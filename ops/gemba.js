#!/usr/bin/env node
// ops/gemba.js [watchSeconds=60] - GO AND LOOK (現場), class-agnostic (owner 09-20: "明らかに効率が悪い、明らかに地形が悪いことに対してなぜあなたが気が付けないのか /
// 現場を見てない管理職だからじゃないのか？" and about per-class audits: "その解決方法だとその2件しか気が付けないのでは？").
// Every audit so far knew ONE failure class (weeds, pens, pinholes …). What the owner sees in a minute of watching needs no theory of the cause:
//   1. STILL      who did not move 1.5 blocks during the watch (task/pos/boxed; sleepers, furnace, fishing … are named as excused, not hidden)
//   2. USELESS    who produced NOTHING in 10 min (any output event of the dispatcher's OUTPUT table) - a bot can walk all day and be useless
//   3. JOBS       per job: bots, output, cells/min/bot against ONE PLAYER by hand, cells left, ETA, fails
//   4. PROGRESS   the last ~24 samples of `left` per build job (ring in bots/metrics/gemba.json): "left unchanged for 30 min", "ETA > 2 h"
// Lines that start with "!" are the ones somebody must ANSWER (they carry where to look, never a diagnosis).
// LLM-free. Library: require('./gemba.js').watch(60) -> the structured result (the inspector runs it every 10 min into REPORT.md § GEMBA);
// CLI: node ops/gemba.js [seconds]. Not a daemon. Readers: bots/metrics/inspector.js, armyctl.js `wait`, ops/escalate.sh, ops/status.sh.
'use strict'
const fs = require('fs')
const W = '/root/workspace'; const A = W + '/bots/army'; const MET = W + '/bots/metrics'
const RING = MET + '/gemba.json'
const WINDOW = 600000 // 10 min of ledger for output/cells
const KEEP = 24 // samples per job in the ring (~4 h at one sample per 10 min)

// blocks a single human player places/digs per minute on such work - the yardstick the owner uses when he says "明らかに効率が悪い"
const PLAYER = { build: 60, fill_void: 60, level: 45, clear_area: 60, platform: 60, road: 50, wall_ring: 50, quarry: 40, tidy: 30 }

// what counts as OUTPUT: the dispatcher's/base-audit's table (ops/base-audit.js § PRODUCTIVITY). Extend BOTH.
const sum = o => Object.values(o || {}).reduce((a, b) => a + (+b || 0), 0)
const OUTPUT = {
  banked: r => sum(r.items), build_pass: r => r.done, build_done: () => 1, chest_placed: () => 1, water_cell: () => 1, torch: () => 1,
  crafted_to_target: r => r.made, forged: r => sum(r.made), furnaces: r => (r.took || 0) + (r.loaded || 0), cooked: r => r.n || 1,
  farm_pass: r => ((r.st || {}).harvested || 0) + ((r.st || {}).planted || 0), cane_pass: r => (r.cut || 0) + (r.planted || 0), lumber_pass: r => (r.felled || 0) + (r.planted || 0),
  herded: r => r.n, bred: r => r.babies || r.pairs, pen_harvest: r => (r.sheared || 0) + (r.culled || 0), trip: r => (r.kills || 0) + (r.haul || 0) + (r.banked || 0),
  tidy_pass: r => (r.pillars || 0) + (r.holes || 0) + (r.floats || 0) - (r.failed || 0), tidy_fix: r => r.blocks || 0, guard_pass: r => r.kills, creeper: r => r.killed ? 1 : 0,
  stair_repaired: r => r.fixed, step: r => r.ok && !/^(goto|wait|say|equip|eat|sleep)$/.test(r.do) ? 1 : 0, scout_trip: () => 1, sampled: () => 1,
  job_slice: r => { const m = /"rawDelivered":(\d+)/.exec(r.r || ''); return m ? +m[1] : 0 }
}
// CELLS: work that moves a build/tidy job forward, comparable with what a player does by hand
const CELLS = { build_pass: r => r.done || 0, tidy_fix: r => r.blocks || 0, tidy_pass: r => (r.pillars || 0) + (r.holes || 0) + (r.floats || 0) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const writeAtomic = (f, s) => { const t = f + '.tmp' + process.pid; fs.writeFileSync(t, s); fs.renameSync(t, f) }
const rj = f => JSON.parse(fs.readFileSync(f, 'utf8'))

function hbAll () {
  const o = {}
  let l = []; try { l = fs.readdirSync(A + '/hb') } catch { return o }
  for (const f of l) { try { const h = rj(A + '/hb/' + f); if (Date.now() - h.t < 120000) o[h.bot] = h } catch {} }
  return o
}
function tailRows (maxBytes = 3e6) {
  const f = A + '/results.jsonl'; const size = fs.statSync(f).size; const from = Math.max(0, size - maxBytes)
  const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd)
  const rows = []; for (const l of buf.toString('utf8').split('\n')) { if (l.length < 20) continue; try { const r = JSON.parse(l); if (r && r.ev) rows.push(r) } catch {} }
  return rows
}
// a bot that stands STILL on purpose (its task says so) is not a finding
const EXCUSED_TASK = /sleeper|in bed|bedtime|smelt|cook|craft|fish|guard: post|furnace|canteen|handover|banking|step \d+\/\d+ (wait|craft|smelt|sleep)/i
const excusedJob = j => !!j && (j.type === 'sleeper' || (j.type === 'guard' && j.params && j.params.post))

