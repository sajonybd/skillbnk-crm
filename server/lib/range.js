import { TZ_OFFSET_MIN, WEEK_START } from '../config.js';

const DAY = 86400000;

export const RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['last_week', 'Last week'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['custom', 'Custom dates'],
  ['all', 'All time'],
];

// Returns { start, end } as ISO strings (UTC), end exclusive — or null for "all".
export function rangeBounds(range, from, to, now = Date.now()) {
  const off = TZ_OFFSET_MIN * 60000;
  const local = now + off; // "local wall clock" expressed as if it were UTC
  const sod = Math.floor(local / DAY) * DAY;
  const d = new Date(local);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const weekStart = () => sod - ((d.getUTCDay() - WEEK_START + 7) % 7) * DAY;
  let s;
  let e;
  switch (range) {
    case 'today':
      s = sod; e = sod + DAY; break;
    case 'yesterday':
      s = sod - DAY; e = sod; break;
    case 'week':
      s = weekStart(); e = s + 7 * DAY; break;
    case 'last_week':
      e = weekStart(); s = e - 7 * DAY; break;
    case 'month':
      s = Date.UTC(y, m, 1); e = Date.UTC(y, m + 1, 1); break;
    case 'last_month':
      s = Date.UTC(y, m - 1, 1); e = Date.UTC(y, m, 1); break;
    case 'custom': {
      const a = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? Date.parse(from + 'T00:00:00Z') : null;
      const b = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? Date.parse(to + 'T00:00:00Z') : null;
      if (a == null && b == null) return null;
      s = a ?? 0;
      e = b != null ? b + DAY : now + off + DAY;
      break;
    }
    default:
      return null;
  }
  return { start: new Date(s - off).toISOString(), end: new Date(e - off).toISOString() };
}
