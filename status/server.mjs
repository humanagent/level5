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
const db = new DatabaseSync(join(DATA, "factory.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, token TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS repos (full_name TEXT PRIMARY KEY, owner_login TEXT NOT NULL, ingest_key TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS heartbeats (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, monitor TEXT NOT NULL, ts TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS hb_unique ON heartbeats(repo, monitor, ts);
  CREATE INDEX IF NOT EXISTS hb_repo_ts ON heartbeats(repo, ts);
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshots (repo TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL);
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
        return { number: p.number, title: p.title, branch: p.head.ref, draft: p.draft, ci, url: p.html_url };
      }),
    );
    const merged = (closedRaw || []).filter((p) => p.merged_at).map((p) => ({ number: p.number, title: p.title, branch: p.head.ref, merged_at: p.merged_at, url: p.html_url })).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
    const runs = [];
    for (const r of runsRaw?.workflow_runs || []) if (!runs.some((x) => x.name === r.name)) runs.push({ name: r.name, status: r.status, conclusion: r.conclusion, at: r.updated_at, event: r.event, url: r.html_url });
    return { issues, prs, merged, runs };
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

// --- judging monitors (the /monitor-meta rules, plus the chronic ratio) -------------------
const AGENT_BRANCH = /^(claude\/|codex\/|fix\/pr-sweep|audit|fix-issues|fix\/issue-|agent\/)/;
function judge(factory, repo) {
  const WEEKS = 12;
  const since = new Date(Date.now() - WEEKS * 7 * 864e5).toISOString();
  const beats = db.prepare("SELECT monitor, ts, status, body FROM heartbeats WHERE repo = ? AND ts >= ? ORDER BY ts DESC").all(repo, since).map((b) => ({ ...JSON.parse(b.body), monitor: b.monitor, ts: b.ts, status: b.status }));
  const roster = [...factory.monitors];
  // A SessionEnd beat named after a declared routine's slash command is evidence for that
  // routine, not a monitor of its own. Anything else unknown still shows, marked unlisted.
  const routineSkill = (r) => (r.prompt?.match(/\/([a-z][a-z0-9:_-]*)/) || [])[1];
  const routineSkills = new Set(factory.routines.map(routineSkill).filter(Boolean));
  const sessions = {};
  for (const b of beats) if (b.source === "session" && !sessions[b.monitor]) sessions[b.monitor] = b.ts;
  for (const id of new Set(beats.map((b) => b.monitor))) {
    if (roster.some((m) => m.id === id)) continue;
    if (routineSkills.has(id) && beats.every((b) => b.monitor !== id || b.source === "session")) continue;
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
      return { id: m.id, cadence: "weekly", routine: m.routine || "", state, why, unlisted: !!m.unlisted, last, runs: mine.length, buckets, span: `${WEEKS} weeks ago`, filed: [...new Set(mine.flatMap((b) => b.filed || []))].slice(0, 20) };
    }
    const byDay = {};
    for (const b of mine) {
      const d = b.ts.slice(0, 10);
      if (!byDay[d] || RANK[b.status] > RANK[byDay[d]]) byDay[d] = b.status;
    }
    return { id: m.id, cadence: m.cadence || "daily", routine: m.routine || "", state, why, unlisted: !!m.unlisted, last, runs: mine.length, buckets: days.map((d) => ({ s: byDay[d] || "", label: new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" }) })), span: `${WINDOW} days ago`, filed: [...new Set(mine.flatMap((b) => b.filed || []))].slice(0, 20) };
  });
  const cut = new Date(Date.now() - WINDOW * 864e5).toISOString();
  return { monitors, beats: beats.filter((b) => b.ts >= cut).length, sessions };
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
  const ran = sessions[(r.prompt?.match(/\/([a-z][a-z0-9:_-]*)/) || [])[1]];
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
  const { monitors, beats, sessions } = judge(factory, repo);
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
    notes: factory.notes,
  };
}

// One GitHub read per repo at a time. The result is kept in SQLite so a page can render
// the last snapshot instantly, even right after the machine wakes up, and refresh behind it.
const inflight = new Map();
function refresh(row) {
  if (!inflight.has(row.full_name)) {
    const p = snapshot(row)
      .then((s) => {
        db.prepare("INSERT INTO snapshots (repo, at, body) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET at = excluded.at, body = excluded.body").run(row.full_name, Date.now(), JSON.stringify(s));
        return s;
      })
      .finally(() => inflight.delete(row.full_name));
    inflight.set(row.full_name, p);
  }
  return inflight.get(row.full_name);
}
const FRESH_MS = 60e3;
// Bump when the snapshot's shape changes, so a page never renders one saved by older code.
const SNAP_V = 2;

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
#ci-live{margin-bottom:32px}#ci-live .group{margin-bottom:0}.run-group+.recent-label{margin-top:18px}.recent-label{font-size:12px;color:var(--faint);margin:0 0 8px 2px}
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
const CHECK = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M6 10.2l2.7 2.6L14 7.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ALERT = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fff" fill-opacity=".25"/><path d="M10 5.5v5.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="#fff"/></svg>`;
const ICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' rx='10' fill='%23070b1c'/><path d='M5 22h8l3-8 5 16 3-8h11' fill='none' stroke='%23f0a35e' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/></svg>">`;
// A live page swaps its .wrap for a fresh render: now when it was served stale or as a
// skeleton, then every two minutes. Open <details> stay open across swaps.
const LIVE = `<script>(()=>{const u=location.pathname+"?partial=1";let busy=0;
const pull=async()=>{if(busy)return;busy=1;const w=document.querySelector(".wrap");w.dataset.loading="1";
try{const r=await fetch(u,{credentials:"same-origin"});if(r.status===401){location.href="/auth/login";return}
const d=new DOMParser().parseFromString(await r.text(),"text/html");const n=d.querySelector(".wrap");if(!n)throw 0;
if(!r.ok)throw 0;const open=[...w.querySelectorAll("details")].map(x=>x.open);w.replaceWith(n);
n.querySelectorAll("details").forEach((x,i)=>{if(open[i])x.open=true});document.title=d.title;document.dispatchEvent(new Event("hush:swap"))}catch(e){w.dataset.loading="";w.dataset.failed="1"}finally{busy=0}};
window.hushPull=pull;if(document.body.dataset.stale)pull();setInterval(()=>{if(!document.hidden)pull()},120e3);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)pull()})})()</script>`;
// The "Actions" panel: polls /r/<repo>/live every 8 s while something runs, 30 s otherwise,
// ticks the elapsed timers every second, and re-renders into the new .wrap after a swap.
const ACTIONS = `<script>(()=>{const box=()=>document.getElementById("ci-live");if(!box())return;
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
function render(){const b=box();if(!b||!data)return;const a=data.active,ids=new Set(a.map(r=>r.id));
const done=data.recent.filter(r=>prev.has(r.id)).map(r=>r.id);
let h='<div class="live-head"><h2>Actions</h2><span class="live-dot" data-on="'+(a.length?1:0)+'"></span><span class="live-meta">'+(a.length?a.length+" running":"Nothing running")+' · checked <span data-ago="'+e(data.at)+'">'+ago(data.at)+'</span></span></div>';
if(!data.ok)h+='<div class="group"><div class="line"><span class="hint">Could not read Actions for this repo.</span></div></div>';
if(a.length){h+='<div class="group run-group">'+a.map(r=>{const jobs=r.jobs.map(j=>{const pct=j.steps?Math.round(j.done/j.steps*100):0;
return '<li class="job" data-st="'+e(j.status)+'">'+icon(j.status,j.conclusion)+'<span class="job-name">'+e(j.name)+'</span><span class="job-step">'+(j.status==="in_progress"&&j.step?e(j.step)+' <span class="faint">'+j.done+"/"+j.steps+"</span>":j.status==="completed"?"":"waiting")+'</span><span class="job-time" '+(j.status==="in_progress"&&j.started?'data-since="'+e(j.started)+'"':"")+'>'+(j.started?dur((j.completed?new Date(j.completed):Date.now())-new Date(j.started)):"")+'</span>'+(j.status==="in_progress"?'<span class="job-bar"><i style="width:'+pct+'%"></i></span>':"")+'</li>'}).join("");
return '<div class="run" data-st="'+e(r.status)+'"><a class="run-head" href="'+e(r.url)+'" target="_blank" rel="noopener">'+icon(r.status,r.conclusion)+'<span class="run-main"><span class="run-title">'+e(r.title||r.name)+'</span><span class="run-sub"><b>'+e(r.name)+'</b> #'+r.number+' · '+e(r.event)+(r.actor?" by "+e(r.actor):"")+'</span></span><span class="run-side"><code class="branch">'+e(r.branch)+'</code><span class="run-time"><span class="faint">'+verb(r)+'</span> <span data-since="'+e(r.started)+'">'+dur(Date.now()-new Date(r.started))+'</span></span></span></a>'+(jobs?'<ul class="jobs">'+jobs+'</ul>':"")+'</div>'}).join("")+'</div>'}
if(data.recent.length)h+='<div class="recent-label">Recently finished</div><div class="group recent">'+data.recent.map(r=>'<a class="line rrow'+(done.includes(r.id)?" just":"")+'" href="'+e(r.url)+'" target="_blank" rel="noopener"><span class="name">'+icon(r.status,r.conclusion)+'<span>'+e(r.name)+' <span class="faint">#'+r.number+'</span><span class="sub">'+e(r.title)+'</span></span></span><span class="meta"><code class="branch">'+e(r.branch)+'</code><span class="sub">'+dur(new Date(r.updated)-new Date(r.started))+' · '+ago(r.updated)+'</span></span></a>').join("")+'</div>';
b.innerHTML=h;prev=ids}
async function poll(){clearTimeout(timer);if(!document.hidden){try{const r=await fetch(u,{credentials:"same-origin"});if(r.ok){const d=await r.json();const finished=data&&data.active.some(x=>!d.active.some(y=>y.id===x.id));data=d;render();if(d.beats&&document.getElementById("onboard")&&window.hushPull)window.hushPull();else if(finished&&window.hushPull)setTimeout(window.hushPull,1500)}}catch(e){}}
timer=setTimeout(poll,data&&data.active.length||document.getElementById("onboard")?8e3:3e4)}
setInterval(()=>{document.querySelectorAll("#ci-live [data-since]").forEach(x=>x.textContent=dur(Date.now()-new Date(x.dataset.since)));document.querySelectorAll("#ci-live [data-ago]").forEach(x=>x.textContent=ago(x.dataset.ago))},1e3);
document.addEventListener("hush:swap",render);document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll()});poll()})()</script>`;
const page = (title, body, { live, stale } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${ICON}${FONTS}<style>${CSS}</style></head><body${stale ? ' data-stale="1"' : ""}><div class="wrap">${body}</div>${live ? LIVE : ""}${live && body.includes('id="ci-live"') ? ACTIONS : ""}</body></html>`;

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
  `, { live: true, stale: true });
}

