import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { CORPUS } from "../bench/corpus.js";
import { currentClaudeModel } from "../src/current.js";
import { analyze } from "../src/extract/extract.js";
import { defaultModel, forecast, holdoutSplit, modelFromPolicy, runtimeProtected, staysSandboxed } from "../src/forecast.js";
import { buildPolicy } from "../src/policy/build.js";
import { renderExplain, renderSummary } from "../src/report.js";
import type { AgentEvent } from "../src/types.js";
import { bashEvent, tempHome } from "./helpers.js";

const home = tempHome("forecast-");
const project = join(home, "app");
afterAll(() => rmSync(home, { recursive: true, force: true }));
for (const d of ["app/.git", ".npm", "shared"]) mkdirSync(join(home, d), { recursive: true });

const run = (events: AgentEvent[]) => analyze(events, { home, readGitRemotes: false });
const bash = (c: string, extra: Partial<AgentEvent> = {}) => bashEvent(c, project, extra);

describe("forecast", () => {
  it("counts only shell commands in Claude Code scope, but the agent's own tools too in process scope", () => {
    const events = run([
      { ...bash("x"), tool: "write", toolName: "Edit", command: undefined, paths: [join(home, "elsewhere", "a.ts")] },
      { ...bash("x"), tool: "fetch", toolName: "WebFetch", command: undefined, url: "https://docs.example.com" },
      bash("echo hi"),
    ]);
    const claude = forecast(events, defaultModel([project], "claude", "darwin"), home);
    const proc = forecast(events, defaultModel([project], "process", "darwin"), home);
    expect([claude.shellCalls, claude.blockedCalls]).toEqual([1, 0]);
    expect([proc.shellCalls, proc.blockedCalls]).toEqual([1, 2]);
  });

  it("knows a local server works by default on Linux but not on macOS", () => {
    const events = run([bash("npm run dev")]);
    expect(forecast(events, defaultModel([project], "claude", "linux"), home).blockedCalls).toBe(0);
    expect(forecast(events, defaultModel([project], "claude", "darwin"), home).blockedCalls).toBe(1);
  });

  it("treats tools that cannot run sandboxed as broken until excluded", () => {
    const events = run([bash("docker ps"), bash("gh pr list")]);
    const before = forecast(events, defaultModel([project]), home);
    expect(before.blockedCalls).toBe(2);
    expect(before.blockers.map((b) => b.fix)).toEqual(expect.arrayContaining([expect.stringContaining("excludedCommands: docker")]));
    const policy = buildPolicy(events, { home, projects: [project] });
    const after = forecast(events, modelFromPolicy(policy, "claude", home, [project]), home);
    expect([after.blockedCalls, after.excludedCalls]).toEqual([0, 2]);
  });

  it("models the sandbox runtime's built-in protected files", () => {
    const events = run([bash("echo x > .mcp.json"), bash("git config user.email me@example.com"), bash("git config --get user.email"), bash("echo x > src.txt")]);
    const r = forecast(events, defaultModel([project]), home);
    expect(r.blockedCalls).toBe(2);
    expect(runtimeProtected([project])).toContain(join(project, ".git/hooks"));
  });

  it("never suggests granting a whole broad folder", () => {
    const r = forecast(run([bash("rm -rf ~/Downloads"), bash("touch ~/Documents/x.txt")]), defaultModel([project]), home);
    expect(r.blockers.map((b) => b.fix).join("\n")).not.toMatch(/allowWrite: ~\/(Downloads|Documents)$/m);
  });

  it("counts approvals that the policy makes unnecessary", () => {
    const events = run([bash("npm install", { decision: "prompted" }), bash("cat ~/.ssh/id_rsa", { decision: "prompted" })]);
    const policy = buildPolicy(events, { home, projects: [project] });
    const r = forecast(events, modelFromPolicy(policy, "claude", home, [project]), home);
    expect([r.promptedBefore, r.promptsAvoided, r.secretCalls]).toEqual([2, 1, 1]);
  });

  it("a policy never breaks the history it was built from, except on purpose (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...CORPUS.map((c) => c.cmd)), { minLength: 1, maxLength: 15 }), (cmds) => {
        const events = run(cmds.map((c, i) => bash(c, { id: String(i) })));
        const policy = buildPolicy(events, { home, projects: [project] });
        const r = forecast(events, modelFromPolicy(policy, "claude", home, [project]), home);
        // Only blocks that are deliberate: secrets, protected files, broad folders, scripts' invisible effects.
        for (const b of r.blockers) expect(b.kind === "secret" || b.fix.startsWith("sandfit never grants") || b.kind === "write").toBe(true);
        for (const b of r.blockers.filter((x) => x.kind === "write")) expect(b.fix).toMatch(/never grants|protected/);
      }),
      { numRuns: 150 },
    );
  });

  it("splits history by time for the holdout", () => {
    const items = [3, 1, 2, 5, 4].map((t) => ({ event: { timestamp: `2026-10-0${t}` } }));
    const [train, test] = holdoutSplit(items, 0.4);
    expect(train.map((x) => x.event.timestamp)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(test.map((x) => x.event.timestamp)).toEqual(["2026-10-04", "2026-10-05"]);
  });
});

