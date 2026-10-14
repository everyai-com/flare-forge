import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git";
import { createToken, getMirrorRow } from "./db";
import { forgeSqliteDb } from "./forge.testkit";
import { MemoryFS } from "./memory-fs";
import { authIdentityFromToken, hashToken, MEMBER_TOKEN_SCOPE, memberRepos, NO_REPOS } from "./tokens";
import { createMemberRepo, FORGE_READY_DETAIL, importGithubRepo, prepareForgeTrunk, listOwnedRepos, MEMBER_REPO_LIMIT, parseGithubRepo, starterFiles, validateWorkspaceName, type WorkspaceGit } from "./workspace";

// Real isomorphic-git on MemoryFS; only the network push is faked.
function fakeGit(pushed: string[], failOn?: string): WorkspaceGit {
  return {
    init: (a) => git.init(a),
    add: (a) => git.add(a),
    commit: (a) => git.commit(a),
    addNote: (a) => git.addNote(a),
    push: async (a) => {
      pushed.push(a.remoteRef);
      return a.remoteRef === failOn ? { ok: false, error: "boom" } : { ok: true };
    },
  };
}

function deps(over: { pushed?: string[]; failOn?: string; exists?: boolean } = {}) {
  const db = forgeSqliteDb();
  const created: string[] = [];
  return {
    created,
    d: {
      db,
      artifacts: {
        create: async (name: string) => {
          if (over.exists) throw new Error("ALREADY_EXISTS: repo exists");
          created.push(name);
          return { remote: `https://art/${name}.git`, token: "t" };
        },
      },
      git: fakeGit(over.pushed ?? [], over.failOn),
      http: {} as HttpClient,
      fs: () => new MemoryFS(),
      namespace: "ns",
      lanes: 3,
    },
  };
}

describe("workspace names", () => {
  it("accepts simple lowercase names and rejects the rest", () => {
    expect(validateWorkspaceName(" My-App ")).toBe("my-app");
    for (const bad of ["ab", "-ab", "ab-", "a--b", "a_b", "x".repeat(41), 7]) expect(validateWorkspaceName(bad)).toBeNull();
  });
});

describe("createMemberRepo", () => {
  it("creates, records the owner, and seeds main, the lane pool and the notes ref", async () => {
    const pushed: string[] = [];
    const { d, created } = deps({ pushed });
    const out = await createMemberRepo(d, "email:sam@example.com", "my-app");
    expect(out).toMatchObject({ ok: true, repo: "my-app", scoped: "ns/my-app", lanes: 3 });
    expect(created).toEqual(["my-app"]);
    expect(pushed).toEqual(["refs/heads/main", "refs/heads/forge/lane-0", "refs/heads/forge/lane-1", "refs/heads/forge/lane-2", "refs/notes/why"]);
    expect(await listOwnedRepos(d.db, "email:sam@example.com")).toEqual([expect.objectContaining({ repo: "my-app" })]);
    expect(await memberRepos(d.db, "email:sam@example.com")).toEqual(["ns/my-app"]);
    expect(await memberRepos(d.db, "email:eve@example.com")).toEqual([NO_REPOS]);
  });

  it("refuses taken names, the per-account limit, and reports seed failures", async () => {
    const { d } = deps();
    expect(await createMemberRepo(d, "email:a@x.io", "dup-name")).toMatchObject({ ok: true });
    expect(await createMemberRepo(d, "email:b@x.io", "dup-name")).toMatchObject({ ok: false, code: "repo_exists" });
    expect(await createMemberRepo(deps({ exists: true }).d, "email:a@x.io", "other")).toMatchObject({ ok: false, code: "repo_exists" });
    for (let i = 1; i < MEMBER_REPO_LIMIT; i++) expect(await createMemberRepo(d, "email:a@x.io", `repo-${i}`)).toMatchObject({ ok: true });
    expect(await createMemberRepo(d, "email:a@x.io", "one-more")).toMatchObject({ ok: false, code: "repo_limit" });
    const failing = deps({ failOn: "refs/heads/forge/lane-1" }).d;
    const bad = await createMemberRepo(failing, "email:c@x.io", "half-seeded");
    expect(bad).toMatchObject({ ok: false, code: "repo_create_failed" });
    // The creator still owns it, so nobody else can take the name.
    expect(await memberRepos(failing.db, "email:c@x.io")).toEqual(["ns/half-seeded"]);
  });

  it("ships a starter project whose CI runs the tests", () => {
    const files = starterFiles("demo-app");
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["flare.yml", "package.json", "test/greet.test.js", "AGENTS.md"]));
    expect(files["flare.yml"]).toContain("node --test test/");
  });
});

describe("member agent tokens", () => {
  it("resolve to the owner's repos at request time and never to every repo", async () => {
    const { d } = deps();
    await createToken(d.db, { id: "t1", name: "agent", tokenHash: await hashToken("secret-1"), scopes: MEMBER_TOKEN_SCOPE, repos: "", owner: "email:sam@example.com" });
    expect(await authIdentityFromToken("secret-1", { db: d.db })).toEqual({ scope: "member", actor: "token:t1", repos: [NO_REPOS], owner: "email:sam@example.com" });
    await createMemberRepo(d, "email:sam@example.com", "new-repo");
    expect((await authIdentityFromToken("secret-1", { db: d.db }))?.repos).toEqual(["ns/new-repo"]);
    // A member-scoped row without an owner is refused, not widened.
    await createToken(d.db, { id: "t2", name: "x", tokenHash: await hashToken("secret-2"), scopes: MEMBER_TOKEN_SCOPE, repos: "" });
    expect(await authIdentityFromToken("secret-2", { db: d.db })).toBeNull();
  });
});

