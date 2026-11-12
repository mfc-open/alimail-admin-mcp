import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { log } from "../logger.js";
import { createMcpServer, type AppContext } from "../server.js";
import { VERSION } from "../version.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

function bearerAuth(expected: string) {
  const want = Buffer.from(expected);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const got = Buffer.from(m?.[1] ?? "");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="alimail-admin-mcp"');
      jsonRpcError(res, 401, "Unauthorized");
      return;
    }
    next();
  };
}

/**
 * Starts a stateless Streamable HTTP endpoint at POST /mcp.
 * Each request gets its own McpServer, while API client, token cache,
 * confirmation store and audit log are shared via `app`.
 */
export async function startHttp(app: AppContext): Promise<Server> {
  const { host, port, authToken } = app.config.http;
  // Keep DNS-rebinding protection even when bound to all interfaces (e.g. inside Docker).
  const allowedHosts = app.config.http.allowedHosts.length
    ? app.config.http.allowedHosts
    : DEFAULT_ALLOWED_HOSTS;

  if (!LOOPBACK.has(host) && !authToken) {
    log.warn(
      `HTTP server is listening on ${host} without MCP_AUTH_TOKEN. Anyone who can reach this port can act as a mail administrator. Set MCP_AUTH_TOKEN, bind to 127.0.0.1, or (in Docker) publish the port on 127.0.0.1 only.`,
    );
  }

  const web = createMcpExpressApp({ host, allowedHosts });

  web.get("/healthz", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });

  if (authToken) web.use("/mcp", bearerAuth(authToken));

  web.post("/mcp", async (req: Request, res: Response) => {
    const { server } = createMcpServer(app);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error("error handling MCP request", { error: (e as Error).message });
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) =>
    jsonRpcError(res, 405, "Method not allowed (stateless server: use POST /mcp)");
  web.get("/mcp", methodNotAllowed);
  web.delete("/mcp", methodNotAllowed);

  return new Promise((resolve, reject) => {
    const httpServer = web.listen(port, host, () => {
      const addr = httpServer.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      log.info("alimail-admin-mcp HTTP server listening", {
        url: `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}/mcp`,
        auth: authToken ? "bearer" : "none",
        allowedHosts,
      });
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}
