import { fitOf } from '../lib/fit.js';
import { WORK_CASE, WORK_KEYS, WORK_GROUPS, workOrder } from '../lib/work.js';
import { Router } from 'express';
import { STAGES, QUALITIES, MANUAL_TYPES, FIRST_TOUCH_TYPES, COMPANY_VIEW_TYPE, MEETING_TYPES, LINK_KINDS, LEAD_CATEGORIES, TIERS, OUTREACH_STATUSES, CHANNELS, legacyPathToQuality, DRAFT_CHANNELS, DRAFT_SEND_WINDOW, DRAFT_LIMITS, DRAFT_REVIEW, APPROVAL_REQUIRED_CHANNELS, CEO_STATUS } from '../config.js';
import { HttpError, logActivity, tx } from '../db.js';
import { dedupeKey, hasIdentity, findExisting } from '../lib/leadkey.js';
import { requireAdmin } from '../auth.js';
import { rangeBounds } from '../lib/range.js';
import { cleanUrl, detectKind, isKind } from '../lib/links.js';
import { createMeeting } from '../lib/meetings.js';
import { todayLocal, addDays } from '../lib/kpi.js';
import { nextStep } from '../lib/cadence.js';
import { getRules } from '../lib/rules.js';
import { buildSetup, buildLeadPrompt } from '../lib/ai-prompt.js';
import { guideOf, countsFor } from '../lib/guide.js';

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
    if (q.needs_review === '1') where.push("l.needs_review != ''");
    if (q.followup === 'due') { where.push("l.next_action_date != '' AND l.next_action_date <= ?"); params.push(todayLocal()); }
    if (q.quality === 'none') where.push("l.quality = ''");
    else if (q.quality) { where.push('l.quality = ?'); params.push(q.quality); }
    if (q.source) { where.push('l.source = ?'); params.push(q.source); }
    if (q.untouched === '1') where.push("l.last_activity_at = ''");
    if (WORK_GROUPS[q.work]) { where.push(`${WORK_CASE} IN (${WORK_GROUPS[q.work].map(() => '?').join(',')})`); params.push(...WORK_GROUPS[q.work]); }
    else if (WORK_KEYS.includes(q.work)) { where.push(`${WORK_CASE} = ?`); params.push(q.work); }
    // Fit suggestions (headcount and title): size = big|sweet|small|unknown, authority = dm|maybe|low|unknown, suggest = skip|nurture|qualify|good
    if (q.size || q.authority || q.suggest) {
      const ids = db.prepare("SELECT id, title, employees FROM leads WHERE deleted_at = ''").all()
        .filter((x) => { const f = fitOf(x); return (!q.size || f.size === q.size) && (!q.authority || f.authority === q.authority) && (!q.suggest || f.suggest === q.suggest); })
        .map((x) => x.id);
      where.push('l.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(ids));
    }
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
    res.json({ rows: rows.map((x) => ({ ...x, fit: fitOf(x) })), total, page, limit });
  });

  r.get('/ids', (req, res) => {
    const { sql, params } = buildWhere(req.query, req.user);
    const ids = db.prepare(`SELECT l.id FROM leads l ${sql} ORDER BY l.id LIMIT 5000`).all(...params).map((x) => x.id);
    res.json({ ids });
  });

  // Counts per working stage (for the tabs above the table), for one owner or everyone.
  r.get('/work-counts', (req, res) => {
    const o = req.query.owner === 'me' ? String(req.user.id) : req.query.owner; // the extension asks for "me"
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
      fit: (() => {
        const out = { size: {}, authority: {}, suggest: {} };
        for (const x of db.prepare("SELECT title, employees FROM leads WHERE deleted_at = ''").all()) {
          const f = fitOf(x);
          for (const k of ['size', 'authority', 'suggest']) out[k][f[k]] = (out[k][f[k]] || 0) + 1;
        }
        return out;
      })(),
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
    res.json({ rows: rows.map((x) => ({ ...x, fit: fitOf(x) })), total, page, limit });
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
    // Selected period (Today / This week / Custom ...): what the chosen person did, counted from the activity log.
    // ?range=today|yesterday|week|last_week|month|last_month|custom|all, ?from= ?to= (custom), ?user=<id> (who did it).
    const b = rangeBounds(req.query.range || 'all', req.query.from, req.query.to);
    const aw = ["l.deleted_at = ''"];
    const ap = [];
    if (b) { aw.push('a.created_at >= ? AND a.created_at < ?'); ap.push(b.start, b.end); }
    const who = req.query.user || req.query.owner;
    if (who) { aw.push('a.user_id = ?'); ap.push(Number(who)); }
    const acts = (types, distinct) => db.prepare(
      `SELECT ${distinct ? 'COUNT(DISTINCT a.lead_id)' : 'COUNT(*)'} AS n FROM activities a JOIN leads l ON l.id = a.lead_id
       WHERE ${aw.join(' AND ')} AND a.type IN (${types.map(() => '?').join(',')})`).get(...ap, ...types).n;
    const replies = db.prepare(
      `SELECT COUNT(DISTINCT a.lead_id) AS n FROM activities a JOIN leads l ON l.id = a.lead_id
       WHERE ${aw.join(' AND ')} AND a.type = 'response_change' AND a.meta LIKE '%"to":"R"%'`).get(...ap).n;
    const period = {
      invites: acts(['linkedin_connect'], true),
      accepted: acts(['linkedin_connected'], true),
      messages: acts(['linkedin_dm'], false),
      messagedLeads: acts(['linkedin_dm'], true),
      inmails: acts(['linkedin_inmail'], false),
      emails: acts(['email'], false),
      emailedLeads: acts(['email'], true),
      replies,
      meetingsBooked: acts(['meeting_booked'], false),
      comments: acts(['linkedin_comment'], false),
      likes: acts(['linkedin_like'], false),
      follows: acts(['linkedin_follow'], false),
      websiteResearch: acts(['website_research'], true),
      commentReplies: acts(['linkedin_comment_reply'], false),
      followups: acts(['linkedin_followup'], false),
    };
    // Right now (not a period): invites still waiting, and first messages with no reply yet, by owner.
    const today = todayLocal();
    const pend = db.prepare(`SELECT invite_sent_date AS d FROM leads WHERE ${w} AND invite_sent_date != '' AND accepted_date = '' AND outreach_status NOT IN ('NI','R','M','NUTR') AND stage NOT IN ('Meeting Booked','Meeting Done','Closed')`).all(...params);
    const age = (d) => Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
    const pending = { total: pend.length, upTo7: pend.filter((x) => age(x.d) <= 7).length, d8to14: pend.filter((x) => age(x.d) > 7 && age(x.d) <= 14).length, over14: pend.filter((x) => age(x.d) > 14).length };
    const awaitingReply = n("first_dm_date != '' AND outreach_status NOT IN ('R','M','NUTR','NI') AND stage NOT IN ('Meeting Booked','Meeting Done','Closed')");
    res.json({ counts: f, rates, period, pending, awaitingReply, bounds: b, byStatus: by('outreach_status'), byCategory: by('lead_category'), byPath: by('quality'), byTier: by('tier') });
  });

  // Paste once at the start of an AI chat: who we are, the rulebook and how to answer.
  r.get('/ai-setup', (req, res) => {
    res.json(buildSetup({ playbook: db.prepare("SELECT value FROM settings WHERE key = 'playbook_md'").get()?.value }));
  });

  // ── Draft queue ────────────────────────────────────────────────────────────
  // Prepared messages / comments / emails. Nothing here is ever sent by the CRM: a person sends it, then presses "Mark sent".
  const DRAFT_SELECT = `SELECT d.*, TRIM(l.first_name || ' ' || l.last_name) AS lead_name, l.company, l.title AS lead_title, l.linkedin, l.email AS lead_email,
      l.owner_id, l.stage, l.outreach_status, l.ceo_status AS lead_ceo_status, l.state AS lead_state, uo.name AS owner_name, uc.name AS created_name, ua.name AS approved_name, us.name AS submitted_name, ur.name AS reviewed_name, usn.name AS sent_name
    FROM drafts d JOIN leads l ON l.id = d.lead_id LEFT JOIN users uo ON uo.id = l.owner_id LEFT JOIN users uc ON uc.id = d.created_by LEFT JOIN users ua ON ua.id = d.approved_by
      LEFT JOIN users us ON us.id = d.submitted_by LEFT JOIN users ur ON ur.id = d.reviewed_by LEFT JOIN users usn ON usn.id = d.sent_by`;
  // Review history of a draft (who submitted, approved, asked for changes, sent). Never deleted.
  const draftEvent = (draftId, user, action, note = '') => db.prepare('INSERT INTO draft_events(draft_id, user_id, action, note, created_at) VALUES (?,?,?,?,?)').run(draftId, user?.id ?? null, action, String(note || '').slice(0, 1000), new Date().toISOString());
  const gateOn = () => (db.prepare("SELECT value FROM settings WHERE key = 'draft_gate'").get()?.value || 'on') !== 'off';
  const draftOne = (id) => db.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).get(id);
  function cleanDraft(input, { partial }) {
    const out = {};
    if (!partial || 'channel' in input) {
      if (!Object.hasOwn(DRAFT_CHANNELS, input.channel)) throw new HttpError(400, 'Channel must be one of: ' + Object.keys(DRAFT_CHANNELS).join(', '));
      out.channel = input.channel;
    }
    if (!partial || 'body' in input) {
      const b = String(input.body ?? '').replace(/\r\n/g, '\n').trim();
      if (!b) throw new HttpError(400, 'Write the draft text first');
      if (b.length > DRAFT_LIMITS.body) throw new HttpError(400, `The draft is too long (max ${DRAFT_LIMITS.body} characters)`);
      out.body = b;
    }
    if ('subject' in input) out.subject = String(input.subject ?? '').trim().slice(0, DRAFT_LIMITS.subject);
    if ('note' in input) out.note = String(input.note ?? '').trim().slice(0, DRAFT_LIMITS.note);
    if ('target_url' in input) {
      const u = String(input.target_url ?? '').trim().slice(0, 600);
      if (u && !/^https:\/\//i.test(u)) throw new HttpError(400, 'The link must start with https://');
      out.target_url = u;
    }
    if ('send_window' in input) out.send_window = String(input.send_window ?? '').trim().slice(0, 120);
    return out;
  }
  const checkConnectNote = (channel, body) => {
    if (channel === 'linkedin_connect' && body.length > DRAFT_LIMITS.connect_note) throw new HttpError(400, `A connection note must be ${DRAFT_LIMITS.connect_note} characters or fewer (this one is ${body.length})`);
  };
  const preview = (t) => String(t).replace(/\s+/g, ' ').slice(0, 90);

  r.get('/drafts', (req, res) => {
    const where = ['l.deleted_at = \'\''];
    const params = [];
    const status = ['ready', 'sent', 'discarded', 'all'].includes(req.query.status) ? req.query.status : 'ready';
    if (status !== 'all') { where.push('d.status = ?'); params.push(status); }
    if (req.query.lead) { where.push('d.lead_id = ?'); params.push(Number(req.query.lead)); }
    if (req.query.owner === 'me') { where.push('l.owner_id = ?'); params.push(req.user.id); }
    else if (/^\d+$/.test(req.query.owner || '')) { where.push('l.owner_id = ?'); params.push(Number(req.query.owner)); }
    if (Object.hasOwn(DRAFT_CHANNELS, req.query.channel || '')) { where.push('d.channel = ?'); params.push(req.query.channel); }
    if (Object.hasOwn(DRAFT_REVIEW, req.query.review || '')) { where.push('d.review_status = ?'); params.push(req.query.review); }
    if (req.query.review === 'replied') where.push("d.replied_at != ''");
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 500);
    const rows = db.prepare(`${DRAFT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${status === 'ready' ? 'd.created_at ASC' : 'COALESCE(NULLIF(d.sent_at, \'\'), d.created_at) DESC'}, d.id LIMIT ?`).all(...params, limit);
    res.json({ rows, send_window: DRAFT_SEND_WINDOW, channels: DRAFT_CHANNELS, review: DRAFT_REVIEW, gate: gateOn(), gated_channels: APPROVAL_REQUIRED_CHANNELS });
  });
  r.get('/drafts/count', (req, res) => {
    const own = /^\d+$/.test(req.query.owner || '') ? ' AND l.owner_id = ' + Number(req.query.owner) : '';
    const n = db.prepare(`SELECT COUNT(*) AS n FROM drafts d JOIN leads l ON l.id = d.lead_id WHERE d.status = 'ready' AND l.deleted_at = ''${own}`).get().n;
    const by = (rs) => db.prepare(`SELECT COUNT(*) AS n FROM drafts d JOIN leads l ON l.id = d.lead_id WHERE d.status = 'ready' AND d.review_status = ? AND l.deleted_at = ''${own}`).get(rs).n;
    res.json({ ready: n, waiting: by('submitted'), approved: by('approved'), changes: by('changes'), leads_waiting: db.prepare("SELECT COUNT(*) AS n FROM leads WHERE deleted_at = '' AND ceo_status = 'submitted'").get().n });
  });
  // Plain-text list of what is waiting for the CEO, to paste into WhatsApp or email.
  r.get('/drafts/digest', (req, res) => {
    const rows = db.prepare(`${DRAFT_SELECT} WHERE d.status = 'ready' AND d.review_status = 'submitted' AND l.deleted_at = '' ORDER BY d.submitted_at ASC, d.id`).all();
    const lines = rows.map((d, i) => `${i + 1}. ${d.lead_name || d.company} (${d.company || '-'}), ${DRAFT_CHANNELS[d.channel]}, by ${d.submitted_name || d.created_name || '-'}\n   ${preview(d.body)}`);
    res.json({ count: rows.length, text: rows.length ? `Drafts waiting for your approval (${rows.length}):\n\n${lines.join('\n\n')}` : 'Nothing is waiting for approval.' });
  });
  r.patch('/drafts/:did', (req, res) => {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.did));
    if (!d) throw new HttpError(404, 'Draft not found');
    if (d.status !== 'ready') throw new HttpError(400, 'Only a draft that is still waiting can be edited');
    const input = req.body || {};
    const f = cleanDraft(input, { partial: true });
    checkConnectNote(f.channel || d.channel, f.body ?? d.body);
    const now = new Date().toISOString();
    // Editing the text removes the approval: the person who approves must see the final wording.
    const reworded = ('body' in f && f.body !== d.body) || ('subject' in f && f.subject !== d.subject) || ('channel' in f && f.channel !== d.channel);
    if (reworded) {
      f.approved_by = null; f.approved_at = '';
      if (d.review_status !== 'draft') { f.review_status = 'draft'; draftEvent(d.id, req.user, 'edited', d.review_status === 'approved' ? 'Text changed after approval, so the approval was removed' : 'Text changed'); }
    }
    // The approval toggle is for admins only (the CEO). Everyone else sends the draft with Submit.
    if (input.approved === true || input.approved === false) {
      if (req.user.role !== 'admin') throw new HttpError(403, 'Only the CEO (an admin) can approve. Use "Send to CEO" to submit this draft.');
      if (input.approved === true) { f.approved_by = req.user.id; f.approved_at = now; f.review_status = 'approved'; f.reviewed_by = req.user.id; f.reviewed_at = now; draftEvent(d.id, req.user, 'approved'); }
      else { f.approved_by = null; f.approved_at = ''; f.review_status = 'draft'; draftEvent(d.id, req.user, 'approval_removed'); }
    }
    f.updated_at = now;
    const cols = Object.keys(f);
    db.prepare(`UPDATE drafts SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => f[c]), d.id);
    res.json({ draft: draftOne(d.id) });
  });
  r.delete('/drafts/:did', (req, res) => {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.did));
    if (!d) throw new HttpError(404, 'Draft not found');
    if (d.status !== 'ready') throw new HttpError(400, 'Only a draft that is still waiting can be discarded');
    db.prepare("UPDATE drafts SET status = 'discarded', updated_at = ? WHERE id = ?").run(new Date().toISOString(), d.id);
    draftEvent(d.id, req.user, 'discarded');
    res.json({ ok: true });
  });
  // Step 1: the person finishes the draft and sends it to the CEO.
  r.post('/drafts/:did/submit', (req, res) => {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.did));
    if (!d) throw new HttpError(404, 'Draft not found');
    if (d.status !== 'ready') throw new HttpError(400, 'Only a draft that is still waiting can be submitted');
    if (d.review_status === 'submitted') throw new HttpError(400, 'This draft is already waiting for the CEO');
    if (d.review_status === 'approved') throw new HttpError(400, 'This draft is already approved');
    const now = new Date().toISOString();
    db.prepare("UPDATE drafts SET review_status = 'submitted', submitted_by = ?, submitted_at = ?, review_note = '', updated_at = ? WHERE id = ?").run(req.user.id, now, now, d.id);
    draftEvent(d.id, req.user, 'submitted', String(req.body?.note || ''));
    res.json({ draft: draftOne(d.id) });
  });
  // Step 2 (admin = the CEO): approve this exact text, or ask for changes with a comment.
  r.post('/drafts/:did/review', (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only the CEO (an admin) can approve or request changes');
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.did));
    if (!d) throw new HttpError(404, 'Draft not found');
    if (d.status !== 'ready') throw new HttpError(400, 'Only a draft that is still waiting can be reviewed');
    const decision = req.body?.decision;
    const note = String(req.body?.note || '').trim().slice(0, DRAFT_LIMITS.note);
    if (!['approve', 'changes'].includes(decision)) throw new HttpError(400, 'decision must be approve or changes');
    if (decision === 'changes' && !note) throw new HttpError(400, 'Write what should change');
    const now = new Date().toISOString();
    if (decision === 'approve') {
      db.prepare("UPDATE drafts SET review_status = 'approved', approved_by = ?, approved_at = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?").run(req.user.id, now, req.user.id, now, note, now, d.id);
      draftEvent(d.id, req.user, 'approved', note);
    } else {
      db.prepare("UPDATE drafts SET review_status = 'changes', approved_by = NULL, approved_at = '', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?").run(req.user.id, now, note, now, d.id);
      draftEvent(d.id, req.user, 'changes_requested', note);
    }
    res.json({ draft: draftOne(d.id) });
  });
  // Last step: the lead answered the sent message.
  r.post('/drafts/:did/replied', (req, res) => {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.did));
    if (!d) throw new HttpError(404, 'Draft not found');
    if (d.status !== 'sent') throw new HttpError(400, 'Only a sent message can be marked as replied');
    if (d.replied_at) throw new HttpError(400, 'Already marked as replied');
    const now = new Date().toISOString();
    db.prepare('UPDATE drafts SET replied_at = ?, updated_at = ? WHERE id = ?').run(now, now, d.id);
    draftEvent(d.id, req.user, 'replied', String(req.body?.note || ''));
    res.json({ draft: draftOne(d.id) });
  });
  r.get('/drafts/:did/events', (req, res) => {
    const rows = db.prepare('SELECT e.id, e.action, e.note, e.created_at, u.name AS user_name FROM draft_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.draft_id = ? ORDER BY e.id').all(Number(req.params.did));
    res.json({ rows });
  });

  // The extension's daily sweep: what changed since the last check (invite accepted, new message, email reply, new post).
  // It logs a note, marks the lead "needs review" with the reason, and fills the accepted date. It never changes the stage or sends anything.
  const SIGNALS = { invite_accepted: 'Invite accepted', invite_pending: 'Invite still pending', new_message: 'New LinkedIn message', email_reply: 'New email', new_post: 'New LinkedIn post' };
  r.post('/signals', (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
    let marked = 0; const skipped = [];
    for (const it of items) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND deleted_at = \'\'').get(Number(it?.lead_id));
      if (!lead || !SIGNALS[it?.type]) { skipped.push(String(it?.lead_id)); continue; }
      const text = String(it.text || '').trim().slice(0, 500);
      const now = new Date().toISOString();
      const line = `Check: ${SIGNALS[it.type]}${text ? ' - ' + text : ''}`;
      // The same signal seen again in the next sweep is not news.
      if (it.type !== 'invite_pending' && db.prepare("SELECT 1 FROM activities WHERE lead_id = ? AND type = 'note' AND note = ? AND created_at >= ?").get(lead.id, line, new Date(Date.now() - 14 * 86400000).toISOString())) { skipped.push(String(lead.id) + ' (already reported)'); continue; }
      tx(db, () => {
        logActivity(db, { lead_id: lead.id, user_id: req.user.id, type: 'note', note: line });
        if (it.type === 'invite_accepted') { if (!lead.accepted_date) recordActivity(lead, 'linkedin_connected', 'Connection accepted (seen by the daily check)', req.user); }
        if (it.type !== 'invite_pending') db.prepare('UPDATE leads SET needs_review = ?, needs_review_at = ?, updated_at = ? WHERE id = ?').run(SIGNALS[it.type] + (text ? ': ' + text.slice(0, 120) : ''), now, now, lead.id);
        else db.prepare('UPDATE leads SET linkedin_checked_at = ? WHERE id = ?').run(now, lead.id);
      });
      if (it.type !== 'invite_pending') marked++;
    }
    res.json({ ok: true, marked, skipped });
  });

  // Per-lead CEO review: submit a qualified lead with its plan; the CEO approves once or asks for changes.
  r.get('/ceo-queue', (req, res) => {
    const rows = db.prepare(`SELECT l.id, TRIM(l.first_name || ' ' || l.last_name) AS name, l.company, l.title, l.assessment, l.why_in_pipeline, l.next_action, l.ceo_status, l.ceo_note, l.ceo_at, u.name AS owner_name
      FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE l.deleted_at = '' AND l.ceo_status = 'submitted' ORDER BY l.ceo_at, l.id`).all();
    res.json({ rows, count: rows.length });
  });
  r.post('/:id/ceo-submit', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead || lead.deleted_at) throw new HttpError(404, 'Lead not found');
    if (lead.ceo_status === 'submitted') throw new HttpError(400, 'This lead is already waiting for the CEO');
    if (lead.ceo_status === 'approved') throw new HttpError(400, 'The CEO already approved this lead');
    const note = String(req.body?.note || '').trim().slice(0, DRAFT_LIMITS.note);
    const now = new Date().toISOString();
    tx(db, () => {
      db.prepare("UPDATE leads SET ceo_status = 'submitted', ceo_note = ?, ceo_at = ?, ceo_by_name = ?, updated_at = ? WHERE id = ?").run(note, now, req.user.name, now, lead.id);
      logActivity(db, { lead_id: lead.id, user_id: req.user.id, type: 'note', note: `Sent to the CEO for review${note ? ': ' + note : ''}` });
    });
    res.json({ ok: true });
  });
  r.post('/:id/ceo-review', (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only the CEO (an admin) can approve or request changes');
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead || lead.deleted_at) throw new HttpError(404, 'Lead not found');
    const decision = req.body?.decision;
    const note = String(req.body?.note || '').trim().slice(0, DRAFT_LIMITS.note);
    if (!['approve', 'changes'].includes(decision)) throw new HttpError(400, 'decision must be approve or changes');
    if (decision === 'changes' && !note) throw new HttpError(400, 'Write what should change');
    const now = new Date().toISOString();
    const status = decision === 'approve' ? 'approved' : 'changes';
    tx(db, () => {
      db.prepare('UPDATE leads SET ceo_status = ?, ceo_note = ?, ceo_at = ?, ceo_by_name = ?, updated_at = ? WHERE id = ?').run(status, note, now, req.user.name, now, lead.id);
      logActivity(db, { lead_id: lead.id, user_id: req.user.id, type: 'note', note: `CEO review: ${CEO_STATUS[status]}${note ? ': ' + note : ''}` });
    });
    res.json({ ok: true, ceo_status: status });
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
    const fit = fitOf(lead);
    const drafts = db.prepare(`${DRAFT_SELECT} WHERE d.lead_id = ? AND d.status != 'discarded' ORDER BY d.id DESC LIMIT 20`).all(lead.id);
    res.json({ lead, fit, guide: guideOf(lead, { fit, counts: countsFor(db, lead.id), today: todayLocal(), rules: getRules(db), meetings }), activities, meetings, links, drafts });
  });

  // One lead for that chat: everything the CRM knows, the suggested next step and a place for your own findings.
  r.get('/:id/ai-prompt', (req, res) => {
    const id = Number(req.params.id);
    const lead = db.prepare('SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE l.id = ?').get(id);
    if (!lead) throw new HttpError(404, 'Lead not found');
    const activities = db.prepare('SELECT a.type, a.note, a.created_at, u.name AS user_name FROM activities a JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 60').all(id);
    const meetings = db.prepare('SELECT m.*, b.name AS booked_by_name FROM meetings m LEFT JOIN users b ON b.id = m.booked_by WHERE m.lead_id = ? ORDER BY m.scheduled_date DESC').all(id);
    const links = db.prepare('SELECT kind, label, url FROM lead_links WHERE lead_id = ? ORDER BY id').all(id);
    const fit = fitOf(lead);
    const guide = guideOf(lead, { fit, counts: countsFor(db, id), today: todayLocal(), rules: getRules(db), meetings });
    res.json(buildLeadPrompt({ lead, fit, guide, activities, meetings, links, machine: req.query.machine === '1' }));
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
  // Once per person, lead and day for these; and any identical entry within 20 seconds is a double click.
  const ONCE_A_DAY = new Set(['linkedin_view', 'linkedin_follow', 'linkedin_connect', 'linkedin_connected', COMPANY_VIEW_TYPE]);
  function isDuplicate(lead, type, text, user) {
    if (type === 'note' && !text) return false;
    const day = rangeBounds('today');
    if (ONCE_A_DAY.has(type) && db.prepare('SELECT 1 FROM activities WHERE lead_id = ? AND user_id = ? AND type = ? AND created_at >= ? AND created_at < ?').get(lead.id, user.id, type, day.start, day.end)) return true;
    const since = new Date(Date.now() - 20000).toISOString();
    return !!db.prepare('SELECT 1 FROM activities WHERE lead_id = ? AND user_id = ? AND type = ? AND note = ? AND created_at >= ?').get(lead.id, user.id, type, text, since);
  }
  function recordActivity(lead, type, text, user) {
      if (isDuplicate(lead, type, text, user)) return false;
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
      return true;
  }

  // One-click result of a planned step. The Plan page sends { result, kind } and this works out what to log and when
  // the lead comes back: accepted | pending | sent | seen | replied | nurture | not_interested | no_response | snooze.
  const RESULTS = ['comment', 'accepted', 'pending', 'sent', 'seen', 'replied', 'nurture', 'not_interested', 'no_response', 'snooze'];
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
        db.prepare('UPDATE leads SET step_done = ? WHERE id = ?').run(today, lead.id);
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
      } else if (result === 'no_response') {
        // Silence is not a refusal: close the lead but keep the lead type and outreach status, and say why.
        applyChanges(lead, { stage: 'Closed', denial_reason: lead.denial_reason || 'No response' }, req.user);
        plan('', '');
      } else if (result === 'snooze') {
        snooze(addDays(today, Math.min(30, Math.max(1, Number(req.body.days) || 1))));
      }
    });
    res.json({ lead: fresh() });
  });


  // Add a draft to a lead (a person or an AI agent with an API key). Creating a draft never sends anything.
  function addDraft(lead, input, user) {
    const f = cleanDraft(input || {}, { partial: false });
    checkConnectNote(f.channel, f.body);
    if (['linkedin_comment', 'linkedin_comment_reply'].includes(f.channel) && !f.target_url) throw new HttpError(400, 'A comment draft needs the direct link (target_url) to the exact post. Find the post first.');
    if (f.channel === 'website_contact' && !f.target_url) throw new HttpError(400, 'A Contact Us draft needs the link (target_url) to the form page');
    const dup = db.prepare("SELECT id FROM drafts WHERE lead_id = ? AND channel = ? AND body = ? AND status = 'ready'").get(lead.id, f.channel, f.body);
    if (dup) return { draft: draftOne(dup.id), duplicate: true };
    const now = new Date().toISOString();
    const id = tx(db, () => {
      const ins = db.prepare('INSERT INTO drafts(lead_id, channel, subject, body, note, target_url, send_window, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(lead.id, f.channel, f.subject || '', f.body, f.note || '', f.target_url || '', f.send_window || DRAFT_SEND_WINDOW, 'ready', user.id, now, now);
      logActivity(db, { lead_id: lead.id, user_id: user.id, type: 'note', note: `Draft ready (${DRAFT_CHANNELS[f.channel]}), NOT sent: ${preview(f.body)}` });
      draftEvent(Number(ins.lastInsertRowid), user, 'created');
      return Number(ins.lastInsertRowid);
    });
    return { draft: draftOne(id) };
  }
  r.post('/:id/drafts', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    const out = addDraft(lead, req.body, req.user);
    res.status(out.duplicate ? 200 : 201).json(out);
  });

  // The browser extension (or any AI agent) saves one researched lead in a single call. Nothing is sent and the stage never changes:
  // it fills the research fields, adds links, and stores drafts as "ready". A person reviews first (the extension shows a preview).
  const VERDICTS = ['PURSUE', 'QUALIFY', 'NURTURE', 'SKIP'];
  r.post('/:id/ai-result', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    const b = req.body || {};
    const verdict = String(b.verdict || '').toUpperCase().trim();
    if (!VERDICTS.includes(verdict)) throw new HttpError(400, 'verdict must be one of: ' + VERDICTS.join(', '));
    const clip = (x, n) => String(x ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);
    const reason = clip(b.reason, 400);
    let assessment = clip(b.assessment, 1500);
    if (!new RegExp('^' + verdict, 'i').test(assessment)) assessment = `${verdict} - ${reason}${assessment ? ' | ' + assessment : ''}`.slice(0, 1500);
    const sets = { assessment };
    if (clip(b.why_in_pipeline, 1000)) sets.why_in_pipeline = clip(b.why_in_pipeline, 1000);
    if (clip(b.todays_question, 500)) sets.todays_question = clip(b.todays_question, 500);
    if (clip(b.next_action, 300)) sets.next_action = clip(b.next_action, 300);
    const days = Number(b.next_action_days);
    if (Number.isFinite(days) && days >= 0 && days <= 60) sets.next_action_date = addDays(todayLocal(), Math.round(days));
    // A task for a person (check an inbox, confirm a connection...) is kept on the lead so it shows in the Plan follow-up list and the lead's Next action.
    const human = clip(b.needs_human, 300);
    if (human) { sets.next_action = clip((sets.next_action ? sets.next_action + ' | ' : '') + 'Check by hand: ' + human, 300); if (!(Number.isFinite(days) && days >= 0 && days <= 60)) sets.next_action_date = todayLocal(); }
    if (verdict === 'SKIP' && clip(b.denial_reason, 300)) sets.denial_reason = clip(b.denial_reason, 300);
    const added = { links: 0, drafts: 0, duplicates: 0, skipped: [], saved: [] };
    const now = new Date().toISOString();
    // Memory for the next person or AI: a short summary and when each source was last checked. A re-check clears "needs review".
    if (clip(b.research_summary, 1500)) { sets.research_summary = clip(b.research_summary, 1500); sets.research_at = now; }
    const SOURCES = { website: 'website_checked_at', linkedin: 'linkedin_checked_at', inbox: 'inbox_checked_at', email: 'email_checked_at' };
    for (const s of Array.isArray(b.checked) ? b.checked : []) if (SOURCES[s]) sets[SOURCES[s]] = now;
    if (clip(b.rules_version, 40)) sets.rules_version = clip(b.rules_version, 40);
    sets.needs_review = ''; sets.needs_review_at = '';
    // Dropdown fields (lead type, category, channel, outreach status): only values the CRM knows. A SKIP with no lead type becomes "Not a Fit",
    // which takes it out of the plan and the research list. The stage is never changed here.
    const dropdowns = {};
    const want = { quality: b.quality, lead_category: b.lead_category, channel: b.channel, outreach_status: b.outreach_status };
    if (verdict === 'SKIP' && !String(want.quality || '').trim()) want.quality = 'Not a Fit';
    const allowedBy = { quality: QUALITIES, lead_category: LEAD_CATEGORIES, channel: CHANNELS, outreach_status: Object.keys(OUTREACH_STATUSES) };
    for (const [k, v] of Object.entries(want)) {
      const val = String(v ?? '').trim(); if (!val) continue;
      if (allowedBy[k].includes(val)) dropdowns[k] = val; else added.skipped.push(`${k}: "${val}" is not a CRM value`);
    }
    tx(db, () => {
      const cols = Object.keys(sets);
      db.prepare(`UPDATE leads SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => sets[c]), now, lead.id);
      if (Object.keys(dropdowns).length) applyChanges(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id), dropdowns, req.user);
      logActivity(db, { lead_id: lead.id, user_id: req.user.id, type: 'note', note: `AI research saved by ${req.user.name}: ${verdict} - ${reason}`.slice(0, 600) });
      for (const k of Array.isArray(b.links) ? b.links.slice(0, 10) : []) {
        try {
          const url = cleanUrl(k?.url);
          const kind = isKind(k?.kind) ? k.kind : detectKind(url);
          if (db.prepare('SELECT 1 FROM lead_links WHERE lead_id = ? AND url = ?').get(lead.id, url)) continue;
          if (db.prepare('SELECT COUNT(*) AS n FROM lead_links WHERE lead_id = ?').get(lead.id).n >= 30) { added.skipped.push('link limit'); break; }
          db.prepare('INSERT INTO lead_links(lead_id, kind, label, url, created_by, created_at) VALUES (?,?,?,?,?,?)').run(lead.id, kind, clip(k?.label, 80), url, req.user.id, now);
          added.links++;
        } catch (e) { added.skipped.push('link: ' + e.message); }
      }
    });
    for (const d of Array.isArray(b.drafts) ? b.drafts.slice(0, 6) : []) {
      try { const out = addDraft(lead, d, req.user); added.saved.push({ id: out.draft.id, channel: out.draft.channel, subject: out.draft.subject, body: out.draft.body, target_url: out.draft.target_url }); if (out.duplicate) added.duplicates++; else added.drafts++; } catch (e) { added.skipped.push('draft: ' + e.message); }
    }
    res.json({ ok: true, verdict, ...added, lead_id: lead.id, dropdowns });
  });

  // The person sent it: log the real activity (with the text) and close the draft.
  r.post('/drafts/:did/sent', (req, res) => {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.did));
    if (!d) throw new HttpError(404, 'Draft not found');
    if (d.status !== 'ready') throw new HttpError(400, 'This draft is already ' + d.status);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(d.lead_id);
    if (!lead || lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    // CEO approval gate: a person cannot mark an outreach draft sent until the CEO approved this exact text. Admins can; switch off with settings key draft_gate = off.
    if (gateOn() && APPROVAL_REQUIRED_CHANNELS.includes(d.channel) && d.review_status !== 'approved' && lead.ceo_status !== 'approved' && req.user.role !== 'admin') {
      throw new HttpError(400, 'The CEO has not approved this lead yet. Use "Send lead to CEO" in the lead panel. Once he approves the lead, you can send every step without asking again.');
    }
    const evidence = String(req.body?.evidence || '').trim().slice(0, 1000);
    if (d.channel === 'website_contact' && evidence.length < 5) throw new HttpError(400, 'Paste the confirmation the website showed after you submitted the form (or write that there was none)');
    const text = d.channel === 'email' && d.subject ? `Subject: ${d.subject}\n\n${d.body}` : d.channel === 'website_contact' ? `${d.body}\n\nForm: ${d.target_url}\nConfirmation: ${evidence}` : d.body;
    tx(db, () => {
      db.prepare("UPDATE drafts SET status = 'sent', sent_by = ?, sent_at = ?, updated_at = ?, evidence = ? WHERE id = ?").run(req.user.id, new Date().toISOString(), new Date().toISOString(), evidence, d.id);
      draftEvent(d.id, req.user, 'sent', evidence);
      recordActivity(lead, d.channel, text.slice(0, 2000), req.user);
      if (['linkedin_dm', 'linkedin_inmail', 'email', 'website_contact'].includes(d.channel)) db.prepare('UPDATE leads SET step_done = ? WHERE id = ?').run(todayLocal(), lead.id);
    });
    res.json({ draft: draftOne(d.id) });
  });

  r.post('/:id/activities', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (lead.deleted_at) throw new HttpError(400, 'This lead is in the recycle bin. Restore it first.');
    const { type, note } = req.body || {};
    if (!(type in MANUAL_TYPES)) throw new HttpError(400, 'Unknown activity type');
    const text = String(note || '').trim();
    if (type === 'note' && !text) throw new HttpError(400, 'Write a note first');
    if (type === 'website_contact' && text.length < 15) throw new HttpError(400, 'Paste the form link and the confirmation the website showed');
    if (type === 'website_research' && text.length < 15) throw new HttpError(400, 'Write what you found on the website (what they do, size, any LMS or platform)');
    // Website research counts once per lead per day, the same way a profile review does (a re-run of the same research must not raise the target).
    if (type === 'website_research') {
      const day = rangeBounds('today');
      if (db.prepare('SELECT 1 FROM activities WHERE lead_id = ? AND type = ? AND created_at >= ? AND created_at < ?').get(lead.id, 'website_research', day.start, day.end)) return res.json({ ok: true, duplicate: true, counted: false });
    }
    const added = tx(db, () => recordActivity(lead, type, text, req.user));
    if (!added) return res.json({ ok: true, duplicate: true });
    res.status(201).json({ ok: true, counted: true });
  });

  // Admin only: remove one wrongly logged activity. The lead's "last activity" is recalculated.
  r.delete('/:id/activities/:actId', requireAdmin, (req, res) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(Number(req.params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    const del = db.prepare('DELETE FROM activities WHERE id = ? AND lead_id = ?').run(Number(req.params.actId), lead.id);
    if (!del.changes) throw new HttpError(404, 'Activity not found');
    const last = db.prepare("SELECT MAX(created_at) AS t FROM activities WHERE lead_id = ? AND type NOT IN ('edit','trashed','restored')").get(lead.id).t || '';
    db.prepare('UPDATE leads SET last_activity_at = ? WHERE id = ?').run(last, lead.id);
    res.json({ ok: true });
  });

  return r;
}
