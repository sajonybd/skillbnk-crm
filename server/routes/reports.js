import { Router } from 'express';
import { TARGET_METRICS, TZ_OFFSET_MIN, OUTREACH_STATUSES, MEETING_STATUSES, PLAN_SWITCH_HOUR } from '../config.js';
import { HttpError } from '../db.js';
import { todayLocal, addDays, computeKpi } from '../lib/kpi.js';
import { isWorkingDay } from '../lib/taskdays.js';
import { planMembers } from './plan.js';
import { tasksOn } from './tasks.js';
import { clean } from '../lib/cadence.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nextWorkingDay = (d) => { let x = addDays(d, 1); while (!isWorkingDay(x)) x = addDays(x, 1); return x; };
const dhakaHour = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000).getUTCHours();
const longDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const timeOf = (iso) => new Date(Date.parse(iso) + TZ_OFFSET_MIN * 60000).toISOString().slice(11, 16);
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');

// Markdown helpers. Table cells must not contain pipes or line breaks.
const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s*\n+\s*/g, ' ').trim() || '–';
const table = (head, rows) => (rows.length ? ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |')].join('\n') : '');
const nm = (l) => `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.company || '(no name)';
const who = (l) => (l.company && nm(l) !== l.company ? `${nm(l)} (${l.company})` : nm(l));
const statusText = (s) => (s ? OUTREACH_STATUSES[s] || s : 'No response yet');
const GOOD_FIT = (q) => q && q !== 'Not a Fit';


// WhatsApp copy: no tables, single * for bold. Each table becomes one bullet per row.
const ROW = {
  'Activity|Target|Done|% of target': (c) => `- ${c[0]}: **${c[2]}** / ${c[1]} (${c[3]})`,
  'Prospect|Comment|Time': (c) => `- **${c[0]}** (${c[2]}): ${c[1]}`,
  'Prospect|Type|Message|Outcome so far': (c) => `- **${c[0]}** (${c[1]}): ${c[2]} [${c[3]}]`,
  'Prospect|Email|Outcome so far': (c) => `- **${c[0]}**: ${c[1]} [${c[2]}]`,
  'Prospect|Note sent|Status': (c) => `- **${c[0]}**: ${c[1]} [${c[2]}]`,
  'Prospect|Verdict|Program fit|Reason': (c) => `- **${c[0]}**: ${c[1]}${c[2] !== '–' ? ' (' + c[2] + ')' : ''}. ${c[3]}`,
  'Prospect|When|Status|Notes': (c) => `- **${c[0]}**: ${c[1]}, ${c[2]}${c[3] !== '–' ? '. ' + c[3] : ''}`,
};
export function toWhatsApp(md) {
  const lines = md.split('\n');
  const out = [];
  const cells = (x) => x.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((v) => v.trim());
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const head = cells(lines[i]);
      const fmt = ROW[head.join('|')] || ((c) => '- ' + c.map((v, j) => (j ? `${head[j]}: ${v}` : `**${v}**`)).join(' · '));
      i += 2;
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) out.push(fmt(cells(lines[i])));
      i--;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\*\*/g, '*').replace(/^(#{1,2}) (.+)$/gm, (m, h, t) => (h === '#' && !/^\*/.test(t) ? `# *${t}*` : m)).replace(/\n{3,}/g, '\n\n');
}

