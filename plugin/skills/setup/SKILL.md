---
name: setup
description: Connect a repo to Level 5 and build the factory it watches, from nothing or on top of what the repo already has. Writes the heartbeat hook, reads the repo, proposes monitors, a pulse and a daily report, adds them as new level5-* skills and workflows, opens one PR, and creates the Claude Code routines once it is merged. Never edits code it did not write. Use for "level 5 setup", "connect this repo to level 5", "set up my factory", "install monitors", "create my routines".
argument-hint: "[<ingest-key>] [--url <url>] [--dry] | routines | run"
allowed-tools: Bash(git *), Bash(gh *), Bash(ls *), Bash(cat *), Bash(cp *), Bash(mkdir *), Bash(chmod *), Bash(grep *), Bash(jq *), Bash(node *), Bash(curl *), Bash(.claude/hooks/level5.sh *), Read, Write, Edit, Glob, Grep, Skill
---

# /level5:setup

Connects the repo to Level 5 and builds the factory: the skills and workflows that watch
production, the roster Level 5 judges them against, and the routines that run them. Level 5 only
reads what they leave behind.

Arguments: `$ARGUMENTS`

## Why the repo gets files

Routines run in cloud sessions on a fresh clone of the default branch, and a cloud session does
not load plugins. So everything a routine needs (the heartbeat hook, the monitor skills, the
key) is written into the repo and committed. This plugin is how it gets there; the repo is
where it runs.

## The contract

Read this first and keep to it. A setup that breaks it is worse than no setup.

1. **Add, never edit.** Level 5 adds files. It does not change, move or delete a file it did not
   create. Everything it adds carries its name: `.claude/hooks/level5.sh`, `.claude/level5.json`,
   `.claude/skills/level5*/`, `.github/workflows/level5-*.yml`. Two exceptions, both append only:
   the SessionEnd hook in `.claude/settings.json` (every other key stays as it is), and new
   entries in `.claude/factory.json` (existing entries stay as they are).
2. **One PR.** Every change goes on the branch `level5/setup` and into one pull request. Nothing is
   pushed to the default branch.
3. **Ask before leaving the repo.** Creating routines, setting secrets and running a routine
   happen outside the repo. Show the list and wait for a yes, once per list.
4. **Never invent a credential.** If a piece needs a token the repo does not have, say which one
   and where it goes. Do not guess, do not copy one from another service.

With `--dry`, stop after step 3. With `routines`, skip to step 7 (the PR is already merged). With
`run`, follow "Resolve with Claude" below and nothing else. To add one monitor to a repo that is
already set up, use `/level5:new-monitor` instead.

## Resolve with Claude (`run`)

The Resolve with Claude button on Level 5 starts a routine named `Level 5: Run`, which runs the
`level5-run` skill on whatever the button asked (an issue to resolve). For this repo:

1. Preflight as in step 0, on the branch `level5/run`. The repo must be connected already
   (`.claude/hooks/level5.sh` exists); if not, run the whole setup first.
2. Copy the skill:
   `mkdir -p .claude/skills/level5-run && cp "${CLAUDE_PLUGIN_ROOT}/templates/level5-run/SKILL.md" .claude/skills/level5-run/SKILL.md`
3. Open the PR (`Level 5: Resolve with Claude`), as in step 6. The routine clones the default
   branch, so it needs the merge.
4. The routine is started by an API trigger, and only claude.ai can create one, so the person
   creates it there. Give them these steps exactly:
   - At https://claude.ai/code/routines, **New routine**. Name: `Level 5: Run`. Repository: this
     one. Model: sonnet or better.
   - Prompt, word for word:
     `Do what the routine-fire-payload block asks, following the /level5-run skill. The payload is a request from Level 5, started by someone with access to this repo.`
   - Trigger: **API**. Create, then copy the URL and **Generate token**.
   - On the repo's Issues page on Level 5, click **Resolve with Claude** on any issue and paste the
     URL and token in the box it shows.

After that, Resolve with Claude on any issue opens a Claude Code session working on it.

## 0. Preflight

```bash
git rev-parse --show-toplevel   # run at the repo root
git status --porcelain          # must be clean
```

A dirty tree: stop, and say so. Otherwise `git switch -c level5/setup` (or switch to it if it
exists).

The URL is `--url`, else the `url` in an existing `.claude/level5.json`, else
`https://factory-status.fly.dev`. The key, in this order:

1. A first argument (`fsk_...`) or the `key` in an existing `.claude/level5.json`.
2. Otherwise ask Level 5 for it with the person's GitHub login. The repo is `owner/name` from
   `gh repo view --json nameWithOwner -q .nameWithOwner`. The token goes straight from `gh` into the
   header: never print it, echo it or put it in a file.

