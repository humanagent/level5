// Storage. Postgres (Neon) when DATABASE_URL is set, a local SQLite file otherwise, behind the
// same three async calls. SQL is written once, Postgres style ($1, $2 ... and ON CONFLICT); the
// SQLite driver rewrites $n to ?n, which SQLite reads as the same numbered parameter.
//
// Tenancy: an account is a GitHub user or organization that installed the app. Every repo
// belongs to one account and is keyed by its GitHub id (stable across renames and transfers),
// and every row of tenant data (heartbeats, costs, snapshots) carries repo_id. Nothing is ever
// read without a repo_id that the request was authorized for.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

// The local SQLite file. Servers set up under an earlier name of the product wrote it under that
// name: when level5.db is missing and the data dir holds exactly one other .db file, move it (with its
// WAL files) to level5.db once, so its data stays. factory.db is the first storage, which the server
// reads on its own (migrateLegacy), so it never counts.
export function liteFile(dataDir) {
  const file = join(dataDir, "level5.db");
  if (!existsSync(file) && existsSync(dataDir)) {
    const others = readdirSync(dataDir).filter((f) => f.endsWith(".db") && f !== "factory.db");
    if (others.length === 1) {
      const old = join(dataDir, others[0]);
      for (const x of ["", "-wal", "-shm"]) if (existsSync(old + x)) renameSync(old + x, file + x);
    }
  }
  return file;
}

const SCHEMA = (pg) => `
  CREATE TABLE IF NOT EXISTS accounts (
    id BIGINT PRIMARY KEY, login TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'User',
    installation_id BIGINT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    login TEXT PRIMARY KEY, token TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS repos (
    id BIGINT PRIMARY KEY, account_id BIGINT NOT NULL, full_name TEXT NOT NULL,
    installation_id BIGINT NOT NULL, ingest_key TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS repos_account ON repos(account_id);
  CREATE INDEX IF NOT EXISTS repos_name ON repos(full_name);
  CREATE TABLE IF NOT EXISTS heartbeats (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, repo_id BIGINT NOT NULL, monitor TEXT NOT NULL,
    ts TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS hb_unique ON heartbeats(repo_id, monitor, ts);
  CREATE INDEX IF NOT EXISTS hb_repo_ts ON heartbeats(repo_id, ts);
  CREATE TABLE IF NOT EXISTS costs (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, repo_id BIGINT NOT NULL, source TEXT NOT NULL,
    key TEXT NOT NULL, day TEXT NOT NULL, usd DOUBLE PRECISION, body TEXT NOT NULL, at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS cost_unique ON costs(repo_id, source, key);
  CREATE INDEX IF NOT EXISTS cost_repo_day ON costs(repo_id, day);
  CREATE TABLE IF NOT EXISTS snapshots (
    repo_id BIGINT PRIMARY KEY, at BIGINT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS marketing (
    repo_id BIGINT NOT NULL, source TEXT NOT NULL, day TEXT NOT NULL, campaign TEXT NOT NULL,
    spend DOUBLE PRECISION NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL, leads BIGINT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (repo_id, source, day, campaign));
  CREATE TABLE IF NOT EXISTS report_bodies (
    repo_id BIGINT NOT NULL, monitor TEXT NOT NULL, at TEXT NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL,
    PRIMARY KEY (repo_id, monitor));
  CREATE TABLE IF NOT EXISTS price_rules (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, repo_id BIGINT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_fired_at TEXT);
  CREATE INDEX IF NOT EXISTS price_rules_repo ON price_rules(repo_id);
  CREATE TABLE IF NOT EXISTS inventories (
    repo_id BIGINT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (repo_id, kind));
  CREATE TABLE IF NOT EXISTS events (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, repo_id BIGINT NOT NULL, at TEXT NOT NULL, level TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, entity TEXT NOT NULL, dedupe TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events(repo_id, dedupe);
  CREATE INDEX IF NOT EXISTS events_repo_at ON events(repo_id, at);
  CREATE TABLE IF NOT EXISTS automations (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, repo_id BIGINT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
    source TEXT NOT NULL, cron TEXT NOT NULL, command TEXT NOT NULL, model TEXT NOT NULL, skills TEXT NOT NULL,
    state TEXT NOT NULL, state_why TEXT NOT NULL, last_run_at TEXT, next_run_at TEXT,
    runs_30d INTEGER NOT NULL, missed_30d INTEGER NOT NULL, tokens_30d BIGINT NOT NULL, usd_30d DOUBLE PRECISION NOT NULL,
    secs_30d BIGINT NOT NULL, updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS automations_key ON automations(repo_id, key);
  CREATE TABLE IF NOT EXISTS automation_runs (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, automation_id BIGINT NOT NULL, repo_id BIGINT NOT NULL, at TEXT NOT NULL,
    status TEXT NOT NULL, origin TEXT NOT NULL, tokens BIGINT, usd DOUBLE PRECISION, secs BIGINT, note TEXT NOT NULL,
    url TEXT NOT NULL, dedupe TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_dedupe ON automation_runs(automation_id, dedupe);
  CREATE INDEX IF NOT EXISTS automation_runs_at ON automation_runs(automation_id, at);
  CREATE TABLE IF NOT EXISTS routine_triggers (
    repo_id BIGINT NOT NULL, routine TEXT NOT NULL, url TEXT NOT NULL, token TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_fired_at TEXT, last_fired_by TEXT,
    last_session_url TEXT, last_error TEXT, PRIMARY KEY (repo_id, routine));
  CREATE TABLE IF NOT EXISTS waitlist (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL,
    referrer TEXT NOT NULL, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT, ua TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email ON waitlist((lower(email)));
  CREATE TABLE IF NOT EXISTS landing_events (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, ts TEXT NOT NULL, anon_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL,
    href TEXT NOT NULL, section TEXT NOT NULL, path TEXT NOT NULL, referrer TEXT NOT NULL, utm_source TEXT, utm_medium TEXT,
    utm_campaign TEXT, utm_term TEXT, utm_content TEXT, vw INTEGER, ua TEXT NOT NULL, country TEXT);
  CREATE INDEX IF NOT EXISTS landing_events_ts ON landing_events(ts);
`;

