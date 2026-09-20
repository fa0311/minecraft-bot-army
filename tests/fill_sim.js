'use strict'
// tests/fill_sim.js — a voxel world + N simulated builders + the test suite for lib/fill_plan.js.
// Run:  node tests/fill_sim.js            (all scenarios)
//       node tests/fill_sim.js b e        (only those)
//       node tests/fill_sim.js --trace b  (print every action of the first 200 ticks)
// No server, no mineflayer, no network: the planner is pure, so it can be measured on a table.
//
// What the simulator is: a block grid, builders with a position, pockets and a busy clock, and the
// physics that matter for this job — reach 4.5, line of sight by sampling, walking 4 blocks/s with
// step-up 1 / drop 3, ladders at 2 blocks/s, placing 4/s, a restock trip of distance/4 + 10 s, gravity
// for falling blocks AND for builders (a fall over 3 counts as damage). Effects are applied when an
// action STARTS and the builder is busy for the action's duration — a throughput model, not a physics
// engine; it measures the plan, not the client.
//
// INVARIANTS (checked on every tick, any breach fails the run):
//   1 no builder is ever entombed (walkable area >= 4)
//   2 no block is placed with air beneath it (only the entry ladder hangs on a wall)
//   3 no cell is dug after the fill placed it (no dig/place loops)
//   4 two builders never target the same cell, nor two cells sharing a face, in one tick
//   5 the fill TERMINATES: every reachable cell stands at grade
//   6 every builder that stayed ends on top, at grade

const FP = require('../bots/skills/lib/fill_plan.js')

const K3 = (x, y, z) => x + ',' + y + ',' + z
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// ---------------------------------------------------------------- the world

class World {
  // ground(x,z) -> y of the topmost solid block of the natural column
  constructor (ground) { this.ground = ground; this.m = new Map(); this.version = 0 }
  get (x, y, z) {
    const k = K3(x, y, z)
    if (this.m.has(k)) return this.m.get(k)
    return y <= this.ground(x, z) ? 'solid' : 'air'
  }
  set (x, y, z, v) { this.m.set(K3(x, y, z), v); this.version++ }
  sky (x, z) { // the y of the topmost solid block — everything above it sees the sky
    for (let y = 320; y > -64; y--) if (this.get(x, y, z) === 'solid') return y
    return -64
  }
}

