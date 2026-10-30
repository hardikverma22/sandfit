import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent, Decision, ToolKind } from "../types.js";

export function claudeProjectsDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, "projects")
    : join(homedir(), ".claude", "projects");
}

/** All transcript files, including subagent transcripts. */
export function findClaudeTranscripts(root = claudeProjectsDir()): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

interface PermissionDecision {
  decision?: string;
  source?: string;
  reasonType?: string;
}

function toDecision(pd: PermissionDecision | undefined): Decision {
  if (!pd || !pd.decision) return "unknown";
  if (pd.decision === "reject") return "rejected";
  if (pd.source === "user_temporary" || pd.source === "user_permanent") return "prompted";
  return "auto";
}

function classify(name: string): ToolKind {
  if (name === "Bash" || name === "Monitor") return "bash";
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "NotebookRead") return "read";
  if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "write";
  if (name === "WebFetch") return "fetch";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

interface PendingUse {
  event: AgentEvent;
}

/**
 * Parse one Claude Code transcript. Tool calls live in assistant messages as `tool_use`
 * blocks; their outcome (permission decision, error) arrives in a later user message as a
 * `tool_result` block with the same id.
 */
export async function parseClaudeTranscript(file: string): Promise<AgentEvent[]> {
  const pending = new Map<string, PendingUse>();
  const events: AgentEvent[] = [];
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || (!line.includes("tool_use") && !line.includes("tool_result"))) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        const input = block.input ?? {};
        const tool = classify(block.name);
        const event: AgentEvent = {
          id: String(block.id ?? `${file}:${events.length}`),
          harness: "claude",
          sessionId: String(entry.sessionId ?? ""),
          cwd: String(entry.cwd ?? ""),
          timestamp: String(entry.timestamp ?? ""),
          tool,
          toolName: block.name,
          decision: "unknown",
        };
        if (tool === "bash" && typeof input.command === "string") {
          event.command = input.command;
          if (input.dangerouslyDisableSandbox === true) event.sandboxBypass = true;
        }
        if (typeof input.file_path === "string") event.paths = [input.file_path];
        else if (typeof input.notebook_path === "string") event.paths = [input.notebook_path];
        else if (tool === "read" && typeof input.path === "string") event.paths = [input.path];
        if (tool === "fetch" && typeof input.url === "string") event.url = input.url;
        pending.set(event.id, { event });
        events.push(event);
      } else if (block?.type === "tool_result" && block.tool_use_id) {
        const p = pending.get(String(block.tool_use_id));
        if (!p) continue;
        p.event.decision = toDecision(entry.permissionDecision);
        if (block.is_error === true) p.event.failed = true;
        pending.delete(String(block.tool_use_id));
      }
    }
  }
  return events;
}
