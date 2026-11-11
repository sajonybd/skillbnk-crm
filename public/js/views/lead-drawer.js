import { api } from '../api.js';
import { h, options, pill, fullName, fmtDateTime, timeAgo, toast, avatar, copyText, asUrl, todayStr } from '../util.js';
import { watchVisit } from '../visit.js';
import { icon, TYPE_ICON } from '../icons.js';

// Editable contact fields: [key, label, full width?]
const DETAIL_FIELDS = [
  ['first_name', 'First name'], ['last_name', 'Last name'],
  ['title', 'Title', true], ['company', 'Company'], ['website', 'Website'],
  ['email', 'Email'], ['email_status', 'Email status'],
  ['phone', 'Phone'], ['linkedin', 'LinkedIn'],
  ['company_linkedin', 'Company LinkedIn'], ['employees', '# Employees'],
  ['industry', 'Industry'], ['icp_segment', 'ICP segment'],
  ['city', 'City'], ['state', 'State'], ['country', 'Country'], ['source', 'Source / list'],
];

function closeOnEsc(close) {
  const fn = (e) => { if (e.key === 'Escape') { close(); } };
  document.addEventListener('keydown', fn);
  return () => document.removeEventListener('keydown', fn);
}

function shell(onClose = () => {}) {
  const overlay = h('div', { class: 'overlay' });
  const drawer = h('aside', { class: 'drawer' });
  let done = false;
  let off = () => {};
  const close = () => {
    if (done) return;
    done = true;
    overlay.remove(); drawer.remove(); off();
    onClose();
  };
  overlay.addEventListener('click', close);
  off = closeOnEsc(close);
  document.body.append(overlay, drawer);
  return { drawer, close };
}

function timelineEl(ctx, acts, onDelete) {
  if (acts.length === 0) return h('div', { class: 'muted' }, 'No activity yet.');
  return h('ul', { class: 'timeline' }, acts.map((a) => h('li', null,
    h('div', { class: 'tl-ico', title: ctx.config.typeLabels[a.type] || a.type }, icon(TYPE_ICON[a.type] || 'clock', 14)),
    h('div', { class: 'tl-body' },
      h('div', null, h('b', null, ctx.config.typeLabels[a.type] || a.type), a.note ? ' · ' + a.note : ''),
      h('div', { class: 'tl-meta', title: a.created_at }, `${a.user_name} · ${fmtDateTime(a.created_at)} (${timeAgo(a.created_at)})`)),
    onDelete && a.id ? h('button', { class: 'ib', title: 'Remove this log (admin)', onclick: () => onDelete(a) }, icon('trash', 14)) : null)));
}

// track = { onLogged } turns on automatic profile-visit logging for the LinkedIn buttons.
function linksEl(l, links = [], track = null) {
  const mkLink = (cls, ic, text, href, title, kind) => {
    const a = h('a', { class: `btn ${cls}${href ? '' : ' off'}`, href: href || null, target: '_blank', rel: 'noopener', title: href ? title : 'Not available' }, icon(ic, 14), text);
    if (track && kind && href) watchVisit(a, l.id, kind, fullName(l), track.onLogged);
    return a;
  };
  const drive = links.find((x) => x.kind === 'drive');
  const gpt = links.find((x) => x.kind === 'chatgpt');
  return h('div', { class: 'linkrow' },
    mkLink('li', 'linkedin', 'LinkedIn profile', asUrl(l.linkedin), 'Open personal LinkedIn (visit is logged)', 'person'),
    mkLink('co', 'building', 'Company page', asUrl(l.company_linkedin), 'Open company LinkedIn (visit is logged)', 'company'),
    drive ? mkLink('drive', 'folder', 'Drive', drive.url, 'Open Google Drive') : null,
    gpt ? mkLink('gpt', 'sparkles', 'ChatGPT', gpt.url, 'Open ChatGPT chat') : null,
    mkLink('web', 'globe', 'Website', asUrl(l.website), 'Open website'),
    l.email ? mkLink('', 'mail', 'Email', 'mailto:' + l.email, 'Send email') : null,
    l.email ? h('button', { class: 'btn', onclick: () => copyText(l.email) }, icon('copy', 14), 'Copy email') : null);
}

