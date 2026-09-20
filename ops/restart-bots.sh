#!/bin/bash
# ops/restart-bots.sh — ROLLING restart of the manager shards (ceil(roster/3); 50 bots = 17) (needed only after editing bots/manager.js or skills/army_worker.js;
# libs under skills/lib hot-reload by themselves). 3 bots reconnect at a time, ~20 s per shard; the run-manager loop respawns each shard.
for pid in $(pgrep -f "^node manager.js"); do
  kill "$pid"; echo "restarted shard pid $pid"; sleep 20
done
echo "rolling restart done"
