import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'test-secret';
const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { seedAdmin } = await import('../server/auth.js');
const { rangeBounds } = await import('../server/lib/range.js');

let server;
let base;
let cookie = '';

async function call(method, url, body, ck = cookie) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', cookie: ck },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

let db;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db);
  server = createApp(db).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// Same shape as the "Master Leads" tab: 2 title rows, then the header.
const MASTER = `skillBNK MASTER LEADS — CLEAN CRM V2
Current state of every lead
First Name,Last Name,Title,Company,Email,Email Status,LinkedIn,Company LinkedIn,Website,# Employees,Industry,State,Country,Source / List,Owner,Research Status,Qualification,Pipeline Stage
Sam,Parr,Co-Founder,Hampton,sam@joinhampton.com,Verified,http://www.linkedin.com/in/parrsam,http://www.linkedin.com/company/myhampton,https://joinhampton.com,16,think tanks,New York,United States,USA Batch 001,Ahana Anjum,Not Reviewed,Batch 01 Screened,New
Pete,Widry,"Founder, CEO",P6 Aviation,pete@p6aviation.com,Verified,http://www.linkedin.com/in/petewidry,,https://p6aviation.com,13,airlines/aviation,New York,United States,USA Batch 001,Tawhid,Not Reviewed,Batch 01 Screened,New
`;

// Same shape as "Apollo New Leads": no owner column.
const APOLLO = `First Name,Last Name,Title,Company,Email,Email Status,LinkedIn,Website,City,State,ICP Segment,Geo,Apollo Contact ID
Nichole,Bradford,Training and Development Manager,Class Valuation,nbradford@classvaluation.com,verified,linkedin.com/in/nichole-bradford-209a88a5,classvaluation.com,Troy,Michigan,L&D Employers,MI,6ac3a3ffa18872000c187222
Elizabeth,Bull-Davie,Training and Development Manager,"Niles Industrial Coatings, LLC",elizabethbulldavie@nilesindustrial.com,verified,linkedin.com/in/elizabeth-bull-davie-detroit,nilesindustrial.com,South Lyon,Michigan,L&D Employers,MI,6ac3a3ffa18872000c187225
Gracie,Corbin,Training & Development Manager,AMP Residential,gcorbin@ampresidential.com,verified,linkedin.com/in/gracie-corbin,ampresidential.com,Grand Rapids,Michigan,L&D Employers,MI,6ac3a3ffa18872000c187218
`;

test('requires login', async () => {
  const r = await call('GET', '/api/leads', null, '');
  assert.equal(r.status, 401);
});

test('login + bad password', async () => {
  const bad = await call('POST', '/api/login', { email: 'admin@skillbnk.local', password: 'nope' }, '');
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/login', { email: 'admin@skillbnk.local', password: 'admin123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.user.role, 'admin');
});

test('import preview detects header row below title rows', async () => {
  const p = await call('POST', '/api/import/preview', { text: MASTER });
  assert.equal(p.status, 200);
  assert.equal(p.totalRows, 2);
  assert.equal(p.newCount, 2);
  assert.ok(p.mapping.includes('owner'));
  assert.equal(p.mapping[p.headers.indexOf('# Employees')], 'employees');
});

test('import Master Leads: auto-creates owners, skips unknown stage text', async () => {
  const p = await call('POST', '/api/import/preview', { text: MASTER });
  const c = await call('POST', '/api/import/commit', { text: MASTER, mapping: p.mapping, source: 'x', assign: { mode: 'none' } });
  assert.equal(c.created, 2);
  assert.deepEqual(c.createdUsers.sort(), ['Ahana Anjum', 'Tawhid']);
  const list = await call('GET', '/api/leads?owner=none');
  assert.equal(list.total, 0);
  const all = await call('GET', '/api/leads');
  const pete = all.rows.find((l) => l.first_name === 'Pete');
  assert.equal(pete.title, 'Founder, CEO');
  assert.equal(pete.owner_name, 'Tawhid');
  assert.equal(pete.stage, 'New');
  assert.equal(pete.quality, '');
  assert.equal(pete.employees, '13');
});

test('re-importing the same file creates no duplicates', async () => {
  const p = await call('POST', '/api/import/preview', { text: MASTER });
  assert.equal(p.newCount, 0);
  assert.equal(p.duplicateCount, 2);
  const c = await call('POST', '/api/import/commit', { text: MASTER, mapping: p.mapping, assign: { mode: 'none' } });
  assert.equal(c.created, 0);
  assert.equal(c.duplicates, 2);
});

