import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { readSettings } from './settings';
import type { VscodeHost } from '../vscode-host';

function makeHost(values: Record<string, unknown>): VscodeHost {
  return {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (values[key] as T | undefined) ?? defaultValue,
    }),
  } as unknown as VscodeHost;
}

describe('readSettings', () => {
  it('returns defaults when no values are configured', () => {
    const s = readSettings(makeHost({}));
    assert.equal(s.clipboardTimeout, 30);
    assert.equal(s.passphraseCacheDuration, 3600);
    assert.equal(s.driveBackupFolderName, 'vaultpilot-backup');
    assert.equal(s.driveBackupEnabled, false);
    assert.equal(s.verboseLogging, false);
  });

  it('returns user-configured values when present', () => {
    const s = readSettings(
      makeHost({
        clipboardTimeout: 60,
        driveBackupEnabled: true,
        verboseLogging: true,
      }),
    );
    assert.equal(s.clipboardTimeout, 60);
    assert.equal(s.driveBackupEnabled, true);
    assert.equal(s.verboseLogging, true);
    // unchanged values fall back to defaults
    assert.equal(s.passphraseCacheDuration, 3600);
  });
});
