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
  const events: AgentEvent[] = [];
  let files = 0;

  if (harnesses.includes("claude")) {
    for (const f of findClaudeTranscripts(opts.claudeDir)) {
      files++;
      events.push(...(await parseClaudeTranscript(f)));
    }
  }
  if (harnesses.includes("codex")) {
    for (const f of findCodexTranscripts(opts.codexDir)) {
      files++;
      events.push(...(await parseCodexTranscript(f)));
    }
  }

  let filtered = events.filter((e) => e.cwd);
  if (opts.project) {
    const root = opts.project.replace(/\/+$/, "");
    filtered = filtered.filter((e) => e.cwd === root || e.cwd.startsWith(root + "/"));
  }
  if (opts.days !== undefined) {
    const cutoff = Date.now() - opts.days * 86_400_000;
    filtered = filtered.filter((e) => !e.timestamp || Date.parse(e.timestamp) >= cutoff);
  }
  filtered.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return { events: filtered, files, sessions: new Set(filtered.map((e) => e.sessionId)).size };
}
