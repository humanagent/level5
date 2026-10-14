#!/bin/sh
# Type V installs as a Claude Code plugin. In Claude Code:
#
#   /plugin install typev --marketplace humanagent/typev
#   /typev:setup <ingest-key>
#
# The second line, at the repo root, writes the heartbeat hook into .claude/ and opens one PR.
cat >&2 <<'MSG'
Type V installs as a Claude Code plugin. In Claude Code:

  /plugin install typev --marketplace humanagent/typev
  /typev:setup <ingest-key>

Run the second line at the repo root. It writes the heartbeat hook into .claude/ and opens one PR.
MSG
exit 1
