import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, before, after, beforeEach } from 'mocha';

import {
  atomicWriteFile,
  listVaultEntries,
  moveVaultEntry,
  pathExists,
  readFileOrNull,
  readVaultEntry,
  removeVaultDirectory,
  writeVaultEntry,
} from './io';
import { Result } from '../result/result';

/**
 * io.test.ts exercises the filesystem helpers against a temporary directory.
 * We do NOT touch the real `~/.vaultpilot/` — VAULT_ROOT is read-only for
 * tests; we drive the helpers with explicit base directories.
 */
describe('vault/io', () => {
  let tmpDir = '';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultpilot-test-'));
  });

  after(async () => {
    if (tmpDir !== '') {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    // Reset tmpDir contents between tests
    const entries = await fs.readdir(tmpDir);
    for (const e of entries) {
      await fs.rm(path.join(tmpDir, e), { recursive: true, force: true });
    }
  });

  describe('atomicWriteFile', () => {
    it('writes bytes to the target path and leaves no .tmp behind', async () => {
      const target = path.join(tmpDir, 'a', 'b.txt');
      const result = await atomicWriteFile(target, Buffer.from('hello'));
      assert.equal(result.ok, true);
      const bytes = await fs.readFile(target);
      assert.equal(bytes.toString('utf8'), 'hello');
      const tmp = `${target}.tmp`;
      assert.equal(await pathExists(tmp), false);
    });

    it('creates parent directories', async () => {
      const target = path.join(tmpDir, 'deeply', 'nested', 'dir', 'file.bin');
      const result = await atomicWriteFile(target, Buffer.from([1, 2, 3]));
      assert.equal(result.ok, true);
    });

    it('overwrites an existing file', async () => {
      const target = path.join(tmpDir, 'x.txt');
      await atomicWriteFile(target, Buffer.from('first'));
      const r = await atomicWriteFile(target, Buffer.from('second'));
      assert.equal(r.ok, true);
      const bytes = await fs.readFile(target, 'utf8');
      assert.equal(bytes, 'second');
    });

    it('leaves prior file intact when target path is not writable', async function () {
      // On Windows EACCES semantics differ; this test is meaningful on POSIX.
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const target = path.join(tmpDir, 'protected.txt');
      await atomicWriteFile(target, Buffer.from('prior good'));
      // Make the parent read-only so the rename fails
      const parent = path.dirname(target);
      await fs.chmod(parent, 0o500);
      try {
        const r = await atomicWriteFile(target, Buffer.from('attempted'));
        // The write should fail; the prior good content remains.
        // (Depending on the filesystem this may succeed; if so, test is best-effort.)
        if (!r.ok) {
          const bytes = await fs.readFile(target, 'utf8');
          assert.equal(bytes, 'prior good');
        }
      } finally {
        await fs.chmod(parent, 0o700);
      }
    });
  });

  describe('readFileOrNull', () => {
    it('returns null when file does not exist', async () => {
      const r = await readFileOrNull(path.join(tmpDir, 'missing.txt'));
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value, null);
      }
    });

    it('returns bytes when file exists', async () => {
      const target = path.join(tmpDir, 'present.txt');
      await fs.writeFile(target, 'data');
      const r = await readFileOrNull(target);
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value?.toString('utf8'), 'data');
      }
    });
  });

  describe('readVaultEntry / writeVaultEntry', () => {
    it('writeVaultEntry persists meta + keys, readVaultEntry recovers both', async () => {
      const baseDir = path.join(tmpDir, 'projects');
      const fp = '1234567890abcdef';
      const meta = Buffer.from(JSON.stringify({ version: 1, fingerprint: fp }), 'utf8');
      const keysEnc = Buffer.from('encrypted-payload-bytes', 'utf8');

      const writeResult = await writeVaultEntry(baseDir, fp, meta, keysEnc);
      assert.equal(writeResult.ok, true);

      const readResult = await readVaultEntry(baseDir, fp);
      assert.equal(readResult.ok, true);
      if (Result.isOk(readResult) && readResult.value !== null) {
        assert.deepEqual(Array.from(readResult.value.meta), Array.from(meta));
        assert.deepEqual(Array.from(readResult.value.keys!), Array.from(keysEnc));
        assert.equal(readResult.value.recoveryKeys, null);
      }
    });

    it('readVaultEntry returns null when entry does not exist', async () => {
      const baseDir = path.join(tmpDir, 'projects');
      await fs.mkdir(baseDir, { recursive: true });
      const r = await readVaultEntry(baseDir, 'no-such-fp');
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.equal(r.value, null);
      }
    });

    it('OQ-8: when keys.enc.tmp sibling exists alongside intact keys.enc, both are reported', async () => {
      // The loader (later story) decides which to use; this module reports both.
      const baseDir = path.join(tmpDir, 'projects');
      const fp = 'recoverycase01';
      const dir = path.join(baseDir, fp);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'meta.json'), 'meta');
      await fs.writeFile(path.join(dir, 'keys.enc'), 'primary');
      await fs.writeFile(path.join(dir, 'keys.enc.tmp'), 'recovery');

      const r = await readVaultEntry(baseDir, fp);
      assert.equal(r.ok, true);
      if (Result.isOk(r) && r.value !== null) {
        assert.equal(r.value.keys?.toString('utf8'), 'primary');
        assert.equal(r.value.recoveryKeys?.toString('utf8'), 'recovery');
      }
    });

    it('OQ-8: when only keys.enc.tmp exists (primary missing), recoveryKeys is populated, keys is null', async () => {
      const baseDir = path.join(tmpDir, 'projects');
      const fp = 'tmponly';
      const dir = path.join(baseDir, fp);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'meta.json'), 'meta');
      await fs.writeFile(path.join(dir, 'keys.enc.tmp'), 'orphan-tmp');

      const r = await readVaultEntry(baseDir, fp);
      assert.equal(r.ok, true);
      if (Result.isOk(r) && r.value !== null) {
        assert.equal(r.value.keys, null);
        assert.equal(r.value.recoveryKeys?.toString('utf8'), 'orphan-tmp');
      }
    });
  });

  describe('moveVaultEntry / removeVaultDirectory / listVaultEntries', () => {
    it('moveVaultEntry renames an entry from one base to another', async () => {
      const fromBase = path.join(tmpDir, 'projects');
      const toBase = path.join(tmpDir, 'archive');
      const fp = 'mvtest01';
      await fs.mkdir(path.join(fromBase, fp), { recursive: true });
      await fs.writeFile(path.join(fromBase, fp, 'meta.json'), 'meta');

      const r = await moveVaultEntry(fromBase, toBase, fp);
      assert.equal(r.ok, true);
      assert.equal(await pathExists(path.join(fromBase, fp)), false);
      assert.equal(await pathExists(path.join(toBase, fp, 'meta.json')), true);
    });

    it('moveVaultEntry refuses to overwrite an existing destination', async () => {
      const fromBase = path.join(tmpDir, 'projects');
      const toBase = path.join(tmpDir, 'archive');
      const fp = 'collide01';
      await fs.mkdir(path.join(fromBase, fp), { recursive: true });
      await fs.mkdir(path.join(toBase, fp), { recursive: true });

      const r = await moveVaultEntry(fromBase, toBase, fp);
      assert.equal(r.ok, false);
      // Source remains intact
      assert.equal(await pathExists(path.join(fromBase, fp)), true);
    });

    it('removeVaultDirectory recursively removes the entry directory', async () => {
      const baseDir = path.join(tmpDir, 'archive');
      const fp = 'rmtest01';
      await fs.mkdir(path.join(baseDir, fp, 'nested'), { recursive: true });
      await fs.writeFile(path.join(baseDir, fp, 'keys.enc'), 'data');
      await fs.writeFile(path.join(baseDir, fp, 'nested', 'inner'), 'x');

      const r = await removeVaultDirectory(baseDir, fp);
      assert.equal(r.ok, true);
      assert.equal(await pathExists(path.join(baseDir, fp)), false);
    });

    it('removeVaultDirectory is idempotent (succeeds when target does not exist)', async () => {
      const baseDir = path.join(tmpDir, 'archive');
      const r = await removeVaultDirectory(baseDir, 'never-existed');
      // fs.rm with { force: true } does not error on missing target.
      assert.equal(r.ok, true);
    });

    it('listVaultEntries returns child directory names', async () => {
      const baseDir = path.join(tmpDir, 'projects-list');
      await fs.mkdir(path.join(baseDir, 'fp1'), { recursive: true });
      await fs.mkdir(path.join(baseDir, 'fp2'), { recursive: true });
      await fs.writeFile(path.join(baseDir, 'a-stray-file'), 'x');

      const r = await listVaultEntries(baseDir);
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.deepEqual([...r.value].sort(), ['fp1', 'fp2']);
      }
    });

    it('listVaultEntries returns empty array when base does not exist', async () => {
      const r = await listVaultEntries(path.join(tmpDir, 'never-created'));
      assert.equal(r.ok, true);
      if (Result.isOk(r)) {
        assert.deepEqual([...r.value], []);
      }
    });
  });

  // TODO: integration tests for crash-mid-rename simulation. Requires injecting
  // a controlled failure between rename + parent-fsync. Deferred to integration
  // test suite.
});
