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
import { existsSync } from "node:fs";
import { openDb } from "./db.mjs";
import { createCipheriv, createDecipheriv, createHash, createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { landingPage } from "./landing.mjs";

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || "./data";
const SECRET = process.env.SECRET || "dev-secret-change-me";
const KEY = createHash("sha256").update(SECRET).digest();
const WINDOW = 30;
const INSTALL = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
mkdirSync(DATA, { recursive: true });

// --- storage --------------------------------------------------------------
// Postgres on Neon when DATABASE_URL is set, else a local SQLite file (db.mjs).
const db = await openDb({ url: process.env.DATABASE_URL, dataDir: DATA });
console.log(`storage: ${db.kind}`);

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
async function sessionUser(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)fs=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split(".");
  const sig = parts.pop();
  const v = parts.join(".");
  const good = Buffer.from(sign(v));
  if (good.length !== Buffer.from(sig).length || !timingSafeEqual(good, Buffer.from(sig))) return null;
  const [login, exp] = [parts.slice(0, -1).join("."), Number(parts.at(-1))];
  if (Date.now() > exp) return null;
  return (await db.one("SELECT login, token FROM users WHERE login = $1", login)) || null;
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
// The app's credentials live sealed in settings and are cached here (loaded at start-up).
let APP = null;
const setSetting = (k, v) => db.run("INSERT INTO settings (k, v) VALUES ($1, $2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
async function loadApp() {
  const r = await db.one("SELECT v FROM settings WHERE k = $1", "app");
  APP = r ? JSON.parse(open(r.v)) : null;
}
async function saveApp(app) {
  await setSetting("app", seal(JSON.stringify(app)));
  APP = app;
}
function appConfig() {
  return APP;
}
// The app's name and slug can be changed on GitHub at any time (Settings → Developer settings →
// GitHub Apps → Edit). The install link uses the slug, so keep the stored copy in step.
async function syncAppSlug() {
  const app = appConfig();
  if (!app) return;
  const r = await fetch("https://api.github.com/app", { headers: { authorization: `Bearer ${appJwt(app)}`, accept: "application/vnd.github+json", "user-agent": "factory-status" } }).catch(() => null);
  if (!r?.ok) return;
  const a = await r.json();
  if (a.slug && (a.slug !== app.slug || a.name !== app.name)) {
    await saveApp({ ...app, slug: a.slug, name: a.name });
    console.log(`app renamed: ${app.slug} -> ${a.slug}`);
  }
}
setTimeout(() => syncAppSlug().catch(() => {}), 5000);
setInterval(() => syncAppSlug().catch(() => {}), 5 * 60e3);

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
      for (let pg = 1; pg <= 10; pg++) {
        const r = await gh(token, `user/installations/${i.id}/repositories?per_page=100&page=${pg}`);
        for (const repo of r?.repositories || []) out.push({ id: repo.id, full_name: repo.full_name, private: repo.private, installation_id: i.id, account: { id: i.account.id, login: i.account.login, type: i.account.type } });
        if (!r || (r.repositories || []).length < 100) break;
      }
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
    const [meta, skillDirs, factoryJson, roster, routineDoc, workflowsList, hushSh, settingsJson] = await Promise.all([
      gh(token, `repos/${repo}`),
      gh(token, `repos/${repo}/contents/.claude/skills`).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/factory.json`, true).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/skills/monitor-meta/roster.json`, true).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/skills/cloud-routine.md`, true).catch(() => null),
      gh(token, `repos/${repo}/actions/workflows?per_page=100`).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/hooks/hush.sh`, true).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/settings.json`, true).catch(() => null),
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

    return { meta: { full_name: meta.full_name, private: meta.private, default_branch: meta.default_branch, url: meta.html_url }, skills, monitors, routines, notes, prices: config.prices || {}, client: { hush_sh: !!hushSh, cost_cmd: /\bcost\)/.test(hushSh || ""), hook: /hush\.sh session-end/.test(settingsJson || "") }, workflows: workflows.filter((w) => w.state === "active").map((w) => ({ id: w.id, name: w.name, path: w.path, url: w.html_url })) };
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

// GitHub metrics over the window: PR and issue flow, time to merge, who merged
async function readMetrics(token, repo, ci, issuesOpen) {
  return cached(`metrics:${repo}`, 10 * 60e3, async () => {
    const since = new Date(Date.now() - (WINDOW - 1) * 864e5).toISOString().slice(0, 10);
    const count = (q) => gh(token, `search/issues?per_page=1&q=${encodeURIComponent(`repo:${repo} ${q}`)}`).then((r) => r?.total_count ?? null).catch(() => null);
    const [prOpened, prMerged, prClosedUnmerged, issOpened, issClosed] = await Promise.all([
      count(`is:pr created:>=${since}`),
      count(`is:pr is:merged merged:>=${since}`),
      count(`is:pr is:closed is:unmerged closed:>=${since}`),
      count(`is:issue created:>=${since}`),
      count(`is:issue is:closed closed:>=${since}`),
    ]);
    const merged = [];
    for (let page = 1; page <= 4; page++) {
      const batch = (await gh(token, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`).catch(() => null)) || [];
      merged.push(...batch.filter((p) => p.merged_at && p.merged_at.slice(0, 10) >= since));
      if (batch.length < 100 || batch.at(-1).updated_at.slice(0, 10) < since) break;
    }
    const hours = merged.map((p) => (Date.parse(p.merged_at) - Date.parse(p.created_at)) / 36e5).sort((a, b) => a - b);
    const median = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
    const days = [...Array(WINDOW)].map((_, i) => new Date(Date.now() - (WINDOW - 1 - i) * 864e5).toISOString().slice(0, 10));
    const perDay = days.map((d) => ({ d, all: merged.filter((p) => p.merged_at.slice(0, 10) === d).length, agents: merged.filter((p) => p.merged_at.slice(0, 10) === d && AGENT_BRANCH.test(p.head.ref)).length }));
    const runs = ci.reduce((a, w) => a + w.runs, 0);
    const passed = ci.reduce((a, w) => a + Math.round(((w.pct || 0) * w.runs) / 100), 0);
    const ages = issuesOpen.map((i) => (Date.now() - Date.parse(i.created_at)) / 864e5).sort((a, b) => a - b);
    return {
      prs: { opened: prOpened, merged: prMerged, closed_unmerged: prClosedUnmerged, median_merge_h: median(hours), agent_share: merged.length ? Math.round((merged.filter((p) => AGENT_BRANCH.test(p.head.ref)).length / merged.length) * 100) : null, per_day: perDay },
      issues: { opened: issOpened, closed: issClosed, open: issuesOpen.length, median_age_d: median(ages) },
      ci: { runs, pass_rate: runs ? Math.round((passed / runs) * 1000) / 10 : null, failing_now: ci.filter((w) => w.last?.conclusion === "failure").map((w) => w.name) },
    };
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
        return { number: p.number, title: p.title, branch: p.head.ref, draft: p.draft, ci, url: p.html_url, author: p.user?.login || "", created_at: p.created_at, updated_at: p.updated_at };
      }),
    );
    const merged = (closedRaw || []).filter((p) => p.merged_at).map((p) => ({ number: p.number, title: p.title, branch: p.head.ref, merged_at: p.merged_at, url: p.html_url, author: p.user?.login || "", created_at: p.created_at })).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
    const closed = (closedRaw || []).filter((p) => !p.merged_at).map((p) => ({ number: p.number, title: p.title, branch: p.head.ref, closed_at: p.closed_at, url: p.html_url, author: p.user?.login || "", created_at: p.created_at })).sort((a, b) => (a.closed_at < b.closed_at ? 1 : -1));
    const runs = [];
    for (const r of runsRaw?.workflow_runs || []) if (!runs.some((x) => x.name === r.name)) runs.push({ name: r.name, status: r.status, conclusion: r.conclusion, at: r.updated_at, event: r.event, url: r.html_url });
    return { issues, prs, merged, closed, runs };
  });
}

// What Actions is doing right now: runs that have not finished, with their jobs and the step
// each job is on, plus the last few that did. One list call, then one jobs call per active run.
async function readLive(token, repo) {
  return cached(`live:${repo}`, 6e3, async () => {
    const list = await gh(token, `repos/${repo}/actions/runs?per_page=25`).catch(() => null);
    const base = (r) => ({ id: r.id, name: r.name, title: r.display_title, number: r.run_number, branch: r.head_branch, event: r.event, actor: r.actor?.login || "", status: r.status, conclusion: r.conclusion, started: r.run_started_at || r.created_at, updated: r.updated_at, url: r.html_url });
    const all = list?.workflow_runs || [];
    const active = await Promise.all(
      all.filter((r) => r.status !== "completed").slice(0, 6).map(async (r) => {
        const j = await gh(token, `repos/${repo}/actions/runs/${r.id}/jobs?per_page=30`).catch(() => null);
        const jobs = (j?.jobs || []).map((x) => {
          const steps = x.steps || [];
          const cur = steps.find((st) => st.status === "in_progress") || steps.find((st) => st.status !== "completed");
          return { name: x.name, status: x.status, conclusion: x.conclusion, started: x.started_at, completed: x.completed_at, done: steps.filter((st) => st.status === "completed").length, steps: steps.length, step: cur?.name || "", url: x.html_url };
        });
        return { ...base(r), jobs };
      }),
    );
    const recent = all.filter((r) => r.status === "completed").slice(0, 6).map(base);
    return { at: new Date().toISOString(), ok: !!list, active, recent };
  });
}

// --- costs -----------------------------------------------------------------------------
// Two kinds of rows in `costs`: a provider's spend for one day (source "aws", key = the day), and
// one Claude Code session's tokens (source "claude-code", key = the session id). Session dollars
// are estimated from list prices per million tokens; a model with no known price shows tokens only.
// A repo can set or override prices in .claude/factory.json: "prices": {"<model>": {"input": 3, "output": 15}}.
const PRICES = [
  [/opus-4-[56]/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-4/, { input: 3, output: 15 }],
  [/haiku-4/, { input: 1, output: 5 }],
];
function priceOf(model, overrides = {}) {
  if (overrides[model]) return overrides[model];
  return (PRICES.find(([re]) => re.test(model || "")) || [])[1] || null;
}
function sessionUsd(models, overrides) {
  let usd = 0;
  for (const [model, t] of Object.entries(models || {})) {
    const p = priceOf(model, overrides);
    if (!p) return null;
    // cache writes at 1.25x input (5 min) or 2x (1 h), reads at 0.1x
    usd += ((t.input || 0) * p.input + (t.output || 0) * p.output + (t.cache_write_5m || 0) * p.input * 1.25 + (t.cache_write_1h || 0) * p.input * 2 + (t.cache_read || 0) * p.input * 0.1) / 1e6;
  }
  return Math.round(usd * 100) / 100;
}
async function readCosts(repoId, prices) {
  const days = [...Array(WINDOW)].map((_, i) => new Date(Date.now() - (WINDOW - 1 - i) * 864e5).toISOString().slice(0, 10));
  const rows = (await db.all("SELECT source, key, day, usd, body, at FROM costs WHERE repo_id = $1 AND day >= $2 ORDER BY day", repoId, days[0])).map((r) => ({ ...r, ...JSON.parse(r.body) }));
  if (!rows.length) return null;
  const sessions = rows.filter((r) => r.source === "claude-code").map((r) => ({ ...r, usd: r.usd ?? sessionUsd(r.models, prices) }));
  const tok = (t) => (t.input || 0) + (t.output || 0) + (t.cache_write_5m || 0) + (t.cache_write_1h || 0) + (t.cache_read || 0);
  for (const x of sessions) x.tokens = Object.values(x.models || {}).reduce((a, t) => ({ input: a.input + (t.input || 0), output: a.output + (t.output || 0), cache_write: a.cache_write + (t.cache_write_5m || 0) + (t.cache_write_1h || 0), cache_read: a.cache_read + (t.cache_read || 0), total: a.total + tok(t) }), { input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0 });
  const providers = rows.filter((r) => r.source !== "claude-code");
  const sources = [...new Set(providers.map((r) => r.source))];
  if (sessions.some((x) => x.usd != null)) sources.push("claude-code");
  const perDay = days.map((d) => {
    const by = {};
    for (const r of providers) if (r.day === d && r.usd != null) by[r.source] = (by[r.source] || 0) + r.usd;
    const cc = sessions.filter((x) => x.day === d && x.usd != null).reduce((a, x) => a + x.usd, 0);
    if (cc) by["claude-code"] = cc;
    return { d, by, total: Object.values(by).reduce((a, b) => a + b, 0), tokens: sessions.filter((x) => x.day === d).reduce((a, x) => a + x.tokens.total, 0) };
  });
  const total = {};
  for (const p of perDay) for (const [k, v] of Object.entries(p.by)) total[k] = (total[k] || 0) + v;
  const last7 = perDay.slice(-8, -1);
  const lastBreakdown = {};
  for (const r of providers) if (r.breakdown) lastBreakdown[r.source] = { day: r.day, breakdown: r.breakdown };
  return {
    sources,
    per_day: perDay,
    total,
    total_usd: Object.values(total).reduce((a, b) => a + b, 0),
    yesterday: perDay[perDay.length - 2]?.total || 0,
    avg7: last7.reduce((a, p) => a + p.total, 0) / (last7.length || 1),
    tokens_30d: sessions.reduce((a, x) => a + x.tokens.total, 0),
    sessions_30d: sessions.length,
    sessions: sessions.slice(-20).reverse().map((x) => ({ name: x.name || "session", day: x.day, at: x.at, tokens: x.tokens, models: Object.keys(x.models || {}), usd: x.usd, turns: x.turns || null })),
    breakdown: lastBreakdown,
    updated: Object.fromEntries(sources.map((src) => [src, rows.filter((r) => r.source === src).map((r) => r.at).sort().pop()])),
  };
}

