import { Result } from '../result/result';
import { FilesystemError } from '../result/errors';
import { ARCHIVE_DIR, removeVaultDirectory } from '../vault/io';

/**
 * Permanent delete of an archived entry (Story 2.4, FR-31).
 *
 * The caller (typically the delete-archived UI command) is responsible for
 * obtaining the strong confirmation (the user must TYPE the project's
 * displayName exactly). This pure helper just performs the recursive
 * directory removal once the caller's confirmation logic has approved.
 *
 * Returns `Result.err` if the removal fails partway (permission, disk error);
 * a subsequent archive scan or view-refresh will re-list any files left
 * behind.
 */
export async function permanentlyDeleteArchivedEntry(
  fingerprint: string,
): Promise<Result<void, FilesystemError>> {
  return removeVaultDirectory(ARCHIVE_DIR, fingerprint);
}

/**
 * Type-name confirmation check. Case-sensitive comparison per FR-31.
 * Returns `true` only when the typed input exactly matches the expected
 * display name. Pure function; testable without VS Code.
 */
export function checkDeletionConfirmation(
  expectedDisplayName: string,
  typedInput: string,
): boolean {
  return typedInput === expectedDisplayName;
}
