import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze } from "../src/extract/extract.js";
import { findBlocks } from "../src/ingest/blocks.js";
import { parseClaudeTranscript } from "../src/ingest/claude.js";
import { parseCodexTranscript } from "../src/ingest/codex.js";
import { addToPolicy, learnSuggestions, lineMentioning } from "../src/learn.js";
import { buildPolicy } from "../src/policy/build.js";
import type { AgentEvent } from "../src/types.js";
import { bashEvent, tempHome, writeClaudeTranscript } from "./helpers.js";

const home = tempHome("learn-");
const project = join(home, "app");
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(join(home, ".cache", "tool"), { recursive: true });
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("findBlocks: real sandbox error formats", () => {
  // Captured from commands run under sandbox-runtime (bubblewrap) in this repo's test environment.
  it("reads blocked writes from coreutils, shells, Python and Node", () => {
    expect(findBlocks("touch: cannot touch '/h/outside.txt': Read-only file system")).toEqual([{ kind: "write", value: "/h/outside.txt" }]);
    expect(findBlocks("/usr/bin/bash: line 1: /h/nope.txt: Read-only file system")).toEqual([{ kind: "write", value: "/h/nope.txt" }]);
    expect(findBlocks("mkdir: cannot create directory '/h/.cache/x': Read-only file system")).toEqual([{ kind: "write", value: "/h/.cache/x" }]);
    expect(findBlocks("OSError: [Errno 30] Read-only file system: '/h/.cache/pip/x'")).toEqual([{ kind: "write", value: "/h/.cache/pip/x" }]);
    expect(findBlocks("Error: EROFS: read-only file system, open '/h/.cache/t/i.json'")).toEqual([{ kind: "write", value: "/h/.cache/t/i.json" }]);
  });

  it("reads macOS Seatbelt's 'Operation not permitted' too", () => {
    expect(findBlocks("touch: /Users/me/x: Operation not permitted")).toEqual([{ kind: "write", value: "/Users/me/x" }]);
    // Captured from Claude Code's sandbox on macOS:
    expect(findBlocks("mkdir: /Users/hardik/.cache/sandfit-probe: Operation not permitted")).toEqual([{ kind: "write", value: "/Users/hardik/.cache/sandfit-probe" }]);
    expect(findBlocks("touch: /Users/hardik/sandfit-write-probe: Operation not permitted\nls: /Users/hardik/sandfit-write-probe: No such file or directory")).toEqual([{ kind: "write", value: "/Users/hardik/sandfit-write-probe" }]);
    expect(findBlocks("PermissionError: [Errno 1] Operation not permitted: '/Users/me/y'")).toEqual([{ kind: "write", value: "/Users/me/y" }]);
    expect(findBlocks("Error: EPERM: operation not permitted, mkdir '/Users/me/z'")).toEqual([{ kind: "write", value: "/Users/me/z" }]);
  });

  it("reads Claude Code's own sandbox violation report", () => {
    // Real output of `curl -sI https://example.org` in a Claude Code session on macOS with sandfit's rules applied.
    const out = [
      "HTTP/1.1 403 not in this command's allowed_domains ? re-run the command with this host listed if it needs it",
      "Content-Type: text/plain",
      "X-Proxy-Error: blocked-by-allowlist",
      "<sandbox_violations>",
      "deny network-outbound example.org:443 (not in this command's allowed_domains — re-run the command with this host listed if it needs it)",
      "</sandbox_violations>",
    ].join("\n");
    expect(findBlocks(out)).toEqual([{ kind: "net", value: "example.org" }]);
    expect(findBlocks("deny network-outbound 127.0.0.1:8080 (x)")).toEqual([]);
  });

  it("reads blocked hosts only when the error names them", () => {
    expect(findBlocks("fatal: unable to access 'https://github.com/octocat/Hello-World/': CONNECT tunnel failed, response 403")).toEqual([{ kind: "net", value: "github.com" }]);
    expect(findBlocks("Error: getaddrinfo EAI_AGAIN example.org")).toEqual([{ kind: "net", value: "example.org" }]);
    expect(findBlocks("curl: (6) Could not resolve host: api.acme.dev")).toEqual([{ kind: "net", value: "api.acme.dev" }]);
    expect(findBlocks("HTTPSConnectionPool(host='pypi.org', port=443): Max retries exceeded (Caused by ProxyError('x', OSError('Tunnel connection failed: 403 Forbidden')))")).toEqual([{ kind: "net", value: "pypi.org" }]);
    // curl through the proxy does not name the host: nothing to learn from it.
    expect(findBlocks("curl: (56) CONNECT tunnel failed, response 403")).toEqual([]);
  });

  it("ignores ordinary output, local hosts and system paths", () => {
    expect(findBlocks("all tests passed")).toEqual([]);
    expect(findBlocks("Error: getaddrinfo ENOTFOUND localhost")).toEqual([]);
    expect(findBlocks("bash: line 1: /proc/sys/x: Read-only file system")).toEqual([]);
    expect(findBlocks("touch: cannot touch 'rel/file': Read-only file system", "/w/app")).toEqual([{ kind: "write", value: "/w/app/rel/file" }]);
  });
});

