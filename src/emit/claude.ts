import { SECRET_FILES } from "../extract/knowledge.js";
import type { Policy } from "../types.js";

/**
 * Claude Code settings. Its sandbox wraps Bash subprocesses only; the Edit/Write/WebFetch
 * tools run outside it and follow permission rules, so harness-tool needs become
 * permission allow rules instead of sandbox grants.
 * Docs: https://code.claude.com/docs/en/sandboxing
 */
export interface ClaudeEmitOptions {
  /**
   * Also add permission allow rules for what the harness tools used (WebFetch domains,
   * Edit paths, MCP tools). Off by default: sandfit tightens permissions but never
   * loosens them unless asked.
   */
  withPermissions?: boolean;
}

export function toClaudeSettings(policy: Policy, opts: ClaudeEmitOptions = {}): Record<string, unknown> {
  const projectSecretsPlain = policy.filesystem.denyRead.filter((p) => p.startsWith("./") && !p.includes("*"));
  const secretsAbs = policy.filesystem.denyRead.filter((p) => !p.startsWith("./"));
  const globs = policy.filesystem.denyRead.filter((p) => p.startsWith("./") && p.includes("*"));

  const sandbox: Record<string, unknown> = {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
  };
  if (policy.excludedCommands.length) sandbox.excludedCommands = policy.excludedCommands.map((e) => e.pattern);
  const network: Record<string, unknown> = { allowedDomains: policy.network.allowDomains };
  if (policy.network.allowLocalBinding) network.allowLocalBinding = true;
  if (policy.network.allowUnixSockets.length) network.allowUnixSockets = policy.network.allowUnixSockets;
  sandbox.network = network;
  sandbox.filesystem = {
    allowWrite: policy.filesystem.allowWrite,
    denyRead: [...secretsAbs, ...projectSecretsPlain],
    denyWrite: policy.filesystem.denyWrite,
  };

  const allow: string[] = opts.withPermissions
    ? [
        ...policy.harnessTools.allowFetch.map((d) => `WebFetch(domain:${d})`),
        ...policy.harnessTools.allowWrite.map((p) => `Edit(${permPath(p)}/**)`),
        ...policy.mcp.allowTools,
      ]
    : [];
  const deny: string[] = [
    ...secretsAbs.map((p) => `Read(${permPath(p)}${SECRET_FILES.has(p) ? "" : "/**"})`),
    ...[...projectSecretsPlain, ...globs].map((p) => `Read(${projectPermPath(p)})`),
    ...[...projectSecretsPlain, ...globs].map((p) => `Edit(${projectPermPath(p)})`),
  ];
  return { sandbox, permissions: allow.length ? { allow, deny } : { deny } };
}

/** Permission rules write home paths as ~/x and absolute paths as //x. */
function permPath(p: string): string {
  if (p.startsWith("~/") || p === "~") return p;
  if (p.startsWith("/")) return "/" + p;
  return p;
}

function projectPermPath(p: string): string {
  // "./.env" -> "./.env" (project-relative); "./*.pem" -> "./**/*.pem"
  const rel = p.slice(2);
  return rel.includes("*") && !rel.includes("/") && rel.startsWith("*") ? `./**/${rel}` : `./${rel}`;
}

/** Merge generated settings into existing settings without dropping anything the user had. */
export function mergeSettings(existing: Record<string, unknown>, generated: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(generated)) {
    const cur = out[k];
    if (Array.isArray(v) && Array.isArray(cur)) out[k] = [...new Set([...cur, ...v])];
    else if (isObj(v) && isObj(cur)) out[k] = mergeSettings(cur, v);
    else if (cur === undefined) out[k] = v;
    else out[k] = cur; // user's explicit scalar choices win
  }
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
