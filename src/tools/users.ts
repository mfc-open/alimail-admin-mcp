import { randomInt } from "node:crypto";
import { z } from "zod";
import { seg } from "../client/http.js";
import { isEmail } from "../guard/scope.js";
import { defineTool, ToolInputError, type AnyToolDef, type ToolContext } from "./registry.js";

const userRef = z
  .string()
  .min(1)
  .describe("用户 ID 或邮箱地址（主邮箱或别名）");

const select = z
  .string()
  .optional()
  .describe("透传 $select，指定额外返回字段，多个用英文逗号分隔，如 phone,managerEmail,isHidden");

const employeeType = z.enum(["EMPLOYEE", "CONTRACTOR", "INTERN", "SERVICE", "WORK_ACCOUNT"]);

const userWritableFields = {
  name: z.string().min(1).describe("姓名"),
  nickname: z.string().optional().describe("昵称 / 花名"),
  customName: z.string().optional().describe("自定义展示名（发信时显示）"),
  defaultSendEmail: z.string().optional().describe("默认发信邮箱"),
  employeeNo: z.string().optional().describe("工号"),
  jobTitle: z.string().optional().describe("职位"),
  workLocation: z.string().optional().describe("工作地"),
  officeLocation: z.string().optional().describe("工位"),
  homeLocation: z.string().optional().describe("居住地"),
  departmentIds: z.array(z.string()).min(1).describe("所属部门 ID 列表（可多个，非部门链）"),
  phone: z.string().optional().describe("手机号"),
  workPhone: z.string().optional().describe("工作电话"),
  status: z.enum(["NORMAL", "FREEZE"]).optional().describe("账号状态：NORMAL 正常 / FREEZE 冻结"),
  statusChangeReason: z.string().optional().describe("状态变更原因"),
  preferredLanguage: z.string().optional().describe("语言偏好，如 zh-CN、en-US"),
  managerEmail: z.string().optional().describe("主管邮箱"),
  isHidden: z.boolean().optional().describe("是否在通讯录中隐藏"),
  info: z.string().optional().describe("备注"),
  forceChangePasswordNextSignIn: z.boolean().optional().describe("下次登录是否强制修改密码"),
  employeeType: employeeType.optional().describe("账号类型"),
  passwordExpireTime: z.string().optional().describe("密码过期时间（ISO 8601）"),
  orderInDepartments: z
    .array(z.object({ departmentId: z.string(), order: z.string() }))
    .optional()
    .describe("在各部门下的排序值；必须提供全量部门的排序值，否则未提供部门的排序会丢失"),
  customFields: z.record(z.string(), z.string()).optional().describe("自定义字段，支持部分修改"),
};

const sharedMember = z.object({
  type: z.enum(["USER", "DEPARTMENT", "GROUP"]).describe("成员类型"),
  value: z.string().describe("USER→用户邮箱；DEPARTMENT→部门 ID；GROUP→邮件组邮箱"),
  relationships: z
    .array(z.enum(["LOGIN", "SEND_AS", "SEND_ON_BEHALF"]))
    .optional()
    .describe("共享关系：LOGIN 登录 / SEND_AS 代表发信 / SEND_ON_BEHALF 代发"),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional().describe("委托审批状态（自助委托场景）"),
});

const userPath = (u: string) => `/v2/users/${seg(u)}`;

interface UserBasic {
  id?: string;
  email?: string;
  name?: string;
  status?: string;
  emailAliases?: string[];
  departmentIds?: string[];
}

/** Ensures the target user is inside ALIMAIL_ALLOWED_DOMAINS, resolving IDs to emails when needed. */
async function ensureUserAllowed(ctx: ToolContext, user: string): Promise<void> {
  if (!ctx.scope.restricted) return;
  if (isEmail(user)) {
    ctx.scope.assertEmail(user, "用户");
    return;
  }
  const u = await ctx.client.get<UserBasic>(userPath(user));
  ctx.scope.assertEmail(u.email ?? "", "用户");
}

async function userSummary(ctx: ToolContext, user: string) {
  const u = await ctx.client.get<UserBasic>(userPath(user));
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    emailAliases: u.emailAliases,
    departmentIds: u.departmentIds,
  };
}

function checkMemberScope(ctx: ToolContext, members: z.infer<typeof sharedMember>[]) {
  for (const m of members) {
    if (m.type !== "DEPARTMENT") ctx.scope.assertEmail(m.value, "共享成员");
  }
}

const PW_SETS = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_=+?"];

