# Flare Forge: design notes

> Provenance: agent-drafted 2026-10-10, trimmed for publication
> 2026-10-13. Platform limits come from the developers.cloudflare.com
> docs for Artifacts, Durable Objects, Workers, Queues and Containers
> (fetched 2026-10-10). Every number is labelled measured, simulated or
> projected; measured runs are in [FORGE.md](FORGE.md) and
> [FORGE-BENCH.md](FORGE-BENCH.md).

This is the design rationale behind Forge: the first principles, the
product spec, the architecture, the proof plan, and the demo script.
Section numbers are kept stable because code comments cite them.

---

## 0. The idea on one page

**Thesis.** When agents write the code, the code is cheap and can be
regenerated. The scarce things are **human attention**, **trunk
throughput**, and **trust**. So the durable unit of collaboration is no
longer the diff. It is the **Intent**: what an agent is about to change,
where, and why, plus the evidence that it worked.

**The one idea judges will remember:**

> **Intent is the unit.** One record answers all four of Cloudflare's
> questions:
> - **Who's doing what?** Query intents by footprint.
> - **Conflicts?** Merge *intents* by replaying them, not hunks.
> - **Human review?** Review intents and evidence, not diffs.
> - **Why?** The intent *is* the history.

**What we ship:** Flare Forge, an intent-native git platform on Workers
and Artifacts. Any agent can use it (Claude Code, Codex, Cursor or a
script) through plain `git` plus MCP. Changes integrate through
CI-verified **trains**, so `main` is never red. Humans spend their time
on the changes that carry risk, and every line can answer
`flare why`.

---

## 2. First principles: what changes when the writers are agents

GitHub's model rests on assumptions that were true for human teams. List
them, check each against agents, and see what the design has to become.

| # | Human-era assumption | Agent-era reality | Design consequence |
|---|---|---|---|
| A1 | Writers are scarce and slow (a few PRs per person per day) | Writers are abundant and fast: thousands of changes per hour | **Integration becomes the bottleneck**, not authoring. Trunk must absorb changes in batches with parallel lanes. |
| A2 | Code is expensive, so preserve the diff | Code is cheap and **regenerable from the intent** | The durable artifact is **intent plus evidence**. The diff is a derived cache, so conflicts can be resolved by *re-deriving* the change. |
| A3 | Writers remember their context | Agents are stateless between sessions | Context must be a **first-class, forkable object**: a session repo per intent. |
| A4 | Coordination happens socially (standups, Slack) | Each agent must be told explicitly. Broadcasting to everyone is O(n²) and floods context | Coordination must be **local**. An agent learns only about the few intents whose footprint overlaps its own, which costs O(overlap), not O(n). |
| A5 | Review is the quality gate, and attention is affordable | Human attention is the **scarcest resource** in the system | Review must be **routed by risk**, done at the **plan** stage, and **compressed** into stories. Everything else is gated by evidence and audited by sampling. |
| A6 | Trust comes from *who* wrote it | Authorship tells you little about an agent's quality | Trust comes from **verifiable evidence**: CI on the exact combined commit, provenance and attestations. |
| A7 | Conflicts are rare and the author fixes them | Conflicts are constant at scale, and the author may be gone | Conflicts are **first-class work items** that any agent can claim, resolved with both intents in context. |
| A8 | The "why" lives in heads and PR threads | Agents can't be asked later | The "why" is **captured at the moment of intent, machine-readable, attached to the commits**, and queryable per line. |

**Three conclusions.** These are the backbone of the pitch:

1. **Optimize for the two scarce resources:** trunk serialization (A1)
   and human attention (A5). Everything else is cheap.
2. **Make intent the primary key of the system** (A2, A3, A7, A8). Code
   hangs off intents, not the other way around.
3. **Locality scales coordination** (A4). You don't need to know what
   100k agents are doing, only the 3 whose work touches yours.

**What this rules out.** It also makes good Q&A answers:
- **Hard locks.** Cursor's 2026 experience: 20 agents behind locks
  produced the throughput of 2–3.
- **One shared repo with agents pushing branches.** Artifacts limits git
  traffic to 2,000 requests per 10 s *per repo*.
- **One-at-a-time merge queues.** A ref compare-and-swap serializes
  merges at about 1 per second, which is 3 hours for 10k changes.
