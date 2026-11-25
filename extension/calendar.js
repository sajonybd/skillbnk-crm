// Shiblu's open times: his availability RULES (Settings) checked against his Google Calendar (read-only, through the calendar's private iCal address).
// Gives ChatGPT two exact times to offer in a meeting ask. Nothing is booked or written; a person still confirms before sending.
const DEFAULT_AVAIL = `Timezone: America/Detroit
Regular: Tue, Wed, Thu 15:00-18:00
Open: 2026-11-25 to 2026-11-29 09:00-18:00
Open: 2026-12-04, 2026-12-11, 2026-12-18 09:00-18:00
Open: 2026-12-21 to 2026-12-28 09:00-18:00
Blocked: 2026-11-26
Blocked:`;
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const hm = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };

function parseAvail(text) {
  const r = { tz: 'America/Detroit', regular: [], open: [], blocked: [] };
  const dates = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const m = /^(\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}))?$/.exec(x); return m ? { from: m[1], to: m[2] || m[1] } : null; }).filter(Boolean);
  for (const line of String(text || '').split('\n')) {
    const l = line.trim(); if (!l) continue;
    let m;
    if ((m = /^timezone:\s*(.+)$/i.exec(l))) r.tz = m[1].trim();
    else if ((m = /^regular:\s*(.+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/i.exec(l))) r.regular.push({ days: m[1].split(/[,\s]+/).map((d) => DOW[d.slice(0, 3).toLowerCase()]).filter((d) => d !== undefined), start: hm(m[2]), end: hm(m[3]) });
    else if ((m = /^open:\s*(.+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/i.exec(l))) for (const d of dates(m[1])) r.open.push({ ...d, start: hm(m[2]), end: hm(m[3]) });
    else if ((m = /^blocked:\s*(.*)$/i.exec(l))) for (const d of dates(m[1])) r.blocked.push(d);
  }
  return r;
}
// ── time zones without a library ──
function tzParts(ms, tz) { const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }); const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value; return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, dow: DOW[o.weekday.slice(0, 3).toLowerCase()] }; }
function zonedMs(y, mo, d, h, mi, tz) { let g = Date.UTC(y, mo - 1, d, h, mi); for (let i = 0; i < 2; i++) { const p = tzParts(g, tz); g += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); } return g; }
const ymd = (p) => `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

// ── iCal reading ──
function icsEvents(text, tzDefault, fromMs, toMs) {
  const lines = String(text).replace(/\r/g, '').replace(/\n[ \t]/g, '').split('\n');
  const evs = []; let cur = null;
  for (const ln of lines) {
    if (ln === 'BEGIN:VEVENT') cur = { ex: [], raw: {} }; else if (ln === 'END:VEVENT') { if (cur) evs.push(cur); cur = null; }
    else if (cur) { const i = ln.indexOf(':'); if (i < 0) continue; const head = ln.slice(0, i), val = ln.slice(i + 1); const [name, ...params] = head.split(';'); const tzid = (params.find((p) => /^TZID=/i.test(p)) || '').slice(5); const isDate = params.some((p) => /VALUE=DATE$/i.test(p)); const N = name.toUpperCase();
      if (N === 'EXDATE') for (const v of val.split(',')) cur.ex.push({ v, tzid, isDate }); else cur.raw[N] = { val, tzid, isDate }; }
  }
  const conv = (o) => { if (!o) return null; const v = o.val; if (o.isDate || /^\d{8}$/.test(v)) return { ms: zonedMs(+v.slice(0, 4), +v.slice(4, 6), +v.slice(6, 8), 0, 0, tzDefault), allDay: true };
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v); if (!m) return null; if (m[7]) return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) }; let tz = o.tzid || tzDefault; try { Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = tzDefault; } return { ms: zonedMs(+m[1], +m[2], +m[3], +m[4], +m[5], tz) }; };
  const overridden = new Set(); const out = [];
  for (const e of evs) { const rid = conv(e.raw['RECURRENCE-ID']); if (rid) overridden.add((e.raw.UID?.val || '') + '|' + rid.ms); }
  for (const e of evs) {
    if (/CANCELLED/i.test(e.raw.STATUS?.val || '') || /TRANSPARENT/i.test(e.raw.TRANSP?.val || '')) continue;
    const s = conv(e.raw.DTSTART); if (!s) continue; let en = conv(e.raw.DTEND); let dur = en ? en.ms - s.ms : 0;
    if (!en) { const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(e.raw.DURATION?.val || ''); dur = m ? ((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 60000 : s.allDay ? 86400000 : 3600000; }
    const uid = e.raw.UID?.val || ''; const exs = new Set(e.ex.map((x) => conv({ val: x.v, tzid: x.tzid, isDate: x.isDate })?.ms));
    const rr = e.raw.RRULE?.val; const isOverride = !!e.raw['RECURRENCE-ID'];
    if (!rr) { out.push({ s: s.ms, e: s.ms + dur }); continue; }
    const k = Object.fromEntries(rr.split(';').map((p) => p.split('='))); const step = Math.max(1, +k.INTERVAL || 1); const until = k.UNTIL ? conv({ val: k.UNTIL.length === 8 ? k.UNTIL : k.UNTIL }) : null; const max = +k.COUNT || 100000;
    const D2 = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }; const byday = (k.BYDAY || '').split(',').filter(Boolean).map((x) => D2[x.slice(-2).toUpperCase()]);
    const base = tzParts(s.ms, tzDefault); let n = 0;
    for (let day = 0; day < 800 && n < max; day++) {
      const dayMs = zonedMs(base.y, base.mo, base.d + day, base.h, base.mi, tzDefault); const p = tzParts(dayMs, tzDefault);
      const wk = Math.floor(day / 7); let hit = false;
      if (k.FREQ === 'DAILY') hit = day % step === 0;
      else if (k.FREQ === 'WEEKLY') hit = wk % step === 0 && (byday.length ? byday.includes(p.dow) : p.dow === base.dow);
      else if (k.FREQ === 'MONTHLY') hit = p.d === base.d && ((p.y * 12 + p.mo) - (base.y * 12 + base.mo)) % step === 0;
      else if (k.FREQ === 'YEARLY') hit = p.d === base.d && p.mo === base.mo && (p.y - base.y) % step === 0;
      if (!hit) continue; n++;
      if (until && dayMs > until.ms + 86400000) break; if (dayMs > toMs) break;
      if (exs.has(dayMs) || overridden.has(uid + '|' + dayMs)) continue;
      if (dayMs + dur >= fromMs) out.push({ s: dayMs, e: dayMs + dur });
    }
  }
  return out.filter((x) => x.e > fromMs && x.s < toMs);
}

// ── open slots: rules minus busy time ──
function freeSlots(rules, busy, nowMs, { minutes = 20, horizonDays = 21, bufferMin = 15, leadHours = 12, max = 2 } = {}) {
  const tz = rules.tz; const t0 = tzParts(nowMs, tz); const picks = []; const earliest = nowMs + leadHours * 3600000;
  for (let i = 0; i < horizonDays && picks.length < max; i++) {
    const dayMs = zonedMs(t0.y, t0.mo, t0.d + i, 12, 0, tz); const p = tzParts(dayMs, tz); const key = ymd(p);
    if (p.dow === 0 || p.dow === 6) continue; // no weekend calls
    if (rules.blocked.some((b) => key >= b.from && key <= b.to)) continue;
    let wins = rules.open.filter((o) => key >= o.from && key <= o.to).map((o) => [o.start, o.end]);
    if (!wins.length) wins = rules.regular.filter((r) => r.days.includes(p.dow)).map((r) => [r.start, r.end]);
    for (const [a, b] of wins) for (let m = a; m + minutes <= b; m += 30) {
      const s = zonedMs(p.y, p.mo, p.d, Math.floor(m / 60), m % 60, tz), e = s + minutes * 60000;
      if (s < earliest || busy.some((x) => s < x.e + bufferMin * 60000 && e > x.s - bufferMin * 60000)) continue;
      picks.push({ s, e, tz, key }); break; // best slot of that day, so the two options are on different days
    }
  }
  return picks.slice(0, max);
}
const fmtSlot = (x) => { const p = tzParts(x.s, x.tz); const f = new Intl.DateTimeFormat('en-US', { timeZone: x.tz, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); return f.format(new Date(x.s)); };

let availCache = { at: 0, text: '' };
async function availabilityBlock(force = false) {
  if (!force && availCache.text && Date.now() - availCache.at < 600000) return availCache.text;
  const rules = parseAvail(cfg.avail || DEFAULT_AVAIL); let busy = [], checked = 'rules only, the calendar was NOT checked, a person must confirm the time';
  if (cfg.calIcs) {
    try { const res = await fetch(cfg.calIcs, { cache: 'no-store' }); if (!res.ok) throw new Error('calendar said ' + res.status); const txt = await res.text(); if (!/BEGIN:VCALENDAR/.test(txt)) throw new Error('not a calendar file'); busy = icsEvents(txt, rules.tz, Date.now() - 86400000, Date.now() + 30 * 86400000); checked = `calendar checked ${new Date().toLocaleTimeString()}, ${busy.length} busy block(s) in the next 30 days`; }
    catch (e) { checked = 'calendar could not be read (' + e.message + '), rules only, a person must confirm the time'; }
  }
  const slots = freeSlots(rules, busy, Date.now());
  const text = slots.length ? `SHIBLU'S OPEN TIMES (${rules.tz}; ${checked}):\n${slots.map((x, i) => `${i + 1}. ${fmtSlot(x)}`).join('\n')}\nIf a call is the right next step, offer EXACTLY these two times in his usual line ("We can have a 15 min discovery meeting <time 1> or <time 2>, How is your calendar?"). Never invent another time. Offer times only if they replied and a call fits.` : `SHIBLU'S OPEN TIMES: none found in the next 3 weeks (${checked}). Do not name a time; ask what works for them and say a person will confirm.`;
  availCache = { at: Date.now(), text }; return text;
}
