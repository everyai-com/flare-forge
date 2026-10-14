// commit_files: land an agent's edits on its own fork without git on the
// agent's side. The Worker shallow-fetches the fork tip (depth 1), writes
// the new blobs, rebuilds only the trees on changed paths, commits with
// the intent's trailers and pushes fork main (fast-forward only). The
// caller then runs report_push on the new sha, so footprint, drift and
// risk are computed exactly as for a git push.
//
// Dependencies are injected (isomorphic-git, its HTTP client, a MemoryFS
// factory) so tests drive a real git server; nothing here imports the
// Workers runtime.

import type { FsClient, HttpClient } from "isomorphic-git";

export interface FileChange {
  path: string;
  // UTF-8 text, or base64 when encoding is "base64". Absent with delete.
  content?: string;
  encoding?: "utf8" | "base64";
  delete?: boolean;
}

export interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

export interface CommitGit {
  init(args: { fs: FsClient; gitdir: string; bare: boolean; defaultBranch: string }): Promise<void>;
  addRemote(args: { fs: FsClient; gitdir: string; remote: string; url: string }): Promise<void>;
  fetch(args: { fs: FsClient; http: HttpClient; gitdir: string; remote: string; ref: string; singleBranch: boolean; depth: number; tags: boolean; onAuth: () => { username: string; password: string } }): Promise<{ fetchHead: string | null }>;
  readTree(args: { fs: FsClient; gitdir: string; oid: string }): Promise<{ oid: string; tree: TreeEntry[] }>;
  readCommit(args: { fs: FsClient; gitdir: string; oid: string }): Promise<{ commit: { tree: string } }>;
  writeBlob(args: { fs: FsClient; gitdir: string; blob: Uint8Array }): Promise<string>;
  writeTree(args: { fs: FsClient; gitdir: string; tree: TreeEntry[] }): Promise<string>;
  commit(args: { fs: FsClient; gitdir: string; message: string; author: { name: string; email: string; timestamp?: number }; tree: string; parent: string[]; ref: string }): Promise<string>;
  push(args: { fs: FsClient; http: HttpClient; gitdir: string; url: string; ref: string; remoteRef: string; force?: boolean; onAuth: () => { username: string; password: string } }): Promise<{ ok: boolean; error?: string | null }>;
}

export const COMMIT_LIMITS = { files: 50, fileBytes: 1_000_000, totalBytes: 5_000_000, message: 4000 };

/** Repo-relative POSIX path: no leading slash, no `.`/`..` segments, never under .git. */
export function validateCommitPath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const path = v.trim();
  if (!path || path.length > 400 || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0")) return null;
  const parts = path.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  if (parts[0] === ".git") return null;
  return path;
}

/** Normalise and bound the change list (null + reason when invalid). */
export function parseChanges(v: unknown): { changes: Array<{ path: string; bytes: Uint8Array | null }> } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: "files must be a non-empty array of {path, content} or {path, delete: true}" };
  if (v.length > COMMIT_LIMITS.files) return { error: `at most ${COMMIT_LIMITS.files} files per commit` };
  const seen = new Set<string>();
  const out: Array<{ path: string; bytes: Uint8Array | null }> = [];
  let total = 0;
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) return { error: "each file must be an object" };
    const f = raw as Record<string, unknown>;
    const path = validateCommitPath(f.path);
    if (!path) return { error: `invalid path: ${String(f.path).slice(0, 80)}` };
    if (seen.has(path)) return { error: `duplicate path: ${path}` };
    seen.add(path);
    if (f.delete === true) {
      out.push({ path, bytes: null });
      continue;
    }
    if (typeof f.content !== "string") return { error: `${path}: content must be a string (or set delete: true)` };
    let bytes: Uint8Array;
    if (f.encoding === "base64") {
      try {
        const bin = atob(f.content);
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } catch {
        return { error: `${path}: content is not valid base64` };
      }
    } else if (f.encoding === undefined || f.encoding === "utf8") {
      bytes = new TextEncoder().encode(f.content);
    } else {
      return { error: `${path}: encoding must be utf8 or base64` };
    }
    if (bytes.length > COMMIT_LIMITS.fileBytes) return { error: `${path}: larger than ${COMMIT_LIMITS.fileBytes} bytes` };
    total += bytes.length;
    if (total > COMMIT_LIMITS.totalBytes) return { error: `files total more than ${COMMIT_LIMITS.totalBytes} bytes` };
    out.push({ path, bytes });
  }
  return { changes: out };
}

