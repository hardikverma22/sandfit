/**
 * Accuracy benchmark: how well does sandfit work out what a command needs?
 * Scores sandfit's extractor against the hand-labelled corpus in bench/corpus.ts.
 *
 *   npm run bench:accuracy            print a table
 *   npm run bench:accuracy -- --json  machine-readable
 */
import { CORPUS } from "./corpus.js";
import { HOLDOUT } from "./corpus-holdout.js";
import { makeFixture, precision, recall, scoreCorpus } from "./accuracy-lib.js";

const fx = makeFixture();
try {
  const sets = [
    { name: "Tuning set", note: "bench/corpus.ts: sandfit was improved against these", cases: CORPUS },
    { name: "Holdout set", note: "bench/corpus-holdout.ts: written after tuning, never tuned on", cases: HOLDOUT },
  ];
  const scored = sets.map((set) => ({ ...set, score: scoreCorpus(set.cases, fx) }));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(scored.map(({ name, score: s }) => ({ name, cases: s.cases, exact: s.exact, byKind: s.byKind, total: s.total })), null, 2));
  } else {
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
    const names: Record<string, string> = { net: "Network hosts", write: "Writes outside project", bind: "Local servers", exec: "Must run outside sandbox", secret: "Secret reads" };
    for (const { name, note, score: s } of scored) {
      console.log(`\n### ${name}: ${s.cases} commands, ${s.exact} fully correct (${pct(s.exact / s.cases)})\n`);
      console.log(`_${note}_\n`);
      console.log("| Need | Precision | Recall | Correct | Wrong | Missed |");
      console.log("|---|---:|---:|---:|---:|---:|");
      for (const [k, v] of Object.entries(s.byKind).sort()) {
        console.log(`| ${names[k] ?? k} | ${pct(precision(v))} | ${pct(recall(v))} | ${v.tp} | ${v.fp} | ${v.fn} |`);
      }
      console.log(`| **All** | **${pct(precision(s.total))}** | **${pct(recall(s.total))}** | ${s.total.tp} | ${s.total.fp} | ${s.total.fn} |`);
      const wrong = s.results.filter((r) => r.missed.length || r.extra.length);
      if (wrong.length) {
        console.log("\nNot fully right:\n");
        for (const r of wrong) {
          const parts = [r.missed.length ? `missed ${r.missed.join(", ")}` : "", r.extra.length ? `extra ${r.extra.join(", ")}` : ""].filter(Boolean).join("; ");
          console.log(`- \`${r.case.cmd.replace(/\n/g, "\\n")}\`: ${parts}${r.case.note ? ` (${r.case.note})` : ""}`);
        }
      }
    }
  }
} finally {
  fx.cleanup();
}
