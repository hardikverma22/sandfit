#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { mergeSettings, toClaudeSettings } from "./emit/claude.js";
import { toCodexToml, toNonoProfile, toPolicyYaml, toSrtSettings } from "./emit/others.js";
import { diffConfig, unusedEntries } from "./diff.js";
import { forecast, modelFromPolicy } from "./forecast.js";
import { plural, renderBlockers, renderChanges, renderDiff, renderExplain, renderSummary } from "./report.js";
import { parseAnswer, reviewLabel, reviewPolicy } from "./review.js";
import { run, type RunOptions } from "./run.js";
import type { Harness, Policy } from "./types.js";
import { VERSION } from "./version.js";

const TARGETS = ["claude", "srt", "codex", "nono", "policy"] as const;
type Target = (typeof TARGETS)[number];

function intArg(min: number) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new InvalidArgumentError(`expected a whole number of at least ${min}`);
    return n;
  };
}

function fractionArg(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n >= 1) throw new InvalidArgumentError("expected a number from 0 up to (not including) 1, e.g. 0.2");
  return n;
}

function harnessArg(v: string): Harness[] {
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((h) => h !== "claude" && h !== "codex");
  if (bad.length || list.length === 0) throw new InvalidArgumentError(`expected claude, codex or claude,codex (got ${v})`);
  return list as Harness[];
}

function common(cmd: Command): Command {
  return cmd
    .option("-a, --all", "use history from every project, not just this one")
    .option("-p, --project <dir>", "project root to build the policy for (default: this git repo)")
    .option("-d, --days <n>", "only use the last N days of history (0 = all)", intArg(0), 30)
    .addOption(new Option("--harness <list>", "which agents' history to read: claude, codex or claude,codex").argParser(harnessArg).default(["claude", "codex"], "claude,codex"))
    .option("--min-count <n>", "drop grants seen fewer than N times", intArg(1), 1)
    .option("--holdout <fraction>", "share of newest history held back to test the policy (0 to turn off)", fractionArg, 0.2)
    .option("--claude-dir <dir>", "Claude Code projects dir (default ~/.claude/projects)")
    .option("--codex-dir <dir>", "Codex sessions dir (default ~/.codex/sessions)");
}

function runOpts(o: any, scope: RunOptions["scope"] = "claude"): RunOptions {
  return {
    all: o.all,
    project: o.project,
    days: o.days > 0 ? o.days : undefined,
    harness: o.harness as Harness[],
    minCount: o.minCount,
    holdout: o.holdout,
    claudeDir: o.claudeDir,
    codexDir: o.codexDir,
    scope,
  };
}

function scopeFor(target: Target): RunOptions["scope"] {
  return target === "claude" || target === "policy" ? "claude" : "process";
}

function render(target: Target, policy: Awaited<ReturnType<typeof run>>["policy"], o: any): string {
  switch (target) {
    case "claude":
      return JSON.stringify(toClaudeSettings(policy, { withPermissions: !!o.withPermissions, strictNetwork: !!o.strictNetwork, maskCredentials: !!o.maskCredentials, user: !!o.user }), null, 2) + "\n";
    case "srt":
      return JSON.stringify(toSrtSettings(policy), null, 2) + "\n";
    case "codex":
      return toCodexToml(policy, { profile: !!o.codexProfile });
    case "nono":
      return JSON.stringify(toNonoProfile(policy, o.name ?? "sandfit"), null, 2) + "\n";
    case "policy":
      return toPolicyYaml(policy);
  }
}

function harnessLabel(h: string[]): string {
  return h.map((x) => (x === "claude" ? "Claude Code" : x === "codex" ? "Codex" : x)).join(" + ") || "none";
}

const program = new Command()
  .name("sandfit")
  .description("Turn on your coding agent's sandbox without breaking your workflow.")
  .version(VERSION)
  .enablePositionalOptions();