async function insertCost(repoId, c) {
  const source = String(c.source || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
  if (!source) throw new Error("source is required (aws, vercel, neon, anthropic, claude-code, ...)");
  const day = c.day && /^\d{4}-\d{2}-\d{2}$/.test(c.day) ? c.day : new Date().toISOString().slice(0, 10);
  const usd = c.usd == null || c.usd === "" || Number.isNaN(Number(c.usd)) ? null : Math.round(Number(c.usd) * 100) / 100;
  if (source !== "claude-code" && usd == null) throw new Error("usd is required for provider costs");
  const key = String(c.key || c.session_id || day).slice(0, 100);
  const models = {};
  for (const [m, t] of Object.entries(c.models || {})) models[String(m).slice(0, 60)] = Object.fromEntries(["input", "output", "cache_write_5m", "cache_write_1h", "cache_read"].map((k) => [k, Math.max(0, Number(t?.[k]) || 0)]));
  const breakdown = c.breakdown && typeof c.breakdown === "object" ? Object.fromEntries(Object.entries(c.breakdown).slice(0, 40).map(([k, v]) => [String(k).slice(0, 60), Math.round(Number(v) * 100) / 100])) : null;
  const body = JSON.stringify({ name: String(c.name || "").slice(0, 80), models, breakdown, turns: Number(c.turns) || null, note: String(c.note || "").slice(0, 300) });
  await db.run("INSERT INTO costs (repo_id, source, key, day, usd, body, at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(repo_id, source, key) DO UPDATE SET day = excluded.day, usd = excluded.usd, body = excluded.body, at = excluded.at", repoId, source, key, day, usd, body, new Date().toISOString());
}

// --- judging monitors (the /monitor-meta rules, plus the chronic ratio) -------------------
const AGENT_BRANCH = /^(claude\/|codex\/|fix\/pr-sweep|audit|fix-issues|fix\/issue-|agent\/)/;
async function judge(factory, repoId) {
  const WEEKS = 12;
  const since = new Date(Date.now() - WEEKS * 7 * 864e5).toISOString();
  const beats = (await db.all("SELECT monitor, ts, status, body FROM heartbeats WHERE repo_id = $1 AND ts >= $2 ORDER BY ts DESC", repoId, since)).map((b) => ({ ...JSON.parse(b.body), monitor: b.monitor, ts: b.ts, status: b.status }));
  const roster = [...factory.monitors];
  // A SessionEnd beat named after a declared routine's slash command is evidence for that
  // routine, not a monitor of its own. Anything else unknown still shows, marked unlisted.
  const isRoutine = (id) => factory.routines.some((r) => routineMatch(r)(id));
  const sessions = {};
  for (const b of beats) if (b.source === "session" && !sessions[b.monitor]) sessions[b.monitor] = b.ts;
  for (const id of new Set(beats.map((b) => b.monitor))) {
    if (roster.some((m) => m.id === id)) continue;
    if (isRoutine(id) && beats.every((b) => b.monitor !== id || b.source === "session")) continue;
    roster.push({ id, cadence: "daily", max_silence_hours: 50, unlisted: true });
  }
  const days = [...Array(WINDOW)].map((_, i) => new Date(Date.now() - (WINDOW - 1 - i) * 864e5).toISOString().slice(0, 10));
  const RANK = { ok: 1, degraded: 2, skipped: 3 };

  const monitors = roster.map((m) => {
    const all = beats.filter((b) => b.monitor === m.id);
    const mine = all.some((b) => b.source !== "session") ? all.filter((b) => b.source !== "session") : all;
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
    const worst = (list) => list.reduce((w, b) => (!w || RANK[b.status] > RANK[w] ? b.status : w), "");
    // Weekly monitors get one bar per week, so a monitor that runs once a week reads as a solid
    // line, not one green bar between six grey ones.
    if (m.cadence === "weekly") {
      const buckets = [...Array(WEEKS)].map((_, i) => {
        const end = Date.now() - (WEEKS - 1 - i) * 7 * 864e5, start = end - 7 * 864e5;
        const inWeek = mine.filter((b) => { const t = new Date(b.ts).getTime(); return t > start && t <= end; });
        return { s: worst(inWeek), label: `Week to ${new Date(end).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })}` };
      });
      return { id: m.id, cadence: "weekly", routine: m.routine || "", state, why, unlisted: !!m.unlisted, last, runs: mine.length, buckets, span: `${WEEKS} weeks ago`, filed: [...new Set(mine.flatMap((b) => b.filed || []))].slice(0, 20), history: mine.slice(0, 15).map((b) => ({ ts: b.ts, status: b.status, source: b.source, note: b.note || "", swept: b.swept || {}, filed: b.filed || [] })) };
    }
    const byDay = {};
    for (const b of mine) {
      const d = b.ts.slice(0, 10);
      if (!byDay[d] || RANK[b.status] > RANK[byDay[d]]) byDay[d] = b.status;
    }
    return { id: m.id, cadence: m.cadence || "daily", routine: m.routine || "", state, why, unlisted: !!m.unlisted, last, runs: mine.length, buckets: days.map((d) => ({ s: byDay[d] || "", label: new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" }) })), span: `${WINDOW} days ago`, filed: [...new Set(mine.flatMap((b) => b.filed || []))].slice(0, 20), history: mine.slice(0, 15).map((b) => ({ ts: b.ts, status: b.status, source: b.source, note: b.note || "", swept: b.swept || {}, filed: b.filed || [] })) };
  });
  const cut = new Date(Date.now() - WINDOW * 864e5).toISOString();
  return { monitors, beats: beats.filter((b) => b.ts >= cut).length, sessions };
}

// Which session names count as a run of this routine: "/fix-issues" matches fix-issues only,
// "/audit-*" (or a prompt that names a family like "/audit-") matches every audit-… skill.
function routineMatch(r) {
  const m = (r.prompt || "").match(/\/([a-z][a-z0-9:_-]*)(\*)?/);
  if (!m) return () => false;
  return m[2] || m[1].endsWith("-") ? (id) => id.startsWith(m[1]) : (id) => id === m[1];
}

function routineState(r, monitors, merged, sessions = {}) {
  const fed = monitors.filter((m) => m.routine && m.routine === r.name && m.last);
  let last = fed.map((m) => m.last.ts).sort().pop() || null;
  let evidence = fed.length ? "heartbeat" : "";
  if (!last && r.source === "Claude Code") {
    const skill = (r.prompt.match(/\/[a-z][a-z0-9-]*/) || [""])[0].slice(1);
    const m = monitors.find((x) => x.id === skill && x.last);
    if (m) [last, evidence] = [m.last.ts, "heartbeat"];
  }
  const match = routineMatch(r);
  const ran = Object.entries(sessions).filter(([id]) => match(id)).map(([, ts]) => ts).sort().pop();
  if (ran && (!last || ran > last)) [last, evidence] = [ran, "routine session"];
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
  const metrics = await readMetrics(token, repo, ci, queue.issues);
  const { monitors, beats, sessions } = await judge(factory, repoRow.id);
  const routines = factory.routines.map((r) => routineState(r, monitors, queue.merged, sessions));
  const runsByName = Object.fromEntries(queue.runs.map((r) => [r.name, r]));
  for (const r of routines) if (r.source === "GitHub Actions" && runsByName[r.name]) [r.last_seen, r.evidence] = [runsByName[r.name].at, "Actions run"];
  const bad = monitors.filter((m) => ["dead", "lying", "degraded"].includes(m.state));
  const warn = monitors.filter((m) => m.state === "warn");
  const lateRoutines = routines.filter((r) => r.last_seen && (Date.now() - new Date(r.last_seen)) / 36e5 > r.period_h * 1.25 + 2);
  const redCi = queue.runs.filter((r) => r.conclusion === "failure");
  const overall = bad.length ? "down" : warn.length || lateRoutines.length || redCi.length ? "degraded" : "ok";
  const day = new Date(Date.now() - 864e5).toISOString();
  return {
    v: SNAP_V,
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
    metrics,
    costs: await readCosts(repoRow.id, factory.prices),
    setup: { ...(factory.client || {}), skill_beats: monitors.filter((m) => m.last && m.last.source !== "session").length },
    notes: factory.notes,
  };
}

// One GitHub read per repo at a time. The result is kept in the database so a page can render
// the last snapshot instantly, even right after the machine wakes up, and refresh behind it.
const inflight = new Map();
function refresh(row) {
  if (!inflight.has(row.id)) {
    const p = snapshot(row)
      .then(async (s) => {
        await db.run("INSERT INTO snapshots (repo_id, at, body) VALUES ($1, $2, $3) ON CONFLICT(repo_id) DO UPDATE SET at = excluded.at, body = excluded.body", row.id, Date.now(), JSON.stringify(s));
        return s;
      })
      .finally(() => inflight.delete(row.id));
    inflight.set(row.id, p);
  }
  return inflight.get(row.id);
}
const FRESH_MS = 60e3;
// Bump when the snapshot's shape changes, so a page never renders one saved by older code.
const SNAP_V = 6;

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

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">`;
const MARK = (color = "currentColor") => `<svg viewBox="0 0 40 40" width="22" height="22" aria-hidden="true"><path d="M3 22h9l3.5-9 6 18 3.5-9h12" fill="none" stroke="${color}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LOGO = `<a class="logo" href="/">${MARK()}<span>hush</span></a>`;

const CSS = `
:root{--bg:#fff;--ink:#14161c;--muted:#666a73;--faint:#9a9ea5;--line:#ebecef;--ok:#2fb36b;--warn:#f0a92c;--bad:#e5484d;--empty:#e9eaed;
--night:#070b1c;--dusk:#1b2350;--dawn:#c4532a;--glow:#f0a35e;
--f:"Open Sans","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--f);-webkit-font-smoothing:antialiased}
::selection{background:var(--dusk);color:#fff}
a{color:var(--ink)}a:focus-visible,summary:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:3px}
code{font-family:var(--mono);font-size:.86em}
.wrap{max-width:1040px;margin:0 auto;padding-inline:16px;padding-block:32px 72px}
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
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.stat{padding:16px 20px;border-left:1px solid var(--line);display:grid;gap:2px;min-width:0}.stat:first-child{border-left:0}
.stat b{font-size:26px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}.stat b i{font-style:normal;color:var(--faint);font-weight:500}
.stat span{font-size:13px;color:var(--ink)}.stat small{font-size:12px;color:var(--faint)}.stat small[data-s=bad]{color:var(--bad)}
.chart{grid-column:1/-1;border-top:1px solid var(--line);padding:16px 20px 12px}
.cols{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;height:64px;align-items:end}
.cols div{height:100%;display:flex;align-items:flex-end}.cols i{display:flex;align-items:flex-end;width:100%;background:#cfd2d8;border-radius:2px 2px 0 0;min-height:1px}
.cols em{display:block;width:100%;background:var(--ink);border-radius:2px 2px 0 0}
.key{display:inline-block;width:9px;height:9px;background:var(--ink);border-radius:2px;margin-right:4px;vertical-align:-1px}
@media(max-width:700px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat:nth-child(3){border-left:0}.stat:nth-child(n+3){border-top:1px solid var(--line)}}
.sk{background:linear-gradient(90deg,#eef0f2 0,#f6f7f8 40%,#eef0f2 80%);background-size:300% 100%;border-radius:4px}
@media (prefers-reduced-motion:no-preference){.sk{animation:sk 1.4s ease-in-out infinite}}
@keyframes sk{0%{background-position:100% 0}100%{background-position:0 0}}
.sk-t{display:block;height:12px}.row-head .sk-t{display:inline-block}.stat .sk-t{display:block}
.bars i.sk{background:linear-gradient(90deg,#eef0f2 0,#f6f7f8 40%,#eef0f2 80%);background-size:3000% 100%}
.sk-banner{background:#e3e5e8}
.sk-note{color:var(--faint);font-size:13px;text-align:center;margin-top:8px}
.updated::after{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-left:8px;vertical-align:middle;background:transparent}
.wrap[data-loading="1"] .updated::after{background:var(--warn)}
@media (prefers-reduced-motion:no-preference){.wrap[data-loading="1"] .updated::after{animation:beat 1s ease-in-out infinite}}
@keyframes beat{50%{opacity:.3}}
.wrap[data-failed="1"] .updated::after{background:var(--bad)}
.onboard{border:1px solid var(--line);border-radius:12px;padding:22px 24px 8px;margin:0 0 36px;box-shadow:0 18px 40px -28px rgba(20,24,30,.25)}
.onboard>h2{color:var(--ink);font-size:16px;letter-spacing:-.01em;margin:0 0 18px}
.ob{list-style:none;margin:0;padding:0}
.ob>li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:14px;padding:0 0 20px;position:relative}
.ob>li:not(:last-child)::before{content:"";position:absolute;left:9.5px;top:24px;bottom:4px;width:1px;background:var(--line)}
.ob>li>.gi,.ob>li>.live-dot{margin-top:3px;justify-self:center}.ob>li>.live-dot{margin-top:7px}
.ob b{font-weight:600}.ob b+small{margin-left:6px}.ob b+small,.ob small{color:var(--faint);font-weight:400;font-size:12px}
.ob span{display:block;color:var(--muted);font-size:13.5px;margin-top:2px}
.ob li.done b{color:var(--muted);font-weight:500}
.ob-n{width:20px;height:20px;border-radius:50%;border:1.5px solid var(--ink);display:grid;place-items:center;font:600 11px var(--f);margin-top:1px}
.ob li.wait b{color:var(--warn)}
.cmd{position:relative;margin:8px 0 6px}.cmd pre{margin:0;padding-right:72px;white-space:pre-wrap;word-break:break-all}
.copy{position:absolute;top:7px;right:7px;font:500 12px var(--f);border:1px solid var(--line);background:#fff;border-radius:6px;padding:4px 9px;cursor:pointer;color:var(--ink)}.copy:hover{background:#f6f7f8}
.more{margin-top:8px}.more summary{cursor:pointer;color:var(--muted);font-size:13px}.more pre{margin:6px 0 12px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);overflow:hidden}
.grid2>.row{background:var(--bg);border-top:0}.grid2>.row:last-child:nth-child(odd){grid-column:1/-1}
@media(max-width:760px){.grid2{grid-template-columns:minmax(0,1fr)}}
.tabs{margin-bottom:32px}.tabs>input{position:absolute;opacity:0;pointer-events:none}
.tabs>label{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;margin:0 4px 10px 0;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--muted);cursor:pointer;user-select:none}
.tabs>label:hover{color:var(--ink)}.tabs>label .count{color:var(--faint);font-variant-numeric:tabular-nums}
.tabs>input:checked+label{color:var(--ink);border-color:var(--ink);font-weight:500}
.tabs>input:focus-visible+label{outline:2px solid var(--ink);outline-offset:2px}
.tabs .tab-panel{display:none;margin-bottom:0}
#prtab-open:checked~.tab-panel[data-tab=open],#prtab-merged:checked~.tab-panel[data-tab=merged],#prtab-closed:checked~.tab-panel[data-tab=closed]{display:block}
.line.pr{text-decoration:none;color:var(--ink);align-items:center}.line.pr:hover{background:#fafafb}
.line.pr .name{display:flex;align-items:flex-start;gap:10px}.line.pr .name .gi{margin-top:3px}
.pr-title{font-weight:500}
.line.pr .meta{display:flex;align-items:center;gap:8px}
.agent-tag{font:500 11px var(--f);color:#fff;background:var(--ink);border-radius:6px;padding:1px 6px}
@media(max-width:520px){.line.pr .meta code.branch{display:none}}
.cols i.stack{display:flex;flex-direction:column-reverse;overflow:hidden;background:transparent}.cols i.stack em{display:block;min-height:1px;border-radius:0}
.costs-fold{margin:-16px 0 32px}.cost-note{color:var(--faint);font-size:12px;margin-top:8px}.costs-fold .line .meta b{color:var(--ink);font-weight:600}
.ci-live{margin-bottom:32px}
:root{--sel:#f1f2f4}
.app-wrap{max-width:none;padding:0}
.app{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;border-right:1px solid var(--line);padding:22px 12px 16px;display:flex;flex-direction:column;gap:18px;background:#fbfbfc}
.side .logo{padding:0 10px}
.repo-box{padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.repo-name{display:block;font:500 13px var(--mono);color:var(--ink);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.repo-name:hover{text-decoration:underline}
.repo-state{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);margin-top:4px}
.repo-state i{width:7px;height:7px;border-radius:50%;background:var(--ok)}.repo-state[data-s=degraded] i{background:var(--warn)}.repo-state[data-s=down] i{background:var(--bad)}
.snav{display:flex;flex-direction:column;gap:2px}
.snav a,.side-foot a{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:14px}
.snav a:hover,.side-foot a:hover{background:var(--sel);color:var(--ink)}
.ni{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.snav a span:first-of-type,.side-foot a span:first-of-type{flex:1}
.nc{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}
.nb{font:600 11px var(--f);color:#fff;background:var(--bad);border-radius:999px;min-width:18px;height:18px;padding:0 5px;display:inline-grid;place-items:center}.nb[data-t=warn]{background:var(--warn)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--line);padding-top:12px}
.side-foot .updated{padding:6px 10px 0;font-size:12px;color:var(--faint)}
.main{padding:36px 48px 80px;max-width:1120px;width:100%}
.vh{margin-bottom:24px}.vh h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px;font-weight:600}.vh p{color:var(--muted);margin:0;max-width:70ch}
.solo{grid-template-columns:minmax(0,1fr)}.solo .main{margin:0 auto}
.tb-btn{background:none;border:0;color:#d5dbdb;font:inherit;padding:0;cursor:pointer}.tb-btn:hover{color:#fff;background:none}
.repos-t{margin-bottom:28px}
.rrow2{display:grid;grid-template-columns:minmax(0,2.4fr) repeat(4,minmax(0,1fr)) 70px;gap:12px;align-items:center;padding:12px 20px;border-top:1px solid var(--line);text-decoration:none;color:var(--ink)}
.rrow2:first-child{border-top:0}a.rrow2:hover{background:#f9fafa}
.rrow2.head{font-size:12px;color:var(--muted);font-weight:600;padding-block:10px}
.rrow2 .rn{display:flex;align-items:flex-start;gap:10px;min-width:0}.rrow2 .rn b{font-weight:600}.rrow2 small{color:var(--faint);font-weight:400}
.rrow2 .dot{width:9px;height:9px;border-radius:50%;background:var(--empty);margin-top:6px;flex:none}.rrow2 .dot[data-s=ok]{background:var(--ok)}.rrow2 .dot[data-s=degraded]{background:var(--warn)}.rrow2 .dot[data-s=down]{background:var(--bad)}
.rrow2 .num{text-align:right;font-variant-numeric:tabular-nums}.rrow2 .num i{font-style:normal;color:var(--faint)}
.rrow2 .go{text-align:right;color:var(--link);font-size:13px}
@media(max-width:820px){.rrow2{grid-template-columns:minmax(0,1fr) auto}.rrow2>span:nth-child(n+2):not(.go){display:none}.rrow2.head{display:none}}
.chat{display:flex;flex-direction:column;gap:12px;max-width:820px}
.chat-log{display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 360px);min-height:180px;overflow-y:auto;padding:4px 2px}
.chat-empty{color:var(--faint);font-size:14px;padding:24px 0}
.msg{padding:12px 16px;border-radius:12px;line-height:1.55;max-width:92%;overflow-wrap:anywhere}
.msg.user{align-self:flex-end;background:var(--squid,#232f3e);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}
.msg.assistant{align-self:flex-start;background:var(--bg);box-shadow:var(--shadow,0 0 0 1px var(--line));border-bottom-left-radius:4px}
.msg.err{color:var(--bad)}.msg ul{margin:6px 0;padding-left:20px}.msg pre{margin:8px 0;white-space:pre-wrap}.msg code{background:#f2f3f3;padding:1px 5px;border-radius:4px}
.typing{display:inline-flex;gap:4px}.typing i{width:6px;height:6px;border-radius:50%;background:var(--faint)}
@media (prefers-reduced-motion:no-preference){.typing i{animation:beat 1s ease-in-out infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font:500 13px var(--f);cursor:pointer}.chip:hover{border-color:var(--ink);background:var(--bg)}
.ask{display:flex;gap:8px;align-items:flex-end;margin:0;background:var(--bg);border-radius:12px;padding:8px;box-shadow:var(--shadow,0 0 0 1px var(--line))}
.ask textarea{flex:1;border:0;resize:none;font:15px/1.45 var(--f);color:var(--ink);padding:6px 8px;background:transparent;outline:none}
.ask button{flex:none}.ask button:disabled{opacity:.5;cursor:default}
.chat-note{font-size:12px;color:var(--faint)}
.openable{cursor:pointer}.row.openable:hover,.line.openable:hover,.mini li.openable:hover{background:#f9fafa}.openable:focus-visible{outline:2px solid var(--link);outline-offset:-2px}
.win{position:fixed;z-index:50;display:flex;flex-direction:column;background:var(--bg);border-radius:10px;box-shadow:0 0 0 1px rgba(0,28,36,.12),0 14px 40px -8px rgba(0,28,36,.35);overflow:hidden;min-width:380px;min-height:280px}
.win.moving{user-select:none}.win.moving .win-body{pointer-events:none}
.win-bar{display:flex;align-items:center;gap:8px;height:42px;padding:0 6px 0 16px;border-bottom:1px solid var(--line);cursor:grab;flex:none;background:#fafafa}.win.moving .win-bar{cursor:grabbing}
.win-kind{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);flex:none}
.win-title{flex:1;min-width:0;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--faint)}.win.active .win-title{color:var(--ink)}
.win-acts{display:flex;gap:2px;flex:none}
.win-btn{display:grid;place-items:center;width:30px;height:30px;border-radius:6px;background:none;border:0;padding:0;color:var(--muted);cursor:pointer}.win-btn:hover{background:#eceeef;color:var(--ink)}
.win-btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.win-body{flex:1;overflow:auto;padding:16px 18px 20px;font-size:14px}
.win-gone{display:none;padding:8px 18px;font-size:12px;color:var(--warn-ink,#8d6605);background:#fff7e6;border-top:1px solid var(--line)}.win.gone .win-gone{display:block}
.win-rz{position:absolute;z-index:2}.win-rz[data-dir=n],.win-rz[data-dir=s]{left:8px;right:8px;height:6px;cursor:ns-resize}.win-rz[data-dir=n]{top:-3px}.win-rz[data-dir=s]{bottom:-3px}
.win-rz[data-dir=e],.win-rz[data-dir=w]{top:8px;bottom:8px;width:6px;cursor:ew-resize}.win-rz[data-dir=e]{right:-3px}.win-rz[data-dir=w]{left:-3px}
.win-rz[data-dir=ne],.win-rz[data-dir=nw],.win-rz[data-dir=se],.win-rz[data-dir=sw]{width:12px;height:12px}.win-rz[data-dir=ne]{top:-3px;right:-3px;cursor:nesw-resize}.win-rz[data-dir=sw]{bottom:-3px;left:-3px;cursor:nesw-resize}.win-rz[data-dir=nw]{top:-3px;left:-3px;cursor:nwse-resize}.win-rz[data-dir=se]{bottom:-3px;right:-3px;cursor:nwse-resize}
.win-dock{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:45;display:flex;gap:8px;padding:6px;border-radius:12px;background:rgba(35,47,62,.92);box-shadow:0 8px 24px -8px rgba(0,0,0,.4);max-width:calc(100vw - 32px);overflow-x:auto}
.win-chip{background:rgba(255,255,255,.08);color:#fff;border:0;border-radius:8px;padding:6px 12px;font:500 13px var(--f);white-space:nowrap;cursor:pointer}.win-chip:hover{background:rgba(255,255,255,.18)}.win-chip span{color:#aab7b8;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.w-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}.w-why{color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;background:#e9f5e3;color:var(--ok)}.pill.sm{padding:0 8px;font-size:11px}
.pill[data-s=warn]{background:#fff4e0;color:var(--warn-ink,#8d6605)}.pill[data-s=bad]{background:#fde8e5;color:var(--bad)}.pill[data-s=none]{background:#f2f3f3;color:var(--muted)}.pill[data-s=merged]{background:#f1eaff;color:#8250df}
.bars.tall{height:44px;margin-top:0}
.kv{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px 14px;margin:16px 0;font-size:13.5px}.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.win-body h4{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);margin:20px 0 8px}
.w-list{display:grid;border:1px solid var(--line);border-radius:8px}.w-list>div{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:10px;align-items:baseline;padding:8px 12px;border-top:1px solid var(--line);font-size:13px}.w-list>div:first-child{border-top:0}
.w-list>div.openable{grid-template-columns:minmax(0,1fr) auto}
.w-note{background:#f9fafa;border-left:3px solid var(--line);padding:8px 12px;margin:0 0 12px;font-size:13px;color:var(--muted)}
.w-title{font-size:16px;font-weight:600;margin:0 0 4px}
@media(max-width:820px){.win{inset:40px 0 0 0!important;width:auto!important;height:auto!important;border-radius:12px 12px 0 0;min-width:0}.win-rz{display:none}.win-bar{cursor:default}}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:0 0 32px}
.card{border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.card-h h3{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted);margin:0}
.card-h a{font-size:12px;color:var(--faint);text-decoration:none}.card-h a:hover{color:var(--ink)}
.card .big{font-size:28px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}.card .big i{font-style:normal;color:var(--faint);font-weight:500}
.card .cap{color:var(--muted);font-size:13px;margin-top:4px}.card .cap.ok{color:var(--ok)}.card .cap.bad{color:var(--bad)}
.mini{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px;font-size:13px}.mini li{display:flex;justify-content:space-between;gap:10px}.mini li>span:first-child,.mini code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:1000px){.cards{grid-template-columns:minmax(0,1fr)}}
@media(max-width:820px){
  .app{grid-template-columns:minmax(0,1fr)}
  .side{position:sticky;top:0;z-index:5;height:auto;flex-direction:row;align-items:center;gap:10px;padding:10px 12px;border-right:0;border-bottom:1px solid var(--line);overflow-x:auto}
  .side .logo span,.repo-box,.side-foot .updated{display:none}
  .snav{flex-direction:row}.snav a span:first-of-type,.side-foot a span:first-of-type{flex:none}
  .snav a,.side-foot a{white-space:nowrap;padding:6px 10px}
  .side-foot{margin:0;flex-direction:row;border:0;padding:0}
  .main{padding:24px 16px 64px}
}#ci-live .group{margin-bottom:0}.run-group+.recent-label{margin-top:18px}.recent-label{font-size:12px;color:var(--faint);margin:0 0 8px 2px}
.live-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}.live-head h2{margin:0}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--empty)}.live-dot[data-on="0"]{background:var(--ok)}.live-dot[data-on="1"]{background:var(--warn);box-shadow:0 0 0 0 rgba(240,169,44,.6)}
@media (prefers-reduced-motion:no-preference){.live-dot[data-on="1"]{animation:ping 1.6s ease-out infinite}.gi.spin{animation:spin .9s linear infinite;transform-origin:50% 50%}.gi .pulse{animation:beat 1.2s ease-in-out infinite}.rrow.just{animation:flash 2.4s ease-out}.job-bar i{transition:width .6s ease}}
@keyframes ping{0%{box-shadow:0 0 0 0 rgba(240,169,44,.55)}100%{box-shadow:0 0 0 8px rgba(240,169,44,0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes flash{0%{background:#eaf7ef}100%{background:transparent}}
.live-meta{color:var(--faint);font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums}
.gi{width:16px;height:16px;flex:none;display:block}
.faint{color:var(--faint);font-weight:400}
.run{border-top:1px solid var(--line)}.run:first-child{border-top:0}
.run-head{display:flex;align-items:flex-start;gap:12px;padding:14px 20px;text-decoration:none;color:var(--ink)}.run-head:hover{background:#fafafb}.run-head .gi{margin-top:3px}
.run-main{flex:1;min-width:0}.run-title{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-sub{display:block;color:var(--muted);font-size:12px}.run-sub b{font-weight:500;color:var(--ink)}
.run-side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}
.run-time{font-size:12px;font-variant-numeric:tabular-nums;color:var(--ink)}
code.branch{font:500 11.5px var(--mono);color:#0969da;background:#ddf4ff;border-radius:6px;padding:1px 7px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}
.jobs{list-style:none;margin:0;padding:0 20px 12px 48px;display:grid;gap:2px}
.job{display:grid;grid-template-columns:16px minmax(0,1fr) auto;column-gap:10px;align-items:center;font-size:13px;padding:4px 0}
.job-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.job[data-st=queued] .job-name,.job[data-st=waiting] .job-name{color:var(--muted)}
.job-step{grid-column:2;grid-row:2;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.job-step:empty{display:none}
.job-time{grid-column:3;grid-row:1;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.job-bar{grid-column:2/4;height:3px;border-radius:2px;background:var(--empty);overflow:hidden;margin-top:4px}.job-bar i{display:block;height:100%;background:var(--warn);border-radius:2px}
.recent .rrow{text-decoration:none;color:var(--ink);align-items:center}.recent .rrow:hover{background:#fafafb}
.recent .name{display:flex;align-items:flex-start;gap:10px}.recent .name .gi{margin-top:3px}
.recent .meta{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.state[data-run]::before{content:"";display:inline-block;width:9px;height:9px;margin-right:6px;border:2px solid rgba(240,169,44,.3);border-top-color:var(--warn);border-radius:50%;vertical-align:-1px}
@media (prefers-reduced-motion:no-preference){.state[data-run]::before{animation:spin .9s linear infinite}}
@media(max-width:520px){.run-head{padding-inline:14px;flex-wrap:wrap}.run-side{flex-direction:row;align-items:center;width:100%;padding-left:28px;justify-content:space-between}.jobs{padding:0 14px 12px 42px}.recent .meta code.branch{display:none}}
@media(max-width:520px){.wrap{padding-block:24px 56px}.row,.line{padding-inline:14px}.name small{display:block;margin-left:0}.bars{gap:1px}}
`;
// Loaded after every other rule so it wins over the page's own styles.
const THEME = `
/* Console theme: the feel of a cloud console (dark top bar, grey canvas, white containers, blue
   links, orange accent). Palette and type only; no third-party names or marks. */
:root{--ink:#16191f;--muted:#545b64;--faint:#879596;--line:#e9ebed;--ok:#1d8102;--warn:#ff9900;--bad:#d13212;--empty:#e9ebed;
--canvas:#f2f3f3;--link:#0073bb;--accent:#ec7211;--squid:#232f3e;--sel:#f2f3f3;--warn-ink:#8d6605;
--shadow:0 1px 1px 0 rgba(0,28,36,.3),1px 1px 1px 0 rgba(0,28,36,.15),-1px 1px 1px 0 rgba(0,28,36,.15)}
body{font-size:14px}
html[data-view] body{background:var(--canvas)}
h2{font-size:14px;font-weight:700;color:var(--ink)}
.state[data-s=warn],.card .cap.warn{color:var(--warn-ink)}
.banner{border-radius:8px;font-size:16px}.banner[data-s=degraded]{color:var(--ink)}.banner[data-s=degraded] svg circle:first-child{fill:var(--ink);fill-opacity:.15}.banner[data-s=degraded] svg path,.banner[data-s=degraded] svg circle+circle{stroke:var(--ink);fill:var(--ink)}.banner[data-s=degraded] svg path{fill:none}
button,.btn{background:var(--accent);border-radius:20px;font-weight:700}button:hover,.btn:hover{background:#eb5f07}
.btn.ghost{background:none}.btn.ghost:hover{background:none;color:var(--ink)}
html[data-view] .group,html[data-view] .card,html[data-view] .onboard{background:var(--bg);border-color:transparent;border-radius:8px;box-shadow:var(--shadow)}
html[data-view] .tabs>label{background:var(--bg)}
.vh h1{font-size:28px;font-weight:700;letter-spacing:-.01em}
.stat b,.card .big{font-weight:700}
.main a:not([class]),.detail a,.cap a,.hint a,.ob a{color:var(--link)}
.topbar{grid-column:1/-1;position:sticky;top:0;z-index:6;height:40px;display:flex;align-items:center;gap:18px;padding:0 20px;background:var(--squid);color:#d5dbdb;font-size:14px}
.topbar .logo{color:#fff;font-size:16px}.topbar .logo svg{color:var(--warn);width:20px;height:20px}
.crumbs{display:flex;align-items:center;gap:8px;min-width:0}.crumbs a{color:#d5dbdb;text-decoration:none}.crumbs a:hover{color:#fff;text-decoration:underline}.crumbs span{color:#879596}.crumbs b{color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:14px}.tb-user{color:#d5dbdb}
.app{grid-template-rows:auto 1fr}
.side{top:40px;height:calc(100vh - 40px);background:var(--bg);padding-top:18px}
.repo-box{border:0;padding:4px 10px 10px;border-bottom:1px solid var(--line);border-radius:0}
.snav a,.side-foot a{border-radius:0;color:var(--muted)}.snav a:hover,.side-foot a:hover{background:none;color:var(--accent)}
.copy{border-radius:20px}
@media(max-width:820px){.side{top:40px;height:auto}.topbar .logo span{display:none}}
html[data-view] .grid2{background:var(--line)}
`;
const CHECK = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M6 10.2l2.7 2.6L14 7.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ALERT = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg>`;
const ICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' rx='10' fill='%23070b1c'/><path d='M5 22h8l3-8 5 16 3-8h11' fill='none' stroke='%23f0a35e' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/></svg>">`;
// A live page swaps its .wrap for a fresh render: now when it was served stale or as a
// skeleton, then every two minutes. Open <details> stay open across swaps.
const LIVE = `<script>(()=>{const u=location.pathname+"?partial=1";let busy=0;
const pull=async()=>{if(busy)return;busy=1;const w=document.querySelector(".wrap");w.dataset.loading="1";
try{const r=await fetch(u,{credentials:"same-origin"});if(r.status===401){location.href="/auth/login";return}
const d=new DOMParser().parseFromString(await r.text(),"text/html");const n=d.querySelector(".wrap");if(!n)throw 0;
if(!r.ok)throw 0;const open=[...w.querySelectorAll("details")].map(x=>x.open),on=[...w.querySelectorAll("input[type=radio]:checked")].map(x=>x.id);w.replaceWith(n);on.forEach(id=>{const x=document.getElementById(id);if(x)x.checked=true});
n.querySelectorAll("details").forEach((x,i)=>{if(open[i])x.open=true});document.title=d.title;document.dispatchEvent(new Event("hush:swap"))}catch(e){w.dataset.loading="";w.dataset.failed="1"}finally{busy=0}};
window.hushPull=pull;if(document.body.dataset.stale)pull();setInterval(()=>{if(!document.hidden)pull()},120e3);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)pull()})})()</script>`;
// The "Actions" panel: polls /r/<repo>/live every 8 s while something runs, 30 s otherwise,
// ticks the elapsed timers every second, and re-renders into the new .wrap after a swap.
const ACTIONS = `<script>(()=>{const boxes=()=>document.querySelectorAll(".ci-live");if(!boxes().length)return;
const u=location.pathname.replace(/[/]$/,"")+"/live";let data=null,prev=new Set(),timer;
const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const I={
success:'<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--ok)"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
failure:'<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--bad)"/><path d="M5.5 5.5l5 5m0-5l-5 5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
neutral:'<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--faint)" stroke-width="1.6"/><path d="M4.5 11.5l7-7" stroke="var(--faint)" stroke-width="1.6" stroke-linecap="round"/></svg>',
running:'<svg class="gi spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--warn)" stroke-opacity=".25" stroke-width="2.2"/><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="var(--warn)" stroke-width="2.2" stroke-linecap="round"/></svg>',
queued:'<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--warn)" stroke-width="1.6" stroke-dasharray="2.4 2.2"/><circle class="pulse" cx="8" cy="8" r="2.6" fill="var(--warn)"/></svg>'};
const icon=(st,c)=>st==="completed"?(c==="success"?I.success:["failure","timed_out","startup_failure","action_required"].includes(c)?I.failure:I.neutral):st==="in_progress"?I.running:I.queued;
const dur=ms=>{ms=Math.max(0,ms);const s=Math.floor(ms/1e3),m=Math.floor(s/60),h=Math.floor(m/60);return h?h+"h "+(m%60)+"m":m?m+"m "+String(s%60).padStart(2,"0")+"s":s+"s"};
const ago=t=>{const m=Math.round((Date.now()-new Date(t))/6e4);return m<1?"just now":m<60?m+" min ago":m<1440?Math.round(m/60)+" h ago":Math.round(m/1440)+" d ago"};
const verb=r=>r.status==="in_progress"?"Running":r.status==="queued"?"Queued":r.status==="waiting"?"Waiting for approval":r.status==="requested"||r.status==="pending"?"Starting":"In progress";
function render(){if(!data)return;boxes().forEach(b=>draw(b,b.dataset.compact==="1"));prev=new Set(data.active.map(r=>r.id))}
function draw(b,compact){const a=data.active;
const done=data.recent.filter(r=>prev.has(r.id)).map(r=>r.id);
let h='<div class="live-head"><h2>Actions</h2><span class="live-dot" data-on="'+(a.length?1:0)+'"></span><span class="live-meta">'+(a.length?a.length+" running":"Nothing running")+' · checked <span data-ago="'+e(data.at)+'">'+ago(data.at)+'</span></span></div>';
if(!data.ok)h+='<div class="group"><div class="line"><span class="hint">Could not read Actions for this repo.</span></div></div>';
if(a.length){h+='<div class="group run-group">'+a.map(r=>{const jobs=r.jobs.map(j=>{const pct=j.steps?Math.round(j.done/j.steps*100):0;
return '<li class="job" data-st="'+e(j.status)+'">'+icon(j.status,j.conclusion)+'<span class="job-name">'+e(j.name)+'</span><span class="job-step">'+(j.status==="in_progress"&&j.step?e(j.step)+' <span class="faint">'+j.done+"/"+j.steps+"</span>":j.status==="completed"?"":"waiting")+'</span><span class="job-time" '+(j.status==="in_progress"&&j.started?'data-since="'+e(j.started)+'"':"")+'>'+(j.started?dur((j.completed?new Date(j.completed):Date.now())-new Date(j.started)):"")+'</span>'+(j.status==="in_progress"?'<span class="job-bar"><i style="width:'+pct+'%"></i></span>':"")+'</li>'}).join("");
return '<div class="run" data-st="'+e(r.status)+'"><a class="run-head" href="'+e(r.url)+'" target="_blank" rel="noopener">'+icon(r.status,r.conclusion)+'<span class="run-main"><span class="run-title">'+e(r.title||r.name)+'</span><span class="run-sub"><b>'+e(r.name)+'</b> #'+r.number+' · '+e(r.event)+(r.actor?" by "+e(r.actor):"")+'</span></span><span class="run-side"><code class="branch">'+e(r.branch)+'</code><span class="run-time"><span class="faint">'+verb(r)+'</span> <span data-since="'+e(r.started)+'">'+dur(Date.now()-new Date(r.started))+'</span></span></span></a>'+(jobs?'<ul class="jobs">'+jobs+'</ul>':"")+'</div>'}).join("")+'</div>'}
if(data.recent.length&&!compact)h+='<div class="recent-label">Recently finished</div><div class="group recent">'+data.recent.map(r=>'<a class="line rrow'+(done.includes(r.id)?" just":"")+'" href="'+e(r.url)+'" target="_blank" rel="noopener"><span class="name">'+icon(r.status,r.conclusion)+'<span>'+e(r.name)+' <span class="faint">#'+r.number+'</span><span class="sub">'+e(r.title)+'</span></span></span><span class="meta"><code class="branch">'+e(r.branch)+'</code><span class="sub">'+dur(new Date(r.updated)-new Date(r.started))+' · '+ago(r.updated)+'</span></span></a>').join("")+'</div>';
b.innerHTML=h}
async function poll(){clearTimeout(timer);if(!document.hidden){try{const r=await fetch(u,{credentials:"same-origin"});if(r.ok){const d=await r.json();const finished=data&&data.active.some(x=>!d.active.some(y=>y.id===x.id));data=d;render();if(d.beats&&document.getElementById("onboard")&&window.hushPull)window.hushPull();else if(finished&&window.hushPull)setTimeout(window.hushPull,1500)}}catch(e){}}
timer=setTimeout(poll,data&&data.active.length||document.getElementById("onboard")?8e3:3e4)}
setInterval(()=>{document.querySelectorAll(".ci-live [data-since]").forEach(x=>x.textContent=dur(Date.now()-new Date(x.dataset.since)));document.querySelectorAll(".ci-live [data-ago]").forEach(x=>x.textContent=ago(x.dataset.ago))},1e3);
document.addEventListener("hush:swap",render);document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll()});poll()})()</script>`;
const VIEWS = ["overview", "assistant", "monitors", "automations", "ci", "prs", "issues", "costs", "setup"];
const VIEW_HEAD = `<script>(()=>{const v=location.hash.slice(1);document.documentElement.dataset.view=${JSON.stringify(VIEWS)}.includes(v)?v:"overview"})()</script>`;
const VIEW_CSS = `.view{display:none}` + VIEWS.map((v) => `html[data-view=${v}] .view[data-view=${v}]{display:block}html[data-view=${v}] [data-nav=${v}]{color:var(--accent);font-weight:700;box-shadow:inset 3px 0 var(--accent)}`).join("");
const VIEW_JS = `<script>(()=>{const V=${JSON.stringify(VIEWS)};const set=()=>{const v=location.hash.slice(1);document.documentElement.dataset.view=V.includes(v)?v:"overview"};
addEventListener("hashchange",()=>{set();scrollTo(0,0)});document.addEventListener("hush:swap",set)})()</script>`;
const ASK_MODEL = process.env.HUSH_MODEL || "openai/gpt-6.1-sol";
const ASK_JS = `<script>(()=>{const S=window.hushChat||(window.hushChat={msgs:[],busy:false,draft:""});
const e=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const md=t=>e(t).replace(/\x60\x60\x60([\\s\\S]*?)\x60\x60\x60/g,(m,c)=>"<pre>"+c.replace(/^\\w*\\n/,"")+"</pre>").replace(/\x60([^\x60\\n]+)\x60/g,"<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g,"<b>$1</b>").replace(/^#{1,4} (.+)$/gm,"<b>$1</b>").replace(/^[-*] (.+)$/gm,"<li>$1</li>").replace(/(<li>.*<\\/li>\\n?)+/g,m=>"<ul>"+m.replace(/\\n/g,"")+"</ul>").replace(/\\n{2,}/g,"<br><br>").replace(/\\n/g,"<br>");
function draw(){const log=document.getElementById("chat-log");if(!log)return;
log.innerHTML=S.msgs.length?S.msgs.map(m=>'<div class="msg '+m.role+(m.err?" err":"")+'">'+(m.role==="user"?e(m.content):md(m.content)||'<span class="typing"><i></i><i></i><i></i></span>')+"</div>").join(""):'<div class="chat-empty">Ask about monitors, routines, CI, pull requests, issues or costs.</div>';
log.scrollTop=log.scrollHeight;const inp=document.getElementById("ask-input");if(inp&&!inp.value&&S.draft)inp.value=S.draft;
document.querySelectorAll("#chat .chip").forEach(c=>c.hidden=S.msgs.length>0);const b=document.querySelector("#ask-form button");if(b)b.disabled=S.busy}
async function ask(q){if(S.busy||!q.trim())return;S.busy=true;S.draft="";S.msgs.push({role:"user",content:q.trim()});const a={role:"assistant",content:""};S.msgs.push(a);draw();
try{const r=await fetch(location.pathname.replace(/[/]$/,"")+"/ask",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({messages:S.msgs.filter(m=>m!==a&&!m.err).map(({role,content})=>({role,content}))})});
if(!r.ok||!r.body){a.content=(await r.text())||"The assistant did not answer.";a.err=true}else{const rd=r.body.getReader(),dec=new TextDecoder();for(;;){const {done,value}=await rd.read();if(done)break;a.content+=dec.decode(value,{stream:true});draw()}}
}catch(x){a.content="Could not reach the assistant.";a.err=true}S.busy=false;draw()}
document.addEventListener("submit",ev=>{if(ev.target.id!=="ask-form")return;ev.preventDefault();const i=document.getElementById("ask-input");const q=i.value;i.value="";ask(q)});
document.addEventListener("keydown",ev=>{if(ev.target.id==="ask-input"&&ev.key==="Enter"&&!ev.shiftKey){ev.preventDefault();ev.target.form.requestSubmit()}});
document.addEventListener("input",ev=>{if(ev.target.id==="ask-input")S.draft=ev.target.value});
document.addEventListener("click",ev=>{const c=ev.target.closest&&ev.target.closest(".chip");if(c){location.hash="assistant";ask(c.dataset.q)}});
document.addEventListener("hush:swap",draw);draw()})()</script>`;
// Floating windows, after the admin's PanelHost (docs/admin/crud-panel.md → Windows): one click on
// an entity opens its own window; the same entity never opens twice (it comes to the front);
// windows are dragged by the title bar, resized from any edge (min 380×280), cascade 28 px from
// the right, take focus on pointer-down, minimize to a dock, never zoom, never dim the page.
// They live on <body>, outside the page, so section changes and background refreshes keep them;
// their contents come from the page's <template>s and are refreshed with it. The open set is in
// the URL (?w=), so a link reopens them. On a phone each window is a full-screen sheet.
const WIN_JS = `<script>(()=>{const W=window.hushWin||(window.hushWin={list:[],frames:{}});
const MINW=380,MINH=280,STEP=28,TOP=52;
const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const tpl=k=>[...document.querySelectorAll("#win-tpl template")].find(t=>t.dataset.key===k);
const phone=()=>matchMedia("(max-width:820px)").matches;
const ICON={min:'<svg viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>',close:'<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',gh:'<svg viewBox="0 0 16 16"><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4"/></svg>'};
function dockEl(){let d=document.getElementById("win-dock");if(!d){d=document.createElement("div");d.id="win-dock";d.className="win-dock";document.body.appendChild(d)}return d}
function syncUrl(){const u=new URL(location.href);const ks=W.list.map(w=>w.key);ks.length?u.searchParams.set("w",ks.join(",")):u.searchParams.delete("w");if(u.href!==location.href)history.replaceState(history.state,"",u)}
function order(){const vis=W.list.filter(w=>!w.min);vis.forEach((w,i)=>{w.el.style.zIndex=50+Math.min(i,140);w.el.classList.toggle("active",i===vis.length-1)})}
function renderDock(){const d=dockEl();const mins=W.list.filter(w=>w.min);d.innerHTML=mins.map(w=>'<button type="button" class="win-chip" data-key="'+esc(w.key)+'"><span>'+esc(w.kind)+'</span> '+esc(w.title)+"</button>").join("");d.hidden=!mins.length}
function clamp(f){const vw=innerWidth,vh=innerHeight;f.w=Math.max(MINW,Math.min(f.w,vw-16));f.h=Math.max(MINH,Math.min(f.h,vh-TOP-8));f.x=Math.max(8-f.w+120,Math.min(f.x,vw-120));f.y=Math.max(TOP-6,Math.min(f.y,vh-40));return f}
function place(w){if(phone()){w.el.removeAttribute("style");order();return}const f=clamp(W.frames[w.key]);Object.assign(w.el.style,{left:f.x+"px",top:f.y+"px",width:f.w+"px",height:f.h+"px"});order()}
function fill(w){const t=tpl(w.key),b=w.el.querySelector(".win-body");if(t){const st=b.scrollTop;b.replaceChildren(t.content.cloneNode(true));b.scrollTop=st;w.el.classList.remove("gone");w.title=t.dataset.title;w.el.querySelector(".win-title").textContent=t.dataset.title}else w.el.classList.add("gone")}
function focus(w){W.list.splice(W.list.indexOf(w),1);W.list.push(w);if(w.min){w.min=false;w.el.hidden=false;renderDock()}order()}
function close(w){w.el.remove();W.list.splice(W.list.indexOf(w),1);order();renderDock();syncUrl()}
function open(key,quiet){const had=W.list.find(w=>w.key===key);if(had){focus(had);return true}const t=tpl(key);if(!t)return false;
const n=W.list.filter(w=>!w.min).length,vw=innerWidth,vh=innerHeight,ww=Math.min(620,Math.max(MINW,vw*.42));
W.frames[key]=W.frames[key]||{w:ww,h:vh-TOP-24-n*STEP,x:vw-ww-20-n*STEP,y:TOP+8+n*STEP};
const el=document.createElement("section");el.className="win";el.setAttribute("role","dialog");el.setAttribute("aria-label",t.dataset.kind+" "+t.dataset.title);
el.innerHTML='<header class="win-bar"><span class="win-kind">'+esc(t.dataset.kind)+'</span><b class="win-title"></b><span class="win-acts">'+(t.dataset.href?'<a class="win-btn" data-no-drag href="'+esc(t.dataset.href)+'" target="_blank" rel="noopener" title="Open on GitHub">'+ICON.gh+"</a>":"")+'<button type="button" class="win-btn" data-act="min" title="Minimize">'+ICON.min+'</button><button type="button" class="win-btn" data-act="close" title="Close">'+ICON.close+'</button></span></header><div class="win-body"></div><div class="win-gone">No longer in this page\\'s data.</div>'+["n","s","e","w","ne","nw","se","sw"].map(d=>'<i class="win-rz" data-dir="'+d+'"></i>').join("");
document.body.appendChild(el);const w={key,el,kind:t.dataset.kind,title:t.dataset.title,min:false};W.list.push(w);fill(w);place(w);if(!quiet)syncUrl();
el.addEventListener("pointerdown",()=>focus(w),true);
el.querySelector('[data-act="close"]').onclick=()=>close(w);
el.querySelector('[data-act="min"]').onclick=()=>{w.min=true;el.hidden=true;order();renderDock()};
const bar=el.querySelector(".win-bar");
bar.addEventListener("pointerdown",ev=>{if(phone()||ev.button!==0||ev.target.closest("button,a,input,textarea,select,[data-no-drag]"))return;ev.preventDefault();const f=W.frames[key],sx=ev.clientX-f.x,sy=ev.clientY-f.y;bar.setPointerCapture(ev.pointerId);el.classList.add("moving");
const mv=e=>{f.x=e.clientX-sx;f.y=e.clientY-sy;place(w)};const up=()=>{bar.removeEventListener("pointermove",mv);bar.removeEventListener("pointerup",up);el.classList.remove("moving")};bar.addEventListener("pointermove",mv);bar.addEventListener("pointerup",up)});
el.querySelectorAll(".win-rz").forEach(h=>h.addEventListener("pointerdown",ev=>{if(phone())return;ev.preventDefault();ev.stopPropagation();const f=W.frames[key],o={...f,cx:ev.clientX,cy:ev.clientY},d=h.dataset.dir;h.setPointerCapture(ev.pointerId);el.classList.add("moving");
const mv=e=>{const dx=e.clientX-o.cx,dy=e.clientY-o.cy;if(d.includes("e"))f.w=Math.max(MINW,o.w+dx);if(d.includes("s"))f.h=Math.max(MINH,o.h+dy);if(d.includes("w")){const nw=Math.max(MINW,o.w-dx);f.x=o.x+(o.w-nw);f.w=nw}if(d.includes("n")){const nh=Math.max(MINH,o.h-dy);f.y=o.y+(o.h-nh);f.h=nh}place(w)};
const up=()=>{h.removeEventListener("pointermove",mv);h.removeEventListener("pointerup",up);el.classList.remove("moving")};h.addEventListener("pointermove",mv);h.addEventListener("pointerup",up)}));
return true}
document.addEventListener("click",ev=>{const chip=ev.target.closest(".win-chip");if(chip){const w=W.list.find(x=>x.key===chip.dataset.key);if(w)focus(w);return}
const o=ev.target.closest("[data-open]");if(!o||ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;
const inner=ev.target.closest("a,button");if(inner&&inner!==o&&!inner.hasAttribute("data-open"))return;if(open(o.dataset.open))ev.preventDefault()});
document.addEventListener("keydown",ev=>{if((ev.key==="Enter"||ev.key===" ")&&ev.target.matches&&ev.target.matches("[data-open][tabindex]")){ev.preventDefault();open(ev.target.dataset.open)}
if(ev.key==="Escape"&&!ev.target.closest("input,textarea")){const top=W.list.filter(w=>!w.min).at(-1);if(top)close(top)}});
document.addEventListener("hush:swap",()=>W.list.forEach(fill));addEventListener("resize",()=>W.list.forEach(place));
if(!W.started){W.started=true;(new URL(location.href).searchParams.get("w")||"").split(",").filter(Boolean).forEach(k=>open(k,true));syncUrl()}})()</script>`;
const page = (title, body, { live, stale, app } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${ICON}${FONTS}${app ? VIEW_HEAD : ""}<style>${CSS}${app ? VIEW_CSS : ""}${THEME}</style></head><body${stale ? ' data-stale="1"' : ""}><div class="wrap${app ? " app-wrap" : ""}">${body}</div>${live ? LIVE : ""}${live && body.includes('class="ci-live"') ? ACTIONS : ""}${app ? VIEW_JS : ""}${body.includes('id="chat"') ? ASK_JS : ""}${body.includes('id="win-tpl"') ? WIN_JS : ""}</body></html>`;

// What the repo page looks like while its first snapshot is being read from GitHub.
function skeletonPage(repo) {
  const bars = `<div class="bars">${'<i class="sk"></i>'.repeat(WINDOW)}</div>`;
  const row = (w) => `<div class="row"><div class="row-head"><span class="sk sk-t" style="width:${w}px"></span><span class="sk sk-t" style="width:84px"></span></div>${bars}<div class="axis"><span class="sk sk-t" style="width:100%;height:8px"></span></div></div>`;
  const stat = `<div class="stat"><span class="sk sk-t" style="width:56px;height:26px"></span><span class="sk sk-t" style="width:110px;margin-top:10px"></span><span class="sk sk-t" style="width:90px;margin-top:8px;height:8px"></span></div>`;
  return page(`${repo} · hush`, `
    <header class="top">${LOGO}<span class="updated">${esc(repo)} · reading GitHub…</span></header>
    <div class="banner sk-banner"><span class="sk sk-t" style="width:200px;background:rgba(255,255,255,.55)"></span></div>
    <p class="banner-sub"><span class="sk sk-t" style="width:62%"></span></p>
    <h2>Last ${WINDOW} days</h2>
    <div class="group stats">${stat.repeat(4)}</div>
    <h2>Monitors</h2>
    <div class="group grid2">${[120, 90, 140, 100].map(row).join("")}</div>
    <h2>Routines</h2>
    <div class="group">${row(110)}${row(80)}</div>
    <p class="sk-note" role="status">The first read of a repo takes a few seconds. After that it opens instantly.</p>
  `, { live: true, stale: true, app: true });
}

const STATE = { alive: ["ok", "Operational"], warn: ["warn", "Degraded"], degraded: ["bad", "Chronically degraded"], lying: ["bad", "Said ok, read nothing"], dead: ["bad", "Down"], retired: ["none", "Retired"] };

// Onboarding for a repo: the app is installed (or the user could not see this page), so what is
// left is the heartbeat. Shown at the top of the repo page until the first heartbeat arrives,
// and at /r/<repo>/setup after that.
const COPY = `<button class="copy" type="button" onclick="navigator.clipboard.writeText(this.parentNode.querySelector('pre').textContent).then(()=>{this.textContent='Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>`;
function heartbeatSetup(origin, key, waiting, st = null) {
  const DONE = `<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--ok)"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const n = (i) => `<span class="ob-n">${i}</span>`;
  // A finished step shows what is in place and keeps its instructions folded away.
  const step = (i, done, title, optional, summary, body) =>
    done
      ? `<li class="done">${DONE}<div><b>${title}</b><span>${summary}</span><details class="more"><summary>Show how</summary>${body}</details></div></li>`
      : `<li>${n(i)}<div><b>${title}</b>${optional ? " <small>optional</small>" : ""}${body}</div></li>`;
  const installed = !!(st?.hush_sh && st?.hook);
  const beats = (st?.skill_beats || 0) > 0;
  const providers = (st?.cost_sources || []).filter((x) => x !== "claude-code");
  const costsOn = providers.length > 0 || (st?.sessions || 0) > 0;
  return `<ol class="ob">
    <li class="done">${DONE}<div><b>Hush can read this repo</b><span>The GitHub App is installed. Monitors, routines, CI and the queue come from it.</span></div></li>
    ${step(2, installed, "Install the heartbeat", false, `<code>.claude/hooks/hush.sh</code> and the SessionEnd hook are in the repo. Every cloud routine reports itself when it ends.`, `<span>At the repo root, then commit <code>.claude/</code> and push.</span>
      <div class="cmd"><pre>curl -fsSL ${esc(origin)}/install.sh | sh -s -- ${esc(key)}</pre>${COPY}</div>
      <span>It adds a SessionEnd hook, so every Claude Code routine that runs a slash command reports itself when it ends. No change to your skills.</span>${st && st.hush_sh && !st.hook ? `<span class="err">Found <code>hush.sh</code> but not the SessionEnd hook in <code>.claude/settings.json</code>. Run the installer again.</span>` : ""}`)}
    ${step(3, beats, "Say how each run went", true, `${st?.skill_beats} monitor${st?.skill_beats === 1 ? "" : "s"} send their own status and volume.`, `<span>A skill ends with this to send its status and how much it read. A monitor that says ok after reading nothing gets flagged.</span>
      <div class="cmd"><pre>.claude/hooks/hush.sh beat errors ok '{"swept":{"events":120}}'</pre>${COPY}</div>
      <details class="more"><summary>Declare your monitors and routines, or post from somewhere else</summary>
      <span>In <code>.claude/factory.json</code>. Routines show their next run and get marked late when they miss one.</span>
<pre>{
  "monitors": [
    { "id": "errors", "cadence": "daily", "max_silence_hours": 50, "volume_key": "events", "routine": "Monitors" }
  ],
  "routines": [
    { "name": "Monitors", "cron": "0 13 * * *", "prompt": "/monitor", "model": "sonnet" }
  ]
}</pre>
      <span>From a script, a Lambda or another CI, the raw call. <code>status</code> is ok, degraded or skipped.</span>
<pre>curl -sS -X POST ${esc(origin)}/api/heartbeat \\
  -H "authorization: Bearer ${esc(key)}" \\
  -H "content-type: application/json" \\
  -d '{"monitor":"errors","status":"ok","swept":{"events":41233}}'</pre></details>`)}
    ${step(4, costsOn, "Report costs", true, [providers.length ? `Spend from ${providers.map((x) => ({ aws: "AWS", vercel: "Vercel", neon: "Neon", anthropic: "Anthropic API", fly: "Fly", cloudflare: "Cloudflare" }[x] || esc(x))).join(", ")}.` : "", st?.sessions ? `Tokens from ${st.sessions} Claude Code session${st.sessions === 1 ? "" : "s"}.` : installed ? "Claude Code tokens arrive with the next cloud session." : ""].filter(Boolean).join(" "), `<span>Claude Code tokens arrive on their own: the same hook counts each cloud session's tokens by model.${st?.hush_sh && !st.cost_cmd ? " Your <code>hush.sh</code> predates this: run the installer again to update it." : ""} For provider spend, the job that already reads your bill ends with one line per day:</span>
      <div class="cmd"><pre>.claude/hooks/hush.sh cost aws 31.50 '{"day":"2026-10-10","breakdown":{"ECS":20,"S3":0.4}}'</pre>${COPY}</div>
      <span>Any provider works (<code>aws</code>, <code>vercel</code>, <code>neon</code>, <code>anthropic</code>…). Sending the same day again replaces it, so resend the last 3 days as charges settle. Hush never asks for billing credentials.</span>`)}
    ${waiting ? `<li class="wait"><span class="live-dot" data-on="1"></span><div><b>Waiting for the first heartbeat</b><span>This page updates on its own when it arrives. Try it now: <code>.claude/hooks/hush.sh beat install-test ok</code></span></div></li>` : ""}
  </ol>`;
}

function heartbeatPage(origin, repoRow) {
  return page(`Heartbeat setup · ${repoRow.full_name}`, `
    <header class="top">${LOGO}<a class="updated" href="/r/${esc(repoRow.full_name)}">← ${esc(repoRow.full_name)}</a></header>
    <section class="onboard"><h2>Heartbeat setup</h2>${heartbeatSetup(origin, repoRow.ingest_key, false)}</section>`);
}

function statusPage(s, user, origin, repoRow, { stale = false } = {}) {
  const repoUrl = s.meta.url;
  const banner = s.overall === "ok" ? "All systems operational" : s.overall === "degraded" ? "Degraded performance" : "Monitors need attention";
  const monRows = s.monitors.map((m) => {
    const [ps, label] = STATE[m.state] || ["none", m.state];
    const ran = m.buckets.filter((b) => b.s).length;
    const pct = ran ? Math.round((m.buckets.filter((b) => b.s === "ok").length / ran) * 1000) / 10 : 0;
    const bars = m.buckets.map((b) => `<i data-s="${b.s}" title="${b.label} · ${b.s || "no run"}"></i>`).join("");
    const swept = m.last?.swept ? Object.entries(m.last.swept).map(([k, v]) => `${esc(k)} <code>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</code>`).join(" · ") : "";
    const filed = m.filed.map((x) => `<a href="${repoUrl}/issues/${x}" target="_blank" rel="noopener">#${x}</a>`).join(" ");
    return `<div class="row openable" data-open="monitor:${esc(m.id)}" role="button" tabindex="0">
      <div class="row-head"><span class="name"><span class="mon-id">${esc(m.id)}</span><small>${m.cadence === "weekly" ? "weekly" : "daily"}${m.unlisted ? " · not in roster" : ""}</small></span><span class="state" data-s="${ps}">${label}</span></div>
      <div class="bars">${bars}</div>
      <div class="axis"><span>${m.span}</span><span class="rule"></span><span>${pct}% ok</span><span class="rule"></span><span>today</span></div>
    </div>`;
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
    return `<div class="line openable" data-open="routine:${esc(encodeURIComponent(r.name))}" role="button" tabindex="0"><span class="name">${esc(r.name.replace(/^App: /, ""))}<span class="sub">${esc(r.source)} · ${esc(r.prompt)} · ${esc(when(r))}${r.model ? " · " + esc(r.model) : ""}</span></span><span class="meta"><span class="state" data-s="${st}">${label}</span><span class="sub">next ${until(r.next_run)}</span></span></div>`;
  }).join("");

  const ci = (s.ci || []).map((w) => {
    const lastS = !w.last ? ["none", "No runs"] : w.last.status !== "completed" ? ["warn", "Running"] : w.last.conclusion === "success" ? ["ok", "Passing"] : w.last.conclusion === "failure" ? ["bad", "Failing"] : ["none", w.last.conclusion];
    const bars = w.days.map((d, i) => { const t = w.tips[i]; return `<i data-s="${d}" title="${new Date(Date.now() - (w.days.length - 1 - i) * 864e5).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })} · ${t.ok + t.bad ? `${t.ok} passed, ${t.bad} failed` : "no runs"}"></i>`; }).join("");
    return `<div class="row openable" data-open="workflow:${esc(encodeURIComponent(w.path))}" role="button" tabindex="0">
      <div class="row-head"><span class="name">${esc(w.name)}<small>${w.runs}${w.capped ? "+" : ""} runs</small></span><span class="state" data-s="${lastS[0]}">${lastS[1]}</span></div>
      <div class="bars">${bars}</div>
      <div class="axis"><span>${WINDOW} days ago</span><span class="rule"></span><span>${w.pct == null ? "no runs" : `${w.pct}% passing`}</span><span class="rule"></span><span>today</span></div>
    </div>`;
  }).join("");

  const PR_ICON = {
    open: `<svg class="gi" viewBox="0 0 16 16" aria-hidden="true"><path fill="#1a7f37" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`,
    draft: `<svg class="gi" viewBox="0 0 16 16" aria-hidden="true"><path fill="#9a9ea5" d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/></svg>`,
    merged: `<svg class="gi" viewBox="0 0 16 16" aria-hidden="true"><path fill="#8250df" d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>`,
    closed: `<svg class="gi" viewBox="0 0 16 16" aria-hidden="true"><path fill="#cf222e" d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`,
  };
  const prLine = (p, kind, when, right = "") => `<a class="line pr" href="${esc(p.url)}" target="_blank" rel="noopener" data-open="pr:${p.number}"><span class="name">${PR_ICON[kind]}<span><span class="pr-title">${esc(p.title)}</span><span class="sub">#${p.number}${p.author ? ` · ${esc(p.author)}` : ""} · ${when}</span></span></span><span class="meta"><code class="branch">${esc(p.branch)}</code>${AGENT_BRANCH.test(p.branch || "") ? `<span class="agent-tag">agent</span>` : ""}${right}</span></a>`;
  const ciTag = (p) => `<span class="state" data-s="${p.ci === "green" ? "ok" : p.ci === "red" ? "bad" : p.ci === "running" ? "warn" : "none"}"${p.ci === "running" ? " data-run" : ""}>${{ green: "Passing", red: "Failing", running: "Running", none: "No CI" }[p.ci]}</span>`;
  const C = s.costs;
  const SRC_COLOR = ["#14161c", "#5b6cff", "#2fb36b", "#f0a92c", "#e5484d", "#8250df", "#0ea5b7", "#9a9ea5"];
  const srcColor = (k) => (k === "claude-code" ? "#d97757" : SRC_COLOR[(C?.sources || []).filter((x) => x !== "claude-code").indexOf(k) % SRC_COLOR.length]);
  const srcName = (k) => ({ aws: "AWS", vercel: "Vercel", neon: "Neon", anthropic: "Anthropic API", "claude-code": "Claude Code", openai: "OpenAI", fly: "Fly", cloudflare: "Cloudflare", supabase: "Supabase" }[k] || k);
  const usd = (n) => (n == null ? "–" : n >= 1000 ? "$" + Math.round(n).toLocaleString("en-US") : "$" + n.toFixed(n < 10 ? 2 : 0));
  const tk = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n || 0));
  const maxCost = C ? Math.max(1e-9, ...C.per_day.map((p) => p.total)) : 1;
  const costs = !C ? "" : `
    <div class="group stats">
      <div class="stat"><b>${usd(C.total_usd)}</b><span>Spent in ${WINDOW} days</span><small>${C.sources.map((k) => `${srcName(k)} ${usd(C.total[k])}`).join(" · ")}</small></div>
      <div class="stat"><b>${usd(C.yesterday)}</b><span>Yesterday</span><small>${usd(C.avg7)} a day over the last 7</small></div>
      <div class="stat"><b>${tk(C.tokens_30d)}</b><span>Claude Code tokens</span><small>${C.sessions_30d} cloud session${C.sessions_30d === 1 ? "" : "s"} in ${WINDOW} days</small></div>
      <div class="stat"><b>${C.sessions_30d ? tk(C.tokens_30d / C.sessions_30d) : "–"}</b><span>Tokens per session</span><small>average</small></div>
      <div class="chart" aria-label="Spend per day">
        <div class="cols">${C.per_day.map((p) => `<div title="${p.d} · ${usd(p.total)}${Object.keys(p.by).length ? " · " + Object.entries(p.by).map(([k, v]) => `${srcName(k)} ${usd(v)}`).join(", ") : ""}${p.tokens ? ` · ${tk(p.tokens)} tokens` : ""}"><i class="stack" style="height:${(p.total / maxCost) * 100}%">${C.sources.filter((k) => p.by[k]).map((k) => `<em style="flex:${p.by[k]};background:${srcColor(k)}"></em>`).join("")}</i></div>`).join("")}</div>
        <div class="axis"><span>Spend per day</span><span class="rule"></span>${C.sources.map((k) => `<span><span class="key" style="background:${srcColor(k)}"></span> ${srcName(k)}</span>`).join("")}</div>
      </div>
    </div>
    ${C.sessions.length ? `<h2>Last ${C.sessions.length === 1 ? "Claude Code session" : `${C.sessions.length} Claude Code sessions`}</h2><div><div class="group" style="margin-bottom:0">${C.sessions.map((x) => `<div class="line"><span class="name"><code>/${esc(x.name)}</code><span class="sub">${ago(x.at)} · ${esc(x.models.join(", "))}${x.turns ? ` · ${x.turns} turns` : ""}</span></span><span class="meta"><b>${tk(x.tokens.total)}</b> tokens <span class="sub">${tk(x.tokens.input + x.tokens.cache_write)} in · ${tk(x.tokens.cache_read)} cached · ${tk(x.tokens.output)} out${x.usd != null ? ` · ~${usd(x.usd)}` : ""}</span></span></div>`).join("")}</div><div class="cost-note">Dollars are estimated at API list prices. On a Claude subscription they show what the same tokens would cost, not what you pay. A model with no known price shows tokens only; set it under <code>prices</code> in <code>.claude/factory.json</code>.</div></div>` : ""}`;
  const prTabs = [
    ["open", "Open", s.queue.prs.map((p) => prLine(p, p.draft ? "draft" : "open", `opened ${ago(p.created_at)}${p.draft ? " · draft" : ""}`, ciTag(p)))],
    ["merged", "Merged", (s.queue.merged || []).slice(0, 15).map((p) => prLine(p, "merged", `merged ${ago(p.merged_at)}`))],
    ["closed", "Closed", (s.queue.closed || []).slice(0, 15).map((p) => prLine(p, "closed", `closed ${ago(p.closed_at)}`))],
  ];
  const prSection = `<div class="tabs">${prTabs.map(([k, label, rows], i) => `<input type="radio" name="prtab" id="prtab-${k}"${i === 0 ? " checked" : ""}><label for="prtab-${k}">${PR_ICON[k]}${label} <span class="count">${k === "open" ? rows.length : rows.length + (rows.length === 15 ? "+" : "")}</span></label>`).join("")}
    ${prTabs.map(([k, , rows]) => `<div class="group tab-panel" data-tab="${k}">${rows.join("") || `<div class="line"><span class="hint">No ${k} pull requests${k === "open" ? "" : " recently"}.</span></div>`}</div>`).join("")}</div>`;
  // --- window contents: one <template> per entity; the window manager clones them -----------
  const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v !== "" && v != null).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const when2 = (ts) => (ts ? `${ago(ts)} <span class="faint">${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC</span>` : "never");
  const statePill = (st, label) => `<span class="pill" data-s="${st}">${label}</span>`;
  const isLate = (r) => r.last_seen && (Date.now() - new Date(r.last_seen)) / 36e5 > r.period_h * 1.25 + 2;
  const wins = [];
  for (const m of s.monitors) {
    const [ps, label] = STATE[m.state] || ["none", m.state];
    const bars = m.buckets.map((b) => `<i data-s="${b.s}" title="${b.label} · ${b.s || "no run"}"></i>`).join("");
    const swept = (x) => Object.entries(x || {}).map(([k, v]) => `${esc(k)} <code>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</code>`).join(" · ");
    const routine = s.routines.find((r) => r.name === m.routine);
    wins.push({ key: `monitor:${m.id}`, kind: "Monitor", title: m.id, body: `
      <div class="w-head">${statePill(ps, label)}${m.why ? `<span class="w-why">${esc(m.why)}</span>` : ""}</div>
      <div class="bars tall">${bars}</div><div class="axis"><span>${m.span}</span><span class="rule"></span><span>today</span></div>
      ${kv([["Cadence", m.cadence], ["Runs", `${m.runs} in the window`], ["Routine", routine ? `<a href="#" data-open="routine:${esc(encodeURIComponent(routine.name))}">${esc(routine.name.replace(/^App: /, ""))}</a>` : m.routine ? esc(m.routine) : ""], ["Last heartbeat", when2(m.last?.ts)], ["Read", swept(m.last?.swept)], ["Filed", m.filed.map((x) => `<a href="${repoUrl}/issues/${x}" target="_blank" rel="noopener">#${x}</a>`).join(" ") || `nothing in ${WINDOW} days`]])}
      ${m.last?.note ? `<p class="w-note">${esc(m.last.note)}</p>` : ""}
      ${m.history?.length ? `<h4>Last ${m.history.length} heartbeats</h4><div class="w-list">${m.history.map((b) => `<div><span class="pill sm" data-s="${b.status === "ok" ? "ok" : b.status === "degraded" ? "warn" : "bad"}">${b.status}</span><span class="faint">${ago(b.ts)}${b.source === "session" ? " · session" : ""}</span><span>${swept(b.swept)}${b.note ? ` <span class="faint">${esc(b.note)}</span>` : ""}</span></div>`).join("")}</div>` : ""}` });
  }
  for (const r of s.routines) {
    const late = isLate(r);
    const [st, label] = !r.last_seen ? ["none", "No evidence"] : late ? ["bad", "Late"] : ["ok", "On schedule"];
    const fed = s.monitors.filter((m) => m.routine === r.name);
    wins.push({ key: `routine:${encodeURIComponent(r.name)}`, kind: r.source === "GitHub Actions" ? "Scheduled workflow" : "Routine", title: r.name.replace(/^App: /, ""), body: `
      <div class="w-head">${statePill(st, label)}</div>
      ${kv([["Runs", esc(r.prompt)], ["Schedule", `${esc(when(r))} <code>${esc(r.cron)}</code>`], ["Next run", r.next_run ? `${until(r.next_run)} <span class="faint">${new Date(r.next_run).toISOString().slice(0, 16).replace("T", " ")} UTC</span>` : ""], ["Last run", when2(r.last_seen)], ["Evidence", esc(r.evidence || "none")], ["Model", esc(r.model || "")], ["Source", esc(r.source)]])}
      ${fed.length ? `<h4>Monitors it runs</h4><div class="w-list">${fed.map((m) => { const [ps, l] = STATE[m.state] || ["none", m.state]; return `<div class="openable" data-open="monitor:${esc(m.id)}" role="button" tabindex="0"><code>${esc(m.id)}</code><span class="state" data-s="${ps}">${l}</span></div>`; }).join("")}</div>` : ""}` });
  }
  for (const w of s.ci || []) {
    const bars = w.days.map((d, i) => { const t = w.tips[i]; return `<i data-s="${d}" title="${t.ok + t.bad ? `${t.ok} passed, ${t.bad} failed` : "no runs"}"></i>`; }).join("");
    wins.push({ key: `workflow:${encodeURIComponent(w.path)}`, kind: "Workflow", title: w.name, href: w.last?.url || `${repoUrl}/actions`, body: `
      <div class="bars tall">${bars}</div><div class="axis"><span>${WINDOW} days ago</span><span class="rule"></span><span>today</span></div>
      ${kv([["File", `<code>${esc(w.path)}</code>`], ["Passing", w.pct == null ? "no runs" : `${w.pct}% of ${w.runs}${w.capped ? "+" : ""} runs`], ["Last run", w.last ? `<a href="${esc(w.last.url)}" target="_blank" rel="noopener">${ago(w.last.at)}</a> on <code>${esc(w.last.branch)}</code>, ${esc(w.last.conclusion || w.last.status)}` : "none"]])}
      <p class="faint">Green day: every run passed. Amber: some failed. Red: all failed.</p>` });
  }
  const prWin = (p, state) => wins.push({ key: `pr:${p.number}`, kind: "Pull request", title: `#${p.number} ${p.title}`, href: p.url, body: `
      <div class="w-head">${statePill(state === "open" ? "ok" : state === "merged" ? "merged" : "bad", state === "open" ? (p.draft ? "Draft" : "Open") : state === "merged" ? "Merged" : "Closed")}${AGENT_BRANCH.test(p.branch || "") ? `<span class="agent-tag">agent</span>` : ""}</div>
      <p class="w-title">${esc(p.title)}</p>
      ${kv([["Branch", `<code class="branch">${esc(p.branch)}</code>`], ["Author", esc(p.author || "")], ["Opened", p.created_at ? when2(p.created_at) : ""], ["Merged", p.merged_at ? when2(p.merged_at) : ""], ["Closed", p.closed_at ? when2(p.closed_at) : ""], ["CI", p.ci ? { green: "Passing", red: "Failing", running: "Running", none: "No CI" }[p.ci] : ""]])}` });
  for (const p of s.queue.prs) prWin(p, "open");
  for (const p of (s.queue.merged || []).slice(0, 15)) prWin(p, "merged");
  for (const p of (s.queue.closed || []).slice(0, 15)) prWin(p, "closed");
  for (const i of s.queue.issues) wins.push({ key: `issue:${i.number}`, kind: "Issue", title: `#${i.number} ${i.title}`, href: i.url, body: `
      <p class="w-title">${esc(i.title)}</p>
      ${kv([["Labels", i.labels.map((l) => `<span class="tag ${l === "risky" ? "risky" : ""}">${esc(l)}</span>`).join("") || "none"], ["Opened", when2(i.created_at)]])}` });
  const winTemplates = `<div id="win-tpl" hidden>${wins.map((w) => `<template data-key="${esc(w.key)}" data-kind="${esc(w.kind)}" data-title="${esc(w.title)}" data-href="${esc(w.href || "")}">${w.body}</template>`).join("")}</div>`;

  const incidents = s.queue.issues.length
    ? s.queue.issues.map((i) => `<div class="incident"><h3><a href="${esc(i.url)}" target="_blank" rel="noopener" data-open="issue:${i.number}">${esc(i.title)}</a></h3><p>${i.labels.map((l) => `<span class="tag ${l === "risky" ? "risky" : ""}">${esc(l)}</span>`).join("")}#${i.number} · opened ${ago(i.created_at)}</p></div>`).join("")
    : `<p class="none">No open issues.</p>`;

  const M = s.metrics;
  const dur = (h) => (h == null ? "–" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} d`);
  const n = (x) => (x == null ? "–" : x);
  const maxDay = M ? Math.max(1, ...M.prs.per_day.map((d) => d.all)) : 1;
  const metrics = !M ? "" : `
    <h2>Last ${WINDOW} days</h2>
    <div class="group stats">
      <div class="stat"><b>${n(M.prs.merged)}</b><span>PRs merged</span><small>${M.prs.agent_share == null ? "" : `${M.prs.agent_share}% by agents · `}${n(M.prs.opened)} opened</small></div>
      <div class="stat"><b>${dur(M.prs.median_merge_h)}</b><span>Median time to merge</span><small>${n(M.prs.closed_unmerged)} closed without merge</small></div>
      <div class="stat"><b>${n(M.issues.closed)}<i>/${n(M.issues.opened)}</i></b><span>Issues closed / opened</span><small>${M.issues.open} open${M.issues.median_age_d == null ? "" : `, median age ${Math.round(M.issues.median_age_d)} d`}</small></div>
      <div class="stat"><b>${M.ci.pass_rate == null ? "–" : M.ci.pass_rate + "%"}</b><span>CI runs passing</span><small data-s="${M.ci.failing_now.length ? "bad" : "ok"}">${M.ci.failing_now.length ? `Failing now: ${esc(M.ci.failing_now.join(", "))}` : `${M.ci.runs} runs, none failing now`}</small></div>
      <div class="chart" aria-label="PRs merged per day">
        <div class="cols">${M.prs.per_day.map((d) => `<div title="${d.d} · ${d.all} merged, ${d.agents} by agents"><i style="height:${(d.all / maxDay) * 100}%"><em style="height:${d.all ? (d.agents / d.all) * 100 : 0}%"></em></i></div>`).join("")}</div>
        <div class="axis"><span>PRs merged per day</span><span class="rule"></span><span><span class="key"></span> by agents</span></div>
      </div>
    </div>`;

  const onboarding = repoRow && s.counts.heartbeats === 0;
  const setupState = { ...(s.setup || {}), cost_sources: s.costs?.sources || [], sessions: s.costs?.sessions_30d || 0 };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // --- left-nav app: one page, one view per section, switched by the URL hash ---------------
  const NAV_ICON = {
    assistant: `<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 7h.01M8 7h.01M10.5 7h.01"/>`,
    overview: `<path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z"/>`,
    monitors: `<path d="M1.5 8.5h3l1.8-4.5 3.4 8.5 1.8-4h3"/>`,
    automations: `<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>`,
    ci: `<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.8 1.8 3.3-3.6"/>`,
    prs: `<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6.5A2 2 0 0 0 10 4.5H7.5M9 3l-1.5 1.5L9 6"/>`,
    issues: `<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.2"/>`,
    costs: `<path d="M10.8 5.2c-.4-.9-1.5-1.5-2.8-1.5-1.6 0-2.8.8-2.8 2 0 2.9 5.8 1.6 5.8 4.5 0 1.2-1.3 2.1-3 2.1-1.4 0-2.6-.6-3-1.6M8 2v1.7M8 12.3V14"/>`,
    setup: `<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>`,
  };
  const ico = (k) => `<svg class="ni" viewBox="0 0 16 16" aria-hidden="true">${NAV_ICON[k]}</svg>`;
  const badMon = s.monitors.filter((m) => ["dead", "lying", "degraded"].includes(m.state)).length;
  const warnMon = s.monitors.filter((m) => m.state === "warn").length;
  const lateN = s.routines.filter(isLate).length;
  const failingCi = (s.ci || []).filter((w) => w.last?.status === "completed" && w.last.conclusion === "failure").length;
  const badge = (n, tone) => (n ? `<span class="nb" data-t="${tone}">${n}</span>` : "");
  const count = (n) => (n ? `<span class="nc">${n}</span>` : "");
  const NAV = [
    ["overview", "Overview", ""],
    ["assistant", "Assistant", ""],
    ["monitors", "Monitors", badMon ? badge(badMon, "bad") : warnMon ? badge(warnMon, "warn") : count(s.monitors.length)],
    ["automations", "Automations", lateN ? badge(lateN, "bad") : count(s.routines.length)],
    ["ci", "CI", failingCi ? badge(failingCi, "bad") : count((s.ci || []).length)],
    ["prs", "Pull requests", count(s.queue.prs.length)],
    ["issues", "Issues", count(s.queue.issues.length)],
    ["costs", "Costs", C ? `<span class="nc">${usd(C.total_usd)}</span>` : ""],
  ];
  const navLink = ([k, label, extra]) => `<a href="#${k}" data-nav="${k}">${ico(k)}<span>${label}</span>${extra}</a>`;
  const vh = (title, desc) => `<header class="vh"><h1>${title}</h1>${desc ? `<p>${desc}</p>` : ""}</header>`;
  const view = (k, body) => `<section class="view" data-view="${k}">${body}</section>`;
  const liveBox = (compact) => `<div class="ci-live"${compact ? ' data-compact="1"' : ""} aria-live="polite"><div class="live-head"><h2>Actions</h2><span class="live-dot"></span><span class="live-meta">Checking…</span></div></div>`;

  // overview cards
  const probs = s.monitors.filter((m) => ["dead", "lying", "degraded", "warn"].includes(m.state));
  const ops = s.monitors.filter((m) => m.state === "alive").length;
  const nextRuns = s.routines.filter((r) => r.next_run).sort((a, b) => (a.next_run < b.next_run ? -1 : 1)).slice(0, 4);
  const card = (k, title, body) => `<div class="card"><div class="card-h"><h3>${ico(k)}${title}</h3><a href="#${k}">View →</a></div>${body}</div>`;
  const cards = `<div class="cards">
    ${card("monitors", "Monitors", s.monitors.length ? `<div class="big">${ops}<i>/${s.monitors.length}</i></div><div class="cap">operational</div>${probs.length ? `<ul class="mini">${probs.slice(0, 4).map((m) => { const [ps, label] = STATE[m.state]; return `<li class="openable" data-open="monitor:${esc(m.id)}" role="button" tabindex="0"><code>${esc(m.id)}</code><span class="state" data-s="${ps}">${label}</span></li>`; }).join("")}</ul>` : `<div class="cap ok">Nothing needs attention.</div>`}` : `<div class="cap">No heartbeat yet. <a href="#setup">Set it up</a>.</div>`)}
    ${card("automations", "Next runs", nextRuns.length ? `<ul class="mini">${nextRuns.map((r) => `<li class="openable" data-open="routine:${esc(encodeURIComponent(r.name))}" role="button" tabindex="0"><span>${esc(r.name.replace(/^App: /, ""))}</span><span class="faint">${until(r.next_run)}</span></li>`).join("")}</ul>${lateN ? `<div class="cap bad">${plural(lateN, "routine")} late</div>` : ""}` : `<div class="cap">No routines found.</div>`)}
    ${card("costs", "Costs", C ? `<div class="big">${usd(C.total_usd)}</div><div class="cap">in ${WINDOW} days · ${usd(C.yesterday)} yesterday</div><div class="cap">${tk(C.tokens_30d)} Claude Code tokens, ${C.sessions_30d} session${C.sessions_30d === 1 ? "" : "s"}</div>` : `<div class="cap">No cost data yet. <a href="#costs">How to connect</a>.</div>`)}
  </div>`;

  const costsEmpty = `<div class="group"><div class="line"><span class="hint">No cost data yet. Claude Code sessions report their tokens through the heartbeat hook; provider spend comes from <code>.claude/hooks/hush.sh cost aws 31.50</code> or <code>POST /api/cost</code>. See <a href="#setup">Setup</a>.</span></div></div>`;

  return page(`${s.repo} · hush`, `<div class="app">
    <header class="topbar">
      <a class="logo" href="/">${MARK()}<span>hush</span></a>
      <nav class="crumbs" aria-label="Breadcrumb">${user ? `<a href="/">Repositories</a><span>/</span>` : ""}<b>${esc(s.repo)}</b></nav>
      <span class="tb-right">${user ? `<span class="tb-user">${esc(user.login)}</span>` : ""}</span>
    </header>
    <aside class="side">
      <div class="repo-box">
        <a class="repo-name" href="${repoUrl}" target="_blank" rel="noopener">${esc(s.repo)}</a>
        <span class="repo-state" data-s="${s.overall}"><i></i>${s.overall === "ok" ? "Operational" : s.overall === "degraded" ? "Degraded" : "Needs attention"}</span>
      </div>
      <nav class="snav" aria-label="Sections">${NAV.map(navLink).join("")}</nav>
      <div class="side-foot">
        <a href="#setup" data-nav="setup">${ico("setup")}<span>Setup</span>${onboarding ? badge("!", "warn") : ""}</a>
        ${user ? `<a href="/">${ico("overview")}<span>All repos</span></a>` : ""}
        <span class="updated">Updated ${ago(s.generated_at)}</span>
      </div>
    </aside>
    <main class="main">
      ${winTemplates}
      ${view("overview", `
        <div class="banner" data-s="${s.overall}">${s.overall === "ok" ? CHECK : ALERT}<span>${banner}</span></div>
        <p class="banner-sub">${s.affected.length ? `Affected: ${esc(s.affected.join(", "))}. ` : ""}${plural(s.counts.merged_24h, "PR")} merged in 24 h, ${s.counts.agent_merged_24h} by agents. ${s.queue.prs.length ? `${plural(s.queue.prs.length, "PR")} open.` : "No open PRs."}</p>
        ${onboarding ? `<section id="onboard" class="onboard"><h2>Finish setting up ${esc(s.repo)}</h2>${heartbeatSetup(origin, repoRow.ingest_key, true, setupState)}</section>` : ""}
        ${cards}
        ${liveBox(true)}
        ${metrics}`)}
      ${view("monitors", `${vh("Monitors", "Skills that run on a schedule and report a heartbeat. A silent monitor is a dead monitor.")}
        ${s.monitors.length ? `<div class="group grid2">${monRows}</div>` : `<div class="group"><div class="line"><span class="hint">No heartbeat yet. <a href="#setup">Install the heartbeat</a>.</span></div></div>`}`)}
      ${view("automations", `${vh("Automations", "Claude Code routines and scheduled GitHub Actions, with their next run and proof that the last one happened.")}
        ${s.routines.length ? `<div class="group">${routineRows}</div>` : `<div class="group"><div class="line"><span class="hint">No routines found. Declare them in <code>.claude/factory.json</code>.</span></div></div>`}`)}
      ${view("ci", `${vh("CI", "GitHub Actions: what is running now, and every workflow over the last 30 days.")}
        ${liveBox(false)}
        ${ci ? `<h2>Workflows</h2><div class="group grid2">${ci}</div>` : ""}`)}
      ${view("prs", `${vh("Pull requests", "Open with their CI, plus the latest merged and closed.")}${prSection}`)}
      ${view("issues", `${vh("Issues", `${plural(s.queue.issues.length, "open issue")}.`)}<div class="incidents">${incidents}</div>`)}
      ${view("costs", `${vh("Costs", "What the factory spends per day and per provider, and the tokens every Claude Code session burns.")}${costs || costsEmpty}`)}
      ${view("assistant", `${vh("Assistant", "Ask anything about this repo. It reads everything Hush has: monitors and their heartbeats, routines, CI, pull requests, issues and costs.")}
        <div class="chat" id="chat" data-repo="${esc(s.repo)}">
          <div class="chat-log" id="chat-log"></div>
          <div class="chips">${["What needs my attention?", "Which routines are late, and why?", "Why did spend change this week?", "Summarize the last 7 days"].map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
          <form class="ask" id="ask-form"><textarea id="ask-input" rows="2" placeholder="Ask about ${esc(s.repo)}…"></textarea><button type="submit">Ask</button></form>
          <div class="chat-note">Answers come from ${esc(ASK_MODEL)} on OpenRouter, from this page's data. They can be wrong; check the source.</div>
        </div>`)}
      ${view("setup", `${vh("Setup", setupState.hush_sh && setupState.hook ? "This repo reports to Hush. Each step shows what is in place." : "How this repo reports to Hush.")}${repoRow ? `<section class="onboard">${heartbeatSetup(origin, repoRow.ingest_key, onboarding, setupState)}</section>` : ""}
        <footer><span>${plural(s.counts.heartbeats, "heartbeat")} in ${WINDOW} days${s.notes.length ? ` · ${esc(s.notes.join(" · "))}` : ""}</span><span></span></footer>`)}
    </main>
  </div>`, { live: true, stale, app: true });
}

function homePage(user, repos = [], msg = "", snaps = {}) {
  const app = appConfig();
  if (!app) {
    return page("hush", `<header class="top">${LOGO}</header>
      <div class="hero"><h1>A status page for your software factory.</h1><p>The GitHub App is not set up yet. Whoever runs this instance does it once, from <code>/setup</code>.</p></div>`);
  }
  const install = `https://github.com/apps/${app.slug}/installations/new`;
  if (!user) return landingPage({ install, msg, esc, css: CSS + THEME, fonts: FONTS, icon: ICON, mark: MARK });
  // Every repo the person can see, grouped by account, with the numbers from its last snapshot.
  const usdF = (n) => (n == null ? "–" : "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)));
  const STATE_LABEL = { ok: "Operational", degraded: "Degraded", down: "Needs attention" };
  const accounts = [...new Map(repos.map((r) => [r.account.login, r.account])).values()];
  const row = (r) => {
    const s = snaps[r.id];
    if (!s) return `<a class="rrow2" href="/r/${esc(r.full_name)}"><span class="rn"><span class="dot"></span><span><b>${esc(r.full_name.split("/")[1])}</b>${r.private ? " <small>private</small>" : ""}<span class="sub">Not read yet. Open it to start.</span></span></span><span></span><span></span><span></span><span></span><span class="go">Open →</span></a>`;
    const mons = s.monitors || [], ok = mons.filter((m) => m.state === "alive").length;
    const M = s.metrics, C = s.costs;
    return `<a class="rrow2" href="/r/${esc(r.full_name)}"><span class="rn"><span class="dot" data-s="${s.overall}"></span><span><b>${esc(r.full_name.split("/")[1])}</b>${r.private ? " <small>private</small>" : ""}<span class="sub">${STATE_LABEL[s.overall] || ""} · updated ${ago(s.generated_at)}</span></span></span>
      <span class="num">${mons.length ? `${ok}<i>/${mons.length}</i>` : "–"}</span>
      <span class="num">${M?.prs?.merged ?? "–"}${M?.prs?.agent_share != null ? `<i> ${M.prs.agent_share}%</i>` : ""}</span>
      <span class="num">${M?.ci?.pass_rate != null ? `${M.ci.pass_rate}%` : "–"}</span>
      <span class="num">${C ? usdF(C.total_usd) : "–"}</span>
      <span class="go">Open →</span></a>`;
  };
  return page("Repositories · hush", `<div class="app solo">
    <header class="topbar"><a class="logo" href="/">${MARK()}<span>hush</span></a><nav class="crumbs"><b>Repositories</b></nav><span class="tb-right"><span class="tb-user">${esc(user.login)}</span><form method="post" action="/logout" style="margin:0"><button class="tb-btn">Sign out</button></form></span></header>
    <main class="main">
      <header class="vh"><h1>Repositories</h1><p>Every repo Hush is installed on that your GitHub account can see. Numbers are the last ${WINDOW} days.</p></header>
      ${repos.length ? accounts.map((a) => `<h2>${esc(a.login)}</h2><div class="group repos-t">
        <div class="rrow2 head"><span>Repository</span><span class="num">Monitors ok</span><span class="num">PRs merged · agents</span><span class="num">CI passing</span><span class="num">Spend</span><span></span></div>
        ${repos.filter((r) => r.account.login === a.login).map(row).join("")}</div>`).join("") : `<div class="group"><div class="line"><span class="hint">Hush is not installed on any of your repos yet.</span></div></div>`}
      <p><a class="btn" href="${install}">${repos.length ? "Add or remove repos" : "Install on your repos"}</a></p>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    </main></div>`, { app: true });
}

function setupPage(origin, t) {
  const manifest = {
    name: `Hush ${randomBytes(2).toString("hex")}`,
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

async function insertBeat(repoId, b) {
  const status = ["ok", "degraded", "skipped"].includes(b.status) ? b.status : null;
  if (!b.monitor || !status) throw new Error("monitor and status (ok|degraded|skipped) are required");
  const ts = b.ts && !Number.isNaN(Date.parse(b.ts)) ? new Date(b.ts).toISOString() : new Date().toISOString();
  const body = JSON.stringify({ source: b.source === "session" ? "session" : "skill", window: b.window || "", swept: b.swept || {}, suppressed: b.suppressed ?? null, filed: (b.filed || []).map(Number).filter(Boolean), note: String(b.note || "").slice(0, 500) });
  await db.run("INSERT INTO heartbeats (repo_id, monitor, ts, status, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", repoId, String(b.monitor).slice(0, 80), ts, status, body);
}

// --- assistant ---------------------------------------------------------------------------
// One question = one OpenRouter call with everything Hush knows about the repo in the system
// prompt: the snapshot, 30 days of heartbeats (with their notes and volumes), the cost rows,
// and a one-line summary of every other repo the person can see. Answers stream back as text.
const askLog = new Map();
function askAllowed(login) {
  const now = Date.now(), recent = (askLog.get(login) || []).filter((t) => now - t < 36e5);
  if (recent.length >= 40) return false;
  askLog.set(login, [...recent, now]);
  return true;
}
async function askContext(row, snap, user, repos) {
  const since = new Date(Date.now() - WINDOW * 864e5).toISOString();
  const beats = await db.all("SELECT monitor, ts, status, body FROM heartbeats WHERE repo_id = $1 AND ts >= $2 ORDER BY ts DESC LIMIT 600", row.id, since);
  const costs = await db.all("SELECT source, day, usd, body FROM costs WHERE repo_id = $1 AND day >= $2 ORDER BY day", row.id, since.slice(0, 10));
  const others = repos.filter((r) => r.id !== row.id);
  const ids = others.map((r) => r.id);
  const snaps = ids.length ? await db.all(`SELECT repo_id, body FROM snapshots WHERE repo_id IN (${ids.map((_, i) => "$" + (i + 1)).join(",")})`, ...ids) : [];
  const brief = snaps.map((r) => { const o = JSON.parse(r.body); return `${o.repo}: ${o.overall}; monitors ${o.monitors.filter((m) => m.state === "alive").length}/${o.monitors.length} ok; PRs merged 30d ${o.metrics?.prs?.merged ?? "?"}; CI pass ${o.metrics?.ci?.pass_rate ?? "?"}%; spend 30d ${o.costs ? "$" + o.costs.total_usd.toFixed(2) : "n/a"}`; });
  const lean = { ...snap, skills: undefined, monitors: snap.monitors.map((m) => ({ ...m, buckets: m.buckets.map((b) => b.s || "-").join("") })), ci: (snap.ci || []).map((w) => ({ ...w, days: w.days.map((d) => d || "-").join(""), tips: undefined })) };
  return `You are the assistant inside Hush, a status page for a software factory: a repo where AI agents (Claude Code routines) and GitHub Actions do scheduled work, and monitors report heartbeats.
You are answering ${user.login} about the repo ${row.full_name}. Now: ${new Date().toISOString()} (UTC).

Rules:
- Answer only from the data below. If it does not say, say so, and say what would tell you.
- Be specific: name monitors, routines, workflows, PR and issue numbers, dates and amounts.
- Lead with the answer. Short paragraphs or a short list. No preamble.
- Monitor states: alive = operational, warn = degraded (last run not ok), degraded = chronically degraded, lying = said ok but read nothing, dead = silent past its window, retired = gone from the roster.
- Bars are oldest to newest, one char per day (or week for weekly monitors): ok, degraded, skipped, "-" = no run.
- Costs: provider rows are real daily spend; Claude Code dollars are estimates at API list prices.

## Snapshot of ${row.full_name}
${JSON.stringify(lean)}

## Heartbeats, last ${WINDOW} days (newest first)
${beats.map((b) => { const x = JSON.parse(b.body); return `${b.ts} ${b.monitor} ${b.status}${x.source === "session" ? " (session)" : ""}${Object.keys(x.swept || {}).length ? " swept=" + JSON.stringify(x.swept) : ""}${x.filed?.length ? " filed=" + x.filed.join(",") : ""}${x.note ? " note: " + x.note : ""}`; }).join("\n") || "none"}

## Cost rows, last ${WINDOW} days
${costs.map((c) => { const x = JSON.parse(c.body); return `${c.day} ${c.source} ${c.usd == null ? "" : "$" + c.usd}${x.name ? " " + x.name : ""}${x.models && Object.keys(x.models).length ? " tokens=" + JSON.stringify(x.models) : ""}${x.breakdown ? " " + JSON.stringify(x.breakdown) : ""}`; }).join("\n") || "none"}

## Other repos ${user.login} can see
${brief.join("\n") || "none"}`;
}
async function askStream(res, system, messages, origin) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return send(res, 503, "The assistant is not configured on this Hush (OPENROUTER_API_KEY is missing).", { "content-type": "text/plain; charset=utf-8" });
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "http-referer": origin, "x-title": "Hush" },
    body: JSON.stringify({ model: ASK_MODEL, stream: true, messages: [{ role: "system", content: system }, ...messages] }),
  });
  if (!r.ok || !r.body) return send(res, 502, `The model did not answer (${r.status}). ${(await r.text().catch(() => "")).slice(0, 300)}`, { "content-type": "text/plain; charset=utf-8" });
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const d = JSON.parse(data);
        const t = d.choices?.[0]?.delta?.content;
        if (t) res.write(t);
        if (d.error) res.write(`\n\n(${d.error.message || "the model stopped"})`);
      } catch {}
    }
  }
  res.end();
}

// A repo row is created the first time someone who can see it opens its page. It is keyed by the
// GitHub repo id; name, account and installation are refreshed from GitHub on every visit, so a
// rename, a transfer or a reinstall keeps its history and its ingest key.
async function ensureRepo(seen, user) {
  const now = new Date().toISOString();
  await db.run("INSERT INTO accounts (id, login, type, installation_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(id) DO UPDATE SET login = excluded.login, type = excluded.type, installation_id = excluded.installation_id", seen.account.id, seen.account.login, seen.account.type, seen.installation_id, now);
  await db.run("INSERT INTO repos (id, account_id, full_name, installation_id, ingest_key, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, full_name = excluded.full_name, installation_id = excluded.installation_id", seen.id, seen.account.id, seen.full_name, seen.installation_id, "fsk_" + randomBytes(24).toString("base64url"), user.login, now);
  return db.one("SELECT * FROM repos WHERE id = $1", seen.id);
}

// One-time move from the first storage (factory.db on the Fly volume, keyed by repo name) into the
// current database. Repo names are resolved to GitHub ids through the app; keys and history keep.
async function migrateLegacy() {
  const file = join(DATA, "factory.db");
  if (!existsSync(file) || (await db.one("SELECT v FROM settings WHERE k = $1", "migrated_legacy"))) return;
  const old = new DatabaseSync(file, { readOnly: true });
  const has = (t) => old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  for (const r of old.prepare("SELECT k, v FROM settings").all()) await db.run("INSERT INTO settings (k, v) VALUES ($1, $2) ON CONFLICT(k) DO NOTHING", r.k, r.v);
  await loadApp();
  for (const u of old.prepare("SELECT login, token, created_at FROM users").all()) await db.run("INSERT INTO users (login, token, created_at) VALUES ($1, $2, $3) ON CONFLICT(login) DO NOTHING", u.login, u.token, u.created_at);
  let moved = { repos: 0, heartbeats: 0, costs: 0 };
  for (const r of old.prepare("SELECT * FROM repos").all()) {
    if (!r.installation_id || !APP) continue;
    const meta = await gh(await installationToken(r.installation_id), `repos/${r.full_name}`).catch(() => null);
    if (!meta) { console.log(`migrate: skipped ${r.full_name}, not readable`); continue; }
    const now = new Date().toISOString();
    await db.run("INSERT INTO accounts (id, login, type, installation_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(id) DO NOTHING", meta.owner.id, meta.owner.login, meta.owner.type, r.installation_id, now);
    await db.run("INSERT INTO repos (id, account_id, full_name, installation_id, ingest_key, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(id) DO NOTHING", meta.id, meta.owner.id, meta.full_name, r.installation_id, r.ingest_key, r.owner_login, r.created_at);
    moved.repos++;
    for (const b of old.prepare("SELECT monitor, ts, status, body FROM heartbeats WHERE repo = ?").all(r.full_name)) {
      await db.run("INSERT INTO heartbeats (repo_id, monitor, ts, status, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", meta.id, b.monitor, b.ts, b.status, b.body);
      moved.heartbeats++;
    }
    if (has("costs")) for (const c of old.prepare("SELECT source, key, day, usd, body, at FROM costs WHERE repo = ?").all(r.full_name)) {
      await db.run("INSERT INTO costs (repo_id, source, key, day, usd, body, at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(repo_id, source, key) DO NOTHING", meta.id, c.source, c.key, c.day, c.usd, c.body, c.at);
      moved.costs++;
    }
  }
  old.close();
  await setSetting("migrated_legacy", new Date().toISOString());
  console.log(`migrate: ${JSON.stringify(moved)}`);
}

// When the server moves to Postgres, bring over what the local SQLite (hush.db) collected in the
// meantime. Same schema; newer cost rows win, everything else is insert-if-missing.
async function migrateLocal() {
  const file = join(DATA, "hush.db");
  if (db.kind !== "postgres" || !existsSync(file) || (await db.one("SELECT v FROM settings WHERE k = $1", "migrated_local"))) return;
  const lite = new DatabaseSync(file, { readOnly: true });
  const all = (q) => lite.prepare(q).all();
  const moved = {};
  const copy = async (name, rows, q, cols) => {
    for (const r of rows) await db.run(q, ...cols.map((c) => r[c]));
    moved[name] = rows.length;
  };
  await copy("settings", all("SELECT * FROM settings"), "INSERT INTO settings (k, v) VALUES ($1, $2) ON CONFLICT(k) DO NOTHING", ["k", "v"]);
  await copy("users", all("SELECT * FROM users"), "INSERT INTO users (login, token, created_at) VALUES ($1, $2, $3) ON CONFLICT(login) DO NOTHING", ["login", "token", "created_at"]);
  await copy("accounts", all("SELECT * FROM accounts"), "INSERT INTO accounts (id, login, type, installation_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(id) DO NOTHING", ["id", "login", "type", "installation_id", "created_at"]);
  await copy("repos", all("SELECT * FROM repos"), "INSERT INTO repos (id, account_id, full_name, installation_id, ingest_key, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(id) DO NOTHING", ["id", "account_id", "full_name", "installation_id", "ingest_key", "created_by", "created_at"]);
  await copy("heartbeats", all("SELECT * FROM heartbeats"), "INSERT INTO heartbeats (repo_id, monitor, ts, status, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", ["repo_id", "monitor", "ts", "status", "body"]);
  await copy("costs", all("SELECT * FROM costs"), "INSERT INTO costs (repo_id, source, key, day, usd, body, at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(repo_id, source, key) DO UPDATE SET day = excluded.day, usd = excluded.usd, body = excluded.body, at = excluded.at WHERE costs.at < excluded.at", ["repo_id", "source", "key", "day", "usd", "body", "at"]);
  lite.close();
  await setSetting("migrated_local", new Date().toISOString());
  console.log(`migrate local: ${JSON.stringify(moved)}`);
}

await loadApp();
await migrateLegacy().catch((e) => console.error("migrate failed:", e));
await migrateLocal().catch((e) => console.error("migrate local failed:", e));
await loadApp();

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const origin = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok", { "content-type": "text/plain" });
    if (url.pathname === "/install.sh") return send(res, 200, INSTALL.replaceAll("__ORIGIN__", origin), { "content-type": "text/x-shellscript; charset=utf-8" });

    if (url.pathname === "/api/cost" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = key && (await db.one("SELECT id FROM repos WHERE ingest_key = $1", key));
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(body) ? body : [body];
      if (list.length > 500) return json(res, 413, { error: "at most 500 per request" });
      for (const c of list) await insertCost(repo.id, c);
      return json(res, 200, { ok: true, stored: list.length });
    }
    if (url.pathname === "/api/heartbeat" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = key && (await db.one("SELECT id FROM repos WHERE ingest_key = $1", key));
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(body) ? body : [body];
      if (list.length > 500) return json(res, 413, { error: "at most 500 per request" });
      for (const b of list) await insertBeat(repo.id, b);
      return json(res, 200, { ok: true, stored: list.length });
    }

    const user = await sessionUser(req);

    if (url.pathname === "/" && req.method === "GET") {
      if (!user) return send(res, 200, homePage(null));
      const repos = await userRepos(user).catch(() => null);
      if (!repos) return redirect(res, "/auth/login");
      const ids = repos.map((r) => r.id);
      const rows = ids.length ? await db.all(`SELECT repo_id, body FROM snapshots WHERE repo_id IN (${ids.map((_, i) => "$" + (i + 1)).join(",")})`, ...ids) : [];
      const snaps = Object.fromEntries(rows.map((r) => [Number(r.repo_id), JSON.parse(r.body)]));
      return send(res, 200, homePage(user, repos, "", snaps));
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
      await saveApp({ id: a.id, slug: a.slug, name: a.name, pem: a.pem, client_id: a.client_id, client_secret: a.client_secret, webhook_secret: a.webhook_secret });
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
      await db.run("INSERT INTO users (login, token, created_at) VALUES ($1, $2, $3) ON CONFLICT(login) DO UPDATE SET token = excluded.token", me.login, seal(tok.access_token), new Date().toISOString());
      cache.delete(`userrepos:${me.login}`);
      return redirect(res, "/", { "set-cookie": [sessionCookie(me.login), "fs_state=; Path=/; Max-Age=0"] });
    }

    if (url.pathname === "/logout" && req.method === "POST") return redirect(res, "/", { "set-cookie": "fs=; Path=/; Max-Age=0" });

    const m = url.pathname.match(/^\/r\/([\w.-]+\/[\w.-]+?)(\.json|\/live|\/setup|\/ask)?$/);
    if (m && (req.method === "GET" || (req.method === "POST" && m[2] === "/ask"))) {
      if (!user) return redirect(res, "/auth/login");
      const repos = await userRepos(user).catch(() => null);
      if (!repos) return redirect(res, "/auth/login");
      const seen = repos.find((r) => r.full_name.toLowerCase() === m[1].toLowerCase());
      if (!seen) return send(res, 404, page("Not found", `<header class="top">${LOGO}</header><p class="none">Hush is not installed on that repo, or your account cannot see it.</p>`));
      const row = await ensureRepo(seen, user);
      if (m[2] === "/live") return json(res, 200, { ...(await readLive(await installationToken(row.installation_id), row.full_name)), beats: (await db.one("SELECT COUNT(*)::int AS n FROM heartbeats WHERE repo_id = $1", row.id)).n });
      if (m[2] === "/setup") return send(res, 200, heartbeatPage(origin, row));
      if (m[2] === "/ask") {
        if (req.method !== "POST") return send(res, 405, "POST only");
        if (!askAllowed(user.login)) return send(res, 429, "That's 40 questions in the last hour. Try again later.", { "content-type": "text/plain; charset=utf-8" });
        const { messages = [] } = JSON.parse((await readBody(req, 2e5)) || "{}");
        const clean = messages.filter((x) => ["user", "assistant"].includes(x?.role) && typeof x.content === "string").slice(-20).map((x) => ({ role: x.role, content: x.content.slice(0, 8000) }));
        if (!clean.length || clean.at(-1).role !== "user") return send(res, 400, "Ask a question.");
        const saved = await db.one("SELECT body FROM snapshots WHERE repo_id = $1", row.id);
        let snap = saved && JSON.parse(saved.body);
        if (!snap || snap.v !== SNAP_V) snap = await refresh(row);
        return askStream(res, await askContext(row, snap, user, repos), clean, origin);
      }
      let saved = await db.one("SELECT at, body FROM snapshots WHERE repo_id = $1", row.id);
      if (saved && JSON.parse(saved.body).v !== SNAP_V) saved = null;
      const fresh = saved && Date.now() - Number(saved.at) < FRESH_MS;
      if (m[2]) return json(res, 200, fresh ? JSON.parse(saved.body) : await refresh(row));
      // ?partial=1 is the page's own background fetch: always a fresh read (deduped, and
      // the readers keep their own short caches).
      if (url.searchParams.has("partial")) return send(res, 200, statusPage(fresh ? JSON.parse(saved.body) : await refresh(row), user, origin, row));
      if (saved) return send(res, 200, statusPage(JSON.parse(saved.body), user, origin, row, { stale: !fresh }));
      refresh(row).catch((e) => console.error(e));
      return send(res, 200, skeletonPage(row.full_name));
    }

    send(res, 404, page("Not found", `<header class="top">${LOGO}</header><p class="none">This page does not exist.</p>`));
  } catch (e) {
    console.error(e);
    if (url.pathname.startsWith("/api/")) return json(res, 400, { error: e.message });
    send(res, 500, page("Error", `<header class="top">${LOGO}</header><p class="err">${esc(e.message)}</p>`));
  }
}).listen(PORT, () => console.log(`factory-status on :${PORT}`));
