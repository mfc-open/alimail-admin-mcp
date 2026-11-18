import { z } from "zod";
import { seg, type AlimailClient } from "../client/http.js";
import { collectByOffset } from "../client/paginate.js";
import { isEmail } from "../guard/scope.js";
import { defineTool, ToolInputError, type AnyToolDef } from "./registry.js";
import { buildTree, type TreeItem } from "./tree.js";

const folderId = z.string().min(1).describe("公共联系人分组 ID；使用 $root 表示根分组");
const contactSelect = z
  .string()
  .optional()
  .describe("透传 $select，指定额外返回的联系人字段，如 phone,workPhone,companyName,jobTitle,folderPath,nickname,info");
const folderSelect = z
  .string()
  .optional()
  .describe("透传 $select，如 contactCount,childFolderCount,isHidden,hiddenExcludeUsers,hiddenExcludeDepartments");

const contactFields = {
  workPhone: z.string().optional().describe("工作电话"),
  phone: z.string().optional().describe("个人手机号"),
  homeAddress: z.string().optional().describe("家庭地址"),
  companyName: z.string().optional().describe("公司"),
  jobTitle: z.string().optional().describe("职位"),
  workAddress: z.string().optional().describe("工作地址"),
  nickname: z.string().optional().describe("昵称 / 花名"),
  manager: z.string().optional().describe("主管邮箱"),
  info: z.string().optional().describe("备注"),
  isHidden: z.boolean().optional().describe("是否在通讯录中隐藏"),
  department: z.string().optional().describe("部门（文本）"),
  officeLocation: z.string().optional().describe("办公地点"),
};

const folderFields = {
  hiddenExcludeUsers: z.array(z.string()).optional().describe("分组隐藏后仍可见的用户 ID 白名单"),
  hiddenExcludeDepartments: z.array(z.string()).optional().describe("分组隐藏后仍可见的部门 ID 白名单"),
  isHidden: z.boolean().optional().describe("是否隐藏分组"),
};

const page = {
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(100).optional().default(100),
  managed: z.boolean().optional().describe("仅返回当前身份可管理的数据"),
};

const folderPath = (id: string) => `/v2/sharedContactFolders/${seg(id)}`;
const contactPath = (id: string) => `/v2/sharedContacts/${seg(id)}`;

interface Folder extends TreeItem {
  contactCount?: number;
  childFolderCount?: number;
}

interface Contact {
  id?: string;
  name?: string;
  email?: string;
  folderId?: string;
  [k: string]: unknown;
}

/** The API identifies the root folder as $root in paths; resolve it to a real ID for request bodies. */
async function resolveRootFolder(client: AlimailClient, id: string): Promise<string> {
  return id === "$root" ? (await client.get<Folder>(folderPath("$root"))).id : id;
}

function listChildFolders(client: AlimailClient, id: string, offset: number, limit: number, extra?: { managed?: boolean; select?: string }) {
  return client.get<{ folders?: Folder[]; total?: number }>(`${folderPath(id)}/childFolders`, {
    offset,
    limit,
    managed: extra?.managed,
    $select: extra?.select,
  });
}

function listFolderContacts(client: AlimailClient, id: string, offset: number, limit: number, extra?: { managed?: boolean; select?: string }) {
  return client.get<{ contacts?: Contact[]; total?: number }>(`${folderPath(id)}/contacts`, {
    offset,
    limit,
    managed: extra?.managed,
    $select: extra?.select,
  });
}

