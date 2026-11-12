import { z } from "zod";

export const TOOLSETS = ["users", "departments"] as const;
export type Toolset = (typeof TOOLSETS)[number];

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
      ctx.addIssue({ code: "custom", message: `invalid boolean: ${v}` });
      return z.NEVER;
    });

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  ALIMAIL_CLIENT_ID: z
    .string({ error: "ALIMAIL_CLIENT_ID is required" })
    .min(1, "ALIMAIL_CLIENT_ID is required"),
  ALIMAIL_CLIENT_SECRET: z
    .string({ error: "ALIMAIL_CLIENT_SECRET is required" })
    .min(1, "ALIMAIL_CLIENT_SECRET is required"),
  ALIMAIL_API_BASE: z
    .url()
    .optional()
    .transform((v) => (v ?? "https://alimail-cn.aliyuncs.com").replace(/\/+$/, "")),
  ALIMAIL_TOOLSETS: csv.transform((list, ctx) => {
    if (list.length === 0) return [...TOOLSETS];
    if (list.includes("all")) return [...TOOLSETS];
    for (const t of list) {
      if (!(TOOLSETS as readonly string[]).includes(t)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown toolset "${t}", supported: ${TOOLSETS.join(", ")}`,
        });
        return z.NEVER;
      }
    }
    return list as Toolset[];
  }),
  ALIMAIL_READ_ONLY: boolish(true),
  ALIMAIL_MAX_QPS: z.coerce.number().positive().max(40).optional().default(20),
  ALIMAIL_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(15_000),
  ALIMAIL_ALLOWED_DOMAINS: csv.transform((l) => l.map((d) => d.toLowerCase())),
  ALIMAIL_AUDIT_LOG: z.string().optional(),
  MCP_HTTP_HOST: z.string().optional().default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional().default(3000),
  MCP_AUTH_TOKEN: z.string().optional(),
  MCP_ALLOWED_HOSTS: csv,
});

export interface Config {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  toolsets: Toolset[];
  readOnly: boolean;
  maxQps: number;
  timeoutMs: number;
  allowedDomains: string[];
  auditLog?: string;
  http: {
    host: string;
    port: number;
    authToken?: string;
    allowedHosts: string[];
  };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${msg}`);
  }
  const e = parsed.data;
  return {
    clientId: e.ALIMAIL_CLIENT_ID,
    clientSecret: e.ALIMAIL_CLIENT_SECRET,
    apiBase: e.ALIMAIL_API_BASE,
    toolsets: e.ALIMAIL_TOOLSETS,
    readOnly: e.ALIMAIL_READ_ONLY,
    maxQps: e.ALIMAIL_MAX_QPS,
    timeoutMs: e.ALIMAIL_TIMEOUT_MS,
    allowedDomains: e.ALIMAIL_ALLOWED_DOMAINS,
    auditLog: e.ALIMAIL_AUDIT_LOG || undefined,
    http: {
      host: e.MCP_HTTP_HOST,
      port: e.MCP_HTTP_PORT,
      authToken: e.MCP_AUTH_TOKEN || undefined,
      allowedHosts: e.MCP_ALLOWED_HOSTS,
    },
  };
}
