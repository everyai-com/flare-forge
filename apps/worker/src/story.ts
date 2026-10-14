// The story page: the whole Forge loop told as chapters on live data.
//
// One static HTML shell (served before ensureSchema, like /dashboard) whose
// client polls ONE read, GET /v1/forge/story?repo= (signed-in session), and
// falls back to GET /v1/public/forge/story?repo= for spectators. Every
// chapter answers one of the competition's questions with the real repo's
// state and says why the mechanism works. Empty states name the command
// that fills them, so the page also works while a judge runs
// `npm run forge:demo` and `npm run forge:agents` from nothing.
//
// Conventions (same as dashboard.ts): the embedded JS has no backticks and
// no `${` (the outer template literal), and API data only ever reaches the
// DOM through textContent, never innerHTML.

export const STORY_CHAPTERS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "open", title: "One repo, many agents" },
  { id: "repo", title: "A repo on Artifacts" },
  { id: "agents", title: "Agents connect" },
  { id: "goals", title: "Goals become intents" },
  { id: "declare", title: "Declare before you edit" },
  { id: "forks", title: "A fork per intent" },
  { id: "trains", title: "Trains verify the exact SHA" },
  { id: "conflicts", title: "Conflicts are replayed" },
  { id: "inbox", title: "What a human reviews" },
  { id: "why", title: "Why this line exists" },
  { id: "bill", title: "The Artifacts bill" },
  { id: "built", title: "How it is built" },
];

export function storyHtml(): string {
  return STORY_HTML;
}

const STORY_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Flare Forge · the story</title>
<style>
:root { color-scheme: dark; --bg:#0a0a0a; --card:#111113; --line:#1f1f23; --line-strong:#2e2e33; --ink:#fafafa; --soft:#a1a1aa; --muted:#71717a; --faint:#3f3f46; --accent:#fafafa; --hover:#17171a;
  --st-working:#7db4f7; --st-overlap:#fbbf24; --st-conflict:#f87171; --st-landed:#4ade80; --st-train:#a78bfa; --st-human:#fb923c; --st-idle:#52525b;
  --tint-working:rgba(125,180,247,.12); --tint-overlap:rgba(251,191,36,.12); --tint-conflict:rgba(248,113,113,.12); --tint-landed:rgba(74,222,128,.12); --tint-train:rgba(167,139,250,.12); --tint-human:rgba(251,146,60,.12);
  --rail:240px; --narr:400px; }
