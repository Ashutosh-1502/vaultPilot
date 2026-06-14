import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { buffersEqual } from './buffers-equal';

describe('buffersEqual', () => {
  it('returns true for identical Buffers', () => {
    const a = Buffer.from('passphrase123');
    const b = Buffer.from('passphrase123');
    assert.equal(buffersEqual(a, b), true);
  });

  it('returns false when contents differ', () => {
    const a = Buffer.from('passphrase123');
    const b = Buffer.from('passphrase124');
    assert.equal(buffersEqual(a, b), false);
  });

  it('returns false when lengths differ', () => {
    const a = Buffer.from('short');
    const b = Buffer.from('shorter');
    assert.equal(buffersEqual(a, b), false);
  });

  it('returns true for two empty Buffers', () => {
    assert.equal(buffersEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
  });

  it('returns false comparing empty to non-empty', () => {
    assert.equal(buffersEqual(Buffer.alloc(0), Buffer.from('x')), false);
  });
});
