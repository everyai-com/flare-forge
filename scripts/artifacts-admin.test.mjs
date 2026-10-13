import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LIFECYCLE_EVENTS,
  ensureAccountSubscription,
  ensureNamespace,
  ensurePushSubscriptions,
  fetchArtifactsMetrics,
  normalizeJurisdiction,
  readNamespaceJurisdiction,
  summarizeMetrics,
} from "./artifacts-admin.mjs";

const CREDS = { apiToken: "t", accountId: "a".repeat(32) };

// Minimal CF API stub: routes by `${method} ${path}` and records calls.
function api(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const hit = routes[`${method} ${path}`];
    if (!hit) return { ok: true, status: 200, json: async () => ({ success: true, result: [] }) };
    const out = typeof hit === "function" ? hit(body) : hit;
    return {
      ok: out.status === undefined || out.status < 400,
      status: out.status ?? 200,
      json: async () => out.json ?? { success: true, result: out.result ?? [] },
    };
  };
  return { fetchImpl, calls };
}

describe("normalizeJurisdiction", () => {
  it("accepts eu and us in any case, and treats blank as unrestricted", () => {
    expect(normalizeJurisdiction("EU")).toBe("eu");
    expect(normalizeJurisdiction(" us ")).toBe("us");
    expect(normalizeJurisdiction("")).toBeNull();
    expect(normalizeJurisdiction(undefined)).toBeNull();
  });

  it("fails closed on anything else, naming the allowed values", () => {
    expect(() => normalizeJurisdiction("uk")).toThrow(/must be one of eu, us/);
    expect(() => normalizeJurisdiction("united-states")).toThrow(/got "united-states"/);
  });
});

describe("ensureNamespace", () => {
  it("sends the jurisdiction on create", async () => {
    const { fetchImpl, calls } = api({ "POST /artifacts/namespaces": { result: {} } });
    const out = await ensureNamespace({ ...CREDS, namespace: "ns", jurisdiction: "eu" }, fetchImpl);
    expect(out).toEqual({ namespace: "ns", reused: false, jurisdiction: "eu" });
    expect(calls[0].body).toEqual({ namespace: "ns", jurisdiction: "eu" });
  });

  it("omits the field entirely when no jurisdiction is asked for", async () => {
    const { fetchImpl, calls } = api({ "POST /artifacts/namespaces": { result: {} } });
    await ensureNamespace({ ...CREDS, namespace: "ns" }, fetchImpl);
    expect(calls[0].body).toEqual({ namespace: "ns" });
    expect(calls[0].body).not.toHaveProperty("jurisdiction");
  });

  it("rejects a bad jurisdiction before calling the API", async () => {
    const { fetchImpl, calls } = api({});
    await expect(ensureNamespace({ ...CREDS, namespace: "ns", jurisdiction: "mars" }, fetchImpl)).rejects.toThrow(
      /must be one of/,
    );
    expect(calls).toEqual([]);
  });

  it("flags a reused namespace whose jurisdiction differs (it cannot be changed)", async () => {
    const { fetchImpl } = api({
      "POST /artifacts/namespaces": { status: 409, json: { success: false, errors: [{ message: "exists" }] } },
      "GET /artifacts/namespaces?per_page=100": { result: [{ namespace: "ns", jurisdiction: "US" }] },
    });
    const out = await ensureNamespace({ ...CREDS, namespace: "ns", jurisdiction: "eu" }, fetchImpl);
    expect(out).toMatchObject({ reused: true, jurisdiction: "eu", actual: "us", mismatch: true });
  });

  it("does not flag a reused namespace that already matches", async () => {
    const { fetchImpl } = api({
      "POST /artifacts/namespaces": { status: 409, json: { success: false, errors: [{ message: "exists" }] } },
      "GET /artifacts/namespaces?per_page=100": { result: [{ namespace: "ns", jurisdiction: "eu" }] },
    });
    const out = await ensureNamespace({ ...CREDS, namespace: "ns", jurisdiction: "eu" }, fetchImpl);
    expect(out.mismatch).toBeUndefined();
    expect(out.actual).toBe("eu");
  });

  it("reuses without a read-back when no jurisdiction is requested", async () => {
    const { fetchImpl, calls } = api({
      "POST /artifacts/namespaces": { status: 409, json: { success: false, errors: [{ message: "exists" }] } },
    });
    const out = await ensureNamespace({ ...CREDS, namespace: "ns" }, fetchImpl);
    expect(out).toEqual({ namespace: "ns", reused: true, jurisdiction: null });
    expect(calls.filter((c) => c.method === "GET")).toEqual([]);
  });

  it("treats an unreadable jurisdiction as unknown rather than a mismatch", async () => {
    const { fetchImpl } = api({
      "POST /artifacts/namespaces": { status: 409, json: { success: false, errors: [{ message: "exists" }] } },
      "GET /artifacts/namespaces?per_page=100": { status: 403, json: { success: false, errors: [{ message: "nope" }] } },
    });
    const out = await ensureNamespace({ ...CREDS, namespace: "ns", jurisdiction: "eu" }, fetchImpl);
    expect(out.mismatch).toBeUndefined();
    expect(out.actual).toBeUndefined();
  });

  it("rethrows non-409 create failures", async () => {
    const { fetchImpl } = api({
      "POST /artifacts/namespaces": { status: 500, json: { success: false, errors: [{ message: "boom" }] } },
    });
    await expect(ensureNamespace({ ...CREDS, namespace: "ns" }, fetchImpl)).rejects.toThrow(/boom/);
  });
});