* { box-sizing:border-box; }
html, body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
body { overflow-x:hidden; }
a { color:inherit; }
.mono, code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12.5px; }
pre { margin:0; white-space:pre-wrap; word-break:break-word; }
.num { font-variant-numeric: tabular-nums; }
button { font:inherit; color:inherit; background:none; border:1px solid var(--line-strong); border-radius:8px; padding:6px 10px; cursor:pointer; }
button:hover { background:var(--hover); }
button.primary { background:var(--accent); color:#0a0a0a; border-color:var(--accent); font-weight:600; }
button.primary:hover { background:#e4e4e7; }
button[disabled] { opacity:.5; cursor:default; }
input[type=text] { font:inherit; color:var(--ink); background:#0a0a0a; border:1px solid var(--line-strong); border-radius:8px; padding:6px 10px; }
.hidden { display:none !important; }

/* top bar */
#top { position:fixed; top:0; left:0; right:0; height:52px; display:flex; align-items:center; gap:14px; padding:0 16px; background:rgba(10,10,10,.86); backdrop-filter: blur(10px); border-bottom:1px solid var(--line); z-index:20; }
#top .brand { display:flex; align-items:center; gap:8px; font-weight:600; }
#top .brand .f { width:22px; height:22px; border-radius:6px; background:var(--accent); color:#0a0a0a; display:grid; place-items:center; font-weight:700; font-size:13px; }
#top .repo { display:flex; align-items:center; gap:8px; color:var(--soft); }
#top .repo input { width:170px; }
#top .live { display:flex; align-items:center; gap:8px; color:var(--soft); font-size:12.5px; }
#top .live .dot { width:8px; height:8px; border-radius:50%; background:var(--st-idle); }
#top .live.on .dot { background:var(--st-landed); box-shadow:0 0 0 0 rgba(74,222,128,.6); animation: pulse 2s infinite; }
#top .live.err .dot { background:var(--st-conflict); }
@keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(74,222,128,.5);} 70% { box-shadow:0 0 0 8px rgba(74,222,128,0);} 100% { box-shadow:0 0 0 0 rgba(74,222,128,0);} }
#top .spacer { flex:1; }
#top .mode { color:var(--muted); font-size:12px; }
#top .links a { color:var(--soft); text-decoration:none; font-size:12.5px; margin-left:12px; }
#top .links a:hover { color:var(--ink); }

/* rail */
#rail { position:fixed; top:52px; left:0; bottom:0; width:var(--rail); padding:18px 12px; border-right:1px solid var(--line); overflow:auto; z-index:10; background:var(--bg); }
#rail .k { font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); padding:0 8px 8px; }
#rail a { display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:8px; text-decoration:none; color:var(--soft); font-size:13px; }
#rail a:hover { background:var(--hover); color:var(--ink); }
#rail a.cur { background:var(--hover); color:var(--ink); }
#rail a .n { width:20px; height:20px; border-radius:6px; border:1px solid var(--line-strong); display:grid; place-items:center; font-size:11px; color:var(--muted); flex:none; }
#rail a.cur .n { border-color:var(--ink); color:var(--ink); }
#rail a .s { margin-left:auto; width:7px; height:7px; border-radius:50%; background:transparent; }
#rail a .s.on { background:var(--st-working); }
#rail a .s.need { background:var(--st-human); }
#rail .foot { margin-top:18px; padding:10px 8px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); }
#rail .foot kbd { border:1px solid var(--line-strong); border-radius:4px; padding:0 4px; font-size:11px; }

/* chapters */
#main { margin-left:var(--rail); padding-top:52px; }
section.ch { min-height:calc(100vh - 52px); display:grid; grid-template-columns: var(--narr) 1fr; gap:32px; padding:48px 40px 56px 36px; border-bottom:1px solid var(--line); scroll-margin-top:52px; }
.narr .kicker { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
.narr h1 { font-size:28px; line-height:1.15; letter-spacing:-.02em; margin:0 0 14px; font-weight:600; }
.narr p { color:var(--soft); margin:0 0 12px; font-size:15px; }
.narr .why { margin-top:18px; padding:12px 14px; border:1px solid var(--line); border-radius:10px; background:var(--card); }
.narr .why .t { font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
.narr .why li { color:var(--soft); margin:4px 0 4px 0; font-size:13.5px; }
.narr .why ul { margin:0; padding-left:18px; }
.narr .cmd { margin-top:14px; }
.cmd { position:relative; border:1px solid var(--line-strong); border-radius:10px; background:#0d0d0f; padding:10px 40px 10px 12px; }
.cmd pre { color:var(--ink); }
.cmd .cp { position:absolute; top:6px; right:6px; padding:3px 8px; font-size:11px; border-radius:6px; }
.cmd .lbl { font-size:11px; color:var(--muted); margin-bottom:4px; }
.live { min-width:0; }
.card { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:14px 16px; }
.card + .card { margin-top:12px; }
.card h2 { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin:0 0 10px; display:flex; align-items:center; gap:8px; }
.card h2 .r { margin-left:auto; font-weight:400; text-transform:none; letter-spacing:0; color:var(--muted); }
.grid { display:grid; gap:12px; }
.g2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
.g3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
.g4 { grid-template-columns:repeat(4,minmax(0,1fr)); }
.stat { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:14px 16px; min-width:0; }
.stat .l { font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }
.stat .v { font-size:34px; font-weight:600; letter-spacing:-.02em; line-height:1.1; margin-top:6px; }
.stat .v small { font-size:14px; color:var(--muted); font-weight:400; margin-left:4px; }
.stat .m { font-size:12px; color:var(--muted); margin-top:4px; }
.stage .stat .v { font-size:48px; }
.empty { color:var(--muted); font-size:13.5px; padding:10px 0; }
.empty b { color:var(--soft); font-weight:600; }
.row { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--line); min-width:0; }
.row:first-of-type { border-top:0; }
.row .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.row .sub { color:var(--muted); font-size:12px; }
.pill { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:999px; font-size:11.5px; border:1px solid var(--line-strong); color:var(--soft); white-space:nowrap; }
.pill .d { width:7px; height:7px; border-radius:50%; background:var(--st-idle); }
.pill.working .d, .pill.claimed .d, .pill.pushing .d { background:var(--st-working); }
.pill.ready .d, .pill.in_train .d, .pill.running .d { background:var(--st-train); }
.pill.landed .d, .pill.success .d, .pill.resolved .d { background:var(--st-landed); }
.pill.conflicted .d, .pill.failed .d, .pill.failure .d, .pill.aborted .d, .pill.error .d, .pill.open .d { background:var(--st-conflict); }
.pill.awaiting_plan .d, .pill.needs_you .d, .pill.human .d, .pill.escalated .d { background:var(--st-human); }
.pill.overlap .d, .pill.replaying .d, .pill.claimed-c .d { background:var(--st-overlap); }
.mono-chip { display:inline-block; padding:1px 6px; border-radius:6px; background:#0a0a0a; border:1px solid var(--line); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; color:var(--soft); white-space:nowrap; }
.mono-chip.drift { border-color:var(--st-overlap); color:var(--st-overlap); }
.ava { width:26px; height:26px; border-radius:8px; border:1px solid var(--line-strong); display:grid; place-items:center; font-size:11px; font-weight:600; color:var(--soft); flex:none; background:#0a0a0a; }
.ava.on { border-color:var(--st-working); color:var(--st-working); }
.term { display:inline-flex; gap:6px; align-items:center; padding:2px 8px; border-radius:6px; font-size:11.5px; border:1px solid var(--line); color:var(--soft); margin:2px 4px 2px 0; }
.term b { font-weight:600; color:var(--ink); }
.risk { font-weight:600; }
.risk.low { color:var(--st-landed); } .risk.med { color:var(--st-overlap); } .risk.high { color:var(--st-conflict); }
.steps { display:flex; gap:6px; align-items:center; }
.steps .st { flex:1; padding:6px 8px; border-radius:8px; border:1px solid var(--line); font-size:11.5px; color:var(--muted); text-align:center; }
.steps .st.done { border-color:var(--st-landed); color:var(--st-landed); background:var(--tint-landed); }
.steps .st.running, .steps .st.pending { border-color:var(--st-train); color:var(--st-train); background:var(--tint-train); }
.steps .st.failed { border-color:var(--st-conflict); color:var(--st-conflict); background:var(--tint-conflict); }
.map { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; }
.cell { border:1px solid var(--line); border-radius:10px; padding:8px 10px; min-height:62px; background:#0d0d0f; }
.cell.working { border-color:var(--st-working); background:var(--tint-working); }
.cell.overlap { border-color:var(--st-overlap); background:repeating-linear-gradient(45deg, var(--tint-overlap) 0 4px, transparent 4px 8px); }
.cell.conflict { border-color:var(--st-conflict); background:var(--tint-conflict); }
.cell.awaiting_plan, .cell.human { border-color:var(--st-human); background:var(--tint-human); }
.cell.landed { border-color:var(--st-landed); background:var(--tint-landed); }
.cell .p { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cell .s { font-size:11px; color:var(--muted); margin-top:4px; }
.vs { display:grid; grid-template-columns:1fr auto 1fr; gap:10px; align-items:center; }
.vs .x { color:var(--st-conflict); font-weight:700; }
.side { border:1px solid var(--line); border-radius:10px; padding:8px 10px; min-width:0; }
.side .t { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.code { border:1px solid var(--line); border-radius:10px; background:#0d0d0f; overflow:auto; max-height:380px; }
.code .ln { display:flex; gap:12px; padding:0 10px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:20px; cursor:pointer; white-space:pre; }
.code .ln:hover { background:var(--hover); }
.code .ln.sel { background:var(--tint-train); }
.code .ln .n { color:var(--faint); width:34px; text-align:right; flex:none; user-select:none; }
.chain { display:flex; flex-direction:column; gap:0; }
.chain .nd { display:flex; gap:12px; padding:8px 0; border-top:1px solid var(--line); }
.chain .nd:first-child { border-top:0; }
.chain .nd .k { width:84px; flex:none; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); padding-top:3px; }
.chain .nd .b { flex:1; min-width:0; }
.chain .nd .b .t { font-weight:600; }
.chain .nd .b .x { color:var(--soft); font-size:13px; margin-top:2px; white-space:pre-wrap; }
.four { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:16px; }
.four a { display:block; border:1px solid var(--line); border-radius:10px; padding:10px 12px; text-decoration:none; color:var(--soft); background:var(--card); }
.four a:hover { border-color:var(--line-strong); color:var(--ink); }
.four a b { display:block; color:var(--ink); margin-bottom:2px; }
.bar { height:8px; border-radius:4px; background:#1a1a1d; overflow:hidden; display:flex; }
.bar i { display:block; height:100%; }
.legend { display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--muted); margin-top:8px; }
.legend i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
.arch li { margin:6px 0; color:var(--soft); }
.arch b { color:var(--ink); }
#ticker { position:fixed; left:calc(var(--rail) + 24px); right:24px; bottom:16px; z-index:15; display:flex; flex-direction:column; gap:6px; align-items:flex-start; pointer-events:none; }
#ticker .ev { background:rgba(17,17,19,.96); border:1px solid var(--line-strong); border-radius:10px; padding:8px 12px; font-size:13px; display:flex; gap:8px; align-items:center; box-shadow:0 8px 24px rgba(0,0,0,.4); animation: rise .25s ease-out; }
#ticker .ev .d { width:8px; height:8px; border-radius:50%; background:var(--st-working); }
#ticker .ev.landed .d { background:var(--st-landed); } #ticker .ev.conflict .d { background:var(--st-conflict); } #ticker .ev.human .d { background:var(--st-human); } #ticker .ev.train .d { background:var(--st-train); } #ticker .ev.overlap .d { background:var(--st-overlap); }
@keyframes rise { from { transform:translateY(8px); opacity:0;} to { transform:none; opacity:1;} }
#banner { margin:0 0 16px; padding:10px 14px; border:1px solid var(--st-human); background:var(--tint-human); border-radius:10px; font-size:13px; color:var(--ink); }
.stage { --narr:460px; }
.stage .narr h1 { font-size:36px; }
.stage .narr p { font-size:17px; }
.stage body, .stage { font-size:15px; }
@media (max-width: 1100px) { section.ch { grid-template-columns:1fr; } :root { --narr:1fr; } }
@media (max-width: 800px) { #rail { display:none; } #main { margin-left:0; } #bannerWrap { padding:12px 16px 0 !important; } section.ch { padding:28px 16px 40px; } #ticker { left:16px; right:16px; } #top { gap:10px; padding:0 12px; } #top .repo, #top .mode, #top .brand .sub, #top .links a:not(:first-child) { display:none; } #top .live span:not(.dot) { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:150px; } .narr h1 { font-size:24px; } .g4 { grid-template-columns:repeat(2,minmax(0,1fr)); } .g3 { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (prefers-reduced-motion: reduce) { #top .live.on .dot { animation:none; } #ticker .ev { animation:none; } }
</style>
</head>
<body>
<div id="top">
  <div class="brand"><span class="f">F</span><span>Flare Forge</span><span class="sub" style="color:var(--muted);font-weight:400">· the story</span></div>
  <div class="repo"><span>repo</span><input id="repoIn" type="text" value="bookshelf" spellcheck="false" aria-label="Repo name"></div>
  <div class="live" id="liveBadge"><span class="dot"></span><span id="liveText">connecting…</span></div>
  <div class="spacer"></div>
  <span class="mode" id="modeText"></span>
  <button id="playBtn" title="Auto-advance one chapter every 20 s (for recording)">Play</button>
  <div class="links"><a id="dashLink" href="/dashboard">Dashboard</a><a id="watchLink" href="/watch">Watch</a><a href="https://github.com/everyai-com/flare-forge" rel="noopener">GitHub</a></div>
</div>
<nav id="rail" aria-label="Chapters"><div class="k">Chapters</div><div id="railList"></div>
  <div class="foot">Scroll, or <kbd>j</kbd> / <kbd>k</kbd> and <kbd>←</kbd> <kbd>→</kbd>. Every number is live from this deployment; nothing on this page is a fixture.</div></nav>
<main id="main">
  <div id="bannerWrap" style="padding:16px 40px 0 36px"></div>

  <section class="ch" id="ch-open">
    <div class="narr">
      <div class="kicker">Chapter 0 · One repo, many agents</div>
      <h1>Pull requests ask what changed. Agents need a system that knows what everyone is <em>about</em> to change, and why.</h1>
      <p>This is a live repo on Cloudflare Artifacts with coding agents working on it right now. No branches to babysit, no pull requests to triage, no trunk token in any agent's hands.</p>
      <p>Four questions decide whether many agents can share one repo. Each chapter below answers one of them with this repo's real state.</p>
      <div class="four">
        <a href="#ch-declare"><b>Who is doing what?</b>Intents, declared before any edit</a>
        <a href="#ch-trains"><b>What happens when they collide?</b>Trains, bisect, replay</a>
        <a href="#ch-inbox"><b>What does a human review?</b>A risk-routed inbox</a>
        <a href="#ch-why"><b>Why does this line exist?</b>Line → intent → goal → reason</a>
      </div>
    </div>
    <div class="live">
      <div class="grid g4" id="openStats"></div>
      <div class="card" style="margin-top:12px"><h2>Right now <span class="r" id="openNow"></span></h2><div id="openDots"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-repo">
    <div class="narr">
      <div class="kicker">Chapter 1 · A repo on Artifacts</div>
      <h1>Trunk lives in Cloudflare Artifacts. Agents never push to it.</h1>
      <p>The repo is an ordinary git remote on Artifacts, so every tool that speaks git works. Trunk is read-only to agents: only CI-verified trains move <code>main</code>.</p>
      <p>Bring a repo three ways: create it and push with plain git, import it from GitHub into the namespace, or point a Flare deployment at an existing Artifacts repo.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>Artifacts makes a repo, and a fork of it, cheap enough to give every intent its own.</li>
        <li>Trunk has no agent-reachable write token. The only writer is the train Workflow, after CI passed on the exact merged SHA.</li>
        <li>Lane refs and <code>refs/notes/why</code> are pre-created, so provenance has a home from the first push.</li>
      </ul></div>
      <div class="cmd"><div class="lbl">Create the demo trunk and seed three goals (idempotent)</div><pre>npm run forge:demo</pre><button class="cp" data-copy="npm run forge:demo">copy</button></div>
    </div>
    <div class="live">
      <div class="card"><h2>Trunk <span class="r" id="repoHeadAt"></span></h2><div id="repoCard"></div></div>
      <div class="card"><h2>Repos in this namespace <span class="r" id="reposCount"></span></h2><div id="reposList"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-agents">
    <div class="narr">
      <div class="kicker">Chapter 2 · Agents connect</div>
      <h1>Any agent joins with one line. Claude Code, Codex, Cursor, or a shell script.</h1>
      <p>Forge is an MCP server and a REST API over the same verbs. An agent adds it, says what it is about to do, and gets back everything it needs: overlaps, a fork, a token, the exact commands.</p>
      <p>The agents on the right are real sessions that touched this repo. Their names are self-reported; their work is not.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>One protocol, three surfaces: every MCP tool is also a REST route and a CLI verb with the same name and payload.</li>
        <li>Every response ends with <code>nextSteps</code>; every error carries a stable <code>code</code> and a <code>hint</code>. Agents follow, they do not guess.</li>
        <li>Peer notes are delivered as labelled, untrusted data. Nothing another agent writes can trigger a tool.</li>
      </ul></div>
      <div class="cmd" id="connectCmd"><div class="lbl">Connect Claude Code (write access needs a runner token in FLARE_TOKEN)</div><pre id="connectPre"></pre><button class="cp" id="connectCopy">copy</button></div>
      <div class="cmd" style="margin-top:8px"><div class="lbl">Watch read-only from your own Claude Code (no token)</div><pre id="watchPre"></pre><button class="cp" id="watchCopy">copy</button></div>
    </div>
    <div class="live">
      <div class="card"><h2>Agents on this repo <span class="r" id="agentsCount"></span></h2><div id="agentsList"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-goals">
    <div class="narr">
      <div class="kicker">Chapter 3 · Goals become intents</div>
      <h1>A human states a goal. The work is split into intents with footprints.</h1>
      <p>An intent is the unit of work: what will change, which paths, why, and the command that proves it. The planner proposes the split; a human approves plans that touch protected paths.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>The footprint is declared up front, so overlap is a set intersection, not a diff after the fact.</li>
        <li>The acceptance command rides with the intent, so a train knows how to verify it without a conversation.</li>
        <li>Goal → intent → commit → line is one chain, recorded as it happens, which is what makes <em>why</em> answerable later.</li>
      </ul></div>
    </div>
    <div class="live" id="goalsLive"></div>
  </section>

  <section class="ch" id="ch-declare">
    <div class="narr">
      <div class="kicker">Chapter 4 · Declare before you edit</div>
      <h1>Overlaps come back in milliseconds, before any code is written.</h1>
      <p><code>declare_intent</code> answers with every live intent whose footprint intersects yours. The agent reads the other side's reasoning, narrows its plan, or sends a note. Nothing is blocked; everything is known.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>Footprints live hot in a Durable Object per repo. "Who is touching <code>src/auth</code>?" is a map lookup, with zero git operations.</li>
        <li>Awareness scales with the number of overlapping changes, not with the number of agents polling.</li>
        <li>Drift is computed from every push: touching an undeclared file raises the risk score and alerts the owner.</li>
      </ul></div>
    </div>
    <div class="live">
      <div class="grid g3" id="declareStats"></div>
      <div class="card" style="margin-top:12px"><h2>Repository map <span class="r">one cell per directory, colored by state</span></h2><div class="map" id="cellMap"></div>
        <div class="legend"><span><i style="background:var(--st-working)"></i>working</span><span><i style="background:var(--st-overlap)"></i>overlap</span><span><i style="background:var(--st-conflict)"></i>conflict</span><span><i style="background:var(--st-human)"></i>needs a human</span><span><i style="background:var(--st-landed)"></i>landed</span></div></div>
      <div class="card"><h2>Live overlaps <span class="r" id="overlapCount"></span></h2><div id="overlapList"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-forks">
    <div class="narr">
      <div class="kicker">Chapter 5 · A fork per intent</div>
      <h1>Claiming an intent forks trunk. The agent gets a one-hour token for its own fork only.</h1>
      <p>Work happens in <code>i-&lt;id&gt;</code>, an Artifacts fork of trunk. The agent pushes with plain git and reports the SHA; Forge verifies it on the fork, computes the actual footprint, and scores the risk.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>Artifacts issues repo-scoped tokens from the Worker, so a stolen agent token can at most rewrite that agent's own fork.</li>
        <li>Declared versus actual footprint is a diff Forge computes itself; agents cannot lie about what they touched.</li>
        <li>The risk score is deterministic and explainable: named terms with points, never a bare model number.</li>
      </ul></div>
    </div>
    <div class="live"><div class="card"><h2>Intents and their forks <span class="r" id="forksCount"></span></h2><div id="forksList"></div></div></div>
  </section>

  <section class="ch" id="ch-trains">
    <div class="narr">
      <div class="kicker">Chapter 6 · Trains verify the exact SHA</div>
      <h1>Ready intents ride trains. CI runs on the merged commit, and trunk only moves to a green one.</h1>
      <p>Ready intents are cut into lanes of non-overlapping footprints, stacked speculatively, and each lane head gets its own CI run. The longest green prefix lands the moment it is green; a red lane is bisected out while the lanes behind it rebuild.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>No global lock: lanes run in parallel and stack on each other's heads instead of queueing.</li>
        <li><code>main</code> is never red by construction: it only ever moves to a SHA whose own run passed.</li>
        <li>Semantic conflicts, where two changes pass alone and fail together, are caught because the <em>combined</em> SHA is what CI sees.</li>
      </ul></div>
    </div>
    <div class="live">
      <div class="grid g3" id="trainStats"></div>
      <div class="card" style="margin-top:12px"><h2>Trains <span class="r" id="trainsCount"></span></h2><div id="trainsList"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-conflicts">
    <div class="narr">
      <div class="kicker">Chapter 7 · Conflicts are replayed</div>
      <h1>A merge conflict is not a wall. It is claimable work, with the other side's reasoning attached.</h1>
      <p>When a train drops an intent on a real conflict, the intent is replayed on the new trunk: by its own agent, by the AI resolver, or by a resolution race of several attempts. Whatever wins must pass CI again before it lands.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>Replay re-derives the change from its intent and the landed side's <em>why</em>, instead of merging hunks blindly.</li>
        <li>An LLM resolution adds a risk term, so a replayed change can be routed to a human by policy.</li>
        <li>Every attempt is verified as its own exact SHA; a wrong resolution cannot land.</li>
      </ul></div>
    </div>
    <div class="live"><div class="card"><h2>Conflicts <span class="r" id="conflictsCount"></span></h2><div id="conflictsList"></div></div></div>
  </section>

  <section class="ch" id="ch-inbox">
    <div class="narr">
      <div class="kicker">Chapter 8 · What a human reviews</div>
      <h1>Policy routes every verified intent: auto-land, an audit sample, or a person.</h1>
      <p>Low-risk work lands itself. A sample is audited after the fact. Protected paths need a plan approved before any work starts, and anything over the risk bar waits here with its reasons.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>Risk is a sum of named terms (protected path, footprint size, drift, LLM replay), so the reviewer sees <em>why</em> it is here, not just a number.</li>
        <li>The policy is a file in trunk (<code>.flare/policy.yml</code>). Lowering the bar is a one-line change, not a redesign.</li>
        <li>Human time is measured per decision, so the cost of review is a number on this screen.</li>
      </ul></div>
    </div>
    <div class="live">
      <div class="grid g4" id="inboxStats"></div>
      <div class="card" style="margin-top:12px"><h2>Needs a human <span class="r" id="inboxNeedCount"></span></h2><div id="inboxList"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-why">
    <div class="narr">
      <div class="kicker">Chapter 9 · Why this line exists</div>
      <h1>Pick a line. Forge walks it back to the goal that asked for it.</h1>
      <p>Agent commits carry <code>Flare-Goal</code>, <code>Flare-Intent</code> and <code>Flare-Agent</code> trailers, and every landed train writes a <code>refs/notes/why</code> record. The chain is line → commit → intent → goal → reasoning → CI evidence → session.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>Provenance is written at landing time by the only writer of trunk, so it cannot be skipped or forged.</li>
        <li>The same answer is one MCP call (<code>why</code>) for any agent, so context survives the session that created it.</li>
        <li>Pre-Forge lines say so honestly: a human commit is reported as a human commit.</li>
      </ul></div>
      <div class="cmd" style="margin-top:14px"><div class="lbl">Ask from the CLI</div><pre id="whyCmd"></pre><button class="cp" id="whyCopy">copy</button></div>
    </div>
    <div class="live">
      <div class="card"><h2>Ask <span class="r"><input id="whyPath" type="text" placeholder="path:line" style="width:300px"> <button id="whyGo">why</button></span></h2>
        <div id="whyFiles" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px"></div>
        <div id="whyCode" class="code hidden"></div>
      </div>
      <div class="card"><h2>The chain <span class="r" id="whyMeta"></span></h2><div id="whyChain" class="chain"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-bill">
    <div class="narr">
      <div class="kicker">Chapter 10 · The Artifacts bill</div>
      <h1>Every Artifacts operation is counted from Cloudflare's own events and priced per landed change.</h1>
      <p>Artifacts bills operations. Forge subscribes to the account's Artifacts events (created, forked, pushed, cloned, fetched), attributes each to trunk, a lane, an intent or a replay, and keeps a ledger you can reconcile against Cloudflare's GraphQL dataset.</p>
      <div class="why"><div class="t">Why it works</div><ul>
        <li>Coordination questions are answered from a Durable Object, so git traffic grows with changes, not with agents or time.</li>
        <li>Server-side reads (<code>read_file</code>, <code>diff</code>, <code>history</code>) are content-addressed and cached, so agents rarely clone.</li>
        <li>The ledger is honest about what the price list does not say: reads and tokens are shown separately as an upper bound.</li>
      </ul></div>
      <div class="cmd" style="margin-top:14px"><div class="lbl">Check the ledger against Cloudflare's own count</div><pre>npm run forge:ops-reconcile</pre><button class="cp" data-copy="npm run forge:ops-reconcile">copy</button></div>
    </div>
    <div class="live">
      <div class="grid g3" id="billStats"></div>
      <div class="card" style="margin-top:12px"><h2>Operations by kind <span class="r" id="billSince"></span></h2><div id="billKinds"></div></div>
      <div class="card"><h2>Attributed to <span class="r">who caused the operation</span></h2><div id="billSubjects"></div></div>
      <div class="card"><h2>Pricing <span class="r" id="billPricing"></span></h2><div id="billPricingBody"></div></div>
    </div>
  </section>

  <section class="ch" id="ch-built">
    <div class="narr">
      <div class="kicker">Chapter 11 · How it is built</div>
      <h1>Workers, Artifacts, Durable Objects, Workflows, Queues, Workers AI, Containers. Nothing else.</h1>
      <p>One Worker serves the API, MCP and this page. Artifacts holds trunk and every fork and issues the scoped tokens. A Durable Object per repo answers coordination questions in memory. Workflows run pushes and trains. CI runs in containers or on any machine you pair.</p>
      <div class="cmd"><div class="lbl">Run the whole thing on your own account (about 15 minutes)</div><pre>git clone https://github.com/everyai-com/flare-forge && cd flare-forge
npm install && npm run setup
npm run forge:demo
npm run forge:agents -- --mode scripted --count 6</pre><button class="cp" data-copy="git clone https://github.com/everyai-com/flare-forge && cd flare-forge && npm install && npm run setup && npm run forge:demo && npm run forge:agents -- --mode scripted --count 6">copy</button></div>
    </div>
    <div class="live">
      <div class="card"><h2>The pieces</h2><ul class="arch" style="margin:0;padding-left:18px">
        <li><b>Artifacts</b>: trunk, one fork per intent, repo-scoped tokens minted by the Worker, account-level events feeding the ops ledger.</li>
        <li><b>Durable Objects</b>: the Coordinator (footprints, overlaps, leases, snapshot) and the Feed (live deltas to this page over WebSocket).</li>
        <li><b>Workflows</b>: the push workflow (verify the SHA on the fork, footprint, drift, risk) and the train workflow (lanes, CI, bisect, land, why notes).</li>
        <li><b>Queues + Containers</b>: CI jobs for trains, replays and races, executed in container seats or on paired runners.</li>
        <li><b>Workers AI</b>: the planner that splits goals, the replay resolver, and failure triage. Never a gate on its own: everything it proposes must pass CI.</li>
        <li><b>D1</b>: intents, goals, trains, conflicts, ledger, policy, sessions.</li>
      </ul></div>
      <div class="card"><h2>Links</h2><div id="builtLinks"></div></div>
    </div>
  </section>
</main>
<div id="ticker" aria-live="polite"></div>
<script>
(function () {
  "use strict";
  var qs = new URLSearchParams(location.search);
  var S = { repo: qs.get("repo") || "bookshelf", data: null, mode: "connecting", admin: false, authed: null, repos: null, prevStates: null, prevTrains: null, polls: 0, why: { path: "", line: 0, text: null }, playing: false, playTimer: null, lastAt: 0 };
  var CH = ["open", "repo", "agents", "goals", "declare", "forks", "trains", "conflicts", "inbox", "why", "bill", "built"];
  var TITLES = { open: "One repo, many agents", repo: "A repo on Artifacts", agents: "Agents connect", goals: "Goals become intents", declare: "Declare before you edit", forks: "A fork per intent", trains: "Trains verify the exact SHA", conflicts: "Conflicts are replayed", inbox: "What a human reviews", why: "Why this line exists", bill: "The Artifacts bill", built: "How it is built" };
  if (qs.get("stage") === "1") document.documentElement.classList.add("stage");

  // ---- DOM helpers (textContent only; API data never becomes markup) ----
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  function add(parent, child) { parent.appendChild(child); return child; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function byId(id) { return document.getElementById(id); }
  function short(sha) { return sha ? String(sha).slice(0, 8) : ""; }
  function ago(iso) { if (!iso) return ""; var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; }
  function money(n) { if (typeof n !== "number") return "–"; return "$" + (n < 0.1 ? n.toFixed(4) : n < 10 ? n.toFixed(2) : n.toFixed(0)); }
  function num(n, d) { if (typeof n !== "number") return "–"; return d ? n.toFixed(d) : String(n); }
  function pill(state, label) { var p = el("span", "pill " + (state || "")); add(p, el("span", "d")); add(p, el("span", null, label || state)); return p; }
  function chip(text, cls) { return el("span", "mono-chip" + (cls ? " " + cls : ""), text); }
  function riskCls(r) { return r <= 30 ? "low" : r <= 60 ? "med" : "high"; }
  function stat(label, value, meta, unit) { var s = el("div", "stat"); add(s, el("div", "l", label)); var v = add(s, el("div", "v num", value)); if (unit) add(v, el("small", null, unit)); if (meta) add(s, el("div", "m", meta)); return s; }
  function empty(parent, text, cmd) { var e = add(parent, el("div", "empty")); add(e, el("span", null, text + " ")); if (cmd) { add(e, el("b", "mono", cmd)); } return e; }
  function copyBtn(btn, text) { btn.addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(text()).then(function () { btn.textContent = "copied"; setTimeout(function () { btn.textContent = "copy"; }, 1200); }); }); }
  function ava(agent, on) { var a = el("span", "ava" + (on ? " on" : ""), label(agent)); a.title = agent; return a; }
  function label(id) { var parts = String(id || "").split(/[^A-Za-z0-9]+/).filter(Boolean); if (!parts.length) return "?"; if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase(); return (parts[0][0] + parts[parts.length - 1].slice(-1)).toUpperCase(); }

  // ---- rail ----
  var railList = byId("railList");
  CH.forEach(function (id, i) { var a = add(railList, el("a")); a.href = "#ch-" + id; a.dataset.ch = id; add(a, el("span", "n", String(i))); add(a, el("span", "t", TITLES[id])); add(a, el("span", "s")); });
  var io = new IntersectionObserver(function (entries) { entries.forEach(function (en) { if (en.isIntersecting) { var id = en.target.id.replace("ch-", ""); railList.querySelectorAll("a").forEach(function (a) { a.classList.toggle("cur", a.dataset.ch === id); }); } }); }, { rootMargin: "-40% 0px -55% 0px" });
  CH.forEach(function (id) { io.observe(byId("ch-" + id)); });
  function curIndex() { var a = railList.querySelector("a.cur"); return a ? CH.indexOf(a.dataset.ch) : 0; }
  function go(i) { i = Math.max(0, Math.min(CH.length - 1, i)); byId("ch-" + CH[i]).scrollIntoView({ behavior: "smooth", block: "start" }); }
  document.addEventListener("keydown", function (e) { if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return; if (e.key === "j" || e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(curIndex() + 1); } if (e.key === "k" || e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(curIndex() - 1); } if (e.key === "Home") { go(0); } if (e.key === "End") { go(CH.length - 1); } });
  var playBtn = byId("playBtn");
  function setPlay(on) { S.playing = on; playBtn.textContent = on ? "Pause" : "Play"; if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; } if (on) { var secs = Number(qs.get("play")) || 20; S.playTimer = setInterval(function () { var i = curIndex(); go(i >= CH.length - 1 ? 0 : i + 1); }, secs * 1000); } }
  playBtn.addEventListener("click", function () { setPlay(!S.playing); });
  if (qs.get("play")) setPlay(true);

  // ---- top bar ----
  var repoIn = byId("repoIn"); repoIn.value = S.repo;
  repoIn.addEventListener("change", function () { var v = repoIn.value.trim(); if (!v) return; var u = new URL(location.href); u.searchParams.set("repo", v); location.href = u.toString(); });
  byId("dashLink").href = "/dashboard#/live?repo=" + encodeURIComponent(S.repo);
  byId("watchLink").href = "/watch?repo=" + encodeURIComponent(S.repo);
  var origin = location.origin;
  var connectLine = "claude mcp add --transport http flare-forge " + origin + "/mcp --header \\"Authorization: Bearer $FLARE_TOKEN\\"";
  var watchLine = "claude mcp add --transport http flare-forge-watch " + origin + "/v1/public/forge/mcp";
  byId("connectPre").textContent = connectLine; copyBtn(byId("connectCopy"), function () { return connectLine; });
  byId("watchPre").textContent = watchLine; copyBtn(byId("watchCopy"), function () { return watchLine; });
  document.querySelectorAll("button.cp[data-copy]").forEach(function (b) { copyBtn(b, function () { return b.dataset.copy; }); });
  function setLive(mode, text) { var b = byId("liveBadge"); b.className = "live " + (mode === "on" ? "on" : mode === "err" ? "err" : ""); byId("liveText").textContent = text; }
  function banner(text, linkText, href) { var w = clear(byId("bannerWrap")); if (!text) return; var b = add(w, el("div")); b.id = "banner"; add(b, el("span", null, text + " ")); if (linkText) { var a = add(b, el("a", null, linkText)); a.href = href; } }

  // ---- data ----
  function getJson(url, cred) { return fetch(url, { credentials: cred ? "include" : "omit", headers: { Accept: "application/json" } }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); }); }
  function load() {
    var repo = encodeURIComponent(S.repo);
    var first = S.authed === false ? getJson("/v1/public/forge/story?repo=" + repo, false) : getJson("/v1/forge/story?repo=" + repo, true);
    return first.then(function (r) {
      if (r.status === 401 && S.authed !== false) { S.authed = false; return getJson("/v1/public/forge/story?repo=" + repo, false); }
      if (r.status === 200 && S.authed !== false) S.authed = true;
      return r;
    }).then(function (r) {
      S.polls++;
      if (r.status === 200 && r.body && r.body.snapshot) {
        S.data = r.body; S.lastAt = Date.now(); S.mode = S.authed ? "signed in" : "spectator";
        setLive("on", "live · " + (S.authed ? "signed in" : "read-only") + " · updated just now");
        byId("modeText").textContent = S.authed ? (S.admin ? "admin" : "signed in") : "spectator (read-only)";
        banner("");
        render();
      } else if (r.status === 404 && !S.authed) {
        setLive("err", "not public"); byId("modeText").textContent = "";
        banner("This repo is not open to spectators and you are not signed in. Sign in to tell its story, or open the public demo repo.", "Sign in", "/dashboard?next=" + encodeURIComponent("/story?repo=" + S.repo));
      } else if (r.status === 429) { setLive("err", "rate limited, retrying"); }
      else { var code = r.body && r.body.code ? String(r.body.code) : String(r.status); setLive("err", "error " + code); banner((r.body && r.body.hint) ? String(r.body.hint) : "Could not load the repo. " + code, "Open the dashboard", "/dashboard"); }
    }).catch(function () { setLive("err", "offline, retrying"); });
  }
  function loadExtras() {
    if (S.authed !== true) return;
    getJson("/v1/repos?limit=50", true).then(function (r) { if (r.status === 200 && r.body && Array.isArray(r.body.repos)) { S.repos = r.body.repos; renderRepos(); } });
    getJson("/v1/admin/status", true).then(function (r) { if (r.status === 200 && r.body && r.body.user) { S.admin = !!r.body.user.admin; byId("modeText").textContent = S.admin ? "admin" : "signed in"; renderInbox(); } });
  }
  setInterval(function () { if (S.lastAt) { var s = Math.round((Date.now() - S.lastAt) / 1000); if (S.mode !== "connecting" && byId("liveBadge").classList.contains("on")) byId("liveText").textContent = "live · " + (S.authed ? "signed in" : "read-only") + " · updated " + (s < 2 ? "just now" : s + "s ago"); } }, 1000);
  load().then(loadExtras);
  setInterval(load, 3000);
  setInterval(loadExtras, 20000);

  // ---- derived ----
  function intentsAll() { var d = S.data; var list = (d.intents && Array.isArray(d.intents.intents)) ? d.intents.intents : []; return list; }
  function intentById() { var m = {}; intentsAll().forEach(function (i) { m[i.id] = i; }); (S.data.snapshot.intents || []).forEach(function (i) { if (!m[i.id]) m[i.id] = i; }); return m; }
  function goalText(id) { var g = (S.data.goals && S.data.goals.goals || []).filter(function (x) { return x.id === id; })[0]; return g ? g.text : ""; }
  function stateCount(list) { var c = {}; list.forEach(function (i) { c[i.state] = (c[i.state] || 0) + 1; }); return c; }

  // ---- render ----
  function render() {
    renderOpen(); renderRepo(); renderAgents(); renderGoals(); renderDeclare(); renderForks(); renderTrains(); renderConflicts(); renderInbox(); renderWhyDefaults(); renderBill(); renderBuilt(); renderRail(); diffEvents();
  }
  function renderRail() {
    var d = S.data, c = d.snapshot.counters || {};
    var need = d.inbox && d.inbox.metrics ? (d.inbox.metrics.needs_you || 0) : 0;
    railList.querySelectorAll("a").forEach(function (a) { var s = a.querySelector(".s"); s.className = "s"; var id = a.dataset.ch;
      if ((id === "declare" || id === "forks" || id === "open") && (c.intents || 0) > 0) s.classList.add("on");
      if (id === "trains" && d.snapshot.track && d.snapshot.track.current) s.classList.add("on");
      if (id === "conflicts" && (c.conflicts_open || 0) > 0) s.classList.add("need");
      if (id === "inbox" && need > 0) s.classList.add("need");
    });
  }
  function renderOpen() {
    var d = S.data, c = d.snapshot.counters || {};
    var g = clear(byId("openStats"));
    add(g, stat("Agents active", num(c.agents), (d.agents && d.agents.agents ? d.agents.agents.length : 0) + " seen on this repo"));
    add(g, stat("Intents live", num(c.intents), (c.overlaps_caught || 0) + " overlaps caught at declare"));
    add(g, stat("Landed today", num(c.landed_today), "through CI-verified trains"));
    add(g, stat("Main red", num(c.main_red_minutes), "by construction", "min"));
    byId("openNow").textContent = "head " + short(d.snapshot.headSha) + " · " + ago(d.snapshot.generatedAt || d.generatedAt);
    var box = clear(byId("openDots"));
    var dots = d.snapshot.dots || [];
    if (!dots.length) { empty(box, "No intent is live right now. The record below stays; a swarm fills this in seconds:", "npm run forge:agents -- --mode scripted --count 6"); return; }
    var map = intentById();
    dots.slice(0, 12).forEach(function (x) { var i = map[x.intent] || {}; var r = add(box, el("div", "row")); add(r, ava(x.agent, x.state === "working" || x.state === "claimed")); var t = add(r, el("div", "t")); add(t, el("div", null, i.title || x.intent)); add(t, el("div", "sub mono", x.path)); add(r, pill(x.state)); });
  }
  function renderRepo() {
    var d = S.data; var box = clear(byId("repoCard"));
    var r = add(box, el("div", "row")); var t = add(r, el("div", "t")); add(t, el("div", null, (d.namespace ? d.namespace + "/" : "") + d.repo)); add(t, el("div", "sub", "Artifacts namespace " + (d.namespace || "(this deployment's)") + " · trunk main"));
    add(r, chip("head " + short(d.snapshot.headSha)));
    if (d.remote) { var r2 = add(box, el("div", "row")); var t2 = add(r2, el("div", "t")); add(t2, el("div", "sub", "git remote (trunk, read-only to agents)")); add(t2, el("div", "mono", d.remote)); }
    var r3 = add(box, el("div", "row")); var t3 = add(r3, el("div", "t"));
    var mine = (S.repos || []).filter(function (x) { return x.name === d.repo; })[0];
    if (mine && mine.source) { add(t3, el("div", null, "Imported from GitHub")); add(t3, el("div", "sub mono", String(mine.source).replace(/^git:/, ""))); }
    else { add(t3, el("div", null, "Created on Artifacts and pushed with plain git")); add(t3, el("div", "sub", "npm run forge:demo: create the repo, push trunk, 32 lane refs and refs/notes/why, record three goals")); }
    var p = d.snapshot.policy || {}; var r4 = add(box, el("div", "row")); var t4 = add(r4, el("div", "t")); add(t4, el("div", null, "Policy (.flare/policy.yml in trunk)")); add(t4, el("div", "sub", "auto-land up to risk " + num(p.autoLandMaxRisk) + " · audit sample " + Math.round((p.auditSample || 0) * 100) + "% · protected: " + ((p.protected || []).join(", ") || "none")));
    byId("repoHeadAt").textContent = d.snapshot.head && d.snapshot.head.at ? ago(d.snapshot.head.at) : "";
    renderRepos();
  }
  function renderRepos() {
    var box = clear(byId("reposList"));
    if (S.authed !== true) { empty(box, "Spectators see one repo. Sign in to list every repo in the namespace, including ones imported from GitHub."); byId("reposCount").textContent = ""; return; }
    if (!S.repos) { empty(box, "Loading…"); return; }
    byId("reposCount").textContent = S.repos.length + " repos";
    if (!S.repos.length) { empty(box, "No repos yet. Create the demo trunk:", "npm run forge:demo"); return; }
    S.repos.slice(0, 12).forEach(function (x) { var r = add(box, el("div", "row")); var t = add(r, el("div", "t")); var a = add(t, el("a", null, x.name)); a.href = "/story?repo=" + encodeURIComponent(x.name); a.style.textDecoration = "none"; add(t, el("div", "sub", x.source ? "imported from " + String(x.source).replace(/^git:/, "") : "created on Artifacts" + (x.updatedAt ? " · " + ago(x.updatedAt) : ""))); add(r, pill(x.name === S.data.repo ? "landed" : "idle", x.name === S.data.repo ? "this story" : (x.defaultBranch || "main"))); });
  }
  function renderAgents() {
    var d = S.data; var box = clear(byId("agentsList"));
    var list = d.agents && Array.isArray(d.agents.agents) ? d.agents.agents : (d.snapshot.agents || []);
    byId("agentsCount").textContent = list.length ? list.length + " agents" : "";
    if (!list.length) { empty(box, "No agent has touched this repo yet. Connect one with the command on the left, or run the scripted swarm:", "npm run forge:agents -- --mode scripted --count 6"); return; }
    list.slice(0, 12).forEach(function (a) { var r = add(box, el("div", "row")); add(r, ava(a.id, (a.active || 0) > 0)); var t = add(r, el("div", "t")); add(t, el("div", null, a.id + (a.client && a.client !== "agent" ? " · " + a.client : ""))); add(t, el("div", "sub", a.intent_title ? "working on: " + a.intent_title : (a.last_at ? "last seen " + ago(a.last_at) : ""))); add(r, chip((a.landed || 0) + " landed · " + (a.landed_today || 0) + " today")); add(r, pill((a.active || 0) > 0 ? "working" : "idle", (a.active || 0) > 0 ? "working" : "idle")); });
  }
  function renderGoals() {
    var d = S.data; var box = clear(byId("goalsLive"));
    var goals = d.goals && Array.isArray(d.goals.goals) ? d.goals.goals : [];
    var ints = intentsAll();
    if (!goals.length) { var c = add(box, el("div", "card")); add(c, el("h2", null, "Goals")); empty(c, "No goal recorded yet. Seed three with", "npm run forge:demo"); return; }
    goals.forEach(function (g) {
      var mine = ints.filter(function (i) { return i.goalId === g.id; });
      var c = add(box, el("div", "card")); var h = add(c, el("h2", null, "Goal")); add(h, el("span", "r", mine.length + " intents"));
      add(c, el("div", null, g.text)).style.marginBottom = "8px";
      var sc = stateCount(mine); var bar = add(c, el("div", "bar")); var tot = mine.length || 1;
      [["landed", "var(--st-landed)"], ["in_train", "var(--st-train)"], ["ready", "var(--st-train)"], ["working", "var(--st-working)"], ["claimed", "var(--st-working)"], ["replaying", "var(--st-overlap)"], ["conflicted", "var(--st-conflict)"], ["awaiting_plan", "var(--st-human)"], ["draft", "var(--st-idle)"]].forEach(function (p) { if (sc[p[0]]) { var i = add(bar, el("i")); i.style.width = (100 * sc[p[0]] / tot) + "%"; i.style.background = p[1]; } });
      mine.slice(0, 8).forEach(function (i) { var r = add(c, el("div", "row")); add(r, ava(i.agent, i.state === "working" || i.state === "claimed")); var t = add(r, el("div", "t")); add(t, el("div", null, i.title)); var fp = (i.footprint && (i.footprint.paths || i.footprint.declared)) || []; add(t, el("div", "sub mono", fp.join("  ") + (i.accept ? "   · accept: " + i.accept : ""))); add(r, el("span", "risk num " + riskCls(i.risk || 0), "risk " + num(i.risk))); add(r, pill(i.state)); });
      if (mine.length > 8) add(c, el("div", "empty", "+ " + (mine.length - 8) + " more"));
    });
  }
  function renderDeclare() {
    var d = S.data, c = d.snapshot.counters || {};
    var g = clear(byId("declareStats"));
    add(g, stat("Overlaps caught", num(c.overlaps_caught), "at declare time, before any edit"));
    add(g, stat("Open conflicts", num(c.conflicts_open), "real merge conflicts right now"));
    add(g, stat("Answer source", d.snapshot.source === "coordinator" ? "DO" : "D1", d.snapshot.source === "coordinator" ? "Durable Object, in memory, zero git ops" : "database fallback"));
    var map = clear(byId("cellMap")); var cells = d.snapshot.cells || [];
    if (!cells.length) { empty(map, "The map fills as intents declare footprints."); }
    cells.slice(0, 24).forEach(function (x) { var cell = add(map, el("div", "cell " + (x.state || "idle"))); add(cell, el("div", "p", x.path + (x.protected ? " 🔒" : ""))); add(cell, el("div", "s", (x.intents ? x.intents.length : 0) + " intent" + ((x.intents || []).length === 1 ? "" : "s") + " · " + (x.state || "idle") + (x.overlap_with && x.overlap_with.length ? " · overlaps " + x.overlap_with.length : ""))); });
    var ol = clear(byId("overlapList")); var ovs = d.snapshot.overlaps || []; var byIdm = intentById();
    byId("overlapCount").textContent = ovs.length ? ovs.length + " live" : "";
    if (!ovs.length) { empty(ol, "No two live intents overlap right now. " + ((c.overlaps_caught || 0) > 0 ? (c.overlaps_caught + " were caught earlier in this repo and settled by notes before any code was written.") : "")); return; }
    ovs.slice(0, 8).forEach(function (o) { var a = byIdm[o.a] || {}, b = byIdm[o.b] || {}; var v = add(ol, el("div", "vs")); v.style.padding = "8px 0"; var sa = add(v, el("div", "side")); add(sa, el("div", "t", a.title || o.a)); add(sa, el("div", "sub", a.agent || "")); add(v, el("div", "x", "◐")); var sb = add(v, el("div", "side")); add(sb, el("div", "t", b.title || o.b)); add(sb, el("div", "sub", b.agent || "")); var p = add(ol, el("div", "sub mono", "shared: " + (o.paths || []).join(", "))); p.style.marginBottom = "6px"; });
  }
  function renderForks() {
    var box = clear(byId("forksList")); var ints = intentsAll().filter(function (i) { return i.forkRepo || i.headSha; });
    byId("forksCount").textContent = ints.length ? ints.length + " forks" : "";
    if (!ints.length) { empty(box, "No intent has been claimed yet. Claiming forks trunk:", "npx flare-forge-cli forge claim <intentId> --clone"); return; }
    ints.slice(0, 10).forEach(function (i) { var r = add(box, el("div", "row")); add(r, ava(i.agent, i.state === "working")); var t = add(r, el("div", "t")); add(t, el("div", null, i.title)); var sub = add(t, el("div", "sub")); add(sub, chip(i.forkRepo || "fork pending")); add(sub, el("span", null, " ")); if (i.headSha) add(sub, chip("head " + short(i.headSha))); add(sub, el("span", null, " ")); if (i.landedSha) add(sub, chip("landed " + short(i.landedSha))); var fp = i.footprint || {}; var declared = fp.declared || fp.paths || [], actual = fp.actual || [], drift = fp.drift || []; add(sub, el("span", "sub", "  declared " + declared.length + " · actual " + actual.length)); drift.forEach(function (p) { add(sub, el("span", null, " ")); add(sub, chip("drift " + p, "drift")); }); var terms = add(t, el("div")); (i.riskTerms || i.risk_terms || []).forEach(function (tm) { var e = add(terms, el("span", "term")); add(e, el("b", null, "+" + (tm.points || tm.weight || 0))); add(e, el("span", null, tm.term + (tm.detail ? " · " + tm.detail : ""))); }); add(r, el("span", "risk num " + riskCls(i.risk || 0), "risk " + num(i.risk))); add(r, pill(i.state)); });
  }
  function renderTrains() {
    var d = S.data, c = d.snapshot.counters || {}; var trains = d.trains && Array.isArray(d.trains.trains) ? d.trains.trains : [];
    var g = clear(byId("trainStats")); var landed = trains.filter(function (t) { return t.state === "landed"; }).length; var red = trains.filter(function (t) { return t.state === "failed" || t.state === "aborted"; }).length;
    add(g, stat("Landed today", num(c.landed_today), "intents on main via trains"));
    add(g, stat("Recent trains", String(trains.length), landed + " landed · " + red + " red lanes bisected"));
    add(g, stat("Main red", num(c.main_red_minutes), "trunk only moves to a green SHA", "min"));
    var box = clear(byId("trainsList")); byId("trainsCount").textContent = d.snapshot.track && d.snapshot.track.current ? "one running now" : "";
    if (!trains.length) { empty(box, "No train yet. A train is cut as soon as an intent is marked ready:", "npx flare-forge-cli forge ready <intentId>"); return; }
    var map = intentById();
    trains.slice(0, 8).forEach(function (t) { var r = add(box, el("div", "row")); r.style.display = "block"; var head = add(r, el("div")); head.style.display = "flex"; head.style.gap = "10px"; head.style.alignItems = "center"; add(head, chip("lane " + t.lane)); var tt = add(head, el("div", "t")); add(tt, el("div", null, (t.intentIds || []).map(function (id) { return map[id] ? map[id].title : id; }).join(" + ") || "(empty train)")); add(tt, el("div", "sub mono", "base " + short(t.baseSha) + " → head " + short(t.headSha || "") + (t.runId ? " · CI run " + short(t.runId) : "") + (t.duration_s ? " · " + t.duration_s + " s" : "") + " · " + ago(t.updatedAt))); add(head, pill(t.state)); var lanes = t.lanes || []; lanes.slice(0, 1).forEach(function (ln) { var st = ln.stages || {}; var steps = add(r, el("div", "steps")); steps.style.marginTop = "8px"; [["merge", st.merge], ["push", st.push], ["ci", st.ci && st.ci.status], ["land", st.cas]].forEach(function (p) { var s = add(steps, el("div", "st " + (p[1] === "done" || p[1] === "success" ? "done" : p[1] === "failed" || p[1] === "failure" ? "failed" : p[1] === "running" || p[1] === "pending" ? "running" : ""), p[0] + (p[1] ? " · " + p[1] : ""))); }); }); if (t.result && typeof t.result.landed === "number") add(r, el("div", "sub", "result: " + t.result.landed + " landed" + (t.result.requeued ? ", " + t.result.requeued + " requeued for the next train" : ""))).style.marginTop = "6px"; });
  }
  function renderConflicts() {
    var d = S.data; var box = clear(byId("conflictsList")); var list = d.conflicts && Array.isArray(d.conflicts.conflicts) ? d.conflicts.conflicts : []; var map = intentById();
    byId("conflictsCount").textContent = list.length ? list.filter(function (c) { return c.state === "open" || c.state === "claimed"; }).length + " open · " + list.filter(function (c) { return c.state === "resolved"; }).length + " resolved" : "";
    if (!list.length) { empty(box, "No merge conflict so far. Two intents editing the same lines of one file will open one here, and the resolver replays the dropped side on the new trunk."); return; }
    list.slice(0, 6).forEach(function (cf) { var a = map[cf.intentA] || {}, b = map[cf.intentB] || {}; var w = add(box, el("div")); w.style.padding = "8px 0"; w.style.borderTop = "1px solid var(--line)"; var v = add(w, el("div", "vs")); var sa = add(v, el("div", "side")); add(sa, el("div", "t", a.title || cf.intentA)); add(sa, el("div", "sub", a.agent || "")); add(v, el("div", "x", "✕")); var sb = add(v, el("div", "side")); add(sb, el("div", "t", b.title || cf.intentB)); add(sb, el("div", "sub", b.agent || "")); var f = add(w, el("div", "sub")); f.style.marginTop = "6px"; add(f, el("span", null, "files: ")); (cf.files || []).forEach(function (p) { add(f, chip(p)); add(f, el("span", null, " ")); }); add(f, el("span", null, " · ")); add(f, pill(cf.state === "claimed" ? "claimed-c" : cf.state, cf.state)); if (cf.resolverAgent) { add(f, el("span", null, "  resolved by " + cf.resolverAgent + (cf.attempts ? " in " + cf.attempts + " attempt" + (cf.attempts === 1 ? "" : "s") : ""))); } if (cf.resolutionSha) { add(f, el("span", null, " ")); add(f, chip("resolution " + short(cf.resolutionSha))); } });
  }
  function renderInbox() {
    var d = S.data; if (!d) return; var inbox = d.inbox; var g = clear(byId("inboxStats")); var box = clear(byId("inboxList"));
    if (!inbox) { empty(box, "Inbox unavailable."); return; }
    var m = inbox.metrics || {};
    add(g, stat("Needs you", num(m.needs_you), "plan approvals + escalations"));
    add(g, stat("Auto-landed", num(m.auto_landed !== undefined ? m.auto_landed : m.auto), "risk ≤ " + num(m.policy ? m.policy.auto_land_max_risk : (inbox.policy || {}).autoLandMaxRisk)));
    add(g, stat("Audit sample", m.sample ? m.sample.count + "/" + m.sample.of : num(m.sample), Math.round((m.sample_rate || 0) * 100) + "% of auto-landed, reviewed after"));
    add(g, stat("Human time today", num(Math.round((m.human_seconds_today || 0) / 60)), "minutes spent deciding", "min"));
    var items = []; (inbox.groups || []).forEach(function (grp) { (grp.items || []).forEach(function (it) { items.push({ it: it, goal: grp.goal }); }); });
    var need = items.filter(function (x) { return x.it.bucket === "needs_you"; }); var rest = items.filter(function (x) { return x.it.bucket !== "needs_you"; });
    byId("inboxNeedCount").textContent = need.length ? need.length + " waiting" : "";
    if (!items.length) { empty(box, "Nothing to review. Verified intents land themselves when their risk is under the policy bar."); return; }
    if (!need.length) empty(box, "Nothing needs a human right now. " + rest.length + " intents went through policy on their own.");
    need.concat(rest.slice(0, 4)).forEach(function (x) { var it = x.it, i = it.intent || {}; var r = add(box, el("div", "row")); r.style.display = "block"; var head = add(r, el("div")); head.style.display = "flex"; head.style.gap = "10px"; head.style.alignItems = "center"; add(head, ava(i.agent, false)); var t = add(head, el("div", "t")); add(t, el("div", null, i.title || i.id)); add(t, el("div", "sub", (it.why || it.reason || "") + (x.goal && x.goal.text ? " · goal: " + x.goal.text : ""))); add(head, el("span", "risk num " + riskCls(it.risk || 0), "risk " + num(it.risk))); add(head, pill(it.bucket === "needs_you" ? "human" : it.bucket === "sample" ? "overlap" : "landed", it.bucket === "needs_you" ? (it.reason === "plan" ? "approve plan" : "escalated") : it.bucket)); var terms = add(r, el("div")); terms.style.marginTop = "6px"; (it.terms || []).forEach(function (tm) { var e = add(terms, el("span", "term")); add(e, el("b", null, "+" + (tm.weight || tm.points || 0))); add(e, el("span", null, tm.term + (tm.detail ? " · " + tm.detail : ""))); }); if (it.bucket === "needs_you" && it.approve && it.approve.endpoint) { var act = add(r, el("div")); act.style.marginTop = "8px"; if (S.admin) { var b = add(act, el("button", "primary", it.approve.kind === "plan" ? "Approve plan" : "Approve landing")); b.addEventListener("click", function () { b.disabled = true; b.textContent = "approving…"; fetch(it.approve.endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { if (res.status < 300) { b.textContent = "approved"; toast("human", "You approved: " + (i.title || i.id)); load(); } else { b.disabled = false; b.textContent = "retry: " + (j.code || res.status); } }); }); }); add(act, el("span", "sub", "  one click; the decision is recorded with your account and timed")); } else { add(act, el("span", "sub", "Approval is an admin button in the signed-in dashboard; spectators watch it happen.")); } } });
  }
  // ---- why ----
  var whyPath = byId("whyPath"), whyGo = byId("whyGo"), whyFiles = byId("whyFiles"), whyCode = byId("whyCode"), whyChain = byId("whyChain"), whyMeta = byId("whyMeta"), whyCmd = byId("whyCmd");
  copyBtn(byId("whyCopy"), function () { return whyCmd.textContent; });
  function whyUrl(path, line) { var q = "?repo=" + encodeURIComponent(S.repo) + "&path=" + encodeURIComponent(path) + (line ? "&line=" + line : ""); return (S.authed ? "/v1/forge/why" : "/v1/public/forge/why") + q; }
  function renderWhyDefaults() {
    var ints = intentsAll().filter(function (i) { return i.state === "landed"; }); var files = []; ints.forEach(function (i) { ((i.footprint && (i.footprint.actual || i.footprint.paths)) || []).forEach(function (p) { if (files.indexOf(p) === -1 && !/test\\//.test(p)) files.push(p); }); });
    if (whyFiles.dataset.sig === files.join("|")) return; whyFiles.dataset.sig = files.join("|");
    clear(whyFiles);
    files.slice(0, 8).forEach(function (p) { var b = add(whyFiles, el("button", null, p)); b.className = "mono"; b.addEventListener("click", function () { pickFile(p); }); });
    if (!files.length) { add(whyFiles, el("span", "sub", "Files landed by intents appear here once a train lands.")); }
    if (!S.why.path && files.length) pickFile(files[0]);
  }
  function pickFile(p) {
    S.why.path = p; S.why.line = 0; whyPath.value = p; clear(whyChain); whyMeta.textContent = "finding a line this intent wrote…"; whyCode.classList.add("hidden");
    if (S.authed) {
      getJson("/v1/forge/read?repo=" + encodeURIComponent(S.repo) + "&path=" + encodeURIComponent(p), true).then(function (r) { if (r.status === 200 && r.body && typeof r.body.text === "string") { S.why.text = r.body.text; renderCode(); } probeLines(p, r.status === 200 && r.body && r.body.lines ? r.body.lines : 40); });
    } else probeLines(p, 40);
  }
  function probeLines(p, n) {
    var cand = []; for (var k = 1; k <= 6; k++) cand.push(Math.max(1, Math.round(n * k / 7)));
    Promise.all(cand.map(function (ln) { return getJson(whyUrl(p, ln), !!S.authed).then(function (r) { return { ln: ln, body: r.status === 200 ? r.body : null }; }, function () { return { ln: ln, body: null }; }); })).then(function (rs) { var hit = rs.filter(function (x) { return x.body && x.body.intent; })[0] || rs[0]; if (S.why.path !== p) return; S.why.line = hit.ln; whyPath.value = p + ":" + hit.ln; showWhy(hit.body, p, hit.ln); renderCode(); });
  }
  function renderCode() { if (S.why.text === null || !S.authed) { whyCode.classList.add("hidden"); return; } clear(whyCode); whyCode.classList.remove("hidden"); var lines = S.why.text.split("\\n"); lines.slice(0, 400).forEach(function (txt, i) { var ln = add(whyCode, el("div", "ln" + (i + 1 === S.why.line ? " sel" : ""))); add(ln, el("span", "n", String(i + 1))); add(ln, el("span", null, txt || " ")); ln.addEventListener("click", function () { askWhy(S.why.path, i + 1); }); }); var sel = whyCode.querySelector(".ln.sel"); if (sel) whyCode.scrollTop = Math.max(0, sel.offsetTop - whyCode.clientHeight / 2); }
  function askWhy(p, ln) { S.why.path = p; S.why.line = ln; whyPath.value = p + ":" + ln; whyMeta.textContent = "asking…"; getJson(whyUrl(p, ln), !!S.authed).then(function (r) { showWhy(r.status === 200 ? r.body : null, p, ln); renderCode(); }, function () { showWhy(null, p, ln); }); }
  whyGo.addEventListener("click", function () { var v = whyPath.value.trim(); var m = /^(.+?)(?::(\\d+))?$/.exec(v); if (!m) return; var p = m[1], ln = Number(m[2] || 1); if (p !== S.why.path) { S.why.text = null; if (S.authed) { getJson("/v1/forge/read?repo=" + encodeURIComponent(S.repo) + "&path=" + encodeURIComponent(p), true).then(function (r) { if (r.status === 200 && r.body && typeof r.body.text === "string") { S.why.text = r.body.text; renderCode(); } }); } } askWhy(p, ln); });
  whyPath.addEventListener("keydown", function (e) { if (e.key === "Enter") whyGo.click(); });
  function showWhy(body, p, ln) {
    clear(whyChain); whyCmd.textContent = "npx flare-forge-cli forge why " + S.repo + " " + p + ":" + ln;
    if (!body) { whyMeta.textContent = "no answer"; empty(whyChain, "Could not read that line."); return; }
    whyMeta.textContent = (body.exact ? "exact line" : "nearest") + " · origin " + (body.origin || "?");
    var chain = body.chain || [];
    if (body.narrative) { var n = add(whyChain, el("div", "nd")); add(n, el("div", "k", "answer")); var b0 = add(n, el("div", "b")); add(b0, el("div", "x", body.narrative)); }
    chain.forEach(function (nd) { var row = add(whyChain, el("div", "nd")); add(row, el("div", "k", nd.kind)); var b = add(row, el("div", "b")); add(b, el("div", "t", nd.title || nd.id)); if (nd.text) add(b, el("div", "x", nd.text)); if (nd.id && nd.id !== nd.title) add(b, el("div", "sub mono", nd.id)); });
    if (!chain.length) empty(whyChain, (body.empty && body.empty.hint) || "No chain.");
  }
  // ---- bill ----
  function renderBill() {
    var d = S.data, ops = d.snapshot.ops || {}; var g = clear(byId("billStats"));
    add(g, stat("Ops per landed change", num(ops.perLandedChange, 1), ops.status === "measured" ? "measured from Artifacts events" : (ops.status || "")));
    add(g, stat("Billable ops", num(ops.billable), (ops.landed || 0) + " landed changes since " + (ops.since ? new Date(ops.since).toISOString().slice(0, 10) : "the ledger began")));
    add(g, stat("Cost so far", money(ops.usd), money(ops.usdPerLandedChange) + " per landed change at list price"));
    var kinds = clear(byId("billKinds")); byId("billSince").textContent = ops.total ? ops.total + " events total" : "";
    var ev = ops.events || {}, bd = ops.binding || {}; var rows = [];
    Object.keys(ev).forEach(function (k) { rows.push([k, ev[k], "billable Artifacts operation (event)"]); });
    Object.keys(bd).forEach(function (k) { rows.push([k === "cached" ? "read (served by cache)" : "binding " + k, bd[k], k === "cached" ? "not an Artifacts operation" : k === "fork" ? "billable" : "billing not documented; counted in the upper bound"]); });
    if (!rows.length) empty(kinds, "No Artifacts events yet. The ledger starts with the first push.");
    var mx = 1; rows.forEach(function (r) { if (r[1] > mx) mx = r[1]; });
    rows.sort(function (a, b) { return b[1] - a[1]; }).forEach(function (r) { var row = add(kinds, el("div", "row")); var t = add(row, el("div", "t")); add(t, el("div", "mono", r[0])); add(t, el("div", "sub", r[2])); var bar = add(t, el("div", "bar")); bar.style.marginTop = "4px"; var i = add(bar, el("i")); i.style.width = Math.max(2, 100 * r[1] / mx) + "%"; i.style.background = "var(--st-train)"; add(row, el("span", "num", String(r[1]))); });
    var subj = clear(byId("billSubjects")); var bs = ops.bySubject || {}; var tot = 0; Object.keys(bs).forEach(function (k) { tot += bs[k]; });
    if (!tot) empty(subj, "Nothing attributed yet."); else { var bar = add(subj, el("div", "bar")); var cols = { trunk: "var(--st-idle)", lane: "var(--st-train)", intent: "var(--st-working)", replay: "var(--st-overlap)" }; Object.keys(bs).forEach(function (k) { var i = add(bar, el("i")); i.style.width = (100 * bs[k] / tot) + "%"; i.style.background = cols[k] || "var(--st-landed)"; }); var lg = add(subj, el("div", "legend")); Object.keys(bs).forEach(function (k) { var s = add(lg, el("span")); var i = add(s, el("i")); i.style.background = cols[k] || "var(--st-landed)"; add(s, el("span", null, k + " " + bs[k])); }); }
    if (ops.upperBound) add(subj, el("div", "sub", "Upper bound if reads and tokens bill too: " + ops.upperBound.ops + " ops, " + money(ops.upperBound.usd) + ".")).style.marginTop = "8px";
    if (ops.projected && ops.projected.at10kChanges) add(subj, el("div", "sub", "Projected at 10,000 changes: " + ops.projected.at10kChanges.ops + " ops (" + money(ops.projected.at10kChanges.usd) + "). Agents that fetch every 30 s instead: " + ops.projected.at10kChanges.naiveOps + " ops (" + money(ops.projected.at10kChanges.naiveUsd) + ")."));
    var pr = ops.pricing || {}; byId("billPricing").textContent = pr.checked ? "checked " + pr.checked : ""; var pb = clear(byId("billPricingBody"));
    add(pb, el("div", null, "$" + num(pr.perThousandOps, 2) + " per 1,000 operations past " + (pr.freeOpsPerMonth || 0).toLocaleString() + " a month · $" + num(pr.perGbMonth, 2) + " per GB-month · billing from " + (pr.billingStarts || "?")));
    if (pr.source) { var a = add(pb, el("a", "sub", pr.source)); a.href = pr.source; a.rel = "noopener"; }
    if (ops.note) add(pb, el("div", "sub", ops.note)).style.marginTop = "6px";
  }
  function renderBuilt() {
    var box = byId("builtLinks"); if (box.dataset.done) return; box.dataset.done = "1";
    [["Live dashboard (signed in)", "/dashboard#/live?repo=" + encodeURIComponent(S.repo)], ["Spectator view (no sign-in)", "/watch?repo=" + encodeURIComponent(S.repo)], ["Public read-only MCP", "/v1/public/forge/mcp"], ["API reference", "/docs"], ["llms.txt (start here for agents)", "/llms.txt"], ["Source, MIT", "https://github.com/everyai-com/flare-forge"], ["Design rationale (first principles, spec, proof)", "https://github.com/everyai-com/flare-forge/blob/main/docs/COMPETITION-PLAN.md"]].forEach(function (l) { var r = add(box, el("div", "row")); var a = add(r, el("a", "t", l[0])); a.href = l[1]; a.style.textDecoration = "none"; add(r, el("span", "sub mono", l[1])); });
  }
  // ---- "just happened" ticker: diff intent and train states between polls ----
  function toast(kind, text) { var t = byId("ticker"); var e = add(t, el("div", "ev " + kind)); add(e, el("span", "d")); add(e, el("span", null, text)); while (t.children.length > 4) t.removeChild(t.firstChild); setTimeout(function () { if (e.parentNode) e.parentNode.removeChild(e); }, 9000); }
  function diffEvents() {
    var cur = {}; intentsAll().forEach(function (i) { cur[i.id] = { state: i.state, title: i.title, agent: i.agent }; });
    var trains = {}; ((S.data.trains && S.data.trains.trains) || []).forEach(function (t) { trains[t.id] = t.state; });
    if (S.prevStates) {
      Object.keys(cur).forEach(function (id) { var p = S.prevStates[id]; var c = cur[id]; if (!p) { toast("working", label(c.agent) + " declared: " + c.title); return; } if (p.state !== c.state) { var k = c.state === "landed" ? "landed" : c.state === "conflicted" || c.state === "replaying" ? "conflict" : c.state === "awaiting_plan" ? "human" : c.state === "in_train" || c.state === "ready" ? "train" : "working"; toast(k, label(c.agent) + " · " + c.title + " → " + c.state.replace(/_/g, " ")); } });
      Object.keys(trains).forEach(function (id) { var p = S.prevTrains[id]; if (p !== undefined && p !== trains[id]) toast(trains[id] === "landed" ? "landed" : trains[id] === "failed" || trains[id] === "aborted" ? "conflict" : "train", "train " + short(id) + " → " + trains[id]); if (p === undefined && S.polls > 1) toast("train", "train " + short(id) + " cut: " + trains[id]); });
    }
    S.prevStates = cur; S.prevTrains = trains;
  }
})();
</script>
</body>
</html>`;
