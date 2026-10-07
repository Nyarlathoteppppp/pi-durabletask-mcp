#!/bin/sh
# Optional launcher: agent-browser and Node must be on this MCP host's PATH.
set -eu
export AGENT_BROWSER_SESSION="pi-$(node -p 'require("node:crypto").randomUUID()')"
agent-browser mcp --tools core <&0 &
child=$!
cleanup() { agent-browser close >/dev/null 2>&1 || true; }
trap 'kill "$child" 2>/dev/null || true; cleanup; exit 0' INT TERM
trap cleanup EXIT
wait "$child"
