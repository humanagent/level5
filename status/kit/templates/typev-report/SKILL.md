---
name: typev-report
model: haiku
description: The daily factory report as a GitHub issue. Reads yesterday (UTC) from Type V, writes it as one issue, closes the previous one, and sends the report to Type V so it shows under Reports. GitHub notifies whoever watches the repo, so it lands in their inbox with no mail setup. Use for "daily report", "what happened yesterday", "factory report".
allowed-tools: Bash(curl *), Bash(jq *), Bash(gh *), Bash(date *), Bash(cat *), Bash(sed *), Bash(.claude/hooks/typev.sh *)
---

# /typev-report

## 1. Read the day

```bash
CFG=.claude/typev.json
URL="${TYPEV_URL:-$(jq -r .url $CFG 2>/dev/null)}"; KEY="${TYPEV_KEY:-$(jq -r .key $CFG 2>/dev/null)}"
curl -sf -H "authorization: Bearer $KEY" "$URL/api/report" > /tmp/typev-day.json
```

No answer: send `skipped` with the reason and stop.

```bash
.claude/hooks/typev.sh beat typev-report skipped '{"note":"Type V did not answer /api/report"}'
```

## 2. Write it

Title: `Factory report · <day>`. Body, in this order, each line with the day before beside it
(`previous` in the data):

1. One line: "All clear", or how many things need a look. Things that need a look: every entry
   in `needs`, every `automations.missed`, every `automations.degraded`, every `ci.failing`.
2. **Automations**: runs, tokens, cost, time. Then the missed, the degraded, and the ones that ran fine.
3. **Code**: PRs merged (and by agents), lines added and deleted, promotions. The merged PRs as a list.
4. **Costs**: the total and by provider, or "not in yet" when `costs` is null.
5. **CI**: minutes, runs, the failing workflows.
6. **Issues**: opened, closed, open now.
7. The link in `url`.

Short lines, numbers before adjectives. No section is invented: if the data has nothing, say so in
a line and move on.

## 3. Post it

```bash
gh label create typev:report --color 5B4DFF --description "Daily report by Type V" 2>/dev/null || true
prev=$(gh issue list --state open --label typev:report --json number --jq '.[].number')
gh issue create --label typev:report --title "Factory report · <day>" --body-file /tmp/typev-report.md
for n in $prev; do gh issue close "$n" --comment "Superseded by the report for <day>."; done
```

## 4. Heartbeat

Always. Include the report so Type V keeps it under Reports:

```bash
.claude/hooks/typev.sh beat typev-report ok "$(jq -n --arg t "Factory report · <day>" --rawfile r /tmp/typev-report.md --argjson runs <n> '{swept:{runs:$runs},title:$t,report:$r}')"
```

`degraded` when the issue could not be created (the report still goes in the heartbeat).
