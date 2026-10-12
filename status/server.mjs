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
import { openDb } from "./db.mjs";
import { createCipheriv, createDecipheriv, createHash, createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { landingPage } from "./landing.mjs";

const PORT = Number(process.env.PORT || 8080);
// Local dev (npm run dev): signed in as DEV_USER, GitHub read with your own `gh` session instead of
// the GitHub App, and the database a Neon branch from .env.local. Never on in production.
const DEV = !!process.env.DEV_USER && process.env.NODE_ENV !== "production";
const DEV_TOKEN = DEV ? process.env.DEV_GITHUB_TOKEN || execSync("gh auth token").toString().trim() : null;
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

    return { meta: { full_name: meta.full_name, private: meta.private, default_branch: meta.default_branch, url: meta.html_url }, skills, monitors, routines, notes, prices: config.prices || {}, promotion: config.promotion || null, client: { hush_sh: !!hushSh, cost_cmd: /\bcost\)/.test(hushSh || ""), hook: /hush\.sh session-end/.test(settingsJson || "") }, workflows: workflows.filter((w) => w.state === "active").map((w) => ({ id: w.id, name: w.name, path: w.path, url: w.html_url })) };
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
    const [pulls, cmp, runs] = await Promise.all([
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
const srcLabel = (k) => ({ aws: "AWS", vercel: "Vercel", neon: "Neon", anthropic: "Anthropic API", "claude-code": "Claude Code", openai: "OpenAI", fly: "Fly", cloudflare: "Cloudflare", supabase: "Supabase" }[k] || k);
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

// The status chart: every skill that runs on a routine, one row each, 30 daily bars (12 weekly
// for weekly skills). A bar is green when the skill ran and read something, yellow when it ran
// but came back degraded or read nothing, red when its routine should have run it and it did not,
// grey when nothing was expected (no schedule, or before the skill's first heartbeat).
// Rows are grouped by the routine that runs them, so a routine's schedule and token cost show once.
const fireOn = (cron, a, b) => { const t = nextRun(cron, new Date(a - 6e4)); return !!t && Date.parse(t) < b; };
async function readSkills(factory, repoId, monitors, routines, prices) {
  const WEEKS = 12, H = 36e5, GRACE = 6 * H, now = Date.now();
  const since = new Date(now - WEEKS * 7 * 864e5).toISOString();
  const beats = (await db.all("SELECT monitor, ts, status, body FROM heartbeats WHERE repo_id = $1 AND ts >= $2", repoId, since)).map((b) => ({ ...JSON.parse(b.body), monitor: b.monitor, ts: b.ts, status: b.status }));
  const firstRows = await db.all("SELECT monitor, MIN(ts) AS t FROM heartbeats WHERE repo_id = $1 GROUP BY monitor", repoId);
  const first = Object.fromEntries(firstRows.map((r) => [r.monitor, Date.parse(r.t)]));
  const sess = (await db.all("SELECT day, usd, body FROM costs WHERE repo_id = $1 AND source = 'claude-code' AND day >= $2", repoId, since.slice(0, 10))).map((r) => { const b = JSON.parse(r.body); return { name: b.name || "session", day: r.day, usd: r.usd ?? sessionUsd(b.models, prices) }; });
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
  // routines that run skills Hush has never heard from still get a row: you should see them
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
  return { routines: hist, groups, usd_30d: sess.filter((x) => x.usd != null && Date.parse(x.day + "T12:00:00Z") >= now - WINDOW * 864e5).reduce((a, x) => a + x.usd, 0), sessions_30d: sess.length };
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
    status: skills,
    ci,
    metrics,
    costs: await readCosts(repoRow.id, factory.prices),
    security: await readSecurity(repoRow.id),
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
  const what = { usd: "spend", tokens: "Claude Code tokens", session_tokens: "tokens in one session" }[c.measure];
  const per = { day: "a day", week: "over 7 days", month: "this month", forecast: "forecast for the month", session: "" }[c.period];
  const src = c.source === "any" ? "All providers" : c.source === "claude-code" ? "Claude Code" : c.source.toUpperCase().length <= 4 ? c.source.toUpperCase() : c.source;
  const lim = c.cond === "spike" ? `${c.pct}% above the ${c.days}-day average` : c.measure === "usd" ? `$${c.amount}` : `${Number(c.amount).toLocaleString("en-US")} tokens`;
  const days = c.dow.length && c.dow.length < 7 ? ` · ${c.dow.map((d) => DOW[d]).join(", ")}` : "";
  const dates = c.from || c.to ? ` · ${c.from || "…"} to ${c.to || "…"}` : "";
  const src2 = c.measure === "usd" ? src : "Claude Code";
  return `${src2}${c.service && c.measure === "usd" ? ` (${c.service})` : ""} · ${[what, per].filter(Boolean).join(" ")} over ${lim}${days}${dates}`;
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
const SNAP_V = 12;

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

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">`;
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
.cx-mini .cx-chart{min-height:260px}.cx-mini .cx-loading{padding:110px 0}.cx-mini .cx-legend{margin-top:6px}.group a.line{text-decoration:none;color:inherit}.group a.line:hover{background:rgba(15,16,20,.03)}.cols i.stack{display:flex;flex-direction:column-reverse;overflow:hidden;background:transparent}.cols i.stack em{display:block;min-height:1px;border-radius:0}
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
.svc-map{position:relative;height:min(600px,66vh);border-radius:10px;overflow:hidden;background:#fff;box-shadow:var(--shadow,0 0 0 1px var(--line))}
.svc-map canvas{display:block;width:100%!important;height:100%!important;cursor:grab}.svc-map canvas:active{cursor:grabbing}
.map-hint{position:absolute;left:14px;bottom:12px;font-size:12px;color:var(--faint);pointer-events:none;z-index:2}
.map-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.city-label{position:absolute;left:0;top:0;white-space:nowrap;font:700 15px/1 Kalam,"Comic Sans MS",cursive;color:#1d1d1f;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 6px #fff}.city-label.alarm{color:var(--bad)}
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
// shadow, Inter, black primary buttons, indigo only for links and focus. Hush's orange stays in the
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
.tb-right{margin-left:auto;display:flex;align-items:center;gap:10px}.tb-user{color:var(--muted);font-size:12.5px}.tb-btn{background:none;border:0;color:var(--muted);font:inherit;padding:0;cursor:pointer}.tb-btn:hover{color:var(--ink);background:none}
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
.rt .rt-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.rt .name{display:flex;flex-direction:column;gap:3px;min-width:0}.rt .name b{font-size:14.5px;font-weight:600}.rt .name small{color:var(--muted);font-size:12.5px}.rt .name small a{color:var(--muted);text-decoration:none}.rt .name small a:hover{color:var(--ink)}.rt .name code{font-size:12px}
.rt-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:12px 0 10px}.rt-stats span{display:flex;flex-direction:column;font-size:11.5px;color:var(--faint)}.rt-stats b{font-size:14px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.rt-hint{margin:8px 0 0;font-size:12.5px;color:var(--muted);line-height:1.45}.rt-hint code{font-size:11.5px}
.w-facts{margin:12px 0 0;font-size:13px;color:var(--muted)}.w-facts a{color:var(--ink)}.w-raw{margin-top:14px;font-size:12.5px}.w-raw summary{cursor:pointer;color:var(--faint)}.w-raw .w-list{margin-top:8px}
.win:not(.adhoc) .win-body{flex:none;max-height:45%}.win:not(.adhoc) .win-chat{flex:1;max-height:none}
.win-chat{flex:none;display:flex;flex-direction:column;gap:8px;max-height:52%;border-top:1px solid var(--line);padding:10px 14px 12px;background:#fbfbfc}
.win.adhoc .win-body{display:none}.win.adhoc .win-chat{flex:1;max-height:none;border-top:0;background:var(--bg)}
.wc-log{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;font-size:13.5px;line-height:1.5}
.wc-m{padding:8px 11px;border-radius:10px;max-width:92%}.wc-m.assistant{align-self:flex-start;background:var(--bg);border:1px solid var(--line)}.wc-m.user{align-self:flex-end;background:var(--ink);color:var(--bg)}.wc-m.err{color:var(--bad)}.wc-m ul{margin:4px 0;padding-left:18px}
.wc-ask{display:flex;gap:8px;align-items:flex-end}.wc-ask textarea{flex:1;resize:none;min-height:36px;max-height:120px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:13.5px;background:var(--bg)}.wc-ask button{height:36px;padding:0 14px;border:0;border-radius:8px;background:var(--ink);color:var(--bg);font:500 13px inherit;cursor:pointer}.wc-ask button:disabled{opacity:.5}
.main :is(.banner,.banner-sub,.stat,.chart,.row,.line,.incident,.tbl tbody tr,.cx-main,.card,.rt-stats){cursor:pointer}.main :is(.stat,.chart,.line,.incident,.tbl tbody tr,.card):hover{background:rgba(15,16,20,.025)}
.tb-actsw{position:relative}.tb-acts{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:500 12.5px inherit;cursor:pointer}.tb-acts:hover{background:rgba(15,16,20,.04)}.tb-ai{display:inline-flex}.tb-ai .gi{width:13px;height:13px}.tb-n{font-variant-numeric:tabular-nums;color:var(--warn);font-weight:600}.tb-n:empty{display:none}html[data-acts] .tb-acts{background:rgba(15,16,20,.06)}
.acts-pop{display:none;position:absolute;right:0;top:36px;z-index:60;width:min(520px,calc(100vw - 24px));max-height:72vh;overflow:auto;padding:4px 14px 12px;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 14px 40px -10px rgba(0,28,36,.3)}html[data-acts] .acts-pop{display:block}
.acts-pop .live-head h2{font-size:13px}.acts-pop .job:not([data-st=in_progress]){display:none}.acts-pop .recent .rrow:nth-child(n+7){display:none}.acts-pop .group{margin-bottom:10px}
@media(max-width:820px){.tb-acts>span:nth-child(2){display:none}}
@media(max-width:820px){.side{top:44px;height:auto;flex-direction:row;padding:8px 10px}.main{padding:20px 16px 64px}.win{inset:44px 0 0 0!important}}
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
async function poll(){clearTimeout(timer);if(!document.hidden){try{const r=await fetch(u,{credentials:"same-origin"});if(r.ok){const d=await r.json();const finished=data&&data.active.some(x=>!d.active.some(y=>y.id===x.id));data=d;render();if(d.beats&&document.getElementById("onboard")&&window.hushPull)window.hushPull();else if(finished&&window.hushPull)setTimeout(window.hushPull,1500)}}catch(e){}}
timer=setTimeout(poll,data&&data.active.length||document.getElementById("onboard")?8e3:3e4)}
setInterval(()=>{document.querySelectorAll(".ci-live [data-since]").forEach(x=>x.textContent=dur(Date.now()-new Date(x.dataset.since)));document.querySelectorAll(".ci-live [data-ago]").forEach(x=>x.textContent=ago(x.dataset.ago))},1e3);
document.addEventListener("hush:swap",render);document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll()});poll()})()</script>`;
const VIEWS = ["status", "monitors", "automations", "ci", "prs", "issues", "costs", "map", "security", "setup"];
const VIEW_HEAD = `<script>(()=>{const v=location.hash.slice(1);document.documentElement.dataset.view=${JSON.stringify(VIEWS)}.includes(v)?v:"status"})()</script>`;
const VIEW_CSS = `.view{display:none}` + VIEWS.map((v) => `html[data-view=${v}] .view[data-view=${v}]{display:block}html[data-view=${v}] [data-nav=${v}]{background:rgba(15,16,20,.06);color:var(--ink);font-weight:500}html[data-view=${v}] [data-nav=${v}] .ni{color:var(--ink)}`).join("");
const VIEW_JS = `<script>(()=>{const V=${JSON.stringify(VIEWS)};const set=()=>{const v=location.hash.slice(1);document.documentElement.dataset.view=V.includes(v)?v:"status"};
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
const H=document.documentElement,K="hush-ask",open=o=>{if(o)H.dataset.ask="1";else delete H.dataset.ask;try{localStorage.setItem(K,o?"1":"")}catch(x){}if(o)setTimeout(()=>{const i=document.getElementById("ask-input");if(i)i.focus()},0)};
try{if(localStorage.getItem(K))H.dataset.ask="1"}catch(x){}if(location.hash==="#assistant"){open(true);history.replaceState(null,"",location.pathname+location.search+"#status")}
document.addEventListener("click",ev=>{const t=ev.target.closest&&ev.target.closest("[data-ask-toggle]");if(t){open(!H.dataset.ask);return}const c=ev.target.closest&&ev.target.closest(".chip");if(c){open(true);ask(c.dataset.q)}});
document.addEventListener("keydown",ev=>{if(ev.key==="Escape"&&H.dataset.ask&&ev.target.closest&&ev.target.closest("#chat"))open(false)});
document.addEventListener("hush:swap",draw);draw()})()</script>`;
// Floating windows, after the admin's PanelHost (docs/admin/crud-panel.md → Windows): one click on
// an entity opens its own window; the same entity never opens twice (it comes to the front);
// windows are dragged by the title bar, resized from any edge (min 380×280), cascade 28 px from
// the right, take focus on pointer-down, minimize to a dock, never zoom, never dim the page.
// They live on <body>, outside the page, so section changes and background refreshes keep them;
// their contents come from the page's <template>s and are refreshed with it. The open set is in
// the URL (?w=), so a link reopens them. On a phone each window is a full-screen sheet.
const WIN_JS = `<script>(()=>{const W=window.hushWin||(window.hushWin={list:[],frames:{}});
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
function fill(w){if(w.ad)return;const t=tpl(w.key),b=w.el.querySelector(".win-body");if(t){const st=b.scrollTop;b.replaceChildren(t.content.cloneNode(true));b.scrollTop=st;w.el.classList.remove("gone");w.title=t.dataset.title;w.el.querySelector(".win-title").textContent=t.dataset.title}else w.el.classList.add("gone")}
function focus(w){W.list.splice(W.list.indexOf(w),1);W.list.push(w);if(w.min){w.min=false;w.el.hidden=false;renderDock()}order()}
function close(w){w.el.remove();W.list.splice(W.list.indexOf(w),1);order();renderDock();syncUrl()}
function open(key,quiet){const had=W.list.find(w=>w.key===key);if(had){focus(had);return true}const ad=W.adhoc&&W.adhoc[key];const t=ad?{dataset:{kind:ad.kind,title:ad.title,href:""}}:tpl(key);if(!t)return false;
const n=W.list.filter(w=>!w.min).length,vw=innerWidth,vh=innerHeight,ww=Math.min(620,Math.max(MINW,vw*.42));
W.frames[key]=W.frames[key]||{w:ww,h:vh-TOP-24-n*STEP,x:vw-ww-20-n*STEP,y:TOP+8+n*STEP};
const el=document.createElement("section");el.className="win";el.setAttribute("role","dialog");el.setAttribute("aria-label",t.dataset.kind+" "+t.dataset.title);
el.innerHTML='<header class="win-bar"><span class="win-kind">'+esc(t.dataset.kind)+'</span><b class="win-title"></b><span class="win-acts">'+(t.dataset.href?'<a class="win-btn" data-no-drag href="'+esc(t.dataset.href)+'" target="_blank" rel="noopener" title="Open on GitHub">'+ICON.gh+"</a>":"")+'<button type="button" class="win-btn" data-act="min" title="Minimize">'+ICON.min+'</button><button type="button" class="win-btn" data-act="close" title="Close">'+ICON.close+'</button></span></header><div class="win-body"></div><div class="win-chat"><div class="wc-log"></div><form class="wc-ask"><textarea rows="1" placeholder="Ask about this…"></textarea><button type="submit">Ask</button></form></div><div class="win-gone">No longer in this page\\'s data.</div>'+["n","s","e","w","ne","nw","se","sw"].map(d=>'<i class="win-rz" data-dir="'+d+'"></i>').join("");
document.body.appendChild(el);const w={key,el,kind:t.dataset.kind,title:t.dataset.title,min:false,msgs:[],ad};if(ad)el.classList.add("adhoc");W.list.push(w);fill(w);place(w);if(!quiet)syncUrl();chat(w);
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

const md=t=>esc(t).replace(/\\*\\*([^*]+)\\*\\*/g,"<b>$1</b>").replace(/\\x60([^\\x60\\n]+)\\x60/g,"<code>$1</code>").replace(/^[-*] (.+)$/gm,"<li>$1</li>").replace(/(<li>.*<\\/li>\\n?)+/g,m=>"<ul>"+m.replace(/\\n/g,"")+"</ul>").replace(/\\n{2,}/g,"<br><br>").replace(/\\n/g,"<br>");
const SUMMARY="Give me a concise, simple summary of what I'm looking at.";
function ctxOf(w){const b=w.el.querySelector(".win-body");return ((w.ad?w.ad.text:b?b.textContent.replace(/[ \\t]+/g," "):"")||"").replace(/\\n{3,}/g,"\\n\\n").slice(0,6000)}
function drawChat(w){const log=w.el.querySelector(".wc-log");log.innerHTML=w.msgs.filter(m=>!m.hidden).map(m=>'<div class="wc-m '+m.role+(m.err?" err":"")+'">'+(m.role==="user"?esc(m.content):md(m.content)||'<span class="typing"><i></i><i></i><i></i></span>')+"</div>").join("");log.scrollTop=log.scrollHeight;w.el.querySelector(".wc-ask button").disabled=!!w.busy}
async function talk(w,q,hidden){if(w.busy||!q.trim())return;w.busy=true;w.msgs.push({role:"user",content:q.trim(),hidden});const a={role:"assistant",content:""};w.msgs.push(a);drawChat(w);
try{const r=await fetch(location.pathname.replace(/[/]$/,"")+"/ask",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({focus:{title:w.kind+": "+w.title,text:ctxOf(w)},messages:w.msgs.filter(m=>m!==a&&!m.err).map(({role,content})=>({role,content}))})});
if(!r.ok||!r.body){a.content=(await r.text())||"The assistant did not answer.";a.err=true}else{const rd=r.body.getReader(),dec=new TextDecoder();for(;;){const {done,value}=await rd.read();if(done)break;a.content+=dec.decode(value,{stream:true});drawChat(w)}}}catch(x){a.content="Could not reach the assistant.";a.err=true}w.busy=false;drawChat(w)}
function chat(w){const f=w.el.querySelector(".wc-ask"),i=f.querySelector("textarea");f.addEventListener("submit",ev=>{ev.preventDefault();const q=i.value;i.value="";talk(w,q)});
i.addEventListener("keydown",ev=>{if(ev.key==="Enter"&&!ev.shiftKey){ev.preventDefault();f.requestSubmit()}});talk(w,SUMMARY,true)}
// what on the page can be explained, and how it is named in the window's title bar
const EXPLAIN=".banner,.banner-sub,.stat,.chart,.row,.line,.incident,.tbl tbody tr,.cx-main,.svc-map,.card,.rt-stats,.sec-f .line";
function explain(ev){if(ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;if(String(getSelection())) return;
const el=ev.target.closest(EXPLAIN);if(!el||!el.closest(".main")||ev.target.closest("a,button,input,textarea,select,label,summary,.cx-bar,.ms"))return;
const view=el.closest(".view"),sec=view&&view.querySelector(".vh h1"),h2=(()=>{let n=el.closest(".group,.cx,.incidents")||el;while(n&&n.previousElementSibling){n=n.previousElementSibling;if(/^H[12]$/.test(n.tagName)||n.classList.contains("rules-h"))return n.innerText.replace(/\\s*All costs.*$/,"").trim()}return ""})();
const first=(el.querySelector("b,.mon-id,h3,.name")||el).innerText.split("\\n")[0].trim().slice(0,70);
const kind=h2||(sec?sec.innerText:"")||"Status",title=first||kind,key="ask:"+kind+":"+title;
W.adhoc=W.adhoc||{};W.adhoc[key]={kind,title,text:(kind+"\\n"+el.innerText).slice(0,6000)};open(key)}
document.addEventListener("click",ev=>{const chip=ev.target.closest(".win-chip");if(chip){const w=W.list.find(x=>x.key===chip.dataset.key);if(w)focus(w);return}
const o=ev.target.closest("[data-open]");if(!o){explain(ev);return}if(ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;
const inner=ev.target.closest("a,button");if(inner&&inner!==o&&!inner.hasAttribute("data-open"))return;if(open(o.dataset.open))ev.preventDefault()});
document.addEventListener("keydown",ev=>{if((ev.key==="Enter"||ev.key===" ")&&ev.target.matches&&ev.target.matches("[data-open][tabindex]")){ev.preventDefault();open(ev.target.dataset.open)}
if(ev.key==="Escape"&&!ev.target.closest("input,textarea")){const top=W.list.filter(w=>!w.min).at(-1);if(top)close(top)}});
document.addEventListener("hush:swap",()=>W.list.forEach(fill));addEventListener("resize",()=>W.list.forEach(place));
window.hushOpen=k=>open(k);if(!W.started){W.started=true;(new URL(location.href).searchParams.get("w")||"").split(",").filter(Boolean).forEach(k=>open(k,true));syncUrl()}})()</script>`;
// The bell: polls /api/notifications every minute; opening the panel marks everything read. The
// panel lives on <body> so background refreshes do not close it. A click on an entry goes to the
// repo and opens the entity's window (in place when it is the repo on screen).
const NOTIF_JS = `<script>(()=>{const N=window.hushNotif||(window.hushNotif={data:null});
const e=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago=t=>{const m=Math.round((Date.now()-new Date(t))/6e4);return m<1?"just now":m<60?m+" min ago":m<1440?Math.round(m/60)+" h ago":Math.round(m/1440)+" d ago"};
const VIEW={monitor:"monitors",routine:"automations",workflow:"ci",pr:"prs",issue:"issues",cost:"costs",rule:"costs",promotion:"ci",security:"security"};
function badge(){const b=document.querySelector("#tb-bell .tb-count");if(!b)return;const n=N.data?N.data.unread:0;b.hidden=!n;b.textContent=n>9?"9+":n}
function panel(){let p=document.getElementById("notif-panel");if(!p){p=document.createElement("div");p.id="notif-panel";p.className="notif";p.hidden=true;document.body.appendChild(p)}return p}
function draw(){const p=panel(),d=N.data;p.innerHTML='<div class="notif-h"><b>Notifications</b>'+(d&&d.unread?'<button type="button" class="notif-all">Mark all as read</button>':'<span class="faint">'+(d&&d.items.length?"All caught up":"")+"</span>")+"</div>"+(d&&d.items.length?'<div class="notif-list">'+d.items.map(x=>'<a class="notif-i'+(x.unread?" unread":"")+'" data-id="'+x.id+'" data-lvl="'+e(x.level)+'" href="/r/'+e(x.repo)+(x.entity?"?w="+encodeURIComponent(x.entity):"")+"#"+(VIEW[x.kind]||"status")+'" data-repo="'+e(x.repo)+'" data-entity="'+e(x.entity)+'"><i></i><span><b>'+e(x.title)+"</b>"+(x.detail?'<span class="nd">'+e(x.detail)+"</span>":"")+'<span class="nm">'+e(x.repo)+" · "+ago(x.at)+"</span></span></a>").join("")+"</div>":'<div class="notif-empty">Nothing yet. An entry appears when a monitor changes state, a routine runs late, CI breaks or recovers, a PR is opened or merged, an issue opens, or spend jumps.</div>')}
async function load(){try{const r=await fetch("/api/notifications",{credentials:"same-origin"});if(r.ok){N.data=await r.json();badge();if(!panel().hidden)draw()}}catch(x){}}
function toggle(show){const p=panel(),b=document.getElementById("tb-bell");if(show===undefined)show=p.hidden;p.hidden=!show;if(b)b.setAttribute("aria-expanded",show);if(show)draw()}
function mark(ids){if(!N.data)return;const all=!ids;N.data.items.forEach(x=>{if(all||ids.includes(x.id))x.unread=false});N.data.unread=N.data.items.filter(x=>x.unread).length;badge();if(!panel().hidden)draw();
fetch("/api/notifications",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(all?{all:true}:{ids})})}
document.addEventListener("click",ev=>{if(ev.target.closest("#tb-bell")){ev.preventDefault();toggle();return}
if(ev.target.closest(".notif-all")){ev.preventDefault();mark();return}
const a=ev.target.closest(".notif-i");if(a){if(a.classList.contains("unread"))mark([+a.dataset.id]);const here=location.pathname.replace(/[/]$/,"")==="/r/"+a.dataset.repo;if(here&&window.hushOpen&&!ev.metaKey&&!ev.ctrlKey){ev.preventDefault();toggle(false);location.hash=a.hash.slice(1);if(a.dataset.entity)window.hushOpen(a.dataset.entity)}return}
if(!ev.target.closest("#notif-panel"))toggle(false)});
document.addEventListener("keydown",ev=>{if(ev.key==="Escape")toggle(false)});
document.addEventListener("hush:swap",badge);if(!N.started){N.started=true;load();setInterval(()=>{if(!document.hidden)load()},6e4)}else badge()})()</script>`;
const RULES_JS = `<script>(()=>{if(window.hushRules)return;window.hushRules=1;
const base=()=>location.pathname.replace(/[/]$/,"")+"/rules";
function deps(f){const v=n=>f.elements[n]&&f.elements[n].value;const sess=v("measure")==="session_tokens",fc=v("period")==="forecast",spike=!sess&&!fc&&v("cond")==="spike";
f.querySelectorAll("[data-show]").forEach(l=>{const k=l.dataset.show;l.hidden=k==="period"?sess:k==="cond"?(sess||fc):k==="amount"?spike:k==="spike"?!spike:k==="service"?v("measure")!=="usd":false})}
const sync=()=>document.querySelectorAll(".rule-form").forEach(deps);
document.addEventListener("change",ev=>{const f=ev.target.closest&&ev.target.closest(".rule-form");if(f)deps(f)});
const obs=new MutationObserver(sync);obs.observe(document.body,{childList:true,subtree:true});sync();
async function post(url,body){const r=await fetch(url,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:body?JSON.stringify(body):"{}"});if(!r.ok)throw new Error(await r.text());if(window.hushPull)await window.hushPull()}
document.addEventListener("submit",async ev=>{const f=ev.target.closest(".rule-form");if(!f)return;ev.preventDefault();const fd=new FormData(f),b={};for(const [k,v] of fd)if(k!=="dow")b[k]=v;b.dow=fd.getAll("dow").map(Number);
const msg=f.querySelector(".f-msg"),btn=f.querySelector("[type=submit]");btn.disabled=true;msg.textContent="Saving…";
try{await post(base()+(f.dataset.ruleId?"/"+f.dataset.ruleId:""),b);msg.textContent="Saved.";if(!f.dataset.ruleId){const w=f.closest(".win");w&&w.querySelector('[data-act="close"]').click()}}catch(x){msg.textContent="Could not save: "+x.message}btn.disabled=false});
document.addEventListener("click",async ev=>{const b=ev.target.closest("[data-rule-act]");if(!b)return;ev.preventDefault();ev.stopPropagation();const act=b.dataset.ruleAct,id=b.dataset.id;
if(act==="delete"&&!b.dataset.sure){b.dataset.sure=1;b.textContent="Click again to delete";return}b.disabled=true;
try{await post(base()+"/"+id+"/"+act);if(act==="delete"){const w=b.closest(".win");w&&w.querySelector('[data-act="close"]').click()}}catch(x){b.textContent="Failed"}b.disabled=false},true)})()</script>`;
const MAP_JS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Kalam:wght@700&display=swap">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
// The factory as a city, after the map in the "Build your own software factory" post: a tiled
// board, one building per service (footprint and height from 30-day spend, the biggest on a
// podium), colored by district, a short name on the roof, a road down the middle with traffic.
const M = window.hushMap || (window.hushMap = {});
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const DISTRICTS = [
  ["run", 0x5f9e6e, /container|fargate|ec2|compute|lambda|app runner|batch|vercel|fly|lightsail|elastic beanstalk/i],
  ["edge", 0x4f9a7a, /cloudfront|vpc|virtual private cloud|route ?53|load balanc|api gateway|nat|direct connect|global accelerator|cloudflare/i],
  ["data", 0x5b8ab8, /s3|storage|rds|relational|aurora|dynamo|elasticache|neon|backup|efs|redshift|opensearch|database|supabase/i],
  ["ai", 0x7d6bb4, /bedrock|transcribe|sagemaker|rekognition|polly|textract|comprehend|claude|anthropic|openai|translate/i],
  ["ship", 0x5a7fa8, /codebuild|ecr|registry|codepipeline|codedeploy|amplify/i],
  ["watch", 0xc9a447, /cloudwatch|cloudtrail|kms|key management|secrets|systems manager|iam|cost explorer|config|guardduty|security hub|x-ray/i],
  ["talk", 0xb8665f, /ses|email|sns|notification|sqs|queue|eventbridge|pinpoint|twilio|chime/i],
];
const SHORT = [[/elastic container service/i,"ECS"],[/simple storage service/i,"S3"],[/relational database/i,"RDS"],[/simple email/i,"SES"],[/simple notification/i,"SNS"],[/simple queue/i,"SQS"],[/elastic compute cloud|ec2 - other|ec2-other/i,"EC2"],[/elastic load balancing/i,"ELB"],[/virtual private cloud/i,"VPC"],[/key management/i,"KMS"],[/container registry/i,"ECR"],[/systems manager/i,"SSM"],[/lambda/i,"λ"],[/route ?53/i,"R53"],[/cloudfront/i,"CF"],[/cloudwatch/i,"CW"],[/bedrock/i,"BR"],[/codebuild/i,"CB"],[/dynamo/i,"DDB"],[/aurora/i,"AU"],[/transcribe/i,"TR"],[/secrets/i,"SM"],[/api gateway/i,"API"],[/claude/i,"CC"],[/vercel/i,"▲"],[/neon/i,"N"]];
const district = (s) => DISTRICTS.find(([, , re]) => re.test(s.name + " " + s.provider)) || ["other", 0x8a8f96];
const short = (s) => (SHORT.find(([re]) => re.test(s.name)) || [null, s.name.replace(/^(Amazon|AWS) /, "").split(/\\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase()])[1];
const nice = (s) => s.name.replace(/^(Amazon|AWS) /, "").replace(/Elastic Container Service/, "ECS").replace(/Simple Storage Service/, "S3").replace(/Relational Database Service/, "RDS").replace(/Simple Email Service/, "SES").replace(/Elastic Compute Cloud - Compute/, "EC2").replace(/Virtual Private Cloud/, "VPC").replace(/Key Management Service/, "KMS").replace(/Elastic Container Registry \\(ECR\\)/, "ECR").replace(/^AmazonCloudTrail$|^CloudTrail$/, "CloudTrail").replace(/^Amazon/, "").replace(/Systems Manager/, "Parameter Store").replace(/Claude Code sessions/, "Claude Code");
async function build() {
  const host = document.getElementById("svc-map"), dataEl = document.getElementById("map-data");
  if (!host || !dataEl || document.documentElement.dataset.view !== "map") return;
  if (M.host === host) return;
  M.dispose?.();
  let THREE, OrbitControls;
  try { THREE = await import("three"); ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js")); }
  catch { host.innerHTML = '<div class="map-hint">The 3D map could not load. The list below has the same numbers.</div>'; return; }
  const services = JSON.parse(dataEl.textContent).services;
  const W = () => host.clientWidth, H = () => host.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(W(), H());
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25); sun.position.set(-8, 20, 14); scene.add(sun);
  const INK = 0x2a2a2a;
  const outlined = (geo, color, pos) => {
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    m.position.copy(pos);
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: INK })));
    scene.add(m); return m;
  };
  // lots: districts in order, biggest first; column ROAD stays empty for the road
  const sorted = services.map((s) => ({ s, d: district(s) })).sort((a, b) => DISTRICTS.findIndex((x) => x[0] === a.d[0]) - DISTRICTS.findIndex((x) => x[0] === b.d[0]) || b.s.total - a.s.total);
  const n = sorted.length, COLS = Math.max(4, Math.ceil(Math.sqrt(n * 1.4))) + 1, ROAD = Math.floor(COLS / 2), CELL = 2.4;
  const lots = []; for (let i = 0, c = 0; lots.length < n; c++) { if (c % COLS === ROAD) continue; lots.push([c % COLS, Math.floor(c / COLS)]); i++; }
  const rows = Math.ceil(lots.at(-1)[1] + 1), BW = COLS * CELL + 1.6, BD = rows * CELL + 1.6;
  const ox = -BW / 2 + 0.8 + CELL / 2, oz = -BD / 2 + 0.8 + CELL / 2;
  // the board: tiles on a beige slab
  outlined(new THREE.BoxGeometry(BW + 0.6, 0.5, BD + 0.6), 0xb9b4a8, new THREE.Vector3(0, -0.45, 0));
  outlined(new THREE.BoxGeometry(BW, 0.2, BD), 0xe9e6de, new THREE.Vector3(0, -0.1, 0));
  const tiles = new THREE.GridHelper(Math.max(BW, BD), Math.round(Math.max(BW, BD) / (CELL / 2)), 0xc4bfb2, 0xc4bfb2); tiles.position.y = 0.005;
  tiles.scale.set(BW / Math.max(BW, BD), 1, BD / Math.max(BW, BD)); scene.add(tiles);
  // the road with its dashes
  const road = outlined(new THREE.BoxGeometry(CELL * 0.7, 0.04, BD - 0.4), 0xd6d2c8, new THREE.Vector3(ox + ROAD * CELL, 0.02, 0));
  for (let z = -BD / 2 + 0.8; z < BD / 2 - 0.6; z += 0.9) { const d = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.36), new THREE.MeshBasicMaterial({ color: 0xffffff })); d.position.set(ox + ROAD * CELL, 0.06, z); scene.add(d); }
  // buildings
  const max = Math.max(...services.map((s) => s.total)), blocks = [], labels = [];
  const roofTex = (txt, color) => { const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
    g.fillStyle = "#" + color.toString(16).padStart(6, "0"); g.beginPath(); g.roundRect(14, 14, 100, 100, 18); g.fill();
    g.fillStyle = "#fff"; g.font = "700 " + (txt.length > 2 ? 34 : 48) + "px Kalam, system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, 64, 68);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; };
  const ROOF = { run: 0xe8742a, edge: 0x8b5cf6, data: 0xc026d3, ai: 0x10a37f, ship: 0xc026d3, watch: 0xdb2777, talk: 0xe11d48, other: 0x475569 };
  sorted.forEach(({ s, d }, i) => {
    const [c, r] = lots[i], x = ox + c * CELL, z = oz + r * CELL, k = Math.sqrt(s.total / max);
    const color = s.alarm ? 0xd13212 : d[1];
    const foot = 0.8 + 1.15 * k, h = 0.35 + 5.6 * k;
    let top = 0, body;
    if (k > 0.55) { // big spenders stand on a podium, like the post's tallest towers
      outlined(new THREE.BoxGeometry(Math.min(2.15, foot + 0.6), h * 0.32, Math.min(2.15, foot + 0.6)), color, new THREE.Vector3(x, h * 0.16, z));
      body = outlined(new THREE.BoxGeometry(foot * 0.72, h, foot * 0.72), color, new THREE.Vector3(x, h * 0.32 + h / 2, z)); top = h * 1.32;
    } else { body = outlined(new THREE.BoxGeometry(foot, h, foot), color, new THREE.Vector3(x, h / 2, z)); top = h; }
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(0.95, foot * 0.6), Math.min(0.95, foot * 0.6)), new THREE.MeshBasicMaterial({ map: roofTex(short(s), ROOF[d[0]] ?? 0x475569), transparent: true }));
    roof.rotation.x = -Math.PI / 2; roof.position.set(x, top + 0.012, z); scene.add(roof);
    body.userData = { s, base: color }; blocks.push(body);
    labels.push({ text: nice(s), pos: new THREE.Vector3(x, top + 0.25, z), alarm: s.alarm, rank: s.total });
  });
  // traffic: orange dots wandering the road and the lots
  const dots = [];
  if (!still) for (let i = 0; i < Math.min(40, 8 + n * 2); i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color: 0xec7211 }));
    const onRoad = i % 3 === 0, lot = lots[i % n];
    m.userData = onRoad ? { road: true, z: Math.random() * BD - BD / 2, v: (Math.random() < 0.5 ? -1 : 1) * (0.012 + Math.random() * 0.02), x: ox + ROAD * CELL + (Math.random() < 0.5 ? -0.3 : 0.3) } : { cx: ox + lot[0] * CELL, cz: oz + lot[1] * CELL, a: Math.random() * 6.28, r: 0.9 + Math.random() * 0.3, v: 0.004 + Math.random() * 0.01 };
    m.position.y = 0.1; scene.add(m); dots.push(m);
  }
  const sphere = new THREE.Box3().setFromObject(scene).getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -300, 500);
  const fit = () => { const a = W() / H(), v = sphere.radius * (a >= 1 ? 0.8 : 0.8 / a); cam.left = -v * a; cam.right = v * a; cam.top = v; cam.bottom = -v; cam.updateProjectionMatrix(); renderer.setSize(W(), H()); };
  cam.position.set(sphere.center.x + 26, 30, sphere.center.z + 34); cam.lookAt(sphere.center); fit();
  const controls = new OrbitControls(cam, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, autoRotate: !still, autoRotateSpeed: 0.35, minZoom: 0.6, maxZoom: 4, maxPolarAngle: Math.PI * 0.42, enablePan: false });
  controls.target.copy(sphere.center);
  renderer.domElement.addEventListener("pointerdown", () => (controls.autoRotate = false), { once: true });
  const layer = document.createElement("div"); layer.className = "map-layer"; host.appendChild(layer);
  labels.sort((a, b) => (b.alarm - a.alarm) || b.rank - a.rank);
  const tags = labels.map((l) => { const e = document.createElement("span"); e.className = "city-label" + (l.alarm ? " alarm" : ""); e.textContent = l.text; layer.appendChild(e); return { ...l, e }; });
  const tip = document.createElement("div"); tip.className = "map-tip"; tip.hidden = true; host.appendChild(tip);
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let hover = null, down = null;
  const money = (v) => "$" + (v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2));
  const pick = (ev) => { const r = renderer.domElement.getBoundingClientRect(); ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, cam); return ray.intersectObjects(blocks, false)[0]?.object || null; };
  renderer.domElement.addEventListener("pointermove", (ev) => {
    const o = pick(ev);
    if (hover && hover !== o) hover.material.emissive?.setHex(0);
    hover = o; renderer.domElement.style.cursor = o ? "pointer" : "grab";
    if (!o) { tip.hidden = true; return; }
    o.material.emissive.setHex(0x2a2a2a);
    const s = o.userData.s, t = Math.abs(s.trend) < 0.05 ? "flat" : (s.trend > 0 ? "+" : "") + Math.round(s.trend * 100) + "%";
    tip.innerHTML = "<b></b><span></span><span></span>"; tip.children[0].textContent = s.name; tip.children[1].textContent = s.label + " · " + money(s.total) + " in 30 days"; tip.children[2].textContent = money(s.last7) + " last 7 days, " + t + (s.alarm ? " · price rule firing" : "");
    const r = host.getBoundingClientRect(); tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 240) + "px"; tip.style.top = (ev.clientY - r.top + 14) + "px"; tip.hidden = false;
  });
  renderer.domElement.addEventListener("pointerleave", () => { tip.hidden = true; if (hover) hover.material.emissive.setHex(0); hover = null; });
  renderer.domElement.addEventListener("pointerdown", (ev) => (down = [ev.clientX, ev.clientY]));
  renderer.domElement.addEventListener("pointerup", (ev) => { if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4) return; const o = pick(ev); if (o && window.hushOpen) window.hushOpen("service:" + o.userData.s.key); });
  const ro = new ResizeObserver(fit); ro.observe(host);
  const v3 = new THREE.Vector3(); let raf;
  const loop = (t) => {
    raf = requestAnimationFrame(loop);
    if (document.hidden || document.documentElement.dataset.view !== "map") return;
    controls.update();
    for (const m of dots) { const u = m.userData;
      if (u.road) { u.z += u.v; if (u.z > BD / 2 - 0.5) u.z = -BD / 2 + 0.5; if (u.z < -BD / 2 + 0.5) u.z = BD / 2 - 0.5; m.position.set(u.x, 0.12, u.z); }
      else { u.a += u.v; m.position.set(u.cx + Math.cos(u.a) * u.r, 0.1, u.cz + Math.sin(u.a) * u.r); } }
    if (!still) for (const b of blocks) if (b.userData.s.alarm) b.material.emissive.setHex(Math.sin(t / 220) > 0 ? 0x551100 : 0x000000);
    renderer.render(scene, cam);
    const r = host.getBoundingClientRect(), placed = [];
    for (const g of tags) {
      v3.copy(g.pos).project(cam);
      const x = (v3.x + 1) / 2 * r.width, y = (1 - v3.y) / 2 * r.height, w = g.w ??= g.e.offsetWidth, h = 22, box = [x - w / 2, y - h, x + w / 2, y];
      const clash = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      g.e.style.visibility = clash ? "hidden" : "visible"; if (!clash) placed.push(box);
      g.e.style.transform = "translate(" + x + "px," + y + "px) translate(-50%,-100%)";
    }
  };
  raf = requestAnimationFrame(loop);
  M.host = host;
  M.dispose = () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); scene.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); }); M.host = null; };
}
addEventListener("hashchange", build); document.addEventListener("hush:swap", () => { M.dispose?.(); build(); }); build();
</script>`;
// The cost explorer, after AWS Cost Explorer: stacked/bar/line chart with a hover column and a
// tooltip, and a parameters panel (time, compare, range, granularity, group by, service and
// provider filters). Data comes once from /r/<repo>/costs; all filtering runs in the browser, and the
// state survives background refreshes and reloads (localStorage).
const CX_JS = `<script>(()=>{const X=window.hushCx||(window.hushCx={data:null,at:0,st:null});
const PAL=["#5e6ad2","#26b5ce","#4cb782","#f2c94c","#f2994a","#eb5757","#bb87fc","#4ea7fc","#d4669a"],OTHER="#c4c6cc";
const NAMES={aws:"AWS",vercel:"Vercel",neon:"Neon",anthropic:"Anthropic API","claude-code":"Claude Code",openai:"OpenAI",fly:"Fly",cloudflare:"Cloudflare"};
const e=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=v=>"$"+(Math.abs(v)>=1000?Math.round(v).toLocaleString("en-US"):v.toFixed(2));
const D=d=>new Date(d+"T00:00:00Z"),iso=t=>new Date(t).toISOString().slice(0,10),add=(d,n)=>iso(D(d).getTime()+n*864e5);
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DEF={mode:"stacked",compare:false,range:"30",from:"",to:"",gran:"daily",group:"service",services:[],providers:[]};
function load(){try{return {...DEF,...JSON.parse(localStorage.getItem("hush.cx")||"{}")}}catch(x){return {...DEF}}}
function save(){try{localStorage.setItem("hush.cx",JSON.stringify(X.st))}catch(x){}}
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
document.addEventListener("hush:swap",()=>{if(Date.now()-X.at>12e4)fetchData();else draw()});
if(X.data)draw();else fetchData()})()</script>`;
const SEC_JS = `<script>(()=>{if(window.hushSec)return;window.hushSec=1;
document.addEventListener("input",ev=>{if(!ev.target.classList||!ev.target.classList.contains("sec-q"))return;const q=ev.target.value.trim().toLowerCase();document.querySelectorAll(".sec-m tr[data-k]").forEach(r=>r.hidden=q&&!r.dataset.k.includes(q))});
document.addEventListener("change",ev=>{if(ev.target.classList&&ev.target.classList.contains("sl-cb"))document.querySelectorAll(".roles-g").forEach(g=>g.classList.toggle("show-sl",ev.target.checked))})})()</script>`;
const page = (title, body, { live, stale, app } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${ICON}${FONTS}${app ? VIEW_HEAD : ""}<style>${CSS}${app ? VIEW_CSS : ""}${THEME}</style></head><body${stale ? ' data-stale="1"' : ""}><div class="wrap${app ? " app-wrap" : ""}">${body}</div>${live ? LIVE : ""}${live && body.includes('class="ci-live"') ? ACTIONS : ""}${app ? VIEW_JS : ""}${body.includes('id="chat"') ? ASK_JS : ""}${body.includes('id="win-tpl"') ? WIN_JS : ""}${body.includes('id="tb-bell"') ? NOTIF_JS : ""}${body.includes('class="rule-form"') ? RULES_JS : ""}${body.includes('id="svc-map"') ? MAP_JS : ""}${body.includes('id="cx') ? CX_JS : ""}${body.includes('class="sec-q"') || body.includes('class="sl-cb"') ? SEC_JS : ""}</body></html>`;

// What the repo page looks like while its first snapshot is being read from GitHub.
function skeletonPage(repo) {
  const bars = `<div class="bars">${'<i class="sk"></i>'.repeat(WINDOW)}</div>`;
  const row = (w) => `<div class="row"><div class="row-head"><span class="sk sk-t" style="width:${w}px"></span><span class="sk sk-t" style="width:84px"></span></div>${bars}<div class="axis"><span class="sk sk-t" style="width:100%;height:8px"></span></div></div>`;
  const stat = `<div class="stat"><span class="sk sk-t" style="width:56px;height:26px"></span><span class="sk sk-t" style="width:110px;margin-top:10px"></span><span class="sk sk-t" style="width:90px;margin-top:8px;height:8px"></span></div>`;
  // the real shell (top bar, sidebar, main column) so nothing jumps when the page arrives
  const nav = [64, 78, 92, 30, 96, 52, 46, 40, 62].map((w) => `<a><span class="sk sk-t" style="width:16px;height:14px"></span><span class="sk sk-t" style="width:${w}px"></span></a>`).join("");
  return page(`${repo} · hush`, `<div class="app">
    <header class="topbar">
      <a class="logo" href="/">${MARK()}<span>hush</span></a>
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
      : missedLast ? ["bad", `Missed the ${lastFire} run`, 0]
      : missRecent ? ["warn", `Missed ${missRecent} of the last ${recent.length}`, 0]
      : failed && b.at(-1)?.s === "warn" ? ["bad", "Last run failed", 0]
      : ["ok", "On schedule", 1];
    const tip = (x) => [x.label, { ok: x.failed ? `${x.runs} runs, ${x.failed} failed` : x.runs > 1 ? `ran ${x.runs} times` : "ran", warn: `${x.failed} of ${x.runs} runs failed`, miss: "should have run, did not", "": "nothing scheduled" }[x.s], x.usd ? usd(x.usd) : ""].filter(Boolean).join(" · ");
    const facts = [
      cmd ? `<code>/${esc(cmd)}</code>` : r.source === "GitHub Actions" ? `<code>${esc(r.prompt.replace(/^\.github\/workflows\//, ""))}</code>` : `<span class="faint">no slash command</span>`,
      esc(when(r)),
      r.model ? esc(r.model) : r.source === "GitHub Actions" ? "GitHub Actions" : "",
      h?.skills?.length ? `<a href="#monitors">${h.skills.length} skill${h.skills.length === 1 ? "" : "s"} →</a>` : "",
    ].filter(Boolean).join(" · ");
    const stats = [
      `<span><b>${r.last_seen ? ago(r.last_seen) : "never"}</b>last run</span>`,
      `<span><b>${until(r.next_run).replace(/^in /, "")}</b>next run</span>`,
      `<span><b>${onTime == null ? "–" : onTime + "%"}</b>on time</span>`,
      r.source === "Claude Code" ? `<span><b>${h?.usd_30d ? usd(h.usd_30d) : "–"}</b>${h?.usd_run ? `${usd(h.usd_run)} a run` : `in ${WINDOW} days`}</span>` : "",
    ].join("");
    const hint = st === "none" ? `<p class="rt-hint">${r.source === "Claude Code" ? `Nothing from this routine reached Hush. Its session ends without a heartbeat${cmd ? "" : " because its prompt runs no slash command"}. <a href="#setup">Install the hook</a> or end the prompt with <code>hush.sh beat</code>.` : "No run of this workflow in the window."}</p>` : "";
    return { rank, html: `<div class="row rt openable" data-open="routine:${esc(encodeURIComponent(r.name))}" role="button" tabindex="0">
      <div class="rt-top"><span class="name"><b>${esc(r.name.replace(/^App: /, ""))}</b><small>${facts}</small></span><span class="state" data-s="${st}">${label}</span></div>
      <div class="rt-stats">${stats}</div>
      ${b.length ? `<div class="bars${h.weekly ? " wk" : ""}">${b.map((x) => `<i data-s="${x.s}" title="${esc(tip(x))}"></i>`).join("")}</div>
      <div class="axis"><span>${h.weekly ? "12 weeks ago" : `${WINDOW} days ago`}</span><span class="rule"></span><span>${h.weekly ? "this week" : "today"}</span></div>` : ""}
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
      <p class="w-facts">${[m.last ? `Last run ${ago(m.last.ts)}` : "Never reported", routine ? `runs in <a href="#" data-open="routine:${esc(encodeURIComponent(routine.name))}">${esc(routine.name.replace(/^App: /, ""))}</a>` : "", m.filed.length ? `filed ${m.filed.slice(0, 5).map((x) => `<a href="${repoUrl}/issues/${x}" target="_blank" rel="noopener">#${x}</a>`).join(" ")}` : ""].filter(Boolean).join(" · ")}</p>
      ${m.history?.length ? `<details class="w-raw"><summary>Raw heartbeats (${m.history.length})</summary><div class="w-list">${m.history.map((b) => `<div><span class="pill sm" data-s="${b.status === "ok" ? "ok" : b.status === "degraded" ? "warn" : "bad"}">${b.status}</span><span class="faint">${ago(b.ts)}${b.source === "session" ? " · session" : ""}</span><span>${swept(b.swept)}${b.note ? ` <span class="faint">${esc(b.note)}</span>` : ""}</span></div>`).join("")}</div></details>` : ""}` });
  }
  for (const r of s.routines) {
    const late = isLate(r);
    const [st, label] = !r.last_seen ? ["none", "No evidence"] : late ? ["bad", "Late"] : ["ok", "On schedule"];
    const fed = s.monitors.filter((m) => m.routine === r.name);
    wins.push({ key: `routine:${encodeURIComponent(r.name)}`, kind: r.source === "GitHub Actions" ? "Scheduled workflow" : "Routine", title: r.name.replace(/^App: /, ""), body: `
      <div class="w-head">${statePill(st, label)}</div>
      <p class="w-facts">${[esc(when(r)), r.last_seen ? `last run ${ago(r.last_seen)}` : "never ran", r.next_run ? `next ${until(r.next_run)}` : "", esc(r.model || "")].filter(Boolean).join(" · ")}</p>
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
  wins.push({ key: "rule:new", kind: "Price rule", title: "New price rule", body: `<p class="faint" style="margin-top:0">A notification when spend or tokens cross a limit. It fires at most once per period.</p>${ruleForm(null)}` });
  for (const r of RULES) wins.push({ key: `rule:${r.id}`, kind: "Price rule", title: r.name, body: `<p class="faint" style="margin-top:0">${esc(r.summary)}</p>${ruleForm(r)}` });
  const fmtRule = (r, v) => (v == null ? "–" : r.config.measure === "usd" ? usd(v) : tk(v));
  const rulesSection = `<div class="rules-h"><h2>Price rules</h2><button type="button" class="btn-sm" data-open="rule:new">New rule</button></div>
    <p class="hint" style="margin:-4px 0 12px">Alarms on spend and tokens. Crossing a limit sends a notification, once per period.</p>
    <div class="group">${RULES.length ? RULES.map((r) => {
      const pct = r.limit ? Math.min(100, (r.value / r.limit) * 100) : 0;
      const st = !r.enabled ? ["none", "Paused"] : !r.active ? ["none", "Not active now"] : r.over ? [r.config.severity === "bad" ? "bad" : "warn", "Over the limit"] : ["ok", "Within the limit"];
      return `<div class="line rule openable" data-open="rule:${r.id}" role="button" tabindex="0"><span class="name">${esc(r.name)}<span class="sub">${esc(r.summary)}${r.last_fired_at ? ` · last fired ${ago(r.last_fired_at)}` : ""}</span>
        <span class="meter" data-s="${st[0]}"><i style="width:${pct.toFixed(1)}%"></i></span></span>
        <span class="meta"><span class="state" data-s="${st[0]}">${st[1]}</span><span class="sub">${fmtRule(r, r.value)} of ${r.limit == null ? "no baseline yet" : fmtRule(r, r.limit)}</span><button type="button" class="btn-plain" data-rule-act="toggle" data-id="${r.id}">${r.enabled ? "Pause" : "Resume"}</button></span></div>`;
    }).join("") : `<div class="line"><span class="hint">No price rules yet. For example: AWS above $50 a day, Claude Code tokens 50% above the 7-day average, or a month-end forecast above $1,500.</span></div>`}</div>`;
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
    <div class="map-wrap"><div id="svc-map" class="svc-map" aria-label="3D map of services by spend"><div class="map-hint">Drag to rotate · scroll to zoom · click a block</div></div>
      <div class="map-legend"><span><i style="background:#5f9e6e"></i>Run</span><span><i style="background:#4f9a7a"></i>Edge</span><span><i style="background:#5b8ab8"></i>Data</span><span><i style="background:#7d6bb4"></i>AI</span><span><i style="background:#5a7fa8"></i>Ship</span><span><i style="background:#c9a447"></i>Watch</span><span><i style="background:#b8665f"></i>Talk</span><span><i style="background:#d13212"></i>Price rule firing</span><span class="faint">Size and height = spend in ${WINDOW} days · orange dots are traffic</span></div></div>
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
    <div class="group stats">
      <div class="stat"><b>${P.last ? ago(P.last.merged_at).replace(" ago", "") : "–"}</b><span>Since the last promotion</span><small>${P.last ? `<a href="#" data-open="pr:${P.last.number}">#${P.last.number}</a> · ${hrs((Date.parse(P.last.merged_at) - Date.parse(P.last.created_at)) / 36e5)} to merge` : "none yet"}</small></div>
      <div class="stat"><b>${P.ahead ?? "–"}</b><span>Commits waiting in ${esc(P.from)}</span><small>${P.waiting_prs} PR${P.waiting_prs === 1 ? "" : "s"}${P.oldest_waiting ? `, oldest ${ago(P.oldest_waiting)}` : ""}</small></div>
      <div class="stat"><b>${P.count_30d}</b><span>Promotions in ${WINDOW} days</span><small>${P.median_gap_h != null ? `one every ${hrs(P.median_gap_h)} (median)` : ""}</small></div>
      <div class="stat"><b>${P.deploys.filter((d) => d.conclusion === "success").length}<i>/${P.deploys.length}</i></b><span>Workflows green on ${esc(P.to)}</span><small data-s="${P.deploys.some((d) => d.conclusion === "failure") ? "bad" : "ok"}">${P.deploys.filter((d) => d.conclusion === "failure").map((d) => esc(d.name)).join(", ") || (P.deploys.length ? "latest run of each passed" : "no runs")}</small></div>
    </div>
    ${P.open ? `<div class="group promo-open openable" data-open="pr:${P.open.number}" role="button" tabindex="0"><div class="line"><span class="name">${PR_ICON.open}<span><b>Promotion in progress: #${P.open.number}</b><span class="sub">${esc(P.open.title)} · opened ${ago(P.open.created_at)} by ${esc(P.open.author)} · <code class="branch">${esc(P.open.head)}</code> → <code class="branch prod">${esc(P.to)}</code></span></span></span><span class="meta"><span class="state" data-s="${P.open.ci === "green" ? "ok" : P.open.ci === "red" ? "bad" : P.open.ci === "running" ? "warn" : "none"}"${P.open.ci === "running" ? " data-run" : ""}>${ciTxt[P.open.ci] || ""}</span></span></div></div>` : ""}
    <div class="promo-cols">
      <div><h2>Waiting for ${esc(P.to)} <span class="faint">${P.ahead ?? 0}</span></h2><div class="group promo-list">${P.waiting.length ? P.waiting.slice(0, 25).map((w) => `<a class="line" href="${esc(w.pr ? `${repoUrl}/pull/${w.pr}` : w.url)}" target="_blank" rel="noopener"><span class="name"><span><span class="pm">${esc(w.message.replace(/\s*\(#\d+\)\s*$/, ""))}</span><span class="sub">${w.pr ? `#${w.pr} · ` : ""}<code>${esc(w.sha)}</code> · ${esc(w.author)} · ${ago(w.at)}</span></span></span></a>`).join("") + (P.waiting.length > 25 ? `<div class="line"><span class="hint">and ${P.waiting.length - 25} more</span></div>` : "") : `<div class="line"><span class="hint">Nothing waiting: ${esc(P.to)} has everything in ${esc(P.from)}.</span></div>`}</div></div>
      <div><h2>Recent promotions</h2><div class="group promo-list">${P.history.length ? P.history.map((p) => `<a class="line" href="${esc(p.url)}" target="_blank" rel="noopener" data-open="pr:${p.number}"><span class="name">${PR_ICON.merged}<span><span class="pm">#${p.number} ${esc(p.title)}</span><span class="sub">merged ${ago(p.merged_at)} · open ${hrs((Date.parse(p.merged_at) - Date.parse(p.created_at)) / 36e5)}${p.author ? ` · ${esc(p.author)}` : ""}</span></span></span></a>`).join("") : `<div class="line"><span class="hint">No promotion merged yet.</span></div>`}</div>
      ${P.deploys.length ? `<h2 style="margin-top:20px">Latest runs on ${esc(P.to)}</h2><div class="group promo-list">${P.deploys.map((d) => `<a class="line" href="${esc(d.url)}" target="_blank" rel="noopener"><span class="name">${esc(d.name)}<span class="sub"><code>${esc(d.sha || "")}</code> · ${ago(d.at)}</span></span><span class="meta"><span class="state" data-s="${d.status !== "completed" ? "warn" : d.conclusion === "success" ? "ok" : d.conclusion === "failure" ? "bad" : "none"}"${d.status !== "completed" ? " data-run" : ""}>${d.status !== "completed" ? "Running" : d.conclusion === "success" ? "Passed" : d.conclusion === "failure" ? "Failed" : esc(d.conclusion || "")}</span></span></a>`).join("")}</div>` : ""}</div>
    </div>`;
  if (P?.enabled) for (const p of [P.open, ...P.history].filter(Boolean)) if (!wins.some((w) => w.key === `pr:${p.number}`)) wins.push({ key: `pr:${p.number}`, kind: "Promotion", title: `#${p.number} ${p.title}`, href: p.url, body: `
      <div class="w-head">${statePill(p.state === "open" ? "ok" : "merged", p.state === "open" ? "Open" : "Merged")}<span class="flow"><code class="branch">${esc(p.head)}</code> → <code class="branch prod">${esc(P.to)}</code></span></div>
      <p class="w-title">${esc(p.title)}</p>
      ${kv([["Author", esc(p.author)], ["Opened", when2(p.created_at)], ["Merged", p.merged_at ? when2(p.merged_at) : ""], ["Time to merge", p.merged_at ? hrs((Date.parse(p.merged_at) - Date.parse(p.created_at)) / 36e5) : ""], ["CI", p.ci ? ciTxt[p.ci] : ""]])}` });
  const SEC = s.security;
  const dAgo = (d) => (d ? ago(d) : "never");
  const age = (d) => (d ? `${Math.round((Date.now() - Date.parse(d)) / 864e5)} d` : "–");
  const SEVL = { critical: ["bad", "Critical"], high: ["bad", "High"], medium: ["warn", "Medium"], low: ["none", "Low"] };
  const secEmpty = `<div class="group"><div class="line"><span class="hint">No inventory yet. Run this where the AWS and Infisical CLIs are logged in (your laptop, or a routine), at the repo root:<br><code>node &lt;hush&gt;/status/scripts/security-inventory.mjs</code><br>It reads IAM users, roles and keys, and the names of your Infisical secrets, and sends only names and metadata.</span></div></div>`;
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
    security: `<path d="M8 1.8l5 2v4c0 3.2-2.2 5.5-5 6.4-2.8-.9-5-3.2-5-6.4v-4z"/><path d="M5.8 8.2l1.6 1.6 3-3.2"/>`,
    map: `<path d="M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9z"/><path d="M2.4 4.9L8 8l5.6-3.1M8 8v6.2"/>`,
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
  const badMon = s.monitors.filter((m) => ["dead", "lying", "degraded"].includes(m.state)).length;
  const warnMon = s.monitors.filter((m) => m.state === "warn").length;
  const lateN = s.routines.filter(isLate).length;
  const failingCi = (s.ci || []).filter((w) => w.last?.status === "completed" && w.last.conclusion === "failure").length;
  const badge = (n, tone) => (n ? `<span class="nb" data-t="${tone}">${n}</span>` : "");
  const count = (n) => (n ? `<span class="nc">${n}</span>` : "");
  const needsN = ((s.status?.groups) || []).flatMap((g) => g.rows).filter((r) => ["dead", "degraded", "lying", "warn", "late"].includes(r.state)).length;
  const NAV = [
    ["status", "Status", needsN ? badge(needsN, "bad") : ""],
    ["monitors", "Monitors", badMon ? badge(badMon, "bad") : warnMon ? badge(warnMon, "warn") : count(s.monitors.length)],
    ["automations", "Automations", lateN ? badge(lateN, "bad") : count(s.routines.length)],
    ["ci", "CI", failingCi ? badge(failingCi, "bad") : count((s.ci || []).length)],
    ["prs", "Pull requests", count(s.queue.prs.length)],
    ["issues", "Issues", count(s.queue.issues.length)],
    ["costs", "Costs", C ? `<span class="nc">${usd(C.total_usd)}</span>` : ""],
    ["map", "Map", ""],
    ["security", "Security", (() => { const f = s.security?.findings || []; const hi = f.filter((x) => SEV[x.sev] <= 1).length; return hi ? badge(hi, "bad") : f.length ? count(f.length) : ""; })()],
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
    const sub = [r.last ? `last run ${ago(r.last)}` : "never reported", r.read != null && r.unit ? `read ${r.read.toLocaleString("en-US")} ${esc(r.unit)}` : "", r.misses ? `<b class="miss">missed ${r.misses}</b>` : ""].filter(Boolean).join(" · ");
    const open = s.monitors.some((m) => m.id === r.id) ? ` openable" data-open="monitor:${esc(r.id)}" role="button" tabindex="0` : "";
    return `<div class="row sk-row${open}">
      <div class="row-head"><span class="name"><span class="mon-id">${esc(r.id)}</span><small>${sub}</small></span><span class="state" data-s="${ps}" title="${esc(r.why)}">${label}</span></div>
      <div class="bars${r.weekly ? " wk" : ""}">${bars}</div>
      <div class="axis"><span>${r.weekly ? "12 weeks ago" : `${WINDOW} days ago`}</span><span class="rule"></span><span>${r.on_time == null ? "–" : `${r.on_time}% ok`}</span><span class="rule"></span><span>${r.weekly ? "this week" : "today"}</span></div>
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
    ...(secHi.length ? [alertLine("bad", "Security", `${plural(secHi.length, "critical or high finding")}`, esc(secHi.slice(0, 3).map((f) => f.title).join(" · ")), "#security")] : []),
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
        ${needs.length ? `<div class="group${needs.length > 1 ? " grid2" : ""}">${needs.map(skRow).join("")}</div>` : ""}
        ${others.length ? `<div class="group">${others.join("")}</div>` : ""}
        ${needs.length ? `<p class="sk-key"><i data-s="ok"></i>ran <i data-s="warn"></i>degraded or read nothing <i data-s="miss"></i>should have run, did not <i></i>nothing expected</p>` : ""}` : ""}
        <div class="rules-h"><h2>Costs</h2><a class="more" href="#costs">All costs →</a></div>
        ${costBlock}
        ${metrics}`;

  const costsEmpty = `<div class="group"><div class="line"><span class="hint">No cost data yet. Claude Code sessions report their tokens through the heartbeat hook; provider spend comes from <code>.claude/hooks/hush.sh cost aws 31.50</code> or <code>POST /api/cost</code>. See <a href="#setup">Setup</a>.</span></div></div>`;

  return page(`${s.repo} · hush`, `<div class="app">
    <header class="topbar">
      <a class="logo" href="/">${MARK()}<span>hush</span></a>
      <nav class="crumbs" aria-label="Breadcrumb">${user ? `<a href="/">Repositories</a><span>/</span>` : ""}<b>${esc(s.repo)}</b></nav>
      <span class="tb-right"><span class="tb-actsw"><button type="button" class="tb-acts" data-acts-toggle aria-haspopup="true" aria-label="GitHub Actions"><span class="tb-ai"></span><span>Actions</span><span class="tb-n"></span></button><div class="acts-pop"><div class="ci-live" data-pop="1" aria-live="polite"></div></div></span><button type="button" class="tb-ask" data-ask-toggle aria-controls="chat" title="Ask about this repo"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 7h.01M8 7h.01M10.5 7h.01"/></svg><span>Ask</span></button>${user ? `<button type="button" class="tb-bell" id="tb-bell" aria-label="Notifications" aria-haspopup="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5a4 4 0 0 1 8 0c0 3 1.2 4.3 1.5 4.5h-11C2.8 10.8 4 9.5 4 6.5zM6.6 13a1.5 1.5 0 0 0 2.8 0"/></svg><span class="tb-count" hidden></span></button>` : ""}</span>
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
      ${view("status", statusView)}
      ${view("monitors", `${vh("Monitors", "Skills that run on a schedule and report a heartbeat. A silent monitor is a dead monitor.")}
        ${s.monitors.length ? `<div class="group grid2">${monRows}</div>` : `<div class="group"><div class="line"><span class="hint">No heartbeat yet. <a href="#setup">Install the heartbeat</a>.</span></div></div>`}`)}
      ${view("automations", `${vh("Automations", "Every scheduled job: whether it ran when it should have, and what it cost. Whether each run was any good is in Monitors.")}
        ${s.routines.length ? `<div class="group grid2 rts">${routineRows}</div><p class="sk-key"><i data-s="ok"></i>ran <i data-s="warn"></i>ran, failed <i data-s="miss"></i>should have run, did not <i></i>nothing scheduled</p>` : `<div class="group"><div class="line"><span class="hint">No routines found. Declare them in <code>.claude/factory.json</code>.</span></div></div>`}`)}
      ${view("ci", `${vh("CI", "How code reaches production: promotions, what is running now, and every workflow over the last 30 days.")}
        ${promoSection}
        ${liveBox(false)}
        ${ci ? `<h2>Workflows</h2><div class="group grid2">${ci}</div>` : ""}`)}
      ${view("prs", `${vh("Pull requests", "Open with their CI, plus the latest merged and closed.")}${prSection}`)}
      ${view("issues", `${vh("Issues", `${plural(s.queue.issues.length, "open issue")}.`)}<div class="incidents">${incidents}</div>`)}
      ${view("costs", `${vh("Costs", "What the factory spends per day and per provider, and the tokens every Claude Code session burns.")}${costs || costsEmpty}${rulesSection}`)}
      ${view("map", `${vh("Map", "The factory as a city: every service it pays for is a building, as big as what it cost in the last 30 days.")}${mapSection}`)}
      ${view("security", `${vh("Security", "AWS IAM and the secrets in Infisical. Names and metadata only: Hush never receives a secret value.")}${secSection}`)}
      ${view("setup", `${vh("Setup", setupState.hush_sh && setupState.hook ? "This repo reports to Hush. Each step shows what is in place." : "How this repo reports to Hush.")}${repoRow ? `<section class="onboard">${heartbeatSetup(origin, repoRow.ingest_key, onboarding, setupState)}</section>` : ""}
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
    const r = await fetch("https://api.github.com/repos/humanagent/hush", { headers: { accept: "application/vnd.github+json", "user-agent": "hush" }, signal: AbortSignal.timeout(5000) });
    if (r.ok) STARS.n = (await r.json()).stargazers_count ?? null;
  } catch {}
}

function homePage(user, repos = [], msg = "", snaps = {}, viewer = null) {
  const app = appConfig();
  if (!app) {
    return page("hush", `<header class="top">${LOGO}</header>
      <div class="hero"><h1>A status page for your software factory.</h1><p>The GitHub App is not set up yet. Whoever runs this instance does it once, from <code>/setup</code>.</p></div>`);
  }
  const install = `https://github.com/apps/${app.slug}/installations/new`;
  if (!user) return landingPage({ install, msg, esc, css: CSS + THEME, fonts: FONTS, icon: ICON, mark: MARK, stars: STARS.n, viewer: viewer?.login || null });
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
    <header class="topbar"><a class="logo" href="/">${MARK()}<span>hush</span></a><nav class="crumbs"><b>Repositories</b></nav><span class="tb-right"><button type="button" class="tb-bell" id="tb-bell" aria-label="Notifications" aria-haspopup="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5a4 4 0 0 1 8 0c0 3 1.2 4.3 1.5 4.5h-11C2.8 10.8 4 9.5 4 6.5zM6.6 13a1.5 1.5 0 0 0 2.8 0"/></svg><span class="tb-count" hidden></span></button><form method="post" action="/logout" style="margin:0"><button class="tb-btn">Sign out</button></form></span></header>
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
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin", ...headers });
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
      const repo = key && (await db.one("SELECT id FROM repos WHERE ingest_key = $1", key));
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const list = [].concat(JSON.parse((await readBody(req, 4e6)) || "[]"));
      for (const it of list.slice(0, 5)) await db.run("INSERT INTO inventories (repo_id, kind, at, body) VALUES ($1, $2, $3, $4) ON CONFLICT (repo_id, kind) DO UPDATE SET at = excluded.at, body = excluded.body", repo.id, String(it.kind), new Date().toISOString(), JSON.stringify(cleanInventory(String(it.kind), it.data || {})));
      const row = await db.one("SELECT * FROM repos WHERE id = $1", repo.id);
      refresh(row).catch(() => {});
      return json(res, 200, { ok: true, stored: list.length });
    }
    if (url.pathname === "/api/cost" && req.method === "POST") {
      const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const repo = key && (await db.one("SELECT id FROM repos WHERE ingest_key = $1", key));
      if (!repo) return json(res, 401, { error: "invalid ingest key" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(body) ? body : [body];
      if (list.length > 500) return json(res, 413, { error: "at most 500 per request" });
      for (const c of list) await insertCost(repo.id, c);
      await evalRules(repo.id, { fire: true }).catch((e) => console.error("rules:", e.message));
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

    // the public landing, also for someone signed in who wants to see it
    if ((url.pathname === "/landing" || (url.pathname === "/" && !user)) && req.method === "GET") await refreshStars();
    if (url.pathname === "/landing" && req.method === "GET") return send(res, 200, homePage(null, [], "", {}, user));
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
    if (url.pathname === "/logout" && req.method === "POST") return redirect(res, "/", { "set-cookie": "fs=; Path=/; Max-Age=0" });

    const m = url.pathname.match(/^\/r\/([\w.-]+\/[\w.-]+?)(\.json|\/live|\/setup|\/ask|\/costs|\/rules(?:\/\d+(?:\/(?:delete|toggle))?)?)?$/);
    if (m && (req.method === "GET" || (req.method === "POST" && (m[2] === "/ask" || m[2]?.startsWith("/rules"))))) {
      if (!user) return redirect(res, "/auth/login");
      const repos = await userRepos(user).catch(() => null);
      if (!repos) return redirect(res, "/auth/login");
      const seen = repos.find((r) => r.full_name.toLowerCase() === m[1].toLowerCase());
      if (!seen) return send(res, 404, page("Not found", `<header class="top">${LOGO}</header><p class="none">Hush is not installed on that repo, or your account cannot see it.</p>`));
      const row = await ensureRepo(seen, user);
      if (m[2] === "/live") return json(res, 200, { ...(await readLive(await installationToken(row.installation_id), row.full_name)), beats: (await db.one("SELECT COUNT(*)::int AS n FROM heartbeats WHERE repo_id = $1", row.id)).n });
      if (m[2] === "/setup") return send(res, 200, heartbeatPage(origin, row));
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
      if (m[2]?.startsWith("/rules")) {
        if (req.method !== "POST") return json(res, 200, await evalRules(row.id));
        const [, id, act] = m[2].match(/^\/rules(?:\/(\d+)(?:\/(delete|toggle))?)?$/) || [];
        // a rule id is only ever used together with this repo's id: one tenant cannot touch another's rules
        if (act === "delete") await db.run("DELETE FROM price_rules WHERE id = $1 AND repo_id = $2", Number(id), row.id);
        else if (act === "toggle") await db.run("UPDATE price_rules SET enabled = 1 - enabled WHERE id = $1 AND repo_id = $2", Number(id), row.id);
        else {
          const b = JSON.parse((await readBody(req, 2e4)) || "{}");
          const name = String(b.name || "").trim().slice(0, 80) || "Price rule";
          const cfg = JSON.stringify(ruleConfig(b));
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
        return askStream(res, system, clean, origin);
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