export async function openLead(id, ctx, onChange = () => {}) {
  let changed = false; // refresh the list behind the drawer only if something was edited
  const { drawer, close } = shell(() => { if (changed) onChange(); });
  drawer.append(h('div', { class: 'empty' }, 'Loading…'));
  const closeAndNotify = close;

  async function load() {
    const { lead, fit, guide, activities, meetings, links } = await api('GET', `/api/leads/${id}`);
    draw(lead, activities, meetings, links, fit, guide);
  }

  async function save(patch, okMsg = 'Saved') {
    try {
      await api('PATCH', `/api/leads/${id}`, patch);
      changed = true;
      toast(okMsg);
      await load();
    } catch (e) { toast(e.message, true); await load(); }
  }

  // A lead in the recycle bin is read-only: restore it (or delete it forever) first.
  function drawTrashed(l, acts, meetings = [], links = []) {
    const admin = ctx.user.role === 'admin';
    const facts = [['Email', l.email], ['Phone', l.phone], ['Title', l.title], ['Company', l.company], ['Owner when deleted', l.owner_name], ['Stage', l.stage], ['Lead type', l.quality], ['Source', l.source]]
      .filter(([, v]) => v);
    drawer.replaceChildren(
      h('div', { class: 'drawer-head' },
        avatar(fullName(l), 44),
        h('div', { style: 'flex:1;min-width:0' },
          h('h2', null, fullName(l)),
          h('div', { class: 'muted' }, [l.title, l.company].filter(Boolean).join(' · ')),
          linksEl(l, links)),
        h('button', { class: 'btn small', onclick: close }, icon('x', 14), 'Close')),
      h('section', null,
        h('div', { class: 'binbanner' }, icon('trash', 18),
          h('div', { style: 'flex:1' }, h('b', null, 'In the recycle bin'),
            h('div', { class: 'muted' }, `Deleted by ${l.deleted_by_name || 'someone'} on ${fmtDateTime(l.deleted_at)}. It is hidden from Leads and can't be edited until restored.`))),
        admin ? h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn primary', onclick: async () => {
            try { await api('POST', '/api/leads/restore', { ids: [id] }); toast('Lead restored'); changed = true; await load(); } catch (e) { toast(e.message, true); }
          } }, icon('restore', 14), 'Restore lead'),
          h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(`Delete ${fullName(l)} forever? Their activity history is deleted too.\n\nThis cannot be undone.`)) return;
            try { await api('POST', '/api/leads/purge', { ids: [id] }); toast('Deleted forever'); changed = true; close(); } catch (e) { toast(e.message, true); }
          } }, icon('trash', 14), 'Delete forever')) : null),
      h('section', null, h('h3', null, 'Details'),
        h('div', { class: 'grid2' }, facts.map(([k, v]) => h('div', { class: 'field' }, h('label', null, k), h('div', null, v))))),
      h('section', null, h('h3', null, 'Activity history'), timelineEl(ctx, acts)));
  }

  async function mpatch(mid, body, msg = 'Meeting updated') {
    try { await api('PATCH', `/api/meetings/${mid}`, body); changed = true; toast(msg); } catch (e) { toast(e.message, true); }
    await load();
  }

  // ── meetings: list (editable) + "book a meeting" form ──
  function meetingsSection(l, meetings) {
    const { meetingStatuses } = ctx.config;
    const people = ctx.users.filter((u) => u.active);
    const today = todayStr();
    const list = meetings.length === 0 ? h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'No meetings yet.')
      : h('div', { class: 'mlist' }, meetings.map((m) => {
        const date = h('input', { type: 'date', value: m.scheduled_date, onchange: () => date.value && mpatch(m.id, { scheduled_date: date.value }, 'Rescheduled') });
        const time = h('input', { type: 'time', value: m.scheduled_time, onchange: () => mpatch(m.id, { scheduled_time: time.value }, 'Time saved') });
        const st = h('select', { class: 'mstat ' + m.status, onchange: () => mpatch(m.id, { status: st.value }, `Marked ${meetingStatuses[st.value].toLowerCase()}`) }, options(Object.entries(meetingStatuses)));
        st.value = m.status;
        const notes = h('input', { value: m.notes, placeholder: 'Notes / outcome', onchange: () => mpatch(m.id, { notes: notes.value }, 'Notes saved') });
        const late = m.status === 'booked' && m.scheduled_date < today;
        return h('div', { class: 'mrow' }, date, time, st, notes,
          ctx.user.role === 'admin' ? h('button', { class: 'ib del', title: 'Delete this meeting', onclick: async () => {
            if (!confirm('Delete this meeting? (Use "Cancelled" if it simply did not happen.)')) return;
            try { await api('DELETE', `/api/meetings/${m.id}`); changed = true; toast('Meeting deleted'); } catch (e) { toast(e.message, true); }
            await load();
          } }, icon('trash', 14)) : h('span'),
          h('div', { class: 'by' }, `Booked by ${m.booked_by_name || '—'} · ${fmtDateTime(m.created_at)}`,
            late ? h('b', { style: 'color:var(--warn);margin-left:8px' }, 'Date passed — mark it completed or cancelled') : null));
      }));

    const date = h('input', { type: 'date', value: today });
    const time = h('input', { type: 'time' });
    const by = h('select', null, people.map((u) => h('option', { value: u.id }, u.name)));
    by.value = String(l.owner_id && people.some((u) => u.id === l.owner_id) ? l.owner_id : ctx.user.id);
    const notes = h('input', { placeholder: 'Agenda / notes (optional)' });
    const book = h('button', { class: 'btn primary', onclick: async () => {
      if (!date.value) return toast('Pick a meeting date', true);
      book.disabled = true;
      try {
        await api('POST', `/api/leads/${id}/meetings`, { scheduled_date: date.value, scheduled_time: time.value, booked_by: Number(by.value), notes: notes.value });
        changed = true; toast('Meeting booked');
      } catch (e) { toast(e.message, true); }
      await load();
    } }, icon('calendar', 14), 'Book meeting');
    return h('section', null, h('h3', null, 'Meetings'), list,
      h('div', { class: 'mform' },
        h('div', { class: 'field' }, h('label', null, 'Date'), date),
        h('div', { class: 'field' }, h('label', null, 'Time'), time),
        h('div', { class: 'field' }, h('label', null, 'Booked by (counts for KPI)'), by),
        h('div', { class: 'field full' }, h('label', null, 'Notes'), notes),
        h('div', { class: 'full' }, book)));
  }

  // ── resource links: Drive, ChatGPT, anything else ──
  function linksSection(l, links) {
    const { linkKinds } = ctx.config;
    const KIND_ICON = { drive: 'folder', chatgpt: 'sparkles', other: 'link' };
    const list = links.length === 0 ? h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'No links yet — add a Google Drive folder, a ChatGPT chat or any URL.')
      : h('div', { class: 'reslist' }, links.map((k) => h('div', { class: 'res' },
        h('span', { class: 'ri ' + k.kind }, icon(KIND_ICON[k.kind] || 'link', 15)),
        h('a', { href: k.url, target: '_blank', rel: 'noopener' }, k.label || linkKinds[k.kind] || 'Link', h('span', { class: 'u' }, k.url)),
        h('button', { class: 'ib', title: 'Copy link', onclick: () => { copyText(k.url); toast('Link copied'); } }, icon('copy', 14)),
        h('button', { class: 'ib del', title: 'Remove link', onclick: async () => {
          try { await api('DELETE', `/api/leads/${id}/links/${k.id}`); changed = true; } catch (e) { toast(e.message, true); }
          await load();
        } }, icon('x', 14)))));
    const url = h('input', { placeholder: 'Paste a Drive / ChatGPT / any link' });
    const label = h('input', { placeholder: 'Label (optional)' });
    const kind = h('select', null, h('option', { value: '' }, 'Auto-detect'), ...Object.entries(linkKinds).map(([k, v]) => h('option', { value: k }, v)));
    const add = h('button', { class: 'btn', onclick: async () => {
      if (!url.value.trim()) return toast('Paste a link first', true);
      try { await api('POST', `/api/leads/${id}/links`, { url: url.value, label: label.value, kind: kind.value }); changed = true; toast('Link added'); }
      catch (e) { toast(e.message, true); return; }
      await load();
    } }, icon('plus', 14), 'Add');
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
    return h('section', null, h('h3', null, 'Links'), list, h('div', { class: 'resform' }, url, kind, label, add));
  }

  function draw(l, acts, meetings, links, fit, guide) {
    if (l.deleted_at) return drawTrashed(l, acts, meetings, links);
    const { stages, qualities, manualTypes } = ctx.config;
    const activeUsers = ctx.users.filter((u) => u.active);

    // ── pipeline (auto-saves on change) ──
    const owner = h('select', { value: l.owner_id ?? '', onchange: () => save({ owner_id: owner.value === '' ? null : Number(owner.value) }, 'Assignment saved') },
      h('option', { value: '' }, 'Unassigned'), ...activeUsers.map((u) => h('option', { value: u.id }, u.name)));
    if (l.owner_id && !activeUsers.some((u) => u.id === l.owner_id)) owner.append(h('option', { value: l.owner_id }, l.owner_name + ' (inactive)'));
    owner.value = l.owner_id ?? '';
    const stage = h('select', { value: l.stage, onchange: () => save({ stage: stage.value }) }, options(stages));
    const quality = h('select', { value: l.quality, onchange: () => save({ quality: quality.value }) }, options(qualities, { blank: 'Unrated' }));
    const nextAction = h('input', { value: l.next_action, placeholder: 'e.g. Send follow-up email' });
    const nextDate = h('input', { type: 'date', value: l.next_action_date });
    const saveNext = () => save({ next_action: nextAction.value, next_action_date: nextDate.value });
    nextDate.addEventListener('change', saveNext);
    nextAction.addEventListener('change', saveNext);

    const field = (label, input, full) => h('div', { class: 'field' + (full ? ' full' : '') }, h('label', null, label), input);

    // ── outreach (funnel + assessment); each control saves on change ──
    const { leadCategories = [], tiers = [], outreachStatuses = {}, channels = [] } = ctx.config;
    const dd = (key, list, blank) => {
      const s = h('select', { onchange: () => save({ [key]: s.value }) }, options(list, { blank }));
      s.value = l[key] || '';
      return s;
    };
    const txt = (key, placeholder, rows) => {
      const t = rows ? h('textarea', { rows, placeholder }) : h('input', { placeholder });
      t.value = l[key] || '';
      t.addEventListener('change', () => save({ [key]: t.value }));
      return t;
    };
    const dt = (key) => { const i = h('input', { type: 'date', value: l[key] || '' }); i.addEventListener('change', () => save({ [key]: i.value })); return i; };
    const outreachSection = h('section', null, h('h3', null, 'Outreach & opportunity'),
      h('div', { class: 'grid2' },
        field('Lead category', dd('lead_category', leadCategories, 'Not set')), field('Tier', dd('tier', tiers, 'Not set')),
        field('Outreach status', dd('outreach_status', Object.entries(outreachStatuses), 'Not set')), field('Channel', dd('channel', channels, 'Not set')),
        field('Invite sent', dt('invite_sent_date')), field('Accepted', dt('accepted_date')),
        field('First DM', dt('first_dm_date')), field('Problem pool', txt('problem_pool', 'e.g. Delivery & tracking')),
        field('Why in pipeline', txt('why_in_pipeline', 'One line: why this person'), true),
        field("Today's question", txt('todays_question', 'The one question to ask'), true),
        field('Denial reason', txt('denial_reason', 'If they said no, why'), true),
        field('Opportunity assessment (after research)', txt('assessment', 'Table summary, key distinction, recommended reply', 4), true)));


    // ── details (explicit save) ──
    const inputs = {};
    const details = h('div', { class: 'grid2' }, DETAIL_FIELDS.map(([k, label, full]) => {
      inputs[k] = h('input', { value: l[k] });
      return field(label, inputs[k], full);
    }));
    const notes = h('textarea', { rows: 3, placeholder: 'Background, context, anything useful…' });
    notes.value = l.notes;
    const saveDetails = h('button', { class: 'btn', onclick: () => {
      const patch = {};
      for (const [k] of DETAIL_FIELDS) if (inputs[k].value.trim() !== l[k]) patch[k] = inputs[k].value;
      if (notes.value.trim() !== l.notes) patch.notes = notes.value;
      if (!Object.keys(patch).length) return toast('No changes');
      save(patch, 'Details saved');
    } }, 'Save details');

    // ── log activity ──
    let type = 'call';
    const note = h('textarea', { rows: 2, placeholder: 'What happened? (optional for calls/emails)' });
    const mkBtn = (k) => {
      const b = h('button', { class: 'btn small' + (k === type ? ' on' : ''), type: 'button', onclick: () => {
        type = k;
        typeBtns.querySelectorAll('.btn').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      } }, icon(TYPE_ICON[k] || 'note', 14), manualTypes[k]);
      return b;
    };
    const general = Object.keys(manualTypes).filter((k) => !k.startsWith('linkedin_'));
    const typeBtns = h('div', { class: 'typebtns' },
      general.map(mkBtn),
      h('div', { class: 'grp' }, 'LinkedIn'),
      ctx.config.linkedinTypes.map(mkBtn));
    const logBtn = h('button', { class: 'btn primary', onclick: async () => {
      try {
        logBtn.disabled = true;
        const r = await api('POST', `/api/leads/${id}/activities`, { type, note: note.value });
        if (r?.duplicate) { toast('Already logged (same action today or just now), not added again'); logBtn.disabled = false; return; }
        changed = true;
        toast('Logged');
        await load();
      } catch (e) { toast(e.message, true); logBtn.disabled = false; }
    } }, 'Log activity');

    const timeline = timelineEl(ctx, acts, ctx.user.role === 'admin' ? async (a) => {
      if (!confirm(`Remove this log?\n\n${ctx.config.typeLabels[a.type] || a.type} by ${a.user_name}, ${fmtDateTime(a.created_at)}\n\nIt will stop counting in the reports.`)) return;
      try { await api('DELETE', `/api/leads/${id}/activities/${a.id}`); changed = true; toast('Log removed'); await load(); } catch (e) { toast(e.message, true); }
    } : null);
    const linkRow = linksEl(l, links, { onLogged: () => { changed = true; load(); } });

    drawer.replaceChildren(
      h('div', { class: 'drawer-head' },
        avatar(fullName(l), 44),
        h('div', { style: 'flex:1;min-width:0' },
          h('h2', null, fullName(l)),
          h('div', { class: 'muted' }, [l.title, l.company].filter(Boolean).join(' · ')),
          h('div', { class: 'row', style: 'margin-top:6px' }, pill(l.stage, 's'), pill(l.quality, 'q'), l.owner_name ? h('span', { class: 'muted' }, 'Owner: ' + l.owner_name) : null),
          linkRow),
        h('div', { class: 'col', style: 'gap:6px;align-items:flex-end;flex-shrink:0' },
          h('button', { class: 'btn small', onclick: closeAndNotify }, icon('x', 14), 'Close'),
          aiBtn(id))),
      guide && guide.kind !== 'none' ? h('section', { class: 'nextbox' + (guide.late_days ? ' late' : '') },
        h('h3', null, 'Next step'),
        h('div', { class: 'next-act' }, guide.action, guide.channel ? h('span', { class: 'next-ch' }, guide.channel) : null),
        h('div', { class: 'sub' }, guide.why + (guide.due ? ` · due ${guide.due}${guide.late_days ? ` (${guide.late_days} days late)` : ''}` : '')),
        guide.how?.length ? h('ol', { class: 'next-how' }, guide.how.map((x) => h('li', null, x))) : null,
        guide.dont?.length ? h('div', { class: 'next-dont' }, guide.dont.map((x) => h('div', null, '✗ ' + x))) : null,
        h('div', { class: 'sub' }, 'A suggestion from the follow-up schedule and this lead\'s history. Log what you did below.')) : null,
      fit ? h('section', { class: 'fitbox ' + (fit.suggest === 'skip' ? 'red' : fit.suggest === 'good' ? 'green' : 'amber') },
        h('h3', null, 'Fit check (a suggestion, please verify)'),
        h('div', { class: 'fit-line' }, h('span', { class: 'fitchip ' + fit.size_tone }, 'Size'), fit.size_text),
        h('div', { class: 'fit-line' }, h('span', { class: 'fitchip ' + fit.auth_tone }, 'Title'), fit.auth_text),
        h('div', { class: 'fit-say' }, h('b', null, { skip: 'Suggest SKIP', nurture: 'Suggest NURTURE', qualify: 'Suggest QUALIFY', good: 'Looks good' }[fit.suggest]), ': ' + fit.why),
        h('div', { class: 'sub' }, 'Based on the headcount and job title recorded in the CRM (they may be old). Nothing changes until you decide.')) : null,
      h('section', null, h('h3', null, 'Pipeline'),
        h('div', { class: 'grid2' },
          field('Owner', owner), field('Stage', stage),
          field('Lead type', quality), field('', h('span')),
          field('Next action', nextAction), field('Next action date', nextDate))),
      outreachSection,
      meetingsSection(l, meetings),
      linksSection(l, links),
      h('section', null, h('h3', null, 'Log activity'), typeBtns, note, h('div', { style: 'margin-top:8px' }, logBtn)),
      h('section', null, h('h3', null, 'Activity history'), timeline),
      h('section', null, h('h3', null, 'Details'), details,
        h('div', { class: 'field', style: 'margin-top:10px' }, h('label', null, 'Notes'), notes),
        h('div', { class: 'row', style: 'margin-top:10px' }, saveDetails,
          h('span', { class: 'muted' }, `Imported ${fmtDateTime(l.created_at)}${l.source ? ' from ' + l.source : ''}`),
          h('div', { class: 'spacer' }),
          ctx.user.role === 'admin' ? h('button', { class: 'btn danger', title: 'Moves the lead to the recycle bin', onclick: async () => {
            try { await api('DELETE', `/api/leads/${id}`); toast('Moved to recycle bin'); changed = true; close(); } catch (e) { toast(e.message, true); }
          } }, icon('trash', 14), 'Delete lead') : null)),
    );
  }

  try { await load(); } catch (e) { toast(e.message, true); close(); }
}

