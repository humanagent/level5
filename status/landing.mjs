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

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hush</title>
<meta name="description" content="A status page for your software factory: monitors, Claude Code routines, CI and the queue, on one page.">
${icon}${fonts}
<style>${css}
/* Landing: the night-to-dawn hero from the hush brand, the example status page rising out of it, then a quiet white page. */
.hero-band{background:linear-gradient(180deg,var(--night) 0%,var(--dusk) 36%,#5a2f4a 64%,#7a3a42 80%,var(--dawn) 92%,var(--glow) 100%);color:#f4f1ee;position:relative;overflow:hidden;padding-bottom:220px}
.hero-band::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:radial-gradient(1px 1px at 12% 18%,rgba(255,255,255,.55),transparent 60%),radial-gradient(1px 1px at 78% 12%,rgba(255,255,255,.45),transparent 60%),radial-gradient(1px 1px at 62% 28%,rgba(255,255,255,.35),transparent 60%),radial-gradient(1px 1px at 30% 8%,rgba(255,255,255,.4),transparent 60%),radial-gradient(1px 1px at 90% 34%,rgba(255,255,255,.3),transparent 60%),radial-gradient(1px 1px at 45% 15%,rgba(255,255,255,.3),transparent 60%)}
.hero-band ::selection{background:rgba(255,255,255,.25);color:#fff}
.in{max-width:1040px;margin:0 auto;padding-inline:20px;position:relative;z-index:1}
.nav{display:flex;justify-content:space-between;align-items:center;padding-block:28px}
.nav .logo{color:#fff}
.nav a.signin{color:rgba(244,241,238,.7);text-decoration:none;font-size:16px}.nav a.signin:hover{color:#fff}
.headline{padding-top:96px}
.headline h1{margin:0;font-weight:500;font-size:clamp(38px,6.6vw,80px);line-height:1.03;letter-spacing:-.04em}
.headline h1 span{display:block;color:rgba(244,241,238,.46)}
.headline h1 span.now{color:#f6f2ee}
.headline p{font-size:19px;line-height:1.5;color:rgba(244,241,238,.72);max-width:44ch;margin:28px 0 36px}
.cta{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.btn.solid{display:inline-flex;align-items:center;gap:10px;padding:15px 24px;font-size:16px;background:#fff;color:var(--night);box-shadow:0 10px 30px -10px rgba(0,0,0,.5);transition:transform .15s ease}
.btn.solid:hover{transform:translateY(-1px)}
.btn.glass{padding:15px 22px;font-size:16px;font-weight:500;background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(6px)}
.btn.glass:hover{background:rgba(255,255,255,.22)}
.fine{font-size:14px;color:rgba(244,241,238,.6);margin:16px 0 0}
.shot{max-width:800px;margin:-170px auto 0;position:relative;z-index:2;background:#fff;border-radius:22px;padding:28px 28px 8px;box-shadow:0 40px 80px -40px rgba(7,11,28,.55),0 2px 8px rgba(7,11,28,.06)}
.shot .chrome{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;font-size:13px;color:var(--muted)}
.shot .chrome b{color:var(--ink);font-weight:600;font-family:var(--mono);font-size:13px}
.example{display:block;text-align:center;font-size:12px;color:var(--faint);margin:12px 0 0}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px;max-width:960px;margin:120px auto 0;padding-inline:20px}
.step .n{font:500 13px var(--mono);color:var(--faint)}
.step h3{font-size:20px;letter-spacing:-.02em;margin:8px 0 8px;font-weight:600}
.step p{color:var(--muted);margin:0}
.step code,.reads code{font:12.5px var(--mono);color:var(--ink);background:#f4f5f6;border-radius:4px;padding:1px 5px}
.reads{max-width:800px;margin:120px auto 0;padding-inline:20px}
.reads h2,.end h2{font-size:clamp(26px,3.6vw,34px);letter-spacing:-.03em;color:var(--ink);margin:0 0 8px;text-align:center;font-weight:600;text-wrap:balance}
.reads>p{color:var(--muted);text-align:center;margin:0 0 28px}
.reads .group .line .meta{white-space:normal;text-align:right;max-width:55%}
.end{max-width:1040px;margin:120px auto 0;padding:72px 24px;border-radius:28px;text-align:center;color:#f4f1ee;background:linear-gradient(180deg,var(--night) 0%,var(--dusk) 55%,#5a2f4a 100%)}
.end h2{color:#f6f2ee}
.end p{color:rgba(244,241,238,.7);margin:0 0 30px;font-size:17px}
.end .cta{justify-content:center}
.foot{max-width:1040px;margin:48px auto 0;padding:24px 20px 56px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;color:var(--faint);font-size:13px}
.foot .logo{font-size:16px}.foot a{color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.shot .bars i:last-child{animation:beat 2.4s ease-in-out infinite}}
@keyframes beat{50%{opacity:.45}}
@media(max-width:760px){.headline{padding-top:48px}.hero-band{padding-bottom:160px}.shot{margin:-120px 12px 0;padding:18px 14px 4px;border-radius:16px}.steps{grid-template-columns:minmax(0,1fr);gap:28px;margin-top:80px}.reads,.end{margin-top:80px}.end{margin-inline:12px;padding:48px 20px}.reads .group .line{flex-direction:column;gap:2px}.reads .group .line .meta{text-align:left;max-width:none}}
</style></head><body>

<header class="hero-band">
  <div class="in">
    <nav class="nav"><a class="logo" href="/">${mark("#fff")}<span>hush</span></a><a class="signin" href="/auth/login">Sign in</a></nav>
    <div class="headline">
      <h1>
        <span>Your agents run the factory.</span>
        <span>Monitors stay quiet.</span>
        <span>Routines run while you sleep.</span>
        <span class="now">Hush tells you when one dies.</span>
      </h1>
      <p>One status page for every repo you pick: are your monitors beating, did your Claude Code routines run, and what is left in the queue.</p>
      <div class="cta">
        <a class="btn solid" href="${install}">${GITHUB}<span>Install Hush on your repos</span></a>
        <a class="btn glass" href="/auth/login">Sign in</a>
      </div>
      <p class="fine">Free. Read-only. Pick one repo, a few, or all of them.</p>
      ${msg ? `<p class="err" style="color:#ffb4a8">${esc(msg)}</p>` : ""}
    </div>
  </div>
</header>

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
  <div class="cta">
    <a class="btn solid" href="${install}">${GITHUB}<span>Install Hush on your repos</span></a>
    <a class="btn glass" href="/auth/login">Sign in</a>
  </div>
</section>

<footer class="foot"><a class="logo" href="/">${mark()}<span>hush</span></a><span>Read-only GitHub App · <a href="/auth/login">Sign in</a></span></footer>
</body></html>`;
}
