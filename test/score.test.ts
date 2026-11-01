import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { toClaudeSettings } from "../src/emit/claude.js";
import { analyze } from "../src/extract/extract.js";
import { buildPolicy } from "../src/policy/build.js";
import { badgeMarkdown, existingSecrets, gradeOf, loadClaudeSettings, renderScore, scoreClaude, type Scope, type SettingsFile } from "../src/score.js";
import { bashEvent, tempHome } from "./helpers.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const home = tempHome("score-");
const project = join(home, "app");
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(project, ".git"), { recursive: true });

const SSH = join(home, ".ssh");
const AWS = join(home, ".aws");
const ENV = join(project, ".env");
const PEM = join(project, "certs", "server.pem");
const secrets = [SSH, AWS, ENV, PEM];
const ctx = { project, home, secrets };

const file = (data: any, scope: Scope = "project"): SettingsFile => ({
  path: scope === "user" ? join(home, ".claude", "settings.json") : scope === "managed" ? "/etc/claude-code/managed-settings.json" : join(project, ".claude", scope === "local" ? "settings.local.json" : "settings.json"),
  scope,
  data,
});
const score = (...files: SettingsFile[]) => scoreClaude(files, ctx);
const check = (s: ReturnType<typeof score>, id: string) => s.checks.find((c) => c.id === id)!;

/** Everything a well-configured project sets. */
const GOOD = {
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    network: { allowedDomains: ["registry.npmjs.org", "*.github.com"] },
    filesystem: { allowWrite: ["~/.npm"] },
    excludedCommands: ["docker *", "git push *"],
  },
  permissions: { deny: ["Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(./.env)", "Read(./**/*.pem)"] },
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("score: the sandbox switch", () => {
  it("is 0 and grade F with no settings, and names one fix, not seven", () => {
    const s = score();
    expect(s.total).toBe(0);
    expect(s.grade).toBe("F");
    expect(s.checks.filter((c) => c.fix)).toHaveLength(1);
    expect(check(s, "sandbox").fix).toBe("npx sandfit apply");
  });

  it("other good settings count for nothing while the sandbox is off", () => {
    const off = clone(GOOD);
    off.sandbox.enabled = false;
    expect(score(file(off)).total).toBe(0);
  });

  it("a well-configured project scores 95, and strict network in user settings makes 100", () => {
    expect(score(file(GOOD)).total).toBe(95);
    const s = score(file({ sandbox: { network: { strictAllowlist: true } } }, "user"), file(GOOD));
    expect(s.total).toBe(100);
    expect(s.grade).toBe("A");
    expect(s.checks.every((c) => c.status === "ok" && !c.fix)).toBe(true);
  });

  it("what sandfit itself generates scores 95 (and 100 with --user --strict-network)", () => {
    mkdirSync(join(project, "certs"), { recursive: true });
    for (const f of [ENV, PEM]) writeFileSync(f, "x");
    mkdirSync(SSH, { recursive: true });
    mkdirSync(AWS, { recursive: true });
    const events = analyze([bashEvent("npm install", project), bashEvent("docker compose up -d", project, { id: "2" })], { home, readGitRemotes: false });
    const policy = buildPolicy(events, { home, projects: [project] });
    const real = { project, home, secrets: existingSecrets(project, home) };
    expect(real.secrets.sort()).toEqual([AWS, SSH, ENV, PEM].sort());
    expect(scoreClaude([file(toClaudeSettings(policy))], real).total).toBe(95);
    expect(scoreClaude([file(toClaudeSettings(policy, { user: true, strictNetwork: true }), "user")], real).total).toBe(100);
  });
});

