// Payment actions. The MCP tools (Claude's side) and the web API (the user's side) both
// call these, so the rules are applied in exactly one place.
//
// Draft lifecycle:
//   prepare  ->  ready ─────────────────────────────┐
//            ->  awaiting_user -> approved (user) ───┼─> confirm -> paid
//                              -> declined (user)    │
//            ->  blocked                             │
//   (confirm re-checks the Mandate and can still turn a draft into "blocked")

import { randomUUID } from 'node:crypto';
import { state, addActivity, resetState } from './state.js';
import { decide, injectionWarnings, REVOKED, STATUS_FOR } from './rules.js';
import { FEE_FIXED_EUR, FEE_PERCENT, RATES_PER_EUR, fmt, maskIban, normIban, round2, toEUR } from './money.js';
import { log } from './log.js';

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

const PREPARED_TEXT = { allow: 'ready to send', needs_approval: 'waiting for your approval', block: 'blocked' };

/** Create a draft and check it against the Mandate. Never moves money. */
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

const NOT_SENDABLE = {
  awaiting_user: 'It is waiting for the user to approve it in the Wise app. You cannot approve it. Ask the user to review it there.',
  declined: 'The user declined it in the Wise app. Do not retry it.',
};

/**
 * The Mandate may have changed since the draft was prepared, so check again at send time.
 * Returns null if the draft may still be sent, otherwise { rule, reason }.
 */
function recheckAtSendTime(d) {
  const m = state.mandate;
  if (m.revoked) return REVOKED;
  if (d.status === 'ready') {
    const r = decide(d);
    return r.decision === 'allow' ? null : r;
  }
  // User-approved drafts skip the hard stops and the per-payment limit,
  // but the monthly cap still applies.
  if (d.amountEUR != null && m.spentThisMonthEUR + d.amountEUR > m.monthlyLimitEUR) {
    return { rule: 'limit.monthly', reason: `This would go over your ${fmt(m.monthlyLimitEUR, 'EUR')} monthly AI limit.` };
  }
  return null;
}

/** Send a draft. Returns { ok: true, draft } or { ok: false, error, draft? }. */
export function confirmPayment(draftId) {
  const d = state.drafts[draftId];
  if (!d) return { ok: false, error: `No payment draft with id ${draftId}.` };
  if (d.status === 'paid') return { ok: false, error: 'This payment was already sent.', draft: d };
  if (d.status === 'blocked') return { ok: false, error: `Payment not sent. It was blocked by the Mandate: ${d.reason} Do not retry it.`, draft: d };
  if (d.status !== 'ready' && d.status !== 'approved') return { ok: false, error: `Payment not sent. ${NOT_SENDABLE[d.status]}`, draft: d };

  const blocked = recheckAtSendTime(d);
  if (blocked) {
    Object.assign(d, { status: 'blocked', decision: 'block', rule: blocked.rule, reason: blocked.reason });
    addActivity({ kind: 'blocked', draftId: d.id, decision: 'block', rule: blocked.rule, text: `Blocked ${fmt(d.amount, d.currency)} to ${d.recipientName} at send time. ${blocked.reason}` });
    return { ok: false, error: `Payment not sent. ${blocked.reason} Do not retry it.`, draft: d };
  }

  const balance = state.balances[d.currency] ?? 0;
  if (balance < d.amount) {
    return { ok: false, error: `Not enough ${d.currency} balance (${fmt(balance, d.currency)} available).`, draft: d };
  }

  state.balances[d.currency] = d.currency === 'JPY' ? balance - d.amount : round2(balance - d.amount);
  if (d.amountEUR != null) state.mandate.spentThisMonthEUR = round2(state.mandate.spentThisMonthEUR + d.amountEUR);
  d.status = 'paid';
  d.paidAt = new Date().toISOString();
  addActivity({
    kind: 'paid',
    draftId: d.id,
    decision: 'paid',
    rule: d.rule,
    text: `Sent ${fmt(d.amount, d.currency)} to ${d.recipientName}. ${d.approvedByUser ? 'You approved it in the Wise app.' : d.reason}`,
  });
  log(`paid ${d.id}`);
  return { ok: true, draft: d };
}

// ---------------------------------------------------------------------------
// The user's side (web app only, never reachable from an MCP tool)
// ---------------------------------------------------------------------------

/** Error with an HTTP status, thrown by the user actions and turned into a response by web.js. */
export class ActionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function awaitingDraft(id) {
  const d = state.drafts[id];
  if (!d) throw new ActionError(404, 'not found');
  if (d.status !== 'awaiting_user') throw new ActionError(409, `Draft is ${d.status}`);
  return d;
}

export function approveDraft(id) {
  const d = awaitingDraft(id);
  if (state.mandate.revoked) throw new ActionError(409, 'AI access is revoked. Restore it first.');
  d.status = 'approved';
  d.approvedByUser = true;
  addActivity({ kind: 'approved', draftId: d.id, decision: 'approved', rule: d.rule, text: `You approved ${fmt(d.amount, d.currency)} to ${d.recipientName}. Claude can now send it.` });
}

export function declineDraft(id) {
  const d = awaitingDraft(id);
  d.status = 'declined';
  addActivity({ kind: 'declined', draftId: d.id, decision: 'declined', rule: d.rule, text: `You declined ${fmt(d.amount, d.currency)} to ${d.recipientName}. Claude cannot send it.` });
}

export function revokeMandate() {
  state.mandate.revoked = true;
  addActivity({ kind: 'revoked', decision: 'block', rule: 'mandate.revoked', text: "You revoked Claude's access. Every new AI payment will be blocked." });
}

export function restoreMandate() {
  state.mandate.revoked = false;
  addActivity({ kind: 'restored', decision: 'allow', rule: 'mandate.restored', text: "You restored Claude's access under your Mandate." });
}

export function resetDemo() {
  resetState();
  log('state reset');
}
