import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeOf, authorityOf, fitOf } from '../server/lib/fit.js';

test('fit: size bands from headcount text', () => {
  assert.equal(sizeOf('12').band, 'sweet');
  assert.equal(sizeOf('11-50').band, 'sweet');
  assert.equal(sizeOf('50').band, 'sweet');
  assert.equal(sizeOf('51').band, 'sweet'); // limit raised from 50 to 100 on 19 Nov 2026
  assert.equal(sizeOf('101').band, 'big');
  assert.equal(sizeOf('101-200').band, 'big');
  assert.equal(sizeOf('51-200').band, 'unknown'); // crosses the 100 line
  assert.equal(sizeOf('1,001+').band, 'big');
  assert.equal(sizeOf('8').band, 'small');
  assert.equal(sizeOf('1-10').band, 'unknown'); // crosses the 10 line
  assert.equal(sizeOf('').band, 'unknown');
  assert.equal(sizeOf('11-200').band, 'unknown');
});

test('fit: authority from job title', () => {
  assert.equal(authorityOf('Founder & CEO'), 'dm');
  assert.equal(authorityOf('Co-Owner'), 'dm');
  assert.equal(authorityOf('Executive Director'), 'dm');
  assert.equal(authorityOf('Vice President of Operations'), 'maybe');
  assert.equal(authorityOf('VP, Sales'), 'maybe');
  assert.equal(authorityOf('Director of Training'), 'maybe');
  assert.equal(authorityOf('Training Manager'), 'low');
  assert.equal(authorityOf("Owner's Assistant"), 'low');
  assert.equal(authorityOf('Learning Coordinator'), 'low');
  assert.equal(authorityOf(''), 'unknown');
});

test('fit: one suggestion from size and title (a hint, never a verdict)', () => {
  assert.equal(fitOf({ employees: '300', title: 'Training Manager' }).suggest, 'skip');
  assert.equal(fitOf({ employees: '300', title: 'CEO' }).suggest, 'skip');
  assert.equal(fitOf({ employees: '6', title: 'Founder' }).suggest, 'nurture');
  assert.equal(fitOf({ employees: '', title: 'Founder' }).suggest, 'qualify');
  assert.equal(fitOf({ employees: '25', title: 'HR Coordinator' }).suggest, 'qualify');
  assert.equal(fitOf({ employees: '25', title: 'Director of L&D' }).suggest, 'qualify');
  assert.equal(fitOf({ employees: '25', title: 'Owner' }).suggest, 'good');
});

import { signalsOf } from '../server/lib/fit.js';
test('place and training signals', () => {
  const a = signalsOf({ city: 'Troy', state: 'Michigan', country: 'United States', industry: 'management consulting', company: 'WhizBang! Retail Training' });
  assert.equal(a.michigan, true); assert.equal(a.training, true); assert.equal(a.loc_tone, 'green');
  const b = signalsOf({ state: 'Ohio', country: 'United States', industry: 'logistics', company: 'Northfield Logistics' });
  assert.equal(b.michigan, false); assert.equal(b.training, false); assert.equal(b.loc_tone, 'amber');
  assert.equal(signalsOf({}).loc_tone, 'grey');
});

test('big company already in a meeting is not suggested for skip', () => {
  assert.equal(fitOf({ employees: '211', title: 'Director', stage: 'Contacted', outreach_status: 'U' }).suggest, 'skip');
  const f = fitOf({ employees: '211', title: 'Director', stage: 'Meeting Booked', outreach_status: 'M' });
  assert.equal(f.suggest, 'qualify');
  assert.equal(fitOf({ employees: '211', title: 'Director', stage: 'Contacted', outreach_status: 'R' }).suggest, 'qualify');
});

import { nonprofitOf } from '../server/lib/fit.js';
test('nonprofit signal', () => {
  assert.equal(nonprofitOf({ industry: 'nonprofit organization management', company: 'Jay Shop, Inc.' }), true);
  assert.equal(nonprofitOf({ industry: 'logistics', company: 'Northfield Logistics' }), false);
});

