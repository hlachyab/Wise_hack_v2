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
  $('pending-count').innerHTML = pending.length ? `<span class="eyebrow">${pending.length} waiting</span>` : '';
  $('nav-count').textContent = pending.length || '';
  $('approvals-wrap').innerHTML = pending.length
    ? pending.map((d) => approvalCard(d, !firstRender && !seenApprovals.has(d.id))).join('')
    : `<div class="empty"><span class="icon-btn ok glyph">✓</span>Nothing needs your approval. Payments Claude prepares that break a rule will appear here.</div>`;
  if (!firstRender) pending.filter((d) => !seenApprovals.has(d.id)).reverse().forEach(notifyApproval);
  pruneToasts(pending);
  pending.forEach((d) => seenApprovals.add(d.id));
  firstRender = false;
}

function approvalCard(d, isNew) {
  const draftOnly = d.rule === 'pass.draft'; // within the rules; waiting only because the pass is Draft
  const eur = d.amountEUR != null && d.currency !== 'EUR' ? `<span class="eur">≈ ${fmt(d.amountEUR, 'EUR')}</span>` : '';
  return `
    <div class="approval ${isNew ? 'new' : ''}">
      <div class="approval-top"><span>${draftOnly ? 'Ready for you to send' : 'Claude is asking'}</span><span>${timeAgo(d.createdAt)}</span></div>
      <div class="approval-body">
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
      </div>
    </div>`;
}

/** "Claude" account card: what is waiting for you right now. */
function renderWaiting(drafts) {
  const pending = drafts.filter((d) => d.status === 'awaiting_user');
  const sent = drafts.filter((d) => d.status === 'paid').length;
  $('waiting-card').innerHTML = `
    <div class="acct-title"><b>Waiting for you</b><span class="chev">›</span></div>
    <div class="acct-big">${pending.length}</div>
    <div class="acct-sub">${pending.length ? pending.slice(0, 2).map((d) => `${esc(d.recipientName)} · ${fmt(d.amount, d.currency)}`).join('<br>') : 'Nothing to approve'}</div>
    <div class="acct-lines"><div><span>Sent through Claude</span><b>${sent}</b></div></div>`;
}

const RATES_PER_EUR = { EUR: 1, GBP: 0.85, JPY: 162 }; // same mock rates as the server

