'use strict'
// fill_plan.js — PLANNER for filling a hole SOLID up to one grade (ravine, trench, crater, pit).
//
// Pure: no mineflayer, no files, no clock of its own. Everything it knows comes from its arguments
//   world = { get(x,y,z) -> 'solid'|'air'|'water'|'lava'|'plant'|'ladder'|…, sky(x,z) -> y of the topmost solid block }
//   box   = {x1,z1,x2,z2,y1}   (y1 = lowest layer of the fill, grade = the finished ground level)
//   crew  = [{id, pos:{x,y,z}, carrying}]   (carrying = a number of fill blocks, or {item: n})
// and it answers with ONE action per builder: place / dig / move / descend / restock / ride_up / wait / leave.
// Deterministic: same inputs -> same actions (the crew is sorted by id, every tie-break is on coordinates).
//
// PULL MODEL (owner 09-20 「気づいたら気づいたbotがやる、でいい気がする」): no crew list, no head-count, no
// supervisor. The box is cut into TILES of `tile` x `tile` columns; a tile is the unit of work AND of
// ownership. Any builder asks openTiles() what is open near it, claim()s one (small, expiring), works it
// with next(), release()s it when it is at grade. Two claimed tiles never share an edge, so two builders
// can never target the same or a face-adjacent cell — no locks, no lock fights, nobody to be "assigned".
// A builder that vanishes mid-fill loses its claim by timeout; the next one that notices takes the lane.
//
// The algorithm a good player uses (docs/FILL.md has the long version and the reasons):
//   * per lane, bottom-up: layer L = the lowest open cell of the lane WITH A SOLID BLOCK UNDER IT; the
//     whole layer of the lane is closed before L rises, so a pinhole can never be left behind;
//   * the builder stands ON the finished layer and places the cells of L around itself (reach 4.5);
//     the cell under its own feet is closed last, by riding up onto it (ride_up);
//   * it never places at or above a mate's feet+1 in the neighbouring columns, never into a mate's body,
//     never where a mate would be left with fewer than 4 walkable cells — nobody is walled in;
//   * a pit deeper than 3 with no walkable way in gets a LADDER down a wall face, built top-down by the
//     first builder that needs it: nothing is dug, no block hangs in the air, and it is the way OUT for a
//     restock trip too. Its lower rungs are simply buried as the floor rises;
//   * a cell nobody can stand beside is classified ONCE — `drop` (a gravity block down its shaft, which
//     also breaks the flower at the bottom) or `sealed` (rock pocket) — and never blocks the layer again;
//   * plants and torches in a cell are dug before it is filled; lava is quenched first and no builder ever
//     stands within 2 of it; a column that hangs over air below the box is reported, never decked.

const DEFAULTS = {
  tile: 3, // columns per lane; one builder at a time, so the whole lane is within its reach (2.83 < 4.5)
  K: 40, // one builder per K open cells — the crew size EMERGES from the work, nobody is assigned
  reach: 4.5,
  pocket: 1024, // one restock trip = full pockets (16 stacks)
  claimMs: 60000, // claims expire: a builder that vanishes frees its lane by itself
  entryGrid: 16, // one entry ladder per 16 blocks of box edge, built on demand
  fillItem: 'cobblestone',
  gravityItem: 'gravel',
  maxDrop: 3, // how far a builder may step down (A.travel's rule) — never a planned fall
  scan: 40, // how many candidate lanes a claiming builder looks at
  minArea: 4, // a builder must always keep at least this many walkable cells
  strict: false // true: plan() throws when two actions touch the same or a face-adjacent cell (tests)
}

const K3 = (x, y, z) => x + ',' + y + ',' + z
const K2 = (x, z) => x + ',' + z
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
const flr = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z

function kindAt (world, x, y, z) { return world.get(x, y, z) || 'air' }
function isSolid (world, x, y, z, blocked) {
  if (blocked && blocked.has(K3(x, y, z))) return true
  return kindAt(world, x, y, z) === 'solid'
}
function isLitter (k) { return k === 'plant' || k === 'torch' }
function isLava (world, x, y, z) { return kindAt(world, x, y, z) === 'lava' }

