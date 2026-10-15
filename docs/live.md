# Live runs

Level 5 receives OpenTelemetry (OTLP/HTTP, JSON or protobuf) at `/v1/logs` and `/v1/traces`, with
the repo's ingest key as `x-level5-key` (or `authorization: Bearer`). Each Claude Code session and
each Managed Agents session becomes a run on the Live view: what it is doing now, its tool calls,
tokens, cost and errors. A run ends after 10 minutes without records.

## Connecting

**Claude Code routines.** Add to the cloud environment's variables on claude.ai (the Live view
prints them with the key filled in):

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=none
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=https://factory-status.fly.dev
OTEL_LOG_TOOL_DETAILS=1
OTEL_LOGS_EXPORT_INTERVAL=5000
CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS=60000
```

The key does not go there. The repo hands it over with Claude Code's `otelHeadersHelper`, in
`.claude/settings.json`:

```json
{ "otelHeadersHelper": ".claude/hooks/level5.sh otel-headers" }
```

`level5.sh otel-headers` prints `{"x-level5-key": "<key>"}` from `LEVEL5_KEY` or
`.claude/level5.json`, waiting up to 15 s for a SessionStart hook that writes it from a vault. When
it has no key, Claude Code asks again after the debounce above. The path is relative to the repo
root (`$CLAUDE_PROJECT_DIR` is not expanded there). Without the helper, add
`OTEL_EXPORTER_OTLP_HEADERS=x-level5-key=<ingest key>` to the variables instead.

A repo's `.claude/settings.json` cannot turn telemetry on (Claude Code ignores OTEL variables
there), so this goes in the environment, not in the repo. Prompt and response text are not sent.

**Managed Agents and the Messages API.** In the Claude Console, OpenTelemetry settings: a Custom
destination with endpoint `https://factory-status.fly.dev`, header `x-level5-key`, content mode
Metadata only. Spans are grouped by `anthropic.session.id`.

## Stuck

A running run is flagged, once per kind, with a notification:

| Flag | When |
| --- | --- |
| Repeating itself | the same tool call with the same input 8 times in a row |
| Running long | over 40 minutes, or over 3 times its usual length |
| Burning tokens | over 3 times its usual tokens (and over 200k) |
| Errors piling up | 5 or more failed tool calls or API errors |

"Usual" is the median of its last ended runs with the same name, once there are 3.

## Kept

Per run: name (the slash command or the first skill), counts, tokens, cost, model, the last 40
steps (tool and a short label: the command, the file name, the skill or MCP tool) and the last 12
errors. Not kept: prompts, outputs, emails or any other resource attribute. Runs older than 30
days are deleted.
