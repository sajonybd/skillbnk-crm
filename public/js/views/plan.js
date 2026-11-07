import { api, qs } from '../api.js';
import { h, fill, toast, avatar, asUrl, pref } from '../util.js';
import { openLead } from './lead-drawer.js';
import { icon } from '../icons.js';
import { renderMd } from './reports.js';

// The daily plan: what each person has to do (and exactly which action to take on each lead),
// how leads are responding, and what was achieved. After 6 pm it opens on the next working day.
const state = { day: '', assignee: '', view: 'queue', _init: false };
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' });

export async function render(root, ctx) {
  const isAdmin = ctx.user.role === 'admin';
  if (!state._init) { state._init = true; state.assignee = pref.get(ctx.user.id, 'plan.assignee', ''); state.view = pref.get(ctx.user.id, 'plan.view', 'queue'); if (state.view !== 'stale') state.view = 'queue'; }
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
      try {
        const wp = await api('GET', '/api/reports/plan?' + qs({ assignee: state.assignee || (isAdmin ? 'all' : 'me'), date: d.date }));
        d._wp = Object.fromEntries((wp.items || []).map((x) => [x.user_id, x]));
      } catch { d._wp = {}; }
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
      d.after_noon && !state.day ? h('div', { class: 'note-bar' }, icon('clock', 16), h('span', null, `It is past 6 pm, so this is the plan for ${nice(d.tomorrow)}${d.skipped_friday ? ' (Friday is a day off)' : ''}. `), h('button', { class: 'linkbtn', onclick: () => { state.day = 'today'; load(); } }, 'Show what is left for today')) : null,
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
      h('div', { class: 'plan-head' }, avatar(m.name, 40), h('div', null, h('h2', null, m.name), h('div', { class: 'muted' }, `${s.actions} follow-up${s.actions === 1 ? '' : 's'} · ${s.tasks} task${s.tasks === 1 ? '' : 's'}`)),
        h('div', { class: 'spacer' }),
        h('div', { class: 'ptiles' },
          tile(s.shown, 'follow-ups' + (s.carry_over ? ` (+${s.carry_over} later)` : '') + (s.stale ? ` · ${s.stale} stale` : ''), s.shown ? 'on' : ''),
          tile(`${s.tasks_done}/${s.tasks}`, 'team tasks'),
          tile(tgtPct == null ? '–' : tgtPct + '%', 'daily target'),
          tile(m.responses.counts.replied, 'replies waiting', m.responses.counts.replied ? 'hot' : ''))),
      workplan(m, d),
      h('div', { class: 'plan-cols' },
        h('div', { class: 'plan-main' }, tasks(m, d), responses(m)),
        h('div', { class: 'plan-side' }, targets(m, d), achieved(m))),
      h('div', { class: 'muted', style: 'margin-top:10px' }, 'Follow-ups, research and engagement are on the ', h('a', { href: '#/leads' }, 'Leads'), ' page.'));
  }

  // The same work plan as Reports → Daily work plan (copy leaves the tables out).
  function workplan(m, d) {
    const it = (d._wp || {})[m.user_id || m.id];
    if (!it) return null;
    const copy = async () => {
      try { await navigator.clipboard.writeText(it.copy); } catch { const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = it.copy; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
      toast('Work plan copied. Paste it anywhere.');
    };
    const doc = renderMd(it.md.split('\n').slice(1).join('\n'));
    return h('div', { class: 'card pcard', style: 'margin-bottom:12px' },
      h('div', { class: 'pc-title' }, icon('listCheck', 16), h('h3', null, 'Work plan'), h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: copy }, icon('inbox', 15), 'Copy')),
      doc);
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