function have (bot, item, o) {
  const c = bot.carrying
  if (c == null) return 0
  if (typeof c === 'number') return item === o.fillItem ? c : 0
  return c[item] || 0
}

// ---------------------------------------------------------------- the work map (built once per box)

function normBox (box, grade, o) {
  const x1 = Math.min(box.x1, box.x2); const x2 = Math.max(box.x1, box.x2)
  const z1 = Math.min(box.z1, box.z2); const z2 = Math.max(box.z1, box.z2)
  const y1 = box.y1 != null ? box.y1 : grade - (o.depth || 16) + 1
  return { x1, x2, z1, z2, y1, y2: grade }
}

function workMap (world, box, grade, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts)
  const b = normBox(box, grade, o)
  const map = {
    o,
    box: b,
    grade,
    tiles: new Map(),
    sealed: new Set(), // cells the sky flood never reached + cells later classified unreachable
    voidBelow: new Set(), // "x,z": the bottom of the box hangs over air — reported, never decked
    dropCols: new Set(), // "x,z": columns that can only be closed by a gravity drop
    lava: new Set(), // every lava cell of the box; it only ever shrinks (quenched), never grows
    floor: new Map(), // "x,z" -> the lowest open cell (monotonic: the fill only ever rises)
    state: new Map(), // tile id -> cached state
    count: { n: 0, at: -1e9 }
  }
  for (let tx = 0; tx * o.tile <= b.x2 - b.x1; tx++) {
    for (let tz = 0; tz * o.tile <= b.z2 - b.z1; tz++) {
      const t = {
        id: 't' + tx + ',' + tz,
        tx,
        tz,
        x1: b.x1 + tx * o.tile,
        z1: b.z1 + tz * o.tile,
        x2: Math.min(b.x2, b.x1 + tx * o.tile + o.tile - 1),
        z2: Math.min(b.z2, b.z1 + tz * o.tile + o.tile - 1)
      }
      t.cx = (t.x1 + t.x2) / 2
      t.cz = (t.z1 + t.z2) / 2
      map.tiles.set(t.id, t)
    }
  }
  sealFlood(map, world)
  for (let x = b.x1 - 2; x <= b.x2 + 2; x++) {
    for (let z = b.z1 - 2; z <= b.z2 + 2; z++) {
      for (let y = b.y1 - 2; y <= b.y2 + 2; y++) if (isLava(world, x, y, z)) map.lava.add(K3(x, y, z))
      if (x < b.x1 || x > b.x2 || z < b.z1 || z > b.z2) continue
      if (!isSolid(world, x, b.y1, z) && !isSolid(world, x, b.y1 - 1, z)) map.voidBelow.add(K2(x, z))
    }
  }
  return map
}

// Air connected to the open sky INSIDE the box is work; a pocket sealed in the rock is not. Flooded
// once at the start: filling strictly bottom-up can never cut a higher cell off from the sky.
function sealFlood (map, world) {
  const b = map.box; const open = new Set(); const q = []
  for (let x = b.x1; x <= b.x2; x++) {
    for (let z = b.z1; z <= b.z2; z++) {
      if (isSolid(world, x, b.y2, z)) continue
      open.add(K3(x, b.y2, z)); q.push([x, b.y2, z])
    }
  }
  const N6 = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  while (q.length) {
    const [x, y, z] = q.pop()
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx; const ny = y + dy; const nz = z + dz
      if (nx < b.x1 || nx > b.x2 || nz < b.z1 || nz > b.z2 || ny < b.y1 || ny > b.y2) continue
      const k = K3(nx, ny, nz)
      if (open.has(k) || isSolid(world, nx, ny, nz)) continue
      open.add(k); q.push([nx, ny, nz])
    }
  }
  for (let x = b.x1; x <= b.x2; x++) {
    for (let z = b.z1; z <= b.z2; z++) {
      for (let y = b.y1; y <= b.y2; y++) if (!isSolid(world, x, y, z) && !open.has(K3(x, y, z))) map.sealed.add(K3(x, y, z))
    }
  }
}

