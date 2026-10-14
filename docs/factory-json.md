# `.claude/factory.json`

Optional. Declares the monitors Type V should expect heartbeats from and the Claude Code routines
that run them. Without it, Type V still shows every monitor that sends a heartbeat (marked "not in
roster"), CI, scheduled Actions and the queue.

```json
{
  "monitors": [
    { "id": "errors", "cadence": "daily", "max_silence_hours": 50, "volume_key": "events", "routine": "Monitors" },
    { "id": "cost", "cadence": "weekly", "max_silence_hours": 200, "volume_key": "line_items", "routine": "Cost weekly" }
  ],
  "routines": [
    { "name": "Monitors", "cron": "0 13 * * *", "prompt": "/monitor", "model": "sonnet" },
    { "name": "Cost weekly", "cron": "0 12 * * 3", "prompt": "/cost-weekly-report", "model": "sonnet" },
    { "name": "Audit", "cron": "0 4 * * 0", "prompt": "/audit-*", "model": "opus" }
  ]
}
```

## Monitors

| Field | Default | What |
| --- | --- | --- |
| `id` | required | The `monitor` the heartbeats carry. |
| `cadence` | `daily` | `daily` shows 30 daily bars; `weekly` shows 12 weekly bars. |
| `max_silence_hours` | 50 daily, 200 weekly | Longer than this without a heartbeat is **Down**. |
| `volume_key` | none | Key in `swept` that counts what the run read. An `ok` with this at 0 is **Said ok, read nothing**. |
| `zero_ok` | false | Set when reading nothing is a normal clean run, to skip that check. |
| `routine` | none | The routine (by `name`) that runs this monitor. Its heartbeats count as that routine's runs. |

## Routines

| Field | What |
| --- | --- |
| `name` | Shown on the page. |
| `cron` | Five fields, **UTC**. Gives the next run and the period used to call a routine late. |
| `prompt` | What the routine runs. The first `/slash-command` in it links session heartbeats to the routine. `/audit-*`, or a family name ending in `-`, matches every `audit-…` command. |
| `model` | Shown on the page. |

Scheduled GitHub Actions (`on: schedule: - cron:`) are added as routines automatically, with
source "GitHub Actions" and their last run as evidence.

## Older convention

When `factory.json` is missing, Type V falls back to:

- monitors from `.claude/skills/monitor-meta/roster.json` (`{ "monitors": [...] }`, same fields), and
- routines from the table in `.claude/skills/cloud-routine.md`: rows shaped
  `| name | \`cron\` | prompt | model |`.
