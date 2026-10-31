/**
 * Review mode: grants that history needed only a few times (one odd curl, one copy to a
 * strange folder) are the ones most likely to be accidents. List them so a person can keep
 * or drop each one before anything is written.
 */
import type { Policy } from "./types.js";

export type ReviewKind = "domain" | "write" | "outside" | "mcp" | "tool-fetch" | "tool-write";

export interface ReviewItem {
  kind: ReviewKind;
  value: string;
  count: number;
  example: string;
}

export type ReviewAnswer = "keep" | "drop" | "keep-rest" | "drop-rest";

const LABEL: Record<ReviewKind, string> = {
  domain: "network",
  write: "write",
  outside: "run outside the sandbox",
  mcp: "MCP tool",
  "tool-fetch": "web fetch",
  "tool-write": "edit",
};

export const reviewLabel = (k: ReviewKind) => LABEL[k];

/** Evidence for a granted value; a wildcard domain adds up every host it covers. */
function evidenceFor(policy: Policy, prefix: string, value: string): { count: number; example: string } | undefined {
  if (prefix === "net" && value.startsWith("*.")) {
    const suffix = value.slice(1);
    const hits = Object.entries(policy.evidence).filter(([k]) => k.startsWith("net:") && k.endsWith(suffix));
    if (!hits.length) return undefined;
    return { count: hits.reduce((n, [, e]) => n + e.count, 0), example: hits[0]![1].example };
  }
  return policy.evidence[`${prefix}:${value}`];
}

/** Grants backed by at most `maxCount` uses in history, rarest first. */
export function reviewCandidates(policy: Policy, maxCount = 1): ReviewItem[] {
  const items: ReviewItem[] = [];
  const add = (kind: ReviewKind, prefix: string, values: string[], strip = (v: string) => v) => {
    for (const v of values) {
      const e = evidenceFor(policy, prefix, strip(v));
      if (e && e.count <= maxCount) items.push({ kind, value: v, count: e.count, example: e.example });
    }
  };
  add("domain", "net", policy.network.allowDomains);
  add("write", "write", policy.filesystem.allowWrite);
  add("outside", "exclude", policy.excludedCommands.map((e) => e.pattern), (p) => p.replace(/ \*$/, ""));
  add("mcp", "mcp", policy.mcp.allowTools);
  add("tool-fetch", "net", policy.harnessTools.allowFetch);
  add("tool-write", "write", policy.harnessTools.allowWrite);
  return items.sort((a, b) => a.count - b.count);
}

/** A copy of the policy without the dropped grants. */
export function dropFromPolicy(policy: Policy, dropped: ReviewItem[]): Policy {
  const has = (kind: ReviewKind) => new Set(dropped.filter((d) => d.kind === kind).map((d) => d.value));
  const domain = has("domain");
  const write = has("write");
  const outside = has("outside");
  const mcp = has("mcp");
  const toolFetch = has("tool-fetch");
  const toolWrite = has("tool-write");
  return {
    ...policy,
    filesystem: { ...policy.filesystem, allowWrite: policy.filesystem.allowWrite.filter((w) => !write.has(w)) },
    network: { ...policy.network, allowDomains: policy.network.allowDomains.filter((d) => !domain.has(d)) },
    excludedCommands: policy.excludedCommands.filter((e) => !outside.has(e.pattern)),
    mcp: { allowTools: policy.mcp.allowTools.filter((t) => !mcp.has(t)) },
    harnessTools: {
      allowFetch: policy.harnessTools.allowFetch.filter((d) => !toolFetch.has(d)),
      allowWrite: policy.harnessTools.allowWrite.filter((w) => !toolWrite.has(w)),
    },
  };
}

/** Ask about each candidate; returns the reviewed policy and what was dropped. */
export async function reviewPolicy(
  policy: Policy,
  ask: (item: ReviewItem, index: number, total: number) => Promise<ReviewAnswer>,
  maxCount = 1,
): Promise<{ policy: Policy; dropped: ReviewItem[]; reviewed: number }> {
  const items = reviewCandidates(policy, maxCount);
  const dropped: ReviewItem[] = [];
  let rest: "keep" | "drop" | undefined;
  for (const [i, item] of items.entries()) {
    const answer = rest ?? (await ask(item, i, items.length));
    if (answer === "keep-rest") rest = "keep";
    if (answer === "drop-rest") rest = "drop";
    if (answer === "drop" || answer === "drop-rest" || rest === "drop") dropped.push(item);
  }
  return { policy: dropFromPolicy(policy, dropped), dropped, reviewed: items.length };
}

/** Turn a typed reply into an answer; anything unclear keeps the grant (the safe default for not breaking work). */
export function parseAnswer(line: string): ReviewAnswer {
  const s = line.trim().toLowerCase();
  if (s === "d" || s === "drop" || s === "n" || s === "no") return "drop";
  if (s === "a" || s === "keep all") return "keep-rest";
  if (s === "x" || s === "drop all") return "drop-rest";
  return "keep";
}
