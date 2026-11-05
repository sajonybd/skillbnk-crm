import { api } from './api.js';
import { toast } from './util.js';

// Called when someone opens a lead's LinkedIn page from the CRM. The server keeps it to one
// log per person, per lead, per kind, per day, so clicking again never creates duplicates.
export function trackVisit(leadId, kind, name, onLogged = () => {}) {
  api('POST', `/api/leads/${leadId}/visit`, { kind })
    .then((r) => {
      if (!r.logged) return;
      toast(`${kind === 'company' ? 'Company page' : 'Profile'} visit logged${name ? ' · ' + name : ''}`);
      onLogged();
    })
    .catch(() => {});
}

// Attach to a link element: fires on normal click and middle-click (open in new tab).
export function watchVisit(el, leadId, kind, name, onLogged) {
  const go = () => trackVisit(leadId, kind, name, onLogged);
  el.addEventListener('click', go);
  el.addEventListener('auxclick', (e) => { if (e.button === 1) go(); });
  return el;
}
