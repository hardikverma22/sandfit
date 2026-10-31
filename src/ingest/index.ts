import { statSync } from "node:fs";
import type { AgentEvent, Harness } from "../types.js";
import { findClaudeTranscripts, parseClaudeTranscript } from "./claude.js";
import { findCodexTranscripts, parseCodexTranscript } from "./codex.js";

export interface IngestOptions {
  harnesses?: Harness[];
  claudeDir?: string;
  codexDir?: string;
  /** Only keep events whose cwd is inside this directory. */
  project?: string;
  /** Only keep events newer than this many days. */
  days?: number;
}

export interface IngestResult {
  events: AgentEvent[];
  files: number;
  sessions: number;
}

export async function ingest(opts: IngestOptions = {}): Promise<IngestResult> {
  const harnesses = opts.harnesses ?? ["claude", "codex"];
  const cutoff = opts.days !== undefined ? Date.now() - opts.days * 86_400_000 : undefined;
  // A file last modified before the cutoff cannot hold newer events: skip it unread.
  const fresh = (f: string) => cutoff === undefined || mtime(f) >= cutoff;
  const jobs: (() => Promise<AgentEvent[]>)[] = [];
  if (harnesses.includes("claude")) for (const f of findClaudeTranscripts(opts.claudeDir).filter(fresh)) jobs.push(() => parseClaudeTranscript(f));
  if (harnesses.includes("codex")) for (const f of findCodexTranscripts(opts.codexDir).filter(fresh)) jobs.push(() => parseCodexTranscript(f));
  const events = (await pool(jobs, 4)).flat();
  const files = jobs.length;

  let filtered = events.filter((e) => e.cwd);
  if (opts.project) {
    const root = opts.project.replace(/\/+$/, "");
    filtered = filtered.filter((e) => e.cwd === root || e.cwd.startsWith(root + "/"));
  }
  if (cutoff !== undefined) {
    filtered = filtered.filter((e) => !e.timestamp || Date.parse(e.timestamp) >= cutoff);
  }
  filtered.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return { events: filtered, files, sessions: new Set(filtered.map((e) => e.sessionId)).size };
}

function mtime(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** Run async jobs with at most `limit` in flight, keeping results in job order. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}