common(program)
  .option("--json", "print machine-readable results")
  .action(async (o) => {
    const r = await run(runOpts(o));
    if (o.json) {
      console.log(
        JSON.stringify(
          {
            version: VERSION,
            scope: r.scopeLabel,
            projects: r.projects,
            sessions: r.sessions,
            toolCalls: r.analyzed.length,
            baseline: strip(r.baseline),
            baselineConfigured: r.baselineConfigured,
            withPolicy: strip(r.withPolicy),
            holdout: r.holdout && { fraction: r.holdout.fraction, ...strip(r.holdout.result) },
            policy: r.policy,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      renderSummary({
        version: VERSION,
        scopeLabel: r.scopeLabel,
        harnessLabel: harnessLabel(r.policy.source.harnesses),
        days: o.days > 0 ? o.days : undefined,
        events: r.analyzed.length,
        sessions: r.sessions,
        baseline: r.baseline,
        baselineConfigured: r.baselineConfigured,
        withPolicy: r.withPolicy,
        holdout: r.holdout,
        policy: r.policy,
      }),
    );
  });

common(program.command("forecast").description("list exactly which past commands each sandbox would block, and the fix for each"))
  .addOption(new Option("--scope <scope>", "claude: Claude Code's Bash sandbox; process: a sandbox around the whole agent").choices(["claude", "process"]).default("claude"))
  .action(async (o) => {
    const r = await run(runOpts(o, o.scope));
    console.log(renderBlockers(r.baseline, r.baselineConfigured ? "With your current sandbox settings" : "With the sandbox switched on and no configuration"));
    console.log("");
    console.log(renderBlockers(r.withPolicy, "With the sandfit policy"));
    if (r.holdout) {
      console.log("");
      console.log(renderBlockers(r.holdout.result, `Holdout: policy built without your newest ${Math.round(r.holdout.fraction * 100)}% of history, tested on it`));
    }
  });

common(program.command("explain").description("show why each grant is in the policy: how often it was needed and an example").argument("[filter]", "only grants containing this text, e.g. github.com or .npm"))
  .addOption(new Option("--scope <scope>", "claude: Claude Code's Bash sandbox; process: a sandbox around the whole agent").choices(["claude", "process"]).default("claude"))
  .action(async (filter: string | undefined, o) => {
    const r = await run(runOpts(o, o.scope));
    const text = renderExplain(r.policy, filter);
    console.log(text);
    if (filter && text.includes("No grant matches")) process.exitCode = 1;
  });

common(program.command("emit").description("print the policy for a sandbox"))
  .addOption(new Option("-t, --target <target>", "output format").choices([...TARGETS]).default("claude"))
  .option("--codex-profile", "emit a Codex permissions profile with per-domain rules")
  .option("--with-permissions", "Claude Code: also add allow rules for WebFetch domains, Edit paths and MCP tools you used")
  .option("--user", "Claude Code: settings meant for ~/.claude/settings.json (needed for --strict-network)")
  .option("--strict-network", "Claude Code: refuse hosts outside the allowlist instead of prompting (user settings only, Claude Code v2.1.219+)")
  .option("--mask-credentials", "Claude Code: let commands use secret env vars your history sent to known hosts without seeing them (user settings only; experimental TLS termination)")
  .option("--name <name>", "profile name (nono)")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (o) => {
    const target = o.target as Target;
    if (o.strictNetwork && target !== "claude") throw new Error("--strict-network is a Claude Code setting; it does not apply to this target.");
    if (o.maskCredentials && target !== "claude") throw new Error("--mask-credentials is a Claude Code setting; it does not apply to this target.");
    const r = await run(runOpts(o, scopeFor(target)));
    const text = render(target, r.policy, o);
    if (o.out) {
      writeWithBackup(o.out, text);
      console.error(pc.green(`wrote ${o.out}`));
    } else process.stdout.write(text);
  });

interface Plan {
  file: string;
  text: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  generated: Record<string, unknown>;
  /** The file is replaced, not merged (nono profiles belong to sandfit). */
  replaces: boolean;
}

/** Which file a target writes, what it holds now, and what apply would write. */
function planFor(target: Target, policy: Policy, projects: string[], o: any): Plan {
  const home = homedir();
  if (target === "claude") {
    const file = o.user ? join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json") : join(projects[0] ?? process.cwd(), ".claude", "settings.json");
    const before = readConfig(file, "json");
    const generated = toClaudeSettings(policy, { withPermissions: !!o.withPermissions, strictNetwork: !!o.strictNetwork, maskCredentials: !!o.maskCredentials, user: !!o.user });
    const after = mergeSettings(before, generated);
    return { file, before, after, generated, text: JSON.stringify(after, null, 2) + "\n", replaces: false };
  }
  if (target === "srt") {
    const file = join(home, ".srt-settings.json");
    const before = readConfig(file, "json");
    const generated = toSrtSettings(policy);
    const after = mergeSettings(before, generated);
    return { file, before, after, generated, text: JSON.stringify(after, null, 2) + "\n", replaces: false };
  }
  if (target === "codex") {
    const file = join(process.env.CODEX_HOME || join(home, ".codex"), "config.toml");
    const before = readConfig(file, "toml");
    const generated = tomlParse(toCodexToml(policy, { profile: !!o.codexProfile })) as Record<string, unknown>;
    const after = mergeSettings(before, generated);
    return { file, before, after, generated, text: tomlStringify(after) + "\n", replaces: false };
  }
  const file = join(home, ".config", "nono", "profiles", `${o.name ?? "sandfit"}.json`);
  const before = readConfig(file, "json");
  const generated = toNonoProfile(policy, o.name ?? "sandfit");
  return { file, before, after: generated, generated, text: JSON.stringify(generated, null, 2) + "\n", replaces: true };
}

/** Refuse when there is nothing to build from, or when project settings would be ambiguous. */
function checkApplicable(target: Target, r: Awaited<ReturnType<typeof run>>, o: any): boolean {
  for (const [flag, on] of [["--strict-network", o.strictNetwork], ["--mask-credentials", o.maskCredentials]] as const) {
    if (on && target !== "claude") {
      console.error(pc.yellow(`sandfit: ${flag} is a Claude Code setting; it does not apply to this target.`));
      process.exitCode = 1;
      return false;
    }
  }
  if (o.maskCredentials && !r.policy.maskEnv?.length) {
    console.error(pc.dim("sandfit: no secret environment variables found in this history to mask (it looks for $NAME_TOKEN-style variables used in commands that reach a host, and known tool tokens like NPM_TOKEN)."));
  }
  if (r.withPolicy.shellCalls === 0) {
    console.error(pc.yellow(`sandfit: no agent history found for ${r.scopeLabel}; nothing written. Run your agent in this project first, or pass --project.`));
    process.exitCode = 1;
    return false;
  }
  if (target === "claude" && !o.user && r.projects.length !== 1) {
    console.error(pc.yellow(`sandfit: this history spans ${r.projects.length} projects. Run it inside one project (or pass --project), or use --user for your user settings.`));
    process.exitCode = 1;
    return false;
  }
  return true;
}

/** Reads answers line by line from stdin, whether it is a terminal or a pipe. EOF answers "". */
function lineReader() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const next = await it.next();
      if (next.done) {
        process.stdout.write("\n");
        return "";
      }
      if (!process.stdin.isTTY) process.stdout.write(`${next.value}\n`);
      return next.value;
    },
    close: () => rl.close(),
  };
}

