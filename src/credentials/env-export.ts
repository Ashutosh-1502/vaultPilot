import type { Credential } from './credential';

/**
 * Serialize a list of credentials as a `.env` file.
 *
 * Naming rules (env vars must be `[A-Za-z_][A-Za-z0-9_]*`):
 *   - For `env-var-name` credentials, the `name` IS the env var name —
 *     pass through unchanged (we sanitize defensively).
 *   - For other types, the credential name is sanitized: uppercased,
 *     non-alphanumerics replaced with `_`, prefixed with `_` if it starts
 *     with a digit.
 *   - `user/password-pair` produces two lines (`NAME_LABELA`, `NAME_LABELB`).
 *
 * Value escaping (POSIX shell `.env` conventions):
 *   - Empty values, or values containing whitespace, quotes, `$`, `` ` ``,
 *     or `\`, are wrapped in double quotes with backslash escaping.
 *   - Simple values are written unquoted.
 */
export function credentialsToEnvFile(
  credentials: readonly Credential[],
  options?: { readonly header?: string },
): string {
  const lines: string[] = [];
  if (options?.header !== undefined && options.header.length > 0) {
    lines.push(options.header);
  }
  for (const c of credentials) {
    for (const line of credentialToEnvLines(c)) {
      lines.push(line);
    }
  }
  return lines.join('\n') + '\n';
}

function credentialToEnvLines(c: Credential): string[] {
  switch (c.type) {
    case 'string':
    case 'api-key':
    case 'token':
    case 'env-var-name':
    case 'json-blob':
      return [`${toEnvKey(c.name)}=${envEscape(c.value)}`];
    case 'user/password-pair':
      return [
        `${toEnvKey(c.name)}_${toEnvKey(c.fields.fieldA.label)}=${envEscape(c.fields.fieldA.value)}`,
        `${toEnvKey(c.name)}_${toEnvKey(c.fields.fieldB.label)}=${envEscape(c.fields.fieldB.value)}`,
      ];
  }
}

export function toEnvKey(name: string): string {
  let key = name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  if (key.length === 0) key = 'UNNAMED';
  if (/^[0-9]/.test(key)) key = `_${key}`;
  return key;
}

export function envEscape(value: string): string {
  if (value.length === 0) return '""';
  if (/[\s"'$`\\]/.test(value)) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    return `"${escaped}"`;
  }
  return value;
}
