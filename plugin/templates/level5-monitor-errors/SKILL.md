---
name: level5-monitor-errors
description: Daily sweep of production errors in Sentry. Files a GitHub issue for each new or regressed error worth a look, stays silent otherwise, and always ends with a Level 5 heartbeat. Runs on a Claude Code routine. Use for "check errors", "sentry sweep", "monitor errors".
allowed-tools: Bash(curl *), Bash(jq *), Bash(gh *), Bash(date *), Bash(.claude/hooks/level5.sh *)
---

# /level5-monitor-errors

Silence is the right output on a good day. Every message this sends must be worth reading.

## Config

- Projects: `{{SENTRY_PROJECTS}}` (space separated Sentry project slugs)
- Environment: `{{SENTRY_ENVIRONMENT}}` (usually `production`)
- File when an error is new or regressed in the last 24 h **and** has at least 10 events or 3 users.

Needs `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` in the environment. If either is missing, send
`skipped` and stop:

```bash
.claude/hooks/level5.sh beat level5-monitor-errors skipped '{"note":"SENTRY_AUTH_TOKEN or SENTRY_ORG missing"}'
```

## 1. Sweep

For each project:

```bash
curl -sf -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/projects/$SENTRY_ORG/<project>/issues/?query=is:unresolved+environment:{{SENTRY_ENVIRONMENT}}&statsPeriod=24h&limit=100"
```

Count every project you actually read (`projects`) and the events across them (`events`). A
project that did not answer is not read: do not count it, and note it.

## 2. Judge

Keep an issue when it is new (`firstSeen` in the last 24 h) or regressed (`isRegressed`), and
it meets the threshold above. Everything else is suppressed: count it.

For each kept issue, read its latest event (`/api/0/issues/<id>/events/latest/`) for the top
in-app frames and the message.

## 3. Dedupe

```bash
gh issue list --state open --label level5:errors --search "<SHORT-ID> in:title" --json number
```

Already open: add a comment only if the count doubled since it was filed. Otherwise skip.

## 4. File

```bash
gh label create level5:errors --color B60205 --description "Filed by Level 5" 2>/dev/null || true
gh issue create --label level5:errors --title "[level5-errors] <SHORT-ID>: <title>" --body "<culprit, events and users in 24 h, first and last seen, the Sentry link, the top in-app frames>"
```

No routine GitHub token with issue rights: do not fail the run. Send `degraded` with the
issues you would have filed in the note.

## 5. Heartbeat

Always, clean run or not:

```bash
.claude/hooks/level5.sh beat level5-monitor-errors ok '{"swept":{"projects":<n>,"events":<n>},"suppressed":<n>,"filed":[<numbers>],"note":"<one line>"}'
```

`degraded` when some project did not answer or filing failed. `projects` at 0 with `ok` is what
Level 5 calls "said ok, read nothing": never send that, send `degraded`.
