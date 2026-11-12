import { describe, expect, it } from "vitest";
import { seg } from "../src/client/http.js";
import { AlimailApiError } from "../src/client/errors.js";
import { collectByCursor, collectByOffset } from "../src/client/paginate.js";
import { RateLimiter } from "../src/client/ratelimit.js";
import { TokenManager } from "../src/client/token.js";
import { API, json, MockApi, testClient } from "./helpers.js";

describe("TokenManager", () => {
  it("caches tokens and deduplicates concurrent refreshes", async () => {
    const api = new MockApi();
    const tm = new TokenManager({ apiBase: API, clientId: "a", clientSecret: "b", fetchImpl: api.fetch });
    const [t1, t2] = await Promise.all([tm.getToken(), tm.getToken()]);
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-1");
    expect(await tm.getToken()).toBe("tok-1");
    expect(api.tokenRequests).toBe(1);
  });

  it("refreshes shortly before expiry", async () => {
    const api = new MockApi();
    let now = 0;
    const tm = new TokenManager({
      apiBase: API,
      clientId: "a",
      clientSecret: "b",
      fetchImpl: api.fetch,
      now: () => now,
    });
    await tm.getToken();
    now = (172799 - 60) * 1000; // within the 5 minute skew
    expect(await tm.getToken()).toBe("tok-2");
  });

  it("sends client credentials as form data and surfaces errors", async () => {
    const api = new MockApi();
    let seen: unknown;
    api.on("POST /oauth2/v2.0/token", (c) => {
      seen = c.body;
      return json({ message: "invalid client" }, 401);
    });
    const tm = new TokenManager({ apiBase: API, clientId: "id1", clientSecret: "sec1", fetchImpl: api.fetch });
    const err = await tm.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(AlimailApiError);
    expect(err.status).toBe(401);
    expect(seen).toEqual({ grant_type: "client_credentials", client_id: "id1", client_secret: "sec1" });
  });
});

describe("AlimailClient", () => {
  it("sends bearer token, keeps $select literal and encodes path segments", async () => {
    const api = new MockApi().on("GET /v2/users/:id", () => ({ id: "1" }));
    const client = testClient(api);
    await client.get(`/v2/users/${seg("a b@x.com")}`, { $select: "phone,isHidden", empty: "", nope: undefined });
    const call = api.calls[0]!;
    expect(call.headers.Authorization).toBe("bearer tok-1");
    expect(call.rawUrl).toContain("/v2/users/a%20b@x.com");
    expect(call.rawUrl).toContain("?$select=phone%2CisHidden");
    expect(call.rawUrl).not.toContain("empty");
    expect(seg("$root")).toBe("$root");
  });

  it("refreshes the token once on 401", async () => {
    const api = new MockApi();
    let n = 0;
    api.on("GET /v2/departments/:id", () => (++n === 1 ? json({ message: "expired" }, 401) : { id: "r" }));
    const client = testClient(api);
    expect(await client.get("/v2/departments/$root")).toEqual({ id: "r" });
    expect(api.tokenRequests).toBe(2);
    expect(api.calls[1]!.headers.Authorization).toBe("bearer tok-2");
  });

  it("retries 429 even for POST, but not 5xx for non-idempotent POST", async () => {
    const api = new MockApi();
    let n = 0;
    api.on("POST /v2/users", () => (++n === 1 ? json({}, 429) : { id: "u1" }));
    const client = testClient(api);
    expect(await client.post("/v2/users", { a: 1 })).toEqual({ id: "u1" });
    expect(n).toBe(2);

    let m = 0;
    api.on("POST /v2/users/x/resetPassword", () => {
      m++;
      return json({ message: "boom" }, 500);
    });
    await expect(client.post("/v2/users/x/resetPassword", {})).rejects.toBeInstanceOf(AlimailApiError);
    expect(m).toBe(1);
  });

  it("retries 5xx for GET up to maxRetries", async () => {
    const api = new MockApi();
    let n = 0;
    api.on("GET /v2/users", () => {
      n++;
      return json({ message: "unavailable" }, 503);
    });
    const client = testClient(api, { maxRetries: 2 });
    await expect(client.get("/v2/users")).rejects.toMatchObject({ status: 503 });
    expect(n).toBe(3);
  });

  it("normalizes error bodies with detailErrorCode and hint", async () => {
    const api = new MockApi().on("POST /v2/users", () =>
      json({ detailErrorCode: "EmailExists", message: "email already exists" }, 409, { "x-request-id": "req-1" }),
    );
    const err = (await testClient(api).post("/v2/users", {}).catch((e) => e)) as AlimailApiError;
    expect(err.toJSON()).toMatchObject({
      status: 409,
      detailErrorCode: "EmailExists",
      message: "email already exists",
      requestId: "req-1",
      request: "POST /v2/users",
    });
    expect(err.hint).toBeTruthy();
  });
});

describe("pagination helpers", () => {
  it("collects offset pages until total", async () => {
    const data = Array.from({ length: 250 }, (_, i) => i);
    const calls: number[] = [];
    const r = await collectByOffset(async (offset, limit) => {
      calls.push(offset);
      return { items: data.slice(offset, offset + limit), total: data.length };
    });
    expect(r.items).toHaveLength(250);
    expect(calls).toEqual([0, 100, 200]);
    expect(r.truncated).toBe(false);
  });

  it("truncates offset results at maxItems", async () => {
    const r = await collectByOffset(async (o, l) => ({ items: Array(l).fill(o), total: 1000 }), {
      maxItems: 150,
    });
    expect(r.items).toHaveLength(150);
    expect(r.truncated).toBe(true);
  });

  it("follows cursors until hasMore is false", async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string; hasMore?: boolean }> = {
      start: { items: [1, 2], nextCursor: "c2", hasMore: true },
      c2: { items: [3], hasMore: false },
    };
    const r = await collectByCursor(async (c) => pages[c ?? "start"]!);
    expect(r).toEqual({ items: [1, 2, 3], hasMore: false });
  });
});

describe("RateLimiter", () => {
  it("waits when the bucket is empty", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(2, 2, () => now, async (ms) => {
      sleeps.push(ms);
      now += ms;
    });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(sleeps).toEqual([500]);
  });
});
