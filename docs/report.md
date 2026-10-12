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

**Sending it every day is not wired yet**: Hush has no email provider configured. The report is ready
to be sent by whatever provider is chosen.
