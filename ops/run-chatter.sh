#!/bin/bash
# Auto-restart loop for the bot chatter daemon (bots/chatter.js).
# Start with:  setsid nohup /root/workspace/ops/run-chatter.sh >/dev/null 2>&1 &
# Stop with:   pkill -f run-chatter.sh; pkill -f bots/chatter.js
cd /root/workspace
LOG=/root/workspace/bots/chatter.log
export NODE_OPTIONS=--max-old-space-size=512
while true; do
  echo "=== $(date -Is) starting chatter.js ===" >> "$LOG"
  node /root/workspace/bots/chatter.js >> "$LOG" 2>&1
  echo "=== $(date -Is) chatter.js exited ($?), restarting in 5s ===" >> "$LOG"
  # keep the log from growing without bound
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 5000000 ]; then
    tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
  sleep 5
done
