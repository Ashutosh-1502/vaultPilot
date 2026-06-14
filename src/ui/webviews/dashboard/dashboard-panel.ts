import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { Result } from '../../../result/result';
import { CryptoError } from '../../../result/errors';
import {
  bridgeAddMultiple,
  bridgeBackUpToDrive,
  bridgeCopy,
  bridgeDelete,
  bridgeEdit,
  bridgeOpenSettings,
  bridgeReveal,
  bridgeSetUpVault,
} from './command-bridge';
import { loadProjectCredentials } from './credentials-loader';
import type {
  DashboardSettings,
  DriveBackupSummary,
  ExtensionResponse,
  WebviewRequest,
} from './message-types';
import { listAllProjects } from './project-loader';
import { readSettings } from '../../../settings/settings';
import { defaultHost } from '../../../vscode-host';
import { GLOBAL_STATE } from '../../../settings/state-keys';
import type { SecretStorageWrapper } from '../../../keychain/secret-storage';
import type { VaultSession } from '../../../vault/vault-session';
import { ARCHIVE_DIR, PROJECTS_DIR, VAULT_ROOT, pathExists } from '../../../vault/io';
import {
  deriveAndCacheActiveKey,
  deriveAndCacheArchivedKey,
} from '../../../archive/archive-decrypt';
import { unlockWithPassphrase } from '../../../vault/unlock';
import { resolveFingerprint } from '../../../fingerprint/re-link';
import { VaultFormatError } from '../../../result/errors';
import { CONTEXT_KEYS } from '../../../settings/state-keys';
import { promptPassphrase } from '../../passphrase-prompt';
import { zeroBuffer } from '../../../vault/memory-zero';
import { errorToUserMessage } from '../../error-to-message';
import { DriveClient } from '../../../drive/client';
import { refreshAccessToken } from '../../../drive/oauth';
import { inspectDriveBackup } from '../../../drive/inspect';
import { credentialsToEnvFile } from '../../../credentials/env-export';
import { listLocalBackupVaults, BACKUP_FILE_EXT } from '../../../backup/local-backup';
import type { DriveBackupInfo } from '../../commands/backup-to-drive';
import type { LocalBackupInfo } from '../../commands/local-backup';

const PANEL_ID = 'vaultpilot.dashboard';
const PANEL_TITLE = 'VaultPilot — Dashboard';

let activePanel: vscode.WebviewPanel | null = null;

/**
 * Open (or focus) the VaultPilot Dashboard webview panel.
 *
 * Single-instance pattern: a second invocation reveals the existing panel
 * instead of opening a duplicate.
 */
export async function openDashboardPanel(
  context: vscode.ExtensionContext,
  session: VaultSession,
  secretStorage: SecretStorageWrapper,
): Promise<void> {
  if (activePanel !== null) {
    activePanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    PANEL_ID,
    PANEL_TITLE,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  );
  activePanel = panel;

  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'vaultpilot-logo.svg');
  panel.webview.html = await loadDashboardHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage((msg: WebviewRequest) => {
    handleMessage(msg, session, secretStorage, context, panel).catch((err: unknown) => {
      void vscode.window.showErrorMessage(`Dashboard error: ${String(err)}`);
    });
  });

  panel.onDidDispose(() => {
    activePanel = null;
  });
}

/**
 * Triggered by the existing TreeView refresh path so the dashboard updates
 * after add/edit/delete via the underlying commands.
 */
export function notifyDashboardChanged(): void {
  if (activePanel !== null) {
    void activePanel.webview.postMessage({ kind: 'changed' } satisfies ExtensionResponse);
  }
}

// ─── HTML template loading ─────────────────────────────────────────────

async function loadDashboardHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): Promise<string> {
  const htmlPath = path.join(extensionUri.fsPath, 'media', 'dashboard', 'index.html');
  const raw = await readFile(htmlPath, 'utf8');

  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'dashboard', 'styles.css'),
  );
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'dashboard', 'dashboard.js'),
  );
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'vaultpilot-logo.svg'),
  );
  const nonce = randomUUID().replace(/-/g, '');

  return raw
    .replace(/\$\{cspSource\}/g, webview.cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{cssUri\}/g, cssUri.toString())
    .replace(/\$\{jsUri\}/g, jsUri.toString())
    .replace(/\$\{logoUri\}/g, logoUri.toString());
}

