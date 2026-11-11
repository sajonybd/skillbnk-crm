import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeOf, authorityOf, fitOf } from '../server/lib/fit.js';

test('fit: size bands from headcount text', () => {
  assert.equal(sizeOf('12').band, 'sweet');
  assert.equal(sizeOf('11-50').band, 'sweet');
  assert.equal(sizeOf('50').band, 'sweet');
  assert.equal(sizeOf('51').band, 'big');
  assert.equal(sizeOf('51-200').band, 'big');
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
