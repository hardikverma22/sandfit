import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { parse as tomlParse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { mergeSettings, toClaudeSettings } from "../src/emit/claude.js";
import { toCodexToml, toNonoProfile, toSrtSettings } from "../src/emit/others.js";
import { analyze } from "../src/extract/extract.js";
import { defaultModel, domainAllowed, forecast, modelFromPolicy } from "../src/forecast.js";
import { ingest } from "../src/ingest/index.js";
import { buildPolicy, redact } from "../src/policy/build.js";
import { generalizeHosts, isSecret, tempRoots } from "../src/policy/paths.js";
import type { AgentEvent } from "../src/types.js";
import { VERSION } from "../src/version.js";

// Snapshots shouldn't change on every release.
expect.addSnapshotSerializer({
  test: (v) => typeof v === "string" && v.includes(`sandfit ${VERSION}`),
  serialize: (v, config, indent, depth, refs, printer) =>
    printer((v as string).replaceAll(`sandfit ${VERSION}`, "sandfit <VERSION>"), config, indent, depth, refs),
});

const HOME = "/home/test";
const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const NOW = new Date("2026-10-30T00:00:00Z");

async function load(harness: "claude" | "codex") {
  const ing = await ingest({ harnesses: [harness], claudeDir: `${FIX}claude`, codexDir: `${FIX}codex` });
  return analyze(ing.events, { home: HOME, readGitRemotes: false });
}

describe("ingest", () => {
  it("parses Claude Code transcripts with decisions", async () => {
    const ing = await ingest({ harnesses: ["claude"], claudeDir: `${FIX}claude` });
    expect(ing.events.map((e) => `${e.tool}:${e.decision}`)).toEqual([
      "bash:prompted",
      "bash:auto",
      "bash:rejected",
      "write:auto",
      "fetch:auto",
      "bash:prompted",
      "bash:auto",
      "bash:auto",
      "mcp:unknown",
    ]);
    expect(ing.events.find((e) => e.command?.startsWith("docker"))?.sandboxBypass).toBe(true);
  });

  it("parses Codex rollouts, unwrapping bash -lc and apply_patch", async () => {
    const ing = await ingest({ harnesses: ["codex"], codexDir: `${FIX}codex` });
    expect(ing.events.map((e) => e.command ?? e.paths?.join(","))).toEqual([
      "uv sync && pytest -q",
      "/home/test/api/app/main.py",
      "curl -sS https://api.openai.com/v1/models -o /home/test/api/models.json",
    ]);
    expect(ing.events[2]!.decision).toBe("prompted");
  });
});

describe("policy", () => {
  it("builds the expected policy from Claude Code history", async () => {
    const policy = buildPolicy(await load("claude"), { home: HOME, projects: ["/home/test/app"], now: NOW });
    expect(policy.network.allowDomains).toEqual(["github.com", "registry.npmjs.org"]);
    expect(policy.network.allowLocalBinding).toBe(true);
    expect(policy.filesystem.allowWrite).toEqual(["~/shared/notes"]);
    expect(policy.excludedCommands.map((e) => e.pattern)).toEqual(["docker *", "git push *"]);
    expect(policy.harnessTools.allowFetch).toEqual(["docs.example.com"]);
    expect(policy.mcp.allowTools).toEqual(["mcp__github__create_issue"]);
    expect(policy.filesystem.denyRead).toContain("~/.ssh");
    expect(policy).toMatchSnapshot();
  });

  it("never grants writes to secrets or to the agent's own config", () => {
    const secretish = fc.constantFrom("/home/test/.ssh/id_rsa", "/home/test/.aws/credentials", "/w/app/.env", "/home/test/.claude/settings.json", "/home/test/.zshrc", "/w/app/.claude/settings.json");
    fc.assert(
      fc.property(fc.array(secretish, { minLength: 1, maxLength: 5 }), (paths) => {
        const events: AgentEvent[] = paths.map((p, i) => ({ id: String(i), harness: "claude", sessionId: "s", cwd: "/w/app", timestamp: "t", tool: "bash", toolName: "Bash", command: `echo x >> ${p}`, decision: "auto" }));
        const policy = buildPolicy(analyze(events, { home: HOME, readGitRemotes: false }), { home: HOME, projects: ["/w/app"] });
        expect(policy.filesystem.allowWrite).toEqual([]);
        expect(toClaudeSettings(policy)).toMatchObject({ sandbox: { filesystem: { allowWrite: [] } } });
      }),
    );
  });

  it("redacts credentials in evidence", () => {
    expect(redact("curl -H 'Authorization: Bearer abc123' https://x")).toContain("Bearer ***");
    expect(redact("TOKEN=supersecretvalue npm publish")).toContain("TOKEN=***");
    expect(redact("export KEY=ghp_abcdefghijklmnopqrstuvwxyz0123")).not.toContain("ghp_");
  });

  it("collapses many subdomains into a wildcard", () => {
    expect(generalizeHosts(["a.cdn.x.com", "b.cdn.x.com", "c.cdn.x.com", "x.com"])).toEqual(["*.cdn.x.com", "x.com"]);
  });

  it("recognizes secret files but not examples", () => {
    expect(isSecret("/w/app/.env", HOME)).toBe(true);
    expect(isSecret("/w/app/.env.local", HOME)).toBe(true);
    expect(isSecret("/w/app/.env.example", HOME)).toBe(false);
    expect(isSecret("/home/test/.ssh/id_ed25519.pub", HOME)).toBe(true);
    expect(isSecret("/w/app/key.pub", HOME)).toBe(false);
  });
});

describe("forecast", () => {
  it("shows the default sandbox breaking and the policy fixing it", async () => {
    const analyzed = await load("claude");
    const policy = buildPolicy(analyzed, { home: HOME, projects: ["/home/test/app"], now: NOW });
    const before = forecast(analyzed, defaultModel(["/home/test/app"], "claude", "darwin"), HOME);
    const after = forecast(analyzed, modelFromPolicy(policy, "claude", HOME, ["/home/test/app"]), HOME);
    expect(before.shellCalls).toBe(6);
    // npm install, git push, dev server, docker socket, write outside the project
    expect(before.blockedCalls).toBe(5);
    expect(after.blockedCalls).toBe(1); // only the secret read, on purpose
    expect(after.secretCalls).toBe(1);
    expect(after.excludedCalls).toBe(2); // docker, git push
    expect(after.promptedBefore).toBe(2);
    expect(after.promptsAvoided).toBe(2);
  });

  it("matches wildcard domains only for subdomains", () => {
    expect(domainAllowed("api.github.com", ["*.github.com"])).toBe(true);
    expect(domainAllowed("github.com", ["*.github.com"])).toBe(false);
    expect(domainAllowed("evilgithub.com", ["*.github.com"])).toBe(false);
  });
});

describe("emitters", () => {
  it("produce valid configs for every target", async () => {
    const policy = buildPolicy(await load("claude"), { home: HOME, projects: ["/home/test/app"], now: NOW });
    const claude = toClaudeSettings(policy);
    expect(claude).toMatchSnapshot("claude");
    expect((claude as any).permissions.allow).toBeUndefined();
    expect((toClaudeSettings(policy, { withPermissions: true }) as any).permissions.allow).toContain("WebFetch(domain:docs.example.com)");
    // Temp dirs differ by OS (/tmp on Linux, /var/folders/… on macOS); collapse them so the snapshot is portable.
    const temps = new Set(tempRoots());
    const srt = toSrtSettings(policy) as any;
    srt.filesystem.allowWrite = [...new Set(srt.filesystem.allowWrite.map((p: string) => (temps.has(p) ? "<TEMP>" : p)))];
    expect(srt).toMatchSnapshot("srt");
    expect(toNonoProfile(policy)).toMatchSnapshot("nono");
    const codex = toCodexToml(policy);
    expect(tomlParse(codex)).toMatchObject({ sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: true } });
    expect(tomlParse(toCodexToml(policy, { profile: true }))).toMatchObject({ default_permissions: "sandfit" });
  });

  it("merges into existing settings without dropping user choices", () => {
    const merged = mergeSettings(
      { model: "opus", sandbox: { enabled: false, network: { allowedDomains: ["a.com"] } }, permissions: { deny: ["Bash(rm:*)"] } },
      { sandbox: { enabled: true, network: { allowedDomains: ["b.com"] } }, permissions: { deny: ["Read(~/.ssh/**)"] } },
    );
    expect(merged).toEqual({
      model: "opus",
      sandbox: { enabled: false, network: { allowedDomains: ["a.com", "b.com"] } },
      permissions: { deny: ["Bash(rm:*)", "Read(~/.ssh/**)"] },
    });
  });
});
