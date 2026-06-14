import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { computeFingerprint } from './compute';
import { normalizeRemoteUrl } from './url-normalize';

/**
 * Project fingerprint resolution (FR-13 to FR-19, FR-45, FR-46).
 *
 * Story 1.6 — strict priority chain:
 *   1. git remote `origin` (canonicalized via `normalizeRemoteUrl`)
 *   2. manifest name (`package.json` `name`, then `pyproject.toml` `[project] name`)
 *   3. absolute workspace path
 *
 * No mixing, no chaining beyond this order. If the workspace has BOTH a git
 * remote AND a manifest name, `source` is `git-remote`.
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;

export type FingerprintSource = 'git-remote' | 'manifest-name' | 'absolute-path';

export interface FingerprintResolution {
  readonly fingerprint: string;
  readonly source: FingerprintSource;
  /** Set only when `source === 'git-remote'`. The canonical normalized URL. */
  readonly canonicalRemoteUrl?: string;
  /** Set only when `source === 'manifest-name'`. The exact manifest name used. */
  readonly manifestName?: string;
}

export async function resolveFingerprint(
  workspacePath: string,
): Promise<FingerprintResolution> {
  // Priority 1: git remote origin
  const remoteUrl = await getGitRemoteUrl(workspacePath);
  if (remoteUrl !== null) {
    const canonical = normalizeRemoteUrl(remoteUrl);
    return {
      fingerprint: computeFingerprint(canonical),
      source: 'git-remote',
      canonicalRemoteUrl: canonical,
    };
  }

  // Priority 2: manifest name
  const manifestName = await getManifestName(workspacePath);
  if (manifestName !== null) {
    return {
      fingerprint: computeFingerprint(manifestName),
      source: 'manifest-name',
      manifestName,
    };
  }

  // Priority 3: absolute path
  return {
    fingerprint: computeFingerprint(workspacePath),
    source: 'absolute-path',
  };
}

/**
 * Read the `origin` remote URL via `git remote get-url origin`. Returns
 * `null` if git is unavailable, the directory is not a git repo, no `origin`
 * remote is configured, or the call times out.
 */
async function getGitRemoteUrl(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Try `package.json` `name`, then `pyproject.toml` `[project] name`. Returns
 * `null` if neither yields a usable name.
 */
async function getManifestName(workspacePath: string): Promise<string | null> {
  // package.json
  try {
    const pkgPath = path.join(workspacePath, 'package.json');
    const pkgRaw = await fs.readFile(pkgPath, 'utf8');
    const parsed: unknown = JSON.parse(pkgRaw);
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const name = parsed.name;
      if (typeof name === 'string' && name.length > 0) {
        return name;
      }
    }
  } catch {
    // fall through to pyproject.toml
  }

  // pyproject.toml — minimal hand-rolled parser for `[project]\n...name = "..."`
  try {
    const pyPath = path.join(workspacePath, 'pyproject.toml');
    const pyRaw = await fs.readFile(pyPath, 'utf8');
    const projectSection = /^\[project\]\s*\n([\s\S]*?)(?=^\[|$)/m.exec(pyRaw);
    if (projectSection !== null) {
      const body = projectSection[1];
      if (body !== undefined) {
        const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(body);
        if (nameMatch !== null && nameMatch[1] !== undefined && nameMatch[1].length > 0) {
          return nameMatch[1];
        }
      }
    }
  } catch {
    // fall through
  }

  return null;
}
