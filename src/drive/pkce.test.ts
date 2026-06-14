import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { computeCodeChallenge, generateCodeVerifier, generateState } from './pkce';

describe('PKCE primitives', () => {
  describe('generateCodeVerifier', () => {
    it('produces a 43-char base64url string', () => {
      const v = generateCodeVerifier();
      assert.equal(v.length, 43);
      assert.match(v, /^[A-Za-z0-9_-]+$/);
    });

    it('is non-deterministic (random)', () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      assert.notEqual(a, b);
    });

    it('contains no padding characters per RFC 7636', () => {
      const v = generateCodeVerifier();
      assert.ok(!v.includes('='));
      assert.ok(!v.includes('+'));
      assert.ok(!v.includes('/'));
    });
  });

  describe('computeCodeChallenge', () => {
    it('returns a base64url string of the SHA-256 hash', () => {
      const c = computeCodeChallenge('test-verifier');
      // 32-byte hash → 43 base64url chars without padding
      assert.equal(c.length, 43);
      assert.match(c, /^[A-Za-z0-9_-]+$/);
    });

    it('is deterministic for identical input', () => {
      const a = computeCodeChallenge('verifier-xyz');
      const b = computeCodeChallenge('verifier-xyz');
      assert.equal(a, b);
    });

    it('differs for different verifiers', () => {
      const a = computeCodeChallenge('verifier-a');
      const b = computeCodeChallenge('verifier-b');
      assert.notEqual(a, b);
    });

    it('matches RFC 7636 §4.2 known vector', () => {
      // RFC 7636 Appendix B test vector.
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      assert.equal(computeCodeChallenge(verifier), expected);
    });
  });

  describe('generateState', () => {
    it('produces a 22-char base64url string', () => {
      const s = generateState();
      assert.equal(s.length, 22);
      assert.match(s, /^[A-Za-z0-9_-]+$/);
    });

    it('is non-deterministic', () => {
      assert.notEqual(generateState(), generateState());
    });
  });
});
