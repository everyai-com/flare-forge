# Recording the demo

> Provenance: agent-drafted 2026-10-14. The beats below were walked on the
> hosted deployment against the `bookshelf` repo (a fresh
> `forge:demo` + `forge:agents --mode scripted --count 6` run) through the
> product app; nothing here depends on fixture data.

The app at `/app?repo=<name>` is the only screen you need. Every beat is a
page of the app on real data; the **Demo** page inside the app carries the
same script, a guided tour that walks it, and live readiness checks.

## Before you press record (15 minutes)

1. **Train CI.** Trains run on cloud seats; a local runner is optional:
   ```sh
   npm run runner          # optional, from a clone of this repo, with .env
   ```
2. **Fresh trunk and goals**, then the swarm. `--recreate` resets the repo
   so the board starts empty; without it the swarm appends to what is there.
   ```sh
   npm run forge:demo -- --repo bookshelf --recreate
   npm run forge:agents -- --mode scripted --count 6 --repo bookshelf
   ```
   The swarm takes about 8 minutes end to end and plants every beat: two
   overlaps, one real conflict and its replay, one semantic failure (page
   size 25 vs 30) that a train bisects out, and one protected-path intent
   that waits for a human.
3. Open `/app?repo=bookshelf` signed in as the admin, **Explain** on, dark
   theme, 1440×900. Open **Demo** once and check that every readiness line
   is green except "something waits for a human" (that is the API-key
   intent; leave it waiting for beat 6).
4. Spectators: Settings → Spectator mode must list `bookshelf`, so the
   links at the end of the video work without a token.

If something goes wrong mid-recording, `npm run forge:director -- stage <n>
--repo bookshelf` jumps the repo to a beat (`forge:director -- list`).

## The beats (about 7 minutes)

| Time | Beat | Page | Say / show |
|---|---|---|---|
| 0:00 | Hook | Overview | "Six agents, one repo, no pull requests." The board: intents in every column, cards moving right, the feed narrating. The four questions on the top of **How it works** are the structure of the next six minutes. |
| 0:40 | A goal | New goal | Type one sentence, **Plan with AI**, **Launch**. Intents appear in *Declared*. "An intent is what, where, why and how to prove it." |
| 1:30 | Declare → overlap | Intents | Open the intent that declared on `src/index.ts`: its mailbox shows the note the other owner received, labelled untrusted. Point at a *drift* chip: "the actual footprint is computed from the push; agents cannot lie." |
| 2:30 | Trains | Trains | Lanes merging and verifying. The red lane: open it, show the failing step and the triage, then the rebuilt lanes landing. "main only moves to a commit whose own run passed." |
| 3:40 | Conflict | Conflicts | `src/middleware/logging.ts`: both sides with their reasoning, the resolver's replay, the resolution SHA that had to pass CI again. |
| 4:40 | Review | Review | 10 landed on their own, 1 audit sample, the API-key plan waiting because `src/auth/**` is protected. Click **Approve plan**. The feed records "operator approved the plan". |
| 5:30 | Why | Repository | Files tab, open `src/lib/validate.ts`, click a line: commit → intent → goal → reasoning → CI run → session. Commits tab: every commit names its intent. CI runs tab: "this is Flare Actions, not GitHub Actions; the flare.yml on the right ran on the exact merged commit." |
| 6:20 | Bill, build, join | Usage, How it works (the map), Agent MCP | Ops per landed change measured from Cloudflare's events. The invariants. One line to connect Claude Code; **Try it** shows what an agent sees. Close on the repo link and `/app?repo=bookshelf`. |

Rules: say what the screen shows as it shows it; real numbers only; cuts
are fine, fakes are not.

## Links to put in the submission

- Product, read-only: `https://<worker>/app?repo=bookshelf`
- Live map alone: `https://<worker>/watch?repo=bookshelf`
- Read-only MCP for a judge's own Claude Code:
  `claude mcp add --transport http flare-forge-watch https://<worker>/v1/public/forge/mcp`
- Source: https://github.com/everyai-com/flare-forge
