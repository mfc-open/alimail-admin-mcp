#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.js";
import { log } from "./logger.js";
import { ALL_TOOLS, createAppContext } from "./server.js";
import { isEnabled } from "./tools/registry.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";
import { VERSION } from "./version.js";

const HELP = `alimail-admin-mcp ${VERSION} — 阿里邮箱管理 MCP 服务（非官方）

用法:
  alimail-admin-mcp [选项]

选项:
  --http             以 Streamable HTTP 方式运行（默认 stdio）
  --host <host>      HTTP 监听地址（默认 127.0.0.1，可用 MCP_HTTP_HOST）
  --port <port>      HTTP 端口（默认 3000，可用 MCP_HTTP_PORT）
  --check            仅换取一次访问令牌以验证凭证，然后退出
  --list-tools       输出当前配置下启用的工具后退出
  -v, --version      显示版本
  -h, --help         显示帮助

主要环境变量:
  ALIMAIL_CLIENT_ID / ALIMAIL_CLIENT_SECRET   应用凭证（必填）
  ALIMAIL_API_BASE        默认 https://alimail-cn.aliyuncs.com
  ALIMAIL_READ_ONLY       默认 true；设为 false 才会注册写操作工具
  ALIMAIL_TOOLSETS        默认 users,departments
  ALIMAIL_ALLOWED_DOMAINS 限定可操作的邮箱域名，逗号分隔
  MCP_AUTH_TOKEN          HTTP 模式下要求 Authorization: Bearer <token>
`;

async function main() {
  const { values } = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      check: { type: "boolean", default: false },
      "list-tools": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(VERSION + "\n");
    return;
  }

  const env = { ...process.env };
  if (values.host) env.MCP_HTTP_HOST = values.host;
  if (values.port) env.MCP_HTTP_PORT = values.port;
  const config = loadConfig(env);

  if (values["list-tools"]) {
    const enabled = ALL_TOOLS.filter((t) => isEnabled(t, config));
    for (const t of enabled) process.stdout.write(`${t.name}\t${t.kind}\t${t.title}\n`);
    return;
  }

  const app = createAppContext(config);

  if (values.check) {
    await app.client.tokens.getToken();
    process.stdout.write(
      `OK: obtained access token from ${config.apiBase} (expires in ${app.client.tokens.expiresInSeconds}s)\n`,
    );
    return;
  }

  if (config.readOnly) log.info("read-only mode: write tools are not registered");

  if (values.http) {
    const server = await startHttp(app);
    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    await startStdio(app);
  }
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    process.stderr.write(e.message + "\n");
    process.exit(2);
  }
  const detail = typeof e?.toJSON === "function" ? JSON.stringify(e.toJSON()) : (e?.stack ?? String(e));
  process.stderr.write(`alimail-admin-mcp failed: ${detail}\n`);
  process.exit(1);
});
