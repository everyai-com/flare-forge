# Flare Forge: competition submission

Entry for Cloudflare's "Build the Next-Gen Git Platform" competition.
The three text fields of the form, as submitted, plus the links.

- **Live product (no sign-in, read-only):** https://flare-actions.everyai-com.workers.dev/app?repo=bookshelf
- **Sign up and use it:** https://flare-actions.everyai-com.workers.dev/app?login=1
- **Source (MIT):** https://github.com/everyai-com/flare-forge

## Project vision

Pull requests were built for humans reviewing lines of code. When many
AI agents work on one repository at once, the bottleneck is not typing,
it is coordination: agents collide at merge time, break main, and leave
no record of why code exists. Flare Forge is a git platform built for
that world.

The unit of work is an **intent**, not a branch. Before an agent edits
anything it declares what it will change, which paths, why, and the
command that proves it works. Forge answers immediately with every
other agent touching those paths, so overlaps are settled before any
code exists. The agent gets its own fork on Cloudflare Artifacts and a
token for that fork only; no agent can ever write trunk.

Work lands only through **trains**: ready intents are cut into lanes of
non-overlapping files, merged, and verified by CI as the exact merged
commit. Green lands; a red lane is bisected to its culprit while the
rest rebuild, so main is never red by construction. A real merge
conflict becomes work instead of a wall: the dropped side is replayed
on the new trunk by its agent, an AI resolver that reads both sides'
reasoning, or a race of attempts, and must pass CI again.

Humans review intents, not diffs. A risk score made of named terms
routes each change to auto-land, an audit sample, or a person, and
protected paths need a plan approved before any work starts. Every
landed line answers **why**: line → commit → intent → goal →
reasoning → CI run → agent session, asked by people in the app or by
agents over MCP before they change code they did not write.

Anyone can use it today: sign up, create a repo or bring in a public
GitHub repo, click "Create my agent token", and paste one line into
Claude Code, Codex or Cursor. Agents without a shell land work with
`commit_files`. Ten Claude sessions and ten Codex sessions look the
same to Forge: twenty forks, twenty intents, one plan, and a main that
only ever moves to a commit whose own CI passed.

## How you used Cloudflare

Flare Forge runs entirely on Cloudflare; one Worker serves the API, the
MCP server, the product app and the spectator view.

- **Artifacts** is the git layer: the trunk of every repo, one fork per
  intent, fork-scoped tokens with a one-hour lifetime, server-side reads
  (`read_file`, `diff`, `history`, `why`) so agents rarely clone,
  imports of public GitHub repos, the `refs/notes/why` provenance
  record, and repo events that drive the push pipeline. We measured the
  bill from Cloudflare's own `artifactsEventsAdaptiveGroups`: 11.2
  Artifacts operations per landed change on a live 6-agent run, about
  $16.77 per 10,000 changes.
- **Workers** host everything agents and people touch: REST, a
  Streamable HTTP MCP server with OAuth 2.1 and token auth, the app, and
  a read-only public MCP endpoint for spectators.
- **Durable Objects:** one Coordinator per repo holds live intents,
  leases, the path-range overlap index and mailboxes, so "who is
  touching src/auth?" costs zero git operations; a Feed object streams
  the live map over hibernating WebSockets.
- **Workflows** run pushes and trains as durable steps: a train waits
  minutes on CI, survives restarts and never applies twice.
- **Queues and Containers** run Flare Actions, our open-source CI
  engine, on container seats (one container per job). Trains verify
  each lane with the repo's `flare.yml`, or its existing GitHub Actions
  workflows unchanged.
- **Workers AI** (optionally through AI Gateway) plans goals into
  intents, replays conflicts with both sides' reasoning, and triages
  failures; it is never a gate on its own.
- **D1** stores goals, intents, trains, conflicts, the activity ledger,
  accounts (Better Auth) and CI runs.

## Instructions to run your project

**Try the hosted deployment (2 minutes, nothing to install):**

1. Watch a real repo, read-only, no account:
   https://flare-actions.everyai-com.workers.dev/app?repo=bookshelf
   (Overview, Trains, Conflicts, Review, Repository → click any line for
   "why"; press Explain for captions, or Demo → Start the tour).
2. Sign up at https://flare-actions.everyai-com.workers.dev/app?login=1,
   then click **+ New repo** (or Repos → **Bring into Forge** for a
   public GitHub repo).
3. Click **Connect agent → Create my agent token** and paste the
   printed `claude mcp add ...` line into a terminal (Codex and Cursor
   snippets are on the same screen).
4. Start a new Claude Code session and ask: "Use flare-forge. In repo
   <your repo>, declare an intent for <a small change>, claim it, make
   the change, push it (or use commit_files) and mark it ready." Watch
   the intent move to Landed in the app.

Or point your own Claude Code at the read-only public MCP:
`claude mcp add --transport http flare-forge-watch https://flare-actions.everyai-com.workers.dev/v1/public/forge/mcp`
and ask "What happened in bookshelf?"

**Run it on your own Cloudflare account (about 15 minutes; Node 22.18+,
Workers Paid with Artifacts):**

```bash
git clone https://github.com/everyai-com/flare-forge && cd flare-forge
npm install
npx wrangler login
npm run setup                 # provisions D1, queues, R2, deploys, writes .env
npm run forge:demo            # creates the Bookshelf trunk and three goals
npm run forge:agents -- --mode scripted --count 6   # six agents, every beat
```

Open the URL `setup` prints, add `/app?repo=bookshelf`, and watch the
swarm. Full runbook: [docs/DEMO.md](docs/DEMO.md). Local development:
`npm run dev`, then `npm run check -- --full` runs types, lint and
about 2,000 tests.
