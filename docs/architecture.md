# Architecture

One Node 24 process on Fly (`factory-status`, region `gru`). Storage is Postgres on Neon when
`DATABASE_URL` is set, and a local SQLite file (`/data/level5.db`) otherwise, behind the same calls
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
| Automations | `syncAutomations` ([automations.md](automations.md)) |
| HTML | `statusPage` (a left-nav app, one view per URL hash: Status, Monitors, Automations, CI, Pull requests, Issues, Costs, Reports, Services, Setup), `skeletonPage`, `heartbeatSetup`, `landing.mjs` |
| Heartbeat client | `plugin/runtime/hooks/level5.sh`, written into each repo by `/level5:setup` ([heartbeats.md](heartbeats.md)) |

## Storage

| Table | What |
| --- | --- |
| `accounts` | GitHub users and organizations that installed the app. |
| `users` | GitHub login and their OAuth token, sealed (AES-GCM keyed by `SECRET`). |
| `repos` | Repos opened at least once, by GitHub id: account, name, installation, ingest key. |
| `heartbeats` | Every heartbeat. Unique on `(repo_id, monitor, ts)`. |
| `costs` | Daily provider spend and per-session Claude Code tokens. Unique on `(repo_id, source, key)`. |
| `snapshots` | The last full snapshot per repo, so a page opens instantly. Versioned by `SNAP_V`. |
| `price_rules` | Cost alarms per repo: name, config (provider, measure, period, condition, limits, days, dates, severity), enabled. |
| `inventories` | Security inventory per repo and kind (`aws-iam`, `infisical`): names and metadata only. |
| `automations` | One row per scheduled job: state, schedule, command, skills, 30-day runs, misses, tokens, cost, time. Unique on `(repo_id, key)`. |
| `automation_runs` | Each run of an automation: when, status, origin, tokens, cost, duration, note, link. Unique on `(automation_id, dedupe)`. |
| `events` | Notifications: one row per change (monitor state, late routine, CI broken or fixed, PR opened or merged, issue opened, spend jump). Unique on `(repo_id, dedupe)`. |
| `waitlist` | Landing waitlist: email (unique on `lower(email)`), when, which form, referrer, utm, user agent. Not tenant data. |
| `landing_events` | The landing's own analytics: view, click, scroll and waitlist beacons with an anonymous id, label, href, section, path, referrer, utm, viewport width, user agent, country (only behind a geo header). Not tenant data. |
| `settings` | The GitHub App's credentials (id, slug, private key, OAuth secret), sealed; each person's time zone (`tz:<login>`); replaced ingest keys during their 24 h grace (`prevkey:<sha256>`). |

## Loading a repo page

1. Auth: the session cookie names the user; their installations (cached 3 min) must cover the repo.
2. If a snapshot is stored, the page renders from it at once. If it is older than 60 s, the page is
   marked stale and fetches `?partial=1` in the background, then swaps in the fresh render.
3. With no snapshot yet, a skeleton in the real app shell renders at once and the first read runs in
   the background; the page reloads itself once the snapshot is ready, so every script loads.
4. A snapshot is one GitHub read per repo at a time (concurrent requests share it). Readers keep
   their own caches: factory files, CI and metrics 10 min, the queue 1 min, live Actions 6 s.
5. The page refreshes itself every 2 minutes and when the tab regains focus. Open sections stay open.

The **Actions** button in the top bar polls `/r/<repo>/live` every 8 s while a run is in progress
(or while onboarding waits for its first heartbeat) and every 30 s otherwise: a spinner and a count
while runs are going, the last result otherwise, and a dropdown with the running jobs and the latest
finished runs. When a run finishes, the rest of the page refreshes.

HTML is served `no-store`, so a browser never shows an old build of a page.

## Routes

