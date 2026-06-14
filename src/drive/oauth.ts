import { Result } from '../result/result';
import { DriveError } from '../result/errors';

/**
 * OAuth 2.0 authorization code flow with PKCE (Story 3.1 — FR-33).
 *
 * Pure HTTP — uses Node 18+ built-in `fetch`. Avoids `google-auth-library`
 * which carries the whole Google Cloud SDK tree.
 *
 * Flow:
 *   1. `buildAuthorizeUrl(...)` — open in system browser; user authenticates.
 *   2. URI handler receives the redirect with `code` + `state`.
 *   3. `exchangeCodeForTokens(...)` — POST to Google's token endpoint with
 *      the code + verifier; returns access + refresh tokens.
 *   4. `refreshAccessToken(...)` — when an access token expires (401 on a
 *      Drive call), use the refresh token to get a new one.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

export interface AuthorizeUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
}

/**
 * Build the Google OAuth 2.0 authorize URL with PKCE parameters.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: DRIVE_APPDATA_SCOPE,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds-from-now until the access token expires. */
  readonly expiresIn: number;
}

export interface ExchangeCodeInput {
  readonly clientId: string;
  /**
   * Required by Google's token endpoint for "Desktop app" OAuth clients,
   * even with PKCE. Pass empty string only for tests that mock fetch.
   */
  readonly clientSecret: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * Exchange an authorization code (received via the redirect) for an access
 * token + refresh token pair.
 *
 * The injected `fetchImpl` is the global `fetch` in production; tests supply
 * a mock.
 */
export async function exchangeCodeForTokens(
  input: ExchangeCodeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<TokenPair, DriveError>> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  };
  if (input.clientSecret.length > 0) {
    params['client_secret'] = input.clientSecret;
  }
  return postTokenEndpoint(new URLSearchParams(params), fetchImpl);
}

export interface RefreshAccessTokenInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Google may or may not return a new refresh token in the response — when it
 * does, callers should rotate the stored value.
 */
export async function refreshAccessToken(
  input: RefreshAccessTokenInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<TokenPair, DriveError>> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  };
  if (input.clientSecret.length > 0) {
    params['client_secret'] = input.clientSecret;
  }
  const body = new URLSearchParams(params);
  // Google does NOT always return a refresh_token on refresh — use the
  // previously-stored one if absent.
  const result = await postTokenEndpoint(body, fetchImpl);
  if (!result.ok) return result;
  return Result.ok({
    accessToken: result.value.accessToken,
    refreshToken: result.value.refreshToken || input.refreshToken,
    expiresIn: result.value.expiresIn,
  });
}

interface TokenResponseBody {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly error?: string;
}

async function postTokenEndpoint(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<Result<TokenPair, DriveError>> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    return Result.err(DriveError.networkFailed(String(err)));
  }

  let parsed: TokenResponseBody;
  try {
    parsed = (await response.json()) as TokenResponseBody;
  } catch {
    return Result.err(DriveError.networkFailed('non-JSON response from token endpoint'));
  }

  if (!response.ok) {
    if (parsed.error === 'invalid_grant') {
      // Refresh token revoked / expired; user must re-authenticate.
      return Result.err(DriveError.authExpired());
    }
    return Result.err(DriveError.networkFailed(parsed.error ?? `HTTP ${String(response.status)}`));
  }

  if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
    return Result.err(DriveError.networkFailed('malformed token response'));
  }

  return Result.ok({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? '',
    expiresIn: parsed.expires_in,
  });
}
