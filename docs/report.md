# Daily factory report

Everything that happened in the factory on one day (UTC), section by section, as one email.
Built from the repo's snapshot by `dailyReport()` in `status/report.mjs`, so it says what the page says.

| Section | What |
| --- | --- |
| Header | "All clear" or "Needs a look", and how many things to look at |
| Automations | runs that day, tokens, token cost, time; which missed, which came back degraded, which ran fine |
| Skills that need a look | only when some do |
| Costs | spend that day by provider, against the 7-day average (or "not arrived yet": providers report a day late) |
| Code | PRs merged (and by agents), lines added and removed, PRs opened, promotions to production; the merged PRs with their size |
| CI | minutes, runs, workflows with failures |
| Issues | opened, closed, open now |
| Reports | weekly reports delivered that day |

The look follows a transactional-email canon: a warm ground the card floats on, one white card with a
header band, the overall state in a pill, data in tinted strips, mono eyebrows over each section, and
the accent colour kept for the single button. Styles are inline and the layout is tables, so it reads
the same in Gmail and Outlook.

Preview any day at `/r/<owner>/<repo>/report?day=YYYY-MM-DD`.

## For the repo's own report

Type V sends no email. A repo that wants the report in its inbox gets the day as data and sends it
with its own template and email path, from a daily routine:

```
GET /api/report?day=YYYY-MM-DD
authorization: Bearer <ingest-key>
```

The day defaults to yesterday (UTC). The answer has `automations` (runs, ok, degraded, missed,
tokens, usd, secs), `costs` (total and by provider, or null until providers report), `code` (merged,
by agents, lines added and deleted, opened, promotions, and the merged PRs with their size), `ci`
(minutes, runs, failing workflows), `issues` (opened, closed), `needs` (skills that need a look),
`reports`, and `previous`: the same facts for the day before, to compare.

This is the one thing an ingest key can **read**: a summary of its own repo, nothing else.
