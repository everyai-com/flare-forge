// Artifacts REST admin: wrangler lacks namespace-create and
// artifacts.repo subscription options, so setup drives the API here.
// Idempotent throughout; `fetchImpl` is injectable for tests.
async function cfApi(fetchImpl, apiToken, accountId, method, path, body) {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = (json.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    const err = new Error(`artifacts API ${method} ${path} failed: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

// Data jurisdiction (US/EU) is accepted only at namespace creation and
// cannot be changed afterwards, so a reused namespace is read back and
// compared: a silent mismatch would pin every repo in the namespace to
// the wrong region for its whole life.
export const JURISDICTIONS = ["eu", "us"];

export function normalizeJurisdiction(value) {
  if (value === undefined || value === null || value === "") return null;
  const j = String(value).trim().toLowerCase();
  if (!JURISDICTIONS.includes(j)) {
    throw new Error(`jurisdiction must be one of ${JURISDICTIONS.join(", ")} (got "${value}")`);
  }
  return j;
}

// Read a namespace's jurisdiction back from the list endpoint. Returns
// undefined when the namespace or the field is absent — callers treat
// that as "unknown", never as "unrestricted", so we only warn on a
// jurisdiction we positively read.
export async function readNamespaceJurisdiction({ apiToken, accountId, namespace }, fetchImpl = fetch) {
  const list = await cfApi(fetchImpl, apiToken, accountId, "GET", "/artifacts/namespaces?per_page=100");
  const row = (list ?? []).find((n) => (n?.namespace ?? n?.name) === namespace);
  if (!row) return undefined;
  const j = row.jurisdiction;
  return typeof j === "string" && j !== "" ? j.toLowerCase() : undefined;
}

// Ensure the namespace exists (409 = reuse). `jurisdiction` is "eu" or
// "us"; omitted leaves the namespace unrestricted. Returns
// { namespace, reused, jurisdiction, mismatch } — `mismatch` is set only
// when a reused namespace positively reports a different jurisdiction
// than the one asked for, which no API call can fix.
export async function ensureNamespace({ apiToken, accountId, namespace, jurisdiction }, fetchImpl = fetch) {
  const want = normalizeJurisdiction(jurisdiction);
  const body = want ? { namespace, jurisdiction: want } : { namespace };
  try {
    await cfApi(fetchImpl, apiToken, accountId, "POST", "/artifacts/namespaces", body);
    return { namespace, reused: false, jurisdiction: want };
  } catch (err) {
    if (err.status !== 409) throw err;
    // Reuse. Only inspect when a jurisdiction was requested: an
    // unrestricted ask has nothing to compare against, and the extra
    // GET would need a scope the caller may not have granted.
    if (!want) return { namespace, reused: true, jurisdiction: null };
    let actual;
    try {
      actual = await readNamespaceJurisdiction({ apiToken, accountId, namespace }, fetchImpl);
    } catch {
      // A read-back failure must not fail setup: the namespace exists
      // and is usable. Report unknown and let the caller note it.
      return { namespace, reused: true, jurisdiction: want, actual: undefined };
    }
    return {
      namespace,
      reused: true,
      jurisdiction: want,
      actual,
      ...(actual !== undefined && actual !== want ? { mismatch: true } : {}),
    };
  }
}

async function findQueue(api, queueName) {
  const queues = await api("GET", "/queues?per_page=100");
  const target = (queues ?? []).find((q) => q.queue_name === queueName);
  if (!target) throw new Error(`queue ${queueName} not found`);
  return target;
}

// Repo-level push subscriptions on the `artifacts.repo` source (only one
// subscription per repo is allowed). `events` defaults to pushed; the
// source also emits cloned, fetched, token.created and token.revoked.
// Returns [{ repo, reused }].
export async function ensurePushSubscriptions(
  { apiToken, accountId, namespace, repos, queueName = "flare-actions-artifacts", events = ["pushed"] },
  fetchImpl = fetch,
) {
  const api = (method, path, body) => cfApi(fetchImpl, apiToken, accountId, method, path, body);
  const target = await findQueue(api, queueName);
  const existing = await api("GET", "/event_subscriptions/subscriptions?per_page=100");
  const owned = new Set(
    (existing ?? [])
      .filter((s) => s.source?.type === "artifacts.repo" && s.source?.namespace === namespace)
      .map((s) => s.source.repo_name),
  );
  const done = [];
  for (const repo of repos) {
    if (owned.has(repo)) {
      done.push({ repo, reused: true });
      continue;
    }
    await api("POST", "/event_subscriptions/subscriptions", {
      name: `flare-${repo}`.slice(0, 64),
      destination: { type: "queues.queue", queue_id: target.queue_id },
      source: { type: "artifacts.repo", namespace, repo_name: repo },
      events,
      enabled: true,
    });
    done.push({ repo, reused: false });
  }
  return done;
}

// Account-level repo lifecycle, on the `artifacts` source. This is the
// only source that reports repos the worker has never seen, so it is how
// agent forks announce themselves: a per-repo `artifacts.repo`
// subscription cannot be created for a repo that does not exist yet.
// One subscription covers the whole account. Returns { reused }.
export const ACCOUNT_LIFECYCLE_EVENTS = ["repo.created", "repo.forked", "repo.imported", "repo.deleted"];

export async function ensureAccountSubscription(
  {
    apiToken,
    accountId,
    queueName = "flare-actions-artifacts",
    events = ACCOUNT_LIFECYCLE_EVENTS,
    name = "flare-artifacts-lifecycle",
  },
  fetchImpl = fetch,
) {
  const api = (method, path, body) => cfApi(fetchImpl, apiToken, accountId, method, path, body);
  const target = await findQueue(api, queueName);
  const existing = await api("GET", "/event_subscriptions/subscriptions?per_page=100");
  const mine = (existing ?? []).find((s) => s.source?.type === "artifacts");
  if (mine) return { reused: true, events: mine.events ?? events };
  await api("POST", "/event_subscriptions/subscriptions", {
    name: name.slice(0, 64),
    destination: { type: "queues.queue", queue_id: target.queue_id },
    source: { type: "artifacts" },
    events,
    enabled: true,
  });
  return { reused: false, events };
}

// ---------------------------------------------------------------------
// Metrics (GraphQL analytics). `artifactsEventsAdaptiveGroups` buckets
// every repo operation by eventKind (action | error) and eventType
// (create/fork/push/pull/delete, or an error category), which is exactly
// the operations/pulls/pushes/errors/error-rate split the dashboard
// shows. Retention is 31 days.
export const METRICS_WINDOW_MAX_HOURS = 31 * 24;

export const ARTIFACTS_METRICS_QUERY = `query FlareArtifactsMetrics($accountTag: String!, $start: Time!, $end: Time!, $namespace: String) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      artifactsEventsAdaptiveGroups(
        limit: 10000
        orderBy: [count_DESC]
        filter: { datetime_geq: $start, datetime_leq: $end, repositoryNamespace: $namespace }
      ) {
        count
        dimensions { repositoryName eventKind eventType }
      }
    }
  }
}`;

export async function graphqlQuery({ apiToken, query, variables }, fetchImpl = fetch) {
  const res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  const errors = json.errors ?? [];
  if (!res.ok || errors.length > 0) {
    const msg = errors.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    const err = new Error(`artifacts metrics query failed: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// Fold the grouped rows into one row per repo. `pulls` counts clones and
