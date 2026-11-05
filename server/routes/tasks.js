import { Router } from 'express';
import { HttpError } from '../db.js';
import { requireAdmin } from '../auth.js';
import { dueOn, parseDays, isWorkingDay } from '../lib/taskdays.js';
import { todayLocal } from '../lib/kpi.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const names = (s) => String(s || '').split(/\s*(?:&|,| and )\s*/).map((x) => x.trim()).filter(Boolean);
const mine = (task, userName) => names(task.assignees).some((n) => n.toLowerCase() === userName.toLowerCase() || userName.toLowerCase().startsWith(n.toLowerCase()));

// Tasks due on a date for one person (name) or everyone (null), with done flags.
export function tasksOn(db, date, who) {
  const done = new Map(db.prepare('SELECT d.task_id, d.done_at, u.name AS by FROM ops_task_done d LEFT JOIN users u ON u.id = d.done_by WHERE d.day = ?').all(date).map((x) => [x.task_id, x]));
    const items = db.prepare('SELECT * FROM ops_tasks WHERE active = 1 ORDER BY time_window, code').all()
      .filter((t) => dueOn(t.days, date) && (who === null || mine(t, who)))
      .map((t) => ({ ...t, done: done.has(t.id), done_at: done.get(t.id)?.done_at || '', done_by: done.get(t.id)?.by || '' }));
    // Times are clock text ("08:30 - 09:10 AM", "11:30 AM - 12:30 PM"); sort them as clock time.
    const mins = (w) => {
      const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(w));
      if (!m) return 9999;
      let h = Number(m[1]);
      let ap = (m[3] || m[6] || '').toUpperCase();
      if (!m[3] && ap === 'PM' && h > Number(m[4]) && Number(m[4]) !== 12) ap = 'AM';
      if (ap === 'PM' && h !== 12) h += 12; else if (ap === 'AM' && h === 12) h = 0;
      return h * 60 + Number(m[2]);
    };
    items.sort((x, y) => mins(x.time_window) - mins(y.time_window) || x.code - y.code);
  return items;
}

export function tasksRoutes(db) {
  const r = Router();

  // Tasks due on a date. ?assignee=me | all | <user id>
  r.get('/', (req, res) => {
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : todayLocal();
    let who = null;
    const a = req.query.assignee || 'me';
    if (a === 'me') who = req.user.name;
    else if (a !== 'all') who = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(a))?.name || '';
    const items = tasksOn(db, date, who);
    res.json({ date, working_day: isWorkingDay(date), total: items.length, done: items.filter((i) => i.done).length, items });
  });

  r.post('/:id/done', (req, res) => {
    const task = db.prepare('SELECT * FROM ops_tasks WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!task) throw new HttpError(404, 'Task not found');
    const day = DATE_RE.test(req.body?.day || '') ? req.body.day : todayLocal();
    if (req.body?.done === false) db.prepare('DELETE FROM ops_task_done WHERE task_id = ? AND day = ?').run(task.id, day);
    else db.prepare('INSERT OR REPLACE INTO ops_task_done(task_id, day, done_by, done_at) VALUES (?,?,?,?)').run(task.id, day, req.user.id, new Date().toISOString());
    res.json({ ok: true });
  });

  // Admin: add / edit / retire tasks.
  const fields = (b, partial) => {
    const out = {};
    for (const [k, col] of [['title', 'title'], ['category', 'category'], ['priority', 'priority'], ['days', 'days'], ['window', 'time_window'], ['assignees', 'assignees'], ['expected', 'expected']]) {
      if (partial && !(k in b)) continue;
      out[col] = String(b[k] ?? '').trim().slice(0, 600);
    }
    if (!partial && !out.title) throw new HttpError(400, 'Give the task a title');
    if ('days' in out && out.days && !parseDays(out.days).dow.size && !parseDays(out.days).dom && !parseDays(out.days).eom) throw new HttpError(400, 'Days not understood. Try "Sat-Thu", "Mon/Wed", "Sunday" or "1st - 10th of month"');
    return out;
  };
  r.post('/', requireAdmin, (req, res) => {
    const f = fields(req.body || {}, false);
    const info = db.prepare('INSERT INTO ops_tasks(title, category, priority, days, time_window, assignees, expected, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(f.title, f.category || '', f.priority || 'Medium', f.days || '', f.time_window || '', f.assignees || '', f.expected || '', new Date().toISOString());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  r.patch('/:id', requireAdmin, (req, res) => {
    const f = fields(req.body || {}, true);
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE ops_tasks SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => f[c]), Number(req.params.id));
    res.json({ ok: true });
  });
  r.delete('/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE ops_tasks SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
  return r;
}
