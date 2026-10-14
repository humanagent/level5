---
name: new-monitor
description: Add one monitor to a repo Type V already watches. Writes the typev-* skill it runs from a one line description (a logs sweep, a cost check, an LLM trace review, anything with a source), adds it and its routine to the roster, and opens one PR. Use for "new monitor", "watch my logs", "add a routine", or the New routine form on Type V.
argument-hint: "\"<name>\" --cron \"<cron>\" --model <model> -- <what it does>"
allowed-tools: Bash(git *), Bash(gh *), Bash(ls *), Bash(cat *), Bash(mkdir *), Bash(jq *), Bash(node *), Bash(.claude/hooks/typev.sh *), Read, Write, Edit, Glob, Grep, Skill
---

# /typev:new-monitor

Arguments: `$ARGUMENTS`

Adds one routine and the skill it runs, and nothing else. The same contract as `/typev:setup`:
add, never edit; one PR from its own branch; ask before leaving the repo; never invent a
credential.

1. **Preflight.** `.claude/hooks/typev.sh` must exist (no: run `/typev:setup` first, and stop).
   The tree must be clean. `git switch -c typev/<id>`.
2. **The id** is `typev-` plus the name in kebab case (`typev-logs-sweep`). If
   `.claude/skills/<id>/` exists, stop and ask. No cron or model given: propose one (monitors run
   daily, before the report; `sonnet` for a sweep that judges, `haiku` for one that only counts)
   and wait.
3. **Write `.claude/skills/<id>/SKILL.md`** from the description: a frontmatter (`name`, a one line
   `description` that says what it does and when to use it, `allowed-tools` for what it needs,
   always including `Bash(.claude/hooks/typev.sh *)`), then the steps. Read
   `${CLAUDE_PLUGIN_ROOT}/templates/typev-monitor-errors/SKILL.md` first and follow its shape:
   - Say which credentials it needs at the top, and send `skipped` when one is missing.
   - Silence is the default output. A GitHub issue only for something worth reading, deduped by
     title, labelled `typev:<name>`.
   - Count what it read, under one `volume_key`. An `ok` with nothing read is what Type V calls
     "said ok, read nothing": the skill sends `degraded` instead.
   - **Always end with a heartbeat**, clean run or not:
     `.claude/hooks/typev.sh beat <id> <ok|degraded|skipped> '{"swept":{"<volume_key>":<n>},"filed":[...],"note":"..."}'`
4. **Append to `.claude/factory.json`**, keeping every existing entry: a monitor
   `{ "id": "<id>", "cadence": "<daily or weekly from the cron>", "max_silence_hours": <50 daily, 200 weekly>, "volume_key": "<what it counts>", "routine": "Type V: <Name>" }`
   and a routine `{ "name": "Type V: <Name>", "cron": "<cron>", "prompt": "/<id>", "model": "<model>" }`.
5. **Open the PR**, titled `Type V: add <Name>`, with what it reads, when it runs and the
   credentials it needs. Then stop: after the merge, `/typev:setup routines` creates the routine
   and runs it once.
