import { Result } from '../result/result';
import { DriveError } from '../result/errors';
import { refreshAccessToken } from './oauth';
import type { SecretStorageWrapper } from '../keychain/secret-storage';

/**
 * Drive REST API wrapper (Story 3.1 — FR-33 silent refresh, FR-50 atomic
 * upload helpers).
 *
 * Architectural boundary: this is the SOLE module that makes outbound HTTP.
 * Every Drive REST call goes through `DriveClient`. Backup and Restore
 * modules consume the client; they don't talk to `fetch` directly.
 *
 * 401 silent refresh (FR-33): on first 401 from any Drive endpoint, the
 * client attempts ONE refresh using the stored refresh token, then retries
 * the original call. On continued failure, returns `drive.auth-expired`.
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly md5Checksum?: string;
  readonly modifiedTime?: string;
}

export class DriveClient {
  /** In-memory access token. Refreshed on 401. NEVER persisted. */
  private accessToken: string;
  /** Last refresh's expiration (ms epoch); used to proactively refresh. */
  private accessTokenExpiry: number;

  constructor(
    accessToken: string,
    expiresInSeconds: number,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly secretStorage: SecretStorageWrapper,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.accessToken = accessToken;
    this.accessTokenExpiry = Date.now() + expiresInSeconds * 1000;
  }

  /**
   * List files in the appdata folder matching the given name. Returns
   * candidates — there may be zero, one, or (in the FR-50 stale-temp case)
   * multiple matches.
   */
  async listAppdataFilesByName(name: string): Promise<Result<readonly DriveFile[], DriveError>> {
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
    const url = `${DRIVE_API_BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,size,md5Checksum,modifiedTime)`;
    const response = await this.driveFetch(url, { method: 'GET' });
    if (!response.ok) return response;
    const json = (await response.value.json()) as { files?: DriveFile[] };
    return Result.ok(json.files ?? []);
  }

  /**
   * Create a new file in the appdata folder with metadata + content
   * in a single multipart request. Returns the created file's metadata.
   */
  async uploadAppdataFile(name: string, content: Buffer): Promise<Result<DriveFile, DriveError>> {
    const boundary = `vp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const metadata = {
      name,
      parents: ['appDataFolder'],
    };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,size,md5Checksum`;
    const response = await this.driveFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!response.ok) return response;
    const json = (await response.value.json()) as DriveFile;
    return Result.ok(json);
  }

  /**
   * Rename a file via metadata PATCH. Used by FR-50 atomic-rename
   * (`vaultpilot-backup.uploading` → `vaultpilot-backup`).
   */
  async renameFile(fileId: string, newName: string): Promise<Result<DriveFile, DriveError>> {
    const url = `${DRIVE_API_BASE}/files/${fileId}?fields=id,name,size,md5Checksum`;
    const response = await this.driveFetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (!response.ok) return response;
    const json = (await response.value.json()) as DriveFile;
    return Result.ok(json);
  }

  /**
   * Download a file's content as raw bytes.
   */
  async downloadFile(fileId: string): Promise<Result<Buffer, DriveError>> {
    const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;
    const response = await this.driveFetch(url, { method: 'GET' });
    if (!response.ok) return response;
    const buf = Buffer.from(await response.value.arrayBuffer());
    return Result.ok(buf);
  }

  /**
   * Permanently delete a file.
   */
  async deleteFile(fileId: string): Promise<Result<void, DriveError>> {
    const url = `${DRIVE_API_BASE}/files/${fileId}`;
    const response = await this.driveFetch(url, { method: 'DELETE' });
    if (!response.ok) return response;
    return Result.ok(undefined);
  }

  /**
   * Single Drive HTTP call with one transparent retry on 401 (FR-33 silent
   * refresh). All other status codes are mapped via `mapDriveStatus`.
   */
  private async driveFetch(
    url: string,
    init: RequestInit,
  ): Promise<Result<Response, DriveError>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, this.withAuthHeader(init));
    } catch (err) {
      return Result.err(DriveError.networkFailed(String(err)));
    }

    if (response.status !== 401) {
      return await this.checkStatus(response);
    }

    // 401 → attempt silent refresh once
    const refreshResult = await this.refreshAccessTokenSilently();
    if (!refreshResult.ok) {
      return refreshResult;
    }

    try {
      response = await this.fetchImpl(url, this.withAuthHeader(init));
    } catch (err) {
      return Result.err(DriveError.networkFailed(String(err)));
    }
    return await this.checkStatus(response);
  }

  private withAuthHeader(init: RequestInit): RequestInit {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.accessToken}`);
    return { ...init, headers };
  }

  private async checkStatus(response: Response): Promise<Result<Response, DriveError>> {
    if (response.ok) return Result.ok(response);
    if (response.status === 401) return Result.err(DriveError.authExpired());

    // Read the JSON body so we can distinguish 403 reasons. Google returns
    // a structured `error.errors[0].reason` field — see
    // https://developers.google.com/drive/api/guides/handle-errors.
    let reason: string | null = null;
    let message: string | null = null;
    let status: string | null = null;
    try {
      const body = (await response.clone().json()) as {
        error?: {
          message?: string;
          status?: string;
          errors?: ReadonlyArray<{ reason?: string; message?: string }>;
        };
      };
      reason = body.error?.errors?.[0]?.reason ?? null;
      message = body.error?.message ?? null;
      status = body.error?.status ?? null;
    } catch {
      // Body not JSON or already consumed — fall through to status-only error.
    }

    // Generic reasons ("forbidden", "permissionDenied") aren't actionable on
    // their own. Concat reason + message + status so the user sees the full
    // picture in the toast.
    const isGeneric = reason === null || reason === 'forbidden' || reason === 'permissionDenied';
    const buildDetail = (httpCode: number): string => {
      const bits: string[] = [];
      if (reason !== null) bits.push(reason);
      if (isGeneric && message !== null && message !== reason) bits.push(`"${message}"`);
      if (isGeneric && status !== null) bits.push(`status=${status}`);
      if (bits.length === 0) bits.push(`HTTP ${String(httpCode)}`);
      return bits.join(' — ');
    };

    if (response.status === 403) {
      if (
        reason === 'userRateLimitExceeded' ||
        reason === 'rateLimitExceeded' ||
        reason === 'storageQuotaExceeded' ||
        reason === 'quotaExceeded'
      ) {
        return Result.err(DriveError.quotaExceeded());
      }
      return Result.err(DriveError.networkFailed(`HTTP 403 — ${buildDetail(403)}`));
    }

    return Result.err(DriveError.networkFailed(buildDetail(response.status)));
  }

  private async refreshAccessTokenSilently(): Promise<Result<void, DriveError>> {
    const refreshToken = await this.secretStorage.getDriveRefreshToken();
    if (!refreshToken.ok) {
      return Result.err(DriveError.authExpired());
    }
    if (refreshToken.value === null) {
      return Result.err(DriveError.authExpired());
    }
    const refreshResult = await refreshAccessToken(
      {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: refreshToken.value,
      },
      this.fetchImpl,
    );
    if (!refreshResult.ok) {
      return refreshResult;
    }
    this.accessToken = refreshResult.value.accessToken;
    this.accessTokenExpiry = Date.now() + refreshResult.value.expiresIn * 1000;
    // Store the (possibly-rotated) refresh token.
    if (refreshResult.value.refreshToken !== refreshToken.value) {
      void this.secretStorage.setDriveRefreshToken(refreshResult.value.refreshToken);
    }
    return Result.ok(undefined);
  }

  /** Expose for tests / proactive refresh in callers if needed. */
  isAccessTokenLikelyExpired(): boolean {
    return Date.now() >= this.accessTokenExpiry - 30_000; // 30s buffer
  }
}
