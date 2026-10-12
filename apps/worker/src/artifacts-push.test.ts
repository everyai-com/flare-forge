/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  ARTIFACTS_EVENT,
  ARTIFACTS_PUSH_TYPE,
  artifactsRunRepo,
  handleArtifactsPush,
  loadArtifactsPipeline,
  parseArtifactsPush,
  RUNNER_CHECKOUT_TTL_SECONDS,
  runnerCheckoutFor,
  type ArtifactsDispatchInput,
  type ArtifactsNamespace,
} from "./artifacts-push";

// node:sqlite via getBuiltinModule: vite-node's import analysis predates
// the specifier, but the runtime resolves it fine.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    `CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);`,
  );
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
            run: async () => {
              const info = raw.prepare(query).run(...params) as { changes?: unknown };
              return { meta: { changes: typeof info.changes === "number" ? info.changes : 0 } };
            },
          };
        },
      };
    },
  } as unknown as Db;
}

const SHA_A = "abc123def456abc123def456abc123def456abc1";
const SHA_B = "def789abc123def789abc123def789abc123def7";

function pushMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: ARTIFACTS_PUSH_TYPE,
    source: { type: "artifacts.repo", namespace: "default", repoName: "race-1" },
    payload: { ref: "refs/heads/main", before: SHA_A, after: SHA_B },
    metadata: { accountId: "acct" },
    ...over,
  };
}

function fakeArtifacts(yaml: string | null, seen: { disposed: boolean }): ArtifactsNamespace {
  return {
    get: async () => ({
      readFile: async () => (yaml === null ? null : { size: yaml.length, text: async () => yaml }),
      [Symbol.dispose]: () => {
        seen.disposed = true;
      },
    }),
  };
}

describe("parseArtifactsPush", () => {
  it("accepts a branch push", () => {
    expect(parseArtifactsPush(pushMsg())).toEqual({
      namespace: "default",
      repo: "race-1",
      ref: "refs/heads/main",
      before: SHA_A,
      after: SHA_B,
    });
  });
  it("rejects non-objects, wrong types, and account-level events", () => {
    expect(parseArtifactsPush(null)).toBeNull();
    expect(parseArtifactsPush({ type: "cf.artifacts.repo.created" })).toBeNull();
    expect(parseArtifactsPush(pushMsg({ type: "cf.artifacts.repo.created" }))).toBeNull();
    expect(
      parseArtifactsPush(pushMsg({ source: { type: "artifacts", namespace: "default", repoName: "race-1" } })),
    ).toBeNull();
  });
  it("rejects tag pushes and branch deletions", () => {
    expect(parseArtifactsPush(pushMsg({ payload: { ref: "refs/tags/v1", before: SHA_A, after: SHA_B } }))).toBeNull();
    expect(
      parseArtifactsPush(pushMsg({ payload: { ref: "refs/heads/main", before: SHA_A, after: "0".repeat(40) } })),
    ).toBeNull();
  });
  it("rejects malformed fields and oversized names", () => {
    expect(parseArtifactsPush(pushMsg({ payload: { ref: "refs/heads/main", before: SHA_A, after: "zzz" } }))).toBeNull();
    expect(
      parseArtifactsPush(pushMsg({ source: { type: "artifacts.repo", namespace: "a/b", repoName: "race-1" } })),
    ).toBeNull();
    expect(
      parseArtifactsPush(pushMsg({ source: { type: "artifacts.repo", namespace: "default", repoName: "x".repeat(101) } })),
    ).toBeNull();
  });
});

describe("artifactsRunRepo", () => {
  it("joins namespace and repo in owner/name shape", () => {
    expect(artifactsRunRepo(parseArtifactsPush(pushMsg())!)).toBe("default/race-1");
  });
});

describe("loadArtifactsPipeline", () => {
  it("returns the file text and disposes the handle", async () => {
    const seen = { disposed: false };
    const out = await loadArtifactsPipeline(fakeArtifacts("jobs:\n  t:\n    steps: []\n", seen), "race-1", SHA_B);
    expect(out).toContain("jobs:");
    expect(seen.disposed).toBe(true);
  });
  it("returns null for missing, blank, oversize, or throwing reads", async () => {
    const seen = { disposed: false };
    expect(await loadArtifactsPipeline(fakeArtifacts(null, seen), "race-1", SHA_B)).toBeNull();
    expect(await loadArtifactsPipeline(fakeArtifacts("  \n", seen), "race-1", SHA_B)).toBeNull();
    expect(await loadArtifactsPipeline(fakeArtifacts("x".repeat(300000), seen), "race-1", SHA_B)).toBeNull();
    const throwing: ArtifactsNamespace = {
      get: async () => {
        throw new Error("gone");
      },
    };
    expect(await loadArtifactsPipeline(throwing, "race-1", SHA_B)).toBeNull();
  });
});

