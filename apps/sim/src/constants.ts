// Simulator constants. Every number here is an INPUT to the simulator,
// not a measurement. Each carries its source, or says plainly that it is
// an assumption. docs/FORGE-BENCH.md renders this table; keep them in
// sync. All durations are minutes of simulated time.

import { DEFAULT_POLICY, type ForgePolicy } from "../../worker/src/intents-core.ts";

export interface DurationDist {
  median: number;
  sigma: number; // lognormal shape
}

// Git traffic model (SIMULATED counts of Cloudflare Artifacts git
// operations). Every field is an op count per event the simulator
// already models; the event -> op mapping is read from the shipped code
// where one exists (apps/sim/src/harness/git.ts, apps/worker/src/train.ts)
// and is an assumption otherwise. CONSTANT_SOURCES says which.
export type PollWindow = "whileWorking" | "untilLanded";

export interface GitOpModel {
  // --- per intent ---
  clonePerIntent: number; // agent clones once (depth 1)
  forkPerIntent: number; // fork modes (trains, forge): one fork per intent
  baselineFetchBeforePush: number; // baseline: pull --rebase before each push
  // --- rework / replay ---
  fetchPerRebase: number; // author fetches trunk to rebase (conflict, interaction, escalation; not a defect fix)
  fetchPerReplayAttempt: number; // replay fetches trunk + the intent fork, per attempt
  pushPerReplay: number; // a successful replay pushes the re-derived head
  fetchPerRestack: number; // a restack fetches the predecessor's current head
  // --- serial queue (baseline) ---
  queueFetchPerServe: number; // queue fetches trunk to build the merge SHA
  queuePushPerServe: number; // updated branch / merge ref pushed for CI
  baselineLandPush: number; // fast-forward main
  // --- train executor (trains, forge) ---
  trainFetchPerGroup: number; // build fetches trunk main
  trainFetchSpeculative: number; // + the speculative parent lane ref when stacked on an in-flight group
  trainFetchPerItem: number; // fetch each item's head from its fork (lower bound: deepening ignored)
  trainPushPerLane: number; // force-push each lane ref
  landFetch: number; // fastForwardMain fetches the lane ref
  landPush: number; // push main + push notes
  probeFetchBase: number; // a bisect probe fetches trunk ...
  probeFetchPerItem: number; // ... plus each item it carries
  probePush: number; // ... and pushes its probe ref
  // --- polling (PROJECTED, applied post-hoc; see pull.ts) ---
  pollIntervalsSec: number[]; // an agent runs git fetch every S seconds
  pollWindows: PollWindow[]; // while working (lower) .. until landed (upper)
  // Forge agents learn about trunk/peer changes from the Feed (events),
  // so they never poll. "poll" applies the projection to Forge too.
  forgeSync: "events" | "poll";
}

export interface SimConstants {
  // --- workload ---
  // All agents declare within this window (COMPETITION-PLAN §4 scale
  // math: "10k agents in 10 min"). The window stays fixed as N grows,
  // so larger N means a denser burst on the same repo.
  arrivalWindowMin: number;
  // Repo size in files. Fixed across N: the same monorepo gets busier
  // as the swarm grows (that contention is what the bench measures).
  repoFiles: number;
  // Files per directory (directories carry protected-path policy).
  filesPerDir: number;
  // Zipf exponent of file popularity (hot files: routes, configs).
  zipfS: number;
  // Declared footprint size: 1 + geometric extra files with this mean.
  footprintExtraMean: number;
  footprintMax: number;
  // Fraction of directories under protected policy paths.
  protectedDirFraction: number;
  // Agent edits an undeclared file (drift) with this probability.
  pDrift: number;

  // --- durations ---
  work: DurationDist; // agent implements the change
  ci: DurationDist; // one CI run (any batch size; trains run one suite)
  reviewLatency: DurationDist; // wall time until a human reviews
  rereviewLatency: DurationDist; // re-approval after a rebase
  planApprovalLatency: DurationDist; // protected-path plan approval
  replay: DurationDist; // one LLM replay attempt
  mergeMin: number; // serial queue: merge + push one PR
  trainMergeBaseMin: number; // train: merge step per lane
  trainMergePerItemMin: number; // train: per intent merged in a lane
  reworkFactor: number; // author rebase/fix redoes this fraction of work

