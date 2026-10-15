# Heartbeats

A heartbeat is the only proof that a scheduled job ran. Without one, a dead monitor and a healthy
system look the same: both are silent. Level 5 stores every heartbeat a repo sends and judges each
monitor from them (see [judging.md](judging.md)).

## The API

```
POST /api/heartbeat
authorization: Bearer <ingest-key>
content-type: application/json
```

The body is one heartbeat or an array of them.

| Field | Required | What |
| --- | --- | --- |
| `monitor` | yes | Id of the monitor or routine, up to 80 chars. Matches `id` in `.claude/factory.json`. |
| `status` | yes | `ok` (ran end to end and saw data), `degraded` (ran, something was missing), `skipped` (did not run: a credential is missing or the source did not answer). |
| `swept` | no | Object of counts of what the run read, e.g. `{"events": 41233}`. The monitor's `volume_key` is looked up here. |
| `filed` | no | Issue numbers the run opened. Linked from the monitor's detail. |
| `suppressed` | no | How many findings it chose not to file. |
| `window` | no | The time range it read, e.g. `24h`. |
| `note` | no | One line, up to 500 chars. |
| `source` | no | `skill` (default) or `session`. Session beats come from the `SessionEnd` hook. |
| `ts` | no | ISO time. Defaults to now. A repeated `(monitor, ts)` is ignored, so retries are safe. |
| `title`, `report` | no | A report the run produced (a weekly summary, an email), as markdown up to 60,000 characters. Shown under Reports. |

Responses: `200 {"ok":true,"stored":n}`, `401` for an unknown key, `400` for a missing monitor or
status.

**A report's body.** A report that goes out as an email posts the HTML it sent, and Reports links
the last one (served sandboxed, so nothing in it runs). `level5.sh body <report> <file.html> [title]`
does this from a skill.

```
POST /api/report-body
{ "monitor": "marketing-ads", "title": "Ads · 8-14 Oct", "html": "<!doctype html>…" }
```

**Marketing.** Spend, leads, impressions and clicks per campaign per day, with the ad account's
state. A repo that posts these gets a Marketing view: the last 30 days against the 30 before, per
campaign. Posting a day again replaces it, so a skill can resend the last days, which ad platforms
keep revising.

```
POST /api/marketing
{ "source": "meta", "account": { "name", "status", "currency", "amount_spent", "spend_cap", "balance" },
  "rows": [{ "day": "2026-10-14", "campaign": "Socios · 2026-10", "spend": 25.3, "impressions": 8708, "clicks": 27, "leads": 5 }] }
```

The **ingest key** is created the first time someone opens the repo's page, and shown in its
onboarding card (and at `/r/<owner>/<repo>/setup` afterwards). It can only post heartbeats and costs
for that one repo, and read that repo's daily report ([report.md](report.md)).

**Getting the key from Claude Code.** `/level5:setup` with no key asks for it:

```
POST /api/connect
authorization: Bearer <a GitHub token: gh auth token>
content-type: application/json

{ "repo": "owner/name" }
```

Level 5 reads `GET /user` and `GET /repos/<owner>/<name>` with that token, and the repo's app
installation with the app's own token. The answer is `200 {"repo","key","url","page"}` when the
person can push to the repo and the app is installed on it; `401` for a token GitHub refuses, `403`
without push access, `404` when the repo is not visible or the app is not installed (with
`"install"`, the link to install it). The GitHub token is used for those reads and never stored.

**Replacing the key.** Setup has a "Replace key" button. The new key works at once and the old one
keeps working for 24 hours, so there is time to update wherever it is stored before heartbeats stop.
Replace it whenever it leaked: committed to git, pasted somewhere.

## Connecting a repo

