// The public landing at "/", for people who are not signed in.
const REPO = "https://github.com/humanagent/hush";
// Every number in the preview is invented and labelled as an example.

const GITHUB = `<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

// 30 days per example monitor: o = ok, d = degraded, s = skipped, . = no run
const EXAMPLE = [
  ["errors", "Operational", "ok", "oooooooooooooooooooooooooooooo", "100"],
  ["logs", "Operational", "ok", "ooooooooooooo.oooooooooooooooo", "100"],
  ["cost", "Operational", "ok", "oooooooooooooooooooooooooooooo", "100"],
  ["llm-traces", "Operational", "ok", "ooooodoooooooooooooooooooooooo", "96.7"],
  ["speed", "Chronically degraded", "bad", "oododddoddddoddddodddoddoddodd", "36.7"],
];

// Example spend for the costs section: 30 days per provider, and what each routine burned.
const COST_SRC = [["Claude Code", "#d97757"], ["AWS", "#5e6ad2"], ["Vercel", "#26b5ce"], ["Neon", "#4cb782"]];
const COST_DAYS = [...Array(30)].map((_, i) => [6 + 2.5 * Math.sin(i / 2.2) + (i % 7 === 3 ? 4 : 0) + (i > 22 ? 5 : 0), 9 + Math.sin(i / 4), 2 + (i % 5 === 0 ? 1.4 : 0.3), 1.2]);
const COST_ROUTINES = [
  ["/fix-issues", "daily", "31", "212M", "$118"],
  ["/monitor", "daily", "30", "96M", "$44"],
  ["/pr-review", "daily", "30", "71M", "$37"],
  ["/growth-report", "weekly", "4", "9M", "$6"],
];

// Example code merged per day for the code tile: thousands of lines added and deleted, quieter on weekends.
const MERGED_DAYS = [...Array(30)].map((_, i) => {
  const add = Math.max(8, 52 + 18 * Math.sin(i / 3.1) + i * 0.9 - (i % 7 === 5 || i % 7 === 6 ? 30 : 0));
  return [add, add * 0.24 + 4 * Math.cos(i / 2)];
});
const CODE = { prs: "3,218", agents: "91%", ci: "14,602", merge: "38 min", promos: "214" };

// Example runs for the live Actions tile, the same panel the topbar opens: name, what, step, steps done, steps, seconds in.
const LIVE = [
  ["/fix-issues", "Fix #4127: retry on 429", "Run regression test", 6, 9, 192],
  ["ci.yml", "PR #4131", "Unit tests", 3, 5, 74],
  ["/pr-review", "Review #4129", "Read the diff", 2, 6, 41],
];
const LIVE_NEXT = [
  ["deploy.yml", "main @ 9f3e2a1", "Build image", 0, 4],
  ["/triage", "12 new issues", "Read issues", 0, 5],
  ["e2e.yml", "PR #4133", "Start browsers", 0, 6],
  ["/monitor", "errors, logs, cost", "Read sources", 0, 7],
  ["ci.yml", "PR #4134", "Install", 0, 5],
];

// The 3D factory: one building per automation, sized by how much it runs. The degraded monitor glows.
const FACTORY = [
  ["/fix-issues", "routines", 1, "31 runs · 212M tokens"],
  ["/monitor", "routines", 0.7, "30 runs · 96M tokens"],
  ["/pr-review", "routines", 0.66, "30 runs · 71M tokens"],
  ["/triage", "routines", 0.45, "60 runs · 22M tokens"],
  ["/growth-report", "routines", 0.3, "4 runs · 9M tokens"],
  ["errors", "monitors", 0.5, "daily · 100% ok"],
  ["logs", "monitors", 0.46, "daily · 100% ok"],
  ["cost", "monitors", 0.4, "daily · 100% ok"],
  ["llm-traces", "monitors", 0.5, "daily · 96.7% ok"],
  ["speed", "monitors", 0.55, "daily · 36.7% ok, degraded", 1],
  ["ci.yml", "ci", 0.8, "4,812 runs"],
  ["e2e.yml", "ci", 0.6, "1,904 runs"],
  ["deploy.yml", "ci", 0.5, "612 runs"],
  ["nightly.yml", "ci", 0.3, "30 runs"],
];

// What Hush connects to today: the four platforms first, the rest in one line under them.
const LOGO_GH = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#fff" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const LOGO_VERCEL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M12 3l10 17.5H2z"/></svg>`;
const INTEGRATIONS = [
  ["github", "#24292f", LOGO_GH, "GitHub", "Repos, pull requests, issues, checks and every Actions workflow, live, through a read-only GitHub App."],
  ["aws", "#232f3e", `<span class="wm">aws</span>`, "AWS", "Daily spend by service from Cost Explorer, the cost explorer and the city map. Sent by your own cost job."],
  ["fly", "#7b3fe4", `<img src="https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/flydotio.svg" alt="" style="filter:invert(1)">`, "Fly.io", "Daily spend next to everything else, and heartbeats from the machines and jobs you run there."],
  ["vercel", "#000000", LOGO_VERCEL, "Vercel", "Daily spend per project, and heartbeats from your deploys and crons."],
];

