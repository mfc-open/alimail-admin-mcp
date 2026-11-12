import { z } from "zod";
import { seg, type AlimailClient } from "../client/http.js";
import { collectByOffset } from "../client/paginate.js";
import { defineTool, ToolInputError, type AnyToolDef } from "./registry.js";

const deptId = z.string().min(1).describe("部门 ID；使用 $root 表示组织根部门");
const select = z
  .string()
  .optional()
  .describe("透传 $select，如 hasUsers,hasSubDepartments,userCount,managers,email,isHidden,canManage");

const deptWritable = {
  hiddenExcludeUsers: z.array(z.string()).optional().describe("部门隐藏后仍可见该部门的用户 ID 白名单"),
  hiddenExcludeDepartments: z.array(z.string()).optional().describe("部门隐藏后仍可见该部门的部门 ID 白名单"),
  isHidden: z.boolean().optional().describe("是否隐藏部门"),
  managers: z.array(z.string()).optional().describe("部门主管用户 ID 列表"),
  email: z.string().optional().describe("部门邮件组地址"),
};

const deptPath = (id: string) => `/v2/departments/${seg(id)}`;

export interface Department {
  id: string;
  name: string;
  parentId?: string;
  [k: string]: unknown;
}

interface UserLite {
  id?: string;
  email?: string;
  name?: string;
  [k: string]: unknown;
}

export function listSubDepartments(client: AlimailClient, id: string, offset: number, limit: number, extra?: { managed?: boolean; select?: string }) {
  return client.get<{ departments?: Department[]; total?: number }>(`${deptPath(id)}/departments`, {
    offset,
    limit,
    managed: extra?.managed,
    $select: extra?.select,
  });
}

export function listDepartmentUsers(client: AlimailClient, id: string, offset: number, limit: number, extra?: { managed?: boolean; select?: string }) {
  return client.get<{ users?: UserLite[]; total?: number }>(`${deptPath(id)}/users`, {
    offset,
    limit,
    managed: extra?.managed,
    $select: extra?.select,
  });
}

export interface TreeNode {
  id: string;
  name: string;
  parentId?: string;
  children: TreeNode[];
  users?: { id?: string; email?: string; name?: string }[];
  usersTotal?: number;
  childrenTruncated?: boolean;
}

export async function buildDepartmentTree(
  client: AlimailClient,
  opts: { rootId?: string; maxDepth?: number; includeUsers?: boolean; maxNodes?: number; maxUsersPerDepartment?: number },
): Promise<{ tree: TreeNode; nodeCount: number; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 10;
  const maxNodes = opts.maxNodes ?? 2000;
  const maxUsers = opts.maxUsersPerDepartment ?? 200;
  const rootDept = await client.get<Department>(deptPath(opts.rootId ?? "$root"));
  const root: TreeNode = { id: rootDept.id, name: rootDept.name, parentId: rootDept.parentId, children: [] };
  const seen = new Set<string>([root.id]);
  let truncated = false;

  const queue: { node: TreeNode; depth: number }[] = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;

    if (opts.includeUsers) {
      const users = await collectByOffset(
        async (offset, limit) => {
          const r = await listDepartmentUsers(client, node.id, offset, limit);
          return { items: r.users ?? [], total: r.total };
        },
        { maxItems: maxUsers },
      );
      node.users = users.items.map((u) => ({ id: u.id, email: u.email, name: u.name }));
      node.usersTotal = users.total ?? users.items.length;
      if (users.truncated) truncated = true;
    }

    if (depth >= maxDepth) {
      node.childrenTruncated = true;
      truncated = true;
      continue;
    }
    const remaining = maxNodes - seen.size;
    if (remaining <= 0) {
      node.childrenTruncated = true;
      truncated = true;
      continue;
    }
    const subs = await collectByOffset(
      async (offset, limit) => {
        const r = await listSubDepartments(client, node.id, offset, limit);
        return { items: r.departments ?? [], total: r.total };
      },
      { maxItems: remaining + 1 },
    );
    for (const d of subs.items) {
      if (seen.has(d.id)) continue;
      if (seen.size >= maxNodes) {
        node.childrenTruncated = true;
        truncated = true;
        break;
      }
      seen.add(d.id);
      const child: TreeNode = { id: d.id, name: d.name, parentId: d.parentId, children: [] };
      node.children.push(child);
      queue.push({ node: child, depth: depth + 1 });
    }
  }
  return { tree: root, nodeCount: seen.size, truncated };
}

