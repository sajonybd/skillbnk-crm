// The follow-up plan from the playbook (day 0 invite, day 7 check, day 8 email, day 7/14 after the first message).
// Given a lead, says what the next step is and when it is due. Returns null when nothing is needed.
//
// Every step has a `kind` (what sort of job it is), a short `verb` (what to do, in plain words) and a
// `detail` (the longer instruction or the lead's own note). The UI builds its buttons from the kind.
import { addDays } from './kpi.js';

const NULLISH = /^(null|undefined|none|n\/a|na|-|—)$/i;
export const clean = (s) => (NULLISH.test(String(s ?? '').trim()) ? '' : String(s ?? '').trim());

export const KINDS = {
  reply:         { verb: 'They replied: answer them',                 rank: 0 },
  first_message: { verb: 'Accepted: send the first message',          rank: 1 },
  followup:      { verb: 'Send a follow-up with a new angle',         rank: 2 },
  email:         { verb: 'Send the short email',                      rank: 3 },
  check_invite:  { verb: 'Check if the invite was accepted',          rank: 4 },
  scheduled:     { verb: 'Do the planned follow-up',                  rank: 5 },
  no_email:      { verb: 'No email: comment on a post or use the website form', rank: 6 },
  research:      { verb: 'Find a way to reach them',                  rank: 7 },
  last_followup: { verb: 'Send the last follow-up, then stop',        rank: 8 },
};

// A planned step the person wrote in the lead ("Check acceptance…", "Find contact path…") is classified by its words.
function kindOfNote(text) {
  const t = text.toLowerCase();
  if (/^(find|try|reach|look for|email route|email only)/.test(t) || /contact path|contact form|website form|via website/.test(t)) return 'research';
  if (/check (the )?(acceptance|invite)|if accepted|follow up if accepted|wait for (acceptance|reply)/.test(t)) return 'check_invite';
  return 'scheduled';
}

const finish = (s) => ({ ...s, action: KINDS[s.kind].verb + (s.kind === 'scheduled' || s.kind === 'research' ? ': ' + s.detail : '') });

export function nextStep(l, today) {
  if (l.stage === 'Closed' || l.quality === 'Not a Fit') return null;
  if (l.snooze_until && l.snooze_until > today) return null;
  const note = clean(l.next_action);
  const planned = l.next_action_date ? { due: l.next_action_date, kind: kindOfNote(note), detail: note || 'Follow-up due', reason: 'Planned follow-up' } : null;

  // They answered: that always comes first, until someone writes the reply and moves the date.
  if (l.outreach_status === 'R') {
    const due = l.next_action_date && l.next_action_date > today ? null : (l.next_action_date || today);
    return due ? finish({ due, kind: l.next_action_date ? 'scheduled' : 'reply', detail: note || 'Read their message and answer', reason: l.next_action_date ? 'Planned follow-up' : 'They replied' }) : null;
  }
  if (['NI', 'NUTR', 'M'].includes(l.outreach_status)) return planned && planned.due <= today ? finish(planned) : null;

  const steps = [];
  if (planned) steps.push(planned);
  if (l.invite_sent_date && !l.accepted_date) {
    const email = l.email && l.email_status && /verified|valid/i.test(l.email_status);
    steps.push({ due: addDays(l.invite_sent_date, 7), kind: 'check_invite', detail: 'If still pending, do not message', reason: 'Day 7 after invite' });
    steps.push({ due: addDays(l.invite_sent_date, 8), kind: email ? 'email' : 'no_email', detail: email ? 'Verified address. Then withdraw the stale invite' : 'No verified email', reason: 'Day 8 after invite' });
  }
  if (l.accepted_date && !l.first_dm_date) steps.push({ due: l.accepted_date, kind: 'first_message', detail: 'One observation, one peer-level question', reason: 'Accepted, no message yet' });
  if (l.first_dm_date) {
    steps.push({ due: addDays(l.first_dm_date, 7), kind: 'followup', detail: 'New angle, not "just checking in"', reason: 'No reply 7 days after first message' });
    steps.push({ due: addDays(l.first_dm_date, 14), kind: 'last_followup', detail: 'Two unanswered messages is the limit', reason: 'No reply 14 days after first message' });
  }
  // The most recent step that has come due.
  const due = steps.filter((s) => s.due <= today).sort((a, b) => (a.due < b.due ? 1 : -1));
  const s = due[0];
  if (!s) return null;
  return finish(s);
}

// A step that is this many days late is not a follow-up any more; it goes to the "stale" pile to close or revive.
export const STALE_AFTER_DAYS = 14;
