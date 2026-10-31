/**
 * A small, realistic sample history for the demo video: one week of a developer working on
 * a Next.js app with Claude Code. Writes it into a throwaway home, then runs the real
 * sandfit CLI on it and saves the output the video shows (demo/output/*.txt).
 *
 *   npx tsx demo/sample-history.ts
 *
 * Nothing here is real user data; every command is typical of what agents run.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rng } from "../bench/synth.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = join(ROOT, "demo", "output");

// command, weight (how often it shows up in a week), approved by hand?
const WEEK: [string, number, boolean?][] = [
  ["npm test", 40],
  ["npm run lint", 18],
  ["npx tsc --noEmit", 22],
  ["git status", 30],
  ["git diff", 25],
  ['git commit -m "wip"', 12],
  ["npm install", 9, true],
  ["npm install zod @tanstack/react-query", 3, true],
  ["npm run dev", 8, true],
  ["curl -s localhost:3000/api/health", 10],
  ["git push origin HEAD", 6, true],
  ["git pull --rebase", 5],
  ["gh pr create --fill", 2, true],
  ["npx prisma migrate dev", 3],
  ["docker compose up -d db", 3, true],
  ["curl -s https://api.github.com/repos/vercel/next.js/releases/latest", 2],
  ["npx playwright install chromium", 1, true],
  ["npx playwright test", 6],
  ["mkdir -p ~/notes && echo '- fixed auth redirect' >> ~/notes/standup.md", 4],
  ["cat .env.local", 2],
  ["vercel --prod", 2, true],
  ["pip install -r scripts/requirements.txt", 1, true],
  ["python3 scripts/seed.py", 2],
  ["rg -n 'useSession' src", 15],
  ["ls -la", 12],
];

export function makeSampleHome(): { home: string; project: string } {
  mkdirSync(join(ROOT, ".bench"), { recursive: true });
  const home = mkdtempSync(join(ROOT, ".bench", "demo-"));
  const project = join(home, "code", "storefront");
  for (const d of [".npm", ".cache/ms-playwright", ".cache/pip", "notes", "code/storefront/.git"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(project, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/storefront.git\n');
  writeFileSync(join(project, ".env.local"), "DATABASE_URL=postgres://localhost/dev\n");

  const rand = rng(7);
  const bag = WEEK.flatMap(([cmd, w, prompted]) => Array.from({ length: w }, () => ({ cmd, prompted: !!prompted })));
  // Shuffle so the newest 20% (the holdout) is a fair sample, like a real week.
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  const sessions = 12;
  const per = Math.ceil(bag.length / sessions);
  const start = Date.now() - 7 * 86_400_000;
  for (let s = 0; s < sessions; s++) {
    const lines: string[] = [];
    bag.slice(s * per, (s + 1) * per).forEach((c, i) => {
      const id = `s${s}-${i}`;
      const base = { cwd: project, sessionId: `session-${s}`, timestamp: new Date(start + (s * per + i) * 600_000).toISOString() };
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: c.cmd } }] }, ...base }));
      lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, permissionDecision: { decision: "accept", source: c.prompted ? "user_temporary" : "config" }, ...base }));
    });
    const dir = join(home, ".claude", "projects", "-code-storefront");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `session-${s}.jsonl`), lines.join("\n") + "\n");
  }
  return { home, project };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { home, project } = makeSampleHome();
  mkdirSync(OUT, { recursive: true });
  try {
    for (const [name, args] of [["summary", []], ["explain", ["explain"]], ["emit-claude", ["emit", "-t", "claude"]]] as const) {
      const r = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], {
        cwd: project,
        env: { ...process.env, HOME: home, NO_COLOR: "1", FORCE_COLOR: "0", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" },
        encoding: "utf8",
      });
      // Show ~ instead of the throwaway home path.
      const text = (r.stdout + r.stderr).split(home).join("~");
      writeFileSync(join(OUT, `${name}.txt`), text);
      console.log(`--- ${name}\n${text}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