function rng (seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

// ---------------------------------------------------------------- walking (the same rules as the planner)

function bfs (map, world, from, limit = 4000) {
  const dist = new Map([[K3(from.x, from.y, from.z), 0]])
  const q = [from]
  while (q.length && dist.size < limit) {
    const p = q.shift()
    const d = dist.get(K3(p.x, p.y, p.z))
    const onLadder = world.get(p.x, p.y, p.z) === 'ladder'
    if (onLadder) {
      for (const dy of [1, -1]) {
        const ny = p.y + dy
        if (world.get(p.x, ny, p.z) !== 'ladder' && !FP.canStand(map, world, p.x, ny, p.z)) continue
        const k = K3(p.x, ny, p.z)
        if (!dist.has(k)) { dist.set(k, d + 1); q.push({ x: p.x, y: ny, z: p.z }) }
      }
    }
    for (const [dx, dz] of SIDES) {
      const nx = p.x + dx; const nz = p.z + dz
      for (let dy = 1; dy >= -map.o.maxDrop; dy--) {
        const ny = p.y + dy
        if (dy === 1 && world.get(p.x, p.y + 2, p.z) === 'solid') break
        if (world.get(nx, ny, nz) === 'ladder') { const k = K3(nx, ny, nz); if (!dist.has(k)) { dist.set(k, d + 1); q.push({ x: nx, y: ny, z: nz }) } break }
        if (!FP.canStand(map, world, nx, ny, nz)) continue
        const k = K3(nx, ny, nz); if (!dist.has(k)) { dist.set(k, d + 1); q.push({ x: nx, y: ny, z: nz }) }
        break
      }
    }
  }
  return dist
}

// ---------------------------------------------------------------- the simulation

const DT = 0.25 // seconds per tick

function simulate (sc, opts = {}) {
  const world = sc.world
  const map = FP.workMap(world, sc.box, sc.grade, sc.opts || {})
  const claims = {}
  const start = FP.summary(map, world)
  const bots = sc.crew.map(b => Object.assign({ busy: 0, placed: 0, digs: 0, trips: 0, falls: 0, moved: 0, waits: 0, noRoute: 0 }, b))
  const gone = []
  const placedCells = new Set()
  const errs = []
  const err = (kind, msg) => { if (errs.length < 12) errs.push(kind + ': ' + msg) }
  let t = 0
  let lastChange = 0
  let version = world.version
  const trace = opts.trace ? [] : null

  const view = b => ({ id: b.id, pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, carrying: b.carrying })

  while (t < (sc.maxMin || 90) * 60) {
    t += DT
    const now = Math.round(t * 1000)
    if (sc.churn) sc.churn(t, bots, gone, rng)

    const free = bots.filter(b => b.busy <= 0)
    const busy = bots.filter(b => b.busy > 0)
    for (const b of busy) { b.busy -= DT; const held = FP.heldBy(claims, b.id); if (held) claims[held].t = now } // a busy builder heartbeats its lane
    if (free.length) {
      const res = FP.plan(world, sc.box, sc.grade, free.map(view), {
        map, claims, now, others: busy.map(view), strict: true
      })
      // invariant 4 also across the builders that are mid-action
      const targets = res.actions.map(a => a.action.cell).filter(Boolean)
      for (let i = 0; i < targets.length; i++) {
        for (let j = i + 1; j < targets.length; j++) {
          const d = Math.abs(targets[i].x - targets[j].x) + Math.abs(targets[i].y - targets[j].y) + Math.abs(targets[i].z - targets[j].z)
          if (d <= 1) err('adjacent-targets', JSON.stringify(targets[i]) + ' / ' + JSON.stringify(targets[j]))
        }
      }
      for (const { id, action } of res.actions) {
        const b = bots.find(q => q.id === id)
        if (!b) continue
        if (trace && trace.length < 200) trace.push(t.toFixed(2) + ' ' + id + ' ' + action.type + ' ' + JSON.stringify(action.cell || action.target || action.item || '') + ' — ' + action.why)
        run(b, action)
      }
    }
    for (const b of bots) gravity(b)
    // invariant 1: nobody is entombed
    for (const b of bots) {
      if (world.get(b.pos.x, b.pos.y, b.pos.z) === 'ladder') continue
      if (b.pos.y > sc.grade) continue // on top of the world, outside the fill
      if (FP.walkArea(map, world, b.pos, null, map.o.minArea) < map.o.minArea) err('entombed', b.id + ' at ' + K3(b.pos.x, b.pos.y, b.pos.z))
    }
    if (world.version !== version) { version = world.version; lastChange = t }
    const s = FP.summary(map, world, now)
    if (!s.open && !s.left) break
    if (t - lastChange > 120) { err('stalled', 'nothing changed for 120 s, ' + s.left + ' cells left'); break }
    if (!bots.length) { err('empty', 'every builder left with ' + s.left + ' cells still open'); break }
  }

  const end = FP.summary(map, world)
  if (end.left) err('unfinished', end.left + ' cells still below grade')
  for (const b of bots) if (b.pos.y <= sc.grade) err('not-on-top', b.id + ' ends at y' + b.pos.y + ' (grade ' + sc.grade + ')')
  const placed = bots.concat(gone).reduce((n, b) => n + b.placed, 0)
  const noRoute = bots.concat(gone).reduce((n, b) => n + (b.noRoute || 0), 0)
  if (noRoute > Math.max(10, placed / 20)) err('no-route', noRoute + ' walks found no path (a mate closing the way is normal, a flood of them is not)')
  const botMin = bots.concat(gone).reduce((n, b) => n + (b.leftAt != null ? b.leftAt : t), 0) / 60
  if (trace) console.log(trace.join('\n'))
  return {
    ok: !errs.length,
    errs,
    minutes: t / 60,
    cells: start.left,
    placed,
    perBotMin: botMin ? placed / botMin : 0,
    crew: bots.length,
    left: gone.length,
    drops: map.dropCols.size,
    sealed: end.sealed - start.sealed,
    falls: bots.concat(gone).reduce((n, b) => n + b.falls, 0),
    noRoute,
    trips: bots.concat(gone).reduce((n, b) => n + b.trips, 0),
    startSealed: start.sealed,
    voidBelow: start.voidBelow.length
  }

  // ---- one action -------------------------------------------------------
  function run (b, a) {
    switch (a.type) {
      case 'place': return doPlace(b, a)
      case 'dig': return doDig(b, a)
      case 'move': return doMove(b, a)
      case 'descend': return doDescend(b, a)
      case 'ride_up': return doRideUp(b, a)
      case 'restock': return doRestock(b, a)
      case 'wait': b.waits++; b.busy = 0.5; return
      case 'leave': {
        b.leftAt = t
        gone.push(b)
        const held = FP.heldBy(claims, b.id); if (held) FP.release(claims, held, b.id)
        bots.splice(bots.indexOf(b), 1)
        return
      }
      default: err('unknown-action', a.type)
    }
  }

  function has (b, item) { return typeof b.carrying === 'number' ? b.carrying : (b.carrying[item] || 0) }
  function take (b, item) { if (typeof b.carrying === 'number') b.carrying--; else b.carrying[item]-- }

  function doPlace (b, a) {
    const c = a.cell
    b.busy = 0.25
    if (has(b, a.item) < 1) return err('no-material', b.id + ' places ' + a.item + ' with none in the pockets')
    if (!FP.canPlaceFrom(world, b.pos, c, map.o.reach)) return err('out-of-reach', b.id + ' at ' + K3(b.pos.x, b.pos.y, b.pos.z) + ' -> ' + K3(c.x, c.y, c.z))
    if (a.item === 'ladder') {
      const wall = SIDES.some(([dx, dz]) => world.get(c.x + dx, c.y, c.z + dz) === 'solid')
      if (!wall) return err('ladder-no-wall', K3(c.x, c.y, c.z))
      world.set(c.x, c.y, c.z, 'ladder'); take(b, a.item); return
    }
    if (a.drop) { // a gravity block dropped down a shaft: it falls until it lands on something solid
      let y = c.y
      while (y > map.box.y1 - 1 && world.get(c.x, y - 1, c.z) !== 'solid') y--
      if (world.get(c.x, y, c.z) === 'plant') world.set(c.x, y, c.z, 'air') // the falling block breaks it
      world.set(c.x, y, c.z, 'solid'); placedCells.add(K3(c.x, y, c.z)); take(b, a.item); b.placed++
      return
    }
    if (world.get(c.x, c.y, c.z) === 'solid') return err('already-solid', K3(c.x, c.y, c.z))
    if (world.get(c.x, c.y, c.z) === 'plant') return err('place-on-plant', K3(c.x, c.y, c.z) + ' (dig it first)')
    if (world.get(c.x, c.y - 1, c.z) !== 'solid') return err('air-beneath', K3(c.x, c.y, c.z))
    if (c.x === b.pos.x && c.z === b.pos.z && (c.y === b.pos.y || c.y === b.pos.y + 1)) return err('into-own-body', b.id)
    world.set(c.x, c.y, c.z, 'solid'); placedCells.add(K3(c.x, c.y, c.z)); take(b, a.item); b.placed++
  }

  function doDig (b, a) {
    const c = a.cell
    b.busy = 0.3
    if (placedCells.has(K3(c.x, c.y, c.z))) return err('dig-after-place', K3(c.x, c.y, c.z))
    const k = world.get(c.x, c.y, c.z)
    if (k !== 'plant' && k !== 'torch') return err('dig-terrain', K3(c.x, c.y, c.z) + ' is ' + k)
    if (!FP.canPlaceFrom(world, b.pos, c, map.o.reach)) return err('dig-out-of-reach', K3(c.x, c.y, c.z))
    world.set(c.x, c.y, c.z, 'air'); b.digs++
  }

  function doMove (b, a) {
    const d = bfs(map, world, b.pos)
    const len = d.get(K3(a.target.x, a.target.y, a.target.z))
    // a mate placed a block between the plan and the step: A.travel returns false, the builder re-plans.
    // Real and harmless in small numbers; a flood of them would be a planner bug (checked at the end).
    if (len == null) { b.busy = 0.5; b.noRoute++; return }
    b.busy = Math.max(DT, len / 4)
    b.moved += len
    b.pos = { x: a.target.x, y: a.target.y, z: a.target.z }
  }

  function doDescend (b, a) {
    const dy = Math.abs(b.pos.y - a.target.y) + Math.abs(b.pos.x - a.target.x) + Math.abs(b.pos.z - a.target.z)
    b.busy = Math.max(DT, dy / 2)
    b.pos = { x: a.target.x, y: a.target.y, z: a.target.z }
  }

  function doRideUp (b, a) {
    const c = a.cell
    b.busy = 0.3
    if (c.x !== b.pos.x || c.z !== b.pos.z || c.y !== b.pos.y) return err('ride-elsewhere', K3(c.x, c.y, c.z))
    if (world.get(c.x, c.y - 1, c.z) !== 'solid') return err('air-beneath', 'ride_up ' + K3(c.x, c.y, c.z))
    if (has(b, a.item) < 1) return err('no-material', b.id + ' rides up with nothing to place')
    world.set(c.x, c.y, c.z, 'solid'); placedCells.add(K3(c.x, c.y, c.z)); take(b, a.item); b.placed++
    b.pos = { x: c.x, y: c.y + 1, z: c.z }
  }

  function doRestock (b, a) {
    const d = Math.hypot(b.pos.x - sc.depot.x, b.pos.y - sc.depot.y, b.pos.z - sc.depot.z)
    b.busy = 2 * d / 4 + 10
    b.trips++
    if (typeof b.carrying === 'number') b.carrying = a.n
    else b.carrying[a.item] = a.n
    settle(b)
  }

  // the builder comes back from the depot / falls when the block under it is gone
  function settle (b) {
    if (world.get(b.pos.x, b.pos.y, b.pos.z) === 'solid') {
      let y = b.pos.y
      while (world.get(b.pos.x, y, b.pos.z) === 'solid' && y < sc.grade + 4) y++
      b.pos = { x: b.pos.x, y, z: b.pos.z }
    }
  }

  function gravity (b) {
    if (world.get(b.pos.x, b.pos.y, b.pos.z) === 'ladder') return
    settle(b)
    let y = b.pos.y
    while (y > map.box.y1 - 2 && world.get(b.pos.x, y - 1, b.pos.z) !== 'solid') y--
    if (y < b.pos.y) { if (b.pos.y - y > 3) b.falls++; b.pos = { x: b.pos.x, y, z: b.pos.z } }
  }
}

// ---------------------------------------------------------------- scenarios

function crew (n, at, carrying) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: 'b' + String(i).padStart(2, '0'),
      pos: { x: at.x + (i % 5), y: at.y, z: at.z + Math.floor(i / 5) },
      carrying: Object.assign({ cobblestone: 0, gravel: 0, ladder: 16 }, carrying || {})
    })
  }
  return out
}

