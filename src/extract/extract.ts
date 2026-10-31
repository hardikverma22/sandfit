import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AnalyzedEvent, Need } from "../types.js";
import { KNOWLEDGE, KNOWN_LOCAL, WRAPPERS } from "./knowledge.js";
import { parseShell, resolvePath, type SimpleCommand } from "./shell.js";

export interface ExtractOptions {
  home?: string;
  /** Look up git remotes in .git/config on disk (default true). */
  readGitRemotes?: boolean;
}

const DEVNULL = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const READ_CMDS = new Set(["cat", "head", "tail", "less", "more", "source", ".", "grep", "rg", "wc", "diff", "file", "stat", "md5", "shasum", "base64", "strings", "hexdump", "od", "jq", "yq", "sort", "uniq", "awk", "sed"]);
const DEV_SCRIPT = /^(dev|start|serve|preview|storybook|watch)(:|$)/;
/** Flags whose value is a separate argument, so the value is not mistaken for a subcommand. */
const VALUE_FLAGS = new Set(["--prefix", "-C", "--cwd", "--dir", "--filter", "-F", "--workspace", "-w", "--port", "-p", "--host", "--config", "-c", "--mode", "--root", "--project", "--manifest-path", "--target", "--profile", "--depth", "-b", "--branch", "-o", "--origin", "-m", "--message", "-n", "--namespace"]);
/** Runners that execute a package's binary: `npx vite`, `pnpm dlx shadcn`, `bunx tsc`. */
const RUNNERS: Record<string, string[]> = { npx: [""], bunx: [""], pnpx: [""], pnpm: ["dlx", "exec"], yarn: ["dlx", "exec"], npm: ["exec", "x"], uvx: [""], pipx: ["run"] };
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--from", "--with"]);
const PYTHON = /^python(\d(\.\d+)?)?$/;
/** curl/wget flags that take a value (so it is not mistaken for a URL). */
const CURL_VALUE_FLAGS = new Set(["-o", "--output", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-X", "--request", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-F", "--form", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-b", "--cookie", "-c", "--cookie-jar", "-T", "--upload-file", "-x", "--proxy", "-K", "--config", "--retry", "-r", "--range", "--cacert", "--cert", "--key", "-E", "--resolve", "-O", "--output-document", "-P", "--directory-prefix", "-U", "-t", "--tries", "--timeout", "--header"]);
const CURL_VALUE_LETTERS: Record<string, string> = { curl: "oHdXuAeFwmbcTxKrE", wget: "OoPUtTe" };

/** Positional arguments with flags and the values of known value-taking flags removed. */
export function cleanPositional(args: string[], valueFlags: Set<string> = VALUE_FLAGS): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1).filter((x) => !x.startsWith("-")));
      break;
    }
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Strip a version from a package spec: create-next-app@latest -> create-next-app, @scope/x@1 -> @scope/x. */
function packageBin(spec: string): string {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  return name.startsWith("@") ? name.split("/").pop() ?? name : name;
}

export function analyze(events: AgentEvent[], opts: ExtractOptions = {}): AnalyzedEvent[] {
  const home = opts.home ?? homedir();
  const remoteCache = new Map<string, string[]>();
  const gitHosts = (cwd: string): string[] => {
    if (opts.readGitRemotes === false) return [];
    if (!remoteCache.has(cwd)) remoteCache.set(cwd, readGitRemoteHosts(cwd));
    return remoteCache.get(cwd)!;
  };
  return events.map((event) => analyzeOne(event, home, gitHosts));
}

