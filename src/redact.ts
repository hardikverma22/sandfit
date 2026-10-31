/**
 * Mask anything that looks like a credential before it is printed or written to a file.
 * Agent history is full of pasted keys; sandfit must never echo them back.
 */
export function redact(s: string): string {
  return (
    s
      .replace(/(authorization:\s*(bearer|basic|token)\s+)\S+/gi, "$1***")
      // KEY=value / "token": "value" / --api-key value, for any variable whose name suggests a secret
      .replace(/(\b(?!authorization\b)[\w-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie|session)[\w-]*["']?\s*[=:]\s*["']?)(?!\*\*\*)[^\s"'&;|)]+/gi, "$1***")
      .replace(/(--?(?:api-?key|token|password|secret)[= ]\s*["']?)[^\s"'&;|)]+/gi, "$1***")
      // short variable names holding a long opaque value: K='AQ.Ab8...'
      .replace(/(\b[A-Za-z_][A-Za-z0-9_]{0,3}=["']?)([A-Za-z0-9._~+/=-]{20,})/g, (m, pre, val) => (looksOpaque(val) ? `${pre}***` : m))
      // well-known token prefixes
      .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|AKIA|ASIA|AIza|ya29|glpat|npm)[-_.A-Za-z0-9]{10,}/g, "***")
      // JWTs
      .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, "***")
      // any remaining long opaque blob
      .replace(/[A-Za-z0-9._~+/=-]{32,}/g, (m) => (looksOpaque(m) && !m.includes("/") ? "***" : m))
  );
}

/** Mixed letters and digits, no spaces, not a path or a domain: likely a key. */
function looksOpaque(v: string): boolean {
  if (/^[./~]/.test(v) || /\.(com|org|io|dev|net|json|ts|js|py|md|html|png)$/i.test(v)) return false;
  return /[A-Za-z]/.test(v) && /\d/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v);
}
