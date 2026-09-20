#!/bin/sh
# Auto-restart wrapper for the LLM-free observability daemon.
# Started with: setsid nohup /root/workspace/bots/metrics/run-inspector.sh >/dev/null 2>&1 &
cd /root/workspace/bots/metrics || exit 1
echo "$$" > /root/workspace/bots/metrics/inspector.pid
while true; do
  echo "$(date -Is) starting inspector.js" >> /root/workspace/bots/metrics/inspector.log
  node /root/workspace/bots/metrics/inspector.js >> /root/workspace/bots/metrics/inspector.out 2>&1
  echo "$(date -Is) inspector.js exited rc=$? — restarting in 10s" >> /root/workspace/bots/metrics/inspector.log
  sleep 10
done