function analyzeOne(event: AgentEvent, home: string, gitHosts: (cwd: string) => string[]): AnalyzedEvent {
  const needs: Need[] = [];
  const unknownPrograms: string[] = [];

  if (event.tool === "bash" && event.command) {
    let cmds: SimpleCommand[] = [];
    try {
      cmds = parseShell(event.command, { cwd: event.cwd, home });
    } catch {
      cmds = [];
    }
    for (const cmd of cmds) shellNeeds(cmd, home, gitHosts, needs, unknownPrograms, 0);
    // A secret variable used in a command that talks to hosts: that is where its value goes.
    const hosts = [...new Set(needs.filter((n) => n.kind === "net").map((n) => n.value))];
    if (hosts.length) for (const name of secretEnvRefs(event.command)) needs.push({ kind: "env", value: name, hosts, reason: "used in a command that reaches these hosts", via: "shell" });
  } else if (event.tool === "read") {
    for (const p of event.paths ?? []) needs.push({ kind: "read", value: resolvePath(event.cwd, expandHome(p, home)), reason: event.toolName, via: "tool" });
  } else if (event.tool === "write") {
    for (const p of event.paths ?? []) needs.push({ kind: "write", value: resolvePath(event.cwd, expandHome(p, home)), reason: event.toolName, via: "tool" });
  } else if (event.tool === "fetch" && event.url) {
    const host = hostOf(event.url);
    if (host) needs.push({ kind: "net", value: host, reason: "WebFetch", via: "tool" });
  } else if (event.tool === "mcp") {
    needs.push({ kind: "mcp", value: event.toolName, reason: "MCP tool call", via: "tool" });
  }
  return { event, needs: dedupe(needs.filter(plausible)), unknownPrograms: [...new Set(unknownPrograms)] };
}

