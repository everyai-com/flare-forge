# Forge bench: simulator and live harness

> Provenance: agent-drafted on 2026-10-10 (stream G), revised the same
> day for speculative stacked trains (branch `feat/forge-speculative`).
> Every number in section 2 is **SIMULATED**: the output of
> `apps/sim/src/sim.ts` under the constants listed below. The main
> tables come from
> `node --experimental-strip-types scripts/forge-bench.mjs --agents 1000,10000,100000 --seed 7 --json`
> run on 2026-10-10 at commit `7b37655` (raw output:
> `docs/bench/forge-sim-seed7.json`). Each sensitivity row names its
> own command; all were run on 2026-10-10 at `7b37655` (`0eee91b` for
> the `--p-interaction` row; the simulator code is identical between
> the two). The "before" column quotes the previous revision of this
> file (commit `94bf9ae`, a different model; see 2.1). No live
> (measured) run has been done yet. Section 3 says how to do one.

COMPETITION-PLAN §5 asks for the same workload to be run three ways,
with the results reported side by side. The bench has two layers, and
each is labelled everywhere it prints:

| Layer | What | Label |
|---|---|---|
| 1. Simulator | `apps/sim/src/sim.ts`: a deterministic discrete-event model of N agents. It is pure TypeScript and makes no network calls. | **SIMULATED** |
| 2. Live harness | The `apps/sim` Worker. `AgentPool` Durable Objects drive the real Forge REST API of a deployment. | **MEASURED** |

The simulator calls the shipped Forge logic. From
`apps/worker/src/intents-core.ts`: `footprintsOverlap` for the
declare-time overlap query, `scoreRisk` plus `routeLanding` for review
routing. From `apps/worker/src/train-core.ts`, the **train executor
itself**: `planTrain` cuts groups, and `SpeculativeChain` (built on
`cutCapacity`, `decideChain`, `bisectStep` and `freeProbeSlots`) decides
every landing, invalidation and bisect probe — the same functions the
Worker's `train.ts` applies to D1 rows. Change those functions and the
bench changes with them. The simulator adds only time and randomness.

## 1. Methodology (simulator)

### Workload (identical across the three modes)

- **Agents and declare times.** N agents, one intent each. Every agent
  declares at a uniform-random time inside a 10-minute window. This is
  the "10k agents in 10 min" burst from plan §4. The window stays fixed
  as N grows, so larger N means a denser burst on the same repo.
- **Repo.** 100,000 files in directories of 20. 2% of directories sit
  under the protected globs `src/auth/**` and `migrations/**`.
- **Footprint.** Each intent declares 1 file plus geometric extra files
  (mean 1.5 extra, capped at 12). Files are drawn **Zipf(s = 0.7)** by
  popularity, and the popularity ranks are shuffled across directories,
  so some hot files are protected and most are not.
- **Overlap.** The exponent is calibrated so that about 21% of intents
  overlap a live intent at 1k agents. The share rises to 50% at 10k and
  83% at 100k: that growing contention is what the bench measures.
- **Drift.** 10% of intents also touch one undeclared file. The
  declare-time query can't see that file.
- **Per-intent draws.** Each intent gets fixed draws for work time,
  defect (none / caught by its own CI / escaped), interaction defect
  (fails only on a combined SHA that contains it), weak CI evidence,
  reviewer disagreement, review latency and plan latency. All of them
  come from seeded PRNG streams (`mulberry32`, with a separate stream
  per concern). The same seed gives byte-identical results; the test
  `simulate › is deterministic for a seed` checks this.

### The train executor (trains-only and Forge)

Both train modes run the shipped executor through `SpeculativeChain`:

1. **Cut.** While `cutCapacity` allows (a free speculation level and a
   free lane ref), a group is cut with `planTrain`: queue order, at
   most `max_per_train` (50) intents, overlap components on the
   declared footprint packed into at most `max_parallel` (8) lanes.
2. **Build.** Lanes are stacked: lane *i* is built on lane *i−1*'s head,
   and a speculative group's first lane on the chain head. Each intent
   merges in order; a textual conflict (p = 0.35 per shared file
   changed on trunk since its base, or anywhere ahead of it in the
   chain, unless it is stacked on that change) or a stale stack drops
   it.
3. **Verify.** CI runs on every lane head (its exact SHA). A lane is red
   when the run flakes or when the head — main plus every unlanded lane
   ahead plus this lane — contains an interaction defect.
4. **Decide** (`decideChain`). The contiguous green prefix lands at
   once (main fast-forwards to the last green head, CAS-checked). The
   first red lane leaves the chain; every lane behind it, in every
   group, is invalidated and its intents go back to the front of the
   queue without blame. A red lane of one intent names the culprit;
   larger lanes split into two **probes** that run off the chain on
   main, in parallel, in the 8 reserved probe refs. Green probes
   requeue their intents; red probes split again.

**Trains-only** runs this with `speculation_depth` 1 (one group in
flight: the pre-speculation executor). **Forge** runs it with the
shipped default, 3.

### Modes

