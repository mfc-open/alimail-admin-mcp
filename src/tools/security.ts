import { z } from "zod";
import { seg } from "../client/http.js";
import { isEmail } from "../guard/scope.js";
import { defineTool, ToolInputError, type AnyToolDef, type ToolContext } from "./registry.js";

// ---------- allow / block lists ----------

const listType = z.enum(["ALLOW", "BLOCK"]).describe("ALLOW 白名单（命中直接投递）/ BLOCK 黑名单（命中直接拒收）");

const ENTRY_TYPES = [
  "EMAIL",
  "DOMAIN_NAME",
  "IPV4ADDRESS",
  "IPV4ADDRESSRANGE",
  "IPV6ADDRESS",
  "IPV6ADDRESSRANGE",
  "IPREGION",
] as const;

const entry = z.object({
  type: z.enum(ENTRY_TYPES).describe("条目类型"),
  email: z.string().optional().describe("type=EMAIL 时必填"),
  domain: z.string().optional().describe("type=DOMAIN_NAME 时必填"),
  ipAddress: z.string().optional().describe("type=IPV4ADDRESS / IPV6ADDRESS 时必填，如 192.168.1.1、2001:db8::1"),
  ipAddressRange: z
    .object({ begin: z.string(), end: z.string() })
    .optional()
    .describe("type=IPV4ADDRESSRANGE / IPV6ADDRESSRANGE 时必填"),
  ipRegion: z
    .object({
      countryCode: z.string().describe("国家代码，如 CN"),
      provinceCode: z.string().optional(),
      cityCode: z.string().optional(),
    })
    .optional()
    .describe("type=IPREGION 时必填"),
});
type Entry = z.infer<typeof entry>;

const REQUIRED_FIELD: Record<(typeof ENTRY_TYPES)[number], keyof Entry> = {
  EMAIL: "email",
  DOMAIN_NAME: "domain",
  IPV4ADDRESS: "ipAddress",
  IPV6ADDRESS: "ipAddress",
  IPV4ADDRESSRANGE: "ipAddressRange",
  IPV6ADDRESSRANGE: "ipAddressRange",
  IPREGION: "ipRegion",
};

/** Keeps only the value field matching each entry's type, rejecting entries that lack it. */
function normalizeEntries(entries: Entry[]): Entry[] {
  return entries.map((e, i) => {
    const field = REQUIRED_FIELD[e.type];
    if (e[field] === undefined || e[field] === "") {
      throw new ToolInputError(`entities[${i}]：type=${e.type} 时必须提供 ${field}`);
    }
    return { type: e.type, [field]: e[field] } as Entry;
  });
}

// ---------- quarantine ----------

const mailbox = z
  .string()
  .refine(isEmail, "invalid email")
  .describe("隔离区所属用户的邮箱地址");
const messageId = z.string().min(1).describe("隔离邮件 ID（来自 search_quarantine_messages）");
const quarantinePath = (email: string) => `/v2/users/${seg(email)}/quarantine/messages`;

interface QuarantineItem {
  message?: { id?: string; subject?: string; from?: unknown; receivedDateTime?: string; sentDateTime?: string; hasAttachments?: boolean };
  reason?: string;
  senderIp?: string;
  scanStatus?: string;
  processStatus?: string;
}

async function quarantineSummary(ctx: ToolContext, email: string, id: string) {
  const r = await ctx.client
    .get<{ message?: QuarantineItem }>(`${quarantinePath(email)}/${seg(id)}`)
    .catch(() => undefined);
  const q = r?.message;
  if (!q) return { id, found: false };
  return {
    id,
    subject: q.message?.subject,
    from: q.message?.from,
    sentDateTime: q.message?.sentDateTime,
    hasAttachments: q.message?.hasAttachments,
    reason: q.reason,
    senderIp: q.senderIp,
    scanStatus: q.scanStatus,
    processStatus: q.processStatus,
  };
}

