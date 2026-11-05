import { api, qs } from '../api.js';
import { h, fill, toast, todayStr, avatar } from '../util.js';
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
      isAdmin ? h('button', { class: 'btn primary', onclick: () => openForm(null) }, icon('plus', 15), 'Add task') : null),
    addBox, chips, summary, list);

  // ── admin: add / edit a task (assign people with the tick boxes) ──
  let editingId = null;
  const f = Object.fromEntries(['title', 'category', 'expected'].map((k) => [k, h('input', { placeholder: { title: 'Task title', category: 'Category', expected: 'Expected result' }[k] })]));
  const prio = h('select', null, ...['High', 'Medium', 'Low'].map((p) => h('option', { value: p }, p + ' priority')));
  const people = ctx.users.filter((u) => u.active && u.role !== 'admin');
  const boxes = people.map((u) => ({ name: u.name, cb: h('input', { type: 'checkbox' }) }));

  // ── "When" picker: tap the days, pick the time. No typing rules by hand. ──
  const DAYS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const dayOn = new Set();
  let mode = 'week', monthFrom = 1, monthTo = 10;
  const dayBtns = DAYS.map((d) => h('button', { type: 'button', class: 'chip noav', onclick: () => { if (dayOn.has(d)) dayOn.delete(d); else dayOn.add(d); drawWhen(); } }, d));
  const preset = (label, list) => h('button', { type: 'button', class: 'btn small', onclick: () => { dayOn.clear(); list.forEach((d) => dayOn.add(d)); mode = 'week'; drawWhen(); } }, label);
  const modeSel = h('select', { onchange: () => { mode = modeSel.value; drawWhen(); } }, h('option', { value: 'week' }, 'Days of the week'), h('option', { value: 'month' }, 'Days of the month'), h('option', { value: 'eom' }, 'End of month (last 3 days)'));
  const mFrom = h('input', { type: 'number', min: 1, max: 31, style: 'width:70px', oninput: () => { monthFrom = Number(mFrom.value) || 1; } });
  const mTo = h('input', { type: 'number', min: 1, max: 31, style: 'width:70px', oninput: () => { monthTo = Number(mTo.value) || 1; } });
  const tStart = h('input', { type: 'time', style: 'width:150px' }); const tEnd = h('input', { type: 'time', style: 'width:150px' });
  let rawWindow = '';
  const whenBox = h('div', { class: 'field' });
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || 'th');
  function drawWhen() {
    dayBtns.forEach((b) => b.classList.toggle('on', dayOn.has(b.textContent)));
    modeSel.value = mode; mFrom.value = monthFrom; mTo.value = monthTo;
    fill(whenBox,
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, h('b', null, 'Repeats on'), modeSel),
      mode === 'week' ? h('div', { style: 'margin-top:8px' },
        h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...dayBtns),
        h('div', { class: 'row', style: 'gap:6px;margin-top:8px' }, preset('Every working day (Sat–Thu)', ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']), preset('Weekdays (Mon–Thu)', ['Mon', 'Tue', 'Wed', 'Thu']), h('span', { class: 'muted' }, 'Friday is the team\'s day off.'))) : null,
      mode === 'month' ? h('div', { class: 'row', style: 'gap:8px;margin-top:8px' }, 'From day', mFrom, 'to day', mTo, 'of every month') : null,
      h('div', { class: 'row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap' }, h('b', null, 'Time'), tStart, 'to', tEnd, rawWindow ? h('span', { class: 'muted' }, `(was: ${rawWindow})`) : null));
  }
  const toText = () => {
    if (mode === 'eom') return 'End of month';
    if (mode === 'month') return `${ord(monthFrom)} - ${ord(monthTo)} of month`;
    const list = DAYS.filter((d) => dayOn.has(d));
    if (list.join() === 'Sat,Sun,Mon,Tue,Wed,Thu') return 'Sat-Thu';
    return list.join('/');
  };
  const t12 = (v) => { if (!v) return ''; let [h24, m] = v.split(':').map(Number); const ap = h24 >= 12 ? 'PM' : 'AM'; const hh = h24 % 12 || 12; return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`; };
  const from12 = (txt) => { const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(txt || ''); if (!m) return ''; let hh = Number(m[1]) % 12; if (/pm/i.test(m[3])) hh += 12; return `${String(hh).padStart(2, '0')}:${m[2]}`; };
  const windowText = () => (tStart.value && tEnd.value ? `${t12(tStart.value)} - ${t12(tEnd.value)}` : tStart.value ? t12(tStart.value) : rawWindow);
  function loadWhen(days, win) {
    dayOn.clear(); mode = 'week'; monthFrom = 1; monthTo = 10;
    const t = String(days || '').replace(/[–—]/g, '-');
    const ORDER = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const no = (x) => ORDER.findIndex((d) => d.toLowerCase() === String(x).trim().slice(0, 3).toLowerCase());
    if (/end of month/i.test(t)) mode = 'eom';
    else if (/of month/i.test(t)) { const m = t.match(/(\d+)\D+(\d+)/); mode = 'month'; if (m) { monthFrom = Number(m[1]); monthTo = Number(m[2]); } }
    else for (const part of t.split(/[,/]/)) {
      const r = part.split('-');
      if (r.length === 2 && no(r[0]) >= 0 && no(r[1]) >= 0) { let i = no(r[0]); const e = no(r[1]); for (let n = 0; n < 7; n++) { dayOn.add(ORDER[i]); if (i === e) break; i = (i + 1) % 7; } }
      else if (no(part) >= 0) dayOn.add(ORDER[no(part)]);
    }
    rawWindow = ''; tStart.value = ''; tEnd.value = '';
    const m2 = /^(.*?)\s*-\s*(.*)$/.exec(win || '');
    const a = m2 ? from12(m2[1].includes('M') ? m2[1] : m2[1] + (/PM/i.test(m2[2]) ? ' PM' : ' AM')) : from12(win);
    const bb = m2 ? from12(m2[2]) : '';
    if (a && (bb || !m2)) { tStart.value = a; tEnd.value = bb; } else rawWindow = win || '';
    drawWhen();
  }
  const formTitle = h('b', null, 'New task');
  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    const assignees = boxes.filter((x) => x.cb.checked).map((x) => x.name).join(' & ');
    const days = toText();
    if (mode === 'week' && !days) { toast('Tap at least one day', true); return; }
    const body = { ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])), priority: prio.value, assignees, days, window: windowText() };
    try {
      if (editingId) await api('PATCH', '/api/tasks/' + editingId, body); else await api('POST', '/api/tasks', body);
      toast(editingId ? 'Task updated' : 'Task added'); closeForm(); load();
    } catch (e) { toast(e.message, true); }
  } }, 'Save task');
  function openForm(t) {
    editingId = t ? t.id : null;
    formTitle.textContent = t ? 'Edit task' : 'New task';
    f.title.value = t?.title || ''; loadWhen(t ? t.days : 'Sat-Thu', t ? t.time_window : ''); f.category.value = t?.category || ''; f.expected.value = t?.expected || '';
    prio.value = t?.priority || 'Medium';
    const set = new Set(String(t?.assignees || '').split(/\s*(?:&|,| and )\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean));
    boxes.forEach((x) => { x.cb.checked = set.has(x.name.toLowerCase()) || [...set].some((n) => x.name.toLowerCase().startsWith(n)); });
    addBox.style.display = ''; addBox.scrollIntoView?.({ block: 'nearest' });
  }
  function closeForm() { addBox.style.display = 'none'; editingId = null; }
  if (isAdmin) {
    addBox.append(h('div', null, formTitle),
      h('div', { class: 'grid2', style: 'margin-top:8px' }, ...Object.values(f).map((i) => h('div', { class: 'field' }, i)), h('div', { class: 'field' }, prio)),
      whenBox,
      h('div', { style: 'margin:10px 0 4px' }, h('b', null, 'Assign to')),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:14px' }, ...boxes.map((x) => h('label', { class: 'row', style: 'gap:6px' }, x.cb, x.name))),
      h('div', { class: 'row', style: 'margin-top:12px' }, saveBtn, h('button', { class: 'btn', onclick: closeForm }, 'Cancel')));
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
            t.done && t.done_by ? h('div', { class: 'sub ok' }, `✓ ${t.done_by}`) : null,
            isAdmin ? h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
              h('button', { class: 'btn small', onclick: () => openForm(t) }, 'Edit'),
              h('button', { class: 'btn small danger', onclick: async () => { if (!confirm(`Delete the task "${t.title}"? It disappears for everyone.`)) return; try { await api('DELETE', '/api/tasks/' + t.id); toast('Task deleted'); load(); } catch (e) { toast(e.message, true); } } }, 'Delete')) : null));
      })));
    } catch (e) { toast(e.message, true); }
  }
  await load();
}
