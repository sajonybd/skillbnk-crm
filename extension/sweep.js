// Daily sweep: ONE look at the pages that show what changed, instead of opening every lead.
//   1) LinkedIn "sent invitations": who is still pending. Leads that are no longer pending get one profile check (1st degree = accepted).
//   2) LinkedIn messaging list: threads where the lead wrote last or that are unread.
//   3) Webmail inbox (added after the layout is checked).
// Read-only. It never clicks Connect, Message or Send, and it stops with a note if a site asks you to sign in.
// Needs the globals of sidepanel.js (cfg, crm, log, sleep, el, $).
const humanPause = (a = 8000, b = 25000) => sleep(a + Math.random() * (b - a));
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const slugOf = (u) => (/linkedin\.com\/in\/([^/?#]+)/i.exec(u || '') || [])[1]?.toLowerCase().replace(/\/$/, '') || '';

async function openBg(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await new Promise((res) => { const f = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(f); res(); } }; chrome.tabs.onUpdated.addListener(f); setTimeout(res, 20000); });
  await sleep(2500 + Math.random() * 2000); // let the page draw
  return tab.id;
}
const runIn = async (tabId, func, args = []) => (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0]?.result;
const needSignIn = (url) => /\/(login|uas\/login|checkpoint|authwall)/i.test(url);

// ── functions that run inside the LinkedIn page ──
async function pageReadSent() {
  const url = location.href; if (/\/(login|uas\/login|checkpoint|authwall)/i.test(url)) return { signin: true };
  for (let i = 0; i < 6; i++) { window.scrollBy(0, 1400); await new Promise((r) => setTimeout(r, 900 + Math.random() * 600)); }
  const slugs = [...new Set([...document.querySelectorAll('a[href*="/in/"]')].map((a) => (/\/in\/([^/?#]+)/.exec(a.href) || [])[1]).filter(Boolean).map((s) => s.toLowerCase()))];
  return { url, slugs, tab: /sent/i.test(url) };
}
function pageReadDegree() {
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  const top = (document.querySelector('main')?.innerText || document.body.innerText || '').slice(0, 900);
  const m = /(?:^|[\s·•])(1st|2nd|3rd)\b/.exec(top);
  const pending = /\bPending\b/.test(top);
  return { degree: m ? m[1] : '', pending };
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
  const out = $('sweep-out'); const say = (m, c = '') => { log(m, c); out.prepend(el('div', { class: c }, m)); };
  try {
    out.replaceChildren(); say('Sweep started: loading leads from the CRM');
    const lists = {};
    for (const w of ['invited', 'message', 'followup', 'replied']) { const q = new URLSearchParams({ work: w, limit: '200' }); if (cfg.owner === 'me') q.set('owner', 'me'); lists[w] = (await crm('GET', '/api/leads?' + q)).rows; }
    const all = Object.values(lists).flat();
    const bySlug = new Map(all.map((l) => [slugOf(l.linkedin), l]).filter(([s]) => s));
    const byName = new Map(all.map((l) => [norm(`${l.first_name} ${l.last_name}`), l]).filter(([n]) => n.length > 3));
    const signals = [];

    // 1) invitations still pending
    say(`Reading the sent invitations page (${lists.invited.length} leads are waiting on an invite)`);
    let tabId = await openBg('https://www.linkedin.com/mynetwork/invitation-manager/sent/');
    let sent = await runIn(tabId, pageReadSent); await chrome.tabs.remove(tabId).catch(() => {});
    if (sent?.signin) { say('LinkedIn asks you to sign in. Sign in in this Chrome and run the sweep again.', 'err'); return; }
    const pending = new Set(sent?.slugs || []);
    if (!pending.size) say('The sent invitations page showed no people. It may not have loaded, so I will not treat leads as accepted.', 'err');
    const verify = [];
    for (const l of lists.invited) { const s = slugOf(l.linkedin); if (!s) continue; if (pending.has(s)) signals.push({ lead_id: l.id, type: 'invite_pending' }); else if (pending.size) verify.push(l); }
    say(`${pending.size} invitations still pending. ${verify.length} leads are no longer in the list: checking up to 10 profiles one by one`);
    for (const l of verify.slice(0, 10)) {
      await humanPause();
      tabId = await openBg(`https://www.linkedin.com/in/${slugOf(l.linkedin)}/`);
      const d = await runIn(tabId, pageReadDegree); await chrome.tabs.remove(tabId).catch(() => {});
      if (d?.signin) { say('LinkedIn asked you to sign in during the profile checks. Stopping.', 'err'); break; }
      if (d?.degree === '1st') signals.push({ lead_id: l.id, type: 'invite_accepted', text: 'Now a 1st-degree connection' });
      else say(`${l.first_name} ${l.last_name}: no longer pending and not connected (${d?.degree || 'unknown'}). Probably withdrawn or expired. Not changed.`);
    }

    // 2) messaging list
    await humanPause(6000, 15000);
    say('Reading the LinkedIn messaging list');
    tabId = await openBg('https://www.linkedin.com/messaging/');
    const inbox = await runIn(tabId, pageReadInbox); await chrome.tabs.remove(tabId).catch(() => {});
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

    // 3) webmail: added after its layout is checked
    const res = signals.length ? await crm('POST', '/api/leads/signals', { items: signals }) : { marked: 0, skipped: [] };
    say(`Done. ${res.marked} leads marked "needs review"${res.skipped.length ? ', ' + res.skipped.length + ' already reported or skipped' : ''}. Choose "Changed since last check" in Settings and press Load leads.`, 'ok');
  } catch (e) { say('Sweep stopped: ' + e.message, 'err'); }
}
$('sweep').onclick = runSweep;
