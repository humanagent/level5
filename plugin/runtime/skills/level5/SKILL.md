---
name: level5
description: Send a Level 5 heartbeat. Every skill that runs on a Claude Code routine (a monitor, a sweep, a report, a fixer) ends by calling this, clean run or not, so the status page can tell a healthy silent monitor from a dead one. Use for "heartbeat", "level5 beat", "report to level 5".
allowed-tools: Bash(.claude/hooks/level5.sh *)
---

# Level 5 heartbeat

The SessionEnd hook already tells Level 5 that a routine ran. That proves the routine is
alive. It does not say whether the run was any good. For that, the skill sends its own
heartbeat as its last step:

```bash
.claude/hooks/level5.sh beat <monitor-id> <ok|degraded|skipped> '{"swept":{"<volume_key>":<n>},"filed":[<issue numbers>],"note":"<one line>"}'
```

- `ok`: the sweep ran end to end and saw data.
- `degraded`: it ran, but something was missing (an empty source, a rate limit, a broken check).
- `skipped`: it did not run: a credential is missing or the source did not answer.

Always send one, even on failure. A degraded heartbeat is worth more than an invented ok,
and a monitor with no heartbeat shows as down. Put the count of what you read in `swept`
under the monitor's `volume_key` from `.claude/factory.json`: an `ok` with zero volume is
flagged as "said ok, read nothing".

A skill that writes a report (a weekly summary, an email, a digest) also sends the report
itself, so it can be read in Level 5 under Reports: add `"title"` and `"report"` (markdown, up to
60,000 characters) to the same JSON.

A report that goes out as an email (HTML) sends that instead, and Level 5 shows the last one as it
was sent:

```bash
.claude/hooks/level5.sh body <report-id> /tmp/report.html "<subject>"
```