| Mode | Flow |
|---|---|
| **Baseline**: branch + PR + serial queue | 1. Work, then the PR's own CI on its branch, then **every PR is reviewed by a human**.<br>2. A **serial merge queue** lands one PR at a time, with CI on the exact merged SHA (test-then-merge).<br>3. A textual conflict with anything that landed since the PR's base bounces it to the author, who rebases (redoing 50% of the work time), is re-approved, and rejoins the **back** of the queue.<br>4. The author gives up after 3 rebases or 3 fixes. |
| **Forge, trains only** | 1. The same PR, CI and review flow as the baseline.<br>2. Ready changes ride the train executor above with **speculation depth 1**.<br>3. Conflicts bounce to the author, as in the baseline.<br>4. There is no declare-time information. |
| **Forge, full** | 1. **Declare-time overlap.** For each declared file, the latest live intent on it becomes an `after:` predecessor (confirmed with `footprintsOverlap`).<br>2. **Stacking.** The new intent waits up to 15 minutes for each predecessor to push a head, then **stacks** on it (forks from it). A stacked intent rides behind its predecessor: in the same group, or — when the predecessor is already in flight — in a speculative group stacked on it, so it does not wait for the predecessor to land. A predecessor that hasn't pushed within the 15 minutes is dropped, and the intent works in parallel.<br>3. **Restacks.** If a predecessor changes after the intent stacked on it (rework, replay, or invalidation), the intent is re-derived on the new head.<br>4. **Plan approval.** Intents on a protected path need a human plan approval first (`awaiting_plan`).<br>5. **Trains** run the executor above with **speculation depth 3**.<br>6. **Replay.** A conflict goes to an **LLM replay**: 2 attempts, each with a 0.6 success rate. A replayed intent passes CI again and **keeps its place in line**. When the replay budget is spent, the conflict escalates to a human and the author reworks it.<br>7. **Review routing.** `scoreRisk` scores every verified head. `routeLanding` then sends it to auto (no human), audit (a 5% sample, reviewed after the fact, never blocking), or human review before landing. |

Each mode runs its own seeded streams for CI duration, flakes, conflict
draws, routing rolls and replays.

### Metrics

Every metric is per mode, at a given N.

| Metric | Definition |
|---|---|
| Landed / Abandoned | Intents that reached trunk, and intents that gave up. Each intent ends in one of the two; a test checks this. |
| Changes/min | Landed ÷ (last land − first declare). This includes the long tail of stragglers. |
| 80% landed by | Minutes from the first declare until 80% of **all** N intents had landed. `n/a` means fewer than 80% ever landed. This is throughput without the straggler tail. |
| p50 / p95 declare→land | Over **landed** intents only. A mode that abandons its hardest intents looks faster here. Read this together with Abandoned. |
| Conflicts hit | Textual conflicts at merge time (see the executor, step 2). A predecessor the intent is stacked on is excluded. |
| Conflicts avoided | Forge only. Predecessor overlaps that were stacked or sequenced, **and** for which the same per-file draw says a conflict would have happened had both worked from one base. This is a counterfactual inside the model. |
| **Escaped defects** (n / min) | Defects that escape **all** CI: the count, and the union of [land, land + 30 min] intervals they keep main red. No exact-SHA check can catch them; they scale with how many intents land. **This was previously labelled "red-main minutes"**, which overstated what it measures. |
| **Main red: integration min** | Main red because a landed trunk state was **not** the exact SHA CI verified and the combination carries an interaction defect. Computed at every landing (trains: `SpeculativeChain` CAS check, counted in `unverified_landings`; baseline: nothing landed between CI start and land), not assumed. **0 for trains/Forge by construction**. The modeled baseline is a test-then-merge queue, so it is 0 as well; a merge-then-test baseline would not be, but is not modeled. |
| Human min | review × 10 min + re-review × 3 + plan approval × 5 + audit × 5 + escalation × 10. The full breakdown is in the JSON. |
| CI runs | Branch/fork CI, plus queue or lane CI, plus probe runs, plus flake reruns. Lanes invalidated by a red lane ahead of them count their (wasted) run. |
| $ / 1k agents | Simulated billable Artifacts git ops (fork + clone + fetch + push) × $0.15 per 1k ops, per 1,000 agents. The op model is in the constants table. Since the pull model (section 2.3) every mode runs on the same Artifacts repo, so the baseline is reported too; the tables in section 2 predate it (old per-intent estimate, baseline `n/a`). |
| Git ops / landed | Pull model: simulated billable git ops per landed change. By kind in the JSON (`git_ops_per_landed`), with ls-remote and token mints apart (`binding_calls_per_landed`, billing undocumented). No polling. |
| $ / 10k changes | Git ops / landed × 10,000 × $0.15 per 1k ops. `poll_projection` in the JSON adds **projected** polling on top (section 2.3). |

The JSON also carries `speculative_groups` (groups cut on an in-flight
group), `invalidated_lanes`, `bisections` and `unverified_landings`.

### Constants (inputs, not measurements)

They are defined in `apps/sim/src/constants.ts` (`DEFAULT_CONSTANTS`,
`CONSTANT_SOURCES`). "Assumption" means nothing external backs the
number; it is a knob you can change.

