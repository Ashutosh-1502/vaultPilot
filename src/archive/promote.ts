import { Result } from '../result/result';
import { FilesystemError } from '../result/errors';
import { ARCHIVE_DIR, PROJECTS_DIR, moveVaultEntry, pathExists } from '../vault/io';
import * as path from 'node:path';

/**
 * Promote an archived vault entry back to active (Story 2.3, FR-30).
 *
 * Two flows trigger this:
 *   1. **Auto-promote on workspace open** — Story 1.10's workspace fingerprint
 *      resolution detects that the resolved fingerprint matches an entry
 *      currently in `archive/`. We promote it back to `projects/` before
 *      the TreeView renders.
 *   2. **Manual promote from archive list UI** — context-menu action on an
 *      archived TreeItem.
 *
 * Both paths use this single helper. The operation is a simple directory
 * rename via `moveVaultEntry`; the caller is responsible for any UI feedback
 * and for updating the cached key (if the user has a session unlocked for
 * the promoted entry).
 */

export async function promoteArchivedEntry(
  fingerprint: string,
): Promise<Result<void, FilesystemError>> {
  const archivedDir = path.join(ARCHIVE_DIR, fingerprint);
  const activeDir = path.join(PROJECTS_DIR, fingerprint);

  // Edge case (defensive): if BOTH archive/<fp>/ AND projects/<fp>/ exist,
  // refuse to promote. This shouldn't happen by invariant, but if it does,
  // promoting would silently merge or overwrite, which is wrong.
  const archivedExists = await pathExists(archivedDir);
  const activeExists = await pathExists(activeDir);

  if (!archivedExists) {
    // Nothing to promote.
    return Result.err(FilesystemError.atomicWriteFailed(archivedDir));
  }
  if (activeExists) {
    return Result.err(FilesystemError.atomicWriteFailed(activeDir));
  }

  return moveVaultEntry(ARCHIVE_DIR, PROJECTS_DIR, fingerprint);
}

/**
 * Check whether a given fingerprint corresponds to an archived entry.
 * Used by the workspace-open flow to decide whether to auto-promote.
 */
export async function isArchived(fingerprint: string): Promise<boolean> {
  const archivedDir = path.join(ARCHIVE_DIR, fingerprint);
  return pathExists(archivedDir);
}

/**
 * Manually archive an active vault entry (move from projects/ to archive/).
 * Inverse of `promoteArchivedEntry`. Used by the dashboard's per-project
 * Archive button.
 *
 * Defensive: refuses if the entry doesn't exist in projects/, or if an
 * entry with the same fingerprint already exists in archive/ (would
 * silently overwrite otherwise).
 */
export async function archiveActiveEntry(
  fingerprint: string,
): Promise<Result<void, FilesystemError>> {
  const activeDir = path.join(PROJECTS_DIR, fingerprint);
  const archivedDir = path.join(ARCHIVE_DIR, fingerprint);

  const activeExists = await pathExists(activeDir);
  const archivedExists = await pathExists(archivedDir);

  if (!activeExists) {
    return Result.err(FilesystemError.atomicWriteFailed(activeDir));
  }
  if (archivedExists) {
    return Result.err(FilesystemError.atomicWriteFailed(archivedDir));
  }

  return moveVaultEntry(PROJECTS_DIR, ARCHIVE_DIR, fingerprint);
}
