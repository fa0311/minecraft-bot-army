#!/bin/bash
# ops/new-world.sh <seed> — start a NEW WORLD (owner 09-19: the first seed was snow for 700+ blocks; in the next world humans are SPECTATORS).
# Everything old is MOVED to backups, nothing is deleted:  server/backups/world-<ts>/  and  bots/army/archive-<ts>/.
# Steps: stop everything -> move the world + the army's world-bound state away -> set level-seed -> start the SERVER ONLY -> datapack `modes`
# (every player outside team `army` is forced into spectator; /trigger goto stays) + team `army` with all roster names + gamerules ->
# write a bootstrap job board around the new world spawn. Then: ops/up.sh (bots log in as team members, i.e. survival).
set -e
W=/root/workspace; S=$W/server; A=$W/bots/army; SEED="$1"
[ -n "$SEED" ] || { echo "usage: ops/new-world.sh <seed>"; exit 1; }
TS=$(date -u +%m%d-%H%M)
echo "== stopping everything"; $W/ops/down.sh all || true
pgrep -f paper.jar >/dev/null && { echo "server still running - abort"; exit 1; }
echo "== moving the old world to server/backups/world-$TS"
mkdir -p $S/backups/world-$TS; for d in world world_nether world_the_end; do [ -d $S/$d ] && mv $S/$d $S/backups/world-$TS/; done
echo "== archiving the army's world-bound state to bots/army/archive-$TS"
mkdir -p $A/archive-$TS
for f in chests.json results.jsonl scout.jsonl animals.jsonl census.json aggressors.json asset_audit.json irrigation_bad.json hunt_bad.json ores_bad.json sites.json tidy_state.json terrain_debt.jsonl night.json alert.json say.json remedies.json escalate.seen.json status.json BOARD.md; do [ -e $A/$f ] && mv $A/$f $A/archive-$TS/; done
for d in decline hb assign swallowed help; do [ -d $A/$d ] && { mkdir -p $A/archive-$TS/$d; mv $A/$d/* $A/archive-$TS/$d/ 2>/dev/null || true; }; done
cp $A/jobs.json $A/archive-$TS/jobs.json
for f in $W/bots/base.json $W/bots/iron_mine.json $W/bots/iron_ledger.json $W/bots/iron_ore_log.json $W/bots/iron_audit.json; do [ -e $f ] && mv $f $A/archive-$TS/; done
[ -e $A/jobs-archive.jsonl ] && mv $A/jobs-archive.jsonl $A/archive-$TS/   # auditStructures reads it: world-1 buildings must not be "repaired" in world 2
[ -d $W/bots/iron_hb ] && { mkdir -p $A/archive-$TS/iron_hb; mv $W/bots/iron_hb/* $A/archive-$TS/iron_hb/ 2>/dev/null || true; }
: > $A/results.jsonl
echo "== seed $SEED"
sed -i "s/^level-seed=.*/level-seed=$SEED/" $S/server.properties
echo "== starting the SERVER ONLY"
setsid nohup $W/ops/run-server.sh >/dev/null 2>&1 &
for i in $(seq 1 120); do node $W/bots/rcon.js list >/dev/null 2>&1 && break; sleep 2; done
node $W/bots/rcon.js list >/dev/null 2>&1 || { echo "server did not come up"; exit 1; }
echo "== team army + gamerules + spectator datapack"
# teams: one per bot, created by ops/modes-pack.sh below (the prefix shows the job)
node $W/bots/rcon.js "gamerule keep_inventory false" "gamerule players_sleeping_percentage 1" "defaultgamemode survival" >/dev/null
$W/ops/modes-pack.sh   # spectators + /trigger goto + /trigger prank (ONE source for the datapack)
echo "== the world spawn"
SPAWN=$(NODE_PATH=$W/bots/node_modules node -e "const nbt=require('prismarine-nbt'),fs=require('fs');(async()=>{require('child_process').execFileSync('node',['$W/bots/rcon.js','save-all flush']);await new Promise(r=>setTimeout(r,2500));const d=nbt.simplify((await nbt.parse(fs.readFileSync('$S/world/level.dat'))).parsed).Data;const p=d.spawn&&d.spawn.pos?d.spawn.pos:[d.SpawnX,d.SpawnY,d.SpawnZ];console.log(p.join(','))})()")
echo "   spawn = $SPAWN"
echo "== bootstrap board (no world-1 coordinates; scouts first, the base site is CHOSEN later: armyctl.js sites -> base set -> plan-base)"
node $W/bots/army/armyctl.js bootstrap --spawn "$SPAWN" || echo "bootstrap failed - write the board by hand before ops/up.sh"
echo "NEXT: ops/up.sh   (humans are spectators; bots are team army = survival)"