// ---------------------------------------------------------------- what is open, per column and lane

function placeable (map, world, x, y, z) {
  if (isSolid(world, x, y, z)) return false
  if (map.sealed.has(K3(x, y, z))) return false
  if (map.voidBelow.has(K2(x, z)) && y === map.box.y1) return false
  return isSolid(world, x, y - 1, z) // SOLID FILL: no block is ever placed with air beneath it
}

// The lowest cell of a column that is still work — null when the column stands at grade.
// Memoised: the floor only ever rises, so the scan resumes where it stopped last time.
function firstOpen (map, world, x, z) {
  const k = K2(x, z)
  let y = map.floor.has(k) ? map.floor.get(k) : map.box.y1
  if (y == null) return null
  for (; y <= map.grade; y++) {
    if (isSolid(world, x, y, z)) continue
    if (map.sealed.has(K3(x, y, z))) continue
    if (map.voidBelow.has(k) && y === map.box.y1) continue
    map.floor.set(k, y)
    return y
  }
  map.floor.set(k, null)
  return null
}

// LAYER = the lowest open cell of the whole lane; its targets are the cells of the lane at that height
// that already have a solid block underneath. The layer is closed before it rises: no pinholes, ever.
function tileState (map, world, tile, now, fresh) {
  const cached = map.state.get(tile.id)
  if (cached && !fresh && now - cached.t < 2000) return cached
  let layerY = null; let remaining = 0
  for (let x = tile.x1; x <= tile.x2; x++) {
    for (let z = tile.z1; z <= tile.z2; z++) {
      const y = firstOpen(map, world, x, z)
      if (y == null) continue
      remaining += map.grade - y + 1
      if (layerY == null || y < layerY) layerY = y
    }
  }
  const targets = []
  if (layerY != null) {
    for (let x = tile.x1; x <= tile.x2; x++) {
      for (let z = tile.z1; z <= tile.z2; z++) {
        if (!placeable(map, world, x, layerY, z)) continue
        targets.push({ x, y: layerY, z, lava: isLava(world, x, layerY, z), litter: isLitter(kindAt(world, x, layerY, z)) })
      }
    }
    targets.sort((a, b) => (b.lava ? 1 : 0) - (a.lava ? 1 : 0) || a.x - b.x || a.z - b.z)
  }
  const st = { t: now, id: tile.id, layerY, targets, remaining, done: layerY == null }
  map.state.set(tile.id, st)
  return st
}

// ---------------------------------------------------------------- claims: small, expiring, per lane
// 't…' = a lane, 'e…' = the entry ladder of one box edge. Nothing else is ever claimed.

function expire (claims, now, claimMs) {
  for (const id of Object.keys(claims)) if (now - claims[id].t > claimMs) delete claims[id]
}
function heldBy (claims, botId, prefix = 't') {
  for (const id of Object.keys(claims)) if (claims[id].bot === botId && id[0] === prefix) return id
  return null
}
function laneCount (claims) { return Object.keys(claims).filter(id => id[0] === 't').length }
function neighbourIds (tile) { return SIDES.map(([a, b]) => 't' + (tile.tx + a) + ',' + (tile.tz + b)) }
function claimable (map, claims, tile, botId) {
  const mine = claims[tile.id]
  if (mine && mine.bot !== botId) return false
  for (const n of neighbourIds(tile)) { const c = claims[n]; if (c && c.bot !== botId) return false }
  return true
}
function claim (claims, id, botId, now, map) {
  const tile = map && id[0] === 't' ? map.tiles.get(id) : null
  if (tile && !claimable(map, claims, tile, botId)) return false
  if (claims[id] && claims[id].bot !== botId) return false
  claims[id] = { bot: botId, t: now }
  return true
}
function release (claims, id, botId) {
  if (claims[id] && (!botId || claims[id].bot === botId)) delete claims[id]
}

