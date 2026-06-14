import { Result } from '../result/result';
import { VaultFormatError } from '../result/errors';

/**
 * Vault format version management (FR-5).
 *
 * Story 1.4 — the current vault format version. Bumped only via a documented
 * migration path. The extension can read all versions in
 * `[1, CURRENT_VAULT_VERSION]`. Future versions are refused with a clear
 * prompt-to-upgrade message.
 */
export const CURRENT_VAULT_VERSION = 1 as const;

/**
 * Check whether the loader can read a vault of the given format version.
 *
 * - version > CURRENT_VAULT_VERSION → `format.version-unsupported` (future format)
 * - 1 <= version <= CURRENT_VAULT_VERSION → ok
 * - version < 1 or non-integer → `format.corrupted`
 */
export function checkSupported(version: number): Result<void, VaultFormatError> {
  if (!Number.isInteger(version) || version < 1) {
    return Result.err(VaultFormatError.corrupted());
  }
  if (version > CURRENT_VAULT_VERSION) {
    return Result.err(VaultFormatError.versionUnsupported(version));
  }
  return Result.ok(undefined);
}
