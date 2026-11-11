// Starting text of the Playbook page. The admin edits it in the CRM; this is only used until they save their own.
// It follows the rulebook "skillBNK Outreach - Current Rules v8". When that document changes, change it first, then this text.
import { RULES_V8, RULES_VERSION } from './rules-v8.js';

// Turn the plain rule text into Markdown: CAPITAL LINES become headings, rule codes (H1, S2, C3) and "- " lines become list items.
const rulesMd = RULES_V8.split('\n').map((ln) => {
  if (/^[A-Z][A-Z0-9 &,/()'-]{3,}( \(.*\))?$/.test(ln.trim()) && ln === ln.trim()) return '\n## ' + ln;
  const code = /^([HSC]\d+) (.*)$/.exec(ln);
  if (code) return `- **${code[1]}** ${code[2]}`;
  return ln.startsWith('- ') ? ln : ln.trim() ? ln : '';
}).join('\n');

export const DEFAULT_PLAYBOOK = `# skillBNK outreach rules

**Rules version: ${RULES_VERSION}.** The full rulebook is the Google Doc "skillBNK Outreach - Current Rules (v8)". The old 66-page playbook is an archive only. This page is the version the CRM and the AI chat use. Admin: edit this text whenever the rules change.

**Goal:** LinkedIn activity → qualified relationship → business conversation → skillBNK customer or revenue-producing partner. Not a bigger network.

## The daily rhythm
1. Open **Plan**. Replies first, then leads that are due today, then late ones. Each lead shows a **Next step** with the plain-words instructions.
2. Do the action by hand on LinkedIn. Type what you wrote in the box, then press the button that matches what happened.
3. Hit your **daily targets** (profile reviews, comments, likes, follows, connection requests, direct messages). They never override quality.
4. Do your **team tasks** and tick them off.
5. Work week is Sunday to Saturday. **Friday is the day off.** Sunday is mainly content, planning and follow-ups, not new connections.
6. End of day: **Reports → End-of-day update**, copy it and submit.
7. To research a lead: at the start of your AI chat press **Copy AI setup** on this Playbook page once, then press **Copy lead for AI** on each lead. Check what the AI says, then update the lead.

## The follow-up cadence (numbers are on the Rules tab)
- **Day 0**: connection request, 300 characters or fewer, no offer.
- **Day 7**: check whether the invite was accepted. If still pending, do not message.
- **Day 8 email: NOT approved.** Do not send it without the owner's yes (rule H20). Comment on their post instead.
- **After they accept**: first message, one real fact and one open question. No pitch, no meeting request.
- **7 days after the first message with no reply**: a follow-up with a new angle, not "just checking in".
- **14 days**: last follow-up, then stop. **Two unanswered messages is the limit**; pause 3 to 4 weeks.
- A step more than 14 days late is stale. Close it or move it to nurture; do not chase it.

## Company employee training (proposed 11 Nov 2026, awaiting Shiblu's yes)
A company with 51 to 200 employees that trains its **own** staff (does not sell training), with no LMS found, a recurring training need and a path to the owner or an executive, may be tried instead of skipped. Over 200 stays SKIP when cold. Training providers over 50 stay SKIP as customers (they already have an LMS). Companies that sell an LMS or e-learning software are our competitors: SKIP. Max 3 to 5 such leads per person per week. Write "QUALIFY - TRY (company training)" in Assessment. Review every Saturday: replies, meetings and time spent, and stop if it does not work.

## Meetings
- Never in a first message. Only after the lead replied with something specific about their training, or invited a call.
- Propose the window: **Tuesday, Wednesday or Thursday after 3 PM Michigan time**, and always state the time zone. A person checks the calendar before any exact time is named.

## What counts as success
Qualified meetings booked (weekly team target is on the Meetings page), replies answered within the day, and a clean pipeline with no stale leads.

---
# The rules in full (hard rules, soft rules, conditions)
${rulesMd}
`;
