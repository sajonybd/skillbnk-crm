import { api, qs } from '../api.js';
import { h, fill, toast } from '../util.js';
import { icon } from '../icons.js';

// Reports built from the CRM: the daily plan, the end-of-day update and the weekly KPI report.
const TABS = [
  ['plan', 'Daily work plan', 'What the team will do on the chosen day'],
  ['eod', 'End-of-day update', 'What was done: prospects, comments and messages sent, research verdicts'],
  ['weekly', 'Weekly KPI', 'Target vs actual for the week, pipeline and lead quality'],
];
const state = { tab: 'eod', date: '', from: '', to: '', assignee: '' };

// Small, safe Markdown renderer: headings, lists, tables, quotes, bold.
function inline(text) {
  const out = [];
  String(text).split(/\*\*/).forEach((part, i) => { if (part) out.push(i % 2 ? h('b', null, part) : part); });
  return out;
}
function renderMd(md) {
  const doc = h('div', { class: 'rep-doc' });
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*\|/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      doc.append(h('div', { style: 'overflow-x:auto' }, h('table', null, h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c)))))))));
      continue;
    }
    const m = /^(#{1,3})\s+(.*)$/.exec(ln);
    if (m) doc.append(h('h' + m[1].length, null, inline(m[2])));
    else if (/^\s*---+\s*$/.test(ln)) doc.append(h('hr', { style: 'border:0;border-top:2px dashed #d6dcea;margin:26px 0' }));
    else if (/^>\s?/.test(ln)) doc.append(h('blockquote', null, inline(ln.replace(/^>\s?/, ''))));
    else if (/^\s*(-|\d+\.)\s+/.test(ln)) {
      const ordered = /^\s*\d+\./.test(ln);
      const items = [];
      while (i < lines.length && /^\s*(-|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*(-|\d+\.)\s+/, '')); i++; }
      doc.append(h(ordered ? 'ol' : 'ul', null, items.map((t) => h('li', null, inline(t)))));
      continue;
    } else if (ln.trim()) doc.append(h('p', null, inline(ln)));
    i++;
  }
  return doc;
}

export async function render(root, ctx) {
  const isAdmin = ctx.user.role === 'admin';
  const out = h('div');
  const bar = h('div', { class: 'rep-bar' });
  const tabs = h('div', { class: 'seg' });
  const chips = h('div', { class: 'chips', style: 'margin-bottom:12px' });
  let current = null;
  root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Reports'), h('div', { class: 'muted' }, 'Built from what is logged in the CRM. Copy it, download it, or submit it as is.')), h('div', { class: 'spacer' }), tabs), chips, bar, out);

  const input = (type, key, label) => {
    const el = h('input', { type, value: state[key] });
    el.addEventListener('change', () => { state[key] = el.value; load(); });
    return h('label', { class: 'row', style: 'gap:6px' }, h('span', { class: 'muted' }, label), el);
  };

  async function load() {
    tabs.replaceChildren(...TABS.map(([k, t]) => h('button', { class: 'segb' + (state.tab === k ? ' on' : ''), onclick: () => { state.tab = k; state.date = ''; state.from = ''; state.to = ''; load(); } }, t)));
    const who = state.assignee || (isAdmin ? 'all' : 'me');
    const mk = (v, t) => h('button', { class: 'chip noav' + (who === v ? ' on' : ''), onclick: () => { state.assignee = v; load(); } }, t);
    chips.replaceChildren(mk('me', 'Mine'), ...(isAdmin ? [mk('all', 'Whole team')] : []), ...ctx.users.filter((u) => u.active && u.id !== ctx.user.id && u.role !== 'admin').map((u) => mk(String(u.id), u.name)));
    let err = null;
    try {
      const p = { assignee: who };
      if (state.tab !== 'weekly' && state.date) p.date = state.date;
      if (state.tab === 'weekly') { if (state.from) p.from = state.from; if (state.to) p.to = state.to; }
      current = await api('GET', `/api/reports/${state.tab}?` + qs(p));
      if (!state.date && current.date) state.date = current.date;
      if (state.tab === 'weekly') { state.from = current.from; state.to = current.to; }
    } catch (e) { err = e; current = null; }
    fill(bar,
      state.tab === 'plan' ? input('date', 'date', 'Plan for') : null,
      state.tab === 'eod' ? input('date', 'date', 'Day') : null,
      state.tab === 'weekly' ? input('date', 'from', 'From') : null,
      state.tab === 'weekly' ? input('date', 'to', 'To') : null,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: async () => { if (current) { try { await navigator.clipboard.writeText(current.markdown); } catch { const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = current.markdown; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
        toast('Report copied. Paste it anywhere.'); } } }, icon('inbox', 15), 'Copy'),
      h('button', { class: 'btn', onclick: () => {
        if (!current) return;
        const a = h('a', { href: URL.createObjectURL(new Blob([current.markdown], { type: 'text/markdown' })), download: current.title.replace(/\s+/g, '-') + '.md' });
        document.body.append(a); a.click(); a.remove();
      } }, 'Download .md'),
      h('button', { class: 'btn primary', onclick: () => window.print() }, 'Print / PDF'));
    if (err) out.replaceChildren(h('div', { class: 'card empty' }, err.message));
    else out.replaceChildren(h('div', { class: 'muted', style: 'margin-bottom:8px' }, TABS.find((t) => t[0] === state.tab)[2]), renderMd(current.markdown));
  }
  await load();
}
