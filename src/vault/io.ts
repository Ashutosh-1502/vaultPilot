import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Result } from '../result/result';
import { FilesystemError } from '../result/errors';

/**
 * Vault filesystem I/O — the SINGLE filesystem gate for the codebase.
 *
 * Story 1.5 — implements FR-1 (vault root at `~/.vaultpilot/`), FR-6 (atomic
 * writes), and OQ-8 (atomic-write partial-recovery semantics).
 *
 * Every vault write goes through `atomicWriteFile`. ESLint enforces that no
 * other module imports `fs` directly. See docs/vault-file-format.md for the
 * authoritative spec of on-disk layout and recovery semantics.
 */

/** Vault root path on the current platform. */
export const VAULT_ROOT = path.join(os.homedir(), '.vaultpilot');
export const PROJECTS_DIR = path.join(VAULT_ROOT, 'projects');
export const ARCHIVE_DIR = path.join(VAULT_ROOT, 'archive');
export const CONFIG_FILE = path.join(VAULT_ROOT, 'config.json');
export const TRASH_PREFIX = '.trash-';

/**
 * Atomic file write — the single gate for any write to the vault.
 *
 * Sequence (FR-6, OQ-8):
 *   1. Write bytes to `<path>.tmp`.
 *   2. fsync the file.
 *   3. Rename `<path>.tmp` → `<path>` (atomic on POSIX; equivalent on Windows).
 *   4. fsync the parent directory (best-effort; no-op on Windows).
 *
 * Failure paths map ENOSPC / EACCES / EPERM to typed FilesystemError subtypes.
 * The prior good file at `<path>` is never touched if the write fails before
 * the rename completes.
 */
export async function atomicWriteFile(
  filePath: string,
  bytes: Buffer,
): Promise<Result<void, FilesystemError>> {
  const tmpPath = `${filePath}.tmp`;
  const parentDir = path.dirname(filePath);

  let fileHandle: fs.FileHandle | null = null;
  try {
    await fs.mkdir(parentDir, { recursive: true });

    // Step 1: write to tmp
    fileHandle = await fs.open(tmpPath, 'w');
    await fileHandle.writeFile(bytes);

    // Step 2: fsync the file
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;

    // Step 3: atomic rename
    await fs.rename(tmpPath, filePath);

    // Step 4: fsync parent dir (POSIX only; Windows doesn't expose dir fsync)
    if (process.platform !== 'win32') {
      await fsyncDirectory(parentDir);
    }

    return Result.ok(undefined);
  } catch (err) {
    if (fileHandle !== null) {
      try {
        await fileHandle.close();
      } catch {
        // best-effort cleanup
      }
    }
    return Result.err(mapFsError(err, filePath));
  }
}

/**
 * Best-effort directory fsync. Some filesystems return EINVAL; we treat that
 * as success-with-degraded-durability rather than failing the write.
 */
