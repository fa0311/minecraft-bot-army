#!/bin/sh
# Kills a manager shard whose event loop is blocked (API unresponsive 3 checks in a row); run-manager.sh respawns it.
while true; do
  SHARDS=$(node -p "String(Math.ceil(require('/root/workspace/bots/roster.json').length/3))")
  for i in $(seq 0 $((SHARDS-1))); do
    port=$((3001+i)); f=/tmp/shard_fail_$i
    if curl -s -o /dev/null --max-time 5 "localhost:$port/players"; then echo 0 > $f
    else n=$(( $(cat $f 2>/dev/null || echo 0) + 1 )); echo $n > $f
      if [ $n -ge 3 ]; then
        for pid in $(pgrep -f "^node manage[r].js"); do
          if tr '\0' '\n' < /proc/$pid/environ | grep -qx "SHARD=$i"; then kill -9 $pid; echo "$(date +%T) killed hung shard $i pid $pid" >> /root/workspace/bots/watchdog.log; fi
        done; echo 0 > $f
      fi
    fi
  done
  sleep 10
done
