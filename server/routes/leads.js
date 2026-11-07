import { WORK_CASE, WORK_KEYS, WORK_GROUPS, workOrder } from '../lib/work.js';
import { Router } from 'express';
import { STAGES, QUALITIES, MANUAL_TYPES, FIRST_TOUCH_TYPES, COMPANY_VIEW_TYPE, MEETING_TYPES, LINK_KINDS, LEAD_CATEGORIES, TIERS, OUTREACH_STATUSES, CHANNELS, legacyPathToQuality } from '../config.js';
import { HttpError, logActivity, tx } from '../db.js';
import { dedupeKey, hasIdentity, findExisting } from '../lib/leadkey.js';
import { requireAdmin } from '../auth.js';
import { rangeBounds } from '../lib/range.js';
import { cleanUrl, detectKind, isKind } from '../lib/links.js';
import { createMeeting } from '../lib/meetings.js';
import { todayLocal, addDays } from '../lib/kpi.js';
import { nextStep } from '../lib/cadence.js';
import { getRules } from '../lib/rules.js';

const TEXT_FIELDS = [
  'first_name', 'last_name', 'title', 'company', 'email', 'email_status', 'phone',
  'linkedin', 'company_linkedin', 'website', 'employees', 'industry', 'city', 'state',
  'country', 'source', 'icp_segment', 'notes', 'next_action',
  'problem_pool', 'why_in_pipeline', 'todays_question', 'denial_reason', 'assessment',
];
const DATE_FIELDS = ['next_action_date', 'invite_sent_date', 'accepted_date', 'first_dm_date'];
// Dropdown fields: '' (blank) or one of the allowed values.
const ENUM_FIELDS = {
  lead_category: LEAD_CATEGORIES,
  tier: TIERS,
  outreach_status: Object.keys(OUTREACH_STATUSES),
  channel: CHANNELS,
};
// Sort keys the UI can ask for. `blank` = rows with an empty value always go last.
const stageCase = 'CASE l.stage ' + STAGES.map((st, i) => `WHEN '${st}' THEN ${i}`).join(' ') + ' ELSE 99 END';
const SORTS = {
  get work() { return { expr: workOrder(todayLocal()) }; },
  updated_at: { expr: 'l.updated_at' },
  created_at: { expr: 'l.created_at' },
  name: { expr: "LOWER(l.first_name || ' ' || l.last_name)" },
  first_name: { expr: "LOWER(l.first_name || ' ' || l.last_name)" },
  company: { expr: 'LOWER(l.company)', blank: 'l.company' },
  owner: { expr: 'LOWER(u.name)', blank: 'u.name' },
  stage: { expr: stageCase },
  quality: { expr: 'l.quality', blank: 'l.quality' },
  last_activity_at: { expr: 'l.last_activity_at', blank: 'l.last_activity_at' },
  touches: { expr: 'activity_count' },
  next_action_date: { expr: 'l.next_action_date', blank: 'l.next_action_date' },
  meeting_date: { expr: 'l.meeting_date', blank: 'l.meeting_date' },
};
// Activity kinds that are not outreach touches (shown in history, not counted).
const NON_TOUCH = ['edit', 'assign', 'stage_change', 'quality_change', 'meeting_date', 'trashed', 'restored', ...MEETING_TYPES];
const NON_TOUCH_SQL = NON_TOUCH.map((t) => `'${t}'`).join(',');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const label = (f) => f.replace(/_/g, ' ');

