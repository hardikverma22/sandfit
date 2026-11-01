import { homedir } from "node:os";
import { expandHome } from "./extract/extract.js";
import { parseShell } from "./extract/shell.js";
import { generalizeWrite, isAgentState, isInside, tempRoots, tildify, tooBroad } from "./policy/paths.js";
import { redact } from "./redact.js";
import type { AnalyzedEvent, Policy } from "./types.js";

/**
 * A sandbox reduced to the questions a forecast asks. "claude" scope models Claude Code's
 * sandbox, which only wraps Bash subprocesses. "process" scope models sandboxes that wrap the
 * whole agent (nono, srt around the agent), where the agent's own file and fetch tools count too.
 */
export interface SandboxModel {
  scope: "claude" | "process";
  /** Project roots (always writable; used to word fixes). */
  projects: string[];
  writeRoots: string[];
  denyRead: string[];
  denyWrite: string[];
  domains: string[];
  localBinding: boolean;
  sockets: string[];
  excluded: string[];
}

/**
 * Paths inside the working folder that sandbox-runtime (and so Claude Code's sandbox) never
 * lets a sandboxed command write, whatever the configuration says. From sandbox-runtime's
 * DANGEROUS_FILES / getDangerousDirectories / linuxGetCwdMandatoryDenyPaths.
 */
export const RUNTIME_PROTECTED = [
  ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json",
  ".vscode", ".idea", ".claude/commands", ".claude/agents", ".git/hooks", ".git/config",
];

export function runtimeProtected(projects: string[]): string[] {
  return projects.flatMap((p) => RUNTIME_PROTECTED.map((r) => `${p}/${r}`));
}

export function modelFromPolicy(policy: Policy, scope: SandboxModel["scope"], home = homedir(), projects?: string[]): SandboxModel {
  const abs = (p: string) => expandHome(p, home);
  const projs = (projects ?? policy.projects.map(abs));
  const relToProjects = (p: string) => (p.startsWith("./") ? projs.map((proj) => `${proj}/${p.slice(2)}`) : [abs(p)]);
  const writeRoots = [...projs, ...tempRoots(), ...policy.filesystem.allowWrite.map(abs)];
  const domains = [...policy.network.allowDomains];
  if (scope === "process") {
    writeRoots.push(...policy.harnessTools.allowWrite.map(abs), abs("~/.claude"), abs("~/.claude.json"), abs("~/.codex"));
    domains.push(...policy.harnessTools.allowFetch);
  }
  return {
    scope,
    projects: projs,
    writeRoots,
    denyRead: policy.filesystem.denyRead.filter((p) => !p.includes("*")).flatMap(relToProjects),
    denyWrite: [...policy.filesystem.denyWrite.flatMap(relToProjects), ...runtimeProtected(projs)],
    domains,
    localBinding: policy.network.allowLocalBinding,
    sockets: policy.network.allowUnixSockets,
    excluded: policy.excludedCommands.map((e) => e.pattern.replace(/ \*$/, "")),
  };
}

/**
 * The sandbox you get by switching it on with no extra configuration.
 * On Linux (bubblewrap) every sandboxed command gets its own network namespace, so binding
 * a local port always succeeds there (though nothing outside that command can reach it).
 * On macOS (Seatbelt) binding needs allowLocalBinding. Verified against sandbox-runtime.
 */
export function defaultModel(projects: string[], scope: SandboxModel["scope"] = "claude", platform: NodeJS.Platform = process.platform): SandboxModel {
  return { scope, projects: [...projects], writeRoots: [...projects, ...tempRoots()], denyRead: [], denyWrite: runtimeProtected(projects), domains: [], localBinding: platform === "linux", sockets: [], excluded: [] };
}

/**
 * Why Claude Code would keep a call that matches excludedCommands inside the sandbox, or undefined
 * if it runs outside. From code.claude.com/docs/en/sandboxing: every command in the call has to
 * match an entry, matching is on the text of the call, and a cd, a redirect to a file, or a command
 * substitution keeps the whole call sandboxed.
 */
export function staysSandboxed(command: string, excluded: string[], cwd: string, home: string): string | undefined {
  if (/\$\(|`|[<>]\(/.test(command)) return "it uses a command substitution such as $(...)";
  const cmds = parseShell(command, { cwd, home }).filter((c) => c.argv.length);
  if (cmds.some((c) => c.argv[0] === "cd" || c.argv[0] === "pushd")) return "it includes a cd";
  if (cmds.some((c) => c.redirects.some((r) => r.op.includes(">") && !r.target.startsWith("&")))) return "it redirects output to a file";
  for (const c of cmds) {
    const text = c.argv.join(" ");
    if (!excluded.some((e) => text === e || text.startsWith(`${e} `))) return `it also runs \`${c.argv.slice(0, 3).join(" ")}\`, which is not excluded as written`;
  }
  return undefined;
}

export function domainAllowed(host: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === host) return true;
    if (p.startsWith("*.")) return host.endsWith(p.slice(1));
    return false;
  });
}

export interface Blocker {
  key: string;
  kind: "write" | "net" | "bind" | "socket" | "secret" | "exec";
  fix: string;
  count: number;
  examples: string[];
}

export interface ForecastResult {
  shellCalls: number;
  blockedCalls: number;
  /** Calls the policy blocks on purpose because they touched secrets. */
  secretCalls: number;
  excludedCalls: number;
  bypassedInHistory: number;
  promptedBefore: number;
  promptsAvoided: number;
  blockers: Blocker[];
  unknownPrograms: { name: string; count: number }[];
}

