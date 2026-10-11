# Heartbeats

A heartbeat is the only proof that a scheduled job ran. Without one, a dead monitor and a healthy
system look the same: both are silent. Hush stores every heartbeat a repo sends and judges each
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

Responses: `200 {"ok":true,"stored":n}`, `401` for an unknown key, `400` for a missing monitor or
status.

The **ingest key** is created the first time someone opens the repo's page, and shown in its
onboarding card (and at `/r/<owner>/<repo>/setup` afterwards). It can only post heartbeats for that
one repo. It reads nothing.

## The installer

```sh
curl -fsSL https://factory-status.fly.dev/install.sh | sh -s -- <ingest-key>
```

Run at the repo root, then commit `.claude/`. It writes, and changes nothing else:

| File | What |
| --- | --- |
| `.claude/hush.json` | `{ "url", "key" }`. `HUSH_URL` and `HUSH_KEY` env vars override it. |
| `.claude/hooks/hush.sh` | The client: `beat` and `session-end`. |
| `.claude/settings.json` | Adds the `SessionEnd` hook. Existing content is kept; running twice adds it once. |
| `.claude/skills/hush/SKILL.md` | Tells agents to end a routine skill with a heartbeat. |
| `.claude/factory.json` | A starter roster, only if the repo has none. |

It needs `node` (to merge `settings.json`) and must run at the root of a git repo.

## Two ways a routine reports

**Automatic: the `SessionEnd` hook.** When a Claude Code session ends in the cloud
(`CLAUDE_CODE_REMOTE=true`), `hush.sh session-end` reads the transcript, takes the first slash
command the session ran (`/fix-issues`), and posts `{monitor: "fix-issues", status: "ok", source:
"session"}`. Local sessions send nothing. This proves the routine ran, not that it went well. A
session beat named after a declared routine counts as that routine's run and does not create a
monitor row of its own. Routines whose prompt is free text, with no slash command, send nothing
this way.

**Explicit: `hush.sh beat`.** A skill ends with:

```sh
.claude/hooks/hush.sh beat monitor-infra ok '{"swept":{"log_events":41233},"filed":[2634],"note":"one box without cameras"}'
```

This carries the status and the volume, so Hush can tell a monitor that read nothing from one that
read a lot and found nothing. Once a monitor sends its own beats, session beats with the same id
are ignored for it.

From anywhere else (a Lambda, another CI, a cron box), post the JSON directly.

## Isolation guarantees

`hush.sh` must never change how the repo it lives in behaves:

- The post runs in the background, detached, with a 5 s cap. The caller's output, exit code and
  duration do not change.
- No network, no curl, no `.claude/hush.json` or no key: it exits 0.
- `HUSH_DISABLED=1` turns it off entirely, before any network call.
- `session-end` does nothing outside a cloud session.

Tested: with an unreachable server, a reachable one, `HUSH_DISABLED=1`, and a local
`session-end`, every case exits 0 in about 0.02 s.

When a repo already has its own heartbeat store, call `hush.sh beat` as the **last** step, after
the existing writes, so the copy to Hush can never affect them.
