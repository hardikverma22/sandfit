export type Harness = "claude" | "codex";

/** How the harness decided whether a tool call could run. */
export type Decision =
  | "auto" // allowed by config, rule, mode or classifier: no human involved
  | "prompted" // a human had to approve it
  | "rejected" // a human or a rule refused it
  | "unknown";

export type ToolKind = "bash" | "read" | "write" | "fetch" | "mcp" | "other";

/** One normalized tool call from any harness. */
export interface AgentEvent {
  id: string;
  harness: Harness;
  sessionId: string;
  cwd: string;
  timestamp: string;
  tool: ToolKind;
  /** Original tool name, e.g. "Bash", "Edit", "mcp__github__create_issue". */
  toolName: string;
  command?: string;
  paths?: string[];
  url?: string;
  decision: Decision;
  /** The call asked to run outside the sandbox (Claude Code dangerouslyDisableSandbox). */
  sandboxBypass?: boolean;
  /** The tool result was an error. */
  failed?: boolean;
}

export type NeedKind = "read" | "write" | "net" | "bind" | "socket" | "mcp" | "exec";

/** A single capability that an event needed in order to succeed. */
export interface Need {
  kind: NeedKind;
  /** Absolute path, hostname, socket path, MCP tool name, or program name. */
  value: string;
  /** Why we believe this need exists, for explanations. */
  reason: string;
  /** Inferred from the knowledge base rather than seen literally in the call. */
  inferred?: boolean;
  /**
   * "shell": a subprocess needed it (always inside an OS sandbox).
   * "tool": the harness's own file/fetch tool needed it. Claude Code runs these outside
   * the OS sandbox, but whole-process sandboxes (nono, srt wrapping the agent) still see them.
   */
  via: "shell" | "tool";
}

export interface AnalyzedEvent {
  event: AgentEvent;
  needs: Need[];
  /** Programs we saw but have no knowledge about (their side effects are unknown). */
  unknownPrograms: string[];
}

export interface Policy {
  version: 1;
  generatedBy: string;
  generatedAt: string;
  source: {
    harnesses: Harness[];
    sessions: number;
    events: number;
    from?: string;
    to?: string;
  };
  /** Project roots this policy was built for. The sandbox always allows writes inside these. */
  projects: string[];
  filesystem: {
    /** Extra writable paths outside the project. */
    allowWrite: string[];
    /** Paths that must never be readable (secrets). */
    denyRead: string[];
    /** Paths that must never be writable, even inside allowed areas. */
    denyWrite: string[];
  };
  network: {
    allowDomains: string[];
    denyDomains: string[];
    /** Dev servers need to bind local ports. */
    allowLocalBinding: boolean;
    allowUnixSockets: string[];
  };
  /** Commands that cannot work inside the sandbox and should run outside it, with a reason. */
  excludedCommands: { pattern: string; reason: string }[];
  mcp: { allowTools: string[] };
  /**
   * Needs of the harness's own tools (Claude Code's Edit/Write/WebFetch run outside the OS
   * sandbox and are governed by permission rules instead). Whole-process sandboxes merge these in.
   */
  harnessTools: { allowWrite: string[]; allowFetch: string[] };
  /** Trade-offs a human should know about (e.g. a secret left readable because a tool needs it). */
  warnings: string[];
  /** Evidence for every grant, so a human can review why it is there. */
  evidence: Record<string, { count: number; example: string }>;
}
