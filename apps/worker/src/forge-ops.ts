// Flare Forge ops ledger (runtime-free): what a repo costs in Cloudflare
// Artifacts operations, per landed change, in dollars at list price.
//
// Artifacts bills operations from 2026-10-14 ($0.15 per 1,000 past
// 10,000 a month; the pricing page names create, push, pull and clone
// as examples). Forge answers coordination questions from Durable
// Object SQLite with zero git operations, so its git traffic should be
// O(intent), not O(time). This module measures that claim:
//
//   - Event ops: Cloudflare's own Artifacts events (created, forked,
//     imported, deleted, pushed, cloned, fetched) reach ForgePushWorkflow
//     through namespace-wide triggers (wrangler.jsonc). Each event is
//     attributed by repo name (`i-<id>` intent fork, `s-` session fork,
//     `r-` replay fork, or the trunk itself) and counted once per event
//     id in the repo's Coordinator. A judge can check these against the
//     Artifacts metrics in their own dashboard.
//   - Binding calls: the reads (readFile/readCommit/readTree/log) and
//     token mints Forge makes through the ARTIFACTS binding, counted by
//     `meterArtifacts`. Kept apart: Cloudflare's pricing page does not
//     say whether binding reads bill, and repo creation through the
//     binding already shows up as an event.
//
// Dollars use the documented kinds only (create/fork/import, push,
// clone, fetch); `upperBound` adds everything else. All dollar figures
// are list price before the free monthly allowance.
import type { SqlStore } from "./coordinator-core";
import type { Db } from "./db";

// ---------------------------------------------------------------------------
// Pricing (one place; checked against the pricing page)
// ---------------------------------------------------------------------------

export const ARTIFACTS_PRICING = {
  perThousandOps: 0.15,
  freeOpsPerMonth: 10_000,
  perGbMonth: 0.5,
  billingStarts: "2026-10-14",
  checked: "2026-10-12",
  source: "https://developers.cloudflare.com/artifacts/platform/pricing/",
} as const;

// The projected baseline, LOWER BOUND ("poll only while working"): an
// agent with no coordination layer fetches every 30 s to stay fresh, but
// only during its 8-minute work session. Agents that keep polling until
// their change lands poll far more (apps/sim/src/pull.ts projects both
// windows; docs/FORGE-BENCH.md "Pull traffic"). Interval and session
// length are the sim's assumptions (apps/sim/src/constants.ts: work
// median 8 min, git.pollIntervalsSec), not measurements.
export const NAIVE_BASELINE = {
  fetchIntervalSeconds: 30,
  workMinutes: 8,
} as const;

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const EVENT_OP_KINDS = ["create", "fork", "import", "delete", "push", "clone", "fetch"] as const;
export type EventOpKind = (typeof EVENT_OP_KINDS)[number];

export const BINDING_OP_KINDS = ["read", "token"] as const;
export type BindingOpKind = (typeof BINDING_OP_KINDS)[number];

export type OpOrigin = "event" | "binding";
export type OpKind = EventOpKind | BindingOpKind;

// Kinds the pricing page's examples cover: a fork creates a repo and a
// fetch is a pull.
export const DOCUMENTED_BILLABLE: readonly EventOpKind[] = ["create", "fork", "import", "push", "clone", "fetch"];

// Who an op is attributed to inside a repo.
export const OP_SUBJECTS = ["trunk", "lane", "intent", "session", "replay"] as const;
export type OpSubject = (typeof OP_SUBJECTS)[number];

export const ARTIFACTS_EVENT_KINDS: Readonly<Record<string, EventOpKind>> = {
  "cf.artifacts.repo.created": "create",
  "cf.artifacts.repo.forked": "fork",
  "cf.artifacts.repo.imported": "import",
  "cf.artifacts.repo.deleted": "delete",
  "cf.artifacts.repo.pushed": "push",
  "cf.artifacts.repo.cloned": "clone",
  "cf.artifacts.repo.fetched": "fetch",
};

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

export interface ArtifactsOpEvent {
  kind: EventOpKind;
  namespace: string;
  // The repo the event is about (for `fork`, the SOURCE repo).
  repoName: string;
  // `fork` only: the new repo.
  targetRepo: string | null;
  // `push` only.
  ref: string | null;
}

