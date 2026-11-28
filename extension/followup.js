// Follow-through after a research result is saved.
// 1) A "check this page" task (company page, pricing page...) is done by the extension: it reads the public page, sends what it saw back to the SAME ChatGPT chat,
//    and saves the better verdict plus a draft. 2) A QUALIFY or PURSUE lead with no draft gets one more ChatGPT round that must end in a draft or an exact reason.
// 3) An inbox, conversation or InMail task is only done when YOU press the button (it reads LinkedIn read-only, one lead at a time).
// Nothing is ever sent. One round only, so it can never loop. Needs globals from sidepanel.js, sweep.js and deep.js.
const WRITING = `HOW TO WRITE A FIRST TOUCH (connection note, first DM, first comment, first email, Contact Us form). This overrides any habit of describing what we do.
- The goal is a quick reply. People reply when they feel noticed and asked about THEIR work. They ignore anything that smells like a sales pitch.
- Shape, two or three short lines: (1) "Hi Name," (2) ONE real fact about THEM that we actually read (their class, program, post, role, location), said with simple interest, (3) ONE easy, specific question about how THEY handle something today, answerable in one line (for example: "Is it mostly paper, or do you use something?").
- Intro: only "I'm Shiblu, a founder based in Warren, MI" (or "a fellow Michigander" when their Michigan location is verified), or "a tech founder with 25+ years of experience". Never write skillBNK, platform, LMS, software, automation, "we help", "we offer", free trial, demo, pilot, meeting, call or any price in a first touch.
- The question is about THEM, never about our product. Never "would you be interested in", never "can I show you".
- A connection note is 300 characters or fewer, holds the fact and the question, has no signature and no "Would love to connect!".
- Good connection note: "Hi Samania, I'm Shiblu, a founder based in Warren, MI. I saw your CNA classes in Detroit. Curious how you track attendance and skills sign-offs for each cohort. Mostly paper?"
- Make every note different. Read the profile and pick ONE specific hook that only this person has: a career move, something they built, a post, a role they are hiring for, an About line, a number (years, size), or where they are from. Never reuse the same skeleton for two leads (not every note is "I saw your X. Curious how you Y?").
- Vary the question too: the hardest part of something, what made them start it, how they get new people up to speed, what works for them. Any of these can be the one question. A story question about them ("what made you start it?") is fine as a first touch.
- Do not claim a background Shiblu has not stated. Never write "my background is in...", "caught my attention", "particularly relevant", "glad to connect".
- SHIBLU'S VOICE for every DM and email: a busy, warm, plain-spoken founder. Short lines, one sentence per line, a blank line between lines. Greet by day or time when known ("GM, Brian," in the US morning), otherwise "Hi Name,". Simple words, contractions, "Pls" for please, no em dashes, no long sentences. A first DM ends with "No rush. Whenever you get a chance." and then "Thanks, Shiblu". An email ends with the closing block described in the EMAIL rule (the mailbox signature was removed). A connection note and a public comment have no closing and no signature.
- EMAIL (Shiblu feedback 28 Nov 2026: the old emails were not attractive to read, and the intro about him was missing at the end). Subject "Quick question about <their company or topic>". Body, 60 to 90 words, written for the reader: "Hi First," then ONE specific, true, warm line about THEIR work that shows we really looked (a number, a detail, something they built; no flattery words), saying we are curious how they do it. Then "Two quick questions:" and exactly two short bullets, each answerable in one line and each pointing at the offer that may fit (platform: where courses and certificates live; AI content: who creates and updates lessons; automation: how enrollment and tracking are handled). Then "Short answers are plenty. No rush. Whenever you get a chance." No product pitch, no meeting ask, no links or attachments in Email 1. No "I'm Shiblu, a tech founder..." paragraph in the body. The mailbox signature was removed, so END WITH THIS CLOSING BLOCK, typed once, nothing before or after it: "Thanks," / "Shiblu Ahmad" / "Founder, skillBNK" / ONE intro line about Shiblu that also says how we found them, for example "Michigan-based founder building tools for training teams. I found <Company> while looking at <true source>." (Say Michigan-based or Warren only when his location is a fact; keep the line under 25 words and TRUE; never invent the source.) Never type "Thanks, Shiblu" as a second sign-off. Shiblu is always in Bcc (the CRM adds it, do not write it).
- SECOND MESSAGE (only after they reply): thank them in a few words, answer what they asked, then ask for time the way Shiblu does: "We can have a 15 min discovery meeting tomorrow or next Monday at 12:00 pm EST, How is your calendar?" A human confirms the calendar before any time is final.
- Bad: anything that names or describes our product, offers something, or asks for time.
- After they reply: answer THEIR words first, then ask ONE more question about the problem they named. Mention skillBNK, a free limited-time pilot or a short call only when they ask what we do, or after two real exchanges. Then offer two time options.`;
const THREAD_HINT = /inbox|conversation|thread|inmail|sales navigator|messaging|latest reply|their reply|replied/i;
const SALES_HINT = /sales navigator|inmail|\/sales\//i;
const KEYWORDS = /pricing|price|fund|tuition|cost|corporate|enterprise|team|about|leadership|executive|staff|program|course|training|contact|learn more/i;


