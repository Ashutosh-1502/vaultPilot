import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import {
  CREDENTIAL_TYPES,
  type Credential,
  type CredentialType,
  type EnvVarNameCredential,
  type PairCredential,
} from '../../credentials/credential';
import { errorToUserMessage } from '../error-to-message';
import { persistVault } from '../../vault/persist';
import type { VaultSession } from '../../vault/vault-session';

/**
 * "Add Multiple Credentials" webview (2026-06-13 — dogfood-driven addition).
 *
 * Replaces the chained-showInputBox add flow with a form panel: rows of
 * (name, type, value, notes) you can add/remove freely. Click **Save All**
 * once at the end → bulk-add → one re-encrypt + atomic write.
 *
 * Also serves as the .env import UI when invoked with `seed.importMode = true`:
 * pre-populates rows from parsed env entries and, on save, overwrites
 * existing credentials by name (matching `importEnvEntries` semantics).
 *
 * Webview UI is plain HTML + CSS + a small inline script. Uses VS Code's
 * CSS variables for theming so it picks up your active color theme.
 */

interface RowPayload {
  readonly name: string;
  readonly type: CredentialType;
  readonly value?: string;
  readonly fieldALabel?: string;
  readonly fieldAValue?: string;
  readonly fieldBLabel?: string;
  readonly fieldBValue?: string;
  readonly notes?: string;
}

interface SaveMessage {
  readonly kind: 'save';
  readonly rows: readonly RowPayload[];
}

interface CancelMessage {
  readonly kind: 'cancel';
}

type WebviewMessage = SaveMessage | CancelMessage;

export interface SeededRow {
  readonly name: string;
  readonly type: CredentialType;
  readonly value: string;
}

export interface AddMultipleSeed {
  readonly rows: readonly SeededRow[];
  /** When true, save replaces existing credentials with the same name (env-import semantics). */
  readonly overwriteByName: boolean;
  readonly title?: string;
  readonly subtitle?: string;
  readonly submitLabel?: string;
}

export function openAddMultipleWebview(
  session: VaultSession,
  onChange: () => void,
  extensionUri: vscode.Uri,
  seed?: AddMultipleSeed,
): Promise<void> {
  if (!session.isUnlocked()) {
    void vscode.window.showWarningMessage('Vault is locked. Set up or unlock first.');
    return Promise.resolve();
  }

  const panelTitle = seed?.title ?? 'VaultPilot — Add Multiple Credentials';
  const panel = vscode.window.createWebviewPanel(
    'vaultpilot.addMultiple',
    panelTitle,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [extensionUri],
    },
  );

  panel.webview.html = renderWebviewHtml(panel.webview, seed);

  return new Promise<void>((resolve) => {
    panel.onDidDispose(() => {
      resolve();
    });

    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg.kind === 'cancel') {
        panel.dispose();
        return;
      }
      void (async () => {
        const result = await saveAll(session, msg.rows, seed?.overwriteByName ?? false);
        if (result.kind === 'error') {
          void vscode.window.showErrorMessage(result.message);
          return;
        }
        onChange();
        const noun =
          seed?.overwriteByName === true
            ? `${result.created > 0 ? `${String(result.created)} new` : ''}${
                result.created > 0 && result.overwritten > 0 ? ' + ' : ''
              }${result.overwritten > 0 ? `${String(result.overwritten)} overwritten` : ''}`
            : `${String(result.created)} credential${result.created === 1 ? '' : 's'}`;
        const summary = noun.length === 0 ? 'no changes' : noun;
        void vscode.window.showInformationMessage(
          seed?.overwriteByName === true
            ? `Imported ${summary}.`
            : `Added ${summary}.`,
        );
        panel.dispose();
      })();
    });
  });
}

type SaveResult =
  | { kind: 'ok'; created: number; overwritten: number }
  | { kind: 'error'; message: string };

async function saveAll(
  session: VaultSession,
  rows: readonly RowPayload[],
  overwriteByName: boolean,
): Promise<SaveResult> {
  const credentials: Credential[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const built = buildCredentialFromRow(row);
    if (built === null) {
      return { kind: 'error', message: `Row ${String(i + 1)}: invalid or incomplete.` };
    }
    credentials.push(built);
  }
  if (credentials.length === 0) {
    return { kind: 'error', message: 'No rows to save — add at least one credential.' };
  }

  const existingResult = session.getCredentials();
  if (!existingResult.ok) {
    return { kind: 'error', message: errorToUserMessage(existingResult.error) };
  }
  const prior = [...existingResult.value];

  let next: Credential[];
  let created = 0;
  let overwritten = 0;
  if (overwriteByName) {
    next = [...prior];
    const now = new Date().toISOString();
    for (const cred of credentials) {
      const idx = next.findIndex((c) => c.name === cred.name);
      if (idx >= 0) {
        const priorEntry = next[idx];
        if (priorEntry !== undefined) {
          next[idx] = { ...cred, id: priorEntry.id, created: priorEntry.created, updated: now };
          overwritten++;
          continue;
        }
      }
      next.push(cred);
      created++;
    }
  } else {
    next = [...prior, ...credentials];
    created = credentials.length;
  }

  const setResult = session.setCredentials(next);
  if (!setResult.ok) {
    return { kind: 'error', message: errorToUserMessage(setResult.error) };
  }
  const persistResult = await persistVault(session);
  if (!persistResult.ok) {
    session.setCredentials(prior);
    return { kind: 'error', message: errorToUserMessage(persistResult.error) };
  }

  return { kind: 'ok', created, overwritten };
}

