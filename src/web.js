// The "Wise app" web page (the user's side) and its small JSON API.
// This is the only place where payments can be approved or declined, or AI access revoked.

import express from 'express';
import path from 'node:path';
import { ROOT } from './paths.js';
import { load, save, state } from './state.js';
import { ibanCountry, maskIban } from './money.js';
import { ActionError, approveDraft, declineDraft, resetDemo, restoreMandate, revokeMandate } from './payments.js';
import { log } from './log.js';

const HOST = '127.0.0.1'; // local only
const RETRY_MS = 2000;

/** What the web page sees. IBANs are masked. */
function publicState() {
  return {
    balances: state.balances,
    recipients: Object.values(state.recipients).map((r) => ({ ...r, iban: maskIban(r.iban), country: ibanCountry(r.iban) })),
    mandate: state.mandate,
    drafts: Object.values(state.drafts).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    activity: state.activity,
  };
}

/** POST handler: load state, run the action, save, reply with the new state. */
const action = (fn) => (req, res) => {
  load();
  try {
    fn(req);
    save();
    res.json(publicState());
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    res.status(e.status).json({ error: e.message });
  }
};

export function createWebApp() {
  const app = express();
  app.use(express.static(path.join(ROOT, 'public')));

  app.get('/api/state', (_req, res) => {
    load();
    res.json(publicState());
  });
  app.post('/api/drafts/:id/approve', action((req) => approveDraft(req.params.id)));
  app.post('/api/drafts/:id/decline', action((req) => declineDraft(req.params.id)));
  app.post('/api/revoke', action(revokeMandate));
  app.post('/api/restore', action(restoreMandate));
  app.post('/api/reset', action(resetDemo));

  return app;
}

/**
 * Start listening. If another copy of the server already has the port, that's fine:
 * state is shared through the file. Keep retrying quietly so this copy takes over
 * if the other one exits.
 */
export function startWebServer(app, port) {
  const server = app.listen(port, HOST, () => log(`Wise app running at http://localhost:${port}`));
  let warned = false;
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') return log('HTTP server error:', err);
    if (!warned) log(`Port ${port} is busy (another copy is serving the web app; state is shared). Will take over if it exits.`);
    warned = true;
    setTimeout(() => server.listen(port, HOST), RETRY_MS).unref();
  });
  return server;
}
