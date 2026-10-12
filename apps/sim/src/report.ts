// Bench output: the `GET /v1/forge/bench` document (FORGE-UX §5.8 / §8:
// `{ run, measured_at, sha, modes:[{mode, metrics, projected}] }`) and
// a plain-text table. Simulated runs are labelled `simulated: true` on
// the document and every row, and the table header says SIMULATED.

import { DEFAULT_CONSTANTS } from "./constants.ts";
import { pullBreakdown, type PollProjection } from "./pull.ts";
import { GIT_MODE_LABELS, MODE_LABELS, type Mode, type ModeMetrics, type SimResult } from "./sim.ts";

export interface BenchMetrics {
  landed: number;
  abandoned: number;
  changes_per_min: number;
  median_declare_to_land_min: number | null;
  p95_declare_to_land_min: number | null;
  time_to_80pct_landed_min: number | null;
  makespan_min: number;
  conflicts_hit: number;
  conflicts_avoided: number;
  stacked_intents: number;
  replays_attempted: number;
  replays_succeeded: number;
  // Defects no CI catches (formerly "red_main_min"): count, and the
  // union of [land, land + MTTR] minutes they keep main red.
  escaped_defects: number;
  escaped_defect_min: number;
  // Main red because a landed state was never verified as that exact SHA.
  // 0 by construction for trains/Forge; computed per landing.
  main_red_integration_min: number;
  unverified_landings: number;
  speculative_groups: number;
  invalidated_lanes: number;
  human_min: number;
  human_breakdown_min: { review: number; rereview: number; plan_approval: number; audit: number; escalation: number };
  routes: { auto: number; audit: number; human: number };
  ci_runs: number;
  trains: number;
  bisections: number;
  // Billable Artifacts git ops (fork + clone + fetch + push), SIMULATED.
  // Numeric for every mode (the baseline is the PR flow on the same
  // Artifacts repo); the `| null` stays for older recorded documents.
  artifacts_ops: number | null;
  dollars_per_1k_agents: number | null;
  // Pull model (apps/sim/src/pull.ts). SIMULATED per landed change.
  git_ops: { fork: number; clone: number; fetch: number; push: number; ls_remote: number; token: number };
  git_ops_per_landed: { fork: number; clone: number; fetch: number; push: number };
  billable_ops_per_landed: number;
  // ls-remote + token mints: Artifacts billing for these is undocumented.
  binding_calls_per_landed: { ls_remote: number; token: number };
  usd_per_10k_changes: number;
  mean_min_in_system: number;
  // PROJECTED: polling added post-hoc (0 for modes that sync by events).
  poll_projection: PollProjection[];
}

export interface BenchModeRow {
  mode: Mode;
  label: string;
  // Set for a constants variant of a mode (e.g. "forge-fetch-cache").
  variant?: string;
  metrics: BenchMetrics;
  projected: false;
  simulated: true;
}

