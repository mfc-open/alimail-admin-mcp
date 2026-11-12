import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";
import { ConfirmStore } from "../src/guard/confirm.js";
import { redact } from "../src/guard/redact.js";
import { DomainScope } from "../src/guard/scope.js";
import { generatePassword } from "../src/tools/users.js";

describe("ConfirmStore", () => {
  it("accepts the same tool + args once", () => {
    const s = new ConfirmStore();
    const { token } = s.issue("delete_user", { user: "a@x.com" });
    expect(s.consume("delete_user", { user: "a@x.com", confirm: true, confirmToken: token }, token)).toBeNull();
    expect(s.consume("delete_user", { user: "a@x.com" }, token)).toMatch(/无效|过期/);
  });

  it("rejects changed args, other tools and expired tokens", () => {
    let now = 0;
    const s = new ConfirmStore(1000, () => now);
    const { token } = s.issue("delete_user", { user: "a@x.com" });
    expect(s.consume("delete_user", { user: "b@x.com" }, token)).toMatch(/不一致/);
    expect(s.consume("reset_password", { user: "a@x.com" }, token)).toMatch(/不匹配/);
    now = 2000;
    expect(s.consume("delete_user", { user: "a@x.com" }, token)).toMatch(/无效|过期/);
    expect(s.consume("delete_user", { user: "a@x.com" }, undefined)).toMatch(/缺少/);
  });

  it("is insensitive to key order", () => {
    const s = new ConfirmStore();
    const { token } = s.issue("t", { a: 1, b: { c: 2, d: 3 } });
    expect(s.consume("t", { b: { d: 3, c: 2 }, a: 1 }, token)).toBeNull();
  });
});

describe("DomainScope", () => {
  it("allows everything when unrestricted", () => {
    expect(new DomainScope([]).isAllowed("a@any.com")).toBe(true);
  });
  it("matches exact domains and subdomains only", () => {
    const s = new DomainScope(["example.com"]);
    expect(s.isAllowed("a@example.com")).toBe(true);
    expect(s.isAllowed("a@EXAMPLE.com")).toBe(true);
    expect(s.isAllowed("a@sub.example.com")).toBe(true);
    expect(s.isAllowed("a@badexample.com")).toBe(false);
    expect(s.isAllowed("not-an-email")).toBe(false);
    expect(() => s.assertEmail("a@other.com")).toThrow(/不在允许/);
  });
});

describe("redact", () => {
  it("masks sensitive keys and bearer tokens", () => {
    expect(
      redact({
        user: "a",
        password: "p",
        nested: { client_secret: "s", Authorization: "bearer abc" },
        note: "use Bearer xyz.123 now",
      }),
    ).toEqual({
      user: "a",
      password: "***",
      nested: { client_secret: "***", Authorization: "***" },
      note: "use Bearer *** now",
    });
  });
});

describe("generatePassword", () => {
  it("contains all character classes", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });
});

describe("loadConfig", () => {
  const base = { ALIMAIL_CLIENT_ID: "a", ALIMAIL_CLIENT_SECRET: "b" };
  it("applies safe defaults", () => {
    const c = loadConfig(base);
    expect(c.readOnly).toBe(true);
    expect(c.toolsets).toEqual(["users", "departments"]);
    expect(c.apiBase).toBe("https://alimail-cn.aliyuncs.com");
    expect(c.http.host).toBe("127.0.0.1");
    expect(c.maxQps).toBe(20);
  });
  it("parses overrides", () => {
    const c = loadConfig({
      ...base,
      ALIMAIL_READ_ONLY: "false",
      ALIMAIL_TOOLSETS: "departments",
      ALIMAIL_ALLOWED_DOMAINS: "A.com, b.com",
      ALIMAIL_API_BASE: "https://alimail-sg.aliyuncs.com/",
    });
    expect(c.readOnly).toBe(false);
    expect(c.toolsets).toEqual(["departments"]);
    expect(c.allowedDomains).toEqual(["a.com", "b.com"]);
    expect(c.apiBase).toBe("https://alimail-sg.aliyuncs.com");
  });
  it("reports missing credentials and bad values", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ALIMAIL_TOOLSETS: "mail" })).toThrow(/unknown toolset/);
    expect(() => loadConfig({ ...base, ALIMAIL_READ_ONLY: "maybe" })).toThrow(/invalid boolean/);
    expect(() => loadConfig({ ...base, ALIMAIL_MAX_QPS: "100" })).toThrow(ConfigError);
  });
});