const SCEN = {}

// (a) a 20x20 pit, 6 deep, with a slope on one side you can walk down
SCEN.a = () => {
  const grade = 68
  const box = { x1: 0, z1: 0, x2: 19, z2: 19, y1: 63 }
  const floor = (x, z) => (x >= 0 && x <= 19 && z >= 0 && z <= 19) ? 63 + Math.max(0, 6 - x) : 69
  const world = new World((x, z) => floor(x, z) - 1)
  return { name: 'a open pit 20x20x6, ramp', world, box, grade, crew: crew(6, { x: -3, y: 69, z: 8 }), depot: { x: -30, y: 69, z: -30 } }
}

// (b) TODAY'S REAL CASE: a sheer trench 7 x 21, floor y52-55, grade 68, 12 builders
SCEN.b = () => {
  const grade = 68
  const box = { x1: -306, z1: -481, x2: -300, z2: -461, y1: 52 }
  const inBox = (x, z) => x >= -306 && x <= -300 && z >= -481 && z <= -461
  const floor = (x, z) => 52 + ((Math.abs(x) + Math.abs(z)) % 4)
  const world = new World((x, z) => inBox(x, z) ? floor(x, z) - 1 : grade)
  return { name: 'b sheer trench 7x21x15 (the live one)', world, box, grade, crew: crew(12, { x: -298, y: 69, z: -470 }), depot: { x: -330, y: 69, z: -490 } }
}

