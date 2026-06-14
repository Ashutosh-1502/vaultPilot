import type { SecretStorageBackend } from './secret-storage';

/**
 * Headless / no-keychain fallback (FR-49).
 *
 * Story 1.7 — wraps a primary `SecretStorageBackend` (typically VS Code's
 * built-in SecretStorage). If the primary throws on any operation, the
 * wrapper degrades to an in-memory `Map` for the lifetime of the VS Code
 * session.
 *
 * The user re-enters the passphrase each session under fallback. A
 * non-blocking sidebar indicator (set via the `vaultpilot.keychainFallbackActive`
 * context key) tells the user why.
 *
 * On `clear()` (called from `deactivate()`), the in-memory cache is wiped
 * via `Map.clear()`. Note: JavaScript strings cannot be deterministically
 * zeroed (OQ-5); the residual is documented in docs/threat-model.md.
 */
export class FallbackSecretStorage implements SecretStorageBackend {
  private readonly memoryCache = new Map<string, string>();
  private fallbackActive_ = false;
  private readonly onFallbackActivated: (() => void) | undefined;

  constructor(
    private readonly primary: SecretStorageBackend,
    onFallbackActivated?: () => void,
  ) {
    this.onFallbackActivated = onFallbackActivated;
  }

  /**
   * True iff the primary keychain has thrown at least once in this session
   * and we've switched to in-memory storage.
   */
  isFallbackActive(): boolean {
    return this.fallbackActive_;
  }

  async get(key: string): Promise<string | undefined> {
    if (this.fallbackActive_) {
      return this.memoryCache.get(key);
    }
    try {
      return await this.primary.get(key);
    } catch {
      this.activateFallback();
      return this.memoryCache.get(key);
    }
  }

  async store(key: string, value: string): Promise<void> {
    if (this.fallbackActive_) {
      this.memoryCache.set(key, value);
      return;
    }
    try {
      await this.primary.store(key, value);
    } catch {
      this.activateFallback();
      this.memoryCache.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    if (this.fallbackActive_) {
      this.memoryCache.delete(key);
      return;
    }
    try {
      await this.primary.delete(key);
    } catch {
      this.activateFallback();
      this.memoryCache.delete(key);
    }
  }

  /**
   * Clear the in-memory cache. MUST be called on `deactivate()` so secrets
   * don't linger in process memory after extension shutdown.
   */
  clear(): void {
    this.memoryCache.clear();
  }

  private activateFallback(): void {
    if (!this.fallbackActive_) {
      this.fallbackActive_ = true;
      this.onFallbackActivated?.();
    }
  }
}
