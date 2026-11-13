// The "Wise app" page. Polls /api/state every second and re-renders the four sections.
// Buttons call the user-only API (approve, decline, revoke, restore, reset).

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
  const eur = d.amountEUR != null && d.currency !== 'EUR' ? `<span class="eur">≈ ${fmt(d.amountEUR, 'EUR')}</span>` : '';
  return `
    <div class="approval ${isNew ? 'new' : ''}">
      <span class="eyebrow">Claude is asking</span>
      <div class="tx" style="padding:0 0 12px">
        ${avatar(d.recipientName, d.iban ? d.iban.slice(0, 2) : '')}
        <div class="meta"><b>Claude wants to pay ${esc(d.recipientName)}</b><small>${d.ibanMasked ? 'To account ' + esc(d.ibanMasked) : 'New recipient'}</small></div>
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
        <button class="btn btn-primary" data-act="approve" data-id="${esc(d.id)}">Approve</button>
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

function renderMandate(m, recipients) {
  const setChip = (el, on, onText, offText) => {
    el.textContent = on ? onText : offText;
    el.className = 'chip' + (on ? '' : ' off');
  };
  setChip($('mandate-badge'), !m.revoked, 'Active', 'Revoked');
  setChip($('conn'), !m.revoked, 'AI Mandate', 'AI access off');

  const pct = Math.min(100, (m.spentThisMonthEUR / m.monthlyLimitEUR) * 100);
  const left = Math.max(0, m.monthlyLimitEUR - m.spentThisMonthEUR);
  $('mandate').innerHTML = `
    <div class="limits">
      <div class="limit"><small>Per payment</small><b>${fmt(m.perPaymentLimitEUR, 'EUR')}</b></div>
      <div class="limit"><small>Per month</small><b>${fmt(m.monthlyLimitEUR, 'EUR')}</b></div>
    </div>
    <div class="spend">
      <div class="bar-label"><span>${fmt(m.spentThisMonthEUR, 'EUR')} spent this month</span><span>${fmt(left, 'EUR')} left</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
    </div>
    <div class="group-title">Trusted recipients</div>
    ${recipients.map((r) => `
      <div class="tx">
        ${avatar(r.name, r.country)}
        <div class="meta"><b>${esc(r.name)}</b><small>${esc(r.currency)} · ${esc(r.iban)}</small></div>
      </div>`).join('')}
    <div class="group-title">Allowed currencies</div>
    <div class="chips">${m.allowedCurrencies.map((c) => `<span class="chip-outline selected">${esc(c)}</span>`).join('')}</div>
    ${m.revoked ? `<div class="revoked-banner">Claude's access is revoked. Every new AI payment is blocked.</div>` : ''}
    <div class="mandate-actions">
      ${m.revoked
        ? `<button class="btn btn-primary" data-act="restore">Restore AI access</button>`
        : `<button class="btn btn-danger" data-act="revoke">Revoke AI access</button>`}
    </div>`;
}

// Icon and label for each kind of activity entry.
const ICON_IMG = {
  arrow: '<img src="/assets/arrow-up.svg" width="24" height="24" alt="" />',
  plus: '<img src="/assets/plus.svg" width="24" height="24" alt="" />',
};
function activityLook(a) {
  switch (a.kind) {
    case 'paid': return { icon: ICON_IMG.arrow, cls: '', label: 'Sent' };
    case 'approved': return { icon: '✓', cls: 'ok glyph', label: 'Approved by you' };
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
        const title = d ? d.recipientName : a.kind === 'revoked' || a.kind === 'restored' ? 'Claude' : 'Wise';
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
  renderApprovals(s.drafts);
  renderBalances(s.balances);
  renderMandate(s.mandate, s.recipients);
  renderActivity(s.activity, s.drafts);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let lastKey = '';

async function poll() {
  try {
    const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    $('offline').style.display = 'none';
    // Re-render when the state changes, and at least every 10s so "time ago" stays fresh.
    const key = JSON.stringify(s) + Math.floor(Date.now() / 10000);
    if (key !== lastKey) {
      lastKey = key;
      render(s);
    }
  } catch {
    $('offline').style.display = 'block';
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
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) ACTIONS[b.dataset.act]?.(b.dataset.id);
});
$('reset').addEventListener('click', () => {
  prevBalances = null;
  post('/api/reset');
});

poll();
setInterval(poll, 1000);
