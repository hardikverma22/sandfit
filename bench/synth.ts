/**
 * Synthetic agent history for benchmarks: Claude Code transcripts and Codex rollouts with
 * a realistic mix of tool calls (commands drawn from the labelled corpus, file reads and
 * edits, web fetches, MCP calls) and realistic transcript sizes (real transcripts are
 * mostly tool output: about 17 KB per tool call in the one we measured).
 *
 * Deterministic: the same seed always produces the same files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS } from "./corpus.js";

export interface SynthOptions {
  dir: string;
  /** Total tool calls to generate. */
  toolCalls: number;
  /** Tool calls per session file. */
  perSession?: number;
  /** Average bytes of tool output per call. */
  outputBytes?: number;
  projects?: string[];
  seed?: number;
  /** Share of sessions written as Codex rollouts instead of Claude Code transcripts. */
  codexShare?: number;
}

/** Small, fast, seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ["src/index.ts", "src/app.tsx", "src/lib/db.ts", "README.md", "package.json", "tests/api.test.ts", "src/routes/users.ts", ".env.example"];
const URLS = ["https://docs.example.com/guide", "https://developer.mozilla.org/en-US/docs/Web/API/fetch", "https://nextjs.org/docs/app"];
const FILLER = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

export function synthesize(opts: SynthOptions): { files: number; bytes: number } {
  const rand = rng(opts.seed ?? 42);
  const perSession = opts.perSession ?? 200;
  const outputBytes = opts.outputBytes ?? 12_000;
  const projects = opts.projects ?? ["/home/bench/app", "/home/bench/api", "/home/bench/site"];
  const codexShare = opts.codexShare ?? 0.2;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const filler = (n: number) => FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n);
  const start = Date.now() - 20 * 86_400_000;

  let made = 0;
  let files = 0;
  let bytes = 0;
  while (made < opts.toolCalls) {
    const n = Math.min(perSession, opts.toolCalls - made);
    const project = pick(projects);
    const sid = `sess-${files}`;
    const codex = rand() < codexShare;
    const lines: string[] = [];
    const ts = (i: number) => new Date(start + (made + i) * 30_000).toISOString();
    if (codex) lines.push(JSON.stringify({ timestamp: ts(0), type: "session_meta", payload: { id: sid, cwd: project } }));
    for (let i = 0; i < n; i++) {
      const id = `${sid}-t${i}`;
      const r = rand();
      const out = filler(Math.floor(rand() * 2 * outputBytes));
      if (codex) {
        const command = r < 0.85 ? pick(CORPUS).cmd : `cat ${pick(FILES)}`;
        lines.push(JSON.stringify({ timestamp: ts(i), type: "response_item", payload: { type: "function_call", name: "shell", call_id: id, arguments: JSON.stringify({ command: ["bash", "-lc", command], workdir: project }) } }));
        lines.push(JSON.stringify({ timestamp: ts(i), type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ output: out, metadata: { exit_code: 0 } }) } }));
        continue;
      }
      let block: Record<string, unknown>;
      if (r < 0.45) block = { type: "tool_use", id, name: "Bash", input: { command: pick(CORPUS).cmd, description: "run" } };
      else if (r < 0.75) block = { type: "tool_use", id, name: "Read", input: { file_path: `${project}/${pick(FILES)}` } };
      else if (r < 0.92) block = { type: "tool_use", id, name: "Edit", input: { file_path: `${project}/${pick(FILES)}`, old_string: "a", new_string: "b" } };
      else if (r < 0.97) block = { type: "tool_use", id, name: "WebFetch", input: { url: pick(URLS), prompt: "summarize" } };
      else block = { type: "tool_use", id, name: "mcp__github__create_issue", input: { title: "x" } };
      const base = { cwd: project, sessionId: sid, timestamp: ts(i) };
      lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: filler(200) }, block] }, ...base }));
      const prompted = rand() < 0.05;
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out }] }, permissionDecision: { decision: "accept", source: prompted ? "user_temporary" : "config" }, ...base }));
    }
    const text = lines.join("\n") + "\n";
    const file = codex ? join(opts.dir, "codex", "2026", "10", `rollout-${sid}.jsonl`) : join(opts.dir, "claude", project.replace(/\//g, "-"), `${sid}.jsonl`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    bytes += Buffer.byteLength(text);
    files++;
    made += n;
  }
  return { files, bytes };
}
