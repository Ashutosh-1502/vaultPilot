import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import * as tar from 'tar';

import { Result } from '../result/result';
import { DriveError } from '../result/errors';
import { VAULT_ROOT, listVaultEntries, pathExists } from '../vault/io';
import type { DriveClient, DriveFile } from './client';

/**
 * Drive backup with FR-50 atomicity (Story 3.2).
 *
 * Sequence:
 *   1. Build a tar archive of `~/.vaultpilot/` (projects/ + archive/ + config.json).
 *      Only files under VAULT_ROOT are included (FR-38).
 *   2. Compute MD5 of the tar bytes locally.
 *   3. Upload to a temp file named `<canonicalName>.uploading` in the Drive
 *      appdata folder.
 *   4. Verify Drive's returned `size` + `md5Checksum` match the local bytes.
 *   5. Find any pre-existing canonical backup file → mark for deletion.
 *   6. Rename the uploaded file from `<canonicalName>.uploading` → `<canonicalName>`.
 *   7. Delete the pre-existing backup file(s) (FR-50 stale-temp tolerance:
 *      multiple `<canonicalName>` files from prior interrupted runs are all
 *      cleaned up; the new one is the only canonical).
 *
 * On any step failure: the prior `<canonicalName>` remains intact. The
 * `.uploading` file is left in place and overwritten on the next attempt.
 */

export interface BackupInput {
  readonly canonicalName: string; // e.g., "vaultpilot-backup"
}

export interface BackupReport {
  readonly bytesUploaded: number;
  readonly md5: string;
  readonly canonicalFileId: string;
}

export async function backupToDrive(
  client: DriveClient,
  input: BackupInput,
): Promise<Result<BackupReport, DriveError>> {
  // 1. Build the tar archive (only under VAULT_ROOT — FR-38 invariant).
  const tarBytes = await buildVaultArchive();
  if (!tarBytes.ok) return tarBytes;

  // 2. Local MD5.
  const localMd5 = createHash('md5').update(tarBytes.value).digest('hex');
  const localSize = tarBytes.value.length;

  // 3. Upload to temp name.
  const tempName = `${input.canonicalName}.uploading`;
  const uploadResult = await client.uploadAppdataFile(tempName, tarBytes.value);
  if (!uploadResult.ok) return uploadResult;
  const uploaded = uploadResult.value;

  // 4. Verify size + md5.
  const verifyResult = verifyUpload(uploaded, localSize, localMd5);
  if (!verifyResult.ok) {
    // Leave the temp file in place; it'll be overwritten on next attempt.
    return verifyResult;
  }

  // 5. Find existing canonical (may be 0, 1, or N — handle all).
  const existingResult = await client.listAppdataFilesByName(input.canonicalName);
  if (!existingResult.ok) return existingResult;
  const existing = existingResult.value;

  // 6. Atomic rename: PATCH temp → canonical name.
  const renameResult = await client.renameFile(uploaded.id, input.canonicalName);
  if (!renameResult.ok) return renameResult;

  // 7. Delete any prior canonical file(s). Best-effort — failure to delete an
  //    old file doesn't compromise the new backup; the user can clean up via
  //    Drive UI if needed.
  for (const file of existing) {
    if (file.id !== uploaded.id) {
      void (await client.deleteFile(file.id));
    }
  }

  return Result.ok({
    bytesUploaded: localSize,
    md5: localMd5,
    canonicalFileId: renameResult.value.id,
  });
}

/**
 * Verify the uploaded Drive file's metadata matches what we sent.
 * Drive returns `size` as a string (decimal); we compare as numbers.
 */
function verifyUpload(
  uploaded: DriveFile,
  localSize: number,
  localMd5: string,
): Result<void, DriveError> {
  const driveSize = typeof uploaded.size === 'number' ? uploaded.size : Number(uploaded.size);
  if (driveSize !== localSize) {
    return Result.err(DriveError.uploadInterrupted());
  }
  if (uploaded.md5Checksum !== undefined && uploaded.md5Checksum !== localMd5) {
    return Result.err(DriveError.uploadInterrupted());
  }
  return Result.ok(undefined);
}

/**
 * Build a tar archive of `~/.vaultpilot/` and return its bytes.
 *
 * FR-38: only files under VAULT_ROOT are included. The tar library packs
 * paths relative to `cwd: VAULT_ROOT`, so the archive's entries are
 * `projects/...`, `archive/...`, `config.json` — never absolute paths and
 * never any escape into project directories.
 */
async function buildVaultArchive(): Promise<Result<Buffer, DriveError>> {
  if (!(await pathExists(VAULT_ROOT))) {
    return Result.err(DriveError.networkFailed('vault root does not exist; nothing to back up'));
  }

  // Determine which subpaths actually exist (tar.c throws on missing).
  const entries: string[] = [];
  const projectsResult = await listVaultEntries(`${VAULT_ROOT}/projects`);
  if (projectsResult.ok && projectsResult.value.length > 0) {
    entries.push('projects');
  }
  const archiveResult = await listVaultEntries(`${VAULT_ROOT}/archive`);
  if (archiveResult.ok && archiveResult.value.length > 0) {
    entries.push('archive');
  }
  if (await pathExists(`${VAULT_ROOT}/config.json`)) {
    entries.push('config.json');
  }
  if (entries.length === 0) {
    return Result.err(DriveError.networkFailed('vault is empty; nothing to back up'));
  }

  try {
    const stream = tar.create(
      {
        cwd: VAULT_ROOT,
        gzip: false,
        portable: true,
      },
      entries,
    ) as unknown as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Result.ok(Buffer.concat(chunks));
  } catch (err) {
    return Result.err(DriveError.networkFailed(`tar build failed: ${String(err)}`));
  }
}
