/**
 * End-to-end check against a REAL sandbox: Anthropic's sandbox-runtime (srt), which uses
 * Seatbelt on macOS and bubblewrap on Linux. It proves two things:
 *   1. the srt config sandfit emits means what sandfit thinks it means, and
 *   2. sandfit's forecast agrees with what the sandbox actually does.
 *
 * Run with: npm run test:sandbox   (needs network access for the domain checks)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { toSrtSettings } from "../../src/emit/others.js";
import { analyze } from "../../src/extract/extract.js";
import { defaultModel, forecast, modelFromPolicy } from "../../src/forecast.js";
import { buildPolicy } from "../../src/policy/build.js";
import type { AgentEvent } from "../../src/types.js";

const enabled = !!process.env.SANDFIT_REAL_SANDBOX;
const CANARY = "SANDFIT-CANARY-7f3a91";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRT = join(ROOT, "node_modules", ".bin", "srt");

let home: string;
let project: string;
let settingsFile: string;
let online = false;

function srt(command: string, settings = settingsFile) {
  const r = spawnSync(SRT, ["-s", settings, "-c", command], {
    cwd: project,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

const ev = (command: string, i: number): AgentEvent => ({
  id: String(i),
  harness: "claude",
  sessionId: "s",
  cwd: project,
  timestamp: `2026-10-01T00:00:0${i}Z`,
  tool: "bash",
  toolName: "Bash",
  command,
  decision: "auto",
});

describe.skipIf(!enabled)("real sandbox: Anthropic sandbox-runtime", () => {
  // What the agent did in "history". The policy is built from this.
  const history = [
    "mkdir -p ~/shared/notes && echo hello >> ~/shared/notes/log.md",
    "curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/left-pad",
    "echo built > dist.txt",
  ];

  beforeAll(async () => {
    // Not under the OS temp dir: the sandbox allows temp writes, which would hide failures.
    mkdirSync(join(ROOT, ".e2e"), { recursive: true });
    home = realpathSync(mkdtempSync(join(ROOT, ".e2e", "home-")));
    project = join(home, "proj");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), `${CANARY}\n`);
    writeFileSync(join(project, ".env"), `API_KEY=${CANARY}\n`);
    // The history already ran (unsandboxed), so what it created exists on disk.
    mkdirSync(join(home, "shared", "notes"), { recursive: true });
    try {
      online = (await fetch("https://registry.npmjs.org/left-pad", { method: "HEAD" })).ok;
    } catch {
      online = false;
    }
    const policy = buildPolicy(analyze(history.map(ev), { home, readGitRemotes: false }), { home, projects: [project] });
    settingsFile = join(home, "srt-settings.json");
    writeFileSync(settingsFile, JSON.stringify(toSrtSettings(policy), null, 2));
    // If the sandbox itself cannot start, every "blocked" check would pass for the wrong reason.
    const probe = srt("true");
    if (!probe.ok) throw new Error(`sandbox-runtime could not start, so these tests would prove nothing:\n${probe.out}`);
  });

  it("allows everything the history needed", () => {
    expect(srt("mkdir -p ~/shared/notes && echo again >> ~/shared/notes/log.md").ok).toBe(true);
    expect(srt("echo built > dist.txt").ok).toBe(true);
    if (online) expect(srt("curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/left-pad").out).toContain("200");
  });

  it("blocks reading secrets", () => {
    const r = srt("cat ~/.ssh/id_rsa");
    expect(r.out).not.toContain(CANARY);
    const env = srt("cat .env");
    expect(env.out).not.toContain(CANARY);
  });

  it("blocks writes outside the granted paths", () => {
    expect(srt("echo x > ~/elsewhere.txt").ok).toBe(false);
    expect(srt("echo 'curl evil' >> ~/.zshrc").ok).toBe(false);
  });

  it("blocks network to hosts the history never needed", () => {
    if (!online) return;
    const r = srt("curl -sS -m 10 https://example.com");
    expect(r.ok).toBe(false);
  });

  it("forecast agrees with the real sandbox", () => {
    const probes = [
      "echo again >> ~/shared/notes/log.md",
      "echo x > ~/elsewhere.txt",
      "cat ~/.ssh/id_rsa",
      ...(online ? ["curl -sS -m 10 https://example.com", "curl -sS -o /dev/null https://registry.npmjs.org/left-pad"] : []),
    ];
    const policy = buildPolicy(analyze(history.map(ev), { home, readGitRemotes: false }), { home, projects: [project] });
    const model = modelFromPolicy(policy, "process", home, [project]);
    let agree = 0;
    for (const [i, cmd] of probes.entries()) {
      const predictedBlocked = forecast(analyze([ev(cmd, i)], { home, readGitRemotes: false }), model, home).blockedCalls > 0;
      const r = srt(cmd);
      const actuallyBlocked = !r.ok || r.out.includes(CANARY) === false && cmd.includes("id_rsa");
      if (predictedBlocked === actuallyBlocked) agree++;
      else console.warn(`forecast mismatch: ${cmd} predicted=${predictedBlocked} actual=${actuallyBlocked}\n${r.out.slice(0, 300)}`);
    }
    expect(agree).toBe(probes.length);
  });

  it("the default sandbox (no sandfit) breaks the same history", () => {
    const empty = join(home, "srt-empty.json");
    writeFileSync(empty, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: ["."], denyWrite: [] } }));
    expect(srt("mkdir -p ~/shared/notes && echo again >> ~/shared/notes/log.md", empty).ok).toBe(false);
    const predicted = forecast(analyze(history.map(ev), { home, readGitRemotes: false }), defaultModel([project], "process"), home);
    expect(predicted.blockedCalls).toBeGreaterThanOrEqual(online ? 2 : 1);
  });
});