function buildCredentialFromRow(row: RowPayload): Credential | null {
  const name = row.name.trim();
  if (name.length === 0) return null;
  const now = new Date().toISOString();
  const base = {
    id: randomUUID(),
    name,
    created: now,
    updated: now,
    ...(row.notes !== undefined && row.notes.length > 0 ? { notes: row.notes } : {}),
  } as const;

  switch (row.type) {
    case 'user/password-pair': {
      const a = (row.fieldAValue ?? '').length > 0 && (row.fieldALabel ?? '').trim().length > 0;
      const b = (row.fieldBValue ?? '').length > 0 && (row.fieldBLabel ?? '').trim().length > 0;
      if (!a || !b) return null;
      const cred: PairCredential = {
        ...base,
        type: 'user/password-pair',
        fields: {
          fieldA: { label: (row.fieldALabel ?? '').trim(), value: row.fieldAValue ?? '' },
          fieldB: { label: (row.fieldBLabel ?? '').trim(), value: row.fieldBValue ?? '' },
        },
      };
      return cred;
    }
    case 'json-blob': {
      const v = row.value ?? '';
      if (v.length === 0) return null;
      try {
        JSON.parse(v);
      } catch {
        return null;
      }
      return { ...base, type: 'json-blob', value: v };
    }
    case 'env-var-name': {
      const v = row.value ?? '';
      if (v.length === 0) return null;
      const cred: EnvVarNameCredential = { ...base, type: 'env-var-name', value: v };
      return cred;
    }
    default: {
      // string | api-key | token
      const v = row.value ?? '';
      if (v.length === 0) return null;
      return { ...base, type: row.type, value: v };
    }
  }
}

