import { api, qs } from '../api.js';
import { h, fill } from '../util.js';
import { openLead } from './lead-drawer.js';

// Outcome numbers for the week (counts only) and a list of things that should not be silent.
export async function drawOutcomes(el, week = '') {
  const o = await api('GET', '/api/kpi/outcomes?' + qs({ week }));
  const cols = [['meetings_booked', 'Meetings booked'], ['meetings_held', 'Meetings held'], ['qualified_replies', 'Replies'], ['emails_sent', 'Emails sent'], ['emails_sent_approved', 'Emails CEO approved'], ['contact_forms', 'Contact Us forms'], ['followups_done', 'Follow-ups done'], ['drafts_submitted', 'Sent to CEO']];
  fill(el,
    h('div', { class: 'row', style: 'align-items:center;margin-bottom:8px' }, h('b', null, 'Outcomes'), h('span', { class: 'muted', style: 'margin-left:8px' }, `${o.from} to ${o.last_working_day} (Monday to Saturday)`),
      h('div', { class: 'spacer' }), h('span', { class: 'muted' }, `Waiting for CEO now: ${o.review.waiting} · approved this week: ${o.review.approved_week} · changes asked: ${o.review.changes_week}`)),
    h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Person'), ...cols.map(([, l]) => h('th', null, l)))),
      h('tbody', null, o.rows.length ? o.rows.map((r) => h('tr', null, h('td', null, r.name), ...cols.map(([k]) => h('td', null, String(r[k]))))) : h('tr', null, h('td', { colspan: cols.length + 1, class: 'muted' }, 'No team members yet.'))))));
}

export async function drawExceptions(el, ctx) {
  const x = await api('GET', '/api/kpi/exceptions');
  const total = x.untouched.length + x.stuck.length + x.unsent.length + x.overdue.length + (x.ceoLeads || []).length;
  const group = (title, rows, line) => rows.length ? h('details', { open: rows.length <= 5, style: 'margin-top:6px' }, h('summary', { style: 'cursor:pointer;font-weight:600' }, `${title} (${rows.length})`),
    h('ul', { style: 'margin:6px 0 0 18px' }, rows.slice(0, 25).map((r) => h('li', null, line(r))))) : null;
  const link = (r) => r.id && r.name ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLead(r.id, ctx, () => {}); } }, r.name || r.company) : (r.name || r.company);
  fill(el, h('b', null, total ? `Needs attention (${total})` : 'Nothing is stuck'),
    group('Rated PURSUE or QUALIFY but no outreach yet', x.untouched, (r) => [link(r), ` · ${r.company || ''} · ${r.rating} · ${r.owner_name || 'no owner'}`]),
    group('Leads waiting for CEO review more than 24 hours', x.ceoLeads || [], (r) => [link(r), ` · ${r.company || ''} · from ${r.submitted_name || '?'}`]),
    group('Drafts waiting for the CEO more than 24 hours', x.stuck, (r) => `${r.name || r.company} · ${r.channel} · from ${r.submitted_name || '?'}`),
    group('Approved but not sent for 2+ days', x.unsent, (r) => `${r.name || r.company} · ${r.channel} · ${r.owner_name || ''}`),
    group('Follow-up 3+ days late', x.overdue, (r) => [link(r), ` · ${r.next_action || ''} · due ${r.next_action_date} · ${r.owner_name || ''}`]));
}
