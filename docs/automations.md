# Automations

An automation is one scheduled job: a Claude Code routine (`.claude/factory.json` or the older
`cloud-routine.md` table) or a scheduled GitHub Actions workflow. It can run in several places and
leave traces in several logs, but Level 5 treats it as **one object**, stored with its own state, cost,
tokens and runs. Anything in the app that names an automation (the week calendar, Status, a monitor's
"runs in", a notification) opens the same window.

## What is stored

Two tables, rebuilt on every refresh of the repo (`syncAutomations()` in `status/server.mjs`) and
kept, so the history outlives the 84 days of heartbeats read at a time.

**`automations`**, one row per automation, unique on `(repo_id, key)`. The key is the routine name
without `App: `, slugified (`App: Code reviews` → `code-reviews`).

| Column | What |
| --- | --- |
| `name`, `source` | `Claude Code` or `GitHub Actions` |
| `cron`, `command`, `model` | the slash command (`/monitor`), or the workflow file |
| `skills` | the skills it runs, as a JSON list of monitor ids |
| `state`, `state_why` | see below |
| `last_run_at`, `next_run_at` | |
| `runs_30d`, `missed_30d` | runs that happened, and scheduled runs that did not |
| `tokens_30d`, `usd_30d`, `secs_30d` | Claude Code tokens, their estimated cost, and run time |

**`automation_runs`**, one row per run, unique on `(automation_id, dedupe)`: `at`, `status`,
`origin`, `tokens`, `usd`, `secs`, `note`, `url`.

## How a run is put together

- **Claude Code routine.** Every heartbeat from the routine's session (`source: session`, named after
  its slash command) and from its skills is collected, and heartbeats less than 3 hours apart are one
  run. The run is `degraded` if any skill reported something other than `ok`, and its note says which
  ("1 of 7 skills degraded: monitor-speed"). Tokens, cost and duration come from that session's
  Claude Code cost row (same command, within 4 hours). Origin: `session`, `skills`, or both.
- **GitHub Actions workflow.** The workflow's last 40 completed runs: `ok`, `failed` or GitHub's own
  conclusion, the duration from start to last update, and a link to the run.

A run that only some sources saw still counts: a routine whose skills report but whose session-end
hook does not still shows its runs, without tokens.

## State

| State | When |
| --- | --- |
| Not reporting | No run of it has ever reached Level 5. |
| Missed the last run | Its schedule says it should have run last time and nothing arrived. |
| Last run degraded | The latest run was not `ok`. |
| On schedule | Otherwise; the reason line gives the share of scheduled runs that happened. |

"Should have run" comes from the cron itself: a weekly routine is only due in the week its cron
fires, a weekdays-only routine is not due on Saturday. See [judging.md](judging.md).

## On the page

**Automations** is a week calendar, Monday to Sunday, in the viewer's time zone (see Settings in
[architecture.md](architecture.md)): hours down, one block per scheduled run at its time, green when
it ran, red when it should have run and did not, dashed when it is still to come, and a line for now.
Hovering a block shows the run (state, day and time, that day's tokens, cost and time) and the
automation (its bars, command, model, last and next run, share on time, skills, 30-day cost).
Clicking it opens the automation.

**The automation window**: the state and why, command, schedule, model and source, the 30-day
numbers (runs and misses, tokens, cost, time), the colour bars (30 days, or 12 weeks for a weekly
one), the run log (five at a time, each with its time, state, origin, note, tokens, cost, duration
and log link), and the skills it runs, each opening its own window.

## What it needs from the repo

- **Runs**: heartbeats ([heartbeats.md](heartbeats.md)). A routine whose prompt runs no slash command
  and has no skills of its own sends nothing, and shows as not reporting.
- **Tokens and cost**: the `SessionEnd` hook, which posts the session's token usage.
- **Duration**: the same hook, from the first and last timestamp in the transcript (`secs`).

## Run and create from Level 5

Claude Code has no API to create, edit or pause a routine. It has one to start a routine that has an
API trigger, so that is what Level 5 does:

- **Run now.** Open a Claude Code routine's window, paste its API trigger (the URL and the
  `sk-ant-…` token from the routine's settings on claude.ai) under "Run from Level 5", and it gets a
  Run now button with an optional text for that run (an issue, a PR, an alert). The token is sealed
  at rest, never sent back to the page, and only posted to Anthropic's fire URL. Every run started
  from Level 5, and every one that failed to start, goes to the bell. Anthropic allows 30 starts per
  routine and 100 per account an hour; Level 5 adds a 20 s pause between starts of the same routine.
- **New routine.** The button on Automations opens a form (name, what it does, when, model) that
  writes a `/level5:new-monitor …` command. Pasted in Claude Code, it adds the `level5-*` skill and its
  roster entry in one PR; after the merge, `/level5:setup routines` creates the routine in the
  person's Claude account. Level 5 itself stays read-only on the repo.

- **Resolve with Claude.** Every open issue on the Issues page has a button that starts the repo's
  `Level 5: Run` routine with "Resolve issue #<n>" as its text, and opens the Claude Code session it
  starts in a new tab. The routine runs the `level5-run` skill: the same five gates as
  `/level5:mend`, a failing test first, the smallest fix, one PR that says `Fixes #<n>`, or a comment
  on the issue saying why not. It never merges. Once per repo, `/level5:setup run` adds the skill,
  and the person creates the routine with an API trigger on claude.ai and pastes it under the
  button. It runs on their Claude account.

Pausing, editing and deleting a routine stay on claude.ai.

