# `/hush-setup`

Builds a factory Hush can watch, from nothing or on top of what a repo already has: monitors,
a daily report and a pulse, the roster that declares them, and the Claude Code routines that run
them. The compute is the repo's own: its routines and its GitHub Actions. Hush stores the
heartbeats and judges them.

The installer puts the skill in `.claude/skills/hush-setup/` and the templates it adds in
`.claude/hush/templates/`. Run it in Claude Code at the repo root:

```
/hush-setup          read the repo, propose, add the pieces, open one PR
/hush-setup --dry    only read and propose
/hush-setup routines after the PR is merged: create the routines, run each once
```

## The contract

1. **Add, never edit.** Hush adds files and does not change, move or delete a file it did not
   create. What it adds is named hush: `.claude/skills/hush-*/`, `.github/workflows/hush-*.yml`,
   `.claude/hush/`. Two exceptions, both append only: the `SessionEnd` hook in
   `.claude/settings.json`, and new entries in `.claude/factory.json`.
2. **One PR**, from the branch `hush/setup`. Nothing goes to the default branch directly.
3. **Asks before leaving the repo**: creating routines, setting secrets, running a routine.
4. **Never invents a credential.** A piece that needs a token says which one and where it goes.

## The templates

| Template | Kind | Default schedule (UTC) | Needs |
| --- | --- | --- | --- |
| `hush-monitor-errors` | skill on a routine (sonnet) | `0 13 * * *` | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` |
| `hush-report` | skill on a routine (haiku) | `0 14 * * *` | nothing beyond Hush |
| `hush-pulse` | GitHub Actions workflow, no model | `0 19 * * *` | repo secret `HUSH_KEY` |

- **hush-monitor-errors** sweeps Sentry for errors new or regressed in 24 h, files a GitHub issue
  (label `hush:errors`) for the ones over the threshold, and ends with a heartbeat whose
  `volume_key` is `projects`.
- **hush-report** reads `GET /api/report` and posts the day as a GitHub issue (label
  `hush:report`), closing the previous one. GitHub notifies whoever watches the repo, so the
  report reaches an inbox with no mail setup. The report also goes in its heartbeat, so Hush shows
  it under Reports.
- **hush-pulse** asks `GET /api/report` which monitors need a look (`needs`) and keeps one issue
  per problem (label `hush:pulse`): opened when Hush judges a monitor dead, late, degraded or
  "said ok, read nothing", closed when it recovers. When Hush does not answer, it files that too.
  It runs on GitHub Actions, apart from the routines it watches, so what stops them does not stop
  it.

Not covered yet: logs, costs and LLM traces. `/hush-setup` says so in its proposal.
