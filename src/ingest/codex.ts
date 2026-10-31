import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { findBlocks } from "./blocks.js";
import { readLines } from "./lines.js";
import type { AgentEvent } from "../types.js";

export function codexSessionsDir(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "sessions") : join(homedir(), ".codex", "sessions");
}

export function findCodexTranscripts(root = codexSessionsDir()): string[] {
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

/** Codex wraps commands as ["bash", "-lc", "<script>"]; unwrap to the script. */
export function codexArgvToCommand(argv: unknown): string | undefined {
  if (typeof argv === "string") return argv;
  if (!Array.isArray(argv) || argv.length === 0) return undefined;
  const parts = argv.map(String);
  const shells = new Set(["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"]);
  if (parts.length >= 3 && shells.has(parts[0]!) && (parts[1] === "-lc" || parts[1] === "-c")) {
    return parts.slice(2).join(" ");
  }
  return parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** Paths touched by an apply_patch payload ("*** Update File: path"). */
export function patchPaths(patch: string, cwd: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const p = m[1]!.trim();
    out.push(isAbsolute(p) ? p : resolve(cwd, p));
  }
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    const p = m[1]!.trim();
    out.push(isAbsolute(p) ? p : resolve(cwd, p));
  }
  return out;
}

/**
 * Parse one Codex rollout file. Commands appear as `function_call` (name "shell" or
 * "exec_command") or `local_shell_call` response items; edits as `apply_patch`.
 */
export async function parseCodexTranscript(file: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const byCallId = new Map<string, AgentEvent>();
  let sessionId = "";
  let cwd = "";

  for await (const line of readLines(file)) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload ?? entry;
    const ts = String(entry?.timestamp ?? "");

    if (entry?.type === "session_meta" || payload?.type === "session_meta") {
      sessionId = String(payload?.id ?? payload?.meta?.id ?? sessionId);
      cwd = String(payload?.cwd ?? payload?.meta?.cwd ?? cwd);
      continue;
    }
    if (entry?.type === "turn_context" && payload?.cwd) {
      cwd = String(payload.cwd);
      continue;
    }

    const item = entry?.type === "response_item" ? payload : payload;
    const callId = String(item?.call_id ?? item?.id ?? `${file}:${events.length}`);

    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const name = String(item.name ?? "");
      let args: any = item.arguments ?? item.input ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { raw: args };
        }
      }
      const workdir = typeof args.workdir === "string" ? args.workdir : cwd;
      if (name === "shell" || name === "exec_command" || name === "container.exec" || name === "local_shell") {
        const command = codexArgvToCommand(args.command ?? args.cmd);
        if (!command) continue;
        const ev = mk(callId, sessionId, workdir, ts, "bash", name, { command });
        if (args.with_escalated_permissions === true || args.sandbox_permissions === "require_escalated") ev.sandboxBypass = true;
        events.push(ev);
        byCallId.set(callId, ev);
      } else if (name === "apply_patch") {
        const patch = typeof args.raw === "string" ? args.raw : typeof args.input === "string" ? args.input : String(item.input ?? "");
        const paths = patchPaths(patch, workdir);
        const ev = mk(callId, sessionId, workdir, ts, "write", name, { paths });
        events.push(ev);
        byCallId.set(callId, ev);
      } else if (name.includes("__") || name.startsWith("mcp")) {
        const ev = mk(callId, sessionId, workdir, ts, "mcp", name, {});
        events.push(ev);
        byCallId.set(callId, ev);
      }
    } else if (item?.type === "local_shell_call") {
      const action = item.action ?? {};
      const command = codexArgvToCommand(action.command);
      if (!command) continue;
      const ev = mk(callId, sessionId, String(action.working_directory ?? cwd), ts, "bash", "local_shell", { command });
      events.push(ev);
      byCallId.set(callId, ev);
    } else if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      const ev = byCallId.get(String(item.call_id));
      if (!ev) continue;
      const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      const exit = /"exit_code"\s*:\s*(\d+)/.exec(out);
      if (exit && exit[1] !== "0") ev.failed = true;
      if (/sandbox denied|Operation not permitted|EPERM/i.test(out)) ev.failed = true;
      if (ev.tool === "bash") {
        const blocked = findBlocks(out.replace(/\\n/g, "\n").replace(/\\'/g, "'"), ev.cwd || "/");
        if (blocked.length) ev.blocked = blocked;
      }
    } else if (entry?.type === "event_msg" && payload?.type === "exec_approval_request") {
      const ev = byCallId.get(String(payload.call_id));
      if (ev) ev.decision = "prompted";
    }
  }
  return events;
}

function mk(
  id: string,
  sessionId: string,
  cwd: string,
  timestamp: string,
  tool: AgentEvent["tool"],
  toolName: string,
  extra: Partial<AgentEvent>,
): AgentEvent {
  return { id, harness: "codex", sessionId, cwd, timestamp, tool, toolName, decision: "auto", ...extra };
}