// (c) overhangs and three 1x1 shafts 12 deep with a flower at the bottom
SCEN.c = () => {
  const grade = 68
  const box = { x1: 0, z1: 0, x2: 15, z2: 15, y1: 50 }
  const inBox = (x, z) => x >= 0 && x <= 15 && z >= 0 && z <= 15
  const world = new World((x, z) => inBox(x, z) ? 61 : grade)
  for (let x = 5; x <= 10; x++) for (let z = 5; z <= 10; z++) world.set(x, 66, z, 'solid') // an overhang shelf
  for (const [sx, sz] of [[3, 3], [8, 12], [12, 5]]) {
    for (let y = 50; y <= 61; y++) world.set(sx, y, sz, 'air')
    world.set(sx, 50, sz, 'plant') // the flower at the bottom of the shaft
  }
  return { name: 'c overhangs + three 1x1 shafts 12 deep', world, box, grade, crew: crew(8, { x: -3, y: 69, z: 8 }, { gravel: 0 }), depot: { x: -30, y: 69, z: -30 } }
}

// (d) a pit with a lava pool on its floor
SCEN.d = () => {
  const grade = 68
  const box = { x1: 0, z1: 0, x2: 15, z2: 15, y1: 63 }
  const inBox = (x, z) => x >= 0 && x <= 15 && z >= 0 && z <= 15
  const world = new World((x, z) => inBox(x, z) ? 62 : grade)
  for (let x = 6; x <= 9; x++) for (let z = 6; z <= 9; z++) world.set(x, 63, z, 'lava')
  return { name: 'd pit with a 4x4 lava pool', world, box, grade, crew: crew(8, { x: -3, y: 69, z: 8 }), depot: { x: -30, y: 69, z: -30 } }
}

