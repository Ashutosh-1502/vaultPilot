import * as vscode from 'vscode';

import { CONTEXT_KEYS } from '../../settings/state-keys';

/**
 * Open Archived Vaults (FR-29 — `vaultpilot.openArchivedVaults`).
 *
 * Toggles the `vaultpilot.archivedViewVisible` context key, which controls
 * the `when` clause on the archived view contribution in package.json.
 * After setting the context, focuses the view so the user lands there.
 */
export async function openArchivedVaultsCommand(): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    CONTEXT_KEYS.ARCHIVED_VIEW_VISIBLE,
    true,
  );
  await vscode.commands.executeCommand('vaultpilot.archived.focus');
}