- **LLM-only conflict resolution.** The best models resolve fewer than
  60% of real conflict hunks (Merge-Bench, ICPR 2026).
- **An AI reviewer as the gate.** Public benchmarks put recall at about
  40–70%.

---

## 3. The product, specified

### 3.1 The primitives

| Primitive | Replaces | What it is |
|---|---|---|
| **Goal** | Issue / epic | The human's request in their own words. Owns N intents. Every line traces back to one. |
| **Intent** | Branch + PR | A declared unit of change. Fields: goal, title, **reasoning**, **footprint** (paths, plus entities later), **acceptance check**, risk, and state. Owns one Artifacts **fork**, `i-<id>`, which contains the code *and* a `flare/session` branch holding the plan, step log and decisions. |
| **Lease** | (nothing) | The intent's advisory claim on its footprint. Has a TTL, is renewed by heartbeat, and is **never blocking**. |
| **Train** | Merge queue + rebase | A batch of ready intents, split into **lanes** of non-overlapping footprints. Merged onto trunk, verified by CI **as that exact combined SHA**, then fast-forwarded. A failing train is bisected. |
| **Conflict** | A blocked merge plus a "please rebase" comment | A claimable work item with both intents' goals, reasoning and diffs. Resolved by **replay**: the intent is re-derived on the new trunk, and it must pass CI. |
| **Story** | PR list | The review unit: a goal's intents with their evidence, risk-sorted, showing the policy decision on each. |
| **Why record** | Commit message + PR thread | Two layers: trailers on every agent commit (`Flare-Goal/Intent/Agent/Session`), and a `refs/notes/why` JSON on every trunk commit, written by the train. Readable per line with `flare why`. |

### 3.2 Intent lifecycle

```
draft ──(policy: protected path)──► awaiting_plan ──(human approves)──┐
  │                                                                   ▼
  └──────────────────────────────► claimed ──► working ──► ready ──► in_train ──► landed
                                     │            │          │          │
                                     │      (drift alert)    │     (conflict) ──► conflicted ──► replaying ──► ready
                                     │                       │     (train red) ──► bisected ──► ready | failed
                                     └── expired (lease TTL, no heartbeat) ──► open for re-claim
```

**Invariants.** Each must be tested.

1. **No agent ever holds a write token for trunk.** Only the train
   writes `main`. Agents get a write token scoped to their own fork with
   a 1-hour TTL, and it is revoked when the intent lands.
2. **`main` only moves to a SHA that CI verified green as that exact
   SHA.**
3. **Every trunk commit has a why note.** Every agent commit has
   trailers.
4. **A conflict resolution lands only through the same train-plus-CI
   path.** It is never pushed directly.
5. **Coordination messages are data, not instructions.** Mailbox text
   is shown to agents labelled as untrusted peer content. This blocks
   prompt injection between agents, and judges will ask about it.

### 3.3 Agent surface (MCP tools; same as REST and CLI)

| Tool | Tier | Returns |
|---|---|---|
| `plan_goal(text)` | write | Proposed intents with footprints. A human may edit them. |
| `declare_intent(goal, title, reasoning, footprint, accept)` | write | `{intent, fork_remote, token, overlaps[], similar[], inbox[]}`. **Overlaps come back before any code is written.** |
| `whats_happening(paths?)` | read | Live intents near these paths, with owner, reasoning and diff summary |
| `heartbeat(intent)` | write | Renews the lease. Returns inbox messages and drift alerts. |
| `report_push(intent, sha)` | write | Actual footprint compared with the declared one. Overlap updates. |
| `send_note(to_intent, text)` | write | Delivered on the recipient's next tool call |
| `mark_ready(intent)` | write | Queued for the next train. Returns its risk and policy outcome. |
| `claim_conflict(id)` / `resolve_conflict(id, sha)` | write | Replay workflow |
| `why(repo, path, line)` | read | Goal → intent → reasoning → alternatives → evidence → session link |
| `fork_session(intent)` | write | A new fork of the session, to continue someone else's work |

Agents push with **plain `git`**. `flare push` is a thin wrapper that
also calls `report_push`. This makes "any agent works" literally true.

### 3.4 Policy (`.flare/policy.yml` in trunk)

