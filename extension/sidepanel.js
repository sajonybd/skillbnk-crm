// Side panel: CRM prompt -> ChatGPT (skillBNK project) -> parse the JSON block -> you review -> one save to the CRM.
// Nothing is sent to anyone. Drafts are saved as "ready" and shown with quick links (Gmail compose, profile, post, form).
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); return n; };

// ── Live panel: shows the plan, the step in progress and the page being opened, so you can see what the extension does ──
let stopRun = false, livePlanSteps = [], liveIdx = -1, workWin = null, chatWin = null; // ChatGPT gets its own window: a tab hidden behind another tab stops drawing and sending
 const workTabs = {}; // key -> tab id
const TAB_NAMES = { chatgpt: 'ChatGPT', linkedin: 'LinkedIn', mail: 'Email', site: 'Website' };
const tabKeyOf = (url) => /chatgpt\.com/i.test(url) ? 'chatgpt' : /linkedin\.com/i.test(url) ? 'linkedin' : /privateemail\.com|namecheap/i.test(url) ? 'mail' : 'site';
// Four steady tabs (ChatGPT, LinkedIn, Email, Website) in ONE separate Chrome window. The window is opened without taking focus, so you can keep working in your own window.
let tabLock = Promise.resolve(); // tab opens run one at a time so parallel reads never open two work windows
function siteTab(key, url) { const run = tabLock.then(() => siteTabNow(key, url)); tabLock = run.catch(() => {}); return run; }
async function siteTabNow(key, url) {
  const isChat = key === 'chatgpt';
  const wid = isChat ? chatWin : workWin;
  let win = wid ? await chrome.windows.get(wid).catch(() => null) : null;
  let tab = workTabs[key] ? await chrome.tabs.get(workTabs[key]).catch(() => null) : null;
  if (tab && win && tab.windowId !== win.id) tab = null;
  if (!win) {
    win = await chrome.windows.create({ url, focused: false, type: 'normal', width: 1100, height: 800 });
    if (isChat) chatWin = win.id; else { workWin = win.id; for (const k of Object.keys(workTabs)) if (k !== 'chatgpt') delete workTabs[k]; }
    tab = win.tabs[0];
  }
  else if (tab) tab = await chrome.tabs.update(tab.id, { url, active: true });
  else tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
  workTabs[key] = tab.id; liveTabs();
  return tab;
}
function liveTabs() {
  const box = document.getElementById('live-tabs'); if (!box) return;
  box.replaceChildren(el('span', { class: 'muted' }, 'Work window: '), ...Object.entries(workTabs).map(([k, id]) => el('button', { onclick: async () => { try { const t = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); } catch { log(TAB_NAMES[k] + ' tab was closed', 'err'); } } }, 'Show ' + TAB_NAMES[k])));
}
const liveHist = [];
function liveHistAdd(t) { if (!t || liveHist[0]?.t === t) return; const d = new Date(); liveHist.unshift({ t, at: d.toTimeString().slice(0, 8) }); liveHist.length = Math.min(liveHist.length, 60); const h = document.getElementById('live-hist'); if (h) h.replaceChildren(...liveHist.map((x) => el('div', {}, el('span', { class: 'muted' }, x.at + '  '), x.t))); }
function liveRender() {
  const box = $('live-steps'); if (!box) return;
  box.replaceChildren(...livePlanSteps.map((t, i) => el('div', { style: i < liveIdx ? 'color:#15803d' : i === liveIdx ? 'font-weight:600;color:#1d4ed8' : 'color:#6b7280' }, (i < liveIdx ? '✓ ' : i === liveIdx ? '▶ ' : '○ ') + t)));
}
function livePlan(title, steps) {
  stopRun = false; livePlanSteps = steps; liveIdx = 0; liveHist.length = 0; liveHistAdd('Started: ' + title);
  $('live').style.display = ''; $('live-title').textContent = title; $('live-stop').style.display = ''; $('live-now').textContent = ''; liveRender();
}
function liveAt(i, note) { if (!livePlanSteps.length) return; liveIdx = i; liveRender(); if (note) liveNote(note); }
function liveNote(t) { const n = $('live-now'); if (n) n.textContent = t; liveHistAdd(t); }
function liveEnd(text) { document.getElementById('live-read').style.display = 'none'; liveIdx = livePlanSteps.length; liveRender(); $('live-stop').style.display = 'none'; liveNote(text || 'Done'); }
function checkStop() { if (stopRun) throw new Error('Stopped by you'); }
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'progress') liveNote(m.note); });
let manualResolve = null;

