// Content-addressed read cache for the ARTIFACTS binding (runtime-free).
//
// A git object named by its hash never changes, so a read keyed by
// (repo, hash) can be answered from any cache without asking anyone
// else: no invalidation, no coordination. Anthropic's "Redesigning
// source control" post (Oct 2026) makes the same point at monorepo scale; here it keeps Forge's
// server-side reads (push footprints, why chains, the read tools, the
// policy file at a trunk sha) from turning into one Artifacts call each.
//
// Cached (each keyed per repo, so an existence check on one fork never
// answers for another):
//   - readCommit(hash), readTree(hash)
//   - readFile({ ref: <full sha>, path }) when the bytes survive a text
//     round-trip byte for byte (binary and invalid UTF-8 pass through
//     uncached)
//   - log({ ref: <full sha>, limit, offset }): a first-parent chain from a
//     fixed commit is fixed too
// Never cached: anything by branch or tag name (refs move), null results
// (an object can appear after a push), info, tokens, forks.
//
// Tiers: an isolate-memory LRU in front of an optional R2 store. Callers
// meter misses (they reach the binding) and hits separately; see
// forge-ops.ts kind `cached`.

const OID_RE = /^[0-9a-f]{40}$/;
const MAX_VALUE_CHARS = 512 * 1024;
const MAX_LOG_LIMIT = 200;

export interface ReadCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

// Bounded LRU (Map insertion order). Sizes count UTF-16 code units, close
// enough to bytes for a budget.
export function memoryReadCache(opts: { maxChars?: number; maxEntries?: number } = {}): ReadCache & { readonly size: number } {
  const maxChars = opts.maxChars ?? 8 * 1024 * 1024;
  const maxEntries = opts.maxEntries ?? 20_000;
  const map = new Map<string, string>();
  let chars = 0;
  return {
    get size() {
      return map.size;
    },
    async get(key) {
      const v = map.get(key);
      if (v === undefined) return null;
      map.delete(key);
      map.set(key, v);
      return v;
    },
    async put(key, value) {
      if (value.length > maxChars) return;
      const prev = map.get(key);
      if (prev !== undefined) {
        chars -= prev.length;
        map.delete(key);
      }
      map.set(key, value);
      chars += value.length;
      for (const [k, v] of map) {
        if (chars <= maxChars && map.size <= maxEntries) break;
        map.delete(k);
        chars -= v.length;
      }
    },
  };
}

export interface ReadCacheBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

export const READ_CACHE_PREFIX = "forge/read-cache/";