```yaml
protected: [ "src/auth/**", "migrations/**" ]   # intents here stop at awaiting_plan
auto_land_max_risk: 30                            # 0-100
audit_sample: 0.05                                # fraction of auto-landed routed to humans
lanes: { max_per_train: 50, max_parallel: 8, speculation_depth: 3 }
replay: { max_attempts: 2, race_k: 3 }            # race_k>1 = resolution tournament
```

`flare.yml`, `.flare/**` and `.github/workflows/**` are **always**
protected (`BUILTIN_PROTECTED` in `intents-core.ts`), merged into every
policy and not removable by it: they are the pipeline that produces the
green evidence and the policy itself, so an agent cannot lift its own
guardrails by editing them. The built-ins also feed the risk score's
protected-path term (declared or undeclared drift).

### 3.5 Risk score (deterministic and explainable; never a bare LLM number)

Risk runs from 0 to 100. It is the **sum** of these contributions (the
weights are capped and tuned on the simulator):

| Signal | Contribution |
|---|---|
| Footprint touches a protected path | +40 |
| Footprint size | log-scaled, up to +15 |
| Drift: undeclared files touched | +15 |
| Resolved by an LLM replay | +15 |
| CI evidence weak: no tests touched the footprint, or a flaky test was quarantined | +10 |
| The clean-context reviewer agent disagrees with the author | +15 |
| Actual footprint truncated (fail closed: unseen files may be protected) | +40 |

The inbox shows **which terms fired**. Explainability is the UX.

---

## 4. Architecture

```
               ┌──────────────────────── Worker (API, MCP, dashboard) ───────────────────────┐
 agents ─MCP/REST─►  routes ─RPC─► RepoCoordinator DO (1 per repo)                           │
 any git ─push──►   Artifacts       ├─ SQLite: intents, leases (range-indexed paths), mailbox │
                    trunk (agents   ├─ overlap query = O(overlap) via path ranges             │
                    read-only)      ├─ alarm: lease expiry sweep, train cut                   │
                    i-<id> forks    └─ ──► LeaseShard DOs (prefix buckets) when hot           │
                                                                                              │
 cf.artifacts.repo.pushed ─► Workflow trigger (namespace-wide) ─► reconcile + dedupe (repo,after)
                                                                                              │
 Train = Cloudflare Workflow (durable steps):                                                 │
   1 partition lanes  2 merge in MemoryFS (isomorphic-git) / seat `git merge-tree` if hard    │
   3 push train/<n>   4 dispatch Flare CI on exact SHA, wait (durable sleep)                  │
   5 green: CAS fast-forward main + write refs/notes/why + revoke fork tokens                  │
     red: bisect → requeue halves;  merge conflict → open Conflict                            │
                                                                                              │
 Feed DO (hibernating WebSockets, 4–10 Hz batched deltas) ─► dashboard live map + inbox       │
 AgentPool DOs ×100 (simulator; alarm-driven, separate `flare-sim` namespace)                 │
 Workers AI via AI Gateway: planner, replay resolver, reviewer, rationale                     │
 Flare executor (existing): seats/runners, checks, digests, triage, quarantine                │
               └──────────────────────────────────────────────────────────────────────────────┘
```

**Why each choice.** Have these ready for Q&A.

- **Fork per intent:** this is Artifacts' documented best practice
  ("10,000 agents → 10,000 repos"). Each fork gets its own git rate
  budget, and forks give isolation and a per-intent session record.
- **Train as a Cloudflare Workflow:** it waits on CI for minutes, must
  survive restarts and must not double-apply. Durable steps provide
  exactly that, and it shows off the platform. The DO **decides**; the
  Workflow **executes**.
- **Coordinator as a plain DO** with SQLite and hibernation:
  - Agents SDK `setState` rewrites and broadcasts the whole state, and
    `McpAgent` is deprecated.
  - Path ranges replace `LIKE`, because DO SQLite caps `LIKE` patterns
    at 50 bytes and allows 100 bound params per query.
- **Agents report pushes; a namespace-wide Workflow trigger
  reconciles.** Queue push subscriptions are per repo, and 10k forks
  can't each have one. Delivery is at-least-once, so we dedupe on
  `(repo, after)`.
- **isomorphic-git for the fast path, seat containers for hard merges.**
  isomorphic-git has diff3 merge, `mergeDriver` and full notes support,
  but no rebase, and it fails when there are multiple merge bases. Real
  git `merge-tree --write-tree` in our existing seats covers the rest.
