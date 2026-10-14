/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { diffCommits, pathHistory, readPath, resolveSha, unifiedDiff } from "./forge-read";
import { claimOp, declareOp, diffOp, forgeServiceDeps, historyOp, readFileOp, reportPushOp, type ForgePrincipal } from "./forge-service";
import type { ForgeArtifacts } from "./intents";
import { cacheArtifacts, memoryReadCache } from "./read-cache";
import { forgeSqliteDb } from "./forge.testkit";

const { createHash } = process.getBuiltinModule("node:crypto");

function oid(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

interface Entry {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob";
}

// A content-addressed git stand-in: blob/tree/commit ids are hashes of
// their content, so unchanged subtrees share ids across commits (what the
// read cache and changedFiles rely on). Counts every handle call.
function gitFake() {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Entry[]>();
  const commits = new Map<string, { treeHash: string; parents: string[]; message: string; committedAt: number; author: { name: string; email: string } }>();
  const repos = new Map<string, { head: string | null }>();
  const calls: Record<string, number> = {};
  const bump = (m: string): void => {
    calls[m] = (calls[m] ?? 0) + 1;
  };
  let clock = 1_700_000_000;

  const writeTree = (files: Record<string, string>, prefix = ""): string => {
    const dirs = new Map<string, Record<string, string>>();
    const entries: Entry[] = [];
    for (const [path, text] of Object.entries(files)) {
      const [head, ...rest] = path.split("/");
      if (rest.length) dirs.set(head, { ...(dirs.get(head) ?? {}), [rest.join("/")]: text });
      else {
        const h = oid(`blob ${text}`);
        blobs.set(h, text);
        entries.push({ name: head, mode: "100644", hash: h, type: "blob" });
      }
    }
    for (const [name, sub] of dirs) entries.push({ name, mode: "40000", hash: writeTree(sub, `${prefix}${name}/`), type: "tree" });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    const h = oid(`tree ${JSON.stringify(entries)}`);
    trees.set(h, entries);
    return h;
  };
  const filesAt = (sha: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (tree: string, prefix: string): void => {
      for (const e of trees.get(tree) ?? []) {
        if (e.type === "tree") walk(e.hash, `${prefix}${e.name}/`);
        else out[`${prefix}${e.name}`] = blobs.get(e.hash) ?? "";
      }
    };
    const c = commits.get(sha);
    if (c) walk(c.treeHash, "");
    return out;
  };
  // Commit `changes` (null deletes) on top of the repo head.
  const commit = (repo: string, message: string, changes: Record<string, string | null>, author = "dev"): string => {
    const r = repos.get(repo);
    if (!r) throw new Error(`no repo ${repo}`);
    const files = r.head ? filesAt(r.head) : {};
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete files[k];
      else files[k] = v;
    }
    const treeHash = writeTree(files);
    const parents = r.head ? [r.head] : [];
    const s = oid(`commit ${treeHash} ${parents.join(",")} ${message} ${clock}`);
    commits.set(s, { treeHash, parents, message, committedAt: clock++, author: { name: author, email: `${author}@x` } });
    r.head = s;
    return s;
  };
  const resolve = (repo: string, ref: string | undefined): string | null => {
    if (!ref || ref === "main" || ref === "HEAD") return repos.get(repo)?.head ?? null;
    return commits.has(ref) ? ref : null;
  };
  const handle = (name: string) => ({
    async log(opts?: { ref?: string; limit?: number }) {
      bump("log");
      const out = [];
      let cur = resolve(name, opts?.ref);
      while (cur && out.length < (opts?.limit ?? 50)) {
        const c = commits.get(cur)!;
        out.push({ hash: cur, ...c });
        cur = c.parents[0] ?? null;
      }
      return out;
    },
    async readCommit(hash: string) {
      bump("readCommit");
      const c = commits.get(hash);
      return c ? { hash, ...c } : null;
    },
    async readTree(hash: string) {
      bump("readTree");
      return trees.get(hash) ?? null;
    },
    async readFile(args: { ref: string; path: string }) {
      bump("readFile");
      const sha = resolve(name, args.ref);
      const text = sha ? filesAt(sha)[args.path] : undefined;
      return text === undefined ? null : new Blob([text], { type: "text/plain" });
    },
    async fork(forkName: string) {
      repos.set(forkName, { head: repos.get(name)?.head ?? null });
      return { name: forkName, remote: `https://x.test/git/ns/${forkName}.git`, defaultBranch: "main" };
    },
    async createToken() {
      return { plaintext: `tok-${name}` };
    },
    [Symbol.dispose]: () => undefined,
  });
  const artifacts = {
    async get(name: string) {
      if (!repos.has(name)) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      return handle(name);
    },
  };
  const create = (name: string): void => {
    repos.set(name, { head: null });
  };
  return { artifacts: artifacts as unknown as ForgeArtifacts & typeof artifacts, calls, commit, create, repos };
}

