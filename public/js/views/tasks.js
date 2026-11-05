import { api, qs } from '../api.js';
import { h, toast, todayStr, avatar } from '../util.js';
import { icon } from '../icons.js';

const state = { date: '', who: 'me' };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

export async function render(root, ctx) {
  state.date ||= todayStr();
  if (!state.init) { state.who = ctx.user.role === 'admin' ? 'all' : 'me'; state.init = true; }
  const isAdmin = ctx.user.role === 'admin';
  const list = h('div', { class: 'card' });
  const chips = h('div', { class: 'chips', style: 'margin-bottom:12px' });
  const summary = h('div', { class: 'card', style: 'padding:14px 18px;margin-bottom:14px' });
  const dateLabel = h('div', { class: 'datelabel' });
  const addBox = h('div', { class: 'card', style: 'display:none;margin-bottom:14px;padding:16px' });
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Tasks'), h('div', { class: 'muted' }, 'The standing operating plan: who does what, each day')), h('div', { class: 'spacer' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn sq', onclick: () => { state.date = addDays(state.date, -1); load(); } }, icon('chevronLeft', 16)), dateLabel,
        h('button', { class: 'btn sq', onclick: () => { state.date = addDays(state.date, 1); load(); } }, icon('chevronRight', 16)),
        h('button', { class: 'btn', onclick: () => { state.date = todayStr(); load(); } }, 'Today')),
      isAdmin ? h('button', { class: 'btn primary', onclick: () => { addBox.style.display = addBox.style.display === 'none' ? '' : 'none'; } }, icon('plus', 15), 'Add task') : null),
    addBox, chips, summary, list);

  if (isAdmin) {
    const f = Object.fromEntries(['title', 'assignees', 'days', 'window', 'category', 'expected'].map((k) => [k, h('input', { placeholder: { title: 'Task title', assignees: 'Who (e.g. Tawhid & Ahana Anjum)', days: 'Days (Sat-Thu, Mon/Wed, 1st - 10th of month)', window: 'Time (09:00 - 10:00 AM)', category: 'Category', expected: 'Expected result' }[k] })]));
    addBox.append(h('div', { class: 'grid2' }, ...Object.values(f).map((i) => h('div', { class: 'field' }, i))),
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', '/api/tasks', Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value]))); toast('Task added'); Object.values(f).forEach((i) => { i.value = ''; }); load(); } catch (e) { toast(e.message, true); }
      } }, 'Save task')));
  }

  const chip = (value, label, av) => h('button', { class: 'chip' + (state.who === value ? ' on' : '') + (av ? '' : ' noav'), onclick: () => { state.who = value; load(); } }, av ? avatar(label, 22) : null, label);

  async function load() {
    dateLabel.textContent = nice(state.date) + (state.date === todayStr() ? ' · today' : '');
    chips.replaceChildren(chip('me', 'My tasks'), chip('all', 'Everyone'), ...ctx.users.filter((u) => u.active && u.role !== 'admin' && u.id !== ctx.user.id).map((u) => chip(String(u.id), u.name, true)));
    try {
      const d = await api('GET', '/api/tasks?' + qs({ date: state.date, assignee: state.who }));
      const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
      summary.replaceChildren(h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:16px' },
        h('div', { style: 'min-width:150px' }, h('div', { class: 'muted' }, d.working_day ? 'Progress' : 'Day off'), h('div', { style: 'font-size:22px;font-weight:700' }, `${d.done} of ${d.total} done`)),
        h('div', { class: 'bar-track', style: 'flex:1;height:12px' }, h('div', { class: 'bar-fill ' + (pct >= 100 ? 'ok' : pct >= 50 ? 'mid' : 'low'), style: `width:${pct}%` })),
        h('b', null, pct + '%')));
      if (!d.items.length) { list.replaceChildren(h('div', { class: 'empty' }, d.working_day ? 'No tasks scheduled for this selection.' : 'Friday is a day off.')); return; }
      list.replaceChildren(h('div', { class: 'tasklist' }, d.items.map((t) => {
        const cb = h('input', { type: 'checkbox', checked: t.done, onchange: async () => {
          try { await api('POST', `/api/tasks/${t.id}/done`, { day: d.date, done: cb.checked }); load(); } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
        } });
        return h('div', { class: 'task' + (t.done ? ' done' : '') },
          h('label', { class: 'tcheck' }, cb),
          h('div', { class: 'ttime' }, t.time_window || 'Any time'),
          h('div', { class: 'tmain' },
            h('div', { class: 'ttitle' }, t.title, t.priority === 'High' ? h('span', { class: 'pill hi' }, 'High') : null),
            t.expected ? h('div', { class: 'sub' }, t.expected) : null),
          h('div', { class: 'twho' }, h('span', { class: 'srcpill' }, t.category || 'General'), h('div', { class: 'sub' }, t.assignees || 'Unassigned'),
            t.done && t.done_by ? h('div', { class: 'sub ok' }, `✓ ${t.done_by}`) : null));
      })));
    } catch (e) { toast(e.message, true); }
  }
  await load();
}
