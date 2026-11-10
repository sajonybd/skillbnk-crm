import { Router } from 'express';
import { HttpError, tx } from '../db.js';
import { requireAdmin } from '../auth.js';
import { updateMeeting, deleteMeeting } from '../lib/meetings.js';
import { addDays, todayLocal, weekStart, localDate } from '../lib/kpi.js';

const SORTS = {
  date: 'm.scheduled_date, m.scheduled_time',
  lead: "LOWER(l.first_name || ' ' || l.last_name)",
  company: 'LOWER(l.company)',
  booked_by: 'LOWER(b.name)',
  status: 'm.status',
  created: 'm.created_at',
  updated: 'm.status_changed_at',
};

export function meetingsRoutes(db) {
  const r = Router();

  function where(q, user) {
    const w = ["l.deleted_at = ''"];
    const p = [];
    const today = todayLocal();
    const wk = weekStart(today);
    if (q.status && ['booked', 'completed', 'cancelled'].includes(q.status)) { w.push('m.status = ?'); p.push(q.status); }
    if (q.user === 'me') { w.push('m.booked_by = ?'); p.push(user.id); }
    else if (q.user) { w.push('m.booked_by = ?'); p.push(Number(q.user)); }
    switch (q.when) {
      case 'upcoming': w.push("m.status = 'booked' AND m.scheduled_date >= ?"); p.push(today); break;
      case 'overdue': w.push("m.status = 'booked' AND m.scheduled_date < ?"); p.push(today); break;
      case 'today': w.push('m.scheduled_date = ?'); p.push(today); break;
      case 'week': w.push('m.scheduled_date >= ? AND m.scheduled_date < ?'); p.push(wk, addDays(wk, 7)); break;
      case 'next_week': w.push('m.scheduled_date >= ? AND m.scheduled_date < ?'); p.push(addDays(wk, 7), addDays(wk, 14)); break;
      case 'month': w.push('m.scheduled_date >= ? AND m.scheduled_date < ?'); p.push(today.slice(0, 8) + '01', addDays(today.slice(0, 8) + '01', 31).slice(0, 8) + '01'); break;
      default: break;
    }
    for (const t of String(q.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
      w.push("LOWER(l.first_name || ' ' || l.last_name || ' ' || l.company) LIKE ?");
      p.push(`%${t}%`);
    }
    return { sql: 'WHERE ' + w.join(' AND '), p };
  }

  const FROM = `FROM meetings m JOIN leads l ON l.id = m.lead_id
                LEFT JOIN users b ON b.id = m.booked_by LEFT JOIN users o ON o.id = l.owner_id`;

  r.get('/', (req, res) => {
    const { sql, p } = where(req.query, req.user);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const key = SORTS[req.query.sort] ? req.query.sort : 'date';
    const dir = req.query.dir === 'desc' ? 'DESC' : req.query.dir === 'asc' ? 'ASC' : (req.query.when === 'upcoming' || !req.query.when ? 'ASC' : 'DESC');
    const order = SORTS[key].split(',').map((c) => `${c.trim()} ${dir}`).join(', ');
    const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${sql}`).get(...p).n;
    const rows = db.prepare(
      `SELECT m.*, l.first_name, l.last_name, l.company, l.title, l.stage, l.owner_id, o.name AS owner_name, b.name AS booked_by_name
       ${FROM} ${sql} ORDER BY ${order}, m.id DESC LIMIT ? OFFSET ?`
    ).all(...p, limit, (page - 1) * limit);
    res.json({ rows, total, page, limit, today: todayLocal() });
  });

  // Cards at the top of the Meetings page. Optional ?user= narrows it to one person.
  r.get('/summary', (req, res) => {
    const today = todayLocal();
    const wk = weekStart(today);
    const u = req.query.user === 'me' ? req.user.id : req.query.user ? Number(req.query.user) : null;
    const uw = u ? ' AND m.booked_by = ?' : '';
    const up = u ? [u] : [];
    const n = (cond, ...extra) => db.prepare(`SELECT COUNT(*) AS n ${FROM} WHERE l.deleted_at = '' ${cond}${uw}`).get(...extra, ...up).n;
    const weekRows = db.prepare(`SELECT m.created_at AS at ${FROM} WHERE l.deleted_at = ''${uw}`).all(...up);
    res.json({
      today,
      upcoming: n("AND m.status = 'booked' AND m.scheduled_date >= ?", today),
      todayCount: n("AND m.status = 'booked' AND m.scheduled_date = ?", today),
      overdue: n("AND m.status = 'booked' AND m.scheduled_date < ?", today),
      completed: n("AND m.status = 'completed'"),
      cancelled: n("AND m.status = 'cancelled'"),
      total: n(''),
      bookedThisWeek: weekRows.filter((x) => weekStart(localDate(x.at)) === wk).length,
    });
  });

  const load = (id) => {
    const m = db.prepare('SELECT m.*, l.deleted_at FROM meetings m JOIN leads l ON l.id = m.lead_id WHERE m.id = ?').get(Number(id));
    if (!m) throw new HttpError(404, 'Meeting not found');
    if (m.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    return m;
  };

  r.patch('/:id', (req, res) => {
    const m = load(req.params.id);
    const meeting = tx(db, () => updateMeeting(db, m, req.body || {}, req.user));
    res.json({ meeting });
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const m = load(req.params.id);
    tx(db, () => deleteMeeting(db, m, req.user));
    res.json({ ok: true });
  });

  return r;
}
