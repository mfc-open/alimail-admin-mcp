import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

interface Pending {
  tool: string;
  argsHash: string;
  expiresAt: number;
}

/** Keys excluded from the argument fingerprint because they carry the confirmation itself. */
const CONFIRM_KEYS = new Set(["confirm", "confirmToken"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonical((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

export function fingerprint(args: Record<string, unknown>): string {
  const filtered = Object.fromEntries(Object.entries(args).filter(([k]) => !CONFIRM_KEYS.has(k)));
  return createHash("sha256").update(JSON.stringify(canonical(filtered))).digest("hex");
}

/**
 * Issues single-use confirmation tokens bound to a tool name and its exact arguments.
 * A destructive call must first be previewed (yielding a token) and then re-sent with
 * `confirm: true` and the same token + identical arguments within the TTL.
 */
export class ConfirmStore {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(tool: string, args: Record<string, unknown>): { token: string; expiresAt: Date } {
    this.gc();
    const token = randomBytes(16).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { tool, argsHash: fingerprint(args), expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  /** Returns null on success, otherwise a human readable reason. Tokens are consumed on success. */
  consume(tool: string, args: Record<string, unknown>, token: string | undefined): string | null {
    this.gc();
    if (!token) return "缺少 confirmToken";
    const p = this.pending.get(token);
    if (!p) return "confirmToken 无效或已过期，请重新发起预览";
    if (p.tool !== tool) return "confirmToken 与当前工具不匹配";
    const a = Buffer.from(p.argsHash);
    const b = Buffer.from(fingerprint(args));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return "参数与预览时不一致，请重新发起预览";
    }
    this.pending.delete(token);
    return null;
  }

  private gc() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
  }
}
