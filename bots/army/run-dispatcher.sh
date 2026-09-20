#!/bin/bash
# Auto-restart loop for the army dispatcher.  Start: setsid nohup /root/workspace/bots/army/run-dispatcher.sh >/dev/null 2>&1 &
# Stop: pkill -f run-dispatcher.sh; pkill -f army/dispatcher.js
cd /root/workspace/bots/army
LOG=/root/workspace/bots/army/dispatcher.log
export NODE_OPTIONS=--max-old-space-size=256
while true; do
  echo "=== $(date -Is) starting dispatcher ===" >> "$LOG"
  node /root/workspace/bots/army/dispatcher.js >> "$LOG" 2>&1
  echo "=== $(date -Is) dispatcher exited ($?), restarting in 3s ===" >> "$LOG"
  if [ "$(stat -c%s "$LOG")" -gt 5000000 ]; then tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  sleep 3
done
