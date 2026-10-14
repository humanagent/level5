---
name: setup
description: Connect a repo to Type V and build the factory it watches, from nothing or on top of what the repo already has. Writes the heartbeat hook, reads the repo, proposes monitors, a pulse and a daily report, adds them as new typev-* skills and workflows, opens one PR, and creates the Claude Code routines once it is merged. Never edits code it did not write. Use for "type v setup", "connect this repo to type v", "set up my factory", "install monitors", "create my routines".
argument-hint: "<ingest-key> [--url <url>] [--dry] | routines"
allowed-tools: Bash(git *), Bash(gh *), Bash(ls *), Bash(cat *), Bash(cp *), Bash(mkdir *), Bash(chmod *), Bash(grep *), Bash(jq *), Bash(node *), Bash(curl *), Bash(.claude/hooks/typev.sh *), Read, Write, Edit, Glob, Grep, Skill
---

# /typev:setup

Connects the repo to Type V and builds the factory: the skills and workflows that watch
production, the roster Type V judges them against, and the routines that run them. Type V only
reads what they leave behind.

Arguments: `$ARGUMENTS`

## Why the repo gets files

Routines run in cloud sessions on a fresh clone of the default branch, and a cloud session does
not load plugins. So everything a routine needs (the heartbeat hook, the monitor skills, the
key) is written into the repo and committed. This plugin is how it gets there; the repo is
where it runs.

## The contract

Read this first and keep to it. A setup that breaks it is worse than no setup.

1. **Add, never edit.** Type V adds files. It does not change, move or delete a file it did not
   create. Everything it adds carries its name: `.claude/hooks/typev.sh`, `.claude/typev.json`,
   `.claude/skills/typev*/`, `.github/workflows/typev-*.yml`. Two exceptions, both append only:
   the SessionEnd hook in `.claude/settings.json` (every other key stays as it is), and new
   entries in `.claude/factory.json` (existing entries stay as they are).
2. **One PR.** Every change goes on the branch `typev/setup` and into one pull request. Nothing is
   pushed to the default branch.
3. **Ask before leaving the repo.** Creating routines, setting secrets and running a routine
   happen outside the repo. Show the list and wait for a yes, once per list.
4. **Never invent a credential.** If a piece needs a token the repo does not have, say which one
   and where it goes. Do not guess, do not copy one from another service.

With `--dry`, stop after step 3. With `routines`, skip to step 7 (the PR is already merged). To
add one monitor to a repo that is already set up, use `/typev:new-monitor` instead.

## 0. Preflight

```bash
git rev-parse --show-toplevel   # run at the repo root
git status --porcelain          # must be clean
```

A dirty tree: stop, and say so. Otherwise `git switch -c typev/setup` (or switch to it if it
exists).

The key is the first argument (`fsk_...`), from the repo's page on Type V. The URL is `--url`,
else the `url` in an existing `.claude/typev.json`, else `https://factory-status.fly.dev`. No key
and no `.claude/typev.json`: ask for the key, and say where it is (the repo's page on Type V,
under Set up). Check it before writing anything:

```bash
curl -sf -m 10 -H "authorization: Bearer <key>" "<url>/api/report" | jq -r .repo
```

It must print this repo's `owner/name`. A 401 is a wrong key; another repo's name is another
repo's key. Stop on either.

## 1. Connect the repo

The plugin carries the files a routine needs. Copy them in:

```bash
mkdir -p .claude/hooks .claude/skills/typev
cp "${CLAUDE_PLUGIN_ROOT}/runtime/hooks/typev.sh" .claude/hooks/typev.sh
chmod +x .claude/hooks/typev.sh
cp "${CLAUDE_PLUGIN_ROOT}/runtime/skills/typev/SKILL.md" .claude/skills/typev/SKILL.md
```

Write `.claude/typev.json`:

```json
{ "url": "<url>", "key": "<key>" }
```

The key can only post heartbeats and costs for this repo and read this repo's daily summary, so
committing it is the default. If the person would rather not commit it, add `.claude/typev.json`
to `.gitignore` and say that each routine then needs `TYPEV_URL` and `TYPEV_KEY` in its
environment.

Add the SessionEnd hook to `.claude/settings.json`, keeping everything already there:

```bash
node -e '
const fs = require("fs"), p = ".claude/settings.json";
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
s.hooks ??= {}; s.hooks.SessionEnd ??= [];
if (!JSON.stringify(s.hooks.SessionEnd).includes("typev.sh"))
  s.hooks.SessionEnd.push({ hooks: [{ type: "command", command: "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/typev.sh session-end" }] });
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");'
```

**An install from before Type V.** If another script in `.claude/hooks/` posts to
`/api/heartbeat` (`grep -l /api/heartbeat .claude/hooks/*.sh`), the repo was connected under the
product's earlier name. It is the one case where setup replaces files it did not write in this
run. List them (that script, the JSON key file beside it, its SessionEnd entry, its heartbeat skill,
its setup skill, and its templates folder under `.claude/`), say what happens to each, and on a
yes do it in the same PR:

- The old SessionEnd entry is removed, so only the new one fires. Every other hook stays.
- The old script becomes a one line forwarder, because skills built from the old templates still
  call it: `#!/bin/sh` then `exec "$(dirname "$0")/typev.sh" "$@"`.