const targetOptions = (cmd: Command) =>
  cmd
    .addOption(new Option("-t, --target <target>", "sandbox to configure").choices(["claude", "srt", "codex", "nono"]).default("claude"))
    .option("--user", "Claude Code: user settings (~/.claude/settings.json) instead of the project's")
    .option("--with-permissions", "Claude Code: also add allow rules for WebFetch domains, Edit paths and MCP tools you used")
    .option("--codex-profile", "Codex: a permissions profile with per-domain rules")
    .option("--strict-network", "Claude Code: refuse hosts outside the allowlist instead of prompting (user settings only, Claude Code v2.1.219+)")
    .option("--mask-credentials", "Claude Code: let commands use secret env vars your history sent to known hosts without seeing them (user settings only; experimental TLS termination)")
    .option("--name <name>", "nono profile name", "sandfit");

targetOptions(common(program.command("diff").description("show what apply would change in your sandbox config, without writing anything")))
  .option("--json", "print machine-readable results")
  .option("--full", "list every protection rule too, not just a count")
  .action(async (o) => {
    const target = o.target as Target;
    const r = await run(runOpts(o, scopeFor(target)));
    if (!checkApplicable(target, r, o)) return;
    const plan = planFor(target, r.policy, r.projects, o);
    const changes = diffConfig(plan.before, plan.after);
    const unused = plan.replaces ? [] : unusedEntries(plan.before, plan.generated);
    if (o.json) {
      console.log(JSON.stringify({ file: plan.file, exists: existsSync(plan.file), changes, unused }, null, 2));
      return;
    }
    console.log(renderDiff(plan.file, existsSync(plan.file), changes, unused, !!o.full));
  });

