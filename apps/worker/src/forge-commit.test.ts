import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import { commitFilesToFork, parseChanges, validateCommitPath } from "./forge-commit";
import { MemoryFS } from "./memory-fs";
import { bareRemote, gitCli, harnessHttp } from "./provenance-harness.test-util";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real bare repo served by `git http-backend`, seeded with the git CLI.
function seededFork() {
  const remote = bareRemote();
  const work = mkdtempSync(join(tmpdir(), "flare-commit-"));
  gitCli(work, ["init", "-q", "-b", "main"]);
  gitCli(work, ["config", "user.email", "t@example.com"]);
  gitCli(work, ["config", "user.name", "t"]);
  mkdirSync(join(work, "src", "lib"), { recursive: true });
  writeFileSync(join(work, "README.md"), "hello\n");
  writeFileSync(join(work, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(work, "src", "lib", "old.ts"), "old\n");
  gitCli(work, ["add", "-A"]);
  gitCli(work, ["commit", "-q", "-m", "seed"]);
  gitCli(work, ["push", "-q", remote.bare, "main"]);
  return remote;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("commit paths and changes", () => {
  it("accepts repo-relative paths and rejects escapes", () => {
    expect(validateCommitPath("src/a.ts")).toBe("src/a.ts");
    for (const bad of ["", "/abs", "a/../b", "./a", ".git/config", "a//b", "a/", "a\\b", 5]) expect(validateCommitPath(bad)).toBeNull();
  });
  it("bounds and decodes the change list", () => {
    expect(parseChanges([])).toHaveProperty("error");
    expect(parseChanges([{ path: "a", content: "x" }, { path: "a", content: "y" }])).toHaveProperty("error");
    expect(parseChanges([{ path: "a" }])).toHaveProperty("error");
    expect(parseChanges([{ path: "b.bin", content: "aGk=", encoding: "base64" }])).toEqual({ changes: [{ path: "b.bin", bytes: enc("hi") }] });
    expect(parseChanges([{ path: "gone", delete: true }])).toEqual({ changes: [{ path: "gone", bytes: null }] });
    expect(parseChanges(Array.from({ length: 51 }, (_, i) => ({ path: `f${i}`, content: "" })))).toHaveProperty("error");
  });
});

describe("commitFilesToFork (real git server)", () => {
  it("edits, adds and deletes files in one commit on top of fork main", async () => {
    const remote = seededFork();
    const before = gitCli(remote.bare, ["rev-parse", "main"]).trim();
    const out = await commitFilesToFork(
      { git, http: harnessHttp(remote), fs: new MemoryFS() },
      {
        url: remote.url,
        token: "t",
        message: "Edit without git\n\nFlare-Intent: i1",
        author: { name: "agent-1", email: "agent-1@agents.flare.invalid" },
        changes: [
          { path: "src/app.ts", bytes: enc("export const a = 2;\n") },
          { path: "src/new/deep.ts", bytes: enc("new\n") },
          { path: "src/lib/old.ts", bytes: null },
        ],
      },
    );
    expect(out.parent).toBe(before);
    expect(gitCli(remote.bare, ["rev-parse", "main"]).trim()).toBe(out.sha);
    expect(gitCli(remote.bare, ["show", "main:src/app.ts"])).toBe("export const a = 2;\n");
    expect(gitCli(remote.bare, ["show", "main:src/new/deep.ts"])).toBe("new\n");
    expect(gitCli(remote.bare, ["show", "main:README.md"])).toBe("hello\n");
    // src/lib held only old.ts, so the now-empty directory is gone.
    expect(gitCli(remote.bare, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n").sort()).toEqual(["README.md", "src/app.ts", "src/new/deep.ts"]);
    expect(gitCli(remote.bare, ["log", "-1", "--format=%an%n%B", "main"])).toContain("Flare-Intent: i1");
    expect(gitCli(remote.bare, ["rev-parse", "main^"]).trim()).toBe(before);
  });

  it("refuses a no-op commit and a file-over-directory write", async () => {
    const remote = seededFork();
    const deps = { git, http: harnessHttp(remote), fs: new MemoryFS() };
    const base = { url: remote.url, token: "t", message: "m", author: { name: "a", email: "a@x.invalid" } };
    await expect(commitFilesToFork(deps, { ...base, changes: [{ path: "README.md", bytes: enc("hello\n") }] })).rejects.toThrow(/nothing changed/);
    await expect(commitFilesToFork({ ...deps, fs: new MemoryFS() }, { ...base, changes: [{ path: "src", bytes: enc("x") }] })).rejects.toThrow(/directory/);
  });
});
