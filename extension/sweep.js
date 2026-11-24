// Daily sweep: ONE look at the pages that show what changed, instead of opening every lead.
//   1) LinkedIn "sent invitations": who is still pending. Leads that are no longer pending get one profile check (1st degree = accepted).
//   2) LinkedIn messaging list: threads where the lead wrote last or that are unread.
//   3) Webmail inbox (added after the layout is checked).
// Read-only. It never clicks Connect, Message or Send, and it stops with a note if a site asks you to sign in.
// Needs the globals of sidepanel.js (cfg, crm, log, sleep, el, $).
const humanPause = async (a = 8000, b = 25000) => { const ms = a + Math.random() * (b - a); liveNote(`Waiting ${Math.round(ms / 1000)}s, like a person would`); await sleep(ms); checkStop(); };
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const slugOf = (u) => (/linkedin\.com\/in\/([^/?#]+)/i.exec(u || '') || [])[1]?.toLowerCase().replace(/\/$/, '') || '';

// Each site has its own steady tab in the work window (LinkedIn, Email, Website). They are reused, never closed, and do not steal your focus.
async function openBg(url) {
  checkStop(); const key = tabKeyOf(url); liveNote(`${TAB_NAMES[key]} tab: opening ` + url.replace(/^https?:\/\//, '').slice(0, 60));
  const tab = await siteTab(key, url);
  await new Promise((res) => { const f = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(f); res(); } }; chrome.tabs.onUpdated.addListener(f); setTimeout(res, 20000); });
  await sleep(2500 + Math.random() * 2000); // let the page draw
  return tab.id;
}
const runIn = async (tabId, func, args = []) => (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0]?.result;
const needSignIn = (url) => /\/(login|uas\/login|checkpoint|authwall)/i.test(url);

// ── functions that run inside the LinkedIn page ──
async function pageReadSent(needDays) {
  const url = location.href; if (/\/(login|uas\/login|checkpoint|authwall)/i.test(url)) return { signin: true };
  const ageDays = (t) => { const m = /Sent (?:(\d+|a|an) )?(minute|hour|day|week|month|year)s? ago|Sent (yesterday)/i.exec(t || ''); if (!m) return null; if (m[3]) return 1; const n = /^\d+$/.test(m[1] || '') ? Number(m[1]) : 1; return n * { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()]; };
  const read = () => [...document.querySelectorAll('main li, main [role="listitem"]')].map((li) => ({ slug: ((/\/in\/([^/?#]+)/.exec(li.querySelector('a[href*="/in/"]')?.href || '') || [])[1] || '').toLowerCase(), age: ageDays(li.innerText) })).filter((x) => x.slug);
  const total = Number((/People\s+([\d,]+)/.exec(document.body.innerText) || [])[1]?.replace(/,/g, '')) || 0; // LinkedIn prints "People 1,597"
  let rows = read(), same = 0;
  for (let i = 0; i < 80; i++) {
    const oldest = Math.max(0, ...rows.map((r) => r.age ?? 0));
    if (oldest >= needDays) break;
    // Infinite scroll only fires when the last row comes into view; also press a "show more" button if there is one.
    const items = [...document.querySelectorAll('main li, main [role="listitem"]')];
    items[items.length - 1]?.scrollIntoView({ block: 'end' }); window.scrollTo(0, document.body.scrollHeight);
    const more = [...document.querySelectorAll('main button')].find((b) => /^(show|load) more/i.test((b.innerText || '').trim())); more?.click();
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
    const next = read(); same = next.length === rows.length ? same + 1 : 0; rows = next; if (same >= 6) break;
  }
  // "Whole list read" is only true when we have (nearly) every person LinkedIn says is there.
  const exhausted = total > 0 && rows.length >= total - 3;
  return { url, slugs: [...new Set(rows.map((r) => r.slug))], reachDays: Math.max(0, ...rows.map((r) => r.age ?? 0)), exhausted, total, loaded: rows.length };
}
function pageReadDegree() {
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  const top = (document.querySelector('main')?.innerText || document.body.innerText || '').slice(0, 900);
  const m = /(?:^|[\s·•])(1st|2nd|3rd)\b/.exec(top);
  const pending = [...document.querySelectorAll('main button, main a')].some((b) => /^\s*pending\s*$/i.test(b.innerText || b.getAttribute('aria-label') || '')) || /\bPending\b/.test(top);
  return { degree: m ? m[1] : '', pending };
}
async function pageReadMail() {
  if (/\/login/i.test(location.href)) return { signin: true };
  for (let i = 0; i < 30 && ![...document.querySelectorAll('.msc-entry-card .spm-card__title')].some((x) => x.innerText.trim()); i++) await new Promise((r) => setTimeout(r, 500)); // wait past the grey loading rows
  const t = (c, q) => (c.querySelector(q)?.innerText || '').replace(/\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('.msc-entry-card')].slice(0, 40).filter((c) => t(c, '.spm-card__title')).map((c) => ({ from: t(c, '.spm-card__title'), subject: t(c, '.spm-card__subtitle'), snippet: t(c, '.spm-card__content'), date: t(c, '.spm-card__date'), unread: c.classList.contains('spm-card--new') }));
  return { rows };
}
async function pageReadInbox() {
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  await new Promise((r) => setTimeout(r, 1500));
  const items = [...document.querySelectorAll('li.msg-conversation-listitem, li[class*="msg-conversation-listitem"], li[class*="msg-conversations-container"]')];
  const rows = items.slice(0, 60).map((li) => {
    const name = (li.querySelector('[class*="participant-names"], h3')?.innerText || '').trim();
    const snippet = (li.querySelector('[class*="message-snippet"], p')?.innerText || '').replace(/\s+/g, ' ').trim();
    const unread = !!li.querySelector('[class*="notification-badge--show"], [class*="unread"]') || /unread/i.test(li.innerText);
    return { name, snippet, unread };
  }).filter((r) => r.name);
  return { rows, found: items.length };
}

async function runSweep() {
  const ok = await chrome.permissions.request({ origins: ['https://www.linkedin.com/*'] });
  if (!ok) { log('Permission to read LinkedIn pages was declined', 'err'); return; }
  const out = $('sweep-out'); const say = (m, c = '') => { log(m, c); liveNote(m); out.prepend(el('div', { class: c }, m)); };
  livePlan('Daily sweep', ['Load leads from the CRM', 'LinkedIn sent invitations (who is still pending)', 'Check profiles of leads missing from that list', 'LinkedIn messaging list', 'Webmail inbox', 'Send the changes to the CRM']);
  try {
    out.replaceChildren(); liveAt(0); say('Sweep started: loading leads from the CRM');
    const lists = {};
    for (const w of ['invited', 'message', 'followup', 'replied', 'engage']) { const q = new URLSearchParams({ work: w, limit: '200' }); if (cfg.owner === 'me') q.set('owner', 'me'); lists[w] = (await crm('GET', '/api/leads?' + q)).rows; }
    const all = Object.values(lists).flat();
    const bySlug = new Map(all.map((l) => [slugOf(l.linkedin), l]).filter(([s]) => s));
    const byName = new Map(all.map((l) => [norm(`${l.first_name} ${l.last_name}`), l]).filter(([n]) => n.length > 3));
    const signals = [];

    // 1) invitations still pending
    liveAt(1); say(`Reading the sent invitations page (${lists.invited.length} leads are waiting on an invite)`);
    let tabId = await openBg('https://www.linkedin.com/mynetwork/invitation-manager/sent/');
    const ageOf = (l) => (l.invite_sent_date ? Math.max(0, Math.round((Date.now() - Date.parse(l.invite_sent_date)) / 86400000)) : 0);
    const needDays = Math.min(60, Math.max(1, ...lists.invited.map(ageOf)));
    let sent = await runIn(tabId, pageReadSent, [needDays]);
    if (sent?.signin) { say('LinkedIn asks you to sign in. Sign in in this Chrome and run the sweep again.', 'err'); return; }
    const pending = new Set(sent?.slugs || []);
    if (!pending.size) say('The sent invitations page showed no people. It may not have loaded, so I will not treat leads as accepted.', 'err');
    const verify = [];
    // The list is newest first and very long. Only an invite newer than the oldest one loaded can be judged "no longer pending".
    const reach = sent?.reachDays ?? 0; let beyond = 0;
    for (const l of lists.invited) { const s = slugOf(l.linkedin); if (!s) continue; if (pending.has(s)) signals.push({ lead_id: l.id, type: 'invite_pending' }); else if (pending.size && (sent.exhausted || ageOf(l) < reach)) verify.push(l); else if (pending.size) beyond++; }
    say(`${pending.size} of ${sent?.total || '?'} invitations loaded (back ${reach} days${sent?.exhausted ? ', whole list' : ', partial list'}). ${verify.length} leads are no longer in the list: checking up to 10 profiles one by one.${beyond ? ' ' + beyond + ' older invites were out of reach, not judged.' : ''}`);
    liveAt(2, `Checking ${Math.min(10, verify.length)} profiles one by one`);
    for (const l of verify.slice(0, 10)) {
      await humanPause();
      liveNote(`Profile: ${l.first_name} ${l.last_name}`);
      tabId = await openBg(`https://www.linkedin.com/in/${slugOf(l.linkedin)}/`);
      const d = await runIn(tabId, pageReadDegree);
      if (d?.signin) { say('LinkedIn asked you to sign in during the profile checks. Stopping.', 'err'); break; }
      if (d?.degree === '1st') signals.push({ lead_id: l.id, type: 'invite_accepted', text: 'Now a 1st-degree connection' });
      else if (d?.pending) { signals.push({ lead_id: l.id, type: 'invite_pending' }); say(`${l.first_name} ${l.last_name}: invite still pending (the profile shows Pending)`); }
      else say(`${l.first_name} ${l.last_name}: no longer pending and not connected (${d?.degree || 'unknown'}). Probably withdrawn or expired. Not changed.`);
    }

    // 2) messaging list
    await humanPause(6000, 15000);
    liveAt(3); say('Reading the LinkedIn messaging list');
    tabId = await openBg('https://www.linkedin.com/messaging/');
    const inbox = await runIn(tabId, pageReadInbox);
    if (inbox?.signin) say('LinkedIn asks you to sign in for messaging. Skipped.', 'err');
    else if (!inbox?.rows?.length) say('Could not read the messaging list (the page layout may have changed). Skipped.', 'err');
    else {
      let hits = 0;
      for (const r of inbox.rows) {
        const l = byName.get(norm(r.name)); if (!l) continue;
        const mine = /^you:/i.test(r.snippet);
        if (r.unread || (!mine && r.snippet)) { signals.push({ lead_id: l.id, type: 'new_message', text: r.snippet.slice(0, 200) }); hits++; }
      }
      say(`Messaging: ${inbox.rows.length} threads read, ${hits} from leads need a look`);
    }

    // 3) webmail inbox (Namecheap PrivateEmail). Only unread mail from a lead's name counts.
    await humanPause(5000, 12000);
    liveAt(4); say('Reading the webmail inbox');
    tabId = await openBg('https://privateemail.com/spm/mail/INBOX/');
    const mail = await runIn(tabId, pageReadMail);
    if (mail?.signin) say('Webmail asks you to sign in. Skipped.', 'err');
    else if (!mail?.rows?.length) say('Could not read the webmail inbox. Skipped.', 'err');
    else {
      let hits = 0;
      for (const r of mail.rows) {
        if (!r.unread) continue;
        const n = norm(r.from); const l = byName.get(n) || all.find((x) => x.email && `${r.subject} ${r.snippet}`.toLowerCase().includes(x.email.toLowerCase()));
        if (l) { signals.push({ lead_id: l.id, type: 'email_reply', text: `${r.subject} (${r.date})`.slice(0, 200) }); hits++; }
      }
      say(`Webmail: ${mail.rows.length} messages read, ${hits} unread from leads`);
    }
    liveAt(5, 'Sending the changes to the CRM');
    const res = signals.length ? await crm('POST', '/api/leads/signals', { items: signals }) : { marked: 0, skipped: [] };
    say(`Done. ${res.marked} leads marked "needs review"${res.skipped.length ? ', ' + res.skipped.length + ' already reported or skipped' : ''}. Choose "Changed since last check" in Settings and press Load leads.`, 'ok'); liveEnd('Sweep finished');;
  } catch (e) { say('Sweep stopped: ' + e.message, 'err'); liveEnd('Stopped: ' + e.message); }
}
$('sweep').onclick = runSweep;
