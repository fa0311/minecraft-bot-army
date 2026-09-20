#!/bin/bash
# ops/up.sh — bring the WHOLE system up from cold. Idempotent: anything already running is left alone.
#   ops/up.sh            server + bots + dispatcher + inspector + shard watchdog
#   (the chatter, operator, help desk and foreman are the LLM consumers; all idle at zero tokens until something needs judgement)
# Everything here is LLM-free and auto-restarting. Stop with ops/down.sh. Look with ops/status.sh.
W=/root/workspace
up () { # up <pgrep pattern> <label> <command...>
  local pat=$1 label=$2; shift 2
  # only a process that IS the daemon counts (bash/sh/node/java as the command): a plain `pgrep -f` also matches the caller's own shell line when it names the script
  # (09-20: the operator daemon stayed down after a restart because the restarting command contained "ops/operator.sh")
  if pgrep -f "^(/bin/|/usr/bin/)?(bash|sh|node|java)( .*)? [^ ]*$pat" >/dev/null; then echo "  = $label already running"; else setsid nohup "$@" >/dev/null 2>&1 & echo "  + $label started"; fi
}
command -v java >/dev/null || { echo "java missing: apt-get install -y openjdk-25-jdk-headless (Paper 26.x needs Java 25)"; exit 1; }
[ -d $W/bots/node_modules ] || { echo "node_modules missing: (cd $W/bots && npm ci && sh patches/apply.sh)"; exit 1; }

up "run-server.sh" "server loop" $W/ops/run-server.sh
echo -n "  waiting for the server"
for i in $(seq 1 90); do node $W/bots/rcon.js list >/dev/null 2>&1 && break; echo -n .; sleep 2; done; echo
node $W/bots/rcon.js list >/dev/null 2>&1 || { echo "server did not come up — see server/console.log"; exit 1; }

up "army/run-dispatcher.sh" "dispatcher" $W/bots/army/run-dispatcher.sh
up "run-manager.sh" "bot managers (roster/3 shards + router :3000)" $W/ops/run-manager.sh
up "shard-watchdog.sh" "shard watchdog" $W/ops/shard-watchdog.sh
up "metrics/run-inspector.sh" "inspector (REPORT.md)" $W/bots/metrics/run-inspector.sh
up "ops/operator.sh op( |$)" "field operator daemon (fresh capped sonnet sessions, only when a digest needs judgement)" $W/ops/operator.sh op
# topical SONNET operators (ops/operator.topics): one site lead per front, event-driven like the general one (zero tokens while nothing needs judgement)
while read -r NAME TOPICS; do [ -n "$NAME" ] && up "ops/operator.sh $NAME " "operator $NAME ($TOPICS)" $W/ops/operator.sh "$NAME" "$TOPICS"; done < $W/ops/operator.topics
up "ops/helpdesk.js" "help desk (LLM answers bots' failure tickets; remedies are cached by signature)" sh -c "node $W/ops/helpdesk.js >> $W/ops/helpdesk.log 2>&1"
up "ops/foreman.sh" "foreman (INSPECTOR: strong model looks at rendered maps every 60 min, READ-ONLY, files findings)" $W/ops/foreman.sh
up "run-chatter.sh" "chatter (haiku answers PLAYERS in character; zero tokens while nobody speaks)" $W/ops/run-chatter.sh
echo "done. ops/status.sh in ~1 min."
