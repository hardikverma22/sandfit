import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { CORPUS } from "../bench/corpus.js";
import { analyze } from "../src/extract/extract.js";
import { buildPolicy, findProjectSecrets, projectRootsOf } from "../src/policy/build.js";
import { dropSubsumed, generalizeHosts, generalizeWrite, gitRoot, isInside, isSelfProtected, tildify, tooBroad } from "../src/policy/paths.js";
import { bashEvent, tempHome } from "./helpers.js";

const home = tempHome("policy-");
const project = join(home, "code", "app");
afterAll(() => rmSync(home, { recursive: true, force: true }));
for (const d of ["code/app/.git", "code/app/web", "code/lib/.git", ".npm", ".cache/pip", "notes", "code/app/config"]) mkdirSync(join(home, d), { recursive: true });
writeFileSync(join(home, "code", "app", ".env.local"), "x");
writeFileSync(join(home, "code", "app", "config", "server.key"), "x");
writeFileSync(join(home, "code", "app", ".env.example"), "x");
writeFileSync(join(home, "notes", "todo.md"), "x");

describe("paths", () => {
  it("treats home, system folders and big containers as too broad", () => {
    for (const p of [home, `${home}/`, "/", "/usr", `${home}/Library`, `${home}/.config`, `${home}/.cache`, `${home}/Documents`]) expect(tooBroad(p, home)).toBe(true);
    for (const p of [project, `${home}/.npm`, `${home}/.config/gh`]) expect(tooBroad(p, home)).toBe(false);
  });

  it("isInside compares whole path segments", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
  });

  it("generalizes a write to the narrowest sensible grant", () => {
    expect(generalizeWrite(join(project, "src/x.ts"), home, [project])).toBeUndefined(); // the project: always allowed
    expect(generalizeWrite("/tmp/build/out", home, [project])).toBeUndefined(); // temp: always allowed
    expect(generalizeWrite(join(home, ".npm/_cacache/x"), home, [project])).toBe(join(home, ".npm")); // a known cache
    expect(generalizeWrite(join(home, "code/lib/src/a.ts"), home, [project])).toBe(join(home, "code/lib")); // a separate repo
    expect(generalizeWrite(join(home, "notes/todo.md"), home, [project])).toBe(join(home, "notes")); // an existing file's folder
    expect(generalizeWrite(join(home, "notes/new-dir"), home, [project])).toBe(join(home, "notes/new-dir")); // not a file name: itself
    expect(generalizeWrite(join(home, "report.pdf"), home, [project])).toBe(join(home, "report.pdf")); // never widened to ~
  });

  it("never grants a repository that contains the project", () => {
    const outer = join(home, "mono");
    mkdirSync(join(outer, ".git"), { recursive: true });
    mkdirSync(join(outer, "packages", "app"), { recursive: true });
    mkdirSync(join(outer, "tools"), { recursive: true });
    expect(generalizeWrite(join(outer, "tools/gen.sh"), home, [join(outer, "packages/app")])).toBe(join(outer, "tools"));
  });

  it("never returns a too-broad path, whatever it is given (property)", () => {
    const seg = fc.constantFrom("a", "b", ".config", ".cache", "Library", "Documents", "x.txt", "..", ".local", "share");
    fc.assert(
      fc.property(fc.array(seg, { maxLength: 5 }), fc.boolean(), (parts, inHome) => {
        const p = (inHome ? home : "") + "/" + parts.join("/");
        const g = generalizeWrite(p, home, [project]);
        if (g !== undefined) expect(tooBroad(g, home) && g !== p).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("collapses hosts only when three or more share a parent", () => {
    expect(generalizeHosts(["a.x.com", "b.x.com"])).toEqual(["a.x.com", "b.x.com"]);
    expect(generalizeHosts(["a.x.com", "b.x.com", "c.x.com", "a.x.com"])).toEqual(["*.x.com"]);
    expect(generalizeHosts(["a.com", "b.com", "c.com"])).toEqual(["a.com", "b.com", "c.com"]); // never *.com
  });

  it("drops paths covered by a broader one", () => {
    expect(dropSubsumed(["~/a/b", "~/a", "~/ab", "~/a/b/c"])).toEqual(["~/a", "~/ab"]);
  });

  it("knows the agent's own config is off limits", () => {
    expect(isSelfProtected(join(home, ".claude/settings.json"), home, [project])).toBe(true);
    expect(isSelfProtected(join(project, ".claude/settings.local.json"), home, [project])).toBe(true);
    expect(isSelfProtected(join(project, ".git/hooks/pre-push"), home, [project])).toBe(true);
    expect(isSelfProtected(join(home, ".zshrc"), home, [project])).toBe(true);
    expect(isSelfProtected(join(project, "src/settings.json"), home, [project])).toBe(false);
  });

  it("tildify and gitRoot", () => {
    expect(tildify(join(home, "x"), home)).toBe("~/x");
    expect(tildify(home, home)).toBe("~");
    expect(tildify(`${home}x`, home)).toBe(`${home}x`);
    expect(gitRoot(join(project, "web"))).toBe(project);
  });
});

describe("project roots", () => {
  it("uses the git root for subfolders and never a too-broad folder", () => {
    const ev = (cwd: string) => analyze([bashEvent("ls", cwd)], { home, readGitRemotes: false })[0]!;
    expect(projectRootsOf([ev(join(project, "web")), ev(project), ev(home), ev(join(home, "notes"))], home)).toEqual([project, join(home, "notes")].sort());
  });

  it("finds secret files in the project but not examples", () => {
    expect(findProjectSecrets(project)).toEqual([".env.local", "config/server.key"]);
  });
});

describe("buildPolicy", () => {
  const build = (cmds: string[], opts: { minCount?: number } = {}) =>
    buildPolicy(analyze(cmds.map((c) => bashEvent(c, project)), { home, readGitRemotes: false }), { home, projects: [project], ...opts });

  it("denies the project's own secret files, plus the generic patterns", () => {
    const p = build(["ls"]);
    expect(p.filesystem.denyRead).toEqual(expect.arrayContaining(["./.env.local", "./config/server.key", "./.env", "./*.pem", "~/.ssh"]));
  });

  it("drops one-off grants with --min-count", () => {
    const p = build(["curl https://once.example.com", "curl https://twice.example.com", "curl https://twice.example.com/b"], { minCount: 2 });
    expect(p.network.allowDomains).toEqual(["twice.example.com"]);
  });

  it("keeps ~/.npmrc readable with a warning when npm needs it", () => {
    writeFileSync(join(home, ".npmrc"), "registry=x");
    const p = build(["npm install"]);
    expect(p.filesystem.denyRead).not.toContain("~/.npmrc");
    expect(p.warnings.join(" ")).toContain("~/.npmrc stays readable");
    rmSync(join(home, ".npmrc"));
  });

  it("masks a secret variable only towards hosts the policy allows", () => {
    const p = build(['curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/x', "npm publish"]);
    expect(p.maskEnv).toEqual([
      { name: "NODE_AUTH_TOKEN", hosts: ["registry.npmjs.org"] },
      { name: "NPM_TOKEN", hosts: ["registry.npmjs.org"] },
      { name: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
    ]);
    // Below --min-count the host is not allowed, so the variable is not masked towards it either.
    expect(build(['curl -H "x: $OPENAI_API_KEY" https://api.openai.com/v1/x'], { minCount: 2 }).maskEnv).toBeUndefined();
    expect(JSON.stringify(build(["OPENAI_API_KEY=sk-live-abcdefghijklmnop1234 curl https://api.openai.com"]))).not.toContain("sk-live-abcdefghijklmnop1234");
  });

  it("records evidence with credentials redacted", () => {
    const p = build(["curl -H 'Authorization: Bearer sk-live-abcdefghijklmnop1234' https://api.stripe.com/v1/charges"]);
    expect(p.evidence["net:api.stripe.com"]?.count).toBe(1);
    expect(JSON.stringify(p)).not.toContain("sk-live-abcdefghijklmnop1234");
  });

  it("never grants a broad path or a protected one, for any mix of real commands (property)", () => {
    const cmds = fc.array(fc.constantFrom(...CORPUS.map((c) => c.cmd)), { minLength: 1, maxLength: 12 });
    fc.assert(
      fc.property(cmds, (list) => {
        const p = build(list);
        for (const w of p.filesystem.allowWrite) {
          const abs = w.startsWith("~") ? home + w.slice(1) : w;
          expect(tooBroad(abs, home)).toBe(false);
          expect(isSelfProtected(abs, home, [project])).toBe(false);
          expect(w).not.toMatch(/\.ssh|\.aws|\.gnupg|Keychains/);
        }
        expect(p.network.allowDomains.every((d) => !d.startsWith("*.") || d.split(".").length >= 3)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe("git over SSH", () => {
  // Found on a real Mac: history had `git push` to an SSH remote, so push ran outside the sandbox,
  // but the first `git fetch` failed because ~/.ssh is protected inside it.
  const sshRepo = join(home, "code", "sshapp");
  mkdirSync(join(sshRepo, ".git"), { recursive: true });
  writeFileSync(join(sshRepo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/sshapp.git\n');
  const httpsRepo = join(home, "code", "httpsapp");
  mkdirSync(join(httpsRepo, ".git"), { recursive: true });
  writeFileSync(join(httpsRepo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/httpsapp.git\n');
  const excludedFor = (cwd: string, commands: string[]) =>
    buildPolicy(analyze(commands.map((c) => bashEvent(c, cwd)), { home }), { home, projects: [cwd] }).excludedCommands;

  it("runs fetch, pull and push outside the sandbox together when any of them talked to an SSH remote", () => {
    const ex = excludedFor(sshRepo, ["git push", "git status"]);
    expect(ex.map((e) => e.pattern)).toEqual(["git fetch *", "git pull *", "git push *"]);
    expect(ex.every((e) => e.reason.includes("SSH"))).toBe(true);
  });

  it("leaves HTTPS remotes alone: fetch works inside the sandbox there", () => {
    const ex = excludedFor(httpsRepo, ["git push", "git fetch"]);
    expect(ex.map((e) => e.pattern)).toEqual(["git push *"]);
    expect(ex[0]!.reason).toContain("keychain or a token");
  });
});

describe("the agent's own state", () => {
  // Seen on a real Mac: a write to ~/.claude/projects/<p>/memory was granted to sandboxed commands.
  it("is never granted to commands: they could change what the agent reads or does next", () => {
    const writes = ["~/.claude/projects/x/memory/notes.md", "~/.claude/commands/deploy.md", "~/.codex/prompts/x.md", "~/.claude.json"].map((p) => p.replace("~", home));
    const policy = buildPolicy(analyze(writes.map((w, i) => bashEvent(`echo hi > ${w}`, project, { id: String(i) })), { home }), { home, projects: [project] });
    expect(policy.filesystem.allowWrite.filter((w) => w.includes(".claude") || w.includes(".codex"))).toEqual([]);
  });
});
