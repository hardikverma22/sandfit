import { homedir } from "node:os";
import { currentClaudeModel } from "./current.js";
import { analyze } from "./extract/extract.js";
import { defaultModel, forecast, holdoutSplit, modelFromPolicy, type ForecastResult } from "./forecast.js";
import { ingest } from "./ingest/index.js";
import { buildPolicy, projectRootsOf } from "./policy/build.js";
import { gitRoot, tildify } from "./policy/paths.js";
import type { AnalyzedEvent, Harness, Policy } from "./types.js";

export interface RunOptions {
  all?: boolean;
  project?: string;
  days?: number;
  harness?: Harness[];
  minCount?: number;
  claudeDir?: string;
  codexDir?: string;
  holdout?: number;
  scope?: "claude" | "process";
  home?: string;
}

export interface RunResult {
  analyzed: AnalyzedEvent[];
  projects: string[];
  sessions: number;
  scopeLabel: string;
  policy: Policy;
  baseline: ForecastResult;
  baselineConfigured: boolean;
  withPolicy: ForecastResult;
  holdout?: { result: ForecastResult; fraction: number };
}

/** The whole pipeline: history -> needs -> policy -> forecasts. */
export async function run(opts: RunOptions): Promise<RunResult> {
  const home = opts.home ?? homedir();
  const cwdRoot = gitRoot(process.cwd()) ?? process.cwd();
  let project = opts.all ? undefined : (opts.project ?? cwdRoot);
  let ing = await ingest({ harnesses: opts.harness, claudeDir: opts.claudeDir, codexDir: opts.codexDir, project, days: opts.days });
  let scopeLabel = project ? `project ${tildify(project, home)}` : "all projects";
  if (project && ing.events.length === 0 && !opts.project) {
    project = undefined;
    ing = await ingest({ harnesses: opts.harness, claudeDir: opts.claudeDir, codexDir: opts.codexDir, days: opts.days });
    scopeLabel = `all projects (no history found for ${tildify(cwdRoot, home)})`;
  }

  const analyzed = analyze(ing.events, { home });
  const projects = project ? [project] : projectRootsOf(analyzed);
  const scope = opts.scope ?? "claude";
  const policy = buildPolicy(analyzed, { home, projects, minCount: opts.minCount });

  const current = scope === "claude" ? currentClaudeModel(projects, home) : { model: defaultModel(projects, scope), configured: false };
  const baseline = forecast(analyzed, current.model, home);
  const withPolicy = forecast(analyzed, modelFromPolicy(policy, scope, home, projects), home);

  let holdout: RunResult["holdout"];
  const fraction = opts.holdout ?? 0.2;
  if (fraction > 0 && analyzed.length >= 20) {
    const [train, test] = holdoutSplit(analyzed, fraction);
    const trained = buildPolicy(train, { home, projects, minCount: opts.minCount });
    holdout = { result: forecast(test, modelFromPolicy(trained, scope, home, projects), home), fraction };
  }

  return { analyzed, projects, sessions: ing.sessions, scopeLabel, policy, baseline, baselineConfigured: current.configured, withPolicy, holdout };
}
