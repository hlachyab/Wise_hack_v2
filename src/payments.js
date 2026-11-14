// Payment actions. The MCP tools (Claude's side) and the web API (the user's side) both
// call these, so the rules are applied in exactly one place.
//
// Draft lifecycle:
//   prepare ─┬─> ready ──────── confirm_payment (Claude) ──┐
//            ├─> awaiting_user ─┬─ Approve (user) ─────────┴─> paid
//            │                  ├─ Decline (user) ─> declined
//            │                  └─ no answer in 5 min ─> expired   (state.js expireStale)
//            └─> blocked
//   confirm_payment re-checks the pass at send time, so a "ready" draft can still move to
//   awaiting_user or blocked if the user changed their pass in the meantime.
//
// A batch is a group of drafts the user confirms with one tap: awaiting_user -> paid | declined
// | expired. Inside a batch even "allowed" payments wait for that tap (rule batch.one_tap).
//
// Decision order for a new draft: the Agent Pass rules (rules.js) first, then Wise's fraud check
// (fraud.js), which can only make a decision stricter, never looser.

import { randomUUID } from 'node:crypto';
import { state, addActivity, resetState, sentTodayCount, today, EXPIRY_MS, PERMISSION_LEVELS } from './state.js';
import { decide, injectionWarnings, STATUS_FOR } from './rules.js';
import { assessFraud } from './fraud.js';
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

/**
 * Create a draft and check it against the Agent Pass. Never moves money.
 * batchId: part of a batch, so anything the pass allows waits for the user's one-tap "Pay all".
 * invoiceId: the inbox invoice this pays; it is marked paid when the draft is sent.
 */
export function preparePayment({ recipientId, amount, currency, iban, note, invoiceId, batchId }) {
  const id = String(recipientId).trim().toLowerCase();
  const saved = state.recipients[id];
  let result = decide({ recipientId: id, amount, currency, iban });
  // Extra layer: Wise's fraud check. A suspicious request never goes through automatically.
  const fraud = result.decision === 'block' ? null : assessFraud({ recipientId: id, amount, currency, iban, note });
  if (fraud && fraud.level !== 'low' && result.decision === 'allow') {
    result = { decision: 'needs_approval', rule: 'fraud.review', reason: `Wise's fraud check flagged this request (${fraud.level} risk), so you need to check it yourself.` };
  }
  if (batchId && result.decision === 'allow') {
    result = { decision: 'needs_approval', rule: 'batch.one_tap', reason: `${result.reason} Part of a batch, so you confirm it together with the others.` };
  }
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
    fraud,
    invoiceId: invoiceId && state.inbox.some((i) => i.id === invoiceId) ? invoiceId : null,
    batchId: batchId || null,
  };
  state.drafts[draft.id] = draft;
  if (batchId) return draft; // the batch logs one activity entry for all its payments
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
  const r = state.recipients[d.recipientId];
  if (r) r.uses = (r.uses || 0) + 1;
  const inv = d.invoiceId && state.inbox.find((i) => i.id === d.invoiceId);
  if (inv) inv.status = 'paid';
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
    case 'expired':
      return { ok: false, draft: d, error: 'Payment not sent. The user did not answer within 5 minutes, so the request expired. Ask the user before preparing it again.' };
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

const MAX_BATCH = 10;

/**
 * Several payments as one request. Each is checked against the pass on its own; blocked ones
 * are left out, everything else waits for the user to confirm all of them with one tap.
 */
