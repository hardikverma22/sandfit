import { parse as tomlParse } from "smol-toml";
import { parse as yamlParse } from "yaml";
import { describe, expect, it } from "vitest";
import { mergeSettings, toClaudeSettings } from "../src/emit/claude.js";
import { openshellHostOk, toCodexToml, toNonoProfile, toOpenShellPolicy, toPolicyYaml, toSrtSettings } from "../src/emit/others.js";
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

  it("turns the sandbox on without allowing an escape hatch, and refuses to run unsandboxed", () => {
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: ["docker *"] });
    expect(s.sandbox.network).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true, allowUnixSockets: ["/tmp/x.sock"] });
  });

  it("writes permission paths the way Claude Code reads them", () => {
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining(["Read(~/.ssh/**)", "Read(~/.npmrc)", "Read(./.env.local)", "Edit(./.env.local)", "Read(./**/*.pem)", "Edit(./**/*.pem)"]),
    );
    const withPerms = toClaudeSettings(policy({ harnessTools: { allowWrite: ["/abs/dir"], allowFetch: [] } }), { withPermissions: true }) as any;
    expect(withPerms.permissions.allow).toEqual(["Edit(//abs/dir/**)", "mcp__github__create_issue"]);
  });

  it("strict network mode is only written to user settings, where Claude Code honours it", () => {
    expect(s.sandbox.network.strictAllowlist).toBeUndefined();
    expect((toClaudeSettings(policy(), { user: true, strictNetwork: true }) as any).sandbox.network.strictAllowlist).toBe(true);
    expect(() => toClaudeSettings(policy(), { strictNetwork: true })).toThrow("user settings");
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
    expect(profile.permissions.sandfit.extends).toBe(":workspace");
    expect(profile.features).toEqual({ network_proxy: true });
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

describe("credential masking", () => {
  const masked = () => policy({ maskEnv: [{ name: "OPENAI_API_KEY", hosts: ["api.openai.com"] }], network: { ...policy().network, allowDomains: ["registry.npmjs.org", "api.openai.com"] } });

  it("masks secret variables for user settings, with TLS termination the proxy needs", () => {
    const s = toClaudeSettings(masked(), { user: true, maskCredentials: true }) as any;
    expect(s.sandbox.network.tlsTerminate).toEqual({});
    // The shape documented at code.claude.com/docs/en/sandboxing#mask-credentials.
    expect(s.sandbox.credentials).toEqual({ envVars: [{ name: "OPENAI_API_KEY", mode: "mask", injectHosts: ["api.openai.com"] }] });
  });

  it("is off unless asked, refused for project settings, and adds nothing when there is nothing to mask", () => {
    expect((toClaudeSettings(masked()) as any).sandbox.credentials).toBeUndefined();
    expect(() => toClaudeSettings(masked(), { maskCredentials: true })).toThrow("user settings");
    const none = toClaudeSettings(policy(), { user: true, maskCredentials: true }) as any;
    expect(none.sandbox.credentials).toBeUndefined();
    expect(none.sandbox.network.tlsTerminate).toBeUndefined();
  });

  it("re-applying does not duplicate credential entries", () => {
    const gen = toClaudeSettings(masked(), { user: true, maskCredentials: true });
    const once = mergeSettings({}, gen);
    expect(mergeSettings(once, gen)).toEqual(once);
    expect((mergeSettings(once, gen) as any).sandbox.credentials.envVars).toHaveLength(1);
  });
});

/** The rules from OpenShell's policy schema reference that a generated policy could break. */
function openshellProblems(doc: any): string[] {
  const out: string[] = [];
  const allowed: Record<string, string[]> = { "": ["version", "filesystem_policy", "landlock", "process", "network_policies", "network_middlewares"], filesystem_policy: ["include_workdir", "read_only", "read_write"], landlock: ["compatibility"] };
  for (const [where, keys] of Object.entries(allowed)) for (const k of Object.keys(where ? doc[where] ?? {} : doc)) if (!keys.includes(k)) out.push(`unknown field ${where}.${k}`);
  if (doc.version !== 1) out.push("version must be 1");
  const fs = doc.filesystem_policy;
  const paths = [...fs.read_only, ...fs.read_write];
  if (paths.length > 256) out.push("more than 256 paths");
  for (const p of paths) if (!p.startsWith("/") || p.split("/").includes("..") || p.includes("*")) out.push(`bad path ${p}`);
  if (fs.read_write.includes("/")) out.push("read_write contains /");
  if (!["best_effort", "hard_requirement"].includes(doc.landlock.compatibility)) out.push("bad landlock");
  for (const [key, rule] of Object.entries<any>(doc.network_policies ?? {})) {
    if (key.startsWith("_provider_")) out.push("reserved rule key");
    for (const k of Object.keys(rule)) if (!["name", "endpoints", "binaries"].includes(k)) out.push(`unknown rule field ${k}`);
    if (!rule.binaries?.length) out.push("a rule without binaries allows nothing");
    for (const b of rule.binaries) if (Object.keys(b).join() !== "path" || !b.path.startsWith("/")) out.push(`bad binary ${JSON.stringify(b)}`);
    for (const e of rule.endpoints) {
      if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) out.push(`bad port on ${e.host}`);
      if (!openshellHostOk(e.host)) out.push(`bad host ${e.host}`);
    }
  }
  return out;
}

describe("OpenShell policy", () => {
  const p = () =>
    policy({
      filesystem: { allowWrite: ["~/.npm", "/opt/data", "./build", "/tmp/x", "/", "/a/../b", "/data/*"], denyRead: ["~/.ssh"], denyWrite: [] },
      network: { allowDomains: ["registry.npmjs.org", "*.githubusercontent.com", "*.io", "10.0.0.5"], denyDomains: [], allowLocalBinding: true, allowUnixSockets: [] },
      source: { harnesses: ["claude", "codex"], sessions: 2, events: 10 },
    });

  it("is a valid OpenShell policy: allowlist only, absolute paths, one rule per agent binary", () => {
    const text = toOpenShellPolicy(p());
    const doc = yamlParse(text) as any;
    expect(openshellProblems(doc)).toEqual([]);
    expect(doc.filesystem_policy.include_workdir).toBe(true);
    // ~/.npm and ./build are inside /sandbox already; "/" , "..", globs and temp paths are not written.
    expect(doc.filesystem_policy.read_write).toEqual(["/sandbox", "/tmp", "/dev/null", "/opt/data"]);
    expect(doc.network_policies.sandfit.endpoints).toEqual([
      { host: "registry.npmjs.org", port: 443 },
      { host: "*.githubusercontent.com", port: 443 },
      { host: "10.0.0.5", port: 443 },
      { host: "docs.example.com", port: 443 },
    ]);
    expect(doc.network_policies.sandfit.binaries).toEqual([{ path: "/usr/local/bin/claude" }, { path: "/usr/local/bin/codex" }]);
    expect(text).toContain("Left out (OpenShell needs at least three labels in a wildcard host): *.io");
    expect(text).toContain("may fail here: docker *");
    expect(JSON.stringify(doc)).not.toContain(".ssh");
  });

  it("takes custom binaries, and drops the network section when nothing needs the network", () => {
    const doc = yamlParse(toOpenShellPolicy(p(), { binaries: ["/usr/bin/node"] })) as any;
    expect(doc.network_policies.sandfit.binaries).toEqual([{ path: "/usr/bin/node" }]);
    expect(() => toOpenShellPolicy(p(), { binaries: ["node"] })).toThrow("absolute");
    const offline = yamlParse(toOpenShellPolicy(policy({ network: { ...policy().network, allowDomains: [] }, harnessTools: { allowWrite: [], allowFetch: [] } }))) as any;
    expect(offline.network_policies).toBeUndefined();
    expect(openshellProblems(offline)).toEqual([]);
  });

  it("checks wildcard hosts the way OpenShell does", () => {
    for (const ok of ["api.example.com", "*.example.com", "*-api.example.com", "api.*.example.com", "**.example.com"]) expect(openshellHostOk(ok)).toBe(true);
    for (const bad of ["*.com", "**.com", "api.**.example.com", "a*b.*x.com", "localhost", "a..com"]) expect(openshellHostOk(bad)).toBe(false);
  });
});
