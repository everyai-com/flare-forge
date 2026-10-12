import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutRepo, gitEnv, isArtifactsRemote } from "./checkout";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fixtureRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "flare-src-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "hello.txt"), "hi");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: dir });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, sha };
}

describe("checkoutRepo", () => {
  it("checks out a repo at a sha", async () => {
    const src = fixtureRepo();
    const dst = mkdtempSync(join(tmpdir(), "flare-dst-"));
    dirs.push(dst);
    await checkoutRepo({ repo: "local/fixture", sha: src.sha, dir: dst }, src.dir);
    expect(readFileSync(join(dst, "hello.txt"), "utf8")).toBe("hi");
  });

  it("creates a missing destination dir", async () => {
    const src = fixtureRepo();
    const base = mkdtempSync(join(tmpdir(), "flare-nest-"));
    dirs.push(base);
    const dst = join(base, "nested", "src");
    await checkoutRepo({ repo: "local/fixture", sha: src.sha, dir: dst }, src.dir);
    expect(readFileSync(join(dst, "hello.txt"), "utf8")).toBe("hi");
  });

  it("keeps the token out of argv and the remote URL", async () => {
    const src = fixtureRepo();
    const dst = mkdtempSync(join(tmpdir(), "flare-dst-"));
    dirs.push(dst);
    await checkoutRepo({ repo: "local/fixture", sha: src.sha, dir: dst, token: "sekrit-token" }, src.dir);
    expect(readFileSync(join(dst, "hello.txt"), "utf8")).toBe("hi");
    // The token rides env config; it must never be materialized in the
    // repo's git config (or the remote URL).
    expect(readFileSync(join(dst, ".git/config"), "utf8")).not.toContain("sekrit-token");
  });

  it("rejects bad repo/sha without touching the network", async () => {
    await expect(checkoutRepo({ repo: "nope", sha: "abc", dir: "/tmp/x" })).rejects.toThrow("invalid repo");
    await expect(checkoutRepo({ repo: "a/b", sha: "not a sha!", dir: "/tmp/x" })).rejects.toThrow("invalid sha");
  });
});

describe("artifacts checkout helpers", () => {
  it("scopes the auth header to the remote's origin with the given username", () => {
    const env = gitEnv("tok", "https://abc.artifacts.cloudflare.net/git/ns/repo.git", "x");
    expect(env["GIT_CONFIG_KEY_0"]).toBe("http.https://abc.artifacts.cloudflare.net/.extraheader");
    expect(env["GIT_CONFIG_VALUE_0"]).toBe(`Authorization: Basic ${Buffer.from("x:tok").toString("base64")}`);
    const gh = gitEnv("tok");
    expect(gh["GIT_CONFIG_KEY_0"]).toBe("http.https://github.com/.extraheader");
    expect(gitEnv(undefined)["GIT_CONFIG_COUNT"]).toBeUndefined();
  });

  it("accepts only Artifacts git remotes from a claim", () => {
    const acc = "a".repeat(32);
    expect(isArtifactsRemote(`https://${acc}.artifacts.cloudflare.net/git/ns/repo.git`)).toBe(true);
    expect(isArtifactsRemote(`http://${acc}.artifacts.cloudflare.net/git/ns/repo.git`)).toBe(false);
    expect(isArtifactsRemote(`https://${acc}.artifacts.cloudflare.net.evil.com/git/x.git`)).toBe(false);
    expect(isArtifactsRemote(`https://user:pw@${acc}.artifacts.cloudflare.net/git/x.git`)).toBe(false);
    expect(isArtifactsRemote("https://github.com/a/b.git")).toBe(false);
    expect(isArtifactsRemote("not a url")).toBe(false);
  });
});
