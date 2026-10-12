import { describe, expect, it } from "vitest";
import { DEFAULT_CONSTANTS } from "./constants";
import { bisect, partitionLanes } from "../../worker/src/intents-core";
import { lognormal, mulberry32, percentile, rngFor, zipf } from "./prng";
import { BILLABLE_GIT_KINDS, EventQueue, MODES, simulate, unionLength } from "./sim";
import { pollFetches, pullBreakdown } from "./pull";
import { filePathFor, generateWorkload } from "./workload";
import { formatMarkdown, formatMinutes, formatPullCurve, formatTable, pullCurve, toBenchDoc } from "./report";

// These suites spawn real git processes (or run the full simulator), which
// can exceed vitest's 5 s default on a loaded machine.
const SLOW_TEST_MS = 60_000;

describe("prng", () => {
  it("is deterministic per seed and label", () => {
    const a = rngFor(7, "x");
    const b = rngFor(7, "x");
    const c = rngFor(7, "y");
    const xs = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(xs);
    expect(c.next()).not.toBe(xs[0]);
  });

  it("zipf masses sum to 1 and rank 0 is hottest", () => {
    const z = zipf(1000, 0.7);
    let s = 0;
    for (let r = 0; r < 1000; r++) s += z.mass(r);
    expect(s).toBeCloseTo(1, 9);
    const rng = mulberry32(1);
    const hits = Array.from({ length: 1000 }, () => 0);
    for (let i = 0; i < 20000; i++) hits[z.sample(rng)]++;
    expect(hits[0]).toBeGreaterThan(hits[500]);
  });

  it("lognormal median is roughly the median", () => {
    const rng = mulberry32(3);
    const xs = Array.from({ length: 4001 }, () => lognormal(rng, 10, 0.5)).sort((a, b) => a - b);
    expect(percentile(xs, 0.5)).toBeGreaterThan(9);
    expect(percentile(xs, 0.5)).toBeLessThan(11);
  });
});

describe("event queue + helpers", () => {
  it("runs events in time order, FIFO on ties", () => {
    const q = new EventQueue();
    const seen: string[] = [];
    q.at(5, () => seen.push("b"));
    q.at(1, () => {
      seen.push("a");
      q.at(5, () => seen.push("c"));
    });
    q.at(5, () => seen.push("b2"));
    q.run();
    expect(seen).toEqual(["a", "b", "b2", "c"]);
  });

  it("unionLength merges overlapping intervals", () => {
    expect(unionLength([])).toBe(0);
    expect(
      unionLength([
        [0, 10],
        [5, 15],
        [20, 25],
      ]),
    ).toBe(20);
  });

  it("formats durations", () => {
    expect(formatMinutes(42)).toBe("42m");
    expect(formatMinutes(125)).toBe("2h 5m");
    expect(formatMinutes(60 * 24 * 3 + 60)).toBe("3d 1h");
    expect(formatMinutes(null)).toBe("n/a");
  });
});

