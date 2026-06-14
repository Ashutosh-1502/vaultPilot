import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import * as tar from 'tar';

import { Result } from '../result/result';
import type { VaultError } from '../result/errors';
import { DriveError } from '../result/errors';
import { decrypt, deriveKey, init as cryptoInit } from '../vault/crypto';
import { parseEnvelope, peekVersion } from '../vault/envelope';
import { checkSupported } from '../vault/format-version';
import { isCredential } from '../credentials/credential';
import type { DriveClient } from './client';

/**
 * Inspect what's in the Drive backup WITHOUT touching local state.
 *
 * Downloads the tar archive to a temp directory, extracts it, and decrypts
 * each project's envelope with the supplied passphrase. Returns a summary:
 * for each project, the display name, fingerprint, status, and the list of
 * credential names (values stay encrypted in memory and are not returned).
 *
 * The temp directory is removed in `finally`, even on error. The supplied
 * passphrase Buffer is NOT zeroed here — the caller owns its lifecycle.
 */

export interface ProjectInspection {
  readonly fingerprint: string;
  readonly displayName: string;
  readonly status: 'active' | 'archived';
  /** 'unlocked' if the supplied passphrase decrypted this project; 'locked' if a different passphrase is needed. */
  readonly unlockState: 'unlocked' | 'locked';
  /** Empty when unlockState === 'locked'. */
  readonly credentialNames: readonly string[];
}

export interface BackupInspection {
  readonly fileBytes: number;
  readonly projects: readonly ProjectInspection[];
}

export async function inspectDriveBackup(
  client: DriveClient,
  canonicalName: string,
  passphrase: Buffer,
): Promise<Result<BackupInspection, VaultError>> {
  const list = await client.listAppdataFilesByName(canonicalName);
  if (!list.ok) return list;
  const file = list.value[0];
  if (file === undefined) {
    return Result.err(DriveError.networkFailed('no backup file found in Drive appdata'));
  }

  const download = await client.downloadFile(file.id);
  if (!download.ok) return download;
  const archiveBytes = download.value;

  const tempDir = path.join(
    tmpdir(),
    `vaultpilot-inspect-${Date.now().toString()}-${String(process.pid)}`,
  );
  await fs.mkdir(tempDir, { recursive: true });

  try {
    await pipeline(
      Readable.from(archiveBytes),
      tar.extract({ cwd: tempDir, strict: true }) as unknown as NodeJS.WritableStream,
    );

    await cryptoInit();
    const projects: ProjectInspection[] = [];

    for (const status of ['active', 'archived'] as const) {
      const subdir = status === 'active' ? 'projects' : 'archive';
      const dir = path.join(tempDir, subdir);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const fingerprint of entries) {
        const inspection = await inspectOneProject(dir, fingerprint, status, passphrase);
        if (!inspection.ok) return inspection;
        if (inspection.value !== null) projects.push(inspection.value);
      }
    }

    return Result.ok({
      fileBytes: archiveBytes.length,
      projects,
    });
  } catch (err) {
    return Result.err(DriveError.networkFailed(`inspect failed: ${String(err)}`));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function inspectOneProject(
  baseDir: string,
  fingerprint: string,
  status: 'active' | 'archived',
  passphrase: Buffer,
): Promise<Result<ProjectInspection | null, VaultError>> {
  const projDir = path.join(baseDir, fingerprint);
  const metaPath = path.join(projDir, 'meta.json');
  const keysPath = path.join(projDir, 'keys.enc');

  let metaRaw: string;
  let keysBuf: Buffer;
  try {
    metaRaw = await fs.readFile(metaPath, 'utf8');
    keysBuf = await fs.readFile(keysPath);
  } catch {
    return Result.ok(null);
  }

  let meta: { displayName?: string; fingerprint?: string };
  try {
    meta = JSON.parse(metaRaw) as { displayName?: string; fingerprint?: string };
  } catch {
    return Result.ok(null);
  }

  const peek = peekVersion(keysBuf);
  if (!peek.ok) return peek;
  const supported = checkSupported(peek.value);
  if (!supported.ok) return supported;

  const parsed = parseEnvelope(keysBuf);
  if (!parsed.ok) return parsed;

  const keyResult = await deriveKey(passphrase, parsed.value.salt);
  if (!keyResult.ok) return keyResult;
  const derivedKey = keyResult.value;

  const decResult = decrypt(parsed.value.ciphertext, parsed.value.nonce, derivedKey);
  derivedKey.fill(0);
  if (!decResult.ok) {
    // Different passphrase for this project — surface as 'locked' rather than
    // failing the whole inspection. Users commonly share one passphrase across
    // projects but the architecture allows per-project passphrases.
    return Result.ok({
      fingerprint: meta.fingerprint ?? fingerprint,
      displayName: meta.displayName ?? fingerprint,
      status,
      unlockState: 'locked',
      credentialNames: [],
    });
  }

  let payload: { credentials?: unknown };
  try {
    payload = JSON.parse(decResult.value.toString('utf8')) as { credentials?: unknown };
  } catch {
    return Result.ok(null);
  }
  decResult.value.fill(0);

  const raw = payload.credentials;
  if (!Array.isArray(raw)) return Result.ok(null);
  const credentialNames: string[] = [];
  for (const c of raw) {
    if (isCredential(c)) credentialNames.push(c.name);
  }

  return Result.ok({
    fingerprint: meta.fingerprint ?? fingerprint,
    displayName: meta.displayName ?? fingerprint,
    status,
    unlockState: 'unlocked',
    credentialNames,
  });
}
