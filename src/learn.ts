/**
 * Learn mode: suggestions from what a sandbox actually blocked in past sessions.
 *
 * History shows commands, not what a script does inside. When a command ran sandboxed and the
 * sandbox blocked something (a script reaching an API, a tool writing a cache), the error in the
 * output names the host or path. Those are exactly the needs the command text never shows.
 *
 * A blocked attempt can also be an attack (a hijacked script trying to send data out), so these
 * are only ever suggestions: a person adds each one. Secrets, the agent's own config and broad
 * folders are never suggested.
 */
import { domainAllowed } from "./forecast.js";
import { generalizeWrite, isInside, isSecret, isSelfProtected, tildify, tooBroad } from "./policy/paths.js";
import { redact } from "./redact.js";
import type { AnalyzedEvent, Policy } from "./types.js";
import { expandHome } from "./extract/extract.js";

export interface Suggestion {
  kind: "domain" | "write";
  /** A host, or the folder sandfit would grant (generalized like any other write). */
  value: string;
  count: number;
  /** Commands whose output showed the block (redacted, shortest first). */
  examples: string[];
}

export function learnSuggestions(analyzed: AnalyzedEvent[], policy: Policy, home: string, projects: string[]): Suggestion[] {
  const abs = (p: string) => expandHome(p, home);
  const writeRoots = [...projects, ...policy.filesystem.allowWrite.map(abs)];
  const found = new Map<string, Suggestion>();
  const add = (kind: Suggestion["kind"], value: string, command: string) => {
    const key = `${kind}:${value}`;
    const s = found.get(key) ?? { kind, value, count: 0, examples: [] };
    s.count++;
    const ex = redact(command.replace(/\s+/g, " ").trim()).slice(0, 160);
    if (!s.examples.includes(ex)) s.examples = [...s.examples, ex].sort((a, b) => a.length - b.length).slice(0, 3);
    found.set(key, s);
  };
  for (const a of analyzed) {
    for (const b of a.event.blocked ?? []) {
      const command = a.event.command ?? a.event.toolName;
      if (b.kind === "net") {
        if (domainAllowed(b.value, policy.network.allowDomains)) continue;
        add("domain", b.value, command);
      } else {
        const p = b.value;
        if (isSecret(p, home) || isSelfProtected(p, home, projects) || tooBroad(p, home)) continue;
        if (writeRoots.some((r) => isInside(p, r))) continue;
        const g = generalizeWrite(p, home, projects);
        if (!g || tooBroad(g, home)) continue;
        add("write", tildify(g, home), command);
      }
    }
  }
  return [...found.values()].sort((x, y) => y.count - x.count || x.value.localeCompare(y.value));
}

/** A copy of the policy with the accepted suggestions granted, and evidence recorded for them. */
export function addToPolicy(policy: Policy, accepted: Suggestion[]): Policy {
  const domains = accepted.filter((s) => s.kind === "domain").map((s) => s.value);
  const writes = accepted.filter((s) => s.kind === "write").map((s) => s.value);
  const evidence = { ...policy.evidence };
  for (const s of accepted) {
    const key = `${s.kind === "domain" ? "net" : "write"}:${s.value}`;
    evidence[key] = { count: (evidence[key]?.count ?? 0) + s.count, example: `blocked by the sandbox: ${s.examples[0] ?? ""}` };
  }
  return {
    ...policy,
    network: { ...policy.network, allowDomains: [...new Set([...policy.network.allowDomains, ...domains])].sort() },
    filesystem: { ...policy.filesystem, allowWrite: [...new Set([...policy.filesystem.allowWrite, ...writes])].sort() },
    evidence,
  };
}
