import { Result } from '../result/result';
import type { VaultError } from '../result/errors';
import { CryptoError, VaultFormatError } from '../result/errors';
import { decrypt, deriveKey, init as cryptoInit } from '../vault/crypto';
import { parseEnvelope, peekVersion } from '../vault/envelope';
import { checkSupported } from '../vault/format-version';
import { ARCHIVE_DIR, readVaultEntry } from '../vault/io';
import { isCredential, type Credential } from '../credentials/credential';
import type { VaultSession } from '../vault/vault-session';

/**
 * Read + decrypt an archived vault entry.
 *
 * Each vault entry has its own salt, so the session's primary derived key
 * (cached for the active workspace) cannot decrypt archived entries. This
 * module looks up the per-fingerprint cache in `VaultSession.borrowArchivedKey`
 * first; on miss it returns `crypto.wrong-passphrase` so the caller can
 * prompt the user, derive a key, and cache it via
 * `VaultSession.cacheArchivedKey` before retrying.
 *
 * The decrypted credentials are returned to the caller (typically the
 * archive TreeView's `getChildren`); they are NOT held inside the
 * `VaultSession` (which is workspace-scoped).
 */

export interface ArchivedEntryView {
  readonly fingerprint: string;
  readonly credentials: readonly Credential[];
}

/**
 * Try to decrypt the archived entry using the cached per-fingerprint key.
 * Returns `crypto.wrong-passphrase` on cache miss so the caller can prompt.
 */
export async function readArchivedEntry(
  session: VaultSession,
  fingerprint: string,
): Promise<Result<ArchivedEntryView, VaultError>> {
  const cachedKey = session.borrowArchivedKey(fingerprint);
  if (cachedKey === null) {
    return Result.err(CryptoError.wrongPassphrase());
  }
  return decryptArchivedEntryWithKey(fingerprint, cachedKey);
}

/**
 * Derive a key from the passphrase for the archived entry's salt, validate
 * by attempting decrypt, then cache on the session if successful. Used by
 * the unlock-archived flow.
 *
 * Returns ownership of the key buffer to the session via `cacheArchivedKey`.
 */
export async function deriveAndCacheArchivedKey(
  session: VaultSession,
  fingerprint: string,
  passphrase: Buffer,
): Promise<Result<ArchivedEntryView, VaultError>> {
  await cryptoInit();
  const entryResult = await readVaultEntry(ARCHIVE_DIR, fingerprint);
  if (!entryResult.ok) return entryResult;
  if (entryResult.value === null || entryResult.value.keys === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const envelopeBytes = entryResult.value.keys;

  const peek = peekVersion(envelopeBytes);
  if (!peek.ok) return peek;
  const supported = checkSupported(peek.value);
  if (!supported.ok) return supported;

  const parsed = parseEnvelope(envelopeBytes);
  if (!parsed.ok) return parsed;

  const keyResult = await deriveKey(passphrase, parsed.value.salt);
  if (!keyResult.ok) return keyResult;
  const derivedKey = keyResult.value;

  const decResult = decrypt(parsed.value.ciphertext, parsed.value.nonce, derivedKey);
  if (!decResult.ok) {
    // Wrong passphrase for this entry — zero the just-derived key.
    derivedKey.fill(0);
    return decResult;
  }

  const credentialsResult = parseCredentialsPayload(decResult.value);
  if (!credentialsResult.ok) {
    derivedKey.fill(0);
    return credentialsResult;
  }

  // Decrypt succeeded — transfer ownership of the key to the session cache.
  session.cacheArchivedKey(fingerprint, derivedKey);
  return Result.ok({ fingerprint, credentials: credentialsResult.value });
}

/** Internal: decrypt with a key the session already has cached. */
async function decryptArchivedEntryWithKey(
  fingerprint: string,
  key: Buffer,
): Promise<Result<ArchivedEntryView, VaultError>> {
  await cryptoInit();
  const entryResult = await readVaultEntry(ARCHIVE_DIR, fingerprint);
  if (!entryResult.ok) return entryResult;
  if (entryResult.value === null || entryResult.value.keys === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const parsed = parseEnvelope(entryResult.value.keys);
  if (!parsed.ok) return parsed;

  const decResult = decrypt(parsed.value.ciphertext, parsed.value.nonce, key);
  if (!decResult.ok) return decResult;

  const credentialsResult = parseCredentialsPayload(decResult.value);
  if (!credentialsResult.ok) return credentialsResult;

  return Result.ok({ fingerprint, credentials: credentialsResult.value });
}

function parseCredentialsPayload(
  plaintext: Buffer,
): Result<readonly Credential[], VaultFormatError> {
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return Result.err(VaultFormatError.corrupted());
  }
  if (typeof payload !== 'object' || payload === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const p = payload as Record<string, unknown>;
  const raw = p['credentials'];
  if (!Array.isArray(raw)) {
    return Result.err(VaultFormatError.corrupted());
  }
  const credentials: Credential[] = [];
  for (const item of raw) {
    if (!isCredential(item)) {
      return Result.err(VaultFormatError.corrupted());
    }
    credentials.push(item);
  }
  return Result.ok(credentials);
}
