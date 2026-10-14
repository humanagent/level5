#!/bin/sh
# typev.sh: heartbeats for Type V.
#
#   typev.sh beat <monitor> <ok|degraded|skipped> ['{"swept":{"events":120},"filed":[42],"note":"..."}']
#       A skill calls this as its last step, clean run or not.
#   typev.sh cost <source> <usd> ['{"day":"2026-10-10","breakdown":{"ECS":4.1,"S3":0.3}}']
#       One provider's spend for one day (default today). Posting the same source and day again
#       replaces it, so a daily job can resend the last few days safely.
#   typev.sh session-end
#       The SessionEnd hook. In a Claude Code cloud session (a routine) it posts the session's
#       token usage by model, and one heartbeat named after the slash command the session ran.
#       Local sessions send nothing.
#
# Never fails or slows the caller: the post runs in the background, detached, with a 5 s cap,
# and no network, no key or no curl just exits 0. TYPEV_DISABLED=1 turns it off entirely.
[ -z "${TYPEV_DISABLED:-}" ] || exit 0
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$DIR/typev.json"
# TYPEV_URL and TYPEV_KEY (a routine's environment) win over .claude/typev.json
cfg() { [ -f "$CFG" ] && sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$CFG"; }
URL="${TYPEV_URL:-$(cfg url)}"
KEY="${TYPEV_KEY:-$(cfg key)}"
[ -n "$URL" ] && [ -n "$KEY" ] && command -v curl >/dev/null 2>&1 || exit 0

post() {
  ( curl -sS -m 5 -X POST "$URL${2:-/api/heartbeat}" \
      -H "authorization: Bearer $KEY" -H "content-type: application/json" \
      -d "$1" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
}

case "${1:-}" in
  beat)
    monitor="${2:?monitor}"; status="${3:-ok}"; extra="${4:-}"
    [ -n "$extra" ] || extra='{}'
    # merge monitor, status and source into the extra object
    rest="${extra#*\{}"
    case "$rest" in
      *[!\ ]*\}*) body="{\"monitor\":\"$monitor\",\"status\":\"$status\",\"source\":\"skill\",$rest" ;;
      *) body="{\"monitor\":\"$monitor\",\"status\":\"$status\",\"source\":\"skill\"}" ;;
    esac
    post "$body"
    ;;
  cost)
    source="${2:?source}"; usd="${3:?usd}"; extra="${4:-}"
    [ -n "$extra" ] || extra='{}'
    rest="${extra#*\{}"
    case "$rest" in
      *[!\ ]*\}*) body="{\"source\":\"$source\",\"usd\":$usd,$rest" ;;
      *) body="{\"source\":\"$source\",\"usd\":$usd}" ;;
    esac
    post "$body" /api/cost
    ;;
  session-end)
    [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
    input="$(cat)"
    transcript="$(printf '%s' "$input" | sed -n 's/.*"transcript_path": *"\([^"]*\)".*/\1/p')"
    [ -f "$transcript" ] || exit 0
    # the first slash command that is not a Claude Code built-in (/clear, /compact, /model...)
    builtin='(add-dir|agents|bug|clear|compact|config|context|cost|doctor|exit|export|help|hooks|ide|init|login|logout|mcp|memory|model|permissions|pr-comments|release-notes|resume|review|status|statusline|terminal-setup|upgrade|vim)'
    cmd="$(grep -o '<command-name>/[^<]*</command-name>' "$transcript" | sed 's/<[^>]*>//g; s/^\///' | grep -vxE "$builtin" | head -1)"
    [ -n "$cmd" ] || cmd="$(grep -o '"content":"/[A-Za-z0-9:_-]*' "$transcript" | sed 's/.*"\///' | grep -vxE "$builtin" | head -1)"
    # Tokens by model, summed over the session's assistant messages (one count per message id).
    sid="$(printf '%s' "$input" | sed -n 's/.*"session_id": *"\([^"]*\)".*/\1/p')"
    if command -v node >/dev/null 2>&1; then
      usage="$(node -e '
        const fs = require("fs"), [file, sid, name] = process.argv.slice(1), seen = new Map();
        let turns = 0, t0 = Infinity, t1 = 0;
        for (const l of fs.readFileSync(file, "utf8").split("\n")) {
          let d; try { d = JSON.parse(l); } catch { continue; }
          const t = Date.parse(d.timestamp || ""); if (t) { t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
          if (d.type === "user" && !d.isSidechain && typeof d.message?.content === "string") turns++;
          const m = d.message;
          if (d.type === "assistant" && m?.usage && m.model && m.model !== "<synthetic>") seen.set(m.id || d.uuid, m);
        }
        const models = {};
        for (const m of seen.values()) {
          const u = m.usage, t = (models[m.model] ??= { input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 });
          t.input += u.input_tokens || 0; t.output += u.output_tokens || 0; t.cache_read += u.cache_read_input_tokens || 0;
          if (u.cache_creation) { t.cache_write_5m += u.cache_creation.ephemeral_5m_input_tokens || 0; t.cache_write_1h += u.cache_creation.ephemeral_1h_input_tokens || 0; }
          else t.cache_write_5m += u.cache_creation_input_tokens || 0;
        }
        if (Object.keys(models).length) process.stdout.write(JSON.stringify({ source: "claude-code", key: sid || undefined, name: name || "session", models, turns, secs: t1 > t0 ? Math.round((t1 - t0) / 1000) : undefined }));
      ' "$transcript" "$sid" "$cmd" 2>/dev/null)"
      [ -n "$usage" ] && post "$usage" /api/cost
    fi
    [ -n "$cmd" ] || exit 0
    reason="$(printf '%s' "$input" | sed -n 's/.*"reason": *"\([^"]*\)".*/\1/p')"
    post "{\"monitor\":\"$cmd\",\"status\":\"ok\",\"source\":\"session\",\"note\":\"routine session ended ($reason)\"}"
    ;;
esac
exit 0
