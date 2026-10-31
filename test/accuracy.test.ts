import { afterAll, describe, expect, it } from "vitest";
import { makeFixture, precision, recall, scoreCorpus } from "../bench/accuracy-lib.js";
import { CORPUS } from "../bench/corpus.js";
import { HOLDOUT } from "../bench/corpus-holdout.js";

// Guards the numbers published in BENCHMARKS.md: a change that makes sandfit worse at
// working out what commands need fails here.
const fx = makeFixture();
afterAll(() => fx.cleanup());

describe("accuracy on labelled commands", () => {
  it("tuning set: no wrong grants, at most the known limits missed", () => {
    const s = scoreCorpus(CORPUS, fx);
    const missed = s.results.filter((r) => r.missed.length || r.extra.length).map((r) => r.case.cmd);
    expect(missed.every((cmd) => CORPUS.find((c) => c.cmd === cmd)?.note?.startsWith("known limit"))).toBe(true);
    expect(precision(s.total)).toBe(1);
  });

  it("holdout set stays at or above the published level", () => {
    const s = scoreCorpus(HOLDOUT, fx);
    expect(precision(s.total)).toBeGreaterThanOrEqual(0.95);
    expect(recall(s.total)).toBeGreaterThanOrEqual(0.95);
  });

  it("every label is well formed", () => {
    for (const c of [...CORPUS, ...HOLDOUT]) {
      for (const l of [...c.expect, ...(c.optional ?? [])]) expect(l).toMatch(/^(net|write|bind|exec|secret):\S/);
      expect(c.expect.filter((l) => c.optional?.includes(l))).toEqual([]);
    }
    expect(new Set(CORPUS.map((c) => c.cmd)).size).toBe(CORPUS.length);
  });
});
