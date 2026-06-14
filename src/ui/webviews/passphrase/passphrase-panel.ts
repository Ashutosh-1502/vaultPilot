import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { normalizePassphrase } from '../../../vault/passphrase-normalize';

/**
 * Webview-based passphrase prompt — replaces VS Code's native
 * `showInputBox({password: true})`.
 *
 * Modes:
 *   - 'single': one input (unlock, restore, archive-unlock, env-import, ...)
 *   - 'confirm': two inputs that must match (first-run vault set-up)
 *
 * The promise returned by `showPassphrasePrompt` resolves with the
 * NFC-normalized UTF-8 Buffer of the entered passphrase, or `null` if the
 * user cancelled / closed the panel.
 *
 * Caller MUST `zeroBuffer()` the returned Buffer when done.
 */

export interface PassphrasePromptOptions {
  readonly mode: 'single' | 'confirm';
  readonly title: string;
  readonly subtitle: string;
  readonly label: string;
  readonly hint?: string;
  readonly submitLabel?: string;
}

let extensionUri: vscode.Uri | null = null;
let activePanel: vscode.WebviewPanel | null = null;

/**
 * Called once at extension activation to capture the extensionUri for
 * resolving asset paths. Avoids threading it through every call site.
 */
export function initPassphrasePromptModule(uri: vscode.Uri): void {
  extensionUri = uri;
}

export async function showPassphrasePrompt(
  options: PassphrasePromptOptions,
): Promise<Buffer | null> {
  if (extensionUri === null) {
    void vscode.window.showErrorMessage(
      'Passphrase prompt module not initialized. This is a bug — please report.',
    );
    return null;
  }

  // Dispose any previous prompt — single-instance.
  if (activePanel !== null) {
    activePanel.dispose();
    activePanel = null;
  }

  const panel = vscode.window.createWebviewPanel(
    'vaultpilot.passphrase',
    `VaultPilot — ${options.title}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    },
  );
  activePanel = panel;
  panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vaultpilot-logo.svg');
  panel.webview.html = await renderHtml(panel.webview, extensionUri, options);

  return new Promise<Buffer | null>((resolve) => {
    let settled = false;
    const settle = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      activePanel = null;
      panel.dispose();
      resolve(value);
    };

    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        activePanel = null;
        resolve(null);
      }
    });

    panel.webview.onDidReceiveMessage((msg: { kind: string; value?: string }) => {
      if (msg.kind === 'cancel') {
        settle(null);
        return;
      }
      if (msg.kind === 'submit') {
        const raw = msg.value ?? '';
        if (raw.length === 0) {
          settle(null);
          return;
        }
        const buf = normalizePassphrase(raw);
        settle(buf);
      }
    });
  });
}

async function renderHtml(
  webview: vscode.Webview,
  ext: vscode.Uri,
  options: PassphrasePromptOptions,
): Promise<string> {
  const htmlPath = path.join(ext.fsPath, 'media', 'passphrase', 'index.html');
  const template = await readFile(htmlPath, 'utf8');

  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'passphrase', 'styles.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'passphrase', 'passphrase.js'));
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'vaultpilot-logo.svg'));
  const nonce = randomUUID().replace(/-/g, '');

  const modeScript = `<script nonce="${nonce}">window.__VP_MODE__ = ${JSON.stringify(options.mode)};</script>`;

  const submitLabel = options.submitLabel ?? (options.mode === 'confirm' ? 'Create Vault' : 'Submit');

  return template
    .replace(/\$\{cspSource\}/g, webview.cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{cssUri\}/g, cssUri.toString())
    .replace(/\$\{jsUri\}/g, jsUri.toString())
    .replace(/\$\{logoUri\}/g, logoUri.toString())
    .replace(/\$\{title\}/g, escapeHtml(options.title))
    .replace(/\$\{subtitle\}/g, escapeHtml(options.subtitle))
    .replace(/\$\{label\}/g, escapeHtml(options.label))
    .replace(/\$\{hint\}/g, escapeHtml(options.hint ?? ''))
    .replace(/\$\{submitLabel\}/g, escapeHtml(submitLabel))
    .replace('<script nonce=', `${modeScript}\n  <script nonce=`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