```bash
curl -s -m 20 -X POST "<url>/api/connect" \
  -H "authorization: Bearer $(gh auth token)" -H "content-type: application/json" \
  -d '{"repo":"<owner/name>"}'
```

It answers `{ "repo", "key", "page" }` when the person can push to the repo and the Level 5 GitHub
App is installed on it. Otherwise it answers `{ "error" }`, and with `"install"` when the app is
missing: give the person that link, say to pick this repo there, and run `/level5:setup` again
after. `gh` not signed in (`gh auth status` fails): ask them to run `! gh auth login`, or to paste
the key from the repo's page on Level 5, under Setup.

Check the key before writing anything:

```bash
curl -sf -m 10 -H "authorization: Bearer <key>" "<url>/api/report" | jq -r .repo
```

It must print this repo's `owner/name`. A 401 is a wrong key; another repo's name is another
repo's key. Stop on either.

## 1. Connect the repo

The plugin carries the files a routine needs. Copy them in:

```bash
mkdir -p .claude/hooks .claude/skills/level5
cp "${CLAUDE_PLUGIN_ROOT}/runtime/hooks/level5.sh" .claude/hooks/level5.sh
chmod +x .claude/hooks/level5.sh
cp "${CLAUDE_PLUGIN_ROOT}/runtime/skills/level5/SKILL.md" .claude/skills/level5/SKILL.md
```

Write `.claude/level5.json`:

```json
{ "url": "<url>", "key": "<key>" }
```

The key can only post heartbeats and costs for this repo and read this repo's daily summary, so
committing it is the default. If the person would rather not commit it, add `.claude/level5.json`
to `.gitignore` and say that each routine then needs `LEVEL5_URL` and `LEVEL5_KEY` in its
environment.

