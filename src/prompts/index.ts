import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer, config: Config): void {
  if (!config.toolsets.includes("users") || !config.toolsets.includes("departments")) return;

  const readOnlyNote = config.readOnly
    ? "\n\n注意：服务当前处于只读模式（ALIMAIL_READ_ONLY=true），写操作工具不可用。请只做检查与方案输出，并提示管理员需要关闭只读模式才能执行。"
    : "";

  server.registerPrompt(
    "onboard_employee",
    {
      title: "新员工入职开户",
      description: "引导完成：确认部门 → 创建账号 → 设置别名/邮箱策略 → 汇总结果",
      argsSchema: {
        name: z.string().describe("员工姓名"),
        email: z.string().describe("拟分配的邮箱地址"),
        department: z.string().describe("部门名称或部门 ID"),
        jobTitle: z.string().optional().describe("职位"),
        aliases: z.string().optional().describe("额外别名，逗号分隔"),
      },
    },
    (a) =>
      userMessage(`请为新员工开通阿里企业邮箱账号：
- 姓名：${a.name}
- 邮箱：${a.email}
- 部门：${a.department}
- 职位：${a.jobTitle ?? "（未提供）"}
- 额外别名：${a.aliases ?? "（无）"}

步骤：
1. 用 get_user 检查 ${a.email} 是否已存在；已存在则停止并报告。
2. 确定部门 ID：若「${a.department}」不是 ID，用 get_department_tree 查找名称匹配的部门；有多个候选时列出路径让我选择，不存在时询问是否用 create_department 创建。
3. 用 create_user 创建账号（不要自行编造密码，让工具自动生成），设置 name、departmentIds${a.jobTitle ? "、jobTitle" : ""}。
4. 如有额外别名，逐个调用 add_email_alias。
5. 汇总：用户 ID、邮箱、部门路径、别名，以及初始密码（提醒我通过安全渠道转交且仅显示一次）。${readOnlyNote}`),
  );

  server.registerPrompt(
    "offboard_employee",
    {
      title: "员工离职处理",
      description: "引导完成：核对账号 → 撤销登录态 → 冻结/重置密码 → 交接共享 → （可选）删除",
      argsSchema: {
        user: z.string().describe("离职员工的邮箱或用户 ID"),
        handoverTo: z.string().optional().describe("交接人邮箱（授予其访问离职邮箱的权限）"),
        deleteAccount: z.string().optional().describe("是否最终删除账号：yes / no（默认 no）"),
      },
    },
    (a) =>
      userMessage(`请处理员工离职：${a.user}
交接人：${a.handoverTo ?? "（无）"}
是否删除账号：${a.deleteAccount ?? "no"}

步骤（每个破坏性操作都要先展示预览并等我确认）：
1. 用 get_user 核对账号信息（姓名、部门、别名、状态），用 list_shared_members 查看现有共享关系。
2. 用 revoke_user_sessions 撤销其所有登录态。
3. 用 update_user 将 status 设为 FREEZE，statusChangeReason 写「离职」。
4. 用 reset_password 重置为随机密码（防止旧密码继续使用）。
${a.handoverTo ? `5. 用 add_shared_members 将 ${a.handoverTo} 以 type=USER、relationships=["LOGIN"] 加为共享成员，便于交接邮件。\n` : ""}${a.deleteAccount === "yes" ? "6. 最后用 delete_user 删除账号（不可逆，务必再次确认）。\n" : ""}最后汇总每一步的执行结果。${readOnlyNote}`),
  );
}
