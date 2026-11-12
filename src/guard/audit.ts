import { appendFile } from "node:fs/promises";
import { redact } from "./redact.js";
import { log } from "../logger.js";

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  outcome: "success" | "error" | "preview";
  error?: string;
  requestId?: string;
  durationMs?: number;
}

/** Records write/destructive operations as JSON lines (file if configured, else stderr). */
export class AuditLog {
  constructor(private readonly file?: string) {}

  async record(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type: "audit",
      ...entry,
      args: redact(entry.args),
    });
    if (this.file) {
      try {
        await appendFile(this.file, line + "\n", { encoding: "utf8", mode: 0o600 });
        return;
      } catch (e) {
        log.error("failed to write audit log, falling back to stderr", {
          file: this.file,
          error: (e as Error).message,
        });
      }
    }
    process.stderr.write(line + "\n");
  }
}
