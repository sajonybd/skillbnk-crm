import { STAGES, MEETING_STATUSES } from '../config.js';
import { HttpError, logActivity } from '../db.js';
import { cleanUrl } from './links.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const stageIdx = (s) => STAGES.indexOf(s);

// The lead row mirrors its meetings: earliest booked, else latest completed, else latest cancelled.
export function syncLeadMeeting(db, leadId) {
  const ms = db.prepare('SELECT status, scheduled_date AS d FROM meetings WHERE lead_id = ?').all(leadId);
  const by = (st) => ms.filter((m) => m.status === st).map((m) => m.d).sort();
  let date = '';
  let status = '';
  if (by('booked').length) { status = 'booked'; date = by('booked')[0]; }
  else if (by('completed').length) { status = 'completed'; date = by('completed').at(-1); }
  else if (by('cancelled').length) { status = 'cancelled'; date = by('cancelled').at(-1); }
  db.prepare('UPDATE leads SET meeting_date = ?, meeting_status = ? WHERE id = ?').run(date, status, leadId);
}

// Keep the pipeline stage in step with meetings (never moves a lead backwards past Closed).
export function reconcileStage(db, leadId, user) {
  const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(leadId);
  const st = new Set(db.prepare('SELECT status FROM meetings WHERE lead_id = ?').all(leadId).map((m) => m.status));
  let next = lead.stage;
  if (lead.stage !== 'Closed') {
    if (st.has('completed') && stageIdx(next) < stageIdx('Meeting Done')) next = 'Meeting Done';
    else if (st.has('booked') && stageIdx(next) < stageIdx('Meeting Booked')) next = 'Meeting Booked';
    else if (!st.has('booked') && !st.has('completed') && st.has('cancelled') && next === 'Meeting Booked') next = 'Replied';
  }
  if (next === lead.stage) return;
  db.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(next, new Date().toISOString(), leadId);
  logActivity(db, { lead_id: leadId, user_id: user.id, type: 'stage_change', note: `${lead.stage} → ${next}`, meta: { from: lead.stage, to: next } });
}

function checkFields(input, { partial }) {
  const out = {};
  if (!partial || 'scheduled_date' in input) {
    const d = String(input.scheduled_date ?? '').trim();
    if (!DATE_RE.test(d)) throw new HttpError(400, 'Meeting date must be YYYY-MM-DD');
    out.scheduled_date = d;
  }
  if ('scheduled_time' in input) {
    const t = String(input.scheduled_time ?? '').trim();
    if (t && !TIME_RE.test(t)) throw new HttpError(400, 'Time must be HH:MM');
    out.scheduled_time = t;
  }
  if ('status' in input) {
    if (!Object.hasOwn(MEETING_STATUSES, input.status)) throw new HttpError(400, 'Status must be booked, completed or cancelled');
    out.status = input.status;
  }
  if ('notes' in input) out.notes = String(input.notes ?? '').trim().slice(0, 2000);
  if ('link' in input) {
    const raw = String(input.link ?? '').trim();
    try { out.link = raw ? cleanUrl(raw) : ''; } catch (e) { throw new HttpError(400, e.message); }
  }
  return out;
}

function resolveBooker(db, id, fallback) {
  if (id === undefined || id === null || id === '') return fallback;
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND removed_at = ''").get(Number(id));
  if (!u) throw new HttpError(400, 'Unknown or inactive team member');
  return u.id;
}

// opts.quiet: no activity log (used by the importer); opts.createdAt: override booking time.
export function createMeeting(db, lead, input, user, opts = {}) {
  const f = checkFields(input, { partial: false });
  const bookedBy = resolveBooker(db, input.booked_by, lead.owner_id || user.id);
  const now = new Date().toISOString();
  const created = opts.createdAt || now;
  const status = f.status || 'booked';
  const info = db.prepare(
    `INSERT INTO meetings(lead_id, booked_by, created_by, scheduled_date, scheduled_time, status, notes, link, created_at, updated_at, status_changed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(lead.id, bookedBy, user.id, f.scheduled_date, f.scheduled_time || '', status, f.notes || '', f.link || '', created, now, now);
  syncLeadMeeting(db, lead.id);
  if (!opts.quiet) {
    logActivity(db, {
      lead_id: lead.id, user_id: user.id, type: status === 'completed' ? 'meeting_completed' : status === 'cancelled' ? 'meeting_cancelled' : 'meeting_booked',
      note: `${f.scheduled_date}${f.scheduled_time ? ' ' + f.scheduled_time : ''}`, meta: { meeting_id: Number(info.lastInsertRowid) },
    });
    reconcileStage(db, lead.id, user);
  }
  return Number(info.lastInsertRowid);
}

export function updateMeeting(db, m, input, user) {
  const f = checkFields(input, { partial: true });
  if ('booked_by' in input) f.booked_by = resolveBooker(db, input.booked_by, m.booked_by);
  const changed = Object.keys(f).filter((k) => f[k] !== m[k]);
  if (changed.length === 0) return m;
  const now = new Date().toISOString();
  if (changed.includes('status')) f.status_changed_at = now;
  const cols = [...changed, ...(changed.includes('status') ? ['status_changed_at'] : [])];
  db.prepare(`UPDATE meetings SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => f[c]), now, m.id);
  const after = { ...m, ...f };
  const log = (type, note) => logActivity(db, { lead_id: m.lead_id, user_id: user.id, type, note, meta: { meeting_id: m.id } });
  const when = `${after.scheduled_date}${after.scheduled_time ? ' ' + after.scheduled_time : ''}`;
  if (changed.includes('status')) {
    log(after.status === 'completed' ? 'meeting_completed' : after.status === 'cancelled' ? 'meeting_cancelled' : 'meeting_booked',
      after.status === 'booked' ? `Re-opened · ${when}` : when);
  }
  if ((changed.includes('scheduled_date') || changed.includes('scheduled_time')) && !changed.includes('status')) {
    log('meeting_rescheduled', `${m.scheduled_date}${m.scheduled_time ? ' ' + m.scheduled_time : ''} → ${when}`);
  }
  syncLeadMeeting(db, m.lead_id);
  reconcileStage(db, m.lead_id, user);
  return after;
}

export function deleteMeeting(db, m, user) {
  db.prepare('DELETE FROM meetings WHERE id = ?').run(m.id);
  logActivity(db, { lead_id: m.lead_id, user_id: user.id, type: 'edit', note: `Removed meeting ${m.scheduled_date}` });
  syncLeadMeeting(db, m.lead_id);
  reconcileStage(db, m.lead_id, user);
}
