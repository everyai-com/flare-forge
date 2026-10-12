import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { SCHEMA_STATEMENTS } from "./schema";
import { counters, ensureIndexSchema, opsLedger, recordRepoOps, type CoordinatorDeps, type FeedOp, type SqlStore, type SqlValue } from "./coordinator-core";
import {
  ARTIFACTS_PRICING,
  attributeOp,
  attributeTally,
  classifyRepoName,
  conflictIdPrefix,
  forgeOpsLookups,
  handleArtifactsOpEvent,
  intentOps,
  meterArtifacts,
  naiveFetchesPerChange,
  opsEconomics,
  opsLine,
  OpsTally,
  opsTotals,
  parseArtifactsOpEvent,
  pushBurstKey,
  recordOps,
  SIM_OPS_PER_INTENT,
  simulatedOpsEconomics,
  topIntentOps,
  usdFor,
  validOpEntries,
  type OpsLookups,
} from "./forge-ops";
import { DEFAULT_CONSTANTS } from "../../sim/src/constants";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

// node:sqlite behind the DO `ctx.storage.sql` shape (same limits the
// coordinator tests enforce: ≤100 bound params, no LIKE).
function doSql(): SqlStore {
  const raw = new DatabaseSync(":memory:");
  const sql: SqlStore = {
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
      if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length}`);
      if (/\bLIKE\b/i.test(query)) throw new Error("LIKE is not allowed in the coordinator");
      const rows = raw.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows };
    },
  };
  ensureIndexSchema(sql);
  return sql;
}

function d1(): { db: Db; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of SCHEMA_STATEMENTS) {
    const m = /(?:TABLE IF NOT EXISTS|ON) (\w+)/.exec(stmt);
    if (m && ["goals", "intents", "conflicts"].includes(m[1])) raw.exec(stmt);
  }
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
            run: async () => ({ meta: { changes: Number((raw.prepare(query).run(...params) as { changes?: unknown }).changes ?? 0) } }),
          };
        },
      };
    },
  } as unknown as Db;
  return { db, raw };
}

// Envelopes as Cloudflare documents them (artifacts/guides/event-subscriptions, 2026-10-12).
const META = { accountId: "acc", eventSubscriptionId: "sub", eventSchemaVersion: 1, eventTimestamp: "2026-10-12T10:00:00Z" };
function envelope(type: string, repoName: string, payload: Record<string, unknown> = {}, sourceType = "artifacts.repo"): Record<string, unknown> {
  return { type, source: { type: sourceType, namespace: "flare-tournaments", repoName }, payload, metadata: META };
}

const INTENT_ID = "3f2a9c1e-7b4d-4e21-9a0b-55c1d2e3f4a5";
const CONFLICT_ID = "9a0b1c2d-3e4f-4a5b-8c7d-112233445566";

function fakeLookups(): OpsLookups {
  return {
    intentByFork: async (fork) => (fork === "i-3f2a9c1e7b4d" ? { id: INTENT_ID, repo: "bookshelf" } : null),
    conflictRepoByShort: async (short) => (short === "9a0b1c2d3e4f" ? "bookshelf" : null),
    isForgeRepo: async (name) => name === "bookshelf",
  };
}

describe("parseArtifactsOpEvent", () => {
  it("maps every documented event type to an op kind", () => {
    const cases: Array<[string, string]> = [
      ["cf.artifacts.repo.created", "create"],
      ["cf.artifacts.repo.imported", "import"],
      ["cf.artifacts.repo.deleted", "delete"],
      ["cf.artifacts.repo.cloned", "clone"],
      ["cf.artifacts.repo.fetched", "fetch"],
    ];
    for (const [type, kind] of cases) {
      expect(parseArtifactsOpEvent(envelope(type, "bookshelf"))).toEqual({ kind, namespace: "flare-tournaments", repoName: "bookshelf", targetRepo: null, ref: null });
    }
  });

  it("reads the push ref and the fork target", () => {
    const push = parseArtifactsOpEvent(envelope("cf.artifacts.repo.pushed", "bookshelf", { ref: "refs/heads/forge/lane-1", before: "a".repeat(40), after: "b".repeat(40), commits: [] }));
    expect(push).toMatchObject({ kind: "push", ref: "refs/heads/forge/lane-1" });
    const fork = parseArtifactsOpEvent(envelope("cf.artifacts.repo.forked", "bookshelf", { namespace: "flare-tournaments", repoName: "i-3f2a9c1e7b4d" }, "artifacts"));
    expect(fork).toMatchObject({ kind: "fork", repoName: "bookshelf", targetRepo: "i-3f2a9c1e7b4d" });
  });

  it("accepts the flattened shape and an untyped push", () => {
    expect(parseArtifactsOpEvent({ source: { namespace: "ns", repoName: "r" }, ref: "refs/heads/main", before: "", after: "c".repeat(40) })).toMatchObject({ kind: "push" });
  });

  it("rejects unknown types, token events and bad names", () => {
    expect(parseArtifactsOpEvent(envelope("cf.artifacts.repo.token.created", "bookshelf"))).toBeNull();
    expect(parseArtifactsOpEvent(envelope("cf.other", "bookshelf"))).toBeNull();
    expect(parseArtifactsOpEvent(envelope("cf.artifacts.repo.cloned", "bad name!"))).toBeNull();
    expect(parseArtifactsOpEvent(null)).toBeNull();
    expect(parseArtifactsOpEvent({ type: "cf.artifacts.repo.cloned" })).toBeNull();
  });
});

describe("attribution", () => {
  it("classifies fork names", () => {
    expect(classifyRepoName("i-3f2a9c1e7b4d")).toEqual({ role: "intent", short: "3f2a9c1e7b4d" });
    expect(classifyRepoName("s-3f2a9c1e7b4d-claude-1-x9")).toEqual({ role: "session", short: "3f2a9c1e7b4d" });
    expect(classifyRepoName("r-9a0b1c2d3e4f-2")).toEqual({ role: "replay", short: "9a0b1c2d3e4f" });
    expect(classifyRepoName("bookshelf")).toEqual({ role: "trunk", short: null });
  });

  it("charges forks to their intent and trunk refs to trunk or lanes", async () => {
    const l = fakeLookups();
    expect(await attributeOp(l, { repoName: "i-3f2a9c1e7b4d" })).toEqual({ repo: "bookshelf", subject: "intent", intentId: INTENT_ID });
    expect(await attributeOp(l, { repoName: "s-3f2a9c1e7b4d-codex-ab" })).toEqual({ repo: "bookshelf", subject: "session", intentId: INTENT_ID });
    expect(await attributeOp(l, { repoName: "r-9a0b1c2d3e4f-1" })).toEqual({ repo: "bookshelf", subject: "replay", intentId: null });
    expect(await attributeOp(l, { repoName: "bookshelf", ref: "refs/heads/main" })).toEqual({ repo: "bookshelf", subject: "trunk", intentId: null });
    expect(await attributeOp(l, { repoName: "bookshelf", ref: "refs/heads/forge/lane-0" })).toEqual({ repo: "bookshelf", subject: "lane", intentId: null });
    expect(await attributeOp(l, { repoName: "tournament-abc" })).toBeNull();
  });

  it("charges a fork event to the new fork, else to the source by the fork's role", async () => {
    const l = fakeLookups();
    expect(await attributeOp(l, { repoName: "bookshelf", targetRepo: "i-3f2a9c1e7b4d" })).toEqual({ repo: "bookshelf", subject: "intent", intentId: INTENT_ID });
    // fork_repo not written yet: still the right repo and subject.
    expect(await attributeOp(l, { repoName: "bookshelf", targetRepo: "i-000000000000" })).toEqual({ repo: "bookshelf", subject: "intent", intentId: null });
    expect(await attributeOp(l, { repoName: "bookshelf", targetRepo: "r-ffffffffffff-1" })).toEqual({ repo: "bookshelf", subject: "replay", intentId: null });
    expect(await attributeOp(l, { repoName: "elsewhere", targetRepo: "copy" })).toBeNull();
  });

  it("rebuilds a UUID prefix from a replay short", () => {
    expect(conflictIdPrefix("9a0b1c2d3e4f")).toBe("9a0b1c2d-3e4f");
    expect(conflictIdPrefix("abc")).toBe("abc");
  });

  it("resolves through D1 (forks, conflicts, goals-only repos)", async () => {
    const { db, raw } = d1();
    const now = "2026-10-12T10:00:00Z";
    raw
      .prepare(
        "INSERT INTO intents (id, repo, title, reasoning, footprint_json, state, agent, fork_repo, created_at, updated_at) VALUES (?, 'bookshelf', 't', 'r', '{\"paths\":[]}', 'working', 'a', 'i-3f2a9c1e7b4d', ?, ?)",
      )
      .run(INTENT_ID, now, now);
    raw.prepare("INSERT INTO conflicts (id, repo, intent_a, intent_b, created_at, updated_at) VALUES (?, 'bookshelf', 'x', 'y', ?, ?)").run(CONFLICT_ID, now, now);
    raw.prepare("INSERT INTO goals (id, repo, text, state, created_by, created_at, updated_at) VALUES ('g1', 'fresh', 'goal', 'open', 'op', ?, ?)").run(now, now);
    const l = forgeOpsLookups(db);
    expect(await l.intentByFork("i-3f2a9c1e7b4d")).toEqual({ id: INTENT_ID, repo: "bookshelf" });
    expect(await l.intentByFork("i-nope")).toBeNull();
    expect(await l.conflictRepoByShort("9a0b1c2d3e4f")).toBe("bookshelf");
    expect(await l.conflictRepoByShort("000000000000")).toBeNull();
    expect(await l.isForgeRepo("bookshelf")).toBe(true);
    expect(await l.isForgeRepo("fresh")).toBe(true);
    expect(await l.isForgeRepo("unknown")).toBe(false);
  });
});

describe("ledger", () => {
  it("counts once per event id and keeps repo totals", () => {
    const sql = doSql();
    const t0 = Date.parse("2026-10-12T10:00:00Z");
    expect(recordOps(sql, [{ kind: "fork", origin: "event", subject: "intent", intentId: INTENT_ID }], "evt-1", t0)).toBe(true);
    expect(recordOps(sql, [{ kind: "fork", origin: "event", subject: "intent", intentId: INTENT_ID }], "evt-1", t0 + 5)).toBe(false);
    recordOps(sql, [{ kind: "clone", origin: "event", subject: "intent", intentId: INTENT_ID }], "evt-2", t0 + 10);
    recordOps(sql, [{ kind: "push", origin: "event", subject: "lane" }], "evt-3", t0 + 20);
    recordOps(sql, [{ kind: "delete", origin: "event", subject: "intent", intentId: INTENT_ID }], "evt-4", t0 + 30);
    recordOps(sql, [{ kind: "read", origin: "binding", subject: "intent", intentId: INTENT_ID, n: 12 }], null, t0 + 40);
    recordOps(sql, [{ kind: "token", origin: "binding", subject: "intent", intentId: INTENT_ID }], null, t0 + 41);
    const totals = opsTotals(sql);
    expect(totals.since).toBe("2026-10-12T10:00:00.000Z");
    expect(totals.events).toEqual({ fork: 1, clone: 1, push: 1, delete: 1 });
    expect(totals.binding).toEqual({ read: 12, token: 1 });
    expect(totals.bySubject).toEqual({ intent: 3, lane: 1 });
    // delete is not a documented billable kind; binding calls never are.
    expect(totals.billable).toBe(3);
    expect(totals.total).toBe(17);
    expect(intentOps(sql, INTENT_ID)).toEqual({ intentId: INTENT_ID, events: { fork: 1, clone: 1, delete: 1 }, binding: { read: 12, token: 1 }, billable: 2, usd: usdFor(2) });
    expect(topIntentOps(sql)).toEqual([{ intentId: INTENT_ID, ops: 3 }]);
  });

  it("prunes old event ids so the dedupe table stays bounded", () => {
    const sql = doSql();
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    recordOps(sql, [{ kind: "clone", origin: "event", subject: "trunk" }], "old", t0);
    recordOps(sql, [{ kind: "clone", origin: "event", subject: "trunk" }], "new", t0 + 4 * 86_400_000);
    const ids = sql.exec<{ event_id: string }>("SELECT event_id FROM fc_ops_seen ORDER BY event_id").toArray().map((r) => r.event_id);
    expect(ids).toEqual(["new"]);
  });

  it("validates entries strictly", () => {
    expect(
      validOpEntries([
        { kind: "push", origin: "event", subject: "trunk" },
        { kind: "read", origin: "event", subject: "trunk" },
        { kind: "push", origin: "binding", subject: "trunk" },
        { kind: "push", origin: "event", subject: "nowhere" },
        { kind: "read", origin: "binding", subject: "intent", intentId: "bad id with spaces", n: 1e9 },
        "junk",
      ]),
    ).toEqual([
      { kind: "push", origin: "event", subject: "trunk", intentId: null, n: 1 },
      { kind: "read", origin: "binding", subject: "intent", intentId: null, n: 10_000 },
    ]);
    expect(validOpEntries("nope")).toEqual([]);
  });

  it("publishes new totals on the live counters", () => {
    const sql = doSql();
    const published: FeedOp[][] = [];
    const deps: CoordinatorDeps = {
      sql,
      db: d1().db,
      repo: "bookshelf",
      now: () => Date.parse("2026-10-12T10:00:00Z"),
      publish: (ops) => published.push(ops),
      log: () => {},
    };
    expect(recordRepoOps(deps, [{ kind: "clone", origin: "event", subject: "trunk" }], "e1")).toEqual({ ok: true, recorded: true, entries: 1 });
    expect(recordRepoOps(deps, [{ kind: "clone", origin: "event", subject: "trunk" }], "e1")).toEqual({ ok: true, recorded: false, entries: 1 });
    expect(recordRepoOps(deps, [{ kind: "bogus" }], "e2")).toEqual({ ok: true, recorded: false, entries: 0 });
    expect(published).toHaveLength(1);
    const op = published[0][0];
    expect(op.kind).toBe("counters");
    expect(op.op === "upsert" && op.kind === "counters" ? op.fields.ops?.billable : null).toBe(1);
    expect(counters(sql).ops?.events).toEqual({ clone: 1 });
    expect(opsLedger(deps, "x").intent).toMatchObject({ intentId: "x", billable: 0 });
  });
});

describe("economics", () => {
  it("prices billable ops per landed change and projects the naive baseline", () => {
    const sql = doSql();
    recordOps(sql, [{ kind: "push", origin: "event", subject: "intent", n: 140 }], null, 0);
    recordOps(sql, [{ kind: "read", origin: "binding", subject: "intent", n: 60 }], null, 0);
    const e = opsEconomics(opsTotals(sql), 10);
    expect(e.status).toBe("measured");
    expect(e.billable).toBe(140);
    expect(e.perLandedChange).toBe(14);
    expect(e.usd).toBeCloseTo(0.021, 6);
    expect(e.usdPerLandedChange).toBeCloseTo(0.0021, 6);
    expect(e.upperBound).toEqual({ ops: 200, usd: usdFor(200) });
    expect(naiveFetchesPerChange()).toBe(16);
    expect(e.projected.naivePerLandedChange).toBe(30);
    expect(e.projected.at10kChanges).toEqual({ ops: 140_000, usd: 21, naiveOps: 300_000, naiveUsd: 45 });
    expect(e.pricing.perThousandOps).toBe(ARTIFACTS_PRICING.perThousandOps);
    expect(opsLine(e)).toBe("Artifacts ops: 140 billable, 14 per landed change (naive agent, projected: 30), $0.0210 at list price");
  });

  it("stays honest before any traffic or landing", () => {
    const e = opsEconomics(opsTotals(doSql()), 0);
    expect(e.status).toBe("empty");
    expect(e.perLandedChange).toBeNull();
    expect(e.projected.at10kChanges).toBeNull();
    expect(opsLine(e)).toBe("Artifacts ops: none recorded yet");
  });

  it("labels fixture numbers as simulated", () => {
    const e = simulatedOpsEconomics(12, 5);
    expect(e.simulated).toBe(true);
    // fork 1 + clone 1 + push 1 per intent; no invented fetches.
    expect(e.events).toEqual({ fork: 12, clone: 12, push: 12 });
    expect(e.events.fetch).toBeUndefined();
    expect(e.billable).toBe(36);
    expect(e.perLandedChange).toBe(7.2);
    // Consistent with the simulator's git op model.
    const g = DEFAULT_CONSTANTS.git;
    expect(SIM_OPS_PER_INTENT).toBe(g.forkPerIntent + g.clonePerIntent + 1);
    expect(e.note).toMatch(/^SIMULATED/);
    // Fixtures are embedded in the dashboard template: no backticks or dollar-brace.
    expect(JSON.stringify(e)).not.toMatch(/`|\$\{/);
  });
});

