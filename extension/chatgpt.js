// Runs inside chatgpt.com. Does what a person does: type into the box, press send, wait, read the answer.
// It never touches the CRM or LinkedIn. ChatGPT changes its page now and then; if a selector stops working, only this file needs fixing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}
const assistantMsgs = () => [...document.querySelectorAll('[data-message-author-role="assistant"]')];
const composer = () => document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"][role="textbox"]');
const stopBtn = () => document.querySelector('[data-testid="stop-button"]') || document.querySelector('button[aria-label*="Stop"]');
const sendBtn = () => { const b = document.querySelector('[data-testid="send-button"]') || document.querySelector('button[aria-label="Send prompt"]'); return b && !b.disabled ? b : null; };

async function ask(prompt, timeoutMs = 420000) {
  const box = await waitFor(composer, 30000);
  if (!box) return { ok: false, error: 'Could not find the ChatGPT message box. Open the skillBNK project page and try again.' };
  const before = assistantMsgs().length;
  box.focus();
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  const dt = new DataTransfer();
  dt.setData('text/plain', prompt);
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(700);
  if ((box.innerText || box.value || '').trim().length < Math.min(40, prompt.length)) document.execCommand('insertText', false, prompt);
  const send = await waitFor(sendBtn, 20000);
  if (!send) return { ok: false, error: 'The Send button never became active (the text may not have been pasted).' };
  await sleep(300 + Math.random() * 500); // a short human-like pause
  send.click();
  const started = await waitFor(() => assistantMsgs().length > before || stopBtn(), 60000);
  if (!started) return { ok: false, error: 'ChatGPT did not start answering.' };
  const end = Date.now() + timeoutMs;
  let last = ''; let stable = 0;
  while (Date.now() < end) {
    await sleep(1000);
    const msgs = assistantMsgs();
    const text = msgs.length ? msgs[msgs.length - 1].innerText : '';
    if (!stopBtn() && text && text === last) { if (++stable >= 3) return { ok: true, text, url: location.href }; } else stable = 0;
    last = text;
  }
  return { ok: false, error: 'ChatGPT took too long to answer.', text: last };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'ping') { reply({ ok: true, ready: !!composer() }); return; }
  if (msg?.type === 'ask') { ask(msg.prompt).then(reply).catch((e) => reply({ ok: false, error: String(e) })); return true; }
});
