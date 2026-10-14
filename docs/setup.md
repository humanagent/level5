# `/level5:setup`

Builds a factory Level 5 can watch, from nothing or on top of what a repo already has: monitors,
a daily report and a pulse, the roster that declares them, and the Claude Code routines that run
them. The compute is the repo's own: its routines and its GitHub Actions. Level 5 stores the
heartbeats and judges them.

The skill and the templates it adds come with the [plugin](../README.md#install)
(`plugin/skills/setup/`, `plugin/templates/`). Run it in Claude Code at the repo root:

```
/level5:setup <ingest-key>        connect the repo, read it, propose, add the pieces, open one PR
/level5:setup <ingest-key> --dry  connect and propose only
/level5:setup routines            after the PR is merged: create the routines, run each once
/level5:new-monitor "<name>" --cron "<cron>" --model <model> -- <what it does>
                                 one more monitor, in its own PR
```

## The contract

1. **Add, never edit.** Level 5 adds files and does not change, move or delete a file it did not
   create. What it adds is named level5: `.claude/hooks/level5.sh`, `.claude/level5.json`,
   `.claude/skills/level5*/`, `.github/workflows/level5-*.yml`. Two exceptions, both append only: the `SessionEnd` hook in
   `.claude/settings.json`, and new entries in `.claude/factory.json`.
2. **One PR**, from the branch `level5/setup`. Nothing goes to the default branch directly.
3. **Asks before leaving the repo**: creating routines, setting secrets, running a routine.
4. **Never invents a credential.** A piece that needs a token says which one and where it goes.

## The templates

| Template | Kind | Default schedule (UTC) | Needs |
| --- | --- | --- | --- |
| `level5-monitor-errors` | skill on a routine (sonnet) | `0 13 * * *` | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` |
| `level5-report` | skill on a routine (haiku) | `0 14 * * *` | nothing beyond Level 5 |
| `level5-pulse` | GitHub Actions workflow, no model | `0 19 * * *` | repo secret `LEVEL5_KEY` |

- **level5-monitor-errors** sweeps Sentry for errors new or regressed in 24 h, files a GitHub issue
  (label `level5:errors`) for the ones over the threshold, and ends with a heartbeat whose
  `volume_key` is `projects`.
- **level5-report** reads `GET /api/report` and posts the day as a GitHub issue (label
  `level5:report`), closing the previous one. GitHub notifies whoever watches the repo, so the
  report reaches an inbox with no mail setup. The report also goes in its heartbeat, so Level 5 shows
  it under Reports.
- **level5-pulse** asks `GET /api/report` which monitors need a look (`needs`) and keeps one issue
  per problem (label `level5:pulse`): opened when Level 5 judges a monitor dead, late, degraded or
  "said ok, read nothing", closed when it recovers. When Level 5 does not answer, it files that too.
  It runs on GitHub Actions, apart from the routines it watches, so what stops them does not stop
  it.

Not covered yet by a template: logs, costs and LLM traces. `/level5:setup` says so in its proposal, and
`/level5:new-monitor` writes a monitor for any of them from one line.
