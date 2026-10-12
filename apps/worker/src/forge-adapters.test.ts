import { describe, expect, it } from "vitest";
import type { CoordinatorSnapshot, HappeningItem } from "./coordinator-core";
import { DEFAULT_POLICY } from "./intents-core";
import { coordinatorPortOver, whyPortOver, type CoordinatorRpc } from "./forge-adapters";
import { forgeSqliteDb } from "./forge.testkit";

function item(over: Partial<HappeningItem> = {}): HappeningItem {
  return {
    intentId: "i1",
    agent: "alpha",
    title: "Cache layer",
    reasoning: "speed",
    state: "claimed",
    paths: ["src/api/cache.ts"],
    actual: null,
    headSha: "",
    leaseExpiresAt: null,
    risk: 0,
    goalId: null,
    updatedAt: "2026-10-10T00:00:00.000Z",
    matched: [{ mine: "src/api/cache.ts", theirs: "src/api/cache.ts" }],
    untrusted: true,
    ...over,
  };
}

function rpc(over: Partial<CoordinatorRpc>): CoordinatorRpc {
  const fail = async (): Promise<never> => {
    throw new Error("not stubbed");
  };
  return {
    declare: fail,
    sync: fail,
    indexPush: fail,
    release: fail,
    snapshot: fail,
    whatsHappening: fail,
    ...over,
  };
}

function snapEmptyTotals() {
  return { since: null, events: {}, binding: {}, bySubject: {}, billable: 0, total: 0 };
}

describe("coordinatorPortOver", () => {
  it("is the D1 fallback when no DO binding exists", () => {
    const port = coordinatorPortOver({ db: forgeSqliteDb(), client: null });
    expect(port.kind).toBe("d1");
  });

  it("maps the DO's whats-happening rows and honours exclude + limit", async () => {
    const port = coordinatorPortOver({
      db: forgeSqliteDb(),
      client: () => rpc({ whatsHappening: async () => ({ items: [item(), item({ intentId: "i2" }), item({ intentId: "i3" })], invalid: [], truncated: false }) }),
    });
    expect(port.kind).toBe("coordinator");
    const live = await port.whatsHappening("demo", { paths: ["src/api/cache.ts"], excludeIntent: "i2", limit: 1 });
    expect(live.map((l) => l.intentId)).toEqual(["i1"]);
    expect(live[0].matchedPaths).toEqual(["src/api/cache.ts"]);
    expect(live[0].footprint).toEqual(["src/api/cache.ts"]);
  });

  it("degrades a throwing DO call to D1 instead of failing the request", async () => {
    const port = coordinatorPortOver({ db: forgeSqliteDb(), client: () => rpc({}) });
    await expect(port.whatsHappening("demo", { paths: ["src/x.ts"] })).resolves.toEqual([]);
  });

  it("prices the ops ledger per change landed since it began", async () => {
    const db = forgeSqliteDb();
    const since = "2026-10-12T09:00:00.000Z";
    for (const [id, at] of [["l1", "2026-10-12T09:30:00.000Z"], ["l2", "2026-10-12T09:40:00.000Z"], ["old", "2026-10-11T09:00:00.000Z"]]) {
      await db
        .prepare("INSERT INTO intents (id, repo, title, reasoning, footprint_json, state, agent, created_at, updated_at) VALUES (?, 'demo', 't', 'r', '{\"paths\":[]}', 'landed', 'a', ?, ?)")
        .bind(id, at, at)
        .run();
    }
    const snap: CoordinatorSnapshot = {
      v: 1,
      repo: "demo",
      at: since,
      ver: 4,
      intents: [],
      edges: [],
      truncated: false,
      counters: {
        intents: 0,
        agents: 0,
        overlaps: 0,
        overlapsCaught: 0,
        pushOverlaps: 0,
        driftAlerts: 0,
        notesSent: 0,
        pushes: 0,
        declared: 0,
        expired: 0,
        byState: {},
        ops: { since, events: { fork: 2, clone: 4, push: 8, delete: 1 }, binding: { read: 30 }, bySubject: { intent: 15 }, billable: 14, total: 45 },
      },
    };
    const port = coordinatorPortOver({ db, client: () => rpc({ snapshot: async () => snap }) });
    const out = await port.snapshot("demo", { policy: DEFAULT_POLICY, head: "h", trains: [] });
    expect(out.ops).toMatchObject({ status: "measured", billable: 14, landed: 2, perLandedChange: 7, upperBound: { ops: 45 } });
    expect(out.counters).toMatchObject({ artifacts_ops: 14, ops_per_landed: 7 });
  });

  it("reads one intent's ops and degrades to null", async () => {
    const intent = { intentId: "i1", events: { push: 2 }, binding: {}, billable: 2, usd: 0.0003 };
    const ok = coordinatorPortOver({ db: forgeSqliteDb(), client: () => rpc({ opsLedger: async () => ({ totals: snapEmptyTotals(), intent, top: [] }) }) });
    await expect(ok.intentOps?.("demo", "i1")).resolves.toEqual(intent);
    const failing = coordinatorPortOver({
      db: forgeSqliteDb(),
      client: () =>
        rpc({
          opsLedger: async () => {
            throw new Error("down");
          },
        }),
    });
    await expect(failing.intentOps?.("demo", "i1")).resolves.toBeNull();
    // An older Coordinator without the RPC: no ledger, no error.
    await expect(coordinatorPortOver({ db: forgeSqliteDb(), client: () => rpc({}) }).intentOps?.("demo", "i1")).resolves.toBeNull();
  });

  it("never lets a failed release or sync escape", async () => {
    const port = coordinatorPortOver({ db: forgeSqliteDb(), client: () => rpc({}) });
    await expect(port.release("demo", "i1")).resolves.toBeUndefined();
    await expect(port.sync?.("demo", "i1")).resolves.toBeUndefined();
  });
});

describe("whyPortOver", () => {
  it("is the D1 fallback without Artifacts", () => {
    expect(whyPortOver({ db: forgeSqliteDb(), chain: null }).kind).toBe("d1");
  });

  it("falls back to the footprint answer when blame throws", async () => {
    const port = whyPortOver({
      db: forgeSqliteDb(),
      chain: async () => {
        throw new Error("artifacts down");
      },
    });
    expect(port.kind).toBe("notes");
    const out = await port.why("demo", "src/a.ts", 3);
    expect(out.exact).toBe(false);
  });
});
