// Actions: the things a person does by hand on LinkedIn, done for you when YOU press the button on a lead.
// Nothing here runs by itself. Every action needs one click on that lead, uses the same rules as the team (rulebook v8),
// is verified on the page afterwards, and is logged in the CRM ONLY when the page proves it happened.
//   Fit check ......... read-only: role, company size and location from LinkedIn (uses prescreen.js)
//   Connect with note . builds the note from a fact + a curious question, checks it against the rules, shows it, asks you to confirm, sends, verifies on "Sent invitations"
//   Like latest post .. likes the lead's own post from the last month, only if it is not liked yet
//   Follow ............ follows the lead from the profile top card
// Needs the globals of sidepanel.js, sweep.js, deep.js, prescreen.js (el, $, crm, log, openBg, runIn, slugOf, humanPause, allSites, pageReadProfile, prescreen, refreshTargets).

// ───────── pure helpers (no browser needed, unit tested in test/actions.test.js) ─────────
const ACT_CAP = { linkedin_connect: 25, linkedin_like: 60, linkedin_follow: 40 }; // per day, a safety net, not a target
const NOTE_MAX = 300;
const BANNED_PHRASES = /i hope this|i wanted to reach out|i came across|stood out to me|leverage|streamline|circle back/i;
const OFFER_WORDS = /\b(demo|trial|pilot|free|pricing|price|discount|schedule|meeting|book a|calendar|offer)\b/i;

// Michigan counts as verified only when the LinkedIn profile itself shows it (the CRM state tag is not reliable).
function michiganOnProfile(top) {
  const head = String(top || '').split('\n').slice(0, 16).join(' ');
  return /\bMichigan\b/i.test(head) || /,\s*MI\b/.test(head) || /Detroit Metropolitan/i.test(head);
}

function buildNote({ first, fact, question, michigan }) {
  const f = String(fact || '').trim().replace(/[.!\s]+$/, '');
  const q = String(question || '').trim();
  const who = michigan ? 'a fellow Michigander and founder' : 'a founder';
  return `Hi ${first}, I'm Shiblu, ${who} based in Warren. I saw ${f}. ${q} Glad to connect.`.replace(/\s+/g, ' ');
}

// Returns { errors: [...], warnings: [...] }. Errors block sending (H14, H15, H16 and the curious-question rule).
function lintNote(note, { first = '', michiganVerified = false } = {}) {
  const n = String(note || '').trim(); const errors = [], warnings = [];
  if (!n) errors.push('The note is empty');
  if (n.length > NOTE_MAX) errors.push(`Too long: ${n.length} characters (limit ${NOTE_MAX})`);
  if (/\p{Extended_Pictographic}/u.test(n)) errors.push('No emojis in the note');
  if (/[—–]/.test(n)) errors.push('No dashes like — in the note');
  if (/(^|\n)\s*(thanks|best|regards|cheers)?[, ]*shiblu\s*$/i.test(n)) errors.push('No signature at the end');
  const q = (n.match(/\?/g) || []).length;
  if (q === 0) errors.push('Add one curious question about their work');
  if (q > 1) errors.push('Only one question');
  if (/michigander/i.test(n) && !michiganVerified) errors.push('"fellow Michigander" only when the LinkedIn profile shows Michigan');
  if (OFFER_WORDS.test(n)) errors.push('No offer or meeting ask in a connection note');
  if (BANNED_PHRASES.test(n)) errors.push('Avoid phrases like "I came across" or "I wanted to reach out"');
  if (first && !new RegExp('^hi ' + first.replace(/[^a-z]/gi, '') + '\\b', 'i').test(n)) warnings.push(`Should start with "Hi ${first},"`);
  if (/skillbnk/i.test(n)) warnings.push('Mentions skillBNK: keep the first note about them, not us');
  return { errors, warnings };
}

