import { api, qs } from '../api.js';
import { h, fill, options, debounce, toast, avatar, fullName, todayStr, shortDate, fmtDateTime } from '../util.js';
import { icon } from '../icons.js';
import { openLead } from './lead-drawer.js';

// Filters survive page switches within the session.
const state = { status: 'booked', when: '', user: '', q: '', sort: 'date', dir: 'asc', page: 1, limit: 50, week: '' };

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export async function render(root, ctx) {
  const { meetingStatuses } = ctx.config;
  const isAdmin = ctx.user.role === 'admin';
  const people = ctx.users.filter((u) => u.active);

  const kpiBox = h('div', { class: 'card', style: 'margin-bottom:14px' });
  const cards = h('div', { class: 'metrics' });
  const scheduleBox = h('div', { class: 'card', style: 'margin-bottom:14px;padding:16px;display:none' });
  const tableWrap = h('div', { class: 'tablewrap' });
  const pager = h('div', { class: 'pager' });
  const statusSeg = h('div', { class: 'seg' });
  const count = h('span', { class: 'muted' });

  const search = h('input', { type: 'search', placeholder: 'Search lead or company…', value: state.q,
    oninput: debounce(() => { state.q = search.value; state.page = 1; load(); }) });
  const whenSel = h('select', { onchange: () => { state.when = whenSel.value; state.page = 1; load(); } },
    options([['upcoming', 'Upcoming'], ['overdue', 'Needs update (date passed)'], ['today', 'Today'], ['week', 'This week'], ['next_week', 'Next week'], ['month', 'This month']], { blank: 'Any date' }));
  const userSel = h('select', { onchange: () => { state.user = userSel.value; state.page = 1; refresh(); } },
    h('option', { value: '' }, 'Everyone'), h('option', { value: 'me' }, 'Booked by me'),
    ...people.filter((u) => u.role === 'member' || u.id === ctx.user.id).map((u) => h('option', { value: u.id }, u.name)));
  whenSel.value = state.when; userSel.value = state.user;

  const scheduleBtn = h('button', { class: 'btn primary', onclick: () => {
    const open = scheduleBox.style.display === 'none';
    scheduleBox.style.display = open ? '' : 'none';
    if (open) drawSchedule();
  } }, icon('plus', 15), 'Schedule meeting');

  root.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Meetings'), h('div', { class: 'muted' }, 'Booked, completed and cancelled meetings, and the weekly booking KPI')),
      h('div', { class: 'spacer' }), scheduleBtn),
    scheduleBox, kpiBox, cards,
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, statusSeg, h('div', { class: 'searchbox' }, icon('search', 15), search), whenSel, userSel, h('div', { class: 'spacer' }), count),
      tableWrap, pager));

  let data = { rows: [], total: 0 };
  let summary = {};
  let kpi = null;

  async function refresh() {
    const sq = qs({ user: state.user });
    [summary, kpi] = await Promise.all([api('GET', '/api/meetings/summary?' + sq), api('GET', '/api/kpi?' + qs({ week: state.week }))]);
    drawCards(); drawKpi();
    await load();
  }

  async function load() {
    data = await api('GET', '/api/meetings?' + qs(state));
    count.textContent = `${data.total.toLocaleString()} meeting${data.total === 1 ? '' : 's'}`;
    drawStatus(); drawTable(); drawPager();
  }

  // ── summary cards (click to filter) ──
  function drawCards() {
    const card = (label, value, tone, ic, apply) => h('div', { class: 'metric', style: 'cursor:pointer', onclick: () => { Object.assign(state, { status: '', when: '', page: 1 }, apply); whenSel.value = state.when; load(); } },
      h('div', { class: 'lbl muted' }, h('span', { class: tone, style: 'display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px' }, icon(ic, 12)), label),
      h('div', { class: 'val' }, Number(value).toLocaleString()));
    fill(cards,
      card('Upcoming', summary.upcoming, 't-blue', 'calendar', { status: 'booked', when: 'upcoming' }),
      card('Today', summary.todayCount, 't-purple', 'clock', { status: 'booked', when: 'today' }),
      card('Need update', summary.overdue, 't-orange', 'clock', { status: 'booked', when: 'overdue' }),
      card('Completed', summary.completed, 't-green', 'check', { status: 'completed' }),
      card('Cancelled', summary.cancelled, 't-pink', 'x', { status: 'cancelled' }),
      card('Booked this week', summary.bookedThisWeek, 't-teal', 'target', {}));
  }

  // ── weekly KPI ──
  function drawKpi() {
    const isCurrent = kpi.week >= kpi.currentWeek;
    const members = state.user && state.user !== 'me' ? kpi.members.filter((m) => String(m.id) === state.user)
      : state.user === 'me' ? kpi.members.filter((m) => m.id === ctx.user.id) : kpi.members;
    const editable = kpi.canEdit && isCurrent;

    const nav = h('div', { class: 'row', style: 'gap:6px' },
      h('button', { class: 'btn small', title: 'Previous week', onclick: () => { state.week = addDays(kpi.week, -7); refresh(); } }, '←'),
      h('b', null, isCurrent ? 'This week' : 'Week'), h('span', { class: 'muted' }, `${shortDate(kpi.week)} – ${shortDate(addDays(kpi.week, 6))}`),
      h('button', { class: 'btn small', title: 'Next week', disabled: isCurrent, onclick: () => { state.week = addDays(kpi.week, 7) >= kpi.currentWeek ? '' : addDays(kpi.week, 7); refresh(); } }, '→'));

    const setAll = editable ? h('button', { class: 'btn small', onclick: async () => {
      const v = prompt('Weekly meeting target for EVERY team member (from this week on):', String(kpi.defaultTarget));
      if (v == null) return;
      try { await api('PUT', '/api/kpi/targets', { user_ids: 'all', target: Number(v) }); toast('Targets updated'); refresh(); } catch (e) { toast(e.message, true); }
    } }, 'Set target for everyone') : null;
    const startBtn = kpi.canEdit ? h('button', { class: 'btn small', title: 'Weeks before this are ignored (no carry-forward)', onclick: async () => {
      const v = prompt('KPI counts from the week containing this date (YYYY-MM-DD):', kpi.start);
      if (v == null) return;
      try { await api('PUT', '/api/kpi/start', { week: v }); toast('KPI start week updated'); refresh(); } catch (e) { toast(e.message, true); }
    } }, `Counting since ${shortDate(kpi.start)}`) : null;

    const memberCard = (m) => {
      const pct = m.target ? Math.min(100, (m.booked / m.target) * 100) : 100;
      const input = h('input', { type: 'number', min: 0, max: 1000, value: m.base, style: 'width:64px' });
      return h('div', { class: 'kcard' },
        h('div', { class: 'top' }, avatar(m.name, 28), h('b', null, m.name), h('div', { class: 'spacer' }),
          m.met ? h('span', { class: 'pill', style: 'background:var(--ok-soft);color:var(--ok)' }, icon('check', 12), 'Met') : null),
        h('div', { class: 'big' }, String(m.booked), h('small', null, ` / ${m.target} meetings`)),
        h('div', { class: 'kbar' + (m.met ? ' met' : ''), style: 'margin-top:6px' }, h('i', { style: `width:${pct}%` })),
        h('div', { class: 'note' }, m.met ? (m.booked > m.target ? `${m.booked - m.target} over target` : 'Target met') : `${m.remaining} to go`,
          m.carry_in ? h('span', null, ' · ', h('span', { class: 'carry' }, `${m.base} + ${m.carry_in} carried over`)) : ` · target ${m.base}`),
        m.history.length > 1 ? h('div', { class: 'khist', title: 'Previous weeks (oldest → newest): green = target met, red = missed (shortfall carried forward)' },
          [...m.history.slice(1)].reverse().map((w) => h('i', { class: w.met ? 'ok' : 'miss', title: `Week of ${shortDate(w.week)}: ${w.booked}/${w.target}` }))) : null,
        editable ? h('div', { class: 'row', style: 'margin-top:10px;gap:6px' }, h('span', { class: 'muted' }, 'Weekly target'), input,
          h('button', { class: 'btn small', onclick: async () => {
            try { await api('PUT', '/api/kpi/targets', { user_ids: [m.id], target: Number(input.value) }); toast(`${m.name}: target ${input.value} from this week`); refresh(); } catch (e) { toast(e.message, true); }
          } }, 'Save')) : null);
    };

    fill(kpiBox,
      h('div', { class: 'panel-h', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        h('div', null, h('h2', null, 'Weekly KPI — meetings booked'),
          h('p', null, `Default ${kpi.defaultTarget} per member per week. Missed meetings are added to next week's target.`)),
        h('div', { class: 'spacer' }), nav, setAll, startBtn),
      members.length ? h('div', { class: 'kpanel' }, members.map(memberCard)) : h('div', { class: 'empty' }, 'No team members to track yet.'));
  }

  // ── list ──
  function drawStatus() {
    const tabs = [['booked', 'Booked'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['', 'All']];
    fill(statusSeg, tabs.map(([k, label]) => h('button', { class: state.status === k ? 'on' : '', onclick: () => { state.status = k; state.page = 1; load(); } }, label)));
  }

  const header = (label, key) => h('th', { class: 'sortable', onclick: () => {
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc'; else { state.sort = key; state.dir = key === 'date' ? 'asc' : 'asc'; }
    state.page = 1; load();
  } }, label + (state.sort === key ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''));

  async function patch(m, body, msg = 'Saved') {
    try { await api('PATCH', `/api/meetings/${m.id}`, body); toast(msg); } catch (e) { toast(e.message, true); }
    refresh();
  }

  function drawTable() {
    if (data.rows.length === 0) { fill(tableWrap, h('div', { class: 'empty' }, 'No meetings match these filters.')); return; }
    const today = todayStr();
    fill(tableWrap, h('table', null,
      h('thead', null, h('tr', null, header('Date', 'date'), h('th', null, 'Time'), header('Lead', 'lead'), header('Company', 'company'),
        header('Booked by', 'booked_by'), header('Status', 'status'), h('th', null, 'Notes'), h('th', null, 'Stage'))),
      h('tbody', null, data.rows.map((m) => {
        const late = m.status === 'booked' && m.scheduled_date < today;
        const date = h('input', { type: 'date', value: m.scheduled_date, onchange: () => date.value && patch(m, { scheduled_date: date.value }, 'Rescheduled') });
        const time = h('input', { type: 'time', value: m.scheduled_time, onchange: () => patch(m, { scheduled_time: time.value }, 'Time saved') });
        const by = h('select', { class: 'inl', onchange: () => patch(m, { booked_by: Number(by.value) }, 'Booked-by updated') }, people.map((u) => h('option', { value: u.id }, u.name)));
        if (m.booked_by && !people.some((u) => u.id === m.booked_by)) by.append(h('option', { value: m.booked_by }, m.booked_by_name));
        by.value = m.booked_by ?? '';
        const st = h('select', { class: 'inl mstat ' + m.status, onchange: () => patch(m, { status: st.value }, `Marked ${meetingStatuses[st.value].toLowerCase()}`) }, options(Object.entries(meetingStatuses)));
        st.value = m.status;
        const notes = h('input', { value: m.notes, placeholder: 'Notes / outcome', style: 'min-width:170px', onchange: () => patch(m, { notes: notes.value }, 'Notes saved') });
        return h('tr', null,
          h('td', null, date, late ? h('div', { class: 'sub due' }, 'Date passed — update status') : (m.scheduled_date === today && m.status === 'booked' ? h('div', { class: 'sub', style: 'color:var(--accent);font-weight:650' }, 'Today') : null)),
          h('td', null, time),
          h('td', null, h('div', { class: 'leadcell' }, avatar(fullName(m), 28), h('div', null, h('a', { class: 'nm', onclick: () => openLead(m.lead_id, ctx, refresh) }, fullName(m)), h('div', { class: 'sub' }, m.title || '')))),
          h('td', { class: 'company' }, h('div', { class: 'nm' }, m.company)),
          h('td', null, by),
          h('td', null, st),
          h('td', null, notes),
          h('td', { class: 'muted' }, m.stage, h('div', { class: 'sub', title: m.created_at }, `Booked ${fmtDateTime(m.created_at)}`)));
      }))));
  }

  function drawPager() {
    const pages = Math.max(1, Math.ceil(data.total / state.limit));
    fill(pager, h('span', { class: 'muted' }, `Page ${state.page} of ${pages}`),
      h('button', { class: 'btn small', disabled: state.page <= 1, onclick: () => { state.page--; load(); } }, '← Prev'),
      h('button', { class: 'btn small', disabled: state.page >= pages, onclick: () => { state.page++; load(); } }, 'Next →'));
  }

  // ── schedule a meeting for any lead ──
  function drawSchedule() {
    let chosen = null;
    const picked = h('div', { class: 'muted' }, 'No lead chosen yet');
    const results = h('div', { class: 'reslist', style: 'margin-top:6px' });
    const find = h('input', { type: 'search', placeholder: 'Find the lead by name, company or email…' });
    find.addEventListener('input', debounce(async () => {
      if (find.value.trim().length < 2) return fill(results);
      const r = await api('GET', '/api/leads?' + qs({ q: find.value, limit: 6 }));
      fill(results, r.rows.length ? r.rows.map((l) => h('div', { class: 'res', style: 'cursor:pointer', onclick: () => {
        chosen = l; fill(picked, h('b', null, fullName(l)), ` · ${l.company || ''}`); fill(results); find.value = '';
        if (l.owner_id && people.some((u) => u.id === l.owner_id)) by.value = String(l.owner_id);
      } }, avatar(fullName(l), 24), h('a', null, fullName(l), h('span', { class: 'u' }, [l.title, l.company].filter(Boolean).join(' · '))))) : h('div', { class: 'muted' }, 'No matching leads'));
    }));
    const date = h('input', { type: 'date', value: todayStr() });
    const time = h('input', { type: 'time' });
    const by = h('select', null, people.map((u) => h('option', { value: u.id }, u.name)));
    by.value = String(ctx.user.id);
    const notes = h('input', { placeholder: 'Agenda / notes (optional)' });
    const go = h('button', { class: 'btn primary', onclick: async () => {
      if (!chosen) return toast('Choose a lead first', true);
      if (!date.value) return toast('Pick a date', true);
      go.disabled = true;
      try {
        await api('POST', `/api/leads/${chosen.id}/meetings`, { scheduled_date: date.value, scheduled_time: time.value, booked_by: Number(by.value), notes: notes.value });
        toast(`Meeting booked with ${fullName(chosen)}`);
        scheduleBox.style.display = 'none';
        state.status = 'booked';
        refresh();
      } catch (e) { toast(e.message, true); go.disabled = false; }
    } }, icon('calendar', 14), 'Book meeting');
    fill(scheduleBox,
      h('h2', { style: 'margin-bottom:10px' }, 'Schedule a meeting'),
      h('div', { class: 'field' }, h('label', null, 'Lead'), find), results, h('div', { style: 'margin:6px 0 12px' }, picked),
      h('div', { class: 'mform', style: 'border:0;background:none;padding:0' },
        h('div', { class: 'field' }, h('label', null, 'Date'), date), h('div', { class: 'field' }, h('label', null, 'Time'), time),
        h('div', { class: 'field' }, h('label', null, 'Booked by (counts for KPI)'), by),
        h('div', { class: 'field full' }, h('label', null, 'Notes'), notes),
        h('div', { class: 'full' }, go)));
  }

  await refresh();
}