export function reportRoutes(db) {
  const r = Router();
  const shift = `${TZ_OFFSET_MIN >= 0 ? '+' : '-'}${Math.abs(TZ_OFFSET_MIN)} minutes`;

  function pickPeople(req) {
    const a = req.query.assignee || (req.user.role === 'admin' ? 'all' : 'me');
    const users = db.prepare("SELECT id, name, role FROM users WHERE active = 1 AND removed_at = '' ORDER BY name").all();
    const picked = a === 'all' ? users.filter((u) => u.role !== 'admin' || users.length === 1) : users.filter((u) => u.id === (a === 'me' ? req.user.id : Number(a)));
    if (!picked.length) throw new HttpError(404, 'Unknown person');
    return { picked, all: a === 'all' };
  }

  const acts = (uid, from, to) => db.prepare(
    `SELECT a.type, a.note, a.meta, a.created_at, l.id AS lead_id, l.first_name, l.last_name, l.company, l.outreach_status, l.first_dm_date, l.stage, l.quality,
            l.denial_reason, l.assessment, l.why_in_pipeline
     FROM activities a JOIN leads l ON l.id = a.lead_id
     WHERE a.user_id = ? AND l.deleted_at = '' AND date(a.created_at, '${shift}') BETWEEN ? AND ? ORDER BY a.created_at`
  ).all(uid, from, to);
  const metaOf = (a) => { try { return JSON.parse(a.meta || '{}'); } catch { return {}; } };

  // Leads this person rated during the period: qualified, not a fit, nurture, not interested.
  function research(list) {
    const out = [];
    for (const a of list) {
      const m = metaOf(a);
      const reason = clean(a.denial_reason) || clean(a.assessment) || clean(a.why_in_pipeline);
      if (a.type === 'quality_change' && m.to !== undefined) {
        const bad = m.to === 'Not a Fit';
        if (!m.to) continue;
        out.push({ lead: a, verdict: bad ? 'NOT A FIT' : 'QUALIFIED', fit: bad ? '–' : m.to, reason: reason || (bad ? 'No reason written. Add one in the lead' : '–') });
      } else if (a.type === 'response_change' && ['NUTR', 'NI'].includes(m.to)) {
        out.push({ lead: a, verdict: m.to === 'NI' ? 'NOT INTERESTED' : 'NURTURE', fit: clean(a.quality) || '–', reason: reason || '–' });
      }
    }
    return out;
  }

  // ── Daily work plan ────────────────────────────────────────────────────────
  function planMd(u, date, today) {
    const [m] = planMembers(db, { date, today, picked: [u] });
    const L = [`# Daily Work Plan: ${u.name}`, `**Date:** ${longDate(date)}${isWorkingDay(date) ? '' : ' (day off)'}`, ''];
    const T = []; // tables go at the bottom of the report and are left out when it is copied
    const meets = db.prepare(
      `SELECT mt.scheduled_time, mt.notes, mt.status, l.first_name, l.last_name, l.company FROM meetings mt JOIN leads l ON l.id = mt.lead_id
       WHERE l.deleted_at = '' AND mt.scheduled_date = ? AND mt.status = 'booked' AND (l.owner_id = ? OR mt.booked_by = ?) ORDER BY mt.scheduled_time`
    ).all(date, u.id, u.id);
    const tasks = m.tasks;
    // Top 3 priorities
    const pri = [];
    for (const x of meets) pri.push(`Meeting${x.scheduled_time ? ' at ' + x.scheduled_time : ''} with ${who(x)}: prepare the agenda and one-pager`);
    for (const a of m.actions) { if (pri.length >= 3) break; pri.push(`${a.verb}: ${who(a)}${a.pursue ? ' (PURSUE)' : ''}`); }
    L.push('## Top 3 priorities', ...(pri.length ? pri.slice(0, 3).map((x, i) => `${i + 1}. ${x}`) : ['1. No lead actions are due. Use the day for research and engagement.']), '');

    L.push('## Outreach & research targets');
    if (m.targets.length) L.push(...m.targets.map((t, i) => `${i + 1}. ${t.label}: **${t.target}**`));
    else L.push('- No daily targets are set for you.');
    L.push('');

    const byKind = {};
    for (const a of m.actions) byKind[a.verb] = (byKind[a.verb] || 0) + 1;
    L.push('## Follow-ups & pipeline');
    if (!m.actions.length) L.push('- Nothing is due.');
    else {
      L.push(`**${m.summary.actions}** lead action${m.summary.actions === 1 ? '' : 's'} due; **${m.summary.shown}** planned for the day${m.summary.carry_over ? `, **${m.summary.carry_over}** carry over` : ''}.`, '');
      L.push(...Object.entries(byKind).map(([k, n]) => `- ${k}: **${n}**`), '');
      T.push('## Follow-up list', table(['#', 'Prospect', 'Action', 'Why', 'Due'], m.actions.map((a, i) => [i + 1, who(a) + (a.pursue ? ' [PURSUE]' : ''), a.verb, a.reason, a.late_days > 0 ? `${a.late_days}d late` : 'due'])), '');
    }
    if (m.summary.stale) L.push(`> ${m.summary.stale} stale leads (14+ days late) are waiting to be closed or moved to nurture.`);
    L.push('');

    L.push('## Operations & team tasks');
    const boldNums = (x) => String(x).replace(/\*\*/g, '').replace(/\d+(?:[-–]\d+)?%?/g, (n) => `**${n}**`);
    L.push(...(tasks.length ? tasks.map((t) => `- ${t.window ? '**' + t.window + '** ' : ''}${boldNums(t.title)}${t.expected ? ': ' + boldNums(t.expected) : ''}`) : ['- No scheduled tasks.']), '');

    if (meets.length) {
      L.push('## Meetings', ...meets.map((x) => `- ${x.scheduled_time || 'Time not set'}: ${who(x)}${x.notes ? ' (' + x.notes + ')' : ''}`), '');
      T.push('## Meetings table', table(['Time', 'Prospect', 'Notes'], meets.map((x) => [x.scheduled_time || '–', who(x), x.notes])), '');
    }
    // WhatsApp copy: single * for bold, operations tasks as "* " bullets, no tables.
    const wa = L.join('\n').replace(/\*\*/g, '*').replace(/^# (.+)$/gm, '# *$1*').replace(/^## Operations & team tasks$/m, '## *Operations & team tasks*')
      .replace(/(## \*Operations & team tasks\*\n)([\s\S]*?)(\n\n|$)/, (_, a, b, c) => a + b.replace(/^- /gm, '* ') + c);
    return { md: [...L, ...T].join('\n'), copy: wa };
  }

  r.get('/plan', (req, res) => {
    const today = todayLocal();
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : dhakaHour() >= PLAN_SWITCH_HOUR ? nextWorkingDay(today) : today;
    const { picked } = pickPeople(req);
    const items = picked.map((u) => ({ user_id: u.id, name: u.name, ...planMd(u, date, today) }));
    res.json({ kind: 'plan', title: `Daily Work Plan ${date}`, date, markdown: items.map((x) => x.md).join('\n\n---\n\n'), copy: items.map((x) => x.copy).join('\n\n---\n\n'), items });
  });

  // ── End-of-day update ──────────────────────────────────────────────────────
  function eodMd(u, date, today) {
    const list = acts(u.id, date, date);
    const of = (...t) => list.filter((a) => t.includes(a.type));
    const tgt = db.prepare('SELECT metric, daily_target FROM member_targets WHERE user_id = ? AND daily_target > 0').all(u.id);
    const count = (t) => list.filter((a) => a.type === t).length;
    const L = [`# End-of-Day Work Update: ${u.name}`, `**Date:** ${longDate(date)}`, ''];

    // 1. Summary against the plan
    const rows = Object.entries(TARGET_METRICS).map(([k, label]) => {
      const t = tgt.find((x) => x.metric === k)?.daily_target || 0;
      return [label, t || '–', count(k), t ? pct(count(k), t) : '–'];
    }).filter((x) => x[1] !== '–' || x[2] > 0);
    const replies = list.filter((a) => a.type === 'response_change' && metaOf(a).to === 'R');
    const tasks = tasksOn(db, date, u.name);
    L.push('## 1. Summary: plan vs done', rows.length ? table(['Activity', 'Target', 'Done', '% of target'], rows) : '- No daily targets are set and no counted activity was logged.', '');
    L.push(`- Accepted connections: **${count('linkedin_connected')}** · Day-8 / other emails sent: **${count('email')}** · Replies received: **${replies.length}** · Meetings booked: **${count('meeting_booked')}**`);
    L.push(`- Team tasks completed: **${tasks.filter((t) => t.done).length} of ${tasks.length}**`, '');

    // 2. Outreach & engagement log
    L.push('## 2. Outreach & engagement log');
    const comments = of('linkedin_comment');
    L.push(`### Comments (${comments.length})`, comments.length ? table(['Prospect', 'Comment', 'Time'], comments.map((a) => [who(a), a.note || '(text not recorded)', timeOf(a.created_at)])) : '- None logged.', '');
    const dms = of('linkedin_dm', 'linkedin_inmail');
    L.push(`### Messages and follow-ups (${dms.length})`, dms.length ? table(['Prospect', 'Type', 'Message', 'Outcome so far'], dms.map((a) => [who(a), a.first_dm_date === date || a.type === 'linkedin_inmail' ? (a.type === 'linkedin_inmail' ? 'InMail' : 'First message') : 'Follow-up', a.note || '(text not recorded)', statusText(a.outreach_status)])) : '- None logged.', '');
    const emails = of('email');
    L.push(`### Emails (${emails.length})`, emails.length ? table(['Prospect', 'Email', 'Outcome so far'], emails.map((a) => [who(a), a.note || '(text not recorded)', statusText(a.outreach_status)])) : '- None logged.', '');
    const inv = of('linkedin_connect');
    L.push(`### Connection requests (${inv.length})`, inv.length ? table(['Prospect', 'Note sent', 'Status'], inv.map((a) => [who(a), a.note, statusText(a.outreach_status)])) : '- None logged.', '');
    const acc = of('linkedin_connected');
    if (acc.length) L.push(`### Accepted (${acc.length})`, ...acc.map((a) => `- ${who(a)}`), '');
    if (replies.length) L.push(`### Replies received (${replies.length})`, ...replies.map((a) => `- ${who(a)}`), '');
    const touches = ['linkedin_like', 'linkedin_follow', 'linkedin_view'].map((t) => [t, count(t)]).filter((x) => x[1]);
    if (touches.length) L.push(`Other touches: ${touches.map(([t, n]) => `${TARGET_METRICS[t]} ${n}`).join(', ')}.`, '');

    // 3. Research
    const rs = research(list);
    L.push('## 3. Lead research & qualification', rs.length ? table(['Prospect', 'Verdict', 'Program fit', 'Reason'], rs.map((x) => [who(x.lead), x.verdict, x.fit, x.reason])) : '- No leads were rated today.', '');
    const ok = rs.filter((x) => x.verdict === 'QUALIFIED').length, bad = rs.filter((x) => x.verdict === 'NOT A FIT').length;
    if (rs.length) L.push(`Qualified: **${ok}** · Not a fit: **${bad}** · Nurture / not interested: **${rs.length - ok - bad}**`, '');

    // 4. Meetings
    const meets = db.prepare(
      `SELECT mt.scheduled_date, mt.scheduled_time, mt.status, mt.notes, l.first_name, l.last_name, l.company, date(mt.created_at, '${shift}') AS booked_on
       FROM meetings mt JOIN leads l ON l.id = mt.lead_id
       WHERE l.deleted_at = '' AND ((mt.booked_by = ? AND date(mt.created_at, '${shift}') = ?) OR (mt.scheduled_date = ? AND (l.owner_id = ? OR mt.booked_by = ?)))
       ORDER BY mt.scheduled_date, mt.scheduled_time`
    ).all(u.id, date, date, u.id, u.id);
    L.push('## 4. Meetings & client coordination', meets.length ? table(['Prospect', 'When', 'Status', 'Notes'], meets.map((x) => [who(x), `${shortDate(x.scheduled_date)}${x.scheduled_time ? ' ' + x.scheduled_time : ''}`, (MEETING_STATUSES[x.status] || x.status) + (x.booked_on === date ? ' (booked today)' : ''), x.notes])) : '- No meetings booked or held today.', '');

    // 5. Blockers / carryover
    const [left] = planMembers(db, { date: today, today, picked: [u] });
    L.push('## 5. Blockers & carryover for tomorrow');
    const undone = tasks.filter((t) => !t.done);
    L.push(`- Lead actions still pending: **${left.summary.actions}**${left.actions.length ? ' (top: ' + left.actions.slice(0, 5).map((a) => nm(a) + ': ' + a.verb).join('; ') + ')' : ''}`);
    L.push(`- Replies waiting for an answer: **${left.responses.counts.replied}** · Seen but no reply: **${left.responses.counts.seen_no_reply}** · Invites pending: **${left.responses.counts.pending_invites}**`);
    if (left.summary.stale) L.push(`- Stale leads to close or nurture: **${left.summary.stale}**`);
    L.push(...(undone.length ? ['- Team tasks not finished:', ...undone.map((t) => `  - ${t.title}`)] : ['- All scheduled team tasks are done.']), '');
    // ── WhatsApp summary: totals and a few names, no lists of every lead ──
    const uniq = (arr) => [...new Map(arr.map((a) => [a.lead_id ?? a.id ?? nm(a), a])).values()];
    const names = (arr, max = 5) => { const n = uniq(arr).map(nm); return n.length <= max ? n.join(', ') : `${n.slice(0, max).join(', ')} and ${n.length - max} more`; };
    const tg = (k) => tgt.find((x) => x.metric === k)?.daily_target || 0;
    const withTarget = (k) => (tg(k) ? ` (Target: ${tg(k)})` : '');
    const B = (n) => `*${n}*`;
    const C = [];
    const dt = new Date(date + 'T00:00:00Z');
    const dateLine = `${dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: '2-digit', year: 'numeric' })} (${dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' })})`;
    C.push(`*Work Update – ${dateLine}*`, `By: *${u.name.toUpperCase()}*`, '');
    const accU = uniq(acc);
    C.push('*1. LinkedIn Outreach & Lead Activities*');
    if (count('linkedin_view')) C.push(`• Researched and reviewed ${B(count('linkedin_view'))} profiles${withTarget('linkedin_view')}.`);
    if (inv.length) C.push(`• Sent ${B(inv.length)} connection requests${withTarget('linkedin_connect')}.`);
    if (accU.length) C.push(`• Logged ${B(accU.length)} newly accepted connections (${names(acc, 4)}).`);
    if (dms.length) C.push(`• Sent ${B(dms.length)} LinkedIn messages and follow-ups${withTarget('linkedin_dm')}.`);
    if (emails.length) C.push(`• Sent ${B(emails.length)} emails.`);
    if (count('linkedin_like')) C.push(`• Completed ${B(count('linkedin_like'))} post likes${withTarget('linkedin_like')}.`);
    if (count('linkedin_follow')) C.push(`• Followed ${B(count('linkedin_follow'))} prospect and company profiles${withTarget('linkedin_follow')}.`);
    if (comments.length) C.push(`• Wrote ${B(comments.length)} comments on prospect and industry posts (engaged with ${names(comments, 4)}${tg('linkedin_comment') ? `; target ${tg('linkedin_comment')}` : ''}).`);
    if (replies.length) C.push(`• Received ${B(replies.length)} ${replies.length === 1 ? 'reply' : 'replies'} (${names(replies, 4)}).`);
    if (C[C.length - 1] === '*1. LinkedIn Outreach & Lead Activities*') C.push('• No outreach activity was logged today.');
    C.push('');
    C.push('*2. Lead Research & Qualification*');
    if (rs.length) {
      const fits = {};
      for (const x of rs.filter((y) => y.verdict === 'QUALIFIED')) fits[x.fit] = (fits[x.fit] || 0) + 1;
      const split = Object.entries(fits).map(([f, n]) => (f === '–' ? `${n} other` : `${n} ${f}`)).join(', ');
      C.push(`• Screened and rated ${B(rs.length)} leads in the CRM:`);
      if (ok) C.push(`  - ${B(ok)} QUALIFIED${split ? ` (${split})` : ''}`);
      if (bad) C.push(`  - ${B(bad)} NOT A FIT`);
      if (rs.length - ok - bad) C.push(`  - ${B(rs.length - ok - bad)} NURTURE / NOT INTERESTED`);
    } else C.push('• No leads were rated today.');
    C.push('');
    if (meets.length) {
      const done = meets.filter((x) => x.status === 'completed').length, booked = meets.filter((x) => x.booked_on === date).length;
      C.push('*3. Meetings & Client Coordination*');
      if (booked) C.push(`• Booked ${B(booked)} meetings (${meets.filter((x) => x.booked_on === date).map(nm).join(', ')}).`);
      if (done) C.push(`• Held ${B(done)} meetings (${meets.filter((x) => x.status === 'completed').map(nm).join(', ')}).`);
      const rest = meets.length - booked - done;
      if (rest > 0) C.push(`• ${B(rest)} more meetings on today's calendar.`);
      C.push('');
    }
    C.push(`*${meets.length ? '4' : '3'}. Team Tasks & Operational Support*`);
    // Only tasks that were ticked as done are reported; open ones appear under tomorrow's priorities.
    const doneTasks = tasks.filter((t) => t.done);
    if (!tasks.length) C.push('• No team tasks were scheduled.');
    else {
      C.push(`• Completed ${B(doneTasks.length)} of ${B(tasks.length)} assigned daily tasks${doneTasks.length ? ':' : '.'}`);
      for (const t of doneTasks) C.push(`  - ${t.title}${t.expected ? ': ' + t.expected : ''}`);
    }
    C.push('');
    C.push('*Key Outcomes*');
    const direct = rs.filter((x) => x.verdict === 'QUALIFIED' && /Customer/i.test(x.fit)).length, partner = rs.filter((x) => x.verdict === 'QUALIFIED' && /Partner/i.test(x.fit)).length;
    if (ok) C.push(`• Qualified ${B(ok)} new prospects${direct || partner ? ` (${direct} direct customer, ${partner} strategic partnership)` : ''}.`);
    if (accU.length) C.push(`• ${B(accU.length)} accepted connections are ready for first-message outreach.`);
    if (replies.length) C.push(`• ${B(replies.length)} ${replies.length === 1 ? 'reply' : 'replies'} received from prospects.`);
    if (meets.filter((x) => x.booked_on === date).length) C.push(`• ${B(meets.filter((x) => x.booked_on === date).length)} meetings booked.`);
    const hit = Object.keys(TARGET_METRICS).filter((k) => tg(k) && count(k) >= tg(k));
    if (hit.length) C.push(`• Target met or exceeded for: ${hit.map((k) => TARGET_METRICS[k]).join(', ')}.`);
    if (C[C.length - 1] === '*Key Outcomes*') C.push('• Daily activity logged in the CRM.');
    C.push('');
    C.push("*Carryover & Tomorrow's Priorities*");
    if (accU.length) C.push(`• Send first messages to today's ${B(accU.length)} accepted connections (${names(acc, 3)}).`);
    if (left.responses.counts.replied) C.push(`• Answer ${B(left.responses.counts.replied)} ${left.responses.counts.replied === 1 ? 'reply' : 'replies'} waiting.`);
    if (left.summary.actions) {
      const byVerb = {};
      for (const a of left.actions) byVerb[a.verb] = (byVerb[a.verb] || 0) + 1;
      const top = Object.entries(byVerb).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, n]) => `${n} × ${v.toLowerCase()}`).join('; ');
      C.push(`• Work through ${B(left.summary.actions)} lead actions due${top ? ` (mostly: ${top})` : ''}.`);
    }
    if (left.summary.stale) C.push(`• Close or nurture ${B(left.summary.stale)} stale leads.`);
    if (undone.length) C.push(`• Finish ${B(undone.length)} open team tasks (${undone.slice(0, 3).map((t) => t.title).join('; ')}${undone.length > 3 ? ` and ${undone.length - 3} more` : ''}).`);
    return { md: L.join('\n'), copy: C.join('\n') };
  }

  r.get('/eod', (req, res) => {
    const today = todayLocal();
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : today;
    const { picked } = pickPeople(req);
    const items = picked.map((u) => eodMd(u, date, today));
    res.json({ kind: 'eod', title: `End-of-Day Update ${date}`, date, markdown: items.map((x) => x.md).join('\n\n---\n\n'), copy: items.map((x) => x.copy).join('\n\n---\n\n') });
  });

  // ── Weekly KPI report ──────────────────────────────────────────────────────
  // The team week runs Saturday to Friday (Friday is off), so by default this is the week so far.
  function weekStartSat(d) { const dow = new Date(d + 'T00:00:00Z').getUTCDay(); return addDays(d, -((dow + 1) % 7)); }

  function weeklyData(u, from, to) {
    const list = acts(u.id, from, to);
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(d)) days.push(d);
    const n = (t) => list.filter((a) => a.type === t).length;
    const tgt = db.prepare('SELECT metric, daily_target FROM member_targets WHERE user_id = ? AND daily_target > 0').all(u.id);
    const metrics = Object.entries(TARGET_METRICS).map(([k, label]) => {
      const daily = tgt.find((x) => x.metric === k)?.daily_target || 0;
      return { k, label, target: daily * days.length, actual: n(k) };
    }).filter((x) => x.target || x.actual);
    const rs = research(list);
    const reasons = {};
    for (const x of rs.filter((x) => x.verdict === 'NOT A FIT')) { const k = x.reason.startsWith('No reason') ? 'No reason recorded' : x.reason.slice(0, 80); reasons[k] = (reasons[k] || 0) + 1; }
    return {
      list, days, metrics, rs, reasons,
      invites: n('linkedin_connect'), accepted: n('linkedin_connected'), dms: list.filter((a) => ['linkedin_dm', 'linkedin_inmail'].includes(a.type)).length,
      emails: n('email'), replies: list.filter((a) => a.type === 'response_change' && metaOf(a).to === 'R').length,
      booked: n('meeting_booked'), held: n('meeting_completed'),
      nurtured: rs.filter((x) => x.verdict === 'NURTURE' || x.verdict === 'NOT INTERESTED').length,
      daily: days.map((d) => ({ d, rows: list.filter((a) => date(a) === d) })),
    };
    function date(a) { return new Date(Date.parse(a.created_at) + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10); }
  }

  function weeklyMd(users, from, to, today, isTeam) {
    const kpi = computeKpi(db);
    const per = users.map((u) => ({ u, d: weeklyData(u, from, to) }));
    const L = [`# Weekly KPI Performance Report`, `**Period:** ${shortDate(from)} to ${shortDate(to)} · **Team / member:** ${isTeam ? 'skillBNK Outreach Team' : users[0].name}`, ''];

    // team totals by metric
    const sumMetric = (k, f) => per.reduce((s, p) => s + (p.d.metrics.find((m) => m.k === k)?.[f] || 0), 0);
    const keys = [...new Set(per.flatMap((p) => p.d.metrics.map((m) => m.k)))];
    L.push('## 1. Executive KPI summary', table(['Metric', 'Target', 'Actual', '% achieved'], keys.map((k) => [TARGET_METRICS[k], sumMetric(k, 'target') || '–', sumMetric(k, 'actual'), sumMetric(k, 'target') ? pct(sumMetric(k, 'actual'), sumMetric(k, 'target')) : '–'])), '');
    const T = (f) => per.reduce((s, p) => s + p.d[f], 0);
    const kRows = kpi.filter((k) => users.some((u) => u.id === k.id));
    const mTarget = kRows.reduce((s, k) => s + k.target, 0);
    L.push(table(['Result', 'Count'], [
      ['Connections accepted', `${T('accepted')} (acceptance rate ${pct(T('accepted'), T('invites'))} of ${T('invites')} invites sent this week)`],
      ['DMs and InMails sent', T('dms')], ['Day-8 / other emails sent', T('emails')], ['Replies received', T('replies')],
      ['Discovery meetings booked', `${T('booked')}${mTarget ? ' vs weekly target ' + mTarget + ' (' + pct(T('booked'), mTarget) + ')' : ''}`],
      ['Meetings completed', T('held')],
    ]), '', '> Acceptance counts only the acceptances someone logged in the CRM, so the real rate may be higher.', '');

    if (isTeam) {
      L.push('### By person', table(['Person', ...keys.map((k) => TARGET_METRICS[k]), 'Invites', 'Accepted', 'DMs', 'Replies', 'Meetings'],
        per.map((p) => [p.u.name, ...keys.map((k) => { const m = p.d.metrics.find((x) => x.k === k); return m ? `${m.actual}/${m.target || '–'}` : '–'; }), p.d.invites, p.d.accepted, p.d.dms, p.d.replies, p.d.booked])), '');
    }
    const dayHead = per[0]?.d.days || [];
    L.push('### Day by day', table(['Date', 'Comments', 'Messages', 'Connections', 'Emails', 'Replies', 'Meetings booked'], dayHead.map((d) => {
      const rows = per.flatMap((p) => p.d.list.filter((a) => new Date(Date.parse(a.created_at) + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10) === d));
      const c = (f) => rows.filter(f).length;
      return [shortDate(d), c((a) => a.type === 'linkedin_comment'), c((a) => ['linkedin_dm', 'linkedin_inmail'].includes(a.type)), c((a) => a.type === 'linkedin_connect'), c((a) => a.type === 'email'), c((a) => a.type === 'response_change' && metaOf(a).to === 'R'), c((a) => a.type === 'meeting_booked')];
    })), '');

    // 2. Pipeline
    L.push('## 2. Pipeline conversion & meetings impact');
    L.push(table(['Step', 'Count', 'Rate'], [
      ['Invites sent', T('invites'), '–'], ['Accepted', T('accepted'), pct(T('accepted'), T('invites'))], ['Messages sent', T('dms'), '–'],
      ['Replies', T('replies'), pct(T('replies'), T('dms'))], ['Meetings booked', T('booked'), pct(T('booked'), T('replies'))],
    ]), '');
    if (kRows.length) L.push(table(['Person', 'Weekly target (with carry-in)', 'Booked this KPI week', 'Remaining / carryover'], kRows.map((k) => [k.name, k.target, k.booked, k.remaining])), '');
    const live = planMembers(db, { date: today, today, picked: users });
    const activeConv = live.reduce((s, m) => s + m.responses.counts.replied, 0);
    L.push(`Active conversations (replied, waiting for us): **${activeConv}**`, '');

    // 3. Lead quality
    const allRs = per.flatMap((p) => p.d.rs);
    const ok = allRs.filter((x) => x.verdict === 'QUALIFIED'), bad = allRs.filter((x) => x.verdict === 'NOT A FIT');
    L.push('## 3. Lead quality & disqualification analysis');
    L.push(`- Qualified: **${ok.length}** · Not a fit: **${bad.length}** · Nurtured / not interested: **${allRs.length - ok.length - bad.length}**`, `- Stale leads waiting to be cleaned: **${live.reduce((s, m) => s + m.summary.stale, 0)}**`, '');
    const reasons = {};
    for (const p of per) for (const [k, v] of Object.entries(p.d.reasons)) reasons[k] = (reasons[k] || 0) + v;
    if (Object.keys(reasons).length) L.push('**Top reasons for "not a fit"**', ...Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `- ${k}: ${v}`), '');
    if (allRs.length) L.push(table(['Prospect', 'Verdict', 'Program fit', 'Reason'], allRs.slice(0, 60).map((x) => [who(x.lead), x.verdict, x.fit, x.reason])), allRs.length > 60 ? `…and ${allRs.length - 60} more.` : '', '');

    // 4. Focus
    L.push('## 4. Focus & corrective actions for next week');
    const lows = keys.map((k) => ({ k, p: sumMetric(k, 'target') ? sumMetric(k, 'actual') / sumMetric(k, 'target') : 1 })).filter((x) => x.p < 0.8).sort((a, b) => a.p - b.p).slice(0, 3);
    for (const x of lows) L.push(`- Raise **${TARGET_METRICS[x.k]}**: reached ${Math.round(x.p * 100)}% of target.`);
    const emailDue = live.reduce((s, m) => s + m.actions.filter((a) => a.kind === 'email').length, 0);
    if (emailDue) L.push(`- Clear the Day-8 email backlog (${emailDue} due today).`);
    if (activeConv) L.push(`- Answer the ${activeConv} replies waiting.`);
    if (kRows.some((k) => k.remaining)) L.push(`- Meetings carry into next week: ${kRows.filter((k) => k.remaining).map((k) => `${k.name} ${k.remaining}`).join(', ')}.`);
    if (!lows.length && !emailDue && !activeConv) L.push('- Targets are on track. Keep the cadence.');
    L.push('', '> Content published (newsletters, videos) is not tracked in the CRM. Add it by hand before submitting.');
    return L.join('\n');
  }

  r.get('/weekly', (req, res) => {
    const today = todayLocal();
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : today;
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : weekStartSat(to);
    if (from > to) throw new HttpError(400, 'The start date is after the end date');
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000) throw new HttpError(400, 'Choose a period of up to 62 days');
    const { picked, all } = pickPeople(req);
    const users = all ? picked.filter((u) => u.role !== 'admin') : picked;
    const markdown = weeklyMd(users.length ? users : picked, from, to, today, all);
    res.json({ kind: 'weekly', title: `Weekly KPI ${from} to ${to}`, from, to, markdown, copy: toWhatsApp(markdown) });
  });

  return r;
}
