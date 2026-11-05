// Tiny DOM helper: h('div', {class:'x', onclick: fn}, 'text', childEl, [more])
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false || k === 'value') continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  if (attrs && 'value' in attrs && attrs.value != null) el.value = attrs.value; // after <option>s exist
  return el;
}

// Like el.replaceChildren(...) but skips null/false (native version prints "null").
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export function toast(msg, isErr = false) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), isErr ? 5000 : 2200);
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let TZ = 'Asia/Dhaka';
export const setTz = (tz) => { TZ = tz; };

export function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

export function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

export const fullName = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || '(no name)';

export function pill(text, prefix) {
  if (!text) return h('span', { class: 'muted' }, '—');
  return h('span', { class: `pill ${prefix}-${text}` }, text);
}

export function options(list, { blank, selected } = {}) {
  const out = [];
  if (blank != null) out.push(h('option', { value: '' }, blank));
  for (const item of list) {
    const [value, label] = Array.isArray(item) ? item : [item, item];
    out.push(h('option', { value }, label));
  }
  return out;
}

// ── people: colored initials + names ──
const PALETTE = ['#3b5bdb', '#0c8599', '#2f9e44', '#e8590c', '#ae3ec9', '#d6336c', '#5f3dc4', '#1971c2'];
const order = new Map();
// Gives each team member a distinct colour (by account order). Called whenever the user list loads.
export function registerPeople(users) {
  order.clear();
  [...users].sort((x, y) => x.id - y.id).forEach((u, i) => order.set(u.name, i));
}
export const colorFor = (name) => {
  if (order.has(name)) return PALETTE[order.get(name) % PALETTE.length];
  let hsh = 2166136261;
  for (const ch of String(name)) { hsh ^= ch.charCodeAt(0); hsh = Math.imul(hsh, 16777619); }
  return PALETTE[(hsh >>> 0) % PALETTE.length];
};
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export function avatar(name, size = 24) {
  return h('span', { class: 'avatar', title: name, style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${colorFor(name)}` }, initials(name));
}

// ── clipboard (works on https/localhost, with a fallback) ──
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = h('textarea', { style: 'position:fixed;opacity:0' });
    t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  toast('Copied ' + text);
}

export const asUrl = (u) => (!u ? '' : /^https?:\/\//i.test(u) ? u : 'https://' + u);

// '2026-11-12' -> 'Nov 12' (date-only strings have no timezone, so format in UTC).
export function shortDate(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Numbered pager: « ‹ 1 2 [3] 4 … 154 › » + "Go to page" box + "Showing 51–100 of 7,664".
// opts = { page, limit, total, onPage(n) }. Fills `el`.
export function drawPager(el, { page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const cur = Math.min(Math.max(page, 1), pages);
  const from = total === 0 ? 0 : (cur - 1) * limit + 1;
  const to = Math.min(cur * limit, total);
  const go = (n) => { n = Math.min(Math.max(Math.round(Number(n)) || 1, 1), pages); if (n !== cur) onPage(n); };
  const btn = (label, n, { on = false, off = false, title = '' } = {}) =>
    h('button', { class: 'pg' + (on ? ' on' : ''), disabled: off || on, title, onclick: () => go(n) }, label);

  // window of page numbers around the current one, with first/last and ellipses
  const nums = new Set([1, pages, cur - 2, cur - 1, cur, cur + 1, cur + 2]);
  const list = [...nums].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items = [];
  let prev = 0;
  for (const n of list) {
    if (n - prev > 1) items.push(h('span', { class: 'pg-gap' }, '…'));
    items.push(btn(n.toLocaleString(), n, { on: n === cur }));
    prev = n;
  }
  const jump = h('input', { class: 'pg-jump', type: 'number', min: 1, max: pages, placeholder: String(cur), title: 'Type a page number and press Enter' });
  jump.addEventListener('keydown', (e) => { if (e.key === 'Enter' && jump.value) go(jump.value); });
  const goBtn = h('button', { class: 'pg wide', onclick: () => jump.value && go(jump.value) }, 'Go');

  fill(el,
    h('span', { class: 'pg-info' }, total === 0 ? 'No results' : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`),
    h('div', { class: 'pg-nav' },
      btn('«', 1, { off: cur === 1, title: 'First page' }), btn('‹', cur - 1, { off: cur === 1, title: 'Previous page' }),
      items,
      btn('›', cur + 1, { off: cur === pages, title: 'Next page' }), btn('»', pages, { off: cur === pages, title: 'Last page' })),
    h('div', { class: 'pg-go' }, h('span', { class: 'muted' }, `Page ${cur.toLocaleString()} of ${pages.toLocaleString()} · go to`), jump, goBtn));
}

// Remembers a choice (selected team member, tab, sort…) per signed-in user, so a reload keeps it.
export const pref = {
  get(uid, key, def = '') { try { const v = localStorage.getItem(`sbk:${uid}:${key}`); return v == null ? def : v; } catch { return def; } },
  set(uid, key, val) { try { localStorage.setItem(`sbk:${uid}:${key}`, String(val ?? '')); } catch { /* private mode */ } },
};
