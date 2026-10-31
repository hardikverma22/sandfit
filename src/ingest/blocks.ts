/**
 * Find what a sandbox blocked, from a command's output.
 *
 * These are the error formats seen when a command runs under sandbox-runtime (which Claude Code's
 * sandbox is built on): bubblewrap on Linux reports blocked writes as "Read-only file system",
 * Seatbelt on macOS as "Operation not permitted"; blocked network shows up as a refused proxy
 * tunnel or a failed DNS lookup. Only errors that name the path or host are used.
 *
 * The same errors can have other causes (a real typo in a hostname, a root-owned folder), so what
 * this finds is only ever shown as a suggestion, never granted automatically.
 */

export interface Block {
  kind: "net" | "write";
  /** Host, or absolute path. */
  value: string;
}

/** Cheap pre-check so most outputs are skipped without running the patterns. */
const MARKER = /read-only file system|operation not permitted|EROFS|EPERM|tunnel|EAI_AGAIN|ENOTFOUND|Could not resolve host|Errno 30|Errno 1\]/i;

const WRITE_PATTERNS: RegExp[] = [
  // coreutils: touch: cannot touch '/p': Read-only file system   mkdir: cannot create directory '/p': ...
  /cannot (?:touch|create(?: regular file| directory)?|open|remove|move|write)[^'"‘]*['"‘]([^'"’]+)['"’]: (?:Read-only file system|Operation not permitted)/gi,
  // shells: bash: line 1: /p: Read-only file system    zsh: operation not permitted: /p
  /(?:^|\n)(?:\/\S*bash|bash|sh|zsh|\/bin\/sh)(?:: line \d+)?: (\/[^:\n]+): (?:Read-only file system|Operation not permitted)/gi,
  /zsh: (?:read-only file system|operation not permitted): (\/\S+)/gi,
  // BSD tools on macOS: touch: /p: Operation not permitted
  /(?:^|\n)[\w.-]+: (\/[^:\n]+): (?:Read-only file system|Operation not permitted)/gi,
  // Python: OSError: [Errno 30] Read-only file system: '/p'   PermissionError: [Errno 1] Operation not permitted: '/p'
  /\[Errno (?:30|1)\] (?:Read-only file system|Operation not permitted): '([^']+)'/g,
  // Node: EROFS: read-only file system, open '/p'    EPERM: operation not permitted, mkdir '/p'
  /(?:EROFS: read-only file system|EPERM: operation not permitted), \w+ '([^']+)'/g,
];

const NET_PATTERNS: RegExp[] = [
  // git: fatal: unable to access 'https://host/x/': CONNECT tunnel failed, response 403
  /unable to access '[a-z]+:\/\/(?:[^@/']+@)?([^/:']+)[^']*': (?:CONNECT tunnel failed|Could not resolve host)/gi,
  // curl / git without a proxy: Could not resolve host: host
  /Could not resolve host: ([\w.-]+)/g,
  // Node: getaddrinfo EAI_AGAIN host   getaddrinfo ENOTFOUND host
  /getaddrinfo (?:EAI_AGAIN|ENOTFOUND) ([\w.-]+)/g,
  // Python requests/urllib3: ... host='pypi.org' ... Tunnel connection failed: 403
  /host='([\w.-]+)'[^\n]{0,400}?(?:Tunnel connection failed|ProxyError|NameResolutionError|Failed to resolve)/g,
  /(?:Tunnel connection failed|ProxyError|NameResolutionError|Failed to resolve)[^\n]{0,400}?host='([\w.-]+)'/g,
];

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1)$/;

export function findBlocks(output: string, cwd = "/"): Block[] {
  if (!output || !MARKER.test(output)) return [];
  const text = output.length > 200_000 ? output.slice(0, 200_000) : output;
  const out = new Map<string, Block>();
  for (const re of WRITE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[1]!.trim();
      if (!raw || /[$`*]/.test(raw)) continue;
      const value = raw.startsWith("/") ? normalize(raw) : normalize(`${cwd}/${raw}`);
      if (/^\/(proc|sys|dev)(\/|$)/.test(value)) continue;
      out.set(`write:${value}`, { kind: "write", value });
    }
  }
  for (const re of NET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const host = m[1]!.toLowerCase().replace(/\.$/, "");
      if (!host.includes(".") || LOCAL_HOST.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
      out.set(`net:${host}`, { kind: "net", value: host });
    }
  }
  return [...out.values()];
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}
