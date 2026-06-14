/**
 * Clipboard with auto-clear (FR-26).
 *
 * Story 1.12 — single-click copy writes a credential value to the system
 * clipboard, then schedules an auto-clear after `clipboardTimeout` seconds.
 * At fire time, the clear is change-detection-aware: if the user copied
 * something else in the interim, our clear is skipped so we don't overwrite
 * unrelated content.
 *
 * NFR-1: on extension deactivate, any pending timers are cancelled and the
 * clipboard is best-effort cleared if it still holds a tracked value.
 */

export interface ClipboardBackend {
  readText(): PromiseLike<string>;
  writeText(value: string): PromiseLike<void>;
}

interface PendingClear {
  readonly value: string;
  readonly timer: NodeJS.Timeout;
}

export class ClipboardAutoClear {
  private readonly pending = new Set<PendingClear>();

  constructor(
    private readonly backend: ClipboardBackend,
    private readonly timeoutSecondsProvider: () => number,
  ) {}

  /**
   * Write `value` to the clipboard and schedule a clear after the configured
   * timeout. The clear only fires if the clipboard still equals `value` at
   * timer-fire time (FR-26 change-detection).
   */
  async copy(value: string): Promise<void> {
    await this.backend.writeText(value);

    // Clamp the resulting millisecond value to at least 1ms to avoid
    // pathological "fire immediately" timers from misconfigured settings.
    // (The user-facing setting is in seconds with a `minimum: 5` schema in
    // package.json, so this is a defensive guard.)
    const timeoutMs = Math.max(1, this.timeoutSecondsProvider() * 1000);
    const entry: PendingClear = {
      value,
      timer: setTimeout(() => {
        void this.fireClear(entry);
      }, timeoutMs),
    };
    this.pending.add(entry);
  }

  private async fireClear(entry: PendingClear): Promise<void> {
    this.pending.delete(entry);
    try {
      const current = await this.backend.readText();
      if (current === entry.value) {
        await this.backend.writeText('');
      }
    } catch {
      // best-effort
    }
  }

  /**
   * Cancel pending clear timers and best-effort clear the clipboard if it
   * still holds a tracked value. Called from `extension.deactivate()`.
   */
  async dispose(): Promise<void> {
    const entries = Array.from(this.pending);
    for (const e of entries) {
      clearTimeout(e.timer);
    }
    this.pending.clear();
    try {
      const current = await this.backend.readText();
      if (entries.some((e) => e.value === current)) {
        await this.backend.writeText('');
      }
    } catch {
      // best-effort
    }
  }

  /** Test helper — current number of pending clear timers. */
  pendingCount(): number {
    return this.pending.size;
  }
}
