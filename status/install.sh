#!/bin/sh
# Type V installer. Run at the root of your repo:
#   curl -fsSL __ORIGIN__/install.sh | sh -s -- <ingest-key>
#
# Writes these, all under .claude/, and changes nothing else:
#   .claude/hooks/typev.sh       the heartbeat: a SessionEnd hook plus `typev.sh beat` for skills
#   .claude/typev.json           where to send heartbeats, and the key (it can only post heartbeats for this repo)
#   .claude/settings.json       adds the SessionEnd hook, keeps everything already there
#   .claude/skills/typev/SKILL.md  tells agents how to send a heartbeat with status and volume
#   .claude/skills/typev-setup/    /typev-setup: builds the factory from the templates, in one PR
#   .claude/typev/templates/       the monitors, report and pulse /typev-setup can add
# and .claude/factory.json if the repo has none.
set -eu

KEY="${1:-${TYPEV_KEY:-}}"
URL="__ORIGIN__"
[ -n "$KEY" ] || { echo "typev: pass your ingest key: sh -s -- fsk_..." >&2; exit 1; }
[ -d .git ] || { echo "typev: run this at the root of a git repo" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "typev: needs node to edit .claude/settings.json" >&2; exit 1; }

mkdir -p .claude/hooks .claude/skills/typev

cat > .claude/typev.json <<EOF
{ "url": "$URL", "key": "$KEY" }
EOF

cat > .claude/hooks/typev.sh <<'HOOK'
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
[ -f "$CFG" ] || exit 0
URL="${TYPEV_URL:-$(sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' "$CFG")}"
KEY="${TYPEV_KEY:-$(sed -n 's/.*"key": *"\([^"]*\)".*/\1/p' "$CFG")}"
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
HOOK
chmod +x .claude/hooks/typev.sh

# Repos installed before the rename to Type V have the old names. The old kit and config go, the
# old SessionEnd hook is swapped for the new one below, and the old hook file stays as a
# forwarder to typev.sh, since skills copied from the old templates still call it.
OLD=hush
if [ -f ".claude/hooks/$OLD.sh" ]; then
  printf '#!/bin/sh\n# Kept for skills written before the rename to Type V.\nexec "$(dirname "$0")/typev.sh" "$@"\n' > ".claude/hooks/$OLD.sh"
  chmod +x ".claude/hooks/$OLD.sh"
  rm -rf ".claude/$OLD.json" ".claude/skills/$OLD" ".claude/skills/$OLD-setup" ".claude/$OLD"
fi

OLD="$OLD" node - <<'NODE'
const fs = require("fs");
const p = ".claude/settings.json";
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
s.hooks ??= {};
s.hooks.SessionEnd ??= [];
const old = `/${process.env.OLD}.sh session-end`; // the hook from before the rename
s.hooks.SessionEnd = s.hooks.SessionEnd.map((e) => (e.hooks ? { ...e, hooks: e.hooks.filter((h) => !String(h.command || "").includes(old)) } : e)).filter((e) => !e.hooks || e.hooks.length);
const cmd = "$CLAUDE_PROJECT_DIR/.claude/hooks/typev.sh session-end";
if (!JSON.stringify(s.hooks.SessionEnd).includes("typev.sh")) s.hooks.SessionEnd.push({ hooks: [{ type: "command", command: cmd }] });
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
NODE

cat > .claude/skills/typev/SKILL.md <<'SKILL'
---
name: typev
description: Send a Type V heartbeat. Every skill that runs on a Claude Code routine (a monitor, a sweep, a report, a fixer) ends by calling this, clean run or not, so the status page can tell a healthy silent monitor from a dead one. Use for "heartbeat", "typev beat", "report to Type V".
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
SKILL

# the kit: /typev-setup, and the templates it adds to the repo as new typev-* skills and workflows
# __KIT__

if [ ! -f .claude/factory.json ]; then
cat > .claude/factory.json <<'EOF'
{
  "monitors": [
    { "id": "monitor", "cadence": "daily", "max_silence_hours": 50, "volume_key": "events", "routine": "Monitors" }
  ],
  "routines": [
    { "name": "Monitors", "cron": "0 13 * * *", "prompt": "/monitor", "model": "sonnet" }
  ]
}
EOF
fi

echo "typev: installed. Commit .claude/ and push."
echo "typev: then run /typev-setup in Claude Code to add monitors, a daily report and a pulse."
echo "typev: test it: .claude/hooks/typev.sh beat install-test ok"
