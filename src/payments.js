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
import { state, addActivity, resetState, READ_LEVELS, TRANSFER_LEVELS } from './state.js';
import { decide, injectionWarnings, STATUS_FOR } from './rules.js';
import { FEE_FIXED_EUR, FEE_PERCENT, RATES_PER_EUR, fmt, maskIban, normIban, round2, toEUR } from './money.js';
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
  addActivity({
    kind: 'paid',
    draftId: d.id,
    decision: 'paid',
    rule: d.rule,
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

/** Save the consent screen: permission levels and limits. */
export function updatePass({ permissions = {}, perPaymentLimitEUR, monthlyLimitEUR }) {
  const p = state.pass;
  const next = { ...p.permissions };
  for (const key of ['balances', 'recipients']) {
    if (permissions[key] === undefined) continue;
    if (!READ_LEVELS.includes(permissions[key])) throw new ActionError(400, `${key} must be one of ${READ_LEVELS.join(', ')}`);
    next[key] = permissions[key];
  }
  if (permissions.transfers !== undefined) {
    if (!TRANSFER_LEVELS.includes(permissions.transfers)) throw new ActionError(400, `transfers must be one of ${TRANSFER_LEVELS.join(', ')}`);
    next.transfers = permissions.transfers;
  }
  const limit = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new ActionError(400, `${name} must be a positive amount`);
    return round2(n);
  };
  const per = limit(perPaymentLimitEUR, 'perPaymentLimitEUR') ?? p.perPaymentLimitEUR;
  const month = limit(monthlyLimitEUR, 'monthlyLimitEUR') ?? p.monthlyLimitEUR;

  Object.assign(p, { permissions: next, perPaymentLimitEUR: per, monthlyLimitEUR: month });
  const limits = next.transfers === 'act' ? `, up to ${fmt(per, 'EUR')} per payment and ${fmt(month, 'EUR')} per month` : '';
  addActivity({
    kind: 'pass',
    decision: 'pass',
    rule: `pass.${next.transfers}`,
    text: `You updated Claude's Agent Pass. Transfers: ${LEVEL_NAMES[next.transfers]}${limits}.`,
  });
}

export function revokeAccess() {
  state.pass.revoked = true;
  addActivity({ kind: 'revoked', decision: 'block', rule: 'pass.revoked', text: "You revoked Claude's access. Claude can't see or do anything in your Wise account." });
}

export function restoreAccess() {
  state.pass.revoked = false;
  addActivity({ kind: 'restored', decision: 'allow', rule: 'pass.restored', text: "You restored Claude's access under your Agent Pass." });
}

export function resetDemo() {
  resetState();
  log('state reset');
}