// ── Style check on every first-touch draft: stock phrases, product talk, no/too many questions, yes/no questions, and the same opening as recent drafts ──
const FIRST_TOUCH = ['linkedin_connect', 'linkedin_dm', 'email', 'website_contact'];
const STOCK = /caught my attention|glad to connect|would love to connect|particularly relevant|my background|i noticed you|i came across|reach out|stood out|synerg|leverage|streamline|excited to|hope this (email|message)/i;
const PITCH = /skillbnk|platform|\blms\b|software|automation|free (trial|pilot)|\bdemo\b|\bpilot\b|\bmeeting\b|schedule a|book a|our (product|solution|service)/i;
const openerOf = (b) => String(b || '').replace(/^\s*(hi|hello|hey|good \w+|gm)\b[^,!.\n]*[,!.]?\s*/i, '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
function lintDraft(x, recent) {
  if (!FIRST_TOUCH.includes(x.channel)) return [];
  const b = String(x.body || ''), issues = [];
  const stock = STOCK.exec(b); if (stock) issues.push(`stock phrase "${stock[0]}"`);
  const pitch = PITCH.exec(b); if (pitch) issues.push(`mentions "${pitch[0]}" (no product, offer or meeting in a first touch)`);
  const qs = b.match(/[^.!?\n]*\?/g) || [];
  if (!qs.length) issues.push('no question'); else if (qs.length > 1) issues.push('more than one question');
  else if (/^\s*(does|do|is|are|would|can|could|will)\b/i.test(qs[0])) issues.push('a yes/no question that probes for a need; ask how, what or why about THEIR work or story instead');
  if (x.channel === 'linkedin_connect' && b.length > 300) issues.push('over 300 characters');
  const o = openerOf(b); if (o && recent.filter((r) => r === o).length >= 1) issues.push('same opening as a recent draft');
  return issues;
}
async function polishDrafts(lead, data, tabId) {
  try {
    const store = (await chrome.storage.local.get('openers')).openers || [];
    const bad = (data.drafts || []).map((x) => ({ x, issues: lintDraft(x, store) })).filter((y) => y.issues.length);
    if (bad.length && tabId) {
      liveNote('Style check: asking ChatGPT to rewrite ' + bad.length + ' draft(s)');
      const list = bad.map((y) => `- ${y.x.channel}: "${y.x.body}"\n  Problems: ${y.issues.join('; ')}`).join('\n');
      const prompt = `STYLE CHECK for ${lead.first_name} ${lead.last_name}. These drafts break the writing standard:\n${list}\n\nRewrite ONLY those drafts. Use a different opening and structure from these recent drafts: ${store.slice(-8).map((o) => '"' + o + '"').join(', ') || '(none)'}. Pick ONE hook only this person has (a move, something they built or shared, a role, a number). One question, ask how, what or why about THEM, not yes/no. No product, no offer. Connection note 300 characters or fewer. Keep every other key of the json block as in your last answer, with the full drafts array. Answer with one line, then the json block.\n\nWriting standard:\n${WRITING}`;
      const a = await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'ask', prompt }), new Promise((r) => setTimeout(() => r({ ok: false, error: 'style check timed out' }), 45000))]);
      const d2 = a?.ok ? extractJson(a.text) : null;
      if (d2?.drafts?.length) { const keep = (data.drafts || []).filter((x) => !bad.some((y) => y.x.channel === x.channel)); data.drafts = [...keep, ...d2.drafts]; log(`Style check rewrote ${bad.length} draft(s) for ${lead.first_name} ${lead.last_name}`, 'ok'); }
      else log('Style check: no rewrite came back, original draft kept', 'err');
    }
    const now = (data.drafts || []).filter((x) => FIRST_TOUCH.includes(x.channel)).map((x) => openerOf(x.body)).filter(Boolean);
    await chrome.storage.local.set({ openers: [...store, ...now].slice(-30) });
  } catch (e) { log('Style check skipped: ' + e.message, 'err'); }
  return data;
}

