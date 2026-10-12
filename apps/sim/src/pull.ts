// Pull model (pure): how Artifacts git traffic scales with swarm size.
//
// Three labels, kept apart everywhere this prints:
//   - SIMULATED: git ops by kind counted by sim.ts at the events it
//     models (clone, fork, pushes, rebases, replays, train builds,
//     landings, probes), under the op model in constants.ts `git`.
//   - PROJECTED: polling. An agent with no event feed runs `git fetch`
//     every S seconds. Applied post-hoc over two windows: while it works
//     (lower bound) and until its change lands or is abandoned (upper
//     bound). Post-hoc means the simulator does NOT make polling agents
//     fresher, so they don't conflict less here (an assumption that
//     favors Forge slightly).
//   - Forge agents sync from Feed events: 0 polls (constants.git.forgeSync).
//
// Billable kinds: fork, clone, fetch, push (the pricing page names
// create, push, pull, clone as examples). ls-remote and token mints are
// reported apart as "billing undocumented".

import { BILLABLE_GIT_KINDS, type GitOps, type ModeMetrics } from "./sim.ts";

export type BillableKind = (typeof BILLABLE_GIT_KINDS)[number];

// Expected `git fetch` calls over `minutes` at one fetch per
// `intervalSec` (continuous: the mean over many agents).
export function pollFetches(minutes: number, intervalSec: number): number {
  if (!(intervalSec > 0) || !(minutes > 0)) return 0;
  return (minutes * 60) / intervalSec;
}

export interface PollWindowProjection {
  polls_per_landed: number; // polling fetches alone
  ops_per_landed: number; // simulated billable ops + polls
  usd_per_10k_changes: number;
}

export interface PollProjection {
  interval_s: number;
  // "events": the mode syncs from the Feed; both windows add 0 polls.
  sync: "events" | "poll";
  while_working: PollWindowProjection;
  until_landed: PollWindowProjection;
}

export interface PullBreakdown {
  landed: number;
  // SIMULATED, per landed change.
  ops_per_landed: Record<BillableKind, number>;
  billable_per_landed: number;
  binding_per_landed: { ls_remote: number; token: number };
  usd_per_10k_changes: number;
  // Mean minutes an intent spent in the system / working.
  mean_min_in_system: number;
  mean_work_min: number;
  // PROJECTED, one entry per poll interval.
  polls: PollProjection[];
}

export function billableOps(git: GitOps): number {
  let n = 0;
  for (const k of BILLABLE_GIT_KINDS) n += git[k];
  return n;
}

export function usdPer10k(opsPerLanded: number, dollarsPer1kOps: number): number {
  return (opsPerLanded * 10_000 * dollarsPer1kOps) / 1000;
}

type PullMetrics = Pick<ModeMetrics, "landed" | "abandoned" | "git" | "lifeMin" | "workMinSum" | "sync">;

export function pullBreakdown(m: PullMetrics, opts: { pollIntervalsSec: readonly number[]; dollarsPer1kOps: number }): PullBreakdown {
  const L = Math.max(1, m.landed);
  const ended = Math.max(1, m.landed + m.abandoned);
  const billable = billableOps(m.git) / L;
  const window = (minutes: number, s: number): PollWindowProjection => {
    const polls = m.sync === "events" ? 0 : pollFetches(minutes, s) / L;
    return { polls_per_landed: polls, ops_per_landed: billable + polls, usd_per_10k_changes: usdPer10k(billable + polls, opts.dollarsPer1kOps) };
  };
  return {
    landed: m.landed,
    ops_per_landed: { fork: m.git.fork / L, clone: m.git.clone / L, fetch: m.git.fetch / L, push: m.git.push / L },
    billable_per_landed: billable,
    binding_per_landed: { ls_remote: m.git.lsRemote / L, token: m.git.token / L },
    usd_per_10k_changes: usdPer10k(billable, opts.dollarsPer1kOps),
    mean_min_in_system: m.lifeMin / ended,
    mean_work_min: m.workMinSum / ended,
    polls: opts.pollIntervalsSec.map((s) => ({
      interval_s: s,
      sync: m.sync,
      while_working: window(m.workMinSum, s),
      until_landed: window(m.lifeMin, s),
    })),
  };
}
