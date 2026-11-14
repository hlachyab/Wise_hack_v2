// Payment actions. The MCP tools (Claude's side) and the web API (the user's side) both
// call these, so the rules are applied in exactly one place.
//
// Draft lifecycle:
//   prepare ─┬─> ready ──────── confirm_payment (Claude) ──┐
//            ├─> awaiting_user ─┬─ Approve (user) ─────────┴─> paid
//            │                  └─ Decline (user) ─> declined
//            └─> blocked
//   confirm_payment re-checks the pass at send time, so a "ready" draft can still move to
//   awaiting_user or blocked if the user changed their pass in the meantime.

import { randomUUID } from 'node:crypto';
import { state, addActivity, resetState, sentTodayCount, today, EXPIRY_MS, READ_LEVELS, TRANSFER_LEVELS } from './state.js';
import { decide, injectionWarnings, STATUS_FOR } from './rules.js';
import { CURRENCIES, FEE_FIXED_EUR, FEE_PERCENT, RATES_PER_EUR, fmt, maskIban, normIban, round2, toEUR } from './money.js';
import { log } from './log.js';

/** Error with an HTTP status. The user actions throw it and web.js turns it into a response. */
export class ActionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Claude's side
// ---------------------------------------------------------------------------

export function getQuote({ amount, fromCurrency, toCurrency }) {
  const from = RATES_PER_EUR[fromCurrency];
  const rate = RATES_PER_EUR[toCurrency] / from;
  const sameCurrency = fromCurrency === toCurrency;
  const fee = sameCurrency ? 0 : round2(amount * (FEE_PERCENT / 100) + FEE_FIXED_EUR * from);
  const converted = (amount - fee) * rate;
  const recipientGets = toCurrency === 'JPY' ? Math.round(converted) : round2(converted);
  return {
    amount,
    fromCurrency,
    toCurrency,
    midMarketRate: Number(rate.toFixed(6)),
    fee,
    feeCurrency: fromCurrency,
    recipientGets,
    summary: sameCurrency
      ? `No conversion needed: ${fmt(amount, fromCurrency)} arrives as ${fmt(amount, toCurrency)}, no fee.`
      : `You send ${fmt(amount, fromCurrency)}. Fee ${fmt(fee, fromCurrency)}. Mid-market rate 1 ${fromCurrency} = ${rate.toFixed(4)} ${toCurrency}. Recipient gets ${fmt(recipientGets, toCurrency)}. (Mock rates)`,
  };
}

const PREPARED_TEXT = { allow: 'ready to send', needs_approval: 'waiting for you', block: 'blocked' };

