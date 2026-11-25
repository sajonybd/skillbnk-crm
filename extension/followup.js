// Follow-through after a research result is saved.
// 1) A "check this page" task (company page, pricing page...) is done by the extension: it reads the public page, sends what it saw back to the SAME ChatGPT chat,
//    and saves the better verdict plus a draft. 2) A QUALIFY or PURSUE lead with no draft gets one more ChatGPT round that must end in a draft or an exact reason.
// 3) An inbox, conversation or InMail task is only done when YOU press the button (it reads LinkedIn read-only, one lead at a time).
// Nothing is ever sent. One round only, so it can never loop. Needs globals from sidepanel.js, sweep.js and deep.js.
const THREAD_HINT = /inbox|conversation|thread|inmail|sales navigator|messaging|latest reply|their reply|replied/i;
const SALES_HINT = /sales navigator|inmail|\/sales\//i;
const KEYWORDS = /pricing|price|fund|tuition|cost|corporate|enterprise|team|about|leadership|executive|staff|program|course|training|contact|learn more/i;

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
      for (const u of more) { await humanPause(3000, 7000); const q = await runIn(await openBg(u), pageReadSite); if (q) out.push(`PAGE ${u} (title: ${q.title}):\n${q.text}`); }
    }
    await humanPause(3000, 7000);
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
  const prompt = `FOLLOW-UP for ${lead.first_name} ${lead.last_name}${lead.company ? ' (' + lead.company + ')' : ''}.${summary}\nThe task from your last answer was: ${task || '(none, a draft was missing)'}\nThe browser extension did that task read-only. What it saw:\n\n${evidence}\n\n${need}\nAnswer briefly, then end with the same machine-readable json block as before (all keys, one code block tagged json).`;
  const tabId = await chatTab(r.url && /\/c\//.test(r.url) ? r.url : cfg.project);
  const a = await chrome.tabs.sendMessage(tabId, { type: 'ask', prompt });
  if (!a?.ok) throw new Error(a?.error || 'No answer from ChatGPT');
  const d2 = extractJson(a.text); if (!d2) throw new Error('The follow-up answer had no JSON block. The first result stays saved.');
  d2.needs_human = d2.needs_human || ''; d2.links = [...(d.links || []), ...(d2.links || [])];
  const res = await crm('POST', `/api/leads/${lead.id}/ai-result`, followBody({ ...d, ...d2 }));
  log(`Follow-up saved for ${lead.first_name} ${lead.last_name}: ${res.verdict}, ${res.drafts} new draft${res.drafts === 1 ? '' : 's'}${d2.needs_human ? ', still to check by hand: ' + d2.needs_human : ''}`, 'ok');
  return { res, d2 };
}
function showFollow(box, lead, { res, d2 }) {
  box.replaceChildren(el('div', { class: 'ok' }, `Follow-up done: ${res.verdict}, ${res.drafts} new draft${res.drafts === 1 ? '' : 's'}. Nothing was sent.`), el('div', {}, 'Next: ' + (d2.next_action || '-')), ...quickLinks(lead, res.saved || []), d2.needs_human ? el('div', { class: 'muted' }, 'Check by hand: ' + d2.needs_human) : null);
}

// Called after a successful save. `box` is the place on the card where the result is shown.
async function followThrough(lead, d, r, saveRes, box) {
  const verdict = String(saveRes.verdict || d.verdict || '').toUpperCase();
  const kind = followKind(d, saveRes, verdict); if (!kind) return;
  const task = String(d.needs_human || '');
  const run = async (k) => {
    box.replaceChildren(el('div', { class: 'muted' }, k === 'thread' ? 'Reading the conversation (read-only)…' : k === 'page' ? 'Checking the page the research asked for…' : 'Asking ChatGPT for the missing draft…'));
    try {
      if (!await allSites()) throw new Error('Permission to read websites was declined');
      const evidence = k === 'thread' ? await readThread(lead, task) : k === 'page' ? await readPublic(lead, task) : 'No new page was needed. Use the research you already did.';
      showFollow(box, lead, await askAndSave(lead, d, r, task, evidence, k));
    } catch (e) { box.replaceChildren(el('div', { class: 'err' }, 'Follow-up stopped: ' + e.message), el('button', { onclick: () => run(k) }, 'Try again')); log(e.message, 'err'); }
  };
  if (kind === 'thread') { // reads your signed-in LinkedIn inbox: you start it, one lead at a time
    box.replaceChildren(el('div', { class: 'muted' }, 'Needs your inbox: ' + task), el('button', { class: 'primary', onclick: () => run('thread') }, 'Read the conversation and draft'));
    return;
  }
  if (cfg.followup === false) { box.replaceChildren(el('div', { class: 'muted' }, 'Follow-up is off in Settings. ' + (task ? 'Check by hand: ' + task : 'No draft was written.')), el('button', { onclick: () => run(kind) }, 'Do the follow-up now')); return; }
  await run(kind);
}
