/**
 * End-to-end check against a REAL sandbox: Anthropic's sandbox-runtime (srt), which uses
 * Seatbelt on macOS and bubblewrap on Linux. It proves two things:
 *   1. the srt config sandfit emits means what sandfit thinks it means, and
 *   2. sandfit's forecast agrees with what the sandbox actually does, probe by probe.
 *
 * Run with: npm run test:sandbox   (network is used for the domain probes when available)
 * The probes live in bench/sandbox-lib.ts; `npm run bench:sandbox` prints them as a table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANARY, emptyModel, policyModel, PROBES, runProbes, sandboxWorks, setup, srt, type Env } from "../../bench/sandbox-lib.js";

const enabled = !!process.env.SANDFIT_REAL_SANDBOX;

describe.skipIf(!enabled)("real sandbox: Anthropic sandbox-runtime", () => {
  let env: Env;

  beforeAll(async () => {
    env = await setup();
    // If the sandbox itself cannot start, every "blocked" check would pass for the wrong reason.
    const works = sandboxWorks(env);
    if (!works.ok) throw new Error(`sandbox-runtime could not start, so these tests would prove nothing:\n${works.out}`);
  }, 60_000);
  afterAll(() => env?.cleanup());

  it("with the sandfit policy, every probe is allowed or blocked as it should be", () => {
    const results = runProbes(env, env.policyFile, policyModel(env));
    const wrong = results.filter((r) => (r.probe.should === "block") !== r.actuallyBlocked).map((r) => `${r.probe.cmd}: ${r.out}`);
    expect(wrong).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(PROBES.filter((p) => !p.net).length);
  }, 120_000);

  it("the forecast matches the real sandbox, probe by probe", () => {
    const results = [...runProbes(env, env.policyFile, policyModel(env)), ...runProbes(env, env.emptyFile, emptyModel(env))];
    const mismatches = results.filter((r) => r.predictedBlocked !== r.actuallyBlocked).map((r) => `${r.probe.cmd} predicted=${r.predictedBlocked} actual=${r.actuallyBlocked}: ${r.out}`);
    expect(mismatches).toEqual([]);
  }, 240_000);

  it("planted secrets never come out", () => {
    for (const cmd of ["cat ~/.ssh/id_rsa", "cat .env", "cat ~/.aws/credentials", "base64 < .env.local"]) {
      expect(srt(env, cmd, env.policyFile).out).not.toContain(CANARY);
    }
  }, 60_000);

  it("the sandbox with no configuration breaks what the history needed", () => {
    const results = runProbes(env, env.emptyFile, emptyModel(env), PROBES.filter((p) => p.should === "allow"));
    expect(results.filter((r) => r.actuallyBlocked).length).toBeGreaterThanOrEqual(env.online ? 4 : 2);
  }, 120_000);
});
