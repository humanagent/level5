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
import { execSync } from "node:child_process";
import { liteFile, openDb } from "./db.mjs";
import { createCipheriv, createDecipheriv, createHash, createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { landingPage } from "./landing.mjs";
import { dailyReport, reportData } from "./report.mjs";
import { decode } from "./otlp.mjs";
import { ingest as ingestRuns, readRuns } from "./live.mjs";

const PORT = Number(process.env.PORT || 8080);
// Local dev (npm run dev): signed in as DEV_USER, GitHub read with your own `gh` session instead of
// the GitHub App, and the database a Neon branch from .env.local. Never on in production.
const DEV = !!process.env.DEV_USER && process.env.NODE_ENV !== "production";
const DEV_TOKEN = DEV ? process.env.DEV_GITHUB_TOKEN || execSync("gh auth token").toString().trim() : null;
const DATA = process.env.DATA_DIR || "./data";
const SECRET = process.env.SECRET || "dev-secret-change-me";
const KEY = createHash("sha256").update(SECRET).digest();
const WINDOW = 30;
// Level 5 installs as a Claude Code plugin; /install.sh only says how
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
  if (DEV) return { login: process.env.DEV_USER, token: "" };
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

async function ghql(token, query, variables) {
  const r = await fetch("https://api.github.com/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "factory-status" }, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error(`GitHub GraphQL ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(`GitHub GraphQL: ${j.errors[0].message}`);
  return j.data;
}

// --- the GitHub App -----------------------------------------------------------------
// The app's credentials live sealed in settings and are cached here (loaded at start-up).
let APP = null;
const setSetting = (k, v) => db.run("INSERT INTO settings (k, v) VALUES ($1, $2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
async function loadApp() {
  const r = await db.one("SELECT v FROM settings WHERE k = $1", "app");
  try {
    APP = r ? JSON.parse(open(r.v)) : null;
  } catch {
    APP = null; // sealed with another SECRET (a dev copy of production): unreadable here
  }
  if (DEV && !APP) APP = { slug: "factory-status-cae6", dev: true };
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
  if (!app || app.dev) return;
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
  if (DEV) return DEV_TOKEN;
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
  if (DEV) {
    const rows = await db.all("SELECT r.id, r.full_name, r.installation_id, a.id AS aid, a.login, a.type FROM repos r JOIN accounts a ON a.id = r.account_id ORDER BY r.full_name");
    return rows.map((r) => ({ id: Number(r.id), full_name: r.full_name, private: true, installation_id: Number(r.installation_id), account: { id: Number(r.aid), login: r.login, type: r.type } }));
  }
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
// The longest wait between two runs over the next two weeks: a weekdays-only cron waits 72 h
// from Friday to Monday even though it runs "daily". Silence is judged against this.
function cronMaxGapHours(cron) {
  let t = nextRun(cron), gap = 0, n = 0;
  const end = Date.now() + 15 * 864e5;
  while (t && Date.parse(t) < end && n++ < 400) { const u = nextRun(cron, new Date(t)); if (!u) break; gap = Math.max(gap, (Date.parse(u) - Date.parse(t)) / 36e5); t = u; }
  return gap || cronPeriodHours(cron);
}
function cronPeriodHours(cron) {
  const a = nextRun(cron);
  const b = a && nextRun(cron, new Date(a));
  return a && b ? (new Date(b) - new Date(a)) / 36e5 : 24;
}

// --- the factory, read from the repo -------------------------------------------------
// A repo is connected when .claude/settings.json has a SessionEnd hook that runs
// .claude/hooks/<name>.sh session-end. Repos connected under an earlier name of the product have
// another <name>: they still count as installed, and the setup page asks to run /level5:setup again.
const HOOK_CMD = /\.claude\/hooks\/([\w.-]+)\.sh\s+session-end/;
function sessionEndHook(settingsJson) {
  let groups = [];
  try {
    groups = JSON.parse(settingsJson || "{}").hooks?.SessionEnd || [];
  } catch {}
  for (const g of Array.isArray(groups) ? groups : []) for (const h of g?.hooks || []) {
    const m = HOOK_CMD.exec(String(h?.command || ""));
    if (m) return m[1];
  }
  return null;
}
async function readFactory(token, repo) {
  return cached(`factory:${repo}`, 10 * 60e3, async () => {
    const notes = [];
    const [meta, skillDirs, factoryJson, roster, routineDoc, workflowsList, settingsJson] = await Promise.all([
      gh(token, `repos/${repo}`),
      gh(token, `repos/${repo}/contents/.claude/skills`).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/factory.json`, true).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/skills/monitor-meta/roster.json`, true).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/skills/cloud-routine.md`, true).catch(() => null),
      gh(token, `repos/${repo}/actions/workflows?per_page=100`).catch(() => null),
      gh(token, `repos/${repo}/contents/.claude/settings.json`, true).catch(() => null),
    ]);
    // the hook script its SessionEnd entry runs (level5.sh when there is no entry yet)
    const hookName = sessionEndHook(settingsJson);
    const hookSh = await gh(token, `repos/${repo}/contents/.claude/hooks/${hookName || "level5"}.sh`, true).catch(() => null);

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

    return { meta: { full_name: meta.full_name, private: meta.private, default_branch: meta.default_branch, url: meta.html_url }, skills, monitors, routines, notes, prices: config.prices || {}, promotion: config.promotion || null, client: { level5_sh: !!hookSh, legacy: !!hookName && hookName !== "level5", cost_cmd: /\bcost\)/.test(hookSh || ""), hook: !!hookName }, workflows: workflows.filter((w) => w.state === "active").map((w) => ({ id: w.id, name: w.name, path: w.path, url: w.html_url })) };
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
        // wall-clock minutes per day: from the run's start to its last update
        const mins = Object.fromEntries(days.map((d) => [d, 0]));
        // a run re-run or edited days later keeps its start and moves its update: over 3 h is not run time
        for (const r of runs) { const m = (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 6e4; if (r.status === "completed" && r.run_started_at && m >= 0 && m <= 180 && r.created_at.slice(0, 10) in mins) mins[r.created_at.slice(0, 10)] += m; }
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
          mins: days.map((d) => Math.round(mins[d] * 10) / 10),
          dates: days,
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
    // diff size of every merged PR: REST lists do not carry it, one GraphQL search page carries 100
    const size = {};
    try {
      let after = null;
      for (let i = 0; i < 6; i++) {
        const d = await ghql(token, `query($q:String!,$a:String){search(query:$q,type:ISSUE,first:100,after:$a){pageInfo{hasNextPage endCursor}nodes{...on PullRequest{number additions deletions}}}}`, { q: `repo:${repo} is:pr is:merged merged:>=${since}`, a: after });
        for (const n of d.search.nodes) if (n?.number) size[n.number] = [n.additions, n.deletions];
        if (!d.search.pageInfo.hasNextPage) break;
        after = d.search.pageInfo.endCursor;
      }
    } catch (e) { console.error("pr sizes:", e.message); }
    const sz = (p, k) => size[p.number]?.[k] || 0;
    const issueDays = { opened: {}, closed: {} };
    try {
      for (const [k, q, f] of [["opened", `repo:${repo} is:issue created:>=${since}`, "createdAt"], ["closed", `repo:${repo} is:issue closed:>=${since}`, "closedAt"]]) {
        let after = null;
        for (let i = 0; i < 5; i++) {
          const d = await ghql(token, `query($q:String!,$a:String){search(query:$q,type:ISSUE,first:100,after:$a){pageInfo{hasNextPage endCursor}nodes{...on Issue{createdAt closedAt}}}}`, { q, a: after });
          for (const n of d.search.nodes) if (n?.[f]) issueDays[k][n[f].slice(0, 10)] = (issueDays[k][n[f].slice(0, 10)] || 0) + 1;
          if (!d.search.pageInfo.hasNextPage) break;
          after = d.search.pageInfo.endCursor;
        }
      }
    } catch (e) { console.error("issue days:", e.message); }
    const hours = merged.map((p) => (Date.parse(p.merged_at) - Date.parse(p.created_at)) / 36e5).sort((a, b) => a - b);
    const median = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
    const days = [...Array(WINDOW)].map((_, i) => new Date(Date.now() - (WINDOW - 1 - i) * 864e5).toISOString().slice(0, 10));
    const perDay = days.map((d) => ({ d, all: merged.filter((p) => p.merged_at.slice(0, 10) === d).length, agents: merged.filter((p) => p.merged_at.slice(0, 10) === d && AGENT_BRANCH.test(p.head.ref)).length, added: merged.filter((p) => p.merged_at.slice(0, 10) === d).reduce((a, p) => a + sz(p, 0), 0), deleted: merged.filter((p) => p.merged_at.slice(0, 10) === d).reduce((a, p) => a + sz(p, 1), 0) }));
    const churn = merged.filter((p) => size[p.number]).map((p) => sz(p, 0) + sz(p, 1)).sort((a, b) => a - b);
    const runs = ci.reduce((a, w) => a + w.runs, 0);
    const passed = ci.reduce((a, w) => a + Math.round(((w.pct || 0) * w.runs) / 100), 0);
    const ages = issuesOpen.map((i) => (Date.now() - Date.parse(i.created_at)) / 864e5).sort((a, b) => a - b);
    return {
      prs: { opened: prOpened, merged: prMerged, closed_unmerged: prClosedUnmerged, median_merge_h: median(hours), agent_share: merged.length ? Math.round((merged.filter((p) => AGENT_BRANCH.test(p.head.ref)).length / merged.length) * 100) : null, per_day: perDay, added: merged.reduce((a, p) => a + sz(p, 0), 0), deleted: merged.reduce((a, p) => a + sz(p, 1), 0), median_lines: median(churn), sized: churn.length, size },
      issues: { opened: issOpened, closed: issClosed, open: issuesOpen.length, median_age_d: median(ages), per_day: days.map((d) => ({ d, opened: issueDays.opened[d] || 0, closed: issueDays.closed[d] || 0 })) },
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
// Promotions: how code moves from the integration branch to production. Repos that promote
// (staging -> main, develop -> master...) do it with pull requests into the production branch;
// this reads those PRs, what is waiting on the integration branch, and the last runs on production.
// Branches come from .claude/factory.json ("promotion": {"from": "staging", "to": "main"}) or are
// detected. A repo with one branch (trunk-based) has no promotions and says so.
async function readPromotions(token, repo, cfg, defaultBranch) {
  return cached(`promo:${repo}`, 2 * 60e3, async () => {
    // ask for the candidate branches by name: a busy repo has thousands of branches to page through
    const CAND = [...new Set([cfg?.from, cfg?.to, "staging", "develop", "development", "dev", "next", "main", "master", "production", "prod", "release"].filter(Boolean))];
    const found = await Promise.all(CAND.map((n) => gh(token, `repos/${repo}/branches/${encodeURIComponent(n)}`).then((b) => (b ? n : null)).catch(() => null)));
    const names = new Set(found.filter(Boolean));
    const from = cfg?.from || ["staging", "develop", "development", "dev", "next"].find((n) => names.has(n));
    const to = cfg?.to || ["main", "master", "production", "prod", "release"].find((n) => names.has(n) && n !== from);
    if (!from || !to) return { enabled: false, default_branch: defaultBranch };
    let [pulls, cmp, runs] = await Promise.all([
      gh(token, `repos/${repo}/pulls?state=all&base=${encodeURIComponent(to)}&sort=created&direction=desc&per_page=40`).catch(() => []),
      gh(token, `repos/${repo}/compare/${encodeURIComponent(to)}...${encodeURIComponent(from)}`).catch(() => null),
      gh(token, `repos/${repo}/actions/runs?branch=${encodeURIComponent(to)}&per_page=40`).catch(() => null),
    ]);
    // a promotion is a PR into production whose head is the integration branch or a merge branch made from it
    const isPromo = (p) => p.head.ref === from || /merge|promot|release/i.test(p.head.ref) || /promot|release/i.test(p.title);
    const prs = (pulls || []).filter(isPromo).map((p) => ({ number: p.number, title: p.title, head: p.head.ref, state: p.merged_at ? "merged" : p.state, created_at: p.created_at, merged_at: p.merged_at, closed_at: p.closed_at, author: p.user?.login || "", url: p.html_url, sha: p.head.sha }));
    const open = prs.find((p) => p.state === "open");
    if (open) {
      const c = await gh(token, `repos/${repo}/commits/${open.sha}/check-runs?per_page=100`).catch(() => null);
      const cr = c?.check_runs || [];
      open.ci = cr.some((x) => ["failure", "timed_out"].includes(x.conclusion)) ? "red" : cr.some((x) => x.status !== "completed") ? "running" : cr.length ? "green" : "none";
    }
    const merged = prs.filter((p) => p.state === "merged").sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
    // squash-merged promotions leave the two branches diverged, so to...from keeps counting commits
    // that already shipped. What is waiting is what the integration branch got since the last
    // promotion's head.
    if (merged[0]?.sha) {
      const since = await gh(token, `repos/${repo}/compare/${merged[0].sha}...${encodeURIComponent(from)}`).catch(() => null);
      if (since && since.status !== "behind") cmp = since;
    }
    const since = Date.now() - WINDOW * 864e5;
    const in30 = merged.filter((p) => Date.parse(p.merged_at) > since);
    const gaps = in30.slice(0, -1).map((p, i) => (Date.parse(p.merged_at) - Date.parse(in30[i + 1].merged_at)) / 36e5).sort((a, b) => a - b);
    const waiting = (cmp?.commits || []).filter((c) => !/^Merge (branch|remote-tracking)/.test(c.commit.message)).reverse().slice(0, 60).map((c) => {
      const msg = c.commit.message.split("\n")[0];
      return { sha: c.sha.slice(0, 7), message: msg, pr: Number((msg.match(/\(#(\d+)\)\s*$/) || [])[1]) || null, author: c.author?.login || c.commit.author?.name || "", at: c.commit.committer?.date || c.commit.author?.date, url: c.html_url };
    });
    const deploys = [];
    for (const r of runs?.workflow_runs || []) if (!deploys.some((x) => x.name === r.name)) deploys.push({ name: r.name, status: r.status, conclusion: r.conclusion, at: r.updated_at, url: r.html_url, sha: r.head_sha?.slice(0, 7) });
    return {
      enabled: true, from, to,
      ahead: cmp?.ahead_by ?? null, behind: cmp?.behind_by ?? null,
      waiting, waiting_prs: [...new Set(waiting.map((w) => w.pr).filter(Boolean))].length,
      oldest_waiting: waiting.length ? waiting.reduce((a, w) => (w.at < a ? w.at : a), waiting[0].at) : null,
      open: open || null,
      history: merged.slice(0, 15),
      last: merged[0] || null,
      count_30d: in30.length,
      median_gap_h: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      deploys: deploys.slice(0, 8),
    };
  });
}

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
// Service names the way Cost Explorer shows them: "Amazon Simple Storage Service" -> "S3"
const SVC_SHORT = [[/simple storage service/i, "S3"], [/elastic container service/i, "Elastic Container Service"], [/relational database service/i, "RDS"], [/simple email service/i, "SES"], [/simple notification service/i, "SNS"], [/simple queue service/i, "SQS"], [/elastic compute cloud - compute/i, "EC2-Instances"], [/^ec2 - other$/i, "EC2-Other"], [/virtual private cloud/i, "VPC"], [/key management service/i, "Key Management Service"], [/^amazon ?cloudwatch$/i, "CloudWatch"], [/^aws ?cloudtrail$|^amazon ?cloudtrail$/i, "CloudTrail"], [/elastic container registry/i, "EC2 Container Registry (ECR)"], [/^aws cost explorer$/i, "Cost Explorer"]];
const svcShort = (n) => (SVC_SHORT.find(([re]) => re.test(n)) || [null, String(n).replace(/^(Amazon|AWS) ?/, "")])[1];
const srcLabel = (k) => ({ aws: "AWS", vercel: "Vercel", neon: "Neon", anthropic: "Anthropic API", "claude-code": "Claude Code", openai: "OpenAI", openrouter: "OpenRouter", fly: "Fly", cloudflare: "Cloudflare", supabase: "Supabase" }[k] || k);
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
  // per service: every breakdown key of every provider (AWS services), plus providers that only
  // report a total as one block each; 30 daily values, last 7 days against the 7 before
  const svc = {};
  const addSvc = (provider, name, d, v) => {
    const k = `${provider}/${name}`;
    const x = (svc[k] ??= { key: k, provider, name, per_day: days.map(() => 0) });
    const i = days.indexOf(d);
    if (i >= 0) x.per_day[i] += v;
  };
  for (const r of providers) {
    if (r.usd == null) continue;
    const parts = r.breakdown && Object.keys(r.breakdown).length ? Object.entries(r.breakdown) : [[srcLabel(r.source), r.usd]];
    for (const [name, v] of parts) addSvc(r.source, name, r.day, Number(v) || 0);
  }
  for (const x of sessions) if (x.usd != null) addSvc("claude-code", "Claude Code sessions", x.day, x.usd);
  const services = Object.values(svc).map((x) => {
    const total = x.per_day.reduce((a, b) => a + b, 0), last7 = x.per_day.slice(-8, -1).reduce((a, b) => a + b, 0), prev7 = x.per_day.slice(-15, -8).reduce((a, b) => a + b, 0);
    return { ...x, per_day: x.per_day.map((v) => Math.round(v * 100) / 100), total: Math.round(total * 100) / 100, last7: Math.round(last7 * 100) / 100, prev7: Math.round(prev7 * 100) / 100, trend: prev7 > 0.5 ? (last7 - prev7) / prev7 : last7 > 0.5 ? 1 : 0 };
  }).filter((x) => x.total >= 0.01).sort((a, b) => b.total - a.total).slice(0, 60);
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
    services,
    days,
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
  const body = JSON.stringify({ name: String(c.name || "").slice(0, 80), models, breakdown, turns: Number(c.turns) || null, secs: Math.max(0, Math.min(86400, Number(c.secs) || 0)) || null, note: String(c.note || "").slice(0, 300) });
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
    // tolerance: what factory.json declares, else what the routine's own schedule implies
    const rt = factory.routines.find((r) => (m.routine && r.name === m.routine) || routineMatch(r)(m.id));
    const silence = m.max_silence_hours || (rt?.cron ? cronMaxGapHours(rt.cron) * 1.25 + 6 : m.cadence === "weekly" ? 200 : 50);
    const vol = (b) => (b?.swept && m.volume_key && m.volume_key in b.swept ? Number(b.swept[m.volume_key]) : null);
    const recent = mine.filter((b) => b.ts >= new Date(Date.now() - 14 * 864e5).toISOString());
    const badShare = recent.length ? recent.filter((b) => b.status !== "ok").length / recent.length : 0;
    const h = last ? (Date.now() - new Date(last.ts)) / 36e5 : null;
    let state = "alive", why = "";
    if (!last) [state, why] = ["silent", "no heartbeat yet: Level 5 has never heard from it"];
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
  return { ...r, last_seen: last, evidence: evidence || "none", next_run: nextRun(r.cron), period_h: cronPeriodHours(r.cron), gap_h: cronMaxGapHours(r.cron) };
}

// The status chart: every skill that runs on a routine, one row each, 30 daily bars (12 weekly
// for weekly skills). A bar is green when the skill ran and read something, yellow when it ran
// but came back degraded or read nothing, red when its routine should have run it and it did not,
// grey when nothing was expected (no schedule, or before the skill's first heartbeat).
// Rows are grouped by the routine that runs them, so a routine's schedule and token cost show once.
const fireOn = (cron, a, b) => { const t = nextRun(cron, new Date(a - 6e4)); return !!t && Date.parse(t) < b; };
const REPORT_NAME = /report|digest|newsletter|growth|marketing/i, REPORT_NOTE = /^(sent|enviado|enviada|mandado) (to|a) /i;
async function readSkills(factory, repoId, monitors, routines, prices) {
  const WEEKS = 12, H = 36e5, GRACE = 6 * H, now = Date.now();
  const since = new Date(now - WEEKS * 7 * 864e5).toISOString();
  const beats = (await db.all("SELECT monitor, ts, status, body FROM heartbeats WHERE repo_id = $1 AND ts >= $2", repoId, since)).map((b) => ({ ...JSON.parse(b.body), monitor: b.monitor, ts: b.ts, status: b.status }));
  const firstRows = await db.all("SELECT monitor, MIN(ts) AS t FROM heartbeats WHERE repo_id = $1 GROUP BY monitor", repoId);
  const first = Object.fromEntries(firstRows.map((r) => [r.monitor, Date.parse(r.t)]));
  const sess = (await db.all("SELECT day, usd, body FROM costs WHERE repo_id = $1 AND source = 'claude-code' AND day >= $2", repoId, since.slice(0, 10))).map((r) => { const b = JSON.parse(r.body); return { name: b.name || "session", day: r.day, usd: r.usd ?? sessionUsd(b.models, prices), tok: Object.values(b.models || {}).reduce((a, t) => a + (t.input || 0) + (t.output || 0) + (t.cache_write_5m || 0) + (t.cache_write_1h || 0) + (t.cache_read || 0), 0), secs: Number(b.secs) || 0 }; });
  const cfg = Object.fromEntries((factory.monitors || []).map((m) => [m.id, m]));
  const cc = routines.filter((r) => r.source === "Claude Code");
  const cmdOf = (r) => ((r.prompt || "").match(/\/([a-z][a-z0-9:_-]*)/) || [])[1] || "";
  const routineFor = (id, mon) => cc.find((r) => mon?.routine && r.name === mon.routine) || cc.find((r) => routineMatch(r)(id));

  const day0 = new Date(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  const fmt = (t) => new Date(t).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
  const usdIn = (names, a, b) => sess.filter((x) => names.includes(x.name) && x.usd != null && Date.parse(x.day + "T12:00:00Z") >= a && Date.parse(x.day + "T12:00:00Z") < b).reduce((s, x) => s + x.usd, 0);

  const ids = monitors.filter((m) => m.state !== "retired").map((m) => m.id);
  for (const b of beats) if (!ids.includes(b.monitor) && cc.some((r) => routineMatch(r)(b.monitor)) && !monitors.some((m) => m.id === b.monitor)) ids.push(b.monitor);

  const row = (id) => {
    const mon = monitors.find((m) => m.id === id), c = cfg[id] || {}, routine = routineFor(id, mon);
    const weekly = (mon?.cadence || c.cadence) === "weekly" || (!!routine && cronPeriodHours(routine.cron) >= 24 * 6);
    const mine = beats.filter((b) => b.monitor === id);
    const own = mine.some((b) => b.source !== "session") ? mine.filter((b) => b.source !== "session") : mine;
    const vol = (b) => (b.swept && c.volume_key && c.volume_key in b.swept ? Number(b.swept[c.volume_key]) : null);
    const start = first[id] ?? Infinity;
    const declared = !!routine || (!!mon && !mon.unlisted);
    const span = weekly ? 7 * 864e5 : 864e5, n = weekly ? WEEKS : WINDOW;
    const buckets = [...Array(n)].map((_, i) => {
      const b = weekly ? now - (n - 1 - i) * span : day0 + (i - (n - 1)) * span, a = b - (weekly ? span : 0), end = weekly ? b : b + span;
      const lo = weekly ? a : b, hi = end;
      const runs = own.filter((x) => { const t = Date.parse(x.ts); return t >= lo && t < hi; });
      const label = weekly ? `Week to ${fmt(hi - 1)}` : fmt(lo);
      const v = runs.map(vol).filter((x) => x != null);
      const cost = routine ? usdIn([cmdOf(routine)], lo, hi) : usdIn([id], lo, hi);
      let s = "";
      if (runs.length) {
        const bad = runs.find((x) => x.status !== "ok");
        const empty = runs.every((x) => x.status === "ok" && vol(x) === 0) && !c.zero_ok;
        s = bad ? "warn" : empty ? "empty" : "ok";
        return { s, label, runs: runs.length, read: v.length ? Math.max(...v) : null, note: (bad?.note || runs[0].note || "").slice(0, 140), status: bad?.status || "ok", usd: cost };
      }
      // nothing arrived: was something expected?
      if (declared && hi > start) {
        const due = routine ? fireOn(routine.cron, Math.max(lo, start), Math.min(hi, now - GRACE)) : !weekly && hi <= now;
        if (due) s = "miss";
      }
      return { s, label, runs: 0, read: null, note: "", status: "", usd: cost };
    });
    const due = buckets.filter((x) => x.s);
    // judged on the last run that was due, not on today's bar: after midnight UTC today has nothing due yet
    const missedLast = due.at(-1)?.s === "miss";
    const last = own.map((x) => x.ts).sort().pop() || null;
    const lastVol = own.length ? vol(own.reduce((a, x) => (x.ts > a.ts ? x : a))) : null;
    return {
      id, weekly, routine: routine?.name || "", unit: c.volume_key || "",
      state: mon && mon.state === "alive" && missedLast ? "late" : mon ? mon.state : !own.length ? "silent" : missedLast ? "dead" : "alive",
      why: mon?.why || "",
      buckets, last, read: lastVol,
      on_time: due.length ? Math.round((due.filter((x) => x.s === "ok").length / due.length) * 1000) / 10 : null,
      misses: buckets.filter((x) => x.s === "miss").length,
    };
  };
  const rows = ids.map(row);
  // routines that run skills Level 5 has never heard from still get a row: you should see them
  for (const r of cc) if (!rows.some((x) => x.routine === r.name)) rows.push({ id: cmdOf(r) || r.name.replace(/^App: /, ""), weekly: cronPeriodHours(r.cron) >= 24 * 6, routine: r.name, unit: "", state: "silent", why: "no heartbeat from this routine yet", buckets: [...Array(cronPeriodHours(r.cron) >= 24 * 6 ? WEEKS : WINDOW)].map(() => ({ s: "", label: "", runs: 0 })), last: null, read: null, on_time: null, misses: 0 });
  const groups = [];
  for (const r of cc) {
    const mine = rows.filter((x) => x.routine === r.name);
    if (mine.length) groups.push({ name: r.name.replace(/^App: /, ""), cron: r.cron, cmd: cmdOf(r), prompt: r.prompt, next_run: r.next_run, usd_30d: usdIn([cmdOf(r)], now - WINDOW * 864e5, now + 864e5), rows: mine });
  }
  // the ones that need a look first, routines that never reported last
  const rank = (g) => (g.rows.every((x) => x.state === "silent") ? 2 : g.rows.some((x) => ["dead", "degraded", "lying", "warn", "late"].includes(x.state)) ? 0 : 1);
  groups.sort((a, b) => rank(a) - rank(b));
  const loose = rows.filter((x) => !x.routine);
  if (loose.length) groups.push({ name: "Other", cron: "", cmd: "", prompt: "", next_run: null, usd_30d: usdIn(loose.map((x) => x.id), now - WINDOW * 864e5, now + 864e5), rows: loose });
  // per routine, not per skill: any heartbeat from the routine's session or its skills counts as a run
  const hist = {};
  for (const r of cc) {
    const weekly = cronPeriodHours(r.cron) >= 24 * 6, n = weekly ? WEEKS : WINDOW, span = weekly ? 7 * 864e5 : 864e5;
    const skillIds = rows.filter((x) => x.routine === r.name).map((x) => x.id), cmd = cmdOf(r), match = routineMatch(r);
    const mine = beats.filter((b) => skillIds.includes(b.monitor) || match(b.monitor)).map((b) => Date.parse(b.ts));
    const start = Math.min(...mine, Infinity);
    const buckets = [...Array(n)].map((_, i) => {
      const hi = weekly ? now - (n - 1 - i) * span : day0 + (i - (n - 2)) * span, lo = hi - span;
      const runs = mine.filter((t) => t >= lo && t < hi).length, usd = cmd ? usdIn([cmd], lo, hi) : 0;
      const label = weekly ? `Week to ${fmt(hi - 1)}` : fmt(lo);
      const s = runs ? "ok" : hi > start && fireOn(r.cron, Math.max(lo, start), Math.min(hi, now - GRACE)) ? "miss" : "";
      return { s, label, runs, usd };
    });
    const runs30 = beats.filter((b) => (skillIds.includes(b.monitor) || match(b.monitor)) && b.source === "session" && Date.parse(b.ts) >= now - WINDOW * 864e5).length;
    const usd30 = cmd ? usdIn([cmd], now - WINDOW * 864e5, now + 864e5) : 0;
    hist[r.name] = { weekly, buckets, skills: skillIds, usd_30d: usd30, usd_run: runs30 && usd30 ? usd30 / runs30 : null };
  }
  const dates = [...Array(WINDOW)].map((_, i) => new Date(day0 + (i - (WINDOW - 1)) * 864e5).toISOString().slice(0, 10));
  const daily = { dates, routines: cc.map((r) => {
    const cmd = cmdOf(r), match = routineMatch(r), skillIds = hist[r.name]?.skills || [];
    const mine = beats.filter((b) => skillIds.includes(b.monitor) || match(b.monitor));
    const on = (d) => sess.filter((x) => x.name === cmd && x.day === d);
    return { name: r.name.replace(/^App: /, ""), cron: r.cron, tokens: dates.map((d) => on(d).reduce((a, x) => a + x.tok, 0)), usd: dates.map((d) => on(d).reduce((a, x) => a + (x.usd || 0), 0)), secs: dates.map((d) => on(d).reduce((a, x) => a + x.secs, 0)), runs: dates.map((d) => { const today = mine.filter((b) => b.ts.slice(0, 10) === d); return Math.max(today.filter((b) => b.source === "session").length, today.length ? 1 : 0); }) };
  }) };
  // Reports: a skill that sends one. Its name says so, it posted a report or its email (the body),
  // or its heartbeat says it sent it. A weekly audit or monitor is not a report. Runs newest first.
  const bodies = Object.fromEntries((await db.all("SELECT monitor, at, title FROM report_bodies WHERE repo_id = $1", repoId)).map((x) => [x.monitor, { at: x.at, title: x.title }]));
  const sentOne = (id) => REPORT_NAME.test(id) || bodies[id] || beats.some((b) => b.monitor === id && (b.report || REPORT_NOTE.test(b.note || "")));
  const reportIds = [...new Set([...rows.map((x) => x.id), ...beats.map((b) => b.monitor), ...Object.keys(bodies)])].filter(sentOne);
  const reports = reportIds.map((id) => {
    const r = rows.find((x) => x.id === id), mine = beats.filter((b) => b.monitor === id && b.source !== "session").sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return { id, routine: r?.routine || "", state: r?.state || "alive", buckets: r?.weekly ? r.buckets || [] : [], body: bodies[id] || null, items: mine.slice(0, 12).map((b) => ({ ts: b.ts, status: b.status, note: b.note || "", swept: b.swept || {}, filed: b.filed || [], title: b.title || "", report: b.report || "" })) };
  });
  return { routines: hist, daily, reports, groups, usd_30d: sess.filter((x) => x.usd != null && Date.parse(x.day + "T12:00:00Z") >= now - WINDOW * 864e5).reduce((a, x) => a + x.usd, 0), sessions_30d: sess.length };
}


// Automations: each routine is one object, stored with its own state, cost, tokens and runs.
// A run is put together from whatever it left behind: the session-end heartbeat, its skills'
// heartbeats, the Claude Code cost row of that session, or the GitHub Actions run. Rebuilt on
// every refresh and persisted, so the history outlives the 84 days of heartbeats read here.
const autoKey = (name) => name.replace(/^App: /, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "routine";
async function syncAutomations(repoRow, factory, routines, status, token, repo) {
  const id = repoRow.id, now = Date.now(), since = new Date(now - 84 * 864e5).toISOString(), d30 = now - WINDOW * 864e5;
  const beats = (await db.all("SELECT monitor, ts, status, body FROM heartbeats WHERE repo_id = $1 AND ts >= $2 ORDER BY ts", id, since)).map((b) => ({ ...JSON.parse(b.body), monitor: b.monitor, ts: b.ts, status: b.status }));
  const tokOf = (m) => Object.values(m || {}).reduce((a, t) => a + (t.input || 0) + (t.output || 0) + (t.cache_write_5m || 0) + (t.cache_write_1h || 0) + (t.cache_read || 0), 0);
  const costs = (await db.all("SELECT key, day, usd, body, at FROM costs WHERE repo_id = $1 AND source = 'claude-code' AND day >= $2", id, since.slice(0, 10))).map((r) => { const b = JSON.parse(r.body); return { key: r.key, name: b.name || "", at: r.at, usd: r.usd ?? sessionUsd(b.models, factory.prices), tok: tokOf(b.models), secs: Number(b.secs) || 0 }; });
  const cmdOf = (r) => ((r.prompt || "").match(/\/([a-z][a-z0-9:_-]*)/) || [])[1] || "";
  const out = [];
  for (const r of routines) {
    const key = autoKey(r.name), cmd = cmdOf(r), skills = status?.routines?.[r.name]?.skills || [];
    let runs = [];
    if (r.source === "GitHub Actions") {
      const file = (r.prompt || "").split("/").pop();
      const list = await cached(`autoruns:${repo}:${file}`, 10 * 60e3, () => gh(token, `repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=40`).catch(() => null));
      runs = (list?.workflow_runs || []).filter((x) => x.status === "completed").map((x) => {
        const start = x.run_started_at || x.created_at;
        return { at: start, status: x.conclusion === "success" ? "ok" : x.conclusion === "failure" || x.conclusion === "timed_out" ? "failed" : String(x.conclusion || "unknown"), origin: `GitHub Actions (${x.event})`, tokens: null, usd: null, secs: Math.max(0, Math.round((Date.parse(x.updated_at) - Date.parse(start)) / 1000)), note: x.display_title || "", url: x.html_url || "", dedupe: `gh:${x.id}` };
      });
    } else {
      const match = routineMatch(r), mine = beats.filter((b) => skills.includes(b.monitor) || match(b.monitor));
      const clusters = [];
      for (const b of mine) { const t = Date.parse(b.ts), c = clusters.at(-1); if (c && t - c.last < 3 * 36e5) { c.beats.push(b); c.last = t; } else clusters.push({ first: t, last: t, beats: [b] }); }
      runs = clusters.map((c) => {
        const sk = c.beats.filter((b) => b.source !== "session"), bad = sk.filter((b) => b.status !== "ok"), sess = c.beats.some((b) => b.source === "session");
        const cs = costs.filter((x) => cmd && x.name === cmd && Math.abs(Date.parse(x.at) - c.last) < 4 * 36e5);
        const sum = (k) => (cs.length ? cs.reduce((a, x) => a + (x[k] || 0), 0) : null);
        return { at: new Date(c.first).toISOString(), status: bad.length ? "degraded" : "ok", origin: sess && sk.length ? "session + skills" : sess ? "session" : "skills",
          tokens: sum("tok"), usd: sum("usd"), secs: sum("secs"),
          note: bad.length ? `${bad.length} of ${sk.length} skills degraded: ${bad.map((b) => b.monitor).join(", ")}` : sk.length ? `${sk.length} skill${sk.length === 1 ? "" : "s"} reported ok` : (c.beats[0].note || "session ended"),
          url: "", dedupe: `cc:${c.beats[0].ts}` };
      });
    }
    // state, from the schedule's own buckets (missed = due and nothing arrived)
    const b = status?.routines?.[r.name]?.buckets || [], due = b.filter((x) => x.s), last = runs.map((x) => x.at).sort().pop() || r.last_seen || null;
    const missed = b.filter((x) => x.s === "miss").length, lastRun = runs.slice().sort((x, y) => (x.at < y.at ? 1 : -1))[0];
    const [state, why] = !runs.length && !due.some((x) => x.s === "ok") ? ["not reporting", "no run of it has reached Level 5"] : due.at(-1)?.s === "miss" ? ["missed", "the last scheduled run did not happen"] : lastRun && lastRun.status !== "ok" ? ["degraded", lastRun.note || `last run ${lastRun.status}`] : ["on schedule", due.length ? `${Math.round(((due.length - missed) / due.length) * 100)}% on time` : ""];
    const in30 = runs.filter((x) => Date.parse(x.at) >= d30), s30 = (k) => in30.reduce((a, x) => a + (x[k] || 0), 0);
    const row = { repo_id: id, key, name: r.name.replace(/^App: /, ""), source: r.source, cron: r.cron, command: r.source === "GitHub Actions" ? r.prompt : cmd ? `/${cmd}` : "", model: r.model || "", skills: JSON.stringify(skills), state, state_why: why, last_run_at: last, next_run_at: r.next_run || null, runs_30d: in30.length, missed_30d: missed, tokens_30d: s30("tokens"), usd_30d: Math.round(s30("usd") * 100) / 100, secs_30d: s30("secs"), updated_at: new Date().toISOString() };
    await db.run(`INSERT INTO automations (repo_id, key, name, source, cron, command, model, skills, state, state_why, last_run_at, next_run_at, runs_30d, missed_30d, tokens_30d, usd_30d, secs_30d, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT(repo_id, key) DO UPDATE SET name = excluded.name, source = excluded.source, cron = excluded.cron, command = excluded.command, model = excluded.model, skills = excluded.skills, state = excluded.state, state_why = excluded.state_why, last_run_at = excluded.last_run_at, next_run_at = excluded.next_run_at, runs_30d = excluded.runs_30d, missed_30d = excluded.missed_30d, tokens_30d = excluded.tokens_30d, usd_30d = excluded.usd_30d, secs_30d = excluded.secs_30d, updated_at = excluded.updated_at`,
      ...Object.values(row));
    const a = await db.one("SELECT id FROM automations WHERE repo_id = $1 AND key = $2", id, key);
    for (const x of runs) await db.run(`INSERT INTO automation_runs (automation_id, repo_id, at, status, origin, tokens, usd, secs, note, url, dedupe) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT(automation_id, dedupe) DO UPDATE SET status = excluded.status, origin = excluded.origin, tokens = excluded.tokens, usd = excluded.usd, secs = excluded.secs, note = excluded.note`,
      a.id, id, x.at, x.status, x.origin, x.tokens, x.usd, x.secs, String(x.note).slice(0, 500), x.url, x.dedupe);
    const recent = await db.all("SELECT at, status, origin, tokens, usd, secs, note, url FROM automation_runs WHERE automation_id = $1 ORDER BY at DESC LIMIT 25", a.id);
    out.push({ id: Number(a.id), ...row, skills, buckets: b, weekly: !!status?.routines?.[r.name]?.weekly, routine: r.name, runs: recent });
  }
  return out;
}

async function snapshot(repoRow) {
  const repo = repoRow.full_name;
  const token = await installationToken(repoRow.installation_id);
  const [factory, queue] = await Promise.all([readFactory(token, repo), readQueue(token, repo)]);
  const [ci, promotions] = await Promise.all([readCi(token, repo, factory.workflows || []), readPromotions(token, repo, factory.promotion, factory.meta.default_branch).catch(() => null)]);
  const metrics = await readMetrics(token, repo, ci, queue.issues);
  const { monitors, beats, sessions } = await judge(factory, repoRow.id);
  const routines = factory.routines.map((r) => routineState(r, monitors, queue.merged, sessions));
  const skills = await readSkills(factory, repoRow.id, monitors, routines, factory.prices);
  const runsByName = Object.fromEntries(queue.runs.map((r) => [r.name, r]));
  for (const r of routines) if (r.source === "GitHub Actions" && runsByName[r.name]) [r.last_seen, r.evidence] = [runsByName[r.name].at, "Actions run"];
  for (const r of routines) {
    const w = r.source === "GitHub Actions" && (ci || []).find((x) => x.path === r.prompt || x.name === r.name);
    if (!w) continue;
    const first = w.days.findIndex(Boolean);
    skills.routines[r.name] = { weekly: false, actions: true, skills: [], usd_30d: 0, usd_run: null, buckets: w.days.slice(-WINDOW).map((d, i, all) => {
      const t = w.tips[w.tips.length - all.length + i] || {}, lo = Date.now() - (all.length - i) * 864e5;
      return { s: d === "ok" ? "ok" : d ? "warn" : first >= 0 && i > first && i < all.length - 1 && cronPeriodHours(r.cron) <= 24 ? "miss" : "", label: new Date(lo + 864e5).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" }), runs: (t.ok || 0) + (t.bad || 0), failed: t.bad || 0 };
    }) };
    if (!r.last_seen && w.last) [r.last_seen, r.evidence] = [w.last.at, "Actions run"];
  }
  const automations = await syncAutomations(repoRow, factory, routines, skills, token, repo).catch((e) => (console.error("automations:", e.message), []));
  const bad = monitors.filter((m) => ["dead", "lying", "degraded"].includes(m.state));
  const warn = monitors.filter((m) => m.state === "warn");
  const lateRoutines = routines.filter((r) => r.last_seen && (Date.now() - new Date(r.last_seen)) / 36e5 > (r.gap_h || r.period_h) * 1.25 + 2);
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
    status: skills,
    automations,
    ci,
    metrics,
    costs: await readCosts(repoRow.id, factory.prices),
    security: await readSecurity(repoRow.id),
    marketing: await readMarketing(repoRow.id),
    promotions,
    rules: await evalRules(repoRow.id, { fire: true, prices: factory.prices }),
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
        const prev = await db.one("SELECT body FROM snapshots WHERE repo_id = $1", row.id);
        if (prev) await recordEvents(row.id, JSON.parse(prev.body), s).catch((e) => console.error("events:", e.message));
        await db.run("INSERT INTO snapshots (repo_id, at, body) VALUES ($1, $2, $3) ON CONFLICT(repo_id) DO UPDATE SET at = excluded.at, body = excluded.body", row.id, Date.now(), JSON.stringify(s));
        return s;
      })
      .finally(() => inflight.delete(row.id));
    inflight.set(row.id, p);
  }
  return inflight.get(row.id);
}
const FRESH_MS = 60e3;

// --- notifications ------------------------------------------------------------------------
// Events come from comparing a repo's new snapshot with the one before it, so they need no extra
// GitHub reads. Each has a dedupe key: the same change is never recorded twice.
const MON_LABEL = { alive: "is operational again", warn: "is degraded", degraded: "is chronically degraded", lying: "said ok but read nothing", dead: "is down", retired: "was retired" };
function diffEvents(prev, s) {
  const out = [];
  const add = (level, kind, title, detail, entity, dedupe) => out.push({ level, kind, title, detail: detail || "", entity: entity || "", dedupe });
  const pm = Object.fromEntries((prev.monitors || []).map((m) => [m.id, m]));
  for (const m of s.monitors || []) {
    const p = pm[m.id];
    if (!p || p.state === m.state || m.state === "retired") continue;
    const level = m.state === "alive" ? "ok" : m.state === "warn" ? "warn" : "bad";
    add(level, "monitor", `${m.id} ${MON_LABEL[m.state] || m.state}`, m.why || m.last?.note || "", `monitor:${m.id}`, `mon:${m.id}:${m.state}:${m.last?.ts || ""}`);
  }
  const late = (r) => r.last_seen && (Date.now() - new Date(r.last_seen)) / 36e5 > r.period_h * 1.25 + 2;
  const pr = Object.fromEntries((prev.routines || []).map((r) => [r.name, r]));
  for (const r of s.routines || []) {
    const p = pr[r.name];
    if (!p) continue;
    const name = r.name.replace(/^App: /, "");
    if (late(r) && !late(p)) add("bad", "routine", `${name} is late`, `Last run ${r.last_seen}. Expected every ${Math.round(r.period_h)} h.`, `routine:${encodeURIComponent(r.name)}`, `late:${r.name}:${r.last_seen}`);
    if (!late(r) && late(p)) add("ok", "routine", `${name} ran again`, "", `routine:${encodeURIComponent(r.name)}`, `ontime:${r.name}:${r.last_seen}`);
  }
  const pw = Object.fromEntries((prev.ci || []).map((w) => [w.path, w]));
  for (const w of s.ci || []) {
    const p = pw[w.path], c = w.last?.status === "completed" ? w.last.conclusion : null, pc = p?.last?.status === "completed" ? p.last.conclusion : null;
    if (!p || !c || c === pc || !w.last?.at) continue;
    if (c === "failure") add("bad", "ci", `${w.name} is failing`, `On ${w.last.branch}.`, `workflow:${encodeURIComponent(w.path)}`, `ci:${w.path}:${w.last.at}`);
    else if (c === "success" && pc === "failure") add("ok", "ci", `${w.name} is passing again`, `On ${w.last.branch}.`, `workflow:${encodeURIComponent(w.path)}`, `ci:${w.path}:${w.last.at}`);
  }
  const agent = (b) => AGENT_BRANCH.test(b || "");
  const prevOpen = new Set((prev.queue?.prs || []).map((x) => x.number)), prevMerged = new Set((prev.queue?.merged || []).map((x) => x.number)), prevIssues = new Set((prev.queue?.issues || []).map((x) => x.number));
  for (const x of s.queue?.prs || []) if (!prevOpen.has(x.number)) add("info", "pr", `${agent(x.branch) ? "An agent opened" : `${x.author || "Someone"} opened`} PR #${x.number}`, x.title, `pr:${x.number}`, `pr-open:${x.number}`);
  for (const x of s.queue?.merged || []) if (!prevMerged.has(x.number)) add("info", "pr", `PR #${x.number} merged${agent(x.branch) ? " (agent)" : ""}`, x.title, `pr:${x.number}`, `pr-merged:${x.number}`);
  const pp = prev.promotions, np = s.promotions;
  if (pp?.enabled && np?.enabled) {
    const seenPromo = new Set((pp.history || []).map((x) => x.number));
    for (const x of np.history || []) if (!seenPromo.has(x.number)) add("ok", "promotion", `Promoted ${np.from} → ${np.to} (#${x.number})`, x.title, `pr:${x.number}`, `promo-merged:${x.number}`);
    if (np.open && np.open.number !== pp.open?.number) add("info", "promotion", `Promotion opened: #${np.open.number}`, `${np.ahead ?? "?"} commits from ${np.from} waiting for ${np.to}.`, `pr:${np.open.number}`, `promo-open:${np.open.number}`);
  }
  for (const x of s.queue?.issues || []) if (!prevIssues.has(x.number)) add(x.labels?.includes("risky") ? "warn" : "info", "issue", `Issue #${x.number} opened`, x.title, `issue:${x.number}`, `issue:${x.number}`);
  const pf = new Set((prev.security?.findings || []).map((f) => f.id));
  if (prev.security) for (const f of s.security?.findings || []) if (!pf.has(f.id) && SEV[f.sev] <= 1) add(f.sev === "critical" ? "bad" : "warn", "security", f.title, f.detail, "", `sec:${f.id}`);
  const C = s.costs;
  if (C && C.yesterday > 5 && C.avg7 > 0 && C.yesterday > C.avg7 * 1.5) {
    const day = C.per_day[C.per_day.length - 2]?.d;
    add("warn", "cost", `Spend jumped to $${C.yesterday.toFixed(2)}`, `${(C.yesterday / C.avg7).toFixed(1)}× the 7-day average of $${C.avg7.toFixed(2)}.`, "", `cost-spike:${day}`);
  }
  return out;
}
// --- price rules: cost alarms ------------------------------------------------------------
// A rule measures one number over one period and fires a notification when it crosses its limit:
//   source   any | aws | vercel | neon | claude-code | ...      which cost rows count
//   measure  usd | tokens | session_tokens                      spend, Claude Code tokens, or one session's tokens
//   period   day | week | month | forecast | session            last day with data, rolling 7 days,
//                                                               month to date, month-end projection, each session
//   cond     above | spike                                      over `amount`, or `pct`% over the average of
//                                                               the `days` days before the window
//   service  substring of a breakdown key (AWS service), optional
//   dow      [0..6] days of the week it applies to (UTC, Sunday = 0); empty = every day
//   from/to  dates it is active, optional;  severity  warn | bad
// It fires at most once per period (dedupe key per rule and period).
const RULE_DEFAULT = { source: "any", measure: "usd", period: "day", cond: "above", amount: 50, pct: 50, days: 7, service: "", dow: [], from: "", to: "", severity: "warn" };
function ruleConfig(raw) {
  const c = { ...RULE_DEFAULT, ...(raw || {}) };
  c.source = String(c.source).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40) || "any";
  c.measure = ["usd", "tokens", "session_tokens"].includes(c.measure) ? c.measure : "usd";
  c.period = c.measure === "session_tokens" ? "session" : ["day", "week", "month", "forecast"].includes(c.period) ? c.period : "day";
  c.cond = c.period === "session" || c.period === "forecast" ? "above" : c.cond === "spike" ? "spike" : "above";
  c.amount = Math.max(0, Number(c.amount) || 0);
  c.pct = Math.max(1, Math.min(1000, Number(c.pct) || 50));
  c.days = Math.max(1, Math.min(60, Math.round(Number(c.days) || 7)));
  c.service = String(c.service || "").slice(0, 80);
  c.dow = (Array.isArray(c.dow) ? c.dow : []).map(Number).filter((d) => d >= 0 && d <= 6);
  c.from = /^\d{4}-\d{2}-\d{2}$/.test(c.from) ? c.from : "";
  c.to = /^\d{4}-\d{2}-\d{2}$/.test(c.to) ? c.to : "";
  c.severity = c.severity === "bad" ? "bad" : "warn";
  return c;
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function ruleSummary(c) {
  const who = c.measure !== "usd" ? "Claude Code" : c.source === "any" ? "total" : c.source === "claude-code" ? "Claude Code" : c.source.length <= 4 ? c.source.toUpperCase() : c.source;
  const svc = c.service && c.measure === "usd" ? ` ${c.service}` : "";
  const lim = c.cond === "spike" ? `${c.pct}% above ${c.measure === "usd" ? "its" : "their"} ${c.days}-day average` : c.measure === "usd" ? `$${Number(c.amount).toLocaleString("en-US")}` : `${Number(c.amount).toLocaleString("en-US")} tokens`;
  const dk = [...c.dow].sort().join("");
  const days = !c.dow.length || c.dow.length === 7 ? "" : dk === "12345" ? ", on weekdays" : dk === "06" ? ", on weekends" : `, on ${c.dow.map((d) => DOW[d]).join(", ")}`;
  const verb = c.measure === "usd" ? "goes" : "go";
  const dates = c.from || c.to ? `, ${c.from ? `from ${c.from}` : ""}${c.from && c.to ? " " : ""}${c.to ? `until ${c.to}` : ""}` : "";
  const what = c.measure === "session_tokens" ? `a single Claude Code session uses more than ${lim}`
    : c.period === "forecast" ? `the month-end forecast for ${who}${svc} spend goes over ${lim}`
    : `${who}${svc} ${c.measure === "usd" ? "spend" : "tokens"} ${verb} ${c.cond === "spike" ? lim : `over ${lim}`} ${c.cond === "spike" ? "" : { day: "in a day", week: "over 7 days", month: "this month" }[c.period] || ""}`.trim();
  return `When ${what}${days}${dates}${c.severity === "bad" ? " (critical)" : ""}`;
}
// A sentence ("tell me if AWS goes over $50 a day on weekdays") becomes a rule. The model only fills
// the config above; ruleConfig() still validates every field, so it cannot write anything else.
async function ruleFromText(text, { sources = [], services = [] } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("rules from a sentence need OPENROUTER_API_KEY");
  const system = `Turn a request for a cost alarm into JSON: {"name": short title, "config": {...}}. Config fields:
source: "any" or one of ${JSON.stringify(sources)}; measure: "usd" | "tokens" (Claude Code tokens) | "session_tokens" (one session's tokens);
period: "day" | "week" (rolling 7 days) | "month" (month to date) | "forecast" (month-end projection); cond: "above" (over amount) | "spike" (pct% over the average of the previous days);
amount: number (dollars, or tokens); pct: number; days: number; service: substring of a service name or "" (known: ${JSON.stringify(services.slice(0, 40))});
dow: array of weekday numbers it applies to, Sunday=0, [] = every day; from/to: "YYYY-MM-DD" or ""; severity: "warn" | "bad" (urgent, critical).
Weekdays = [1,2,3,4,5]. Today is ${new Date().toISOString().slice(0, 10)}. Answer with the JSON object only.`;
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Level 5" }, body: JSON.stringify({ model: ASK_MODEL, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: String(text).slice(0, 500) }] }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`the model did not answer (${r.status})`);
  const out = (await r.json()).choices?.[0]?.message?.content || "";
  const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ["{}"])[0]);
  const config = ruleConfig(j.config || j);
  return { name: String(j.name || ruleSummary(config)).trim().slice(0, 80), config };
}

// value of a cost row for this rule: dollars (optionally one service) or tokens
function rowValue(r, c) {
  if (c.measure === "usd") {
    if (r.source === "claude-code") return r.usd ?? null;
    if (!c.service) return r.usd;
    if (!r.breakdown) return 0;
    return Object.entries(r.breakdown).filter(([k]) => k.toLowerCase().includes(c.service.toLowerCase())).reduce((a, [, v]) => a + v, 0);
  }
  if (r.source !== "claude-code") return null;
  return Object.values(r.models || {}).reduce((a, t) => a + (t.input || 0) + (t.output || 0) + (t.cache_write_5m || 0) + (t.cache_write_1h || 0) + (t.cache_read || 0), 0);
}
async function evalRules(repoId, { fire = false, prices = {} } = {}) {
  const rules = await db.all("SELECT * FROM price_rules WHERE repo_id = $1 ORDER BY id", repoId);
  if (!rules.length) return [];
  const since = new Date(Date.now() - 70 * 864e5).toISOString().slice(0, 10);
  const rows = (await db.all("SELECT source, key, day, usd, body, at FROM costs WHERE repo_id = $1 AND day >= $2", repoId, since)).map((r) => {
    const b = JSON.parse(r.body);
    return { ...r, ...b, usd: r.usd ?? (r.source === "claude-code" ? sessionUsd(b.models, prices) : null) };
  });
  const today = new Date().toISOString().slice(0, 10);
  const dayAdd = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const out = [];
  for (const rule of rules) {
    const c = ruleConfig(JSON.parse(rule.config));
    const mine = rows.filter((r) => (c.source === "any" || r.source === c.source) && rowValue(r, c) != null);
    const sumDays = (a, b) => mine.filter((r) => r.day >= a && r.day <= b).reduce((t, r) => t + (rowValue(r, c) || 0), 0);
    const lastDay = mine.map((r) => r.day).sort().pop() || today;
    let value = 0, limit = c.amount, ref = lastDay, key = lastDay, hits = [];
    if (c.period === "session") {
      const recent = mine.filter((r) => r.source === "claude-code" && r.day >= dayAdd(today, -2));
      value = Math.max(0, ...recent.map((r) => rowValue(r, c)));
      hits = recent.filter((r) => rowValue(r, c) > c.amount).map((r) => ({ key: r.key, value: rowValue(r, c), day: r.day, name: r.name }));
    } else {
      const len = { day: 1, week: 7, month: 0, forecast: 0 }[c.period];
      let a, b = lastDay;
      if (c.period === "day" || c.period === "week") { a = dayAdd(b, 1 - len); key = c.period === "day" ? b : `${a}..${b}`; }
      else { a = today.slice(0, 8) + "01"; b = today; key = today.slice(0, 7); ref = today; }
      value = sumDays(a, b);
      if (c.period === "forecast") {
        const d = new Date(), dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(), elapsed = Math.max(1, Number(lastDay.slice(8, 10)) || d.getUTCDate());
        value = (value / elapsed) * dim;
      }
      if (c.cond === "spike") {
        const base = sumDays(dayAdd(a, -c.days), dayAdd(a, -1)) / c.days * (len || 1);
        limit = base * (1 + c.pct / 100);
        if (!base) limit = Infinity;
      }
      if (value > limit) hits = [{ key, value, day: ref }];
    }
    const active = !!rule.enabled && (!c.from || ref >= c.from) && (!c.to || ref <= c.to);
    const dowOk = (d) => !c.dow.length || c.dow.includes(new Date(d + "T12:00:00Z").getUTCDay());
    const firing = active ? hits.filter((h) => dowOk(h.day)) : [];
    const fmt = (v) => (c.measure === "usd" ? `$${v.toFixed(2)}` : `${Math.round(v).toLocaleString("en-US")} tokens`);
    if (fire) for (const h of firing) {
      const r = await db.one("SELECT 1 AS x FROM events WHERE repo_id = $1 AND dedupe = $2", repoId, `rule:${rule.id}:${h.key}`);
      if (r) continue;
      await db.run("INSERT INTO events (repo_id, at, level, kind, title, detail, entity, dedupe) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (repo_id, dedupe) DO NOTHING", repoId, new Date().toISOString(), c.severity, "cost", `${rule.name}: ${fmt(h.value)}`.slice(0, 200), `${ruleSummary(c)}.${h.name ? ` Session /${h.name}.` : ""}${Number.isFinite(limit) && c.cond === "spike" ? ` Limit today ${fmt(limit)}.` : ""}`.slice(0, 400), `rule:${rule.id}`, `rule:${rule.id}:${h.key}`);
      await db.run("UPDATE price_rules SET last_fired_at = $1 WHERE id = $2", new Date().toISOString(), rule.id);
    }
    out.push({ id: Number(rule.id), name: rule.name, enabled: !!rule.enabled, config: c, summary: ruleSummary(c), value, limit: Number.isFinite(limit) ? limit : null, over: value > limit, active, firing: firing.length > 0, last_fired_at: rule.last_fired_at, period_key: key });
  }
  return out;
}

// --- security inventory ------------------------------------------------------------------
// Sent by scripts/security-inventory.mjs. Only names and metadata are accepted: every field is
// copied by name and length-limited, secret names must look like names, and nothing else is kept.
const str = (x, n = 200) => (x == null ? null : String(x).slice(0, n));
const strs = (a, n = 50, m = 200) => (Array.isArray(a) ? a.slice(0, n).map((x) => str(x, m)) : []);
function cleanInventory(kind, d) {
  if (kind === "aws-iam") {
    const keys = (k) => (Array.isArray(k) ? k.slice(0, 2).map((x) => ({ created: str(x?.created, 40), last_used: str(x?.last_used, 40), service: str(x?.service, 60) })) : []);
    return {
      account: str(d.account, 20), caller: str(d.caller, 200),
      root: d.root ? { mfa: !!d.root.mfa, keys: keys(d.root.keys), password_last_used: str(d.root.password_last_used, 40) } : null,
      users: (d.users || []).slice(0, 500).map((u) => ({ name: str(u.name, 128), arn: str(u.arn), created: str(u.created, 40), console: !!u.console, password_last_used: str(u.password_last_used, 40), mfa: !!u.mfa, keys: keys(u.keys), policies: strs(u.policies), groups: strs(u.groups) })),
      roles: (d.roles || []).slice(0, 1500).map((r) => ({ name: str(r.name, 128), path: str(r.path, 128), created: str(r.created, 40), last_used: str(r.last_used, 40), last_region: str(r.last_region, 30), trusted: strs(r.trusted, 20), service_linked: !!r.service_linked, policies: strs(r.policies), description: str(r.description) })),
    };
  }
  if (kind === "infisical") {
    const NAME = /^[A-Za-z0-9_.\-]{1,128}$/;
    return { project: str(d.project, 60), environments: strs(d.environments, 10, 40), folders: (d.folders || []).slice(0, 300).map((f) => ({ env: str(f.env, 40), path: str(f.path, 200), keys: (f.keys || []).slice(0, 3000).map(String).filter((k) => NAME.test(k)) })) };
  }
  throw new Error("kind must be aws-iam or infisical");
}
const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
function securityFindings(awsInv, inf) {
  const out = [];
  const days = (d) => (d ? (Date.now() - Date.parse(d)) / 864e5 : null);
  const add = (sev, title, detail, id) => out.push({ sev, title, detail: detail || "", id });
  if (awsInv) {
    const r = awsInv.root;
    if (r?.keys?.length) add("critical", "The root account has active access keys", "Delete them; nothing should sign requests as root.", "root-keys");
    if (r && !r.mfa) add("critical", "The root account has no MFA", "Turn on MFA for root.", "root-mfa");
    for (const u of awsInv.users) {
      if (u.console && !u.mfa) add("high", `${u.name} signs in to the console without MFA`, "", `nomfa:${u.name}`);
      u.keys.forEach((k, i) => {
        const age = days(k.created), idle = k.last_used ? days(k.last_used) : age;
        if (age > 90) add("medium", `${u.name}'s access key is ${Math.round(age)} days old`, "Rotate keys at least every 90 days.", `keyage:${u.name}:${i}`);
        if (idle > 90) add("medium", `${u.name}'s access key ${k.last_used ? `has not been used in ${Math.round(idle)} days` : "was never used"}`, "Deactivate keys nobody uses.", `keyidle:${u.name}:${i}`);
      });
      if (u.policies.includes("AdministratorAccess")) add("low", `${u.name} has AdministratorAccess`, "Prefer roles with narrower policies for day-to-day work.", `useradmin:${u.name}`);
    }
    for (const r of awsInv.roles) {
      if (r.service_linked) continue;
      if (r.trusted.includes("*")) add("critical", `Role ${r.name} can be assumed by anyone`, "Its trust policy allows the * principal.", `rolestar:${r.name}`);
      if (r.policies.includes("AdministratorAccess")) add("medium", `Role ${r.name} has AdministratorAccess`, `Trusted by ${r.trusted.join(", ") || "?"}.`, `roleadmin:${r.name}`);
      const idle = r.last_used ? days(r.last_used) : days(r.created);
      if (idle > 90) add("low", `Role ${r.name} ${r.last_used ? `has not been used in ${Math.round(idle)} days` : "has never been used"}`, "Delete roles nothing assumes.", `roleidle:${r.name}`);
    }
  }
  if (inf) {
    const byEnv = {};
    for (const f of inf.folders) for (const k of f.keys) ((byEnv[f.env] ??= {})[k] ??= []).push(f.path);
    for (const [env, m] of Object.entries(byEnv)) {
      const dups = Object.entries(m).filter(([, paths]) => paths.length > 2).sort((x, y) => y[1].length - x[1].length);
      if (dups.length) add("low", `${dups.length} secret${dups.length === 1 ? " is" : "s are"} copied into 3 or more folders in ${env}`, `${dups.slice(0, 8).map(([k, p]) => `${k} (${p.length})`).join(", ")}${dups.length > 8 ? "…" : ""}. Every copy is one more place to rotate.`, `dup:${env}`);
    }
    const prod = inf.folders.filter((f) => f.env === "prod"), stg = Object.fromEntries(inf.folders.filter((f) => f.env === "staging").map((f) => [f.path, new Set(f.keys)]));
    for (const f of prod) if (stg[f.path]) { const miss = f.keys.filter((k) => !stg[f.path].has(k)); if (miss.length) add("low", `${miss.length} key${miss.length === 1 ? "" : "s"} in prod ${f.path} missing from staging`, miss.slice(0, 12).join(", ") + (miss.length > 12 ? "…" : ""), `drift:${f.path}`); }
  }
  return out.sort((a, b) => SEV[a.sev] - SEV[b.sev]);
}
// Marketing: spend, leads, impressions and clicks per campaign per day, posted by the repo's own
// ads skill (POST /api/marketing), with the ad account's state. Last 30 days against the 30 before.
async function readMarketing(repoId) {
  const since = new Date(Date.now() - 2 * WINDOW * 864e5).toISOString().slice(0, 10);
  const rows = await db.all("SELECT source, day, campaign, spend, impressions, clicks, leads FROM marketing WHERE repo_id = $1 AND day >= $2", repoId, since);
  if (!rows.length) return null;
  const cut = new Date(Date.now() - WINDOW * 864e5).toISOString().slice(0, 10);
  const sum = (list) => list.reduce((a, r) => ({ spend: a.spend + Number(r.spend), impressions: a.impressions + Number(r.impressions), clicks: a.clicks + Number(r.clicks), leads: a.leads + Number(r.leads) }), { spend: 0, impressions: 0, clicks: 0, leads: 0 });
  const now = rows.filter((r) => r.day > cut), before = rows.filter((r) => r.day <= cut);
  const names = [...new Set(now.map((r) => r.campaign))];
  const campaigns = names.map((name) => ({ name, source: now.find((r) => r.campaign === name).source, ...sum(now.filter((r) => r.campaign === name)), before: sum(before.filter((r) => r.campaign === name)), last: now.filter((r) => r.campaign === name).map((r) => r.day).sort().pop() })).sort((a, b) => b.spend - a.spend);
  const dates = [...Array(WINDOW)].map((_, i) => new Date(Date.now() - (WINDOW - 1 - i) * 864e5).toISOString().slice(0, 10));
  const daily = campaigns.map((c) => ({ name: c.name, spend: dates.map((d) => now.filter((r) => r.campaign === c.name && r.day === d).reduce((a, r) => a + Number(r.spend), 0)), leads: dates.map((d) => now.filter((r) => r.campaign === c.name && r.day === d).reduce((a, r) => a + Number(r.leads), 0)) }));
  const accounts = [];
  for (const src of [...new Set(rows.map((r) => r.source))]) { const a = await db.one("SELECT v FROM settings WHERE k = $1", `mkt:${repoId}:${src}`); if (a) accounts.push({ source: src, ...JSON.parse(a.v) }); }
  return { total: sum(now), before: sum(before), campaigns, dates, daily, accounts };
}
async function readSecurity(repoId) {
  const rows = await db.all("SELECT kind, at, body FROM inventories WHERE repo_id = $1", repoId);
  if (!rows.length) return null;
  const by = Object.fromEntries(rows.map((r) => [r.kind, { at: r.at, data: JSON.parse(r.body) }]));
  return { aws: by["aws-iam"] || null, infisical: by.infisical || null, findings: securityFindings(by["aws-iam"]?.data, by.infisical?.data) };
}

async function recordEvents(repoId, prev, s) {
  const now = new Date().toISOString();
  for (const e of diffEvents(prev, s)) await db.run("INSERT INTO events (repo_id, at, level, kind, title, detail, entity, dedupe) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (repo_id, dedupe) DO NOTHING", repoId, now, e.level, e.kind, e.title.slice(0, 200), e.detail.slice(0, 400), e.entity, e.dedupe.slice(0, 300));
}
// Keep active repos current without anyone watching: every 10 minutes, refresh the repos whose
// page was opened in the last 7 days (one at a time, gently on GitHub). This is what produces
// notifications between visits.
async function backgroundRefresh() {
  const rows = await db.all("SELECT r.* FROM repos r JOIN snapshots s ON s.repo_id = r.id WHERE s.at > $1", Date.now() - 7 * 864e5);
  for (const row of rows) await refresh(row).catch((e) => console.error(`refresh ${row.full_name}:`, e.message));
}
setInterval(() => backgroundRefresh().catch(() => {}), 10 * 60e3);
// Bump when the snapshot's shape changes, so a page never renders one saved by older code.
const SNAP_V = 20;

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

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">`;
const MARK = (color = "currentColor") => `<svg viewBox="0 0 40 40" width="22" height="22" aria-hidden="true"><path d="M3 22h9l3.5-9 6 18 3.5-9h12" fill="none" stroke="${color}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LOGO = `<a class="logo" href="/">${MARK()}<span>Level 5</span></a>`;

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
.sk-banner{background:#e3e5e8}.sk-nav a{display:flex;align-items:center;gap:10px;padding:7px 10px}
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
.rz{position:relative;border-top:1px solid var(--line)}.rz:first-child{border-top:0}.rz>.line{border-top:0;padding-right:200px}
.rz-btn{position:absolute;right:16px;top:50%;transform:translateY(-50%);white-space:nowrap}
.rz-setup{margin:0 0 20px;padding:16px 20px;border:1px solid var(--line);border-radius:10px;background:#fafafb}.rz-setup[hidden]{display:none}
.rz-setup h3{margin:0 0 6px;font-size:15px}.rz-setup p,.rz-setup li{font-size:13.5px;color:var(--muted);line-height:1.5}.rz-setup ol{margin:8px 0 4px;padding-left:20px}
@media(max-width:640px){.rz>.line{padding-right:20px;padding-bottom:52px}.rz-btn{top:auto;bottom:12px;transform:none;right:auto;left:20px}}
.cx.cx-mini{display:block;margin:0;background:none;border-radius:0;box-shadow:none}.cx-mini .cx-chart{min-height:260px}.cx-mini .cx-loading{padding:110px 0}.cx-mini .cx-legend{margin-top:6px}.group a.line{text-decoration:none;color:inherit}.group a.line:hover{background:rgba(15,16,20,.03)}.cols i.stack{display:flex;flex-direction:column-reverse;overflow:hidden;background:transparent}.cols i.stack em{display:block;min-height:1px;border-radius:0}
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
.tb-bell{position:relative;display:grid;place-items:center;width:32px;height:32px;border-radius:6px;background:none;border:0;padding:0;color:#d5dbdb;cursor:pointer}.tb-bell:hover,.tb-bell[aria-expanded=true]{background:rgba(255,255,255,.1);color:#fff}
.tb-bell svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.tb-count{position:absolute;top:2px;right:1px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--accent,#ec7211);color:#fff;font:700 10px/16px var(--f);text-align:center}
.notif{position:fixed;top:44px;right:12px;z-index:220;width:min(400px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 60px));display:flex;flex-direction:column;background:var(--bg);border-radius:10px;box-shadow:0 0 0 1px rgba(0,28,36,.12),0 16px 40px -10px rgba(0,28,36,.4);overflow:hidden}
.notif-h{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);font-size:14px}.notif-h .faint{font-size:12px}
.notif-all{background:none;border:0;padding:0;color:var(--link,#0073bb);font:600 13px var(--f);cursor:pointer}.notif-all:hover{background:none;text-decoration:underline}
.notif-list{overflow-y:auto}
.notif-i{display:grid;grid-template-columns:10px minmax(0,1fr);gap:10px;padding:11px 16px;border-top:1px solid var(--line);text-decoration:none;color:var(--ink);font-size:13px}.notif-i:first-child{border-top:0}.notif-i:hover{background:#f9fafa}
.notif-i.unread{background:#f2f8fd}.notif-i.unread:hover{background:#e9f3fb}
.notif-i>i{width:8px;height:8px;border-radius:50%;margin-top:5px;background:var(--faint)}.notif-i[data-lvl=bad]>i{background:var(--bad)}.notif-i[data-lvl=warn]>i{background:var(--warn)}.notif-i[data-lvl=ok]>i{background:var(--ok)}.notif-i[data-lvl=info]>i{background:var(--link,#0073bb)}
.notif-i b{font-weight:600;display:block}.notif-i .nd{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notif-i .nm{display:block;color:var(--faint);font-size:12px;margin-top:2px}
.notif-empty{padding:28px 20px;color:var(--muted);font-size:13px;line-height:1.5}
.rules-h{display:flex;align-items:center;justify-content:space-between;margin-top:32px}.rules-h h2{margin:0}
.btn-sm{font:700 13px var(--f);padding:6px 14px}
.btn-plain{background:none;border:0;color:var(--link,#0073bb);font:500 13px var(--f);padding:2px 0;cursor:pointer}.btn-plain:hover{background:none;text-decoration:underline}.btn-plain.danger{color:var(--bad)}
.line.rule{align-items:center}.line.rule .meta{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.meter{display:block;height:4px;border-radius:2px;background:var(--empty);margin-top:8px;max-width:360px;overflow:hidden}.meter i{display:block;height:100%;background:var(--ok)}.meter[data-s=warn] i{background:var(--warn)}.meter[data-s=bad] i{background:var(--bad)}.meter[data-s=none] i{background:var(--faint)}
.rule-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
.rule-form label,.rule-form fieldset{display:flex;flex-direction:column;gap:4px;font-size:12.5px;font-weight:600;color:var(--muted);margin:0;min-width:0}
.rule-form label small,.rule-form legend small{font-weight:400;color:var(--faint)}
.rule-form .f-wide{grid-column:1/-1}.rule-form [hidden]{display:none}
.rule-form input,.rule-form select{font:14px var(--f);color:var(--ink);padding:7px 9px;border:1px solid #aab7b8;border-radius:6px;background:var(--bg);min-width:0}
.rule-form input:focus,.rule-form select:focus{outline:2px solid var(--link,#0073bb);outline-offset:-1px;border-color:transparent}
.rule-form fieldset{border:0;padding:0}.rule-form legend{padding:0;margin-bottom:4px}
.dow{display:flex;gap:6px;flex-wrap:wrap}.dow-i{flex-direction:row!important;align-items:center}.dow-i input{position:absolute;opacity:0;pointer-events:none}
.dow-i span{display:inline-block;padding:5px 10px;border:1px solid var(--line);border-radius:999px;font-weight:500;color:var(--ink);cursor:pointer;user-select:none}.dow-i input:checked+span{background:var(--squid,#232f3e);border-color:var(--squid,#232f3e);color:#fff}.dow-i input:focus-visible+span{outline:2px solid var(--link,#0073bb)}
.f-actions{display:flex;align-items:center;gap:12px;justify-content:flex-end;margin-top:6px}.f-msg{flex:1;font-size:13px;font-weight:400;color:var(--muted)}
.map-wrap{position:relative}
.svc-map{position:relative;height:min(640px,70vh);border-radius:10px;overflow:hidden;background:#dfe6ee;box-shadow:var(--shadow,0 0 0 1px var(--line))}
.svc-map canvas{display:block;width:100%!important;height:100%!important;cursor:grab}.svc-map canvas:active{cursor:grabbing}
.map-hint{position:absolute;left:14px;bottom:12px;font-size:12px;color:rgba(255,255,255,.92);text-shadow:0 1px 3px rgba(0,0,0,.45);pointer-events:none;z-index:2}
.map-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.map-tag{position:absolute;left:0;top:0;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.88);box-shadow:0 2px 10px rgba(25,30,45,.16);font:500 11.5px var(--mono);color:#191e2d;white-space:nowrap}.map-tag.bad{background:#e5484d;color:#fff}
.map-label,.map-island{position:absolute;left:0;top:0;white-space:nowrap;font:600 11.5px var(--f);color:var(--ink);background:rgba(255,255,255,.88);padding:2px 7px;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.map-label.alarm{background:var(--bad);color:#fff}
.map-island{background:var(--squid,#232f3e);color:#fff;text-transform:uppercase;letter-spacing:.04em;font-size:10.5px}
.map-tip{position:absolute;z-index:3;width:228px;display:grid;gap:2px;padding:10px 12px;border-radius:8px;background:var(--squid,#232f3e);color:#d5dbdb;font-size:12px;pointer-events:none;box-shadow:0 8px 24px -8px rgba(0,0,0,.4)}.map-tip b{color:#fff;font-size:13px}
.map-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;color:var(--muted)}.map-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.w-cols{height:90px;margin-bottom:6px}.w-cols i{background:var(--squid,#232f3e)}
.cx{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:0;margin:20px 0 32px;background:var(--bg);border-radius:8px;box-shadow:var(--shadow,0 0 0 1px var(--line))}
.cx-main{padding:20px 22px 18px;min-width:0}
.cx-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.cx-head h2{font-size:20px;margin:0}
.seg{display:inline-flex;border:2px solid #7d8998;border-radius:20px;padding:2px;gap:2px}.seg button{background:none;border:0;border-radius:16px;padding:5px 12px;color:var(--ink);cursor:pointer;font:700 14px var(--f)}.seg button:hover{background:#f2f3f3}.seg button.on{background:#0972d3;color:#fff}
.seg svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.seg.wide{display:flex;margin-bottom:14px}.seg.wide button{flex:1}
.cx-sub{color:var(--muted);font-size:13px;margin:6px 0 10px}.cx-sub b{color:var(--ink);font-size:15px}
.cx-chart{position:relative;min-height:340px}.cx-loading,.cx-note{color:var(--faint);font-size:13px}.cx-loading{padding:140px 0;text-align:center}
.cx-svg{display:block;max-width:100%;height:auto;font:12px var(--f)}
.cx-svg .grid{stroke:#ececf0;stroke-dasharray:3 4}.cx-svg .axis0{stroke:#aab7b8}.cx-svg .yl{fill:var(--muted);text-anchor:end}.cx-svg .xl{fill:var(--muted);text-anchor:middle;font-size:12.5px}
.cx-svg .hit{fill:transparent}.cx-svg .cap{fill:#fff;opacity:.5}
.cx-svg.hov .col:not(.on) rect:not(.hit){opacity:.32}.cx-svg .col rect{transition:opacity .12s}
.cx-svg .ln{fill:none;stroke-width:2}.cx-svg .pt{opacity:0}.cx-svg .pt.on{opacity:1}
.cx-svg .prev{fill:none;stroke:#16191f;stroke-width:1.6;stroke-dasharray:5 4;opacity:.65}
.cx-tip{position:absolute;z-index:4;width:300px;max-width:calc(100% - 8px);padding:14px 16px;background:#fff;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 8px 24px -6px rgba(0,28,36,.3);font-size:13.5px;pointer-events:none}
.cx-tip b{display:block;margin-bottom:8px;font-size:14px}.cx-tip .tr,.cx-tip .tt,.cx-tip .tp{display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:8px;align-items:center;padding:3px 0}
.cx-tip .tr i{width:11px;height:11px;border-radius:2px}.cx-tip em{font-style:normal;font-variant-numeric:tabular-nums}.cx-tip .tr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cx-tip .tt{grid-template-columns:minmax(0,1fr) auto;border-top:1px solid var(--line);margin-top:6px;padding-top:8px;font-weight:700}.cx-tip .tp{grid-template-columns:minmax(0,1fr) auto;color:var(--muted)}.cx-tip small{color:var(--muted)}
.cx-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:10px 0 4px;font-size:12.5px;color:var(--ink)}.cx-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}.cx-legend i.dash{width:16px;height:0;border-top:2px dashed #16191f;border-radius:0;vertical-align:3px}
.cx-table table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13.5px}.cx-table th{text-align:left;font-size:12px;color:var(--muted);font-weight:700;padding:8px 6px;border-bottom:1px solid var(--line)}.cx-table td{padding:7px 6px;border-bottom:1px solid #f2f3f3}.cx-table td:nth-child(2){font-variant-numeric:tabular-nums;width:110px}.cx-table td:nth-child(3){width:200px;color:var(--muted);font-variant-numeric:tabular-nums}
.cx-table .bar{display:inline-block;width:100px;height:6px;border-radius:3px;background:#e9ebed;margin-right:8px;vertical-align:middle;overflow:hidden}.cx-table .bar i{display:block;height:100%;background:#688ae8}
.cx-panel{border-left:1px solid var(--line);padding:6px 20px 18px}
.cx-panel details{border-bottom:1px solid var(--line);padding:12px 0}.cx-panel details:last-child{border-bottom:0}
.cx-panel summary{font-weight:700;font-size:16px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;margin-bottom:10px}.cx-panel summary::-webkit-details-marker{display:none}
.cx-panel summary::before{content:"";border:6px solid transparent;border-top:8px solid var(--ink);border-bottom:0;transition:transform .15s}.cx-panel details:not([open]) summary::before{transform:rotate(-90deg)}
.cx-panel label{display:flex;flex-direction:column;gap:5px;font-weight:700;font-size:13.5px;margin-bottom:12px}
.cx-panel .lab{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13.5px;margin:4px 0 6px}.cx-panel .lab a{font-weight:600;color:var(--link,#0073bb);text-decoration:none}
.cx-panel select,.cx-panel input[type=date],.cx-panel input[type=search]{font:14px var(--f);color:var(--ink);padding:7px 10px;border:2px solid #7d8998;border-radius:8px;background:#fff;width:100%}
.cx-custom{display:grid;grid-template-columns:1fr 1fr;gap:8px}.cx-custom[hidden]{display:none}.cx-note{margin:-4px 0 12px}
.ms{position:relative;margin-bottom:12px}.ms-btn{display:flex;justify-content:space-between;align-items:center;width:100%;background:#fff;color:var(--ink);border:2px solid #7d8998;border-radius:8px;padding:7px 10px;font:italic 14px var(--f);cursor:pointer}.ms-btn:hover{background:#fff}
.ms-btn svg{width:16px;height:16px;fill:none;stroke:#0972d3;stroke-width:2.2}
.ms-pop{position:absolute;z-index:6;left:0;right:0;top:calc(100% + 4px);background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 8px 24px -6px rgba(0,28,36,.3);padding:8px}.ms-pop[hidden]{display:none}
.ms-list{max-height:240px;overflow-y:auto;margin-top:6px}.ms-list label,.cx-checks label{flex-direction:row;align-items:center;gap:8px;font-weight:400;margin:0;padding:4px 2px;font-size:13.5px}
.cx-checks{display:grid;gap:2px}
@media(max-width:1100px){.cx{grid-template-columns:minmax(0,1fr)}.cx-panel{border-left:0;border-top:1px solid var(--line)}}
.promo-h{display:flex;align-items:center;gap:14px;margin-bottom:10px}.promo-h h2{margin:0}
.flow{display:inline-flex;align-items:center;gap:6px}.flow svg{width:16px;height:16px;fill:none;stroke:var(--muted);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
code.branch.prod{color:#0f7a38;background:#e3f6e8}
.promo-open{margin-bottom:24px;border-left:3px solid var(--ok)}.promo-open .name{display:flex;gap:10px;align-items:flex-start}.promo-open .name .gi{margin-top:3px}
.promo-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;margin-bottom:28px}.promo-cols h2 .faint{font-weight:500}
.promo-list{margin-bottom:0}.promo-list .line{text-decoration:none;color:var(--ink);align-items:center}.promo-list a.line:hover{background:#f9fafa}
.promo-list .name{display:flex;gap:10px;align-items:flex-start;min-width:0}.promo-list .name>span:not(.gi){min-width:0;flex:1}.promo-list .name .gi{margin-top:3px}.pm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:1000px){.promo-cols{grid-template-columns:minmax(0,1fr)}}
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
// The Linear-style layer, loaded after everything else: light, dense, thin borders, almost no
// shadow, Inter, black primary buttons, indigo only for links and focus. Level 5's orange stays in the
// logo. Palette and type only; layout lives in the base styles.
const THEME = `
.sk-g{margin-bottom:28px}.sk-gh{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px}.sk-gh h2{margin:0}.sk-gh span{font-size:12.5px;color:var(--faint)}.sk-gh code{font:12px var(--mono);color:var(--muted)}.sk-gh b{color:var(--ink);font-weight:500}
.sk-row .name small b.miss{color:var(--bad);font-weight:500}
.bars i[data-s=warn]{background:var(--warn)}.bars i[data-s=miss]{background:var(--bad)}
.sk-key{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;font-size:12px;color:var(--faint);margin:-8px 0 0}.sk-key i{display:inline-block;width:8px;height:14px;border-radius:2px;background:var(--empty);margin-right:2px;vertical-align:-2px}.sk-key i[data-s=ok]{background:var(--ok)}.sk-key i[data-s=warn]{background:var(--warn)}.sk-key i[data-s=miss]{background:var(--bad)}

:root{--bg:#fff;--canvas:#fbfbfc;--ink:#1b1c1f;--ink2:#3c3f45;--muted:#6b6f76;--faint:#9a9ea6;--line:#ebebef;--line2:#f3f3f5;
--ok:#2f9e5b;--warn:#e8913a;--bad:#e5484d;--empty:#ececf0;--link:#5e6ad2;--accent:#1b1c1f;--squid:#1b1c1f;--sel:rgba(15,16,20,.05);--warn-ink:#b5651d;
--shadow:0 0 0 1px var(--line),0 1px 2px rgba(15,16,20,.04);
--f:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
body{font-size:13.5px;letter-spacing:-.006em;font-feature-settings:"cv11","ss01"}
html[data-view] body{background:var(--canvas)}
a{color:var(--ink)}::selection{background:#dcdff7;color:var(--ink)}
a:focus-visible,summary:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--link);outline-offset:1px;border-radius:4px}
h2{font-size:12.5px;font-weight:600;color:var(--muted);letter-spacing:0;margin-bottom:8px}
.vh{margin-bottom:20px}.vh h1{font-size:19px;font-weight:600;letter-spacing:-.015em;margin-bottom:4px}.vh p{font-size:13.5px;color:var(--muted)}
/* chrome */
.app{grid-template-columns:232px minmax(0,1fr);grid-template-rows:auto 1fr}.app.solo{grid-template-columns:minmax(0,1fr)}.solo .main{margin:0 auto;max-width:1080px}
.topbar{grid-column:1/-1;position:sticky;top:0;z-index:6;height:44px;display:flex;align-items:center;gap:14px;padding:0 16px;background:var(--bg);color:var(--ink);border-bottom:1px solid var(--line);font-size:13px}
.topbar .logo{color:var(--ink);font-size:14px;font-weight:600;gap:7px}.topbar .logo svg{color:#f2702c;width:18px;height:18px}
.crumbs{display:flex;align-items:center;gap:6px;min-width:0}.crumbs a{color:var(--muted);text-decoration:none}.crumbs a:hover{color:var(--ink)}.crumbs span{color:var(--faint)}.crumbs b{color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:10px}.tb-refresh{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:none;color:var(--muted);cursor:pointer}.tb-refresh:hover{background:var(--sel);color:var(--ink)}.tb-refresh svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.wrap[data-loading="1"] .tb-refresh svg{animation:spin 1s linear infinite}.tb-user{color:var(--muted);font-size:12.5px}.tb-btn{background:none;border:0;color:var(--muted);font:inherit;padding:0;cursor:pointer}.tb-btn:hover{color:var(--ink);background:none}
.tb-bell{position:relative;display:grid;place-items:center;width:28px;height:28px;border-radius:6px;background:none;border:0;padding:0;color:var(--muted);cursor:pointer}.tb-bell:hover,.tb-bell[aria-expanded=true]{background:var(--sel);color:var(--ink)}
.tb-bell svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.tb-count{position:absolute;top:1px;right:0;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--link);color:#fff;font:600 10px/15px var(--f);text-align:center}
.side{position:sticky;top:44px;height:calc(100vh - 44px);background:#f7f7f8;border-right:1px solid var(--line);padding:12px 8px;display:flex;flex-direction:column;gap:14px}
.repo-box{border:0;border-radius:0;background:none;padding:2px 10px 10px;border-bottom:1px solid var(--line)}
.repo-name{font:500 12.5px var(--mono);color:var(--ink)}.repo-state{font-size:12px;color:var(--muted)}
.snav a,.side-foot a{display:flex;align-items:center;gap:9px;height:30px;padding:0 10px;border-radius:6px;color:var(--ink2);text-decoration:none;font-size:13px;margin:0}
.snav a:hover,.side-foot a:hover{background:rgba(15,16,20,.04);color:var(--ink)}
.ni{width:16px;height:16px;color:var(--faint)}
.nc{font-size:11.5px;color:var(--faint)}
.nb{background:var(--bad);font-size:10.5px;min-width:17px;height:17px}.nb[data-t=warn]{background:var(--warn)}
.side-foot{border-top:1px solid var(--line);padding-top:10px}.side-foot .updated{font-size:11.5px;color:var(--faint)}
.main{padding:28px 40px 72px;max-width:1180px}
/* surfaces */
.group,.card,.onboard,html[data-view] .group,html[data-view] .card,html[data-view] .onboard{background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 1px 2px rgba(15,16,20,.03)}
.grid2,html[data-view] .grid2{background:var(--line);border:1px solid var(--line)}.grid2>.row,html[data-view] .grid2>.row{background:var(--bg)}
.row{padding:14px 16px;border-top:1px solid var(--line2)}.line{padding:10px 16px;border-top:1px solid var(--line2)}
.row.openable:hover,.line.openable:hover,.mini li.openable:hover,a.line:hover,.recent .rrow:hover,.run-head:hover{background:#fafafb}
.name{font-weight:500}.mon-id{font:500 12.5px var(--mono)}.sub{color:var(--faint);font-size:12px}
.state{font-size:12.5px;font-weight:500}.state[data-s=warn]{color:var(--warn-ink)}
.bars{gap:2px;height:26px}.bars i{border-radius:2px}.axis{font-size:11.5px;color:var(--faint)}
.banner{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:12px 16px;font-size:14px;font-weight:500;box-shadow:0 1px 2px rgba(15,16,20,.03)}
.banner svg{width:16px;height:16px}.banner svg circle:first-child{fill:var(--ok);fill-opacity:1}
.banner[data-s=degraded],.banner[data-s=down]{color:var(--ink)}.banner[data-s=degraded] svg circle:first-child{fill:var(--warn)}.banner[data-s=down] svg circle:first-child{fill:var(--bad)}
.banner svg path{stroke:#fff}.banner svg circle+circle{fill:#fff}
.banner-sub{font-size:12.5px;color:var(--muted);margin:8px 0 28px}
.stat{padding:14px 16px}.stat b,.card .big{font-size:22px;font-weight:600;letter-spacing:-.02em}.stat span{font-size:12.5px;color:var(--ink2)}.stat small{font-size:11.5px;color:var(--faint)}
.card{padding:14px 16px}.card-h h3{font-size:12.5px;font-weight:500;color:var(--muted)}.card-h a{font-size:12px;color:var(--faint)}
.cards{gap:12px}
code{font-size:12px}code.branch{font:500 11px var(--mono);color:var(--ink2);background:#f2f2f4;border-radius:4px;padding:1px 6px}code.branch.prod{color:#1f7a45;background:#e8f5ec}
.agent-tag{background:#eef0fb;color:var(--link);font-weight:600;border-radius:4px}
.pill{font-weight:500;font-size:11.5px;padding:2px 8px;border-radius:999px}
/* controls */
button,.btn{background:var(--ink);color:#fff;border-radius:6px;font:500 13px var(--f);padding:7px 12px;border:0}button:hover,.btn:hover{background:#000}
.btn.ghost,.btn-plain{background:none;color:var(--link)}.btn.ghost:hover,.btn-plain:hover{background:none}
.btn-sm{font:500 12.5px var(--f);padding:5px 10px}
.chip{background:var(--bg);color:var(--ink2);border:1px solid var(--line);border-radius:999px;font:500 12.5px var(--f);padding:5px 11px}.chip:hover{background:#f7f7f8;border-color:#dcdce1}
.copy{border-radius:6px;border-color:var(--line);font-size:12px}
.tabs>label{border-radius:6px;font-size:12.5px;padding:5px 10px;background:var(--bg)}.tabs>input:checked+label{border-color:var(--ink2);background:var(--bg)}
.rule-form input,.rule-form select,.cx-panel select,.cx-panel input[type=date],.cx-panel input[type=search],.ms-btn{border:1px solid #e2e2e6;border-radius:6px;font-size:13px;padding:6px 9px;background:var(--bg)}
.dow-i span{border-radius:6px;font-size:12.5px}.dow-i input:checked+span{background:var(--ink);border-color:var(--ink)}
.seg{border:1px solid var(--line);border-radius:7px;padding:2px;background:#f7f7f8}.seg button{border-radius:5px;padding:4px 10px;color:var(--muted);font-weight:500;background:none}.seg button:hover{background:rgba(15,16,20,.04);color:var(--ink)}.seg button.on{background:var(--bg);color:var(--ink);box-shadow:0 0 0 1px var(--line),0 1px 2px rgba(15,16,20,.06)}
.ms-btn{font-style:normal;color:var(--muted)}.ms-btn svg{stroke:var(--muted)}
.cx{border:1px solid var(--line);border-radius:8px;box-shadow:0 1px 2px rgba(15,16,20,.03)}.cx-head h2{font-size:14px;color:var(--ink);font-weight:600}
.cx-panel summary{font-size:13px;font-weight:600}.cx-panel summary::before{border-top-color:var(--muted)}.cx-panel label,.cx-panel .lab{font-size:12.5px;font-weight:500;color:var(--ink2)}.cx-panel .lab a{color:var(--link)}
.cx-tip{border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 32px -10px rgba(15,16,20,.22);font-size:12.5px}
/* windows, dock, notifications, map */
.win{border-radius:10px;box-shadow:0 0 0 1px rgba(15,16,20,.08),0 18px 48px -14px rgba(15,16,20,.28)}
.win-bar{height:40px;background:var(--bg);border-bottom:1px solid var(--line);cursor:grab}.win-kind{font-size:11px;letter-spacing:.02em;color:var(--faint)}.win-title{font-size:13px;font-weight:500}
.win-btn{color:var(--faint)}.win-btn:hover{background:var(--sel);color:var(--ink)}
.win-dock{background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 32px -12px rgba(15,16,20,.25)}.win-chip{background:#f4f4f6;color:var(--ink);border-radius:6px;font-size:12.5px}.win-chip:hover{background:#ececf0}.win-chip span{color:var(--faint)}
.notif{top:48px;border:1px solid var(--line);border-radius:10px;box-shadow:0 18px 48px -14px rgba(15,16,20,.28)}.notif-h{font-size:13px}.notif-i{font-size:12.5px}.notif-i.unread{background:#f6f7fe}.notif-i.unread:hover{background:#eef0fb}
.notif-i[data-lvl=info]>i{background:var(--link)}
.msg.user{background:var(--ink)}.msg.assistant{border:1px solid var(--line);box-shadow:none}
.ask{border:1px solid var(--line);box-shadow:0 1px 2px rgba(15,16,20,.04);border-radius:10px}
.svc-map{border:1px solid var(--line);border-radius:8px;box-shadow:none}
.map-tip{background:var(--ink)}
.promo-open{border-left:3px solid var(--ok)}
.onboard>h2{color:var(--ink);font-size:14px}.ob-n{border-color:var(--ink2)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:rgba(15,16,20,.14);border-radius:10px;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-track{background:transparent}
.banner,.banner[data-s=degraded],.banner[data-s=down]{background:var(--bg)}
/* cost explorer: a toolbar of chips over the chart */
.cx{display:block;padding:0;margin:16px 0 28px;background:var(--bg)}
.cx-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.cx-bar .seg svg{width:15px;height:15px}
.pick{position:relative;display:inline-flex;flex-direction:row;align-items:center;gap:6px;height:28px;margin:0;padding:0 8px;border:1px solid var(--line);border-radius:6px;font-size:12.5px;font-weight:500;color:var(--ink);background:var(--bg)}
.pick:hover{background:#f9f9fa}.pick-l{color:var(--faint);font-weight:400}
.pick select{border:0;background:transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 6.5l3.5 3.5 3.5-3.5' fill='none' stroke='%239a9ea6' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right center/14px;font:500 12.5px var(--f);color:var(--ink);padding:0 18px 0 0;appearance:none;-webkit-appearance:none;cursor:pointer;outline-offset:3px}
.toggle{display:inline-flex;align-items:center;height:28px;padding:0 10px;background:var(--bg);color:var(--ink2);border:1px solid var(--line);border-radius:6px;font:500 12.5px var(--f)}.toggle:hover{background:#f9f9fa}.toggle.on{background:#eef0fb;color:var(--link);border-color:#d7dbf6}
.cx-spacer{flex:1}
.cx-custom{display:inline-flex;gap:6px;align-items:center}.cx-custom[hidden]{display:none}.cx-custom input{height:28px;border:1px solid var(--line);border-radius:6px;font:12.5px var(--f);padding:0 6px;color:var(--ink)}
.cx .ms{margin:0;position:relative}
.cx .ms-btn{display:inline-flex;align-items:center;gap:6px;width:auto;height:28px;padding:0 10px;background:var(--bg);color:var(--muted);border:1px dashed #d6d6dc;border-radius:6px;font:500 12.5px var(--f)}.cx .ms-btn:hover{background:#f9f9fa;color:var(--ink)}
.cx .ms-btn.on{border-style:solid;color:var(--link);background:#eef0fb;border-color:#d7dbf6}.cx .ms-btn svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
.cx .ms-pop{left:auto;right:0;width:280px;border:1px solid var(--line);border-radius:8px;box-shadow:0 16px 40px -12px rgba(15,16,20,.25)}
.cx .ms-list label,.cx .cx-checks label{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:400;padding:5px 4px;border-radius:5px;cursor:pointer}.cx .ms-list label:hover{background:#f6f6f8}
.cx-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line)}.cx-filters[hidden]{display:none}
.fchip{display:inline-flex;gap:6px;align-items:center;height:24px;padding:0 6px 0 8px;background:#f4f4f6;color:var(--ink2);border:0;border-radius:5px;font:400 12px var(--f)}.fchip b{font-weight:600;color:var(--ink)}.fchip span{color:var(--faint);font-size:14px;line-height:1}.fchip:hover{background:#ececf0}
.cx-clear{font-size:12px;color:var(--muted);text-decoration:none;margin-left:4px}.cx-clear:hover{color:var(--ink)}
.cx-main{padding:14px 18px 16px}.cx-sub{font-size:12.5px}.cx-sub b{font-size:20px;font-weight:600;letter-spacing:-.02em;margin-right:4px}
.cx-svg .yl,.cx-svg .xl{fill:var(--faint);font-size:11.5px}.cx-svg .axis0{stroke:#dedee3}
.cx-legend{font-size:12px;color:var(--ink2)}.cx-legend i{border-radius:3px}
.cx-table th{font-size:11.5px;font-weight:500;color:var(--faint)}.cx-table td{font-size:13px;border-bottom:1px solid var(--line2)}.cx-table .bar i{background:var(--link)}
.cx-tip{border-radius:8px;padding:10px 12px;width:260px}.cx-tip b{font-size:12.5px}.cx-tip .tt{font-weight:600}
.tbl{width:100%;border-collapse:collapse;font-size:13px}.tbl th{text-align:left;font-size:11.5px;font-weight:500;color:var(--faint);padding:9px 14px;border-bottom:1px solid var(--line)}.tbl td{padding:9px 14px;border-top:1px solid var(--line2);vertical-align:top}.tbl tr:first-child td{border-top:0}
.tbl td .sub{display:block}.tbl .c{text-align:center;width:90px}.tbl tr[hidden]{display:none}
.roles-g tr.sl{display:none}.roles-g.show-sl tr.sl{display:table-row}.sl-toggle{gap:6px;cursor:pointer}.sl-toggle input{margin:0}
code.branch.admin{background:#fdecec;color:var(--bad)}
.dot-y{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok)}.dot-n{color:var(--faint)}
.sec-f .name{display:flex;gap:10px;align-items:flex-start}.sec-f .pill{flex:none;margin-top:1px}.sec-f b{font-weight:500}
.sec-q{height:28px;border:1px solid var(--line);border-radius:6px;padding:0 9px;font:13px var(--f);width:220px}
.notif[hidden],.win-dock[hidden],.win[hidden]{display:none!important}
.tb-ask{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:500 12.5px var(--sans,inherit);cursor:pointer}.tb-ask svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}.tb-ask:hover{background:rgba(15,16,20,.04)}html[data-ask] .tb-ask{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.askp{display:none;position:fixed;top:44px;right:0;bottom:0;width:400px;z-index:7;flex-direction:column;gap:10px;padding:0 16px 14px;background:var(--bg);border-left:1px solid var(--line)}html[data-ask] .askp{display:flex}
.askp-h{display:flex;align-items:center;gap:8px;height:48px;flex:none;border-bottom:1px solid var(--line);margin:0 -16px;padding:0 10px 0 16px;font-size:13px}.askp-h .faint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.askp-x{margin-left:auto;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;background:none;color:var(--muted);cursor:pointer}.askp-x:hover{background:rgba(15,16,20,.06);color:var(--ink)}.askp-x svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}
.askp .chat-log{flex:1;max-height:none;min-height:0}.askp .chips{display:flex;flex-direction:column;align-items:flex-start;gap:6px}.askp .ask textarea{min-height:56px}
@media(min-width:1100px){html[data-ask] .app .main{width:auto;margin-right:400px}}
@media(max-width:820px){.askp{width:auto;left:0}.tb-ask span{display:none}}
.rt .rt-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.rt .name{display:flex;flex-direction:column;gap:3px;min-width:0}.rt .name b{font-size:14.5px;font-weight:600}.rt .name small{color:var(--faint);font-size:12px}.rt .bars{margin-top:10px}.rt .name small a{color:var(--muted);text-decoration:none}.rt .name small a:hover{color:var(--ink)}.rt .name code{font-size:12px}
.rt-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:10px 0 8px}.rts .bars{gap:1.5px}.rt-stats span{display:flex;flex-direction:column;font-size:11.5px;color:var(--faint)}.rt-stats b{font-size:14px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.rt-hint{margin:8px 0 0;font-size:12.5px;color:var(--muted);line-height:1.45}.rt-hint code{font-size:11.5px}
.w-facts{margin:12px 0 0;font-size:13px;color:var(--muted)}.w-facts a{color:var(--ink)}.w-raw{margin-top:14px;font-size:12.5px}.w-raw summary{cursor:pointer;color:var(--faint)}.w-raw .w-list{margin-top:8px}
.tb-actsw{position:relative}.tb-acts{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:500 12.5px inherit;cursor:pointer}.tb-acts:hover{background:rgba(15,16,20,.04)}.tb-ai{display:inline-flex}.tb-ai .gi{width:13px;height:13px}.tb-n{font-variant-numeric:tabular-nums;color:var(--warn);font-weight:600}.tb-n:empty{display:none}html[data-acts] .tb-acts{background:rgba(15,16,20,.06)}
.acts-pop{display:none;position:absolute;right:0;top:36px;z-index:60;width:min(520px,calc(100vw - 24px));max-height:72vh;overflow:auto;padding:4px 14px 12px;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 14px 40px -10px rgba(0,28,36,.3)}html[data-acts] .acts-pop{display:block}
.acts-pop .live-head h2{font-size:13px}.acts-pop .job:not([data-st=in_progress]){display:none}.acts-pop .recent .rrow:nth-child(n+7){display:none}.acts-pop .group{margin-bottom:10px}
@media(max-width:820px){.tb-acts>span:nth-child(2){display:none}}
.htip{position:fixed;z-index:200;pointer-events:none;max-width:300px;padding:10px 12px;background:var(--bg);border:1px solid #d1d5db;border-radius:10px;box-shadow:0 8px 24px -6px rgba(0,28,36,.3);font-size:13px;line-height:1.45;color:var(--ink)}.htip b{display:block;margin-bottom:4px;font-size:13.5px}.htip div{color:var(--muted)}
.cols:hover>div:not(:hover) i,.bars:hover>i:not(:hover){opacity:.45}.cols i,.bars i{transition:opacity .12s}
.stats5{grid-template-columns:repeat(5,minmax(0,1fr))}.stat b.loc span{font-size:inherit}.loc .add{color:var(--ok)}.loc.sm{font:500 12px var(--mono);white-space:nowrap}.loc .del{color:var(--bad)}@media(max-width:1000px){.stats5{grid-template-columns:repeat(3,minmax(0,1fr))}}
.ci-cols,.day-cols{height:140px}.day-cols>div.grp{display:flex;align-items:flex-end;gap:1px}.day-cols>div.grp i{flex:1;border-radius:2px 2px 0 0;min-height:0}.ci-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:12.5px;color:var(--muted)}.ci-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);overflow:hidden}.grid3>*{background:var(--bg)}.grid3 .bars{gap:1.5px}.sk-row .row-head{gap:8px}.sk-row .row-head .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:1100px){.grid3{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.grid3{grid-template-columns:minmax(0,1fr)}}
.more5:not(.all)>:nth-child(n+6):not(.more-btn){display:none}.more-btn{display:block;width:100%;padding:10px 16px;border:0;border-top:1px solid var(--line);background:none;color:var(--muted);font:500 12.5px inherit;text-align:left;cursor:pointer}.more-btn:hover{color:var(--ink);background:rgba(15,16,20,.025)}
.rps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}@media(max-width:1000px){.rps{grid-template-columns:minmax(0,1fr)}}
.rp{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:0}.rp-h{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.rp-h .name{display:flex;flex-direction:column;gap:3px;min-width:0}.rp-h .name b{font:600 14px var(--mono)}.rp-h small{color:var(--faint);font-size:12px}
.rp .bars{margin:10px 0 4px}.rp-none{margin:10px 0 0;font-size:12.5px;color:var(--muted);line-height:1.45}.rp-none code{font-size:11.5px}.mk td small{display:block;color:var(--muted);font-size:11.5px}.mk .dl{display:inline;font-size:11px;margin-left:4px}.mk .dl[data-s=ok],.stat .dl[data-s=ok]{color:#2f8f5b}.mk .dl[data-s=bad],.stat .dl[data-s=bad]{color:#d14343}.stat .dl{font-size:12px;margin-left:6px;font-weight:500}.mk-acct{font-size:12.5px;color:var(--muted);margin:10px 2px}.lv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}.lv-run{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.lv-run.stuck{border-color:#eb5757}.lv-h{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.lv-run>small,.lv-row small{display:block;color:var(--muted);font-size:12px;margin-top:3px}.lv-flag{margin:10px 0 0;font-size:13px;color:#d14343}.lv-now{margin:10px 0 0;font-size:13px}.lv-now small{color:var(--muted)}.lv-run details,.lv-row{margin-top:8px}.lv-run summary,.lv-row summary{cursor:pointer;font-size:12.5px;color:var(--muted)}.lv-row{padding:10px 16px;margin:0;border-bottom:1px solid var(--line)}.lv-row:last-child{border-bottom:0}.lv-row summary{display:flex;justify-content:space-between;gap:10px;color:var(--text);font-size:13px}.lv-steps{margin-top:8px;font-size:12.5px}.lv-step{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px dashed var(--line)}.lv-step span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lv-step small{color:var(--muted);white-space:nowrap}.lv-step.bad span{color:#d14343}.lv-errs{margin-top:8px;font-size:12.5px;color:#d14343}.lv-errs span{font-weight:600}.lv-setup{margin-top:16px;padding:12px 16px}.lv-setup summary{cursor:pointer;font-weight:500}.lv-how{font-size:13px;line-height:1.5}.lv-how pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:var(--canvas);padding:10px;border-radius:8px}.rp-modal{position:fixed;inset:0;background:rgba(15,16,20,.45);z-index:300;display:flex;align-items:center;justify-content:center;padding:24px}.rp-modal[hidden]{display:none}.rp-dlg{background:var(--bg);border-radius:12px;width:min(760px,100%);height:min(88vh,1100px);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25)}.rp-bar{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}.rp-bar b{flex:1;font-size:14px}.rp-bar a{font-size:12.5px;color:var(--muted)}.rp-bar button{border:0;background:none;font-size:20px;cursor:pointer;color:var(--muted);line-height:1}.rp-dlg iframe{flex:1;border:0;width:100%;background:#fff}.rp-click{cursor:pointer;transition:border-color .15s}.rp-click:hover{border-color:var(--muted)}.rp-open{display:block;margin:10px 0 0;font-size:13px;font-weight:500;color:var(--text);text-decoration:none}.rp-open:hover{text-decoration:underline}
.rp-body{margin-top:10px}.rp-body summary{cursor:pointer;font-weight:600;font-size:13px}.rp-body .md{margin-top:6px;font-size:13px;line-height:1.55;color:var(--ink2);max-height:420px;overflow:auto}.rp-body .md h3,.rp-body .md h4,.rp-body .md h5{margin:10px 0 4px;font-size:13.5px}.rp-body .md ul{padding-left:18px;margin:4px 0}
.rp-past{margin:12px 0 0;box-shadow:none;border:1px solid var(--line)}.rp-past .line{padding:8px 12px}
.keybox{margin-top:28px}.keybox p{font-size:13.5px;color:var(--muted);max-width:720px;line-height:1.5}.keybox form{margin-top:10px}.btn-quiet{height:32px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:500 13px inherit;cursor:pointer}.btn-quiet:hover{background:rgba(15,16,20,.04)}
.rule-nl{display:flex;gap:8px;margin:0 0 6px}.rule-nl input{flex:1;height:40px;padding:0 12px;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:14px;background:var(--bg)}.rule-nl button{height:40px;padding:0 16px;border:0;border-radius:10px;background:var(--ink);color:var(--bg);font:500 13.5px inherit;cursor:pointer}.rule-nl button:disabled{opacity:.5}.rule-msg{min-height:18px;margin:0 0 10px;font-size:12.5px;color:var(--muted)}
.wk-wrap{overflow-x:auto}.wk{width:100%;border-collapse:collapse;font-size:13px}.wk th,.wk td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:center;white-space:nowrap}.wk thead th{font-weight:500;color:var(--muted);font-size:12px}.wk thead th small,.wk tbody th small{display:block;font-weight:400;color:var(--faint);font-size:11px}
.wk tbody th{text-align:left;font-weight:600;min-width:170px}.wk tbody tr:last-child td,.wk tbody tr:last-child th{border-bottom:1px solid var(--line)}.wk tfoot th{text-align:left;color:var(--muted);font-weight:500}.wk tfoot td{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}.wk tfoot td,.wk tfoot th{border-bottom:0}
.wk .today{background:rgba(94,106,210,.06)}.wk-c span{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;font-size:12px;font-weight:700}.wk-c small{display:block;margin-top:2px;color:var(--faint);font-size:10.5px}
.wk-c[data-s=ok] span,.wk-k[data-s=ok]{background:rgba(47,179,107,.14);color:var(--ok)}.wk-c[data-s=miss] span,.wk-k[data-s=miss]{background:rgba(229,72,77,.14);color:var(--bad)}.wk-c[data-s=next] span,.wk-k[data-s=next]{border:1.5px dashed #c4c6cc;color:var(--faint)}.wk-c[data-s=unk] span{color:var(--faint)}.wk-k{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:4px;font-size:10px;font-weight:700;margin-right:4px}
.cal{padding:0;overflow:hidden}.cal-head{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-bottom:1px solid var(--line)}.cal-head>div{padding:10px 12px;font-size:13px;color:var(--muted);border-left:1px solid var(--line)}.cal-head>div:first-child{border-left:0}.cal-head b{color:var(--ink);font-weight:600}.cal-head small{display:block;color:var(--faint);font-size:11.5px;margin-top:2px}.cal-head .today{background:rgba(94,106,210,.06)}.cal-head .today b{color:#5e6ad2}
.cal-body{position:relative;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));background:repeating-linear-gradient(to bottom,transparent 0,transparent calc(6 * 18px - 1px),var(--line) calc(6 * 18px - 1px),var(--line) calc(6 * 18px))}
.cal-hours{position:absolute;inset:0;pointer-events:none}.cal-hours span{position:absolute;left:4px;transform:translateY(2px);font-size:10px;color:var(--faint)}
.cal-day{position:relative;border-left:1px solid var(--line)}.cal-day:first-of-type{border-left:0}.cal-day.today{background:rgba(94,106,210,.04)}.cal-now{position:absolute;left:0;right:0;height:2px;background:#5e6ad2;z-index:2}
.cal-ev{position:absolute;height:20px;padding:0 6px;border-radius:5px;font-size:11px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default;z-index:1}
.cal-ev[data-s=ok]{background:rgba(47,179,107,.16);color:#1f7a49;box-shadow:inset 3px 0 0 var(--ok)}.cal-ev[data-s=miss]{background:rgba(229,72,77,.14);color:#b4282d;box-shadow:inset 3px 0 0 var(--bad)}.cal-ev[data-s=next]{background:var(--bg);color:var(--muted);border:1px dashed #c4c6cc}.cal-ev[data-s=unk]{background:#f1f2f4;color:var(--faint)}
.wk-k[data-s=ok]{background:rgba(47,179,107,.16);box-shadow:inset 3px 0 0 var(--ok)}.wk-k[data-s=miss]{background:rgba(229,72,77,.14);box-shadow:inset 3px 0 0 var(--bad)}.wk-k[data-s=next]{background:var(--bg);border:1px dashed #c4c6cc}.wk-k{width:14px;height:12px;border-radius:3px;vertical-align:-1px}
.settings{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-top:8px}.settings label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}.settings select{height:38px;min-width:320px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font:inherit;font-size:14px;color:var(--ink)}.settings button{height:38px;padding:0 16px;border:0;border-radius:8px;background:var(--ink);color:var(--bg);font:500 13.5px inherit;cursor:pointer}
.cal-card{position:fixed;z-index:120;width:280px;padding:12px 14px;background:var(--bg);border:1px solid #d1d5db;border-radius:12px;box-shadow:0 10px 28px -8px rgba(0,28,36,.32);font-size:12.5px;pointer-events:none}
.cc-h{display:flex;justify-content:space-between;align-items:center;gap:8px}.cc-h b{font-size:14px}.cc-s{font-size:11.5px;font-weight:500;padding:2px 8px;border-radius:999px}.cc-s[data-s=ok]{background:rgba(47,179,107,.14);color:#1f7a49}.cc-s[data-s=miss]{background:rgba(229,72,77,.12);color:#b4282d}.cc-s[data-s=next],.cc-s[data-s=unk]{background:#f1f2f4;color:var(--muted)}
.cc-t{color:var(--muted);margin:3px 0 8px}.cc-bars{display:flex;gap:1.5px;height:18px;margin-bottom:2px}.cc-bars i{flex:1;border-radius:2px;background:#e6e7ea}.cc-bars i[data-s=ok]{background:var(--ok)}.cc-bars i[data-s=warn]{background:var(--warn)}.cc-bars i[data-s=miss]{background:var(--bad)}.cc-ax{display:flex;justify-content:space-between;font-size:10.5px;color:var(--faint);margin-bottom:8px}.cc-run{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:8px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:6px}.cc-run span{display:flex;flex-direction:column;color:var(--faint);font-size:11px}.cc-run b{font-size:14px;color:var(--ink)}
.cc-kv div{display:flex;justify-content:space-between;gap:10px;padding:3px 0}.cc-kv span{color:var(--muted)}.cc-kv b{font-weight:500;text-align:right}.cc-f{margin-top:8px;color:var(--faint);font-size:11px}.cal-ev{cursor:pointer}
.a-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:12px 0 10px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.a-stats span{display:flex;flex-direction:column;font-size:11.5px;color:var(--faint)}.a-stats b{font-size:16px;color:var(--ink);font-weight:600}
.ar-list{border:1px solid var(--line);border-radius:10px;overflow:hidden}.ar{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);font-size:12.5px}.ar:first-child{border-top:0}.ar-st{width:8px;height:8px;border-radius:50%}.ar-st[data-s=ok]{background:var(--ok)}.ar-st[data-s=warn]{background:var(--warn)}.ar-st[data-s=bad]{background:var(--bad)}.ar-main{display:flex;flex-direction:column;min-width:0}.ar-main b{font-weight:500}.ar-main .sub{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ar-num{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
@media(max-width:820px){.side{top:44px;height:auto;flex-direction:row;padding:8px 10px}.main{padding:20px 16px 64px}.win{inset:44px 0 0 0!important}}/* The landing's look, lightly: its faces (Geist), its ink and indigo, softer surfaces without
   shadows, and pill-shaped controls in the top bar. */
:root{--f:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
--ink:#191e2d;--ink2:#3a3f52;--muted:#636878;--faint:#9a9eae;--line:#e8e8f0;--line2:#f1f1f6;--link:#5b4dff;--canvas:#f7f7fb;--sel:rgba(91,77,255,.06)}
::selection{background:#e7e8ff;color:var(--ink)}
.side{background:#f7f7fb}
.group,.card,.onboard,html[data-view] .group,html[data-view] .card,html[data-view] .onboard,.banner,.cx{border-radius:12px;box-shadow:none;border-color:var(--line)}
.cx{box-shadow:0 0 0 1px var(--line)}.cx.cx-mini{box-shadow:none;border-radius:0}
.main h1,.main .cx-head h2{letter-spacing:-.03em}
.tb-ask,.tb-acts,.btn-quiet{border-radius:999px;padding-inline:12px}.btn{border-radius:999px}
.snav a,.side-foot a{border-radius:8px}
.vh-act{margin:-6px 0 18px}
.rt-fire form,.nr-form{display:grid;gap:8px}.nr-form{gap:12px}.nr-form label{display:grid;gap:5px;font-size:12.5px;color:var(--muted)}.nr-form label[hidden]{display:none}
.rt-fire input,.rt-fire textarea,.nr-form input,.nr-form textarea,.nr-form select{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:13px var(--f)}
.rt-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.rt-msg{font-size:12.5px;color:var(--muted)}.rt-row .btn-plain{margin-left:auto}
.nr-cmd{padding:12px 14px;border-radius:10px;background:#14161f;color:#e9eaf0;font:12.5px/1.55 var(--mono);white-space:pre-wrap;word-break:break-word}
`;
const CHECK = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M6 10.2l2.7 2.6L14 7.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ALERT = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg>`;
const ICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' rx='10' fill='%23070b1c'/><path d='M5 22h8l3-8 5 16 3-8h11' fill='none' stroke='%23f0a35e' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/></svg>">`;
// A live page swaps its .wrap for a fresh render: now when it was served stale or as a
// skeleton, then every two minutes. Open <details> stay open across swaps.
const LIVE = `<script>(()=>{const u=location.pathname+"?partial=1";let busy=0;
const pull=async(force)=>{if(busy)return;busy=1;const w=document.querySelector(".wrap");w.dataset.loading="1";
try{const r=await fetch(force===true?u+"&force=1":u,{credentials:"same-origin"});if(r.status===401){location.href="/auth/login";return}
const d=new DOMParser().parseFromString(await r.text(),"text/html");const n=d.querySelector(".wrap");if(!n)throw 0;if(r.ok&&w.querySelector(".sk-nav")&&!n.querySelector(".sk-nav")){location.reload();return}
if(!r.ok)throw 0;const open=[...w.querySelectorAll("details")].map(x=>x.open),on=[...w.querySelectorAll("input[type=radio]:checked")].map(x=>x.id);w.replaceWith(n);on.forEach(id=>{const x=document.getElementById(id);if(x)x.checked=true});
n.querySelectorAll("details").forEach((x,i)=>{if(open[i])x.open=true});document.title=d.title;document.dispatchEvent(new Event("level5:swap"))}catch(e){w.dataset.loading="";w.dataset.failed="1"}finally{busy=0}};
window.level5Pull=pull;if(document.body.dataset.stale)pull();
document.addEventListener("click",ev=>{if(ev.target.closest&&ev.target.closest("[data-refresh]"))pull(true)});setInterval(()=>{if(!document.hidden)pull()},120e3);
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
function render(){if(!data)return;boxes().forEach(b=>draw(b,b.dataset.compact==="1"));prev=new Set(data.active.map(r=>r.id));const n=data.active.length,last=data.recent[0];document.querySelectorAll(".tb-acts").forEach(t=>{t.dataset.on=n?1:0;t.querySelector(".tb-n").textContent=n||"";t.querySelector(".tb-ai").innerHTML=n?I.running:last?icon(last.status,last.conclusion):I.neutral;t.title=n?n+" running":last?"Last: "+last.name+" "+(last.conclusion||""):"Nothing running"})}
const H=document.documentElement;document.addEventListener("click",ev=>{const t=ev.target.closest&&ev.target.closest("[data-acts-toggle]");if(t){if(H.dataset.acts)delete H.dataset.acts;else{H.dataset.acts="1";poll()}return}if(H.dataset.acts&&!(ev.target.closest&&ev.target.closest(".acts-pop")))delete H.dataset.acts});document.addEventListener("keydown",ev=>{if(ev.key==="Escape")delete H.dataset.acts});
function draw(b,compact){const a=data.active;
const done=data.recent.filter(r=>prev.has(r.id)).map(r=>r.id);
let h='<div class="live-head"><h2>Actions</h2><span class="live-dot" data-on="'+(a.length?1:0)+'"></span><span class="live-meta">'+(a.length?a.length+" running":"Nothing running")+' · checked <span data-ago="'+e(data.at)+'">'+ago(data.at)+'</span></span></div>';
if(!data.ok)h+='<div class="group"><div class="line"><span class="hint">Could not read Actions for this repo.</span></div></div>';
if(a.length){h+='<div class="group run-group">'+a.map(r=>{const jobs=r.jobs.map(j=>{const pct=j.steps?Math.round(j.done/j.steps*100):0;
return '<li class="job" data-st="'+e(j.status)+'">'+icon(j.status,j.conclusion)+'<span class="job-name">'+e(j.name)+'</span><span class="job-step">'+(j.status==="in_progress"&&j.step?e(j.step)+' <span class="faint">'+j.done+"/"+j.steps+"</span>":j.status==="completed"?"":"waiting")+'</span><span class="job-time" '+(j.status==="in_progress"&&j.started?'data-since="'+e(j.started)+'"':"")+'>'+(j.started?dur((j.completed?new Date(j.completed):Date.now())-new Date(j.started)):"")+'</span>'+(j.status==="in_progress"?'<span class="job-bar"><i style="width:'+pct+'%"></i></span>':"")+'</li>'}).join("");
return '<div class="run" data-st="'+e(r.status)+'"><a class="run-head" href="'+e(r.url)+'" target="_blank" rel="noopener">'+icon(r.status,r.conclusion)+'<span class="run-main"><span class="run-title">'+e(r.title||r.name)+'</span><span class="run-sub"><b>'+e(r.name)+'</b> #'+r.number+' · '+e(r.event)+(r.actor?" by "+e(r.actor):"")+'</span></span><span class="run-side"><code class="branch">'+e(r.branch)+'</code><span class="run-time"><span class="faint">'+verb(r)+'</span> <span data-since="'+e(r.started)+'">'+dur(Date.now()-new Date(r.started))+'</span></span></span></a>'+(jobs?'<ul class="jobs">'+jobs+'</ul>':"")+'</div>'}).join("")+'</div>'}
if(data.recent.length&&!compact)h+='<div class="recent-label">Recently finished</div><div class="group recent">'+data.recent.map(r=>'<a class="line rrow'+(done.includes(r.id)?" just":"")+'" href="'+e(r.url)+'" target="_blank" rel="noopener"><span class="name">'+icon(r.status,r.conclusion)+'<span>'+e(r.name)+' <span class="faint">#'+r.number+'</span><span class="sub">'+e(r.title)+'</span></span></span><span class="meta"><code class="branch">'+e(r.branch)+'</code><span class="sub">'+dur(new Date(r.updated)-new Date(r.started))+' · '+ago(r.updated)+'</span></span></a>').join("")+'</div>';
b.innerHTML=h}
async function poll(){clearTimeout(timer);if(!document.hidden){try{const r=await fetch(u,{credentials:"same-origin"});if(r.ok){const d=await r.json();const finished=data&&data.active.some(x=>!d.active.some(y=>y.id===x.id));data=d;render();if(d.beats&&document.getElementById("onboard")&&window.level5Pull)window.level5Pull();else if(finished&&window.level5Pull)setTimeout(window.level5Pull,1500)}}catch(e){}}
timer=setTimeout(poll,data&&data.active.length||document.getElementById("onboard")?8e3:3e4)}
setInterval(()=>{document.querySelectorAll(".ci-live [data-since]").forEach(x=>x.textContent=dur(Date.now()-new Date(x.dataset.since)));document.querySelectorAll(".ci-live [data-ago]").forEach(x=>x.textContent=ago(x.dataset.ago))},1e3);
document.addEventListener("level5:swap",render);document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll()});poll()})()</script>`;
const LIVE_RUNS = `<script>(()=>{const box=()=>document.getElementById("lv");let timer,last=null;
const e=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const dur=ms=>{const m=Math.round(ms/6e4);return m<1?Math.round(ms/1e3)+" s":m<60?m+" min":Math.floor(m/60)+" h "+(m%60)+" min"};
const kt=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?Math.round(n/1e3)+"k":String(n);
const ago=t=>dur(Date.now()-t)+" ago";
const FL={loop:"Repeating itself",long:"Running long",burn:"Burning tokens",errors:"Errors piling up"};
const steps=r=>'<div class="lv-steps">'+r.steps.slice().reverse().map(x=>'<div class="lv-step'+(x.ok===false?" bad":"")+'"><span>'+e(x.what)+'</span><small>'+(x.ms?dur(x.ms):"")+" · "+ago(x.t)+"</small></div>").join("")+"</div>"+(r.errs.length?'<div class="lv-errs"><b>Errors</b>'+r.errs.slice().reverse().map(x=>'<div><span>'+e(x.what)+"</span> "+e(x.error)+"</div>").join("")+"</div>":"");
const meta=r=>[r.place,r.tool_calls+" tool calls",kt(r.tokens)+" tokens",r.usd?"US$ "+r.usd.toFixed(2):"",r.errors?r.errors+" errors":"",r.model].filter(Boolean).map(e).join(" · ");
const card=r=>{const st=r.steps[r.steps.length-1];return '<section class="lv-run'+(r.flags.length?" stuck":"")+'"><div class="lv-h"><b>'+e(r.name)+'</b><span class="state" data-s="'+(r.flags.length?"bad":"ok")+'" data-run>'+(r.flags.length?"Looks stuck":"Running")+" · "+dur(r.last_at-r.started_at)+(Date.now()-r.last_at>12e4?" · quiet "+dur(Date.now()-r.last_at):"")+'</span></div><small>'+meta(r)+"</small>"+(r.flags.length?'<p class="lv-flag">'+r.flags.map(f=>"<b>"+e(FL[f.kind]||f.kind)+"</b>: "+e(f.detail)).join("<br>")+"</p>":"")+(st?'<p class="lv-now">Now: '+e(st.what)+" <small>"+ago(st.t)+"</small></p>":"")+"<details><summary>Steps</summary>"+steps(r)+"</details></section>"};
const row=r=>'<details class="lv-row"><summary><span class="name"><b>'+e(r.name)+'</b><small>'+meta(r)+'</small></span><span class="meta">'+(r.flags.length?'<span class="state" data-s="bad">'+e(FL[r.flags[0].kind]||"Stuck")+"</span> ":"")+dur(r.last_at-r.started_at)+" · ended "+ago(r.last_at)+"</span></summary>"+steps(r)+"</details>";
function draw(d){const b=box();if(!b)return;const n=document.getElementById("lv-n");if(n)n.textContent=d.running.length?d.running.length+" running":"";
b.innerHTML=(d.running.length?'<h2>Running now</h2><div class="lv-grid">'+d.running.map(card).join("")+"</div>":'<div class="group"><div class="line"><span class="hint">Nothing running right now.'+(d.recent.length?"":" Once a routine or an agent reports here, it shows while it runs.")+"</span></div></div>")+(d.recent.length?'<h2>Last 24 hours <span class="faint">'+d.recent.length+'</span></h2><div class="group lv-recent">'+d.recent.map(row).join("")+"</div>":"")}
async function pull(){clearTimeout(timer);const b=box();if(!b)return;const on=document.documentElement.dataset.view==="live";if(on||!last){try{const r=await fetch("/r/"+b.dataset.repo+"/runs",{credentials:"same-origin"});if(r.ok){last=await r.json();const open=[...b.querySelectorAll("details")].map(x=>x.open);draw(last);b.querySelectorAll("details").forEach((x,i)=>{if(open[i])x.open=true})}}catch(x){}}timer=setTimeout(pull,on?5e3:6e4)}
document.addEventListener("level5:swap",()=>{if(last)draw(last);pull()});addEventListener("hashchange",pull);pull()})()</script>`;
const VIEWS = ["status", "live", "monitors", "automations", "ci", "prs", "issues", "costs", "marketing", "reports", "services", "setup"];
const VIEW_HEAD = `<script>(()=>{const v=location.hash.slice(1);document.documentElement.dataset.view=${JSON.stringify(VIEWS)}.includes(v)?v:"status"})()</script>`;
const VIEW_CSS = `.view{display:none}` + VIEWS.map((v) => `html[data-view=${v}] .view[data-view=${v}]{display:block}html[data-view=${v}] [data-nav=${v}]{background:var(--sel);color:var(--ink);font-weight:500}html[data-view=${v}] [data-nav=${v}] .ni{color:var(--link)}`).join("");
const VIEW_JS = `<script>(()=>{const V=${JSON.stringify(VIEWS)};const set=()=>{const v=location.hash.slice(1);document.documentElement.dataset.view=V.includes(v)?v:"status"};
addEventListener("hashchange",()=>{set();scrollTo(0,0)});document.addEventListener("level5:swap",set)})()</script>`;
const ASK_MODEL = process.env.LEVEL5_MODEL || "openai/gpt-6.1-sol";
const ASK_JS = `<script>(()=>{const S=window.level5Chat||(window.level5Chat={msgs:[],busy:false,draft:""});
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
const H=document.documentElement,K="level5-ask",open=o=>{if(o)H.dataset.ask="1";else delete H.dataset.ask;try{localStorage.setItem(K,o?"1":"")}catch(x){}if(o)setTimeout(()=>{const i=document.getElementById("ask-input");if(i)i.focus()},0)};
try{if(localStorage.getItem(K))H.dataset.ask="1"}catch(x){}if(location.hash==="#assistant"){open(true);history.replaceState(null,"",location.pathname+location.search+"#status")}
document.addEventListener("click",ev=>{const t=ev.target.closest&&ev.target.closest("[data-ask-toggle]");if(t){open(!H.dataset.ask);return}const c=ev.target.closest&&ev.target.closest(".chip");if(c){open(true);ask(c.dataset.q)}});
document.addEventListener("keydown",ev=>{if(ev.key==="Escape"&&H.dataset.ask&&ev.target.closest&&ev.target.closest("#chat"))open(false)});
document.addEventListener("level5:swap",draw);draw()})()</script>`;
// Floating windows, after the admin's PanelHost (docs/admin/crud-panel.md → Windows): one click on
// an entity opens its own window; the same entity never opens twice (it comes to the front);
// windows are dragged by the title bar, resized from any edge (min 380×280), cascade 28 px from
// the right, take focus on pointer-down, minimize to a dock, never zoom, never dim the page.
// They live on <body>, outside the page, so section changes and background refreshes keep them;
// their contents come from the page's <template>s and are refreshed with it. The open set is in
// the URL (?w=), so a link reopens them. On a phone each window is a full-screen sheet.
const WIN_JS = `<script>(()=>{const W=window.level5Win||(window.level5Win={list:[],frames:{}});
const MINW=380,MINH=280,STEP=28,TOP=56;
const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const tpl=k=>[...document.querySelectorAll("#win-tpl template")].find(t=>t.dataset.key===k);
const phone=()=>matchMedia("(max-width:820px)").matches;
const ICON={min:'<svg viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>',close:'<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',gh:'<svg viewBox="0 0 16 16"><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4"/></svg>'};
function dockEl(){let d=document.getElementById("win-dock");if(!d){d=document.createElement("div");d.id="win-dock";d.className="win-dock";document.body.appendChild(d)}return d}
function syncUrl(){const u=new URL(location.href);const ks=W.list.filter(w=>!w.ad).map(w=>w.key);ks.length?u.searchParams.set("w",ks.join(",")):u.searchParams.delete("w");if(u.href!==location.href)history.replaceState(history.state,"",u)}
function order(){const vis=W.list.filter(w=>!w.min);vis.forEach((w,i)=>{w.el.style.zIndex=50+Math.min(i,140);w.el.classList.toggle("active",i===vis.length-1)})}
function renderDock(){const d=dockEl();const mins=W.list.filter(w=>w.min);d.innerHTML=mins.map(w=>'<button type="button" class="win-chip" data-key="'+esc(w.key)+'"><span>'+esc(w.kind)+'</span> '+esc(w.title)+"</button>").join("");d.hidden=!mins.length}
function clamp(f){const vw=innerWidth,vh=innerHeight;f.w=Math.max(MINW,Math.min(f.w,vw-16));f.h=Math.max(MINH,Math.min(f.h,vh-TOP-8));f.x=Math.max(8-f.w+120,Math.min(f.x,vw-120));f.y=Math.max(TOP-6,Math.min(f.y,vh-40));return f}
function place(w){if(phone()){w.el.removeAttribute("style");order();return}const f=clamp(W.frames[w.key]);Object.assign(w.el.style,{left:f.x+"px",top:f.y+"px",width:f.w+"px",height:f.h+"px"});order()}
function fill(w){if(w.ad)return;const t=tpl(w.key),b=w.el.querySelector(".win-body");if(t){const st=b.scrollTop;b.replaceChildren(t.content.cloneNode(true));b.scrollTop=st;if(window.level5Local)window.level5Local();w.el.classList.remove("gone");w.title=t.dataset.title;w.el.querySelector(".win-title").textContent=t.dataset.title}else w.el.classList.add("gone")}
function focus(w){W.list.splice(W.list.indexOf(w),1);W.list.push(w);if(w.min){w.min=false;w.el.hidden=false;renderDock()}order()}
function close(w){w.el.remove();W.list.splice(W.list.indexOf(w),1);order();renderDock();syncUrl()}
function open(key,quiet){const had=W.list.find(w=>w.key===key);if(had){focus(had);return true}const ad=W.adhoc&&W.adhoc[key];const t=ad?{dataset:{kind:ad.kind,title:ad.title,href:""}}:tpl(key);if(!t)return false;
const n=W.list.filter(w=>!w.min).length,vw=innerWidth,vh=innerHeight,ww=Math.min(620,Math.max(MINW,vw*.42));
W.frames[key]=W.frames[key]||{w:ww,h:vh-TOP-24-n*STEP,x:vw-ww-20-n*STEP,y:TOP+8+n*STEP};
const el=document.createElement("section");el.className="win";el.setAttribute("role","dialog");el.setAttribute("aria-label",t.dataset.kind+" "+t.dataset.title);
el.innerHTML='<header class="win-bar"><span class="win-kind">'+esc(t.dataset.kind)+'</span><b class="win-title"></b><span class="win-acts">'+(t.dataset.href?'<a class="win-btn" data-no-drag href="'+esc(t.dataset.href)+'" target="_blank" rel="noopener" title="Open on GitHub">'+ICON.gh+"</a>":"")+'<button type="button" class="win-btn" data-act="min" title="Minimize">'+ICON.min+'</button><button type="button" class="win-btn" data-act="close" title="Close">'+ICON.close+'</button></span></header><div class="win-body"></div><div class="win-gone">No longer in this page\\'s data.</div>'+["n","s","e","w","ne","nw","se","sw"].map(d=>'<i class="win-rz" data-dir="'+d+'"></i>').join("");
document.body.appendChild(el);const w={key,el,kind:t.dataset.kind,title:t.dataset.title,min:false,msgs:[],ad};if(ad)el.classList.add("adhoc");W.list.push(w);fill(w);place(w);if(!quiet)syncUrl();
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
const o=ev.target.closest("[data-open]");if(!o)return;if(ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;
const inner=ev.target.closest("a,button");if(inner&&inner!==o&&!inner.hasAttribute("data-open"))return;if(open(o.dataset.open))ev.preventDefault()});
document.addEventListener("keydown",ev=>{if((ev.key==="Enter"||ev.key===" ")&&ev.target.matches&&ev.target.matches("[data-open][tabindex]")){ev.preventDefault();open(ev.target.dataset.open)}
if(ev.key==="Escape"&&!ev.target.closest("input,textarea")){const top=W.list.filter(w=>!w.min).at(-1);if(top)close(top)}});
document.addEventListener("level5:swap",()=>W.list.forEach(fill));addEventListener("resize",()=>W.list.forEach(place));
window.level5Open=k=>open(k);if(!W.started){W.started=true;(new URL(location.href).searchParams.get("w")||"").split(",").filter(Boolean).forEach(k=>open(k,true));syncUrl()}})()</script>`;
// The bell: polls /api/notifications every minute; opening the panel marks everything read. The
// panel lives on <body> so background refreshes do not close it. A click on an entry goes to the
// repo and opens the entity's window (in place when it is the repo on screen).
const NOTIF_JS = `<script>(()=>{const N=window.level5Notif||(window.level5Notif={data:null});
const e=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago=t=>{const m=Math.round((Date.now()-new Date(t))/6e4);return m<1?"just now":m<60?m+" min ago":m<1440?Math.round(m/60)+" h ago":Math.round(m/1440)+" d ago"};
const VIEW={run:"live",monitor:"monitors",routine:"automations",workflow:"ci",pr:"prs",issue:"issues",cost:"costs",rule:"costs",promotion:"ci",security:"status"};
function badge(){const b=document.querySelector("#tb-bell .tb-count");if(!b)return;const n=N.data?N.data.unread:0;b.hidden=!n;b.textContent=n>9?"9+":n}
function panel(){let p=document.getElementById("notif-panel");if(!p){p=document.createElement("div");p.id="notif-panel";p.className="notif";p.hidden=true;document.body.appendChild(p)}return p}
function draw(){const p=panel(),d=N.data;p.innerHTML='<div class="notif-h"><b>Notifications</b>'+(d&&d.unread?'<button type="button" class="notif-all">Mark all as read</button>':'<span class="faint">'+(d&&d.items.length?"All caught up":"")+"</span>")+"</div>"+(d&&d.items.length?'<div class="notif-list">'+d.items.map(x=>'<a class="notif-i'+(x.unread?" unread":"")+'" data-id="'+x.id+'" data-lvl="'+e(x.level)+'" href="/r/'+e(x.repo)+(x.entity?"?w="+encodeURIComponent(x.entity):"")+"#"+(VIEW[x.kind]||"status")+'" data-repo="'+e(x.repo)+'" data-entity="'+e(x.entity)+'"><i></i><span><b>'+e(x.title)+"</b>"+(x.detail?'<span class="nd">'+e(x.detail)+"</span>":"")+'<span class="nm">'+e(x.repo)+" · "+ago(x.at)+"</span></span></a>").join("")+"</div>":'<div class="notif-empty">Nothing yet. An entry appears when a monitor changes state, a routine runs late, CI breaks or recovers, a PR is opened or merged, an issue opens, or spend jumps.</div>')}
async function load(){try{const r=await fetch("/api/notifications",{credentials:"same-origin"});if(r.ok){N.data=await r.json();badge();if(!panel().hidden)draw()}}catch(x){}}
function toggle(show){const p=panel(),b=document.getElementById("tb-bell");if(show===undefined)show=p.hidden;p.hidden=!show;if(b)b.setAttribute("aria-expanded",show);if(show)draw()}
function mark(ids){if(!N.data)return;const all=!ids;N.data.items.forEach(x=>{if(all||ids.includes(x.id))x.unread=false});N.data.unread=N.data.items.filter(x=>x.unread).length;badge();if(!panel().hidden)draw();
fetch("/api/notifications",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(all?{all:true}:{ids})})}
document.addEventListener("click",ev=>{if(ev.target.closest("#tb-bell")){ev.preventDefault();toggle();return}
if(ev.target.closest(".notif-all")){ev.preventDefault();mark();return}
const a=ev.target.closest(".notif-i");if(a){if(a.classList.contains("unread"))mark([+a.dataset.id]);const here=location.pathname.replace(/[/]$/,"")==="/r/"+a.dataset.repo;if(here&&window.level5Open&&!ev.metaKey&&!ev.ctrlKey){ev.preventDefault();toggle(false);location.hash=a.hash.slice(1);if(a.dataset.entity)window.level5Open(a.dataset.entity)}return}
if(!ev.target.closest("#notif-panel"))toggle(false)});
document.addEventListener("keydown",ev=>{if(ev.key==="Escape")toggle(false)});
document.addEventListener("level5:swap",badge);if(!N.started){N.started=true;load();setInterval(()=>{if(!document.hidden)load()},6e4)}else badge()})()</script>`;
// Routines from Level 5: fill each .rt-fire box with its trigger (save one, run now, remove it), and
// turn the New routine form into a /level5:new-monitor command to copy.
const TRIG_JS = `<script>(()=>{if(window.level5Trig)return;window.level5Trig=1;
const base=()=>location.pathname.replace(/[/]$/,"");let cache=null,at=0;
const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago=t=>{const m=Math.round((Date.now()-new Date(t))/6e4);return m<1?"just now":m<60?m+" min ago":m<1440?Math.round(m/60)+" h ago":Math.round(m/1440)+" d ago"};
async function load(force){if(!force&&cache&&Date.now()-at<15e3)return cache;const r=await fetch(base()+"/triggers",{credentials:"same-origin"});cache=r.ok?await r.json():{};at=Date.now();return cache}
async function post(path,body){const r=await fetch(base()+path,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
function draw(box,t){
if(box.dataset.mini&&t){box.innerHTML='<p class="rt-hint">Connected. <b>Resolve with Claude</b> on any issue starts a session on your Claude account. <button class="btn-plain danger" type="button" data-rt-remove>Remove trigger</button></p>';return}
if(!t){box.innerHTML=(box.dataset.mini?'':'<p class="rt-hint">Give this routine an API trigger on claude.ai (open the routine, add a trigger, choose API), then paste its URL and token here. Level 5 keeps the token sealed and only uses it to start the routine.</p>')+'<form class="rt-form"><input name="url" placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire" required><input name="token" type="password" placeholder="sk-ant-…" required autocomplete="off"><div class="rt-row"><button class="btn-sm" type="submit">Save trigger</button><span class="rt-msg"></span></div></form>';return}
const last=t.last_fired_at?(t.last_error?"Last try "+ago(t.last_fired_at)+": "+e(t.last_error):"Last started "+ago(t.last_fired_at)+" by "+e(t.last_fired_by)+(t.last_session_url?' · <a href="'+e(t.last_session_url)+'" target="_blank" rel="noopener">open the session</a>':"")):"Trigger saved "+ago(t.created_at)+" by "+e(t.created_by);
box.innerHTML='<form class="rt-run"><textarea name="text" rows="2" placeholder="Optional: what this run should look at (an issue, a PR, an alert)"></textarea><div class="rt-row"><button class="btn-sm" type="submit">Run now</button><span class="rt-msg">'+last+'</span><button class="btn-plain danger" type="button" data-rt-remove>Remove trigger</button></div></form>'}
async function sync(force){const boxes=[...document.querySelectorAll(".rt-fire")].filter(b=>force||!b.dataset.ready);if(!boxes.length)return;boxes.forEach(b=>b.dataset.ready=1);const all=await load(force).catch(()=>({}));boxes.forEach(b=>draw(b,all[b.dataset.routine]))}
new MutationObserver(()=>sync(false)).observe(document.body,{childList:true,subtree:true});sync(false);
document.addEventListener("submit",async ev=>{const f=ev.target,box=f.closest&&f.closest(".rt-fire");if(!box)return;ev.preventDefault();const msg=f.querySelector(".rt-msg"),btn=f.querySelector("[type=submit]");btn.disabled=true;
try{if(f.classList.contains("rt-form")){msg.textContent="Saving…";await post("/triggers",{routine:box.dataset.routine,url:f.elements.url.value,token:f.elements.token.value})}else{msg.textContent="Starting…";await post("/fire",{routine:box.dataset.routine,text:f.elements.text.value})}
await sync(true)}catch(x){msg.textContent=x.message;btn.disabled=false}});
document.addEventListener("click",async ev=>{const b=ev.target.closest&&ev.target.closest("[data-rt-remove]");if(!b)return;if(!b.dataset.sure){b.dataset.sure=1;b.textContent="Click again to remove";return}const box=b.closest(".rt-fire");await post("/triggers",{routine:box.dataset.routine,remove:true}).catch(()=>{});sync(true)});
const RUN="Level 5: Run";
function setup(){const p=document.getElementById("rz-setup");if(!p)return;p.hidden=false;sync(true);p.scrollIntoView({behavior:"smooth",block:"center"})}
document.addEventListener("click",ev=>{const b=ev.target.closest&&ev.target.closest("[data-resolve]");if(!b)return;ev.preventDefault();ev.stopPropagation();
if(cache&&!cache[RUN]){setup();return}
const w=window.open("","_blank");if(w)w.document.write('<title>Starting Claude</title><p style="font:15px system-ui;padding:24px">Starting a Claude Code session on issue #'+e(b.dataset.resolve)+'…</p>');
const old=b.textContent;b.disabled=true;b.textContent="Starting…";
post("/fire",{routine:RUN,text:"Resolve issue #"+b.dataset.resolve+": "+b.dataset.title+"\\n"+b.dataset.url}).then(j=>{b.textContent="Started";cache=null;if(j.session_url){if(w)w.location=j.session_url;else window.open(j.session_url,"_blank")}else if(w)w.close()}).catch(x=>{if(w)w.close();if(/no API trigger/.test(x.message))setup();b.textContent=/no API trigger/.test(x.message)?old:x.message}).finally(()=>setTimeout(()=>{b.disabled=false;b.textContent=old},5000))});
const q=s=>'"'+String(s).replace(/["\\\\]/g,"")+'"';
function cmd(f){const v=n=>f.elements[n].value.trim(),custom=v("preset")==="custom",cron=custom?v("cron"):v("preset");f.querySelector("[data-cron]").hidden=!custom;
f.querySelector("[data-cmd]").textContent=v("name")&&v("what")?"/level5:new-monitor "+q(v("name"))+" --cron "+q(cron||"0 13 * * *")+" --model "+v("model")+" -- "+v("what").replace(/\\s+/g," "):"Fill in a name and what it does."}
["input","change"].forEach(t=>document.addEventListener(t,ev=>{const f=ev.target.closest&&ev.target.closest(".nr-form");if(f)cmd(f)}));
document.addEventListener("click",async ev=>{const b=ev.target.closest&&ev.target.closest("[data-nr-copy]");if(!b)return;const t=b.closest(".nr-form").querySelector("[data-cmd]").textContent;if(!t.startsWith("/"))return;try{await navigator.clipboard.writeText(t);b.textContent="Copied"}catch(x){}});
})()</script>`;
const RULES_JS = `<script>(()=>{if(window.level5Rules)return;window.level5Rules=1;
const base=()=>location.pathname.replace(/[/]$/,"")+"/rules";
function deps(f){const v=n=>f.elements[n]&&f.elements[n].value;const sess=v("measure")==="session_tokens",fc=v("period")==="forecast",spike=!sess&&!fc&&v("cond")==="spike";
f.querySelectorAll("[data-show]").forEach(l=>{const k=l.dataset.show;l.hidden=k==="period"?sess:k==="cond"?(sess||fc):k==="amount"?spike:k==="spike"?!spike:k==="service"?v("measure")!=="usd":false})}
const sync=()=>document.querySelectorAll(".rule-form").forEach(deps);
document.addEventListener("change",ev=>{const f=ev.target.closest&&ev.target.closest(".rule-form");if(f)deps(f)});
const obs=new MutationObserver(sync);obs.observe(document.body,{childList:true,subtree:true});sync();
async function post(url,body){const r=await fetch(url,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:body?JSON.stringify(body):"{}"});if(!r.ok)throw new Error(await r.text());if(window.level5Pull)await window.level5Pull()}
document.addEventListener("submit",async ev=>{const n=ev.target.closest(".rule-nl");if(!n)return;ev.preventDefault();const i=n.elements.text,btn=n.querySelector("button"),msg=document.querySelector(".rule-msg");if(!i.value.trim())return;btn.disabled=true;msg.textContent="Reading it…";
try{const r=await fetch(base(),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({text:i.value})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);i.value="";msg.textContent="Added.";if(window.level5Pull)await window.level5Pull()}catch(x){msg.textContent="Could not make a rule from that: "+x.message}btn.disabled=false});
document.addEventListener("submit",async ev=>{const f=ev.target.closest(".rule-form");if(!f)return;ev.preventDefault();const fd=new FormData(f),b={};for(const [k,v] of fd)if(k!=="dow")b[k]=v;b.dow=fd.getAll("dow").map(Number);
const msg=f.querySelector(".f-msg"),btn=f.querySelector("[type=submit]");btn.disabled=true;msg.textContent="Saving…";
try{await post(base()+(f.dataset.ruleId?"/"+f.dataset.ruleId:""),b);msg.textContent="Saved.";if(!f.dataset.ruleId){const w=f.closest(".win");w&&w.querySelector('[data-act="close"]').click()}}catch(x){msg.textContent="Could not save: "+x.message}btn.disabled=false});
document.addEventListener("click",async ev=>{const b=ev.target.closest("[data-rule-act]");if(!b)return;ev.preventDefault();ev.stopPropagation();const act=b.dataset.ruleAct,id=b.dataset.id;
if(act==="delete"&&!b.dataset.sure){b.dataset.sure=1;b.textContent="Click again to delete";return}b.disabled=true;
try{await post(base()+"/"+id+"/"+act);if(act==="delete"){const w=b.closest(".win");w&&w.querySelector('[data-act="close"]').click()}}catch(x){b.textContent="Failed"}b.disabled=false},true)})()</script>`;
const MAP_JS = `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
// The services as the landing's factory: the same industrial park (grass to the fog, an asphalt
// yard, the plant's concrete slab), and every service it pays for is a hall on it, corrugated
// walls, a sawtooth roof, a band in its district's colour and its name over the door. Footprint and
// height come from 30-day spend; the halls stand in rows facing a yard road where trucks run. A
// service with a price rule firing gets a red beacon on the roof. Physical materials, soft shadows,
// ambient occlusion and a little bloom, as on the landing; without post-processing it renders flatter.
const M = window.level5Map || (window.level5Map = {});
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const DISTRICTS = [
  ["run", 0x5f9e6e, /container|fargate|ec2|compute|lambda|app runner|batch|vercel|fly|lightsail|elastic beanstalk/i],
  ["edge", 0x4f9a7a, /cloudfront|vpc|virtual private cloud|route ?53|load balanc|api gateway|nat|direct connect|global accel|cloudflare/i],
  ["data", 0x5b8ab8, /s3|storage|rds|relational|aurora|dynamo|elasticache|neon|backup|efs|redshift|opensearch|database|supabase/i],
  ["ai", 0x7d6bb4, /bedrock|transcribe|sagemaker|rekognition|polly|textract|comprehend|claude|anthropic|openai|translate/i],
  ["ship", 0x5a7fa8, /codebuild|ecr|registry|codepipeline|codedeploy|amplify/i],
  ["watch", 0xc9a447, /cloudwatch|cloudtrail|kms|key management|secrets|systems manager|iam|cost explorer|config|guardduty|security hub|x-ray/i],
  ["talk", 0xb8665f, /ses|email|sns|notification|sqs|queue|eventbridge|pinpoint|twilio|chime/i],
];
const district = (s) => DISTRICTS.find(([, , re]) => re.test(s.name + " " + s.provider)) || ["other", 0x8a8f96];
const nice = (s) => s.name.replace(/^(Amazon|AWS) /, "").replace(/Elastic Container Service/, "ECS").replace(/Simple Storage Service/, "S3").replace(/Relational Database Service/, "RDS").replace(/Simple Email Service/, "SES").replace(/Elastic Compute Cloud - Compute/, "EC2").replace(/Virtual Private Cloud/, "VPC").replace(/Key Management Service/, "KMS").replace(/Elastic Container Registry \\(ECR\\)/, "ECR").replace(/^AmazonCloudTrail$|^CloudTrail$/, "CloudTrail").replace(/^Amazon/, "").replace(/Systems Manager/, "Parameter Store").replace(/Claude Code sessions/, "Claude Code").replace(/ \\(Amazon Bedrock Edition\\)/, " on Bedrock");
async function build() {
  const host = document.getElementById("svc-map"), dataEl = document.getElementById("map-data");
  if (!host || !dataEl || document.documentElement.dataset.view !== "services") return;
  if (M.host === host) return;
  M.dispose?.();
  M.host = host;
  let THREE, OrbitControls, RoomEnvironment, RoundedBoxGeometry, PP = null;
  try {
    THREE = await import("three");
    ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
    ({ RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js"));
    ({ RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js"));
  } catch { M.host = null; host.querySelector(".map-hint").textContent = "The 3D map could not load. The list below has the same numbers."; return; }
  try {
    const [a, b, c, d, e] = await Promise.all(["EffectComposer", "RenderPass", "GTAOPass", "UnrealBloomPass", "OutputPass"].map((n) => import("three/addons/postprocessing/" + n + ".js")));
    PP = { EffectComposer: a.EffectComposer, RenderPass: b.RenderPass, GTAOPass: c.GTAOPass, UnrealBloomPass: d.UnrealBloomPass, OutputPass: e.OutputPass };
  } catch {}
  if (M.host !== host || !host.isConnected) return; // swapped away while loading
  const services = JSON.parse(dataEl.textContent).services;
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
  const asphaltC = cv(256, 256, (g, w, h) => noise(g, w, h, "#55575c", 50, 12000, 1.6));
  const grass = tex(cv(256, 256, (g, w, h) => noise(g, w, h, "#7f9a5e", 60, 16000, 2)), 40, 40);
  const corrV = tex(cv(256, 64, (g, w, h) => { for (let x = 0; x < w; x++) { const v = 128 + 110 * Math.sin((x / w) * Math.PI * 32); g.fillStyle = "rgb(" + v + "," + v + "," + v + ")"; g.fillRect(x, 0, 1, h); } }), 3, 1, false);
  const sky = new THREE.CanvasTexture(cv(16, 512, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#9fb8d6"); gr.addColorStop(0.55, "#d8e1ea"); gr.addColorStop(1, "#ece8e2"); g.fillStyle = gr; g.fillRect(0, 0, w, h); }));
  sky.colorSpace = THREE.SRGBColorSpace; scene.background = sky;

  const Mat = (color, rough = 0.7, metal = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  const mat = {
    grass: Mat(0xffffff, 1, 0, { map: grass }), curb: Mat(0xbdb8ae, 0.9), plinth: Mat(0x9c978d, 0.9),
    wall: Mat(0xeceae5, 0.55, 0.35, { bumpMap: corrV, bumpScale: 1.2 }), steel: Mat(0xa3a8b1, 0.3, 0.9), dark: Mat(0x2a2e38, 0.45, 0.3),
    roof: Mat(0xb9bdc4, 0.42, 0.75, { bumpMap: corrV, bumpScale: 0.8 }), glass: Mat(0x6f8fb3, 0.04, 0.95), paint: Mat(0xe8b83c, 0.6),
    white: Mat(0xf4f4f2, 0.42), crate: Mat(0xc29660, 0.88), pallet: Mat(0x9d7a4f, 0.92), tire: Mat(0x18191c, 0.92), visor: Mat(0x111318, 0.08, 0.7),
    trunk: Mat(0x6b5640, 0.95), leaf: Mat(0x4f7a3f, 0.9), leaf2: Mat(0x5f8a46, 0.9), hvac: Mat(0xc8cbd0, 0.5, 0.6), orange: Mat(0xf2702c, 0.45),
  };
  const add = (geo, m, x, y, z, parent = scene, cast = true) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = cast; o.receiveShadow = true; parent.add(o); return o; };
  const rbox = (w, h, d, r = 0.08) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2));
  const group = (x, y, z, parent = scene) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
  const hex = (c) => "#" + c.toString(16).padStart(6, "0");
  const sign = (txt, w, h, bg) => {
    const c = cv(1024, Math.round(1024 * h / w), (g, cw, ch) => {
      g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, cw, ch, ch * 0.16); g.fill();
      let fs = Math.round(ch * 0.5); g.font = "600 " + fs + "px Geist, Inter, system-ui, sans-serif";
      while (fs > 12 && g.measureText(txt).width > cw * 0.9) { fs -= 2; g.font = "600 " + fs + "px Geist, Inter, system-ui, sans-serif"; }
      g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, cw / 2, ch * 0.54);
    });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), Mat(0xffffff, 0.5, 0, { map: t }));
  };

  // ---- the plan: districts in order, biggest first, packed into rows; each row faces a yard road
  const max = Math.max(1e-9, ...services.map((s) => s.total));
  const items = services.map((s) => ({ s, d: district(s) }))
    .sort((a, b) => DISTRICTS.findIndex((x) => x[0] === a.d[0]) - DISTRICTS.findIndex((x) => x[0] === b.d[0]) || b.s.total - a.s.total)
    .map((it) => { const k = Math.sqrt(it.s.total / max); return { ...it, k, w: 3.2 + 3.6 * k, dd: 3.6 + 3.4 * k, h: 1.5 + 4.4 * k }; });
  const GAP = 1.3, ROAD = 4.2, SETBACK = 1.6;
  const ROWW = Math.max(22, Math.sqrt(items.reduce((a, it) => a + (it.w + GAP) * (it.dd + ROAD + SETBACK), 0)) * 1.25);
  const rows = []; let row = null;
  for (const it of items) { if (!row || row.x + it.w > ROWW) rows.push((row = { x: 0, items: [], depth: 0 })); it.x = row.x + it.w / 2; row.x += it.w + GAP; row.depth = Math.max(row.depth, it.dd); row.items.push(it); }
  let zc = 0; const roads = [];
  for (const r of rows) { for (const it of r.items) it.z = zc + r.depth - it.dd / 2; r.road = zc + r.depth + SETBACK + ROAD / 2; r.width = r.x - GAP; roads.push(r); zc = r.road + ROAD / 2 + 2.2; }
  const PW = Math.max(...rows.map((r) => r.width)), PD = zc - 2.2;
  for (const r of rows) { const sh = (PW - r.width) / 2; for (const it of r.items) it.x += sh - PW / 2; r.road -= PD / 2; for (const it of r.items) it.z -= PD / 2; }
  const SW = PW + 5, SD = PD + 4, R = Math.hypot(SW, SD) / 2;

  // ---- light: a warm low sun, a sky/grass bounce, studio reflections for the metal
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture; scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xcfe0f5, 0x6f7a55, 0.75));
  const sun = new THREE.DirectionalLight(0xffeedb, 2.5);
  sun.position.set(-R * 0.9, R * 1.2, R * 0.7); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -R * 1.15, right: R * 1.15, top: R * 1.15, bottom: -R * 1.15, near: 1, far: R * 4 });
  sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.025; sun.shadow.radius = 3;
  scene.add(sun);

  // ---- the park: grass to the fog, an asphalt yard, the plant's concrete slab on a plinth
  add(new THREE.PlaneGeometry(600, 600), mat.grass, 0, -0.02, 0, scene, false).rotation.x = -Math.PI / 2;
  add(new THREE.BoxGeometry(SW + 14, 0.1, SD + 12), Mat(0xffffff, 0.95, 0, { map: tex(asphaltC, (SW + 14) / 3, (SD + 12) / 3) }), 0, 0, 0, scene, false);
  add(new THREE.BoxGeometry(SW + 14.4, 0.14, 0.3), mat.curb, 0, 0.02, (SD + 12) / 2 + 0.1, scene, false);
  add(new THREE.BoxGeometry(SW, 0.5, SD), mat.plinth, 0, 0.2, 0, scene, false);
  add(new THREE.BoxGeometry(SW - 0.4, 0.06, SD - 0.4), Mat(0xffffff, 0.92, 0, { map: tex(concreteC, SW / 8, SD / 8), roughnessMap: tex(concreteC, SW / 8, SD / 8, false) }), 0, 0.47, 0, scene, false);
  const Y0 = 0.5;
  const stripe = (x, z, w, d, m = mat.paint) => add(new THREE.BoxGeometry(w, 0.01, d), m, x, Y0 + 0.006, z, scene, false);
  for (const r of roads) {
    add(new THREE.BoxGeometry(SW - 0.6, 0.02, ROAD), Mat(0xffffff, 0.95, 0, { map: tex(asphaltC, SW / 3, ROAD / 3) }), 0, Y0 + 0.01, r.road, scene, false);
    stripe(0, r.road - ROAD / 2 - 0.15, SW - 0.6, 0.09); stripe(0, r.road + ROAD / 2 + 0.15, SW - 0.6, 0.09);
    for (let x = -SW / 2 + 1; x < SW / 2 - 1; x += 1.6) stripe(x, r.road, 0.8, 0.1, mat.white);
  }

  // ---- the halls: one per service, corrugated walls, a window band, sawtooth roofs with north lights
  const picks = [], tags = [], halls = [], beacons = [];
  for (const it of items) {
    const { s, d, k, w, dd, h } = it, color = d[1];
    const g = group(it.x, Y0, it.z);
    add(new THREE.BoxGeometry(w + 0.1, 0.3, dd + 0.1), mat.plinth, 0, 0.15, 0, g);
    add(rbox(w, h, dd, 0.05), mat.wall, 0, h / 2 + 0.2, 0, g);
    const band = add(new THREE.BoxGeometry(w + 0.03, 0.4, dd + 0.03), Mat(s.alarm ? 0xd13212 : color, 0.45, 0.2), 0, h - 0.1, 0, g);
    if (h > 2.2) {
      for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.5, dd - 1), mat.glass, side * (w / 2 + 0.01), h - 0.75, 0, g, false);
      for (let i = 0; i < Math.round(w / 1.6); i++) add(new THREE.BoxGeometry(1.0, 0.5, 0.02), mat.glass, -w / 2 + 0.9 + i * 1.6, h - 0.75, -dd / 2 - 0.01, g, false);
    }
    const teeth = Math.max(2, Math.round(dd / 2.4)), td = dd / teeth, rise = 0.5 + 0.6 * k, slope = Math.hypot(td, rise), ang = Math.atan2(rise, td);
    for (let i = 0; i < teeth; i++) {
      const z0 = -dd / 2 + i * td;
      add(new THREE.BoxGeometry(w + 0.1, 0.08, slope), mat.roof, 0, h + 0.2 + rise / 2, z0 + td / 2, g).rotation.x = ang;
      add(new THREE.BoxGeometry(w - 0.1, rise, 0.05), mat.glass, 0, h + 0.2 + rise / 2, z0 + 0.03, g);
      for (const side of [-1, 1]) { const tri = new THREE.Shape(); tri.moveTo(0, 0); tri.lineTo(td, 0); tri.lineTo(0, rise); const e = add(new THREE.ExtrudeGeometry(tri, { depth: 0.06, bevelEnabled: false }), mat.wall, 0, h + 0.2, z0, g); e.rotation.y = -Math.PI / 2; e.position.x = side * (w / 2) + (side > 0 ? 0 : 0.06); }
    }
    const dw = Math.min(2.2, w * 0.45), dh = Math.min(2.3, h * 0.55);
    add(new THREE.BoxGeometry(dw, dh, 0.08), mat.steel, 0, 0.2 + dh / 2, dd / 2 + 0.04, g);
    for (let i = 1; i < 10; i++) add(new THREE.BoxGeometry(dw, 0.02, 0.02), mat.dark, 0, 0.2 + i * dh / 10, dd / 2 + 0.09, g, false);
    add(new THREE.BoxGeometry(dw + 0.4, 0.1, 0.6), mat.dark, 0, 0.3 + dh, dd / 2 + 0.3, g); // canopy
    const sg = sign(nice(s), Math.min(w - 0.6, 4.2), 0.34 + 0.3 * k, hex(s.alarm ? 0xd13212 : color)); sg.position.set(0, h - 0.1, dd / 2 + 0.03); g.add(sg);
    if (k > 0.3) for (let i = 0; i < 2; i++) { const u = group(-w / 4 + i * (w / 2), h + 0.2 + rise + 0.05, -dd / 2 + 1.2, g); add(rbox(1.0, 0.5, 0.8, 0.06), mat.hvac, 0, 0.25, 0, u); add(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 24), mat.dark, 0, 0.51, 0, u); }
    if (k > 0.55) add(new THREE.CylinderGeometry(0.16, 0.16, h + 2.2, 16), mat.steel, w / 2 - 0.45, (h + 2.2) / 2, -dd / 2 + 0.5, g); // flue
    if (w > 4) { const pl = group(w / 2 - 0.8, 0.3, dd / 2 + 0.9, g); add(new THREE.BoxGeometry(1.0, 0.14, 1.0), mat.pallet, 0, 0.07, 0, pl); for (let j = 0; j < 3; j++) add(rbox(0.45, 0.38, 0.45, 0.03), mat.crate, (j % 2) * 0.46 - 0.23, 0.33 + Math.floor(j / 2) * 0.38, j < 2 ? -0.23 : 0.2, pl); }
    if (s.alarm) { // a red beacon on the roof, flashing
      const lm = Mat(0xff3b3b, 0.25, 0, { emissive: 0xff3b3b, emissiveIntensity: 2.2 });
      add(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 10), mat.steel, 0, h + 0.2 + rise + 0.45, 0, g);
      add(new THREE.SphereGeometry(0.26, 24, 16), lm, 0, h + 0.2 + rise + 1.0, 0, g, false);
      const light = new THREE.PointLight(0xff3b3b, 9, 8, 2); light.position.set(0, h + rise + 1.2, 0); g.add(light);
      beacons.push({ lm, light });
    }
    g.traverse((o) => { if (o.isMesh) { o.userData.s = s; o.userData.band = band; picks.push(o); } });
    halls.push({ x: it.x, door: new THREE.Vector3(it.x + dw / 2 + 0.6, Y0, it.z + dd / 2 + 1.2) });
    tags.push({ text: nice(s), pos: new THREE.Vector3(it.x, Y0 + h + rise + (s.alarm ? 1.8 : 1.0), it.z), bad: s.alarm, rank: s.total });
  }

  // ---- the park around it: trees past the yard, light poles along the roads
  const AX = (SW + 14) / 2, AZ = (SD + 12) / 2;
  for (let i = 0; i < 40 + Math.round(R); i++) {
    const side = i % 4, t = rnd();
    const x = side < 2 ? -AX - 6 + t * (2 * AX + 12) : side === 2 ? -AX - 2 - rnd() * 8 : AX + 2 + rnd() * 8;
    const z = side === 0 ? -AZ - 2 - rnd() * 8 : side === 1 ? AZ + 2 + rnd() * 6 : -AZ + t * 2 * AZ;
    const sz = 0.8 + rnd() * 0.7, g = group(x, 0, z);
    add(new THREE.CylinderGeometry(0.18 * sz, 0.24 * sz, 1.6 * sz, 8), mat.trunk, 0, 0.8 * sz, 0, g);
    add(new THREE.IcosahedronGeometry(1.4 * sz, 1), rnd() < 0.5 ? mat.leaf : mat.leaf2, 0, 2.4 * sz, 0, g).scale.set(1, 1.15, 1);
    add(new THREE.IcosahedronGeometry(1.0 * sz, 1), mat.leaf2, 0.5 * sz, 3.2 * sz, 0.3 * sz, g);
  }
  const poleLamp = Mat(0xfff2d6, 0.3, 0, { emissive: 0xfff2d6, emissiveIntensity: 1.2 });
  for (const r of roads) for (let x = -SW / 2 + 2; x < SW / 2 - 1; x += 9) {
    const g = group(x, Y0, r.road + ROAD / 2 + 0.6);
    add(new THREE.CylinderGeometry(0.06, 0.08, 3.4, 10), mat.steel, 0, 1.7, 0, g);
    add(rbox(0.5, 0.12, 0.25, 0.04), mat.dark, 0, 3.4, -0.2, g); add(new THREE.BoxGeometry(0.4, 0.02, 0.18), poleLamp, 0, 3.33, -0.2, g, false);
  }

  // ---- traffic: trucks down the yard roads, workers walking between the hall doors
  const trucks = [];
  if (!still) roads.forEach((r, ri) => { for (let i = 0; i < 1 + Math.floor(r.items.length / 4); i++) {
    const dir = (i + ri) % 2 ? 1 : -1, g = group(0, Y0, r.road + dir * 0.9);
    const body = group(0, 0, 0, g); body.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    add(rbox(1.3, 1.4, 3.2, 0.06), mat.white, 0, 1.0, -0.3, body); add(new THREE.BoxGeometry(1.32, 0.16, 3.22), mat.orange, 0, 0.72, -0.3, body);
    add(rbox(1.25, 1.1, 1.0, 0.14), mat.white, 0, 0.85, 1.75, body); add(new THREE.BoxGeometry(1.1, 0.45, 0.03), mat.visor, 0, 1.05, 2.26, body);
    for (const [wx, wz] of [[-0.62, -1.3], [0.62, -1.3], [-0.62, 1.7], [0.62, 1.7]]) add(new THREE.CylinderGeometry(0.28, 0.28, 0.22, 18), mat.tire, wx, 0.28, wz, body).rotation.z = Math.PI / 2;
    trucks.push({ g, dir, x: -SW / 2 + rnd() * SW, v: 2.2 + rnd() * 1.6 });
  } });
  const stops = halls.map((h) => h.door), workers = [];
  if (!still && stops.length > 1) for (let i = 0; i < Math.min(10, stops.length * 2); i++) {
    const g = group(0, Y0, 0);
    const legs = [-0.1, 0.1].map((sx) => { const p = group(sx, 0.44, 0, g); add(rbox(0.12, 0.44, 0.14, 0.05), mat.dark, 0, -0.22, 0, p); return p; });
    add(new THREE.CapsuleGeometry(0.21, 0.38, 6, 18), mat.white, 0, 0.8, 0, g);
    add(new THREE.BoxGeometry(0.42, 0.06, 0.3), Mat(0xf2c14e, 0.5), 0, 0.92, 0, g);
    add(new THREE.SphereGeometry(0.18, 22, 16), mat.white, 0, 1.3, 0, g);
    add(new THREE.SphereGeometry(0.2, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), Mat(0xf2c14e, 0.4), 0, 1.36, 0, g);
    const a = stops[i % stops.length].clone(), b = stops[(i * 5 + 3) % stops.length].clone();
    g.position.copy(a); workers.push({ g, legs, a, b, t: rnd(), ph: rnd() * 6 });
  }

  // ---- camera, post, controls, labels, hover, click
  const cam = new THREE.PerspectiveCamera(28, W() / H(), 0.5, 900);
  const center = new THREE.Vector3(0, 1.5, 0), DIR = new THREE.Vector3(0.55, 0.62, 0.86).normalize();
  scene.fog = new THREE.Fog(0xe2e4e6, R * 2.6, R * 6);
  let composer = null;
  if (PP) {
    try {
      const rt = new THREE.WebGLRenderTarget(W() * DPR, H() * DPR, { type: THREE.HalfFloatType, samples: 4 });
      composer = new PP.EffectComposer(renderer, rt);
      composer.addPass(new PP.RenderPass(scene, cam));
      const ao = new PP.GTAOPass(scene, cam, W(), H());
      ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
      ao.blendIntensity = 0.85; composer.addPass(ao);
      composer.addPass(new PP.UnrealBloomPass(new THREE.Vector2(W(), H()), 0.22, 0.4, 1.0));
      composer.addPass(new PP.OutputPass());
    } catch { composer = null; }
  }
  const dist0 = () => R * 2.7 / Math.min(1, (W() / H()) / 1.6);
  const fit = () => { if (!W() || !H()) return; cam.aspect = W() / H(); cam.updateProjectionMatrix(); renderer.setSize(W(), H()); if (composer) { composer.setPixelRatio(DPR); composer.setSize(W(), H()); } };
  cam.position.copy(center).addScaledVector(DIR, dist0()); fit(); cam.lookAt(center);
  const controls = new OrbitControls(cam, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, autoRotate: !still, autoRotateSpeed: 0.3, enablePan: false, minDistance: R * 1.1, maxDistance: R * 5, minPolarAngle: Math.PI * 0.12, maxPolarAngle: Math.PI * 0.42 });
  controls.target.copy(center);
  renderer.domElement.addEventListener("pointerdown", () => (controls.autoRotate = false), { once: true });
  const layer = document.createElement("div"); layer.className = "map-layer"; host.appendChild(layer);
  tags.sort((a, b) => (b.bad - a.bad) || b.rank - a.rank);
  const els = tags.map((t) => { const e = document.createElement("span"); e.className = "map-tag" + (t.bad ? " bad" : ""); e.textContent = t.text; layer.appendChild(e); return { ...t, e }; });
  const tip = document.createElement("div"); tip.className = "map-tip"; tip.hidden = true; host.appendChild(tip);
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let hover = null, down = null;
  const money = (v) => "$" + (v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2));
  const pick = (ev) => { const r = renderer.domElement.getBoundingClientRect(); ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, cam); return ray.intersectObjects(picks, false)[0]?.object || null; };
  renderer.domElement.addEventListener("pointermove", (ev) => {
    const o = pick(ev), band = o?.userData.band || null;
    if (hover && hover !== band) hover.material.emissive.setHex(0);
    hover = band; renderer.domElement.style.cursor = o ? "pointer" : "grab";
    if (!o) { tip.hidden = true; return; }
    band.material.emissive.setHex(0x333333);
    const s = o.userData.s, t = Math.abs(s.trend) < 0.05 ? "flat" : (s.trend > 0 ? "+" : "") + Math.round(s.trend * 100) + "%";
    tip.innerHTML = "<b></b><span></span><span></span>"; tip.children[0].textContent = s.name; tip.children[1].textContent = s.label + " · " + money(s.total) + " in 30 days"; tip.children[2].textContent = money(s.last7) + " last 7 days, " + t + (s.alarm ? " · price rule firing" : "");
    const r = host.getBoundingClientRect(); tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 240) + "px"; tip.style.top = (ev.clientY - r.top + 14) + "px"; tip.hidden = false;
  });
  renderer.domElement.addEventListener("pointerleave", () => { tip.hidden = true; if (hover) hover.material.emissive.setHex(0); hover = null; });
  renderer.domElement.addEventListener("pointerdown", (ev) => (down = [ev.clientX, ev.clientY]));
  renderer.domElement.addEventListener("pointerup", (ev) => { if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4) return; const o = pick(ev); if (o && window.level5Open) window.level5Open("service:" + o.userData.s.key); });
  const ro = new ResizeObserver(fit); ro.observe(host);
  let seen = true; const io = new IntersectionObserver((es) => (seen = es[0].isIntersecting)); io.observe(host);

  const v3 = new THREE.Vector3(), clock = new THREE.Clock(); let el = 0, raf;
  const frame = () => {
    const dt = Math.min(0.05, clock.getDelta()); el += dt;
    controls.update();
    if (!still) {
      for (const t of trucks) { t.x += t.dir * t.v * dt; if (t.x > SW / 2 + 2) t.x = -SW / 2 - 2; if (t.x < -SW / 2 - 2) t.x = SW / 2 + 2; t.g.position.x = t.x; }
      for (const w of workers) {
        w.t += dt * 0.55 / Math.max(1, w.a.distanceTo(w.b));
        if (w.t >= 1) { w.t = 0; w.a.copy(w.b); w.b.copy(stops[Math.floor(rnd() * stops.length)]); }
        w.g.position.lerpVectors(w.a, w.b, w.t); w.g.position.y = Y0 + Math.abs(Math.sin(el * 8 + w.ph)) * 0.035;
        w.g.rotation.y = Math.atan2(w.b.x - w.a.x, w.b.z - w.a.z);
        w.legs[0].rotation.x = Math.sin(el * 8 + w.ph) * 0.45; w.legs[1].rotation.x = -w.legs[0].rotation.x;
      }
      for (const b of beacons) { const on = Math.sin(el * 6) > 0; b.lm.emissiveIntensity = on ? 3.2 : 0.1; b.light.intensity = on ? 10 : 0; }
    }
    if (composer) composer.render(); else renderer.render(scene, cam);
    const r = host.getBoundingClientRect(), placed = [];
    for (const g of els) {
      v3.copy(g.pos).project(cam);
      const x = (v3.x + 1) / 2 * r.width, y = (1 - v3.y) / 2 * r.height, w = g.w ||= g.e.offsetWidth, box = [x - w / 2, y - 22, x + w / 2, y];
      const clash = v3.z > 1 || placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      g.e.style.visibility = clash ? "hidden" : "visible"; if (!clash) placed.push(box);
      g.e.style.transform = "translate(" + x + "px," + y + "px) translate(-50%,-100%)";
    }
  };
  const loop = () => { raf = requestAnimationFrame(loop); if (seen && !document.hidden && document.documentElement.dataset.view === "services") frame(); };
  frame(); raf = requestAnimationFrame(loop);
  M.dispose = () => {
    cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); controls.dispose(); composer?.dispose?.(); envRT.dispose(); pmrem.dispose();
    scene.traverse((o) => { o.geometry?.dispose(); if (o.material) { for (const k of ["map", "bumpMap", "roughnessMap"]) o.material[k]?.dispose(); o.material.dispose(); } });
    sky.dispose(); renderer.dispose(); renderer.domElement.remove(); layer.remove(); tip.remove(); M.host = null;
  };
}
addEventListener("hashchange", build); document.addEventListener("level5:swap", () => { M.dispose?.(); M.host = null; build(); }); build();
</script>`;
// The cost explorer, after AWS Cost Explorer: stacked/bar/line chart with a hover column and a
// tooltip, and a parameters panel (time, compare, range, granularity, group by, service and
// provider filters). Data comes once from /r/<repo>/costs; all filtering runs in the browser, and the
// state survives background refreshes and reloads (localStorage).
const CX_JS = `<script>(()=>{const X=window.level5Cx||(window.level5Cx={data:null,at:0,st:null});
const PAL=["#5e6ad2","#26b5ce","#4cb782","#f2c94c","#f2994a","#eb5757","#bb87fc","#4ea7fc","#d4669a"],OTHER="#c4c6cc";
const NAMES={aws:"AWS",vercel:"Vercel",neon:"Neon",anthropic:"Anthropic API","claude-code":"Claude Code",openai:"OpenAI",openrouter:"OpenRouter",fly:"Fly",cloudflare:"Cloudflare"};
const e=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=v=>"$"+(Math.abs(v)>=1000?Math.round(v).toLocaleString("en-US"):v.toFixed(2));
const D=d=>new Date(d+"T00:00:00Z"),iso=t=>new Date(t).toISOString().slice(0,10),add=(d,n)=>iso(D(d).getTime()+n*864e5);
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DEF={mode:"stacked",compare:false,range:"30",from:"",to:"",gran:"daily",group:"service",services:[],providers:[]};
function load(){try{return {...DEF,...JSON.parse(localStorage.getItem("level5.cx")||"{}")}}catch(x){return {...DEF}}}
function save(){try{localStorage.setItem("level5.cx",JSON.stringify(X.st))}catch(x){}}
if(!X.st)X.st=load();
const root=()=>document.getElementById("cx");
function period(){const s=X.st,today=X.data.today,y=add(today,-1);let a,b=y;
if(s.range==="custom"&&s.from&&s.to){a=s.from;b=s.to}else if(s.range==="mtd"){a=today.slice(0,8)+"01";b=today}else{a=add(y,1-Number(s.range||30))}if(a>b)[a,b]=[b,a];return [a,b]}
function bucketOf(d){const g=X.st.gran;if(g==="monthly")return d.slice(0,7)+"-01";if(g==="weekly"){const t=D(d),wd=(t.getUTCDay()+6)%7;return add(d,-wd)}return d}
function buckets(a,b){const out=[];let d=a;while(d<=b){const k=bucketOf(d);if(out[out.length-1]!==k)out.push(k);d=add(d,1)}return out}
function label(k){const t=D(k);return X.st.gran==="monthly"?MON[t.getUTCMonth()]+"-"+String(t.getUTCFullYear()).slice(2):MON[t.getUTCMonth()]+"-"+String(t.getUTCDate()).padStart(2,"0")}
function keyOf(r){const g=X.st.group;return g==="provider"?(NAMES[r[1]]||r[1]):g==="none"?"Total":r[2]}
function pass(r){const s=X.st;return(!s.services.length||s.services.includes(r[2]))&&(!s.providers.length||s.providers.includes(r[1]))}
function compute(){const [a,b]=period(),bk=buckets(a,b),idx=Object.fromEntries(bk.map((k,i)=>[k,i]));const rows=X.data.rows.filter(r=>r[0]>=a&&r[0]<=b&&pass(r));
const tot={};for(const r of rows){const k=keyOf(r);tot[k]=(tot[k]||0)+r[3]}const order=Object.keys(tot).sort((x,y)=>tot[y]-tot[x]),top=order.slice(0,9),rest=order.length>9;
const series=[...top,...(rest?["Others"]:[])].map((k,i)=>({k,color:k==="Others"?OTHER:PAL[i%PAL.length],v:bk.map(()=>0)}));const si=Object.fromEntries(series.map((x,i)=>[x.k,i]));
for(const r of rows){const k=keyOf(r),s2=series[si[top.includes(k)?k:"Others"]],i=idx[bucketOf(r[0])];if(s2&&i!=null)s2.v[i]+=r[3]}
let prev=null;if(X.st.compare){const len=(D(b)-D(a))/864e5+1,pa=add(a,-len),pb=add(a,-1),pbk=buckets(pa,pb),pidx=Object.fromEntries(pbk.map((k,i)=>[k,i]));prev=pbk.map(()=>0);for(const r of X.data.rows)if(r[0]>=pa&&r[0]<=pb&&pass(r)){const i=pidx[bucketOf(r[0])];if(i!=null)prev[i]+=r[3]}prev={v:prev,a:pa,b:pb}}
return {a,b,bk,series,tot,order,prev,total:Object.values(tot).reduce((x,y)=>x+y,0)}}
function nice(m){if(m<=0)return 1;const p=Math.pow(10,Math.floor(Math.log10(m))),f=m/p;return(f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p}
function drawIn(R,mini){if(!R||!X.data)return;const s=X.st,c=compute(),box=R.querySelector(".cx-chart"),W=Math.max(320,box.clientWidth),H=mini?260:340,L=48,B=34,T=12,Rt=8,iw=W-L-Rt,ih=H-T-B,n=c.bk.length;
const totals=c.bk.map((_,i)=>c.series.reduce((t,x)=>t+x.v[i],0));const mx=Math.max(...(s.mode==="line"?c.series.flatMap(x=>x.v):totals),...(c.prev?c.prev.v.slice(0,n):[]),0);const top=nice(mx*1.08),step=top/5;
const X0=i=>L+(i+.5)*iw/n,bw=Math.max(3,Math.min(46,iw/n*.62)),Y=v=>T+ih-(v/top)*ih;let g="";
for(let j=0;j<=5;j++){const y=Y(j*step);g+='<line class="grid" x1="'+L+'" x2="'+(W-Rt)+'" y1="'+y+'" y2="'+y+'"/><text class="yl" x="'+(L-8)+'" y="'+(y+4)+'">'+(step*j>=1000?Math.round(step*j/100)/10+"k":+(step*j).toFixed(step<1?2:0))+"</text>"}
const every=Math.ceil(n/Math.max(1,Math.floor(iw/72)));c.bk.forEach((k,i)=>{if(i%every===every-1||n<=8)g+='<text class="xl" x="'+X0(i)+'" y="'+(H-10)+'">'+label(k)+"</text>"});
c.bk.forEach((k,i)=>{let col='<g class="col" data-i="'+i+'">';
if(s.mode==="stacked"){let y0=0;c.series.forEach(x=>{const v=x.v[i];if(v>0){col+='<rect x="'+(X0(i)-bw/2)+'" y="'+Y(y0+v)+'" width="'+bw+'" height="'+Math.max(.5,Y(y0)-Y(y0+v))+'" fill="'+x.color+'"/>';y0+=v}});if(y0>0)col+='<rect class="cap" x="'+(X0(i)-bw/2)+'" y="'+Y(y0)+'" width="'+bw+'" height="2" rx="1"/>'}
else if(s.mode==="bar"){const v=totals[i];if(v>0)col+='<rect x="'+(X0(i)-bw/2)+'" y="'+Y(v)+'" width="'+bw+'" height="'+(Y(0)-Y(v))+'" fill="#688ae8" rx="2"/>'}
col+='<rect class="hit" x="'+(L+i*iw/n)+'" y="'+T+'" width="'+(iw/n)+'" height="'+ih+'"/></g>';g+=col});
if(s.mode==="line")c.series.forEach(x=>{g+='<polyline class="ln" stroke="'+x.color+'" points="'+x.v.map((v,i)=>X0(i)+","+Y(v)).join(" ")+'"/>'+x.v.map((v,i)=>'<circle class="pt" data-i="'+i+'" cx="'+X0(i)+'" cy="'+Y(v)+'" r="2.6" fill="'+x.color+'"/>').join("")});
if(c.prev)g+='<polyline class="prev" points="'+c.prev.v.slice(0,n).map((v,i)=>X0(i)+","+Y(v)).join(" ")+'"/>';
g+='<line class="axis0" x1="'+L+'" x2="'+(W-Rt)+'" y1="'+Y(0)+'" y2="'+Y(0)+'"/>';
box.innerHTML='<svg class="cx-svg" viewBox="0 0 '+W+" "+H+'" width="'+W+'" height="'+H+'"><text class="yt" x="'+L+'" y="'+(T-2)+'"></text>'+g+'</svg><div class="cx-tip" hidden></div>';
const tip=box.querySelector(".cx-tip"),svg=box.querySelector("svg");
svg.addEventListener("mousemove",ev=>{const r=svg.getBoundingClientRect(),i=Math.floor((ev.clientX-r.left-L)/(iw/n));if(i<0||i>=n){tip.hidden=true;svg.classList.remove("hov");return}
svg.classList.add("hov");svg.querySelectorAll(".col,.pt").forEach(el=>el.classList.toggle("on",+el.dataset.i===i));
const items=c.series.map(x=>[x,x.v[i]]).filter(([,v])=>v>0||s.group==="none").sort((p,q)=>(p[0].k==="Others")-(q[0].k==="Others")||q[1]-p[1]);
tip.innerHTML='<b>'+label(c.bk[i])+(s.gran==="weekly"?" week":"")+"</b>"+items.map(([x,v])=>'<div class="tr"><i style="background:'+x.color+'"></i><span>'+e(x.k)+"</span><em>"+money(v)+"</em></div>").join("")+'<div class="tt"><span>Total costs</span><em>'+money(totals[i])+"</em></div>"+(c.prev?'<div class="tp"><span>Previous period</span><em>'+money(c.prev.v[i]||0)+(c.prev.v[i]?' <small>'+(totals[i]>=c.prev.v[i]?"+":"")+Math.round((totals[i]/c.prev.v[i]-1)*100)+"%</small>":"")+"</em></div>":"");
tip.hidden=false;const bx=box.getBoundingClientRect(),x=X0(i)*(r.width/W),left=x+16+tip.offsetWidth>bx.width?x-16-tip.offsetWidth:x+16;tip.style.left=Math.max(4,left)+"px";tip.style.top="8px"});
svg.addEventListener("mouseleave",()=>{tip.hidden=true;svg.classList.remove("hov")});
R.querySelector(".cx-legend").innerHTML=c.series.map(x=>'<span><i style="background:'+x.color+'"></i>'+e(x.k)+"</span>").join("")+(c.prev?'<span><i class="dash"></i>Previous period</span>':"");
const ptot=c.prev?c.prev.v.reduce((a2,b2)=>a2+b2,0):0;
R.querySelector(".cx-sub").innerHTML="<b>"+money(c.total)+"</b> total · "+label(c.a)+" to "+label(c.b)+(s.gran==="daily"?" · "+money(c.total/Math.max(1,n))+" a day":"")+(c.prev?" · previous period "+money(ptot)+(ptot?" ("+(c.total>=ptot?"+":"")+Math.round((c.total/ptot-1)*100)+"%)":""):"");
if(mini)return;R.querySelector(".cx-table").innerHTML=c.order.length?'<table><thead><tr><th>'+(s.group==="provider"?"Provider":s.group==="none"?"":"Service")+"</th><th>Total</th><th>Share</th></tr></thead><tbody>"+c.order.slice(0,25).map(k=>'<tr><td>'+e(k)+"</td><td>"+money(c.tot[k])+'</td><td><span class="bar"><i style="width:'+(c.tot[k]/c.total*100).toFixed(1)+'%"></i></span>'+(c.tot[k]/c.total*100).toFixed(1)+"%</td></tr>").join("")+"</tbody></table>":'<p class="cx-note">No costs match these filters.</p>';
panel(c)}
// the Status page shows the same chart, fixed: last 30 days, daily, stacked by service, no filters
function draw(){drawIn(root());const h=document.getElementById("cx-home");if(h&&X.data){const k=X.st;X.st={...DEF};try{drawIn(h,true)}finally{X.st=k}}}
function panel(c){const R=root(),s=X.st;R.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("on",b.dataset.mode===s.mode));R.querySelectorAll("[data-time]").forEach(b=>{b.classList.toggle("on",s.compare);b.setAttribute("aria-pressed",s.compare)});
for(const k of ["range","gran","group","from","to"]){const el=R.querySelector('[data-k="'+k+'"]');if(el&&document.activeElement!==el)el.value=s[k]||(k==="from"?c.a:k==="to"?c.b:el.value)}
R.querySelector(".cx-custom").hidden=s.range!=="custom";R.querySelector('[data-note="range"]').textContent="Displaying "+label(c.a)+" to "+label(c.b);
const all=[...new Set(X.data.rows.map(r=>r[2]))].sort(),provs=[...new Set(X.data.rows.map(r=>r[1]))].sort();const q=(R.querySelector(".ms-q")||{}).value||"";
R.querySelector('[data-list="services"]').innerHTML=all.filter(x=>x.toLowerCase().includes(q.toLowerCase())).map(x=>'<label><input type="checkbox" data-svc="'+e(x)+'"'+(s.services.includes(x)?" checked":"")+"><span>"+e(x)+"</span></label>").join("")||'<p class="cx-note">No match.</p>';
R.querySelector('[data-list="providers"]').innerHTML=provs.map(x=>'<label><input type="checkbox" data-prov="'+e(x)+'"'+(s.providers.includes(x)?" checked":"")+"><span>"+e(NAMES[x]||x)+"</span></label>").join("");
R.querySelector(".ms-btn:not(.ms-prov) span").textContent=s.services.length?"Service · "+s.services.length:"Service";R.querySelector(".ms-prov span").textContent=s.providers.length?"Provider · "+s.providers.length:"Provider";
R.querySelectorAll(".ms-btn").forEach(b=>b.classList.toggle("on",b.classList.contains("ms-prov")?s.providers.length>0:s.services.length>0));
const chips=[...s.services.map(v=>["svc",v,v]),...s.providers.map(v=>["prov",v,NAMES[v]||v])];
R.querySelector(".cx-fchips").innerHTML=chips.map(([t,v,l])=>'<button type="button" class="fchip" data-rm="'+t+'" data-v="'+e(v)+'">'+(t==="svc"?"Service":"Provider")+" is <b>"+e(l)+'</b><span aria-hidden="true">×</span></button>').join("");
R.querySelector(".cx-clear").hidden=!chips.length;R.querySelector(".cx-filters").hidden=!chips.length}
function set(p){Object.assign(X.st,p);save();draw()}
async function fetchData(){if(!root()&&!document.getElementById("cx-home"))return;try{const r=await fetch(location.pathname.replace(/[/]$/,"")+"/costs",{credentials:"same-origin"});if(r.ok){X.data=await r.json();X.at=Date.now();draw()}}catch(x){}}
document.addEventListener("click",ev=>{const R=root();if(!R||!R.contains(ev.target)){document.querySelectorAll(".ms-pop").forEach(p=>p.hidden=true);return}
const m=ev.target.closest("[data-mode]");if(m)return set({mode:m.dataset.mode});const t=ev.target.closest("[data-time]");if(t)return set({compare:!X.st.compare});
const rm=ev.target.closest("[data-rm]");if(rm){const v=rm.dataset.v;return set(rm.dataset.rm==="svc"?{services:X.st.services.filter(x=>x!==v)}:{providers:X.st.providers.filter(x=>x!==v)})}
const cl=ev.target.closest("[data-clear]");if(cl){ev.preventDefault();const k=cl.dataset.clear;return set(k==="group"?{group:"service"}:k==="services"?{services:[]}:k==="providers"?{providers:[]}:{services:[],providers:[]})}
const mb=ev.target.closest(".ms-btn");if(mb){const p=mb.parentNode.querySelector(".ms-pop");R.querySelectorAll(".ms-pop").forEach(x=>{if(x!==p)x.hidden=true});p.hidden=!p.hidden;const q=p.querySelector(".ms-q");if(!p.hidden&&q)q.focus();return}
if(!ev.target.closest(".ms"))R.querySelectorAll(".ms-pop").forEach(x=>x.hidden=true)});
document.addEventListener("change",ev=>{const R=root();if(!R||!R.contains(ev.target))return;const el=ev.target;
if(el.dataset.k){const p={[el.dataset.k]:el.value};if(el.dataset.k==="range"&&el.value==="custom"){const [a,b]=period();p.from=X.st.from||a;p.to=X.st.to||b}return set(p)}
if(el.dataset.svc!=null){const v=el.dataset.svc,l=X.st.services.filter(x=>x!==v);if(el.checked)l.push(v);return set({services:l})}
if(el.dataset.prov!=null){const v=el.dataset.prov,l=X.st.providers.filter(x=>x!==v);if(el.checked)l.push(v);return set({providers:l})}});
document.addEventListener("input",ev=>{if(ev.target.classList&&ev.target.classList.contains("ms-q")&&X.data)panel(compute())});
addEventListener("resize",()=>{clearTimeout(X.rt);X.rt=setTimeout(draw,120)});
addEventListener("hashchange",()=>draw());
document.addEventListener("level5:swap",()=>{if(Date.now()-X.at>12e4)fetchData();else draw()});
if(X.data)draw();else fetchData()})()</script>`;
const SEC_JS = `<script>(()=>{if(window.level5Sec)return;window.level5Sec=1;
document.addEventListener("input",ev=>{if(!ev.target.classList||!ev.target.classList.contains("sec-q"))return;const q=ev.target.value.trim().toLowerCase();document.querySelectorAll(".sec-m tr[data-k]").forEach(r=>r.hidden=q&&!r.dataset.k.includes(q))});
document.addEventListener("change",ev=>{if(ev.target.classList&&ev.target.classList.contains("sl-cb"))document.querySelectorAll(".roles-g").forEach(g=>g.classList.toggle("show-sl",ev.target.checked))})})()</script>`;
// Tooltips: every title="a · b · c" in the app shows at once, styled like the cost chart's: the first
// part (a date gets spelled out) as the heading, one line per other part. The native title is
// moved to data-tip so the browser's own slow tooltip never shows.
const TIP_JS = `<script>(()=>{if(window.level5Tip)return;window.level5Tip=1;const t=document.createElement("div");t.className="htip";t.hidden=true;document.body.appendChild(t);
const e=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const day=x=>/^\\d{4}-\\d{2}-\\d{2}$/.test(x)?new Date(x+"T12:00:00Z").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",timeZone:"UTC"}):x;
let cur=null;document.addEventListener("mouseover",ev=>{const el=ev.target.closest&&ev.target.closest("[title],[data-tip]");if(!el||el.closest(".win-bar,.tb-right,.cx-svg")){t.hidden=true;cur=null;return}
if(el.hasAttribute("title")){el.dataset.tip=el.getAttribute("title");el.removeAttribute("title")}const txt=el.dataset.tip;if(!txt){t.hidden=true;return}cur=el;
const [h,...rest]=txt.split(" · ");t.innerHTML="<b>"+e(day(h))+"</b>"+rest.map(x=>"<div>"+e(x)+"</div>").join("");t.hidden=false});
document.addEventListener("mousemove",ev=>{if(t.hidden)return;const w=t.offsetWidth,h=t.offsetHeight;let x=ev.clientX+14,y=ev.clientY+16;if(x+w>innerWidth-8)x=ev.clientX-w-14;if(y+h>innerHeight-8)y=ev.clientY-h-12;t.style.left=x+"px";t.style.top=y+"px"});
document.addEventListener("mouseout",ev=>{if(cur&&!cur.contains(ev.relatedTarget)){t.hidden=true;cur=null}});addEventListener("scroll",()=>{t.hidden=true},{passive:true});
const TZ=()=>{const a=document.querySelector("[data-tz]");return (a&&a.dataset.tz)||Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"};
const parts=(d,tz)=>{const o={};for(const p of new Intl.DateTimeFormat("en-US",{timeZone:tz||TZ(),year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false,weekday:"short"}).formatToParts(d))o[p.type]=p.value;if(o.hour==="24")o.hour="00";return o};
window.level5Time={TZ,parts};
const DW=["Sundays","Mondays","Tuesdays","Wednesdays","Thursdays","Fridays","Saturdays"],DS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const local=()=>{const tz=TZ();if(tz==="UTC"||tz==="Etc/UTC")return;
document.querySelectorAll(".utc:not([data-lt])").forEach(el=>{el.dataset.lt=1;el.title=(el.title?el.title+" · ":"")+el.textContent.trim()+(el.textContent.includes("UTC")?"":" UTC");el.textContent=el.textContent.replace(/(?:(Sundays|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays) )?(\\d{2}):(\\d{2})(?: UTC)?/g,(m,dw,h,mi)=>{const now=new Date(),wd=dw?DW.indexOf(dw):now.getUTCDay(),ref=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+((wd-now.getUTCDay()+7)%7),+h,+mi)),p=parts(ref,tz),lw=DS.indexOf(p.weekday);return (dw?DW[lw]+" ":"")+p.hour+":"+p.minute})});
document.querySelectorAll("[data-at]:not([data-lt])").forEach(el=>{el.dataset.lt=1;const d=new Date(el.dataset.at);if(isNaN(d))return;const p=parts(d,tz);el.title=el.textContent;el.textContent=p.year+"-"+p.month+"-"+p.day+" "+p.hour+":"+p.minute})};
window.level5Local=local;local();document.addEventListener("level5:swap",local);
document.addEventListener("click",ev=>{const b=ev.target.closest&&ev.target.closest("[data-more]");if(!b)return;const g=b.parentElement,all=g.classList.toggle("all");b.textContent=all?"Show less":"Show all "+b.dataset.more})})()</script>`;
// The Automations week as a calendar, drawn in the viewer's time zone: Monday to Sunday, hours
// down, each run a block at its time, coloured by what happened; the routine name on hover.
const CAL_JS = `<script>(()=>{
const e=t=>String(t).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const S={ok:"ran",miss:"should have run, did not",next:"scheduled",unk:"no record either way"};
function draw(){const box=document.getElementById("cal");if(!box)return;const src=box.querySelector(".cal-data");if(!src)return;const runs=JSON.parse(src.textContent),meta=JSON.parse((box.querySelector(".cal-meta")||{}).textContent||"{}");
const T=window.level5Time,tz=T.TZ(),P=d=>T.parts(d,tz),DS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const now=new Date(),pn=P(now),base=Date.UTC(+pn.year,+pn.month-1,+pn.day)-((DS.indexOf(pn.weekday)+6)%7)*864e5;
const days=[...Array(7)].map((_,i)=>{const d=new Date(base+i*864e5);return{k:d.toISOString().slice(0,10),dow:DS[d.getUTCDay()],n:d.getUTCDate()}});
const keyOf=d=>{const p=P(d);return p.year+"-"+p.month+"-"+p.day},todayK=pn.year+"-"+pn.month+"-"+pn.day,H=1.2,mins=d=>{const p=P(d);return +p.hour*60+ +p.minute};
const by=days.map(d=>runs.map(r=>({...r,src:r,at:new Date(r.t)})).filter(r=>keyOf(r.at)===d.k).sort((a,b)=>a.at-b.at));
const TOUCH=70,col=(list)=>{const out=[];for(const r of list){const m=mins(r.at);let lane=0;while(out.some(s=>s.lane===lane&&Math.abs(s.m-m)<TOUCH))lane++;out.push({...r,m,lane})}for(const o of out){const near=out.filter(x=>Math.abs(x.m-o.m)<TOUCH);o.lanes=Math.max(...near.map(x=>x.lane))+1}return out};
const hh=d=>{const p=P(d);return p.hour+":"+p.minute};
let h='<div class="cal-head">'+days.map((d,i)=>'<div class="'+(d.k===todayK?"today":"")+'"><b>'+d.dow+'</b> '+d.n+'<small>'+by[i].length+" run"+(by[i].length===1?"":"s")+'</small></div>').join("")+'</div><div class="cal-body" style="height:'+(24*60*H/4)+'px">';
h+='<div class="cal-hours">'+[6,12,18].map(x=>'<span style="top:'+(x*60*H/4)+'px">'+String(x).padStart(2,"0")+':00</span>').join("")+'</div>';
h+=days.map((d,i)=>{const placed=col(by[i]);const nowLine=d.k===todayK?'<i class="cal-now" style="top:'+(mins(now)*H/4)+'px"></i>':"";
return '<div class="cal-day'+(d.k===todayK?" today":"")+'">'+nowLine+placed.map(p=>'<span class="cal-ev" data-s="'+p.s+'" data-i="'+runs.indexOf(p.src)+'" data-open="'+e((meta[p.n]||{}).key||"")+'" style="top:'+(p.m*H/4)+'px;left:calc('+(p.lane*100/p.lanes)+'% + 3px);width:calc('+(100/p.lanes)+'% - 6px)">'+e(p.n)+'</span>').join("")+'</div>'}).join("")+'</div>';
let v=box.querySelector(".cal-view");if(!v){v=document.createElement("div");v.className="cal-view";box.appendChild(v)}v.innerHTML=h}
// hover card: the run, then the routine
const card=document.createElement("div");card.className="cal-card";card.hidden=true;document.body.appendChild(card);
const ago=t=>{if(!t)return "never";const m=Math.round((Date.now()-Date.parse(t))/6e4);return m<60?m+" min ago":m<2880?Math.round(m/60)+" h ago":Math.round(m/1440)+" days ago"};
const until=t=>{if(!t)return "";const m=Math.round((Date.parse(t)-Date.now())/6e4);return m<60?"in "+m+" min":m<2880?"in "+Math.round(m/60)+" h":"in "+Math.round(m/1440)+" days"};
const tk=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?Math.round(n/1e3)+"k":String(n),hm=s=>s>=3600?Math.floor(s/3600)+" h "+Math.round(s%3600/60)+" min":Math.round(s/60)+" min";
document.addEventListener("mouseover",ev=>{const b=ev.target.closest&&ev.target.closest(".cal-ev");if(!b){card.hidden=true;return}const box=document.getElementById("cal"),runs=JSON.parse(box.querySelector(".cal-data").textContent),meta=JSON.parse((box.querySelector(".cal-meta")||{}).textContent||"{}"),r=runs[+b.dataset.i];if(!r)return;const m=meta[r.n]||{},T=window.level5Time,p=T.parts(new Date(r.t));
const row=(k,v)=>v?'<div><span>'+k+'</span><b>'+e(v)+'</b></div>':"";
const bars=m.bars?'<div class="cc-bars">'+[...m.bars].map(c=>'<i data-s="'+({o:"ok",w:"warn",m:"miss"}[c]||"")+'"></i>').join("")+'</div><div class="cc-ax"><span>'+(m.weekly?"12 weeks":"30 days")+'</span><span>'+(m.weekly?"this week":"today")+'</span></div>':"";
card.innerHTML='<div class="cc-h"><b>'+e(r.n)+'</b><span class="cc-s" data-s="'+r.s+'">'+S[r.s]+'</span></div><div class="cc-t">'+p.weekday+" "+p.day+"/"+p.month+" · "+p.hour+":"+p.minute+'</div>'+bars+
(r.tok||r.usd||r.secs?'<div class="cc-run">'+(r.tok?'<span><b>'+tk(r.tok)+'</b>tokens</span>':"")+(r.usd?'<span><b>$'+r.usd.toFixed(2)+'</b>cost</span>':"")+(r.secs?'<span><b>'+hm(r.secs)+'</b>time</span>':"")+'</div>':"")+
'<div class="cc-kv">'+row(m.src==="GitHub Actions"?"Workflow":"Command",m.cmd?(m.src==="GitHub Actions"?m.cmd:"/"+m.cmd):"")+row("Model",m.model)+row("Last run",ago(m.last))+row("Next run",until(m.next))+row("On time",m.on==null?"":m.on+"% in 30 days")+row("Skills",m.skills?String(m.skills):"")+row("Cost, 30 days",m.usd30?"$"+m.usd30.toFixed(2):"")+'</div><div class="cc-f">Click for the routine</div>';
card.hidden=false;const rc=b.getBoundingClientRect(),w=card.offsetWidth,h=card.offsetHeight;let x=rc.right+8,y=rc.top;if(x+w>innerWidth-8)x=rc.left-w-8;if(y+h>innerHeight-8)y=innerHeight-h-8;card.style.left=Math.max(8,x)+"px";card.style.top=Math.max(52,y)+"px"});
addEventListener("scroll",()=>{card.hidden=true},{passive:true});
draw();document.addEventListener("level5:swap",draw)})()</script>`;
const page = (title, body, { live, stale, app } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${ICON}${FONTS}${app ? VIEW_HEAD : ""}<style>${CSS}${app ? VIEW_CSS : ""}${THEME}</style></head><body${stale ? ' data-stale="1"' : ""}><div class="wrap${app ? " app-wrap" : ""}">${body}</div>${live ? LIVE : ""}${live && body.includes('class="ci-live"') ? ACTIONS : ""}${app ? VIEW_JS + TIP_JS : ""}${body.includes('id="chat"') ? ASK_JS : ""}${body.includes('id="win-tpl"') ? WIN_JS : ""}${body.includes('id="tb-bell"') ? NOTIF_JS : ""}${body.includes('class="rule-form"') || body.includes('class="rule-nl"') ? RULES_JS : ""}${body.includes('class="rt-fire"') || body.includes('class="nr-form"') ? TRIG_JS : ""}${body.includes('id="svc-map"') ? MAP_JS : ""}${body.includes('id="cx') ? CX_JS : ""}${body.includes('id="cal"') ? CAL_JS : ""}${body.includes('class="sec-q"') || body.includes('class="sl-cb"') ? SEC_JS : ""}</body></html>`;

// What the repo page looks like while its first snapshot is being read from GitHub.
function skeletonPage(repo) {
  const bars = `<div class="bars">${'<i class="sk"></i>'.repeat(WINDOW)}</div>`;
  const row = (w) => `<div class="row"><div class="row-head"><span class="sk sk-t" style="width:${w}px"></span><span class="sk sk-t" style="width:84px"></span></div>${bars}<div class="axis"><span class="sk sk-t" style="width:100%;height:8px"></span></div></div>`;
  const stat = `<div class="stat"><span class="sk sk-t" style="width:56px;height:26px"></span><span class="sk sk-t" style="width:110px;margin-top:10px"></span><span class="sk sk-t" style="width:90px;margin-top:8px;height:8px"></span></div>`;
  // the real shell (top bar, sidebar, main column) so nothing jumps when the page arrives
  const nav = [64, 78, 92, 30, 96, 52, 46, 40, 62].map((w) => `<a><span class="sk sk-t" style="width:16px;height:14px"></span><span class="sk sk-t" style="width:${w}px"></span></a>`).join("");
  return page(`${repo} · Level 5`, `<div class="app">
    <header class="topbar">
      <a class="logo" href="/">${MARK()}<span>Level 5</span></a>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Repositories</a><span>/</span><b>${esc(repo)}</b></nav>
      <span class="tb-right"><span class="updated">reading GitHub…</span></span>
    </header>
    <aside class="side">
      <div class="repo-box"><span class="repo-name">${esc(repo)}</span><span class="sk sk-t" style="width:96px;margin-top:6px"></span></div>
      <nav class="snav sk-nav" aria-hidden="true">${nav}</nav>
    </aside>
    <main class="main">
      <div class="banner sk-banner"><span class="sk sk-t" style="width:200px;background:rgba(255,255,255,.55)"></span></div>
      <p class="banner-sub"><span class="sk sk-t" style="width:62%"></span></p>
      <h2>Needs a look</h2>
      <div class="group grid2">${[120, 90, 140, 100].map(row).join("")}</div>
      <h2>Costs</h2>
      <div class="group stats">${stat.repeat(4)}<div class="chart"><span class="sk" style="display:block;height:200px"></span></div></div>
      <h2>Last ${WINDOW} days</h2>
      <div class="group stats">${stat.repeat(4)}</div>
      <p class="sk-note" role="status">The first read of a repo takes a few seconds. After that it opens instantly.</p>
    </main></div>
  `, { live: true, stale: true, app: true });
}

const STATE = { silent: ["none", "No heartbeat yet"], alive: ["ok", "Operational"], warn: ["warn", "Degraded"], degraded: ["bad", "Chronically degraded"], lying: ["bad", "Said ok, read nothing"], dead: ["bad", "Down"], retired: ["none", "Retired"] };

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
  const installed = !!(st?.level5_sh && st?.hook);
  const legacy = installed && st.legacy; // connected under an earlier name: works, other file names
  const beats = (st?.skill_beats || 0) > 0;
  const providers = (st?.cost_sources || []).filter((x) => x !== "claude-code");
  const costsOn = providers.length > 0 || (st?.sessions || 0) > 0;
  return `<ol class="ob">
    <li class="done">${DONE}<div><b>Level 5 can read this repo</b><span>The GitHub App is installed. Monitors, routines, CI and the queue come from it.</span></div></li>
    ${step(2, installed, "Connect the repo", false, legacy ? `The heartbeat from before the rename to Level 5 is in the repo and still reports. Run <code>/level5:setup</code> again to update it.` : `<code>.claude/hooks/level5.sh</code> and the SessionEnd hook are in the repo. Every cloud routine reports itself when it ends.`, `<span>In Claude Code, add the Level 5 plugin once:</span>
      <div class="cmd"><pre>/plugin install level5 --marketplace humanagent/level5</pre>${COPY}</div>
      <span>Then, at the repo root, connect it. It gets this repo's key with your GitHub login (<code>gh</code>), writes the SessionEnd hook into <code>.claude/</code>, proposes monitors, a daily report and a pulse, and opens one PR.</span>
      <div class="cmd"><pre>/level5:setup</pre>${COPY}</div>
      <span>No <code>gh</code> on that machine: <code>/level5:setup ${esc(key)}</code> does the same with the key.</span>
      <span>The files go in the repo because routines run on a fresh clone, where plugins do not load. No change to your skills.</span>${st && st.level5_sh && !st.hook ? `<span class="err">Found <code>level5.sh</code> but not the SessionEnd hook in <code>.claude/settings.json</code>. Run <code>/level5:setup</code> again.</span>` : ""}`)}
    ${step(3, beats, "Say how each run went", true, `${st?.skill_beats} monitor${st?.skill_beats === 1 ? "" : "s"} send their own status and volume.`, `<span>A skill ends with this to send its status and how much it read. A monitor that says ok after reading nothing gets flagged.</span>
      <div class="cmd"><pre>.claude/hooks/level5.sh beat errors ok '{"swept":{"events":120}}'</pre>${COPY}</div>
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
    ${step(4, costsOn, "Report costs", true, [providers.length ? `Spend from ${providers.map((x) => ({ aws: "AWS", vercel: "Vercel", neon: "Neon", anthropic: "Anthropic API", openrouter: "OpenRouter", fly: "Fly", cloudflare: "Cloudflare" }[x] || esc(x))).join(", ")}.` : "", st?.sessions ? `Tokens from ${st.sessions} Claude Code session${st.sessions === 1 ? "" : "s"}.` : installed ? "Claude Code tokens arrive with the next cloud session." : ""].filter(Boolean).join(" "), `<span>Claude Code tokens arrive on their own: the same hook counts each cloud session's tokens by model.${st?.level5_sh && !st.cost_cmd ? " Your <code>level5.sh</code> predates this: run <code>/level5:setup</code> again to update it." : ""} For provider spend, the job that already reads your bill ends with one line per day:</span>
      <div class="cmd"><pre>.claude/hooks/level5.sh cost aws 31.50 '{"day":"2026-10-10","breakdown":{"ECS":20,"S3":0.4}}'</pre>${COPY}</div>
      <span>Any provider works (<code>aws</code>, <code>vercel</code>, <code>neon</code>, <code>anthropic</code>…). Sending the same day again replaces it, so resend the last 3 days as charges settle. Level 5 never asks for billing credentials.</span>`)}
    ${waiting ? `<li class="wait"><span class="live-dot" data-on="1"></span><div><b>Waiting for the first heartbeat</b><span>This page updates on its own when it arrives. Try it now: <code>.claude/hooks/level5.sh beat install-test ok</code></span></div></li>` : ""}
  </ol>`;
}

function heartbeatPage(origin, repoRow) {
  return page(`Heartbeat setup · ${repoRow.full_name}`, `
    <header class="top">${LOGO}<a class="updated" href="/r/${esc(repoRow.full_name)}">← ${esc(repoRow.full_name)}</a></header>
    <section class="onboard"><h2>Heartbeat setup</h2>${heartbeatSetup(origin, repoRow.ingest_key, false)}</section>`);
}

function statusPage(s, user, origin, repoRow, { stale = false, tz = "" } = {}) {
  const repoUrl = s.meta.url;
  const banner = s.overall === "ok" ? "All systems operational" : s.overall === "degraded" ? "Degraded performance" : "Monitors need attention";
  // A skill that sends a report is shown under Reports, not Monitors
  const RPT = new Set((s.status?.reports || []).map((r) => r.id)), MON = s.monitors.filter((m) => !RPT.has(m.id));
  const monRows = MON.map((m) => {
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
  // Automations: did each routine run when it should have, and what it cost. Whether the run was any
  // good is Monitors' question; here a routine's skills are only a count and a link.
  const RH = s.status?.routines || {};
  const fullDay = (d) => d.replace(/s$/, "");
  const routineCard = (r) => {
    const h = RH[r.name], cmd = r.source === "Claude Code" ? ((r.prompt || "").match(/\/([a-z][a-z0-9:_-]*)/) || [])[1] : "";
    const b = h?.buckets || [], due = b.filter((x) => x.s), recent = b.slice(-7).filter((x) => x.s);
    const missedLast = due.at(-1)?.s === "miss";
    const missRecent = recent.filter((x) => x.s === "miss").length, failed = b.filter((x) => x.s === "warn").length;
    const onTime = due.length ? Math.round((due.filter((x) => x.s !== "miss").length / due.length) * 100) : null;
    const lastFire = (() => { const t = new Date(r.next_run || Date.now()); t.setTime(t.getTime() - r.period_h * 36e5); return r.period_h >= 24 * 6 ? `${fullDay(DOW[t.getUTCDay()])} ${t.toISOString().slice(11, 16)}` : t.toISOString().slice(11, 16); })();
    const [st, label, rank] = !r.last_seen && !due.length ? ["none", r.source === "Claude Code" ? "Not reporting" : "No runs found", 2]
      : missedLast ? ["bad", `Missed the <span class="utc">${lastFire}</span> run`, 0]
      : missRecent ? ["warn", `Missed ${missRecent} of the last ${recent.length}`, 0]
      : failed && b.at(-1)?.s === "warn" ? ["bad", "Last run failed", 0]
      : ["ok", "On schedule", 1];
    const tip = (x) => [x.label, { ok: x.failed ? `${x.runs} runs, ${x.failed} failed` : x.runs > 1 ? `ran ${x.runs} times` : "ran", warn: `${x.failed} of ${x.runs} runs failed`, miss: "should have run, did not", "": "nothing scheduled" }[x.s], x.usd ? usd(x.usd) : ""].filter(Boolean).join(" · ");
    const facts = [cmd ? `/${esc(cmd)}` : r.source === "GitHub Actions" ? esc(r.prompt.replace(/^\.github\/workflows\//, "")) : "", `<span class="utc">${esc(when(r))}</span>`, r.next_run ? `next ${until(r.next_run)}` : ""].filter(Boolean).join(" · ");
    const hint = st === "none" ? `<p class="rt-hint">${r.source === "Claude Code" ? `No heartbeat. <a href="#setup">Install the hook</a>` : "No runs in the window."}</p>` : "";
    return { rank, html: `<div class="row rt openable" data-open="routine:${esc(encodeURIComponent(r.name))}" role="button" tabindex="0">
      <div class="rt-top"><span class="name"><b>${esc(r.name.replace(/^App: /, ""))}</b><small>${facts}</small></span><span class="state" data-s="${st}">${label}</span></div>
      ${b.length ? `<div class="bars${h.weekly ? " wk" : ""}">${b.map((x) => `<i data-s="${x.s}" title="${esc(tip(x))}"></i>`).join("")}</div>` : ""}
      ${hint}
    </div>` };
  };
  const routineRows = s.routines.map(routineCard).map((x, i) => ({ ...x, i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.html).join("");

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
  const prLine = (p, kind, when, right = "") => `<a class="line pr" href="${esc(p.url)}" target="_blank" rel="noopener"><span class="name">${PR_ICON[kind]}<span><span class="pr-title">${esc(p.title)}</span><span class="sub">#${p.number}${p.author ? ` · ${esc(p.author)}` : ""} · ${when}</span></span></span><span class="meta"><code class="branch">${esc(p.branch)}</code>${AGENT_BRANCH.test(p.branch || "") ? `<span class="agent-tag">agent</span>` : ""}${right}</span></a>`;
  const ciTag = (p) => `<span class="state" data-s="${p.ci === "green" ? "ok" : p.ci === "red" ? "bad" : p.ci === "running" ? "warn" : "none"}"${p.ci === "running" ? " data-run" : ""}>${{ green: "Passing", red: "Failing", running: "Running", none: "No CI" }[p.ci]}</span>`;
  const C = s.costs;
  const SRC_COLOR = ["#14161c", "#5b6cff", "#2fb36b", "#f0a92c", "#e5484d", "#8250df", "#0ea5b7", "#9a9ea5"];
  const srcColor = (k) => (k === "claude-code" ? "#d97757" : SRC_COLOR[(C?.sources || []).filter((x) => x !== "claude-code").indexOf(k) % SRC_COLOR.length]);
  const srcName = (k) => ({ aws: "AWS", vercel: "Vercel", neon: "Neon", anthropic: "Anthropic API", "claude-code": "Claude Code", openai: "OpenAI", openrouter: "OpenRouter", fly: "Fly", cloudflare: "Cloudflare", supabase: "Supabase" }[k] || k);
  const usd = (n) => (n == null ? "–" : n >= 1000 ? "$" + Math.round(n).toLocaleString("en-US") : "$" + n.toFixed(n < 10 ? 2 : 0));
  const tk = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n || 0));
  const maxCost = C ? Math.max(1e-9, ...C.per_day.map((p) => p.total)) : 1;
  const costs = !C ? "" : `
    <div class="group stats">
      <div class="stat"><b>${usd(C.total_usd)}</b><span>Spent in ${WINDOW} days</span><small>${C.sources.map((k) => `${srcName(k)} ${usd(C.total[k])}`).join(" · ")}</small></div>
      <div class="stat"><b>${usd(C.yesterday)}</b><span>Yesterday</span><small>${usd(C.avg7)} a day over the last 7</small></div>
      <div class="stat"><b>${tk(C.tokens_30d)}</b><span>Claude Code tokens</span><small>${C.sessions_30d} cloud session${C.sessions_30d === 1 ? "" : "s"} in ${WINDOW} days</small></div>
      <div class="stat"><b>${C.sessions_30d ? tk(C.tokens_30d / C.sessions_30d) : "–"}</b><span>Tokens per session</span><small>average</small></div>
    </div>
    <div class="cx" id="cx" data-repo="${esc(s.repo)}">
      <div class="cx-bar">
        <div class="seg" role="group" aria-label="Chart type">
          <button type="button" data-mode="stacked" title="Stacked by group"><svg viewBox="0 0 16 16"><path d="M2.5 13.5h11M4 12V9M4 9V7M7 12V8M7 8V4M10 12V10M10 10V7M13 12V9"/></svg></button>
          <button type="button" data-mode="bar" title="Total"><svg viewBox="0 0 16 16"><path d="M2.5 13.5h11M4 12V7M7 12V4M10 12V8M13 12V6"/></svg></button>
          <button type="button" data-mode="line" title="Lines"><svg viewBox="0 0 16 16"><path d="M2 12l4-4 3 2 5-6"/></svg></button>
        </div>
        <label class="pick"><select data-k="range" aria-label="Date range"><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option><option value="mtd">Month to date</option><option value="custom">Custom…</option></select></label>
        <span class="cx-custom"><input type="date" data-k="from" aria-label="From"><span class="faint">–</span><input type="date" data-k="to" aria-label="To"></span>
        <label class="pick"><select data-k="gran" aria-label="Granularity"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label class="pick"><span class="pick-l">Group</span><select data-k="group" aria-label="Group by"><option value="service">Service</option><option value="provider">Provider</option><option value="none">None</option></select></label>
        <button type="button" class="toggle" data-time="compare" title="Compare with the previous period">Compare</button>
        <span class="cx-spacer"></span>
        <div class="ms"><button type="button" class="ms-btn" aria-haspopup="listbox"><svg viewBox="0 0 16 16"><path d="M2.5 4h11M4.5 8h7M6.5 12h3"/></svg><span>Service</span></button><div class="ms-pop" hidden><input type="search" placeholder="Find a service" class="ms-q"><div class="ms-list" data-list="services"></div></div></div>
        <div class="ms"><button type="button" class="ms-btn ms-prov" aria-haspopup="listbox"><svg viewBox="0 0 16 16"><path d="M2.5 4h11M4.5 8h7M6.5 12h3"/></svg><span>Provider</span></button><div class="ms-pop" hidden><div class="ms-list cx-checks" data-list="providers"></div></div></div>
      </div>
      <div class="cx-filters"><span data-note="nfilters" hidden>0</span><span class="cx-fchips"></span><a href="#" data-clear="all" class="cx-clear" hidden>Clear filters</a></div>
      <section class="cx-main"><div class="cx-sub"></div><p class="cx-note" data-note="range" hidden></p><div class="cx-chart" role="img" aria-label="Spend over time"><div class="cx-loading">Loading cost data…</div></div><div class="cx-legend"></div><div class="cx-table"></div></section>
    </div>
    ${C.sessions.length ? `<h2>Last ${C.sessions.length === 1 ? "Claude Code session" : `${C.sessions.length} Claude Code sessions`}</h2><div><div class="group" style="margin-bottom:0">${C.sessions.map((x) => `<div class="line"><span class="name"><code>/${esc(x.name)}</code><span class="sub">${ago(x.at)} · ${esc(x.models.join(", "))}${x.turns ? ` · ${x.turns} turns` : ""}</span></span><span class="meta"><b>${tk(x.tokens.total)}</b> tokens <span class="sub">${tk(x.tokens.input + x.tokens.cache_write)} in · ${tk(x.tokens.cache_read)} cached · ${tk(x.tokens.output)} out${x.usd != null ? ` · ~${usd(x.usd)}` : ""}</span></span></div>`).join("")}</div><div class="cost-note">Dollars are estimated at API list prices. On a Claude subscription they show what the same tokens would cost, not what you pay. A model with no known price shows tokens only; set it under <code>prices</code> in <code>.claude/factory.json</code>.</div></div>` : ""}`;
  // long lists show 5 rows and a button for the rest
  const more = (n) => (n > 5 ? `<button type="button" class="more-btn" data-more="${n}">Show all ${n}</button>` : "");
  const prTabs = [
    ["open", "Open", s.queue.prs.map((p) => prLine(p, p.draft ? "draft" : "open", `opened ${ago(p.created_at)}${p.draft ? " · draft" : ""}`, ciTag(p)))],
    ["merged", "Merged", (s.queue.merged || []).slice(0, 15).map((p) => { const z = s.metrics?.prs?.size?.[p.number]; return prLine(p, "merged", `merged ${ago(p.merged_at)}`, z ? `<span class="loc sm"><span class="add">+${z[0].toLocaleString("en-US")}</span> <span class="del">−${z[1].toLocaleString("en-US")}</span></span>` : ""); })],
    ["closed", "Closed", (s.queue.closed || []).slice(0, 15).map((p) => prLine(p, "closed", `closed ${ago(p.closed_at)}`))],
  ];
  const prSection = `<div class="tabs">${prTabs.map(([k, label, rows], i) => `<input type="radio" name="prtab" id="prtab-${k}"${i === 0 ? " checked" : ""}><label for="prtab-${k}">${PR_ICON[k]}${label} <span class="count">${k === "open" ? rows.length : rows.length + (rows.length === 15 ? "+" : "")}</span></label>`).join("")}
    ${prTabs.map(([k, , rows]) => `<div class="group tab-panel more5" data-tab="${k}">${rows.join("") || `<div class="line"><span class="hint">No ${k} pull requests${k === "open" ? "" : " recently"}.</span></div>`}${more(rows.length)}</div>`).join("")}</div>`;
  // --- window contents: one <template> per entity; the window manager clones them -----------
  const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v !== "" && v != null).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const when2 = (ts) => (ts ? `${ago(ts)} <span class="faint" data-at="${esc(new Date(ts).toISOString())}">${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC</span>` : "never");
  const statePill = (st, label) => `<span class="pill" data-s="${st}">${label}</span>`;
  const isLate = (r) => r.last_seen && (Date.now() - new Date(r.last_seen)) / 36e5 > (r.gap_h || r.period_h) * 1.25 + 2;
  const wins = [];
  for (const m of s.monitors) {
    const [ps, label] = STATE[m.state] || ["none", m.state];
    const bars = m.buckets.map((b) => `<i data-s="${b.s}" title="${b.label} · ${b.s || "no run"}"></i>`).join("");
    const swept = (x) => Object.entries(x || {}).map(([k, v]) => `${esc(k)} <code>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</code>`).join(" · ");
    const routine = s.routines.find((r) => r.name === m.routine);
    wins.push({ key: `monitor:${m.id}`, kind: "Monitor", title: m.id, body: `
      <div class="w-head">${statePill(ps, label)}${m.why ? `<span class="w-why">${esc(m.why)}</span>` : ""}</div>
      <div class="bars tall">${bars}</div><div class="axis"><span>${m.span}</span><span class="rule"></span><span>today</span></div>
      <p class="w-facts">${[m.last ? `Last run ${ago(m.last.ts)}` : "Never reported", routine ? `runs in <a href="#" data-open="routine:${esc(encodeURIComponent(routine.name))}">${esc(routine.name.replace(/^App: /, ""))}</a>` : "", m.filed.length ? `filed ${m.filed.slice(0, 5).map((x) => `<a href="${repoUrl}/issues/${x}" target="_blank" rel="noopener">#${x}</a>`).join(" ")}` : ""].filter(Boolean).join(" · ")}</p>
      ${m.history?.length ? `<details class="w-raw"><summary>Raw heartbeats (${m.history.length})</summary><div class="w-list">${m.history.map((b) => `<div><span class="pill sm" data-s="${b.status === "ok" ? "ok" : b.status === "degraded" ? "warn" : "bad"}">${b.status}</span><span class="faint">${ago(b.ts)}${b.source === "session" ? " · session" : ""}</span><span>${swept(b.swept)}${b.note ? ` <span class="faint">${esc(b.note)}</span>` : ""}</span></div>`).join("")}</div></details>` : ""}` });
  }
  // the automation window: one object, everything about it
  const AUTO = Object.fromEntries((s.automations || []).map((x) => [x.routine, x]));
  const AST = { "on schedule": ["ok", "On schedule"], missed: ["bad", "Missed the last run"], degraded: ["warn", "Last run degraded"], "not reporting": ["none", "Not reporting"] };
  const hmS = (sec) => (sec == null ? "–" : sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`);
  for (const r of s.routines) {
    const A = AUTO[r.name], fed = s.monitors.filter((m) => m.routine === r.name || (A?.skills || []).includes(m.id));
    const [st, label] = A ? AST[A.state] || ["none", A.state] : ["none", "No data yet"];
    const bk = A?.buckets || [];
    const tipB = (x) => [x.label, { ok: "ran", warn: "ran, failed", miss: "should have run, did not", "": "nothing scheduled" }[x.s], x.usd ? usd(x.usd) : ""].filter(Boolean).join(" · ");
    const runRow = (x) => `<div class="ar"><span class="ar-st" data-s="${x.status === "ok" ? "ok" : x.status === "degraded" ? "warn" : "bad"}"></span><span class="ar-main"><b data-at="${esc(x.at)}">${esc(new Date(x.at).toISOString().slice(0, 16).replace("T", " "))}</b><span class="sub">${esc(x.origin)}${x.note ? ` · ${esc(x.note)}` : ""}</span></span><span class="ar-num">${x.tokens ? `${tk(Number(x.tokens))} tok` : ""}${x.usd ? ` · ${usd(Number(x.usd))}` : ""}${x.secs ? ` · ${hmS(Number(x.secs))}` : ""}${x.url ? ` · <a href="${esc(x.url)}" target="_blank" rel="noopener">log</a>` : ""}</span></div>`;
    wins.push({ key: `routine:${encodeURIComponent(r.name)}`, kind: "Automation", title: r.name.replace(/^App: /, ""), href: r.source === "GitHub Actions" ? `${repoUrl}/actions/workflows/${esc((r.prompt || "").split("/").pop())}` : "", body: `
      <div class="w-head">${statePill(st, label)}${A?.state_why ? `<span class="w-why">${esc(A.state_why)}</span>` : ""}</div>
      <p class="w-facts">${[A?.command ? `<code>${esc(A.command)}</code>` : "", `<span class="utc">${esc(when(r))}</span>`, r.model ? esc(r.model) : "", esc(r.source)].filter(Boolean).join(" · ")}</p>
      <div class="a-stats">
        <span><b>${A ? `${A.runs_30d}` : "–"}</b>runs in ${WINDOW} days${A?.missed_30d ? `, ${A.missed_30d} missed` : ""}</span>
        <span><b>${A?.tokens_30d ? tk(Number(A.tokens_30d)) : "–"}</b>tokens</span>
        <span><b>${A?.usd_30d ? usd(Number(A.usd_30d)) : "–"}</b>cost</span>
        <span><b>${A?.secs_30d ? hmS(Number(A.secs_30d)) : "–"}</b>time</span>
      </div>
      ${bk.length ? `<div class="bars tall${A.weekly ? " wk" : ""}">${bk.map((x) => `<i data-s="${x.s}" title="${esc(tipB(x))}"></i>`).join("")}</div><div class="axis"><span>${A.weekly ? "12 weeks ago" : `${WINDOW} days ago`}</span><span class="rule"></span><span>${A.weekly ? "this week" : "today"}</span></div>` : ""}
      <p class="w-facts">${[A?.last_run_at ? `Last run ${ago(A.last_run_at)}` : "Never ran", r.next_run ? `next ${until(r.next_run)}` : ""].filter(Boolean).join(" · ")}</p>
      ${r.source === "GitHub Actions" ? "" : `<h4>Run from Level 5</h4><div class="rt-fire" data-routine="${esc(r.name)}"></div>`}
      <h4>Runs</h4>
      ${A?.runs?.length ? `<div class="ar-list more5">${A.runs.map(runRow).join("")}${more(A.runs.length)}</div>` : `<p class="faint">No run recorded yet.</p>`}
      ${fed.length ? `<h4>Skills it runs</h4><div class="w-list">${fed.map((m) => { const [ps, l] = STATE[m.state] || ["none", m.state]; return `<div class="openable" data-open="monitor:${esc(m.id)}" role="button" tabindex="0"><code>${esc(m.id)}</code><span class="state" data-s="${ps}">${l}</span></div>`; }).join("")}</div>` : ""}` });
  }
  // New routine: there is no API to create a routine, so Level 5 writes the /level5:new-monitor command that does it
  wins.push({ key: "new:routine", kind: "Automation", title: "New routine", body: `
      <form class="nr-form" onsubmit="return false">
        <label>Name<input name="name" placeholder="Logs sweep" maxlength="60"></label>
        <label>What it does<textarea name="what" rows="4" placeholder="Every day, read the production logs from the last 24 h, file an issue for each new error pattern, and stay silent when there is none."></textarea></label>
        <label>When<select name="preset"><option value="0 13 * * *">Every day at 13:00 UTC</option><option value="0 13 * * 1-5">Weekdays at 13:00 UTC</option><option value="0 12 * * 1">Mondays at 12:00 UTC</option><option value="0 */6 * * *">Every 6 hours</option><option value="custom">Custom cron</option></select></label>
        <label data-cron hidden>Cron (UTC)<input name="cron" placeholder="0 13 * * *"></label>
        <label>Model<select name="model"><option>sonnet</option><option>opus</option><option>haiku</option></select></label>
        <p class="faint">Paste this in Claude Code at the repo root. It adds a new <code>level5-*</code> skill and its roster entry in one PR, changing nothing else. After the merge, <code>/level5:setup routines</code> creates the routine in your Claude account.</p>
        <div class="nr-cmd" data-cmd>Fill in a name and what it does.</div>
        <div><button class="btn-sm" type="button" data-nr-copy>Copy command</button></div>
      </form>` });
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
      ${kv([["Labels", i.labels.map((l) => `<span class="tag ${l === "risky" ? "risky" : ""}">${esc(l)}</span>`).join("") || "none"], ["Opened", when2(i.created_at)]])}
      <p><button type="button" class="btn-sm" data-resolve="${i.number}" data-title="${esc(i.title)}" data-url="${esc(i.url)}">Resolve with Claude</button></p>` });
  // price rules: a form per rule (and one blank) as window contents
  const RULES = s.rules || [];
  const knownSources = [...new Set(["aws", "vercel", "neon", "anthropic", "claude-code", ...((C?.sources) || [])])];
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(label)}</option>`;
  const ruleForm = (r) => {
    const c = r ? r.config : { source: "any", measure: "usd", period: "day", cond: "above", amount: 50, pct: 50, days: 7, service: "", dow: [], from: "", to: "", severity: "warn" };
    return `<form class="rule-form" data-rule-id="${r ? r.id : ""}">
      <label class="f-wide">Name<input name="name" required maxlength="80" value="${esc(r?.name || "")}" placeholder="AWS over $50 a day"></label>
      <label>Provider<select name="source">${opt("any", "Any provider", c.source)}${knownSources.map((x) => opt(x, srcName(x), c.source)).join("")}</select></label>
      <label>Measure<select name="measure" data-dep>${opt("usd", "Spend (USD)", c.measure)}${opt("tokens", "Claude Code tokens", c.measure)}${opt("session_tokens", "Tokens in one session", c.measure)}</select></label>
      <label data-show="period">Period<select name="period" data-dep>${opt("day", "Per day", c.period)}${opt("week", "Rolling 7 days", c.period)}${opt("month", "Month to date", c.period)}${opt("forecast", "Month-end forecast", c.period)}</select></label>
      <label data-show="cond">Condition<select name="cond" data-dep>${opt("above", "Above a fixed amount", c.cond)}${opt("spike", "Above the recent average", c.cond)}</select></label>
      <label data-show="amount">Limit<input name="amount" type="number" min="0" step="any" value="${esc(c.amount)}"></label>
      <label data-show="spike">% above average<input name="pct" type="number" min="1" max="1000" value="${esc(c.pct)}"></label>
      <label data-show="spike">Average of the last (days)<input name="days" type="number" min="1" max="60" value="${esc(c.days)}"></label>
      <label data-show="service"><span>Service contains <small>optional</small></span><input name="service" value="${esc(c.service)}" placeholder="Elastic Container Service"></label>
      <fieldset class="f-wide"><legend>Days it applies <small>none = every day, UTC</small></legend><div class="dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => `<label class="dow-i"><input type="checkbox" name="dow" value="${i}"${c.dow.includes(i) ? " checked" : ""}><span>${d}</span></label>`).join("")}</div></fieldset>
      <label><span>Active from <small>optional</small></span><input name="from" type="date" value="${esc(c.from)}"></label>
      <label><span>Active until <small>optional</small></span><input name="to" type="date" value="${esc(c.to)}"></label>
      <label>Severity<select name="severity">${opt("warn", "Warning", c.severity)}${opt("bad", "Critical", c.severity)}</select></label>
      <div class="f-wide f-actions">${r ? `<button type="button" class="btn-plain danger" data-rule-act="delete" data-id="${r.id}">Delete</button>` : ""}<span class="f-msg" role="status"></span><button type="submit">${r ? "Save rule" : "Create rule"}</button></div>
    </form>`;
  };
  for (const r of RULES) wins.push({ key: `rule:${r.id}`, kind: "Price rule", title: r.name, body: `<p class="faint" style="margin-top:0">${esc(r.summary)}</p>${ruleForm(r)}` });
  const fmtRule = (r, v) => (v == null ? "–" : r.config.measure === "usd" ? usd(v) : tk(v));
  const rulesSection = `<h2>Price rules</h2>
    <form class="rule-nl"><input name="text" maxlength="500" autocomplete="off" placeholder="Tell me when AWS goes over $50 a day on weekdays" aria-label="Describe a price rule"><button type="submit">Add rule</button></form>
    <p class="rule-msg" role="status"></p>
    <div class="group">${RULES.length ? RULES.map((r) => {
      const pct = r.limit ? Math.min(100, (r.value / r.limit) * 100) : 0;
      const st = !r.enabled ? ["none", "Paused"] : !r.active ? ["none", "Not active now"] : r.over ? [r.config.severity === "bad" ? "bad" : "warn", "Over the limit"] : ["ok", "Within the limit"];
      return `<div class="line rule openable" data-open="rule:${r.id}" role="button" tabindex="0"><span class="name">${esc(r.summary)}<span class="sub">${esc(r.name)}${r.last_fired_at ? ` · last fired ${ago(r.last_fired_at)}` : ""}</span>
        <span class="meter" data-s="${st[0]}"><i style="width:${pct.toFixed(1)}%"></i></span></span>
        <span class="meta"><span class="state" data-s="${st[0]}">${st[1]}</span><span class="sub">${fmtRule(r, r.value)} of ${r.limit == null ? "no baseline yet" : fmtRule(r, r.limit)}</span><button type="button" class="btn-plain" data-rule-act="toggle" data-id="${r.id}">${r.enabled ? "Pause" : "Resume"}</button></span></div>`;
    }).join("") : `<div class="line"><span class="hint">No price rules yet. Write one above, the way you would say it: "AWS over $50 a day", "Claude Code tokens 50% above the weekly average", "warn me if the month-end forecast passes $1,500".</span></div>`}</div>`;
  const SVCS = C?.services || [];
  const firingRules = RULES.filter((r) => r.firing && r.enabled);
  const alarmOn = (x) => firingRules.filter((r) => (r.config.source === "any" || r.config.source === x.provider) && r.config.service && x.name.toLowerCase().includes(r.config.service.toLowerCase()));
  const trendTxt = (t) => (Math.abs(t) < 0.05 ? "flat" : `${t > 0 ? "+" : ""}${Math.round(t * 100)}%`);
  for (const x of SVCS) {
    const mx = Math.max(1e-9, ...x.per_day);
    const al = alarmOn(x);
    wins.push({ key: `service:${x.key}`, kind: srcName(x.provider), title: x.name, body: `
      <div class="w-head">${al.length ? statePill("bad", "Price rule firing") : statePill(x.trend > 0.15 ? "warn" : "ok", x.trend > 0.15 ? "Rising" : x.trend < -0.15 ? "Falling" : "Steady")}</div>
      <div class="cols w-cols">${x.per_day.map((v, i) => `<div title="${C.days[i]} · ${usd(v)}"><i style="height:${(v / mx) * 100}%"></i></div>`).join("")}</div>
      <div class="axis"><span>${WINDOW} days ago</span><span class="rule"></span><span>today</span></div>
      ${kv([["Provider", srcName(x.provider)], ["Last 30 days", usd(x.total)], ["Last 7 days", `${usd(x.last7)} <span class="faint">${trendTxt(x.trend)} vs the 7 before (${usd(x.prev7)})</span>`], ["Daily average", usd(x.total / WINDOW)], ["Price rules", al.map((r) => `<a href="#" data-open="rule:${r.id}">${esc(r.name)}</a>`).join(", ") || "none firing"]])}` });
  }
  const mapData = JSON.stringify({ services: SVCS.map((x) => ({ key: x.key, provider: x.provider, label: srcName(x.provider), name: x.name, total: x.total, last7: x.last7, prev7: x.prev7, trend: x.trend, alarm: alarmOn(x).length > 0 })) }).replace(/</g, "\\u003c");
  const mapSection = SVCS.length ? `
    <div class="map-wrap"><div id="svc-map" class="svc-map" aria-label="3D map of services by spend"><div class="map-hint">Drag to turn it · scroll to zoom · click a hall</div></div>
      <div class="map-legend"><span><i style="background:#5f9e6e"></i>Run</span><span><i style="background:#4f9a7a"></i>Edge</span><span><i style="background:#5b8ab8"></i>Data</span><span><i style="background:#7d6bb4"></i>AI</span><span><i style="background:#5a7fa8"></i>Ship</span><span><i style="background:#c9a447"></i>Watch</span><span><i style="background:#b8665f"></i>Talk</span><span class="faint">Each hall is a service · size and height = spend in ${WINDOW} days · a red beacon is a price rule firing</span></div></div>
    <script type="application/json" id="map-data">${mapData}</script>
    <h2 style="margin-top:28px">Services</h2>
    <div class="group">${SVCS.map((x) => `<div class="line openable" data-open="service:${esc(x.key)}" role="button" tabindex="0"><span class="name">${esc(x.name)}<span class="sub">${srcName(x.provider)}</span></span><span class="meta"><b>${usd(x.total)}</b> <span class="sub">${usd(x.last7)} last 7 days · ${trendTxt(x.trend)}${alarmOn(x).length ? ' · <span style="color:var(--bad)">rule firing</span>' : ""}</span></span></div>`).join("")}</div>`
    : `<div class="group"><div class="line"><span class="hint">The map draws every service you spend on, from the cost data. Nothing has arrived yet: see <a href="#setup">Setup</a>, step 4.</span></div></div>`;
  // promotions block (CI view) + a window per promotion PR that is not already an open PR window
  const P = s.promotions;
  const hrs = (h) => (h == null ? "–" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`);
  const ciTxt = { green: "Passing", red: "Failing", running: "Running", none: "No CI" };
  const promoSection = !P ? "" : !P.enabled ? `<h2>Promotions</h2><div class="group"><div class="line"><span class="hint">No promotion flow found: this repo ships from one branch${P.default_branch ? ` (<code>${esc(P.default_branch)}</code>)` : ""}. If it promotes between two, set <code>"promotion": {"from": "staging", "to": "main"}</code> in <code>.claude/factory.json</code>.</span></div></div>` : `
    <div class="promo-h"><h2>Promotions</h2><span class="flow"><code class="branch">${esc(P.from)}</code><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4"/></svg><code class="branch prod">${esc(P.to)}</code></span></div>
    ${P.open ? `<a class="group promo-open" href="${esc(P.open.url)}" target="_blank" rel="noopener"><div class="line"><span class="name">${PR_ICON.open}<span><b>Promotion in progress: #${P.open.number}</b><span class="sub">${esc(P.open.title)} · opened ${ago(P.open.created_at)} by ${esc(P.open.author)} · <code class="branch">${esc(P.open.head)}</code> → <code class="branch prod">${esc(P.to)}</code></span></span></span><span class="meta"><span class="state" data-s="${P.open.ci === "green" ? "ok" : P.open.ci === "red" ? "bad" : P.open.ci === "running" ? "warn" : "none"}"${P.open.ci === "running" ? " data-run" : ""}>${ciTxt[P.open.ci] || ""}</span></span></div></a>` : ""}
    <div class="promo-cols">
      <div><h2>Waiting for ${esc(P.to)} <span class="faint">${P.ahead ?? 0}</span></h2><div class="group promo-list more5">${P.waiting.length ? P.waiting.slice(0, 25).map((w) => `<a class="line" href="${esc(w.pr ? `${repoUrl}/pull/${w.pr}` : w.url)}" target="_blank" rel="noopener"><span class="name"><span><span class="pm">${esc(w.message.replace(/\s*\(#\d+\)\s*$/, ""))}</span><span class="sub">${w.pr ? `#${w.pr} · ` : ""}<code>${esc(w.sha)}</code> · ${esc(w.author)} · ${ago(w.at)}</span></span></span></a>`).join("") + (P.waiting.length > 25 ? `<div class="line"><span class="hint">and ${P.waiting.length - 25} more</span></div>` : "") : `<div class="line"><span class="hint">Nothing waiting: ${esc(P.to)} has everything in ${esc(P.from)}.</span></div>`}${more(Math.min(P.waiting.length, 26))}</div></div>
      <div><h2>Recent promotions</h2><div class="group promo-list more5">${P.history.length ? P.history.map((p) => `<a class="line" href="${esc(p.url)}" target="_blank" rel="noopener"><span class="name">${PR_ICON.merged}<span><span class="pm">#${p.number} ${esc(p.title)}</span><span class="sub">merged ${ago(p.merged_at)} · open ${hrs((Date.parse(p.merged_at) - Date.parse(p.created_at)) / 36e5)}${p.author ? ` · ${esc(p.author)}` : ""}</span></span></span></a>`).join("") : `<div class="line"><span class="hint">No promotion merged yet.</span></div>`}${more(P.history.length)}</div>
</div>
    </div>`;
  if (P?.enabled) for (const p of [P.open, ...P.history].filter(Boolean)) if (!wins.some((w) => w.key === `pr:${p.number}`)) wins.push({ key: `pr:${p.number}`, kind: "Promotion", title: `#${p.number} ${p.title}`, href: p.url, body: `
      <div class="w-head">${statePill(p.state === "open" ? "ok" : "merged", p.state === "open" ? "Open" : "Merged")}<span class="flow"><code class="branch">${esc(p.head)}</code> → <code class="branch prod">${esc(P.to)}</code></span></div>
      <p class="w-title">${esc(p.title)}</p>
      ${kv([["Author", esc(p.author)], ["Opened", when2(p.created_at)], ["Merged", p.merged_at ? when2(p.merged_at) : ""], ["Time to merge", p.merged_at ? hrs((Date.parse(p.merged_at) - Date.parse(p.created_at)) / 36e5) : ""], ["CI", p.ci ? ciTxt[p.ci] : ""]])}` });
  const SEC = s.security;
  const dAgo = (d) => (d ? ago(d) : "never");
  const age = (d) => (d ? `${Math.round((Date.now() - Date.parse(d)) / 864e5)} d` : "–");
  const SEVL = { critical: ["bad", "Critical"], high: ["bad", "High"], medium: ["warn", "Medium"], low: ["none", "Low"] };
  const secEmpty = `<div class="group"><div class="line"><span class="hint">No inventory yet. Run this where the AWS and Infisical CLIs are logged in (your laptop, or a routine), at the repo root:<br><code>node &lt;level5&gt;/status/scripts/security-inventory.mjs</code><br>It reads IAM users, roles and keys, and the names of your Infisical secrets, and sends only names and metadata.</span></div></div>`;
  let secSection = secEmpty;
  if (SEC) {
    const A = SEC.aws?.data, I = SEC.infisical?.data, F = SEC.findings;
    const users = A?.users || [], roles = (A?.roles || []), own = roles.filter((r) => !r.service_linked);
    const keysAll = users.flatMap((u) => u.keys.map((k) => ({ ...k, user: u.name })));
    const names = I ? [...new Set(I.folders.flatMap((f) => f.keys))] : [];
    const envs = I?.environments?.filter((e) => I.folders.some((f) => f.env === e)) || [];
    const paths = I ? [...new Set(I.folders.map((f) => f.path))].sort() : [];
    const has = (env, path, k) => I.folders.some((f) => f.env === env && f.path === path && f.keys.includes(k));
    secSection = `
    <p class="hint" style="margin:-8px 0 16px">${A ? `AWS account <code>${esc(A.account)}</code>, inventory ${ago(SEC.aws.at)}` : "No AWS inventory"}${I ? ` · Infisical, inventory ${ago(SEC.infisical.at)}` : " · no Infisical inventory"}.</p>
    <div class="group stats">
      <div class="stat"><b>${F.filter((f) => SEV[f.sev] <= 1).length}<i>/${F.length}</i></b><span>Critical or high findings</span><small>${F.length} in total</small></div>
      <div class="stat"><b>${users.length}</b><span>IAM users</span><small>${users.filter((u) => u.console && !u.mfa).length} with console and no MFA</small></div>
      <div class="stat"><b>${keysAll.length}</b><span>Active access keys</span><small>${keysAll.length ? `oldest ${age(keysAll.map((k) => k.created).filter(Boolean).sort()[0])}` : ""}</small></div>
      <div class="stat"><b>${names.length}</b><span>Secret names</span><small>${I ? `${I.folders.length} folders in ${envs.length} environment${envs.length === 1 ? "" : "s"}` : "no inventory"}</small></div>
    </div>
    <h2>Findings</h2>
    <div class="group sec-f">${F.length ? F.map((f) => `<div class="line"><span class="name"><span class="pill" data-s="${SEVL[f.sev][0]}">${SEVL[f.sev][1]}</span><span><b>${esc(f.title)}</b>${f.detail ? `<span class="sub">${esc(f.detail)}</span>` : ""}</span></span></div>`).join("") : `<div class="line"><span class="hint">Nothing to flag.</span></div>`}</div>
    ${A ? `<h2>IAM users</h2><div class="group"><table class="tbl"><thead><tr><th>User</th><th>Console</th><th>MFA</th><th>Access keys</th><th>Policies and groups</th></tr></thead><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b><span class="sub">created ${age(u.created)} ago</span></td><td>${u.console ? `yes <span class="sub">last ${dAgo(u.password_last_used)}</span>` : "no"}</td><td>${u.mfa ? '<span class="state" data-s="ok">on</span>' : u.console ? '<span class="state" data-s="bad">off</span>' : '<span class="faint">off</span>'}</td><td>${u.keys.map((k) => `<div>${age(k.created)} old · used ${dAgo(k.last_used)}${k.service ? ` <span class="faint">(${esc(k.service)})</span>` : ""}</div>`).join("") || '<span class="faint">none</span>'}</td><td>${[...u.policies, ...u.groups.map((g) => g + " (group)")].map((x) => `<code class="branch${x === "AdministratorAccess" ? " admin" : ""}">${esc(x)}</code>`).join(" ") || '<span class="faint">none</span>'}</td></tr>`).join("") || `<tr><td colspan="5" class="hint">No IAM users.</td></tr>`}</tbody></table></div>
    ${A.root ? `<p class="hint" style="margin:-20px 0 28px">Root account: MFA ${A.root.mfa ? "on" : '<b style="color:var(--bad)">off</b>'}, ${A.root.keys.length ? `<b style="color:var(--bad)">${A.root.keys.length} access key${A.root.keys.length === 1 ? "" : "s"}</b>` : "no access keys"}, last console sign-in ${dAgo(A.root.password_last_used)}.</p>` : ""}
    <div class="rules-h"><h2>IAM roles <span class="faint">${own.length} yours, ${roles.length - own.length} service-linked</span></h2><label class="pick sl-toggle"><input type="checkbox" class="sl-cb"> Show service-linked</label></div>
    <div class="group roles-g"><table class="tbl"><thead><tr><th>Role</th><th>Trusted by</th><th>Policies</th><th>Last used</th></tr></thead><tbody>${roles.sort((a, b) => a.service_linked - b.service_linked || a.name.localeCompare(b.name)).map((r) => `<tr${r.service_linked ? ' class="sl"' : ""}><td><b>${esc(r.name)}</b>${r.description ? `<span class="sub">${esc(r.description)}</span>` : ""}</td><td>${r.trusted.map((t) => `<code class="branch">${esc(t.replace(/^arn:aws:iam::\\d+:/, ""))}</code>`).join(" ")}</td><td>${r.policies.map((x) => `<code class="branch${x === "AdministratorAccess" ? " admin" : ""}">${esc(x)}</code>`).join(" ") || '<span class="faint">inline only</span>'}</td><td>${r.last_used ? `${ago(r.last_used)}${r.last_region ? ` <span class="faint">${esc(r.last_region)}</span>` : ""}` : '<span class="faint">never</span>'}</td></tr>`).join("")}</tbody></table></div>` : ""}
    ${I ? `<div class="rules-h"><h2>Infisical secrets <span class="faint">${names.length} names</span></h2><input type="search" class="sec-q" placeholder="Filter keys" aria-label="Filter secret names"></div>
    <div class="group sec-m"><table class="tbl"><thead><tr><th>Key</th><th>Folder</th>${envs.map((e) => `<th class="c">${esc(e)}</th>`).join("")}</tr></thead><tbody>${paths.flatMap((pth) => [...new Set(I.folders.filter((f) => f.path === pth).flatMap((f) => f.keys))].sort().map((k) => `<tr data-k="${esc(k.toLowerCase())}"><td><code>${esc(k)}</code></td><td class="faint">${esc(pth)}</td>${envs.map((e) => `<td class="c">${has(e, pth, k) ? '<span class="dot-y" title="present"></span>' : '<span class="dot-n" title="missing">–</span>'}</td>`).join("")}</tr>`)).join("")}</tbody></table></div>` : ""}`;
  }
  const winTemplates = `<div id="win-tpl" hidden>${wins.map((w) => `<template data-key="${esc(w.key)}" data-kind="${esc(w.kind)}" data-title="${esc(w.title)}" data-href="${esc(w.href || "")}">${w.body}</template>`).join("")}</div>`;

  // issues, in the same rows as pull requests: icon, title, number and age, labels on the right
  const ISSUE_ICON = `<svg class="gi" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="#1a7f37" stroke-width="1.5"/><circle cx="8" cy="8" r="1.5" fill="#1a7f37"/></svg>`;
  // Resolve with Claude: starts the repo's "Level 5: Run" routine on the issue and opens its session
  const resolveBtn = (i) => `<button type="button" class="btn-sm rz-btn" data-resolve="${i.number}" data-title="${esc(i.title)}" data-url="${esc(i.url)}">Resolve with Claude</button>`;
  const resolveSetup = `<div class="rz-setup" id="rz-setup" hidden><h3>Resolve issues with Claude</h3><p>One click starts a Claude Code session on your Claude account that fixes the issue with a failing test first and opens a PR. It never merges. Once per repo:</p><ol><li>In Claude Code at the repo root, run <code>/level5:setup run</code> and merge its PR. It adds the skill the session runs and gives you the routine to create.</li><li>On claude.ai, create the routine <b>Level 5: Run</b> with an API trigger, as it says.</li><li>Paste the trigger's URL and token here.</li></ol><div class="rt-fire" data-routine="Level 5: Run" data-mini="1"></div></div>`;
  const incidents = s.queue.issues.length
    ? `<div class="group more5">${s.queue.issues.map((i) => `<div class="rz"><a class="line pr" href="${esc(i.url)}" target="_blank" rel="noopener" data-open="issue:${i.number}"><span class="name">${ISSUE_ICON}<span><span class="pr-title">${esc(i.title)}</span><span class="sub">#${i.number} · opened ${ago(i.created_at)}</span></span></span><span class="meta">${i.labels.map((l) => `<span class="tag${l === "risky" ? " risky" : ""}">${esc(l)}</span>`).join("")}</span></a>${resolveBtn(i)}</div>`).join("")}${more(s.queue.issues.length)}</div>`
    : `<div class="group"><div class="line"><span class="hint">No open issues.</span></div></div>`;

  const M = s.metrics;
  const dur = (h) => (h == null ? "–" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} d`);
  const n = (x) => (x == null ? "–" : x);
  const maxDay = M ? Math.max(1, ...M.prs.per_day.map((d) => d.all)) : 1;
  const kn = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const metrics = !M ? "" : `
    <h2>Last ${WINDOW} days</h2>
    <div class="group stats stats5">
      <div class="stat"><b>${n(M.prs.merged)}</b><span>PRs merged</span><small>${M.prs.agent_share == null ? "" : `${M.prs.agent_share}% by agents · `}${n(M.prs.opened)} opened</small></div>
      <div class="stat"><b>${dur(M.prs.median_merge_h)}</b><span>Median time to merge</span><small>${n(M.prs.closed_unmerged)} closed without merge</small></div>
      <div class="stat"><b>${n(M.issues.closed)}<i>/${n(M.issues.opened)}</i></b><span>Issues closed / opened</span><small>${M.issues.open} open${M.issues.median_age_d == null ? "" : `, median age ${Math.round(M.issues.median_age_d)} d`}</small></div>
      <div class="stat"><b class="loc">${M.prs.added == null ? "–" : `<span class="add">+${kn(M.prs.added)}</span> <span class="del">−${kn(M.prs.deleted)}</span>`}</b><span>Lines changed</span><small>${M.prs.median_lines == null ? "in merged PRs" : `median PR ${M.prs.median_lines.toLocaleString("en-US")} lines`}</small></div>
      <div class="stat"><b>${M.ci.pass_rate == null ? "–" : M.ci.pass_rate + "%"}</b><span>CI runs passing</span><small data-s="${M.ci.failing_now.length ? "bad" : "ok"}">${M.ci.failing_now.length ? `Failing now: ${esc(M.ci.failing_now.join(", "))}` : `${M.ci.runs} runs, none failing now`}</small></div>
      <div class="chart" aria-label="PRs merged per day">
        <div class="cols">${M.prs.per_day.map((d) => `<div title="${d.d} · ${d.all} merged · ${d.agents} by agents · ${d.all - d.agents} by people${d.added != null ? ` · +${d.added.toLocaleString("en-US")} −${(d.deleted || 0).toLocaleString("en-US")} lines` : ""}"><i style="height:${(d.all / maxDay) * 100}%"><em style="height:${d.all ? (d.agents / d.all) * 100 : 0}%"></em></i></div>`).join("")}</div>
        <div class="axis"><span>PRs merged per day</span><span class="rule"></span><span><span class="key"></span> by agents</span></div>
      </div>
    </div>`;

  const onboarding = repoRow && s.counts.heartbeats === 0;
  const setupState = { ...(s.setup || {}), cost_sources: s.costs?.sources || [], sessions: s.costs?.sessions_30d || 0 };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // --- left-nav app: one page, one view per section, switched by the URL hash ---------------
  const NAV_ICON = {
    live: `<circle cx="8" cy="8" r="2.2"/><path d="M4.2 4.2a5.4 5.4 0 0 0 0 7.6M11.8 4.2a5.4 5.4 0 0 1 0 7.6M2.3 2.3a8 8 0 0 0 0 11.4M13.7 2.3a8 8 0 0 1 0 11.4"/>`,
    marketing: `<path d="M2 6.5v3h2.5l5 3v-9l-5 3z"/><path d="M12 6a2.5 2.5 0 0 1 0 4"/>`,
    security: `<path d="M8 1.8l5 2v4c0 3.2-2.2 5.5-5 6.4-2.8-.9-5-3.2-5-6.4v-4z"/><path d="M5.8 8.2l1.6 1.6 3-3.2"/>`,
    reports: `<path d="M4 1.8h5.5l3 3v9.4H4z"/><path d="M9.5 1.8v3h3M6 8h5M6 10.5h5M6 13h3"/>`,
    services: `<path d="M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9z"/><path d="M2.4 4.9L8 8l5.6-3.1M8 8v6.2"/>`,
    assistant: `<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 7h.01M8 7h.01M10.5 7h.01"/>`,
    overview: `<path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z"/>`,
    monitors: `<path d="M1.5 8.5h3l1.8-4.5 3.4 8.5 1.8-4h3"/>`,
    status: `<path d="M2.5 13.5V9M5.5 13.5V6M8.5 13.5V8M11.5 13.5V3.5M14 13.5H1.5"/>`,
    automations: `<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>`,
    ci: `<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.8 1.8 3.3-3.6"/>`,
    prs: `<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6.5A2 2 0 0 0 10 4.5H7.5M9 3l-1.5 1.5L9 6"/>`,
    issues: `<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.2"/>`,
    costs: `<path d="M10.8 5.2c-.4-.9-1.5-1.5-2.8-1.5-1.6 0-2.8.8-2.8 2 0 2.9 5.8 1.6 5.8 4.5 0 1.2-1.3 2.1-3 2.1-1.4 0-2.6-.6-3-1.6M8 2v1.7M8 12.3V14"/>`,
    setup: `<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>`,
  };
  const ico = (k) => `<svg class="ni" viewBox="0 0 16 16" aria-hidden="true">${NAV_ICON[k]}</svg>`;
  const badMon = MON.filter((m) => ["dead", "lying", "degraded"].includes(m.state)).length;
  const warnMon = MON.filter((m) => m.state === "warn").length;
  const lateN = s.routines.filter(isLate).length;
  const failingCi = (s.ci || []).filter((w) => w.last?.status === "completed" && w.last.conclusion === "failure").length;
  const badge = (n, tone) => (n ? `<span class="nb" data-t="${tone}">${n}</span>` : "");
  const count = (n) => (n ? `<span class="nc">${n}</span>` : "");
  const needsN = ((s.status?.groups) || []).flatMap((g) => g.rows).filter((r) => ["dead", "degraded", "lying", "warn", "late"].includes(r.state)).length;
  const NAV = [
    ["status", "Status", needsN ? badge(needsN, "bad") : ""],
    ["live", "Live", `<span class="nc" id="lv-n"></span>`],
    ["monitors", "Monitors", badMon ? badge(badMon, "bad") : warnMon ? badge(warnMon, "warn") : count(MON.length)],
    ["automations", "Automations", lateN ? badge(lateN, "bad") : count(s.routines.length)],
    ["ci", "CI", failingCi ? badge(failingCi, "bad") : count((s.ci || []).length)],
    ["prs", "Pull requests", count(s.queue.prs.length)],
    ["issues", "Issues", count(s.queue.issues.length)],
    ["costs", "Costs", C ? `<span class="nc">${usd(C.total_usd)}</span>` : ""],
    ...(s.marketing ? [["marketing", "Marketing", `<span class="nc">${s.marketing.total.leads} leads</span>`]] : []),
    ["reports", "Reports", (() => { const n = (s.status?.reports || []).filter((r) => ["dead", "late", "warn", "degraded", "lying"].includes(r.state)).length; return n ? badge(n, "bad") : count((s.status?.reports || []).length); })()],
    ["services", "Services", ""],
  ];
  const navLink = ([k, label, extra]) => `<a href="#${k}" data-nav="${k}">${ico(k)}<span>${label}</span>${extra}</a>`;
  const vh = (title, desc) => `<header class="vh"><h1>${title}</h1>${desc ? `<p>${desc}</p>` : ""}</header>`;
  const view = (k, body) => `<section class="view" data-view="${k}">${body}</section>`;
  const liveBox = (compact) => `<div class="ci-live"${compact ? ' data-compact="1"' : ""} aria-live="polite"><div class="live-head"><h2>Actions</h2><span class="live-dot"></span><span class="live-meta">Checking…</span></div></div>`;

  // --- the status chart: skills grouped by the routine that runs them ----------------------
  const ST = s.status || { groups: [], usd_30d: 0 };
  const SK = { alive: ["ok", "Running"], warn: ["warn", "Degraded"], degraded: ["bad", "Often degraded"], lying: ["warn", "Read nothing"], late: ["bad", "Missed the last run"], dead: ["bad", "Stopped"], silent: ["none", "No heartbeat yet"] };
  const allRows = ST.groups.flatMap((g) => g.rows);
  const needs = allRows.filter((r) => ["dead", "degraded", "lying", "warn", "late"].includes(r.state));
  const sched = (cron) => { if (!cron) return ""; const f = cron.split(/\s+/); const t = `${f[1].padStart(2, "0")}:${f[0].padStart(2, "0")} UTC`; return f[4] !== "*" && /^\d$/.test(f[4]) ? `${DOW[Number(f[4])]} ${t}` : f[2] === "*" && f[4] === "*" && /^\d+$/.test(f[1]) ? `daily ${t}` : cron; };
  const barTip = (r, b) => {
    if (!b.label) return "";
    const what = { ok: "ran", warn: `ran, ${b.status}`, empty: "ran, read nothing", miss: "should have run, did not", "": "nothing expected" }[b.s];
    return [b.label, what, b.read != null && r.unit ? `${b.read.toLocaleString("en-US")} ${r.unit}` : "", b.runs > 1 ? `${b.runs} runs` : "", b.usd ? usd(b.usd) : "", b.note].filter(Boolean).join(" · ");
  };
  const skRow = (r) => {
    const [ps, label] = SK[r.state] || ["none", r.state];
    const bars = r.buckets.map((b) => `<i data-s="${b.s === "empty" ? "warn" : b.s}" title="${esc(barTip(r, b))}"></i>`).join("");
    const sub = r.last ? `last run ${ago(r.last)}` : "never reported";
    const open = s.monitors.some((m) => m.id === r.id) ? ` openable" data-open="monitor:${esc(r.id)}" role="button" tabindex="0` : "";
    return `<div class="row sk-row${open}">
      <div class="row-head"><span class="name"><span class="mon-id">${esc(r.id)}</span><small>${sub}</small></span><span class="state" data-s="${ps}" title="${esc(r.why)}">${label}</span></div>
      <div class="bars${r.weekly ? " wk" : ""}">${bars}</div>
    </div>`;
  };
  // --- Status: the one page. Only what is wrong, then what it costs, then the numbers ----------
  const late = s.routines.filter(isLate).filter((r) => !ST.groups.some((g) => g.name === r.name.replace(/^App: /, "") && g.rows.some((x) => x.state === "late")));
  const failing = (s.ci || []).filter((w) => w.last?.status === "completed" && w.last.conclusion === "failure");
  const secHi = (s.security?.findings || []).filter((f) => SEV[f.sev] <= 1);
  const fired = (s.rules || []).filter((r) => r.firing && r.enabled);
  const alertLine = (tone, label, title, sub, open) => open.startsWith("#") ? `<a class="line" href="${open}"><span class="name"><span><b>${title}</b>${sub ? `<span class="sub">${sub}</span>` : ""}</span></span><span class="meta"><span class="state" data-s="${tone}">${label}</span></span></a>` : `<div class="line${open ? ` openable" ${open} role="button" tabindex="0` : ""}"><span class="name"><span><b>${title}</b>${sub ? `<span class="sub">${sub}</span>` : ""}</span></span><span class="meta"><span class="state" data-s="${tone}">${label}</span></span></div>`;
  const others = [
    ...failing.map((w) => alertLine("bad", "Failing", `CI: ${esc(w.name)}`, `${w.last.branch ? `${esc(w.last.branch)} · ` : ""}failed ${ago(w.last.at)}`, `data-open="workflow:${esc(encodeURIComponent(w.path))}"`)),
    ...late.map((r) => alertLine("bad", "Late", esc(r.name.replace(/^App: /, "")), `last seen ${r.last_seen ? ago(r.last_seen) : "never"} · expected every ${hrs(r.period_h)}`, `data-open="routine:${esc(encodeURIComponent(r.name))}"`)),
    ...fired.map((r) => alertLine("bad", "Price rule", esc(r.name), esc(r.summary), `data-open="rule:${r.id}"`)),
    ...(secHi.length ? [alertLine("bad", "Security", `${plural(secHi.length, "critical or high finding")}`, esc(secHi.slice(0, 3).map((f) => f.title).join(" · ")), "")] : []),
  ];
  const nAlerts = needs.length + others.length;
  const stOverall = needs.some((r) => ["dead", "degraded", "late"].includes(r.state)) || others.length ? "down" : needs.length ? "degraded" : "ok";
  const healthy = allRows.length - needs.length;
  const topRoutines = ST.groups.filter((g) => g.usd_30d).sort((a, b) => b.usd_30d - a.usd_30d).slice(0, 4);
  const costBlock = !C ? `<div class="group"><div class="line"><span class="hint">No cost data yet. <a href="#costs">How to connect</a>.</span></div></div>` : `
    <div class="group stats">
      <div class="stat"><b>${usd(C.total_usd)}</b><span>Spent in ${WINDOW} days</span><small>${C.sources.map((k) => `${srcName(k)} ${usd(C.total[k])}`).join(" · ")}</small></div>
      <div class="stat"><b>${usd(C.yesterday)}</b><span>Yesterday</span><small>${usd(C.avg7)} a day over the last 7</small></div>
      <div class="stat"><b>${tk(C.tokens_30d)}</b><span>Claude Code tokens</span><small>${C.sessions_30d} cloud session${C.sessions_30d === 1 ? "" : "s"}</small></div>
      <div class="stat"><b>${topRoutines.length ? usd(topRoutines[0].usd_30d) : "–"}</b><span>${topRoutines.length ? `Top routine: ${esc(topRoutines[0].name)}` : "Per routine"}</span><small>${topRoutines.slice(1).map((g) => `${esc(g.name)} ${usd(g.usd_30d)}`).join(" · ") || (topRoutines.length ? "" : "no session costs yet")}</small></div>
      <div class="chart cx cx-mini" id="cx-home"><div class="cx-sub" hidden></div><div class="cx-chart" role="img" aria-label="Spend per day by service"><div class="cx-loading">Loading cost data…</div></div><div class="cx-legend"></div></div>
    </div>`;
  const statusView = `
        <div class="banner" data-s="${stOverall}">${stOverall === "ok" ? CHECK : ALERT}<span>${nAlerts ? `${plural(nAlerts, "thing")} need${nAlerts === 1 ? "s" : ""} a look` : "Nothing needs attention"}</span></div>
        <p class="banner-sub">${allRows.length ? `${healthy} of ${plural(allRows.length, "skill")} ran as expected. ` : ""}${plural(s.counts.merged_24h, "PR")} merged in 24 h, ${s.counts.agent_merged_24h} by agents. ${s.queue.prs.length ? `${plural(s.queue.prs.length, "PR")} open.` : "No open PRs."}</p>
        ${onboarding ? `<section id="onboard" class="onboard"><h2>Finish setting up ${esc(s.repo)}</h2>${heartbeatSetup(origin, repoRow.ingest_key, true, setupState)}</section>` : ""}
        ${nAlerts ? `<h2>Needs a look</h2>
        ${needs.length ? `<div class="group${needs.length > 1 ? " grid3" : ""}">${needs.map(skRow).join("")}</div>` : ""}
        ${others.length ? `<div class="group">${others.join("")}</div>` : ""}
        ${needs.length ? `<p class="sk-key"><i data-s="ok"></i>ran <i data-s="warn"></i>degraded or read nothing <i data-s="miss"></i>should have run, did not <i></i>nothing expected</p>` : ""}` : ""}
        <div class="rules-h"><h2>Costs</h2><a class="more" href="#costs">All costs →</a></div>
        ${costBlock}
        ${metrics}`;

  // Every section opens the same way: a row of numbers in the section's own unit, then that unit
  // per day for 30 days. series: [{ name, color, v: [per day] }]; stacked, or side by side ("grouped").
  const PAL = ["#5e6ad2", "#26b5ce", "#4cb782", "#f2c94c", "#f2994a", "#eb5757", "#bb87fc"];
  const topN = (list, n = 7) => { const tot = (x) => x.v.reduce((a, b) => a + b, 0); const r = list.filter((x) => tot(x) > 0).sort((a, b) => tot(b) - tot(a)); const out = r.slice(0, n).map((x, i) => ({ ...x, color: x.color || PAL[i % PAL.length] })); if (r.length > n) out.push({ name: "Others", color: "#c4c6cc", v: r[0].v.map((_, i) => r.slice(n).reduce((a, x) => a + x.v[i], 0)) }); return out; };
  const dayChart = (dates, series, fmt, { grouped = false, extra = () => "" } = {}) => {
    if (!dates?.length || !series.length) return "";
    const tot = dates.map((_, i) => series.reduce((a, x) => a + (x.v[i] || 0), 0));
    const mx = Math.max(1e-9, ...(grouped ? series.flatMap((x) => x.v) : tot));
    const tip = (d, i) => [d, grouped ? "" : `${fmt(tot[i])} in total`, ...series.filter((x) => x.v[i] > 0).sort((a, b) => (grouped ? 0 : b.v[i] - a.v[i])).map((x) => `${x.name}: ${fmt(x.v[i])}`), extra(i)].filter(Boolean).join(" · ");
    const col = (d, i) => grouped
      ? `<div class="grp" title="${esc(tip(d, i))}">${series.map((x) => `<i style="height:${((x.v[i] || 0) / mx) * 100}%;background:${x.color}"></i>`).join("")}</div>`
      : `<div title="${esc(tip(d, i))}"><i class="stack" style="height:${(tot[i] / mx) * 100}%">${series.map((x) => (x.v[i] > 0 ? `<em style="height:${(x.v[i] / tot[i]) * 100}%;background:${x.color}"></em>` : "")).join("")}</i></div>`;
    return `<div class="chart"><div class="cols day-cols">${dates.map(col).join("")}</div>
      <div class="axis"><span>${WINDOW} days ago</span><span class="rule"></span><span>today</span></div>
      <div class="ci-legend">${series.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join("")}</div></div>`;
  };
  const tile = (big, label, small = "") => `<div class="stat"><b>${big}</b><span>${label}</span><small>${small}</small></div>`;
  const head = (tiles, chart) => `<div class="group stats">${tiles.join("")}${chart}</div>`;
  const mm = (m) => (m >= 600 ? `${Math.round(m / 60)} h` : m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);
  const num = (n) => Math.round(n).toLocaleString("en-US");

  // CI: minutes per day by workflow
  const CIW = (s.ci || []).filter((w) => w.mins);
  let ciMinutes = "";
  if (CIW.length) {
    const series = topN(CIW.map((w) => ({ name: w.name, v: w.mins })));
    const dates = CIW[0].dates || [];
    const dayTot = dates.map((_, i) => series.reduce((a, x) => a + x.v[i], 0)), all = dayTot.reduce((a, b) => a + b, 0);
    const runs = (s.ci || []).reduce((a, w) => a + w.runs, 0), top = series[0];
    ciMinutes = head([
      tile(mm(all), `CI time in ${WINDOW} days`, `${num(all)} minutes, wall clock`),
      tile(mm(dayTot.at(-2) || 0), "Yesterday", `${mm(dayTot.slice(-8, -1).reduce((a, b) => a + b, 0) / 7)} a day over the last 7`),
      tile(esc(top.name), "Most time", `${mm(top.v.reduce((a, b) => a + b, 0))}, ${Math.round((top.v.reduce((a, b) => a + b, 0) / Math.max(1, all)) * 100)}% of all`),
      tile(num(runs), "Runs", `${mm(all / Math.max(1, runs))} each on average`),
    ], dayChart(dates, series, mm));
  }

  // Monitors: skill runs per day, by how they went
  const dailyRows = (s.status?.groups || []).flatMap((g) => g.rows).filter((r) => !r.weekly && !RPT.has(r.id) && r.buckets.length === WINDOW);
  const mDates = s.status?.daily?.dates || [];
  let monHead = "";
  if (dailyRows.length && mDates.length) {
    const cnt = (k) => mDates.map((_, i) => dailyRows.filter((r) => k.includes(r.buckets[i]?.s)).length);
    const ok = cnt(["ok"]), bad = cnt(["warn", "empty"]), miss = cnt(["miss"]);
    const sum = (a) => a.reduce((x, y) => x + y, 0), due = sum(ok) + sum(bad) + sum(miss);
    monHead = head([
      tile(num(sum(ok) + sum(bad)), `Skill runs in ${WINDOW} days`, `${dailyRows.length} daily skills`),
      tile(due ? Math.round((sum(ok) / due) * 100) + "%" : "–", "Ran clean", "of the runs that were due"),
      tile(num(sum(bad)), "Degraded or read nothing", ""),
      tile(num(sum(miss)), "Missed", "should have run, did not"),
    ], dayChart(mDates, [{ name: "Ran", color: "#4cb782", v: ok }, { name: "Degraded or read nothing", color: "#f2994a", v: bad }, { name: "Missed", color: "#eb5757", v: miss }], (n) => plural(n, "skill")));
  }

  // Automations: the week. What is scheduled, what ran, and what it took (tokens, time, money).
  const AD = s.status?.daily;
  let autoHead = "", weekGrid = "";
  if (AD?.routines?.length || s.routines.length) {
    const DAYMS = 864e5, today = new Date().toISOString().slice(0, 10);
    const mon = new Date(Date.parse(today + "T00:00:00Z") - ((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7) * DAYMS);
    const week = [...Array(7)].map((_, i) => new Date(mon.getTime() + i * DAYMS).toISOString().slice(0, 10));
    const di = (d) => (AD?.dates || []).indexOf(d);
    const fires = (cron, d) => { const out = [], end = Date.parse(d + "T00:00:00Z") + DAYMS; let t = nextRun(cron, new Date(Date.parse(d + "T00:00:00Z") - 6e4)); while (t && Date.parse(t) < end && out.length < 48) { out.push(t); t = nextRun(cron, new Date(t)); } return out; };
    const rows = s.routines.map((r) => {
      const a = (AD?.routines || []).find((x) => x.name === r.name.replace(/^App: /, "")), h = RH[r.name];
      const ranOn = (d) => { const i = di(d); if (a && i >= 0) return a.runs[i] > 0; if (h?.buckets?.length === WINDOW && i >= 0) return ["ok", "warn"].includes(h.buckets[i]?.s); return null; };
      const cells = week.map((d) => {
        const f = fires(r.cron, d);
        if (!f.length) return { s: "" };
        const ran = ranOn(d), past = d < today || (d === today && Date.parse(f[0]) < Date.now() - 2 * 36e5);
        return { s: ran ? "ok" : d > today || (d === today && !past) ? "next" : ran === null ? "unk" : "miss", n: f.length, t: f[0].slice(11, 16) };
      });
      return { r, cells, a };
    });
    const sumW = (k) => (AD?.routines || []).reduce((acc, x) => acc + week.reduce((p, d) => p + (di(d) >= 0 ? x[k]?.[di(d)] || 0 : 0), 0), 0);
    const sched = rows.reduce((a, x) => a + x.cells.reduce((p, c) => p + (c.s ? c.n || 1 : 0), 0), 0);
    const done = rows.reduce((a, x) => a + x.cells.filter((c) => c.s === "ok").length, 0), missed = rows.reduce((a, x) => a + x.cells.filter((c) => c.s === "miss").length, 0);
    const wTok = sumW("tokens"), wUsd = sumW("usd"), wSec = sumW("secs");
    const hm = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.round(sec / 60)} min`);
    autoHead = head([
      tile(`${num(done)}<i>/${num(sched)}</i>`, "Runs this week", `${missed ? `${missed} missed · ` : ""}${(sched / 7).toFixed(1)} scheduled a day`),
      tile(wTok ? tk(wTok) : "–", "Tokens this week", wTok ? `${tk(wTok / Math.max(1, done))} a run` : "routines have not reported tokens yet"),
      tile(wSec ? hm(wSec) : "–", "Time this week", wSec ? `${hm(wSec / Math.max(1, done))} a run` : "routines have not reported duration yet"),
      tile(wUsd ? usd(wUsd) : "–", "Cost this week", "Claude Code, at API list prices"),
    ], (() => {
      const tokSeries = topN((AD?.routines || []).map((r) => ({ name: r.name, v: r.tokens })));
      const runSeries = topN((AD?.routines || []).map((r) => ({ name: r.name, v: r.runs })));
      return tokSeries.length ? dayChart(AD.dates, tokSeries, (n) => tk(n) + " tokens") : dayChart(AD?.dates || [], runSeries, (n) => plural(n, "run"));
    })());
    const calRuns = [];
    for (const x of rows) {
      const a2 = x.a, h = RH[x.r.name];
      for (let i = -1; i < 8; i++) {
        const d = new Date(mon.getTime() + i * DAYMS).toISOString().slice(0, 10);
        const ran = (() => { const k = di(d); if (a2 && k >= 0) return a2.runs[k] > 0; if (h?.buckets?.length === WINDOW && k >= 0) return ["ok", "warn"].includes(h.buckets[k]?.s); return null; })();
        const k = di(d), day = (f) => (a2 && k >= 0 ? a2[f]?.[k] || 0 : 0);
        for (const t of fires(x.r.cron, d)) calRuns.push({ n: x.r.name.replace(/^App: /, ""), t, s: ran ? "ok" : Date.parse(t) > Date.now() - 2 * 36e5 ? "next" : ran === null ? "unk" : "miss", tok: day("tokens"), usd: day("usd"), secs: day("secs") });
      }
    }
    const calMeta = Object.fromEntries(rows.map((x) => {
      const r = x.r, h = RH[r.name], b = h?.buckets || [], due = b.filter((y) => y.s);
      return [r.name.replace(/^App: /, ""), { key: `routine:${encodeURIComponent(r.name)}`, cmd: r.source === "Claude Code" ? ((r.prompt || "").match(/\/([a-z][a-z0-9:_-]*)/) || [])[1] || "" : r.prompt.replace(/^\.github\/workflows\//, ""), src: r.source, sched: when(r), model: r.model || "", last: r.last_seen, next: r.next_run, on: due.length ? Math.round((due.filter((y) => y.s !== "miss").length / due.length) * 100) : null, skills: h?.skills?.length || 0, usd30: h?.usd_30d || 0, bars: b.map((y) => ({ ok: "o", warn: "w", empty: "w", miss: "m" })[y.s] || "_").join(""), weekly: !!h?.weekly }];
    }));
    weekGrid = `<div class="group cal" id="cal"><script type="application/json" class="cal-data">${JSON.stringify(calRuns).replace(/</g, "\\u003c")}</script><script type="application/json" class="cal-meta">${JSON.stringify(calMeta).replace(/</g, "\\u003c")}</script></div>
      <p class="sk-key"><span class="wk-k" data-s="ok"></span>ran <span class="wk-k" data-s="miss"></span>should have run, did not <span class="wk-k" data-s="next"></span>scheduled · times in ${tz ? esc(tz.replace(/_/g, " ")) : "your browser's time zone"} · <a href="/settings">change</a></p><div style="height:14px"></div>`;
  }

  // Reports: the weekly ones. Unit: reports per week, delivered or missed.
  const mdHtml = (t) => esc(t).replace(/^### (.+)$/gm, "<h5>$1</h5>").replace(/^## (.+)$/gm, "<h4>$1</h4>").replace(/^# (.+)$/gm, "<h3>$1</h3>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/^[-*] (.+)$/gm, "<li>$1</li>").replace(/(<li>.*<\/li>\n?)+/g, (m) => "<ul>" + m.replace(/\n/g, "") + "</ul>").replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
  const RP = s.status?.reports || [];
  let reportsView = `<div class="group"><div class="line"><span class="hint">No weekly reports yet. A skill whose routine runs once a week shows up here.</span></div></div>`;
  if (RP.length) {
    const wk = RP.filter((r) => r.buckets.length === 12);
    const wkLabels = [...Array(12)].map((_, i) => `Week to ${new Date(Date.now() - (11 - i) * 7 * 864e5).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`);
    const sent = wkLabels.map((_, i) => wk.filter((r) => ["ok", "warn", "empty"].includes(r.buckets[i]?.s)).length), missed = wkLabels.map((_, i) => wk.filter((r) => r.buckets[i]?.s === "miss").length);
    const totS = sent.reduce((a, b) => a + b, 0), totM = missed.reduce((a, b) => a + b, 0);
    const last = RP.flatMap((r) => r.items.slice(0, 1).map((x) => ({ ...x, id: r.id }))).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
    const head2 = head([
      tile(num(totS), "Reports in 12 weeks", `${RP.length} weekly report${RP.length === 1 ? "" : "s"}`),
      tile(totS + totM ? Math.round((totS / (totS + totM)) * 100) + "%" : "–", "Delivered", "of the ones that were due"),
      tile(num(totM), "Missed", "should have gone out, did not"),
      tile(last ? ago(last.ts).replace(" ago", "") : "–", "Since the last one", last ? esc(last.id) : ""),
    ], dayChart(wkLabels, [{ name: "Delivered", color: "#4cb782", v: sent }, { name: "Missed", color: "#eb5757", v: missed }], (n) => plural(n, "report")).replace(`${WINDOW} days ago`, "12 weeks ago").replace(">today<", ">this week<"));
    const card = (r) => {
      const [ps, label] = SK[r.state] || ["none", r.state], x = r.items[0], rt = s.routines.find((y) => y.name === r.routine);
      const read = x ? Object.entries(x.swept || {}).map(([k, v]) => `${typeof v === "number" ? v.toLocaleString("en-US") : esc(JSON.stringify(v))} ${esc(k)}`).join(" · ") : "";
      const link = r.body ? `<span class="rp-open">${esc(r.body.title || "The last one sent")} <span class="faint">· ${ago(r.body.at)}</span></span>` : "";
      const body = link && !x?.report ? link : x?.report ? link + `<details class="rp-body" open><summary>${esc(x.title || "This week's report")}</summary><div class="md"><p>${mdHtml(x.report)}</p></div></details>`
        : `<p class="rp-none">${x?.note ? esc(x.note) + ". " : ""}The report itself is not in Level 5 yet: its skill posts it with <code>level5.sh body</code>.</p>`;
      const past = r.items.slice(1).map((y) => `<div class="line"><span class="name"><span>${new Date(y.ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}<span class="sub">${esc(y.title || y.note || Object.entries(y.swept || {}).map(([k, v]) => `${v} ${k}`).join(" · "))}</span></span></span><span class="meta"><span class="state" data-s="${y.status === "ok" ? "ok" : "warn"}">${y.status === "ok" ? "Delivered" : esc(y.status)}</span></span></div>`).join("");
      return `<section class="rp${r.body ? " rp-click" : ""}"${r.body ? ` data-body="/r/${esc(s.repo)}/body/${encodeURIComponent(r.id)}" title="Open the last report as it was sent"` : ""}>
        <div class="rp-h"><span class="name"><b>${esc(r.id)}</b><small>${[rt ? `<span class="utc">${esc(when(rt))}</span>` : "", x ? `last ${ago(x.ts)}` : "never sent", read].filter(Boolean).join(" · ")}</small></span><span class="state" data-s="${ps}">${label === "Running" ? "Delivered" : label}</span></div>
        ${r.buckets.length ? `<div class="bars wk">${r.buckets.map((b) => `<i data-s="${b.s === "empty" ? "warn" : b.s}" title="${esc(barTip(r, b))}"></i>`).join("")}</div>` : ""}
        ${body}
        ${past ? `<div class="group more5 rp-past">${past}${more(r.items.length - 1)}</div>` : ""}
      </section>`;
    };
    reportsView = head2 + `<div class="rps">${RP.map(card).join("")}</div><script>if(!window.level5Rp){window.level5Rp=1;document.addEventListener("click",ev=>{const c=ev.target.closest(".rp-click");if(!c||ev.target.closest("a,summary,details .line"))return;ev.preventDefault();level5Report(c.dataset.body,c.querySelector(".rp-h b").textContent)});window.level5Report=(u,t)=>{let m=document.getElementById("rp-modal");if(!m){m=document.createElement("div");m.id="rp-modal";m.className="rp-modal";m.innerHTML='<div class="rp-dlg" role="dialog" aria-modal="true"><div class="rp-bar"><b></b><a target="_blank" rel="noopener">Open in a tab</a><button type="button" aria-label="Close">×</button></div><iframe sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe></div>';document.body.appendChild(m);m.addEventListener("click",e=>{if(e.target===m||e.target.closest("button"))m.hidden=true});addEventListener("keydown",e=>{if(e.key==="Escape")m.hidden=true})}m.querySelector("b").textContent=t;m.querySelector("a").href=u;m.querySelector("iframe").src=u;m.hidden=false}}</script>`;
  }

  // Live: runs drawn in the browser from /r/<repo>/runs, every 5 s while the view is open
  const otelEnv = repoRow ? [
    "CLAUDE_CODE_ENABLE_TELEMETRY=1", "OTEL_LOGS_EXPORTER=otlp", "OTEL_METRICS_EXPORTER=none", "OTEL_EXPORTER_OTLP_PROTOCOL=http/json",
    `OTEL_EXPORTER_OTLP_ENDPOINT=${origin}`, "OTEL_LOG_TOOL_DETAILS=1", "OTEL_LOGS_EXPORT_INTERVAL=5000", "CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS=60000",
  ].join("\n") : "";
  const liveView = `<div id="lv" data-repo="${esc(s.repo)}"><p class="hint lv-wait">Loading…</p></div>
    <details class="group lv-setup"${repoRow ? "" : " hidden"}><summary>Connect a routine or an agent</summary><div class="lv-how">
      <p><b>Claude Code routines.</b> On claude.ai, open the environment your routines run in, and add these to its environment variables. Every session in it then reports here while it runs. Nothing from prompts or outputs is sent.</p>
      <pre>${esc(otelEnv)}</pre>
      <p><b>The key</b> stays out of the environment: the repo hands it over. In <code>.claude/settings.json</code>, <code>"otelHeadersHelper": ".claude/hooks/level5.sh otel-headers"</code>, which reads it from <code>LEVEL5_KEY</code> or <code>.claude/level5.json</code>, wherever your vault puts it. Without that, add <code>OTEL_EXPORTER_OTLP_HEADERS=x-level5-key=&lt;this repo's key&gt;</code> to the list instead.</p>
      <p><b>Managed Agents and the Messages API.</b> In the Claude Console, OpenTelemetry settings, add a destination: Custom, endpoint <code>${esc(origin)}</code>, header <code>x-level5-key</code> with this repo's key, content mode Metadata only. Each agent session shows here as a run.</p>
    </div></details>${LIVE_RUNS}`;

  // Marketing: per campaign, the last 30 days against the 30 before
  let marketingView = "";
  if (s.marketing) {
    const K = s.marketing, money = (v) => "US$ " + (v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cpl = (x) => (x.leads ? money(x.spend / x.leads) : "–"), ctr = (x) => (x.impressions ? ((x.clicks / x.impressions) * 100).toFixed(2) + "%" : "–");
    const delta = (a, b, invert) => { if (!b) return ""; const p = Math.round(((a - b) / b) * 100); return p ? ` <small class="dl" data-s="${(p > 0) !== !!invert ? "ok" : "bad"}">${p > 0 ? "+" : ""}${p}%</small>` : ""; };
    const COLORS = ["#5b4dff", "#4cb782", "#f2994a", "#eb5757", "#2d9cdb", "#bb6bd9", "#9b9b9b"];
    marketingView = head([
      tile(money(K.total.spend) + delta(K.total.spend, K.before.spend, true), "Spend", `${WINDOW} days`),
      tile(num(K.total.leads) + delta(K.total.leads, K.before.leads), "Leads", `${cpl(K.total)} per lead`),
      tile(kn(K.total.impressions) + delta(K.total.impressions, K.before.impressions), "Impressions", `${kn(K.total.clicks)} clicks · ${ctr(K.total)} CTR`),
      tile(num(K.campaigns.length), "Campaigns", "with spend in the window"),
    ], dayChart(K.dates, K.daily.map((c, i) => ({ name: c.name, color: COLORS[i % COLORS.length], v: c.spend })), (v) => money(v), { extra: (i) => `${K.daily.reduce((a, c) => a + c.leads[i], 0)} leads` }))
      + `<h2>Campaigns</h2><div class="group"><table class="tbl mk"><thead><tr><th>Campaign</th><th>Spend</th><th>Leads</th><th>Per lead</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead><tbody>${K.campaigns.map((c) => `<tr><td><b>${esc(c.name)}</b><small>last data ${esc(c.last)}</small></td><td>${money(c.spend)}${delta(c.spend, c.before.spend, true)}</td><td>${num(c.leads)}${delta(c.leads, c.before.leads)}</td><td>${cpl(c)}</td><td>${num(c.impressions)}</td><td>${num(c.clicks)}</td><td>${ctr(c)}</td></tr>`).join("")}</tbody></table></div>`
      + K.accounts.map((a) => `<p class="mk-acct">${esc(a.name || a.source)}: ${esc(a.status)} · spent ${money(a.spent)}${a.cap != null ? ` of ${money(a.cap)}` : ""} · balance ${money(a.balance)} <span class="faint">· ${ago(a.at)}</span></p>`).join("");
  }

  // Pull requests: lines added and removed per day, side by side
  let prHead = "";
  if (M?.prs?.per_day?.length && M.prs.added != null) {
    const pd = M.prs.per_day;
    prHead = head([
      tile(num(M.prs.merged ?? 0), `PRs merged in ${WINDOW} days`, `${M.prs.agent_share == null ? "" : `${M.prs.agent_share}% by agents · `}${M.prs.opened ?? 0} opened`),
      tile(`<span class="loc"><span class="add">+${kn(M.prs.added)}</span> <span class="del">−${kn(M.prs.deleted)}</span></span>`, "Lines changed", `${kn(Math.round((M.prs.added + M.prs.deleted) / WINDOW))} a day`),
      tile(M.prs.median_lines == null ? "–" : num(M.prs.median_lines), "Median PR, lines", ""),
      tile(dur(M.prs.median_merge_h), "Median time to merge", `${M.prs.closed_unmerged ?? 0} closed without merge`),
    ], dayChart(pd.map((d) => d.d), [{ name: "Added", color: "#4cb782", v: pd.map((d) => d.added || 0) }, { name: "Removed", color: "#eb5757", v: pd.map((d) => d.deleted || 0) }], (n) => num(n) + " lines", { grouped: true, extra: (i) => `${pd[i].all} merged` }));
  }

  // Issues: opened and closed per day, side by side
  let issueHead = "";
  if (M?.issues?.per_day?.length) {
    const pd = M.issues.per_day, o = pd.reduce((a, d) => a + d.opened, 0), c = pd.reduce((a, d) => a + d.closed, 0);
    issueHead = head([
      tile(num(o), `Opened in ${WINDOW} days`, `${(o / WINDOW).toFixed(1)} a day`),
      tile(num(c), "Closed", c >= o ? "closing faster than opening" : "opening faster than closing"),
      tile(num(M.issues.open), "Open now", M.issues.median_age_d == null ? "" : `median age ${Math.round(M.issues.median_age_d)} d`),
      tile(o ? Math.round((c / o) * 100) + "%" : "–", "Closed per opened", ""),
    ], dayChart(pd.map((d) => d.d), [{ name: "Opened", color: "#5e6ad2", v: pd.map((d) => d.opened) }, { name: "Closed", color: "#4cb782", v: pd.map((d) => d.closed) }], (n) => plural(n, "issue"), { grouped: true }));
  }

  const costsEmpty = `<div class="group"><div class="line"><span class="hint">No cost data yet. Claude Code sessions report their tokens through the heartbeat hook; provider spend comes from <code>.claude/hooks/level5.sh cost aws 31.50</code> or <code>POST /api/cost</code>. See <a href="#setup">Setup</a>.</span></div></div>`;

  return page(`${s.repo} · Level 5`, `<div class="app" data-tz="${esc(tz)}">
    <header class="topbar">
      <a class="logo" href="/">${MARK()}<span>Level 5</span></a>
      <nav class="crumbs" aria-label="Breadcrumb">${user ? `<a href="/">Repositories</a><span>/</span>` : ""}<b>${esc(s.repo)}</b></nav>
      <span class="tb-right"><button type="button" class="tb-refresh" data-refresh title="Read everything again now" aria-label="Refresh"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg></button><span class="tb-actsw"><button type="button" class="tb-acts" data-acts-toggle aria-haspopup="true" aria-label="GitHub Actions"><span class="tb-ai"></span><span>Actions</span><span class="tb-n"></span></button><div class="acts-pop"><div class="ci-live" data-pop="1" aria-live="polite"></div></div></span><button type="button" class="tb-ask" data-ask-toggle aria-controls="chat" title="Ask about this repo"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 7h.01M8 7h.01M10.5 7h.01"/></svg><span>Ask</span></button>${user ? `<button type="button" class="tb-bell" id="tb-bell" aria-label="Notifications" aria-haspopup="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5a4 4 0 0 1 8 0c0 3 1.2 4.3 1.5 4.5h-11C2.8 10.8 4 9.5 4 6.5zM6.6 13a1.5 1.5 0 0 0 2.8 0"/></svg><span class="tb-count" hidden></span></button>` : ""}</span>
    </header>
    <aside class="side">
      <div class="repo-box">
        <a class="repo-name" href="${repoUrl}" target="_blank" rel="noopener">${esc(s.repo)}</a>
        <span class="repo-state" data-s="${s.overall}"><i></i>${s.overall === "ok" ? "Operational" : s.overall === "degraded" ? "Degraded" : "Needs attention"}</span>
      </div>
      <nav class="snav" aria-label="Sections">${NAV.map(navLink).join("")}</nav>
      <div class="side-foot">
        ${user ? `<a href="/settings">${ico("automations")}<span>Settings</span></a>` : ""}
        <a href="#setup" data-nav="setup">${ico("setup")}<span>Setup</span>${onboarding ? badge("!", "warn") : ""}</a>
        ${user ? `<a href="/">${ico("overview")}<span>All repos</span></a>` : ""}
        <span class="updated">Updated ${ago(s.generated_at)}</span>
      </div>
    </aside>
    <main class="main">
      ${winTemplates}
      ${view("status", statusView)}
      ${view("live", `${vh("Live", "Every Claude Code routine and agent session while it runs: what it is doing, what it costs, and whether it looks stuck.")}${liveView}`)}
      ${view("monitors", `${vh("Monitors", "Skills that run on a schedule and report a heartbeat. A silent monitor is a dead monitor.")}${monHead}
        ${MON.length ? `<div class="group grid3">${monRows}</div>` : `<div class="group"><div class="line"><span class="hint">No heartbeat yet. <a href="#setup">Install the heartbeat</a>.</span></div></div>`}`)}
      ${view("automations", `${vh("Automations", "The scheduled jobs, week by week: what runs when, what ran, and what it took. Whether each run was any good is in Monitors.")}<div class="vh-act"><button type="button" class="btn-quiet" data-open="new:routine">New routine</button></div>${weekGrid || `<div class="group"><div class="line"><span class="hint">No routines found. Declare them in <code>.claude/factory.json</code>.</span></div></div>`}`)}
      ${view("ci", `${vh("CI", "Minutes spent per day, every workflow over the last 30 days, and what goes to production.")}
        ${ciMinutes}
        ${ci ? `<h2>Workflows</h2><div class="group grid3">${ci}</div>` : ""}
        ${promoSection}`)}
      ${view("prs", `${vh("Pull requests", "Code merged per day, open PRs with their CI, and the latest merged and closed.")}${prHead}${prSection}`)}
      ${view("issues", `${vh("Issues", "Opened and closed per day, and what is open now.")}${issueHead}<h2>Open <span class="faint">${s.queue.issues.length}</span></h2>${resolveSetup}${incidents}`)}
      ${view("costs", `${vh("Costs", "What the factory spends per day and per provider, and the tokens every Claude Code session burns.")}${costs || costsEmpty}`)}
      ${s.marketing ? view("marketing", `${vh("Marketing", "Spend, leads and impressions per campaign over the last 30 days, posted by the repo's ads skill.")}${marketingView}`) : ""}
      ${view("reports", `${vh("Reports", "What each report sent, week by week, and the last one as it went out.")}${reportsView}`)}
      ${view("services", `${vh("Services", "The factory as an industrial park: every service it pays for is a hall, as big as what it cost in the last 30 days.")}${mapSection}`)}
      ${view("setup", `${vh("Setup", setupState.level5_sh && setupState.hook ? "This repo reports to Level 5. Each step shows what is in place." : "How this repo reports to Level 5.")}${repoRow ? `<section class="onboard">${heartbeatSetup(origin, repoRow.ingest_key, onboarding, setupState)}</section>
        <section class="keybox"><h2>Ingest key</h2><p>Heartbeats and costs from this repo are sent with <code>${esc(repoRow.ingest_key.slice(0, 8))}…${esc(repoRow.ingest_key.slice(-4))}</code>. It can only write this repo's heartbeats and costs. If it leaked (committed to git, pasted somewhere), replace it: the old key keeps working for 24 hours so there is time to update wherever it is stored.</p><form method="post" action="/r/${esc(s.repo)}/key"><button type="submit" class="btn-quiet">Replace key</button></form></section>` : ""}
        <footer><span>${plural(s.counts.heartbeats, "heartbeat")} in ${WINDOW} days${s.notes.length ? ` · ${esc(s.notes.join(" · "))}` : ""}</span><span></span></footer>`)}
    </main>
    <aside class="askp" id="chat" data-repo="${esc(s.repo)}" aria-label="Assistant">
      <header class="askp-h"><b>Assistant</b><span class="faint">${esc(s.repo)}</span><button type="button" class="askp-x" data-ask-toggle aria-label="Close the assistant"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></header>
      <div class="chat-log" id="chat-log"></div>
      <div class="chips">${["What needs my attention?", "Which routines are late, and why?", "Why did spend change this week?", "Summarize the last 7 days"].map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
      <form class="ask" id="ask-form"><textarea id="ask-input" rows="2" placeholder="Ask about ${esc(s.repo)}…"></textarea><button type="submit">Ask</button></form>
      <div class="chat-note">Answers come from ${esc(ASK_MODEL)} on OpenRouter, from this page's data. They can be wrong; check the source.</div>
    </aside>
  </div>`, { live: true, stale, app: true });
}

// The repo's GitHub stars for the landing, read once an hour without a token (the repo is
// public). Kept null until a read works, so the landing never shows a made-up number.
const STARS = { n: null, at: 0 };
async function refreshStars() {
  if (Date.now() - STARS.at < 36e5) return;
  STARS.at = Date.now();
  try {
    const r = await fetch("https://api.github.com/repos/humanagent/level5", { headers: { accept: "application/vnd.github+json", "user-agent": "level5" }, signal: AbortSignal.timeout(5000) });
    if (r.ok) STARS.n = (await r.json()).stargazers_count ?? null;
  } catch {}
}

function homePage(user, repos = [], msg = "", snaps = {}, viewer = null) {
  const app = appConfig();
  if (!app) {
    return page("Level 5", `<header class="top">${LOGO}</header>
      <div class="hero"><h1>A status page for your software factory.</h1><p>The GitHub App is not set up yet. Whoever runs this instance does it once, from <code>/setup</code>.</p></div>`);
  }
  const install = `https://github.com/apps/${app.slug}/installations/new`;
  if (!user) return landingPage({ install, msg, esc, css: CSS + THEME, fonts: FONTS, viewer: viewer?.login || null });
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
  return page("Repositories · Level 5", `<div class="app solo">
    <header class="topbar"><a class="logo" href="/">${MARK()}<span>Level 5</span></a><nav class="crumbs"><b>Repositories</b></nav><span class="tb-right"><button type="button" class="tb-bell" id="tb-bell" aria-label="Notifications" aria-haspopup="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5a4 4 0 0 1 8 0c0 3 1.2 4.3 1.5 4.5h-11C2.8 10.8 4 9.5 4 6.5zM6.6 13a1.5 1.5 0 0 0 2.8 0"/></svg><span class="tb-count" hidden></span></button><a class="tb-btn" href="/settings" style="text-decoration:none">Settings</a><form method="post" action="/logout" style="margin:0"><button class="tb-btn">Sign out</button></form></span></header>
    <main class="main">
      <header class="vh"><h1>Repositories</h1><p>Every repo Level 5 is installed on that your GitHub account can see. Numbers are the last ${WINDOW} days.</p></header>
      ${repos.length ? accounts.map((a) => `<h2>${esc(a.login)}</h2><div class="group repos-t">
        <div class="rrow2 head"><span>Repository</span><span class="num">Monitors ok</span><span class="num">PRs merged · agents</span><span class="num">CI passing</span><span class="num">Spend</span><span></span></div>
        ${repos.filter((r) => r.account.login === a.login).map(row).join("")}</div>`).join("") : `<div class="group"><div class="line"><span class="hint">Level 5 is not installed on any of your repos yet.</span></div></div>`}
      <p><a class="btn" href="${install}">${repos.length ? "Add or remove repos" : "Install on your repos"}</a></p>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    </main></div>`, { app: true });
}

function setupPage(origin, t) {
  const manifest = {
    name: `Level 5 ${randomBytes(2).toString("hex")}`,
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
const readRaw = (req, limit = 8e6) =>
  new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) rej(new Error("body too large")); else chunks.push(c); });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
const form = async (req) => Object.fromEntries(new URLSearchParams(await readBody(req)));
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin", ...headers });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { "content-type": "application/json" });
const redirect = (res, to, headers = {}) => send(res, 303, "", { location: to, ...headers });

// An ingest key resolves to its repo. A replaced key keeps working for 24 hours, so the
// routines that carry it can be moved to the new one without losing heartbeats.
const KEY_GRACE_H = 24;
// The time zone a person reads Level 5 in ("" = whatever their browser says). Times are stored and
// computed in UTC; the page converts what it prints.
const TZS = new Set(Intl.supportedValuesOf("timeZone"));
const tzCache = new Map();
async function userTz(login) {
  if (!login) return "";
  if (tzCache.has(login)) return tzCache.get(login);
  const r = await db.one("SELECT v FROM settings WHERE k = $1", `tz:${login}`);
  const tz = r && TZS.has(r.v) ? r.v : "";
  tzCache.set(login, tz);
  return tz;
}

async function repoForKey(key) {
  if (!key) return null;
  const repo = await db.one("SELECT id FROM repos WHERE ingest_key = $1", key);
  if (repo) return repo;
  const old = await db.one("SELECT v FROM settings WHERE k = $1", `prevkey:${createHash("sha256").update(key).digest("hex")}`);
  const o = old && JSON.parse(old.v);
  return o && Date.parse(o.until) > Date.now() ? { id: o.repo_id } : null;
}
async function replaceKey(repoId) {
  const row = await db.one("SELECT ingest_key FROM repos WHERE id = $1", repoId);
  const fresh = "fsk_" + randomBytes(24).toString("base64url");
  await db.run("UPDATE repos SET ingest_key = $1 WHERE id = $2", fresh, repoId);
  if (row?.ingest_key) await setSetting(`prevkey:${createHash("sha256").update(row.ingest_key).digest("hex")}`, JSON.stringify({ repo_id: repoId, until: new Date(Date.now() + KEY_GRACE_H * 36e5).toISOString() }));
  return fresh;
}

async function insertBeat(repoId, b) {
  const status = ["ok", "degraded", "skipped"].includes(b.status) ? b.status : null;
  if (!b.monitor || !status) throw new Error("monitor and status (ok|degraded|skipped) are required");
  const ts = b.ts && !Number.isNaN(Date.parse(b.ts)) ? new Date(b.ts).toISOString() : new Date().toISOString();
  const body = JSON.stringify({ source: b.source === "session" ? "session" : "skill", window: b.window || "", swept: b.swept || {}, suppressed: b.suppressed ?? null, filed: (b.filed || []).map(Number).filter(Boolean), note: String(b.note || "").slice(0, 500), ...(b.report ? { report: String(b.report).slice(0, 60000), title: String(b.title || "").slice(0, 140) } : {}) });
  await db.run("INSERT INTO heartbeats (repo_id, monitor, ts, status, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", repoId, String(b.monitor).slice(0, 80), ts, status, body);
}

// --- landing: waitlist and first-party analytics ------------------------------------------------
// The landing (Level 5) posts its own beacons to /api/track: views, clicks (Start free is
// cta:*-start, Run your own cta:*-selfhost) and how far each section is read, under an anonymous id from localStorage. No cookies, no third
// parties. /api/waitlist and its table stay from when the landing was a waitlist; nothing posts to
// it now, but the list is still readable and exportable. Read at /admin/landing by the logins in ADMIN_LOGINS (and DEV_USER in dev).
const ADMINS = new Set((process.env.ADMIN_LOGINS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
const isAdmin = (u) => !!u && (ADMINS.has(u.login.toLowerCase()) || (DEV && u.login === process.env.DEV_USER));
const clientIp = (req) => req.headers["fly-client-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
// at most n per window per key, in memory (one process); idle keys go once the map grows
const hits = new Map();
function allowed(key, n, ms) {
  const now = Date.now(), recent = (hits.get(key) || []).filter((t) => now - t < ms);
  if (recent.length >= n) return false;
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 2e4) for (const [k, v] of hits) if (now - v.at(-1) > 36e5) hits.delete(k);
  return true;
}
const UTM = ["source", "medium", "campaign", "term", "content"];
const utmOf = (o) => UTM.map((k) => (o && o[k] ? String(o[k]).slice(0, 100) : null));
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|curl|wget|python|node-fetch|go-http|axios|okhttp|httpclient|monitor/i;
const TRACK_TYPES = new Set(["view", "click", "scroll", "waitlist_submit", "waitlist_join", "waitlist_error"]);
// the landing's sections, top to bottom, for scroll depth
const LANDING_SECTIONS = ["hero", "tools", "status", "costs", "factory", "sources", "install"];

async function waitlistJoin(req, res, origin) {
  const isForm = !/json/.test(req.headers["content-type"] || "");
  // without JS: back to the landing it came from, with the answer in the URL
  const back = (state, source) => {
    let path = "/";
    try { const r = new URL(req.headers.referer); if (r.origin === origin && r.pathname === "/landing") path = "/landing"; } catch {}
    return redirect(res, `${path}?joined=${state}#${source === "install" ? "install" : "join"}`);
  };
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return isForm ? redirect(res, "/") : json(res, 403, { error: "From the Level 5 page only." });
  let b;
  try {
    const raw = await readBody(req, 8e3);
    b = isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || "{}");
  } catch {
    return isForm ? back("invalid") : json(res, 400, { error: "That did not go through. Try again." });
  }
  const source = ["hero", "install"].includes(b.source) ? b.source : "other";
  if (!allowed(`wl:${clientIp(req)}`, 10, 36e5)) return isForm ? back("busy", source) : json(res, 429, { error: "Too many tries from here. Try again later." });
  if (b.website) return isForm ? back(1, source) : json(res, 200, { ok: true }); // the hidden field: only a bot fills it
  const email = String(b.email || "").trim();
  if (email.length > 254 || !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(email)) return isForm ? back("invalid", source) : json(res, 400, { error: "That email doesn't look right." });
  // the script sends the visit's referrer and utm; without JS the utm ride on the landing's URL (this post's Referer)
  let utm = b.utm && typeof b.utm === "object" ? b.utm : {};
  if (isForm) try { const r = new URL(req.headers.referer); utm = Object.fromEntries(UTM.map((k) => [k, r.searchParams.get("utm_" + k)])); } catch {}
  const already = await db.one("SELECT id FROM waitlist WHERE lower(email) = $1", email.toLowerCase());
  if (!already) await db.run("INSERT INTO waitlist (email, created_at, source, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ua) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING", email, new Date().toISOString(), source, String(b.ref || "").slice(0, 500), ...utmOf(utm), String(req.headers["user-agent"] || "").slice(0, 300));
  return isForm ? back(already ? "already" : 1, source) : json(res, 200, { ok: true, already: !!already });
}

// A beacon never waits on the answer and never sees an error: always 204, bad input is dropped.
async function landingTrack(req, res) {
  try {
    const ua = String(req.headers["user-agent"] || "");
    const raw = await readBody(req, 4e3);
    if (!ua || BOT.test(ua) || !allowed(`tr:${clientIp(req)}`, 600, 36e5)) return;
    const b = JSON.parse(raw), s = (v, n) => String(v ?? "").slice(0, n);
    if (!TRACK_TYPES.has(b.type) || !/^[\w-]{1,64}$/.test(b.aid || "")) return;
    const vw = Number.isFinite(Number(b.vw)) ? Math.max(0, Math.min(1e4, Math.round(Number(b.vw)))) : null;
    const country = s(req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"], 8) || null;
    await db.run("INSERT INTO landing_events (ts, anon_id, type, label, href, section, path, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content, vw, ua, country) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
      new Date().toISOString(), b.aid, b.type, s(b.label, 80), s(b.href, 300), s(b.section, 40), s(b.path, 100), s(b.ref, 500), ...utmOf(b.utm), vw, ua.slice(0, 300), country);
  } catch {} finally {
    if (!res.headersSent) { res.writeHead(204, { "cache-control": "no-store" }); res.end(); }
  }
}

const csvCell = (v) => {
  let x = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; // a spreadsheet must not read it as a formula
  return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};
async function waitlistCsv() {
  const cols = ["created_at", "email", "source", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ua"];
  const rows = await db.all(`SELECT ${cols.join(", ")} FROM waitlist ORDER BY created_at DESC`);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

async function landingAdmin(user, origin) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const ev = (q) => db.all(q, since);
  const [days, labels, [f], refs, utms, depth, wlTotal, [wl30], list] = await Promise.all([
    ev("SELECT substr(ts, 1, 10) AS day, COUNT(*)::int AS views, COUNT(DISTINCT anon_id)::int AS u FROM landing_events WHERE type = 'view' AND ts >= $1 GROUP BY substr(ts, 1, 10) ORDER BY day"),
    ev("SELECT label, section, COUNT(*)::int AS n, COUNT(DISTINCT anon_id)::int AS u FROM landing_events WHERE type = 'click' AND ts >= $1 GROUP BY label, section ORDER BY n DESC LIMIT 25"),
    ev(`SELECT COUNT(DISTINCT CASE WHEN type = 'view' THEN anon_id END)::int AS v, COUNT(DISTINCT CASE WHEN type = 'click' AND label LIKE 'cta:%-start' THEN anon_id END)::int AS c,
      COUNT(DISTINCT CASE WHEN type = 'click' AND label LIKE 'cta:%-selfhost' THEN anon_id END)::int AS sh, COUNT(DISTINCT CASE WHEN type = 'click' AND label = 'nav:github' THEN anon_id END)::int AS gh, COUNT(*)::int AS n FROM landing_events WHERE ts >= $1`),
    ev("SELECT referrer, COUNT(DISTINCT anon_id)::int AS u FROM landing_events WHERE type = 'view' AND ts >= $1 GROUP BY referrer ORDER BY u DESC LIMIT 2000"),
    ev("SELECT utm_source AS s, COALESCE(utm_medium, '') AS m, COALESCE(utm_campaign, '') AS c, COUNT(DISTINCT anon_id)::int AS u FROM landing_events WHERE type = 'view' AND ts >= $1 AND utm_source IS NOT NULL GROUP BY utm_source, utm_medium, utm_campaign ORDER BY u DESC LIMIT 20"),
    ev("SELECT label, COUNT(DISTINCT anon_id)::int AS u FROM landing_events WHERE type = 'scroll' AND ts >= $1 GROUP BY label"),
    db.one("SELECT COUNT(*)::int AS n FROM waitlist"),
    ev("SELECT COUNT(*)::int AS n FROM waitlist WHERE created_at >= $1"),
    db.all("SELECT * FROM waitlist ORDER BY created_at DESC LIMIT 500"),
  ]);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "–");
  const meter = (a, b) => `<span style="display:block;height:6px;border-radius:3px;background:var(--line);margin-top:6px"><i style="display:block;height:100%;width:${b ? Math.min(100, (a / b) * 100) : 0}%;border-radius:3px;background:#5b4dff"></i></span>`;
  const empty = (n, t) => `<tr><td colspan="${n}" class="hint">${t}</td></tr>`;
  // views per day: 30 columns, today on the right, unique visitors in the darker part
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
  const span = [...Array(30)].map((_, i) => new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10));
  const max = Math.max(1, ...days.map((d) => d.views));
  const chart = `<div style="display:flex;align-items:flex-end;gap:3px;height:120px;padding:16px 16px 6px">${span.map((d) => { const x = byDay[d] || { views: 0, u: 0 }; return `<span title="${d}: ${x.views} views, ${x.u} visitors" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%"><i style="display:block;height:${((x.views - x.u) / max) * 100}%;background:#c9c4ff;border-radius:2px 2px 0 0"></i><i style="display:block;height:${(x.u / max) * 100}%;background:#5b4dff;border-radius:${x.views > x.u ? 0 : "2px 2px"} 0 0"></i></span>`; }).join("")}</div><div class="axis" style="display:flex;justify-content:space-between;padding:0 16px 12px;font-size:11.5px;color:var(--faint)"><span>${span[0]}</span><span>views (light) and unique visitors (dark) per day</span><span>today</span></div>`;
  const views = days.reduce((a, d) => a + d.views, 0);
  // referrers by site; the landing's own address and none at all are "direct"
  const hosts = new Map();
  const self = new URL(origin).hostname;
  for (const r of refs) {
    let h = "Direct";
    try { const x = new URL(r.referrer).hostname; if (x !== self) h = x.replace(/^www\./, ""); } catch {}
    hosts.set(h, (hosts.get(h) || 0) + r.u);
  }
  const topRefs = [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const depthBy = Object.fromEntries(depth.map((d) => [d.label, d.u]));
  const steps = [["Viewed the landing", f.v], ["Clicked Start free", f.c]];
  const ago = (t) => { const m = Math.round((Date.now() - Date.parse(t)) / 6e4); return m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
  return page("Landing · Level 5", `<div class="app solo"><header class="topbar"><a class="logo" href="/">${MARK()}<span>Level 5</span></a><nav class="crumbs"><a href="/">Repositories</a><span>/</span><b>Landing</b></nav></header>
    <main class="main"><header class="vh"><h1>Landing</h1><p>The last 30 days of the public landing, from its own beacons (no cookies, anonymous ids). Start free installs the GitHub App; Run your own goes to the repo. For ${esc(user.login)}.</p></header>
    <div class="group"><div class="stats">
      <div class="stat"><b>${views}</b><span>Views</span></div>
      <div class="stat"><b>${f.v}</b><span>Unique visitors</span></div>
      <div class="stat"><b>${f.c}</b><span>Clicked Start free <span class="faint">${pct(f.c, f.v)}</span></span></div>
      <div class="stat"><b>${f.sh}</b><span>Clicked Run your own <span class="faint">${pct(f.sh, f.v)} · ${f.gh} more on the nav's GitHub</span></span></div>
    </div></div>
    <h2>Views per day</h2><div class="group">${chart}</div>
    <h2>Funnel <span class="faint">unique visitors</span></h2>
    <div class="group"><table class="tbl"><thead><tr><th>Step</th><th>Visitors</th><th>Of the step before</th><th>Of all visitors</th></tr></thead><tbody>${steps.map(([t, n], i) => `<tr><td>${t}${meter(n, f.v)}</td><td>${n}</td><td>${i ? pct(n, steps[i - 1][1]) : ""}</td><td>${pct(n, f.v)}</td></tr>`).join("")}<tr><td>Clicked Run your own <span class="faint">self-host, alongside Start free</span>${meter(f.sh, f.v)}</td><td>${f.sh}</td><td></td><td>${pct(f.sh, f.v)}</td></tr></tbody></table></div>
    <h2>Top clicks</h2>
    <div class="group"><table class="tbl"><thead><tr><th>Label</th><th>Section</th><th>Clicks</th><th>Visitors</th></tr></thead><tbody>${labels.map((l) => `<tr><td><b>${esc(l.label) || '<span class="faint">(no label)</span>'}</b></td><td>${esc(l.section)}</td><td>${l.n}</td><td>${l.u}</td></tr>`).join("") || empty(4, "No clicks yet.")}</tbody></table></div>
    <div class="grid2" style="gap:24px;background:none;border:0;overflow:visible">
      <div><h2>Referrers</h2><div class="group"><table class="tbl"><thead><tr><th>Site</th><th>Visitors</th></tr></thead><tbody>${topRefs.map(([h, u]) => `<tr><td>${esc(h)}</td><td>${u}</td></tr>`).join("") || empty(2, "No views yet.")}</tbody></table></div></div>
      <div><h2>Campaigns</h2><div class="group"><table class="tbl"><thead><tr><th>utm_source</th><th>Medium</th><th>Campaign</th><th>Visitors</th></tr></thead><tbody>${utms.map((x) => `<tr><td>${esc(x.s)}</td><td>${esc(x.m)}</td><td>${esc(x.c)}</td><td>${x.u}</td></tr>`).join("") || empty(4, "No utm-tagged visits yet.")}</tbody></table></div></div>
    </div>
    <h2>Scroll depth <span class="faint">visitors who reached each section</span></h2>
    <div class="group"><table class="tbl"><thead><tr><th>Section</th><th>Visitors</th><th>Of all visitors</th></tr></thead><tbody>${LANDING_SECTIONS.map((sct) => `<tr><td>#${sct}${meter(depthBy[sct] || 0, f.v)}</td><td>${depthBy[sct] || 0}</td><td>${pct(depthBy[sct] || 0, f.v)}</td></tr>`).join("")}</tbody></table></div>
    <h2>Waitlist <span class="faint">${wlTotal.n} · closed, from before Start free (${wl30.n} in 30 days)</span> <a href="/admin/landing/waitlist.csv" style="font-size:13px;font-weight:500;margin-left:8px">Export CSV</a></h2>
    <div class="group"><table class="tbl"><thead><tr><th>Email</th><th>Joined</th><th>Form</th><th>Referrer</th><th>utm</th></tr></thead><tbody>${list.map((w) => `<tr><td><b>${esc(w.email)}</b></td><td title="${esc(w.created_at)}">${ago(w.created_at)}</td><td>${esc(w.source)}</td><td>${esc(w.referrer) || '<span class="faint">–</span>'}</td><td>${esc([w.utm_source, w.utm_medium, w.utm_campaign].filter(Boolean).join(" / ")) || '<span class="faint">–</span>'}</td></tr>`).join("") || empty(5, "Nobody yet.")}</tbody></table>${wlTotal.n > list.length ? `<p class="hint" style="padding:0 14px">The latest ${list.length}; the CSV has all ${wlTotal.n}.</p>` : ""}</div>
    </main></div>`);
}

// --- assistant ---------------------------------------------------------------------------
// One question = one OpenRouter call with everything Level 5 knows about the repo in the system
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
  return `You are the assistant inside Level 5, a status page for a software factory: a repo where AI agents (Claude Code routines) and GitHub Actions do scheduled work, and monitors report heartbeats.
You are answering ${user.login} about the repo ${row.full_name}. Now: ${new Date().toISOString()} (UTC).

Rules:
- Answer only from the data below. If it does not say, say so, and say what would tell you.
- Be specific: name monitors, routines, workflows, PR and issue numbers, dates and amounts.
- Lead with the answer. Short paragraphs or a short list. No preamble.
- Monitor states: alive = operational, warn = degraded (last run not ok), degraded = chronically degraded, lying = said ok but read nothing, dead = silent past its window, retired = gone from the roster.
- Bars are oldest to newest, one char per day (or week for weekly monitors): ok, degraded, skipped, "-" = no run.
- Costs: provider rows are real daily spend; Claude Code dollars are estimates at API list prices.
- Price rules (cost alarms) are made here, by you, with your tools. When ${user.login} asks to be told, alerted, warned or notified about spend or tokens, create the rule; when they ask what alarms exist, list them; to stop one, delete it. After a change, confirm in one sentence that repeats the rule as it was saved. Never invent a rule you did not create with a tool.

## Snapshot of ${row.full_name}
${JSON.stringify(lean)}

## Heartbeats, last ${WINDOW} days (newest first)
${beats.map((b) => { const x = JSON.parse(b.body); return `${b.ts} ${b.monitor} ${b.status}${x.source === "session" ? " (session)" : ""}${Object.keys(x.swept || {}).length ? " swept=" + JSON.stringify(x.swept) : ""}${x.filed?.length ? " filed=" + x.filed.join(",") : ""}${x.note ? " note: " + x.note : ""}`; }).join("\n") || "none"}

## Cost rows, last ${WINDOW} days
${costs.map((c) => { const x = JSON.parse(c.body); return `${c.day} ${c.source} ${c.usd == null ? "" : "$" + c.usd}${x.name ? " " + x.name : ""}${x.models && Object.keys(x.models).length ? " tokens=" + JSON.stringify(x.models) : ""}${x.breakdown ? " " + JSON.stringify(x.breakdown) : ""}`; }).join("\n") || "none"}

## Other repos ${user.login} can see
${brief.join("\n") || "none"}`;
}
// The assistant can make, list and delete price rules: alarms are asked for in words, not in a form.
const RULE_TOOLS = [
  { type: "function", function: { name: "create_price_rule", description: "Create a cost alarm for this repo. It notifies when the measure crosses the limit, at most once per period.", parameters: { type: "object", required: ["name", "config"], properties: {
    name: { type: "string", description: "Short title, e.g. 'AWS over $50 a day'" },
    config: { type: "object", description: "source: 'any' or a provider (aws, vercel, neon, claude-code...); measure: usd | tokens (Claude Code tokens) | session_tokens (one session); period: day | week (rolling 7 days) | month (month to date) | forecast (month-end projection); cond: above (over amount) | spike (pct % over the average of the previous `days` days); amount: number; pct: number; days: number; service: substring of a service name or ''; dow: weekdays it applies to, Sunday=0, [] = every day, weekdays = [1,2,3,4,5]; from/to: YYYY-MM-DD or ''; severity: warn | bad" } } } } },
  { type: "function", function: { name: "list_price_rules", description: "List this repo's cost alarms with their current value against the limit.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "delete_price_rule", description: "Delete one of this repo's cost alarms by id.", parameters: { type: "object", required: ["id"], properties: { id: { type: "number" } } } } },
];
async function runRuleTool(row, user, name, args) {
  if (name === "list_price_rules") return (await evalRules(row.id)).map((r) => ({ id: r.id, rule: ruleSummary(r.config), name: r.name, enabled: r.enabled, value: r.value, limit: r.limit, over: r.over, last_fired_at: r.last_fired_at }));
  if (name === "delete_price_rule") { await db.run("DELETE FROM price_rules WHERE id = $1 AND repo_id = $2", Number(args.id), row.id); refresh(row).catch(() => {}); return { deleted: Number(args.id) }; }
  if (name === "create_price_rule") {
    const config = ruleConfig(args.config || {}), nm = String(args.name || ruleSummary(config)).trim().slice(0, 80);
    await db.run("INSERT INTO price_rules (repo_id, name, config, enabled, created_by, created_at) VALUES ($1, $2, $3, 1, $4, $5)", row.id, nm, JSON.stringify(config), user.login, new Date().toISOString());
    refresh(row).catch(() => {});
    return { created: nm, rule: ruleSummary(config) };
  }
  return { error: `unknown tool ${name}` };
}
// One answer: up to three rounds of tool calls, then the text. Plain text back, like askStream.
async function askWithTools(res, system, messages, origin, row, user) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return send(res, 503, "The assistant is not configured on this Level 5 (OPENROUTER_API_KEY is missing).", { "content-type": "text/plain; charset=utf-8" });
  const convo = [{ role: "system", content: system }, ...messages];
  for (let round = 0; round < 4; round++) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "http-referer": origin, "x-title": "Level 5" }, body: JSON.stringify({ model: ASK_MODEL, messages: convo, tools: RULE_TOOLS }) });
    if (!r.ok) return send(res, 502, `The model did not answer (${r.status}). ${(await r.text().catch(() => "")).slice(0, 300)}`, { "content-type": "text/plain; charset=utf-8" });
    const msg = (await r.json()).choices?.[0]?.message || {};
    if (!msg.tool_calls?.length || round === 3) return send(res, 200, msg.content || "", { "content-type": "text/plain; charset=utf-8" });
    convo.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
    for (const c of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch {}
      const out = await runRuleTool(row, user, c.function?.name, args).catch((e) => ({ error: e.message }));
      convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
}
async function askStream(res, system, messages, origin) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return send(res, 503, "The assistant is not configured on this Level 5 (OPENROUTER_API_KEY is missing).", { "content-type": "text/plain; charset=utf-8" });
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "http-referer": origin, "x-title": "Level 5" },
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

async function connectRepo(req, res, origin) {
  const app = appConfig();
  if (!app || app.dev) return json(res, 503, { error: "this instance has no GitHub App yet" });
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const { repo } = JSON.parse((await readBody(req, 4e3)) || "{}");
  if (!token) return json(res, 401, { error: "send your GitHub token: authorization: Bearer $(gh auth token)" });
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) return json(res, 400, { error: "repo must be owner/name" });
  const me = await gh(token, "user").catch(() => null);
  if (!me?.login) return json(res, 401, { error: "GitHub did not accept that token" });
  const meta = await gh(token, `repos/${repo}`).catch(() => null);
  if (!meta) return json(res, 404, { error: `${repo} is not visible to ${me.login}` });
  if (!meta.permissions?.push) return json(res, 403, { error: `${me.login} cannot push to ${meta.full_name}` });
  const r = await fetch(`https://api.github.com/repos/${meta.full_name}/installation`, { headers: { authorization: `Bearer ${appJwt(app)}`, accept: "application/vnd.github+json", "user-agent": "factory-status" } }).catch(() => null);
  if (!r?.ok) return json(res, 404, { error: `the Level 5 app is not installed on ${meta.full_name}`, install: `https://github.com/apps/${app.slug}/installations/new` });
  const inst = await r.json();
  const row = await ensureRepo({ id: meta.id, full_name: meta.full_name, installation_id: inst.id, account: { id: inst.account.id, login: inst.account.login, type: inst.account.type } }, { login: me.login });
  return json(res, 200, { repo: row.full_name, key: row.ingest_key, url: origin, page: `${origin}/r/${row.full_name}` });
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

// When the server moves to Postgres, bring over what the local SQLite (level5.db) collected in the
// meantime. Same schema; newer cost rows win, everything else is insert-if-missing.
async function migrateLocal() {
  const file = liteFile(DATA);
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
if (!DEV) {
  await migrateLegacy().catch((e) => console.error("migrate failed:", e));
  await migrateLocal().catch((e) => console.error("migrate local failed:", e));
}
if (DEV) console.log(`dev mode: signed in as ${process.env.DEV_USER}, GitHub read with your gh session, storage ${db.kind}`);
await loadApp();

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const origin = `${req.headers["x-forwarded-proto"] || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https")}://${host}`;
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok", { "content-type": "text/plain" });
    if (url.pathname === "/install.sh") return send(res, 200, INSTALL.replaceAll("__ORIGIN__", origin), { "content-type": "text/x-shellscript; charset=utf-8" });

    if (url.pathname === "/api/inventory" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = await repoForKey(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const list = [].concat(JSON.parse((await readBody(req, 4e6)) || "[]"));
      for (const it of list.slice(0, 5)) await db.run("INSERT INTO inventories (repo_id, kind, at, body) VALUES ($1, $2, $3, $4) ON CONFLICT (repo_id, kind) DO UPDATE SET at = excluded.at, body = excluded.body", repo.id, String(it.kind), new Date().toISOString(), JSON.stringify(cleanInventory(String(it.kind), it.data || {})));
      const row = await db.one("SELECT * FROM repos WHERE id = $1", repo.id);
      refresh(row).catch(() => {});
      return json(res, 200, { ok: true, stored: list.length });
    }
    if (url.pathname === "/api/cost" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = await repoForKey(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(body) ? body : [body];
      if (list.length > 500) return json(res, 413, { error: "at most 500 per request" });
      for (const c of list) await insertCost(repo.id, c);
      await evalRules(repo.id, { fire: true }).catch((e) => console.error("rules:", e.message));
      return json(res, 200, { ok: true, stored: list.length });
    }
    // /level5:setup with no key: the person's own GitHub token (gh auth token) proves they can push to
    // the repo, the app's own token proves the app is installed on it, and the answer is that repo's
    // ingest key. The GitHub token is only used for these two reads and never stored.
    if (url.pathname === "/api/connect" && req.method === "POST") return connectRepo(req, res, origin);
    // The day's report as data, for the repo's own report skill. The ingest key is the only key a
    // routine holds, so it may read this one summary of its own repo (and nothing else).
    if (url.pathname === "/api/report" && req.method === "GET") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = await repoForKey(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const row = await db.one("SELECT * FROM repos WHERE id = $1", repo.id);
      const saved = await db.one("SELECT body FROM snapshots WHERE repo_id = $1", row.id);
      let snap = saved && JSON.parse(saved.body);
      if (!snap || snap.v !== SNAP_V || Date.now() - Date.parse(snap.generated_at) > 15 * 60e3) snap = await refresh(row);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("day") || "") ? url.searchParams.get("day") : undefined;
      return json(res, 200, reportData(snap, { origin, day }));
    }
    // OpenTelemetry in (OTLP/HTTP, JSON or protobuf, gzip or not): Claude Code's logs and the Claude
    // Platform's traces become live runs. The ingest key comes as a bearer token or as x-level5-key.
    // Metrics are accepted and dropped: the logs already carry tokens and cost per request.
    const otlp = url.pathname.match(/^\/v1\/(logs|traces|metrics)$/);
    if (otlp && req.method === "POST") {
      const key = String(req.headers["x-level5-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
      const repo = await repoForKey(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const raw = await readRaw(req);
      const isJson = /json/.test(String(req.headers["content-type"] || ""));
      if (otlp[1] !== "metrics") {
        let records;
        try { records = decode(otlp[1], raw, req.headers); } catch (e) { return json(res, 400, { error: `could not read OTLP ${otlp[1]}: ${e.message}` }); }
        const raised = await ingestRuns(db, repo.id, records);
        for (const { run, flag } of raised) await db.run("INSERT INTO events (repo_id, at, level, kind, title, detail, entity, dedupe) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (repo_id, dedupe) DO NOTHING", repo.id, new Date().toISOString(), "bad", "run", `${run.name} looks stuck`.slice(0, 200), flag.detail.slice(0, 400), `run:${run.run_id}`, `run-${flag.kind}:${run.run_id}`);
        if (Math.random() < 0.01) db.run("DELETE FROM live_runs WHERE last_at < $1", Date.now() - WINDOW * 864e5).catch(() => {});
      }
      return send(res, 200, isJson ? "{}" : "", { "content-type": isJson ? "application/json" : "application/x-protobuf" });
    }
    // Marketing: one row per campaign per day ({ source, account?, rows: [{ day, campaign, spend,
    // impressions, clicks, leads }] }). Posting a day again replaces it, so a skill can resend the
    // last few days, which ad platforms keep revising.
    if (url.pathname === "/api/marketing" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = await repoForKey(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const b = JSON.parse((await readBody(req)) || "{}");
      const source = str(b.source || "ads", 40), rows = Array.isArray(b.rows) ? b.rows : [];
      if (rows.length > 5000) return json(res, 413, { error: "at most 5000 rows per request" });
      const at = new Date().toISOString(), n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      for (const r of rows) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day || "") || !r.campaign) continue;
        await db.run("INSERT INTO marketing (repo_id, source, day, campaign, spend, impressions, clicks, leads, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (repo_id, source, day, campaign) DO UPDATE SET spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks, leads = excluded.leads, at = excluded.at", repo.id, source, r.day, str(r.campaign, 200), n(r.spend), Math.round(n(r.impressions)), Math.round(n(r.clicks)), Math.round(n(r.leads)), at);
      }
      if (b.account) await setSetting(`mkt:${repo.id}:${source}`, JSON.stringify({ name: str(b.account.name, 120), status: str(b.account.status, 60), currency: str(b.account.currency, 8), spent: n(b.account.amount_spent), cap: b.account.spend_cap == null ? null : n(b.account.spend_cap), balance: n(b.account.balance), at }));
      return json(res, 200, { ok: true, stored: rows.length });
    }
    // A report's body (the email as sent), latest only per skill, read on the Reports view.
    if (url.pathname === "/api/report-body" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = await repoForKey(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const b = JSON.parse((await readBody(req, 3e6)) || "{}");
      if (!b.monitor || !b.html) return json(res, 400, { error: "monitor and html are required" });
      await db.run("INSERT INTO report_bodies (repo_id, monitor, at, title, html) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (repo_id, monitor) DO UPDATE SET at = excluded.at, title = excluded.title, html = excluded.html", repo.id, String(b.monitor).slice(0, 80), new Date().toISOString(), String(b.title || "").slice(0, 200), String(b.html));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/heartbeat" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = await repoForKey(key);
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(body) ? body : [body];
      if (list.length > 500) return json(res, 413, { error: "at most 500 per request" });
      for (const b of list) await insertBeat(repo.id, b);
      return json(res, 200, { ok: true, stored: list.length });
    }

    if (url.pathname === "/api/waitlist" && req.method === "POST") return waitlistJoin(req, res, origin);
    if (url.pathname === "/api/track" && req.method === "POST") return landingTrack(req, res);

    const user = await sessionUser(req);

    // the public landing, also for someone signed in who wants to see it
    if ((url.pathname === "/landing" || (url.pathname === "/" && !user)) && req.method === "GET") await refreshStars();
    // ?out=1 in dev shows the signed-out landing
    if (url.pathname === "/landing" && req.method === "GET") return send(res, 200, homePage(null, [], "", {}, DEV && url.searchParams.has("out") ? null : user));
    if (url.pathname === "/" && req.method === "GET") {
      if (!user) return send(res, 200, homePage(null, [], "", {}, null));
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

    if (url.pathname === "/api/notifications" && user) {
      const repos = await userRepos(user).catch(() => []);
      const ids = repos.map((r) => r.id);
      const seenKey = `notif_seen:${user.login}`;
      const readKey = `notif_read:${user.login}`;
      if (req.method === "POST") {
        const b = JSON.parse((await readBody(req, 2e4)) || "{}");
        if (Array.isArray(b.ids) && b.ids.length) {
          const prev = JSON.parse((await db.one("SELECT v FROM settings WHERE k = $1", readKey))?.v || "[]");
          await setSetting(readKey, JSON.stringify([...new Set([...b.ids.map(Number).filter(Boolean), ...prev])].slice(0, 500)));
        } else {
          await setSetting(seenKey, new Date().toISOString());
          await setSetting(readKey, "[]");
        }
        return json(res, 200, { ok: true });
      }
      if (!ids.length) return json(res, 200, { unread: 0, items: [] });
      const ph = ids.map((_, i) => "$" + (i + 1)).join(",");
      const items = await db.all(`SELECT e.id, e.repo_id, e.at, e.level, e.kind, e.title, e.detail, e.entity FROM events e WHERE e.repo_id IN (${ph}) ORDER BY e.at DESC, e.id DESC LIMIT 60`, ...ids);
      const seen = (await db.one("SELECT v FROM settings WHERE k = $1", seenKey))?.v || "";
      const read = new Set(JSON.parse((await db.one("SELECT v FROM settings WHERE k = $1", `notif_read:${user.login}`))?.v || "[]"));
      const names = Object.fromEntries(repos.map((r) => [r.id, r.full_name]));
      const out = items.map((e) => ({ ...e, id: Number(e.id), repo: names[Number(e.repo_id)], unread: e.at > seen && !read.has(Number(e.id)) }));
      return json(res, 200, { unread: out.filter((e) => e.unread).length, items: out });
    }
    if (url.pathname === "/settings") {
      if (!user) return redirect(res, "/auth/login");
      if (req.method === "POST") {
        if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return send(res, 405, "POST from this page only");
        const tz = new URLSearchParams((await readBody(req, 4e3)) || "").get("tz") || "";
        if (tz && !TZS.has(tz)) return send(res, 400, "Unknown time zone");
        if (tz) await setSetting(`tz:${user.login}`, tz); else await db.run("DELETE FROM settings WHERE k = $1", `tz:${user.login}`);
        tzCache.delete(user.login);
        return redirect(res, "/settings?saved=1");
      }
      const tz = await userTz(user.login);
      const opts = [...TZS].sort().map((z) => `<option value="${esc(z)}"${z === tz ? " selected" : ""}>${esc(z.replace(/_/g, " "))}</option>`).join("");
      return send(res, 200, page("Settings · Level 5", `<div class="app solo"><header class="topbar"><a class="logo" href="/">${MARK()}<span>Level 5</span></a><nav class="crumbs"><a href="/">Repositories</a><span>/</span><b>Settings</b></nav></header>
        <main class="main"><header class="vh"><h1>Settings</h1><p>For ${esc(user.login)}. Level 5 stores everything in UTC and shows it in this time zone.</p></header>
        <form method="post" class="settings"><label><span>Time zone</span><select name="tz"><option value=""${tz ? "" : " selected"}>Use my browser's time zone</option>${opts}</select></label><button type="submit">Save</button>${url.searchParams.has("saved") ? `<span class="faint">Saved.</span>` : ""}</form>
        <p class="hint" id="tz-now"></p></main></div><script>(()=>{const b=Intl.DateTimeFormat().resolvedOptions().timeZone;document.getElementById("tz-now").textContent="Your browser says "+b+"."})()</script>`));
    }
    if (url.pathname === "/admin/landing" || url.pathname === "/admin/landing/waitlist.csv") {
      if (!user) return redirect(res, "/auth/login");
      if (!isAdmin(user)) return send(res, 404, page("Not found", `<header class="top">${LOGO}</header><p class="none">This page does not exist.</p>`));
      if (url.pathname.endsWith(".csv")) return send(res, 200, await waitlistCsv(), { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="level5-waitlist-${new Date().toISOString().slice(0, 10)}.csv"` });
      return send(res, 200, await landingAdmin(user, origin));
    }
    if (url.pathname === "/logout" && req.method === "POST") return redirect(res, "/", { "set-cookie": "fs=; Path=/; Max-Age=0" });

    const m = url.pathname.match(/^\/r\/([\w.-]+\/[\w.-]+?)(\.json|\/live|\/setup|\/ask|\/costs|\/key|\/report|\/triggers|\/fire|\/runs|\/body\/[\w.:-]+|\/rules(?:\/\d+(?:\/(?:delete|toggle))?)?)?$/);
    if (m && (req.method === "GET" || (req.method === "POST" && (m[2] === "/ask" || m[2] === "/key" || m[2] === "/triggers" || m[2] === "/fire" || m[2]?.startsWith("/rules"))))) {
      if (!user) return redirect(res, "/auth/login");
      const repos = await userRepos(user).catch(() => null);
      if (!repos) return redirect(res, "/auth/login");
      const seen = repos.find((r) => r.full_name.toLowerCase() === m[1].toLowerCase());
      if (!seen) return send(res, 404, page("Not found", `<header class="top">${LOGO}</header><p class="none">Level 5 is not installed on that repo, or your account cannot see it.</p>`));
      const row = await ensureRepo(seen, user);
      if (m[2] === "/live") return json(res, 200, { ...(await readLive(await installationToken(row.installation_id), row.full_name)), beats: (await db.one("SELECT COUNT(*)::int AS n FROM heartbeats WHERE repo_id = $1", row.id)).n });
      if (m[2] === "/setup") return send(res, 200, heartbeatPage(origin, row));
      if (m[2] === "/runs") return json(res, 200, await readRuns(db, row.id));
      if (m[2]?.startsWith("/body/")) {
        // the last report a skill sent, as its email; sandboxed, so nothing in it runs
        const b = await db.one("SELECT html FROM report_bodies WHERE repo_id = $1 AND monitor = $2", row.id, decodeURIComponent(m[2].slice(6)));
        if (!b) return send(res, 404, "No report body yet", { "content-type": "text/plain" });
        return send(res, 200, b.html, { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src * data:; frame-ancestors 'self'", "x-frame-options": "SAMEORIGIN" });
      }
      if (m[2] === "/costs") {
        // every cost row of the last 120 days, one [day, provider, service, usd] per breakdown key
        const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
        const rows = [];
        for (const r of await db.all("SELECT source, day, usd, body FROM costs WHERE repo_id = $1 AND day >= $2", row.id, since)) {
          const b = JSON.parse(r.body);
          if (r.source === "claude-code") { const v = r.usd ?? sessionUsd(b.models, {}); if (v != null) rows.push([r.day, "claude-code", "Claude Code sessions", Math.round(v * 100) / 100]); continue; }
          if (r.usd == null) continue;
          const parts = b.breakdown && Object.keys(b.breakdown).length ? Object.entries(b.breakdown) : [[srcLabel(r.source), r.usd]];
          for (const [name, v] of parts) if (Number(v)) rows.push([r.day, r.source, svcShort(name), Math.round(Number(v) * 100) / 100]);
        }
        return json(res, 200, { today: new Date().toISOString().slice(0, 10), rows });
      }
      if (m[2] === "/report") {
        // the daily factory report for one UTC day (default yesterday), exactly as the email
        const saved = await db.one("SELECT body FROM snapshots WHERE repo_id = $1", row.id);
        let snap = saved && JSON.parse(saved.body);
        if (!snap || snap.v !== SNAP_V) snap = await refresh(row);
        const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("day") || "") ? url.searchParams.get("day") : undefined;
        return send(res, 200, dailyReport(snap, { origin, day }).html);
      }
      if (m[2] === "/key") {
        // replacing the key is a deliberate, same-site form post; the old key keeps working for a day
        if (req.method !== "POST" || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) return send(res, 405, "POST from this page only");
        await replaceKey(row.id);
        return redirect(res, `/r/${row.full_name}?key=new#setup`);
      }
      if (m[2] === "/triggers" || m[2] === "/fire") {
        // Run a Claude Code routine from Level 5. There is no API to create or edit routines, only to fire
        // one that has an API trigger: the person pastes that trigger's URL and token here once. The token
        // is sealed at rest, never sent back to the page, and only ever posted to Anthropic's fire URL.
        if (req.method === "GET") {
          const list = await db.all("SELECT routine, url, created_by, created_at, last_fired_at, last_fired_by, last_session_url, last_error FROM routine_triggers WHERE repo_id = $1", row.id);
          return json(res, 200, Object.fromEntries(list.map((t) => [t.routine, { ...t, url: t.url.replace(/routines\/([\w-]{4})[\w-]*\//, "routines/$1…/") }])));
        }
        if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return json(res, 403, { error: "from this page only" });
        const b = JSON.parse((await readBody(req, 7e4)) || "{}");
        const routine = String(b.routine || "").slice(0, 200);
        if (!routine) return json(res, 400, { error: "which routine?" });
        if (m[2] === "/triggers") {
          if (b.remove) { await db.run("DELETE FROM routine_triggers WHERE repo_id = $1 AND routine = $2", row.id, routine); return json(res, 200, { ok: true }); }
          const fireUrl = String(b.url || "").trim(), token = String(b.token || "").trim();
          if (!/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[\w-]{6,80}\/fire$/.test(fireUrl)) return json(res, 422, { error: "That is not a routine's API trigger URL. It looks like https://api.anthropic.com/v1/claude_code/routines/…/fire" });
          if (!/^sk-ant-[\w-]{20,300}$/.test(token)) return json(res, 422, { error: "That is not a routine trigger token. It starts with sk-ant-." });
          await db.run("DELETE FROM routine_triggers WHERE repo_id = $1 AND routine = $2", row.id, routine);
          await db.run("INSERT INTO routine_triggers (repo_id, routine, url, token, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)", row.id, routine, fireUrl, seal(token), user.login, new Date().toISOString());
          return json(res, 200, { ok: true });
        }
        const t = await db.one("SELECT * FROM routine_triggers WHERE repo_id = $1 AND routine = $2", row.id, routine);
        if (!t) return json(res, 404, { error: "This routine has no API trigger in Level 5 yet." });
        if (t.last_fired_at && Date.now() - Date.parse(t.last_fired_at) < 20e3) return json(res, 429, { error: "It was started a few seconds ago. Give it a moment." });
        const text = typeof b.text === "string" ? b.text.slice(0, 65536) : "";
        let out, err = null;
        try {
          const r = await fetch(t.url, { method: "POST", headers: { authorization: `Bearer ${open(t.token)}`, "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01", "content-type": "application/json" }, body: JSON.stringify(text ? { text } : {}), signal: AbortSignal.timeout(20e3) });
          out = await r.json().catch(() => ({}));
          if (!r.ok) err = r.status === 401 ? "Anthropic rejected the token: it may have been regenerated. Paste the new one." : r.status === 429 ? "The routine's hourly limit is reached. Try again later." : r.status === 400 ? "Anthropic refused the run: the routine may be paused." : `Anthropic answered ${r.status}${out?.error?.message ? `: ${out.error.message}` : ""}`;
        } catch (e) { err = `Could not reach Anthropic: ${e.message}`; }
        const now = new Date().toISOString(), sessionUrl = !err ? String(out?.claude_code_session_url || "") : null;
        await db.run("UPDATE routine_triggers SET last_fired_at = $1, last_fired_by = $2, last_session_url = $3, last_error = $4 WHERE repo_id = $5 AND routine = $6", now, user.login, sessionUrl, err, row.id, routine);
        await db.run("INSERT INTO events (repo_id, at, level, kind, title, detail, entity, dedupe) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (repo_id, dedupe) DO NOTHING", row.id, now, err ? "bad" : "ok", "routine", `${routine.replace(/^App: /, "")} ${err ? "could not start" : "started from Level 5"}`, err || `by ${user.login}${text ? `: ${text.slice(0, 140)}` : ""}`, `routine:${encodeURIComponent(routine)}`, `fire:${routine}:${now}`);
        return err ? json(res, 502, { error: err }) : json(res, 200, { ok: true, session_url: sessionUrl });
      }
      if (m[2]?.startsWith("/rules")) {
        if (req.method !== "POST") return json(res, 200, await evalRules(row.id));
        const [, id, act] = m[2].match(/^\/rules(?:\/(\d+)(?:\/(delete|toggle))?)?$/) || [];
        // a rule id is only ever used together with this repo's id: one tenant cannot touch another's rules
        if (act === "delete") await db.run("DELETE FROM price_rules WHERE id = $1 AND repo_id = $2", Number(id), row.id);
        else if (act === "toggle") await db.run("UPDATE price_rules SET enabled = 1 - enabled WHERE id = $1 AND repo_id = $2", Number(id), row.id);
        else {
          const b = JSON.parse((await readBody(req, 2e4)) || "{}");
          let name = String(b.name || "").trim().slice(0, 80) || "Price rule", cfg = JSON.stringify(ruleConfig(b));
          if (typeof b.text === "string" && b.text.trim()) {
            const saved = await db.one("SELECT body FROM snapshots WHERE repo_id = $1", row.id), snap = saved && JSON.parse(saved.body);
            const made = await ruleFromText(b.text, { sources: snap?.costs?.sources || [], services: (snap?.costs?.services || []).map((x) => x.name) }).catch((e) => ({ error: e.message }));
            if (made.error) return json(res, 422, { error: made.error });
            [name, cfg] = [made.name, JSON.stringify(made.config)];
          }
          if (id) await db.run("UPDATE price_rules SET name = $1, config = $2 WHERE id = $3 AND repo_id = $4", name, cfg, Number(id), row.id);
          else await db.run("INSERT INTO price_rules (repo_id, name, config, enabled, created_by, created_at) VALUES ($1, $2, $3, 1, $4, $5)", row.id, name, cfg, user.login, new Date().toISOString());
        }
        await refresh(row).catch(() => {});
        return json(res, 200, { ok: true });
      }
      if (m[2] === "/ask") {
        if (req.method !== "POST") return send(res, 405, "POST only");
        if (!askAllowed(user.login)) return send(res, 429, "That's 40 questions in the last hour. Try again later.", { "content-type": "text/plain; charset=utf-8" });
        const { messages = [], focus } = JSON.parse((await readBody(req, 2e5)) || "{}");
        const clean = messages.filter((x) => ["user", "assistant"].includes(x?.role) && typeof x.content === "string").slice(-20).map((x) => ({ role: x.role, content: x.content.slice(0, 8000) }));
        if (!clean.length || clean.at(-1).role !== "user") return send(res, 400, "Ask a question.");
        const saved = await db.one("SELECT body FROM snapshots WHERE repo_id = $1", row.id);
        let snap = saved && JSON.parse(saved.body);
        if (!snap || snap.v !== SNAP_V) snap = await refresh(row);
        let system = await askContext(row, snap, user, repos);
        // a chat window opened from something on the page: what that thing shows, as the person sees it
        if (focus && typeof focus.text === "string") system += `\n\n## What ${user.login} is looking at right now\n${String(focus.title || "").slice(0, 200)}\n${focus.text.slice(0, 6000)}\n\nThey opened this from the page. When they ask for a summary: three or four short sentences in plain words, no headings, no list. Say what it is, whether it is fine or not and why, and the one thing to do if anything. Then answer follow-ups about it, still briefly.`;
        return askWithTools(res, system, clean, origin, row, user);
      }
      let saved = await db.one("SELECT at, body FROM snapshots WHERE repo_id = $1", row.id);
      if (saved && JSON.parse(saved.body).v !== SNAP_V) saved = null;
      const fresh = saved && Date.now() - Number(saved.at) < FRESH_MS;
      if (m[2]) return json(res, 200, fresh ? JSON.parse(saved.body) : await refresh(row));
      // ?partial=1 is the page's own background fetch: always a fresh read (deduped, and
      // the readers keep their own short caches).
      const tz = await userTz(user?.login);
      // the Refresh button: drop this repo's short caches and read everything again
      if (url.searchParams.has("partial") && url.searchParams.has("force")) {
        for (const k of cache.keys()) if (k.endsWith(`:${row.full_name}`) || k.includes(`:${row.full_name}:`)) cache.delete(k);
        return send(res, 200, statusPage(await refresh(row), user, origin, row, { tz }));
      }
      if (url.searchParams.has("partial")) return send(res, 200, statusPage(fresh ? JSON.parse(saved.body) : await refresh(row), user, origin, row, { tz }));
      if (saved) return send(res, 200, statusPage(JSON.parse(saved.body), user, origin, row, { stale: !fresh, tz }));
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
