import pc from "picocolors";
import { diffConfig, unusedEntries, type ConfigChange } from "./diff.js";
import { plural, renderChanges } from "./report.js";

/** Lists of rules that protect secrets and the agent's own config, rather than grant access. */
const PROTECTION = /(^|\.)(denyRead|denyWrite|deny)$/;
const HOSTS = /(allowedDomains|domains|allow_domain)$/;

export interface Drift {
  file: string;
  exists: boolean;
  /** Grants recent history needed that the config does not have: these commands will be blocked. */
  missing: ConfigChange[];
  /** Protection rules sandfit would add that the config does not have. */
  protections: ConfigChange[];
  /** Grants in the config that recent history never needed. */
  unused: ConfigChange[];
}

export function computeDrift(plan: { file: string; before: Record<string, unknown>; after: Record<string, unknown>; generated: Record<string, unknown> }, exists: boolean): Drift {
  const changes = exists ? diffConfig(plan.before, plan.after).filter((c) => c.kind !== "remove") : [];
  return {
    file: plan.file,
    exists,
    missing: changes.filter((c) => !PROTECTION.test(c.path)),
    protections: changes.filter((c) => PROTECTION.test(c.path)),
    unused: exists ? unusedEntries(plan.before, plan.generated).filter((c) => !PROTECTION.test(c.path)) : [],
  };
}

/** "3 hosts, 1 folder" style summary of missing grants. */
function summarize(cs: ConfigChange[]): string {
  const hosts = cs.filter((c) => HOSTS.test(c.path)).length;
  const other = cs.length - hosts;
  return [hosts ? plural(hosts, "host") : "", other ? plural(other, "other rule") : ""].filter(Boolean).join(", ");
}

/** One line for hooks and scripts, or "" when the config is in step with recent history. */
export function driftLine(d: Drift, days: number | undefined, target: string, user = false): string {
  const window = days ? `in the last ${plural(days, "day")}` : "in your history";
  const t = (target === "claude" ? "" : ` -t ${target}`) + (user ? " --user" : "");
  if (!d.exists) return `sandfit: no sandbox config at ${d.file} yet. Run: npx sandfit apply${t}`;
  if (!d.missing.length) return "";
  return `sandfit: your sandbox config is missing ${summarize(d.missing)} your agent used ${window}, so those commands will be blocked. See: npx sandfit drift${t}`;
}

export function renderDrift(d: Drift, days: number | undefined, target: string, user = false): string {
  const t = (target === "claude" ? "" : ` -t ${target}`) + (user ? " --user" : "");
  const window = days ? `the last ${plural(days, "day")}` : "your history";
  const out = ["", `${pc.bold("sandfit drift")} → ${d.file}`];
  if (!d.exists) {
    out.push(pc.yellow("  no config here yet: the sandbox is not set up for this target."), `  ${pc.green(`sandfit apply${t}`)}   set it up from your history`, "");
    return out.join("\n");
  }
  if (!d.missing.length) out.push(pc.green(`  in step: your config allows everything your agent needed in ${window}.`));
  else {
    out.push(pc.yellow(`  ${plural(d.missing.length, "rule")} missing: your agent needed ${d.missing.length === 1 ? "this" : "these"} in ${window}, and the sandbox will block ${d.missing.length === 1 ? "it" : "them"}.`));
    out.push(renderChanges(d.missing));
  }
  if (d.protections.length) out.push("", pc.dim(`  sandfit would also add ${plural(d.protections.length, "protection rule")} for secrets and the agent's own config.`));
  if (d.unused.length) {
    out.push("", pc.dim(`  Not needed in ${window} (fine to keep; remove by hand if you no longer use ${d.unused.length === 1 ? "it" : "them"}):`));
    out.push(renderChanges(d.unused, { marker: pc.dim("·") }));
  }
  if (d.missing.length || d.protections.length) out.push("", `  ${pc.green(`sandfit apply${t}`)}   bring the config up to date ${pc.dim("(shows the changes, asks first)")}`);
  out.push("");
  return out.join("\n");
}