// "1h •", "3d •", "2w •" and "1mo •" are recent enough. "2mo" or older is not.
function isRecentStamp(head) {
  const h = String(head || '').replace(/\s+/g, ' ').slice(0, 300);
  if (/\b([2-9]|\d\d)\s?mo\s?•/.test(h) || /\b\d+\s?yr\s?•/.test(h)) return false;
  return /\b\d+\s?(m|h|d|w)\s?•/.test(h) || /\b1\s?mo\s?•/.test(h);
}

// ───────── functions that run inside the LinkedIn page (must stay self-contained) ─────────
async function pageActLike(first, dry) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  const find = () => [...document.querySelectorAll('button')].filter((b) => /^Reaction button state/i.test(b.getAttribute('aria-label') || '') || /^React Like$/i.test(b.getAttribute('aria-label') || ''));
  for (let i = 0; i < 12 && !find().length; i++) await sleep(700);
  const unliked = (b) => { const a = b.getAttribute('aria-label') || ''; return /no reaction/i.test(a) || (/^React Like$/i.test(a) && b.getAttribute('aria-pressed') === 'false'); };
  const isLiked = (b) => { const a = b.getAttribute('aria-label') || ''; return (/^Reaction button state/i.test(a) && !/no reaction/i.test(a)) || b.getAttribute('aria-pressed') === 'true' || /^Unlike/i.test(a); };
  const recent = (h) => { h = h.replace(/\s+/g, ' ').slice(0, 300); if (/\b([2-9]|\d\d)\s?mo\s?•/.test(h) || /\b\d+\s?yr\s?•/.test(h)) return false; return /\b\d+\s?(m|h|d|w)\s?•/.test(h) || /\b1\s?mo\s?•/.test(h); };
  const seen = new Set(); const notes = [];
  for (const b of find()) {
    let a = b; for (let i = 0; i < 14 && a.parentElement; i++) { a = a.parentElement; if ((a.innerText || '').length > 350) break; }
    const t = (a.innerText || '').replace(/\s+/g, ' '); const key = t.slice(0, 120); if (seen.has(key)) continue; seen.add(key);
    const own = !!first && t.slice(0, 200).toLowerCase().includes(first.toLowerCase()); const rec = recent(t); const un = unliked(b);
    notes.push(`${own ? 'own' : 'other'} ${rec ? 'recent' : 'old'} ${un ? 'not liked' : 'liked'}`);
    if (!(own && rec && un)) continue;
    const snippet = t.slice(0, 200);
    if (dry) return { ok: true, dry: true, post: snippet };
    b.scrollIntoView({ block: 'center' }); await sleep(600); b.click(); await sleep(1600);
    return { ok: isLiked(b), post: snippet, count: (b.innerText || '').trim() };
  }
  return { ok: false, why: 'No post from the last month that is theirs and not liked yet', seen: notes.slice(0, 6) };
}

async function pageActFollow(first, dry) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  for (let i = 0; i < 12 && !document.querySelector('h1'); i++) await sleep(600);
  const followers = () => { const m = /([\d,]+)\s+followers/i.exec(document.querySelector('main')?.innerText || ''); return m ? Number(m[1].replace(/,/g, '')) : 0; };
  const top = document.querySelector('main section') || document.querySelector('main') || document.body;
  const btns = [...top.querySelectorAll('button,[role=button]')];
  const txt = (b) => (b.innerText || '').trim().replace(/^\+\s*/, ''); const aria = (b) => b.getAttribute('aria-label') || '';
  const name = (first || '').toLowerCase();
  const mine = (b) => !name || aria(b).toLowerCase().includes(name) || !aria(b);
  if (btns.some((b) => /^Following$/i.test(txt(b)) && mine(b))) return { ok: true, already: true, followers: followers() };
  const f = btns.find((b) => /^Follow$/i.test(txt(b)) && (!aria(b) || aria(b).toLowerCase().includes(name)));
  if (!f) return { ok: false, why: 'No Follow button on the profile top card. They may already be followed, or it is in the More menu.', followers: followers() };
  if (dry) return { ok: true, dry: true, followers: followers() };
  const before = followers(); f.scrollIntoView({ block: 'center' }); await sleep(500); f.click(); await sleep(1800);
  const nowBtn = [...top.querySelectorAll('button,[role=button]')].some((b) => /^Following$/i.test(txt(b)));
  const after = followers();
  return { ok: nowBtn || after > before, before, after, stillShowsFollow: !nowBtn };
}

