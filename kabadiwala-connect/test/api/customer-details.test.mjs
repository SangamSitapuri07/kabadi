import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomerDetails } from '../../apps/api/dist/customer-details.js';

const valid = { name: '  ਜਸਪ੍ਰੀਤ  ', addressLine: '  12 ਗਲੀ  ', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' };
test('customer details accept bounded Unicode and trim, without interpreting identity fields', () => {
  assert.deepEqual(parseCustomerDetails(valid), { ...valid, name: 'ਜਸਪ੍ਰੀਤ', addressLine: '12 ਗਲੀ' });
  assert.equal(parseCustomerDetails({ ...valid, userId: 'another-user' }), null);
  assert.equal(parseCustomerDetails({ ...valid, role: 'admin' }), null);
  assert.equal(parseCustomerDetails({ ...valid, addressLine: undefined }), null);
  assert.equal(parseCustomerDetails({ ...valid, city: '  ' }), null);
  assert.equal(parseCustomerDetails({ ...valid, city: '\u0000' }), null);
  assert.equal(parseCustomerDetails({ ...valid, city: 'x\ny' }), null);
  assert.equal(parseCustomerDetails({ ...valid, name: 'x'.repeat(101) }), null);
  assert.equal(parseCustomerDetails({ ...valid, name: '\ud800' }), null);
  assert.ok(parseCustomerDetails({ ...valid, name: '😀'.repeat(100) }));
  for (const input of [null, [], 'text', {}, 42]) assert.equal(parseCustomerDetails(input), null);
});
