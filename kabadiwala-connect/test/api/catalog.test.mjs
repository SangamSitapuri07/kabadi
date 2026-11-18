import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateEstimate, categoryName, rateValue, utcTimestamp } from '../../apps/api/dist/catalog.js';

test('category and rate inputs are bounded and timestamps are unambiguous UTC', () => {
  assert.equal(categoryName('  ਕਾਗਜ਼  '), 'ਕਾਗਜ਼');
  for (const value of ['', '  ', 'x'.repeat(101), 'a\nb', '\ud800', null]) assert.equal(categoryName(value), null);
  assert.equal(rateValue(0), 0); assert.equal(rateValue(1000000000), 1000000000);
  for (const value of [-1, 1.1, 1000000001, '3', NaN, null]) assert.equal(rateValue(value), null);
  assert.equal(utcTimestamp('2030-01-01T00:00:00.000Z'), '2030-01-01T00:00:00.000Z');
  for (const value of ['2030-01-01', '2030-01-01T00:00:00Z', '2030-02-30T00:00:00.000Z', '2030-01-01T00:00:00.000+05:30', null]) assert.equal(utcTimestamp(value), null);
});
test('estimate uses exact integer arithmetic and refuses unapproved half-paise ties', () => {
  assert.deepEqual(calculateEstimate(1000, 1200), {amountPaise:'1200'});
  assert.deepEqual(calculateEstimate(1499, 1), {amountPaise:'1'});
  assert.deepEqual(calculateEstimate(1501, 1), {amountPaise:'2'});
  assert.deepEqual(calculateEstimate(1500, 1), {roundingRequired:true});
  assert.deepEqual(calculateEstimate(10000000, 1000000000), {amountPaise:'10000000000000'});
  assert.deepEqual(calculateEstimate(9999999, 999999999), {amountPaise:'9999998990000'});
  assert.deepEqual(calculateEstimate(5, 0), {amountPaise:'0'});
  for (const pair of [[0,2],[-1,2],[1.1,2],[10000001,2],[3, -1],[3, 1.2],['1', 5]]) assert.equal(calculateEstimate(...pair), null);
});
