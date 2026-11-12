import { afterEach, describe, expect, it } from "vitest";
import { connect, json, MockApi } from "./helpers.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup(api: MockApi, env: Record<string, string> = {}) {
  const c = await connect(api, env);
  cleanup = c.close;
  return c;
}

const RW = { ALIMAIL_READ_ONLY: "false" };

describe("tool registration", () => {
  it("only exposes read tools in read-only mode (default)", async () => {
    const { client } = await setup(new MockApi());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("list_users");
    expect(names).toContain("get_department_tree");
    expect(names).not.toContain("create_user");
    expect(names).not.toContain("delete_user");
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(names).toHaveLength(11);
  });

  it("exposes write and destructive tools with annotations when enabled", async () => {
    const { client } = await setup(new MockApi(), RW);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(27);
    const del = tools.find((t) => t.name === "delete_user")!;
    expect(del.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(Object.keys((del.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(["user", "confirm", "confirmToken"]),
    );
    const create = tools.find((t) => t.name === "create_user")!;
    expect(create.annotations).toMatchObject({ destructiveHint: false, readOnlyHint: false });
  });

  it("respects ALIMAIL_TOOLSETS", async () => {
    const { client } = await setup(new MockApi(), { ALIMAIL_TOOLSETS: "departments" });
    const { tools } = await client.listTools();
    expect(tools.every((t) => !t.name.includes("user") || t.name === "list_department_users")).toBe(true);
  });
});

describe("users tools", () => {
  it("list_users maps parameters to query string", async () => {
    const api = new MockApi().on("GET /v2/users", () => ({ users: [{ id: "1" }], hasMore: true, nextCursor: "n" }));
    const { call } = await setup(api);
    const r = await call("list_users", { filter: "(departmentId=d1*)", size: 10, select: "phone" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ hasMore: true, nextCursor: "n" });
    const q = api.calls[0]!.query;
    expect(q.get("filter")).toBe("(departmentId=d1*)");
    expect(q.get("size")).toBe("10");
    expect(q.get("$select")).toBe("phone");
  });

  it("validates input via the MCP schema", async () => {
    const { call } = await setup(new MockApi());
    const r = await call("list_users", { size: 1000 });
    expect(r.isError).toBe(true);
  });

  it("create_user generates a password and forces change on next sign-in", async () => {
    const api = new MockApi().on("POST /v2/users", (c) => ({ id: "u1", email: (c.body as any).email }));
    const { call, audit } = await setup(api, RW);
    const r = await call("create_user", { email: "new@x.com", name: "New", departmentIds: ["d1"] });
    expect(r.isError).toBe(false);
    const body = api.calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ email: "new@x.com", name: "New", departmentIds: ["d1"], forceChangePasswordNextSignIn: true });
    expect(typeof body.password).toBe("string");
    expect(r.data.initialPassword).toBe(body.password);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ tool: "create_user", outcome: "success" });
  });

  it("update_user rejects empty updates and sends only provided fields", async () => {
    const api = new MockApi().on("PATCH /v2/users/:id", () => ({}));
    const { call } = await setup(api, RW);
    const empty = await call("update_user", { user: "a@x.com" });
    expect(empty.isError).toBe(true);
    const r = await call("update_user", { user: "a@x.com", status: "FREEZE" });
    expect(r.isError).toBe(false);
    expect(api.calls[0]!.path).toBe("/v2/users/a@x.com");
    expect(api.calls[0]!.body).toEqual({ status: "FREEZE" });
  });

  it("delete_user requires a preview and a matching confirmation token", async () => {
    const api = new MockApi()
      .on("GET /v2/users/:id", () => ({ id: "u1", email: "a@x.com", name: "A", status: "NORMAL" }))
      .on("DELETE /v2/users/:id", () => ({}));
    const { call, audit } = await setup(api, RW);

    const preview = await call("delete_user", { user: "a@x.com" });
    expect(preview.data.status).toBe("confirmation_required");
    expect(preview.data.preview.target).toMatchObject({ email: "a@x.com", name: "A" });
    expect(api.callsTo("DELETE", "/v2/users/a@x.com")).toHaveLength(0);
    const token = preview.data.confirmToken as string;

    const noToken = await call("delete_user", { user: "a@x.com", confirm: true });
    expect(noToken.isError).toBe(true);

    const otherTarget = await call("delete_user", { user: "b@x.com", confirm: true, confirmToken: token });
    expect(otherTarget.isError).toBe(true);
    expect(otherTarget.data.message).toMatch(/不一致/);

    const ok = await call("delete_user", { user: "a@x.com", confirm: true, confirmToken: token });
    expect(ok.isError).toBe(false);
    expect(api.callsTo("DELETE", "/v2/users/a@x.com")).toHaveLength(1);

    const replay = await call("delete_user", { user: "a@x.com", confirm: true, confirmToken: token });
    expect(replay.isError).toBe(true);
    expect(audit.entries.map((e) => e.outcome)).toEqual(["preview", "success"]);
  });

  it("reset_password returns the generated password only after confirmation and never logs it", async () => {
    const api = new MockApi()
      .on("GET /v2/users/:id", () => ({ id: "u1", email: "a@x.com", name: "A" }))
      .on("POST /v2/users/:id/resetPassword", () => ({}));
    const { call, audit } = await setup(api, RW);
    const p = await call("reset_password", { user: "a@x.com" });
    expect(p.data.preview.passwordSource).toBe("auto-generated");
    expect(JSON.stringify(p.data)).not.toMatch(/newPassword/);
    const r = await call("reset_password", { user: "a@x.com", confirm: true, confirmToken: p.data.confirmToken });
    const sent = api.callsTo("POST", "/v2/users/a@x.com/resetPassword")[0]!.body as Record<string, unknown>;
    expect(r.data.newPassword).toBe(sent.password);
    expect(sent.forceChangePasswordNextSignIn).toBe(true);
    expect(JSON.stringify(audit.entries)).not.toContain(String(sent.password));
  });

  it("enforces ALLOWED_DOMAINS, resolving user IDs to emails", async () => {
    const api = new MockApi()
      .on("GET /v2/users/:id", (c) =>
        c.path.endsWith("/u-out") ? { id: "u-out", email: "z@other.com" } : { id: "u-in", email: "a@x.com" },
      )
      .on("DELETE /v2/users/:id", () => ({}));
    const { call } = await setup(api, { ...RW, ALIMAIL_ALLOWED_DOMAINS: "x.com" });

    const byEmail = await call("get_user", { user: "z@other.com" });
    expect(byEmail.isError).toBe(true);
    expect(byEmail.data.error).toBe("ScopeError");

    const byId = await call("delete_user", { user: "u-out" });
    expect(byId.isError).toBe(true);
    expect(byId.data.error).toBe("ScopeError");

    const created = await call("create_user", { email: "n@other.com", name: "N", departmentIds: ["d"] });
    expect(created.data.error).toBe("ScopeError");
    expect(api.callsTo("POST", "/v2/users")).toHaveLength(0);

    const ok = await call("delete_user", { user: "u-in" });
    expect(ok.data.status).toBe("confirmation_required");
  });

  it("returns normalized API errors", async () => {
    const api = new MockApi().on("GET /v2/users/:id", () => json({ detailErrorCode: "UserNotFound", message: "not found" }, 404));
    const { call } = await setup(api);
    const r = await call("get_user", { user: "missing@x.com" });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ status: 404, detailErrorCode: "UserNotFound" });
  });
});

