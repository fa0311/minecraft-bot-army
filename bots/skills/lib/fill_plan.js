'use strict'
// fill_plan.js — PLANNER for filling a hole SOLID up to one grade (ravine, trench, crater, pit).
//
// Pure: no mineflayer, no files, no clock of its own. Everything it knows comes from
//   world  = { get(x,y,z) -> 'solid'|'air'|'water'|'lava'|'plant'|'ladder'|…, sky(x,z) -> y of the topmost solid block }
//   box    = {x1,z1,x2,z2, y1}   (y1 = lowest layer of the fill; grade = the finished ground level)
//   crew   = [{id, pos:{x,y,z}, carrying}]  (carrying = a number of fill blocks, or {item: n})
// and it answers with ONE action per builder: place / dig / move / descend / restock / ride_up / wait / leave.
// Deterministic: same inputs -> same actions (crew is sorted by id, every tie-break is on coordinates).
//
// PULL MODEL (owner 09-20: "気づいたら気づいたbotがやる"): there is no crew list and no head-count.
// The box is cut into TILES of `tile` x `tile` columns; a tile is the unit of work and of ownership.
// Any builder asks `openTiles()` what is open near it, `claim()`s one tile (small, expiring), works it
// with `next()` and `release()`s it. Two claimed tiles never share an edge, so two builders can never
// target the same or a face-adjacent cell — no locks, no fights, no supervisor.
//
// The algorithm a good player uses (docs/FILL.md has the long version):
//   * bottom-up per tile: layer L = the lowest open cell of the tile that has a SOLID block under it;
//     the whole layer of the tile is closed before L rises, so a pinhole cannot be left behind;
//   * the builder stands ON the finished layer, places the cells of L around itself (reach 4.5),
//     and closes the cell under its own feet last by riding up onto it (ride_up);
//   * it never places at or above a mate's feet+1 within one column, never into a mate's body and
//     never into a mate's last way out — nobody is walled in;
//   * a pit deeper than 3 with no walkable way in gets a LADDER run down a wall face, built top-down
//     by the first builder that needs it (no digging, no block hangs in the air, it is an exit too);
//   * cells nobody can stand beside are classified ONCE as `drop` (a gravity block down their shaft)
//     or `sealed` (rock pocket, never work) — a classified cell never blocks the layer order again;
//   * plants/torches in a cell are dug before it is filled; lava is quenched first and nobody stands
//     within 2 of it; a column that hangs over air below the box is reported, never decked.

const DEFAULTS = {
  tile: 3, // columns per lane; one builder at a time, so its whole layer is within reach (2.83 < 4.5)
  K: 40, // one builder per K open cells: crew size emerges from the work, nobody is assigned
  reach: 4.5,
  pocket: 1024, // one restock trip = full pockets (16 stacks)
  claimMs: 60000, // a claim expires: a builder that vanishes mid-fill frees its tile by itself
  entryGrid: 16, // one ladder per 16 blocks of box edge, built on demand
  fillItem: 'cobblestone',
  gravityItem: 'gravel',
  maxDrop: 3, // how far a builder may walk down (pathfinder rule; never a planned fall)
  scan: 32, // how many candidate tiles a claiming builder looks at
  strict: false // true: plan() throws when two actions target the same or a face-adjacent cell (tests)
}

const K3 = (x, y, z) => x + ',' + y + ',' + z
const K2 = (x, z) => x + ',' + z
const flr = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

function kindAt (world, x, y, z) { return world.get(x, y, z) || 'air' }
function isSolid (world, x, y, z) { return kindAt(world, x, y, z) === 'solid' }
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
    o, box: b, grade, world,
    tiles: new Map(), // id -> tile
    sealed: new Set(), // cells the sky flood never reached, plus cells classified unreachable later
    voidBelow: new Set(), // "x,z": the bottom of the box hangs over air — reported, never decked
    state: new Map(), // id -> cached tile state
    cache: { count: 0, countAt: -1e9, reach: new Map(), reachAt: -1e9 }
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
      t.cx = (t.x1 + t.x2) / 2; t.cz = (t.z1 + t.z2) / 2
      map.tiles.set(t.id, t)
    }
  }
  sealFlood(map, world)
  for (let x = b.x1; x <= b.x2; x++) {
    for (let z = b.z1; z <= b.z2; z++) {
      if (!isSolid(world, x, b.y1, z) && !isSolid(world, x, b.y1 - 1, z)) map.voidBelow.add(K2(x, z))
    }
  }
  return map
}

