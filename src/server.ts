import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AlimailClient } from "./client/http.js";
import type { Config } from "./config.js";
import { AuditLog } from "./guard/audit.js";
import { ConfirmStore } from "./guard/confirm.js";
import { DomainScope } from "./guard/scope.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources, ResourceCache } from "./resources/index.js";
import { auditTools } from "./tools/audit.js";
import { contactTools } from "./tools/contacts.js";
import { departmentTools } from "./tools/departments.js";
import { groupTools } from "./tools/groups.js";
import { loginTools } from "./tools/login.js";
import { orgTools } from "./tools/org.js";
import { registerTools, type AnyToolDef, type Deps } from "./tools/registry.js";
import { securityTools } from "./tools/security.js";
import { userTools } from "./tools/users.js";
import { VERSION } from "./version.js";

export const ALL_TOOLS: AnyToolDef[] = [
  ...userTools,
  ...departmentTools,
  ...groupTools,
  ...contactTools,
  ...orgTools,
  ...securityTools,
  ...auditTools,
  ...loginTools,
];

export interface AppContext extends Deps {
  cache: ResourceCache;
}

/** Builds the long-lived dependencies shared by every MCP session. */
export function createAppContext(config: Config, overrides: Partial<AppContext> = {}): AppContext {
  return {
    config,
    client:
      overrides.client ??
      new AlimailClient({
        apiBase: config.apiBase,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        maxQps: config.maxQps,
        timeoutMs: config.timeoutMs,
      }),
    scope: overrides.scope ?? new DomainScope(config.allowedDomains),
    confirm: overrides.confirm ?? new ConfirmStore(),
    audit: overrides.audit ?? new AuditLog(config.auditLog),
    cache: overrides.cache ?? new ResourceCache(),
  };
}

export function createMcpServer(app: AppContext): { server: McpServer; tools: string[] } {
  const server = new McpServer(
    { name: "alimail-admin-mcp", title: "阿里邮箱管理 (非官方)", version: VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: [
        "本服务通过阿里邮箱开放平台 API 管理企业邮箱的用户、部门、邮件组、公共通讯录、组织与域名、收信黑白名单、隔离区和审计日志。",
        app.config.readOnly
          ? "当前为只读模式：只提供查询类工具。"
          : "写操作已启用：破坏性操作（删除、重置密码、撤销登录态、放行隔离邮件、修改黑白名单等）需两步确认，务必先向用户展示预览并获得明确同意。",
        "用户和邮件组可用 ID 或邮箱定位；部门 ID 可用 $root 表示根部门，公共联系人分组 ID 可用 $root 表示根分组。列表结果注意分页（nextCursor/hasMore 或 offset/total）。",
      ].join("\n"),
    },
  );
  const tools = registerTools(server, ALL_TOOLS, app);
  registerResources(server, app, app.cache);
  registerPrompts(server, app.config);
  return { server, tools };
}
