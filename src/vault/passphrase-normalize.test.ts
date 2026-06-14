import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { normalizePassphrase } from './passphrase-normalize';

describe('normalizePassphrase', () => {
  it('returns a UTF-8 Buffer of the input string', () => {
    const buf = normalizePassphrase('hello');
    assert.equal(buf.toString('utf8'), 'hello');
  });

  it('strips leading and trailing whitespace', () => {
    const buf = normalizePassphrase('   secret   ');
    assert.equal(buf.toString('utf8'), 'secret');
  });

  it('produces identical Buffer for NFC and NFD inputs of the same visible string', () => {
    // "é" can be a single code point (NFC: U+00E9) or "e" + combining acute (NFD: U+0065 U+0301).
    const nfc = 'café';
    const nfd = 'café';
    const bufNfc = normalizePassphrase(nfc);
    const bufNfd = normalizePassphrase(nfd);
    assert.deepEqual(Array.from(bufNfc), Array.from(bufNfd));
  });

  it('preserves zero-width characters (correctly distinguishes passphrases)', () => {
    // ZERO WIDTH SPACE (U+200B) is NOT in JavaScript's whitespace set, so
    // String.prototype.trim() preserves it. This is the correct security
    // behavior: a passphrase with embedded ZWSP differs from one without,
    // so the derived keys must also differ. (If we silently stripped ZWSP,
    // an attacker could craft a confusable passphrase that decrypts the
    // user's vault.)
    const withZwsp = normalizePassphrase('​​secret​');
    const withoutZwsp = normalizePassphrase('secret');
    assert.notDeepEqual(Array.from(withZwsp), Array.from(withoutZwsp));
  });

  it('trims standard whitespace (spaces, tabs, newlines) at the boundary', () => {
    const trimmed = normalizePassphrase('   secret\t\n');
    assert.equal(trimmed.toString('utf8'), 'secret');
  });

  it('preserves internal Unicode characters', () => {
    const buf = normalizePassphrase('🔐héllo');
    assert.equal(buf.toString('utf8'), '🔐héllo'.normalize('NFC'));
  });

  it('empty string after trim yields empty Buffer', () => {
    const buf = normalizePassphrase('   ');
    assert.equal(buf.length, 0);
  });

  // TODO: cross-platform parity test — running on macOS, Windows, Linux should
  // produce identical Buffer for the same visible passphrase. Validated in CI
  // via the matrix build (when matrix is added to ci.yml).
});
