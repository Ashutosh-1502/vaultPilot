import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import * as vscode from 'vscode';

import { Result } from '../result/result';
import { DriveError } from '../result/errors';
import { buildAuthorizeUrl, exchangeCodeForTokens, type TokenPair } from './oauth';
import { computeCodeChallenge, generateCodeVerifier, generateState } from './pkce';
import type { SecretStorageWrapper } from '../keychain/secret-storage';

/**
 * OAuth orchestrator (Story 3.1 — FR-33).
 *
 * 2026-06-13: switched from `vscode://` deep-link URI handler to **loopback
 * HTTP server** (RFC 8252 §7.3) after Google tightened restrictions on
 * custom URI schemes. The new flow:
 *
 *   1. Start a Node HTTP server on a random `127.0.0.1` port.
 *   2. Open Google's authorize URL in the system browser with
 *      `redirect_uri=http://127.0.0.1:<port>/oauth-callback`.
 *   3. After the user grants consent, Google redirects the browser to the
 *      loopback URL with `?code=...&state=...`. The HTTP server captures it,
 *      responds with a friendly HTML "you can close this tab" page, and
 *      closes itself.
 *   4. Exchange the code for tokens at Google's token endpoint.
 *
 * Google's OAuth allows `http://127.0.0.1:<any-port>/` and
 * `http://localhost:<any-port>/` redirect URIs WITHOUT pre-registration for
 * "Desktop app" client type. PKCE eliminates the need for a `client_secret`.
 */

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_PATH = '/oauth-callback';

interface CallbackServer {
  readonly redirectUri: string;
  readonly awaitCode: Promise<string>;
  readonly dispose: () => void;
}

/**
 * Bind a localhost HTTP server on a random free port and return:
 *   - the redirect URI string to embed in the OAuth authorize URL
 *   - a promise that resolves with the authorization code (or rejects on
 *     state mismatch / OAuth error / malformed callback)
 *   - a dispose() to close the server early
 */
async function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  let resolveCode: (code: string) => void = () => {
    /* assigned below */
  };
  let rejectCode: (err: Error) => void = () => {
    /* assigned below */
  };
  const awaitCode = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error !== null) {
      sendHtml(res, 'OAuth error', `Google returned: ${escapeHtml(error)}. You can close this tab.`);
      rejectCode(new Error(`OAuth error: ${error}`));
      return;
    }
    if (state !== expectedState) {
      sendHtml(res, 'State mismatch', 'Possible CSRF — flow aborted. You can close this tab.');
      rejectCode(new Error('OAuth state mismatch'));
      return;
    }
    if (code === null) {
      sendHtml(res, 'Missing code', 'OAuth callback did not include an authorization code.');
      rejectCode(new Error('OAuth callback missing code'));
      return;
    }

    sendHtml(
      res,
      'Signed in',
      'Authentication complete. You can close this tab and return to VS Code.',
    );
    resolveCode(code);
  });

  // Bind to port 0 → OS picks a free port.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${String(address.port)}${CALLBACK_PATH}`;

  return {
    redirectUri,
    awaitCode,
    dispose: () => {
      try {
        server.close();
      } catch {
        // best-effort
      }
    },
  };
}

function sendHtml(res: http.ServerResponse, title: string, body: string): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>VaultPilot — ${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;text-align:center;color:#333;line-height:1.5}
h1{font-size:1.5rem;margin-bottom:0.5rem}
p{color:#666}
</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface AuthenticateInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly secretStorage: SecretStorageWrapper;
}

/**
 * Run the full OAuth flow:
 *   1. Generate PKCE verifier + challenge + state.
 *   2. Start a loopback HTTP server on a random localhost port.
 *   3. Open the Google authorize URL in the system browser, with the
 *      loopback URL as the redirect URI.
 *   4. Wait for the HTTP server to receive the callback (5-minute timeout).
 *   5. Exchange the code for tokens at Google's token endpoint.
 *   6. Persist the refresh token via SecretStorage.
 */
export async function authenticate(
  input: AuthenticateInput,
): Promise<Result<TokenPair, DriveError>> {
  if (input.clientId.length === 0) {
    return Result.err(
      DriveError.networkFailed(
        'OAuth client ID not configured. Set `vaultpilot.driveOAuthClientId` in settings.',
      ),
    );
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const state = generateState();

  let server: CallbackServer;
  try {
    server = await startCallbackServer(state);
  } catch (err) {
    return Result.err(
      DriveError.networkFailed(`Could not start OAuth callback server: ${String(err)}`),
    );
  }

  try {
    const authorizeUrl = buildAuthorizeUrl({
      clientId: input.clientId,
      redirectUri: server.redirectUri,
      codeChallenge,
      state,
    });

    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));
    if (!opened) {
      return Result.err(DriveError.networkFailed('Failed to open system browser for OAuth'));
    }

    // Race the user against a 5-minute timeout.
    let code: string;
    try {
      code = await Promise.race([
        server.awaitCode,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('OAuth flow timed out'));
          }, AUTH_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      return Result.err(DriveError.networkFailed(String(err)));
    }

    const exchangeResult = await exchangeCodeForTokens({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      code,
      codeVerifier,
      redirectUri: server.redirectUri,
    });
    if (!exchangeResult.ok) return exchangeResult;

    if (exchangeResult.value.refreshToken.length > 0) {
      void input.secretStorage.setDriveRefreshToken(exchangeResult.value.refreshToken);
    }

    return exchangeResult;
  } finally {
    server.dispose();
  }
}
