import { z } from "zod";
import { seg } from "../client/http.js";
import { defineTool, ToolInputError, type AnyToolDef } from "./registry.js";

const domainName = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z0-9-]+$/i, "invalid domain")
  .describe("完整域名，如 example.com");

const domainSelect = z.string().optional().describe("透传 $select，如 createdTime,aliasInfos,isVerified");

interface Domain {
  id?: string;
  domain?: string;
  isMaster?: boolean;
  aliases?: string[];
  isMxVerified?: boolean;
}

export const orgTools: AnyToolDef[] = [
  // ---------- read ----------
  defineTool({
    name: "get_organization",
    title: "获取组织信息",
    toolset: "org",
    kind: "read",
    description: "获取组织信息（名称、主域名、默认域名、联系方式、语言偏好等）。默认返回当前凭证所属组织。",
    inputSchema: {
      org: z.string().optional().default("$current").describe("组织 ID 或域名，默认 $current 表示当前组织"),
    },
    handler: async (a, { client }) => client.get(`/v2/organization/${seg(a.org)}`),
  }),
  defineTool({
    name: "list_domains",
    title: "查询组织域名",
    toolset: "org",
    kind: "read",
    description: "查询当前组织下的全部域名（主域名及其他已添加的域名），包括域别名、MX 解析状态等。",
    inputSchema: { select: domainSelect },
    handler: async (a, { client }) => client.get("/v2/domains", { $select: a.select }),
  }),
  defineTool({
    name: "get_domain",
    title: "获取域名信息",
    toolset: "org",
    kind: "read",
    description: "根据域名 ID、域名或域别名获取域名信息。",
    inputSchema: { domain: z.string().min(1).describe("域名 ID、域名或域别名"), select: domainSelect },
    handler: async (a, { client }) => client.get(`/v2/domains/${seg(a.domain)}`, { $select: a.select }),
  }),

  // ---------- write ----------
  defineTool({
    name: "update_organization",
    title: "更新组织信息",
    toolset: "org",
    kind: "write",
    idempotent: true,
    description: "更新当前组织的基本信息（仅修改传入字段）。",
    inputSchema: {
      name: z.string().min(1).optional().describe("组织名称"),
      introduction: z.string().optional().describe("组织介绍"),
      telephone: z.string().optional().describe("联系电话"),
      address: z.string().optional().describe("地址"),
      preferredLanguage: z.string().optional().describe("偏好语言，如 zh_CN、zh_TW、en_US"),
      defaultDomain: z.string().optional().describe("默认域名"),
    },
    handler: async (a, { client }) => {
      if (Object.values(a).every((v) => v === undefined)) {
        throw new ToolInputError("至少需要提供一个要更新的字段");
      }
      return client.patch("/v2/organization/$current", a);
    },
  }),
  defineTool({
    name: "add_domain",
    title: "添加域名",
    toolset: "org",
    kind: "write",
    description: "为当前组织添加新域名。添加后需在 DNS 中配置校验记录，再用 verify_domain 验证所有权。",
    inputSchema: { domain: domainName },
    authorize: async (a, ctx) => ctx.scope.assertDomain(a.domain),
    handler: async (a, { client }) => client.post("/v2/domains", { domain: a.domain }),
  }),
  defineTool({
    name: "verify_domain",
    title: "验证域名所有权",
    toolset: "org",
    kind: "write",
    idempotent: true,
    description: "验证当前组织是否拥有指定域名（检查 DNS 校验记录），返回 isOwner。",
    inputSchema: { domain: domainName },
    authorize: async (a, ctx) => ctx.scope.assertDomain(a.domain),
    handler: async (a, { client }) => client.post(`/v2/domains/${seg(a.domain)}/verify`, {}, undefined, true),
  }),

  // ---------- destructive ----------
  defineTool({
    name: "delete_domain",
    title: "删除域名",
    toolset: "org",
    kind: "destructive",
    description: "从当前组织删除域名。组织主域名不支持删除。该域名下的地址将无法再收发邮件。",
    inputSchema: { domain: domainName },
    authorize: async (a, ctx) => ctx.scope.assertDomain(a.domain),
    preview: async (a, { client }) => {
      const d = await client.get<Domain>(`/v2/domains/${seg(a.domain)}`);
      return {
        target: { id: d.id, domain: d.domain, aliases: d.aliases, isMaster: d.isMaster, isMxVerified: d.isMxVerified },
        willFail: d.isMaster ? "主域名不支持删除" : undefined,
      };
    },
    handler: async (a, { client }) => {
      await client.delete(`/v2/domains/${seg(a.domain)}`);
      return { ok: true, deleted: a.domain };
    },
  }),
];