function renderWebviewHtml(webview: vscode.Webview, seed?: AddMultipleSeed): string {
  const nonce = randomUUID().replace(/-/g, '');
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const heading = seed?.title?.replace(/^VaultPilot — /, '') ?? 'Add Multiple Credentials';
  const subtitle =
    seed?.subtitle ??
    'Fill in as many rows as you want. Click "Save All" when done. Empty rows are ignored.';
  const submitLabel = seed?.submitLabel ?? 'Save All';
  const seededJson = JSON.stringify(seed?.rows ?? []);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Add Multiple Credentials</title>
<style>
  /* Branded surface — tokens mirror docs/DESIGN.md */
  :root {
    color-scheme: dark;
    --vp-surface: #0b1326;
    --vp-surface-container-low: #131b2e;
    --vp-surface-container: #171f33;
    --vp-surface-container-high: #222a3d;
    --vp-on-surface: #dae2fd;
    --vp-on-surface-variant: #bacac5;
    --vp-outline: #859490;
    --vp-outline-variant: #3c4a46;
    --vp-primary: #57f1db;
    --vp-primary-container: #2dd4bf;
    --vp-on-primary-container: #00574d;
    --vp-secondary: #7bd0ff;
    --vp-danger: #F87171;
    --vp-font-ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --vp-font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
    --vp-radius-md: 0.25rem;
    --vp-radius-lg: 0.5rem;
  }
  body {
    font-family: var(--vp-font-ui);
    color: var(--vp-on-surface);
    background: var(--vp-surface);
    padding: 24px 32px;
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }
  h1 {
    font-size: 1.5rem;
    line-height: 2rem;
    letter-spacing: -0.02em;
    margin: 0 0 4px 0;
    font-weight: 600;
  }
  .subtitle {
    color: var(--vp-on-surface-variant);
    margin: 0 0 20px 0;
    font-size: 0.875rem;
    line-height: 1.4;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) 150px minmax(200px, 2fr) minmax(140px, 1fr) auto;
    gap: 8px;
    align-items: start;
    padding: 10px;
    border: 1px solid var(--vp-outline-variant);
    border-radius: var(--vp-radius-lg);
    margin-bottom: 8px;
    background: var(--vp-surface-container);
    transition: border-color 120ms ease;
  }
  .row:hover { border-color: var(--vp-primary-container); }
  .row.pair {
    grid-template-columns: minmax(160px, 1fr) 150px minmax(280px, 2fr) minmax(140px, 1fr) auto;
  }
  .field-label {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--vp-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
    display: block;
  }
  input, select, textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    background: var(--vp-surface-container-low);
    color: var(--vp-on-surface);
    border: 1px solid var(--vp-outline-variant);
    border-radius: var(--vp-radius-md);
    font-family: var(--vp-font-mono);
    font-size: 0.85rem;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  input[data-field="name"], input[data-field="notes"], select { font-family: var(--vp-font-ui); }
  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--vp-secondary);
    box-shadow: 0 0 0 3px rgba(123, 208, 255, 0.18);
  }
  textarea { resize: vertical; min-height: 36px; }
  .pair-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .pair-field {
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 4px;
  }
  .remove-btn {
    background: transparent;
    border: 1px solid var(--vp-outline-variant);
    color: var(--vp-danger);
    border-radius: var(--vp-radius-md);
    width: 32px;
    height: 32px;
    cursor: pointer;
    margin-top: 20px;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .remove-btn:hover {
    background: rgba(248, 113, 113, 0.08);
    border-color: var(--vp-danger);
  }
  .toolbar {
    display: flex;
    gap: 8px;
    margin: 16px 0;
    align-items: center;
  }
  button.primary {
    background: var(--vp-primary-container);
    color: var(--vp-on-primary-container);
    border: none;
    padding: 8px 18px;
    border-radius: var(--vp-radius-md);
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    font-family: var(--vp-font-ui);
    transition: background 120ms ease, transform 80ms ease;
  }
  button.primary:hover { background: var(--vp-primary); }
  button.primary:active { transform: translateY(1px); }
  button.secondary {
    background: transparent;
    color: var(--vp-primary);
    border: 1px solid var(--vp-outline-variant);
    padding: 7px 16px;
    border-radius: var(--vp-radius-md);
    font-size: 0.875rem;
    cursor: pointer;
    font-family: var(--vp-font-ui);
    transition: background 120ms ease, border-color 120ms ease;
  }
  button.secondary:hover {
    background: var(--vp-surface-container-high);
    border-color: var(--vp-primary);
  }
  .count {
    color: var(--vp-on-surface-variant);
    font-size: 0.85rem;
    margin-left: auto;
    font-family: var(--vp-font-mono);
  }
  .footer {
    display: flex;
    gap: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--vp-outline-variant);
    margin-top: 16px;
    justify-content: flex-end;
  }
  .vp-icon {
    display: inline-block;
    width: 16px;
    height: 16px;
    vertical-align: middle;
    flex-shrink: 0;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .vp-icon-sm { width: 14px; height: 14px; }
  button { display: inline-flex; align-items: center; gap: 6px; }
  .help {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vp-on-surface-variant);
    font-size: 0.8rem;
    margin: 8px 0 16px 0;
  }
