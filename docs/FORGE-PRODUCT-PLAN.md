# Flare Forge: the product, the repo, and the last 60 hours

> Provenance: agent-drafted 2026-10-12 (IST morning, PDT Sunday night).
> - Artifacts facts come from developers.cloudflare.com (pricing page,
>   open-beta changelog) and blog.cloudflare.com (competition brief),
>   all fetched 2026-10-12.
> - Repo facts come from a read-only audit of `everyai-com/flare-actions`
>   at `56a3c84` (the commit the production worker was deployed from on
>   2026-10-10) and from probing the production worker on 2026-10-12.
> - Every number marked *estimate* or *SIMULATED* is not a measurement.
>   Nothing goes on a slide without being measured or labelled.
> - The detailed engineering plan, rules, scoring and Q&A drill stay in
>   [COMPETITION-PLAN.md](COMPETITION-PLAN.md). This document is the
>   product decision, the repo decision, and the schedule from here to
>   submission.

---

## 0. Two questions, answered

### "Did we make Artifacts?"

No. **Cloudflare made Artifacts.** It is their Git-compatible versioned
file system: beta on 2026-04-16, open beta on 2026-10-01, Workers Paid
plan only. **We build on it.** Flare Forge is a layer above Artifacts:

| Artifacts gives us | Forge uses it for |
|---|---|
| A repo per agent / task / session, "tens of millions" of them | One fork `i-<id>` per intent, plus session forks (`fork_session`) |
| Repo-scoped tokens | 1-hour write tokens scoped to the agent's own fork; trunk never gets a token |
| Events: created, imported, forked, deleted, pushed, cloned, fetched | `cf.artifacts.repo.pushed` drives the push Workflow (namespace-wide trigger, ~3 s) |
| Workers binding (`env.ARTIFACTS`): create, fork, read files, inspect commits | Trunk reads, fork creation, `flare.yml` lookup, the `why` chain |
| Git protocol | Agents use plain `git`; trains push `forge/lane-N` refs and `refs/notes/why` |

Binding name `ARTIFACTS`, production namespace `flare-tournaments`,
preview namespace `flare-forge-preview` (`wrangler.jsonc`). So the
answer to the post is: Cloudflare shipped the storage. Forge is one of
the things they asked people to build on it, and it is our entry in
their competition.

### What the two posts change

**Post 1 (Artifacts billing).** From **2026-10-14** (pricing page and
changelog; the competition blog says the 15th, plan for the 14th)
Artifacts bills **$0.15 per 1,000 operations** past 10,000 a month and
**$0.50 per GB-month** past 1 GB. Operations are "such as" create, push,
pull, clone. Consequence: **Artifacts operations are now a first-class
product metric.** A coordination layer that costs git operations to
answer "who is touching this file" is a layer that costs money on every
question. Forge's Coordinator answers that with Durable Object SQLite,
zero git operations (index bench: p50 0.19 ms, p99 1.1 ms at 100k
intents, FORGE.md "Benchmark"). We should measure and show it.

**Post 2 (Rhys Sullivan, 2026-09-05).** "Budgeting for 10x–100x volume
compounding, how is every service going to handle that? ... everyone
runs their own caches in front of the APIs they use, but then that
becomes a data access and freshness nightmare." This is the agent-scale
problem stated from the API side. It is exactly why Forge is shaped
the way it is:

- **The platform is the cache.** One Coordinator per repo holds the
  live state (intents, leases, footprints, mailbox). 10,000 agents
  asking "what's happening on `src/auth`" cost 10,000 DO reads, not
  10,000 clones.
- **Freshness comes from events, not polling.** Artifacts pushes
  `repo.pushed` to a Workflow in ~3 s; the Feed DO streams deltas over
  hibernating WebSockets. Agents never `git fetch` to find out what
  changed.
- **Git operations stay O(intent), not O(time).** An agent does one
  fork, one clone, two pushes. It does not fetch every 30 seconds to
  stay fresh, which is what a naive agent (or a per-agent cache) would
  do. The sim's assumption is 7 operations per intent, flat in swarm
  size.

