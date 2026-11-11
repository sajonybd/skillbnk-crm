import { RULES_V8, RULES_VERSION } from '../data/rules-v8.js';

const v = (x) => (x === undefined || x === null || String(x).trim() === '' ? 'not in CRM' : String(x).trim());
const ACT = { linkedin_view: 'Viewed profile', linkedin_follow: 'Followed', linkedin_like: 'Liked a post', linkedin_comment: 'Commented', linkedin_connect: 'Sent connection request', linkedin_connected: 'Connection accepted', linkedin_inmail: 'InMail', linkedin_dm: 'LinkedIn message', email: 'Email', call: 'Call', meeting: 'Meeting', note: 'Note' };

// The admin's saved Playbook text wins when it looks like the full rulebook; otherwise the built-in v8 copy is used.
export function buildAiPrompt({ lead: l, fit, guide, activities, meetings, links, playbook, user }) {
  const custom = playbook && playbook.length > 6000 && /H1\b/.test(playbook);
  const rules = custom ? playbook : RULES_V8;
  const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || '(no name)';
  const where = [l.city, l.state, l.country].filter(Boolean).join(', ');
  const L = [];
  L.push(`Name: ${name}`, `Job title: ${v(l.title)}`, `Company: ${v(l.company)}`, `Employees (CRM, may be old): ${v(l.employees)}`, `Industry: ${v(l.industry)}`,
    `Location: ${v(where)}`, `LinkedIn: ${v(l.linkedin)}`, `Company LinkedIn: ${v(l.company_linkedin)}`, `Website: ${v(l.website)}`, `Email: ${v(l.email)}`,
    `Source: ${v(l.source)}`, `Segment: ${v(l.icp_segment)}`,
    '', `Stage: ${v(l.stage)}`, `Lead type (Quality): ${v(l.quality)}`, `Category: ${v(l.lead_category)}`, `Tier: ${v(l.tier)}`, `Outreach status: ${v(l.outreach_status)}`,
    `Channel: ${v(l.channel)}`, `Owner: ${v(l.owner_name)}`, `Why in pipeline: ${v(l.why_in_pipeline)}`, `Assessment so far: ${v(l.assessment)}`,
    `Today's question: ${v(l.todays_question)}`, `Denial reason: ${v(l.denial_reason)}`, `Next action: ${l.next_action || l.next_action_date ? [l.next_action, l.next_action_date && '(' + l.next_action_date + ')'].filter(Boolean).join(' ') : 'not in CRM'}`,
    `Invite sent: ${v(l.invite_sent_date)} | Accepted: ${v(l.accepted_date)} | First DM: ${v(l.first_dm_date)}`, `Notes: ${v(l.notes)}`);
  if (links.length) L.push('', 'Saved links:', ...links.map((k) => `- ${k.label || k.kind}: ${k.url}`));
  L.push('', 'CRM fit hint (a suggestion from headcount and job title only, not a verdict):', fit ? `- ${fit.size_text}\n- ${fit.auth_text}\n- Suggestion: ${fit.suggest.toUpperCase()} (${fit.why})` : '- none');
  if (guide) L.push(...['', 'NEXT STEP the CRM suggests (from the lead\'s history and the follow-up schedule; a person decides):',
    `- Do: ${guide.action}${guide.channel ? ' [' + guide.channel + ']' : ''}`, `- Why: ${guide.why}`, guide.due ? `- Due: ${guide.due}${guide.late_days ? ' (' + guide.late_days + ' days late)' : ''}` : null,
    ...(guide.how || []).map((x) => `- How: ${x}`), ...(guide.dont || []).map((x) => `- Avoid: ${x}`)].filter((x) => x !== null));
  L.push('', `Meetings (${meetings.length}):`, ...(meetings.length ? meetings.map((m) => `- ${m.scheduled_date} ${m.scheduled_time || ''} | ${v(m.status)} | booked by ${v(m.booked_by_name)} | ${m.notes || ''}`) : ['- none']));
  L.push('', `Activity history in the CRM (newest first, ${activities.length} shown). These are logged actions; the CRM does not hold the LinkedIn inbox, so the real conversation must be read by a human:`,
    ...(activities.length ? activities.map((a) => `- ${String(a.created_at).slice(0, 16).replace('T', ' ')} UTC | ${a.user_name} | ${ACT[a.type] || a.type}${a.note ? ': ' + String(a.note).replace(/\s+/g, ' ').slice(0, 400) : ''}`) : ['- no activity logged']));

  const prompt = `You are a careful research assistant for skillBNK's LinkedIn outreach. Follow the rulebook below exactly. You research and draft only; a human sends and logs everything (H1).

=== TASK ===
The lead data includes a NEXT STEP suggested by the CRM. Say whether you agree with it. If you do not, say what the right next step is and why, using the rules.
Research the lead below and return one RESULT BLOCK, in this order:
1. Rule check: "All hard rules met", or the H-number that could not be met and why.
2. Verdict: PURSUE, QUALIFY, NURTURE or SKIP, with a one-line reason. If SKIP, STOP after one line (H2): name, company, SKIP, reason.
3. Category and lead type (use only the dropdown values listed in the rules).
4. Business: what they sell, headcount and hiring, who is trained, who pays, what learners pay, whether they sell training or train their own staff.
5. Tech check: LMS or payment tool found with the exact link, or "no LMS found on pages checked".
6. Compliance signal: yes, no or unknown (a reason to ask, not a claim).
7. Buyer: name and role; buyer or champion; is the authority verified?
8. Location: verified location and distance from Warren, Michigan (approximate or exact), with the source.
9. History: what the CRM history below shows. Tell me which inboxes a human still has to check (regular LinkedIn, Sales Navigator, hello@skillbnk.com).
10. Booking route: exact URL or "not found on pages checked".
11. Missing fact (for QUALIFY): the one fact still to verify and the smallest action to verify it.
12. Conditions that applied: the C-numbers.
13. Question sheet: what I think about this lead (facts and inferences separate), Question 1 with its reason, Question 2.
14. Opportunity ratings (Strong, Possible, Unproven, No evidence, Not justified, one evidence note each): Direct skillBNK Customer; Strategic Partnership; AI Video / Content Tool; AI Agent / Automation Tool; Custom Platform Development; Discovery Meeting; Relationship Building.
15. A suggested CRM update (existing dropdown values only) and the Assessment line in this format: "VERDICT - ... | Pays: ... | Learner price: ... | Headcount: ... | Platform: ... (link) | Buyer: ...".
Add one line: "Next step for the team member" in plain words (comment, like, follow, connection request, message, follow-up, InMail or email, or wait), with the reason. Then, only if the verdict is not SKIP, draft the next message for a human to send: a connection note (300 characters or fewer) if not yet connected, otherwise a first message or follow-up that follows the rules (no signature, no emoji, no offer, no meeting request in a first message).

How to work:
- Use web browsing if you can: read the company website beyond the homepage (About, programs, pricing, contact, team, careers, footer), read the link target of every Enroll, Buy, Login and Book button, and check the LinkedIn profile and company page.
- Use the CRM data below as given, but it may be old: check headcount, title and company for changes and tell me where they disagree.
- Never invent anything. If you cannot find a fact, write "not found on pages checked". Label inferences as "inference". If you cannot browse, say so and list what a human must check instead of guessing.
- If the CRM fit hint says SKIP (more than 50 employees, or a title with no decision authority), confirm the headcount and the person's authority first. Do not spend time beyond that if it holds.
- Reply in plain English. Keep it short and scannable.

=== RULEBOOK (${custom ? 'saved on the CRM Playbook page' : RULES_VERSION}) ===
${rules}

=== LEAD DATA FROM THE CRM (id ${l.id}) ===
${L.join('\n')}

=== END ===
Start now with the result block.`;
  return { prompt, chars: prompt.length, rules_source: custom ? 'CRM Playbook page' : RULES_VERSION, lead_id: l.id };
}