</style>
</head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  <p class="subtitle">${escapeHtml(subtitle)}</p>
  <p class="help"><svg class="vp-icon vp-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01"/><path d="M11 12h1v5"/></svg> Tip: type-specific fields appear when you change the Type dropdown.</p>

  <div id="rows"></div>

  <div class="toolbar">
    <button id="add-row" class="secondary" type="button"><svg class="vp-icon vp-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="M4 12h16"/></svg><span>Add Row</span></button>
    <span class="count" id="row-count"></span>
  </div>

  <div class="footer">
    <button id="cancel" class="secondary" type="button">Cancel</button>
    <button id="save" class="primary" type="button">${escapeHtml(submitLabel)}</button>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const TYPES = ${JSON.stringify(CREDENTIAL_TYPES)};
      const SEEDED = ${seededJson};
      const rowsEl = document.getElementById('rows');
      const countEl = document.getElementById('row-count');
      let rowIdCounter = 0;
      let rows = [];

      function newRow() {
        const id = ++rowIdCounter;
        const row = {
          id,
          name: '',
          type: 'string',
          value: '',
          fieldALabel: '',
          fieldAValue: '',
          fieldBLabel: '',
          fieldBValue: '',
          notes: '',
        };
        rows.push(row);
        return row;
      }

      function removeRow(id) {
        rows = rows.filter((r) => r.id !== id);
        render();
      }

      function updateRow(id, patch) {
        const r = rows.find((x) => x.id === id);
        if (r) Object.assign(r, patch);
      }

      function makeTypeSelect(row) {
        const opts = TYPES.map((t) => '<option value="' + t + '"' + (t === row.type ? ' selected' : '') + '>' + t + '</option>').join('');
        return '<select data-row="' + row.id + '" data-field="type">' + opts + '</select>';
      }

      function makeValueField(row) {
        if (row.type === 'user/password-pair') {
          return [
            '<div class="pair-fields">',
              '<div class="pair-field">',
                '<input type="text" placeholder="Label A" data-row="' + row.id + '" data-field="fieldALabel" value="' + escapeAttr(row.fieldALabel) + '">',
                '<input type="password" placeholder="Value A" data-row="' + row.id + '" data-field="fieldAValue" value="' + escapeAttr(row.fieldAValue) + '">',
              '</div>',
              '<div class="pair-field">',
                '<input type="text" placeholder="Label B" data-row="' + row.id + '" data-field="fieldBLabel" value="' + escapeAttr(row.fieldBLabel) + '">',
                '<input type="password" placeholder="Value B" data-row="' + row.id + '" data-field="fieldBValue" value="' + escapeAttr(row.fieldBValue) + '">',
              '</div>',
            '</div>',
          ].join('');
        }
        if (row.type === 'json-blob') {
          return '<textarea placeholder=\\"JSON value\\" rows=\\"2\\" data-row=\\"' + row.id + '\\" data-field=\\"value\\">' + escapeText(row.value) + '</textarea>';
        }
        const masked = row.type === 'api-key' || row.type === 'token';
        return '<input type="' + (masked ? 'password' : 'text') + '" placeholder="Value" data-row="' + row.id + '" data-field="value" value="' + escapeAttr(row.value) + '">';
      }

      function makeRowHtml(row) {
        const namePlaceholder = row.type === 'env-var-name' ? 'Env-var name (DATABASE_URL)' : 'Credential name';
        const pairClass = row.type === 'user/password-pair' ? ' pair' : '';
        return [
          '<div class="row' + pairClass + '" data-row="' + row.id + '">',
            '<div>',
              '<label class="field-label">Name</label>',
              '<input type="text" placeholder="' + namePlaceholder + '" data-row="' + row.id + '" data-field="name" value="' + escapeAttr(row.name) + '">',
            '</div>',
            '<div>',
              '<label class="field-label">Type</label>',
              makeTypeSelect(row),
            '</div>',
            '<div>',
              '<label class="field-label">Value</label>',
              makeValueField(row),
            '</div>',
            '<div>',
              '<label class="field-label">Notes (optional)</label>',
              '<input type="text" placeholder="Optional notes" data-row="' + row.id + '" data-field="notes" value="' + escapeAttr(row.notes) + '">',
            '</div>',
            '<button class="remove-btn" title="Remove row" data-remove="' + row.id + '" type="button"><svg class="vp-icon vp-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg></button>',
          '</div>',
        ].join('');
      }

      function render() {
        rowsEl.innerHTML = rows.map(makeRowHtml).join('');
        countEl.textContent = rows.length + ' row' + (rows.length === 1 ? '' : 's');
      }

      function escapeAttr(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function escapeText(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      // Event delegation
      rowsEl.addEventListener('input', (e) => {
        const t = e.target;
        const id = parseInt(t.getAttribute('data-row'), 10);
        const field = t.getAttribute('data-field');
        if (!id || !field) return;
        const patch = {};
        patch[field] = t.value;
        updateRow(id, patch);
      });
      rowsEl.addEventListener('change', (e) => {
        const t = e.target;
        if (t.getAttribute('data-field') === 'type') {
          const id = parseInt(t.getAttribute('data-row'), 10);
          updateRow(id, { type: t.value });
          render();
        }
      });
      rowsEl.addEventListener('click', (e) => {
        const id = e.target.getAttribute && e.target.getAttribute('data-remove');
        if (id) removeRow(parseInt(id, 10));
      });
      document.getElementById('add-row').addEventListener('click', () => {
        newRow();
        render();
      });
      document.getElementById('cancel').addEventListener('click', () => {
        vscode.postMessage({ kind: 'cancel' });
      });
      document.getElementById('save').addEventListener('click', () => {
        // Filter out completely-empty rows
        const payload = rows
          .filter((r) => r.name.trim().length > 0 || r.value.length > 0 || r.fieldAValue.length > 0)
          .map((r) => {
            const out = { name: r.name, type: r.type };
            if (r.type === 'user/password-pair') {
              out.fieldALabel = r.fieldALabel;
              out.fieldAValue = r.fieldAValue;
              out.fieldBLabel = r.fieldBLabel;
              out.fieldBValue = r.fieldBValue;
            } else {
              out.value = r.value;
            }
            if (r.notes && r.notes.length > 0) out.notes = r.notes;
            return out;
          });
        vscode.postMessage({ kind: 'save', rows: payload });
      });

      if (SEEDED.length > 0) {
        for (const s of SEEDED) {
          const r = newRow();
          r.name = s.name || '';
          r.type = s.type || 'env-var-name';
          r.value = s.value || '';
        }
      } else {
        newRow(); newRow(); newRow();
      }
      render();
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
