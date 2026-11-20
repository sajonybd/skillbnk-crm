import { api, qs } from '../api.js';
import { h, fill, toast, copyText, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { openLead } from './lead-drawer.js';

const CH = { linkedin_dm: 'LinkedIn message', linkedin_inmail: 'InMail', linkedin_comment: 'Comment', linkedin_connect: 'Connection note', email: 'Email' };

// One draft card. Used by the Draft ready tab and the lead panel. The CRM never sends: a person sends, then presses Mark sent.
export function draftCard(d, { onChange = () => {}, showLead = false, ctx } = {}) {
  const ready = d.status === 'ready';
  const text = d.channel === 'email' && d.subject ? `Subject: ${d.subject}\n\n${d.body}` : d.body;
  const body = h('textarea', { rows: Math.min(12, Math.max(4, d.body.split('\n').length + 1)), disabled: !ready });
  body.value = d.body;
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); } catch (e) { toast(e.message, true); } onChange(); };
  const saveEdit = () => act(() => api('PATCH', `/api/leads/drafts/${d.id}`, { body: body.value }), 'Draft saved (approval cleared)');
  return h('div', { class: 'card', style: 'padding:12px;margin-bottom:10px' },
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center' },
      showLead ? h('b', { style: 'cursor:pointer', onclick: () => openLead(d.lead_id, ctx, onChange) }, d.lead_name || '(no name)') : null,
      showLead && d.company ? h('span', { class: 'muted' }, d.company) : null,
      h('span', { class: 'chip noav on' }, CH[d.channel] || d.channel),
      d.status !== 'ready' ? h('span', { class: 'chip noav' }, d.status === 'sent' ? 'Sent' : 'Discarded') : null,
      d.approved_at ? h('span', { class: 'chip noav green' }, 'Approved by ' + (d.approved_name || '')) : null,
      h('span', { class: 'muted' }, `by ${d.created_name || '?'} · ${timeAgo(d.created_at)}`)),
    d.channel === 'email' && d.subject ? h('div', { style: 'margin-top:6px' }, h('b', null, 'Subject: '), d.subject) : null,
    h('div', { style: 'margin-top:6px' }, body),
    d.note ? h('div', { class: 'muted', style: 'margin-top:4px' }, 'Note: ' + d.note) : null,
    ready ? h('div', { class: 'row', style: 'margin-top:8px;gap:6px;flex-wrap:wrap' },
      h('button', { class: 'btn small', onclick: () => { copyText(text); toast('Draft copied'); } }, icon('copy', 14), 'Copy'),
      h('button', { class: 'btn small', onclick: saveEdit }, 'Save edit'),
      h('button', { class: 'btn small', onclick: () => act(() => api('PATCH', `/api/leads/drafts/${d.id}`, { approved: !d.approved_at }), d.approved_at ? 'Approval removed' : 'Approved') }, d.approved_at ? 'Remove approval' : 'Approve'),
      h('button', { class: 'btn small primary', title: 'Press only after you really sent it. This logs the activity.', onclick: () => { if (confirm('Did you send this? This logs it as sent.')) act(() => api('POST', `/api/leads/drafts/${d.id}/sent`), 'Marked sent and logged'); } }, 'Mark sent'),
      h('button', { class: 'btn small danger', onclick: () => { if (confirm('Discard this draft?')) act(() => api('DELETE', `/api/leads/drafts/${d.id}`), 'Draft discarded'); } }, 'Discard')) : null,
    d.status === 'sent' ? h('div', { class: 'muted', style: 'margin-top:6px' }, 'Sent ' + timeAgo(d.sent_at)) : null);
}

export async function renderDrafts(el, ctx, { owner = '', onChange = () => {} } = {}) {
  const r = await api('GET', '/api/leads/drafts?' + qs({ status: 'ready', owner }));
  fill(el,
    h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Send window: ' + r.send_window + '. Oldest first.'),
    r.rows.length ? r.rows.map((d) => draftCard(d, { onChange, showLead: true, ctx })) : h('div', { class: 'empty' }, 'No drafts waiting.'));
}