// Air that is connected to the open sky INSIDE the box is work; a pocket sealed in the rock is not.
// Flooded once: filling from the bottom up can never cut a higher cell off from the sky.
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
      for (let y = b.y1; y <= b.y2; y++) {
        if (!isSolid(world, x, y, z) && !open.has(K3(x, y, z))) map.sealed.add(K3(x, y, z))
      }
    }
  }
}

// ---------------------------------------------------------------- tile state (what is open, where)

function fillable (map, world, x, y, z) {
  if (isSolid(world, x, y, z)) return false
  if (map.sealed.has(K3(x, y, z))) return false
  if (map.voidBelow.has(K2(x, z)) && y === map.box.y1) return false
  return isSolid(world, x, y - 1, z) // SOLID FILL: never a block with air under it
}

// the lowest cell of a column that is still open (sealed pockets skipped) — null = filled to grade
function firstOpen (map, world, x, z) {
  for (let y = map.box.y1; y <= map.grade; y++) {
    if (isSolid(world, x, y, z)) continue
    if (map.sealed.has(K3(x, y, z))) continue
    if (map.voidBelow.has(K2(x, z)) && y === map.box.y1) continue
    return y
  }
  return null
}

// LAYER = the lowest open cell of the whole tile; its targets are every cell of the tile at that height
// that already has a solid block underneath. The layer is closed before it rises: no pinholes.
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
        if (!fillable(map, world, x, layerY, z)) continue
        targets.push({ x, y: layerY, z, lava: isLava(world, x, layerY, z), litter: isLitter(kindAt(world, x, layerY, z)) })
      }
    }
    // lava first (it is quenched before anybody works within 2 of it), then west-to-east for a stable order
    targets.sort((a, b) => (b.lava ? 1 : 0) - (a.lava ? 1 : 0) || a.x - b.x || a.z - b.z)
  }
  const st = { t: now, id: tile.id, layerY, targets, remaining, done: layerY == null }
  map.state.set(tile.id, st)
  return st
}

// ---------------------------------------------------------------- claims (small, expiring, per tile)

function expire (claims, now, claimMs) {
  for (const id of Object.keys(claims)) if (now - claims[id].t > claimMs) delete claims[id]
}
function heldBy (claims, botId) {
  for (const id of Object.keys(claims)) if (claims[id].bot === botId) return id
  return null
}
function neighbourIds (tile) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => 't' + (tile.tx + a) + ',' + (tile.tz + b))
}
function claimable (map, claims, tile, botId) {
  const mine = claims[tile.id]
  if (mine && mine.bot !== botId) return false
  for (const n of neighbourIds(tile)) { const c = claims[n]; if (c && c.bot !== botId) return false }
  return true
}
function claim (claims, tileId, botId, now, map) {
  const tile = map ? map.tiles.get(tileId) : null
  if (tile && !claimable(map, claims, tile, botId)) return false
  claims[tileId] = { bot: botId, t: now }
  return true
}
function release (claims, tileId, botId) {
  if (claims[tileId] && (!botId || claims[tileId].bot === botId)) delete claims[tileId]
}

// ---------------------------------------------------------------- what is open right now

// tiles a builder standing at `from` could take, nearest first. Each carries what it NEEDS
// (blocks, and whether it still wants a way in) and how much is left in it.
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
    if (out.length >= (opts.limit || 999)) break
  }
  return out
}