describe("departments tools", () => {
  function orgApi() {
    const tree: Record<string, { id: string; name: string; parentId?: string }[]> = {
      root: [
        { id: "a", name: "A", parentId: "root" },
        { id: "b", name: "B", parentId: "root" },
      ],
      a: [{ id: "a1", name: "A1", parentId: "a" }],
      b: [],
      a1: [],
    };
    return new MockApi()
      .on("GET /v2/departments/$root", () => ({ id: "root", name: "Org" }))
      .on("GET /v2/departments/:id/departments", (c) => {
        const id = c.path.split("/")[3]!;
        const all = tree[id] ?? [];
        const offset = Number(c.query.get("offset") ?? 0);
        const limit = Number(c.query.get("limit"));
        return { departments: all.slice(offset, offset + limit), total: all.length };
      })
      .on("GET /v2/departments/:id/users", (c) => {
        const id = c.path.split("/")[3]!;
        return { users: [{ id: `u-${id}`, email: `${id}@x.com`, name: id, extra: "drop" }], total: 1 };
      });
  }

  it("get_department_tree builds a nested tree from $root", async () => {
    const { call } = await setup(orgApi());
    const r = await call("get_department_tree", {});
    expect(r.isError).toBe(false);
    expect(r.data.nodeCount).toBe(4);
    expect(r.data.truncated).toBe(false);
    expect(r.data.tree).toMatchObject({
      id: "root",
      children: [{ id: "a", children: [{ id: "a1", children: [] }] }, { id: "b", children: [] }],
    });
  });

  it("get_department_tree honors maxDepth, maxNodes and includeUsers", async () => {
    const { call } = await setup(orgApi());
    const shallow = await call("get_department_tree", { maxDepth: 1 });
    expect(shallow.data.truncated).toBe(true);
    expect(shallow.data.tree.children[0].childrenTruncated).toBe(true);

    const limited = await call("get_department_tree", { maxNodes: 2 });
    expect(limited.data.nodeCount).toBe(2);
    expect(limited.data.truncated).toBe(true);

    const withUsers = await call("get_department_tree", { includeUsers: true });
    expect(withUsers.data.tree.users).toEqual([{ id: "u-root", email: "root@x.com", name: "root" }]);
  });

  it("create_department resolves $root parent", async () => {
    const api = orgApi().on("POST /v2/departments", (c) => ({ id: "new", ...(c.body as object) }));
    const { call } = await setup(api, RW);
    const r = await call("create_department", { name: "New", parentId: "$root" });
    expect(r.isError).toBe(false);
    expect(api.callsTo("POST", "/v2/departments")[0]!.body).toEqual({ name: "New", parentId: "root" });
  });

  it("delete_department preview warns about non-empty departments", async () => {
    const api = orgApi()
      .on("GET /v2/departments/:id", () => ({ id: "a", name: "A", hasUsers: true, hasSubDepartments: true, userCount: 3 }))
      .on("GET /v2/departments/:id/chain", () => ({ departments: [{ id: "root", name: "Org" }, { id: "a", name: "A" }] }));
    const { call } = await setup(api, RW);
    const r = await call("delete_department", { id: "a" });
    expect(r.data.status).toBe("confirmation_required");
    expect(r.data.preview.target.path).toBe("Org / A");
    expect(r.data.preview.willFail).toBeTruthy();
    expect(api.calls.find((c) => c.path === "/v2/departments/a" && c.method === "GET")!.query.get("$select")).toBe(
      "hasUsers,hasSubDepartments,userCount",
    );
  });

  it("get_department_chain supports single and batch", async () => {
    const api = new MockApi()
      .on("GET /v2/departments/:id/chain", () => ({ departments: [] }))
      .on("POST /v2/departments/listChainsByIds", () => ({ departmentsChains: [] }));
    const { call } = await setup(api);
    expect((await call("get_department_chain", { id: "a" })).isError).toBe(false);
    expect((await call("get_department_chain", { ids: ["a", "b"] })).isError).toBe(false);
    expect(api.callsTo("POST", "/v2/departments/listChainsByIds")[0]!.body).toEqual({ ids: ["a", "b"] });
    expect((await call("get_department_chain", {})).isError).toBe(true);
  });
});

describe("resources and prompts", () => {
  it("lists resources and renders prompts", async () => {
    const { client } = await setup(new MockApi(), RW);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("alimail://departments/tree");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["offboard_employee", "onboard_employee"]);
    const p = await client.getPrompt({ name: "offboard_employee", arguments: { user: "a@x.com", handoverTo: "b@x.com" } });
    expect((p.messages[0]!.content as { text: string }).text).toContain("revoke_user_sessions");
  });

  it("reads the department tree resource", async () => {
    const api = new MockApi()
      .on("GET /v2/departments/$root", () => ({ id: "root", name: "Org" }))
      .on("GET /v2/departments/:id/departments", () => ({ departments: [], total: 0 }));
    const { client } = await setup(api);
    const r = await client.readResource({ uri: "alimail://departments/tree" });
    expect(JSON.parse((r.contents[0] as { text: string }).text).tree.id).toBe("root");
  });
});
