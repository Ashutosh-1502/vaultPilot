import * as vscode from 'vscode';

import { defaultHost } from './vscode-host';
import { createLogger, type Logger } from './logging/output-channel';
import { readSettings } from './settings/settings';
import { SecretStorageWrapper } from './keychain/secret-storage';
import { FallbackSecretStorage } from './keychain/fallback';
import { VaultSession } from './vault/vault-session';
import { setUpNewVault } from './ui/first-run';
import { CONTEXT_KEYS, GLOBAL_STATE } from './settings/state-keys';
import { PROJECTS_DIR, ensureVaultRoot, readVaultEntry } from './vault/io';
import { resolveFingerprint } from './fingerprint/re-link';
import { loadAndUnlockVault, unlockWithPassphrase } from './vault/unlock';
import { VaultTreeDataProvider } from './ui/tree-view';
import { ClipboardAutoClear } from './credentials/clipboard';
import { copyCredentialCommand } from './ui/commands/copy-credential';
import { revealCredentialCommand } from './ui/commands/reveal-credential';
import { editCredentialCommand } from './ui/commands/edit-credential';
import { deleteCredentialCommand } from './ui/commands/delete-credential';
import { promptPassphrase } from './ui/passphrase-prompt';
import { zeroBuffer } from './vault/memory-zero';
import { errorToUserMessage } from './ui/error-to-message';
import { ArchiveTreeDataProvider } from './archive/archive-view';
import { scanForArchivableEntries } from './archive/archive-scan';
import { isArchived, promoteArchivedEntry } from './archive/promote';
import { openArchivedVaultsCommand } from './ui/commands/open-archived-vaults';
import { unlockArchivedCommand } from './ui/commands/unlock-archived';
import { promoteArchivedCommand } from './ui/commands/promote-archived';
import { deleteArchivedCommand } from './ui/commands/delete-archived';
import { archiveProjectCommand } from './ui/commands/archive-project';
import { removeDriveBackupCommand } from './ui/commands/remove-drive-backup';
import { localBackupCommand } from './ui/commands/local-backup';
import { backupToDriveCommand } from './ui/commands/backup-to-drive';
import { restoreFromDriveCommand } from './ui/commands/restore-from-drive';
import { restoreFromLocalCommand } from './ui/commands/restore-from-local';
import { restoreCommand } from './ui/commands/restore';
import { importFromEnvCommand, isEnvFileName } from './ui/commands/import-from-env';
import { parseEnvFile } from './credentials/env-parser';
import { openAddMultipleWebview } from './ui/webviews/add-multi-webview';
import {
  notifyDashboardChanged,
  openDashboardPanel,
} from './ui/webviews/dashboard/dashboard-panel';
import { initPassphrasePromptModule } from './ui/webviews/passphrase/passphrase-panel';

/**
 * Extension entry point.
 *
 * Wires the full Epic 1 lifecycle:
 *   - SecretStorage (with FR-49 fallback)
 *   - VaultSession singleton + lock-on-deactivate (NFR-1)
 *   - Active TreeView (Story 1.10)
 *   - Auto-unlock on activation when a cached key + workspace vault exist
 *   - Re-prompt path when key cache is missed (FR-47)
 *   - All FR-10 commands wired
 *   - ClipboardAutoClear with deactivate cleanup
 */

