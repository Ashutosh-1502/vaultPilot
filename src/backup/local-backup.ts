import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const archiver = require('archiver') as unknown as ArchiverFactory;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const archiverZipEncrypted = require('archiver-zip-encrypted') as unknown as object;

import { Result } from '../result/result';
import type { VaultError } from '../result/errors';
import { FilesystemError } from '../result/errors';
import type { Credential } from '../credentials/credential';
import { credentialsToEnvFile } from '../credentials/env-export';
import { ARCHIVE_DIR, PROJECTS_DIR, listVaultEntries, pathExists, readVaultEntry } from '../vault/io';

/**
 * Local-file backup — emits AES-256 encrypted ZIP files containing readable
 * .env content. Designed so the user can recover credentials WITHOUT
 * VaultPilot installed: any archive tool that supports WinZip-AES (Keka /
 * 7-Zip / WinZip / The Unarchiver+keka) can open the .zip and reveal a plain
 * .env inside.
 *
 * Layout:
 *   <targetDir>/vaultpilot-secret/
 *     ├── projects/<fingerprint>/meta.json                ← plaintext index
 *     ├── projects/<fingerprint>/<displayName>.env.zip    ← AES-256 encrypted
 *     ├── archive/<fingerprint>/meta.json
 *     ├── archive/<fingerprint>/<displayName>.env.zip
 *     └── backup-manifest.json
 *
 * The .zip contains a single file: `<displayName>.env` in standard POSIX
 * env format. To open externally: double-click in Keka/7-Zip → enter the
 * backup passphrase → see the .env file.
 *
 * The backup passphrase is a SEPARATE secret from per-project vault
 * passphrases — set once at backup time, applies to every ZIP in this run.
 *
 * Notes:
 *   - macOS Finder cannot open AES-256 ZIPs natively. User needs Keka,
 *     The Unarchiver (with Keka helper), or 7-Zip. Documented in the UI.
 *   - Projects whose credentials aren't currently available (vault locked,
 *     no cached key) are skipped — the caller is responsible for collecting
 *     decrypted credentials before invoking this function.
 */

// Register the AES-256 encryption format with archiver. Idempotent — the
// library guards against duplicate registration internally.
interface ArchiverFactory {
  registerFormat: (name: string, module: object) => void;
  (format: string, options: { zlib: { level: number }; encryptionMethod: string; password: string }): ArchiverInstance;
}
interface ArchiverInstance {
  append: (source: Buffer | string, options: { name: string }) => void;
  pipe: (dest: NodeJS.WritableStream) => void;
  finalize: () => Promise<void>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}
try {
  archiver.registerFormat('zip-encrypted', archiverZipEncrypted);
} catch {
  // Already registered (re-entry on module reload during dev).
}

export const BACKUP_FOLDER_NAME = 'vaultpilot-secret';
export const BACKUP_FILE_EXT = '.env.zip';

export interface LocalBackupReport {
  readonly folder: string;
  readonly projectsCopied: number;
  readonly archivedCopied: number;
  readonly skipped: ReadonlyArray<{ readonly displayName: string; readonly reason: string }>;
  readonly bytes: number;
}

export interface LocalVaultEntry {
  readonly fingerprint: string;
  readonly displayName: string;
  readonly status: 'active' | 'archived';
  readonly gitRemoteUrl: string | null;
  readonly hasZip: boolean;
}

/**
 * Per-project bundle of cleartext credentials the caller already decrypted.
 * Caller MUST provide an entry for every project they want included in the
 * backup; locked projects without a bundle are skipped.
 */
export interface BackupBundle {
  readonly fingerprint: string;
  readonly status: 'active' | 'archived';
  readonly displayName: string;
  readonly credentials: readonly Credential[];
}

interface ManifestJson {
  readonly version: 2; // bump from v1 (raw-blob format)
  readonly format: 'aes-zip';
  readonly createdAt: string;
  readonly entries: ReadonlyArray<{
    readonly fingerprint: string;
    readonly status: 'active' | 'archived';
    readonly displayName: string;
    readonly file: string;
  }>;
}

