import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import * as tar from 'tar';

import { Result } from '../result/result';
import type { VaultError } from '../result/errors';
import { DriveError } from '../result/errors';
import {
  ARCHIVE_DIR,
  PROJECTS_DIR,
  VAULT_ROOT,
  ensureVaultRoot,
  makeDirectory,
  pathExists,
  readDirectoryEntries,
  removePath,
  renamePath,
} from '../vault/io';
import type { DriveClient } from './client';

/**
 * Drive restore flow (Story 3.3 — FR-36, FR-37, FR-39, FR-42).
 *
 * Two-step API:
 *   1. `prepareRestore(...)` — download + extract into a staging directory;
 *      report whether local content exists so the caller can show the chooser.
 *   2. `applyRestoreDecision(...)` — apply the user's choice (Overwrite /
 *      Keep Local / Cancel). On Overwrite, move existing content to
 *      `.trash-<ts>/` first; rollback on failure mid-restore.
 *
 * Filesystem operations route through `src/vault/io.ts` helpers per the
 * file-system boundary.
 */

export type RestoreDecision = 'overwrite' | 'keep-local' | 'cancel';

export interface RestoreInput {
  readonly canonicalName: string;
}

export interface RestorePreparedState {
  readonly stagingDir: string;
  readonly localHasContent: boolean;
}

export async function prepareRestore(
  client: DriveClient,
  input: RestoreInput,
): Promise<Result<RestorePreparedState, VaultError>> {
  const filesResult = await client.listAppdataFilesByName(input.canonicalName);
  if (!filesResult.ok) return filesResult;
  const file = filesResult.value[0];
  if (file === undefined) {
    return Result.err(DriveError.networkFailed('no backup file found in Drive appdata'));
  }

  const downloadResult = await client.downloadFile(file.id);
  if (!downloadResult.ok) return downloadResult;
  const archiveBytes = downloadResult.value;

  const ensure = await ensureVaultRoot();
  if (!ensure.ok) return ensure;

  const stagingDir = path.join(VAULT_ROOT, `.restore-staging-${Date.now().toString()}`);
  const stageResult = await extractToStaging(archiveBytes, stagingDir);
  if (!stageResult.ok) {
    await removePath(stagingDir);
    return stageResult;
  }

  // FR-38 defense-in-depth: refuse archives that include traversal paths.
  const escapeCheck = await assertStagingEntriesContained(stagingDir);
  if (!escapeCheck.ok) {
    await removePath(stagingDir);
    return escapeCheck;
  }

  const localHasContent =
    (await dirHasContent(PROJECTS_DIR)) || (await dirHasContent(ARCHIVE_DIR));

  return Result.ok({ stagingDir, localHasContent });
}

export async function applyRestoreDecision(
  state: RestorePreparedState,
  decision: RestoreDecision,
): Promise<Result<void, VaultError>> {
  if (decision === 'cancel' || decision === 'keep-local') {
    await removePath(state.stagingDir);
    return Result.ok(undefined);
  }

  // Overwrite path.
  const trashDir = path.join(VAULT_ROOT, `.trash-${Date.now().toString()}`);
  let movedProjects = false;
  let movedArchive = false;
  try {
    if (await pathExists(PROJECTS_DIR)) {
      const r = await renamePath(PROJECTS_DIR, path.join(trashDir, 'projects'));
      if (!r.ok) return r;
      movedProjects = true;
    }
    if (await pathExists(ARCHIVE_DIR)) {
      const r = await renamePath(ARCHIVE_DIR, path.join(trashDir, 'archive'));
      if (!r.ok) {
        // Roll back the projects/ move so the local state is consistent.
        if (movedProjects) {
          await renamePath(path.join(trashDir, 'projects'), PROJECTS_DIR);
        }
        return r;
      }
      movedArchive = true;
    }

    // Move staging entries into place.
    const stagingEntries = await readDirectoryEntries(state.stagingDir);
    if (!stagingEntries.ok) {
      await rollback(trashDir, movedProjects, movedArchive);
      return stagingEntries;
    }
    for (const name of stagingEntries.value) {
      const moveResult = await renamePath(
        path.join(state.stagingDir, name),
        path.join(VAULT_ROOT, name),
      );
      if (!moveResult.ok) {
        await rollback(trashDir, movedProjects, movedArchive);
        return moveResult;
      }
    }
    await removePath(state.stagingDir);
    return Result.ok(undefined);
  } catch (err) {
    await rollback(trashDir, movedProjects, movedArchive);
    return Result.err(DriveError.networkFailed(`restore apply failed: ${String(err)}`));
  }
}

async function rollback(
  trashDir: string,
  movedProjects: boolean,
  movedArchive: boolean,
): Promise<void> {
  if (movedProjects) {
    await renamePath(path.join(trashDir, 'projects'), PROJECTS_DIR);
  }
  if (movedArchive) {
    await renamePath(path.join(trashDir, 'archive'), ARCHIVE_DIR);
  }
}

async function dirHasContent(dir: string): Promise<boolean> {
  const entries = await readDirectoryEntries(dir);
  return entries.ok && entries.value.length > 0;
}

async function extractToStaging(
  archiveBytes: Buffer,
  stagingDir: string,
): Promise<Result<void, VaultError>> {
  const mkResult = await makeDirectory(stagingDir);
  if (!mkResult.ok) return mkResult;
  try {
    await pipeline(
      Readable.from(archiveBytes),
      tar.extract({ cwd: stagingDir, strict: true }) as unknown as NodeJS.WritableStream,
    );
    return Result.ok(undefined);
  } catch (err) {
    return Result.err(DriveError.networkFailed(`extract failed: ${String(err)}`));
  }
}

async function assertStagingEntriesContained(
  stagingDir: string,
): Promise<Result<void, VaultError>> {
  const entries = await readDirectoryEntries(stagingDir);
  if (!entries.ok) return entries;
  for (const name of entries.value) {
    if (name.includes('..') || path.isAbsolute(name)) {
      return Result.err(
        DriveError.networkFailed(
          `restore archive contains a path that escapes the vault root: ${name}`,
        ),
      );
    }
  }
  return Result.ok(undefined);
}
