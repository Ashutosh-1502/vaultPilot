import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { looksSecret, parseEnvFile } from './env-parser';

describe('parseEnvFile', () => {
  it('parses simple KEY=value lines', () => {
    const entries = parseEnvFile('FOO=bar\nBAZ=qux');
    assert.deepEqual(
      entries.map((e) => ({ key: e.key, value: e.value })),
      [
        { key: 'FOO', value: 'bar' },
        { key: 'BAZ', value: 'qux' },
      ],
    );
  });

  it('strips double-quoted values', () => {
    const entries = parseEnvFile('FOO="hello world"');
    assert.equal(entries[0]?.value, 'hello world');
  });

  it('strips single-quoted values', () => {
    const entries = parseEnvFile("FOO='hello world'");
    assert.equal(entries[0]?.value, 'hello world');
  });

  it('handles export prefix', () => {
    const entries = parseEnvFile('export FOO=bar');
    assert.equal(entries[0]?.key, 'FOO');
    assert.equal(entries[0]?.value, 'bar');
  });

  it('ignores comments and blank lines', () => {
    const entries = parseEnvFile('# top comment\n\nFOO=bar\n# another comment\nBAZ=qux\n');
    assert.equal(entries.length, 2);
  });

  it('skips empty values', () => {
    const entries = parseEnvFile('EMPTY=\nFOO=bar\nALSO_EMPTY=""');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.key, 'FOO');
  });

  it('preserves special characters in values', () => {
    const entries = parseEnvFile('URL=https://user:pass@host.com/path?q=1');
    assert.equal(entries[0]?.value, 'https://user:pass@host.com/path?q=1');
  });

  it('records 1-based line numbers', () => {
    const entries = parseEnvFile('# comment line 1\n\nFOO=bar\nBAZ=qux');
    assert.equal(entries[0]?.lineNumber, 3);
    assert.equal(entries[1]?.lineNumber, 4);
  });

  it('handles CRLF line endings', () => {
    const entries = parseEnvFile('FOO=bar\r\nBAZ=qux');
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.value, 'qux');
  });

  it('rejects keys starting with a digit', () => {
    const entries = parseEnvFile('1FOO=bar\nFOO=bar');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.key, 'FOO');
  });

  it('parses a realistic .env corpus', () => {
    const content = `
      # MongoDB Configuration
      MONGO_URI=mongodb+srv://user:pass@cluster0.example.net/?appName=Cluster0

      # JWT Secret
      SECRET_KEY=this_is_the_budgetiq_data_which_need_128x_@@@@_yiea

      # AWS S3 Configuration
      AWS_REGION=ap-south-1
      AWS_ACCESS_KEY_ID=AKIAEXAMPLE
      AWS_SECRET_ACCESS_KEY=abcdef1234567890
      AWS_BUCKET_NAME=my-bucket
    `;
    const entries = parseEnvFile(content);
    assert.equal(entries.length, 6);
    assert.equal(entries[0]?.key, 'MONGO_URI');
    assert.equal(entries[3]?.value, 'AKIAEXAMPLE');
  });
});

describe('looksSecret heuristic', () => {
  it('returns true for keys containing secret keywords', () => {
    assert.equal(looksSecret('MONGO_URI'), true);
    assert.equal(looksSecret('SECRET_KEY'), true);
    assert.equal(looksSecret('AWS_ACCESS_KEY_ID'), true);
    assert.equal(looksSecret('GITHUB_TOKEN'), true);
    assert.equal(looksSecret('STRIPE_API_KEY'), true);
    assert.equal(looksSecret('DB_PASSWORD'), true);
    assert.equal(looksSecret('JWT_AUTH'), true);
  });

  it('returns false for non-secret-looking keys', () => {
    assert.equal(looksSecret('AWS_REGION'), false);
    assert.equal(looksSecret('AWS_BUCKET_NAME'), false);
    assert.equal(looksSecret('R2_BUCKET'), false);
    assert.equal(looksSecret('NODE_ENV'), false);
    assert.equal(looksSecret('PORT'), false);
  });

  it('is case-insensitive', () => {
    assert.equal(looksSecret('mongo_uri'), true);
    assert.equal(looksSecret('Mongo_Uri'), true);
  });
});
