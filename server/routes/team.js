import crypto from 'node:crypto';
import { Router } from 'express';
import { hashPassword, requireAdmin } from '../auth.js';
import { HttpError, logActivity, tx } from '../db.js';

export function teamRoutes(db) {
  const r = Router();

  r.get('/', (_req, res) => {
    const users = db.prepare(
      `SELECT u.id, u.name, u.email, u.role, u.active,
              (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.deleted_at = '') AS lead_count
       FROM users u WHERE u.removed_at = '' ORDER BY u.active DESC, u.name`
    ).all();
    res.json({ users });
  });

  // Remove a member: their leads become unassigned, their past activity stays in the history
  // (shown under "Name (removed)"), and the name/email are freed so they can be reused.
  r.delete('/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND removed_at = ''").get(id);
    if (!u) throw new HttpError(404, 'User not found');
    if (id === req.user.id) throw new HttpError(400, "You can't remove yourself");
    if (u.role === 'admin' && !db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND active = 1 AND removed_at = '' AND id != ?").get(id)) {
      throw new HttpError(400, "You can't remove the last admin");
    }
    const now = new Date().toISOString();
    let unassigned = 0;
    tx(db, () => {
      const leads = db.prepare('SELECT id FROM leads WHERE owner_id = ?').all(id);
      for (const l of leads) {
        db.prepare('UPDATE leads SET owner_id = NULL WHERE id = ?').run(l.id);
        logActivity(db, { lead_id: l.id, user_id: req.user.id, type: 'assign', note: `${u.name} (removed) → Unassigned`, meta: { from_id: id, to_id: null }, at: now });
        unassigned++;
      }
      db.prepare("UPDATE users SET active = 0, removed_at = ?, name = ?, email = ? WHERE id = ?")
        .run(now, `${u.name} (removed)`, `removed.${id}.${u.email}`, id);
    });
    res.json({ ok: true, unassigned });
  });

  r.post('/', requireAdmin, (req, res) => {
    const { name, email, password, role } = req.body || {};
    if (!String(name || '').trim() || !String(email || '').trim()) throw new HttpError(400, 'Name and email are required');
    if (!password || String(password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    try {
      const info = db.prepare(
        'INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)'
      ).run(String(name).trim(), String(email).trim(), hashPassword(password), role === 'admin' ? 'admin' : 'member', new Date().toISOString());
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A user with that name or email already exists');
      throw e;
    }
  });

  r.patch('/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'User not found');
    const { name, email, role, active, password } = req.body || {};
    if (id === req.user.id && (active === false || active === 0 || (role && role !== 'admin'))) {
      throw new HttpError(400, "You can't deactivate or demote yourself");
    }
    const next = {
      name: name != null ? String(name).trim() : u.name,
      email: email != null ? String(email).trim() : u.email,
      role: role ? (role === 'admin' ? 'admin' : 'member') : u.role,
      active: active != null ? (active ? 1 : 0) : u.active,
      password_hash: password ? hashPassword(password) : u.password_hash,
    };
    if (password && String(password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    try {
      db.prepare('UPDATE users SET name=?, email=?, role=?, active=?, password_hash=? WHERE id=?')
        .run(next.name, next.email, next.role, next.active, next.password_hash, id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A user with that name or email already exists');
      throw e;
    }
    res.json({ ok: true });
  });

  return r;
}

// Used by the importer when a sheet names an owner that has no account yet.
export function createPlaceholderUser(db, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'user';
  let email = `${slug}@skillbnk.local`;
  let n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) email = `${slug}${++n}@skillbnk.local`;
  const info = db.prepare(
    'INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)'
  ).run(name, email, hashPassword(crypto.randomBytes(12).toString('hex')), 'member', new Date().toISOString());
  return { id: Number(info.lastInsertRowid), name };
}
