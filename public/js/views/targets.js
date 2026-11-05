import { api, qs } from '../api.js';
import { h, toast, avatar, todayStr } from '../util.js';
import { icon } from '../icons.js';

const state = { date: '' };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
const short = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short' });
const tone = (p) => (p == null ? '' : p >= 100 ? 'ok' : p >= 60 ? 'mid' : 'low');

export async function render(root, ctx) {
  state.date ||= todayStr();
  const isAdmin = ctx.user.role === 'admin';
  const body = h('div');
  const editor = h('div', { class: 'card', style: 'display:none;margin-bottom:16px;padding:18px' });
  const dateLabel = h('div', { class: 'datelabel' });
  const nav = h('div', { class: 'row' },
    h('button', { class: 'btn sq', onclick: () => { state.date = addDays(state.date, -1); load(); } }, icon('chevronLeft', 16)),
    dateLabel,
    h('button', { class: 'btn sq', onclick: () => { state.date = addDays(state.date, 1); load(); } }, icon('chevronRight', 16)),
    h('button', { class: 'btn', onclick: () => { state.date = todayStr(); load(); } }, 'Today'));
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Daily targets'), h('div', { class: 'muted' }, 'Counted automatically from logged LinkedIn activity. Friday is a day off.')),
      h('div', { class: 'spacer' }), nav,
      isAdmin ? h('button', { class: 'btn primary', onclick: toggleEditor }, icon('target', 15), 'Set targets') : null),
    editor, body);

  async function toggleEditor() {
    if (editor.style.display !== 'none') { editor.style.display = 'none'; return; }
    const e = await api('GET', '/api/targets/edit');
    const val = (u, m) => e.targets.find((t) => t.user_id === u && t.metric === m)?.daily_target || '';
    const metrics = Object.entries(e.metrics);
    editor.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h2', null, 'Daily targets per person'), h('div', { class: 'spacer' }),
        h('button', { class: 'btn', title: 'Reset everyone to the playbook numbers (Tawhid, Ahana)', onclick: async () => {
          if (!confirm('Replace the current numbers with the playbook defaults?')) return;
          try { const r = await api('POST', '/api/targets/auto'); toast(`${r.set} targets set`); editor.style.display = 'none'; load(); } catch (x) { toast(x.message, true); }
        } }, 'Auto-set from playbook')),
      h('table', { class: 'tgt-edit' },
        h('thead', null, h('tr', null, h('th', null, 'Person'), metrics.map(([, l]) => h('th', null, l)))),
        h('tbody', null, e.users.map((u) => h('tr', null, h('td', null, u.name), metrics.map(([m]) => {
          const inp = h('input', { type: 'number', min: 0, value: val(u.id, m), placeholder: '—' });
          inp.addEventListener('change', async () => {
            try { await api('PUT', '/api/targets', { user_id: u.id, metric: m, daily_target: inp.value || 0 }); toast('Saved'); load(); } catch (x) { toast(x.message, true); }
          });
          return h('td', null, inp);
        }))))),
      h('div', { class: 'muted', style: 'margin-top:8px' }, 'Leave a box empty (or 0) for no target. Numbers are per working day.'));
    editor.style.display = '';
  }

  async function load() {
    dateLabel.textContent = nice(state.date) + (state.date === todayStr() ? ' · today' : '');
    try {
      const d = await api('GET', '/api/targets?' + qs({ date: state.date }));
      if (!d.members.length) { body.replaceChildren(h('div', { class: 'card empty' }, 'No targets set yet. Use "Set targets" to give each person a daily number.')); return; }
      body.replaceChildren(...[
        d.working_day ? null : h('div', { class: 'card', style: 'padding:12px 16px;margin-bottom:14px;background:#fff8e6;border-color:#f3d99a' }, 'Friday is a day off, so no targets are due.'),
        h('div', { class: 'tgt-grid' }, d.members.map((m) => h('div', { class: 'card tgt' },
          h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:12px' }, avatar(m.name, 40),
            h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'tgt-name' }, m.name), h('div', { class: 'muted' }, m.overall == null ? 'No targets' : 'Today’s target progress')),
            m.overall == null ? null : h('div', { class: 'tgt-pct ' + tone(m.overall) }, m.overall + '%')),
          h('div', { class: 'tgt-rows' }, m.rows.map((r) => h('div', { class: 'tgt-row' },
            h('div', { class: 'tgt-top' }, h('span', null, r.label), h('b', null, r.target ? `${r.done.toLocaleString()} / ${r.target.toLocaleString()}` : `${r.done.toLocaleString()} (no target)`)),
            h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill ' + tone(r.pct), style: `width:${Math.min(100, r.pct ?? 0)}%` }))))),
          h('div', { class: 'week' }, m.days.map((x) => h('div', { class: 'wk' + (x.off ? ' off' : '') + (x.day === d.date ? ' cur' : ''), title: `${x.day}: ${x.pct == null ? 'no target' : x.pct + '%'}` },
            h('div', { class: 'wk-bar' }, h('div', { class: 'wk-fill ' + tone(x.pct), style: `height:${x.off ? 0 : Math.min(100, x.pct ?? 0)}%` })),
            h('div', { class: 'wk-d' }, short(x.day))))))))].filter(Boolean));
    } catch (e) { toast(e.message, true); }
  }
  await load();
}
