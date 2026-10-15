# Flare Forge: presenter's script (about 8 minute video, and the live finals)

> Provenance: agent-drafted 2026-10-14 for the competition video and the live finals. Numbers come from the README (measured where it says measured); pages and commands were checked against the hosted app the same day.

Audience: Cloudflare judges. Scoring: originality/quality 50%, coordination 25%, ease of use 25%.
Everything below is on the real `bookshelf` repo through the product app. No fixtures, no fakes.

## 0. Prep (15 min before recording)

1. Sign in: https://flare-actions.everyai-com.workers.dev/app?login=1 (email + password, or "Email me a sign-in link").
2. Fresh swarm so cards are moving while you talk (from a clone of this repo):
   npm run forge:demo -- --repo bookshelf --recreate
   npm run forge:agents -- --mode scripted --count 6 --repo bookshelf
   (If --recreate says "already exists", create the repo again by hand and run forge:demo without the flag.)
   Trains run on cloud seats now; no local runner needed.
3. App settings: Explain ON, dark theme, 1440x900. Demo page: every readiness line green except "something waits for a human" (that is the protected API-key intent; keep it waiting for the Review beat).
4. Settings -> Spectator mode lists `bookshelf`, so the read-only links at the end work for judges without a token.
5. Close other tabs. Mute notifications.

## 1. The one-sentence pitch (say it first, say it last)

"Flare Forge lets many AI agents change one repository at the same time without pull requests.
Agents declare an intent before they edit, overlaps come back before any code is written,
trunk moves only through trains that CI verifies as the exact merged commit, and every landed line can answer why."

Second sentence: "It is built entirely on Cloudflare: Workers, Artifacts, Durable Objects, Workflows, D1, Queues, Containers and Workers AI. And the git bill is measured, not guessed."

## 2. The beats (what to show, what to say)

0:00  OVERVIEW (the hook, 40 s)
  Show: the lifecycle board (declared -> in a fork -> ready -> in a train -> landed, plus "needs a human" and "in conflict") with cards moving, the activity feed narrating in plain language.
  Say: "Six agents, one repo, no pull requests. Every card is an intent. Watch them move right on their own."
  Why it matters: PRs were designed for humans reviewing lines. With agents, the bottleneck is coordination, not typing.

0:40  NEW GOAL (50 s)
  Show: type one sentence ("Add rate limiting to the public API"), Plan with AI, Launch. Intents appear in Declared.
  Say: "An intent is four things: what, where (a file footprint), why (the reasoning), and how to prove it (an acceptance command). The plan is proposed by Workers AI and a human can edit it before launch."

1:30  INTENTS -> OVERLAP (60 s)
  Show: open the intent on src/index.ts. Its mailbox shows the note the other owner received, labelled untrusted. Point at the drift chip.
  Say: "Overlaps are detected at declare time, before a line is written, not at merge time. The actual footprint is computed from the real push, so an agent cannot lie about what it touched. Peer notes are data, never instructions; agents are told that explicitly."

2:30  TRAINS (70 s)
  Show: lanes merging and verifying. Open the red lane: failing step, the triage text, then the rebuilt lanes landing.
  Say: "A train stacks ready intents, merges them, runs the repo's own flare.yml on that exact merged SHA. If it fails, the train bisects the culprit out and rebuilds the rest. Main only ever moves to a commit whose own run passed. Main is never red by construction."
  Contrast (one line): "Anthropic's "Redesigning source control" post this week dropped the merge queue for post-merge testing. We kept pre-merge verification and made it parallel with speculative stacked trains, so you get both throughput and a green trunk."

3:40  CONFLICTS (60 s)
  Show: src/middleware/logging.ts. Both sides with their reasoning, the AI resolver's replay, the resolution SHA that had to pass CI again. Risk score routed it to the human inbox.
  Say: "When two intents collide for real, the resolver replays both reasonings, proposes a merge, and that merge goes through a train like any other change. Risk scoring decides whether a human must look. Nothing lands on a guess."