| Constant | Value | Source |
|---|---|---|
| Arrival window | 10 min | COMPETITION-PLAN §4 scale math |
| Repo files / per dir | 100,000 / 20 | Assumption (a large monorepo) |
| Zipf exponent | 0.7 | Assumption. Calibrated to about 21% overlap at 1k agents |
| Footprint size | 1 + Geom(mean 1.5), ≤ 12 | Assumption |
| Protected dirs | 2% (`src/auth/**`, `migrations/**`) | Assumption |
| Drift | 10% of intents touch 1 undeclared file | Assumption |
| Work time | Lognormal, median 8 min, σ 0.6 | Assumption |
| CI run | Lognormal, median 10 min, σ 0.3. One suite per run, any batch size; runners unlimited | Assumption |
| Review latency / re-review | Median 30 / 15 min, σ 0.8. Reviewers are unlimited, which favors the baselines | Assumption |
| Plan approval latency | Median 30 min | Assumption |
| LLM replay | Median 3 min. Success rate 0.6 per attempt, 2 attempts (`replay.max_attempts`) | Merge-Bench (plan §13) for 0.6; `DEFAULT_POLICY` for attempts |
| Rework (rebase or fix) | 50% of the original work time | Assumption |
| Conflict probability | 0.35 per shared changed file | Assumption. Overlap is necessary for a conflict, not sufficient |
| Defect | 5% of intents. 90% are caught by their own CI; the rest escape | Assumption |
| Interaction defect | 2%. Caught only by CI on a combined SHA that contains it | Assumption |
| Flake | 5% per CI run | Assumption. Google reported about 1.5% of test runs flaky (2016 testing blog), and a run has many tests |
| Weak evidence / reviewer disagrees | 15% / 6% | Assumption (risk terms) |
| Escaped defect MTTR | 30 min | Assumption |
| Planner wait budget | 15 min | Assumption |
| Policy | `DEFAULT_POLICY`: auto-land risk ≤ 30, 5% audit sample, lanes 50 per group × 8 parallel, **speculation depth 3**, replay 2 | `intents-core.ts` |
| Trains-only speculation depth | 1 (the pre-speculation executor) | `trainsSpeculationDepth` |
| Lane-ref pool | 32: chain ≤ 24, probes 8 | `train-core.ts` |
| Human minutes per item | Review 10, re-review 3, plan 5, audit 5, escalation 10 | Assumption |
| Give-up limits | 3 rebases, 3 fixes, 8 conflicts in total | Assumption |
| Git: clone / fork per intent | clone 1 (all modes); fork 1 (trains, Forge; the baseline uses branches of the same repo) | `apps/sim/src/harness/git.ts` (clone `depth: 1`, once); Forge forks once per intent |
| Git: agent push | push 1 per agent push (first push + each rework); the baseline also fetches 1 before each push (`pull --rebase`) | Assumption for the baseline fetch |
| Git: rework / replay / restack | rebase fetch 1 (conflict, interaction fix, escalation; not a defect fix); replay fetch 2 per attempt (trunk + fork) + push 1 on success; restack fetch 1 | Assumption; replay fetches read from the train/replay code |
| Git: serial queue (baseline) | fetch 1 per serve (bounces included), push 1 per merge ref, push 1 to fast-forward main | Assumption |
| Git: train build | fetch 1 per group (+1 for the speculative parent lane ref), fetch 1 per item from its fork, push 1 per lane ref; plus 1 ls-remote | `apps/worker/src/train.ts` `buildGroup`. **Lower bound**: `fetchCovering` deepening retries are ignored |
| Git: train landing | fetch 1 (lane ref), push 2 (main + notes); plus 1 ls-remote | `train.ts` `fastForwardMain` |
| Git: bisect probe | fetch 1 + 1 per item, push 1 | `train-core.ts` probes |
| ls-remote, token mints | counted, reported apart | Artifacts billing for them is undocumented |
| Polling (projected) | `git fetch` every 30 / 60 / 300 s, while working .. until landed or abandoned; Forge agents sync from Feed events (0 polls) | Assumption; applied post-hoc, see 2.3 |
| Fetch cache (`forgeFetchCache`) | off; on = the train caches each item's fork fetch across speculative rebuilds and a replay fetches trunk once | **Design, not shipped** |
| Artifacts price | $0.15 per 1k ops | Artifacts pricing page (names create, push, pull, clone as examples), checked 2026-10-12 |

## 2. Results (SIMULATED)

All rows below are simulated, seed 7, generated on 2026-10-10 at
commit `7b37655` with:

```bash
node --experimental-strip-types scripts/forge-bench.mjs --agents 1000,10000,100000 --seed 7 --json
```

**1,000 agents.** 21.0% overlap at declare.

| Mode | Landed | Abandoned | Changes/min | 80% landed by | p50 declare->land | p95 | Conflicts hit / avoided | Escaped defects (n / min) | Main red: integration min | Human min | CI runs | $ / 1k agents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline: branch + PR + serial queue | 988 | 12 | 0.09 | 6d 13h | 3d 23h | 7d 15h | 205 / 0 | 4 / 120 | 0 | 10,636 | 2,392 | n/a |
| Forge, trains only | 986 | 14 | 1.31 | 9h 17m | 5h 39m | 10h 27m | 253 / 0 | 4 / 113 | 0 | 10,774 | 1,811 | $1.92 |
| Forge, full | 998 | 2 | 1.59 | 7h 16m | 4h 18m | 7h 56m | 337 / 52 | 4 / 120 | 0 | 2,180 | 2,427 | $2.82 |

**10,000 agents.** 50.4% overlap at declare.

| Mode | Landed | Abandoned | Changes/min | 80% landed by | p50 declare->land | p95 | Conflicts hit / avoided | Escaped defects (n / min) | Main red: integration min | Human min | CI runs | $ / 1k agents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline: branch + PR + serial queue | 8,860 | 1,140 | 0.08 | 66d 23h | 36d 22h | 70d 17h | 7,818 / 0 | 53 / 1,590 | 0 | 120,580 | 27,801 | n/a |
| Forge, trains only | 8,708 | 1,292 | 1.16 | 4d 12h | 2d 3h | 4d 16h | 8,715 / 0 | 52 / 1,323 | 0 | 122,809 | 23,789 | $2.21 |
| Forge, full | 9,820 | 180 | 2.02 | 2d 14h | 35h 3m | 2d 23h | 8,309 / 945 | 59 / 1,406 | 0 | 37,693 | 28,846 | $2.87 |