/** Create a draft and check it against the Agent Pass. Never moves money. */
export function preparePayment({ recipientId, amount, currency, iban, note }) {
  const id = String(recipientId).trim().toLowerCase();
  const saved = state.recipients[id];
  const result = decide({ recipientId: id, amount, currency, iban });
  const draft = {
    id: `drf_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    recipientId: id,
    recipientName: saved ? saved.name : recipientId,
    iban: iban ? normIban(iban) : saved ? normIban(saved.iban) : null,
    ibanMasked: maskIban(iban || saved?.iban),
    amount,
    currency,
    amountEUR: RATES_PER_EUR[currency] ? toEUR(amount, currency) : null,
    note: note || '',
    status: STATUS_FOR[result.decision],
    decision: result.decision,
    rule: result.rule,
    reason: result.reason,
    warnings: injectionWarnings(note),
  };
  state.drafts[draft.id] = draft;
  addActivity({
    kind: 'prepared',
    draftId: draft.id,
    decision: result.decision,
    rule: result.rule,
    text: `Claude prepared ${fmt(amount, currency)} to ${draft.recipientName}: ${PREPARED_TEXT[result.decision]}. ${result.reason}`,
  });
  log(`prepare ${draft.id} ${amount} ${currency} -> ${draft.recipientName}: ${result.decision} (${result.rule})`);
  return draft;
}

/** Move the money (mock). Used by Claude's confirm and by the user's Approve. */
function send(d, byUser) {
  const balance = state.balances[d.currency] ?? 0;
  if (balance < d.amount) return `Not enough ${d.currency} balance (${fmt(balance, d.currency)} available).`;
  state.balances[d.currency] = d.currency === 'JPY' ? balance - d.amount : round2(balance - d.amount);
  if (d.amountEUR != null) state.pass.spentThisMonthEUR = round2(state.pass.spentThisMonthEUR + d.amountEUR);
  d.status = 'paid';
  d.paidAt = new Date().toISOString();
  d.sentByUser = byUser;
  if (!byUser) state.pass.sentToday = { date: today(), count: sentTodayCount() + 1 };
  addActivity({
    kind: 'paid',
    draftId: d.id,
    decision: 'paid',
    rule: d.rule,
    byUser,
    text: `Sent ${fmt(d.amount, d.currency)} to ${d.recipientName}. ${byUser ? 'You approved it in the Wise app.' : d.reason}`,
  });
  log(`paid ${d.id}${byUser ? ' (approved by user)' : ''}`);
  return null;
}

/**
 * Claude sends a "ready" draft. Returns { ok: true, draft, already? } or { ok: false, error, draft? }.
 * The pass may have changed since the draft was prepared, so it is checked again first.
 */
export function confirmPayment(draftId) {
  const d = state.drafts[draftId];
  if (!d) return { ok: false, error: `No payment draft with id ${draftId}.` };

  switch (d.status) {
    case 'paid':
      return { ok: true, already: true, draft: d };
    case 'awaiting_user':
      return { ok: false, draft: d, error: 'Payment not sent. It is waiting for the user, who can approve and send it with one tap in the Wise app. You cannot approve it.' };
    case 'declined':
      return { ok: false, draft: d, error: 'Payment not sent. The user declined it in the Wise app. Do not retry it.' };
    case 'blocked':
      return { ok: false, draft: d, error: `Payment not sent. It was blocked by the Agent Pass: ${d.reason} Do not retry it.` };
  }

  const now = decide(d);
  if (now.decision !== 'allow') {
    Object.assign(d, { status: STATUS_FOR[now.decision], decision: now.decision, rule: now.rule, reason: now.reason });
    const kind = now.decision === 'block' ? 'blocked' : 'prepared';
    addActivity({ kind, draftId: d.id, decision: now.decision, rule: now.rule, text: `Checked ${fmt(d.amount, d.currency)} to ${d.recipientName} again at send time. ${now.reason}` });
    return now.decision === 'block'
      ? { ok: false, draft: d, error: `Payment not sent. ${now.reason} Do not retry it.` }
      : { ok: false, draft: d, error: `Payment not sent yet. ${now.reason} The user can approve it in the Wise app.` };
  }

  const error = send(d, false);
  return error ? { ok: false, error, draft: d } : { ok: true, draft: d };
}

// ---------------------------------------------------------------------------
// The user's side (web app only, never reachable from an MCP tool)
// ---------------------------------------------------------------------------

function awaitingDraft(id) {
  const d = state.drafts[id];
  if (!d) throw new ActionError(404, 'not found');
  if (d.status !== 'awaiting_user') throw new ActionError(409, `Draft is ${d.status}`);
  return d;
}

/** Approve = send. The user's own decision, so the pass limits don't apply. */
export function approveDraft(id) {
  const d = awaitingDraft(id);
  if (state.pass.revoked) throw new ActionError(409, "Claude's access is revoked. Restore it first.");
  const error = send(d, true); // logs "Sent … You approved it in the Wise app."
  if (error) throw new ActionError(409, error);
}

export function declineDraft(id) {
  const d = awaitingDraft(id);
  d.status = 'declined';
  addActivity({ kind: 'declined', draftId: d.id, decision: 'declined', rule: d.rule, text: `You declined ${fmt(d.amount, d.currency)} to ${d.recipientName}. Claude cannot send it.` });
}

const LEVEL_NAMES = { none: 'None', view: 'View', draft: 'Draft', act: 'Act' };

const EXPIRY_NAMES = { '1h': 'for 1 hour', '1d': 'for 1 day', '30d': 'for 30 days', never: 'until you revoke it' };

/**
 * Save the consent screen. Every field is optional; missing ones keep their current value.
 * { permissions, perPaymentLimitEUR, monthlyLimitEUR, dailyCountLimit, allowedCurrencies, autoPay, expiry }
 */
export function updatePass(body) {
  const { permissions = {}, perPaymentLimitEUR, monthlyLimitEUR, dailyCountLimit, allowedCurrencies, autoPay, expiry } = body;
  const p = state.pass;
  const bad = (msg) => { throw new ActionError(400, msg); };

  const next = { ...p.permissions };
  for (const key of ['balances', 'recipients', 'rates']) {
    if (permissions[key] === undefined) continue;
    if (!READ_LEVELS.includes(permissions[key])) bad(`${key} must be one of ${READ_LEVELS.join(', ')}`);
    next[key] = permissions[key];
  }
  if (permissions.transfers !== undefined) {
    if (!TRANSFER_LEVELS.includes(permissions.transfers)) bad(`transfers must be one of ${TRANSFER_LEVELS.join(', ')}`);
    next.transfers = permissions.transfers;
  }

  const limit = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) bad(`${name} must be a positive amount`);
    return round2(n);
  };
  const per = limit(perPaymentLimitEUR, 'perPaymentLimitEUR') ?? p.perPaymentLimitEUR;
  const month = limit(monthlyLimitEUR, 'monthlyLimitEUR') ?? p.monthlyLimitEUR;

  let count = p.dailyCountLimit;
  if (dailyCountLimit !== undefined) {
    count = Number(dailyCountLimit);
    if (!Number.isInteger(count) || count < 1 || count > 50) bad('dailyCountLimit must be a whole number from 1 to 50');
  }

  let currencies = p.allowedCurrencies;
  if (allowedCurrencies !== undefined) {
    if (!Array.isArray(allowedCurrencies) || !allowedCurrencies.every((c) => CURRENCIES.includes(c))) bad(`allowedCurrencies must be from ${CURRENCIES.join(', ')}`);
    currencies = CURRENCIES.filter((c) => allowedCurrencies.includes(c)); // dedupe, keep order
  }

  const auto = { ...p.autoPay };
  if (autoPay !== undefined) {
    if (typeof autoPay !== 'object' || autoPay === null) bad('autoPay must be an object');
    for (const [id, on] of Object.entries(autoPay)) {
      if (!state.recipients[id]) bad(`Unknown recipient ${id}`);
      auto[id] = !!on;
    }
  }

  let { expiry: exp, expiresAt } = p;
  if (expiry !== undefined) {
    if (!(expiry in EXPIRY_MS)) bad(`expiry must be one of ${Object.keys(EXPIRY_MS).join(', ')}`);
    exp = expiry;
    expiresAt = EXPIRY_MS[expiry] ? new Date(Date.now() + EXPIRY_MS[expiry]).toISOString() : null;
  }

  Object.assign(p, {
    permissions: next, perPaymentLimitEUR: per, monthlyLimitEUR: month, dailyCountLimit: count,
    allowedCurrencies: currencies, autoPay: auto, expiry: exp, expiresAt,
  });

  const t = next.transfers;
  const asks = Object.values(state.recipients).filter((r) => !auto[r.id]).map((r) => r.name);
  const details = t === 'act'
    ? `, up to ${fmt(per, 'EUR')} per payment, ${fmt(month, 'EUR')} per month and ${count} payment${count === 1 ? '' : 's'} a day` +
      (asks.length ? `; always ask for ${asks.join(', ')}` : '')
    : '';
  addActivity({
    kind: 'pass',
    decision: 'pass',
    rule: `pass.${t}`,
    text: `You updated Claude's Agent Pass ${EXPIRY_NAMES[exp]}. Transfers: ${LEVEL_NAMES[t]}${details}.`,
  });
}

