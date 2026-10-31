import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/extract/extract.js";
import { isInside, isSecret, isTemp, tildify } from "../src/policy/paths.js";
import type { AgentEvent } from "../src/types.js";
import type { Case } from "./corpus.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Folders that exist in the fake home, so cache inference behaves like a real machine. */
const HOME_DIRS = [
  ".npm", ".bun", ".cargo", ".rustup", "go", ".m2", ".gradle", ".ollama", ".ssh", ".aws", ".kube", ".config/gh",
  ".cache/pip", ".cache/uv", ".cache/pnpm", ".cache/yarn", ".cache/go-build", ".cache/pypoetry", ".cache/composer",
  ".cache/deno", ".cache/huggingface", ".cache/ms-playwright", ".local/share/pnpm", ".local/share/uv", ".local/pipx", ".local/bin",
];

export interface Fixture {
  home: string;
  project: string;
  cleanup: () => void;
}

/** A fake home outside the OS temp dir (temp writes are always allowed, which would hide misses). */
export function makeFixture(): Fixture {
  const base = join(ROOT, ".bench");
  mkdirSync(base, { recursive: true });
  const home = realpathSync(mkdtempSync(join(base, "home-")));
  for (const d of HOME_DIRS) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_rsa"), "fake");
  writeFileSync(join(home, ".aws", "credentials"), "fake");
  writeFileSync(join(home, ".kube", "config"), "fake");
  const project = join(home, "app");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
  return { home, project, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** The needs sandfit reports for one command, in the corpus label format. */
export function predicted(cmd: string, fx: Fixture): Set<string> {
  const event: AgentEvent = { id: "x", harness: "claude", sessionId: "s", cwd: fx.project, timestamp: "2026-10-01T00:00:00Z", tool: "bash", toolName: "Bash", command: cmd, decision: "auto" };
  const [a] = analyze([event], { home: fx.home });
  const out = new Set<string>();
  for (const n of a!.needs) {
    if (n.kind === "net") out.add(`net:${n.value}`);
    else if (n.kind === "bind") out.add("bind:localhost");
    else if (n.kind === "exec") out.add(`exec:${n.value}`);
    else if (n.kind === "write" && !isInside(n.value, fx.project) && !isTemp(n.value)) out.add(`write:${tildify(n.value, fx.home)}`);
    else if (n.kind === "read" && isSecret(n.value, fx.home)) out.add(`secret:${label(n.value, fx)}`);
  }
  return out;
}

function label(p: string, fx: Fixture): string {
  return isInside(p, fx.project) ? `./${p.slice(fx.project.length + 1)}` : tildify(p, fx.home);
}

export interface CaseResult {
  case: Case;
  missed: string[];
  extra: string[];
}

export interface KindScore {
  tp: number;
  fp: number;
  fn: number;
}

export interface Score {
  cases: number;
  exact: number;
  byKind: Record<string, KindScore>;
  total: KindScore;
  results: CaseResult[];
}

export function scoreCorpus(corpus: Case[], fx: Fixture): Score {
  const byKind: Record<string, KindScore> = {};
  const total: KindScore = { tp: 0, fp: 0, fn: 0 };
  const results: CaseResult[] = [];
  const bump = (label: string, field: keyof KindScore) => {
    const kind = label.split(":")[0]!;
    (byKind[kind] ??= { tp: 0, fp: 0, fn: 0 })[field]++;
    total[field]++;
  };
  let exact = 0;
  for (const c of corpus) {
    const got = predicted(c.cmd, fx);
    const want = new Set(c.expect);
    const optional = new Set(c.optional ?? []);
    const missed = [...want].filter((w) => !got.has(w));
    const extra = [...got].filter((g) => !want.has(g) && !optional.has(g));
    for (const w of want) bump(w, got.has(w) ? "tp" : "fn");
    for (const e of extra) bump(e, "fp");
    if (missed.length === 0 && extra.length === 0) exact++;
    results.push({ case: c, missed, extra });
  }
  return { cases: corpus.length, exact, byKind, total, results };
}

export const precision = (s: KindScore) => (s.tp + s.fp === 0 ? 1 : s.tp / (s.tp + s.fp));
export const recall = (s: KindScore) => (s.tp + s.fn === 0 ? 1 : s.tp / (s.tp + s.fn));