// (e) THE WHOLE RAVINE: 46 x 79, uneven floor 10-28 deep, 30 builders
SCEN.e = () => {
  const grade = 68
  const box = { x1: -330, z1: -500, x2: -285, z2: -422, y1: 41 }
  const inBox = (x, z) => x >= -330 && x <= -285 && z >= -500 && z <= -422
  const depth = (x, z) => Math.round(19 + 9 * Math.sin(x / 7) * Math.cos(z / 9))
  const world = new World((x, z) => inBox(x, z) ? grade - depth(x, z) : grade)
  return { name: 'e the whole ravine 46x79, 10-28 deep', world, box, grade, crew: crew(30, { x: -283, y: 69, z: -460 }), depot: { x: -350, y: 69, z: -520 }, maxMin: 180 }
}

// (f) 25 builders on a 150-cell tail: the surplus must leave
SCEN.f = () => {
  const grade = 68
  const box = { x1: 0, z1: 0, x2: 14, z2: 9, y1: 68 }
  const inBox = (x, z) => x >= 0 && x <= 14 && z >= 0 && z <= 9
  const world = new World((x, z) => inBox(x, z) ? 67 : 68)
  return { name: 'f 150-cell tail, 25 builders', world, box, grade, crew: crew(25, { x: -3, y: 69, z: 4 }), depot: { x: -30, y: 69, z: -30 } }
}

