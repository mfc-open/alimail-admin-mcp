import { z } from "zod";
import { seg } from "../client/http.js";
import { isEmail } from "../guard/scope.js";
import { defineTool, ToolInputError, type AnyToolDef, type ToolContext } from "./registry.js";

const groupRef = z.string().min(1).describe("邮件组 ID 或邮件组邮箱地址");

const select = z
  .string()
  .optional()
  .describe("透传 $select，指定额外返回字段，多个用英文逗号分隔，如 type,admins,allowedSenderPolicy,departmentId,itemCountLimit");

const memberEmails = z
  .array(z.string().refine(isEmail, "invalid email"))
  .min(1)
  .max(50)
  .describe("成员邮箱地址列表，一次最多 50 个");

const groupWritable = {
  status: z.enum(["NORMAL", "FREEZE"]).optional().describe("状态：NORMAL 正常 / FREEZE 冻结"),
  admins: z.array(z.string()).optional().describe("邮件组管理员邮箱列表"),
  allowedSenderPolicy: z
    .enum(["ANYONE", "SAME_ORGANIZATION", "GROUP_MEMBER", "ONLY_ALLOWED_SENDER", "GROUP_MEMBER_AND_ALLOWED_SENDER"])
    .optional()
    .describe("谁可以向该组发信：所有人 / 本组织 / 组成员 / 仅 allowedSenders / 组成员与 allowedSenders"),
  allowedSenders: z.array(z.string()).optional().describe("允许向该组发信的地址（配合 allowedSenderPolicy）"),
  needMessageDeliveryReview: z.boolean().optional().describe("投递到该组的邮件是否需要审核"),
  messageDeliveryReviewers: z.array(z.string()).optional().describe("投递审核员邮箱列表"),
  dynamicMatchRule: z.string().optional().describe("动态组的成员匹配规则（仅 DYNAMIC 类型）"),
  itemCountLimit: z.number().int().min(1).max(100000).optional().describe("最大成员数，不超过 100000"),
  departmentId: z.string().optional().describe("归属部门 ID"),
  isHidden: z.boolean().optional().describe("是否在通讯录中隐藏该组"),
  ignoreAutoReplyOfMember: z.boolean().optional().describe("是否忽略成员的自动回复"),
  sendMessageToNewMember: z.boolean().optional().describe("是否给新加入的成员发送通知信"),
  requireApprovalWhenMemberLeaves: z.boolean().optional().describe("成员退出是否需要管理员审核"),
  memberOnlyVisibleToAdmin: z.boolean().optional().describe("成员列表是否仅管理员可见"),
};

const groupPath = (g: string) => `/v2/groups/${seg(g)}`;

interface GroupBasic {
  id?: string;
  email?: string;
  name?: string;
  status?: string;
  type?: string;
  itemCount?: number;
}

/** Ensures the target group is inside ALIMAIL_ALLOWED_DOMAINS, resolving IDs to emails when needed. */
async function ensureGroupAllowed(ctx: ToolContext, group: string): Promise<void> {
  if (!ctx.scope.restricted) return;
  if (isEmail(group)) {
    ctx.scope.assertEmail(group, "邮件组");
    return;
  }
  const g = await ctx.client.get<GroupBasic>(groupPath(group));
  ctx.scope.assertEmail(g.email ?? "", "邮件组");
}

async function groupSummary(ctx: ToolContext, group: string) {
  const g = await ctx.client.get<GroupBasic>(groupPath(group), { $select: "type" });
  return { id: g.id, email: g.email, name: g.name, status: g.status, type: g.type, memberCount: g.itemCount };
}

