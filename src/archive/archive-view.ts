import * as path from 'node:path';

import * as vscode from 'vscode';

import { isPairCredential, type Credential } from '../credentials/credential';
import { ARCHIVE_DIR, listVaultEntries, readFileOrNull } from '../vault/io';
import { readArchivedEntry } from './archive-decrypt';
import type { VaultSession } from '../vault/vault-session';

/**
 * Archived Vaults TreeDataProvider (Story 2.2, FR-29, FR-30).
 *
 * Two-level tree:
 *   - Root: one item per archived project (fingerprint), labeled by
 *     displayName from `meta.json` (unencrypted, no passphrase needed).
 *   - Children: credentials decrypted via the per-fingerprint key cache in
 *     `VaultSession`. If the key isn't cached yet, a single "Click to unlock"
 *     placeholder appears; the user runs `vaultpilot.unlockArchived` which
 *     prompts for the passphrase, derives the entry's key, caches it, and
 *     refreshes.
 *
 * Read-only contract (FR-30): credentials get only Copy and Reveal context
 * actions via package.json's `view/item/context` menu — NO Edit, NO Delete.
 * The contextValue `vaultpilot.archived.credential` distinguishes them from
 * the active-view's `vaultpilot.credential`.
 */

const MASK = '••••••••';

export type ArchiveTreeItem = ArchiveProjectItem | ArchiveCredentialItem | UnlockPromptItem;

export class ArchiveProjectItem extends vscode.TreeItem {
  readonly kind = 'project' as const;
  readonly fingerprint: string;
  readonly displayName: string;

  constructor(fingerprint: string, displayName: string, lastKnownPath: string | null) {
    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.fingerprint = fingerprint;
    this.displayName = displayName;
    this.description = lastKnownPath ?? '';
    this.tooltip = `Archived: ${displayName}\nLast known path: ${lastKnownPath ?? '(unknown)'}\nFingerprint: ${fingerprint}`;
    this.contextValue = 'vaultpilot.archived.project';
    this.iconPath = new vscode.ThemeIcon('archive');
  }
}

export class ArchiveCredentialItem extends vscode.TreeItem {
  readonly kind = 'credential' as const;
  readonly fingerprint: string;
  readonly credentialId: string;

  constructor(fingerprint: string, credential: Credential) {
    super(credential.name, vscode.TreeItemCollapsibleState.None);
    this.fingerprint = fingerprint;
    this.credentialId = credential.id;
    this.description = `${credential.type} — ${MASK}`;
    this.tooltip = buildTooltip(credential);
    this.contextValue = isPairCredential(credential)
      ? 'vaultpilot.archived.credential.pair'
      : 'vaultpilot.archived.credential';
    this.iconPath = new vscode.ThemeIcon('key');
    // Default click: copy from archive (uses same clipboard auto-clear).
    this.command = {
      command: 'vaultpilot.copyCredential',
      title: 'Copy',
      arguments: [{ credentialId: credential.id, archivedFingerprint: fingerprint }],
    };
  }
}

class UnlockPromptItem extends vscode.TreeItem {
  readonly kind = 'unlock-prompt' as const;
  readonly fingerprint: string;

  constructor(fingerprint: string) {
    super('Click to unlock and view credentials', vscode.TreeItemCollapsibleState.None);
    this.fingerprint = fingerprint;
    this.iconPath = new vscode.ThemeIcon('unlock');
    this.command = {
      command: 'vaultpilot.unlockArchived',
      title: 'Unlock archived entry',
      arguments: [{ fingerprint }],
    };
  }
}

function buildTooltip(credential: Credential): string {
  const lines = [`Name: ${credential.name}`, `Type: ${credential.type}`, '(Archived — read-only)'];
  if (credential.notes !== undefined && credential.notes.length > 0) {
    lines.push(`Notes: ${credential.notes}`);
  }
  if (isPairCredential(credential)) {
    lines.push(`Fields: ${credential.fields.fieldA.label}, ${credential.fields.fieldB.label}`);
  }
  return lines.join('\n');
}

interface ArchiveMetaJson {
  readonly displayName?: string;
  readonly lastKnownPath?: string;
}

export class ArchiveTreeDataProvider implements vscode.TreeDataProvider<ArchiveTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ArchiveTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly session: VaultSession) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ArchiveTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ArchiveTreeItem): Promise<ArchiveTreeItem[]> {
    if (element === undefined) {
      // Root — list archived projects.
      return this.listProjects();
    }
    if (element.kind === 'project') {
      return this.listProjectCredentials(element.fingerprint);
    }
    return [];
  }

  private async listProjects(): Promise<ArchiveProjectItem[]> {
    const entriesResult = await listVaultEntries(ARCHIVE_DIR);
    if (!entriesResult.ok) return [];
    const items: ArchiveProjectItem[] = [];
    for (const fp of entriesResult.value) {
      const meta = await readArchivedMeta(fp);
      const displayName = meta?.displayName ?? `(unnamed) ${fp.slice(0, 8)}`;
      items.push(new ArchiveProjectItem(fp, displayName, meta?.lastKnownPath ?? null));
    }
    return items.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private async listProjectCredentials(fingerprint: string): Promise<ArchiveTreeItem[]> {
    const decryptResult = await readArchivedEntry(this.session, fingerprint);
    if (!decryptResult.ok) {
      // Wrong-passphrase here means "no cached key yet" — show unlock prompt.
      return [new UnlockPromptItem(fingerprint)];
    }
    return decryptResult.value.credentials.map(
      (c) => new ArchiveCredentialItem(fingerprint, c),
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

async function readArchivedMeta(fingerprint: string): Promise<ArchiveMetaJson | null> {
  const metaPath = path.join(ARCHIVE_DIR, fingerprint, 'meta.json');
  const metaResult = await readFileOrNull(metaPath);
  if (!metaResult.ok || metaResult.value === null) return null;
  try {
    return JSON.parse(metaResult.value.toString('utf8')) as ArchiveMetaJson;
  } catch {
    return null;
  }
}
