// The Agent Pass rules engine. Order matters; the first matching rule wins.
// decide() returns { decision, rule, reason }, where decision is "allow" | "needs_approval" | "block".
//
// The idea: within the user's limits Claude can act on its own; a bigger single payment asks the
// user; hard settings block outright. The monthly and daily limits are hard caps: once reached,
// nothing more is sent, not even with the user's approval (see hardCapReason, also used when the
// user approves).
// Accounts on Wise's list of reported scam accounts are blocked outright (reportedAccount).

import { isExpired, sentTodayCount, state } from './state.js';
import { fmt, maskIban, normIban, toEUR } from './money.js';

/**
 * Mock of Wise's fraud database: accounts other Wise users reported as scams. Money is never sent
 * to them, whatever the Agent Pass says. (Demo data: the fake "Tallinn Power" account.)
 */
const REPORTED_ACCOUNTS = new Map([
  ['LT473250079455120937', 'reported by 14 Wise users for fake invoices'],
]);
/** Why Wise knows this IBAN is a scam account, or null. */
export const reportedAccount = (iban) => (iban ? REPORTED_ACCOUNTS.get(normIban(iban)) || null : null);

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

/**
 * Why sending `addEUR` more (in `addCount` payments) would break a hard cap, or null if it fits.
 * Every payment sent through the Agent Pass counts, whether Claude sent it or the user approved it.
 */
export function hardCapReason(addEUR, addCount = 1) {
  const p = state.pass;
  if (p.spentThisMonthEUR + addEUR > p.monthlyLimitEUR + 0.001) {
    const left = Math.max(0, p.monthlyLimitEUR - p.spentThisMonthEUR);
    return `This would go over your ${fmt(p.monthlyLimitEUR, 'EUR')} monthly limit (${fmt(left, 'EUR')} left this month). The monthly limit is a hard cap, so it can't be sent, even with your approval. You can raise the limit in the Wise app.`;
  }
  const sent = sentTodayCount(p);
  if (sent + addCount > p.dailyCountLimit) {
    return `${sent} of your ${p.dailyCountLimit} payment${p.dailyCountLimit === 1 ? '' : 's'} a day ${sent === 1 ? 'is' : 'are'} already used${addCount > 1 ? `, so ${addCount} more won't fit` : ''}. The daily limit is a hard cap, so nothing more can be sent today, even with your approval. You can raise it in the Wise app.`;
  }
  return null;
}

/**
 * The Agent Pass decision for one payment. pendingEUR / pendingCount are payments earlier in the
 * same batch, so a batch can't get around the monthly or daily cap by splitting.
 */
export function decide({ recipientId, amount, currency, iban, pendingEUR = 0, pendingCount = 0 }) {
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

  // 2b. Wise's fraud database knows this account as a scam: never send, not even with approval
  const scam = reportedAccount(iban || r?.iban);
  if (scam) {
    return {
      decision: 'block',
      rule: 'fraud.reported_account',
      reason: `Wise's fraud system stopped this: the account ${maskIban(iban || r.iban)} is ${scam}. No money will be sent to it.`,
    };
  }

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

  // 6. Monthly and daily limits: hard caps, checked before anything that could ask the user
  const cap = hardCapReason(pendingEUR + eur, pendingCount + 1);
  if (cap) {
    const monthly = cap.includes('monthly');
    return { decision: 'block', rule: monthly ? 'limit.monthly' : 'limit.daily_count', reason: cap };
  }

  // 7. Per-payment limit: a bigger payment asks the user
  if (eur > p.perPaymentLimitEUR) {
    return {
      decision: 'needs_approval',
      rule: 'limit.per_payment',
      reason: `${fmt(amount, currency)}${eurNote} is above your ${fmt(p.perPaymentLimitEUR, 'EUR')} limit per payment, so you need to approve it.`,
    };
  }

  // 8. The user asked to approve every payment to this recipient
  if (level === 'act' && p.autoPay[recipientId] === false) {
    return {
      decision: 'needs_approval',
      rule: 'pass.recipient_ask',
      reason: r.addedBy === 'claude'
        ? `${r.name} is a new recipient Claude added, so you approve payments to them yourself.`
        : `You asked Claude to always check with you before paying ${r.name.replace(/\.$/, '')}.`,
    };
  }

  // 9. Within the rules, but the pass is Draft: Claude prepares, the user sends
  if (level === 'draft') {
    return {
      decision: 'needs_approval',
      rule: 'pass.draft',
      reason: `Ready to go. Your Agent Pass is set to Draft, so you send it yourself with one tap in the Wise app.`,
    };
  }

  // 10. Allow
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
