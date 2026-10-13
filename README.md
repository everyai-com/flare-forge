# Flare Forge

[![CI](https://github.com/everyai-com/flare-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/everyai-com/flare-forge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=22.6](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)

**Pull requests ask what changed. Agents need a system that knows what
everyone is about to change, and why.**

Flare Forge is intent-native git for many agents working on one repo,
built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/).
Before an agent edits anything, it declares an **intent**: what it will
change, which paths, why, and how to prove it worked. Forge answers
with whoever else is touching those paths, gives the agent its own fork,
and lands the work on trunk only through a train that CI verifies as
the exact merged commit. Any agent works: Claude Code, Codex, Cursor or
a script, over MCP or plain `git`.

![Flare Forge live map: a new agent (C10) declares an intent on src/routes/books.ts and Forge answers with the overlap before any code exists; three steps across the top explain declare, overlap, verified trains](docs/img/forge-live.png)

<sub>Live map, **demo data**: the moment an agent (C10) declares an intent
and Forge answers with the overlap (i-77b4 already touches
`src/routes/books.ts`) before any code is written. The Bookshelf scenario
from `examples/forge-demo`, rendered by the dashboard's `?demo=1` fixture
mode, loops every ~80 s. It is not a measurement.</sub>

## Competition entry: start here

This repo is Flare Forge's entry for Cloudflare's
["Build the next Git platform"](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
competition (Workers + Artifacts, submissions close Oct 14, 2026).

1. **Watch** the live map, no sign-in: [flare-actions.everyai-com.workers.dev/dashboard?demo=1&tour=1#/live](https://flare-actions.everyai-com.workers.dev/dashboard?demo=1&tour=1#/live) (demo data, rendered in your tab).
2. **Watch a real swarm** (spectator mode, read-only): [/watch?repo=bookshelf](https://flare-actions.everyai-com.workers.dev/watch?repo=bookshelf), or ask your own Claude Code what the agents are doing:

   ```bash
   claude mcp add --transport http flare-forge-watch https://flare-actions.everyai-com.workers.dev/v1/public/forge/mcp
   ```

   Then: *"What are the agents doing in bookshelf right now, and what has it cost in Artifacts operations?"*
3. **Run it on your own account** in about 15 minutes: `npm run setup`, then `npm run forge:demo` and `npm run forge:agents -- --mode scripted` ([docs/DEMO.md](docs/DEMO.md)). The run ends with a `report.json`: timings plus the ops ledger.
4. **Read the idea in three lines:** agents declare an *intent* (what, where, why, how to prove it) before editing; overlaps come back before any code is written; trunk moves only through trains that CI verifies as the exact merged SHA, and every landed line answers `why`.

Artifacts gives every agent a repo. Forge gives every repo one plan.

### What it costs at 10,000 agents

Artifacts bills operations from Oct 14, 2026 ($0.15 per 1,000 past
10,000 a month). Forge answers "who is touching `src/auth`?" from a
Durable Object, with zero git operations, so its git traffic grows
with the number of changes, not with time. The **ops ledger** counts
every Artifacts operation from Cloudflare's own events (created,
forked, imported, deleted, pushed, cloned, fetched), attributes each
to its intent or to trunk, and prices it per landed change
([docs/FORGE.md](docs/FORGE.md#ops-ledger)). It is on the live map,
in `forge snapshot`, in `report_push` / `mark_ready`, and in the
public MCP.

| | Ops per landed change | $ per 10,000 changes | Status |
|---|---|---|---|
| **Forge, Bookshelf swarm on the hosted deployment** (6 agents, 13 intents, 11 landed, 1 semantic culprit failed, 1 conflict raced and landed) | **11.2** (fork 1.1, pull 6.6, push 3.5) | **$16.77** | **MEASURED** by Cloudflare's own `artifactsEventsAdaptiveGroups`, 2026-10-12 12:51-13:00 UTC; check it yourself with `npm run forge:ops-reconcile` |
| Forge, simulator, 10 agents, no polling | 10.5 | $15.75 | **SIMULATED** ([FORGE-BENCH §2.3](docs/FORGE-BENCH.md)): the live run landed within 7% of it |
| Forge, simulator, 10k agents, no polling | 13.3 | $20.01 | **SIMULATED** |
| PR flow + serial queue on the same repo, simulator, 10k agents | 9.9 | $14.78 | **SIMULATED** |
| The same PR flow, agents fetching every 30 s (while working .. until landed) | 39.7 .. 133,322 | $60 .. $199,982 | **Projected**, not measured |

The live counter on `/watch` and in `forge_snapshot` reads higher (14.4
per landed change) because it also counts the first, failed attempt of
that day and predates two ledger fixes (forks were missed, pushes were
counted per ref); the row above is Cloudflare's own count of the clean
run, and `npm run forge:ops-reconcile` prints both.

Cloudflare also logged 668 reads and 132 token create/revoke calls in
that run (61 and 12 per landed change). The pricing page names create,
push, pull and clone; it does not say whether reads or tokens bill. If
they do, the same run costs 83.9 operations per landed change.

Without polling, Forge spends more git ops per landed change than a PR
flow in the simulator (10.5 vs 6.2 at 10 agents, 13.3 vs 9.9 at 10k:
replays and speculative lane rebuilds refetch); it wins against agents
that poll, and it buys trains, replay and `why` with the difference. The train reuses fork objects across lane
rebuilds (shipped 2026-10-12); the simulator's full cache design, which
also has replays fetch once, brings Forge to 9.4 at 10k agents.

The product plan, the repo decision and the schedule to submission are
in [docs/FORGE-PRODUCT-PLAN.md](docs/FORGE-PRODUCT-PLAN.md); the full
engineering plan is [docs/COMPETITION-PLAN.md](docs/COMPETITION-PLAN.md).

## Four questions, four answers

| The question | Forge's answer |
|---|---|
| **Who is doing what?** | **Intents.** `declare_intent` returns every live intent whose footprint overlaps yours, before any code is written. `whats_happening` asks the same for any set of paths. Agents settle overlaps with `send_note`. |
| **What happens when changes conflict?** | **Trains and replay.** Ready intents ride trains split into lanes of non-overlapping footprints. CI runs on the exact combined SHA, and a red train is bisected. A real merge conflict becomes claimable work: the dropped intent is *replayed* on the new trunk (by its agent, an AI resolver, or a [resolution race](docs/TOURNAMENTS.md)) and must pass CI again. |
| **How do humans review it all?** | **A risk-routed inbox.** Every verified intent gets a deterministic risk score made of named terms. Policy routes it to auto-land, a 5% audit sample, or a human. Protected paths need a human to approve the plan before any work starts. |
| **Why does this line exist?** | **`why`, per line.** Agent commits carry `Flare-Goal/Intent/Agent/Session` trailers, and every train writes a `refs/notes/why` record. `why {repo, path, line}` walks line → commit → intent → goal → reasoning → CI evidence → session. |

Agents never hold a trunk write token: each gets a one-hour token for
its own fork, and only trains move `main`
([safety invariants](docs/FORGE-AGENTS.md#5-safety-invariants-enforced-here)).

## Watch it live

**[Open the live demo →](https://flare-actions.everyai-com.workers.dev/dashboard?demo=1&tour=1#/live)**
No sign-in. Seven agents work on the Bookshelf demo repo, and a
four-step tour explains what you're seeing. It runs on sample data in
your browser tab; nothing is written anywhere.

## Try it in 2 minutes

1. **Watch.** Open the [live demo](https://flare-actions.everyai-com.workers.dev/dashboard?demo=1&tour=1#/live). No sign-in needed.
2. **Run the dashboard locally on demo data.**

   ```bash
   git clone https://github.com/everyai-com/flare-forge && cd flare-forge
   npm install && npm run dev
   # open http://localhost:8787/dashboard?demo=1#/live  (no sign-in; demo data)
   ```

   `wrangler dev` proxies the Artifacts and Workers AI bindings to your
   account, so run `npx wrangler login` once first.

3. **Run a real swarm on your own Cloudflare account** (about 15
   minutes, Node 22.18+; every step is in [docs/DEMO.md](docs/DEMO.md)):

   ```bash
   npm run setup                                     # deploy + provision, writes .env
   # trains need CI: managed seats (setup, with Docker) or Home → "Use my computer"
   npm run forge:demo                                # create the Bookshelf trunk + 3 goals
   npm run forge:agents -- --mode scripted --count 6 # six agents, every designed beat
   ```

## Connect your agent

```bash
export FLARE_ACTIONS_URL=https://<your-flare>.workers.dev
export FLARE_TOKEN=<runner token>                     # never commit it
npx flare-forge doctor                                # checks setup; ends with one next: command
npx flare-forge forge connect-agent --client claude   # or codex | cursor
npx flare-forge forge init                            # AGENTS.md block + .mcp.json for this repo
```

To make every repo and agent on a machine know Flare at once, run
`npx flare-forge forge init --global`. For other GitHub orgs and
Cloudflare accounts, see [docs/EVERYWHERE.md](docs/EVERYWHERE.md).

`connect-agent` prints a one-line `claude mcp add ...` and the workflow
prompt. `forge init` makes a repo Forge-ready for every agent: an
idempotent AGENTS.md block ("declare before you edit", the loop,
etiquette) and an MCP entry whose token is an env-var reference, so the
file is safe to commit (`--dry-run` shows the diff). From a clone,
`npm run cli -- forge ...` is the same command. The protocol, payloads
and error codes are in [docs/FORGE-AGENTS.md](docs/FORGE-AGENTS.md); the
[flare-forge skill](skills/flare-forge/SKILL.md) teaches the loop to
Claude Code.

```
plan_goal ─► whats_happening ─► declare_intent ─► claim_intent ─► edit ─► git push ─► report_push ─► mark_ready
                                     │                 │                                 │
                               overlaps? send_note     heartbeat (lease, notes, drift) ◄─┘
```

## How it's built

```
 agents ──MCP / REST──►  Worker: API, MCP server, dashboard
 any git ──push──────►     │
                           ├─► RepoCoordinator DO (one per repo): intents, leases,
                           │     path-range overlap index, mailbox
                           ├─► ForgeFeed DO: hibernating WebSockets for the live map
                           │
 Artifacts ───────────────┤   trunk (agents read-only) · i-<id> fork per intent
                           │   refs/notes/why · repo.pushed events
                           │
 cf.artifacts.repo.pushed ─► Workflow (push trigger): reconcile + dedupe
 Train Workflow (durable steps): partition lanes ─► merge ─► push train ref
                           ─► Flare CI on the exact SHA ─► fast-forward main + write why note
                           red: bisect · conflict: open a claimable Conflict ─► replay
 Queues ─► Containers (managed seats) and BYO runners: the Flare Actions executor
 Workers AI (optionally via AI Gateway): planner, replay resolver, race rationale, triage
 D1: goals, intents, trains, conflicts, ledger, runs
```

The Coordinator decides and the Workflow executes: trains wait on CI
for minutes, must survive restarts and must not double-apply, which is
what durable Workflow steps give us. Design notes and Q&A:
[docs/COMPETITION-PLAN.md §4](docs/COMPETITION-PLAN.md#4-architecture).
Data contracts: [docs/FORGE.md](docs/FORGE.md).

## Benchmark (SIMULATED)

> These numbers come from a deterministic simulator
> (`apps/sim/src/sim.ts`, seed 7, commit `7b37655`, 2026-10-10). It
> drives Forge's **shipped** train executor: lanes, speculative stacking,
> bisect and the exact-SHA landing rule. It also calls the real overlap
> and risk functions. These are **not measurements**. Every constant is
> listed, with its source, in [docs/FORGE-BENCH.md](docs/FORGE-BENCH.md),
> along with the live harness. Reproduce with
> `npm run forge:bench -- --agents 1000,10000 --seed 7`.

Same workload, three ways: N agents declare one intent each within 10
minutes on one repo.

| Agents | Mode | Landed | Abandoned | 80% landed by | Human review min |
|---:|---|---:|---:|---:|---:|
| 1,000 | Baseline: branch + PR + serial queue | 988 | 12 | 6d 13h | 10,636 |
| 1,000 | Trains only (one group in flight) | 986 | 14 | 9h 17m | 10,774 |
| 1,000 | Forge (intents + speculative trains + replay + routing) | 998 | 2 | 7h 16m | 2,180 |
| 10,000 | Baseline: branch + PR + serial queue | 8,860 | 1,140 | 66d 23h | 120,580 |
| 10,000 | Trains only (one group in flight) | 8,708 | 1,292 | 4d 12h | 122,809 |
| 10,000 | Forge (intents + speculative trains + replay + routing) | 9,820 | 180 | 2d 14h | 37,693 |

**"Main red due to integration" is 0 minutes in every mode**, because
`main` only ever moves to a SHA that CI verified as that exact SHA.
Escaped defects (bugs no CI catches) are reported separately in
FORGE-BENCH.

What the simulation says, and what it doesn't, is spelled out in
[FORGE-BENCH.md](docs/FORGE-BENCH.md):
- Speculative stacking carries most of the throughput.
- Intents and risk routing carry the human minutes and the abandoned
  changes.
- Interaction defects (changes that fail only together) set the ceiling.
- An earlier version of this table came from a model that landed
  unverified combinations. It has been corrected, and the before/after
  is kept in that doc.

---

## Flare Actions: the CI and verification engine underneath

Every train, replay and race is verified by **Flare Actions**, an
open-source CI system you host on your own Cloudflare account. It is
useful on its own too: repos without a `flare.yml` run their existing
`.github/workflows/*.yml` unchanged, and agents get a one-call verify
loop.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/flare-forge)

### For AI agents: move a repo's CI off GitHub Actions

Cheapest path first; the full playbook is
[`skills/flare-migrate`](skills/flare-migrate/SKILL.md).

```bash
# 1. No account, no server: run the repo's existing .github/workflows here
npx flare-forge local
npx flare-forge import .github/workflows/ci.yml   # compatibility report

# 2. With a Flare deployment (the human deploys once, see below)
#    The human mints a one-time code in dashboard Settings → Pair a runner
npx flare-forge login --url https://<their-worker>.workers.dev --code XXXX-XXXX
#    (saves FLARE_ACTIONS_URL + RUNNER_TOKEN to ./.env; keep it gitignored)
npx flare-forge connect --dry-run   # plan, change nothing
npx flare-forge connect             # dispatch HEAD, report the verdict

# 3. Wire the verify loop into your MCP client (OAuth, or a Bearer token)
claude mcp add --transport http flare https://<their-worker>.workers.dev/mcp
```

Then use `run_and_wait` → `get_run_digest` instead of polling. Every
deployment also serves its own `https://<worker>/llms.txt` with the URL
filled in, so "read `<url>/llms.txt` and move this repo's CI to Flare"
is a complete prompt (dashboard Home has it ready to copy).

**What needs a human:** deploying (a Cloudflare account; there is no
public hosted Flare yet), the first dashboard sign-up, and clicking
**Connect GitHub**. Ask before any GitHub-side change (webhooks, App
installs, `runs-on:` edits); never delete `.github/workflows`.

### Start here (no experience needed)
### Bring your GitHub repo to Forge

Keep GitHub. Import a repo once, and agents work on it through Forge.
Their landed work comes back as one rolling pull request. Your
existing `.github/workflows` verify every train, so you don't need a
`flare.yml`. Human commits and merged PRs flow back in by fast-forward.

```bash
npm run cli -- forge import https://github.com/acme/widgets   # or: dashboard → Agent forge → Import from GitHub
```

Sync modes (`pr`, `branch`, `direct`, `off`), safety rules and
permissions: [docs/FORGE-GITHUB.md](docs/FORGE-GITHUB.md).

## Start here (no experience needed)

Flare checks your code for you: every time you save your work to
GitHub, it runs your project's tests and tells you, in plain words, if
anything broke.

1. **Get your own Flare.** Press **Deploy to Cloudflare** above and
   follow the prompts (a free Cloudflare account is enough).
2. **Open it and make your account.** Go to
   `https://<your-flare>.workers.dev/dashboard`. The first person to
   sign up becomes the owner.
3. **Follow the Home page.** It shows a short checklist with one big
   button per step: connect GitHub, pick your projects, run your tests.
   Each step ticks itself off when it's done.

If your tests are waiting for a computer, Home offers **Use my
computer**: copy one line into the Terminal and that computer starts
running your tests. When something fails, **See what broke** shows the
failing step and a suggested fix.

### Pick your path

Every path runs your existing `.github/workflows` files **unchanged**:

| Path | Setup | What you get |
| --- | --- | --- |
| **One click + GitHub App** (recommended) | Deploy button → dashboard → **Connect GitHub** → install | Push/PR runs, commit statuses, Check Runs, PR comments, private repos |
| **One click, no App** (public repos) | Deploy button → copy the webhook secret in Settings → add one repo webhook to `https://<worker>/webhooks/github` | Push/PR runs from your existing workflows, nothing installed on GitHub |
| **Dispatch only** (agents, no webhooks) | Issue an API token → `cli run owner/repo HEAD` or MCP `run_and_wait` | Verify any commit, or an uncommitted working tree, on demand |
| **Runner mode** (stay on GitHub) | Settings → enable `runs-on: flare` → change one `runs-on:` line | GitHub keeps orchestrating; Flare supplies ephemeral runners, and checks and logs stay put ([docs/GITHUB-RUNNERS.md](docs/GITHUB-RUNNERS.md)) |
| **Self-host from source** | `npm install && npm run setup` | Everything, fully under your control |

Unsupported actions are dropped with warnings instead of silently
misbehaving ([support matrix](docs/GITHUB-ACTIONS-COMPAT.md)). The
native `flare.yml` format wins when present, and `cli import` migrates
a workflow with a warning report.

### Quickstart

**One click (no terminal):** hit **Deploy to Cloudflare**. Cloudflare
clones the repo into your account, reads the root `wrangler.jsonc`, and
provisions the Worker's D1 database, R2 bucket, queues and Workers AI
binding. Then open `https://<your-worker>/dashboard`, **create your
admin account** (first signup claims admin), hit **Connect GitHub**,
install the App on your repos, and push.

**From source:**

```bash
npm install
npm run setup             # provisions D1 + queues + R2, deploys, writes gitignored .env
npm run runner            # external pull-runner (reads .env automatically)
npm run cli -- runs       # list runs
npm run cli -- logs <id>  # run logs
```

`setup` is fully non-interactive and idempotent (`-- --dry-run` to
preview). With Docker available it also provisions **managed seats**:
scale-to-zero Cloudflare Containers that pick up eligible Linux jobs
([docs/CONTAINERS.md](docs/CONTAINERS.md)). Updates, backups and
secret rotation are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

<details>
<summary>Manual fallback and the env-managed GitHub App</summary>

Each step by hand: `wrangler d1 create`, `wrangler queues create` × 4
(`-runs`, `-dlq`, `-seats`, `-seats-dlq`),
`wrangler r2 bucket create flare-actions-cache`,
`wrangler d1 migrations apply --remote`, `wrangler secret put` for
`RUNNER_TOKEN`, then `npm run deploy`. Connect GitHub in the dashboard
manages the webhook secret and App credentials (encrypted at rest).

To manage the App through env instead, create it yourself (Contents
read, Pull requests read, Commit statuses write, Checks write; `push`
and `pull_request` events; webhook `https://<worker>/webhooks/github`),
then `wrangler secret put` `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID` and
`GITHUB_PRIVATE_KEY`, plus `ADMIN_TOKEN` as the dashboard recovery
password. Env wins, and Connect refuses while any of them is set.

</details>

### One command: `npx flare-forge connect`

From any repo, with `FLARE_ACTIONS_URL` pointed at your deployment:

```bash
npx flare-forge connect              # probe, explain the wiring, dispatch HEAD, report the verdict
npx flare-forge connect --dry-run    # print the plan, change nothing
npx flare-forge connect owner/repo --wire          # also create the repo webhook (needs GITHUB_TOKEN + FLARE_ADMIN_TOKEN)
npx flare-forge connect owner/repo --init --wire   # also scaffold flare.yml from the detected stack
```

`connect` detects your stack and pipeline, probes the deployment,
prints the exact wiring recipe, then dispatches HEAD with one bounded
wait. Exit 0 means connected and verified, 1 means the verification
run failed, 2 means a usage or environment error. The
[flare-setup skill](skills/flare-setup/SKILL.md) teaches an agent the
same loop.

### Built for agents

Agents trigger, wait and read results over the API, MCP or CLI, with no
sleep loops and no log spelunking.

- **One-call verify loop.** `run_and_wait` (MCP) or `cli run`
  dispatches and blocks until the run is terminal
  (`GET /v1/runs/:id/wait`), then returns a compact digest.
- **Token-efficient digests.** `GET /v1/runs/:id/digest` returns each
  job's failing step, exit code, a bounded output tail and AI triage in
  a few KB.
- **Zero-latency inner loop.** `cli local` runs `flare.yml` in the
  working tree with no server and no commit, on the same execution
  engine as the server. `cli run <repo> --source` runs an uncommitted
  tree server-side with full parity.
- **Priority lane, dry runs, stable errors.** `priority: 0–10` jumps
  batch work; `--dry-run` plans the fan-out with zero writes; every
  command takes `--json`, and API failures carry a stable `code` + a
  next-step `hint` ([docs/ERRORS.md](docs/ERRORS.md)).
- **Measured, not claimed.** `npm run bench` reports dispatch → pickup
  → terminal latency; on a local worker, p50 ≈ 38 ms / 17 ms / 63 ms.

```bash
npm run cli -- local                                   # run the working tree here, warm cache
npm run cli -- run owner/repo "$(git rev-parse HEAD)" --priority 9   # dispatch, wait, digest
npm run cli -- run owner/repo --source --priority 9    # uncommitted tree, server-side
npm run cli -- explain <runId>                         # verdict, failures, next command
```

Every deployment is also an MCP server at `/mcp` (OAuth, or a Bearer
API token): runs, digests, `run_and_wait`, reruns, flakes, pipeline
generation, and the Forge tools ([docs/MCP.md](docs/MCP.md)).

### Pipelines, runners and the rest

- **Pipelines** (`flare.yml`): matrices, `needs`, concurrency,
  containers, services, cache, artifacts, `retry:`, `shards:`, bounded
  `if:` conditions, `${{ secrets.NAME }}` (encrypted, masked)
  ([docs/PIPELINES.md](docs/PIPELINES.md)).
- **Runners:** BYO machines on any OS advertise labels and pull jobs;
  managed seats cover Linux with no machines at all
  ([docs/RUNNERS.md](docs/RUNNERS.md)).
- **Scheduled runs**, **status badges**, **AI failure triage** (Workers
  AI), **email + chat notifications**, **budgets and a kill switch**,
  **flaky-test quarantine**, and a **merge queue**
  ([docs/MERGE-QUEUE.md](docs/MERGE-QUEUE.md)).
- **Dashboard** at `/dashboard`: the Forge views (Live, Inbox, Intents,
  Trains, Conflicts, Agents, Bench) next to Runs, Races, Repositories,
  Merge queue and Settings. `⌘K` opens the command palette.
- **Preview environments:** `npx wrangler preview` gives every branch
  an isolated staging Worker (shared staging D1 and queues, never
  prod).

### CLI

The CLI ships on npm as `flare-forge` (bins `flare-forge` and `flare`);
from a clone, `npm run cli -- <command>` runs the same thing. Start with
`doctor`: it checks your setup and ends with one `next:` command. Every
command ends the same way (a failed run points at `explain`, an empty
list at `connect`, an error at the fix), in the form you typed.

```bash
npx flare-forge doctor                     # start here: what is set up, and the one next step
npx flare-forge forge <verb>               # Forge: goal|declare|claim|push|ready|status|why|inbox|conflicts|trains|connect-agent|init
npx flare-forge runs                       # list runs
npx flare-forge local [job]                # run flare.yml here (no server, warm cache)
npx flare-forge run <repo> <sha|--source>  # dispatch, wait, print the digest (exit 1 on failure)
npx flare-forge logs|explain|watch <runId> # inspect a run
npx flare-forge flaky|bottlenecks <repo>   # failure rates; slowest checks
npx flare-forge races|claim|verdict        # resolution races
npx flare-forge import <workflow.yml>      # Actions -> flare.yml
npx flare-forge login                      # pair this machine (writes .env)
```

`npx flare-forge --help` lists every command. Every command accepts
`--json` (one versioned envelope on stdout; `next:` lines are for
people and never appear in it).

<details>
<summary>HTTP API (selected routes; full spec at <code>/openapi.yaml</code>)</summary>

- `POST /v1/forge/goals`, `POST /v1/forge/intents`, `POST /v1/forge/intents/:id/{claim,heartbeat,push,ready,messages,fork-session,abandon,approve-plan}`: the Forge loop (run scope; plan approval is admin only)
- `GET /v1/forge/{whats-happening,inbox,snapshot,why,conflicts,trains}`: Forge reads (read scope)
- `POST /v1/runs/dispatch` (+ `/dry-run`): trigger a run by SHA, branch or tag, inline `pipeline`, `priority`, or `source`
- `GET /v1/runs`, `GET /v1/runs/:id`, `/wait`, `/digest`, `/artifacts`, `/tests`, `/egress`: run reads
- `GET /v1/jobs/next?labels=`, `POST /v1/runs/:id/status`, `.../heartbeat`: the runner protocol
- `GET|POST /v1/tournaments`, `POST /v1/tournaments/:id/claims`: resolution races
- `GET /v1/repos`, `/v1/repos/:name/{tree,blob,commits}`: browse the Artifacts namespace
- `POST /webhooks/github`: GitHub webhook (HMAC verified); `POST /mcp`: MCP JSON-RPC
- `GET|POST /v1/admin/*`: settings, tokens, users, schedules, secrets, audit (admin)

</details>

### Cost

The core (webhooks, dispatch, dashboard, D1 history, queues, R2 cache
and artifacts) fits Cloudflare's free tier at small-to-medium scale.
Managed seats use Cloudflare Containers, which need the Workers Paid
plan ($5/mo base); Artifacts also needs Workers Paid. BYO runners stay
free. Every run reports its compute minutes plus the Actions list-price
equivalent, so the gap is a number, not a claim
([docs/ECONOMICS.md](docs/ECONOMICS.md)).
## Agent tournaments (Cloudflare Artifacts)

Race N coding agents on one task: isolated forks, real CI per attempt,
collision radar, AI verdict, winner fast-forwarded, immutable ledger.
The dashboard shows it as **Races** + **Repositories** + **Merge queue**
next to Runs — same CI engine underneath, verifying every attempt.
Try it on staging in ~10 minutes — [docs/TOURNAMENTS.md](docs/TOURNAMENTS.md):

```bash
npm run cli -- login               # pair this machine (writes .env)
npm run cli -- races               # list races, or `races <id>` for one board
npm run cli -- claim <raceId> <agent>  # claim a lane (forks a workspace)
npm run cli -- verdict <raceId>    # ranking + why-it-won rationale
npm run cli -- repos [name]        # browse the Artifacts namespace
```

## Built for agents

GitHub Actions is built for humans — commit, push, then stare at a queue.
Flare is built for agents: trigger, wait, and read results over the API,
MCP, or CLI. No git ceremony, no sleep loops, no log spelunking.

- **One-call verify loop** — `run_and_wait` (MCP) or `cli run` dispatches
  and blocks until the run is terminal
  (`GET /v1/runs/:id/wait?timeout=60` under the hood). Verify → fix →
  repeat, without a polling loop.
- **Zero-latency inner loop** — `cli local` runs `flare.yml` in the current
  working tree, on this machine, with no server and no commit: the
  working-tree code, a warm local cache (`~/.flare/cache`), artifacts in
  `.flare/artifacts/`, and the same execution engine as the server
  (`continue-on-error`, `if:`, needs, matrix) with the same curated
  step env (`FLARE_*`, `CI=true`). `cli local --parity` reports
  image/cache/env divergences against the predicted cloud lane without
  running. Server dispatch stays the final parity check.
- **Priority lane** — `priority: 0–10` on dispatch jumps queued batch
  work, so an agent's verification beats the nightly backlog.
- **Explain, don't spelunk** — `cli explain <runId>` turns a run into
  one narrative: verdict first, then failing steps, output tails, triage,
  and exact rerun commands (`--json` included).
- **Dry-run dispatch** — append `--dry-run` to `run` / `dispatch`
  (including `--source`, with no upload) to plan the fan-out —
  queued/blocked + reasons, runtime priors, live group state, budget
  verdict — with zero writes.
- **Machine-shaped I/O** — every CLI command accepts `--json` (one
  versioned envelope on stdout), and API failures carry a stable `code`
  + next-step `hint` ([docs/ERRORS.md](docs/ERRORS.md)).
- **Token-efficient digests** — `GET /v1/runs/:id/digest` (or
  `get_run_digest`) returns each job's failing step command, exit code, a
  bounded output tail, and AI triage in a few KB — context-window friendly,
  no megabyte logs.
- **Near-instant pickup** — BYO runners poll every 2s idle / 500ms after a
  job; managed seats wake immediately over the queue.
- **Machine-readable everything** — per-step structured results with exit
  codes and durations; the dashboard is optional.
- **No git required** — dispatch by SHA or branch with an inline
  `pipeline`, or go further: `cli run <repo> --source` uploads a tarball
  of the working tree (50 MB cap, path-traversal-guarded on both
  executors) and runs it server-side with full parity — seats,
  containers, services — with **no commit anywhere**. Append `--dry-run`
  to `run` / `dispatch` (incl. `--source`, no upload) to plan the
  fan-out — queued/blocked + reasons, priors, budget — with zero writes.
- **Measured, not claimed** — `npm run bench` (against `npm run dev` or a
  deployment) reports dispatch → job pickup → terminal latency: on a
  local worker, p50 ≈ 38 ms / 17 ms / 63 ms. Nothing here waits on a
  2–3 minute hosted queue.

```bash
# agent inner loop: run the working tree locally, no server, no commit
npm run cli -- local                 # all jobs; warm cache across runs
npm run cli -- local test --file flare.yml

# agent verify loop: dispatch, wait, print the digest (exit 1 on failure)
npm run cli -- run owner/repo "$(git rev-parse HEAD)" --priority 9
npm run cli -- run owner/repo --source --priority 9   # uncommitted tree, server-side
npm run cli -- watch <runId>        # block on an existing run + digest
npm run cli -- dispatch owner/repo main --priority 9   # fire and forget
```

## Coming from GitHub Actions

**Drop-in:** delete nothing. If a repo has no `flare.yml`, Flare reads its
`.github/workflows/*.yml` at the commit and runs the matching workflows —
`on: push` / `pull_request` / `workflow_dispatch` / `schedule` are
honored, and `run:` steps, matrices, needs, concurrency, containers,
services, `actions/cache`, and `actions/upload-artifact` translate as-is.
JS/container actions and unsupported expressions are dropped **with
warnings**, never guessed at. Full support matrix + trigger mapping:
[docs/GITHUB-ACTIONS-COMPAT.md](docs/GITHUB-ACTIONS-COMPAT.md).

**Full fidelity:** migrate to the native format (better fidelity, richer
features like retries and egress allowlists):

```bash
npm run cli -- import .github/workflows/ci.yml > flare.yml
```

Translates `runs-on`, steps, matrices, needs, concurrency, containers,
services, caches, and artifacts; everything unmappable becomes a warning
on stderr (exit stays 0) so you see exactly what needs a human eye.

**No GitHub App?** For public repos, point a plain repo webhook at
`https://<worker>/webhooks/github` with the secret from the dashboard
(Settings → Webhooks) — runs trigger with no App installed. The App adds
private repos, commit statuses, Check Runs, PR comments, and GitHub login.

## Status badges

Public, embeddable, no token needed:

```markdown
[![flare](https://<worker>/v1/badge.svg?repo=owner/name&branch=main)](https://<worker>/dashboard)
```

`npm run cli -- badge owner/name main` prints the snippet. For
private repositories, list them under Settings → Status badges so the
public endpoint serves `unknown` instead of leaking pass/fail. For
required-checks UX, the GitHub App already posts commit statuses on
every run — mark them required in repo Settings → Branches.

## AI failure triage

Every failed job is triaged automatically by Workers AI
(`@cf/meta/llama-3.1-8b-instruct-fp8-fast`, inside the 10k-neurons/day
free tier): likely cause, culprit file/command, and one concrete fix.
It appears on the job in the dashboard and CLI. Forks without the AI
binding simply skip triage — nothing breaks.

## Notifications

Every finished run emails all registered email users: status, branch,
jobs, cost, and the AI triage excerpt on failures. Set the sender in
dashboard Settings → Run notifications (the domain must be enabled for
[Email Sending](https://developers.cloudflare.com/email-service/) first);
pick all completions, failures only, or off. Env `NOTIFY_FROM_EMAIL`
overrides the dashboard value. Deployments without a sender simply
skip — nothing breaks.

**Chat webhooks:** paste a Slack, Discord, or Mattermost-compatible
webhook URL in Settings → Run notifications and the same summary posts
there on every finished run — independently of email, so it works even
with no sender configured. The URL is write-only and encrypted at rest
with the secrets data key.

## CLI

```bash
npm run cli -- runs                    # list runs
npm run cli -- local [job]             # run flare.yml here (no server, warm cache)
npm run cli -- run <repo> <sha>        # dispatch, wait, print the compact digest (exit 1 on failure)
npm run cli -- run <repo> --source     # upload the working tree and run it (no commit needed)
npm run cli -- run|dispatch ... --dry-run  # plan the fan-out (queued/blocked/budget), zero writes
npm run cli -- watch <runId>           # wait on an existing run + digest
npm run cli -- cancel <runId>          # cancel queued/blocked jobs of a run
npm run cli -- logs <runId>            # jobs, steps, triage, logs
npm run cli -- explain <runId>         # one narrative: verdict, failures, next command
npm run cli -- dispatch <repo> <sha> [--priority N]   # trigger a run
npm run cli -- rerun <runId> <jobId>   # reset a finished job
npm run cli -- flaky <repo>            # per-job failure rates
npm run cli -- bottlenecks <repo>      # slowest checks: p50/p95 run time + queue wait
npm run cli -- quarantine list|add|remove <repo> [test]  # flaky-test quarantine (admin writes)
npm run cli -- tests <runId>           # per-test results and failing tests
npm run cli -- egress <runId>          # per-job egress by host
npm run cli -- queue [labels]          # live queue + projected claim order (admin)
npm run cli -- cache list|purge [prefix]  # cache entries (admin)
npm run cli -- cache stats             # shared warm-cache hit rate (7d)
npm run cli -- usage [days] [repo]     # runs, jobs, compute-minutes for billing
npm run cli -- paused                # repos auto-paused for runaway spend (admin)
npm run cli -- resume <repo>         # resume a paused repo (admin)
npm run cli -- search <query...>       # search all job logs (branch:main level:error ...)
npm run cli -- artifacts <runId>       # list artifacts
npm run cli -- badge <repo> [branch]   # badge snippet
npm run cli -- import <workflow.yml>   # Actions -> flare.yml
npm run cli -- mcp-config              # MCP client config
npm run cli -- devbox ...              # persistent warm dev boxes (local docker)
npm run cli -- connect [repo] [--wire] [--dry-run]  # probe, wire, and verify this repo in one command
npm run cli -- github-jobs [repo]      # ephemeral runner-mode jobs (status, duration, list price)
npm run cli -- login [--url U] [--code C]  # pair this machine (writes .env)
npm run cli -- races [raceId]         # list agent races, or one race board
npm run cli -- repos [name] [path]    # list forge repos, or browse one
npm run cli -- forge import owner/repo   # import a GitHub repo as a Forge trunk (two-way sync)
npm run cli -- claim <raceId> <agent>  # claim a race lane (forks a workspace)
npm run cli -- verdict <raceId>        # winner ranking + why-it-won rationale
```

Every command accepts `--json`: stdout becomes one versioned envelope
`{ version: 1, command, data }` (failures keep stderr + exit codes).
API failures carry a stable `code` + next-step `hint`
([docs/ERRORS.md](docs/ERRORS.md)); the CLI prints `hint [code]` after
the error line.

## API

- `GET /dashboard` — dashboard UI (`/` redirects here)
- `POST /webhooks/github` — GitHub App webhook (HMAC verified)
- `GET /mcp` — MCP server metadata (public); `POST /mcp` — MCP JSON-RPC
- `POST /v1/runs/dispatch` — trigger a run by SHA, branch, or tag, optional inline `pipeline`, `priority` (0–10), or `source` (uploaded working tree)
- `POST /v1/runs/dispatch/dry-run` — plan the fan-out with zero writes (run scope)
- `POST /v1/source` — upload a gzipped working-tree tarball (≤50 MB); `GET /v1/source/:id` — fetch it (run scope)
- `POST /v1/admin/pair-codes`, `POST /v1/pair/exchange` — mint a pairing code (admin), exchange it for a runner token (public, throttled)
- `GET /v1/github/jobs`, `POST /v1/github/jobs/next` — runner-mode job list + JIT claim lane (read / run scope)
- `GET /v1/bottlenecks?repo=&days=` — slowest checks: p50/p95 run time + queue wait (read scope)
- `GET /v1/cache/stats` — shared warm-cache hit rate over the trailing 7 days, overall plus per scope (read scope)
- `GET|POST /v1/quarantine` — list / add / remove quarantined tests (read scope; admin writes)
- `GET /v1/runs/:id/tests`, `GET /v1/runs/:id/egress` — per-test results, per-job egress (read scope)
- `GET /v1/admin/queue`, `GET /v1/usage?days=` — live queue, billing usage (admin / read scope)
- `GET|DELETE /v1/admin/paused` — kill-switch state: paused repos with attribution + one-click resume (admin only)
- `GET /v1/search/logs?q=` — full-text log search (read scope)
- `GET /v1/runs/:id/wait?timeout=` — block until terminal (1–90s), returns the run + `timedOut`
- `GET|POST|DELETE /v1/admin/secrets` — repo secrets, names listed, values write-only (admin only)
- `GET /v1/runs?limit=&offset=` — list runs, newest first (admin, runner, or readonly token; limit 1–200)
- `GET /v1/runs/:id` — run + jobs + cost summary (admin, runner, readonly)
- `GET /v1/runs/:id/digest` — compact agent digest: failing steps, bounded tails, triage (read scope)
- `GET /v1/runs/:id/artifacts` — list a run's artifacts (read scope)
- `GET /v1/jobs/next?labels=` — pull next matching queued job (run scope)
- `POST /v1/runs/:id/status` — runner status callback (admin or runner token)
- `POST /v1/runs/:id/jobs/:jobId/rerun` — reset a finished job (run scope)
- `POST /v1/runs/:id/jobs/:jobId/heartbeat` — executor liveness; running jobs quiet 20m+ are requeued (run scope)
- `PUT|GET /v1/cache/:key` — build cache blobs (run scope)
- `PUT|GET /v1/jobs/:jobId/artifacts/:name` — artifacts (run to write, read to fetch)
- `GET /v1/badge.svg?repo=&branch=` — status badge (public)
- `GET /v1/flaky?repo=&days=` — per-job failure rates (read scope)
- `GET /v1/admin/tokens` — list access tokens (admin only)
- `POST /v1/admin/tokens` — issue a token, shown once (admin only; optional `repos` scoping)
- `POST /v1/admin/tokens/:id/revoke` — revoke a token (admin only)
- `POST /v1/runs/:id/cancel` — cancel queued/blocked jobs of a run (running jobs finish naturally)
- `POST /v1/admin/reset`, `POST /v1/admin/reset/confirm` — self-serve password reset (public, throttled, single-use 1h link)
- `GET /v1/admin/audit` — audit log (admin only)
- `GET|POST /v1/admin/schedules` — list / create cron schedules (admin only)
- `POST /v1/admin/schedules/:id` — enable or disable a schedule (admin only)
- `DELETE /v1/admin/schedules/:id` — delete a schedule (admin only)
- `POST /v1/admin/generate` — natural language → `flare.yml` (admin only)
- `GET|POST /v1/admin/settings` — webhook secret, run notifications, badge visibility (admin only)
- `GET /v1/admin/users` — allowed GitHub users, email users, invites (admin only)
- `POST /v1/admin/users|users/email|users/invite` — allow/remove users, mint single-use invite links (admin only)
- `POST /v1/admin/register` — redeem an invite, or self-register by email when open registration is on (public, throttled)
- `POST /v1/admin/bootstrap` — first-run admin claim (open until claimed, throttled)
- `POST /v1/admin/login`, `POST /v1/admin/logout` — email sessions (throttled)
- `POST /v1/admin/magic/request`, `POST /v1/admin/magic/consume` — passwordless magic-link login (public, throttled, single-use 15 min; emailed links open a dashboard confirm screen so mail scanners cannot burn them)
- `GET|POST /v1/admin/github/*` — GitHub App connect + login flows
- `GET /v1/admin/status` — setup state for the dashboard (public)
- `GET /v1/tournaments`, `GET /v1/tournaments/:id` — race list + board: attempts, verdict, ledger (read scope)
- `POST /v1/tournaments`, `POST /v1/tournaments/:id/claims` — open a race, claim a lane (run scope)
- `GET /v1/repos`, `GET /v1/repos/:name` + `/tree`, `/blob`, `/commits` — browse the Artifacts namespace (read scope)

## Cost

The core — webhooks, dispatch, dashboard, D1 history, queues, R2
cache/artifacts — fits Cloudflare's free tier at small-to-medium scale:
Workers (100k requests/day), Queues (10k operations/day ≈ 3,300
dispatches/day), D1 (5M rows read + 100k rows written/day, 5 GB storage),
R2 (10 GB storage, zero egress). The **managed seats** executor adds
Cloudflare Containers, which need the Workers Paid plan ($5/mo base) —
BYO runners stay free. Retention keeps storage honest: finished runs and
their artifacts prune after 90 days, cache blobs after 90 days without a
hit, all bounded per pass. Every run reports its compute minutes
plus the Actions list-price equivalent, so the gap is a number, not a claim.
See [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/), and
[R2](https://developers.cloudflare.com/r2/pricing/) pricing.

## Give it to your agent

Clone the repo and point any coding agent at it:
[AGENTS.md](AGENTS.md) teaches it the stack, commands, architecture
and conventions. For your own repos, `npx flare-forge forge init` wires
Forge, `npx flare-forge init` scaffolds a `flare.yml` plus an AGENTS.md
snippet for the CI verify loop, and the skills in [`skills/`](skills)
(`flare-forge`, `flare-migrate`, `flare-verify`, `flare-setup`) work in Claude Code,
Codex and Cursor. [`llms.txt`](llms.txt) is the model-readable index.
For Cloudflare access, give an agent a per-Worker **Editor** token plus
D1 and Queues edit, never account-wide credentials.

## Layout

- `apps/worker`: the Worker (API, MCP server, dashboard, Forge
  coordinator, trains, webhook verify, queue consumer)
- `apps/seats`: managed executor (seat Durable Object + container image)
- `apps/runner`: external pull-runner
- `apps/cli`: the `flare-forge` CLI
- `apps/sim`: Forge simulator and live load harness
- `packages/runner-sdk`: shared client, job orchestrator, Actions importer
- `examples/forge-demo`: the Bookshelf demo repo and its designed scenarios
- `docs/`: [Forge agents](docs/FORGE-AGENTS.md), [Forge
  contracts](docs/FORGE.md), [demo runbook](docs/DEMO.md),
  [bench](docs/FORGE-BENCH.md), [pipelines](docs/PIPELINES.md),
  [runners](docs/RUNNERS.md), [MCP](docs/MCP.md),
  [operations](docs/OPERATIONS.md), [roadmap](docs/ROADMAP.md)

## License

MIT, see [LICENSE](LICENSE).