**The line for the video:** *Artifacts gives every agent a repo. Forge
gives every repo one plan.* And, on billing day: *"Billing starts
today. Here is our bill for 10,000 agents."*

---

## 1. The decision: Forge is one product, in its own repo

**Decided 2026-10-10:** Flare Forge is the competition entry; Flare
Actions is a separate hosted CI product sold on its own. Until now both
lived in `everyai-com/flare-actions`, whose README already says "Flare
Forge" at the top while the repo name, package name and 31 links say
Actions. The judges get one link. It should be the product.

| | |
|---|---|
| **Repo** | `https://github.com/everyai-com/flare-forge` (created 2026-10-12, **private until you flip it**; the rules require public + MIT at submission) |
| **Seed** | Full history of `flare-actions` at `56a3c84`: the exact commit production runs. Nothing rewritten, every test and gate identical |
| **Name** | `flare-forge` matches the npm package (`npx flare-forge`), the MCP server name, the skill, and the `claude mcp add` one-liner people already paste |
| **Hosted demo** | Unchanged: `https://flare-actions.everyai-com.workers.dev` (worker name `flare-actions` in `wrangler.jsonc`). Renaming the worker before the finals is a risk with no judge-visible upside, so it waits (§6) |
| **What stays behind** | The uncommitted Actions-SaaS work in `flare-actions` (`console*.ts`, `cloud.ts` credits, `latency.ts`, `provision-cell*.mjs`, `pricing.json`, `docs/ACTIONS-*.md`). That is the other product |

### Why keep Flare Actions inside the Forge repo

Because it is the moat. COMPETITION-PLAN §0: "We're the only entry
with a real CI and execution engine. Others 'verify' with a model."
Every train, replay and race lands only on a SHA that Flare Actions ran
green. The engine is part of the product, not a dependency to hide. The
README keeps the "verification engine underneath" section and the
Deploy button.

### Governance until the engine is extracted (§6)

Two repos share the engine code for about two weeks. Keep it simple:

1. **Forge-owned paths** land in `flare-forge` only: `apps/worker/src/
   {forge*,intents*,train*,coordinator*,feed*,why*,replay*,tournaments*,
   provenance*,session*,artifacts-*}.ts`, `dashboard-forge-*.ts`,
   `apps/sim`, `examples/forge-demo`, `scripts/forge-*.mjs`,
   `skills/flare-forge`, `apps/cli/src/forge*.ts`, `docs/FORGE*.md`,
   `docs/COMPETITION-PLAN.md`, `docs/DEMO.md`, `docs/TOURNAMENTS.md`.
2. **Engine paths** (everything else) land in `flare-actions` first and
   are cherry-picked into `flare-forge` when Forge needs them. Expect
   zero or one such pick before submission.
3. **Production deploys from `flare-forge` `main`** from today until
   the finals (Oct 21). The `flare-actions` branch work deploys to
   previews only. One deploy source, no surprises on the demo URL.
4. `flare-actions` PR #18 (`feat/forge-intents` → `main`) can merge as
   is; it is the same history. After it merges, `flare-actions` `main`
   equals `flare-forge` `main` and the split starts from a clean point.

---

## 2. Positioning, refined

The four questions and the one primitive stay (README, COMPETITION-PLAN
§0). Add the question the posts just made everyone ask:

| Question | Forge's answer | Evidence to show |
|---|---|---|
| Who is doing what? | Intents, overlap at declare time | Live map, `whats_happening` |
| What happens on conflict? | Trains on the exact SHA, replay | A red lane bisected, a conflict replayed, both landed |
| What do humans review? | Risk-routed inbox | 12 intents, ~90 s of human time |
| Why does this line exist? | `why`, per line | Click a line, read the chain |
| **What does this cost at 10,000 agents?** | **Ops are O(intent); coordination is free of git ops** | **The ops ledger (§4, item 3): measured operations per landed change, in dollars at list price** |