export function landingPage({ install, msg, esc, css, fonts, icon, mark, stars = null, viewer = null }) {
  // signed in (only reachable at /landing): every way in goes to the repos instead of to sign-in
  const enter = viewer ? `<a class="signin enter" href="/">Enter →</a>` : `<a class="signin" href="/auth/login">Sign in</a>`;
  const bars = (s) => [...s].map((c) => `<i data-s="${{ o: "ok", d: "degraded", s: "skipped", ".": "" }[c]}"></i>`).join("");
  const rows = EXAMPLE.map(
    ([id, label, st, days, pct]) => `<div class="row">
      <div class="row-head"><span class="name"><span class="mon-id">${id}</span><small>daily</small></span><span class="state" data-s="${st}">${label}</span></div>
      <div class="bars">${bars(days)}</div>
      <div class="axis"><span>30 days ago</span><span class="rule"></span><span>${pct}% ok</span><span class="rule"></span><span>today</span></div>
    </div>`,
  ).join("");

  const maxDay = Math.max(...COST_DAYS.map((d) => d.reduce((a, b) => a + b, 0)));
  const costCols = COST_DAYS.map((d) => `<div class="cc">${d.map((v, i) => `<i style="height:${(v / maxDay) * 100}%;background:${COST_SRC[i][1]}"></i>`).join("")}</div>`).join("");
  const totals = COST_SRC.map(([n, c], i) => [n, c, COST_DAYS.reduce((a, d) => a + d[i], 0)]);

  // bento tiles around the status page
  const kl = (k) => (k >= 1000 ? (k / 1000).toFixed(2).replace(/0$/, "") + "M" : Math.round(k) + "k");
  const addT = MERGED_DAYS.reduce((a, d) => a + d[0], 0), delT = MERGED_DAYS.reduce((a, d) => a + d[1], 0);
  const maxA = Math.max(...MERGED_DAYS.map((d) => d[0])), maxD = Math.max(...MERGED_DAYS.map((d) => d[1]));
  const mergedCols = MERGED_DAYS.map(([a, d]) => `<div class="mc"><span class="up"><i style="height:${(a / maxA) * 100}%"></i></span><span class="dn"><i style="height:${(d / maxD) * 100}%"></i></span></div>`).join("");
  const monSmall = EXAMPLE.filter(([id]) => id !== "cost").map(([id, label, st, days, pct]) => `<div class="mt" data-s="${st}"><div class="mt-h"><span class="mon-id">${id}</span><span class="state" data-s="${st}">${st === "ok" ? "ok" : "degraded"}</span></div><b>${pct}%</b><div class="bars">${bars(days.slice(-14))}</div></div>`).join("");
  const SPIN = `<svg class="gi spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--warn)" stroke-opacity=".25" stroke-width="2.2"/><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="var(--warn)" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  const dur = (s) => (s >= 60 ? Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s" : s + "s");
  const liveRows = LIVE.map(([n, w, step, d, k, s]) => `<li class="lj" data-st="run"><span class="lj-i">${SPIN}</span><span class="lj-n"><b>${n}</b><small>${w}</small></span><span class="lj-s">${step} <em>${d}/${k}</em></span><span class="lj-t">${dur(s)}</span><span class="lj-bar"><i style="width:${Math.round((d / k) * 100)}%"></i></span></li>`).join("");

  const starLabel = stars == null ? "Star on GitHub" : `Star · ${stars >= 1000 ? (stars / 1000).toFixed(1).replace(/\.0$/, "") + "k" : stars}`;
  const cta = () => `<div class="lcta">
    ${viewer ? `<a class="lp pri" href="/">Open your repos →</a>` : `<a class="lp pri" href="${install}">${GITHUB}<span>Install on GitHub</span></a>`}
    <a class="lp alt" href="${REPO}" target="_blank" rel="noopener">${starLabel}</a>
  </div>`;

  // Line icons for the hero cards and the feature heads, drawn in the accent.
  const ICONS = {
    beat: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><circle cx="32" cy="32" r="20" class="o d"/><path d="M8 34h12l4-10 7 20 4-10h21" class="s"/></svg>`,
    cost: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><path d="M18 44V34M26 44V26M34 44V30M42 44V20M50 44V28" class="s"/><path d="M14 46h40" class="o"/></svg>`,
    flow: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><circle cx="18" cy="24" r="4" class="f"/><circle cx="46" cy="24" r="4" class="f"/><circle cx="32" cy="44" r="4" class="f"/><path d="M22 24h20M20 28l9 12M44 28l-9 12" class="s"/></svg>`,
    tok: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><ellipse cx="32" cy="22" rx="13" ry="5" class="s"/><path d="M19 22v10c0 2.8 5.8 5 13 5s13-2.2 13-5V22M19 32v10c0 2.8 5.8 5 13 5s13-2.2 13-5V32" class="s"/></svg>`,
    auto: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><circle cx="32" cy="32" r="20" class="o d"/><path d="M45 26a14 14 0 0 0-25-3M19 38a14 14 0 0 0 25 3" class="s"/><path d="M20 15v8h8M44 49v-8h-8" class="s"/></svg>`,
    doc: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><path d="M22 16h14l8 8v24H22z" class="s"/><path d="M28 32h10M28 39h10M28 25h4" class="s"/></svg>`,
    sm: (k) => ICONS[k].replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" width="18" height="18"'),
  };
  // The hero board: what to watch in an AI factory, as a control panel. Sparks are the last 14 days.
  const sp = (vals, st = []) => vals.map((v, i) => `<i style="height:${Math.round(12 + 88 * v)}%"${st[i] ? ` data-s="${st[i]}"` : ""}></i>`).join("");
  const wave = (n, f) => [...Array(14)].map((_, i) => Math.max(0.05, Math.min(1, f(i))));
  const BOARD = [
    ["#costs", "tok", "Tokens", "18.20M", "today · +6% on the week", "ok", sp(wave(14, (i) => 0.45 + 0.25 * Math.sin(i / 1.6) + i * 0.02))],
    ["#costs", "cost", "Costs", "$38.40", "1 price rule firing", "warn", sp(wave(14, (i) => 0.4 + 0.15 * Math.cos(i / 2) + (i === 13 ? 0.45 : 0)), [, , , , , , , , , , , , , "warn"])],
    ["#status", "auto", "Automations", "41 runs", "3 running now", "ok", sp(wave(14, (i) => 0.6 + 0.2 * Math.sin(i * 1.3)))],
    ["#status", "doc", "Reports", "sent 07:00", "2 things to look at", "warn", sp(Array(14).fill(0.7), [..."oooowoooooowow"].map((c) => (c === "w" ? "warn" : "ok")))],
    ["#status", "beat", "Monitors", "4 / 5 ok", "speed, degraded for weeks", "bad", sp(Array(14).fill(0.7), [...EXAMPLE[4][3].slice(-14)].map((c) => (c === "o" ? "ok" : "bad")))],
  ];
  let pd = "M0 60"; for (const x of [150, 520, 890, 1260]) pd += ` H${x} l14 -40 l22 84 l16 -44`; pd += " H1440";
  const PULSE = `<svg class="pulse" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true"><path class="pl-b" pathLength="1000" d="${pd}"/><path class="pl-g" pathLength="1000" d="${pd}"/></svg>`;
  const ARROW = `<svg viewBox="0 0 60 30" aria-hidden="true"><path d="M2 4c14 2 30 8 50 20M52 24l-9 1M52 24l-2-9"/></svg>`;


  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hush · AI native observability for automated developments</title>
<meta name="description" content="AI native observability for automated developments. Tokens, costs, automations, reports and monitors for high throughput automated repos. Every routine, run, token and dollar on one page.">
${icon}${fonts}
<style>${css}
/* Landing, night shift. The hero is the factory at night: city lights from above and the hush
   pulse running across it, a live board of what to watch on the right. Below, paper: the report's
   warm ground with a fine grid, mono eyebrows numbering each section, the product on top. */
:root{--night:#070b1c;--night2:#0d1330;--amber:#f0a35e;--orange:#f2702c;--paper:#f1efea;--paper2:#f8f6f1;--rule:#e3ded3;
--l-ink:#14161f;--l-muted:#5d5b56;--l-faint:#9a968d;--l-line:rgba(20,22,31,.1);
--l-ease:cubic-bezier(.05,.7,.1,1);--l-spring:cubic-bezier(.16,1,.3,1)}
html,body{background:var(--paper2)}
body.land{margin:0;color:var(--l-ink);font-family:var(--f);font-size:15px;letter-spacing:-.011em}
.land a{color:inherit}
.eb{display:inline-flex;align-items:center;gap:10px;font:500 11.5px var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--l-faint)}
.eb b{color:var(--orange);font-weight:500}

