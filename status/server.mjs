// Factory status: a status page for any GitHub repo that runs a Claude Code factory.
//
// Reads, live, through the GitHub App installation:
//   .claude/skills/*            the skills
//   .claude/factory.json        roster of monitors and declared routines (optional)
//   .claude/skills/monitor-meta/roster.json + .claude/skills/cloud-routine.md   (the same, older convention)
//   .github/workflows/*.yml     scheduled Actions crons, and the last run of every workflow
//   issues, pull requests, checks
// Receives heartbeats over HTTP: every monitor POSTs one when it finishes (/api/heartbeat).
//
// Access goes through a GitHub App, created once with the manifest flow at /setup?t=SETUP_TOKEN.
// People sign in with GitHub and install the app on the repos they want; reads use installation tokens.
//
// node server.mjs   (PORT, DATA_DIR, SECRET, SETUP_TOKEN)

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { landingPage } from "./landing.mjs";

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || "./data";
const SECRET = process.env.SECRET || "dev-secret-change-me";
const KEY = createHash("sha256").update(SECRET).digest();
const WINDOW = 30;
mkdirSync(DATA, { recursive: true });

// --- storage --------------------------------------------------------------
const db = new DatabaseSync(join(DATA, "factory.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, token TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS repos (full_name TEXT PRIMARY KEY, owner_login TEXT NOT NULL, ingest_key TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS heartbeats (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, monitor TEXT NOT NULL, ts TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS hb_unique ON heartbeats(repo, monitor, ts);
  CREATE INDEX IF NOT EXISTS hb_repo_ts ON heartbeats(repo, ts);
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
try { db.exec("ALTER TABLE repos ADD COLUMN installation_id INTEGER"); } catch {}

const seal = (text) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
};
const open = (b64) => {
  const buf = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
};

// --- sessions (signed cookie: login.expiry.sig) ------------------------------
const sign = (v) => createHmac("sha256", KEY).update(v).digest("base64url");
function sessionCookie(login) {
  const v = `${login}.${Date.now() + 30 * 864e5}`;
  return `fs=${v}.${sign(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
}
function sessionUser(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)fs=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split(".");
  const sig = parts.pop();
  const v = parts.join(".");
  const good = Buffer.from(sign(v));
  if (good.length !== Buffer.from(sig).length || !timingSafeEqual(good, Buffer.from(sig))) return null;
  const [login, exp] = [parts.slice(0, -1).join("."), Number(parts.at(-1))];
  if (Date.now() > exp) return null;
  return db.prepare("SELECT login, token FROM users WHERE login = ?").get(login) || null;
}

// --- GitHub ---------------------------------------------------------------------
async function gh(token, path, raw = false) {
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory-status" },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path.split("?")[0]}`);
  return raw ? r.text() : r.json();
}

