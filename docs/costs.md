# Costs

What the factory spends, per day and per source, and how many tokens each Claude Code session
burns. Hush holds no cloud or billing credentials: the repo pushes what it already knows, with the
same ingest key it uses for heartbeats.

## Claude Code sessions (automatic)

The `SessionEnd` hook installed by `install.sh` reads the session transcript when a cloud session
ends and posts its token usage by model:

```json
{ "source": "claude-code", "key": "<session_id>", "name": "fix-issues", "turns": 6,
  "models": { "claude-sonnet-4-5": { "input": 216, "output": 70555, "cache_write_5m": 0, "cache_write_1h": 322734, "cache_read": 19673294 } } }
```

- Each assistant message counts once (by message id), so streamed partial lines are not double counted.
- `name` is the first slash command that is not a Claude Code built-in (`/clear`, `/compact`,
  `/model`... are skipped).
- Subagent transcripts are separate files and are not counted yet.
- Local sessions send nothing.

**Dollars are an estimate** at API list prices per million tokens: input, output, cache writes at
1.25× input (5 min) or 2× (1 h), cache reads at 0.1× input. On a Claude subscription this is what
the same tokens would cost on the API, not what you pay. Models Hush has no price for show tokens
only; set or override prices in `.claude/factory.json`:

```json
{ "prices": { "claude-opus-5-5": { "input": 5, "output": 25 } } }
```

## Provider spend (AWS, Vercel, Neon, anything)

One row per source per day. Posting the same source and day again replaces it, so a daily job can
resend the last few days as late charges settle.

```sh
.claude/hooks/hush.sh cost aws 31.50 '{"day":"2026-10-10","breakdown":{"ECS":20,"Bedrock":8,"S3":0.4}}'
.claude/hooks/hush.sh cost vercel 4.20 '{"day":"2026-10-10"}'
.claude/hooks/hush.sh cost neon 0.63  # a flat monthly plan, spread per day
```

Or the raw call:

```
POST /api/cost
authorization: Bearer <ingest-key>

{ "source": "aws", "day": "2026-10-10", "usd": 31.5, "breakdown": { "ECS": 20, "Bedrock": 8 } }
```

| Field | What |
| --- | --- |
| `source` | Required. `aws`, `vercel`, `neon`, `anthropic`, `fly`, `cloudflare`... any lowercase slug. |
| `usd` | Required for providers. The day's spend. |
| `day` | `YYYY-MM-DD`, UTC. Defaults to today. |
| `breakdown` | Optional object of service → USD. |
| `key` | Optional. Defaults to `day`. Rows are unique on `(repo, source, key)`. |
| `note` | Optional, one line. |

The natural sender is the job that already reads the bill. For example, a daily cost monitor that
queries AWS Cost Explorer ends by posting the last 3 days with `hush.sh cost aws`.

## On the page

A **Costs** section: 30-day total by source, yesterday, the 7-day daily average, Claude Code tokens
in 30 days and per session, a stacked spend-per-day chart, and the last 20 sessions with their
tokens (input, cached, output) and estimated dollars.

## Price rules

Alarms on spend and tokens, under Costs. Each rule measures one number over one period and sends a
notification (the bell) when it crosses its limit, at most once per period.

| Field | Options |
| --- | --- |
| Provider | any, or one source (`aws`, `vercel`, `neon`, `claude-code`…) |
| Measure | spend in USD, Claude Code tokens, or tokens in one session |
| Period | per day (the last day with data), rolling 7 days, month to date, month-end forecast, each session |
| Condition | above a fixed amount, or N% above the average of the previous D days |
| Service | optional: only breakdown keys containing this text (an AWS service, say) |
| Days | days of the week it applies to (UTC); none = every day |
| Active from / until | optional dates |
| Severity | warning or critical |

Rules are checked every time the repo refreshes and every time costs are posted. Each shows its
current value against its limit. They belong to the repo: a rule id is only accepted together with
the repo it was created on.

## Map

The factory as a city, after the map in the "Build your own software factory" post: a tiled board
with a road down the middle, one outlined building per service (each AWS service from the Cost
Explorer breakdown; a provider that reports one total is one building). Footprint and height come
from the 30-day spend, and the biggest stand on a podium. Buildings are colored by district (run,
edge, data, AI, ship, watch, talk) with a short name on the roof; a building turns red while a price
rule on it is firing. Orange dots moving along the road and around the lots are decoration. Drag to
rotate, scroll to zoom, hover for the numbers, click a building for the service's window. Built with
three.js (loaded from jsDelivr only on this view); the list under it has the same numbers.
