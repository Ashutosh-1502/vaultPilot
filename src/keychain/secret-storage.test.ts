import * as assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'mocha';

import { SecretStorageWrapper, type SecretStorageBackend } from './secret-storage';
import { SECRET_STORAGE } from '../settings/state-keys';
import { Result } from '../result/result';

class InMemoryBackend implements SecretStorageBackend {
  private readonly store_ = new Map<string, string>();
  shouldThrowOnGet = false;
  shouldThrowOnStore = false;
  shouldThrowOnDelete = false;

  async get(key: string): Promise<string | undefined> {
    if (this.shouldThrowOnGet) throw new Error('keychain unavailable');
    return this.store_.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    if (this.shouldThrowOnStore) throw new Error('keychain write failed');
    this.store_.set(key, value);
  }
  async delete(key: string): Promise<void> {
    if (this.shouldThrowOnDelete) throw new Error('keychain delete failed');
    this.store_.delete(key);
  }
}

describe('SecretStorageWrapper', () => {
  let backend: InMemoryBackend;
  let wrapper: SecretStorageWrapper;

  beforeEach(() => {
    backend = new InMemoryBackend();
    wrapper = new SecretStorageWrapper(backend);
  });

  describe('derived key', () => {
    it('cacheDerivedKey + getCachedDerivedKey round-trip preserves bytes', async () => {
      const key = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
      const cacheResult = await wrapper.cacheDerivedKey(key);
      assert.equal(cacheResult.ok, true);
      const getResult = await wrapper.getCachedDerivedKey();
      assert.equal(getResult.ok, true);
      if (Result.isOk(getResult) && getResult.value !== null) {
        assert.deepEqual(Array.from(getResult.value), Array.from(key));
      }
    });

    it('getCachedDerivedKey returns null when not yet cached', async () => {
      const r = await wrapper.getCachedDerivedKey();
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value, null);
      }
    });

    it('cacheDerivedKey returns write-failed on backend throw', async () => {
      backend.shouldThrowOnStore = true;
      const r = await wrapper.cacheDerivedKey(Buffer.from([1]));
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'keychain.write-failed');
      }
    });

    it('getCachedDerivedKey returns unavailable on backend throw', async () => {
      backend.shouldThrowOnGet = true;
      const r = await wrapper.getCachedDerivedKey();
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'keychain.unavailable');
      }
    });

    it('clearDerivedKey is best-effort (swallows backend throw)', async () => {
      backend.shouldThrowOnDelete = true;
      // Should not throw
      await wrapper.clearDerivedKey();
    });

    it('uses the canonical SecretStorage key name from state-keys.ts', async () => {
      await wrapper.cacheDerivedKey(Buffer.from([9]));
      const direct = await backend.get(SECRET_STORAGE.DERIVED_KEY);
      assert.notEqual(direct, undefined);
    });
  });

  describe('Drive refresh token', () => {
    it('set + get round-trip preserves string', async () => {
      const token = '1//0gFakeRefreshTokenExampleString';
      const setResult = await wrapper.setDriveRefreshToken(token);
      assert.equal(setResult.ok, true);
      const getResult = await wrapper.getDriveRefreshToken();
      assert.equal(getResult.ok, true);
      if (Result.isOk(getResult)) {
        assert.equal(getResult.value, token);
      }
    });

    it('get returns null when not yet set', async () => {
      const r = await wrapper.getDriveRefreshToken();
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value, null);
      }
    });

    it('clear removes the token', async () => {
      await wrapper.setDriveRefreshToken('t');
      await wrapper.clearDriveRefreshToken();
      const r = await wrapper.getDriveRefreshToken();
      if (Result.isOk(r)) {
        assert.equal(r.value, null);
      }
    });
  });
});