setTimeout(() => { const rb = document.getElementById('live-read'); if (rb) rb.onclick = async () => { try { const r = await chrome.tabs.sendMessage(workTabs.chatgpt, { type: 'read' }); if (manualResolve) manualResolve(r); else liveNote('Nothing is waiting for an answer right now'); } catch (e) { liveNote('Could not read the ChatGPT tab: ' + e.message); } }; }, 0);
setTimeout(() => { const b = document.getElementById('live-stop'); if (b) b.onclick = () => { stopRun = true; try { stop = true; } catch { /* batch not running */ } liveNote('Stopping after this step…'); }; }, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cfg = { crm: 'https://skillbnk-crm.onrender.com', token: '', project: '', work: 'plan', owner: 'me', pause: 20, deep: true, setup: true };
let setup = { text: '', version: '', at: 0 }; // the rulebook and its version code; refreshed every 10 minutes so a rules change is picked up
async function getSetup(force = false) {
  if (force || !setup.text || Date.now() - setup.at > 120000) { const s = await crm('GET', '/api/leads/ai-setup'); setup = { text: s.prompt.replace(/Reply "Ready"[^\n]*/g, 'The first lead follows in this same message. Answer it now.'), version: s.version, writing: s.writing || '', source: s.rules_source || '', at: Date.now() }; }
  return setup;
}
// Every time the panel opens, and on demand: pull the rulebook and the writing standard fresh from the CRM (nothing is kept from an earlier session) and say what was found.
async function syncNow() {
  const box = $('sync'); if (!box) return;
  try {
    const st = await getSetup(true); const ver = chrome.runtime.getManifest().version;
    const ok = !!st.writing;
    box.className = ok ? 'ok' : 'err';
    box.textContent = `Synced ${new Date().toLocaleTimeString()}: rules ${st.version} (${st.source || 'built-in'}), writing standard ${st.writing || 'MISSING, the CRM server is not updated yet'}, extension v${ver}`;
    log('Synced with the CRM: rulebook ' + st.version + (ok ? ', writing standard ' + st.writing : ', writing standard missing on the server'), ok ? 'ok' : 'err');
  } catch (e) { box.className = 'err'; box.textContent = 'Not synced: ' + e.message + ' (using nothing from the last session)'; }
}
let appCfg = null; // CRM dropdown values (lead type, category, channel)
let leads = []; let busy = false; let stop = false; const findings = {}; // lead id -> text the person added
const deepInfo = {}; // lead id -> { checked: [...], links: [...] } from the automatic check

// Plain-words state and "what the extension will do" for each kind of step the CRM plan produces.
const STATE = {
  reply: ['REPLIED', 'green', 'Read the thread, then draft your answer.'],
  first_message: ['ACCEPTED', 'green', 'They accepted. Check the profile and draft the first message.'],
  followup: ['MESSAGED, NO REPLY', 'amber', 'Check the thread, then draft a follow-up with a new angle.'],
  last_followup: ['LAST FOLLOW-UP', 'amber', 'Draft the last follow-up, then stop.'],
  email: ['NO REPLY: EMAIL', 'amber', 'Check webmail, then draft the short email.'],
  check_invite: ['INVITE PENDING', 'blue', 'Check if they accepted. If yes the CRM is updated, then draft the first message.'],
  no_email: ['NO EMAIL', 'blue', 'Find the Contact Us form or a post to comment on, then draft it.'],
  research: ['FIND A WAY IN', 'blue', 'Read the website for a booking link, form or email, then draft.'],
  scheduled: ['PLANNED STEP', 'blue', 'Do the planned follow-up from the lead note.'],
};
const stateOfLead = (l) => (l.outreach_status === 'R' ? 'reply' : l.first_dm_date ? 'followup' : l.accepted_date ? 'first_message' : l.invite_sent_date ? 'check_invite' : 'research');
let batchInfo = '';
const setStatus = (m) => { const s = $('status'); if (!m) { s.style.display = 'none'; return; } s.style.display = ''; s.textContent = (batchInfo ? batchInfo + ' · ' : '') + m; };
async function refreshTargets() {
  try {
    const p = await crm('GET', '/api/plan?assignee=me&day=today'); const t = p.members?.[0]?.targets || [];
    $('targets').replaceChildren(el('b', {}, 'Today: '), ...(t.length ? t.map((x) => el('span', { style: 'margin-right:8px;white-space:nowrap' + (x.done >= x.target ? ';color:#0a7a2f' : '') }, `${x.label} ${x.done}/${x.target}`)) : ['no targets set']));
  } catch { /* not important */ }
}
const log = (m, cls = '') => { const d = el('div', { class: cls }, `${new Date().toLocaleTimeString()} ${m}`); $('log').prepend(d); if (!cls) setStatus(m); };
async function crm(method, path, body) {
  const res = await fetch(cfg.crm.replace(/\/$/, '') + path, { method, cache: 'no-store', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `CRM said ${res.status}`);
  return j;
}


// ── Survive closing the side panel: keep each ChatGPT answer until it is saved, and keep today's finished list ──
async function stashPending(lead, text) { const s = (await chrome.storage.local.get('pending')).pending || {}; s[lead.id] = { id: lead.id, name: `${lead.first_name} ${lead.last_name}`, text, at: Date.now() }; await chrome.storage.local.set({ pending: s }); }
async function clearPending(id) { const s = (await chrome.storage.local.get('pending')).pending || {}; delete s[id]; await chrome.storage.local.set({ pending: s }); }
async function addDone(lead, verdict, next) { const s = (await chrome.storage.local.get('doneList')).doneList || []; const day = new Date().toLocaleDateString('en-CA'); const keep = s.filter((x) => x.day === day && x.id !== lead.id); keep.unshift({ id: lead.id, day, name: `${lead.first_name} ${lead.last_name}`, verdict, next: next || '' }); await chrome.storage.local.set({ doneList: keep.slice(0, 200) }); }
async function renderDone() {
  const list = ((await chrome.storage.local.get('doneList')).doneList || []).filter((x) => x.day === new Date().toLocaleDateString('en-CA')); if (!list.length) return;
  const dn = $('done'); dn.classList.remove('muted'); dn.replaceChildren(...list.map((x) => el('div', { class: 'card' }, el('b', {}, x.name), ' ', el('span', { class: 'chip ' + x.verdict }, x.verdict), el('div', {}, 'Next: ' + (x.next || '-')))));
}
async function resumePending() {
  if (cfg.autosave === false) return;
  const s = (await chrome.storage.local.get('pending')).pending || {};
  for (const k of Object.keys(s)) {
    const p = s[k];
    if (Date.now() - p.at > 3 * 86400000) { await clearPending(p.id); continue; }
    const d = extractJson(p.text);
    if (!d) { log(`Saved answer for ${p.name} has no JSON block. Open the lead and press Research this lead again.`, 'err'); continue; }
    try {
      const body = { verdict: String(d.verdict || 'QUALIFY').toUpperCase(), reason: d.reason || '', assessment: d.assessment || '', why_in_pipeline: d.why_in_pipeline || '', todays_question: d.todays_question || '', next_action: d.next_action || '', next_action_days: Number(d.next_action_days) || 0, denial_reason: d.denial_reason || '', quality: d.quality || '', lead_category: d.lead_category || '', channel: d.channel || '', outreach_status: d.outreach_status || '', research_summary: d.research_summary || '', needs_human: d.needs_human || '', rules_version: (typeof setup !== 'undefined' && setup?.version) || '', checked: d.checked || [], links: d.links || [], drafts: (d.drafts || []).map((z) => ({ channel: z.channel, subject: z.subject || '', body: z.body || '', target_url: z.target_url || '', note: z.note || '' })) };
      const res = await crm('POST', `/api/leads/${p.id}/ai-result`, body);
      log(`Recovered and saved ${p.name}: ${res.verdict}, ${res.drafts} drafts (it was not saved before the panel closed)`, 'ok');
      await clearPending(p.id); await addDone({ id: p.id, first_name: p.name, last_name: '' }, res.verdict, body.next_action);
    } catch (e) { log(`Could not save the kept answer for ${p.name}: ${e.message}`, 'err'); }
  }
}

async function loadCfg() {
  const s = await chrome.storage.local.get('cfg'); cfg = { ...cfg, ...(s.cfg || {}) };
  for (const k of ['crm', 'token', 'project', 'work', 'owner', 'pause']) $(k).value = cfg[k];
  $('calIcs').value = cfg.calIcs || ''; $('avail').value = cfg.avail || DEFAULT_AVAIL; $('hidedone').checked = cfg.hideDone !== false; $('autosave').checked = cfg.autosave !== false; $('followup').checked = cfg.followup !== false; $('deep').checked = cfg.deep !== false; $('setup').checked = cfg.setup !== false;
  if (!cfg.token || !cfg.project) $('settings').open = true; else { await syncNow(); refreshTargets(); await resumePending(); await renderDone(); try { appCfg = await crm('GET', '/api/config'); } catch { /* the preview then has no dropdown lists */ } $('load').click(); /* show the list right away */ }
}
$('save').onclick = async () => { for (const k of ['crm', 'token', 'project', 'work', 'owner', 'pause']) cfg[k] = $(k).value.trim(); cfg.calIcs = $('calIcs').value.trim(); cfg.avail = $('avail').value; if (cfg.calIcs) { try { await chrome.permissions.request({ origins: [new URL(cfg.calIcs).origin + '/*'] }); } catch { /* shown when the calendar is read */ } } availCache = { at: 0, text: '' }; cfg.hideDone = $('hidedone').checked; cfg.autosave = $('autosave').checked; cfg.followup = $('followup').checked; cfg.deep = $('deep').checked; cfg.setup = $('setup').checked; await chrome.storage.local.set({ cfg }); log('Settings saved', 'ok'); $('load').click(); };

$('load').onclick = async () => {
  try {
    if (cfg.work === 'plan') {
      const p = await crm('GET', '/api/plan?assignee=me'); const acts = (p.members?.[0]?.actions || []);
      leads = acts.map((a) => { const [first, ...rest] = String(a.name || '').split(' '); return { id: a.id, first_name: first, last_name: rest.join(' '), title: a.title, company: a.company, linkedin: a.linkedin, email: a.email, plan: a }; });
      $('count').textContent = `${acts.length} leads due (${p.members?.[0]?.summary?.carry_over || 0} more carried over)`;
      drawQueue(); return;
    }
    const q = new URLSearchParams({ limit: '100', sort: 'work', dir: 'asc' }); // same order as the CRM's "Work order"
    if (cfg.work === 'changed') q.set('needs_review', '1'); else q.set('work', cfg.work);
    if (cfg.owner === 'me') q.set('owner', 'me');
    const r = await crm('GET', '/api/leads?' + q);
    // Hide what needs no work today: next action is still in the future, or the lead was already researched today. Changed leads always show.
    const today = new Date().toLocaleDateString('en-CA'); let notDue = 0, doneToday = 0;
    const keep = (l) => {
      if (cfg.work === 'changed' || cfg.hideDone === false || l.needs_review) return true;
      if (l.next_action_date && l.next_action_date > today) { notDue++; return false; }
      if (l.research_at && String(l.research_at).slice(0, 10) === today) { doneToday++; return false; }
      return true;
    };
    const due = r.rows.filter(keep); leads = due.slice(0, 20);
    const wl = $('work').selectedOptions[0]?.textContent.replace(/\s*\(\d+\)$/, '') || cfg.work;
    $('count').textContent = `${wl} · ${cfg.owner === 'me' ? 'my leads' : 'everyone'}: ${r.total} in the CRM list. ${due.length} need work now, showing ${leads.length}.` + (notDue || doneToday ? ` Hidden: ${notDue} not due yet, ${doneToday} already researched today (untick the setting to see them).` : '');
    refreshCounts();
    drawQueue();
  } catch (e) { log(e.message, 'err'); }
};
// Put the CRM's own counts on the list names, so the extension and the CRM tabs can be compared number for number.
async function refreshCounts() {
  try {
    const q = new URLSearchParams(); if (cfg.owner === 'me') q.set('owner', 'me');
    const c = await crm('GET', '/api/leads/work-counts?' + q);
    for (const o of $('work').options) { const base = o.textContent.replace(/\s*\(\d+\)$/, ''); const n = c[o.value]; o.textContent = n === undefined ? base : `${base} (${n})`; }
  } catch { /* counts are only a help */ }
}

function drawQueue() {
  $('queue').replaceChildren(
    leads.length ? el('div', { class: 'row' }, el('button', { class: 'primary', id: 'runall', onclick: async () => { if (await allSites()) runBatch(); } }, `Research all ${leads.length} in order`), el('button', { onclick: () => { stop = true; log('Stopping after this lead'); } }, 'Stop')) : null,
    ...leads.map((l) => el('div', { class: 'card', id: 'lead' + l.id }, el('b', {}, `${l.first_name} ${l.last_name}`.trim() || l.company), ' ', el('span', { class: 'muted' }, [l.title, l.company].filter(Boolean).join(' · ')),
      (() => { const k = l.plan?.kind || stateOfLead(l); const [label, tone, what] = STATE[k] || STATE.scheduled; const due = l.plan ? (l.plan.late_days > 0 ? `${l.plan.late_days} days late` : 'due today') : (l.next_action_date ? 'due ' + l.next_action_date : '');
        return el('div', {}, el('div', { class: 'row' }, el('span', { class: 'chip', style: 'font-weight:600;background:' + ({ green: '#d7f5e0', amber: '#fff1c2', blue: '#dbe8ff' }[tone]) }, label), l.plan?.pursue ? el('span', { class: 'chip PURSUE' }, 'PURSUE') : null, due ? el('span', { class: 'muted' }, due) : null),
          el('div', {}, el('b', {}, 'Do now: '), l.plan?.action || l.next_action || (STATE[k] || [])[0]), el('div', { class: 'muted' }, 'The extension will: ' + what), l.plan?.reason ? el('div', { class: 'muted' }, 'Why: ' + l.plan.reason) : null,
          [l.stage, l.needs_review && 'NEW: ' + l.needs_review].filter(Boolean).length ? el('div', { class: 'muted' }, [l.stage, l.needs_review && 'NEW: ' + l.needs_review].filter(Boolean).join(' · ')) : null); })(),
      el('div', { class: 'row' }, el('button', { onclick: async () => { if (await allSites()) researchOne(l); } }, 'Research this lead'), el('button', { onclick: async () => { if (await allSites()) deepOnly(l); } }, 'Check only'), el('button', { onclick: () => { document.getElementById('lead' + l.id)?.remove(); log(`Skipped ${l.first_name} ${l.last_name} (nothing saved)`); } }, 'Skip'), el('button', { onclick: () => scanTab('web', l) }, 'Scan open website'), el('button', { onclick: () => scanTab('li', l) }, 'Read open LinkedIn page'), el('span', { class: 'muted', id: 'f' + l.id }, findings[l.id] ? 'findings added' : '')), logRow(l))));
}

// ── Log what you did by hand, in one click, so the CRM history, targets and weekly report stay true ──
const ACTION_LABELS = { linkedin_like: 'Liked a post', linkedin_comment: 'Commented on a post', linkedin_comment_reply: 'Replied to a comment', linkedin_follow: 'Followed', linkedin_connect: 'Sent connection request', linkedin_dm: 'Sent LinkedIn DM', linkedin_followup: 'Sent follow-up message', linkedin_inmail: 'Sent InMail', email: 'Sent email', website_contact: 'Submitted website form', meeting: 'Meeting booked', call: 'Call', note: 'Note only' };
function logRow(lead) {
  const sel = el('select', {}, el('option', { value: '' }, 'Log what I did…'), ...Object.entries(ACTION_LABELS).map(([k, v]) => el('option', { value: k }, v)));
  const note = el('input', { placeholder: 'note, link or what you wrote (optional)', style: 'flex:1;min-width:120px' });
  const btn = el('button', { onclick: async () => {
    const type = sel.value; if (!type) return;
    try {
      if (type === 'meeting') {
        const date = prompt('Meeting date (YYYY-MM-DD):', ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { log('Meeting not logged: use a date like 2026-12-01', 'err'); return; }
        const time = prompt('Time (optional, e.g. 15:30 Michigan):', '') || '';
        await crm('POST', `/api/leads/${lead.id}/meetings`, { scheduled_date: date, scheduled_time: time, notes: note.value, link: /^https?:/i.test(note.value) ? note.value : '' });
      } else {
        let text = note.value.trim();
        if (type === 'website_contact' && text.length < 15) { text = prompt('Paste the form link and the confirmation the website showed (15+ characters):', text) || ''; if (text.trim().length < 15) return; }
        if (type === 'note' && !text) { log('Write a note first', 'err'); return; }
        await crm('POST', `/api/leads/${lead.id}/activities`, { type, note: text });
      }
      log(`${lead.first_name} ${lead.last_name}: logged "${ACTION_LABELS[type]}"`, 'ok'); sel.value = ''; note.value = ''; btn.textContent = 'Logged ✓'; setTimeout(() => { btn.textContent = 'Log'; }, 2000); refreshTargets();
    } catch (e) { log(e.message, 'err'); }
  } }, 'Log');
  return el('div', {}, el('div', { class: 'row' }, sel, note, btn), typeof actionsRow === 'function' ? actionsRow(lead) : null);
}

async function allSites() {
  if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true;
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
  if (!ok) log('Permission to read websites was declined. It is needed for the automatic check.', 'err');
  return ok;
}
async function deepOnly(lead) {
  const box = $('work-area'); box.replaceChildren(el('div', { class: 'card' }, `Checking ${lead.first_name} ${lead.last_name}…`));
  livePlan(`Checking ${lead.first_name} ${lead.last_name}`, ['LinkedIn status first: accepted or pending? last activity, conversation', 'Website (only if not read recently)', 'Webmail (only if not searched recently)']);
  try { if (!lead.hydrated) { const full = (await crm('GET', `/api/leads/${lead.id}`)).lead; Object.assign(lead, full, { hydrated: true }); } const d = await deepCheck(lead); liveEnd('Check finished. The result is below.'); findings[lead.id] = d.text; deepInfo[lead.id] = { checked: d.checked, links: [...(d.website.book || []).map((x) => ({ kind: 'booking', url: x.h })), ...(d.website.contact || []).map((x) => ({ kind: 'contact', url: x.h }))] }; $('f' + lead.id) && ($('f' + lead.id).textContent = 'findings added'); box.replaceChildren(el('div', { class: 'card' }, el('b', {}, 'Check finished (added to the next research)'), el('pre', { style: 'white-space:pre-wrap' }, d.text))); }
  catch (e) { box.replaceChildren(el('div', { class: 'card err' }, e.message)); liveEnd('Stopped: ' + e.message); }
}

// ── read-only helpers on the page you have open (they run only when you press the button) ──
async function scanTab(kind, lead) {
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
  if (!ok) { log('Permission to read the open page was declined', 'err'); return; }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: kind === 'web' ? scanWebsite : readPage });
  findings[lead.id] = (findings[lead.id] ? findings[lead.id] + '\n' : '') + (kind === 'web' ? 'Website scan of ' + tab.url + ':\n' : 'Page text from ' + tab.url + ':\n') + result;
  $('f' + lead.id).textContent = 'findings added'; log(`Added ${kind === 'web' ? 'website scan' : 'page text'} for ${lead.first_name} ${lead.last_name}`, 'ok');
}
function scanWebsite() {
  const a = [...document.querySelectorAll('a[href]')].map((x) => ({ h: x.href, t: (x.textContent || '').trim().slice(0, 60) }));
  const book = a.filter((x) => /calendly\.com|cal\.com|savvycal|tidycal|zcal\.co|youcanbook|setmore|acuityscheduling|meetings\.hubspot|\/book/i.test(x.h));
  const contact = a.filter((x) => /contact|get-in-touch/i.test(x.h + ' ' + x.t));
  const mail = a.filter((x) => /^mailto:/i.test(x.h)).map((x) => x.h.replace(/^mailto:/i, '').split('?')[0]);
  const text = (document.body.innerText || '').slice(0, 3500);
  const emails = [...new Set((document.body.innerText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).concat(mail))].slice(0, 6);
  const uniq = (xs) => [...new Map(xs.map((x) => [x.h, x])).values()].slice(0, 6).map((x) => `${x.t} ${x.h}`).join('\n  ');
  return `Booking links:\n  ${uniq(book) || 'none seen'}\nContact page links:\n  ${uniq(contact) || 'none seen'}\nEmails seen: ${emails.join(', ') || 'none'}\nPage text:\n${text}`;
}
function readPage() { return (document.querySelector('main')?.innerText || document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 6000); }

// ── ChatGPT ──
async function chatTab(url = cfg.project) {
  liveNote('Opening ChatGPT in its own tab');
  const tab = await siteTab('chatgpt', url);
  await new Promise((res) => { const f = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(f); res(); } }; chrome.tabs.onUpdated.addListener(f); setTimeout(res, 20000); });
  for (let i = 0; i < 20; i++) { try { const p = await chrome.tabs.sendMessage(tab.id, { type: 'ping' }); if (p?.ready) return tab.id; } catch { /* page still loading */ } await sleep(1000); }
  throw new Error('ChatGPT did not load. Are you signed in, and is the project link right?');
}
function extractJson(text) {
  let at = text.lastIndexOf('"verdict"'); if (at < 0) return null;
  let start = text.lastIndexOf('{', at); while (start >= 0) { // walk back to the outer brace that parses
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) { const c = text[i]; if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; } else if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { break; } } }
    start = text.lastIndexOf('{', start - 1);
  }
  return null;
}

