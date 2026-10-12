# hush

Observability for your software factory: whether every skill your agents run actually ran, and
what it cost. Open source under the [MIT license](LICENSE). Use the hosted one at
https://factory-status.fly.dev or [run your own](#run-and-deploy).

## What it shows per repo

Every section opens with its own unit per day.

- **Status**: only what needs a look (skills that missed or degraded, failing CI, late routines,
  firing price rules, critical security findings), then costs and the last 30 days.
- **Monitors**: each skill's heartbeats, judged against its own schedule: operational, degraded,
  chronically degraded, "said ok, read nothing", missed, down, or no heartbeat yet.
- **Automations**: the week as a calendar in your time zone, one block per scheduled run, coloured by
  what happened. Each automation is one stored object with its state, runs, tokens, cost and time
  ([docs/automations.md](docs/automations.md)).
- **CI**: minutes per day by workflow, every workflow's 30-day bars, and what is waiting for
  production.
- **Pull requests**: lines added and removed per day; open (with CI), merged (with their size) and
  closed.
- **Issues**: opened and closed per day, and what is open.
- **Costs**: price rules written as sentences, then daily spend per provider and service, and tokens
  per Claude Code session.
- **Reports**: what the weekly routines delivered, week by week, and the latest report.
- **Services**: the factory as a city, one building per service sized by spend.

Around it: **Actions** in the top bar (runs in progress and the latest finished), **Ask** (an
assistant panel that reads all of the above), the bell (notifications), **Settings** (your time
zone), and **Repositories** (every repo you can see, by account, side by side).

## How the data gets in

- **GitHub**: a read-only GitHub App (contents, issues, pull requests, actions, checks, metadata).
  Users sign in with the app's OAuth and see only the repos their installations cover.
- **Heartbeats**: `POST /api/heartbeat` with the repo's ingest key. The installer sets it up:

  ```sh
  curl -fsSL https://factory-status.fly.dev/install.sh | sh -s -- <ingest-key>
  ```

  It adds `.claude/hooks/hush.sh` and a `SessionEnd` hook, so every Claude Code cloud routine that
  runs a slash command reports itself when it ends. A skill can also send its own status and
  volume with `.claude/hooks/hush.sh beat <id> ok '{"swept":{"events":120}}'`. The post is
  detached with a 5 s cap and never fails or slows the caller; `HUSH_DISABLED=1` turns it off.

## Docs

- [Heartbeats](docs/heartbeats.md): the API, the installer, the `SessionEnd` hook, isolation guarantees.
- [`.claude/factory.json`](docs/factory-json.md): declaring monitors and routines.
- [Costs](docs/costs.md): tokens per Claude Code session, daily spend per provider.
- [Security](docs/security.md): AWS IAM and Infisical secret names, and the findings.
- [Daily factory report](docs/report.md): one email with everything that happened in the factory that day.
- [Automations](docs/automations.md): each scheduled job as one stored object, its runs, state and calendar.
- [How Hush judges](docs/judging.md): schedules, skill bars, monitor states, Status, Reports, CI, promotions.
- [Architecture](docs/architecture.md): storage, page loading, routes, security model, operations, known gaps.

## Layout

| Path | What |
| --- | --- |
| `status/server.mjs` | The app: GitHub App auth, readers, judging rules, assistant, HTML, routes. |
| `status/db.mjs` | Storage: Postgres (Neon) with `DATABASE_URL`, local SQLite otherwise. Multi-tenant schema. |
| `status/landing.mjs` | The public landing at `/`. |
| `status/install.sh` | The one-line installer, served at `/install.sh` with the origin filled in. |
| `status/Dockerfile`, `status/fly.toml` | Fly app `factory-status`, region `gru`, volume `factory_data` on `/data`. |
| `index.html`, `PRODUCT.md`, `.impeccable/` | The earlier landing prototype (a claude.ai artifact) and its product brief. |

## Local dev

```sh
cd status && npm install
npm run dev        # http://localhost:8787, restarts on save
```

`status/.env.local` (not in git) sets `DATABASE_URL` to the Neon branch `dev`, a copy of production,
plus `DEV_USER` and `OPENROUTER_API_KEY`. In dev mode you are signed in as `DEV_USER`, GitHub is read
with your own `gh auth token` instead of the GitHub App, and nothing is migrated. It never turns on
in production (`NODE_ENV=production` in the image). To refresh the copy, reset the `dev` branch from
`main` in Neon.

## Run and deploy

```sh
cd status
npm install
DATA_DIR=./data SECRET=dev SETUP_TOKEN=dev node server.mjs   # http://localhost:8080, SQLite
# DATABASE_URL=postgres://... for Neon, OPENROUTER_API_KEY=... for the assistant
fly deploy -a factory-status
```

Secrets on Fly: `SECRET` (seals the stored app credentials and signs sessions) and `SETUP_TOKEN`
(guards `/setup`, which creates the GitHub App once from a manifest). The app's credentials live
sealed in SQLite, not in env.
