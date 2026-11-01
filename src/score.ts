import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { expandHome } from "./extract/extract.js";
import { KNOWLEDGE, SECRET_PATHS } from "./extract/knowledge.js";
import { findProjectSecrets } from "./policy/build.js";
import { isAgentState, isInside, tildify, tooBroad } from "./policy/paths.js";
import { plural } from "./report.js";

/**
 * A safety score for the Claude Code sandbox settings that apply to a project, out of 100.
 *
 * It rates the settings as Claude Code would load them (user, project, local and managed files
 * merged), not sandfit's suggestions. Every point comes from a documented setting
 * (code.claude.com/docs/en/sandboxing) and every lost point names the fix.
 */

export type Scope = "user" | "project" | "local" | "managed";

export interface SettingsFile {
  path: string;
  scope: Scope;
  data: any;
}

export interface Check {
  id: "sandbox" | "escape" | "fail-closed" | "network" | "secrets" | "writes" | "outside";
  label: string;
  points: number;
  max: number;
  status: "ok" | "partial" | "fail";
  detail: string;
  fix?: string;
}

export interface Score {
  total: number;
  grade: "A" | "B" | "C" | "D" | "F";
  checks: Check[];
  files: string[];
}

/** Where Claude Code's managed (admin) settings live. Highest precedence. */
const MANAGED_FILES = ["/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"];

/** The settings files Claude Code loads for a project, lowest precedence first. Unreadable files are skipped. */
export function loadClaudeSettings(project: string, home = homedir(), opts: { projectOnly?: boolean; managedFiles?: string[] } = {}): SettingsFile[] {
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const candidates: [string, Scope][] = opts.projectOnly
    ? [[join(project, ".claude", "settings.json"), "project"]]
    : [
        [join(userDir, "settings.json"), "user"],
        [join(project, ".claude", "settings.json"), "project"],
        [join(project, ".claude", "settings.local.json"), "local"],
        ...(opts.managedFiles ?? MANAGED_FILES).map((f): [string, Scope] => [f, "managed"]),
      ];
  const out: SettingsFile[] = [];
  for (const [path, scope] of candidates) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data && typeof data === "object") out.push({ path, scope, data });
    } catch {
      // A broken file is ignored by Claude Code too; it scores as if absent.
    }
  }
  return out;
}

/** A path rule: a folder or file (and everything under it), or a glob. */
interface PathRule {
  abs?: string;
  re?: RegExp;
}

