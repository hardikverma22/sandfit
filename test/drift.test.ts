import { describe, expect, it } from "vitest";
import { computeDrift, driftLine, renderDrift } from "../src/drift.js";
import { mergeSettings } from "../src/emit/claude.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function plan(before: Record<string, unknown>, generated: Record<string, unknown>) {
  return { file: "/p/.claude/settings.json", before, generated, after: mergeSettings(before, generated) };
}

const generated = {
  sandbox: { enabled: true, network: { allowedDomains: ["registry.npmjs.org", "api.acme.dev"] }, filesystem: { allowWrite: ["~/.npm"] }, excludedCommands: ["docker *"] },
  permissions: { deny: ["Read(~/.ssh/**)"] },
};

describe("computeDrift", () => {
  it("splits what is missing from protections, and lists unused grants", () => {
    const d = computeDrift(plan({ sandbox: { enabled: true, network: { allowedDomains: ["registry.npmjs.org", "old.example.com"] } } }, generated), true);
    expect(d.missing.map((c) => c.value).sort()).toEqual(["api.acme.dev", "docker *", "~/.npm"]);
    expect(d.protections).toEqual([{ path: "permissions.deny", kind: "add", value: "Read(~/.ssh/**)" }]);
    expect(d.unused).toEqual([{ path: "sandbox.network.allowedDomains", kind: "add", value: "old.example.com" }]);
  });

  it("is empty when the config already has everything", () => {
    const d = computeDrift(plan(generated, generated), true);
    expect([d.missing, d.protections, d.unused]).toEqual([[], [], []]);
    expect(driftLine(d, 30, "claude")).toBe("");
    expect(plain(renderDrift(d, 30, "claude"))).toContain("in step: your config allows everything your agent needed in the last 30 days.");
  });

  it("reports nothing to compare when there is no config", () => {
    const d = computeDrift(plan({}, generated), false);
    expect(d.missing).toEqual([]);
    expect(driftLine(d, 30, "codex")).toBe("sandfit: no sandbox config at /p/.claude/settings.json yet. Run: npx sandfit apply -t codex");
    expect(plain(renderDrift(d, undefined, "srt"))).toContain("sandfit apply -t srt");
  });
});

describe("drift messages", () => {
  const d = computeDrift(plan({ sandbox: { network: { allowedDomains: ["old.example.com"] } } }, generated), true);

  it("one line names what is missing and where to look", () => {
    expect(driftLine(d, 7, "claude")).toBe(
      "sandfit: your sandbox config is missing 2 hosts, 3 other rules your agent used in the last 7 days, so those commands will be blocked. See: npx sandfit drift",
    );
    expect(driftLine(d, undefined, "claude")).toContain("used in your history");
  });

  it("the full report lists missing rules, counts protections, and marks unused ones", () => {
    const text = plain(renderDrift(d, 30, "claude"));
    expect(text).toContain("5 rules missing");
    expect(text).toContain("+ api.acme.dev");
    expect(text).toContain("also add 1 protection rule");
    expect(text).toContain("· old.example.com");
    expect(text).toContain("sandfit apply   bring the config up to date");
  });
});