function shellNeeds(
  cmd: SimpleCommand,
  home: string,
  gitHosts: (cwd: string) => string[],
  needs: Need[],
  unknown: string[],
  depth: number,
): void {
  if (depth > 4) return;
  for (const r of cmd.redirects) {
    if (DEVNULL.test(r.target)) continue;
    if (r.op === "<" || r.op === "<<<") needs.push({ kind: "read", value: r.target, reason: `input redirect`, via: "shell" });
    else needs.push({ kind: "write", value: r.target, reason: `output redirect (${r.op})`, via: "shell" });
  }
  let argv = cmd.argv.slice();
  if (argv.length === 0) return;

  // Unwrap wrappers like `sudo`, `env FOO=1`, `timeout 30`, `xargs -n1`.
  for (let guard = 0; guard < 5 && argv.length; guard++) {
    const name = basename(argv[0]!);
    const two = `${name} ${argv[1] ?? ""}`;
    const spec = WRAPPERS[two] ?? WRAPPERS[name];
    if (!spec) break;
    argv = argv.slice(WRAPPERS[two] ? 2 : 1);
    let positional = spec.skipPositional ?? 0;
    while (argv.length) {
      const a = argv[0]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) argv.shift();
      else if (spec.skipFlagsWithValue?.includes(a)) argv.splice(0, 2);
      else if (a.startsWith("-")) argv.shift();
      else if (positional > 0) {
        argv.shift();
        positional--;
      } else break;
    }
  }
  if (argv.length === 0) return;

  const prog = basename(argv[0]!);
  const progKey = argv[0] === "./gradlew" ? "./gradlew" : prog;
  const args = argv.slice(1);
  const positional = args.filter((a) => !a.startsWith("-"));

  // Nested shells: bash -c "...", sh -c '...', eval "..."
  if ((prog === "bash" || prog === "sh" || prog === "zsh") && args.includes("-c")) {
    const script = args[args.indexOf("-c") + 1];
    if (script) for (const inner of parseShell(script, { cwd: cmd.cwd, home })) shellNeeds(inner, home, gitHosts, needs, unknown, depth + 1);
    return;
  }
  if (prog === "eval") {
    for (const inner of parseShell(args.join(" "), { cwd: cmd.cwd, home })) shellNeeds(inner, home, gitHosts, needs, unknown, depth + 1);
    return;
  }

  // python -m pip install x  ->  pip install x;  python -m http.server  ->  a local server
  if (PYTHON.test(prog) && args.includes("-m")) {
    const i = args.indexOf("-m");
    const mod = args[i + 1] ?? "";
    if (mod === "http.server") needs.push({ kind: "bind", value: "localhost", reason: "python -m http.server starts a local server", via: "shell", inferred: true });
    else if (mod && (KNOWLEDGE[mod] || mod === "pip")) shellNeeds({ ...cmd, argv: [mod, ...args.slice(i + 2)], redirects: [] }, home, gitHosts, needs, unknown, depth + 1);
    return;
  }

  const abs = (p: string) => resolvePath(cmd.cwd, p);

  // Any argument that points at a file is a potential read (this is how secret access shows up).
  // For copy-like tools the last argument is the destination, which is written, not read.
  const copyLike = prog === "cp" || prog === "scp" || prog === "rsync" || prog === "install" || prog === "ln";
  const readArgs = copyLike ? positional.slice(0, -1) : positional;
  for (const a of readArgs) {
    if (looksLikePath(a, home)) {
      if (READ_CMDS.has(prog) || copyLike || prog === "tar" || prog === "zip") {
        needs.push({ kind: "read", value: abs(a), reason: prog, via: "shell" });
      }
    }
  }

  // Filesystem writes visible in arguments.
  switch (prog) {
    case "cp":
    case "ln":
    case "install":
    case "mv": {
      const { sources, dest } = copyArgs(args);
      // mv also removes the sources.
      if (prog === "mv") for (const p of sources) needs.push({ kind: "write", value: abs(p), reason: "mv", via: "shell" });
      if (dest && sources.length) for (const t of copyTargets(sources, dest, abs)) needs.push({ kind: "write", value: t, reason: prog, via: "shell" });
      break;
    }
    case "rm":
    case "rmdir":
    case "mkdir":
    case "touch":
    case "tee":
    case "truncate":
      for (const p of positional) needs.push({ kind: "write", value: abs(p), reason: prog, via: "shell" });
      break;
    case "chmod":
    case "chown":
      for (const p of positional.slice(1)) needs.push({ kind: "write", value: abs(p), reason: prog, via: "shell" });
      break;
    case "sed":
    case "perl":
      for (const p of sedInPlaceFiles(args, prog)) needs.push({ kind: "write", value: abs(p), reason: `${prog} -i`, via: "shell" });
      break;
    case "tar": {
      const ci = args.indexOf("-C");
      if (ci >= 0 && args[ci + 1]) needs.push({ kind: "write", value: abs(args[ci + 1]!), reason: "tar -C", via: "shell" });
      const fi = args.findIndex((a) => /^-?[a-zA-Z]*c[a-zA-Z]*f$/.test(a));
      if (fi >= 0 && args[fi + 1]) needs.push({ kind: "write", value: abs(args[fi + 1]!), reason: "tar create", via: "shell" });
      break;
    }
    case "unzip": {
      const di = args.indexOf("-d");
      if (di >= 0 && args[di + 1]) needs.push({ kind: "write", value: abs(args[di + 1]!), reason: "unzip -d", via: "shell" });
      break;
    }
  }

  // Network.
  if (prog === "git") {
    const positional = cleanPositional(args);
    const sub = positional[0] ?? "";
    // git config / git remote add|set-url|remove write .git/config (or ~/.gitconfig with --global).
    const readOnlyConfig = args.some((a) => /^--(get|get-all|get-regexp|list|show-origin)$/.test(a) || a === "-l") || (sub === "config" && cleanPositional(args.filter((a) => a !== "config")).length < 2);
    if ((sub === "config" && !readOnlyConfig) || (sub === "remote" && ["add", "set-url", "remove", "rm", "rename"].includes(positional[1] ?? ""))) {
      const target = args.includes("--global") ? join(home, ".gitconfig") : args.includes("--system") ? "/etc/gitconfig" : join(gitRootOf(cmd.cwd) ?? cmd.cwd, ".git", "config");
      needs.push({ kind: "write", value: target, reason: `git ${sub}`, via: "shell" });
    }
    const netSubs = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule", "remote"]);
    if (netSubs.has(sub) && !(sub === "remote" && !args.includes("update")) && !(sub === "submodule" && !args.includes("update"))) {
      const urlArgs = positional.filter((a) => gitUrlHost(a));
      const urlHosts = urlArgs.map(gitUrlHost).filter((h): h is string => !!h);
      const hosts = urlHosts.length ? urlHosts : gitHosts(cmd.cwd);
      for (const h of hosts) needs.push({ kind: "net", value: h, reason: `git ${sub}`, via: "shell", inferred: urlHosts.length === 0 });
      // Pushing, or talking to an SSH remote, needs your git credentials (SSH keys, keychain).
      const sshRemote = urlArgs.some((a) => /^[\w.-]+@[\w.-]+:|^ssh:\/\//.test(a)) || (urlArgs.length === 0 && gitUsesSsh(cmd.cwd));
      if (sshRemote) needs.push({ kind: "exec", value: `git ${sub}`, reason: SSH_GIT_REASON, via: "shell" });
      else if (sub === "push") needs.push({ kind: "exec", value: "git push", reason: "needs your git credentials (keychain or a token), which the sandbox protects", via: "shell" });
      if (sub === "clone" && positional.length >= 2) needs.push({ kind: "write", value: abs(positional[positional.length - 1]!), reason: "git clone", via: "shell" });
    }
    return;
  }
  if (prog === "curl" || prog === "wget") {
    const { urls, outputs } = curlArgs(args, prog);
    for (const o of outputs) needs.push({ kind: "write", value: abs(o), reason: `${prog} output`, via: "shell" });
    for (const u of urls) {
      const h = hostOf(u) ?? bareHost(u);
      if (!h) continue;
      if (isLocalHost(h)) needs.push({ kind: "bind", value: "localhost", reason: `${prog} to a local server`, via: "shell" });
      else needs.push({ kind: "net", value: h, reason: prog, via: "shell" });
    }
    return;
  }
  if (prog === "http" || prog === "https" || prog === "xh") {
    for (const a of args) {
      const h = hostOf(a) ?? bareHost(a);
      if (!h) continue;
      if (isLocalHost(h)) needs.push({ kind: "bind", value: "localhost", reason: `${prog} to a local server`, via: "shell" });
      else needs.push({ kind: "net", value: h, reason: prog, via: "shell" });
    }
    return;
  }
  if (prog === "rsync" && positional.some((a) => /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/.test(a))) {
    needs.push({ kind: "exec", value: "rsync", reason: "copies over SSH, which needs your SSH keys (the sandbox protects them)", via: "shell" });
    return;
  }

  const clean = cleanPositional(args);
  const csub = clean[0] ?? "";
  const k = KNOWLEDGE[progKey];
  if (k) {
    // A tool that cannot run sandboxed runs outside the sandbox: it needs no grants inside it.
    if (k.exclude) {
      needs.push({ kind: "exec", value: prog, reason: k.exclude, via: "shell" });
      return;
    }
    const runnerSubs = RUNNERS[prog];
    const isRunner = !!runnerSubs && runnerSubs.includes(runnerSubs[0] === "" ? "" : csub);
    const subMatches = isRunner || !k.netSubcommands || k.netSubcommands.includes(csub) || (csub === "" && k.netSubcommands.includes(""));
    if (k.hosts && subMatches) for (const h of k.hosts) needs.push({ kind: "net", value: h, reason: `${prog}${csub ? " " + csub : ""}`, via: "shell", inferred: true });
    if (k.writes && subMatches) for (const w of k.writes.filter((x) => existsSync(expandHome(x, home)))) needs.push({ kind: "write", value: expandHome(w, home), reason: `${prog} cache`, via: "shell", inferred: true });
    if (k.sockets) for (const s of k.sockets) needs.push({ kind: "socket", value: s, reason: prog, via: "shell", inferred: true });
    if (k.tokenEnv && k.hosts && subMatches) for (const t of k.tokenEnv) needs.push({ kind: "env", value: t, hosts: k.hosts, reason: `${prog} sends it`, via: "shell", inferred: true });
    if (k.readsSecrets) for (const r of k.readsSecrets.filter((x) => existsSync(expandHome(x, home)))) needs.push({ kind: "read", value: expandHome(r, home), reason: `${prog} reads its config`, via: "shell", inferred: true });
    const runScript = (csub === "run" || csub === "run-script") ? clean[1] ?? "" : csub;
    if (k.bindSubcommands && (k.bindSubcommands.includes("*") || k.bindSubcommands.includes(csub) || DEV_SCRIPT.test(runScript))) {
      needs.push({ kind: "bind", value: "localhost", reason: `${prog}${csub ? " " + csub : ""} starts a local server`, via: "shell", inferred: true });
    }
    // npx vite / pnpm dlx shadcn: also analyze the program the runner starts.
    if (isRunner) {
      const rest = runnerSubs![0] === "" ? args : args.slice(args.indexOf(csub) + 1);
      const inner = cleanPositional(rest, RUNNER_VALUE_FLAGS);
      if (inner.length) {
        const start = rest.indexOf(inner[0]!);
        shellNeeds({ ...cmd, argv: [packageBin(inner[0]!), ...rest.slice(start + 1)], redirects: [] }, home, gitHosts, needs, unknown, depth + 1);
      }
    }
    return;
  }
  // create-next-app my-app, create-vite web: scaffolders write their first argument.
  if (/^create-[\w-]+$/.test(prog)) {
    if (clean[0]) needs.push({ kind: "write", value: abs(clean[0]), reason: `${prog} scaffolds a project`, via: "shell" });
    return;
  }
  if (!KNOWN_LOCAL.has(prog) && !/^[./$~]/.test(prog) && !prog.includes("=") && /^[\w.+-]+$/.test(prog)) unknown.push(prog);
}