describe("handleArtifactsPush", () => {
  const yaml = "jobs:\n  t:\n    steps:\n      - run: echo hi\n";

  it("dispatches with the artifacts event and namespace/name repo", async () => {
    const seen = { disposed: false };
    const inputs: ArtifactsDispatchInput[] = [];
    const out = await handleArtifactsPush(
      {
        db: sqliteDb(),
        artifacts: fakeArtifacts(yaml, seen),
        dispatch: async (input) => {
          inputs.push(input);
          return { runId: "run-1" };
        },
      },
      pushMsg(),
    );
    expect(out).toEqual({ status: "dispatched", runId: "run-1" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({ repo: "default/race-1", sha: SHA_B, ref: "refs/heads/main", pipeline: yaml, event: ARTIFACTS_EVENT });
    expect(seen.disposed).toBe(true);
  });
  it("dedupes redeliveries of the same push", async () => {
    const db = sqliteDb();
    const deps = {
      db,
      artifacts: fakeArtifacts(yaml, { disposed: false }),
      dispatch: async () => ({ runId: "run-1" }),
    };
    expect(await handleArtifactsPush(deps, pushMsg())).toEqual({ status: "dispatched", runId: "run-1" });
    expect(await handleArtifactsPush(deps, pushMsg())).toEqual({ status: "skipped", reason: "duplicate" });
  });
  it("skips pushes to hands-free GitHub mirrors (trunk sync) before claiming", async () => {
    const db = sqliteDb();
    let dispatched = 0;
    const deps = {
      db,
      artifacts: fakeArtifacts(yaml, { disposed: false }),
      dispatch: async () => {
        dispatched++;
        return { runId: "run-1" };
      },
      isMirror: async (repo: string) => repo === "race-1",
    };
    expect(await handleArtifactsPush(deps, pushMsg())).toEqual({ status: "skipped", reason: "mirror" });
    expect(dispatched).toBe(0);
    // Delivery id not burned; a non-mirror lookup failure fails open.
    expect(await handleArtifactsPush({ ...deps, isMirror: async () => Promise.reject(new Error("db")) }, pushMsg())).toEqual({
      status: "dispatched",
      runId: "run-1",
    });
  });
  it("skips invalid envelopes without touching the binding", async () => {
    let calls = 0;
    const out = await handleArtifactsPush(
      {
        db: sqliteDb(),
        artifacts: { get: async () => { calls++; throw new Error("unreachable"); } },
        dispatch: async () => ({ runId: "run-1" }),
      },
      { type: "nope" },
    );
    expect(out).toEqual({ status: "skipped", reason: "invalid" });
    expect(calls).toBe(0);
  });
  it("skips without a binding and does not burn the delivery id", async () => {
    const db = sqliteDb();
    const without = { db, artifacts: null, dispatch: async () => ({ runId: "run-1" }) };
    expect(await handleArtifactsPush(without, pushMsg())).toEqual({ status: "skipped", reason: "no-binding" });
    // A later configured redelivery still dispatches.
    const seen = { disposed: false };
    const out = await handleArtifactsPush({ db, artifacts: fakeArtifacts(yaml, seen), dispatch: async () => ({ runId: "run-2" }) }, pushMsg());
    expect(out).toEqual({ status: "dispatched", runId: "run-2" });
  });
  it("skips pushes with no pipeline and failed dispatches", async () => {
    const seen = { disposed: false };
    expect(
      await handleArtifactsPush(
        { db: sqliteDb(), artifacts: fakeArtifacts(null, seen), dispatch: async () => ({ runId: "run-1" }) },
        pushMsg(),
      ),
    ).toEqual({ status: "skipped", reason: "no-pipeline" });
    expect(
      await handleArtifactsPush(
        {
          db: sqliteDb(),
          artifacts: fakeArtifacts(yaml, seen),
          dispatch: async () => { throw new Error("parse failed"); },
        },
        pushMsg(),
      ),
    ).toEqual({ status: "skipped", reason: "dispatch-failed" });
  });
});

describe("runnerCheckoutFor", () => {
  const ACC = "a".repeat(32);
  function tokens(out: { plaintext: string } | string | Error) {
    const seen: { names: string[]; scopes: string[]; ttls: number[]; disposed: number } = { names: [], scopes: [], ttls: [], disposed: 0 };
    const ns = {
      get: async (name: string) => {
        seen.names.push(name);
        return {
          createToken: async (scope: "read" | "write", ttl: number) => {
            seen.scopes.push(scope);
            seen.ttls.push(ttl);
            if (out instanceof Error) throw out;
            return out;
          },
          [Symbol.dispose]: () => {
            seen.disposed++;
          },
        };
      },
    };
    return { ns, seen };
  }

  it("mints a 10-minute read token for the run's repo and names the remote", async () => {
    const { ns, seen } = tokens({ plaintext: "tok-1" });
    const out = await runnerCheckoutFor(ns, { accountId: ACC, namespace: "flare-forge-preview", runRepo: "flare-forge-preview/bookshelf" });
    expect(out).toEqual({ url: `https://${ACC}.artifacts.cloudflare.net/git/flare-forge-preview/bookshelf.git`, token: "tok-1", username: "x", expiresInSeconds: RUNNER_CHECKOUT_TTL_SECONDS });
    expect(seen).toEqual({ names: ["bookshelf"], scopes: ["read"], ttls: [600], disposed: 1 });
  });

  it("refuses repos outside our namespace and degrades mint failures to null", async () => {
    const { ns, seen } = tokens("tok");
    expect(await runnerCheckoutFor(ns, { accountId: ACC, namespace: "mine", runRepo: "other/bookshelf" })).toBeNull();
    expect(await runnerCheckoutFor(ns, { accountId: ACC, namespace: "mine", runRepo: "no-slash" })).toBeNull();
    expect(await runnerCheckoutFor(ns, { accountId: "bad", namespace: "mine", runRepo: "mine/x" })).toBeNull();
    expect(seen.names).toEqual([]);
    const failing = tokens(new Error("down"));
    expect(await runnerCheckoutFor(failing.ns, { accountId: ACC, namespace: "mine", runRepo: "mine/x" })).toBeNull();
    expect(failing.seen.disposed).toBe(1);
    expect(await runnerCheckoutFor(tokens("").ns, { accountId: ACC, namespace: "mine", runRepo: "mine/x" })).toBeNull();
  });
});