describe("current Claude Code settings", () => {
  it("reads sandbox settings and WebFetch rules, and ignores broken files", () => {
    const user = join(home, ".claude");
    mkdirSync(user, { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(user, "settings.json"), JSON.stringify({ sandbox: { network: { allowedDomains: ["a.com"], allowLocalBinding: true }, excludedCommands: ["docker *"] }, permissions: { allow: ["WebFetch(domain:b.com)"] } }));
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ sandbox: { filesystem: { allowWrite: ["~/shared", "./out"], denyRead: ["~/.ssh"] } } }));
    writeFileSync(join(project, ".claude", "settings.local.json"), "{ broken");
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "";
    try {
      const { model, configured } = currentClaudeModel([project], home);
      expect(configured).toBe(true);
      expect(model.domains).toEqual(["a.com", "b.com"]);
      expect(model.localBinding).toBe(true);
      expect(model.excluded).toEqual(["docker"]);
      expect(model.writeRoots).toEqual(expect.arrayContaining([join(home, "shared"), join(project, "out")]));
      expect(model.denyRead).toEqual([join(home, ".ssh")]);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = prev;
      rmSync(user, { recursive: true });
      rmSync(join(project, ".claude"), { recursive: true });
    }
  });

  it("is the bare default when nothing is configured", () => {
    expect(currentClaudeModel([project], home).configured).toBe(false);
  });
});

describe("report", () => {
  const events = run([bash("npm install"), bash("echo x >> ~/shared/log"), bash("cat ~/.ssh/id_rsa")]);
  const policy = buildPolicy(events, { home, projects: [project] });
  // Colors are on in some CI terminals; compare plain text.
  const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
  const summary = (evs = events) =>
    plain(renderSummary({
      version: "0.0.0",
      scopeLabel: "project ~/app",
      harnessLabel: "Claude Code",
      events: evs.length,
      sessions: 1,
      baseline: forecast(evs, defaultModel([project]), home),
      baselineConfigured: false,
      withPolicy: forecast(evs, modelFromPolicy(policy, "claude", home, [project]), home),
      policy,
    }));

  it("summarizes before and after in plain words", () => {
    const s = summary();
    expect(s).toContain("read 3 tool calls from 1 session");
    expect(s).toMatch(/67% of your shell commands would break.*\(2 of 3\)/);
    expect(s).toContain("1 command that reads secrets is blocked");
  });

  it("handles an empty history", () => {
    expect(summary([])).toContain("No shell commands found");
  });

  it("explains grants and filters them", () => {
    expect(plain(renderExplain(policy))).toContain("Always denied");
    expect(plain(renderExplain(policy, "npm"))).toContain("registry.npmjs.org");
    expect(plain(renderExplain(policy, "npm"))).not.toContain("~/shared");
    expect(plain(renderExplain(policy, "zzz"))).toContain('No grant matches "zzz"');
  });
});

describe("excluded commands, the way Claude Code matches them", () => {
  // code.claude.com/docs/en/sandboxing: every command in the call must match, matching is on the
  // text, and a cd, a redirect to a file, or $(...) keeps the whole call sandboxed. Seen on a real
  // Mac: `cd repo && git fetch origin` ran sandboxed and failed although `git fetch *` was excluded.
  const ex = ["git fetch", "git push", "docker"];

  it("runs outside only when the whole call is excluded commands", () => {
    for (const ok of ["git fetch", "git fetch origin", "git fetch && git push", "docker compose up -d", "git fetch 2>&1"]) expect(staysSandboxed(ok, ex, project, home)).toBeUndefined();
    expect(staysSandboxed("cd /w/app && git fetch origin", ex, project, home)).toBe("it includes a cd");
    expect(staysSandboxed("git fetch > log.txt", ex, project, home)).toBe("it redirects output to a file");
    expect(staysSandboxed("git fetch $(git remote | head -1)", ex, project, home)).toContain("command substitution");
    expect(staysSandboxed("npm ci && docker compose build", ex, project, home)).toContain("also runs `npm ci`");
    expect(staysSandboxed("git -C ../lib fetch", ex, project, home)).toContain("not excluded as written");
  });

  it("the forecast counts a chained excluded command as blocked, and says why", () => {
    const events = analyze([bashEvent("docker ps", project), bashEvent("cd /tmp && docker ps", project, { id: "2" })], { home });
    const model = { ...defaultModel([project]), excluded: ["docker"] };
    const r = forecast(events, model, home);
    expect(r.excludedCalls).toBe(1);
    expect(r.blockedCalls).toBe(1);
    expect(r.blockers[0]!.key).toBe("exec-chained:docker");
    expect(r.blockers[0]!.fix).toContain("because it includes a cd");
    // Sandboxes that wrap the whole agent have no such rule.
    expect(forecast(events, { ...model, scope: "process" }, home).excludedCalls).toBe(2);
  });

  it("writes exclusions the way the command was typed", () => {
    const policy = buildPolicy(analyze([bashEvent("sudo apt install -y jq", project), bashEvent("/usr/local/bin/docker ps", project)], { home }), { home, projects: [project] });
    expect(policy.excludedCommands.map((e) => e.pattern)).toEqual(["/usr/local/bin/docker *", "sudo apt *"]);
  });
});