// (g) THE PULL MODEL UNDER CHURN: builders join and drop out mid-fill, one vanishes without releasing
SCEN.g = () => {
  const s = SCEN.b()
  s.name = 'g the same trench, builders join and vanish'
  s.crew = crew(8, { x: -298, y: 69, z: -470 })
  const r = rng(7)
  let nextId = 100
  s.churn = (t, bots, gone) => {
    if (Math.abs(t - 30) < 0.13 && bots.length) { const b = bots[Math.floor(r() * bots.length)]; b.leftAt = t; gone.push(b); bots.splice(bots.indexOf(b), 1) } // VANISHES: keeps its claim
    if (t > 10 && Math.abs((t % 25) - 0) < 0.13) {
      if (bots.length > 3 && r() < 0.5) { const b = bots[Math.floor(r() * bots.length)]; b.leftAt = t; gone.push(b); bots.splice(bots.indexOf(b), 1) } else {
        bots.push({ id: 'n' + (nextId++), pos: { x: -298, y: 69, z: -470 }, carrying: { cobblestone: 0, gravel: 0, ladder: 16 }, busy: 0, placed: 0, digs: 0, trips: 0, falls: 0, moved: 0, waits: 0, noRoute: 0 })
      }
    }
  }
  return s
}

// ---------------------------------------------------------------- runner

function main () {
  const args = process.argv.slice(2)
  const trace = args.includes('--trace')
  const want = args.filter(a => !a.startsWith('--'))
  const names = Object.keys(SCEN).filter(k => !want.length || want.includes(k))
  const rows = []
  let bad = 0
  for (const k of names) {
    const sc = SCEN[k]()
    const t0 = Date.now()
    let r
    try { r = simulate(sc, { trace }) } catch (e) { r = { ok: false, errs: ['threw: ' + e.message + '\n' + e.stack.split('\n')[1]], minutes: 0, cells: 0, placed: 0, perBotMin: 0, crew: 0, left: 0, drops: 0, falls: 0, trips: 0 } }
    r.name = sc.name; r.cpu = (Date.now() - t0) / 1000
    rows.push(r)
    if (!r.ok) bad++
  }
  const pad = (s, n) => String(s).padEnd(n)
  const num = (v, n, d = 1) => String(typeof v === 'number' ? v.toFixed(d) : v).padStart(n)
  console.log('')
  console.log(pad('scenario', 40) + num('cells', 7) + num('crew', 5) + num('quit', 5) + num('min', 7) + num('c/min/bot', 10) + num('trips', 6) + num('drops', 6) + num('falls', 6) + '  result')
  console.log('-'.repeat(103))
  for (const r of rows) {
    console.log(pad(r.name, 40) + num(r.cells, 7, 0) + num(r.crew, 5, 0) + num(r.left, 5, 0) + num(r.minutes, 7) + num(r.perBotMin, 10) + num(r.trips, 6, 0) + num(r.drops, 6, 0) + num(r.falls, 6, 0) + '  ' + (r.ok ? 'PASS' : 'FAIL'))
    if (!r.ok) for (const e of r.errs) console.log('      ! ' + e)
  }
  console.log('')
  console.log(bad ? bad + ' of ' + rows.length + ' scenarios FAILED' : 'all ' + rows.length + ' scenarios pass')
  process.exit(bad ? 1 : 0)
}

if (require.main === module) main()
module.exports = { World, simulate, SCEN, bfs }
