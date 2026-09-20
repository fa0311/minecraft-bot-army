#!/bin/bash
# ops/escalate.sh — ESCALATION TO THE TOP MODEL (LLM-free). Run it in the BACKGROUND from the main session: it blocks (zero tokens) and
# EXITS with a short reason as soon as something needs the code owner — the exit re-invokes the main session. Re-arm it after handling.
#   triggers: new open line in docs/BUGS.md by an operator/foreman (NOT helpdesk tickets, NOT the top model's own lines: author field before the first ": " contains "top model") ·
#             worker `error` events · >=3 bots `hung`/`stranded` in 10 min · deaths/1h >= 25 · damage/flood audits · a warning storm (same warning
#             >= 40x/10 min) · a NEW base-audit finding (ops/base-audit.js: audit_pen/stray/rough/growth/furniture/field/structure, kind `idle` = standing bots) · a core process down for 60 s · cooked food 0 AND >=6 bots food<=6 · no operator has called `wait` for 25 min
#   quiet rules: each KIND escalates at most once per 60 min (a NEW worker-error text is its own kind; a BROKEN EDIT only when it lasts >= 60 s).
#   usage: ops/escalate.sh [maxMinutes=120]     |     ops/escalate.sh check   = ONE dry pass: prints what would escalate / what is held back, writes nothing
W=/root/workspace; A=$W/bots/army; MAX=${1:-120}; DRY=0
[ "$1" = check ] && { DRY=1; MAX=1; }
open_bugs () { grep '^- \[ \]' $W/docs/BUGS.md 2>/dev/null | awk '{i=index($0,": "); h=(i?substr($0,1,i):$0); if (tolower(h) ~ /top model/) next; if (tolower(h) ~ /helpdesk/) next; print}'; }  # helpdesk tickets are ONE bot's failure, already answered by an LLM and read by the foreman (09-19: they woke the top model every 3 min); op/foreman lines still wake
bugs0=$(open_bugs | cut -c1-120)
pos0=$(stat -c %s $A/results.jsonl 2>/dev/null || echo 0)
[ $DRY = 1 ] && pos0=0
end=$(( $(date +%s) + MAX*60 )); down=0
while [ $(date +%s) -lt $end ]; do
  [ $DRY = 1 ] || sleep 20
  new=$(open_bugs | while IFS= read -r l; do k=$(printf '%s' "$l" | cut -c1-120); grep -qxF -- "$k" <<<"$bugs0" || printf '%s\n' "$l"; done)
  # BATCH the bug lines: operators and the foreman file one every few minutes on a busy day (09-20: 14 wake-ups in 2 h, most of them small) - the top
  # model is woken for them at most every 20 min and then reads ALL new lines at once. A line that says URGENT wakes at once.
  if [ -n "$new" ]; then
    lastb=$(cat $A/escalate.bugs.t 2>/dev/null || echo 0); nowb=$(date +%s)
    if [ $DRY = 1 ] || [ $((nowb - lastb)) -ge 1200 ] || grep -qi "urgent" <<<"$new"; then
      [ $DRY = 1 ] || echo $nowb > $A/escalate.bugs.t
      echo "ESCALATION: new bug report(s) in docs/BUGS.md:"; printf '%s\n' "$new" | tail -n 8 | cut -c1-400; exit 0
    fi
  fi
  for p in paper.jar "army/dispatcher.js" "metrics/inspector.js"; do pgrep -f "$p" >/dev/null || down=$((down+1)); done
  NSH=$(node -p "String(Math.ceil(require('/root/workspace/bots/roster.json').length/3))" 2>/dev/null || echo 10)  # expected shards follow the roster
  [ $(pgrep -fc '^node manager.js') -lt $NSH ] && down=$((down+1))
  if [ $down -ge 3 ]; then echo "ESCALATION: a core process has been down for ~60 s -> ops/status.sh, ops/up.sh"; exit 0; fi
  [ $down -gt 0 ] && pgrep -f paper.jar >/dev/null && [ $(pgrep -fc '^node manager.js') -ge $NSH ] && down=0
  out=$(DRY=$DRY node -e '
    const fs=require("fs"),A="'$A'",DRY=process.env.DRY==="1";const pos0='$pos0';const f=A+"/results.jsonl";const size=fs.statSync(f).size;const from=Math.max(pos0,size-400000);
    const fd=fs.openSync(f,"r");const buf=Buffer.alloc(size-from);fs.readSync(fd,buf,0,buf.length,from);fs.closeSync(fd);
    const cut=Date.now()-600000;const hung=new Set(),errs=[],floods=[],damage=[],storm={},broken=[],audits={};
    for(const l of buf.toString().split("\n")){let r;try{r=JSON.parse(l)}catch{continue} if(r.t<cut)continue;
      if(r.ev==="hung"||r.ev==="stranded")hung.add(r.bot+"@"+(r.job||""));
      if(r.ev==="hedge_damaged"||r.ev==="structure_damaged")damage.push(r.ev+" "+(r.job||"")+" "+(r.missing?r.missing+" cells":("bushes "+r.was+"->"+r.now)));
      // only the audit kinds that mean loss or a systemic fault wake the top model (animals out, furniture gone, a building wrong, idle army);
      // field, growth, stray and rough findings are routine upkeep: REPORT + the foreman prompt carry them every round
      if(/^audit_(pen|furniture|structure|idle)$/.test(r.ev)&&r.alert&&r.fresh)(audits[r.ev]=audits[r.ev]||[]).push(String(r.msg||r.text||"").slice(0,220));
      if(r.ev==="flood")floods.push(r.bot+" "+r.flowing+" flowing, open sources "+JSON.stringify(r.openSources||[]));
      if((r.ev==="error"||r.ev==="core_error")&&/^BROKEN EDIT/.test(String(r.err))){broken.push(r.t);continue}
      if(r.ev==="error"||r.ev==="core_error")errs.push(r.bot+": "+String(r.err).split("\n").slice(0,2).join(" ").replace(/\s+/g," ").slice(0,160));
      if(/plan_failed|declined|chest_full|chest_missing|travel_fail|no_route|plan_idle|rebuild_failed/.test(r.ev)||(r.ev==="step"&&r.ok===false)){const k=r.ev+"/"+(r.job||r.cat||"-")+"/"+String(r.why||"").replace(/[0-9]+/g,"N").slice(0,50);storm[k]=(storm[k]||0)+1}}
    const st=JSON.parse(fs.readFileSync(A+"/status.json"));const hb=fs.readdirSync(A+"/hb").map(x=>{try{return JSON.parse(fs.readFileSync(A+"/hb/"+x))}catch{return null}}).filter(h=>h&&Date.now()-h.t<180000);
    let idx={};try{idx=JSON.parse(fs.readFileSync(A+"/chests.json"))}catch{}
    const cooked=Object.values(idx).reduce((n,v)=>n+Object.entries(v.items||{}).filter(([k])=>/^(cooked_|bread$)/.test(k)).reduce((a,[,c])=>a+c,0),0);
    const starving=hb.filter(h=>h.food<=6).length;
    const waits=fs.readdirSync(A).filter(x=>/^attention\..*\.json$/.test(x)).map(x=>fs.statSync(A+"/"+x).mtimeMs);const lastWait=waits.length?Math.max(...waits):0;
    const sf=A+"/escalate.seen.json";let seen={};try{seen=JSON.parse(fs.readFileSync(sf))}catch{}
    const TTL=3600000;const msg=[];const held=[];   // msg: [kind,text]
    const loud=Object.entries(storm).filter(([,n])=>n>=40).sort((a,b)=>b[1]-a[1]).slice(0,4);
    if(loud.length)msg.push(["storm","WARNING STORM (same warning >=40x in 10 min = nobody is resolving it): "+loud.map(([k,n])=>n+"x "+k).join(" ; ")]);
    if(damage.length)msg.push(["damage","DAMAGE to what the army built/planted (mobs, or one of our own jobs undoes another): "+[...new Set(damage)].slice(-4).join(" | ")]);
    if(floods.length)msg.push(["flood","FLOOD on a farm (flowing water where only capped holes belong): "+floods.slice(-2).join(" | ")]);
    // BASE AUDIT (ops/base-audit.js, camera + books, every ~30 min): a NEW finding (not an alert at the last audit, or clearly worse) wakes once per kind per 60 min
    for(const [ev,l] of Object.entries(audits))msg.push([ev==="audit_idle"?"idle":"audit:"+ev.slice(6),"BASE AUDIT "+ev.slice(6).toUpperCase()+" (camera: plan vs world; details `armyctl.js events 20 audit`, REPORT.md, picture /tmp/base-audit.png): "+[...new Set(l)].slice(-3).map(x=>x.slice(0,200)).join(" | ")]);
    // GEMBA (ops/gemba.js, one 60 s watch every 10 min): a "!" line that is STILL standing 30 min after the operator was told is not an operator
    // problem any more - the board alone cannot fix it (a job crawling at 1/40 of a player, a quarter of the army standing, bots without output)
    try{const G=JSON.parse(fs.readFileSync("'$W'/bots/metrics/gemba.json","utf8"));
      if(Date.now()-G.t<25*60000&&Date.now()-lastWait<35*60000){const old=(G.bangs||[]).filter(b=>b.standingMin>=30);
        if(old.length)msg.push(["gemba","GEMBA (measured by WATCHING the field, REPORT.md section GEMBA): "+old.length+" finding(s) still standing 30+ min after the operator was told - the board alone is not fixing it: "+old.slice(0,3).map(b=>b.text.slice(0,200)+" ["+b.standingMin+" min]").join(" | ")+" -> LOOK (node bots/army/mapshot.js <bot> 48, armyctl.js look), then fix the CODE or the plan, not the head-count"])}}catch(e){}
    if(errs.length){const last=errs[errs.length-1];msg.push(["error:"+last.replace(/^[^:]*: /,"").replace(/[0-9]+/g,"N").slice(0,60),"worker errors (code bug): "+errs.slice(-3).join(" | ")])}
    // a half-written file seen by the hot-reloader for a few seconds is somebody saving, not a bug: only a file that STAYS broken (>= 60 s, still failing) wakes
    if(broken.length&&broken[broken.length-1]-broken[0]>=60000&&Date.now()-broken[broken.length-1]<90000)msg.push(["broken","BROKEN EDIT for "+Math.round((broken[broken.length-1]-broken[0])/1000)+" s and still failing: a lib file does not parse, the bots run the last good copy -> ops/check.sh"]);
    if(hung.size>=3)msg.push(["hung",hung.size+" bots hung/stranded in 10 min: "+[...hung].slice(0,8).join(" ")]);
    if(st.deaths1h>=25)msg.push(["deaths","deaths/1h = "+st.deaths1h+" "+JSON.stringify(st.deathsByJob)+" -> causes: node bots/army/armyctl.js deaths 60"]);
    if(cooked===0&&starving>=6)msg.push(["food","no cooked food in stock and "+starving+" bots at food<=6"]);
    if(Date.now()-lastWait>25*60000)msg.push(["nosteer","no operator has called `armyctl.js wait` for 25 min — nobody is steering the army: (re)start operators"]);
    const fresh=[];for(const [kind,text] of msg){if(Date.now()-(seen[kind]||0)<TTL){held.push(kind+" (reported "+Math.round((Date.now()-seen[kind])/60000)+" min ago)");continue}seen[kind]=Date.now();fresh.push(text)}
    if(DRY){console.log("check:\n would escalate: "+(fresh.length?"\n  + "+fresh.join("\n  + "):"nothing")+"\n held back (once per 60 min): "+(held.join(" ; ")||"-"));process.exit(0)}
    if(fresh.length){for(const k of Object.keys(seen))if(Date.now()-seen[k]>6*TTL)delete seen[k];fs.writeFileSync(sf,JSON.stringify(seen));
      console.log("ESCALATION: "+fresh.join("\n  + "))}' 2>/dev/null)
  if [ $DRY = 1 ]; then echo "$out"; echo " new BUGS.md lines that would wake: $( [ -n "$new" ] && echo yes || echo none ) (open lines by others: $(open_bugs | wc -l), top model's own open lines ignored: $(( $(grep -c '^- \[ \]' $W/docs/BUGS.md) - $(open_bugs | wc -l) )))"; exit 0; fi
  if [ -n "$out" ]; then echo "$out"; exit 0; fi
done
echo "escalate.sh: nothing to escalate in $MAX min — re-arm me"
