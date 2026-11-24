// Per-lead deep check: website (several pages), LinkedIn profile (degree), the message thread if 1st degree, and email history in webmail.
// Read-only and paced like a person. Anything that cannot be read is reported as "not checked", never guessed.
// Needs globals from sidepanel.js and sweep.js (openBg, runIn, humanPause, norm, slugOf, cfg, log, sleep).
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const today10 = () => new Date().toISOString().slice(0, 10);

// ── page functions (run inside the page) ──
function pageReadSite() {
  const a = [...document.querySelectorAll('a[href]')].map((x) => ({ h: x.href.split('#')[0], t: (x.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) })).filter((x) => /^https?:/i.test(x.h));
  const emails = [...new Set((document.body.innerText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).concat(a.filter((x) => /^mailto:/i.test(x.h)).map((x) => x.h.replace(/^mailto:/i, ''))))].slice(0, 6);
  return { title: document.title, text: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 2600), links: a.slice(0, 400), emails };
}
function pageReadProfile() {
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  const top = (document.querySelector('main')?.innerText || document.body.innerText || '').replace(/\n{2,}/g, '\n');
  const m = /(?:^|[\s·•])(1st|2nd|3rd)\b/.exec(top.slice(0, 900));
  return { degree: m ? m[1] : '', pending: /\bPending\b/.test(top.slice(0, 900)), top: top.slice(0, 1400) };
}
async function pageReadThread(name) {
  const sleepp = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  await sleepp(2000);
  const input = document.querySelector('input[placeholder*="Search messages" i], input[aria-label*="Search messages" i], input[type="search"]');
  if (!input) return { error: 'search box not found on the messaging page' };
  input.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleepp(2500);
  const first = document.querySelector('.msg-conversation-listitem__link, li[class*="msg-conversation-listitem"] a, [class*="msg-search-pill"]');
  if (!first) return { none: true };
  first.click(); await sleepp(2500);
  const list = document.querySelector('.msg-s-message-list, [class*="msg-s-message-list-content"], .msg-s-message-list-container');
  if (!list) return { error: 'thread did not open' };
  return { text: list.innerText.replace(/\n{2,}/g, '\n').slice(-3500) };
}
async function pageReadMailSearch() {
  if (/\/login/i.test(location.href)) return { signin: true };
  const t = (c, q) => (c.querySelector(q)?.innerText || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 30 && ![...document.querySelectorAll('.msc-entry-card .spm-card__title')].some((x) => x.innerText.trim()); i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 800));
  return { rows: [...document.querySelectorAll('.msc-entry-card')].filter((c) => t(c, '.spm-card__title')).slice(0, 12).map((c) => ({ from: t(c, '.spm-card__title'), subject: t(c, '.spm-card__subtitle'), snippet: t(c, '.spm-card__content').slice(0, 140), date: t(c, '.spm-card__date') })) };
}

// ── the check ──
const PAGE_HINT = /about|program|course|training|class|pricing|price|enroll|contact|team|services|certif/i;
const LMS_HINT = /thinkific|teachable|kajabi|learnworlds|moodle|canvas|docebo|talentlms|ispring|podia|coursera|udemy|enrollware|learndash|absorb|litmos|lessonly|mindflash|northpass|skillshare|stripe\.com|paypal|square|acuity|calendly|cal\.com|hubspot|typeform|jotform|wufoo/i;

async function checkWebsite(lead) {
  if (!lead.website) return { text: 'WEBSITE: no website in the CRM.', ok: false };
  const url = /^https?:/i.test(lead.website) ? lead.website : 'https://' + lead.website;
  let tabId = await openBg(url); const home = await runIn(tabId, pageReadSite); await chrome.tabs.remove(tabId).catch(() => {});
  if (!home) return { text: `WEBSITE: could not open ${url}.`, ok: false };
  const host = hostOf(url); const seen = new Set([url]); const pages = [{ url, ...home }];
  const next = home.links.filter((x) => hostOf(x.h) === host && PAGE_HINT.test(x.h + ' ' + x.t)).map((x) => x.h).filter((h) => !seen.has(h) && seen.add(h)).slice(0, 3);
  for (const u of next) { await humanPause(3000, 8000); tabId = await openBg(u); const p = await runIn(tabId, pageReadSite); await chrome.tabs.remove(tabId).catch(() => {}); if (p) pages.push({ url: u, ...p }); }
  const links = pages.flatMap((p) => p.links);
  const uniq = (xs) => [...new Map(xs.map((x) => [x.h, x])).values()];
  const book = uniq(links.filter((x) => /calendly\.com|cal\.com|savvycal|tidycal|zcal\.co|youcanbook|setmore|acuityscheduling|meetings\.hubspot|\/book(ing)?\b/i.test(x.h))).slice(0, 5);
  const contact = uniq(links.filter((x) => hostOf(x.h) === host && /contact|get-in-touch/i.test(x.h + ' ' + x.t))).slice(0, 3);
  const tools = uniq(links.filter((x) => hostOf(x.h) !== host && LMS_HINT.test(hostOf(x.h)))).slice(0, 8);
  const emails = [...new Set(pages.flatMap((p) => p.emails))].slice(0, 6);
  const fmt = (xs) => (xs.length ? xs.map((x) => `${x.t || '-'} ${x.h}`).join('\n  ') : 'none seen');
  return { ok: true, book, contact, text: `WEBSITE (${pages.length} pages read: ${pages.map((p) => p.url).join(', ')}):\nBooking links:\n  ${fmt(book)}\nContact page links:\n  ${fmt(contact)}\nPlatform / payment / form links seen (read where each Enroll, Buy, Login and Book button goes):\n  ${fmt(tools)}\nEmails seen: ${emails.join(', ') || 'none'}\n${pages.map((p) => `--- ${p.url}\n${p.text.slice(0, 1600)}`).join('\n')}` };
}

