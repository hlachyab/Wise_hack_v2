// The "Wise app" page. Polls /api/state every second and re-renders the four sections.
// Buttons call the user-only API (approve, decline, change the pass, revoke, restore, reset).

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const SYMBOLS = { EUR: '€', GBP: '£', JPY: '¥' };
const NAMES = { EUR: 'Euro', GBP: 'British Pound', JPY: 'Japanese Yen' };
// Flags from the Figma kit's "Flags" section, by currency and by IBAN country code.
const CURRENCY_FLAGS = { EUR: '/assets/flag-eu.png', GBP: '/assets/flag-gb.png', JPY: '/assets/flag-jp.png' };
const COUNTRY_FLAGS = { EE: '/assets/flag-ee.png', JP: '/assets/flag-jp.png', GB: '/assets/flag-gb.png' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (a, c) => {
  const d = c === 'JPY' || Number.isInteger(Number(a)) ? 0 : 2;
  return Number(a).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmt = (a, c) => (SYMBOLS[c] ? SYMBOLS[c] + num(a, c) : `${num(a, c)} ${esc(c)}`);
const initials = (n) => String(n).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const timeAgo = (iso) => {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 10) return 'Just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** Currency flag, or a symbol circle if there is no flag file. */
const currencyFlag = (c, size, fallbackClass) =>
  CURRENCY_FLAGS[c]
    ? `<img class="flag-img" src="${CURRENCY_FLAGS[c]}" width="${size}" height="${size}" alt="${esc(c)} flag" />`
    : `<span class="${fallbackClass}">${esc(SYMBOLS[c] || c[0])}</span>`;

/** Small country flag on the corner of an avatar. */
const flagBadge = (cc) => (COUNTRY_FLAGS[cc] ? `<img class="badge" src="${COUNTRY_FLAGS[cc]}" width="20" height="20" alt="" />` : '');

const avatar = (name, country) => `<span class="icon-btn"><span class="initials">${esc(initials(name))}</span>${flagBadge(country)}</span>`;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const seenApprovals = new Set(); // only cards that appear after page load slide in
let firstRender = true;
let prevBalances = null; // to flash a balance that changed

function renderApprovals(drafts) {
  const pending = drafts.filter((d) => d.status === 'awaiting_user');
  $('pending-count').innerHTML = pending.length ? `<span class="eyebrow" style="margin:0">${pending.length} waiting</span>` : '';
  $('approvals-wrap').innerHTML = pending.length
    ? pending.map((d) => approvalCard(d, !firstRender && !seenApprovals.has(d.id))).join('')
    : `<div class="empty"><span class="icon-btn ok glyph">✓</span>Nothing needs your approval. Payments Claude prepares that break a rule will appear here.</div>`;
  pending.forEach((d) => seenApprovals.add(d.id));
  firstRender = false;
}

function approvalCard(d, isNew) {
  const draftOnly = d.rule === 'pass.draft'; // within the rules; waiting only because the pass is Draft
  const eur = d.amountEUR != null && d.currency !== 'EUR' ? `<span class="eur">≈ ${fmt(d.amountEUR, 'EUR')}</span>` : '';
  return `
    <div class="approval ${isNew ? 'new' : ''}">
      <span class="eyebrow">${draftOnly ? 'Ready for you to send' : 'Claude is asking'}</span>
      <div class="tx" style="padding:0 0 12px">
        ${avatar(d.recipientName, d.iban ? d.iban.slice(0, 2) : '')}
        <div class="meta"><b>${draftOnly ? 'Claude prepared a payment to' : 'Claude wants to pay'} ${esc(d.recipientName)}</b><small>${d.ibanMasked ? 'To account ' + esc(d.ibanMasked) : 'New recipient'}</small></div>
      </div>
      <div class="label">Recipient gets</div>
      <div class="money"><span class="amt">${num(d.amount, d.currency)}</span>
        <span class="ccy">${eur}${currencyFlag(d.currency, 24, 'ccy-dot')}${esc(d.currency)}</span></div>
      <div class="panel">${esc(d.reason)}</div>
      ${d.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
      ${d.note ? `<div class="note">Note: “${esc(d.note)}”</div>` : ''}
      <span class="rule">${esc(d.rule)}</span>
      <div class="btn-row">
        <button class="btn btn-secondary" data-act="decline" data-id="${esc(d.id)}">Decline</button>
        <button class="btn btn-primary" data-act="approve" data-id="${esc(d.id)}">${draftOnly ? 'Send' : 'Approve and send'}</button>
      </div>
    </div>`;
}

function renderBalances(balances) {
  $('balances').innerHTML = Object.entries(balances).map(([c, a]) => `
    <div class="card-btn ${prevBalances && prevBalances[c] !== a ? 'flash' : ''}">
      ${currencyFlag(c, 40, 'ccy-circle')}
      <div><b>${num(a, c)}</b><small>${esc(NAMES[c] || c)}</small></div>
    </div>`).join('');
  if (document.querySelector('.card-btn.flash')) {
    setTimeout(() => document.querySelectorAll('.card-btn.flash').forEach((el) => el.classList.remove('flash')), 900);
  }
  prevBalances = balances;
}

// What each Agent Pass level means, shown on the consent screen and in the access panel.
const LEVELS = {
  none: { name: 'None', help: "Claude can't see this." },
  view: { name: 'View', help: 'Claude can see this, but not change anything.' },
  draft: { name: 'Draft', help: 'Claude prepares transfers. You send each one with one tap in the Wise app.' },
  act: { name: 'Act', help: 'Claude sends money within your limits. Anything else waits for your approval.' },
};
const TRANSFER_HELP = {
  none: "Claude can't see your transfers.",
  view: "Claude can see your transfers, but can't prepare or send money.",
  draft: LEVELS.draft.help,
  act: LEVELS.act.help,
};

let lastPass = null; // the consent screen opens with the current settings

function renderPass(p, recipients) {
  lastPass = p;
  const t = p.permissions.transfers;
  const setChip = (el, on, onText, offText) => {
    el.textContent = on ? onText : offText;
    el.className = 'chip' + (on ? '' : ' off');
  };
  setChip($('pass-badge'), !p.revoked, 'Active', 'Revoked');
  setChip($('conn'), !p.revoked, `Agent Pass · ${LEVELS[t].name}`, 'Claude access off');

  // Hero status pills, like "Connection established" / "Permissions enabled" on the Wise for AI page.
  $('hero-status').innerHTML = p.revoked
    ? `<span class="status-pill off"><i>✕</i>Claude's access is revoked</span>
       <button class="btn btn-dark" data-act="restore">Restore access</button>`
    : `<span class="status-pill"><i>✓</i>Claude connected</span>
       <span class="status-pill"><i>⛨</i>Transfers: ${LEVELS[t].name}${t === 'act' ? ` · up to ${fmt(p.perPaymentLimitEUR, 'EUR')}` : ''}</span>
       <button class="btn btn-dark" data-act="consent">Change permissions</button>`;

  const level = (v) => `<span class="level ${v === 'none' || p.revoked ? 'off' : ''}">${p.revoked ? 'None' : LEVELS[v].name}</span>`;
  const pct = Math.min(100, (p.spentThisMonthEUR / p.monthlyLimitEUR) * 100);
  const left = Math.max(0, p.monthlyLimitEUR - p.spentThisMonthEUR);
  $('pass').innerHTML = `
    <div class="perm-rows">
      <div class="perm-row"><span>Balances</span>${level(p.permissions.balances)}</div>
      <div class="perm-row"><span>Recipients</span>${level(p.permissions.recipients)}</div>
      <div class="perm-row"><span>Exchange rates</span>${level(p.permissions.rates)}</div>
      <div class="perm-row"><span>Transfers<small>${esc(p.revoked ? "Claude can't see or do anything." : TRANSFER_HELP[t])}</small></span>${level(t)}</div>
    </div>
    <div class="limits">
      <div class="limit"><small>Per payment</small><b>${fmt(p.perPaymentLimitEUR, 'EUR')}</b></div>
      <div class="limit"><small>Per month</small><b>${fmt(p.monthlyLimitEUR, 'EUR')}</b></div>
    </div>
    <div class="spend">
      <div class="bar-label"><span>${fmt(p.spentThisMonthEUR, 'EUR')} sent this month</span><span>${fmt(left, 'EUR')} left</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
    </div>
    <div class="group-title">Saved recipients</div>
    ${recipients.map((r) => `
      <div class="tx">
        ${avatar(r.name, r.country)}
        <div class="meta"><b>${esc(r.name)}</b><small>${r.note ? esc(r.note) + ' · ' : ''}${esc(r.currency)} · ${esc(r.iban)}</small></div>
      </div>`).join('')}
    <div class="group-title">Allowed currencies</div>
    <div class="chips">${p.allowedCurrencies.map((c) => `<span class="chip-outline selected">${esc(c)}</span>`).join('')}</div>
    ${p.revoked ? `<div class="revoked-banner">Claude's access is revoked. It can't see your account or move money.</div>` : ''}
    <div class="pass-actions">
      ${p.revoked
        ? `<button class="btn btn-primary" data-act="restore">Restore access</button>`
        : `<button class="btn btn-secondary" data-act="consent">Change permissions</button>
           <button class="btn btn-danger" data-act="revoke">Revoke access</button>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Consent screen
// ---------------------------------------------------------------------------

const consent = $('consent');
const form = $('consent-form');
const PERM_OPTIONS = { balances: ['none', 'view'], recipients: ['none', 'view'], rates: ['none', 'view'], transfers: ['none', 'view', 'draft', 'act'] };
const NEW_LEVELS = new Set(['draft', 'act']); // the levels this project adds to Wise's None / View

function openConsent() {
  if (!lastPass) return;
  for (const [perm, options] of Object.entries(PERM_OPTIONS)) {
    form.querySelector(`[data-perm="${perm}"]`).innerHTML = options.map((v) => `
      <label><input type="radio" name="${perm}" value="${v}" ${lastPass.permissions[perm] === v ? 'checked' : ''} />
        <span>${LEVELS[v].name}${NEW_LEVELS.has(v) ? '<em class="new">NEW</em>' : ''}</span></label>`).join('');
  }
  form.perPaymentLimitEUR.value = lastPass.perPaymentLimitEUR;
  form.monthlyLimitEUR.value = lastPass.monthlyLimitEUR;
  $('consent-error').textContent = '';
  syncConsent();
  consent.showModal();
}

/** Show the help text for the chosen transfer level, and the limits for Draft and Act. */
function syncConsent() {
  const t = form.transfers.value;
  $('transfers-help').textContent = TRANSFER_HELP[t];
  $('perm-limits').hidden = !NEW_LEVELS.has(t);
}

form.addEventListener('change', syncConsent);
consent.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === consent) consent.close(); // ✕, Cancel, or the backdrop
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    permissions: { balances: form.balances.value, recipients: form.recipients.value, rates: form.rates.value, transfers: form.transfers.value },
    perPaymentLimitEUR: Number(form.perPaymentLimitEUR.value),
    monthlyLimitEUR: Number(form.monthlyLimitEUR.value),
  };
  const res = await fetch('/api/pass', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    $('consent-error').textContent = (await res.json().catch(() => ({}))).error || 'Something went wrong.';
    return;
  }
  consent.close();
  lastKey = '';
  poll();
});

