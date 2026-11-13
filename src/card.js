// The inline "Wise card" shown inside Claude's chat (MCP Apps).
//
// Every tool declares _meta.ui.resourceUri = CARD_URI. A host that supports MCP Apps
// (Claude Desktop) reads that resource once and renders it in a sandboxed iframe, then
// sends each tool result's structuredContent to it. Hosts without MCP Apps just show
// the text content.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { ibanCountry } from './money.js';

export const CARD_URI = 'ui://wise/card.html';
const CARD_MIME = 'text/html;profile=mcp-app';
const CARD_DIR = path.join(ROOT, 'ui');

// prefersBorder:false asks the host not to wrap the card in its own border and background.
// The CSP lets the card load the Inter font from Google Fonts.
const CARD_UI_META = {
  prefersBorder: false,
  csp: { resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] },
};

/** _meta to put on every tool so the host renders the card. Includes the legacy key. */
export const TOOL_UI_META = { ui: { resourceUri: CARD_URI }, 'ui/resourceUri': CARD_URI };

// The card runs with no network access to localhost, so each `__ASSET:file__` placeholder
// in card.html is replaced with the file from ui/assets as a data URI. A missing file
// becomes '' and the card shows its built-in fallback (e.g. a symbol instead of a flag).
function embedAssets(html) {
  return html.replace(/__ASSET:([\w.-]+)__/g, (_, file) => {
    const p = path.join(CARD_DIR, 'assets', file);
    if (!fs.existsSync(p)) return '';
    const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });
}

export function registerCard(mcp) {
  mcp.registerResource(
    'wise-card',
    CARD_URI,
    { title: 'Wise payment card', description: 'Inline card showing balances, quotes and payment status', mimeType: CARD_MIME, _meta: { ui: CARD_UI_META } },
    async () => ({
      contents: [
        {
          uri: CARD_URI,
          mimeType: CARD_MIME,
          text: embedAssets(fs.readFileSync(path.join(CARD_DIR, 'card.html'), 'utf8')),
          _meta: { ui: CARD_UI_META },
        },
      ],
    })
  );
}

/** The fields of a draft the card needs. Never includes the full IBAN. */
export const cardFor = (d) => ({
  draftId: d.id,
  status: d.status,
  rule: d.rule,
  reason: d.reason,
  warnings: d.warnings,
  recipient: d.recipientName,
  ibanMasked: d.ibanMasked,
  country: d.iban ? ibanCountry(d.iban) : null, // for the flag badge
  amount: d.amount,
  currency: d.currency,
  amountEUR: d.amountEUR,
  note: d.note,
  sentByUser: !!d.sentByUser,
});
