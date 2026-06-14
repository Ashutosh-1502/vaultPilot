import * as path from 'node:path';

import { Result } from '../result/result';
import { FilesystemError } from '../result/errors';
import {
  ARCHIVE_DIR,
  PROJECTS_DIR,
  atomicWriteFile,
  listVaultEntries,
  moveVaultEntry,
  pathExists,
  readFileOrNull,
} from '../vault/io';

/**
 * Archive scan + two-activation-miss detection (FR-28).
 *
 * Story 2.1 — on extension activation, iterate every entry under
 * `~/.vaultpilot/projects/<fp>/`, read its `meta.json`, and check whether
 * `lastKnownPath` is reachable on disk.
 *
 * Two-activation gate:
 *   - First time we observe an entry's path missing → set `tentativeMissAt`
 *     to the current ISO timestamp; entry remains in `projects/`.
 *   - Second time we observe it missing (across activations) → move the
 *     entry from `projects/<fp>/` to `archive/<fp>/` and clear
 *     `tentativeMissAt`.
 *   - If the path becomes reachable again before the second miss, clear
 *     `tentativeMissAt` and leave the entry in `projects/`.
 *
 * Guard (FR-28 explicit): if `currentWorkspaceFingerprint` matches an entry's
 * fingerprint, skip archiving (the user has this workspace open right now —
 * the path is logically reachable via the open window even if `lastKnownPath`
 * has stale value).
 */

export interface ArchiveScanInput {
  /** Fingerprint of the currently-open workspace, or `null` if none. */
  readonly currentWorkspaceFingerprint: string | null;
}

export interface ArchiveScanReport {
  readonly scanned: number;
  readonly archived: readonly string[];
  readonly markedTentative: readonly string[];
  readonly clearedTentative: readonly string[];
  readonly skippedActive: readonly string[];
  readonly errors: readonly { readonly fingerprint: string; readonly reason: string }[];
}

interface MetaJson {
  readonly version?: number;
  readonly fingerprint?: string;
  readonly fingerprintSource?: string;
  readonly displayName?: string;
  readonly gitRemoteUrl?: string | null;
  readonly lastKnownPath?: string;
  readonly tentativeMissAt?: string | null;
}

export async function scanForArchivableEntries(
  input: ArchiveScanInput,
): Promise<Result<ArchiveScanReport, FilesystemError>> {
  const entriesResult = await listVaultEntries(PROJECTS_DIR);
  if (!entriesResult.ok) return entriesResult;
  const fingerprints = entriesResult.value;

  const archived: string[] = [];
  const markedTentative: string[] = [];
  const clearedTentative: string[] = [];
  const skippedActive: string[] = [];
  const errors: { fingerprint: string; reason: string }[] = [];

  for (const fingerprint of fingerprints) {
    const result = await scanSingleEntry(fingerprint, input);
    if (!result.ok) {
      errors.push({ fingerprint, reason: result.error.kind });
      continue;
    }
    switch (result.value.outcome) {
      case 'archived':
        archived.push(fingerprint);
        break;
      case 'marked-tentative':
        markedTentative.push(fingerprint);
        break;
      case 'cleared-tentative':
        clearedTentative.push(fingerprint);
        break;
      case 'skipped-active':
        skippedActive.push(fingerprint);
        break;
      case 'no-change':
        break;
    }
  }

  return Result.ok({
    scanned: fingerprints.length,
    archived,
    markedTentative,
    clearedTentative,
    skippedActive,
    errors,
  });
}

type SingleScanOutcome =
  | { outcome: 'archived' }
  | { outcome: 'marked-tentative' }
  | { outcome: 'cleared-tentative' }
  | { outcome: 'skipped-active' }
  | { outcome: 'no-change' };

async function scanSingleEntry(
  fingerprint: string,
  input: ArchiveScanInput,
): Promise<Result<SingleScanOutcome, FilesystemError>> {
  const entryDir = path.join(PROJECTS_DIR, fingerprint);
  const metaPath = path.join(entryDir, 'meta.json');

  const metaResult = await readFileOrNull(metaPath);
  if (!metaResult.ok) return metaResult;
  if (metaResult.value === null) {
    return Result.ok({ outcome: 'no-change' });
  }

  let meta: MetaJson;
  try {
    meta = JSON.parse(metaResult.value.toString('utf8')) as MetaJson;
  } catch {
    return Result.ok({ outcome: 'no-change' });
  }

  const lastKnownPath = meta.lastKnownPath;
  if (typeof lastKnownPath !== 'string' || lastKnownPath.length === 0) {
    return Result.ok({ outcome: 'no-change' });
  }

  const reachable = await pathExists(lastKnownPath);
  const isCurrentlyOpen =
    input.currentWorkspaceFingerprint !== null &&
    input.currentWorkspaceFingerprint === fingerprint;

  // Reachable or currently-open → clear tentativeMissAt if set; keep entry active.
  if (reachable || isCurrentlyOpen) {
    if (meta.tentativeMissAt !== null && meta.tentativeMissAt !== undefined) {
      const cleared: MetaJson = { ...meta, tentativeMissAt: null };
      const write = await atomicWriteFile(
        metaPath,
        Buffer.from(JSON.stringify(cleared), 'utf8'),
      );
      if (!write.ok) return write;
      return Result.ok({ outcome: 'cleared-tentative' });
    }
    if (isCurrentlyOpen && !reachable) {
      return Result.ok({ outcome: 'skipped-active' });
    }
    return Result.ok({ outcome: 'no-change' });
  }

  // Unreachable AND not currently-open.
  if (meta.tentativeMissAt === null || meta.tentativeMissAt === undefined) {
    // First miss — record tentative, keep in projects/.
    const flagged: MetaJson = { ...meta, tentativeMissAt: new Date().toISOString() };
    const write = await atomicWriteFile(
      metaPath,
      Buffer.from(JSON.stringify(flagged), 'utf8'),
    );
    if (!write.ok) return write;
    return Result.ok({ outcome: 'marked-tentative' });
  }

  // Second miss — move to archive (via the io.ts gate).
  const moveResult = await moveVaultEntry(PROJECTS_DIR, ARCHIVE_DIR, fingerprint);
  if (!moveResult.ok) return moveResult;

  // Clear tentativeMissAt in the archived meta.json (best-effort).
  const archivedMetaPath = path.join(ARCHIVE_DIR, fingerprint, 'meta.json');
  const cleanedMeta: MetaJson = { ...meta, tentativeMissAt: null };
  void (await atomicWriteFile(
    archivedMetaPath,
    Buffer.from(JSON.stringify(cleanedMeta), 'utf8'),
  ));
  return Result.ok({ outcome: 'archived' });
}