// ─── Message router ────────────────────────────────────────────────────

async function handleMessage(
  msg: WebviewRequest,
  session: VaultSession,
  secretStorage: SecretStorageWrapper,
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
): Promise<void> {
  switch (msg.kind) {
    case 'list-projects': {
      const projects = await listAllProjects();
      // Annotate with knownCount for projects whose key is in the cache.
      const enriched = projects.map((p) => {
        // The current-workspace vault session is the only one with a
        // direct credential count; others appear as "?" until unlocked.
        if (session.getFingerprint() === p.fingerprint) {
          const credsResult = session.getCredentials();
          if (credsResult.ok) {
            return { ...p, knownCount: credsResult.value.length };
          }
        }
        return p;
      });
      panel.webview.postMessage({
        kind: 'projects-loaded',
        projects: enriched,
      } satisfies ExtensionResponse);
      return;
    }

    case 'load-project': {
      const result = await loadProjectCredentials(session, msg.fingerprint);
      if (!result.ok) {
        if (result.error.kind === 'crypto.wrong-passphrase') {
          panel.webview.postMessage({
            kind: 'project-needs-unlock',
            fingerprint: msg.fingerprint,
          } satisfies ExtensionResponse);
          return;
        }
        void vscode.window.showErrorMessage(errorToUserMessage(result.error));
        return;
      }
      panel.webview.postMessage({
        kind: 'project-loaded',
        credentials: result.value,
      } satisfies ExtensionResponse);
      return;
    }

    case 'unlock-project': {
      const passphrase = await promptPassphrase(
        'Enter the passphrase for this project to unlock it.',
      );
      if (passphrase === null) return;

      // Route based on where the vault actually lives on disk. The previous
      // implementation always read from ARCHIVE_DIR, which surfaced
      // "vault file is unreadable" whenever the user clicked unlock on an
      // active project's card.
      const inArchive = await pathExists(path.join(ARCHIVE_DIR, msg.fingerprint));
      const inProjects =
        !inArchive && (await pathExists(path.join(PROJECTS_DIR, msg.fingerprint)));

      try {
        if (inArchive) {
          const result = await deriveAndCacheArchivedKey(session, msg.fingerprint, passphrase);
          if (!result.ok) {
            void vscode.window.showErrorMessage(errorToUserMessage(result.error));
            return;
          }
        } else if (inProjects) {
          const ws = vscode.workspace.workspaceFolders?.[0];
          const workspaceFp =
            ws !== undefined ? (await resolveFingerprint(ws.uri.fsPath)).fingerprint : null;
          if (workspaceFp === msg.fingerprint) {
            // Current workspace — unlock the in-memory session AND cache the
            // primary derived key in SecretStorage so the next VS Code session
            // auto-unlocks.
            const result = await unlockWithPassphrase(session, msg.fingerprint, passphrase);
            if (!result.ok) {
              void vscode.window.showErrorMessage(errorToUserMessage(result.error));
              return;
            }
            const cacheResult = await secretStorage.cacheDerivedKey(result.value.derivedKey);
            if (!cacheResult.ok) {
              void vscode.window.showWarningMessage(
                `${errorToUserMessage(cacheResult.error)} You may be re-prompted next session.`,
              );
            }
            await vscode.commands.executeCommand(
              'setContext',
              CONTEXT_KEYS.VAULT_EXISTS,
              true,
            );
          } else {
            // A different active project. Cache the per-fingerprint key so
            // loadProjectCredentials can decrypt it via the same path it uses
            // for already-cached projects.
            const result = await deriveAndCacheActiveKey(session, msg.fingerprint, passphrase);
            if (!result.ok) {
              void vscode.window.showErrorMessage(errorToUserMessage(result.error));
              return;
            }
          }
        } else {
          void vscode.window.showErrorMessage(
            errorToUserMessage(VaultFormatError.corrupted()),
          );
          return;
        }
      } finally {
        zeroBuffer(passphrase);
      }

      const reload = await loadProjectCredentials(session, msg.fingerprint);
      if (reload.ok) {
        panel.webview.postMessage({
          kind: 'project-loaded',
          credentials: reload.value,
        } satisfies ExtensionResponse);
      }
      notifyDashboardChanged();
      return;
    }

    case 'copy': {
      await bridgeCopy(buildPayload(msg, session));
      return;
    }
    case 'reveal': {
      await bridgeReveal(buildPayload(msg, session));
      return;
    }
    case 'edit': {
      await bridgeEdit(buildPayload(msg, session));
      notifyDashboardChanged();
      return;
    }
    case 'delete': {
      await bridgeDelete(buildPayload(msg, session));
      notifyDashboardChanged();
      return;
    }
    case 'add-credential': {
      await bridgeAddMultiple();
      notifyDashboardChanged();
      return;
    }
    case 'create-new-vault': {
      await bridgeSetUpVault();
      notifyDashboardChanged();
      return;
    }
    case 'sync-to-drive': {
      await bridgeBackUpToDrive();
      // Refresh settings so the last-backup time updates.
      void sendSettings(panel, context, session);
      return;
    }
    case 'remove-drive-backup': {
      await vscode.commands.executeCommand('vaultpilot.removeDriveBackup');
      void sendSettings(panel, context, session);
      return;
    }
    case 'open-vscode-settings': {
      await bridgeOpenSettings();
      return;
    }
    case 'open-docs': {
      const file = msg.target === 'changelog' ? 'CHANGELOG.md' : 'README.md';
      const uri = vscode.Uri.joinPath(context.extensionUri, file);
      void vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    case 'load-settings': {
      void sendSettings(panel, context, session);
      return;
    }
    case 'refresh-drive-backup': {
      void liveRefreshDriveBackup(panel, context, secretStorage);
      return;
    }
    case 'inspect-drive-backup': {
      void inspectDriveBackupHandler(panel, secretStorage);
      return;
    }
    case 'local-backup': {
      await vscode.commands.executeCommand('vaultpilot.localBackup');
      void sendSettings(panel, context, session);
      return;
    }
    case 'refresh-local-backup': {
      void refreshLocalBackupHandler(panel, context, session);
      return;
    }
    case 'inspect-local-backup': {
      void inspectLocalBackupHandler(panel, context);
      return;
    }
    case 'reveal-local-vault': {
      void revealLocalVaultHandler(context, msg.fingerprint, msg.status);
      return;
    }
    case 'download-env': {
      void downloadEnvHandler(session, msg.fingerprint);
      return;
    }
    case 'archive-project': {
      void vscode.commands
        .executeCommand('vaultpilot.archiveProject', {
          fingerprint: msg.fingerprint,
          displayName: msg.displayName,
        })
        .then(() => {
          notifyDashboardChanged();
        });
      return;
    }
    case 'unarchive-project': {
      void vscode.commands
        .executeCommand('vaultpilot.promoteArchived', {
          fingerprint: msg.fingerprint,
          displayName: msg.displayName,
        })
        .then(() => {
          notifyDashboardChanged();
        });
      return;
    }
    case 'delete-archived': {
      void vscode.commands
        .executeCommand('vaultpilot.deleteArchived', {
          fingerprint: msg.fingerprint,
          displayName: msg.displayName,
        })
        .then(() => {
          notifyDashboardChanged();
        });
      return;
    }
  }
}

function buildPayload(
  msg: WebviewRequest & { credentialId: string; fingerprint: string },
  session: VaultSession,
): { credentialId: string; archivedFingerprint?: string } {
  if (session.getFingerprint() === msg.fingerprint) {
    return { credentialId: msg.credentialId };
  }
  return { credentialId: msg.credentialId, archivedFingerprint: msg.fingerprint };
}

async function sendSettings(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  session: VaultSession,
): Promise<void> {
  const cfg = readSettings(defaultHost);
  const lastBackupInfo = context.globalState.get<DriveBackupInfo | null>(
    GLOBAL_STATE.DRIVE_LAST_BACKUP,
    null,
  );
  const localLastBackup = context.globalState.get<LocalBackupInfo | null>(
    GLOBAL_STATE.LOCAL_LAST_BACKUP,
    null,
  );
  const pkgRaw = await readFile(path.join(context.extensionUri.fsPath, 'package.json'), 'utf8');
  const pkgJson = JSON.parse(pkgRaw) as { version?: string };
  void session;
  const settings: DashboardSettings = {
    driveBackupEnabled: cfg.driveBackupEnabled,
    driveLastBackupAt: lastBackupInfo?.uploadedAt ?? null,
    driveLastBackup:
      lastBackupInfo === null
        ? null
        : {
            bytes: lastBackupInfo.bytes,
            md5: lastBackupInfo.md5,
            fileId: lastBackupInfo.fileId,
            fileName: lastBackupInfo.fileName,
          },
    localLastBackup,
    vaultRoot: VAULT_ROOT.replace(process.env['HOME'] ?? '', '~'),
    version: pkgJson.version ?? '0.0.1',
    autoLockOnIdle: true,
  };
  panel.webview.postMessage({
    kind: 'settings-loaded',
    settings,
  } satisfies ExtensionResponse);
}

/**
 * Live-fetch the backup file metadata from Drive's appdata folder and
 * post it back to the webview. Used by the "Refresh" button on the
 * Drive Sync card.
 */
async function liveRefreshDriveBackup(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  secretStorage: SecretStorageWrapper,
): Promise<void> {
  const cfg = readSettings(defaultHost);
  if (
    cfg.driveOAuthClientId.length === 0 ||
    cfg.driveOAuthClientSecret.length === 0 ||
    !cfg.driveBackupEnabled
  ) {
    panel.webview.postMessage({
      kind: 'drive-backup-info',
      info: null,
      error: 'Drive backup is not configured. Enable it in Settings and provide your OAuth credentials.',
    } satisfies ExtensionResponse);
    return;
  }

  const refreshResult = await secretStorage.getDriveRefreshToken();
  if (!refreshResult.ok || refreshResult.value === null) {
    panel.webview.postMessage({
      kind: 'drive-backup-info',
      info: null,
      error: 'No Drive refresh token. Run Sync Now once to authorize.',
    } satisfies ExtensionResponse);
    return;
  }

  // Explicitly refresh now so the first Drive call has a valid token.
  // (The empty-token + 401-driven refresh path is fragile — some Drive
  // endpoints respond 403 instead of 401 to a missing bearer token,
  // which bypasses silent refresh.)
  const tokenResult = await refreshAccessToken({
    clientId: cfg.driveOAuthClientId,
    clientSecret: cfg.driveOAuthClientSecret,
    refreshToken: refreshResult.value,
  });
  if (!tokenResult.ok) {
    panel.webview.postMessage({
      kind: 'drive-backup-info',
      info: null,
      error: errorToUserMessage(tokenResult.error),
    } satisfies ExtensionResponse);
    return;
  }
  const client = new DriveClient(
    tokenResult.value.accessToken,
    tokenResult.value.expiresIn,
    cfg.driveOAuthClientId,
    cfg.driveOAuthClientSecret,
    secretStorage,
  );
  const list = await client.listAppdataFilesByName(cfg.driveBackupFolderName);
  if (!list.ok) {
    panel.webview.postMessage({
      kind: 'drive-backup-info',
      info: null,
      error: errorToUserMessage(list.error),
    } satisfies ExtensionResponse);
    return;
  }
  const file = list.value[0];
  if (file === undefined) {
    panel.webview.postMessage({
      kind: 'drive-backup-info',
      info: null,
      error: `No file named "${cfg.driveBackupFolderName}" found in Drive appdata.`,
    } satisfies ExtensionResponse);
    return;
  }

  const info: DriveBackupSummary = {
    fileId: file.id,
    fileName: file.name,
    bytes: file.size ?? 0,
    md5: file.md5Checksum ?? null,
    modifiedTime: file.modifiedTime ?? null,
  };
  panel.webview.postMessage({
    kind: 'drive-backup-info',
    info,
    error: null,
  } satisfies ExtensionResponse);
  void context; // currently unused; kept in signature for future use
}

/**
 * Inspect what's in the Drive backup — download, extract, decrypt with the
 * user's passphrase, and post a project-level summary back to the webview.
 */
async function inspectDriveBackupHandler(
  panel: vscode.WebviewPanel,
  secretStorage: SecretStorageWrapper,
): Promise<void> {
  const cfg = readSettings(defaultHost);
  if (
    !cfg.driveBackupEnabled ||
    cfg.driveOAuthClientId.length === 0 ||
    cfg.driveOAuthClientSecret.length === 0
  ) {
    panel.webview.postMessage({
      kind: 'drive-backup-contents',
      inspection: null,
      error: 'Drive backup is not configured.',
    } satisfies ExtensionResponse);
    return;
  }

  const stored = await secretStorage.getDriveRefreshToken();
  if (!stored.ok || stored.value === null) {
    panel.webview.postMessage({
      kind: 'drive-backup-contents',
      inspection: null,
      error: 'No Drive refresh token. Run Sync Now once to authorize.',
    } satisfies ExtensionResponse);
    return;
  }

  const passphrase = await promptPassphrase(
    'Enter the passphrase used to encrypt your project vaults. Projects with a different passphrase will appear locked.',
  );
  if (passphrase === null) return;

  try {
    const tokenResult = await refreshAccessToken({
      clientId: cfg.driveOAuthClientId,
      clientSecret: cfg.driveOAuthClientSecret,
      refreshToken: stored.value,
    });
    if (!tokenResult.ok) {
      panel.webview.postMessage({
        kind: 'drive-backup-contents',
        inspection: null,
        error: errorToUserMessage(tokenResult.error),
      } satisfies ExtensionResponse);
      return;
    }
    const client = new DriveClient(
      tokenResult.value.accessToken,
      tokenResult.value.expiresIn,
      cfg.driveOAuthClientId,
      cfg.driveOAuthClientSecret,
      secretStorage,
    );
    const result = await inspectDriveBackup(client, cfg.driveBackupFolderName, passphrase);
    if (!result.ok) {
      panel.webview.postMessage({
        kind: 'drive-backup-contents',
        inspection: null,
        error: errorToUserMessage(result.error),
      } satisfies ExtensionResponse);
      return;
    }
    panel.webview.postMessage({
      kind: 'drive-backup-contents',
      inspection: {
        fileBytes: result.value.fileBytes,
        projects: result.value.projects.map((p) => ({
          fingerprint: p.fingerprint,
          displayName: p.displayName,
          status: p.status,
          unlockState: p.unlockState,
          credentialNames: p.credentialNames,
        })),
      },
      error: null,
    } satisfies ExtensionResponse);
  } finally {
    zeroBuffer(passphrase);
  }
}

/**
 * Export a project's credentials as a `.env` file. Opens a save dialog
 * so the user picks where the plaintext lands.
 */
async function downloadEnvHandler(
  session: VaultSession,
  fingerprint: string,
): Promise<void> {
  const result = await loadProjectCredentials(session, fingerprint);
  if (!result.ok) {
    if (result.error.kind === 'crypto.wrong-passphrase') {
      void vscode.window.showWarningMessage(
        'Project is locked. Open it in the dashboard first to unlock, then try again.',
      );
      return;
    }
    void vscode.window.showErrorMessage(errorToUserMessage(result.error));
    return;
  }
  const credentials = result.value;
  if (credentials.length === 0) {
    void vscode.window.showInformationMessage('This project has no credentials to export.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Export ${String(credentials.length)} credential${credentials.length === 1 ? '' : 's'} as a plaintext .env file?`,
    { modal: true, detail: 'Values will be written in cleartext to the file you choose.' },
    'Export',
  );
  if (confirm !== 'Export') return;

  const defaultName = '.env';
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri =
    workspaceUri !== undefined ? vscode.Uri.joinPath(workspaceUri, defaultName) : undefined;
  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Export .env',
    title: 'Export Credentials as .env',
    ...(defaultUri !== undefined ? { defaultUri } : {}),
    filters: { 'Env Files': ['env', 'env.local', 'env.production'] },
  });
  if (target === undefined) return;

  const header = `# Exported from VaultPilot — ${new Date().toISOString()}\n# Project fingerprint: ${fingerprint}`;
  const content = credentialsToEnvFile(credentials, { header });
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    void vscode.window.showInformationMessage(`Exported ${String(credentials.length)} credentials to ${target.fsPath}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to write .env file: ${String(err)}`);
  }
}

