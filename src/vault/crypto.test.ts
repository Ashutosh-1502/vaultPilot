import * as assert from 'node:assert/strict';
import { describe, it, before } from 'mocha';

import {
  AUTH_TAG_BYTES,
  KEY_BYTES,
  NONCE_BYTES,
  SALT_BYTES,
  decrypt,
  deriveKey,
  encrypt,
  generateNonce,
  generateSalt,
  init,
} from './crypto';
import { Result } from '../result/result';

describe('crypto', () => {
  before(async () => {
    await init();
  });

  it('init is idempotent', async () => {
    await init();
    await init();
    assert.ok(true);
  });

  it('generateSalt returns SALT_BYTES of random data', () => {
    const salt = generateSalt();
    assert.equal(salt.length, SALT_BYTES);
    const salt2 = generateSalt();
    assert.notDeepEqual(Array.from(salt), Array.from(salt2));
  });

  it('generateNonce returns NONCE_BYTES of random data', () => {
    const nonce = generateNonce();
    assert.equal(nonce.length, NONCE_BYTES);
  });

  describe('deriveKey', () => {
    it('produces a KEY_BYTES key', async () => {
      const salt = generateSalt();
      const r = await deriveKey(Buffer.from('correct-horse-battery-staple', 'utf8'), salt);
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.value.length, KEY_BYTES);
      }
    });

    it('deterministic: same passphrase + salt → same key', async () => {
      const salt = generateSalt();
      const passphrase = Buffer.from('passphrase', 'utf8');
      const a = await deriveKey(passphrase, salt);
      const b = await deriveKey(passphrase, salt);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      if (a.ok && b.ok) {
        assert.deepEqual(Array.from(a.value), Array.from(b.value));
      }
    });

    it('different salt → different key', async () => {
      const passphrase = Buffer.from('passphrase', 'utf8');
      const a = await deriveKey(passphrase, generateSalt());
      const b = await deriveKey(passphrase, generateSalt());
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      if (a.ok && b.ok) {
        assert.notDeepEqual(Array.from(a.value), Array.from(b.value));
      }
    });

    it('rejects invalid salt length', async () => {
      const r = await deriveKey(Buffer.from('pw', 'utf8'), new Uint8Array(8));
      assert.equal(r.ok, false);
    });

    it('NFR-2 budget: deriveKey completes within 1.2 seconds (20% headroom)', async function () {
      // Mocha test-level timeout: allow 5s to be safe against cold-start jitter,
      // but the assertion enforces the 1200ms budget.
      this.timeout(5000);
      const salt = generateSalt();
      const passphrase = Buffer.from('performance-test', 'utf8');
      const start = Date.now();
      const r = await deriveKey(passphrase, salt);
      const elapsed = Date.now() - start;
      assert.equal(r.ok, true);
      assert.ok(
        elapsed < 1200,
        `deriveKey took ${String(elapsed)}ms — exceeds NFR-2 budget of 1200ms`,
      );
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trip recovers exact plaintext bytes', async () => {
      const salt = generateSalt();
      const keyResult = await deriveKey(Buffer.from('pw', 'utf8'), salt);
      assert.equal(keyResult.ok, true);
      if (!Result.isOk(keyResult)) return;
      const key = keyResult.value;

      const plaintext = Buffer.from('secret payload 🔐', 'utf8');
      const encResult = encrypt(plaintext, key);
      assert.equal(encResult.ok, true);
      if (!Result.isOk(encResult)) return;

      const decResult = decrypt(encResult.value.ciphertext, encResult.value.nonce, key);
      assert.equal(decResult.ok, true);
      if (!Result.isOk(decResult)) return;
      assert.deepEqual(Array.from(decResult.value), Array.from(plaintext));
    });

    it('ciphertext tampering yields wrong-passphrase (auth tag mismatch)', async () => {
      const salt = generateSalt();
      const keyResult = await deriveKey(Buffer.from('pw', 'utf8'), salt);
      if (!Result.isOk(keyResult)) {
        assert.fail('deriveKey failed');
        return;
      }
      const key = keyResult.value;

      const encResult = encrypt(Buffer.from('hello'), key);
      if (!Result.isOk(encResult)) {
        assert.fail('encrypt failed');
        return;
      }
      const tampered = Buffer.from(encResult.value.ciphertext);
      tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);

      const decResult = decrypt(tampered, encResult.value.nonce, key);
      assert.equal(decResult.ok, false);
      if (!decResult.ok) {
        assert.equal(decResult.error.kind, 'crypto.wrong-passphrase');
      }
    });

    it('wrong key yields wrong-passphrase', async () => {
      const salt = generateSalt();
      const keyA = await deriveKey(Buffer.from('pw-a', 'utf8'), salt);
      const keyB = await deriveKey(Buffer.from('pw-b', 'utf8'), salt);
      if (!Result.isOk(keyA) || !Result.isOk(keyB)) {
        assert.fail('deriveKey failed');
        return;
      }

      const encResult = encrypt(Buffer.from('hello'), keyA.value);
      if (!Result.isOk(encResult)) {
        assert.fail('encrypt failed');
        return;
      }

      const decResult = decrypt(encResult.value.ciphertext, encResult.value.nonce, keyB.value);
      assert.equal(decResult.ok, false);
      if (!decResult.ok) {
        assert.equal(decResult.error.kind, 'crypto.wrong-passphrase');
      }
    });

    it('rejects malformed inputs', () => {
      const badKey = Buffer.alloc(KEY_BYTES);
      const r1 = decrypt(new Uint8Array(5), new Uint8Array(NONCE_BYTES), badKey);
      assert.equal(r1.ok, false);
      const r2 = decrypt(new Uint8Array(100), new Uint8Array(5), badKey);
      assert.equal(r2.ok, false);
      const r3 = decrypt(new Uint8Array(100), new Uint8Array(NONCE_BYTES), Buffer.alloc(8));
      assert.equal(r3.ok, false);
    });

    it('auth tag is appended (ciphertext length = plaintext + AUTH_TAG_BYTES)', async () => {
      const salt = generateSalt();
      const keyResult = await deriveKey(Buffer.from('pw', 'utf8'), salt);
      if (!Result.isOk(keyResult)) return;

      const plaintext = Buffer.from('hello world');
      const encResult = encrypt(plaintext, keyResult.value);
      if (!Result.isOk(encResult)) {
        assert.fail('encrypt failed');
        return;
      }
      assert.equal(encResult.value.ciphertext.length, plaintext.length + AUTH_TAG_BYTES);
    });
  });
});