describe("workload", () => {
  it("is identical for the same seed and puts some files under protected paths", () => {
    const a = generateWorkload(300, 11, DEFAULT_CONSTANTS);
    const b = generateWorkload(300, 11, DEFAULT_CONSTANTS);
    expect(a.intents.map((i) => i.footprint.paths.join(","))).toEqual(b.intents.map((i) => i.footprint.paths.join(",")));
    expect(a.overlapAtDeclare).toBe(b.overlapAtDeclare);
    const paths = Array.from({ length: 4000 }, (_, i) => filePathFor(i, DEFAULT_CONSTANTS));
    expect(paths.some((p) => p.startsWith("src/auth/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("migrations/"))).toBe(true);
    for (const it of a.intents) {
      expect(it.footprint.paths.length).toBeGreaterThan(0);
      expect(it.declareAt).toBeLessThanOrEqual(DEFAULT_CONSTANTS.arrivalWindowMin);
    }
  });

  it("footprints feed the shipped lane partitioner", () => {
    const w = generateWorkload(200, 5, DEFAULT_CONSTANTS);
    const lanes = partitionLanes(w.intents.map((i) => ({ id: i.id, footprint: i.footprint })));
    expect(lanes.flat().length).toBe(200);
    expect(bisect([1, 2, 3])).toEqual([[1, 2], [3]]);
  });
});

describe("simulate", { timeout: SLOW_TEST_MS }, () => {
  const run = simulate({ agents: 400, seed: 7, now: () => 0 });
  const by = Object.fromEntries(run.modes.map((m) => [m.mode, m]));

  it("runs all three modes over the same workload", () => {
    expect(run.modes.map((m) => m.mode)).toEqual([...MODES]);
    for (const m of run.modes) {
      // Every intent ends landed or abandoned (the sim drains).
      expect(m.landed + m.abandoned).toBe(400);
      expect(m.landed).toBeGreaterThan(0);
      expect(m.declareToLandP95Min).toBeGreaterThanOrEqual(m.declareToLandP50Min);
      expect(m.ciRuns).toBeGreaterThan(0);
    }
  });

  it("is deterministic for a seed", () => {
    const again = simulate({ agents: 400, seed: 7, now: () => 0 });
    expect(again).toEqual(run);
    const other = simulate({ agents: 400, seed: 8, now: () => 0 });
    expect(other.modes[2].declareToLandP50Min).not.toBe(run.modes[2].declareToLandP50Min);
  });

  it("keeps mode-specific mechanics where they belong", () => {
    expect(by.baseline.trains).toBe(0);
    // The baseline is the PR flow on the same Artifacts repo: real git ops,
    // branches instead of forks.
    expect(by.baseline.artifactsOps).toBeGreaterThan(0);
    expect(by.baseline.git.fork).toBe(0);
    expect(by.baseline.git.clone).toBe(400 * DEFAULT_CONSTANTS.git.clonePerIntent);
    expect(by.trains.trains).toBeGreaterThan(0);
    for (const m of [by.baseline, by.trains]) {
      expect(m.conflictsAvoided).toBe(0);
      expect(m.replaysAttempted).toBe(0);
      expect(m.routes).toEqual({ auto: 0, audit: 0, human: 0 });
      // Every PR is human-reviewed once.
      expect(m.human.review).toBe(400 * DEFAULT_CONSTANTS.reviewMin);
    }
    // Forge routes every verified change and reviews only the human route.
    const f = by.forge;
    expect(f.routes.auto + f.routes.audit + f.routes.human).toBeGreaterThanOrEqual(f.landed);
    expect(f.human.review).toBeLessThan(by.trains.human.review);
    expect(f.humanReviewMin).toBeLessThan(by.baseline.humanReviewMin);
  });

  it("every mode lands only exact verified states: no integration red, no unverified landing", () => {
    for (const m of run.modes) {
      expect(m.unverifiedLandings).toBe(0);
      expect(m.mainRedIntegrationMin).toBe(0);
    }
  });

  it("Forge speculates (groups cut on in-flight groups); trains-only (depth 1) never does", () => {
    expect(by.trains.speculativeGroups).toBe(0);
    expect(by.forge.speculativeGroups).toBeGreaterThan(0);
  });

  it("trains out-ship the serial queue", () => {
    expect(by.trains.landedPerMin).toBeGreaterThan(by.baseline.landedPerMin);
    expect(by.forge.landedPerMin).toBeGreaterThan(by.baseline.landedPerMin);
  });

  it("with no overlap there are no conflicts, and no defects means no red main", () => {
    const quiet = simulate({
      agents: 120,
      seed: 3,
      now: () => 0,
      constants: { zipfS: 0, repoFiles: 1_000_000, pDrift: 0, pDefect: 0, pInteraction: 0, pFlake: 0 },
    });
    for (const m of quiet.modes) {
      expect(m.abandoned).toBe(0);
      expect(m.escapedDefectMin).toBe(0);
      expect(m.mainRedIntegrationMin).toBe(0);
      expect(m.flakeReruns).toBe(0);
    }
  });

  it("serializes hot files: everyone on one file still drains", () => {
    const hot = simulate({ agents: 60, seed: 9, now: () => 0, constants: { repoFiles: 1, footprintExtraMean: 0, pDrift: 0 } });
    for (const m of hot.modes) expect(m.landed + m.abandoned).toBe(60);
    const forge = hot.modes[2];
    expect(forge.stackedIntents).toBeGreaterThan(0);
    expect(forge.conflictsAvoided).toBeGreaterThan(0);
  });

  it("produces the bench document contract and a labelled table", () => {
    const doc = toBenchDoc(run, { sha: "abc1234", date: "2026-10-10", command: "test" });
    expect(doc).toMatchObject({ run: "sim-s7-n400", measured_at: "2026-10-10", sha: "abc1234", simulated: true, kind: "simulated" });
    expect(doc.modes).toHaveLength(3);
    for (const row of doc.modes) {
      expect(row.projected).toBe(false);
      expect(row.simulated).toBe(true);
      expect(typeof row.metrics.changes_per_min).toBe("number");
    }
    expect(doc.modes[0].metrics.dollars_per_1k_agents).toBeGreaterThan(0);
    expect(doc.modes[0].metrics.poll_projection.map((p) => p.interval_s)).toEqual(DEFAULT_CONSTANTS.git.pollIntervalsSec);
    const table = formatTable(doc);
    expect(table.split("\n")[0]).toContain("SIMULATED");
    expect(formatMarkdown(doc).split("\n")).toHaveLength(5);
    expect(doc.modes[2].metrics.time_to_80pct_landed_min).not.toBeNull();
  });

  it("pull model: billable kinds sum to artifactsOps; ls-remote and tokens stay apart", () => {
    for (const m of run.modes) {
      const billable = BILLABLE_GIT_KINDS.reduce((a, k) => a + m.git[k], 0);
      expect(billable).toBe(m.artifactsOps);
      expect(m.artifactsDollars).toBeCloseTo((billable / 1000) * DEFAULT_CONSTANTS.dollarsPer1kOps, 9);
      expect(m.git.push).toBeGreaterThanOrEqual(m.landed);
      expect(m.lifeMin).toBeGreaterThan(m.workMinSum * 0.5);
    }
    expect(by.trains.git.fork).toBe(400);
    expect(by.forge.git.fork).toBe(400);
    expect(by.baseline.git.lsRemote).toBe(0);
    expect(by.forge.git.lsRemote).toBeGreaterThan(0);
    expect(by.forge.git.token).toBeGreaterThan(0);
  });

  it("pull model: Forge syncs by events (0 polls), the PR flow polls", () => {
    const opts = { pollIntervalsSec: [30, 300], dollarsPer1kOps: 0.15 };
    const f = pullBreakdown(by.forge, opts);
    expect(by.forge.sync).toBe("events");
    for (const p of f.polls) {
      expect(p.while_working.polls_per_landed).toBe(0);
      expect(p.until_landed.polls_per_landed).toBe(0);
      expect(p.until_landed.ops_per_landed).toBe(f.billable_per_landed);
    }
    const b = pullBreakdown(by.baseline, opts);
    expect(b.polls[0].while_working.polls_per_landed).toBeGreaterThan(0);
    expect(b.polls[0].until_landed.ops_per_landed).toBeGreaterThan(b.polls[0].while_working.ops_per_landed);
    // A longer interval polls less.
    expect(b.polls[1].until_landed.polls_per_landed).toBeLessThan(b.polls[0].until_landed.polls_per_landed);
    expect(pollFetches(10, 30)).toBe(20);
    expect(pollFetches(10, 0)).toBe(0);
    // forgeSync "poll" applies the projection to Forge too.
    const polled = simulate({ agents: 40, seed: 7, now: () => 0, modes: ["forge"], constants: { git: { ...DEFAULT_CONSTANTS.git, forgeSync: "poll" } } });
    expect(polled.modes[0].sync).toBe("poll");
    expect(pullBreakdown(polled.modes[0], opts).polls[0].until_landed.polls_per_landed).toBeGreaterThan(0);
  });

  it("pull model: baseline poll-until-landed ops per change rise with swarm size", () => {
    const opts = { pollIntervalsSec: [60], dollarsPer1kOps: 0.15 };
    const at = (n: number): number =>
      pullBreakdown(simulate({ agents: n, seed: 7, now: () => 0, modes: ["baseline"] }).modes[0], opts).polls[0].until_landed.ops_per_landed;
    const small = at(40);
    const large = pullBreakdown(by.baseline, opts).polls[0].until_landed.ops_per_landed; // 400 agents
    expect(large).toBeGreaterThan(small);
    expect(at(40)).toBe(small); // deterministic for a seed
  });

  it("forgeFetchCache (design) cuts Forge fetches and nothing else", () => {
    const cached = simulate({ agents: 400, seed: 7, now: () => 0, modes: ["forge"], constants: { forgeFetchCache: true } }).modes[0];
    expect(cached.git.fetch).toBeLessThan(by.forge.git.fetch);
    expect(cached.git.push).toBe(by.forge.git.push);
    expect(cached.landed).toBe(by.forge.landed);
    // Trains-only ignores the Forge-only knob.
    const t = simulate({ agents: 400, seed: 7, now: () => 0, modes: ["trains"], constants: { forgeFetchCache: true } }).modes[0];
    expect(t.git).toEqual(by.trains.git);
  });

  it("formats the N x mode pull curve with labels", () => {
    const doc = toBenchDoc(run, { sha: "abc1234", date: "2026-10-12", command: "test" });
    const rows = pullCurve([doc]);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const k = r.git_ops_per_landed;
      expect(k.fork + k.clone + k.fetch + k.push).toBeCloseTo(r.billable_ops_per_landed, 2);
    }
    const text = formatPullCurve([doc]);
    expect(text).toContain("SIMULATED git ops per landed change");
    expect(text).toContain("PROJECTED");
    expect(text).toContain("(events, 0 polls)");
    expect(formatPullCurve([doc], { markdown: true })).toContain("| N | Mode |");
  });
});
