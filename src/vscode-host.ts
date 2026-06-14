import * as vscode from 'vscode';

/**
 * Thin wrapper around the `vscode` namespace surfaces that pure-logic modules
 * need. Unit tests substitute a fake implementation here without mocking the
 * global `vscode` import.
 *
 * Story 1.3 — establishes the VS Code API boundary. Pure-logic modules under
 * src/vault, src/fingerprint, src/credentials, src/archive, src/drive,
 * src/result, src/keychain, src/settings, src/logging must NOT import `vscode`
 * directly. They consume this wrapper instead. Enforced by ESLint.
 */
export interface VscodeHost {
  showInformationMessage(message: string): Thenable<string | undefined>;
  showWarningMessage(message: string): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<string | undefined>;
  showInputBox(options?: vscode.InputBoxOptions): Thenable<string | undefined>;
  showQuickPick(
    items: readonly vscode.QuickPickItem[],
    options?: vscode.QuickPickOptions,
  ): Thenable<vscode.QuickPickItem | undefined>;
  getConfiguration(section: string): vscode.WorkspaceConfiguration;
  workspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined;
  createOutputChannel(name: string): vscode.OutputChannel;
  createEventEmitter<T>(): vscode.EventEmitter<T>;
  getSecretStorage(context: vscode.ExtensionContext): vscode.SecretStorage;
  getGlobalState(context: vscode.ExtensionContext): vscode.Memento;
  getWorkspaceState(context: vscode.ExtensionContext): vscode.Memento;
}

export const defaultHost: VscodeHost = {
  showInformationMessage: (m) => vscode.window.showInformationMessage(m),
  showWarningMessage: (m) => vscode.window.showWarningMessage(m),
  showErrorMessage: (m) => vscode.window.showErrorMessage(m),
  showInputBox: (o) => vscode.window.showInputBox(o),
  showQuickPick: (items, o) => vscode.window.showQuickPick(items, o),
  getConfiguration: (section) => vscode.workspace.getConfiguration(section),
  workspaceFolders: () => vscode.workspace.workspaceFolders,
  createOutputChannel: (name) => vscode.window.createOutputChannel(name),
  createEventEmitter: <T>() => new vscode.EventEmitter<T>(),
  getSecretStorage: (ctx) => ctx.secrets,
  getGlobalState: (ctx) => ctx.globalState,
  getWorkspaceState: (ctx) => ctx.workspaceState,
};
