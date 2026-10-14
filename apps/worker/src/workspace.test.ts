import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git";
import { createToken } from "./db";
import { forgeSqliteDb } from "./forge.testkit";
import { MemoryFS } from "./memory-fs";
import { authIdentityFromToken, hashToken, MEMBER_TOKEN_SCOPE, memberRepos, NO_REPOS } from "./tokens";
import { createMemberRepo, listOwnedRepos, MEMBER_REPO_LIMIT, starterFiles, validateWorkspaceName, type WorkspaceGit } from "./workspace";

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
