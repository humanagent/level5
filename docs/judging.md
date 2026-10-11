# How Hush judges

All times are UTC. Every rule here lives in `judge()`, `routineState()` and `snapshot()` in
`status/server.mjs`.

## Monitors

Evaluated in this order; the first that matches wins.

| State | Rule |
| --- | --- |
| **Down** | No heartbeat within `max_silence_hours` (or none in the window at all). |
| **Said ok, read nothing** | The last heartbeat is `ok` with `swept[volume_key] = 0`, unless `zero_ok`. |
| **Chronically degraded** | At least 4 runs in the last 14 days and more than 30% of them not `ok`. Catches a monitor that flips between good and bad days, which no single-run rule sees. |
| **Chronically degraded** | The last two runs were both not `ok`. |
| **Degraded** | The last run was not `ok`. |
| **Retired** | Not in the roster and silent past its window. Shown, but never counts against the repo. |
| **Operational** | Anything else. |

Bars: one per day (daily) or per week (weekly), coloured by the worst status in that bucket:
green `ok`, amber `degraded`, red `skipped`, grey no run. The percentage is ok buckets over buckets
that ran.

## Routines

The last run is the newest of:

1. a heartbeat from a monitor whose `routine` is this routine, or from a monitor whose id is the
   routine's slash command;
2. a session heartbeat matching the routine's slash command (see [factory-json.md](factory-json.md));
3. for routines with no heartbeat at all: the last merged PR from a matching branch (`pr-sweep` or
   `review` for review routines, `audit` for audit routines);
4. for GitHub Actions routines: the last run of that workflow.

A routine is **late** when its last run is older than 1.25 × its cron period + 2 h.

## The banner

| Banner | When |
| --- | --- |
| Monitors need attention (red) | Any monitor Down, Said ok read nothing, or Chronically degraded. |
| Degraded performance (amber) | Any monitor Degraded, any routine late, or the latest run of any workflow failed. |
| All systems operational (green) | Otherwise. |

## CI

Each active workflow gets 30 daily bars from its completed runs: green when every run that day
passed, amber when some failed, red when all failed, grey with no runs. Reads stop at 600 runs per
workflow (shown as `600+`).

## Last 30 days

From GitHub search and the merged PR list:

- **PRs merged**, and the share merged from agent branches: `claude/`, `codex/`, `agent/`,
  `fix/pr-sweep`, `fix/issue-`, `fix-issues`, `audit`.
- **Median time to merge**, and PRs closed without merging.
- **Issues closed / opened**, open count and median age of open issues.
- **CI pass rate** over all completed runs, and the workflows failing right now.

## Promotions

Under CI. A repo that promotes code from an integration branch to production (staging → main,
develop → master…) does it with pull requests into the production branch. Hush finds the two
branches by name (or from `"promotion": {"from": "staging", "to": "main"}` in `.claude/factory.json`)
and shows: time since the last promotion and how long it took to merge, the commits waiting on the
integration branch (from GitHub's compare, with their PRs), promotions in 30 days and the median gap,
the open promotion PR with its CI, recent promotions, and the latest run of each workflow on the
production branch. A promotion PR is one into production from the integration branch or from a
branch named like `merge/`, `promote` or `release`. A new promotion, opened or merged, is a
notification. A repo with a single branch has no promotions and says so.
