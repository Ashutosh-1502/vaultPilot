import { Result } from '../result/result';
import { KeychainError } from '../result/errors';
import { SECRET_STORAGE } from '../settings/state-keys';

/**
 * SecretStorage wrapper — the SINGLE writer to VS Code SecretStorage.
 *
 * Story 1.7 — implements FR-4 (derived key cache) and the contract for FR-33
 * (Drive OAuth refresh token, consumed by Epic 3). The actual VS Code
 * `SecretStorage` instance is injected as a backend (`SecretStorageBackend`)
 * to keep the wrapper unit-testable without mocking the global `vscode`
 * namespace.
 *
 * Architectural boundary: this is the SOLE module that calls
 * `context.secrets.store` / `.get` / `.delete`. Enforced by code review.
 */

/**
 * Minimal contract a SecretStorage backend must satisfy. The real VS Code
 * `vscode.SecretStorage` instance satisfies this; tests inject a fake.
 *
 * Uses `PromiseLike` (== VS Code's `Thenable`) rather than `Promise` so VS
 * Code's API surface satisfies it directly without adaptation.
 */
export interface SecretStorageBackend {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export class SecretStorageWrapper {
  constructor(private readonly backend: SecretStorageBackend) {}

  // --- Derived key cache (FR-4) ---

  async cacheDerivedKey(key: Buffer): Promise<Result<void, KeychainError>> {
    try {
      await this.backend.store(SECRET_STORAGE.DERIVED_KEY, key.toString('base64'));
      return Result.ok(undefined);
    } catch {
      return Result.err(KeychainError.writeFailed());
    }
  }

  async getCachedDerivedKey(): Promise<Result<Buffer | null, KeychainError>> {
    try {
      const value = await this.backend.get(SECRET_STORAGE.DERIVED_KEY);
      if (value === undefined) {
        return Result.ok(null);
      }
      return Result.ok(Buffer.from(value, 'base64'));
    } catch {
      return Result.err(KeychainError.unavailable());
    }
  }

  async clearDerivedKey(): Promise<void> {
    try {
      await this.backend.delete(SECRET_STORAGE.DERIVED_KEY);
    } catch {
      // best-effort; the cleared-key state should not block other flows.
    }
  }

  // --- Drive OAuth refresh token (FR-33 contract; Epic 3 consumer) ---

  async setDriveRefreshToken(token: string): Promise<Result<void, KeychainError>> {
    try {
      await this.backend.store(SECRET_STORAGE.DRIVE_REFRESH_TOKEN, token);
      return Result.ok(undefined);
    } catch {
      return Result.err(KeychainError.writeFailed());
    }
  }

  async getDriveRefreshToken(): Promise<Result<string | null, KeychainError>> {
    try {
      const value = await this.backend.get(SECRET_STORAGE.DRIVE_REFRESH_TOKEN);
      return Result.ok(value ?? null);
    } catch {
      return Result.err(KeychainError.unavailable());
    }
  }

  async clearDriveRefreshToken(): Promise<void> {
    try {
      await this.backend.delete(SECRET_STORAGE.DRIVE_REFRESH_TOKEN);
    } catch {
      // best-effort
    }
  }
}
