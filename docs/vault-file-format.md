# VaultPilot Vault File Format

This document specifies the on-disk layout of the VaultPilot vault and the versioned envelope format. It is the canonical reference for **FR-5 (versioning + future-version refusal)** and **OQ-8 (atomic-write partial-recovery semantics)**.

Cross-references: [PRD](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/prd.md), [PRD addendum](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/addendum.md), [Architecture](../../_bmad-output/planning-artifacts/architecture.md), [Threat model](./threat-model.md).

## Vault root layout

```
~/.vaultpilot/
├── config.json                    # Global settings (unencrypted; no secrets)
├── projects/
│   └── <fingerprint>/
│       ├── meta.json              # Unencrypted project metadata
│       └── keys.enc               # Encrypted credentials envelope
└── archive/
    └── <fingerprint>/
        ├── meta.json
        └── keys.enc
```

The vault root resolves to `path.join(os.homedir(), '.vaultpilot')`. It works identically on macOS, Windows, and Linux (NFR-3); the root is determined by the OS's home-directory convention.

The extension **never** reads or writes credential files inside any project directory (FR-1). All credential state lives under `~/.vaultpilot/`.

## File: `config.json`

Global VaultPilot settings, unencrypted, no secrets:

```json
{
  "version": 1,
  "clipboardTimeout": 30,
  "passphraseCacheDuration": 3600,
  "driveBackupFolderName": "vaultpilot-backup"
}
```

