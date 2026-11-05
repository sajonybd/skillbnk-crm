import { Router } from 'express';
import { TARGET_METRICS, TZ_OFFSET_MIN, PLAN_SWITCH_HOUR } from '../config.js';
import { todayLocal, addDays, weekStart } from '../lib/kpi.js';
import { nextStep, KINDS, clean } from '../lib/cadence.js';
import { getRules, capFor } from '../lib/rules.js';
import { isWorkingDay } from '../lib/taskdays.js';
import { WORK_CASE } from '../lib/work.js';
import { tasksOn } from './tasks.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIER_RANK = { A: 0, B: 1, C: 2, '': 3 };
const nextWorkingDay = (d) => { let x = addDays(d, 1); while (!isWorkingDay(x)) x = addDays(x, 1); return x; };

// The Dhaka wall-clock hour right now.
const dhakaHour = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000).getUTCHours();

// Everything one day needs for each person: lead actions, tasks, targets, responses, achievements.
export function planMembers(db, { date, today, picked, skipEmpty = false }) {
  const shift = `${TZ_OFFSET_MIN >= 0 ? '+' : '-'}${Math.abs(TZ_OFFSET_MIN)} minutes`;
  const isToday = date === today;
  const rules = getRules(db);
  const rows = db.prepare(
    `SELECT * FROM leads WHERE deleted_at = '' AND owner_id IS NOT NULL AND
     (invite_sent_date != '' OR accepted_date != '' OR first_dm_date != '' OR next_action_date != '' OR outreach_status = 'R')`
  ).all();
  const byOwner = new Map();
  for (const l of rows) { if (!byOwner.has(l.owner_id)) byOwner.set(l.owner_id, []); byOwner.get(l.owner_id).push(l); }

  const metrics = Object.keys(TARGET_METRICS);
  const tgt = db.prepare('SELECT user_id, metric, daily_target FROM member_targets WHERE daily_target > 0').all();
  const wk = weekStart(today);
  const counts = db.prepare(
    `SELECT user_id, type, COUNT(*) AS n, date(created_at, '${shift}') >= ? AS in_week, date(created_at, '${shift}') = ? AS is_today
     FROM activities WHERE date(created_at, '${shift}') >= ? GROUP BY user_id, type, in_week, is_today`
  ).all(wk, today, wk);
  const replies = db.prepare(
    `SELECT user_id, COUNT(*) AS n, date(created_at, '${shift}') = ? AS is_today FROM activities
     WHERE type = 'response_change' AND meta LIKE '%"to":"R"%' AND date(created_at, '${shift}') >= ? GROUP BY user_id, is_today`
  ).all(today, wk);
  const sum = (uid, types, scope) => counts.filter((c) => c.user_id === uid && types.includes(c.type) && (scope === 'week' || c.is_today)).reduce((s, c) => s + c.n, 0);
  const rep = (uid, scope) => replies.filter((c) => c.user_id === uid && (scope === 'week' || c.is_today)).reduce((s, c) => s + c.n, 0);
  const achieved = (uid, scope) => ({
    invites: sum(uid, ['linkedin_connect'], scope),
    accepted: sum(uid, ['linkedin_connected'], scope),
    messages: sum(uid, ['linkedin_dm', 'linkedin_inmail'], scope),
    emails: sum(uid, ['email'], scope),
    replies: rep(uid, scope),
    meetings: sum(uid, ['meeting_booked'], scope),
  });

  const days = (d) => Math.max(0, Math.round((Date.parse(today) - Date.parse(d)) / 86400000));
  const members = [];
  for (const u of picked) {
    const mine = byOwner.get(u.id) || [];
    const all = [];
    for (const l of mine) {
      const s = nextStep(l, date, rules);
      if (!s) continue;
      const late = Math.round((Date.parse(date) - Date.parse(s.due)) / 86400000);
      all.push({
        id: l.id, name: `${l.first_name} ${l.last_name}`.trim() || l.company, title: l.title, company: l.company, tier: l.tier,
        kind: s.kind, verb: KINDS[s.kind].verb, action: s.action, detail: s.detail, reason: s.reason, due: s.due, late_days: late,
        outreach_status: l.outreach_status, email: l.email && /verified|valid/i.test(l.email_status) ? l.email : '',
        linkedin: l.linkedin, question: clean(l.todays_question), why: clean(l.why_in_pipeline),
        pursue: /\bPURSUE\b/i.test(`${l.next_action} ${l.assessment} ${l.why_in_pipeline} ${l.problem_pool}`),
        stale: late > rules.stale_days && !['reply', 'first_message'].includes(s.kind), _rank: KINDS[s.kind].rank,
      });
    }
    // 1) replied or PURSUE leads, 2) due today, 3) late (least late first); then step type, tier A first.
    const band = (x) => (x.kind === 'reply' || x.pursue ? 0 : x.late_days <= 0 ? 1 : 2);
    const cap = capFor(db, u.id, rules);
    const live = all.filter((x) => !x.stale).sort((x, y) => band(x) - band(y) || (band(x) === 2 ? x.late_days - y.late_days : 0) || x._rank - y._rank || TIER_RANK[x.tier || ''] - TIER_RANK[y.tier || ''] || x.id - y.id);
    const stale = all.filter((x) => x.stale).sort((x, y) => y.late_days - x.late_days);
    for (const x of [...live, ...stale]) delete x._rank;

    const done = (m) => counts.find((c) => c.user_id === u.id && c.type === m && c.is_today)?.n || 0;
    const targets = metrics.map((m) => {
      const t = tgt.find((x) => x.user_id === u.id && x.metric === m)?.daily_target || 0;
      return { metric: m, label: TARGET_METRICS[m], target: t, done: isToday ? done(m) : 0 };
    }).filter((x) => x.target > 0);

    const tasks = tasksOn(db, date, u.name).map((t) => ({ id: t.id, title: t.title, category: t.category, priority: t.priority, window: t.time_window, expected: t.expected, done: isToday ? t.done : false }));
    const dm = mine.filter((l) => l.first_dm_date);
    const pick = (status, list) => list.filter((l) => l.outreach_status === status).sort((x, y) => (x.last_activity_at < y.last_activity_at ? 1 : -1));
    const brief = (l) => ({ id: l.id, name: `${l.first_name} ${l.last_name}`.trim(), company: l.company, since: l.first_dm_date || l.invite_sent_date, days: days(l.first_dm_date || l.invite_sent_date || today) });
    const seenL = pick('SNR', dm), unseenL = pick('U', dm), repliedL = pick('R', mine);
    const pending = mine.filter((l) => l.invite_sent_date && !l.accepted_date);

    if (skipEmpty && !all.length && !tasks.length && !targets.length && !mine.length) continue; // nothing to show for this person
    members.push({
      user_id: u.id, name: u.name,
      summary: { actions: live.length, shown: Math.min(live.length, cap), carry_over: Math.max(0, live.length - cap), cap, stale: stale.length, tasks: tasks.length, tasks_done: tasks.filter((t) => t.done).length },
      actions: live.slice(0, cap),
      stale: stale.slice(0, 200),
      targets, tasks,
      responses: {
        counts: { replied: repliedL.length, seen_no_reply: seenL.length, unseen: unseenL.length, pending_invites: pending.length, messaged: dm.length },
        replied: repliedL.slice(0, 8).map(brief), seen_no_reply: seenL.slice(0, 8).map(brief), unseen: unseenL.slice(0, 8).map(brief),
      },
      achieved: { today: achieved(u.id, 'today'), week: achieved(u.id, 'week') },
    });
  }
  return members;
}

