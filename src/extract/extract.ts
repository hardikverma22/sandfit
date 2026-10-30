import { existsSync, readFileSync } from "node:fs";
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
  const sub = positional[0] ?? "";

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

  const abs = (p: string) => resolvePath(cmd.cwd, p);

  // Any argument that points at a file is a potential read (this is how secret access shows up).
  for (const a of positional) {
    if (looksLikePath(a, home)) {
      if (READ_CMDS.has(prog) || prog === "cp" || prog === "scp" || prog === "rsync" || prog === "tar" || prog === "zip") {
        needs.push({ kind: "read", value: abs(a), reason: prog, via: "shell" });
      }
    }
  }

  // Filesystem writes visible in arguments.
  switch (prog) {
    case "cp":
    case "ln":
    case "install":
      if (positional.length >= 2) needs.push({ kind: "write", value: abs(positional[positional.length - 1]!), reason: prog, via: "shell" });
      break;
    case "mv":
      for (const p of positional) needs.push({ kind: "write", value: abs(p), reason: "mv", via: "shell" });
      break;
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
    case "curl":
    case "wget": {
      const oi = args.findIndex((a) => a === "-o" || a === "--output" || a === "-O" && prog === "wget");
      if (oi >= 0 && args[oi + 1]) needs.push({ kind: "write", value: abs(args[oi + 1]!), reason: `${prog} output`, via: "shell" });
      break;
    }
  }

  // Network.
  if (prog === "git") {
    const netSubs = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule", "remote"]);
    if (netSubs.has(sub) && !(sub === "remote" && !args.includes("update")) && !(sub === "submodule" && !args.includes("update"))) {
      const urlArgs = positional.filter((a) => gitUrlHost(a));
      const urlHosts = urlArgs.map(gitUrlHost).filter((h): h is string => !!h);
      const hosts = urlHosts.length ? urlHosts : gitHosts(cmd.cwd);
      for (const h of hosts) needs.push({ kind: "net", value: h, reason: `git ${sub}`, via: "shell", inferred: urlHosts.length === 0 });
      // Pushing, or talking to an SSH remote, needs your git credentials (SSH keys, keychain).
      const sshRemote = urlArgs.some((a) => /^[\w.-]+@[\w.-]+:|^ssh:\/\//.test(a)) || (urlArgs.length === 0 && gitUsesSsh(cmd.cwd));
      if (sub === "push" || sshRemote) needs.push({ kind: "exec", value: `git ${sub}`, reason: "needs your git credentials (SSH keys or keychain), which the sandbox protects", via: "shell" });
      if (sub === "clone" && positional.length >= 2) needs.push({ kind: "write", value: abs(positional[positional.length - 1]!), reason: "git clone", via: "shell" });
    }
    return;
  }
  if (prog === "curl" || prog === "wget" || prog === "http" || prog === "https" || prog === "xh") {
    for (const a of args) {
      const h = hostOf(a) ?? (prog !== "curl" && prog !== "wget" ? bareHost(a) : undefined);
      if (h) {
        if (isLocalHost(h)) needs.push({ kind: "bind", value: "localhost", reason: `${prog} to a local server`, via: "shell" });
        else needs.push({ kind: "net", value: h, reason: prog, via: "shell" });
      }
    }
    return;
  }

  const k = KNOWLEDGE[progKey];
  if (k) {
    const subMatches = !k.netSubcommands || k.netSubcommands.includes(sub) || (sub === "" && k.netSubcommands.includes(""));
    if (k.hosts && subMatches) for (const h of k.hosts) needs.push({ kind: "net", value: h, reason: `${prog}${sub ? " " + sub : ""}`, via: "shell", inferred: true });
    if (k.writes && subMatches) for (const w of k.writes.filter((x) => existsSync(expandHome(x, home)))) needs.push({ kind: "write", value: expandHome(w, home), reason: `${prog} cache`, via: "shell", inferred: true });
    if (k.sockets) for (const s of k.sockets) needs.push({ kind: "socket", value: s, reason: prog, via: "shell", inferred: true });
    if (k.exclude) needs.push({ kind: "exec", value: prog, reason: k.exclude, via: "shell" });
    if (k.readsSecrets) for (const r of k.readsSecrets.filter((x) => existsSync(expandHome(x, home)))) needs.push({ kind: "read", value: expandHome(r, home), reason: `${prog} reads its config`, via: "shell", inferred: true });
    const runScript = (sub === "run" || sub === "run-script") ? positional[1] ?? "" : sub;
    if (k.bindSubcommands && (k.bindSubcommands.includes(sub) || DEV_SCRIPT.test(runScript))) {
      needs.push({ kind: "bind", value: "localhost", reason: `${prog} ${sub} starts a local server`, via: "shell", inferred: true });
    }
    return;
  }
  if (!KNOWN_LOCAL.has(prog) && !/^[./$~]/.test(prog) && !prog.includes("=") && /^[\w.+-]+$/.test(prog)) unknown.push(prog);
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

function bareHost(s: string): string | undefined {
  if (s.startsWith("-") || s.includes("=") && !s.includes("/")) return undefined;
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
  const seen = new Set<string>();
  return needs.filter((n) => {
    const k = `${n.kind}|${n.value}|${n.via}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
