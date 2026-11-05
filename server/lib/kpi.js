import { TZ_OFFSET_MIN, WEEK_START, DEFAULT_WEEKLY_MEETING_TARGET } from '../config.js';

const DAY = 86400000;
const OFF = TZ_OFFSET_MIN * 60000;

// 'YYYY-MM-DD' of an instant on the Dhaka wall clock.
export const localDate = (iso) => new Date(Date.parse(iso) + OFF).toISOString().slice(0, 10);
export const todayLocal = () => localDate(new Date().toISOString());

export function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}

// Monday (WEEK_START) of the week that contains `date`.
export function weekStart(date) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  return addDays(date, -((dow - WEEK_START + 7) % 7));
}

export function getKpiStart(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'kpi_start_week'").get();
  if (row) return row.value;
  const w = weekStart(todayLocal());
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('kpi_start_week', ?)").run(w);
  return w;
}

// Weekly meeting KPI with carry-forward.
//   booked  = meetings created that week (not cancelled, lead not in the bin), credited to booked_by
//   target  = base target + carry_in;   carry_out = max(0, target - booked)
// A surplus never reduces next week's target.
export function computeKpi(db, upToWeek = weekStart(todayLocal())) {
  const start = getKpiStart(db);
  const members = db.prepare("SELECT id, name, created_at FROM users WHERE role = 'member' AND active = 1 AND removed_at = '' ORDER BY name").all();
  const booked = new Map(); // userId -> Map(week -> n)
  const rows = db.prepare(
    `SELECT m.booked_by AS u, m.created_at AS at FROM meetings m JOIN leads l ON l.id = m.lead_id
     WHERE l.deleted_at = '' AND m.status != 'cancelled' AND m.booked_by IS NOT NULL`
  ).all();
  for (const r of rows) {
    const w = weekStart(localDate(r.at));
    if (!booked.has(r.u)) booked.set(r.u, new Map());
    const m = booked.get(r.u);
    m.set(w, (m.get(w) || 0) + 1);
  }
  const targetRows = db.prepare('SELECT user_id, effective_week, target FROM kpi_targets ORDER BY effective_week').all();
  const baseFor = (uid, week) => {
    let t = DEFAULT_WEEKLY_MEETING_TARGET;
    for (const r of targetRows) if (r.user_id === uid && r.effective_week <= week) t = r.target;
    return t;
  };

  return members.map((u) => {
    const first = weekStart(localDate(u.created_at));
    const from = first > start ? first : start;
    const history = [];
    let carry = 0;
    for (let w = from; w <= upToWeek; w = addDays(w, 7)) {
      const base = baseFor(u.id, w);
      const target = base + carry;
      const got = booked.get(u.id)?.get(w) || 0;
      history.push({ week: w, base, carry_in: carry, target, booked: got, met: got >= target });
      carry = Math.max(0, target - got);
    }
    const cur = history[history.length - 1] || {
      week: upToWeek, base: baseFor(u.id, upToWeek), carry_in: 0, target: baseFor(u.id, upToWeek),
      booked: booked.get(u.id)?.get(upToWeek) || 0, met: false,
    };
    cur.met = cur.booked >= cur.target;
    return { id: u.id, name: u.name, ...cur, remaining: Math.max(0, cur.target - cur.booked), history: history.slice(-8).reverse() };
  });
}