function renderBalances(balances) {
  const totalEUR = Object.entries(balances).reduce((t, [c, a]) => t + a / (RATES_PER_EUR[c] || 1), 0);
  $('total').textContent = `${totalEUR.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
  $('main-total').textContent = fmt(balances.EUR ?? 0, 'EUR');
  $('balances').innerHTML = Object.entries(balances).map(([c, a]) => `
    <div class="ccy-item ${prevBalances && prevBalances[c] !== a ? 'flash' : ''}">
      ${currencyFlag(c, 36, 'ccy-dot')}<span>${fmt(a, c)}</span><span class="chev">›</span>
    </div>`).join('');
  if (document.querySelector('.ccy-item.flash')) {
    setTimeout(() => document.querySelectorAll('.ccy-item.flash').forEach((el) => el.classList.remove('flash')), 900);
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

/** "in 29 days", "in 3 hours", "in 12 min". */
const timeLeft = (iso) => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  if (m >= 2880) return `in ${Math.round(m / 1440)} days`;
  if (m >= 120) return `in ${Math.round(m / 60)} hours`;
  return `in ${m} min`;
};

function renderPass(p, recipients) {
  lastPass = p;
  lastRecipients = recipients;
  const t = p.permissions.transfers;
  const off = p.revoked || p.expired; // Claude can't see or do anything
  const offWord = p.revoked ? 'Revoked' : 'Expired';
  $('pass-badge').textContent = off ? offWord : 'Active';
  $('pass-badge').className = 'chip' + (off ? ' off' : '');
  $('conn').textContent = off ? `Claude access ${p.revoked ? 'off' : 'expired'}` : `Agent Pass · ${LEVELS[t].name}`;
  $('conn').className = 'pill ' + (off ? 'off' : 'pill-green');
  const expiresLine = p.expiresAt && !p.expired ? ` Access ends ${timeLeft(p.expiresAt)}.` : '';

  // Light-blue banner, like "Get ready to spend" on the Wise home screen.
  const banner = $('hero-status');
  banner.className = 'banner' + (off ? ' off' : '');
  banner.innerHTML = off
    ? `<span class="banner-icon"><svg viewBox="0 0 24 24"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/></svg></span>
       <div><h3>Claude's access ${p.revoked ? 'is revoked' : 'has expired'}</h3><p>Claude can't see your account or move money until you ${p.revoked ? 'restore' : 'renew'} it.</p>
       <div class="btn-row"><button class="btn btn-teal" data-act="restore">${p.revoked ? 'Restore' : 'Renew'} access</button></div></div>`
    : `<span class="banner-icon"><svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8L18 21l-.8-2.4-2-.8 2-.8z"/></svg></span>
       <div><h3>Claude is connected to your Wise account</h3><p>${esc(TRANSFER_HELP[t])}${t === 'act' ? ` Up to ${fmt(p.perPaymentLimitEUR, 'EUR')} per payment.` : ''}${expiresLine}</p>
       <div class="btn-row"><button class="btn btn-teal" data-act="consent">Change permissions</button></div></div>`;
  $('revoke-slot').innerHTML = off
    ? `<button class="pill pill-light pill-lg" data-act="restore">${p.revoked ? 'Restore' : 'Renew'} access</button>`
    : `<button class="pill pill-light pill-lg" data-act="revoke">Revoke access</button>`;

  // Yellow "Agent Pass" account card.
  const pct = Math.min(100, (p.spentThisMonthEUR / p.monthlyLimitEUR) * 100);
  $('pass-card').innerHTML = `
    <div class="acct-title"><b>${off ? offWord : LEVELS[t].name}</b><span class="chev">›</span></div>
    <div class="acct-sub">${off ? 'Claude has no access' : p.expiresAt ? `Ends ${timeLeft(p.expiresAt)}` : 'Transfers level for Claude'}</div>
    <div class="acct-lines">
      <div><span>Per payment</span><b>${fmt(p.perPaymentLimitEUR, 'EUR')}</b></div>
      <div><span>Today</span><b>${p.sentTodayCount} / ${p.dailyCountLimit} payments</b></div>
      <div><span>This month</span><b>${fmt(p.spentThisMonthEUR, 'EUR')} / ${fmt(p.monthlyLimitEUR, 'EUR')}</b></div>
    </div>
    <div class="bar"><div style="width:${pct}%"></div></div>`;

  // "Claude's access" panel
  const level = (v) => `<span class="level ${v === 'none' || off ? 'off' : ''}">${off ? 'None' : LEVELS[v].name}</span>`;
  const left = Math.max(0, p.monthlyLimitEUR - p.spentThisMonthEUR);
  const recipientMode = (r) => t !== 'act' ? '' : p.autoPay[r.id] === false
    ? '<span class="mode ask">Always asks</span>' : '<span class="mode auto">Pays on its own</span>';
  $('pass').innerHTML = `
    <div class="perm-rows">
      <div class="perm-row"><span>Balances</span>${level(p.permissions.balances)}</div>
      <div class="perm-row"><span>Recipients</span>${level(p.permissions.recipients)}</div>
      <div class="perm-row"><span>Exchange rates</span>${level(p.permissions.rates)}</div>
      <div class="perm-row"><span>Transfers<small>${esc(off ? "Claude can't see or do anything." : TRANSFER_HELP[t])}</small></span>${level(t)}</div>
      <div class="perm-row"><span>Access lasts</span><span class="level ${p.expired ? 'off' : ''}">${p.expired ? 'Expired' : p.expiresAt ? 'Ends ' + timeLeft(p.expiresAt) : 'Until revoked'}</span></div>
    </div>
    <div class="limits">
      <div class="limit"><small>Per payment</small><b>${fmt(p.perPaymentLimitEUR, 'EUR')}</b></div>
      <div class="limit"><small>Per month</small><b>${fmt(p.monthlyLimitEUR, 'EUR')}</b></div>
      <div class="limit"><small>Per day</small><b>${p.dailyCountLimit} payment${p.dailyCountLimit === 1 ? '' : 's'}</b></div>
      <div class="limit"><small>Sent today</small><b>${p.sentTodayCount}</b></div>
    </div>
    <div class="spend">
      <div class="bar-label"><span>${fmt(p.spentThisMonthEUR, 'EUR')} sent this month</span><span>${fmt(left, 'EUR')} left</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
    </div>
    <div class="group-title">Saved recipients</div>
    ${recipients.map((r) => `
      <div class="tx">
        ${avatar(r.name, r.country)}
        <div class="meta"><div class="head"><b>${esc(r.name)}</b>${recipientMode(r)}</div><small>${r.note ? esc(r.note) + ' · ' : ''}${esc(r.currency)} · ${esc(r.iban)}</small></div>
      </div>`).join('')}
    <div class="group-title">Allowed currencies</div>
    <div class="chips">${p.allowedCurrencies.length ? p.allowedCurrencies.map((c) => `<span class="chip-outline">${esc(c)}</span>`).join('') : '<span class="hint">None</span>'}</div>
    <div class="pass-actions">
      ${off
        ? `<button class="btn btn-primary" data-act="restore">${p.revoked ? 'Restore' : 'Renew'} access</button>`
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
const EXPIRY = { '1h': '1 hour', '1d': '1 day', '30d': '30 days', never: 'Until revoked' };
const ALL_CURRENCIES = ['EUR', 'GBP', 'JPY'];
let lastRecipients = [];

// One-tap starting points. Each sets the whole form; the user can still adjust anything.
const PRESETS = {
  look: { permissions: { balances: 'view', recipients: 'view', rates: 'view', transfers: 'view' }, expiry: '1d' },
  draft: { permissions: { balances: 'view', recipients: 'view', rates: 'view', transfers: 'draft' }, expiry: '30d', perPaymentLimitEUR: 200, monthlyLimitEUR: 500 },
  bills: {
    permissions: { balances: 'view', recipients: 'view', rates: 'view', transfers: 'act' }, expiry: '30d',
    perPaymentLimitEUR: 200, monthlyLimitEUR: 500, dailyCountLimit: 3, allowedCurrencies: ['EUR'],
    autoPay: { elisa: true, jana: false, hikari: false },
  },
};

const radios = (name, options, current, label = (v) => LEVELS[v].name) => options.map((v) => `
  <label><input type="radio" name="${name}" value="${v}" ${current === v ? 'checked' : ''} />
    <span>${label(v)}${NEW_LEVELS.has(v) ? '<em class="new">NEW</em>' : ''}</span></label>`).join('');

/** Fill the form from a pass-like object (the current pass, or a preset merged over it). */
function fillConsent(p) {
  for (const [perm, options] of Object.entries(PERM_OPTIONS)) {
    form.querySelector(`[data-perm="${perm}"]`).innerHTML = radios(perm, options, p.permissions[perm]);
  }
  form.querySelector('[data-perm="expiry"]').innerHTML = radios('expiry', Object.keys(EXPIRY), p.expiry, (v) => EXPIRY[v]);
  form.perPaymentLimitEUR.value = p.perPaymentLimitEUR;
  form.monthlyLimitEUR.value = p.monthlyLimitEUR;
  form.dailyCountLimit.value = p.dailyCountLimit;
  $('consent-currencies').innerHTML = ALL_CURRENCIES.map((c) => `
    <label class="toggle-chip"><input type="checkbox" name="currency" value="${c}" ${p.allowedCurrencies.includes(c) ? 'checked' : ''} />
      <span>${currencyFlag(c, 20, 'ccy-dot')}${c}</span></label>`).join('');
  $('consent-recipients').innerHTML = lastRecipients.map((r) => `
    <label class="switch-row">${avatar(r.name, r.country)}
      <span class="switch-text"><b>${esc(r.name)}</b><small data-auto-label="${esc(r.id)}"></small></span>
      <input type="checkbox" class="switch" name="autopay" value="${esc(r.id)}" ${p.autoPay[r.id] !== false ? 'checked' : ''} /></label>`).join('');
}

function openConsent() {
  if (!lastPass) return;
  fillConsent(lastPass);
  $('consent-error').textContent = '';
  syncConsent();
  consent.showModal();
}

/** Read the form into the body that POST /api/pass expects. */
function readConsent() {
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]`)];
  return {
    permissions: { balances: form.balances.value, recipients: form.recipients.value, rates: form.rates.value, transfers: form.transfers.value },
    perPaymentLimitEUR: Number(form.perPaymentLimitEUR.value),
    monthlyLimitEUR: Number(form.monthlyLimitEUR.value),
    dailyCountLimit: Number(form.dailyCountLimit.value),
    allowedCurrencies: checked('currency').filter((i) => i.checked).map((i) => i.value),
    autoPay: Object.fromEntries(checked('autopay').map((i) => [i.value, i.checked])),
    expiry: form.expiry.value,
  };
}

/** Which preset (if any) the form matches right now. */
function matchingPreset(body) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [name, pr] of Object.entries(PRESETS)) {
    if (Object.entries(pr).every(([k, v]) => (k === 'permissions' || k === 'autoPay' ? Object.entries(v).every(([kk, vv]) => body[k][kk] === vv) : same(body[k], v)))) return name;
  }
  return 'custom';
}

/** Show/hide parts for the chosen level, and rewrite the plain-English summary. */
function syncConsent() {
  const b = readConsent();
  const t = b.permissions.transfers;
  $('transfers-help').textContent = TRANSFER_HELP[t];
  $('perm-limits').hidden = !NEW_LEVELS.has(t);
  form.querySelectorAll('.act-only').forEach((el) => (el.hidden = t !== 'act'));
  for (const [id, on] of Object.entries(b.autoPay)) {
    const el = form.querySelector(`[data-auto-label="${id}"]`);
    if (el) el.textContent = on ? 'Pays on its own, within your limits' : 'Always asks you first';
  }
  const preset = matchingPreset(b);
  document.querySelectorAll('.preset').forEach((el) => el.classList.toggle('on', el.dataset.preset === preset));

  // Plain-English summary
  const sees = ['balances', 'recipients', 'rates'].filter((k) => b.permissions[k] === 'view')
    .map((k) => ({ balances: 'balances', recipients: 'recipients', rates: 'exchange rates' }[k]));
  const names = Object.fromEntries(lastRecipients.map((r) => [r.id, r.name]));
  const auto = Object.entries(b.autoPay).filter(([, on]) => on).map(([id]) => names[id]);
  const ask = Object.entries(b.autoPay).filter(([, on]) => !on).map(([id]) => names[id]);
  const ccy = b.allowedCurrencies.length ? b.allowedCurrencies.join(', ') : 'no currencies';
  const can = [], asks = [], cannot = [];
  if (sees.length) can.push(`See your ${list(sees)}`);
  if (t === 'view' || t === 'none') cannot.push('Prepare or send any money');
  if (t === 'draft') { can.push(`Prepare payments in ${ccy}`); asks.push('Every payment: you send it with one tap'); }
  if (t === 'act') {
    if (auto.length) can.push(`Pay ${list(auto)} up to ${fmt(b.perPaymentLimitEUR, 'EUR')} each, in ${ccy}`);
    if (ask.length) asks.push(`Any payment to ${list(ask)}`);
    asks.push(`Over ${fmt(b.perPaymentLimitEUR, 'EUR')}, over ${fmt(b.monthlyLimitEUR, 'EUR')} a month, or more than ${b.dailyCountLimit} a day`);
  }
  if (t === 'draft' || t === 'act') asks.push('New recipients or changed bank details');
  cannot.push('Add recipients or change these settings');
  const line = (cls, title, items) => items.length ? `<div class="sum ${cls}"><b>${title}</b><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '';
  $('consent-summary').innerHTML =
    line('can', 'Claude can', can) + line('ask', 'Claude asks you first', asks) + line('cannot', 'Claude can never', cannot) +
    `<div class="sum-foot">Access ${b.expiry === 'never' ? 'lasts until you revoke it' : `ends in ${EXPIRY[b.expiry]}`}.</div>`;
}
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

form.addEventListener('change', syncConsent);
form.addEventListener('input', syncConsent);
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (!b || !PRESETS[b.dataset.preset]) return;
  const pr = PRESETS[b.dataset.preset];
  fillConsent({ ...lastPass, ...pr, permissions: { ...lastPass.permissions, ...pr.permissions }, autoPay: { ...lastPass.autoPay, ...(pr.autoPay || {}) } });
  syncConsent();
});
consent.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === consent) consent.close(); // ✕, Cancel, or the backdrop
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = readConsent();
  if (NEW_LEVELS.has(body.permissions.transfers) && !body.allowedCurrencies.length) {
    $('consent-error').textContent = 'Pick at least one currency, or set Transfers to View.';
    return;
  }
  const res = await fetch('/api/pass', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    $('consent-error').textContent = (await res.json().catch(() => ({}))).error || 'Something went wrong.';
    return;
  }
  consent.close();
  lastKey = '';
  poll();
});

