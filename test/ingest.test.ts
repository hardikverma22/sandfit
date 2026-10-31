import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codexArgvToCommand, parseCodexTranscript, patchPaths } from "../src/ingest/codex.js";
import { parseClaudeTranscript } from "../src/ingest/claude.js";
import { ingest } from "../src/ingest/index.js";
import { readLines } from "../src/ingest/lines.js";
import { tempHome, writeClaudeTranscript } from "./helpers.js";

const dir = tempHome("ingest-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (text: string, name = `f${n++}.jsonl`) => {
  const p = join(dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const collect = async (p: string) => {
  const out: string[] = [];
  for await (const l of readLines(p)) out.push(l);
  return out;
};

describe("readLines", () => {
  it("handles CRLF, a missing final newline and empty lines", async () => {
    expect(await collect(file("a\r\nb\n\nc"))).toEqual(["a", "b", "", "c"]);
  });

  it("joins lines split across chunk boundaries (lines over 1 MB)", async () => {
    const big = "x".repeat(1_500_000);
    expect((await collect(file(`${big}\nshort\n${big}y\n`))).map((l) => l.length)).toEqual([1_500_000, 5, 1_500_001]);
  });

  it("keeps multi-byte characters intact across chunks", async () => {
    const line = "é".repeat(700_000); // 1.4 MB of 2-byte characters
    expect(await collect(file(`${line}\nend\n`))).toEqual([line, "end"]);
  });
});

describe("Claude Code transcripts", () => {
  it("survives malformed lines, unknown entries and calls with no result", async () => {
    const p = file(
      [
        "not json at all",
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{"command":"ls"}}]},"cwd":"/w","sessionId":"s","timestamp":"2026-10-01T00:00:00Z"}',
        '{"type":"assistant","message":{"content":"tool_use mentioned in plain text"}}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"pwd","dangerouslyDisableSandbox":true}}]},"cwd":"/w","sessionId":"s","timestamp":"2026-10-01T00:00:01Z"}',
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b","is_error":true}]},"permissionDecision":{"decision":"accept","source":"user_permanent"}}',
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"nope"}]}}',
        "{truncated",
      ].join("\n"),
    );
    const events = await parseClaudeTranscript(p);
    expect(events.map((e) => [e.command, e.decision, !!e.failed, !!e.sandboxBypass])).toEqual([
      ["ls", "unknown", false, false],
      ["pwd", "prompted", true, true],
    ]);
  });

  it("classifies every tool kind and keeps paths and URLs", async () => {
    const p = join(dir, "kinds.jsonl");
    writeClaudeTranscript(p, "/w", [
      { name: "Read", input: { file_path: "/w/a.ts" } },
      { name: "Grep", input: { path: "/w/src", pattern: "x" } },
      { name: "MultiEdit", input: { file_path: "/w/b.ts" } },
      { name: "NotebookEdit", input: { notebook_path: "/w/n.ipynb" } },
      { name: "WebFetch", input: { url: "https://x.dev/a" } },
      { name: "mcp__linear__create_issue", input: {} },
      { name: "Monitor", input: { command: "tail -f log" } },
      { name: "TodoWrite", input: {} },
      { name: "Bash", command: "rm x", decision: "reject" },
    ]);
    const events = await parseClaudeTranscript(p);
    expect(events.map((e) => `${e.tool}:${e.paths?.[0] ?? e.url ?? e.command ?? e.toolName}:${e.decision}`)).toEqual([
      "read:/w/a.ts:auto",
      "read:/w/src:auto",
      "write:/w/b.ts:auto",
      "write:/w/n.ipynb:auto",
      "fetch:https://x.dev/a:auto",
      "mcp:mcp__linear__create_issue:auto",
      "bash:tail -f log:auto",
      "other:TodoWrite:auto",
      "bash:rm x:rejected",
    ]);
  });
});

