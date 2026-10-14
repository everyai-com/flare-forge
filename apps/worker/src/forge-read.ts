// Server-side repo reads for agents (runtime-free core).
//
// An agent that only needs to look (read a file, see what an intent
// changed, find which commits touched a path) should not have to clone.
// These answers come from the server over the ARTIFACTS binding, pinned
// to a commit sha so every object read below is content-addressed and
// served by the read cache (read-cache.ts) after the first time. Results
// return the sha they read, so an agent can pin follow-up reads to it.
//
// forge-service.ts wraps these as the read_file / diff / history verbs
// (REST + MCP); everything here takes a structural repo handle so tests
// drive it with fakes.

import { changedFiles } from "./forge-push";

export const READ_LIMITS = {
  // read_file
  fileChars: 256 * 1024,
  dirEntries: 500,
  pathDepth: 16,
  // diff
  diffFiles: 25,
  diffFileChars: 128 * 1024,
  diffPatchChars: 96 * 1024,
  diffCells: 4_000_000,
  diffContext: 3,
  // history
  historyScan: 100,
  historyReturn: 30,
  historyTreeReads: 600,
} as const;

const OID_RE = /^[0-9a-f]{40}$/;

export interface ReadTreeEntry {
  name: string;
  mode: string;
  hash: string;
  type?: string;
}

export interface ReadBlob {
  readonly size: number;
  text(): Promise<string>;
}

export interface ReadHandle {
  log(opts?: { ref?: string; limit?: number }): Promise<Array<{ hash: string }>>;
  readCommit(hash: string): Promise<{ treeHash: string } | null>;
  readTree(hash: string): Promise<ReadTreeEntry[] | null>;
  readFile(args: { ref: string; path: string }): Promise<ReadBlob | null>;
}

export function isTreeEntry(e: ReadTreeEntry): boolean {
  return e.type === "tree" || e.mode === "40000" || e.mode === "040000";
}

// A branch, tag or sha to a full sha (one log read for names; none for a
// sha). Null when the ref does not resolve.
export async function resolveSha(handle: ReadHandle, ref: string): Promise<string | null> {
  if (OID_RE.test(ref)) return ref;
  const [tip] = await handle.log({ ref, limit: 1 });
  return tip && OID_RE.test(tip.hash) ? tip.hash : null;
}

// The tree entry at `path` in a commit ("" = the root tree), walking one
// readTree per segment. `reads` counts tree reads for budgets.
export async function entryAt(
  handle: ReadHandle,
  sha: string,
  path: string,
  budget: { reads: number; max: number } = { reads: 0, max: Number.POSITIVE_INFINITY },
): Promise<{ kind: "tree" | "blob"; hash: string; mode: string } | null | "budget"> {
  const commit = await handle.readCommit(sha);
  if (!commit) return null;
  let cur: { kind: "tree" | "blob"; hash: string; mode: string } = { kind: "tree", hash: commit.treeHash, mode: "40000" };
  if (!path) return cur;
  for (const segment of path.split("/")) {
    if (cur.kind !== "tree") return null;
    if (budget.reads >= budget.max) return "budget";
    budget.reads++;
    const entries = await handle.readTree(cur.hash);
    const next = entries?.find((e) => e.name === segment);
    if (!next) return null;
    cur = { kind: isTreeEntry(next) ? "tree" : "blob", hash: next.hash, mode: next.mode };
  }
  return cur;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export type ReadResult =
  | {
      kind: "file";
      path: string;
      sha: string;
      blob: string;
      size: number;
      lines: number;
      range: { start: number; end: number } | null;
      binary: boolean;
      truncated: boolean;
      text: string | null;
    }
  | {
      kind: "dir";
      path: string;
      sha: string;
      tree: string;
      entries: Array<{ name: string; type: "dir" | "file"; hash: string }>;
      truncated: boolean;
    };

export async function readPath(
  handle: ReadHandle,
  sha: string,
  path: string,
  range: { start: number; end: number | null } | null = null,
): Promise<ReadResult | null> {
  const at = await entryAt(handle, sha, path);
  if (!at || at === "budget") return null;
  if (at.kind === "tree") {
    const entries = (await handle.readTree(at.hash)) ?? [];
    const mapped = entries
      .map((e) => ({ name: e.name, type: isTreeEntry(e) ? ("dir" as const) : ("file" as const), hash: e.hash }))
      .sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === "dir" ? -1 : 1));
    return { kind: "dir", path, sha, tree: at.hash, entries: mapped.slice(0, READ_LIMITS.dirEntries), truncated: mapped.length > READ_LIMITS.dirEntries };
  }
  const file = await handle.readFile({ ref: sha, path });
  if (!file) return null;
  const base = { kind: "file" as const, path, sha, blob: at.hash, size: file.size };
  if (file.size > READ_LIMITS.fileChars * 4) return { ...base, lines: 0, range: null, binary: false, truncated: true, text: null };
  const raw = await file.text();
  if (raw.includes("\0")) return { ...base, lines: 0, range: null, binary: true, truncated: false, text: null };
  const all = raw.split("\n");
  const lines = raw.endsWith("\n") ? all.length - 1 : all.length;
  let text = raw;
  let picked: { start: number; end: number } | null = null;
  if (range) {
    const start = Math.min(Math.max(1, range.start), Math.max(1, lines));
    const end = Math.min(lines, Math.max(start, range.end ?? lines));
    picked = { start, end };
    text = all.slice(start - 1, end).join("\n");
  }
  const truncated = text.length > READ_LIMITS.fileChars;
  return { ...base, lines, range: picked, binary: false, truncated, text: truncated ? text.slice(0, READ_LIMITS.fileChars) : text };
}

