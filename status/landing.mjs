// The public landing at "/", for people who are not signed in.
// Every number in the preview is invented and labelled as an example.

const GITHUB = `<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

// 30 days per example monitor: o = ok, d = degraded, s = skipped, . = no run
const EXAMPLE = [
  ["errors", "Operativo", "ok", "oooooooooooooooooooooooooooooo", "99.9"],
  ["logs", "Operativo", "ok", "ooooooooooooo.oooooooooooooooo", "100"],
  ["cost", "Operativo", "ok", "oooooooooooooooooooooooooooooo", "100"],
  ["llm-traces", "Operativo", "ok", "ooooodoooooooooooooooooooooooo", "96.7"],
  ["speed", "Degradado crónico", "bad", "oododddoddddoddddodddoddoddodd", "36.7"],
];

export function landingPage({ install, msg, esc, css }) {
  const bars = (s) => [...s].map((c) => `<i data-s="${{ o: "ok", d: "degraded", s: "skipped", ".": "" }[c]}"></i>`).join("");
  const rows = EXAMPLE.map(
    ([id, label, st, days, pct]) => `<div class="row">
      <div class="row-head"><span class="name">${id}<small>diario</small></span><span class="state" data-s="${st}">${label}</span></div>
      <div class="bars">${bars(days)}</div>
      <div class="axis"><span>hace 30 días</span><span class="rule"></span><span>${pct}% ok</span><span class="rule"></span><span>hoy</span></div>
    </div>`,
  ).join("");

  const cta = (big) => `<div class="cta${big ? " big" : ""}">
    <a class="btn gh" href="${install}">${GITHUB}<span>Instalar Hush en tus repos</span></a>
    <a class="btn ghost" href="/auth/login">Ya la instalé, entrar →</a>
  </div>`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hush</title>
<meta name="description" content="La status page de tu software factory: monitores, routines de Claude Code, CI y la cola, en una página.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='%232fb36b'/></svg>">
<style>${css}
.land{max-width:1040px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:72px}
.nav .logo{display:flex;align-items:center;gap:8px;font-size:18px}
.nav .logo i{width:10px;height:10px;border-radius:50%;background:var(--ok);display:inline-block}
.nav a.in{color:var(--muted);text-decoration:none;font-size:14px}.nav a.in:hover{color:var(--ink)}
.h{max-width:760px;margin:0 auto;text-align:center}
.h h1{font-size:clamp(36px,6vw,60px);line-height:1.04;letter-spacing:-.035em;font-weight:700;margin:0 0 20px;text-wrap:balance}
.h h1 span{color:var(--faint)}
.h p.lede{font-size:18px;line-height:1.55;color:var(--muted);margin:0 auto 32px;max-width:56ch;text-wrap:pretty}
.cta{display:flex;justify-content:center;align-items:center;gap:18px;flex-wrap:wrap}
.btn.gh{display:inline-flex;align-items:center;gap:10px;padding:14px 22px;font-size:16px;border-radius:10px;box-shadow:0 1px 0 rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.35);transition:transform .15s ease,box-shadow .15s ease}
.btn.gh:hover{transform:translateY(-1px);box-shadow:0 1px 0 rgba(0,0,0,.04),0 12px 28px -8px rgba(0,0,0,.4)}
.btn.ghost{font-size:15px}
.fine{font-size:13px;color:var(--faint);text-align:center;margin:14px 0 0}
.shot{max-width:760px;margin:64px auto 0;border:1px solid var(--line);border-radius:14px;padding:28px 28px 8px;box-shadow:0 30px 60px -30px rgba(20,24,30,.25),0 2px 6px rgba(20,24,30,.04);background:var(--bg)}
.shot .chrome{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;font-size:13px;color:var(--muted)}
.shot .chrome b{color:var(--ink);font-weight:600}
.example{display:block;text-align:center;font-size:12px;color:var(--faint);margin:10px 0 0}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px;max-width:960px;margin:120px auto 0}
.step .n{font:600 13px var(--mono);color:var(--faint)}
.step h3{font-size:18px;letter-spacing:-.01em;margin:8px 0 8px}
.step p{color:var(--muted);margin:0}
.step code,.reads code{font:12.5px var(--mono);color:var(--ink);background:#f4f5f6;border-radius:4px;padding:1px 5px}
.reads{max-width:760px;margin:120px auto 0}
.reads h2{font-size:28px;letter-spacing:-.02em;color:var(--ink);margin:0 0 8px;text-align:center}
.reads>p{color:var(--muted);text-align:center;margin:0 0 28px}
.reads .group .line .meta{white-space:normal;text-align:right;max-width:52%}
.end{text-align:center;margin:120px auto 0;padding:56px 24px;border:1px solid var(--line);border-radius:16px;max-width:760px}
.end h2{font-size:30px;letter-spacing:-.02em;color:var(--ink);margin:0 0 10px;text-wrap:balance}
.end p{color:var(--muted);margin:0 0 28px}
@media (prefers-reduced-motion:no-preference){.shot .bars i:last-child{animation:beat 2.4s ease-in-out infinite}}
@keyframes beat{50%{opacity:.45}}
@media(max-width:760px){.nav{margin-bottom:48px}.steps{grid-template-columns:minmax(0,1fr);gap:28px;margin-top:80px}.shot{padding:18px 14px 4px;margin-top:44px}.reads,.end{margin-top:80px}.reads .group .line{flex-direction:column;gap:2px}.reads .group .line .meta{text-align:left;max-width:none}}
</style></head><body><div class="wrap land">

<nav class="nav"><span class="logo"><i></i>Hush</span><a class="in" href="/auth/login">Entrar</a></nav>

<section class="h">
  <h1>La status page de tu software factory. <span>Silencio cuando todo anda.</span></h1>
  <p class="lede">Instalás la app en tus repos y ves en una sola página si tus monitores laten, si tus routines de Claude Code corrieron y qué quedó en la cola.</p>
  ${cta(true)}
  <p class="fine">Gratis. Solo lectura. Elegís uno, varios o todos tus repos.</p>
  ${msg ? `<p class="err" style="text-align:center">${esc(msg)}</p>` : ""}
</section>

<section class="shot" aria-label="Ejemplo de status page">
  <div class="chrome"><b>acme/api</b><span>Actualizado hace 2 min</span></div>
  <div class="banner" data-s="down"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg><span>Un monitor degradado hace semanas</span></div>
  <p class="banner-sub" style="margin-bottom:24px">Afectado: speed. Ningún otro monitor lo iba a decir: alterna días ok con días degradados.</p>
  <h2>Monitores</h2>
  <div class="group" style="margin-bottom:20px">${rows}</div>
</section>
<span class="example">Ejemplo con datos inventados.</span>

<section class="steps">
  <div class="step"><span class="n">1</span><h3>Instalá la app</h3><p>En tu cuenta o en tu organización. En la misma pantalla de GitHub elegís uno, varios o todos los repos, y después sumás o sacás cuando quieras.</p></div>
  <div class="step"><span class="n">2</span><h3>Tus monitores laten</h3><p>Una línea de <code>curl</code> al final de cada skill. Si un monitor deja de latir, se marca caído. Si dice ok sin haber leído nada, también.</p></div>
  <div class="step"><span class="n">3</span><h3>Mirás una página</h3><p>Monitores con 30 días de historia, routines con su próxima corrida, CI, PRs e issues abiertos. Se actualiza sola.</p></div>
</section>

<section class="reads">
  <h2>Lo que lee de cada repo</h2>
  <p>Todo con permisos de solo lectura. No escribe en tu repo.</p>
  <div class="group">
    <div class="line"><span class="name"><code>.claude/skills</code></span><span class="meta">Qué skills tiene la factory y cuáles corren en una routine</span></div>
    <div class="line"><span class="name"><code>.claude/factory.json</code></span><span class="meta">El roster de monitores y las routines de Claude Code, con su cron</span></div>
    <div class="line"><span class="name"><code>.github/workflows</code></span><span class="meta">Los crons de Actions y la última corrida de cada workflow</span></div>
    <div class="line"><span class="name">Issues, PRs y checks</span><span class="meta">La cola abierta, el CI de cada PR y qué mergearon los agentes</span></div>
  </div>
</section>

<section class="end">
  <h2>Un monitor muerto y un sistema sano se ven igual.</h2>
  <p>Los dos están callados. Hush te dice cuál es cuál.</p>
  ${cta(false)}
</section>

<footer><span>Hush</span><span><a href="/auth/login">Entrar</a></span></footer>
</div></body></html>`;
}