// Icon and label for each kind of activity entry.
const ICON_IMG = {
  arrow: '<img src="/assets/arrow-up.svg" width="24" height="24" alt="" />',
  plus: '<img src="/assets/plus.svg" width="24" height="24" alt="" />',
};
function activityLook(a) {
  switch (a.kind) {
    case 'paid': return { icon: ICON_IMG.arrow, cls: '', label: a.byUser ? 'Sent · approved by you' : 'Sent by Claude' };
    case 'pass': return { icon: '✓', cls: 'ok glyph', label: 'Agent Pass updated' };
    case 'declined': return { icon: '✕', cls: 'no glyph', label: 'Declined by you', muted: true };
    case 'blocked': return { icon: '✕', cls: 'no glyph', label: 'Blocked at send time', muted: true };
    case 'revoked': return { icon: '⏻', cls: 'no glyph', label: 'Access revoked' };
    case 'restored': return { icon: '↺', cls: 'glyph', label: 'Access restored' };
    case 'prepared':
      if (a.decision === 'needs_approval') return { icon: '!', cls: 'wait glyph', label: 'Waiting for you' };
      if (a.decision === 'block') return { icon: '✕', cls: 'no glyph', label: 'Blocked', muted: true };
      return { icon: ICON_IMG.plus, cls: '', label: 'Prepared by Claude' };
    default: return { icon: '•', cls: 'glyph', label: '' };
  }
}