Scoring reminder (terms PDF, COMPETITION-PLAN §1): 50% originality and
quality of the prototype (tie-breaker), 25% concurrency, coordination,
context, review and conflicts, 25% ease of use. The fifth row moves the
50% (nobody else will show a bill) and the 25% UX (a judge sees a
number they can check against Cloudflare's own metrics).

---

## 3. Where we actually are (verified 2026-10-12)

| Area | State | Verified how |
|---|---|---|
| Forge core: intents, Coordinator DO, trains, replay, races, `why`, MCP (14 tools), REST, SDK, CLI, skill | Shipped | `npm test` 108 files / 1371 tests at `56a3c84`; FORGE.md, FORGE-AGENTS.md |
| Dashboard live map, inbox, why panel, demo fixture mode, guided tour | Shipped | `GET /dashboard?demo=1` on prod returns 200 |
| Benchmark | **SIMULATED only** (seed 7, `7b37655`) | FORGE-BENCH.md says so on every table; no live harness run recorded |
| Artifacts ops | **Ledger built** (2026-10-12, branch `forge/ops-ledger`): Cloudflare's own events + binding meter, per intent, per landed change, priced. **Not yet measured live**: needs the deploy + item 1. The sim's git op model (FORGE-BENCH §2.3, 13.3 ops per landed change at 10k, no polling) stays labelled SIMULATED | `forge-ops.test.ts` (22 tests), binding meter exercised in `wrangler dev` against the real `ARTIFACTS` binding (2026-10-12) |
| Live run against a deployed worker + real Artifacts | A `wrangler dev` run on 2026-10-10 (FORGE.md "Live run") | DEMO.md provenance: "Nothing here has been run against a deployed Worker or Artifacts yet" |
| Spectator mode (`/watch`, public read-only MCP) | Code shipped, **not enabled on prod** | `GET /watch` and `GET /v1/public/forge/mcp` return 404 on prod |
| Demo tooling (`forge:demo`, `forge:agents`, `forge:director`) | Dry-run verified only | DEMO.md provenance |
| Publishable CLI | `npm publish` not yet run by a human | COMPETITION-PLAN status board |
| Eligibility | Open: US/Canada resident, 18+, in SF on Oct 21 | Status board: Varun to confirm with git-competition@cloudflare.com |
| README "start here" | Written (2026-10-12): hosted URL, spectator link + public MCP one-liner, `forge:demo`, concept, ops table with the live row marked *pending* | Links to `/watch` work only once item 2 enables spectator mode on prod |
| Video, submission | Not done | This document, §5 |
| Repo | `flare-forge` created, private, history pushed | This session |

The honest summary: the product is built and tested; **nothing has been
measured live**, and the judge-facing surface (public watch page, start
here, video) is not up yet. The next 60 hours are about measurement
and the judge path, not features.

---

## 4. The last-mile list, ranked by score moved

Everything below is ordered by the rubric. Each item has a cut rule.
The cut order in COMPETITION-PLAN §8.5 still applies to the feature
set; this list is what's left on top of it.

| # | Item | Moves | Effort | Cut rule |
|---|---|---|---|---|
| 1 | **Live run on prod**: `npm run forge:demo`, then `forge:agents --mode scripted`, then `--mode real` with 6 Claude Code agents. Record timings, fix what breaks | 50% + 25% | 6–10 h incl. fixes | Never cut. Without it every number is simulated |
| 2 | **Spectator mode on prod**: `POST /v1/admin/forge/public {"repos":["bookshelf"]}`, the `apps/sim` demo-loop keeping the swarm alive, `/watch` and the public MCP one-liner in the README | 25% UX | 2–3 h after item 1 | Never cut. It is the judge's two-minute path |
| 3 | **Ops ledger** (new, from the posts): count Artifacts operations per repo and per intent, show "ops per landed change" and dollars at list price on the live map counters, `forge snapshot`, and the README table | 50% | 3–4 h | Cut to a SIMULATED column labelled "assumption: 7 ops/intent" if item 1 slips past Tue 20:00 IST |
| 4 | **README "start here"** for judges: hosted URL, the public MCP one-liner, `npm run forge:demo`, the concept in 3 lines, the measured table | 25% UX | 1 h after items 1–3 | Never cut |
| 5 | **`why` on Forge's own repo**: mirror `flare-forge` into Artifacts, land one intent through a train, run `flare why` on a line of `intents-core.ts` in the video | 50% | 1–2 h after item 1 | Cut if item 1 is still red on Tue night |
| 6 | **Video** (8:30 cut, COMPETITION-PLAN §9), captioned | All | 5–6 h | Never cut |
| 7 | **Fresh-account dry run** of the judge path from the public repo | 25% UX | 1 h | Never cut |
| 8 | `npm publish --workspace apps/cli`, MCP registry listing, GitHub repo description for `flare-actions` back to Actions | Hygiene | 30 min, human | Publish before the video; the rest can follow |
| 9 | GitHub bridge land-out (mirror in exists; land back as a PR) | Adoption | 1 day | Post-submission (§6) |

### Item 3 in one paragraph (the ops ledger)

Open beta added `cf.artifacts.repo.cloned` and `cf.artifacts.repo.fetched`
events next to `pushed`. Subscribe the existing namespace-wide push
Workflow trigger to all three, attribute each event to its fork
(`i-<id>` → intent) or to trunk, and keep a per-repo counter in the
Coordinator (operations by kind, by intent, by train). Add the binding
calls we make ourselves (fork, token, read) at the one place they
happen in `forge-service.ts` and `train.ts`. Expose `ops` on the
snapshot counters and in `report_push` / `mark_ready` payloads, and
print `ops per landed change` with dollars at $0.15 per 1,000. The
baseline column (a naive agent that fetches every 30 s to stay fresh
over the sim's work time) is *projected* and labelled as such. The
measurement comes from Cloudflare's own events, so a judge can check it
against the Artifacts metrics dataset in their dashboard.

---

## 5. Schedule (IST, with PDT), Mon Oct 12 → Thu Oct 15 12:29 IST

Deadline: **Wed Oct 14, 23:59 PDT = Thu Oct 15, 12:29 IST.** Internal
submit target: **Wed Oct 14, 20:00 IST (07:30 PDT)**, which leaves a
16-hour buffer for a failed upload or a re-record. No resubmission is
allowed, so the submission must be final when it goes in.

| When (IST) | PDT | Milestone | Exit criteria |
|---|---|---|---|
| Mon 12, 10:00–13:00 | Sun 21:30–00:30 | **Repo cutover** (this session) | `flare-forge` has the plan, the README start-here, links repointed, gates green, pushed |
| Mon 12, 13:00–22:00 | Mon 00:30–09:30 | **Item 1, scripted**: `forge:demo` + `forge:agents --mode scripted` against prod | All 13 Bookshelf intents land; the conflict replays; the semantic red bisects; the protected intent waits. First timings written into DEMO.md with a provenance line |
| Mon 12, 22:00–01:00 | Mon 09:30–12:30 | **Item 2**: spectator mode enabled, demo-loop running | `/watch?repo=bookshelf` is live; the public MCP answers "what are the agents doing" |
| Tue 13, 09:00–14:00 | Mon 20:30–01:30 | **Item 1, real agents**: 6 Claude Code agents, one goal end to end | Transcript + timings recorded. Any failure fixed and re-run |
| Tue 13, 14:00–19:00 | Tue 01:30–06:30 | **Item 3**: ops ledger; **item 5**: `why` on Forge itself | Ops counters on the live map from real events; `flare why apps/worker/src/intents-core.ts:1` prints a chain |
| Tue 13, 19:00–22:00 | Tue 06:30–09:30 | **Item 4**: README start-here with the measured table; FORGE-BENCH gets a MEASURED section | A fresh reader reaches the live map and the MCP one-liner in under 2 minutes |
| **Tue 13, 22:00** | **Tue 09:30** | **Freeze.** Bug fixes, docs and video only | Gates green on `flare-forge` `main`; `git status` clean of secrets |
| Wed 14, 09:00–15:00 | Tue 20:30–02:30 | **Item 6**: record, edit, caption (8:30 cut) | Every number on screen is measured or says *projected* |
| Wed 14, 15:00–17:00 | Wed 02:30–04:30 | **Item 7**: fresh-account dry run of the judge path from the *public* repo | Passes untouched; **repo is public** |
| **Wed 14, 20:00** | **Wed 07:30** | **Submit by hand.** Screenshot the confirmation | Done |
| Oct 15–21 | | Finals prep: director stages reliable, three rehearsals (one offline), Q&A drill | Ready for Moscone, Oct 21 |

Parallelism: items 1 and 2 are one person on the deployment; item 3
can be built in a worktree while item 1 runs; the video script
(COMPETITION-PLAN §9) can be rehearsed against the fixture mode before
the live numbers exist.

---

## 6. After submission (Oct 15–Nov)

| When | What | Why |
|---|---|---|
| Oct 15–21 | Finals hardening only (COMPETITION-PLAN §10) | No new features unless the judges' brief asks |
| Oct 22+ | **Extract the engine**: `packages/flare-engine` (worker core + runner-sdk) consumed by both `flare-forge` and `flare-actions`; each product keeps its own routes, dashboard and `wrangler.jsonc` | Ends the cherry-pick phase; lets Actions ship its SaaS console without touching Forge |
| Oct 22+ | Rename the Forge worker (`flare-forge`), keep a redirect from the old demo URL | Only after the finals |
| Oct 22+ | **GitHub bridge**: mirror in (exists, `artifacts-mirrors.ts`), land out as a PR or push | The adoption wedge: teams keep GitHub as the source of truth and get Forge coordination today |
| Nov | Hosted Forge (multi-tenant cells, the same tenancy answer as Actions) | The competition's own framing: millions of repos need a landlord |

---

## 7. Billing day (Oct 14) and the ops budget

Artifacts starts billing while the public demo loop is running. The
account must be on Workers Paid (it is; Artifacts is unavailable
otherwise).

*Estimate* from the sim constants, not a measurement: one Bookshelf
loop lands 13 intents at about 7 operations each (≈ 91) plus 4 lanes of
train traffic (≈ 50), so roughly 150 operations per 30-minute loop,
about 7,000 a day, about $1 a day after the 10,000-operation monthly
allowance. Storage is in the kilobytes per fork. Forks are deleted
after landing (plan §8.2, S3). The sim harness uses its own namespace.
Guardrails: watch the Artifacts metrics dataset on Oct 14; the demo
loop has a pause switch; item 3 turns this estimate into a measurement
by Tuesday.

---

## 8. Submission checklist (updated for the new repo)

- [ ] Submitter confirmed: US/Canada legal resident, 18+, in SF Oct 21;
  a second traveller named.
- [ ] `everyai-com/flare-forge` is **public**, MIT `LICENSE` at the
  root, no secrets (`git status` clean of `.env`, `.dev.vars`,
  `worker-configuration.d.ts`, `apps/seats/wrangler.jsonc`).
- [ ] README top: "Competition entry: start here" with the hosted URL,
  the public MCP one-liner, `npm run forge:demo`, the concept in 3
  lines, the measured table.
- [ ] `npm run forge:demo` passes from a fresh account, timed.
- [ ] Video 5–10 min, captioned, no disparagement, every number
  measured or labelled.
- [ ] CI green on `flare-forge` `main` (`.github/workflows/ci.yml`).
- [ ] Submitted once, by hand, by Wed Oct 14 20:00 IST. Screenshot kept.

---

## 9. Risks added by the cutover

| Risk | Mitigation |
|---|---|
| Two repos drift during the week | §1 governance: Forge paths here, engine paths there, cherry-pick once; prod deploys from here only |
| Links still point at `flare-actions` | Docs, README, `package.json`, `llms.txt` and the dashboard demo banner are repointed in this commit. Engine code URLs (`runner-script.ts`, `forge-init.ts`, the CLI deploy hint) stay on `flare-actions` on purpose: they describe the engine, and that repo stays public |
| Repo is private when a judge clicks | Flip to public before the Wed dry run (§5); the submission form is filled in after that |
| CI badge shows nothing until the first run | The first push to `main` runs `ci.yml` |
| Deploy button points at a private repo | Same flip; the button reads `wrangler.jsonc` at the root, unchanged |
| The Actions SaaS session commits engine changes Forge needs | Cherry-pick by sha; never merge the branch |
