import { describe, expect, it } from "vitest";
import { diffConfig, unusedEntries } from "../src/diff.js";
import { renderChanges, renderDiff } from "../src/report.js";
import { dropFromPolicy, parseAnswer, reviewCandidates, reviewPolicy } from "../src/review.js";
import type { Policy } from "../src/types.js";

const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");

describe("diffConfig", () => {
  it("reports list additions and removals as sets, ignoring order", () => {
    expect(diffConfig({ a: ["x", "y"] }, { a: ["y", "x", "z"] })).toEqual([{ path: "a", kind: "add", value: "z" }]);
    expect(diffConfig({ a: ["x", "y"] }, { a: ["x"] })).toEqual([{ path: "a", kind: "remove", value: "y" }]);
  });

  it("reports new and changed settings with what they were before", () => {
    expect(diffConfig({ s: { enabled: false } }, { s: { enabled: true, mode: "x" } })).toEqual([
      { path: "s.enabled", kind: "set", value: "true", from: "false" },
      { path: "s.mode", kind: "set", value: "x", from: "unset" },
    ]);
  });

  it("lists everything inside a brand-new section, and removed keys", () => {
    expect(diffConfig({}, { sandbox: { network: { allowedDomains: ["a.com"] } } })).toEqual([{ path: "sandbox.network.allowedDomains", kind: "add", value: "a.com" }]);
    expect(diffConfig({ old: 1, keep: 2 }, { keep: 2 })).toEqual([{ path: "old", kind: "remove", value: "1" }]);
  });

  it("shows a new empty-object setting such as tlsTerminate: {}", () => {
    expect(diffConfig({ sandbox: { network: {} } }, { sandbox: { network: { tlsTerminate: {} } } })).toEqual([{ path: "sandbox.network.tlsTerminate", kind: "set", value: "{}", from: "unset" }]);
  });

  it("is empty when nothing changes", () => {
    const cfg = { sandbox: { enabled: true, network: { allowedDomains: ["a.com", "b.com"] } }, permissions: { deny: ["Read(~/.ssh/**)"] } };
    expect(diffConfig(cfg, structuredClone(cfg))).toEqual([]);
  });

  it("finds entries the user has that this history did not need", () => {
    const existing = { sandbox: { network: { allowedDomains: ["a.com", "old.com"] } }, model: "opus" };
    const generated = { sandbox: { network: { allowedDomains: ["a.com"] } } };
    expect(unusedEntries(existing, generated)).toEqual([{ path: "sandbox.network.allowedDomains", kind: "add", value: "old.com" }]);
  });
});

describe("rendering changes", () => {
  const changes = [
    ...["a.com", "b.com"].map((value) => ({ path: "sandbox.network.allowedDomains", kind: "add" as const, value })),
    { path: "sandbox.enabled", kind: "set" as const, value: "true", from: "unset" },
    ...Array.from({ length: 12 }, (_, i) => ({ path: "permissions.deny", kind: "add" as const, value: `Read(~/s${i})` })),
  ];

  it("lists grants in full and summarizes protection rules", () => {
    const t = plain(renderChanges(changes));
    expect(t).toContain("+ a.com");
    expect(t).toContain("~ sandbox.enabled: true");
    expect(t).toContain("permissions.deny  +12 protection rules");
    expect(t).not.toContain("Read(~/s3)");
    expect(plain(renderChanges(changes, { full: true }))).toContain("Read(~/s3)");
  });

  it("says when apply would change nothing, and when the file is new", () => {
    expect(plain(renderDiff("/x/settings.json", true, [], []))).toContain("already up to date");
    expect(plain(renderDiff("/x/settings.json", false, changes, []))).toContain("does not exist yet");
  });
});

function policy(): Policy {
  return {
    version: 1,
    generatedBy: "t",
    generatedAt: "t",
    source: { harnesses: ["claude"], sessions: 1, events: 1 },
    projects: ["~/app"],
    filesystem: { allowWrite: ["~/.npm", "~/odd"], denyRead: [], denyWrite: [] },
    network: { allowDomains: ["registry.npmjs.org", "once.example.com", "*.cdn.example.com"], denyDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
    excludedCommands: [{ pattern: "docker *", reason: "x" }],
    mcp: { allowTools: ["mcp__a__b"] },
    harnessTools: { allowWrite: [], allowFetch: ["docs.example.com"] },
    warnings: [],
    evidence: {
      "net:registry.npmjs.org": { count: 40, example: "npm ci" },
      "net:once.example.com": { count: 1, example: "curl https://once.example.com" },
      "net:a.cdn.example.com": { count: 1, example: "curl a" },
      "net:b.cdn.example.com": { count: 1, example: "curl b" },
      "net:c.cdn.example.com": { count: 1, example: "curl c" },
      "write:~/.npm": { count: 40, example: "npm ci" },
      "write:~/odd": { count: 1, example: "cp x ~/odd/" },
      "exclude:docker": { count: 1, example: "docker ps" },
      "mcp:mcp__a__b": { count: 5, example: "mcp__a__b" },
      "net:docs.example.com": { count: 1, example: "https://docs.example.com" },
    },
  };
}

describe("review", () => {
  it("picks grants needed rarely, adding up wildcard domains", () => {
    const items = reviewCandidates(policy());
    expect(items.map((i) => `${i.kind}:${i.value}`)).toEqual(["domain:once.example.com", "write:~/odd", "outside:docker *", "tool-fetch:docs.example.com"]);
    // *.cdn.example.com covers three hosts used once each: 3 uses, so only reviewed with a higher threshold.
    expect(reviewCandidates(policy(), 3).map((i) => i.value)).toContain("*.cdn.example.com");
  });

  it("drops exactly what was chosen", () => {
    const p = dropFromPolicy(policy(), reviewCandidates(policy()).filter((i) => i.kind === "domain" || i.kind === "outside"));
    expect(p.network.allowDomains).toEqual(["registry.npmjs.org", "*.cdn.example.com"]);
    expect(p.excludedCommands).toEqual([]);
    expect(p.filesystem.allowWrite).toEqual(["~/.npm", "~/odd"]);
  });

  it("supports keep, drop, and 'the same for the rest'", async () => {
    const answers = ["drop", "keep-rest"] as const;
    const r = await reviewPolicy(policy(), async (_item, i) => answers[i]!);
    expect(r.reviewed).toBe(4);
    expect(r.dropped.map((d) => d.value)).toEqual(["once.example.com"]);
    const all = await reviewPolicy(policy(), async () => "drop-rest");
    expect(all.dropped).toHaveLength(4);
    expect(all.policy.harnessTools.allowFetch).toEqual([]);
  });

  it("keeps a grant on Enter or anything unclear", () => {
    expect(parseAnswer("")).toBe("keep");
    expect(parseAnswer("huh")).toBe("keep");
    expect(parseAnswer(" D ")).toBe("drop");
    expect(parseAnswer("a")).toBe("keep-rest");
    expect(parseAnswer("x")).toBe("drop-rest");
  });
});