describe("ingest keeps what was blocked, not the output", () => {
  it("Claude Code tool results", async () => {
    const file = join(home, "c.jsonl");
    writeClaudeTranscript(file, project, [{ command: "node build.mjs", output: `Error: EROFS: read-only file system, open '${home}/.cache/tool/a'` }, { command: "ls", output: "a b c" }]);
    const events = await parseClaudeTranscript(file);
    expect(events[0]!.blocked).toEqual([{ kind: "write", value: `${home}/.cache/tool/a` }]);
    expect(events[1]!.blocked).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("EROFS");
  });

  it("Codex tool outputs", async () => {
    const file = join(home, "x.jsonl");
    const lines = [
      { type: "session_meta", payload: { id: "c", cwd: project } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "1", arguments: JSON.stringify({ command: ["bash", "-lc", "python sync.py"] }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "1", output: JSON.stringify({ output: "curl: (6) Could not resolve host: api.acme.dev\n", metadata: { exit_code: 6 } }) } },
    ].map((l) => JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", ...l }));
    writeFileSync(file, lines.join("\n"));
    const events = await parseCodexTranscript(file);
    expect(events[0]!.blocked).toEqual([{ kind: "net", value: "api.acme.dev" }]);
  });
});

describe("learnSuggestions", () => {
  const ev = (command: string, blocked: AgentEvent["blocked"]) => ({ ...bashEvent(command, project), blocked });
  const analyzed = analyze(
    [
      ev("npm install", undefined),
      ev("python sync.py", [{ kind: "net", value: "api.acme.dev" }]),
      ev("python sync.py --again", [{ kind: "net", value: "api.acme.dev" }]),
      ev("node build.mjs", [{ kind: "write", value: `${home}/.cache/tool/index.json` }]),
      ev("./evil.sh", [
        { kind: "write", value: `${home}/.zshrc` },
        { kind: "write", value: `${home}/.ssh/authorized_keys` },
        { kind: "write", value: home },
        { kind: "write", value: `${project}/.claude/settings.json` },
      ]),
      ev("npm i x", [{ kind: "net", value: "registry.npmjs.org" }]),
      ev("touch ok", [{ kind: "write", value: `${project}/out.txt` }]),
    ],
    { home, readGitRemotes: false },
  );
  const policy = buildPolicy(analyzed, { home, projects: [project] });

  it("suggests hidden needs, counted and with examples", () => {
    const s = learnSuggestions(analyzed, policy, home, [project]);
    expect(s.map((x) => `${x.kind}:${x.value}:${x.count}`)).toEqual(["domain:api.acme.dev:2", "write:~/.cache/tool:1"]);
    expect(s[0]!.examples).toEqual(["python sync.py", "python sync.py --again"]);
  });

  it("never suggests secrets, the agent's config, shell startup files, broad folders, or what is already allowed", () => {
    const values = learnSuggestions(analyzed, policy, home, [project]).map((x) => x.value).join(" ");
    for (const banned of [".zshrc", ".ssh", ".claude", "registry.npmjs.org", "out.txt"]) expect(values).not.toContain(banned);
    expect(values.split(" ")).not.toContain("~");
  });

  it("adds only what was accepted, with evidence", () => {
    const [domain] = learnSuggestions(analyzed, policy, home, [project]);
    const p = addToPolicy(policy, [domain!]);
    expect(p.network.allowDomains).toContain("api.acme.dev");
    expect(p.filesystem.allowWrite).not.toContain("~/.cache/tool");
    expect(p.evidence["net:api.acme.dev"]?.example).toContain("blocked by the sandbox");
  });
});

describe("learn examples", () => {
  it("show the line of a multi-line call that hit the block", () => {
    const call = "cd /Users/me/app\necho '## probe'\nmkdir -p ~/.cache/probe && touch ~/.cache/probe/x\ncurl -s https://api.acme.dev";
    expect(lineMentioning(call, ["api.acme.dev"])).toBe("curl -s https://api.acme.dev");
    expect(lineMentioning(call, ["/Users/me/.cache/probe", "~/.cache/probe", "probe"])).toBe("mkdir -p ~/.cache/probe && touch ~/.cache/probe/x");
    expect(lineMentioning("npm test", ["x"])).toBe("npm test");
    expect(lineMentioning("a\nb", ["zzz"])).toBe("a\nb");
  });
});
