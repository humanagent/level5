#!/bin/sh
# Level 5 installs as a Claude Code plugin. In Claude Code:
#
#   /plugin install level5 --marketplace humanagent/level5
#   /level5:setup <ingest-key>
#
# The second line, at the repo root, writes the heartbeat hook into .claude/ and opens one PR.
cat >&2 <<'MSG'
Level 5 installs as a Claude Code plugin. In Claude Code:

  /plugin install level5 --marketplace humanagent/level5
  /level5:setup <ingest-key>

Run the second line at the repo root. It writes the heartbeat hook into .claude/ and opens one PR.
MSG
exit 1
