import { LINK_KINDS } from '../config.js';

// Returns a safe absolute http(s) URL, or throws an Error with a friendly message.
export function cleanUrl(raw) {
  let v = String(raw ?? '').trim();
  if (!v) throw new Error('Paste a link first');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  let u;
  try { u = new URL(v); } catch { throw new Error('That does not look like a valid link'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links are allowed');
  if (!u.hostname.includes('.')) throw new Error('That does not look like a valid link');
  return u.href;
}

export function detectKind(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') return 'chatgpt';
  if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'sheets.google.com' || host === 'slides.google.com') return 'drive';
  if (/(^|\.)(calendly\.com|cal\.com|savvycal\.com|tidycal\.com|zcal\.co|youcanbook\.me|setmore\.com|acuityscheduling\.com|squareup\.com|meetings\.hubspot\.com|app\.hubspot\.com)$/.test(host)) return 'booking';
  if (host === 'outlook.office365.com' || host === 'outlook.office.com') { if (/\/bookwithme|\/book\//i.test(new URL(url).pathname)) return 'booking'; }
  if (/\/(contact|contact-us|contactus|get-in-touch)(\/|$|\.)/i.test(new URL(url).pathname)) return 'contact';
  return 'other';
}

export const isKind = (k) => Object.hasOwn(LINK_KINDS, k);
