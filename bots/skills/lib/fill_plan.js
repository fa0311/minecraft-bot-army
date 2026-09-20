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
  K: 8, // one builder per K open cells — the crew size EMERGES from the work, nobody is assigned.
  // MEASURED on the live trench (tests/fill_sim.js b, 7x21x15, 12 builders available): K 40 -> 1 builder
  // and 27.6 min, K 9 -> 5 and 16.5, K 8 -> 6 and 12.8, K 6 -> 7 and 10.1, K 4 -> 10 and 10.8 (crowded,
  // each one slower). K is the ONE throughput knob; the lane rules keep the work correct at any value.
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
    hard: new Set(), // "x,z" columns nobody can ever stand in at some height: lava, and under a roof
    floor: new Map(), // "x,z" -> the lowest open cell (monotonic: the fill only ever rises)
    state: new Map(), // tile id -> cached state
    tries: new Map(), // cell -> how often a builder stood in front of it and could do nothing
    abandoned: new Set(), // "x,z": a column with a cell nobody can fill — the rest of it would hang
    avoid: new Map(), // botId -> a lane it just handed back, so it does not take it straight back
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
  capSeal(map, world)
  for (let x = b.x1 - 2; x <= b.x2 + 2; x++) {
    for (let z = b.z1 - 2; z <= b.z2 + 2; z++) {
      for (let y = b.y1 - 2; y <= b.y2 + 2; y++) if (isLava(world, x, y, z)) map.lava.add(K3(x, y, z))
      if (x < b.x1 || x > b.x2 || z < b.z1 || z > b.z2) continue
      // `hard` = a column with LAVA in it. (Cells under a roof were in here too, and the wide rule then
      // froze a third of the box around every overhang; capSeal() answers those instead.)
      for (let y = b.y1; y <= b.y2; y++) if (isLava(world, x, y, z)) { map.hard.add(K2(x, z)); break }
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

// UNDER A ROOF, AT ARM'S LENGTH ONLY. A cell with a solid block one or two above it is a cell no
// builder can stand in: it has to be filled from a column beside it where one can. Beyond about two
// columns that shot does not exist (you cannot see into a 1-high gap from three blocks away), so those
// cells are declared NOT WORK here, once, before anybody walks anywhere — instead of freezing the box
// while builder after builder proves it again. They are reported as `roofed`: taking the lid off first
// (the live blueprint's `unlid`) is a decision for the job, not for the man with the cobblestone.
function capSeal (map, world) {
  const b = map.box
  const capped = (x, y, z) => isSolid(world, x, y + 1, z) || isSolid(world, x, y + 2, z)
  map.roofed = new Set()
  for (let x = b.x1; x <= b.x2; x++) {
    for (let z = b.z1; z <= b.z2; z++) {
      for (let y = b.y1; y <= b.y2; y++) {
        if (isSolid(world, x, y, z) || map.sealed.has(K3(x, y, z)) || !capped(x, y, z)) continue
        let shot = false
        for (let dx = -2; dx <= 2 && !shot; dx++) {
          for (let dz = -2; dz <= 2 && !shot; dz++) {
            if (!dx && !dz) continue
            if (!isSolid(world, x + dx, y, z + dz) && !isSolid(world, x + dx, y + 1, z + dz)) shot = true
          }
        }
        if (!shot) { map.sealed.add(K3(x, y, z)); map.roofed.add(K3(x, y, z)) }
      }
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
  if (map.abandoned.has(k)) return null
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

// THE WATER LEVEL, per column: a block may go in only where it ends up at most ONE above each of the
// four neighbouring columns. Outside the box a column counts as finished, so the rim never holds a cell
// back. This is the whole anti-well rule (measured, scenarios (a) and (b), 09-20: lanes that rose
// independently built 5-block wells around each other, and the planner then wanted an entry ladder
// into a hole IT had made). Consequence: the filled surface is always a 1-step staircase — walkable in
// every direction, no wall a builder cannot step over — and the fill spreads like water, deepest basin
// first. It also makes the crew size honest: the columns at the waterline ARE the open work.
function colFloor (map, world, x, z) {
  const b = map.box
  if (x < b.x1 || x > b.x2 || z < b.z1 || z > b.z2) return map.grade + 1
  const y = firstOpen(map, world, x, z)
  return y == null ? map.grade + 1 : y
}
function levelWith (map, world, x, y, z) {
  for (const [dx, dz] of SIDES) if (y > colFloor(map, world, x + dx, z + dz)) return false
  // …AND NOTHING RISES AROUND A CELL NOBODY CAN STAND IN (measured, scenario (d): the ring around a
  // lava pool went up one step per column — legally, each only 1 over its neighbour — until the pool
  // sat at the bottom of a funnel 3 deep, out of reach from the nearest place a builder may stand, and
  // the whole box waited for it for ever). A lava cell and a cell under a roof are filled from a
  // distance, so the ground within an arm's length of them must stay at their level until they are done.
  // …but a hard column is not held back by another one: they rise together under the 1-step rule above,
  // and whatever is left over when they can rise no further is written off and reported.
  if (!map.hard.size || map.hard.has(K2(x, z))) return true
  for (const k of map.hard) {
    const c = k.split(',')
    const hx = +c[0]; const hz = +c[1]
    if (Math.abs(hx - x) > 3 || Math.abs(hz - z) > 3) continue
    if (colFloor(map, world, hx, hz) < y) return false
  }
  return true
}

// the lowest cell of a lane that is still work — grade+1 when the lane stands finished
function laneFloor (map, world, tile) {
  let y = null
  for (let x = tile.x1; x <= tile.x2; x++) {
    for (let z = tile.z1; z <= tile.z2; z++) {
      const q = firstOpen(map, world, x, z)
      if (q != null && (y == null || q < y)) y = q
    }
  }
  return y == null ? map.grade + 1 : y
}

// LAYER = the lowest open cell of the whole lane; its targets are the cells of the lane at that height
// that already have a solid block underneath. The layer is closed before it rises: no pinholes, ever.
//
function tileState (map, world, tile, now, fresh) {
  const cached = map.state.get(tile.id)
  if (cached && !fresh && now - cached.t < 2000) return cached
  let layerY = null; let remaining = 0
  for (let x = tile.x1; x <= tile.x2; x++) {
    for (let z = tile.z1; z <= tile.z2; z++) {
      const y = firstOpen(map, world, x, z)
      if (y == null) continue
      for (let q = y; q <= map.grade; q++) if (!isSolid(world, x, q, z) && !map.sealed.has(K3(x, q, z))) remaining++
      if (layerY == null || y < layerY) layerY = y
    }
  }
  const targets = []
  if (layerY != null) {
    for (let x = tile.x1; x <= tile.x2; x++) {
      for (let z = tile.z1; z <= tile.z2; z++) {
        if (!placeable(map, world, x, layerY, z)) continue
        if (!levelWith(map, world, x, layerY, z)) continue
        targets.push({ x, y: layerY, z, lava: isLava(world, x, layerY, z), litter: isLitter(kindAt(world, x, layerY, z)) })
      }
    }
    targets.sort((a, b) => (b.lava ? 1 : 0) - (a.lava ? 1 : 0) || a.x - b.x || a.z - b.z)
  }
  const blocked = layerY != null && !targets.length
  const st = { t: now, id: tile.id, layerY, targets, remaining, blocked, done: layerY == null }
  map.state.set(tile.id, st)
  return st
}

// A cell we cannot fill takes with it every open cell ABOVE it until the next solid block: they could
// only ever stand on air. If the run reaches the sky, the whole column stops being work and is reported
// (`abandoned` -> the adapter's void_under_pad); under a roof the column carries on above the roof.
function sealUp (map, world, x, y, z) {
  let q = y
  for (; q <= map.grade; q++) {
    if (isSolid(world, x, q, z)) break
    map.sealed.add(K3(x, q, z))
  }
  map.floor.delete(K2(x, z))
  if (q > map.grade) map.abandoned.add(K2(x, z))
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
  const av = opts.avoid && opts.avoid.until > now ? opts.avoid.id : null
  const rc = opts.reachCols || null
  const cand = [...map.tiles.values()]
    .filter(t => t.id !== av && claimable(map, claims, t, opts.botId || null) && (!rc || laneInReach(t, rc)))
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

// "can I get at this lane" is not "can I walk into it": the last two layers under an overhang are
// filled at arm's length from the rim of the roof, where the builder can still stand. So a lane counts
// as within reach when any of its columns lies within an arm of a column the builder can walk to.
function laneInReach (tile, cols, r = 3) {
  for (let x = tile.x1; x <= tile.x2; x++) {
    for (let z = tile.z1; z <= tile.z2; z++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (cols.has(K2(x + dx, z + dz))) return true
    }
  }
  return false
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
  // Lava: never IN it, never touching it (the 3x3x3 around the builder). Two blocks away at the same
  // level is where a player stands to throw a block into a pool, and it has to be allowed — with the
  // 2-block rule the core of a 4x4 pool had no legal stand at all and the whole box waited for it.
  if (lavaWithin(map, world, x, y, z, 1) || lavaWithin(map, world, x, y + 1, z, 1)) return false
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
  if (Math.abs(stand.x - cell.x) <= 1 && Math.abs(stand.z - cell.z) <= 1 && Math.abs(stand.y - cell.y) <= 1) return true // right beside my feet
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
  // an entry is built from ABOVE. A builder already down in the pit never walks out for one — it waits
  // for the floor, which is rising under it anyway (that is why the fill needs no exit).
  if (Math.floor(bot.pos.y) <= map.grade && kindAt(world, Math.floor(bot.pos.x), Math.floor(bot.pos.y), Math.floor(bot.pos.z)) !== 'ladder') {
    const up = reachSet(map, world, flr(bot.pos))
    if (!up.has(K3(col.x + col.ox, map.grade + 1, col.z + col.oz))) {
      return { type: 'wait', release: true, why: 'I am inside the pit and this lane is not reachable — another lane' }
    }
  }
  const floor = firstOpen(map, world, col.x, col.z)
  const feet = flr(bot.pos)
  const rim = { x: col.x + col.ox, y: map.grade + 1, z: col.z + col.oz }
  let lowest = null
  for (let y = map.grade; y >= floor; y--) { if (kindAt(world, col.x, y, col.z) !== 'ladder') break; lowest = y }
  const rung = lowest == null ? map.grade : lowest - 1
  const tag = 'e' + K2(col.x, col.z)
  if (rung < floor) {
    const bottom = { x: col.x, y: floor, z: col.z }
    if (same(feet, bottom)) return { type: 'wait', release: true, why: 'at the foot of the entry ladder: this lane is not the one to take' }
    return { type: 'descend', target: bottom, entry: tag, why: 'down the entry ladder at ' + K2(col.x, col.z) }
  }
  if (have(bot, 'ladder', o) < 1) return { type: 'restock', item: 'ladder', n: 16, entry: tag, why: 'ladders for the way into the pit at ' + K2(col.x, col.z) }
  const from = lowest == null ? rim : { x: col.x, y: lowest, z: col.z }
  if (!same(feet, from)) {
    if (lowest == null) return same(feet, rim) ? { type: 'wait', why: 'at the rim, the first rung goes in next tick' } : { type: 'move', target: rim, entry: tag, why: 'to the rim to start the entry ladder' }
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

  // 0. AM I STUCK? (a mate's floor closed around me, or the terrain did). The fill is its own ladder:
  // place under my feet and rise with it. No headroom over me -> hand myself back, that is a rescue.
  if (feet.y <= map.grade && walkArea(map, world, feet, null, o.minArea) < o.minArea) {
    if (!isSolid(world, feet.x, feet.y + 2, feet.z) && have(bot, o.fillItem, o) > 0 && isSolid(world, feet.x, feet.y - 1, feet.z)) {
      return { type: 'ride_up', cell: feet, item: o.fillItem, why: 'boxed in at ' + K3(feet.x, feet.y, feet.z) + ': riding my own fill up' }
    }
    return { type: 'leave', release: true, why: 'boxed in at ' + K3(feet.x, feet.y, feet.z) + ' with no headroom — this needs a rescue, not a plan' }
  }

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

  // 2. what may be filled at all this tick without harming anybody — MYSELF INCLUDED (measured under
  // an overhang: a builder filled the floor of a 2-high pocket, rose into a 1-high gap and was stuck)
  const others = mates.filter(m => !same(m, feet))
  const safe = st.targets.filter(c => safeToPlace(map, world, c, others.concat([feet]), o))
  if (!safe.length) return { type: 'wait', release: true, why: 'every open cell of ' + t.id + ' is held by a mate standing in it — I take another lane' }

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
    if (!isSolid(world, feet.x, feet.y + 2, feet.z)) {
      return { type: 'ride_up', cell: feet, item: o.fillItem, why: 'closing the cell I stand in and riding up with the floor' }
    }
    // a roof one block over my head (an overhang): stepping up would wedge me. Someone fills this cell
    // from the side later — including me, from the next lane.
    return { type: 'wait', release: true, why: 'the cell I stand in is the last one and there is a roof over me: it is filled from the side' }
  }

  // 6. a cell nobody can stand beside: classify it ONCE — a gravity block down its shaft…
  for (const c of safe) {
    const d = dropFor(map, world, c, o)
    if (!d || d.place.y - c.y < 2) continue // a real shaft, not a cell whose stand is busy this second
    map.dropCols.add(K2(c.x, c.z))
    if (have(bot, o.gravityItem, o) < 1) return { type: 'restock', item: o.gravityItem, n: 64, why: 'a gravity block for the shaft at ' + K2(c.x, c.z) }
    if (same(feet, d.from)) return { type: 'place', cell: d.place, item: o.gravityItem, drop: true, lands: d.lands, why: 'gravity block down the shaft at ' + K2(c.x, c.z) }
    if (reachSet(map, world, feet).has(K3(d.from.x, d.from.y, d.from.z))) return { type: 'move', target: d.from, why: 'beside the mouth of the shaft at ' + K2(c.x, c.z) }
  }

  // 7. …else nobody could fill it FROM HERE. A cell is written off only with EVIDENCE (a builder stood
  // in front of it and could do nothing, five times over 30 s) — a busy second is not a verdict. A
  // written-off cell takes the rest of its column with it unless a roof stands over it: a column over a
  // hole we cannot close would hang in the air, and "never deck a hole" beats "the box is finished".
  // The adapter reports these as void_under_pad. This is counted BEFORE the entry branch: a lane nobody
  // can work must end, not send builder after builder down a ladder to look at it (measured in (c)).
  const done = []
  let near = false
  for (const c of safe) {
    // evidence means a builder STOOD IN FRONT of the cell: a report from 40 blocks away proves nothing
    // (it wrote off 30 good columns of the trench in one run before this line existed)
    if (Math.hypot(c.x - feet.x, c.y - feet.y, c.z - feet.z) > 8) continue
    near = true
    const k = K3(c.x, c.y, c.z)
    const e = map.tries.get(k) || { n: 0, t0: now }
    e.n++; map.tries.set(k, e)
    if (e.n < 5 || now - e.t0 < 15000) continue
    sealUp(map, world, c.x, c.y, c.z)
    done.push(k)
  }
  map.state.delete(t.id)
  // a builder that is AT the cell keeps the lane while it proves the point — handing it back and
  // walking away means the next one starts the evidence from nothing and the tail never ends
  if (!done.length && near) return { type: 'wait', why: 'standing in front of ' + safe.length + ' cells of ' + t.id + ' I cannot reach — proving it' }
  if (done.length) return { type: 'wait', why: 'wrote off ' + done.join(' ') + ': no stand, no shaft, five tries — not work' }

  // 8. a way in, if the pit is deeper than a walkable step and I am still up top
  if (map.grade - st.layerY > o.maxDrop) return entryAction(map, world, bot, t, o)
  return { type: 'wait', release: true, why: 'nothing of ' + t.id + ' is reachable from here this second — another lane first' }
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
  const inLane = standsIn(map, world, tile, st, targets, mates, o, 0)
  return inLane.length ? inLane : standsIn(map, world, tile, st, targets, mates, o, 3)
}

// r = 0: only the lane's own columns (the normal case — a builder never stands in a mate's lane).
// r = 3: the ring around it, for the two cases the lane itself has no room: a cell under a 1-high
// overhang, and a lava cell that may only be quenched from 3 blocks away.
function standsIn (map, world, tile, st, targets, mates, o, r) {
  const out = []
  for (let x = tile.x1 - r; x <= tile.x2 + r; x++) {
    for (let z = tile.z1 - r; z <= tile.z2 + r; z++) {
      for (const y of [st.layerY, st.layerY + 1]) {
        if (!canStand(map, world, x, y, z, mates)) continue
        const s = { x, y, z }
        if (!targets.some(c => !same(c, s) && canPlaceFrom(world, s, c, o.reach))) continue
        // never walk into a spot with no room (measured, scenario (c): builders stepped into the
        // 2-high crawl space under an overhang and had to be rescued out of it one by one)
        if (walkArea(map, world, s, null, o.minArea) < o.minArea) continue
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
    if (tileId) { const st = tileState(map, world, map.tiles.get(tileId), now, true); if (st.done || st.blocked) { release(claims, tileId, bot.id); tileId = null } }
    if (!tileId) {
      if (laneCount(claims) >= capacity) {
        actions.push({ id: bot.id, action: { type: 'leave', why: openCells + ' cells open: ' + laneCount(claims) + ' builders are the whole crew this needs' } })
        continue
      }
      // A builder already down in the pit is only offered a lane it can WALK to. (Measured with a
      // crowded trench: four of them stood at the foot of the entry ladder for six minutes, each
      // holding a lane on the far side of a 3-block natural step it could never climb.) On the rim it
      // may take any lane — from up there it can always build the way in.
      let reachCols = null
      if (Math.floor(bot.pos.y) <= grade) {
        reachCols = new Set()
        for (const k of reachSet(map, world, flr(bot.pos), null, 4000)) { const p = k.split(','); reachCols.add(p[0] + ',' + p[2]) }
      }
      const t = openTiles(world, box, grade, { map, claims, now, from: bot.pos, botId: bot.id, limit: 1, avoid: map.avoid.get(bot.id), reachCols })[0]
      if (!t) {
        actions.push({ id: bot.id, action: { type: 'leave', why: reachCols ? 'no open lane I can walk to from down here' : 'no lane open near me that is not beside a working mate' } })
        continue
      }
      claim(claims, t.id, bot.id, now, map)
      tileId = t.id
    }
    claims[tileId].t = now // a working builder renews its claim; a vanished one lets it lapse
    let action = next(bot, tileId, world, { map, mates, now })
    if (action.release) { release(claims, tileId, bot.id); map.avoid.set(bot.id, { id: tileId, until: now + 10000 }) }
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
  return { open, left, sealed: map.sealed.size, roofed: map.roofed ? map.roofed.size : 0, voidBelow: [...map.voidBelow], abandoned: [...map.abandoned], tiles: map.tiles.size, drops: map.dropCols.size }
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
