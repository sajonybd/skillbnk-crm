import { Router } from 'express';
import { HttpError, tx } from '../db.js';
import { analyze, buildLeads, dedupeKey, IMPORT_FIELDS } from '../lib/importer.js';
import { findExisting } from '../lib/leadkey.js';
import { createPlaceholderUser } from './team.js';
import { createMeeting } from '../lib/meetings.js';
import { TEAM, LEAD_CATEGORIES, TIERS, OUTREACH_STATUSES, CHANNELS, OPPORTUNITY_PATHS } from '../config.js';
import { parseMeetings, parseActivityLog, dayOf } from '../lib/sheet-sync.js';
import { logActivity } from '../db.js';

const COLS = [
  'first_name', 'last_name', 'title', 'company', 'email', 'email_status', 'phone', 'linkedin',
  'company_linkedin', 'website', 'employees', 'industry', 'city', 'state', 'country', 'source',
  'icp_segment', 'stage', 'quality', 'next_action', 'next_action_date', 'notes', 'apollo_id',
  'lead_category', 'tier', 'outreach_status', 'channel', 'opportunity_path', 'problem_pool', 'why_in_pipeline',
  'todays_question', 'denial_reason', 'assessment', 'invite_sent_date', 'accepted_date', 'first_dm_date',
];
// Dropdown-type fields: a value that is not in the allowed list is dropped rather than stored.
const ENUMS = { lead_category: LEAD_CATEGORIES, tier: TIERS, outreach_status: Object.keys(OUTREACH_STATUSES), channel: CHANNELS, opportunity_path: OPPORTUNITY_PATHS };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Accepts 2026-11-05 or any date text JS can read ("Nov 5, 2026"); returns YYYY-MM-DD or ''.
function meetingDate(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const ms = Date.parse(t + ' 12:00 UTC');
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString().slice(0, 10);
}