async function pageActInvite(note, dry) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  const find = (re) => [...document.querySelectorAll('button,[role=button],a')].find((b) => re.test((b.innerText || '').trim() || b.getAttribute('aria-label') || ''));
  for (let i = 0; i < 14 && !(find(/^Add a note$/i) || document.querySelector('#custom-message')); i++) await sleep(600);
  const add = find(/^Add a note$/i); if (add) { add.click(); await sleep(800); }
  const ta = document.querySelector('#custom-message') || document.querySelector('textarea[name=message]') || document.querySelector('textarea');
  if (!ta) return { ok: false, why: 'The note box did not open (LinkedIn may have changed the page, or the invite is not possible)' };
  ta.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, note);
  ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); await sleep(700);
  if (ta.value !== note) return { ok: false, why: 'The note did not stay in the box' };
  const send = [...document.querySelectorAll('button')].find((b) => /^Send( invitation)?$/i.test((b.innerText || '').trim()) && !b.disabled);
  if (!send) return { ok: false, why: 'The Send button is not enabled (the note may be over the limit)' };
  if (dry) return { ok: true, dry: true };
  send.click(); await sleep(2500);
  return { ok: true, clicked: true };
}

async function pageActSentCheck(first, noteStart) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  for (let i = 0; i < 12; i++) { const t = document.querySelector('main')?.innerText || ''; if (t.length > 300) break; await sleep(700); }
  const t = (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ');
  const first200 = t.slice(0, 3000);
  const i = first200.toLowerCase().indexOf(String(noteStart).toLowerCase());
  return { found: i >= 0, mentionsFirst: first200.toLowerCase().includes(String(first).toLowerCase()) };
}

// ───────── panel side ─────────
async function actCount(type) { const day = new Date().toLocaleDateString('en-CA'); const s = (await chrome.storage.local.get('actCount')).actCount || {}; return s.day === day ? (s[type] || 0) : 0; }
async function actBump(type) { const day = new Date().toLocaleDateString('en-CA'); const s = (await chrome.storage.local.get('actCount')).actCount || {}; const cur = s.day === day ? s : { day }; cur[type] = (cur[type] || 0) + 1; await chrome.storage.local.set({ actCount: cur }); return cur[type]; }
async function actCapOk(type, say) { const n = await actCount(type); if (n >= ACT_CAP[type]) { say(`Daily safety limit reached (${n} of ${ACT_CAP[type]}). Stop for today to protect the account.`, 'err'); return false; } return true; }
const firstOf = (lead) => String(lead.first_name || '').trim();
const fullOf = (lead) => `${lead.first_name || ''} ${lead.last_name || ''}`.trim();

async function actProfile(lead) { // read-only look at the profile: degree, pending, location
  const slug = slugOf(lead.linkedin); if (!slug) throw new Error('This lead has no LinkedIn profile address in the CRM');
  const tabId = await openBg(`https://www.linkedin.com/in/${slug}/`);
  const p = await runIn(tabId, pageReadProfile);
  if (!p || p.signin) throw new Error('LinkedIn asks you to sign in. Sign in once in the work window, then press again.');
  return { ...p, michigan: michiganOnProfile(p.top), tabId, slug };
}

