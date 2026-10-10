// The public landing at "/", for people who are not signed in.
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

export function landingPage({ install, msg, esc, css, fonts, icon, mark }) {
  const bars = (s) => [...s].map((c) => `<i data-s="${{ o: "ok", d: "degraded", s: "skipped", ".": "" }[c]}"></i>`).join("");
  const rows = EXAMPLE.map(
    ([id, label, st, days, pct]) => `<div class="row">
      <div class="row-head"><span class="name"><span class="mon-id">${id}</span><small>daily</small></span><span class="state" data-s="${st}">${label}</span></div>
      <div class="bars">${bars(days)}</div>
      <div class="axis"><span>30 days ago</span><span class="rule"></span><span>${pct}% ok</span><span class="rule"></span><span>today</span></div>
    </div>`,
  ).join("");

  const cta = () => `<div class="cta">
    <a class="btn gh" href="${install}">${GITHUB}<span>Install Hush on your repos</span></a>
    <a class="btn ghost" href="/auth/login">Already installed? Sign in →</a>
  </div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hush</title>
<meta name="description" content="A status page for your software factory: monitors, Claude Code routines, CI and the queue, on one page.">
${icon}${fonts}
<style>${css}
/* Landing: one white column. Headline, install button, an example status page, three steps, what it reads, the button again. */
.land{max-width:1040px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:80px}
.nav a.signin{color:var(--muted);text-decoration:none;font-size:15px}.nav a.signin:hover{color:var(--ink)}
.h{max-width:760px;margin:0 auto;text-align:center}
.h h1{font-size:clamp(36px,6vw,60px);line-height:1.04;letter-spacing:-.04em;font-weight:600;margin:0 0 20px;text-wrap:balance}
.h h1 span{color:var(--faint)}
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
.reads h2,.end h2{font-size:28px;letter-spacing:-.025em;color:var(--ink);margin:0 0 8px;text-align:center;font-weight:600;text-wrap:balance}
.reads>p{color:var(--muted);text-align:center;margin:0 0 28px}
.reads .group .line .meta{white-space:normal;text-align:right;max-width:55%}
.end{text-align:center;margin:112px auto 0;padding:56px 24px;border:1px solid var(--line);border-radius:16px;max-width:760px}
.end p{color:var(--muted);margin:0 0 28px}
@media (prefers-reduced-motion:no-preference){.shot .bars i:last-child{animation:beat 2.4s ease-in-out infinite}}
@keyframes beat{50%{opacity:.45}}
@media(max-width:760px){.nav{margin-bottom:48px}.steps{grid-template-columns:minmax(0,1fr);gap:28px;margin-top:80px}.shot{padding:18px 14px 4px;margin-top:44px}.reads,.end{margin-top:80px}.reads .group .line{flex-direction:column;gap:2px}.reads .group .line .meta{text-align:left;max-width:none}}
</style></head><body><div class="wrap land">

<nav class="nav"><a class="logo" href="/">${mark()}<span>hush</span></a><a class="signin" href="/auth/login">Sign in</a></nav>

<section class="h">
  <h1>A status page for your software factory. <span>Quiet when it’s fine.</span></h1>
  <p class="lede">Install the app on your repos and see on one page whether your monitors are beating, whether your Claude Code routines ran, and what is left in the queue.</p>
  ${cta()}
  <p class="fine">Free. Read-only. Pick one repo, a few, or all of them.</p>
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
  <div class="step"><span class="n">02</span><h3>Your monitors beat</h3><p>One <code>curl</code> line at the end of each skill. A monitor that stops beating is marked down. One that says ok after reading nothing is too.</p></div>
  <div class="step"><span class="n">03</span><h3>You read one page</h3><p>Monitors with 30 days of history, routines with their next run, CI, open PRs and issues. It refreshes on its own.</p></div>
</section>

<section class="reads">
  <h2>What it reads from each repo</h2>
  <p>Read-only permissions. It never writes to your repo.</p>
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

<footer><span>hush · a read-only GitHub App</span><span><a href="/auth/login">Sign in</a></span></footer>
</div>
</body></html>`;
}
