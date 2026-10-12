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

  const starLabel = stars == null ? "Star on GitHub" : `Star · ${stars >= 1000 ? (stars / 1000).toFixed(1).replace(/\.0$/, "") + "k" : stars}`;
  const cta = (dark = true) => `<div class="lcta">
    ${viewer ? `<a class="lp pri" href="/">Open your repos →</a>` : `<a class="lp pri" href="${install}">${GITHUB}<span>Install on GitHub</span></a>`}
    <a class="lp alt${dark ? "" : " on-paint"}" href="${REPO}" target="_blank" rel="noopener">${starLabel}</a>
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
.announce{display:inline-flex;align-items:center;gap:12px;min-height:46px;margin-top:16px;padding:0 18px;border-radius:999px;font:500 14px/1 var(--f);letter-spacing:-.45px;text-decoration:none;background:color-mix(in srgb,var(--l-surface) 76%,transparent);box-shadow:inset 0 0 0 1px var(--l-line);backdrop-filter:blur(18px);transition:transform .3s var(--l-spring)}
.announce:hover{transform:translateY(-1px)}.announce span{color:var(--l-muted)}
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
.lhero h1,.lhero .lede,.lhero .lcta,.announce{animation:lin .68s var(--l-ease) both}.lhero .lede{animation-delay:.12s}.lhero .lcta{animation-delay:.22s}.announce{animation-delay:.3s}
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

/* end */
.lend{margin:120px 24px 0;max-width:1100px;box-sizing:border-box;padding:96px 32px;text-align:center}
.paint.lend{background:linear-gradient(160deg,#e98a6b 0,#9b6fd6 48%,#4f4fd8 100%)}
@media(min-width:1148px){.lend{margin-inline:auto}}
.lend h2{margin:0 auto 12px;max-width:20ch;color:#fff;font-size:clamp(34px,5vw,56px);font-weight:500;letter-spacing:-.06em;line-height:1;text-wrap:balance}
.lend p{margin:0 0 28px;color:rgba(255,255,255,.86);font-size:17px}.lend .lcta{justify-content:center}
.land .lend .lp.pri{background:#fff;color:var(--l-ink)}.land .lp.alt.on-paint{background:rgba(255,255,255,.18);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.lfoot{max-width:1100px;margin:64px auto 0;padding:20px 24px 0;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:#9aa0b8;font-size:13px;border-top:1px solid #eef0f5}
.lfoot a{color:var(--l-muted)}

@media(max-width:980px){.lhero-in{grid-template-columns:minmax(0,1fr);gap:40px;padding:112px 16px 160px}.lhero h1{font-size:48px;letter-spacing:-2.4px}
.lsec-head{grid-template-columns:minmax(0,1fr);gap:24px;margin-bottom:48px}.lsec-head .r{text-align:left}.lsec-head .lcta{justify-content:flex-start}
.duo,.trio{grid-template-columns:minmax(0,1fr)}.trio{gap:24px}.paint{padding:32px 20px 0}.frame{border-inline:0;border-radius:20px 20px 0 0}}
@media(max-width:760px){.lnav{inset:8px 8px auto;padding-left:14px}.lnav-r a.t{display:none}.lnav .lp.alt{display:none}
.lhero h1{font-size:42px;letter-spacing:-2px}.pillar{grid-template-columns:48px minmax(0,1fr);padding:12px 14px 12px 8px}.pillar svg{width:40px;height:40px}
.lsec{padding:80px 16px 0}.cost-shot{grid-template-columns:minmax(0,1fr)}.cost-chart,.cost-runs{padding:18px 16px}.cost-cols{height:110px;gap:2px}
.sheet{padding:16px 14px 4px}.sheet .line{flex-direction:column;gap:2px}.sheet .line .meta{text-align:left;max-width:none}.int-grid{grid-template-columns:minmax(0,1fr)}
.lend{margin:80px 16px 0;padding:64px 20px}.lcta .lp{flex:1 1 auto}}
</style></head><body class="land">

<nav class="lnav" id="lnav"><a class="logo" href="/">${mark()}<span>hush</span></a>
  <span class="lnav-r"><a class="t" href="#status">Status</a><a class="t" href="#costs">Costs</a><a class="t" href="#sources">Sources</a><a class="t" href="${REPO}" target="_blank" rel="noopener">GitHub</a>
  ${viewer ? `<a class="lp alt" href="/landing">${esc(viewer)}</a><a class="lp pri" href="/">Enter →</a>` : `<a class="lp alt" href="/auth/login">Sign in</a><a class="lp pri" href="${install}">${GITHUB}<span>Install</span></a>`}</span>
</nav>

<header class="lhero">
  <canvas id="dither" aria-hidden="true"></canvas>
  <div class="lhero-in">
    <div>
      <h1>AI Native Observability <em>for Automated Developments</em></h1>
      <p class="lede">When agents ship more than you can read, Hush shows which routines ran, which went silent, and what each one cost.</p>
      ${cta()}
      <a class="announce" href="${REPO}" target="_blank" rel="noopener">Open source, MIT <span>Read the code →</span></a>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    </div>
    <div class="pillars">${PILLARS.map(([href, ic, t, p], i) => `<a class="pillar" href="${href}" style="--i:${i}">${ICONS[ic]}<span><h2>${t}<i>→</i></h2><p>${p}</p></span></a>`).join("")}</div>
  </div>
</header>

<main class="frame">

<section class="lsec" id="status">
  <div class="lsec-head">
    <div><span class="ltag">${ICONS.sm("beat")} monitors</span><p class="lword">status</p></div>
    <div class="r"><h3>The monitor of the monitors</h3><p>A dead monitor and a healthy system both look like silence. Every routine leaves a heartbeat when it ends, and Hush checks them against your roster.</p>${cta()}</div>
  </div>
  <h3 class="lfeat">${ICONS.sm("beat")} One page for the whole factory</h3>
  <p class="lfeat-p">Every skill with 30 days of history, grouped by the routine that runs it. It flags the ones that died and the ones that said ok after reading nothing.</p>
  <div class="paint a" aria-label="Example status page">
    <div class="sheet">
      <div class="chrome"><span class="l"><span class="dots"><i></i><i></i><i></i></span><b>acme/api</b></span><span>updated 2 min ago</span></div>
      <div class="banner" data-s="down"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg><span>One monitor has been degraded for weeks</span></div>
      <p class="banner-sub">Affected: speed. No other check would have said it: it flips between ok days and degraded days.</p>
      <div class="group">${rows}</div>
    </div>
  </div>
  <span class="lex">Example with invented data.</span>
  <div class="trio">
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("auto")} Install the app <span class="n">01</span></h3><p class="lfeat-p">On your account or your organization. Pick one repo, a few, or all of them, and change it later.</p></div>
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("beat")} Your routines report <span class="n">02</span></h3><p class="lfeat-p">One command installs a hook: every Claude Code routine reports itself when it ends.</p></div>
    <div class="lmini"><h3 class="lfeat">${ICONS.sm("doc")} You read one page <span class="n">03</span></h3><p class="lfeat-p">Next run, tokens and state for every skill. It refreshes on its own.</p></div>
  </div>
</section>

<section class="lsec" id="costs">
  <div class="lsec-head">
    <div><span class="ltag">${ICONS.sm("tok")} tokens and costs</span><p class="lword">costs</p></div>
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

<section class="lsec" id="sources">
  <div class="lsec-head">
    <div><span class="ltag">${ICONS.sm("flow")} read-only</span><p class="lword">sources</p></div>
    <div class="r"><h3>Where it reads from</h3><p>Read-only on your code. No cloud or billing credentials: your jobs send what they already know.</p></div>
  </div>
  <div class="duo">
    <div>
      <h3 class="lfeat">${ICONS.sm("flow")} Integrations</h3>
      <p class="lfeat-p">The four platforms first. Anything else through one <code>curl</code>.</p>
      <div class="paint c pad"><div class="int-grid">${INTEGRATIONS.map(([k, bg, logo, name, what]) => `<div class="int"><span class="int-m" style="background:${bg}">${logo}</span><b>${name}</b><span class="int-t">${what}</span></div>`).join("")}</div></div>
      <p class="int-more">Also: Claude Code routines, skills and tokens per session, Neon and the Anthropic API.</p>
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

<section class="lend paint b">
  <h2>A dead monitor and a healthy system look the same.</h2>
  <p>Both are silent. Hush tells you which one you have.</p>
  ${cta(false)}
</section>

<footer class="lfoot"><span>hush · open source, MIT · <a href="${REPO}" target="_blank" rel="noopener">github.com/humanagent/hush</a></span><span>${viewer ? `<a href="/">Enter as ${esc(viewer)}</a>` : `<a href="/auth/login">Sign in</a>`}</span></footer>
</main>

<script>
// Nav turns into a dark lp once the lhero has scrolled a little.
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
</body></html>`;
}
