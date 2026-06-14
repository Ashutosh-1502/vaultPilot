// The "sumo" build is required for argon2id (`crypto_pwhash_*`); the base
// The "sumo" build is required for argon2id (`crypto_pwhash_*`); the base
// `libsodium-wrappers` package omits password-hashing primitives.
import sodium from 'libsodium-wrappers-sumo';

import { Result } from '../result/result';
import { CryptoError } from '../result/errors';

/**
 * Cryptography core.
 *
 * Story 1.4 — KDF (argon2id) + symmetric AEAD (XChaCha20-Poly1305) via
 * libsodium-wrappers-sumo. No native compile required (WASM-backed).
 *
 * Architecture decisions locked here:
 *   - Symmetric AEAD: XChaCha20-Poly1305 (192-bit nonce, no collision risk on random nonces).
 *   - KDF: argon2id, parameters `OPSLIMIT_INTERACTIVE` + `MEMLIMIT_INTERACTIVE`.
 *     Targets ~1s on consumer hardware (NFR-2).
 *   - Hash for fingerprints lives in src/fingerprint/compute.ts (Node `crypto.createHash`).
 *
 * Wrong-passphrase detection: a decrypt with a key derived from the wrong
 * passphrase fails the AEAD auth tag verification. This implementation maps
 * that throw to `CryptoError.wrong-passphrase`. There is no rate-limit or
 * lockout in the module (FR-48).
 */

let initialized = false;

/**
 * Ensure libsodium-wrappers-sumo is ready. Idempotent. MUST be awaited before any
 * other function in this module is called.
 */
export async function init(): Promise<void> {
  if (!initialized) {
    await sodium.ready;
    initialized = true;
  }
}

export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const AUTH_TAG_BYTES = 16;

/**
 * Generate a cryptographically-secure random salt for argon2id.
 * MUST be called only after `init()` resolves.
 */
export function generateSalt(): Uint8Array {
  return sodium.randombytes_buf(SALT_BYTES);
}

/**
 * Generate a cryptographically-secure random nonce for XChaCha20-Poly1305.
 * Regenerate on every re-encrypt.
 */
export function generateNonce(): Uint8Array {
  return sodium.randombytes_buf(NONCE_BYTES);
}

/**
 * Derive an encryption key from a passphrase via argon2id with the
 * INTERACTIVE preset. Returns a 32-byte key suitable for XChaCha20-Poly1305.
 *
 * The caller MUST `zeroBuffer(key)` when the key reference is no longer
 * needed. Typically callers wrap the derive+use in `withZeroedBufferAsync`.
 */
// `deriveKey` returns a Promise to keep the call signature future-proof if
// libsodium ever moves to async, but the current libsodium-wrappers-sumo KDF is
// synchronous (WASM). Returning a wrapped Promise instead of using `async`
// keeps the function passing `require-await` while preserving the public type.
export function deriveKey(
  passphrase: Buffer,
  salt: Uint8Array,
): Promise<Result<Buffer, CryptoError>> {
  if (!initialized) {
    return Promise.resolve(Result.err(CryptoError.kdfTimeout()));
  }
  if (salt.length !== SALT_BYTES) {
    return Promise.resolve(Result.err(CryptoError.decryptFailed()));
  }
  try {
    const derived = sodium.crypto_pwhash(
      KEY_BYTES,
      passphrase,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    return Promise.resolve(Result.ok(Buffer.from(derived)));
  } catch {
    // libsodium throws on OOM or invalid params. Map to kdf-timeout per FR-48
    // (KDF cost is the only friction; this is the "argon2id couldn't run" case).
    return Promise.resolve(Result.err(CryptoError.kdfTimeout()));
  }
}

/**
 * Encrypt plaintext with XChaCha20-Poly1305. Returns the random nonce and
 * the ciphertext (which includes the 16-byte auth tag appended).
 */
export function encrypt(
  plaintext: Buffer,
  key: Buffer,
): Result<{ nonce: Uint8Array; ciphertext: Uint8Array }, CryptoError> {
  if (!initialized) {
    return Result.err(CryptoError.decryptFailed());
  }
  if (key.length !== KEY_BYTES) {
    return Result.err(CryptoError.decryptFailed());
  }
  try {
    const nonce = sodium.randombytes_buf(NONCE_BYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      null,
      null,
      nonce,
      key,
    );
    return Result.ok({ nonce, ciphertext });
  } catch {
    return Result.err(CryptoError.decryptFailed());
  }
}

/**
 * Decrypt XChaCha20-Poly1305 ciphertext. Auth tag mismatch returns
 * `wrong-passphrase` (the most likely cause when the key is wrong); other
 * decrypt errors return `decrypt-failed`.
 *
 * libsodium-wrappers-sumo throws on auth tag mismatch; we catch and map.
 */
export function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Buffer,
): Result<Buffer, CryptoError> {
  if (!initialized) {
    return Result.err(CryptoError.decryptFailed());
  }
  if (key.length !== KEY_BYTES) {
    return Result.err(CryptoError.decryptFailed());
  }
  if (nonce.length !== NONCE_BYTES) {
    return Result.err(CryptoError.decryptFailed());
  }
  if (ciphertext.length < AUTH_TAG_BYTES) {
    return Result.err(CryptoError.decryptFailed());
  }
  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      nonce,
      key,
    );
    return Result.ok(Buffer.from(plaintext));
  } catch {
    // Auth tag mismatch is overwhelmingly "wrong key" in our usage. The
    // `decrypt-failed` subtype is reserved for structural issues (truncated
    // input, etc.), so we report `wrong-passphrase` for the common case.
    return Result.err(CryptoError.wrongPassphrase());
  }
}
