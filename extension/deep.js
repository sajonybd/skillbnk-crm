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
  return { degree: m ? m[1] : '', pending: [...document.querySelectorAll('main button, main a')].some((b) => /^\s*pending\s*$/i.test(b.innerText || '')) || /\bPending\b/.test(top.slice(0, 900)), top: top.slice(0, 1400) };
}
async function pageReadActivity() {
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  await new Promise((r) => setTimeout(r, 2500));
  window.scrollBy(0, 900); await new Promise((r) => setTimeout(r, 1200));
  const body = (document.querySelector('main')?.innerText || document.body.innerText || '');
  if (/hasn.t posted yet|no recent activity|nothing to see yet/i.test(body)) return { none: true };
  const posts = [...document.querySelectorAll('[data-urn], .feed-shared-update-v2, [class*="feed-shared-update"]')].slice(0, 4).map((p) => {
    const t = (p.innerText || '').replace(/\s+/g, ' ').trim();
    const age = (/(?:^|\s)(\d+)\s?(h|d|w|mo|yr)\b/.exec(t) || [])[0]?.trim() || '';
    return { age, text: t.slice(0, 180) };
  }).filter((x) => x.text);
  // fall back to the first "3w" or "2mo" style marker on the page
  const first = posts[0]?.age || (/(?:^|\s)(\d+)\s?(h|d|w|mo|yr)\b/.exec(body) || [])[0]?.trim() || '';
  return { posts, first };
}
async function pageReadThread(name, slug) {
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
  // Two people can share a name: confirm the open thread links to this lead's profile.
  const pageSlugs = [...document.querySelectorAll('a[href*="/in/"]')].map((a) => ((/\/in\/([^/?#]+)/.exec(a.href) || [])[1] || '').toLowerCase()).filter(Boolean);
  const verified = slug ? (pageSlugs.length ? pageSlugs.includes(slug) : null) : null;
  return { text: list.innerText.replace(/\n{2,}/g, '\n').slice(-3500), verified };
}
async function pageReadMailSearch() {
  if (/\/login/i.test(location.href)) return { signin: true };
  const t = (c, q) => (c.querySelector(q)?.innerText || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 30 && ![...document.querySelectorAll('.msc-entry-card .spm-card__title')].some((x) => x.innerText.trim()); i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 800));
  return { rows: [...document.querySelectorAll('.msc-entry-card')].filter((c) => t(c, '.spm-card__title')).slice(0, 12).map((c) => ({ from: t(c, '.spm-card__title'), subject: t(c, '.spm-card__subtitle'), snippet: t(c, '.spm-card__content').slice(0, 140), date: t(c, '.spm-card__date'), folder: t(c, '.spm-card__folder') })) };
}

// ── the check ──
const PAGE_HINT = /about|program|course|training|class|pricing|price|enroll|contact|team|services|certif/i;
const LMS_HINT = /thinkific|teachable|kajabi|learnworlds|moodle|canvas|docebo|talentlms|ispring|podia|coursera|udemy|enrollware|learndash|absorb|litmos|lessonly|mindflash|northpass|skillshare|stripe\.com|paypal|square|acuity|calendly|cal\.com|hubspot|typeform|jotform|wufoo/i;

async function checkWebsite(lead) {
  if (!lead.website) return { text: 'WEBSITE: no website in the CRM.', ok: false };
  const url = /^https?:/i.test(lead.website) ? lead.website : 'https://' + lead.website;
  let tabId = await openBg(url); const home = await runIn(tabId, pageReadSite);
  if (!home) return { text: `WEBSITE: could not open ${url}.`, ok: false };
  const host = hostOf(url); const seen = new Set([url]); const pages = [{ url, ...home }];
  const next = home.links.filter((x) => hostOf(x.h) === host && PAGE_HINT.test(x.h + ' ' + x.t)).map((x) => x.h).filter((h) => !seen.has(h) && seen.add(h)).slice(0, 3);
  for (const u of next) { await humanPause(3000, 8000); tabId = await openBg(u); const p = await runIn(tabId, pageReadSite); if (p) pages.push({ url: u, ...p }); }
  const links = pages.flatMap((p) => p.links);
  const uniq = (xs) => [...new Map(xs.map((x) => [x.h, x])).values()];
  const book = uniq(links.filter((x) => /calendly\.com|cal\.com|savvycal|tidycal|zcal\.co|youcanbook|setmore|acuityscheduling|meetings\.hubspot|\/book(ing)?\b/i.test(x.h))).slice(0, 5);
  const contact = uniq(links.filter((x) => hostOf(x.h) === host && /contact|get-in-touch/i.test(x.h + ' ' + x.t))).slice(0, 3);
  const tools = uniq(links.filter((x) => hostOf(x.h) !== host && LMS_HINT.test(hostOf(x.h)))).slice(0, 8);
  const emails = [...new Set(pages.flatMap((p) => p.emails))].slice(0, 6);
  const fmt = (xs) => (xs.length ? xs.map((x) => `${x.t || '-'} ${x.h}`).join('\n  ') : 'none seen');
  const toolNames = [...new Set(tools.map((x) => hostOf(x.h)))].slice(0, 5).join(', ') || 'none';
  const note = `Auto read of ${pages.length} page${pages.length === 1 ? '' : 's'} on ${host}. Booking links: ${book.length}. Contact page: ${contact.length}. Platform/payment links: ${toolNames}. Emails seen: ${emails.length}.`;
  return { ok: true, book, contact, note, text: `WEBSITE (${pages.length} pages read: ${pages.map((p) => p.url).join(', ')}):\nBooking links:\n  ${fmt(book)}\nContact page links:\n  ${fmt(contact)}\nPlatform / payment / form links seen (read where each Enroll, Buy, Login and Book button goes):\n  ${fmt(tools)}\nEmails seen: ${emails.join(', ') || 'none'}\n${pages.map((p) => `--- ${p.url}\n${p.text.slice(0, 1600)}`).join('\n')}` };
}

async function checkLinkedIn(lead) {
  const s = slugOf(lead.linkedin); if (!s) return { text: 'LINKEDIN: no profile link in the CRM.', ok: false };
  let tabId = await openBg(`https://www.linkedin.com/in/${s}/`); const p = await runIn(tabId, pageReadProfile);
  if (!p || p.signin) return { text: 'LINKEDIN: not checked (sign-in needed).', ok: false, signin: true };
  let out = `LINKEDIN PROFILE: connection ${p.degree || 'unknown'}${p.pending ? ', invite pending' : ''}.\n${p.top}`;
  // Last activity: tells us whether a pending or silent lead is even on LinkedIn.
  await humanPause(3000, 8000);
  tabId = await openBg(`https://www.linkedin.com/in/${s}/recent-activity/all/`);
  const act = await runIn(tabId, pageReadActivity);
  let activity = 'not read';
  if (act?.none) activity = 'no public posts or activity found: probably INACTIVE on LinkedIn';
  else if (act?.first) { const m = /^(\d+)\s?(h|d|w|mo|yr)$/.exec(act.first.replace(/\s/g, '')); const days = m ? Number(m[1]) * { h: 0, d: 1, w: 7, mo: 30, yr: 365 }[m[2]] : null; activity = `last activity about ${act.first} ago${days !== null && days > 60 ? ' (INACTIVE: nothing in the last 60 days)' : ''}`; }
  out += `\nLAST ACTIVITY: ${activity}.` + (act?.posts?.length ? '\nRecent posts:\n' + act.posts.map((x) => `- ${x.age || '?'}: ${x.text}`).join('\n') : '');
  if (p.degree !== '1st') return { text: out + '\nMessages: not connected, so no conversation to read.', ok: true, degree: p.degree, pending: p.pending, note: `connection ${p.degree || 'unknown'}` };
  await humanPause(4000, 10000);
  tabId = await openBg('https://www.linkedin.com/messaging/');
  const name = `${lead.first_name} ${lead.last_name}`.trim();
  const t = await runIn(tabId, pageReadThread, [name, s]);
  if (t?.text) out += `\nLINKEDIN CONVERSATION (latest part)${t.verified === true ? ', matched to this profile' : t.verified === false ? ', WARNING: the open thread does not link to this lead\'s profile, it may be a different person with the same name. Do not rely on it' : ', name matched only (could not confirm the profile)'}:\n${t.text}`;
  else out += `\nLINKEDIN CONVERSATION: not read (${t?.signin ? 'sign-in needed' : t?.none ? 'no thread found' : t?.error || 'unknown'}). A person must open the inbox before anything is sent.`;
  return { text: out, ok: true, degree: p.degree, pending: p.pending, thread: !!t?.text, note: `connection ${p.degree}, thread ${t?.text ? 'read' : 'not read'}` };
}

async function checkMail(lead) {
  const q = lead.email || `${lead.last_name || lead.company || ''}`.trim();
  if (!q) return { text: 'EMAIL: no address or name to search.', ok: false };
  const tabId = await openBg('https://privateemail.com/spm/mail/Virtual~2FAll/?search=' + encodeURIComponent(q) /* All Mail: inbox, sent and archive */);
  const m = await runIn(tabId, pageReadMailSearch);
  if (!m || m.signin) return { text: 'EMAIL: not checked (webmail sign-in needed).', ok: false, signin: true };
  if (!m.rows.length) return { text: `EMAIL: no messages found for "${q}".`, ok: true, note: 'no messages found' };
  // In All Mail the folder tag tells the direction: a row in Sent is ours (its title is the RECIPIENT). Anything else (Inbox, Archive...) came from them, unless the sender is us.
  const own = /shiblu|skillbnk/i;
  const ours = (r) => /sent|outbox|draft/i.test(r.folder || '') || own.test(r.from);
  const lines = m.rows.slice(0, 8).map((r) => `- ${r.date} | ${ours(r) ? 'WE WROTE' : 'THEY WROTE'} [${r.folder || 'folder ?'}] (${r.from.slice(0, 40)}) | ${r.subject.slice(0, 80)} | starts: ${(r.snippet || '').slice(0, 70)}`);
  return { note: `${m.rows.length} messages`, text: `EMAIL HISTORY for "${q}" (${m.rows.length} found, newest first; open the thread yourself for full text):\n${lines.join('\n')}`, ok: true };
}

// What still needs a look. Anything checked recently is not redone unless the CRM flagged a change (needs_review).
const ageDays = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity);
function needsOf(lead) {
  const nr = String(lead.needs_review || '');
  return { website: ageDays(lead.website_checked_at) > 30 || /website|post/i.test(nr), mail: ageDays(lead.email_checked_at) > 14 || /email|mail/i.test(nr) };
}
// The situation in plain words, so ChatGPT picks the next step from facts and not from guesses.
function situationOf(lead, l) {
  const sent = lead.invite_sent_date; const days = sent ? Math.round(ageDays(sent)) : null;
  if (l.degree === '1st') return `SITUATION: connected (1st degree)${lead.accepted_date ? ' since ' + lead.accepted_date : ''}. Read the conversation below. If we never messaged: first DM. If they replied: answer. If we wrote last: follow-up on schedule.`;
  if (sent && l.pending) return `SITUATION: our LinkedIn invite is STILL PENDING (sent ${sent}, ${days} days ago). Do not DM, they are not connected. If they posted recently: suggest ONE useful comment on a recent post (with the post link). If they are inactive or the invite is old: suggest email, or the website Contact Us form, using the facts below. Never suggest the same thing twice.`;
  if (sent) return `SITUATION: invite was sent ${sent} (${days} days ago) but is no longer pending and they are not connected: withdrawn or expired. Suggest email or the website form. Do not re-invite unless the rulebook says so.`;
  return 'SITUATION: no invitation sent yet. Suggest the best first step from the facts below (connection note, comment, email, or the website form).';
}

// Order: LinkedIn status first (cheap, and it decides the next step), then website and webmail only if not checked recently.
async function deepCheck(lead, say = log) {
  const parts = []; const checked = []; const need = needsOf(lead);
  let si = 0; const step = async (label, src, fn) => { liveAt(si++); say(`${lead.first_name} ${lead.last_name}: ${label}`); try { const r = await fn(lead); parts.push(r.text); if (r.ok) checked.push(src); return r; } catch (e) { parts.push(`${label}: not checked (${e.message}).`); return { ok: false }; } finally { await humanPause(2500, 7000); } };
  const skip = (name, when) => { si++; const t = `${name}: not re-checked (last checked ${when ? String(when).slice(0, 10) : '?'}, nothing new flagged). The earlier research summary still applies.`; say(`${lead.first_name} ${lead.last_name}: ${name.toLowerCase()} skipped, checked recently`); parts.push(t); return { ok: false, skipped: true, text: t }; };
  const l = await step('LinkedIn status first (accepted? pending? last activity)', 'linkedin', checkLinkedIn);
  const w = need.website || !lead.website_checked_at ? await step('reading the website', 'website', checkWebsite) : skip('WEBSITE', lead.website_checked_at);
  const m = need.mail ? await step('searching webmail', 'email', checkMail) : skip('EMAIL', lead.email_checked_at);
  if (l.thread) checked.push('inbox');
  await logWork(lead, { w, l, m });
  return { text: `AUTO CHECK by the extension on ${today10()} (read-only):\n${situationOf(lead, l)}\n\n` + parts.join('\n\n'), checked, website: w, linkedin: l, mail: m };
}

// Count the real work in the CRM so it shows in today's targets and the lead's history. The server keeps a profile visit to one per day.
async function logWork(lead, { w, l, m }) {
  try {
    if (l.ok) await crm('POST', `/api/leads/${lead.id}/visit`, { kind: 'person' });
    // Answer "did they accept?" from the real profile and update the CRM (no stage change, nothing sent).
    if (l.ok && lead.invite_sent_date && !lead.accepted_date && l.degree === '1st') await crm('POST', '/api/leads/signals', { items: [{ lead_id: lead.id, type: 'invite_accepted', text: 'Seen as 1st degree by the check' }] });
    else if (l.ok && lead.invite_sent_date && !lead.accepted_date && l.pending) await crm('POST', '/api/leads/signals', { items: [{ lead_id: lead.id, type: 'invite_pending' }] });
    if (w.ok && w.note) await crm('POST', `/api/leads/${lead.id}/activities`, { type: 'website_research', note: w.note });
    const bits = [`website ${w.skipped ? 'skipped (checked recently)' : w.ok ? 'read' : 'not read'}`, `LinkedIn ${l.ok ? l.note : 'not read'}`, `webmail ${m.skipped ? 'skipped (checked recently)' : m.ok ? m.note : 'not read'}`];
    await crm('POST', `/api/leads/${lead.id}/activities`, { type: 'note', note: `Auto check by the extension: ${bits.join('; ')}` });
  } catch (e) { log('Could not log the check in the CRM: ' + e.message, 'err'); }
  refreshTargets();
}
