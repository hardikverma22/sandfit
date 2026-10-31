import { parse as tomlParse } from "smol-toml";
import { parse as yamlParse } from "yaml";
import { describe, expect, it } from "vitest";
import { mergeSettings, toClaudeSettings } from "../src/emit/claude.js";
import { toCodexToml, toNonoProfile, toPolicyYaml, toSrtSettings } from "../src/emit/others.js";
import type { Policy } from "../src/types.js";

function policy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    generatedBy: "sandfit test",
    generatedAt: "2026-10-30T00:00:00.000Z",
    source: { harnesses: ["claude"], sessions: 2, events: 10 },
    projects: ["~/app"],
    filesystem: {
      allowWrite: ["~/.npm", "/opt/data"],
      denyRead: ["~/.ssh", "~/.npmrc", "./.env.local", "./.env", "./*.pem"],
      denyWrite: ["~/.zshrc", "./.claude/settings.json"],
    },
    network: { allowDomains: ["registry.npmjs.org"], denyDomains: [], allowLocalBinding: true, allowUnixSockets: ["/tmp/x.sock"] },
    excludedCommands: [{ pattern: "docker *", reason: "daemon socket" }],
    mcp: { allowTools: ["mcp__github__create_issue"] },
    harnessTools: { allowWrite: ["~/notes"], allowFetch: ["docs.example.com"] },
    warnings: [],
    evidence: { "net:registry.npmjs.org": { count: 3, example: "npm ci" } },
    ...over,
  };
}

describe("Claude Code settings", () => {
  const s = toClaudeSettings(policy()) as any;

  it("turns the sandbox on without allowing an escape hatch", () => {
    expect(s.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: ["docker *"] });
    expect(s.sandbox.network).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true, allowUnixSockets: ["/tmp/x.sock"] });
  });

  it("writes permission paths the way Claude Code reads them", () => {
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining(["Read(~/.ssh/**)", "Read(~/.npmrc)", "Read(./.env.local)", "Edit(./.env.local)", "Read(./**/*.pem)", "Edit(./**/*.pem)"]),
    );
    const withPerms = toClaudeSettings(policy({ harnessTools: { allowWrite: ["/abs/dir"], allowFetch: [] } }), { withPermissions: true }) as any;
    expect(withPerms.permissions.allow).toEqual(["Edit(//abs/dir/**)", "mcp__github__create_issue"]);
  });

  it("only adds harness-tool grants to the OS sandbox config when asked", () => {
    expect(JSON.stringify(s)).not.toContain("docs.example.com");
    expect(s.sandbox.filesystem.allowWrite).not.toContain("~/notes");
  });
});

describe("other targets", () => {
  it("srt: wraps the whole agent, so its own tools' needs are included", () => {
    const srt = toSrtSettings(policy()) as any;
    expect(srt.network.allowedDomains).toEqual(["registry.npmjs.org", "docs.example.com"]);
    expect(srt.filesystem.allowWrite).toEqual(expect.arrayContaining([".", "~/.npm", "~/notes", "~/.claude", "~/.codex"]));
    expect(srt.filesystem.denyRead).toEqual(["~/.ssh", "~/.npmrc", ".env.local", ".env"]);
    expect(srt.filesystem.denyWrite).toEqual(["~/.zshrc", ".claude/settings.json"]);
  });

  it("codex: classic form has one network switch; profile form lists domains and denies secrets", () => {
    const classic = tomlParse(toCodexToml(policy())) as any;
    expect(classic.sandbox_workspace_write).toEqual({ network_access: true, writable_roots: ["~/.npm", "/opt/data", "~/notes"] });
    expect(toCodexToml(policy())).toContain("# registry.npmjs.org");
    const profile = tomlParse(toCodexToml(policy(), { profile: true })) as any;
    expect(profile.permissions.sandfit.network).toEqual({ enabled: true, domains: { "registry.npmjs.org": "allow" } });
    expect(profile.permissions.sandfit.filesystem["~/.ssh"]).toBe("deny");
    const offline = tomlParse(toCodexToml(policy({ network: { ...policy().network, allowDomains: [] } }))) as any;
    expect(offline.sandbox_workspace_write.network_access).toBe(false);
  });

  it("nono: uses $HOME and $WORKDIR, since nono does not expand ~", () => {
    const nono = toNonoProfile(policy(), "dev") as any;
    expect(nono.meta.name).toBe("dev");
    expect(nono.filesystem.allow).toEqual(expect.arrayContaining(["$HOME/.npm", "/opt/data", "$HOME/notes", "$HOME/.claude"]));
    expect(nono.filesystem.allow_file).toEqual(["$HOME/.claude.json"]);
    expect(nono.filesystem.deny).toEqual(["$HOME/.ssh", "$HOME/.npmrc", "$WORKDIR/.env.local", "$WORKDIR/.env"]);
    expect(JSON.stringify(nono)).not.toMatch(/"~/);
  });

  it("policy YAML round-trips and starts with a review note", () => {
    const text = toPolicyYaml(policy());
    expect(text.startsWith("# sandfit policy")).toBe(true);
    expect(yamlParse(text)).toEqual(policy());
  });
});

describe("mergeSettings", () => {
  it("adds without removing, de-duplicates lists, and keeps the user's own values", () => {
    const merged = mergeSettings(
      { sandbox: { enabled: false, network: { allowedDomains: ["a.com", "b.com"] } }, hooks: { x: 1 } },
      { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: ["b.com", "c.com"] } } },
    );
    expect(merged).toEqual({ sandbox: { enabled: false, autoAllowBashIfSandboxed: true, network: { allowedDomains: ["a.com", "b.com", "c.com"] } }, hooks: { x: 1 } });
  });

  it("is idempotent", () => {
    const gen = toClaudeSettings(policy());
    const once = mergeSettings({ model: "x" }, gen);
    expect(mergeSettings(once, gen)).toEqual(once);
  });
});
