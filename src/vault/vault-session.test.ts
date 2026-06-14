import * as assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'mocha';

import { VaultSession, type SessionEventEmitter, type UnlockInput } from './vault-session';
import type { Credential } from '../credentials/credential';

function makeEmitter<T>(): SessionEventEmitter<T> & { fireCount: number } {
  let count = 0;
  const listeners: ((data: T) => void)[] = [];
  const emitter = {
    fireCount: 0,
    event: (listener: (data: T) => void) => {
      listeners.push(listener);
      return {
        dispose: () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
    fire: (data: T) => {
      count++;
      emitter.fireCount = count;
      for (const l of listeners) l(data);
    },
    dispose: () => {
      listeners.length = 0;
    },
  };
  return emitter;
}

function makeCredential(id: string): Credential {
  return {
    id,
    name: `cred-${id}`,
    type: 'string',
    value: 'secret-value',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  };
}

function makeUnlockInput(overrides: Partial<UnlockInput> = {}): UnlockInput {
  return {
    fingerprint: 'fp-abc',
    derivedKey: Buffer.from([1, 2, 3, 4, 5]),
    salt: new Uint8Array(16).fill(0x11),
    created: '2026-06-01T00:00:00Z',
    projectMeta: {
      fingerprint: 'fp-abc',
      fingerprintSource: 'git-remote',
      displayName: 'test',
      gitRemoteUrl: 'github.com/test/test',
      lastKnownPath: '/tmp/test',
    },
    credentials: [makeCredential('a')],
    ...overrides,
  };
}

describe('VaultSession', () => {
  let lockedEm: ReturnType<typeof makeEmitter<undefined>>;
  let unlockedEm: ReturnType<typeof makeEmitter<undefined>>;
  let session: VaultSession;

  beforeEach(() => {
    lockedEm = makeEmitter<undefined>();
    unlockedEm = makeEmitter<undefined>();
    session = new VaultSession(lockedEm, unlockedEm);
  });

  it('starts locked', () => {
    assert.equal(session.isUnlocked(), false);
    assert.equal(session.getFingerprint(), null);
    assert.equal(session.getProjectMeta(), null);
    assert.equal(session.getSalt(), null);
    assert.equal(session.getCreatedAt(), null);
  });

  it('getCredentials returns wrong-passphrase when locked', () => {
    const r = session.getCredentials();
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'crypto.wrong-passphrase');
    }
  });

  it('unlock populates all session state and fires onUnlocked', () => {
    const input = makeUnlockInput();
    session.unlock(input);
    assert.equal(session.isUnlocked(), true);
    assert.equal(session.getFingerprint(), 'fp-abc');
    assert.equal(session.getCreatedAt(), '2026-06-01T00:00:00Z');
    assert.equal(unlockedEm.fireCount, 1);
    const salt = session.getSalt();
    assert.notEqual(salt, null);
    if (salt !== null) {
      assert.equal(salt.length, 16);
    }
  });

  it('lock zeros the derived key and fires onLocked', () => {
    const key = Buffer.from([9, 9, 9, 9]);
    session.unlock(makeUnlockInput({ derivedKey: key }));
    session.lock();
    assert.equal(session.isUnlocked(), false);
    assert.deepEqual(Array.from(key), [0, 0, 0, 0]);
    assert.equal(lockedEm.fireCount, 1);
  });

  it('lock is idempotent (no event on already-locked session)', () => {
    session.lock();
    assert.equal(lockedEm.fireCount, 0);
  });

  it('unlock while already unlocked locks first', () => {
    const key1 = Buffer.from([1, 2, 3]);
    const key2 = Buffer.from([4, 5, 6]);
    session.unlock(makeUnlockInput({ derivedKey: key1, fingerprint: 'fp1' }));
    session.unlock(makeUnlockInput({ derivedKey: key2, fingerprint: 'fp2' }));
    assert.deepEqual(Array.from(key1), [0, 0, 0]);
    assert.equal(session.getFingerprint(), 'fp2');
    assert.equal(unlockedEm.fireCount, 2);
    assert.equal(lockedEm.fireCount, 1);
  });

  it('setCredentials updates the array when unlocked', () => {
    session.unlock(makeUnlockInput());
    const r = session.setCredentials([makeCredential('a'), makeCredential('b')]);
    assert.equal(r.ok, true);
    const creds = session.getCredentials();
    if (creds.ok) {
      assert.equal(creds.value.length, 2);
    }
  });

  it('updateProjectMeta updates the meta', () => {
    session.unlock(makeUnlockInput());
    const newMeta = {
      fingerprint: 'fp-abc',
      fingerprintSource: 'git-remote' as const,
      displayName: 'new-name',
      gitRemoteUrl: null,
      lastKnownPath: '/new/path',
    };
    const r = session.updateProjectMeta(newMeta);
    assert.equal(r.ok, true);
    assert.equal(session.getProjectMeta()?.displayName, 'new-name');
  });

  it('borrowDerivedKey returns the key when unlocked, null when locked', () => {
    assert.equal(session.borrowDerivedKey(), null);
    session.unlock(makeUnlockInput());
    const borrowed = session.borrowDerivedKey();
    assert.notEqual(borrowed, null);
  });
});