describe("importGithubRepo", () => {
  function importDeps(over: { refs?: Array<{ ref: string; oid: string }>; importFails?: string } = {}) {
    const db = forgeSqliteDb();
    const pushed: Array<{ remoteRef: string; ref: string }> = [];
    const tip = "a".repeat(40);
    const refs = over.refs ?? [{ ref: "refs/heads/master", oid: tip }];
    return {
      db,
      pushed,
      tip,
      d: {
        db,
        artifacts: {
          import: async () => {
            if (over.importFails) throw Object.assign(new Error("x"), { code: over.importFails });
            return { remote: "https://art/x.git" };
          },
          get: async () => ({ createToken: async () => ({ plaintext: "w" }), info: async () => ({ remote: "https://art/x.git" }) }),
          delete: async () => true,
        },
        git: {
          init: async () => undefined,
          writeRef: async () => undefined,
          addNote: async () => "n".repeat(40),
          listServerRefs: async () => refs,
          push: async (a: { remoteRef: string; ref: string }) => {
            pushed.push({ remoteRef: a.remoteRef, ref: a.ref });
            return { ok: true };
          },
        },
        http: {} as HttpClient,
        fs: () => new MemoryFS(),
        namespace: "ns",
        lanes: 2,
      },
    };
  }

  it("parses owner/name from names and URLs", () => {
    expect(parseGithubRepo("everyai-com/flare-forge")).toBe("everyai-com/flare-forge");
    expect(parseGithubRepo("https://github.com/everyai-com/flare-forge.git")).toBe("everyai-com/flare-forge");
    expect(parseGithubRepo("github.com/a/b/")).toBe("a/b");
    for (const bad of ["", "a", "a/b/c", "https://gitlab.com/a/b", "a/..", 3]) expect(parseGithubRepo(bad)).toBeNull();
  });

  it("imports, records the owner, adds main + lanes + notes at the tip without uploading history", async () => {
    const { d, pushed, tip } = importDeps();
    const out = await importGithubRepo(d, "github:sam", "sam/app", { isPrivate: false });
    expect(out).toMatchObject({ ok: true, status: "ready", repo: "sam-app", scoped: "ns/sam-app", trunk: tip, lanesCreated: 2 });
    expect(pushed).toEqual([
      { remoteRef: "refs/heads/main", ref: "refs/heads/tip" },
      { remoteRef: "refs/heads/forge/lane-0", ref: "refs/heads/tip" },
      { remoteRef: "refs/heads/forge/lane-1", ref: "refs/heads/tip" },
      { remoteRef: "refs/notes/why", ref: "refs/notes/why" },
    ]);
    expect(await memberRepos(d.db, "github:sam")).toEqual(["ns/sam-app"]);
    // Marked train-ready, so the first-push hook will not redo the work.
    expect((await getMirrorRow(d.db, "sam/app"))?.detail).toBe(FORGE_READY_DETAIL);
  });

  it("prepareForgeTrunk is idempotent: a ready trunk pushes nothing", async () => {
    const tip = "c".repeat(40);
    const refs = [{ ref: "refs/heads/main", oid: tip }, { ref: "refs/notes/why", oid: tip }, ...Array.from({ length: 2 }, (_, i) => ({ ref: `refs/heads/forge/lane-${i}`, oid: tip }))];
    const { d, pushed } = importDeps({ refs });
    expect(await prepareForgeTrunk(d, "sam-app")).toEqual({ tip, lanesCreated: 0 });
    expect(pushed).toEqual([]);
  });

  it("is idempotent for the owner and refuses other accounts", async () => {
    const tip = "b".repeat(40);
    const { d, pushed } = importDeps({ refs: [{ ref: "refs/heads/main", oid: tip }, { ref: "refs/heads/forge/lane-0", oid: tip }, { ref: "refs/notes/why", oid: tip }] });
    expect(await importGithubRepo(d, "github:sam", "sam/app", { isPrivate: false })).toMatchObject({ ok: true, lanesCreated: 1 });
    expect(pushed.map((p) => p.remoteRef)).toEqual(["refs/heads/forge/lane-1"]);
    expect(await importGithubRepo(d, "github:sam", "sam/app", { isPrivate: false })).toMatchObject({ ok: true });
    expect(await importGithubRepo(d, "email:eve@x.io", "sam/app", { isPrivate: false })).toMatchObject({ ok: false, code: "repo_exists" });
  });

  it("explains a failed private import", async () => {
    const { d } = importDeps({ importFails: "REMOTE_AUTH_REQUIRED" });
    const out = await importGithubRepo(d, "github:sam", "sam/secret", { isPrivate: false });
    expect(out).toMatchObject({ ok: false, code: "repo_create_failed" });
    expect(out.ok ? "" : out.error).toContain("Flare GitHub App");
  });
});