**100,000 agents.** 83.0% overlap at declare. A stress case: 100k
agents declaring within 10 minutes on a single repo.

| Mode | Landed | Abandoned | Changes/min | 80% landed by | p50 declare->land | p95 | Conflicts hit / avoided | Escaped defects (n / min) | Main red: integration min | Human min | CI runs | $ / 1k agents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline: branch + PR + serial queue | 68,153 | 31,847 | 0.08 | n/a | 293d 21h | 581d 3h | 171,932 / 0 | 388 / 11,535 | 0 | 1,424,611 | 331,879 | n/a |
| Forge, trains only | 66,649 | 33,351 | 0.75 | n/a | 22d 12h | 56d 16h | 179,877 / 0 | 379 / 10,420 | 0 | 1,443,817 | 311,409 | $2.59 |
| Forge, full | 97,989 | 2,011 | 2.01 | 26d 18h | 16d 7h | 31d 14h | 120,186 / 10,293 | 524 / 13,198 | 0 | 509,321 | 330,530 | $3.05 |

### 2.1 Before / after (10,000 agents, seed 7)

The "before" rows are the previous revision of this file (`94bf9ae`).
That simulator did **not** run the shipped executor: it verified each
lane independently against trunk and landed lanes one by one, so two
lanes that landed back to back put a combined state on main that no CI
run had verified. The shipped code never did that (lanes are stacked;
invariant 2), and its `planTrain` kept only the first 8 overlap
components, so a cut of 50 disjoint ready intents shipped 8. The
"before" numbers were therefore not reachable by the shipped code.

| Model | Mode | Changes/min | 80% landed by | Abandoned |
|---|---|---:|---:|---:|
| before (`94bf9ae`, independent lanes) | trains only | 5.60 | 21h 41m | 1,138 |
| before | trains only, `--max-parallel 32` | 12.14 | 5h 59m | 1,002 |
| before | Forge, full | 4.85 | 21h 51m | 190 |
| after (`7b37655`, shipped executor) | trains only (depth 1) | 1.16 | 4d 12h | 1,292 |
| after | **Forge, full (speculation depth 3)** | **2.02** | **2d 14h** | **180** |

At 1k agents: trains only 1.31 → 1.59 changes/min for Forge (80% by
9h 17m → 7h 16m). At 100k: 0.75 → 2.01, and only Forge ever reaches
80% landed (26d 18h).

### 2.2 Sensitivity (10,000 agents, seed 7)

Each row: `node --experimental-strip-types scripts/forge-bench.mjs --agents 10000 --seed 7 <flags> --json`
(raw output `docs/bench/forge-sim-seed7-<suffix>.json`).

| Flags | Mode | Changes/min | 80% landed by | Abandoned | Human min |
|---|---|---:|---:|---:|---:|
| (defaults) | trains only, depth 1 | 1.16 | 4d 12h | 1,292 | 122,809 |
| (defaults) | Forge, depth 3 | 2.02 | 2d 14h | 180 | 37,693 |
| `--modes forge --speculation-depth 1` (`-d1`) | Forge, no speculation | 1.31 | 4d 0h | 25 | 29,648 |
| `--modes trains --trains-speculation-depth 3` (`-td3`) | trains only **with** speculation | 1.99 | 2d 18h | 1,610 | 126,481 |
| `--modes trains,forge --max-parallel 32` (`-mp32`) | trains only, 32 lanes per group | 0.93 | 5d 18h | 1,337 | 123,715 |
| `--modes trains,forge --max-parallel 32` (`-mp32`) | Forge, 32 lanes per group (chain capped at 24 lanes, so ~1 group) | 1.23 | 4d 12h | 202 | 37,933 |
| `--modes trains,forge --p-interaction 0` (`-pi0`) | trains only, no interaction defects | 1.37 | 3d 16h | 1,200 | 120,991 |
| `--modes trains,forge --p-interaction 0` (`-pi0`) | Forge, no interaction defects | 3.17 | 34h 43m | 150 | 34,532 |

Development measurements (2,000 agents, seed 7, a throwaway probe
script against intermediate versions of `sim.ts`; **not reproducible at
HEAD**, reported because they explain two design decisions):

- **In-chain vs off-chain bisect.** With bisect children placed at the
  chain head (the original design), 80% landed took 2,064 min for Forge
  (depth 4) and 2,060 min for trains only. Moving bisection off the
  chain into probes: 709 min and 1,089 min. Off-chain probes shipped.
- **Retry a red lane once on the same SHA.** Tried to absorb flakes
  before invalidating speculative work. It made trains only slower
  (2,060 → 3,028 min to 80%): most reds are real interaction defects,
  and a retry delays their bisect by a CI round. Not shipped.

### 2.3 Pull traffic: git ops per landed change, N × mode

> Provenance: agent-drafted on 2026-10-12 (branch `forge/pull-sim`).
> Tables generated with
> `node --experimental-strip-types scripts/forge-bench.mjs --pull --agents 10,100,1000,10000 --seed 7 --json --markdown`
> on 2026-10-12 at commit `6b2907d` (raw output:
> `docs/bench/forge-sim-seed7-pull.json`, key `pull_curve`). Nothing in
> this section is measured.

