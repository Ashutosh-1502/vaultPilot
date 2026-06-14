import * as assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, before, after, beforeEach } from 'mocha';

import { resolveFingerprint } from './re-link';
import { computeFingerprint } from './compute';
import { normalizeRemoteUrl } from './url-normalize';

/**
 * re-link.test.ts exercises the priority chain against real filesystem
 * fixtures. We create temporary workspaces with various combinations of git
 * remote / package.json / pyproject.toml / nothing, and verify the resolver
 * picks the correct anchor in FR-19's strict priority order.
 */
describe('resolveFingerprint', () => {
  let tmpDir = '';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-fp-test-'));
  });

  after(async () => {
    if (tmpDir !== '') {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    const entries = await fs.readdir(tmpDir);
    for (const e of entries) {
      await fs.rm(path.join(tmpDir, e), { recursive: true, force: true });
    }
  });

  async function makeWorkspace(name: string): Promise<string> {
    const ws = path.join(tmpDir, name);
    await fs.mkdir(ws, { recursive: true });
    return ws;
  }

  function initGitRepo(ws: string, remoteUrl: string): void {
    execSync('git init -q', { cwd: ws });
    execSync(`git remote add origin ${remoteUrl}`, { cwd: ws });
  }

  it('Priority 1: git remote → source = git-remote, canonicalRemoteUrl populated', async () => {
    const ws = await makeWorkspace('with-git');
    initGitRepo(ws, 'git@github.com:user/repo.git');

    const r = await resolveFingerprint(ws);
    assert.equal(r.source, 'git-remote');
    assert.equal(r.canonicalRemoteUrl, 'github.com/user/repo');
    assert.equal(r.fingerprint, computeFingerprint('github.com/user/repo'));
  });

  it('Priority 2: no git remote, but package.json name → source = manifest-name', async () => {
    const ws = await makeWorkspace('with-package-json');
    await fs.writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'my-cool-project' }),
    );

    const r = await resolveFingerprint(ws);
    assert.equal(r.source, 'manifest-name');
    assert.equal(r.manifestName, 'my-cool-project');
    assert.equal(r.fingerprint, computeFingerprint('my-cool-project'));
  });

  it('Priority 2: pyproject.toml [project] name when no package.json', async () => {
    const ws = await makeWorkspace('with-pyproject');
    await fs.writeFile(
      path.join(ws, 'pyproject.toml'),
      '[project]\nname = "my-python-pkg"\nversion = "0.1.0"\n',
    );

    const r = await resolveFingerprint(ws);
    assert.equal(r.source, 'manifest-name');
    assert.equal(r.manifestName, 'my-python-pkg');
  });

  it('Priority 3: no git, no manifest → source = absolute-path', async () => {
    const ws = await makeWorkspace('bare');
    const r = await resolveFingerprint(ws);
    assert.equal(r.source, 'absolute-path');
    assert.equal(r.fingerprint, computeFingerprint(ws));
  });

  it('FR-19 strict priority: git remote wins even when package.json exists', async () => {
    const ws = await makeWorkspace('both-git-and-pkg');
    initGitRepo(ws, 'https://github.com/team/svc.git');
    await fs.writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'this-name-should-be-ignored' }),
    );

    const r = await resolveFingerprint(ws);
    assert.equal(r.source, 'git-remote');
    assert.equal(r.canonicalRemoteUrl, 'github.com/team/svc');
  });

  it('FR-46 invariant: same canonical URL → same fingerprint across clone forms', async () => {
    const wsA = await makeWorkspace('clone-a');
    const wsB = await makeWorkspace('clone-b');
    initGitRepo(wsA, 'git@github.com:user/repo.git');
    initGitRepo(wsB, 'https://github.com/user/repo'); // different form, same canonical

    const a = await resolveFingerprint(wsA);
    const b = await resolveFingerprint(wsB);
    assert.equal(a.fingerprint, b.fingerprint);
  });

  it('FR-46 fork: different remote URL → different fingerprint', async () => {
    const wsUp = await makeWorkspace('upstream');
    const wsFork = await makeWorkspace('fork');
    initGitRepo(wsUp, 'https://github.com/upstream-org/repo.git');
    initGitRepo(wsFork, 'https://github.com/my-fork/repo.git');

    const up = await resolveFingerprint(wsUp);
    const fork = await resolveFingerprint(wsFork);
    assert.notEqual(up.fingerprint, fork.fingerprint);
  });

  it('package.json with empty name falls through to next priority', async () => {
    const ws = await makeWorkspace('empty-pkg-name');
    await fs.writeFile(path.join(ws, 'package.json'), JSON.stringify({ name: '' }));
    const r = await resolveFingerprint(ws);
    // Should fall through to absolute-path since name is empty
    assert.equal(r.source, 'absolute-path');
  });

  it('malformed package.json falls through to next priority', async () => {
    const ws = await makeWorkspace('bad-pkg');
    await fs.writeFile(path.join(ws, 'package.json'), '{not valid json');
    const r = await resolveFingerprint(ws);
    assert.equal(r.source, 'absolute-path');
  });

  it('integration with normalizeRemoteUrl: SSH and HTTPS clones of the same repo collide on fingerprint', async () => {
    // Sanity check that the resolver chains url-normalize correctly.
    const canonical1 = normalizeRemoteUrl('git@github.com:user/repo.git');
    const canonical2 = normalizeRemoteUrl('https://github.com/user/repo.git');
    assert.equal(canonical1, canonical2);
    assert.equal(computeFingerprint(canonical1), computeFingerprint(canonical2));
  });

  // TODO: test for git not installed on PATH (mock execFile to throw ENOENT).
  // TODO: test for git repo without `origin` remote (initGitRepo without add remote).
});
