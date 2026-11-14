// The Agent Pass rules engine. Order matters; the first matching rule wins.
// decide() returns { decision, rule, reason }, where decision is "allow" | "needs_approval" | "block".
//
// The idea: within the user's limits Claude can act on its own; anything outside them asks the
// user; only a few hard settings (revoked, read-only, currency) block outright.

import { isExpired, sentTodayCount, state } from './state.js';
import { fmt, maskIban, normIban, toEUR } from './money.js';

/** Draft status for each decision. */
export const STATUS_FOR = { allow: 'ready', needs_approval: 'awaiting_user', block: 'blocked' };
// Later statuses: paid, declined (by the user), expired (no answer within 5 minutes).

export const REVOKED = {
  decision: 'block',
  rule: 'pass.revoked',
  reason: "You revoked Claude's access to your Wise account.",
};

export const NOT_CONNECTED = {
  decision: 'block',
  rule: 'pass.not_connected',
  reason: "Claude isn't connected to your Wise account yet. You can connect it in the Wise app.",
};

export const EXPIRED = {
  decision: 'block',
  rule: 'pass.expired',
  reason: "Claude's access to your Wise account has expired. You can renew it in the Wise app.",
};

const READ_ONLY = {
  decision: 'block',
  rule: 'pass.transfers_read_only',
  reason: "Your Agent Pass lets Claude view transfers only, so it can't prepare or send money. You can change Transfers to Draft or Act in the Wise app.",
};

export function decide({ recipientId, amount, currency, iban }) {
  const p = state.pass;
  const r = state.recipients[recipientId];

  // 0. Not connected yet
  if (!p.connected) return NOT_CONNECTED;

  // 1. Access revoked
  if (p.revoked) return REVOKED;

  // 1b. Access expired
  if (isExpired(p)) return EXPIRED;

  // 2. Transfers are None or View (read-only)
  const level = p.permissions.transfers;
  if (level !== 'draft' && level !== 'act') return READ_ONLY;

  // 3. Unknown recipient
  if (!r) {
    return {
      decision: 'needs_approval',
      rule: 'hard_stop.new_recipient',
      reason: `"${recipientId}" is not one of your saved recipients, so you need to approve this yourself.`,
    };
  }

  // 4. Bank details differ from the saved ones
  if (iban && normIban(iban) !== normIban(r.iban)) {
    return {
      decision: 'needs_approval',
      rule: 'hard_stop.changed_bank_details',
      reason: `The bank details (${maskIban(iban)}) don't match the account saved for ${r.name} (${maskIban(r.iban)}). This is a common fraud pattern, so you need to check and approve it yourself.`,
    };
  }

  // 5. Currency not allowed
  if (!p.allowedCurrencies.includes(currency)) {
    return {
      decision: 'block',
      rule: 'currency.not_allowed',
      reason: `Your Agent Pass doesn't allow payments in ${currency}. Allowed: ${p.allowedCurrencies.join(', ')}.`,
    };
  }

  const eur = toEUR(amount, currency);
  const eurNote = currency === 'EUR' ? '' : ` (about ${fmt(eur, 'EUR')})`;

  // 6. Per-payment limit
  if (eur > p.perPaymentLimitEUR) {
    return {
      decision: 'needs_approval',
      rule: 'limit.per_payment',
      reason: `${fmt(amount, currency)}${eurNote} is above your ${fmt(p.perPaymentLimitEUR, 'EUR')} limit per payment, so you need to approve it.`,
    };
  }

  // 7. Monthly limit
  if (p.spentThisMonthEUR + eur > p.monthlyLimitEUR) {
    const left = Math.max(0, p.monthlyLimitEUR - p.spentThisMonthEUR);
    return {
      decision: 'needs_approval',
      rule: 'limit.monthly',
      reason: `This would go over your ${fmt(p.monthlyLimitEUR, 'EUR')} monthly limit (${fmt(left, 'EUR')} left this month), so you need to approve it.`,
    };
  }

  // 7b. Daily payment count (only Claude's own sends count)
  if (level === 'act' && sentTodayCount(p) >= p.dailyCountLimit) {
    return {
      decision: 'needs_approval',
      rule: 'limit.daily_count',
      reason: `Claude already sent ${p.dailyCountLimit} payment${p.dailyCountLimit === 1 ? '' : 's'} today, your daily maximum, so you need to approve this one.`,
    };
  }

  // 7c. The user asked to approve every payment to this recipient
  if (level === 'act' && p.autoPay[recipientId] === false) {
    return {
      decision: 'needs_approval',
      rule: 'pass.recipient_ask',
      reason: `You asked Claude to always check with you before paying ${r.name}.`,
    };
  }

  // 8. Within the rules, but the pass is Draft: Claude prepares, the user sends
  if (level === 'draft') {
    return {
      decision: 'needs_approval',
      rule: 'pass.draft',
      reason: `Ready to go. Your Agent Pass is set to Draft, so you send it yourself with one tap in the Wise app.`,
    };
  }

  // 9. Allow
  return {
    decision: 'allow',
    rule: 'within_pass',
    reason: `Allowed because ${r.name} is a saved recipient and ${fmt(amount, currency)}${eurNote} is within your ${fmt(p.perPaymentLimitEUR, 'EUR')} limit.`,
  };
}

// Prompt-injection heuristics. They never change the decision (the rules above do that);
// they add a visible warning to the draft, and fraud.js adds risk points for them.
const SUSPICIOUS = [
  /ignore (all |any )?(previous|prior) instructions/i,
  /pay this account/i,
  /system prompt/i,
  /do not (tell|ask) the user/i,
];

/** True if the text looks like instructions aimed at an AI. */
export const looksLikeInjection = (text) => !!text && SUSPICIOUS.some((re) => re.test(text));

export function injectionWarnings(note) {
  return looksLikeInjection(note)
    ? ['The payment note contains text that looks like instructions to an AI. It may be a prompt-injection attempt.']
    : [];
}
