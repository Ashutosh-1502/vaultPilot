# Changelog

All notable changes to the VaultPilot extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Epic 1 (Local Vault & Credential Management)

- **Scaffold + tooling** (Story 1.1): TypeScript + esbuild + ESLint flat config + Prettier + CI workflow + F5 debug.
- **Architecture docs** (Story 1.2): `docs/threat-model.md` + `docs/vault-file-format.md`.
- **Foundational patterns** (Story 1.3): `Result<T, VaultError>`, error taxonomy, OutputChannel logger, VS Code host wrapper, `errorToUserMessage` dispatcher.
- **Cryptography core** (Story 1.4): `libsodium-wrappers-sumo` (sumo build required for argon2id) + XChaCha20-Poly1305 AEAD, vault envelope serializer, format-version check, memory-zero helpers, NFC passphrase normalization.
- **Vault file I/O** (Story 1.5): `atomicWriteFile` (write→fsync→rename→fsync-parent) + OQ-8 partial-recovery semantics.
- **Project fingerprint** (Story 1.6): URL canonicalization (SSH↔HTTPS, FR-45), SHA-256 fingerprint, strict priority chain (git remote → manifest → path).
- **OS keychain + headless fallback** (Story 1.7): VS Code SecretStorage wrapper + lazy in-memory fallback for FR-49.
- **VaultSession** (Story 1.8): in-memory singleton with deactivate cleanup (NFR-1).
- **First-run UX** (Story 1.9): welcome state, "Set Up New Vault" with passphrase × 2 + strength meter + Drive opt-in chooser.
- **Active TreeView + auto-unlock** (Story 1.10): credential renderer, auto-unlock on activation when cached key present, re-prompt flow on cache miss.
- **Add credential** (Story 1.11): adaptive per-type prompts for all 6 PRD types (`string`, `api-key`, `token`, `user/password-pair`, `json-blob`, `env-var-name`).
- **Reveal + Copy** (Story 1.12): per-action reveal via modal dialog; single-click copy with 30s auto-clear and change-detection.
- **Edit + Delete** (Story 1.13): full-replace edit (no version history); delete with explicit modal confirmation.

### Added — Epic 2 (Project Archive)

- **Tentative-miss detection + archive move** (Story 2.1, FR-28): background scan at activation; two-activation gate (first miss flags `tentativeMissAt`, second miss moves to `archive/`); currently-open guard skips archiving the workspace's own vault entry. Reachable-again clears the flag.
- **Archived Vaults TreeView** (Story 2.2, FR-29, FR-30 view+copy half): second TreeDataProvider; project list from unencrypted `meta.json`; per-fingerprint key cache supports cross-salt decryption when expanding archived entries; "click to unlock" placeholder when key isn't yet cached; read-only context menu (Copy + Reveal only — no Edit/Delete).
- **Promote archived entry to active** (Story 2.3, FR-30 promote half): auto-promote at workspace open when fingerprint matches an archived entry; manual promote via TreeView context menu; defensive guard refuses promote if both active and archived directories exist.
- **Permanent delete of archived entry** (Story 2.4, FR-31): type-the-display-name confirmation (case-sensitive); recursive directory removal via `removeVaultDirectory`; per-fingerprint key cache cleared on delete.
- **New io helpers** (extracted in `src/vault/io.ts` to keep the filesystem boundary): `moveVaultEntry`, `removeVaultDirectory`, `listVaultEntries`.

### Added — Epic 3 (Drive Backup & Restore)

- **OAuth 2.0 with PKCE** (Story 3.1, FR-33): pure-fetch implementation (no `google-auth-library` dep). `src/drive/pkce.ts` (code_verifier, code_challenge, state per RFC 7636), `src/drive/oauth.ts` (authorize URL builder, token exchange, refresh), `src/drive/auth.ts` (orchestrator with system-browser handoff + `vscode://` URI handler + pending-promise pattern).
- **Drive REST client** (Story 3.1, FR-33): `src/drive/client.ts` with single-retry silent refresh on 401, 403→quota-exceeded, 5xx→network-failed status mapping. Sole module that makes outbound HTTP per the architecture's external-network boundary.
- **Backup with atomicity** (Story 3.2, FR-34, FR-35, FR-38, FR-50): `src/drive/backup.ts` — `tar`-package archive of `~/.vaultpilot/`, MD5-verified upload to `<canonicalName>.uploading`, atomic PATCH-rename to canonical name, best-effort delete of prior canonical(s) — stale `.uploading` from prior failed runs tolerated and overwritten.
- **Restore with chooser + trash safety** (Story 3.3, FR-36, FR-37, FR-39, FR-42): `src/drive/restore.ts` — two-phase `prepareRestore` (download + extract to `.restore-staging-<ts>/`) and `applyRestoreDecision` (Overwrite / Keep Local / Cancel). On Overwrite, existing `projects/` + `archive/` move to `.trash-<ts>/` first; failure mid-restore triggers rollback to restore the prior state. FR-38 defense-in-depth path-traversal check on extracted entries.
- **First-run welcome's "Restore from Drive" wired** (FR-42): replaces the Story 1.9 stub; clicking now runs the real `restoreFromDriveCommand`.
- **New settings**: `vaultpilot.driveOAuthClientId` — user-supplied OAuth client ID (PKCE-based, no client_secret needed). Empty until configured; Drive features unavailable until set.
- **New io helpers** (in `src/vault/io.ts`): `renamePath`, `readDirectoryEntries`, `removePath`, `makeDirectory` — routing restore's filesystem orchestration through the file-system boundary.
- **`tar` runtime dependency** added (`tar@^7.x`) for archive packaging.

### Notes

- **OAuth client ID setup required.** Drive features will not work until the user registers a Google OAuth 2.0 client at https://console.cloud.google.com/ (Application type: Desktop, with redirect URI `vscode://ashutoshsuryavanshi.vaultpilot/oauth-callback`) and sets `vaultpilot.driveOAuthClientId` in VS Code settings.
- Per-fingerprint key cache in `VaultSession` holds derived keys for archived entries the user has opened this session. All zeroed on `lock()` / deactivate.
- Publisher in `package.json` is `ashutoshsuryavanshi` — register at https://marketplace.visualstudio.com/manage before `vsce publish`.
- All FR-10 commands now have real handlers wired.