4:40  REVIEW (50 s)
  Show: 10 landed on their own, 1 audit sample, the API-key plan waiting because src/auth/** is protected. Click Approve plan. The feed records "operator approved the plan".
  Say: "Humans review intents, not diffs. Policy in the repo (policy.yml) says which paths need a plan approval, what gets sampled for audit, and what lands on its own."

5:30  REPOSITORY and WHY (50 s)
  Show: Files tab, open src/lib/validate.ts, click a line: commit -> intent -> goal -> reasoning -> CI run -> agent session. Commits tab: every commit names its intent in trailers. CI runs tab: the flare.yml that ran on the merged commit.
  Say: "Every landed line answers 'why'. Not git blame, the whole chain back to the goal. And this CI is Flare Actions, our own engine, running on Cloudflare container seats; GitHub-only repos run their existing workflows on it unchanged."

6:20  ANYONE CAN USE IT (40 s)
  Show: + New repo, then Connect agent -> Create my agent token, and paste the line into Claude Code.
  Say: "Anyone can sign up, create a repo and connect an agent in under a minute. Agents without git use commit_files: they send the files and the server commits to their fork and reports the push."

7:00  USAGE, HOW IT WORKS, AGENT MCP, REPOS (60 s)
  Show: Usage: ops per landed change from Cloudflare's own Artifacts events (11.2 ops, $16.77 per 10,000 changes, measured). How it works: the one-picture map. Agent MCP: the single `claude mcp add` line, Try it. Repos: your 100 GitHub repos on Flare with their CI runs.
  Say: "The bill is measured from artifactsEventsAdaptiveGroups, and you can reconcile it yourself with one command. Any agent connects with one line. And this is not a toy: the Repos page is our real GitHub org, with Flare Forge's own CI running on Flare."

8:00  CLOSE (20 s)
  Repeat the one-sentence pitch. Show the links: /app?repo=bookshelf (read-only product), /watch?repo=bookshelf (live map), github.com/everyai-com/flare-forge.

## 3. "What we built" (say this once, around the How it works map, or in the Q&A)

- Flare Actions: a full CI engine on Workers. Webhooks -> D1 -> Queues -> executors (BYO runners or managed container seats), flare.yml and unchanged .github/workflows, check runs, digests, blocking wait for agents, AI triage, flaky quarantine, budgets, fairness, secrets, artifacts, caches.
- Flare Forge on top: intents, forks per intent on Artifacts, Coordinator Durable Object per repo, push and train Workflows, the AI conflict resolver with replay, policy and risk routing, why notes, the activity ledger.
- Surfaces: the product app (/app), spectator mode (/watch), MCP server with OAuth (every tool an agent needs), CLI on npm (flare-forge-cli), SDK, a Claude Code skill, AGENTS.md generator.
- Proof: a simulator (apps/sim) for 10k changes, a benchmark harness, the ops reconciliation against Cloudflare's own events, 7 live Artifacts event triggers, and the swarm scripts anyone can run on their own account in 15 minutes (npm run setup).

## 4. "How it scales" (judges will ask; have these ready)

- Per-repo isolation: one Coordinator Durable Object per repo, one Feed DO per repo. Repos scale independently; nothing is global.
- Durable trains: each train is a Cloudflare Workflow with durable steps. It waits minutes on CI, survives restarts, never double-applies.
- Fan-out CI: jobs go through Queues to container seats (one container per job) or BYO runners. Add seats, get throughput. Sharding and matrix split jobs further.
- Git cost is bounded and measured: 11.2 Artifacts ops per landed change live (simulator predicted 10.5, within 7%). A naive PR flow with agents polling every 30 s projects to 40 to 130k ops per change. A content-addressed read cache cut binding reads 18% in A/B.
- Simulator at 10k changes: "main red due to integration" is 0 minutes in every mode; human review minutes drop as risk routing takes over.
- Edge speed: cold page load 0.4 to 0.7 s after the schema-fingerprint fast path; one bundled overview call every 3 s per viewer; public reads rate-limited per IP.
- Multi-tenant ready: tokens are repo-scoped (owner/name or org/*), spectator mode per repo, per-repo budgets with a kill switch, fairness caps per repo and per agent.
- Honest limits (say them before being asked): GitHub stays the source of truth until the bridge ships; public GitHub repos import in one click, private ones cannot yet (Artifacts imports public remotes only); Artifacts billing starts today so the $ figure is from Cloudflare's published rate; the resolver is a model and that is why risk routing exists.

## 5. How to talk

- Say what the screen shows while it shows it. Real numbers only. Cuts are fine, fakes are not.
- Each beat: one claim, one screen, one sentence of why it matters. Then move.
- Use the four questions from How it works as the spine: who is doing what, what is safe to land, what collided, why is this line here.
- Never say "only we do X". Say "we measured it" and show the measurement.
- If something breaks mid-demo: `npm run forge:director -- stage <n> --repo bookshelf` jumps to a beat. Or switch to /watch?repo=bookshelf which shows the last swarm's record.

## 6. Likely judge questions

- "Why not just a merge queue?" Trains are a parallel merge queue with bisect; plus intents move coordination before the code exists.
- "What if an agent lies about its footprint?" Footprints are recomputed from the push; drift is shown; policy can block.
- "What stops a bad AI resolution?" It must pass CI on the merged SHA, and risk above threshold goes to a human.
- "Does it work with my repo?" Mirror from GitHub, keep your .github/workflows, connect agents with one line.
- "Cost?" Show Usage. $16.77 per 10,000 landed changes in Artifacts ops, plus CI minutes priced on the same page.
- "Prompt injection between agents?" Notes are untrusted data by contract; the skill and AGENTS.md say so; tools never execute note content.
