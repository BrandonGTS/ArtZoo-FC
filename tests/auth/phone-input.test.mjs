import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import {
  mainlandPhoneDigits,
  mainlandPhoneInput,
  mainlandPhoneE164,
  validateMainlandPhone
} from '../../apps/web/components/account/phone-input.ts';
test('mainland national and country-prefixed inputs share one E.164 identity', () => {
  for (const value of [
    '13800138000',
    '+8613800138000',
    '008613800138000',
    ' 138 0013 8000 ',
    '+86 138-0013-8000'
  ]) {
    assert.equal(mainlandPhoneDigits(value), '13800138000');
    assert.equal(mainlandPhoneInput(value), '13800138000');
    assert.equal(mainlandPhoneE164(value), '+8613800138000');
  }
});
test('non-mainland, landline, short and malformed numbers are rejected without losing the input', async () => {
  for (const value of [
    '+85261234567',
    '+886912345678',
    '+12025550100',
    '01012345678',
    '12800138000',
    '1380013800',
    '138001380000',
    '13800138000x',
    '１３８００１３８０００',
    '+86',
    '138'
  ]) {
    assert.equal(mainlandPhoneDigits(value), null);
    assert.equal(mainlandPhoneInput(value), value);
    assert.throws(() => mainlandPhoneE164(value));
    await assert.rejects(validateMainlandPhone(null, value));
  }
});
test('empty and non-string values fail form validation', async () => {
  for (const value of ['', ' ', null, undefined, 13800138000])
    await assert.rejects(validateMainlandPhone(null, value));
  await validateMainlandPhone(null, '13800138000');
});

test('client and actual server mainland policy agree on accepted and rejected inputs', () => {
  const accepted = [
    '13800138000',
    '+8613800138000',
    '008613800138000',
    ' 138 0013 8000 ',
    '+86 138-0013-8000'
  ];
  const rejected = [
    '+85261234567',
    '+886912345678',
    '+12025550100',
    '01012345678',
    '12800138000',
    '1380013800',
    '138001380000',
    '13800138000x',
    '１３８００１３８０００',
    '+86'
  ];
  for (const value of accepted) assert.equal(mainlandPhoneE164(value), mainlandChinaPhone.normalize(value));
  for (const value of rejected) {
    assert.equal(mainlandPhoneDigits(value), null);
    assert.throws(() => mainlandChinaPhone.normalize(value));
  }
  assert.equal(mainlandChinaPhone.ready, true);
  assert.equal(mainlandChinaPhone.defaultRegion, 'CN');
});
