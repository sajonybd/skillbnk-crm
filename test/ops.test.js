import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'test-secret';
const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { seedAdmin } = await import('../server/auth.js');
const { parseDays, dueOn, isWorkingDay } = await import('../server/lib/taskdays.js');
const { seedOps } = await import('../server/lib/seed-ops.js');

let server, base, cookie = '', db;
async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db);
  seedOps(db);
  server = createApp(db).listen(0);
  base = `http://localhost:${server.address().port}`;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@skillbnk.local', password: 'admin123' }) });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});
after(() => server.close());

test('parseDays/dueOn: Sat-Thu wraps and skips Friday', () => {
  assert.equal(dueOn('Sat-Thu', '2026-11-05'), true);  // Thu
  assert.equal(dueOn('Sat-Thu', '2026-11-06'), false); // Fri
  assert.equal(dueOn('Sat-Thu', '2026-11-08'), true);  // Sun (wrapped)
  assert.equal(dueOn('Mon/Wed', '2026-11-04'), true);
  assert.equal(dueOn('Mon/Wed', '2026-11-05'), false);
  assert.equal(dueOn('1st - 10th of month', '2026-11-10'), true);
  assert.equal(dueOn('1st - 10th of month', '2026-11-11'), false);
  assert.equal(parseDays('').adhoc, true);
  assert.equal(isWorkingDay('2026-11-06'), false);
});

test('seeded tasks are returned for a working day', async () => {
  const r = await call('GET', '/api/tasks?date=2026-11-05&assignee=all');
  assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r).length > 100);
});

test('targets endpoint responds and admin can edit', async () => {
  const r = await call('GET', '/api/targets?date=2026-11-05');
  assert.equal(r.status, 200);
  const e = await call('GET', '/api/targets/edit');
  assert.equal(e.status, 200);
});

test('adding a lead that already exists updates it instead of duplicating (email, LinkedIn, name+company)', async () => {
  const a = await call('POST', '/api/leads', { first_name: 'Dana', last_name: 'Lee', company: 'Acme Academy', email: 'dana@acme.com' });
  assert.equal(a.status, 201);
  // same person by LinkedIn only, new info: title
  const b = await call('POST', '/api/leads', { first_name: 'Dana', last_name: 'Lee', company: 'Acme Academy', linkedin: 'https://www.linkedin.com/in/dana-lee/', title: 'Director' });
  assert.equal(b.existing, true);
  assert.equal(b.id, a.id);
  assert.ok(b.filled.includes('linkedin') && b.filled.includes('title'));
  // now found by LinkedIn alone (different key than the stored email key)
  const c = await call('POST', '/api/leads', { linkedin: 'linkedin.com/in/dana-lee', phone: '123' });
  assert.equal(c.existing, true);
  assert.equal(c.id, a.id);
  // email in different case
  const d = await call('POST', '/api/leads', { email: 'DANA@acme.com' });
  assert.equal(d.id, a.id);
  const lead = (await call('GET', `/api/leads/${a.id}`)).lead;
  assert.equal(lead.title, 'Director');
  assert.equal(lead.phone, '123');
  assert.equal(lead.email, 'dana@acme.com');
});

test('plan: step buttons move a lead through the cadence', async () => {
  const mk = await call('POST', '/api/leads', { first_name: 'Pia', last_name: 'Rao', company: 'Skill Co', email: 'pia@skill.co', email_status: 'verified', invite_sent_date: '2026-10-01' });
  const id = mk.id;
  await call('PATCH', `/api/leads/${id}`, { invite_sent_date: '2026-10-01' });
  let plan = await call('GET', '/api/plan?day=today&assignee=all');
  const mine = (p) => p.members.flatMap((m) => [...m.actions, ...m.stale]).find((x) => x.id === id);
  assert.ok(mine(plan), 'lead is in the plan');
  assert.equal(mine(plan).stale, true); // invite was long ago
  const ok = await call('POST', `/api/leads/${id}/step`, { result: 'accepted' });
  assert.equal(ok.lead.accepted_date.length, 10);
  plan = await call('GET', '/api/plan?day=today&assignee=all');
  assert.equal(mine(plan).kind, 'first_message');
  await call('POST', `/api/leads/${id}/step`, { result: 'sent', kind: 'first_message' });
  let l = (await call('GET', `/api/leads/${id}`)).lead;
  assert.equal(l.outreach_status, 'U');
  assert.ok(l.first_dm_date);
  plan = await call('GET', '/api/plan?day=today&assignee=all');
  assert.equal(mine(plan), undefined, 'nothing due right after sending');
  await call('POST', `/api/leads/${id}/step`, { result: 'seen' });
  l = (await call('GET', `/api/leads/${id}`)).lead;
  assert.equal(l.outreach_status, 'SNR');
  await call('POST', `/api/leads/${id}/step`, { result: 'replied' });
  plan = await call('GET', '/api/plan?day=today&assignee=all');
  assert.equal(mine(plan).kind, 'reply');
  const bad = await call('POST', `/api/leads/${id}/step`, { result: 'nope' });
  assert.equal(bad.status, 400);
});

