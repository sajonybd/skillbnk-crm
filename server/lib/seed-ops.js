import { SEED_TASKS } from '../data/seed-tasks.js';

// Fill the task list and daily targets once (only when the tables are empty). Safe to call on every start.
export function seedOps(db) {
  const now = new Date().toISOString();
  if (db.prepare('SELECT COUNT(*) AS n FROM ops_tasks').get().n === 0) {
    const ins = db.prepare('INSERT INTO ops_tasks(code, title, category, priority, days, time_window, assignees, expected, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const [code, title, cat, pri, days, win, who, exp] of SEED_TASKS) ins.run(code, title, cat, pri, days, win, who, exp, now);
  }
  applyDefaultTargets(db, false);
}

// Team default daily targets. The admin can change them (Playbook > Daily targets); stored in settings.
export const BUILTIN_TARGETS = { linkedin_view: 100, linkedin_comment: 50, linkedin_like: 150, linkedin_follow: 30, linkedin_connect: 20, linkedin_dm: 25 };

export function getDefaultTargets(db) {
  try {
    const v = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'default_targets'").get()?.value || 'null');
    if (v && typeof v === 'object') return { ...BUILTIN_TARGETS, ...v };
  } catch { /* fall through */ }
  return { ...BUILTIN_TARGETS };
}

const upTarget = (db) => db.prepare('INSERT INTO member_targets(user_id, metric, daily_target) VALUES (?,?,?) ON CONFLICT(user_id, metric) DO UPDATE SET daily_target = excluded.daily_target');

// Give one person the team defaults (used when a member is added).
export function applyTargetsTo(db, userId) {
  const up = upTarget(db);
  for (const [m, t] of Object.entries(getDefaultTargets(db))) up.run(userId, m, t);
}

// force = overwrite everyone's numbers with the team defaults ("Auto-set" button); otherwise only when nothing is set yet.
export function applyDefaultTargets(db, force) {
  if (!force && db.prepare('SELECT COUNT(*) AS n FROM member_targets').get().n > 0) return 0;
  let n = 0;
  for (const u of db.prepare("SELECT id FROM users WHERE active = 1 AND removed_at = '' AND role = 'member'").all()) { applyTargetsTo(db, u.id); n += Object.keys(getDefaultTargets(db)).length; }
  return n;
}