async function actLike(lead, say) {
  try {
    if (!(await allSites())) return; if (!(await actCapOk('linkedin_like', say))) return;
    const slug = slugOf(lead.linkedin); if (!slug) throw new Error('No LinkedIn address in the CRM for this lead');
    say('Opening their recent activity…');
    const tabId = await openBg(`https://www.linkedin.com/in/${slug}/recent-activity/all/`);
    const res = await runIn(tabId, pageActLike, [firstOf(lead), false]);
    if (!res || res.signin) throw new Error('LinkedIn asks you to sign in');
    if (!res.ok) { say(res.why ? `${res.why}. Nothing was liked and nothing was logged.` : 'LinkedIn did not confirm the like, so nothing was logged. Check the post by hand.', 'err'); return; }
    await crm('POST', `/api/leads/${lead.id}/activities`, { type: 'linkedin_like', note: `Liked their post (verified on the page): ${String(res.post || '').slice(0, 160)}. Done with the extension after a person pressed the button.` });
    await actBump('linkedin_like'); say('Liked and logged in the CRM.', 'ok'); log(`${fullOf(lead)}: liked a recent post`, 'ok'); refreshTargets();
  } catch (e) { say(e.message, 'err'); }
}

async function actFollow(lead, say) {
  try {
    if (!(await allSites())) return; if (!(await actCapOk('linkedin_follow', say))) return;
    const slug = slugOf(lead.linkedin); if (!slug) throw new Error('No LinkedIn address in the CRM for this lead');
    say('Opening the profile…');
    const tabId = await openBg(`https://www.linkedin.com/in/${slug}/`);
    const res = await runIn(tabId, pageActFollow, [firstOf(lead), false]);
    if (!res || res.signin) throw new Error('LinkedIn asks you to sign in');
    if (res.already) { say('Already following. Nothing to do.'); return; }
    if (!res.ok) { say((res.why || 'LinkedIn did not confirm the follow') + ' Nothing was logged.', 'err'); return; }
    await crm('POST', `/api/leads/${lead.id}/activities`, { type: 'linkedin_follow', note: `Followed on LinkedIn (verified: followers ${res.before} to ${res.after}, or the button changed to Following).` });
    await actBump('linkedin_follow'); say('Followed and logged in the CRM.', 'ok'); log(`${fullOf(lead)}: followed`, 'ok'); refreshTargets();
  } catch (e) { say(e.message, 'err'); }
}

async function actFit(lead, say) {
  try {
    if (!(await allSites())) return;
    say('Checking role, company size and location on LinkedIn (read-only)…');
    const p = await actProfile(lead); const r = await prescreen(lead);
    const bits = [p.degree ? `${p.degree} degree` : 'degree not shown', p.pending ? 'invite already pending' : '', p.michigan ? 'Michigan shown on the profile' : 'Michigan NOT shown on the profile', r.facts?.role ? 'role: ' + r.facts.role : '', r.facts?.company ? `company size on LinkedIn: ${r.facts.company.label}` : '', r.skip ? 'LIKELY SKIP: ' + r.reasons.join('; ') : 'passes the size and authority rules', r.facts?.diffs?.length ? 'CRM differs: ' + r.facts.diffs.join('; ') : ''].filter(Boolean);
    say(bits.join(' · '), r.skip ? 'err' : 'ok');
  } catch (e) { say(e.message, 'err'); }
}

