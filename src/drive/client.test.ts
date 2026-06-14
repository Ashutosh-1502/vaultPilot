import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { DriveClient } from './client';
import { Result } from '../result/result';
import type { SecretStorageWrapper } from '../keychain/secret-storage';

/**
 * client.test.ts focuses on the FR-33 silent-refresh behavior. The full
 * upload/download/rename paths are covered by integration tests that hit
 * real Drive (deferred to test/integration/ under @vscode/test-electron).
 *
 * We mock both `fetch` and the SecretStorageWrapper to drive specific
 * sequences (401 → refresh → retry).
 */

function makeFakeSecrets(refreshToken: string | null): SecretStorageWrapper {
  return {
    getDriveRefreshToken: async () =>
      Result.ok(refreshToken),
    setDriveRefreshToken: async () => Result.ok(undefined),
  } as unknown as SecretStorageWrapper;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeScriptedFetch(
  responses: Array<{ status: number; body?: unknown }>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: urlStr, init: init ?? {} });
    const spec = responses[i++];
    if (spec === undefined) throw new Error(`no scripted response at index ${String(i - 1)}`);
    const responseObj = {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: () => Promise.resolve(spec.body ?? {}),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      clone() {
        return responseObj;
      },
    } as unknown as Response;
    return responseObj;
  }) satisfies typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('DriveClient', () => {
  describe('401 silent refresh (FR-33)', () => {
    it('refreshes once on 401, retries, returns success', async () => {
      const { fetch: fetchImpl, calls } = makeScriptedFetch([
        // 1st Drive call → 401
        { status: 401 },
        // Token refresh → 200 with new access token
        { status: 200, body: { access_token: 'NEW_AT', expires_in: 3600 } },
        // Retry of 1st call → 200
        { status: 200, body: { files: [{ id: 'f1', name: 'vaultpilot-backup' }] } },
      ]);
      const client = new DriveClient(
        'OLD_AT',
        3600,
        'CLIENT_ID',
        'CLIENT_SECRET',
        makeFakeSecrets('RT'),
        fetchImpl,
      );

      const r = await client.listAppdataFilesByName('vaultpilot-backup');
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value.length, 1);
        assert.equal(r.value[0]?.id, 'f1');
      }
      assert.equal(calls.length, 3);
      // The retry uses the new bearer token
      const retryAuth = (calls[2]!.init.headers as Headers).get('Authorization');
      assert.equal(retryAuth, 'Bearer NEW_AT');
    });

    it('returns auth-expired when refresh fails after 401', async () => {
      const { fetch: fetchImpl } = makeScriptedFetch([
        // 1st call → 401
        { status: 401 },
        // Refresh → invalid_grant
        { status: 400, body: { error: 'invalid_grant' } },
      ]);
      const client = new DriveClient(
        'AT',
        3600,
        'CLIENT_ID',
        'CLIENT_SECRET',
        makeFakeSecrets('RT'),
        fetchImpl,
      );

      const r = await client.listAppdataFilesByName('vaultpilot-backup');
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.auth-expired');
      }
    });

    it('returns auth-expired when no refresh token is available', async () => {
      const { fetch: fetchImpl } = makeScriptedFetch([{ status: 401 }]);
      const client = new DriveClient(
        'AT',
        3600,
        'CLIENT_ID',
        'CLIENT_SECRET',
        makeFakeSecrets(null),
        fetchImpl,
      );

      const r = await client.listAppdataFilesByName('vaultpilot-backup');
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.auth-expired');
      }
    });

    it('maps 403 with rate-limit reason to quota-exceeded', async () => {
      const { fetch: fetchImpl, calls } = makeScriptedFetch([
        {
          status: 403,
          body: {
            error: { errors: [{ reason: 'userRateLimitExceeded', message: 'Rate Limit Exceeded' }] },
          },
        },
      ]);
      const client = new DriveClient(
        'AT',
        3600,
        'CLIENT_ID',
        'CLIENT_SECRET',
        makeFakeSecrets('RT'),
        fetchImpl,
      );
      const r = await client.listAppdataFilesByName('vaultpilot-backup');
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.quota-exceeded');
      }
      assert.equal(calls.length, 1);
    });

    it('maps 403 with insufficientPermissions reason to network-failed with cause', async () => {
      const { fetch: fetchImpl } = makeScriptedFetch([
        {
          status: 403,
          body: {
            error: { errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }] },
          },
        },
      ]);
      const client = new DriveClient(
        'AT',
        3600,
        'CLIENT_ID',
        'CLIENT_SECRET',
        makeFakeSecrets('RT'),
        fetchImpl,
      );
      const r = await client.listAppdataFilesByName('vaultpilot-backup');
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.network-failed');
        if (r.error.kind === 'drive.network-failed') {
          assert.ok(r.error.cause?.includes('insufficientPermissions'));
        }
      }
    });
  });

  describe('status mapping', () => {
    it('maps 5xx to network-failed', async () => {
      const { fetch: fetchImpl } = makeScriptedFetch([{ status: 503 }]);
      const client = new DriveClient(
        'AT',
        3600,
        'CLIENT_ID',
        'CLIENT_SECRET',
        makeFakeSecrets('RT'),
        fetchImpl,
      );
      const r = await client.listAppdataFilesByName('x');
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.network-failed');
      }
    });

    it('maps fetch throw to network-failed', async () => {
      const fetchImpl = (async () => {
        throw new Error('ECONNREFUSED');
      }) satisfies typeof fetch;
      const client = new DriveClient(
        'AT',
        3600,
        'CLIENT_ID',
        'CLIENT_SECRET',
        makeFakeSecrets('RT'),
        fetchImpl,
      );
      const r = await client.listAppdataFilesByName('x');
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.network-failed');
      }
    });
  });
});
