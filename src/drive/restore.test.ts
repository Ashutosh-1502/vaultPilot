/**
 * restore.test.ts — placeholder.
 *
 * The restore flow composes a Drive download, tar extraction into a staging
 * directory under the real `~/.vaultpilot/`, the FR-37 chooser decision
 * (Overwrite / Keep Local / Cancel), and the trash-safety rollback. End-to-
 * end correctness requires real filesystem fixtures + a mocked Drive client.
 *
 * Pure-logic pieces are exercised elsewhere:
 *   - DriveClient list/download/PATCH — tested in `client.test.ts`.
 *   - tar extraction round-trip — implicit via the npm `tar` package
 *     (battle-tested upstream).
 *   - Filesystem helpers (`renamePath`, `removePath`, `readDirectoryEntries`,
 *     `makeDirectory`) — tested in `vault/io.test.ts`.
 *   - FR-38 traversal defense — verified by inspection of the
 *     `assertStagingEntriesContained` check; integration test would also
 *     simulate a tampered archive.
 *
 * Full end-to-end (including rollback-on-failure mid-restore) is deferred to
 * the integration suite under `@vscode/test-electron`.
 */
import { describe, it } from 'mocha';

describe('restore (placeholder)', () => {
  it('end-to-end restore flow — covered by integration suite', () => {
    // intentional no-op
  });
});
