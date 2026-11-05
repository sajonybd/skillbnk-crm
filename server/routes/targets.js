import { Router } from 'express';
import { TARGET_METRICS, TZ_OFFSET_MIN } from '../config.js';
import { HttpError } from '../db.js';
import { requireAdmin } from '../auth.js';
import { applyDefaultTargets } from '../lib/seed-ops.js';
import { todayLocal, addDays } from '../lib/kpi.js';
import { isWorkingDay } from '../lib/taskdays.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function targetsRoutes(db) {
  const r = Router();
  const shift = `${TZ_OFFSET_MIN >= 0 ? '+' : '-'}${Math.abs(TZ_OFFSET_MIN)} minutes`;

  // Per person: today's counted work against their daily targets, plus the last 7 days.
  r.get('/', (req, res) => {
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : todayLocal();
    const from = addDays(date, -6);
    const metrics = Object.keys(TARGET_METRICS);
    const tgt = db.prepare('SELECT user_id, metric, daily_target FROM member_targets WHERE daily_target > 0').all();
    const counts = db.prepare(
      `SELECT a.user_id, date(a.created_at, '${shift}') AS day, a.type, COUNT(*) AS n FROM activities a
       WHERE a.type IN (${metrics.map(() => '?').join(',')}) AND date(a.created_at, '${shift}') BETWEEN ? AND ? GROUP BY 1, 2, 3`
    ).all(...metrics, from, date);
    const users = db.prepare("SELECT id, name FROM users WHERE active = 1 AND removed_at = '' ORDER BY name").all();
    const out = [];
    for (const u of users) {
      const mine = tgt.filter((t) => t.user_id === u.id);
      if (!mine.length && !counts.some((c) => c.user_id === u.id && c.day === date)) continue;
      const done = (m, day) => counts.find((c) => c.user_id === u.id && c.type === m && c.day === day)?.n || 0;
      const rows = metrics.filter((m) => mine.some((t) => t.metric === m) || done(m, date) > 0).map((m) => {
        const target = mine.find((t) => t.metric === m)?.daily_target || 0;
        const today = done(m, date);
        return { metric: m, label: TARGET_METRICS[m], target, done: today, pct: target ? Math.round((today / target) * 100) : null };
      });
      const tracked = rows.filter((x) => x.target > 0);
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const day = addDays(date, -i);
        const t = tracked.reduce((s, x) => s + x.target, 0);
        const d = tracked.reduce((s, x) => s + Math.min(done(x.metric, day), x.target), 0);
        days.push({ day, off: !isWorkingDay(day), pct: t ? Math.round((d / t) * 100) : null });
      }
      const sumT = tracked.reduce((s, x) => s + x.target, 0);
      const sumD = tracked.reduce((s, x) => s + Math.min(x.done, x.target), 0);
      out.push({ user_id: u.id, name: u.name, rows, overall: sumT ? Math.round((sumD / sumT) * 100) : null, days });
    }
    res.json({ date, working_day: isWorkingDay(date), metrics: TARGET_METRICS, members: out });
  });

  // Admin: raw targets for editing.
  r.get('/edit', requireAdmin, (_req, res) => {
    res.json({
      metrics: TARGET_METRICS,
      users: db.prepare("SELECT id, name FROM users WHERE active = 1 AND removed_at = '' AND role != 'admin' ORDER BY name").all(),
      targets: db.prepare('SELECT user_id, metric, daily_target FROM member_targets').all(),
    });
  });
  r.put('/', requireAdmin, (req, res) => {
    const { user_id, metric, daily_target } = req.body || {};
    if (!Object.hasOwn(TARGET_METRICS, metric)) throw new HttpError(400, 'Unknown target');
    const n = Math.max(0, Math.min(5000, Math.round(Number(daily_target) || 0)));
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1").get(Number(user_id))) throw new HttpError(400, 'Unknown team member');
    db.prepare('INSERT INTO member_targets(user_id, metric, daily_target) VALUES (?,?,?) ON CONFLICT(user_id, metric) DO UPDATE SET daily_target = excluded.daily_target').run(Number(user_id), metric, n);
    res.json({ ok: true });
  });
  r.post('/auto', requireAdmin, (_req, res) => res.json({ set: applyDefaultTargets(db, true) }));
  return r;
}