  // --- probabilities ---
  // Textual conflict probability per shared file changed on trunk since
  // the intent's base (or merged earlier in the same lane).
  pConflictPerSharedFile: number;
  pDefect: number; // change carries a real bug
  pDefectCaught: number; // CI catches it (else it escapes to trunk)
  pInteraction: number; // passes own CI, fails combined with trunk
  pFlake: number; // a CI run goes red with no real defect
  pWeakEvidence: number; // risk term: CI evidence weak
  pReviewerDisagrees: number; // risk term: clean-context reviewer disagrees
  replaySuccess: number; // LLM conflict replay success rate
  mttrMin: number; // escaped defect: red main until revert

  // --- Forge planner ---
  // A declared intent with live overlaps gets after: edges to them and
  // waits at most this long for each predecessor to push a CI-green
  // head, then stacks on it (forks from it). Predecessors not ready by
  // then are dropped and the intent works in parallel.
  afterWaitMaxMin: number;
  // Ready-queue scan bound per train cut (keeps cuts O(1) at 100k).
  cutScanLimit: number;

  // --- serial baseline ---
  maxRebases: number; // author gives up after this many conflict bounces
  maxFixes: number; // ... or this many CI-failure fixes
  maxConflicts: number; // lifetime conflicts before an intent is abandoned

  // --- human cost per item (minutes of human attention) ---
  reviewMin: number;
  rereviewMin: number;
  planApprovalMin: number;
  auditMin: number;
  escalationMin: number;

  // --- Artifacts git op model (all three modes run on Artifacts) ---
  git: GitOpModel;
  dollarsPer1kOps: number;
  // DESIGN, NOT SHIPPED: a Forge train that caches each item's fork
  // fetch across speculative rebuilds (an item re-cut at the same
  // version is not refetched) and replays that fetch trunk once
  // (fetchPerReplayAttempt 1). Off by default; Forge mode only.
  forgeFetchCache: boolean;

  // Train groups in flight at once for the trains-only mode. 1 = the
  // pre-speculation executor (one group per repo at a time). Forge mode
  // uses policy.lanes.speculationDepth (the shipped default).
  trainsSpeculationDepth: number;

  policy: ForgePolicy;
}

export const PROTECTED_GLOBS = ["src/auth/**", "migrations/**"];

export const DEFAULT_CONSTANTS: SimConstants = {
  arrivalWindowMin: 10,
  repoFiles: 100_000,
  filesPerDir: 20,
  zipfS: 0.7,
  footprintExtraMean: 1.5,
  footprintMax: 12,
  protectedDirFraction: 0.02,
  pDrift: 0.1,

  work: { median: 8, sigma: 0.6 },
  ci: { median: 10, sigma: 0.3 },
  reviewLatency: { median: 30, sigma: 0.8 },
  rereviewLatency: { median: 15, sigma: 0.8 },
  planApprovalLatency: { median: 30, sigma: 0.8 },
  replay: { median: 3, sigma: 0.5 },
  mergeMin: 0.5,
  trainMergeBaseMin: 0.5,
  trainMergePerItemMin: 0.02,
  reworkFactor: 0.5,

  pConflictPerSharedFile: 0.35,
  pDefect: 0.05,
  pDefectCaught: 0.9,
  pInteraction: 0.02,
  pFlake: 0.05,
  pWeakEvidence: 0.15,
  pReviewerDisagrees: 0.06,
  replaySuccess: 0.6,
  mttrMin: 30,

  afterWaitMaxMin: 15,
  cutScanLimit: 2_000,

  maxRebases: 3,
  maxFixes: 3,
  maxConflicts: 8,

  reviewMin: 10,
  rereviewMin: 3,
  planApprovalMin: 5,
  auditMin: 5,
  escalationMin: 10,

  git: {
    clonePerIntent: 1,
    forkPerIntent: 1,
    baselineFetchBeforePush: 1,
    fetchPerRebase: 1,
    fetchPerReplayAttempt: 2,
    pushPerReplay: 1,
    fetchPerRestack: 1,
    queueFetchPerServe: 1,
    queuePushPerServe: 1,
    baselineLandPush: 1,
    trainFetchPerGroup: 1,
    trainFetchSpeculative: 1,
    trainFetchPerItem: 1,
    trainPushPerLane: 1,
    landFetch: 1,
    landPush: 2,
    probeFetchBase: 1,
    probeFetchPerItem: 1,
    probePush: 1,
    pollIntervalsSec: [30, 60, 300],
    pollWindows: ["whileWorking", "untilLanded"],
    forgeSync: "events",
  },
  dollarsPer1kOps: 0.15,
  forgeFetchCache: false,

  trainsSpeculationDepth: 1,

  policy: { ...DEFAULT_POLICY, protected: PROTECTED_GLOBS },
};

