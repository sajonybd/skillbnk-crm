// One-time import of meeting data from the Master Leads sheet (columns Pipeline Stage / Meeting Date).
// Usage: node scripts/backfill-meetings.js          → dry run (prints what it would do)
//        node scripts/backfill-meetings.js --apply  → writes (backs up data/crm.db first)
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { DB_FILE, DATA_DIR } from '../server/config.js';
import { createMeeting } from '../server/lib/meetings.js';

const apply = process.argv.includes('--apply');
// [lead id, date, time, status, note]. Times are as written in the sheet (mostly US Eastern).
const M = [
  [91,   '2026-10-29', '15:30', 'booked',    'ET. Sheet said "Meeting Scheduled"; held or not is not confirmed — mark Completed/Cancelled.'],
  [485,  '2026-09-11', '16:00', 'completed', 'Discovery call held (from sheet)'],
  [887,  '2026-09-22', '16:00', 'completed', 'Discovery call held (from sheet)'],
  [1597, '2026-12-21', '15:30', 'booked',    'EST, Google Meet. Oct 28 meeting was postponed by the lead; acceptance of Dec 21 not yet shown.'],
  [1989, '2026-09-09', '15:00', 'completed', 'Discovery call held (from sheet)'],
  [2041, '2026-09-24', '15:00', 'completed', 'Discovery call held (from sheet)'],
  [2479, '2026-10-12', '15:30', 'completed', 'Walkthrough completed (from sheet)'],
  [2670, '2026-10-01', '15:30', 'completed', 'Discovery call held (from sheet)'],
  [2670, '2026-11-30', '',      'booked',    'Follow-up (requested time based on email; time not confirmed)'],
  [3206, '2026-10-04', '11:30', 'completed', 'Walkthrough completed (from sheet)'],
  [3206, '2026-10-12', '02:00', 'completed', 'Walkthrough completed (from sheet)'],
  [3208, '2026-09-04', '16:00', 'completed', 'Discovery call held (from sheet)'],
  [3209, '2026-09-15', '05:00', 'completed', 'Presentation held; skillBNK Bangladesh Government Pilot Proposal'],
  [3210, '2026-10-15', '18:30', 'completed', 'Proposal / Pilot stage (from sheet)'],
  [3211, '2026-10-30', '14:30', 'cancelled', 'EDT. Declined by the lead, not held.'],
  [7664, '2026-11-03', '15:30', 'booked',    'ET = 8:30 PM UK = Nov 4 2:30 AM Dhaka. Confirmed by calendar invite (Google Meet, organizer Luke Willcock). Mark Completed if it was held.'],
];

if (apply) {
  const dir = path.join(DATA_DIR, 'backup-pre-meetings-' + new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['crm.db', 'crm.db-wal']) if (fs.existsSync(path.join(DATA_DIR, f))) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
  console.log('Backup →', dir);
}
const db = openDb(DB_FILE);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
let made = 0, skipped = 0;
for (const [id, date, time, status, note] of M) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND deleted_at = \'\'').get(id);
  if (!lead) { console.log('SKIP missing lead', id); skipped++; continue; }
  const dup = db.prepare('SELECT 1 FROM meetings WHERE lead_id = ? AND scheduled_date = ?').get(id, date);
  const label = `${lead.first_name} ${lead.last_name} (#${id}) ${date} ${time} ${status}`;
  if (dup) { console.log('SKIP exists  ', label); skipped++; continue; }
  console.log((apply ? 'ADD          ' : 'WOULD ADD    ') + label);
  if (!apply) continue;
  const past = date < new Date().toISOString().slice(0, 10);
  createMeeting(db, lead, { scheduled_date: date, scheduled_time: time, status, notes: note, booked_by: lead.owner_id || admin.id }, admin,
    past ? { createdAt: date + 'T12:00:00.000Z' } : {});
  db.prepare("UPDATE leads SET outreach_status = 'M' WHERE id = ? AND outreach_status = ''").run(id);
  made++;
}
console.log(apply ? `Done: ${made} meetings added, ${skipped} skipped.` : `Dry run: nothing written. Run with --apply.`);