Artifacts bills git operations ($0.15 per 1,000; the pricing page names
create, push, pull and clone as examples). This section asks how that
traffic scales with swarm size. Three kinds of number, never mixed:

| Label | What | Where |
|---|---|---|
| **MEASURED** | Cloudflare's own Artifacts events for a real repo, per landed change | The ops ledger (`apps/worker/src/forge-ops.ts`, FORGE.md "Ops ledger"). **No live run recorded yet.** |
| **SIMULATED** | Git ops by kind, counted by `sim.ts` at the events it already models (clone, fork, pushes, rebases, replays, train builds, landings, probes) under the `git` constants above | Table A |
| **PROJECTED** | Table A plus polling: an agent without an event feed runs `git fetch` every S seconds. Applied **post-hoc** over two windows: while the agent works (lower bound) and until its change lands or is abandoned (upper bound) | Table B |

All three modes run on the same Artifacts repo: the baseline is the PR
flow on branches of that repo (no forks), so it has real git ops now
(it used to be `n/a`). ls-remote and token mints are counted but kept
out of the billable total; their billing is undocumented.

**Table A: SIMULATED billable git ops per landed change (no polling), seed 7.**

| N | Mode | Landed | Min in system | fork | clone | fetch | push | Billable / landed | [ls-remote] | [token] | $ / 10k changes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | Baseline: PR flow on the same Artifacts repo | 10 | 1h 32m | 0.0 | 1.0 | 2.1 | 3.1 | 6.2 | 0.0 | 0.0 | $9.30 |
| 10 | Forge, trains only | 10 | 1h 27m | 1.0 | 1.0 | 2.9 | 4.1 | 9.0 | 1.9 | 5.9 | $13.50 |
| 10 | Forge, full | 10 | 40m | 1.0 | 1.0 | 3.9 | 4.6 | 10.5 | 1.8 | 6.8 | $15.75 |
| 10 | Forge + fetch cache (design, not shipped) | 10 | 40m | 1.0 | 1.0 | 3.4 | 4.6 | 10.0 | 1.8 | 6.3 | $15.00 |
| 100 | Baseline: PR flow on the same Artifacts repo | 100 | 10h 23m | 0.0 | 1.0 | 2.3 | 3.1 | 6.4 | 0.0 | 0.0 | $9.60 |
| 100 | Forge, trains only | 100 | 1h 34m | 1.0 | 1.0 | 2.1 | 2.9 | 6.9 | 0.7 | 4.3 | $10.41 |
| 100 | Forge, full | 100 | 53m | 1.0 | 1.0 | 2.8 | 2.4 | 7.2 | 0.6 | 4.7 | $10.86 |
| 100 | Forge + fetch cache (design, not shipped) | 100 | 53m | 1.0 | 1.0 | 1.8 | 2.4 | 6.2 | 0.6 | 3.7 | $9.29 |
| 1,000 | Baseline: PR flow on the same Artifacts repo | 988 | 4d 1h | 0.0 | 1.0 | 2.8 | 3.3 | 7.1 | 0.0 | 0.0 | $10.67 |
| 1,000 | Forge, trains only | 986 | 6h 6m | 1.0 | 1.0 | 2.9 | 2.2 | 7.1 | 0.3 | 4.3 | $10.69 |
| 1,000 | Forge, full | 998 | 4h 25m | 1.0 | 1.0 | 6.8 | 2.8 | 11.6 | 0.3 | 8.6 | $17.40 |
| 1,000 | Forge + fetch cache (design, not shipped) | 998 | 4h 25m | 1.0 | 1.0 | 2.8 | 2.8 | 7.6 | 0.3 | 5.1 | $11.40 |
| 10,000 | Baseline: PR flow on the same Artifacts repo | 8,860 | 41d 0h | 0.0 | 1.1 | 4.7 | 4.0 | 9.9 | 0.0 | 0.0 | $14.78 |
| 10,000 | Forge, trains only | 8,708 | 2d 14h | 1.1 | 1.1 | 4.3 | 3.1 | 9.7 | 0.3 | 5.3 | $14.53 |
| 10,000 | Forge, full | 9,820 | 37h 21m | 1.0 | 1.0 | 8.1 | 3.2 | 13.3 | 0.3 | 9.4 | $20.01 |
| 10,000 | Forge + fetch cache (design, not shipped) | 9,820 | 37h 21m | 1.0 | 1.0 | 4.1 | 3.2 | 9.4 | 0.3 | 6.6 | $14.06 |

**Table B: PROJECTED, Table A plus polling.** Range = poll while
working .. poll until landed or abandoned. Forge syncs from Feed events,
so it adds 0 polls.

