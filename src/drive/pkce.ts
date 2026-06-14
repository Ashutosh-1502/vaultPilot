import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE primitives for OAuth 2.0 authorization code flow with PKCE
 * (Story 3.1 — FR-33).
 *
 * RFC 7636. Google supports PKCE with `code_challenge_method=S256`.
 *
 * Public client (no `client_secret`) is fine here because the redirect URI is
 * a `vscode://` deep-link that only our extension can receive — combined with
 * the PKCE binding between authorize and token-exchange, an interceptor of
 * the authorization code cannot complete the token exchange without the
 * `code_verifier` we kept locally.
 */

/**
 * Generate a 43-character `code_verifier` per RFC 7636 §4.1.
 * 32 random bytes → base64url-encoded → 43 chars (no padding).
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

/**
 * Compute `code_challenge = base64url(SHA-256(code_verifier))` per RFC 7636 §4.2.
 */
export function computeCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier, 'utf8').digest();
  return base64UrlEncode(hash);
}

/**
 * Generate a 22-character `state` parameter per OAuth 2.0 §10.12.
 * 16 random bytes → base64url-encoded → 22 chars (no padding).
 *
 * Used to bind the authorize request to the callback so an attacker cannot
 * inject a forged callback while the user has an authorize flow pending.
 */
export function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
