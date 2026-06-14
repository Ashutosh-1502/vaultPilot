import { Result } from '../result/result';
import type { VaultError } from '../result/errors';
import { CryptoError, VaultFormatError } from '../result/errors';

import { decrypt, deriveKey, init as cryptoInit } from './crypto';
import { parseEnvelope, peekVersion } from './envelope';
import { checkSupported } from './format-version';
import { PROJECTS_DIR, readVaultEntry } from './io';
import { isCredential, type Credential } from '../credentials/credential';
import type { ProjectMetadata, UnlockInput, VaultSession } from './vault-session';

/**
 * Load a vault entry from disk and decrypt it into the session.
 *
 * Story 1.10 (auto-unlock) + Story 1.7 (re-prompt on miss) — the loader:
 *   1. Reads `meta.json` + `keys.enc` (and `keys.enc.tmp` if present per OQ-8).
 *   2. Peeks the format version; refuses future versions (FR-5).
 *   3. Decrypts with the supplied key (Buffer). Caller owns the key buffer.
 *   4. On success, unlocks the session and TRANSFERS ownership of the key.
 *
 * If the primary `keys.enc` fails to decrypt but a `keys.enc.tmp` sibling
 * exists, the loader attempts recovery per OQ-8.
 */
export async function loadAndUnlockVault(
  session: VaultSession,
  fingerprint: string,
  derivedKey: Buffer,
): Promise<Result<void, VaultError>> {
  await cryptoInit();

  const entryResult = await readVaultEntry(PROJECTS_DIR, fingerprint);
  if (!entryResult.ok) return entryResult;
  if (entryResult.value === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const { meta, keys, recoveryKeys } = entryResult.value;

  // Decrypt primary; if it fails AND a recovery .tmp sibling exists, try that.
  let inner = keys === null ? null : tryDecrypt(keys, derivedKey);
  if ((inner === null || !inner.ok) && recoveryKeys !== null) {
    const recoveryResult = tryDecrypt(recoveryKeys, derivedKey);
    if (recoveryResult.ok) {
      inner = recoveryResult;
    }
  }
  if (inner === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  if (!inner.ok) {
    return inner;
  }

  // Parse the inner JSON payload and extract project meta + credentials.
  let payload: unknown;
  try {
    payload = JSON.parse(inner.value.plaintext.toString('utf8'));
  } catch {
    return Result.err(VaultFormatError.corrupted());
  }
  if (typeof payload !== 'object' || payload === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const p = payload as Record<string, unknown>;
  if (typeof p['created'] !== 'string') {
    return Result.err(VaultFormatError.corrupted());
  }
  if (typeof p['project'] !== 'object' || p['project'] === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const projectMeta = parseProjectMeta(p['project']);
  if (projectMeta === null) {
    return Result.err(VaultFormatError.corrupted());
  }

  const credentialsRaw = p['credentials'];
  if (!Array.isArray(credentialsRaw)) {
    return Result.err(VaultFormatError.corrupted());
  }
  const credentials: Credential[] = [];
  for (const c of credentialsRaw) {
    if (!isCredential(c)) {
      return Result.err(VaultFormatError.corrupted());
    }
    credentials.push(c);
  }

  // Verify meta.json structure (we don't fail if minor drift, but ignore meta
  // for unlocking purposes — the encrypted payload is authoritative).
  void meta;

  const input: UnlockInput = {
    fingerprint,
    derivedKey,
    salt: inner.value.salt,
    created: p['created'],
    projectMeta,
    credentials,
  };
  session.unlock(input);
  return Result.ok(undefined);
}

/**
 * Derive the key from a passphrase and unlock. Used by the re-prompt flow
 * when SecretStorage has no cached key (FR-47, FR-49).
 */
export async function unlockWithPassphrase(
  session: VaultSession,
  fingerprint: string,
  passphrase: Buffer,
): Promise<Result<{ derivedKey: Buffer }, VaultError>> {
  await cryptoInit();

  // Read just enough to extract the salt without decrypting twice
  const entryResult = await readVaultEntry(PROJECTS_DIR, fingerprint);
  if (!entryResult.ok) return entryResult;
  if (entryResult.value === null || entryResult.value.keys === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const peekResult = peekVersion(entryResult.value.keys);
  if (!peekResult.ok) return peekResult;
  const checkResult = checkSupported(peekResult.value);
  if (!checkResult.ok) return checkResult;
  const parsed = parseEnvelope(entryResult.value.keys);
  if (!parsed.ok) return parsed;

  const keyResult = await deriveKey(passphrase, parsed.value.salt);
  if (!keyResult.ok) return keyResult;
  const derivedKey = keyResult.value;

  const unlockResult = await loadAndUnlockVault(session, fingerprint, derivedKey);
  if (!unlockResult.ok) {
    // unlock failed — derivedKey is still owned by us; wipe it
    derivedKey.fill(0);
    return unlockResult;
  }
  // On success, session owns derivedKey now. Return a reference for the
  // caller to re-cache in SecretStorage.
  return Result.ok({ derivedKey });
}

interface DecryptedInner {
  plaintext: Buffer;
  salt: Uint8Array;
}

function tryDecrypt(
  envelopeBytes: Buffer,
  key: Buffer,
): Result<DecryptedInner, VaultError> {
  const peek = peekVersion(envelopeBytes);
  if (!peek.ok) return peek;
  const supported = checkSupported(peek.value);
  if (!supported.ok) return supported;

  const parsed = parseEnvelope(envelopeBytes);
  if (!parsed.ok) return parsed;

  const decResult = decrypt(parsed.value.ciphertext, parsed.value.nonce, key);
  if (!decResult.ok) {
    return decResult.error.kind === 'crypto.wrong-passphrase'
      ? Result.err(CryptoError.wrongPassphrase())
      : decResult;
  }
  return Result.ok({ plaintext: decResult.value, salt: parsed.value.salt });
}

function parseProjectMeta(value: unknown): ProjectMetadata | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p['fingerprint'] !== 'string') return null;
  const src = p['fingerprintSource'];
  if (src !== 'git-remote' && src !== 'manifest-name' && src !== 'absolute-path') return null;
  if (typeof p['displayName'] !== 'string') return null;
  if (typeof p['lastKnownPath'] !== 'string') return null;
  const remoteUrl = p['gitRemoteUrl'];
  if (remoteUrl !== null && typeof remoteUrl !== 'string') return null;

  return {
    fingerprint: p['fingerprint'],
    fingerprintSource: src,
    displayName: p['displayName'],
    gitRemoteUrl: remoteUrl,
    lastKnownPath: p['lastKnownPath'],
  };
}