let logger: Logger | null = null;
let fallbackSecrets: FallbackSecretStorage | null = null;
let vaultSession: VaultSession | null = null;
let lockedEmitter: vscode.EventEmitter<undefined> | null = null;
let unlockedEmitter: vscode.EventEmitter<undefined> | null = null;
let treeProvider: VaultTreeDataProvider | null = null;
let archiveProvider: ArchiveTreeDataProvider | null = null;
let clipboard: ClipboardAutoClear | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const host = defaultHost;
  logger = createLogger(host, () => readSettings(host).verboseLogging);
  logger.info('VaultPilot activating...');

  // Pass the extensionUri to the passphrase webview module so it can resolve
  // its HTML/CSS/JS asset paths without each caller threading the context.
  initPassphrasePromptModule(context.extensionUri);

  fallbackSecrets = new FallbackSecretStorage(context.secrets, () => {
    logger?.warn('OS keychain unavailable — falling back to in-memory cache for this session.');
    void vscode.commands.executeCommand(
      'setContext',
      CONTEXT_KEYS.KEYCHAIN_FALLBACK_ACTIVE,
      true,
    );
  });
  const secretStorage = new SecretStorageWrapper(fallbackSecrets);

  lockedEmitter = new vscode.EventEmitter<undefined>();
  unlockedEmitter = new vscode.EventEmitter<undefined>();
  vaultSession = new VaultSession(lockedEmitter, unlockedEmitter);
  context.subscriptions.push(lockedEmitter, unlockedEmitter);

  treeProvider = new VaultTreeDataProvider(vaultSession);
  archiveProvider = new ArchiveTreeDataProvider(vaultSession);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('vaultpilot', treeProvider),
    vscode.window.registerTreeDataProvider('vaultpilot.archived', archiveProvider),
  );
  // Refresh both views when the session locks or unlocks
  context.subscriptions.push(
    vaultSession.onVaultLocked(() => {
      treeProvider?.refresh();
      archiveProvider?.refresh();
    }),
    vaultSession.onVaultUnlocked(() => {
      treeProvider?.refresh();
      archiveProvider?.refresh();
    }),
  );

  clipboard = new ClipboardAutoClear(
    {
      readText: () => vscode.env.clipboard.readText(),
      writeText: (v) => vscode.env.clipboard.writeText(v),
    },
    () => readSettings(host).clipboardTimeout,
  );

  // Capture non-null local refs so command handlers don't need non-null
  // assertions on the module-level `vaultSession` / `clipboard` (which are
  // typed as nullable so `deactivate` can re-null them).
  const session = vaultSession;
  const cb = clipboard;

  // Detect existing vault for this workspace and auto-unlock if cached key.
  await refreshAndMaybeUnlock(secretStorage);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshAndMaybeUnlock(secretStorage);
    }),
  );

  const onChange = (): void => {
    treeProvider?.refresh();
    archiveProvider?.refresh();
    notifyDashboardChanged();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('vaultpilot.setUpVault', () =>
      setUpNewVault({
        secretStorage,
        session,
        globalState: context.globalState,
        onChange,
      }).catch((err: unknown) => logger?.error(`setUpVault: ${String(err)}`)),
    ),
    vscode.commands.registerCommand('vaultpilot.restore', async () => {
      await restoreCommand();
    }),
    vscode.commands.registerCommand('vaultpilot.restoreFromLocal', async () => {
      await restoreFromLocalCommand(context.globalStorageUri.fsPath);
    }),
    vscode.commands.registerCommand('vaultpilot.restoreFromDrive', async () => {
      await restoreFromDriveCommand(secretStorage, onChange);
    }),
    vscode.commands.registerCommand('vaultpilot.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'vaultpilot'),
    ),
    vscode.commands.registerCommand('vaultpilot.addCredential', async () => {
      // Unified UX: both single-add and multi-add open the same webview form.
      // The form starts with 3 rows; user fills as many as they want.
      await ensureUnlocked(secretStorage);
      await openAddMultipleWebview(session, onChange, context.extensionUri);
    }),
    vscode.commands.registerCommand('vaultpilot.addMultipleCredentials', async () => {
      await ensureUnlocked(secretStorage);
      await openAddMultipleWebview(session, onChange, context.extensionUri);
    }),
    vscode.commands.registerCommand('vaultpilot.openDashboard', async () => {
      await openDashboardPanel(context, session, secretStorage);
    }),
    vscode.commands.registerCommand(
      'vaultpilot.copyCredential',
      async (payload?: { credentialId: string; archivedFingerprint?: string }) => {
        // Archived credentials don't require the active session to be unlocked.
        if (payload?.archivedFingerprint === undefined) {
          await ensureUnlocked(secretStorage);
        }
        await copyCredentialCommand(session, cb, payload);
      },
    ),
    vscode.commands.registerCommand(
      'vaultpilot.revealCredential',
      async (payload?: { credentialId: string; archivedFingerprint?: string }) => {
        if (payload?.archivedFingerprint === undefined) {
          await ensureUnlocked(secretStorage);
        }
        await revealCredentialCommand(session, payload);
      },
    ),
    vscode.commands.registerCommand(
      'vaultpilot.editCredential',
      async (payload?: { credentialId: string }) => {
        await ensureUnlocked(secretStorage);
        await editCredentialCommand(session, payload, onChange);
      },
    ),
    vscode.commands.registerCommand(
      'vaultpilot.deleteCredential',
      async (payload?: { credentialId: string }) => {
        await ensureUnlocked(secretStorage);
        await deleteCredentialCommand(session, payload, onChange);
      },
    ),
  );

  // Epic 2 — archive commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vaultpilot.openArchivedVaults', () =>
      openArchivedVaultsCommand(),
    ),
    vscode.commands.registerCommand(
      'vaultpilot.unlockArchived',
      async (payload?: { fingerprint: string }) => {
        await unlockArchivedCommand(session, payload, onChange);
      },
    ),
    vscode.commands.registerCommand(
      'vaultpilot.promoteArchived',
      async (payload?: { fingerprint: string; displayName?: string }) => {
        await promoteArchivedCommand(session, payload, onChange);
      },
    ),
    vscode.commands.registerCommand(
      'vaultpilot.deleteArchived',
      async (payload?: { fingerprint: string; displayName: string }) => {
        await deleteArchivedCommand(session, payload, onChange);
      },
    ),
    vscode.commands.registerCommand(
      'vaultpilot.archiveProject',
      async (payload?: { fingerprint: string; displayName: string }) => {
        await archiveProjectCommand(session, payload, onChange);
      },
    ),
  );

  // Epic 3 — Drive backup; restoreFromDrive is wired in the main commands
  // block above (replacing the Story 1.9 stub). The OAuth flow uses a
  // loopback HTTP server (see src/drive/auth.ts) — no URI handler needed.
  context.subscriptions.push(
    vscode.commands.registerCommand('vaultpilot.backUpToDrive', async () => {
      await backupToDriveCommand(secretStorage, context.globalState);
      notifyDashboardChanged();
    }),
    vscode.commands.registerCommand('vaultpilot.removeDriveBackup', async () => {
      await removeDriveBackupCommand(secretStorage, context.globalState);
      notifyDashboardChanged();
    }),
    vscode.commands.registerCommand('vaultpilot.localBackup', async () => {
      await localBackupCommand(session, context.globalState, context.globalStorageUri.fsPath);
      notifyDashboardChanged();
    }),
  );

  // Dogfood-driven addition (2026-06-13) — bulk import from .env file.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vaultpilot.importFromEnv',
      async (uri?: vscode.Uri) => {
        await importFromEnvCommand(session, onChange, uri, context.extensionUri, secretStorage);
      },
    ),
  );

  // Auto-detect: when the user opens a `.env*` file with the vault unlocked,
  // surface a non-blocking notification offering to import. Respects the
  // "Don't show again" flag in globalState.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      if (!isEnvFileName(doc.fileName)) return;
      if (!session.isUnlocked()) return;
      const dismissed = context.globalState.get<boolean>(
        GLOBAL_STATE.ENV_IMPORT_DONT_SUGGEST,
        false,
      );
      if (dismissed) return;

      const text = doc.getText();
      const entries = parseEnvFile(text);
      if (entries.length === 0) return;

      const fileName = doc.fileName.split('/').pop() ?? doc.fileName;
      const IMPORT = 'Import';
      const DISMISS = "Don't show again";
      void vscode.window
        .showInformationMessage(
          `Found ${String(entries.length)} env vars in ${fileName}. Import to VaultPilot?`,
          IMPORT,
          DISMISS,
        )
        .then(async (choice) => {
          if (choice === IMPORT) {
            await importFromEnvCommand(
              session,
              onChange,
              doc.uri,
              context.extensionUri,
              secretStorage,
            );
          } else if (choice === DISMISS) {
            await context.globalState.update(GLOBAL_STATE.ENV_IMPORT_DONT_SUGGEST, true);
          }
        });
    }),
  );

  // Kick off the FR-28 archive scan in the background (does not block the
  // 500ms activation budget per NFR-2). Errors are logged only.
  void runBackgroundArchiveScan();

  void context.globalState.get<boolean>(GLOBAL_STATE.FIRST_RUN_DRIVE_DECLINED, false);
  logger.info('VaultPilot activated.');
}