test('location in India is screened by place, never by name', () => {
  assert.equal(fitOf({ employees: '20', title: 'Founder', country: 'India', stage: 'New' }).suggest, 'skip');
  assert.equal(fitOf({ employees: '20', title: 'Founder', country: 'India', stage: 'Replied', outreach_status: 'R' }).suggest, 'good');
  // an Indian name in the USA is judged like anyone else
  const f = fitOf({ first_name: 'Anil', last_name: 'Bajnath', employees: '20', title: 'Founder', city: 'Troy', state: 'Michigan', country: 'United States' });
  assert.equal(f.suggest, 'good');
});

test('Company employee training: 101-200 own-staff companies are TRY, others stay skip (limit raised to 100 on 19 Nov 2026)', () => {
  const base = { title: 'Director', stage: 'New', outreach_status: 'U' };
  assert.equal(fitOf({ ...base, employees: '101-200', industry: 'restaurants', company: 'Evviva Trattoria' }).suggest, 'try');
  assert.equal(fitOf({ ...base, employees: '150', industry: 'manufacturing', company: 'Acme Parts' }).suggest, 'try');
  assert.equal(fitOf({ ...base, employees: '201-500', industry: 'pharmaceuticals', company: 'Accord' }).suggest, 'skip');
  assert.equal(fitOf({ ...base, employees: '101-200', industry: 'e-learning', company: 'Northfield Training Academy' }).suggest, 'skip');
  assert.equal(fitOf({ ...base, employees: '200+', industry: 'retail', company: 'Big Retail' }).suggest, 'skip');
});

test('size rule 19 Nov 2026: up to 100 employees is fine for a company, over 100 is big', () => {
  const base = { title: 'Founder', stage: 'New', outreach_status: 'U', industry: 'manufacturing', company: 'Acme Parts' };
  assert.equal(sizeOf('51-100').band, 'sweet');
  assert.equal(sizeOf('100').band, 'sweet');
  assert.equal(sizeOf('101').band, 'big');
  assert.equal(fitOf({ ...base, employees: '75' }).suggest, 'good');
  assert.equal(fitOf({ ...base, employees: '100' }).suggest, 'good');
  assert.equal(fitOf({ ...base, employees: '400' }).suggest, 'skip');
});

test('size rule 19 Nov 2026: a training center over 20 employees is skip', () => {
  const base = { title: 'Founder', stage: 'New', outreach_status: 'U' };
  const a = fitOf({ ...base, employees: '60', industry: 'e-learning', company: 'Learning Life' });
  assert.equal(a.suggest, 'skip'); assert.equal(a.size, 'trainbig');
  assert.equal(fitOf({ ...base, employees: '22', industry: 'professional training & coaching', company: 'Ignite Selling' }).suggest, 'skip');
  assert.equal(fitOf({ ...base, employees: '20', industry: 'professional training & coaching', company: 'Ignite Selling' }).suggest, 'good');
  assert.equal(fitOf({ ...base, employees: '12', industry: 'education management', company: 'Onsen Training' }).suggest, 'good');
  // a range that crosses 20 means: find the real headcount
  assert.equal(fitOf({ ...base, employees: '11-50', industry: 'professional training & coaching', company: 'Acme Academy' }).suggest, 'qualify');
  // a company that is not a training center keeps the 100 limit
  assert.equal(fitOf({ ...base, employees: '60', industry: 'construction', company: 'Acme Builders' }).suggest, 'good');
  // active relationships are exempt
  assert.equal(fitOf({ ...base, employees: '60', industry: 'e-learning', company: 'Learning Life', stage: 'Replied', outreach_status: 'R' }).suggest, 'qualify');
});

test('competitor: LMS or e-learning software company is skip', () => {
  const r = fitOf({ company: 'Acme Learning Management Systems', industry: 'Computer Software', employees: '11-50', title: 'CEO' });
  assert.equal(r.suggest, 'skip');
  assert.equal(r.competitor, true);
  assert.equal(fitOf({ company: 'Acme Plumbing', industry: 'Construction', employees: '11-50', title: 'CEO' }).competitor, false);
});
