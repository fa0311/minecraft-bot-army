#!/bin/sh
# Auto-restarting bot managers: ceil(roster/3) shard processes (3 bots each; 50 bots = 17 shards) + API router on :3000.
cd /root/workspace/bots
export MC_VERSION=26.1 PER_SHARD=3 SHARDS=$(node -p "String(Math.ceil(require('./roster.json').length/3))") NODE_OPTIONS=--max-old-space-size=4096
for i in $(seq 0 $((SHARDS-1))); do
  ( while true; do SHARD=$i nice -n 15 node manager.js >> manager.log 2>&1; echo "shard $i exited, restarting in 5s" >> manager.log; sleep 5; done ) &
done
# keep manager.log bounded (it once reached 250 MB): above 50 MB keep the last 5 MB in manager.log.1 and start over
( while true; do sleep 600; [ "$(stat -c%s manager.log 2>/dev/null || echo 0)" -gt 50000000 ] && tail -c 5000000 manager.log > manager.log.1 && : > manager.log; done ) &
while true; do node router.js >> router.log 2>&1; sleep 3; done
# nice 15 (09-20 13:0xZ, owner: "tps低いらしい"): load average 21 on 16 cores, swap full; java (nice 5, not ours to lower in this container) shared the CPUs on equal terms with
# 17 shards at ~40 % each and the server tick starved: MSPT avg 105 -> 63 within a minute of lowering the shards' priority. The server comes first; bots wait.