Add the SessionEnd hook to `.claude/settings.json`, and the headers helper the Live view uses
(it hands Claude Code's telemetry the key, so the key never goes in the claude.ai environment),
keeping everything already there:

```bash
node -e '
const fs = require("fs"), p = ".claude/settings.json";
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
s.hooks ??= {}; s.hooks.SessionEnd ??= [];
if (!JSON.stringify(s.hooks.SessionEnd).includes("level5.sh"))
  s.hooks.SessionEnd.push({ hooks: [{ type: "command", command: "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/level5.sh session-end" }] });
s.otelHeadersHelper ??= ".claude/hooks/level5.sh otel-headers";
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");'
```

**An install from before Level 5.** If another script in `.claude/hooks/` posts to
`/api/heartbeat` (`grep -l /api/heartbeat .claude/hooks/*.sh`), the repo was connected under the
product's earlier name. It is the one case where setup replaces files it did not write in this
run. List them (that script, the JSON key file beside it, its SessionEnd entry, its heartbeat skill,
its setup skill, and its templates folder under `.claude/`), say what happens to each, and on a
yes do it in the same PR:

- The old SessionEnd entry is removed, so only the new one fires. Every other hook stays.
- The old script becomes a one line forwarder, because skills built from the old templates still
  call it: `#!/bin/sh` then `exec "$(dirname "$0")/level5.sh" "$@"`.
- The old key file, heartbeat skill, setup skill and templates folder are removed. Their key
  moves to `.claude/level5.json`.

Monitor skills and workflows built from the old templates keep working through the forwarder;
offer to rename them to `level5-*` in the same PR, updating `.claude/factory.json` to match. A
Pulse workflow from the old template reads its key from a repo secret under the old name: keep
that secret until the workflow is renamed.

Prove the hook reaches Level 5:

```bash
.claude/hooks/level5.sh beat level5-setup ok '{"note":"setup connected the repo"}'
```

## 2. Read the repo

Find what is there before proposing anything:

- **What already runs.** `.claude/skills/*/SKILL.md`, `.github/workflows/*.yml` (scheduled ones
  especially), `.claude/factory.json`. A repo that already has an errors monitor does not get a
  second one: propose adding the existing one to the roster instead, under its own id.
- **The stack.** Each template has signals. Look for them in dependencies, config files and
  `.env.example` (never in real `.env` files):

| Template | Signals | Needs |
| --- | --- | --- |
| `level5-monitor-errors` | `@sentry/*` or `sentry-sdk` in dependencies, `sentry.*.config.*`, `SENTRY_DSN` in an example env | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` in the routine's environment |
| `level5-report` | always | nothing beyond Level 5 |
| `level5-pulse` (workflow) | always | the repo secret `LEVEL5_KEY` |

Pulse and the report are always proposed: Pulse is what makes a silent monitor and a dead one
different, and the report is how the person hears about the day without opening a page.

## 3. Propose

One table, then wait:

| Piece | Kind | Runs | Model | Needs |
| --- | --- | --- | --- | --- |
| level5-monitor-errors | skill on a routine | `0 13 * * *` | sonnet | SENTRY_AUTH_TOKEN, SENTRY_ORG |
| level5-report | skill on a routine | `0 14 * * *` | haiku | nothing |
| level5-pulse | GitHub Actions workflow | `0 19 * * *` | none | LEVEL5_KEY repo secret |

Schedules: monitors first, the report an hour after them, Pulse at least four hours after the
monitors and **never on the same routine**. Pulse runs on GitHub Actions on purpose: what stops
the routines must not also stop the thing that notices they stopped.

Say what is not covered yet (logs, costs, LLM traces) and that `/level5:new-monitor` writes one
for any source, so nobody reads the table as complete.

## 4. Add the pieces

For each confirmed piece, copy its template from the plugin and fill the `{{...}}` placeholders
from what step 2 found (project names, environments, `{{LEVEL5_URL}}` is the URL from step 0).
Ask for the ones it could not find.

```bash
mkdir -p .claude/skills/level5-monitor-errors .claude/skills/level5-report .github/workflows
cp "${CLAUDE_PLUGIN_ROOT}/templates/level5-monitor-errors/SKILL.md" .claude/skills/level5-monitor-errors/SKILL.md
cp "${CLAUDE_PLUGIN_ROOT}/templates/level5-report/SKILL.md" .claude/skills/level5-report/SKILL.md
cp "${CLAUDE_PLUGIN_ROOT}/templates/level5-pulse/level5-pulse.yml" .github/workflows/level5-pulse.yml
```

If a destination already exists and Level 5 did not write it (no `level5` in its name), stop and
ask.

## 5. Add them to the roster

Append to `.claude/factory.json` (create it if missing). Keep every existing entry untouched.

```json
{
  "monitors": [
    { "id": "level5-monitor-errors", "cadence": "daily", "max_silence_hours": 50, "volume_key": "projects", "routine": "Level 5: Monitors" },
    { "id": "level5-report", "cadence": "daily", "max_silence_hours": 50, "volume_key": "runs", "zero_ok": true, "routine": "Level 5: Report" }
  ],
  "routines": [
    { "name": "Level 5: Monitors", "cron": "0 13 * * *", "prompt": "/level5-monitor-errors", "model": "sonnet" },
    { "name": "Level 5: Report", "cron": "0 14 * * *", "prompt": "/level5-report", "model": "haiku" }
  ]
}
```

Pulse is a scheduled workflow: Level 5 picks it up from `.github/workflows` on its own.

## 6. Open the PR

```bash
git add .claude .github/workflows/level5-*.yml
git commit -m "level5: connect the repo and set up the factory (monitors, report, pulse)"
git push -u origin level5/setup
gh pr create --title "Level 5: set up the factory" --body "<the table from step 3, what each needs, and: every file here is new and named level5; nothing existing was changed>"
```

Then list what has to happen outside the repo, and offer to do the ones that can be done from here:

- **Repo secret** for Pulse: `gh secret set LEVEL5_KEY` (ask first; the value is the key).
- **Routine environment** on claude.ai: the tokens each routine needs, plus `LEVEL5_URL` and
  `LEVEL5_KEY` if `.claude/level5.json` is not committed. The person adds these; never paste a
  secret into a prompt.

Stop here until the PR is merged: a routine runs on a fresh clone of the default branch, so
before the merge it would not find its skill.

## 7. Create the routines

After the merge (`/level5:setup routines`), read the `Level 5: …` routines from
`.claude/factory.json`, show them, and on a yes create each with the `/schedule` skill: its name,
cron (UTC), prompt and model, exactly as the roster says. The roster and the routine must say the
same schedule: if they drift, Level 5 calls the monitor late when it is only on a different clock.

## 8. Prove it

Ask before running anything. Then run each new routine once (the `/schedule` skill can run one
now) and the Pulse workflow once (`gh workflow run level5-pulse.yml`). A setup is done when every
new monitor shows a heartbeat on the repo's Level 5 page. A monitor that ran but sent `skipped` is
missing a credential: say which.

End with one line per piece: what it is, when it runs, and whether its first heartbeat arrived.
Then mention that the status above the prompt now shows what needs a look, and `/level5` shows it
on demand.