test('Apollo import split evenly across team', async () => {
  const team = await call('GET', '/api/team');
  const ids = team.users.filter((u) => ['Ahana Anjum', 'Tawhid'].includes(u.name)).map((u) => u.id);
  const p = await call('POST', '/api/import/preview', { text: APOLLO });
  const c = await call('POST', '/api/import/commit', { text: APOLLO, mapping: p.mapping, source: 'Apollo Oct 5', assign: { mode: 'split', user_ids: ids } });
  assert.equal(c.created, 3);
  const counts = Object.values(c.byOwner).sort();
  assert.deepEqual(counts, [1, 2]);
  const all = await call('GET', '/api/leads?source=' + encodeURIComponent('Apollo Oct 5'));
  assert.equal(all.total, 3);
});

test('assigning logs activity; reassigning logs again', async () => {
  const all = await call('GET', '/api/leads');
  const lead = all.rows[0];
  const team = await call('GET', '/api/team');
  const admin = team.users.find((u) => u.role === 'admin');
  const a = await call('PATCH', `/api/leads/${lead.id}`, { owner_id: admin.id });
  assert.equal(a.status, 200);
  const d = await call('GET', `/api/leads/${lead.id}`);
  const assign = d.activities.find((x) => x.type === 'assign');
  assert.ok(assign);
  assert.match(assign.note, /→ Admin$/);
  assert.equal(assign.user_name, 'Admin');
});

test('stage / quality changes are validated and logged; first touch auto-moves New→Contacted', async () => {
  const all = await call('GET', '/api/leads?q=bradford');
  const id = all.rows[0].id;
  const bad = await call('PATCH', `/api/leads/${id}`, { stage: 'Banana' });
  assert.equal(bad.status, 400);
  const bad2 = await call('PATCH', `/api/leads/${id}`, { quality: 'Meh' });
  assert.equal(bad2.status, 400);

  const log = await call('POST', `/api/leads/${id}/activities`, { type: 'call', note: 'Left voicemail' });
  assert.equal(log.status, 201);
  let d = await call('GET', `/api/leads/${id}`);
  assert.equal(d.lead.stage, 'Contacted');

  await call('PATCH', `/api/leads/${id}`, { quality: 'Strategic Partnership' });
  await call('POST', `/api/leads/${id}/meetings`, { scheduled_date: '2026-11-10' });
  d = await call('GET', `/api/leads/${id}`);
  const types = d.activities.map((x) => x.type);
  for (const t of ['call', 'stage_change', 'quality_change', 'meeting_booked']) assert.ok(types.includes(t), t);
});

test('bulk assign + stage', async () => {
  const ids = (await call('GET', '/api/leads/ids')).ids;
  assert.equal(ids.length, 5);
  const team = await call('GET', '/api/team');
  const t = team.users.find((u) => u.name === 'Tawhid');
  const r = await call('POST', '/api/leads/bulk', { ids, set: { owner_id: t.id, stage: 'Replied' } });
  assert.equal(r.status, 200);
  const list = await call('GET', `/api/leads?owner=${t.id}&stage=Replied`);
  assert.equal(list.total, 5);
});

test('activity log: today summary per user, filter by user and type', async () => {
  const a = await call('GET', '/api/activity?range=today');
  assert.ok(a.total > 0);
  const admin = a.summary.find((s) => s.user_name === 'Admin');
  assert.ok(admin.types.call >= 1);
  assert.ok(admin.leads >= 1);
  const calls = await call('GET', '/api/activity?range=today&type=call');
  assert.ok(calls.rows.every((r) => r.type === 'call'));
  const yest = await call('GET', '/api/activity?range=yesterday');
  assert.equal(yest.total, 0);
});

test('duplicate email edit is rejected', async () => {
  const all = await call('GET', '/api/leads');
  const [a, b] = all.rows;
  const r = await call('PATCH', `/api/leads/${a.id}`, { email: b.email });
  assert.equal(r.status, 409);
});

test('team: member cannot create users; admin can', async () => {
  const mk = await call('POST', '/api/team', { name: 'Safiul Alom', email: 'safiul@skillbnk.local', password: 'secret1', role: 'member' });
  assert.equal(mk.status, 201);
  const memberCookie = await (async () => {
    const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'safiul@skillbnk.local', password: 'secret1' }) });
    return res.headers.get('set-cookie').split(';')[0];
  })();
  const denied = await call('POST', '/api/team', { name: 'X', email: 'x@x.com', password: 'secret1' }, memberCookie);
  assert.equal(denied.status, 403);
});