// --- the GitHub App -----------------------------------------------------------------
const getSetting = (k) => db.prepare("SELECT v FROM settings WHERE k = ?").get(k)?.v;
const setSetting = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
function appConfig() {
  const raw = getSetting("app");
  return raw ? JSON.parse(open(raw)) : null;
}
function appJwt(app) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(app.id) })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(app.pem, "base64url")}`;
}
const instTokens = new Map();
async function installationToken(installationId) {
  const hit = instTokens.get(installationId);
  if (hit && hit.exp - Date.now() > 5 * 60e3) return hit.token;
  const r = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${appJwt(appConfig())}`, accept: "application/vnd.github+json", "user-agent": "factory-status" },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} fetching the installation token`);
  const j = await r.json();
  instTokens.set(installationId, { token: j.token, exp: Date.parse(j.expires_at) });
  return j.token;
}
// repos this person can see through their installations of the app
async function userRepos(user) {
  return cached(`userrepos:${user.login}`, 3 * 60e3, async () => {
    const token = open(user.token);
    const inst = await gh(token, "user/installations?per_page=100");
    if (!inst) throw new Error("The GitHub session expired");
    const out = [];
    for (const i of inst.installations || []) {
      const r = await gh(token, `user/installations/${i.id}/repositories?per_page=100`);
      for (const repo of r?.repositories || []) out.push({ full_name: repo.full_name, private: repo.private, installation_id: i.id });
    }
    return out;
  });
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// --- cron -------------------------------------------------------------------------
function cronField(spec, min, max) {
  const out = new Set();
  for (const part of spec.split(",")) {
    const [range, stepS] = part.split("/");
    const step = Number(stepS || 1);
    let [a, b] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (b === undefined) b = stepS ? max : a;
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}
function nextRun(cron, from = new Date()) {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  try {
    const [mi, ho, dom, mo, dow] = [cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31), cronField(f[3], 1, 12), cronField(f[4].replace("7", "0"), 0, 6)];
    let t = new Date(Math.ceil((from.getTime() + 1) / 6e4) * 6e4);
    for (let i = 0; i < 60 * 24 * 40; i++, t = new Date(t.getTime() + 6e4)) {
      if (mi.has(t.getUTCMinutes()) && ho.has(t.getUTCHours()) && mo.has(t.getUTCMonth() + 1) && (f[2] === "*" || dom.has(t.getUTCDate())) && (f[4] === "*" || dow.has(t.getUTCDay()))) return t.toISOString();
    }
  } catch {}
  return null;
}
// how often a cron fires, in hours (good enough to judge "late")
function cronPeriodHours(cron) {
  const a = nextRun(cron);
  const b = a && nextRun(cron, new Date(a));
  return a && b ? (new Date(b) - new Date(a)) / 36e5 : 24;
}

// --- the factory, read from the repo -------------------------------------------------
async function readFactory(token, repo) {
  return cached(`factory:${repo}`, 10 * 60e3, async () => {
    const notes = [];
    const [meta, skillDirs, factoryJson, roster, routineDoc, workflowsList] = await Promise.all([
      gh(token, `repos/${repo}`),
      gh(token, `repos/${repo}/contents/.claude/skills`).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/factory.json`, true).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/skills/monitor-meta/roster.json`, true).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/skills/cloud-routine.md`, true).catch(() => null),
      gh(token, `repos/${repo}/actions/workflows?per_page=100`).catch(() => null),
    ]);

    // skills
    const dirs = (skillDirs || []).filter((d) => d.type === "dir").slice(0, 80);
    const skills = (
      await Promise.all(
        dirs.map(async (d) => {
          const md = await gh(token, `repos/${repo}/contents/${d.path}/SKILL.md`, true).catch(() => null);
          if (!md) return null;
          const desc = (md.match(/^description:\s*(.+)$/m) || ["", ""])[1].replace(/^["']|["']$/g, "");
          return { name: d.name, description: desc.slice(0, 200) };
        }),
      )
    ).filter(Boolean);

    // monitors and declared routines
    let config = {};
    if (factoryJson) {
      try {
        config = JSON.parse(factoryJson);
      } catch {
        notes.push(".claude/factory.json is not valid JSON");
      }
    }
    let monitors = config.monitors || [];
    if (!monitors.length && roster) {
      try {
        monitors = JSON.parse(roster).monitors || [];
      } catch {}
    }
    let routines = (config.routines || []).map((r) => ({ ...r, source: "Claude Code" }));
    if (!routines.length && routineDoc) {
      routines = routineDoc
        .split("\n")
        .filter((l) => /^\|[^|]+\|\s*`[^`]+`\s*\|/.test(l))
        .map((l) => {
          const [name, cron, prompt, model] = l.split("|").slice(1, 5).map((c) => c.trim().replace(/`/g, ""));
          return { name, cron, prompt, model, source: "Claude Code" };
        });
    }

    // scheduled GitHub Actions count as routines too
    const workflows = workflowsList?.workflows || [];
    const scheduled = await Promise.all(
      workflows.map(async (w) => {
        const yml = await gh(token, `repos/${repo}/contents/${w.path}`, true).catch(() => null);
        const crons = [...(yml || "").matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
        return crons.map((cron) => ({ name: w.name, cron, prompt: w.path, model: "", source: "GitHub Actions" }));
      }),
    );
    routines = routines.concat(scheduled.flat());

    return { meta: { full_name: meta.full_name, private: meta.private, default_branch: meta.default_branch, url: meta.html_url }, skills, monitors, routines, notes, workflows: workflows.filter((w) => w.state === "active").map((w) => ({ id: w.id, name: w.name, path: w.path, url: w.html_url })) };
  });
}

// every workflow as a monitor: one bar per day over the window, from its completed runs
async function readCi(token, repo, workflows) {
  return cached(`ci:${repo}`, 10 * 60e3, async () => {
    const since = new Date(Date.now() - (WINDOW - 1) * 864e5).toISOString().slice(0, 10);
    const days = [...Array(WINDOW)].map((_, i) => new Date(Date.now() - (WINDOW - 1 - i) * 864e5).toISOString().slice(0, 10));
    return Promise.all(
      workflows.map(async (w) => {
        const runs = [];
        for (let page = 1; page <= 6; page++) {
          const r = await gh(token, `repos/${repo}/actions/workflows/${w.id}/runs?per_page=100&page=${page}&created=>=${since}`).catch(() => null);
          const batch = r?.workflow_runs || [];
          runs.push(...batch);
          if (batch.length < 100) break;
        }
        const done = runs.filter((r) => ["success", "failure", "timed_out"].includes(r.conclusion));
        const byDay = Object.fromEntries(days.map((d) => [d, { ok: 0, bad: 0 }]));
        for (const r of done) {
          const d = byDay[r.created_at.slice(0, 10)];
          if (d) r.conclusion === "success" ? d.ok++ : d.bad++;
        }
        const last = runs[0];
        const ok = done.filter((r) => r.conclusion === "success").length;
        return {
          name: w.name,
          path: w.path,
          url: w.url,
          runs: done.length,
          capped: runs.length >= 600,
          pct: done.length ? Math.round((ok / done.length) * 1000) / 10 : null,
          days: days.map((d) => { const x = byDay[d]; return !x.ok && !x.bad ? "" : !x.bad ? "ok" : !x.ok ? "skipped" : "degraded"; }),
          tips: days.map((d) => byDay[d]),
          last: last ? { conclusion: last.conclusion, status: last.status, at: last.updated_at, branch: last.head_branch, url: last.html_url } : null,
        };
      }),
    ).then((list) => list.filter((w) => w.runs || w.last).sort((a, b) => b.runs - a.runs));
  });
}

