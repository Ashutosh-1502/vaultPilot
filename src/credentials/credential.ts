/**
 * Credential schema — discriminated union keyed by `type` (FR-20, PRD addendum).
 *
 * Story 1.11 — replaces the Story 1.8 predeclaration. The full per-type shape
 * lives here. Each subtype carries the fields the Add UI prompts for and the
 * TreeView renders.
 *
 * Identity invariant: `id` is a UUID assigned at creation and never mutated.
 * Names are NOT unique — the user can have two credentials with the same name
 * and they coexist (FR-22 explicit). Identity is by `id`.
 */

export type CredentialType =
  | 'string'
  | 'api-key'
  | 'token'
  | 'user/password-pair'
  | 'json-blob'
  | 'env-var-name';

export const CREDENTIAL_TYPES: readonly CredentialType[] = [
  'string',
  'api-key',
  'token',
  'user/password-pair',
  'json-blob',
  'env-var-name',
] as const;

export interface CredentialBase {
  readonly id: string;
  readonly name: string;
  readonly notes?: string;
  readonly created: string;
  readonly updated: string;
}

export interface StringCredential extends CredentialBase {
  readonly type: 'string';
  readonly value: string;
}

export interface ApiKeyCredential extends CredentialBase {
  readonly type: 'api-key';
  readonly value: string;
}

export interface TokenCredential extends CredentialBase {
  readonly type: 'token';
  readonly value: string;
}

export interface PairField {
  readonly label: string;
  readonly value: string;
}

export interface PairCredential extends CredentialBase {
  readonly type: 'user/password-pair';
  readonly fields: {
    readonly fieldA: PairField;
    readonly fieldB: PairField;
  };
}

export interface JsonBlobCredential extends CredentialBase {
  readonly type: 'json-blob';
  /** Always validated as parseable JSON before save (Story 1.11). */
  readonly value: string;
}

export interface EnvVarNameCredential extends CredentialBase {
  readonly type: 'env-var-name';
  /** The env-var value. `name` (CredentialBase.name) carries the env-var name. */
  readonly value: string;
}

export type Credential =
  | StringCredential
  | ApiKeyCredential
  | TokenCredential
  | PairCredential
  | JsonBlobCredential
  | EnvVarNameCredential;

/**
 * For credentials with a single `value` field (everything except pair-type),
 * narrow to the union of those subtypes.
 */
export type SingleValueCredential =
  | StringCredential
  | ApiKeyCredential
  | TokenCredential
  | JsonBlobCredential
  | EnvVarNameCredential;

export function isPairCredential(c: Credential): c is PairCredential {
  return c.type === 'user/password-pair';
}

export function isSingleValueCredential(c: Credential): c is SingleValueCredential {
  return !isPairCredential(c);
}

/**
 * Best-effort zeroing of secret-bearing string fields. JavaScript strings are
 * immutable and cannot be deterministically wiped from memory (OQ-5). This is
 * a no-op intended to be replaced when string values can be Buffer-backed.
 * Documented in docs/threat-model.md.
 */
export function zeroCredentialFields(credential: Credential): void {
  void credential;
}

/**
 * Validate that an unknown value is a well-formed credential. Used when
 * decrypting the vault payload (defense against tampered structure).
 */
export function isCredential(value: unknown): value is Credential {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c['id'] !== 'string' || c['id'].length === 0) return false;
  if (typeof c['name'] !== 'string') return false;
  if (typeof c['type'] !== 'string' || !CREDENTIAL_TYPES.includes(c['type'] as CredentialType)) {
    return false;
  }
  if (typeof c['created'] !== 'string' || typeof c['updated'] !== 'string') return false;

  if (c['type'] === 'user/password-pair') {
    const fields = c['fields'];
    if (typeof fields !== 'object' || fields === null) return false;
    const f = fields as Record<string, unknown>;
    if (!isPairField(f['fieldA']) || !isPairField(f['fieldB'])) return false;
  } else {
    if (typeof c['value'] !== 'string') return false;
  }
  return true;
}

function isPairField(value: unknown): value is PairField {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f['label'] === 'string' && typeof f['value'] === 'string';
}
