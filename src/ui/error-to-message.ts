import type { VaultError } from '../result/errors';

/**
 * Maps every `VaultError` subtype to a user-facing string.
 *
 * Story 1.3 — central error→message dispatcher. Call sites MUST use this
 * function instead of inline string-building for error notifications. The
 * exhaustive `switch` is compile-time-verified: TypeScript rejects unhandled
 * subtypes.
 *
 * Invariant: returned strings never include passphrase characters, key buffer
 * contents, or credential values. Structured fields like `path` (file paths)
 * and `foundVersion` (vault format version) are safe to surface.
 */
export function errorToUserMessage(error: VaultError): string {
  switch (error.kind) {
    case 'crypto.decrypt-failed':
      return 'Vault contents could not be decrypted. The file may be corrupted.';
    case 'crypto.kdf-timeout':
      return 'Key derivation timed out. Please try again.';
    case 'crypto.wrong-passphrase':
      return 'Incorrect passphrase. Please try again.';
    case 'keychain.unavailable':
      return 'OS keychain unavailable. Your passphrase will be requested each session.';
    case 'keychain.evicted':
      return 'Stored credentials were evicted from the OS keychain. Please re-enter your passphrase.';
    case 'keychain.write-failed':
      return 'Failed to save credentials to the OS keychain.';
    case 'drive.auth-expired':
      return 'Google Drive sign-in expired. Please sign in again.';
    case 'drive.network-failed': {
      const cause = error.cause;
      if (cause === undefined || cause.length === 0) {
        return 'Google Drive request failed due to a network error.';
      }
      // Surface OAuth-specific failures with actionable guidance.
      if (
        cause.includes('access_denied') ||
        cause.includes('OAuth flow timed out') ||
        cause.toLowerCase().includes('cancel')
      ) {
        return `Google sign-in didn't complete (${cause}). If you see "Access blocked", add your Google account as a Test User in the OAuth consent screen at https://console.cloud.google.com/apis/credentials/consent.`;
      }
      return `Google Drive request failed: ${cause}`;
    }
    case 'drive.quota-exceeded':
      return 'Google Drive quota exceeded. Free up space and try again.';
    case 'drive.upload-interrupted':
      return 'Backup upload to Google Drive was interrupted. Your prior backup is unchanged.';
    case 'format.version-unsupported':
      return `Vault file version ${String(error.foundVersion)} is newer than this extension supports. Please update VaultPilot.`;
    case 'format.corrupted':
      return 'Vault file is unreadable. The file may be corrupted.';
    case 'format.missing-header':
      return 'Vault file is missing its format header.';
    case 'fs.disk-full':
      return 'Disk is full. Free up space and try again.';
    case 'fs.permission-denied':
      return `Permission denied writing to ${error.path}.`;
    case 'fs.atomic-write-failed':
      return `Failed to save ${error.path} safely. Your previous vault contents are intact.`;
  }
}