describe("readNamespaceJurisdiction", () => {
  it("returns undefined for an unrestricted or absent namespace", async () => {
    const { fetchImpl } = api({
      "GET /artifacts/namespaces?per_page=100": { result: [{ namespace: "ns" }, { namespace: "other", jurisdiction: "eu" }] },
    });
    expect(await readNamespaceJurisdiction({ ...CREDS, namespace: "ns" }, fetchImpl)).toBeUndefined();
    expect(await readNamespaceJurisdiction({ ...CREDS, namespace: "missing" }, fetchImpl)).toBeUndefined();
  });

  it("accepts the alternate `name` spelling", async () => {
    const { fetchImpl } = api({
      "GET /artifacts/namespaces?per_page=100": { result: [{ name: "ns", jurisdiction: "US" }] },
    });
    expect(await readNamespaceJurisdiction({ ...CREDS, namespace: "ns" }, fetchImpl)).toBe("us");
  });
});

const QUEUE = { "GET /queues?per_page=100": { result: [{ queue_name: "flare-actions-artifacts", queue_id: "q1" }] } };

describe("ensureAccountSubscription", () => {
  it("subscribes the account-level artifacts source to the lifecycle events", async () => {
    const { fetchImpl, calls } = api({ ...QUEUE, "POST /event_subscriptions/subscriptions": { result: {} } });
    const out = await ensureAccountSubscription(CREDS, fetchImpl);
    expect(out).toEqual({ reused: false, events: ACCOUNT_LIFECYCLE_EVENTS });
    const post = calls.find((c) => c.method === "POST");
    expect(post.body.source).toEqual({ type: "artifacts" });
    expect(post.body.events).toEqual(["repo.created", "repo.forked", "repo.imported", "repo.deleted"]);
    expect(post.body.destination).toEqual({ type: "queues.queue", queue_id: "q1" });
  });

  it("reuses an existing account-level subscription", async () => {
    const { fetchImpl, calls } = api({
      ...QUEUE,
      "GET /event_subscriptions/subscriptions?per_page=100": {
        result: [{ source: { type: "artifacts" }, events: ["repo.forked"] }],
      },
    });
    const out = await ensureAccountSubscription(CREDS, fetchImpl);
    expect(out).toEqual({ reused: true, events: ["repo.forked"] });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does not mistake a repo-level subscription for the account one", async () => {
    const { fetchImpl, calls } = api({
      ...QUEUE,
      "GET /event_subscriptions/subscriptions?per_page=100": {
        result: [{ source: { type: "artifacts.repo", namespace: "ns", repo_name: "r" } }],
      },
      "POST /event_subscriptions/subscriptions": { result: {} },
    });
    expect((await ensureAccountSubscription(CREDS, fetchImpl)).reused).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("fails when the destination queue is missing", async () => {
    const { fetchImpl } = api({ "GET /queues?per_page=100": { result: [] } });
    await expect(ensureAccountSubscription(CREDS, fetchImpl)).rejects.toThrow(/queue flare-actions-artifacts not found/);
  });
});

describe("ensurePushSubscriptions", () => {
  it("defaults to pushed and keeps the repo-level source shape", async () => {
    const { fetchImpl, calls } = api({ ...QUEUE, "POST /event_subscriptions/subscriptions": { result: {} } });
    const out = await ensurePushSubscriptions({ ...CREDS, namespace: "ns", repos: ["r"] }, fetchImpl);
    expect(out).toEqual([{ repo: "r", reused: false }]);
    const post = calls.find((c) => c.method === "POST");
    expect(post.body.source).toEqual({ type: "artifacts.repo", namespace: "ns", repo_name: "r" });
    expect(post.body.events).toEqual(["pushed"]);
  });

  it("passes through an explicit event list", async () => {
    const { fetchImpl, calls } = api({ ...QUEUE, "POST /event_subscriptions/subscriptions": { result: {} } });
    await ensurePushSubscriptions({ ...CREDS, namespace: "ns", repos: ["r"], events: ["pushed", "cloned"] }, fetchImpl);
    expect(calls.find((c) => c.method === "POST").body.events).toEqual(["pushed", "cloned"]);
  });
});

describe("summarizeMetrics", () => {
  const groups = [
    { count: 10, dimensions: { repositoryName: "api", eventKind: "action", eventType: "pull" } },
    { count: 4, dimensions: { repositoryName: "api", eventKind: "action", eventType: "push" } },
    { count: 2, dimensions: { repositoryName: "api", eventKind: "error", eventType: "rateLimited" } },
    { count: 1, dimensions: { repositoryName: "web", eventKind: "action", eventType: "create" } },
  ];

  it("splits operations, pushes, pulls and errors per repo", () => {
    const { repos } = summarizeMetrics(groups);
    expect(repos[0]).toMatchObject({ repo: "api", operations: 14, pushes: 4, pulls: 10, errors: 2, attempts: 16 });
    expect(repos[0].errorRate).toBeCloseTo(2 / 16);
    expect(repos[1]).toMatchObject({ repo: "web", operations: 1, errors: 0, errorRate: 0 });
  });

  it("keeps errors out of the operations count but inside attempts", () => {
    const { totals } = summarizeMetrics(groups);
    expect(totals).toMatchObject({ operations: 15, pushes: 4, pulls: 10, errors: 2, attempts: 17 });
    expect(totals.errorRate).toBeCloseTo(2 / 17);
  });

  it("retains the error category breakdown", () => {
    expect(summarizeMetrics(groups).repos[0].byType.rateLimited).toBe(2);
  });

  it("reports zero rather than NaN with no traffic", () => {
    expect(summarizeMetrics([]).totals).toEqual({
      operations: 0,
      pushes: 0,
      pulls: 0,
      errors: 0,
      attempts: 0,
      errorRate: 0,
    });
  });

  it("skips rows with no repo or a nonsense count", () => {
    const out = summarizeMetrics([
      { count: 5, dimensions: { eventKind: "action", eventType: "push" } },
      { count: -1, dimensions: { repositoryName: "api", eventKind: "action", eventType: "push" } },
      { count: "x", dimensions: { repositoryName: "api", eventKind: "action", eventType: "push" } },
    ]);
    expect(out.repos).toEqual([]);
  });

  it("orders the busiest repo first", () => {
    const out = summarizeMetrics([
      { count: 1, dimensions: { repositoryName: "quiet", eventKind: "action", eventType: "pull" } },
      { count: 9, dimensions: { repositoryName: "busy", eventKind: "action", eventType: "pull" } },
    ]);
    expect(out.repos.map((r) => r.repo)).toEqual(["busy", "quiet"]);
  });
});

describe("fetchArtifactsMetrics", () => {
  function gql(data, errors) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: !errors,
        status: errors ? 400 : 200,
        json: async () => (errors ? { errors } : { data }),
      };
    };
    return { fetchImpl, calls };
  }

  it("queries the GraphQL endpoint with a bounded window and folds the result", async () => {
    const { fetchImpl, calls } = gql({
      viewer: {
        accounts: [
          {
            artifactsEventsAdaptiveGroups: [
              { count: 3, dimensions: { repositoryName: "api", eventKind: "action", eventType: "push" } },
            ],
          },
        ],
      },
    });
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    const out = await fetchArtifactsMetrics({ ...CREDS, namespace: "ns", sinceHours: 2, now }, fetchImpl);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(calls[0].body.variables).toMatchObject({
      accountTag: CREDS.accountId,
      namespace: "ns",
      start: "2026-10-13T10:00:00.000Z",
      end: "2026-10-13T12:00:00.000Z",
    });
    expect(out.totals.pushes).toBe(3);
    expect(out.window.hours).toBe(2);
  });

  it("clamps the window to the 31-day retention limit", async () => {
    const { fetchImpl } = gql({ viewer: { accounts: [] } });
    const out = await fetchArtifactsMetrics({ ...CREDS, sinceHours: 99999 }, fetchImpl);
    expect(out.window.hours).toBe(31 * 24);
  });

  it("omits the namespace filter when none is given", async () => {
    const { fetchImpl, calls } = gql({ viewer: { accounts: [] } });
    await fetchArtifactsMetrics(CREDS, fetchImpl);
    expect(calls[0].body.variables).not.toHaveProperty("namespace");
  });

  it("surfaces GraphQL errors", async () => {
    const { fetchImpl } = gql(null, [{ message: "bad filter" }]);
    await expect(fetchArtifactsMetrics(CREDS, fetchImpl)).rejects.toThrow(/bad filter/);
  });

  it("treats a missing account as no traffic", async () => {
    const { fetchImpl } = gql({ viewer: { accounts: [] } });
    expect((await fetchArtifactsMetrics(CREDS, fetchImpl)).repos).toEqual([]);
  });
});
