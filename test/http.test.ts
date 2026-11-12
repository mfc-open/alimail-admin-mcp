import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAppContext } from "../src/server.js";
import { startHttp } from "../src/transports/http.js";
import { MockApi, testClient, testConfig } from "./helpers.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(env: Record<string, string> = {}) {
  const api = new MockApi().on("GET /v2/departments/:id", () => ({ id: "root", name: "Org" }));
  const config = testConfig({ MCP_HTTP_PORT: "1", ...env });
  config.http.port = 0; // ephemeral port
  server = await startHttp(createAppContext(config, { client: testClient(api) }));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, api };
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("Streamable HTTP transport", () => {
  it("serves health and MCP without auth when no token is configured", async () => {
    const { base } = await start();
    const h = await fetch(`${base}/healthz`);
    expect((await h.json()).status).toBe("ok");

    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const r = (await client.callTool({ name: "get_department", arguments: { id: "$root" } })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(r.content[0]!.text)).toEqual({ id: "root", name: "Org" });
    await client.close();
  });

  it("requires the bearer token when MCP_AUTH_TOKEN is set", async () => {
    const { base } = await start({ MCP_AUTH_TOKEN: "s3cret" });
    const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(initBody) });
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer nope" },
      body: JSON.stringify(initBody),
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer s3cret" },
      body: JSON.stringify(initBody),
    });
    expect(ok.status).toBe(200);
  });

  it("rejects unexpected Host headers (DNS rebinding protection)", async () => {
    const { base } = await start();
    const { port } = new URL(base);
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...headers, host: "evil.example.com" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(initBody));
    });
    expect(status).toBe(403);
  });

  it("returns 405 for GET /mcp in stateless mode", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(r.status).toBe(405);
  });
});