async function watch (seconds = 60) {
  const secs = Math.max(10, +seconds || 60)
  const h0 = hbAll(); await sleep(secs * 1000); const h1 = hbAll()
  let board = { jobs: [] }; try { board = rj(A + '/jobs.json') } catch {}
  const jobs = Object.fromEntries((board.jobs || []).map(j => [j.id, j]))
  const now = Date.now()

  // ---- 1. who stands still ----
  const still = []; const byJob = {}
  for (const [n, b] of Object.entries(h1)) {
    (byJob[b.job] = byJob[b.job] || []).push(n)
    const a = h0[n]; if (!a || !a.pos || !b.pos) continue
    const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2])
    if (d >= 1.5) continue
    const task = String(b.task || '').replace(/^army:/, '').slice(0, 44)
    still.push({ bot: n, job: b.job, task, pos: b.pos.map(Math.round).join(','), boxed: !!b.boxed, frozen: Date.now() - b.t > 60000, excused: EXCUSED_TASK.test(task) || excusedJob(jobs[b.job]) })
  }
  const total = Object.keys(h1).length
  const stillBad = still.filter(s => !s.excused)

  // ---- 2./3. the ledger of the last 10 min: output per BOT, cells + output per JOB ----
  const rows = tailRows().filter(r => now - r.t <= WINDOW)
  const outBot = {}; const st = {}
  for (const r of rows) {
    const f = OUTPUT[r.ev]; const u = f ? +f(r) || 0 : 0
    if (u > 0) outBot[r.bot] = (outBot[r.bot] || 0) + u
    if (!r.job) continue
    const s = st[r.job] = st[r.job] || { cells: 0, out: 0, left: null, passes: 0, fails: 0 }
    const c = CELLS[r.ev]; if (c) { s.cells += +c(r) || 0; s.passes++ }
    if (u > 0) s.out += u
    if (r.ev === 'build_pass') { if (r.left != null) s.left = r.left; for (const k in (r.fails || {})) if (k !== 'last') s.fails += r.fails[k] }
  }
  const useless = Object.values(h1).filter(h => !(outBot[h.bot] > 0) && !excusedJob(jobs[h.job]))
    .map(h => ({ bot: h.bot, job: h.job, task: String(h.task || '').replace(/^army:/, '').slice(0, 40), pos: (h.pos || []).map(Math.round).join(',') }))

  // ---- 4. the ring: `left` over time, one JSON file, atomic ----
  let R = { ring: {}, seen: {} }; try { R = rj(RING) } catch {}
  R.ring = R.ring || {}; R.seen = R.seen || {}

  const out = []
  for (const [id, names] of Object.entries(byJob).sort((a, b) => b[1].length - a[1].length)) {
    const j = jobs[id]; const s = st[id] || { cells: 0, out: 0, left: null, passes: 0, fails: 0 }; const n = names.length
    const isWork = !!j && (j.type === 'build' || j.type === 'tidy')
    const bp = j && j.params && j.params.blueprint
    const ref = PLAYER[bp] || PLAYER[(j || {}).type] || 50
    const rate = +(s.cells / 10 / Math.max(1, n)).toFixed(2)
    const ring = isWork ? (R.ring[id] = R.ring[id] || []) : null
    // no build_pass in the window does NOT mean "no work left": carry the last known `left` forward from the ring (that is exactly the stalled case)
    const prev = ring && ring[ring.length - 1]
    const left = s.left != null ? s.left : (prev ? prev[1] : null)
    const eta = isWork && left > 0 ? (s.cells > 0 ? Math.round(left / (s.cells / 10)) : null) : null
    const idleHere = useless.filter(u => u.job === id).length
    const row = { id, type: j ? j.type : '?', bots: n, names, site: (j && j.site) || null, cells10: s.cells, rate, ref, player: ref, left, leftStale: s.left == null && left != null, eta, fails: s.fails, out10: s.out, isWork, useless: idleHere, still: stillBad.filter(x => x.job === id).length, flags: [] }

    // ring: sample `left` (coalesce samples closer than 4 min so the ring keeps spanning ~4 h)
    const slowNow = isWork && n >= 2 && (left > 0 || j.type === 'tidy') && rate < ref / 5
    if (isWork) {
      const smp = [now, left, n, rate, slowNow ? 1 : 0]
      row.slowPrev = !!(prev && prev[4])
      if (prev && now - prev[0] < 240000) ring[ring.length - 1] = smp; else ring.push(smp)
      while (ring.length > KEEP) ring.shift()
      // stalled: `left` unchanged, contiguously back from now, for >= 30 min while >= 2 bots held the job
      if (left > 0) {
        let i = ring.length - 1; let minBots = n
        while (i > 0 && ring[i - 1][1] === left) { i--; minBots = Math.min(minBots, ring[i][2] || 0) }
        const span = Math.round((now - ring[i][0]) / 60000)
        if (span >= 30 && minBots >= 2) { row.stalledMin = span; row.flags.push('stalled') }
      }
      // RUNAWAY (owner 09-20 13:2xZ "道路Erikaバグってる": base_road_9 reported 3138 cells DONE in 70 min while `left` stayed at 2 - a swap rule was digging the road into a
      // 9-deep trench and every yardstick read it as a fast, healthy job): work that is "done" far beyond what was left, with `left` not falling, is DESTRUCTION or a loop.
      if (prev && prev[1] != null && left != null && left >= prev[1] && s.cells >= Math.max(60, 5 * Math.max(left, 1))) { row.flags.push('runaway'); row.runaway = { done10: s.cells, left } }
      if (slowNow && row.slowPrev) row.flags.push('slow')
      if (eta != null && eta > 120) row.flags.push('eta')
      if (left > 0 && s.cells === 0 && n >= 2) row.flags.push('nocells')
    }
    out.push(row)
  }
  for (const id of Object.keys(R.ring)) { const r = R.ring[id]; if (!r.length || now - r[r.length - 1][0] > 6 * 3600000) delete R.ring[id] }

  // ---- the "!" lines: WHERE and WHAT TO LOOK AT, never a diagnosis ----
  const bangs = []; const eyes = (names, site) => 'node bots/army/armyctl.js look ' + (names[0] || '<bot>') + ' 14 · node bots/army/mapshot.js ' + (names[0] || '<bot>') + ' 48' + (site ? ' (site ' + Math.round(site[0]) + ',' + Math.round(site[2]) + ')' : '')
  const clump = list => { const g = {}; for (const s of list) (g[s.job + ' | ' + s.task] = g[s.job + ' | ' + s.task] || []).push(s.bot + (s.boxed ? '[BOXED]' : '') + (s.frozen ? '[no-hb]' : '') + '@' + s.pos); return Object.entries(g).sort((a, b) => b[1].length - a[1].length) }

  if (total && stillBad.length > total / 4) {
    const g = clump(stillBad).slice(0, 3).map(([k, v]) => v.length + 'x ' + k + ' ' + v.slice(0, 3).join(' '))
    bangs.push({ kind: 'army_still', key: 'army_still', text: 'STILL ' + stillBad.length + ' of ' + total + ' bots did not move 1.5 blocks in ' + secs + ' s (excused ' + (still.length - stillBad.length) + '): ' + g.join(' · '), look: eyes([stillBad[0].bot]) })
  }
  if (useless.length >= 8) {
    const g = {}; for (const u of useless) (g[u.job] = g[u.job] || []).push(u.bot)
    bangs.push({ kind: 'useless_bots', key: 'useless_bots', text: 'USELESS 10 min: ' + useless.length + ' bots produced nothing — ' + Object.entries(g).sort((a, b) => b[1].length - a[1].length).slice(0, 4).map(([k, v]) => v.length + 'x ' + k + ' (' + v.slice(0, 3).join(' ') + ')').join(' · ') + '; e.g. ' + useless[0].bot + ' "' + useless[0].task + '" @' + useless[0].pos, look: 'node bots/army/armyctl.js bot ' + useless[0].bot + ' · ' + eyes([useless[0].bot]) })
  }
  for (const r of out.filter(x => x.flags.includes('runaway'))) bangs.unshift({ kind: 'slow_job', key: 'runaway:' + r.id, job: r.id, text: 'RUNAWAY ' + r.id + ': ' + r.runaway.done10 + ' cells "done" in 10 min while left stays ' + r.runaway.left + ' - a job that digs/places far more than it has left is DESTROYING something or looping: PAUSE it (armyctl.js job ' + r.id + ' paused), then look', look: eyes(r.names, r.site) })
  for (const r of out.filter(x => x.flags.length && !x.flags.includes('runaway')).sort((a, b) => b.bots - a.bots).slice(0, 4)) {
    const why = r.flags.includes('stalled') ? 'left ' + r.left + ' UNCHANGED for ' + r.stalledMin + ' min with ' + r.bots + ' bots'
      : r.flags.includes('nocells') ? 'not one cell in 10 min with ' + r.bots + ' bots, left ' + r.left
        : r.bots + ' bots do ' + r.rate + ' cells/min/bot, ONE player does ' + r.player + (r.left != null ? ', left ' + r.left + (r.leftStale ? ' (no build pass in 10 min)' : '') : '') + (r.eta != null ? ', ETA ' + (r.eta >= 120 ? Math.round(r.eta / 60) + ' h' : r.eta + ' min') : '')
    bangs.push({ kind: 'slow_job', key: 'slow_job:' + r.id, job: r.id, text: (r.flags.includes('stalled') ? 'STALLED ' : 'SLOW ') + r.id + ': ' + why + (r.fails ? ', fails ' + r.fails : ''), look: eyes(r.names, r.site) })
  }
  for (const b of bangs) b.digest = b.kind + ' — ' + b.text + '  -> LOOK first, then act: ' + b.look

  // persist: how long each "!" has been standing (ops/escalate.sh wakes the top model on one that survives 30 min)
  const keys = new Set(bangs.map(b => b.key))
  for (const b of bangs) { const s = R.seen[b.key] || { first: now }; s.last = now; s.text = b.text.slice(0, 200); s.kind = b.kind; R.seen[b.key] = s }
  for (const k of Object.keys(R.seen)) if (!keys.has(k) && now - (R.seen[k].last || 0) > 1800000) delete R.seen[k]
  for (const b of bangs) b.standingMin = Math.round((now - (R.seen[b.key].first || now)) / 60000)

  const res = { t: now, secs, total, still, stillBad: stillBad.length, excused: still.length - stillBad.length, useless, jobs: out, bangs, board: Object.keys(jobs).length }
  res.report = render(res, 9)
  try { R.t = now; R.secs = secs; R.bangs = bangs.map(b => ({ kind: b.kind, key: b.key, job: b.job || null, text: b.text, look: b.look, digest: b.digest, standingMin: b.standingMin })); R.report = res.report; writeAtomic(RING, JSON.stringify(R)) } catch (e) { res.ringError = e.message }
  return res
}

