// Parses CSV / TSV text (a downloaded CSV, or cells copied straight out of
// Google Sheets) and maps its columns to lead fields.
//
// To teach the importer a new column name, add it to ALIASES below.
import { STAGES, QUALITIES, legacyPathToQuality } from '../config.js';
import { dedupeKey, hasIdentity } from './leadkey.js';
import { isNullish, mapStage, mapVerdict } from './sheet-sync.js';

export const IMPORT_FIELDS = [
  ['first_name', 'First name'], ['last_name', 'Last name'], ['full_name', 'Full name (split)'],
  ['title', 'Title'], ['company', 'Company'], ['email', 'Email'], ['email_status', 'Email status'],
  ['phone', 'Phone'], ['linkedin', 'LinkedIn'], ['company_linkedin', 'Company LinkedIn'],
  ['website', 'Website'], ['employees', '# Employees'], ['industry', 'Industry'],
  ['city', 'City'], ['state', 'State'], ['country', 'Country'], ['source', 'Source / List'],
  ['icp_segment', 'ICP segment'], ['owner', 'Owner (team member)'], ['stage', 'Stage'],
  ['quality', 'Quality'], ['verdict', 'Research verdict (PURSUE / QUALIFY…)'], ['meeting_date', 'Meeting date (free text ok)'], ['next_action', 'Next action'],
  ['next_action_date', 'Next action date'], ['notes', 'Notes'], ['apollo_id', 'Apollo contact ID'],
];

// normalized header (lowercase letters+digits only) → field
const ALIASES = {
  firstname: 'first_name', first: 'first_name',
  lastname: 'last_name', last: 'last_name', surname: 'last_name',
  name: 'full_name', fullname: 'full_name', contactname: 'full_name',
  title: 'title', jobtitle: 'title', position: 'title',
  company: 'company', companyname: 'company', organization: 'company', account: 'company',
  email: 'email', emailaddress: 'email', workemail: 'email',
  emailstatus: 'email_status',
  phone: 'phone', phonenumber: 'phone', workdirectphone: 'phone', mobilephone: 'phone', corporatephone: 'phone',
  linkedin: 'linkedin', linkedinurl: 'linkedin', personlinkedinurl: 'linkedin', personlinkedin: 'linkedin',
  companylinkedin: 'company_linkedin', companylinkedinurl: 'company_linkedin',
  website: 'website', companywebsite: 'website', url: 'website',
  employees: 'employees', numemployees: 'employees', employeecount: 'employees',
  industry: 'industry', city: 'city', state: 'state', country: 'country',
  source: 'source', sourcelist: 'source', list: 'source', lists: 'source',
  icpsegment: 'icp_segment', segment: 'icp_segment',
  owner: 'owner', assignedto: 'owner', assignee: 'owner',
  stage: 'stage', pipelinestage: 'stage',
  quality: 'quality', qualification: 'verdict', verdict: 'verdict',
  leadcategory: 'lead_category', tier: 'tier', outreachstatus: 'outreach_status', channel: 'channel',
  opportunitypath: 'opportunity_path', // old column: merged into quality below
  problempool: 'problem_pool', whyinpipeline: 'why_in_pipeline', todaysquestion: 'todays_question',
  denialreason: 'denial_reason', invitesentdate: 'invite_sent_date', accepteddate: 'accepted_date', firstdmdate: 'first_dm_date',
  meetingdate: 'meeting_date', nextaction: 'next_action', nextactiondate: 'next_action_date',
  notes: 'notes', note: 'notes',
  apollocontactid: 'apollo_id', apolloid: 'apollo_id',
};
const MULTI = new Set(['phone']); // several columns may feed one field (first non-empty wins)

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseTable(text) {
  text = String(text || '').replace(/^﻿/, '');
  const sample = text.split('\n').slice(0, 20).join('\n');
  const delim = (sample.match(/\t/g) || []).length > (sample.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

// The Master Leads tab has title rows above the real header, so look for it.
export function findHeaderRow(rows) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const score = rows[i].filter((c) => ALIASES[norm(c)]).length;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

export function detectMapping(headers) {
  const used = new Set();
  return headers.map((h) => {
    const f = ALIASES[norm(h)];
    if (!f) return '';
    if (used.has(f) && !MULTI.has(f)) return '';
    used.add(f);
    return f;
  });
}

const clean = (v) => { const s = String(v ?? '').trim().replace(/^'/, ''); return isNullish(s) ? '' : s; };

function toLead(cells, mapping) {
  const l = {};
  mapping.forEach((field, i) => {
    if (!field) return;
    const v = clean(cells[i]);
    if (v === '') return;
    if (field in l && l[field] !== '') return; // first non-empty wins
    l[field] = v;
  });
  if (l.full_name && !l.first_name && !l.last_name) {
    const parts = l.full_name.split(/\s+/);
    l.first_name = parts.shift() || '';
    l.last_name = parts.join(' ');
  }
  delete l.full_name;
  if (l.email) l.email = l.email.toLowerCase();
  if (l.employees) l.employees = l.employees.replace(/[^0-9]/g, '');
  // Sheet pipeline words ("Connection Request Sent", "Discovery Call Held"…) → CRM stage + outreach status.
  if (l.stage && !STAGES.includes(l.stage)) {
    const m = mapStage(l.stage);
    l.stage_raw = l.stage;
    delete l.stage;
    if (m) {
      if (m.stage) l.stage = m.stage;
      if (m.outreach_status && !l.outreach_status) l.outreach_status = m.outreach_status;
      if (m.quality && !l.quality) l.quality = m.quality;
      l.stage_held = !!m.held;
      l.stage_accepted = !!m.accepted;
    }
  }
  if (l.verdict) {
    const v = mapVerdict(l.verdict);
    delete l.verdict;
    if (v) {
      if (v.quality && !l.quality) l.quality = v.quality;
      if (v.outreach_status && !l.outreach_status) l.outreach_status = v.outreach_status;
      l.assessment = l.assessment || `Research verdict (from sheet): ${v.verdict}`;
    }
  }
  if (l.opportunity_path) { if (!l.quality) l.quality = legacyPathToQuality(l.opportunity_path); delete l.opportunity_path; }
  if (l.quality && !QUALITIES.includes(l.quality)) l.quality = legacyPathToQuality(l.quality) || undefined;
  if (!l.quality) delete l.quality;
  // Free-text meeting dates are kept for the meeting parser; next_action_date must be a real date.
  if (l.next_action_date && !/^\d{4}-\d{2}-\d{2}$/.test(l.next_action_date)) delete l.next_action_date;
  return l;
}

export function analyze(text) {
  const all = parseTable(text);
  if (all.length === 0) return { headers: [], mapping: [], rows: [], headerRow: 0 };
  const headerRow = findHeaderRow(all);
  const headers = all[headerRow].map((h) => String(h).trim());
  return { headers, mapping: detectMapping(headers), rows: all.slice(headerRow + 1), headerRow };
}

export function buildLeads(rows, mapping) {
  const leads = [];
  let invalid = 0;
  for (const cells of rows) {
    const l = toLead(cells, mapping);
    if (!hasIdentity(l)) { invalid++; continue; }
    leads.push(l);
  }
  return { leads, invalid };
}

export { dedupeKey };