/** Generates a random password containing every character class. */
export function generatePassword(length = 16): string {
  const all = PW_SETS.join("");
  const chars = PW_SETS.map((s) => s[randomInt(s.length)]!);
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export const userTools: AnyToolDef[] = [
  // ---------- read ----------
  defineTool({
    name: "list_users",
    title: "查询用户列表",
    toolset: "users",
    kind: "read",
    description: `按 filter 表达式查询组织内用户，游标分页（单页最多 100）。
filter 支持字段：email、name、nickname、employeeNo、status、domain、employeeType、delegateType、departmentId、jobTitle、workLocation、homeLocation、info、managerId、isSharedWithOthers。
示例：(departmentId=xxx) 直属成员；(departmentId=xxx*) 含子部门；(|(name=Jack)(email=*jack*))；(&(employeeType=SERVICE)(email=*abc*))；(&(departmentId=xxx)(!(status=FREEZE)))。
返回 hasMore=true 时用 nextCursor 继续翻页。`,
    inputSchema: {
      filter: z.string().optional().describe("LDAP 风格过滤表达式"),
      cursor: z.string().optional().describe("上一页返回的 nextCursor"),
      size: z.number().int().min(1).max(100).optional().default(50).describe("每页数量，最大 100"),
      orderby: z.enum(["email", "name", "nickname", "employeeNo", "createdTime"]).optional(),
      order: z.enum(["ASC", "DES"]).optional().describe("ASC 升序 / DES 降序"),
      managed: z.boolean().optional().describe("仅返回当前身份可管理的用户"),
      select,
    },
    handler: async (a, { client }) =>
      client.get("/v2/users", {
        filter: a.filter,
        cursor: a.cursor,
        size: a.size,
        orderby: a.orderby,
        order: a.order,
        managed: a.managed,
        $select: a.select,
      }),
  }),
  defineTool({
    name: "get_user",
    title: "获取用户信息",
    toolset: "users",
    kind: "read",
    description: "根据用户 ID 或邮箱获取用户详情。",
    inputSchema: { user: userRef, select },
    handler: async (a, ctx) => {
      await ensureUserAllowed(ctx, a.user);
      return ctx.client.get(userPath(a.user), { $select: a.select });
    },
  }),
  defineTool({
    name: "get_users_by_ids",
    title: "批量获取用户信息",
    toolset: "users",
    kind: "read",
    description: "根据用户 ID 列表批量获取用户信息（最多 100 个），不存在的 ID 不返回。",
    inputSchema: { ids: z.array(z.string()).min(1).max(100), select },
    handler: async (a, { client }) =>
      client.post("/v2/users/listByIds", { ids: a.ids }, { $select: a.select }, true),
  }),
  defineTool({
    name: "get_mailbox_settings",
    title: "获取邮箱设置",
    toolset: "users",
    kind: "read",
    description:
      "获取用户邮箱设置（外部收发信限制、自动转发、附件大小、收件人数等）。字段多为可选字段，可用 select 指定，如 forbidSendMailToOutside,forwardingMode,attachmentSize。",
    inputSchema: { user: userRef, select },
    handler: async (a, ctx) => {
      await ensureUserAllowed(ctx, a.user);
      return ctx.client.get(`${userPath(a.user)}/mailboxSettings`, { $select: a.select });
    },
  }),
  defineTool({
    name: "list_shared_members",
    title: "查询共享账号成员",
    toolset: "users",
    kind: "read",
    description: "查询共享账号 / 委托账号的成员及其访问权限（LOGIN / SEND_AS / SEND_ON_BEHALF）与审批状态。",
    inputSchema: {
      user: userRef,
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional().default(100),
    },
    handler: async (a, ctx) => {
      await ensureUserAllowed(ctx, a.user);
      return ctx.client.get(`${userPath(a.user)}/sharedMembers`, {
        offset: a.offset,
        limit: a.limit,
      });
    },
  }),

  // ---------- write ----------
  defineTool({
    name: "create_user",
    title: "创建用户",
    toolset: "users",
    kind: "write",
    description:
      "在组织中创建邮箱账号。未提供 password 时自动生成符合复杂度的随机密码，并默认要求下次登录修改密码；生成的密码只在本次结果中返回一次。",
    inputSchema: {
      email: z.string().refine(isEmail, "invalid email").describe("邮箱地址"),
      password: z.string().optional().describe("初始密码；不传则自动生成"),
      ...userWritableFields,
    },
    authorize: async (a, ctx) => ctx.scope.assertEmail(a.email, "新用户邮箱"),
    handler: async (a, { client }) => {
      const generated = a.password ? undefined : generatePassword();
      const body = {
        ...a,
        password: a.password ?? generated,
        forceChangePasswordNextSignIn: a.forceChangePasswordNextSignIn ?? (generated ? true : undefined),
      };
      const user = await client.post("/v2/users", body);
      return generated
        ? { user, initialPassword: generated, note: "初始密码仅显示这一次，请通过安全渠道交给用户。" }
        : { user };
    },
  }),
  defineTool({
    name: "update_user",
    title: "更新用户信息",
    toolset: "users",
    kind: "write",
    idempotent: true,
    description:
      "更新用户资料（仅修改传入字段）。可修改姓名、部门、职位、状态（NORMAL/FREEZE 冻结）等。注意 departmentIds 为全量覆盖。",
    inputSchema: {
      user: userRef,
      ...Object.fromEntries(
        Object.entries(userWritableFields).map(([k, v]) => [k, (v as z.ZodType).optional()]),
      ),
    } as { user: typeof userRef } & {
      [K in keyof typeof userWritableFields]: z.ZodOptional<(typeof userWritableFields)[K]>;
    },
    authorize: async (a, ctx) => {
      await ensureUserAllowed(ctx, a.user);
      if (a.managerEmail) ctx.scope.assertEmail(a.managerEmail, "主管邮箱");
    },
    handler: async ({ user, ...fields }, { client }) => {
      if (Object.values(fields).every((v) => v === undefined)) {
        throw new ToolInputError("至少需要提供一个要更新的字段");
      }
      return client.patch(userPath(user), fields);
    },
  }),
  defineTool({
    name: "add_email_alias",
    title: "添加邮箱别名",
    toolset: "users",
    kind: "write",
    description: "为用户添加邮箱别名，可设为默认展示地址。",
    inputSchema: {
      user: userRef,
      alias: z.string().refine(isEmail, "invalid email").describe("完整别名邮箱地址"),
      asDefault: z.boolean().optional().describe("是否作为默认展示地址"),
    },
    authorize: async (a, ctx) => {
      await ensureUserAllowed(ctx, a.user);
      ctx.scope.assertEmail(a.alias, "别名");
    },
    handler: async (a, { client }) =>
      client.post(`${userPath(a.user)}/emailAliases`, { alias: a.alias, asDefault: a.asDefault }),
  }),
  defineTool({
    name: "update_mailbox_settings",
    title: "更新邮箱设置",
    toolset: "users",
    kind: "write",
    idempotent: true,
    description: "更新用户邮箱设置，仅修改传入的设置项。",
    inputSchema: {
      user: userRef,
      forbidReceiveMailFromOutside: z.boolean().optional().describe("禁止接收外部邮件"),
      forbidSendMailToOutside: z.boolean().optional().describe("禁止向外部发信"),
      forbidAutoForward: z.boolean().optional().describe("禁止自动转发"),
      forbidSendMail: z.boolean().optional().describe("禁止发信（true 即封禁发信）"),
      attachmentSize: z.number().int().positive().optional().describe("附件大小限制（MB）"),
      recipientCount: z.number().int().positive().optional().describe("单封收件人数上限"),
      forbidSendMailToOutsideExceptions: z.array(z.string()).optional().describe("禁止外发时的例外地址或域名"),
      forbidSendMailToOutsideExceptionsAlias: z.array(z.string()).optional().describe("禁止外发时不受限的发信别名"),
      forbidReceiveMailFromOutsideExceptions: z.array(z.string()).optional().describe("禁止外部收信时的例外地址"),
      forwardingMode: z
        .enum(["FORBIDDEN", "ALLOWED", "FORBIDOUTBOUND"])
        .optional()
        .describe("转发模式：FORBIDDEN 禁止 / ALLOWED 允许 / FORBIDOUTBOUND 仅允许内部转发"),
    },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    handler: async ({ user, ...settings }, { client }) => {
      if (Object.values(settings).every((v) => v === undefined)) {
        throw new ToolInputError("至少需要提供一个要更新的设置项");
      }
      return client.patch(`${userPath(user)}/mailboxSettings`, settings);
    },
  }),
  defineTool({
    name: "add_shared_members",
    title: "添加共享账号成员",
    toolset: "users",
    kind: "write",
    description:
      "为共享账号批量添加成员（最多 50 个）并设置权限。授予 LOGIN 后成员可直接访问该邮箱，请谨慎。",
    inputSchema: { user: userRef, members: z.array(sharedMember).min(1).max(50) },
    authorize: async (a, ctx) => {
      await ensureUserAllowed(ctx, a.user);
      checkMemberScope(ctx, a.members);
    },
    handler: async (a, { client }) =>
      client.post(`${userPath(a.user)}/sharedMembers/batchAdd`, { members: a.members }),
  }),
  defineTool({
    name: "update_shared_members",
    title: "更新共享账号成员",
    toolset: "users",
    kind: "write",
    idempotent: true,
    description: "批量更新共享账号成员权限：已存在的成员覆盖权限，不存在的成员新建访问关系。",
    inputSchema: { user: userRef, members: z.array(sharedMember).min(1).max(50) },
    authorize: async (a, ctx) => {
      await ensureUserAllowed(ctx, a.user);
      checkMemberScope(ctx, a.members);
    },
    handler: async (a, { client }) =>
      client.post(`${userPath(a.user)}/sharedMembers/batchUpdate`, { members: a.members }, undefined, true),
  }),
  defineTool({
    name: "bind_security_phone",
    title: "绑定安全手机号",
    toolset: "users",
    kind: "write",
    idempotent: true,
    description: "为用户绑定安全手机号（用于登录验证与账号安全操作）。",
    inputSchema: {
      user: userRef,
      phone: z.string().min(5).describe("手机号"),
      notify: z.boolean().optional().describe("是否邮件通知用户"),
    },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    handler: async (a, { client }) =>
      client.post(`${userPath(a.user)}/bindSecurityPhone`, { phone: a.phone, notify: a.notify }),
  }),

  // ---------- destructive ----------
  defineTool({
    name: "delete_user",
    title: "删除用户",
    toolset: "users",
    kind: "destructive",
    description: "删除邮箱账号。账号及其邮件数据将被删除，操作不可逆。离职场景建议先冻结（update_user status=FREEZE）。",
    inputSchema: { user: userRef },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    preview: async (a, ctx) => ({ target: await userSummary(ctx, a.user), irreversible: true }),
    handler: async (a, { client }) => {
      await client.delete(userPath(a.user));
      return { ok: true, deleted: a.user };
    },
  }),
  defineTool({
    name: "reset_password",
    title: "重置用户密码",
    toolset: "users",
    kind: "destructive",
    description:
      "管理员重置用户密码（无需旧密码）。未提供 password 时自动生成随机密码，仅在执行结果中返回一次。用户现有密码将立即失效。",
    inputSchema: {
      user: userRef,
      password: z.string().optional().describe("新密码；不传则自动生成"),
      forceChangePasswordNextSignIn: z.boolean().optional().default(true).describe("下次登录强制修改密码"),
    },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    preview: async (a, ctx) => ({
      target: await userSummary(ctx, a.user),
      passwordSource: a.password ? "provided" : "auto-generated",
      forceChangePasswordNextSignIn: a.forceChangePasswordNextSignIn,
    }),
    handler: async (a, { client }) => {
      const password = a.password ?? generatePassword();
      await client.post(`${userPath(a.user)}/resetPassword`, {
        password,
        forceChangePasswordNextSignIn: a.forceChangePasswordNextSignIn,
      });
      return a.password
        ? { ok: true }
        : { ok: true, newPassword: password, note: "新密码仅显示这一次，请通过安全渠道交给用户。" };
    },
  }),
  defineTool({
    name: "remove_email_alias",
    title: "删除邮箱别名",
    toolset: "users",
    kind: "destructive",
    description: "删除用户的邮箱别名，删除后该地址将无法收信。",
    inputSchema: { user: userRef, alias: z.string().refine(isEmail, "invalid email") },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    preview: async (a, ctx) => {
      const u = await userSummary(ctx, a.user);
      return {
        target: u,
        aliasToRemove: a.alias,
        aliasExists: u.emailAliases ? u.emailAliases.includes(a.alias) : "unknown",
      };
    },
    handler: async (a, { client }) =>
      client.delete(`${userPath(a.user)}/emailAliases/${seg(a.alias)}`),
  }),
  defineTool({
    name: "remove_shared_members",
    title: "删除共享账号成员",
    toolset: "users",
    kind: "destructive",
    description: "从共享账号中批量移除成员及其访问关系（成员用 type + value 指定）。",
    inputSchema: {
      user: userRef,
      members: z
        .array(sharedMember.pick({ type: true, value: true }))
        .min(1)
        .max(50),
    },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    preview: async (a, ctx) => ({ target: await userSummary(ctx, a.user), membersToRemove: a.members }),
    handler: async (a, { client }) =>
      client.post(`${userPath(a.user)}/sharedMembers/batchDelete`, { members: a.members }),
  }),
  defineTool({
    name: "unbind_security_phone",
    title: "解绑安全手机号",
    toolset: "users",
    kind: "destructive",
    description: "解除用户与当前安全手机号的绑定。",
    inputSchema: { user: userRef },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    preview: async (a, ctx) => ({ target: await userSummary(ctx, a.user) }),
    handler: async (a, { client }) => client.post(`${userPath(a.user)}/unbindSecurityPhone`, {}),
  }),
  defineTool({
    name: "revoke_user_sessions",
    title: "撤销用户全部登录态",
    toolset: "users",
    kind: "destructive",
    description: "撤销用户已签发的全部登录令牌，使所有已登录会话（网页、客户端）立即失效。常用于离职或账号疑似被盗。",
    inputSchema: { user: userRef },
    authorize: async (a, ctx) => ensureUserAllowed(ctx, a.user),
    preview: async (a, ctx) => ({ target: await userSummary(ctx, a.user) }),
    handler: async (a, { client }) => client.post(`${userPath(a.user)}/invalidateAllTokens`, {}),
  }),
];
