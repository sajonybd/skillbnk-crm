// Fit hints for a lead, worked out only from what is already recorded (headcount and job title).
// These are SUGGESTIONS for a person to check. Nothing here changes a lead, a verdict or a dropdown.
// Rules come from the outreach rules v8: more than 50 employees = big company (skip as a direct customer),
// 10–50 is the sweet spot, under 10 is nurture, and a contact who cannot decide cannot be a PURSUE lead.

const nums = (s) => (String(s ?? '').replace(/,/g, '').match(/\d+/g) || []).map(Number);

// -> { band: 'big' | 'sweet' | 'small' | 'unknown', lo, hi }
export function sizeOf(employees) {
  const n = nums(employees);
  if (!n.length) return { band: 'unknown' };
  const plus = /\+/.test(String(employees));
  const lo = n[0];
  const hi = plus ? Infinity : n.length > 1 ? n[1] : n[0];
  if (lo > 50) return { band: 'big', lo, hi };
  if (hi < 10) return { band: 'small', lo, hi };
  if (lo >= 10 && hi <= 50) return { band: 'sweet', lo, hi };
  return { band: 'unknown', lo, hi }; // a range that crosses a line, for example 11–200
}

const VP = /\b(vp|svp|evp|vice[- ]president)\b/i;
const LOW_FIRST = /\b(assistant|associate|coordinator|intern|receptionist)\b/i;
const DM = /\b(founder|co-?founder|owner|co-?owner|proprietor|ceo|chief|president|principal|managing (director|partner|member)|executive director|general manager|coo|cfo|cto)\b/i;
const MAYBE = /\b(head of|director|partner|vice[- ]president)\b/i;
const LOW = /\b(manager|specialist|trainer|instructor|analyst|administrator|recruiter|advisor|adviser|representative|supervisor|officer|educator|facilitator|team lead|generalist|executive assistant)\b/i;

// -> 'dm' | 'maybe' | 'low' | 'unknown'
export function authorityOf(title) {
  const t = String(title ?? '').trim();
  if (!t) return 'unknown';
  if (VP.test(t)) return 'maybe';
  if (LOW_FIRST.test(t)) return 'low';
  if (DM.test(t)) return 'dm';
  if (MAYBE.test(t)) return 'maybe';
  if (LOW.test(t)) return 'low';
  return 'unknown';
}

const SIZE_TEXT = {
  big: ['red', 'Over 50 employees: a big company. Suggest SKIP as a direct customer.'],
  sweet: ['green', '10–50 employees: the sweet spot.'],
  small: ['amber', 'Under 10 employees: suggest NURTURE unless a clear need is shown.'],
  unknown: ['grey', 'Headcount not clear: find it first (suggest QUALIFY, no invite yet).'],
};
const AUTH_TEXT = {
  dm: ['green', 'Title suggests a decision maker.'],
  maybe: ['amber', 'Director / VP / head: check whether they can decide.'],
  low: ['red', 'Title suggests they cannot decide: not a PURSUE lead. Find the owner or CEO.'],
  unknown: ['grey', 'Title does not show authority: check it.'],
};

// Extra signals, shown for information only. They never change the suggestion (location never qualifies a lead).
const MI = /\b(michigan|mich\.?)\b/i;
const TRAIN = /\b(train(ing|er|ers)?|learning|academy|coach(es|ing)?|education(al)?|school|workforce|instruct(ion|or|ors)?|certification|skills?|l&d|upskill\w*|onboarding)\b/i;
export function signalsOf(lead) {
  const state = String(lead.state || '').trim();
  const place = [lead.city, lead.state, lead.country].filter(Boolean).join(', ');
  const mi = MI.test(place) || /^mi$/i.test(state);
  const us = /united states|usa|^us$/i.test(String(lead.country || '')) || (!lead.country && !!state);
  const loc = mi ? ['green', 'Michigan: first priority. Verify the location before writing "fellow Michigander".']
    : us ? ['amber', `Elsewhere in the USA${place ? ' (' + place + ')' : ''}: nurture and relationship first; no meeting without a conversation.`]
    : place ? ['amber', `Outside the USA (${place}): needs the owner's approval; India gets strict screening.`]
    : ['grey', 'Location not recorded: find it.'];
  const tr = TRAIN.test([lead.industry, lead.company].join(' '))
    ? ['green', 'Training-related by industry or company name. Check: do they SELL training (a provider) or train their own staff?']
    : ['grey', 'No training signal in the industry or company name: check what they do.'];
  return { loc_tone: loc[0], loc_text: loc[1], michigan: mi, train_tone: tr[0], train_text: tr[1], training: tr[0] === 'green' };
}

// One suggestion from the two signals. A person confirms it.
export function fitOf(lead) {
  const size = sizeOf(lead.employees).band;
  const authority = authorityOf(lead.title);
  let suggest, why;
  if (size === 'big') { suggest = 'skip'; why = authority === 'low' ? 'Big company and a contact who cannot decide.' : 'Big company (over 50 employees).'; }
  else if (size === 'small') { suggest = 'nurture'; why = 'Under 10 employees.'; }
  else if (size === 'unknown') { suggest = 'qualify'; why = 'Headcount is missing or unclear.'; }
  else if (authority === 'low') { suggest = 'qualify'; why = 'Right size, but this contact probably cannot decide. Find the owner or CEO.'; }
  else if (authority === 'dm') { suggest = 'good'; why = 'Right size and a decision maker by title.'; }
  else { suggest = 'qualify'; why = 'Right size; check that this contact has authority.'; }
  return {
    ...signalsOf(lead),
    size, authority, suggest, why,
    size_tone: SIZE_TEXT[size][0], size_text: SIZE_TEXT[size][1],
    auth_tone: AUTH_TEXT[authority][0], auth_text: AUTH_TEXT[authority][1],
  };
}