test('date ranges in Asia/Dhaka', () => {
  // 2026-11-04 17:03 Dhaka = 11:03 UTC (a Wednesday)
  const now = Date.parse('2026-11-04T11:03:00Z');
  assert.deepEqual(rangeBounds('today', '', '', now), { start: '2026-11-03T18:00:00.000Z', end: '2026-11-04T18:00:00.000Z' });
  assert.equal(rangeBounds('yesterday', '', '', now).start, '2026-11-02T18:00:00.000Z');
  assert.equal(rangeBounds('week', '', '', now).start, '2026-11-01T18:00:00.000Z'); // Monday Nov 2, 00:00 Dhaka
  assert.equal(rangeBounds('month', '', '', now).start, '2026-10-31T18:00:00.000Z');
  assert.equal(rangeBounds('last_month', '', '', now).start, '2026-09-30T18:00:00.000Z');
});

test('analytics: tabs + daily breakdown by team member, linkedin action types', async () => {
  const all = await call('GET', '/api/leads?q=bradford');
  const id = all.rows[0].id;
  for (const type of ['linkedin_view', 'linkedin_connect', 'linkedin_dm']) {
    const r = await call('POST', `/api/leads/${id}/activities`, { type });
    assert.equal(r.status, 201, type);
  }
  const list = await call('GET', '/api/leads?q=bradford');
  assert.ok(list.rows[0].activity_count >= 4);
  assert.equal(list.rows[0].last_type, 'linkedin_dm');

  const tabs = await call('GET', '/api/activity/tabs');
  assert.ok(tabs.today >= 4);
  assert.equal(tabs.yesterday, 0);
  assert.ok(tabs.all >= tabs.today);

  const daily = await call('GET', '/api/activity/daily?range=month');
  assert.ok(daily.days.length >= 1);
  const day = daily.days[0];
  assert.match(day.day, /^\d{4}-\d{2}-\d{2}$/);
  const admin = Object.values(day.byUser).find((u) => u.user_name === 'Admin');
  assert.ok(admin.touches >= 4);
  assert.ok(admin.types.linkedin_dm >= 1);

  const team = await call('GET', '/api/team');
  const other = team.users.find((u) => u.name === 'Tawhid');
  const filtered = await call('GET', `/api/activity/daily?range=month&user=${other.id}`);
  assert.ok(filtered.days.every((d) => Object.keys(d.byUser).every((k) => Number(k) === other.id)));

  const fac = await call('GET', '/api/leads/facets');
  assert.equal(typeof fac.untouched, 'number');
  const untouched = await call('GET', '/api/leads?untouched=1');
  assert.equal(untouched.total, fac.untouched);
});

test('recycle bin: delete → bin → restore, purge only from the bin, admin only', async () => {
  const adminCookie = cookie;
  const memberCookie = await (async () => {
    const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'safiul@skillbnk.local', password: 'secret1' }) });
    return res.headers.get('set-cookie').split(';')[0];
  })();
  const all = await call('GET', '/api/leads?limit=200');
  const before = all.total;
  const [a, b, c] = all.rows;

  // members can't delete, see the bin, restore or purge
  assert.equal((await call('DELETE', `/api/leads/${a.id}`, null, memberCookie)).status, 403);
  assert.equal((await call('POST', '/api/leads/bulk-delete', { ids: [a.id] }, memberCookie)).status, 403);
  assert.equal((await call('GET', '/api/leads/trash', null, memberCookie)).status, 403);
  assert.equal((await call('POST', '/api/leads/restore', { ids: [a.id] }, memberCookie)).status, 403);
  assert.equal((await call('POST', '/api/leads/purge', { ids: [a.id] }, memberCookie)).status, 403);

  // delete = move to bin: gone from lists/counts, history kept
  assert.equal((await call('DELETE', `/api/leads/${a.id}`, null, adminCookie)).status, 200);
  assert.equal((await call('DELETE', `/api/leads/${a.id}`, null, adminCookie)).status, 404, 'already in bin');
  assert.equal((await call('POST', '/api/leads/bulk-delete', { ids: [b.id, c.id] }, adminCookie)).deleted, 2);
  assert.equal((await call('GET', '/api/leads')).total, before - 3);
  const fac = await call('GET', '/api/leads/facets');
  assert.equal(fac.total, before - 3);
  assert.equal(fac.trash, 3);
  const bin = await call('GET', '/api/leads/trash');
  assert.equal(bin.total, 3);
  assert.equal(bin.rows[0].deleted_by_name, 'Admin');
  assert.ok(bin.rows[0].deleted_at);

  // a trashed lead is read-only and can't be edited or logged against
  assert.equal((await call('PATCH', `/api/leads/${a.id}`, { stage: 'Replied' })).status, 400);
  assert.equal((await call('POST', `/api/leads/${a.id}/activities`, { type: 'call' })).status, 400);
  assert.equal((await call('GET', `/api/leads/${a.id}`)).lead.deleted_at.length > 0, true);

  // re-importing a trashed lead is skipped and reported as "in bin"
  const row = (await call('GET', `/api/leads/${a.id}`)).lead;
  const csv = `First Name,Last Name,Email,Company\n${row.first_name},${row.last_name},${row.email},${row.company}\n`;
  if (row.email) {
    const pv = await call('POST', '/api/import/preview', { text: csv });
    assert.equal(pv.trashedCount, 1);
    assert.equal(pv.newCount, 0);
  }

  // restore one → back in the list with a history entry
  assert.equal((await call('POST', '/api/leads/restore', { ids: [a.id] })).restored, 1);
  assert.equal((await call('GET', '/api/leads')).total, before - 2);
  const hist = await call('GET', `/api/leads/${a.id}`);
  assert.deepEqual(hist.activities.filter((x) => ['trashed', 'restored'].includes(x.type)).map((x) => x.type).sort(), ['restored', 'trashed']);

  // purge refuses leads that aren't in the bin, and removes binned ones for good
  assert.equal((await call('POST', '/api/leads/purge', { ids: [a.id] })).purged, 0);
  assert.equal((await call('POST', '/api/leads/purge', { ids: [b.id] })).purged, 1);
  assert.equal((await call('GET', `/api/leads/${b.id}`)).status, 404);
  assert.equal((await call('GET', '/api/leads/trash')).total, 1);

  // empty the bin
  assert.equal((await call('POST', '/api/leads/purge', { all: true })).purged, 1);
  assert.equal((await call('GET', '/api/leads/trash')).total, 0);
  assert.equal((await call('GET', '/api/leads')).total, before - 2);
});

