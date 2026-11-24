// Runs inside chatgpt.com. Does what a person does: type into the box, press send, wait, read the answer.
// It never touches the CRM or LinkedIn. ChatGPT changes its page now and then; if a selector stops working, only this file needs fixing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}
// ChatGPT renames these now and then, so try several selectors and keep the first that finds something.
const assistantMsgs = () => {
  for (const sel of ['[data-message-author-role="assistant"]', '[data-turn="assistant"]', 'article[data-testid^="conversation-turn"]:has(.markdown) .markdown', 'div.markdown']) { const x = [...document.querySelectorAll(sel)]; if (x.length) return x; }
  return [];
};
// If none of the selectors above match (ChatGPT changed its page again), find the answer by its content: our JSON block is a code block holding "needs_human".
const jsonBlocks = () => [...document.querySelectorAll('pre, code')].filter((e) => /"needs_human"/.test(e.innerText || '') && !e.closest('textarea,#prompt-textarea,form'));
const getAnswer = (blocksBefore = 0) => {
  const m = assistantMsgs(); if (m.length) return { text: m[m.length - 1].innerText, via: 'message' };
  const b = jsonBlocks(); if (b.length > blocksBefore) return { text: b[b.length - 1].innerText, via: 'code block' };
  return { text: '', via: 'none' };
};
const progress = (note) => { try { chrome.runtime.sendMessage({ type: 'progress', note }); } catch { /* panel closed */ } };
const composer = () => document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"][role="textbox"]');
const stopBtn = () => document.querySelector('[data-testid="stop-button"]') || document.querySelector('button[aria-label*="Stop"]');
const sendBtn = () => {
  // ChatGPT renames this button now and then, so try several ways to find it.
  const cands = [document.querySelector('[data-testid="send-button"]'), document.querySelector('#composer-submit-button'), document.querySelector('button[aria-label="Send prompt"]'), document.querySelector('button[aria-label*="Send" i]:not([aria-label*="feedback" i])'), document.querySelector('form button[type="submit"]')];
  return cands.find((x) => x && !x.disabled && x.getAttribute('aria-disabled') !== 'true') || null;
};
const pressEnter = (box) => { for (const t of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); };

async function ask(prompt, timeoutMs = 420000) {
  const box = await waitFor(composer, 30000);
  if (!box) return { ok: false, error: 'Could not find the ChatGPT message box. Open the skillBNK project page and try again.' };
  const before = assistantMsgs().length, blocksBefore = jsonBlocks().length, lenBefore = (document.querySelector('main')?.innerText || '').length;
  box.focus();
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  const dt = new DataTransfer();
  dt.setData('text/plain', prompt);
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(700);
  if ((box.innerText || box.value || '').trim().length < Math.min(40, prompt.length)) document.execCommand('insertText', false, prompt);
  const send = await waitFor(sendBtn, 8000);
  await sleep(300 + Math.random() * 500); // a short human-like pause
  if (send) send.click(); else pressEnter(box); // no button found: send with the Enter key, like typing it
  let started = await waitFor(() => assistantMsgs().length > before || stopBtn() || jsonBlocks().length > blocksBefore || (document.querySelector('main')?.innerText || '').length > lenBefore + 400, 8000);
  if (!started) { // the click did nothing: try the other way once
    if (send) pressEnter(box); else { const b = sendBtn(); if (b) b.click(); }
    started = await waitFor(() => assistantMsgs().length > before || stopBtn() || jsonBlocks().length > blocksBefore || (document.querySelector('main')?.innerText || '').length > lenBefore + 400, 60000);
  }
  if (!started) return { ok: false, error: 'The prompt was pasted but ChatGPT did not start answering. Press the send arrow yourself, then run this lead again.' };
  const end = Date.now() + timeoutMs;
  let last = ''; let stable = 0; const t0 = Date.now();
  while (Date.now() < end) {
    await sleep(1000);
    const ans = getAnswer(blocksBefore); const text = ans.text;
    // Done = the text stopped changing and the Stop button is gone. If the Stop button never goes away, 25 quiet seconds is enough.
    if (text && text === last) { stable++; if ((!stopBtn() && stable >= 3) || stable >= 25) return { ok: true, text, url: location.href }; } else stable = 0;
    last = text;
    if ((Date.now() - t0) % 5000 < 1000) progress(`ChatGPT is answering… ${Math.round((Date.now() - t0) / 1000)}s, ${text.length} characters (found by ${ans.via})${stopBtn() ? '' : ', finishing'}`);
  }
  return { ok: false, error: 'ChatGPT took too long to answer.', text: last };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'ping') { reply({ ok: true, ready: !!composer() }); return; }
  if (msg?.type === 'diag') {
    const sels = ['main pre', 'main code', 'main','[data-message-author-role="assistant"]', '[data-turn="assistant"]', 'article[data-testid^="conversation-turn"]', 'div.markdown', '[data-testid="stop-button"]', 'button[aria-label*="Stop"]', '#prompt-textarea', '[data-testid="send-button"]', '#composer-submit-button'];
    const counts = Object.fromEntries(sels.map((s) => { try { return [s, document.querySelectorAll(s).length]; } catch { return [s, 'bad selector']; } }));
    const turns = [...document.querySelectorAll('article, [data-testid^="conversation-turn"], [data-message-author-role]')];
    const last = turns[turns.length - 1];
    const skeleton = last ? last.outerHTML.replace(/>[^<]{40,}</g, '>…<').replace(/\s+/g, ' ').slice(0, 2500) : 'no article or turn found';
    const m = assistantMsgs();
    reply({ url: location.href, counts, jsonBlocks: jsonBlocks().length, via: getAnswer(0).via, found: m.length, lastTextStart: m.length ? m[m.length - 1].innerText.slice(0, 120) : '', lastTextEnd: m.length ? m[m.length - 1].innerText.slice(-200) : '', skeleton });
    return;
  }
  if (msg?.type === 'read') { const a = getAnswer(0); reply({ ok: !!a.text, text: a.text, url: location.href, error: a.text ? '' : 'No ChatGPT answer found on this page' }); return; }
  if (msg?.type === 'ask') { ask(msg.prompt).then(reply).catch((e) => reply({ ok: false, error: String(e) })); return true; }
});
