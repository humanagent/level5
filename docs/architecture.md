# Architecture

One Node 24 process on Fly (`factory-status`, region `gru`). Storage is Postgres on Neon when
`DATABASE_URL` is set, and a local SQLite file (`/data/hush.db`) otherwise, behind the same calls
(`db.mjs`). The only dependency is the `postgres` driver.

## Tenancy

- An **account** is a GitHub user or organization that installed the app (`accounts.id` is the
  GitHub account id).
- A **repo** belongs to one account and is keyed by its GitHub repo id, so a rename, a transfer or
  a reinstall keeps its history and its ingest key. Name, account and installation are refreshed
  from GitHub on every visit.
- Every row of tenant data (`heartbeats`, `costs`, `snapshots`) carries `repo_id`, and nothing is
  read without a `repo_id` the request was authorized for:
  - pages and the assistant: the signed-in user's own GitHub installations must cover the repo;
  - ingest: the bearer ingest key resolves to exactly one repo.
- Caches (GitHub reads, installation tokens, snapshots in flight) are keyed per repo or per
  installation, never shared across tenants.
- Ingest is capped at 500 items and 2 MB per request; the assistant at 40 questions per user per hour.

## Pieces

| Piece | Where |
| --- | --- |
| GitHub App auth: manifest setup, app JWT, installation tokens, user OAuth | `server.mjs`, "GitHub App" |
| Readers: factory files, CI, metrics, queue, live Actions | `readFactory`, `readCi`, `readMetrics`, `readQueue`, `readLive` |
| Judging | `judge`, `routineState`, `snapshot` ([judging.md](judging.md)) |
| HTML | `statusPage` (a left-nav app: Overview, Monitors, Automations, CI, Pull requests, Issues, Costs, Setup, one view per URL hash), `skeletonPage`, `heartbeatSetup`, `landing.mjs` |
| Heartbeat client | `install.sh` ([heartbeats.md](heartbeats.md)) |

## Storage

| Table | What |
| --- | --- |
| `accounts` | GitHub users and organizations that installed the app. |
| `users` | GitHub login and their OAuth token, sealed (AES-GCM keyed by `SECRET`). |
| `repos` | Repos opened at least once, by GitHub id: account, name, installation, ingest key. |
| `heartbeats` | Every heartbeat. Unique on `(repo_id, monitor, ts)`. |
| `costs` | Daily provider spend and per-session Claude Code tokens. Unique on `(repo_id, source, key)`. |
| `snapshots` | The last full snapshot per repo, so a page opens instantly. Versioned by `SNAP_V`. |
| `settings` | The GitHub App's credentials (id, slug, private key, OAuth secret), sealed. |

## Loading a repo page

1. Auth: the session cookie names the user; their installations (cached 3 min) must cover the repo.
2. If a snapshot is stored, the page renders from it at once. If it is older than 60 s, the page is
   marked stale and fetches `?partial=1` in the background, then swaps in the fresh render.
3. With no snapshot yet, a skeleton renders at once and the first read runs in the background.
4. A snapshot is one GitHub read per repo at a time (concurrent requests share it). Readers keep
   their own caches: factory files, CI and metrics 10 min, the queue 1 min, live Actions 6 s.
5. The page refreshes itself every 2 minutes and when the tab regains focus. Open sections stay open.

The live Actions panel polls `/r/<repo>/live` every 8 s while a run is in progress (or while
onboarding waits for its first heartbeat) and every 30 s otherwise. When a run finishes, the rest
of the page refreshes.

## Routes

| Route | What |
| --- | --- |
| `GET /` | Landing when signed out; signed in, every repo they can see, grouped by account, with its state, monitors, PRs merged, CI pass rate and spend. |
| `GET /r/<owner>/<repo>` | The status page. `?partial=1` is the page's own background refresh. |
| `GET /r/<owner>/<repo>.json` | The snapshot as JSON. |
| `GET /r/<owner>/<repo>/live` | Live Actions plus the heartbeat count. |
| `GET /r/<owner>/<repo>/setup` | Heartbeat setup for the repo. |
| `POST /r/<owner>/<repo>/ask` | The assistant: streams an answer as plain text. |
| `POST /api/heartbeat` | Heartbeat ingest ([heartbeats.md](heartbeats.md)). |
| `POST /api/cost` | Cost ingest ([costs.md](costs.md)). |
| `GET /install.sh` | The installer, with this origin filled in. |
| `GET /setup?t=SETUP_TOKEN` | One-time GitHub App creation from a manifest. |
| `GET /auth/login`, `/auth/callback`, `POST /logout` | Sign in with GitHub. |
| `GET /healthz` | Health check. |

## Security model

- **Read-only on GitHub.** The app asks for read access to contents, issues, pull requests,
  actions, checks and metadata, and nothing else. Hush never writes to a repo.
- **No personal tokens stored for reads.** Reads use short-lived installation tokens. The user's
  OAuth token is only used to list which installations they can see.
- **A user sees a repo only if one of their installations covers it.**
- **Ingest keys can only write heartbeats** for their one repo.
- Secrets at rest are sealed with `SECRET`. Losing `SECRET` means re-creating the app via `/setup`.

## Assistant

A section of the repo page. Each question is one OpenRouter call (`HUSH_MODEL`, default
`openai/gpt-6.1-sol`) whose system prompt carries everything Hush has on the repo: the snapshot,
30 days of heartbeats with their notes and volumes, the cost rows, and a one-line summary of every
other repo the person can see. The conversation lives in the page only; nothing is stored.

## Moving storage

On start-up Hush brings older data forward, once each:

- from the first storage (`/data/factory.db`, keyed by repo name), resolving names to GitHub ids;
- when running on Postgres, from the local `/data/hush.db` collected before the switch.

## Operations

- Deploy: `cd status && fly deploy -a factory-status`.
- Secrets: `SECRET` and `SETUP_TOKEN` (required), `DATABASE_URL` (Neon), `OPENROUTER_API_KEY`
  and optionally `HUSH_MODEL` (the assistant). Set with `fly secrets set NAME=value -a factory-status`.
- Logs: `fly logs -a factory-status`.
- The machine auto-stops when idle; the first request after that pays a cold start, which the
  stored snapshots hide.

## Known gaps

- **Backups depend on the storage.** On Neon they come with it; on the local SQLite there are none.
- **No alerts.** Hush shows state; it does not notify yet.
- **No deploy pipeline.** Deploys are manual `fly deploy`.
- The GitHub App is still named "Factory Status …" and the domain is `factory-status.fly.dev`.