// ---------------------------------------------------------------- the work map, seen from outside

// Every lane a builder standing at `from` could take, nearest first, with what it needs and how much
// is left in it. This is the whole "board" a filling job needs — no jobs, no crews, no priorities.
function openTiles (world, box, grade, opts = {}) {
  const map = opts.map || workMap(world, box, grade, opts)
  const o = map.o
  const claims = opts.claims || {}
  const now = opts.now || 0
  const from = opts.from ? flr(opts.from) : { x: map.box.x1, y: grade + 1, z: map.box.z1 }
  expire(claims, now, o.claimMs)
  const cand = [...map.tiles.values()]
    .filter(t => claimable(map, claims, t, opts.botId || null))
    .sort((a, b) => Math.hypot(a.cx - from.x, a.cz - from.z) - Math.hypot(b.cx - from.x, b.cz - from.z) || (a.id < b.id ? -1 : 1))
  const out = []
  for (const t of cand.slice(0, opts.all ? cand.length : o.scan)) {
    const st = tileState(map, world, t, now, false)
    if (st.done || !st.targets.length) continue
    out.push({
      id: t.id,
      x1: t.x1,
      x2: t.x2,
      z1: t.z1,
      z2: t.z2,
      layerY: st.layerY,
      open: st.targets.length,
      left: st.remaining,
      need: { item: o.fillItem, n: Math.min(st.remaining, o.pocket) },
      entry: grade - st.layerY > o.maxDrop,
      dist: Math.hypot(t.cx - from.x, t.cz - from.z)
    })
    if (out.length >= (opts.limit || 1e9)) break
  }
  return out
}

// how many cells the whole box has open in its working layers — the number that sets the crew size
function countOpen (map, world, now) {
  if (now - map.count.at < 5000) return map.count.n
  let n = 0
  for (const t of map.tiles.values()) n += tileState(map, world, t, now, true).targets.length
  map.count = { n, at: now }
  return n
}

// ---------------------------------------------------------------- geometry: standing, reach, walking

function canStand (map, world, x, y, z, mates, blocked) {
  if (!isSolid(world, x, y - 1, z, blocked)) return false
  if (isSolid(world, x, y, z, blocked) || isSolid(world, x, y + 1, z, blocked)) return false
  if (lavaWithin(map, world, x, y, z, 2)) return false // nobody works within 2 of lava until it is quenched
  if (mates) for (const m of mates) if (m.x === x && m.z === z && Math.abs(m.y - y) <= 1) return false
  return true
}

// the lava index: small, shrinks as cells are quenched, and saves a 5x5x5 world scan per stand
function lavaWithin (map, world, x, y, z, r) {
  if (!map.lava || !map.lava.size) return false
  for (const k of map.lava) {
    const [lx, ly, lz] = k.split(',').map(Number)
    if (Math.abs(lx - x) > r || Math.abs(ly - y) > r || Math.abs(lz - z) > r) continue
    if (isLava(world, lx, ly, lz)) return true
    map.lava.delete(k)
  }
  return false
}

function los (world, from, to) {
  const ax = from.x + 0.5; const ay = from.y + 1.6; const az = from.z + 0.5
  const bx = to.x + 0.5; const by = to.y + 0.5; const bz = to.z + 0.5
  const n = Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) * 5)
  for (let i = 1; i < n; i++) {
    const s = i / n
    const x = Math.floor(ax + (bx - ax) * s); const y = Math.floor(ay + (by - ay) * s); const z = Math.floor(az + (bz - az) * s)
    if (x === to.x && y === to.y && z === to.z) continue
    if (x === from.x && z === from.z && (y === from.y || y === from.y + 1)) continue
    if (isSolid(world, x, y, z)) return false
  }
  return true
}

