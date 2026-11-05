import { api, qs } from '../api.js';
import { h, fill, toast, asUrl } from '../util.js';
import { openLead } from './lead-drawer.js';
import { icon } from '../icons.js';

// The follow-up work (cards with the exact next action) and the stale pile. Shown inside the Leads page.
const KIND_TONE = { reply: 'hot', first_message: 'hot', followup: 'warm', email: 'warm', check_invite: 'cool', scheduled: 'cool', no_email: 'muted', research: 'muted', last_followup: 'muted' };

// What the buttons on a lead card do. First entry is the main action.
const BUTTONS = {
  reply: [['sent', 'I replied', 'primary', { kind: 'reply' }], ['snooze', 'Later', ''], ['nurture', 'Nurture', '']],
  first_message: [['sent', 'First message sent', 'primary', { kind: 'first_message' }], ['snooze', 'Later', '']],
  followup: [['sent', 'Follow-up sent', 'primary', { kind: 'followup' }], ['replied', 'They replied', ''], ['seen', 'Seen, no reply', ''], ['snooze', 'Later', '']],
  last_followup: [['sent', 'Last follow-up sent', 'primary', { kind: 'last_followup' }], ['replied', 'They replied', ''], ['nurture', 'Nurture', '']],
  email: [['sent', 'Email sent', 'primary', { kind: 'email' }], ['accepted', 'They accepted', ''], ['snooze', 'Later', '']],
  check_invite: [['accepted', 'Accepted', 'primary'], ['pending', 'Still pending', ''], ['snooze', 'Later', '']],
  scheduled: [['sent', 'Message sent', 'primary', { kind: 'followup' }], ['replied', 'They replied', ''], ['accepted', 'Accepted', ''], ['snooze', 'Later', '']],
  no_email: [['sent', 'Commented / form sent', 'primary', { kind: 'email' }], ['accepted', 'They accepted', ''], ['snooze', 'Later', '']],
  research: [['snooze', 'Later', ''], ['nurture', 'Nurture', ''], ['not_interested', 'Not a fit', '']],
};
const DONE_TEXT = { comment: 'Comment logged', sent: 'Logged as sent', accepted: 'Marked accepted', pending: 'Still pending, back in 3 days', seen: 'Marked seen, no reply', replied: 'Marked replied', nurture: 'Moved to nurture', not_interested: 'Closed', snooze: 'Pushed to tomorrow' };


