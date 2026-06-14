import { randomUUID } from 'node:crypto';

import { Result } from '../result/result';
import type { VaultError } from '../result/errors';
import { CryptoError } from '../result/errors';
import { persistVault } from '../vault/persist';
import type { VaultSession } from '../vault/vault-session';
import type { EnvEntry } from './env-parser';
import type { Credential, EnvVarNameCredential } from './credential';

/**
 * Bulk import of `.env` entries as `env-var-name` credentials.
 *
 * Per the user-confirmed UX:
 *   - Same-name credentials are **overwritten** (preserving id + created,
 *     updating value + type='env-var-name' + updated timestamp).
 *   - New names are appended with fresh UUIDs.
 *   - The whole batch is atomic: ONE re-encrypt + ONE atomic vault write.
 *     If persist fails, the in-memory session state rolls back.
 */

export interface ImportSummary {
  readonly created: number;
  readonly overwritten: number;
}

export async function importEnvEntries(
  session: VaultSession,
  entries: readonly EnvEntry[],
): Promise<Result<ImportSummary, VaultError>> {
  if (entries.length === 0) {
    return Result.ok({ created: 0, overwritten: 0 });
  }

  const credsResult = session.getCredentials();
  if (!credsResult.ok) return credsResult;
  const existing = credsResult.value;

  const { next, summary } = mergeForImport(existing, entries);

  const setResult = session.setCredentials(next);
  if (!setResult.ok) return setResult;

  const persistResult = await persistVault(session);
  if (!persistResult.ok) {
    // Rollback in-memory state to keep session consistent with disk.
    const rollback = session.setCredentials([...existing]);
    if (!rollback.ok) {
      // Couldn't rollback — return the original error.
      return persistResult;
    }
    return persistResult;
  }

  return Result.ok(summary);
}

/**
 * Pure merge logic, exported for unit testing. Produces a new credentials
 * array reflecting the import + a summary.
 *
 * Conflict resolution (overwrite by name):
 *   - If an existing credential has the same `name` as an import entry, its
 *     `value` is replaced; type is forced to `env-var-name` (the type
 *     designed for this case per FR-20 + PRD addendum); `updated` is bumped.
 *     If the existing credential already had the same value, it still counts
 *     as overwritten (idempotency over correctness here keeps the summary
 *     honest about "how many existed before this import").
 *   - Otherwise, a fresh `EnvVarNameCredential` with a new UUID is appended.
 *
 * Note: VaultPilot's name field is NOT unique (FR-22). Multiple credentials
 * may share a name. For env-import, we treat the FIRST same-named entry as
 * the overwrite target. Subsequent same-named entries in the existing array
 * remain untouched. This matches the user's mental model: "update my
 * MONGO_URI with this new value" — there's typically only one.
 */
export function mergeForImport(
  existing: readonly Credential[],
  entries: readonly EnvEntry[],
  now: string = new Date().toISOString(),
): { next: Credential[]; summary: ImportSummary } {
  const result: Credential[] = [...existing];
  let created = 0;
  let overwritten = 0;

  for (const entry of entries) {
    const idx = result.findIndex((c) => c.name === entry.key);
    if (idx >= 0) {
      const prior = result[idx];
      if (prior !== undefined) {
        const merged: EnvVarNameCredential = {
          id: prior.id,
          name: entry.key,
          type: 'env-var-name',
          value: entry.value,
          created: prior.created,
          updated: now,
          ...(prior.notes !== undefined ? { notes: prior.notes } : {}),
        };
        result[idx] = merged;
        overwritten++;
        continue;
      }
    }

    const fresh: EnvVarNameCredential = {
      id: randomUUID(),
      name: entry.key,
      type: 'env-var-name',
      value: entry.value,
      created: now,
      updated: now,
    };
    result.push(fresh);
    created++;
  }

  return { next: result, summary: { created, overwritten } };
}

// Re-export for compile-time check that this module sees CryptoError typed
// correctly through VaultError. Removed at tree-shake time.
void CryptoError;