/**
 * Step 1 of local inspect: list every vault in the most-recent local backup
 * folder WITHOUT decrypting. Each entry has displayName + fingerprint + status;
 * passphrase is only needed when the user later asks to view a specific vault.
 */
async function inspectLocalBackupHandler(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  const info = context.globalState.get<LocalBackupInfo | null>(
    GLOBAL_STATE.LOCAL_LAST_BACKUP,
    null,
  );
  if (info === null) {
    panel.webview.postMessage({
      kind: 'local-backup-vaults',
      vaults: null,
      folder: null,
      error: 'No local backup yet. Click "Back Up Locally" first.',
    } satisfies ExtensionResponse);
    return;
  }
  const result = await listLocalBackupVaults(info.folder);
  if (!result.ok) {
    panel.webview.postMessage({
      kind: 'local-backup-vaults',
      vaults: null,
      folder: info.folder,
      error: errorToUserMessage(result.error),
    } satisfies ExtensionResponse);
    return;
  }
  panel.webview.postMessage({
    kind: 'local-backup-vaults',
    vaults: result.value,
    folder: info.folder,
    error: null,
  } satisfies ExtensionResponse);
}

/**
 * Verify the persisted local backup against disk. If the folder is gone, clear
 * the state so the dashboard reverts to "Never". If still present, recompute
 * the vault counts + total bytes (covers external add/remove of .env.zip
 * files between backups).
 */