In Claude Code, with the [plugin](../README.md#install) added, at the repo root:

```
/level5:setup
```

It asks Level 5 for the repo's key with the person's GitHub login (`POST /api/connect`, below), or
takes the key as its argument. It writes these into the repo, in the PR it opens, and changes nothing else. They go in the repo
and not in the plugin because routines run in cloud sessions on a fresh clone, and a cloud session
does not load plugins: only what is committed reaches them.

| File | What |
| --- | --- |
| `.claude/level5.json` | `{ "url", "key" }`. `LEVEL5_URL` and `LEVEL5_KEY` env vars override it. |
| `.claude/hooks/level5.sh` | The client: `beat`, `cost` and `session-end`. |
| `.claude/settings.json` | Adds the `SessionEnd` hook. Existing content is kept; running twice adds it once. |
| `.claude/skills/level5/SKILL.md` | Tells agents to end a routine skill with a heartbeat. |
| `.claude/factory.json` | The roster, created if missing, appended to otherwise. |

The source of the first three is `plugin/runtime/` in this repo; a plugin update reaches a repo the
next time `/level5:setup` runs there.

**Connected before the rename to Level 5?** That install keeps reporting, and the setup page says
so. Run `/level5:setup` again to move it to the names above: it swaps the old `SessionEnd` hook for
the new one, removes the old config and kit, and keeps the old hook file as a one-line forwarder to
`level5.sh`, since skills copied from the old templates still call it.

**Where the key lives.** Committing `.claude/level5.json` puts a live key in the repo's history: anyone
with a clone can post fake heartbeats. In a repo that keeps secrets in a vault, set `LEVEL5_URL` and
`LEVEL5_KEY` there instead, gitignore `.claude/level5.json`, and let the environment provide them:

- **Claude Code cloud routines:** the variables a session-start hook exports into `$CLAUDE_ENV_FILE`
  reach the commands the session runs (so skill heartbeats work), but **not the `SessionEnd` hook**.
  Have the session-start hook also write `.claude/level5.json` inside the container (not committed), so
  `level5.sh session-end` finds the key.
- **GitHub Actions:** pass both to the job that calls `level5.sh`, and make sure its checkout includes
  `.claude/hooks/level5.sh` (a sparse checkout that leaves it out skips the copy silently).

## Two ways a routine reports

**Automatic: the `SessionEnd` hook.** When a Claude Code session ends in the cloud
(`CLAUDE_CODE_REMOTE=true`), `level5.sh session-end` reads the transcript, takes the first slash
command the session ran (`/fix-issues`), and posts `{monitor: "fix-issues", status: "ok", source:
"session"}`, and the session's token usage by model and its duration (see [costs.md](costs.md)).
Local sessions send nothing. This proves the routine ran, not that it went well. A
session beat named after a declared routine counts as that routine's run and does not create a
monitor row of its own. Routines whose prompt is free text, with no slash command, send nothing
this way.

**Explicit: `level5.sh beat`.** A skill ends with:

```sh
.claude/hooks/level5.sh beat monitor-infra ok '{"swept":{"log_events":41233},"filed":[2634],"note":"one box without cameras"}'
```

This carries the status and the volume, so Level 5 can tell a monitor that read nothing from one that
read a lot and found nothing. Once a monitor sends its own beats, session beats with the same id
are ignored for it.

From anywhere else (a Lambda, another CI, a cron box), post the JSON directly.

## Isolation guarantees

`level5.sh` must never change how the repo it lives in behaves:

- The post runs in the background, detached, with a 5 s cap. The caller's output, exit code and
  duration do not change.
- No network, no curl, no `.claude/level5.json` or no key: it exits 0.
- `LEVEL5_DISABLED=1` turns it off entirely, before any network call.
- `session-end` does nothing outside a cloud session.

Tested: with an unreachable server, a reachable one, `LEVEL5_DISABLED=1`, and a local
`session-end`, every case exits 0 in about 0.02 s.

When a repo already has its own heartbeat store, call `level5.sh beat` as the **last** step, after
the existing writes, so the copy to Level 5 can never affect them.