function canPlaceFrom (world, stand, cell, reach) {
  if (Math.hypot(stand.x - cell.x, (stand.y + 1.6) - (cell.y + 0.5), stand.z - cell.z) > reach) return false
  return los(world, stand, cell)
}

// read-only walking, exactly like A.travel: step up 1, drop at most maxDrop, ladders climbed, nothing dug
function reachSet (map, world, start, blocked, limit = 800) {
  const o = map.o
  const seen = new Set([K3(start.x, start.y, start.z)])
  const q = [start]
  while (q.length && seen.size < limit) {
    const p = q.shift()
    if (kindAt(world, p.x, p.y, p.z) === 'ladder') {
      for (const dy of [1, -1]) {
        const ny = p.y + dy
        const onLadder = kindAt(world, p.x, ny, p.z) === 'ladder'
        if (!onLadder && !canStand(map, world, p.x, ny, p.z, null, blocked)) continue
        const k = K3(p.x, ny, p.z)
        if (!seen.has(k)) { seen.add(k); q.push({ x: p.x, y: ny, z: p.z }) }
      }
    }
    for (const [dx, dz] of SIDES) {
      const nx = p.x + dx; const nz = p.z + dz
      for (let dy = 1; dy >= -o.maxDrop; dy--) {
        const ny = p.y + dy
        if (dy === 1 && isSolid(world, p.x, p.y + 2, p.z, blocked)) break // no headroom to step up
        if (kindAt(world, nx, ny, nz) === 'ladder') {
          const k = K3(nx, ny, nz)
          if (!seen.has(k)) { seen.add(k); q.push({ x: nx, y: ny, z: nz }) }
          break
        }
        if (!canStand(map, world, nx, ny, nz, null, blocked)) continue
        const k = K3(nx, ny, nz)
        if (!seen.has(k)) { seen.add(k); q.push({ x: nx, y: ny, z: nz }) }
        break // the first standable height in that column wins
      }
    }
  }
  return seen
}

// how much room a builder has to walk — the simulator's "not entombed" test and ours
function walkArea (map, world, p, blocked, cap = 8) { return reachSet(map, world, flr(p), blocked, cap).size }

// ---------------------------------------------------------------- safety: nobody is walled in

function safeToPlace (map, world, cell, mates, o) {
  for (const m of mates) {
    if (m.x === cell.x && m.z === cell.z && (cell.y === m.y || cell.y === m.y + 1)) return false // its body
    if (Math.abs(m.x - cell.x) <= 1 && Math.abs(m.z - cell.z) <= 1 && cell.y >= m.y + 1) return false // a 2-high wall beside it
    if (Math.abs(m.x - cell.x) <= 2 && Math.abs(m.y - cell.y) <= 2 && Math.abs(m.z - cell.z) <= 2) {
      const blocked = new Set([K3(cell.x, cell.y, cell.z)])
      if (walkArea(map, world, m, blocked, o.minArea) < o.minArea) return false // it would be entombed
    }
  }
  return true
}

// ---------------------------------------------------------------- entry: a ladder down a wall face

// One ladder per `entryGrid` blocks of box edge, on the box column nearest the lane whose OUTSIDE
// neighbour is solid wall all the way down. Built top-down from the rim: place a rung, hang on it,
// place the next. Nothing is dug, no block hangs in the air, and it is the way OUT for a restock trip.
function entryColumn (map, world, tile) {
  const b = map.box; const o = map.o
  const sides = []
  for (let x = b.x1; x <= b.x2; x++) { sides.push({ x, z: b.z1, ox: 0, oz: -1 }); sides.push({ x, z: b.z2, ox: 0, oz: 1 }) }
  for (let z = b.z1; z <= b.z2; z++) { sides.push({ x: b.x1, z, ox: -1, oz: 0 }); sides.push({ x: b.x2, z, ox: 1, oz: 0 }) }
  const good = sides.filter(s => {
    const floor = firstOpen(map, world, s.x, s.z)
    if (floor == null) return false
    for (let y = floor; y <= map.grade; y++) if (!isSolid(world, s.x + s.ox, y, s.z + s.oz)) return false
    return canStand(map, world, s.x + s.ox, map.grade + 1, s.z + s.oz)
  })
  if (!good.length) return null
  const snap = v => Math.round(v / o.entryGrid) * o.entryGrid
  const wx = snap(tile.cx); const wz = snap(tile.cz)
  good.sort((a, c) => Math.hypot(a.x - wx, a.z - wz) - Math.hypot(c.x - wx, c.z - wz) || a.x - c.x || a.z - c.z)
  return good[0]
}

