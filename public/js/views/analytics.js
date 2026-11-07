import { api, qs } from '../api.js';
import { h, fill, options, fmtDateTime, toast, avatar, colorFor } from '../util.js';
import { icon, TYPE_ICON } from '../icons.js';
import { openLead } from './lead-drawer.js';

const state = { range: 'today', from: '', to: '', user: '', type: '' };
const PAGE = 100;
const TABS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['last_week', 'Last week'], ['month', 'This month'], ['all', 'All time'], ['custom', 'Custom']];
const MEET = [['meeting_booked', 'Meetings booked'], ['meeting_completed', 'Completed'], ['meeting_cancelled', 'Cancelled']];
const TONES = ['t-blue', 't-purple', 't-green', 't-orange', 't-pink', 't-teal'];

const fmtDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' });

export async function render(root, ctx) {
  const { typeLabels, touchTypes } = ctx.config;
  const users = ctx.users;

  const tabsBox = h('div', { class: 'seg' });
  const custom = h('span', { class: 'row' });
  const memberBox = h('div', { class: 'chips' });
  const metricsBox = h('div', { class: 'metrics' });
  const funnelBox = h('div', { class: 'card', style: 'margin-bottom:16px' });
  const matrixBox = h('div', { class: 'card', style: 'margin-bottom:16px' });
  const dailyBox = h('div', { class: 'card', style: 'margin-bottom:16px' });
  const feedBox = h('div', { class: 'card' });
  const caption = h('span', { class: 'muted' });
  const typeSel = h('select', { value: state.type, onchange: () => { state.type = typeSel.value; loadFeed(); } },
    options(Object.entries(typeLabels), { blank: 'All activity types' }));

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Analytics'), h('div', { class: 'muted' }, 'Team outreach and daily activity')), h('div', { class: 'spacer' }), caption),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, tabsBox, custom),
    h('div', { style: 'margin-bottom:6px' }, memberBox),
    metricsBox, funnelBox, matrixBox, dailyBox, feedBox);

  let tabCounts = {};
  let rows = [];
  let total = 0;

  const filterQs = () => qs({ range: state.range, from: state.from, to: state.to, user: state.user });

  function drawControls() {
    fill(tabsBox, TABS.map(([k, label]) => h('button', { class: state.range === k ? 'on' : '', onclick: () => { state.range = k; loadAll(); } },
      label, tabCounts[k] != null && k !== 'custom' ? h('span', { class: 'n' }, `(${tabCounts[k].toLocaleString()})`) : null)));
    const from = h('input', { type: 'date', value: state.from, onchange: () => { state.from = from.value; loadAll(); } });
    const to = h('input', { type: 'date', value: state.to, onchange: () => { state.to = to.value; loadAll(); } });
    fill(custom, state.range === 'custom' ? [from, '→', to] : null);
    const chip = (value, label, av) => h('button', { class: 'chip' + (state.user === value ? ' on' : '') + (av ? '' : ' noav'),
      onclick: () => { state.user = value; loadAll(); } }, av ? avatar(label, 22) : icon('users', 14), label);
    fill(memberBox, chip('', 'All team'), ...users.filter((u) => u.active).map((u) => chip(String(u.id), u.name, true)));
  }

  async function loadFunnel() {
    try {
      const { counts: c, rates: r, byPath } = await api('GET', '/api/leads/funnel?' + qs({ owner: state.user }));
      const pct = (v) => (v == null ? '—' : v + '%');
      const step = (label, n, note) => h('div', { class: 'metric' }, h('div', { class: 'muted' }, label), h('div', { style: 'font-size:22px;font-weight:600' }, n.toLocaleString()), note ? h('div', { class: 'muted' }, note) : null);
      const paths = Object.entries(byPath).filter(([k]) => k).map(([k, n]) => `${k}: ${n}`).join(' · ') || 'No lead types set yet';
      fill(funnelBox, h('h3', null, 'Outreach funnel (all time)'),
        h('div', { class: 'metrics' },
          step('Researched', c.researched), step('Invited', c.invited), step('Accepted', c.accepted, 'Acceptance ' + pct(r.acceptance)),
          step('First DM', c.firstDm), step('Replied', c.replied, 'Reply ' + pct(r.reply)), step('Meetings', c.meetings, 'Of replies ' + pct(r.meeting))),
        h('div', { class: 'muted', style: 'margin-top:8px' }, 'Lead types — ' + paths));
    } catch (e) { toast(e.message, true); }
  }

  async function loadAll() {
    loadFunnel();
    try {
      const [tabs, act, daily] = await Promise.all([
        api('GET', '/api/activity/tabs?' + qs({ user: state.user })),
        api('GET', '/api/activity?' + qs({ ...state, type: '', limit: 1 })),
        api('GET', '/api/activity/daily?' + filterQs()),
      ]);
      tabCounts = tabs;
      drawControls();
      drawMetrics(act.summary);
      drawMatrix(act.summary);
      drawDaily(daily);
      caption.textContent = act.bounds
        ? `${fmtDateTime(act.bounds.start)} → ${fmtDateTime(new Date(new Date(act.bounds.end) - 1).toISOString())}`
        : 'All time';
      await loadFeed();
    } catch (e) { toast(e.message, true); }
  }

  const sumType = (summary, t) => summary.reduce((n, s) => n + (s.types[t] || 0), 0);
  const touchesOf = (s) => touchTypes.reduce((n, t) => n + (s.types[t] || 0), 0);

  function drawMetrics(summary) {
    const totalTouches = summary.reduce((n, s) => n + touchesOf(s), 0);
    fill(metricsBox,
      h('div', { class: 'metric main' }, h('div', { class: 'lbl' }, icon('chart', 14), 'Touches'), h('div', { class: 'val' }, totalTouches.toLocaleString())),
      touchTypes.map((t, i) => h('div', { class: 'metric' },
        h('div', { class: 'lbl muted' }, h('span', { class: TONES[i % TONES.length], style: 'display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px' }, icon(TYPE_ICON[t] || 'clock', 12)), typeLabels[t]),
        h('div', { class: 'val' }, sumType(summary, t).toLocaleString()))),
      MEET.map(([t, label]) => h('div', { class: 'metric' },
        h('div', { class: 'lbl muted' }, h('span', { class: 't-green', style: 'display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px' }, icon(TYPE_ICON[t], 12)), label),
        h('div', { class: 'val' }, sumType(summary, t).toLocaleString()))));
  }

  function drawMatrix(summary) {
    if (summary.length === 0) { fill(matrixBox, h('div', { class: 'empty' }, 'No activity in this period.')); return; }
    const cell = (n, bold) => h('td', { class: n ? '' : 'z' }, bold && n ? h('b', null, n.toLocaleString()) : n ? n.toLocaleString() : '·');
    fill(matrixBox,
      h('div', { class: 'panel-h' }, h('h2', null, 'Team activity by member'), h('p', null, 'Every logged action in the selected period')),
      h('div', { class: 'tablewrap' }, h('table', { class: 'matrix' },
        h('thead', null, h('tr', null, h('th', null, 'Team member'), h('th', null, 'Leads worked'), h('th', null, 'Touches'),
          touchTypes.map((t) => h('th', null, typeLabels[t])), MEET.map(([, l]) => h('th', null, l)), h('th', null, 'Notes'))),
        h('tbody', null, summary.map((s) => h('tr', null,
          h('td', null, h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap;white-space:nowrap' }, avatar(s.user_name, 24), h('b', null, s.user_name))),
          cell(s.leads), cell(touchesOf(s), true),
          touchTypes.map((t) => cell(s.types[t] || 0)), MEET.map(([t]) => cell(s.types[t] || 0)), cell(s.types.note || 0)))),
        summary.length > 1 ? h('tfoot', null, h('tr', null, h('td', null, 'Team'), h('td', null, ''),
          h('td', null, summary.reduce((n, s) => n + touchesOf(s), 0).toLocaleString()),
          touchTypes.map((t) => h('td', null, sumType(summary, t).toLocaleString())),
          MEET.map(([t]) => h('td', null, sumType(summary, t).toLocaleString())),
          h('td', null, sumType(summary, 'note').toLocaleString()))) : null)));
  }

  function drawDaily(daily) {
    if (daily.days.length === 0) { fill(dailyBox, h('div', { class: 'empty' }, 'No daily activity in this period.')); return; }
    const days = [...daily.days].reverse(); // oldest → newest for the chart
    const members = new Map();
    for (const d of days) for (const u of Object.values(d.byUser)) members.set(u.user_id, u.user_name);
    const memberList = [...members].map(([id, name]) => ({ id, name }));
    const max = Math.max(1, ...days.map((d) => d.touches));

    const chart = h('div', { class: 'bars' }, days.map((d) => h('div', { class: 'bar', title: `${fmtDay(d.day)}: ${d.touches} touches` },
      h('div', { class: 'v' }, d.touches || ''),
      h('div', { class: 'stack', style: `height:${Math.round((d.touches / max) * 110)}px` },
        memberList.map((m) => {
          const t = d.byUser[m.id]?.touches || 0;
          return t ? h('div', { class: 'seg-part', style: `height:${(t / d.touches) * 100}%;background:${colorFor(m.name)}`, title: `${m.name}: ${t}` }) : null;
        })),
      h('div', { class: 'd' }, fmtDay(d.day).replace(/^\w+, /, '')))));

    const legend = h('div', { class: 'legend' }, memberList.map((m) => h('span', null, h('i', { style: `background:${colorFor(m.name)}` }), m.name)));

    const table = h('div', { class: 'tablewrap' }, h('table', { class: 'matrix' },
      h('thead', null, h('tr', null, h('th', null, 'Day'), memberList.map((m) => h('th', null, m.name)), h('th', null, 'Total touches'), h('th', null, 'All activity'))),
      h('tbody', null, daily.days.map((d) => h('tr', null,
        h('td', null, h('b', null, fmtDay(d.day))),
        memberList.map((m) => { const n = d.byUser[m.id]?.touches || 0; return h('td', { class: n ? '' : 'z' }, n ? n.toLocaleString() : '·'); }),
        h('td', null, h('b', null, d.touches.toLocaleString())), h('td', { class: 'muted' }, d.total.toLocaleString()))))));

    fill(dailyBox,
      h('div', { class: 'panel-h' }, h('h2', null, 'Daily activity'),
        h('p', null, `Touches per day${state.user ? ' for the selected member' : ', stacked by team member'}${daily.capped ? ' (showing the latest 62 days)' : ''}`)),
      chart, legend, table);
  }

  async function fetchFeed(offset) {
    return api('GET', '/api/activity?' + qs({ ...state, limit: PAGE, offset }));
  }
  async function loadFeed() {
    const d = await fetchFeed(0);
    rows = d.rows; total = d.total;
    drawFeed();
  }

  function drawFeed() {
    const head = h('div', { class: 'toolbar', style: 'justify-content:space-between' }, h('h2', null, `Activity log (${total.toLocaleString()})`), typeSel);
    if (rows.length === 0) { fill(feedBox, head, h('div', { class: 'empty' }, 'Nothing logged for these filters.')); return; }
    const more = rows.length < total
      ? h('div', { class: 'pager' }, h('button', { class: 'btn small', onclick: async () => {
          const d = await fetchFeed(rows.length);
          rows = rows.concat(d.rows);
          drawFeed();
        } }, `Load more (${(total - rows.length).toLocaleString()} left)`)) : null;
    fill(feedBox, head,
      h('div', { class: 'tablewrap' }, h('table', { class: 'feed' },
        h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'Activity'), h('th', null, 'Lead'), h('th', null, 'Detail'))),
        h('tbody', null, rows.map((r) => h('tr', { class: 'clickable', onclick: () => openLead(r.lead_id, ctx, loadAll) },
          h('td', { class: 'when' }, fmtDateTime(r.created_at)),
          h('td', null, h('div', { class: 'row', style: 'gap:7px;flex-wrap:nowrap' }, avatar(r.user_name, 20), r.user_name)),
          h('td', null, h('span', { class: 'pill' }, icon(TYPE_ICON[r.type] || 'clock', 12), typeLabels[r.type] || r.type)),
          h('td', null, h('div', null, r.lead_name || '(no name)'), h('div', { class: 'sub' }, r.lead_company)),
          h('td', null, r.note)))))),
      more);
  }

  await loadAll();
}