describe("score: settings merge the way Claude Code merges them", () => {
  it("a higher scope's scalar wins: local over project over user, managed over all", () => {
    expect(check(score(file({ sandbox: { enabled: true } }, "user"), file({ sandbox: { enabled: false } })), "sandbox").points).toBe(0);
    expect(check(score(file({ sandbox: { enabled: false } }), file({ sandbox: { enabled: true } }, "local")), "sandbox").points).toBe(30);
    expect(check(score(file({ sandbox: { enabled: true } }, "local"), file({ sandbox: { enabled: false } }, "managed")), "sandbox").points).toBe(0);
    // A scope that does not set the key leaves the lower one in force.
    expect(check(score(file({ sandbox: { enabled: true } }, "user"), file({ model: "x" })), "sandbox").points).toBe(30);
  });

  it("lists merge across scopes", () => {
    const s = score(file({ permissions: { deny: ["Read(~/.ssh/**)"] } }, "user"), file({ sandbox: { enabled: true, filesystem: { denyRead: ["~/.aws", ".env", "certs"] } } }));
    expect(check(s, "secrets").status).toBe("ok");
  });

  it("strict network counts only from user or managed settings, where Claude Code honours it", () => {
    const project = clone(GOOD) as any;
    project.sandbox.network.strictAllowlist = true;
    expect(check(score(file(project)), "network").points).toBe(10);
    expect(check(score(file(GOOD), file({ sandbox: { network: { strictAllowlist: true } } }, "managed")), "network").points).toBe(15);
  });
});

describe("score: network", () => {
  const withDomains = (domains: string[], extra: any = {}) => {
    const g = clone(GOOD) as any;
    g.sandbox.network.allowedDomains = domains;
    return score(file({ ...g, ...extra }));
  };
  it("any-site entries score 0, whole top-level domains are partial", () => {
    expect(check(withDomains(["*"]), "network").points).toBe(0);
    expect(check(withDomains([], { permissions: { ...GOOD.permissions, allow: ["WebFetch(domain:*)"] } }), "network").points).toBe(0);
    expect(check(withDomains(["*.com"]), "network")).toMatchObject({ points: 5, status: "partial" });
    expect(check(withDomains(["*.github.com"]), "network").points).toBe(10);
  });
});

describe("score: credentials", () => {
  it("lists what commands can still read", () => {
    const g = clone(GOOD);
    g.permissions.deny = ["Read(~/.ssh/**)"];
    const c = check(score(file(g)), "secrets");
    expect(c.points).toBe(5);
    expect(c.status).toBe("partial");
    expect(c.detail).toBe("3 of 4 credential files readable by commands: ~/.aws, ~/app/.env, ~/app/certs/server.pem");
    expect(c.fix).toBe("npx sandfit apply");
  });

  // Seen on a real Mac: the fix said "npx sandfit apply", which leaves ~/.npmrc readable on purpose.
  it("does not send you to apply for a file your tools read on every run", () => {
    const npmrc = join(home, ".npmrc");
    const c = scoreClaude([file(GOOD)], { project, home, secrets: [SSH, npmrc] }).checks.find((x) => x.id === "secrets")!;
    expect(c.detail).toContain("~/.npmrc");
    expect(c.fix).not.toContain("sandfit apply");
    expect(c.fix).toContain("keep tokens out of it");
  });

  it("reads both path conventions: //abs and ./ in permission rules, /abs and ~ in sandbox paths", () => {
    const s = score(file({ sandbox: { enabled: true, filesystem: { denyRead: [AWS, "~/.ssh"] } }, permissions: { deny: [`Read(/${ENV})`, "Read(certs/**)"] } }));
    expect(check(s, "secrets").status).toBe("ok");
  });

  it("globs cover matching files at any depth", () => {
    const s = score(file({ sandbox: { enabled: true }, permissions: { deny: ["Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(./**/.env)", "Read(./**/*.pem)"] } }));
    expect(check(s, "secrets").status).toBe("ok");
    const missPem = score(file({ sandbox: { enabled: true }, permissions: { deny: ["Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(./.env)", "Read(./*.pem)"] } }));
    expect(check(missPem, "secrets").detail).toContain("server.pem");
  });

  it("a narrower allowRead re-opens a denied credential; a broader one does not", () => {
    const reopened = score(file({ sandbox: { enabled: true, filesystem: { denyRead: ["~/"], allowRead: ["~/.ssh"] } } }));
    expect(check(reopened, "secrets").detail).toContain("~/.ssh");
    const broader = score(file({ sandbox: { enabled: true, filesystem: { denyRead: ["~/.ssh", "~/.aws", "~/app"], allowRead: ["~/"] } } }));
    expect(check(broader, "secrets").status).toBe("ok");
  });

  it("in user settings '.' means ~/.claude, so it protects nothing in the project", () => {
    const s = score(file({ sandbox: { enabled: true, filesystem: { denyRead: [".env", "~/.ssh", "~/.aws"] } } }, "user"));
    expect(check(s, "secrets").detail).toContain("~/app/.env");
  });

  it("full marks when there is nothing to protect", () => {
    expect(check(scoreClaude([file(GOOD)], { ...ctx, secrets: [] }), "secrets")).toMatchObject({ points: 20, detail: "no credential files found on this machine to protect" });
  });
});

