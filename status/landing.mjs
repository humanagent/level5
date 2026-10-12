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

// The 3D plant: the product's components are the halls, routines the robot arms, CI the gates,
// monitors the light towers. Sizes follow how much each one ships or runs.
const FACTORY = {
  components: [["Web app", 1, "#5b4dff", "1,204 PRs in 30 days"], ["Mobile app", 0.8, "#f2702c", "742 PRs in 30 days"], ["API", 0.9, "#1f9fb0", "861 PRs in 30 days"], ["Admin", 0.6, "#3f9f6a", "301 PRs in 30 days"], ["Landing", 0.35, "#a873f0", "110 PRs in 30 days"]],
  routines: [["/fix-issues", "31 runs · 212M tokens"], ["/pr-review", "30 runs · 71M tokens"], ["/triage", "60 runs · 22M tokens"], ["/monitor", "30 runs · 96M tokens"], ["/growth-report", "4 runs · 9M tokens"]],
  gates: [["ci.yml", "4,812 runs"], ["e2e.yml", "1,904 runs"]],
  monitors: [["errors", "ok", "daily · 100% ok"], ["logs", "ok", "daily · 100% ok"], ["cost", "ok", "daily · 100% ok"], ["llm-traces", "ok", "daily · 96.7% ok"], ["speed", "bad", "daily · 36.7% ok, degraded"]],
  deploy: ["deploy.yml", "612 promotions"],
};


// What Hush connects to today: the four platforms first, the rest in one line under them.
const LOGO_GH = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#fff" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const LOGO_VERCEL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M12 3l10 17.5H2z"/></svg>`;
// The tools a factory's monitors read and Hush keeps track of, as a row of grey logos under the hero.
// Logos from simple-icons at the version that has each one; the two it lacks show their initial.
const SI = (v, slug) => `https://cdn.jsdelivr.net/npm/simple-icons@${v}/icons/${slug}.svg`;
const TOOLS = [
  ["GitHub", SI("16.32.0", "github")], ["GitHub Actions", SI("16.32.0", "githubactions")], ["Claude Code", SI("16.32.0", "claude")],
  ["Anthropic", SI("16.32.0", "anthropic")], ["OpenRouter", SI("16.32.0", "openrouter")], ["AWS", SI("13.21.0", "amazonwebservices")],
  ["CloudWatch", SI("13.21.0", "amazoncloudwatch")], ["Sentry", SI("16.32.0", "sentry")], ["Langfuse", null], ["Mixpanel", SI("16.32.0", "mixpanel")],
  ["Neon", SI("16.32.0", "neon")], ["Vercel", SI("16.32.0", "vercel")], ["Fly.io", SI("16.32.0", "flydotio")], ["Expo", SI("16.32.0", "expo")],
  ["Twilio", SI("13.21.0", "twilio")], ["Infisical", null], ["OpenTelemetry", SI("16.32.0", "opentelemetry")],
];

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

  const cta = () => `<div class="lcta">
    ${viewer ? `<a class="lp pri" href="/">Open your repos →</a>` : `<a class="lp pri" href="${install}">${GITHUB}<span>Install on GitHub</span></a>`}
  </div>`;

  // Line icons for the lhero cards and the feature heads, drawn in the accent.
  const ICONS = {
    beat: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><circle cx="32" cy="32" r="20" class="o d"/><path d="M8 34h12l4-10 7 20 4-10h21" class="s"/></svg>`,
    cost: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><path d="M18 44V34M26 44V26M34 44V30M42 44V20M50 44V28" class="s"/><path d="M14 46h40" class="o"/></svg>`,
    flow: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><circle cx="18" cy="24" r="4" class="f"/><circle cx="46" cy="24" r="4" class="f"/><circle cx="32" cy="44" r="4" class="f"/><path d="M22 24h20M20 28l9 12M44 28l-9 12" class="s"/></svg>`,
    tok: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><ellipse cx="32" cy="22" rx="13" ry="5" class="s"/><path d="M19 22v10c0 2.8 5.8 5 13 5s13-2.2 13-5V22M19 32v10c0 2.8 5.8 5 13 5s13-2.2 13-5V32" class="s"/></svg>`,
    auto: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><circle cx="32" cy="32" r="20" class="o d"/><path d="M45 26a14 14 0 0 0-25-3M19 38a14 14 0 0 0 25 3" class="s"/><path d="M20 15v8h8M44 49v-8h-8" class="s"/></svg>`,
    doc: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="o"/><path d="M22 16h14l8 8v24H22z" class="s"/><path d="M28 32h10M28 39h10M28 25h4" class="s"/></svg>`,
    sm: (k) => ICONS[k].replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" width="18" height="18"'),
  };
  const PILLARS = [
    ["#costs", "tok", "Tokens", "Every run's tokens, per routine and per skill. A routine burning 4× shows up the same day."],
    ["#costs", "cost", "Costs", "Claude Code next to your cloud bill, with price rules that fire before the invoice."],
    ["#status", "auto", "Automations", "Every routine and Actions workflow with its state, runs, time and cost over 30 days."],
    ["#status", "doc", "Reports", "One day of the factory in one email: what ran, what it cost, what shipped."],
    ["#status", "beat", "Monitors", "A monitor that goes silent, or says ok after reading nothing, is marked down."],
  ];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hush · AI native observability for automated developments</title>
<meta name="description" content="AI native observability for automated developments. Tokens, costs, automations, reports and monitors for high throughput automated repos. Every routine, run, token and dollar on one page.">
${icon}${fonts}<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>${css}
/* Landing. A stippled dusk lhero (headline left, three glass cards right), then one framed column:
   a wordmark head per section and the product shown on a painted panel. */
