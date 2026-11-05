import { Router } from 'express';
import { DEFAULT_WEEKLY_MEETING_TARGET } from '../config.js';
import { HttpError, tx } from '../db.js';
import { requireAdmin } from '../auth.js';
import { computeKpi, getKpiStart, todayLocal, weekStart } from '../lib/kpi.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function kpiRoutes(db) {
  const r = Router();

  r.get('/', (req, res) => {
    const current = weekStart(todayLocal());
    let week = DATE_RE.test(req.query.week || '') ? weekStart(req.query.week) : current;
    if (week > current) week = current;
    const members = computeKpi(db, week);
    res.json({ currentWeek: current, week, start: getKpiStart(db), defaultTarget: DEFAULT_WEEKLY_MEETING_TARGET, canEdit: req.user.role === 'admin', members });
  });

  // Admin: set the weekly target. Takes effect from the current week onward.
  r.put('/targets', requireAdmin, (req, res) => {
    const { user_ids, target } = req.body || {};
    const t = Number(target);
    if (!Number.isInteger(t) || t < 0 || t > 1000) throw new HttpError(400, 'Target must be a whole number from 0 to 1000');
    const ids = user_ids === 'all' || !user_ids
      ? db.prepare("SELECT id FROM users WHERE role = 'member' AND active = 1 AND removed_at = ''").all().map((u) => u.id)
      : (Array.isArray(user_ids) ? user_ids : [user_ids]).map(Number);
    const week = weekStart(todayLocal());
    tx(db, () => {
      const up = db.prepare('INSERT INTO kpi_targets(user_id, effective_week, target) VALUES (?,?,?) ON CONFLICT(user_id, effective_week) DO UPDATE SET target = excluded.target');
      for (const id of ids) {
        if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND removed_at = ''").get(id)) throw new HttpError(400, 'Unknown team member');
        up.run(id, week, t);
      }
    });
    res.json({ ok: true, updated: ids.length, effective_week: week });
  });

  // Admin: first week the KPI counts from (earlier weeks are ignored for carry-forward).
  r.put('/start', requireAdmin, (req, res) => {
    const d = req.body?.week;
    if (!DATE_RE.test(d || '')) throw new HttpError(400, 'week must be YYYY-MM-DD');
    const w = weekStart(d);
    db.prepare("INSERT INTO settings(key, value) VALUES ('kpi_start_week', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(w);
    res.json({ start: w });
  });

  return r;
}
