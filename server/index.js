import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { seedAdmin, seedTeam, hashPassword } from './auth.js';
import { DB_FILE, PORT, DEFAULT_ADMIN, TEAM_DEFAULT_PASSWORD, DATA_DIR } from './config.js';
import { seedOps } from './lib/seed-ops.js';
import { startBackups } from './lib/backup.js';

// A file named import.db in the data folder replaces the database on the next start (the old one is kept as crm.db.before-import).
// This is how an existing database is moved to a server. See DEPLOY.md.
const incoming = path.join(DATA_DIR, 'import.db');
if (DB_FILE !== ':memory:' && fs.existsSync(incoming)) {
  if (fs.existsSync(DB_FILE)) fs.renameSync(DB_FILE, DB_FILE + '.before-import');
  for (const ext of ['-wal', '-shm']) fs.rmSync(DB_FILE + ext, { force: true });
  fs.renameSync(incoming, DB_FILE);
  console.log('Imported database from import.db');
}

const db = openDb(DB_FILE);
// On a server, never start a brand-new database with the well-known default passwords.
const onServer = process.env.NODE_ENV === 'production' || process.env.RENDER;
if (onServer && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 && (!process.env.ADMIN_PASSWORD || !process.env.TEAM_PASSWORD)) {
  console.error('Refusing to start an empty database with default passwords. Set ADMIN_PASSWORD and TEAM_PASSWORD (and ADMIN_EMAIL).');
  process.exit(1);
}
if (seedAdmin(db)) {
  console.log('\nFirst run: created admin account');
  console.log(`  email:    ${DEFAULT_ADMIN.email}`);
  console.log(process.env.ADMIN_PASSWORD ? '  password:  (the ADMIN_PASSWORD you set)' : `  password: ${DEFAULT_ADMIN.password}`);
  console.log('  Sign in and change the password (top right → Password).\n');
}
// Locked out? Set RESET_ADMIN_PASSWORD=1 with ADMIN_EMAIL and ADMIN_PASSWORD, redeploy once, then delete RESET_ADMIN_PASSWORD.
if (process.env.RESET_ADMIN_PASSWORD && process.env.ADMIN_PASSWORD) {
  const email = String(process.env.ADMIN_EMAIL || DEFAULT_ADMIN.email).trim().toLowerCase();
  const u = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email);
  if (u) {
    db.prepare("UPDATE users SET password_hash = ?, active = 1, role = 'admin' WHERE id = ?").run(hashPassword(process.env.ADMIN_PASSWORD), u.id);
    console.log(`Password reset for ${email}. Now delete the RESET_ADMIN_PASSWORD setting.`);
  } else console.log(`RESET_ADMIN_PASSWORD: no user with email ${email}`);
}
const madeTeam = seedTeam(db);
seedOps(db);
if (madeTeam.length) console.log(`Created team members: ${madeTeam.join(', ')} (password: ${process.env.TEAM_PASSWORD ? 'the TEAM_PASSWORD you set' : TEAM_DEFAULT_PASSWORD}). Update emails/passwords in the Team page.\n`);
if (DB_FILE !== ':memory:') startBackups(db, DATA_DIR);
createApp(db).listen(PORT, () => console.log(`skillBNK CRM running → http://localhost:${PORT}`));
