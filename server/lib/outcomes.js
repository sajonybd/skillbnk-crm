// Outcome numbers and exceptions for the CEO (feedback 24 Nov 2026): what moved, not how busy people were.
import { TZ_OFFSET_MIN } from '../config.js';
import { weekStart, weekEnd, addDays, todayLocal } from './kpi.js';

const shift = `${TZ_OFFSET_MIN >= 0 ? '+' : '-'}${Math.abs(TZ_OFFSET_MIN)} minutes`;

// One row per active member for the week starting `week` (Monday). Counts only, no invented targets.
export function computeOutcomes(db, week) {
  const from = week;
  const to = addDays(week, 6); // Sunday work counts toward the week that just ended, so the window is Monday to Sunday
  const users = db.prepare("SELECT id, name FROM users WHERE role = 'member' AND active = 1 AND removed_at = '' ORDER BY name").all();
  const actCount = (uid, types) => db.prepare(
    `SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND type IN (${types.map(() => '?').join(',')}) AND date(created_at, '${shift}') BETWEEN ? AND ?`
  ).get(uid, ...types, from, to).n;
  const rows = users.map((u) => {
    const booked = db.prepare(`SELECT COUNT(*) AS n FROM meetings WHERE booked_by = ? AND date(created_at, '${shift}') BETWEEN ? AND ?`).get(u.id, from, to).n;
    const held = db.prepare(`SELECT COUNT(*) AS n FROM meetings WHERE booked_by = ? AND status = 'completed' AND date(COALESCE(NULLIF(status_changed_at, ''), updated_at), '${shift}') BETWEEN ? AND ?`).get(u.id, from, to).n;
    const replies = db.prepare(
      `SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND type = 'response_change' AND meta LIKE '%"to":"R"%' AND date(created_at, '${shift}') BETWEEN ? AND ?`
    ).get(u.id, from, to).n;
    const d = (col, extra = '') => db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE ${col} = ? AND date(${col === 'submitted_by' ? 'submitted_at' : col === 'reviewed_by' ? 'reviewed_at' : 'sent_at'}, '${shift}') BETWEEN ? AND ? ${extra}`).get(u.id, from, to).n;
    return {
      id: u.id, name: u.name,
      meetings_booked: booked, meetings_held: held, qualified_replies: replies,
      emails_sent: actCount(u.id, ['email']), contact_forms: actCount(u.id, ['website_contact']), followups_done: actCount(u.id, ['linkedin_followup']),
      drafts_submitted: d('submitted_by'),
      emails_sent_approved: db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE sent_by = ? AND channel = 'email' AND review_status = 'approved' AND date(sent_at, '${shift}') BETWEEN ? AND ?`).get(u.id, from, to).n,
    };
  });
  const review = {
    waiting: db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'ready' AND review_status = 'submitted'").get().n,
    approved_week: db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE review_status = 'approved' AND date(reviewed_at, '${shift}') BETWEEN ? AND ?`).get(from, to).n,
    changes_week: db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE review_status = 'changes' AND date(reviewed_at, '${shift}') BETWEEN ? AND ?`).get(from, to).n,
  };
  return { week, from, to, last_working_day: weekEnd(week), rows, review };
}

// Things that should not be silent. Each item names a person and a lead so someone can act.
export function computeExceptions(db, today = todayLocal()) {
  const LEAD = "l.deleted_at = '' AND l.stage NOT IN ('Closed')";
  const mine = (sql, ...p) => db.prepare(sql).all(...p);
  // Rated PURSUE / QUALIFY but nothing has been sent to them yet.
  const untouched = mine(
    `SELECT l.id, TRIM(l.first_name || ' ' || l.last_name) AS name, l.company, l.owner_id, u.name AS owner_name, substr(l.assessment, 1, 12) AS rating
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${LEAD} AND (l.assessment LIKE 'PURSUE%' OR l.assessment LIKE 'QUALIFY%')
       AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type IN ('linkedin_connect','linkedin_dm','linkedin_inmail','email','website_contact'))
     ORDER BY l.assessment LIKE 'PURSUE%' DESC, l.id LIMIT 100`);
  // Drafts the CEO has had for over 24 hours.
  const stuck = mine(
    `SELECT d.id, d.channel, d.submitted_at, TRIM(l.first_name || ' ' || l.last_name) AS name, l.company, u.name AS submitted_name
     FROM drafts d JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.submitted_by
     WHERE d.status = 'ready' AND d.review_status = 'submitted' AND l.deleted_at = '' AND d.submitted_at < ? ORDER BY d.submitted_at LIMIT 100`,
    new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  // Approved but never sent for 2+ days: approval is waiting on the person.
  const unsent = mine(
    `SELECT d.id, d.channel, d.reviewed_at, TRIM(l.first_name || ' ' || l.last_name) AS name, l.company, uo.name AS owner_name
     FROM drafts d JOIN leads l ON l.id = d.lead_id LEFT JOIN users uo ON uo.id = l.owner_id
     WHERE d.status = 'ready' AND d.review_status = 'approved' AND l.deleted_at = '' AND d.reviewed_at < ? ORDER BY d.reviewed_at LIMIT 100`,
    new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString());
  // Follow-up date passed by 3+ days and the lead is not snoozed.
  const overdue = mine(
    `SELECT l.id, TRIM(l.first_name || ' ' || l.last_name) AS name, l.company, l.next_action, l.next_action_date, u.name AS owner_name
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${LEAD} AND l.owner_id IS NOT NULL AND l.next_action_date != '' AND l.next_action_date <= ? AND (l.snooze_until = '' OR l.snooze_until <= ?)
     ORDER BY l.next_action_date LIMIT 100`, addDays(today, -3), today);
  const ceoLeads = mine("SELECT l.id, TRIM(l.first_name || ' ' || l.last_name) AS name, l.company, l.ceo_by_name AS submitted_name, l.ceo_at FROM leads l WHERE l.deleted_at = '' AND l.ceo_status = 'submitted' AND l.ceo_at < ? ORDER BY l.ceo_at LIMIT 100", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  return { today, untouched, stuck, unsent, overdue, ceoLeads };
}
export { weekStart };
