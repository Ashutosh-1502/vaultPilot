import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'mocha';

import { normalizeRemoteUrl } from './url-normalize';

interface CorpusFile {
  cases: Array<[string, string]>;
  idempotencyCases: string[];
}

const corpusPath = path.join(__dirname, '..', '..', 'test', 'fixtures', 'git-remote-url-cases.json');
const corpus: CorpusFile = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as CorpusFile;

describe('normalizeRemoteUrl', () => {
  it('corpus is at least 30 cases (FR-45 acceptance)', () => {
    assert.ok(
      corpus.cases.length >= 30,
      `corpus has only ${String(corpus.cases.length)} cases; FR-45 AC requires ≥ 30`,
    );
  });

  for (const [input, expected] of corpus.cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizeRemoteUrl(input), expected);
    });
  }

  describe('FR-45 canonical-equivalence: 5 forms map to the same fingerprint anchor', () => {
    const equivalent = [
      'git@github.com:user/repo.git',
      'https://github.com/user/repo.git',
      'https://github.com/user/repo',
      'ssh://git@github.com/user/repo.git',
      'https://GitHub.com/User/Repo.git/',
    ];
    it('all canonicalize to github.com/user/repo', () => {
      const canonicals = equivalent.map(normalizeRemoteUrl);
      for (const c of canonicals) {
        assert.equal(c, 'github.com/user/repo');
      }
    });
  });

  describe('idempotency', () => {
    for (const canonical of corpus.idempotencyCases) {
      it(`normalize(${JSON.stringify(canonical)}) is unchanged`, () => {
        assert.equal(normalizeRemoteUrl(canonical), canonical);
      });
    }
  });

  describe('FR-46 fork handling', () => {
    it('fork and upstream with different remote URLs produce different canonical forms', () => {
      const upstream = normalizeRemoteUrl('https://github.com/upstream-org/repo.git');
      const fork = normalizeRemoteUrl('https://github.com/my-fork/repo.git');
      assert.notEqual(upstream, fork);
    });
  });
});