export const contactTools: AnyToolDef[] = [
  // ---------- read ----------
  defineTool({
    name: "get_shared_contact",
    title: "获取公共联系人",
    toolset: "contacts",
    kind: "read",
    description: "根据 ID 获取企业公共通讯录中的联系人信息。",
    inputSchema: { id: z.string().min(1).describe("联系人 ID"), select: contactSelect },
    handler: async (a, { client }) => client.get(contactPath(a.id), { $select: a.select }),
  }),
  defineTool({
    name: "get_contact_folder",
    title: "获取公共联系人分组",
    toolset: "contacts",
    kind: "read",
    description: "根据分组 ID 获取公共联系人分组信息；id 传 $root 返回根分组。",
    inputSchema: { id: folderId, select: folderSelect },
    handler: async (a, { client }) => client.get(folderPath(a.id), { $select: a.select }),
  }),
  defineTool({
    name: "get_contact_folder_chain",
    title: "获取公共联系人分组层级链",
    toolset: "contacts",
    kind: "read",
    description: "获取从根分组到目标分组的完整层级链。",
    inputSchema: { id: z.string().min(1).describe("分组 ID") },
    handler: async (a, { client }) => client.get(`${folderPath(a.id)}/chain`),
  }),
  defineTool({
    name: "list_contact_subfolders",
    title: "查询公共联系人子分组",
    toolset: "contacts",
    kind: "read",
    description: "查询指定分组的直属子分组（offset/limit 分页）。需要整棵树请用 get_contact_folder_tree。",
    inputSchema: { id: folderId, ...page, select: folderSelect },
    handler: async (a, { client }) =>
      listChildFolders(client, a.id, a.offset, a.limit, { managed: a.managed, select: a.select }),
  }),
  defineTool({
    name: "list_folder_contacts",
    title: "查询分组内的公共联系人",
    toolset: "contacts",
    kind: "read",
    description: "查询指定分组内的公共联系人（offset/limit 分页）。",
    inputSchema: { id: folderId, ...page, select: contactSelect },
    handler: async (a, { client }) =>
      listFolderContacts(client, a.id, a.offset, a.limit, { managed: a.managed, select: a.select }),
  }),
  defineTool({
    name: "get_contact_folder_tree",
    title: "获取公共联系人分组树",
    toolset: "contacts",
    kind: "read",
    description:
      "从指定分组（默认根分组）递归获取公共联系人分组树，自动处理分页，可选附带每个分组内的联系人。结果中 truncated=true 表示被截断。",
    inputSchema: {
      rootId: z.string().optional().default("$root").describe("起始分组 ID，默认 $root"),
      maxDepth: z.number().int().min(0).max(50).optional().default(10).describe("最大递归深度"),
      maxNodes: z.number().int().min(1).max(10000).optional().default(2000).describe("最多返回的分组数量"),
      includeContacts: z.boolean().optional().default(false).describe("是否包含每个分组内的联系人（调用次数显著增加）"),
      maxContactsPerFolder: z.number().int().min(1).max(1000).optional().default(200),
    },
    handler: async (a, { client }) => {
      const root = await client.get<Folder>(folderPath(a.rootId));
      return buildTree({
        root,
        maxDepth: a.maxDepth,
        maxNodes: a.maxNodes,
        listChildren: async (id, offset, limit) => {
          const r = await listChildFolders(client, id, offset, limit);
          return { items: r.folders ?? [], total: r.total };
        },
        visit: a.includeContacts
          ? async (node) => {
              const contacts = await collectByOffset(
                async (offset, limit) => {
                  const r = await listFolderContacts(client, node.id, offset, limit);
                  return { items: r.contacts ?? [], total: r.total };
                },
                { maxItems: a.maxContactsPerFolder },
              );
              node.contacts = contacts.items.map((c) => ({ id: c.id, name: c.name, email: c.email }));
              node.contactsTotal = contacts.total ?? contacts.items.length;
              return contacts.truncated;
            }
          : undefined,
      });
    },
  }),

  // ---------- write ----------
  defineTool({
    name: "create_shared_contact",
    title: "创建公共联系人",
    toolset: "contacts",
    kind: "write",
    description: "在企业公共通讯录的指定分组中创建联系人。folderId 可用 $root 表示根分组。",
    inputSchema: {
      name: z.string().min(1).describe("联系人姓名"),
      email: z.string().refine(isEmail, "invalid email").describe("联系人邮箱"),
      folderId: folderId.describe("所属分组 ID（$root 表示根分组）"),
      ...contactFields,
    },
    handler: async (a, { client }) =>
      client.post("/v2/sharedContacts", { ...a, folderId: await resolveRootFolder(client, a.folderId) }),
  }),
  defineTool({
    name: "update_shared_contact",
    title: "更新公共联系人",
    toolset: "contacts",
    kind: "write",
    idempotent: true,
    description: "更新公共联系人信息（仅修改传入字段）。修改 folderId 即移动到其他分组。",
    inputSchema: {
      id: z.string().min(1).describe("联系人 ID"),
      name: z.string().min(1).optional().describe("联系人姓名"),
      email: z.string().refine(isEmail, "invalid email").optional().describe("联系人邮箱"),
      folderId: z.string().optional().describe("新的所属分组 ID（$root 表示根分组）"),
      ...contactFields,
    },
    handler: async ({ id, ...fields }, { client }) => {
      if (Object.values(fields).every((v) => v === undefined)) {
        throw new ToolInputError("至少需要提供一个要更新的字段");
      }
      if (fields.folderId) fields.folderId = await resolveRootFolder(client, fields.folderId);
      return client.patch(contactPath(id), fields);
    },
  }),
  defineTool({
    name: "create_contact_folder",
    title: "创建公共联系人分组",
    toolset: "contacts",
    kind: "write",
    description: "在指定父分组下创建公共联系人分组。parentId 可用 $root 表示根分组。",
    inputSchema: {
      name: z.string().min(1).describe("分组名称"),
      parentId: z.string().min(1).describe("父分组 ID（$root 表示根分组）"),
      ...folderFields,
    },
    handler: async (a, { client }) =>
      client.post("/v2/sharedContactFolders", { ...a, parentId: await resolveRootFolder(client, a.parentId) }),
  }),
  defineTool({
    name: "update_contact_folder",
    title: "更新公共联系人分组",
    toolset: "contacts",
    kind: "write",
    idempotent: true,
    description: "更新公共联系人分组（仅修改传入字段）。修改 parentId 即移动分组。",
    inputSchema: {
      id: z.string().min(1).describe("分组 ID"),
      name: z.string().min(1).optional().describe("分组名称"),
      parentId: z.string().optional().describe("新的父分组 ID（$root 表示根分组）"),
      ...folderFields,
    },
    handler: async ({ id, ...fields }, { client }) => {
      if (Object.values(fields).every((v) => v === undefined)) {
        throw new ToolInputError("至少需要提供一个要更新的字段");
      }
      if (fields.parentId) fields.parentId = await resolveRootFolder(client, fields.parentId);
      return client.patch(folderPath(id), fields);
    },
  }),

  // ---------- destructive ----------
  defineTool({
    name: "delete_shared_contacts",
    title: "删除公共联系人",
    toolset: "contacts",
    kind: "destructive",
    description: "删除一个或多个公共联系人（单次最多 20 个）。批量删除时逐项返回结果。",
    inputSchema: { ids: z.array(z.string().min(1)).min(1).max(20).describe("联系人 ID 列表") },
    preview: async (a, { client }) => ({
      targets: await Promise.all(
        a.ids.map(async (id: string) => {
          const c = await client.get<Contact>(contactPath(id)).catch(() => undefined);
          return c ? { id, name: c.name, email: c.email } : { id, found: false };
        }),
      ),
      irreversible: true,
    }),
    handler: async (a, { client }) => {
      if (a.ids.length === 1) {
        await client.delete(contactPath(a.ids[0]!));
        return { ok: true, deleted: a.ids };
      }
      return client.post("/v2/sharedContacts/batchDelete", { ids: a.ids });
    },
  }),
  defineTool({
    name: "delete_contact_folder",
    title: "删除公共联系人分组",
    toolset: "contacts",
    kind: "destructive",
    description: "删除公共联系人分组。预览会显示分组内的联系人数和子分组数，删除非空分组前请确认其中数据的去向。",
    inputSchema: { id: z.string().min(1).describe("分组 ID") },
    preview: async (a, { client }) => {
      const f = await client.get<Folder>(folderPath(a.id), { $select: "contactCount,childFolderCount" });
      const chain = await client
        .get<{ folders?: { id: string; name: string }[] }>(`${folderPath(a.id)}/chain`)
        .catch(() => undefined);
      return {
        target: {
          id: f.id,
          name: f.name,
          path: chain?.folders?.map((x) => x.name).join(" / "),
          contactCount: f.contactCount,
          childFolderCount: f.childFolderCount,
        },
      };
    },
    handler: async (a, { client }) => {
      await client.delete(folderPath(a.id));
      return { ok: true, deleted: a.id };
    },
  }),
];
