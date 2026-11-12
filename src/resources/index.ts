import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { seg } from "../client/http.js";
import { buildDepartmentTree } from "../tools/departments.js";
import type { Deps } from "../tools/registry.js";

const TREE_TTL_MS = 5 * 60_000;

export function registerResources(server: McpServer, deps: Deps, cache: ResourceCache): void {
  const { config, client, scope } = deps;

  if (config.toolsets.includes("departments")) {
    server.registerResource(
      "department-tree",
      "alimail://departments/tree",
      {
        title: "组织部门树",
        description: "从根部门开始的完整部门树（不含成员），缓存 5 分钟。",
        mimeType: "application/json",
      },
      async (uri) => {
        const data = await cache.get("department-tree", TREE_TTL_MS, () =>
          buildDepartmentTree(client, { maxDepth: 20, maxNodes: 5000 }),
        );
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
      },
    );
  }

  if (config.toolsets.includes("users")) {
    server.registerResource(
      "user",
      new ResourceTemplate("alimail://users/{email}", { list: undefined }),
      {
        title: "用户信息",
        description: "按邮箱地址读取用户详情。",
        mimeType: "application/json",
      },
      async (uri, vars) => {
        const email = decodeURIComponent(String(vars.email));
        scope.assertEmail(email, "用户");
        const user = await client.get(`/v2/users/${seg(email)}`);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(user, null, 2) }] };
      },
    );
  }
}

/** Small TTL cache shared across sessions, with in-flight deduplication. */
export class ResourceCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => this.entries.delete(key));
    return value;
  }
}
