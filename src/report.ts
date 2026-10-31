import pc from "picocolors";
import type { ForecastResult } from "./forecast.js";
import type { Policy } from "./types.js";

export function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  const v = (100 * n) / d;
  return `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
}

function bar(n: number, d: number, width = 24): string {
  const filled = d === 0 ? 0 : Math.max(n > 0 ? 1 : 0, Math.round((width * n) / d));
  return pc.red("█".repeat(filled)) + pc.dim("░".repeat(width - filled));
}

const fmt = (n: number) => n.toLocaleString("en-US");
/** "1 session", "2 sessions" */
export const plural = (n: number, word: string, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;

function list(items: string[], max = 6): string {
  if (items.length === 0) return pc.dim("none");
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} ${pc.dim(`+${items.length - max} more`)}` : shown;
}

export interface SummaryInput {
  version: string;
  scopeLabel: string;
  harnessLabel: string;
  days?: number;
  events: number;
  sessions: number;
  baseline: ForecastResult;
  baselineConfigured: boolean;
  withPolicy: ForecastResult;
  holdout?: { result: ForecastResult; fraction: number };
  policy: Policy;
}

export function renderSummary(s: SummaryInput): string {
  const out: string[] = [];
  const b = s.baseline;
  const w = s.withPolicy;
  out.push("");
  out.push(`${pc.bold("sandfit")} ${pc.dim(s.version)}  ${pc.dim("·")}  read ${plural(s.events, "tool call")} from ${plural(s.sessions, "session")} (${s.harnessLabel})${s.days ? ` ${pc.dim("·")} last ${s.days} days` : ""}`);
  out.push(pc.dim(`  ${s.scopeLabel}`));
  out.push("");

  if (b.shellCalls === 0) {
    out.push("  No shell commands found in this history yet. Run your agent for a while, then try again.");
    return out.join("\n");
  }

  out.push(pc.bold(s.baselineConfigured ? "  If you turn on the sandbox with your current settings" : "  If you turn on the sandbox today"));
  out.push(`  ${bar(b.blockedCalls - b.secretCalls, b.shellCalls)}  ${pc.bold(pct(b.blockedCalls - b.secretCalls, b.shellCalls))} of your shell commands would break  ${pc.dim(`(${fmt(b.blockedCalls - b.secretCalls)} of ${fmt(b.shellCalls)})`)}`);
  out.push("");
  out.push(pc.bold("  With the sandfit policy"));
  const broken = w.blockedCalls - w.secretCalls;
  if (s.holdout && s.holdout.result.shellCalls > 0) {
    // Lead with the honest number: a policy tested on history it was not built from.
    const h = s.holdout.result;
    const hb = h.blockedCalls - h.secretCalls;
    out.push(`  ${bar(hb, h.shellCalls)}  ${pc.bold(pc.green(pct(hb, h.shellCalls)))} would break  ${pc.dim(`(${fmt(hb)} of ${fmt(h.shellCalls)} commands from your newest ${Math.round(s.holdout.fraction * 100)}% of history, which the policy never saw)`)}`);
    out.push(`  ${pc.dim(`On the history it was built from: ${pct(broken, w.shellCalls)}`)}`);
  } else {
    out.push(`  ${bar(broken, w.shellCalls)}  ${pc.bold(pc.green(pct(broken, w.shellCalls)))} would break  ${pc.dim(`(${fmt(broken)} of ${fmt(w.shellCalls)})`)}`);
  }
  if (w.secretCalls > 0) out.push(`  ${pc.yellow(fmt(w.secretCalls))} commands that read secrets are blocked ${pc.dim("on purpose")}`);
  if (w.promptedBefore > 0) out.push(`  Manual approvals you would no longer need: ${pc.bold(fmt(w.promptsAvoided))} of ${fmt(w.promptedBefore)}`);
  if (w.excludedCalls > 0) out.push(`  ${fmt(w.excludedCalls)} commands run outside the sandbox ${pc.dim("(tools that cannot work inside it)")}`);
  out.push("");

  const p = s.policy;
  out.push(pc.bold("  What the policy allows"));
  out.push(`  ${pc.cyan("Network ")}  ${list(p.network.allowDomains)}`);
  out.push(`  ${pc.cyan("Writes  ")}  your project, temp, ${list(p.filesystem.allowWrite, 4)}`);
  if (p.network.allowLocalBinding) out.push(`  ${pc.cyan("Servers ")}  local dev servers may listen on ports`);
  if (p.excludedCommands.length) out.push(`  ${pc.cyan("Outside ")}  ${p.excludedCommands.map((e) => e.pattern.replace(" *", "")).join(", ")} ${pc.dim("run unsandboxed")}`);
  out.push(`  ${pc.cyan("Denied  ")}  ${pc.dim("secrets (~/.ssh, ~/.aws, .env …) and the agent's own config")}`);
  for (const w of p.warnings) out.push(`  ${pc.yellow("!")} ${w}`);
  out.push("");

  const remaining = w.blockers.filter((x) => x.kind !== "secret").slice(0, 5);
  if (remaining.length) {
    out.push(pc.bold("  Still blocked"));
    for (const r of remaining) out.push(`  ${pc.red("✗")} ${r.key.replace(/^(\w+):/, "$1 ")} ${pc.dim(`×${r.count}`)}  ${pc.dim("e.g.")} ${truncate(r.examples[0] ?? "", 60)}`);
    out.push(pc.dim("    These came from one-off actions below --min-count, or from tools sandfit cannot see into."));
    out.push("");
  }

  const unknown = w.unknownPrograms.slice(0, 6);
  if (unknown.length) {
    out.push(`  ${pc.dim("Tools sandfit has no knowledge of (side effects unverified):")} ${unknown.map((u) => `${u.name} ${pc.dim(`×${u.count}`)}`).join(", ")}`);
    out.push("");
  }

  out.push(pc.bold("  Next"));
  out.push(`  ${pc.green("sandfit apply")}                    write it to .claude/settings.json ${pc.dim("(keeps a backup)")}`);
  out.push(`  ${pc.green("sandfit explain")}                  why each grant is there, with an example`);
  out.push(`  ${pc.green("sandfit emit --target policy")}     the full policy file to review`);
  out.push(`  ${pc.green("sandfit emit --target srt|codex|nono")}  for other sandboxes`);
  out.push("");
  return out.join("\n");
}

