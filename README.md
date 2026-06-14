# VaultPilot

A VS Code extension that gives every project a persistent, recoverable credential store inside the editor.

## Status

Pre-release. Scaffolded from PRD + architecture; modules under active implementation.

## Development

```bash
npm install
npm run watch        # esbuild watch mode
# Press F5 in VS Code → Extension Development Host opens
```

Other commands:

```bash
npm run lint         # ESLint strict-type-checked
npm run typecheck    # tsc --noEmit
npm test             # mocha unit tests
npm run compile      # one-shot esbuild
npm run package      # production build for .vsix packaging
```

## Activation

The extension activates on the VaultPilot sidebar view (`onView:vaultpilot`). VS Code automatically derives command activation from the `contributes.commands` array in `package.json`, so no explicit `onCommand:*` activation events are needed (modern VS Code best practice; FR-11's "MUST NOT activate on `*`" is preserved).

## Configuration

### VS Code Marketplace publisher

Publisher is set to `ashutoshsuryavanshi` in `package.json`. Register at https://marketplace.visualstudio.com/manage before `vsce publish`.

### Google Drive backup (Epic 3)

Drive backup is opt-in and requires you to provide your own Google OAuth 2.0 client ID (PKCE-based — no `client_secret` is needed or used). VaultPilot uses a **loopback HTTP flow** (RFC 8252 §7.3 — the modern standard for desktop apps): during sign-in, the extension binds a temporary HTTP server on a random `127.0.0.1` port and Google redirects there with the authorization code. No URI handler registration needed.

To enable:

1. Create a project at https://console.cloud.google.com/.
2. Enable the **Google Drive API** at https://console.cloud.google.com/apis/library/drive.googleapis.com (or via APIs & Services → Library).
3. Configure the OAuth consent screen via the **Google Auth Platform** UI:
   - **Branding:** App name `VaultPilot`, your email as support + developer contact.
   - **Audience:** User type **External**; add your Gmail as a Test user.
   - **Data access:** add scope `https://www.googleapis.com/auth/drive.appdata`.
4. Under **Clients**, create an **OAuth 2.0 Client ID**:
   - **Application type: Desktop app** (NOT Web application — Google rejects `vscode://` URIs and most custom schemes in 2025+)
   - No redirect URI configuration needed — Desktop apps automatically allow `http://127.0.0.1:<any-port>/` and `http://localhost:<any-port>/` loopback redirects.
5. Copy the Client ID into VS Code settings: `vaultpilot.driveOAuthClientId`.
6. Toggle `vaultpilot.driveBackupEnabled` to `true`.
7. Run the command **VaultPilot: Back Up to Drive** to authenticate and back up.

The first time you sign in, your OS firewall may prompt about allowing Node to accept incoming connections on localhost. Allow it once — the server is only bound during the OAuth flow (~10 seconds) and closes immediately after the redirect.

Credentials are encrypted locally with XChaCha20-Poly1305 before upload — plaintext never leaves the machine.

## Documentation

- [`docs/threat-model.md`](docs/threat-model.md) — NFR-1 security invariants, memory-zero strategy, network confinement, threat model non-goals.
- [`docs/vault-file-format.md`](docs/vault-file-format.md) — Versioned envelope spec, on-disk layout, partial-recovery semantics.

## Architectural boundaries

This codebase enforces five invariants:

1. **VS Code API boundary** — only `src/extension.ts` and `src/ui/**` import `vscode` at the top level. Pure-logic modules use `src/vscode-host.ts`. Enforced by ESLint (per-file exceptions: `src/archive/archive-view.ts`, `src/drive/auth.ts`).
2. **External network boundary** — only `src/drive/client.ts` makes outbound HTTP.
3. **File system boundary** — only `src/vault/io.ts` writes to `~/.vaultpilot/`; helpers `atomicWriteFile`, `renamePath`, `moveVaultEntry`, `removePath`, `makeDirectory` are the gates. Enforced by ESLint within `src/vault/`.
4. **Secret-material boundary** — `src/keychain/secret-storage.ts` is the sole writer to VS Code SecretStorage.
5. **Memory-zero boundary** — `src/vault/memory-zero.ts` is the sole authority on Buffer-zeroing.

## License

MIT. See [LICENSE](LICENSE).