const READ_ONLY_PASS = {
  permissions: { balances: 'view', recipients: 'view', rates: 'view', transfers: 'view' },
  expiry: 'never',
};

/**
 * The first-time connect screen. body.mode is "readonly" (Wise's read-only connection) or
 * "custom" (the Agent Pass, with the same fields as updatePass).
 */
export function connectClaude(body = {}) {
  const custom = body.mode === 'custom';
  updatePass(custom ? body : READ_ONLY_PASS);
  Object.assign(state.pass, { connected: true, connectRequestedAt: null, revoked: false });
  state.activity.shift(); // replace the "updated" entry with a clearer one
  const t = state.pass.permissions.transfers;
  addActivity({
    kind: 'restored',
    decision: 'allow',
    rule: 'pass.connected',
    text: `You connected Claude to your Wise account (${custom ? `Agent Pass, Transfers: ${LEVEL_NAMES[t]}` : 'read-only'}).`,
  });
}

/** Called by the MCP side when Claude tries to use Wise before it is connected. */
export function noteConnectRequest() {
  state.pass.connectRequestedAt = new Date().toISOString();
}

export function revokeAccess() {
  state.pass.revoked = true;
  addActivity({ kind: 'revoked', decision: 'block', rule: 'pass.revoked', text: "You revoked Claude's access. Claude can't see or do anything in your Wise account." });
}

export function restoreAccess() {
  Object.assign(state.pass, { revoked: false, expiry: 'never', expiresAt: null }); // also renews an expired pass
  addActivity({ kind: 'restored', decision: 'allow', rule: 'pass.restored', text: "You restored Claude's access under your Agent Pass." });
}

export function resetDemo() {
  resetState();
  log('state reset');
}