// ---------------------------------------------------------------------------
// Pop-up notifications for new approvals
// ---------------------------------------------------------------------------

const toasts = $('toasts');
const notifyOk = () => 'Notification' in window && Notification.permission === 'granted';

function syncBell() {
  const btn = $('notify-btn');
  if (!('Notification' in window)) { btn.hidden = true; return; }
  btn.classList.toggle('on', notifyOk());
  btn.title = notifyOk() ? 'Notifications are on' : 'Turn on notifications';
}
$('notify-btn').addEventListener('click', async () => {
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  syncBell();
});
syncBell();

/** A new payment is waiting: pop up in the page, and as a system notification if allowed. */
function notifyApproval(d) {
  const draftOnly = d.rule === 'pass.draft';
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.id = d.id;
  el.innerHTML = `
    <div class="toast-top"><span>${draftOnly ? 'Ready for you to send' : 'Claude is asking'}</span><button class="toast-x" aria-label="Dismiss">✕</button></div>
    <div class="toast-body">
      ${avatar(d.recipientName, d.iban ? d.iban.slice(0, 2) : '')}
      <div class="meta"><b>${esc(d.recipientName)} · ${fmt(d.amount, d.currency)}</b><small>${esc(d.reason)}</small></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" data-act="decline" data-id="${esc(d.id)}">Decline</button>
      <button class="btn btn-primary" data-act="approve" data-id="${esc(d.id)}">${draftOnly ? 'Send' : 'Approve'}</button>
    </div>`;
  el.querySelector('.toast-x').addEventListener('click', () => el.remove());
  toasts.prepend(el);
  document.title = `(${$('nav-count').textContent || 1}) Wise · Agent Pass`;

  if (notifyOk() && document.hidden) {
    const n = new Notification(draftOnly ? 'Ready for you to send' : 'Claude is asking to pay', {
      body: `${d.recipientName} · ${fmt(d.amount, d.currency)}\n${d.reason}`,
      tag: d.id,
    });
    n.onclick = () => { window.focus(); n.close(); };
  }
}

/** Remove pop-ups for drafts that are no longer waiting (approved, declined, or reset). */
function pruneToasts(pending) {
  const ids = new Set(pending.map((d) => d.id));
  toasts.querySelectorAll('.toast').forEach((el) => { if (!ids.has(el.dataset.id)) el.remove(); });
  if (!pending.length) document.title = 'Wise · Agent Pass';
}

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
  renderWaiting(s.drafts);
  renderActivity(s.activity, s.drafts);
  if (first && location.hash === '#consent') openConsent(); // direct link to the consent screen
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let lastKey = '';

const API_VERSION = 4; // must match STATE_VERSION in src/state.js

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
