import { AlimailApiError, AlimailNetworkError, type AlimailErrorBody } from "./errors.js";
import { RateLimiter } from "./ratelimit.js";
import { TokenManager, type FetchLike } from "./token.js";
import { log } from "../logger.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * Whether the request may be safely retried after a network error or 5xx.
   * Defaults to true for GET/PUT/DELETE/PATCH and false for POST.
   */
  idempotent?: boolean;
  /** Use "manual" to receive 3xx responses instead of following them (see `getRedirect`). */
  redirect?: "follow" | "manual";
}

export interface AlimailClientOptions {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  maxQps?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/** Encodes a path segment, keeping "@" and "$" readable (e.g. emails, `$root`). */
export function seg(value: string): string {
  return encodeURIComponent(value).replace(/%40/g, "@").replace(/%24/g, "$");
}

export class AlimailClient {
  readonly tokens: TokenManager;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AlimailClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tokens = new TokenManager({
      apiBase: opts.apiBase,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    this.limiter = new RateLimiter(opts.maxQps ?? 20);
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>({ method: "GET", path, query });
  }
  post<T = unknown>(path: string, body?: unknown, query?: Record<string, QueryValue>, idempotent?: boolean) {
    return this.request<T>({ method: "POST", path, body: body ?? {}, query, idempotent });
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.request<T>({ method: "PATCH", path, body });
  }
  delete<T = unknown>(path: string) {
    return this.request<T>({ method: "DELETE", path });
  }
  /** GETs an endpoint that answers with an HTTP redirect and returns the target URL without following it. */
  async getRedirect(path: string, query?: Record<string, QueryValue>): Promise<{ location?: string }> {
    const r = await this.request<{ location?: string }>({ method: "GET", path, query, redirect: "manual" });
    return { location: r.location };
  }

  async request<T = unknown>(req: RequestOptions): Promise<T> {
    const idempotent = req.idempotent ?? req.method !== "POST";
    const url = this.buildUrl(req.path, req.query);
    let authRetried = false;

    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      const token = await this.tokens.getToken();
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: req.method,
          headers: {
            Authorization: `bearer ${token}`,
            Accept: "application/json",
            ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          redirect: req.redirect ?? "follow",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const err = new AlimailNetworkError((e as Error).message, req.method, req.path);
        if (idempotent && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw err;
      }

      const requestId =
        res.headers.get("x-request-id") ?? res.headers.get("x-acs-request-id") ?? undefined;
      log.debug("alimail request", {
        method: req.method,
        path: req.path,
        status: res.status,
        ms: Date.now() - started,
        requestId,
      });

      if (req.redirect === "manual" && res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return { location: res.headers.get("location") ?? undefined } as T;
      }

      if (res.ok) {
        const text = await res.text();
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return { raw: text } as T;
        }
      }

      const text = await res.text();
      let body: AlimailErrorBody | undefined;
      try {
        body = text ? (JSON.parse(text) as AlimailErrorBody) : undefined;
      } catch {
        body = undefined;
      }

      // A 401 means the request was rejected before execution, so one retry with a fresh token is safe.
      if (res.status === 401 && !authRetried) {
        authRetried = true;
        this.tokens.invalidate();
        continue;
      }
      // 429 means the request was not processed, so it is safe to retry even for non-idempotent calls.
      const retryable = res.status === 429 || (res.status >= 500 && idempotent);
      if (retryable && attempt < this.maxRetries) {
        await this.backoff(attempt, res.headers.get("retry-after"));
        continue;
      }
      throw new AlimailApiError({
        status: res.status,
        method: req.method,
        path: req.path,
        body,
        rawText: text,
        requestId,
      });
    }
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.opts.apiBase + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    // URLSearchParams encodes "$" in keys like "$select"; the API expects it literally.
    return url.toString().replace(/([?&])%24/g, "$1$");
  }

  private async backoff(attempt: number, retryAfter?: string | null) {
    let ms = Math.min(8_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
    const ra = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(ra) && ra >= 0) ms = Math.min(30_000, ra * 1000);
    await this.sleep(ms);
  }
}
