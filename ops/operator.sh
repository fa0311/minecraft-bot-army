#!/bin/bash
# ops/operator.sh — the FIELD OPERATOR as a daemon of short, fresh, capped LLM sessions (replaces long-lived operator agents, which grew
# their context with every wake-up: one burned ~240k tokens for zero torches on 09-19).
#   loop: `armyctl.js wait` blocks at ZERO tokens -> a digest appears -> ONE headless `claude -p` session (cheap model) handles exactly that
#   digest and ends. Fresh context every time (runbook ~9 KB + digest), hard turn cap, tools restricted to the operator CLI + reading docs +
#   appending to docs/BUGS.md. It cannot edit code, cannot spawn agents. Code problems reach the top model through docs/BUGS.md (ops/escalate.sh).
# usage: ops/operator.sh [name=op] [topics=""] [model=sonnet]     start: setsid nohup ops/operator.sh op >/dev/null 2>&1 &     stop: pkill -f ops/operator.sh
W=/root/workspace; NAME=${1:-op}; TOPICS=${2:-}; MODEL=${3:-sonnet}; LOG=$W/ops/operator.$NAME.log
MAX_TURNS=${MAX_TURNS:-30}; MIN_GAP=${MIN_GAP:-180}   # at most one session per 3 min
cd $W || exit 1
while true; do
  DIGEST=$(node bots/army/armyctl.js wait "$NAME" 900 "$TOPICS" 2>/dev/null)
  case "$DIGEST" in ""|nothing\ needs\ attention*) continue;; esac
  echo "=== $(date -Is) digest ===" >> $LOG; echo "$DIGEST" >> $LOG
  # SEVERAL SONNET OPERATORS, ONE TOPIC EACH (owner 09-20: "sonnet5活用してる？全然活用してないから..."): more cheap eyes on the field, each owning the jobs whose ids start
  # with its prefixes (ops/operator.topics: one line per topical operator `name prefixes`); the general operator (no topics) leaves those jobs to their owners.
  if [ -n "$TOPICS" ]; then OWN="You own ONLY the jobs whose id starts with one of: $TOPICS - never edit another job; what you see elsewhere goes to docs/BUGS.md. For your jobs you are the site lead: after handling the digest, LOOK at one bot of each of your active jobs (armyctl.js look <bot> 12, or mapshot) and ask what a good player would do differently there (a way in, material nearer, fewer or more hands, a wrong order) - change the board or file the code bug with evidence. "
  else OWN="Other operators own the jobs whose ids start with: $(cut -d' ' -f2- $W/ops/operator.topics 2>/dev/null | tr '\n' ',' ) - do not edit those jobs. "; fi
  PROMPT="You are the field operator '$NAME' of the Minecraft bot army in /root/workspace. $OWN (your runbook CLAUDE.md is already loaded). HARD RULES (owner 09-20, after an operator session paused the base's biggest job for being slow and parked its crew): NEVER pause a job because it is slow or has many fails - pausing parks bots; lower its bots to what it can use, or file the code bug in docs/BUGS.md. Pause ONLY for destruction (a RUNAWAY line, a job undoing another) or deaths piling up on it. More than 3 fit bots on muster by day = raise the head-count of a big always-doable squad job (hill cut / terrace, a fill with a way in) before anything else. This is ONE short session: handle the digest below, then stop.
START with 'ops/status.sh': its FIRST lines are the GEMBA block (ops/gemba.js watches the field for 60 s every 10 min: who STANDS, which job CRAWLS against one player digging by hand, who produced NOTHING in 10 min). Every line there that begins with '!' must be ANSWERED in this session, before the digest: LOOK at what it names ('armyctl.js look <bot> 14', 'armyctl.js bot <bot>'), then change the board (bots, params, pause the job, a steps plan) - or, if only code can fix it, ONE evidence line in docs/BUGS.md. Your summary must say, per '!' line, what you SAW and what you CHANGED; an '!' line answered from numbers alone is not answered. Rules: act only through 'node bots/army/armyctl.js …' (look/ground/stock/recipe/howto/who/bot/template/put/patch/job/rm/chest/rescue/events/deaths/errors/mine/animals/sites); create jobs with \"armyctl.js putjson '<json>'\" (you cannot write files); never edit code; a suspected code bug or anything you cannot fix with the board = append ONE evidence line to docs/BUGS.md (that escalates to the code owner) and move on — but FIRST grep docs/BUGS.md for the same bot/coordinates/symptom: if it is already there (open or answered in a 'note (top model)' line), do NOT log it again (duplicate reports wake the code owner for nothing). An 'info:' line in the digest is CONTEXT, not a task. Damage audits (structure_damaged, hedge_damaged, crops_vanished, flood) mean mobs or one of our own jobs: LOOK first ('look'), the structure's own re-activated build job is the repair - keep it staffed, never add a second job. A no_route from a bot that is underground (y < 58) is a cave problem the bots escape from by themselves, not a missing road. Do not wait or poll — verify at most once with 'armyctl.js events 15', then end with a 3-line summary of what you changed. Never raise priorities to take bots from other jobs; use squad jobs' 'bots'. Owner's orders: all 50 bots working in big squads; work the FIRST open roadmap phase in docs/GOALS.md.

DIGEST (from armyctl.js wait):
$DIGEST"
  timeout 900 claude -p "$PROMPT" --model "$MODEL" --max-turns $MAX_TURNS \
    --allowedTools "Bash(node bots/army/armyctl.js:*)" "Bash(ops/status.sh:*)" "Read" "Grep" "Edit(/tmp/**)" "Edit(docs/BUGS.md)" \
    --disallowedTools "Agent" "Task" "WebFetch" "WebSearch" < /dev/null >> $LOG 2>&1
  echo "=== $(date -Is) session ended rc=$? ===" >> $LOG
  [ "$(stat -c%s $LOG)" -gt 2000000 ] && tail -c 500000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG
  sleep $MIN_GAP
done