test('plan: tomorrow view skips Friday and reports the day', async () => {
  const p = await call('GET', '/api/plan?day=tomorrow');
  assert.equal(p.status, 200);
  assert.ok(p.date >= p.today);
  assert.equal(p.working_day, true);
});

test('plan: PURSUE and replied leads come first; null placeholder text is never stored', async () => {
  const a = await call('POST', '/api/leads', { first_name: 'Zed', last_name: 'Pursue', company: 'Z Co', next_action: 'null', assessment: 'PURSUE (warm)', next_action_date: '2026-11-01' });
  const b = await call('POST', '/api/leads', { first_name: 'Amy', last_name: 'Today', company: 'A Co', next_action: 'Call', next_action_date: '2026-11-05', tier: 'A' });
  await call('PATCH', `/api/leads/${a.id}`, { next_action_date: '2026-11-01' });
  await call('PATCH', `/api/leads/${b.id}`, { next_action_date: '2026-11-05', tier: 'A' });
  const la = (await call('GET', `/api/leads/${a.id}`)).lead;
  assert.equal(la.next_action, '');
  const p = await call('GET', '/api/plan?day=today&assignee=all');
  const list = p.members.flatMap((m) => m.actions);
  const ia = list.findIndex((x) => x.id === a.id), ib = list.findIndex((x) => x.id === b.id);
  assert.ok(ia >= 0 && ib >= 0 && ia < ib, `PURSUE ranks above due-today: ${ia} ${ib} of ${list.length}; users ${p.members.length}`);
  assert.equal(list[ia].pursue, true);
});

test('plan: daily cap of 25 per person, extra carried over', async () => {
  for (let i = 0; i < 30; i++) {
    const c = await call('POST', '/api/leads', { first_name: 'Cap' + i, last_name: 'Test', company: 'Cap Co', next_action: 'Call' });
    await call('PATCH', `/api/leads/${c.id}`, { next_action_date: '2026-11-05' });
  }
  const p = await call('GET', '/api/plan?day=today&assignee=all');
  const m = p.members.find((x) => x.summary.actions > 25);
  assert.ok(m, 'someone has more than 25');
  assert.equal(m.actions.length, 25);
  assert.ok(m.summary.carry_over >= 5);
});