| Route | What |
| --- | --- |
| `GET /` | Landing when signed out; signed in, every repo they can see, grouped by account, with its state, monitors, PRs merged, CI pass rate and spend. |
| `GET /r/<owner>/<repo>` | The status page. `?partial=1` is the page's own background refresh. |
| `GET /r/<owner>/<repo>.json` | The snapshot as JSON. |
| `GET /api/notifications`, `POST` | The signed-in person's notifications; POST marks them read. |
| `GET /r/<owner>/<repo>/live` | Live Actions plus the heartbeat count. |
| `GET /r/<owner>/<repo>/setup` | Heartbeat setup for the repo. |
| `POST /r/<owner>/<repo>/key` | Replace the repo's ingest key (same-site form post); the old one works 24 h more. |
| `GET /r/<owner>/<repo>/triggers`, `POST` | The routines that can be run from Level 5; POST saves or removes one's API trigger (same-site only). The token is sealed and never sent back. |
| `POST /r/<owner>/<repo>/fire` | Run a routine now through its API trigger, with an optional text for the run (same-site only). |
| `POST /r/<owner>/<repo>/rules` | Create, edit, pause or delete a price rule; `{text}` makes one from a sentence. |
| `GET /settings`, `POST` | The signed-in person's settings: their time zone. |
| `GET /r/<owner>/<repo>/report?day=YYYY-MM-DD` | The daily factory report for one UTC day (default yesterday), as the email renders it. |
| `GET /landing` | The landing, also when signed in (it then says Enter instead of Sign in). In dev, `?out=1` shows it signed out. |
| `POST /api/waitlist` | Join the waitlist: JSON `{email, source}` answers JSON; a plain form post redirects back with `?joined=1` (or `already`, `invalid`, `busy`). Same-site, 10 per IP per hour, a honeypot field. |
| `POST /api/track` | The landing's beacons (4 KB, bots dropped, 600 per IP per hour). Always 204. |
| `GET /admin/landing`, `/admin/landing/waitlist.csv` | Views, visitors, funnel, clicks, referrers, campaigns, scroll depth and the waitlist, for `ADMIN_LOGINS` (and `DEV_USER` in dev). |
| `POST /r/<owner>/<repo>/ask` | The assistant: streams an answer as plain text. |
| `POST /api/heartbeat` | Heartbeat ingest ([heartbeats.md](heartbeats.md)). |
| `POST /api/cost` | Cost ingest ([costs.md](costs.md)). |
| `POST /api/inventory` | Security inventory ingest ([security.md](security.md)). |
| `GET /install.sh` | Says Level 5 installs as a Claude Code plugin, and how. |
| `GET /setup?t=SETUP_TOKEN` | One-time GitHub App creation from a manifest. |
| `GET /auth/login`, `/auth/callback`, `POST /logout` | Sign in with GitHub. |
| `GET /healthz` | Health check. |

## Security model

- **Read-only on GitHub.** The app asks for read access to contents, issues, pull requests,
  actions, checks and metadata, and nothing else. Level 5 never writes to a repo.
- **No personal tokens stored for reads.** Reads use short-lived installation tokens. The user's
  OAuth token is only used to list which installations they can see.
- **A user sees a repo only if one of their installations covers it.**
- **Ingest keys can only write heartbeats and costs** for their one repo, and can be replaced.
- Secrets at rest are sealed with `SECRET`. Losing `SECRET` means re-creating the app via `/setup`.

## Notifications

The bell in the top bar. Every time a repo's snapshot is refreshed, Level 5 compares it with the
previous one and records what changed as events. A background job refreshes every repo opened in
the last 7 days every 10 minutes, so events accrue between visits (while the machine is awake).
Each person sees the events of every repo their installations cover; opening the panel marks them
read. An entry links to the repo and opens the entity's window.

## Time zone

Everything is stored and computed in UTC. Each person picks a time zone in Settings (default: the
browser's), and the page prints schedules, the week calendar, missed-run labels and exact times in
it; hovering shows the UTC original. Per-day charts still group by UTC day.

## Floating windows

Clicking a monitor, automation, workflow, pull request or issue opens it in its own window, after the
admin's PanelHost: one window per entity, drag by the title bar, resize from any edge, cascade from
the right, focus on click, minimize to a dock, no zoom, no scrim. Windows survive section changes
and background refreshes, and the open set is in the URL (`?w=`).

## Assistant

A panel on the right of the repo page, opened from Ask in the top bar; it stays open across sections
and refreshes, and the page makes room for it. It is also where price rules are made: it has tools to
create, list and delete them ([costs.md](costs.md)). Each question is one OpenRouter call (`LEVEL5_MODEL`, default
`openai/gpt-6.1-sol`) whose system prompt carries everything Level 5 has on the repo: the snapshot,
30 days of heartbeats with their notes and volumes, the cost rows, and a one-line summary of every
other repo the person can see. The conversation lives in the page only; nothing is stored.

## Moving storage

On start-up Level 5 brings older data forward, once each:

- from the first storage (`/data/factory.db`, keyed by repo name), resolving names to GitHub ids;
- when running on Postgres, from the local `/data/level5.db` collected before the switch.

## Operations

- Deploy: `cd status && fly deploy -a factory-status`.
- Secrets: `SECRET` and `SETUP_TOKEN` (required), `DATABASE_URL` (Neon), `OPENROUTER_API_KEY`
  and optionally `LEVEL5_MODEL` (the assistant) and `ADMIN_LOGINS` (comma-separated GitHub logins that can read `/admin/landing`). Set with `fly secrets set NAME=value -a factory-status`.
- Logs: `fly logs -a factory-status`.
- The machine auto-stops when idle; the first request after that pays a cold start, which the
  stored snapshots hide.

## Known gaps

- **Backups depend on the storage.** On Neon they come with it; on the local SQLite there are none.
- **Notifications only in the app.** The bell and price rules notify inside Level 5; nothing is sent
  by email or chat yet.
- **Per-day charts are UTC days**, whatever the viewer's time zone.
- **No deploy pipeline.** Deploys are manual `fly deploy`.
- The GitHub App is still named "Factory Status …" and the domain is `factory-status.fly.dev`.