targetOptions(common(program.command("apply").description("write the policy into your sandbox's config (shows the changes, asks first, keeps a backup)")))
  .option("--review", "go through grants your history needed only rarely, and keep or drop each one")
  .option("--review-max <n>", "with --review: review grants needed at most N times", intArg(1), 1)
  .option("-y, --yes", "do not ask for confirmation")
  .action(async (o) => {
    const target = o.target as Target;
    const r = await run(runOpts(o, scopeFor(target)));
    if (!checkApplicable(target, r, o)) return;
    const reader = o.review || (!o.yes && process.stdin.isTTY) ? lineReader() : undefined;
    try {
      let policy = r.policy;
      if (o.review) {
        const result = await reviewPolicy(
          policy,
          async (item, i, total) => {
            if (i === 0) console.log(`${pc.bold("Review")}  ${plural(total, "grant")} your history needed ${o.reviewMax === 1 ? "only once" : `at most ${o.reviewMax} times`}. Enter keeps it.`);
            console.log(`  ${pc.dim(`${i + 1}/${total}`)} ${reviewLabel(item.kind)}: ${pc.bold(item.value)}  ${pc.dim(`needed ${plural(item.count, "time")}, e.g. ${item.example.slice(0, 90)}`)}`);
            return parseAnswer(await reader!.ask(`      ${pc.dim("[k]eep  [d]rop  keep [a]ll  drop all [x]")} `));
          },
          o.reviewMax,
        );
        policy = result.policy;
        if (result.reviewed === 0) console.log(pc.dim(`  Nothing to review: every grant was needed more than ${plural(o.reviewMax, "time")}.`));
        else console.log(`  ${result.dropped.length ? `dropped ${result.dropped.map((d) => d.value).join(", ")}` : "kept everything"}\n`);
      }

      const plan = planFor(target, policy, r.projects, o);
      const changes = diffConfig(plan.before, plan.after);
      // After a review the policy may have lost grants: forecast the policy that will actually be written.
      const f = policy === r.policy ? r.withPolicy : forecast(r.analyzed, modelFromPolicy(policy, scopeFor(target) ?? "claude", homedir(), r.projects));
      const broken = f.blockedCalls - f.secretCalls;
      console.log(`${pc.bold("sandfit apply")} → ${plan.file}`);
      console.log(`  forecast: ${broken} of ${f.shellCalls} past shell commands would still break${policy === r.policy || broken === r.withPolicy.blockedCalls - r.withPolicy.secretCalls ? "" : pc.yellow(" (because of what you dropped)")}`);
      if (changes.length === 0) {
        console.log(pc.green("  already up to date: nothing to write"));
        return;
      }
      console.log(renderChanges(changes));
      if (!o.yes) {
        if (!reader || !process.stdin.isTTY) {
          console.error(pc.yellow("  not a terminal: re-run with --yes to write the file"));
          process.exitCode = 1;
          return;
        }
        const answer = await reader.ask(`  write it${existsSync(plan.file) ? " (a backup of the current file is kept)" : ""}? [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("  nothing written");
          return;
        }
      }
      const backup = writeWithBackup(plan.file, plan.text);
      console.log(pc.green(`  wrote ${plan.file}`) + (backup ? pc.dim(`  (backup: ${backup})`) : ""));
      if (target === "nono") console.log(pc.dim(`  run your agent with: nono run --profile ${o.name} -- claude`));
      if (target === "srt") console.log(pc.dim("  run your agent with: srt claude"));
    } finally {
      reader?.close();
    }
  });

/** Read an existing config file to merge into; refuse (rather than overwrite) one we cannot parse. */
function readConfig(file: string, format: "json" | "toml"): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  try {
    const v = format === "json" ? JSON.parse(text) : tomlParse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${file} is not valid ${format.toUpperCase()} (${e instanceof Error ? e.message.split("\n")[0] : e}). Fix it or move it away; nothing was written.`);
  }
}

function writeWithBackup(file: string, text: string): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  if (existsSync(file)) {
    backup = `${file}.sandfit-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, text);
  return backup;
}

function strip(r: any) {
  return { ...r, blockers: r.blockers.slice(0, 50) };
}

program.parseAsync().catch((err) => {
  console.error(pc.red(`sandfit: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
