---
name: typev
description: Send a Type V heartbeat. Every skill that runs on a Claude Code routine (a monitor, a sweep, a report, a fixer) ends by calling this, clean run or not, so the status page can tell a healthy silent monitor from a dead one. Use for "heartbeat", "typev beat", "report to type v".
allowed-tools: Bash(.claude/hooks/typev.sh *)
---

# Type V heartbeat

The SessionEnd hook already tells Type V that a routine ran. That proves the routine is
alive. It does not say whether the run was any good. For that, the skill sends its own
heartbeat as its last step:

```bash
.claude/hooks/typev.sh beat <monitor-id> <ok|degraded|skipped> '{"swept":{"<volume_key>":<n>},"filed":[<issue numbers>],"note":"<one line>"}'
```

- `ok`: the sweep ran end to end and saw data.
- `degraded`: it ran, but something was missing (an empty source, a rate limit, a broken check).
- `skipped`: it did not run: a credential is missing or the source did not answer.

Always send one, even on failure. A degraded heartbeat is worth more than an invented ok,
and a monitor with no heartbeat shows as down. Put the count of what you read in `swept`
under the monitor's `volume_key` from `.claude/factory.json`: an `ok` with zero volume is
flagged as "said ok, read nothing".

A skill that writes a report (a weekly summary, an email, a digest) also sends the report
itself, so it can be read in Type V under Reports: add `"title"` and `"report"` (markdown, up to
60,000 characters) to the same JSON.
