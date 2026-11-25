// Fit pre-screen: before the 5-minute research, VERIFY the CRM facts on LinkedIn (current role and company size) and apply the size and authority rules.
// Read-only. It never skips a lead on CRM data alone: if LinkedIn cannot be read, the lead goes on to the normal research.
// Needs globals from sidepanel.js and sweep.js (openBg, runIn, humanPause, slugOf, cfg, log, crm, liveNote).
const SIZE_LIMIT = { training: 20, other: 100 }; // training centers 20 max, companies and nonprofits 100 max (rulebook v8, CEO rule 19 Nov 2026)
const AUTHORITY = /\b(owner|founder|co-?founder|ceo|chief|president|principal|partner|managing director|executive director|director|vp|vice president|head of|general manager)\b/i;
const NO_AUTHORITY = /\b(supervisor|specialist|coordinator|assistant|associate|analyst|representative|trainer|instructor|facilitator|administrator|manager|lead)\b/i;
const TRAINING_ORG = /training|coaching|academy|school|college|educat|learning|instruction|apprentice|workforce/i;

function pageReadCompany() {
  if (/\/(login|uas\/login|checkpoint|authwall)/i.test(location.href)) return { signin: true };
  const body = (document.querySelector('main')?.innerText || document.body.innerText || '').replace(/[ \t]+/g, ' ');
  const num = (s) => Number(String(s).replace(/,/g, ''));
  let lo = 0, hi = 0, label = '';
  let m = /(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)\s+employees/i.exec(body);
  if (m) { lo = num(m[1]); hi = num(m[2]); label = m[1] + '-' + m[2]; }
  else if ((m = /(\d[\d,]*)\+\s+employees/i.exec(body))) { lo = num(m[1]); hi = 1e9; label = m[1] + '+'; }
  else if ((m = /\b(\d[\d,]*)\s+employees\b/i.exec(body))) { lo = hi = num(m[1]); label = m[1]; }
  const ind = (/Industry\s*\n?\s*([^\n]{3,60})/i.exec(body) || [])[1] || '';
  return { lo, hi, label, industry: ind.trim(), name: (document.querySelector('h1')?.innerText || '').trim().slice(0, 80) };
}

const companySlug = (u) => (/linkedin\.com\/company\/([^/?#]+)/i.exec(u || '') || [])[1] || '';
const crmSize = (v) => { const m = String(v || '').replace(/,/g, '').match(/\d+/g); return m ? Number(m[m.length - 1]) : 0; };

async function prescreen(lead) {
  const out = { skip: false, reasons: [], facts: {} };
  try {
    // A lead we already talk to is never pre-screened out: it goes to the reply / meeting path.
    if (lead.outreach_status || lead.verdict || lead.rules_version || /replied|meeting|customer|partner/i.test(lead.stage || '')) { out.facts.note = 'active relationship, not pre-screened'; return out; }
    liveNote(`Pre-screen ${lead.first_name} ${lead.last_name}: checking the role and company size on LinkedIn`);
    const slug = slugOf(lead.linkedin); let head = '';
    if (slug) {
      const tabId = await openBg(`https://www.linkedin.com/in/${slug}/`);
      const p = await runIn(tabId, pageReadProfile);
      if (p && !p.signin) { head = (p.top || '').split('\n').slice(0, 14).join(' | '); out.facts.profile = head.slice(0, 300); }
      try { await crm('POST', `/api/leads/${lead.id}/activities`, { type: 'linkedin_view', note: 'Pre-screen: opened the profile' }); } catch {}
    }
    const cs = companySlug(lead.company_linkedin);
    let co = null;
    if (cs) {
      await humanPause(1500, 3500);
      const tabId = await openBg(`https://www.linkedin.com/company/${cs}/about/`);
      co = await runIn(tabId, pageReadCompany);
      if (co && !co.signin && co.lo) out.facts.company = co;
    }
    // role: the headline on the profile first, the CRM title second
    const role = (head.split('|').slice(1, 5).join(' ') + ' ' + (lead.title || '')).trim();
    const hasAuth = AUTHORITY.test(role); const weak = !hasAuth && NO_AUTHORITY.test(role);
    const isTraining = TRAINING_ORG.test((co?.industry || '') + ' ' + (lead.industry || '') + ' ' + (lead.company || ''));
    const limit = isTraining ? SIZE_LIMIT.training : SIZE_LIMIT.other;
    // differences between the CRM and what LinkedIn shows
    const diffs = [];
    if (co?.lo) {
      const was = crmSize(lead.employees);
      if (was && (was < co.lo * 0.7 || was > Math.min(co.hi, co.lo * 4) * 1.3)) diffs.push(`employees: CRM ${lead.employees}, LinkedIn ${co.label}`);
      if (!was) diffs.push(`employees: CRM blank, LinkedIn ${co.label}`);
    }
    if (head && lead.company) { const w = String(lead.company).toLowerCase().split(/\W+/).filter((x) => x.length > 3)[0]; if (w && !head.toLowerCase().includes(w)) diffs.push(`company "${lead.company}" is not in the LinkedIn headline (check he or she still works there)`); }
    out.facts.diffs = diffs; out.facts.role = role.slice(0, 120); out.facts.limit = limit;
    // the rules, applied to verified numbers only
    if (co?.lo && co.lo > limit && !hasAuth) out.reasons.push(`${isTraining ? 'Training organization' : 'Company'} with ${co.label} employees (limit ${limit}) and a role without authority`);
    else if (co?.lo && co.lo > limit * 3) out.reasons.push(`${isTraining ? 'Training organization' : 'Company'} with ${co.label} employees, far over the limit of ${limit}`);
    else if (co?.lo && co.lo > limit && weak) out.reasons.push(`${co.label} employees (limit ${limit}) and the role looks like a manager or specialist, not the buyer`);
    out.skip = out.reasons.length > 0;
    // write what was verified back to the CRM so the next person does not redo it
    if (diffs.length || out.skip) {
      const note = `Pre-screen ${new Date().toISOString().slice(0, 10)} (LinkedIn, read-only): ` + (out.skip ? 'LIKELY SKIP, ' + out.reasons.join('; ') + '. ' : 'goes on to research. ') + (diffs.length ? 'CRM differs: ' + diffs.join('; ') + '. ' : '') + (out.facts.role ? 'Role seen: ' + out.facts.role + '.' : '');
      await crm('POST', `/api/leads/${lead.id}/activities`, { type: 'note', note: note.slice(0, 900) });
      if (co?.label && diffs.some((d) => d.startsWith('employees'))) { try { await crm('PATCH', `/api/leads/${lead.id}`, { employees: co.label }); } catch {} }
      if (out.skip) {
        const next = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
        try { await crm('PATCH', `/api/leads/${lead.id}`, { next_action: 'Pre-screen says likely SKIP: confirm (check both inboxes first), then mark SKIP', next_action_date: next }); } catch {}
      }
    }
  } catch (e) { log('Pre-screen could not finish for ' + lead.first_name + ': ' + e.message + ' (going on to the research)', 'err'); out.skip = false; }
  return out;
}
