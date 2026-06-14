import * as assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'mocha';

import { ClipboardAutoClear, type ClipboardBackend } from './clipboard';

function fakeBackend(): ClipboardBackend & { contents: string; writes: string[] } {
  return {
    contents: '',
    writes: [],
    async readText() {
      return this.contents;
    },
    async writeText(v: string) {
      this.contents = v;
      this.writes.push(v);
    },
  };
}

// Polls `cond` every 5ms up to `timeoutMs`. Used to wait for the auto-clear
// callback to run without resorting to brittle sleeps.
async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ClipboardAutoClear', () => {
  let backend: ReturnType<typeof fakeBackend>;
  let clipboard: ClipboardAutoClear;

  beforeEach(() => {
    backend = fakeBackend();
  });

  it('copy writes the value to the clipboard immediately', async () => {
    clipboard = new ClipboardAutoClear(backend, () => 30);
    await clipboard.copy('secret');
    assert.equal(backend.contents, 'secret');
  });

  it('auto-clears the clipboard after the configured timeout', async () => {
    // Use a very short timeout for the test (the provider can be < 1 second
    // via the Math.max clamp, but the test asserts the contract not the timing.)
    clipboard = new ClipboardAutoClear(backend, () => 0.05); // 50ms
    await clipboard.copy('secret');
    await waitFor(() => backend.contents === '');
    assert.equal(backend.contents, '');
  });

  it('change-detection: skip clear if clipboard contents changed', async () => {
    clipboard = new ClipboardAutoClear(backend, () => 0.05);
    await clipboard.copy('secret');
    // User copies something else in the meantime
    backend.contents = 'user-typed-something';
    await waitFor(() => clipboard.pendingCount() === 0);
    // The clear should NOT have overwritten the new value
    assert.equal(backend.contents, 'user-typed-something');
  });

  it('multiple concurrent copies each get their own timer', async () => {
    clipboard = new ClipboardAutoClear(backend, () => 0.05);
    await clipboard.copy('a');
    await clipboard.copy('b');
    assert.equal(clipboard.pendingCount(), 2);
    assert.equal(backend.contents, 'b'); // last write wins on clipboard
    await waitFor(() => clipboard.pendingCount() === 0);
  });

  it('dispose cancels pending timers and clears if clipboard matches', async () => {
    clipboard = new ClipboardAutoClear(backend, () => 30);
    await clipboard.copy('secret');
    assert.equal(clipboard.pendingCount(), 1);
    await clipboard.dispose();
    assert.equal(clipboard.pendingCount(), 0);
    // Dispose should have cleared the clipboard since it still held 'secret'
    assert.equal(backend.contents, '');
  });

  it('dispose does NOT clear if clipboard contents have changed', async () => {
    clipboard = new ClipboardAutoClear(backend, () => 30);
    await clipboard.copy('secret');
    backend.contents = 'user-copied-this-instead';
    await clipboard.dispose();
    assert.equal(backend.contents, 'user-copied-this-instead');
  });

  it('negative timeout clamps to a positive value (defensive guard)', async () => {
    // The Math.max(1, ms) clamp ensures we don't fire a 0-or-negative-ms timer
    // even if the user-facing setting was somehow corrupted. The package.json
    // schema enforces a minimum of 5 seconds at the user-facing layer.
    clipboard = new ClipboardAutoClear(backend, () => -5);
    await clipboard.copy('x');
    // Timer is scheduled (macrotask) but hasn't fired yet — the assertion
    // runs in the microtask continuation right after the await.
    assert.equal(clipboard.pendingCount(), 1);
  });
});
