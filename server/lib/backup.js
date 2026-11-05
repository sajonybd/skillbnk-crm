// Daily snapshot of the database into data/backups (keeps the newest KEEP files).
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 14;

export function backupNow(db, dataDir) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `crm-${new Date().toISOString().slice(0, 10)}.db`);
  if (!fs.existsSync(file)) {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log('Backup written →', file);
  }
  const old = fs.readdirSync(dir).filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
}

export function startBackups(db, dataDir) {
  const run = () => { try { backupNow(db, dataDir); } catch (e) { console.error('Backup failed:', e.message); } };
  run();
  setInterval(run, 6 * 3600e3).unref();
}