// fetches (the read path, billed as pulls); `operations` counts every
// successful action. Error rate is errors over attempts, so a repo with
// no traffic reports 0 rather than NaN.
export function summarizeMetrics(groups) {
  const byRepo = new Map();
  for (const g of groups ?? []) {
    const repo = g?.dimensions?.repositoryName;
    if (typeof repo !== "string" || repo === "") continue;
    const count = Number(g.count ?? 0);
    if (!Number.isFinite(count) || count < 0) continue;
    const kind = g.dimensions.eventKind;
    const type = g.dimensions.eventType;
    const row = byRepo.get(repo) ?? { repo, operations: 0, pushes: 0, pulls: 0, errors: 0, byType: {} };
    row.byType[type] = (row.byType[type] ?? 0) + count;
    if (kind === "error") {
      row.errors += count;
    } else {
      row.operations += count;
      if (type === "push") row.pushes += count;
      if (type === "pull") row.pulls += count;
    }
    byRepo.set(repo, row);
  }
  const rows = [...byRepo.values()].map((r) => {
    const attempts = r.operations + r.errors;
    return { ...r, attempts, errorRate: attempts === 0 ? 0 : r.errors / attempts };
  });
  rows.sort((a, b) => b.attempts - a.attempts || a.repo.localeCompare(b.repo));
  const totals = rows.reduce(
    (acc, r) => ({
      operations: acc.operations + r.operations,
      pushes: acc.pushes + r.pushes,
      pulls: acc.pulls + r.pulls,
      errors: acc.errors + r.errors,
      attempts: acc.attempts + r.attempts,
    }),
    { operations: 0, pushes: 0, pulls: 0, errors: 0, attempts: 0 },
  );
  return {
    repos: rows,
    totals: { ...totals, errorRate: totals.attempts === 0 ? 0 : totals.errors / totals.attempts },
  };
}

export async function fetchArtifactsMetrics(
  { apiToken, accountId, namespace, sinceHours = 24, now = Date.now() },
  fetchImpl = fetch,
) {
  const hours = Math.min(Math.max(Number(sinceHours) || 24, 1), METRICS_WINDOW_MAX_HOURS);
  const end = new Date(now).toISOString();
  const start = new Date(now - hours * 3_600_000).toISOString();
  const data = await graphqlQuery(
    {
      apiToken,
      query: ARTIFACTS_METRICS_QUERY,
      variables: { accountTag: accountId, start, end, ...(namespace ? { namespace } : {}) },
    },
    fetchImpl,
  );
  const groups = data?.viewer?.accounts?.[0]?.artifactsEventsAdaptiveGroups ?? [];
  return { window: { start, end, hours }, ...summarizeMetrics(groups) };
}