| N | Mode | poll 30s: ops / landed | poll 30s: $ / 10k | poll 60s: ops / landed | poll 60s: $ / 10k | poll 300s: ops / landed | poll 300s: $ / 10k |
|---|---|---:|---:|---:|---:|---:|---:|
| 10 | Baseline: PR flow on the same Artifacts repo | 23.9 .. 189 | $35.79 .. $284 | 15.0 .. 97.8 | $22.54 .. $147 | 8.0 .. 24.5 | $11.95 .. $36.79 |
| 10 | Forge, trains only | 26.7 .. 183 | $39.99 .. $275 | 17.8 .. 96.1 | $26.74 .. $144 | 10.8 .. 26.4 | $16.15 .. $39.63 |
| 10 | Forge, full (events, 0 polls) | 10.5 | $15.75 | 10.5 | $15.75 | 10.5 | $15.75 |
| 10 | Forge + fetch cache (design, not shipped) (events, 0 polls) | 10.0 | $15.00 | 10.0 | $15.00 | 10.0 | $15.00 |
| 100 | Baseline: PR flow on the same Artifacts repo | 26.6 .. 1,251 | $39.95 .. $1,877 | 16.5 .. 629 | $24.78 .. $943 | 8.4 .. 131 | $12.64 .. $196 |
| 100 | Forge, trains only | 26.9 .. 194 | $40.41 .. $291 | 16.9 .. 101 | $25.41 .. $151 | 8.9 .. 25.7 | $13.41 .. $38.49 |
| 100 | Forge, full (events, 0 polls) | 7.2 | $10.86 | 7.2 | $10.86 | 7.2 | $10.86 |
| 100 | Forge + fetch cache (design, not shipped) (events, 0 polls) | 6.2 | $9.29 | 6.2 | $9.29 | 6.2 | $9.29 |
| 1,000 | Baseline: PR flow on the same Artifacts repo | 28.7 .. 11,881 | $43.00 .. $17,821 | 17.9 .. 5,944 | $26.83 .. $8,916 | 9.3 .. 1,194 | $13.90 .. $1,792 |
| 1,000 | Forge, trains only | 29.4 .. 750 | $44.11 .. $1,125 | 18.3 .. 378 | $27.40 .. $568 | 9.3 .. 81.4 | $14.03 .. $122 |
| 1,000 | Forge, full (events, 0 polls) | 11.6 | $17.40 | 11.6 | $17.40 | 11.6 | $17.40 |
| 1,000 | Forge + fetch cache (design, not shipped) (events, 0 polls) | 7.6 | $11.40 | 7.6 | $11.40 | 7.6 | $11.40 |
| 10,000 | Baseline: PR flow on the same Artifacts repo | 39.7 .. 133,322 | $59.51 .. $199,982 | 24.8 .. 66,666 | $37.15 .. $99,999 | 12.8 .. 13,341 | $19.25 .. $20,012 |
| 10,000 | Forge, trains only | 40.9 .. 8,683 | $61.41 .. $13,024 | 25.3 .. 4,346 | $37.97 .. $6,519 | 12.8 .. 877 | $19.22 .. $1,316 |
| 10,000 | Forge, full (events, 0 polls) | 13.3 | $20.01 | 13.3 | $20.01 | 13.3 | $20.01 |
| 10,000 | Forge + fetch cache (design, not shipped) (events, 0 polls) | 9.4 | $14.06 | 9.4 | $14.06 | 9.4 | $14.06 |

What this says, and what it doesn't:

- **Without polling, Forge spends more git ops per landed change than
  the baseline**: 13.3 vs 9.9 at 10k agents, 11.6 vs 7.1 at 1k (Table
  A). The extra is fetches (8.1 vs 4.7 per landed change at 10k): LLM
  replays (12,203 attempts at 2 fetches each, about 2.5 per landed
  change) and speculative lane rebuilds (5,117 lanes invalidated by a
  red lane ahead of them, re-cut, and every item refetched from its
  fork). Forge
  lands more changes (9,820 vs 8,860 at 10k), but per landed change it
  is not cheaper on git traffic.
- **Forge wins only against agents that poll.** At 10k agents, an
  agent polling every 60 s only while it works already costs 24.8 ops
  per landed change (Forge: 13.3). Polling until landed costs
  thousands, because the serial queue keeps changes in the system for
  weeks (41 days mean at 10k); that upper bound is driven by queue
  wait, not by git. At a 300 s interval and only while working, the
  baseline (12.8) is roughly level with Forge (13.3).
- **Polling is post-hoc.** The simulator does not make polling agents
  fresher, so they do not conflict less here. Agents that poll would
  rebase earlier and might conflict less; that effect is not modelled.
- **Train fetches are a lower bound** (`fetchCovering` deepening
  retries are ignored), and every per-event count is an input, listed
  in the constants table.
- **Optimisation opportunity: cache fork fetches across lane
  rebuilds.** The "Forge + fetch cache (design, not shipped)" rows turn
  on `forgeFetchCache`: the train fetches an item's head once per
  version, so a speculative rebuild of the same head is free, and a
  replay fetches trunk once. Forge's no-poll figure drops to 9.4 ops per
  landed change at 10k (from 13.3; baseline 9.9) and 7.6 at 1k (from
  11.6; baseline 7.1). Landings are unchanged (same seed, same
  decisions); only fetches move. **Status (2026-10-12):** the
  lane-rebuild half shipped: `train.ts` restores the previous build's
  objects from an R2-backed `objectCache` and skips a fork fetch when
  the intent's head and base are present (`train.test.ts` "object
  cache" tests: a rebuild after main moves does one fork fetch instead
  of two). Replays still fetch trunk and fork (their merge calls the AI
  resolver, so a cache-miss retry would re-run it). The rows above stay
  labelled as the model they are; the live ledger is the measurement.

### What the simulated numbers say, and what they don't

- **Forge beats trains only at every N in this model**, on changes/min
  and on time to 80% landed: 1.2× at 1k, 1.7× at 10k, and at 100k it
  is the only mode that reaches 80%. It also abandons far less (180 vs
  1,292 at 10k) and spends 69% fewer human minutes.
- **Most of the throughput gain is speculation, not declare-time
  information.** Trains only with speculation depth 3 reaches 80% in
  2d 18h, close to full Forge's 2d 14h; Forge without speculation takes
  4d 0h. Declare-time stacking and replay mostly buy fewer abandons
  and fewer human minutes, not speed.
