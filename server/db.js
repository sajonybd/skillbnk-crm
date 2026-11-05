import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  email_status TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  linkedin TEXT NOT NULL DEFAULT '',
  company_linkedin TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  employees TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  icp_segment TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'New',
  quality TEXT NOT NULL DEFAULT '',
  meeting_date TEXT NOT NULL DEFAULT '',
  meeting_status TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  next_action_date TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id),
  apollo_id TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL DEFAULT '',
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_quality ON leads(quality);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_lead ON activities(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_act_time ON activities(created_at);
CREATE INDEX IF NOT EXISTS idx_act_user ON activities(user_id, created_at);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  booked_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  scheduled_date TEXT NOT NULL,
  scheduled_time TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked',
  notes TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_lead ON meetings(lead_id);
CREATE INDEX IF NOT EXISTS idx_meet_date ON meetings(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_meet_user ON meetings(booked_by, created_at);

CREATE TABLE IF NOT EXISTS lead_links (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other',
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_lead ON lead_links(lead_id);

CREATE TABLE IF NOT EXISTS kpi_targets (
  user_id INTEGER NOT NULL REFERENCES users(id),
  effective_week TEXT NOT NULL,
  target INTEGER NOT NULL,
  PRIMARY KEY (user_id, effective_week)
);

CREATE TABLE IF NOT EXISTS plan_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  admin_note TEXT NOT NULL DEFAULT '',
  decided_by INTEGER,
  created_at TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Migration for databases created before the recycle bin existed.
  const cols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
  if (!cols.includes('deleted_at')) {
    db.exec("ALTER TABLE leads ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''");
    db.exec('ALTER TABLE leads ADD COLUMN deleted_by INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_deleted ON leads(deleted_at)');
  // Meetings used to be a single date on the lead. Turn those into real meeting rows (once).
  if (!cols.includes('meeting_status')) {
    db.exec("ALTER TABLE leads ADD COLUMN meeting_status TEXT NOT NULL DEFAULT ''");
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    const old = db.prepare("SELECT id, owner_id, meeting_date, updated_at FROM leads WHERE meeting_date != ''").all();
    const ins = db.prepare("INSERT INTO meetings(lead_id, booked_by, created_by, scheduled_date, status, created_at, updated_at, status_changed_at) VALUES (?,?,?,?, 'booked', ?,?,?)");
    for (const l of old) {
      ins.run(l.id, l.owner_id || admin?.id || null, admin?.id || null, l.meeting_date, l.updated_at, l.updated_at, l.updated_at);
      db.prepare("UPDATE leads SET meeting_status = 'booked' WHERE id = ?").run(l.id);
    }
  }
  // Outreach funnel fields (Sections 40–42). Added once, existing rows get blanks.
  const OUTREACH_COLS = ['lead_category', 'tier', 'problem_pool', 'why_in_pipeline', 'todays_question', 'outreach_status', 'denial_reason', 'opportunity_path', 'channel', 'assessment', 'invite_sent_date', 'accepted_date', 'first_dm_date'];
  const have = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
  for (const c of OUTREACH_COLS) if (!have.includes(c)) db.exec(`ALTER TABLE leads ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_ostatus ON leads(outreach_status)');
  // "Not today": push a lead's next step to a later date without touching its history.
  if (!have.includes('snooze_until')) db.exec("ALTER TABLE leads ADD COLUMN snooze_until TEXT NOT NULL DEFAULT ''");
  // Placeholder text that came from spreadsheets ("null") is not a real next step.
  db.exec("UPDATE leads SET next_action = '' WHERE LOWER(TRIM(next_action)) IN ('null','undefined','none','n/a')");
  db.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL DEFAULT ''
  )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_tasks (
      id INTEGER PRIMARY KEY, code INTEGER, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'Medium',
      days TEXT NOT NULL DEFAULT '', time_window TEXT NOT NULL DEFAULT '', assignees TEXT NOT NULL DEFAULT '', expected TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_code ON ops_tasks(code) WHERE code IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ops_task_done (
      task_id INTEGER NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE, day TEXT NOT NULL, done_by INTEGER REFERENCES users(id), done_at TEXT NOT NULL,
      PRIMARY KEY (task_id, day)
    );
    CREATE TABLE IF NOT EXISTS member_targets (
      user_id INTEGER NOT NULL REFERENCES users(id), metric TEXT NOT NULL, daily_target INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, metric)
    );
  `);
  // Removed team members keep their history but disappear from the app.
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('removed_at')) db.exec("ALTER TABLE users ADD COLUMN removed_at TEXT NOT NULL DEFAULT ''");
  return db;
}

// Run fn inside a transaction; rolls back if it throws.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Types that should not bump "last activity" on the lead.
const QUIET_TYPES = new Set(['edit', 'trashed', 'restored']);

export function logActivity(db, { lead_id, user_id, type, note = '', meta = null, at }) {
  const now = at || new Date().toISOString();
  db.prepare(
    'INSERT INTO activities(lead_id, user_id, type, note, meta, created_at) VALUES (?,?,?,?,?,?)'
  ).run(lead_id, user_id, type, note, meta ? JSON.stringify(meta) : '', now);
  if (QUIET_TYPES.has(type)) {
    db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(now, lead_id);
  } else {
    db.prepare('UPDATE leads SET last_activity_at = ?, updated_at = ? WHERE id = ?').run(now, now, lead_id);
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