/**
 * Where cp/mv/ln/install put things: into the destination folder (when it ends with "/",
 * exists as a folder, or there are several sources), else the destination itself.
 */
function copyTargets(sources: string[], raw: string, abs: (p: string) => string): string[] {
  const dest = abs(raw);
  let isDir = raw.endsWith("/") || sources.length > 1;
  if (!isDir) {
    try {
      isDir = statSync(dest).isDirectory();
    } catch {
      isDir = false;
    }
  }
  if (!isDir) return [dest];
  return sources.map((s) => `${dest}/${s.replace(/\/+$/, "").split("/").pop()}`);
}

const COPY_VALUE_FLAGS = new Set(["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]);

/** Sources and destination of cp/mv/ln/install, honouring -t DIR and flags that take a value. */
export function copyArgs(args: string[]): { sources: string[]; dest?: string } {
  const pos: string[] = [];
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-t" || a === "--target-directory") target = args[++i];
    else if (a.startsWith("--target-directory=")) target = a.slice(a.indexOf("=") + 1);
    else if (COPY_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("-")) pos.push(a);
  }
  if (target !== undefined) return { sources: pos, dest: target.endsWith("/") ? target : `${target}/` };
  return pos.length >= 2 ? { sources: pos.slice(0, -1), dest: pos[pos.length - 1] } : { sources: pos };
}

/**
 * Files edited in place by `sed -i` / `perl -pi`. Handles GNU `-i`, `-i.bak`, BSD `-i ''`,
 * and scripts given with -e/-f (then every positional is a file).
 */
export function sedInPlaceFiles(args: string[], prog = "sed"): string[] {
  let inPlace = false;
  let explicitScript = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in-place" || a.startsWith("--in-place=")) inPlace = true;
    else if (a === "-i" || (prog === "perl" && /^-[a-z]*i/.test(a) && !a.startsWith("--"))) {
      inPlace = true;
      // BSD sed: `-i ''` or `-i .bak` takes a separate suffix argument
      if (prog === "sed" && a === "-i" && (args[i + 1] === "" || /^\.[\w-]+$/.test(args[i + 1] ?? ""))) i++;
      if (prog === "perl" && a.endsWith("e")) {
        explicitScript = true;
        i++;
      }
    } else if (prog === "sed" && a.startsWith("-i")) inPlace = true;
    else if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
      explicitScript = true;
      i++;
    } else if (/^-[a-zA-Z]*e$/.test(a) && prog === "perl") {
      explicitScript = true;
      i++;
    } else if (a.startsWith("-")) continue;
    else positional.push(a);
  }
  if (!inPlace) return [];
  return (explicitScript ? positional : positional.slice(1)).filter((p) => p !== "");
}

