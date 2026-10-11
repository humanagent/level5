# hush

A status page for a software factory: the monitors, Claude Code routines, CI and queue of every
repo you pick, on one page. Live at https://factory-status.fly.dev.

## What it shows per repo

- **Monitors**: heartbeats from the skills that run on a routine, judged as operational, degraded,
  chronically degraded, "said ok, read nothing", or down. 30 daily bars, or 12 weekly bars for
  weekly monitors.
- **Routines**: declared in `.claude/factory.json` (or the older `cloud-routine.md` table), plus
  scheduled GitHub Actions, with their next run and the evidence that the last one ran.
- **Actions, live**: runs in progress with their jobs, the current step and ticking timers, and
  the last runs that finished.
- **Last 30 days**: PRs merged (and the share merged by agents), median time to merge, issues
  closed against opened, CI pass rate, merges per day.
- **CI**: every active workflow with 30 days of pass/fail bars.
- **Costs**: daily spend per provider (AWS, Vercel, Neon...) and tokens per Claude Code session.
- **Pull requests**: open (with CI), merged and closed, and open issues.

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
- [How Hush judges](docs/judging.md): monitor states, routine evidence, the banner, CI and metrics.
- [Architecture](docs/architecture.md): storage, page loading, routes, security model, operations, known gaps.

## Layout

| Path | What |
| --- | --- |
| `status/server.mjs` | The whole app: GitHub App auth, readers, judging rules, HTML, routes. Node 24, `node:sqlite`, no dependencies. |
| `status/landing.mjs` | The public landing at `/`. |
| `status/install.sh` | The one-line installer, served at `/install.sh` with the origin filled in. |
| `status/Dockerfile`, `status/fly.toml` | Fly app `factory-status`, region `gru`, volume `factory_data` on `/data`. |
| `index.html`, `PRODUCT.md`, `.impeccable/` | The earlier landing prototype (a claude.ai artifact) and its product brief. |

## Run and deploy

```sh
cd status
DATA_DIR=./data SECRET=dev SETUP_TOKEN=dev node server.mjs   # http://localhost:8080
fly deploy -a factory-status
```

Secrets on Fly: `SECRET` (seals the stored app credentials and signs sessions) and `SETUP_TOKEN`
(guards `/setup`, which creates the GitHub App once from a manifest). The app's credentials live
sealed in SQLite, not in env.
