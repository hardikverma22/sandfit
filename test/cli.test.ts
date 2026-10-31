/**
 * The CLI as a user runs it: a real process, a fake home with real transcripts in it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as tomlParse } from "smol-toml";
import { parse as yamlParse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, tempHome, writeClaudeTranscript } from "./helpers.js";

// Fabricated, credential-shaped value: it must never appear in anything sandfit prints or writes.
const FAKE_TOKEN = "ghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa";

// The tsx loader, by absolute URL: the CLI runs from folders outside this repo.
const TSX = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "loader.mjs")).href;

let home: string;
let project: string;

function sandfit(args: string[], opts: { cwd?: string; input?: string } = {}) {
  const r = spawnSync(process.execPath, ["--import", TSX, join(ROOT, "src", "cli.ts"), ...args], {
    cwd: opts.cwd ?? project,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    input: opts.input,
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeAll(() => {
  home = tempHome("cli-");
  project = join(home, "app");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
  mkdirSync(join(home, ".npm"), { recursive: true });
  mkdirSync(join(home, "shared"), { recursive: true });
  writeClaudeTranscript(join(home, ".claude", "projects", "-app", "s1.jsonl"), project, [
    { command: "npm install", decision: "user_temporary" },
    { command: "npm run dev" },
    { command: "git push origin main" },
    { command: "echo note >> ~/shared/log.md", decision: "user_temporary" },
    { command: `curl -H "Authorization: token ${FAKE_TOKEN}" https://api.github.com/user` },
    { command: "cat ~/.ssh/id_rsa" },
    { command: "docker compose up -d" },
    { name: "WebFetch", input: { url: "https://docs.example.com/x", prompt: "read" } },
    { name: "Edit", input: { file_path: join(project, "src", "a.ts"), old_string: "a", new_string: "b" } },
  ]);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("sandfit (summary)", () => {
  it("prints the before/after forecast for this project", () => {
    const r = sandfit([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("read 9 tool calls from 1 session (Claude Code)");
    expect(r.out).toContain("If you turn on the sandbox today");
    expect(r.out).toContain("With the sandfit policy");
    expect(r.out).toContain("registry.npmjs.org");
    expect(r.out).toContain("docker, git push");
  });

  it("never prints a credential from history", () => {
    for (const args of [[], ["forecast"], ["explain"], ["--json"], ["emit", "-t", "policy"]]) {
      const r = sandfit(args);
      expect(r.out + r.err).not.toContain(FAKE_TOKEN);
    }
  });

  it("--json is machine-readable and complete", () => {
    const j = JSON.parse(sandfit(["--json"]).out);
    expect(j).toMatchObject({ sessions: 1, toolCalls: 9, projects: [project] });
    expect(j.policy.network.allowDomains).toEqual(expect.arrayContaining(["registry.npmjs.org", "api.github.com"]));
    expect(j.baseline.shellCalls).toBe(7);
    expect(j.withPolicy.blockedCalls).toBe(j.withPolicy.secretCalls);
  });

  it("says so when there is no history, instead of failing", () => {
    const empty = join(home, "empty");
    mkdirSync(join(empty, ".git"), { recursive: true });
    const r = sandfit(["--claude-dir", join(home, "nothing")], { cwd: empty });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No shell commands found");
  });

  it("prints its version", () => {
    expect(sandfit(["--version"]).out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("option checking", () => {
  it.each([
    [["--harness", "cursor"], "--harness"],
    [["--days", "-3"], "--days"],
    [["--holdout", "1.5"], "--holdout"],
    [["--min-count", "0"], "--min-count"],
    [["emit", "-t", "docker"], "--target"],
  ])("rejects %j", (args, flag) => {
    const r = sandfit(args);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(flag);
  });

  it("rejects --strict-network where Claude Code would ignore it", () => {
    const project = sandfit(["emit", "--strict-network"]);
    expect(project.code).toBe(1);
    expect(project.err).toContain("--user");
    expect(sandfit(["emit", "-t", "srt", "--strict-network"]).code).toBe(1);
    expect(sandfit(["diff", "-t", "codex", "--strict-network"]).code).toBe(1);
    const user = JSON.parse(sandfit(["emit", "--user", "--strict-network"]).out);
    expect(user.sandbox.network.strictAllowlist).toBe(true);
  });

  it("--mask-credentials writes masks only to user settings", () => {
    expect(sandfit(["emit", "--mask-credentials"]).err).toContain("--user");
    expect(sandfit(["diff", "-t", "srt", "--mask-credentials"]).code).toBe(1);
    const s = JSON.parse(sandfit(["emit", "--user", "--mask-credentials"]).out);
    expect(s.sandbox.network.tlsTerminate).toEqual({});
    expect(s.sandbox.credentials.envVars).toContainEqual({ name: "NPM_TOKEN", mode: "mask", injectHosts: ["registry.npmjs.org"] });
    // The literal token in history is never written anywhere.
    expect(JSON.stringify(s)).not.toContain(FAKE_TOKEN);
  });

  it("refuses a project that is really the home folder", () => {
    const r = sandfit(["--project", home]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("too broad");
  });
});

describe("forecast and explain", () => {
  it("lists each blocked command with its fix", () => {
    const r = sandfit(["forecast"]);
    expect(r.out).toContain("fix: allowedDomains: registry.npmjs.org");
    expect(r.out).toContain("fix: allowWrite: ~/shared");
    expect(r.out).toContain("blocked on purpose (secret)");
  });

  it("explains a grant with its evidence", () => {
    const r = sandfit(["explain", "npmjs"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("registry.npmjs.org");
    expect(r.out).toContain("e.g. npm install");
    expect(r.out).not.toContain("~/shared");
  });

  it("exits non-zero when nothing matches the filter", () => {
    expect(sandfit(["explain", "nothing-like-this"]).code).toBe(1);
  });
});

describe("emit", () => {
  it("prints valid config for every target", () => {
    const claude = JSON.parse(sandfit(["emit", "-t", "claude"]).out);
    expect(claude.sandbox.enabled).toBe(true);
    expect(claude.sandbox.excludedCommands).toEqual(["docker *", "git push *"]);
    expect(claude.permissions.allow).toBeUndefined();
    expect(JSON.parse(sandfit(["emit", "-t", "claude", "--with-permissions"]).out).permissions.allow).toContain("WebFetch(domain:docs.example.com)");
    const srt = JSON.parse(sandfit(["emit", "-t", "srt"]).out);
    expect(srt.network.allowLocalBinding).toBe(true);
    expect(srt.network.allowedDomains).toContain("docs.example.com"); // srt wraps the whole agent
    expect(tomlParse(sandfit(["emit", "-t", "codex"]).out)).toMatchObject({ sandbox_mode: "workspace-write" });
    expect(JSON.parse(sandfit(["emit", "-t", "nono", "--name", "work"]).out).meta.name).toBe("work");
    expect(yamlParse(sandfit(["emit", "-t", "policy"]).out).version).toBe(1);
    const openshell = yamlParse(sandfit(["emit", "-t", "openshell", "--binary", "/usr/bin/node", "/usr/bin/git"]).out);
    expect(openshell.network_policies.sandfit.endpoints).toContainEqual({ host: "docs.example.com", port: 443 }); // wraps the whole agent too
    expect(openshell.network_policies.sandfit.binaries).toEqual([{ path: "/usr/bin/node" }, { path: "/usr/bin/git" }]);
  });

  it("writes to a file with -o", () => {
    const out = join(home, "out", "policy.yaml");
    const r = sandfit(["emit", "-t", "policy", "-o", out]);
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("allowDomains");
  });
});

describe("apply", () => {
  const settings = () => join(project, ".claude", "settings.json");

  it("will not write without confirmation when not in a terminal", () => {
    const r = sandfit(["apply"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--yes");
    expect(existsSync(settings())).toBe(false);
  });

  it("writes project settings, merges into existing ones and keeps a backup", () => {
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(settings(), JSON.stringify({ model: "opus", sandbox: { enabled: false }, permissions: { deny: ["Bash(rm -rf:*)"] } }));
    const r = sandfit(["apply", "-y"]);
    expect(r.code).toBe(0);
    const s = JSON.parse(readFileSync(settings(), "utf8"));
    expect(s.model).toBe("opus"); // untouched
    expect(s.sandbox.enabled).toBe(false); // the user's explicit choice wins
    expect(s.permissions.deny).toContain("Bash(rm -rf:*)");
    expect(s.permissions.deny).toContain("Read(~/.ssh/**)");
    expect(s.sandbox.network.allowedDomains).toContain("registry.npmjs.org");
    const backups = readdirSync(join(project, ".claude")).filter((f) => f.includes(".sandfit-backup-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(project, ".claude", backups[0]!), "utf8")).model).toBe("opus");
    // Running it again changes nothing in the content.
    const before = readFileSync(settings(), "utf8");
    sandfit(["apply", "-y"]);
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  it("refuses to touch a settings file it cannot parse", () => {
    writeFileSync(settings(), "{ not json");
    const r = sandfit(["apply", "-y"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not valid JSON");
    expect(readFileSync(settings(), "utf8")).toBe("{ not json");
    rmSync(settings());
  });

  it("writes srt, codex and nono configs into the (fake) home", () => {
    expect(sandfit(["apply", "-t", "srt", "-y"]).code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".srt-settings.json"), "utf8")).filesystem.denyRead).toContain("~/.ssh");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "o3"\n');
    expect(sandfit(["apply", "-t", "codex", "-y"]).code).toBe(0);
    expect(tomlParse(readFileSync(join(home, ".codex", "config.toml"), "utf8"))).toMatchObject({ model: "o3", sandbox_mode: "workspace-write" });
    expect(sandfit(["apply", "-t", "nono", "-y", "--name", "work"]).code).toBe(0);
    expect(existsSync(join(home, ".config", "nono", "profiles", "work.json"))).toBe(true);
  });

  it("writes nothing when there is no history", () => {
    const empty = join(home, "empty2");
    mkdirSync(join(empty, ".git"), { recursive: true });
    const r = sandfit(["apply", "-y", "--claude-dir", join(home, "nothing")], { cwd: empty });
    expect(r.code).toBe(1);
    expect(existsSync(join(empty, ".claude"))).toBe(false);
  });
});

describe("diff and review", () => {
  const settings = () => join(project, ".claude", "settings.json");
  const clean = () => rmSync(join(project, ".claude"), { recursive: true, force: true });

  it("diff shows what apply would add, writes nothing, and lists settings history never needed", () => {
    clean();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(settings(), JSON.stringify({ sandbox: { network: { allowedDomains: ["old.example.com"] } } }));
    const r = sandfit(["diff"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("+ registry.npmjs.org");
    expect(r.out).toMatch(/permissions\.deny\s+\+\d+ protection rules/);
    expect(r.out).toContain("· old.example.com");
    expect(JSON.parse(readFileSync(settings(), "utf8"))).toEqual({ sandbox: { network: { allowedDomains: ["old.example.com"] } } });
    const j = JSON.parse(sandfit(["diff", "--json"]).out);
    expect(j.changes).toContainEqual({ path: "sandbox.network.allowedDomains", kind: "add", value: "registry.npmjs.org" });
    expect(j.unused).toEqual([{ path: "sandbox.network.allowedDomains", kind: "add", value: "old.example.com" }]);
  });

  it("apply says when there is nothing to change, and does not write a new backup", () => {
    clean();
    expect(sandfit(["apply", "-y"]).code).toBe(0);
    const r = sandfit(["apply", "-y"]);
    expect(r.out).toContain("already up to date");
    expect(readdirSync(join(project, ".claude")).filter((f) => f.includes("backup"))).toHaveLength(0);
    expect(sandfit(["diff"]).out).toContain("already up to date");
  });

  it("apply --review drops what you say, and re-forecasts what that breaks", () => {
    clean();
    // First rare grant: drop it; then drop all the rest.
    const r = sandfit(["apply", "--review", "-y"], { input: "d\nx\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Review");
    expect(r.out).toContain("because of what you dropped");
    const s = JSON.parse(readFileSync(settings(), "utf8"));
    expect(s.sandbox.network.allowedDomains).toEqual([]);
    expect(s.permissions.deny).toContain("Read(~/.ssh/**)"); // protections are never reviewed away
  });

  it("apply --review keeps everything on Enter", () => {
    clean();
    const r = sandfit(["apply", "--review", "-y"], { input: "\n\n\n\n\n\n\n\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("kept everything");
    expect(JSON.parse(readFileSync(settings(), "utf8")).sandbox.network.allowedDomains).toContain("registry.npmjs.org");
    clean();
  });
});

describe("drift", () => {
  const settings = () => join(project, ".claude", "settings.json");
  const clean = () => rmSync(join(project, ".claude"), { recursive: true, force: true });

  it("says when the sandbox is not set up, and the hook stays quiet about it", () => {
    clean();
    const r = sandfit(["drift"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no config here yet");
    expect(sandfit(["drift", "--quiet"]).out).toContain("no sandbox config at");
    const hook = sandfit(["drift", "--hook"]);
    expect(hook).toMatchObject({ code: 0, out: "" });
  });

  it("is in step right after apply", () => {
    clean();
    expect(sandfit(["apply", "-y"]).code).toBe(0);
    const r = sandfit(["drift"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("in step");
    expect(sandfit(["drift", "--quiet"]).out).toBe("");
    expect(sandfit(["drift", "--hook"]).out).toBe("");
  });

  it("flags what recent history needs that the config lacks, and lists what went unused", () => {
    clean();
    expect(sandfit(["apply", "-y"]).code).toBe(0);
    const s = JSON.parse(readFileSync(settings(), "utf8"));
    s.sandbox.network.allowedDomains = ["old.example.com"];
    writeFileSync(settings(), JSON.stringify(s));
    const r = sandfit(["drift"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("+ registry.npmjs.org");
    expect(r.out).toContain("· old.example.com");
    const j = JSON.parse(sandfit(["drift", "--json"]).out);
    expect(j.missing).toContainEqual({ path: "sandbox.network.allowedDomains", kind: "add", value: "registry.npmjs.org" });
    expect(j.unused).toEqual([{ path: "sandbox.network.allowedDomains", kind: "add", value: "old.example.com" }]);
    expect(j.protections).toEqual([]);
    const hook = sandfit(["drift", "--hook"]);
    expect(hook.code).toBe(0);
    expect(JSON.parse(hook.out).systemMessage).toMatch(/missing \d+ hosts? your agent used in the last 30 days/);
    clean();
  });

  it("the hook never fails a session, even when it cannot read a config", () => {
    clean();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(settings(), "{ not json");
    expect(sandfit(["drift", "--hook"])).toMatchObject({ code: 0, out: "" });
    expect(sandfit(["drift"]).code).not.toBe(0);
    clean();
  });
});

describe("learn", () => {
  let learnProject: string;
  beforeAll(() => {
    learnProject = join(home, "learnapp");
    mkdirSync(join(learnProject, ".git"), { recursive: true });
    writeClaudeTranscript(
      join(home, ".claude", "projects", "-learnapp", "l.jsonl"),
      learnProject,
      [
        { command: "npm install" },
        { command: "python scripts/sync.py", output: "HTTPSConnectionPool(host='api.acme.dev', port=443): Max retries exceeded (Caused by ProxyError('x', OSError('Tunnel connection failed: 403 Forbidden')))" },
        { command: "./deploy.sh", output: `touch: cannot touch '${home}/.zshrc': Read-only file system\nError: getaddrinfo EAI_AGAIN exfil.evil.example` },
      ],
      "learn",
    );
  });

  it("lists what was blocked, but never protected files", () => {
    const r = sandfit(["learn"], { cwd: learnProject });
    expect(r.code).toBe(0);
    expect(r.out).toContain("api.acme.dev");
    expect(r.out).toContain("exfil.evil.example");
    expect(r.out).not.toContain(".zshrc");
    expect(JSON.parse(sandfit(["learn", "--json"], { cwd: learnProject }).out).suggestions).toHaveLength(2);
  });

  it("apply --learn adds only what you accept; Enter skips", () => {
    const r = sandfit(["apply", "--learn", "-y"], { cwd: learnProject, input: "a\n\n" });
    expect(r.code).toBe(0);
    const s = JSON.parse(readFileSync(join(learnProject, ".claude", "settings.json"), "utf8"));
    expect(s.sandbox.network.allowedDomains).toContain("api.acme.dev");
    expect(s.sandbox.network.allowedDomains).not.toContain("exfil.evil.example");
  });

  it("says when there is nothing to learn", () => {
    expect(sandfit(["learn"]).out).toContain("No sandbox blocks found");
  });
});

describe("codex: the two config styles never mix", () => {
  const cfg = () => join(home, ".codex", "config.toml");

  it("refuses a permission profile on top of sandbox_mode, and the reverse", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(cfg(), 'sandbox_mode = "workspace-write"\n');
    const r = sandfit(["apply", "-t", "codex", "--codex-profile", "-y"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ignores permission profiles while sandbox_mode is set");
    expect(readFileSync(cfg(), "utf8")).toBe('sandbox_mode = "workspace-write"\n');

    writeFileSync(cfg(), 'default_permissions = "mine"\n');
    expect(sandfit(["apply", "-t", "codex", "-y"]).err).toContain("Use --codex-profile");

    writeFileSync(cfg(), 'model = "o3"\n');
    expect(sandfit(["apply", "-t", "codex", "--codex-profile", "-y"]).code).toBe(0);
    const written = tomlParse(readFileSync(cfg(), "utf8")) as any;
    expect(written).toMatchObject({ model: "o3", default_permissions: "sandfit", features: { network_proxy: true }, permissions: { sandfit: { extends: ":workspace" } } });
    expect(written.sandbox_mode).toBeUndefined();
  });
});
