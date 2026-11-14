// Payment actions. The MCP tools (Claude's side) and the web API (the user's side) both
// call these, so the rules are applied in exactly one place.
//
// Every payment takes two steps. First Claude shows the user a draft in the chat
// (draftPayments, nothing reaches Wise). Only after the user says yes does Claude send it to Wise
// (sendToWise), which creates the payments below. Trusted ones are sent at once.
//
// Payment lifecycle in Wise (after the user's yes):
//   preparePayment ─┬─> ready ──────── sent at once by sendToWise ──┐
//                   ├─> awaiting_user ─┬─ Approve (user) ───────────┴─> paid
//                   │                  ├─ Decline (user) ─> declined
//                   │                  └─ no answer in 5 min ─> expired   (state.js expireStale)
//                   └─> blocked        (a rule, a hard cap, or a reported scam account)
//   Every check runs again at send time, so a pass changed after the chat draft still counts.
//
// A batch groups the waiting payments of one request (and of requests in the 2 minutes before)
// so the user confirms them with one tap: awaiting_user -> paid | declined | expired.
//
// Decision order for a new draft: the Agent Pass rules (rules.js) first, then Wise's fraud check
// (fraud.js), which can only make a decision stricter, never looser.

import { randomUUID } from 'node:crypto';
import { state, addActivity, resetState, sentTodayCount, today, EXPIRY_MS, PERMISSION_LEVELS } from './state.js';
import { decide, hardCapReason, injectionWarnings, reportedAccount, STATUS_FOR } from './rules.js';
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
 * What Wise would decide for one payment: the Agent Pass rules, then the fraud check, which can
 * only make it stricter. pending = { eur, count } of earlier payments in the same request, so the
 * hard caps cover the whole request. Changes nothing.
 */
function evaluate({ recipientId, amount, currency, iban, note }, pending = { eur: 0, count: 0 }) {
  const id = String(recipientId).trim().toLowerCase();
  const saved = state.recipients[id];
  let result = decide({ recipientId: id, amount, currency, iban, pendingEUR: pending.eur, pendingCount: pending.count });
  // A scam block keeps its fraud signals so the user can see why; other blocks need none.
  const fraud = result.decision === 'block' && !result.rule.startsWith('fraud.') ? null : assessFraud({ recipientId: id, amount, currency, iban, note });
  if (fraud && fraud.level !== 'low' && result.decision === 'allow') {
    result = { decision: 'needs_approval', rule: 'fraud.review', reason: `Wise's fraud check flagged this request (${fraud.level} risk), so you need to check it yourself.` };
  }
  return { id, saved, result, fraud };
}

/**
 * Create a payment in Wise and check it against the Agent Pass. Never moves money by itself.
 * invoiceId: the inbox invoice this pays; it is marked paid when the payment is sent.
 */
export function preparePayment(payment, pending) {
  const { amount, currency, iban, note, invoiceId } = payment;
  const { id, saved, result, fraud } = evaluate(payment, pending);
  const draft = {
    id: `drf_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    recipientId: id,
    recipientName: saved ? saved.name : payment.recipientId,
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
    // For a scam block: what Wise knows about the account, and the account saved under that name.
    scam: result.rule === 'fraud.reported_account'
      ? { why: reportedAccount(iban || saved?.iban), savedIbanMasked: saved && iban && normIban(iban) !== normIban(saved.iban) ? maskIban(saved.iban) : null }
      : null,
    invoiceId: invoiceId && state.inbox.some((i) => i.id === invoiceId) ? invoiceId : null,
    batchId: null, // set by groupWaiting() when it joins a batch
  };
  state.drafts[draft.id] = draft;
  addActivity({
    kind: 'prepared',
    draftId: draft.id,
    decision: result.decision,
    rule: result.rule,
    text: draft.scam
      ? `Wise stopped a scam: Claude was asked to pay ${fmt(amount, currency)} to ${draft.recipientName} (${draft.ibanMasked}). ${result.reason}`
      : `Claude prepared ${fmt(amount, currency)} to ${draft.recipientName}: ${PREPARED_TEXT[result.decision]}. ${result.reason}`,
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
  state.pass.sentToday = { date: today(), count: sentTodayCount() + 1 }; // Claude's and approved ones both count
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

// ---------------------------------------------------------------------------
// Two steps for every payment: a draft in the chat, then the request to Wise
// ---------------------------------------------------------------------------

const MAX_BATCH = 10;
/** A chat draft can be sent to Wise once, within this time. */
export const CHAT_DRAFT_TTL_MS = 10 * 60 * 1000;
/** Waiting payments Claude sends within this window are grouped into one request. */
const GROUP_WINDOW_MS = 2 * 60 * 1000;

const OUTCOME = { allow: 'sends_now', needs_approval: 'needs_you', block: 'blocked' };

/**
 * Step 1 (draft_payments): what Claude shows the user in the chat before anything reaches Wise.
 * Each payment gets a preview of what Wise would do: sent at once (trusted), needs your approval,
 * or blocked. Nothing appears in the Wise app; only the draft is kept, so send_to_wise sends
 * exactly what the user saw.
 */
export function draftPayments({ title, payments }) {
  const list = payments.slice(0, MAX_BATCH);
  const pending = { eur: 0, count: 0 };
  const items = list.map((p) => {
    const { id, saved, result, fraud } = evaluate(p, pending);
    if (result.decision !== 'block') { pending.eur += toEUR(p.amount, p.currency) || 0; pending.count += 1; }
    const iban = p.iban || saved?.iban;
    return {
      recipientId: id, recipient: saved ? saved.name : p.recipientId, ibanMasked: maskIban(iban),
      country: iban ? normIban(iban).slice(0, 2) : null,
      amount: p.amount, currency: p.currency, note: p.note || '',
      outcome: OUTCOME[result.decision], reason: result.reason, fraud,
      scam: result.rule === 'fraud.reported_account'
        ? { why: reportedAccount(iban), savedIbanMasked: saved && p.iban && normIban(p.iban) !== normIban(saved.iban) ? maskIban(saved.iban) : null }
        : null,
    };
  });
  const draft = {
    id: `chd_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    title: String(title || (list.length > 1 ? 'Payments from Claude' : 'Payment')).slice(0, 80),
    payments: list,
    sent: false,
  };
  state.chatDrafts[draft.id] = draft;
  return { draft, items };
}

