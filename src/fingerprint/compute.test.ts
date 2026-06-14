import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { computeFingerprint } from './compute';

describe('computeFingerprint', () => {
  it('returns a 16-hex-character string', () => {
    const fp = computeFingerprint('github.com/user/repo');
    assert.equal(fp.length, 16);
    assert.match(fp, /^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical inputs', () => {
    const a = computeFingerprint('github.com/user/repo');
    const b = computeFingerprint('github.com/user/repo');
    assert.equal(a, b);
  });

  it('different inputs yield different fingerprints', () => {
    const a = computeFingerprint('github.com/user/repo');
    const b = computeFingerprint('github.com/user/other-repo');
    assert.notEqual(a, b);
  });

  it('pins expected fingerprints for known canonical inputs (regression guard)', () => {
    // Pre-computed: first 16 hex of SHA-256(utf8(input)).
    // Verified via:  node -e "console.log(require('crypto').createHash('sha256').update('<input>', 'utf8').digest('hex').slice(0,16))"
    // If you change the truncation length or hash algorithm, regenerate these.
    assert.equal(computeFingerprint('github.com/user/repo'), '64aa633da2af4351');
  });

  it('handles unicode inputs', () => {
    const fp = computeFingerprint('github.com/usér/répo');
    assert.equal(fp.length, 16);
    assert.match(fp, /^[0-9a-f]{16}$/);
  });
});
