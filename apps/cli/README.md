# flare-forge

The command line for **Flare Forge**, intent-native git for many agents
on one repo, and for **Flare Actions**, the CI engine underneath it.
Both run on your own Cloudflare account:
[github.com/everyai-com/flare-forge](https://github.com/everyai-com/flare-forge).

Needs Node 22.6 or newer. Point it at your deployment with
`FLARE_ACTIONS_URL` and a token in `RUNNER_TOKEN` (or run
`npx flare-forge-cli login` to pair this machine).

## Connect an agent

```sh
export FLARE_ACTIONS_URL=https://<your-flare>.workers.dev
export FLARE_TOKEN=<runner token>      # never commit it
npx flare-forge-cli forge connect-agent --client claude   # or codex | cursor
```

It prints a one-line `claude mcp add ...`, a paste-ready MCP config and
the workflow prompt.

## Wire a repo for every agent

```sh
npx flare-forge-cli forge init --dry-run   # preview the diff
npx flare-forge-cli forge init             # AGENTS.md block + .mcp.json entry
npx flare-forge-cli forge init --client cursor --skill
```

`forge init` is idempotent. It adds a marked "Flare Forge" block to
`AGENTS.md` (declare before you edit, the loop, etiquette) and merges a
`flare-forge` server into `.mcp.json` (or `.cursor/mcp.json`). The token
is always an env-var reference, so the file is safe to commit. For
Codex it prints the `~/.codex/config.toml` snippet instead of editing
your home directory.

## The loop without MCP

```sh
npx flare-forge-cli forge status <repo> src/api          # who is touching these paths?
npx flare-forge-cli forge declare <repo> "Add rate limit" --path src/api/** --accept "npm test"
npx flare-forge-cli forge claim <intentId> --clone       # your own fork; token stays out of argv
npx flare-forge-cli forge push                           # plain git push, then report_push
npx flare-forge-cli forge ready                          # queue for a CI-verified train
npx flare-forge-cli forge why <repo> src/api/x.ts:42     # goal -> intent -> reasoning for a line
```

## CI commands

The same package carries the Flare Actions CLI:

```sh
npx flare-forge-cli connect --dry-run        # probe, wire and verify this repo
npx flare-forge-cli run owner/repo HEAD      # dispatch, wait, print the digest
npx flare-forge-cli local                    # run flare.yml here, no server
```

Every command accepts `--json`. Installed globally
(`npm i -g flare-forge-cli`), the same CLI is also on your path as `flare`.

MIT licensed.
