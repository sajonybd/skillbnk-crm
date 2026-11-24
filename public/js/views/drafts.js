import { api, qs } from '../api.js';
import { h, fill, toast, copyText, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { openLead } from './lead-drawer.js';

const CH = { linkedin_dm: 'LinkedIn message', linkedin_inmail: 'InMail', linkedin_comment: 'Comment', linkedin_connect: 'Connection note', linkedin_comment_reply: 'Comment reply', linkedin_followup: 'Follow-up / reply message', email: 'Email', website_contact: 'Website Contact Us form' };
const REVIEW = { draft: ['Draft', ''], submitted: ['Waiting for CEO', 'amber'], approved: ['Approved', 'green'], changes: ['Changes requested', 'red'] };
const GATED = ['linkedin_dm', 'linkedin_inmail', 'email', 'website_contact'];

// One draft card. Used by the Draft ready tab and the lead panel. The CRM never sends: a person sends, then presses Mark sent.
export function draftCard(d, { onChange = () => {}, showLead = false, ctx } = {}) {
  const ready = d.status === 'ready';
  const isAdmin = ctx?.user?.role === 'admin';
  const blocked = ready && GATED.includes(d.channel) && d.review_status !== 'approved' && d.lead_ceo_status !== 'approved' && !isAdmin;
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
      ready ? (() => { const [t, c] = REVIEW[d.review_status] || REVIEW.draft; return h('span', { class: 'chip noav ' + c }, t + (d.review_status === 'approved' && d.approved_name ? ' by ' + d.approved_name : '')); })() : null,
      d.status === 'sent' && d.replied_at ? h('span', { class: 'chip noav green' }, 'Replied') : null,
      h('span', { class: 'muted' }, `by ${d.created_name || '?'} · ${timeAgo(d.created_at)}`)),
    d.channel === 'email' && d.subject ? h('div', { style: 'margin-top:6px' }, h('b', null, 'Subject: '), d.subject) : null,
    h('div', { style: 'margin-top:6px' }, body),
    d.note ? h('div', { class: 'muted', style: 'margin-top:4px' }, 'Note: ' + d.note) : null,
    d.review_status === 'changes' && d.review_note ? h('div', { class: 'card', style: 'margin-top:6px;padding:8px;border-left:3px solid #e5484d' }, h('b', null, 'CEO asked for changes: '), d.review_note) : null,
    d.evidence ? h('div', { class: 'muted', style: 'margin-top:4px' }, 'Confirmation: ' + d.evidence) : null,
    (() => {
      const url = d.target_url || (d.channel === 'email' ? '' : d.linkedin);
      const missing = d.channel === 'linkedin_comment' && !d.target_url;
      const label = d.channel === 'linkedin_comment' ? (d.target_url ? 'Open the post' : 'Post link missing: open profile') : d.channel === 'linkedin_dm' || d.channel === 'linkedin_inmail' ? (d.target_url ? 'Open the message thread' : 'Open profile') : d.channel === 'linkedin_connect' ? 'Open profile' : '';
      return url && label ? h('div', { style: 'margin-top:6px' }, missing ? h('span', { class: 'chip noav', style: 'margin-right:6px' }, 'No post link yet') : null, h('a', { class: 'btn small', href: /^https?:/i.test(url) ? url : 'https://' + url, target: '_blank', rel: 'noopener' }, icon('link', 14), label)) : null;
    })(),
    ready ? h('div', { class: 'row', style: 'margin-top:8px;gap:6px;flex-wrap:wrap' },
      h('button', { class: 'btn small', onclick: () => { copyText(text); toast('Draft copied'); } }, icon('copy', 14), 'Copy'),
      h('button', { class: 'btn small', onclick: saveEdit }, 'Save edit'),
      // Step 1: send to the CEO. Step 2 (CEO only): approve or ask for changes with a comment.
      ['draft', 'changes'].includes(d.review_status) ? h('button', { class: 'btn small', onclick: () => act(() => api('POST', `/api/leads/drafts/${d.id}/submit`, {}), 'Sent to the CEO for approval') }, d.review_status === 'changes' ? 'Send to CEO again' : 'Send to CEO') : null,
      isAdmin && d.review_status !== 'approved' ? h('button', { class: 'btn small', onclick: () => act(() => api('POST', `/api/leads/drafts/${d.id}/review`, { decision: 'approve' }), 'Approved') }, 'Approve') : null,
      isAdmin && d.review_status === 'submitted' ? h('button', { class: 'btn small', onclick: () => { const n = prompt('What should change?'); if (n && n.trim()) act(() => api('POST', `/api/leads/drafts/${d.id}/review`, { decision: 'changes', note: n.trim() }), 'Changes requested'); } }, 'Request changes') : null,
      isAdmin && d.review_status === 'approved' ? h('button', { class: 'btn small', onclick: () => act(() => api('PATCH', `/api/leads/drafts/${d.id}`, { approved: false }), 'Approval removed') }, 'Remove approval') : null,
      h('button', { class: 'btn small primary', disabled: blocked, title: blocked ? 'The CEO has to approve this lead first (Send lead to CEO in the lead panel)' : 'Press only after you really sent it. This logs the activity.', onclick: () => {
        if (!confirm(d.channel === 'website_contact' ? 'Did you submit the form on their website?' : 'Did you send this? This logs it as sent.')) return;
        let evidence = '';
        if (d.channel === 'website_contact') { evidence = prompt('Paste the confirmation the website showed (or write what you saw):') || ''; if (evidence.trim().length < 5) { toast('The confirmation is needed to log this', true); return; } }
        act(() => api('POST', `/api/leads/drafts/${d.id}/sent`, { evidence }), 'Marked sent');
      } }, 'Mark sent'),
      h('button', { class: 'btn small danger', onclick: () => { if (confirm('Discard this draft?')) act(() => api('DELETE', `/api/leads/drafts/${d.id}`), 'Draft discarded'); } }, 'Discard')) : null,
    d.status === 'sent' && !d.replied_at ? h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn small', onclick: () => act(() => api('POST', `/api/leads/drafts/${d.id}/replied`, {}), 'Marked as replied') }, 'They replied')) : null,
    d.status === 'sent' ? h('div', { class: 'muted', style: 'margin-top:6px' }, 'Sent ' + timeAgo(d.sent_at)) : null);
}

