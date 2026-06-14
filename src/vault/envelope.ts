import { Result } from '../result/result';
import { VaultFormatError } from '../result/errors';

/**
 * Vault envelope serializer/parser.
 *
 * Story 1.4 — defines the on-disk format for `keys.enc`. See
 * docs/vault-file-format.md for the authoritative spec.
 *
 * Layout:
 *   <plaintext JSON header line>\n<base64 ciphertext>
 *
 * The header is plaintext so `peekVersion` can read the format version
 * WITHOUT attempting decrypt (FR-5 future-version refusal).
 */

export interface EnvelopeHeader {
  readonly version: number;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
}

export interface EnvelopeContents extends EnvelopeHeader {
  readonly ciphertext: Uint8Array;
}

const NEWLINE = 0x0a;

/**
 * Serialize the envelope to bytes:
 *   {"version":N,"salt":"<base64>","nonce":"<base64>"}\n<base64 ciphertext>
 */
export function serializeEnvelope(
  version: number,
  salt: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Buffer {
  const header = JSON.stringify({
    version,
    salt: Buffer.from(salt).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  });
  const cipherB64 = Buffer.from(ciphertext).toString('base64');
  return Buffer.from(`${header}\n${cipherB64}`, 'utf8');
}

/**
 * Read ONLY the header version, without parsing the ciphertext. Used by the
 * loader to refuse future-version files before attempting decrypt.
 */
export function peekVersion(buffer: Buffer): Result<number, VaultFormatError> {
  const headerJson = extractHeaderJson(buffer);
  if (!headerJson.ok) {
    return headerJson;
  }
  try {
    const parsed = JSON.parse(headerJson.value) as { version?: unknown };
    if (typeof parsed.version !== 'number') {
      return Result.err(VaultFormatError.missingHeader());
    }
    return Result.ok(parsed.version);
  } catch {
    return Result.err(VaultFormatError.corrupted());
  }
}

/**
 * Fully parse the envelope into header fields + ciphertext bytes.
 */
export function parseEnvelope(buffer: Buffer): Result<EnvelopeContents, VaultFormatError> {
  const headerJson = extractHeaderJson(buffer);
  if (!headerJson.ok) {
    return headerJson;
  }

  let parsed: { version?: unknown; salt?: unknown; nonce?: unknown };
  try {
    parsed = JSON.parse(headerJson.value) as typeof parsed;
  } catch {
    return Result.err(VaultFormatError.corrupted());
  }

  if (typeof parsed.version !== 'number') {
    return Result.err(VaultFormatError.missingHeader());
  }
  if (typeof parsed.salt !== 'string' || typeof parsed.nonce !== 'string') {
    return Result.err(VaultFormatError.missingHeader());
  }

  // The ciphertext starts after the first newline.
  const newlineIdx = buffer.indexOf(NEWLINE);
  if (newlineIdx < 0) {
    return Result.err(VaultFormatError.corrupted());
  }
  const cipherB64 = buffer.subarray(newlineIdx + 1).toString('utf8');
  let ciphertext: Buffer;
  try {
    ciphertext = Buffer.from(cipherB64, 'base64');
  } catch {
    return Result.err(VaultFormatError.corrupted());
  }
  if (ciphertext.length === 0) {
    return Result.err(VaultFormatError.corrupted());
  }

  return Result.ok({
    version: parsed.version,
    salt: Buffer.from(parsed.salt, 'base64'),
    nonce: Buffer.from(parsed.nonce, 'base64'),
    ciphertext,
  });
}

/**
 * Extract the JSON header line (without the trailing newline). The header is
 * guaranteed to be on the first line; the ciphertext begins on the second.
 */
function extractHeaderJson(buffer: Buffer): Result<string, VaultFormatError> {
  const newlineIdx = buffer.indexOf(NEWLINE);
  if (newlineIdx <= 0) {
    return Result.err(VaultFormatError.missingHeader());
  }
  const headerStr = buffer.subarray(0, newlineIdx).toString('utf8');
  return Result.ok(headerStr);
}