- **The Feed is separate from the Coordinator,** so broadcasting never
  stalls lease traffic. A DO has a soft limit of about 1,000 req/s.

### Scale math (for the pitch; numbers marked *projected* until measured)

| Layer | Load at 10k agents in 10 min | Limit | Verdict |
|---|---|---|---|
| Fork creation | ~167 / 10 s | 2,000 / 10 s per namespace | ✅ (shard namespaces for bursts) |
| Agent git traffic | Own fork each | 2,000 / 10 s **per fork** | ✅ no contention |
| Trunk pushes | ~100 trains (batches of ~100) | CAS serial | ✅ instead of 10k serial merges taking ~3 h |
| Coordinator | ~1k heartbeats/s at a 10 s cadence | ~1k req/s per DO | ⚠️ 60 s TTL + batched heartbeats + LeaseShards |
| Cost | ~30–50k Artifacts ops | $0.15 / 1k | **~$3–6 per 10k-agent run** (*projected*) |

**Two separate scale claims, kept honest:**

- **Coordination scale:** 100k intents declared and overlap-queried
  against the Coordinator and its shards. These are DO operations only,
  cheap, and a measured 100k is feasible.
- **Git scale:** 1k–10k agents doing real forks, pushes, trains and
  lands, measured.

This lets us honestly say "hundreds of thousands" for coordination
without faking git numbers.

---

## 5. Proof: the benchmark

Claims are cheap; a **baseline comparison** is what persuades. We run
the same synthetic workload (N agents, same goals, the same
overlap distribution) three ways, through the simulator:

| Mode | What it models |
|---|---|
| **Baseline: branch + PR + serial queue** | Today's workflow: each agent branches, merges one at a time, and the author rebases on conflict |
| **Forge without intents** (trains only) | Isolates the value of batching and lanes |
| **Forge, full** | Declare-time overlap, lanes, replay |

**Metrics, shown on one slide and in the README:**
- Changes landed per minute.
- Median time from declare to land.
- **Conflicts encountered** compared with **conflicts avoided at declare
  time**.
- Broken-`main` minutes. Target: 0.
- **Human review minutes required.** The model is plan approvals,
  stories, the audit sample and escalations, times a constant
  per-item cost.
- Artifacts ops and $ per 1k agents.

Without a baseline, "10k agents" is just a number. With one, it reads as
"N× throughput, zero red mains, 98% less human review".

---

## 9. The submission video (8:30; recorded, edited, captioned)

**Rules:**
- Show, don't tell. Every claim appears on screen as it happens.
- Real numbers only.
- Cuts are fine; fakes are not.
- 1080p, large fonts, a dark dashboard, cursor highlighting.

| Time | Beat | On screen |
|---|---|---|
| 0:00 | **Hook** | "10,000 agents, one repo. Who's doing what? What happens when they collide? What does a human review? Why does this line exist?" Then the live map at full scale, dots flowing into `main`. |
| 0:35 | **First principles** | One slide: code is cheap now, attention and trunk are scarce, so **intent is the unit**. The four questions collapse into one primitive. |
| 1:15 | **Goal → plan** | A human types a goal. The planner proposes 12 intents with footprints. One touches `src/auth`, so it waits for plan approval, which takes one click. |
| 2:00 | **Q1, awareness** | 6 real Claude Code agents claim intents. Agent 4 declares and gets "agent 2 is changing `middleware.ts` because …" before writing code. It adjusts its plan and sends a note. A drift alert fires when agent 5 touches an undeclared file. |
| 3:15 | **Q2, conflicts** | A train with 3 lanes runs in parallel. One lane fails CI on the combined SHA, so it bisects, finds the culprit and lands the rest. A real merge conflict opens; replay runs with the other intent's why, CI goes green, it lands. |
| 4:45 | **Q3, review** | The inbox: 1 story, 12 intents. 10 auto-landed (risk terms shown), 1 audit sample, 1 needs a human. A side-by-side resolution race. The human spends about 90 s. |
| 5:45 | **Q4, why** | Click a line in the repo view. The chain: goal → intent → reasoning → rejected alternative → CI run → reviewer → **fork session** → a new agent continues from that exact context. |
| 6:45 | **Scale + proof** | Simulator: 10k agents, measured trains/min, 0 main-red-from-integration minutes (exact-SHA, by construction; escaped defects shown separately), the baseline table, $ per 1k agents. |
| 7:45 | **How it's built** | One diagram: Workers, Artifacts (forks, notes, events, tokens), Durable Objects, Workflows, Queues, Workers AI, Containers. "No agent ever holds a trunk token." |
| 8:10 | **Try it** | Hosted URL plus `npm run forge:demo`. "Plain git and MCP: bring any agent." |