// how many cells the whole box has open in its working layers (the number that sets the crew size)
function countOpen (map, world, now) {
  if (now - map.cache.countAt < 5000) return map.cache.count
  let n = 0
  for (const t of map.tiles.values()) { const st = tileState(map, world, t, now, false); n += st.targets.length }
  map.cache.count = n; map.cache.countAt = now
  return n
}

// ---------------------------------------------------------------- geometry: stands, reach, walking

function canStand (map, world, x, y, z, mates) {
  if (!isSolid(world, x, y - 1, z)) return false
  if (isSolid(world, x, y, z) || isSolid(world, x, y + 1, z)) return false
  if (kindAt(world, x, y, z) === 'lava' || kindAt(world, x, y - 1, z) === 'lava') return false
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) if (isLava(world, x + dx, y + dy, z + dz)) return false
    }
  }
  if (mates) for (const m of mates) if (m.x === x && m.z === z && Math.abs(m.y - y) <= 1) return false
  return true
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
  const d = Math.hypot(stand.x - cell.x, (stand.y + 1.6) - (cell.y + 0.5), stand.z - cell.z)
  if (d > reach) return false
  return los(world, stand, cell)
}

// read-only walking, exactly like A.travel: step up 1, drop at most maxDrop, ladders climbed
function reachSet (map, world, start, limit = 2500) {
  const seen = new Set([K3(start.x, start.y, start.z)])
  const q = [start]
  const o = map.o
  while (q.length && seen.size < limit) {
    const p = q.shift()
    const onLadder = kindAt(world, p.x, p.y, p.z) === 'ladder'
    if (onLadder) {
      for (const dy of [1, -1]) {
        const ny = p.y + dy
        if (kindAt(world, p.x, ny, p.z) !== 'ladder' && !(dy < 0 && canStand(map, world, p.x, ny, p.z))) continue
        const k = K3(p.x, ny, p.z); if (seen.has(k)) continue
        seen.add(k); q.push({ x: p.x, y: ny, z: p.z })
      }
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = p.x + dx; const nz = p.z + dz
      for (let dy = 1; dy >= -o.maxDrop; dy--) {
        const ny = p.y + dy
        if (kindAt(world, nx, ny, nz) === 'ladder') { const k = K3(nx, ny, nz); if (!seen.has(k)) { seen.add(k); q.push({ x: nx, y: ny, z: nz }) } break }
        if (!canStand(map, world, nx, ny, nz)) continue
        if (dy === 1 && isSolid(world, p.x, p.y + 2, p.z)) break // no headroom to step up
        const k = K3(nx, ny, nz); if (!seen.has(k)) { seen.add(k); q.push({ x: nx, y: ny, z: nz }) }
        break // the first standable height in this column wins
      }
    }
  }
  return seen
}

// ---------------------------------------------------------------- safety: nobody is walled in

function freeAround (map, world, p, extra) {
  let n = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    for (let dy = 1; dy >= -1; dy--) {
      const x = p.x + dx; const y = p.y + dy; const z = p.z + dz
      if (extra && extra.x === x && extra.y === y && extra.z === z) continue
      if (canStand(map, world, x, y, z)) { n++; break }
    }
  }
  return n
}

// a cell may be filled only when it harms no builder standing nearby (mine or a mate's)
function safeToPlace (map, world, cell, mates) {
  for (const m of mates) {
    if (m.x === cell.x && m.z === cell.z && (cell.y === m.y || cell.y === m.y + 1)) return false // its body
    if (Math.abs(m.x - cell.x) <= 1 && Math.abs(m.z - cell.z) <= 1 && cell.y >= m.y + 1) return false // a 2-high wall beside it
    if (Math.abs(m.x - cell.x) <= 2 && Math.abs(m.z - cell.z) <= 2 && Math.abs(m.y - cell.y) <= 2) {
      if (freeAround(map, world, m, cell) < 4) return false // it would be entombed
    }
  }
  return true
}

// ---------------------------------------------------------------- entry: a ladder down a wall face