async function checkLinkedIn(lead) {
  const s = slugOf(lead.linkedin); if (!s) return { text: 'LINKEDIN: no profile link in the CRM.', ok: false };
  let tabId = await openBg(`https://www.linkedin.com/in/${s}/`); const p = await runIn(tabId, pageReadProfile); await chrome.tabs.remove(tabId).catch(() => {});
  if (!p || p.signin) return { text: 'LINKEDIN: not checked (sign-in needed).', ok: false, signin: true };
  let out = `LINKEDIN PROFILE: connection ${p.degree || 'unknown'}${p.pending ? ', invite pending' : ''}.\n${p.top}`;
  if (p.degree !== '1st') return { text: out + '\nMessages: not connected, so no conversation to read.', ok: true, degree: p.degree };
  await humanPause(4000, 10000);
  tabId = await openBg('https://www.linkedin.com/messaging/');
  const name = `${lead.first_name} ${lead.last_name}`.trim();
  const t = await runIn(tabId, pageReadThread, [name]); await chrome.tabs.remove(tabId).catch(() => {});
  if (t?.text) out += `\nLINKEDIN CONVERSATION (latest part):\n${t.text}`;
  else out += `\nLINKEDIN CONVERSATION: not read (${t?.signin ? 'sign-in needed' : t?.none ? 'no thread found' : t?.error || 'unknown'}). A person must open the inbox before anything is sent.`;
  return { text: out, ok: true, degree: p.degree, thread: !!t?.text };
}

async function checkMail(lead) {
  const q = lead.email || `${lead.last_name || lead.company || ''}`.trim();
  if (!q) return { text: 'EMAIL: no address or name to search.', ok: false };
  const tabId = await openBg('https://privateemail.com/spm/mail/INBOX/?search=' + encodeURIComponent(q));
  const m = await runIn(tabId, pageReadMailSearch); await chrome.tabs.remove(tabId).catch(() => {});
  if (!m || m.signin) return { text: 'EMAIL: not checked (webmail sign-in needed).', ok: false, signin: true };
  if (!m.rows.length) return { text: `EMAIL: no messages found for "${q}".`, ok: true };
  const own = /shiblu|skillbnk/i;
  const lines = m.rows.slice(0, 8).map((r) => `- ${r.date} | ${own.test(r.from) ? 'WE WROTE' : 'THEY WROTE'} (${r.from.slice(0, 28)}) | ${r.subject.slice(0, 80)}`);
  return { text: `EMAIL HISTORY for "${q}" (${m.rows.length} found, newest first; open the thread yourself for full text):\n${lines.join('\n')}`, ok: true };
}

// Runs all four checks one after another with human pauses. Returns { text, checked: [...] } to put into the prompt.
async function deepCheck(lead, say = log) {
  const parts = []; const checked = [];
  const step = async (label, src, fn) => { say(`${lead.first_name} ${lead.last_name}: ${label}`); try { const r = await fn(lead); parts.push(r.text); if (r.ok) checked.push(src); return r; } catch (e) { parts.push(`${label}: not checked (${e.message}).`); return { ok: false }; } finally { await humanPause(2500, 7000); } };
  const w = await step('reading the website', 'website', checkWebsite);
  const l = await step('checking the LinkedIn profile', 'linkedin', checkLinkedIn);
  const m = await step('searching webmail', 'email', checkMail);
  if (l.thread) checked.push('inbox');
  return { text: `AUTO CHECK by the extension on ${today10()} (read-only):\n` + parts.join('\n\n'), checked, website: w, linkedin: l, mail: m };
}
