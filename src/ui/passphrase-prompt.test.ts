/**
 * passphrase-prompt.test.ts — placeholder.
 *
 * `passphrase-prompt.ts` imports `vscode` at module load, so it cannot be
 * exercised under plain `npm test` (which runs Mocha + ts-node outside an
 * Extension Host). The interactive `promptPassphrase` flow is integration-
 * tested via @vscode/test-electron in `test/integration/` (deferred).
 *
 * The pure-logic helper `buffersEqual` has been moved to
 * `src/vault/buffers-equal.ts` and is tested there.
 */
import { describe, it } from 'mocha';

describe('passphrase-prompt (placeholder)', () => {
  it('vscode-bound — tested via integration suite; buffersEqual lives in src/vault/', () => {
    // intentional no-op
  });
});
