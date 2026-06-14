import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { withZeroedBuffer, withZeroedBufferAsync, zeroBuffer } from './memory-zero';

describe('memory-zero', () => {
  it('zeroBuffer zeros every byte of a Buffer', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    zeroBuffer(buf);
    for (let i = 0; i < buf.length; i++) {
      assert.equal(buf[i], 0);
    }
  });

  it('zeroBuffer zeros a Uint8Array', () => {
    const arr = new Uint8Array([9, 9, 9]);
    zeroBuffer(arr);
    assert.deepEqual(Array.from(arr), [0, 0, 0]);
  });

  it('withZeroedBuffer returns fn result and zeros the buffer', () => {
    const buf = Buffer.from('secret');
    const result = withZeroedBuffer(buf, (b) => b.toString('utf8'));
    assert.equal(result, 'secret');
    assert.deepEqual(Array.from(buf), [0, 0, 0, 0, 0, 0]);
  });

  it('withZeroedBuffer zeros even when fn throws', () => {
    const buf = Buffer.from('secret');
    assert.throws(() => {
      withZeroedBuffer(buf, () => {
        throw new Error('boom');
      });
    });
    assert.deepEqual(Array.from(buf), [0, 0, 0, 0, 0, 0]);
  });

  it('withZeroedBufferAsync zeros after async fn resolves', async () => {
    const buf = Buffer.from('xyz');
    const result = await withZeroedBufferAsync(buf, async (b) =>
      Promise.resolve(b.toString('utf8')),
    );
    assert.equal(result, 'xyz');
    assert.deepEqual(Array.from(buf), [0, 0, 0]);
  });

  it('withZeroedBufferAsync zeros after async fn rejects', async () => {
    const buf = Buffer.from('xyz');
    await assert.rejects(
      withZeroedBufferAsync(buf, async () => {
        await Promise.resolve();
        throw new Error('boom');
      }),
    );
    assert.deepEqual(Array.from(buf), [0, 0, 0]);
  });
});
