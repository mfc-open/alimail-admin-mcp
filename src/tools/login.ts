import { z } from "zod";
import { seg } from "../client/http.js";
import { isEmail } from "../guard/scope.js";
import { defineTool, type AnyToolDef } from "./registry.js";

export const loginTools: AnyToolDef[] = [
  defineTool({
    name: "create_login_link",
    title: "生成免登录链接",
    toolset: "login",
    kind: "destructive",
    description:
      "为指定用户生成一次性免登录链接（默认 1 分钟内有效）。任何拿到链接的人都能直接进入该用户的邮箱，只能在完成身份核验后通过安全渠道交付，切勿粘贴到聊天、工单或日志中。",
    inputSchema: {
      email: z.string().refine(isEmail, "invalid email").describe("目标用户邮箱"),
      redirectUrl: z.string().url().optional().describe("登录后跳转的地址域名，默认 https://qiye.aliyun.com，可设为企业自定义域名"),
      mailId: z.string().optional().describe("登录后直接打开的邮件 ID"),
      clientId: z.string().optional().describe("免登的目标应用，默认 webmail"),
    },
    authorize: async (a, ctx) => ctx.scope.assertEmail(a.email, "用户"),
    preview: async (a) => ({
      target: a.email,
      validFor: "约 1 分钟，一次性",
      risk: "持有链接即可访问该用户邮箱，请确认已完成身份核验",
    }),
    handler: async ({ email, ...body }, { client }) =>
      client.post(`/v2/users/${seg(email)}/passwordless/link`, body),
  }),
];
