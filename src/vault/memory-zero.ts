/**
 * Memory-zeroing helpers for Buffer-backed cleartext.
 *
 * Story 1.4 — implements the memory-zero discipline from NFR-1 and OQ-5.
 * `Buffer.fill(0)` provides best-effort zeroing of decrypted credentials,
 * derived keys, and passphrase bytes before the references are released.
 *
 * Known residual (OQ-5): JavaScript `string` values cannot be deterministically
 * zeroed — strings are immutable and garbage-collected at the engine's
 * discretion. Callers must convert string inputs to Buffer immediately at the
 * input boundary (see `passphrase-normalize.ts`). Documented in
 * docs/threat-model.md.
 */

/**
 * Zero the contents of a Buffer or Uint8Array in place.
 */
export function zeroBuffer(buf: Buffer | Uint8Array): void {
  buf.fill(0);
}

/**
 * Run `fn(buf)` and zero the buffer in a `finally` block.
 * Use this whenever a buffer holds secret material and the secret-handling
 * span is bounded by a single function.
 */
export function withZeroedBuffer<T>(buf: Buffer, fn: (buf: Buffer) => T): T {
  try {
    return fn(buf);
  } finally {
    zeroBuffer(buf);
  }
}

/**
 * Async variant of `withZeroedBuffer`. The buffer is zeroed after the
 * promise settles, regardless of resolution or rejection.
 */
export async function withZeroedBufferAsync<T>(
  buf: Buffer,
  fn: (buf: Buffer) => Promise<T>,
): Promise<T> {
  try {
    return await fn(buf);
  } finally {
    zeroBuffer(buf);
  }
}