describe("binding meter", () => {
  function fakeBinding() {
    const calls: string[] = [];
    let disposed = 0;
    const handle = {
      readFile: async (a: { path: string }) => {
        calls.push(`readFile:${a.path}`);
        return null;
      },
      log: async () => [],
      createToken: async () => ({ plaintext: "tok" }),
      fork: async (name: string) => {
        calls.push(`fork:${name}`);
        return { name };
      },
      [Symbol.dispose]: () => {
        disposed++;
      },
    };
    const binding = {
      get: async (name: string) => {
        calls.push(`get:${name}`);
        return handle;
      },
      create: async (name: string) => {
        calls.push(`create:${name}`);
        return { name };
      },
    };
    return { binding, calls, disposed: () => disposed };
  }

  it("counts reads and token mints per repo and passes everything else through", async () => {
    const { binding, calls, disposed } = fakeBinding();
    const tally = new OpsTally();
    const metered = meterArtifacts(binding, (repo, kind) => tally.add(repo, kind));
    const h = await metered.get("i-3f2a9c1e7b4d");
    await h.readFile({ path: "flare.yml" });
    await h.log();
    await h.createToken();
    await h.fork("s-copy");
    h[Symbol.dispose]();
    await metered.create("new-repo");
    expect(calls).toEqual(["get:i-3f2a9c1e7b4d", "readFile:flare.yml", "fork:s-copy", "create:new-repo"]);
    expect(disposed()).toBe(1);
    expect(tally.drain()).toEqual([
      { repoName: "i-3f2a9c1e7b4d", kind: "read", n: 2 },
      { repoName: "i-3f2a9c1e7b4d", kind: "token", n: 1 },
      // The fork is charged to the NEW repo, and repo creation is counted.
      { repoName: "s-copy", kind: "fork", n: 1 },
      { repoName: "new-repo", kind: "create", n: 1 },
    ]);
    expect(tally.size).toBe(0);
  });

  it("works over RPC-stub-shaped bindings (callable, apply/bind are remote)", async () => {
    // workerd RPC stubs answer ANY property as a remote method: touching
    // .apply/.bind/.call on a stub method throws like this one does.
    function rpcFn(impl: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown {
      return new Proxy(impl, {
        get(t, p) {
          if (p === "apply" || p === "bind" || p === "call") throw new TypeError(`The RPC receiver does not implement the method "${String(p)}".`);
          return Reflect.get(t, p);
        },
      });
    }
    const reads: string[] = [];
    const handle = Object.assign(() => undefined, {
      log: rpcFn(async () => [{ hash: "a".repeat(40) }]),
      readFile: rpcFn(async () => null),
    });
    const binding = { get: rpcFn(async () => handle) };
    const metered = meterArtifacts(binding, (repo, kind) => reads.push(`${kind}:${repo}`));
    const h = (await metered.get("everyai-com-flare-actions")) as typeof handle;
    await expect(h.log()).resolves.toEqual([{ hash: "a".repeat(40) }]);
    await h.readFile();
    expect(reads).toEqual(["read:everyai-com-flare-actions", "read:everyai-com-flare-actions"]);
  });

  it("never lets a failing sink break the call", async () => {
    const { binding } = fakeBinding();
    const metered = meterArtifacts(binding, () => {
      throw new Error("sink down");
    });
    const h = await metered.get("bookshelf");
    await expect(h.readFile({ path: "x" })).resolves.toBeNull();
  });

  it("groups drained calls per Forge repo and drops strangers", async () => {
    const out = await attributeTally(fakeLookups(), [
      { repoName: "i-3f2a9c1e7b4d", kind: "read", n: 3 },
      { repoName: "bookshelf", kind: "token", n: 1 },
      { repoName: "stranger", kind: "read", n: 5 },
    ]);
    expect(out.dropped).toBe(5);
    expect(out.byRepo.get("bookshelf")).toEqual([
      { kind: "read", origin: "binding", subject: "intent", intentId: INTENT_ID, n: 3 },
      { kind: "token", origin: "binding", subject: "trunk", intentId: null, n: 1 },
    ]);
  });
});

describe("ledger accuracy vs Cloudflare metrics (prod, 2026-10-12)", () => {
  it("counts Forge's own forks and creates as billable binding ops", () => {
    const sql = doSql();
    recordOps(sql, [{ kind: "fork", origin: "binding", subject: "intent", intentId: INTENT_ID, n: 2 }], null, 0);
    recordOps(sql, [{ kind: "read", origin: "binding", subject: "intent", intentId: INTENT_ID, n: 9 }], null, 0);
    const t = opsTotals(sql);
    expect(t.billable).toBe(2);
    expect(t.binding).toEqual({ fork: 2, read: 9 });
    expect(intentOps(sql, INTENT_ID).billable).toBe(2);
  });

  it("attributes race forks through the tournament", async () => {
    const l = { ...fakeLookups(), tournamentRepoByShort: async (short: string) => (short === "938cfb59" ? "bookshelf" : null) };
    expect(classifyRepoName("t-938cfb59-replay-0")).toEqual({ role: "race", short: "938cfb59" });
    expect(await attributeOp(l, { repoName: "t-938cfb59-replay-0" })).toEqual({ repo: "bookshelf", subject: "replay", intentId: null });
    expect(await attributeOp(fakeLookups(), { repoName: "t-938cfb59-replay-0" })).toBeNull();
  });

  it("collapses a burst of ref creations into one push operation", async () => {
    const recorded: Array<[string, string | null]> = [];
    const deps = { namespace: "", lookups: fakeLookups(), record: async (repo: string, _e: unknown, id: string | null) => void recorded.push([repo, id]) };
    const lane = (n: number) => envelope("cf.artifacts.repo.pushed", "bookshelf", { ref: `refs/heads/forge/lane-${n}`, before: "0".repeat(40), after: "b".repeat(40) });
    const t = Date.parse("2026-10-12T12:37:10.250Z");
    for (let i = 0; i < 3; i++) await handleArtifactsOpEvent(deps, lane(i), `evt-${i}`, t + i * 100);
    const update = envelope("cf.artifacts.repo.pushed", "bookshelf", { ref: "refs/heads/main", before: "a".repeat(40), after: "c".repeat(40) });
    await handleArtifactsOpEvent(deps, update, "evt-main", t);
    expect(new Set(recorded.slice(0, 3).map((r) => r[1]))).toEqual(new Set([pushBurstKey("bookshelf", t)]));
    expect(recorded[3][1]).toBe("evt-main");
    expect(parseArtifactsOpEvent(update)?.createdRef).toBe(false);
  });
});

describe("handleArtifactsOpEvent", () => {
  it("records an attributed event with its event id", async () => {
    const recorded: unknown[] = [];
    const deps = { namespace: "flare-tournaments", lookups: fakeLookups(), record: async (...a: unknown[]) => void recorded.push(a) };
    const out = await handleArtifactsOpEvent(deps, envelope("cf.artifacts.repo.cloned", "i-3f2a9c1e7b4d"), "evt-9");
    expect(out).toEqual({ status: "recorded", kind: "clone", repo: "bookshelf", subject: "intent", intentId: INTENT_ID });
    expect(recorded).toEqual([["bookshelf", [{ kind: "clone", origin: "event", subject: "intent", intentId: INTENT_ID, n: 1 }], "evt-9"]]);
  });

  it("skips other namespaces, strangers and junk", async () => {
    const deps = { namespace: "mine", lookups: fakeLookups(), record: async () => {} };
    expect(await handleArtifactsOpEvent(deps, envelope("cf.artifacts.repo.cloned", "bookshelf"), "e")).toEqual({ status: "skipped", reason: "other-namespace", kind: "clone" });
    const open = { ...deps, namespace: "" };
    expect(await handleArtifactsOpEvent(open, envelope("cf.artifacts.repo.fetched", "stranger"), "e")).toEqual({ status: "skipped", reason: "unattributed", kind: "fetch", repoName: "stranger" });
    expect(await handleArtifactsOpEvent(open, { nope: true }, "e")).toEqual({ status: "skipped", reason: "invalid" });
  });
});