export interface BenchDoc {
  run: string;
  measured_at: string;
  sha: string;
  kind: "simulated";
  simulated: true;
  agents: number;
  seed: number;
  repo_files: number;
  overlap_at_declare: number;
  command: string;
  modes: BenchModeRow[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const finiteOrNull = (n: number): number | null => (Number.isFinite(n) ? r2(n) : null);

export interface PullOpts {
  pollIntervalsSec?: readonly number[];
  dollarsPer1kOps?: number;
}

function roundWindow(w: PollProjection["while_working"]): PollProjection["while_working"] {
  return { polls_per_landed: r2(w.polls_per_landed), ops_per_landed: r2(w.ops_per_landed), usd_per_10k_changes: r2(w.usd_per_10k_changes) };
}

export function toBenchMetrics(m: ModeMetrics, opts: PullOpts = {}): BenchMetrics {
  const pull = pullBreakdown(m, {
    pollIntervalsSec: opts.pollIntervalsSec ?? DEFAULT_CONSTANTS.git.pollIntervalsSec,
    dollarsPer1kOps: opts.dollarsPer1kOps ?? DEFAULT_CONSTANTS.dollarsPer1kOps,
  });
  return {
    landed: m.landed,
    abandoned: m.abandoned,
    changes_per_min: r2(m.landedPerMin),
    median_declare_to_land_min: finiteOrNull(m.declareToLandP50Min),
    p95_declare_to_land_min: finiteOrNull(m.declareToLandP95Min),
    time_to_80pct_landed_min: finiteOrNull(m.timeTo80PctMin),
    makespan_min: r2(m.makespanMin),
    conflicts_hit: m.conflictsEncountered,
    conflicts_avoided: m.conflictsAvoided,
    stacked_intents: m.stackedIntents,
    replays_attempted: m.replaysAttempted,
    replays_succeeded: m.replaysSucceeded,
    escaped_defects: m.escapedDefects,
    escaped_defect_min: r2(m.escapedDefectMin),
    main_red_integration_min: r2(m.mainRedIntegrationMin),
    unverified_landings: m.unverifiedLandings,
    speculative_groups: m.speculativeGroups,
    invalidated_lanes: m.invalidatedLanes,
    human_min: r2(m.humanReviewMin),
    human_breakdown_min: {
      review: r2(m.human.review),
      rereview: r2(m.human.rereview),
      plan_approval: r2(m.human.planApproval),
      audit: r2(m.human.audit),
      escalation: r2(m.human.escalation),
    },
    routes: { ...m.routes },
    ci_runs: m.ciRuns,
    trains: m.trains,
    bisections: m.bisections,
    artifacts_ops: m.artifactsOps,
    dollars_per_1k_agents: r2((m.artifactsDollars * 1000) / Math.max(1, m.agents)),
    git_ops: { fork: m.git.fork, clone: m.git.clone, fetch: m.git.fetch, push: m.git.push, ls_remote: m.git.lsRemote, token: m.git.token },
    git_ops_per_landed: {
      fork: r3(pull.ops_per_landed.fork),
      clone: r3(pull.ops_per_landed.clone),
      fetch: r3(pull.ops_per_landed.fetch),
      push: r3(pull.ops_per_landed.push),
    },
    billable_ops_per_landed: r3(pull.billable_per_landed),
    binding_calls_per_landed: { ls_remote: r3(pull.binding_per_landed.ls_remote), token: r3(pull.binding_per_landed.token) },
    usd_per_10k_changes: r2(pull.usd_per_10k_changes),
    mean_min_in_system: r2(pull.mean_min_in_system),
    poll_projection: pull.polls.map((p) => ({
      interval_s: p.interval_s,
      sync: p.sync,
      while_working: roundWindow(p.while_working),
      until_landed: roundWindow(p.until_landed),
    })),
  };
}

export interface BenchMeta extends PullOpts {
  sha: string;
  date: string;
  command: string;
  // A constants variant: every row gets this key and label.
  variant?: { key: string; label: string };
}

export function toBenchDoc(result: SimResult, meta: BenchMeta): BenchDoc {
  return {
    run: `sim-s${result.seed}-n${result.agents}`,
    measured_at: meta.date,
    sha: meta.sha,
    kind: "simulated",
    simulated: true,
    agents: result.agents,
    seed: result.seed,
    repo_files: result.fileCount,
    overlap_at_declare: r2(result.overlapAtDeclare * 100) / 100,
    command: meta.command,
    modes: result.modes.map((m) => ({
      mode: m.mode,
      label: meta.variant ? meta.variant.label : MODE_LABELS[m.mode],
      ...(meta.variant ? { variant: meta.variant.key } : {}),
      metrics: toBenchMetrics(m, meta),
      projected: false,
      simulated: true,
    })),
  };
}

// "45m", "3h 12m", "12d 4h".
export function formatMinutes(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return "n/a";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${Math.round(min - h * 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

const COLUMNS = [
  "Mode",
  "Landed",
  "Abandoned",
  "Changes/min",
  "80% landed by",
  "p50 declare->land",
  "p95",
  "Conflicts hit / avoided",
  "Escaped defects (n / min)",
  "Main red: integration min",
  "Human min",
  "CI runs",
  "$ / 1k agents",
  "Git ops / landed",
  "$ / 10k changes",
] as const;

export function tableRows(doc: BenchDoc): string[][] {
  return doc.modes.map((row) => {
    const m = row.metrics;
    return [
      row.label,
      formatInt(m.landed),
      formatInt(m.abandoned),
      m.changes_per_min.toFixed(2),
      formatMinutes(m.time_to_80pct_landed_min),
      formatMinutes(m.median_declare_to_land_min),
      formatMinutes(m.p95_declare_to_land_min),
      `${formatInt(m.conflicts_hit)} / ${formatInt(m.conflicts_avoided)}`,
      `${formatInt(m.escaped_defects)} / ${formatInt(m.escaped_defect_min)}`,
      formatInt(m.main_red_integration_min),
      formatInt(m.human_min),
      formatInt(m.ci_runs),
      m.dollars_per_1k_agents === null ? "n/a" : `$${m.dollars_per_1k_agents.toFixed(2)}`,
      fmtOps(m.billable_ops_per_landed),
      `$${m.usd_per_10k_changes.toFixed(2)}`,
    ];
  });
}

export function headerLine(doc: BenchDoc): string {
  return (
    `SIMULATED (not a measurement) · ${formatInt(doc.agents)} agents · seed ${doc.seed} · ` +
    `${formatInt(doc.repo_files)}-file repo · ${(doc.overlap_at_declare * 100).toFixed(1)}% overlap at declare · ` +
    `${doc.measured_at} @ ${doc.sha}`
  );
}

export function formatTable(doc: BenchDoc): string {
  const rows = [COLUMNS.slice(), ...tableRows(doc)];
  const widths = COLUMNS.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: readonly string[]): string =>
    r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
  return [headerLine(doc), line(rows[0]), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(line)].join("\n");
}

// Markdown table for docs/FORGE-BENCH.md.
export function formatMarkdown(doc: BenchDoc): string {
  const head = `| ${COLUMNS.join(" | ")} |`;
  const sep = `|${COLUMNS.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`;
  return [head, sep, ...tableRows(doc).map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

// ---------------------------------------------------------------------------
// Pull curve: git traffic per landed change, N x mode (docs/FORGE-BENCH.md
// "Pull traffic"). SIMULATED ops by kind; PROJECTED polling.
// ---------------------------------------------------------------------------

function fmtOps(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return n >= 100 ? formatInt(n) : n.toFixed(1);
}

function fmtUsd(n: number): string {
  return `$${n >= 100 ? formatInt(n) : n.toFixed(2)}`;
}

export interface PullCurveRow {
  agents: number;
  mode: Mode;
  label: string;
  variant?: string;
  landed: number;
  mean_min_in_system: number;
  git_ops_per_landed: BenchMetrics["git_ops_per_landed"];
  billable_ops_per_landed: number;
  binding_calls_per_landed: BenchMetrics["binding_calls_per_landed"];
  usd_per_10k_changes: number;
  poll_projection: PollProjection[];
}

// Docs in order; rows of the same agent count stay together.
export function pullCurve(docs: readonly BenchDoc[]): PullCurveRow[] {
  const order: number[] = [];
  for (const d of docs) if (!order.includes(d.agents)) order.push(d.agents);
  const rows: PullCurveRow[] = [];
  for (const n of order) {
    for (const d of docs) {
      if (d.agents !== n) continue;
      for (const row of d.modes) {
        const m = row.metrics;
        rows.push({
          agents: n,
          mode: row.mode,
          label: row.label,
          ...(row.variant ? { variant: row.variant } : {}),
          landed: m.landed,
          mean_min_in_system: m.mean_min_in_system,
          git_ops_per_landed: m.git_ops_per_landed,
          billable_ops_per_landed: m.billable_ops_per_landed,
          binding_calls_per_landed: m.binding_calls_per_landed,
          usd_per_10k_changes: m.usd_per_10k_changes,
          poll_projection: m.poll_projection,
        });
      }
    }
  }
  return rows;
}

function renderTable(head: readonly string[], rows: string[][], markdown: boolean): string {
  if (markdown) {
    return [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (i < 2 ? "---" : "---:")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
  }
  const all = [head.slice(), ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r: readonly string[]): string => r.map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const shortLabel = (r: PullCurveRow): string => (r.variant ? r.label : GIT_MODE_LABELS[r.mode]);

export function formatPullCurve(docs: readonly BenchDoc[], opts: { markdown?: boolean } = {}): string {
  const rows = pullCurve(docs);
  const md = Boolean(opts.markdown);
  const intervals = rows.length ? rows[0].poll_projection.map((p) => p.interval_s) : [];
  const simHead = ["N", "Mode", "Landed", "Min in system", "fork", "clone", "fetch", "push", "Billable / landed", "[ls-remote]", "[token]", "$ / 10k changes"];
  const simRows = rows.map((r) => [
    formatInt(r.agents),
    shortLabel(r),
    formatInt(r.landed),
    formatMinutes(r.mean_min_in_system),
    fmtOps(r.git_ops_per_landed.fork),
    fmtOps(r.git_ops_per_landed.clone),
    fmtOps(r.git_ops_per_landed.fetch),
    fmtOps(r.git_ops_per_landed.push),
    fmtOps(r.billable_ops_per_landed),
    fmtOps(r.binding_calls_per_landed.ls_remote),
    fmtOps(r.binding_calls_per_landed.token),
    fmtUsd(r.usd_per_10k_changes),
  ]);
  const pollHead = ["N", "Mode", ...intervals.flatMap((s) => [`poll ${s}s: ops / landed`, `poll ${s}s: $ / 10k`])];
  const pollRows = rows.map((r) => [
    formatInt(r.agents),
    shortLabel(r) + (r.poll_projection[0]?.sync === "events" ? " (events, 0 polls)" : ""),
    ...r.poll_projection.flatMap((p) => {
      if (p.sync === "events") return [fmtOps(p.until_landed.ops_per_landed), fmtUsd(p.until_landed.usd_per_10k_changes)];
      return [
        `${fmtOps(p.while_working.ops_per_landed)} .. ${fmtOps(p.until_landed.ops_per_landed)}`,
        `${fmtUsd(p.while_working.usd_per_10k_changes)} .. ${fmtUsd(p.until_landed.usd_per_10k_changes)}`,
      ];
    }),
  ]);
  const t1 = "SIMULATED git ops per landed change, by kind (billable: fork + clone + fetch + push; [bracketed] = billing undocumented)";
  const t2 =
    "PROJECTED: the simulated ops + polling (git fetch every S s), applied post-hoc; range = poll while working .. poll until landed or abandoned";
  return [t1, renderTable(simHead, simRows, md), "", t2, renderTable(pollHead, pollRows, md)].join("\n");
}