// One ladder per `entryGrid` blocks of box edge, on the box column nearest the tile whose OUTSIDE
// neighbour is a solid wall all the way down. Built top-down from the rim: the builder places a rung,
// hangs on it, places the next. Nothing is dug, nothing hangs in the air, and it is the way out too
// (a restock trip uses it). Its lower rungs are simply buried as the floor rises.
function entryColumn (map, world, tile) {
  const b = map.box; const o = map.o
  const sides = []
  for (let x = b.x1; x <= b.x2; x++) { sides.push({ x, z: b.z1, ox: 0, oz: -1 }); sides.push({ x, z: b.z2, ox: 0, oz: 1 }) }
  for (let z = b.z1; z <= b.z2; z++) { sides.push({ x: b.x1, z, ox: -1, oz: 0 }); sides.push({ x: b.x2, z, ox: 1, oz: 0 }) }
  const snap = v => Math.round(v / o.entryGrid) * o.entryGrid
  const good = sides.filter(s => {
    const floor = firstOpen(map, world, s.x, s.z)
    if (floor == null) return false
    for (let y = floor; y <= map.grade - 1; y++) if (!isSolid(world, s.x + s.ox, y, s.z + s.oz)) return false
    return canStand(map, world, s.x + s.ox, map.grade + 1, s.z + s.oz) || canStand(map, world, s.x + s.ox, map.grade, s.z + s.oz)
  })
  if (!good.length) return null
  const wantX = snap(tile.cx); const wantZ = snap(tile.cz)
  good.sort((a, c) =>
    Math.hypot(a.x - wantX, a.z - wantZ) - Math.hypot(c.x - wantX, c.z - wantZ) || a.x - c.x || a.z - c.z)
  return good[0]
}

function ladderRun (map, world, col) {
  const floor = firstOpen(map, world, col.x, col.z)
  const cells = []
  if (floor == null) return cells
  for (let y = map.grade - 1; y >= floor; y--) cells.push({ x: col.x, y, z: col.z })
  return cells
}

function entryAction (map, world, bot, tile, o) {
  const col = entryColumn(map, world, tile)
  if (!col) return { type: 'wait', why: 'no wall face to hang an entry ladder on' }
  const run = ladderRun(map, world, col)
  const feet = flr(bot.pos)
  const rim = { x: col.x + col.ox, y: map.grade + 1, z: col.z + col.oz }
  const rimStand = canStand(map, world, rim.x, rim.y, rim.z) ? rim : { x: rim.x, y: map.grade, z: rim.z }
  // the first rung that is missing, top down
  const missing = run.find(c => kindAt(world, c.x, c.y, c.z) !== 'ladder')
  if (!missing) {
    const bottom = run[run.length - 1]
    return { type: 'descend', target: bottom, why: 'down the entry ladder at ' + K2(col.x, col.z) }
  }
  if (have(bot, 'ladder', o) < 1) return { type: 'restock', item: 'ladder', n: 16, why: 'an entry ladder for the pit at ' + K2(col.x, col.z) }
  const from = kindAt(world, feet.x, feet.y, feet.z) === 'ladder' ? feet : rimStand
  if (!(feet.x === from.x && feet.y === from.y && feet.z === from.z)) {
    // hang on the lowest rung that stands, else walk to the rim
    const lowest = run.filter(c => kindAt(world, c.x, c.y, c.z) === 'ladder').pop()
    if (lowest && Math.abs(feet.y - lowest.y) <= 1 && feet.x === lowest.x && feet.z === lowest.z) { /* already there */ } else if (lowest && kindAt(world, feet.x, feet.y, feet.z) !== 'ladder' && feet.y > lowest.y) {
      return { type: 'descend', target: lowest, why: 'down to the end of the entry ladder' }
    } else if (!lowest) {
      return { type: 'move', target: rimStand, why: 'to the rim to start the entry ladder' }
    }
  }
  return { type: 'place', cell: missing, item: 'ladder', entry: true, why: 'entry ladder rung ' + missing.y }
}

// ---------------------------------------------------------------- the one decision: next()

