/**
 * Minimal `.env` file parser.
 *
 * Handles the common cases:
 *   - `KEY=value`
 *   - `KEY="value with spaces"` and `KEY='single-quoted'` (strips matching outer quotes)
 *   - `export KEY=value` (bash-style export prefix)
 *   - Lines starting with `#` are comments and ignored
 *   - Blank lines are ignored
 *   - Empty values are skipped (you'd add those manually anyway)
 *
 * Out of scope (for now):
 *   - Multi-line values with `\` continuation
 *   - Variable expansion (`KEY=$OTHER` or `KEY=${OTHER}`)
 *   - Inline comments (`KEY=value  # comment` — the `# comment` becomes part of the value)
 */

export interface EnvEntry {
  readonly key: string;
  readonly value: string;
  /** 1-based line number of the original file, for diagnostics. */
  readonly lineNumber: number;
}

const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const match = LINE_RE.exec(line);
    if (match === null) continue;

    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;

    const value = stripQuotes(rawValue.trim());
    if (value.length === 0) continue;

    entries.push({ key, value, lineNumber: i + 1 });
  }

  return entries;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Heuristic — does the env-var name look like a secret? Used to decide
 * whether to mask the value in the import preview.
 */
const SECRET_KEYWORDS = [
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'AUTH',
  'PRIVATE',
  'CREDENTIAL',
  'URI',
  'DSN',
  'API',
];

export function looksSecret(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_KEYWORDS.some((kw) => upper.includes(kw));
}