/**
 * Step 2 (send_to_wise), only after the user said yes in the chat. Sends the request to Wise:
 * trusted payments (allowed by the pass, low fraud risk) are sent at once; the others wait for
 * the user, grouped into one batch when batch payments are on; blocked ones go nowhere.
 * Returns { drafts, batch }, or throws an ActionError.
 */
export function sendToWise(chatDraftId) {
  const cd = state.chatDrafts[chatDraftId];
  if (!cd) throw new ActionError(404, `No chat draft ${chatDraftId}. Call draft_payments first and show it to the user.`);
  if (cd.sent) throw new ActionError(409, 'This draft was already sent to Wise. Do not send it again.');
  if (Date.now() - Date.parse(cd.createdAt) > CHAT_DRAFT_TTL_MS) throw new ActionError(410, 'This draft is older than 10 minutes. Draft it again and ask the user again.');
  cd.sent = true;
  const pending = { eur: 0, count: 0 };
  const drafts = cd.payments.map((p) => {
    const d = preparePayment(p, pending);
    if (d.status !== 'blocked') { pending.eur += d.amountEUR || 0; pending.count += 1; }
    return d;
  });
  for (const d of drafts) if (d.status === 'ready') confirmPayment(d.id); // trusted, and the user already said yes
  const waiting = drafts.filter((d) => d.status === 'awaiting_user');
  const batch = state.pass.permissions.batches === 'on' ? groupWaiting(waiting, cd.title) : null;
  if (batch) {
    batch.sentWith = drafts.filter((d) => d.status === 'paid').map((d) => d.id);       // trusted, sent at once
    batch.blockedWith = drafts.filter((d) => d.status === 'blocked').map((d) => d.id); // never sent
  }
  log(`sent ${cd.id} to Wise: ${drafts.map((d) => d.status).join(', ')}${batch ? ` (batch ${batch.id})` : ''}`);
  return { drafts, batch };
}

/**
 * Group waiting payments into one request the user confirms with one tap: the new ones, plus
 * any single payment Claude asked for in the last 2 minutes, or an open group from then.
 * So asking for payments one by one still ends up as one request. Returns the batch, or null
 * when there is only one payment waiting.
 */
function groupWaiting(newDrafts, title) {
  const since = Date.now() - GROUP_WINDOW_MS;
  const recent = (x) => Date.parse(x.createdAt) > since;
  let b = Object.values(state.batches).find((x) => x.auto && x.status === 'awaiting_user' && recent(x));
  const ids = new Set(newDrafts.map((d) => d.id));
  const lone = Object.values(state.drafts).filter((d) => !ids.has(d.id) && d.status === 'awaiting_user' && !d.batchId && recent(d));
  const join = [...lone, ...newDrafts];
  if (!join.length || (!b && join.length < 2)) return null;
  if (!b) {
    b = { id: `bat_${randomUUID().slice(0, 8)}`, title, draftIds: [], status: 'awaiting_user', auto: true };
    state.batches[b.id] = b;
  }
  b.createdAt = new Date().toISOString(); // the whole group gets a fresh 5 minutes
  for (const d of join) { d.batchId = b.id; b.draftIds.push(d.id); }
  const all = b.draftIds.map((id) => state.drafts[id]);
  addActivity({
    kind: 'prepared',
    batchId: b.id,
    decision: 'needs_approval',
    rule: 'batch.grouped',
    text: `Claude asked for ${all.length} payments, so Wise put them in one request: ${all.map((d) => `${d.recipientName} ${fmt(d.amount, d.currency)}`).join(', ')}. You confirm them with one tap.`,
  });
  return b;
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
  const scam = reportedAccount(clean);
  if (scam) throw new ActionError(403, `Wise's fraud system refused this account: it is ${scam}. It can't be added or paid.`);
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

/**
 * Approve = send. The user's own decision, so the per-payment limit and "always ask" don't apply,
 * but the monthly and daily limits are hard caps and still do.
 */
export function approveDraft(id) {
  const d = awaitingDraft(id);
  if (state.pass.revoked) throw new ActionError(409, "Claude's access is revoked. Restore it first.");
  const cap = hardCapReason(d.amountEUR || 0, 1);
  if (cap) throw new ActionError(409, cap);
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
  const cap = hardCapReason(round2(pay.reduce((t, d) => t + (d.amountEUR || 0), 0)), pay.length);
  if (cap) throw new ActionError(409, cap);
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
  addActivity({ kind: 'declined', batchId: id, decision: 'declined', rule: 'batch.declined', text: `You declined the batch "${b.title}". Claude cannot send these payments.` });
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