:root{--f:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
--l-ink:#191e2d;--l-muted:rgba(25,30,45,.66);--l-indigo:#5b4dff;--l-peach:#f2894a;--l-surface:rgba(255,255,255,.34);--l-line:rgba(31,38,65,.12);
--l-ease:cubic-bezier(.05,.7,.1,1);--l-spring:cubic-bezier(.16,1,.3,1)}
html,body{background:#f7f7fb}
body.land{margin:0;color:var(--l-ink);font-family:var(--f);font-size:15px;letter-spacing:-.01em}
.land a{color:inherit}

/* nav: transparent over the lhero, a dark lp once you scroll */
.lnav{position:fixed;inset:12px 16px auto;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:1408px;margin:0 auto;padding:8px 8px 8px 20px;border-radius:999px;transition:background .25s ease,color .25s ease,box-shadow .25s ease}
.lnav .logo{font-size:20px;letter-spacing:-.04em;font-weight:600;color:inherit}.lnav .logo svg{color:var(--l-peach);width:24px;height:24px}
.lnav-r{display:flex;align-items:center;gap:4px}
.lnav-r a.t{padding:8px 12px;border-radius:999px;font-size:14.5px;letter-spacing:-.3px;text-decoration:none;color:var(--l-muted)}.lnav-r a.t:hover{color:var(--l-ink)}
.lnav .lp{min-height:38px;min-width:0;padding:0 16px;font-size:14.5px}
.lnav[data-s="1"]{background:rgba(14,15,26,.9);color:#fff;backdrop-filter:blur(16px) saturate(1.2);box-shadow:0 12px 32px -12px rgba(10,10,30,.5)}
.lnav[data-s="1"] a.t{color:rgba(255,255,255,.66)}.lnav[data-s="1"] a.t:hover{color:#fff}
.lnav[data-s="1"] .lp.pri{background:#fff;color:#14151f}.lnav[data-s="1"] .lp.alt{background:rgba(255,255,255,.1);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}

/* pills */
.lp{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-width:154px;min-height:46px;padding:0 25px;border-radius:999px;box-sizing:border-box;font:500 14px/1 var(--f);letter-spacing:-.45px;text-decoration:none;white-space:nowrap;transition:transform .52s var(--l-spring),background .18s ease-out,box-shadow .18s ease-out}
.lp svg{width:17px;height:17px}.lp:hover{transform:translateY(-2px)}.lp:active{transform:scale(.98);transition-duration:90ms}.lp:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.land .lp.pri{color:#fff;background:var(--l-ink);box-shadow:0 10px 34px rgba(62,64,105,.18)}
.land .lp.alt{color:var(--l-ink);background:color-mix(in srgb,var(--l-surface) 76%,transparent);box-shadow:inset 0 0 0 1px var(--l-line);backdrop-filter:blur(24px)}.lp.alt:hover{background:rgba(255,255,255,.6)}
.lcta{display:flex;gap:10px;flex-wrap:wrap}

/* lhero */
.lhero{position:relative;min-height:min(860px,100svh);display:grid;align-items:center;overflow:hidden;
background:radial-gradient(120% 80% at 70% 100%,#d9d4fb 0,transparent 60%),radial-gradient(70% 60% at 15% 90%,#fbe1cf 0,transparent 70%),linear-gradient(180deg,#f9f8fd 0,#ecebfb 55%,#e1ddf8 100%)}
.lhero canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.lhero-in{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,440px);gap:56px;align-items:center;width:100%;max-width:1240px;margin:0 auto;padding:120px 24px 200px;box-sizing:border-box}
.lhero h1{max-width:680px;margin:0;font-size:64px;font-weight:500;letter-spacing:-3.7px;line-height:.98;text-wrap:balance}
.lhero h1 em{font-style:normal;color:rgba(25,30,45,.42)}
.lhero .lede{max-width:44ch;margin:22px 0 28px;color:var(--l-muted);font-size:17px;line-height:1.5;letter-spacing:-.3px;text-wrap:pretty}
.harness{display:flex;align-items:center;flex-wrap:wrap;gap:10px 18px;margin-top:26px;font-size:14px;color:var(--l-muted);letter-spacing:-.2px}
.harness .hn{display:inline-flex;align-items:center;gap:8px;color:var(--l-ink);font-weight:500}.harness img{width:18px;height:18px;opacity:.75}
.harness em{font-style:normal;margin-left:2px;padding:1px 7px;border-radius:999px;background:rgba(25,30,45,.07);color:var(--l-muted);font-size:11.5px;font-weight:500}
.pillars{display:grid;gap:4px}
.pillar{display:grid;grid-template-columns:64px minmax(0,1fr);gap:14px;align-items:center;min-height:0;padding:14px 18px 14px 12px;border-radius:16px;text-decoration:none;background:color-mix(in srgb,var(--l-surface) 50%,transparent);box-shadow:inset 0 0 0 1px rgba(31,38,65,.05);backdrop-filter:blur(9px) saturate(.9);transition:transform .42s var(--l-spring),background .18s ease-out}
.pillar:hover{transform:translateX(-4px);background:rgba(255,255,255,.4)}
.pillar svg{width:46px;height:46px;justify-self:center}
.pillar h2{display:flex;align-items:center;gap:8px;margin:0;color:var(--l-ink);font-size:17.5px;font-weight:560;letter-spacing:-.5px;line-height:1.25}
.pillar h2 i{font-style:normal;opacity:0;transform:translateX(-8px);transition:opacity 90ms ease-out,transform .18s var(--l-spring)}.pillar:hover h2 i{opacity:1;transform:none}
.pillar p{margin:4px 0 0;color:var(--l-muted);font-size:14px;line-height:1.5;letter-spacing:-.24px;text-wrap:balance}
.land svg .o{fill:none;stroke:var(--l-indigo);stroke-width:1.4;opacity:.55}.land svg .o.d{stroke-dasharray:2 3}
.land svg .s{fill:none;stroke:var(--l-indigo);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.land svg .f{fill:var(--l-indigo)}
.err{color:var(--bad)}
@media (prefers-reduced-motion:no-preference){
.lhero h1,.lhero .lede,.lhero .lcta,.harness{animation:lin .68s var(--l-ease) both}.lhero .lede{animation-delay:.12s}.lhero .lcta{animation-delay:.22s}.harness{animation-delay:.3s}
.pillar{animation:lpil .72s var(--l-ease) both;animation-delay:calc(.18s + var(--i) * 90ms)}}
@keyframes lin{from{opacity:0;transform:translate3d(0,18px,0)}}@keyframes lpil{from{opacity:0;transform:translate3d(18px,0,0)}}

/* the framed column */
.frame{position:relative;max-width:1400px;margin:-48px auto 0;padding:0 0 64px;background:#fff;border-inline:1px dashed #dcdfea;border-radius:24px 24px 0 0;z-index:2}
.lsec{max-width:1100px;margin:0 auto;padding:120px 24px 0}
.lsec-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,460px);gap:48px;align-items:end;margin-bottom:72px}
.lword{margin:0;font-size:clamp(64px,10vw,124px);font-weight:500;letter-spacing:-.075em;line-height:.8;color:var(--l-ink)}
.ltag{display:inline-flex;align-items:center;gap:6px;margin-bottom:18px;padding:4px 9px;border-radius:7px;background:#f2f3ff;color:#3616eb;font:500 12.5px var(--f)}
.lsec-head .r{text-align:right}.lsec-head h3{margin:0 0 14px;font-size:30px;font-weight:600;letter-spacing:-1.1px;line-height:1.1}
.lsec-head .r p{margin:0 0 22px;color:var(--l-muted);font-size:15.5px;line-height:1.6}.lsec-head .lcta{justify-content:flex-end}
.lfeat{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:19px;font-weight:600;letter-spacing:-.5px}
.lfeat-p{margin:0 0 20px;color:var(--l-muted);font-size:15px;line-height:1.55;max-width:72ch}
.lfeat-p code,.lmini code{font:12.5px var(--mono);color:var(--l-ink);background:#f2f3f7;border-radius:4px;padding:1px 5px}
.duo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-top:64px}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px;margin-top:56px}
.lmini .lfeat{font-size:16.5px}.lmini .lfeat-p{margin:0;font-size:14.5px}
.lmini .n{font:500 12px var(--mono);color:#9aa0b8;margin-left:auto}

/* painted panels: soft dusk gradients with a stipple of light on top, the product sitting on the bottom edge */
.paint{position:relative;overflow:hidden;border-radius:16px;padding:56px 64px 0;isolation:isolate}
.paint::before{content:"";position:absolute;inset:0;z-index:-1;background-image:radial-gradient(rgba(255,255,255,.55) .9px,transparent 1.3px);background-size:5px 5px;-webkit-mask:linear-gradient(180deg,#000,transparent 70%);mask:linear-gradient(180deg,#000,transparent 70%)}
.paint.a{background:linear-gradient(120deg,#8a8fe6 0,#a8bdf0 48%,#9fd3df 100%)}
.paint.b{background:linear-gradient(160deg,#f7b9a1 0,#d2a8e6 46%,#8e97e8 100%)}
.paint.c{background:linear-gradient(200deg,#fad5ad 0,#f1a9b8 42%,#9b90e2 100%)}
.paint.pad{padding:28px}
.sheet{background:#fff;border-radius:12px 12px 0 0;padding:24px 28px 8px;box-shadow:0 30px 80px -30px rgba(40,24,110,.55),0 0 0 1px rgba(255,255,255,.6)}
.paint.pad .sheet{border-radius:12px;padding:6px 0}
.sheet .chrome{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;font-size:13px;color:var(--muted)}.sheet .chrome b{color:var(--ink);font:500 13px var(--mono)}
.sheet .chrome .dots{display:flex;gap:6px;margin-right:12px}.sheet .chrome .dots i{width:10px;height:10px;border-radius:50%;background:#e6e7ee}
.sheet .chrome .l{display:flex;align-items:center}
.lex{display:block;text-align:right;font-size:12px;color:#9aa0b8;margin:10px 2px 0}
.sheet .group{margin-bottom:20px;box-shadow:none}
@media (prefers-reduced-motion:no-preference){.sheet .bars i:last-child{animation:beat 2.4s ease-in-out infinite}}
@keyframes beat{50%{opacity:.45}}

/* costs */
.cost-shot{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:1px;background:var(--line);border-radius:12px 12px 0 0;overflow:hidden;box-shadow:0 30px 80px -30px rgba(40,24,110,.55)}
.cost-chart,.cost-runs{background:#fff;padding:24px 26px}
.cost-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}.cost-h b{font-size:24px;font-weight:600;letter-spacing:-.04em}.cost-runs .cost-h b{font-size:15px;letter-spacing:-.02em}.cost-h span{font-size:12.5px;color:var(--faint)}
.cost-cols{display:flex;align-items:flex-end;gap:3px;height:160px}.cc{flex:1;display:flex;flex-direction:column-reverse;height:100%;gap:1px}.cc i{display:block;border-radius:1.5px;min-height:1px}
.cost-leg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:14px;font-size:12.5px;color:var(--muted)}.cost-leg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}.cost-leg b{color:var(--ink);font-weight:500;margin-left:2px}
.cost-runs table{width:100%;border-collapse:collapse;font-size:13.5px}.cost-runs th{text-align:left;font-weight:500;color:var(--faint);font-size:12px;padding:0 0 8px}.cost-runs td{padding:9px 0;border-top:1px solid var(--line)}.cost-runs th:not(:first-child),.cost-runs td:not(:first-child){text-align:right}
.cost-runs code{font:12.5px var(--mono);color:var(--ink)}.cost-runs small{color:var(--faint);margin-left:8px;font-size:11.5px}.cost-runs td b{font-weight:600}
.cost-alarm{display:flex;align-items:center;gap:8px;margin:14px 0 0;padding:9px 12px;border-radius:9px;background:#fff4ea;color:#8a5a12;font-size:12.5px}.cost-alarm i{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none}.cost-alarm b{font-weight:600}

/* sources */
.int-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.int{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:12px;background:#fff;box-shadow:0 20px 50px -28px rgba(40,24,110,.5)}
.int-m{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;margin-bottom:6px}.int-m svg,.int-m img{width:20px;height:20px}
.int-m .wm{color:#fff;font:800 14px/1 var(--f);letter-spacing:-.02em;position:relative}.int-m .wm::after{content:"";position:absolute;left:1px;right:2px;bottom:-5px;height:3px;border-radius:0 0 6px 6px;border-bottom:2px solid #ff9900}
.int b{font-weight:600;font-size:15px;letter-spacing:-.3px}.int-t{color:var(--muted);font-size:13.5px;line-height:1.45}
.sheet .line{padding:13px 20px}.sheet .line .meta{white-space:normal;text-align:right;max-width:58%}.sheet .line code{font:12.5px var(--mono)}
.int-more{margin:20px 0 0;color:var(--l-muted);font-size:14px}

/* install: the title on the left, three steps as an accordion on the right, like a CLI's docs */
.inst{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,640px);gap:56px;align-items:start}
.inst-l h2{margin:0 0 14px;font-size:40px;font-weight:500;letter-spacing:-1.8px;line-height:1.05;color:var(--l-ink)}.inst-l p{margin:0;color:var(--l-muted);font-size:15.5px;line-height:1.6;max-width:34ch}
.inst-steps details{border-bottom:1px solid var(--line)}.inst-steps details:first-child{border-top:1px solid var(--line)}
.inst-steps summary{display:flex;align-items:center;gap:14px;padding:18px 2px;cursor:pointer;list-style:none;font-size:18px;font-weight:500;letter-spacing:-.4px;color:var(--l-muted)}
.inst-steps summary::-webkit-details-marker{display:none}.inst-steps details[open] summary{color:var(--l-ink)}
.inst-steps summary .n{display:grid;place-items:center;flex:none;width:26px;height:26px;border-radius:50%;box-shadow:inset 0 0 0 1.5px #c9ccd8;font:500 13px var(--f);color:var(--l-muted)}
.inst-steps details[open] summary .n{background:var(--l-ink);color:#fff;box-shadow:none}
.inst-steps summary::after{content:"";margin-left:auto;width:8px;height:8px;border-right:1.5px solid #9aa0b8;border-bottom:1.5px solid #9aa0b8;transform:rotate(-45deg);transition:transform .2s}.inst-steps details[open] summary::after{transform:rotate(45deg)}
.inst-b{padding:0 2px 22px 40px;color:var(--l-muted);font-size:14.5px;line-height:1.55}.inst-b p{margin:0 0 12px}.inst-b code{font:12.5px var(--mono);color:var(--l-ink);background:#f2f3f7;border-radius:4px;padding:1px 5px}
.inst-tabs{display:flex;align-items:center;gap:4px;margin:0 0 10px;font-size:13px}.inst-tabs span{color:#9aa0b8;margin-right:6px}
.inst-tabs button{padding:5px 10px;border:0;border-radius:7px;background:none;color:var(--l-muted);font:500 13px var(--f);cursor:pointer}.inst-tabs button[aria-selected=true]{background:#eceef5;color:var(--l-ink)}
.cmdb{position:relative;display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:14px 48px 14px 16px;border-radius:10px;background:#14161f;color:#e9eaf0;font:13px/1.5 var(--mono);overflow-x:auto;white-space:nowrap}
.cmdb .p{color:#7c8098}.cmdb .h{color:#f0a35e}.cmdb .k{color:#9aa0b8}
.cmdb .cp{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:7px;background:rgba(255,255,255,.06);color:#c4c7d4;cursor:pointer}.cmdb .cp:hover{background:rgba(255,255,255,.12)}.cmdb .cp svg{width:14px;height:14px}
.cmdb .cp[data-done]{color:#7ee0a1}
.term{margin:4px 0 0;border-radius:10px;background:#14161f;color:#d6d8e2;font:12.5px/1.7 var(--mono);overflow:hidden}
.term-h{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.07);color:#7c8098;font-size:11.5px}.term-h i{width:9px;height:9px;border-radius:50%;background:#3a3d4c}.term-h b{margin-left:8px;font-weight:400}
.term pre{margin:0;padding:12px 16px 14px;font:inherit;color:inherit;background:none;border:0;border-radius:0;white-space:pre;overflow-x:auto}.cmdb[hidden]{display:none}
.term .g{color:#7ee0a1}.term .o{color:#f0a35e}.term .m{color:#7c8098}.term .w{color:#fff}
.inst-next{display:inline-flex;align-items:center;gap:6px;font-weight:500;color:var(--l-ink);text-decoration:none}
@media(max-width:980px){.inst{grid-template-columns:minmax(0,1fr);gap:28px}.inst-l h2{font-size:32px}.inst-b{padding-left:2px}}

.lfoot{max-width:1100px;margin:64px auto 0;padding:20px 24px 0;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:#9aa0b8;font-size:13px;border-top:1px solid #eef0f5}
.lfoot a{color:var(--l-muted)}

/* tools: one quiet row of logos */
.tools{max-width:1100px;margin:0 auto;padding:64px 24px 0;text-align:center}
.tools p{margin:0 0 26px;color:var(--l-muted);font-size:14.5px;letter-spacing:-.2px}
.tools ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;justify-content:center;gap:18px 34px}
.tools li{display:inline-flex;align-items:center;gap:9px;color:#6b6f80;font-size:15px;font-weight:500;letter-spacing:-.3px}
.tools li img{width:20px;height:20px;opacity:.55}
.tools li i{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;background:#6b6f80;color:#fff;font:700 11px/1 var(--f);font-style:normal;opacity:.75}
@media(max-width:760px){.tools{padding:48px 16px 0}.tools ul{gap:14px 22px}.tools li{font-size:14px}}
@media(max-width:980px){.lhero-in{grid-template-columns:minmax(0,1fr);gap:40px;padding:112px 16px 160px}.lhero h1{font-size:48px;letter-spacing:-2.4px}
.lsec-head{grid-template-columns:minmax(0,1fr);gap:24px;margin-bottom:48px}.lsec-head .r{text-align:left}.lsec-head .lcta{justify-content:flex-start}
.duo,.trio{grid-template-columns:minmax(0,1fr)}.trio{gap:24px}.paint{padding:32px 20px 0}.frame{border-inline:0;border-radius:20px 20px 0 0}}
@media(max-width:760px){.lnav{inset:8px 8px auto;padding-left:14px}.lnav-r a.t{display:none}.lnav .lp.alt{display:none}
.lhero h1{font-size:42px;letter-spacing:-2px}.pillar{grid-template-columns:48px minmax(0,1fr);padding:12px 14px 12px 8px}.pillar svg{width:40px;height:40px}
.lsec{padding:80px 16px 0}.cost-shot{grid-template-columns:minmax(0,1fr)}.cost-chart,.cost-runs{padding:18px 16px}.cost-cols{height:110px;gap:2px}
.sheet{padding:16px 14px 4px}.sheet .line{flex-direction:column;gap:2px}.sheet .line .meta{text-align:left;max-width:none}.int-grid{grid-template-columns:minmax(0,1fr)}
.lcta .lp{flex:1 1 auto}}

/* bento: the status page big, and around it what's running, the monitors, the code merged and the report */
.bento{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.tile{position:relative;display:flex;flex-direction:column;min-width:0;border-radius:16px;overflow:hidden;background:linear-gradient(180deg,#f6f5fd,#efedfb);box-shadow:inset 0 0 0 1px rgba(31,38,65,.06)}
.tile-cap{padding:22px 24px 18px}.tile-cap h4{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:16.5px;font-weight:600;letter-spacing:-.4px;color:var(--l-ink)}.tile-cap p{margin:0;color:var(--l-muted);font-size:14px;line-height:1.5;text-wrap:pretty}
.b-status{grid-column:1/3;grid-row:1/3}.b-live{grid-column:3;grid-row:1}.b-mon{grid-column:3;grid-row:2}.b-code{grid-column:1/3;grid-row:3}.b-rep{grid-column:3;grid-row:3}
.tile.paint{padding:0}.b-status .tile-cap{padding:26px 28px 22px}.b-status .sheet{margin:auto 28px 0}
/* live: the topbar and the panel it opens */
.b-live{background:linear-gradient(180deg,#fdf3ea,#f6eefc)}
.live-ui{margin:auto 16px 0;background:#fff;border-radius:12px 12px 0 0;box-shadow:0 24px 60px -30px rgba(40,24,110,.5);overflow:hidden}
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
.mt{padding:12px;border-radius:10px;background:#fff;box-shadow:0 10px 30px -22px rgba(40,24,110,.6)}.mt-h{display:flex;justify-content:space-between;align-items:baseline;gap:6px}.mt-h .mon-id{font-size:12px}.mt .state{font-size:11.5px}
.mt>b{display:block;margin:6px 0 2px;font-size:22px;font-weight:600;letter-spacing:-.04em}.mt[data-s=bad]>b{color:var(--bad)}.mt .bars{height:18px;gap:1.5px;margin-top:6px}
/* code */
.b-code{background:linear-gradient(160deg,#eef8f2,#f1effc 60%)}
.code-ui{margin:auto 16px 16px;padding:22px 24px 16px;background:#fff;border-radius:12px;box-shadow:0 24px 60px -30px rgba(20,80,50,.4)}
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
.f3{position:relative;height:min(700px,78vh);border-radius:16px;overflow:hidden;background:radial-gradient(80% 70% at 50% 40%,#fbfaff 0,#ecebfa 70%,#e3e0f7 100%);box-shadow:inset 0 0 0 1px rgba(31,38,65,.06)}
.f3 canvas{display:block;width:100%!important;height:100%!important;cursor:grab}.f3 canvas:active{cursor:grabbing}
.f3-stat{position:absolute;left:20px;top:18px;z-index:2;display:flex;flex-direction:column;padding:12px 16px;border-radius:12px;background:rgba(255,255,255,.7);backdrop-filter:blur(12px);box-shadow:inset 0 0 0 1px var(--l-line);pointer-events:none}
.f3-stat b{font-size:30px;font-weight:600;letter-spacing:-.05em;line-height:1;font-variant-numeric:tabular-nums}.f3-stat span{color:var(--l-muted);font-size:12.5px;margin-top:4px}
.f3-leg{position:absolute;right:16px;top:18px;z-index:2;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;pointer-events:none}.f3-leg span{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.7);backdrop-filter:blur(12px);font-size:12px;color:var(--l-ink);box-shadow:inset 0 0 0 1px var(--l-line)}.f3-leg i{width:9px;height:9px;border-radius:3px}
.f3 .map-tip[hidden]{display:none}.f3-tag{position:absolute;left:0;top:0;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.88);box-shadow:0 2px 10px rgba(25,30,45,.16);font:500 11.5px var(--mono);color:#191e2d;white-space:nowrap;pointer-events:none}.f3-tag.bad{background:#e5484d;color:#fff}.f3-hint{position:absolute;left:20px;bottom:16px;z-index:2;font-size:12px;color:rgba(255,255,255,.9);text-shadow:0 1px 3px rgba(0,0,0,.45);pointer-events:none}
@media(max-width:980px){.bento{grid-template-columns:minmax(0,1fr)}.bento>.tile{grid-column:auto;grid-row:auto}.b-status .sheet{margin:auto 12px 0}.code-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.code-big>b{font-size:44px}.f3{height:460px}.f3-leg{display:none}}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Kalam:wght@700&display=swap">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script></head><body class="land">

<nav class="lnav" id="lnav"><a class="logo" href="/">${mark()}<span>hush</span></a>
  <span class="lnav-r"><a class="t" href="#status">Status</a><a class="t" href="#costs">Costs</a><a class="t" href="#factory">Factory</a><a class="t" href="#sources">Sources</a><a class="t" href="#install">Install</a><a class="t" href="${REPO}" target="_blank" rel="noopener">GitHub</a>
  ${viewer ? `<a class="lp alt" href="/landing">${esc(viewer)}</a><a class="lp pri" href="/">Enter →</a>` : `<a class="lp alt" href="/auth/login">Sign in</a><a class="lp pri" href="${install}">${GITHUB}<span>Install</span></a>`}</span>
</nav>

<header class="lhero">
  <canvas id="dither" aria-hidden="true"></canvas>
  <div class="lhero-in">
    <div>
      <h1>AI Native Observability <em>for Automated Developments</em></h1>
      <p class="lede">When agents ship more than you can read, Hush shows which routines ran, which went silent, and what each one cost.</p>
      ${cta()}
      <div class="harness"><span>For your harness</span><span class="hn"><img src="${SI("16.32.0", "claude")}" alt="">Claude Code</span><span class="hn"><img src="${SI("13.21.0", "openai")}" alt="">Codex<em>soon</em></span></div>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    </div>
    <div class="pillars">${PILLARS.map(([href, ic, t, p], i) => `<a class="pillar" href="${href}" style="--i:${i}">${ICONS[ic]}<span><h2>${t}<i>→</i></h2><p>${p}</p></span></a>`).join("")}</div>
  </div>
</header>

<main class="frame">

<section class="tools" aria-label="Works with">
  <p>Works with all the tools you use</p>
  <ul>${TOOLS.map(([name, logo]) => `<li>${logo ? `<img src="${logo}" alt="" loading="lazy">` : `<i aria-hidden="true">${name[0]}</i>`}${name}</li>`).join("")}</ul>
</section>

<section class="lsec" id="status">
  <div class="lsec-head">
    <div><span class="ltag">${ICONS.sm("beat")} Monitors</span><p class="lword">Status</p></div>
    <div class="r"><h3>The monitor of the monitors</h3><p>A dead monitor and a healthy system both look like silence. Every routine leaves a heartbeat when it ends, and Hush checks them against your roster.</p>${cta()}</div>
  </div>
  <div class="bento">
    <div class="tile b-status paint a" aria-label="Example status page">
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
    <div><span class="ltag">${ICONS.sm("tok")} Tokens and costs</span><p class="lword">Costs</p></div>
    <div class="r"><h3>What the factory burns</h3><p>Tokens for every routine run, next to what your cloud bills each day. A routine that burns 4× its usual tokens shows up the same day, not on the invoice.</p></div>
  </div>
  <div class="paint b">
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
    <div><span class="ltag">${ICONS.sm("auto")} In 3D</span><p class="lword">Factory</p></div>
    <div class="r"><h3>Your software factory, in 3D</h3><p>Every component is a hall. Routines are the robot arms, agents are the workers, and every PR is a crate that rides the belt through the CI gates into main. Monitors are the light towers: the failing one flashes red.</p></div>
  </div>
  <div class="f3" id="f3">
    <div class="map-layer"></div><div class="map-tip" hidden></div>
    <div class="f3-stat"><b id="f3-n">112</b><span>PRs merged today</span></div>
    <div class="f3-leg"><span><i style="background:#5b4dff"></i>Components</span><span><i style="background:#f28c28"></i>Routines</span><span><i style="background:#262a35"></i>CI gates</span><span><i style="background:#3ccf78"></i>Monitors</span><span><i style="background:#f7f7f5;box-shadow:0 0 0 1px #c9ccd8"></i>Agents</span></div>
    <span class="f3-hint">Drag to turn it</span>
  </div>
  <span class="lex">Example with invented data.</span>
  <script type="application/json" id="f3-data">${JSON.stringify(FACTORY)}</script>
</section>

<section class="lsec" id="sources">
  <div class="lsec-head">
    <div><span class="ltag">${ICONS.sm("flow")} Read-only</span><p class="lword">Sources</p></div>
    <div class="r"><h3>Where it reads from</h3><p>Read-only on your code. No cloud or billing credentials: your jobs send what they already know.</p></div>
  </div>
  <div class="duo">
    <div>
      <h3 class="lfeat">${ICONS.sm("flow")} Integrations</h3>
      <p class="lfeat-p">The four platforms first. Anything else through one <code>curl</code>.</p>
      <div class="paint c pad"><div class="int-grid">${INTEGRATIONS.map(([k, bg, logo, name, what]) => `<div class="int"><span class="int-m" style="background:${bg}">${logo}</span><b>${name}</b><span class="int-t">${what}</span></div>`).join("")}</div></div>
      <p class="int-more">Also: Claude Code routines, skills and tokens per session, OpenRouter for agents that run on its keys, Neon and the Anthropic API.</p>
    </div>
    <div>
      <h3 class="lfeat">${ICONS.sm("beat")} What it reads from each repo</h3>
      <p class="lfeat-p">It never writes to your repo, and every line that reads it is <a href="${REPO}/blob/main/status/server.mjs" target="_blank" rel="noopener">on GitHub</a>.</p>
      <div class="paint a pad"><div class="sheet"><div class="group">
        <div class="line"><span class="name"><code>.claude/skills</code></span><span class="meta">The skills in your factory, and which ones run on a routine</span></div>
        <div class="line"><span class="name"><code>.claude/factory.json</code></span><span class="meta">Your monitor roster and Claude Code routines, with their cron</span></div>
        <div class="line"><span class="name"><code>.github/workflows</code></span><span class="meta">Scheduled Actions and the last run of every workflow</span></div>
        <div class="line"><span class="name">Issues, PRs and checks</span><span class="meta">The open queue, CI on every PR, and what your agents merged</span></div>
      </div></div></div>
    </div>
  </div>
</section>

<section class="lsec" id="install">
  <div class="inst">
    <div class="inst-l"><h2>Install Hush</h2><p>Connect GitHub, add Hush to the repo from Claude Code, and let it build the factory it will watch. Free and open source.</p></div>
    <div class="inst-steps">
      <details name="inst" open>
        <summary><span class="n">1</span>Connect GitHub</summary>
        <div class="inst-b">
          <p>Install the GitHub App on your account or organization, and pick one repo, a few or all of them. It only reads.</p>
          ${viewer ? `<a class="lp pri" href="/">Open your repos →</a>` : `<a class="lp pri" href="${install}">${GITHUB}<span>Install on GitHub</span></a>`}
        </div>
      </details>
      <details name="inst">
        <summary><span class="n">2</span>Add Hush to the repo</summary>
        <div class="inst-b">
          <div class="inst-tabs" role="tablist"><span>Run in</span><button type="button" role="tab" aria-selected="true" data-tab="cc">Claude Code</button><button type="button" role="tab" aria-selected="false" data-tab="sh">Terminal</button></div>
          <div class="cmdb" data-pane="cc"><span class="h">!</span><span data-cmd>curl -fsSL <span data-origin></span>/install.sh | sh -s -- <span class="k">&lt;ingest-key&gt;</span></span><button class="cp" type="button" aria-label="Copy" data-copy><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg></button></div>
          <div class="cmdb" data-pane="sh" hidden><span class="p">$</span><span data-cmd>curl -fsSL <span data-origin></span>/install.sh | sh -s -- <span class="k">&lt;ingest-key&gt;</span></span><button class="cp" type="button" aria-label="Copy" data-copy><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg></button></div>
          <p>At the root of the repo. Your ingest key is on the repo's Setup page in Hush, right after step 1. It adds a heartbeat hook, the <code>/hush-setup</code> skill and its templates under <code>.claude/</code>, and changes nothing else.</p>
        </div>
      </details>
      <details name="inst">
        <summary><span class="n">3</span>Build your factory</summary>
        <div class="inst-b">
          <div class="cmdb"><span class="p">&gt;</span><span data-cmd>/hush-setup</span><button class="cp" type="button" aria-label="Copy" data-copy><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg></button></div>
          <p>It reads the repo, proposes monitors, a daily report and a pulse, and opens one PR with new <code>hush-*</code> skills and workflows. After the merge it creates the Claude Code routines and runs each once.</p>
          <div class="term" aria-label="Example run of /hush-setup"><div class="term-h"><i></i><i></i><i></i><b>claude · acme/api</b></div><pre><span class="w">&gt; /hush-setup</span>
<span class="g">●</span> Read the repo: Sentry in 2 apps, 12 skills, 6 workflows, no monitors
<span class="g">●</span> Proposal
  <span class="w">hush-monitor-errors</span>  routine   0 13 * * *  sonnet  <span class="m">SENTRY_AUTH_TOKEN</span>
  <span class="w">hush-report</span>          routine   0 14 * * *  haiku
  <span class="w">hush-pulse</span>           workflow  0 19 * * *  none    <span class="m">HUSH_KEY secret</span>
  <span class="m">Not covered yet: logs, costs, LLM traces.</span>
<span class="o">?</span> Add these? <span class="w">yes</span>
<span class="g">●</span> Opened PR #1 "Hush: set up the factory": 6 new files, 0 changed</pre></div>
        </div>
      </details>
    </div>
  </div>
</section>


<footer class="lfoot"><span>hush · open source, MIT · <a href="${REPO}" target="_blank" rel="noopener">github.com/humanagent/hush</a></span><span>${viewer ? `<a href="/">Enter as ${esc(viewer)}</a>` : `<a href="/auth/login">Sign in</a>`}</span></footer>
</main>

<script>
// Install: the commands carry this Hush's own address, the tabs switch the shell, copy copies.
(() => {
  document.querySelectorAll("[data-origin]").forEach((e) => (e.textContent = location.origin));
  document.querySelectorAll(".inst-tabs button").forEach((b) => b.addEventListener("click", () => {
    const box = b.closest(".inst-b");
    box.querySelectorAll(".inst-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    box.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  }));
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const box = b.closest(".cmdb"), pre = box.dataset.pane === "cc" ? "! " : "";
    try { await navigator.clipboard.writeText(pre + box.querySelector("[data-cmd]").textContent); b.dataset.done = ""; setTimeout(() => delete b.dataset.done, 1400); } catch {}
  }));
})();
// Nav turns into a dark pill once the hero has scrolled a little.
(() => { const n = document.getElementById("lnav"); const f = () => n.dataset.s = scrollY > 40 ? "1" : "0"; addEventListener("scroll", f, { passive: true }); f(); })();
// The lhero backdrop: an ordered-dither stipple of a ridge shaped like the hush mark (flat, a spike, a dip, flat),
// with a plume of light rising from the spike. Drawn once per size, no animation.
(() => {
  const c = document.getElementById("dither"); if (!c) return;
  const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const ridge = (u) => { // the mark's path, in fractions of the lhero height
    const pts = [[0, .76], [.42, .76], [.505, .40], [.60, .97], [.68, .76], [1, .76]];
    for (let i = 1; i < pts.length; i++) if (u <= pts[i][0]) { const [a, ya] = pts[i - 1], [b, yb] = pts[i]; const t = (u - a) / (b - a); return ya + (yb - ya) * (t * t * (3 - 2 * t)); }
    return .76;
  };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const draw = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr; const g = c.getContext("2d"); g.scale(dpr, dpr); seed = 7;
    const s = 3.2, cols = Math.ceil(w / s), rows = Math.ceil(h / s);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const u = i / cols, v = j / rows, r = ridge(u), n = rnd();
      let d = 0, warm = 0;
      if (v > r) { // the land: dense right under the edge, a lit rim, thinning toward the foot
        const depth = v - r; d = depth < .012 ? .95 : .62 - depth * .9 + .12 * Math.sin(u * 37 + v * 19) * Math.sin(u * 11); warm = u < .42 ? .6 : u > .7 ? .25 : .12;
      } else { // the sky: a plume of light rising from the spike, almost empty elsewhere
        const up = r - v, px = (u - .505) / (.035 + up * .32); d = Math.exp(-px * px) * Math.max(0, .62 - up * .75) + Math.max(0, .05 - up * .4); warm = .3;
      }
      if (d * (.8 + .4 * n) <= B[(j & 3) * 4 + (i & 3)]) continue;
      g.fillStyle = rnd() < warm ? "rgba(242,137,74,.55)" : "rgba(91,77,255,.42)";
      g.fillRect(i * s, j * s, 1.6, 1.6);
    }
  };
  let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(draw, 120); }); draw();
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
// The factory in 3D, as a real plant in an industrial park. Every component of the product is a
// hall (the app, the API, the admin...). Routines are the robot arms on the belt, agents are the
// workers walking the floor, and every pull request is a crate: out of its hall, down the belt,
// through the CI gates and into the main warehouse, where a truck takes promotions out. Monitors
// are the light towers along the front, the failing one flashes red, and Pulse is the control
// tower in the corner. Physical materials, procedural concrete and corrugated steel, soft shadows,
// ambient occlusion and a little bloom on the lamps. Built once it scrolls into view, paused while
// it is out of it; without post-processing it still renders, only flatter.
const host = document.getElementById("f3");
if (host) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const go = async () => {
    let THREE, OrbitControls, RoomEnvironment, RoundedBoxGeometry, PP = null;
    try {
      THREE = await import("three");
      ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
      ({ RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js"));
      ({ RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js"));
    } catch { host.querySelector(".f3-hint").textContent = "The 3D view could not load."; return; }
    try {
      const [a, b, c, d, e] = await Promise.all(["EffectComposer", "RenderPass", "GTAOPass", "UnrealBloomPass", "OutputPass"].map((n) => import("three/addons/postprocessing/" + n + ".js")));
      PP = { EffectComposer: a.EffectComposer, RenderPass: b.RenderPass, GTAOPass: c.GTAOPass, UnrealBloomPass: d.UnrealBloomPass, OutputPass: e.OutputPass };
    } catch {}
    const D = JSON.parse(document.getElementById("f3-data").textContent);
    const W = () => host.clientWidth, H = () => host.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    const DPR = Math.min(devicePixelRatio, 1.75);
    renderer.setPixelRatio(DPR); renderer.setSize(W(), H());
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.9;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.prepend(renderer.domElement);
    const scene = new THREE.Scene();

    // ---- textures, all procedural: a canvas each, tiled
    const cv = (w, h, paint) => { const c = document.createElement("canvas"); c.width = w; c.height = h; paint(c.getContext("2d"), w, h); return c; };
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const tex = (c, rx, ry, color = true) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = 8; if (color) t.colorSpace = THREE.SRGBColorSpace; return t; };
    const noise = (g, w, h, base, spread, n = 9000, size = 2) => { g.fillStyle = base; g.fillRect(0, 0, w, h); for (let i = 0; i < n; i++) { const v = Math.round((rnd() - 0.5) * spread); g.fillStyle = "rgba(" + (v > 0 ? "255,255,255," : "0,0,0,") + Math.abs(v) / 255 + ")"; g.fillRect(rnd() * w, rnd() * h, size * rnd() + 0.5, size * rnd() + 0.5); } };
    const concreteC = cv(512, 512, (g, w, h) => {
      noise(g, w, h, "#aaa59c", 40, 26000, 2);
      for (let i = 0; i < 14; i++) { const x = rnd() * w, y = rnd() * h, r = 20 + rnd() * 70; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, "rgba(90,80,70,.10)"); gr.addColorStop(1, "rgba(90,80,70,0)"); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
      g.strokeStyle = "rgba(60,55,50,.35)"; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2);
    });
    const concrete = tex(concreteC, 6, 4), concreteR = tex(concreteC, 6, 4, false);
    const asphalt = tex(cv(256, 256, (g, w, h) => noise(g, w, h, "#55575c", 50, 12000, 1.6)), 30, 30);
    const grass = tex(cv(256, 256, (g, w, h) => { noise(g, w, h, "#7f9a5e", 60, 16000, 2); }), 40, 40);
    const corr = (n) => cv(256, 64, (g, w, h) => { for (let x = 0; x < w; x++) { const v = 128 + 110 * Math.sin((x / w) * Math.PI * 2 * n); g.fillStyle = "rgb(" + v + "," + v + "," + v + ")"; g.fillRect(x, 0, 1, h); } });
    const corrV = tex(corr(16), 3, 1, false);
    const sky = tex(cv(16, 512, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#9fb8d6"); gr.addColorStop(0.55, "#d8e1ea"); gr.addColorStop(1, "#ece8e2"); g.fillStyle = gr; g.fillRect(0, 0, w, h); }), 1, 1);
    sky.wrapS = sky.wrapT = THREE.ClampToEdgeWrapping; sky.repeat.set(1, 1);
    scene.background = sky;
    scene.fog = new THREE.Fog(0xe2e4e6, 70, 170);

    // ---- light: a warm low sun, a sky/grass bounce, studio reflections for the metal
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    scene.add(new THREE.HemisphereLight(0xcfe0f5, 0x6f7a55, 0.75));
    const sun = new THREE.DirectionalLight(0xffeedb, 2.5);
    sun.position.set(-26, 34, 20); sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 26, bottom: -26, near: 1, far: 110 });
    sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.025; sun.shadow.radius = 3;
    scene.add(sun);

    const M = (color, rough = 0.7, metal = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
    const mat = {
      concrete: M(0xffffff, 0.92, 0, { map: concrete, roughnessMap: concreteR }), slab: M(0xa9a397, 0.95),
      asphalt: M(0xffffff, 0.95, 0, { map: asphalt }), grass: M(0xffffff, 1, 0, { map: grass }), curb: M(0xbdb8ae, 0.9),
      wall: M(0xeceae5, 0.55, 0.35, { bumpMap: corrV, bumpScale: 1.2 }), plinth: M(0x9c978d, 0.9),
      steel: M(0xa3a8b1, 0.3, 0.9), dark: M(0x2a2e38, 0.45, 0.3), roof: M(0xb9bdc4, 0.42, 0.75, { bumpMap: corrV, bumpScale: 0.8 }),
      glass: M(0x6f8fb3, 0.04, 0.95), belt: M(0x232528, 0.9), roller: M(0x8d929a, 0.35, 0.9), paint: M(0xe8b83c, 0.6),
      white: M(0xf4f4f2, 0.42), robot: M(0xf0821e, 0.32, 0.25), crate: M(0xc29660, 0.88), pallet: M(0x9d7a4f, 0.92),
      tire: M(0x18191c, 0.92), visor: M(0x111318, 0.08, 0.7), trunk: M(0x6b5640, 0.95), leaf: M(0x4f7a3f, 0.9), leaf2: M(0x5f8a46, 0.9),
      hvac: M(0xc8cbd0, 0.5, 0.6), whdark: M(0x2c313d, 0.5, 0.4, { bumpMap: corrV, bumpScale: 1.0 }),
    };
    const add = (geo, m, x, y, z, parent = scene, cast = true) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = cast; o.receiveShadow = true; parent.add(o); return o; };
    const rbox = (w, h, d, r = 0.08) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2));
    const group = (x, y, z, parent = scene) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
    const sign = (txt, w, h, bg, fg = "#ffffff") => {
      const c = cv(1024, Math.round(1024 * h / w), (g, cw, ch) => { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, cw, ch, ch * 0.16); g.fill(); g.fillStyle = fg; g.font = "600 " + Math.round(ch * 0.5) + "px Geist, Inter, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, cw / 2, ch * 0.54); });
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      return new THREE.Mesh(new THREE.PlaneGeometry(w, h), M(0xffffff, 0.5, 0, { map: t }));
    };
    const picks = [], tags = [];
    const pickable = (obj, info) => obj.traverse((o) => { if (o.isMesh) { o.userData.info = info; picks.push(o); } });
    const tag = (text, pos, bad = false) => tags.push({ text, pos, bad });

    // ---- the park: grass to the fog, an asphalt yard, the plant's concrete slab on a plinth
    add(new THREE.PlaneGeometry(500, 500), mat.grass, 0, -0.02, 0, scene, false).rotation.x = -Math.PI / 2;
    add(new THREE.BoxGeometry(84, 0.1, 56), mat.asphalt, 6, 0, 4, scene, false);
    add(new THREE.BoxGeometry(84.4, 0.14, 0.3), mat.curb, 6, 0.02, 32.1, scene, false);
    add(new THREE.BoxGeometry(48, 0.5, 32), mat.plinth, 0, 0.2, 0, scene, false);
    add(new THREE.BoxGeometry(47.6, 0.06, 31.6), mat.concrete, 0, 0.47, 0, scene, false);
    const Y0 = 0.5;
    const stripe = (x, z, w, d, m = mat.paint) => add(new THREE.BoxGeometry(w, 0.01, d), m, x, Y0 + 0.006, z, scene, false);
    stripe(-2.5, 0.9, 37, 0.09); stripe(-2.5, 6.2, 37, 0.09); stripe(-2.5, 8.6, 37, 0.09);
    for (let x = -20; x < 15; x += 1.4) stripe(x, 7.4, 0.7, 1.4, mat.white);
    for (let i = 0; i < 9; i++) add(new THREE.BoxGeometry(0.1, 0.01, 4.6), mat.white, 28 + i * 2.6, 0.06, 18, scene, false); // parking bays

    // ---- the halls: one per component, corrugated walls, a window band, sawtooth roofs with north lights
    const halls = [];
    let hx = -21;
    for (const [name, k, color, what] of D.components) {
      const w = 4.4 + 2.2 * k, d = 7, h = 3.1 + 0.9 * k, cx = hx + w / 2, cz = -8.5;
      const g = group(cx, Y0, cz);
      add(new THREE.BoxGeometry(w + 0.1, 0.35, d + 0.1), mat.plinth, 0, 0.175, 0, g);
      add(rbox(w, h, d, 0.05), mat.wall, 0, h / 2 + 0.2, 0, g);
      add(new THREE.BoxGeometry(w + 0.03, 0.4, d + 0.03), M(new THREE.Color(color).getHex(), 0.45, 0.2), 0, h - 0.1, 0, g);
      for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.55, d - 1.2), mat.glass, side * (w / 2 + 0.01), h - 0.85, 0, g, false);
      for (let i = 0; i < Math.round(w / 1.6); i++) add(new THREE.BoxGeometry(1.0, 0.55, 0.02), mat.glass, -w / 2 + 0.9 + i * 1.6, h - 0.85, -d / 2 - 0.01, g, false);
      const teeth = 3, td = d / teeth, rise = 1.15, slope = Math.hypot(td, rise), ang = Math.atan2(rise, td);
      for (let i = 0; i < teeth; i++) {
        const z0 = -d / 2 + i * td;
        const p = add(new THREE.BoxGeometry(w + 0.1, 0.08, slope), mat.roof, 0, h + 0.2 + rise / 2, z0 + td / 2, g); p.rotation.x = ang;
        add(new THREE.BoxGeometry(w - 0.1, rise, 0.05), mat.glass, 0, h + 0.2 + rise / 2, z0 + 0.03, g);
        for (const side of [-1, 1]) { const tri = new THREE.Shape(); tri.moveTo(0, 0); tri.lineTo(td, 0); tri.lineTo(0, rise); const e = add(new THREE.ExtrudeGeometry(tri, { depth: 0.06, bevelEnabled: false }), mat.wall, side * (w / 2) - (side > 0 ? 0.06 : 0), h + 0.2, z0, g); e.rotation.y = -Math.PI / 2; e.position.x = side * (w / 2) + (side > 0 ? 0 : 0.06); }
      }
      const door = add(new THREE.BoxGeometry(2.2, 2.3, 0.08), mat.steel, 0, 1.35, d / 2 + 0.04, g);
      for (let i = 1; i < 10; i++) add(new THREE.BoxGeometry(2.2, 0.02, 0.02), mat.dark, 0, 0.2 + i * 0.23, d / 2 + 0.09, g, false);
      add(new THREE.BoxGeometry(2.6, 0.12, 0.7), mat.dark, 0, 2.6, d / 2 + 0.35, g); // canopy
      const s = sign(name, Math.min(w - 1, 4.2), 0.72, color); s.position.set(0, h - 0.1, d / 2 + 0.03); g.add(s);
      for (let i = 0; i < 2; i++) { const u = group(-w / 4 + i * (w / 2), h + 0.2 + rise + 0.05, -d / 2 + 1.4, g); add(rbox(1.1, 0.55, 0.9, 0.06), mat.hvac, 0, 0.27, 0, u); add(new THREE.CylinderGeometry(0.32, 0.32, 0.04, 24), mat.dark, 0, 0.56, 0, u); }
      add(new THREE.CylinderGeometry(0.18, 0.18, h + 2.4, 16), mat.steel, w / 2 - 0.5, (h + 2.4) / 2, -d / 2 + 0.6, g); // flue
      // pallets by the door
      const pl = group(w / 2 - 0.9, 0.35, d / 2 + 1.0, g);
      add(new THREE.BoxGeometry(1.1, 0.14, 1.1), mat.pallet, 0, 0.07, 0, pl);
      for (let j = 0; j < 3; j++) add(rbox(0.5, 0.4, 0.5, 0.03), mat.crate, (j % 2) * 0.5 - 0.25, 0.34 + Math.floor(j / 2) * 0.4, j < 2 ? -0.25 : 0.2, pl);
      pickable(g, { name, kind: "component", what });
      halls.push({ x: cx, doorZ: cz + d / 2 + 0.6, color });
      hx += w + 1.3;
    }
    // pipes running along the back of the halls
    add(new THREE.CylinderGeometry(0.16, 0.16, 36, 16), mat.steel, -3, Y0 + 3.6, -12.4, scene).rotation.z = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.11, 0.11, 36, 16), M(0x3f7fa8, 0.35, 0.6), -3, Y0 + 3.2, -12.5, scene).rotation.z = Math.PI / 2;

    // ---- the belts, with rollers and legs
    const BELT_Y = Y0 + 0.62, BZ = 3.4, BX0 = -21, BX1 = 15;
    const conveyor = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0), along = x1 !== x0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      add(new THREE.BoxGeometry(along ? len : 1.1, 0.1, along ? 1.1 : len), mat.belt, cx, BELT_Y, cz);
      for (const s of [-0.6, 0.6]) add(new THREE.BoxGeometry(along ? len : 0.06, 0.22, along ? 0.06 : len), mat.steel, cx + (along ? 0 : s), BELT_Y + 0.03, cz + (along ? s : 0));
      for (let t = 0; t <= len; t += 1.8) { const lx = along ? x0 + Math.sign(x1 - x0) * t : x0, lz = along ? z0 : z0 + Math.sign(z1 - z0) * t;
        for (const s of [-0.48, 0.48]) add(new THREE.BoxGeometry(0.08, BELT_Y - Y0, 0.08), mat.steel, lx + (along ? 0 : s), Y0 + (BELT_Y - Y0) / 2, lz + (along ? s : 0));
        add(new THREE.BoxGeometry(along ? 0.06 : 1.0, 0.06, along ? 1.0 : 0.06), mat.steel, lx, Y0 + 0.18, lz); }
    };
    for (const h of halls) conveyor(h.x, h.doorZ - 0.2, h.x, BZ - 0.6);
    conveyor(BX0, BZ, BX1, BZ);

    // ---- the robot arms: one per routine, on a plinth in front of the belt
    const arms = [];
    D.routines.forEach(([name, what], i) => {
      const x = BX0 + 3 + i * ((BX1 - BX0 - 12) / Math.max(1, D.routines.length - 1)), z = BZ + 1.7;
      const g = group(x, Y0, z);
      add(new THREE.BoxGeometry(1.4, 0.18, 1.4), mat.dark, 0, 0.09, 0, g);
      for (const [sx, sz] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) add(new THREE.BoxGeometry(0.14, 0.03, 0.14), mat.paint, sx, 0.19, sz, g, false);
      add(new THREE.CylinderGeometry(0.5, 0.6, 0.3, 32), mat.robot, 0, 0.33, 0, g);
      const yaw = group(0, 0.48, 0, g);
      add(new THREE.CylinderGeometry(0.42, 0.46, 0.48, 32), mat.robot, 0, 0.24, 0, yaw);
      add(new THREE.CylinderGeometry(0.2, 0.2, 0.8, 24), mat.dark, 0, 0.55, 0, yaw).rotation.z = Math.PI / 2;
      const sh = group(0, 0.55, 0, yaw);
      add(rbox(0.38, 1.7, 0.42, 0.14), mat.robot, 0, 0.85, 0, sh);
      const el = group(0, 1.7, 0, sh);
      add(new THREE.CylinderGeometry(0.22, 0.22, 0.6, 24), mat.dark, 0, 0, 0, el).rotation.z = Math.PI / 2;
      add(rbox(0.3, 1.35, 0.32, 0.12), mat.robot, 0, 0.68, 0, el);
      const wr = group(0, 1.35, 0, el);
      add(new THREE.CylinderGeometry(0.15, 0.15, 0.24, 20), mat.steel, 0, 0.12, 0, wr);
      for (const s of [-0.09, 0.09]) add(new THREE.BoxGeometry(0.05, 0.3, 0.14), mat.steel, s, 0.36, 0, wr);
      add(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 8), mat.dark, 0.25, 0.85, 0.2, sh, false); // cable
      arms.push({ x, yaw, sh, el, wr, ph: i * 1.7 });
      pickable(g, { name, kind: "routine", what });
      tag(name, new THREE.Vector3(x, Y0 + 4, z));
    });

    // ---- the CI gates: arches over the belt, a scanning bar that lights when a crate passes
    const gates = D.gates.map(([name, what], i) => {
      const x = BX1 - 7 + i * 3.4, g = group(x, Y0, BZ);
      for (const s of [-1, 1]) add(rbox(0.32, 2.7, 0.32, 0.05), mat.dark, 0, 1.35, s * 0.95, g);
      add(rbox(0.5, 0.42, 2.4, 0.08), mat.dark, 0, 2.7, 0, g);
      const bar = add(new THREE.BoxGeometry(0.08, 0.05, 1.9), M(0x3ccf78, 0.4, 0, { emissive: 0x3ccf78, emissiveIntensity: 0.4 }), 0, 2.46, 0, g, false);
      const ss = sign(name, 1.6, 0.34, "#191e2d"); ss.position.set(0.26, 2.7, 0); ss.rotation.y = Math.PI / 2; g.add(ss);
      pickable(g, { name, kind: "CI gate", what });
      return { x, bar, t: 0 };
    });

    // ---- main: the warehouse at the end of the belt, its dock, and the truck that ships promotions
    const WX = BX1 + 4.6, WZ = BZ - 1.5;
    const wh = group(WX, Y0, WZ);
    add(rbox(8, 5.6, 9, 0.08), mat.whdark, 0, 2.8, 0, wh);
    add(new THREE.BoxGeometry(8.2, 0.3, 9.2), mat.roof, 0, 5.7, 0, wh);
    for (let i = 0; i < 3; i++) add(rbox(1.4, 0.6, 1.2, 0.06), mat.hvac, -2.5 + i * 2.5, 6.15, -2, wh);
    const mainSign = sign("main", 3.2, 0.95, "#f2702c"); mainSign.position.set(0, 4.5, 4.52); wh.add(mainSign);
    for (const dx of [-1.8, 1.8]) { add(new THREE.BoxGeometry(2.6, 2.6, 0.08), mat.steel, dx, 1.3 + 0.9, 4.54, wh); for (let i = 1; i < 11; i++) add(new THREE.BoxGeometry(2.6, 0.02, 0.02), mat.dark, dx, 0.9 + i * 0.24, 4.6, wh, false); }
    add(new THREE.BoxGeometry(8, 0.9, 2.2), mat.concrete, 0, 0.45, 5.6, wh);
    for (const dx of [-3, 0, 3]) add(new THREE.BoxGeometry(0.4, 0.5, 0.2), mat.tire, dx, 0.7, 6.72, wh);
    add(new THREE.BoxGeometry(0.06, 1.3, 1.3), mat.dark, -4.03, BELT_Y - Y0 + 0.5, BZ - WZ, wh);
    pickable(wh, { name: "main", kind: "branch", what: "where every PR lands" });
    const truck = group(WX + 1.8, Y0, WZ + 9.4);
    add(rbox(2.3, 2.5, 6, 0.08), mat.white, 0, 1.75, 0, truck);
    add(new THREE.BoxGeometry(2.34, 0.28, 6.04), M(0xf2702c, 0.45), 0, 1.25, 0, truck);
    add(new THREE.BoxGeometry(2.2, 0.35, 6), mat.dark, 0, 0.55, 0, truck);
    const cab = group(0, 0, 3.9, truck);
    add(rbox(2.2, 2.0, 1.9, 0.22), mat.white, 0, 1.5, 0, cab);
    add(new THREE.BoxGeometry(2.0, 0.85, 0.04), mat.visor, 0, 1.85, 0.96, cab);
    for (const [wx, wz] of [[-1.05, -2], [1.05, -2], [-1.05, -0.8], [1.05, -0.8], [-1.05, 3.9], [1.05, 3.9]]) { const t = add(new THREE.CylinderGeometry(0.48, 0.48, 0.38, 28), mat.tire, wx, 0.48, wz, truck); t.rotation.z = Math.PI / 2; add(new THREE.CylinderGeometry(0.24, 0.24, 0.4, 20), mat.steel, wx, 0.48, wz, truck).rotation.z = Math.PI / 2; }
    pickable(truck, { name: D.deploy[0], kind: "promotion", what: D.deploy[1] });
    tag(D.deploy[0], new THREE.Vector3(WX + 1.8, Y0 + 3.6, WZ + 9));
    tag("main", new THREE.Vector3(WX, Y0 + 7, WZ));
    // a forklift shuttling pallets in front of the dock
    const fork = group(WX - 2, Y0, WZ + 7.4);
    add(rbox(1.0, 0.8, 1.5, 0.12), M(0xf2c14e, 0.45, 0.1), 0, 0.6, 0, fork);
    add(new THREE.BoxGeometry(0.06, 1.8, 0.06), mat.dark, -0.42, 1.1, 0.78, fork); add(new THREE.BoxGeometry(0.06, 1.8, 0.06), mat.dark, 0.42, 1.1, 0.78, fork);
    add(new THREE.BoxGeometry(0.9, 0.06, 0.06), mat.dark, 0, 2.0, -0.4, fork);
    for (const s of [-0.25, 0.25]) add(new THREE.BoxGeometry(0.1, 0.05, 0.9), mat.steel, s, 0.12, 1.2, fork);
    add(new THREE.BoxGeometry(0.9, 0.14, 0.9), mat.pallet, 0, 0.22, 1.2, fork); add(rbox(0.7, 0.55, 0.7, 0.03), mat.crate, 0, 0.56, 1.2, fork);
    for (const [wx, wz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) add(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 18), mat.tire, wx, 0.22, wz, fork).rotation.z = Math.PI / 2;

    // ---- the monitors: light towers along the front, a lamp in the colour of their state
    const LAMP = { ok: 0x3ccf78, warn: 0xf0a33a, bad: 0xff3b3b };
    const lamps = D.monitors.map(([name, st, what], i) => {
      const x = -17 + i * 6.2, z = 11.6, g = group(x, Y0, z);
      add(new THREE.CylinderGeometry(0.42, 0.5, 0.25, 24), mat.dark, 0, 0.12, 0, g);
      add(new THREE.CylinderGeometry(0.07, 0.09, 3.6, 12), mat.steel, 0, 2.0, 0, g);
      add(rbox(0.62, 0.5, 0.5, 0.08), mat.white, 0, 3.85, 0, g);
      const lm = M(LAMP[st], 0.25, 0, { emissive: LAMP[st], emissiveIntensity: 2.2 });
      add(new THREE.SphereGeometry(0.24, 24, 16), lm, 0, 4.32, 0, g, false);
      add(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 24), mat.dark, 0, 4.58, 0, g);
      const light = new THREE.PointLight(LAMP[st], st === "bad" ? 9 : 3, 7, 2); light.position.set(0, 4.32, 0); g.add(light);
      pickable(g, { name, kind: "monitor", what });
      tag(name, new THREE.Vector3(x, Y0 + 5.2, z), st === "bad");
      return { lm, light, bad: st === "bad" };
    });

    // ---- Pulse: the control tower in the corner, glass cab, its radar turning
    const pt = group(-21.5, Y0, 11);
    add(rbox(2.2, 6.2, 2.2, 0.06), M(0xe2ded6, 0.85, 0, { map: concrete }), 0, 3.1, 0, pt);
    add(rbox(3.3, 1.4, 3.3, 0.1), mat.glass, 0, 6.9, 0, pt);
    for (const [sx, sz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) add(new THREE.BoxGeometry(0.1, 1.4, 0.1), mat.dark, sx, 6.9, sz, pt);
    add(rbox(3.6, 0.28, 3.6, 0.06), mat.dark, 0, 7.75, 0, pt);
    add(new THREE.CylinderGeometry(0.07, 0.07, 1.1, 10), mat.steel, 0, 8.4, 0, pt);
    const radar = group(0, 8.95, 0, pt);
    add(new THREE.CylinderGeometry(0.85, 0.7, 0.1, 32), mat.white, 0, 0, 0.12, radar).rotation.x = Math.PI / 2.6;
    pickable(pt, { name: "Pulse", kind: "monitor of the monitors", what: "checks every monitor against the roster" });
    tag("Pulse", new THREE.Vector3(-21.5, Y0 + 10, 11));

    // ---- the park around it: trees, cars in the bays, light poles on the yard
    const trees = [];
    for (let i = 0; i < 46; i++) {
      const side = i % 4, t = rnd();
      const x = side < 2 ? -40 + t * 96 : side === 2 ? -40 - rnd() * 8 : 51 + rnd() * 8;
      const z = side === 0 ? -26 - rnd() * 8 : side === 1 ? 35 + rnd() * 6 : -24 + t * 56;
      const s = 0.8 + rnd() * 0.7, g = group(x, 0, z);
      add(new THREE.CylinderGeometry(0.18 * s, 0.24 * s, 1.6 * s, 8), mat.trunk, 0, 0.8 * s, 0, g);
      add(new THREE.IcosahedronGeometry(1.4 * s, 1), rnd() < 0.5 ? mat.leaf : mat.leaf2, 0, 2.4 * s, 0, g).scale.set(1, 1.15, 1);
      add(new THREE.IcosahedronGeometry(1.0 * s, 1), mat.leaf2, 0.5 * s, 3.2 * s, 0.3 * s, g);
      trees.push(g);
    }
    const CARS = [0x2f3a4c, 0xb8bcc4, 0x7a1f24, 0xf4f4f2, 0x1d2027, 0x3f5f80];
    for (let i = 0; i < 6; i++) {
      const g = group(29.3 + i * 2.6 + (i > 2 ? 2.6 : 0), 0, 18 + (i % 2 ? 0.4 : -0.3));
      const body = M(CARS[i], 0.28, 0.6);
      add(rbox(1.8, 0.7, 4.2, 0.28), body, 0, 0.6, 0, g);
      add(rbox(1.6, 0.6, 2.2, 0.25), body, 0, 1.15, -0.2, g);
      add(rbox(1.62, 0.42, 2.0, 0.18), mat.visor, 0, 1.2, -0.2, g);
      for (const [wx, wz] of [[-0.85, -1.3], [0.85, -1.3], [-0.85, 1.3], [0.85, 1.3]]) add(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 20), mat.tire, wx, 0.34, wz, g).rotation.z = Math.PI / 2;
    }

    // ---- the workers: agents walking between the hall doors, the arms and the towers
    const stops = [...halls.map((h) => new THREE.Vector3(h.x + 1.7, Y0, h.doorZ + 0.8)), ...arms.map((a) => new THREE.Vector3(a.x + 1.5, Y0, BZ + 3.8)), ...lamps.map((l, i) => new THREE.Vector3(-17 + i * 6.2 + 1, Y0, 10))];
    const workers = [];
    for (let i = 0; i < 10; i++) {
      const g = group(0, Y0, 0);
      const legs = [-0.1, 0.1].map((s) => { const p = group(s, 0.44, 0, g); add(rbox(0.12, 0.44, 0.14, 0.05), mat.dark, 0, -0.22, 0, p); return p; });
      add(new THREE.CapsuleGeometry(0.21, 0.38, 6, 18), mat.white, 0, 0.8, 0, g);
      add(new THREE.BoxGeometry(0.42, 0.06, 0.3), M(0xf2c14e, 0.5), 0, 0.92, 0, g);
      add(new THREE.SphereGeometry(0.18, 22, 16), mat.white, 0, 1.3, 0, g);
      add(new THREE.SphereGeometry(0.2, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), M(0xf2c14e, 0.4), 0, 1.36, 0, g); // hard hat
      add(rbox(0.28, 0.1, 0.06, 0.03), mat.visor, 0, 1.3, 0.16, g);
      const a = stops[i % stops.length].clone(), b = stops[(i * 5 + 3) % stops.length].clone();
      g.position.copy(a);
      workers.push({ g, legs, a, b, t: rnd(), ph: rnd() * 6 });
      pickable(g, { name: "Agent", kind: "worker", what: "a coding agent between jobs" });
    }

    // ---- the crates: pull requests, out of a hall, along the belt, through the gates, into main
    const counter = document.getElementById("f3-n"); let merged = Number(counter?.textContent || 0);
    const tapes = halls.map((h) => M(new THREE.Color(h.color).getHex(), 0.5));
    const crates = [];
    const spawn = (c) => { const i = Math.floor(rnd() * halls.length), h = halls[i]; c.path = [new THREE.Vector3(h.x, 0, h.doorZ), new THREE.Vector3(h.x, 0, BZ), new THREE.Vector3(BX1 + 0.4, 0, BZ)]; c.seg = 0; c.u = 0; c.tape.material = tapes[i]; };
    for (let i = 0; i < (still ? 0 : 18); i++) {
      const g = group(0, BELT_Y + 0.05, 0);
      add(rbox(0.6, 0.46, 0.6, 0.04), mat.crate, 0, 0.23, 0, g);
      const tape = add(new THREE.BoxGeometry(0.62, 0.47, 0.12), tapes[0], 0, 0.23, 0, g, false);
      const c = { g, tape }; spawn(c); c.seg = rnd() < 0.5 ? 0 : 1; c.u = rnd(); crates.push(c);
    }

    // ---- camera, post, controls, labels, hover
    const cam = new THREE.PerspectiveCamera(26, W() / H(), 0.5, 600);
    const center = new THREE.Vector3(0, 1.8, 1.5);
    let composer = null, ao = null, bloom = null;
    if (PP) {
      try {
        const rt = new THREE.WebGLRenderTarget(W() * DPR, H() * DPR, { type: THREE.HalfFloatType, samples: 4 });
        composer = new PP.EffectComposer(renderer, rt);
        composer.addPass(new PP.RenderPass(scene, cam));
        ao = new PP.GTAOPass(scene, cam, W(), H());
        ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
        ao.blendIntensity = 0.85;
        composer.addPass(ao);
        bloom = new PP.UnrealBloomPass(new THREE.Vector2(W(), H()), 0.22, 0.4, 1.0);
        composer.addPass(bloom);
        composer.addPass(new PP.OutputPass());
      } catch { composer = null; }
    }
    const fit = () => { const a = W() / H(); cam.aspect = a; const dist = 64 / Math.min(1, a / 1.7); cam.position.copy(center).add(new THREE.Vector3(0.55, 0.6, 0.86).normalize().multiplyScalar(dist)); cam.updateProjectionMatrix(); renderer.setSize(W(), H()); if (composer) { composer.setPixelRatio(DPR); composer.setSize(W(), H()); } };
    fit(); cam.lookAt(center);
    const controls = new OrbitControls(cam, renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, autoRotate: !still, autoRotateSpeed: 0.3, enableZoom: false, enablePan: false, minPolarAngle: Math.PI * 0.22, maxPolarAngle: Math.PI * 0.38 });
    controls.target.copy(center);
    renderer.domElement.addEventListener("pointerdown", () => (controls.autoRotate = false), { once: true });
    const layer = host.querySelector(".map-layer");
    const els = tags.map((t) => { const e = document.createElement("span"); e.className = "f3-tag" + (t.bad ? " bad" : ""); e.textContent = t.text; layer.appendChild(e); return { ...t, e }; });
    const tip = host.querySelector(".map-tip");
    const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
    renderer.domElement.addEventListener("pointermove", (ev) => {
      const r = renderer.domElement.getBoundingClientRect(); ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, cam);
      const o = ray.intersectObjects(picks, false)[0]?.object;
      renderer.domElement.style.cursor = o ? "pointer" : "grab";
      if (!o) { tip.hidden = true; return; }
      const u = o.userData.info; tip.innerHTML = "<b></b><span></span>"; tip.children[0].textContent = u.name; tip.children[1].textContent = u.kind + " · " + u.what;
      tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 240) + "px"; tip.style.top = (ev.clientY - r.top + 14) + "px"; tip.hidden = false;
    });
    renderer.domElement.addEventListener("pointerleave", () => (tip.hidden = true));
    new ResizeObserver(fit).observe(host);
    let seen = true; new IntersectionObserver((es) => (seen = es[0].isIntersecting)).observe(host);

    const v3 = new THREE.Vector3(), clock = new THREE.Clock(); let flash = 0, truckT = 0, forkT = 0, el = 0;
    const frame = () => {
      const dt = Math.min(0.05, clock.getDelta()); el += dt;
      controls.update();
      if (!still) {
        arms.forEach((a) => { const t = el * 0.8 + a.ph; a.yaw.rotation.y = Math.sin(t) * 0.9; a.sh.rotation.z = -0.35 + Math.sin(t * 1.3) * 0.25; a.el.rotation.z = 1.15 + Math.sin(t * 1.3 + 1) * 0.35; a.wr.rotation.y = t * 2; });
        for (const c of crates) {
          c.u += dt * 1.6 / Math.max(0.5, c.path[c.seg].distanceTo(c.path[c.seg + 1]));
          if (c.u >= 1) { c.u = 0; c.seg++; }
          if (c.seg >= 2) { spawn(c); merged++; flash = 0.4; if (counter) counter.textContent = String(merged); }
          const a = c.path[c.seg], b = c.path[c.seg + 1];
          c.g.position.set(a.x + (b.x - a.x) * c.u, BELT_Y + 0.05, a.z + (b.z - a.z) * c.u);
          for (const gt of gates) if (c.seg === 1 && Math.abs(c.g.position.x - gt.x) < 0.35) gt.t = 0.5;
        }
        for (const gt of gates) { gt.t = Math.max(0, gt.t - dt); gt.bar.material.emissiveIntensity = 0.4 + gt.t * 6; }
        for (const w of workers) {
          w.t += dt * 0.55 / Math.max(1, w.a.distanceTo(w.b));
          if (w.t >= 1) { w.t = 0; w.a.copy(w.b); w.b.copy(stops[Math.floor(rnd() * stops.length)]); }
          w.g.position.lerpVectors(w.a, w.b, w.t); w.g.position.y = Y0 + Math.abs(Math.sin(el * 8 + w.ph)) * 0.035;
          w.g.rotation.y = Math.atan2(w.b.x - w.a.x, w.b.z - w.a.z);
          w.legs[0].rotation.x = Math.sin(el * 8 + w.ph) * 0.45; w.legs[1].rotation.x = -w.legs[0].rotation.x;
        }
        radar.rotation.y = el * 1.4;
        for (const l of lamps) if (l.bad) { const on = Math.sin(el * 6) > 0; l.lm.emissiveIntensity = on ? 3.2 : 0.1; l.light.intensity = on ? 10 : 0; }
        truckT = (truckT + dt / 16) % 1;
        const tz = truckT < 0.35 ? 0 : truckT < 0.6 ? (truckT - 0.35) / 0.25 : truckT < 0.75 ? 1 : 1 - (truckT - 0.75) / 0.25;
        truck.position.z = WZ + 9.4 + tz * 3.6;
        forkT += dt / 7; const fx = Math.sin(forkT * Math.PI * 2);
        fork.position.x = WX - 2 + fx * 2.6; fork.rotation.y = Math.cos(forkT * Math.PI * 2) > 0 ? Math.PI / 2 : -Math.PI / 2;
        flash = Math.max(0, flash - dt); mainSign.material.emissive.setHex(flash > 0 ? 0x5a2a10 : 0);
      }
      if (composer) composer.render(); else renderer.render(scene, cam);
      const r = host.getBoundingClientRect(), placed = [];
      for (const g of els) {
        v3.copy(g.pos).project(cam);
        const x = (v3.x + 1) / 2 * r.width, y = (1 - v3.y) / 2 * r.height, w = g.w ??= g.e.offsetWidth, box = [x - w / 2, y - 22, x + w / 2, y];
        const clash = v3.z > 1 || placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        g.e.style.visibility = clash ? "hidden" : "visible"; if (!clash) placed.push(box);
        g.e.style.transform = "translate(" + x + "px," + y + "px) translate(-50%,-100%)";
      }
    };
    const loop = () => { requestAnimationFrame(loop); if (seen && !document.hidden) frame(); };
    frame(); requestAnimationFrame(loop);
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: "300px" });
  io.observe(host);
}
</script>
</body></html>`;
}
