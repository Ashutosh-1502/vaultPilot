/**
 * Discriminated-union Result type for fallible operations across the codebase.
 *
 * Story 1.3 — every fallible operation in `vault/`, `drive/`, `fingerprint/`,
 * `credentials/`, `archive/`, `keychain/`, `settings/` MUST return
 * `Result<T, VaultError>` instead of throwing. `throw` is reserved for
 * unreachable-state programmer errors only in `extension.ts`.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Result = {
  ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
  },

  err<E>(error: E): Result<never, E> {
    return { ok: false, error };
  },

  isOk<T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } {
    return r.ok;
  },

  isErr<T, E>(r: Result<T, E>): r is { readonly ok: false; readonly error: E } {
    return !r.ok;
  },
} as const;
