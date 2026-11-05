import { api, qs } from '../api.js';
import { drawPager, h, fill, debounce, fullName, timeAgo, fmtDateTime, toast, avatar } from '../util.js';
import { icon } from '../icons.js';
import { openLead } from './lead-drawer.js';

// Recycle bin (admin only). Deleted leads wait here until they are restored or deleted forever.
export async function render(root, ctx) {
  const state = { q: '', page: 1, limit: 50 };
  const selected = new Set();
  let data = { rows: [], total: 0 };

  const search = h('input', { type: 'search', placeholder: 'Search deleted leads…', oninput: debounce(() => { state.q = search.value; state.page = 1; load(); }) });
  const emptyBtn = h('button', { class: 'btn danger', onclick: async () => {
    const { ids } = await api('GET', '/api/leads/trash/ids');
    if (!ids.length) return;
    if (!confirm(`Delete all ${ids.length.toLocaleString()} lead(s) in the recycle bin forever?\n\nTheir activity history is deleted too. This cannot be undone.`)) return;
    await run(() => api('POST', '/api/leads/purge', { all: true }), (r) => `${r.purged.toLocaleString()} lead(s) deleted forever`);
    selected.clear();
  } }, icon('trash', 14), 'Empty recycle bin');

  const bulk = h('div', { class: 'bulkbar', style: 'display:none' });
  const tableWrap = h('div', { class: 'tablewrap' });
  const pager = h('div', { class: 'pager' });
  const count = h('span', { class: 'muted' });

  root.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Recycle bin'), h('div', { class: 'muted' }, 'Deleted leads stay here until you restore them or delete them forever.')),
      h('div', { class: 'spacer' }), emptyBtn),
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('div', { class: 'searchbox' }, icon('search', 15), search), h('div', { class: 'spacer' }), count),
      bulk, tableWrap, pager));

  async function run(fn, msg) {
    try { const r = await fn(); toast(msg(r)); } catch (e) { toast(e.message, true); }
    await load();
  }
  const restore = (ids) => run(() => api('POST', '/api/leads/restore', { ids }), (r) => `${r.restored.toLocaleString()} lead(s) restored`);
  const purge = async (ids, label) => {
    if (!confirm(`Delete ${label} forever? Their activity history is deleted too.\n\nThis cannot be undone.`)) return;
    await run(() => api('POST', '/api/leads/purge', { ids }), (r) => `${r.purged.toLocaleString()} lead(s) deleted forever`);
  };

  async function load() {
    data = await api('GET', '/api/leads/trash?' + qs(state));
    for (const id of [...selected]) if (!data.rows.some((r) => r.id === id) && data.total === 0) selected.delete(id);
    count.textContent = `${data.total.toLocaleString()} in bin`;
    emptyBtn.disabled = data.total === 0 && !state.q;
    drawTable(); drawPagerNow(); drawBulk();
  }

  function drawTable() {
    if (data.rows.length === 0) {
      fill(tableWrap, h('div', { class: 'empty' }, icon('trash', 28), h('div', { style: 'margin-top:8px' }, state.q ? 'No deleted leads match your search.' : 'The recycle bin is empty.')));
      return;
    }
    const allOn = data.rows.every((r) => selected.has(r.id));
    const master = h('input', { type: 'checkbox', checked: allOn, onchange: () => {
      data.rows.forEach((r) => (master.checked ? selected.add(r.id) : selected.delete(r.id)));
      drawTable(); drawBulk();
    } });
    fill(tableWrap, h('table', null,
      h('thead', null, h('tr', null, h('th', { style: 'width:32px' }, master), h('th', null, 'Lead'), h('th', null, 'Company'), h('th', null, 'Email'),
        h('th', null, 'Owner'), h('th', null, 'Deleted by'), h('th', null, 'Deleted'), h('th', null, 'History'), h('th', null, ''))),
      h('tbody', null, data.rows.map((l) => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(l.id), onchange: () => { cb.checked ? selected.add(l.id) : selected.delete(l.id); drawBulk(); } });
        const open = () => openLead(l.id, ctx, load);
        return h('tr', null,
          h('td', null, cb),
          h('td', null, h('div', { class: 'leadcell' }, avatar(fullName(l), 32), h('div', null, h('a', { class: 'nm', onclick: open }, fullName(l)), h('div', { class: 'sub' }, l.title)))),
          h('td', { class: 'company' }, h('div', { class: 'nm' }, l.company), h('div', { class: 'sub' }, l.industry)),
          h('td', null, l.email || h('span', { class: 'muted' }, '—')),
          h('td', null, l.owner_name || h('span', { class: 'muted' }, 'Unassigned')),
          h('td', null, l.deleted_by_name || h('span', { class: 'muted' }, '—')),
          h('td', { class: 'muted', title: fmtDateTime(l.deleted_at), style: 'white-space:nowrap' }, timeAgo(l.deleted_at)),
          h('td', { class: 'muted' }, `${l.activity_count} entries`),
          h('td', null, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { class: 'btn small', onclick: () => restore([l.id]) }, icon('restore', 13), 'Restore'),
            h('button', { class: 'btn small danger', title: 'Delete forever', onclick: () => purge([l.id], fullName(l)) }, icon('trash', 13), 'Delete forever'))));
      }))));
  }

  function drawPagerNow() {
    drawPager(pager, { page: state.page, limit: state.limit, total: data.total, onPage: (n) => { state.page = n; load(); } });
  }

  function drawBulk() {
    if (selected.size === 0) { bulk.style.display = 'none'; return; }
    bulk.style.display = '';
    const all = data.total > selected.size
      ? h('button', { class: 'btn small', onclick: async () => {
          const { ids } = await api('GET', '/api/leads/trash/ids');
          ids.forEach((i) => selected.add(i)); drawTable(); drawBulk();
        } }, `Select all ${data.total.toLocaleString()} in bin`) : null;
    fill(bulk, h('b', null, `${selected.size.toLocaleString()} selected`), all,
      h('button', { class: 'btn primary small', onclick: async () => { const ids = [...selected]; selected.clear(); await restore(ids); } }, icon('restore', 13), 'Restore'),
      h('button', { class: 'btn small danger', onclick: async () => { const ids = [...selected]; await purge(ids, `${ids.length.toLocaleString()} lead(s)`); selected.clear(); drawBulk(); } }, icon('trash', 13), 'Delete forever'),
      h('button', { class: 'btn small', onclick: () => { selected.clear(); drawTable(); drawBulk(); } }, 'Clear'));
  }

  await load();
}
