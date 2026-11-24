// Side panel: CRM prompt -> ChatGPT (skillBNK project) -> parse the JSON block -> you review -> one save to the CRM.
// Nothing is sent to anyone. Drafts are saved as "ready" and shown with quick links (Gmail compose, profile, post, form).
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); return n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cfg = { crm: 'https://skillbnk-crm.onrender.com', token: '', project: '', work: 'plan', owner: 'me', pause: 30, deep: true };
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
    const p = await crm('GET', '/api/plan?assignee=me'); const t = p.members?.[0]?.targets || [];
    $('targets').replaceChildren(el('b', {}, 'Today: '), ...(t.length ? t.map((x) => el('span', { style: 'margin-right:8px;white-space:nowrap' + (x.done >= x.target ? ';color:#0a7a2f' : '') }, `${x.label} ${x.done}/${x.target}`)) : ['no targets set']));
  } catch { /* not important */ }
}
const log = (m, cls = '') => { const d = el('div', { class: cls }, `${new Date().toLocaleTimeString()} ${m}`); $('log').prepend(d); if (!cls) setStatus(m); };
async function crm(method, path, body) {
  const res = await fetch(cfg.crm.replace(/\/$/, '') + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `CRM said ${res.status}`);
  return j;
}

async function loadCfg() {
  const s = await chrome.storage.local.get('cfg'); cfg = { ...cfg, ...(s.cfg || {}) };
  for (const k of ['crm', 'token', 'project', 'work', 'owner', 'pause']) $(k).value = cfg[k];
  $('deep').checked = cfg.deep !== false;
  if (!cfg.token || !cfg.project) $('settings').open = true; else { refreshTargets(); try { appCfg = await crm('GET', '/api/config'); } catch { /* the preview then has no dropdown lists */ } }
}
$('save').onclick = async () => { for (const k of ['crm', 'token', 'project', 'work', 'owner', 'pause']) cfg[k] = $(k).value.trim(); cfg.deep = $('deep').checked; await chrome.storage.local.set({ cfg }); log('Settings saved', 'ok'); };
$('master').onclick = async () => { try { const s = await crm('GET', '/api/leads/ai-setup'); await navigator.clipboard.writeText(s.prompt); log(`Master prompt copied (${s.chars.toLocaleString()} characters). Paste it into the ChatGPT project's instructions, or save it as a .txt file and upload it to the project files.`, 'ok'); } catch (e) { log(e.message, 'err'); } };

