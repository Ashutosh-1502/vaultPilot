import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import {
  CryptoError,
  DriveError,
  FilesystemError,
  KeychainError,
  VaultFormatError,
} from './errors';

describe('VaultError taxonomy', () => {
  it('CryptoError factories produce discriminated kinds', () => {
    assert.equal(CryptoError.decryptFailed().kind, 'crypto.decrypt-failed');
    assert.equal(CryptoError.kdfTimeout().kind, 'crypto.kdf-timeout');
    assert.equal(CryptoError.wrongPassphrase().kind, 'crypto.wrong-passphrase');
  });

  it('KeychainError factories produce discriminated kinds', () => {
    assert.equal(KeychainError.unavailable().kind, 'keychain.unavailable');
    assert.equal(KeychainError.evicted().kind, 'keychain.evicted');
    assert.equal(KeychainError.writeFailed().kind, 'keychain.write-failed');
  });

  it('DriveError factories produce discriminated kinds', () => {
    assert.equal(DriveError.authExpired().kind, 'drive.auth-expired');
    assert.equal(DriveError.networkFailed().kind, 'drive.network-failed');
    assert.equal(DriveError.quotaExceeded().kind, 'drive.quota-exceeded');
    assert.equal(DriveError.uploadInterrupted().kind, 'drive.upload-interrupted');
  });

  it('DriveError.networkFailed accepts an optional cause', () => {
    const err = DriveError.networkFailed('ECONNRESET');
    assert.equal(err.kind, 'drive.network-failed');
    if (err.kind === 'drive.network-failed') {
      assert.equal(err.cause, 'ECONNRESET');
    }
  });

  it('VaultFormatError carries structured payload for version-unsupported', () => {
    const err = VaultFormatError.versionUnsupported(99);
    assert.equal(err.kind, 'format.version-unsupported');
    if (err.kind === 'format.version-unsupported') {
      assert.equal(err.foundVersion, 99);
    }
  });

  it('FilesystemError carries the path it failed on', () => {
    const err = FilesystemError.permissionDenied('/tmp/nope');
    assert.equal(err.kind, 'fs.permission-denied');
    if (err.kind === 'fs.permission-denied') {
      assert.equal(err.path, '/tmp/nope');
    }
  });

  // TODO: when more subtypes are added, append constructor coverage here.
});
