/**
 * What `apply` would change in a config file, entry by entry.
 * Lists count as sets (order does not matter); objects are compared key by key.
 */

export interface ConfigChange {
  /** Dotted key path, e.g. "sandbox.network.allowedDomains". */
  path: string;
  /** add: a list entry is added. set: a value is set or changed. remove: a list entry or key goes away. */
  kind: "add" | "set" | "remove";
  value: string;
  /** For "set": the value before ("unset" if there was none). */
  from?: string;
}

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function diffConfig(before: unknown, after: unknown, path = ""): ConfigChange[] {
  const out: ConfigChange[] = [];
  const at = (k: string) => (path ? `${path}.${k}` : k);
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(k in after)) out.push(...leaves(before[k], at(k)).map((c) => ({ ...c, kind: "remove" as const })));
      else if (!(k in before)) out.push(...leaves(after[k], at(k), true));
      else out.push(...diffConfig(before[k], after[k], at(k)));
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const b = new Set(before.map(show));
    const a = new Set(after.map(show));
    for (const v of a) if (!b.has(v)) out.push({ path, kind: "add", value: v });
    for (const v of b) if (!a.has(v)) out.push({ path, kind: "remove", value: v });
    return out;
  }
  if (show(before) !== show(after)) out.push({ path, kind: "set", value: show(after), from: before === undefined ? "unset" : show(before) });
  return out;
}

/** Every leaf under a value, as additions (or plain entries to be relabelled by the caller). */
function leaves(v: unknown, path: string, isNew = false): ConfigChange[] {
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => leaves(x, `${path}.${k}`, isNew));
  if (Array.isArray(v)) return v.map((x) => ({ path, kind: "add" as const, value: show(x) }));
  return [{ path, kind: "set", value: show(v), ...(isNew ? { from: "unset" } : {}) }];
}

/**
 * List entries in the current config that the generated config does not contain: things the
 * user (or an earlier run) allowed that this history never needed. apply keeps them; this only
 * reports them, so they can be reviewed by hand.
 */
export function unusedEntries(existing: unknown, generated: unknown): ConfigChange[] {
  return diffConfig(generated, existing).filter((c) => c.kind === "add" && Array.isArray(get(generated, c.path)));
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