- The old key file, heartbeat skill, setup skill and templates folder are removed. Their key
  moves to `.claude/typev.json`.

Monitor skills and workflows built from the old templates keep working through the forwarder;
offer to rename them to `typev-*` in the same PR, updating `.claude/factory.json` to match. A
Pulse workflow from the old template reads its key from a repo secret under the old name: keep
that secret until the workflow is renamed.

Prove the hook reaches Type V:

```bash
.claude/hooks/typev.sh beat typev-setup ok '{"note":"setup connected the repo"}'
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
| `typev-monitor-errors` | `@sentry/*` or `sentry-sdk` in dependencies, `sentry.*.config.*`, `SENTRY_DSN` in an example env | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` in the routine's environment |
| `typev-report` | always | nothing beyond Type V |
| `typev-pulse` (workflow) | always | the repo secret `TYPEV_KEY` |

Pulse and the report are always proposed: Pulse is what makes a silent monitor and a dead one
different, and the report is how the person hears about the day without opening a page.

## 3. Propose

One table, then wait:

| Piece | Kind | Runs | Model | Needs |
| --- | --- | --- | --- | --- |
| typev-monitor-errors | skill on a routine | `0 13 * * *` | sonnet | SENTRY_AUTH_TOKEN, SENTRY_ORG |
| typev-report | skill on a routine | `0 14 * * *` | haiku | nothing |
| typev-pulse | GitHub Actions workflow | `0 19 * * *` | none | TYPEV_KEY repo secret |

Schedules: monitors first, the report an hour after them, Pulse at least four hours after the
monitors and **never on the same routine**. Pulse runs on GitHub Actions on purpose: what stops
the routines must not also stop the thing that notices they stopped.

Say what is not covered yet (logs, costs, LLM traces) and that `/typev:new-monitor` writes one
for any source, so nobody reads the table as complete.

## 4. Add the pieces

For each confirmed piece, copy its template from the plugin and fill the `{{...}}` placeholders
from what step 2 found (project names, environments, `{{TYPEV_URL}}` is the URL from step 0).
Ask for the ones it could not find.

```bash
mkdir -p .claude/skills/typev-monitor-errors .claude/skills/typev-report .github/workflows
cp "${CLAUDE_PLUGIN_ROOT}/templates/typev-monitor-errors/SKILL.md" .claude/skills/typev-monitor-errors/SKILL.md
cp "${CLAUDE_PLUGIN_ROOT}/templates/typev-report/SKILL.md" .claude/skills/typev-report/SKILL.md
cp "${CLAUDE_PLUGIN_ROOT}/templates/typev-pulse/typev-pulse.yml" .github/workflows/typev-pulse.yml
```

If a destination already exists and Type V did not write it (no `typev` in its name), stop and
ask.

## 5. Add them to the roster

Append to `.claude/factory.json` (create it if missing). Keep every existing entry untouched.

```json
{
  "monitors": [
    { "id": "typev-monitor-errors", "cadence": "daily", "max_silence_hours": 50, "volume_key": "projects", "routine": "Type V: Monitors" },
    { "id": "typev-report", "cadence": "daily", "max_silence_hours": 50, "volume_key": "runs", "zero_ok": true, "routine": "Type V: Report" }
  ],
  "routines": [
    { "name": "Type V: Monitors", "cron": "0 13 * * *", "prompt": "/typev-monitor-errors", "model": "sonnet" },
    { "name": "Type V: Report", "cron": "0 14 * * *", "prompt": "/typev-report", "model": "haiku" }
  ]
}
```

Pulse is a scheduled workflow: Type V picks it up from `.github/workflows` on its own.

## 6. Open the PR

```bash
git add .claude .github/workflows/typev-*.yml
git commit -m "typev: connect the repo and set up the factory (monitors, report, pulse)"
git push -u origin typev/setup
gh pr create --title "Type V: set up the factory" --body "<the table from step 3, what each needs, and: every file here is new and named typev; nothing existing was changed>"
```

Then list what has to happen outside the repo, and offer to do the ones that can be done from here:

- **Repo secret** for Pulse: `gh secret set TYPEV_KEY` (ask first; the value is the key).
- **Routine environment** on claude.ai: the tokens each routine needs, plus `TYPEV_URL` and
  `TYPEV_KEY` if `.claude/typev.json` is not committed. The person adds these; never paste a
  secret into a prompt.

Stop here until the PR is merged: a routine runs on a fresh clone of the default branch, so
before the merge it would not find its skill.

## 7. Create the routines

After the merge (`/typev:setup routines`), read the `Type V: …` routines from
`.claude/factory.json`, show them, and on a yes create each with the `/schedule` skill: its name,
cron (UTC), prompt and model, exactly as the roster says. The roster and the routine must say the
same schedule: if they drift, Type V calls the monitor late when it is only on a different clock.

## 8. Prove it

Ask before running anything. Then run each new routine once (the `/schedule` skill can run one
now) and the Pulse workflow once (`gh workflow run typev-pulse.yml`). A setup is done when every
new monitor shows a heartbeat on the repo's Type V page. A monitor that ran but sent `skipped` is
missing a credential: say which.

End with one line per piece: what it is, when it runs, and whether its first heartbeat arrived.
Then mention that the status above the prompt now shows what needs a look, and `/typev` shows it
on demand.