function followKind(d, saveRes, verdict) {
  if (!['PURSUE', 'QUALIFY'].includes(verdict) && !String(d.needs_human || '').trim()) return '';
  const nh = String(d.needs_human || '');
  if (nh && THREAD_HINT.test(nh)) return 'thread';
  if (nh) return 'page';
  const drafts = (saveRes.drafts || 0) + (saveRes.duplicates || 0);
  if (['PURSUE', 'QUALIFY'].includes(verdict) && !drafts) return 'draft';
  return '';
}
function followBody(d) {
  return { verdict: String(d.verdict || 'QUALIFY').toUpperCase(), reason: d.reason || '', assessment: d.assessment || '', why_in_pipeline: d.why_in_pipeline || '', todays_question: d.todays_question || '', next_action: d.next_action || '', next_action_days: Number(d.next_action_days) || 0, denial_reason: d.denial_reason || '', quality: d.quality || '', lead_category: d.lead_category || '', channel: d.channel || '', outreach_status: d.outreach_status || '', research_summary: d.research_summary || '', needs_human: d.needs_human || '', rules_version: (typeof setup !== 'undefined' && setup?.version) || '', checked: d.checked || [], links: d.links || [], drafts: (d.drafts || []).map((z) => ({ channel: z.channel, subject: z.subject || '', body: z.body || '', target_url: z.target_url || '', note: z.note || '' })) };
}
// Which pages to read for a "check this page" task: a link in the task text, else the company LinkedIn page, else the lead's website, plus up to two same-site pages the task points at.
function pagesFor(lead, task) {
  const urls = (task.match(/https?:\/\/[^\s)>\]"']+/g) || []).slice(0, 2);
  if (!urls.length && /company page|linkedin company|company linkedin/i.test(task) && lead.company_linkedin) urls.push(/^https?:/i.test(lead.company_linkedin) ? lead.company_linkedin : 'https://' + lead.company_linkedin);
  if (!urls.length && lead.website) urls.push(/^https?:/i.test(lead.website) ? lead.website : 'https://' + lead.website);
  return urls;
}
async function readPublic(lead, task) {
  const out = [];
  for (const url of pagesFor(lead, task)) {
    const tabId = await openBg(url); const p = await runIn(tabId, pageReadSite);
    if (!p) { out.push(`PAGE ${url}: could not be read.`); continue; }
    if (/linkedin\.com/i.test(url) && /authwall|login|checkpoint/i.test(p.title + ' ')) { out.push(`PAGE ${url}: LinkedIn asked for a sign-in.`); continue; }
    out.push(`PAGE ${url} (title: ${p.title}):\n${p.text}`);
    if (!/linkedin\.com/i.test(url)) {
      const host = hostOf(url), seen = new Set([url]);
      const more = p.links.filter((x) => hostOf(x.h) === host && KEYWORDS.test(x.h + ' ' + x.t)).map((x) => x.h).filter((h) => !seen.has(h) && seen.add(h)).slice(0, 2);
      for (const u of more) { await humanPause(/linkedin\.com/i.test(url) ? 3000 : 800, /linkedin\.com/i.test(url) ? 7000 : 2000); const q = await runIn(await openBg(u), pageReadSite); if (q) out.push(`PAGE ${u} (title: ${q.title}):\n${q.text}`); }
    }
    await humanPause(/linkedin\.com/i.test(url) ? 3000 : 800, /linkedin\.com/i.test(url) ? 7000 : 2000);
  }
  return out.length ? out.join('\n\n') : 'No page could be opened (no link in the task and no website in the CRM).';
}
// Runs inside the LinkedIn Sales Navigator inbox: open the conversation that matches the name and return its text. Read-only.
async function pageReadSalesThread(name) {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  await w(3000);
  const want = name.toLowerCase();
  const item = [...document.querySelectorAll('li, [role="listitem"], a')].find((x) => (x.innerText || '').toLowerCase().includes(want) && (x.innerText || '').length < 400);
  if (!item) return { none: true };
  item.click(); await w(3000);
  const main = document.querySelector('main') || document.body;
  return { text: main.innerText.replace(/\n{2,}/g, '\n').slice(-3500), verified: null };
}
async function readThread(lead, task) {
  const name = `${lead.first_name} ${lead.last_name}`.trim(), slug = slugOf(lead.linkedin);
  if (SALES_HINT.test(task)) {
    const t = await runIn(await openBg('https://www.linkedin.com/sales/inbox/'), pageReadSalesThread, [name]);
    if (t?.text) return `SALES NAVIGATOR CONVERSATION with ${name} (latest part, read-only, name matched only):\n${t.text}`;
    return `SALES NAVIGATOR CONVERSATION: not read (${t?.signin ? 'sign-in needed' : t?.none ? 'no conversation with that name found' : 'unknown'}).`;
  }
  const t = await runIn(await openBg('https://www.linkedin.com/messaging/'), pageReadThread, [name, slug]);
  if (t?.text) return `LINKEDIN CONVERSATION with ${name} (latest part, read-only)${t.verified === true ? ', matched to the profile' : t.verified === false ? ', WARNING: the open thread does not link to this lead, it may be someone with the same name. Do not rely on it' : ', name matched only'}:\n${t.text}`;
  return `LINKEDIN CONVERSATION: not read (${t?.signin ? 'sign-in needed' : t?.none ? 'no thread found' : t?.error || 'unknown'}).`;
}

// Send what was read back to the same chat and save the better answer.
async function askAndSave(lead, d, r, task, evidence, kind) {
  const summary = d.research_summary ? `\nEarlier research summary: ${d.research_summary}` : '';
  const need = kind === 'draft'
    ? 'You saved this lead as ' + String(d.verdict).toUpperCase() + ' with NO draft. Write the draft now (in Shiblu\'s voice, from the rulebook) for the next action. If a draft is truly impossible today, put the exact reason and the one page or inbox a person must check in needs_human.'
    : 'Use this evidence to finish the task. Update the verdict only if the evidence changes it. Give ONE next_action a person can do today and write the draft for it (in Shiblu\'s voice, from the rulebook). If the evidence is missing or says sign-in needed, say so in needs_human and still give the best draft you can.';
  const prompt = `FOLLOW-UP for ${lead.first_name} ${lead.last_name}${lead.company ? ' (' + lead.company + ')' : ''}.${summary}\nThe task from your last answer was: ${task || '(none, a draft was missing)'}\nThe browser extension did that task read-only. What it saw:\n\n${evidence}\n\n${need}\nWriting standard for any draft:\n${WRITING}\n\n${kind === 'thread' ? await availabilityBlock() + '\n\n' : ''}Answer briefly, then end with the same machine-readable json block as before (all keys, one code block tagged json).`;
  const tabId = await chatTab(r.url && /\/c\//.test(r.url) ? r.url : cfg.project);
  const a = await chrome.tabs.sendMessage(tabId, { type: 'ask', prompt });
  if (!a?.ok) throw new Error(a?.error || 'No answer from ChatGPT');
  const d2 = extractJson(a.text); if (!d2) throw new Error('The follow-up answer had no JSON block. The first result stays saved.');
  await polishDrafts(lead, d2, tabId);
  d2.needs_human = d2.needs_human || ''; d2.links = [...(d.links || []), ...(d2.links || [])];
  const res = await crm('POST', `/api/leads/${lead.id}/ai-result`, followBody({ ...d, ...d2 }));
  log(`Follow-up saved for ${lead.first_name} ${lead.last_name}: ${res.verdict}, ${res.drafts} new draft${res.drafts === 1 ? '' : 's'}${d2.needs_human ? ', still to check by hand: ' + d2.needs_human : ''}`, 'ok');
  return { res, d2 };
}
function showFollow(box, lead, { res, d2 }) {
  box.replaceChildren(el('div', { class: 'ok' }, `Follow-up done: ${res.verdict}, ${res.drafts} new draft${res.drafts === 1 ? '' : 's'}. Nothing was sent.`), el('div', {}, 'Next: ' + (d2.next_action || '-')), ...quickLinks(lead, res.saved || []), d2.needs_human ? el('div', { class: 'muted' }, 'Check by hand: ' + d2.needs_human) : null);
}

// ── The next touch: after the research, do what the CRM says is the next step and save that draft ──
// The CRM already decides the step (guide.kind). We only turn it into a draft the person can review and send later.
const STEP_DRAFT = { warm: ['linkedin_comment'], nurture: ['linkedin_comment'], connect: ['linkedin_connect'], first_message: ['linkedin_dm'], followup: ['linkedin_followup'], last_followup: ['linkedin_followup'], reply: ['linkedin_followup', 'email'], email: ['email'], no_email: ['website_contact', 'linkedin_comment'] };
const STEP_RULE = {
  linkedin_connect: 'A connection note, 300 characters or fewer: "Hi Name," + who Shiblu is in a few words + ONE real fact about THEM + ONE easy question about how THEY work. No skillBNK, no offer, no signature, no "Would love to connect".',
  linkedin_dm: 'The first message to someone who does not know us: "Hi Name," + ONE real fact about them + ONE easy question about how they work today. No skillBNK, no product, no offer, no meeting ask. 45 words or fewer.',
  linkedin_followup: 'A reply or follow-up message in Shiblu\'s voice. If they wrote last, answer THEIR words first and ask ONE more question about the problem they named. If we wrote last, bring a NEW angle with a new question about them, never "just checking in". Mention skillBNK, a free limited-time pilot or a short call only if they asked what we do or after two real exchanges.',
  email: 'A short email (50 to 90 words) with a subject line. First email: one fact about them and ONE easy question about how they work today. No product, no offer, no meeting ask.',
  website_contact: 'A short Contact Us message: one fact about them and ONE easy question about how they work today. No product, no offer. Put the form page link in target_url.',
  linkedin_comment: 'A comment with a real view on ONE recent post (not praise, not a summary), no name, no company, no signature, no product. Put the direct post link in target_url.',
};
// Runs inside the lead's recent-activity page: the latest posts with their direct links.
async function pageReadPosts() {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  await w(2500); window.scrollBy(0, 900); await w(1500);
  const seen = new Set();
  const posts = [...document.querySelectorAll('[data-urn]')].map((p) => { const urn = p.getAttribute('data-urn') || ''; if (!/^urn:li:(activity|ugcPost|share)/.test(urn) || seen.has(urn)) return null; seen.add(urn); return { url: 'https://www.linkedin.com/feed/update/' + urn + '/', text: (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600) }; }).filter((x) => x && x.text).slice(0, 3);
  return { posts };
}
async function evidenceFor(lead, kind) {
  const have = String(findings[lead.id] || '');
  if (['warm', 'nurture'].includes(kind)) {
    const slug = slugOf(lead.linkedin); if (!slug) return 'No LinkedIn profile link in the CRM, so no post could be read.';
    const t = await runIn(await openBg(`https://www.linkedin.com/in/${slug}/recent-activity/all/`), pageReadPosts);
    return t?.posts?.length ? 'RECENT POSTS (read-only; use one of these links as target_url):\n' + t.posts.map((x, i) => `${i + 1}. ${x.url}\n   ${x.text}`).join('\n') : `No recent posts could be read (${t?.signin ? 'sign-in needed' : 'none found'}).`;
  }
  if (['reply', 'followup', 'last_followup', 'first_message'].includes(kind)) {
    if (/LINKEDIN CONVERSATION|EMAIL HISTORY/.test(have)) return have.slice(-5000);
    if (kind === 'first_message' || !lead.linkedin) return have.slice(-3000) || 'No earlier conversation was read.';
    return await readThread(lead, '');
  }
  if (['email', 'no_email'].includes(kind)) {
    let mail = /EMAIL HISTORY|EMAIL:/.test(have) ? '' : (await checkMail(lead)).text;
    const contact = (deepInfo[lead.id]?.links || []).filter((x) => x.kind === 'contact').map((x) => x.url).slice(0, 3);
    return [have.slice(-3500), mail, contact.length ? 'Contact page links found: ' + contact.join(', ') : ''].filter(Boolean).join('\n\n');
  }
  return have.slice(-3000);
}
async function prepNext(lead, cur, r, box) {
  const detail = await crm('GET', `/api/leads/${lead.id}`);
  const g = detail.guide || {}; const kind = g.kind || '';
  const verdict = String(cur.verdict || '').toUpperCase();
  const allowed = (STEP_DRAFT[kind] || []).filter(() => verdict !== 'SKIP' && (verdict !== 'NURTURE' || ['warm', 'nurture'].includes(kind)));
  if (!allowed.length) { box.replaceChildren(el('div', { class: 'muted' }, 'Next touch: ' + (g.action || 'nothing due today') + (g.why ? ' (' + g.why + ')' : '') + '. Nothing to draft now.')); return; }
  const waiting = (detail.drafts || []).filter((x) => x.status === 'ready' && allowed.includes(x.channel));
  if (waiting.length) { box.replaceChildren(el('div', { class: 'muted' }, `Next touch: ${g.action}. A draft is already waiting for your review.`)); return; }
  box.replaceChildren(el('div', { class: 'muted' }, `Next touch: ${g.action}. Reading what is needed and preparing the draft…`));
  const evidence = await evidenceFor(lead, kind);
  const rules = allowed.map((c) => `- ${c}: ${STEP_RULE[c]}`).join('\n');
  const prompt = `NEXT TOUCH for ${lead.first_name} ${lead.last_name}${lead.company ? ' (' + lead.company + ')' : ''}.\nThe CRM says the next step is: ${g.action}. Why: ${g.why || '-'}\nAllowed draft channel(s):\n${rules}\n\nEvidence the extension read (read-only):\n${evidence || '(none)'}\n\nWrite ONLY the draft for this step, in Shiblu's voice from the rulebook, one draft in the best allowed channel. Keep every other key of the json block as in your last answer. Never send, only draft. Writing standard:\n${WRITING}\n\n${kind === 'reply' ? await availabilityBlock() + '\n\n' : ''}Answer in two lines, then the json block with the draft in "drafts".`;
  const tabId = await chatTab(r.url && /\/c\//.test(r.url) ? r.url : cfg.project);
  const a = await chrome.tabs.sendMessage(tabId, { type: 'ask', prompt });
  if (!a?.ok) throw new Error(a?.error || 'No answer from ChatGPT');
  const d2 = extractJson(a.text); if (d2) await polishDrafts(lead, d2, tabId);
  const drafts = (d2?.drafts || []).filter((x) => allowed.includes(x.channel));
  if (!drafts.length) throw new Error('ChatGPT gave no usable draft for this step. Next touch stays: ' + g.action);
  const res = await crm('POST', `/api/leads/${lead.id}/ai-result`, followBody({ ...cur, needs_human: '', drafts, links: cur.links || [] }));
  log(`Next touch ready for ${lead.first_name} ${lead.last_name}: ${drafts[0].channel} draft saved. Review it in the CRM, nothing was sent.`, 'ok');
  box.replaceChildren(el('div', { class: 'ok' }, `Next touch drafted (${g.action}). Review and send it yourself.`), ...quickLinks(lead, res.saved || []));
}

// Called after a successful save. `box` is the place on the card where the result is shown.
async function followThrough(lead, d, r, saveRes, box) {
  if (cfg.followup === false) return;
  const verdict = String(saveRes.verdict || d.verdict || '').toUpperCase();
  const a = el('div'), b = el('div'); box.replaceChildren(a, b);
  let cur = d; const task = String(d.needs_human || ''); const kind = followKind(d, saveRes, verdict);
  const step = async () => { try { if (verdict !== 'SKIP') await prepNext(lead, cur, r, b); } catch (e) { b.replaceChildren(el('div', { class: 'err' }, 'Next touch not prepared: ' + e.message), el('button', { onclick: () => step() }, 'Try again')); log(e.message, 'err'); } };
  const run = async (k) => {
    a.replaceChildren(el('div', { class: 'muted' }, k === 'thread' ? 'Reading the conversation (read-only)…' : k === 'page' ? 'Checking the page the research asked for…' : 'Asking ChatGPT for the missing draft…'));
    try {
      if (!await allSites()) throw new Error('Permission to read websites was declined');
      const evidence = k === 'thread' ? await readThread(lead, task) : k === 'page' ? await readPublic(lead, task) : 'No new page was needed. Use the research you already did.';
      const out = await askAndSave(lead, d, r, task, evidence, k); cur = { ...d, ...out.d2 }; showFollow(a, lead, out);
    } catch (e) { a.replaceChildren(el('div', { class: 'err' }, 'Follow-up stopped: ' + e.message), el('button', { onclick: () => run(k).then(step) }, 'Try again')); log(e.message, 'err'); }
  };
  if (kind) await run(kind);
  await step();
}