export function forecast(analyzed: AnalyzedEvent[], model: SandboxModel, home = homedir()): ForecastResult {
  const blockers = new Map<string, Blocker>();
  const unknown = new Map<string, number>();
  let shellCalls = 0;
  let blockedCalls = 0;
  let secretCalls = 0;
  let excludedCalls = 0;
  let bypassed = 0;
  let promptedBefore = 0;
  let promptsAvoided = 0;
  const projects = model.projects;

  const hit = (key: string, kind: Blocker["kind"], fix: string, example: string) => {
    const b = blockers.get(key) ?? { key, kind, fix, count: 0, examples: [] };
    b.count++;
    const clean = redact(example.replace(/\s+/g, " ").trim()).slice(0, 160);
    if (!b.examples.includes(clean)) {
      b.examples.push(clean);
      b.examples.sort((x, y) => x.length - y.length);
      b.examples.length = Math.min(b.examples.length, 3);
    }
    blockers.set(key, b);
  };

  for (const a of analyzed) {
    const isShell = a.event.tool === "bash";
    const relevant = a.needs.filter((n) => n.via === "shell" || model.scope === "process");
    if (!isShell && relevant.length === 0) continue;
    if (isShell) shellCalls++;
    if (a.event.sandboxBypass) bypassed++;
    if (isShell && a.event.decision === "prompted") promptedBefore++;
    for (const u of a.unknownPrograms) unknown.set(u, (unknown.get(u) ?? 0) + 1);

    let chained: string | undefined;
    if (relevant.some((n) => n.kind === "exec" && model.excluded.includes(n.value))) {
      chained = model.scope === "claude" && a.event.command ? staysSandboxed(a.event.command, model.excluded, a.event.cwd, home) : undefined;
      if (!chained) {
        excludedCalls++;
        continue;
      }
    }

    let blocked = false;
    let secret = false;
    const example = a.event.command ?? a.event.url ?? a.event.paths?.join(" ") ?? a.event.toolName;
    for (const n of relevant) {
      if (n.kind === "write") {
        const denied = model.denyWrite.some((d) => isInside(n.value, d));
        const allowed = model.writeRoots.some((r) => isInside(n.value, r));
        // Writing a secrets file (e.g. creating .env.local from .env.example) is fine;
        // the sandbox protects secrets from being read, not from being created.
        if (denied || !allowed) {
          blocked = true;
          if (denied) hit(`write-protected:${tildify(n.value, home)}`, "secret", "protected on purpose (agent config, git hooks/config or shell startup file); run it yourself outside the agent", example);
          else if (isAgentState(n.value, home)) {
            hit(`write-protected:${tildify(n.value, home)}`, "secret", "protected on purpose (the agent's own settings, memory and history); let the agent's file tools write there, or run it yourself", example);
          } else if (tooBroad(n.value, home)) {
            hit(`write:${tildify(n.value, home)}`, "write", "sandfit never grants this whole folder; have the agent write somewhere narrower", example);
          } else {
            const g = generalizeWrite(n.value, home, projects) ?? n.value;
            hit(`write:${tildify(g, home)}`, "write", `allowWrite: ${tildify(g, home)}`, example);
          }
        }
      } else if (n.kind === "read") {
        if (isDeniedSecret(n.value, model)) {
          blocked = true;
          secret = true;
          hit(`secret:${tildify(n.value, home)}`, "secret", "blocked on purpose (secret)", example);
        }
      } else if (n.kind === "net") {
        if (!domainAllowed(n.value, model.domains)) {
          blocked = true;
          hit(`net:${n.value}`, "net", `allowedDomains: ${n.value}`, example);
        }
      } else if (n.kind === "bind") {
        if (!model.localBinding) {
          blocked = true;
          hit("bind:localhost", "bind", "allowLocalBinding: true", example);
        }
      } else if (n.kind === "exec") {
        blocked = true;
        if (chained && model.excluded.includes(n.value)) {
          // Excluded, but the way it was called keeps it inside the sandbox.
          hit(`exec-chained:${n.value}`, "exec", `runs inside the sandbox anyway, because ${chained}. Claude Code runs an excluded command outside the sandbox only when the call is that command on its own; ask the agent to run \`${n.value}\` by itself`, example);
        } else hit(`exec:${n.value}`, "exec", `excludedCommands: ${n.value} * (${n.reason})`, example);
      } else if (n.kind === "socket") {
        if (!model.sockets.includes(n.value)) {
          blocked = true;
          hit(`socket:${n.value}`, "socket", `allowUnixSockets: ${n.value}`, example);
        }
      }
    }
    if (blocked) {
      blockedCalls++;
      if (secret) secretCalls++;
    } else if (isShell && a.event.decision === "prompted") {
      promptsAvoided++;
    }
  }

  return {
    shellCalls,
    blockedCalls,
    secretCalls,
    excludedCalls,
    bypassedInHistory: bypassed,
    promptedBefore,
    promptsAvoided,
    blockers: [...blockers.values()].sort((x, y) => y.count - x.count),
    unknownPrograms: [...unknown].map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count),
  };
}

/** A path the model protects from reading: inside an explicit denyRead entry. */
function isDeniedSecret(p: string, model: SandboxModel): boolean {
  return model.denyRead.some((d) => isInside(p, d));
}

/** Split events by time: the first part trains a policy, the rest tests it. */
export function holdoutSplit<T extends { event: { timestamp: string } }>(items: T[], testFraction: number): [T[], T[]] {
  const sorted = [...items].sort((a, b) => (a.event.timestamp < b.event.timestamp ? -1 : 1));
  const cut = Math.floor(sorted.length * (1 - testFraction));
  return [sorted.slice(0, cut), sorted.slice(cut)];
}