- **The honest headline is smaller than the one this file used to
  print.** Before, trains only reached 5.60 changes/min at 10k (12.14
  with 32 lanes). Forge with speculation now reaches 2.02 in the
  faithful model. Forge does **not** beat the old trains-only numbers;
  those came from a model that landed unverified combinations and that
  the shipped code could not reproduce (2.1).
- **The ceiling is interaction defects under exact-SHA verification.**
  With 2% of intents failing only in combination, a 50-intent group
  almost always holds one. Every red lane invalidates everything
  behind it, so the chain lands roughly one defect-free run of intents
  per CI round. Removing interaction defects (`--p-interaction 0`)
  takes Forge from 2d 14h to 34h 43m; speculation pays off in
  proportion to how often groups are green.
- **More lanes per group hurt here.** `--max-parallel 32` makes both
  modes slower: a red lane invalidates every lane stacked behind it,
  and more lanes means more of them.
- **Speculation costs CI.** Invalidated lanes still ran: Forge spends
  28,846 CI runs against 23,789 for trains only at 10k, and the
  Artifacts estimate rises from $2.21 to $2.87 per 1k agents.
- **Main red from integration is 0 in every mode**, computed at every
  landing. For trains and Forge it is 0 by construction (CAS on the
  verified lane head); the test-then-merge baseline is also 0. Escaped
  defects (bugs no CI catches) are similar across modes and scale with
  how many intents land.

### Limitations

- Reviewers and CI runners are unlimited, and review effort is a
  constant. This favors both baselines and hides the CI cost of
  speculation (it shows up only in the CI-runs column).
