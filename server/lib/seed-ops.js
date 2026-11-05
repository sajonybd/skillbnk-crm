import { SEED_TASKS, SEED_TARGETS } from '../data/seed-tasks.js';

// Fill the task list and daily targets once (only when the tables are empty). Safe to call on every start.
export function seedOps(db) {
  const now = new Date().toISOString();
  if (db.prepare('SELECT COUNT(*) AS n FROM ops_tasks').get().n === 0) {
    const ins = db.prepare('INSERT INTO ops_tasks(code, title, category, priority, days, time_window, assignees, expected, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const [code, title, cat, pri, days, win, who, exp] of SEED_TASKS) ins.run(code, title, cat, pri, days, win, who, exp, now);
  }
  applyDefaultTargets(db, false);
}

// force = overwrite existing numbers ("Auto-set from playbook" button); otherwise only when nothing is set yet.
export function applyDefaultTargets(db, force) {
  if (!force && db.prepare('SELECT COUNT(*) AS n FROM member_targets').get().n > 0) return 0;
  const up = db.prepare('INSERT INTO member_targets(user_id, metric, daily_target) VALUES (?,?,?) ON CONFLICT(user_id, metric) DO UPDATE SET daily_target = excluded.daily_target');
  let n = 0;
  for (const [name, metrics] of Object.entries(SEED_TARGETS)) {
    const u = db.prepare("SELECT id FROM users WHERE LOWER(name) = LOWER(?) AND removed_at = ''").get(name);
    if (!u) continue;
    for (const [m, t] of Object.entries(metrics)) { up.run(u.id, m, t); n++; }
  }
  return n;
}
