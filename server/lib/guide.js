// "What should I do next with this lead?" in plain words, for team members who do not know outreach.
// It suggests; a person decides. It uses the planned step from cadence.js when one is due, otherwise the lead's own history.
import { nextStep } from './cadence.js';
import { addDays } from './kpi.js';

const verdictOf = (l) => (String(l.assessment || '').trim().match(/^(PURSUE|QUALIFY|NURTURE|SKIP)\b/i) || [])[1]?.toUpperCase() || '';

const NO_PITCH = 'Do not pitch, do not offer a meeting, no signature, no emoji.';

// counts = { linkedin_view: 2, linkedin_like: 1, ... } for this lead (all time, all people)
export function guideOf(l, { fit, counts = {}, today, rules, meetings = [] }) {
  const n = (t) => counts[t] || 0;
  const verdict = verdictOf(l);
  const real = ['PURSUE', 'QUALIFY'].includes(verdict);
  const g = (o) => ({ ...o, verdict });

  if (l.stage === 'Closed' || l.quality === 'Not a Fit') return g({ kind: 'none', action: 'Nothing to do', channel: '', why: 'This lead is closed or marked Not a Fit.', how: [], dont: ['Do not message or follow up again.'] });

  // 1. The CRM thinks this is a big company or a person without authority: verify first.
  if (fit?.suggest === 'skip') {
    return g({ kind: 'verify_skip', action: 'Check the size, then most likely mark SKIP', channel: 'research', due: today,
      why: fit.why,
      how: ['Open the company LinkedIn page and read the employee count.', 'If it is more than 50 employees, or the person is only a manager who cannot decide, set Lead type = Not a Fit and write the reason in Denial reason.', 'If the count is wrong or the person is the owner or CEO, write what you found in Notes and carry on.'],
      dont: ['Do not send a note or message while this is open.'] });
  }

  const s = nextStep(l, today, rules);

  // 1b. A meeting exists. An unanswered reply still comes first; otherwise the meeting is the work, not an old planned follow-up.
  if (s?.kind !== 'reply') {
    const booked = meetings.filter((m) => m.status === 'booked').sort((a, b) => String(a.scheduled_date).localeCompare(String(b.scheduled_date)));
    const past = booked.find((m) => m.scheduled_date < today);
    const upcoming = booked.find((m) => m.scheduled_date >= today);
    const when = (m) => `${m.scheduled_date}${m.scheduled_time ? ' ' + m.scheduled_time : ''}`;
    if (past) {
      const late = Math.round((new Date(today) - new Date(past.scheduled_date)) / 86400000);
      return g({ kind: 'meeting_past', action: 'The meeting date has passed: record what happened', channel: 'CRM', due: past.scheduled_date, late_days: late,
        why: `Meeting ${when(past)}${past.notes ? ' (' + past.notes + ')' : ''} is still marked "booked".`,
        how: ['Ask the person who booked it, or check the calendar and the lead\'s email and LinkedIn thread: did it happen?', 'Open the Meetings page and mark it Completed, Cancelled or Rescheduled.', 'If it happened, write what the lead said they need, what was agreed and the next step in Notes (Meeting outcome record: size, new or established, platform found, who attended, result, reason).', 'Do not send a generic follow-up or propose a new meeting until you know what happened.'],
        dont: ['Do not restart the relationship with an introduction.'] });
    }
    if (upcoming) return g({ kind: 'meeting', action: 'Prepare for the meeting', channel: '', due: upcoming.scheduled_date,
      why: `Meeting booked for ${when(upcoming)}${upcoming.notes ? ' (' + upcoming.notes + ')' : ''}.`,
      how: ['Read the whole history and the lead\'s notes.', 'Write three questions about how they train and who decides.', 'Check headcount, platform and who attends. A human confirms the calendar and the time zone.'],
      dont: ['No pitch before you understand how they work today.'] });
  }

  // 2. A step that has come due (reply, first message, follow-up, check…).
  if (s) {
    const late = s.due < today ? Math.round((new Date(today) - new Date(s.due)) / 86400000) : 0;
    const base = { due: s.due, late_days: late, why: s.reason, planned_text: s.detail };
    const map = {
      reply: { action: 'They replied: answer them first', channel: 'LinkedIn message',
        how: ['Open the lead on LinkedIn and read the whole conversation (regular inbox and Sales Navigator).', 'Answer what they actually said, in two or three short sentences, and ask one easy question.', 'If they said something specific about their training, you may offer the window: Tuesday, Wednesday or Thursday after 3 PM Michigan time (state the time zone). Never name an exact time before someone checks the calendar.', 'After sending, press the button on the Plan page or log a DM.'],
        dont: ['Do not pitch skillBNK yet.', 'Do not say "next week" without naming days.'] },
      first_message: { action: 'Send the first message (they accepted)', channel: 'LinkedIn message',
        how: ['Read their profile, recent posts and website again for one real fact.', 'Write two or three short sentences: that one fact, then one open question about how they train people today.', 'Show the question to Safiul or the CEO first if it is not already approved.', 'Send it from LinkedIn, then log a DM.'],
        dont: [NO_PITCH, 'No meeting request in a first message.'] },
      followup: { action: 'Send a follow-up message with a new angle', channel: 'LinkedIn message',
        how: ['Read the whole conversation first.', 'Write something new: a useful fact, a different question or a comment on their latest post. Not "just checking in".', 'Send it and log a DM.'],
        dont: ['Two unanswered messages is the limit. After that, stop.'] },
      last_followup: { action: 'Send the last follow-up, then stop', channel: 'LinkedIn message',
        how: ['Send one short, friendly message with a fresh reason to talk.', 'Log it. Then pause 3 to 4 weeks; only like or comment on their posts in between.'],
        dont: ['No third message in this round.'] },
      check_invite: { action: 'Check if the invite was accepted', channel: 'LinkedIn',
        how: ['LinkedIn > My Network > Manage > Sent. See if the invite is still pending.', 'Accepted: press Accepted on the Plan page, then send the first message.', 'Still pending: do nothing today and press Pending. The CRM checks again later.'],
        dont: ['Do not message someone who has not accepted.'] },
      email: { action: 'Day-8 email is due, but it is NOT approved yet', channel: 'Email',
        how: ['Ask Safiul or the CEO before sending any cold email (rule H20).', 'If you are told no, press Snooze and keep to LinkedIn: like or comment on a recent post.'],
        dont: ['Do not email without a yes.'] },
      no_email: { action: 'No email route: engage on LinkedIn instead', channel: 'LinkedIn',
        how: ['Comment on one recent post with a real view, not praise.', 'Do not use a website form without the owner\'s yes (H20).'], dont: [] },
      research: { action: 'Find a way to reach this person', channel: 'research',
        how: ['Check LinkedIn profile, company page and website for a contact route.', 'Write what you found in Notes.'], dont: [] },
      scheduled: { action: 'Do the planned follow-up', channel: '',
        how: [`Planned note: ${s.detail}`, 'Read the lead\'s history first, do it, then log what you did.'], dont: [] },
    };
    const m = map[s.kind] || map.scheduled;
    if (real && ['check_invite', 'no_email'].includes(s.kind)) m.how = [...m.how, 'InMail is allowed only for PURSUE or QUALIFY leads after full research, and a free message is preferred. Ask Safiul first.'];
    return g({ kind: s.kind, ...base, ...m });
  }

  // 3. Nothing is due. Say what the lead needs from its history.
  if (['NI'].includes(l.outreach_status)) return g({ kind: 'none', action: 'Nothing to do', channel: '', why: 'They said they are not interested.', how: [], dont: ['Do not ask again or use another channel.'] });
  if (l.outreach_status === 'NUTR') return g({ kind: 'nurture', action: 'Stay visible: like or comment now and then', channel: 'LinkedIn', why: 'Nurture: waiting for a good moment.',
    how: ['Follow them if you have not.', 'Like or comment (with a real view) on a post only when it is relevant.', 'Do not message until the planned date or a real trigger.'], dont: ['No pushing.'] });
  if (l.outreach_status === 'M' || l.stage === 'Meeting Booked') return g({ kind: 'meeting', action: 'Prepare for the meeting', channel: '', why: 'A meeting is booked.', how: ['Read the history and the Notes.', 'Write what you want to learn as three questions.'], dont: [] });

  if (!l.invite_sent_date && !l.accepted_date && !n('linkedin_connect')) {
    if (fit?.suggest === 'try' && !/\bTRY\b/.test(l.assessment || '')) return g({ kind: 'try_check', action: 'Own-staff training test: check five facts before you connect', channel: 'research', due: today,
      why: fit.why,
      how: ['1. It trains its OWN employees and does not sell training (otherwise: a training provider or an LMS/e-learning company, so SKIP: they already have a platform or compete with us).', '2. No LMS found (read the website, the Login and Enroll links, the job posts).', '3. A recurring training need: frequent hiring, several locations or shifts, or compliance work.', '4. A path to the owner or an executive (a Director of Training alone is a champion, not the buyer).', '5. Headcount is 51 to 200, verified on LinkedIn or the website.', 'All five: write the Assessment as "QUALIFY - TRY (own-staff test) | ..." and carry on. Any missing: write what is missing. If it fails 1, 2 or 5, mark Not a Fit.'],
      dont: ['No message until the five facts are checked.', 'Do not pitch a replacement LMS.'] });
    if (!n('linkedin_view') && !n('linkedin_company_view')) return g({ kind: 'research', action: 'Research first: read the profile and the company', channel: 'research',
      why: 'No one has looked at this lead yet.', how: ['Open the LinkedIn profile (the button logs the visit) and read the About section and recent posts.', 'Open the company page and the website. Note headcount, what they sell, who they train and any LMS.', 'Press "Copy AI prompt" and paste it into your AI chat for the full research, then check what it says.'], dont: ['Do not connect yet.'] });
    if (!verdict) return g({ kind: 'verdict', action: 'Decide the verdict: PURSUE, QUALIFY, NURTURE or SKIP', channel: 'research',
      why: 'Researched, but no verdict is written yet.', how: ['Use "Copy AI prompt" and check its result block.', 'Write the verdict as the first word of Assessment. If SKIP, set Lead type = Not a Fit and stop.'], dont: ['No note or message to a SKIP lead.'] });
    if (verdict === 'SKIP') return g({ kind: 'verify_skip', action: 'Verdict is SKIP: mark Not a Fit and stop', channel: '', why: 'Assessment says SKIP.', how: ['Set Lead type = Not a Fit and write the reason in Denial reason.'], dont: ['No note, message or pitch.'] });
    if (!n('linkedin_follow') && !n('linkedin_like') && !n('linkedin_comment')) return g({ kind: 'warm', action: 'Warm up: follow and like or comment on a recent post', channel: 'LinkedIn', why: 'A little genuine activity before the invite makes it feel natural.',
      how: ['Follow them.', 'Like a recent post, or comment with a real view (not praise, not a summary). Read the whole post first.'], dont: [] });
    return g({ kind: 'connect', action: 'Send the connection request', channel: 'LinkedIn', due: today,
      why: 'Researched, verdict is ' + (verdict || 'set') + ', not connected yet.',
      how: ['If they are already a first-degree connection, send a direct message instead.', 'Add a note of 300 characters or fewer: a greeting, one fact you read, one curious question.', 'Send it, check that it shows Pending, then log "Connection request".'],
      dont: ['No offer, no meeting request, no feature list, no signature. "Fellow Michigander" only for verified Michigan leads.'] });
  }
  if (l.invite_sent_date && !l.accepted_date) return g({ kind: 'wait', action: 'Wait: the invite is pending', channel: '', why: `Invite sent ${l.invite_sent_date}. The CRM will ask you to check on day ${rules.invite_check_day} (${addDays(l.invite_sent_date, rules.invite_check_day)}).`,
    how: ['Optional: like or comment on one of their posts.'], dont: ['Do not message someone who has not accepted.'] });
  if (l.first_dm_date) return g({ kind: 'wait', action: 'Wait for their reply', channel: '', why: 'The first message is sent. Follow-ups come at day ' + rules.followup1_day + ' and ' + rules.followup2_day + '.', how: ['Optional: like or comment on a post.'], dont: ['Do not send another message early.'] });
  return g({ kind: 'wait', action: 'Nothing due today', channel: '', why: 'No step is due.', how: [], dont: [] });
}

export function countsFor(db, leadId) {
  return Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM activities WHERE lead_id = ? GROUP BY type').all(leadId).map((r) => [r.type, r.n]));
}
