import type { VscodeHost } from '../vscode-host';

/**
 * Single OutputChannel logger for VaultPilot.
 *
 * Story 1.3 — NFR-4 compliance: the channel is never persisted to disk and
 * exposes no API surface that accepts secrets. The method signatures take
 * `string` only — there is no overload for `Buffer`, `Credential`, or any
 * structured type that could carry a passphrase, derived key, or credential
 * value. This is intentional compile-time protection.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  verbose(message: string): void;
  dispose(): void;
}

const CHANNEL_NAME = 'VaultPilot';

export function createLogger(host: VscodeHost, verboseEnabled: () => boolean): Logger {
  const channel = host.createOutputChannel(CHANNEL_NAME);
  const stamp = (): string => new Date().toISOString();

  return {
    info(message: string): void {
      channel.appendLine(`[${stamp()}] INFO  ${message}`);
    },
    warn(message: string): void {
      channel.appendLine(`[${stamp()}] WARN  ${message}`);
    },
    error(message: string): void {
      channel.appendLine(`[${stamp()}] ERROR ${message}`);
    },
    verbose(message: string): void {
      if (verboseEnabled()) {
        channel.appendLine(`[${stamp()}] DEBUG ${message}`);
      }
    },
    dispose(): void {
      channel.dispose();
    },
  };
}
