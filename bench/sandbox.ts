/**
 * Real-sandbox benchmark: does sandfit's forecast match what a real sandbox does?
 * Builds a policy from a small history, runs every probe in bench/sandbox-lib.ts under
 * Anthropic's sandbox-runtime, and compares.
 *
 *   npm run bench:sandbox      (needs bubblewrap + socat on Linux; network for the host checks)
 */
import { emptyModel, policyModel, PROBES, runProbes, sandboxWorks, setup, type ProbeResult } from "./sandbox-lib.js";

const env = await setup();
try {
  const works = sandboxWorks(env);
  if (!works.ok) {
    console.error(`sandbox-runtime could not start here, so there is nothing to measure:\n${works.out}`);
    process.exitCode = 1;
  } else {
    const withPolicy = runProbes(env, env.policyFile, policyModel(env));
    const empty = runProbes(env, env.emptyFile, emptyModel(env), PROBES.filter((p) => p.should === "allow"));
    const mark = (b: boolean) => (b ? "blocked" : "allowed");
    console.log(`\nReal sandbox: Anthropic sandbox-runtime on ${process.platform}${env.online ? "" : " (offline: network probes skipped)"}\n`);
    console.log("| Probe | Should be | Forecast | Real sandbox | Correct? | Forecast right? |");
    console.log("|---|---|---|---|:-:|:-:|");
    for (const r of withPolicy) {
      const correct = (r.probe.should === "block") === r.actuallyBlocked;
      console.log(`| \`${r.probe.cmd.replace(/\|/g, "\\|")}\` (${r.probe.why}) | ${r.probe.should === "block" ? "blocked" : "allowed"} | ${mark(r.predictedBlocked)} | ${mark(r.actuallyBlocked)} | ${correct ? "✓" : "✗"} | ${r.predictedBlocked === r.actuallyBlocked ? "✓" : "✗"} |`);
    }
    const agree = (rs: ProbeResult[]) => rs.filter((r) => r.predictedBlocked === r.actuallyBlocked).length;
    const correct = withPolicy.filter((r) => (r.probe.should === "block") === r.actuallyBlocked).length;
    const emptyBroken = empty.filter((r) => r.actuallyBlocked).length;
    console.log(`\n- With the sandfit policy, the sandbox did the right thing on **${correct} of ${withPolicy.length}** probes.`);
    console.log(`- sandfit's forecast matched the real sandbox on **${agree(withPolicy)} of ${withPolicy.length}** probes.`);
    console.log(`- With no configuration, **${emptyBroken} of ${empty.length}** things the history needed were blocked; the forecast for that sandbox matched on ${agree(empty)} of ${empty.length}.`);
    for (const r of [...withPolicy, ...empty].filter((x) => x.predictedBlocked !== x.actuallyBlocked)) {
      console.log(`\nMismatch: ${r.probe.cmd}\n  forecast=${mark(r.predictedBlocked)} real=${mark(r.actuallyBlocked)}\n  ${r.out.replace(/\n/g, "\n  ")}`);
    }
  }
} finally {
  env.cleanup();
}
