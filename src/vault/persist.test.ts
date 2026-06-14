import * as assert from 'node:assert/strict';
import { describe, it, before } from 'mocha';

import { VaultSession, type SessionEventEmitter } from './vault-session';
import { persistVault } from './persist';
import { Result } from '../result/result';
import type { Credential } from '../credentials/credential';
import { init as cryptoInit, decrypt, deriveKey, encrypt, generateSalt } from './crypto';
import { parseEnvelope, serializeEnvelope } from './envelope';

/**
 * persist.test.ts exercises the re-encrypt + write path against a real
 * libsodium round-trip. Full persistVault integration (which writes to the
 * real `~/.vaultpilot/projects/`) is covered by the integration test suite
 * (deferred).
 *
 * Here we focus on the in-session pure-logic preconditions:
 *   - persistVault returns wrong-passphrase when session is locked.
 *   - encrypt + envelope + decrypt round-trip preserves credentials.
 */
function makeEmitter<T>(): SessionEventEmitter<T> {
  const listeners: ((data: T) => void)[] = [];
  return {
    event: (l) => {
      listeners.push(l);
      return {
        dispose: () => {
          listeners.splice(listeners.indexOf(l), 1);
        },
      };
    },
    fire: (data) => {
      for (const l of listeners) l(data);
    },
    dispose: () => {
      listeners.length = 0;
    },
  };
}

describe('persistVault', () => {
  it('returns wrong-passphrase when session is locked', async () => {
    const session = new VaultSession(makeEmitter<undefined>(), makeEmitter<undefined>());
    const r = await persistVault(session);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'crypto.wrong-passphrase');
    }
  });

  describe('envelope + decrypt round-trip (hermetic)', () => {
    before(async () => {
      await cryptoInit();
    });

    it('re-encrypt produces a decryptable envelope', async () => {
      // Set up: derive a key, encrypt a credentials list, serialize envelope.
      const passphrase = Buffer.from('test-passphrase-12345', 'utf8');
      const salt = generateSalt();
      const keyResult = await deriveKey(passphrase, salt);
      if (!Result.isOk(keyResult)) {
        assert.fail('deriveKey failed');
        return;
      }
      const key = keyResult.value;

      const credentials: Credential[] = [
        {
          id: 'uuid-1',
          name: 'test-cred',
          type: 'string',
          value: 'my-secret',
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
      ];

      const innerPayload = Buffer.from(
        JSON.stringify({ version: 1, credentials }),
        'utf8',
      );
      const encResult = encrypt(innerPayload, key);
      if (!Result.isOk(encResult)) {
        assert.fail('encrypt failed');
        return;
      }
      const envelope = serializeEnvelope(
        1,
        salt,
        encResult.value.nonce,
        encResult.value.ciphertext,
      );

      // Parse + decrypt
      const parsed = parseEnvelope(envelope);
      if (!Result.isOk(parsed)) {
        assert.fail('parseEnvelope failed');
        return;
      }
      assert.equal(parsed.value.version, 1);
      assert.deepEqual(Array.from(parsed.value.salt), Array.from(salt));

      const decResult = decrypt(parsed.value.ciphertext, parsed.value.nonce, key);
      assert.equal(decResult.ok, true);
      if (!Result.isOk(decResult)) return;

      const decoded = JSON.parse(decResult.value.toString('utf8')) as {
        credentials: Credential[];
      };
      assert.equal(decoded.credentials.length, 1);
      assert.equal(decoded.credentials[0]?.name, 'test-cred');
    });
  });
});