test('migration: an old database without deleted_at is upgraded in place', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(os.tmpdir(), `crm-old-${Date.now()}.db`);
  // Build a database exactly as the previous version made it: current schema minus the recycle-bin columns.
  const first = openDb(file);
  first.exec('DROP INDEX idx_leads_deleted; ALTER TABLE leads DROP COLUMN deleted_at; ALTER TABLE leads DROP COLUMN deleted_by;');
  first.exec("INSERT INTO leads(first_name, dedupe_key, created_at, updated_at) VALUES ('Old', 'e:old@x.com', 'x', 'x')");
  assert.ok(!first.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'deleted_at'));
  first.close();

  const upgraded = openDb(file); // runs the migration
  const lead = upgraded.prepare('SELECT first_name, deleted_at, deleted_by FROM leads').get();
  assert.equal(lead.first_name, 'Old');
  assert.equal(lead.deleted_at, '');
  assert.equal(lead.deleted_by, null);
  upgraded.close();
  openDb(file).close(); // and is safe to run again
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true });
});

test('team: admin removes a member -> leads unassigned, history kept, login blocked', async () => {
  const mk = await call('POST', '/api/team', { name: 'Temp Person', email: 'temp@skillbnk.local', password: 'secret1', role: 'member' });
  const all = await call('GET', '/api/leads?limit=2');
  const ids = all.rows.map((l) => l.id);
  await call('POST', '/api/leads/bulk', { ids, set: { owner_id: mk.id } });
  await call('POST', `/api/leads/${ids[0]}/activities`, { type: 'call' });
  const del = await call('DELETE', `/api/team/${mk.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.unassigned, 2);
  const after = await call('GET', '/api/leads?limit=200');
  for (const id of ids) assert.equal(after.rows.find((l) => l.id === id).owner_id, null);
  const team = await call('GET', '/api/team');
  assert.ok(!team.users.some((u) => u.id === mk.id));
  const lead = await call('GET', `/api/leads/${ids[0]}`);
  assert.ok(lead.activities.some((a) => a.type === 'assign' && a.note === 'Temp Person (removed) → Unassigned'));
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'temp@skillbnk.local', password: 'secret1' }) });
  assert.equal(login.status, 401);
  // name is free again; can't remove yourself
  const again = await call('POST', '/api/team', { name: 'Temp Person', email: 'temp@skillbnk.local', password: 'secret1' });
  assert.equal(again.status, 201);
  const me = await call('GET', '/api/me');
  assert.equal((await call('DELETE', `/api/team/${me.user.id}`)).status, 400);
});

test('sorting: by name, company, owner, stage; blanks last; per-page', async () => {
  const names = (await call('GET', '/api/leads?sort=name&dir=asc&limit=200')).rows.map((l) => `${l.first_name} ${l.last_name}`.toLowerCase());
  assert.deepEqual(names, [...names].sort());
  const co = (await call('GET', '/api/leads?sort=company&dir=asc&limit=200')).rows.map((l) => l.company.toLowerCase());
  const filled = co.filter(Boolean);
  assert.deepEqual(co.slice(0, filled.length), [...filled].sort());
  const st = await call('GET', '/api/leads?sort=stage&dir=desc&limit=200');
  assert.equal(st.status, 200);
  assert.equal((await call('GET', '/api/leads?sort=owner&dir=asc&limit=2')).rows.length, 2);
  assert.equal((await call('GET', '/api/leads?sort=bogus&limit=3')).rows.length, 3);
});

test('profile visit: logged once per user, lead and day; person and company are separate', async () => {
  const fresh = await call('POST', '/api/leads', { first_name: 'Vera', last_name: 'Visit', company: 'Visit Co', email: 'vera@visit.co' });
  const lead = { id: fresh.id };
  const a = await call('POST', `/api/leads/${lead.id}/visit`, { kind: 'person' });
  const b = await call('POST', `/api/leads/${lead.id}/visit`, { kind: 'person' });
  const c = await call('POST', `/api/leads/${lead.id}/visit`, { kind: 'company' });
  const d = await call('POST', `/api/leads/${lead.id}/visit`, { kind: 'company' });
  assert.deepEqual([a.logged, b.logged, c.logged, d.logged], [true, false, true, false]);
  const acts = (await call('GET', `/api/leads/${lead.id}`)).activities;
  assert.equal(acts.filter((x) => x.type === 'linkedin_view' && x.note === 'Opened from CRM').length, 1);
  assert.equal(acts.filter((x) => x.type === 'linkedin_company_view').length, 1);
  // a different user on the same lead logs their own visit
  const mk = await call('POST', '/api/team', { name: 'Visitor', email: 'visitor@skillbnk.local', password: 'secret1' });
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'visitor@skillbnk.local', password: 'secret1' }) });
  const ck = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', `/api/leads/${lead.id}/visit`, { kind: 'person' }, ck)).logged, true);
  // yesterday's visit does not block today's
  db.prepare("UPDATE activities SET created_at = '2020-01-01T00:00:00.000Z' WHERE lead_id = ? AND type = 'linkedin_company_view'").run(lead.id);
  assert.equal((await call('POST', `/api/leads/${lead.id}/visit`, { kind: 'company' })).logged, true);
  await call('DELETE', `/api/team/${mk.id}`);
});

test('meetings: lifecycle, stage sync, statuses, validation', async () => {
  const lead = (await call('GET', '/api/leads?limit=1&sort=created_at&dir=asc')).rows[0];
  assert.equal((await call('POST', `/api/leads/${lead.id}/meetings`, { scheduled_date: 'nope' })).status, 400);
  const mk = await call('POST', `/api/leads/${lead.id}/meetings`, { scheduled_date: '2999-01-05', scheduled_time: '15:30', notes: 'Intro call' });
  assert.equal(mk.status, 201);
  let d = await call('GET', `/api/leads/${lead.id}`);
  assert.equal(d.lead.stage, 'Meeting Booked');
  assert.equal(d.lead.meeting_status, 'booked');
  assert.equal(d.lead.meeting_date, '2999-01-05');
  assert.equal(d.meetings.length, 1);
  assert.equal((await call('PATCH', `/api/meetings/${mk.id}`, { status: 'nope' })).status, 400);
  await call('PATCH', `/api/meetings/${mk.id}`, { scheduled_date: '2999-01-06' });
  await call('PATCH', `/api/meetings/${mk.id}`, { status: 'cancelled' });
  d = await call('GET', `/api/leads/${lead.id}`);
  assert.equal(d.lead.meeting_status, 'cancelled');
  assert.equal(d.lead.stage, 'Replied'); // all meetings cancelled -> back from Meeting Booked
  await call('PATCH', `/api/meetings/${mk.id}`, { status: 'booked' });
  await call('PATCH', `/api/meetings/${mk.id}`, { status: 'completed', notes: 'Went well' });
  d = await call('GET', `/api/leads/${lead.id}`);
  assert.equal(d.lead.stage, 'Meeting Done');
  const types = d.activities.map((a) => a.type);
  for (const t of ['meeting_booked', 'meeting_rescheduled', 'meeting_cancelled', 'meeting_completed']) assert.ok(types.includes(t), t);
  const list = await call('GET', '/api/meetings?status=completed');
  assert.ok(list.rows.some((m) => m.id === mk.id && m.company !== undefined));
  const sum = await call('GET', '/api/meetings/summary');
  assert.equal(sum.completed >= 1, true);
});

test('lead links: drive + chatgpt detection, validation, list columns', async () => {
  const lead = (await call('GET', '/api/leads?limit=1')).rows[0];
  const bad = await call('POST', `/api/leads/${lead.id}/links`, { url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  const dr = await call('POST', `/api/leads/${lead.id}/links`, { url: 'drive.google.com/drive/folders/abc' });
  assert.equal(dr.kind, 'drive');
  assert.equal(dr.url, 'https://drive.google.com/drive/folders/abc');
  const gp = await call('POST', `/api/leads/${lead.id}/links`, { url: 'https://chatgpt.com/c/123', label: 'Research' });
  assert.equal(gp.kind, 'chatgpt');
  assert.equal((await call('POST', `/api/leads/${lead.id}/links`, { url: 'https://chatgpt.com/c/123' })).status, 409);
  const row = (await call('GET', `/api/leads?q=${encodeURIComponent(lead.email || lead.first_name)}`)).rows.find((l) => l.id === lead.id);
  assert.ok(row.drive_url && row.chatgpt_url);
  assert.equal(row.link_count, 2);
  assert.equal((await call('DELETE', `/api/leads/${lead.id}/links/${dr.id}`)).status, 200);
  assert.equal((await call('GET', `/api/leads/${lead.id}`)).links.length, 1);
});

test('weekly KPI: default 8, carry-forward of shortfall, cancelled not counted, admin target', async () => {
  const { weekStart, addDays, todayLocal } = await import('../server/lib/kpi.js');
  const mk = await call('POST', '/api/team', { name: 'Kpi Person', email: 'kpi@skillbnk.local', password: 'secret1' });
  const thisWeek = weekStart(todayLocal());
  // account created 2 weeks ago, KPI counts from then
  const twoAgo = addDays(thisWeek, -14);
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(twoAgo + 'T06:00:00.000Z', mk.id);
  await call('PUT', '/api/kpi/start', { week: twoAgo });
  const leads = [];
  for (let i = 0; i < 14; i++) leads.push({ id: (await call('POST', '/api/leads', { first_name: 'K' + i, last_name: 'Lead', email: `k${i}@kpi.co` })).id });
  const put = (lead, iso, status = 'booked') => {
    db.prepare("INSERT INTO meetings(lead_id, booked_by, created_by, scheduled_date, status, created_at, updated_at, status_changed_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(lead.id, mk.id, mk.id, '2026-01-01', status, iso, iso, iso);
  };
  // week -2: 5 booked (+1 cancelled, ignored) ; week -1: 6 booked ; this week: 2 booked
  for (let i = 0; i < 5; i++) put(leads[i], addDays(twoAgo, 1) + 'T08:00:00.000Z');
  put(leads[5], addDays(twoAgo, 1) + 'T08:00:00.000Z', 'cancelled');
  for (let i = 6; i < 12; i++) put(leads[i], addDays(thisWeek, -6) + 'T08:00:00.000Z');
  for (let i = 12; i < 14; i++) put(leads[i], thisWeek + 'T08:00:00.000Z');
  let k = (await call('GET', '/api/kpi')).members.find((m) => m.id === mk.id);
  const byWeek = Object.fromEntries(k.history.map((h) => [h.week, h]));
  assert.equal(byWeek[twoAgo].target, 8);
  assert.equal(byWeek[twoAgo].booked, 5);
  assert.equal(byWeek[addDays(thisWeek, -7)].carry_in, 3);   // missed 3
  assert.equal(byWeek[addDays(thisWeek, -7)].target, 11);
  assert.equal(byWeek[addDays(thisWeek, -7)].booked, 6);
  assert.equal(k.carry_in, 5);                               // 11 - 6 carried
  assert.equal(k.target, 13);
  assert.equal(k.booked, 2);
  assert.equal(k.remaining, 11);
  // admin changes the target for this person from this week
  assert.equal((await call('PUT', '/api/kpi/targets', { user_ids: [mk.id], target: 10 })).status, 200);
  k = (await call('GET', '/api/kpi')).members.find((m) => m.id === mk.id);
  assert.equal(k.base, 10);
  assert.equal(k.target, 15);
  assert.equal((await call('PUT', '/api/kpi/targets', { user_ids: 'all', target: -1 })).status, 400);
  // members cannot edit
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'kpi@skillbnk.local', password: 'secret1' }) });
  const ck = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('PUT', '/api/kpi/targets', { user_ids: 'all', target: 1 }, ck)).status, 403);
  assert.equal((await call('GET', '/api/kpi', null, ck)).canEdit, false);
});

test('migration: old meeting_date on a lead becomes a meeting row', async () => {
  const fs = await import('node:fs');
  const file = `/tmp/skillbnk-mig-${process.pid}.db`;
  fs.rmSync(file, { force: true });
  const m = openDb(file);
  m.prepare("INSERT INTO users(name,email,password_hash,role,created_at) VALUES ('A','a@a.a','x','admin','2026-01-01T00:00:00Z')").run();
  m.prepare("INSERT INTO leads(first_name,dedupe_key,meeting_date,created_at,updated_at) VALUES ('Old','k1','2026-12-01','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')").run();
  m.exec('ALTER TABLE leads DROP COLUMN meeting_status');
  m.exec('DROP TABLE meetings');
  m.close();
  const again = openDb(file);
  const rows = again.prepare('SELECT * FROM meetings').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'booked');
  assert.equal(rows[0].scheduled_date, '2026-12-01');
  assert.equal(again.prepare('SELECT meeting_status FROM leads').get().meeting_status, 'booked');
  again.close();
  openDb(file).close(); // second open must not duplicate
  const third = openDb(file);
  assert.equal(third.prepare('SELECT COUNT(*) AS n FROM meetings').get().n, 1);
  third.close();
  fs.rmSync(file, { force: true });
});

test('unknown owner names are not turned into accounts', async () => {
  const csv = 'First Name,Last Name,Email,Owner\nZed,Nobody,zed@nobody.com,TO CONFIRM\n';
  const p = await call('POST', '/api/import/preview', { text: csv });
  const c = await call('POST', '/api/import/commit', { text: csv, mapping: p.mapping, assign: { mode: 'none' } });
  assert.equal(c.created, 1);
  assert.deepEqual(c.createdUsers, []);
  assert.equal(c.unknownOwners['TO CONFIRM'], 1);
  const team = await call('GET', '/api/team');
  assert.ok(!team.users.some((u) => u.name === 'TO CONFIRM'));
  const zed = (await call('GET', '/api/leads?q=nobody')).rows[0];
  assert.equal(zed.owner_id, null);
});

test('outreach funnel: dropdown validation, auto dates, funnel counts', async () => {
  const { id } = await call('POST', '/api/leads', { first_name: 'Fay', last_name: 'Funnel', email: 'fay@funnel.co' });
  const bad = await call('PATCH', `/api/leads/${id}`, { opportunity_path: 'Made Up' });
  assert.equal(bad.status, 400);
  const bad2 = await call('PATCH', `/api/leads/${id}`, { outreach_status: 'XX' });
  assert.equal(bad2.status, 400);
  const ok = await call('PATCH', `/api/leads/${id}`, { lead_category: 'Customer', tier: 'A', quality: 'Strategic Partnership', todays_question: 'How do you track learners?' });
  assert.equal(ok.status, 200);
  assert.equal(ok.lead.quality, 'Strategic Partnership');

  await call('POST', `/api/leads/${id}/activities`, { type: 'linkedin_connect' });
  let l = (await call('GET', `/api/leads/${id}`)).lead;
  assert.match(l.invite_sent_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(l.outreach_status, 'U');
  assert.equal(l.channel, 'LinkedIn');
  assert.equal(l.accepted_date, '');
  await call('POST', `/api/leads/${id}/activities`, { type: 'linkedin_connected' });
  await call('POST', `/api/leads/${id}/activities`, { type: 'linkedin_dm' });
  l = (await call('GET', `/api/leads/${id}`)).lead;
  assert.ok(l.accepted_date && l.first_dm_date);
  const invited = l.invite_sent_date;
  await call('POST', `/api/leads/${id}/activities`, { type: 'linkedin_connect' }); // 2nd time must not overwrite
  assert.equal((await call('GET', `/api/leads/${id}`)).lead.invite_sent_date, invited);

  await call('PATCH', `/api/leads/${id}`, { outreach_status: 'R' });
  const f = await call('GET', '/api/leads/funnel');
  assert.ok(f.counts.invited >= 1 && f.counts.accepted >= 1 && f.counts.firstDm >= 1 && f.counts.replied >= 1);
  assert.equal(f.rates.acceptance, Math.round((f.counts.accepted / f.counts.invited) * 1000) / 10);
  const filtered = await call('GET', '/api/leads?outreach_status=R&tier=A');
  assert.ok(filtered.rows.some((r) => r.id === id));
});

test('importing a Master Leads row brings stage, meetings, activity log and funnel dates', async () => {
  const notes = '--- Activity Log ---\n[Oct 10, 2026, 4:10 PM - Tawhid] Connection Request via Personal LinkedIn\n[Oct 7, 2026, 10:38 AM - Safiul Alom] Profile View via Personal LinkedIn\n[Earlier - Safiul Alom] Cold via Personal LinkedIn';
  const q = (s) => '"' + s.replace(/"/g, '""') + '"';
  const header = 'First Name,Last Name,Email,Pipeline Stage,Meeting Date,Qualification,Notes,ICP Segment';
  const r1 = ['Gia', 'Sheet', 'gia@sheet.co', 'Discovery Call Held', '2026-09-11 16:00', 'SKIP', q(notes), 'null'].join(',');
  const r2 = ['Hal', 'Sheet', 'hal@sheet.co', 'Meeting Scheduled', q('2026-10-30 2:30 PM EDT (CANCELLED - declined, not held)'), 'NURTURE', '', ''].join(',');
  const csv = [header, r1, r2].join('\n');
  const p = await call('POST', '/api/import/preview', { text: csv });
  const c = await call('POST', '/api/import/commit', { text: csv, mapping: p.mapping, assign: { mode: 'none' } });
  assert.equal(c.created, 2);
  assert.equal(c.activities, 2);
  const gia = (await call('GET', '/api/leads?q=sheet+gia')).rows[0];
  assert.equal(gia.stage, 'Meeting Done');
  assert.equal(gia.quality, 'Not a Fit');
  assert.equal(gia.icp_segment, '');
  assert.equal(gia.invite_sent_date, '2026-10-10');
  assert.equal(gia.outreach_status, 'M'); // meeting stage wins over invite 'U'
  assert.ok(gia.last_activity_at.startsWith('2026-10-10'));
  const gd = await call('GET', `/api/leads/${gia.id}`);
  assert.equal(gd.meetings.length, 1);
  assert.equal(gd.meetings[0].status, 'completed');
  assert.equal(gd.meetings[0].scheduled_time, '16:00');
  assert.equal(gd.activities.filter((a) => a.type === 'linkedin_connect').length, 1);
  const hal = (await call('GET', '/api/leads?q=sheet+hal')).rows[0];
  const hd = await call('GET', `/api/leads/${hal.id}`);
  assert.equal(hd.meetings[0].status, 'cancelled');
  assert.equal(hal.outreach_status, 'M');
});

test('queue, auto follow-up date, api tokens, login rate limit', async () => {
  const { id } = await call('POST', '/api/leads', { first_name: 'Quinn', last_name: 'Queue', email: 'quinn@queue.co' });
  await call('POST', `/api/leads/${id}/activities`, { type: 'linkedin_connect' });
  const l = (await call('GET', `/api/leads/${id}`)).lead;
  assert.ok(l.next_action_date > l.invite_sent_date, 'next step pre-filled');
  // make it overdue: invite 9 days ago
  const { addDays, todayLocal } = await import('../server/lib/kpi.js');
  await call('PATCH', `/api/leads/${id}`, { invite_sent_date: addDays(todayLocal(), -9), next_action_date: addDays(todayLocal(), -2) });
  const q = await call('GET', '/api/leads/queue?owner=all');
  const item = q.items.find((x) => x.id === id);
  assert.ok(item && item.overdue_days >= 0);
  // a lead that replied stays on the list as "answer them" until a later follow-up date is set
  await call('PATCH', `/api/leads/${id}`, { outreach_status: 'R', next_action_date: '' });
  const rq = (await call('GET', '/api/leads/queue?owner=all')).items.find((x) => x.id === id);
  assert.match(rq.action, /replied/i);
  await call('PATCH', `/api/leads/${id}`, { next_action_date: addDays(todayLocal(), 3) });
  assert.ok(!(await call('GET', '/api/leads/queue?owner=all')).items.some((x) => x.id === id));

  const tok = await call('POST', '/api/me/tokens', { name: 'test' });
  assert.match(tok.token, /^sbk_/);
  const viaToken = await fetch(base + '/api/leads/funnel', { headers: { authorization: 'Bearer ' + tok.token } });
  assert.equal(viaToken.status, 200);
  const bad = await fetch(base + '/api/leads/funnel', { headers: { authorization: 'Bearer sbk_wrong' } });
  assert.equal(bad.status, 401);
  const noCookieMint = await fetch(base + '/api/me/tokens', { method: 'POST', headers: { authorization: 'Bearer ' + tok.token, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCookieMint.status, 403);

  let last;
  for (let i = 0; i < 10; i++) last = await call('POST', '/api/login', { email: 'nobody@x.co', password: 'nope' }, '');
  assert.equal(last.status, 429);
});

test('import with update fills blanks of an existing lead without overwriting', async () => {
  await call('POST', '/api/leads', { first_name: 'Una', last_name: 'Update', email: 'una@update.co', title: 'Typed Title' });
  const csv = 'First Name,Last Name,Email,Title,Industry,Pipeline Stage,Meeting Date\nUna,Update,una@update.co,Other Title,Training,Discovery Call Held,2026-09-11 16:00\n';
  const p = await call('POST', '/api/import/preview', { text: csv });
  const c = await call('POST', '/api/import/commit', { text: csv, mapping: p.mapping, update: true, assign: { mode: 'none' } });
  assert.equal(c.updated, 1);
  const una = (await call('GET', '/api/leads?q=una+update')).rows[0];
  assert.equal(una.title, 'Typed Title');
  assert.equal(una.industry, 'Training');
  assert.equal(una.stage, 'Meeting Done');
  assert.equal((await call('GET', `/api/leads/${una.id}`)).meetings.length, 1);
});
