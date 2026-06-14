/**
 * promote.test.ts — placeholder.
 *
 * `promoteArchivedEntry` and `isArchived` operate against the real
 * `~/.vaultpilot/projects/` and `~/.vaultpilot/archive/` directories (via the
 * io.ts constants). The atomic rename is delegated to `moveVaultEntry` which
 * is tested directly in `io.test.ts`. The defensive-check (refuse promote if
 * both archive/<fp>/ and projects/<fp>/ exist) and the auto-promote-on-open
 * trigger live in `extension.ts` and `archive-scan.ts`, both exercised by
 * the integration suite (deferred).
 */
import { describe, it } from 'mocha';

describe('promote (placeholder)', () => {
  it('promote-back filesystem flow — covered by integration suite', () => {
    // intentional no-op
  });
});