---

## 10. Finals (Oct 21, 10 minutes live)

- **Demo director:** `forge demo --stage <n>` resets the hosted instance
  to a known state for each beat. Every beat can be re-run in 10 s, so a
  live hiccup never kills the pitch.
- **Belt and braces:** pre-recorded clips of every beat play from local
  disk, plus a hotspot. Decide on the spot: live if healthy, clips if
  not.
- **Structure (10:00):**
  - 1:00 thesis
  - 6:00 live (Q1–Q4)
  - 1:30 scale and proof
  - 1:00 what's next, framed as Artifacts making this possible
  - 0:30 close
- **Live-only moment:** invite the room to watch a judge's own Claude
  Code (or ours, on stage) join the swarm by pasting one MCP config,
  live.

**Q&A drill (the answers are in this doc):**

| Likely question | Answer |
|---|---|
| Why not GitHub merge queue plus agents? | It serializes. It assumes humans review diffs. It loses the why. A1, A5 and A8 in §2. |
| Anthropic's Scion post (Oct 13) says a merge queue "doesn't make much sense at agent scale" and went post-merge. Why keep one? | We dropped the lock, not the verification: speculative stacked lanes, each verified as its own exact SHA, land the longest green prefix as soon as it is green, so trunk is never red. Ceiling = lanes in flight ÷ CI wall time; the Bookshelf run landed 11 in ~6 min (MEASURED). Their trade is a policy threshold away (lower `auto_land_max_risk`, audit after). README "Isn't a merge queue the wrong primitive". |
| What if an agent lies about its footprint? | The actual footprint is computed from every push, and drift adds risk and alerts. |
| What about semantic conflicts? | Trains verify the *combined* SHA, and a red train is bisected. |
| What if the LLM resolution is wrong? | It can't land without green CI. Weak coverage escalates to a human. Merge-Bench (<60%) is why. |
| How does this get to 100k? | Locality (O(overlap)), fork per intent (a git budget each), trains (about 100 trunk pushes), sharded DOs. Show the measured 100k declare bench. |
| Cost? | The measured $ per 1k agents. |
| Prompt injection between agents? | Mailbox content is labelled untrusted data and never triggers tools. Fork-scoped tokens and no trunk tokens. |
| Why git at all? | Models already know it, every agent speaks it, and Artifacts makes a million repos cheap. |
| What do humans actually do? | Approve plans on protected paths, skim stories, audit a 5% sample, resolve escalations. Shown as minutes in the benchmark. |

---

## 13. Sources

- Rules: https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf
- Brief: https://blog.cloudflare.com/next-git-platform-on-cloudflare/
- Artifacts launch: https://blog.cloudflare.com/artifacts-git-for-agents-beta/
- Artifacts docs (binding, git protocol, limits, pricing, events, best practices, isomorphic-git, sandbox): https://developers.cloudflare.com/artifacts/llms.txt
- DO limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Agents SDK state: https://developers.cloudflare.com/agents/runtime/lifecycle/state/
- isomorphic-git merge / notes: https://isomorphic-git.org/docs/en/merge, https://isomorphic-git.org/docs/en/addNote
- Cursor, scaling long-running agents: https://cursor.com/blog/scaling-agents
- Cognition: https://cognition.com/blog/dont-build-multi-agents
- Anthropic multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Uber SubmitQueue: https://www.uber.com/blog/slashing-ci-costs-at-uber/
- Zuul gating: https://zuul-ci.org/docs/zuul/9.4.0/gating.html
- Graphite batching and bisection: https://graphite.com/blog/merge-queue-batching
- Merge-Bench: https://homes.cs.washington.edu/~mernst/pubs/merge-bench-icpr2026-abstract.html
- Agent Trace: https://www.infoq.com/news/2026/02/agent-trace-cursor
- git-ai: https://usegitai.com/docs/how-git-ai-works
