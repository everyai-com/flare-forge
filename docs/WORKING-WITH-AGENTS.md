# Working with coding agents on one repo

> Provenance: agent-drafted 2026-10-14. Every command below was run
> against the hosted deployment or a local `wrangler dev` the same day;
> the loop was exercised by the scripted Bookshelf swarm
> (`npm run forge:agents -- --mode scripted --count 6`, 13 intents,
> 10 landed). Protocol details and payloads: [FORGE-AGENTS.md](FORGE-AGENTS.md).

This is the plain-language guide for a team whose changes arrive from
Claude Code, Codex, Cursor or any other MCP-speaking agent, several at a
time, on one repository. It answers one question: **what happens when
ten agents push at once, and what do I have to do about it?**

Short version: nothing lands by being pushed. Each agent works in its
own fork, trunk only moves through trains that CI verifies on the exact
merged commit, and you review intents, not diffs.

## 1. Connect an agent (one line each)

Every agent needs the MCP server URL and a token. A **runner** token
(Settings → Tokens, scoped to the repos it may touch) is the right
scope: it can declare, claim, push and read, and it can never write
trunk. The same screen is in the app under **Agent MCP → Connect an
agent**, with the three snippets filled in for your deployment.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http flare-forge https://<worker>/mcp --header "Authorization: Bearer $FLARE_TOKEN"` |
| Codex | add to `~/.codex/config.toml`: `[mcp_servers.flare-forge]` with `url = "https://<worker>/mcp"` and `bearer_token_env_var = "FLARE_TOKEN"` |
| Cursor | `.cursor/mcp.json` with the same URL and an `Authorization` header that references `${env:FLARE_TOKEN}` |
| Any shell, no MCP | `npx flare-forge-cli forge ...` (reads `FLARE_ACTIONS_URL` + `FLARE_TOKEN`) |
| OAuth clients | paste `https://<worker>/mcp` and sign in; no token needed |

`npx flare-forge-cli forge connect-agent --client claude|codex|cursor`
prints the snippet for you, plus the workflow prompt to give the agent.

To make a **repository** agent-ready for everyone who clones it:

```bash
npx flare-forge-cli forge init --dry-run     # shows the diff
npx flare-forge-cli forge init               # AGENTS.md block + .mcp.json (token as env ref)
```

The AGENTS.md block says "declare before you edit" and lists the loop,
so an agent that only reads files still follows the protocol. To wire
**every repo on a machine** at once, `npx flare-forge-cli forge init
--global` writes a Flare section into `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md`. Say what is wrong and how to fix it:
`npx flare-forge-cli doctor`.

## 2. What an agent does (the loop)

The agent runs these verbs itself; you watch them on the Overview board.
Every MCP tool has a CLI twin and a REST route under `/v1/forge/*`.

| Step | MCP tool | CLI | What Forge does |
|---|---|---|---|
| Look | `whats_happening {repo, paths}` | `forge status <repo> [paths]` | Lists live intents near those paths, from the repo's Coordinator Durable Object. Zero git operations. |
| Declare | `declare_intent {repo, title, reasoning, footprint, accept}` | `forge declare <repo> <title> --path P --accept CMD` | Records what, where, why and the command that proves it. Returns **overlaps** with other agents' footprints now, before any code, and notes the other owner. |
| Claim | `claim_intent {intentId}` | `forge claim <id> --clone` | Forks trunk on Cloudflare Artifacts for this intent only and mints a **1-hour token for that fork**. Returns the clone command and the commit trailers. |
| Work | plain `git commit` with the trailers, plain `git push` | `forge push` | The push lands on the fork. An Artifacts event starts the push Workflow: it verifies the SHA, computes the **actual footprint** from the diff, flags **drift** against what was declared, and scores risk. |
| Report, keep alive | `report_push {intentId, sha}`, `heartbeat {intentId}` | `forge push`, `forge heartbeat` | The heartbeat renews the lease and delivers peer notes as labelled untrusted data. An expired lease frees the work for someone else. |
| Ready | `mark_ready {intentId}` | `forge ready` | Policy routes the intent: under the risk bar it joins the next train; a sample is audited after landing; protected paths and anything over the bar wait in the human inbox. |
| Ask why | `why {repo, path, line}` | `forge why <repo> <path>:<line>` | Line → commit → intent → goal → reasoning → CI run → session. Agents ask this before changing code they did not write. |

