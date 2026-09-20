#!/bin/bash
# ops/status.sh — the ONE look at the system. LLM-free, <= 60 lines. Read this before anything else.
#   processes -> army board (who does what) -> inspector headline + FIELD ANOMALIES + top problems
W=/root/workspace
p () { pgrep -f "$1" >/dev/null && echo "  ok    $2" || echo "  DOWN  $2   -> ops/up.sh"; }
# GEMBA FIRST (ops/gemba.js through the inspector): who stands, which job crawls, who produces nothing. "!" lines are the ones to ANSWER.
[ -f $W/REPORT.md ] && sed -n '/^## GEMBA/,/^$/p' $W/REPORT.md | grep -E '^(## GEMBA|!|  \()' | cut -c1-320 | head -6
echo "## processes"
p paper.jar "minecraft server"
p "army/dispatcher.js" "dispatcher"
NSH=$(node -p "String(Math.ceil(require('/root/workspace/bots/roster.json').length/3))" 2>/dev/null || echo '?')  # expected shards follow the roster (50 bots = 17); a hard-coded 10 made "17/10" look normal and would hide a real loss
HAVE=$(pgrep -fc '^node manager.js'); [ "$HAVE" = "$NSH" ] || echo "  !! SHARDS: $HAVE of $NSH manager shards are running"
echo "  $HAVE/$NSH manager shards, router $(pgrep -f '^node router.js' >/dev/null && echo ok || echo DOWN)"
p "metrics/inspector.js" "inspector"
p "shard-watchdog.sh" "shard watchdog"
pgrep -f bots/chatter.js >/dev/null && echo "  ok    chatter (LLM: haiku, only when a spectator speaks)" || echo "  off   chatter"
echo
if [ -f $W/bots/army/BOARD.md ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y $W/bots/army/BOARD.md) ))
  [ "$AGE" -gt 120 ] && echo "WARNING: BOARD.md is ${AGE}s stale"
  # ACTIVE jobs only, rows cut to 190 chars; paused jobs become one line (the full board: bots/army/BOARD.md)
  sed -n '1p' $W/bots/army/BOARD.md
  sed -n '/^| pri/,/^$/p' $W/bots/army/BOARD.md | awk -F'|' 'NR==1 {print "| pri | job | type | staffed | banked 1h | plan"} NR>2 && $6 ~ /active/ {print "|"$2"|"$3"|"$4"|"$(NF-2)"|"substr($(NF-1),1,50)"|"substr($7,1,70)} NR>2 && $6 ~ /paused/ {n++; ids=ids" "$3} END {gsub(/  +/," ",ids); if (n) print "paused ("n"):" substr(ids,1,400)}'
  # bots: one line per job instead of 30 rows
  node -e '
    const fs=require("fs"),d="'$W'/bots/army/";const st=JSON.parse(fs.readFileSync(d+"status.json"));
    const hb=fs.readdirSync(d+"hb").map(f=>{try{return JSON.parse(fs.readFileSync(d+"hb/"+f))}catch{return null}}).filter(h=>h&&Date.now()-h.t<120000);
    const weak=hb.filter(h=>h.hp<=6||h.food<=6).map(h=>h.bot+"(hp"+h.hp+"/f"+h.food+")");
    const by={};for(const h of hb)(by[h.job]=by[h.job]||[]).push(h.bot);
    console.log("bots: "+hb.length+" heartbeating | deaths/1h "+st.deaths1h+" "+JSON.stringify(st.deathsByJob));
    for(const[j,l]of Object.entries(by))console.log("  "+j.padEnd(16)+l.length+"  "+l.join(" "));
    if(weak.length)console.log("weak: "+weak.join(" "));
    const cut=Date.now()-30*60000,tr={};
    for(const l of fs.readFileSync(d+"results.jsonl","utf8").trim().split("\n").slice(-3000)){try{const r=JSON.parse(l);if(r.t>cut&&(r.ev==="stranded"||r.ev==="no_route")){
      // a bot that has moved on since is no longer stranded (a stale flag got healthy bots rescue-killed): it must still stand within 4 blocks of the report
      const h=hb.find(x=>x.bot===r.bot);if(r.ev==="stranded"&&h&&h.pos&&Array.isArray(r.at)&&Math.hypot(h.pos[0]-r.at[0],h.pos[2]-r.at[2])>4)continue;
      (tr[r.ev]=tr[r.ev]||new Set()).add(r.bot)}}catch{}}
    if(tr.stranded)console.log("STRANDED (boxed in, could not escape): "+[...tr.stranded].join(" ")+"   -> node bots/army/armyctl.js rescue <bot>");
    if(tr.no_route)console.log("no_route (walkable but no path to target): "+[...tr.no_route].join(" ")+"   -> needs a road/stairs job, see docs/DEV.md 4");
  ' 2>/dev/null
fi
echo
R=$W/REPORT.md
if [ -f $R ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y $R) ))
  [ "$AGE" -gt 300 ] && echo "WARNING: REPORT.md is ${AGE}s stale"
  sed -n '1,4p' $R
  sed -n '/^## FIELD ANOMALIES/,/^$/p' $R | head -5
  sed -n '/^## Top problems/,/^$/p' $R | head -6
fi
