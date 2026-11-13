// Shared demo state, stored in a small JSON file.
//
// Claude Desktop sometimes launches the same MCP server twice, and only one copy can own
// port 4000, so every copy must see the same data. Each operation therefore runs
// load -> change -> save (see tx()).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './paths.js';

const STATE_FILE = process.env.WISE_STATE_FILE || path.join(ROOT, '.wise-state.json');
const MAX_ACTIVITY = 100;

export function createInitialState() {
  return {
    balances: { EUR: 2400, GBP: 300, JPY: 120000 },
    recipients: {
      maria: { id: 'maria', name: 'Maria Tamm', currency: 'EUR', iban: 'EE38 2200 2210 2014 5685' },
      hikari: { id: 'hikari', name: 'Hikari Print Co.', currency: 'JPY', iban: 'JP12 0001 1111 2222' },
    },
    mandate: {
      perPaymentLimitEUR: 200,
      monthlyLimitEUR: 1000,
      allowedCurrencies: ['EUR', 'GBP', 'JPY'],
      spentThisMonthEUR: 0,
      revoked: false,
    },
    drafts: {},
    activity: [],
  };
}

/** The current state. A live binding: importers always see the latest value. */
export let state;

export function load() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = createInitialState();
    save();
  }
}

export function save() {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic replace
}

export function resetState() {
  state = createInitialState();
}

/** Wrap a synchronous handler: fresh state in, persisted state out. */
export const tx =
  (fn) =>
  (...args) => {
    load();
    try {
      return fn(...args);
    } finally {
      save();
    }
  };

export function addActivity(entry) {
  state.activity.unshift({ id: randomUUID(), ts: new Date().toISOString(), ...entry });
  if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
}

load();