function globRule(abs: string): PathRule {
  const body = abs.replace(/\/\*\*$/, "");
  if (!/[*?[]/.test(body)) return { abs: body };
  const re = body
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => (part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return { re: new RegExp(`^${re}(?:/.*)?$`) };
}

const covers = (rule: PathRule, p: string) => (rule.abs ? isInside(p, rule.abs) : !!rule.re?.test(p));

/**
 * Sandbox filesystem paths: `/x` absolute, `~/x` home, `.` or `x` relative to where the settings
 * apply (the project for project files; ~/.claude for the user file, as the docs warn).
 */
function sandboxPath(raw: string, base: string, home: string): PathRule {
  if (raw.startsWith("/")) return globRule(raw);
  if (raw === "~" || raw.startsWith("~/")) return globRule(expandHome(raw, home));
  return globRule(join(base, raw));
}

/** Permission-rule paths: `//x` absolute, `~/x` home, `/x` and `./x` and `x` relative to the project. */
function permissionPath(raw: string, project: string, home: string): PathRule {
  if (raw.startsWith("//")) return globRule(raw.slice(1));
  if (raw === "~" || raw.startsWith("~/")) return globRule(expandHome(raw, home));
  return globRule(join(project, raw.replace(/^\//, "")));
}

/** Programs that can run anything: excluding one takes everything it runs out of the sandbox. */
const RUNS_ANYTHING = new Set(["*", "bash", "sh", "zsh", "fish", "dash", "env", "sudo", "eval", "exec", "xargs", "python", "python3", "node", "deno", "bun", "bunx", "npx", "npm", "pnpm", "yarn", "ruby", "perl", "php", "make", "just", "uv", "uvx", "pipx"]);

const SHELL_STARTUP = [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".zshenv", ".config/fish"];

export interface ScoreContext {
  project: string;
  home: string;
  /** Credential files that exist on this machine, absolute. */
  secrets: string[];
}

/** Credential files that exist here: the well-known ones in home, and secret files in the project. */
export function existingSecrets(project: string, home: string): string[] {
  const inHome = SECRET_PATHS.map((p) => expandHome(p, home)).filter((p) => existsSync(p));
  const inProject = findProjectSecrets(project).map((rel) => join(project, rel));
  return [...inHome, ...inProject];
}

export function scoreClaude(files: SettingsFile[], ctx: ScoreContext): Score {
  const { project, home } = ctx;
  // Scalars: the highest-precedence file that sets one wins. Arrays: merged across files.
  const scalar = (get: (d: any) => unknown, scopes?: Scope[]): unknown => {
    let v: unknown;
    for (const f of files) if (!scopes || scopes.includes(f.scope)) v = get(f.data) ?? v;
    return v;
  };
  const domains: string[] = [];
  const excluded: string[] = [];
  const denyRead: PathRule[] = [];
  const allowRead: PathRule[] = [];
  const allowWrite: { raw: string; rule: PathRule }[] = [];
  for (const f of files) {
    const sb = f.data.sandbox ?? {};
    const base = f.scope === "user" ? dirname(f.path) : f.scope === "managed" ? "/" : project;
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    domains.push(...strs(sb.network?.allowedDomains));
    excluded.push(...strs(sb.excludedCommands));
    denyRead.push(...strs(sb.filesystem?.denyRead).map((p) => sandboxPath(p, base, home)));
    allowRead.push(...strs(sb.filesystem?.allowRead).map((p) => sandboxPath(p, base, home)));
    allowWrite.push(...strs(sb.filesystem?.allowWrite).map((raw) => ({ raw, rule: sandboxPath(raw, base, home) })));
    for (const r of strs(f.data.permissions?.allow)) {
      const fetch = /^WebFetch\(domain:(.+)\)$/.exec(r);
      if (fetch) domains.push(fetch[1]!);
      const edit = /^Edit\((.+)\)$/.exec(r);
      if (edit) allowWrite.push({ raw: edit[1]!, rule: permissionPath(edit[1]!, project, home) });
    }
    for (const r of strs(f.data.permissions?.deny)) {
      const read = /^Read\((.+)\)$/.exec(r);
      if (read) denyRead.push(permissionPath(read[1]!, project, home));
    }
  }

  const on = scalar((d) => d.sandbox?.enabled) === true;
  const offNote = "only counts with the sandbox on";
  const checks: Check[] = [];

  checks.push(
    on
      ? { id: "sandbox", label: "Sandbox is on", points: 30, max: 30, status: "ok", detail: "commands Claude runs are isolated from the rest of your machine" }
      : { id: "sandbox", label: "Sandbox is on", points: 0, max: 30, status: "fail", detail: "commands Claude runs can read, write and reach anything you can", fix: "npx sandfit apply" },
  );

  const noEscape = scalar((d) => d.sandbox?.allowUnsandboxedCommands) === false;
  checks.push(
    on && noEscape
      ? { id: "escape", label: "No way around it", points: 10, max: 10, status: "ok", detail: "a failing command cannot be retried outside the sandbox" }
      : { id: "escape", label: "No way around it", points: 0, max: 10, status: "fail", detail: on ? "Claude can retry a failing command outside the sandbox (allowUnsandboxedCommands is not false)" : offNote, ...(on ? { fix: "npx sandfit apply" } : {}) },
  );

  const failClosed = scalar((d) => d.sandbox?.failIfUnavailable) === true;
  checks.push(
    on && failClosed
      ? { id: "fail-closed", label: "Fails closed", points: 5, max: 5, status: "ok", detail: "if the sandbox cannot start, commands are refused" }
      : { id: "fail-closed", label: "Fails closed", points: 0, max: 5, status: "fail", detail: on ? "if the sandbox cannot start, commands run without it (failIfUnavailable is not true)" : offNote, ...(on ? { fix: "npx sandfit apply" } : {}) },
  );

  // strictAllowlist is honoured only from user or managed settings.
  const strict = scalar((d) => d.sandbox?.network?.strictAllowlist, ["user", "managed"]) === true;
  const openAll = domains.filter((d) => d === "*");
  const wholeTld = domains.filter((d) => /^\*\.[^.]+$/.test(d));
  if (!on) checks.push({ id: "network", label: "Network limited to known sites", points: 0, max: 15, status: "fail", detail: offNote });
  else if (openAll.length) checks.push({ id: "network", label: "Network limited to known sites", points: 0, max: 15, status: "fail", detail: "a \"*\" entry lets commands reach any website", fix: "remove \"*\" from allowedDomains (or WebFetch(domain:*)), then npx sandfit apply" });
  else if (wholeTld.length) checks.push({ id: "network", label: "Network limited to known sites", points: 5, max: 15, status: "partial", detail: `${wholeTld.join(", ")} covers a whole top-level domain`, fix: "replace it with the sites you use: npx sandfit apply" });
  else if (strict) checks.push({ id: "network", label: "Network limited to known sites", points: 15, max: 15, status: "ok", detail: `${plural(domains.length, "site")} allowed; anything else is refused without asking` });
  else checks.push({ id: "network", label: "Network limited to known sites", points: 10, max: 15, status: "partial", detail: `${plural(domains.length, "site")} allowed; other sites ask first (in auto mode the classifier answers)`, fix: "npx sandfit apply --user --strict-network" });

  // Readable unless denied; an allowRead narrower than the deny that covers it re-opens it
  // ("when read rules overlap, the rule with the narrower path applies").
  const readable = (p: string): boolean => {
    const deniedBy = denyRead.filter((d) => covers(d, p));
    if (!deniedBy.length) return true;
    return allowRead.some((a) => a.abs && covers(a, p) && deniedBy.every((d) => d.abs && a.abs !== d.abs && isInside(a.abs!, d.abs)));
  };
  const exposed = ctx.secrets.filter(readable);
  if (!on) checks.push({ id: "secrets", label: "Credentials protected", points: 0, max: 20, status: "fail", detail: offNote });
  else if (!ctx.secrets.length) checks.push({ id: "secrets", label: "Credentials protected", points: 20, max: 20, status: "ok", detail: "no credential files found on this machine to protect" });
  else {
    const points = Math.round((20 * (ctx.secrets.length - exposed.length)) / ctx.secrets.length);
    const shown = exposed.slice(0, 4).map((p) => tildify(p, home)).join(", ") + (exposed.length > 4 ? `, +${exposed.length - 4} more` : "");
    // Files a tool reads on every run (npm and ~/.npmrc) stay readable after apply too, so apply is no fix for them.
    const toolRead = new Set(Object.values(KNOWLEDGE).flatMap((k) => k.readsSecrets ?? []).map((p) => expandHome(p, home)));
    const fix = exposed.some((p) => !toolRead.has(p))
      ? "npx sandfit apply"
      : `your tools read ${exposed.length === 1 ? "this file" : "these files"} on every run, so the sandbox has to allow it: keep tokens out of ${exposed.length === 1 ? "it" : "them"} (use environment variables instead)`;
    checks.push(
      exposed.length
        ? { id: "secrets", label: "Credentials protected", points, max: 20, status: points ? "partial" : "fail", detail: `${exposed.length} of ${ctx.secrets.length} credential files readable by commands: ${shown}`, fix }
        : { id: "secrets", label: "Credentials protected", points: 20, max: 20, status: "ok", detail: `all ${ctx.secrets.length} credential files found are blocked from commands` },
    );
  }

  const dangerousWrite = (p: string): string | undefined => {
    if (p === "/" || isInside(home, p)) return "your whole home folder";
    if (SECRET_PATHS.some((s) => isInside(p, expandHome(s, home)) || isInside(expandHome(s, home), p))) return "credential files";
    if (isAgentState(p, home)) return "the agent's own settings and memory";
    if (SHELL_STARTUP.some((s) => isInside(join(home, s), p))) return "shell startup files";
    return undefined;
  };
  const bad = allowWrite.flatMap(({ raw, rule }) => {
    const why = rule.abs ? dangerousWrite(rule.abs) : /^(\/|~\/?)?\*\*/.test(raw) ? "everything (a glob from the top)" : undefined;
    return why ? [`${raw} (${why})`] : [];
  });
  const broad = allowWrite.filter(({ rule }) => rule.abs && !dangerousWrite(rule.abs) && tooBroad(rule.abs, home)).map(({ raw }) => raw);
  if (!on) checks.push({ id: "writes", label: "Writes kept narrow", points: 0, max: 10, status: "fail", detail: offNote });
  else if (bad.length) checks.push({ id: "writes", label: "Writes kept narrow", points: 0, max: 10, status: "fail", detail: `commands can write to ${bad.join(", ")}`, fix: "remove these from allowWrite / Edit allow rules" });
  else if (broad.length) checks.push({ id: "writes", label: "Writes kept narrow", points: 5, max: 10, status: "partial", detail: `broad folders writable: ${broad.join(", ")}`, fix: "narrow them to the folders your tools use: npx sandfit apply" });
  else checks.push({ id: "writes", label: "Writes kept narrow", points: 10, max: 10, status: "ok", detail: allowWrite.length ? `${plural(allowWrite.length, "extra folder")}, none broad or sensitive` : "only the project and temp folders" });

  const programs = [...new Set(excluded.map((e) => e.trim().replace(/(\s\*|:\*)$/, "")))].filter(Boolean);
  const anything = programs.filter((p) => RUNS_ANYTHING.has(p.split(/\s+/)[0]!.split("/").pop()!) && p.split(/\s+/).length === 1);
  if (!on) checks.push({ id: "outside", label: "Little runs outside", points: 0, max: 10, status: "fail", detail: offNote });
  else if (anything.length) checks.push({ id: "outside", label: "Little runs outside", points: 0, max: 10, status: "fail", detail: `${anything.join(", ")} can run anything, and runs outside the sandbox`, fix: "remove it from excludedCommands; exclude the specific tool instead" });
  else {
    const points = programs.length <= 3 ? 10 : Math.max(5, 13 - programs.length);
    checks.push({ id: "outside", label: "Little runs outside", points, max: 10, status: points === 10 ? "ok" : "partial", detail: programs.length ? `${programs.length} run outside the sandbox: ${programs.slice(0, 6).join(", ")}${programs.length > 6 ? ", …" : ""}` : "nothing runs outside the sandbox", ...(points < 10 ? { fix: "review excludedCommands; keep only what cannot work sandboxed" } : {}) });
  }

  const total = checks.reduce((n, c) => n + c.points, 0);
  return { total, grade: gradeOf(total), checks, files: files.map((f) => f.path) };
}

export function gradeOf(total: number): Score["grade"] {
  return total >= 90 ? "A" : total >= 75 ? "B" : total >= 60 ? "C" : total >= 40 ? "D" : "F";
}

const BADGE_COLOR: Record<Score["grade"], string> = { A: "brightgreen", B: "green", C: "yellow", D: "orange", F: "red" };

/** A shields.io badge for a README, linking to sandfit. */
export function badgeMarkdown(score: Score): string {
  const url = `https://img.shields.io/badge/${encodeURIComponent("agent sandbox")}-${encodeURIComponent(`${score.total}/100`)}-${BADGE_COLOR[score.grade]}`;
  return `[![agent sandbox: ${score.total}/100](${url})](https://github.com/hardikverma22/sandfit)`;
}

export function renderScore(score: Score, opts: { home: string; fit?: { blocked: number; secrets?: number; total: number }; projectOnly?: boolean }): string {
  const color = score.grade === "A" || score.grade === "B" ? pc.green : score.grade === "C" ? pc.yellow : pc.red;
  const out = ["", `${pc.bold("sandfit score")}  ${color(pc.bold(`${score.total}/100`))}  ${color(`grade ${score.grade}`)}  ${pc.dim(opts.projectOnly ? "(the project's committed settings only)" : "(Claude Code sandbox, as your settings apply to this project)")}`, ""];
  for (const c of score.checks) {
    const mark = c.status === "ok" ? pc.green("✓") : c.status === "partial" ? pc.yellow("~") : pc.red("✗");
    out.push(`  ${mark} ${c.label.padEnd(31)} ${pc.dim(`${c.points}/${c.max}`.padStart(5))}  ${c.detail}`);
    if (c.fix) out.push(`  ${" ".repeat(39)}${pc.dim("fix:")} ${c.fix}`);
  }
  out.push("");
  if (opts.fit && opts.fit.total > 0) {
    const pct = (100 * opts.fit.blocked) / opts.fit.total;
    // Same count as sandfit apply and forecast: secret reads are blocked on purpose, not broken.
    const secrets = opts.fit.secrets ? `, plus ${opts.fit.secrets} blocked on purpose for reading secrets` : "";
    out.push(`  ${pc.dim("Fit:")} these settings would break ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of your recent commands (${opts.fit.blocked} of ${opts.fit.total}${secrets}). ${pc.dim("sandfit forecast shows which.")}`);
  }
  out.push(pc.dim(`  Read from: ${score.files.length ? score.files.map((f) => tildify(f, opts.home)).join(", ") : "no Claude Code settings files"}`));
  out.push(pc.dim("  Badge for your README: sandfit score --badge"), "");
  return out.join("\n");
}
