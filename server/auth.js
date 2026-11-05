import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { DATA_DIR, DEFAULT_ADMIN, TEAM, TEAM_DEFAULT_PASSWORD } from './config.js';
import { HttpError } from './db.js';

const COOKIE = 'sid';
const MAX_AGE_S = 60 * 60 * 24 * 30;

function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const SECRET = getSecret();

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return want.length === hash.length && crypto.timingSafeEqual(hash, want);
}

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function makeToken(userId) {
  const payload = `${userId}.${Date.now() + MAX_AGE_S * 1000}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const a = Buffer.from(sign(payload));
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return Number(parts[0]);
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const hashApiToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function attachUser(db) {
  const find = db.prepare('SELECT id, name, email, role FROM users WHERE id = ? AND active = 1');
  const byToken = db.prepare("SELECT u.id, u.name, u.email, u.role, t.id AS tid FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.active = 1");
  return (req, _res, next) => {
    // Scripts and AI agents send "Authorization: Bearer sbk_…"; the browser uses the session cookie.
    const bearer = /^Bearer (sbk_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    if (bearer) {
      const row = byToken.get(hashApiToken(bearer[1]));
      if (row) {
        db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.tid);
        req.user = { id: row.id, name: row.name, email: row.email, role: row.role };
        req.viaToken = true;
      } else req.user = null;
      return next();
    }
    const id = readToken(getCookie(req, COOKIE));
    req.user = id ? find.get(id) || null : null;
    next();
  };
}

// Too many wrong passwords from one address + email → wait. In memory, resets on restart.
const FAILS = new Map();
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;
function failKey(req, email) { return `${req.ip}|${String(email || '').toLowerCase()}`; }
function tooMany(key) {
  const rec = FAILS.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { FAILS.delete(key); return false; }
  return rec.n >= MAX_FAILS;
}
function noteFail(key) {
  const rec = FAILS.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) FAILS.set(key, { n: 1, first: Date.now() });
  else rec.n++;
}

// True while the account still uses one of the documented default passwords.
const DEFAULT_PASSWORDS = [DEFAULT_ADMIN.password, TEAM_DEFAULT_PASSWORD, 'admin123', 'welcome123'];
export const hasDefaultPassword = (hash) => DEFAULT_PASSWORDS.some((p) => verifyPassword(p, hash));

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admins only'));
  next();
}

export function seedAdmin(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return false;
  db.prepare(
    "INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)"
  ).run(DEFAULT_ADMIN.name, DEFAULT_ADMIN.email, hashPassword(DEFAULT_ADMIN.password), 'admin', new Date().toISOString());
  return true;
}

export function authRoutes(db) {
  const r = Router();

  r.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const key = failKey(req, email);
    if (tooMany(key)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || '').trim());
    if (!u || !verifyPassword(password || '', u.password_hash)) { noteFail(key); throw new HttpError(401, 'Wrong email or password'); }
    FAILS.delete(key);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(u.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure}`);
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, weakPassword: hasDefaultPassword(u.password_hash) });
  });

  r.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: req.user, weakPassword: !!row && hasDefaultPassword(row.password_hash) });
  });

  // API tokens for scripts / AI agents. The token is shown once; only its hash is stored.
  r.get('/me/tokens', requireAuth, (req, res) => {
    res.json({ tokens: db.prepare('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id').all(req.user.id) });
  });
  r.post('/me/tokens', requireAuth, (req, res) => {
    if (req.viaToken) throw new HttpError(403, 'Create tokens from a browser session');
    const token = 'sbk_' + crypto.randomBytes(24).toString('base64url');
    const name = String(req.body?.name || 'API token').trim().slice(0, 60);
    const info = db.prepare('INSERT INTO api_tokens(user_id, name, token_hash, created_at) VALUES (?,?,?,?)').run(req.user.id, name, hashApiToken(token), new Date().toISOString());
    res.status(201).json({ id: Number(info.lastInsertRowid), name, token });
  });
  r.delete('/me/tokens/:id', requireAuth, (req, res) => {
    const out = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    if (!Number(out.changes)) throw new HttpError(404, 'Token not found');
    res.json({ ok: true });
  });

  r.post('/me/password', requireAuth, (req, res) => {
    const { current, next } = req.body || {};
    if (!next || String(next).length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current || '', u.password_hash)) throw new HttpError(400, 'Current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
    res.json({ ok: true });
  });

  return r;
}

// Ensures every member listed in config.TEAM exists. Returns the names it created.
export function seedTeam(db) {
  const created = [];
  // Once an admin has removed someone, the team is managed in the Team page, not config.js.
  if (db.prepare("SELECT 1 FROM users WHERE removed_at != ''").get()) return created;
  const find =db.prepare('SELECT 1 FROM users WHERE LOWER(name) = LOWER(?) OR LOWER(email) = LOWER(?)');
  const add = db.prepare("INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,'member',1,?)");
  for (const m of TEAM) {
    if (find.get(m.name, m.email)) continue;
    add.run(m.name, m.email, hashPassword(TEAM_DEFAULT_PASSWORD), new Date().toISOString());
    created.push(m.name);
  }
  return created;
}