export async function openDb({ url, dataDir }) {
  if (url) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { ssl: "require", max: 5, idle_timeout: 20, connect_timeout: 15, onnotice: () => {}, types: { bigint: postgres.BigInt } });
    // bigint columns come back as JS numbers: GitHub ids fit comfortably below 2^53.
    const num = (row) => (row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])) : row);
    const db = {
      kind: "postgres",
      all: async (q, ...p) => (await sql.unsafe(q, p)).map(num),
      one: async (q, ...p) => num((await sql.unsafe(q, p))[0]),
      run: async (q, ...p) => { await sql.unsafe(q, p); },
      close: () => sql.end({ timeout: 5 }),
    };
    for (const stmt of SCHEMA(true).split(";").map((x) => x.trim()).filter(Boolean)) await sql.unsafe(stmt);
    return db;
  }
  mkdirSync(dataDir, { recursive: true });
  const lite = new DatabaseSync(liteFile(dataDir));
  lite.exec("PRAGMA journal_mode = WAL;" + SCHEMA(false));
  // $n -> ?n, and drop Postgres casts (::int) that SQLite does not need
  const conv = (q) => q.replace(/\$(\d+)/g, "?$1").replace(/::[a-z]+/g, "");
  return {
    kind: "sqlite",
    all: async (q, ...p) => lite.prepare(conv(q)).all(...p),
    one: async (q, ...p) => lite.prepare(conv(q)).get(...p),
    run: async (q, ...p) => { lite.prepare(conv(q)).run(...p); },
    close: () => lite.close(),
  };
}