export function openNewLead(ctx, onCreated) {
  const { drawer, close } = shell();
  const fields = [['first_name', 'First name'], ['last_name', 'Last name'], ['title', 'Title'], ['company', 'Company'],
    ['email', 'Email'], ['linkedin', 'LinkedIn'], ['phone', 'Phone'], ['website', 'Website']];
  const inputs = Object.fromEntries(fields.map(([k]) => [k, h('input')]));
  const owner = h('select', { value: ctx.user.id }, ctx.users.filter((u) => u.active).map((u) => h('option', { value: u.id }, u.name)));
  owner.value = ctx.user.id;
  const create = h('button', { class: 'btn primary', onclick: async () => {
    const body = Object.fromEntries(fields.map(([k]) => [k, inputs[k].value]));
    body.owner_id = Number(owner.value);
    try {
      const { id, existing, restored, filled } = await api('POST', '/api/leads', body);
      toast(existing ? `Already in the CRM — ${filled.length ? 'updated: ' + filled.join(', ') : 'nothing new to add'}${restored ? ' (restored from recycle bin)' : ''}` : 'Lead added');
      close();
      onCreated();
      openLead(id, ctx, onCreated);
    } catch (e) { toast(e.message, true); }
  } }, 'Add lead');
  drawer.append(
    h('div', { class: 'drawer-head' }, h('h2', { style: 'flex:1' }, 'Add lead'), h('button', { class: 'btn small', onclick: close }, 'Close')),
    h('section', null, h('div', { class: 'grid2' },
      fields.map(([k, label]) => h('div', { class: 'field' }, h('label', null, label), inputs[k])),
      h('div', { class: 'field' }, h('label', null, 'Owner'), owner)),
      h('div', { style: 'margin-top:14px' }, create)));
  inputs.first_name.focus();
}

// One button per lead. The AI setup (rules) is copied once from the Playbook page.
function aiBtn(id) {
  const b = h('button', { class: 'btn small primary', title: 'Paste this lead into your AI chat (set the chat up once from the Playbook page)' }, icon('copy', 14), 'Copy lead for AI');
  b.onclick = async () => {
    try {
      b.disabled = true;
      const r = await api('GET', `/api/leads/${id}/ai-prompt`);
      await copyPlain(r.prompt);
      toast(`Lead copied (${Math.round(r.chars / 1000)}k characters). Paste it in your AI chat.`);
    } catch (e) { toast(e.message, true); }
    b.disabled = false;
  };
  return b;
}
async function copyPlain(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
}
