/**
 * Git remote URL normalization (FR-45).
 *
 * Story 1.6 — canonicalizes SSH↔HTTPS forms so that all clone variants of the
 * same logical repository produce identical canonical strings, and therefore
 * identical fingerprints (FR-46).
 *
 * Steps:
 *   1. Trim outer whitespace.
 *   2. Strip protocol prefix (`https://`, `http://`, `ssh://`, `git://`).
 *   3. Strip leading `user@` (covers `git@github.com`, `user@host`).
 *   4. If no protocol was originally present (scp-style `host:owner/repo`),
 *      replace the first `:` with `/`.
 *   5. Lowercase the entire string (canonical form is lowercased).
 *   6. Strip trailing slashes.
 *   7. Strip a single trailing `.git` suffix.
 *
 * Canonical output shape: `<host>/<owner>/<repo>` (lowercase, no protocol,
 * no `.git`, no trailing slash).
 *
 * Idempotent: `normalize(normalize(x)) === normalize(x)`.
 */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim();

  let hadProtocol = false;

  // Strip protocol prefix (case-insensitive).
  const protocolMatch = /^(https?|ssh|git):\/\//i.exec(s);
  if (protocolMatch !== null) {
    hadProtocol = true;
    s = s.slice(protocolMatch[0].length);
  }

  // Strip user@host prefix.
  const firstSlash = s.indexOf('/');
  const atIndex = s.indexOf('@');
  if (atIndex >= 0 && (firstSlash < 0 || atIndex < firstSlash)) {
    s = s.slice(atIndex + 1);
  }

  // scp-style host:owner/repo → host/owner/repo (only when no protocol).
  // With a protocol, a colon in the host position is a port (e.g., `host:8443/...`)
  // and should be preserved.
  if (!hadProtocol) {
    const colonIdx = s.indexOf(':');
    if (colonIdx >= 0) {
      s = s.slice(0, colonIdx) + '/' + s.slice(colonIdx + 1);
    }
  }

  // Lowercase before suffix stripping so `.GIT` / `.Git` are caught.
  s = s.toLowerCase();

  // Strip trailing slashes.
  while (s.endsWith('/')) {
    s = s.slice(0, -1);
  }

  // Strip a single trailing `.git` suffix.
  if (s.endsWith('.git')) {
    s = s.slice(0, -4);
  }

  return s;
}
