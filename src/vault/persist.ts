import { Result } from '../result/result';
import type { VaultError } from '../result/errors';
import { CryptoError } from '../result/errors';
import { encrypt } from './crypto';
import { serializeEnvelope } from './envelope';
import { CURRENT_VAULT_VERSION } from './format-version';
import { PROJECTS_DIR, writeVaultEntry } from './io';
import { zeroBuffer } from './memory-zero';
import type { VaultSession } from './vault-session';
import type { Credential } from '../credentials/credential';

/**
 * Re-encrypt the current session's credentials and write `meta.json` +
 * `keys.enc` atomically.
 *
 * Story 1.11 / 1.13 — used by Add / Edit / Delete flows after mutating the
 * credentials array. The salt stays constant (per vault entry); only the
 * nonce changes per encrypt.
 *
 * The caller updates `session.setCredentials(...)` BEFORE calling this.
 * On success, the on-disk state matches the in-memory session.
 */
export async function persistVault(session: VaultSession): Promise<Result<void, VaultError>> {
  if (!session.isUnlocked()) {
    return Result.err(CryptoError.wrongPassphrase());
  }

  const key = session.borrowDerivedKey();
  const salt = session.getSalt();
  const projectMeta = session.getProjectMeta();
  const created = session.getCreatedAt();
  const credsResult = session.getCredentials();

  if (key === null || salt === null || projectMeta === null || created === null) {
    return Result.err(CryptoError.wrongPassphrase());
  }
  if (!credsResult.ok) {
    return credsResult;
  }
  const credentials: readonly Credential[] = credsResult.value;

  const innerPayload = Buffer.from(
    JSON.stringify({
      version: CURRENT_VAULT_VERSION,
      created,
      updated: new Date().toISOString(),
      project: projectMeta,
      credentials,
    }),
    'utf8',
  );

  const encResult = encrypt(innerPayload, key);
  zeroBuffer(innerPayload);
  if (!encResult.ok) {
    return encResult;
  }

  const envelope = serializeEnvelope(
    CURRENT_VAULT_VERSION,
    salt,
    encResult.value.nonce,
    encResult.value.ciphertext,
  );

  const metaJson = Buffer.from(
    JSON.stringify({
      version: 1,
      fingerprint: projectMeta.fingerprint,
      fingerprintSource: projectMeta.fingerprintSource,
      displayName: projectMeta.displayName,
      gitRemoteUrl: projectMeta.gitRemoteUrl,
      lastKnownPath: projectMeta.lastKnownPath,
      tentativeMissAt: null,
    }),
    'utf8',
  );

  return writeVaultEntry(PROJECTS_DIR, projectMeta.fingerprint, metaJson, envelope);
}