const STATE = { alive: ["ok", "Operational"], warn: ["warn", "Degraded"], degraded: ["bad", "Chronically degraded"], lying: ["bad", "Said ok, read nothing"], dead: ["bad", "Down"], retired: ["none", "Retired"] };

// Onboarding for a repo: the app is installed (or the user could not see this page), so what is
// left is the heartbeat. Shown at the top of the repo page until the first heartbeat arrives,
// and at /r/<repo>/setup after that.
const COPY = `<button class="copy" type="button" onclick="navigator.clipboard.writeText(this.parentNode.querySelector('pre').textContent).then(()=>{this.textContent='Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>`;
function heartbeatSetup(origin, key, waiting) {
  const DONE = `<svg class="gi" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--ok)"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const n = (i) => `<span class="ob-n">${i}</span>`;
  return `<ol class="ob">
    <li class="done">${DONE}<div><b>Hush can read this repo</b><span>The GitHub App is installed. Monitors, routines, CI and the queue below come from it.</span></div></li>
    <li>${n(2)}<div><b>Install the heartbeat</b><span>At the repo root, then commit <code>.claude/</code> and push.</span>
      <div class="cmd"><pre>curl -fsSL ${esc(origin)}/install.sh | sh -s -- ${esc(key)}</pre>${COPY}</div>
      <span>It adds a SessionEnd hook, so every Claude Code routine that runs a slash command reports itself when it ends. No change to your skills.</span></div></li>
    <li>${n(3)}<div><b>Say how each run went</b> <small>optional</small><span>A skill ends with this to send its status and how much it read. A monitor that says ok after reading nothing gets flagged.</span>
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
  -d '{"monitor":"errors","status":"ok","swept":{"events":41233}}'</pre></details></div></li>
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
    return `<details class="row"><summary>
      <div class="row-head"><span class="name"><span class="mon-id">${esc(m.id)}</span><small>${m.cadence === "weekly" ? "weekly" : "daily"}${m.unlisted ? " · not in roster" : ""}</small></span><span class="state" data-s="${ps}">${label}</span></div>
      <div class="bars">${bars}</div>
      <div class="axis"><span>${m.span}</span><span class="rule"></span><span>${pct}% ok</span><span class="rule"></span><span>today</span></div>
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

  const prs = s.queue.prs.map((p) => `<div class="line"><span class="name"><a href="${esc(p.url)}" target="_blank" rel="noopener" style="text-decoration:none">${esc(p.title)}</a><span class="sub">#${p.number} · ${esc(p.branch)}</span></span><span class="meta"><span class="state" data-s="${p.ci === "green" ? "ok" : p.ci === "red" ? "bad" : p.ci === "running" ? "warn" : "none"}"${p.ci === "running" ? " data-run" : ""}>${{ green: "Passing", red: "Failing", running: "Running", none: "No CI" }[p.ci]}</span></span></div>`).join("");
  const incidents = s.queue.issues.length
    ? s.queue.issues.map((i) => `<div class="incident"><h3><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></h3><p>${i.labels.map((l) => `<span class="tag ${l === "risky" ? "risky" : ""}">${esc(l)}</span>`).join("")}#${i.number} · opened ${ago(i.created_at)}</p></div>`).join("")
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
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  return page(`${s.repo} · hush`, `
    <header class="top">${LOGO}<span class="updated">${esc(s.repo)} · updated ${ago(s.generated_at)}</span></header>
    <div class="banner" data-s="${s.overall}">${s.overall === "ok" ? CHECK : ALERT}<span>${banner}</span></div>
    <p class="banner-sub">${s.affected.length ? `Affected: ${esc(s.affected.join(", "))}. ` : ""}${plural(s.counts.merged_24h, "PR")} merged in 24 h, ${s.counts.agent_merged_24h} by agents. ${s.queue.prs.length ? `${plural(s.queue.prs.length, "PR")} open.` : "No open PRs."}</p>

    ${onboarding ? `<section id="onboard" class="onboard"><h2>Finish setting up ${esc(s.repo)}</h2>${heartbeatSetup(origin, repoRow.ingest_key, true)}</section>` : ""}

    <section id="ci-live" aria-live="polite"><div class="live-head"><h2>Actions</h2><span class="live-dot"></span><span class="live-meta">Checking…</span></div></section>

    ${metrics}

    <h2>Monitors</h2>
    ${s.monitors.length ? `<div class="group grid2">${monRows}</div>` : `<div class="group"><div class="line"><span class="hint">No heartbeat yet.${onboarding ? " Finish the setup above." : ""}</span></div></div>`}

    <h2>Routines</h2>
    ${s.routines.length ? `<div class="group">${routineRows}</div>` : `<div class="group"><div class="line"><span class="hint">No routines found. Declare them in <code>.claude/factory.json</code>.</span></div></div>`}

    ${ci ? `<h2>CI · GitHub Actions</h2><div class="group grid2">${ci}</div>` : ""}
    ${prs ? `<h2>Open pull requests</h2><div class="group">${prs}</div>` : ""}

    <h2>Open issues</h2>
    <div class="incidents">${incidents}</div>

    <footer><span><a href="${repoUrl}" target="_blank" rel="noopener">${esc(s.repo)}</a> · ${plural(s.counts.heartbeats, "heartbeat")} in ${WINDOW} days${s.notes.length ? ` · ${esc(s.notes.join(" · "))}` : ""}</span><span>${repoRow && !onboarding ? `<a href="/r/${esc(s.repo)}/setup">Heartbeat setup</a> · ` : ""}${user ? `<a href="/">Your repos</a>` : ""}</span></footer>
  `, { live: true, stale });
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
  const body = JSON.stringify({ source: b.source === "session" ? "session" : "skill", window: b.window || "", swept: b.swept || {}, suppressed: b.suppressed ?? null, filed: (b.filed || []).map(Number).filter(Boolean), note: String(b.note || "").slice(0, 500) });
  db.prepare("INSERT OR IGNORE INTO heartbeats (repo, monitor, ts, status, body) VALUES (?, ?, ?, ?, ?)").run(repo, String(b.monitor).slice(0, 80), ts, status, body);
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const origin = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok", { "content-type": "text/plain" });
    if (url.pathname === "/install.sh") return send(res, 200, INSTALL.replaceAll("__ORIGIN__", origin), { "content-type": "text/x-shellscript; charset=utf-8" });

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

    const m = url.pathname.match(/^\/r\/([\w.-]+\/[\w.-]+?)(\.json|\/live|\/setup)?$/);
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
      if (m[2] === "/live") return json(res, 200, { ...(await readLive(await installationToken(row.installation_id), row.full_name)), beats: db.prepare("SELECT COUNT(*) n FROM heartbeats WHERE repo = ?").get(row.full_name).n });
      if (m[2] === "/setup") return send(res, 200, heartbeatPage(origin, row));
      let saved = db.prepare("SELECT at, body FROM snapshots WHERE repo = ?").get(row.full_name);
      if (saved && JSON.parse(saved.body).v !== SNAP_V) saved = null;
      const fresh = saved && Date.now() - saved.at < FRESH_MS;
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
