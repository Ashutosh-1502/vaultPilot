import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { CURRENT_VAULT_VERSION, checkSupported } from './format-version';

describe('format-version', () => {
  it('accepts version 1 (current)', () => {
    const r = checkSupported(1);
    assert.equal(r.ok, true);
  });

  it('accepts CURRENT_VAULT_VERSION', () => {
    const r = checkSupported(CURRENT_VAULT_VERSION);
    assert.equal(r.ok, true);
  });

  it('rejects future version with version-unsupported', () => {
    const r = checkSupported(CURRENT_VAULT_VERSION + 1);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.version-unsupported');
      if (r.error.kind === 'format.version-unsupported') {
        assert.equal(r.error.foundVersion, CURRENT_VAULT_VERSION + 1);
      }
    }
  });

  it('rejects version 0 as corrupted', () => {
    const r = checkSupported(0);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.corrupted');
    }
  });

  it('rejects negative version as corrupted', () => {
    const r = checkSupported(-1);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.corrupted');
    }
  });

  it('rejects non-integer version as corrupted', () => {
    const r = checkSupported(1.5);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.corrupted');
    }
  });

  it('rejects NaN as corrupted', () => {
    const r = checkSupported(NaN);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.corrupted');
    }
  });
});