describe("score: writes", () => {
  const withWrite = (paths: string[], edit: string[] = []) => {
    const g = clone(GOOD) as any;
    g.sandbox.filesystem.allowWrite = paths;
    g.permissions.allow = edit.map((p) => `Edit(${p})`);
    return check(score(file(g)), "writes");
  };
  it("fails on home, the root, credentials, the agent's own state and shell startup files", () => {
    for (const p of ["~", "~/", "/", "~/.ssh", "~/.ssh/id_rsa", "~/.claude", "~/.claude/projects/x/memory", "~/.codex", "~/.zshrc", "/**"]) expect(withWrite([p]).points, p).toBe(0);
    expect(withWrite([], ["//Users/**"]).points).toBe(5); // not this home, but a broad folder
    expect(withWrite([], ["~/**"]).points).toBe(0);
    expect(withWrite([], [`/${home}/.aws/**`]).points).toBe(0);
  });

  it("broad folders are partial; narrow ones are fine", () => {
    expect(withWrite(["~/Documents"])).toMatchObject({ points: 5, status: "partial" });
    expect(withWrite(["~/.npm", "/opt/data"])).toMatchObject({ points: 10, detail: "2 extra folders, none broad or sensitive" });
    expect(withWrite([])).toMatchObject({ points: 10, detail: "only the project and temp folders" });
  });
});

describe("score: what runs outside the sandbox", () => {
  const withExcluded = (ex: string[]) => {
    const g = clone(GOOD) as any;
    g.sandbox.excludedCommands = ex;
    return check(score(file(g)), "outside");
  };
  it("anything that can run anything is a fail", () => {
    for (const e of ["bash *", "sh", "python3 *", "npx *", "*", "sudo *", "/bin/bash *", "make:*"]) expect(withExcluded([e]).points, e).toBe(0);
  });
  it("specific tools are fine; a long list costs a little", () => {
    expect(withExcluded(["git push *", "docker *", "sudo apt *"]).points).toBe(10);
    expect(withExcluded(["a *", "b *", "c *", "d *", "e *"]).points).toBe(8);
    expect(withExcluded(Array.from({ length: 12 }, (_, i) => `tool${i} *`)).points).toBe(5);
    expect(withExcluded([]).detail).toBe("nothing runs outside the sandbox");
  });
});

