#!/bin/bash
# ops/down.sh — stop the bot side (managers, dispatcher, inspector, watchdog, chatter). The server keeps running.
#   ops/down.sh all   ...also stops the Minecraft server (saves the world first). Humans play here: keep it rare.
for p in ops/foreman.sh ops/operator.sh run-manager.sh shard-watchdog.sh army/run-dispatcher.sh metrics/run-inspector.sh run-chatter.sh; do pkill -f "$p"; done
pkill -f "^node manager.js"; pkill -f "^node router.js"; pkill -f "army/dispatcher.js"; pkill -f "metrics/inspector.js"; pkill -f "bots/chatter.js"; pkill -f "ops/helpdesk.js"
echo "bot side stopped"
if [ "$1" = all ]; then
  pkill -f run-server.sh
  node /root/workspace/bots/rcon.js "save-all" "stop" >/dev/null 2>&1
  for i in $(seq 1 90); do pgrep -f paper.jar >/dev/null || break; sleep 1; done
  pgrep -f paper.jar >/dev/null && echo "server still running!" || echo "server stopped"
fi