// Fills `root` with the follow-ups or the stale pile for one person. onChange runs after anything is saved.
export async function renderFollowups(root, ctx, { assignee, view, onChange }) {
  const d = await api('GET', '/api/plan?' + qs({ day: 'today', assignee }));
  const m = d.members[0];
  if (!m) { fill(root, h('div', { class: 'card empty' }, 'Nobody to show.')); return null; }
  // ── lead actions ───────────────────────────────────────────────────────────
  function actions(m, d) {
    const box = h('div', { class: 'card pcard' }, h('div', { class: 'pc-title' }, icon('users', 16), h('h3', null, 'Lead actions'), h('span', { class: 'muted' }, 'most valuable first')));
    if (!m.actions.length) {
      box.append(h('div', { class: 'empty' }, d.is_today ? 'No lead actions due. Log invites and messages and the next steps appear here.' : 'Nothing due for this day yet.'));
      return box;
    }
    for (const a of m.actions) box.append(actionCard(a, d));
    if (m.summary.carry_over) box.append(h('div', { class: 'carry' }, `+${m.summary.carry_over} more are waiting. They appear as you finish these (${d.daily_cap} per day keeps the day realistic).`));
    return box;
  }

  function actionCard(a, d) {
    const card = h('div', { class: 'act' });
    const said = h('input', { class: 'said', placeholder: 'What did you write? Message or comment text (goes into your end-of-day report)' });
    const run = async (result, extra) => {
      card.classList.add('busy');
      try {
        await api('POST', `/api/leads/${a.id}/step`, { result, note: said.value, ...(extra || {}) });
        toast(`${a.name}: ${DONE_TEXT[result]}`);
        card.classList.add('gone');
        setTimeout(() => onChange(), 250);
      } catch (e) { card.classList.remove('busy'); toast(e.message, true); }
    };
    const btns = (BUTTONS[a.kind] || BUTTONS.scheduled).map(([result, text, style, extra]) =>
      h('button', { class: 'btn small' + (style ? ' ' + style : ''), onclick: (ev) => { ev.stopPropagation(); run(result, extra); } }, text));
    const links = [
      a.linkedin ? h('a', { class: 'plink', href: asUrl(a.linkedin), target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, 'LinkedIn ↗') : null,
      a.email ? h('a', { class: 'plink', href: 'mailto:' + a.email, onclick: (e) => e.stopPropagation() }, a.email) : null,
    ].filter(Boolean);
    const late = a.late_days > 0 ? `${a.late_days}d late` : 'due';
    fill(card,
      h('div', { class: 'act-top', onclick: () => openLead(a.id, ctx, () => onChange()) },
        h('div', { class: 'act-who' }, h('div', { class: 'nm' }, a.name, a.pursue ? h('span', { class: 'tier tA' }, 'PURSUE') : null, a.tier ? h('span', { class: 'tier t' + a.tier }, a.tier) : null), h('div', { class: 'sub' }, [a.title, a.company].filter(Boolean).join(' · '))),
        h('div', { class: 'act-meta' }, h('span', { class: 'kind ' + (KIND_TONE[a.kind] || '') }, a.verb), h('span', { class: 'sub' + (a.late_days > 3 ? ' due' : '') }, `${a.reason} · ${late}`))),
      a.detail && a.kind !== 'reply' ? h('div', { class: 'act-detail' }, a.detail) : null,
      a.question ? h('div', { class: 'act-ask' }, 'Ask: ' + a.question) : null,
      said,
      h('div', { class: 'act-btns' }, ...btns, h('button', { class: 'btn small', title: 'Log a comment on one of their posts', onclick: (ev) => { ev.stopPropagation(); run('comment'); } }, 'Commented'), h('div', { class: 'spacer' }), ...links));
    return card;
  }

  function stalePile(m) {
    const box = h('div', { class: 'card pcard stale' }, h('div', { class: 'pc-title' }, icon('clock', 16), h('h3', null, `${m.summary.stale} stale leads`), h('span', { class: 'muted' }, 'more than 14 days late')));
    if (!m.stale.length) { box.append(h('div', { class: 'empty' }, 'No stale leads. Nothing is more than 14 days behind.')); return box; }
    const bulk = async (result) => {
      if (!confirm(`${result === 'nurture' ? 'Move to nurture' : 'Close'} all ${m.stale.length} stale leads? They leave the daily plan.`)) return;
      let n = 0;
      for (const x of m.stale) { try { await api('POST', `/api/leads/${x.id}/step`, { result }); n++; } catch { /* skip */ } }
      toast(`${n} stale leads ${result === 'nurture' ? 'moved to nurture' : 'closed'}`);
      onChange();
    };
    box.append(
      h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'These steps were missed long ago, so they are not follow-ups any more. Nurture = like and comment on their posts and check back in 30 days. Close = not interested.'),
      h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'btn primary small', onclick: () => bulk('nurture') }, `Nurture all ${m.stale.length}`), h('button', { class: 'btn small', onclick: () => bulk('not_interested') }, `Close all ${m.stale.length}`)));
    for (const x of m.stale.slice(0, 100)) {
      const row = h('div', { class: 'stale-row' });
      const one = async (result) => { try { await api('POST', `/api/leads/${x.id}/step`, { result }); row.remove(); toast(`${x.name}: ${DONE_TEXT[result]}`); onChange(); } catch (e) { toast(e.message, true); } };
      fill(row, h('div', { style: 'cursor:pointer;min-width:0', onclick: () => openLead(x.id, ctx, () => onChange()) }, h('div', { class: 'nm' }, x.name), h('div', { class: 'sub' }, [x.title, x.company].filter(Boolean).join(' · ')), h('div', { class: 'sub due' }, `${x.verb} · ${x.late_days}d late`)),
        h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('button', { class: 'btn small', onclick: () => one('nurture') }, 'Nurture'), h('button', { class: 'btn small', onclick: () => one('not_interested') }, 'Close')));
      box.append(row);
    }
    if (m.stale.length > 100) box.append(h('div', { class: 'carry' }, `…and ${m.stale.length - 100} more (the bulk buttons cover all ${m.stale.length}).`));
    return box;
  }


  fill(root, view === 'stale' ? stalePile(m) : actions(m, d));
  return m.summary;
}

// Just the two counts, for the tab labels.
export async function followupCounts(assignee) {
  const d = await api('GET', '/api/plan?' + qs({ day: 'today', assignee }));
  const m = d.members[0];
  return m ? { actions: m.summary.actions, stale: m.summary.stale } : { actions: 0, stale: 0 };
}