async function readQueue(token, repo) {
  return cached(`queue:${repo}`, 60e3, async () => {
    const [issuesRaw, prsRaw, closedRaw, runsRaw] = await Promise.all([
      gh(token, `repos/${repo}/issues?state=open&per_page=100`),
      gh(token, `repos/${repo}/pulls?state=open&per_page=30`),
      gh(token, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`),
      gh(token, `repos/${repo}/actions/runs?per_page=100`).catch(() => ({ workflow_runs: [] })),
    ]);
    const issues = (issuesRaw || []).filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name), created_at: i.created_at, url: i.html_url }));
    const prs = await Promise.all(
      (prsRaw || []).map(async (p) => {
        const c = await gh(token, `repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`).catch(() => null);
        const runs = c?.check_runs || [];
        const ci = runs.some((x) => ["failure", "timed_out"].includes(x.conclusion)) ? "red" : runs.some((x) => x.status !== "completed") ? "running" : runs.length ? "green" : "none";
        return { number: p.number, title: p.title, branch: p.head.ref, draft: p.draft, ci, url: p.html_url };
      }),
    );
    const merged = (closedRaw || []).filter((p) => p.merged_at).map((p) => ({ number: p.number, title: p.title, branch: p.head.ref, merged_at: p.merged_at, url: p.html_url })).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
    const runs = [];
    for (const r of runsRaw?.workflow_runs || []) if (!runs.some((x) => x.name === r.name)) runs.push({ name: r.name, status: r.status, conclusion: r.conclusion, at: r.updated_at, event: r.event, url: r.html_url });
    return { issues, prs, merged, runs };
  });
}

// --- judging monitors (the /monitor-meta rules, plus the chronic ratio) -------------------
const AGENT_BRANCH = /^(claude\/|codex\/|fix\/pr-sweep|audit|fix-issues|fix\/issue-|agent\/)/;
function judge(factory, repo) {
  const since = new Date(Date.now() - WINDOW * 864e5).toISOString();
  const beats = db.prepare("SELECT monitor, ts, status, body FROM heartbeats WHERE repo = ? AND ts >= ? ORDER BY ts DESC").all(repo, since).map((b) => ({ ...JSON.parse(b.body), monitor: b.monitor, ts: b.ts, status: b.status }));
  const roster = [...factory.monitors];
  for (const id of new Set(beats.map((b) => b.monitor))) if (!roster.some((m) => m.id === id)) roster.push({ id, cadence: "daily", max_silence_hours: 50, unlisted: true });
  const days = [...Array(WINDOW)].map((_, i) => new Date(Date.now() - (WINDOW - 1 - i) * 864e5).toISOString().slice(0, 10));
  const RANK = { ok: 1, degraded: 2, skipped: 3 };

  const monitors = roster.map((m) => {
    const mine = beats.filter((b) => b.monitor === m.id);
    const last = mine[0];
    const silence = m.max_silence_hours || (m.cadence === "weekly" ? 200 : 50);
    const vol = (b) => (b?.swept && m.volume_key && m.volume_key in b.swept ? Number(b.swept[m.volume_key]) : null);
    const recent = mine.filter((b) => b.ts >= new Date(Date.now() - 14 * 864e5).toISOString());
    const badShare = recent.length ? recent.filter((b) => b.status !== "ok").length / recent.length : 0;
    const h = last ? (Date.now() - new Date(last.ts)) / 36e5 : null;
    let state = "alive", why = "";
    if (!last) [state, why] = ["dead", `no heartbeat in ${WINDOW} days`];
    else if (h > silence) [state, why] = ["dead", `last heartbeat ${Math.round(h)} h ago, tolerates ${silence} h`];
    else if (last.status === "ok" && vol(last) === 0 && !m.zero_ok) [state, why] = ["lying", `reported ok with ${m.volume_key} = 0`];
    else if (recent.length >= 4 && badShare > 0.3) [state, why] = ["degraded", `${Math.round(badShare * 100)}% of runs in 14 days were not ok`];
    else if (mine[1] && last.status !== "ok" && mine[1].status !== "ok") [state, why] = ["degraded", "two runs in a row not ok"];
    else if (last.status !== "ok") [state, why] = ["warn", last.note || `last run ${last.status}`];
    if (m.unlisted && state === "dead") [state, why] = ["retired", "stopped beating and is not in the roster"];
    const byDay = {};
    for (const b of mine) {
      const d = b.ts.slice(0, 10);
      if (!byDay[d] || RANK[b.status] > RANK[byDay[d]]) byDay[d] = b.status;
    }
    return { id: m.id, cadence: m.cadence || "daily", routine: m.routine || "", state, why, unlisted: !!m.unlisted, last, runs: mine.length, days: days.map((d) => byDay[d] || ""), filed: [...new Set(mine.flatMap((b) => b.filed || []))].slice(0, 20) };
  });
  return { monitors, beats: beats.length };
}

function routineState(r, monitors, merged) {
  const fed = monitors.filter((m) => m.routine && m.routine === r.name && m.last);
  let last = fed.map((m) => m.last.ts).sort().pop() || null;
  let evidence = fed.length ? "heartbeat" : "";
  if (!last && r.source === "Claude Code") {
    const skill = (r.prompt.match(/\/[a-z][a-z0-9-]*/) || [""])[0].slice(1);
    const m = monitors.find((x) => x.id === skill && x.last);
    if (m) [last, evidence] = [m.last.ts, "heartbeat"];
  }
  if (!last && /review/i.test(r.name)) {
    const p = merged.find((x) => /pr-sweep|review/.test(x.branch));
    if (p) [last, evidence] = [p.merged_at, "merged PR"];
  }
  if (!last && /audit/i.test(r.name)) {
    const p = merged.find((x) => /audit/.test(x.branch));
    if (p) [last, evidence] = [p.merged_at, "merged PR"];
  }
  return { ...r, last_seen: last, evidence: evidence || "none", next_run: nextRun(r.cron), period_h: cronPeriodHours(r.cron) };
}

async function snapshot(repoRow) {
  const repo = repoRow.full_name;
  const token = await installationToken(repoRow.installation_id);
  const [factory, queue] = await Promise.all([readFactory(token, repo), readQueue(token, repo)]);
  const ci = await readCi(token, repo, factory.workflows || []);
  const { monitors, beats } = judge(factory, repo);
  const routines = factory.routines.map((r) => routineState(r, monitors, queue.merged));
  const runsByName = Object.fromEntries(queue.runs.map((r) => [r.name, r]));
  for (const r of routines) if (r.source === "GitHub Actions" && runsByName[r.name]) [r.last_seen, r.evidence] = [runsByName[r.name].at, "Actions run"];
  const bad = monitors.filter((m) => ["dead", "lying", "degraded"].includes(m.state));
  const warn = monitors.filter((m) => m.state === "warn");
  const lateRoutines = routines.filter((r) => r.last_seen && (Date.now() - new Date(r.last_seen)) / 36e5 > r.period_h * 1.25 + 2);
  const redCi = queue.runs.filter((r) => r.conclusion === "failure");
  const overall = bad.length ? "down" : warn.length || lateRoutines.length || redCi.length ? "degraded" : "ok";
  const day = new Date(Date.now() - 864e5).toISOString();
  return {
    repo,
    meta: factory.meta,
    generated_at: new Date().toISOString(),
    overall,
    affected: [...bad, ...warn].map((m) => m.id).concat(lateRoutines.map((r) => r.name), redCi.map((r) => r.name)),
    counts: { heartbeats: beats, merged_24h: queue.merged.filter((p) => p.merged_at > day).length, agent_merged_24h: queue.merged.filter((p) => p.merged_at > day && AGENT_BRANCH.test(p.branch)).length },
    monitors,
    routines,
    queue,
    skills: factory.skills,
    ci,
    notes: factory.notes,
  };
}

// --- HTML -------------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ago(ts) {
  if (!ts) return "never";
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function until(ts) {
  if (!ts) return "not scheduled";
  const s = (new Date(ts) - Date.now()) / 1000;
  if (s <= 60) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 172800) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">`;
const MARK = (color = "currentColor") => `<svg viewBox="0 0 40 40" width="22" height="22" aria-hidden="true"><path d="M3 22h9l3.5-9 6 18 3.5-9h12" fill="none" stroke="${color}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LOGO = `<a class="logo" href="/">${MARK()}<span>hush</span></a>`;

const CSS = `
:root{--bg:#fff;--ink:#14161c;--muted:#666a73;--faint:#9a9ea5;--line:#ebecef;--ok:#2fb36b;--warn:#f0a92c;--bad:#e5484d;--empty:#e9eaed;
--night:#070b1c;--dusk:#1b2350;--dawn:#c4532a;--glow:#f0a35e;
--f:"Hanken Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--f);-webkit-font-smoothing:antialiased}
::selection{background:var(--dusk);color:#fff}
a{color:var(--ink)}a:focus-visible,summary:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:3px}
code{font-family:var(--mono);font-size:.86em}
.wrap{max-width:760px;margin:0 auto;padding-inline:16px;padding-block:32px 72px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:36px}
.logo{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:18px;letter-spacing:-.02em;margin:0;text-decoration:none;color:var(--ink)}
.crumb{color:var(--faint);font-weight:400;margin-left:2px}.crumb b{color:var(--ink);font-weight:500}
.updated{color:var(--muted);font-size:13px}
.banner{display:flex;align-items:center;gap:12px;padding:18px 20px;border-radius:10px;color:#fff;background:var(--ok);font-size:17px;font-weight:600;margin-bottom:8px}
.banner[data-s=degraded]{background:var(--warn)}.banner[data-s=down]{background:var(--bad)}
.banner-sub{color:var(--muted);font-size:13px;margin:0 0 40px;padding-inline:2px}
h2{font-size:13px;font-weight:600;color:var(--muted);margin:0 0 10px;letter-spacing:.01em}
.group{border:1px solid var(--line);border-radius:10px;margin-bottom:32px}
.row{padding:16px 20px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.row-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.name{font-weight:500;min-width:0;overflow-wrap:anywhere}.name small{color:var(--faint);font-weight:400;font-size:12px;margin-left:6px}
.mon-id{font-family:var(--mono);font-size:13.5px}
.state{font-size:13px;color:var(--ok);white-space:nowrap}.state[data-s=warn]{color:var(--warn)}.state[data-s=bad]{color:var(--bad)}.state[data-s=none]{color:var(--faint)}
.bars{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;height:30px;margin-top:10px}
.bars i{border-radius:2px;background:var(--empty)}.bars i[data-s=ok]{background:var(--ok)}.bars i[data-s=degraded]{background:var(--warn)}.bars i[data-s=skipped]{background:var(--bad)}.bars i:hover{opacity:.7}
.axis{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--faint)}.axis .rule{flex:1;height:1px;background:var(--line)}
details.row>summary{list-style:none;cursor:pointer}details.row>summary::-webkit-details-marker{display:none}
.detail{margin-top:10px;font-size:13px;color:var(--muted);display:grid;gap:4px}.detail code{font:12px var(--mono);color:var(--ink)}
.line{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:12px 20px;border-top:1px solid var(--line)}.line:first-child{border-top:0}
.line .meta{color:var(--muted);font-size:13px;text-align:right;white-space:nowrap}.sub{display:block;color:var(--faint);font-size:12px;font-weight:400}
.incident{padding:16px 0;border-top:1px solid var(--line)}.incident:first-of-type{border-top:0;padding-top:0}
.incident h3{margin:0;font-size:15px;font-weight:600}.incident h3 a{text-decoration:none}.incident h3 a:hover{text-decoration:underline}
.incident p{margin:4px 0 0;font-size:13px;color:var(--muted)}.tag{font-size:12px;font-weight:600;margin-right:6px;color:var(--muted)}.tag.risky{color:var(--bad)}
.incidents{margin-bottom:40px}.none{color:var(--muted)}
.fold summary{cursor:pointer;color:var(--muted);font-size:13px}.fold p{font:12px/1.8 var(--mono);color:var(--muted);margin:10px 0 0}.fold p b{color:var(--ink);font-weight:500}
.fold .say{font:13px/1.5 var(--f)}
pre{font:12px/1.6 var(--mono);background:#f6f7f8;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;margin:8px 0 16px;white-space:pre}
footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);color:var(--faint);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
footer a{color:var(--muted)}
form{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 8px}
button,.btn{font:600 15px var(--f);padding:10px 16px;border-radius:999px;border:0;background:var(--ink);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.btn.ghost{background:none;color:var(--muted);padding-inline:0;font-weight:500}
.hero h1{font-size:28px;letter-spacing:-.02em;margin:0 0 8px;text-wrap:balance}.hero p{color:var(--muted);margin:0 0 24px;max-width:56ch}
.err{color:var(--bad);font-size:13px}.hint{color:var(--muted);font-size:13px}
@media(max-width:520px){.wrap{padding-block:24px 56px}.row,.line{padding-inline:14px}.name small{display:block;margin-left:0}.bars{gap:1px}}
`;
const CHECK = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M6 10.2l2.7 2.6L14 7.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ALERT = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg>`;
const ICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' rx='10' fill='%23070b1c'/><path d='M5 22h8l3-8 5 16 3-8h11' fill='none' stroke='%23f0a35e' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/></svg>">`;
const page = (title, body, { refresh } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>${esc(title)}</title>${ICON}${FONTS}<style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;

const STATE = { alive: ["ok", "Operational"], warn: ["warn", "Degraded"], degraded: ["bad", "Chronically degraded"], lying: ["bad", "Said ok, read nothing"], dead: ["bad", "Down"], retired: ["none", "Retired"] };

function statusPage(s, user, origin, repoRow) {
  const repoUrl = s.meta.url;
  const banner = s.overall === "ok" ? "All systems operational" : s.overall === "degraded" ? "Degraded performance" : "Monitors need attention";
  const monRows = s.monitors.map((m) => {
    const [ps, label] = STATE[m.state] || ["none", m.state];
    const ran = m.days.filter(Boolean).length;
    const pct = ran ? Math.round((m.days.filter((d) => d === "ok").length / ran) * 1000) / 10 : 0;
    const bars = m.days.map((d, i) => `<i data-s="${d}" title="${new Date(Date.now() - (m.days.length - 1 - i) * 864e5).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })} · ${d || "no run"}"></i>`).join("");
    const swept = m.last?.swept ? Object.entries(m.last.swept).map(([k, v]) => `${esc(k)} <code>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</code>`).join(" · ") : "";
    const filed = m.filed.map((x) => `<a href="${repoUrl}/issues/${x}" target="_blank" rel="noopener">#${x}</a>`).join(" ");
    return `<details class="row"><summary>
      <div class="row-head"><span class="name"><span class="mon-id">${esc(m.id)}</span><small>${m.cadence === "weekly" ? "weekly" : "daily"}${m.unlisted ? " · not in roster" : ""}</small></span><span class="state" data-s="${ps}">${label}</span></div>
      <div class="bars">${bars}</div>
      <div class="axis"><span>${WINDOW} days ago</span><span class="rule"></span><span>${pct}% ok</span><span class="rule"></span><span>today</span></div>
    </summary><div class="detail">${m.why ? `<div>${esc(m.why)}</div>` : ""}<div>Last heartbeat ${ago(m.last?.ts)}${swept ? ` · ${swept}` : ""}</div>${m.last?.note ? `<div>${esc(m.last.note)}</div>` : ""}<div>${filed ? `Filed ${filed}` : `Filed nothing in ${WINDOW} days`}</div></div></details>`;
  }).join("");

  const DOW = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const when = (r) => {
    if (!r.next_run) return r.cron;
    const t = new Date(r.next_run);
    const hh = t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
    if (r.period_h <= 1.01) return `every ${Math.round(r.period_h * 60)} min`;
    if (r.period_h < 24) return `every ${Math.round(r.period_h)} h`;
    if (r.period_h === 24) return `daily ${hh}`;
    return `${DOW[t.getUTCDay()]} ${hh}`;
  };
  const routineRows = s.routines.map((r) => {
    const late = r.last_seen && (Date.now() - new Date(r.last_seen)) / 36e5 > r.period_h * 1.25 + 2;
    const [st, label] = !r.last_seen ? ["none", "No evidence"] : late ? ["bad", "Late"] : ["ok", `Ran ${ago(r.last_seen)}`];
    return `<div class="line"><span class="name">${esc(r.name.replace(/^App: /, ""))}<span class="sub">${esc(r.source)} · ${esc(r.prompt)} · ${esc(when(r))}${r.model ? " · " + esc(r.model) : ""}</span></span><span class="meta"><span class="state" data-s="${st}">${label}</span><span class="sub">next ${until(r.next_run)}</span></span></div>`;
  }).join("");

  const ci = (s.ci || []).map((w) => {
    const lastS = !w.last ? ["none", "No runs"] : w.last.status !== "completed" ? ["warn", "Running"] : w.last.conclusion === "success" ? ["ok", "Passing"] : w.last.conclusion === "failure" ? ["bad", "Failing"] : ["none", w.last.conclusion];
    const bars = w.days.map((d, i) => { const t = w.tips[i]; return `<i data-s="${d}" title="${new Date(Date.now() - (w.days.length - 1 - i) * 864e5).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })} · ${t.ok + t.bad ? `${t.ok} passed, ${t.bad} failed` : "no runs"}"></i>`; }).join("");
    return `<details class="row"><summary>
      <div class="row-head"><span class="name">${esc(w.name)}<small>${w.runs}${w.capped ? "+" : ""} runs</small></span><span class="state" data-s="${lastS[0]}">${lastS[1]}</span></div>
      <div class="bars">${bars}</div>
      <div class="axis"><span>${WINDOW} days ago</span><span class="rule"></span><span>${w.pct == null ? "no runs" : `${w.pct}% passing`}</span><span class="rule"></span><span>today</span></div>
    </summary><div class="detail"><div><code>${esc(w.path)}</code></div>${w.last ? `<div>Last run <a href="${esc(w.last.url)}" target="_blank" rel="noopener">${ago(w.last.at)}</a> on <code>${esc(w.last.branch)}</code>, ${esc(w.last.conclusion || w.last.status)}</div>` : ""}<div>Green day: every run passed. Amber: some failed. Red: all failed.</div></div></details>`;
  }).join("");

  const prs = s.queue.prs.map((p) => `<div class="line"><span class="name"><a href="${esc(p.url)}" target="_blank" rel="noopener" style="text-decoration:none">${esc(p.title)}</a><span class="sub">#${p.number} · ${esc(p.branch)}</span></span><span class="meta"><span class="state" data-s="${p.ci === "green" ? "ok" : p.ci === "red" ? "bad" : p.ci === "running" ? "warn" : "none"}">${{ green: "Passing", red: "Failing", running: "Running", none: "No CI" }[p.ci]}</span></span></div>`).join("");
  const incidents = s.queue.issues.length
    ? s.queue.issues.map((i) => `<div class="incident"><h3><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></h3><p>${i.labels.map((l) => `<span class="tag ${l === "risky" ? "risky" : ""}">${esc(l)}</span>`).join("")}#${i.number} · opened ${ago(i.created_at)}</p></div>`).join("")
    : `<p class="none">No open issues.</p>`;

  const onRoutine = new Set(s.routines.map((r) => (r.prompt.match(/\/([a-z][a-z0-9-]*)/) || [])[1]).filter(Boolean));
  const owner = repoRow;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  return page(`${s.repo} · hush`, `
    <header class="top">${LOGO}<span class="updated">${esc(s.repo)} · updated ${ago(s.generated_at)}</span></header>
    <div class="banner" data-s="${s.overall}">${s.overall === "ok" ? CHECK : ALERT}<span>${banner}</span></div>
    <p class="banner-sub">${s.affected.length ? `Affected: ${esc(s.affected.join(", "))}. ` : ""}${plural(s.counts.merged_24h, "PR")} merged in 24 h, ${s.counts.agent_merged_24h} by agents. ${s.queue.prs.length ? `${plural(s.queue.prs.length, "PR")} open.` : "No open PRs."}</p>

    <h2>Monitors</h2>
    ${s.monitors.length ? `<div class="group">${monRows}</div>` : `<div class="group"><div class="line"><span class="hint">No heartbeat yet. The curl every monitor runs when it finishes is at the bottom of this page.</span></div></div>`}

    <h2>Routines</h2>
    ${s.routines.length ? `<div class="group">${routineRows}</div>` : `<div class="group"><div class="line"><span class="hint">No routines found. Declare them in <code>.claude/factory.json</code> (see below).</span></div></div>`}

    ${ci ? `<h2>CI · GitHub Actions</h2><div class="group">${ci}</div>` : ""}
    ${prs ? `<h2>Open pull requests</h2><div class="group">${prs}</div>` : ""}

    <h2>Open issues</h2>
    <div class="incidents">${incidents}</div>

    <details class="fold"><summary>${plural(s.skills.length, "skill")} in .claude/skills</summary>
      <p>${s.skills.map((k) => onRoutine.has(k.name) ? `<b title="${esc(k.description)}">${esc(k.name)}</b>` : `<span title="${esc(k.description)}">${esc(k.name)}</span>`).join(" · ") || "None."}</p>
    </details>

    ${owner ? `<details class="fold" style="margin-top:16px"><summary>Connect monitors and routines</summary>
      <p class="say">Every monitor leaves a heartbeat when it finishes, clean run or not:</p>
<pre>curl -sS -X POST ${esc(origin)}/api/heartbeat \\
  -H "authorization: Bearer ${esc(owner.ingest_key)}" \\
  -H "content-type: application/json" \\
  -d '{"monitor":"errors","status":"ok","swept":{"events":41233},"filed":[2634],"note":""}'</pre>
      <p class="say"><code>status</code> is ok, degraded or skipped. Declare the roster and your Claude Code routines in <code>.claude/factory.json</code>:</p>
<pre>{
  "monitors": [
    { "id": "errors", "cadence": "daily", "max_silence_hours": 50, "volume_key": "events", "routine": "Monitors" }
  ],
  "routines": [
    { "name": "Monitors", "cron": "0 13 * * *", "prompt": "/monitor", "model": "sonnet" }
  ]
}</pre>
    </details>` : ""}

    <footer><span><a href="${repoUrl}" target="_blank" rel="noopener">${esc(s.repo)}</a> · ${plural(s.counts.heartbeats, "heartbeat")} in ${WINDOW} days${s.notes.length ? ` · ${esc(s.notes.join(" · "))}` : ""}</span><span>${user ? `<a href="/">Your repos</a>` : ""}</span></footer>
  `, { refresh: 120 });
}

function homePage(user, repos = [], msg = "") {
  const app = appConfig();
  if (!app) {
    return page("hush", `<header class="top">${LOGO}</header>
      <div class="hero"><h1>A status page for your software factory.</h1><p>The GitHub App is not set up yet. Whoever runs this instance does it once, from <code>/setup</code>.</p></div>`);
  }
  const install = `https://github.com/apps/${app.slug}/installations/new`;
  if (!user) return landingPage({ install, msg, esc, css: CSS, fonts: FONTS, icon: ICON, mark: MARK });
  return page("hush", `
    <header class="top">${LOGO}<form method="post" action="/logout" style="margin:0"><button class="btn ghost">Sign out (${esc(user.login)})</button></form></header>
    <h2>Your repos</h2>
    <div class="group">${repos.length ? repos.map((r) => `<div class="line"><a class="name" href="/r/${esc(r.full_name)}" style="text-decoration:none">${esc(r.full_name)}${r.private ? "<small>private</small>" : ""}</a><span class="meta"><a href="/r/${esc(r.full_name)}">View status →</a></span></div>`).join("") : `<div class="line"><span class="hint">Hush is not installed on any of your repos yet.</span></div>`}</div>
    <p><a class="btn" href="${install}">${repos.length ? "Add or remove repos" : "Install on your repos"}</a></p>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ""}`);
}

function setupPage(origin, t) {
  const manifest = {
    name: `Factory Status ${randomBytes(2).toString("hex")}`,
    url: origin,
    hook_attributes: { url: `${origin}/api/github/webhook`, active: false },
    redirect_url: `${origin}/setup/callback/${encodeURIComponent(t)}`,
    callback_urls: [`${origin}/auth/callback`],
    setup_url: `${origin}/`,
    public: true,
    default_permissions: { contents: "read", issues: "read", pull_requests: "read", actions: "read", checks: "read", metadata: "read" },
    default_events: [],
  };
  return page("Create the GitHub App", `<header class="top">${LOGO}</header>
    <div class="hero"><h1>Create the GitHub App</h1><p>One click: GitHub creates a read-only app and hands its credentials back to this instance. You do this once.</p></div>
    <form method="post" action="https://github.com/settings/apps/new"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button>Create on GitHub</button></form>`);
}

// --- HTTP ---------------------------------------------------------------------------------
const readBody = (req, limit = 2e6) =>
  new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) rej(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
const form = async (req) => Object.fromEntries(new URLSearchParams(await readBody(req)));
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "referrer-policy": "same-origin", ...headers });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { "content-type": "application/json" });
const redirect = (res, to, headers = {}) => send(res, 303, "", { location: to, ...headers });

function insertBeat(repo, b) {
  const status = ["ok", "degraded", "skipped"].includes(b.status) ? b.status : null;
  if (!b.monitor || !status) throw new Error("monitor and status (ok|degraded|skipped) are required");
  const ts = b.ts && !Number.isNaN(Date.parse(b.ts)) ? new Date(b.ts).toISOString() : new Date().toISOString();
  const body = JSON.stringify({ window: b.window || "", swept: b.swept || {}, suppressed: b.suppressed ?? null, filed: (b.filed || []).map(Number).filter(Boolean), note: String(b.note || "").slice(0, 500) });
  db.prepare("INSERT OR IGNORE INTO heartbeats (repo, monitor, ts, status, body) VALUES (?, ?, ?, ?, ?)").run(repo, String(b.monitor).slice(0, 80), ts, status, body);
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const origin = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok", { "content-type": "text/plain" });

    if (url.pathname === "/api/heartbeat" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = key && db.prepare("SELECT full_name FROM repos WHERE ingest_key = ?").get(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(body) ? body : [body];
      for (const b of list) insertBeat(repo.full_name, b);
      return json(res, 200, { ok: true, stored: list.length });
    }

    const user = sessionUser(req);

    if (url.pathname === "/" && req.method === "GET") {
      if (!user) return send(res, 200, homePage(null));
      const repos = await userRepos(user).catch(() => null);
      if (!repos) return redirect(res, "/auth/login");
      return send(res, 200, homePage(user, repos));
    }

    const SETUP = process.env.SETUP_TOKEN;
    if (url.pathname === "/setup" && req.method === "GET") {
      if (!SETUP || url.searchParams.get("t") !== SETUP) return send(res, 404, page("Not found", `<p class="none">This page does not exist.</p>`));
      if (appConfig()) return redirect(res, "/");
      return send(res, 200, setupPage(origin, SETUP));
    }
    if (url.pathname.startsWith("/setup/callback/") && req.method === "GET") {
      if (!SETUP || decodeURIComponent(url.pathname.slice(16)) !== SETUP || appConfig()) return redirect(res, "/");
      const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get("code") || "")}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "factory-status" } });
      if (!r.ok) throw new Error(`GitHub ${r.status} converting the manifest`);
      const a = await r.json();
      setSetting("app", seal(JSON.stringify({ id: a.id, slug: a.slug, pem: a.pem, client_id: a.client_id, client_secret: a.client_secret, webhook_secret: a.webhook_secret })));
      return redirect(res, `https://github.com/apps/${a.slug}/installations/new`);
    }

    if (url.pathname === "/auth/login" && req.method === "GET") {
      const app = appConfig();
      if (!app) return redirect(res, "/");
      const state = randomBytes(16).toString("base64url");
      return redirect(res, `https://github.com/login/oauth/authorize?client_id=${app.client_id}&redirect_uri=${encodeURIComponent(origin + "/auth/callback")}&state=${state}`, { "set-cookie": `fs_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` });
    }
    if (url.pathname === "/auth/callback" && req.method === "GET") {
      const app = appConfig();
      const state = (req.headers.cookie || "").match(/(?:^|;\s*)fs_state=([^;]+)/)?.[1];
      if (!app || !state || state !== url.searchParams.get("state")) return send(res, 400, homePage(null, [], "Sign-in could not be verified. Try again."));
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, code: url.searchParams.get("code"), redirect_uri: origin + "/auth/callback" }),
      });
      const tok = await r.json();
      const me = tok.access_token && (await gh(tok.access_token, "user"));
      if (!me?.login) return send(res, 401, homePage(null, [], "GitHub did not complete the sign-in."));
      db.prepare("INSERT INTO users (login, token, created_at) VALUES (?, ?, ?) ON CONFLICT(login) DO UPDATE SET token = excluded.token").run(me.login, seal(tok.access_token), new Date().toISOString());
      cache.delete(`userrepos:${me.login}`);
      return redirect(res, "/", { "set-cookie": [sessionCookie(me.login), "fs_state=; Path=/; Max-Age=0"] });
    }

    if (url.pathname === "/logout" && req.method === "POST") return redirect(res, "/", { "set-cookie": "fs=; Path=/; Max-Age=0" });

    const m = url.pathname.match(/^\/r\/([\w.-]+\/[\w.-]+?)(\.json)?$/);
    if (m && req.method === "GET") {
      if (!user) return redirect(res, "/auth/login");
      const repos = await userRepos(user).catch(() => null);
      if (!repos) return redirect(res, "/auth/login");
      const seen = repos.find((r) => r.full_name.toLowerCase() === m[1].toLowerCase());
      if (!seen) return send(res, 404, page("Not found", `<header class="top">${LOGO}</header><p class="none">Hush is not installed on that repo, or your account cannot see it.</p>`));
      let row = db.prepare("SELECT * FROM repos WHERE full_name = ?").get(seen.full_name);
      if (!row) db.prepare("INSERT INTO repos (full_name, owner_login, ingest_key, created_at, installation_id) VALUES (?, ?, ?, ?, ?)").run(seen.full_name, user.login, "fsk_" + randomBytes(24).toString("base64url"), new Date().toISOString(), seen.installation_id);
      else if (row.installation_id !== seen.installation_id) db.prepare("UPDATE repos SET installation_id = ? WHERE full_name = ?").run(seen.installation_id, seen.full_name);
      row = db.prepare("SELECT * FROM repos WHERE full_name = ?").get(seen.full_name);
      const s = await snapshot(row);
      if (m[2]) return json(res, 200, s);
      return send(res, 200, statusPage(s, user, origin, row));
    }

    send(res, 404, page("Not found", `<header class="top">${LOGO}</header><p class="none">This page does not exist.</p>`));
  } catch (e) {
    console.error(e);
    if (url.pathname.startsWith("/api/")) return json(res, 400, { error: e.message });
    send(res, 500, page("Error", `<header class="top">${LOGO}</header><p class="err">${esc(e.message)}</p>`));
  }
}).listen(PORT, () => console.log(`factory-status on :${PORT}`));