// ---------------------------------------------------------------------------
// Unified diff (bounded LCS; prefix/suffix trimmed first)
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

type Op = { t: " " | "-" | "+"; line: string; a: number; b: number };

function diffOps(a: string[], b: string[]): Op[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if ((n + 1) * (m + 1) > READ_LIMITS.diffCells) return null;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: " ", line: a[i], a: i, b: i });
  if (n > 0 && m > 0) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[pre + i] === b[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[pre + i] === b[pre + j]) {
        ops.push({ t: " ", line: a[pre + i], a: pre + i, b: pre + j });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        // Deletions before additions on ties, like git.
        ops.push({ t: "-", line: a[pre + i], a: pre + i, b: pre + j });
        i++;
      } else {
        ops.push({ t: "+", line: b[pre + j], a: pre + i, b: pre + j });
        j++;
      }
    }
  } else {
    for (let i = 0; i < n; i++) ops.push({ t: "-", line: a[pre + i], a: pre + i, b: pre });
    for (let j = 0; j < m; j++) ops.push({ t: "+", line: b[pre + j], a: pre + n, b: pre + j });
  }
  for (let k = 0; k < suf; k++) ops.push({ t: " ", line: a[a.length - suf + k], a: a.length - suf + k, b: b.length - suf + k });
  return ops;
}

