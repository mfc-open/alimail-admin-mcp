import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AlimailClient } from "../src/client/http.js";
import { loadConfig, type Config } from "../src/config.js";
import { AuditLog, type AuditEntry } from "../src/guard/audit.js";
import { createAppContext, createMcpServer, type AppContext } from "../src/server.js";

export const API = "https://alimail.test";

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  rawUrl: string;
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (call: RecordedCall) => Response | Promise<Response> | unknown;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A tiny fetch mock: routes are "METHOD /path" with optional ":param" segments.
 * Handlers may return a Response or a plain value (serialized as 200 JSON).
 */
export class MockApi {
  readonly calls: RecordedCall[] = [];
  private readonly routes: { method: string; re: RegExp; handler: Handler }[] = [];
  tokenRequests = 0;

  constructor() {
    this.on("POST /oauth2/v2.0/token", () => {
      this.tokenRequests++;
      return { token_type: "bearer", access_token: `tok-${this.tokenRequests}`, expires_in: 172799 };
    });
  }

  on(route: string, handler: Handler): this {
    const [method, path] = route.split(" ") as [string, string];
    const re = new RegExp(
      "^" + path.replace(/[$]/g, "\\$").replace(/:[a-zA-Z]+/g, "[^/]+") + "$",
    );
    this.routes.unshift({ method, re, handler });
    return this;
  }

  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof URLSearchParams) {
      body = Object.fromEntries(init.body);
    }
    const call: RecordedCall = {
      method,
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      rawUrl: String(input),
      body,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    };
    if (call.path !== "/oauth2/v2.0/token") this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && r.re.test(call.path));
    if (!route) return json({ message: `no mock for ${method} ${call.path}` }, 404);
    const out = await route.handler(call);
    return out instanceof Response ? out : json(out ?? {});
  };
}

export class MemoryAudit extends AuditLog {
  readonly entries: AuditEntry[] = [];
  override async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    ALIMAIL_CLIENT_ID: "cid",
    ALIMAIL_CLIENT_SECRET: "csecret",
    ALIMAIL_API_BASE: API,
    ...env,
  });
}

export function testClient(api: MockApi, opts: { maxRetries?: number } = {}) {
  return new AlimailClient({
    apiBase: API,
    clientId: "cid",
    clientSecret: "csecret",
    maxQps: 1000,
    fetchImpl: api.fetch,
    sleep: async () => {},
    maxRetries: opts.maxRetries,
  });
}

export async function connect(api: MockApi, env: Record<string, string> = {}) {
  const config = testConfig(env);
  const audit = new MemoryAudit();
  const app: AppContext = createAppContext(config, { client: testClient(api), audit });
  const { server } = createMcpServer(app);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    const text = res.content[0]?.text ?? "null";
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { data: data as Record<string, any>, isError: Boolean(res.isError) };
  }

  return { client, server, app, audit, call, close: () => client.close() };
}
