import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze, gitUrlHost, sedInPlaceFiles } from "../src/extract/extract.js";
import type { AgentEvent } from "../src/types.js";

const home = mkdtempSync(join(tmpdir(), "sandfit-home-"));
mkdirSync(join(home, ".npm"));
mkdirSync(join(home, ".cache", "uv"), { recursive: true });

function bash(command: string, cwd = "/w/app"): AgentEvent {
  return { id: command, harness: "claude", sessionId: "s", cwd, timestamp: "2026-10-01T00:00:00Z", tool: "bash", toolName: "Bash", command, decision: "auto" };
}
const needsOf = (command: string) => analyze([bash(command)], { home, readGitRemotes: false })[0]!.needs.map((n) => `${n.kind}:${n.value}`);

describe("analyze", () => {
  it("infers registry and cache for package installs", () => {
    const n = needsOf("npm install lodash");
    expect(n).toContain("net:registry.npmjs.org");
    expect(n).toContain(`write:${home}/.npm`);
  });

  it("does not infer network for npm scripts", () => {
    expect(needsOf("npm test")).not.toContain("net:registry.npmjs.org");
  });

  it("only lists cache dirs that exist", () => {
    const n = needsOf("pip install requests");
    expect(n).toContain("net:pypi.org");
    expect(n.some((x) => x.includes("Caches/pip"))).toBe(false);
  });

  it("reads hosts from git URLs, including scp style", () => {
    expect(needsOf("git push https://github.com/a/b.git")).toContain("net:github.com");
    expect(gitUrlHost("git@gitlab.com:a/b.git")).toBe("gitlab.com");
  });

  it("treats curl to localhost as a local server, not network", () => {
    expect(needsOf("curl -s http://localhost:3000/health")).toEqual(["bind:localhost"]);
    expect(needsOf("curl -sSL https://api.example.com/v1 -o out.json")).toEqual(["write:/w/app/out.json", "net:api.example.com"]);
  });

  it("flags dev servers as needing local binding", () => {
    expect(needsOf("pnpm run dev")).toContain("bind:localhost");
    expect(needsOf("npx vite")).toContain("net:registry.npmjs.org");
  });

  it("marks tools that cannot run sandboxed", () => {
    expect(needsOf("docker compose up -d")).toContain("exec:docker");
  });

  it("sees secret reads", () => {
    expect(needsOf("cat ~/.ssh/id_rsa")).toContain(`read:${home}/.ssh/id_rsa`);
  });

  it("unwraps wrappers and nested shells", () => {
    expect(needsOf("sudo -u bob env CI=1 timeout 60 npm ci")).toContain("net:registry.npmjs.org");
    expect(needsOf(`bash -c "uv sync && touch done"`)).toContain("net:pypi.org");
  });

  it("drops untrustworthy values", () => {
    expect(needsOf('echo x > "$OUT"')).toEqual([]);
    expect(needsOf("curl $URL")).toEqual([]);
    expect(needsOf("echo x > /dev/null")).toEqual([]);
  });

  it("reports unknown programs", () => {
    const [a] = analyze([bash("frobnicate --all && ls")], { home, readGitRemotes: false });
    expect(a!.unknownPrograms).toEqual(["frobnicate"]);
  });
});

describe("sedInPlaceFiles", () => {
  it("handles GNU, BSD and -e forms", () => {
    expect(sedInPlaceFiles(["-i", "s/a/b/", "f.txt"])).toEqual(["f.txt"]);
    expect(sedInPlaceFiles(["-i", "", "/x/d", "f.txt"])).toEqual(["f.txt"]);
    expect(sedInPlaceFiles(["-i.bak", "-e", "s/a/b/", "a", "b"])).toEqual(["a", "b"]);
    expect(sedInPlaceFiles(["-n", "5p", "f.txt"])).toEqual([]);
    expect(sedInPlaceFiles(["-pi", "-e", "s/a/b/", "f.pl"], "perl")).toEqual(["f.pl"]);
  });
});
