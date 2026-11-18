import { z } from "zod";
import { isEmail } from "../guard/scope.js";
import { defineTool, type AnyToolDef } from "./registry.js";

export const auditTools: AnyToolDef[] = [
  defineTool({
    name: "query_audit_logs",
    title: "查询审计日志",
    toolset: "audit",
    kind: "read",
    description: `查询组织或指定操作者的审计日志（登录、收发信、账号变更、邮件组、隔离区、管理操作等），offset/limit 分页，hasMore=true 时增加 offset 继续读取。
activities 使用大写活动标识，["*"] 表示全部，常用值：USER_LOGIN、MAIL_SENT、MAIL_RECEIVED、MAIL_DELETED、AUTOFORWARD_CREATED、USER_CREATED、USER_DELETED、USER_UPDATED、USER_PASSWORD_RESET、USER_PASSWORD_CHANGED、USER_ALIAS_CREATED、GROUP_MEMBERS_ADDED、QUARANTINE_MAIL_RELEASED、THIRD_PARTY_APP_CREATED（完整列表见官方文档）。
filters 按日志属性过滤，如 {"ip":["1.2.3.4"]}、{"from":["a@x.com"],"to":["b@y.com"]}；不同属性之间为 AND，同一属性多个值为 OR。`,
    inputSchema: {
      beginTimestamp: z.string().describe("开始时间（ISO 8601，如 2026-11-01T00:00:00+08:00）"),
      endTimestamp: z.string().describe("结束时间（ISO 8601）"),
      activities: z.array(z.string().min(1)).min(1).optional().default(["*"]).describe("活动类型列表，默认 [\"*\"]"),
      email: z.string().refine(isEmail, "invalid email").optional().describe("只查询该操作者的日志"),
      filters: z.record(z.string(), z.array(z.string())).optional().describe("按属性过滤，值为候选值数组"),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(1000).optional().default(100),
    },
    handler: async (a, ctx) => {
      if (a.email) ctx.scope.assertEmail(a.email, "操作者");
      return ctx.client.post(
        "/v2/reports",
        {
          ...a,
          filters: a.filters
            ? Object.fromEntries(Object.entries(a.filters).map(([k, v]) => [k, JSON.stringify(v)]))
            : undefined,
        },
        undefined,
        true,
      );
    },
  }),
];
