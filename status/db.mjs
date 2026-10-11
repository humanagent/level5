// Storage. Postgres (Neon) when DATABASE_URL is set, a local SQLite file otherwise, behind the
// same three async calls. SQL is written once, Postgres style ($1, $2 ... and ON CONFLICT); the
// SQLite driver rewrites $n to ?n, which SQLite reads as the same numbered parameter.
//
// Tenancy: an account is a GitHub user or organization that installed the app. Every repo
// belongs to one account and is keyed by its GitHub id (stable across renames and transfers),
// and every row of tenant data (heartbeats, costs, snapshots) carries repo_id. Nothing is ever
// read without a repo_id that the request was authorized for.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
  CREATE TABLE IF NOT EXISTS events (
    id ${pg ? "BIGSERIAL" : "INTEGER"} PRIMARY KEY, repo_id BIGINT NOT NULL, at TEXT NOT NULL, level TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, entity TEXT NOT NULL, dedupe TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events(repo_id, dedupe);
  CREATE INDEX IF NOT EXISTS events_repo_at ON events(repo_id, at);
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
  const lite = new DatabaseSync(join(dataDir, "hush.db"));
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
