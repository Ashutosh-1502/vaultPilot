import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { mergeForImport } from './env-import';
import type { Credential } from './credential';
import type { EnvEntry } from './env-parser';

const NOW = '2026-06-13T00:00:00Z';

function entry(key: string, value: string): EnvEntry {
  return { key, value, lineNumber: 1 };
}

describe('mergeForImport', () => {
  it('creates new credentials for keys that do not exist', () => {
    const { next, summary } = mergeForImport([], [entry('FOO', 'bar')], NOW);
    assert.equal(summary.created, 1);
    assert.equal(summary.overwritten, 0);
    assert.equal(next.length, 1);
    assert.equal(next[0]?.name, 'FOO');
    assert.equal(next[0]?.type, 'env-var-name');
    if (next[0]?.type === 'env-var-name') {
      assert.equal(next[0].value, 'bar');
    }
  });

  it('overwrites an existing credential with matching name', () => {
    const existing: Credential[] = [
      {
        id: 'uuid-1',
        name: 'MONGO_URI',
        type: 'string',
        value: 'old-value',
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-01T00:00:00Z',
      },
    ];
    const { next, summary } = mergeForImport(existing, [entry('MONGO_URI', 'new-value')], NOW);
    assert.equal(summary.created, 0);
    assert.equal(summary.overwritten, 1);
    assert.equal(next.length, 1);
    assert.equal(next[0]?.id, 'uuid-1');
    assert.equal(next[0]?.type, 'env-var-name');
    if (next[0]?.type === 'env-var-name') {
      assert.equal(next[0].value, 'new-value');
    }
    assert.equal(next[0]?.created, '2025-01-01T00:00:00Z');
    assert.equal(next[0]?.updated, NOW);
  });

  it('preserves notes when overwriting', () => {
    const existing: Credential[] = [
      {
        id: 'uuid-1',
        name: 'MONGO_URI',
        type: 'string',
        value: 'old-value',
        notes: 'Production cluster',
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-01T00:00:00Z',
      },
    ];
    const { next } = mergeForImport(existing, [entry('MONGO_URI', 'new-value')], NOW);
    assert.equal(next[0]?.notes, 'Production cluster');
  });

  it('mixes creates and overwrites in a single batch', () => {
    const existing: Credential[] = [
      {
        id: 'uuid-1',
        name: 'EXISTING_KEY',
        type: 'api-key',
        value: 'old',
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-01T00:00:00Z',
      },
    ];
    const { next, summary } = mergeForImport(
      existing,
      [entry('EXISTING_KEY', 'new'), entry('NEW_KEY', 'fresh'), entry('ANOTHER_NEW', 'also-fresh')],
      NOW,
    );
    assert.equal(summary.created, 2);
    assert.equal(summary.overwritten, 1);
    assert.equal(next.length, 3);
  });

  it('forces type to env-var-name on overwrite', () => {
    const existing: Credential[] = [
      {
        id: 'uuid-1',
        name: 'STRIPE_KEY',
        type: 'api-key',
        value: 'sk_old',
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-01T00:00:00Z',
      },
    ];
    const { next } = mergeForImport(existing, [entry('STRIPE_KEY', 'sk_new')], NOW);
    assert.equal(next[0]?.type, 'env-var-name');
  });

  it('handles same-name pair-type by overwriting (type becomes env-var-name)', () => {
    const existing: Credential[] = [
      {
        id: 'uuid-1',
        name: 'AWS_CREDS',
        type: 'user/password-pair',
        fields: {
          fieldA: { label: 'access_key_id', value: 'AKIA1' },
          fieldB: { label: 'secret_access_key', value: 'SKID' },
        },
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-01T00:00:00Z',
      },
    ];
    const { next, summary } = mergeForImport(existing, [entry('AWS_CREDS', 'replaced')], NOW);
    assert.equal(summary.overwritten, 1);
    assert.equal(next[0]?.type, 'env-var-name');
    if (next[0]?.type === 'env-var-name') {
      assert.equal(next[0].value, 'replaced');
    }
  });

  it('only matches the FIRST same-named existing credential', () => {
    // VaultPilot allows duplicate names. mergeForImport overwrites only one.
    const existing: Credential[] = [
      {
        id: 'uuid-1',
        name: 'API_KEY',
        type: 'string',
        value: 'first',
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-01T00:00:00Z',
      },
      {
        id: 'uuid-2',
        name: 'API_KEY',
        type: 'string',
        value: 'second',
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-01T00:00:00Z',
      },
    ];
    const { next, summary } = mergeForImport(existing, [entry('API_KEY', 'imported')], NOW);
    assert.equal(summary.overwritten, 1);
    assert.equal(summary.created, 0);
    assert.equal(next.length, 2);
    // First one is overwritten
    if (next[0]?.type === 'env-var-name') {
      assert.equal(next[0].value, 'imported');
    }
    // Second one is untouched
    if (next[1]?.type === 'string') {
      assert.equal(next[1].value, 'second');
    }
  });

  it('returns empty result for empty input', () => {
    const { next, summary } = mergeForImport([], [], NOW);
    assert.equal(summary.created, 0);
    assert.equal(summary.overwritten, 0);
    assert.equal(next.length, 0);
  });
});
