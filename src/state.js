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

/** Bump this when the shape of the state changes, so an old state file is replaced on load. */
const STATE_VERSION = 3;

/** Agent Pass levels, from least to most power. */
export const READ_LEVELS = ['none', 'view'];
export const TRANSFER_LEVELS = ['none', 'view', 'draft', 'act'];

export function createInitialState() {
  return {
    version: STATE_VERSION,
    balances: { EUR: 2400, GBP: 300, JPY: 120000 },
    recipients: {
      elisa: { id: 'elisa', name: 'Elisa', currency: 'EUR', iban: 'EE47 1000 0010 2014 5685', note: 'Home internet' },
      jana: { id: 'jana', name: 'Jana Michiels', currency: 'EUR', iban: 'BE71 0961 2345 6769', note: 'Family' },
      hikari: { id: 'hikari', name: 'Hikari Print Co.', currency: 'JPY', iban: 'JP12 0001 1111 2222', note: 'Supplier' },
    },
    // The Wise Agent Pass: what the user lets Claude do, set on the consent screen.
    pass: {
      revoked: false,
      // Like Wise's consent screen: None or View for reading, plus Draft and Act for transfers.
      // A fresh demo starts read-only, so "the wall" can be shown before switching to Act.
      permissions: { balances: 'view', recipients: 'view', rates: 'view', transfers: 'view' },
      perPaymentLimitEUR: 200,
      monthlyLimitEUR: 500,
      allowedCurrencies: ['EUR', 'GBP', 'JPY'],
      spentThisMonthEUR: 0,
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
    if (state.version !== STATE_VERSION) throw new Error('old state file');
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