const NAME_RE = /^[\w.-]{1,100}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nameOf(v: unknown): string | null {
  return typeof v === "string" && NAME_RE.test(v) ? v : null;
}

// Accepts the event envelope ({type, source, payload}) or the payload
// fields flattened next to `source` (the workflow payload shape varies
// by delivery path, same as parseForgePush). A missing `type` with a
// push-shaped body counts as a push (older trigger deliveries).
export function parseArtifactsOpEvent(raw: unknown): ArtifactsOpEvent | null {
  if (!isRecord(raw)) return null;
  const source = raw["source"];
  if (!isRecord(source)) return null;
  const body = isRecord(raw["payload"]) ? raw["payload"] : raw;
  const type = raw["type"];
  let kind: EventOpKind | undefined;
  if (typeof type === "string") kind = ARTIFACTS_EVENT_KINDS[type];
  else if (type === undefined && typeof body["after"] === "string") kind = "push";
  if (!kind) return null;
  const namespace = nameOf(source["namespace"]);
  const repoName = nameOf(source["repoName"]);
  if (!namespace || !repoName) return null;
  const targetRepo = kind === "fork" ? nameOf(body["repoName"]) : null;
  const ref = kind === "push" && typeof body["ref"] === "string" && body["ref"].length <= 300 ? body["ref"] : null;
  return { kind, namespace, repoName, targetRepo, ref };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

// Fork naming (intents-core intentForkName, session.ts sessionForkName,
// replay.ts replayForkName): `i-<12>`, `s-<12>-<agent>-<rand>`,
// `r-<12>-<attempt>`. Anything else is a trunk candidate.
export function classifyRepoName(name: string): { role: "intent" | "session" | "replay" | "trunk"; short: string | null } {
  let m = /^i-([a-z0-9]{1,12})$/.exec(name);
  if (m) return { role: "intent", short: m[1] };
  m = /^s-([a-z0-9]{1,12})-/.exec(name);
  if (m) return { role: "session", short: m[1] };
  m = /^r-([a-z0-9]{1,12})-\d+$/.exec(name);
  if (m) return { role: "replay", short: m[1] };
  return { role: "trunk", short: null };
}

// Trunk pushes to `refs/heads/forge/*` are train lanes.
export function subjectForTrunkRef(ref: string | null): OpSubject {
  return ref !== null && ref.startsWith("refs/heads/forge/") ? "lane" : "trunk";
}

export interface OpTarget {
  repo: string;
  subject: OpSubject;
  intentId: string | null;
}

// D1 lookups the attribution needs (injected; forgeOpsLookups builds
// them over D1).
export interface OpsLookups {
  intentByFork(forkRepo: string): Promise<{ id: string; repo: string } | null>;
  conflictRepoByShort(short: string): Promise<string | null>;
  isForgeRepo(name: string): Promise<boolean>;
}

async function targetForName(lookups: OpsLookups, name: string, ref: string | null): Promise<OpTarget | null> {
  const c = classifyRepoName(name);
  if (c.role === "intent" || c.role === "session") {
    const intent = await lookups.intentByFork(c.role === "intent" ? name : `i-${c.short}`);
    if (intent) return { repo: intent.repo, subject: c.role, intentId: intent.id };
  } else if (c.role === "replay" && c.short) {
    const repo = await lookups.conflictRepoByShort(c.short);
    if (repo) return { repo, subject: "replay", intentId: null };
  }
  // A trunk literally named like a fork still resolves as trunk.
  if (await lookups.isForgeRepo(name)) return { repo: name, subject: subjectForTrunkRef(ref), intentId: null };
  return null;
}

// Null = not a Forge repo (tournament forks, mirrors nobody declared on,
// other tenants of the namespace): logged by the caller, not counted.
export async function attributeOp(lookups: OpsLookups, ev: { repoName: string; targetRepo?: string | null; ref?: string | null }): Promise<OpTarget | null> {
  if (ev.targetRepo) {
    // A fork: charge the new repo when it is already known, else the
    // source it was forked from (the claim writes fork_repo around the
    // fork call, so either order happens).
    const direct = await targetForName(lookups, ev.targetRepo, null);
    if (direct) return direct;
    const source = await targetForName(lookups, ev.repoName, null);
    if (!source) return null;
    const role = classifyRepoName(ev.targetRepo).role;
    return { repo: source.repo, subject: role === "trunk" ? source.subject : role, intentId: role === "trunk" ? source.intentId : null };
  }
  return targetForName(lookups, ev.repoName, ev.ref ?? null);
}

// The D1 side of attribution. Each lookup is one indexed read; any
// failure answers "unknown" (the op is dropped, never misattributed).
export function forgeOpsLookups(db: Db): OpsLookups {
  return {
    async intentByFork(forkRepo) {
      try {
        return (await db.prepare("SELECT id, repo FROM intents WHERE fork_repo = ? LIMIT 1").bind(forkRepo).first<{ id: string; repo: string }>()) ?? null;
      } catch {
        return null;
      }
    },
    async conflictRepoByShort(short) {
      try {
        const prefix = conflictIdPrefix(short);
        const row = await db
          .prepare("SELECT repo FROM conflicts WHERE id >= ? AND id < ? ORDER BY id LIMIT 1")
          .bind(prefix, `${prefix}\uffff`)
          .first<{ repo: string }>();
        return row?.repo ?? null;
      } catch {
        return null;
      }
    },
    async isForgeRepo(name) {
      try {
        const row = await db
          .prepare("SELECT 1 AS ok FROM intents WHERE repo = ? UNION ALL SELECT 1 AS ok FROM goals WHERE repo = ? LIMIT 1")
          .bind(name, name)
          .first<{ ok: number }>();
        return row !== null;
      } catch {
        return false;
      }
    },
  };
}

// Replay forks carry the first 12 alphanumerics of a UUID conflict id:
// rebuild the `xxxxxxxx-xxxx` prefix for an indexed range scan.
export function conflictIdPrefix(short: string): string {
  return short.length > 8 ? `${short.slice(0, 8)}-${short.slice(8)}` : short;
}

// ---------------------------------------------------------------------------
// Ledger (Coordinator DO SQLite; fc_ prefix like the index tables)
// ---------------------------------------------------------------------------

export const OPS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fc_ops (
    subject TEXT NOT NULL,
    intent_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    n INTEGER NOT NULL,
    first_ms INTEGER NOT NULL,
    last_ms INTEGER NOT NULL,
    PRIMARY KEY (subject, intent_id, kind, origin)
  )`,
  "CREATE INDEX IF NOT EXISTS fc_ops_intent ON fc_ops (intent_id)",
  // Repo totals, kept incrementally so the hot counters path reads one
  // small table instead of summing every intent's rows.
  "CREATE TABLE IF NOT EXISTS fc_ops_total (k TEXT PRIMARY KEY, n INTEGER NOT NULL)",
  // Event ids already counted (workflow retries and redeliveries).
  "CREATE TABLE IF NOT EXISTS fc_ops_seen (event_id TEXT PRIMARY KEY, seen_ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS fc_ops_seen_ms ON fc_ops_seen (seen_ms)",
];

export const OPS_LIMITS = {
  // Entries accepted per record call.
  entriesPerCall: 50,
  // n per entry (a binding flush can batch many reads).
  maxPerEntry: 10_000,
  // Dedupe window for event ids, and rows pruned per call past it.
  seenTtlMs: 3 * 86_400_000,
  seenPrunePerCall: 200,
  // Intents listed in a ledger view.
  topIntents: 10,
} as const;

export function ensureOpsSchema(sql: SqlStore): void {
  for (const stmt of OPS_SCHEMA) sql.exec(stmt);
}

export interface OpEntry {
  kind: OpKind;
  origin: OpOrigin;
  subject: OpSubject;
  intentId?: string | null;
  n?: number;
}

const KIND_SET = new Set<string>([...EVENT_OP_KINDS, ...BINDING_OP_KINDS]);
const SUBJECT_SET = new Set<string>(OP_SUBJECTS);
const INTENT_ID_RE = /^[\w-]{1,64}$/;

// Validates RPC input (the Coordinator is called across a trust
// boundary only by our own Worker, but stays strict).
export function validOpEntries(input: unknown): OpEntry[] {
  if (!Array.isArray(input)) return [];
  const out: OpEntry[] = [];
  for (const raw of input.slice(0, OPS_LIMITS.entriesPerCall)) {
    if (!isRecord(raw)) continue;
    const kind = raw["kind"];
    const origin = raw["origin"];
    const subject = raw["subject"];
    if (typeof kind !== "string" || !KIND_SET.has(kind)) continue;
    if (origin !== "event" && origin !== "binding") continue;
    if (origin === "event" && !(EVENT_OP_KINDS as readonly string[]).includes(kind)) continue;
    if (origin === "binding" && !(BINDING_OP_KINDS as readonly string[]).includes(kind)) continue;
    if (typeof subject !== "string" || !SUBJECT_SET.has(subject)) continue;
    const intentRaw = raw["intentId"];
    const intentId = typeof intentRaw === "string" && INTENT_ID_RE.test(intentRaw) ? intentRaw : null;
    const nRaw = raw["n"];
    const n = typeof nRaw === "number" && Number.isInteger(nRaw) ? Math.max(1, Math.min(OPS_LIMITS.maxPerEntry, nRaw)) : 1;
    out.push({ kind: kind as OpKind, origin, subject: subject as OpSubject, intentId, n });
  }
  return out;
}

function bumpTotal(sql: SqlStore, key: string, by: number): void {
  sql.exec("INSERT INTO fc_ops_total (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n", key, by);
}

// Records entries once per `eventId` (null = binding flushes, never
// deduped). Returns false for a duplicate event.
export function recordOps(sql: SqlStore, entries: readonly OpEntry[], eventId: string | null, nowMs: number): boolean {
  if (eventId) {
    const seen = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_ops_seen WHERE event_id = ?", eventId).toArray()[0]?.n ?? 0;
    if (seen > 0) return false;
    sql.exec("INSERT INTO fc_ops_seen (event_id, seen_ms) VALUES (?, ?)", eventId, nowMs);
    sql.exec(
      "DELETE FROM fc_ops_seen WHERE event_id IN (SELECT event_id FROM fc_ops_seen WHERE seen_ms < ? LIMIT ?)",
      nowMs - OPS_LIMITS.seenTtlMs,
      OPS_LIMITS.seenPrunePerCall,
    );
  }
  for (const e of entries) {
    const n = e.n ?? 1;
    sql.exec(
      `INSERT INTO fc_ops (subject, intent_id, kind, origin, n, first_ms, last_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject, intent_id, kind, origin) DO UPDATE SET n = n + excluded.n, last_ms = excluded.last_ms`,
      e.subject,
      e.intentId ?? "",
      e.kind,
      e.origin,
      n,
      nowMs,
      nowMs,
    );
    bumpTotal(sql, `${e.origin}:${e.kind}`, n);
    if (e.origin === "event") bumpTotal(sql, `subject:${e.subject}`, n);
  }
  if (entries.length && sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_ops_total WHERE k = 'since'").toArray()[0]?.n === 0) {
    sql.exec("INSERT INTO fc_ops_total (k, n) VALUES ('since', ?)", nowMs);
  }
  return true;
}

// Raw repo totals (live counters + snapshots).
export interface OpsTotals {
  since: string | null;
  // Cloudflare-observed operations by kind.
  events: Partial<Record<EventOpKind, number>>;
  // Forge's own binding calls by kind.
  binding: Partial<Record<BindingOpKind, number>>;
  // Event ops by who they are charged to.
  bySubject: Partial<Record<OpSubject, number>>;
  // Event ops of the documented billable kinds.
  billable: number;
  // Every event op plus every binding call.
  total: number;
}

export function emptyOpsTotals(): OpsTotals {
  return { since: null, events: {}, binding: {}, bySubject: {}, billable: 0, total: 0 };
}

export function opsTotals(sql: SqlStore): OpsTotals {
  const out = emptyOpsTotals();
  for (const r of sql.exec<{ k: string; n: number }>("SELECT k, n FROM fc_ops_total").toArray()) {
    const [head, tail] = r.k.split(":", 2);
    if (r.k === "since") out.since = new Date(r.n).toISOString();
    else if (head === "event" && (EVENT_OP_KINDS as readonly string[]).includes(tail)) {
      out.events[tail as EventOpKind] = r.n;
      out.total += r.n;
      if ((DOCUMENTED_BILLABLE as readonly string[]).includes(tail)) out.billable += r.n;
    } else if (head === "binding" && (BINDING_OP_KINDS as readonly string[]).includes(tail)) {
      out.binding[tail as BindingOpKind] = r.n;
      out.total += r.n;
    } else if (head === "subject" && SUBJECT_SET.has(tail)) out.bySubject[tail as OpSubject] = r.n;
  }
  return out;
}

// One intent's operations (report_push / mark_ready payloads).
export interface IntentOps {
  intentId: string;
  events: Partial<Record<EventOpKind, number>>;
  binding: Partial<Record<BindingOpKind, number>>;
  billable: number;
  usd: number;
}

export function intentOps(sql: SqlStore, intentId: string): IntentOps {
  const out: IntentOps = { intentId, events: {}, binding: {}, billable: 0, usd: 0 };
  const rows = sql
    .exec<{ kind: string; origin: string; n: number }>("SELECT kind, origin, SUM(n) AS n FROM fc_ops WHERE intent_id = ? GROUP BY kind, origin", intentId)
    .toArray();
  for (const r of rows) {
    if (r.origin === "event" && (EVENT_OP_KINDS as readonly string[]).includes(r.kind)) {
      out.events[r.kind as EventOpKind] = r.n;
      if ((DOCUMENTED_BILLABLE as readonly string[]).includes(r.kind)) out.billable += r.n;
    } else if (r.origin === "binding" && (BINDING_OP_KINDS as readonly string[]).includes(r.kind)) {
      out.binding[r.kind as BindingOpKind] = r.n;
    }
  }
  out.usd = usdFor(out.billable);
  return out;
}

// The intents that cost the most (ledger view).
export function topIntentOps(sql: SqlStore, limit: number = OPS_LIMITS.topIntents): Array<{ intentId: string; ops: number }> {
  return sql
    .exec<{ intent_id: string; n: number }>(
      "SELECT intent_id, SUM(n) AS n FROM fc_ops WHERE intent_id != '' AND origin = 'event' GROUP BY intent_id ORDER BY n DESC, intent_id ASC LIMIT ?",
      Math.max(1, Math.min(50, limit)),
    )
    .toArray()
    .map((r) => ({ intentId: r.intent_id, ops: r.n }));
}

// ---------------------------------------------------------------------------
// Economics (pure)
// ---------------------------------------------------------------------------

export function usdFor(ops: number): number {
  return Math.round(((ops * ARTIFACTS_PRICING.perThousandOps) / 1000) * 1e6) / 1e6;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Fetches a naive agent makes over one work session.
export function naiveFetchesPerChange(b: { fetchIntervalSeconds: number; workMinutes: number } = NAIVE_BASELINE): number {
  return Math.round((b.workMinutes * 60) / b.fetchIntervalSeconds);
}

export interface OpsEconomics extends OpsTotals {
  // "measured": event ops arrived; "empty": no Artifacts traffic yet.
  status: "measured" | "empty";
  // Changes landed since `since`.
  landed: number;
  // billable ops ÷ landed (in-flight work included); null before the
  // first landing.
  perLandedChange: number | null;
  usd: number;
  usdPerLandedChange: number | null;
  // Everything counted, at the same price (binding calls and deletes
  // included): the bill can't be higher than this.
  upperBound: { ops: number; usd: number };
  // PROJECTED, not measured: the same work with one fetch every 30 s
  // over an 8-minute session per change, and the measured ratio scaled
  // to 10,000 landed changes.
  projected: {
    naivePerLandedChange: number | null;
    naiveFetchesPerChange: number;
    at10kChanges: { ops: number; usd: number; naiveOps: number; naiveUsd: number } | null;
    assumption: string;
  };
  pricing: typeof ARTIFACTS_PRICING;
  note: string;
  // Fixture/demo data built from the sim's assumption, never measured.
  simulated?: boolean;
}

export function opsEconomics(totals: OpsTotals, landed: number): OpsEconomics {
  const per = landed > 0 ? round(totals.billable / landed, 1) : null;
  const naive = naiveFetchesPerChange();
  const naivePer = per === null ? null : round(per + naive, 1);
  const at10k =
    per === null || naivePer === null
      ? null
      : { ops: Math.round(per * 10_000), usd: round(usdFor(per * 10_000)), naiveOps: Math.round(naivePer * 10_000), naiveUsd: round(usdFor(naivePer * 10_000)) };
  return {
    ...totals,
    status: totals.total > 0 ? "measured" : "empty",
    landed,
    perLandedChange: per,
    usd: usdFor(totals.billable),
    usdPerLandedChange: per === null ? null : usdFor(per),
    upperBound: { ops: totals.total, usd: usdFor(totals.total) },
    projected: {
      naivePerLandedChange: naivePer,
      naiveFetchesPerChange: naive,
      at10kChanges: at10k,
      assumption: `projected: + one fetch every ${NAIVE_BASELINE.fetchIntervalSeconds}s over a ${NAIVE_BASELINE.workMinutes}-minute session per change (sim median); 10k = measured ratio x 10,000`,
    },
    pricing: ARTIFACTS_PRICING,
    note: "measured from Cloudflare Artifacts events since the ledger began (since); usd at list price before the 10,000-op monthly allowance; binding reads and tokens counted separately (billing not documented)",
  };
}

// The sim's per-intent floor (apps/sim/src/constants.ts `git`:
// forkPerIntent 1 + clonePerIntent 1 + the agent's first push 1) for
// fixtures. Train, replay and landing traffic is per landed change, not
// per intent, so it is left out: the fixture is a floor, with no
// invented fetches. SIMULATED: shown only where the payload says so.
// forge-ops.test.ts checks this against the sim constants.
export const SIM_OPS_PER_INTENT = 3;

export function simulatedOpsEconomics(intents: number, landed: number): OpsEconomics {
  const billable = intents * SIM_OPS_PER_INTENT;
  const totals: OpsTotals = {
    since: null,
    events: { fork: intents, clone: intents, push: intents },
    binding: {},
    bySubject: { intent: billable },
    billable,
    total: billable,
  };
  return {
    ...opsEconomics(totals, landed),
    simulated: true,
    note: `SIMULATED: assumption of ${SIM_OPS_PER_INTENT} Artifacts ops per intent (apps/sim), not a measurement`,
  };
}

// One line for CLIs and demo logs.
export function opsLine(e: Pick<OpsEconomics, "billable" | "landed" | "perLandedChange" | "usd" | "status" | "projected">): string {
  if (e.status === "empty") return "Artifacts ops: none recorded yet";
  const per = e.perLandedChange === null ? "no landed change yet" : `${e.perLandedChange} per landed change`;
  const naive = e.projected.naivePerLandedChange === null ? "" : ` (naive agent, projected: ${e.projected.naivePerLandedChange})`;
  return `Artifacts ops: ${e.billable} billable, ${per}${naive}, $${e.usd.toFixed(4)} at list price`;
}

// ---------------------------------------------------------------------------
// Binding meter
// ---------------------------------------------------------------------------

const READ_METHODS = new Set(["readFile", "readCommit", "readTree", "readBlob", "log", "readRef", "listRefs", "info"]);
const TOKEN_METHODS = new Set(["createToken"]);

export type MeterSink = (repoName: string, kind: BindingOpKind) => void;

function safeSink(sink: MeterSink, repoName: string, kind: BindingOpKind): void {
  try {
    sink(repoName, kind);
  } catch {
    // Metering never fails a binding call.
  }
}

// RPC stubs (the ARTIFACTS binding and its repo handles) treat ANY
// property as a remote method, `apply`/`bind`/`call` included, and are
// often callable proxies (typeof "function"). So: never touch those
// properties, call through Reflect.apply with the real receiver, and
// accept function-typed handles.
function isHandle(v: unknown): v is object {
  return (typeof v === "object" || typeof v === "function") && v !== null;
}

// Wraps a repo handle: counted methods report, everything else (incl.
// Symbol.dispose) passes through with the real handle as receiver.
function meterHandle<H extends object>(handle: H, repoName: string, sink: MeterSink): H {
  return new Proxy(handle, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      const kind: BindingOpKind | null =
        typeof prop === "string" ? (TOKEN_METHODS.has(prop) ? "token" : READ_METHODS.has(prop) ? "read" : null) : null;
      return (...args: unknown[]): unknown => {
        if (kind) safeSink(sink, repoName, kind);
        return Reflect.apply(fn, target, args);
      };
    },
  });
}

// Wraps the ARTIFACTS binding so every handle from `get(name)` is
// metered. The binding's own methods (create/import/delete/get) are
// not counted here: repo creation and deletion arrive as events.
export function meterArtifacts<B extends object>(binding: B, sink: MeterSink): B {
  return new Proxy(binding, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === "get") {
        return async (...args: unknown[]): Promise<unknown> => {
          const handle: unknown = await Reflect.apply(fn, target, args);
          const name = typeof args[0] === "string" ? args[0] : "";
          return isHandle(handle) && name ? meterHandle(handle, name, sink) : handle;
        };
      }
      return (...args: unknown[]): unknown => Reflect.apply(fn, target, args);
    },
  });
}

// Buffers binding calls per Artifacts repo name until flushed.
export class OpsTally {
  private readonly counts = new Map<string, number>();

  add(repoName: string, kind: BindingOpKind, n = 1): void {
    const key = `${kind}\u0000${repoName}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  get size(): number {
    return this.counts.size;
  }

  drain(): Array<{ repoName: string; kind: BindingOpKind; n: number }> {
    const out: Array<{ repoName: string; kind: BindingOpKind; n: number }> = [];
    for (const [key, n] of this.counts) {
      const [kind, repoName] = key.split("\u0000", 2);
      out.push({ repoName, kind: kind as BindingOpKind, n });
    }
    this.counts.clear();
    return out;
  }
}