function renderActivity(activity, drafts) {
  const draftsById = Object.fromEntries(drafts.map((d) => [d.id, d]));
  $('activity').innerHTML = activity.length
    ? activity.map((a) => {
        const look = activityLook(a);
        const d = a.draftId ? draftsById[a.draftId] : null;
        const title = d ? d.recipientName : ['revoked', 'restored', 'pass'].includes(a.kind) ? 'Claude' : 'Wise';
        const amount = d ? `<span class="amount ${look.muted ? 'muted' : ''}">${num(d.amount, d.currency)} ${esc(d.currency)}</span>` : '';
        return `<div class="tx">
          <span class="icon-btn ${look.cls}">${look.icon}</span>
          <div class="meta">
            <div class="head"><b>${esc(title)}</b>${amount}</div>
            <small>${esc(look.label)} · ${timeAgo(a.ts)}</small>
            <p>${esc(a.text)}</p>
            ${a.rule ? `<span class="rule">${esc(a.rule)}</span>` : ''}
          </div>
        </div>`;
      }).join('')
    : `<div class="empty"><span class="icon-btn glyph">·</span>No activity yet. Ask Claude to pay someone.</div>`;
}

function render(s) {
  const first = !lastPass;
  renderApprovals(s.drafts);
  renderBalances(s.balances);
  renderPass(s.pass, s.recipients);
  renderActivity(s.activity, s.drafts);
  if (first && location.hash === '#consent') openConsent(); // direct link to the consent screen
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let lastKey = '';

const API_VERSION = 3; // must match STATE_VERSION in src/state.js

async function poll() {
  let s;
  try {
    s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    $('offline').style.display = 'none';
  } catch {
    $('offline').style.display = 'block';
    return;
  }
  // An older server (e.g. a Claude Desktop copy started before an update) sends a different
  // shape. Say so clearly instead of rendering a broken page.
  const outdated = s.version !== API_VERSION;
  $('outdated').style.display = outdated ? 'block' : 'none';
  if (outdated) return;
  // Re-render when the state changes, and at least every 10s so "time ago" stays fresh.
  const key = JSON.stringify(s) + Math.floor(Date.now() / 10000);
  if (key !== lastKey) {
    lastKey = key;
    render(s);
  }
}

async function post(url) {
  try {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) console.warn((await res.json().catch(() => ({}))).error || res.statusText);
  } finally {
    lastKey = '';
    poll();
  }
}

const ACTIONS = {
  approve: (id) => post(`/api/drafts/${encodeURIComponent(id)}/approve`),
  decline: (id) => post(`/api/drafts/${encodeURIComponent(id)}/decline`),
  revoke: () => post('/api/revoke'),
  restore: () => post('/api/restore'),
  consent: openConsent,
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) ACTIONS[b.dataset.act]?.(b.dataset.id);
});
// "Try asking Claude" cards copy their prompt, so the presenter can paste it into Claude.
document.querySelectorAll('[data-copy]').forEach((card) => {
  card.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(card.dataset.copy);
      card.classList.add('copied');
      setTimeout(() => card.classList.remove('copied'), 1500);
    } catch { /* clipboard blocked: the text is on the card anyway */ }
  });
});

$('reset').addEventListener('click', () => {
  prevBalances = null;
  post('/api/reset');
});

poll();
setInterval(poll, 1000);