function entryAction (map, world, bot, tile, o) {
  const col = entryColumn(map, world, tile)
  if (!col) return { type: 'wait', why: 'no wall face to hang an entry ladder on' }
  const floor = firstOpen(map, world, col.x, col.z)
  const feet = flr(bot.pos)
  const rim = { x: col.x + col.ox, y: map.grade + 1, z: col.z + col.oz }
  let lowest = null
  for (let y = map.grade; y >= floor; y--) { if (kindAt(world, col.x, y, col.z) !== 'ladder') break; lowest = y }
  const rung = lowest == null ? map.grade : lowest - 1
  const tag = 'e' + K2(col.x, col.z)
  if (rung < floor) return { type: 'descend', target: { x: col.x, y: floor, z: col.z }, entry: tag, why: 'down the entry ladder at ' + K2(col.x, col.z) }
  if (have(bot, 'ladder', o) < 1) return { type: 'restock', item: 'ladder', n: 16, entry: tag, why: 'ladders for the way into the pit at ' + K2(col.x, col.z) }
  const from = lowest == null ? rim : { x: col.x, y: lowest, z: col.z }
  if (!same(feet, from)) {
    if (lowest == null) return { type: 'move', target: rim, entry: tag, why: 'to the rim to start the entry ladder' }
    return { type: 'descend', target: from, entry: tag, why: 'down to the last rung' }
  }
  return { type: 'place', cell: { x: col.x, y: rung, z: col.z }, item: 'ladder', entry: tag, why: 'entry ladder rung y' + rung }
}

// ---------------------------------------------------------------- the one decision: next()

