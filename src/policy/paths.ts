import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { KNOWLEDGE, SECRET_PATHS, SELF_PROTECT_PATHS } from "../extract/knowledge.js";
import { expandHome } from "../extract/extract.js";

/** Directories that must never be granted wholesale. */
export function tooBroad(p: string, home: string): boolean {
  const broad = new Set([
    "/",
    "/Users",
    "/home",
    "/usr",
    "/usr/local",
    "/opt",
    "/etc",
    "/var",
    "/private",
    "/System",
    "/Library",
    "/Applications",
    home,
    `${home}/Library`,
    `${home}/Library/Application Support`,
    `${home}/Library/Caches`,
    `${home}/Documents`,
    `${home}/Desktop`,
    `${home}/Downloads`,
    `${home}/.config`,
    `${home}/.local`,
    `${home}/.local/share`,
    `${home}/.cache`,
  ]);
  return broad.has(p.replace(/\/+$/, "") || "/");
}

export function isInside(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, "");
  return child === p || child.startsWith(p + "/");
}

export function tempRoots(): string[] {
  const t = tmpdir().replace(/\/+$/, "");
  const roots = new Set(["/tmp", "/private/tmp", t]);
  if (t.startsWith("/var/")) roots.add("/private" + t);
  if (t.startsWith("/private/var/")) roots.add(t.replace(/^\/private/, ""));
  return [...roots];
}

export function isTemp(p: string): boolean {
  return tempRoots().some((r) => isInside(p, r)) || /^\/(private\/)?var\/folders\//.test(p);
}

export function secretPaths(home: string): string[] {
  return SECRET_PATHS.map((p) => expandHome(p, home));
}

export function isSecret(p: string, home: string): boolean {
  if (secretPaths(home).some((s) => isInside(p, s))) return true;
  const base = p.split("/").pop() ?? "";
  return base === ".env" || /^\.env\./.test(base) && !/\.(example|sample|template)$/.test(base) || /\.(pem|key)$/.test(base) && !base.endsWith(".pub");
}

export function isSelfProtected(p: string, home: string, projects: string[]): boolean {
  for (const raw of SELF_PROTECT_PATHS) {
    if (raw.startsWith("~")) {
      if (isInside(p, expandHome(raw, home))) return true;
    } else {
      for (const proj of projects) if (isInside(p, `${proj}/${raw}`)) return true;
    }
  }
  return false;
}

/**
 * The agents' own state: settings, memory, commands, skills, session history. A sandboxed command
 * that can write here can change what the agent reads or does next, so sandfit never grants it to
 * commands. (Sandboxes that wrap the whole agent, like srt and nono, still let the agent itself
 * write there.)
 */
export function isAgentState(p: string, home: string): boolean {
  return ["~/.claude", "~/.claude.json", "~/.codex"].some((d) => isInside(p, expandHome(d, home)));
}

/** Cache directories from the knowledge base, expanded. */
function cacheRoots(home: string): string[] {
  const out = new Set<string>();
  for (const k of Object.values(KNOWLEDGE)) for (const w of k.writes ?? []) out.add(expandHome(w, home));
  return [...out].sort((a, b) => a.length - b.length);
}

/** The nearest ancestor (or self) that contains a .git directory. */
export function gitRoot(p: string): string | undefined {
  let dir = p;
  for (let i = 0; i < 30; i++) {
    if (existsSync(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Turn a concrete path an agent wrote to into the rule we would grant:
 * a known cache root, a repository root, or the containing directory. Returns undefined
 * when the path is already covered by the defaults (project or temp), or when it is a
 * folder too broad to ever grant.
 */
export function generalizeWrite(p: string, home: string, projects: string[]): string | undefined {
  if (projects.some((proj) => isInside(p, proj))) return undefined;
  // Writing a broad folder itself (rm -rf ~/Downloads, touch ~) is never granted.
  if (tooBroad(p, home)) return undefined;
  if (isTemp(p)) return undefined;
  for (const root of cacheRoots(home)) if (isInside(p, root)) return root;

  // Grant a whole repository only if it is a separate one: never a repo that contains a
  // project (that would quietly widen the project grant to its parent).
  const repo = gitRoot(p);
  if (repo && !tooBroad(repo, home) && !projects.some((proj) => isInside(proj, repo))) return repo;

  // A path is a file if it exists as one, or if it does not exist and looks like a file name.
  let dir = p;
  try {
    const exists = existsSync(p);
    if ((exists && statSync(p).isFile()) || (!exists && /\.[A-Za-z0-9]{1,8}$/.test(p))) dir = dirname(p);
  } catch {
    dir = dirname(p);
  }
  if (tooBroad(dir, home)) return p;
  return dir;
}

/** Collapse hosts that share a parent domain three or more times into a wildcard. */
export function generalizeHosts(hosts: string[]): string[] {
  const uniq = [...new Set(hosts)].sort();
  const byParent = new Map<string, string[]>();
  for (const h of uniq) {
    const parts = h.split(".");
    if (parts.length < 3) continue;
    const parent = parts.slice(1).join(".");
    byParent.set(parent, [...(byParent.get(parent) ?? []), h]);
  }
  const out = new Set(uniq);
  for (const [parent, members] of byParent) {
    if (members.length >= 3 && parent.split(".").length >= 2) {
      for (const m of members) out.delete(m);
      out.add(`*.${parent}`);
    }
  }
  return [...out].sort();
}

/** Remove entries already covered by a broader entry in the same list. */
export function dropSubsumed(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  return sorted.filter((p, i) => !sorted.slice(0, i).some((q) => isInside(p, q))).sort();
}

export function tildify(p: string, home: string): string {
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}