async function refreshLocalBackupHandler(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  session: VaultSession,
): Promise<void> {
  const info = context.globalState.get<LocalBackupInfo | null>(
    GLOBAL_STATE.LOCAL_LAST_BACKUP,
    null,
  );
  if (info === null) {
    void vscode.window.showInformationMessage(
      'No local backup recorded yet. Click "Back Up Locally" to create one.',
    );
    return;
  }

  const fs = await import('node:fs/promises');
  let stat;
  try {
    stat = await fs.stat(info.folder);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isDirectory()) {
    await context.globalState.update(GLOBAL_STATE.LOCAL_LAST_BACKUP, null);
    void sendSettings(panel, context, session);
    void vscode.window.showWarningMessage(
      `Backup folder ${info.folder} is gone. Cleared local backup info — run Back Up Locally to create a new one.`,
    );
    return;
  }

  // Folder exists — recompute live state.
  const vaultsResult = await listLocalBackupVaults(info.folder);
  if (!vaultsResult.ok) {
    void vscode.window.showErrorMessage(errorToUserMessage(vaultsResult.error));
    return;
  }
  const vaults = vaultsResult.value;
  const bytes = await computeFolderSize(info.folder, fs);
  const projectsCopied = vaults.filter((v) => v.status === 'active' && v.hasZip).length;
  const archivedCopied = vaults.filter((v) => v.status === 'archived' && v.hasZip).length;

  const updated: LocalBackupInfo = {
    uploadedAt: info.uploadedAt, // preserve the original backup timestamp
    folder: info.folder,
    bytes,
    projectsCopied,
    archivedCopied,
  };
  await context.globalState.update(GLOBAL_STATE.LOCAL_LAST_BACKUP, updated);
  void sendSettings(panel, context, session);

  const total = projectsCopied + archivedCopied;
  void vscode.window.showInformationMessage(
    `Refreshed local backup — ${String(total)} vault${total === 1 ? '' : 's'} on disk in ${info.folder}.`,
  );
}