export function leadsRoutes(db) {
  const r = Router();
  const userById = (id) => db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(id);

  // ── shared: validate + apply changes to one lead, logging each one ──────────
  function applyChanges(lead, input, user) {
    // Old clients may still send opportunity_path: it now means Quality.
    if ('opportunity_path' in input) { const { opportunity_path: op, ...rest } = input; const q = legacyPathToQuality(op); if (String(op ?? '').trim() && !q) throw new HttpError(400, `Unknown lead type "${op}"`); input = 'quality' in rest ? rest : { ...rest, quality: q }; }
    const set = {};
    for (const f of TEXT_FIELDS) {
      if (!(f in input)) continue;
      const v = /^(null|undefined|n\/a)$/i.test(String(input[f] ?? '').trim()) ? '' : String(input[f] ?? '').trim();
      if (v !== lead[f]) set[f] = v;
    }
    for (const f of DATE_FIELDS) {
      if (!(f in input)) continue;
      const v = String(input[f] ?? '').trim();
      if (v && !DATE_RE.test(v)) throw new HttpError(400, `${label(f)} must be YYYY-MM-DD`);
      if (v !== lead[f]) set[f] = v;
    }
    for (const [f, allowed] of Object.entries(ENUM_FIELDS)) {
      if (!(f in input)) continue;
      const v = String(input[f] ?? '').trim();
      if (v && !allowed.includes(v)) throw new HttpError(400, `Unknown ${label(f)} "${v}"`);
      if (v !== lead[f]) set[f] = v;
    }
    if ('stage' in input && input.stage !== lead.stage) {
      if (!STAGES.includes(input.stage)) throw new HttpError(400, `Unknown stage "${input.stage}"`);
      set.stage = input.stage;
    }
    if ('quality' in input) {
      const q = input.quality || '';
      if (q && !QUALITIES.includes(q)) throw new HttpError(400, `Unknown quality "${q}"`);
      if (q !== lead.quality) set.quality = q;
    }
    let newOwner;
    if ('owner_id' in input) {
      const id = input.owner_id === null || input.owner_id === '' ? null : Number(input.owner_id);
      if (id !== null && !userById(id)) throw new HttpError(400, 'Unknown or inactive user');
      if (id !== lead.owner_id) { set.owner_id = id; newOwner = id; }
    }
    if (Object.keys(set).length === 0) return lead;

    const keyFields = ['email', 'linkedin', 'first_name', 'last_name', 'company'];
    if (keyFields.some((f) => f in set)) {
      const merged = { ...lead, ...set };
      if (!hasIdentity(merged)) throw new HttpError(400, 'A lead needs a name, email or LinkedIn');
      const key = dedupeKey(merged);
      if (key !== lead.dedupe_key) set.dedupe_key = key;
    }

    const now = new Date().toISOString();
    const cols = Object.keys(set);
    try {
      db.prepare(`UPDATE leads SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...cols.map((c) => set[c]), now, lead.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Another lead already has this email / LinkedIn');
      throw e;
    }

    const log = (type, note, meta) => logActivity(db, { lead_id: lead.id, user_id: user.id, type, note, meta });
    if ('stage' in set) log('stage_change', `${lead.stage} → ${set.stage}`, { from: lead.stage, to: set.stage });
    if ('quality' in set) log('quality_change', `${lead.quality || 'Unrated'} → ${set.quality || 'Unrated'}`, { from: lead.quality, to: set.quality });
    if ('owner_id' in set) {
      const from = lead.owner_id ? userById(lead.owner_id)?.name || db.prepare('SELECT name FROM users WHERE id=?').get(lead.owner_id)?.name : null;
      const to = newOwner ? userById(newOwner).name : null;
      log('assign', `${from || 'Unassigned'} → ${to || 'Unassigned'}`, { from_id: lead.owner_id, to_id: newOwner });
    }
    if ('outreach_status' in set) {
      const nm = (c) => OUTREACH_STATUSES[c] || 'No response data';
      log('response_change', `${nm(lead.outreach_status)} → ${nm(set.outreach_status)}`, { from: lead.outreach_status, to: set.outreach_status });
    }
    const other = cols.filter((c) => !['stage', 'quality', 'owner_id', 'dedupe_key', 'outreach_status'].includes(c));
    if (other.length) log('edit', 'Edited: ' + other.map(label).join(', '));

    return db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
  }

  // ── filters shared by list / ids ────────────────────────────────────────────
  function buildWhere(q, user) {
    const where = ["l.deleted_at = ''"];
    const params = [];
    const terms = String(q.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of terms) {
      where.push("LOWER(l.first_name || ' ' || l.last_name || ' ' || l.company || ' ' || l.email || ' ' || l.title) LIKE ?");
      params.push(`%${t}%`);
    }
    if (q.owner === 'none') where.push('l.owner_id IS NULL');
    else if (q.owner === 'me') { where.push('l.owner_id = ?'); params.push(user.id); }
    else if (q.owner) { where.push('l.owner_id = ?'); params.push(Number(q.owner)); }
    if (q.stage) { where.push('l.stage = ?'); params.push(q.stage); }
    for (const f of ['lead_category', 'tier', 'outreach_status', 'channel']) {
      if (q[f] === 'none') where.push(`l.${f} = ''`);
      else if (q[f]) { where.push(`l.${f} = ?`); params.push(q[f]); }
    }
    if (q.followup === 'due') { where.push("l.next_action_date != '' AND l.next_action_date <= ?"); params.push(todayLocal()); }
    if (q.quality === 'none') where.push("l.quality = ''");
    else if (q.quality) { where.push('l.quality = ?'); params.push(q.quality); }
    if (q.source) { where.push('l.source = ?'); params.push(q.source); }
    if (q.untouched === '1') where.push("l.last_activity_at = ''");
    if (WORK_GROUPS[q.work]) { where.push(`${WORK_CASE} IN (${WORK_GROUPS[q.work].map(() => '?').join(',')})`); params.push(...WORK_GROUPS[q.work]); }
    else if (WORK_KEYS.includes(q.work)) { where.push(`${WORK_CASE} = ?`); params.push(q.work); }
    if (q.meeting === '1') where.push("l.meeting_date != ''");
    if (q.due === '1') { where.push("l.next_action_date != '' AND l.next_action_date <= ?"); params.push(todayLocal()); }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }

  r.get('/', (req, res) => {
    const { sql, params } = buildWhere(req.query, req.user);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const sd = SORTS[req.query.sort] || SORTS.updated_at;
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const order = `${sd.blank ? `(${sd.blank} IS NULL OR ${sd.blank} = '') ASC, ` : ''}${sd.expr} ${dir}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM leads l ${sql}`).get(...params).n;
    const rows = db.prepare(
      `SELECT l.*, u.name AS owner_name, ${WORK_CASE} AS work,
              (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id AND a.type NOT IN (${NON_TOUCH_SQL})) AS activity_count,
              (SELECT a.type FROM activities a WHERE a.lead_id = l.id AND a.type NOT IN (${NON_TOUCH_SQL}) ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS last_type,
              (SELECT url FROM lead_links k WHERE k.lead_id = l.id AND k.kind = 'drive' ORDER BY k.id LIMIT 1) AS drive_url,
              (SELECT url FROM lead_links k WHERE k.lead_id = l.id AND k.kind = 'chatgpt' ORDER BY k.id LIMIT 1) AS chatgpt_url,
              (SELECT COUNT(*) FROM lead_links k WHERE k.lead_id = l.id) AS link_count
       FROM leads l LEFT JOIN users u ON u.id = l.owner_id
       ${sql} ORDER BY ${order}, l.id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, (page - 1) * limit);
    res.json({ rows, total, page, limit });
  });

  r.get('/ids', (req, res) => {
    const { sql, params } = buildWhere(req.query, req.user);
    const ids = db.prepare(`SELECT l.id FROM leads l ${sql} ORDER BY l.id LIMIT 5000`).all(...params).map((x) => x.id);
    res.json({ ids });
  });

  // Counts per working stage (for the tabs above the table), for one owner or everyone.
  r.get('/work-counts', (req, res) => {
    const o = req.query.owner;
    const cond = o === 'none' ? 'AND l.owner_id IS NULL' : o ? 'AND l.owner_id = ?' : '';
    const rows = db.prepare(`SELECT ${WORK_CASE} AS k, COUNT(*) AS n FROM leads l WHERE l.deleted_at = '' ${cond} GROUP BY 1`).all(...(o && o !== 'none' ? [Number(o)] : []));
    const out = Object.fromEntries(rows.map((x) => [x.k, x.n]));
    for (const [g, keys] of Object.entries(WORK_GROUPS)) out[g] = keys.reduce((a, k) => a + (out[k] || 0), 0);
    res.json(out);
  });

  r.get('/facets', (_req, res) => {
    const today = todayLocal();
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    const count = (col) => Object.fromEntries(db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM leads WHERE deleted_at = '' GROUP BY ${col}`).all().map((x) => [x.k ?? '', x.n]));
    res.json({
      total: db.prepare("SELECT COUNT(*) AS n FROM leads WHERE deleted_at = ''").get().n,
      trash: db.prepare("SELECT COUNT(*) AS n FROM leads WHERE deleted_at != ''").get().n,
      untouched: one("SELECT COUNT(*) AS n FROM leads WHERE deleted_at = '' AND last_activity_at = ''"),
      meetings: one("SELECT COUNT(*) AS n FROM leads WHERE deleted_at = '' AND meeting_date != ''"),
      upcomingMeetings: one("SELECT COUNT(*) AS n FROM leads WHERE deleted_at = '' AND meeting_status = 'booked' AND meeting_date >= ?", today),
      due: one("SELECT COUNT(*) AS n FROM leads WHERE deleted_at = '' AND next_action_date != '' AND next_action_date <= ?", today),
      stages: count('stage'),
      qualities: count('quality'),
      owners: count('owner_id'),
      sources: db.prepare("SELECT source AS k, COUNT(*) AS n FROM leads WHERE deleted_at = '' AND source != '' GROUP BY source ORDER BY n DESC").all(),
    });
  });

  r.post('/', (req, res) => {
    const input = req.body || {};
    const lead = Object.fromEntries(TEXT_FIELDS.map((f) => [f, /^(null|undefined|n\/a)$/i.test(String(input[f] ?? '').trim()) ? '' : String(input[f] ?? '').trim()]));
    if (!hasIdentity(lead)) throw new HttpError(400, 'Enter at least a name, email or LinkedIn');
    // Never create a second copy: if this person is already in the CRM (same email, LinkedIn, or name + company)
    // add the new information to the existing lead instead.
    const key = dedupeKey(lead);
    const dup = findExisting(db, lead);
    if (dup) {
      const filled = [];
      const set = {};
      for (const f of TEXT_FIELDS) {
        if (!lead[f]) continue;
        if (!dup[f]) { set[f] = lead[f]; filled.push(label(f)); }
        else if (f === 'notes' && !dup.notes.includes(lead.notes)) { set.notes = dup.notes + '\n' + lead.notes; filled.push(label(f)); }
      }
      const restored = !!dup.deleted_at;
      if (restored) { set.deleted_at = ''; set.deleted_by = null; }
      const cols = Object.keys(set);
      tx(db, () => {
        if (cols.length) db.prepare(`UPDATE leads SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => set[c]), new Date().toISOString(), dup.id);
        logActivity(db, { lead_id: dup.id, user_id: req.user.id, type: 'edit', note: filled.length ? 'Already in CRM: added ' + filled.join(', ') : 'Already in CRM: nothing new to add' });
      });
      return res.json({ id: dup.id, existing: true, restored, filled });
    }
    const now = new Date().toISOString();
    const cols = [...TEXT_FIELDS, 'dedupe_key', 'owner_id', 'created_at', 'updated_at'];
    const owner = input.owner_id ? Number(input.owner_id) : req.user.id;
    const id = tx(db, () => {
      const info = db.prepare(`INSERT INTO leads(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...TEXT_FIELDS.map((f) => lead[f]), key, owner, now, now);
      logActivity(db, { lead_id: Number(info.lastInsertRowid), user_id: req.user.id, type: 'note', note: 'Lead added manually' });
      return Number(info.lastInsertRowid);
    });
    res.status(201).json({ id });
  });

  r.post('/bulk', (req, res) => {
    const { ids, set } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'No leads selected');
    if (ids.length > 5000) throw new HttpError(400, 'Select at most 5000 leads at a time');
    const allowed = {};
    for (const k of ['owner_id', 'stage', 'quality']) if (set && k in set) allowed[k] = set[k];
    if (Object.keys(allowed).length === 0) throw new HttpError(400, 'Nothing to change');
    let changed = 0;
    tx(db, () => {
      const get = db.prepare('SELECT * FROM leads WHERE id = ?');
      for (const id of ids) {
        const lead = get.get(Number(id));
        if (!lead || lead.deleted_at) continue;
        const after = applyChanges(lead, allowed, req.user);
        if (after !== lead) changed++;
      }
    });
    res.json({ changed });
  });

  // ── Recycle bin (admin only) ────────────────────────────────────────────────
  // "Delete" moves a lead to the bin. Only "purge" removes it for good.
  const idList = (body) => {
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'No leads selected');
    if (ids.length > 5000) throw new HttpError(400, 'Select at most 5000 leads at a time');
    return ids.map(Number).filter(Boolean);
  };

  function moveToBin(ids, user) {
    const now = new Date().toISOString();
    let n = 0;
    tx(db, () => {
      const upd = db.prepare("UPDATE leads SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at = ''");
      for (const id of ids) {
        if (!Number(upd.run(now, user.id, id).changes)) continue;
        logActivity(db, { lead_id: id, user_id: user.id, type: 'trashed', at: now });
        n++;
      }
    });
    return n;
  }

  r.post('/bulk-delete', requireAdmin, (req, res) => res.json({ deleted: moveToBin(idList(req.body), req.user) }));

  r.get('/trash', requireAdmin, (req, res) => {
    const terms = String(req.query.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const where = ["l.deleted_at != ''"];
    const params = [];
    for (const t of terms) {
      where.push("LOWER(l.first_name || ' ' || l.last_name || ' ' || l.company || ' ' || l.email) LIKE ?");
      params.push(`%${t}%`);
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const sql = 'WHERE ' + where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM leads l ${sql}`).get(...params).n;
    const rows = db.prepare(
      `SELECT l.*, o.name AS owner_name, d.name AS deleted_by_name,
              (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id) AS activity_count
       FROM leads l LEFT JOIN users o ON o.id = l.owner_id LEFT JOIN users d ON d.id = l.deleted_by
       ${sql} ORDER BY l.deleted_at DESC, l.id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, (page - 1) * limit);
    res.json({ rows, total, page, limit });
  });

  r.get('/trash/ids', requireAdmin, (_req, res) => {
    res.json({ ids: db.prepare("SELECT id FROM leads WHERE deleted_at != '' ORDER BY id LIMIT 5000").all().map((x) => x.id) });
  });

  r.post('/restore', requireAdmin, (req, res) => {
    const ids = idList(req.body);
    const now = new Date().toISOString();
    let n = 0;
    tx(db, () => {
      const upd = db.prepare("UPDATE leads SET deleted_at = '', deleted_by = NULL WHERE id = ? AND deleted_at != ''");
      for (const id of ids) {
        if (!Number(upd.run(id).changes)) continue;
        logActivity(db, { lead_id: id, user_id: req.user.id, type: 'restored', at: now });
        n++;
      }
    });
    res.json({ restored: n });
  });

  // Permanent delete. Only works on leads that are already in the bin.
  r.post('/purge', requireAdmin, (req, res) => {
    const ids = req.body?.all ? db.prepare("SELECT id FROM leads WHERE deleted_at != ''").all().map((x) => x.id) : idList(req.body);
    let n = 0;
    tx(db, () => {
      const del = db.prepare("DELETE FROM leads WHERE id = ? AND deleted_at != ''");
      for (const id of ids) n += Number(del.run(id).changes);
    });
    res.json({ purged: n });
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM leads WHERE id = ? AND deleted_at = \'\'').get(id)) throw new HttpError(404, 'Lead not found');
    moveToBin([id], req.user);
    res.json({ deleted: 1 });
  });

  // Today's queue: leads whose next outreach step has come due (playbook cadence + scheduled follow-ups).
  r.get('/queue', (req, res) => {
    const today = todayLocal();
    const rules = getRules(db);
    const where = ["deleted_at = ''", "(invite_sent_date != '' OR accepted_date != '' OR first_dm_date != '' OR next_action_date != '')"];
    const params = [];
    const owner = req.query.owner === 'me' || !req.query.owner ? req.user.id : req.query.owner === 'all' ? null : Number(req.query.owner);
    if (owner !== null) { where.push('owner_id = ?'); params.push(owner); }
    const rows = db.prepare(`SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE ${where.join(' AND ')}`).all(...params);
    const items = [];
    for (const l of rows) {
      const s = nextStep(l, today, rules);
      if (!s) continue;
      items.push({ id: l.id, name: `${l.first_name} ${l.last_name}`.trim(), company: l.company, title: l.title, owner_id: l.owner_id, owner_name: l.owner_name,
        outreach_status: l.outreach_status, stage: l.stage, due: s.due, overdue_days: Math.round((Date.parse(today) - Date.parse(s.due)) / 86400000), action: s.action, reason: s.reason,
        todays_question: l.todays_question });
    }
    items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id - b.id));
    res.json({ today, total: items.length, items: items.slice(0, 300) });
  });

  // Outreach funnel: counts per step, with rates. Optional ?owner=<id>.
  r.get('/funnel', (req, res) => {
    const where = ["deleted_at = ''"];
    const params = [];
    if (req.query.owner) { where.push('owner_id = ?'); params.push(Number(req.query.owner)); }
    const w = where.join(' AND ');
    const n = (extra = '1=1') => db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${w} AND ${extra}`).get(...params).n;
    const f = {
      researched: n(),
      invited: n("invite_sent_date != ''"),
      accepted: n("accepted_date != ''"),
      firstDm: n("first_dm_date != ''"),
      replied: n("outreach_status IN ('R','M','NUTR','NI')"),
      meetings: n("outreach_status = 'M' OR stage IN ('Meeting Booked','Meeting Done')"),
    };
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const rates = { acceptance: pct(f.accepted, f.invited), reply: pct(f.replied, f.firstDm), meeting: pct(f.meetings, f.replied) };
    const by = (col) => Object.fromEntries(db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM leads WHERE ${w} GROUP BY ${col}`).all(...params).map((x) => [x.k || '', x.n]));
    res.json({ counts: f, rates, byStatus: by('outreach_status'), byCategory: by('lead_category'), byPath: by('quality'), byTier: by('tier') });
  });

  r.get('/:id', (req, res) => {
    const lead = db.prepare('SELECT l.*, u.name AS owner_name, d.name AS deleted_by_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN users d ON d.id = l.deleted_by WHERE l.id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    const activities = db.prepare(
      `SELECT a.id, a.type, a.note, a.created_at, a.user_id, u.name AS user_name
       FROM activities a JOIN users u ON u.id = a.user_id
       WHERE a.lead_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 300`
    ).all(lead.id);
    const meetings = db.prepare(
      `SELECT m.*, b.name AS booked_by_name FROM meetings m LEFT JOIN users b ON b.id = m.booked_by
       WHERE m.lead_id = ? ORDER BY m.scheduled_date DESC, m.scheduled_time DESC, m.id DESC`
    ).all(lead.id);
    const links = db.prepare('SELECT id, kind, label, url, created_at FROM lead_links WHERE lead_id = ? ORDER BY id').all(lead.id);
    res.json({ lead, activities, meetings, links });
  });

  const liveLead = (id) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    return lead;
  };

  // Auto-log "I opened this LinkedIn page". One entry per person, per lead, per kind, per Dhaka day.
  r.post('/:id/visit', (req, res) => {
    const lead = liveLead(req.params.id);
    const type = req.body?.kind === 'company' ? COMPANY_VIEW_TYPE : 'linkedin_view';
    const day = rangeBounds('today');
    const seen = db.prepare('SELECT 1 FROM activities WHERE lead_id = ? AND user_id = ? AND type = ? AND created_at >= ? AND created_at < ?')
      .get(lead.id, req.user.id, type, day.start, day.end);
    if (seen) return res.json({ logged: false });
    logActivity(db, { lead_id: lead.id, user_id: req.user.id, type, note: 'Opened from CRM' });
    res.status(201).json({ logged: true });
  });

  r.post('/:id/meetings', (req, res) => {
    const lead = liveLead(req.params.id);
    const id = tx(db, () => createMeeting(db, lead, req.body || {}, req.user));
    res.status(201).json({ id });
  });

  r.post('/:id/links', (req, res) => {
    const lead = liveLead(req.params.id);
    let url;
    try { url = cleanUrl(req.body?.url); } catch (e) { throw new HttpError(400, e.message); }
    const kind = isKind(req.body?.kind) ? req.body.kind : detectKind(url);
    if (db.prepare('SELECT COUNT(*) AS n FROM lead_links WHERE lead_id = ?').get(lead.id).n >= 30) throw new HttpError(400, 'Too many links on this lead');
    if (db.prepare('SELECT 1 FROM lead_links WHERE lead_id = ? AND url = ?').get(lead.id, url)) throw new HttpError(409, 'This link is already added');
    const label = String(req.body?.label || '').trim().slice(0, 80);
    const now = new Date().toISOString();
    const info = db.prepare('INSERT INTO lead_links(lead_id, kind, label, url, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(lead.id, kind, label, url, req.user.id, now);
    logActivity(db, { lead_id: lead.id, user_id: req.user.id, type: 'edit', note: `Added ${LINK_KINDS[kind]} link`, at: now });
    res.status(201).json({ id: Number(info.lastInsertRowid), kind, url, label });
  });

  r.delete('/:id/links/:linkId', (req, res) => {
    const lead = liveLead(req.params.id);
    const del = db.prepare('DELETE FROM lead_links WHERE id = ? AND lead_id = ?').run(Number(req.params.linkId), lead.id);
    if (!Number(del.changes)) throw new HttpError(404, 'Link not found');
    logActivity(db, { lead_id: lead.id, user_id: req.user.id, type: 'edit', note: 'Removed a link' });
    res.json({ ok: true });
  });

  r.patch('/:id', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    const updated = tx(db, () => applyChanges(lead, req.body || {}, req.user));
    res.json({ lead: updated });
  });

  // Logs one outreach action and fills the funnel dates / next follow-up the first time it happens.
  function recordActivity(lead, type, text, user) {
      logActivity(db, { lead_id: lead.id, user_id: user.id, type, note: text });
      // Fill the outreach funnel dates the first time each step is logged.
      const today = todayLocal();
      const auto = { linkedin_connect: ['invite_sent_date', 'U', 'LinkedIn'], linkedin_connected: ['accepted_date'], linkedin_dm: ['first_dm_date'] }[type];
      if (auto) {
        const [col, status, channel] = auto;
        if (!lead[col]) db.prepare(`UPDATE leads SET ${col} = ? WHERE id = ?`).run(today, lead.id);
        if (status && !lead.outreach_status) db.prepare('UPDATE leads SET outreach_status = ? WHERE id = ?').run(status, lead.id);
        if (channel && !lead.channel) db.prepare('UPDATE leads SET channel = ? WHERE id = ?').run(channel, lead.id);
      }
      // Pre-fill the next follow-up from the cadence (never overwrites a date someone already set).
      const follow = { linkedin_connect: [7, 'Day 7: check whether the invite was accepted'], linkedin_dm: [7, 'Day 7 follow-up if no reply'] }[type];
      if (follow && !lead.next_action_date) {
        db.prepare('UPDATE leads SET next_action_date = ?, next_action = CASE WHEN next_action = \'\' THEN ? ELSE next_action END WHERE id = ?').run(addDays(today, follow[0]), follow[1], lead.id);
      }
      if (lead.stage === 'New' && FIRST_TOUCH_TYPES.includes(type)) {
        applyChanges(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id), { stage: 'Contacted' }, user);
      }
  }

  // One-click result of a planned step. The Plan page sends { result, kind } and this works out what to log and when
  // the lead comes back: accepted | pending | sent | seen | replied | nurture | not_interested | snooze.
  const RESULTS = ['comment', 'accepted', 'pending', 'sent', 'seen', 'replied', 'nurture', 'not_interested', 'snooze'];
  r.post('/:id/step', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    const { result, kind } = req.body || {};
    const note = String(req.body?.note || '').trim().slice(0, 2000); // the message / comment text, for the EOD report
    if (!RESULTS.includes(result)) throw new HttpError(400, 'Unknown result');
    const today = todayLocal();
    const rules = getRules(db);
    const plan = (date, text) => db.prepare("UPDATE leads SET next_action_date = ?, next_action = ?, snooze_until = '', updated_at = ? WHERE id = ?").run(date, text, new Date().toISOString(), lead.id);
    const snooze = (date) => db.prepare('UPDATE leads SET snooze_until = ?, updated_at = ? WHERE id = ?').run(date, new Date().toISOString(), lead.id);
    const fresh = () => db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    tx(db, () => {
      if (result === 'comment') {
        recordActivity(lead, 'linkedin_comment', note, req.user);
      } else if (result === 'accepted') {
        recordActivity(lead, 'linkedin_connected', note, req.user);
        plan(today, 'Send the first message');
      } else if (result === 'pending') {
        logActivity(db, { lead_id: lead.id, user_id: req.user.id, type: 'note', note: 'Invite still pending' });
        snooze(addDays(today, rules.pending_recheck_days));
      } else if (result === 'sent') {
        const email = kind === 'email';
        recordActivity(lead, email ? 'email' : 'linkedin_dm', note, req.user);
        const cur = fresh();
        if (['', 'U', 'SNR'].includes(cur.outreach_status)) applyChanges(cur, { outreach_status: 'U' }, req.user);
        if (email) plan(addDays(today, rules.followup1_day), 'Email sent. Check for a reply, otherwise comment on their post');
        else if (kind === 'last_followup') plan(addDays(today, rules.nurture_days), 'Two messages unanswered. Only like or comment on their posts');
        else if (kind === 'reply' || cur.outreach_status === 'R') plan(addDays(today, rules.pending_recheck_days), 'Check if they answered');
        else if (kind === 'followup') {
          const day14 = addDays(cur.first_dm_date || today, rules.followup2_day);
          plan('', ''); snooze(day14 <= today ? addDays(today, 4) : day14);
        } else plan('', '');
      } else if (result === 'seen') {
        applyChanges(lead, { outreach_status: 'SNR' }, req.user);
      } else if (result === 'replied') {
        applyChanges(lead, { outreach_status: 'R', ...(['New', 'Contacted'].includes(lead.stage) ? { stage: 'Replied' } : {}) }, req.user);
        plan('', '');
      } else if (result === 'nurture') {
        applyChanges(lead, { outreach_status: 'NUTR' }, req.user);
        plan(addDays(today, rules.nurture_days), 'Nurture: like or comment on their posts, check back');
      } else if (result === 'not_interested') {
        applyChanges(lead, { outreach_status: 'NI' }, req.user);
        plan('', '');
      } else if (result === 'snooze') {
        snooze(addDays(today, Math.min(30, Math.max(1, Number(req.body.days) || 1))));
      }
    });
    res.json({ lead: fresh() });
  });

  r.post('/:id/activities', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    const { type, note } = req.body || {};
    if (!(type in MANUAL_TYPES)) throw new HttpError(400, 'Unknown activity type');
    const text = String(note || '').trim();
    if (type === 'note' && !text) throw new HttpError(400, 'Write a note first');
    tx(db, () => recordActivity(lead, type, text, req.user));
    res.status(201).json({ ok: true });
  });

  return r;
}
