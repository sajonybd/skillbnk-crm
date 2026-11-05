// ─────────────────────────────────────────────────────────────
// All business settings live here. Edit this file to change
// stages, quality categories, timezone, etc. No other file needs
// to change — the UI reads these lists from /api/config.
// ─────────────────────────────────────────────────────────────
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'crm.db');
export const PUBLIC_DIR = path.join(root, 'public');

// Timezone used for "today / yesterday / this week / this month".
// Asia/Dhaka is UTC+6 with no daylight saving, so a fixed offset is exact.
export const TZ = 'Asia/Dhaka';
export const TZ_OFFSET_MIN = 360;
export const WEEK_START = 1; // 0 = Sunday, 1 = Monday

// Pipeline stage: where the lead is in the process.
export const STAGES = ['New', 'Contacted', 'Replied', 'Meeting Booked', 'Meeting Done', 'Closed'];

// Quality / category: what kind of lead this turned out to be.
// '' (blank) means "not rated yet".
export const QUALITIES = [
  'Discovery Meeting',
  'Direct skillBNK Customer',
  'Strategic Partnership',
  'AI Video Content Tool',
  'AI Agent Tool',
  'Not a Fit',
];

// Activity types people can log by hand. Order = order of the buttons in the UI.
export const MANUAL_TYPES = {
  call: 'Call',
  email: 'Email',
  meeting: 'Meeting',
  note: 'Note',
  linkedin_view: 'Profile view',
  linkedin_follow: 'Follow',
  linkedin_like: 'Like',
  linkedin_comment: 'Comment',
  linkedin_connect: 'Connection request',
  linkedin_connected: 'Connected',
  linkedin_inmail: 'InMail',
  linkedin_dm: 'DM',
};

// The LinkedIn actions (shown as a group / menu in the UI).
export const LINKEDIN_TYPES = Object.keys(MANUAL_TYPES).filter((k) => k.startsWith('linkedin_'));

// Logged automatically when someone opens a lead's company page from the CRM (once per person, lead and day).
export const COMPANY_VIEW_TYPE = 'linkedin_company_view';
LINKEDIN_TYPES.push(COMPANY_VIEW_TYPE);

// Outreach "touches" = every logged action except notes.
export const TOUCH_TYPES = [...Object.keys(MANUAL_TYPES).filter((k) => k !== 'note'), COMPANY_VIEW_TYPE];

// Meetings: status of one booked meeting.
export const MEETING_STATUSES = { booked: 'Booked', completed: 'Completed', cancelled: 'Cancelled' };
export const MEETING_TYPES = ['meeting_booked', 'meeting_completed', 'meeting_cancelled', 'meeting_rescheduled'];

// Weekly KPI: meetings each member must book per week. Admin can change it per person in the Meetings page.
// From this Dhaka hour on, the Plan and the daily work plan report open on the next working day.
export const PLAN_SWITCH_HOUR = Number(process.env.PLAN_SWITCH_HOUR || 18);

export const DEFAULT_WEEKLY_MEETING_TARGET = Number(process.env.WEEKLY_MEETING_TARGET || 8);

// Resource links that can be attached to a lead.
export const LINK_KINDS = { drive: 'Google Drive', chatgpt: 'ChatGPT', other: 'Link' };

// Everything that can appear in the activity log (manual + automatic).
export const TYPE_LABELS = {
  ...MANUAL_TYPES,
  linkedin_company_view: 'Company page view',
  meeting_booked: 'Meeting booked',
  meeting_completed: 'Meeting completed',
  meeting_cancelled: 'Meeting cancelled',
  meeting_rescheduled: 'Meeting rescheduled',
  linkedin: 'LinkedIn', // older generic type, kept so old rows still display
  stage_change: 'Stage change',
  quality_change: 'Quality change',
  assign: 'Assignment',
  meeting_date: 'Meeting date',
  edit: 'Edit',
  response_change: 'Response update',
  trashed: 'Moved to recycle bin',
  restored: 'Restored',
};

// Logging one of these on a lead that is still "New" moves it to "Contacted".
export const FIRST_TOUCH_TYPES = TOUCH_TYPES.filter((t) => t !== 'meeting');

export const DEFAULT_ADMIN = {
  name: process.env.ADMIN_NAME || 'Admin',
  email: process.env.ADMIN_EMAIL || 'admin@skillbnk.local',
  password: process.env.ADMIN_PASSWORD || 'admin123',
};

// Team members created automatically on startup if they don't exist yet.
// Emails are placeholders: edit them (and reset passwords) in the Team page.
export const TEAM = [
  { name: 'Tawhid', email: 'tawhid@skillbnk.local' },
  { name: 'Ahana Anjum', email: 'ahana@skillbnk.local' },
  { name: 'Safiul Alom', email: 'safiul@skillbnk.local' },
];
export const TEAM_DEFAULT_PASSWORD = process.env.TEAM_PASSWORD || 'welcome123';

// Daily targets: each is counted automatically from the activity log.
export const TARGET_METRICS = {
  linkedin_view: 'Profile reviews', linkedin_comment: 'Comments', linkedin_like: 'Post likes', linkedin_follow: 'Follows',
  linkedin_connect: 'Connection requests', linkedin_dm: 'Direct messages',
};

// ── Outreach funnel (playbook Sections 40–42) ───────────────────────────────
export const LEAD_CATEGORIES = ['Customer', 'Curious', 'Strategic Partner'];
export const TIERS = ['A', 'B', 'C'];
// Outreach status codes: U unseen, SNR seen no reply, NI not interested, R replied, M meeting booked, NUTR nurture
export const OUTREACH_STATUSES = { U: 'U · Unseen', SNR: 'SNR · Seen, no reply', NI: 'NI · Not interested', R: 'R · Replied', M: 'M · Meeting booked', NUTR: 'NUTR · Nurture' };
export const CHANNELS = ['LinkedIn', 'Email', 'Both'];
// Set by the owner after the post-research opportunity assessment (Section 42).
export const OPPORTUNITY_PATHS = [
  'Direct skillBNK Customer', 'Strategic Partnership', 'Discovery Meeting',
  'AI Video / Content Tool', 'AI Agent / Automation Tool', 'Custom Platform Development',
  'Relationship Building Only', 'No Opportunity',
];
// New lead fields: text columns, and the date columns that the log fills in automatically.
export const OUTREACH_TEXT_FIELDS = ['lead_category', 'tier', 'problem_pool', 'why_in_pipeline', 'todays_question', 'outreach_status', 'denial_reason', 'opportunity_path', 'channel', 'assessment'];
export const OUTREACH_DATE_FIELDS = ['invite_sent_date', 'accepted_date', 'first_dm_date'];
