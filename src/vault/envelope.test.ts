import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { parseEnvelope, peekVersion, serializeEnvelope } from './envelope';

const salt = new Uint8Array(16).fill(0x11);
const nonce = new Uint8Array(24).fill(0x22);
const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

describe('envelope', () => {
  it('serialize → parse round-trip recovers all fields', () => {
    const bytes = serializeEnvelope(1, salt, nonce, ciphertext);
    const parsed = parseEnvelope(bytes);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.version, 1);
      assert.deepEqual(Array.from(parsed.value.salt), Array.from(salt));
      assert.deepEqual(Array.from(parsed.value.nonce), Array.from(nonce));
      assert.deepEqual(Array.from(parsed.value.ciphertext), Array.from(ciphertext));
    }
  });

  it('peekVersion reads version without parsing ciphertext', () => {
    const bytes = serializeEnvelope(42, salt, nonce, ciphertext);
    const v = peekVersion(bytes);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.value, 42);
    }
  });

  it('peekVersion on a future-version envelope returns the version (loader decides supportedness)', () => {
    const bytes = serializeEnvelope(99, salt, nonce, ciphertext);
    const v = peekVersion(bytes);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.value, 99);
    }
  });

  it('parseEnvelope fails on missing newline', () => {
    const garbage = Buffer.from('not-a-vault-envelope-no-newline-here', 'utf8');
    const r = parseEnvelope(garbage);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.missing-header');
    }
  });

  it('parseEnvelope fails on malformed header JSON', () => {
    const bad = Buffer.from('{not-json}\nABCD', 'utf8');
    const r = parseEnvelope(bad);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.corrupted');
    }
  });

  it('parseEnvelope fails on header missing salt/nonce fields', () => {
    const bad = Buffer.from('{"version":1}\nABCD', 'utf8');
    const r = parseEnvelope(bad);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.missing-header');
    }
  });

  it('parseEnvelope fails on empty ciphertext', () => {
    const bytes = serializeEnvelope(1, salt, nonce, new Uint8Array(0));
    // The base64 of empty bytes is "", which round-trips to a 0-length Buffer.
    const r = parseEnvelope(bytes);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'format.corrupted');
    }
  });
});
