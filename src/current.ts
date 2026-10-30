import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./extract/extract.js";
import { defaultModel, type SandboxModel } from "./forecast.js";

/** Claude Code settings files that apply to a project, lowest precedence first. */
export function claudeSettingsFiles(project: string, home = homedir()): string[] {
  const userDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return [join(userDir, "settings.json"), join(project, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")];
}

/**
 * The sandbox you would get today if you ran /sandbox in Claude Code with your current
 * settings. Most people have never configured it, so this is usually the bare default.
 */
export function currentClaudeModel(projects: string[], home = homedir()): { model: SandboxModel; configured: boolean } {
  const model = defaultModel(projects, "claude");
  let configured = false;
  for (const project of projects) {
    for (const file of claudeSettingsFiles(project, home)) {
      if (!existsSync(file)) continue;
      let s: any;
      try {
        s = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const sb = s?.sandbox;
      if (!sb) continue;
      configured = true;
      const rel = (p: string) => (p.startsWith(".") ? join(project, p) : expandHome(p, home));
      model.domains.push(...(sb.network?.allowedDomains ?? []));
      model.writeRoots.push(...(sb.filesystem?.allowWrite ?? []).map(rel));
      model.denyRead.push(...(sb.filesystem?.denyRead ?? []).map(rel));
      model.denyWrite.push(...(sb.filesystem?.denyWrite ?? []).map(rel));
      model.sockets.push(...(sb.network?.allowUnixSockets ?? []));
      if (sb.network?.allowLocalBinding) model.localBinding = true;
      model.excluded.push(...(sb.excludedCommands ?? []).map((c: string) => c.replace(/ \*$/, "").replace(/:\*$/, "")));
      for (const rule of s?.permissions?.allow ?? []) {
        const m = /^WebFetch\(domain:(.+)\)$/.exec(rule);
        if (m) model.domains.push(m[1]!);
      }
    }
  }
  return { model, configured };
}
