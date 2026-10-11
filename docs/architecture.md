# Architecture

One Node 24 process, no dependencies, one SQLite file. Runs on Fly (`factory-status`, region `gru`,
a 1 GB volume on `/data`).

## Pieces

| Piece | Where |
| --- | --- |
| GitHub App auth: manifest setup, app JWT, installation tokens, user OAuth | `server.mjs`, "GitHub App" |
| Readers: factory files, CI, metrics, queue, live Actions | `readFactory`, `readCi`, `readMetrics`, `readQueue`, `readLive` |
| Judging | `judge`, `routineState`, `snapshot` ([judging.md](judging.md)) |
| HTML | `statusPage` (a left-nav app: Overview, Monitors, Automations, CI, Pull requests, Issues, Costs, Setup, one view per URL hash), `skeletonPage`, `heartbeatSetup`, `landing.mjs` |
| Heartbeat client | `install.sh` ([heartbeats.md](heartbeats.md)) |

## Storage (`/data/factory.db`)

| Table | What |
| --- | --- |
| `users` | GitHub login and their OAuth token, sealed (AES-GCM keyed by `SECRET`). |
| `repos` | Repos opened at least once: installation id and ingest key. |
| `heartbeats` | Every heartbeat. Unique on `(repo, monitor, ts)`. |
| `costs` | Daily provider spend and per-session Claude Code tokens. Unique on `(repo, source, key)`. |
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
| `GET /` | Landing when signed out; the user's repos when signed in. |
| `GET /r/<owner>/<repo>` | The status page. `?partial=1` is the page's own background refresh. |
| `GET /r/<owner>/<repo>.json` | The snapshot as JSON. |
| `GET /r/<owner>/<repo>/live` | Live Actions plus the heartbeat count. |
| `GET /r/<owner>/<repo>/setup` | Heartbeat setup for the repo. |
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

## Operations

- Deploy: `cd status && fly deploy -a factory-status`.
- Secrets: `fly secrets set SECRET=... SETUP_TOKEN=...`.
- Logs: `fly logs -a factory-status`.
- The machine auto-stops when idle; the first request after that pays a cold start, which the
  stored snapshots hide.

## Known gaps

- **No backups.** Everything is one SQLite file on one volume. Litestream to S3 or R2 is the
  planned fix.
- **No alerts.** Hush shows state; it does not notify yet.
- **No deploy pipeline.** Deploys are manual `fly deploy`.
- The GitHub App is still named "Factory Status …" and the domain is `factory-status.fly.dev`.
