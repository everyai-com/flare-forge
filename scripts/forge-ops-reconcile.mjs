#!/usr/bin/env node
// Check Forge's ops ledger against Cloudflare's own Artifacts metrics.
//
//   CLOUDFLARE_API_TOKEN=... npm run forge:ops-reconcile -- --since 2026-10-12T12:30:00Z [--until ...]
//       [--namespace flare-tournaments] [--account <id>] [--repo bookshelf] [--json]
//
// Cloudflare side: GraphQL `artifactsEventsAdaptiveGroups` (eventKind
// "action"), grouped by eventType, for the namespace and window
// (developers.cloudflare.com/artifacts/observability/metrics/). The token
// needs Account Analytics: Read. Forge side: GET /v1/forge/snapshot `ops`
// for --repo (FLARE_ACTIONS_URL + RUNNER_TOKEN/FLARE_TOKEN, read from the
// repo .env like the CLI). Tokens never reach argv or stdout.
//
// The namespace total covers every repo in it (trunk, intent/replay/race
// forks, and anything else that lives there); the ledger covers one Forge
// repo since its first recorded op. Compare the billable kinds:
// Cloudflare create/fork/pull/push vs ledger create/fork/clone/fetch/push.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, dflt = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const env = { ...process.env };
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}
const wrangler = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
const account = flag("account", wrangler.vars?.ARTIFACTS_ACCOUNT_ID);
const namespace = flag("namespace", wrangler.vars?.ARTIFACTS_NAMESPACE);
const since = flag("since");
const until = flag("until", new Date().toISOString());
const repo = flag("repo", "bookshelf");
const json = args.includes("--json");
if (!since) {
  console.error("usage: npm run forge:ops-reconcile -- --since <ISO> [--until <ISO>] [--namespace NS] [--repo NAME] [--json]");
  process.exit(2);
}
if (!env.CLOUDFLARE_API_TOKEN) {
  console.error("forge:ops-reconcile needs CLOUDFLARE_API_TOKEN (Account Analytics: Read) in the environment or .env");
  process.exit(2);
}

const query = `query($a: String!, $s: Time, $e: Time, $ns: String!) { viewer { accounts(filter: { accountTag: $a }) {
  artifactsEventsAdaptiveGroups(limit: 100, filter: { datetime_geq: $s, datetime_leq: $e, repositoryNamespace: $ns, eventKind: "action" }, orderBy: [count_DESC]) {
    count dimensions { eventType } } } } }`;
const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { a: account, s: since, e: until, ns: namespace } }),
});
const body = await res.json();
if (!res.ok || body.errors?.length) {
  console.error(`Cloudflare GraphQL failed: ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  process.exit(1);
}
const rows = body.data?.viewer?.accounts?.[0]?.artifactsEventsAdaptiveGroups ?? [];
const cf = Object.fromEntries(rows.map((r) => [r.dimensions.eventType, r.count]));
const cfBillable = (cf.create ?? 0) + (cf.fork ?? 0) + (cf.pull ?? 0) + (cf.push ?? 0) + (cf.import ?? 0);

let ledger = null;
const token = env.RUNNER_TOKEN || env.FLARE_TOKEN;
if (env.FLARE_ACTIONS_URL && token) {
  const snap = await fetch(`${env.FLARE_ACTIONS_URL.replace(/\/+$/, "")}/v1/forge/snapshot?repo=${encodeURIComponent(repo)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (snap.ok) ledger = (await snap.json()).ops ?? null;
}

const out = {
  window: { since, until, namespace },
  cloudflare: { byType: cf, billable: cfBillable, usdAtList: Math.round(cfBillable * 0.15 * 1e4) / 1e7 },
  ledger: ledger && {
    repo,
    since: ledger.since,
    events: ledger.events,
    binding: ledger.binding,
    billable: ledger.billable,
    landed: ledger.landed,
    perLandedChange: ledger.perLandedChange,
  },
};
if (json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`Cloudflare (${namespace}, ${since} .. ${until}): ${rows.map((r) => `${r.dimensions.eventType} ${r.count}`).join(", ") || "no events"}`);
  console.log(`  billable kinds (create+fork+pull+push+import): ${cfBillable}  ($${out.cloudflare.usdAtList.toFixed(4)} at $0.15/1k)`);
  if (out.ledger) {
    console.log(`Forge ledger (${repo}, since ${out.ledger.since}): events ${JSON.stringify(out.ledger.events)}, binding ${JSON.stringify(out.ledger.binding)}`);
    console.log(`  billable ${out.ledger.billable}, landed ${out.ledger.landed}, ${out.ledger.perLandedChange ?? "-"} per landed change`);
  } else console.log("Forge ledger: unavailable (set FLARE_ACTIONS_URL + RUNNER_TOKEN, or no ledger on this deployment)");
}
