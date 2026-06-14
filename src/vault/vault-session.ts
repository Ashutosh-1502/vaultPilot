import { Result } from '../result/result';
import { CryptoError } from '../result/errors';
import { zeroBuffer } from './memory-zero';
import { zeroCredentialFields, type Credential } from '../credentials/credential';
import type { FingerprintSource } from '../fingerprint/re-link';

/**
 * In-memory vault session.
 *
 * Story 1.8 (Chunk 4 refactor) — extends the original state to carry the salt
 * and project metadata needed for re-encrypts after CRUD operations. The salt
 * stays constant across re-encrypts for a given vault entry; only the nonce
 * changes per encrypt.
 *
 * NFR-1 invariants:
 *   - Cleartext lives ONLY in this object while unlocked.
 *   - `lock()` zeros the derived key Buffer and every Buffer-backed credential
 *     field before transitioning back to locked state.
 *   - `lock()` MUST be called from `deactivate()` so the cleartext lifetime
 *     ends at extension shutdown.
 */

export interface ProjectMetadata {
  readonly fingerprint: string;
  readonly fingerprintSource: FingerprintSource;
  readonly displayName: string;
  readonly gitRemoteUrl: string | null;
  readonly lastKnownPath: string;
}

type State =
  | { readonly locked: true }
  | {
      readonly locked: false;
      readonly fingerprint: string;
      readonly derivedKey: Buffer;
      readonly salt: Uint8Array;
      readonly created: string;
      readonly projectMeta: ProjectMetadata;
      readonly credentials: Credential[];
    };

/**
 * Per-fingerprint derived-key cache for archived vault entries.
 *
 * Each vault entry has its own salt → its own derived key. The active session
 * caches the CURRENT workspace's key in `state.derivedKey`. When the user
 * accesses an archived entry (different fingerprint), the extension prompts
 * for passphrase, re-derives the key for that entry's salt, and stores it
 * here. Keyed by fingerprint so subsequent accesses skip the prompt.
 *
 * Zeroed on `lock()` along with the primary derived key.
 */
type ArchivedKeyMap = Map<string, Buffer>;

/**
 * Minimal EventEmitter contract — `vscode.EventEmitter<T>` satisfies this.
 * We use `undefined` as the payload for "no data" events instead of `void`
 * (ESLint's `no-invalid-void-type` rule forbids `void` in type-arg positions).
 */
export interface SessionEventEmitter<T> {
  readonly event: (listener: (data: T) => void) => { dispose: () => void };
  fire(data: T): void;
  dispose(): void;
}

export interface UnlockInput {
  readonly fingerprint: string;
  readonly derivedKey: Buffer;
  readonly salt: Uint8Array;
  readonly created: string;
  readonly projectMeta: ProjectMetadata;
  readonly credentials: Credential[];
}

export class VaultSession {
  private state: State = { locked: true };
  private readonly archivedKeys: ArchivedKeyMap = new Map();

  constructor(
    private readonly onLockedEmitter: SessionEventEmitter<undefined>,
    private readonly onUnlockedEmitter: SessionEventEmitter<undefined>,
  ) {}

  get onVaultLocked(): SessionEventEmitter<undefined>['event'] {
    return this.onLockedEmitter.event;
  }

  get onVaultUnlocked(): SessionEventEmitter<undefined>['event'] {
    return this.onUnlockedEmitter.event;
  }

  isUnlocked(): boolean {
    return !this.state.locked;
  }

  /**
   * Transition to unlocked state. Takes OWNERSHIP of `derivedKey` — caller
   * must NOT zero or reuse it after this call. The session will zero it on
   * `lock()`.
   */
  unlock(input: UnlockInput): void {
    if (!this.state.locked) {
      this.lock();
    }
    this.state = {
      locked: false,
      fingerprint: input.fingerprint,
      derivedKey: input.derivedKey,
      salt: input.salt,
      created: input.created,
      projectMeta: input.projectMeta,
      credentials: input.credentials,
    };
    this.onUnlockedEmitter.fire(undefined);
  }

  lock(): void {
    // Zero every archived-entry key regardless of active state.
    for (const key of this.archivedKeys.values()) {
      zeroBuffer(key);
    }
    this.archivedKeys.clear();

    if (this.state.locked) {
      return;
    }
    zeroBuffer(this.state.derivedKey);
    for (const cred of this.state.credentials) {
      zeroCredentialFields(cred);
    }
    this.state = { locked: true };
    this.onLockedEmitter.fire(undefined);
  }

  /**
   * Cache a derived key for an archived vault entry. Takes OWNERSHIP of the
   * Buffer — callers must NOT zero or reuse it after this call.
   *
   * If a previous key existed for the same fingerprint, it is zeroed before
   * replacement.
   */
  cacheArchivedKey(fingerprint: string, derivedKey: Buffer): void {
    const existing = this.archivedKeys.get(fingerprint);
    if (existing !== undefined) {
      zeroBuffer(existing);
    }
    this.archivedKeys.set(fingerprint, derivedKey);
  }

  /**
   * Look up the cached derived key for an archived entry, or `null` if not
   * yet derived this session. Returned reference is borrowed — caller MUST
   * NOT zero it or hold it beyond the immediate operation.
   */
  borrowArchivedKey(fingerprint: string): Buffer | null {
    return this.archivedKeys.get(fingerprint) ?? null;
  }

  /** Fingerprints whose archived keys are currently cached this session. */
  cachedArchivedFingerprints(): readonly string[] {
    return Array.from(this.archivedKeys.keys());
  }

  /**
   * Forget the cached key for a specific archived entry. Used when the entry
   * is promoted back to active (the key becomes the primary derivedKey
   * instead) or permanently deleted.
   */
  forgetArchivedKey(fingerprint: string): void {
    const existing = this.archivedKeys.get(fingerprint);
    if (existing !== undefined) {
      zeroBuffer(existing);
      this.archivedKeys.delete(fingerprint);
    }
  }

  getCredentials(): Result<readonly Credential[], CryptoError> {
    if (this.state.locked) {
      return Result.err(CryptoError.wrongPassphrase());
    }
    return Result.ok(this.state.credentials);
  }

  getFingerprint(): string | null {
    return this.state.locked ? null : this.state.fingerprint;
  }

  getProjectMeta(): ProjectMetadata | null {
    return this.state.locked ? null : this.state.projectMeta;
  }

  getSalt(): Uint8Array | null {
    return this.state.locked ? null : this.state.salt;
  }

  getCreatedAt(): string | null {
    return this.state.locked ? null : this.state.created;
  }

  setCredentials(credentials: Credential[]): Result<void, CryptoError> {
    if (this.state.locked) {
      return Result.err(CryptoError.wrongPassphrase());
    }
    this.state = { ...this.state, credentials };
    return Result.ok(undefined);
  }

  updateProjectMeta(projectMeta: ProjectMetadata): Result<void, CryptoError> {
    if (this.state.locked) {
      return Result.err(CryptoError.wrongPassphrase());
    }
    this.state = { ...this.state, projectMeta };
    return Result.ok(undefined);
  }

  /**
   * Internal accessor for the derived key — used by persist/encrypt callers.
   * Callers MUST NOT zero the Buffer or hold the reference beyond the
   * encrypt/decrypt operation. Returns `null` when locked.
   */
  borrowDerivedKey(): Buffer | null {
    return this.state.locked ? null : this.state.derivedKey;
  }
}