// While ChatGPT is answering for one lead, the next lead's LinkedIn, website and webmail are already being read.
let nextInBatch = null; const prefetching = {};
function startPrefetch() {
  const n = nextInBatch; if (!n || cfg.deep === false || deepInfo[n.id] || prefetching[n.id]) return Promise.resolve();
  prefetching[n.id] = (async () => {
    try {
      if (!n.hydrated) { const full = (await crm('GET', `/api/leads/${n.id}`)).lead; Object.assign(n, full, { hydrated: true }); }
      const d = await deepCheck(n, () => {}, true);
      findings[n.id] = d.text + (findings[n.id] ? '\n' + findings[n.id] : '');
      deepInfo[n.id] = { checked: d.checked, links: [...(d.website.book || []).map((x) => ({ kind: 'booking', url: x.h })), ...(d.website.contact || []).map((x) => ({ kind: 'contact', url: x.h }))] };
    } catch { /* that lead's own run reads it again */ } finally { delete prefetching[n.id]; }
  })();
  return prefetching[n.id];
}

async function researchOne(lead) {
  if (busy) { log('Another lead is running', 'err'); return false; }
  busy = true; const box = $('work-area'); box.replaceChildren(el('div', { class: 'card' }, `Researching ${lead.first_name} ${lead.last_name}…`));
  try {
    if (!cfg.token || !cfg.project) throw new Error('Add the CRM API key and the ChatGPT project link in Settings first.');
    livePlan(`Researching ${lead.first_name} ${lead.last_name}`, ['LinkedIn status first: accepted or pending? last activity, conversation', 'Website (only if not read recently)', 'Webmail (only if not searched recently)', 'Ask ChatGPT (new or saved chat)', 'Read the answer, show the preview']);
    if (!lead.hydrated) { const full = (await crm('GET', `/api/leads/${lead.id}`)).lead; Object.assign(lead, full, { hydrated: true }); }
    if (prefetching[lead.id]) { liveNote('This lead was already read while the last answer was coming in'); await prefetching[lead.id]; }
    if (cfg.deep !== false && !deepInfo[lead.id]) {
      const d = await deepCheck(lead);
      findings[lead.id] = d.text + (findings[lead.id] ? '\n' + findings[lead.id] : '');
      deepInfo[lead.id] = { checked: d.checked, links: [...(d.website.book || []).map((x) => ({ kind: 'booking', url: x.h })), ...(d.website.contact || []).map((x) => ({ kind: 'contact', url: x.h }))] };
    }
    const detail = await crm('GET', `/api/leads/${lead.id}`);
    const chatLink = (detail.links || []).find((k) => k.kind === 'chatgpt' && /\/c\//.test(k.url))?.url;
    let prompt; let chatUrl = cfg.project;
    if (chatLink) {
      // This lead already has its own chat: continue it and send only what is new.
      chatUrl = chatLink;
      prompt = `UPDATE ${new Date().toISOString().slice(0, 10)}. New since the last check: ${detail.lead.needs_review || 'no change flagged, this is a manual re-check'}.\n\n${findings[lead.id] || '(no extra findings)'}\n\nRe-assess this lead from the earlier research plus this update. Any draft you write follows this writing standard:\n${WRITING}\n\n${detail.lead.outreach_status === 'R' ? await availabilityBlock() + '\n\n' : ''} Answer in the same A to F format, but only say what changed. End with the same machine-readable json block as before, with research_summary updated.`;
      if (cfg.setup !== false) { const st = await getSetup(); if (detail.lead.rules_version !== st.version) { prompt = `RULES UPDATED. The rulebook below replaces every earlier version of the rules in this chat. Use only this one from now on.\n\n${st.text}\n\n=== END OF UPDATED RULEBOOK ===\n\n` + prompt; log('Rules changed since this chat last saw them: sending the updated rulebook with the update', 'ok'); } }
      log(`Continuing the saved ChatGPT chat for ${lead.first_name} ${lead.last_name} (only what is new)`);
    } else {
      ({ prompt } = await crm('GET', `/api/leads/${lead.id}/ai-prompt?machine=1`));
      // New chat: the rulebook goes first, in the same message (skip it if the project already holds it).
      if (cfg.setup !== false) prompt = (await getSetup()).text + '\n\n' + prompt;
      if (findings[lead.id]) prompt = prompt.replace('Anything else I noticed:', 'Anything else I noticed:\n' + findings[lead.id]);
    }
    log(`Asking ChatGPT about ${lead.first_name} ${lead.last_name}…`);
    liveAt(3, chatLink ? 'Opening this lead\'s saved ChatGPT chat and sending only what is new' : 'Opening a new chat in the ChatGPT project, pasting the rules and the lead prompt');
    const tabId = await chatTab(chatUrl);
    $('live-read').style.display = '';
    const manual = new Promise((res) => { manualResolve = res; });
    const pf = startPrefetch();
    const r = await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'ask', prompt }), manual]); manualResolve = null; $('live-read').style.display = 'none';
    await pf; // the next lead's reading finishes before the follow-through below uses the same tabs
    if (!r?.ok) throw new Error(r?.error || 'No answer from ChatGPT');
    if (r.url && /\/c\//.test(r.url)) { try { await crm('POST', `/api/leads/${lead.id}/links`, { url: r.url, kind: 'chatgpt', label: 'ChatGPT research' }); log('ChatGPT chat link saved on the lead', 'ok'); } catch (e) { if (!/already added/i.test(e.message)) log('Could not save the ChatGPT chat link: ' + e.message, 'err'); } } else log('ChatGPT answered, but its chat link was not visible, so it was not saved', 'err');
    liveAt(4, 'ChatGPT answered, reading the JSON block');
    await stashPending(lead, r.text); // kept until it is saved, so closing the panel does not lose it
    let data = extractJson(r.text);
    if (!data && cfg.autosave !== false) { // ChatGPT forgot the JSON block: ask for it once, by itself
      liveNote('The answer had no JSON block, asking ChatGPT for it');
      try { const r2 = await chrome.tabs.sendMessage(tabId, { type: 'ask', prompt: 'Send ONLY the machine-readable json block for this lead, exactly as specified in the MACHINE BLOCK section. One code block tagged json and nothing else.' }); if (r2?.ok) { data = extractJson(r2.text); if (data) r.text += '\n\n' + r2.text; } } catch { /* shown below */ }
    }
    if (!data) { liveEnd('ChatGPT gave no JSON block. Skipped, nothing saved.'); box.replaceChildren(card(lead, null, r)); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); log('ChatGPT answered without the JSON block. Press "Ask ChatGPT for the JSON block" on the card.', 'err'); return false; }
    data = await polishDrafts(lead, data, tabId);
    const c = card(lead, data, r); box.replaceChildren(c);
    if (cfg.autosave !== false) {
      liveAt(4, 'Saving the result to the CRM (nothing is sent)');
      const saved = await c._doSave();
      liveEnd(saved ? 'Saved to the CRM. Drafts are ready in the list below. Nothing was sent.' : 'Could not save. Fix the problem shown in the card, then press Save to CRM.');
      return saved;
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    liveEnd('Preview is ready below. Check it, edit if needed, then Save to CRM.');
    return true;
  } catch (e) { box.replaceChildren(el('div', { class: 'card err' }, e.message)); log(e.message, 'err'); liveEnd('Stopped: ' + e.message); return false; }
  finally { busy = false; }
}

