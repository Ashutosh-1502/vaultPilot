import { createHash } from 'node:crypto';

/**
 * Project fingerprint: SHA-256 of the canonical anchor, truncated to 16 hex
 * characters. Used as the directory name under `~/.vaultpilot/projects/`.
 *
 * Story 1.6 — same canonical anchor produces the same fingerprint on every
 * machine, in every clone. 16 hex chars (64 bits) is sufficient for the
 * project-scale (≤ tens of thousands of distinct repos per machine in the
 * extreme case; collision probability negligible).
 */
export function computeFingerprint(canonicalSource: string): string {
  return createHash('sha256').update(canonicalSource, 'utf8').digest('hex').slice(0, 16);
}