export function planRoutes(db) {
  const r = Router();
  const shift = `${TZ_OFFSET_MIN >= 0 ? '+' : '-'}${Math.abs(TZ_OFFSET_MIN)} minutes`;

  // What each person has to do on one day: lead actions (with the exact next step), team tasks, daily targets,
  // how leads are responding, and what was achieved. After 6 pm the default day is the next working day.
  r.get('/', (req, res) => {
    const today = todayLocal();
    const afterNoon = dhakaHour() >= PLAN_SWITCH_HOUR;
    const tomorrow = nextWorkingDay(today);
    let date = DATE_RE.test(req.query.date || '') ? req.query.date : req.query.day === 'tomorrow' ? tomorrow : req.query.day === 'today' ? today : afterNoon ? tomorrow : today;
    if (!isWorkingDay(date) && date === today) date = today; // Friday: show it anyway, tasks/targets will be empty
    const isToday = date === today;

    const a = req.query.assignee || (req.user.role === 'admin' ? 'all' : 'me');
    const users = db.prepare("SELECT id, name, role FROM users WHERE active = 1 AND removed_at = '' ORDER BY name").all();
    const picked = a === 'all' ? users : users.filter((u) => u.id === (a === 'me' ? req.user.id : Number(a)));

    const members = planMembers(db, { date, today, picked, skipEmpty: a === 'all' });
    res.json({
      now_hour: dhakaHour(), switch_hour: PLAN_SWITCH_HOUR, after_noon: afterNoon, today, tomorrow, date, is_today: isToday, working_day: isWorkingDay(date),
      skipped_friday: addDays(today, 1) !== tomorrow, daily_cap: getRules(db).daily_cap, stale_days: getRules(db).stale_days, members,
    });
  });

  // Two working lists for one person. mode=research: leads with no lead type yet (look at website, profile and company
  // page, then choose a type). mode=engage: real fits with no invite yet (like, comment, follow, connect, InMail).
  r.get('/review', (req, res) => {
    const today = todayLocal();
    const a = req.query.assignee;
    const uid = req.user.role === 'admin' && a && a !== 'me' && a !== 'all' ? Number(a) : req.user.id;
    const mode = req.query.mode === 'engage' ? 'engage' : 'research';
    const target = db.prepare("SELECT daily_target FROM member_targets WHERE user_id = ? AND metric = 'linkedin_view'").get(uid)?.daily_target || 0;
    const done = db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND type = 'linkedin_view' AND date(created_at, '${shift}') = ?`).get(uid, today).n;
    const where = `l.deleted_at = '' AND l.owner_id = ? AND ${WORK_CASE} = ?`;
    const rows = db.prepare(
      `SELECT l.id, l.first_name, l.last_name, l.title, l.company, l.linkedin, l.company_linkedin, l.website, l.tier, l.quality, l.source, l.city, l.state,
              EXISTS(SELECT 1 FROM activities x WHERE x.lead_id = l.id AND x.user_id = ? AND x.type = 'linkedin_view' AND date(x.created_at, '${shift}') = ?) AS viewed_today
       FROM leads l WHERE ${where}
       ORDER BY CASE l.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END, l.created_at ASC, l.id ASC LIMIT ?`
    ).all(uid, today, uid, mode, Math.max(25, Math.min(target || 100, 100)));
    const pool = db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}`).get(uid, mode).n;
    res.json({ mode, target, done, pool, rows });
  });
  return r;
}
