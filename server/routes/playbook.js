import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../db.js';
import { requireAdmin } from '../auth.js';
import { RULE_DEFS, DEFAULT_RULES, getRules, saveRules, capFor } from '../lib/rules.js';
import { getDefaultTargets, BUILTIN_TARGETS } from '../lib/seed-ops.js';
import { TARGET_METRICS } from '../config.js';
import { DEFAULT_PLAYBOOK } from '../data/playbook-default.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = (name) => { try { return fs.readFileSync(path.join(root, 'docs', name), 'utf8'); } catch { return ''; } };
const STATUSES = ['open', 'approved', 'declined', 'done'];

export function playbookRoutes(db) {
  const r = Router();
  const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  const put = (k, v) => db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  // Rules, plan text and (for the admin) every change request; members see their own requests.
  r.get('/', (req, res) => {
    const rules = getRules(db);
    const users = db.prepare("SELECT id, name, role FROM users WHERE active = 1 AND removed_at = '' AND role != 'admin' ORDER BY name").all();
    const meta = (() => { try { return JSON.parse(setting('playbook_meta') || '{}'); } catch { return {}; } })();
    const isAdmin = req.user.role === 'admin';
    const reqs = db.prepare(
      `SELECT q.*, u.name AS user_name FROM plan_requests q JOIN users u ON u.id = q.user_id ${isAdmin ? '' : 'WHERE q.user_id = ?'} ORDER BY (q.status = 'open') DESC, q.id DESC LIMIT 100`
    ).all(...(isAdmin ? [] : [req.user.id]));
    res.json({
      rules, defaults: DEFAULT_RULES, defs: RULE_DEFS,
      caps: users.map((u) => ({ user_id: u.id, name: u.name, cap: capFor(db, u.id, rules), custom: setting('cap:' + u.id) !== undefined })),
      markdown: setting('playbook_md') || DEFAULT_PLAYBOOK, customized: setting('playbook_md') !== undefined, ...meta,
      targets: {
        metrics: TARGET_METRICS, defaults: getDefaultTargets(db), builtin: BUILTIN_TARGETS,
        members: users.map((u) => ({ user_id: u.id, name: u.name, targets: Object.fromEntries(db.prepare('SELECT metric, daily_target FROM member_targets WHERE user_id = ?').all(u.id).map((t) => [t.metric, t.daily_target])) })),
      },
      requests: reqs, open_requests: db.prepare("SELECT COUNT(*) AS n FROM plan_requests WHERE status = 'open'").get().n,
    });
  });

  // Admin: team default daily targets and each person's own numbers.
  r.put('/targets', requireAdmin, (req, res) => {
    const clamp = (v) => Math.max(0, Math.min(5000, Math.round(Number(v) || 0)));
    const defs = {};
    for (const m of Object.keys(TARGET_METRICS)) if (req.body?.defaults && m in req.body.defaults) defs[m] = clamp(req.body.defaults[m]);
    if (Object.keys(defs).length) put('default_targets', JSON.stringify({ ...getDefaultTargets(db), ...defs }));
    const up = db.prepare('INSERT INTO member_targets(user_id, metric, daily_target) VALUES (?,?,?) ON CONFLICT(user_id, metric) DO UPDATE SET daily_target = excluded.daily_target');
    for (const [uid, row] of Object.entries(req.body?.members || {})) {
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1").get(Number(uid))) continue;
      for (const [m, v] of Object.entries(row || {})) if (Object.hasOwn(TARGET_METRICS, m)) up.run(Number(uid), m, clamp(v));
    }
    res.json({ ok: true });
  });

  r.put('/rules', requireAdmin, (req, res) => {
    let rules;
    try { rules = saveRules(db, req.body?.rules); } catch (e) { throw new HttpError(400, e.message); }
    for (const c of req.body?.caps || []) {
      const uid = Number(c.user_id);
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1").get(uid)) continue;
      const n = Math.round(Number(c.cap));
      if (c.cap === '' || c.cap === null || n === rules.daily_cap) db.prepare('DELETE FROM settings WHERE key = ?').run('cap:' + uid);
      else if (n >= 1 && n <= 200) put('cap:' + uid, String(n));
      else throw new HttpError(400, 'A daily limit must be from 1 to 200');
    }
    res.json({ ok: true, rules });
  });

  r.put('/plan', requireAdmin, (req, res) => {
    const md = String(req.body?.markdown ?? '');
    if (md.trim().length < 20) throw new HttpError(400, 'The plan text is too short');
    if (md.length > 60000) throw new HttpError(400, 'The plan text is too long (60,000 characters at most)');
    put('playbook_md', md);
    put('playbook_meta', JSON.stringify({ updated_at: new Date().toISOString(), updated_by: req.user.name }));
    res.json({ ok: true });
  });

  // Anyone (including an AI agent using an API key) can ask the admin to change the plan.
  r.post('/requests', (req, res) => {
    const title = String(req.body?.title || '').trim().slice(0, 200);
    const details = String(req.body?.details || '').trim().slice(0, 5000);
    if (!title) throw new HttpError(400, 'Give the request a short title');
    const info = db.prepare('INSERT INTO plan_requests(user_id, title, details, created_at) VALUES (?,?,?,?)').run(req.user.id, title, details, new Date().toISOString());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  r.patch('/requests/:id', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT * FROM plan_requests WHERE id = ?').get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Request not found');
    const status = String(req.body?.status || row.status);
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
    db.prepare('UPDATE plan_requests SET status = ?, admin_note = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(status, String(req.body?.admin_note ?? row.admin_note).slice(0, 2000), req.user.id, new Date().toISOString(), row.id);
    res.json({ ok: true });
  });

  // Manuals shown in the Help page and read by AI agents.
  r.get('/docs', (_req, res) => res.json({ team: doc('USER-GUIDE.md'), agent: doc('AGENT-API.md') }));
  return r;
}