- Interaction defects are per intent ("fails in any combined SHA that
  contains it"). The model has **no cross-lane semantic interactions**
  (two changes that are each fine but break together). So it charges
  stacked, exact-SHA verification its full cost and credits it with
  none of what it buys; that is why the old independent-lane model
  looked faster and safe.
- Stacking is the modeled meaning of an `after:` edge (fork from the
  predecessor's pushed head). The planner in stream A/B may differ.
- "Keeps its place in line" after a replay or an invalidation is
  modeled as the front of the queue; the Worker restores the intent's
  queue time to when it joined the train.
- Hot-file contention, CI duration and defect rates are assumptions.
  Change them in `constants.ts` and re-run; the same seed gives the
  same output.

## 3. Live harness (MEASURED; `apps/sim` Worker)

### Shape

```
forge-bench.mjs live start ──► flare-forge-sim Worker (POST /runs, admin token)
                                 ├─ SimRegistry DO (run list)
                                 └─ AgentPool DO × P  (alarm-driven; ≤6 requests in flight,
                                      ≤400 requests / 20 s per alarm, then the next alarm)
                                        └─► target Forge REST API (/v1/forge/*), FORGE_TOKEN
                                              └─► Artifacts forks in namespace flare-sim
```

- **Pools.** full-git: up to 100 agents per pool, so 10k agents is 100
  pools. coordination-only: up to 1,000 agents per pool, so 100k
  agents is 100 pools. Starts are spread over `ramp_seconds`
  (default 60).
- **coordination-only.** Each agent runs declare, then
  `whats_happening`, then N heartbeats. No forks are created. This is
  the cheap path to a measured 100k-intent run against the Coordinator.
- **full-git.** Each agent runs:
  1. declare;
  2. claim (fork remote + a fork-scoped token);
  3. a real `git push` of one tiny commit, using isomorphic-git over
     `MemoryFS`. The commit message carries `Flare-Intent`,
     `Flare-Agent` and `Flare-Goal` trailers from the shipped
     `appendTrailers`;
  4. report push;
  5. ready.
- **Rate limits.**
  - A 429 or an Artifacts `rateLimited`-style error code backs the
    agent off, honoring `Retry-After` if present, otherwise exponential
    with jitter. It is counted in `rateLimited` and never fails the
    run, up to 30 retries per agent.
  - A 5xx or network error retries 4 times.
  - A non-retryable 4xx on an optional step (heartbeat,
    `whats_happening`) is skipped. On any other step it fails that
    agent, and the error code is counted.
- **Budget guard.** full-git above `MAX_FULL_GIT_AGENTS` (default
  1,000) is refused with 409 `confirm_required` unless the request
  carries `"confirm": true` (CLI: `--confirm`). full-git is capped at
  10,000 agents. The CLI checks the same limit before it sends.
- **Tokens.**
  - Fork tokens live in pool storage only until that agent finishes.
    They are never exported, never logged, and are redacted from git
    errors.
  - The Worker's admin token is compared digest-then-compare, which is
    constant-time.
- **Endpoints.**

  | Endpoint | Purpose | Auth |
  |---|---|---|
  | `POST /runs` | Start a run | Admin |
  | `GET /runs` | List runs | Read |
  | `GET /runs/:id/results` | Aggregate JSON: per-op requests, ok, errors, p50/p95 (log-bucket upper bounds, ±12.5%), intents/s, rate-limit count, done/failed/pending | Read |
  | `GET /runs/:id` | The same as an HTML page that refreshes itself | Read |
  | `POST /runs/:id/stop` | Stop the run | Admin |
  | `POST /runs/:id/cleanup` | Delete every fork the run created, through the Worker's `ARTIFACTS` binding (namespace `flare-sim`) | Admin |

  Admin endpoints take `Authorization: Bearer $SIM_ADMIN_TOKEN`. Read
  endpoints need the same token unless `PUBLIC_RESULTS="true"`.

The API contract is coded in `apps/sim/src/harness/api.ts`
(`FORGE_ROUTES`). It mirrors plan §3.3 and stream B:

| Op | Request | Fields read from the response |
|---|---|---|
| Goal | `POST /v1/forge/goals {repo, text}` | `goal.id` or `id` |
| Declare | `POST /v1/forge/intents {repo, goal_id, agent, title, reasoning, accept, footprint:{paths}}` | `intent.id` or `id`; `overlaps[]` |
| Claim | `POST /v1/forge/intents/:id/claim {agent}` | `fork_repo`, `fork_remote` or `remote`, `token` |
| Heartbeat | `POST /v1/forge/intents/:id/heartbeat {agent}` | `inbox[]` |
| Push | `POST /v1/forge/intents/:id/push {agent, sha, files}` | `drift[]` |
| Ready | `POST /v1/forge/intents/:id/ready {agent}` | `risk` |
| What's happening | `GET /v1/forge/whats-happening?repo=&paths=a,b` | `intents[]` |

When stream B's routes are merged, adjust `FORGE_ROUTES` and the `pick`
paths there. Nothing else needs to change.

### Running it (integrator)

Nothing in this stream was deployed, and no cloud resources were
created.

1. **Pick a target.** Use a **preview** Forge deployment whose
   `ARTIFACTS` binding points at namespace `flare-sim` (never
   production for full-git). Create the namespace if it is missing,
   with the same Artifacts REST call `scripts/artifacts-admin.mjs` uses.
   Then create the trunk repo (`SIM_REPO`, default `flare-sim-trunk`)
   with a tiny seed commit.
2. **Configure and deploy the harness.** Secrets go in through stdin
   and never appear in argv:

   ```bash
   printf %s "$FORGE_API_TOKEN" | npx wrangler secret put FORGE_TOKEN -c apps/sim/wrangler.jsonc
   printf %s "$SIM_ADMIN_TOKEN" | npx wrangler secret put SIM_ADMIN_TOKEN -c apps/sim/wrangler.jsonc
   # set vars.FORGE_URL in apps/sim/wrangler.jsonc (or --var FORGE_URL:https://...)
   npx wrangler deploy -c apps/sim/wrangler.jsonc --dry-run   # validate
   npx wrangler deploy -c apps/sim/wrangler.jsonc
   ```

3. **Run.** `SIM_ADMIN_TOKEN` comes from the environment.

   ```bash
   export FORGE_SIM_URL=https://flare-forge-sim.<sub>.workers.dev
   npm run forge:bench -- live start --mode coordination-only --agents 100000 --ramp 300
   npm run forge:bench -- live start --mode full-git --agents 1000
   npm run forge:bench -- live start --mode full-git --agents 10000 --confirm --ramp 600
   npm run forge:bench -- live results --run <id>           # or open $FORGE_SIM_URL/runs/<id>
   npm run forge:bench -- live results --run <id> --json > docs/bench/forge-live-<id>.json
   npm run forge:bench -- live cleanup --run <id>           # deletes the run's forks
   ```

4. **Report.** Record the measured rows in this file with the run ID,
   date and the Forge SHA, labelled **measured**, next to the
   simulated tables. Plan §4 estimates about 30–50k Artifacts ops for
   a 10k full-git run; measure it before you quote any dollar figure.

### Bench panel

`GET /v1/forge/bench` (FORGE-UX §5.8 and §8) has the shape
`{ run, measured_at, sha, modes: [{ mode, metrics, projected }] }`.
Each `runs[]` entry in `docs/bench/forge-sim-seed7.json` already has
that shape. It also carries `simulated: true` and `kind: "simulated"`
on the document and on every row, so the panel can label it. Metric
keys are snake_case: `changes_per_min`, `median_declare_to_land_min`,
`time_to_80pct_landed_min`, `conflicts_hit`, `conflicts_avoided`,
`escaped_defects`, `escaped_defect_min`, `main_red_integration_min`
(replaces the old `red_main_min`), `unverified_landings`,
`speculative_groups`, `invalidated_lanes`, `human_min`,
`dollars_per_1k_agents`, and so on. Since the pull model each mode also
carries `git_ops`, `git_ops_per_landed`, `billable_ops_per_landed`,
`binding_calls_per_landed`, `usd_per_10k_changes`,
`mean_min_in_system` and `poll_projection` (section 2.3).

## 4. Files

| Path | Role |
|---|---|
| `apps/sim/src/{prng,constants,workload,sim,report}.ts` | Simulator. Pure, and runs under Node strip-types and vitest |
| `apps/sim/src/pull.ts` | Pull model: git ops per landed change by kind, polling projections (section 2.3) |
| `apps/sim/src/harness/{api,pool,plan,git}.ts` | Harness logic. Runtime-free, with an injectable HTTP layer and git |
| `apps/sim/src/{pool-do,index,env}.ts` | The Worker and its Durable Objects |
| `apps/sim/src/sim.test.ts`, `apps/sim/src/harness/pool.test.ts` | Tests. Pool logic runs against a fake Forge API |
| `scripts/forge-bench.mjs` | CLI for both layers (`npm run forge:bench`) |
| `docs/bench/forge-sim-seed7.json` | Committed simulated output |
| `docs/bench/forge-sim-seed7-{d1,td3,mp32,pi0}.json` | Committed sensitivity runs (section 2.2) |
| `docs/bench/forge-sim-seed7-pull.json` | Committed pull-traffic run (section 2.3), with `pull_curve` |