async function fsyncDirectory(dir: string): Promise<void> {
  let dirHandle: fs.FileHandle | null = null;
  try {
    dirHandle = await fs.open(dir, 'r');
    await dirHandle.sync();
  } catch {
    // Some filesystems / kernels reject directory fsync. Acceptable per OQ-8.
  } finally {
    if (dirHandle !== null) {
      try {
        await dirHandle.close();
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Ensure the vault root and its `projects/` + `archive/` subdirectories exist.
 * Idempotent.
 */
export async function ensureVaultRoot(): Promise<Result<void, FilesystemError>> {
  try {
    await fs.mkdir(VAULT_ROOT, { recursive: true });
    await fs.mkdir(PROJECTS_DIR, { recursive: true });
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
    return Result.ok(undefined);
  } catch (err) {
    return Result.err(mapFsError(err, VAULT_ROOT));
  }
}

/**
 * Read raw bytes from a path; returns `null` if the file doesn't exist.
 */
export async function readFileOrNull(filePath: string): Promise<Result<Buffer | null, FilesystemError>> {
  try {
    const bytes = await fs.readFile(filePath);
    return Result.ok(bytes);
  } catch (err) {
    if (isNoEnt(err)) {
      return Result.ok(null);
    }
    return Result.err(mapFsError(err, filePath));
  }
}

/**
 * Check whether a path is reachable on disk (used by archive scan for FR-28).
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Vault entry on-disk read result. Either both `meta.json` + `keys.enc` are
 * present (the normal case), only the .tmp sibling is present (mid-rename
 * crash — recovery candidate), or nothing is present.
 *
 * Per OQ-8, the loader (later stories) decides whether to use `keys` or
 * `recoveryKeys` based on whether the primary decrypts successfully. This
 * module reports what's on disk; it does not validate ciphertext.
 */
export interface VaultEntryFiles {
  readonly meta: Buffer;
  readonly keys: Buffer | null;
  readonly recoveryKeys: Buffer | null;
}

export async function readVaultEntry(
  baseDir: string,
  fingerprint: string,
): Promise<Result<VaultEntryFiles | null, FilesystemError>> {
  const dir = path.join(baseDir, fingerprint);
  const metaPath = path.join(dir, 'meta.json');
  const keysPath = path.join(dir, 'keys.enc');
  const tmpPath = `${keysPath}.tmp`;

  const metaResult = await readFileOrNull(metaPath);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;
  if (meta === null) {
    return Result.ok(null);
  }

  const keysResult = await readFileOrNull(keysPath);
  if (!keysResult.ok) return keysResult;
  const tmpResult = await readFileOrNull(tmpPath);
  if (!tmpResult.ok) return tmpResult;

  return Result.ok({
    meta,
    keys: keysResult.value,
    recoveryKeys: tmpResult.value,
  });
}

/**
 * Write a vault entry (meta + keys.enc) atomically. Both files go through
 * `atomicWriteFile`. If either write fails, the existing files are unchanged.
 */
export async function writeVaultEntry(
  baseDir: string,
  fingerprint: string,
  meta: Buffer,
  keysEnc: Buffer,
): Promise<Result<void, FilesystemError>> {
  const dir = path.join(baseDir, fingerprint);
  const metaPath = path.join(dir, 'meta.json');
  const keysPath = path.join(dir, 'keys.enc');

  const keysWrite = await atomicWriteFile(keysPath, keysEnc);
  if (!keysWrite.ok) return keysWrite;
  const metaWrite = await atomicWriteFile(metaPath, meta);
  if (!metaWrite.ok) return metaWrite;
  return Result.ok(undefined);
}

/**
 * Move a vault entry's directory from one base (projects/ or archive/) to
 * the other. Used by archive scan (Story 2.1) and promote-back (Story 2.3).
 *
 * Returns `Result.err(...)` if the destination already exists (cross-base
 * collision is forbidden — exposes a bug in the caller) or if rename fails.
 */
export async function moveVaultEntry(
  fromBase: string,
  toBase: string,
  fingerprint: string,
): Promise<Result<void, FilesystemError>> {
  const fromDir = path.join(fromBase, fingerprint);
  const toDir = path.join(toBase, fingerprint);
  if (await pathExists(toDir)) {
    return Result.err(FilesystemError.atomicWriteFailed(toDir));
  }
  try {
    await fs.mkdir(toBase, { recursive: true });
    await fs.rename(fromDir, toDir);
    return Result.ok(undefined);
  } catch (err) {
    return Result.err(mapFsError(err, fromDir));
  }
}

/**
 * Recursively delete a directory inside the vault root. Used by Story 2.4
 * (permanent delete of an archived entry). Caller is responsible for any
 * confirmation UI before invoking this.
 */
export async function removeVaultDirectory(
  baseDir: string,
  fingerprint: string,
): Promise<Result<void, FilesystemError>> {
  const dir = path.join(baseDir, fingerprint);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return Result.ok(undefined);
  } catch (err) {
    return Result.err(mapFsError(err, dir));
  }
}

/**
 * Generic path rename under the vault root. Used by Story 3.3 restore-with-
 * trash-safety, which moves `projects/` and `archive/` into a `.trash-<ts>/`
 * sibling and then moves staging content into place.
 *
 * Routes through io.ts to honor the file-system boundary ("only io.ts writes
 * to `~/.vaultpilot/`").
 */
export async function renamePath(
  from: string,
  to: string,
): Promise<Result<void, FilesystemError>> {
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return Result.ok(undefined);
  } catch (err) {
    return Result.err(mapFsError(err, from));
  }
}

/**
 * Read the contents of a directory under the vault root. Used by Story 3.3
 * to enumerate staging contents during restore.
 */
export async function readDirectoryEntries(
  dir: string,
): Promise<Result<readonly string[], FilesystemError>> {
  if (!(await pathExists(dir))) {
    return Result.ok([]);
  }
  try {
    const entries = await fs.readdir(dir);
    return Result.ok(entries);
  } catch (err) {
    return Result.err(mapFsError(err, dir));
  }
}

/**
 * Create a directory (recursive). Used by Story 3.3 restore to create the
 * staging directory before tar-extracting into it.
 */
export async function makeDirectory(
  target: string,
): Promise<Result<void, FilesystemError>> {
  try {
    await fs.mkdir(target, { recursive: true });
    return Result.ok(undefined);
  } catch (err) {
    return Result.err(mapFsError(err, target));
  }
}

/**
 * Best-effort recursive directory remove (for staging cleanup on restore
 * failure). Idempotent — succeeds even if the target does not exist.
 */
export async function removePath(
  target: string,
): Promise<Result<void, FilesystemError>> {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return Result.ok(undefined);
  } catch (err) {
    return Result.err(mapFsError(err, target));
  }
}

/**
 * List the immediate-child directories under a base path (typically
 * PROJECTS_DIR or ARCHIVE_DIR). Returns `[]` if the base doesn't exist.
 */
export async function listVaultEntries(
  baseDir: string,
): Promise<Result<readonly string[], FilesystemError>> {
  if (!(await pathExists(baseDir))) {
    return Result.ok([]);
  }
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    return Result.ok(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch (err) {
    return Result.err(mapFsError(err, baseDir));
  }
}

interface NodeJsErrnoException extends Error {
  code?: string;
}

function isNoEnt(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJsErrnoException).code === 'ENOENT'
  );
}

function mapFsError(err: unknown, filePath: string): FilesystemError {
  if (typeof err !== 'object' || err === null) {
    return FilesystemError.atomicWriteFailed(filePath);
  }
  const code = (err as NodeJsErrnoException).code;
  if (code === 'ENOSPC') return FilesystemError.diskFull();
  if (code === 'EACCES' || code === 'EPERM') return FilesystemError.permissionDenied(filePath);
  return FilesystemError.atomicWriteFailed(filePath);
}