// bot = {id, pos, carrying}; tile = a tile object (from openTiles) or its id; opts = {map, mates, now}
function next (bot, tile, world, opts = {}) {
  const map = opts.map
  const o = map.o
  const now = opts.now || 0
  const t = typeof tile === 'string' ? map.tiles.get(tile) : map.tiles.get(tile.id)
  const mates = (opts.mates || []).map(flr)
  const feet = flr(bot.pos)
  const st = tileState(map, world, t, now, true)
  if (st.done) return { type: 'wait', why: 'tile ' + t.id + ' is at grade' }

  // 1. MATERIAL — one trip with full pockets, never six little ones
  const laneNeed = Math.min(st.remaining, o.tile * o.tile)
  const drops = st.targets.filter(c => map.dropCells && map.dropCells.has(K3(c.x, c.y, c.z)))
  if (drops.length && have(bot, o.gravityItem, o) < 1) {
    return { type: 'restock', item: o.gravityItem, n: 64, why: drops.length + ' cells can only be closed by a gravity block down their shaft' }
  }
  if (have(bot, o.fillItem, o) < laneNeed && have(bot, o.fillItem, o) < st.remaining) {
    return { type: 'restock', item: o.fillItem, n: o.pocket, why: 'carrying ' + have(bot, o.fillItem, o) + ', the lane needs ' + laneNeed }
  }

  // 2. what may be filled at all, this tick, without harming anybody
  const safe = st.targets.filter(c => safeToPlace(map, world, c, mates.filter(m => !(m.x === feet.x && m.y === feet.y && m.z === feet.z))))
  if (!safe.length) return { type: 'wait', why: 'every open cell of ' + t.id + ' is beside a builder — it steps up first' }

  // 3. from where I stand (lava first, then the nearest cell)
  const here = safe.filter(c => !(c.x === feet.x && c.z === feet.z && c.y === feet.y) && canPlaceFrom(world, feet, c, o.reach))
  if (here.length && canStand(map, world, feet.x, feet.y, feet.z)) {
    const c = pick(here, feet)
    if (c.litter) return { type: 'dig', cell: c, why: 'a plant in the cell is not a filled cell' }
    return { type: 'place', cell: c, item: o.fillItem, why: 'layer y' + st.layerY + ' of ' + t.id }
  }

  // 4. a stand inside my own lane (± 2 columns, where a 1-high overhang leaves no room in the lane)
  const stands = standsFor(map, world, t, st, safe, mates, o)
  const reach = reachSet(map, world, feet)
  const walkable = stands.filter(s => reach.has(K3(s.x, s.y, s.z)))
  if (walkable.length) {
    const s = pick(walkable, feet)
    if (s.x === feet.x && s.y === feet.y && s.z === feet.z) return { type: 'wait', why: 'nothing in reach of this stand' }
    return { type: 'move', target: s, why: 'onto the finished floor beside layer y' + st.layerY }
  }

  // 5. the cell under my own feet is the last one of this layer: ride up onto it
  if (safe.some(c => c.x === feet.x && c.y === feet.y && c.z === feet.z)) {
    return { type: 'ride_up', cell: { x: feet.x, y: feet.y, z: feet.z }, item: o.fillItem, why: 'closing the cell I stand in and riding up with the floor' }
  }

  // 6. a cell nobody can stand beside: classify it ONCE — a gravity block down its shaft, or sealed
  const shaft = safe.map(c => dropFor(map, world, c, feet, o)).find(Boolean)
  if (shaft) {
    map.dropCells = map.dropCells || new Set()
    map.dropCells.add(K3(shaft.cell.x, shaft.cell.y, shaft.cell.z))
    if (have(bot, o.gravityItem, o) < 1) return { type: 'restock', item: o.gravityItem, n: 64, why: 'a gravity block for the shaft at ' + K2(shaft.cell.x, shaft.cell.z) }
    if (!(feet.x === shaft.from.x && feet.y === shaft.from.y && feet.z === shaft.from.z)) {
      if (reach.has(K3(shaft.from.x, shaft.from.y, shaft.from.z))) return { type: 'move', target: shaft.from, why: 'over the shaft at ' + K2(shaft.cell.x, shaft.cell.z) }
    } else {
      return { type: 'place', cell: shaft.cell, item: o.gravityItem, drop: true, why: 'gravity block down the 1x1 shaft at ' + K2(shaft.cell.x, shaft.cell.z) }
    }
  }

  // 7. no way in: the pit is deeper than a walkable step
  if (map.grade - st.layerY > o.maxDrop) return entryAction(map, world, bot, t, o)

  // 8. nothing reaches it and it is not a shaft — declare it sealed, once, and let the layer move on
  for (const c of safe) {
    if (!dropFor(map, world, c, feet, o)) map.sealed.add(K3(c.x, c.y, c.z))
  }
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
// never in the way of a mate, never within 2 of lava, and only where it actually reaches a target.
function standsFor (map, world, tile, st, targets, mates, o) {
  const out = []
  for (let x = tile.x1 - 2; x <= tile.x2 + 2; x++) {
    for (let z = tile.z1 - 2; z <= tile.z2 + 2; z++) {
      for (const y of [st.layerY, st.layerY + 1]) {
        if (!canStand(map, world, x, y, z, mates)) continue
        const s = { x, y, z }
        if (!targets.some(c => !(c.x === x && c.z === z && c.y === y) && canPlaceFrom(world, s, c, o.reach))) continue
        out.push(s); break
      }
    }
  }
  return out
}

// a 1x1 shaft (or a cell under an overhang) with a clear column of air above it: a gravity block
// dropped from a stand over its mouth lands on its floor and closes it — and breaks the flower in it.
function dropFor (map, world, cell, feet, o) {
  for (let y = cell.y + 1; y <= map.grade + 2; y++) {
    if (isSolid(world, cell.x, y, cell.z)) return null
    if (!canStand(map, world, cell.x, y, cell.z)) continue
    const from = { x: cell.x, y, z: cell.z }
    if (y - cell.y < 2) return null // not a shaft: an ordinary cell, it just has no stand yet
    return { cell, from }
  }
  return null
}

// ---------------------------------------------------------------- plan(): one action for every builder

function plan (world, box, grade, crew, opts = {}) {
  const map = opts.map || workMap(world, box, grade, opts)
  const o = map.o
  const now = opts.now || 0
  const claims = opts.claims || {}
  expire(claims, now, o.claimMs)
  const openCells = countOpen(map, world, now)
  const capacity = Math.max(1, Math.ceil(openCells / o.K))
  const sorted = crew.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
  const actions = []
  for (const bot of sorted) {
    const mates = sorted.filter(m => m.id !== bot.id).map(m => m.pos)
    let tileId = heldBy(claims, bot.id)
    if (tileId) {
      const st = tileState(map, world, map.tiles.get(tileId), now, true)
      if (st.done) { release(claims, tileId, bot.id); tileId = null }
    }
    if (!tileId) {
      const held = Object.keys(claims).length
      if (held >= capacity) {
        actions.push({ id: bot.id, action: { type: 'leave', why: openCells + ' cells open: ' + held + ' builders are the whole crew this needs' } })
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
    claims[tileId].t = now // a working builder renews its claim; a vanished one lets it expire
    actions.push({ id: bot.id, action: next(bot, tileId, world, { map, mates, now }) })
  }
  if (o.strict) assertDisjoint(actions)
  return { actions, claims, capacity, open: openCells, map }
}

// two builders must never touch the same cell, nor two cells that share a face, in one tick
function assertDisjoint (actions) {
  const cells = actions.map(a => a.action.cell || a.action.target).filter(Boolean)
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
  return { open, left, sealed: map.sealed.size, voidBelow: [...map.voidBelow], tiles: map.tiles.size }
}

module.exports = {
  DEFAULTS, workMap, openTiles, claim, release, heldBy, expire, next, plan, summary,
  // exported for the simulator and for the live adapter's own checks
  firstOpen, fillable, canStand, canPlaceFrom, reachSet, los, freeAround, tileState, countOpen
}
