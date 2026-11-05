// Understands the free-text parts of the Master Leads sheet so an import brings the pipeline,
// meetings and activity history across, not just the contact details.

// Times written in the sheet's activity log have no zone; they were entered by the Dhaka team.
export const LOG_TZ_OFFSET_H = 6;

// "null", "N/A" and friends are empty cells, not values.
const NULLISH = /^(null|undefined|n\/a|na|none|-|—)$/i;
export const isNullish = (v) => NULLISH.test(String(v ?? '').trim());

// Sheet "Pipeline Stage" → CRM stage, outreach status code and (sometimes) quality.
const STAGE_MAP = {
  'new': {}, 'researching': {}, 'cold': {}, 'qualified': {},
  'connection request sent': { stage: 'Contacted', outreach_status: 'U' },
  'connection requested': { stage: 'Contacted', outreach_status: 'U' },
  'connection sent': { stage: 'Contacted', outreach_status: 'U' },
  'connected': { stage: 'Contacted', outreach_status: 'U', accepted: true },
  'message sent': { stage: 'Contacted', outreach_status: 'U' },
  'in conversation': { stage: 'Replied', outreach_status: 'R' },
  'meeting requested': { stage: 'Replied', outreach_status: 'R' },
  'meeting scheduled': { stage: 'Meeting Booked', outreach_status: 'M' },
  'discovery call held': { stage: 'Meeting Done', outreach_status: 'M', held: true },
  'walkthrough completed': { stage: 'Meeting Done', outreach_status: 'M', held: true },
  'presentation held': { stage: 'Meeting Done', outreach_status: 'M', held: true },
  'proposal / pilot': { stage: 'Meeting Done', outreach_status: 'M', held: true },
  'customer': { stage: 'Closed', outreach_status: 'M', held: true },
  'nurture': { outreach_status: 'NUTR' },
  'not a fit': { quality: 'Not a Fit' },
};

export function mapStage(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return STAGE_MAP[k] || null;
}

// Sheet "Qualification" holds the research verdict (PURSUE / QUALIFY / NURTURE / SKIP).
export function mapVerdict(raw) {
  const v = String(raw || '').trim();
  const k = v.toLowerCase();
  if (!v || isNullish(v) || /^batch \d+/.test(k) || k === 'needs review') return null;
  const out = { verdict: v.toUpperCase().startsWith('QUALIFIED (PARTNER') ? 'QUALIFY (partner)' : v };
  if (k === 'skip' || k === 'not qualified') out.quality = 'Not a Fit';
  if (k === 'nurture') out.outreach_status = 'NUTR';
  if (k.includes('(partner)')) out.opportunity_path = 'Strategic Partnership';
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Reads meetings out of the sheet's free-text "Meeting Date" cell.
// Handles "2026-09-11 16:00", "2026-10-04 11:30, 2026-10-12 02:00", "…(CANCELLED …)" and
// "Follow-up: 2026-11-30 … Earlier discovery held 2026-10-01 3:30 PM". `held` = stage says the meeting happened.
export function parseMeetings(text, { held = false, booked = false } = {}) {
  const t = String(text || '').trim();
  if (!t || isNullish(t)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  const re = /(\d{4}-\d{2}-\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?:\s*([AP]M))?)?/gi;
  let m;
  while ((m = re.exec(t))) {
    let hh = m[2] === undefined ? null : Number(m[2]);
    if (hh !== null && m[4]) { const pm = m[4].toUpperCase() === 'PM'; hh = (hh % 12) + (pm ? 12 : 0); }
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 80).toLowerCase();
    const cancelled = /cancel|declined/.test(after) || /cancel/.test(before);
    const followUp = /follow-?up/.test(before);
    const past = m[1] < today;
    let status = 'booked';
    if (cancelled) status = 'cancelled';
    else if (/held|completed/.test(before + ' ' + after.slice(0, 20)) || (held && past && !followUp)) status = 'completed';
    out.push({ date: m[1], time: hh === null ? '' : `${pad(hh)}:${m[3]}`, status, note: out.length === 0 ? t.slice(0, 600) : '' });
  }
  // A stage like "Meeting Scheduled" with only prose and no date gives no usable meeting.
  return out;
}

// Parses "[Oct 7, 2026, 10:38 AM - Safiul Alom] Comment via Personal LinkedIn" lines from the Notes cell.
const LINE = /^\[([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) ([AP]M) - (.+?)\] (.+)$/;
const TYPE_MAP = [
  ['Company Page View', 'linkedin_company_view'], ['Company Follow', 'linkedin_follow'], ['Company Post Like', 'linkedin_like'], ['Company Comment', 'linkedin_comment'],
  ['Profile View', 'linkedin_view'], ['Follow', 'linkedin_follow'], ['Like', 'linkedin_like'], ['Comment', 'linkedin_comment'],
  ['Connection accepted', 'linkedin_connected'], ['Connection Request', 'linkedin_connect'], ['Connection request', 'linkedin_connect'], ['Message', 'linkedin_dm'],
];
export function parseActivityLog(notes) {
  const out = [];
  for (const ln of String(notes || '').split('\n')) {
    const m = LINE.exec(ln.trim());
    if (!m) continue;
    const [, mon, d, y, h12, min, ap, who, what] = m;
    if (/^null\b/i.test(what)) continue;
    const type = (TYPE_MAP.find(([k]) => what.startsWith(k)) || [])[1];
    if (!type) continue;
    const hour = (Number(h12) % 12) + (ap === 'PM' ? 12 : 0);
    const ms = Date.UTC(Number(y), MONTHS[mon.toLowerCase()] - 1, Number(d), hour, Number(min)) - LOG_TZ_OFFSET_H * 3600e3;
    out.push({ at: new Date(ms).toISOString(), who: who.trim(), type, note: what.startsWith('Company ') ? 'Company page' : '' });
  }
  return out;
}

// Dhaka calendar day of an ISO instant (matches how the team reads the funnel).
export const dayOf = (iso) => new Date(Date.parse(iso) + LOG_TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