async function computeFolderSize(
  folder: string,
  fs: typeof import('node:fs/promises'),
): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        try {
          const s = await fs.stat(child);
          total += s.size;
        } catch {
          // skip unreadable
        }
      }
    }
  };
  await walk(folder);
  return total;
}

/**
 * Reveal a vault's encrypted .zip file in the OS file manager so the user
 * can double-click it and decrypt externally (Keka / 7-Zip / WinZip).
 *
 * VaultPilot doesn't decrypt the AES ZIPs in-app — they're produced for
 * portability, deliberately openable WITHOUT VaultPilot.
 */
async function revealLocalVaultHandler(
  context: vscode.ExtensionContext,
  fingerprint: string,
  status: 'active' | 'archived',
): Promise<void> {
  const info = context.globalState.get<LocalBackupInfo | null>(
    GLOBAL_STATE.LOCAL_LAST_BACKUP,
    null,
  );
  if (info === null) {
    void vscode.window.showWarningMessage('No local backup folder is configured.');
    return;
  }

  const subdir = status === 'active' ? 'projects' : 'archive';
  const entryDir = path.join(info.folder, subdir, fingerprint);
  let zipFile: string | undefined;
  try {
    const fs = await import('node:fs/promises');
    const files = await fs.readdir(entryDir);
    zipFile = files.find((f) => f.endsWith(BACKUP_FILE_EXT));
  } catch {
    // fall through
  }
  if (zipFile === undefined) {
    void vscode.window.showErrorMessage(
      `No .env.zip file found for this vault in ${entryDir}.`,
    );
    return;
  }
  const zipPath = path.join(entryDir, zipFile);
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath));
}

// Silence unused-import warning if `Result` / `CryptoError` aren't used directly here.
void Result;
void CryptoError;
