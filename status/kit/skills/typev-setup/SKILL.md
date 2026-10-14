---
name: typev-setup
description: Set up a software factory that Type V watches, from nothing or on top of what the repo already has. Reads the repo, proposes monitors, a pulse and a daily report, adds them as new typev-* skills and workflows, adds them to the roster, opens one PR, and creates the Claude Code routines once it is merged. Never edits code it did not write. Use for "typev setup", "set up my factory", "install monitors", "create my routines".
argument-hint: "[--dry] [routines] [add \"<name>\" --cron \"<cron>\" --model <model> -- <what it does>]"
allowed-tools: Bash(git *), Bash(gh *), Bash(ls *), Bash(cat *), Bash(cp *), Bash(mkdir *), Bash(jq *), Bash(node *), Bash(curl *), Bash(.claude/hooks/typev.sh *), Read, Write, Edit, Glob, Grep, Skill
---

# /typev-setup

Builds the factory: the skills and workflows that watch production, the roster Type V judges them
against, and the routines that run them. Type V only reads what they leave behind.

## The contract

Read this first and keep to it. A setup that breaks it is worse than no setup.

1. **Add, never edit.** Type V adds files. It does not change, move or delete a file it did not
   create. Everything it adds carries its name: `.claude/skills/typev-*/`,
   `.github/workflows/typev-*.yml`, `.claude/typev/`. Two exceptions, both append only: the
   SessionEnd hook in `.claude/settings.json` (the installer adds it and keeps the rest), and new
   entries in `.claude/factory.json` (existing entries stay as they are).
2. **One PR.** Every change goes on the branch `typev/setup` and into one pull request. Nothing is
   pushed to the default branch.
3. **Ask before leaving the repo.** Creating routines, setting secrets and running a routine
   happen outside the repo. Show the list and wait for a yes, once per list.
4. **Never invent a credential.** If a piece needs a token the repo does not have, say which one
   and where it goes. Do not guess, do not copy one from another service.

With `--dry`, stop after step 2. With `routines`, skip to step 6 (the PR is already merged). With
`add`, follow "Add one routine" below instead of steps 1 to 4.

## Add one routine

`/typev-setup add "Logs sweep" --cron "0 13 * * *" --model sonnet -- <what it does>` comes from the
New routine form in Type V. It adds one routine and the skill it runs, and nothing else.

1. Run the preflight (step 0).
2. The id is `typev-` plus the name in kebab case (`typev-logs-sweep`). If
   `.claude/skills/<id>/` exists, stop and ask.
3. Write `.claude/skills/<id>/SKILL.md` from the description: a frontmatter (`name`, a one line
   `description` that says what it does and when to use it, `allowed-tools` for what it needs),
   then the steps. Keep to the house rules: silence is the default output, a GitHub issue only for
   something worth reading (deduped by title, labelled `typev:<id>`), never invent a credential, and
   **always end with a heartbeat**:
   `.claude/hooks/typev.sh beat <id> <ok|degraded|skipped> '{"swept":{"<what it counted>":<n>},"filed":[...],"note":"..."}'`.
   Say which credentials it needs at the top, and send `skipped` when one is missing.
4. Append to `.claude/factory.json`: a monitor `{ "id": "<id>", "cadence": "<daily or weekly from the cron>", "volume_key": "<what it counted>", "routine": "Type V: <Name>" }`
   and a routine `{ "name": "Type V: <Name>", "cron": "<cron>", "prompt": "/<id>", "model": "<model>" }`.
5. Open the PR as in step 5, titled `Type V: add <Name>`, then stop: after the merge,
   `/typev-setup routines` creates it (step 6) and runs it once (step 7).

## 0. Preflight

```bash
ls .claude/typev/templates                     # the installer put the templates here
cat .claude/typev.json 2>/dev/null | jq -r .url # where Type V lives (or $TYPEV_URL)
git status --porcelain                         # must be clean
```

No templates: tell the person to run the installer from their repo's Type V setup page, and stop.
A dirty tree: stop, and say so. Otherwise `git switch -c typev/setup` (or switch to it if it exists).

## 1. Read the repo

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

## 2. Propose

One table, then wait:

| Piece | Kind | Runs | Model | Needs |
| --- | --- | --- | --- | --- |
| typev-monitor-errors | skill on a routine | `0 13 * * *` | sonnet | SENTRY_AUTH_TOKEN, SENTRY_ORG |
| typev-report | skill on a routine | `0 14 * * *` | haiku | nothing |
| typev-pulse | GitHub Actions workflow | `0 19 * * *` | none | TYPEV_KEY repo secret |

Schedules: monitors first, the report an hour after them, Pulse at least four hours after the
monitors and **never on the same routine**. Pulse runs on GitHub Actions on purpose: what stops
the routines must not also stop the thing that notices they stopped.

Say what is not covered yet (logs, costs, LLM traces) so nobody reads the table as complete.

## 3. Add the pieces

For each confirmed piece, copy its template and fill the `{{...}}` placeholders from what step 1
found (project names, environments). Ask for the ones it could not find.

```bash
mkdir -p .claude/skills/typev-monitor-errors
cp .claude/typev/templates/typev-monitor-errors/SKILL.md .claude/skills/typev-monitor-errors/SKILL.md
mkdir -p .github/workflows
cp .claude/typev/templates/typev-pulse/typev-pulse.yml .github/workflows/typev-pulse.yml
```

If a destination already exists and Type V did not write it (no `typev` in its name), stop and ask.

## 4. Add them to the roster

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

## 5. Open the PR

```bash
git add .claude .github/workflows/typev-*.yml
git commit -m "typev: set up the factory (monitors, report, pulse)"
git push -u origin typev/setup
gh pr create --title "Type V: set up the factory" --body "<the table from step 2, what each needs, and: every file here is new and named typev; nothing existing was changed>"
```

Then list what has to happen outside the repo, and offer to do the ones that can be done from here:

- **Repo secret** for Pulse: `gh secret set TYPEV_KEY` (ask first; the value is the key in
  `.claude/typev.json`).
- **Routine environment** on claude.ai: the tokens each routine needs, plus `TYPEV_URL` and
  `TYPEV_KEY` if `.claude/typev.json` is not committed. The person adds these; never paste a
  secret into a prompt.

Stop here until the PR is merged: a routine runs on a fresh clone of the default branch, so
before the merge it would not find its skill.

## 6. Create the routines

After the merge (`/typev-setup routines`), read the `Type V: …` routines from `.claude/factory.json`,
show them, and on a yes create each with the `/schedule` skill: its name, cron (UTC), prompt and
model, exactly as the roster says. The roster and the routine must say the same schedule: if they
drift, Type V calls the monitor late when it is only on a different clock.

## 7. Prove it

Ask before running anything. Then run each new routine once (the `/schedule` skill can run one
now) and the Pulse workflow once (`gh workflow run typev-pulse.yml`). A setup is done when every
new monitor shows a heartbeat on the repo's Type V page. A monitor that ran but sent `skipped` is
missing a credential: say which.

End with one line per piece: what it is, when it runs, and whether its first heartbeat arrived.