export function importRoutes(db) {
  const r = Router();
  // "Update existing": fill only the blanks of a lead that is already in the CRM and add missing history.
  // Never overwrites a value someone typed, never moves the stage backwards.
  function fillExisting(cur, l, history, ownerId, user, result) {
    if (!cur || cur.deleted_at) return;
    const set = {};
    for (const c of COLS) {
      if (c === 'stage' || c === 'notes' || c === 'apollo_id') continue;
      if (cur[c] === '' && l[c]) set[c] = l[c];
    }
    if (cur.stage === 'New' && l.stage && l.stage !== 'New') set.stage = l.stage;
    if (!cur.owner_id && ownerId) set.owner_id = ownerId;
    if (!cur.notes && l.notes) set.notes = l.notes;
    const cols = Object.keys(set);
    if (cols.length) db.prepare(`UPDATE leads SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => set[c]), new Date().toISOString(), cur.id);
    let added = 0;
    const have = db.prepare('SELECT 1 FROM activities WHERE lead_id = ? AND user_id = ? AND type = ? AND created_at = ?');
    for (const h of history) {
      const uid = userByNameAll.get(h.who.toLowerCase()) || user.id;
      if (have.get(cur.id, uid, h.type, h.at)) continue;
      logActivity(db, { lead_id: cur.id, user_id: uid, type: h.type, note: h.note, at: h.at });
      added++;
    }
    const last = history.map((h) => h.at).sort().at(-1) || '';
    if (last) db.prepare('UPDATE leads SET last_activity_at = ? WHERE id = ? AND last_activity_at < ?').run(last, cur.id, last);
    let met = 0;
    if (!db.prepare('SELECT 1 FROM meetings WHERE lead_id = ?').get(cur.id)) {
      for (const mt of parseMeetings(l.meeting_date, { held: !!l.stage_held })) {
        const createdAt = new Date(Math.min(Date.now(), Date.parse(mt.date + 'T06:00:00Z'))).toISOString();
        createMeeting(db, { id: cur.id, owner_id: cur.owner_id }, { scheduled_date: mt.date, scheduled_time: mt.time, status: mt.status, notes: mt.note, booked_by: cur.owner_id || user.id }, user, { quiet: true, createdAt });
        met++;
      }
    }
    if (cols.length || added || met) { result.updated++; result.activities += added; result.meetings += met; }
  }
  const userByNameAll = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.name.toLowerCase(), u.id]));
  const inBin = db.prepare("SELECT 1 FROM leads WHERE dedupe_key = ? AND deleted_at != ''");

  // Step 1 — read the file, guess the column mapping, count new vs duplicate rows.
  r.post('/preview', (req, res) => {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) throw new HttpError(400, 'Paste some data or choose a file first');
    const a = analyze(text);
    if (a.headers.length === 0) throw new HttpError(400, 'Could not read any rows');
    const { leads, invalid } = buildLeads(a.rows, a.mapping);
    const seen = new Set();
    let fresh = 0;
    let dupes = 0;
    let trashed = 0;
    for (const l of leads) {
      const k = dedupeKey(l);
      const ex = findExisting(db, l);
      if (ex?.deleted_at) trashed++;
      if (seen.has(k) || ex) dupes++;
      else { fresh++; seen.add(k); }
    }
    res.json({
      headers: a.headers,
      mapping: a.mapping,
      fields: IMPORT_FIELDS,
      totalRows: a.rows.length,
      newCount: fresh,
      duplicateCount: dupes,
      trashedCount: trashed,
      invalidCount: invalid,
      sample: a.rows.slice(0, 5),
    });
  });

  // Step 2 — import for real.
  // assign: { mode: 'none' | 'user' | 'split', user_ids: [] }
  r.post('/commit', (req, res) => {
    const { text, mapping, source, assign, update } = req.body || {};
    if (!text || !Array.isArray(mapping)) throw new HttpError(400, 'Missing data');
    const a = analyze(text);
    const { leads, invalid } = buildLeads(a.rows, mapping);

    const mode = assign?.mode || 'none';
    const pool = (assign?.user_ids || []).map(Number).filter(Boolean);
    if (mode !== 'none' && pool.length === 0) throw new HttpError(400, 'Pick at least one team member to assign to');
    for (const id of pool) {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(id)) throw new HttpError(400, 'Unknown team member');
    }

    const result = { totalRows: a.rows.length, updated: 0, created: 0, duplicates: 0, inBin: 0, invalid, activities: 0, meetings: 0, createdUsers: [], unknownOwners: {}, byOwner: {} };
    const userByName = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.name.toLowerCase(), u.id]));
    const ownerCache = new Map(); // lowercase name/email → user id
    const nameOf = new Map();
    const findUser = db.prepare('SELECT id, name FROM users WHERE LOWER(name) = ? OR LOWER(email) = ?');

    const resolveOwner = (raw) => {
      const k = raw.toLowerCase();
      if (ownerCache.has(k)) return ownerCache.get(k);
      let u = findUser.get(k, k);
      // Only people on the configured team get an account automatically. Any other name in the
      // Owner column (e.g. "TO CONFIRM") is not turned into a user: the lead is imported unassigned.
      if (!u && !TEAM.some((m) => m.name.toLowerCase() === k)) { ownerCache.set(k, null); return null; }
      if (!u) { u = createPlaceholderUser(db, raw); result.createdUsers.push(raw); }
      ownerCache.set(k, u.id);
      nameOf.set(u.id, u.name);
      return u.id;
    };

    const cols = [...COLS, 'dedupe_key', 'owner_id', 'created_at', 'updated_at'];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO leads(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    const poolNames = new Map(pool.map((id) => [id, db.prepare('SELECT name FROM users WHERE id = ?').get(id).name]));
    const now = new Date().toISOString();
    const label = String(source || '').trim();
    let rr = 0;

    tx(db, () => {
      for (const l of leads) {
        if (label && !l.source) l.source = label;
        let ownerId = null;
        let viaSplit = false;
        if (l.owner) {
          ownerId = resolveOwner(l.owner);
          if (ownerId === null) result.unknownOwners[l.owner] = (result.unknownOwners[l.owner] || 0) + 1;
        }
        else if (mode === 'user') ownerId = pool[0];
        else if (mode === 'split') { ownerId = pool[rr % pool.length]; viaSplit = true; }
        for (const [f, allowed] of Object.entries(ENUMS)) if (l[f] && !allowed.includes(l[f])) delete l[f];
        for (const f of ['invite_sent_date', 'accepted_date', 'first_dm_date']) if (l[f] && !ISO.test(l[f])) delete l[f];
        // Activity history written into the Notes cell ("[Oct 7, 2026, 10:38 AM - Name] Comment via …").
        const history = parseActivityLog(l.notes);
        const firstOf = (t) => history.filter((h) => h.type === t).map((h) => h.at).sort()[0];
        if (!l.invite_sent_date && firstOf('linkedin_connect')) l.invite_sent_date = dayOf(firstOf('linkedin_connect'));
        if (!l.accepted_date && firstOf('linkedin_connected')) l.accepted_date = dayOf(firstOf('linkedin_connected'));
        if (!l.first_dm_date && firstOf('linkedin_dm')) l.first_dm_date = dayOf(firstOf('linkedin_dm'));
        if (history.length && !l.channel) l.channel = 'LinkedIn';
        if (l.invite_sent_date && !l.outreach_status) l.outreach_status = 'U';
        const lastAt = history.map((h) => h.at).sort().at(-1) || '';
        const vals = COLS.map((c) => (c === 'stage' ? l.stage || 'New' : l[c] ?? ''));
        const ex = findExisting(db, l);
        const info = ex ? { changes: 0 } : insert.run(...vals, dedupeKey(l), ownerId, now, now);
        if (info.changes === 0) {
          result.duplicates++;
          if (ex?.deleted_at) result.inBin++;
          else if (update) fillExisting(ex || db.prepare("SELECT * FROM leads WHERE dedupe_key = ? AND deleted_at = ''").get(dedupeKey(l)), l, history, ownerId, req.user, result);
          continue;
        }
        if (viaSplit) rr++;
        result.created++;
        const leadId = Number(db.prepare('SELECT id FROM leads WHERE dedupe_key = ?').get(dedupeKey(l)).id);
        for (const h of history) {
          const uid = userByName.get(h.who.toLowerCase()) || req.user.id;
          logActivity(db, { lead_id: leadId, user_id: uid, type: h.type, note: h.note, at: h.at });
          result.activities++;
        }
        if (lastAt) db.prepare('UPDATE leads SET last_activity_at = ? WHERE id = ?').run(lastAt, leadId);
        const meetings = parseMeetings(l.meeting_date, { held: !!l.stage_held });
        for (const mt of meetings) {
          // Old meetings count towards the week they were scheduled in, not this week's KPI.
          const createdAt = new Date(Math.min(Date.now(), Date.parse(mt.date + 'T06:00:00Z'))).toISOString();
          createMeeting(db, { id: leadId, owner_id: ownerId }, { scheduled_date: mt.date, scheduled_time: mt.time, status: mt.status, notes: mt.note, booked_by: ownerId || req.user.id }, req.user, { quiet: true, createdAt });
          result.meetings++;
        }
        if (meetings.length && meetings.every((m) => m.status === 'cancelled')) db.prepare("UPDATE leads SET stage = 'Replied' WHERE id = ? AND stage = 'Meeting Booked'").run(leadId);
        if (meetings.length && !l.stage) db.prepare("UPDATE leads SET stage = ? WHERE id = ?").run(meetings.some((m) => m.status === 'completed') ? 'Meeting Done' : meetings.some((m) => m.status === 'booked') ? 'Meeting Booked' : 'New', leadId);
        const nm = ownerId ? nameOf.get(ownerId) || poolNames.get(ownerId) : 'Unassigned';
        result.byOwner[nm] = (result.byOwner[nm] || 0) + 1;
      }
    });
    res.json(result);
  });

  return r;
}
