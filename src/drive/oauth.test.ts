import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import {
  buildAuthorizeUrl,
  DRIVE_APPDATA_SCOPE,
  exchangeCodeForTokens,
  refreshAccessToken,
} from './oauth';
import { Result } from '../result/result';

describe('OAuth flow', () => {
  describe('buildAuthorizeUrl', () => {
    it('includes all required PKCE parameters', () => {
      const url = new URL(
        buildAuthorizeUrl({
          clientId: 'CLIENT_ID',
          redirectUri: 'vscode://ashutoshsuryavanshi.vaultpilot/oauth-callback',
          codeChallenge: 'CHAL',
          state: 'STATE',
        }),
      );
      assert.equal(url.host, 'accounts.google.com');
      assert.equal(url.searchParams.get('client_id'), 'CLIENT_ID');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('scope'), DRIVE_APPDATA_SCOPE);
      assert.equal(url.searchParams.get('state'), 'STATE');
      assert.equal(url.searchParams.get('code_challenge'), 'CHAL');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('access_type'), 'offline');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('returns tokens on a 200 response', async () => {
      const fakeFetch = makeFakeFetch({
        status: 200,
        body: {
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
        },
      });
      const r = await exchangeCodeForTokens(
        { clientId: 'C', clientSecret: '', code: 'CODE', codeVerifier: 'V', redirectUri: 'R' },
        fakeFetch,
      );
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value.accessToken, 'AT');
        assert.equal(r.value.refreshToken, 'RT');
        assert.equal(r.value.expiresIn, 3600);
      }
    });

    it('returns auth-expired on invalid_grant error', async () => {
      const fakeFetch = makeFakeFetch({
        status: 400,
        body: { error: 'invalid_grant' },
      });
      const r = await exchangeCodeForTokens(
        { clientId: 'C', clientSecret: '', code: 'CODE', codeVerifier: 'V', redirectUri: 'R' },
        fakeFetch,
      );
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.auth-expired');
      }
    });

    it('returns network-failed on a non-JSON response', async () => {
      const fakeFetch = (async () =>
        ({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('not json')),
        }) as unknown as Response) satisfies typeof fetch;
      const r = await exchangeCodeForTokens(
        { clientId: 'C', clientSecret: '', code: 'CODE', codeVerifier: 'V', redirectUri: 'R' },
        fakeFetch,
      );
      assert.equal(r.ok, false);
    });

    it('returns network-failed on fetch throw', async () => {
      const fakeFetch = (async () => {
        throw new Error('ECONNRESET');
      }) satisfies typeof fetch;
      const r = await exchangeCodeForTokens(
        { clientId: 'C', clientSecret: '', code: 'CODE', codeVerifier: 'V', redirectUri: 'R' },
        fakeFetch,
      );
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.network-failed');
      }
    });
  });

  describe('refreshAccessToken', () => {
    it('preserves the previous refresh token when Google omits it', async () => {
      const fakeFetch = makeFakeFetch({
        status: 200,
        body: { access_token: 'NEW_AT', expires_in: 3600 },
      });
      const r = await refreshAccessToken(
        { clientId: 'C', clientSecret: '', refreshToken: 'OLD_RT' },
        fakeFetch,
      );
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value.accessToken, 'NEW_AT');
        assert.equal(r.value.refreshToken, 'OLD_RT');
      }
    });

    it('rotates the refresh token when Google returns a new one', async () => {
      const fakeFetch = makeFakeFetch({
        status: 200,
        body: { access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 3600 },
      });
      const r = await refreshAccessToken(
        { clientId: 'C', clientSecret: '', refreshToken: 'OLD_RT' },
        fakeFetch,
      );
      if (Result.isOk(r)) {
        assert.equal(r.value.refreshToken, 'NEW_RT');
      }
    });

    it('returns auth-expired when the refresh token is revoked', async () => {
      const fakeFetch = makeFakeFetch({
        status: 400,
        body: { error: 'invalid_grant' },
      });
      const r = await refreshAccessToken(
        { clientId: 'C', clientSecret: '', refreshToken: 'BAD_RT' },
        fakeFetch,
      );
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error.kind, 'drive.auth-expired');
      }
    });
  });
});

function makeFakeFetch(spec: {
  status: number;
  body: unknown;
}): typeof fetch {
  return (async () =>
    ({
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: () => Promise.resolve(spec.body),
    }) as unknown as Response) satisfies typeof fetch;
}
