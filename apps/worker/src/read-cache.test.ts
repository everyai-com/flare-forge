import { describe, expect, it } from "vitest";
import { meterArtifacts, type BindingOpKind } from "./forge-ops";
import {
  bucketReadCache,
  cacheArtifacts,
  commitKey,
  memoryReadCache,
  tieredReadCache,
  type ReadCache,
} from "./read-cache";

const A = "a".repeat(40);
const B = "b".repeat(40);
const T = "c".repeat(40);

interface Calls {
  [method: string]: number;
}

// A fake ARTIFACTS binding: per-repo objects, counts every handle call.
function fakeBinding(files: Record<string, Uint8Array | string> = {}) {
  const calls: Calls = {};
  const bump = (m: string): void => {
    calls[m] = (calls[m] ?? 0) + 1;
  };
  const commits: Record<string, Record<string, unknown>> = {
    trunk: { [A]: { hash: A, treeHash: T, message: "m", author: { name: "a", email: "e" }, committer: { name: "a", email: "e" }, parents: [], authoredAt: 1, committedAt: 1 } },
    fork: {},
  };
  const handle = (repo: string) => ({
    repo,
    async readCommit(hash: string) {
      bump("readCommit");
      return commits[repo]?.[hash] ?? null;
    },
    async readTree(hash: string) {
      bump("readTree");
      return hash === T ? [{ name: "a.ts", mode: "100644", hash: B, type: "blob" }] : null;
    },
    async readFile(args: { ref: string; path: string }) {
      bump("readFile");
      const v = files[args.path];
      if (v === undefined) return null;
      return new Blob([v], { type: "text/plain" });
    },
    async log(opts?: { ref?: string; limit?: number }) {
      bump("log");
      return opts?.ref === A || opts?.ref === "main" ? [commits.trunk[A]] : [];
    },
    async info() {
      bump("info");
      return { name: this.repo };
    },
  });
  const binding = {
    async get(name: string) {
      return handle(name);
    },
  };
  return { binding, calls };
}

