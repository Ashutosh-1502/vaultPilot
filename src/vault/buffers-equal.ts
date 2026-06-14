import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two Buffers via `crypto.timingSafeEqual`.
 *
 * Story 1.9 — used to compare the two passphrase entries in the set-up flow
 * without leaking byte-position timing.
 *
 * Length is leaked by the early-return check (unavoidable). The byte
 * comparison itself is constant-time over equal-length buffers.
 *
 * Lives in `src/vault/` rather than `src/ui/` so its unit tests can run under
 * plain Mocha without loading the `vscode` module.
 */
export function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