export function deactivate(): void {
  vaultSession?.lock();
  fallbackSecrets?.clear();
  // Best-effort clipboard cleanup; deactivate is synchronous so we can't
  // truly await, but the async call still kicks off.
  void clipboard?.dispose();
  logger?.dispose();
  logger = null;
  vaultSession = null;
  fallbackSecrets = null;
  treeProvider = null;
  archiveProvider = null;
  clipboard = null;
  lockedEmitter = null;
  unlockedEmitter = null;
}

/**
 * FR-28 archive scan, run in the background after activation. Logs the
 * report; errors don't block activation.
 */
async function runBackgroundArchiveScan(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  let currentFingerprint: string | null = null;
  if (ws !== undefined) {
    try {
      const fp = await resolveFingerprint(ws.uri.fsPath);
      currentFingerprint = fp.fingerprint;
    } catch {
      // best-effort
    }
  }

  const result = await scanForArchivableEntries({
    currentWorkspaceFingerprint: currentFingerprint,
  });
  if (!result.ok) {
    logger?.warn(`Archive scan failed: ${result.error.kind}`);
    return;
  }
  const { scanned, archived, markedTentative, clearedTentative } = result.value;
  logger?.info(
    `Archive scan: scanned=${String(scanned)} archived=${String(archived.length)} tentative=${String(markedTentative.length)} cleared=${String(clearedTentative.length)}`,
  );
  if (archived.length > 0) {
    archiveProvider?.refresh();
    treeProvider?.refresh();
  }
}