$('load').onclick = async () => {
  try {
    if (cfg.work === 'plan') {
      const p = await crm('GET', '/api/plan?assignee=me'); const acts = (p.members?.[0]?.actions || []);
      leads = acts.map((a) => { const [first, ...rest] = String(a.name || '').split(' '); return { id: a.id, first_name: first, last_name: rest.join(' '), title: a.title, company: a.company, linkedin: a.linkedin, email: a.email, plan: a }; });
      $('count').textContent = `${acts.length} leads due (${p.members?.[0]?.summary?.carry_over || 0} more carried over)`;
      drawQueue(); return;
    }
    const q = new URLSearchParams({ limit: '20', sort: 'updated_at' });
    if (cfg.work === 'changed') q.set('needs_review', '1'); else q.set('work', cfg.work);
    if (cfg.owner === 'me') q.set('owner', 'me');
    const r = await crm('GET', '/api/leads?' + q); leads = r.rows;
    $('count').textContent = `${r.total} in this list, showing ${leads.length}`;
    drawQueue();
  } catch (e) { log(e.message, 'err'); }
};
function drawQueue() {
  $('queue').replaceChildren(
    leads.length ? el('div', { class: 'row' }, el('button', { class: 'primary', id: 'runall', onclick: async () => { if (await allSites()) runBatch(); } }, `Research all ${leads.length} in order`), el('button', { onclick: () => { stop = true; log('Stopping after this lead'); } }, 'Stop')) : null,
    ...leads.map((l) => el('div', { class: 'card', id: 'lead' + l.id }, el('b', {}, `${l.first_name} ${l.last_name}`.trim() || l.company), ' ', el('span', { class: 'muted' }, [l.title, l.company].filter(Boolean).join(' · ')),
      (() => { const k = l.plan?.kind || stateOfLead(l); const [label, tone, what] = STATE[k] || STATE.scheduled; const due = l.plan ? (l.plan.late_days > 0 ? `${l.plan.late_days} days late` : 'due today') : (l.next_action_date ? 'due ' + l.next_action_date : '');
        return el('div', {}, el('div', { class: 'row' }, el('span', { class: 'chip', style: 'font-weight:600;background:' + ({ green: '#d7f5e0', amber: '#fff1c2', blue: '#dbe8ff' }[tone]) }, label), l.plan?.pursue ? el('span', { class: 'chip PURSUE' }, 'PURSUE') : null, due ? el('span', { class: 'muted' }, due) : null),
          el('div', {}, el('b', {}, 'Do now: '), l.plan?.action || l.next_action || (STATE[k] || [])[0]), el('div', { class: 'muted' }, 'The extension will: ' + what), l.plan?.reason ? el('div', { class: 'muted' }, 'Why: ' + l.plan.reason) : null,
          [l.stage, l.needs_review && 'NEW: ' + l.needs_review].filter(Boolean).length ? el('div', { class: 'muted' }, [l.stage, l.needs_review && 'NEW: ' + l.needs_review].filter(Boolean).join(' · ')) : null); })(),
      el('div', { class: 'row' }, el('button', { onclick: async () => { if (await allSites()) researchOne(l); } }, 'Research this lead'), el('button', { onclick: async () => { if (await allSites()) deepOnly(l); } }, 'Check only'), el('button', { onclick: () => { document.getElementById('lead' + l.id)?.remove(); log(`Skipped ${l.first_name} ${l.last_name} (nothing saved)`); } }, 'Skip'), el('button', { onclick: () => scanTab('web', l) }, 'Scan open website'), el('button', { onclick: () => scanTab('li', l) }, 'Read open LinkedIn page'), el('span', { class: 'muted', id: 'f' + l.id }, findings[l.id] ? 'findings added' : '')))));
}

