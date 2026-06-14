# VaultPilot Threat Model

This document locks the security invariants the rest of the codebase depends on. It is the canonical reference for **NFR-1 (Security boundaries)** in the PRD, and it drafts ahead of any production crypto or vault module per the architecture's "first implementation story" directive.

Cross-references: [PRD](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/prd.md), [Architecture](../../_bmad-output/planning-artifacts/architecture.md), [Vault file format](./vault-file-format.md).

## Scope and stakes

VaultPilot is a **personal-tool-first** product. The threat model is calibrated accordingly:

- The expected adversary is **someone with read access to the user's home directory after the user has walked away** (laptop left unlocked briefly, backup of `~/.vaultpilot/` exfiltrated, cloud sync mishap).
- The product **does not** defend against an attacker with the passphrase, kernel-level access, hardware keyloggers, or a compromised VS Code installation.
- See [PRD Goals](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/prd.md#goals) and the brief's Vision section for context.

If the audience widens beyond personal-tool stakes, this threat model should be re-examined before that scope shift.

## Confidentiality invariants

### Cleartext lifetime

Cleartext credential values exist on the system in only three places, each for a bounded duration:

1. **Transient process memory** — Decrypted credentials live in the `VaultSession` singleton (Story 1.8) while the vault is unlocked. Zeroed on extension deactivate via `Buffer.fill(0)` (`src/vault/memory-zero.ts`, Story 1.4).
2. **System clipboard** — When the user copies a credential value, the clipboard holds it for the duration of `vaultpilot.clipboardTimeout` (default 30 seconds, FR-26). The auto-clear is change-detection-aware (Story 1.12): if the user copied something else in the interim, VaultPilot's clear is skipped to avoid overwriting unrelated content.
3. **In-flight edit buffers** — While an Add/Edit credential modal is open, a partial value is held in memory. On extension deactivate or crash, these buffers are discarded and zeroed; they are **never** silently persisted (NFR-1, Story 1.8 / Story 1.11).

### Memory-zero strategy and residual risk

- **`Buffer`-backed cleartext** (passphrases, derived keys, raw credential bytes) is zeroed via `Buffer.fill(0)` (`src/vault/memory-zero.ts`) before references are released.
- **`String`-backed cleartext** (intermediate strings between `showInputBox` returning a result and conversion to `Buffer`) **cannot be deterministically zeroed** in Node.js. JavaScript strings are immutable and garbage-collected at the engine's discretion. This is a known residual risk (PRD OQ-5, resolved in architecture).
  - **Mitigation:** minimize the string-state window. Convert `showInputBox` returns to `Buffer` immediately at the call site (`src/vault/passphrase-normalize.ts` in Story 1.4). Discard string references promptly.
- The accepted residual is documented here per OQ-5's resolution.

### Encryption at rest (FR-2)

- All credential payloads are encrypted with **XChaCha20-Poly1305** (`libsodium-wrappers-sumo` `crypto_aead_xchacha20poly1305_ietf_*`).
- The encryption key is derived from the user's passphrase via **argon2id** (`crypto_pwhash_*`), parameters `OPSLIMIT_INTERACTIVE` + `MEMLIMIT_INTERACTIVE`. Targets ~1 second cold-open on consumer hardware (NFR-2).
- The passphrase is **the root of trust**. Loss of the passphrase = loss of the vault (FR-3). There is no recovery mechanism, no escape hatch, no email-the-author flow. This is surfaced to the user at first-run.
- Architecture-approved deviation from the brief: original brief `[ASSUMPTION]` of AES-256-GCM is **superseded** by XChaCha20-Poly1305 (libsodium's preferred AEAD; 192-bit nonce eliminates random-nonce-collision risk).

### Wrong-passphrase policy (FR-48)

- No retry limit or lockout. KDF cost (~1 second per attempt) is the only friction.
- Rationale: an attacker who has `keys.enc` already has the file; rate-limiting in the extension does not change the threat model. Documented as a known limit; revisit if multi-user adoption grows before Marketplace.

## Integrity invariants

### Atomic vault writes (FR-6)

All writes to vault files (`keys.enc`, `meta.json`) route through `atomicWriteFile(path, bytes)` in `src/vault/io.ts` (Story 1.5). Implementation:

1. Write to `<path>.tmp`
2. `fsync(<path>.tmp)`
3. `rename(<path>.tmp, <path>)`
4. `fsync(parent directory)`

A crash between any two steps leaves the vault in a recoverable state. Recovery semantics on next open are documented in [`vault-file-format.md`](./vault-file-format.md) per OQ-8.

### Multi-window state (FR-12)

When two VS Code windows have the same workspace open (rare in practice — each window typically targets a different workspace), simultaneous writes to the same `keys.enc` are **last-write-wins**. No file locking is implemented in MVP.

- **Accepted limit.** The race window is narrow and the consequence is the loss of one edit, not corruption.
- The atomic-write guarantee (FR-6) prevents partial-write corruption; the multi-window concern is purely about which writer "wins."

## Network confinement

### Outbound traffic

The extension makes outbound HTTP requests **only** to Google Drive API endpoints (`*.googleapis.com`), and **only** when `vaultpilot.driveBackupEnabled` is `true` (FR-32).

- When the setting is `false` (default), **no Drive code path executes** (Story 3.1).
- All Drive HTTP calls go through `src/drive/client.ts` (Epic 3). A unit test enforces that no other host is ever requested.

### No telemetry (NFR-4)

- No analytics library is admitted to `package.json` dependencies (Story 1.1 AC).
- No usage data is sent anywhere. No phone-home of any kind.
- The OutputChannel logger (`src/logging/output-channel.ts`) is the only logging surface. It is **never persisted to disk** and exposes no API surface that accepts secrets (compile-time enforcement: the `Logger` interface methods take only `string` arguments).
- Crash reporting (if ever added) MUST NOT include user data — paths, key names, passphrase fragments, or credential values. Requires re-briefing before adoption.

## On-disk secret material

Security-sensitive material exists on disk in exactly these locations, each with a defined purpose:

| Location | Contents | Story |
|---|---|---|
| `~/.vaultpilot/projects/<fp>/keys.enc` | Encrypted credentials payload (XChaCha20-Poly1305) | 1.5 |
| `~/.vaultpilot/archive/<fp>/keys.enc` | Encrypted credentials payload, archived | 2.1 |
| VS Code SecretStorage: `vaultpilot.derivedKey` | Cached derived encryption key | 1.7 |
| VS Code SecretStorage: `vaultpilot.driveRefreshToken` | Google OAuth refresh token | 1.7 (contract), 3.1 (consumer) |

No other on-disk location holds anything sensitive. `meta.json` and `config.json` are **unencrypted** but contain **no credentials, no secrets** — only project names, normalized remote URLs, fingerprint sources, and last-known paths.

## In-flight discard on extension shutdown

When VS Code unloads the extension (uninstall, disable, crash, window close), the `deactivate()` lifecycle hook in `src/extension.ts`:

1. Calls `VaultSession.lock()` (Story 1.8).
2. `lock()` invokes `zeroBuffer(derivedKey)` and zeros every credential value buffer in the in-memory cache.
3. Any open Add/Edit credential modal's in-flight buffer is discarded and zeroed — **never** persisted (Story 1.8 / Story 1.11 AC).

The user MUST be able to walk away from a half-typed secret and return to find it has not been silently saved.

## Threat model non-goals

The following are explicit non-goals. Attempting to defend against any of them is out of scope for MVP.

### OS-level clipboard managers (FR-26 NOTE FOR PM)

Maccy, Paste, Windows clipboard history, Alfred, and similar tools capture clipboard contents at copy time and persist them beyond VaultPilot's 30-second auto-clear. **VaultPilot does not defeat these tools.** This is documented in the first-run experience (README) so the user can make an informed choice.

### Audit logging

VaultPilot does not record which credentials were viewed, copied, edited, or deleted. The threat model does not include "did somebody else use my credentials on my machine?" as a question we can answer.

### Key-expiry tracking

Per-credential expiry timestamps and alerts are out of scope. A meaningful alert pipeline needs a notification surface VaultPilot has chosen not to commit to in MVP.

### Attacker with the passphrase

If an attacker has the passphrase, they have the vault. End of story. VaultPilot's security model assumes the passphrase is held by the legitimate user.

### Compromised VS Code installation

If the VS Code installation itself is compromised (malicious extensions, modified binary, OS-level keylogger), VaultPilot offers no defense. The threat surface is the VS Code extension runtime; defending the runtime is out of scope.

### Hardware-level threats

Cold-boot attacks, DMA attacks, evil-maid attacks — out of scope.

## References

- [PRD §Cross-cutting NFRs](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/prd.md) — NFR-1 source
- [PRD Open Questions](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/prd.md) — OQ-5 (memory-zero feasibility), OQ-8 (atomic-write recovery)
- [Architecture §Security & Cryptography](../../_bmad-output/planning-artifacts/architecture.md)
- [Vault file format](./vault-file-format.md)