// Source notes rendered into docs/FORGE-BENCH.md. "assumption" means no
// external measurement backs the number; it is a tunable input.
export const CONSTANT_SOURCES: Record<string, string> = {
  arrivalWindowMin: "COMPETITION-PLAN.md §4 scale math (10k agents in 10 min)",
  repoFiles: "assumption (a large monorepo)",
  zipfS: "assumption; calibrated so ~22% of intents overlap a live intent at 1k agents (51% at 10k, 75% at 100k)",
  pDrift: "assumption",
  work: "assumption (agent session, median 8 min)",
  ci: "assumption (median 10 min suite)",
  reviewLatency: "assumption; reviewers modeled as unlimited (favors the baselines)",
  pConflictPerSharedFile: "assumption; overlap is necessary, not sufficient, for a textual conflict",
  pFlake: "assumption (per CI run); Google reports ~1.5% of test runs flaky (2016 testing blog)",
  pDefect: "assumption (reaches CI with a real bug; 90% caught by the intent's own CI)",
  pInteraction: "assumption (semantic conflict caught only on the combined SHA)",
  replaySuccess: "Merge-Bench (COMPETITION-PLAN.md §13), default 0.6",
  mttrMin: "assumption (detect + revert)",
  afterWaitMaxMin: "assumption (planner wait budget)",
  reviewMin: "assumption (human minutes per small agent PR)",
  policy: "DEFAULT_POLICY from intents-core.ts (lanes 50 per group x 8 parallel, speculation depth 3) + protected src/auth/**, migrations/**",
  trainsSpeculationDepth: "1: trains-only models the pre-speculation executor (one group in flight per repo)",
  dollarsPer1kOps: "Artifacts pricing page ($0.15 / 1,000 ops; names create, push, pull, clone as examples); checked 2026-10-12",
  forgeFetchCache: "design, not shipped: train caches item fork fetches across speculative rebuilds; replays fetch trunk once",
  "git.clonePerIntent": "apps/sim/src/harness/git.ts (clone depth=1, once per intent)",
  "git.forkPerIntent": "Forge claim_intent forks once per intent (trains + forge modes); the baseline works on branches of the same repo",
  "git.baselineFetchBeforePush": "assumption: baseline agent runs pull --rebase before every push",
  "git.fetchPerRebase": "assumption: one trunk fetch per author rebase (conflict, interaction fix, escalation); a defect fix needs none",
  "git.fetchPerReplayAttempt": "train/replay code fetches trunk + the intent fork per attempt (2); 1 with forgeFetchCache",
  "git.pushPerReplay": "a successful replay pushes the re-derived head once",
  "git.fetchPerRestack": "assumption: a restack fetches the predecessor's current head once",
  "git.queueFetchPerServe": "assumption: the serial queue fetches trunk once per serve (bounces included)",
  "git.queuePushPerServe": "assumption: the queue pushes the updated branch / merge ref for CI",
  "git.baselineLandPush": "assumption: fast-forward main = one push",
  "git.trainFetchPerGroup": "apps/worker/src/train.ts buildGroup: fetchCovering(main) once per group (+1 for the speculative parent lane ref)",
  "git.trainFetchPerItem": "apps/worker/src/train.ts buildGroup: one fork fetch per item; LOWER BOUND (fetchCovering deepening retries ignored)",
  "git.trainPushPerLane": "apps/worker/src/train.ts: force-push each lane ref",
  "git.landPush": "apps/worker/src/train.ts fastForwardMain: fetch lane ref 1, push main + push notes 2 (plus an ls-remote, reported apart)",
  "git.probe": "train-core bisect probes: fetch trunk 1 + each item 1, push the probe ref 1",
  "git.pollIntervalsSec": "assumption: projected agent poll intervals (git fetch every 30 / 60 / 300 s)",
  "git.pollWindows": "assumption: polls while working (lower bound) .. until landed or abandoned (upper bound); applied post-hoc, so fresher agents are NOT modelled as conflicting less",
  "git.forgeSync": "Forge agents sync from Feed events: 0 polls",
  "git.lsRemote/token": "ls-remote and token mints counted apart: Artifacts billing for them is undocumented",
};
