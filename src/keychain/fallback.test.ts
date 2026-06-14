import * as assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'mocha';

import { FallbackSecretStorage } from './fallback';
import type { SecretStorageBackend } from './secret-storage';

class FlakyBackend implements SecretStorageBackend {
  shouldThrow = false;
  private readonly storage = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    if (this.shouldThrow) throw new Error('keychain unavailable');
    return this.storage.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    if (this.shouldThrow) throw new Error('keychain unavailable');
    this.storage.set(key, value);
  }
  async delete(key: string): Promise<void> {
    if (this.shouldThrow) throw new Error('keychain unavailable');
    this.storage.delete(key);
  }
}

describe('FallbackSecretStorage', () => {
  let primary: FlakyBackend;
  let fallback: FallbackSecretStorage;

  beforeEach(() => {
    primary = new FlakyBackend();
    fallback = new FallbackSecretStorage(primary);
  });

  it('delegates to primary when primary is healthy', async () => {
    await fallback.store('k', 'v');
    const got = await fallback.get('k');
    assert.equal(got, 'v');
    assert.equal(fallback.isFallbackActive(), false);
  });

  it('activates fallback on first primary throw', async () => {
    primary.shouldThrow = true;
    await fallback.store('k', 'v');
    assert.equal(fallback.isFallbackActive(), true);
    primary.shouldThrow = false;
    // Subsequent ops still use in-memory cache (don't auto-recover within a session)
    const got = await fallback.get('k');
    assert.equal(got, 'v');
  });

  it('subsequent ops after fallback activation skip the primary', async () => {
    primary.shouldThrow = true;
    await fallback.store('k', 'v'); // activates fallback
    primary.shouldThrow = false;
    // Primary was not touched on the next store; verify by reading primary directly
    await fallback.store('k2', 'v2');
    const primaryDirect = await primary.get('k2');
    assert.equal(primaryDirect, undefined);
  });

  it('onFallbackActivated callback fires exactly once', async () => {
    let activations = 0;
    const fb = new FallbackSecretStorage(primary, () => activations++);
    primary.shouldThrow = true;
    await fb.store('a', '1');
    await fb.get('a');
    await fb.delete('a');
    assert.equal(activations, 1);
  });

  it('clear() wipes the in-memory cache', async () => {
    primary.shouldThrow = true;
    await fallback.store('k', 'v');
    fallback.clear();
    const got = await fallback.get('k');
    assert.equal(got, undefined);
  });

  it('get/store/delete all behave in fallback mode', async () => {
    primary.shouldThrow = true;
    await fallback.store('k1', 'v1');
    await fallback.store('k2', 'v2');
    assert.equal(await fallback.get('k1'), 'v1');
    await fallback.delete('k1');
    assert.equal(await fallback.get('k1'), undefined);
    assert.equal(await fallback.get('k2'), 'v2');
  });
});
