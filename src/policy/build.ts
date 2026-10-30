import { homedir } from "node:os";
import { SECRET_PROJECT_GLOBS, SELF_PROTECT_PATHS } from "../extract/knowledge.js";
import type { AnalyzedEvent, Harness, Policy } from "../types.js";
import { VERSION } from "../version.js";
import { dropSubsumed, generalizeHosts, generalizeWrite, gitRoot, isSecret, isSelfProtected, secretPaths, tildify, tooBroad } from "./paths.js";

export interface BuildOptions {
  home?: string;
  /** Explicit project roots. Defaults to the git roots of every cwd seen. */
  projects?: string[];
  /** Drop grants seen fewer than this many times (default 1: keep everything you actually did). */
  minCount?: number;
  now?: Date;
}

export function projectRootsOf(analyzed: AnalyzedEvent[], home = homedir()): string[] {
  const roots = new Set<string>();
  const gitRoots = new Set<string>();
  for (const a of analyzed) {
    const g = gitRoot(a.event.cwd);
    if (g && !tooBroad(g, home)) {
      roots.add(g);
      gitRoots.add(g);
    } else if (!tooBroad(a.event.cwd, home)) roots.add(a.event.cwd);
  }
  // A subdirectory of a repository is the same project; a plain folder that happens to
  // contain repositories (like ~/Projects) is kept separately and never swallows them.
  const all = [...roots];
  const containsRepo = (p: string) => [...gitRoots].some((g) => g.startsWith(p + "/"));
  return all
    .filter((r) => !all.some((p) => p !== r && r.startsWith(p + "/") && (gitRoots.has(p) || !containsRepo(p))))
    .sort();
}

/** Redact things that look like credentials before they land in a policy file. */
export function redact(s: string): string {
  return s
    .replace(/(authorization:\s*(bearer|basic)\s+)\S+/gi, "$1***")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)["']?\s*[=:]\s*["']?)[^\s"'&]+/gi, "$1***")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "***")
    .replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, "***");
}

export function buildPolicy(analyzed: AnalyzedEvent[], opts: BuildOptions = {}): Policy {
  const home = opts.home ?? homedir();
  const projects = opts.projects ?? projectRootsOf(analyzed);
  const minCount = opts.minCount ?? 1;

  const evidence: Policy["evidence"] = {};
  const note = (key: string, example: string) => {
    const e = evidence[key];
    if (e) e.count++;
    else evidence[key] = { count: 1, example: redact(example).slice(0, 160) };
  };

  const shellWrites = new Set<string>();
  const toolWrites = new Set<string>();
  const shellHosts: string[] = [];
  const toolHosts: string[] = [];
  const sockets = new Set<string>();
  const excluded = new Map<string, string>();
  const mcp = new Set<string>();
  let bind = false;
  const neededSecrets = new Map<string, string>();

  for (const a of analyzed) {
    const example = a.event.command ?? a.event.url ?? a.event.paths?.join(" ") ?? a.event.toolName;
    for (const n of a.needs) {
      switch (n.kind) {
        case "write": {
          if (isSecret(n.value, home) || isSelfProtected(n.value, home, projects)) continue;
          const g = generalizeWrite(n.value, home, projects);
          if (!g) continue;
          const key = tildify(g, home);
          (n.via === "shell" ? shellWrites : toolWrites).add(key);
          note(`write:${key}`, example);
          break;
        }
        case "net":
          (n.via === "shell" ? shellHosts : toolHosts).push(n.value);
          note(`net:${n.value}`, example);
          break;
        case "bind":
          bind = true;
          note("bind:localhost", example);
          break;
        case "socket":
          sockets.add(n.value);
          break;
        case "exec":
          excluded.set(n.value, n.reason);
          note(`exclude:${n.value}`, example);
          break;
        case "read":
          if (n.inferred && isSecret(n.value, home)) neededSecrets.set(tildify(n.value, home), n.reason);
          break;
        case "mcp":
          mcp.add(n.value);
          note(`mcp:${n.value}`, example);
          break;
        default:
          break;
      }
    }
  }

  const keep = (prefix: string) => (v: string) => (evidence[`${prefix}:${v}`]?.count ?? minCount) >= minCount;
  const hostKeep = (h: string) => (evidence[`net:${h}`]?.count ?? 0) >= minCount;

  // Sockets of excluded programs are not granted: those programs run outside the sandbox.
  const excludedSockets = new Set(excluded.has("docker") ? ["/var/run/docker.sock"] : []);

  const times = analyzed.map((a) => a.event.timestamp).filter(Boolean).sort();
  const harnesses = [...new Set(analyzed.map((a) => a.event.harness))] as Harness[];

  return {
    version: 1,
    generatedBy: `sandfit ${VERSION}`,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    source: {
      harnesses,
      sessions: new Set(analyzed.map((a) => a.event.sessionId)).size,
      events: analyzed.length,
      from: times[0],
      to: times[times.length - 1],
    },
    projects: projects.map((p) => tildify(p, home)),
    filesystem: {
      allowWrite: dropSubsumed([...shellWrites].filter(keep("write"))),
      denyRead: [...secretPaths(home).map((p) => tildify(p, home)).filter((p) => !neededSecrets.has(p)), ...SECRET_PROJECT_GLOBS.map((g) => `./${g}`)],
      denyWrite: SELF_PROTECT_PATHS.map((p) => (p.startsWith("~") ? p : `./${p}`)),
    },
    network: {
      allowDomains: generalizeHosts(shellHosts.filter(hostKeep)),
      denyDomains: [],
      allowLocalBinding: bind,
      allowUnixSockets: [...sockets].filter((s) => !excludedSockets.has(s)).sort(),
    },
    excludedCommands: [...excluded].map(([cmd, reason]) => ({ pattern: `${cmd} *`, reason })).sort((a, b) => a.pattern.localeCompare(b.pattern)),
    mcp: { allowTools: [...mcp].sort() },
    warnings: [...neededSecrets].map(([p, why]) => `${p} stays readable because ${why.replace(/ reads its config$/, "")} reads it on every run. Keep long-lived tokens out of it, or move them to environment variables.`),
    harnessTools: {
      allowWrite: dropSubsumed([...toolWrites].filter((w) => !shellWrites.has(w)).filter(keep("write"))),
      allowFetch: generalizeHosts(toolHosts.filter(hostKeep)),
    },
    evidence,
  };
}