Note: OAuth tokens are **not** stored in `config.json`. They live in VS Code SecretStorage (see [Threat model](./threat-model.md#on-disk-secret-material)).

## File: `meta.json` (unencrypted)

Per-project metadata, sibling to `keys.enc`. Contains **no credentials, no secrets**.

```json
{
  "version": 1,
  "fingerprint": "abc1234567890def",
  "fingerprintSource": "git-remote",
  "displayName": "valtPilot",
  "gitRemoteUrl": "github.com/ashutosh/valtpilot",
  "lastKnownPath": "/Users/.../valtPilot",
  "tentativeMissAt": null
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `version` | integer | Format version of this `meta.json`. Currently `1`. |
| `fingerprint` | string | First 16 hex chars of SHA-256 over the canonical anchor (FR-14). Matches the directory name. |
| `fingerprintSource` | enum | One of `git-remote`, `manifest-name`, `absolute-path`. Records which anchor was used (FR-19). |
| `displayName` | string | Human-readable project name (for the sidebar label). |
| `gitRemoteUrl` | string \| null | The canonical remote URL (normalized) when `fingerprintSource = git-remote`. |
| `lastKnownPath` | string | Absolute path of the last workspace folder that opened this vault entry (FR-15). |
| `tentativeMissAt` | ISO timestamp \| null | Set when the first-miss archive scan detects an unreachable path (FR-28, Story 2.1). Cleared when the path becomes reachable again. Drives the two-activation-miss archive gate. |

## File: `keys.enc` (encrypted envelope)

The credentials payload, encrypted with XChaCha20-Poly1305. Versioned for future format evolution.

### Envelope layout

```
+-------------------------------------------+
| header (plaintext JSON, single line)      |
|   { "version": N, "salt": "...",          |
|     "nonce": "..." }                      |
+-------------------------------------------+
| '\n' (single newline delimiter)           |
+-------------------------------------------+
| ciphertext (base64-encoded)               |
|   XChaCha20-Poly1305 over the inner JSON  |
+-------------------------------------------+
```

The header is **plaintext JSON** so the version can be read without attempting decrypt (satisfies FR-5's future-version refusal — see below).

### Header fields

| Field | Type | Description |
|---|---|---|
| `version` | integer | Vault format version. Currently `1`. |
| `salt` | base64 string | argon2id salt (16 bytes). Per-vault-entry; generated at vault initialization via `sodium.randombytes_buf`. |
| `nonce` | base64 string | XChaCha20-Poly1305 nonce (24 bytes). Regenerated on every re-encrypt. |

### Inner JSON (encrypted payload)

```json
{
  "version": 1,
  "created": "2026-06-09T12:34:56Z",
  "updated": "2026-06-09T12:34:56Z",
  "project": {
    "fingerprint": "abc1234567890def",
    "fingerprintSource": "git-remote",
    "displayName": "valtPilot",
    "gitRemoteUrl": "github.com/ashutosh/valtpilot",
    "lastKnownPath": "/Users/.../valtPilot"
  },
  "credentials": [
    {
      "id": "uuid",
      "name": "production AWS",
      "type": "user/password-pair",
      "notes": "Account 1234567890, IAM user ci-deploy",
      "fields": {
        "fieldA": { "label": "access_key_id", "value": "AKIA..." },
        "fieldB": { "label": "secret_access_key", "value": "..." }
      },
      "created": "2026-06-09T12:34:56Z",
      "updated": "2026-06-09T12:34:56Z"
    }
  ]
}
```

The `project` block inside the encrypted payload **mirrors** the unencrypted `meta.json` `project` block — this lets the loader verify on decrypt that the meta and the cipher agree.

### Credential `type` values (FR-20, PRD addendum)

| `type` | Field shape |
|---|---|
| `string` | `value` (single string) |
| `api-key` | `value` (single string, displayed masked) |
| `token` | `value` (multi-line string, displayed masked) |
| `user/password-pair` | `fields.fieldA = { label, value }`, `fields.fieldB = { label, value }` |
| `json-blob` | `value` (string containing parseable JSON) |
| `env-var-name` | `name` is the env-var name (e.g., `DATABASE_URL`), `value` is the value |

## Version detection without decrypt (FR-5)

The plaintext header is the **first line** of the file, terminated by `\n`. The loader reads only up to the first newline to extract the header JSON, then calls `checkSupported(version)` from `src/vault/format-version.ts`:

- `version > CURRENT_VERSION` (currently `1`): `Result.err(VaultFormatError.versionUnsupported(version))`. The user is prompted to upgrade the extension; **the file is not decrypted**.
- `version >= 1 && version <= CURRENT_VERSION`: ok. The loader proceeds to decrypt and may prompt the user to confirm a re-save if a migration is needed (always non-silent per FR-5).

## Atomic write partial-recovery semantics (OQ-8)

On every save, `atomicWriteFile(path, bytes)` in `src/vault/io.ts` performs:

1. Write to `<path>.tmp`
2. `fsync(<path>.tmp)`
3. `rename(<path>.tmp, <path>)`
4. `fsync(parent directory)`

A crash can leave the disk in one of these states. The loader handles each:

| State on disk | Loader behavior |
|---|---|
| `keys.enc` intact, no `.tmp` sibling | Use `keys.enc`. Normal case. |
| `keys.enc` intact, `keys.enc.tmp` sibling present | **Ignore the `.tmp`.** Crash happened before rename; the intact file is the prior good state. |
| `keys.enc` zero-byte or fails auth tag, `keys.enc.tmp` present | **Attempt recovery from `.tmp`.** If `.tmp` decrypts successfully, prompt the user to confirm the recovered state before promoting `.tmp` to `keys.enc`. |
| `keys.enc` zero-byte or fails auth tag, no `.tmp` | `Result.err(VaultFormatError.corrupted)`. The user sees a clear actionable message. |
| Neither `keys.enc` nor `.tmp` present | Treated as "no vault entry for this fingerprint" — FR-9 prompt fires. |

The same semantics apply to `meta.json` independently. Because `meta.json` is unencrypted, "fails auth tag" is replaced with "fails JSON parse."

## Cross-platform considerations (NFR-3)

- Path separators: use `path.join` exclusively. The vault root (`~/.vaultpilot`) resolves via `os.homedir()` which gives the correct platform-specific value.
- `fs.rename` is atomic on POSIX (macOS, Linux). On Windows, the `MOVEFILE_REPLACE_EXISTING` flag (implicit in `fs.rename` since Node 14+) provides equivalent atomicity. No platform-specific code needed.
- `fsync` on the parent directory is a no-op on Windows (Windows doesn't expose directory fsync); on macOS/Linux it ensures the rename is durable. The atomic-write helper tolerates the no-op transparently.

## References

- [PRD §F1. Vault Storage & Encryption](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/prd.md) — FR-1 to FR-6 source
- [PRD §Vault File Format](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/prd.md) — on-disk layout authority
- [PRD addendum §Vault file format draft schema](../../_bmad-output/planning-artifacts/prds/prd-valtPilot-2026-06-09/addendum.md) — inner JSON shape source
- [Architecture §Cryptography & Vault Format](../../_bmad-output/planning-artifacts/architecture.md) — XChaCha20-Poly1305 + argon2id INTERACTIVE preset
- [Threat model](./threat-model.md)