export const departmentTools: AnyToolDef[] = [
  // ---------- read ----------
  defineTool({
    name: "get_department",
    title: "获取部门信息",
    toolset: "departments",
    kind: "read",
    description: "根据部门 ID 获取部门信息；id 传 $root 返回组织根部门。",
    inputSchema: { id: deptId, select },
    handler: async (a, { client }) => client.get(deptPath(a.id), { $select: a.select }),
  }),
  defineTool({
    name: "get_departments_by_ids",
    title: "批量获取部门信息",
    toolset: "departments",
    kind: "read",
    description: "根据部门 ID 列表批量获取部门信息（最多 100 个），不存在的 ID 不返回。",
    inputSchema: { ids: z.array(z.string()).min(1).max(100), select },
    handler: async (a, { client }) =>
      client.post("/v2/departments/listByIds", { ids: a.ids }, { $select: a.select }, true),
  }),
  defineTool({
    name: "list_sub_departments",
    title: "查询子部门",
    toolset: "departments",
    kind: "read",
    description: "查询指定部门的直属子部门（offset/limit 分页，limit 最大 100）。需要整棵树请用 get_department_tree。",
    inputSchema: {
      id: deptId,
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(100).optional().default(100),
      managed: z.boolean().optional().describe("仅返回当前身份可管理的部门"),
      select,
    },
    handler: async (a, { client }) =>
      listSubDepartments(client, a.id, a.offset, a.limit, { managed: a.managed, select: a.select }),
  }),
  defineTool({
    name: "list_department_users",
    title: "查询部门成员",
    toolset: "departments",
    kind: "read",
    description: "查询指定部门的直属成员（offset/limit 分页，limit 最大 100）。如需含子部门成员，可用 list_users 的 filter (departmentId=xxx*)。",
    inputSchema: {
      id: deptId,
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(100).optional().default(100),
      managed: z.boolean().optional(),
      select: z.string().optional().describe("透传 $select，指定额外返回的用户字段"),
    },
    handler: async (a, { client }) =>
      listDepartmentUsers(client, a.id, a.offset, a.limit, { managed: a.managed, select: a.select }),
  }),
  defineTool({
    name: "get_department_chain",
    title: "获取部门层级链",
    toolset: "departments",
    kind: "read",
    description: "获取从根部门到目标部门的完整层级链。传 id 查询单个，传 ids 批量查询（最多 100 个）。",
    inputSchema: {
      id: z.string().optional().describe("单个部门 ID"),
      ids: z.array(z.string()).min(1).max(100).optional().describe("批量部门 ID"),
    },
    handler: async (a, { client }) => {
      if (a.ids?.length) return client.post("/v2/departments/listChainsByIds", { ids: a.ids }, undefined, true);
      if (a.id) return client.get(`${deptPath(a.id)}/chain`);
      throw new ToolInputError("需要提供 id 或 ids");
    },
  }),
  defineTool({
    name: "get_department_tree",
    title: "获取部门树",
    toolset: "departments",
    kind: "read",
    description:
      "从指定部门（默认根部门）递归获取完整部门树，自动处理分页。可选包含每个部门的直属成员。大型组织请设置 maxDepth / maxNodes 控制规模，结果中 truncated=true 表示被截断。",
    inputSchema: {
      rootId: z.string().optional().default("$root").describe("起始部门 ID，默认 $root"),
      maxDepth: z.number().int().min(0).max(50).optional().default(10).describe("最大递归深度"),
      maxNodes: z.number().int().min(1).max(10000).optional().default(2000).describe("最多返回的部门数量"),
      includeUsers: z.boolean().optional().default(false).describe("是否包含每个部门的直属成员（调用次数显著增加）"),
      maxUsersPerDepartment: z.number().int().min(1).max(1000).optional().default(200),
    },
    handler: async (a, { client }) => buildDepartmentTree(client, a),
  }),

  // ---------- write ----------
  defineTool({
    name: "create_department",
    title: "创建部门",
    toolset: "departments",
    kind: "write",
    description: "在指定父部门下创建部门。parentId 可用 $root 表示根部门。",
    inputSchema: {
      name: z.string().min(1).describe("部门名称"),
      parentId: z.string().min(1).describe("父部门 ID（$root 表示根部门）"),
      ...deptWritable,
    },
    handler: async (a, { client }) => {
      let parentId = a.parentId;
      if (parentId === "$root") parentId = (await client.get<Department>(deptPath("$root"))).id;
      return client.post("/v2/departments", { ...a, parentId });
    },
  }),
  defineTool({
    name: "update_department",
    title: "更新部门",
    toolset: "departments",
    kind: "write",
    idempotent: true,
    description: "更新部门信息（仅修改传入字段）。修改 parentId 即移动部门，不能把部门设为自身的父部门。",
    inputSchema: {
      id: z.string().min(1).describe("部门 ID"),
      name: z.string().min(1).optional(),
      parentId: z.string().optional().describe("新的父部门 ID（移动部门）"),
      ...deptWritable,
    },
    handler: async ({ id, ...fields }, { client }) => {
      if (Object.values(fields).every((v) => v === undefined)) {
        throw new ToolInputError("至少需要提供一个要更新的字段");
      }
      if (fields.parentId === "$root") {
        fields.parentId = (await client.get<Department>(deptPath("$root"))).id;
      }
      return client.patch(deptPath(id), fields);
    },
  }),

  // ---------- destructive ----------
  defineTool({
    name: "delete_department",
    title: "删除部门",
    toolset: "departments",
    kind: "destructive",
    description: "删除部门。存在成员或子部门的非空部门无法删除（返回 412）。",
    inputSchema: { id: z.string().min(1).describe("部门 ID") },
    preview: async (a, { client }) => {
      const d = await client.get<Department>(deptPath(a.id), {
        $select: "hasUsers,hasSubDepartments,userCount",
      });
      const chain = await client
        .get<{ departments?: { id: string; name: string }[] }>(`${deptPath(a.id)}/chain`)
        .catch(() => undefined);
      return {
        target: {
          id: d.id,
          name: d.name,
          path: chain?.departments?.map((x) => x.name).join(" / "),
          hasUsers: d.hasUsers,
          hasSubDepartments: d.hasSubDepartments,
          userCount: d.userCount,
        },
        willFail: d.hasUsers === true || d.hasSubDepartments === true ? "部门非空，删除将失败，请先迁移成员和子部门" : undefined,
      };
    },
    handler: async (a, { client }) => {
      await client.delete(deptPath(a.id));
      return { ok: true, deleted: a.id };
    },
  }),
];