export const groupTools: AnyToolDef[] = [
  // ---------- read ----------
  defineTool({
    name: "list_groups",
    title: "查询邮件组列表",
    toolset: "groups",
    kind: "read",
    description: `按 filter 表达式查询组织内的邮件组，游标分页。
filter 支持字段：email、name、status、domain、type（STATIC 静态组 / DEPARTMENT 部门组 / DYNAMIC 动态组 / USERGROUP 群组 / DING 钉钉组）。
示例：(name=*研发*)；(|(name=Jack)(email=*jack*))；(&(type=DYNAMIC)(status=FREEZE))；(domain=example.com)。
返回 hasMore=true 时用 nextCursor 继续翻页。`,
    inputSchema: {
      filter: z.string().optional().describe("LDAP 风格过滤表达式"),
      cursor: z.string().optional().describe("上一页返回的 nextCursor"),
      size: z.number().int().min(1).max(100).optional().default(30).describe("每页数量"),
      orderby: z.enum(["email", "name", "createdTime"]).optional().describe("排序字段，默认按创建时间倒序"),
      order: z.enum(["ASC", "DES"]).optional().describe("ASC 升序 / DES 降序"),
      select,
    },
    handler: async (a, { client }) =>
      client.get("/v2/groups", {
        filter: a.filter,
        cursor: a.cursor,
        size: a.size,
        orderby: a.orderby,
        order: a.order,
        $select: a.select,
      }),
  }),
  defineTool({
    name: "get_group",
    title: "获取邮件组信息",
    toolset: "groups",
    kind: "read",
    description: "根据邮件组 ID 或邮箱地址获取邮件组信息。",
    inputSchema: { group: groupRef, select },
    handler: async (a, ctx) => {
      await ensureGroupAllowed(ctx, a.group);
      return ctx.client.get(groupPath(a.group), { $select: a.select });
    },
  }),
  defineTool({
    name: "list_group_members",
    title: "查询邮件组成员",
    toolset: "groups",
    kind: "read",
    description: "查询邮件组的成员邮箱列表（offset/limit 分页，limit 最大 10000）。",
    inputSchema: {
      group: groupRef,
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(10000).optional().default(1000),
    },
    handler: async (a, ctx) => {
      await ensureGroupAllowed(ctx, a.group);
      return ctx.client.get(`${groupPath(a.group)}/members`, { offset: a.offset, limit: a.limit });
    },
  }),

  // ---------- write ----------
  defineTool({
    name: "create_group",
    title: "创建邮件组",
    toolset: "groups",
    kind: "write",
    description: "创建邮件组。邮件组地址必须可用，所属域名必须存在且未被冻结。",
    inputSchema: {
      name: z.string().min(1).describe("组名"),
      email: z.string().refine(isEmail, "invalid email").describe("邮件组地址"),
      type: z.enum(["STATIC", "DYNAMIC"]).optional().describe("组类型：STATIC 静态组 / DYNAMIC 动态组（需同时提供 dynamicMatchRule）"),
      ...groupWritable,
    },
    authorize: async (a, ctx) => ctx.scope.assertEmail(a.email, "邮件组地址"),
    handler: async (a, { client }) => client.post("/v2/groups", a),
  }),
  defineTool({
    name: "update_group",
    title: "更新邮件组",
    toolset: "groups",
    kind: "write",
    idempotent: true,
    description: "更新邮件组信息（仅修改传入字段）。可修改名称、状态（FREEZE 为冻结）、发信权限、审核设置等。",
    inputSchema: { group: groupRef, name: z.string().min(1).optional().describe("组名"), ...groupWritable },
    authorize: async (a, ctx) => ensureGroupAllowed(ctx, a.group),
    handler: async ({ group, ...fields }, { client }) => {
      if (Object.values(fields).every((v) => v === undefined)) {
        throw new ToolInputError("至少需要提供一个要更新的字段");
      }
      return client.patch(groupPath(group), fields);
    },
  }),
  defineTool({
    name: "add_group_members",
    title: "添加邮件组成员",
    toolset: "groups",
    kind: "write",
    description:
      "向邮件组批量添加成员（最多 50 个），返回 successes / failures。邮件组被冻结或超过成员数上限时失败。成员可以是外部地址，不受 ALIMAIL_ALLOWED_DOMAINS 限制。",
    inputSchema: { group: groupRef, members: memberEmails },
    authorize: async (a, ctx) => ensureGroupAllowed(ctx, a.group),
    handler: async (a, { client }) =>
      client.post(`${groupPath(a.group)}/members/batchAdd`, { members: a.members }),
  }),

  // ---------- destructive ----------
  defineTool({
    name: "remove_group_members",
    title: "移除邮件组成员",
    toolset: "groups",
    kind: "destructive",
    description: "从邮件组批量移除成员（最多 50 个），返回 successes / failures。",
    inputSchema: { group: groupRef, members: memberEmails },
    authorize: async (a, ctx) => ensureGroupAllowed(ctx, a.group),
    preview: async (a, ctx) => ({ target: await groupSummary(ctx, a.group), membersToRemove: a.members }),
    handler: async (a, { client }) =>
      client.post(`${groupPath(a.group)}/members/batchDelete`, { members: a.members }),
  }),
  defineTool({
    name: "delete_group",
    title: "删除邮件组",
    toolset: "groups",
    kind: "destructive",
    description: "删除邮件组，删除后该组地址将无法收信。只想暂停使用可改用 update_group 将 status 设为 FREEZE。",
    inputSchema: { group: groupRef },
    authorize: async (a, ctx) => ensureGroupAllowed(ctx, a.group),
    preview: async (a, ctx) => ({ target: await groupSummary(ctx, a.group), irreversible: true }),
    handler: async (a, { client }) => {
      await client.delete(groupPath(a.group));
      return { ok: true, deleted: a.group };
    },
  }),
];
