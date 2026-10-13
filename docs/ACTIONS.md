# Flare Actions: the CI and verification engine under Forge

> Every Forge train, replay and race lands only on a SHA that Flare
> Actions ran green, as that exact SHA. This page documents the engine on
> its own; the product and the competition entry are in the
> [README](../README.md). Flare Actions also continues as a standalone
> project at [everyai-com/flare-actions](https://github.com/everyai-com/flare-actions).

Every train, replay and race is verified by **Flare Actions**, an
open-source CI system you host on your own Cloudflare account. It is
useful on its own too: repos without a `flare.yml` run their existing
`.github/workflows/*.yml` unchanged, and agents get a one-call verify
loop.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/flare-forge)

## For AI agents: move a repo's CI off GitHub Actions

Cheapest path first; the full playbook is
[`skills/flare-migrate`](../skills/flare-migrate/SKILL.md).

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

## Pick your path

Every path runs your existing `.github/workflows` files **unchanged**:

| Path | Setup | What you get |
| --- | --- | --- |
| **One click + GitHub App** (recommended) | Deploy button → dashboard → **Connect GitHub** → install | Push/PR runs, commit statuses, Check Runs, PR comments, private repos |
| **One click, no App** (public repos) | Deploy button → copy the webhook secret in Settings → add one repo webhook to `https://<worker>/webhooks/github` | Push/PR runs from your existing workflows, nothing installed on GitHub |
| **Dispatch only** (agents, no webhooks) | Issue an API token → `cli run owner/repo HEAD` or MCP `run_and_wait` | Verify any commit, or an uncommitted working tree, on demand |
| **Runner mode** (stay on GitHub) | Settings → enable `runs-on: flare` → change one `runs-on:` line | GitHub keeps orchestrating; Flare supplies ephemeral runners, and checks and logs stay put ([docs/GITHUB-RUNNERS.md](GITHUB-RUNNERS.md)) |
| **Self-host from source** | `npm install && npm run setup` | Everything, fully under your control |

Unsupported actions are dropped with warnings instead of silently
misbehaving ([support matrix](GITHUB-ACTIONS-COMPAT.md)). The
native `flare.yml` format wins when present, and `cli import` migrates
a workflow with a warning report.

## Quickstart

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
([docs/CONTAINERS.md](CONTAINERS.md)). Updates, backups and
secret rotation are in [docs/OPERATIONS.md](OPERATIONS.md).

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

## One command: `npx flare-forge connect`

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
[flare-setup skill](../skills/flare-setup/SKILL.md) teaches an agent the
same loop.

## Built for agents

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
  next-step `hint` ([docs/ERRORS.md](ERRORS.md)).
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
generation, and the Forge tools ([docs/MCP.md](MCP.md)).

## Pipelines, runners and the rest

- **Pipelines** (`flare.yml`): matrices, `needs`, concurrency,
  containers, services, cache, artifacts, `retry:`, `shards:`, bounded
  `if:` conditions, `${{ secrets.NAME }}` (encrypted, masked)
  ([docs/PIPELINES.md](PIPELINES.md)).
- **Runners:** BYO machines on any OS advertise labels and pull jobs;
  managed seats cover Linux with no machines at all
  ([docs/RUNNERS.md](RUNNERS.md)).
- **Scheduled runs**, **status badges**, **AI failure triage** (Workers
  AI), **email + chat notifications**, **budgets and a kill switch**,
  **flaky-test quarantine**, and a **merge queue**
  ([docs/MERGE-QUEUE.md](MERGE-QUEUE.md)).
- **Dashboard** at `/dashboard`: the Forge views (Live, Inbox, Intents,
  Trains, Conflicts, Agents, Bench) next to Runs, Races, Repositories,
  Merge queue and Settings. `⌘K` opens the command palette.
- **Preview environments:** `npx wrangler preview` gives every branch
  an isolated staging Worker (shared staging D1 and queues, never
  prod).

## CLI

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

## Cost

The core (webhooks, dispatch, dashboard, D1 history, queues, R2 cache
and artifacts) fits Cloudflare's free tier at small-to-medium scale.
Managed seats use Cloudflare Containers, which need the Workers Paid
plan ($5/mo base); Artifacts also needs Workers Paid. BYO runners stay
free. Every run reports its compute minutes plus the Actions list-price
equivalent, so the gap is a number, not a claim
([cost receipts in the Actions repo](https://github.com/everyai-com/flare-actions)).
