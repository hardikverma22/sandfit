import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseShell } from "../src/extract/shell.js";

const ctx = { cwd: "/w/app", home: "/home/u" };
const argvs = (s: string) => parseShell(s, ctx).map((c) => c.argv);

describe("parseShell", () => {
  it("splits lists and pipelines", () => {
    expect(argvs("npm ci && npm test || echo fail; ls | wc -l")).toEqual([
      ["npm", "ci"],
      ["npm", "test"],
      ["echo", "fail"],
      ["ls"],
      ["wc", "-l"],
    ]);
  });

  it("respects quoting and escapes", () => {
    expect(argvs(`grep -r "a b" 'c|d' e\\ f`)).toEqual([["grep", "-r", "a b", "c|d", "e f"]]);
  });

  it("tracks cd for later commands", () => {
    const cmds = parseShell("cd web && npm i && cd ../api && touch x", ctx);
    expect(cmds.map((c) => c.cwd)).toEqual(["/w/app", "/w/app/web", "/w/app/web", "/w/app/api"]);
  });

  it("scopes cd inside subshells", () => {
    const cmds = parseShell("(cd sub && make) && pwd", ctx);
    expect(cmds.find((c) => c.argv[0] === "pwd")?.cwd).toBe("/w/app");
    expect(cmds.find((c) => c.argv[0] === "make")?.cwd).toBe("/w/app/sub");
  });

  it("captures redirects and ignores fd duplication", () => {
    const [c] = parseShell("node build.js > out/log.txt 2>&1", ctx);
    expect(c!.redirects).toEqual([{ op: ">", target: "/w/app/out/log.txt" }]);
  });

  it("skips heredoc bodies", () => {
    const cmds = parseShell("cat > notes.md <<'EOF'\nrm -rf /\ncurl evil.example\nEOF\necho done", ctx);
    expect(cmds.map((c) => c.argv)).toEqual([["cat"], ["echo", "done"]]);
    expect(cmds[0]!.redirects[0]!.target).toBe("/w/app/notes.md");
  });

  it("parses command substitutions as commands too", () => {
    expect(argvs('echo "$(git rev-parse HEAD)" `whoami`')).toContainEqual(["git", "rev-parse", "HEAD"]);
    expect(argvs('echo "$(git rev-parse HEAD)" `whoami`')).toContainEqual(["whoami"]);
  });

  it("expands ~ and $HOME only", () => {
    expect(argvs("ls ~/x $HOME/y $OTHER/z")).toEqual([["ls", "/home/u/x", "/home/u/y", "$OTHER/z"]]);
  });

  it("separates env assignments from argv", () => {
    const [c] = parseShell("NODE_ENV=test FOO=1 npm test", ctx);
    expect(c!.assignments).toEqual(["NODE_ENV=test", "FOO=1"]);
    expect(c!.argv).toEqual(["npm", "test"]);
  });

  it("never throws or hangs on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        expect(() => parseShell(s, ctx)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });
});