/* nav: a thin bar, clear over the night, solid night once you scroll, with the factory's state in it */
.lnav{position:fixed;inset:0 0 auto;z-index:10;display:flex;align-items:center;gap:20px;height:60px;padding:0 max(20px,calc((100vw - 1240px) / 2));color:#fff;transition:background .25s ease,box-shadow .25s ease}
.lnav .logo{font-size:18px;letter-spacing:-.03em;font-weight:600;color:inherit}.lnav .logo svg{color:var(--orange);width:22px;height:22px}
.lnav-st{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid rgba(255,255,255,.12);border-radius:6px;font:500 11.5px var(--mono);color:rgba(255,255,255,.7)}
.lnav-st i{width:7px;height:7px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 0 rgba(232,145,58,.6)}
@media (prefers-reduced-motion:no-preference){.lnav-st i{animation:lst 2s ease-out infinite}}@keyframes lst{to{box-shadow:0 0 0 7px rgba(232,145,58,0)}}
.lnav-r{display:flex;align-items:center;gap:2px;margin-left:auto}
.lnav-r a.t{padding:8px 11px;font-size:14px;text-decoration:none;color:rgba(255,255,255,.62)}.lnav-r a.t:hover{color:#fff}
.lnav .lp{min-height:36px;min-width:0;padding:0 14px;font-size:14px}
.lnav[data-s="1"]{background:rgba(7,11,28,.94);backdrop-filter:blur(14px);box-shadow:0 1px 0 rgba(255,255,255,.08)}

/* buttons: squared, amber on the night */
.lp{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:46px;padding:0 20px;border-radius:9px;box-sizing:border-box;font:600 14.5px/1 var(--f);letter-spacing:-.2px;text-decoration:none;white-space:nowrap;transition:transform .3s var(--l-spring),background .15s,box-shadow .15s}
.lp svg{width:17px;height:17px}.lp:hover{transform:translateY(-1px)}.lp:active{transform:scale(.98)}.lp:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.land .lp.pri{color:var(--night);background:var(--amber);box-shadow:0 0 0 1px rgba(255,190,130,.4),0 10px 30px -10px rgba(242,112,44,.7)}.land .lp.pri:hover{background:#f6b373}
.land .lp.alt{color:#fff;background:transparent;box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}.land .lp.alt:hover{background:rgba(255,255,255,.06)}
.lcta{display:flex;gap:10px;flex-wrap:wrap}
.lsec .lp.pri,.lsec .lp.alt{color:var(--l-ink)}.lsec .lp.alt{box-shadow:inset 0 0 0 1px var(--rule)}.lsec .lp.alt:hover{background:#fff}

/* hero */
.lhero{position:relative;min-height:min(880px,100svh);display:grid;align-items:center;overflow:hidden;color:#fff;
background:radial-gradient(90% 60% at 50% 110%,#2a1a2e 0,transparent 70%),radial-gradient(60% 50% at 85% 0,#121a45 0,transparent 70%),linear-gradient(180deg,var(--night) 0,var(--night2) 100%)}
.lhero canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.pulse{position:absolute;left:0;right:0;bottom:17%;width:100%;height:120px;pointer-events:none}
.pulse path{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.pulse .pl-b{stroke:rgba(240,163,94,.26)}.pulse .pl-g{stroke:#ffb878;stroke-dasharray:60 940;stroke-dashoffset:1000;filter:drop-shadow(0 0 6px #f2702c) drop-shadow(0 0 14px rgba(242,112,44,.6))}
@media (prefers-reduced-motion:no-preference){.pulse .pl-g{animation:pl 5.5s linear infinite}}@media (prefers-reduced-motion:reduce){.pulse .pl-g{display:none}}
@keyframes pl{to{stroke-dashoffset:0}}
.lhero-in{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,460px);gap:64px;align-items:center;width:100%;max-width:1240px;margin:0 auto;padding:128px 24px 230px;box-sizing:border-box}
.lhero .eb{color:rgba(255,255,255,.5);margin-bottom:22px}
.lhero h1{max-width:680px;margin:0;font-size:62px;font-weight:600;letter-spacing:-.045em;line-height:1;text-wrap:balance}
.lhero h1 em{font-style:normal;color:rgba(255,255,255,.42)}
.lhero .lede{max-width:46ch;margin:22px 0 30px;color:rgba(255,255,255,.66);font-size:17px;line-height:1.55;text-wrap:pretty}
.lhero .oss-l{display:inline-block;margin-top:18px;font:500 12px var(--mono);color:rgba(255,255,255,.5);text-decoration:none;letter-spacing:.02em}.lhero .oss-l:hover{color:#fff}.oss-l b{color:var(--amber);font-weight:500}
/* the board: what to watch, as a control panel */
.board{position:relative;border-radius:14px;background:rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),0 40px 80px -40px rgba(0,0,0,.8);backdrop-filter:blur(6px)}
.bd-h{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08);font:500 11px var(--mono);text-transform:uppercase;letter-spacing:.14em;color:rgba(255,255,255,.45)}
.bd-h .live{display:inline-flex;align-items:center;gap:7px;color:#7ee0a1}.bd-h .live i{width:6px;height:6px;border-radius:50%;background:#3ccf78;box-shadow:0 0 8px #3ccf78}
.bd-r{display:grid;grid-template-columns:104px minmax(0,1fr) 78px 10px;grid-template-areas:"k v sp d" "k s sp d";gap:2px 14px;align-items:center;padding:13px 18px;border-top:1px solid rgba(255,255,255,.06);text-decoration:none;transition:background .15s}
.bd-r:first-of-type{border-top:0}.bd-r:hover{background:rgba(255,255,255,.04)}
.bd-k{grid-area:k;font-size:14px;font-weight:500;color:rgba(255,255,255,.82)}
.bd-v{grid-area:v;font:500 19px var(--mono);letter-spacing:-.02em;color:#fff;font-variant-numeric:tabular-nums}
.bd-sub{grid-area:s;font-size:12.5px;color:rgba(255,255,255,.48)}
.bd-sp{grid-area:sp;display:flex;align-items:flex-end;gap:2px;height:24px}.bd-sp i{flex:1;border-radius:1px;background:rgba(240,163,94,.55)}.bd-sp i[data-s=warn]{background:var(--warn)}.bd-sp i[data-s=bad]{background:var(--bad)}.bd-sp i[data-s=ok]{background:#3ccf78}
.bd-dot{grid-area:d;width:8px;height:8px;border-radius:50%;background:#3ccf78}.bd-r[data-s=warn] .bd-dot{background:var(--warn)}.bd-r[data-s=bad] .bd-dot{background:var(--bad);box-shadow:0 0 10px var(--bad)}.bd-r[data-s=bad] .bd-sub{color:#ff8b8e}
/* hand-written notes, in the 3D map's hand */
.note{position:absolute;z-index:2;font:700 17px/1.15 Kalam,"Comic Sans MS",cursive;color:var(--amber);transform:rotate(-5deg);pointer-events:none;white-space:nowrap}
.note svg{position:absolute;overflow:visible}.note path{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.note.n-hero{left:-178px;bottom:6px}.note.n-hero svg{left:118px;top:24px;width:60px;height:30px}
.note.n-code{right:34px;top:118px;color:var(--orange);transform:rotate(-4deg)}.note.n-code svg{left:-58px;top:22px;width:52px;height:26px;transform:scaleX(-1)}
@media (prefers-reduced-motion:no-preference){.lhero .eb,.lhero h1,.lhero .lede,.lhero .lcta,.oss-l{animation:lin .7s var(--l-ease) both}.lhero h1{animation-delay:.05s}.lhero .lede{animation-delay:.12s}.lhero .lcta{animation-delay:.2s}.oss-l{animation-delay:.26s}
.board{animation:lin .8s var(--l-ease) .2s both}.note{animation:nin .6s var(--l-ease) 1s both}}
@keyframes lin{from{opacity:0;transform:translate3d(0,16px,0)}}@keyframes nin{from{opacity:0}}

/* paper */
.frame{position:relative;background:var(--paper2);padding:0 0 64px}
.lsec{max-width:1100px;margin:0 auto;padding:120px 24px 0}
.lsec-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:48px;align-items:end;margin-bottom:56px;padding-bottom:28px;border-bottom:1px solid var(--rule)}
.lsec-head .eb{margin-bottom:16px}
.lh{margin:0;font-size:clamp(34px,4.4vw,50px);font-weight:600;letter-spacing:-.045em;line-height:1.02;color:var(--l-ink);text-wrap:balance}
.lsec-head .r p{margin:0 0 20px;color:var(--l-muted);font-size:15.5px;line-height:1.6}.lsec-head .r p:last-child{margin-bottom:0}
.lfeat{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:18px;font-weight:600;letter-spacing:-.4px}
.lfeat-p{margin:0 0 20px;color:var(--l-muted);font-size:15px;line-height:1.55;max-width:72ch}
.lfeat-p code,.lmini code{font:12.5px var(--mono);color:var(--l-ink);background:#ebe7de;border-radius:4px;padding:1px 5px}
.duo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px;margin-top:56px;padding-top:28px;border-top:1px solid var(--rule)}
.lmini .lfeat{font-size:16px}.lmini .lfeat-p{margin:0;font-size:14.5px}
.lmini .n{font:500 11.5px var(--mono);color:var(--orange);margin-left:auto}
.land svg .o{fill:none;stroke:var(--orange);stroke-width:1.4;opacity:.5}.land svg .o.d{stroke-dasharray:2 3}
.land svg .s{fill:none;stroke:var(--orange);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.land svg .f{fill:var(--orange)}
.err{color:#ff8b8e}

/* panels: graph paper, the product on top */
.panel{position:relative;border-radius:14px;padding:44px 52px 0;overflow:hidden;background-color:var(--paper);background-image:linear-gradient(rgba(20,22,31,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(20,22,31,.055) 1px,transparent 1px);background-size:24px 24px;background-position:-1px -1px;box-shadow:inset 0 0 0 1px var(--rule)}
.panel.pad{padding:24px}
.sheet{background:#fff;border-radius:10px 10px 0 0;padding:24px 28px 8px;box-shadow:0 0 0 1px var(--rule),0 24px 50px -30px rgba(40,30,10,.35)}
.panel.pad .sheet{border-radius:10px;padding:6px 0}
.sheet .chrome{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;font-size:13px;color:var(--muted)}.sheet .chrome b{color:var(--ink);font:500 13px var(--mono)}
.sheet .chrome .dots{display:flex;gap:6px;margin-right:12px}.sheet .chrome .dots i{width:10px;height:10px;border-radius:50%;background:#e6e3dc}
.sheet .chrome .l{display:flex;align-items:center}
.lex{display:block;text-align:right;font:11.5px var(--mono);color:var(--l-faint);margin:10px 2px 0}
.sheet .group{margin-bottom:20px;box-shadow:none}
@media (prefers-reduced-motion:no-preference){.sheet .bars i:last-child{animation:beat 2.4s ease-in-out infinite}}
@keyframes beat{50%{opacity:.45}}

/* costs */
.cost-shot{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:1px;background:var(--line);border-radius:10px 10px 0 0;overflow:hidden;box-shadow:0 0 0 1px var(--rule),0 24px 50px -30px rgba(40,30,10,.35)}
.cost-chart,.cost-runs{background:#fff;padding:24px 26px}
.cost-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}.cost-h b{font-size:24px;font-weight:600;letter-spacing:-.04em}.cost-runs .cost-h b{font-size:15px;letter-spacing:-.02em}.cost-h span{font-size:12.5px;color:var(--faint)}
.cost-cols{display:flex;align-items:flex-end;gap:3px;height:160px}.cc{flex:1;display:flex;flex-direction:column-reverse;height:100%;gap:1px}.cc i{display:block;border-radius:1.5px;min-height:1px}
.cost-leg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:14px;font-size:12.5px;color:var(--muted)}.cost-leg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}.cost-leg b{color:var(--ink);font-weight:500;margin-left:2px}
.cost-runs table{width:100%;border-collapse:collapse;font-size:13.5px}.cost-runs th{text-align:left;font-weight:500;color:var(--faint);font-size:12px;padding:0 0 8px}.cost-runs td{padding:9px 0;border-top:1px solid var(--line)}.cost-runs th:not(:first-child),.cost-runs td:not(:first-child){text-align:right}
.cost-runs code{font:12.5px var(--mono);color:var(--ink)}.cost-runs small{color:var(--faint);margin-left:8px;font-size:11.5px}.cost-runs td b{font-weight:600}
.cost-alarm{display:flex;align-items:center;gap:8px;margin:14px 0 0;padding:9px 12px;border-radius:9px;background:#fff4ea;color:#8a5a12;font-size:12.5px}.cost-alarm i{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none}.cost-alarm b{font-weight:600}

/* sources */
.int-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.int{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:10px;background:#fff;box-shadow:0 0 0 1px var(--rule)}
.int-m{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;margin-bottom:6px}.int-m svg,.int-m img{width:20px;height:20px}
.int-m .wm{color:#fff;font:800 14px/1 var(--f);letter-spacing:-.02em;position:relative}.int-m .wm::after{content:"";position:absolute;left:1px;right:2px;bottom:-5px;height:3px;border-radius:0 0 6px 6px;border-bottom:2px solid #ff9900}
.int b{font-weight:600;font-size:15px;letter-spacing:-.3px}.int-t{color:var(--muted);font-size:13.5px;line-height:1.45}
.sheet .line{padding:13px 20px}.sheet .line .meta{white-space:normal;text-align:right;max-width:58%}.sheet .line code{font:12.5px var(--mono)}
.int-more{margin:20px 0 0;color:var(--l-muted);font-size:14px}

/* end: back to the night, the pulse running under the line */
.lend{position:relative;overflow:hidden;margin:120px 24px 0;max-width:1100px;box-sizing:border-box;padding:96px 32px 120px;border-radius:16px;text-align:center;color:#fff;background:linear-gradient(180deg,var(--night),var(--night2))}
@media(min-width:1148px){.lend{margin-inline:auto}}
.lend .pulse{bottom:12px;height:90px}
.lend h2{position:relative;margin:0 auto 12px;color:#fff;max-width:20ch;font-size:clamp(32px,4.6vw,52px);font-weight:600;letter-spacing:-.045em;line-height:1.02;text-wrap:balance}
.lend p{position:relative;margin:0 0 28px;color:rgba(255,255,255,.66);font-size:17px}.lend .lcta{position:relative;justify-content:center}
.lfoot{max-width:1100px;margin:64px auto 0;padding:20px 24px 0;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--l-faint);font:12px var(--mono);border-top:1px solid var(--rule)}
.lfoot a{color:var(--l-muted)}

@media(max-width:1100px){.lnav-st{display:none}.note.n-hero{display:none}}
@media(max-width:980px){.lhero-in{grid-template-columns:minmax(0,1fr);gap:44px;padding:112px 16px 180px}.lhero h1{font-size:46px}
.lsec-head{grid-template-columns:minmax(0,1fr);gap:20px;margin-bottom:40px}
.duo,.trio{grid-template-columns:minmax(0,1fr)}.trio{gap:24px}.panel{padding:28px 16px 0}.note{display:none}}
@media(max-width:760px){.lnav{gap:12px;padding:0 14px}.lnav-r a.t{display:none}.lnav .lp.alt{display:none}
.lhero h1{font-size:40px}.bd-r{grid-template-columns:92px minmax(0,1fr) 10px;grid-template-areas:"k v d" "k s d";padding:12px 14px}.bd-sp{display:none}.bd-v{font-size:17px}
.lsec{padding:80px 16px 0}.cost-shot{grid-template-columns:minmax(0,1fr)}.cost-chart,.cost-runs{padding:18px 16px}.cost-cols{height:110px;gap:2px}
.sheet{padding:16px 14px 4px}.sheet .line{flex-direction:column;gap:2px}.sheet .line .meta{text-align:left;max-width:none}.int-grid{grid-template-columns:minmax(0,1fr)}
.lend{margin:80px 16px 0;padding:64px 20px 100px}.lcta .lp{flex:1 1 auto}}

/* bento: the status page big, and around it what's running, the monitors, the code merged and the report */
.bento{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.tile{position:relative;display:flex;flex-direction:column;min-width:0;border-radius:16px;overflow:hidden;background:var(--paper);box-shadow:inset 0 0 0 1px var(--rule)}
.tile-cap{padding:22px 24px 18px}.tile-cap h4{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:16.5px;font-weight:600;letter-spacing:-.4px;color:var(--l-ink)}.tile-cap p{margin:0;color:var(--l-muted);font-size:14px;line-height:1.5;text-wrap:pretty}
.b-status{grid-column:1/3;grid-row:1/3}.b-live{grid-column:3;grid-row:1}.b-mon{grid-column:3;grid-row:2}.b-code{grid-column:1/3;grid-row:3}.b-rep{grid-column:3;grid-row:3}
.tile.panel{padding:0;background-image:linear-gradient(rgba(20,22,31,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(20,22,31,.055) 1px,transparent 1px);background-size:24px 24px;background-position:-1px -1px}.b-status .tile-cap{padding:26px 28px 22px}.b-status .sheet{margin:auto 28px 0}
/* live: the topbar and the panel it opens */
.b-live{background:linear-gradient(180deg,var(--night),var(--night2));box-shadow:none}.b-live .tile-cap h4{color:#fff}.b-live .tile-cap p{color:rgba(255,255,255,.58)}
.live-ui{margin:auto 16px 0;background:#fff;border-radius:12px 12px 0 0;box-shadow:0 24px 60px -30px rgba(40,30,10,.32);overflow:hidden}
.mini-tb{display:flex;align-items:center;gap:10px;height:40px;padding:0 10px 0 12px;border-bottom:1px solid var(--line);font-size:12.5px}
.mini-tb .logo{font-size:13px;gap:6px}.mini-tb .logo svg{color:#f2702c;width:16px;height:16px}.mini-tb .crumb{color:var(--muted);flex:1;font:12px var(--mono)}
.mini-tb .tb-acts{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid var(--line);border-radius:7px;font:500 12px var(--f);background:rgba(15,16,20,.04)}.mini-tb .tb-ai{display:inline-flex}.mini-tb .gi,.lj .gi{width:13px;height:13px;margin:0}.mini-tb .tb-n{color:var(--warn);font-weight:600;font-variant-numeric:tabular-nums}.mini-tb .tb-n:empty{display:none}
.live-pop{padding:10px 12px 6px}.live-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12.5px}.live-hd .live-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);margin:0}.live-meta{color:var(--faint);font-size:11.5px}
.lj-list{list-style:none;margin:0;padding:0}
.lj{display:grid;grid-template-columns:16px minmax(0,1fr) auto;grid-template-areas:"i n t" "i s s" ". b b";gap:1px 8px;align-items:center;padding:8px 0;border-top:1px solid var(--line2);font-size:12.5px}
.lj:first-child{border-top:0}.lj-i{grid-area:i;display:inline-flex;align-self:start;margin-top:2px}.lj-n{grid-area:n;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lj-n b{font:500 12.5px var(--mono)}.lj-n small{color:var(--faint);margin-left:7px;font-size:11.5px}
.lj-s{grid-area:s;color:var(--muted);font-size:11.5px}.lj-s em{font-style:normal;color:var(--faint)}.lj-t{grid-area:t;color:var(--muted);font:11.5px var(--mono);font-variant-numeric:tabular-nums}
.lj-bar{grid-area:b;height:3px;border-radius:2px;background:var(--empty);overflow:hidden;margin-top:4px}.lj-bar i{display:block;height:100%;background:var(--warn);border-radius:2px;transition:width .6s var(--l-spring)}
.lj[data-st=ok] .lj-bar i{background:var(--ok)}.lj[data-st=ok] .lj-s{color:var(--ok)}.lj[data-st=q]{opacity:.7}
@media (prefers-reduced-motion:no-preference){.lj[data-st=ok]{animation:ljok 1.2s ease-out}}@keyframes ljok{from{background:#eaf7ef}}
/* monitors */
.mt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:auto 16px 16px}
.mt{padding:12px;border-radius:10px;background:#fff;box-shadow:0 10px 30px -22px rgba(40,30,10,.32)}.mt-h{display:flex;justify-content:space-between;align-items:baseline;gap:6px}.mt-h .mon-id{font-size:12px}.mt .state{font-size:11.5px}
.mt>b{display:block;margin:6px 0 2px;font-size:22px;font-weight:600;letter-spacing:-.04em}.mt[data-s=bad]>b{color:var(--bad)}.mt .bars{height:18px;gap:1.5px;margin-top:6px}
/* code */
.b-code{position:relative}
.code-ui{margin:auto 16px 16px;padding:22px 24px 16px;background:#fff;border-radius:12px;box-shadow:0 0 0 1px var(--rule),0 24px 50px -30px rgba(40,30,10,.32)}
.code-big{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 14px}.code-big>b{font-size:56px;font-weight:600;letter-spacing:-.06em;line-height:1}.code-big>span{color:var(--muted);font-size:14px}.code-big .loc{font:500 14px var(--mono)}.code-big .add{color:var(--ok)}.code-big .del{color:var(--bad)}
.code-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin:18px 0 18px;background:var(--line);border-radius:10px;overflow:hidden}
.code-stats span{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:#f8f8fb;font-size:12px;color:var(--muted)}.code-stats b{font-size:18px;font-weight:600;letter-spacing:-.03em;color:var(--l-ink)}
.m-cols{display:flex;gap:3px;height:210px}.mc{flex:1;display:grid;grid-template-rows:72% 28%;gap:2px}.mc span{display:flex}.mc .up{align-items:flex-end}.mc .dn{align-items:flex-start}.mc i{display:block;width:100%;border-radius:2px}.mc .up i{background:var(--ok)}.mc .dn i{background:var(--bad);opacity:.75}
.code-ui .axis{margin-top:8px}
/* report: the email as it lands */
.b-rep{background:#f1efea}.b-rep .tile-cap h4{color:#111113}
.rep{margin:auto 16px 0}.rep-card{background:#fff;border-radius:14px 14px 0 0;overflow:hidden;font-family:Inter,var(--f);box-shadow:0 24px 60px -30px rgba(60,40,10,.35)}
.rep-band{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#faf9f6;border-bottom:1px solid #e8e4dc;font-size:13px}.rep-h{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:#111113;color:#fff;font-weight:700;font-size:12px}
.rep-in{padding:16px 16px 12px}.rep-pill{display:inline-block;padding:3px 10px;border-radius:999px;background:#fdf1e1;color:#b45309;font-size:11.5px;font-weight:600}
.rep-hl{margin:10px 0 2px;font-size:21px;font-weight:700;letter-spacing:-.03em;color:#111113}.rep-sub{margin:0;color:#55555c;font-size:12.5px}
.rep-eb{margin:16px 0 7px;font:500 10px var(--mono);text-transform:uppercase;letter-spacing:.14em;color:#8a8a92}
.rep-strip{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);background:#f6f4f0;border-radius:10px}.rep-strip span{display:flex;flex-direction:column;padding:9px 11px;font-size:11px;color:#55555c}.rep-strip b{font-size:15px;font-weight:700;color:#111113;letter-spacing:-.02em}.rep-strip small{color:#8a8a92;font-size:10.5px}.rep-strip small.bad{color:#c0271d}
.rep-strip i{font-style:normal}.rep-strip .g{color:#0f7a45}.rep-strip .r{color:#c0271d}
.rep-l{list-style:none;margin:8px 0 0;padding:0}.rep-l li{display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:12.5px;color:#111113}.rep-l li::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:#0f7a45;transform:translateY(-1px)}.rep-l li[data-t=alert]::before{background:#c0271d}.rep-l li[data-t=warn]::before{background:#b45309}
.rep-l li span{flex:1;min-width:0}.rep-l em{font-style:normal;color:#8a8a92;font-size:11.5px;white-space:nowrap}
/* the factory in 3D */
.f3{position:relative;height:min(640px,72vh);border-radius:16px;overflow:hidden;background:radial-gradient(70% 70% at 50% 45%,#1b2350 0,var(--night) 78%)}
.f3 canvas{display:block;width:100%!important;height:100%!important;cursor:grab}.f3 canvas:active{cursor:grabbing}
.f3-stat{position:absolute;left:20px;top:18px;z-index:2;display:flex;flex-direction:column;padding:12px 16px;border-radius:10px;color:#fff;background:rgba(255,255,255,.06);backdrop-filter:blur(12px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);pointer-events:none}
.f3-stat b{font-size:30px;font-weight:600;letter-spacing:-.05em;line-height:1;font-variant-numeric:tabular-nums}.f3-stat span{color:rgba(255,255,255,.55);font-size:12.5px;margin-top:4px}
.f3-leg{position:absolute;right:16px;top:18px;z-index:2;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;pointer-events:none}.f3-leg span{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.06);backdrop-filter:blur(12px);font:11.5px var(--mono);color:rgba(255,255,255,.8);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}.f3-leg i{width:9px;height:9px;border-radius:3px}
.f3 .map-tip[hidden]{display:none}.f3-hint{position:absolute;left:20px;bottom:16px;z-index:2;font:11.5px var(--mono);color:rgba(255,255,255,.4);pointer-events:none}
@media(max-width:980px){.bento{grid-template-columns:minmax(0,1fr)}.bento>.tile{grid-column:auto;grid-row:auto}.b-status .sheet{margin:auto 12px 0}.code-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.code-big>b{font-size:44px}.f3{height:460px}.f3-leg{display:none}}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Kalam:wght@700&display=swap">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script></head><body class="land">

<nav class="lnav" id="lnav"><a class="logo" href="/">${mark()}<span>hush</span></a><span class="lnav-st"><i></i>1 degraded · 41 runs today</span>
  <span class="lnav-r"><a class="t" href="#status">Status</a><a class="t" href="#costs">Costs</a><a class="t" href="#factory">Factory</a><a class="t" href="#sources">Sources</a><a class="t" href="${REPO}" target="_blank" rel="noopener">GitHub</a>
  ${viewer ? `<a class="lp alt" href="/landing">${esc(viewer)}</a><a class="lp pri" href="/">Enter →</a>` : `<a class="lp alt" href="/auth/login">Sign in</a><a class="lp pri" href="${install}">${GITHUB}<span>Install</span></a>`}</span>
</nav>

<header class="lhero">
  <canvas id="dither" aria-hidden="true"></canvas>
  ${PULSE}
  <div class="lhero-in">
    <div>
      <span class="eb"><b>●</b> the night shift for your repos</span>
      <h1>AI Native Observability <em>for Automated Developments</em></h1>
      <p class="lede">When agents ship more than you can read, Hush shows which routines ran, which went silent, and what each one cost.</p>
      ${cta()}
      <br><a class="oss-l" href="${REPO}" target="_blank" rel="noopener">open source · MIT · <b>read the code →</b></a>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    </div>
    <div class="board" aria-label="Example factory board">
      <div class="bd-h"><span>acme/api · today</span><span class="live"><i></i>live</span></div>
      ${BOARD.map(([href, k, label, val, sub, st, spark]) => `<a class="bd-r" href="${href}" data-s="${st}"><span class="bd-k">${label}</span><span class="bd-v"${k === "tok" ? ' id="bd-tok"' : ""}>${val}</span><span class="bd-sub">${sub}</span><span class="bd-sp" aria-hidden="true">${spark}</span><i class="bd-dot"></i></a>`).join("")}
      <span class="note n-hero">said ok after<br>reading nothing${ARROW}</span>
    </div>
  </div>
</header>

<main class="frame">

<section class="lsec" id="status">
  <div class="lsec-head">
    <div><span class="eb"><b>01</b> / status</span><h2 class="lh">The monitor of the monitors</h2></div>
    <div class="r"><p>A dead monitor and a healthy system both look like silence. Every routine leaves a heartbeat when it ends, and Hush checks them against your roster.</p>${cta()}</div>
  </div>
  <div class="bento">
    <div class="tile b-status panel" aria-label="Example status page">
      <div class="tile-cap"><h4>${ICONS.sm("beat")} One page for the whole factory</h4><p>Every skill with 30 days of history. It flags the ones that died and the ones that said ok after reading nothing.</p></div>
      <div class="sheet">
        <div class="chrome"><span class="l"><span class="dots"><i></i><i></i><i></i></span><b>acme/api</b></span><span>updated 2 min ago</span></div>
        <div class="banner" data-s="down"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg><span>One monitor has been degraded for weeks</span></div>
        <p class="banner-sub">Affected: speed. No other check would have said it: it flips between ok days and degraded days.</p>
        <div class="group">${rows}</div>
      </div>
    </div>

    <div class="tile b-live" id="live">
      <div class="tile-cap"><h4>${ICONS.sm("auto")} Automations, live</h4><p>What is running right now, one click from the top of every page.</p></div>
      <div class="live-ui">
        <div class="mini-tb"><span class="logo">${mark()}<span>hush</span></span><span class="crumb">acme/api</span><span class="tb-acts" data-on="1"><span class="tb-ai">${SPIN}</span><span>Actions</span><span class="tb-n">${LIVE.length}</span></span></div>
        <div class="live-pop"><div class="live-hd"><b>Actions</b><span class="live-dot" data-on="1"></span><span class="live-meta">${LIVE.length} running · checked just now</span></div><ul class="lj-list">${liveRows}</ul></div>
      </div>
    </div>

    <div class="tile b-mon">
      <div class="tile-cap"><h4>${ICONS.sm("beat")} Monitors</h4><p>Each one reports when it ends. Two weeks at a glance.</p></div>
      <div class="mt-grid">${monSmall}</div>
    </div>

    <div class="tile b-code">
      <div class="tile-cap"><h4>${ICONS.sm("flow")} Code your agents merged</h4><p>Built for repos where agents ship more code than any team could review by hand.</p></div>
      <span class="note n-code">more than a team<br>could ever review${ARROW}</span>
      <div class="code-ui">
        <div class="code-big"><b>${kl(addT + delT)}</b><span>lines merged in 30 days</span><span class="loc"><span class="add">+${kl(addT)}</span> <span class="del">−${kl(delT)}</span></span></div>
        <div class="code-stats">
          <span><b>${CODE.prs}</b>PRs merged</span><span><b>${CODE.agents}</b>by agents</span><span><b>${CODE.ci}</b>CI runs</span><span><b>${CODE.merge}</b>median to merge</span>
        </div>
        <div class="m-cols" aria-hidden="true">${mergedCols}</div>
        <div class="axis"><span>30 days ago</span><span class="rule"></span><span>lines added and deleted per day</span><span class="rule"></span><span>today</span></div>
      </div>
    </div>

    <div class="tile b-rep">
      <div class="tile-cap"><h4>${ICONS.sm("doc")} Reports</h4><p>One day of the factory in one email, every morning.</p></div>
      <div class="rep"><div class="rep-card">
        <div class="rep-band"><span class="rep-h">h</span><b>Daily factory report</b></div>
        <div class="rep-in">
          <span class="rep-pill">Needs a look</span>
          <p class="rep-hl">2 things to look at</p>
          <p class="rep-sub">Sunday, 11 October · acme/api</p>
          <div class="rep-eb">Automations</div>
          <div class="rep-strip"><span><b>41</b>runs<small class="bad">1 missed</small></span><span><b>18.2M</b>tokens</span><span><b>$38.40</b>token cost</span></div>
          <ul class="rep-l"><li data-t="alert"><span><b>/growth-report</b> did not run</span><em>0 9 * * 1</em></li><li data-t="warn"><span><b>speed</b>: degraded</span><em>4 of 7 days</em></li><li data-t="ok"><span>/fix-issues</span><em>3 PRs opened</em></li></ul>
          <div class="rep-eb">Code</div>
          <div class="rep-strip"><span><b>112</b>PRs merged<small>104 by agents</small></span><span><b><i class="g">+64k</i> <i class="r">−17k</i></b>lines</span></div>
        </div>
      </div></div>
    </div>
  </div>
  <script type="application/json" id="live-data">${JSON.stringify({ live: LIVE, next: LIVE_NEXT })}</script>
  <span class="lex">Example with invented data.</span>
  <div class="trio">
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("auto")} Install the app <span class="n">01</span></h3><p class="lfeat-p">On your account or your organization. Pick one repo, a few, or all of them, and change it later.</p></div>
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("beat")} Your routines report <span class="n">02</span></h3><p class="lfeat-p">One command installs a hook: every Claude Code routine reports itself when it ends.</p></div>
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("doc")} You read one page <span class="n">03</span></h3><p class="lfeat-p">Next run, tokens and state for every skill. It refreshes on its own.</p></div>
  </div>
</section>

<section class="lsec" id="costs">
  <div class="lsec-head">
    <div><span class="eb"><b>02</b> / costs</span><h2 class="lh">What the factory burns</h2></div>
    <div class="r"><p>Tokens for every routine run, next to what your cloud bills each day. A routine that burns 4× its usual tokens shows up the same day, not on the invoice.</p></div>
  </div>
  <div class="panel">
    <div class="cost-shot">
      <div class="cost-chart">
        <div class="cost-h"><b>$${Math.round(totals.reduce((a, t) => a + t[2], 0)).toLocaleString("en-US")}</b><span>last 30 days</span></div>
        <div class="cost-cols" aria-hidden="true">${costCols}</div>
        <div class="cost-leg">${totals.map(([n, c, v]) => `<span><i style="background:${c}"></i>${n} <b>$${Math.round(v)}</b></span>`).join("")}</div>
      </div>
      <div class="cost-runs">
        <div class="cost-h"><b>Per routine</b><span>30 days</span></div>
        <table><thead><tr><th>Routine</th><th>Runs</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${COST_ROUTINES.map(([n, cad, runs, tok, usd]) => `<tr><td><code>${n}</code><small>${cad}</small></td><td>${runs}</td><td>${tok}</td><td><b>${usd}</b></td></tr>`).join("")}</tbody></table>
        <p class="cost-alarm"><i></i>Price rule: <b>/fix-issues</b> over $6 a day, fired 3 h ago</p>
      </div>
    </div>
  </div>
  <span class="lex">Example with invented data.</span>
</section>

<section class="lsec" id="factory">
  <div class="lsec-head">
    <div><span class="eb"><b>03</b> / factory</span><h2 class="lh">Your software factory, in 3D</h2></div>
    <div class="r"><p>Every routine, monitor and workflow is a building, as tall as it runs. Pull requests drive down the road to main. The one that is failing glows red.</p></div>
  </div>
  <div class="f3" id="f3">
    <div class="map-layer"></div><div class="map-tip" hidden></div>
    <div class="f3-stat"><b id="f3-n">112</b><span>PRs merged today</span></div>
    <div class="f3-leg"><span><i style="background:#f0a35e"></i>Routines</span><span><i style="background:#8b84f0"></i>Monitors</span><span><i style="background:#5fc3c9"></i>CI</span><span><i style="background:#262a3b;box-shadow:0 0 0 1px rgba(255,255,255,.55)"></i>main</span></div>
    <span class="f3-hint">Drag to turn it</span>
  </div>
  <span class="lex">Example with invented data.</span>
  <script type="application/json" id="f3-data">${JSON.stringify(FACTORY)}</script>
</section>

<section class="lsec" id="sources">
  <div class="lsec-head">
    <div><span class="eb"><b>04</b> / sources</span><h2 class="lh">Where it reads from</h2></div>
    <div class="r"><p>Read-only on your code. No cloud or billing credentials: your jobs send what they already know.</p></div>
  </div>
  <div class="duo">
    <div>
      <h3 class="lfeat">${ICONS.sm("flow")} Integrations</h3>
      <p class="lfeat-p">The four platforms first. Anything else through one <code>curl</code>.</p>
      <div class="panel pad"><div class="int-grid">${INTEGRATIONS.map(([k, bg, logo, name, what]) => `<div class="int"><span class="int-m" style="background:${bg}">${logo}</span><b>${name}</b><span class="int-t">${what}</span></div>`).join("")}</div></div>
      <p class="int-more">Also: Claude Code routines, skills and tokens per session, Neon and the Anthropic API.</p>
    </div>
    <div>
      <h3 class="lfeat">${ICONS.sm("beat")} What it reads from each repo</h3>
      <p class="lfeat-p">It never writes to your repo, and every line that reads it is <a href="${REPO}/blob/main/status/server.mjs" target="_blank" rel="noopener">on GitHub</a>.</p>
      <div class="panel pad"><div class="sheet"><div class="group">
        <div class="line"><span class="name"><code>.claude/skills</code></span><span class="meta">The skills in your factory, and which ones run on a routine</span></div>
        <div class="line"><span class="name"><code>.claude/factory.json</code></span><span class="meta">Your monitor roster and Claude Code routines, with their cron</span></div>
        <div class="line"><span class="name"><code>.github/workflows</code></span><span class="meta">Scheduled Actions and the last run of every workflow</span></div>
        <div class="line"><span class="name">Issues, PRs and checks</span><span class="meta">The open queue, CI on every PR, and what your agents merged</span></div>
      </div></div></div>
    </div>
  </div>
</section>

<section class="lend">
  ${PULSE}
  <h2>A dead monitor and a healthy system look the same.</h2>
  <p>Both are silent. Hush tells you which one you have.</p>
  ${cta()}
</section>

<footer class="lfoot"><span>hush · open source, MIT · <a href="${REPO}" target="_blank" rel="noopener">github.com/humanagent/hush</a></span><span>${viewer ? `<a href="/">Enter as ${esc(viewer)}</a>` : `<a href="/auth/login">Sign in</a>`}</span></footer>
</main>

<script>
// Nav turns solid once the hero has scrolled a little.
(() => { const n = document.getElementById("lnav"); const f = () => n.dataset.s = scrollY > 40 ? "1" : "0"; addEventListener("scroll", f, { passive: true }); f(); })();
// The hero backdrop: the factory at night seen from above. Lit windows cluster into blocks toward
// the bottom, thin out into a few stars at the top; a handful twinkle, and one block is red.
(() => {
  const c = document.getElementById("dither"); if (!c) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let g, lights = [], raf;
  const draw = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr; g = c.getContext("2d"); g.scale(dpr, dpr); seed = 11; lights = [];
    const s = 6, cols = Math.ceil(w / s), rows = Math.ceil(h / s);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const u = i / cols, v = j / rows, n = rnd();
      // blocks: a coarse grid of lots, some lit, with streets between them
      const bx = Math.floor(i / 7), by = Math.floor(j / 5), street = i % 7 === 0 || j % 5 === 0;
      const lot = Math.abs(Math.sin(bx * 12.9898 + by * 78.233) * 43758.5453) % 1;
      const ground = Math.max(0, (v - 0.58) / 0.42);
      let p = street ? ground * 0.05 : ground * ground * (lot > 0.35 ? 0.9 : 0.12);
      p += v < 0.55 ? 0.006 : 0; // stars
      if (n > p) continue;
      const red = !street && bx % 23 === 17 && by % 9 === 7;
      const warm = rnd();
      const col = red ? "229,72,77" : warm < 0.55 ? "240,163,94" : warm < 0.85 ? "242,112,44" : "255,226,194";
      const a = v < 0.55 ? 0.35 + 0.4 * rnd() : 0.25 + 0.65 * rnd() * ground;
      const x = i * s + 1, y = j * s + 1, r = v < 0.55 ? 1 : 1.6;
      g.fillStyle = "rgba(" + col + "," + a + ")"; g.fillRect(x, y, r, r);
      if (!still && rnd() < 0.04) lights.push({ x, y, r, col, a, t: rnd() * 6.28, v: 0.02 + rnd() * 0.04 });
    }
  };
  const tw = () => {
    raf = requestAnimationFrame(tw);
    if (document.hidden || !g) return;
    for (const l of lights) { l.t += l.v; g.clearRect(l.x, l.y, l.r, l.r); g.fillStyle = "rgba(" + l.col + "," + (l.a * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(l.t)))) + ")"; g.fillRect(l.x, l.y, l.r, l.r); }
  };
  let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(draw, 120); }); draw();
  if (!still) raf = requestAnimationFrame(tw);
})();
// The board's token count keeps climbing while you read.
(() => {
  const e = document.getElementById("bd-tok"); if (!e || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let v = 18.2; setInterval(() => { v += 0.01; e.textContent = v.toFixed(2) + "M"; }, 1600);
})();
</script>
<script>
// The live Actions tile plays the topbar panel: running jobs step forward and their clocks tick,
// a finished one turns green for a few seconds, then the next queued run takes its place.
(() => {
  const box = document.getElementById("live"); if (!box || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const D = JSON.parse(document.getElementById("live-data").textContent);
  const STEPS = ["Install", "Build", "Read the diff", "Write the fix", "Run tests", "Run regression test", "Open the PR", "Upload"];
  const I = {
    run: '<svg class="gi spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--warn)" stroke-opacity=".25" stroke-width="2.2"/><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="var(--warn)" stroke-width="2.2" stroke-linecap="round"/></svg>',
    ok: '<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--ok)"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    q: '<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--warn)" stroke-width="1.6" stroke-dasharray="2.4 2.2"/><circle cx="8" cy="8" r="2.6" fill="var(--warn)"/></svg>',
  };
  const dur = (s) => (s >= 60 ? Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s" : s + "s");
  const mk = (r) => ({ n: r[0], w: r[1], step: r[2], d: r[3], k: r[4], s: r[5] || 0, done: 0 });
  let runs = D.live.map(mk), qi = 0;
  const next = () => { const r = mk(D.next[qi % D.next.length]); qi++; return r; };
  let queued = next();
  const list = box.querySelector(".lj-list"), count = box.querySelectorAll(".tb-n"), meta = box.querySelector(".live-meta");
  const row = (r) => '<li class="lj" data-st="' + (r.done ? "ok" : "run") + '"><span class="lj-i">' + (r.done ? I.ok : I.run) + '</span><span class="lj-n"><b>' + r.n + "</b><small>" + r.w + '</small></span><span class="lj-s">' + (r.done ? "Done" : r.step + " <em>" + r.d + "/" + r.k + "</em>") + '</span><span class="lj-t">' + dur(r.s) + '</span><span class="lj-bar"><i style="width:' + Math.round((r.d / r.k) * 100) + '%"></i></span></li>';
  const draw = () => {
    const n = runs.filter((r) => !r.done).length;
    list.innerHTML = runs.map(row).join("") + '<li class="lj" data-st="q"><span class="lj-i">' + I.q + '</span><span class="lj-n"><b>' + queued.n + "</b><small>" + queued.w + '</small></span><span class="lj-s">Queued</span><span class="lj-t"></span></li>';
    count.forEach((c) => (c.textContent = n || ""));
    meta.textContent = n + " running · checked just now";
  };
  setInterval(() => {
    for (const r of runs) {
      if (r.done) { r.done++; continue; }
      r.s++;
      if (Math.random() < 0.3) { r.d++; r.step = STEPS[(r.d + r.n.length) % STEPS.length]; if (r.d >= r.k) { r.d = r.k; r.done = 1; } }
    }
    runs = runs.map((r) => { if (r.done <= 3) return r; const q = queued; queued = next(); q.step = STEPS[q.n.length % STEPS.length]; return q; });
    draw();
  }, 1000);
})();
</script>
<script type="module">
// The factory in 3D, drawn like the services map: a tiled board, one building per automation (as
// tall as it runs), a district each for routines, monitors and CI, and a road down the middle where
// pull requests drive to main. The degraded monitor glows red. Built once it scrolls into view.
const host = document.getElementById("f3");
if (host) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const go = async () => {
    let THREE, OrbitControls;
    try { THREE = await import("three"); ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js")); }
    catch { host.querySelector(".f3-hint").textContent = "The 3D view could not load."; return; }
    const items = JSON.parse(document.getElementById("f3-data").textContent);
    const COLOR = { routines: 0xf0a35e, monitors: 0x8b84f0, ci: 0x5fc3c9 }, ROOF = { routines: 0xd9702c, monitors: 0x5b4dff, ci: 0x1f8f99 };
    const W = () => host.clientWidth, H = () => host.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(W(), H());
    host.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(-8, 20, 14); scene.add(sun);
    const INK = 0x2a2a3a;
    const outlined = (geo, color, pos) => {
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
      m.position.copy(pos);
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: INK })));
      scene.add(m); return m;
    };
    // lots in rows of six, the middle column left for the road; main sits at the end of the road
    const COLS = 7, ROAD = 3, CELL = 2.4, n = items.length;
    const lots = []; for (let c = 0; lots.length < n; c++) if (c % COLS !== ROAD) lots.push([c % COLS, Math.floor(c / COLS)]);
    const rows = lots.at(-1)[1] + 2, BW = COLS * CELL + 1.6, BD = rows * CELL + 1.6;
    const ox = -BW / 2 + 0.8 + CELL / 2, oz = -BD / 2 + 0.8 + CELL / 2, rx = ox + ROAD * CELL;
    outlined(new THREE.BoxGeometry(BW + 0.6, 0.5, BD + 0.6), 0xb9b4a8, new THREE.Vector3(0, -0.45, 0));
    outlined(new THREE.BoxGeometry(BW, 0.2, BD), 0xe9e6de, new THREE.Vector3(0, -0.1, 0));
    const tiles = new THREE.GridHelper(Math.max(BW, BD), Math.round(Math.max(BW, BD) / (CELL / 2)), 0xc4bfb2, 0xc4bfb2); tiles.position.y = 0.005;
    tiles.scale.set(BW / Math.max(BW, BD), 1, BD / Math.max(BW, BD)); scene.add(tiles);
    outlined(new THREE.BoxGeometry(CELL * 0.7, 0.04, BD - 0.4), 0xd6d2c8, new THREE.Vector3(rx, 0.02, 0));
    for (let z = -BD / 2 + 0.8; z < BD / 2 - 0.6; z += 0.9) { const d = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.36), new THREE.MeshBasicMaterial({ color: 0xffffff })); d.position.set(rx, 0.06, z); scene.add(d); }
    const roofTex = (txt, color) => { const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
      g.fillStyle = "#" + color.toString(16).padStart(6, "0"); g.beginPath(); g.roundRect(14, 14, 100, 100, 18); g.fill();
      g.fillStyle = "#fff"; g.font = "700 " + (txt.length > 2 ? 34 : 46) + "px Kalam, system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, 64, 68);
      const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; };
    const roof = (txt, color, size, x, top, z) => { const r = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: roofTex(txt, color), transparent: true }));
      r.rotation.x = -Math.PI / 2; r.position.set(x, top + 0.012, z); scene.add(r); };
    const blocks = [], labels = [];
    items.forEach(([name, kind, k, what, alarm], i) => {
      const [c, r] = lots[i], x = ox + c * CELL, z = oz + r * CELL, foot = 0.9 + 1.0 * k, h = 0.5 + 4.6 * k;
      const body = outlined(new THREE.BoxGeometry(foot, h, foot), alarm ? 0xe5484d : COLOR[kind], new THREE.Vector3(x, h / 2, z));
      roof(name.replace(/^\\//, "").replace(/\\.yml$/, "").slice(0, 3), alarm ? 0xb4232a : ROOF[kind], Math.min(0.95, foot * 0.6), x, h, z);
      body.userData = { name, kind, what, alarm }; blocks.push(body);
      labels.push({ text: name, pos: new THREE.Vector3(x, h + 0.25, z), alarm, rank: k });
    });
    // main: a tower on a podium where the road ends
    const mz = oz + (rows - 1) * CELL;
    outlined(new THREE.BoxGeometry(CELL * 2.2, 0.9, CELL * 0.9), 0x3a3f55, new THREE.Vector3(rx, 0.45, mz));
    const main = outlined(new THREE.BoxGeometry(1.5, 5.4, 1.2), 0x262a3b, new THREE.Vector3(rx, 0.9 + 2.7, mz));
    roof("main", 0xf2702c, 1.0, rx, 6.3, mz);
    main.userData = { name: "main", kind: "branch", what: "where every PR lands" }; blocks.push(main);
    labels.push({ text: "main", pos: new THREE.Vector3(rx, 6.6, mz), alarm: 0, rank: 9 });
    // traffic: PRs leave a building, drive down the road and land on main; others idle around their lot
    const cars = [], idle = [], counter = document.getElementById("f3-n");
    let merged = Number(counter?.textContent || 0);
    const spawn = (m) => { const lot = lots[Math.floor(Math.random() * n)]; m.userData = { t: 0, x0: ox + lot[0] * CELL, z0: oz + lot[1] * CELL, lane: Math.random() < 0.5 ? -0.28 : 0.28, v: 0.0016 + Math.random() * 0.0018 }; };
    if (!still) {
      for (let i = 0; i < 10; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.3), new THREE.MeshBasicMaterial({ color: 0xf2702c })); spawn(m); m.userData.t = Math.random(); scene.add(m); cars.push(m); }
      for (let i = 0; i < 18; i++) { const lot = lots[i % n], m = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), new THREE.MeshBasicMaterial({ color: 0x5b4dff })); m.userData = { cx: ox + lot[0] * CELL, cz: oz + lot[1] * CELL, a: Math.random() * 6.28, r: 0.95 + Math.random() * 0.25, v: 0.006 + Math.random() * 0.01 }; scene.add(m); idle.push(m); }
    }
    const sphere = new THREE.Box3().setFromObject(scene).getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -300, 500);
    const fit = () => { const a = W() / H(), v = sphere.radius * (a >= 1 ? 0.6 : 0.66 / a); cam.left = -v * a; cam.right = v * a; cam.top = v; cam.bottom = -v; cam.updateProjectionMatrix(); renderer.setSize(W(), H()); };
    cam.position.set(sphere.center.x + 26, 30, sphere.center.z + 34); cam.lookAt(sphere.center); fit();
    const controls = new OrbitControls(cam, renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, autoRotate: !still, autoRotateSpeed: 0.5, enableZoom: false, enablePan: false, minPolarAngle: Math.PI * 0.2, maxPolarAngle: Math.PI * 0.34 });
    controls.target.copy(sphere.center);
    renderer.domElement.addEventListener("pointerdown", () => (controls.autoRotate = false), { once: true });
    const layer = host.querySelector(".map-layer");
    labels.sort((a, b) => (b.alarm || 0) - (a.alarm || 0) || b.rank - a.rank);
    const tags = labels.map((l) => { const e = document.createElement("span"); e.className = "city-label" + (l.alarm ? " alarm" : ""); e.textContent = l.text; layer.appendChild(e); return { ...l, e }; });
    const tip = host.querySelector(".map-tip");
    const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let hover = null;
    renderer.domElement.addEventListener("pointermove", (ev) => {
      const r = renderer.domElement.getBoundingClientRect(); ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, cam);
      const o = ray.intersectObjects(blocks, false)[0]?.object || null;
      if (hover && hover !== o) hover.material.emissive.setHex(0);
      hover = o; renderer.domElement.style.cursor = o ? "pointer" : "grab";
      if (!o) { tip.hidden = true; return; }
      o.material.emissive.setHex(0x2a2a2a);
      const u = o.userData; tip.innerHTML = "<b></b><span></span>"; tip.children[0].textContent = u.name; tip.children[1].textContent = u.kind + " · " + u.what;
      tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 240) + "px"; tip.style.top = (ev.clientY - r.top + 14) + "px"; tip.hidden = false;
    });
    renderer.domElement.addEventListener("pointerleave", () => { tip.hidden = true; if (hover) hover.material.emissive.setHex(0); hover = null; });
    new ResizeObserver(fit).observe(host);
    let seen = true; new IntersectionObserver((es) => (seen = es[0].isIntersecting)).observe(host);
    const v3 = new THREE.Vector3(); let flash = 0;
    const frame = (t) => {
      controls.update();
      for (const m of cars) { const u = m.userData; u.t += u.v;
        // first a short hop from the lot to the road, then down the road to main
        if (u.t < 0.2) { const k = u.t / 0.2; m.position.set(u.x0 + (rx + u.lane - u.x0) * k, 0.12, u.z0); }
        else { const k = (u.t - 0.2) / 0.8; m.position.set(rx + u.lane, 0.12, u.z0 + (mz - 0.9 - u.z0) * k); }
        if (u.t >= 1) { spawn(m); flash = 12; if (counter) counter.textContent = String(++merged); } }
      for (const m of idle) { const u = m.userData; u.a += u.v; m.position.set(u.cx + Math.cos(u.a) * u.r, 0.1, u.cz + Math.sin(u.a) * u.r); }
      main.material.emissive.setHex(flash > 0 ? 0x5a2a10 : 0); if (flash > 0) flash--;
      if (!still) for (const b of blocks) if (b.userData.alarm) b.material.emissive.setHex(Math.sin(t / 220) > 0 ? 0x551100 : 0);
      renderer.render(scene, cam);
      const r = host.getBoundingClientRect(), placed = [];
      for (const g of tags) {
        v3.copy(g.pos).project(cam);
        const x = (v3.x + 1) / 2 * r.width, y = (1 - v3.y) / 2 * r.height, w = g.w ??= g.e.offsetWidth, box = [x - w / 2, y - 22, x + w / 2, y];
        const clash = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        g.e.style.visibility = clash ? "hidden" : "visible"; if (!clash) placed.push(box);
        g.e.style.transform = "translate(" + x + "px," + y + "px) translate(-50%,-100%)";
      }
    };
    // the first frame is drawn right away, so the board shows even before the browser starts animating
    const loop = (t) => { requestAnimationFrame(loop); if (seen && !document.hidden) frame(t); };
    frame(0); requestAnimationFrame(loop);
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: "300px" });
  io.observe(host);
}
</script>
</body></html>`;
}
