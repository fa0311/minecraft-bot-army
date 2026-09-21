#!/bin/bash
# ops/check.sh — run after EVERY code edit: syntax + real load of every production file (a syntax-valid file can still fail to load).
cd /root/workspace/bots || exit 1; bad=0
for f in skills/army_worker.js skills/iron_miner.js skills/lib/*.js skills/core/*.js army/dispatcher.js army/armyctl.js army/plan.js metrics/inspector.js manager.js blueprints/*.js; do node --check "$f" 2>/dev/null || { echo "SYNTAX  $f"; bad=1; }; done
node -e 'for (const m of ["swallow","util","army","army_jobs","blocks","craft","base","feed","fishery","iron_core","look"]) { try { require("/root/workspace/bots/skills/lib/" + m + ".js") } catch (e) { console.log("LOAD    lib/" + m + ".js: " + e.message.split("\n")[0]); process.exitCode = 1 } }' || bad=1
node /root/workspace/tests/unknown_cells.js >/dev/null || { echo "TEST    tests/unknown_cells.js (an unknown cell is read as air/passable/done)"; bad=1; }
node /root/workspace/ops/lint-catch.js > /tmp/lint-catch.out 2>&1 || { echo "LINT    $(tail -1 /tmp/lint-catch.out)"; [ -n "$STRICT_LINT" ] && bad=1; }
[ $bad = 0 ] && echo "check: all production files parse and load" || { echo "check: FAILED — fix before anything else (all 50 bots hot-load these files)"; exit 1; }
