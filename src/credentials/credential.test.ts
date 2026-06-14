import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import {
  CREDENTIAL_TYPES,
  isCredential,
  isPairCredential,
  isSingleValueCredential,
  type Credential,
} from './credential';

function baseFields() {
  return {
    id: 'uuid-1',
    name: 'test',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  };
}

describe('Credential type system', () => {
  it('CREDENTIAL_TYPES enumerates all 6 PRD-addendum types', () => {
    assert.equal(CREDENTIAL_TYPES.length, 6);
    assert.deepEqual([...CREDENTIAL_TYPES].sort(), [
      'api-key',
      'env-var-name',
      'json-blob',
      'string',
      'token',
      'user/password-pair',
    ]);
  });

  it('isPairCredential narrows on user/password-pair', () => {
    const c: Credential = {
      ...baseFields(),
      type: 'user/password-pair',
      fields: {
        fieldA: { label: 'access_key_id', value: 'AKIA' },
        fieldB: { label: 'secret_access_key', value: 'XYZ' },
      },
    };
    assert.equal(isPairCredential(c), true);
    if (isPairCredential(c)) {
      assert.equal(c.fields.fieldA.label, 'access_key_id');
    }
  });

  it('isSingleValueCredential narrows on string/api-key/token/json-blob/env-var-name', () => {
    const types = ['string', 'api-key', 'token', 'json-blob', 'env-var-name'] as const;
    for (const t of types) {
      const c: Credential = { ...baseFields(), type: t, value: 'v' };
      assert.equal(isSingleValueCredential(c), true);
      if (isSingleValueCredential(c)) {
        assert.equal(c.value, 'v');
      }
    }
  });

  describe('isCredential validation', () => {
    it('accepts a well-formed string credential', () => {
      const c = { ...baseFields(), type: 'string', value: 'hello' };
      assert.equal(isCredential(c), true);
    });

    it('accepts a well-formed pair credential', () => {
      const c = {
        ...baseFields(),
        type: 'user/password-pair',
        fields: {
          fieldA: { label: 'l', value: 'v' },
          fieldB: { label: 'l2', value: 'v2' },
        },
      };
      assert.equal(isCredential(c), true);
    });

    it('rejects null and primitives', () => {
      assert.equal(isCredential(null), false);
      assert.equal(isCredential('string'), false);
      assert.equal(isCredential(123), false);
      assert.equal(isCredential(undefined), false);
    });

    it('rejects missing id', () => {
      const c = { name: 'n', type: 'string', value: 'v', created: 'c', updated: 'u' };
      assert.equal(isCredential(c), false);
    });

    it('rejects empty id', () => {
      const c = { ...baseFields(), id: '', type: 'string', value: 'v' };
      assert.equal(isCredential(c), false);
    });

    it('rejects unknown type', () => {
      const c = { ...baseFields(), type: 'not-a-real-type', value: 'v' };
      assert.equal(isCredential(c), false);
    });

    it('rejects pair credential missing fieldA', () => {
      const c = {
        ...baseFields(),
        type: 'user/password-pair',
        fields: { fieldB: { label: 'l', value: 'v' } },
      };
      assert.equal(isCredential(c), false);
    });

    it('rejects single-value credential missing value', () => {
      const c = { ...baseFields(), type: 'string' };
      assert.equal(isCredential(c), false);
    });
  });
});
