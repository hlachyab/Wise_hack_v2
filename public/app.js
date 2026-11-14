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

// A soft colour per recipient, so people are easy to tell apart.
const TINTS = ['#E2F6D5', '#FCEC7D', '#E4F6F7', '#FFE1D6', '#E8E1FA', '#EDEFEB'];
const tint = (s) => TINTS[[...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];
/** Round icon with initials (and a country flag) for a recipient. */
const personIcon = (r) => `<span class="person" style="background:${tint(r.name)}">${esc(initials(r.name))}${flagBadge(r.country)}</span>`;

/** The Claude app icon, for anything Claude asked for or did. */
const claudeIcon = (size = 20) => `<img class="claude-ico" src="/assets/claude-icon.png" width="${size}" height="${size}" alt="" />`;

const avatar = (name, country) => `<span class="icon-btn"><span class="initials">${esc(initials(name))}</span>${flagBadge(country)}</span>`;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const seenApprovals = new Set(); // only cards that appear after page load slide in
let firstRender = true;
let prevBalances = null; // to flash a balance that changed

const APPROVAL_TTL_MS = 5 * 60 * 1000; // same as the server: requests expire after 5 minutes

/** "4:32 left" chip; a 1-second ticker keeps it current without re-rendering. */
const countdown = (createdAt) => `<span class="countdown" data-expires="${Date.parse(createdAt) + APPROVAL_TTL_MS}"></span>`;
function tickCountdowns() {
  document.querySelectorAll('[data-expires]').forEach((el) => {
    const s = Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left` : 'Expired';
    el.classList.toggle('soon', s <= 60);
  });
}
setInterval(tickCountdowns, 1000);

/** Wise's fraud check result: a calm line when low risk, the signals when not. */
const FRAUD_TEXT = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };
const fraudBox = (f) => !f ? '' : `
  <div class="fraud ${f.level}">
    <span class="fraud-dot"></span>
    <div><b>Fraud check: ${FRAUD_TEXT[f.level]}</b>${f.signals.length && f.level !== 'low' ? `<ul>${f.signals.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<small>Nothing unusual about this request.</small>'}</div>
  </div>`;

let lastDrafts = [];
let lastBatches = [];

function renderApprovals(drafts, batches = []) {
  lastDrafts = drafts;
  lastBatches = batches;
  const single = drafts.filter((d) => d.status === 'awaiting_user' && !d.batchId);
  const openBatches = batches.filter((b) => b.status === 'awaiting_user');
  const count = single.length + openBatches.length;
  $('pending-count').innerHTML = count ? `<span class="eyebrow">${count} waiting</span>` : '';
  $('nav-count').textContent = count || '';
  const isNew = (id) => !firstRender && !seenApprovals.has(id);
  $('approvals-wrap').innerHTML = count
    ? openBatches.map((b) => batchCard(b, isNew(b.id))).join('') + single.map((d) => approvalCard(d, isNew(d.id))).join('')
    : `<div class="empty"><span class="icon-btn ok glyph">✓</span>Nothing needs your approval. Payments Claude prepares that break a rule will appear here.</div>`;
  if (!firstRender) {
    single.filter((d) => !seenApprovals.has(d.id)).reverse().forEach(notifyApproval);
    openBatches.filter((b) => !seenApprovals.has(b.id)).forEach(notifyBatch);
  }
  pruneToasts([...single, ...openBatches]);
  [...single, ...openBatches].forEach((x) => seenApprovals.add(x.id));
  firstRender = false;
}

// ---------------------------------------------------------------------------
// Batch approval: see where each payment goes, untick any, pay the rest with one tap
// ---------------------------------------------------------------------------

const unticked = new Map();
const riskyFraud = (d) => d.fraud && d.fraud.level === 'high'; // batchId -> Set of draft ids the user unticked (survives re-renders)
const riskyByDefault = (d) => d.rule.startsWith('hard_stop') || d.warnings.length > 0 || riskyFraud(d);

function batchSelection(b) {
  if (!unticked.has(b.id)) {
    unticked.set(b.id, new Set(b.draftIds.map((id) => lastDrafts.find((d) => d.id === id)).filter((d) => d && riskyByDefault(d)).map((d) => d.id)));
  }
  const items = b.draftIds.map((id) => lastDrafts.find((d) => d.id === id)).filter(Boolean);
  const waiting = items.filter((d) => d.status === 'awaiting_user');
  const chosen = waiting.filter((d) => !unticked.get(b.id).has(d.id));
  return { items, waiting, chosen };
}

const totalLine = (ds) => {
  const byCcy = {};
  for (const d of ds) byCcy[d.currency] = (byCcy[d.currency] || 0) + d.amount;
  return Object.entries(byCcy).map(([c, a]) => fmt(Math.round(a * 100) / 100, c)).join(' + ') || '–';
};

function batchCard(b, isNew) {
  const { items, waiting, chosen } = batchSelection(b);
  const off = unticked.get(b.id);
  const invoiceRef = (d) => d.invoiceId ? ' · invoice' : '';
  const row = (d) => {
    const blocked = d.status !== 'awaiting_user';
    const r = { name: d.recipientName, country: d.iban ? d.iban.slice(0, 2) : '' };
    return `
      <label class="brow ${blocked ? 'blocked' : ''} ${riskyByDefault(d) ? 'risky' : ''}">
        <input type="checkbox" data-batch="${esc(b.id)}" value="${esc(d.id)}" ${blocked ? 'disabled' : off.has(d.id) ? '' : 'checked'} />
        ${personIcon(r)}
        <span class="brow-main">
          <span class="brow-line"><b>${esc(d.recipientName)}</b><b class="brow-amt">${fmt(d.amount, d.currency)}</b></span>
          <small>${d.ibanMasked ? 'To ' + esc(d.ibanMasked) : 'New recipient'}${invoiceRef(d)}${d.note ? ' · “' + esc(d.note.slice(0, 40)) + (d.note.length > 40 ? '…' : '') + '”' : ''}</small>
          <small class="brow-why">${blocked ? 'Blocked: ' : ''}${esc(d.reason)}</small>
          ${d.warnings.map((w) => `<small class="brow-warn">⚠ ${esc(w)}</small>`).join('')}
          ${d.fraud && d.fraud.level !== 'low' ? `<small class="brow-fraud ${d.fraud.level}">Fraud check: ${d.fraud.level} risk · ${esc(d.fraud.signals.join(' · '))}</small>` : ''}
        </span>
      </label>`;
  };
  return `
    <div class="approval batch ${isNew ? 'new' : ''}" data-batch-card="${esc(b.id)}">
      <div class="approval-top"><span class="with-icon">${claudeIcon()}Batch from Claude · ${waiting.length} payment${waiting.length === 1 ? '' : 's'}</span>${countdown(b.createdAt)}</div>
      <div class="approval-body">
        <div class="batch-title"><b>${esc(b.title)}</b><small>Check where each payment goes. Untick anything you don't want to pay.</small></div>
        <div class="brows">${items.map(row).join('')}</div>
        <div class="batch-total"><span>Total for <b data-batch-count>${chosen.length}</b> selected</span><b data-batch-total>${totalLine(chosen)}</b></div>
        <div class="btn-row">
          <button class="btn btn-secondary" data-act="batchdecline" data-id="${esc(b.id)}">Decline all</button>
          <button class="btn btn-primary" data-act="batchpay" data-id="${esc(b.id)}" ${chosen.length ? '' : 'disabled'}>Pay ${chosen.length} with one tap</button>
        </div>
      </div>
    </div>`;
}

// Ticking/unticking updates the total and the button without re-rendering the card.
document.addEventListener('change', (e) => {
  const box = e.target.closest('input[data-batch]');
  if (!box) return;
  const id = box.dataset.batch;
  const set = unticked.get(id);
  box.checked ? set.delete(box.value) : set.add(box.value);
  const b = lastBatches.find((x) => x.id === id);
  const { chosen } = batchSelection(b);
  const card = document.querySelector(`[data-batch-card="${id}"]`);
  card.querySelector('[data-batch-count]').textContent = chosen.length;
  card.querySelector('[data-batch-total]').textContent = totalLine(chosen);
  const btn = card.querySelector('[data-act="batchpay"]');
  btn.textContent = `Pay ${chosen.length} with one tap`;
  btn.disabled = !chosen.length;
});

function approvalCard(d, isNew) {
  const draftOnly = d.rule === 'pass.draft'; // within the rules; waiting only because the pass is Draft
  const eur = d.amountEUR != null && d.currency !== 'EUR' ? `<span class="eur">≈ ${fmt(d.amountEUR, 'EUR')}</span>` : '';
  return `
    <div class="approval ${isNew ? 'new' : ''}">
      <div class="approval-top"><span class="with-icon">${claudeIcon()}${draftOnly ? 'Ready for you to send' : 'Claude is asking'}</span>${countdown(d.createdAt)}</div>
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
        ${fraudBox(d.fraud)}
        <div class="btn-row">
          <button class="btn btn-secondary" data-act="decline" data-id="${esc(d.id)}">Decline</button>
          <button class="btn btn-primary" data-act="approve" data-id="${esc(d.id)}">${draftOnly ? 'Send' : 'Approve and send'}</button>
        </div>
      </div>
    </div>`;
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
  add: { name: 'Add', help: 'Claude can add new recipients. Payments to them always ask you first.' },
  off: { name: 'Off' },
  on: { name: 'One tap' },
};
const TRANSFER_HELP = {
  none: "Claude can't see your transfers.",
  view: "Claude can see your transfers, but can't prepare or send money.",
  draft: LEVELS.draft.help,
  act: LEVELS.act.help,
};

let lastPass = null; // the consent screen opens with the current settings

// What each Transfers level means in a few words, for the home card.
const LEVEL_SHORT = {
  none: "Can't see transfers",
  view: 'Can look, not pay',
  draft: 'Prepares, you send',
  act: 'Pays within your limits',
};

/**
 * Home "Claude · Agent Pass" card: status and time left, what waits for you, how much of the
 * limits is used, what Claude may do, and Claude's last action.
 */
function renderPassCard(p, drafts, batches, activity, off, offWord) {
  const t = p.permissions.transfers;
  const status = !p.connected ? ['idle', 'Not connected'] : off ? ['off', offWord] : ['on', 'Active'];
  $('pass-status').className = `pass-status ${status[0]}`;
  $('pass-status').innerHTML = `<i></i>${status[1]}`;

  if (!p.connected || off) {
    $('pass-card').innerHTML = `
      <div class="pc-off">
        <b>${!p.connected ? 'Claude is not connected' : p.revoked ? 'Access revoked' : 'Access expired'}</b>
        <p>Claude can't see your account or move money.</p>
        ${p.connected ? `<button class="btn btn-primary pc-btn" data-act="restore">${p.revoked ? 'Restore' : 'Renew'} access</button>` : ''}
      </div>`;
    return;
  }

  const singles = drafts.filter((d) => d.status === 'awaiting_user' && !d.batchId);
  const openBatches = batches.filter((b) => b.status === 'awaiting_user');
  const waitCount = singles.length + openBatches.length;
  const waitLine = [...openBatches.map((b) => esc(b.title)), ...singles.map((d) => `${esc(d.recipientName)} ${fmt(d.amount, d.currency)}`)].slice(0, 2).join(' · ');

  const monthPct = Math.min(100, (p.spentThisMonthEUR / p.monthlyLimitEUR) * 100);
  const dots = Array.from({ length: Math.min(p.dailyCountLimit, 10) }, (_, i) => `<span class="${i < p.sentTodayCount ? 'on' : ''}"></span>`).join('');
  const canPay = t === 'act' || t === 'draft';

  // What Claude may do, as chips; switched-off ones are shown struck through.
  const caps = [
    ['Balances', p.permissions.balances !== 'none'],
    [p.permissions.recipients === 'add' ? 'Recipients + add' : 'Recipients', p.permissions.recipients !== 'none'],
    ['Email invoices', p.permissions.invoices === 'view'],
    ['Batches', p.permissions.batches === 'on' && canPay],
    [p.allowedCurrencies.join(' · ') || 'No currencies', canPay && p.allowedCurrencies.length > 0],
  ];

  const last = activity.find((a) => ['paid', 'prepared', 'recipient', 'declined', 'expired'].includes(a.kind));
  const lastLine = last ? `${esc(last.text.split('. ')[0].replace(/\.$/, ''))} · ${timeAgo(last.ts)}` : 'Nothing yet. Ask Claude to pay a bill.';

  $('pass-card').innerHTML = `
    <div class="pc-head" data-act="consent" role="button" tabindex="0">
      <div><span class="pc-label">Transfers</span><b class="pc-level">${LEVELS[t].name}</b><span class="pc-sub">${LEVEL_SHORT[t]}</span></div>
      <div class="pc-time"><span class="pc-label">Access ends</span><b>${p.expiresAt ? timeLeft(p.expiresAt).replace(/^in /, '') : '–'}</b><span class="pc-sub">left</span></div>
    </div>

    <div class="pc-tiles">
      <a class="pc-tile wait ${waitCount ? 'has' : ''}" href="#sec-approvals">
        <span class="pc-label">Waiting for you</span>
        <b>${waitCount}</b>
        <small>${waitCount ? waitLine : 'All clear'}</small>
      </a>
      <div class="pc-tile">
        <span class="pc-label">This month</span>
        <b>${fmt(p.spentThisMonthEUR, 'EUR')}<em> / ${fmt(p.monthlyLimitEUR, 'EUR')}</em></b>
        <div class="bar"><div style="width:${monthPct}%"></div></div>
      </div>
      <div class="pc-tile">
        <span class="pc-label">Today</span>
        <b>${p.sentTodayCount}<em> / ${p.dailyCountLimit} payments</em></b>
        <div class="pc-dots">${dots}</div>
      </div>
    </div>

    <div class="pc-caps">
      <span class="pc-cap limit">Up to ${fmt(p.perPaymentLimitEUR, 'EUR')} each</span>
      ${caps.map(([label, on]) => `<span class="pc-cap ${on ? '' : 'no'}">${on ? '✓' : '✕'} ${esc(label)}</span>`).join('')}
    </div>

    <div class="pc-foot">
      <span class="pc-last">${claudeIcon(18)}<span>${lastLine}</span></span>
      <span class="pc-actions">
        <button class="pill pill-light pc-small" data-act="consent">Permissions</button>
        <button class="pill pc-small pc-revoke" data-act="revoke">Revoke</button>
      </span>
    </div>`;
}

/** "in 29 days", "in 3 hours", "in 12 min". */
const timeLeft = (iso) => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  if (m >= 2880) return `in ${Math.round(m / 1440)} days`;
  if (m >= 120) return `in ${Math.round(m / 60)} hours`;
  return `in ${m} min`;
};

function renderPass(p, recipients, drafts = [], batches = [], activity = []) {
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

  renderPassCard(p, drafts, batches, activity, off, offWord);

  // "Claude's access" panel
  const level = (v) => `<span class="level ${v === 'none' || v === 'off' || off ? 'off' : ''}">${off ? 'None' : LEVELS[v].name}</span>`;
  const left = Math.max(0, p.monthlyLimitEUR - p.spentThisMonthEUR);
  const monthPct = Math.min(100, (p.spentThisMonthEUR / p.monthlyLimitEUR) * 100);
  const recipientMode = (r) => t !== 'act' ? '' : p.autoPay[r.id] === false
    ? '<span class="mode ask">Asks</span>' : '<span class="mode auto">Auto</span>';
  $('pass').innerHTML = `
    <div class="perm-rows">
      <div class="perm-row"><span>Balances</span>${level(p.permissions.balances)}</div>
      <div class="perm-row"><span>Recipients</span>${level(p.permissions.recipients)}</div>
      <div class="perm-row"><span>Exchange rates</span>${level(p.permissions.rates)}</div>
      <div class="perm-row"><span>Email invoices</span>${level(p.permissions.invoices)}</div>
      <div class="perm-row"><span>Transfers<small>${esc(off ? "Claude can't see or do anything." : TRANSFER_HELP[t])}</small></span>${level(t)}</div>
      <div class="perm-row"><span>Batch payments</span>${level(p.permissions.batches)}</div>
      <div class="perm-row"><span>Access lasts</span><span class="level ${p.expired ? 'off' : ''}">${p.expired ? 'Expired' : p.expiresAt ? 'Ends ' + timeLeft(p.expiresAt) : '–'}</span></div>
    </div>
    <div class="limits">
      <div class="limit"><small>Per payment</small><b>${fmt(p.perPaymentLimitEUR, 'EUR')}</b></div>
      <div class="limit"><small>Per month</small><b>${fmt(p.monthlyLimitEUR, 'EUR')}</b></div>
      <div class="limit"><small>Per day</small><b>${p.dailyCountLimit} payment${p.dailyCountLimit === 1 ? '' : 's'}</b></div>
      <div class="limit"><small>Sent today</small><b>${p.sentTodayCount}</b></div>
    </div>
    <div class="spend">
      <div class="bar-label"><span>${fmt(p.spentThisMonthEUR, 'EUR')} sent this month</span><span>${fmt(left, 'EUR')} left</span></div>
      <div class="bar"><div style="width:${monthPct}%"></div></div>
    </div>
    <div class="group-title">Saved recipients</div>
    <div class="rlist">${[...recipients].sort((a, b) => (b.uses || 0) - (a.uses || 0)).map((r) => `
      <div class="rrow">${personIcon(r)}<b>${esc(r.name)}</b>${r.addedBy === 'claude' ? '<em class="tag">Added by Claude</em>' : ''}<small>${esc(r.iban)} · ${esc(r.currency)}</small>${recipientMode(r)}</div>`).join('')}</div>
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
const PERM_OPTIONS = {
  balances: ['none', 'view'], recipients: ['none', 'view', 'add'], rates: ['none', 'view'], invoices: ['none', 'view'],
  transfers: ['none', 'view', 'draft', 'act'], batches: ['off', 'on'],
};
const NEW_LEVELS = new Set(['draft', 'act', 'add', 'on']); // the levels this project adds to Wise's None / View
const PAY_LEVELS = new Set(['draft', 'act']);
const EXPIRY = { '1h': '1 hour', '1d': '1 day', '1w': '1 week', '30d': '30 days' }; // 30 days is the maximum
const ALL_CURRENCIES = ['EUR', 'GBP', 'JPY'];
let lastRecipients = [];

// One-tap starting points. Each sets the whole form; the user can still adjust anything.
const PRESETS = {
  look: { permissions: { balances: 'view', recipients: 'view', rates: 'view', invoices: 'none', transfers: 'view', batches: 'off' }, expiry: '1d' },
  draft: { permissions: { balances: 'view', recipients: 'view', rates: 'view', invoices: 'view', transfers: 'draft', batches: 'off' }, expiry: '1w', perPaymentLimitEUR: 200, monthlyLimitEUR: 500 },
  bills: {
    permissions: { balances: 'view', recipients: 'add', rates: 'view', invoices: 'view', transfers: 'act', batches: 'on' }, expiry: '30d',
    perPaymentLimitEUR: 200, monthlyLimitEUR: 500, dailyCountLimit: 3, allowedCurrencies: ['EUR'],
    autoPay: { elisa: true, tallinnpower: true, jana: false, hikari: false, marko: false, sofia: false, lumi: false },
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
  renderRecipientList(p.autoPay);
}

/** Compact one-line rows: "Frequently used" first, then everyone else. Search hides rows, so switches keep their state. */
function renderRecipientList(autoPay) {
  const byUse = [...lastRecipients].sort((a, b) => (b.uses || 0) - (a.uses || 0));
  const frequent = byUse.filter((r) => (r.uses || 0) >= 5).slice(0, 3);
  const rest = byUse.filter((r) => !frequent.includes(r)).sort((a, b) => a.name.localeCompare(b.name));
  const row = (r) => `
    <label class="rrow" data-search="${esc((r.name + ' ' + r.note + ' ' + r.iban).toLowerCase())}">
      ${personIcon(r)}
      <b>${esc(r.name)}</b>${r.addedBy === 'claude' ? '<em class="tag">Added by Claude</em>' : ''}
      <small>${esc(r.iban)} · ${esc(r.currency)}</small>
      <input type="checkbox" class="switch" name="autopay" value="${esc(r.id)}" ${autoPay[r.id] !== false ? 'checked' : ''} aria-label="Claude pays ${esc(r.name)} on its own" />
    </label>`;
  $('consent-recipients').innerHTML =
    (frequent.length ? `<div class="rgroup"><span>Frequently used</span>${frequent.map(row).join('')}</div>` : '') +
    `<div class="rgroup"><span>${frequent.length ? 'Everyone else' : 'Recipients'}</span>${rest.map(row).join('')}</div>` +
    '<p class="rempty" hidden>No recipients match. Use “Add new” to add one.</p>';
  filterRecipients();
}

function filterRecipients() {
  const q = $('recipient-search').value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#consent-recipients .rrow').forEach((el) => {
    el.hidden = !!q && !el.dataset.search.includes(q);
    if (!el.hidden) shown++;
  });
  document.querySelectorAll('#consent-recipients .rgroup').forEach((g) => (g.hidden = !g.querySelector('.rrow:not([hidden])')));
  document.querySelector('#consent-recipients .rempty').hidden = shown > 0;
}
$('recipient-search').addEventListener('input', filterRecipients);

// "Add new" recipient, from inside the permissions screen. Saved right away; Claude always asks before paying them.
$('add-recipient-btn').addEventListener('click', () => { $('add-form').hidden = !$('add-form').hidden; form.newName.focus(); });
$('add-save').addEventListener('click', async () => {
  const body = { name: form.newName.value, iban: form.newIban.value, currency: form.newCurrency.value };
  const res = await fetch('/api/recipients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('add-error').textContent = data.error || 'Something went wrong.'; return; }
  $('add-error').textContent = '';
  form.newName.value = form.newIban.value = '';
  $('add-form').hidden = true;
  const keep = readConsent().autoPay;
  lastRecipients = data.recipients;
  renderRecipientList({ ...data.pass.autoPay, ...keep });
  syncConsent();
});

let consentMode = 'pass'; // 'connect' when fine-tuning from the connect screen (saves locally, not to the server)

function openConsent(mode = 'pass', from = lastPass) {
  if (!lastPass) return;
  consentMode = mode === 'connect' ? 'connect' : 'pass';
  fillConsent(from);
  $('consent-error').textContent = '';
  syncConsent();
  consent.showModal();
}

/** Read the form into the body that POST /api/pass expects. */
function readConsent() {
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]`)];
  return {
    permissions: Object.fromEntries(Object.keys(PERM_OPTIONS).map((k) => [k, form[k].value])),
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
  $('perm-limits').hidden = !PAY_LEVELS.has(t);
  form.querySelectorAll('.act-only').forEach((el) => (el.hidden = t !== 'act'));
  $('invoices-help').textContent = b.permissions.invoices === 'view'
    ? 'Claude can read invoices in your email and prepare payments for them.' : "Claude can't read your email.";
  const preset = matchingPreset(b);
  document.querySelectorAll('.preset').forEach((el) => el.classList.toggle('on', el.dataset.preset === preset));

  $('consent-summary').innerHTML = summaryHtml(b);
}

/** Plain-English "Claude can / asks you first / can never" for a pass body. */
function summaryHtml(b) {
  const t = b.permissions.transfers;
  const sees = ['balances', 'recipients', 'rates'].filter((k) => b.permissions[k] !== 'none')
    .map((k) => ({ balances: 'balances', recipients: 'recipients', rates: 'exchange rates' }[k]));
  const names = Object.fromEntries(lastRecipients.map((r) => [r.id, r.name]));
  const auto = Object.entries(b.autoPay).filter(([, on]) => on).map(([id]) => names[id]);
  const ask = Object.entries(b.autoPay).filter(([, on]) => !on).map(([id]) => names[id]);
  const ccy = b.allowedCurrencies.length ? b.allowedCurrencies.join(', ') : 'no currencies';
  const can = [], asks = [], cannot = [];
  if (sees.length) can.push(`See your ${list(sees)}`);
  if (b.permissions.invoices === 'view') can.push('Read invoices in your email');
  if (b.permissions.recipients === 'add') can.push('Add new recipients (payments to them always ask you)');
  if (b.permissions.batches === 'on' && PAY_LEVELS.has(t)) asks.push('Batches of payments: you check each one, then pay all with one tap');
  if (t === 'view' || t === 'none') cannot.push('Prepare or send any money');
  if (t === 'draft') { can.push(`Prepare payments in ${ccy}`); asks.push('Every payment: you send it with one tap'); }
  if (t === 'act') {
    if (auto.length) can.push(`Pay ${list(auto)} up to ${fmt(b.perPaymentLimitEUR, 'EUR')} each, in ${ccy}`);
    if (ask.length) asks.push(`Any payment to ${list(ask)}`);
    asks.push(`Over ${fmt(b.perPaymentLimitEUR, 'EUR')}, over ${fmt(b.monthlyLimitEUR, 'EUR')} a month, or more than ${b.dailyCountLimit} a day`);
  }
  if (t === 'draft' || t === 'act') asks.push('New recipients or changed bank details');
  cannot.push(b.permissions.recipients === 'add' ? 'Change saved bank details or these settings' : 'Add recipients or change these settings');
  cannot.push('Approve a payment: that always takes your fingerprint, Wise app or SMS code');
  const line = (cls, title, items) => items.length ? `<div class="sum ${cls}"><b>${title}</b><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '';
  return line('can', 'Claude can', can) + line('ask', 'Claude asks you first', asks) + line('cannot', 'Claude can never', cannot) +
    `<div class="sum-foot">Access ends in ${EXPIRY[b.expiry]} (30 days at most). You can revoke it any time.</div>`;
}
const list = (xs) => {
  if (xs.length > 3) xs = [...xs.slice(0, 2), `${xs.length - 2} others`];
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

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
  if (PAY_LEVELS.has(body.permissions.transfers) && !body.allowedCurrencies.length) {
    $('consent-error').textContent = 'Pick at least one currency, or set Transfers to View.';
    return;
  }
  if (consentMode === 'connect') {
    connectBody = body;
    consent.close();
    renderConnect(lastPass);
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
    <div class="toast-top"><span class="with-icon">${claudeIcon()}${draftOnly ? 'Ready for you to send' : 'Claude is asking'}</span><span class="toast-right">${countdown(d.createdAt)}<button class="toast-x" aria-label="Dismiss">✕</button></span></div>
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

/** A batch arrived: pop up a summary that takes you to the batch card. */
function notifyBatch(b) {
  const { waiting } = batchSelection(b);
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.id = b.id;
  el.innerHTML = `
    <div class="toast-top"><span class="with-icon">${claudeIcon()}Batch from Claude</span><span class="toast-right">${countdown(b.createdAt)}<button class="toast-x" aria-label="Dismiss">✕</button></span></div>
    <div class="toast-body">
      <span class="icon-btn glyph">${waiting.length}</span>
      <div class="meta"><b>${esc(b.title)} · ${totalLine(waiting)}</b><small>${esc(list(waiting.map((d) => d.recipientName)))}. Check each one, then pay all with one tap.</small></div>
    </div>
    <div class="btn-row"><a class="btn btn-primary" href="#sec-approvals">Review batch</a></div>`;
  el.querySelector('.toast-x').addEventListener('click', () => el.remove());
  el.querySelector('a').addEventListener('click', () => el.remove());
  toasts.prepend(el);
  if (notifyOk() && document.hidden) new Notification('Claude sent a batch of payments', { body: `${b.title}: ${totalLine(waiting)}`, tag: b.id });
}

// ---------------------------------------------------------------------------
// Identity check (mock): fingerprint, Wise app approval, or SMS code
// ---------------------------------------------------------------------------

const verifyDlg = $('verify');
let verifyDone = null;

/** Ask the user to confirm with their ID. Resolves true after "Continue", false if cancelled. */
function verify(what, drafts) {
  $('verify-what').textContent = what;
  $('verify-list').innerHTML = drafts.map((d) => `
    <div class="vrow">${personIcon({ name: d.recipientName, country: d.iban ? d.iban.slice(0, 2) : '' })}
      <span><b>${esc(d.recipientName)}</b><small>${esc(d.ibanMasked || 'New recipient')}</small></span>
      <b>${fmt(d.amount, d.currency)}</b></div>`).join('');
  setMethod('finger');
  verifyDlg.showModal();
  return new Promise((resolve) => { verifyDone = resolve; });
}

let appTimer = null;
let smsCode = '';
const METHODS = ['finger', 'app', 'sms'];

function setMethod(m) {
  clearTimeout(appTimer);
  verifyDlg.dataset.method = m;
  document.querySelectorAll('.vtab').forEach((t) => t.classList.toggle('on', t.dataset.method === m));
  for (const x of METHODS) $(`pane-${x}`).hidden = x !== m;
  $('verified').hidden = true;
  $('verify-tabs').hidden = false;
  $('verify-go').disabled = true;
  $('finger').classList.remove('scanning', 'ok');
  $('finger-hint').textContent = 'Touch the sensor to confirm';
  if (m === 'app') {
    $('app-hint').textContent = 'We sent a request to the Wise app on your phone. Tap Approve there.';
    appTimer = setTimeout(() => verified('Wise app'), 2800); // mock: the phone approves by itself
  }
  if (m === 'sms') {
    smsCode = String(100000 + Math.floor(Math.random() * 900000));
    $('sms-input').value = '';
    $('sms-demo').textContent = smsCode;
    $('sms-error').textContent = '';
    setTimeout(() => $('sms-input').focus(), 50);
  }
}

$('sms-input').addEventListener('input', () => {
  const v = $('sms-input').value.replace(/\D/g, '').slice(0, 6);
  $('sms-input').value = v;
  if (v.length < 6) { $('sms-error').textContent = ''; return; }
  if (v === smsCode) verified('SMS code');
  else $('sms-error').textContent = "That code doesn't match. Try again.";
});
document.querySelectorAll('.vtab').forEach((t) => t.addEventListener('click', () => setMethod(t.dataset.method)));

function verified(how) {
  clearTimeout(appTimer);
  $('finger').classList.add('ok');
  for (const x of METHODS) $(`pane-${x}`).hidden = true;
  $('verify-tabs').hidden = true;
  $('verified').hidden = false;
  $('verified-how').textContent = `${how} · just now`;
  $('verify-go').disabled = false;
  $('verify-go').focus();
}

$('finger').addEventListener('click', () => {
  if ($('finger').classList.contains('scanning')) return;
  $('finger').classList.add('scanning');
  $('finger-hint').textContent = 'Scanning…';
  setTimeout(() => verified('Fingerprint'), 1100);
});
const finishVerify = (ok) => {
  clearTimeout(appTimer);
  if (verifyDlg.open) verifyDlg.close();
  verifyDone?.(ok);
  verifyDone = null;
};
$('verify-go').addEventListener('click', () => finishVerify(true));
verifyDlg.addEventListener('click', (e) => { if (e.target.closest('[data-vclose]') || e.target === verifyDlg) finishVerify(false); });
verifyDlg.addEventListener('cancel', () => finishVerify(false));

/** Remove pop-ups for drafts that are no longer waiting (approved, declined, or reset). */
function pruneToasts(pending) {
  const ids = new Set(pending.map((d) => d.id));
  toasts.querySelectorAll('.toast').forEach((el) => { if (!ids.has(el.dataset.id)) el.remove(); });
  if (!pending.length) document.title = 'Wise · Agent Pass';
}

// ---------------------------------------------------------------------------
// First-time connect screen
// ---------------------------------------------------------------------------

let connectTab = 'readonly';
let connectBody = null; // the Custom choice; starts as the "Pay my bills" preset

const presetBody = (name) => {
  const pr = PRESETS[name];
  return { ...readPassBody(lastPass), ...pr, permissions: { ...lastPass.permissions, ...pr.permissions }, autoPay: { ...lastPass.autoPay, ...(pr.autoPay || {}) } };
};
/** The pass fields that POST /api/pass and /api/connect take. */
const readPassBody = (p) => ({
  permissions: p.permissions, perPaymentLimitEUR: p.perPaymentLimitEUR, monthlyLimitEUR: p.monthlyLimitEUR,
  dailyCountLimit: p.dailyCountLimit, allowedCurrencies: p.allowedCurrencies, autoPay: p.autoPay, expiry: p.expiry,
});

const LEGAL = {
  readonly: `<p>By connecting, you let Claude read information from the Wise account you select, such as balances, transactions and recipients, within the permissions above.</p>
    <p>This connection is read-only. Claude can't make payments or change your Wise account through it.</p>`,
  custom: `<p>By connecting, you let Claude read and act on the Wise account you select, within the Agent Pass above.</p>
    <p>Every payment Claude prepares is checked by Wise against your rules. Anything outside them waits for your approval in the Wise app. You can change or revoke access at any time.</p>`,
};

function renderConnect(p) {
  const show = !p.connected;
  $('connect-screen').hidden = !show;
  document.body.classList.toggle('connecting', show);
  if (!show) { connectBody = null; return; }
  if (!connectBody) connectBody = presetBody('bills');
  $('connect-waiting').hidden = !p.connectRequestedAt;
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === connectTab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on);
  });
  $('panel-readonly').hidden = connectTab !== 'readonly';
  $('panel-custom').hidden = connectTab !== 'custom';
  $('connect-summary').innerHTML = summaryHtml(connectBody);
  const preset = matchingPreset(connectBody);
  document.querySelectorAll('[data-cpreset]').forEach((el) => el.classList.toggle('on', el.dataset.cpreset === preset));
  $('connect-legal').innerHTML = LEGAL[connectTab];
  $('connect-btn').disabled = !$('connect-account').checked;
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { connectTab = t.dataset.tab; renderConnect(lastPass); }));
$('connect-presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cpreset]');
  if (!b) return;
  connectBody = presetBody(b.dataset.cpreset);
  renderConnect(lastPass);
});
$('connect-finetune').addEventListener('click', () => openConsent('connect', { ...lastPass, ...connectBody }));
$('connect-account').addEventListener('change', () => renderConnect(lastPass));
$('connect-btn').addEventListener('click', async () => {
  const body = connectTab === 'custom' ? { mode: 'custom', ...connectBody } : { mode: 'readonly' };
  const res = await fetch('/api/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  $('connect-error').textContent = res.ok ? '' : (await res.json().catch(() => ({}))).error || 'Something went wrong.';
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
    case 'restored': return { icon: '↺', cls: 'glyph', label: a.rule === 'pass.connected' ? 'Connected' : 'Access restored' };
    case 'recipient': return { icon: '+', cls: 'glyph', label: 'New recipient' };
    case 'expired': return { icon: '⏱', cls: 'glyph', label: 'Expired · nothing sent', muted: true };
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
        const title = d ? d.recipientName : a.batchId ? 'Batch of payments' : 'Claude';
        const amount = d ? `<span class="amount ${look.muted ? 'muted' : ''}">${num(d.amount, d.currency)} ${esc(d.currency)}</span>` : '';
        const byClaude = title === 'Claude' || (a.kind === 'prepared' && look.label === 'Prepared by Claude') || (a.kind === 'paid' && !a.byUser);
        return `<div class="tx" title="${esc(a.text)}">
          <span class="icon-btn ${look.cls}">${look.icon}${byClaude ? `<span class="by-claude">${claudeIcon(18)}</span>` : ''}</span>
          <div class="meta">
            <div class="head"><b>${esc(title)}</b>${amount}</div>
            <small>${esc(look.label)} · ${timeAgo(a.ts)}</small>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty"><span class="icon-btn glyph">·</span>No activity yet. Ask Claude to pay someone.</div>`;
}

function render(s) {
  const first = !lastPass;
  renderApprovals(s.drafts, s.batches);
  tickCountdowns();
  renderBalances(s.balances);
  renderPass(s.pass, s.recipients, s.drafts, s.batches, s.activity);
  renderConnect(s.pass);
  renderActivity(s.activity, s.drafts);
  if (first && location.hash === '#consent') openConsent(); // direct link to the consent screen
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let lastKey = '';

const API_VERSION = 6; // must match STATE_VERSION in src/state.js

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

async function post(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!res.ok) console.warn((await res.json().catch(() => ({}))).error || res.statusText);
  } finally {
    lastKey = '';
    poll();
  }
}

const ACTIONS = {
  // Approving always takes an ID check first (mock fingerprint, Wise app or SMS code).
  approve: async (id) => {
    const d = lastDrafts.find((x) => x.id === id);
    if (!d || !(await verify(`Send ${fmt(d.amount, d.currency)} to ${d.recipientName}`, [d]))) return;
    post(`/api/drafts/${encodeURIComponent(id)}/approve`);
  },
  decline: (id) => post(`/api/drafts/${encodeURIComponent(id)}/decline`),
  batchpay: async (id) => {
    const b = lastBatches.find((x) => x.id === id);
    const { chosen } = batchSelection(b);
    if (!chosen.length || !(await verify(`Pay ${chosen.length} payment${chosen.length === 1 ? '' : 's'}: ${totalLine(chosen)}`, chosen))) return;
    post(`/api/batches/${encodeURIComponent(id)}/approve`, { draftIds: chosen.map((d) => d.id) });
  },
  batchdecline: (id) => post(`/api/batches/${encodeURIComponent(id)}/decline`),
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