/**
 * Detect the workspace's vault state and refresh the welcome context key.
 * If a vault entry + a cached derived key both exist, auto-unlock.
 */
async function refreshAndMaybeUnlock(secretStorage: SecretStorageWrapper): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws === undefined || vaultSession === null) {
    await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.VAULT_EXISTS, false);
    return;
  }

  const ensure = await ensureVaultRoot();
  if (!ensure.ok) {
    await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.VAULT_EXISTS, false);
    return;
  }

  const fp = await resolveFingerprint(ws.uri.fsPath);

  // FR-30 auto-promote: if the workspace's fingerprint matches an archived
  // entry (and no active entry exists), promote it back BEFORE checking
  // vault-exists state.
  let entryResult = await readVaultEntry(PROJECTS_DIR, fp.fingerprint);
  const activeExists = entryResult.ok && entryResult.value !== null;
  if (!activeExists && (await isArchived(fp.fingerprint))) {
    const promoteResult = await promoteArchivedEntry(fp.fingerprint);
    if (promoteResult.ok) {
      logger?.info(`Auto-promoted archived entry ${fp.fingerprint} for opened workspace.`);
      archiveProvider?.refresh();
      // Re-read the active entry after promote.
      entryResult = await readVaultEntry(PROJECTS_DIR, fp.fingerprint);
    } else {
      logger?.warn(`Auto-promote failed: ${promoteResult.error.kind}`);
    }
  }

  const exists = entryResult.ok && entryResult.value !== null;
  await vscode.commands.executeCommand(
    'setContext',
    CONTEXT_KEYS.VAULT_EXISTS,
    exists,
  );

  if (!exists) return;

  // Try auto-unlock using the SecretStorage cache (FR-4).
  const cachedKey = await secretStorage.getCachedDerivedKey();
  if (!cachedKey.ok || cachedKey.value === null) {
    // Cache miss — the user will be prompted on first interaction. No
    // proactive prompt at activation so a user opening a fresh laptop window
    // doesn't get yelled at.
    return;
  }

  const unlockResult = await loadAndUnlockVault(
    vaultSession,
    fp.fingerprint,
    cachedKey.value,
  );
  if (!unlockResult.ok) {
    // Cached key didn't decrypt — clear it and let the next interaction
    // re-prompt (FR-47).
    logger?.warn(`Auto-unlock failed: ${unlockResult.error.kind}. Clearing cached key.`);
    await secretStorage.clearDerivedKey();
    cachedKey.value.fill(0);
  } else {
    logger?.info('Auto-unlocked vault from cached derived key.');
  }
}

/**
 * Ensure the session is unlocked before running a command that needs it.
 * If locked, prompt for passphrase (FR-47 re-prompt flow).
 */
async function ensureUnlocked(secretStorage: SecretStorageWrapper): Promise<void> {
  if (vaultSession === null || vaultSession.isUnlocked()) return;

  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws === undefined) return;
  const fp = await resolveFingerprint(ws.uri.fsPath);

  const passphrase = await promptPassphrase('Enter the passphrase for this project.');
  if (passphrase === null) return;

  const result = await unlockWithPassphrase(vaultSession, fp.fingerprint, passphrase);
  zeroBuffer(passphrase);
  if (!result.ok) {
    await vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return;
  }

  // Re-cache the freshly-derived key (FR-47)
  const cacheResult = await secretStorage.cacheDerivedKey(result.value.derivedKey);
  if (!cacheResult.ok) {
    logger?.warn(`Re-cache after unlock failed: ${cacheResult.error.kind}`);
  }
}
