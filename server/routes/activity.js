import { Router } from 'express';
import { TYPE_LABELS, TOUCH_TYPES, TZ_OFFSET_MIN } from '../config.js';
import { rangeBounds, RANGES } from '../lib/range.js';

export function activityRoutes(db) {
  const r = Router();

  function filters(q) {
    const where = [];
    const params = [];
    const b = rangeBounds(q.range || 'today', q.from, q.to);
    if (b) { where.push('a.created_at >= ? AND a.created_at < ?'); params.push(b.start, b.end); }
    if (q.user) { where.push('a.user_id = ?'); params.push(Number(q.user)); }
    if (q.type) { where.push('a.type = ?'); params.push(q.type); }
    if (q.lead) { where.push('a.lead_id = ?'); params.push(Number(q.lead)); }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, bounds: b };
  }

  r.get('/', (req, res) => {
    const { sql, params, bounds } = filters(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM activities a ${sql}`).get(...params).n;

    const rows = db.prepare(
      `SELECT a.id, a.type, a.note, a.created_at, a.lead_id, a.user_id, u.name AS user_name,
              TRIM(l.first_name || ' ' || l.last_name) AS lead_name, l.company AS lead_company
       FROM activities a
       JOIN users u ON u.id = a.user_id
       JOIN leads l ON l.id = a.lead_id
       ${sql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    // Per-user summary: counts by type + distinct leads touched.
    const byType = db.prepare(
      `SELECT a.user_id, u.name AS user_name, a.type, COUNT(*) AS n
       FROM activities a JOIN users u ON u.id = a.user_id ${sql}
       GROUP BY a.user_id, a.type`
    ).all(...params);
    const leadsTouched = db.prepare(
      `SELECT a.user_id, COUNT(DISTINCT a.lead_id) AS n FROM activities a ${sql} GROUP BY a.user_id`
    ).all(...params);
    const touched = Object.fromEntries(leadsTouched.map((x) => [x.user_id, x.n]));
    const users = new Map();
    for (const x of byType) {
      if (!users.has(x.user_id)) users.set(x.user_id, { user_id: x.user_id, user_name: x.user_name, total: 0, leads: touched[x.user_id] || 0, types: {} });
      const u = users.get(x.user_id);
      u.types[x.type] = x.n;
      u.total += x.n;
    }
    const summary = [...users.values()].sort((a, b) => b.total - a.total);

    res.json({ rows, total, summary, bounds });
  });

  // Touch counts for the quick range tabs (Today / Yesterday / This week / ...).
  r.get('/tabs', (req, res) => {
    const marks = TOUCH_TYPES.map(() => '?').join(',');
    const out = {};
    for (const key of ['today', 'yesterday', 'week', 'last_week', 'month', 'all']) {
      const b = rangeBounds(key);
      const where = [`a.type IN (${marks})`];
      const params = [...TOUCH_TYPES];
      if (b) { where.push('a.created_at >= ? AND a.created_at < ?'); params.push(b.start, b.end); }
      if (req.query.user) { where.push('a.user_id = ?'); params.push(Number(req.query.user)); }
      out[key] = db.prepare(`SELECT COUNT(*) AS n FROM activities a WHERE ${where.join(' AND ')}`).get(...params).n;
    }
    res.json(out);
  });

  // Day-by-day counts per team member (days are in the configured timezone).
  r.get('/daily', (req, res) => {
    const { sql, params, bounds } = filters(req.query);
    const shift = `${TZ_OFFSET_MIN >= 0 ? '+' : '-'}${Math.abs(TZ_OFFSET_MIN)} minutes`;
    const rows = db.prepare(
      `SELECT date(a.created_at, '${shift}') AS day, a.user_id, u.name AS user_name, a.type, COUNT(*) AS n
       FROM activities a JOIN users u ON u.id = a.user_id ${sql}
       GROUP BY day, a.user_id, a.type ORDER BY day DESC`
    ).all(...params);
    const days = new Map();
    for (const x of rows) {
      if (!days.has(x.day)) days.set(x.day, { day: x.day, touches: 0, total: 0, byUser: {} });
      const d = days.get(x.day);
      const isTouch = TOUCH_TYPES.includes(x.type);
      d.total += x.n;
      if (isTouch) d.touches += x.n;
      const u = (d.byUser[x.user_id] ||= { user_id: x.user_id, user_name: x.user_name, touches: 0, total: 0, types: {} });
      u.total += x.n;
      u.types[x.type] = x.n;
      if (isTouch) u.touches += x.n;
    }
    const list = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 62);
    res.json({ days: list, capped: days.size > 62, bounds });
  });

  r.get('/meta', (_req, res) => res.json({ ranges: RANGES, types: TYPE_LABELS }));

  return r;
}
