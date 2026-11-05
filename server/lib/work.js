// Where each lead is in the working pipeline, from the lead's own fields. One definition shared by the
// Leads table (tabs, sort) and the Plan (research and engage lists).
//   research  no lead type chosen yet: look at the website, profile and company page, then choose a type
//   engage    a real fit with no invite yet: like, comment, follow, send the connection request or InMail
//   invited   connection request sent, not accepted yet
//   message   accepted, first message not sent yet
//   followup  messaged, waiting for an answer
//   replied   they answered
//   meeting   a meeting is booked
//   nurture   parked, check back later
//   declined  they said not interested
//   notfit    we decided it is not a fit (lead type)
export const WORK_KEYS = ['research', 'engage', 'invited', 'message', 'followup', 'replied', 'meeting', 'nurture', 'declined', 'notfit'];

export const WORK_CASE = `(CASE
  WHEN l.quality = 'Not a Fit' THEN 'notfit'
  WHEN l.outreach_status = 'R' THEN 'replied'
  WHEN l.outreach_status = 'M' THEN 'meeting'
  WHEN l.outreach_status = 'NUTR' THEN 'nurture'
  WHEN l.outreach_status = 'NI' THEN 'declined'
  WHEN l.quality = '' THEN 'research'
  WHEN l.first_dm_date != '' THEN 'followup'
  WHEN l.accepted_date != '' THEN 'message'
  WHEN l.invite_sent_date != '' THEN 'invited'
  ELSE 'engage' END)`;

// Sort rank: answer replies first, then messages to send and follow-ups, then leads to engage, then research.
export const workOrder = (today) => `(CASE
  WHEN ${WORK_CASE} = 'replied' THEN 0
  WHEN l.next_action_date != '' AND l.next_action_date <= '${today}' AND ${WORK_CASE} NOT IN ('notfit', 'meeting', 'nurture', 'declined') THEN 1
  WHEN ${WORK_CASE} = 'message' THEN 2
  WHEN ${WORK_CASE} = 'engage' THEN 3
  WHEN ${WORK_CASE} = 'research' THEN 4
  WHEN ${WORK_CASE} = 'followup' THEN 5
  WHEN ${WORK_CASE} = 'invited' THEN 6
  ELSE 7 END) * 10 + (CASE l.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END)`;

// Tabs group the stages that need the same kind of attention.
export const WORK_GROUPS = { waiting: ['invited', 'followup'], parked: ['nurture', 'declined', 'notfit'] };
