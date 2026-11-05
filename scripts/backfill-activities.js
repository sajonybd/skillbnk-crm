// One-time import of the "--- Activity Log ---" lines from the Master Leads Notes column into the CRM activity log.
// Usage: node scripts/backfill-activities.js          → dry run
//        node scripts/backfill-activities.js --apply  → writes (backs up data/crm.db first)
// Safe to re-run: an entry with the same lead, person, type and time is never added twice.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { DB_FILE, DATA_DIR } from '../server/config.js';

const apply = process.argv.includes('--apply');
const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, 'activity-backfill.json'), 'utf8'));

if (apply) {
  const dir = path.join(DATA_DIR, 'backup-pre-activities-' + new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['crm.db', 'crm.db-wal']) if (fs.existsSync(path.join(DATA_DIR, f))) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
  console.log('Backup →', dir);
}
const db = openDb(DB_FILE);
const users = Object.fromEntries(db.prepare("SELECT name, id FROM users").all().map((u) => [u.name, u.id]));
const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
const getLead = db.prepare('SELECT id, email, first_name, last_name, invite_sent_date, accepted_date, first_dm_date, outreach_status, channel FROM leads WHERE id = ?');
const exists = db.prepare('SELECT 1 FROM activities WHERE lead_id = ? AND user_id = ? AND type = ? AND created_at = ?');
const ins = db.prepare('INSERT INTO activities(lead_id, user_id, type, note, meta, created_at) VALUES (?,?,?,?,?,?)');
const dhakaDay = (iso) => new Date(Date.parse(iso) + 6 * 3600e3).toISOString().slice(0, 10);

let added = 0, dup = 0, mismatch = 0, leads = 0;
db.exec('BEGIN');
try {
  for (const rec of data) {
    const lead = getLead.get(rec.id);
    const same = lead && (lead.email || '').toLowerCase() === (rec.email || '').toLowerCase() && lead.first_name.toLowerCase() === rec.first.toLowerCase();
    if (!same) { mismatch++; continue; }
    leads++;
    let first = {};
    for (const [at, who, type, note] of rec.entries) {
      const uid = users[who] || admin;
      if (exists.get(lead.id, uid, type, at)) { dup++; continue; }
      added++;
      if (apply) ins.run(lead.id, uid, type, note, '', at);
      const k = type === 'linkedin_connect' ? 'invite_sent_date' : type === 'linkedin_connected' ? 'accepted_date' : type === 'linkedin_dm' ? 'first_dm_date' : null;
      if (k && (!first[k] || at < first[k])) first[k] = at;
    }
    if (!apply) continue;
    const last = rec.entries.map((e) => e[0]).sort().at(-1);
    db.prepare("UPDATE leads SET last_activity_at = ? WHERE id = ? AND last_activity_at < ?").run(last, lead.id, last);
    for (const [k, at] of Object.entries(first)) if (!lead[k]) db.prepare(`UPDATE leads SET ${k} = ? WHERE id = ?`).run(dhakaDay(at), lead.id);
    if (first.invite_sent_date) db.prepare("UPDATE leads SET outreach_status = 'U' WHERE id = ? AND outreach_status = ''").run(lead.id);
    if (rec.entries.length) db.prepare("UPDATE leads SET channel = 'LinkedIn' WHERE id = ? AND channel = ''").run(lead.id);
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`${apply ? 'Added' : 'Would add'} ${added} activities on ${leads} leads; ${dup} already present; ${mismatch} leads skipped (row no longer matches).`);
