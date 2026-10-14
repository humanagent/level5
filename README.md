# Type V

Observability for your software factory: whether every skill your agents run actually ran, and
what it cost. Open source under the [MIT license](LICENSE). It installs as a Claude Code plugin. Use the hosted one at
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

## Install

In Claude Code, once per machine:

```
/plugin install typev --marketplace humanagent/typev
```

Then sign in at https://factory-status.fly.dev, connect a repo, and run this at its root with the
ingest key the repo's page gives you:

```
/typev:setup <ingest-key>
```

It connects the repo, proposes monitors, a daily report and a pulse, and opens one PR. After the
merge, `/typev:setup routines` creates the Claude Code routines and runs each once. A self-hosted
instance adds `--url <its address>`.

## What it is made of

Type V has three parts. The plugin is how it gets into Claude Code. The runtime is what the plugin
writes into each repo, because routines run in cloud sessions on a fresh clone and a cloud session
does not load plugins: only what is committed reaches them. The server stores the heartbeats and
judges them.

### The plugin (`plugin/`, on your machine)

| Component | Kind | What it does |
| --- | --- | --- |
| `.claude-plugin/plugin.json` | manifest | Name, version, MIT, and two settings (`userConfig`) |
| `band` | setting | When the status shows above the prompt: `problems` (default), `always`, `off` |
| `key` | setting, kept in the keychain | The ingest key, only for a repo that does not commit `.claude/typev.json` |
| `skills/setup/` | skill | `/typev:setup`: connects the repo, proposes the factory, opens one PR, creates the routines after the merge |
| `skills/new-monitor/` | skill | `/typev:new-monitor`: one more monitor (logs, costs, LLM traces, any source) from one line, in its own PR |
| `hooks/register.tsx` | mod | A band above the prompt with the monitors that need a look (stopped, late, degraded, "said ok, read nothing"), silent when all is clear; a toast when a session starts with one; `/typev` prints the repo's state |
| `workflows/sweep.js` | workflow | `/typev:sweep`: runs the repo's monitors now; two skeptics try to refute every finding before it is filed |
| `workflows/mend.js` | workflow | `/typev:mend`: the fixer. Per open `typev:*` issue: the five gates, a regression test that fails, the smallest fix, one PR, and a skeptic who reruns the test without the fix. Never merges |
| `templates/` | files | The monitor, report and pulse `/typev:setup` copies into a repo |
| `runtime/` | files | The heartbeat hook and skill `/typev:setup` copies into a repo |

`.claude-plugin/marketplace.json` at the repo root makes this repo the `typev` marketplace.

### The runtime (in each repo, written by `/typev:setup`)

| Component | Kind | What it does |
| --- | --- | --- |
| `.claude/hooks/typev.sh` | script | `beat`, `cost` and `session-end`. Detached, 5 s cap, never fails the caller; `TYPEV_DISABLED=1` turns it off |
| `SessionEnd` in `.claude/settings.json` | hook | When a routine ends: its tokens by model, and a heartbeat named after the command it ran |
| `.claude/typev.json` | config | `{ "url", "key" }`. The key only posts this repo's heartbeats and costs and reads its daily summary. `TYPEV_URL` and `TYPEV_KEY` override it |
| `.claude/factory.json` | config | The roster: each monitor and routine, with its schedule ([docs](docs/factory-json.md)) |
| `.claude/skills/typev/` | skill | Teaches any skill to end with its heartbeat: `typev.sh beat <id> ok '{"swept":{"events":120}}'` |
| `.claude/skills/typev-monitor-errors/` | skill on a routine | Sentry: an issue per new or regressed error worth a look |
| `.claude/skills/typev-report/` | skill on a routine | The day as one GitHub issue, closing the one before |
| `.github/workflows/typev-pulse.yml` | GitHub Action | The monitor of the monitors: an issue per monitor that stopped, ran late or said ok after reading nothing. It runs apart from the routines on purpose |

### The server (`status/`, https://factory-status.fly.dev)

| Path | What |
| --- | --- |
| `status/server.mjs` | The app: GitHub App auth, readers, judging rules, assistant, HTML, routes, `POST /api/heartbeat`, `POST /api/cost`, `GET /api/report`. |
| `status/db.mjs` | Storage: Postgres (Neon) with `DATABASE_URL`, local SQLite otherwise. Multi-tenant schema. |
| `status/landing.mjs` | The public landing at `/`. |
| `status/report.mjs` | The daily factory report, as an email and as data. |
| `status/install.sh` | Served at `/install.sh`: says Type V installs as a plugin, and how. |
| `status/Dockerfile`, `status/fly.toml` | Fly app `factory-status`, region `gru`, volume `factory_data` on `/data`. |
| `index.html`, `PRODUCT.md`, `.impeccable/` | The earlier landing prototype (a claude.ai artifact) and its product brief. |

GitHub comes in through a read-only GitHub App (contents, issues, pull requests, actions, checks,
metadata). Users sign in with the app's OAuth and see only the repos their installations cover.

## Docs

- [Heartbeats](docs/heartbeats.md): the API, connecting a repo, the `SessionEnd` hook, isolation guarantees.
- [`.claude/factory.json`](docs/factory-json.md): declaring monitors and routines.
- [`/typev:setup`](docs/setup.md): building the factory in one PR, as new typev-* skills, workflows and routines.
- [Costs](docs/costs.md): tokens per Claude Code session, daily spend per provider.
- [Security](docs/security.md): AWS IAM and Infisical secret names, and the findings.
- [Daily factory report](docs/report.md): one email with everything that happened in the factory that day.
- [Automations](docs/automations.md): each scheduled job as one stored object, its runs, state and calendar.
- [How Type V judges](docs/judging.md): schedules, skill bars, monitor states, Status, Reports, CI, promotions.
- [Architecture](docs/architecture.md): storage, page loading, routes, security model, operations, known gaps.

## Plugin dev

```sh
claude --plugin-dir ./plugin     # a session with the plugin loaded from this folder
claude plugin validate ./plugin  # what it hooks and calls, and anything Claude Code would refuse
claude plugin test ./plugin      # the mod's tests
```

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