function connectBox(lead, say) {
  const first = firstOf(lead); const st = { michigan: false, checked: false };
  const fact = el('input', { placeholder: 'One real fact about them or the company, e.g. "you run Vision Realty Centers in Livonia for 18 years"' });
  const question = el('input', { placeholder: 'One curious question about how they work, e.g. "How do you get a new agent ready for their first deal?"' });
  const note = el('textarea', { rows: 4 }); const count = el('div', { class: 'muted' }); const problems = el('div');
  const refresh = () => { const { errors, warnings } = lintNote(note.value, { first, michiganVerified: st.michigan }); count.textContent = `${note.value.length}/${NOTE_MAX} characters · Michigan ${st.checked ? (st.michigan ? 'verified on the profile' : 'NOT shown on the profile') : 'not checked yet'}`; problems.replaceChildren(...errors.map((x) => el('div', { class: 'err' }, '✗ ' + x)), ...warnings.map((x) => el('div', { class: 'muted' }, '! ' + x))); return errors; };
  const rebuild = () => { note.value = buildNote({ first, fact: fact.value || '…', question: question.value || '…', michigan: st.michigan }); refresh(); };
  fact.addEventListener('input', rebuild); question.addEventListener('input', rebuild); note.addEventListener('input', refresh);
  const checkBtn = el('button', { onclick: async () => { try { if (!(await allSites())) return; say('Reading the profile…'); const p = await actProfile(lead); st.checked = true; st.michigan = p.michigan; st.degree = p.degree; st.pending = p.pending; say(`${p.degree || 'degree not shown'}${p.pending ? ', invite already pending' : ''}, Michigan ${p.michigan ? 'shown' : 'not shown'} on the profile.`, p.pending || p.degree === '1st' ? 'err' : 'ok'); rebuild(); } catch (e) { say(e.message, 'err'); } } }, '1. Check profile');
  const sendBtn = el('button', { class: 'primary', onclick: async () => {
    try {
      if (!st.checked) { say('Press "1. Check profile" first. It confirms the location, and that no invite is pending.', 'err'); return; }
      if (st.pending || st.degree === '1st') { say('Already connected or pending. No invite needed.', 'err'); return; }
      const errs = refresh(); if (errs.length) { say('Fix the red items first.', 'err'); return; }
      if (!(await actCapOk('linkedin_connect', say))) return;
      if (!confirm(`Send this connection request to ${fullOf(lead)}?\n\n${note.value}`)) return;
      sendBtn.disabled = true; say('Opening the invite page…');
      const slug = slugOf(lead.linkedin);
      await humanPause(1500, 4000);
      const tabId = await openBg(`https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(slug)}`);
      const res = await runIn(tabId, pageActInvite, [note.value.trim(), false]);
      if (!res || res.signin) throw new Error('LinkedIn asks you to sign in');
      if (!res.ok) throw new Error(res.why || 'The invite did not go through. Nothing was logged.');
      say('Sent. Checking the Sent invitations page…');
      const sTab = await openBg('https://www.linkedin.com/mynetwork/invitation-manager/sent/');
      const chk = await runIn(sTab, pageActSentCheck, [first, note.value.trim().slice(0, 40)]);
      if (!chk?.found) throw new Error('I could not find the invite on the Sent invitations page, so it is NOT logged. Look at that page by hand, then use "Log what I did" if it is there.');
      await crm('POST', `/api/leads/${lead.id}/activities`, { type: 'linkedin_connect', note: `${note.value.trim()} | Sent with the extension (person pressed Send, confirmed on the Sent invitations page). Profile checked first: ${st.degree || 'degree not shown'}, Michigan ${st.michigan ? 'shown' : 'not shown'}.` });
      await actBump('linkedin_connect'); say('Invitation sent, confirmed on LinkedIn, and logged in the CRM.', 'ok'); log(`${fullOf(lead)}: connection request sent`, 'ok'); refreshTargets();
    } catch (e) { sendBtn.disabled = false; say(e.message, 'err'); }
  } }, '3. Send invitation');
  return el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Connection note: 300 characters or less, one curious question, no offer, no signature, no emoji.'), checkBtn, el('div', { class: 'muted' }, '2. Write'), fact, question, note, count, problems, el('div', { class: 'row' }, sendBtn));
}

function actionsRow(lead) {
  const out = el('div', { class: 'muted' }); const say = (m, cls = '') => { out.className = cls || 'muted'; out.textContent = m; };
  const box = el('div');
  return el('details', {}, el('summary', {}, 'Do it on LinkedIn (you press each one)'),
    el('div', { class: 'row' },
      el('button', { onclick: () => actFit(lead, say) }, 'Fit check'),
      el('button', { onclick: () => actLike(lead, say) }, 'Like latest post'),
      el('button', { onclick: () => actFollow(lead, say) }, 'Follow'),
      el('button', { onclick: () => { box.replaceChildren(connectBox(lead, say)); } }, 'Connect with note…')),
    box, out);
}

if (typeof module !== 'undefined') module.exports = { michiganOnProfile, buildNote, lintNote, isRecentStamp, NOTE_MAX };
