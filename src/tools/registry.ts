import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { AlimailClient } from "../client/http.js";
import { AlimailApiError, AlimailNetworkError } from "../client/errors.js";
import type { Config, Toolset } from "../config.js";
import type { AuditLog } from "../guard/audit.js";
import type { ConfirmStore } from "../guard/confirm.js";
import { redact } from "../guard/redact.js";
import { ScopeError, type DomainScope } from "../guard/scope.js";
import { log } from "../logger.js";

export type ToolKind = "read" | "write" | "destructive";

export interface ToolContext {
  client: AlimailClient;
  scope: DomainScope;
  config: Config;
}

export interface Deps extends ToolContext {
  confirm: ConfirmStore;
  audit: AuditLog;
}

export interface ToolDef<S extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  kind: ToolKind;
  /** Whether repeating the call with the same args has no additional effect. */
  idempotent?: boolean;
  inputSchema: S;
  /** For destructive tools: describes what will happen; may call read APIs and run scope checks. */
  preview?: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
  /** Runs before execution of write/destructive tools (e.g. domain scope checks). */
  authorize?: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<void>;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

// Type-erased definition used for heterogeneous tool lists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): AnyToolDef {
  return def as AnyToolDef;
}

export const confirmShape = {
  confirm: z
    .boolean()
    .optional()
    .describe("确认执行。首次调用不要传，先获取预览与 confirmToken；用户确认后再带 confirm=true 与 confirmToken 重新调用"),
  confirmToken: z.string().optional().describe("预览返回的一次性确认令牌，5 分钟内有效，参数必须与预览时完全一致"),
};

export function jsonResult(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Expected, user-correctable input problems that zod schemas cannot express. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function errorToResult(e: unknown): CallToolResult {
  if (e instanceof AlimailApiError || e instanceof AlimailNetworkError) {
    return jsonResult(e.toJSON(), true);
  }
  if (e instanceof ToolInputError) {
    return jsonResult({ error: "ValidationError", message: e.message }, true);
  }
  if (e instanceof ScopeError) {
    return jsonResult({ error: "ScopeError", message: e.message }, true);
  }
  if (e instanceof z.ZodError) {
    return jsonResult({ error: "ValidationError", issues: e.issues }, true);
  }
  log.error("unexpected tool error", { error: (e as Error)?.stack ?? String(e) });
  return jsonResult({ error: "InternalError", message: (e as Error)?.message ?? String(e) }, true);
}

/** Whether a tool is exposed under the current configuration. */
export function isEnabled(def: AnyToolDef, config: Config): boolean {
  if (!config.toolsets.includes(def.toolset)) return false;
  if (config.readOnly && def.kind !== "read") return false;
  return true;
}

export function registerTools(server: McpServer, defs: AnyToolDef[], deps: Deps): string[] {
  const registered: string[] = [];
  for (const def of defs) {
    if (!isEnabled(def, deps.config)) continue;
    const shape: ZodRawShape =
      def.kind === "destructive" ? { ...def.inputSchema, ...confirmShape } : def.inputSchema;
    const description =
      def.kind === "destructive"
        ? `${def.description}\n\n⚠️ 破坏性操作，需两步确认：第一次调用（不带 confirm）返回预览与 confirmToken；向用户展示预览并获得明确同意后，用完全相同的参数加上 confirm=true 和 confirmToken 再次调用。`
        : def.description;

    server.registerTool(
      def.name,
      {
        title: def.title,
        description,
        inputSchema: shape,
        annotations: {
          title: def.title,
          readOnlyHint: def.kind === "read",
          destructiveHint: def.kind === "destructive",
          idempotentHint: def.idempotent ?? def.kind === "read",
          openWorldHint: true,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (rawArgs: any) => runTool(def, rawArgs ?? {}, deps)) as any,
    );
    registered.push(def.name);
  }
  return registered;
}

export async function runTool(
  def: AnyToolDef,
  rawArgs: Record<string, unknown>,
  deps: Deps,
): Promise<CallToolResult> {
  const ctx: ToolContext = { client: deps.client, scope: deps.scope, config: deps.config };
  const { confirm, confirmToken, ...args } = rawArgs as Record<string, unknown> & {
    confirm?: boolean;
    confirmToken?: string;
  };
  const started = Date.now();

  try {
    if (def.kind !== "read" && def.authorize) await def.authorize(args, ctx);

    if (def.kind === "destructive") {
      if (!confirm) {
        const preview = def.preview ? await def.preview(args, ctx) : undefined;
        const { token, expiresAt } = deps.confirm.issue(def.name, args);
        await deps.audit.record({ tool: def.name, args, outcome: "preview" });
        return jsonResult({
          status: "confirmation_required",
          action: def.title,
          tool: def.name,
          arguments: redact(args),
          preview,
          confirmToken: token,
          expiresAt: expiresAt.toISOString(),
          next: "请向用户展示以上内容并获得明确同意后，使用相同参数并附加 confirm=true 与该 confirmToken 再次调用本工具。",
        });
      }
      const reason = deps.confirm.consume(def.name, args, confirmToken);
      if (reason) return jsonResult({ error: "ConfirmationError", message: reason }, true);
    }

    const result = await def.handler(args, ctx);
    if (def.kind !== "read") {
      await deps.audit.record({
        tool: def.name,
        args,
        outcome: "success",
        durationMs: Date.now() - started,
      });
    }
    return jsonResult(result ?? { ok: true });
  } catch (e) {
    if (def.kind !== "read") {
      await deps.audit.record({
        tool: def.name,
        args,
        outcome: "error",
        error: (e as Error)?.message,
        requestId: e instanceof AlimailApiError ? e.requestId : undefined,
        durationMs: Date.now() - started,
      });
    }
    return errorToResult(e);
  }
}
