// Turns the schedule text from the task sheet ("Sat-Thu", "Mon/Wed/Thu", "1st - 10th of month") into "is it due on this date?".
const NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ORDER = [6, 0, 1, 2, 3, 4, 5]; // team week runs Sat → Fri, so "Sat-Thu" wraps through Sunday

const dayNo = (s) => NAMES[String(s).trim().slice(0, 3).toLowerCase()];

export function parseDays(text) {
  const t = String(text || '').trim().replace(/[–—]/g, '-');
  const out = { dow: new Set(), dom: null, eom: false, adhoc: false };
  if (!t) { out.adhoc = true; return out; }
  if (/end of month/i.test(t)) { out.eom = true; return out; }
  const m = t.match(/(\d+)(?:st|nd|rd|th)?\s*-\s*(\d+)(?:st|nd|rd|th)?\s*of month/i);
  if (m) { out.dom = [Number(m[1]), Number(m[2])]; return out; }
  for (const part of t.split(/[,/]/)) {
    const p = part.trim();
    if (!p) continue;
    const r = p.split('-').map((x) => x.trim());
    if (r.length === 2 && dayNo(r[0]) !== undefined && dayNo(r[1]) !== undefined) {
      let i = ORDER.indexOf(dayNo(r[0]));
      const end = ORDER.indexOf(dayNo(r[1]));
      for (let n = 0; n < 7; n++) { out.dow.add(ORDER[i]); if (i === end) break; i = (i + 1) % 7; }
    } else if (dayNo(p) !== undefined) out.dow.add(dayNo(p));
  }
  return out;
}

// date = 'YYYY-MM-DD'
export function dueOn(days, date) {
  const d = new Date(date + 'T00:00:00Z');
  const rule = typeof days === 'string' ? parseDays(days) : days;
  if (rule.adhoc) return false;
  if (rule.eom) return d.getUTCDate() >= new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - 2;
  if (rule.dom) return d.getUTCDate() >= rule.dom[0] && d.getUTCDate() <= rule.dom[1];
  return rule.dow.has(d.getUTCDay());
}

// Friday is the team's day off.
export const isWorkingDay = (date) => new Date(date + 'T00:00:00Z').getUTCDay() !== 5;