test('reports: end-of-day lists what was sent, with text, and research verdicts with reasons', async () => {
  const me = (await call('GET', '/api/me')).user || {};
  const a = await call('POST', '/api/leads', { first_name: 'Rita', last_name: 'Comment', company: 'Rita Academy', email: 'rita@ra.com' });
  const b = await call('POST', '/api/leads', { first_name: 'Sam', last_name: 'Solo', company: 'Solo Shop' });
  const c = await call('POST', '/api/leads', { first_name: 'Quin', last_name: 'Fit', company: 'Big Training Co' });
  await call('POST', `/api/leads/${a.id}/step`, { result: 'comment', note: 'Loved your point on spaced practice' });
  await call('POST', `/api/leads/${a.id}/step`, { result: 'sent', kind: 'first_message', note: 'Hi Rita, quick question about your cohorts' });
  await call('PATCH', `/api/leads/${b.id}`, { quality: 'Not a Fit', denial_reason: 'Solo operator, no training budget' });
  await call('PATCH', `/api/leads/${c.id}`, { quality: 'Direct skillBNK Customer', assessment: 'PURSUE: 60+ staff, runs academy' });
  const r = await call('GET', '/api/reports/eod?assignee=me');
  assert.equal(r.status, 200);
  const md = r.markdown;
  assert.match(md, /Loved your point on spaced practice/);
  assert.match(md, /Hi Rita, quick question/);
  assert.match(md, /First message/);
  assert.match(md, /Sam Solo[^|]*\| NOT A FIT \| – \| Solo operator, no training budget/);
  assert.match(md, /Quin Fit[^|]*\| QUALIFIED \| Direct skillBNK Customer \| PURSUE: 60\+ staff/);
  const w = await call('GET', '/api/reports/weekly?assignee=me');
  assert.match(w.markdown, /Weekly KPI Performance Report/);
  assert.match(w.markdown, /Solo operator, no training budget/);
  const p = await call('GET', '/api/reports/plan?assignee=me&date=2026-11-07');
  assert.match(p.markdown, /Daily Work Plan/);
  assert.equal((await call('GET', '/api/reports/weekly?from=2026-11-05&to=2026-10-01')).status, 400);
});

test('playbook: admin changes rules and a per-person cap; plan follows; members can only ask', async () => {
  const g = await call('GET', '/api/playbook');
  assert.equal(g.rules.daily_cap, 25);
  assert.ok(g.markdown.includes('skillBNK outreach plan'));
  const bad = await call('PUT', '/api/playbook/rules', { rules: { ...g.rules, followup2_day: 3 } });
  assert.equal(bad.status, 400);
  const user = (await call('GET', '/api/me')).user || (await call('GET', '/api/team')).users?.[0];
  const ok = await call('PUT', '/api/playbook/rules', { rules: { ...g.rules, daily_cap: 10, stale_days: 20 }, caps: [] });
  assert.equal(ok.status, 200);
  const p = await call('GET', '/api/plan?day=today&assignee=all');
  assert.ok(p.members.every((m) => m.actions.length <= 10), 'cap of 10 applied');
  assert.equal(p.stale_days, 20);
  await call('PUT', '/api/playbook/rules', { rules: g.rules, caps: [] });
  const t = await call('PUT', '/api/playbook/plan', { markdown: '# New plan\n\nShort but valid plan text for testing.' });
  assert.equal(t.status, 200);
  assert.match((await call('GET', '/api/playbook')).markdown, /New plan/);
  const rq = await call('POST', '/api/playbook/requests', { title: 'Lower my daily limit', details: 'Messages need research' });
  assert.equal(rq.status, 201);
  const list = (await call('GET', '/api/playbook')).requests;
  assert.equal(list[0].title, 'Lower my daily limit');
  const dec = await call('PATCH', `/api/playbook/requests/${rq.id}`, { status: 'approved', admin_note: 'ok' });
  assert.equal(dec.status, 200);
  const docs = await call('GET', '/api/playbook/docs');
  assert.match(docs.agent, /Authorization: Bearer/);
  assert.match(docs.team, /Plan/);
});

test('agent flow with an API key: read plan, log with text, request a change', async () => {
  const k = await call('POST', '/api/me/tokens', { name: 'agent' });
  const tok = k.token;
  const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const lead = await api('POST', '/api/leads', { first_name: 'Agent', last_name: 'Lead', company: 'Bot Co', email: 'a@bot.co' });
  assert.equal(lead.status, 201);
  const dup = await api('POST', '/api/leads', { email: 'A@bot.co', title: 'CEO' });
  assert.equal(dup.id, lead.id);
  const st = await api('POST', `/api/leads/${lead.id}/step`, { result: 'comment', note: 'Nice post on cohorts' });
  assert.equal(st.status, 200);
  const plan = await api('GET', '/api/plan?assignee=me');
  assert.equal(plan.status, 200);
  const rep = await api('GET', '/api/reports/eod?assignee=me');
  assert.match(rep.markdown, /Nice post on cohorts/);
  const rq = await api('POST', '/api/playbook/requests', { title: 'Agent suggestion', details: 'x' });
  assert.equal(rq.status, 201);
});
