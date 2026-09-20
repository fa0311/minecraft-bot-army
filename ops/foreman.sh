#!/bin/bash
# ops/foreman.sh — the FOREMAN (現場監督): a smart reviewer that LOOKS at the field the way the owner does, so the owner does not have to.
# Every $EVERY seconds it renders top-down MAP IMAGES of the key sites through nearby bots, then starts ONE fresh headless session on a strong
# model that reads those images + status + deaths + swallowed errors and behaves like a demanding senior player: what is ugly, wasteful, dangerous,
# too small (x50 rule!), half-finished, flooded, floating, idle? It FIXES what the board can fix (armyctl putjson/patch) and writes every code-level
# finding as one evidence line to docs/BUGS.md (that wakes the code owner through ops/escalate.sh). Log: ops/foreman.log
#   start: setsid nohup ops/foreman.sh >/dev/null 2>&1 &     stop: pkill -f ops/foreman.sh
W=/root/workspace; LOG=$W/ops/foreman.log; EVERY=${EVERY:-1500}; MODEL=${MODEL:-opus}; SITES=${SITES:-}
cd $W || exit 1
# sites to look at = the board: muster (base) + the site of every ACTIVE job, one per ~48-block neighbourhood, at most 6 (override: SITES="name:x,z …")
board_sites () { node -e 'const b=require("'$W'/bots/army/jobs.json");const out=[];const add=(n,x,z)=>{if(![x,z].every(Number.isFinite)||out.some(o=>Math.hypot(o[1]-x,o[2]-z)<48))return;out.push([n,Math.round(x),Math.round(z)])};const m=(b.settings||{}).muster;if(m)add("base",m.x,m.z);for(const j of (b.jobs||[]).filter(j=>j.status==="active"&&Array.isArray(j.site)).sort((a,c)=>(c.bots||1)-(a.bots||1)))add(j.id,j.site[0],j.site[2]);console.log(out.slice(0,6).map(o=>o[0]+":"+o[1]+","+o[2]).join(" "))' 2>/dev/null; }
while true; do
  [ -n "$SITES" ] || SITES_NOW=$(board_sites); [ -n "$SITES" ] && SITES_NOW=$SITES
  D=/tmp/foreman; mkdir -p $D; rm -f $D/*.png; LIST=""
  for s in $SITES_NOW; do n=${s%%:*}; xz=${s#*:}; B=$(node bots/army/armyctl.js who near:$xz n:1 | sed -n 2p | awk '{print $1}'); d=$(node bots/army/armyctl.js who near:$xz n:1 | sed -n 2p | awk '{print $2}' | tr -d d)
    [ -n "$B" ] && [ "${d:-999}" -lt 60 ] && node bots/army/mapshot.js $B 44 $D/$n.png 8 > $D/$n.txt 2>&1 && LIST="$LIST $D/$n.png($(head -1 $D/$n.txt | cut -d' ' -f3-))"; done
  # a BLIND foreman is worse than none (12:20Z: the round started during a server restart, all 5 renders failed, the model fell back to ASCII):
  # no map at all -> say why in the log, wait 2 min and try the round again instead of spending an Opus session without eyes
  if [ -z "$LIST" ]; then echo "=== $(date -Is) foreman: NO MAPS ($(cat $D/*.txt 2>/dev/null | head -c 120 | tr '\n' ' ')) - retry in 120 s ===" >> $LOG; sleep 120; continue; fi
  # THE BASE AUDIT first, LLM-free (ops/base-audit.js: plan vs WORLD through the spectator camera at 1 block/px - what 6 px/block colour maps do not show:
  # a 1-block bump, a stray block, sheep outside a fence, furnaces that are air, a farm in unloaded chunks, jobs that hold bots without output).
  # A result younger than 10 min is reused; its alert lines and its picture go into the prompt.
  AGE=$(node -p 'try{Math.round((Date.now()-require("'$W'/bots/army/base_audit.json").t)/60000)}catch(e){999}' 2>/dev/null || echo 999)
  [ "${AGE:-999}" -ge 10 ] && timeout 150 node ops/base-audit.js > $D/base-audit.txt 2>&1
  AUDIT=$(node -e 'const A=require("'$W'/bots/army/base_audit.json");const age=Math.round((Date.now()-A.t)/60000);if(age>45)process.exit(0);const al=(A.findings||[]).filter(f=>f.alert);console.log("BASE AUDIT ("+age+" min old, "+al.length+" alerts; the machine measured these, you do not need to re-measure - judge, fix via the board, file what needs code):");for(const f of al.slice(0,14))console.log("- "+(f.fresh?"NEW ":"")+String(f.text).slice(0,700));console.log("PICTURE (Read it): "+A.legend)' 2>/dev/null)
  [ -n "$AUDIT" ] || AUDIT="BASE AUDIT: no fresh result ($(tail -c 200 $D/base-audit.txt 2>/dev/null | tr '\n' ' ')) - say so in your summary; the camera audit must not stay blind."
  # GEMBA (ops/gemba.js through the inspector, every 10 min): the class-agnostic look - who STANDS, which job CRAWLS against one player by hand,
  # who produced NOTHING. Its "!" lines are what the owner notices in a minute of watching; the foreman answers them before anything else.
  GEMBA=$(sed -n '/^## GEMBA/,/^$/p' $W/REPORT.md 2>/dev/null | head -10)
  [ -n "$GEMBA" ] || GEMBA="## GEMBA: no watch on record (the inspector writes one every 10 min) - say so in your summary."
  echo "=== $(date -Is) foreman round, maps:$LIST audit: $(printf '%s' "$AUDIT" | head -1 | cut -c1-80) gemba: $(printf '%s' "$GEMBA" | grep -c '^!') ! lines ===" >> $LOG
  PROMPT="You are the FOREMAN (現場監督) of a 50-bot Minecraft survival army in /root/workspace (runbook CLAUDE.md is loaded; docs/GOALS.md has the doctrine, the x50 SCALE RULE and the roadmap). The owner is tired of being the only one who notices problems. Do what he does: LOOK, then nag and fix.
0. START HERE — $GEMBA
   Every line above that begins with '!' was MEASURED by watching the field (still bots, cells/min/bot against ONE player by hand, bots with zero output, jobs whose 'left' does not move). Answer EACH of them in this round, before anything else: LOOK at the place it names (the map images in step 1, 'armyctl.js look <bot> 14', 'node bots/army/mapshot.js <bot> 48'), then act. In your summary write one line per '!' line: what you SAW and what you CHANGED on the board (or why it is in fact fine). An '!' line answered from numbers alone is not answered; one that only CODE can fix goes to docs/BUGS.md.
   FOREMAN'S HARD RULES (owner 09-20: '現場監督無能すぎだろ' - this afternoon a foreman round PAUSED the biggest job of the base (fill_ravine_s) because it was slow, which parked its crew at muster; re-opened a finished tile three times on a camera cluster that lay outside its box; and never noticed 11 fit bots idling at muster): (a) IDLE FIRST: more than 3 fit bots on job muster by day is the worst finding there is - before anything else make sure a big always-doable squad job is active with room (a hill cut / terrace, a fill with a working way in, lumber, a road) and say which one takes them. (b) A job whose `desc` starts with OWNER-LOCKED is never re-activated, re-staffed or edited by you. NEVER raise a head-count to make idle bots look busy: a job gets only as many bots as its OPEN work can use now (the owner sees through it: '建設タスク入れて適当に歩かせてごまかすな'). NEVER PAUSE A JOB BECAUSE IT IS SLOW - pausing parks bots. Lower its bots to what the open work can use, give it what it lacks (a way in: ramp + keep boxes; material; light), or file the code bug; pause ONLY for destruction (a RUNAWAY line, a job undoing another job) or deaths piling up. (c) VERIFY OR REVERT: every board change you make is checked in the same round after at least 3 minutes (look again, events of that job); a change that did not move the number is reverted and said so. (d) NEVER re-open a job that reports complete without a probe ON THE SPOT that shows a cell of ITS OWN blueprint unfinished (a camera cluster next to a job belongs to nobody: it needs its own small job). (e) Say what you did not check.
0b. $AUDIT
1. Read these freshly rendered top-down map images with the Read tool (legend: brighter = higher; dark lines = height steps >= 2; RED boxes = floating blocks; white squares = bots; magenta = mobs; yellow = torches; blue = water; yellow-brown band = wheat; tan = wood/barrels/chests; grey = cobblestone; white dashed grid every 16 blocks):$LIST
2. Run: ops/status.sh ; node bots/army/armyctl.js deaths 30 ; node bots/army/armyctl.js errors 8 ; node bots/army/armyctl.js stock 'bread|cooked|wheat|seeds|string|rod|iron_ingot|diamond|barrel|_log' ; node bots/army/armyctl.js events 30
3. Judge like a demanding veteran player (start with the GEMBA '!' lines of step 0, then the BASE AUDIT alerts of step 0b - each one is a measured fact with coordinates; an alert that is still there from the last round and has no job working on it is YOUR failure): floods, stray water, floating blocks/tree crowns, junk pillars, holes, unfinished walls, trees standing on fields, tiny things that should be x50, bots standing still in a clump, sites on uneven ground (one site = ONE height: level first), death causes that repeat, jobs that produce nothing, storage overflow, missing light.
4. Act: what the job board can fix, fix now with 'node bots/army/armyctl.js putjson|patch|job' (templates: 'armyctl.js template <kind>', blueprints: 'armyctl.js blueprints'; coordinates ONLY from the maps' grid, 'armyctl.js ground/look'). What needs CODE, append as ONE evidence line each to docs/BUGS.md ('- [ ] <time> foreman: <what you SAW, where (coords), why it is wrong, what should exist instead>'). Never edit code. Max 5 actions + 5 findings per round, most harmful first.
5. End with a summary: ONE line per GEMBA '!' line (saw / changed) + 5 lines for the rest."
  timeout 1500 claude -p "$PROMPT" --model "$MODEL" --max-turns 80 \
    --allowedTools "Bash(node bots/army/armyctl.js:*)" "Bash(ops/status.sh:*)" "Read" "Grep" "Edit(docs/BUGS.md)" \
    --disallowedTools "Agent" "Task" "WebFetch" "WebSearch" < /dev/null >> $LOG 2>&1
  echo "=== $(date -Is) foreman round ended rc=$? ===" >> $LOG
  [ "$(stat -c%s $LOG)" -gt 2000000 ] && tail -c 500000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG
  sleep $EVERY
done