// bot = {id, pos, carrying}; tile = a lane or its id; opts = {map, mates, now}
function next (bot, tile, world, opts = {}) {
  const map = opts.map
  const o = map.o
  const now = opts.now || 0
  const t = typeof tile === 'string' ? map.tiles.get(tile) : map.tiles.get(tile.id)
  const mates = (opts.mates || []).map(flr)
  const feet = flr(bot.pos)
  const st = tileState(map, world, t, now, true)
  if (st.done) return { type: 'wait', why: 'lane ' + t.id + ' stands at grade' }

  // 1. MATERIAL — ONE trip with full pockets, never six little ones
  const laneNeed = Math.min(st.remaining, o.tile * o.tile)
  const needsDrop = st.targets.some(c => map.dropCols.has(K2(c.x, c.z)))
  if (needsDrop && have(bot, o.gravityItem, o) < 1) {
    return { type: 'restock', item: o.gravityItem, n: 64, why: 'a shaft in ' + t.id + ' can only be closed by a gravity block' }
  }
  const carried = have(bot, o.fillItem, o)
  if (carried < laneNeed && carried < st.remaining) {
    return { type: 'restock', item: o.fillItem, n: o.pocket, why: 'carrying ' + carried + ', this lane needs ' + laneNeed }
  }

  // 2. what may be filled at all this tick without harming anybody
  const others = mates.filter(m => !same(m, feet))
  const safe = st.targets.filter(c => safeToPlace(map, world, c, others, o))
  if (!safe.length) return { type: 'wait', why: 'every open cell of ' + t.id + ' stands beside a builder — it steps up first' }

  // 3. from where I stand (lava first, then the nearest cell)
  if (canStand(map, world, feet.x, feet.y, feet.z)) {
    const here = safe.filter(c => !same(c, feet) && canPlaceFrom(world, feet, c, o.reach))
    if (here.length) {
      const c = pick(here, feet)
      if (c.litter) return { type: 'dig', cell: c, why: 'a plant in the cell is not a filled cell' }
      return { type: 'place', cell: c, item: o.fillItem, why: 'layer y' + st.layerY + ' of ' + t.id }
    }
  }

  // 4. a stand in my own lane (+-3 columns, for cells under a 1-high overhang and around lava)
  const stands = standsFor(map, world, t, st, safe, others, o)
  if (stands.length) {
    const reach = reachSet(map, world, feet)
    const walkable = stands.filter(s => reach.has(K3(s.x, s.y, s.z)) && !same(s, feet))
    if (walkable.length) return { type: 'move', target: pick(walkable, feet), why: 'onto the finished floor beside layer y' + st.layerY }
  }

  // 5. the cell under my own feet is the last one of this layer: ride up onto it
  if (safe.some(c => same(c, feet))) {
    return { type: 'ride_up', cell: feet, item: o.fillItem, why: 'closing the cell I stand in and riding up with the floor' }
  }

  // 6. a cell nobody can stand beside: classify it ONCE — a gravity block down its shaft…
  for (const c of safe) {
    const d = dropFor(map, world, c, o)
    if (!d) continue
    map.dropCols.add(K2(c.x, c.z))
    if (have(bot, o.gravityItem, o) < 1) return { type: 'restock', item: o.gravityItem, n: 64, why: 'a gravity block for the shaft at ' + K2(c.x, c.z) }
    if (same(feet, d.from)) return { type: 'place', cell: d.place, item: o.gravityItem, drop: true, lands: d.lands, why: 'gravity block down the shaft at ' + K2(c.x, c.z) }
    if (reachSet(map, world, feet).has(K3(d.from.x, d.from.y, d.from.z))) return { type: 'move', target: d.from, why: 'beside the mouth of the shaft at ' + K2(c.x, c.z) }
  }

  // 7. no way in: the pit is deeper than a walkable step
  if (map.grade - st.layerY > o.maxDrop) return entryAction(map, world, bot, t, o)

  // 8. …else it is sealed. Said once, and the layer order is never held up by it again.
  for (const c of safe) map.sealed.add(K3(c.x, c.y, c.z))
  map.floor.delete(K2(safe[0].x, safe[0].z))
  map.state.delete(t.id)
  return { type: 'wait', why: 'classified ' + safe.length + ' cells of ' + t.id + ' as unreachable (sealed)' }
}

function pick (list, feet) {
  return list.slice().sort((a, b) =>
    (b.lava ? 1 : 0) - (a.lava ? 1 : 0) ||
    Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z) ||
    a.y - b.y || a.x - b.x || a.z - b.z)[0]
}

// where a builder may stand to work this lane: on the finished floor, in the lane or just beside it,
// never in a mate's cell, never within 2 of lava, and only where it really reaches a cell of the lane.
function standsFor (map, world, tile, st, targets, mates, o) {
  const out = []
  for (let x = tile.x1 - 3; x <= tile.x2 + 3; x++) {
    for (let z = tile.z1 - 3; z <= tile.z2 + 3; z++) {
      for (const y of [st.layerY, st.layerY + 1]) {
        if (!canStand(map, world, x, y, z, mates)) continue
        const s = { x, y, z }
        if (!targets.some(c => !same(c, s) && canPlaceFrom(world, s, c, o.reach))) continue
        out.push(s); break
      }
    }
  }
  return out
}