// Preview + edit, then one save. Quick links appear after saving.
function card(lead, data, r) {
  const d = data || {};
  const tx = (v, rows = 2) => { const t = el('textarea', { rows }); t.value = v || ''; return t; };
  const verdict = el('select', {}, ...['PURSUE', 'QUALIFY', 'NURTURE', 'SKIP'].map((v) => el('option', { value: v }, v))); verdict.value = String(d.verdict || 'QUALIFY').toUpperCase();
  const pick = (list, val) => { const s = el('select', {}, el('option', { value: '' }, '(leave as is)'), ...(list || []).map((v) => el('option', { value: v }, v))); s.value = (list || []).includes(val) ? val : ''; return s; };
  const qualitySel = pick(appCfg?.qualities, d.quality), categorySel = pick(appCfg?.leadCategories, d.lead_category), channelSel = pick(appCfg?.channels, d.channel);
  const reason = tx(d.reason), assessment = tx(d.assessment, 3), why = tx(d.why_in_pipeline), next = tx(d.next_action, 1);
  const days = el('input', { type: 'number', min: 0, max: 60, value: d.next_action_days ?? 0, style: 'width:70px' });
  const drafts = (d.drafts || []).map((x) => ({ x, body: tx(x.body, 4), subject: el('input', { value: x.subject || '' }), target: el('input', { value: x.target_url || '', placeholder: 'link (comments and Contact Us)' }) }));
  const links = (d.links || []).map((k) => `${k.kind || 'other'}: ${k.url}`).join('\n');
  const out = el('div');
  const reaskBtn = el('button', { class: 'primary', onclick: async () => {
    reaskBtn.disabled = true; reaskBtn.textContent = 'Asking…';
    try {
      const tabId = await chatTab(r.url && /\/c\//.test(r.url) ? r.url : cfg.project);
      const r2 = await chrome.tabs.sendMessage(tabId, { type: 'ask', prompt: 'Send ONLY the machine-readable json block for this lead, exactly as specified in the MACHINE BLOCK section. One code block tagged json and nothing else.' });
      if (!r2?.ok) throw new Error(r2?.error || 'No answer');
      const d2 = extractJson(r2.text); if (!d2) throw new Error('Still no JSON block in the answer. Read the full answer below.');
      $('work-area').replaceChildren(card(lead, d2, { ...r2, text: r.text + '\n\n' + r2.text })); $('work-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { reaskBtn.disabled = false; reaskBtn.textContent = 'Ask ChatGPT for the JSON block'; log(e.message, 'err'); }
  } }, 'Ask ChatGPT for the JSON block');
  const skipBtn = el('button', { onclick: () => { document.getElementById('lead' + lead.id)?.remove(); $('work-area').replaceChildren(); log(`Skipped ${lead.first_name} ${lead.last_name} (nothing saved)`); } }, 'Skip, do not save');
  const doSave = async () => {
    saveBtn.disabled = true;
    try {
      const body = { verdict: verdict.value, reason: reason.value, assessment: assessment.value, why_in_pipeline: why.value, todays_question: d.todays_question || '', next_action: next.value, next_action_days: Number(days.value), denial_reason: d.denial_reason || '', quality: qualitySel.value, lead_category: categorySel.value, channel: channelSel.value, outreach_status: d.outreach_status || '', research_summary: d.research_summary || '', needs_human: d.needs_human || '', rules_version: setup.version || '', checked: [...new Set([...(d.checked || []), ...(deepInfo[lead.id]?.checked || [])])],
        links: [...(d.links || []), ...(deepInfo[lead.id]?.links || [])], drafts: drafts.map((z) => ({ channel: z.x.channel, subject: z.subject.value, body: z.body.value, target_url: z.target.value, note: z.x.note || '' })) };
      const res = await crm('POST', `/api/leads/${lead.id}/ai-result`, body);
      log(`Saved ${lead.first_name} ${lead.last_name}: ${res.verdict}${res.dropdowns?.quality ? ', type ' + res.dropdowns.quality : ''}, ${res.drafts} drafts, ${res.links} links${res.skipped.length ? ', skipped: ' + res.skipped.join('; ') : ''}`, 'ok');
      const saved = res.saved || [];
      out.replaceChildren(el('div', { class: 'ok' }, `Saved to the CRM (${res.drafts} drafts, ${res.links} links). Nothing was sent.`), ...quickLinks(lead, saved),
        ['PURSUE', 'QUALIFY'].includes(res.verdict) ? el('div', { class: 'row' }, el('button', { onclick: async (ev) => { try { await crm('POST', `/api/leads/${lead.id}/ceo-submit`, { note: body.reason }); ev.target.disabled = true; ev.target.textContent = 'Sent to CEO'; log(`${lead.first_name} ${lead.last_name} sent to the CEO`, 'ok'); } catch (e) { log(e.message, 'err'); } } }, 'Send lead to CEO')) : null,
        logRow(lead), el('div', { class: 'muted' }, d.needs_human ? 'Check by hand: ' + d.needs_human : ''));
      refreshTargets(); await clearPending(lead.id); await addDone(lead, res.verdict, body.next_action);
      saveBtn.remove(); skipBtn.remove(); document.getElementById('lead' + lead.id)?.remove();
      // keep a line for every finished lead, so the next lead in a batch does not hide this one's quick links
      const dn = $('done'); if (dn.classList.contains('muted')) { dn.classList.remove('muted'); dn.replaceChildren(); }
      const followBox = el('div'); dn.prepend(el('div', { class: 'card' }, el('b', {}, `${lead.first_name} ${lead.last_name}`), ' ', el('span', { class: 'chip ' + res.verdict }, res.verdict), el('div', {}, 'Next: ' + (body.next_action || '-')), ...quickLinks(lead, saved), followBox, logRow(lead)));
      try { await followThrough(lead, d, r, res, followBox); } catch (e) { log('Follow-up: ' + e.message, 'err'); }
      return true;
    } catch (e) { saveBtn.disabled = false; log(e.message, 'err'); out.replaceChildren(el('div', { class: 'err' }, e.message)); return false; }
  };
  const saveBtn = el('button', { class: 'primary', onclick: doSave }, 'Save to CRM');
  const root = el('div', { class: 'card' },
    el('div', { class: 'row' }, el('b', {}, `${lead.first_name} ${lead.last_name}`), verdict, !data ? el('span', { class: 'chip SKIP' }, 'No JSON block found') : null),
    data ? el('div', {}, 'Reason', reason, 'Assessment line', assessment, 'Why in pipeline', why, el('div', { class: 'row' }, 'Next action', next, 'in days', days), el('div', { class: 'row' }, 'Lead type', qualitySel, 'Category', categorySel, 'Channel', channelSel),
      links ? el('div', {}, el('div', { class: 'muted' }, 'Links to add'), el('pre', {}, links)) : null,
      ...drafts.map((z) => el('div', { class: 'card' }, el('span', { class: 'chip' }, z.x.channel), z.x.channel === 'email' ? z.subject : null, z.body, ['linkedin_comment', 'linkedin_comment_reply', 'linkedin_like', 'website_contact'].includes(z.x.channel) ? z.target : null,
        z.x.channel === 'linkedin_connect' ? el('div', { class: 'muted' }, 'Connection note limit: 300 characters') : null)),
      d.needs_human ? el('div', { class: 'muted' }, 'Check by hand: ' + d.needs_human) : null, el('div', { class: 'row' }, saveBtn, skipBtn)) : el('div', { class: 'row' }, reaskBtn, skipBtn),
    out, el('details', {}, el('summary', {}, 'Full ChatGPT answer'), el('pre', { style: 'white-space:pre-wrap' }, r.text || '')));
  root._doSave = doSave;
  return root;
}

// Quick links for the human step. The extension opens pages; you review and press send yourself.
function quickLinks(lead, drafts) {
  const rows = [];
  const li = (u) => (/^https?:/i.test(u) ? u : 'https://' + u);
  for (const d of drafts) {
    const buttons = [el('button', { onclick: () => { navigator.clipboard.writeText((d.channel === 'email' && d.subject ? 'Subject: ' + d.subject + '\n\n' : '') + d.body); log('Draft copied', 'ok'); } }, 'Copy text')];
    if (d.channel === 'email' && lead.email) buttons.push(el('a', { class: 'btn', target: '_blank', href: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.email)}&su=${encodeURIComponent(d.subject || '')}&body=${encodeURIComponent(d.body)}` }, 'Open Gmail draft'));
    if (['linkedin_connect', 'linkedin_dm', 'linkedin_followup', 'linkedin_inmail', 'linkedin_comment_reply'].includes(d.channel) && lead.linkedin) buttons.push(el('a', { class: 'btn', target: '_blank', href: li(lead.linkedin) }, 'Open profile'));
    if (d.target_url) buttons.push(el('a', { class: 'btn', target: '_blank', href: d.target_url }, d.channel === 'website_contact' ? 'Open the form' : d.channel === 'linkedin_like' ? 'Open the post to like' : 'Open the post'));
    if (d.id) buttons.push(el('button', { class: 'primary', title: 'Press only after you really sent it', onclick: async (ev) => { if (!confirm('Did you really send this? This logs it as sent in the CRM.')) return; let evidence = ''; if (d.channel === 'website_contact') { evidence = prompt('Paste the confirmation the website showed:') || ''; if (evidence.trim().length < 5) return; } try { await crm('POST', `/api/leads/drafts/${d.id}/sent`, { evidence }); ev.target.disabled = true; ev.target.textContent = 'Logged as sent'; log('Logged as sent', 'ok'); refreshTargets(); } catch (e) { log(e.message, 'err'); } } }, 'Mark sent'));
    rows.push(el('div', { class: 'row' }, el('span', { class: 'chip' }, d.channel), ...buttons));
  }
  return rows;
}

async function runBatch() {
  stop = false;
  const total = leads.length; let i = 0, fails = 0;
  const list = [...leads];
  for (let idx = 0; idx < list.length; idx++) {
    const l = list[idx]; nextInBatch = list[idx + 1] || null;
    if (stop || stopRun) break;
    batchInfo = `Lead ${++i} of ${total}`;
    if (cfg.prescreen !== false && typeof prescreen === 'function') {
      if (!l.hydrated) { try { const full = (await crm('GET', `/api/leads/${l.id}`)).lead; Object.assign(l, full, { hydrated: true }); } catch {} }
      const ps = await prescreen(l);
      if (stop || stopRun) break;
      if (ps.skip) { log(`Pre-screen: ${l.first_name} ${l.last_name} looks like a SKIP (${ps.reasons.join('; ')}). Saved a note, moved on. Confirm the SKIP in the CRM.`, 'ok'); liveNote(`${l.first_name} ${l.last_name}: likely SKIP, not researched`); continue; }
    }
    const ok = await researchOne(l);
    if (stop || stopRun) break;
    if (!ok) { // one bad lead does not stop the batch; three in a row do
      if (++fails >= 3) { log('Three leads in a row failed. Stopping so a person can look.', 'err'); break; }
      continue;
    }
    fails = 0;
    if (cfg.autosave === false) { // manual mode: wait for the person to save or skip this lead
      await new Promise((res) => { const t = setInterval(() => { if (!document.getElementById('lead' + l.id) || stop) { clearInterval(t); res(); } }, 800); });
      if (stop) break;
    }
    $('live-stop').style.display = ''; // keep Stop available between leads
    if (i < total) { const w = Math.round(Math.max(4, (Number(cfg.pause) || 30) / 2)); log(`Waiting about ${w}s before the next lead`); liveNote(`Waiting about ${w}s before the next lead, like a person would`); await sleep(Math.max(4, (Number(cfg.pause) || 30) / 2) * 1000 + Math.random() * 4000); }
  }
  nextInBatch = null; batchInfo = ''; setStatus(''); log('Batch finished or stopped', 'ok'); if (typeof liveEnd === 'function') liveEnd(`Batch finished: ${i} of ${total} leads processed`);
}
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
$('syncbtn').onclick = () => syncNow();
$('availbtn').onclick = async () => { $('availout').textContent = 'Reading…'; try { const t = await availabilityBlock(true); $('availout').textContent = ''; log(t, 'ok'); $('availout').textContent = t.split('\n').slice(0, 3).join(' | ').slice(0, 220); } catch (e) { $('availout').textContent = e.message; } };
loadCfg();
