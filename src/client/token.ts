import { AlimailApiError, AlimailNetworkError } from "./errors.js";

export type FetchLike = typeof fetch;

export interface TokenManagerOptions {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Refresh this many ms before the token actually expires. */
  refreshSkewMs?: number;
  now?: () => number;
}

interface TokenResponse {
  token_type?: string;
  access_token?: string;
  expires_in?: number;
}

/** Caches the client-credentials token and deduplicates concurrent refreshes. */
export class TokenManager {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly skew: number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skew = opts.refreshSkewMs ?? 5 * 60_000;
  }

  async getToken(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - this.skew) return this.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
  }

  /** Returns seconds until expiry of the cached token (for diagnostics). */
  get expiresInSeconds(): number {
    return Math.max(0, Math.floor((this.expiresAt - this.now()) / 1000));
  }

  private async fetchToken(): Promise<string> {
    const path = "/oauth2/v2.0/token";
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.apiBase + path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new AlimailNetworkError(`token request failed: ${(e as Error).message}`, "POST", path);
    }
    const text = await res.text();
    let json: TokenResponse & { message?: string; detailErrorCode?: string } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // non-JSON error body
    }
    if (!res.ok || !json.access_token) {
      throw new AlimailApiError({
        status: res.ok ? 500 : res.status,
        method: "POST",
        path,
        body: {
          message: json.message ?? (res.ok ? "token response missing access_token" : undefined),
          detailErrorCode: json.detailErrorCode,
        },
        rawText: text,
      });
    }
    this.token = json.access_token;
    this.expiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
    return this.token;
  }
}
