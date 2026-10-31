import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../src/types.js";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * A temporary home OUTSIDE the OS temp dir (sandfit treats temp writes as always allowed)
 * and outside any git repository (a parent repo would change which folder is "the project").
 */
export function tempHome(prefix = "home-"): string {
  for (const base of ["/var/tmp", join(ROOT, ".bench")]) {
    try {
      mkdirSync(base, { recursive: true });
      return realpathSync(mkdtempSync(join(base, `sandfit-${prefix}`)));
    } catch {
      // try the next place
    }
  }
  throw new Error("no writable place for a test home");
}

export interface ToolCall {
  name?: string;
  command?: string;
  input?: Record<string, unknown>;
  /** "user_temporary" = a person approved it; "config" = allowed by a rule; "reject" = refused. */
  decision?: "user_temporary" | "config" | "reject";
  error?: boolean;
  timestamp?: string;
}

/** Write a Claude Code transcript (assistant tool_use + user tool_result per call). */
export function writeClaudeTranscript(file: string, cwd: string, calls: ToolCall[], sessionId = "s1"): void {
  const lines: string[] = [];
  calls.forEach((c, i) => {
    const id = `${sessionId}-t${i}`;
    const timestamp = c.timestamp ?? new Date(Date.now() - (calls.length - i) * 60_000).toISOString();
    const base = { cwd, sessionId, timestamp };
    const input = c.input ?? { command: c.command };
    lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: c.name ?? "Bash", input }] }, ...base }));
    const pd = c.decision === "reject" ? { decision: "reject", source: "user_temporary" } : { decision: "accept", source: c.decision ?? "config" };
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...(c.error ? { is_error: true } : {}) }] }, permissionDecision: pd, ...base }));
  });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
}

export function bashEvent(command: string, cwd: string, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: command, harness: "claude", sessionId: "s", cwd, timestamp: "2026-10-01T00:00:00Z", tool: "bash", toolName: "Bash", command, decision: "auto", ...extra };
}