function seeded() {
  const g = gitFake();
  g.create("shop");
  const c1 = g.commit("shop", "init", { "README.md": "hi\n", "src/api/a.ts": "export const a = 1;\n", "src/web/b.ts": "b\n" });
  const c2 = g.commit("shop", "touch web", { "src/web/b.ts": "b2\n" });
  const c3 = g.commit("shop", "speed up a", { "src/api/a.ts": "export const a = 2;\nexport const b = 3;\n" }, "alice");
  return { g, c1, c2, c3 };
}

const ADMIN: ForgePrincipal = { actor: "token:t", repos: [], isAdmin: true, canWrite: true, agent: "alpha" };

describe("unifiedDiff", () => {
  it("emits git-style hunks with context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
    const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9", "10", "11"].join("\n") + "\n";
    // Changes within 2 x context of each other share one hunk (git does too).
    expect(unifiedDiff(before, after)).toBe(["@@ -2,9 +2,10 @@", " 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8", " 9", " 10", "+11"].join("\n"));
    const lines = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const far = lines.map((l) => (l === "2" ? "two" : l === "18" ? "eighteen" : l));
    expect(unifiedDiff(lines.join("\n"), far.join("\n"))).toBe(
      ["@@ -1,5 +1,5 @@", " 1", "-2", "+two", " 3", " 4", " 5", "@@ -15,6 +15,6 @@", " 15", " 16", " 17", "-18", "+eighteen", " 19", " 20"].join("\n"),
    );
  });

  it("handles added, deleted and identical files", () => {
    expect(unifiedDiff("", "a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
    expect(unifiedDiff("a\n", "")).toBe("@@ -1,1 +0,0 @@\n-a");
    expect(unifiedDiff("same\n", "same\n")).toBe("");
  });
});

describe("forge-read core", () => {
  it("reads a file, a line range and a directory at a sha", async () => {
    const { g, c3 } = seeded();
    const h = await g.artifacts.get("shop");
    const file = await readPath(h, c3, "src/api/a.ts");
    expect(file).toMatchObject({ kind: "file", lines: 2, text: "export const a = 2;\nexport const b = 3;\n", truncated: false });
    expect(await readPath(h, c3, "src/api/a.ts", { start: 2, end: null })).toMatchObject({ text: "export const b = 3;", range: { start: 2, end: 2 } });
    const root = await readPath(h, c3, "");
    expect(root?.kind === "dir" && root.entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:src", "file:README.md"]);
    expect(await readPath(h, c3, "src/nope.ts")).toBeNull();
    expect(await resolveSha(h, "main")).toBe(c3);
  });

  it("diffs two commits with per-file patches", async () => {
    const { g, c1, c3 } = seeded();
    g.commit("shop", "add + delete", { "docs/x.md": "x\n", "README.md": null });
    const head = g.repos.get("shop")!.head!;
    const h = await g.artifacts.get("shop");
    const out = await diffCommits(h, c1, head);
    expect(out?.files.map((f) => `${f.status} ${f.path}`)).toEqual(["deleted README.md", "added docs/x.md", "modified src/api/a.ts", "modified src/web/b.ts"]);
    expect(out?.files.find((f) => f.path === "src/api/a.ts")?.patch).toBe("@@ -1,1 +1,2 @@\n-export const a = 1;\n+export const a = 2;\n+export const b = 3;");
    expect((await diffCommits(h, c1, c3, "src/api"))?.files.map((f) => f.path)).toEqual(["src/api/a.ts"]);
  });

  it("lists only the commits that changed a path, back to the one that added it", async () => {
    const { g, c1, c3 } = seeded();
    const c4 = g.commit("shop", "delete a", { "src/api/a.ts": null });
    const h = await g.artifacts.get("shop");
    const a = await pathHistory(h, c4, "src/api/a.ts");
    expect(a.commits.map((c) => [c.hash, c.change])).toEqual([
      [c4, "deleted"],
      [c3, "modified"],
      [c1, "added"],
    ]);
    expect(a.commits[1]).toMatchObject({ message: "speed up a", author: "alice" });
    expect(a.truncated).toBe(false);
    const dir = await pathHistory(h, c4, "src/web");
    expect(dir.commits.map((c) => c.message)).toEqual(["touch web", "init"]);
    expect((await pathHistory(h, c4, "src/api/a.ts", 1)).truncated).toBe(true);
  });
});

describe("read verbs (forge-service)", () => {
  it("read_file reads trunk; pinned to the returned sha, a repeat read never reaches the binding", async () => {
    const { g, c3 } = seeded();
    const artifacts = cacheArtifacts(g.artifacts, { cache: memoryReadCache() });
    const deps = forgeServiceDeps({ db: forgeSqliteDb(), artifacts, namespace: "ns" });
    const first = await readFileOp(deps, ADMIN, { repo: "shop", path: "src/api/a.ts" });
    expect(first.ok && first.data).toMatchObject({ repo: "shop", ref: "main", kind: "file", sha: c3, lines: 2 });
    expect(first.ok && first.data.nextSteps).toEqual([expect.objectContaining({ tool: "why" })]);
    const before = { ...g.calls };
    const again = await readFileOp(deps, ADMIN, { repo: "shop", path: "src/api/a.ts", ref: c3 });
    expect(again.ok && again.data.text).toBe("export const a = 2;\nexport const b = 3;\n");
    expect(g.calls).toEqual(before);
  });

  it("scopes reads to the token's repos and reports a missing binding", async () => {
    const { g } = seeded();
    const deps = forgeServiceDeps({ db: forgeSqliteDb(), artifacts: g.artifacts, namespace: "ns" });
    const scoped = await readFileOp(deps, { ...ADMIN, repos: ["ns/other"] }, { repo: "shop", path: "README.md" });
    expect(!scoped.ok && scoped.body.code).toBe("repo_not_allowed");
    const none = await readFileOp(forgeServiceDeps({ db: forgeSqliteDb(), namespace: "ns" }), ADMIN, { repo: "shop" });
    expect(!none.ok && none.body.code).toBe("artifacts_unconfigured");
    const bad = await readFileOp(deps, ADMIN, { repo: "shop", path: "../etc" });
    expect(!bad.ok && bad.status).toBe(400);
    const missing = await readFileOp(deps, ADMIN, { repo: "shop", path: "nope.ts" });
    expect(!missing.ok && missing.status).toBe(404);
  });

  it("diff + read_file on an intent's fork after report_push; history links landed intents", async () => {
    const { g, c3 } = seeded();
    const db = forgeSqliteDb();
    const deps = forgeServiceDeps({ db, artifacts: g.artifacts, namespace: "ns" });
    const decl = await declareOp(deps, ADMIN, { repo: "shop", title: "Cache a", footprint: ["src/api/a.ts"], reasoning: "slow", accept: "npm test" });
    expect(decl.ok).toBe(true);
    const intentId = decl.ok ? (decl.data.intent as { id: string }).id : "";
    const claim = await claimOp(deps, ADMIN, { intentId });
    expect(claim.ok).toBe(true);
    const fork = claim.ok ? (claim.data.forkRepo as string) : "";

    const early = await diffOp(deps, ADMIN, { intentId });
    expect(!early.ok && early.body.code).toBe("invalid_request");

    const head = g.commit(fork, "cache it", { "src/api/a.ts": "export const a = 2;\nexport const b = 3;\nexport const cache = new Map();\n" });
    expect((await reportPushOp(deps, ADMIN, { intentId, sha: head })).ok).toBe(true);

    const diff = await diffOp(deps, ADMIN, { intentId });
    expect(diff.ok && diff.data).toMatchObject({ intentId, fork, base: c3, head, stat: { added: 0, modified: 1, deleted: 0 } });
    expect(diff.ok && (diff.data.files as Array<{ patch: string }>)[0].patch).toContain("+export const cache = new Map();");

    const onFork = await readFileOp(deps, ADMIN, { intentId, path: "src/api/a.ts", startLine: 3 });
    expect(onFork.ok && onFork.data).toMatchObject({ fork, sha: head, text: "export const cache = new Map();" });
    const onTrunk = await readFileOp(deps, ADMIN, { repo: "shop", path: "src/api/a.ts" });
    expect(onTrunk.ok && onTrunk.data.lines).toBe(2);

    const byRefs = await diffOp(deps, ADMIN, { repo: "shop", base: c3, head: "main" });
    expect(byRefs.ok && byRefs.data.files).toEqual([]);

    await db.prepare("UPDATE intents SET landed_sha = ? WHERE id = ?").bind(c3, intentId).run();
    const hist = await historyOp(deps, ADMIN, { repo: "shop", path: "src/api/a.ts" });
    expect(hist.ok && (hist.data.commits as Array<{ hash: string; intents: unknown[] }>).map((c) => [c.hash === c3, c.intents.length])).toEqual([
      [true, 1],
      [false, 0],
    ]);
    const noPath = await historyOp(deps, ADMIN, { repo: "shop" });
    expect(!noPath.ok && noPath.status).toBe(400);
  });
});
