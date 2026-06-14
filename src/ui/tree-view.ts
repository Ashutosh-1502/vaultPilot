import * as vscode from 'vscode';

import type { Credential } from '../credentials/credential';
import { isPairCredential } from '../credentials/credential';
import type { VaultSession } from '../vault/vault-session';

/**
 * VaultPilot active TreeDataProvider (Story 1.10).
 *
 * Renders the unlocked session's credentials as TreeItems. Each credential:
 *   - label: `name`
 *   - description: `type` (or `type` + auto-link warning if path-fingerprinted)
 *   - value: masked
 *   - contextValue: `vaultpilot.credential` (or `.pair` for pair-type, so the
 *     `view/item/context` menu can show different actions)
 *
 * When the session is locked OR no credentials exist, returns `[]`. VS Code's
 * `viewsWelcome` contribution then renders the appropriate welcome content
 * (Welcome / "Add credentials for this project?") based on context keys.
 */

const MASK = '••••••••';

export interface CredentialTreeItemData {
  readonly credentialId: string;
}

/**
 * Per-type icon mapping — uses VS Code's built-in codicons + ThemeColor so
 * each credential type gets a visually distinct row.
 *
 * The colors come from VS Code's theme palette and adapt to your active
 * theme automatically (light/dark/high-contrast).
 */
function iconForCredential(credential: Credential): vscode.ThemeIcon {
  switch (credential.type) {
    case 'string':
      return new vscode.ThemeIcon('symbol-string', new vscode.ThemeColor('charts.blue'));
    case 'api-key':
      return new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow'));
    case 'token':
      return new vscode.ThemeIcon('symbol-key', new vscode.ThemeColor('charts.orange'));
    case 'user/password-pair':
      return new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.purple'));
    case 'json-blob':
      return new vscode.ThemeIcon('json', new vscode.ThemeColor('charts.green'));
    case 'env-var-name':
      return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.foreground'));
  }
}

export class CredentialTreeItem extends vscode.TreeItem {
  readonly credentialId: string;

  constructor(credential: Credential) {
    super(credential.name, vscode.TreeItemCollapsibleState.None);
    this.credentialId = credential.id;
    this.description = describeCredential(credential);
    this.tooltip = buildTooltip(credential);
    this.contextValue = isPairCredential(credential)
      ? 'vaultpilot.credential.pair'
      : 'vaultpilot.credential';
    this.iconPath = iconForCredential(credential);
    this.command = {
      command: 'vaultpilot.copyCredential',
      title: 'Copy',
      arguments: [{ credentialId: credential.id } satisfies CredentialTreeItemData],
    };
  }
}

function describeCredential(credential: Credential): string {
  // Build a compact description: [type-badge] [value hint]
  const badge = `[${credential.type}]`;
  if (isPairCredential(credential)) {
    const { fieldA, fieldB } = credential.fields;
    return `${badge}  ${fieldA.label} + ${fieldB.label}  ${MASK}`;
  }
  // For single-value credentials, optionally show the first 4 chars as a
  // hint (so the user can distinguish "MONGO_URI = mongo..." from another
  // mongo connection string without needing to reveal/copy).
  const v = credential.value;
  const hint = v.length > 4 ? `${v.slice(0, 4)}…` : '';
  return `${badge}  ${MASK} ${hint.length > 0 ? `(${hint})` : ''}`.trimEnd();
}

function buildTooltip(credential: Credential): string {
  const lines = [`Name: ${credential.name}`, `Type: ${credential.type}`];
  if (credential.notes !== undefined && credential.notes.length > 0) {
    lines.push(`Notes: ${credential.notes}`);
  }
  if (isPairCredential(credential)) {
    lines.push(`Fields: ${credential.fields.fieldA.label}, ${credential.fields.fieldB.label}`);
  }
  lines.push(`Created: ${credential.created}`);
  if (credential.updated !== credential.created) {
    lines.push(`Updated: ${credential.updated}`);
  }
  return lines.join('\n');
}

export class VaultTreeDataProvider implements vscode.TreeDataProvider<CredentialTreeItem> {
  private readonly emitter = new vscode.EventEmitter<CredentialTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly session: VaultSession) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: CredentialTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CredentialTreeItem[] {
    if (!this.session.isUnlocked()) {
      return [];
    }
    const credsResult = this.session.getCredentials();
    if (!credsResult.ok) return [];
    return credsResult.value.map((c) => new CredentialTreeItem(c));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
