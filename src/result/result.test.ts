import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { Result } from './result';

describe('Result', () => {
  it('ok branch carries the value', () => {
    const r = Result.ok(42);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value, 42);
    }
  });

  it('err branch carries the error', () => {
    const r = Result.err({ kind: 'crypto.wrong-passphrase' as const });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'crypto.wrong-passphrase');
    }
  });

  it('isOk narrows the type', () => {
    const r: Result<number, string> = Result.ok(7);
    if (Result.isOk(r)) {
      assert.equal(r.value, 7);
    } else {
      assert.fail('expected ok branch');
    }
  });

  it('isErr narrows the type', () => {
    const r: Result<number, string> = Result.err('boom');
    if (Result.isErr(r)) {
      assert.equal(r.error, 'boom');
    } else {
      assert.fail('expected err branch');
    }
  });

  // TODO: extend with helper combinators (map, mapErr, andThen) if/when added.
});
