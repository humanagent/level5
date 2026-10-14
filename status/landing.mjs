// The public landing at "/", for people who are not signed in. Type V, after the Kardashev
// scale.
const REPO = "https://github.com/humanagent/typev";
// Every number in the preview is invented and labelled as an example.

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


// What it connects to today: the four platforms first, the rest in one line under them.
const LOGO_GH = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#fff" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const LOGO_VERCEL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M12 3l10 17.5H2z"/></svg>`;
// The tools a factory's monitors read and Type V keeps track of, as a row of grey logos under the hero.
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

const GITHUB_I = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
// The Type V mark: five rising rounded bars, one per Kardashev type, bottom-aligned.
const MARKV = (size = 24) => `<svg class="mk" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">${[0, 1, 2, 3, 4].map((i) => `<rect x="${+(2 + i * 7.6).toFixed(1)}" y="${+(36 - (8 + i * 6.5)).toFixed(1)}" width="5.4" height="${+(8 + i * 6.5).toFixed(1)}" rx="1.6" fill="currentColor" opacity="${[0.42, 0.56, 0.7, 0.85, 1][i]}"/>`).join("")}</svg>`;
const WORDMARK = (size = 24) => `${MARKV(size)}<span class="wm">Type <b>V</b></span>`;
const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' rx='9' fill='#0b0c14'/><g transform='translate(4 4) scale(.8)' fill='#e8875f'>${[0, 1, 2, 3, 4].map((i) => `<rect x='${+(2 + i * 7.6).toFixed(1)}' y='${+(36 - (8 + i * 6.5)).toFixed(1)}' width='5.4' height='${+(8 + i * 6.5).toFixed(1)}' rx='1.6'/>`).join("")}</g></svg>`)}">`;
const SITE = "https://factory-status.fly.dev";
const COPY_I = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>`;

export function landingPage({ install, msg, esc, css, fonts, viewer = null }) {
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

  // Every way in: Start free installs the GitHub App (or, signed in, goes to the repos);
  // Run your own goes to the repo. `where` names the spot for the click beacons.
  const start = (where, label = "Start free") => viewer ? `<a class="lp pri" href="/">Open your repos <span aria-hidden="true">→</span></a>` : `<a class="lp pri" href="${esc(install)}" data-track="cta:${where}-start">${label}</a>`;
  const own = (where) => `<a class="lp alt" href="${REPO}" target="_blank" rel="noopener" data-track="cta:${where}-selfhost">${GITHUB_I}<span>Run your own</span></a>`;
  const cta = (where) => `<div class="lcta">${start(where)}${own(where)}</div>`;

  // Line icons for the pillars and the feature heads.
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
  // section eyebrows, CLI style: a number, a dot, a lowercase word
  const ey = (n, w) => `<span class="ey"><b>${n}</b><i>·</i>${w}</span>`;
  const copyBtn = `<button class="cp" type="button" aria-label="Copy command" data-copy>${COPY_I}</button>`;
  const title = "Type V · For a new class of developer. Accelerate.";
  const desc = "Observability for the factory your agents run: which routines ran, which went silent, and what each one cost. Works with Claude Code. Free, open source (MIT), self-host it.";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#0b0c14">
<link rel="canonical" href="${SITE}/">
<meta property="og:type" content="website"><meta property="og:site_name" content="Type V"><meta property="og:url" content="${SITE}/">
<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${desc}">
${FAVICON}${fonts}<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>${css}
/* Type V. Deep cool ink with a faint dot field, warm clay as the accent and indigo behind it, 1px
   lines instead of glass, mono for every label and number. The product shots stay light: they
   read as screenshots on the dark ground. */
:root{--f:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
--v-bg:#0b0c14;--v-bg2:#11121c;--v-bg3:#171826;--v-tx:#ecebf2;--v-mut:#a3a2b0;--v-faint:#73727f;--v-ln:rgba(236,235,255,.09);--v-ln2:rgba(236,235,255,.16);
--v-clay:#e8875f;--v-clay2:#f2a07a;--v-indigo:#5b4dff;--v-indigo2:#9a92ff;--v-ok:#5fd394;
--v-ease:cubic-bezier(.05,.7,.1,1);--v-spring:cubic-bezier(.16,1,.3,1)}
html{background:var(--v-bg);color-scheme:dark;scroll-padding-top:72px}
body.land{margin:0;color:var(--v-tx);font-family:var(--f);font-size:15px;letter-spacing:-.01em;background:var(--v-bg);
background-image:radial-gradient(rgba(236,235,255,.045) 1px,transparent 1.2px);background-size:22px 22px;background-attachment:fixed}
.land ::selection{background:var(--v-clay);color:#160d09}
.land a{color:inherit}
.land a:focus-visible,.land button:focus-visible,.land summary:focus-visible{outline:2px solid var(--v-clay);outline-offset:3px;border-radius:6px}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mk{color:var(--v-clay);flex:none}
.wm{font-weight:600;letter-spacing:-.035em}.wm b{color:var(--v-clay);font-weight:600}
kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border:1px solid var(--v-ln2);border-bottom-width:2px;border-radius:5px;font:500 10.5px/1 var(--mono);color:var(--v-mut);background:rgba(255,255,255,.03)}

/* nav: a thin bar, transparent over the hero, ink with a hairline once you scroll */
.lnav{position:fixed;inset:0 0 auto;z-index:10;border-bottom:1px solid transparent;transition:background .25s ease,border-color .25s ease}
.lnav-in{display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:1240px;margin:0 auto;padding:12px 24px;box-sizing:border-box}
.lnav[data-s="1"]{background:rgba(11,12,20,.82);backdrop-filter:blur(14px) saturate(1.1);border-bottom-color:var(--v-ln)}
.lnav .logo{display:inline-flex;align-items:center;gap:10px;font-size:19px;color:var(--v-tx);text-decoration:none}
.lnav-r{display:flex;align-items:center;gap:2px}
.lnav-r a.t{padding:8px 11px;border-radius:7px;font:400 13px var(--mono);letter-spacing:0;text-decoration:none;color:var(--v-mut)}.lnav-r a.t:hover{color:var(--v-tx);background:rgba(255,255,255,.04)}
.lnav .lp{min-height:36px;min-width:0;padding:0 14px;font-size:14px;margin-left:6px}

/* buttons: clay with ink text (AA), and a hairline ghost */
.lp{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:46px;padding:0 22px;border-radius:10px;box-sizing:border-box;font:500 15px/1 var(--f);letter-spacing:-.3px;text-decoration:none;white-space:nowrap;transition:transform .45s var(--v-spring),background .18s ease-out,border-color .18s ease-out,box-shadow .18s ease-out}
.lp svg{width:17px;height:17px}.lp:hover{transform:translateY(-1px)}.lp:active{transform:scale(.98);transition-duration:90ms}
.land .lp.pri{color:#170c07;background:var(--v-clay);box-shadow:0 0 0 1px rgba(255,190,160,.25) inset,0 10px 30px -12px rgba(232,135,95,.65)}.land .lp.pri:hover{background:var(--v-clay2)}
.land .lp.alt{color:var(--v-tx);background:rgba(255,255,255,.02);border:1px solid var(--v-ln2)}.land .lp.alt:hover{background:rgba(255,255,255,.06);border-color:rgba(236,235,255,.28)}
.lcta{display:flex;gap:10px;flex-wrap:wrap}

/* hero: copy on the left, a Claude Code session on the right, over a dithered starfield */
.lhero{position:relative;min-height:min(900px,100svh);display:grid;align-items:center;overflow:hidden;
background:radial-gradient(70% 55% at 78% 30%,rgba(91,77,255,.16),transparent 70%),radial-gradient(60% 50% at 10% 100%,rgba(232,135,95,.10),transparent 70%)}
.lhero canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.lhero::after{content:"";position:absolute;inset:auto 0 0;height:140px;background:linear-gradient(180deg,transparent,var(--v-bg));pointer-events:none}
.lhero-in{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,560px);gap:56px;align-items:center;width:100%;max-width:1240px;margin:0 auto;padding:128px 24px 112px;box-sizing:border-box}
.kick{display:inline-flex;align-items:center;gap:10px;margin:0 0 26px;padding:6px 12px 6px 8px;border:1px solid var(--v-ln2);border-radius:999px;font:400 12.5px var(--mono);color:var(--v-mut);background:rgba(11,12,20,.5)}
.kick b{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;background:rgba(232,135,95,.14);color:var(--v-clay2);font-weight:500}
.lhero h1{margin:0;font-size:76px;font-weight:600;letter-spacing:-.045em;line-height:.96;text-wrap:balance}
.lhero h1 em{display:block;font-style:normal;color:var(--v-clay)}
.lhero .lede{max-width:46ch;margin:26px 0 32px;color:var(--v-mut);font-size:18px;line-height:1.55;letter-spacing:-.25px;text-wrap:pretty}
.works{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;margin-top:30px;padding-top:22px;border-top:1px solid var(--v-ln);font:400 13px var(--mono);color:var(--v-mut)}
.works .hn{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid var(--v-ln2);border-radius:8px;color:var(--v-tx);font:500 14px var(--f);letter-spacing:-.2px}
.works .hn img{width:16px;height:16px;filter:invert(1);opacity:.9}
.works .hn .lg{width:16px;height:16px;background:var(--v-clay);-webkit-mask:var(--u) center/contain no-repeat;mask:var(--u) center/contain no-repeat}
.works .hn.soon{color:var(--v-mut);border-style:dashed}.works .hn.soon img{opacity:.55}
.works em{font-style:normal;padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.07);color:var(--v-mut);font:500 10.5px var(--mono);text-transform:uppercase;letter-spacing:.06em}
.free{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:14px 0 0;font:400 13px var(--mono);color:var(--v-mut)}
.free b{color:var(--v-tx);font-weight:500}.free i{font-style:normal;color:var(--v-faint)}.free .ck{color:var(--v-ok)}
.err{color:#ff8f8f}

/* the Claude Code window */
.ccw{position:relative;border:1px solid var(--v-ln2);border-radius:14px;background:linear-gradient(180deg,#12131e,#0d0e17);box-shadow:0 40px 90px -40px rgba(0,0,0,.9),0 0 0 1px rgba(0,0,0,.4),0 0 80px -30px rgba(91,77,255,.35);overflow:hidden;font:12.5px/1.6 var(--mono);color:#d9d8e3}
.ccw-bar{display:flex;align-items:center;gap:7px;padding:11px 14px;border-bottom:1px solid var(--v-ln);color:var(--v-faint);font-size:11.5px}
.ccw-bar i{width:10px;height:10px;border-radius:50%;background:#2a2b3a}.ccw-bar span{margin-left:8px}.ccw-bar span:last-child{margin-left:auto}
.ccw-body{padding:16px 18px 6px}
.ccw-wel{display:inline-block;margin:0 0 14px;padding:8px 14px;border:1px solid rgba(232,135,95,.55);border-radius:8px}
.ccw-wel b{color:var(--v-tx);font-weight:500}.ccw .sp{color:var(--v-clay)}
.ccw .m{color:var(--v-faint)}.ccw .w{color:var(--v-tx)}.ccw .c{color:var(--v-clay2)}.ccw .g{color:var(--v-ok)}.ccw .ix{color:var(--v-indigo2)}
.ccw-l{white-space:pre;min-height:1.6em;overflow:hidden;text-overflow:ellipsis}
.ccw-l.in{margin:2px 0 8px;color:var(--v-tx)}.ccw-l.in .pr{color:var(--v-faint)}
.ccw-l.ok{margin-top:8px;color:var(--v-ok)}
.ccw-l[hidden],.ccw-spin[hidden]{display:none}
.ccw-spin{color:var(--v-clay2);white-space:pre}.ccw-spin .m{color:var(--v-faint)}
.ccw-in{display:flex;align-items:center;gap:8px;margin:10px 14px 0;padding:9px 12px;border:1px solid var(--v-ln2);border-radius:8px;color:var(--v-faint)}
.ccw-in .caret{width:8px;height:15px;background:var(--v-mut)}
.ccw-hint{display:flex;justify-content:space-between;align-items:center;padding:8px 16px 12px;color:var(--v-faint);font-size:11px}.ccw-hint span{display:inline-flex;align-items:center;gap:6px}
@media (prefers-reduced-motion:no-preference){.ccw-in .caret{animation:blink 1.1s steps(1) infinite}
.lhero .kick,.lhero h1,.lhero .lede,.lhero .lcta,.works,.free{animation:lin .7s var(--v-ease) both}.lhero h1{animation-delay:.06s}.lhero .lede{animation-delay:.14s}.lhero .lcta{animation-delay:.22s}.works{animation-delay:.3s}.free{animation-delay:.34s}
.ccw{animation:lin .9s var(--v-ease) .2s both}}
@keyframes blink{50%{opacity:0}}@keyframes lin{from{opacity:0;transform:translate3d(0,16px,0)}}

/* plugin: what it adds to a session, four tiles with a terminal each */
.hero-cmd{max-width:520px;margin:0 0 18px}
.plug{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.plug .tile-cap h4 code{font:500 15px var(--mono);color:var(--v-tx)}.plug .tile-cap h4 small{font:400 11px var(--mono);color:var(--v-faint);text-transform:uppercase;letter-spacing:.08em}
.plug .tile-cap p code,.plug-more code{font:12.5px var(--mono);color:var(--v-tx);background:rgba(255,255,255,.06);border:1px solid var(--v-ln);border-radius:5px;padding:1px 5px}
.mini{display:block;margin:auto 18px 18px;padding:13px 15px;border:1px solid var(--v-ln);border-radius:10px;background:#07080e;color:var(--v-mut);font:12.5px/1.75 var(--mono);white-space:pre;overflow:hidden;text-overflow:ellipsis}
.mini .m{color:var(--v-faint)}.mini .w{color:var(--v-tx)}.mini .c{color:var(--v-clay2)}.mini .g{color:var(--v-ok)}
.mini .band{display:inline-flex;align-items:center;gap:8px}.mini .band b{color:var(--v-tx);font-weight:600}.mini .band .warn{color:#f0b35e}.mini .band .hide{padding:0 6px;border:1px solid var(--v-ln2);border-radius:4px;color:var(--v-mut);line-height:1.5}
.mini .inp{display:flex;align-items:center;gap:8px;margin-top:6px;padding:4px 10px;border:1px solid var(--v-ln2);border-radius:7px}.mini .caret{width:7px;height:14px;background:var(--v-mut)}
.plug-more{margin:22px 0 0;color:var(--v-mut);font-size:14.5px}.plug-more a{color:var(--v-tx);text-underline-offset:3px}
@media(max-width:760px){.plug{grid-template-columns:minmax(0,1fr)}.mini{margin:auto 12px 12px;font-size:11.5px}}
/* pillars: one ruled strip under the hero */
.pillars{position:relative;z-index:2;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));max-width:1192px;margin:0 auto;border-block:1px solid var(--v-ln);box-sizing:border-box}
.pillar{display:flex;flex-direction:column;gap:10px;padding:22px 22px 24px;text-decoration:none;border-left:1px solid var(--v-ln);transition:background .2s ease-out}
.pillar:first-child{border-left:0}.pillar:hover{background:rgba(255,255,255,.025)}
.pillar .ph{display:flex;align-items:center;justify-content:space-between}.pillar svg{width:30px;height:30px}
.pillar .n{font:400 11.5px var(--mono);color:var(--v-faint)}
.pillar h2{display:flex;align-items:center;gap:6px;margin:0;color:var(--v-tx);font-size:16px;font-weight:600;letter-spacing:-.3px}
.pillar h2 i{font-style:normal;color:var(--v-clay);opacity:0;transform:translateX(-6px);transition:opacity .12s ease-out,transform .2s var(--v-spring)}.pillar:hover h2 i{opacity:1;transform:none}
.pillar p{margin:0;color:var(--v-mut);font-size:13.5px;line-height:1.5;text-wrap:pretty}
.land svg .o{fill:none;stroke:var(--v-indigo2);stroke-width:1.4;opacity:.5}.land svg .o.d{stroke-dasharray:2 3}
.land svg .s{fill:none;stroke:var(--v-clay);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.land svg .f{fill:var(--v-clay)}

/* the column */
.frame{position:relative;padding:0 0 40px}
.lsec{max-width:1140px;margin:0 auto;padding:136px 24px 0}
.lsec-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,460px);gap:48px;align-items:end;margin-bottom:56px}
.ey{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;font:400 12.5px var(--mono);color:var(--v-mut);text-transform:lowercase}
.ey b{color:var(--v-clay);font-weight:500}.ey i{font-style:normal;color:var(--v-faint)}
.lword{margin:0;font-size:clamp(60px,9vw,112px);font-weight:600;letter-spacing:-.065em;line-height:.85;color:var(--v-tx)}
.lsec-head h3{margin:0 0 12px;font-size:28px;font-weight:600;letter-spacing:-1px;line-height:1.12}
.lsec-head .r p{margin:0 0 22px;color:var(--v-mut);font-size:15.5px;line-height:1.6;text-wrap:pretty}
.lfeat{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:18px;font-weight:600;letter-spacing:-.4px}
.lfeat-p{margin:0 0 20px;color:var(--v-mut);font-size:15px;line-height:1.55;max-width:72ch}
.lfeat-p a{color:var(--v-clay2);text-underline-offset:3px}
.land .lfeat-p code,.land .lmini code,.land .int-more code{font:12.5px var(--mono);color:var(--v-tx);background:rgba(255,255,255,.06);border:1px solid var(--v-ln);border-radius:5px;padding:1px 5px}
.duo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-top:56px}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;margin-top:48px;border:1px solid var(--v-ln);border-radius:14px}
.lmini{padding:22px 24px}.lmini+.lmini{border-left:1px solid var(--v-ln)}
.lmini .lfeat{font-size:16px}.lmini .lfeat-p{margin:0;font-size:14px}
.lmini .n{font:400 11.5px var(--mono);color:var(--v-faint);margin-left:auto}

/* painted panels, re-tinted for the dark: a glow of indigo or clay and a stipple of light */
.paint{position:relative;overflow:hidden;border-radius:16px;padding:56px 64px 0;isolation:isolate;background:var(--v-bg2);border:1px solid var(--v-ln)}
.paint::before{content:"";position:absolute;inset:0;z-index:-1;background-image:radial-gradient(rgba(236,235,255,.22) .8px,transparent 1.2px);background-size:6px 6px;-webkit-mask:radial-gradient(90% 70% at 50% 0%,#000,transparent 75%);mask:radial-gradient(90% 70% at 50% 0%,#000,transparent 75%)}
.paint.a{background:radial-gradient(90% 80% at 20% 0%,rgba(91,77,255,.38),transparent 65%),radial-gradient(60% 60% at 100% 100%,rgba(38,181,206,.10),transparent 70%),var(--v-bg2)}
.paint.b{background:radial-gradient(70% 70% at 15% 0%,rgba(232,135,95,.30),transparent 65%),radial-gradient(70% 80% at 90% 10%,rgba(91,77,255,.30),transparent 65%),var(--v-bg2)}
.paint.c{background:radial-gradient(90% 80% at 80% 0%,rgba(232,135,95,.26),transparent 65%),radial-gradient(60% 60% at 0% 100%,rgba(91,77,255,.18),transparent 70%),var(--v-bg2)}
.paint.pad{padding:28px}
.sheet{background:#fff;color:var(--ink);border-radius:12px 12px 0 0;padding:24px 28px 8px;box-shadow:0 40px 80px -30px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.1)}
.paint.pad .sheet{border-radius:12px;padding:6px 0}
.sheet .chrome{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;font-size:13px;color:var(--muted)}.sheet .chrome b{color:var(--ink);font:500 13px var(--mono)}
.sheet .chrome .dots{display:flex;gap:6px;margin-right:12px}.sheet .chrome .dots i{width:10px;height:10px;border-radius:50%;background:#e6e7ee}
.sheet .chrome .l{display:flex;align-items:center}
.lex{display:block;text-align:right;font:400 11.5px var(--mono);color:var(--v-faint);margin:12px 2px 0}
.sheet .group{margin-bottom:20px;box-shadow:none}
@media (prefers-reduced-motion:no-preference){.sheet .bars i:last-child{animation:beat 2.4s ease-in-out infinite}}
@keyframes beat{50%{opacity:.45}}

/* costs */
.cost-shot{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:1px;background:var(--line);color:var(--ink);border-radius:12px 12px 0 0;overflow:hidden;box-shadow:0 40px 80px -30px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.1)}
.cost-chart,.cost-runs{background:#fff;padding:24px 26px}
.cost-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}.cost-h b{font-size:24px;font-weight:600;letter-spacing:-.04em}.cost-runs .cost-h b{font-size:15px;letter-spacing:-.02em}.cost-h span{font-size:12.5px;color:var(--faint)}
.cost-cols{display:flex;align-items:flex-end;gap:3px;height:160px}.cc{flex:1;display:flex;flex-direction:column-reverse;height:100%;gap:1px}.cc i{display:block;border-radius:1.5px;min-height:1px}
.cost-leg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:14px;font-size:12.5px;color:var(--muted)}.cost-leg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}.cost-leg b{color:var(--ink);font-weight:500;margin-left:2px}
.cost-runs table{width:100%;border-collapse:collapse;font-size:13.5px}.cost-runs th{text-align:left;font-weight:500;color:var(--faint);font-size:12px;padding:0 0 8px}.cost-runs td{padding:9px 0;border-top:1px solid var(--line)}.cost-runs th:not(:first-child),.cost-runs td:not(:first-child){text-align:right}
.cost-runs code{font:12.5px var(--mono);color:var(--ink)}.cost-runs small{color:var(--faint);margin-left:8px;font-size:11.5px}.cost-runs td b{font-weight:600}
.cost-alarm{display:flex;align-items:center;gap:8px;margin:14px 0 0;padding:9px 12px;border-radius:9px;background:#fff4ea;color:#8a5a12;font-size:12.5px}.cost-alarm i{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none}.cost-alarm b{font-weight:600}

/* sources */
.int-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.int{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:12px;background:#fff;color:var(--ink);box-shadow:0 24px 50px -28px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.08)}
.int-m{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;margin-bottom:6px}.int-m svg,.int-m img{width:20px;height:20px}
.int-m .wm{color:#fff;font:800 14px/1 var(--f);letter-spacing:-.02em;position:relative}.int-m .wm::after{content:"";position:absolute;left:1px;right:2px;bottom:-5px;height:3px;border-radius:0 0 6px 6px;border-bottom:2px solid #ff9900}
.int b{font-weight:600;font-size:15px;letter-spacing:-.3px}.int-t{color:var(--muted);font-size:13.5px;line-height:1.45}
.sheet .line{padding:13px 20px}.sheet .line .meta{white-space:normal;text-align:right;max-width:58%}.sheet .line code{font:12.5px var(--mono)}
.int-more{margin:20px 0 0;color:var(--v-mut);font-size:14px;line-height:1.55}

/* start: the title on the left, three numbered steps on the right, then the self-host path */
.inst{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,660px);gap:56px;align-items:start}
.inst-l h2{margin:0 0 16px;font-size:52px;font-weight:600;letter-spacing:-.05em;line-height:1;color:var(--v-tx)}.inst-l p{margin:0;color:var(--v-mut);font-size:15.5px;line-height:1.6;max-width:36ch}
.inst-l .free{margin-top:22px;font-size:13px}
.steps{list-style:none;margin:0;padding:0;border:1px solid var(--v-ln);border-radius:14px;background:rgba(17,18,28,.6)}
.steps>li{display:grid;grid-template-columns:28px minmax(0,1fr);gap:16px;padding:22px 24px}.steps>li+li{border-top:1px solid var(--v-ln)}
.steps .n{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;border:1px solid rgba(232,135,95,.45);color:var(--v-clay2);font:500 12.5px var(--mono)}
.steps h3{margin:3px 0 8px;font-size:18px;font-weight:600;letter-spacing:-.4px}
.steps p{margin:0 0 12px;color:var(--v-mut);font-size:14.5px;line-height:1.55}.steps p:last-child{margin-bottom:0}
.land .steps code,.land .own code{font:12.5px var(--mono);color:var(--v-tx);background:rgba(255,255,255,.06);border:1px solid var(--v-ln);border-radius:5px;padding:1px 5px}
.steps .lcta{align-items:center;margin-bottom:12px}.steps .lcta .lp{min-height:40px;padding:0 18px;font-size:14px}
.steps .alt-link{font:400 13px var(--mono);color:var(--v-mut);text-underline-offset:3px}.steps .alt-link:hover{color:var(--v-tx)}
.cmdb{position:relative;display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:13px 48px 13px 14px;border-radius:10px;background:#07080e;border:1px solid var(--v-ln);color:#e9e8f0;font:12.5px/1.5 var(--mono);overflow-x:auto;white-space:nowrap}
.cmdb .p{color:var(--v-faint)}.cmdb .h{color:var(--v-clay)}.cmdb .k{color:var(--v-indigo2)}
.cmdb .cp,.own-t .cp{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:7px;background:rgba(255,255,255,.06);color:#c4c7d4;cursor:pointer}.cmdb .cp:hover,.own-t .cp:hover{background:rgba(255,255,255,.12)}.cmdb .cp svg,.own-t .cp svg{width:14px;height:14px}
.cmdb .cp[data-done],.own-t .cp[data-done]{color:var(--v-ok)}.cmdb[hidden]{display:none}
/* run your own */
.own{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,660px);gap:56px;align-items:center;margin-top:28px;padding:28px;border:1px dashed var(--v-ln2);border-radius:16px}
.own h3{display:flex;align-items:center;gap:10px;margin:0 0 10px;font-size:22px;font-weight:600;letter-spacing:-.6px;color:var(--v-tx)}.own h3 svg{width:20px;height:20px;flex:none}
.own p{margin:0 0 18px;color:var(--v-mut);font-size:14.5px;line-height:1.6;max-width:42ch}
.own-t{position:relative;border:1px solid var(--v-ln);border-radius:12px;background:#07080e;overflow:hidden}
.own-t .ccw-bar{padding:9px 12px}
.own-t pre{margin:0;padding:14px 16px 16px;font:12.5px/1.75 var(--mono);color:#d9d8e3;background:none;border:0;white-space:pre;overflow-x:auto}
.own-t pre .p{color:var(--v-faint)}.own-t pre .m{color:var(--v-faint)}.own-t pre .c{color:var(--v-clay2)}
.own-t .cp{top:6px;transform:none;width:26px;height:26px}
@media(max-width:980px){.inst,.own{grid-template-columns:minmax(0,1fr);gap:28px}.inst-l h2{font-size:40px}}

/* closing */
.end{max-width:1140px;margin:136px auto 0;padding:0 24px;text-align:center}
.end .mk{width:48px;height:48px;margin:0 auto 22px;display:block}
.end h2{margin:0;color:var(--v-tx);font-size:clamp(44px,7vw,88px);font-weight:600;letter-spacing:-.06em;line-height:.95}.end h2 em{font-style:normal;color:var(--v-clay)}
.end p{margin:20px auto 30px;color:var(--v-mut);font-size:16px;max-width:46ch}
.end .lcta{justify-content:center}.end .free{justify-content:center;margin-top:22px}
.lfoot{max-width:1140px;margin:112px auto 0;padding:22px 24px 0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;color:var(--v-faint);font:400 12.5px var(--mono);border-top:1px solid var(--v-ln)}
.lfoot .logo{display:inline-flex;align-items:center;gap:8px;color:var(--v-tx);font:600 15px var(--f);text-decoration:none}
.lfoot a{color:var(--v-mut);text-underline-offset:3px}.lfoot a:hover{color:var(--v-tx)}.lfoot i{font-style:normal;margin:0 8px}

/* tools: one quiet row of logos */
.tools{max-width:1140px;margin:0 auto;padding:72px 24px 0;text-align:center}
.tools p{margin:0 0 26px;font:400 12.5px var(--mono);color:var(--v-faint);text-transform:lowercase}
.tools ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;justify-content:center;gap:16px 32px}
.tools li{display:inline-flex;align-items:center;gap:9px;color:var(--v-mut);font-size:14.5px;font-weight:500;letter-spacing:-.3px}
.tools li img{width:18px;height:18px;filter:invert(1);opacity:.55}
.tools li i{display:grid;place-items:center;width:18px;height:18px;border-radius:5px;background:var(--v-mut);color:var(--v-bg);font:700 11px/1 var(--f);font-style:normal;opacity:.6}
@media(max-width:760px){.tools{padding:56px 16px 0}.tools ul{gap:12px 20px}.tools li{font-size:13.5px}}
@media(max-width:1080px){.lhero-in{grid-template-columns:minmax(0,1fr);gap:48px;padding:112px 20px 80px}.lhero h1{font-size:60px}.ccw{max-width:620px}
.pillars{grid-template-columns:repeat(2,minmax(0,1fr));margin:0 20px}.pillar{border-left:0;border-top:1px solid var(--v-ln)}.pillar:nth-child(even){border-left:1px solid var(--v-ln)}.pillar:nth-child(-n+2){border-top:0}.pillar:last-child{grid-column:1/-1}}
@media(max-width:980px){.lsec-head{grid-template-columns:minmax(0,1fr);gap:20px;margin-bottom:40px}
.duo,.trio{grid-template-columns:minmax(0,1fr)}.lmini+.lmini{border-left:0;border-top:1px solid var(--v-ln)}.paint{padding:32px 20px 0}}
@media(max-width:760px){.lnav-in{padding:10px 14px}.lnav-r a.t,.lnav .lp.alt{display:none}
.lhero-in{padding:96px 16px 64px}.lhero h1{font-size:46px}.lhero .lede{font-size:16.5px}.kick{font-size:11.5px}
.ccw{font-size:11px}.ccw-body{padding:14px 12px 4px}.ccw-in{margin:8px 10px 0}
.pillars{grid-template-columns:minmax(0,1fr);margin:0 16px}.pillar,.pillar:nth-child(even){border-left:0;border-top:1px solid var(--v-ln)}.pillar:first-child{border-top:0}.pillar:nth-child(2){border-top:1px solid var(--v-ln)}.pillar{padding:18px 4px}
.lsec{padding:96px 16px 0}.cost-shot{grid-template-columns:minmax(0,1fr)}.cost-chart,.cost-runs{padding:18px 16px}.cost-cols{height:110px;gap:2px}
.sheet{padding:16px 14px 4px}.sheet .line{flex-direction:column;gap:2px}.sheet .line .meta{text-align:left;max-width:none}.int-grid{grid-template-columns:minmax(0,1fr)}
.steps>li{grid-template-columns:minmax(0,1fr);gap:10px;padding:20px 16px}.own{padding:18px 14px}.lcta .lp{flex:1 1 auto}.end{margin-top:96px;padding:0 16px}.lfoot{margin-top:80px;padding:20px 16px 0}}

/* bento: the status page big, and around it what's running, the monitors, the code merged and the report */
.bento{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.tile{position:relative;display:flex;flex-direction:column;min-width:0;border-radius:16px;overflow:hidden;background:var(--v-bg2);border:1px solid var(--v-ln)}
.tile-cap{padding:22px 24px 18px}.tile-cap h4{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:16px;font-weight:600;letter-spacing:-.35px;color:var(--v-tx)}.tile-cap p{margin:0;color:var(--v-mut);font-size:14px;line-height:1.5;text-wrap:pretty}
.b-status{grid-column:1/3;grid-row:1/3}.b-live{grid-column:3;grid-row:1}.b-mon{grid-column:3;grid-row:2}.b-code{grid-column:1/3;grid-row:3}.b-rep{grid-column:3;grid-row:3}
.tile.paint{padding:0}.b-status .tile-cap{padding:26px 28px 22px}.b-status .sheet{margin:auto 28px 0}
/* live: the topbar and the panel it opens */
.b-live{background:radial-gradient(90% 70% at 100% 0%,rgba(232,135,95,.18),transparent 70%),var(--v-bg2)}
.live-ui{margin:auto 16px 0;background:#fff;color:var(--ink);border-radius:12px 12px 0 0;box-shadow:0 30px 60px -30px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.1);overflow:hidden}
.mini-tb{display:flex;align-items:center;gap:10px;height:40px;padding:0 10px 0 12px;border-bottom:1px solid var(--line);font-size:12.5px}
.mini-tb .logo{font-size:13px;gap:6px;color:var(--ink)}.mini-tb .logo .mk{width:15px;height:15px;color:#d9673c}.mini-tb .logo .wm b{color:#d9673c}.mini-tb .crumb{color:var(--muted);flex:1;font:12px var(--mono)}
.mini-tb .tb-acts{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid var(--line);border-radius:7px;font:500 12px var(--f);background:rgba(15,16,20,.04)}.mini-tb .tb-ai{display:inline-flex}.mini-tb .gi,.lj .gi{width:13px;height:13px;margin:0}.mini-tb .tb-n{color:var(--warn);font-weight:600;font-variant-numeric:tabular-nums}.mini-tb .tb-n:empty{display:none}
.live-pop{padding:10px 12px 6px}.live-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12.5px}.live-hd .live-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);margin:0}.live-meta{color:var(--faint);font-size:11.5px}
.lj-list{list-style:none;margin:0;padding:0}
.lj{display:grid;grid-template-columns:16px minmax(0,1fr) auto;grid-template-areas:"i n t" "i s s" ". b b";gap:1px 8px;align-items:center;padding:8px 0;border-top:1px solid var(--line2);font-size:12.5px}
.lj:first-child{border-top:0}.lj-i{grid-area:i;display:inline-flex;align-self:start;margin-top:2px}.lj-n{grid-area:n;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lj-n b{font:500 12.5px var(--mono)}.lj-n small{color:var(--faint);margin-left:7px;font-size:11.5px}
.lj-s{grid-area:s;color:var(--muted);font-size:11.5px}.lj-s em{font-style:normal;color:var(--faint)}.lj-t{grid-area:t;color:var(--muted);font:11.5px var(--mono);font-variant-numeric:tabular-nums}
.lj-bar{grid-area:b;height:3px;border-radius:2px;background:var(--empty);overflow:hidden;margin-top:4px}.lj-bar i{display:block;height:100%;background:var(--warn);border-radius:2px;transition:width .6s var(--v-spring)}
.lj[data-st=ok] .lj-bar i{background:var(--ok)}.lj[data-st=ok] .lj-s{color:var(--ok)}.lj[data-st=q]{opacity:.7}
@media (prefers-reduced-motion:no-preference){.lj[data-st=ok]{animation:ljok 1.2s ease-out}}@keyframes ljok{from{background:#eaf7ef}}
/* monitors */
.b-mon{background:radial-gradient(80% 60% at 0% 100%,rgba(91,77,255,.16),transparent 70%),var(--v-bg2)}
.mt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:auto 16px 16px}
.mt{padding:12px;border-radius:10px;background:#fff;color:var(--ink);box-shadow:0 14px 30px -20px rgba(0,0,0,.9)}.mt-h{display:flex;justify-content:space-between;align-items:baseline;gap:6px}.mt-h .mon-id{font-size:12px}.mt .state{font-size:11.5px}
.mt>b{display:block;margin:6px 0 2px;font-size:22px;font-weight:600;letter-spacing:-.04em}.mt[data-s=bad]>b{color:var(--bad)}.mt .bars{height:18px;gap:1.5px;margin-top:6px}
/* code */
.b-code{background:radial-gradient(70% 70% at 0% 0%,rgba(95,211,148,.12),transparent 70%),radial-gradient(60% 60% at 100% 100%,rgba(91,77,255,.14),transparent 70%),var(--v-bg2)}
.code-ui{margin:auto 16px 16px;padding:22px 24px 16px;background:#fff;color:var(--ink);border-radius:12px;box-shadow:0 30px 60px -30px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.1)}
.code-big{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 14px}.code-big>b{font-size:56px;font-weight:600;letter-spacing:-.06em;line-height:1}.code-big>span{color:var(--muted);font-size:14px}.code-big .loc{font:500 14px var(--mono)}.code-big .add{color:var(--ok)}.code-big .del{color:var(--bad)}
.code-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin:18px 0 18px;background:var(--line);border-radius:10px;overflow:hidden}
.code-stats span{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:#f8f8fb;font-size:12px;color:var(--muted)}.code-stats b{font-size:18px;font-weight:600;letter-spacing:-.03em;color:var(--ink)}
.m-cols{display:flex;gap:3px;height:210px}.mc{flex:1;display:grid;grid-template-rows:72% 28%;gap:2px}.mc span{display:flex}.mc .up{align-items:flex-end}.mc .dn{align-items:flex-start}.mc i{display:block;width:100%;border-radius:2px}.mc .up i{background:var(--ok)}.mc .dn i{background:var(--bad);opacity:.75}
.code-ui .axis{margin-top:8px}
/* report: the email as it lands */
.b-rep{background:radial-gradient(90% 70% at 50% 100%,rgba(232,135,95,.16),transparent 70%),var(--v-bg2)}
.rep{margin:auto 16px 0}.rep-card{background:#fff;border-radius:14px 14px 0 0;overflow:hidden;font-family:Inter,var(--f);box-shadow:0 30px 60px -30px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.1)}
.rep-band{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#faf9f6;border-bottom:1px solid #e8e4dc;font-size:13px;color:#111113}.rep-h{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:#111113;color:#e8875f}.rep-h .mk{width:16px;height:16px}
.rep-in{padding:16px 16px 12px}.rep-pill{display:inline-block;padding:3px 10px;border-radius:999px;background:#fdf1e1;color:#b45309;font-size:11.5px;font-weight:600}
.rep-hl{margin:10px 0 2px;font-size:21px;font-weight:700;letter-spacing:-.03em;color:#111113}.rep-sub{margin:0;color:#55555c;font-size:12.5px}
.rep-eb{margin:16px 0 7px;font:500 10px var(--mono);text-transform:uppercase;letter-spacing:.14em;color:#8a8a92}
.rep-strip{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);background:#f6f4f0;border-radius:10px}.rep-strip span{display:flex;flex-direction:column;padding:9px 11px;font-size:11px;color:#55555c}.rep-strip b{font-size:15px;font-weight:700;color:#111113;letter-spacing:-.02em}.rep-strip small{color:#8a8a92;font-size:10.5px}.rep-strip small.bad{color:#c0271d}
.rep-strip i{font-style:normal}.rep-strip .g{color:#0f7a45}.rep-strip .r{color:#c0271d}
.rep-l{list-style:none;margin:8px 0 0;padding:0}.rep-l li{display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:12.5px;color:#111113}.rep-l li::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:#0f7a45;transform:translateY(-1px)}.rep-l li[data-t=alert]::before{background:#c0271d}.rep-l li[data-t=warn]::before{background:#b45309}
.rep-l li span{flex:1;min-width:0}.rep-l em{font-style:normal;color:#8a8a92;font-size:11.5px;white-space:nowrap}
/* the factory in 3D */
.f3{position:relative;height:min(700px,78vh);border-radius:16px;overflow:hidden;background:radial-gradient(80% 70% at 50% 30%,#2a2547 0,#141526 70%,#0d0e18 100%);border:1px solid var(--v-ln);box-shadow:0 50px 100px -50px rgba(0,0,0,.9)}
.f3 canvas{display:block;width:100%!important;height:100%!important;cursor:grab}.f3 canvas:active{cursor:grabbing}
.f3-stat{position:absolute;left:18px;top:16px;z-index:2;display:flex;flex-direction:column;padding:12px 16px;border-radius:10px;background:rgba(11,12,20,.72);backdrop-filter:blur(10px);border:1px solid var(--v-ln2);pointer-events:none}
.f3-stat b{font:500 30px/1 var(--mono);letter-spacing:-.04em;font-variant-numeric:tabular-nums;color:var(--v-tx)}.f3-stat span{color:var(--v-mut);font:400 11.5px var(--mono);margin-top:6px}
.f3-leg{position:absolute;right:16px;top:16px;z-index:2;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;pointer-events:none}.f3-leg span{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:7px;background:rgba(11,12,20,.72);backdrop-filter:blur(10px);font:400 11.5px var(--mono);color:var(--v-tx);border:1px solid var(--v-ln2)}.f3-leg i{width:9px;height:9px;border-radius:3px}
.f3 .map-tip[hidden]{display:none}.f3-tag{position:absolute;left:0;top:0;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.9);box-shadow:0 2px 10px rgba(0,0,0,.3);font:500 11.5px var(--mono);color:#191e2d;white-space:nowrap;pointer-events:none}.f3-tag.bad{background:#e5484d;color:#fff}
.f3-hint{position:absolute;left:18px;bottom:14px;z-index:2;display:inline-flex;align-items:center;gap:8px;font:400 11.5px var(--mono);color:rgba(255,255,255,.85);text-shadow:0 1px 3px rgba(0,0,0,.6);pointer-events:none}
@media(max-width:980px){.bento{grid-template-columns:minmax(0,1fr)}.bento>.tile{grid-column:auto;grid-row:auto}.b-status .sheet{margin:auto 12px 0}.code-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.code-big>b{font-size:44px}.f3{height:460px}.f3-leg{display:none}}
</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script></head><body class="land">

<nav class="lnav" id="lnav" aria-label="Main"><div class="lnav-in"><a class="logo" href="/" aria-label="Type V, home">${WORDMARK(24)}</a>
  <span class="lnav-r"><a class="t" href="#plugin">plugin</a><a class="t" href="#status">status</a><a class="t" href="#costs">costs</a><a class="t" href="#factory">factory</a><a class="t" href="#sources">sources</a><a class="t" href="#install">start</a><a class="t" href="${REPO}" target="_blank" rel="noopener" data-track="nav:github">github</a>
  ${viewer ? `<a class="lp alt" href="/landing">${esc(viewer)}</a><a class="lp pri" href="/">Enter <span aria-hidden="true">→</span></a>` : `<a class="lp alt" href="/auth/login" data-track="nav:signin">Sign in</a><a class="lp pri" href="${esc(install)}" data-track="cta:nav-start">Start free</a>`}</span>
</div></nav>

<header class="lhero" id="hero">
  <canvas id="stars" aria-hidden="true"></canvas>
  <div class="lhero-in">
    <div>
      <p class="kick"><b>${MARKV(13)}Type V</b>a Claude Code plugin</p>
      <h1>For a new class of developer. <em>Accelerate.</em></h1>
      <p class="lede">A Claude Code plugin that watches the factory your agents run: which routines ran, which went silent, and what each one cost.</p>
      <div class="cmdb hero-cmd"><span class="p">&gt;</span><span data-cmd>/plugin install typev --marketplace humanagent/typev</span>${copyBtn}</div>
      ${cta("hero")}
      <div class="works"><span>Plugin for</span><span class="hn"><span class="lg" style="--u:url(${SI("16.32.0", "claude")})" aria-hidden="true"></span>Claude Code</span><span class="hn soon"><img src="${SI("13.21.0", "openai")}" alt="" width="16" height="16">Codex <em>soon</em></span></div>
      <p class="free"><span class="ck" aria-hidden="true">✓</span><b>Free</b><i aria-hidden="true">·</i><b>Open source</b> (MIT)<i aria-hidden="true">·</i><b>Self-host it</b></p>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    </div>
    <div class="ccw" id="ccw" role="img" aria-label="An example Claude Code session: the Type V plugin is installed, then /typev:setup reads the repo, lists the monitors it will create, opens PR #142 with 5 skills and 3 workflows, and ends with a green check.">
      <div class="ccw-bar" aria-hidden="true"><i></i><i></i><i></i><span>~/acme/api</span><span>claude</span></div>
      <div class="ccw-body" aria-hidden="true">
        <div class="ccw-wel"><span class="sp">✳</span> <b>Welcome to Claude Code</b><br><span class="m">  cwd: ~/acme/api</span></div>
        <div class="ccw-l in"><span class="pr">&gt;</span> <span data-type="/plugin install typev --marketplace humanagent/typev">/plugin install typev --marketplace humanagent/typev</span></div>
        <div class="ccw-l" data-step data-wait="900"><span class="m">  ⎿  </span><span class="g">✓</span> Installed typev. Plugin is now active.</div>
        <div class="ccw-l in" data-step data-wait="400"><span class="pr">&gt;</span> <span data-type="/typev:setup fsk_…">/typev:setup fsk_…</span></div>
        <div class="ccw-l" data-step data-spin="Reading the repo" data-wait="1500"><span class="w">⏺</span> Read the repo</div>
        <div class="ccw-l" data-step data-wait="250"><span class="m">  ⎿  </span>Sentry in 2 apps · 12 skills · 6 workflows · <span class="c">no monitors</span></div>
        <div class="ccw-l" data-step data-spin="Choosing monitors" data-wait="1300"><span class="w">⏺</span> Monitors it will create</div>
        <div class="ccw-l" data-step data-wait="160"><span class="m">  ⎿  </span><span class="w">typev-monitor-errors</span>  <span class="m">routine </span> <span class="ix">0 13 * * *</span></div>
        <div class="ccw-l" data-step data-wait="160"><span class="m">     </span><span class="w">typev-monitor-logs</span>    <span class="m">routine </span> <span class="ix">0 13 * * *</span></div>
        <div class="ccw-l" data-step data-wait="160"><span class="m">     </span><span class="w">typev-monitor-cost</span>    <span class="m">routine </span> <span class="ix">0 13 * * *</span></div>
        <div class="ccw-l" data-step data-wait="160"><span class="m">     </span><span class="w">typev-report</span>          <span class="m">routine </span> <span class="ix">0 14 * * *</span></div>
        <div class="ccw-l" data-step data-wait="160"><span class="m">     </span><span class="w">typev-pulse</span>           <span class="m">workflow</span> <span class="ix">0 19 * * *</span></div>
        <div class="ccw-l" data-step data-spin="Writing skills and workflows" data-wait="1700"><span class="w">⏺</span> Opened <span class="c">PR #142</span> · 5 skills, 3 workflows</div>
        <div class="ccw-l ok" data-step data-wait="700">✓ Factory ready · 5 monitors watching acme/api</div>
      </div>
      <div class="ccw-in" aria-hidden="true"><span>&gt;</span><span class="caret"></span></div>
      <div class="ccw-hint" aria-hidden="true"><span><kbd>?</kbd> for shortcuts</span><span><kbd>esc</kbd> to interrupt</span></div>
    </div>
  </div>
</header>

<nav class="pillars" aria-label="What it shows">${PILLARS.map(([href, ic, t, p], i) => `<a class="pillar" href="${href}"><span class="ph">${ICONS[ic]}<span class="n">0${i + 1}</span></span><h2>${t}<i aria-hidden="true">→</i></h2><p>${p}</p></a>`).join("")}</nav>

<main class="frame">

<section class="tools" id="tools" aria-label="Works with">
  <p>&gt; works with the tools you already use</p>
  <ul>${TOOLS.map(([name, logo]) => `<li>${logo ? `<img src="${logo}" alt="" loading="lazy" width="18" height="18">` : `<i aria-hidden="true">${name[0]}</i>`}${name}</li>`).join("")}</ul>
</section>

<section class="lsec" id="plugin">
  <div class="lsec-head">
    <div>${ey("01", "claude code plugin")}<h2 class="lword">Plugin</h2></div>
    <div class="r"><h3>It lives in Claude Code</h3><p>Type V is a Claude Code plugin, open source, installed in one line. It adds four things to your sessions, and writes the one hook your routines need into the repo, since a routine runs on a fresh clone.</p>
      <div class="cmdb"><span class="p">&gt;</span><span data-cmd>/plugin install typev --marketplace humanagent/typev</span>${copyBtn}</div></div>
  </div>
  <div class="plug">
    <div class="tile"><div class="tile-cap"><h4><code>/typev:setup</code> <small>skill</small></h4><p>Reads the repo, proposes monitors, a daily report and a pulse, and opens one PR. After the merge it creates the routines.</p></div>
      <div class="mini"><span class="m">&gt;</span> <span class="w">/typev:setup fsk_…</span>
<span class="w">⏺</span> Opened <span class="c">PR #142</span> · 5 skills, 3 workflows
<span class="g">✓</span> Factory ready · 5 monitors watching acme/api</div></div>
    <div class="tile"><div class="tile-cap"><h4>Above the prompt <small>mod</small></h4><p>What needs a look, where you already are. Silent when all is clear. <code>/typev</code> says the rest.</p></div>
      <div class="mini"><span class="band"><b>Type V</b> <span class="warn">typev-report missed its last run</span> <span class="m">/typev</span> <span class="hide">Hide</span></span>
<span class="inp"><span class="m">&gt;</span> <span class="caret"></span></span></div></div>
    <div class="tile"><div class="tile-cap"><h4><code>/typev:sweep</code> <small>workflow</small></h4><p>Runs every monitor now. A finding becomes an issue only after two skeptics fail to refute it.</p></div>
      <div class="mini"><span class="m">&gt;</span> <span class="w">/typev:sweep</span>
<span class="w">⏺</span> 3 monitors · 4 findings · <span class="m">3 refuted</span>
<span class="g">✓</span> Filed <span class="c">#311</span> · heartbeats sent</div></div>
    <div class="tile"><div class="tile-cap"><h4><code>/typev:mend</code> <small>workflow</small></h4><p>The fixer. A test that fails first, the smallest fix, one PR per issue. It never merges.</p></div>
      <div class="mini"><span class="m">&gt;</span> <span class="w">/typev:mend</span>
<span class="w">⏺</span> <span class="c">#311</span> → <span class="c">PR #312</span> · 1 test, 4 lines
<span class="g">✓</span> Fails without the fix, passes with it</div></div>
  </div>
  <p class="plug-more">Also <code>/typev:new-monitor</code>, a monitor for any source from one line. Every file is in <a href="${REPO}/tree/main/plugin" target="_blank" rel="noopener" data-track="plugin:source">plugin/</a> on GitHub.</p>
</section>

<section class="lsec" id="status">
  <div class="lsec-head">
    <div>${ey("02", "monitors")}<h2 class="lword">Status</h2></div>
    <div class="r"><h3>The monitor of the monitors</h3><p>A dead monitor and a healthy system both look like silence. Every routine leaves a heartbeat when it ends, and Type V checks them against your roster.</p>${cta("status")}</div>
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
        <div class="mini-tb"><span class="logo">${WORDMARK(15)}</span><span class="crumb">acme/api</span><span class="tb-acts" data-on="1"><span class="tb-ai">${SPIN}</span><span>Actions</span><span class="tb-n">${LIVE.length}</span></span></div>
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
        <div class="rep-band"><span class="rep-h">${MARKV(16)}</span><b>Daily factory report</b></div>
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
  <span class="lex">example with invented data</span>
  <div class="trio">
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("auto")} Connect GitHub <span class="n">01</span></h3><p class="lfeat-p">Install the app on your account or your organization. Pick one repo, a few, or all of them, and change it later.</p></div>
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("beat")} Your routines report <span class="n">02</span></h3><p class="lfeat-p">One command installs a hook: every Claude Code routine reports itself when it ends.</p></div>
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("doc")} You read one page <span class="n">03</span></h3><p class="lfeat-p">Next run, tokens and state for every skill. It refreshes on its own.</p></div>
  </div>
</section>

<section class="lsec" id="costs">
  <div class="lsec-head">
    <div>${ey("03", "tokens and costs")}<h2 class="lword">Costs</h2></div>
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
  <span class="lex">example with invented data</span>
</section>

<section class="lsec" id="factory">
  <div class="lsec-head">
    <div>${ey("04", "in 3d")}<h2 class="lword">Factory</h2></div>
    <div class="r"><h3>Your software factory, in 3D</h3><p>Every component is a hall. Routines are the robot arms, agents are the workers, and every PR is a crate that rides the belt through the CI gates into main. Monitors are the light towers: the failing one flashes red.</p></div>
  </div>
  <div class="f3" id="f3">
    <div class="map-layer"></div><div class="map-tip" hidden></div>
    <div class="f3-stat"><b id="f3-n">112</b><span>PRs merged today</span></div>
    <div class="f3-leg"><span><i style="background:#5b4dff"></i>Components</span><span><i style="background:#f28c28"></i>Routines</span><span><i style="background:#262a35;box-shadow:0 0 0 1px rgba(255,255,255,.3)"></i>CI gates</span><span><i style="background:#3ccf78"></i>Monitors</span><span><i style="background:#f7f7f5"></i>Agents</span></div>
    <span class="f3-hint">Drag to turn it</span>
  </div>
  <span class="lex">example with invented data</span>
  <script type="application/json" id="f3-data">${JSON.stringify(FACTORY)}</script>
</section>

<section class="lsec" id="sources">
  <div class="lsec-head">
    <div>${ey("05", "read-only")}<h2 class="lword">Sources</h2></div>
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
    <div class="inst-l">${ey("06", "start")}<h2>Start in a minute</h2><p>Connect GitHub on the hosted instance and let Claude Code build the factory it will watch. Or run the whole thing yourself: same code, MIT.</p>
      <p class="free"><span class="ck" aria-hidden="true">✓</span><b>Free</b><i aria-hidden="true">·</i><b>Open source</b> (MIT)<i aria-hidden="true">·</i><b>Self-host it</b></p></div>
    <ol class="steps">
      <li><span class="n">1</span><div>
        <h3>Connect GitHub</h3>
        <p>Install the GitHub App on your account or organization and pick one repo, a few or all of them. It only reads.</p>
        <div class="lcta">${start("install")}${viewer ? "" : `<a class="alt-link" href="/auth/login" data-track="install:signin">or sign in</a>`}</div>
      </div></li>
      <li><span class="n">2</span><div>
        <h3>Add the plugin to Claude Code</h3>
        <div class="cmdb"><span class="p">&gt;</span><span data-cmd>/plugin install typev --marketplace humanagent/typev</span>${copyBtn}</div>
        <p>Once per machine. It brings <code>/typev:setup</code>, what needs a look above the prompt, and <code>/typev:sweep</code> and <code>/typev:mend</code> for a sweep or a fix on demand.</p>
      </div></li>
      <li><span class="n">3</span><div>
        <h3>Let it build the factory</h3>
        <div class="cmdb"><span class="p">&gt;</span><span data-cmd>/typev:setup <span class="k">&lt;ingest-key&gt;</span></span>${copyBtn}</div>
        <p>At the repo root, with the key you get once the repo is connected. It writes the heartbeat hook into <code>.claude/</code>, proposes monitors, a daily report and a pulse, and opens one PR with new <code>typev-*</code> skills and workflows. After the merge it creates the Claude Code routines and runs each once.</p>
      </div></li>
    </ol>
  </div>
  <div class="own" id="self-host">
    <div>
      <h3>${GITHUB_I} Run your own</h3>
      <p>One Node server and a database: SQLite on a volume, or Postgres. No license key, nothing phones home. Deploy it on Fly, then create your own GitHub App from <code>/setup</code>.</p>
      <div class="lcta">${own("install")}</div>
    </div>
    <div class="own-t" aria-label="Commands to run your own">
      <div class="ccw-bar" aria-hidden="true"><i></i><i></i><i></i><span>~</span></div>
      <pre data-own><span class="p">$</span> git clone ${REPO} &amp;&amp; cd typev/status
<span class="p">$</span> npm install &amp;&amp; DATA_DIR=./data SECRET=dev SETUP_TOKEN=dev npm start
<span class="m">  factory-status on :8080</span>
<span class="p">$</span> fly launch <span class="m"># your own app, with a volume on /data</span>
<span class="p">$</span> open https://&lt;your-app&gt;.fly.dev/setup?t=<span class="c">$SETUP_TOKEN</span></pre>
      <button class="cp" type="button" aria-label="Copy commands" data-copy-own>${COPY_I}</button>
    </div>
  </div>
</section>

<section class="end" aria-label="Start">
  ${MARKV(48)}
  <h2>For a new class of developer. <em>Accelerate.</em></h2>
  <p>Know what your agents did today, what went silent and what it cost, before anyone asks.</p>
  ${cta("end")}
  <p class="free"><span class="ck" aria-hidden="true">✓</span><b>Free</b><i aria-hidden="true">·</i><b>Open source</b> (MIT)<i aria-hidden="true">·</i><b>Self-host it</b></p>
</section>

<footer class="lfoot"><span><a class="logo" href="/" aria-label="Type V, home">${WORDMARK(18)}</a></span><span>open source, MIT<i>·</i><a href="${REPO}" target="_blank" rel="noopener" data-track="foot:github">github.com/humanagent/typev</a><i>·</i>${viewer ? `<a href="/">Enter as ${esc(viewer)}</a>` : `<a href="/auth/login" data-track="foot:signin">Sign in</a>`}</span></footer>
</main>

${viewer ? "" : `<script>
// First-party analytics, dogfooding: views, clicks and how far each section is read go to
// /api/track as beacons. An anonymous random id in localStorage, no cookies, nothing personal.
(() => {
  let aid; try { aid = localStorage.getItem("typev_aid") || (localStorage.setItem("typev_aid", aid = crypto.randomUUID()), aid); } catch { aid = "nostore"; }
  const q = new URLSearchParams(location.search), utm = {};
  for (const k of ["source", "medium", "campaign", "term", "content"]) if (q.get("utm_" + k)) utm[k] = q.get("utm_" + k).slice(0, 100);
  const sec = (el) => { const s = el && el.closest("section[id],header[id],nav[id],footer"); return s ? s.id || s.tagName.toLowerCase() : ""; };
  const track = window.typevTrack = (type, o = {}) => {
    const b = JSON.stringify({ aid, type, path: location.pathname, ref: document.referrer, utm, vw: innerWidth, ...o });
    try { navigator.sendBeacon ? navigator.sendBeacon("/api/track", new Blob([b], { type: "text/plain" })) : fetch("/api/track", { method: "POST", body: b, keepalive: true }); } catch {}
  };
  track("view");
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("a,button,[data-track]"); if (!el) return;
    const label = el.dataset.track || el.getAttribute("aria-label") || el.textContent.replace(/\\s+/g, " ").trim().slice(0, 60);
    track("click", { label, href: el.getAttribute("href") || "", section: sec(el) });
  }, { capture: true });
  // scroll depth: once per section, when its top reaches the middle of the screen
  const seen = new Set(), io = new IntersectionObserver((es) => es.forEach((x) => {
    if (!x.isIntersecting || seen.has(x.target.id)) return; seen.add(x.target.id); io.unobserve(x.target); track("scroll", { label: x.target.id, section: x.target.id });
  }), { rootMargin: "0px 0px -50% 0px" });
  document.querySelectorAll("header.lhero[id],section[id]").forEach((s) => io.observe(s));
})();
</script>`}
<script>
// Install: copy copies.
(() => {
  const done = (b) => { b.dataset.done = ""; setTimeout(() => delete b.dataset.done, 1400); };
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const box = b.closest(".cmdb");
    try { await navigator.clipboard.writeText(box.querySelector("[data-cmd]").textContent); done(b); } catch {}
  }));
  document.querySelectorAll("[data-copy-own]").forEach((b) => b.addEventListener("click", async () => {
    const lines = b.parentElement.querySelector("[data-own]").textContent.split("\\n").filter((l) => l.startsWith("$ ")).map((l) => l.slice(2).replace(/\\s+#.*$/, ""));
    try { await navigator.clipboard.writeText(lines.join("\\n")); done(b); } catch {}
  }));
})();
// Nav gets its ink and hairline once the hero has scrolled a little.
(() => { const n = document.getElementById("lnav"); const f = () => n.dataset.s = scrollY > 40 ? "1" : "0"; addEventListener("scroll", f, { passive: true }); f(); })();
// The hero's sky: a sparse starfield, then the lit limb of a planet rising from the bottom edge,
// ordered-dithered in indigo and clay like the launch film's cosmic sequence. Drawn once per size.
(() => {
  const c = document.getElementById("stars"); if (!c) return;
  const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const draw = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr; const g = c.getContext("2d"); g.scale(dpr, dpr); seed = 11;
    // stars: most faint and white, a few warm, a few indigo, a handful bright with a soft halo
    const n = Math.round((w * h) / 2600);
    for (let i = 0; i < n; i++) {
      const x = rnd() * w, y = rnd() * h * 0.9, k = rnd(), r = rnd();
      const a = 0.12 + Math.pow(r, 3) * 0.75;
      g.fillStyle = k < 0.12 ? "rgba(242,160,122," + a + ")" : k < 0.26 ? "rgba(154,146,255," + a + ")" : "rgba(236,235,255," + a + ")";
      const s = r > 0.985 ? 2 : r > 0.9 ? 1.4 : 1;
      g.fillRect(x, y, s, s);
      if (r > 0.997) { const gr = g.createRadialGradient(x + 1, y + 1, 0, x + 1, y + 1, 9); gr.addColorStop(0, "rgba(236,235,255,.2)"); gr.addColorStop(1, "rgba(236,235,255,0)"); g.fillStyle = gr; g.fillRect(x - 9, y - 9, 20, 20); }
    }
    // the planet's limb: a huge circle below the hero, dithered dense at the rim and thinning inward and outward
    const cx = w * 0.62, R = Math.max(w, h) * 1.25, cy = h + R - h * 0.2, s = 3;
    for (let y = Math.floor(h * 0.45); y < h; y += s) for (let x = 0; x < w; x += s) {
      const dd = Math.hypot(x - cx, y - cy) - R; // < 0 inside the planet
      let d = dd < 0 ? Math.max(0, 0.75 * Math.exp(dd / 26) - 0.02) : 0.55 * Math.exp(-dd / 14);
      const side = (x - cx) / w; d *= 0.55 + 0.45 * Math.max(0, 1 - Math.abs(side + 0.1) * 1.6);
      if (d * (0.85 + 0.3 * rnd()) <= B[((y / s) & 3) * 4 + ((x / s) & 3)]) continue;
      g.fillStyle = dd > -6 && rnd() < 0.7 ? "rgba(242,137,90,.75)" : "rgba(91,77,255,.6)";
      g.fillRect(x, y, 1.6, 1.6);
    }
  };
  let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(draw, 120); }); draw();
})();
// The hero session replays: each prompt types itself, a spark spins while Claude works, each line
// lands in turn, then a pause and again. With reduced motion the finished session just sits there.
(() => {
  const w = document.getElementById("ccw"); if (!w || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const body = w.querySelector(".ccw-body"), typed = w.querySelector(".ccw-l.in:not([data-step]) [data-type]"), steps = [...w.querySelectorAll("[data-step]")];
  body.style.minHeight = body.offsetHeight + "px";
  const spin = document.createElement("div"); spin.className = "ccw-spin"; spin.hidden = true;
  spin.innerHTML = '<span class="g1">✳</span> <span class="t"></span>… <span class="m">(esc to interrupt)</span>';
  const glyph = spin.querySelector(".g1"), label = spin.querySelector(".t"), G = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
  let gi = 0; setInterval(() => { if (!spin.hidden) glyph.textContent = G[gi++ % G.length]; }, 110);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const type = async (el) => { for (const ch of el.dataset.type) { el.textContent += ch; await sleep(55 + Math.random() * 60); } };
  const run = async () => {
    for (;;) {
      steps.forEach((s) => (s.hidden = true)); typed.textContent = ""; spin.hidden = true;
      await sleep(700);
      await type(typed);
      await sleep(350);
      let last = typed.closest(".ccw-l");
      for (const s of steps) {
        const wait = +s.dataset.wait || 200;
        if (s.dataset.spin) { label.textContent = s.dataset.spin; last.after(spin); spin.hidden = false; }
        await sleep(wait);
        spin.hidden = true; s.hidden = false; last = s;
        const t = s.querySelector("[data-type]"); if (t) { t.textContent = ""; await type(t); await sleep(350); }
      }
      await sleep(6500);
    }
  };
  run();
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
    const sky = tex(cv(16, 512, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#151629"); gr.addColorStop(0.45, "#3a3360"); gr.addColorStop(0.8, "#b9768a"); gr.addColorStop(1, "#f0a47a"); g.fillStyle = gr; g.fillRect(0, 0, w, h); }), 1, 1);
    sky.wrapS = sky.wrapT = THREE.ClampToEdgeWrapping; sky.repeat.set(1, 1);
    scene.background = sky;
    scene.fog = new THREE.Fog(0x6b5170, 70, 170); // dusk, to sit on the dark landing

    // ---- light: a warm low sun, a sky/grass bounce, studio reflections for the metal
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    scene.add(new THREE.HemisphereLight(0xb9b2e6, 0x6a6150, 0.7));
    const sun = new THREE.DirectionalLight(0xffd6ae, 2.4);
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