// Groups drained binding calls into per-repo entry lists via the same
// attribution as events. Unattributed names are dropped (and counted in
// `dropped` for the caller's log line).
export async function attributeTally(
  lookups: OpsLookups,
  drained: ReadonlyArray<{ repoName: string; kind: BindingOpKind; n: number }>,
): Promise<{ byRepo: Map<string, OpEntry[]>; dropped: number }> {
  const byRepo = new Map<string, OpEntry[]>();
  const cache = new Map<string, OpTarget | null>();
  let dropped = 0;
  for (const d of drained) {
    let target = cache.get(d.repoName);
    if (target === undefined) {
      target = await attributeOp(lookups, { repoName: d.repoName }).catch(() => null);
      cache.set(d.repoName, target);
    }
    if (!target) {
      dropped += d.n;
      continue;
    }
    const list = byRepo.get(target.repo) ?? [];
    list.push({ kind: d.kind, origin: "binding", subject: target.subject, intentId: target.intentId, n: d.n });
    byRepo.set(target.repo, list);
  }
  return { byRepo, dropped };
}

// ---------------------------------------------------------------------------
// One Artifacts event -> one ledger entry (ForgePushWorkflow's meter step)
// ---------------------------------------------------------------------------

export interface OpEventDeps {
  // Our namespace; events from any other are skipped ("" = accept all).
  namespace: string;
  lookups: OpsLookups;
  record(repo: string, entries: OpEntry[], eventId: string | null): Promise<unknown>;
}

export type OpEventOutcome =
  | { status: "recorded"; kind: EventOpKind; repo: string; subject: OpSubject; intentId: string | null }
  | { status: "skipped"; reason: "invalid" | "other-namespace" | "unattributed"; kind?: EventOpKind; repoName?: string };

export async function handleArtifactsOpEvent(deps: OpEventDeps, raw: unknown, eventId: string | null): Promise<OpEventOutcome> {
  const ev = parseArtifactsOpEvent(raw);
  if (!ev) return { status: "skipped", reason: "invalid" };
  if (deps.namespace && ev.namespace !== deps.namespace) return { status: "skipped", reason: "other-namespace", kind: ev.kind };
  const target = await attributeOp(deps.lookups, ev);
  if (!target) return { status: "skipped", reason: "unattributed", kind: ev.kind, repoName: ev.repoName };
  await deps.record(target.repo, [{ kind: ev.kind, origin: "event", subject: target.subject, intentId: target.intentId, n: 1 }], eventId);
  return { status: "recorded", kind: ev.kind, repo: target.repo, subject: target.subject, intentId: target.intentId };
}
