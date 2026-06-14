import * as path from 'node:path';

import { ARCHIVE_DIR, PROJECTS_DIR, listVaultEntries, readFileOrNull } from '../../../vault/io';
import type { ProjectInfo, ProjectStatus } from './message-types';

/**
 * Scan `~/.vaultpilot/projects/` AND `~/.vaultpilot/archive/` for all
 * initialized vault entries. Returns metadata for each by reading the
 * unencrypted `meta.json` — no decryption needed.
 *
 * Designed to be fast enough to run on every Dashboard load (sub-100ms for
 * typical 5–50 projects). The Dashboard's stats footer uses `knownCount`
 * only when the per-fingerprint key is already cached.
 */

interface RawMeta {
  readonly fingerprint?: string;
  readonly displayName?: string;
  readonly gitRemoteUrl?: string | null;
  readonly fingerprintSource?: string;
  readonly lastKnownPath?: string;
  readonly created?: string;
}

export async function listAllProjects(): Promise<ProjectInfo[]> {
  const active = await listFrom(PROJECTS_DIR, 'active');
  const archived = await listFrom(ARCHIVE_DIR, 'archived');
  return [...active, ...archived];
}

async function listFrom(baseDir: string, status: ProjectStatus): Promise<ProjectInfo[]> {
  const entriesResult = await listVaultEntries(baseDir);
  if (!entriesResult.ok) return [];
  const fingerprints = entriesResult.value;
  const out: ProjectInfo[] = [];
  for (const fp of fingerprints) {
    const meta = await readMeta(baseDir, fp);
    if (meta === null) continue;
    out.push({
      fingerprint: meta.fingerprint ?? fp,
      displayName: meta.displayName ?? '(unnamed)',
      gitRemoteUrl: meta.gitRemoteUrl ?? null,
      fingerprintSource: meta.fingerprintSource ?? 'unknown',
      lastKnownPath: meta.lastKnownPath ?? '',
      status,
      ...(meta.created !== undefined ? { created: meta.created } : {}),
    });
  }
  return out;
}

async function readMeta(baseDir: string, fingerprint: string): Promise<RawMeta | null> {
  const metaPath = path.join(baseDir, fingerprint, 'meta.json');
  const result = await readFileOrNull(metaPath);
  if (!result.ok || result.value === null) return null;
  try {
    return JSON.parse(result.value.toString('utf8')) as RawMeta;
  } catch {
    return null;
  }
}