// R2 tier: survives isolates and colos. Failures degrade to a miss.
export function bucketReadCache(bucket: ReadCacheBucket, prefix: string = READ_CACHE_PREFIX): ReadCache {
  return {
    async get(key) {
      try {
        const obj = await bucket.get(prefix + key);
        return obj ? await obj.text() : null;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      try {
        await bucket.put(prefix + key, value);
      } catch {
        // A failed fill is a future miss, never an error.
      }
    },
  };
}

// Memory first; an R2 hit refills memory.
export function tieredReadCache(near: ReadCache, far: ReadCache | null): ReadCache {
  if (!far) return near;
  return {
    async get(key) {
      const hit = await near.get(key);
      if (hit !== null) return hit;
      const v = await far.get(key);
      if (v !== null) await near.put(key, v);
      return v;
    },
    async put(key, value) {
      await Promise.all([near.put(key, value), far.put(key, value)]);
    },
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function isOid(v: unknown): v is string {
  return typeof v === "string" && OID_RE.test(v);
}

export function commitKey(repo: string, hash: string): string {
  return `${repo}/c/${hash}`;
}

export function treeKey(repo: string, hash: string): string {
  return `${repo}/t/${hash}`;
}

export function fileKey(repo: string, sha: string, path: string): string {
  return `${repo}/f/${sha}/${encodeURIComponent(path)}`;
}

export function logKey(repo: string, sha: string, limit: number, offset: number): string {
  return `${repo}/l/${sha}/${limit}/${offset}`;
}

// ---------------------------------------------------------------------------
// Binding wrapper
// ---------------------------------------------------------------------------

export interface CacheArtifactsOptions {
  cache: ReadCache;
  // One call per read answered from the cache (no binding call made).
  onHit?: (repoName: string) => void;
  // Fills run here when set (response first), else inline.
  defer?: ((p: Promise<unknown>) => void) | null;
}

interface CachedFile {
  type: string;
  text: string;
}

function isHandle(v: unknown): v is object {
  return (typeof v === "object" || typeof v === "function") && v !== null;
}

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function fileBlob(f: CachedFile): Blob {
  return new Blob([f.text], { type: f.type });
}

// Reads the blob once. `text` is set only when it re-encodes to exactly
// the stored bytes (not binary, valid UTF-8; a BOM is kept); `blob` is a fresh
// copy for the caller, since the original's body is now consumed.
async function cacheableText(blob: Blob): Promise<{ text: string | null; blob: Blob }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const copy = new Blob([bytes], { type: blob.type });
  if (bytes.length > MAX_VALUE_CHARS || bytes.includes(0)) return { text: null, blob: copy };
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  const same = new TextEncoder().encode(text);
  if (same.length !== bytes.length || same.some((b, i) => b !== bytes[i])) return { text: null, blob: copy };
  return { text, blob: copy };
}

function cacheHandle<H extends object>(handle: H, repo: string, opts: CacheArtifactsOptions): H {
  const { cache } = opts;
  const hit = (): void => {
    try {
      opts.onHit?.(repo);
    } catch {
      // Metering never fails a read.
    }
  };
  const fill = (key: string, value: string): Promise<void> => {
    const p = cache.put(key, value).catch(() => undefined);
    if (opts.defer) {
      try {
        opts.defer(p);
        return Promise.resolve();
      } catch {
        // Outside a request context: fill inline.
      }
    }
    return p;
  };
  const call = (target: H, prop: string, args: unknown[]): Promise<unknown> => {
    const fn = Reflect.get(target, prop) as (...a: unknown[]) => unknown;
    return Promise.resolve(Reflect.apply(fn, target, args));
  };
  // readCommit / readTree: one object by hash.
  const byHash =
    (target: H, prop: "readCommit" | "readTree", keyOf: (r: string, h: string) => string) =>
    async (...args: unknown[]): Promise<unknown> => {
      const hash = args[0];
      if (!isOid(hash)) return call(target, prop, args);
      const key = keyOf(repo, hash);
      const raw = await cache.get(key).catch(() => null);
      if (raw !== null) {
        const v = parse<unknown>(raw);
        if (v !== null) {
          hit();
          return v;
        }
      }
      const out = await call(target, prop, args);
      if (out !== null && out !== undefined) await fill(key, JSON.stringify(out));
      return out;
    };
  return new Proxy(handle, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (prop === "readCommit") return byHash(target, "readCommit", commitKey);
      if (prop === "readTree") return byHash(target, "readTree", treeKey);
      if (prop === "readFile") {
        return async (...args: unknown[]): Promise<unknown> => {
          const a = args[0];
          const ref = isHandle(a) ? Reflect.get(a, "ref") : undefined;
          const path = isHandle(a) ? Reflect.get(a, "path") : undefined;
          if (!isOid(ref) || typeof path !== "string" || !path) return call(target, prop, args);
          const key = fileKey(repo, ref, path);
          const raw = await cache.get(key).catch(() => null);
          if (raw !== null) {
            const v = parse<CachedFile>(raw);
            if (v && typeof v.text === "string" && typeof v.type === "string") {
              hit();
              return fileBlob(v);
            }
          }
          const out = await call(target, prop, args);
          if (!(out instanceof Blob)) return out;
          const read = await cacheableText(out);
          if (read.text !== null) await fill(key, JSON.stringify({ type: out.type, text: read.text } satisfies CachedFile));
          return read.blob;
        };
      }
      if (prop === "log") {
        return async (...args: unknown[]): Promise<unknown> => {
          const o = args[0];
          const ref = isHandle(o) ? Reflect.get(o, "ref") : undefined;
          const limitRaw = isHandle(o) ? Reflect.get(o, "limit") : undefined;
          const offsetRaw = isHandle(o) ? Reflect.get(o, "offset") : undefined;
          const limit = limitRaw === undefined ? 50 : limitRaw;
          const offset = offsetRaw === undefined ? 0 : offsetRaw;
          if (!isOid(ref) || typeof limit !== "number" || typeof offset !== "number" || limit > MAX_LOG_LIMIT) {
            return call(target, prop, args);
          }
          const key = logKey(repo, ref, limit, offset);
          const raw = await cache.get(key).catch(() => null);
          if (raw !== null) {
            const v = parse<unknown>(raw);
            if (Array.isArray(v)) {
              hit();
              return v;
            }
          }
          const out = await call(target, prop, args);
          if (Array.isArray(out) && out.length > 0) await fill(key, JSON.stringify(out));
          return out;
        };
      }
      // Everything else (info, tokens, fork, dispose) passes through with
      // the real handle as receiver (RPC stubs: never touch apply/bind).
      const fn = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]): unknown => Reflect.apply(fn, target, args);
    },
  });
}

// Wraps a binding (or an already metered one) so every handle from
// `get(name)` reads through the cache. Wrap OUTSIDE the meter: a hit then
// never reaches it, so the binding meter keeps counting real calls only.
export function cacheArtifacts<B extends object>(binding: B, opts: CacheArtifactsOptions): B {
  return new Proxy(binding, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === "get") {
        return async (...args: unknown[]): Promise<unknown> => {
          const handle: unknown = await Reflect.apply(fn, target, args);
          const name = typeof args[0] === "string" ? args[0] : "";
          return isHandle(handle) && name ? cacheHandle(handle, name, opts) : handle;
        };
      }
      return (...args: unknown[]): unknown => Reflect.apply(fn, target, args);
    },
  });
}

// The isolate's shared memory tier. Isolate cache, not request state: it
// only ever holds immutable objects keyed by repo + hash, and every read
// is authorized before it reaches the binding.
export const ISOLATE_READ_CACHE = memoryReadCache();