export function prepareBatch({ title, payments }) {
  const batch = {
    id: `bat_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    title: String(title || 'Payments').slice(0, 80),
    draftIds: [],
    status: 'awaiting_user',
  };
  for (const p of payments.slice(0, MAX_BATCH)) batch.draftIds.push(preparePayment({ ...p, batchId: batch.id }).id);
  const drafts = batch.draftIds.map((id) => state.drafts[id]);
  const waiting = drafts.filter((d) => d.status === 'awaiting_user');
  if (!waiting.length) batch.status = 'blocked';
  state.batches[batch.id] = batch;
  const totalEUR = round2(waiting.reduce((t, d) => t + (d.amountEUR || 0), 0));
  addActivity({
    kind: 'prepared',
    batchId: batch.id,
    decision: waiting.length ? 'needs_approval' : 'block',
    rule: 'batch.one_tap',
    text: `Claude prepared a batch "${batch.title}": ${waiting.length} payment${waiting.length === 1 ? '' : 's'} (about ${fmt(totalEUR, 'EUR')}) waiting for one tap` +
      (drafts.length > waiting.length ? `, ${drafts.length - waiting.length} blocked.` : '.'),
  });
  log(`batch ${batch.id}: ${waiting.length}/${drafts.length} waiting`);
  return { batch, drafts };
}

/** Plain IBAN check: 2 letters, 2 digits, then 10-30 letters/digits. */
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

/**
 * Add a recipient. Claude can do this only with Recipients set to "Add"; the user can always.
 * New recipients always ask before Claude pays them, until the user turns on auto-pay.
 */
export function addRecipient({ name, iban, currency, note }, by) {
  const clean = normIban(iban);
  if (!String(name || '').trim()) throw new ActionError(400, 'Name is required.');
  if (!IBAN_RE.test(clean)) throw new ActionError(400, 'That IBAN doesn\'t look right.');
  if (!RATES_PER_EUR[currency]) throw new ActionError(400, `Currency must be one of ${CURRENCIES.join(', ')}.`);
  const dupe = Object.values(state.recipients).find((r) => normIban(r.iban) === clean);
  if (dupe) throw new ActionError(409, `${dupe.name} already has this IBAN.`);
  let id = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'recipient';
  for (let n = 2; state.recipients[id]; n++) id = id.replace(/\d*$/, String(n));
  const pretty = clean.replace(/(.{4})/g, '$1 ').trim();
  const r = { id, name: String(name).trim().slice(0, 60), currency, iban: pretty, note: String(note || '').slice(0, 60), uses: 0, addedBy: by };
  state.recipients[id] = r;
  state.pass.autoPay[id] = false;
  addActivity({
    kind: 'recipient',
    decision: by === 'claude' ? 'needs_approval' : 'allow',
    rule: by === 'claude' ? 'recipients.added_by_claude' : 'recipients.added',
    text: `${by === 'claude' ? 'Claude' : 'You'} added ${r.name} (${maskIban(r.iban)}) as a recipient. Claude always asks you before paying them.`,
  });
  return r;
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

/**
 * Pay the selected payments of a batch with one tap; the rest are declined.
 * Checks the balances first so it either pays all selected or none.
 */
export function approveBatch(id, draftIds) {
  const b = state.batches[id];
  if (!b) throw new ActionError(404, 'not found');
  if (b.status !== 'awaiting_user') throw new ActionError(409, `Batch is ${b.status}`);
  if (state.pass.revoked) throw new ActionError(409, "Claude's access is revoked. Restore it first.");
  const waiting = b.draftIds.map((d) => state.drafts[d]).filter((d) => d.status === 'awaiting_user');
  const chosen = new Set(Array.isArray(draftIds) ? draftIds : waiting.map((d) => d.id));
  const pay = waiting.filter((d) => chosen.has(d.id));
  if (!pay.length) throw new ActionError(400, 'Choose at least one payment.');
  const need = {};
  for (const d of pay) need[d.currency] = (need[d.currency] || 0) + d.amount;
  for (const [c, a] of Object.entries(need)) {
    if ((state.balances[c] ?? 0) < a) throw new ActionError(409, `Not enough ${c} balance for these payments (${fmt(state.balances[c] ?? 0, c)} available).`);
  }
  for (const d of waiting) {
    if (chosen.has(d.id)) send(d, true);
    else d.status = 'declined';
  }
  b.status = 'paid';
  b.paidAt = new Date().toISOString();
}

export function declineBatch(id) {
  const b = state.batches[id];
  if (!b) throw new ActionError(404, 'not found');
  if (b.status !== 'awaiting_user') throw new ActionError(409, `Batch is ${b.status}`);
  for (const d of b.draftIds.map((x) => state.drafts[x])) if (d.status === 'awaiting_user') d.status = 'declined';
  b.status = 'declined';
  addActivity({ kind: 'declined', batchId: id, decision: 'declined', rule: 'batch.one_tap', text: `You declined the batch "${b.title}". Claude cannot send these payments.` });
}

const LEVEL_NAMES = { none: 'None', view: 'View', draft: 'Draft', act: 'Act' };

const EXPIRY_NAMES = { '1h': 'for 1 hour', '1d': 'for 1 day', '1w': 'for 1 week', '30d': 'for 30 days' };

/**
 * Save the consent screen. Every field is optional; missing ones keep their current value.
 * { permissions, perPaymentLimitEUR, monthlyLimitEUR, dailyCountLimit, allowedCurrencies, autoPay, expiry }
 */
export function updatePass(body) {
  const { permissions = {}, perPaymentLimitEUR, monthlyLimitEUR, dailyCountLimit, allowedCurrencies, autoPay, expiry } = body;
  const p = state.pass;
  const bad = (msg) => { throw new ActionError(400, msg); };

  const next = { ...p.permissions };
  for (const [key, levels] of Object.entries(PERMISSION_LEVELS)) {
    if (permissions[key] === undefined) continue;
    if (!levels.includes(permissions[key])) bad(`${key} must be one of ${levels.join(', ')}`);
    next[key] = permissions[key];
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
    expiresAt = new Date(Date.now() + EXPIRY_MS[expiry]).toISOString();
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
  permissions: { balances: 'view', recipients: 'view', rates: 'view', invoices: 'view', transfers: 'view', batches: 'off' },
  expiry: '30d',
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
  // Also renews an expired pass, for the same length of time as before.
  const p = state.pass;
  Object.assign(p, { revoked: false, expiresAt: new Date(Date.now() + EXPIRY_MS[p.expiry]).toISOString() });
  addActivity({ kind: 'restored', decision: 'allow', rule: 'pass.restored', text: "You restored Claude's access under your Agent Pass." });
}

export function resetDemo() {
  resetState();
  log('state reset');
}
