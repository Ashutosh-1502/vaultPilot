import { showPassphrasePrompt } from './webviews/passphrase/passphrase-panel';

/**
 * Passphrase prompt — used everywhere VaultPilot needs the user's passphrase:
 *   - First-run vault set-up (uses confirm mode — two-input with match check)
 *   - Unlock active workspace vault (FR-47 re-prompt path)
 *   - Unlock archived vault (Epic 2 archive view + Epic 4 cross-project access)
 *   - Restore from Drive (Epic 3)
 *
 * Backed by a custom webview (see `src/ui/webviews/passphrase/`) — replaced
 * VS Code's `showInputBox({password: true})` per user request for a
 * consistent VaultPilot-branded UI across all input flows.
 *
 * Returns a UTF-8 Buffer of the NFC-normalized passphrase, or `null` on
 * cancel. Caller MUST `zeroBuffer()` the returned Buffer when done.
 */
export async function promptPassphrase(prompt: string): Promise<Buffer | null> {
  return showPassphrasePrompt({
    mode: 'single',
    title: 'Unlock Vault',
    subtitle: prompt,
    label: 'Passphrase',
    hint: '',
  });
}

/**
 * Two-input confirmation prompt for first-run vault set-up. Returns the
 * common passphrase (Buffer) if both entries match, or `null` if cancelled.
 * The webview enforces the match check client-side; we still see two
 * identical strings here.
 */
export async function promptPassphraseConfirm(): Promise<Buffer | null> {
  return showPassphrasePrompt({
    mode: 'confirm',
    title: 'Set Up New Vault',
    subtitle:
      'Choose a strong passphrase. It encrypts everything VaultPilot stores. Lose it = lose the vault — there is no recovery.',
    label: 'Passphrase',
    hint:
      '12+ characters with mixed case, numbers, and symbols recommended. The strength meter is guidance only — no minimum is enforced.',
    submitLabel: 'Create Vault',
  });
}

// Re-exported here for callers that import buffersEqual via this module.
// Implementation lives in src/vault/buffers-equal.ts so its unit tests can
// run under plain Mocha without loading the `vscode` namespace.
export { buffersEqual } from '../vault/buffers-equal';
