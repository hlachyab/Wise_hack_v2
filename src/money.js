// Mock rates and fees, plus small formatting helpers for money and IBANs.

/** Fixed mock mid-market rates, as "1 EUR = X". */
export const RATES_PER_EUR = { EUR: 1, GBP: 0.85, JPY: 162 };
export const CURRENCIES = Object.keys(RATES_PER_EUR);
const SYMBOLS = { EUR: '€', GBP: '£', JPY: '¥' };

export const FEE_PERCENT = 0.43; // mock Wise-style variable fee, %
export const FEE_FIXED_EUR = 0.3; // mock fixed fee, in EUR equivalent

export const round2 = (n) => Math.round(n * 100) / 100;
export const toEUR = (amount, currency) => round2(amount / RATES_PER_EUR[currency]);

/** "€1,234.50", "¥18,500", or "12 XYZ" for an unknown currency. */
export function fmt(amount, currency) {
  const digits = currency === 'JPY' || Number.isInteger(Number(amount)) ? 0 : 2;
  const num = Number(amount).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${num}` : `${num} ${currency}`;
}

export const normIban = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
export const ibanCountry = (s) => normIban(s).slice(0, 2);
export const maskIban = (s) => {
  const n = normIban(s);
  return n ? `•••• ${n.slice(-4)}` : '';
};
