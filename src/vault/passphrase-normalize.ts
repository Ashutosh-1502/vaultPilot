/**
 * Passphrase normalization at the input boundary.
 *
 * Story 1.4 — resolves OQ-9 (Unicode normalization).
 *
 * The same visible passphrase MUST decrypt the same vault on macOS, Windows,
 * and Linux. JavaScript engines differ on default string composition (NFC vs
 * NFD), so we explicitly normalize to NFC. We also Unicode-trim leading and
 * trailing whitespace at the paste boundary (smart quotes, zero-width chars,
 * line separators) so a passphrase pasted from a notes app still works.
 *
 * The string is converted to a UTF-8 `Buffer` immediately so downstream code
 * can zero the bytes via `zeroBuffer`. The original `string` reference should
 * be discarded by the caller as soon as this function returns.
 */
export function normalizePassphrase(input: string): Buffer {
  const trimmed = input.trim();
  const composed = trimmed.normalize('NFC');
  return Buffer.from(composed, 'utf8');
}