// A 1x1 shaft (or a cell under an overhang): from a stand beside its MOUTH a gravity block is dropped
// in, falls to the floor of the shaft and closes it — and breaks the flower standing down there.
function dropFor (map, world, cell, o) {
  for (let y = cell.y + 1; y <= map.grade; y++) {
    if (isSolid(world, cell.x, y, cell.z)) return null // roofed: not a shaft
    for (const [dx, dz] of SIDES) {
      for (const sy of [y, y - 1]) {
        const s = { x: cell.x + dx, y: sy, z: cell.z + dz }
        if (!canStand(map, world, s.x, s.y, s.z)) continue
        const mouth = { x: cell.x, y, z: cell.z }
        if (!canPlaceFrom(world, s, mouth, o.reach)) continue
        return { place: mouth, from: s, lands: cell }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------- plan(): one action per builder

function plan (world, box, grade, crew, opts = {}) {
  const map = opts.map || workMap(world, box, grade, opts)
  const o = map.o
  const now = opts.now || 0
  const claims = opts.claims || {}
  expire(claims, now, o.claimMs)
  const openCells = countOpen(map, world, now)
  const capacity = Math.max(1, Math.ceil(openCells / o.K))
  const sorted = crew.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
  const everyone = sorted.concat(opts.others || [])
  const actions = []
  for (const bot of sorted) {
    const mates = everyone.filter(m => m.id !== bot.id).map(m => m.pos)
    let tileId = heldBy(claims, bot.id)
    if (tileId && tileState(map, world, map.tiles.get(tileId), now, true).done) { release(claims, tileId, bot.id); tileId = null }
    if (!tileId) {
      if (laneCount(claims) >= capacity) {
        actions.push({ id: bot.id, action: { type: 'leave', why: openCells + ' cells open: ' + laneCount(claims) + ' builders are the whole crew this needs' } })
        continue
      }
      const t = openTiles(world, box, grade, { map, claims, now, from: bot.pos, botId: bot.id, limit: 1 })[0]
      if (!t) {
        actions.push({ id: bot.id, action: { type: 'leave', why: 'no lane open near me that is not beside a working mate' } })
        continue
      }
      claim(claims, t.id, bot.id, now, map)
      tileId = t.id
    }
    claims[tileId].t = now // a working builder renews its claim; a vanished one lets it lapse
    let action = next(bot, tileId, world, { map, mates, now })
    // the entry ladder is shared by every lane of that box edge: one builder builds it, the rest wait
    if (action.entry && !claim(claims, action.entry, bot.id, now, map)) {
      action = { type: 'wait', why: 'another builder is building the entry ladder ' + action.entry }
    }
    if (!action.entry) release(claims, heldBy(claims, bot.id, 'e'), bot.id)
    actions.push({ id: bot.id, action })
  }
  if (o.strict) assertDisjoint(actions)
  return { actions, claims, capacity, open: openCells, map }
}

// two builders must never touch the same cell, nor two cells that share a face, in one tick
function assertDisjoint (actions) {
  const cells = actions.map(a => a.action.cell).filter(Boolean)
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const d = Math.abs(cells[i].x - cells[j].x) + Math.abs(cells[i].y - cells[j].y) + Math.abs(cells[i].z - cells[j].z)
      if (d <= 1) throw new Error('two builders target ' + JSON.stringify(cells[i]) + ' and ' + JSON.stringify(cells[j]))
    }
  }
}

// ---------------------------------------------------------------- reporting

function summary (map, world, now = 0) {
  let open = 0; let left = 0
  for (const t of map.tiles.values()) { const st = tileState(map, world, t, now, true); open += st.targets.length; left += st.remaining }
  return { open, left, sealed: map.sealed.size, voidBelow: [...map.voidBelow], tiles: map.tiles.size, drops: map.dropCols.size }
}

module.exports = {
  DEFAULTS,
  workMap,
  openTiles,
  claim,
  release,
  heldBy,
  expire,
  next,
  plan,
  summary,
  // used by the simulator and by the live adapter's own checks
  firstOpen,
  placeable,
  canStand,
  canPlaceFrom,
  reachSet,
  walkArea,
  los,
  tileState,
  countOpen
}