// `git diff`-style hunks without the file header. Null when the change
// is too large to diff within the cell budget.
export function unifiedDiff(before: string, after: string, context: number = READ_LIMITS.diffContext): string | null {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffOps(a, b);
  if (!ops) return null;
  const changed = ops.map((o, i) => (o.t === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const from = Math.max(0, changed[k] - context);
    let to = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= to + 1) {
      k++;
      to = Math.min(ops.length - 1, changed[k] + context);
    }
    const slice = ops.slice(from, to + 1);
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    const aStart = aLen ? slice.find((o) => o.t !== "+")!.a + 1 : slice[0].a;
    const bStart = bLen ? slice.find((o) => o.t !== "-")!.b + 1 : slice[0].b;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    k++;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// diff (an intent's fork head against its base)
// ---------------------------------------------------------------------------

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  patch: string | null;
  // Why `patch` is null: binary, too large, budget (patch budget spent),
  // or listed (past the per-call file cap).
  omitted?: "binary" | "too_large" | "budget" | "listed";
}

async function textAt(handle: ReadHandle, sha: string, path: string): Promise<string | null | "binary" | "too_large"> {
  const f = await handle.readFile({ ref: sha, path });
  if (!f) return null;
  if (f.size > READ_LIMITS.diffFileChars) return "too_large";
  const t = await f.text();
  return t.includes("\0") ? "binary" : t;
}

export async function diffCommits(
  handle: ReadHandle,
  base: string,
  head: string,
  only: string | null = null,
): Promise<{ files: DiffFile[]; truncated: boolean } | null> {
  const listed = await changedFiles(handle, base, head);
  if (!listed) return null;
  const paths = only ? listed.files.filter((p) => p === only || p.startsWith(`${only}/`)) : listed.files;
  const files: DiffFile[] = [];
  let budget: number = READ_LIMITS.diffPatchChars;
  for (const [i, path] of paths.entries()) {
    if (i >= READ_LIMITS.diffFiles) {
      files.push({ path, status: "modified", patch: null, omitted: "listed" });
      continue;
    }
    const [before, after] = await Promise.all([textAt(handle, base, path), textAt(handle, head, path)]);
    const status: DiffFile["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
    if (before === "binary" || after === "binary") {
      files.push({ path, status, patch: null, omitted: "binary" });
      continue;
    }
    if (before === "too_large" || after === "too_large") {
      files.push({ path, status, patch: null, omitted: "too_large" });
      continue;
    }
    const patch = unifiedDiff(before ?? "", after ?? "");
    if (patch === null) files.push({ path, status, patch: null, omitted: "too_large" });
    else if (patch.length > budget) files.push({ path, status, patch: null, omitted: "budget" });
    else {
      budget -= patch.length;
      files.push({ path, status, patch });
    }
  }
  return { files, truncated: listed.truncated };
}

// ---------------------------------------------------------------------------
// history (commits on a first-parent chain that changed a path)
// ---------------------------------------------------------------------------

export interface HistoryCommit {
  hash: string;
  message: string;
  author: string;
  at: number | null;
  change: "added" | "modified" | "deleted";
}

interface LogCommit {
  hash: string;
  message?: unknown;
  author?: unknown;
  committedAt?: unknown;
}

function commitMeta(c: LogCommit): { message: string; author: string; at: number | null } {
  const message = typeof c.message === "string" ? c.message.split("\n")[0].slice(0, 200) : "";
  const a = c.author;
  const author = typeof a === "object" && a !== null && typeof (a as { name?: unknown }).name === "string" ? (a as { name: string }).name.slice(0, 100) : "";
  const at = typeof c.committedAt === "number" ? c.committedAt : null;
  return { message, author, at };
}

// Walks the first-parent chain from `sha` (newest first) and reports the
// commits where the path's object hash changed. Unchanged subtrees share
// hashes, so after the first walk nearly every tree read is a cache hit.
// Truncated when the scan or tree-read budget runs out first.
export async function pathHistory(
  handle: ReadHandle,
  sha: string,
  path: string,
  limit: number = READ_LIMITS.historyReturn,
): Promise<{ commits: HistoryCommit[]; scanned: number; truncated: boolean }> {
  const chain = (await handle.log({ ref: sha, limit: READ_LIMITS.historyScan + 1 })) as LogCommit[];
  const budget = { reads: 0, max: READ_LIMITS.historyTreeReads };
  const hashes: Array<string | null> = [];
  let truncated = false;
  for (const c of chain) {
    const at = await entryAt(handle, c.hash, path, budget);
    if (at === "budget") {
      truncated = true;
      break;
    }
    hashes.push(at ? at.hash : null);
  }
  // hashes[i] is the path at chain[i]; its first parent is chain[i + 1].
  // A chain shorter than the scan ends at the root commit (parent: none).
  const reachedRoot = chain.length <= READ_LIMITS.historyScan && hashes.length === chain.length;
  const commits: HistoryCommit[] = [];
  let scanned = 0;
  for (let i = 0; i < hashes.length && i < READ_LIMITS.historyScan; i++) {
    if (commits.length >= limit) {
      truncated = true;
      break;
    }
    let parent: string | null;
    if (i + 1 < hashes.length) parent = hashes[i + 1];
    else if (reachedRoot) parent = null;
    else {
      truncated = true;
      break;
    }
    scanned++;
    const cur = hashes[i];
    if (cur === parent) continue;
    const change: HistoryCommit["change"] = parent === null ? "added" : cur === null ? "deleted" : "modified";
    commits.push({ hash: chain[i].hash, ...commitMeta(chain[i]), change });
  }
  return { commits, scanned, truncated };
}