/** Nearest folder at or above `cwd` that holds a .git directory. */
function gitRootOf(cwd: string): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 30 && dir; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dir.replace(/\/[^/]+$/, "") || "/";
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Why git over SSH runs outside the sandbox. The policy builder keys on this to group fetch, pull and push. */
export const SSH_GIT_REASON = "talks to an SSH remote, which needs your SSH keys (the sandbox protects ~/.ssh)";

const sshCache = new Map<string, boolean>();
function gitUsesSsh(cwd: string): boolean {
  if (!sshCache.has(cwd)) {
    let dir = cwd;
    let result = false;
    for (let i = 0; i < 20 && dir; i++) {
      const cfg = join(dir, ".git", "config");
      if (existsSync(cfg)) {
        try {
          result = /^\s*url\s*=\s*(?:[\w.-]+@[\w.-]+:|ssh:\/\/)/m.test(readFileSync(cfg, "utf8"));
        } catch {
          result = false;
        }
        break;
      }
      const parent = dir.replace(/\/[^/]+$/, "");
      if (parent === dir) break;
      dir = parent;
    }
    sshCache.set(cwd, result);
  }
  return sshCache.get(cwd)!;
}

export function readGitRemoteHosts(cwd: string): string[] {
  let dir = cwd;
  for (let i = 0; i < 20 && dir; i++) {
    const cfg = join(dir, ".git", "config");
    if (existsSync(cfg)) {
      try {
        const text = readFileSync(cfg, "utf8");
        const hosts = [...text.matchAll(/^\s*url\s*=\s*(.+)$/gm)].map((m) => gitUrlHost(m[1]!.trim())).filter((h): h is string => !!h);
        return [...new Set(hosts)];
      } catch {
        return [];
      }
    }
    const parent = dir.replace(/\/[^/]+$/, "");
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

export function gitUrlHost(s: string): string | undefined {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(s);
  if (scp) return scp[1]!.toLowerCase();
  return hostOf(s);
}

export function hostOf(s: string): string | undefined {
  const m = /^(?:https?|wss?|git|ssh|ftp):\/\/(?:[^@/]+@)?([^/:?#]+)/i.exec(s);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Split curl/wget arguments into URLs and output files. */
export function curlArgs(args: string[], prog: "curl" | "wget"): { urls: string[]; outputs: string[] } {
  const urls: string[] = [];
  const outputs: string[] = [];
  const letters = CURL_VALUE_LETTERS[prog]!;
  const isOutput = (flag: string) => (prog === "curl" ? flag === "-o" || flag === "--output" : flag === "-O" || flag === "--output-document");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        if (isOutput(a.slice(0, eq))) outputs.push(a.slice(eq + 1));
      } else if (CURL_VALUE_FLAGS.has(a)) {
        if (isOutput(a) && args[i + 1]) outputs.push(args[i + 1]!);
        i++;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      // A cluster like -sSLo takes a value when its last letter does.
      const last = a[a.length - 1]!;
      if (letters.includes(last)) {
        if (isOutput(`-${last}`) && args[i + 1]) outputs.push(args[i + 1]!);
        i++;
      }
    } else urls.push(a);
  }
  return { urls, outputs: outputs.filter((o) => o !== "-") };
}

function bareHost(s: string): string | undefined {
  if (s.startsWith("-") || s.includes("=") && !s.includes("/")) return undefined;
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.exec(s);
  if (local) return local[1]!.toLowerCase().replace(/^\[|\]$/g, "");
  const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/|$)/i.exec(s);
  return m && /[a-z]/i.test(m[1]!.split(".").pop()!) ? m[1]!.toLowerCase() : undefined;
}

export function isLocalHost(h: string): boolean {
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h.endsWith(".localhost");
}

function looksLikePath(a: string, home: string): boolean {
  if (/^[a-z]+:\/\//i.test(a)) return false;
  return a.startsWith("/") || a.startsWith("./") || a.startsWith("../") || a.startsWith(home) || /^[\w.@-]+\/[\w./@-]*$/.test(a) || /^\.[\w-]+/.test(a) || /\.[a-z0-9]{1,5}$/i.test(a);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 && !p.startsWith("./") ? p.slice(i + 1) : p;
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

/** Drop needs we cannot trust: unexpanded variables, substitutions, or text that is not a path. */
function plausible(n: Need): boolean {
  if (n.kind === "write" || n.kind === "read") {
    return !/[$`"'<>{}|;\n]|…/.test(n.value) && n.value.length < 400 && !DEVNULL.test(n.value) && n.value !== "/dev";
  }
  if (n.kind === "net") return /^[a-z0-9.*-]+$/.test(n.value) && n.value.includes(".");
  return true;
}

function dedupe(needs: Need[]): Need[] {
  const seen = new Map<string, Need>();
  return needs.filter((n) => {
    const k = `${n.kind}|${n.value}|${n.via}`;
    const prev = seen.get(k);
    if (prev) {
      if (n.hosts) prev.hosts = [...new Set([...(prev.hosts ?? []), ...n.hosts])];
      return false;
    }
    seen.set(k, n.hosts ? { ...n } : n);
    return true;
  }).map((n) => seen.get(`${n.kind}|${n.value}|${n.via}`)!);
}

/** Names that look like they hold a credential: OPENAI_API_KEY, GITHUB_TOKEN, DB_PASSWORD … */
const SECRET_ENV = /^[A-Z][A-Z0-9_]*(TOKEN|_KEY|KEY_ID|SECRET|PASSWORD|PASSWD|_PAT|CREDENTIALS?|_AUTH)$/;

/** Secret-looking environment variables a command expands ($NAME or ${NAME}); never their values. */
export function secretEnvRefs(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) if (SECRET_ENV.test(m[1]!)) out.add(m[1]!);
  return [...out];
}
