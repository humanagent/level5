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
  const starTag = stars == null ? "" : `<span class="stars" aria-label="${stars} stars">★ ${stars >= 1000 ? (stars / 1000).toFixed(1).replace(/\.0$/, "") + "k" : stars}</span>`;
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

  const cta = () => `<div class="cta">
    ${viewer ? `<a class="btn gh" href="/"><span>Open your repos →</span></a>` : `<a class="btn gh" href="${install}">${GITHUB}<span>Install Hush on your repos</span></a>`}
  </div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hush · software observability for the AI era</title>
<meta name="description" content="Software observability for the AI era. Monitor your factory so software never sleeps.">
${icon}${fonts}
<style>${css}
/* Landing: one white column. Headline, install button, an example status page, three steps, what it reads, the button again. */
.land{max-width:1040px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:80px}
.nav a.signin{color:var(--muted);text-decoration:none;font-size:15px}.nav a.signin:hover{color:var(--ink)}.nav a.enter{color:var(--bg);background:var(--ink);padding:6px 14px;border-radius:8px;font-weight:500}.nav a.enter:hover{color:var(--bg);opacity:.88}
.h{max-width:760px;margin:0 auto;text-align:center}
.h{max-width:900px}
.h h1{font-size:clamp(34px,5.6vw,64px);line-height:1.05;letter-spacing:-.04em;font-weight:500;margin:0 0 28px}
.h h1 span{display:block;color:#b9bcc3}
.h h1 span.now{color:var(--ink);font-weight:600}
.h p.lede{font-size:18px;line-height:1.55;color:var(--muted);margin:0 auto 32px;max-width:54ch;text-wrap:pretty}
.cta{display:flex;justify-content:center;align-items:center;gap:18px;flex-wrap:wrap}
.btn.gh{display:inline-flex;align-items:center;gap:10px;padding:14px 22px;font-size:16px;box-shadow:0 8px 24px -10px rgba(0,0,0,.4);transition:transform .15s ease}
.btn.gh:hover{transform:translateY(-1px)}
.fine{font-size:13px;color:var(--faint);text-align:center;margin:14px 0 0}
.shot{max-width:760px;margin:64px auto 0;border:1px solid var(--line);border-radius:16px;padding:28px 28px 8px;box-shadow:0 30px 60px -30px rgba(20,24,30,.25)}
.shot .chrome{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;font-size:13px;color:var(--muted)}
.shot .chrome b{color:var(--ink);font:500 13px var(--mono)}
.example{display:block;text-align:center;font-size:12px;color:var(--faint);margin:10px 0 0}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px;max-width:960px;margin:112px auto 0}
.step .n{font:500 13px var(--mono);color:var(--faint)}
.step h3{font-size:18px;letter-spacing:-.01em;margin:8px 0;font-weight:600}
.step p{color:var(--muted);margin:0}
.step code,.reads code{font:12.5px var(--mono);color:var(--ink);background:#f4f5f6;border-radius:4px;padding:1px 5px}
.reads{max-width:760px;margin:112px auto 0}
.oss svg{width:14px;height:14px}.oss>span:not(.stars){padding-right:6px}.stars{padding:2px 9px;border-left:1px solid var(--line);font:500 12px var(--mono);color:var(--ink)}
.nav-r{display:flex;align-items:center;gap:20px}.gh-link{display:inline-flex;align-items:center;gap:7px}.gh-link svg{width:16px;height:16px}
.oss{display:inline-flex;align-items:center;gap:8px;margin:0 0 22px;padding:5px 6px 5px 12px;border:1px solid var(--line);border-radius:999px;font:500 12.5px var(--mono);color:var(--muted);text-decoration:none}.oss:hover{color:var(--ink);border-color:#d6d8dc}
.fine a{color:var(--muted)}
.costs{max-width:1000px;margin:112px auto 0}.costs>h2{font-size:28px;letter-spacing:-.025em;color:var(--ink);margin:0 0 8px;text-align:center;font-weight:600}.costs>p{color:var(--muted);text-align:center;margin:0 auto 32px;max-width:60ch;text-wrap:pretty}
.cost-shot{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 30px 60px -30px rgba(20,24,30,.25)}
.cost-chart,.cost-runs{background:var(--bg);padding:22px 24px}
.cost-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}.cost-h b{font-size:22px;font-weight:600;letter-spacing:-.02em}.cost-runs .cost-h b{font-size:15px}.cost-h span{font-size:12.5px;color:var(--faint)}
.cost-cols{display:flex;align-items:flex-end;gap:3px;height:150px}.cc{flex:1;display:flex;flex-direction:column-reverse;height:100%;gap:1px}.cc i{display:block;border-radius:1.5px;min-height:1px}
.cost-leg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:14px;font-size:12.5px;color:var(--muted)}.cost-leg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}.cost-leg b{color:var(--ink);font-weight:500;margin-left:2px}
.cost-runs table{width:100%;border-collapse:collapse;font-size:13.5px}.cost-runs th{text-align:left;font-weight:500;color:var(--faint);font-size:12px;padding:0 0 8px}.cost-runs td{padding:9px 0;border-top:1px solid var(--line)}.cost-runs th:not(:first-child),.cost-runs td:not(:first-child){text-align:right}
.cost-runs code{font:12.5px var(--mono);color:var(--ink)}.cost-runs small{color:var(--faint);margin-left:8px;font-size:11.5px}.cost-runs td b{font-weight:600}
.cost-alarm{display:flex;align-items:center;gap:8px;margin:14px 0 0;padding:9px 12px;border-radius:9px;background:#fff7ec;color:#8a5a12;font-size:12.5px}.cost-alarm i{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none}.cost-alarm b{font-weight:600}
@media(max-width:760px){.costs{margin-top:80px}.cost-shot{grid-template-columns:minmax(0,1fr)}.cost-chart,.cost-runs{padding:18px 16px}.cost-cols{height:110px;gap:2px}}
.ints{max-width:1000px;margin:112px auto 0}.ints>h2{font-size:28px;letter-spacing:-.025em;color:var(--ink);margin:0 0 8px;text-align:center;font-weight:600}.ints>p{color:var(--muted);text-align:center;margin:0 auto 32px;max-width:60ch}
.int-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.int{display:flex;flex-direction:column;gap:8px;padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--bg)}
.int-m{display:grid;place-items:center;width:48px;height:48px;border-radius:12px;margin-bottom:6px}.int-m svg,.int-m img{width:24px;height:24px}
.int-m .wm{color:#fff;font:800 16px/1 var(--f);letter-spacing:-.02em;position:relative}.int-m .wm::after{content:"";position:absolute;left:1px;right:2px;bottom:-5px;height:3px;border-radius:0 0 6px 6px;border-bottom:2px solid #ff9900}
.int b{font-weight:600;font-size:16px}.int-t{color:var(--muted);font-size:14px;line-height:1.45}
.ints>p.int-more{text-align:center;color:var(--muted);font-size:14px;margin:24px auto 0;max-width:70ch}.int-more code{font:13px var(--mono);background:#f4f5f6;border-radius:4px;padding:1px 5px}
@media(max-width:860px){.int-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:520px){.int-grid{grid-template-columns:minmax(0,1fr)}}
.reads h2,.end h2{font-size:28px;letter-spacing:-.025em;color:var(--ink);margin:0 0 8px;text-align:center;font-weight:600;text-wrap:balance}
.reads>p{color:var(--muted);text-align:center;margin:0 0 28px}
.reads .group .line .meta{white-space:normal;text-align:right;max-width:55%}
.end{text-align:center;margin:112px auto 0;padding:56px 24px;border:1px solid var(--line);border-radius:16px;max-width:760px}
.end p{color:var(--muted);margin:0 0 28px}
@media (prefers-reduced-motion:no-preference){.shot .bars i:last-child{animation:beat 2.4s ease-in-out infinite}}
@keyframes beat{50%{opacity:.45}}
@media(max-width:760px){.nav{margin-bottom:48px}.steps{grid-template-columns:minmax(0,1fr);gap:28px;margin-top:80px}.shot{padding:18px 14px 4px;margin-top:44px}.reads,.end{margin-top:80px}.reads .group .line{flex-direction:column;gap:2px}.reads .group .line .meta{text-align:left;max-width:none}}
</style></head><body><div class="wrap land">

<nav class="nav"><a class="logo" href="/">${mark()}<span>hush</span></a><span class="nav-r"><a class="signin gh-link" href="${REPO}" target="_blank" rel="noopener">${GITHUB}<span>GitHub</span></a>${enter}</span></nav>

<section class="h">
  <a class="oss" href="${REPO}" target="_blank" rel="noopener">${GITHUB}<span>Star on GitHub</span>${starTag}</a>
  <h1>
    <span>Software observability</span>
    <span class="now">for the AI era.</span>
  </h1>
  <p class="lede">Monitor your factory so software never sleeps.</p>
  ${cta()}
  ${msg ? `<p class="err" style="text-align:center">${esc(msg)}</p>` : ""}
</section>

<section class="shot" aria-label="Example status page">
  <div class="chrome"><b>acme/api</b><span>updated 2 min ago</span></div>
  <div class="banner" data-s="down"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg><span>One monitor has been degraded for weeks</span></div>
  <p class="banner-sub" style="margin-bottom:24px">Affected: speed. No other check would have said it: it flips between ok days and degraded days.</p>
  <h2>Monitors</h2>
  <div class="group" style="margin-bottom:20px">${rows}</div>
</section>
<span class="example">Example with invented data.</span>

<section class="steps">
  <div class="step"><span class="n">01</span><h3>Install the app</h3><p>On your account or your organization. On the same GitHub screen you pick one repo, a few, or all of them, and you can add or remove any later.</p></div>
  <div class="step"><span class="n">02</span><h3>Your routines report</h3><p>One command installs a hook: every Claude Code routine reports itself when it ends. A monitor that stops beating is marked down. One that says ok after reading nothing is too.</p></div>
  <div class="step"><span class="n">03</span><h3>You read one page</h3><p>Every skill with 30 days of history, grouped by the routine that runs it, with its next run and its tokens. It refreshes on its own.</p></div>
</section>

<section class="costs">
  <h2>And what it costs</h2>
  <p>Tokens for every routine run, next to what your cloud bills each day. A routine that burns 4× its usual tokens shows up the same day, not on the invoice.</p>
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
  <span class="example">Example with invented data.</span>
</section>

<section class="ints">
  <h2>Integrations</h2>
  <p>Read-only on your code. No cloud or billing credentials: your jobs send what they already know.</p>
  <div class="int-grid">${INTEGRATIONS.map(([k, bg, logo, name, what]) => `<div class="int"><span class="int-m" style="background:${bg}">${logo}</span><b>${name}</b><span class="int-t">${what}</span></div>`).join("")}</div>
  <p class="int-more">Also: Claude Code routines, skills and tokens per session, Neon, the Anthropic API, and any provider or cron through one <code>curl</code>.</p>
</section>

<section class="reads">
  <h2>What it reads from each repo</h2>
  <p>Read-only permissions. It never writes to your repo, and every line that reads it is <a href="${REPO}/blob/main/status/server.mjs" target="_blank" rel="noopener">on GitHub</a>.</p>
  <div class="group">
    <div class="line"><span class="name"><code>.claude/skills</code></span><span class="meta">The skills in your factory, and which ones run on a routine</span></div>
    <div class="line"><span class="name"><code>.claude/factory.json</code></span><span class="meta">Your monitor roster and Claude Code routines, with their cron</span></div>
    <div class="line"><span class="name"><code>.github/workflows</code></span><span class="meta">Scheduled Actions and the last run of every workflow</span></div>
    <div class="line"><span class="name">Issues, PRs and checks</span><span class="meta">The open queue, CI on every PR, and what your agents merged</span></div>
  </div>
</section>

<section class="end">
  <h2>A dead monitor and a healthy system look the same.</h2>
  <p>Both are silent. Hush tells you which one you have.</p>
  ${cta()}
</section>

<footer><span>hush · open source, MIT · <a href="${REPO}" target="_blank" rel="noopener">github.com/humanagent/hush</a></span><span>${viewer ? `<a href="/">Enter as ${esc(viewer)}</a>` : `<a href="/auth/login">Sign in</a>`}</span></footer>
</div>
</body></html>`;
}