interface Node {
  files: Map<string, Uint8Array | null>;
  dirs: Map<string, Node>;
}

function changeTree(changes: Array<{ path: string; bytes: Uint8Array | null }>): Node {
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const c of changes) {
    const parts = c.path.split("/");
    let node = root;
    for (const seg of parts.slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], c.bytes);
  }
  return root;
}

// Rebuild one tree: untouched entries keep their oids; changed files get
// new blobs; changed subdirectories recurse. Returns null when the tree
// ends up empty (git has no empty trees, so the parent drops it).
async function rebuild(git: CommitGit, fs: FsClient, gitdir: string, oid: string | null, node: Node): Promise<string | null> {
  const entries = new Map<string, TreeEntry>();
  if (oid) for (const e of (await git.readTree({ fs, gitdir, oid })).tree) entries.set(e.path, e);
  for (const [name, bytes] of node.files) {
    const prev = entries.get(name);
    if (bytes === null) {
      if (prev && prev.type === "blob") entries.delete(name);
      continue;
    }
    if (prev && prev.type === "tree") throw new Error(`${name} is a directory on the fork; delete it first`);
    const blob = await git.writeBlob({ fs, gitdir, blob: bytes });
    entries.set(name, { mode: prev?.mode === "100755" ? "100755" : "100644", path: name, oid: blob, type: "blob" });
  }
  for (const [name, child] of node.dirs) {
    const prev = entries.get(name);
    if (prev && prev.type !== "tree") throw new Error(`${name} is a file on the fork, not a directory`);
    const sub = await rebuild(git, fs, gitdir, prev?.oid ?? null, child);
    if (sub) entries.set(name, { mode: "040000", path: name, oid: sub, type: "tree" });
    else entries.delete(name);
  }
  if (entries.size === 0) return null;
  return git.writeTree({ fs, gitdir, tree: [...entries.values()] });
}

export async function commitFilesToFork(
  deps: { git: CommitGit; http: HttpClient; fs: FsClient },
  args: { url: string; token: string; changes: Array<{ path: string; bytes: Uint8Array | null }>; message: string; author: { name: string; email: string } },
): Promise<{ sha: string; parent: string; changed: number }> {
  const { git, http, fs } = deps;
  const gitdir = "/fork.git";
  const onAuth = () => ({ username: "x", password: args.token });
  await git.init({ fs, gitdir, bare: true, defaultBranch: "main" });
  await git.addRemote({ fs, gitdir, remote: "fork", url: args.url });
  const fetched = await git.fetch({ fs, http, gitdir, remote: "fork", ref: "main", singleBranch: true, depth: 1, tags: false, onAuth });
  const parent = fetched.fetchHead;
  if (!parent) throw new Error("the fork has no main branch");
  const baseTree = (await git.readCommit({ fs, gitdir, oid: parent })).commit.tree;
  const tree = await rebuild(git, fs, gitdir, baseTree, changeTree(args.changes));
  if (!tree) throw new Error("the commit would leave the repo empty");
  if (tree === baseTree) throw new Error("nothing changed: every file already has that content");
  const sha = await git.commit({ fs, gitdir, message: args.message, author: args.author, tree, parent: [parent], ref: "refs/heads/commit" });
  const pushed = await git.push({ fs, http, gitdir, url: args.url, ref: "refs/heads/commit", remoteRef: "refs/heads/main", force: false, onAuth });
  if (!pushed.ok) throw new Error(`push to the fork was rejected${pushed.error ? `: ${pushed.error}` : ""} (the fork moved; retry)`);
  return { sha, parent, changed: args.changes.length };
}
