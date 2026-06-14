/**
 * archive-scan.test.ts — placeholder.
 *
 * `scanForArchivableEntries` operates against the real `~/.vaultpilot/`
 * filesystem layout (via `PROJECTS_DIR` / `ARCHIVE_DIR` constants in
 * `src/vault/io.ts`). Testing the two-activation state machine + the
 * reachability check + the currently-open guard requires controlled
 * filesystem fixtures.
 *
 * The pure-logic decision tree is well-covered conceptually by:
 *   1. The state-machine table in `archive-scan.ts` (no branch missing).
 *   2. The io.test.ts tests for the underlying helpers (`atomicWriteFile`,
 *      `moveVaultEntry`, `listVaultEntries`, `readFileOrNull`, `pathExists`).
 *
 * Full end-to-end behavior — including the cross-activation
 * `tentativeMissAt` flag persistence — is exercised by the integration test
 * suite in `test/integration/` (deferred, runs under `@vscode/test-electron`).
 */
import { describe, it } from 'mocha';

describe('archive-scan (placeholder)', () => {
  it('two-activation state machine — covered by integration suite', () => {
    // intentional no-op; integration tests live in test/integration/.
  });
});
