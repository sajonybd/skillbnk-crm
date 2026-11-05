// The outreach rules the admin can change (Playbook page). Stored in the settings table; defaults come from the written playbook.
export const RULE_DEFS = {
  invite_check_day:   { label: 'Check the invite after (days)',               help: 'Day 7: has the connection request been accepted?', min: 1, max: 30, def: 7 },
  email_day:          { label: 'Send the short email after (days)',            help: 'Day 8: email the ones who have not accepted, if the address is verified.', min: 1, max: 30, def: 8 },
  followup1_day:      { label: 'First follow-up after the first message (days)', help: 'No reply this many days after the first message: follow up with a new angle.', min: 1, max: 30, def: 7 },
  followup2_day:      { label: 'Last follow-up after the first message (days)', help: 'Two unanswered messages is the limit; after this, stop.', min: 2, max: 60, def: 14 },
  stale_days:         { label: 'A step is "stale" when it is late by (days)',  help: 'Stale leads leave the daily plan and wait in the Stale tab to be closed or nurtured.', min: 3, max: 90, def: 14 },
  daily_cap:          { label: 'Lead actions per person per day',              help: 'How many leads each person gets in the daily plan. The rest carry over to the next day.', min: 1, max: 200, def: 25 },
  pending_recheck_days: { label: 'Invite still pending: check again after (days)', help: 'Used by the "Still pending" button.', min: 1, max: 30, def: 3 },
  nurture_days:       { label: 'Nurture: check back after (days)',              help: 'Used by the "Nurture" button and after the last follow-up.', min: 7, max: 180, def: 30 },
};

export const DEFAULT_RULES = Object.fromEntries(Object.entries(RULE_DEFS).map(([k, d]) => [k, d.def]));

export function getRules(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'rules'").get();
  let saved = {};
  try { saved = JSON.parse(row?.value || '{}'); } catch { /* use defaults */ }
  const out = { ...DEFAULT_RULES };
  for (const [k, d] of Object.entries(RULE_DEFS)) {
    const n = Math.round(Number(saved[k]));
    if (Number.isFinite(n) && n >= d.min && n <= d.max) out[k] = n;
  }
  return out;
}

// Validates and saves. Throws a message string on bad input.
export function saveRules(db, input) {
  const next = {};
  for (const [k, d] of Object.entries(RULE_DEFS)) {
    const n = Math.round(Number(input?.[k]));
    if (!Number.isFinite(n) || n < d.min || n > d.max) throw new Error(`${d.label}: enter a number from ${d.min} to ${d.max}`);
    next[k] = n;
  }
  if (next.followup2_day <= next.followup1_day) throw new Error('The last follow-up must come after the first follow-up');
  if (next.email_day <= next.invite_check_day) throw new Error('The email day must come after the invite check day');
  db.prepare("INSERT INTO settings(key, value) VALUES ('rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  return next;
}

// Daily cap for one person: their own number if the admin set one, else the team number.
export function capFor(db, userId, rules = getRules(db)) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('cap:' + userId);
  const n = Math.round(Number(row?.value));
  return Number.isFinite(n) && n >= 1 && n <= 200 ? n : rules.daily_cap;
}