describe("cacheArtifacts", () => {
  it("answers a second readCommit/readTree by hash from the cache", async () => {
    const { binding, calls } = fakeBinding();
    let hits = 0;
    const art = cacheArtifacts(binding, { cache: memoryReadCache(), onHit: () => hits++ });
    const h = await art.get("trunk");
    expect(await h.readCommit(A)).toMatchObject({ hash: A, treeHash: T });
    expect(await h.readCommit(A)).toMatchObject({ hash: A, treeHash: T });
    expect(await h.readTree(T)).toHaveLength(1);
    expect(await h.readTree(T)).toEqual([{ name: "a.ts", mode: "100644", hash: B, type: "blob" }]);
    expect(calls).toEqual({ readCommit: 1, readTree: 1 });
    expect(hits).toBe(2);
  });

  it("never caches a miss: an object can appear after a push", async () => {
    const { binding, calls } = fakeBinding();
    const art = cacheArtifacts(binding, { cache: memoryReadCache() });
    const h = await art.get("trunk");
    expect(await h.readCommit(B)).toBeNull();
    expect(await h.readCommit(B)).toBeNull();
    expect(calls.readCommit).toBe(2);
  });

  it("keys per repo, so one fork's objects never answer for another", async () => {
    const { binding, calls } = fakeBinding();
    const cache = memoryReadCache();
    const art = cacheArtifacts(binding, { cache });
    await (await art.get("trunk")).readCommit(A);
    expect(await (await art.get("fork")).readCommit(A)).toBeNull();
    expect(calls.readCommit).toBe(2);
    expect(await cache.get(commitKey("trunk", A))).not.toBeNull();
    expect(await cache.get(commitKey("fork", A))).toBeNull();
  });

  it("caches readFile only when pinned to a full sha", async () => {
    const { binding, calls } = fakeBinding({ "src/a.ts": "export const a = 1;\n" });
    const art = cacheArtifacts(binding, { cache: memoryReadCache() });
    const h = await art.get("trunk");
    const one = await h.readFile({ ref: A, path: "src/a.ts" });
    const two = await h.readFile({ ref: A, path: "src/a.ts" });
    expect(await one?.text()).toBe("export const a = 1;\n");
    expect(await two?.text()).toBe("export const a = 1;\n");
    expect(two?.size).toBe(20);
    expect(two?.type).toBe("text/plain");
    await h.readFile({ ref: "main", path: "src/a.ts" });
    await h.readFile({ ref: "main", path: "src/a.ts" });
    expect(calls.readFile).toBe(3);
  });

  it("serves every file byte-exact; binary and invalid UTF-8 stay uncached", async () => {
    const bin = new Uint8Array([0x89, 0x50, 0x00, 0x01]);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const bad = new Uint8Array([0x68, 0xff, 0x69]);
    const { binding, calls } = fakeBinding({ bin, bom, bad });
    const art = cacheArtifacts(binding, { cache: memoryReadCache() });
    const h = await art.get("trunk");
    for (const [path, bytes] of [["bin", bin], ["bom", bom], ["bad", bad]] as const) {
      for (let i = 0; i < 2; i++) {
        const f = await h.readFile({ ref: A, path });
        expect(new Uint8Array(await f!.arrayBuffer())).toEqual(bytes);
      }
    }
    // bin and bad: 2 binding reads each; bom round-trips, so 1.
    expect(calls.readFile).toBe(5);
  });

  it("caches log only from a fixed commit", async () => {
    const { binding, calls } = fakeBinding();
    const art = cacheArtifacts(binding, { cache: memoryReadCache() });
    const h = await art.get("trunk");
    await h.log({ ref: A, limit: 5 });
    expect(await h.log({ ref: A, limit: 5 })).toHaveLength(1);
    await h.log({ ref: "main", limit: 5 });
    await h.log({ ref: "main", limit: 5 });
    expect(calls.log).toBe(3);
  });

  it("passes other methods through with the real handle as receiver", async () => {
    const { binding, calls } = fakeBinding();
    const art = cacheArtifacts(binding, { cache: memoryReadCache() });
    expect(await (await art.get("trunk")).info()).toEqual({ name: "trunk" });
    expect(calls.info).toBe(1);
  });

  it("a corrupt or failing cache degrades to the binding", async () => {
    const { binding, calls } = fakeBinding();
    const broken: ReadCache = {
      get: async (k) => (k.includes("/c/") ? "{not json" : Promise.reject(new Error("down"))),
      put: async () => {
        throw new Error("down");
      },
    };
    const art = cacheArtifacts(binding, { cache: broken });
    const h = await art.get("trunk");
    expect(await h.readCommit(A)).toMatchObject({ hash: A });
    expect(await h.readTree(T)).toHaveLength(1);
    expect(calls).toEqual({ readCommit: 1, readTree: 1 });
  });

  it("wrapped outside the meter, hits never count as binding reads", async () => {
    const { binding } = fakeBinding();
    const seen: Array<[string, BindingOpKind | "cached"]> = [];
    const art = cacheArtifacts(meterArtifacts(binding, (repo, kind) => seen.push([repo, kind])), {
      cache: memoryReadCache(),
      onHit: (repo) => seen.push([repo, "cached"]),
    });
    const h = await art.get("trunk");
    await h.readCommit(A);
    await h.readCommit(A);
    await h.readCommit(A);
    expect(seen).toEqual([
      ["trunk", "read"],
      ["trunk", "cached"],
      ["trunk", "cached"],
    ]);
  });

  it("defers fills when asked", async () => {
    const { binding } = fakeBinding();
    const deferred: Array<Promise<unknown>> = [];
    const cache = memoryReadCache();
    const art = cacheArtifacts(binding, { cache, defer: (p) => deferred.push(p) });
    await (await art.get("trunk")).readCommit(A);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(await cache.get(commitKey("trunk", A))).not.toBeNull();
  });
});

describe("read cache stores", () => {
  it("memory LRU evicts the least recently used past its budget", async () => {
    const c = memoryReadCache({ maxEntries: 2 });
    await c.put("a", "1");
    await c.put("b", "2");
    await c.get("a");
    await c.put("c", "3");
    expect(await c.get("a")).toBe("1");
    expect(await c.get("b")).toBeNull();
    expect(await c.get("c")).toBe("3");
    const small = memoryReadCache({ maxChars: 4 });
    await small.put("x", "12345");
    expect(small.size).toBe(0);
  });

  it("tiered: a far hit refills near; puts write both", async () => {
    const near = memoryReadCache();
    const far = memoryReadCache();
    await far.put("k", "v");
    const t = tieredReadCache(near, far);
    expect(await t.get("k")).toBe("v");
    expect(await near.get("k")).toBe("v");
    await t.put("k2", "v2");
    expect(await far.get("k2")).toBe("v2");
  });

  it("bucket tier prefixes keys and turns failures into misses", async () => {
    const store = new Map<string, string>();
    const bucket = {
      get: async (k: string) => (store.has(k) ? { text: async () => store.get(k) ?? "" } : null),
      put: async (k: string, v: string) => store.set(k, v),
    };
    const c = bucketReadCache(bucket);
    await c.put("trunk/c/x", "{}");
    expect([...store.keys()]).toEqual(["forge/read-cache/trunk/c/x"]);
    expect(await c.get("trunk/c/x")).toBe("{}");
    const down = bucketReadCache({ get: () => Promise.reject(new Error("x")), put: () => Promise.reject(new Error("x")) });
    expect(await down.get("k")).toBeNull();
    await expect(down.put("k", "v")).resolves.toBeUndefined();
  });
});
