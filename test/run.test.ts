import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";
import { tempHome, writeClaudeTranscript } from "./helpers.js";

const home = tempHome("run-");
const claudeDir = join(home, ".claude", "projects");
const app = join(home, "app");
const api = join(home, "api");
for (const p of [app, api]) mkdirSync(join(p, ".git"), { recursive: true });
mkdirSync(join(home, ".npm"), { recursive: true });
writeClaudeTranscript(
  join(claudeDir, "-app", "s1.jsonl"),
  app,
  Array.from({ length: 30 }, (_, i) => ({ command: i < 24 ? "npm test" : i < 29 ? "npm install" : "curl https://only-at-the-end.example.com" })),
  "s1",
);
writeClaudeTranscript(join(claudeDir, "-api", "s2.jsonl"), api, [{ command: "pip install requests" }], "s2");
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const opts = { home, claudeDir, codexDir: join(home, "none"), harness: ["claude" as const] };

describe("run", () => {
  it("scopes to the project you are in", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(join(app, "src"));
    const r = await run(opts);
    expect(r.projects).toEqual([app]);
    expect(r.scopeLabel).toBe("project ~/app");
    expect(r.policy.network.allowDomains).not.toContain("pypi.org");
  });

  it("uses every project with --all, or from a folder that is not a project", async () => {
    for (const o of [{ ...opts, all: true }, opts]) {
      vi.spyOn(process, "cwd").mockReturnValue(home);
      const r = await run(o);
      expect(r.projects).toEqual([api, app]);
      expect(r.policy.network.allowDomains).toEqual(expect.arrayContaining(["pypi.org", "registry.npmjs.org"]));
    }
  });

  it("falls back to all projects when this one has no history", async () => {
    const other = join(home, "fresh");
    mkdirSync(join(other, ".git"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(other);
    const r = await run(opts);
    expect(r.scopeLabel).toContain("no history found for ~/fresh");
    expect(r.projects).toEqual([api, app]);
  });

  it("refuses a too-broad --project", async () => {
    await expect(run({ ...opts, project: home })).rejects.toThrow("too broad");
  });

  it("tests the policy on newest history it was not built from", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(app);
    const r = await run({ ...opts, holdout: 0.2 });
    // The last command reaches a host never seen before it: the holdout catches that.
    expect(r.holdout?.result.blockers.map((b) => b.key)).toContain("net:only-at-the-end.example.com");
    expect(r.withPolicy.blockedCalls).toBe(0);
    expect((await run({ ...opts, holdout: 0 })).holdout).toBeUndefined();
  });

  it("builds a process-scope forecast for whole-agent sandboxes", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(app);
    const r = await run({ ...opts, scope: "process" });
    expect(r.baselineConfigured).toBe(false);
    expect(r.baseline.blockedCalls).toBeGreaterThan(0);
  });
});
