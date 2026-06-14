import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { scorePassphrase } from './strength-meter';

describe('scorePassphrase', () => {
  it('empty input is weak', () => {
    const r = scorePassphrase('');
    assert.equal(r.level, 'weak');
    assert.equal(r.score, 0);
  });

  it('short input is weak regardless of diversity', () => {
    const r = scorePassphrase('Aa1!Aa1!'); // 8 chars, 4 classes
    assert.equal(r.level, 'weak');
  });

  it('inputs below 12 characters are always weak per FR-41 / brief assumption', () => {
    for (let len = 1; len < 12; len++) {
      const r = scorePassphrase('a'.repeat(len));
      assert.equal(r.level, 'weak', `length ${String(len)} should be weak`);
    }
  });

  it('12-char single-class input is OK (length × 1)', () => {
    const r = scorePassphrase('aaaaaaaaaaaa'); // 12 chars, 1 class → score 12
    assert.equal(r.level, 'ok');
  });

  it('long high-diversity input is strong', () => {
    const r = scorePassphrase('Correct-Horse-Battery-Staple-99!'); // 32 chars, 4 classes
    assert.equal(r.level, 'strong');
  });

  it('moderately long with diverse classes reaches strong threshold', () => {
    // 16 chars × (1 + 0.25*3) = 16 × 1.75 = 28 → strong
    const r = scorePassphrase('Abcdefgh1234!@#$');
    assert.equal(r.level, 'strong');
  });

  it('exactly 20 score boundary is strong', () => {
    // 20 chars, single class → score = 20 → strong
    const r = scorePassphrase('a'.repeat(20));
    assert.equal(r.level, 'strong');
  });

  it('score increases with character-class diversity', () => {
    const single = scorePassphrase('a'.repeat(16));
    const diverse = scorePassphrase('Aa1!'.repeat(4));
    assert.ok(diverse.score > single.score);
  });

  it('does NOT enforce any minimum length (FR-41)', () => {
    // The function just classifies; the UI is responsible for not enforcing a minimum.
    // This test pins the no-enforcement contract.
    const r = scorePassphrase('x');
    assert.equal(r.level, 'weak');
    // score is computable; no error or throw
    assert.equal(typeof r.score, 'number');
  });
});
