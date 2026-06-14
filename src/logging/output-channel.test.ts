import * as assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'mocha';

import { createLogger } from './output-channel';
import type { VscodeHost } from '../vscode-host';

interface FakeChannel {
  lines: string[];
  appendLine(line: string): void;
  dispose(): void;
  disposed: boolean;
}

function fakeChannel(): FakeChannel {
  const lines: string[] = [];
  return {
    lines,
    disposed: false,
    appendLine(line: string): void {
      lines.push(line);
    },
    dispose(): void {
      this.disposed = true;
    },
  };
}

function fakeHost(channel: FakeChannel): VscodeHost {
  return {
    createOutputChannel: () => channel as unknown as ReturnType<VscodeHost['createOutputChannel']>,
  } as unknown as VscodeHost;
}

describe('OutputChannel logger', () => {
  let channel: FakeChannel;

  beforeEach(() => {
    channel = fakeChannel();
  });

  it('info/warn/error always log', () => {
    const log = createLogger(fakeHost(channel), () => false);
    log.info('hi');
    log.warn('uh');
    log.error('no');
    assert.equal(channel.lines.length, 3);
    assert.match(channel.lines[0]!, /INFO  hi$/);
    assert.match(channel.lines[1]!, /WARN  uh$/);
    assert.match(channel.lines[2]!, /ERROR no$/);
  });

  it('verbose suppresses output when disabled', () => {
    const log = createLogger(fakeHost(channel), () => false);
    log.verbose('debug');
    assert.equal(channel.lines.length, 0);
  });

  it('verbose emits when enabled', () => {
    const log = createLogger(fakeHost(channel), () => true);
    log.verbose('debug');
    assert.equal(channel.lines.length, 1);
    assert.match(channel.lines[0]!, /DEBUG debug$/);
  });

  it('verbose flag is re-evaluated per call', () => {
    let enabled = false;
    const log = createLogger(fakeHost(channel), () => enabled);
    log.verbose('a');
    enabled = true;
    log.verbose('b');
    enabled = false;
    log.verbose('c');
    assert.equal(channel.lines.length, 1);
    assert.match(channel.lines[0]!, /DEBUG b$/);
  });

  it('dispose() releases the underlying channel', () => {
    const log = createLogger(fakeHost(channel), () => false);
    log.dispose();
    assert.equal(channel.disposed, true);
  });

  // Compile-time check (no runtime assertion): the Logger interface accepts only
  // `string` arguments. Attempting `log.info({ secret: 'X' } as any)` is rejected
  // by TypeScript without the cast. This guard prevents accidental secret logging.
});
