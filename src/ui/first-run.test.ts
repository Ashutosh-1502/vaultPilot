/**
 * first-run.test.ts — placeholder.
 *
 * The first-run orchestrator is heavily VS Code-API-bound (showInputBox,
 * showQuickPick, workspace.workspaceFolders, commands.executeCommand). The
 * pure-logic pieces it composes are individually tested:
 *
 *   - strength-meter.test.ts  → scoring + thresholds
 *   - passphrase-prompt.test.ts → buffersEqual
 *   - passphrase-normalize.test.ts → NFC + Unicode trim
 *   - crypto.test.ts → KDF + encrypt + decrypt
 *   - envelope.test.ts → serialize + parse round-trip
 *   - io.test.ts → atomic write + recovery semantics
 *   - re-link.test.ts → fingerprint priority chain
 *   - secret-storage.test.ts → key cache + Drive token contract
 *   - vault-session.test.ts → unlock/lock state machine
 *
 * The end-to-end first-run flow lives in test/integration/first-run.test.ts
 * (deferred; requires @vscode/test-electron to exercise the real VS Code API).
 *
 * This file exists so a future test of pure first-run helpers (if any are
 * extracted) has a home, and so `mocha --recursive src/**` doesn't skip the
 * directory in case extension-of-tests is added.
 */
import { describe, it } from 'mocha';

describe('first-run (placeholder)', () => {
  it('pure-logic dependencies are individually tested — see file header', () => {
    // intentional no-op
  });
});
