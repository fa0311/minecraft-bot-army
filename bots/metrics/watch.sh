#!/bin/sh
# Compact one-line-per-minute OUTPUT pulse for the inspector agent. usage: watch.sh <minutes>
N=${1:-9}; i=0
while [ $i -lt $N ]; do
  sleep 60; i=$((i+1))
  python3 - <<'PY'
import json
try: d=json.load(open('/root/workspace/bots/metrics/latest.json'))
except Exception as e: print('latest.json unreadable', e); raise SystemExit
g1=d['boards']['g1']; g2=d['boards']['g2']
tm=' '.join('%s:%s'%(t[:2],v['banked30']) for t,v in d['perTeam'].items())
dc=(d.get('moderation') or {}).get('deathsByCause') or {}
bl=' '.join('%s:%s%%'%(j['id'],j['pct']) for j in d['build'] if j['status']=='running')
print('%s bank30 %-4s food %-3s inflow %-5s str %-3s rods %-3s beds %-2s | iron %sraw/%sing y%s | torch/h %-4s deaths/h %-4s hungry %-3s | %s | %s'%(
 d['t'][11:19], d['banked30']['total'], g1['edibleBanked2h'], g1['inflowPerMin'], g1['string']['held'],
 g1['rods']['held'], g1['beds']['held']+g1['beds']['placed'], g2['raw_iron'], g2['ingots'], g2['shafts'],
 g1['torchesPlaced1h'], sum(dc.values()), g1['hungry'], tm, bl))
PY
done
