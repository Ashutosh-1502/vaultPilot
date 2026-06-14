import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { errorToUserMessage } from './error-to-message';
import type { VaultError } from '../result/errors';

const ALL_SUBTYPES: VaultError[] = [
  { kind: 'crypto.decrypt-failed' },
  { kind: 'crypto.kdf-timeout' },
  { kind: 'crypto.wrong-passphrase' },
  { kind: 'keychain.unavailable' },
  { kind: 'keychain.evicted' },
  { kind: 'keychain.write-failed' },
  { kind: 'drive.auth-expired' },
  { kind: 'drive.network-failed' },
  { kind: 'drive.quota-exceeded' },
  { kind: 'drive.upload-interrupted' },
  { kind: 'format.version-unsupported', foundVersion: 99 },
  { kind: 'format.corrupted' },
  { kind: 'format.missing-header' },
  { kind: 'fs.disk-full' },
  { kind: 'fs.permission-denied', path: '/tmp/x' },
  { kind: 'fs.atomic-write-failed', path: '/tmp/x' },
];

describe('errorToUserMessage', () => {
  it('every VaultError subtype maps to a non-empty string', () => {
    for (const e of ALL_SUBTYPES) {
      const m = errorToUserMessage(e);
      assert.ok(m.length > 0, `empty message for kind=${e.kind}`);
    }
  });

  it('messages for distinct kinds are distinct strings', () => {
    // Two entries share `network-failed` (with/without cause is the same kind),
    // and {fs.permission-denied} + {fs.atomic-write-failed} both interpolate
    // path, so the distinct count equals the kind count.
    const messages = new Set(ALL_SUBTYPES.map((e) => errorToUserMessage(e)));
    const kinds = new Set(ALL_SUBTYPES.map((e) => e.kind));
    assert.equal(messages.size, kinds.size);
  });

  it('no message contains the substring "undefined" (interpolation hygiene)', () => {
    for (const e of ALL_SUBTYPES) {
      const m = errorToUserMessage(e);
      assert.ok(!m.includes('undefined'), `bad interpolation for kind=${e.kind}: ${m}`);
    }
  });

  it('version-unsupported message contains the found version number', () => {
    const m = errorToUserMessage({ kind: 'format.version-unsupported', foundVersion: 7 });
    assert.match(m, /\b7\b/);
  });

  it('fs error messages contain the path', () => {
    const m = errorToUserMessage({ kind: 'fs.permission-denied', path: '/abc/def' });
    assert.match(m, /\/abc\/def/);
  });
});
