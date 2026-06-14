/**
 * The full `VaultError` taxonomy. Each subtype is a discriminated union member
 * keyed by `kind`. Errors carry structured payloads only — no string-concat
 * messages at construction. User-facing strings are produced by
 * `src/ui/error-to-message.ts`.
 *
 * Story 1.3 — locks the error taxonomy. Forbids stringly-typed error handling.
 */

export type CryptoError =
  | { readonly kind: 'crypto.decrypt-failed' }
  | { readonly kind: 'crypto.kdf-timeout' }
  | { readonly kind: 'crypto.wrong-passphrase' };

export type KeychainError =
  | { readonly kind: 'keychain.unavailable' }
  | { readonly kind: 'keychain.evicted' }
  | { readonly kind: 'keychain.write-failed' };

export type DriveError =
  | { readonly kind: 'drive.auth-expired' }
  | { readonly kind: 'drive.network-failed'; readonly cause?: string }
  | { readonly kind: 'drive.quota-exceeded' }
  | { readonly kind: 'drive.upload-interrupted' };

export type VaultFormatError =
  | { readonly kind: 'format.version-unsupported'; readonly foundVersion: number }
  | { readonly kind: 'format.corrupted' }
  | { readonly kind: 'format.missing-header' };

export type FilesystemError =
  | { readonly kind: 'fs.disk-full' }
  | { readonly kind: 'fs.permission-denied'; readonly path: string }
  | { readonly kind: 'fs.atomic-write-failed'; readonly path: string };

export type VaultError =
  | CryptoError
  | KeychainError
  | DriveError
  | VaultFormatError
  | FilesystemError;

// Factory constructors. Use these instead of object literals at call sites.
export const CryptoError = {
  decryptFailed: (): CryptoError => ({ kind: 'crypto.decrypt-failed' }),
  kdfTimeout: (): CryptoError => ({ kind: 'crypto.kdf-timeout' }),
  wrongPassphrase: (): CryptoError => ({ kind: 'crypto.wrong-passphrase' }),
} as const;

export const KeychainError = {
  unavailable: (): KeychainError => ({ kind: 'keychain.unavailable' }),
  evicted: (): KeychainError => ({ kind: 'keychain.evicted' }),
  writeFailed: (): KeychainError => ({ kind: 'keychain.write-failed' }),
} as const;

export const DriveError = {
  authExpired: (): DriveError => ({ kind: 'drive.auth-expired' }),
  networkFailed: (cause?: string): DriveError =>
    cause === undefined ? { kind: 'drive.network-failed' } : { kind: 'drive.network-failed', cause },
  quotaExceeded: (): DriveError => ({ kind: 'drive.quota-exceeded' }),
  uploadInterrupted: (): DriveError => ({ kind: 'drive.upload-interrupted' }),
} as const;

export const VaultFormatError = {
  versionUnsupported: (foundVersion: number): VaultFormatError => ({
    kind: 'format.version-unsupported',
    foundVersion,
  }),
  corrupted: (): VaultFormatError => ({ kind: 'format.corrupted' }),
  missingHeader: (): VaultFormatError => ({ kind: 'format.missing-header' }),
} as const;

export const FilesystemError = {
  diskFull: (): FilesystemError => ({ kind: 'fs.disk-full' }),
  permissionDenied: (path: string): FilesystemError => ({ kind: 'fs.permission-denied', path }),
  atomicWriteFailed: (path: string): FilesystemError => ({ kind: 'fs.atomic-write-failed', path }),
} as const;