export const securityTools: AnyToolDef[] = [
  // ---------- read ----------
  defineTool({
    name: "list_allow_block_list",
    title: "查询域级收信黑白名单",
    toolset: "security",
    kind: "read",
    description: "查询组织的域级收信白名单或黑名单条目，可按邮件地址、域名、IP 关键词模糊搜索。",
    inputSchema: {
      type: listType,
      keyword: z.string().optional().describe("关键词，按邮件地址、域名、IP 模糊匹配"),
    },
    handler: async (a, { client }) =>
      client.get("/v2/messageRules/allowBlockLists", { type: a.type, keyword: a.keyword }),
  }),
  defineTool({
    name: "search_quarantine_messages",
    title: "搜索隔离区邮件",
    toolset: "security",
    kind: "read",
    description:
      "搜索指定用户隔离区中被反垃圾 / 反病毒 / 反钓鱼规则拦截的邮件（隔离邮件只保留 30 天），游标分页。结果含隔离原因、发件 IP、AI 扫描与处理状态。",
    inputSchema: {
      email: mailbox,
      from: z.string().optional().describe("发件人"),
      recipient: z.string().optional().describe("收件人"),
      subject: z.string().optional().describe("主题"),
      startTime: z.string().optional().describe("开始时间（ISO 8601）"),
      endTime: z.string().optional().describe("结束时间（ISO 8601）"),
      isProcessed: z.boolean().optional().describe("增强版专用：true 已处理 / false 处理中"),
      cursor: z.string().optional().describe("上一页返回的 nextCursor"),
      size: z.number().int().min(1).max(50).optional().default(20).describe("每页数量，最大 50"),
      select: z.string().optional().describe("透传 $select，如 toRecipients,receivedDateTime,internetMessageId"),
    },
    handler: async ({ email, select, ...q }, ctx) => {
      ctx.scope.assertEmail(email, "隔离区用户");
      return ctx.client.get(`${quarantinePath(email)}/search`, { ...q, $select: select });
    },
  }),
  defineTool({
    name: "get_quarantine_message",
    title: "获取隔离区邮件详情",
    toolset: "security",
    kind: "read",
    description: "获取隔离邮件详情。正文需通过 select=body 获取。",
    inputSchema: {
      email: mailbox,
      id: messageId,
      select: z.string().optional().describe("透传 $select，如 body,toRecipients,ccRecipients,internetMessageHeaders"),
    },
    handler: async (a, ctx) => {
      ctx.scope.assertEmail(a.email, "隔离区用户");
      return ctx.client.get(`${quarantinePath(a.email)}/${seg(a.id)}`, { $select: a.select });
    },
  }),
  defineTool({
    name: "list_quarantine_attachments",
    title: "查询隔离区邮件附件",
    toolset: "security",
    kind: "read",
    description: "列出隔离邮件的全部附件（名称、大小、是否内联、附件 ID）。",
    inputSchema: { email: mailbox, id: messageId },
    handler: async (a, ctx) => {
      ctx.scope.assertEmail(a.email, "隔离区用户");
      return ctx.client.get(`${quarantinePath(a.email)}/${seg(a.id)}/attachments`);
    },
  }),
  defineTool({
    name: "get_quarantine_attachment_url",
    title: "获取隔离区附件下载地址",
    toolset: "security",
    kind: "read",
    description:
      "获取隔离邮件附件的临时下载地址。隔离附件可能含恶意内容，请勿在不安全的环境中打开；下载地址属于敏感信息，不要转发或写入日志。",
    inputSchema: { email: mailbox, id: messageId, attachmentId: z.string().min(1).describe("附件 ID") },
    handler: async (a, ctx) => {
      ctx.scope.assertEmail(a.email, "隔离区用户");
      return ctx.client.getRedirect(
        `${quarantinePath(a.email)}/${seg(a.id)}/attachments/${seg(a.attachmentId)}/$value`,
      );
    },
  }),

  // ---------- destructive ----------
  defineTool({
    name: "add_allow_block_entries",
    title: "添加域级收信黑白名单",
    toolset: "security",
    kind: "destructive",
    description:
      "向域级收信白名单或黑名单批量添加条目（邮件地址、域名、IP、IP 段或 IP 归属地区域），对全组织生效。白名单命中的邮件将跳过拦截直接投递，黑名单命中的邮件将被拒收，请严格核对范围。",
    inputSchema: { type: listType, entities: z.array(entry).min(1).max(100).describe("待添加的条目") },
    preview: async (a) => ({
      list: a.type,
      entities: normalizeEntries(a.entities),
      scope: "全组织",
      warning: a.type === "ALLOW" ? "白名单会让命中的来信绕过反垃圾/反钓鱼拦截" : "黑名单会拒收命中的全部来信",
    }),
    handler: async (a, { client }) =>
      client.post("/v2/messageRules/allowBlockLists", { type: a.type, entities: normalizeEntries(a.entities) }),
  }),
  defineTool({
    name: "remove_allow_block_entries",
    title: "删除域级收信黑白名单",
    toolset: "security",
    kind: "destructive",
    description: "按条目 ID 批量删除域级收信黑白名单条目。type 必须与条目所在名单一致。",
    inputSchema: {
      type: listType,
      ids: z.array(z.string().min(1)).min(1).max(100).describe("条目 ID（来自 list_allow_block_list）"),
    },
    preview: async (a, { client }) => {
      const r = await client
        .get<{ entities?: (Entry & { id?: string })[] }>("/v2/messageRules/allowBlockLists", { type: a.type })
        .catch(() => undefined);
      const byId = new Map((r?.entities ?? []).map((e) => [e.id, e]));
      return {
        list: a.type,
        entitiesToRemove: a.ids.map((id: string) => byId.get(id) ?? { id, found: r ? false : "unknown" }),
      };
    },
    handler: async (a, { client }) =>
      client.post("/v2/messageRules/allowBlockLists/batchDelete", { type: a.type, ids: a.ids }),
  }),
  defineTool({
    name: "release_quarantine_message",
    title: "放行隔离区邮件",
    toolset: "security",
    kind: "destructive",
    description: "将隔离邮件放行，使其进入正常投递流程（投递到收件人邮箱）。放行前务必确认不是钓鱼或恶意邮件。",
    inputSchema: { email: mailbox, id: messageId },
    authorize: async (a, ctx) => ctx.scope.assertEmail(a.email, "隔离区用户"),
    preview: async (a, ctx) => ({ mailbox: a.email, message: await quarantineSummary(ctx, a.email, a.id) }),
    handler: async (a, { client }) => client.post(`${quarantinePath(a.email)}/${seg(a.id)}/release`, {}),
  }),
  defineTool({
    name: "delete_quarantine_messages",
    title: "删除隔离区邮件",
    toolset: "security",
    kind: "destructive",
    description:
      "批量删除隔离邮件。deleteType：USER_DELETED 移到已删除（默认）/ ENTERPRISE_TRASH 移到企业回收站（可恢复）/ PERMANENT 永久删除。",
    inputSchema: {
      email: mailbox,
      ids: z.array(z.string().min(1)).min(1).max(50).describe("隔离邮件 ID 列表"),
      deleteType: z.enum(["USER_DELETED", "ENTERPRISE_TRASH", "PERMANENT"]).optional(),
    },
    authorize: async (a, ctx) => ctx.scope.assertEmail(a.email, "隔离区用户"),
    preview: async (a, ctx) => ({
      mailbox: a.email,
      deleteType: a.deleteType ?? "USER_DELETED",
      irreversible: a.deleteType === "PERMANENT",
      messages: await Promise.all(a.ids.map((id: string) => quarantineSummary(ctx, a.email, id))),
    }),
    handler: async (a, { client }) =>
      client.post(`${quarantinePath(a.email)}/batchDelete`, { ids: a.ids, deleteType: a.deleteType }),
  }),
];