describe("Codex rollouts", () => {
  it("unwraps shell argv, quoting arguments that need it", () => {
    expect(codexArgvToCommand(["bash", "-lc", "npm ci && npm test"])).toBe("npm ci && npm test");
    expect(codexArgvToCommand(["/bin/zsh", "-c", "ls"])).toBe("ls");
    expect(codexArgvToCommand(["rg", "-n", "hello world", "src"])).toBe("rg -n 'hello world' src");
    expect(codexArgvToCommand(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
    expect(codexArgvToCommand("git status")).toBe("git status");
    expect(codexArgvToCommand([])).toBeUndefined();
  });

  it("finds every file an apply_patch touches, relative to the workdir", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: /abs/b.ts\n*** Delete File: old.ts\n*** Update File: c.ts\n*** Move to: d/c.ts\n*** End Patch";
    expect(patchPaths(patch, "/w")).toEqual(["/w/src/a.ts", "/abs/b.ts", "/w/old.ts", "/w/c.ts", "/w/d/c.ts"]);
  });

  it("reads every command form, cwd changes, approvals, escalation and failures", async () => {
    const lines = [
      { type: "session_meta", payload: { id: "cx", cwd: "/w" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "1", arguments: JSON.stringify({ cmd: "npm test" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "1", output: '{"exit_code":1}' } },
      { type: "turn_context", payload: { cwd: "/w/api" } },
      { type: "response_item", payload: { type: "local_shell_call", call_id: "2", action: { command: ["bash", "-lc", "uv sync"] } } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "3", arguments: JSON.stringify({ command: ["git", "push"], with_escalated_permissions: true }) } },
      { type: "event_msg", payload: { type: "exec_approval_request", call_id: "3" } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "4", arguments: JSON.stringify({ command: ["curl", "https://x.dev"] }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "4", output: "curl: (7) Operation not permitted" } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "5", input: "*** Update File: m.py" } },
      { type: "response_item", payload: { type: "function_call", name: "github__get_issue", call_id: "6", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "7", arguments: "not json" } },
    ].map((l, i) => JSON.stringify({ timestamp: `2026-10-01T00:00:0${i % 10}Z`, ...l }));
    const events = await parseCodexTranscript(file(lines.join("\n")));
    expect(events.map((e) => [e.tool, e.cwd, e.command ?? e.paths?.join(",") ?? e.toolName, e.decision, !!e.failed, !!e.sandboxBypass])).toEqual([
      ["bash", "/w", "npm test", "auto", true, false],
      ["bash", "/w/api", "uv sync", "auto", false, false],
      ["bash", "/w/api", "git push", "prompted", false, true],
      ["bash", "/w/api", "curl https://x.dev", "auto", true, false],
      ["write", "/w/api", "/w/api/m.py", "auto", false, false],
      ["mcp", "/w/api", "github__get_issue", "auto", false, false],
    ]);
    expect(events.every((e) => e.sessionId === "cx" && e.harness === "codex")).toBe(true);
  });
});

describe("ingest", () => {
  const root = join(dir, "projects");
  const old = new Date(Date.now() - 90 * 86_400_000);
  writeClaudeTranscript(join(root, "-w-app", "new.jsonl"), "/w/app", [{ command: "npm ci" }], "new");
  writeClaudeTranscript(join(root, "-w-app", "sub", "subagents", "agent.jsonl"), "/w/app/web", [{ command: "pnpm i" }], "agent");
  writeClaudeTranscript(join(root, "-w-app2", "other.jsonl"), "/w/app2", [{ command: "cargo build" }], "other");
  writeClaudeTranscript(join(root, "-w-app", "old.jsonl"), "/w/app", [{ command: "make", timestamp: old.toISOString() }], "old");
  utimesSync(join(root, "-w-app", "old.jsonl"), old, old);

  it("reads subagent transcripts and counts sessions", async () => {
    const r = await ingest({ harnesses: ["claude"], claudeDir: root });
    expect(r.events.map((e) => e.command).sort()).toEqual(["cargo build", "make", "npm ci", "pnpm i"]);
    expect(r.sessions).toBe(4);
  });

  it("scopes to a project without matching sibling folders that share a prefix", async () => {
    const r = await ingest({ harnesses: ["claude"], claudeDir: root, project: "/w/app/" });
    expect(r.events.map((e) => e.command).sort()).toEqual(["make", "npm ci", "pnpm i"]);
  });

  it("drops old history, and skips old files without reading them", async () => {
    const r = await ingest({ harnesses: ["claude"], claudeDir: root, days: 30 });
    expect(r.events.map((e) => e.command)).not.toContain("make");
    expect(r.files).toBe(3);
  });

  it("returns nothing (not an error) when the folders do not exist", async () => {
    expect(await ingest({ claudeDir: join(dir, "missing"), codexDir: join(dir, "missing2") })).toEqual({ events: [], files: 0, sessions: 0 });
  });

  it("returns events oldest first", async () => {
    const r = await ingest({ harnesses: ["claude"], claudeDir: root });
    const ts = r.events.map((e) => e.timestamp);
    expect(ts).toEqual([...ts].sort());
  });
});