export function renderBlockers(r: ForecastResult, title: string): string {
  const out: string[] = [pc.bold(title)];
  const broken = r.blockedCalls - r.secretCalls;
  out.push(`  ${pct(broken, r.shellCalls)} of shell commands would break (${fmt(broken)} of ${fmt(r.shellCalls)}); ${fmt(r.secretCalls)} blocked for touching secrets`);
  for (const b of r.blockers.slice(0, 25)) {
    out.push(`  ${b.kind === "secret" ? pc.yellow("●") : pc.red("✗")} ${b.key}  ${pc.dim(`×${b.count}`)}`);
    out.push(`      ${pc.dim("fix:")} ${b.fix}`);
    for (const e of b.examples.slice(0, 2)) out.push(`      ${pc.dim("e.g.")} ${truncate(e, 100)}`);
  }
  return out.join("\n");
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

const EXPLAIN_KINDS: Record<string, string> = {
  net: "Network: hosts your agent's commands reached",
  write: "Writes: folders outside the project your agent wrote to",
  bind: "Local servers",
  exclude: "Run outside the sandbox",
  mcp: "MCP tools",
};

/** Why each grant is in the policy, with how often it was needed and one (redacted) example. */
export function renderExplain(policy: Policy, filter?: string): string {
  const inPolicy = (kind: string, value: string): boolean => {
    const domains = [...policy.network.allowDomains, ...policy.harnessTools.allowFetch];
    const writes = [...policy.filesystem.allowWrite, ...policy.harnessTools.allowWrite];
    if (kind === "net") return domains.some((d) => d === value || (d.startsWith("*.") && value.endsWith(d.slice(1))));
    if (kind === "write") return writes.some((w) => value === w || value.startsWith(w + "/"));
    if (kind === "bind") return policy.network.allowLocalBinding;
    if (kind === "exclude") return policy.excludedCommands.some((e) => e.pattern === `${value} *`);
    if (kind === "mcp") return policy.mcp.allowTools.includes(value);
    return false;
  };
  const groups = new Map<string, { value: string; count: number; example: string; kept: boolean }[]>();
  for (const [key, ev] of Object.entries(policy.evidence)) {
    const i = key.indexOf(":");
    const kind = key.slice(0, i);
    const value = key.slice(i + 1);
    if (filter && !key.toLowerCase().includes(filter.toLowerCase())) continue;
    const list = groups.get(kind) ?? [];
    list.push({ value, count: ev.count, example: ev.example, kept: inPolicy(kind, value) });
    groups.set(kind, list);
  }
  const out: string[] = [""];
  if (groups.size === 0) {
    out.push(filter ? `  No grant matches "${filter}". Run sandfit explain with no filter to see them all.` : "  The policy has no grants: no agent history was found.");
    return out.join("\n");
  }
  for (const kind of Object.keys(EXPLAIN_KINDS)) {
    const list = groups.get(kind);
    if (!list) continue;
    out.push(pc.bold(`  ${EXPLAIN_KINDS[kind]}`));
    for (const g of list.sort((a, b) => b.count - a.count)) {
      const reason = kind === "exclude" ? policy.excludedCommands.find((e) => e.pattern === `${g.value} *`)?.reason : undefined;
      out.push(`  ${g.kept ? pc.green("✓") : pc.dim("–")} ${g.value}  ${pc.dim(`needed ${plural(g.count, "time")}${g.kept ? "" : ", left out (below --min-count)"}`)}`);
      if (reason) out.push(`      ${pc.dim("why:")} ${reason}`);
      out.push(`      ${pc.dim("e.g.")} ${truncate(g.example, 100)}`);
    }
    out.push("");
  }
  if (!filter) {
    out.push(pc.bold("  Always denied"));
    out.push(`  ${pc.dim("reading:")} ${policy.filesystem.denyRead.join(", ")}`);
    out.push(`  ${pc.dim("writing:")} ${policy.filesystem.denyWrite.join(", ")}`);
    for (const w of policy.warnings) out.push(`  ${pc.yellow("!")} ${w}`);
    out.push("");
  }
  return out.join("\n");
}
