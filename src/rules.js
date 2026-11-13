// The Mandate rules engine. Order matters; the first matching rule wins.
// decide() returns { decision, rule, reason }, where decision is "allow" | "needs_approval" | "block".

import { state } from './state.js';
import { fmt, maskIban, normIban, toEUR } from './money.js';

/** Draft status for each decision. */
export const STATUS_FOR = { allow: 'ready', needs_approval: 'awaiting_user', block: 'blocked' };

export const REVOKED = { decision: 'block', rule: 'mandate.revoked', reason: 'Your Wise Mandate was revoked.' };

export function decide({ recipientId, amount, currency, iban }) {
  const m = state.mandate;
  const r = state.recipients[recipientId];

  // 1. Revoked
  if (m.revoked) return REVOKED;

  // 2. Unknown recipient
  if (!r) {
    return {
      decision: 'needs_approval',
      rule: 'hard_stop.new_recipient',
      reason: `"${recipientId}" is not one of your trusted recipients, so you need to approve this yourself.`,
    };
  }

  // 3. Bank details differ from the saved ones
  if (iban && normIban(iban) !== normIban(r.iban)) {
    return {
      decision: 'needs_approval',
      rule: 'hard_stop.changed_bank_details',
      reason: `The bank details (${maskIban(iban)}) don't match the account saved for ${r.name} (${maskIban(r.iban)}). This is a common fraud pattern, so you need to check and approve it yourself.`,
    };
  }

  // 4. Currency not allowed
  if (!m.allowedCurrencies.includes(currency)) {
    return {
      decision: 'block',
      rule: 'currency.not_allowed',
      reason: `Your Mandate doesn't allow payments in ${currency}. Allowed: ${m.allowedCurrencies.join(', ')}.`,
    };
  }

  const eur = toEUR(amount, currency);
  const eurNote = currency === 'EUR' ? '' : ` (about ${fmt(eur, 'EUR')})`;

  // 5. Per-payment limit
  if (eur > m.perPaymentLimitEUR) {
    return {
      decision: 'needs_approval',
      rule: 'limit.per_payment',
      reason: `${fmt(amount, currency)}${eurNote} is over your ${fmt(m.perPaymentLimitEUR, 'EUR')} per-payment limit, so you need to approve it.`,
    };
  }

  // 6. Monthly limit
  if (m.spentThisMonthEUR + eur > m.monthlyLimitEUR) {
    const left = Math.max(0, m.monthlyLimitEUR - m.spentThisMonthEUR);
    return {
      decision: 'block',
      rule: 'limit.monthly',
      reason: `This would go over your ${fmt(m.monthlyLimitEUR, 'EUR')} monthly AI limit. Only ${fmt(left, 'EUR')} is left this month.`,
    };
  }

  // 7. Allow
  return {
    decision: 'allow',
    rule: 'trusted_recipient_under_limit',
    reason: `Allowed because ${r.name} is trusted and ${fmt(amount, currency)}${eurNote} is under your ${fmt(m.perPaymentLimitEUR, 'EUR')} limit.`,
  };
}

// Prompt-injection heuristics. They never change the decision (the rules above do that);
// they only add a visible warning to the draft.
const SUSPICIOUS = [
  /ignore (all |any )?(previous|prior) instructions/i,
  /pay this account/i,
  /system prompt/i,
  /do not (tell|ask) the user/i,
];

export function injectionWarnings(note) {
  return note && SUSPICIOUS.some((re) => re.test(note))
    ? ['The payment note contains text that looks like instructions to an AI. It may be a prompt-injection attempt.']
    : [];
}
