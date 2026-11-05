import { api, qs } from '../api.js';
import { h, fill, toast, avatar, asUrl, pref } from '../util.js';
import { openLead } from './lead-drawer.js';
import { icon } from '../icons.js';

// The daily plan: what each person has to do (and exactly which action to take on each lead),
// how leads are responding, and what was achieved. After 12:00 it opens on the next working day.
const state = { day: '', assignee: '', view: 'queue', _init: false };
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' });

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

export async function render(root, ctx) {
  const isAdmin = ctx.user.role === 'admin';
  if (!state._init) { state._init = true; state.assignee = pref.get(ctx.user.id, 'plan.assignee', ''); state.view = pref.get(ctx.user.id, 'plan.view', 'queue'); }
  const body = h('div');
  const chips = h('div', { class: 'chips', style: 'margin-bottom:14px' });
  const tabs = h('div', { class: 'seg' });
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Plan'), h('div', { class: 'muted', id: 'plan-sub' }, '')), h('div', { class: 'spacer' }), tabs);
  const banner = h('div');
  root.replaceChildren(head, banner, chips, body);

  async function load(keepScroll) {
    const y = window.scrollY;
    pref.set(ctx.user.id, 'plan.assignee', state.assignee); pref.set(ctx.user.id, 'plan.view', state.view);
    try {
      const d = await api('GET', '/api/plan?' + qs({ day: state.day, assignee: state.assignee }));
      draw(d);
      if (keepScroll) window.scrollTo(0, y);
    } catch (e) { toast(e.message, true); }
  }

  function draw(d) {
    const label = d.is_today ? 'Today' : 'Tomorrow';
    head.querySelector('#plan-sub').textContent = `${label}: ${nice(d.date)}${d.working_day ? '' : ' · day off'}`;
    const t = (key, text) => h('button', { class: 'segb' + ((state.day || (d.after_noon ? 'tomorrow' : 'today')) === key ? ' on' : ''), onclick: () => { state.day = key; load(); } }, text);
    tabs.replaceChildren(t('today', 'Today'), t('tomorrow', d.skipped_friday ? 'Next working day' : 'Tomorrow'));
    fill(banner,
      d.after_noon && !state.day ? h('div', { class: 'note-bar' }, icon('clock', 16), h('span', null, `It is past 12:00, so this is the plan for ${nice(d.tomorrow)}${d.skipped_friday ? ' (Friday is a day off)' : ''}. `), h('button', { class: 'linkbtn', onclick: () => { state.day = 'today'; load(); } }, 'Show what is left for today')) : null,
      !d.is_today ? h('div', { class: 'note-bar soft' }, 'Planned from what is due and what carries over from today. It updates as you finish today\'s work.') : null);
    const meId = ctx.user.id;
    const people = d.members;
    const mkChip = (v, text) => h('button', { class: 'chip noav' + ((state.assignee || (isAdmin ? 'all' : 'me')) === v ? ' on' : ''), onclick: () => { state.assignee = v; load(); } }, text);
    chips.replaceChildren(mkChip('me', 'Mine'), ...(isAdmin ? [mkChip('all', 'Everyone')] : []), ...ctx.users.filter((u) => u.active && u.id !== meId).map((u) => mkChip(String(u.id), u.name)));
    body.replaceChildren(...(people.length ? people.map((m) => member(m, d)) : [h('div', { class: 'card empty' }, 'Nobody to show.')]));
  }

  function member(m, d) {
    const s = m.summary;
    const tile = (num, text, tone) => h('div', { class: 'ptile ' + (tone || '') }, h('div', { class: 'pnum' }, String(num)), h('div', { class: 'plab' }, text));
    const tgtPct = m.targets.length ? Math.round(m.targets.reduce((a, x) => a + Math.min(x.done, x.target), 0) / m.targets.reduce((a, x) => a + x.target, 0) * 100) : null;
    return h('section', { class: 'plan-member' },
      h('div', { class: 'plan-head' }, avatar(m.name, 40), h('div', null, h('h2', null, m.name), h('div', { class: 'muted' }, `${s.actions} lead action${s.actions === 1 ? '' : 's'} · ${s.tasks} task${s.tasks === 1 ? '' : 's'}`)),
        h('div', { class: 'spacer' }),
        h('div', { class: 'ptiles' },
          tile(s.shown, 'lead actions' + (s.carry_over ? ` (+${s.carry_over} later)` : ''), s.shown ? 'on' : ''),
          tile(`${s.tasks_done}/${s.tasks}`, 'team tasks'),
          tile(tgtPct == null ? '–' : tgtPct + '%', 'daily target'),
          tile(m.responses.counts.replied, 'replies waiting', m.responses.counts.replied ? 'hot' : ''))),
      h('div', { class: 'plan-cols' },
        h('div', { class: 'plan-main' }, viewTabs(m), state.view === 'stale' ? stalePile(m, true) : state.view === 'review' ? reviewList(m) : actions(m, d)),
        h('div', { class: 'plan-side' }, targets(m, d), tasks(m, d), responses(m), achieved(m))));
  }

  function viewTabs(m) {
    const b = (key, text) => h('button', { class: 'segb' + (state.view === key ? ' on' : ''), onclick: () => { state.view = key; load(true); } }, text);
    return h('div', { class: 'seg', style: 'align-self:flex-start' }, b('queue', `Today's queue (${m.summary.actions})`), b('review', 'Profile review list'), b('stale', `Stale: close or nurture (${m.summary.stale})`));
  }

  // ── profile review list: exactly which profiles to open to reach today's profile-review target ──
  function reviewList(m) {
    const box = h('div', { class: 'card pcard' }, h('div', { class: 'pc-title' }, icon('users', 16), h('h3', null, 'Profile review list'), h('span', { class: 'muted' }, 'untouched leads, best tier first')));
    const list = h('div', null, h('div', { class: 'muted' }, 'Loading…'));
    box.append(list);
    api('GET', '/api/plan/review?' + qs({ assignee: String(m.user_id) })).then((r) => {
      const head = h('div', { class: 'revhead' },
        h('b', null, `${r.done} of ${r.target} profiles reviewed today`),
        h('span', { class: 'muted' }, r.pool > r.rows.length ? `${r.pool.toLocaleString()} untouched leads in your pool, showing the next ${r.rows.length}` : `${r.rows.length} left in your pool`));
      if (!r.rows.length) { fill(list, head, h('div', { class: 'empty' }, r.target && r.done >= r.target ? 'Target reached. Nice work.' : 'No untouched leads with a LinkedIn link. Ask the admin for more leads.')); return; }
      const how = h('div', { class: 'muted', style: 'margin:6px 0 10px' }, 'Click Open profile. The view is logged for you and the lead drops off this list. Work top to bottom.');
      const rowEl = (l) => {
        const row = h('div', { class: 'revrow' },
          h('div', { style: 'min-width:0' }, h('b', null, `${l.first_name} ${l.last_name}`.trim() || l.company), l.tier ? h('span', { class: 'tier t' + l.tier }, l.tier) : null,
            h('div', { class: 'muted', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, [l.title, l.company].filter(Boolean).join(' · '))),
          h('a', { class: 'btn small primary', href: asUrl(l.linkedin), target: '_blank', rel: 'noopener', onclick: () => {
            api('POST', `/api/leads/${l.id}/visit`, { kind: 'profile' }).then(() => { row.classList.add('gone'); setTimeout(() => load(true), 600); }).catch(() => {});
          } }, 'Open profile ↗'));
        return row;
      };
      fill(list, head, how, ...r.rows.map(rowEl));
    }).catch((e) => fill(list, h('div', { class: 'empty' }, e.message)));
    return box;
  }

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
        setTimeout(() => load(true), 250);
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
      h('div', { class: 'act-top', onclick: () => openLead(a.id, ctx, () => load(true)) },
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
      load(true);
    };
    box.append(
      h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'These steps were missed long ago, so they are not follow-ups any more. Nurture = like and comment on their posts and check back in 30 days. Close = not interested.'),
      h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'btn primary small', onclick: () => bulk('nurture') }, `Nurture all ${m.stale.length}`), h('button', { class: 'btn small', onclick: () => bulk('not_interested') }, `Close all ${m.stale.length}`)));
    for (const x of m.stale.slice(0, 100)) {
      const row = h('div', { class: 'stale-row' });
      const one = async (result) => { try { await api('POST', `/api/leads/${x.id}/step`, { result }); row.remove(); toast(`${x.name}: ${DONE_TEXT[result]}`); load(true); } catch (e) { toast(e.message, true); } };
      fill(row, h('div', { style: 'cursor:pointer;min-width:0', onclick: () => openLead(x.id, ctx, () => load(true)) }, h('div', { class: 'nm' }, x.name), h('div', { class: 'sub' }, [x.title, x.company].filter(Boolean).join(' · ')), h('div', { class: 'sub due' }, `${x.verb} · ${x.late_days}d late`)),
        h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('button', { class: 'btn small', onclick: () => one('nurture') }, 'Nurture'), h('button', { class: 'btn small', onclick: () => one('not_interested') }, 'Close')));
      box.append(row);
    }
    if (m.stale.length > 100) box.append(h('div', { class: 'carry' }, `…and ${m.stale.length - 100} more (the bulk buttons cover all ${m.stale.length}).`));
    return box;
  }

  // ── side panels ────────────────────────────────────────────────────────────
  function targets(m, d) {
    const box = h('div', { class: 'card pcard' }, h('div', { class: 'pc-title' }, icon('target', 16), h('h3', null, d.is_today ? 'Daily targets' : 'Target for the day')));
    if (!m.targets.length) { box.append(h('div', { class: 'muted' }, 'No targets set.')); return box; }
    for (const x of m.targets) {
      const pct = Math.min(100, Math.round((x.done / x.target) * 100));
      box.append(h('div', { class: 'tg' }, h('div', { class: 'tg-row' }, h('span', null, x.label), h('b', null, d.is_today ? `${x.done} / ${x.target}` : String(x.target))),
        d.is_today ? h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill ' + (pct >= 100 ? 'ok' : pct >= 60 ? 'mid' : 'low'), style: `width:${pct}%` })) : null));
    }
    return box;
  }

  function tasks(m, d) {
    const box = h('div', { class: 'card pcard' }, h('div', { class: 'pc-title' }, icon('listCheck', 16), h('h3', null, 'Team tasks'), h('span', { class: 'muted' }, `${m.summary.tasks_done}/${m.summary.tasks}`)));
    if (!m.tasks.length) { box.append(h('div', { class: 'muted' }, d.working_day ? 'No tasks scheduled.' : 'Day off.')); return box; }
    for (const t of m.tasks) {
      const cb = h('input', { type: 'checkbox', checked: t.done });
      cb.disabled = !d.is_today;
      cb.addEventListener('change', async () => { try { await api('POST', `/api/tasks/${t.id}/done`, { done: cb.checked, day: d.date }); load(true); } catch (e) { cb.checked = !cb.checked; toast(e.message, true); } });
      box.append(h('label', { class: 'ptask' + (t.done ? ' done' : '') }, cb, h('div', null, h('div', { class: 'tt' }, t.title), h('div', { class: 'sub' }, [t.window, t.priority].filter(Boolean).join(' · ')))));
    }
    return box;
  }

  function responses(m) {
    const c = m.responses.counts;
    const box = h('div', { class: 'card pcard' }, h('div', { class: 'pc-title' }, icon('inbox', 16), h('h3', null, 'How leads are responding')));
    const row = (n, text, tone, help, list) => h('div', { class: 'resp ' + tone },
      h('div', { class: 'resp-top' }, h('span', { class: 'resp-n' }, String(n)), h('div', null, h('b', null, text), h('div', { class: 'sub' }, help))),
      list.length ? h('div', { class: 'resp-list' }, list.map((x) => h('button', { class: 'rl', onclick: () => openLead(x.id, ctx, () => load(true)) }, x.name, h('span', { class: 'sub' }, ` ${x.days}d`)))) : null);
    box.append(
      row(c.replied, 'Replied', 'hot', 'Answer these first, within the day.', m.responses.replied),
      row(c.seen_no_reply, 'Seen, no reply', 'warm', 'They read it. Send a new-angle follow-up or engage with a post.', m.responses.seen_no_reply),
      row(c.unseen, 'Messaged, unseen', 'cool', 'Not opened yet. Like or comment so they notice you, then wait.', m.responses.unseen),
      h('div', { class: 'resp' }, h('div', { class: 'resp-top' }, h('span', { class: 'resp-n' }, String(c.pending_invites)), h('div', null, h('b', null, 'Invites pending'), h('div', { class: 'sub' }, 'Not accepted yet. Checked on day 7, emailed on day 8.')))));
    if (!c.messaged && !c.pending_invites && !c.replied) box.append(h('div', { class: 'muted' }, 'Responses show up here once messages go out.'));
    return box;
  }

  function achieved(m) {
    const a = m.achieved;
    const cell = (x, k) => h('td', null, String(x[k]));
    const cols = [['invites', 'Invites'], ['accepted', 'Accepted'], ['messages', 'Messages'], ['emails', 'Emails'], ['replies', 'Replies'], ['meetings', 'Meetings']];
    return h('div', { class: 'card pcard' }, h('div', { class: 'pc-title' }, icon('chart', 16), h('h3', null, 'Achieved')),
      h('table', { class: 'ach' }, h('thead', null, h('tr', null, h('th', null, ''), cols.map(([, l]) => h('th', null, l)))),
        h('tbody', null, h('tr', null, h('th', null, 'Today'), cols.map(([k]) => cell(a.today, k))), h('tr', null, h('th', null, 'This week'), cols.map(([k]) => cell(a.week, k))))));
  }

  await load();
}