/**
 * Write a password-protected ZIP file containing a single .env entry.
 * Uses WinZip-compatible AES-256 encryption via archiver-zip-encrypted.
 */
async function writeEncryptedZip(
  destPath: string,
  envFileName: string,
  envContent: string,
  passphrase: string,
): Promise<Result<number, FilesystemError>> {
  return new Promise((resolve) => {
    const out = createWriteStream(destPath);
    let bytes = 0;
    const archive = archiver('zip-encrypted', {
      zlib: { level: 9 },
      encryptionMethod: 'aes256',
      password: passphrase,
    });

    out.on('close', () => {
      resolve(Result.ok(bytes));
    });
    out.on('error', (err: Error) => {
      resolve(Result.err(FilesystemError.atomicWriteFailed(`${destPath}: ${String(err)}`)));
    });
    archive.on('error', (err: unknown) => {
      resolve(Result.err(FilesystemError.atomicWriteFailed(`${destPath}: ${String(err)}`)));
    });
    archive.on('end', () => {
      bytes = (archive as unknown as { pointer: () => number }).pointer();
    });

    archive.pipe(out);
    archive.append(envContent, { name: envFileName });
    void archive.finalize();
  });
}

export async function backupToLocal(
  targetParentDir: string,
  bundles: readonly BackupBundle[],
  backupPassphrase: string,
): Promise<Result<LocalBackupReport, VaultError>> {
  const folder = path.join(targetParentDir, BACKUP_FOLDER_NAME);

  try {
    await fs.mkdir(folder, { recursive: true });
  } catch (err) {
    return Result.err(FilesystemError.atomicWriteFailed(`${folder}: ${String(err)}`));
  }

  let totalBytes = 0;
  const manifestEntries: ManifestJson['entries'][number][] = [];
  const skipped: Array<{ displayName: string; reason: string }> = [];
  const bundlesByFingerprint = new Map<string, BackupBundle>(
    bundles.map((b) => [b.fingerprint, b]),
  );

  const processSubdir = async (
    sourceBase: string,
    subdir: 'projects' | 'archive',
  ): Promise<Result<number, VaultError>> => {
    const entries = await listVaultEntries(sourceBase);
    if (!entries.ok) return entries;
    let written = 0;
    for (const fingerprint of entries.value) {
      const read = await readVaultEntry(sourceBase, fingerprint);
      if (!read.ok) return read;
      if (read.value === null) continue;
      const meta = read.value.meta;

      let displayName = fingerprint;
      try {
        const parsed = JSON.parse(meta.toString('utf8')) as { displayName?: string };
        if (typeof parsed.displayName === 'string' && parsed.displayName.length > 0) {
          displayName = parsed.displayName;
        }
      } catch {
        // Tolerate broken meta.
      }

      const bundle = bundlesByFingerprint.get(fingerprint);
      if (bundle === undefined) {
        skipped.push({
          displayName,
          reason: 'Vault is locked — unlock it first, then re-run the backup.',
        });
        continue;
      }

      const destDir = path.join(folder, subdir, fingerprint);
      try {
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(path.join(destDir, 'meta.json'), meta);
      } catch (err) {
        return Result.err(FilesystemError.atomicWriteFailed(`${destDir}: ${String(err)}`));
      }

      const envFile = `${sanitizeForFilename(displayName)}.env`;
      const zipName = `${sanitizeForFilename(displayName)}${BACKUP_FILE_EXT}`;
      const envContent = credentialsToEnvFile(bundle.credentials, {
        header:
          `# VaultPilot backup — ${displayName} (${fingerprint})\n` +
          `# Exported at ${new Date().toISOString()}\n` +
          `# This file lives inside an AES-256 encrypted ZIP. Open the ZIP with the\n` +
          `# backup passphrase you set when running "Back Up Locally".\n#`,
      });

      const zipPath = path.join(destDir, zipName);
      const writeResult = await writeEncryptedZip(
        zipPath,
        envFile,
        envContent,
        backupPassphrase,
      );
      if (!writeResult.ok) return writeResult;
      totalBytes += writeResult.value + meta.length;

      manifestEntries.push({
        fingerprint,
        status: subdir === 'projects' ? 'active' : 'archived',
        displayName,
        file: zipName,
      });
      written++;
    }
    return Result.ok(written);
  };

  const projects = await processSubdir(PROJECTS_DIR, 'projects');
  if (!projects.ok) return projects;
  const archived = await processSubdir(ARCHIVE_DIR, 'archive');
  if (!archived.ok) return archived;

  if (projects.value === 0 && archived.value === 0) {
    const reason =
      skipped.length > 0
        ? 'Nothing was backed up — every vault is locked. Unlock at least one workspace, then re-run.'
        : 'Vault is empty; nothing to back up.';
    return Result.err(FilesystemError.atomicWriteFailed(reason));
  }

  const manifest: ManifestJson = {
    version: 2,
    format: 'aes-zip',
    createdAt: new Date().toISOString(),
    entries: manifestEntries,
  };
  try {
    await fs.writeFile(
      path.join(folder, 'backup-manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  } catch (err) {
    return Result.err(FilesystemError.atomicWriteFailed(`backup-manifest.json: ${String(err)}`));
  }

  return Result.ok({
    folder,
    projectsCopied: projects.value,
    archivedCopied: archived.value,
    skipped,
    bytes: totalBytes,
  });
}

/**
 * List vaults present in a backup folder WITHOUT decrypting anything.
 * Each entry includes whether the encrypted ZIP file actually exists on disk
 * (so the Inspect UI can show "missing" if someone deleted the .zip manually).
 */
export async function listLocalBackupVaults(
  backupFolder: string,
): Promise<Result<readonly LocalVaultEntry[], FilesystemError>> {
  if (!(await pathExists(backupFolder))) {
    return Result.err(FilesystemError.atomicWriteFailed(`${backupFolder} does not exist`));
  }

  const entries: LocalVaultEntry[] = [];
  for (const status of ['active', 'archived'] as const) {
    const subdir = path.join(backupFolder, status === 'active' ? 'projects' : 'archive');
    if (!(await pathExists(subdir))) continue;
    let fingerprints: string[];
    try {
      const dirents = await fs.readdir(subdir, { withFileTypes: true });
      fingerprints = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      return Result.err(FilesystemError.atomicWriteFailed(`${subdir}: ${String(err)}`));
    }
    for (const fingerprint of fingerprints) {
      const projDir = path.join(subdir, fingerprint);
      const metaPath = path.join(projDir, 'meta.json');
      let metaRaw: string;
      try {
        metaRaw = await fs.readFile(metaPath, 'utf8');
      } catch {
        continue;
      }
      let displayName = fingerprint;
      let gitRemoteUrl: string | null = null;
      try {
        const parsed = JSON.parse(metaRaw) as {
          displayName?: string;
          gitRemoteUrl?: string | null;
        };
        if (typeof parsed.displayName === 'string' && parsed.displayName.length > 0) {
          displayName = parsed.displayName;
        }
        if (typeof parsed.gitRemoteUrl === 'string') {
          gitRemoteUrl = parsed.gitRemoteUrl;
        }
      } catch {
        // ignore
      }

      // Check whether the encrypted ZIP exists in this entry.
      let hasZip = false;
      try {
        const files = await fs.readdir(projDir);
        hasZip = files.some((f) => f.endsWith(BACKUP_FILE_EXT));
      } catch {
        // ignore
      }
      entries.push({ fingerprint, displayName, status, gitRemoteUrl, hasZip });
    }
  }

  return Result.ok(entries);
}

function sanitizeForFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-').slice(0, 100) || 'vault';
}