// lines, "!" first. max = how many lines at most (the REPORT block is short, the CLI shows more)
function render (res, max = 35) {
  const L = ['GEMBA ' + new Date(res.t).toISOString().slice(11, 16) + 'Z — watched ' + res.total + ' bots for ' + res.secs + ' s (ops/gemba.js; "!" = answer it: LOOK, then say what you changed)']
  for (const b of res.bangs) L.push(('! ' + b.text + (b.standingMin >= 20 ? '  [standing ' + b.standingMin + ' min]' : '')).slice(0, 330) + '  -> ' + b.look)
  if (res.bangs.length === 0) L.push('  (nothing stands out: ' + res.stillBad + ' of ' + res.total + ' still, ' + res.useless.length + ' without output in 10 min)')
  if (L.length < max) {
    L.push('  STILL ' + res.stillBad + '/' + res.total + ' (excused ' + res.excused + ') · USELESS 10 min ' + res.useless.length + ' · jobs (bots, cells/min/bot vs ONE player, left, ETA):')
    for (const r of res.jobs) {
      if (L.length >= max) break
      L.push('  ' + (r.flags.length ? '! ' : '  ') + String(r.bots).padStart(2) + ' bots ' + r.id.padEnd(26) +
        (r.isWork ? (r.rate + '/min/bot (player ' + r.player + ')').padEnd(28) + (r.left != null ? 'left ' + r.left : '') + (r.eta != null ? '  ETA ' + r.eta + ' min' : '') + (r.fails ? '  fails ' + r.fails : '')
          : 'output ' + r.out10 + (r.useless ? '  (' + r.useless + ' bots produced nothing)' : '')) + (r.still ? '  still ' + r.still : ''))
    }
  }
  return L.slice(0, max)
}

module.exports = { watch, render, OUTPUT, PLAYER, RING }

if (require.main === module) {
  watch(+process.argv[2] || 60).then(r => console.log(render(r, 35).join('\n'))).catch(e => { console.error('gemba: ' + (e.stack || e)); process.exit(1) })
}
