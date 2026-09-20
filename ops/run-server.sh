#!/bin/sh
cd /root/workspace/server
while true; do
  ./start.sh >> console.log 2>&1 < /dev/null
  echo "server exited, restarting in 10s" >> console.log; sleep 10
done