describe("score: invariants", () => {
  const anyFile = fc.record({
    scope: fc.constantFrom<Scope>("user", "project", "local", "managed"),
    data: fc.record({
      sandbox: fc.record(
        {
          enabled: fc.boolean(),
          allowUnsandboxedCommands: fc.boolean(),
          failIfUnavailable: fc.boolean(),
          network: fc.record({ allowedDomains: fc.array(fc.constantFrom("*", "*.com", "a.com", "*.github.com")), strictAllowlist: fc.boolean() }, { requiredKeys: [] }),
          filesystem: fc.record({ allowWrite: fc.array(fc.constantFrom("~", "~/.npm", "~/Documents", "/opt/x", "~/.claude")), denyRead: fc.array(fc.constantFrom("~/.ssh", "~/.aws", ".env", "~/")), allowRead: fc.array(fc.constantFrom("~/.ssh", "~/")) }, { requiredKeys: [] }),
          excludedCommands: fc.array(fc.constantFrom("docker *", "bash *", "git push *", "x *")),
        },
        { requiredKeys: [] },
      ),
    }),
  });

  it("is always 0-100, the sum of its checks, and graded consistently", () => {
    fc.assert(
      fc.property(fc.array(anyFile, { maxLength: 4 }), (fs) => {
        const s = scoreClaude(fs.map((f) => file(f.data, f.scope)), ctx);
        expect(s.total).toBeGreaterThanOrEqual(0);
        expect(s.total).toBeLessThanOrEqual(100);
        expect(s.total).toBe(s.checks.reduce((n, c) => n + c.points, 0));
        expect(s.grade).toBe(gradeOf(s.total));
        for (const c of s.checks) expect(c.points <= c.max && (c.status === "ok") === (c.points === c.max)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("adding a deny rule never lowers it; adding an any-site domain never raises it", () => {
    fc.assert(
      fc.property(anyFile, fc.constantFrom("~/.ssh", "~/.aws", ".env", "certs"), (f, deny) => {
        const before = scoreClaude([file(f.data, "project")], ctx).total;
        const more = clone(f.data) as any;
        more.sandbox.filesystem = { ...(more.sandbox.filesystem ?? {}), denyRead: [...(more.sandbox.filesystem?.denyRead ?? []), deny] };
        expect(scoreClaude([file(more, "project")], ctx).total).toBeGreaterThanOrEqual(before);
        const open = clone(f.data) as any;
        open.sandbox.network = { ...(open.sandbox.network ?? {}), allowedDomains: [...(open.sandbox.network?.allowedDomains ?? []), "*"] };
        expect(scoreClaude([file(open, "project")], ctx).total).toBeLessThanOrEqual(before);
      }),
      { numRuns: 300 },
    );
  });
});

describe("loading settings", () => {
  it("reads user, project and local files, skips broken ones, and the badge mode reads only the committed file", () => {
    const h = tempHome("score-load-");
    const p = join(h, "proj");
    mkdirSync(join(p, ".claude"), { recursive: true });
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
    writeFileSync(join(p, ".claude", "settings.json"), JSON.stringify({ sandbox: { failIfUnavailable: true } }));
    writeFileSync(join(p, ".claude", "settings.local.json"), "{ broken");
    const managed = join(h, "managed.json");
    writeFileSync(managed, JSON.stringify({ sandbox: { allowUnsandboxedCommands: false } }));
    const all = loadClaudeSettings(p, h, { managedFiles: [managed] });
    expect(all.map((f) => f.scope)).toEqual(["user", "project", "managed"]);
    expect(loadClaudeSettings(p, h, { projectOnly: true }).map((f) => f.scope)).toEqual(["project"]);
    writeFileSync(join(p, ".claude", "settings.json"), "null");
    expect(loadClaudeSettings(p, h, { managedFiles: [] }).map((f) => f.scope)).toEqual(["user"]);
    rmSync(h, { recursive: true, force: true });
  });
});

describe("output", () => {
  it("grades at the documented boundaries", () => {
    expect([100, 90, 89, 75, 74, 60, 59, 40, 39, 0].map(gradeOf)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]);
  });

  it("the badge is a valid shields.io link coloured by grade, linking to sandfit", () => {
    const s = score(file(GOOD));
    expect(badgeMarkdown(s)).toBe("[![agent sandbox: 95/100](https://img.shields.io/badge/agent%20sandbox-95%2F100-brightgreen)](https://github.com/hardikverma22/sandfit)");
    expect(badgeMarkdown(score())).toContain("0%2F100-red");
  });

  it("the report shows every check, the fix for lost points, the fit and where it read from", () => {
    const text = plain(renderScore(score(file(GOOD)), { home, fit: { blocked: 3, secrets: 2, total: 120 } }));
    expect(text).toContain("95/100  grade A");
    expect(text).toContain("~ Network limited to known sites  10/15");
    expect(text).toContain("fix: npx sandfit apply --user --strict-network");
    expect(text).toContain("would break 2.5% of your recent commands (3 of 120, plus 2 blocked on purpose for reading secrets)");
    expect(text).toContain("Read from: ~/app/.claude/settings.json");
    expect(plain(renderScore(score(), { home }))).toContain("Read from: no Claude Code settings files");
  });
});

describe("score: any settings file, however strange", () => {
  it("never throws and stays in range on arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ scope: fc.constantFrom<Scope>("user", "project", "local", "managed"), data: fc.oneof(fc.object(), fc.record({ sandbox: fc.anything(), permissions: fc.anything() })) }), { maxLength: 4 }), (fs) => {
        const s = scoreClaude(fs.map((f) => file(f.data, f.scope)), ctx);
        expect(s.total).toBeGreaterThanOrEqual(0);
        expect(s.total).toBeLessThanOrEqual(100);
      }),
      { numRuns: 500 },
    );
  });
});