export async function renderDrafts(el, ctx, { owner = '', onChange = () => {} } = {}) {
  const review = renderDrafts.filter || '';
  const r = await api('GET', '/api/leads/drafts?' + qs({ status: 'ready', owner, review }));
  const c = await api('GET', '/api/leads/drafts/count?' + qs({ owner }));
  const tab = (key, label, n) => h('button', { class: 'btn small' + (review === key ? ' primary' : ''), onclick: () => { renderDrafts.filter = key; renderDrafts(el, ctx, { owner, onChange }); } }, label + (n != null ? ` (${n})` : ''));
  const digest = h('button', { class: 'btn small', onclick: async () => { const x = await api('GET', '/api/leads/drafts/digest'); await copyText(x.text); toast(x.count ? `Copied: ${x.count} waiting for the CEO` : 'Nothing is waiting'); } }, icon('copy', 14), 'Copy list for CEO');
  fill(el,
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:8px' }, tab('', 'All', c.ready), tab('submitted', 'Waiting for CEO', c.waiting), tab('approved', 'Approved, ready to send', c.approved), tab('changes', 'Changes requested', c.changes), tab('draft', 'Not submitted'), digest),
    h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Send window: ' + r.send_window + '. Oldest first. Messages, emails and Contact Us forms can be marked sent once the CEO has approved the lead.'),
    r.rows.length ? r.rows.map((d) => draftCard(d, { onChange, showLead: true, ctx })) : h('div', { class: 'empty' }, 'No drafts here.'));
}


// "Add draft" form for the lead panel. Saves a ready draft (never sends). Comments and comment replies need the direct post link.
export function newDraftForm(lead, { onSaved = () => {} } = {}) {
  const channel = h('select', null, Object.entries(CH).map(([v, label]) => h('option', { value: v }, label)));
  const subject = h('input', { placeholder: 'Subject (email only)', style: 'display:none' });
  const target = h('input', { placeholder: 'Direct link to the exact post (needed for comments)', style: 'display:none' });
  const body = h('textarea', { rows: 5, placeholder: 'Write the draft here. It is saved as ready, not sent.' });
  const note = h('input', { placeholder: 'Note (optional)' });
  const sync = () => {
    subject.style.display = channel.value === 'email' ? '' : 'none';
    const needsLink = ['linkedin_comment', 'linkedin_comment_reply'].includes(channel.value);
    const form = channel.value === 'website_contact';
    target.style.display = needsLink || form || channel.value === 'linkedin_dm' ? '' : 'none';
    target.placeholder = needsLink ? 'Direct link to the exact post (needed)' : form ? 'Link to their Contact Us page (needed)' : 'Message thread link (optional)';
  };
  channel.addEventListener('change', sync);
  const save = h('button', { class: 'btn small primary', onclick: async () => {
    if (!body.value.trim()) { toast('Write the draft first', true); return; }
    try {
      await api('POST', `/api/leads/${lead.id}/drafts`, { channel: channel.value, subject: subject.value.trim(), body: body.value.trim(), note: note.value.trim(), target_url: target.value.trim() });
      toast('Draft saved (not sent)');
      onSaved();
    } catch (e) { toast(e.message, true); }
  } }, icon('plus', 14), 'Save draft');
  const box = h('details', { class: 'card', style: 'padding:10px;margin-top:6px' },
    h('summary', { style: 'cursor:pointer;font-weight:600' }, 'Add draft'),
    h('div', { style: 'display:grid;gap:8px;margin-top:8px' }, channel, subject, target, body, note, h('div', { class: 'row' }, save)));
  return box;
}