async function allSites() {
  if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true;
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
  if (!ok) log('Permission to read websites was declined. It is needed for the automatic check.', 'err');
  return ok;
}
async function deepOnly(lead) {
  const box = $('work-area'); box.replaceChildren(el('div', { class: 'card' }, `Checking ${lead.first_name} ${lead.last_name}…`));
  try { if (!lead.website && !lead.hydrated) { const full = (await crm('GET', `/api/leads/${lead.id}`)).lead; Object.assign(lead, full, { hydrated: true }); } const d = await deepCheck(lead); findings[lead.id] = d.text; deepInfo[lead.id] = { checked: d.checked, links: [...(d.website.book || []).map((x) => ({ kind: 'booking', url: x.h })), ...(d.website.contact || []).map((x) => ({ kind: 'contact', url: x.h }))] }; $('f' + lead.id) && ($('f' + lead.id).textContent = 'findings added'); box.replaceChildren(el('div', { class: 'card' }, el('b', {}, 'Check finished (added to the next research)'), el('pre', { style: 'white-space:pre-wrap' }, d.text))); }
  catch (e) { box.replaceChildren(el('div', { class: 'card err' }, e.message)); }
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
  const [t] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const tab = t ? await chrome.tabs.update(t.id, { url, active: false }) : await chrome.tabs.create({ url, active: false });
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

async function researchOne(lead) {
  if (busy) { log('Another lead is running', 'err'); return false; }
  busy = true; const box = $('work-area'); box.replaceChildren(el('div', { class: 'card' }, `Researching ${lead.first_name} ${lead.last_name}…`));
  try {
    if (!cfg.token || !cfg.project) throw new Error('Add the CRM API key and the ChatGPT project link in Settings first.');
    if (!lead.website && !lead.hydrated) { const full = (await crm('GET', `/api/leads/${lead.id}`)).lead; Object.assign(lead, full, { hydrated: true }); }
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
      prompt = `UPDATE ${new Date().toISOString().slice(0, 10)}. New since the last check: ${detail.lead.needs_review || 'no change flagged, this is a manual re-check'}.\n\n${findings[lead.id] || '(no extra findings)'}\n\nRe-assess this lead from the earlier research plus this update. Answer in the same A to F format, but only say what changed. End with the same machine-readable json block as before, with research_summary updated.`;
      log(`Continuing the saved ChatGPT chat for ${lead.first_name} ${lead.last_name} (only what is new)`);
    } else {
      ({ prompt } = await crm('GET', `/api/leads/${lead.id}/ai-prompt?machine=1`));
      if (findings[lead.id]) prompt = prompt.replace('Anything else I noticed:', 'Anything else I noticed:\n' + findings[lead.id]);
    }
    log(`Asking ChatGPT about ${lead.first_name} ${lead.last_name}…`);
    const tabId = await chatTab(chatUrl);
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ask', prompt });
    if (!r?.ok) throw new Error(r?.error || 'No answer from ChatGPT');
    if (r.url && /\/c\//.test(r.url)) { try { await crm('POST', `/api/leads/${lead.id}/links`, { url: r.url, kind: 'chatgpt', label: 'ChatGPT research' }); log('ChatGPT chat link saved on the lead', 'ok'); } catch (e) { if (!/already added/i.test(e.message)) log('Could not save the ChatGPT chat link: ' + e.message, 'err'); } } else log('ChatGPT answered, but its chat link was not visible, so it was not saved', 'err');
    const data = extractJson(r.text);
    if (!data) { box.replaceChildren(card(lead, null, r)); log('ChatGPT answered without the JSON block. Read the answer below, or ask it again.', 'err'); return false; }
    box.replaceChildren(card(lead, data, r));
    return true;
  } catch (e) { box.replaceChildren(el('div', { class: 'card err' }, e.message)); log(e.message, 'err'); return false; }
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
  const skipBtn = el('button', { onclick: () => { document.getElementById('lead' + lead.id)?.remove(); $('work-area').replaceChildren(); log(`Skipped ${lead.first_name} ${lead.last_name} (nothing saved)`); } }, 'Skip, do not save');
  const saveBtn = el('button', { class: 'primary', onclick: async () => {
    saveBtn.disabled = true;
    try {
      const body = { verdict: verdict.value, reason: reason.value, assessment: assessment.value, why_in_pipeline: why.value, todays_question: d.todays_question || '', next_action: next.value, next_action_days: Number(days.value), denial_reason: d.denial_reason || '', quality: qualitySel.value, lead_category: categorySel.value, channel: channelSel.value, outreach_status: d.outreach_status || '', research_summary: d.research_summary || '', checked: [...new Set([...(d.checked || []), ...(deepInfo[lead.id]?.checked || [])])],
        links: [...(d.links || []), ...(deepInfo[lead.id]?.links || [])], drafts: drafts.map((z) => ({ channel: z.x.channel, subject: z.subject.value, body: z.body.value, target_url: z.target.value, note: z.x.note || '' })) };
      const res = await crm('POST', `/api/leads/${lead.id}/ai-result`, body);
      log(`Saved ${lead.first_name} ${lead.last_name}: ${res.verdict}${res.dropdowns?.quality ? ', type ' + res.dropdowns.quality : ''}, ${res.drafts} drafts, ${res.links} links${res.skipped.length ? ', skipped: ' + res.skipped.join('; ') : ''}`, 'ok');
      const saved = res.saved || [];
      out.replaceChildren(el('div', { class: 'ok' }, `Saved to the CRM (${res.drafts} drafts, ${res.links} links). Nothing was sent.`), ...quickLinks(lead, saved),
        ['PURSUE', 'QUALIFY'].includes(res.verdict) ? el('div', { class: 'row' }, el('button', { onclick: async (ev) => { try { await crm('POST', `/api/leads/${lead.id}/ceo-submit`, { note: body.reason }); ev.target.disabled = true; ev.target.textContent = 'Sent to CEO'; log(`${lead.first_name} ${lead.last_name} sent to the CEO`, 'ok'); } catch (e) { log(e.message, 'err'); } } }, 'Send lead to CEO')) : null,
        el('div', { class: 'muted' }, d.needs_human ? 'Check by hand: ' + d.needs_human : ''));
      refreshTargets();
      saveBtn.remove(); skipBtn.remove(); document.getElementById('lead' + lead.id)?.remove();
    } catch (e) { saveBtn.disabled = false; log(e.message, 'err'); out.replaceChildren(el('div', { class: 'err' }, e.message)); }
  } }, 'Save to CRM');
  return el('div', { class: 'card' },
    el('div', { class: 'row' }, el('b', {}, `${lead.first_name} ${lead.last_name}`), verdict, !data ? el('span', { class: 'chip SKIP' }, 'No JSON block found') : null),
    data ? el('div', {}, 'Reason', reason, 'Assessment line', assessment, 'Why in pipeline', why, el('div', { class: 'row' }, 'Next action', next, 'in days', days), el('div', { class: 'row' }, 'Lead type', qualitySel, 'Category', categorySel, 'Channel', channelSel),
      links ? el('div', {}, el('div', { class: 'muted' }, 'Links to add'), el('pre', {}, links)) : null,
      ...drafts.map((z) => el('div', { class: 'card' }, el('span', { class: 'chip' }, z.x.channel), z.x.channel === 'email' ? z.subject : null, z.body, ['linkedin_comment', 'linkedin_comment_reply', 'website_contact'].includes(z.x.channel) ? z.target : null,
        z.x.channel === 'linkedin_connect' ? el('div', { class: 'muted' }, 'Connection note limit: 300 characters') : null)),
      d.needs_human ? el('div', { class: 'muted' }, 'Check by hand: ' + d.needs_human) : null, el('div', { class: 'row' }, saveBtn, skipBtn)) : el('div', { class: 'row' }, skipBtn),
    out, el('details', {}, el('summary', {}, 'Full ChatGPT answer'), el('pre', { style: 'white-space:pre-wrap' }, r.text || '')));
}

// Quick links for the human step. The extension opens pages; you review and press send yourself.
function quickLinks(lead, drafts) {
  const rows = [];
  const li = (u) => (/^https?:/i.test(u) ? u : 'https://' + u);
  for (const d of drafts) {
    const buttons = [el('button', { onclick: () => { navigator.clipboard.writeText((d.channel === 'email' && d.subject ? 'Subject: ' + d.subject + '\n\n' : '') + d.body); log('Draft copied', 'ok'); } }, 'Copy text')];
    if (d.channel === 'email' && lead.email) buttons.push(el('a', { class: 'btn', target: '_blank', href: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.email)}&su=${encodeURIComponent(d.subject || '')}&body=${encodeURIComponent(d.body)}` }, 'Open Gmail draft'));
    if (['linkedin_connect', 'linkedin_dm', 'linkedin_followup', 'linkedin_inmail'].includes(d.channel) && lead.linkedin) buttons.push(el('a', { class: 'btn', target: '_blank', href: li(lead.linkedin) }, 'Open profile'));
    if (d.target_url) buttons.push(el('a', { class: 'btn', target: '_blank', href: d.target_url }, d.channel === 'website_contact' ? 'Open the form' : 'Open the post'));
    if (d.id) buttons.push(el('button', { class: 'primary', title: 'Press only after you really sent it', onclick: async (ev) => { if (!confirm('Did you really send this? This logs it as sent in the CRM.')) return; let evidence = ''; if (d.channel === 'website_contact') { evidence = prompt('Paste the confirmation the website showed:') || ''; if (evidence.trim().length < 5) return; } try { await crm('POST', `/api/leads/drafts/${d.id}/sent`, { evidence }); ev.target.disabled = true; ev.target.textContent = 'Logged as sent'; log('Logged as sent', 'ok'); refreshTargets(); } catch (e) { log(e.message, 'err'); } } }, 'Mark sent'));
    rows.push(el('div', { class: 'row' }, el('span', { class: 'chip' }, d.channel), ...buttons));
  }
  return rows;
}

async function runBatch() {
  stop = false;
  const total = leads.length; let i = 0;
  for (const l of [...leads]) {
    if (stop) break;
    batchInfo = `Lead ${++i} of ${total}`;
    const ok = await researchOne(l);
    if (!ok) break; // stop at the first problem so a person looks at it
    // wait for the person to save or skip this lead before moving on
    await new Promise((res) => { const t = setInterval(() => { if (!document.getElementById('lead' + l.id) || stop) { clearInterval(t); res(); } }, 800); });
    if (stop) break;
    log(`Waiting ${cfg.pause}s before the next lead`); await sleep(Math.max(5, Number(cfg.pause) || 30) * 1000 + Math.random() * 8000);
  }
  batchInfo = ''; setStatus(''); log('Batch finished or stopped');
}
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
loadCfg();
