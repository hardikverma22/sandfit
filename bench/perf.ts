/**
 * Performance benchmark: how long does sandfit take on a large history?
 * Generates synthetic transcripts (bench/synth.ts) and times each stage of the pipeline.
 *
 *   npm run bench:perf                    1k, 10k and 100k tool calls
 *   npm run bench:perf -- --sizes 1000,5000
 *   npm run bench:perf -- --json
 */
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { analyze } from "../src/extract/extract.js";
import { defaultModel, forecast, modelFromPolicy } from "../src/forecast.js";
import { ingest } from "../src/ingest/index.js";
import { buildPolicy, projectRootsOf } from "../src/policy/build.js";
import { synthesize } from "./synth.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sizes = (arg("--sizes") ?? "1000,10000,100000").split(",").map(Number);
const json = process.argv.includes("--json");
const HOME = "/home/bench";

interface Row {
  toolCalls: number;
  files: number;
  mb: number;
  ingestMs: number;
  analyzeMs: number;
  buildMs: number;
  forecastMs: number;
  totalMs: number;
  callsPerSec: number;
  peakRssMb: number;
}

async function time<T>(fn: () => T | Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

const rows: Row[] = [];
for (const n of sizes) {
  const dir = mkdtempSync(join(tmpdir(), "sandfit-perf-"));
  try {
    const { files, bytes } = synthesize({ dir, toolCalls: n });
    global.gc?.();
    let peak = process.memoryUsage().rss;
    const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
    const [ing, ingestMs] = await time(() => ingest({ claudeDir: join(dir, "claude"), codexDir: join(dir, "codex") }));
    const [analyzed, analyzeMs] = await time(() => analyze(ing.events, { home: HOME, readGitRemotes: false }));
    const projects = projectRootsOf(analyzed, HOME);
    const [policy, buildMs] = await time(() => buildPolicy(analyzed, { home: HOME, projects }));
    const [, forecastMs] = await time(() => {
      forecast(analyzed, defaultModel(projects), HOME);
      forecast(analyzed, modelFromPolicy(policy, "claude", HOME, projects), HOME);
    });
    clearInterval(sample);
    peak = Math.max(peak, process.memoryUsage().rss);
    const totalMs = ingestMs + analyzeMs + buildMs + forecastMs;
    rows.push({
      toolCalls: ing.events.length,
      files,
      mb: bytes / 1e6,
      ingestMs,
      analyzeMs,
      buildMs,
      forecastMs,
      totalMs,
      callsPerSec: ing.events.length / (totalMs / 1000),
      peakRssMb: peak / 1e6,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (json) console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, rows }, null, 2));
else {
  const f = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
  console.log(`\nNode ${process.version} · ${cpus()[0]?.model ?? "unknown CPU"} · ${cpus().length} cores\n`);
  console.log("| Tool calls | Transcript size | Read files | Work out needs | Build policy | Forecast (×2) | Total | Tool calls/s | Peak memory |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(`| ${r.toolCalls.toLocaleString("en-US")} | ${r.mb.toFixed(0)} MB in ${r.files} files | ${f(r.ingestMs)} | ${f(r.analyzeMs)} | ${f(r.buildMs)} | ${f(r.forecastMs)} | **${f(r.totalMs)}** | ${Math.round(r.callsPerSec).toLocaleString("en-US")} | ${Math.round(r.peakRssMb)} MB |`);
  }
}
