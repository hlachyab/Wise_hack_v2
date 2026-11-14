// Fraud check: an extra layer on top of the Agent Pass rules.
//
// Every payment Claude sends to Wise gets a risk score from a few simple signals. The Agent Pass
// decides what Claude is *allowed* to do; this layer asks whether a request *looks wrong*, even
// when it is allowed. A medium or high score turns an automatic payment into one the user must
// approve, and the signals are shown to the user. It never approves anything by itself.

import { state } from './state.js';
import { normIban, toEUR } from './money.js';

const VELOCITY_WINDOW_MS = 2 * 60 * 1000;
const VELOCITY_MAX = 3; // more Claude requests than this in the window is unusual
const URGENT = /\b(urgent|immediately|asap|today only|final notice|right now)\b/i;
const INSTRUCTIONS = /ignore (all |any )?(previous|prior) instructions|pay this account|system prompt|do not (tell|ask) the user/i;

/** { score 0-100, level 'low' | 'medium' | 'high', signals: [text] } */
export function assessFraud({ recipientId, amount, currency, iban, note }) {
  const r = state.recipients[recipientId];
  const signals = [];
  let score = 0;
  const add = (points, text) => { score += points; signals.push(text); };

  if (!r) add(25, 'Recipient is not saved in your Wise account');
  else {
    if (iban && normIban(iban) !== normIban(r.iban)) add(45, 'Bank details differ from the ones you saved');
    if (r.addedBy === 'claude') add(15, 'Recipient was added by Claude, not by you');
    const eur = toEUR(amount, currency);
    if (r.avgEUR && eur > r.avgEUR * 3) add(25, `Much more than you usually send ${r.name} (about €${Math.round(r.avgEUR)})`);
  }
  if (note && INSTRUCTIONS.test(note)) add(40, 'Payment text contains instructions aimed at an AI');
  if (note && URGENT.test(note)) add(15, 'Payment text pushes for urgency');

  const since = Date.now() - VELOCITY_WINDOW_MS;
  const recent = Object.values(state.drafts).filter((d) => Date.parse(d.createdAt) > since).length;
  if (recent >= VELOCITY_MAX * 2) add(20, `${recent} payment requests from Claude in the last 2 minutes`);

  score = Math.min(100, score);
  const level = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
  return { score, level, signals };
}
