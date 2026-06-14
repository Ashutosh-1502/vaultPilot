import { Result } from '../../../result/result';
import type { VaultError } from '../../../result/errors';
import { CryptoError } from '../../../result/errors';
import { readArchivedEntry } from '../../../archive/archive-decrypt';
import type { Credential } from '../../../credentials/credential';
import { ARCHIVE_DIR, PROJECTS_DIR, pathExists } from '../../../vault/io';
import * as path from 'node:path';
import type { VaultSession } from '../../../vault/vault-session';
import { decrypt, init as cryptoInit } from '../../../vault/crypto';
import { parseEnvelope } from '../../../vault/envelope';
import { readVaultEntry } from '../../../vault/io';
import { isCredential } from '../../../credentials/credential';
import { VaultFormatError } from '../../../result/errors';

/**
 * Load + decrypt the credentials for ANY project on the system (active or
 * archived). Uses VaultSession's per-fingerprint key cache:
 *   - For the current workspace's vault, the primary `derivedKey` is used.
 *   - For other projects, the per-fingerprint cache (from `archive-decrypt`)
 *     is used. If the key isn't cached, returns `wrong-passphrase` so the
 *     caller can prompt the user.
 *
 * The webview's "Unlock Vault" button maps to a passphrase prompt that
 * populates the cache; on retry, this function will succeed.
 */
export async function loadProjectCredentials(
  session: VaultSession,
  fingerprint: string,
): Promise<Result<readonly Credential[], VaultError>> {
  // Case 1: this fingerprint is the currently-active workspace vault.
  if (session.getFingerprint() === fingerprint) {
    const creds = session.getCredentials();
    return creds;
  }

  // Case 2: archived entry — use the archived-key cache pattern.
  const archiveDir = path.join(ARCHIVE_DIR, fingerprint);
  const projectsDir = path.join(PROJECTS_DIR, fingerprint);

  if (await pathExists(archiveDir)) {
    const view = await readArchivedEntry(session, fingerprint);
    if (!view.ok) return view;
    return Result.ok(view.value.credentials);
  }

  // Case 3: active entry that's NOT the current workspace's vault. Same
  // per-fingerprint cache pattern, but reading from PROJECTS_DIR.
  if (!(await pathExists(projectsDir))) {
    return Result.err(VaultFormatError.corrupted());
  }

  const cachedKey = session.borrowArchivedKey(fingerprint);
  if (cachedKey === null) {
    // No key cached for this fingerprint yet — caller must prompt.
    return Result.err(CryptoError.wrongPassphrase());
  }

  await cryptoInit();
  const entry = await readVaultEntry(PROJECTS_DIR, fingerprint);
  if (!entry.ok) return entry;
  if (entry.value === null || entry.value.keys === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const parsed = parseEnvelope(entry.value.keys);
  if (!parsed.ok) return parsed;

  const dec = decrypt(parsed.value.ciphertext, parsed.value.nonce, cachedKey);
  if (!dec.ok) return dec;

  let payload: unknown;
  try {
    payload = JSON.parse(dec.value.toString('utf8'));
  } catch {
    return Result.err(VaultFormatError.corrupted());
  }
  if (typeof payload !== 'object' || payload === null) {
    return Result.err(VaultFormatError.corrupted());
  }
  const raw = (payload as { credentials?: unknown }).credentials;
  if (!Array.isArray(raw)) return Result.err(VaultFormatError.corrupted());
  const credentials: Credential[] = [];
  for (const c of raw) {
    if (!isCredential(c)) return Result.err(VaultFormatError.corrupted());
    credentials.push(c);
  }
  return Result.ok(credentials);
}