The agent never receives a trunk token. Only the train Workflow writes
`main`.

## 3. What happens when they all push

1. **Overlaps are caught at declare time**, not at merge time. Two
   agents declaring `src/index.ts` both learn it instantly; the second
   gets the first one's reasoning and is told to narrow, split or send a
   note. Nothing is written yet, so nothing is wasted.
2. **Each push is verified, measured and scored.** Footprint drift (an
   agent touched a file it did not declare) raises risk and alerts the
   owner. Agents cannot lie about what they touched.
3. **Trains land the ready ones.** Ready intents are cut into lanes of
   non-overlapping files. Each lane is one merged commit with its own CI
   run on that exact SHA (Flare Actions runs the repo's `flare.yml`, or
   its unchanged `.github/workflows`). Green lands. A red lane is
   bisected to its culprit, which goes back to its agent with the
   failing step and the triage; the lanes behind rebuild without it.
   **`main` is never red.**
4. **A real conflict is work, not a wall.** When a lane cannot merge an
   intent, the dropped side is replayed on the new trunk: by its own
   agent, by the AI resolver (which reads the landed side's `why`), or
   by a race of several attempts. The resolution is a new SHA that must
   pass CI again, and an AI replay adds a risk term so policy can route
   it to a person.
5. **Humans review intents.** The Review page shows what landed on its
   own, what was audit-sampled, and what waits because
   `.flare/policy.yml` protects those paths. Approve the plan, send it
   back, or take it over. Every decision is recorded with its timing.
6. **Every landed line answers why.** Commit trailers and `refs/notes/why`
   are written at landing by the only writer of trunk. The Repository
   page and the `why` tool give the whole chain back to the goal.

Ten Claude sessions and ten Codex sessions look the same to Forge:
twenty forks, twenty intents, one plan.

## 4. Repos that live on GitHub

Forge's trunk is on Cloudflare Artifacts. For a repo whose source of
truth is GitHub, connect the GitHub App (Settings → GitHub) and Flare
mirrors it: the mirror's trunk follows GitHub's default branch on every
push, and the **Repos** page shows the GitHub repos the App can see with
their Flare CI runs. Today this is **coordination mode**: agents declare,
claim and verify through Forge, and still land through a GitHub PR plus
CI, closing the intent with `forge done <intentId>` once merged. The
bridge that lands trains back onto GitHub is a draft
([everyai-com/flare-forge#12](https://github.com/everyai-com/flare-forge/pull/12)),
so trunk writes stay on GitHub until it ships. This repository dogfoods
exactly that mode (see the Flare Forge block in `AGENTS.md`).

## 5. Letting people watch

- Spectator mode (Settings → Spectators) publishes a repo read-only:
  `https://<worker>/app?repo=<name>`, `https://<worker>/watch?repo=<name>`,
  and a token-free MCP endpoint `https://<worker>/v1/public/forge/mcp`
  with read-only tools, rate-limited per IP. A judge's own Claude Code
  can ask "what are the agents doing in bookshelf right now?".
- Accounts, sign-in and who can see what: [ACCOUNTS.md](ACCOUNTS.md).

## 6. Rules the server enforces (so you do not have to)

- No agent ever holds a trunk write token.
- Nothing lands without a green CI run on the exact SHA that lands.
- The actual footprint is computed from every push; drift is visible.
- Peer notes are delivered as labelled untrusted data and never trigger
  a tool.
- Every write is in the ledger, shown as the activity feed.

Full list with the enforcement points:
[FORGE-AGENTS.md §5](FORGE-AGENTS.md#5-safety-invariants-enforced-here).
