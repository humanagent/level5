# How Level 5 judges

Everything is stored and computed in UTC; the page prints times in the viewer's time zone (see
Settings in [architecture.md](architecture.md)). The rules live in `judge()`, `readSkills()`,
`routineState()`, `syncAutomations()` and `snapshot()` in `status/server.mjs`.

## Schedules

A skill or routine is judged against its own cron. The silence it tolerates is the **longest gap
between two runs** of its schedule over the next two weeks, × 1.25, + 6 h:

| Schedule | Longest gap | Alarm after |
| --- | --- | --- |
| daily | 24 h | 36 h of silence |
| weekdays only | 72 h (Friday to Monday) | 96 h |
| weekly | 168 h | 9 days |
| monthly | about 30 days | about 38 days |

`max_silence_hours` in `.claude/factory.json` overrides it. Without a cron, the declared cadence
decides: 50 h for daily, 200 h for weekly.

## Skills (Status and Monitors)

One row per skill. Weekly skills get 12 weekly bars, the rest 30 daily bars. A bar is:

| Bar | When |
| --- | --- |
| green | it ran and read something |
| amber | it ran but came back degraded or skipped, or said ok and read nothing (`swept[volume_key] = 0`, unless `zero_ok`) |
| red | its routine's cron fired in that bucket (or, without a routine, a past day for a daily skill) and nothing arrived |
| grey | nothing was expected: no schedule that day, or before the skill's first heartbeat |

Missed runs are judged on **the last run that was due**, not on today's bar: after midnight UTC
today has nothing due yet, and yesterday's miss still counts.

## Monitors

Evaluated in this order; the first that matches wins.

| State | Rule |
| --- | --- |
| **No heartbeat yet** | Level 5 has never heard from it. Grey, not an alert. |
| **Down** | No heartbeat within its tolerance (see Schedules). |
| **Said ok, read nothing** | The last heartbeat is `ok` with `swept[volume_key] = 0`, unless `zero_ok`. |
| **Chronically degraded** | At least 4 runs in the last 14 days and more than 30% of them not `ok`; or the last two runs both not `ok`. |
| **Degraded** | The last run was not `ok`. |
| **Missed the last run** | Otherwise healthy, but the last scheduled run did not arrive. |
| **Retired** | Not in the roster and silent past its window. Shown, never counts against the repo. |
| **Operational** | Anything else. |

## Automations

See [automations.md](automations.md). A GitHub Actions schedule is judged by its workflow's runs.

## Status

Status shows only what needs a look, then costs and the last 30 days:

- skills that missed their last run, are degraded, often degraded or read nothing;
- CI workflows whose latest run failed;
- routines that are late (no run within their tolerance) and have no skill row saying so already;
- price rules that are firing;
- critical or high security findings (see [security.md](security.md)).

The banner says how many things need a look, or "Nothing needs attention".

## Reports

Every weekly skill, and any skill that sends a `report` in its heartbeat, is a report. Reports per
week are counted as delivered (it ran) or missed (it was due and nothing arrived). The latest report
text shows when the heartbeat carries it ([heartbeats.md](heartbeats.md)).

## CI

Each active workflow gets 30 daily bars from its completed runs: green when every run that day
passed, amber when some failed, red when all failed, grey with no runs. Reads stop at 600 runs per
workflow. **CI minutes per day** add up each run's wall clock (start to last update), by workflow;
a run whose span is over 3 hours is left out, since that is a re-run days later, not run time.

## Promotions

Under CI. A repo that promotes from an integration branch to production (staging → main, develop →
master…) does it with pull requests into the production branch. Level 5 finds the two branches by name
(or from `"promotion": {"from": "staging", "to": "main"}` in `.claude/factory.json`) and lists what
is waiting for production and the recent promotions.

**Waiting** is counted from the **head of the last merged promotion** to the integration branch, not
from production: squash-merged promotions leave the two branches diverged, and comparing them keeps
counting commits that already shipped. A promotion PR is one into production from the integration
branch or from a branch named like `merge/`, `promote` or `release`.

## Last 30 days

From GitHub search, GraphQL and the merged PR list:

- **PRs merged**, and the share merged from agent branches: `claude/`, `codex/`, `agent/`,
  `fix/pr-sweep`, `fix/issue-`, `fix-issues`, `audit`.
- **Lines changed** in merged PRs (additions and deletions, per PR and per day), and the median PR.
- **Median time to merge**, and PRs closed without merging.
- **Issues opened and closed per day**, open count and median age.
- **CI pass rate** over all completed runs, and the workflows failing right now.

Per-day charts group by UTC day.
