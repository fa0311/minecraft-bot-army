// iron_core.js -- THE MINE (world 2). One OWNED, AUDITED stairwell + one level per squad. docs/PLAN-world2.md §5, §9.
//
// The owner's question this file answers: "採掘にいったbotが拠点に戻れない" - miners could not get back. World 1, all observed:
//  (a) ONE 1-wide stair of 140 recorded steps: its own repair code bricked a corner with cobblestone (09-19 11:58Z, 6 miners jammed), the trunk
//      floor was dug away, creeper craters - one broken step stranded everybody;
//  (b) bots re-assigned while underground used the SURFACE pathfinder -> no_route -> private tunnels straight up;
//  (c) the mine was a sponge job (stays of 70-400 s against a 140-step commute); (d) miners went down hungry and torchless into a dark trunk.
// World 2:
//  * The stairwell is GEOMETRY, not a recording: `stairCells(entrance, level)` (pure) says for every cell whether it is walkway (air/torch) or
//    floor/wall/ceiling. 2 wide (keep right: down lane / up lane), 3 high, one block down per step, a landing every ~16 steps (switchback, so
//    every level's hub lies under the mine head), a torch every 6 steps. Digging it and repairing it are ONE routine (`repairStairs`): make the
//    world equal to the geometry. `walkRoute` audits the next rows on EVERY commute and repairs before it steps (`stair_broken` ->
//    `stair_repaired`, verified by looking at the blocks). A repair block is only ever placed into a floor/wall/ceiling cell of the geometry.
//  * Underground a miner moves ONLY along the graph branch -> trunk -> hub -> stairs -> mine head, with raw controls. No pathfinder below ground.
//    `toSurface(bot)` works from any cell (position -> graph part by geometry, never a search through rock) and is THE exit for everything:
//    shift end, job switch (army_jobs upTheStairs), hunger, full pack, worn picks. Off the graph (fell into a cave): a 1x2 stepped connection to
//    the nearest graph cell inside the mine's box, reported as `mine_reconnect` - never a tunnel to the sky.
//  * Levels: params.args.level (16 = iron/coal first, -54 = diamonds later, same stairwell extended; every level's landing has a door to its
//    own 2-wide trunk, branches every 3rd block). NO X-RAY: only ore with a face opened by our own digging, plus the rest of that vein.
//  * The entrance comes ONLY from params.args.entrance or settings.mineHead {x,y,z,facing}. bots/iron_mine.json is a CACHE keyed by that entrance
//    (progress `dug`, lease, branch claims, + derived `steps`/`hub`/`levelY` for readers); another entrance = another mine = a fresh cache.
const fs = require('fs')
const swallow = require('./swallow')
const path = require('path')
const { Vec3 } = require('vec3')
const U = require('./util')
const C = require('./craft')

const DIR = process.env.IRON_STATE_DIR || path.join(__dirname, '..', '..') // the override is for the offline tests only: they must never touch the field's cache
const FILE = path.join(DIR, 'iron_mine.json')
const HB_DIR = path.join(DIR, 'iron_hb')
const LEDGER = path.join(DIR, 'iron_ledger.json')

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]   // east, south, west, north; right of DIRS[i] = DIRS[(i + 1) % 4]
const FACING = { east: 0, south: 1, west: 2, north: 3, e: 0, s: 1, w: 2, n: 3 }
const FACES = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const LEVEL_Y = 16            // feet y of the first level (iron/coal band) when the job names none
const LANDING_EVERY = 16      // a landing at every y that is a multiple of 16, and at every level
const MIN_FLIGHT = 3          // no flight shorter than 3 steps: 2 flights + a landing must clear the flight above (geometry self-check proves it)
const STAIR_TORCH = 6         // a torch every 6 steps: light >= 8 everywhere on the flight
const SPACING = 3             // a branch every 3rd trunk block (2 solid between: every ore block shows a face to one of them)
const FIRST_OFF = 4           // first branch 4 blocks beyond the hub row: rock stays between the landing's end wall and branch 0
const BRANCH_LEN = 32
const MAX_BRANCH = 256        // THE LIMIT of a branch (was 128). 09-20 03:00Z: five levels x 80 branches x 128 were worked out in a day by 26 miners, iron 8/224
const K_MAX = 80              // THE LIMIT of a level: branch pairs = a 243-block trunk (was 40 = 123 blocks; world 1's trunk grew for ever through the dark:
                              // 218 blocks, 7 creeper deaths/h - this one is 2 wide, lit and walked keep-right). A level GROWS BY ITSELF (claimBranch): new
                              // mouths further along the trunk first (nearest the hub first), then the branches that merely reached their length grow by 32
                              // up to MAX_BRANCH. A trunk that cannot be driven on (water, a void: two miners failed at the same place) ends the level there
                              // (`kStop`). Everything at its limit on every level -> `mine_exhausted` (iron_miner, once an hour).
const TRUNK_LEN = FIRST_OFF + SPACING * (K_MAX - 1) + 1
const TORCH_EVERY = 9         // branches
const CLAIM_MS = 8 * 60 * 1000
const FILL = ['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'dirt', 'stone', 'deepslate']
const JUNK_RE = /^(andesite|diorite|granite|tuff|gravel|dirt|cobbled_deepslate|flint|calcite|smooth_basalt|dripstone_block|pointed_dripstone|snowball|snow_block|clay_ball|clay|rotten_flesh|bone|arrow|string|gunpowder|spider_eye|.*_sapling|.*_seeds)$/
const GRAVITY = new Set(['gravel', 'sand', 'red_sand'])
const ORE_RE = /^(deepslate_)?(coal|iron|gold|redstone|lapis|diamond|emerald)_ore$/   // copper deliberately skipped
const HOSTILE = U.HOSTILE // ONE list (util.js)

const sleep = U.sleep
const army = () => require('./army') // lazy: army.js loads us nowhere, but a cycle through army_jobs must never bite at require time
const say = (bot, rec) => { try { army().result(bot, Object.assign({ job: bot.__armyJob || null }, rec)) } catch (e_) { swallow('iron_core:say', e_) } }
// the same report at most once per `ms` per bot (a broken cell must not become an event storm of 12 commuters x every pass)
function sayOnce (bot, sig, ms, rec) { const m = bot.__ironSaid = bot.__ironSaid || {}; if (Date.now() - (m[sig] || 0) < ms) return false; m[sig] = Date.now(); if (rec) say(bot, rec); return true }

// ------------------------------------------------------------------ GEOMETRY (pure: no bot, no world, no file - unit-tested offline)
function dirIndex (f) { if (Number.isInteger(f)) return ((f % 4) + 4) % 4; const k = FACING[String(f == null ? '' : f).toLowerCase()]; return k == null ? null : k }
// {x,y,z,facing} | [x,y,z,facing] -> {x,y,z,dir} or null. (x,y,z) = FEET cell of the left mouth cell on the mine-head pad; the second lane is to its
// right, the stairs go down towards `facing`. Nothing is guessed: no facing = no entrance.
function normEntrance (e) {
  if (Array.isArray(e)) e = { x: e[0], y: e[1], z: e[2], facing: e[3] }
  if (!e || ![e.x, e.y, e.z].every(Number.isFinite)) return null
  const dir = dirIndex(e.facing != null ? e.facing : e.dir)
  if (dir == null) return null
  return { x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z), dir }
}
const ck = (x, y, z) => x + ',' + y + ',' + z
function span (from, to) { const o = []; for (let l = from; l !== to;) { l += Math.sign(to - l); o.push(l) } return o } // lanes after `from` up to `to`

// Every cell of the stairwell from the mouth down to `level` (opts.levels = the other levels ever opened: their landings keep their doors).
// Local coordinates: a = along `facing`, l = lane to the right, flights alternate between lanes 0-1 (going out) and 3-4 (coming back), lane 2 is
// the wall between them; a landing is 2 rows x lanes 0..4 at the end of each flight; a LEVEL landing (hub) has a 2x2 door in its end wall
// (lanes 2-3) where that level's trunk starts. Returns {E, cells: Map 'x,y,z' -> {x,y,z,kind,g,above?,wall?}, groups, flights, levels, feet, box}:
//   kind  air | torch (walkway; torch = a wall torch belongs here)  ·  floor | wall | ceiling (must be solid: THE repairable set)
//   g     index of the audit group (mouth, one per step, one per landing) · above = at/above the pad (open air, the mine-head build owns it)
// Throws when the geometry would contradict itself (a walkway cell that another row needs solid) - refuse to dig rather than dig nonsense.
function stairCells (entrance, level, opts = {}) {
  const E = normEntrance(entrance)
  if (!E) throw new Error('stairCells: entrance needs x,y,z,facing')
  const levels = [...new Set([level].concat(opts.levels || []).filter(Number.isFinite).map(Math.floor))].sort((p, q) => q - p)
  if (!levels.length) throw new Error('stairCells: no level')
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] > E.y - MIN_FLIGHT || levels[i] < -59) throw new Error('stairCells: level ' + levels[i] + ' must lie in -59..' + (E.y - MIN_FLIGHT))
    if (i && levels[i - 1] - levels[i] < MIN_FLIGHT) throw new Error('stairCells: levels ' + levels[i - 1] + ' and ' + levels[i] + ' are closer than ' + MIN_FLIGHT)
  }
  const bottom = levels[levels.length - 1]
  const ys = levels.slice()
  for (let y = Math.floor((E.y - 1) / LANDING_EVERY) * LANDING_EVERY; y > bottom; y -= LANDING_EVERY) if (y <= E.y - MIN_FLIGHT && levels.every(q => Math.abs(q - y) >= MIN_FLIGHT)) ys.push(y)
  ys.sort((p, q) => q - p)
  const d = DIRS[E.dir]; const r = DIRS[(E.dir + 1) % 4]
  const at = (a, l, y) => [E.x + d[0] * a + r[0] * l, y, E.z + d[1] * a + r[1] * l]
  const groups = [{ type: 'mouth', y: E.y, rows: [{ a: 0, y: E.y, lanes: [0, 1], h: 3 }], torches: [] }]
  const flights = []; const lv = {}
  let a = 0; let y = E.y; let side = 0; let s = 1; let n = 0
  for (const ly of ys) {
    const pair = side ? [3, 4] : [0, 1]
    const fl = { side, s, pair, steps: [] }
    while (y > ly) {
      a += s; y--; n++
      groups.push({ type: 'step', n, y, rows: [{ a, y, lanes: pair, h: 3 }], torches: n % STAIR_TORCH === 0 ? [{ c: at(a, side ? 4 : 0, y + 2), wall: at(a, side ? 5 : -1, y + 2) }] : [] })
      fl.steps.push({ a, y, g: groups.length - 1 })
    }
    const isLevel = levels.includes(ly)
    const rows = [{ a: a + s, y: ly, lanes: [0, 1, 2, 3, 4], h: 3 }, { a: a + 2 * s, y: ly, lanes: [0, 1, 2, 3, 4], h: 3 }]
    if (isLevel) rows.push({ a: a + 3 * s, y: ly, lanes: [2, 3], h: 2, door: s })
    groups.push({ type: isLevel ? 'hub' : 'landing', y: ly, rows, torches: [{ c: at(a + 2 * s, 0, ly + 2), wall: at(a + 2 * s, -1, ly + 2) }, { c: at(a + 2 * s, 4, ly + 2), wall: at(a + 2 * s, 5, ly + 2) }] })
    fl.landing = { a1: a + s, a2: a + 2 * s, y: ly, g: groups.length - 1, level: isLevel }
    flights.push(fl)
    if (isLevel) { const tdir = s > 0 ? E.dir : (E.dir + 2) % 4; const h = at(a + 2 * s, s > 0 ? 2 : 3, ly); lv[ly] = { y: ly, g: groups.length - 1, s, hub: { x: h[0], y: ly, z: h[2], dir: tdir } } }
    a = a + s; s = -s; side ^= 1 // the next flight starts beside the last step of this one, on the other pair of lanes, going back
  }
  // pass 1: the walkway. pass 2: what must be solid around it - never where pass 1 said walkway
  const cells = new Map(); const feet = new Map()
  groups.forEach((grp, g) => { for (const row of grp.rows) for (const l of row.lanes) { feet.set(ck(...at(row.a, l, row.y)), g); for (let dy = 0; dy < row.h; dy++) { const p = at(row.a, l, row.y + dy); cells.set(ck(...p), { x: p[0], y: p[1], z: p[2], kind: 'air', g }) } } })
  groups.forEach((grp) => { for (const t of grp.torches) { const c = cells.get(ck(...t.c)); if (!c) throw new Error('stairCells: torch outside the walkway'); c.kind = 'torch'; c.wall = t.wall } })
  groups.forEach((grp, g) => {
    grp.cells = []
    const seen = new Set()
    const add = (p, kind) => {
      const k = ck(...p); let c = cells.get(k)
      if (!c) { c = { x: p[0], y: p[1], z: p[2], kind, g }; if (p[1] >= E.y) c.above = true; cells.set(k, c) } else if (kind === 'floor' && (c.kind === 'air' || c.kind === 'torch')) throw new Error('stairCells: floor ' + k + ' is walkway of group ' + c.g)
      if (!seen.has(k)) { seen.add(k); grp.cells.push(c) }
    }
    for (const row of grp.rows) for (const l of row.lanes) {
      for (let dy = 0; dy < row.h; dy++) add(at(row.a, l, row.y + dy), 'air')
      add(at(row.a, l, row.y - 1), 'floor'); add(at(row.a, l, row.y + row.h), 'ceiling')
      for (const [da, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { if (row.door && da === row.door) continue; for (let dy = 0; dy < row.h; dy++) add(at(row.a + da, l + dl, row.y + dy), 'wall') } // beyond the door the trunk goes on
    }
  })
  // REAL STAIRS (owner 09-20 "階段化"; measured on this stairwell: full blocks = ONE JUMP PER STEP, 1.6 steps/s up - the jump cadence of the physics, no code can
  // beat it). A TREAD is the floor block of a step laid as a `*_stairs` block that ascends towards the mouth: rises of 0.5 are WALKED (step height 0.6). Tread rows:
  // the floor of every step ABOVE its landing's level (the last step is level with the landing: it stays a block) + the edge row of the landing at the flight's TOP
  // (its low half meets the first step's high half) - but never the mouth row: the mine-head pad belongs to its build job, that one block is still jumped.
  // treads: 'x,y,z' of a floor cell -> {dir: index into DIRS of the way UP (= the block's `facing`), row: the row's two cells}
  const treads = new Map()
  flights.forEach((fl, i) => {
    const upDir = fl.s > 0 ? (E.dir + 2) % 4 : E.dir
    const rows = fl.steps.filter(st => st.y > fl.landing.y).map(st => ({ a: st.a, y: st.y - 1 }))
    if (i > 0 && fl.steps.length) rows.unshift({ a: fl.steps[0].a - fl.s, y: fl.steps[0].y })
    for (const r of rows) { const row = fl.pair.map(l => at(r.a, l, r.y)); for (const q of row) { const c = cells.get(ck(...q)); if (!c || c.kind !== 'floor') throw new Error('stairCells: tread ' + ck(...q) + ' is not a floor cell'); treads.set(ck(...q), { dir: upDir, row }) } }
  })
  let box = null
  for (const c of cells.values()) { if (!box) box = { x1: c.x, x2: c.x, y1: c.y, y2: c.y, z1: c.z, z2: c.z }; else { box.x1 = Math.min(box.x1, c.x); box.x2 = Math.max(box.x2, c.x); box.y1 = Math.min(box.y1, c.y); box.y2 = Math.max(box.y2, c.y); box.z1 = Math.min(box.z1, c.z); box.z2 = Math.max(box.z2, c.z) } }
  return { E, at, level: bottom, levelList: levels, cells, groups, flights, levels: lv, feet, box, treads }
}
const isWalk = c => !!c && (c.kind === 'air' || c.kind === 'torch')
const isRepairable = c => !!c && (c.kind === 'floor' || c.kind === 'wall' || c.kind === 'ceiling')

// KEEP RIGHT. Waypoints [{p:[x,y,z], g}] mouth -> the R lane of `level`'s hub row (routeDown) / hub L lane -> mouth (routeUp). On a landing the
// down lane crosses on the first row, the up lane on the second: the two never share a cell (world 1: 16 miners deadlocked on one stairhead).
function laneDown (fl) { return fl.s > 0 ? fl.pair[1] : fl.pair[0] }
function laneUp (fl) { return fl.s > 0 ? fl.pair[0] : fl.pair[1] }
function routeDown (G, level) {
  const out = [{ p: G.at(0, 1, G.E.y), g: 0 }]
  for (let i = 0; i < G.flights.length; i++) {
    const fl = G.flights[i]; const dl = laneDown(fl); const L = fl.landing
    for (const st of fl.steps) out.push({ p: G.at(st.a, dl, st.y), g: st.g })
    out.push({ p: G.at(L.a1, dl, L.y), g: L.g })
    if (L.y === level) { const R = fl.s > 0 ? 3 : 2; for (const l of span(dl, R)) out.push({ p: G.at(L.a1, l, L.y), g: L.g }); out.push({ p: G.at(L.a2, R, L.y), g: L.g }); return out }
    const nx = G.flights[i + 1]; if (!nx) break
    for (const l of span(dl, laneDown(nx))) out.push({ p: G.at(L.a1, l, L.y), g: L.g })
  }
  throw new Error('routeDown: level ' + level + ' is not a level of this stairwell')
}
function routeUp (G, level) {
  const out = [{ p: G.at(0, 0, G.E.y), g: 0 }]
  for (let i = 0; i < G.flights.length; i++) {
    const fl = G.flights[i]; const ul = laneUp(fl); const L = fl.landing
    for (const st of fl.steps) out.push({ p: G.at(st.a, ul, st.y), g: st.g })
    out.push({ p: G.at(L.a1, ul, L.y), g: L.g }, { p: G.at(L.a2, ul, L.y), g: L.g })
    if (L.y === level) { for (const l of span(ul, fl.s > 0 ? 2 : 3)) out.push({ p: G.at(L.a2, l, L.y), g: L.g }); return out.reverse() }
    const nx = G.flights[i + 1]; if (!nx) break
    for (const l of span(ul, laneUp(nx))) out.push({ p: G.at(L.a2, l, L.y), g: L.g })
    out.push({ p: G.at(L.a1, laneUp(nx), L.y), g: L.g })
  }
  throw new Error('routeUp: level ' + level + ' is not a level of this stairwell')
}

// The level: hub = lane L (0) of the landing's second row, `dir` = the trunk's direction; lane R (1) is one to the right. Trunk offset 1 = the door.
// Branch (k, side) leaves lane R (side +1) / lane L (side -1) at offset FIRST_OFF + SPACING*k, len cells sideways.
function trunkCell (hub, off, lane = 0) { const d = DIRS[hub.dir]; const r = DIRS[(hub.dir + 1) % 4]; return { x: hub.x + d[0] * off + r[0] * lane, y: hub.y, z: hub.z + d[1] * off + r[1] * lane } }
function branchOff (k) { return FIRST_OFF + SPACING * k }
function branchDir (hub, side) { return (hub.dir + (side > 0 ? 1 : 3)) % 4 }
function branchCell (hub, k, side, len) { const t = trunkCell(hub, branchOff(k), side > 0 ? 1 : 0); const d = DIRS[branchDir(hub, side)]; return { x: t.x + d[0] * len, y: hub.y, z: t.z + d[1] * len } }
function relTo (hub, x, z) { const d = DIRS[hub.dir]; const r = DIRS[(hub.dir + 1) % 4]; const rx = x - hub.x; const rz = z - hub.z; return { along: rx * d[0] + rz * d[1], across: rx * r[0] + rz * r[1] } }
function onLevel (hub, p, tolDown = 0) { // which line of this level is column p on?  tolDown: a bot up to 3 under the line still counts (walkLine climbs back)
  if (p.y > hub.y + (tolDown ? 1 : 0) || p.y < hub.y - tolDown) return null
  const q = relTo(hub, p.x, p.z)
  if (q.along < 0 || q.along > TRUNK_LEN) return null
  if (q.across === 0 || q.across === 1) return { part: 'trunk', along: q.along, lane: q.across }
  const k = (q.along - FIRST_OFF) / SPACING
  if (!Number.isInteger(k) || k < 0 || k >= K_MAX) return null
  const len = q.across >= 2 ? q.across - 1 : -q.across
  return len >= 1 && len <= MAX_BRANCH ? { part: 'branch', k, side: q.across >= 2 ? 1 : -1, len } : null
}
// position -> part of the mine graph, by geometry alone: {part:'stair', g, p} | {part:'trunk'|'branch', level, …} | null = OFF the graph
function locate (G, p, tolDown = 3) {
  for (const dy of [0, -1, 1]) { const g = G.feet.get(ck(p.x, p.y + dy, p.z)); if (g != null) return { part: 'stair', g, p: [p.x, p.y + dy, p.z] } }
  for (const lv of Object.values(G.levels)) { const q = onLevel(lv.hub, p, tolDown); if (q) return Object.assign(q, { level: lv.y }) }
  return null
}
function onGraph (G, p) { return !!locate(G, { x: p[0], y: p[1], z: p[2] }, 0) }
// THE WAY OUT from graph cell p, as data: {legs, cells}. legs = straight level lines ({line:[x,y,z]}) then the stair route ({stairs:[wp…]});
// cells = every cell of it in walking order (what the offline test checks against onGraph). null = p is not on the graph.
function planUp (G, p) {
  const loc = locate(G, p)
  if (!loc) return null
  const legs = []; const cells = []
  let cur = [p.x, p.y, p.z]
  const lineTo = (t) => { const to = [t.x, t.y, t.z]; if (to[0] === cur[0] && to[2] === cur[2]) return; legs.push({ line: to }); while (cur[0] !== to[0] || cur[2] !== to[2]) { cur = [cur[0] + Math.sign(to[0] - cur[0]), to[1], cur[2] + Math.sign(to[2] - cur[2])]; cells.push(cur) } }
  let level = G.level; let route = null
  if (loc.part !== 'stair') {
    level = loc.level; const hub = G.levels[level].hub
    cells.push([p.x, hub.y, p.z])
    cur = [p.x, hub.y, p.z]
    if (loc.part === 'branch') lineTo(trunkCell(hub, branchOff(loc.k), loc.side > 0 ? 1 : 0))
    const q = relTo(hub, cur[0], cur[2])
    lineTo(trunkCell(hub, q.along, 0)) // inbound = lane L (keep right)
    lineTo(hub)
    route = routeUp(G, level)
  } else {
    // anywhere in the stairwell: shortest walk over walkway cells onto the up lane, then along it
    route = routeUp(G, G.level)
    const idx = new Map(route.map((w, i) => [ck(...w.p), i]))
    const start = ck(...loc.p); const prev = new Map([[start, null]]); const q = [loc.p]; let hit = null
    while (q.length && !hit) {
      const c = q.shift()
      if (idx.has(ck(...c))) { hit = c; break }
      for (const [dx, dz] of DIRS) for (const dy of [0, 1, -1]) { const nb = [c[0] + dx, c[1] + dy, c[2] + dz]; const k = ck(...nb); if (G.feet.has(k) && !prev.has(k)) { prev.set(k, c); q.push(nb) } }
    }
    if (!hit) return null
    const join = []; for (let c = hit; c; c = prev.get(ck(...c))) join.unshift(c)
    route = join.slice(0, -1).map(c => ({ p: c, g: G.feet.get(ck(...c)) })).concat(route.slice(idx.get(ck(...hit))))
  }
  legs.push({ stairs: route })
  for (const w of route) if (!cells.length || ck(...cells[cells.length - 1]) !== ck(...w.p)) cells.push(w.p)
  return { level, legs, cells }
}
// the box the mine may ever occupy (stairwell + every level's trunk and branches): reconnect digs only inside it
function mineBox (G) {
  const b = Object.assign({}, G.box)
  for (const lv of Object.values(G.levels)) for (const [off, across] of [[0, -MAX_BRANCH - 1], [0, MAX_BRANCH + 2], [TRUNK_LEN, -MAX_BRANCH - 1], [TRUNK_LEN, MAX_BRANCH + 2]]) {
    const c = trunkCell(lv.hub, off, across); b.x1 = Math.min(b.x1, c.x); b.x2 = Math.max(b.x2, c.x); b.z1 = Math.min(b.z1, c.z); b.z2 = Math.max(b.z2, c.z); b.y1 = Math.min(b.y1, lv.y - 8)
  }
  return b
}
function inBox (b, p, m = 0) { return p.x >= b.x1 - m && p.x <= b.x2 + m && p.z >= b.z1 - m && p.z <= b.z2 + m && p.y >= b.y1 - m && p.y <= b.y2 + m }

// ------------------------------------------------------------------ state file (a CACHE keyed by the entrance; atomic tmp+rename under a lock)
const DEFAULT = { key: null, entrance: null, facing: null, levels: [], levelY: null, dug: -1, lv: {}, stairLease: null, trips: [], updated: 0 }
const keyOf = E => [E.x, E.y, E.z, E.dir].join(',')
function readRaw () { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') swallow('iron_core:readState', e); return null } }
function read (E) {
  const raw = readRaw()
  if (raw && (!E || raw.key === keyOf(E))) return Object.assign(JSON.parse(JSON.stringify(DEFAULT)), raw)
  return JSON.parse(JSON.stringify(DEFAULT))
}
function lvState (d, level) { d.lv = d.lv || {}; const k = String(level); if (!d.lv[k]) d.lv[k] = { branches: {}, branchLen: BRANCH_LEN }; return d.lv[k] }
async function update (E, fn) {
  return U.withLock('iron-mine', async () => {
    const raw = readRaw()
    // a cache of ANOTHER entrance (old world, moved mine head) is never mixed in: it is set aside UNDER ITS OWN KEY, and the one of this entrance
    // comes back when it was set aside before. (09-20 05:40Z: a plan moved the entrance by one block for 60 s; bots remembering either entrance then
    // renamed each other's cache onto the ONE `.stale` file in turn - five levels of branch ledgers and the restored copy were gone within 2 min,
    // `dug -1`, the whole squad stood at a stairwell "to be dug".)
    if (raw && raw.key !== keyOf(E)) {
      const aside = k => FILE + '.' + String(k || 'nokey').replace(/[^0-9,-]/g, '') + '.stale'
      try { fs.renameSync(FILE, aside(raw.key)) } catch (e_) { swallow('iron_core:staleCache', e_) }
      try { if (fs.existsSync(aside(keyOf(E)))) fs.renameSync(aside(keyOf(E)), FILE) } catch (e_) { swallow('iron_core:staleCacheBack', e_) }
    }
    const d = read(E)
    d.key = keyOf(E); d.entrance = [E.x, E.y, E.z]; d.facing = Object.keys(FACING)[E.dir]
    const r = await fn(d)
    d.updated = Date.now()
    const tmp = FILE + '.tmp.' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(d))
    fs.renameSync(tmp, FILE)
    return r === undefined ? d : r
  }, 15000)
}
// ONE report for the whole squad: every bot is its own process, so sayOnce/sayGroup repeat a squad-wide fact once PER BOT (09-19: `mine_level_refused`
// x12 in 3 s). The stamp lives in the mine's cache (d.said[sig] = t) under its lock. -> true when this bot was the one that said it.
async function sayMine (bot, E, sig, ms, rec) {
  try {
    const mine = await update(E, d => { d.said = d.said || {}; const now = Date.now(); for (const k of Object.keys(d.said)) if (now - d.said[k] > 6 * 3600000) delete d.said[k]; if (now - (d.said[sig] || 0) < ms) return false; d.said[sig] = now; return true })
    if (mine) say(bot, rec)
    return mine
  } catch (e_) { swallow('iron_core:sayMine', e_); return false }
}
function hb (bot, info) {
  try {
    if (!fs.existsSync(HB_DIR)) fs.mkdirSync(HB_DIR, { recursive: true })
    const f = path.join(HB_DIR, bot.username + '.json')
    let old = {}
    try { old = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') swallow('iron_core:hbRead', e) }
    const p = bot.entity && bot.entity.position
    const o = Object.assign(old, {
      t: Date.now(), bot: bot.username, hp: bot.health, food: bot.food,
      pos: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null,
      task: bot.state && bot.state.task, note: bot.__lastNote || null
    }, info || {})
    fs.writeFileSync(f + '.tmp', JSON.stringify(o))
    fs.renameSync(f + '.tmp', f)
  } catch (e_) { swallow('iron_core:hb', e_) }
}
function bump (bot, key, n = 1) {
  if (!bot.__ironStats) bot.__ironStats = {}
  bot.__ironStats[key] = (bot.__ironStats[key] || 0) + n
}
async function ledger (entry) {
  return U.withLock('iron-ledger', async () => {
    let l = []
    try { l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') swallow('iron_core:ledgerRead', e) }
    l.push(Object.assign({ t: Date.now() }, entry))
    if (l.length > 2000) l = l.slice(-2000)
    fs.writeFileSync(LEDGER + '.tmp', JSON.stringify(l))
    fs.renameSync(LEDGER + '.tmp', LEDGER)
  }, 8000)
}

// ------------------------------------------------------------------ the mine of THIS job: entrance + level -> geometry + cache
let CUR = null // the last resolved mine of this process: the place/dig guards below look cells up in it
let _geo = { k: null, G: null }
function geometry (E, level, levels) { const k = keyOf(E) + '|' + level + '|' + levels.join(','); if (_geo.k !== k) _geo = { k, G: stairCells(E, level, { levels }) }; return _geo.G }
const rowSig = grp => grp.rows.filter(r => !r.door).map(r => [r.a, r.y, r.lanes.join('')].join(':')).join('|')
// -> M = {E, level, levels, G, lv:{y,g,hub}, box, st} or null (reported: mine_no_entrance | mine_bad_level | mine_level_refused)
// opts.recall (toSurface from outside the skill): the entrance may also come from the cache a miner wrote - a bot that IS down there must get out
// even when the caller knows no params - and a missing mine is no event (not every underground bot is in a mine).
async function mine (bot, args = {}, opts = {}) {
  let src = args.entrance != null ? args.entrance : army().settings().mineHead
  // a RECALL never moves the mine: the cache the working miners keep says where it is; an entrance this bot remembers from an earlier run
  // (bot.__ironArgs) only counts when there is no cache at all (05:40Z: recalled bots with a 60-s-old entrance reset the cache of the live one)
  if (opts.recall) { const raw = readRaw(); if (raw && raw.entrance && raw.dug >= 0) src = raw.entrance.concat([raw.facing]) }
  const E = normEntrance(src)
  if (!E) { if (!opts.recall) sayOnce(bot, 'no_entrance', 300000, { ev: 'mine_no_entrance', note: 'the mine needs params.args.entrance or settings.mineHead = {x,y,z,facing: north|south|east|west} (feet cell of the left mouth lane on the pad)' }); return null }
  let st = read(E)
  let level = Number.isFinite(args.level) ? Math.floor(args.level) : (st.levelY != null ? st.levelY : LEVEL_Y)
  try {
    // opts.visit (iron_miner's fallback to another DUG level that still has work): the job's working level in the cache stays what the board says
    if (!(opts.visit && st.levels.includes(level) && st.key != null) && (!st.levels.includes(level) || st.levelY !== level || st.key == null)) {
      // a NEW level must leave every row that is already dug where it is (a landing inserted above the dug depth would shift all flights below it)
      if (!st.levels.includes(level) && st.levels.length && st.dug >= 0) {
        const deepest = Math.min(...st.levels)
        const oldG = stairCells(E, deepest, { levels: st.levels }); const newG = stairCells(E, Math.min(level, deepest), { levels: st.levels.concat([level]) })
        for (let g = 0; g <= Math.min(st.dug, oldG.groups.length - 1); g++) if (!newG.groups[g] || rowSig(newG.groups[g]) !== rowSig(oldG.groups[g])) throw new Error('level ' + level + ' would move stair rows that are already dug (row ' + g + '): use a landing y (multiple of ' + LANDING_EVERY + ') or a level below ' + deepest)
      } else if (!st.levels.includes(level)) stairCells(E, level, { levels: st.levels }) // throws on a bad level
      st = await update(E, d => { if (!d.levels.includes(level)) d.levels.push(level); d.levelY = level; lvState(d, level); derive(d, E) })
    }
  } catch (e) {
    if (sayOnce(bot, 'bad_level', 300000, null)) await sayMine(bot, E, 'bad_level@' + level, 600000, { ev: st.levels.length ? 'mine_level_refused' : 'mine_bad_level', level, keeps: st.levelY, why: String(e && e.message || e).slice(0, 160) })
    if (st.levelY == null) return null
    level = st.levelY
  }
  const G = geometry(E, Math.min(...st.levels), st.levels.slice().sort((p, q) => q - p))
  CUR = { E, level, levels: st.levels, G, lv: G.levels[level], box: mineBox(G), st }
  return CUR
}
// derived fields for READERS of the cache (armyctl `mine`, army_jobs' keep-out boxes): never read back by this file
function derive (d, E) {
  try { const G = stairCells(E, Math.min(...d.levels), { levels: d.levels }); d.steps = routeDown(G, d.levelY).map(w => w.p); d.hub = G.levels[d.levelY].hub; d.hubGroup = G.levels[d.levelY].g } catch (e_) { swallow('iron_core:derive', e_) }
}
function refresh (M) { M.st = read(M.E); return M.st }
// below the pad and inside the mine's box = "underground in OUR mine" (sync; army_jobs asks this before it sends a bot anywhere on the surface)
function underground (bot, M = CUR) { if (!M || !bot.entity) return false; const f = feet(bot); return f.y < M.E.y - 1 && inBox(M.box, f, 12) && (!!locate(M.G, f) || (roofed(bot, f) && !inHole(f))) }
// THE RAVINE IS NOT THE MINE (measured 09-20 05:30-06:30Z: 95 `mine_reconnect` galleries in an hour from the ravine floor through the stairwell's wall at y48 - its
// overhangs count as "roofed"). A bot inside a `settings.keepOut` box, above that hole's floor (`floor`, default base y - 30), walks out by the hole's exit (A.travel).
function inHole (f) {
  try {
    const S = army().settings(); const by = ((S.base || {}).y) || 68
    return (S.keepOut || []).some(k => k && Array.isArray(k.box) && k.box.length === 4 && f.x >= Math.min(k.box[0], k.box[2]) && f.x <= Math.max(k.box[0], k.box[2]) && f.z >= Math.min(k.box[1], k.box[3]) && f.z <= Math.max(k.box[1], k.box[3]) && f.y >= (Number.isFinite(k.floor) ? k.floor : by - 30) - 2)
  } catch (e_) { swallow('iron_core:inHole', e_); return false }
}
// rock overhead (>= 3 solid blocks in the 10 above): a farmer in a 3-deep pit inside the mine's (large) box is NOT "in the mine" - no gallery for him
function roofed (bot, f) { let n = 0; for (let dy = 2; dy <= 11; dy++) if (isSolid(blk(bot, f.x, f.y + dy, f.z))) n++; return n >= 3 }
// walkway of the shared infrastructure (stairwell, trunks, branch mouths): nothing but a torch is ever PLACED there
function walkway (x, y, z) {
  const M = CUR; if (!M) return false
  const c = M.G.cells.get(ck(x, y, z)); if (c) return isWalk(c)
  for (const lv of Object.values(M.G.levels)) {
    if (y !== lv.y && y !== lv.y + 1) continue
    const q = relTo(lv.hub, x, z)
    if (q.along < 0 || q.along > TRUNK_LEN) continue
    if (q.across === 0 || q.across === 1) return true
    if ((q.across === -1 || q.across === 2) && q.along >= FIRST_OFF && (q.along - FIRST_OFF) % SPACING === 0) return true
  }
  return false
}
function stairSolid (x, y, z) { return !!CUR && isRepairable(CUR.G.cells.get(ck(x, y, z))) }

// ------------------------------------------------------------------ block helpers
function blk (bot, x, y, z) { return bot.blockAt(new Vec3(x, y, z)) }
function isLiquid (b) { return !!b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column' || (b.getProperties && b.getProperties().waterlogged === true)) }
function isSolid (b) { return !!b && b.boundingBox === 'block' && !isLiquid(b) }
function isOpen (b) { return !!b && b.boundingBox !== 'block' && !isLiquid(b) }
function eye (bot) { return bot.entity.position.offset(0, 1.62, 0) }
function eyeDist (bot, p) { return eye(bot).distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) }
function feet (bot) { return bot.entity.position.offset(0, 0.5, 0).floored() } // + 0.5: on the low half of a tread (y = n.5) the feet cell is the step's, not the one below
function fillItem (bot) { return FILL.find(n => U.count(bot, n) > 0) || null }
// A run is stale when cancelled, superseded by a newer iron_miner run, or when ANOTHER skill took the bot over
// (e.g. team_mining_forage): two loops on one bot fight over controls/pathfinder and neither works.
function foreignTask (bot) {
  const t = bot.state && bot.state.task
  return typeof t === 'string' && t !== 'idle' && !/^iron:/.test(t) && !/^skill:iron_miner/.test(t)
}
function stale (bot, gen) { return !bot.entity || (bot.state && bot.state.cancel) || (gen != null && bot.__ironGen !== gen) || foreignTask(bot) }

// place `item` INTO pos (air or liquid) using any solid neighbour as reference; true = the block is THERE afterwards (looked at, not assumed).
// NEVER into the walkway of the stairwell / a trunk / a branch mouth (world 1, 09-19 11:58Z: a "side wall" block at a stair corner was the next
// step's headroom - cobblestone at -24,-28,13 closed the only stair in both directions; mob walls did the same in the trunk). opts.temp = the
// caller digs the cell out again at once (plugging a liquid source that sits in a cell we are opening).
async function placeAt (bot, item, pos, opts = {}) {
  const cur = bot.blockAt(pos)
  if (isSolid(cur)) return true
  if (!item || U.count(bot, item) <= 0) return false
  if (item !== 'torch' && !opts.temp && walkway(pos.x, pos.y, pos.z)) { bump(bot, 'walkwayRefused'); return false }
  if (eyeDist(bot, pos) > 4.6) return false
  const f = feet(bot)
  if ((pos.x === f.x && pos.z === f.z) && (pos.y === f.y || pos.y === f.y + 1)) return false // would entomb ourselves
  if (!await U.equip(bot, item, 'hand')) return false
  for (const d of FACES) {
    const ref = bot.blockAt(pos.offset(-d[0], -d[1], -d[2]))
    if (!isSolid(ref)) continue
    try {
      await U.withTimeout(bot.placeBlock(ref, new Vec3(d[0], d[1], d[2])), 2500, 'place')
    } catch (e_) { swallow('iron_core:placeAt', e_) } // judged on the block below, not on the promise
    await sleep(60)
    const nb = bot.blockAt(pos)
    if (item === 'torch' ? (nb && /torch/.test(nb.name)) : isSolid(nb)) return true
  }
  return false
}
async function plug (bot, pos, opts) {
  const it = fillItem(bot)
  if (!it) return false
  const ok = await placeAt(bot, it, pos, opts)
  if (ok) bump(bot, 'plugs')
  return ok
}

// ------------------------------------------------------------------ tools
function pickaxes (bot) { return bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)) }
function durLeft (bot, it) {
  const max = (bot.registry.itemsByName[it.name] || {}).maxDurability || 131
  let used = 0
  try { used = it.durabilityUsed || 0 } catch (e_) { swallow('iron_core:q1', e_) }
  return max - used
}
function pickRank (n) { return /^(diamond|netherite)/.test(n) ? 4 : /^iron/.test(n) ? 3 : /^stone/.test(n) ? 2 : 1 }
function bestPick (bot) {
  const ps = pickaxes(bot).filter(i => durLeft(bot, i) > 0)
  ps.sort((a, b) => pickRank(b.name) - pickRank(a.name) || durLeft(bot, a) - durLeft(bot, b)) // best tier, most worn first
  return ps[0] || null
}
function stonePickCount (bot) { return pickaxes(bot).filter(i => pickRank(i.name) >= 2 && durLeft(bot, i) > 8).length }
function cobbleCount (bot) { return U.count(bot, 'cobblestone') + U.count(bot, 'cobbled_deepslate') }
function woodUnits (bot) { return U.countRe(bot, U.LOG_RE) * 4 + U.countRe(bot, U.PLANK_RE) } // in planks
function canCraftPick (bot) { return cobbleCount(bot) >= 3 && (U.count(bot, 'stick') >= 2 || woodUnits(bot) >= 2) && (U.has(bot, 'crafting_table') || woodUnits(bot) >= 6) }

// our own crafting table back into the pocket (it is a PROTECTED block for digCell - this is the one place that may take one)
async function takeTable (bot, pos) {
  const b = bot.blockAt(pos)
  if (!b || b.name !== 'crafting_table' || eyeDist(bot, pos) > 4.8) return false
  try { await U.withTimeout(bot.tool.equipForBlock(b, {}), 3000, 'eq') } catch (e_) { swallow('iron_core:tableEquip', e_) }
  try { await U.withTimeout(bot.dig(b, true), 12000, 'digTable') } catch (e_) { swallow('iron_core:tableDig', e_); try { bot.stopDigging() } catch (e2) { swallow('iron_core:tableStop', e2) } }
  await sweep(bot, 2500, 3.5)
  const nb = bot.blockAt(pos)
  return !!nb && nb.name !== 'crafting_table'
}
// Put a crafting table next to us (any open neighbour cell), craft, pick it back up.
async function withTable (bot, fn) {
  let tbl = null
  try { tbl = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 3 }) } catch (e_) { swallow('iron_core:q2', e_) }
  let mine = null
  if (!tbl || eyeDist(bot, tbl.position) > 4) {
    tbl = null
    if (!U.has(bot, 'crafting_table')) {
      // 2x2 crafts hang on this server unless a table window is used -- but the very first table has no choice
      if (!await C.ensureCraftingTable(bot)) return false
    }
    const f = feet(bot)
    const cands = []
    for (const [dx, dz] of DIRS) for (const dy of [1, 0]) cands.push(f.offset(dx, dy, dz))
    for (const [dx, dz] of DIRS) for (const dy of [1, 0]) cands.push(f.offset(dx * 2, dy, dz * 2))
    for (const p of cands) {
      const b = bot.blockAt(p)
      if (!isOpen(b) || (b.name !== 'air' && b.name !== 'cave_air')) continue
      if (await placeAt(bot, 'crafting_table', p, { temp: true })) { tbl = bot.blockAt(p); mine = p; break } // temp: taken back below (a table left in a walkway is removed by the stair audit)
    }
    if (!tbl) {
      // no open neighbour (fresh 1x1 tunnel head): carve a niche at head height
      for (const [dx, dz] of DIRS) {
        const p = f.offset(dx, 1, dz)
        const r = await digCell(bot, p)
        if (r !== 'ok' && r !== 'air') continue
        if (await placeAt(bot, 'crafting_table', p, { temp: true })) { tbl = bot.blockAt(p); mine = p; break }
      }
    }
  }
  if (!tbl) return false
  let res = false
  try { res = await fn(tbl) } finally {
    if (mine) await takeTable(bot, mine)
  }
  return res
}

// Make sure we hold a usable pickaxe; craft stone ones on the spot when needed.
async function ensurePick (bot, want = 1) {
  if (stonePickCount(bot) >= want) return true
  if (!canCraftPick(bot)) return stonePickCount(bot) > 0 || !!bestPick(bot)
  await withTable(bot, async (tbl) => {
    for (let i = 0; i < 4 && stonePickCount(bot) < want; i++) {
      if (cobbleCount(bot) < 3) break
      if (U.count(bot, 'stick') < 2 && !await C.ensureSticks(bot, 2, tbl)) break
      if (!await C.craft(bot, 'stone_pickaxe', 1, tbl)) break
      bump(bot, 'picksCrafted')
    }
    return true
  })
  return !!bestPick(bot)
}
async function ensureTorches (bot, want = 16) {
  if (U.count(bot, 'torch') >= want) return true
  const coal = U.count(bot, 'coal') + U.count(bot, 'charcoal')
  if (coal < 1 || (U.count(bot, 'stick') < 1 && woodUnits(bot) < 2)) return U.count(bot, 'torch') > 0
  const times = Math.min(coal, Math.ceil((want - U.count(bot, 'torch')) / 4), 8)
  await withTable(bot, async (tbl) => {
    if (U.count(bot, 'stick') < times) await C.ensureSticks(bot, times, tbl)
    const t = Math.min(times, U.count(bot, 'stick'))
    if (t > 0) await C.craft(bot, 'torch', t, tbl)
    return true
  })
  return U.count(bot, 'torch') > 0
}

// ------------------------------------------------------------------ digging
// Dig one cell with the full §4 safety protocol. Returns:
//  'ok' dug | 'air' nothing to dig | 'liquid' refuses (unpluggable liquid) | 'notool' | 'needpick' (we carry a pick, but this block wants a better one) | 'fail' | 'protected'
// WHAT AN ABANDONED MINESHAFT LEAVES IN A LINE (09-20 06:12Z, level 0 trunk @163, z -670: its corridor crosses the trunk - a FENCE POST was the home lane's
// floor at -328,-1,-670 and -668, rails lay in the floor row, cobwebs beside). A fence reads "solid" but stands 1.5 high: under a 2-high line nobody steps
// onto it and nobody gets round it to the cell's centre -> the out lane passed, the home lane did not: 13 miners `blocked` at the far end, 12 `hung`,
// 6 recalls `surfaced:false`, and `mine_trunk_end` cut level 0 at k 53. Such a floor is TAKEN OUT and laid again; a cobweb in the line is cut; a rail /
// cobweb lying in a floor cell is lifted so the floor block can go in (digCell opts.soft opens these although they are no full blocks).
const TALL_RE = /_fence$|_fence_gate$|_wall$/
const CLUTTER_RE = /^cobweb$|(^|_)rail$/
function tallBlock (b) { return !!b && TALL_RE.test(b.name) }
function clutter (b) { return !!b && CLUTTER_RE.test(b.name) }
function isWeb (b) { return !!b && b.name === 'cobweb' }
async function digCell (bot, p, opts = {}) {
  for (let round = 0; round < 14; round++) {
    const b = bot.blockAt(p)
    if (!b) return 'fail'
    if (b.name === 'lava') noteLava(bot, p)
    if (isLiquid(b)) { if (await plug(bot, p, { temp: true })) continue; return 'liquid' } // a block put into a source IS the end of that source
    if (b.boundingBox !== 'block' && !(opts.soft && clutter(b))) return round ? 'ok' : 'air'
    // opts.obsidian: the obsidian trip mines what it cast itself (obsidian is protected for everybody else: a portal frame is furniture)
    if ((U.protectedBlock(b) && !(opts.obsidian && b.name === 'obsidian')) || b.name === 'bedrock') return 'protected'
    // the stairwell's floor/wall/ceiling belongs to everybody (world 1: a neighbour's branch and a vein excursion took stair floors away).
    // opts.breach: a reconnect gallery may come in through the wall - the next commuter's audit closes it again
    if (!opts.breach && stairSolid(p.x, p.y, p.z)) return 'protected'
    if (eyeDist(bot, p) > 4.9) return 'fail'
    // 6-neighbour liquid check BEFORE opening the cell
    let liquids = 0
    for (const d of FACES) {
      const n = bot.blockAt(p.offset(d[0], d[1], d[2]))
      if (!isLiquid(n)) continue
      if (n.name === 'lava') noteLava(bot, n.position)
      if (opts.noPlug) continue // the obsidian trip's own dam beside its own draining water: nothing to plug
      liquids++
      if (liquids > 3) return 'liquid'
      if (!await plug(bot, n.position, { temp: true })) return 'liquid'
    }
    const needsPick = !!b.harvestTools && !clutter(b) // a cobweb "needs" a sword/shears for its DROP only: equipForBlock takes the fastest tool, else the hand
    if (needsPick) {
      const pk = bestPick(bot)
      if (!pk) { if (!await ensurePick(bot, 1) && !opts.hand) return 'notool' }
      const pk2 = bestPick(bot)
      if (!pk2 && !opts.hand) return 'notool'
      // opts.hand: a bot with NO pickaxe and nothing to craft one from may punch its way (slow, no drops) - only for the short level connection
      // back to the graph (reconnect / repairs), like a player who lost his tools in a cave
      if (!pk2) { try { await U.withTimeout(bot.tool.equipForBlock(b, {}), 4000, 'equipFB') } catch (e_) { swallow('iron_core:q5', e_) } } else if (!b.harvestTools[pk2.type]) {
        // e.g. gold/diamond ore with a stone pick: leave it (drops nothing)
        const any = pickaxes(bot).find(i => b.harvestTools[i.type] && durLeft(bot, i) > 0)
        // opts.sacrifice (walkTrunk, BOTH trunk lanes shut by such an ore): the shared way to 70 branches is worth more than the drop of one ore
        // block - it is broken with the pick we have (no drop) and the board hears it once. Never for what a poor pick takes minutes to break.
        if (!any && !(opts.sacrifice && !/obsidian|ancient_debris|netherite|reinforced/.test(b.name))) return 'needpick'
        if (!any) sayOnce(bot, 'sacrifice@' + p.x + ',' + p.y + ',' + p.z, 600000, { ev: 'mine_ore_sacrificed', block: b.name, at: [p.x, p.y, p.z], note: 'both trunk lanes were shut by an ore this pick cannot harvest: broken without drop to keep the trunk open' })
        try { await U.withTimeout(bot.equip(any || pk2, 'hand'), 4000, 'equip') } catch { return 'fail' }
      } else if (!bot.heldItem || bot.heldItem.slot !== pk2.slot) {
        try { await U.withTimeout(bot.equip(pk2, 'hand'), 4000, 'equip') } catch { return 'fail' }
      }
    } else {
      try { await U.withTimeout(bot.tool.equipForBlock(b, {}), 4000, 'equipFB') } catch (e_) { swallow('iron_core:q6', e_) }
    }
    let t = (() => { try { return bot.digTime(b) } catch { return 2000 } })()
    // OBSIDIAN: this protocol's block data files obsidian under the material "incorrect_for_wooden_tool", so mineflayer finds no tool speed for it and
    // waits 75 s per block (measured 09-20: 4 obsidian in 4 min); the server wants 188 ticks with a diamond pickaxe (speed 8, hardness 50), 167 with
    // netherite. For this one dig the wait is the real one (+ 0.4 s); a finish the server refuses leaves the block standing -> read back below, next round.
    const held = bot.heldItem && bot.heldItem.name; const realMs = b.name === 'obsidian' && /^(diamond|netherite)_pickaxe$/.test(held || '') ? Math.ceil(1 / ((held[0] === 'n' ? 9 : 8) / 50 / 30)) * 50 + 400 + round * 600 : 0
    const origDigTime = bot.digTime
    if (realMs && t > realMs * 1.5) { t = realMs; bot.digTime = () => realMs }
    try {
      try { await U.withTimeout(bot.dig(b, true), Math.max(4000, t * 2 + 3000), 'dig') } finally { bot.digTime = origDigTime }
      if (realMs) { await sleep(250); const still = bot.blockAt(p); if (still && still.name === 'obsidian') { if (round > 3) return 'fail'; continue } }
      bump(bot, 'dug')
    } catch (e) {
      try { bot.stopDigging() } catch (e_) { swallow('iron_core:q7', e_) }
      if (stale(bot)) return 'fail'
      if (round > 2) return 'fail'
      await sleep(250)
      continue
    }
    // gravity blocks above fall into the hole: wait and re-dig
    const above = bot.blockAt(p.offset(0, 1, 0))
    if (above && GRAVITY.has(above.name)) { await sleep(450); continue }
    await sleep(40)
    const again = bot.blockAt(p)
    if (again && again.boundingBox === 'block' && GRAVITY.has(again.name)) continue
    return 'ok'
  }
  return 'fail'
}

// ------------------------------------------------------------------ raw movement
async function settle (bot, ms = 1200, expectY = null) {
  const end = Date.now() + ms
  await sleep(100)
  while (Date.now() < end && bot.entity) {
    if (bot.entity.onGround && (expectY == null || Math.floor(bot.entity.position.y + 0.01) <= expectY)) break
    await sleep(50)
  }
}
// Walk with raw controls onto the centre of column (x,z). `up` = hold jump.
async function stepTo (bot, x, z, opts = {}) {
  const ms = opts.ms || 3500
  const t0 = Date.now()
  try { bot.pathfinder.setGoal(null) } catch (e_) { swallow('iron_core:q8', e_) }
  let lastD = 99; let lastT = Date.now()
  let ok = false
  while (Date.now() - t0 < ms) {
    if (opts.force ? (!bot.entity || bot.health <= 0) : stale(bot, opts.gen)) break
    const p = bot.entity.position
    const dx = x + 0.5 - p.x; const dz = z + 0.5 - p.z
    const d = Math.hypot(dx, dz)
    if (d < (opts.tol || 0.3)) { ok = true; break }
    const yaw = Math.atan2(-dx, -dz)
    try { await bot.look(yaw, 0, true) } catch (e_) { swallow('iron_core:q9', e_) }
    bot.setControlState('sprint', !!opts.sprint && bot.food > 6) // (the server lets nobody sprint at food <= 6) the caller says where running is safe (walled stairwell, a line whose next two cells were looked at)
    bot.setControlState('forward', true)
    if (d < lastD - 0.05) { lastD = d; lastT = Date.now(); bot.setControlState('jump', !!opts.up) } else if (Date.now() - lastT > 700) {
      bot.setControlState('jump', true) // bumped into a lip / pit edge
    }
    await sleep(50)
  }
  if (!opts.keepMoving || !ok) { try { bot.clearControlStates() } catch (e_) { swallow('iron_core:q10', e_) } }
  return ok
}

// ------------------------------------------------------------------ the stairwell in the WORLD: audit, repair (= dig), walk
// what is wrong with one geometry cell right now? null = fine / not loaded / open air above the pad
function cellFault (bot, c) {
  const b = blk(bot, c.x, c.y, c.z)
  if (!b) return null
  if (isWalk(c)) return isOpen(b) ? null : (isLiquid(b) ? 'liquid' : 'blocked')
  if (c.above) return null
  return isSolid(b) ? null : (isLiquid(b) ? 'liquid' : 'open')
}
// AUDIT of the audit groups `gs` (the rows around the bot - ~16 block reads per step, so it runs on EVERY commute): {bad:[{c,fault}], dark:[c]}
function auditStairs (bot, M, gs) {
  const bad = []; const dark = []
  for (const g of [].concat(gs)) {
    const grp = M.G.groups[g]; if (!grp) continue
    for (const c of grp.cells) {
      const fault = cellFault(bot, c)
      if (fault) bad.push({ c, fault }); else if (c.kind === 'torch') { const b = blk(bot, c.x, c.y, c.z); if (b && !/torch/.test(b.name)) dark.push(c) }
    }
  }
  return { bad, dark }
}
// can a bot stand in / pass through the column of waypoint w? (floor there, feet + head free)
function colOk (bot, w) { const [x, y, z] = w.p; return isSolid(blk(bot, x, y - 1, z)) && isOpen(blk(bot, x, y, z)) && isOpen(blk(bot, x, y + 1, z)) }
async function placeTorch (bot, c) {
  if (U.count(bot, 'torch') <= 0 || !c.wall || eyeDist(bot, c) > 4.5) return false
  const cell = blk(bot, c.x, c.y, c.z); const wall = blk(bot, c.wall[0], c.wall[1], c.wall[2])
  if (!cell || !isOpen(cell) || /torch/.test(cell.name) || !isSolid(wall)) return false
  if (!await U.equip(bot, 'torch', 'hand')) return false
  try { await U.withTimeout(bot.placeBlock(wall, new Vec3(c.x - c.wall[0], 0, c.z - c.wall[2])), 2500, 'stairTorch') } catch (e_) { swallow('iron_core:stairTorch', e_) }
  await sleep(60)
  const nb = blk(bot, c.x, c.y, c.z)
  if (nb && /torch/.test(nb.name)) { bump(bot, 'torches'); return true }
  return false
}
// ---- BRIDGING A CAVE (world 2, 09-19 20:29Z: the stairwell broke into a cave at y36 - both floor cells of step 34 hung over a 2-deep void, no
// neighbour to place against, the digger looped on `stair_broken unrepaired` every 5 s with 59 cobblestone in her pockets).
// A player builds the SUPPORT first: out from the last solid block, each new block the reference of the next - or a pillar from the ground below.
// SUPPORT cell = a column cell directly under a floor (stair floor of the geometry, or the floor of a trunk / branch mouth), at most SUPPORT_MAX
// below it, never walkway. Nothing else is ever placed: geometry floor/wall/ceiling cells + these columns.
const SUPPORT_MAX = 8
function isSupport (M, x, y, z) {
  for (let j = 0; j <= SUPPORT_MAX; j++) {
    const c = M.G.cells.get(ck(x, y + j, z))
    if ((c && isWalk(c)) || walkway(x, y + j, z)) return j > 0 // the cell under the first walkway cell above us IS that floor: we are in its column
    if (c && c.kind === 'floor') return true
  }
  return false
}
// SHELL CORNER: the geometry's floors, walls and ceilings of consecutive steps meet only DIAGONALLY (in rock nobody notices; in an open cave - flight 4,
// y32..y23, 20:41Z - the far-wall/ceiling cells had no face to hang on: 8 groups `stair_broken` for every commuter, the roof open to the cave).
// A cell outside the geometry that touches >= 2 of its solid-to-be cells is the corner of the shell: filling it joins wall to ceiling, never walkway.
function isShellCorner (M, x, y, z) { let n = 0; for (const d of FACES) { const c = M.G.cells.get(ck(x + d[0], y + d[1], z + d[2])); if (c && isRepairable(c) && !c.above) n++ } return n >= 2 }
function mayCarry (M, x, y, z) { const c = M.G.cells.get(ck(x, y, z)); if (c) return isRepairable(c) && !c.above; return !walkway(x, y, z) && (isSupport(M, x, y, z) || isShellCorner(M, x, y, z)) }
// The cheapest list of cells to fill, IN PLACING ORDER, that ends in `target` and starts at a cell with a solid neighbour (length 1 = the ordinary
// repair). Cells: open/liquid, within reach from where the bot stands, geometry floor/wall/ceiling (cost 1: they are wanted anyway) or support
// columns (cost 3). null = no such chain (void deeper than the reach on all sides). `ban` = cells a placement just failed in.
function supportChain (bot, M, target, ban, maxLen = 7) {
  const f = feet(bot)
  const usable = (p) => {
    const k = ck(p.x, p.y, p.z)
    if (ban && ban.has(k)) return false
    const b = bot.blockAt(p); if (!b || isSolid(b)) return false
    if (eyeDist(bot, p) > 4.5) return false
    if (p.x === f.x && p.z === f.z && (p.y === f.y || p.y === f.y + 1)) return false
    return mayCarry(M, p.x, p.y, p.z)
  }
  if (!usable(target)) return null
  const anchored = (p) => FACES.some(d => isSolid(bot.blockAt(p.offset(d[0], d[1], d[2]))))
  const open = [{ p: target, cost: 0, len: 1, prev: null }]; const seen = new Map([[ck(target.x, target.y, target.z), 0]])
  for (let n = 0; open.length && n < 400; n++) {
    open.sort((a, b) => a.cost - b.cost)
    const cur = open.shift()
    if (anchored(cur.p)) { const out = []; for (let q = cur; q; q = q.prev) out.push(q.p); return out } // anchor first ... target last
    if (cur.len >= maxLen) continue
    for (const d of FACES) {
      const p = cur.p.offset(d[0], d[1], d[2]); const k = ck(p.x, p.y, p.z)
      if (!usable(p)) continue
      const cost = cur.cost + (M.G.cells.has(k) ? 1 : 3) + eyeDist(bot, p) * 0.01
      if (seen.has(k) && seen.get(k) <= cost) continue
      seen.set(k, cost); open.push({ p, cost, len: cur.len + 1, prev: cur })
    }
  }
  return null
}
// Put a block INTO `pos` (a floor/wall/ceiling cell or a support cell), building what has to carry it first. -> true | 'no_filler' | 'no_support' | 'place_failed'
async function placeSupported (bot, M, pos, gen) {
  const ban = new Set()
  for (let round = 0; round < 3 && !stale(bot, gen); round++) {
    if (isSolid(bot.blockAt(pos))) return true
    const chain = supportChain(bot, M, pos, ban)
    if (!chain) return round ? 'place_failed' : 'no_support'
    let failed = null
    for (const p of chain) {
      if (!mayCarry(M, p.x, p.y, p.z)) { sayOnce(bot, 'refused', 600000, { ev: 'stair_repair_refused', at: [p.x, p.y, p.z], note: 'not a floor/wall/ceiling/support cell' }); failed = p; break }
      const it = fillItem(bot)
      if (!it) return 'no_filler'
      if (!await placeAt(bot, it, p)) { failed = p; break }
      if (!p.equals(pos)) { bump(bot, 'supports'); say(bot, { ev: 'stair_support', at: [p.x, p.y, p.z], for: [pos.x, pos.y, pos.z], item: it }) }
    }
    if (!failed) return true
    if (failed.equals(pos) && chain.length === 1) return 'place_failed'
    ban.add(ck(failed.x, failed.y, failed.z))
  }
  return isSolid(bot.blockAt(pos)) ? true : 'place_failed'
}
// one report per audit group and `ms` for the whole process: 15 commuters pass the same open cell within a minute
function sayGroup (sig, ms) { const m = global.__ironSaidGroup = global.__ironSaidGroup || {}; if (Date.now() - (m[sig] || 0) < ms) return false; m[sig] = Date.now(); return true }
// MAKE THE WORLD EQUAL TO THE GEOMETRY for audit group g, from where the bot stands. Digging a new row and repairing an old one are this same
// routine. Order: what must be SOLID first (lava/water sources and cave mouths are closed before the walkway beside them is opened), then the
// walkway top-down, then torches; up to 3 passes (gravel that falls, a floor that only finds a neighbour once the wall stands).
// A block is placed ONLY into a floor/wall/ceiling cell of stairCells - asserted here, and placeAt refuses walkway cells a second time.
// -> {ok, fixed, left:[{c,fault}]}; rows already dug report stair_broken -> stair_repaired (left = what is STILL wrong after looking again).
async function repairStairs (bot, M, g, gen, opts = {}) {
  let a = auditStairs(bot, M, g)
  if (!a.bad.length && !a.dark.length) return { ok: true, fixed: 0, left: [] }
  const before = a.bad.length; const holes0 = a.bad.filter(q => !isWalk(q.c)).length
  const known = before > 0 && !opts.undug
  const brief = l => l.slice(0, 6).map(q => q.c.kind + ':' + q.fault + '@' + ck(q.c.x, q.c.y, q.c.z))
  if (known && sayGroup('broken' + g, 600000)) say(bot, { ev: 'stair_broken', group: g, y: M.G.groups[g].y, n: before, cells: brief(a.bad) })
  if (before) try { bot.clearControlStates() } catch (e_) { swallow('iron_core:repairClear', e_) }
  const why = {} // cell -> why the last attempt to fill it failed
  for (let pass = 0; pass < 3 && a.bad.length && !stale(bot, gen); pass++) {
    const KIND = { floor: 0, wall: 1, ceiling: 2 } // the floor carries the walls, the walls carry the ceiling; nearest first (it becomes the next one's reference)
    const solids = a.bad.filter(q => !isWalk(q.c)).sort((p, q2) => (KIND[p.c.kind] - KIND[q2.c.kind]) || (eyeDist(bot, p.c) - eyeDist(bot, q2.c)))
    for (const q of solids) {
      if (eyeDist(bot, q.c) > 4.5) { q.why = 'out_of_reach'; continue }
      if (!isRepairable(M.G.cells.get(ck(q.c.x, q.c.y, q.c.z)))) { sayOnce(bot, 'refused', 600000, { ev: 'stair_repair_refused', at: [q.c.x, q.c.y, q.c.z], note: 'not a floor/wall/ceiling cell of stairCells' }); continue }
      const it = fillItem(bot)
      if (!it) { sayOnce(bot, 'no_filler', 600000, { ev: 'stair_no_filler', group: g, note: 'a stair repair needs cobblestone in the pockets' }); break }
      const r = await placeSupported(bot, M, new Vec3(q.c.x, q.c.y, q.c.z), gen)
      if (r !== true) why[ck(q.c.x, q.c.y, q.c.z)] = r
    }
    for (const q of a.bad.filter(q => isWalk(q.c)).sort((p, q2) => q2.c.y - p.c.y)) {
      if (eyeDist(bot, q.c) > 4.8) continue
      if ((blk(bot, q.c.x, q.c.y, q.c.z) || {}).name === 'crafting_table') { await takeTable(bot, new Vec3(q.c.x, q.c.y, q.c.z)); continue } // a miner's table left in the walkway
      const r = await digCell(bot, new Vec3(q.c.x, q.c.y, q.c.z), { hand: !opts.undug, sacrifice: true }) // the stairwell has no second lane: an ore in it that our pick cannot harvest is broken anyway
      if (r === 'notool' || r === 'needpick') { bot.__ironStairFail = { why: r, at: [q.c.x, q.c.y, q.c.z], t: Date.now() }; break }
    }
    a = auditStairs(bot, M, g)
  }
  for (const c of a.dark) await placeTorch(bot, c)
  const fixed = before - a.bad.length
  const closed = holes0 - a.bad.filter(q => !isWalk(q.c)).length // floor/wall/ceiling cells that were open (a cave, a liquid) and are solid now - looked at, not assumed
  if (known && fixed > 0) say(bot, { ev: 'stair_repaired', group: g, y: M.G.groups[g].y, fixed, left: a.bad.length, verified: true, still: brief(a.bad) })
  else if (opts.undug && closed > 0) say(bot, { ev: 'stair_repaired', group: g, y: M.G.groups[g].y, fixed: closed, left: a.bad.length, verified: true, cave: true, still: brief(a.bad) }) // a NEW row that met a cave
  if (fixed > 0) bump(bot, opts.undug ? 'stairCells' : 'stairRepairs', fixed)
  for (const q of a.bad) q.why = !isWalk(q.c) ? (eyeDist(bot, q.c) > 4.5 ? 'out_of_reach' : (why[ck(q.c.x, q.c.y, q.c.z)] || (fillItem(bot) ? 'place_failed' : 'no_filler'))) : 'dig_failed'
  return { ok: !a.bad.length, fixed, left: a.bad }
}

// ---- TREADS IN THE WORLD (geometry: stairCells `treads`). Laid by whoever CLIMBS with stair blocks in the pockets, from the step below, looking UP the flight (a stair
// block takes its `facing` from the placer's yaw: the look is sent first, two ticks pass, then the click without another look - the chest lesson of 04:19Z).
// One cell at a time: dig the floor block (its support below must be solid, nobody else within 3 blocks), lay the tread, LOOK at the result; a tread that did not
// come out right is taken back and the floor block returns - a hole is never left. A full block is always walkable (jump), so a half-converted flight works.
const STAIR_RE = /^(cobblestone|mossy_cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|tuff|blackstone|stone_brick|deepslate_brick|deepslate_tile|polished_[a-z_]+|tuff_brick)_stairs$/
const FACE_NAME = ['east', 'south', 'west', 'north'] // DIRS order
const running = () => { try { return !!army().larderFull() } catch (e_) { swallow('iron_core:running', e_); return false } }
function stairItem (bot) { return bot.inventory.items().find(i => STAIR_RE.test(i.name)) || null }
function propsOf (b) { try { return (b && b.getProperties && b.getProperties()) || {} } catch (e_) { swallow('iron_core:props', e_); return {} } }
// null = not a tread cell · 'ok' = a stair block ascending the right way · 'full' = a solid block (walkable with a jump, convertible) · 'wrong' · 'open'
function treadState (bot, M, x, y, z) {
  const t = M && M.G.treads && M.G.treads.get(ck(x, y, z)); if (!t) return null
  const b = blk(bot, x, y, z); if (!b) return 'full'
  if (/_stairs$/.test(b.name)) { const q = propsOf(b); return q.facing === FACE_NAME[t.dir] && q.half === 'bottom' ? 'ok' : 'wrong' }
  return isSolid(b) ? 'full' : 'open'
}
async function placeTread (bot, pos, dir) {
  // reference: the block below (top face), else a solid block beside the cell (its face towards the cell, lower half) - over a hollow the other lane's floor is always there
  const it = stairItem(bot); let ref = blk(bot, pos.x, pos.y - 1, pos.z); let face = new Vec3(0, 1, 0)
  if (!isSolid(ref)) { ref = null; for (const d of DIRS) { const q = blk(bot, pos.x - d[0], pos.y, pos.z - d[1]); if (isSolid(q) && eyeDist(bot, q.position) <= 4.6) { ref = q; face = new Vec3(d[0], 0, d[1]); break } } }
  if (!it || !ref) return false
  try { await U.withTimeout(bot.equip(it, 'hand'), 4000, 'equipTread') } catch (e_) { swallow('iron_core:treadEquip', e_); return false }
  const d = DIRS[dir]; const e = eye(bot)
  const pitch = Math.atan2(pos.y - e.y, Math.hypot(pos.x + 0.5 - e.x, pos.z + 0.5 - e.z))
  try { await bot.look(Math.atan2(-d[0], -d[1]), pitch, true) } catch (e_) { swallow('iron_core:treadLook', e_) }
  await sleep(200)
  try { await U.withTimeout(bot._placeBlockWithOptions(ref, face, { forceLook: 'ignore', half: 'bottom', swingArm: 'right' }), 2500, 'tread') } catch (e_) { swallow('iron_core:treadPlace', e_) } // judged on the block, not on the promise
  await sleep(120)
  return true
}
// lay the tread row under waypoint `w` (the next step UP) from where the bot stands -> number of treads laid
async function layTreads (bot, M, w, gen) {
  const t = M.G.treads && M.G.treads.get(ck(w.p[0], w.p[1] - 1, w.p[2])); if (!t) return 0
  let laid = 0
  for (const c of t.row) {
    if (stale(bot, gen) || !stairItem(bot) || !bestPick(bot) || threat(bot, 8)) break
    if (treadState(bot, M, c[0], c[1], c[2]) !== 'full') continue
    const pos = new Vec3(c[0], c[1], c[2]); const b = bot.blockAt(pos)
    if (!b || U.protectedBlock(b) || GRAVITY.has(b.name) || eyeDist(bot, { x: c[0], y: c[1], z: c[2] }) > 4.2) continue // (an ore in the floor is mined like any other: digCell leaves it when the pick cannot harvest it)
    if (!isSolid(blk(bot, c[0], c[1] - 1, c[2])) && !DIRS.some(d => isSolid(blk(bot, c[0] - d[0], c[1], c[2] - d[1])))) continue // over a hollow (32 of 106 floors of the y16 way hang over galleries) the tread hangs on its neighbour like the block did; with no neighbour at all it stays
    if (FACES.some(d => isLiquid(blk(bot, c[0] + d[0], c[1] + d[1], c[2] + d[2])))) continue
    const mid = new Vec3(c[0] + 0.5, c[1] + 1, c[2] + 0.5)
    if (Object.values(bot.entities).some(e => e !== bot.entity && e.type === 'player' && e.position && e.position.distanceTo(mid) < 3)) continue // never under a comrade's feet
    const f = feet(bot)
    try { bot.clearControlStates() } catch (e_) { swallow('iron_core:treadClear', e_) }
    await stepTo(bot, f.x, f.z, { ms: 1500, gen, tol: 0.12 }) // square on our own step: a body that overlaps the cell makes the server refuse the block
    await settle(bot, 400)
    { const dr = await digCell(bot, pos, { breach: true }); if (dr !== 'ok') { sayOnce(bot, 'tread_nodig' + c.join(','), 600000, { ev: 'tread_failed', at: c, state: 'dig:' + dr, block: b.name }); continue } }
    await placeTread(bot, pos, t.dir)
    let st = treadState(bot, M, c[0], c[1], c[2])
    if (st === 'wrong') { await digCell(bot, pos, { breach: true }); await placeTread(bot, pos, t.dir); st = treadState(bot, M, c[0], c[1], c[2]) }
    if (st === 'ok') { laid++; continue }
    if (st === 'wrong') await digCell(bot, pos, { breach: true })
    if (!isSolid(bot.blockAt(pos))) { const it = fillItem(bot); if (it) await placeAt(bot, it, pos) } // the floor returns: never a hole
    sayOnce(bot, 'tread_failed' + c.join(','), 600000, { ev: 'tread_failed', at: c, state: st, below: (blk(bot, c[0], c[1] - 1, c[2]) || {}).name, held: bot.heldItem && bot.heldItem.name, from: [+bot.entity.position.x.toFixed(2), +bot.entity.position.y.toFixed(2), +bot.entity.position.z.toFixed(2)] })
    break
  }
  if (laid) bump(bot, 'treads', laid)
  return laid
}

const UNREPAIRED = global.__ironUnrepaired = global.__ironUnrepaired || {} // audit group -> time of the last `stair_broken unrepaired` report of this PROCESS (the module is re-required per bot run)
function nearestWp (bot, wps, r = 2.5) {
  const me = bot.entity.position
  let best = -1; let bd = r
  for (let i = 0; i < wps.length; i++) {
    const p = wps[i].p
    const d = Math.hypot(me.x - (p[0] + 0.5), me.z - (p[2] + 0.5)) + Math.abs(me.y - p[1]) * 1.5
    if (d < bd) { bd = d; best = i }
  }
  return best
}
// Walk a stair route (routeDown / routeUp / planUp) waypoint by waypoint with raw controls. Before EVERY move the group of the next waypoint is
// audited and repaired (see repairStairs) - a broken cell is fixed before anything else, by whoever gets there first. No pathfinder: world 1's
// "last resort" pathfinder hop dug and placed in the stairwell. opts.dig = this bot holds the stair lease and may open rows beyond `dug`.
// false -> bot.__ironStairFail = {why: off_route | undug | stair_broken | step | budget | notool | needpick, at, g}
async function walkRoute (bot, M, wps, gen, opts = {}) {
  let i = nearestWp(bot, wps, opts.near || 2.5)
  const fail = (why, extra) => { try { bot.clearControlStates() } catch (e_) { swallow('iron_core:routeClear', e_) } const p = feet(bot); bot.__ironStairFail = Object.assign({ why, at: [p.x, p.y, p.z], t: Date.now() }, extra || {}); return false }
  if (i < 0) return fail('off_route')
  bot.__ironStairFail = null
  const endT = Date.now() + (opts.maxMs || 120000 + (wps.length - i) * 4000)
  let fails = 0; let dug = M.st.dug
  let treadRows = opts.treads === false ? 0 : (opts.treadRows || 8); let laidAll = 0; let fullSeen = 0 // at most 8 rows per climb: a commute, not a building site
  const run = running()
  while (i < wps.length - 1) {
    await sleep(5)
    if (stale(bot, gen)) { bot.clearControlStates(); return false }
    if (Date.now() > endT) return fail('budget')
    if (threat(bot, 6)) { bot.clearControlStates(); await defend(bot, gen); continue }
    const w = wps[i + 1]
    const undug = w.g > dug
    if (undug && !opts.dig && auditStairs(bot, M, w.g).bad.some(q => isWalk(q.c))) return fail('undug', { g: w.g })
    if (opts.dig) {
      await eat(bot)
      if (U.freeSlots(bot) <= 1) await tossJunk(bot, true)
      if (undug && !bestPick(bot) && !await ensurePick(bot, 1)) return fail('notool')
    }
    const rep = await repairStairs(bot, M, w.g, gen, { undug })
    if (bot.__ironStairFail && opts.dig) return false // notool / needpick from the dig
    if (!colOk(bot, w)) {
      if (++fails < 3) { await sleep(400); continue }
      const left = rep.left.slice(0, 6).map(q => q.c.kind + ':' + q.fault + '@' + ck(q.c.x, q.c.y, q.c.z) + (q.why ? '(' + q.why + ')' : ''))
      const reason = !fillItem(bot) ? 'no_filler' : ((rep.left.find(q => !isWalk(q.c) && q.why) || rep.left[0] || {}).why || 'column_blocked')
      if (Date.now() - (UNREPAIRED[w.g] || 0) >= 300000) { // ONE report per group and 5 min (20:29Z: 39 identical lines in 3 min from one digger)
        UNREPAIRED[w.g] = Date.now()
        say(bot, { ev: 'stair_broken', group: w.g, next: w.p, unrepaired: true, reason, left, filler: fillItem(bot) || 'none', pick: (bestPick(bot) || {}).name || 'none' })
        try { army().askHelp(bot, 'stair_broken', 'mine stair column ' + w.p.join(',') + ' cannot be made passable (' + reason + ')', { at: w.p, left }) } catch (e_) { swallow('iron_core:stairHelp', e_) }
      }
      return fail('stair_broken', { g: w.g, next: w.p, reason })
    }
    const rise = w.p[1] > wps[i].p[1]
    const trow = rise ? ((M.G.treads && M.G.treads.get(ck(w.p[0], w.p[1] - 1, w.p[2]))) || {}).row || [] : [] // BOTH lanes of the row: the climber's own lane alone left every down-lane block of a finished up lane standing
    const rowFull = () => trow.some(c => treadState(bot, M, c[0], c[1], c[2]) === 'full')
    if (rise && !undug && treadRows > 0 && stairItem(bot) && rowFull()) { const n = await layTreads(bot, M, w, gen); if (n) { treadRows--; laidAll += n } }
    const tread = rise ? treadState(bot, M, w.p[0], w.p[1] - 1, w.p[2]) : null
    if (rise && rowFull()) fullSeen++
    const up = rise && tread !== 'ok' // a tread is WALKED up (0.5 rises); only a full block is jumped
    const ok = await stepTo(bot, w.p[0], w.p[2], { up, ms: 3000, gen, keepMoving: true, tol: 0.35, sprint: run && !undug && !opts.dig })
    if (ok && Math.abs(bot.entity.position.y - w.p[1]) < 1.3) {
      i++; fails = 0
      // the digger's progress: every group BEHIND the one we stand in is complete as far as hands could reach
      if (opts.dig && w.g - 1 > dug) { dug = w.g - 1; bot.clearControlStates(); await update(M.E, d => { d.dug = Math.max(d.dug, dug); d.stairLease = { owner: bot.username, t: Date.now() } }); if (dug % 5 === 0) { await sweep(bot, 600, 2.5); hb(bot, { phase: 'stairs', depth: w.p[1], stats: bot.__ironStats }) } }
      continue
    }
    bot.clearControlStates()
    await settle(bot, 800)
    const j = nearestWp(bot, wps, 2.5)
    if (j >= 0 && j !== i) { i = j; continue }
    if (j < 0) return fail('off_route')
    if (++fails >= 4) return fail('step', { g: w.g, next: w.p })
  }
  bot.clearControlStates()
  await settle(bot)
  if (laidAll) say(bot, { ev: 'treads_laid', n: laidAll, left: fullSeen, y: Math.floor(bot.entity.position.y) })
  if ((laidAll || fullSeen || ((M.st.treadsLeftBy || {})[String(wps[0].p[1])] !== 0)) && wps.length > 8 && wps[wps.length - 1].p[1] > wps[0].p[1]) { try { await update(M.E, d => { d.treadsLeft = fullSeen; d.treadsLeftBy = Object.assign({}, d.treadsLeftBy, { [String(wps[0].p[1])]: fullSeen }); d.treadsT = Date.now() }) } catch (e_) { swallow('iron_core:treadsLeft', e_) } } // a CLIMB from a level's hub counted the blocks that are still jumped on THAT level's way (treadsLeftBy[hub y]): the depot visit draws stair blocks while there are any
  if (opts.dig) { // the last group (a hub: both rows + the door) is finished from its last waypoint
    const g = wps[wps.length - 1].g
    const rep = await repairStairs(bot, M, g, gen, { undug: g > dug })
    if (g > dug && colOk(bot, wps[wps.length - 1])) await update(M.E, d => { d.dug = Math.max(d.dug, g); d.stairLease = null; if (rep.left.length) d.defects = rep.left.slice(0, 12).map(q => [q.c.x, q.c.y, q.c.z, q.fault]) })
  }
  return true
}

// One line in results.jsonl when the mine cannot do what it is trying to do (rate-limited: one per bot, reason and 5 min) - so "standing on the level"
// has a REASON on the board long before the army's 3-minute hang watchdog fires.
function blocked (bot, why, extra) {
  const m = bot.__ironBlockedT = bot.__ironBlockedT || {}
  if (Date.now() - (m[why] || 0) < 300000) return
  m[why] = Date.now()
  try {
    const ARMY = require('./army'); const p = feet(bot)
    ARMY.result(bot, Object.assign({ ev: 'mine_blocked', job: bot.__armyJob || null, task: String((bot.state && bot.state.task) || '').slice(0, 40), why, at: [p.x, p.y, p.z] }, extra || {}))
  } catch (e_) { swallow('iron_core:blocked', e_) }
}

// Pillar up ONE block in place (jump, filler under the feet). This is how a miner gets back onto the level of a line out of a crater or trench;
// the block stays where it is - it IS the missing floor. 'ok' | 'no_filler' | 'headroom' | 'no_floor' | 'equip' | 'fail'
async function pillarOne (bot, gen) {
  const f = feet(bot)
  let it = fillItem(bot)
  if (!it) { // empty pockets: take one block out of the side wall at feet height (below the line's floor, invisible once the floor is back)
    for (const d of DIRS) {
      const b = blk(bot, f.x + d[0], f.y, f.z + d[1])
      if (!isSolid(b) || U.protectedBlock(b) || ORE_RE.test(b.name)) continue
      if (await digCell(bot, b.position) === 'ok') { await sweep(bot, 1500, 2); break }
    }
    it = fillItem(bot)
    if (!it) return 'no_filler'
  }
  const head = blk(bot, f.x, f.y + 2, f.z)
  if (isLiquid(head)) return 'headroom'
  if (isSolid(head)) { const r = await digCell(bot, head.position); if (r !== 'ok' && r !== 'air') return 'headroom' }
  const ref = blk(bot, f.x, f.y - 1, f.z)
  if (!isSolid(ref)) return 'no_floor'
  await stepTo(bot, f.x, f.z, { ms: 1200, gen, tol: 0.22 })
  if (!await U.equip(bot, it, 'hand')) return 'equip'
  bot.setControlState('jump', true)
  const t0 = Date.now()
  while (Date.now() - t0 < 900 && bot.entity.position.y < f.y + 1.0) await sleep(20)
  try { await U.withTimeout(bot.placeBlock(ref, new Vec3(0, 1, 0)), 1500, 'pillar') } catch (e_) { swallow('iron_core:q11', e_) }
  bot.setControlState('jump', false)
  await settle(bot, 900)
  if (feet(bot).y > f.y) { bump(bot, 'pillared'); return 'ok' }
  return 'fail'
}

// Is there a torch in the line cells within `r` cells before/behind (x,z)? (The client's light values are not reliable: torch cells read 0.)
function torchAlong (bot, x, y, z, d, r = 6) {
  for (let i = -r; i <= r; i++) for (const dy of [0, 1]) { const b = blk(bot, x + d[0] * i, y + dy, z + d[1] * i); if (b && /torch/.test(b.name)) return true }
  return false
}

// LAVA / FIRE ON THE LINE AHEAD. walkLine only ever asked "is the next cell SOLID?" - lava is not, so a miner walking `to-face` into a gallery that
// lava had run into after it was opened stepped straight in: 09-20 04:42-05:35Z, level -32 branch 67:1 @108, 11 deaths in a row (2 Madoka, 9 Shiori:
// respawn -> "resume my own branch" -> the same face, every 3 min, a whole kit each time). Now every step LOOKS 2 cells ahead at feet, head and
// the cell above: what is hot is plugged from where we stand (2 cells away, nearest first) and the plugs in the line are then opened by digCell with
// its full liquid protocol (every lava face beside the cell is shut BEFORE it is opened) = the repair pass. A budget of plugs per walk; past it, or
// without filler: a 2-high wall in front of us, 3 cells back, `lava` (the caller puts the branch on record as a hazard). Never a step into it.
const HOT_BUDGET = 16
function isHot (b) { return !!b && (b.name === 'lava' || b.name === 'fire' || b.name === 'soul_fire') }
function hotAhead (bot, f, step, Y, n = 2) {
  const out = []; const ys = [...new Set([Y, Y + 1, Y + 2, f.y, f.y + 1])]
  for (let i = 1; i <= n; i++) for (const yy of ys) { const b = blk(bot, f.x + step[0] * i, yy, f.z + step[1] * i); if (isHot(b)) out.push(b.position) }
  return out
}
// -> 'clear' | 'plugged' (look again, then carry on) | 'lava' (not made safe: walled off as far as we could, stepped back)
async function clearHot (bot, f, step, Y, st, gen) {
  let hot = hotAhead(bot, f, step, Y)
  if (!hot.length) return 'clear'
  try { bot.clearControlStates() } catch (e_) { swallow('iron_core:hotStop', e_) }
  if (!st.at) st.at = [hot[0].x, hot[0].y, hot[0].z]
  st.kind = hot.some(p => (bot.blockAt(p) || {}).name === 'lava') ? 'lava' : 'fire'
  for (const q of hot) if ((bot.blockAt(q) || {}).name === 'lava') noteLava(bot, q)
  // a BODY of lava, not a trickle into our gallery (a column hot from feet to over the head, or lava on BOTH sides of a line cell): no tunnelling into a lake
  const body = [1, 2].some(i => { const x = f.x + step[0] * i; const z = f.z + step[1] * i; return [Y, Y + 1, Y + 2].every(yy => isHot(blk(bot, x, yy, z))) || [Y, Y + 1].some(yy => isHot(blk(bot, x - step[1], yy, z + step[0])) && isHot(blk(bot, x + step[1], yy, z - step[0]))) })
  let ok = (st.plugs || 0) < HOT_BUDGET && !!fillItem(bot) && !body
  if (ok) for (const q of hot) { if (!isHot(bot.blockAt(q))) continue; st.plugs = (st.plugs || 0) + 1; if (!await plug(bot, q, { temp: true })) { ok = false; break } }
  if (ok) { await sleep(150); hot = hotAhead(bot, f, step, Y); if (!hot.length) return 'plugged' }
  // not safe from here: shut the line in front of us (feet + head), and away from it
  for (const dy of [0, 1]) { const w = new Vec3(f.x + step[0], Y + dy, f.z + step[1]); if (!isSolid(bot.blockAt(w))) await plug(bot, w, { temp: true }) }
  st.walled = [0, 1].every(dy => isSolid(blk(bot, f.x + step[0], Y + dy, f.z + step[1])))
  for (let i = 1; i <= 3 && !stale(bot, gen); i++) {
    const bx = f.x - step[0] * i; const bz = f.z - step[1] * i
    if (![0, 1].every(dy => { const b = blk(bot, bx, f.y + dy, bz); return isOpen(b) && !isHot(b) }) || !isSolid(blk(bot, bx, f.y - 1, bz))) break
    if (!await stepTo(bot, bx, bz, { ms: 2000, gen, tol: 0.35 })) break
  }
  return 'lava'
}

// Walk a straight 1x2 line (trunk / branch / level gallery) to column (x,z) ON LEVEL `opts.y` (default: where we stand now).
// THE LINE KEEPS ITS LEVEL. The old version dug "the next cell at MY feet": a miner standing one block low in a creeper crater dug the trunk's FLOOR
// out in front of itself, and so did everybody after it - on 09-19 that turned the y-54 trunk into a trench at y-56 from z-72 to z-205; the branch
// mouths were 2 blocks up, nobody could leave it, 20 `hung` events in 90 min (task "iron:descend", note "lost underground").
// Now: only cells y/y+1 of the line are ever dug, a missing floor is put back, and a bot below the level climbs (step up, else pillar = refills the hole).
// opts.light: torch the line as we pass (no torch within 6 cells) · opts.space: keep 5 blocks behind the miner in front (one creeper, one victim)
// opts.wide [dx,dz]: also open the cell beside the line (the TRUNK is 2 wide: out on the right lane, home on the other - whoever walks digs both)
// opts.breach: a reconnect gallery may enter the stairwell through its wall · opts.hand: punch when there is no pickaxe
// A failure says why in bot.__ironLineFail + a `mine_blocked` event: budget | no_progress (60 s without getting closer) | off_level | no_filler | climb_* | blocked
async function walkLine (bot, x, z, gen, ms = 60000, opts = {}) {
  const t0 = Date.now()
  let fails = 0
  const f0 = feet(bot)
  const Y = opts.y != null ? opts.y : f0.y
  const budget = Math.max(ms, 30000 + (Math.abs(x - f0.x) + Math.abs(z - f0.z)) * 1500)
  let paused = 0 // time NOT spent walking (a fight, a convoy hold): the budget is for the ROUTE, not for what happens on it (11:0xZ, see defend())
  let best = 1e9; let progT = Date.now(); let held = 0; let lastTorchAt = null
  const hotSt = { plugs: 0 }; const runLine = running()
  const quit = (why, extra) => {
    try { bot.clearControlStates() } catch (e_) { swallow('iron_core:q12', e_) }
    const p = feet(bot)
    bot.__ironLineFail = Object.assign({ why, at: [p.x, p.y, p.z], to: [x, Y, z], t: Date.now() }, extra || {})
    blocked(bot, why, Object.assign({ to: [x, Y, z] }, extra || {}))
    return false
  }
  bot.__ironLineFail = null
  while (true) {
    await sleep(5)
    if (stale(bot, gen)) { bot.clearControlStates(); return false }
    if (Date.now() - t0 - paused > budget) return quit('budget', { paused: Math.round(paused / 1000) })
    const f = feet(bot)
    if (f.y > Y + 2 || f.y < Y - 3) return quit('off_level') // fell into a cave / respawned: this is no longer the line we were walking
    const dist = Math.abs(x - f.x) + Math.abs(z - f.z) + Math.abs(Y - f.y)
    if (dist === 0) break
    if (dist < best) { best = dist; progT = Date.now() } else if (Date.now() - progT > 60000) return quit('no_progress')
    // a walking miner is not blind: 12:39Z one creeper took a convoy of 5 that never looked up from the trunk
    if (threat(bot, 6)) { bot.clearControlStates(); const tp = Date.now(); await defend(bot, gen); paused += Date.now() - tp; progT = Date.now(); continue }
    const dx = Math.sign(x - f.x); const dz = Math.sign(z - f.z)
    let nx = f.x; let nz = f.z
    const tryX = dx !== 0 && (Math.abs(x - f.x) >= Math.abs(z - f.z) || dz === 0)
    if (tryX) nx += dx; else nz += dz
    const atCol = dx === 0 && dz === 0
    // BELOW THE LINE: one block low with the floor ahead intact -> step up onto it; else pillar up right here
    const stepUp = f.y === Y - 1 && !atCol && isSolid(blk(bot, nx, f.y, nz))
    if (f.y < Y && !stepUp) {
      bot.clearControlStates()
      // NOBODY CAN PILLAR IN A SHARED CELL (the server refuses a block where another player stands; bots walk through each other, so a convoy
      // ends up in ONE cell of the hole: 8 miners, 8x climb_fail at -39,-56,-132). First name keeps the cell, the others move one cell on along the hole.
      const me = bot.entity.position
      const mates = Object.values(bot.entities).filter(e => e !== bot.entity && e.type === 'player' && e.position && Math.abs(e.position.y - me.y) < 1.6 && Math.max(Math.abs(e.position.x - me.x), Math.abs(e.position.z - me.z)) < 0.95)
      if (mates.length) {
        if (mates.some(e => String(e.username) < String(bot.username))) {
          const open2 = (cx, cz) => isOpen(blk(bot, cx, f.y, cz)) && isOpen(blk(bot, cx, f.y + 1, cz)) && isSolid(blk(bot, cx, f.y - 1, cz))
          const fwd = atCol ? null : [nx, nz]; const back = atCol ? null : [f.x - (nx - f.x), f.z - (nz - f.z)]
          const to = [fwd, back].find(c => c && open2(c[0], c[1]))
          if (to) await stepTo(bot, to[0], to[1], { ms: 2000, gen, tol: 0.3 }); else await sleep(700)
        } else await sleep(400 + Math.floor(Math.random() * 300)) // my cell: wait until the others have left it
        continue
      }
      const r = await pillarOne(bot, gen)
      if (r !== 'ok') { fails += 2; if (fails > 5) return quit(r === 'no_filler' ? r : 'climb_' + r); await sleep(300) }
      continue
    }
    if (atCol) { // over the target column but above its level (somebody's wall block, a filled step): land, else take the block under us out
      await settle(bot, 600)
      const under = blk(bot, f.x, f.y - 1, f.z)
      if (feet(bot).y === f.y && f.y - 1 >= Y && isSolid(under) && !U.protectedBlock(under)) { const r = await digCell(bot, under.position, { hand: opts.hand, breach: opts.breach }); if (r !== 'ok' && r !== 'air' && ++fails > 5) return quit('blocked') }
      continue
    }
    const step = [nx - f.x, nz - f.z]
    // LOOK before the step: lava / fire within 2 cells on the line is plugged from here (then opened by digCell's protocol) - or we turn round
    { const hz = await clearHot(bot, f, step, Y, hotSt, gen); if (hz === 'lava') return quit('lava', { hot: hotSt.at, kind: hotSt.kind, plugs: hotSt.plugs, walled: !!hotSt.walled }); if (hz === 'plugged') { progT = Date.now(); continue } }
    // SPACING on the way out: hold while another miner is within 5 blocks IN FRONT of us on the line (15 s at most per walk, so a miner that
    // stands there for a reason never blocks the trunk)
    if (opts.space && held < 15000) {
      const me = bot.entity.position
      const close = Object.values(bot.entities).some(e => {
        if (e === bot.entity || e.type !== 'player' || !e.position || Math.abs(e.position.y - me.y) > 2.5) return false
        const ax = (e.position.x - me.x) * step[0] + (e.position.z - me.z) * step[1]
        const lat = Math.abs((e.position.x - me.x) * step[1]) + Math.abs((e.position.z - me.z) * step[0])
        return ax > 0.6 && ax < 5 && lat < 1.2
      })
      if (close) { bot.clearControlStates(); await sleep(500); held += 500; paused += 500; progT += 500; continue }
    }
    // LIGHT the line as we pass
    if (opts.light && f.y === Y && U.count(bot, 'torch') > 0 && !(lastTorchAt && lastTorchAt[0] === f.x && lastTorchAt[1] === f.z) && !torchAlong(bot, f.x, Y, f.z, step)) {
      lastTorchAt = [f.x, f.z]
      bot.clearControlStates()
      const di = DIRS.findIndex(q => q[0] === step[0] && q[1] === step[1])
      if (di >= 0) await torchNear(bot, f.x, Y, f.z, di).catch(e_ => swallow('iron_core:lineTorch', e_))
    }
    // open the next cell of the line: ONLY the line's own two cells (plus our headroom while we are above/below it) - never its floor
    const cells = [[nx, Y + 1, nz], [nx, Y, nz]]
    if (f.y > Y) cells.unshift([nx, f.y + 1, nz])
    if (stepUp) cells.unshift([f.x, f.y + 2, f.z])
    let worked = false // this step needed hands (dig / floor / torch): no running into it
    for (const c of [[f.x, f.y, f.z], [f.x, f.y + 1, f.z]].concat(cells)) { const b = blk(bot, c[0], c[1], c[2]); if (isWeb(b)) { worked = true; bot.clearControlStates(); await digCell(bot, b.position, { hand: true, soft: true }) } } // a web holds a walker for 20 s per cell: cut it (ours and the next)
    for (const c of cells) {
      const b = blk(bot, c[0], c[1], c[2])
      if (isSolid(b) && !U.protectedBlock(b)) { worked = true; bot.clearControlStates(); const r = await digCell(bot, b.position, { hand: opts.hand, breach: opts.breach, sacrifice: opts.sacrifice }); if (r === 'needpick') return quit('needpick'); if (r !== 'ok' && r !== 'air') { fails += 2 } }
    }
    let fl = blk(bot, nx, Y - 1, nz)
    // a fence / wall as the floor (1.5 high: no way over it under a 2-high line), a rail / web lying in the floor cell: out with it, the floor goes in below
    if ((tallBlock(fl) || clutter(fl)) && !(CUR && stairSolid(nx, Y - 1, nz))) { worked = true; bot.clearControlStates(); await digCell(bot, fl.position, { hand: true, soft: true }); fl = blk(bot, nx, Y - 1, nz); if (tallBlock(fl)) { fails += 2; if (fails > 5) return quit('blocked', { floor: fl.name }); continue } }
    if (!isSolid(fl)) {
      bot.clearControlStates()
      const M = CUR; const fp = new Vec3(nx, Y - 1, nz)
      // the floor ahead normally finds the floor under our feet as its reference; over a cave it gets its support first (placeSupported)
      const r = !fillItem(bot) ? 'no_filler' : (M && mayCarry(M, nx, Y - 1, nz) ? await placeSupported(bot, M, fp, gen) : ((await placeAt(bot, fillItem(bot), fp)) || 'place_failed'))
      // a 1-deep dip is walked through (step up on the far side); a VOID is not stepped into: world 1's miners fell into caves off the trunk
      if (r !== true && (isHot(blk(bot, nx, Y - 1, nz)) || (f.y === Y && !isSolid(blk(bot, nx, Y - 2, nz))))) { fails += 2; if (fails > 5) return quit(r === 'no_filler' ? 'no_filler' : 'no_floor'); await sleep(400); continue }
    }
    if (opts.wide && f.y === Y) { // the second lane: best effort (an ore our pick cannot take stays a pillar in the trunk - the other lane passes it)
      const wx = nx + opts.wide[0]; const wz = nz + opts.wide[1]
      for (const yy of [Y + 1, Y]) { const b = blk(bot, wx, yy, wz); if ((isSolid(b) && !U.protectedBlock(b)) || isWeb(b)) { bot.clearControlStates(); await digCell(bot, b.position, { hand: opts.hand, soft: true }) } }
      { const wf = blk(bot, wx, Y - 1, wz); if ((tallBlock(wf) || clutter(wf)) && fillItem(bot)) { bot.clearControlStates(); await digCell(bot, wf.position, { hand: true, soft: true }) } } // whoever walks OUT makes the HOME lane's floor too
      if (!isSolid(blk(bot, wx, Y - 1, wz)) && fillItem(bot)) { bot.clearControlStates(); const M = CUR; const wp = new Vec3(wx, Y - 1, wz); if (M && mayCarry(M, wx, Y - 1, wz)) await placeSupported(bot, M, wp, gen); else await placeAt(bot, fillItem(bot), wp) }
    }
    // RUN where the line is FINISHED (owner 09-20 "走る"; a miner walks up to 243 blocks of trunk + 256 of branch each way): on the line's level, nothing to do in this
    // cell, and the cell AFTER it looked at too - floor solid, both cells open, nothing hot (a runner needs ~0.5 block to stop: the look-ahead is the brake)
    const ax = nx + step[0]; const az = nz + step[1]
    const runOk = !worked && !stepUp && f.y === Y && isSolid(fl) && runLine && isSolid(blk(bot, ax, Y - 1, az)) && isOpen(blk(bot, ax, Y, az)) && isOpen(blk(bot, ax, Y + 1, az)) && !isHot(blk(bot, ax, Y - 1, az)) && !isHot(blk(bot, ax, Y, az))
    const ok = await stepTo(bot, nx, nz, { ms: 2500, gen, keepMoving: true, tol: 0.4, up: stepUp, sprint: runOk })
    if (!ok) { if (++fails > 5) return quit('blocked') } else fails = Math.max(0, fails - 1)
  }
  bot.clearControlStates()
  bot.__ironLinePlugs = hotSt.plugs ? { n: hotSt.plugs, at: hotSt.at, kind: hotSt.kind, t: Date.now() } : null // a walk that mended lava on its way says so (gotoBranchFace)
  return true
}

// pick up drops near us with raw controls (only onto cells that are safe to stand in)
async function sweep (bot, ms = 1500, radius = 3) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (stale(bot) || U.freeSlots(bot) <= 0) return
    const me = bot.entity.position
    const items = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position &&
      e.position.distanceTo(me) < radius && Math.abs(e.position.y - me.y) < 1.2)
    if (!items.length) return
    items.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    const it = items[0]
    if (it.position.distanceTo(me) < 0.9) { await sleep(150); continue }
    const c = it.position.floored()
    const fy = Math.floor(me.y + 0.01)
    if (!isOpen(blk(bot, c.x, fy, c.z)) || !isOpen(blk(bot, c.x, fy + 1, c.z)) || !isSolid(blk(bot, c.x, fy - 1, c.z))) { await sleep(200); if (Date.now() + 300 > end) return; continue }
    await stepTo(bot, c.x, c.z, { ms: Math.min(1500, end - Date.now()), tol: 0.45 })
  }
}

// ------------------------------------------------------------------ ore (no x-ray)
function oreFamily (name) { const m = ORE_RE.exec(name); return m ? m[2] : null }
function exposedOre (bot, cells) {
  const out = []
  const seen = new Set()
  for (const c of cells) {
    for (const d of FACES) {
      const b = blk(bot, c[0] + d[0], c[1] + d[1], c[2] + d[2])
      if (!b || !ORE_RE.test(b.name)) continue
      const k = U.kpos(b.position)
      if (!seen.has(k)) { seen.add(k); out.push(b) }
    }
  }
  return out
}
function veinOf (bot, first, max = 24) {
  const fam = oreFamily(first.name)
  const seen = new Set([U.kpos(first.position)])
  const out = [first.position]
  const q = [first.position]
  while (q.length && out.length < max) {
    const p = q.shift()
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue
      const n = p.offset(dx, dy, dz)
      const k = U.kpos(n)
      if (seen.has(k)) continue
      seen.add(k)
      const b = bot.blockAt(n)
      if (b && oreFamily(b.name) === fam) { out.push(n); q.push(n) }
    }
  }
  return out
}

// Mine a whole exposed vein. `level` = corridor feet y, `anchor` = cell to return to.
// Excursions are 1x2 side tunnels at corridor level (never straight up / down).
async function mineVein (bot, first, level, anchor, gen, opts = {}) {
  const fam = oreFamily(first.name)
  const pk = bestPick(bot)
  if (!pk || !first.harvestTools || !first.harvestTools[pk.type]) {
    if (fam === 'diamond' || fam === 'gold' || fam === 'redstone' || fam === 'emerald') recordOre(bot, first)
    return 0
  }
  let todo = veinOf(bot, first)
  let got = 0
  let moves = 0
  const maxMoves = opts.maxMoves == null ? 8 : opts.maxMoves
  const trail = []
  for (let guard = 0; guard < 60 && todo.length; guard++) {
    await sleep(10)
    if (stale(bot, gen)) break
    const f = feet(bot)
    todo = todo.filter(p => { const b = bot.blockAt(p); return b && oreFamily(b.name) === fam })
    if (!todo.length) break
    todo.sort((a, b) => eyeDist(bot, a) - eyeDist(bot, b))
    // diggable from here: in reach, not straight above our column, not the block under our feet
    const pick = todo.find(p => eyeDist(bot, p) <= 4.4 && !(p.x === f.x && p.z === f.z))
    if (pick) {
      const r = await digCell(bot, pick)
      if (r === 'ok') { got++; bump(bot, 'ore_' + fam) } else { todo = todo.filter(p => p !== pick) }
      continue
    }
    // own column (above head / below feet): step back onto the trail/anchor and retry from there
    const own = todo.find(p => p.x === f.x && p.z === f.z && eyeDist(bot, p) <= 4.4)
    if (own && (trail.length || anchor)) {
      const back = trail.length ? trail[trail.length - 1] : anchor
      if (back && (back.x !== f.x || back.z !== f.z) && Math.abs(back.x - f.x) + Math.abs(back.z - f.z) === 1) {
        await stepTo(bot, back.x, back.z, { ms: 2000, gen })
        if (trail.length) trail.pop()
        continue
      }
      // anchor IS this column: open the next cell toward any other direction? give up on this block
      todo = todo.filter(p => p !== own)
      continue
    }
    // out of reach: tunnel one cell toward the nearest remaining ore at corridor level
    if (moves >= maxMoves) break
    const t = todo[0]
    const ddx = t.x - f.x; const ddz = t.z - f.z
    let sx = 0; let sz = 0
    if (Math.abs(ddx) >= Math.abs(ddz)) sx = Math.sign(ddx); else sz = Math.sign(ddz)
    if (!sx && !sz) { todo.shift(); continue }
    const nx = f.x + sx; const nz = f.z + sz
    const r = await openCell(bot, nx, level, nz)
    if (r !== 'ok') { todo.shift(); continue }
    trail.push(f)
    if (!await stepTo(bot, nx, nz, { ms: 2500, gen })) { trail.pop(); todo.shift(); continue }
    moves++
  }
  await sweep(bot, 900, 3.5)
  // Ore dug from a distance leaves its drop inside the wall cavity (that lost ~80% of the first veins):
  // carve a 1x2 side tunnel at corridor level to every valuable drop and walk onto it.
  await collectDrops(bot, level, trail, gen, fam)
  // walk the trail back to the anchor
  while (trail.length) {
    const p = trail.pop()
    if (stale(bot, gen)) break
    await stepTo(bot, p.x, p.z, { ms: 2500, gen })
    await sweep(bot, 500, 2)
  }
  if (anchor) {
    const f = feet(bot)
    if (f.x !== anchor.x || f.z !== anchor.z || f.y !== anchor.y) await returnTo(bot, anchor, gen)
  }
  return got
}
const VALUABLE_RE = /^(raw_iron|raw_gold|raw_copper|coal|diamond|emerald|lapis_lazuli|redstone|flint)$/
function dropName (e) {
  try { const it = e.getDroppedItem && e.getDroppedItem(); if (it) return it.name } catch (e_) { swallow('iron_core:q13', e_) }
  return null
}
async function collectDrops (bot, level, trail, gen, fam) {
  const given = new Set()
  let moves = 0
  for (let guard = 0; guard < 40 && moves < 14; guard++) {
    await sleep(10)
    if (stale(bot, gen) || U.freeSlots(bot) <= 0) return
    const me = bot.entity.position
    const items = Object.values(bot.entities).filter(e => {
      if (!e || e.name !== 'item' || !e.position || given.has(e.id)) return false
      const dx = e.position.x - me.x; const dz = e.position.z - me.z
      if (Math.hypot(dx, dz) > 5.5) return false
      const dy = e.position.y - level
      if (dy < -1.6 || dy > 3.2) return false
      const n = dropName(e)
      return n == null || VALUABLE_RE.test(n)
    })
    if (!items.length) return
    items.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    const it = items[0]
    const c = it.position.floored()
    const f = feet(bot)
    if (c.x === f.x && c.z === f.z) { await sleep(350); given.add(it.id); continue }
    const ddx = c.x - f.x; const ddz = c.z - f.z
    if (Math.abs(ddx) + Math.abs(ddz) === 1 && Math.abs(it.position.y - me.y) < 0.6 && it.position.distanceTo(me) < 1.25) { await sleep(300); given.add(it.id); continue }
    let sx = 0; let sz = 0
    if (Math.abs(ddx) >= Math.abs(ddz)) sx = Math.sign(ddx); else sz = Math.sign(ddz)
    const nx = f.x + sx; const nz = f.z + sz
    const r = await openCell(bot, nx, level, nz)
    if (r !== 'ok') { given.add(it.id); continue }
    // ore that came into view while carving belongs to the same job
    for (const o of exposedOre(bot, [[nx, level, nz], [nx, level + 1, nz]])) {
      if (eyeDist(bot, o.position) <= 4.4 && !(o.position.x === f.x && o.position.z === f.z) && oreFamily(o.name)) {
        const pk = bestPick(bot)
        if (pk && o.harvestTools && o.harvestTools[pk.type]) { if (await digCell(bot, o.position) === 'ok') bump(bot, 'ore_' + oreFamily(o.name)) }
      }
    }
    trail.push(f)
    if (!await stepTo(bot, nx, nz, { ms: 2500, gen })) { trail.pop(); given.add(it.id); continue }
    moves++
    await sleep(120)
  }
}
function recordOre (bot, b) {
  try {
    const f = path.join(DIR, 'iron_ore_log.json')
    let l = []
    try { l = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') swallow('iron_core:oreLogRead', e) }
    const k = U.kpos(b.position)
    if (l.some(e => e.k === k)) return
    l.push({ k, name: b.name, t: Date.now(), by: bot.username })
    fs.writeFileSync(f + '.tmp', JSON.stringify(l.slice(-500)))
    fs.renameSync(f + '.tmp', f)
  } catch (e_) { swallow('iron_core:oreLog', e_) }
}
// back to the anchor cell of our own line after a vein excursion: a LEVEL 1x2 line (walkLine keeps the level, floors gaps, climbs out of a hole).
// World 1 used the pathfinder here as a fallback - underground it digs and places, which is how private diagonals appeared beside the branches.
async function returnTo (bot, anchor, gen) {
  const f = feet(bot)
  if (f.x === anchor.x && f.z === anchor.z && f.y === anchor.y) return true
  if (Math.abs(f.x - anchor.x) + Math.abs(f.z - anchor.z) <= 1 && Math.abs(f.y - anchor.y) <= 1) {
    if (await stepTo(bot, anchor.x, anchor.z, { ms: 2500, gen, up: f.y < anchor.y }) && feet(bot).y === anchor.y) return true
  }
  return walkLine(bot, anchor.x, anchor.z, gen, 30000, { y: anchor.y })
}

// Open a 1x2 standing cell at (x, y..y+1, z) with a solid floor. 'ok' | 'liquid' | 'fail' | 'cave'
async function openCell (bot, x, y, z, opts = {}) {
  for (const dy of [1, 0]) {
    const r = await digCell(bot, new Vec3(x, y + dy, z))
    if (r === 'liquid') return 'liquid'
    if (r !== 'ok' && r !== 'air') return (r === 'notool' || r === 'needpick') ? r : 'fail'
  }
  // lava anywhere around the new cell that we could not see before? (diagonals / floor)
  const fl = blk(bot, x, y - 1, z)
  if (!isSolid(fl)) {
    const it = fillItem(bot)
    if (!it || !await placeAt(bot, it, new Vec3(x, y - 1, z))) return isLiquid(fl) ? 'liquid' : 'fail'
  }
  const up = blk(bot, x, y + 2, z)
  if (isLiquid(up)) { if (!await plug(bot, up.position)) return 'liquid' }
  return 'ok'
}

// seal side openings (caves) of a freshly opened column so the tunnel stays a closed, lit tube
async function sealSides (bot, x, ys, z, dirIdx) {
  const d = DIRS[dirIdx]
  const sides = [[-d[1], d[0]], [d[1], -d[0]]]
  let n = 0
  for (const y of ys) {
    for (const s of sides) {
      const b = blk(bot, x + s[0], y, z + s[1])
      if (b && (isOpen(b) && !/torch/.test(b.name)) && n < 4) { const it = fillItem(bot); if (it && await placeAt(bot, it, b.position)) n++ }
    }
  }
  const top = blk(bot, x, ys[0] + 1, z)
  if (top && isOpen(top) && !/torch/.test(top.name)) { const it = fillItem(bot); if (it) await placeAt(bot, it, top.position) }
  return n
}

async function torchNear (bot, x, y, z, dirIdx) {
  if (U.count(bot, 'torch') <= 0) return false
  const d = DIRS[dirIdx]
  // wall torch at head height on either side wall, else on the floor
  for (const s of [[-d[1], d[0]], [d[1], -d[0]]]) {
    const wall = blk(bot, x + s[0], y + 1, z + s[1])
    const cell = blk(bot, x, y + 1, z)
    if (isSolid(wall) && cell && (cell.name === 'air' || cell.name === 'cave_air')) {
      if (!await U.equip(bot, 'torch', 'hand')) return false
      try { await U.withTimeout(bot.placeBlock(wall, new Vec3(-s[0], 0, -s[1])), 2500, 'torch') } catch (e_) { swallow('iron_core:q14', e_) }
      await sleep(60)
      const nb = blk(bot, x, y + 1, z)
      if (nb && /torch/.test(nb.name)) { bump(bot, 'torches'); return true }
    }
  }
  return false
}

// ------------------------------------------------------------------ mobs
function los (bot, target) {
  const a = eye(bot); const b = target
  const d = b.minus(a); const len = d.norm()
  const n = Math.ceil(len / 0.5)
  for (let i = 1; i < n; i++) {
    const p = a.plus(d.scaled(i / n))
    const bl = bot.blockAt(p)
    if (bl && bl.boundingBox === 'block') return false
  }
  return true
}
function threat (bot, r = 7) {
  const me = bot.entity.position
  const skip = bot.__ironNoMob || null // mobs defend() could neither reach nor drive off (a cave pocket above the gallery): see defend()
  let best = null; let bd = r
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !HOSTILE.has(e.name)) continue
    const d = e.position.distanceTo(me)
    if (d >= bd || Math.abs(e.position.y - me.y) > 3) continue
    if (skip && skip[e.id] > Date.now() && d > 3.5) continue // ignored for 2 min - but the moment it is really in reach it is a fight again
    if (!los(bot, e.position.offset(0, 1.2, 0)) && !los(bot, e.position.offset(0, 0.3, 0))) continue
    best = e; bd = d
  }
  return best
}
async function wallOff (bot, mob) {
  const f = feet(bot)
  const dx = mob.position.x - bot.entity.position.x; const dz = mob.position.z - bot.entity.position.z
  let sx = 0; let sz = 0
  if (Math.abs(dx) >= Math.abs(dz)) sx = Math.sign(dx) || 1; else sz = Math.sign(dz) || 1
  let n = 0
  for (const dy of [0, 1]) {
    const it = fillItem(bot)
    if (it && await placeAt(bot, it, f.offset(sx, dy, sz))) n++
  }
  if (n) bump(bot, 'walls')
  return n === 2 || (isSolid(bot.blockAt(f.offset(sx, 0, sz))) && isSolid(bot.blockAt(f.offset(sx, 1, sz))))
}
// returns true if it had to deal with something
async function defend (bot, gen) {
  let mob = threat(bot)
  if (!mob) return false
  bot.clearControlStates()
  try { bot.stopDigging() } catch (e_) { swallow('iron_core:q15', e_) }
  const weak = bot.health < 9
  const dist = () => mob.position.distanceTo(bot.entity.position)
  if ((mob.name === 'creeper' && dist() > 3) || weak || ((mob.name === 'skeleton' || mob.name === 'stray' || mob.name === 'bogged') && dist() > 4)) {
    if (await wallOff(bot, mob)) { U.note(bot, 'info', 'walled off ' + mob.name); await sleep(400); return true }
  }
  const w = ['diamond_sword', 'iron_sword', 'stone_sword', 'stone_axe', 'wooden_sword'].find(n => U.has(bot, n)) || (bestPick(bot) || {}).name
  if (w) await U.equip(bot, w, 'hand')
  const cd = /sword/.test(w || '') ? 650 : 1000
  let t0 = Date.now(); const end = t0 + 25000
  let last = 0; let near = dist()
  while (Date.now() < end && !stale(bot, gen)) {
    if (!mob.isValid || !bot.entities[mob.id]) { mob = threat(bot); if (!mob) break; t0 = Date.now(); near = dist() } // a fresh target gets its own 3 s to come into reach
    if (bot.health < 7 && fillItem(bot)) { if (await wallOff(bot, mob)) break }
    const d = dist()
    if (d > 9) break
    near = Math.min(near, d)
    // A MOB WE CAN NEITHER REACH NOR DRIVE OFF (11:0xZ: a zombie in a cave pocket 3 blocks above the y32 branch - d 5.4, dy 3.0, line of sight through the
    // gap - held FIVE miners: every walkLine iteration called defend, defend stared at it for its full 25 s, and `mine_blocked budget` x8 killed every
    // recall at -374,32,-601). It never came within reach in 3 s: leave it alone for 2 minutes and walk on - a miner that cannot fight must not stand.
    if (Date.now() - t0 > 3000 && near > 3.5) {
      const m = bot.__ironNoMob = bot.__ironNoMob || {}; const now = Date.now()
      for (const k of Object.keys(m)) if (m[k] < now) delete m[k]
      m[mob.id] = now + 120000
      sayOnce(bot, 'mob_far', 600000, { ev: 'mine_mob_ignored', kind: mob.name, at: [Math.round(mob.position.x), Math.round(mob.position.y), Math.round(mob.position.z)], d: Math.round(near * 10) / 10, note: 'the mob neither came into reach nor could be hit (a cave pocket beside/above the gallery): ignored for 2 min so the walk goes on' })
      break
    }
    try { await bot.lookAt(mob.position.offset(0, (mob.height || 1.6) * 0.8, 0), true) } catch (e_) { swallow('iron_core:q16', e_) }
    if (d <= 3.3 && Date.now() - last >= cd) { try { bot.attack(mob) } catch (e_) { swallow('iron_core:q17', e_) } last = Date.now(); bump(bot, 'hits') }
    await sleep(60)
  }
  await sleep(150)
  return true
}

async function eat (bot) {
  if (bot.food == null || bot.food >= 15) return false
  if (bot.food > 8 && bot.health >= 18) return false
  const foods = bot.inventory.items().filter(i => bot.registry.foodsByName[i.name] && !/spider_eye|poisonous|pufferfish|chorus/.test(i.name) &&
    (i.name !== 'rotten_flesh' || bot.food <= 4))
  if (!foods.length) return false
  foods.sort((a, b) => (bot.registry.foodsByName[b.name].foodPoints || 0) - (bot.registry.foodsByName[a.name].foodPoints || 0))
  try {
    await U.withTimeout(bot.equip(foods[0], 'hand'), 4000, 'eqFood')
    await U.withTimeout(bot.consume(), 6000, 'eat')
    return true
  } catch { return false }
}

// THE MINE IS THE ARMY'S QUARRY while the depot is short of cobblestone (settings.targets.cobblestone; world 2, 09-19: stock 1 / target 1728, 23 builders
// `build_blocked: no cobblestone` - world 1's rule "more than 3 stacks of cobble is dead weight" was written with 24k banked). While short: cobblestone and
// cobbled deepslate are no junk, nothing of them is tossed, and a pack full of them is a HAUL (needHaul) - the miner carries it up and banks it.
// ENOUGH IS ENOUGH (foreman 09-20 02:26Z: stock 20729 against a target of 1728 - miners hauled 1280 cobbled deepslate 90 blocks home and the bank threw
// it on the base): wanted only while the army holds less than 2x the target (stock.js group `cobblestone` = cobblestone + cobbled deepslate, depot +
// pockets). Not wanted -> the decision is taken AT THE FACE: stone beyond the repair kit is dropped in the branch, never carried up, never a haul.
function stoneWanted () {
  try {
    const A = army(); const t = ((A.settings().targets || {}).cobblestone) || 0
    if (!(t > 0)) return false
    let have = null; try { have = require('../../army/stock.js').have('cobblestone') } catch (e_) { swallow('iron_core:stoneHave', e_) }
    if (!Number.isFinite(have)) have = A.stockOf('cobblestone') + A.stockOf('cobbled_deepslate')
    return have < 2 * t
  } catch (e_) { swallow('iron_core:stoneWanted', e_); return false }
}
// toss junk stone when the pack fills up underground (cobble itself is kept: plugs + builders want it)
// `dir` [dx,dz] = throw THAT way (a stack flies 2-3 blocks the way we look: thrown at the face it lay in the next cells to be dug and was picked up
// again at once; thrown towards the way out it comes home in the pockets after all) - the face while leaving, the mouth while digging on
async function tossJunk (bot, force, dir) {
  if (!force && U.freeSlots(bot) > 3) return 0
  if (dir && (dir[0] || dir[1])) { try { await bot.look(Math.atan2(-dir[0], -dir[1]), 0, true) } catch (e_) { swallow('iron_core:tossLook', e_) } }
  let n = 0
  const want = stoneWanted()
  const kept = {} // THE REPAIR KIT stays: the biggest stack of cobblestone and of cobbled deepslate (stair repairs, lava plugs, dams need a block in hand)
  for (const it of bot.inventory.items().slice().sort((a, b) => b.count - a.count)) {
    const stone = it.name === 'cobblestone' || it.name === 'cobbled_deepslate'
    if (!stone && !JUNK_RE.test(it.name)) continue
    if (stone && (want || !kept[it.name])) { kept[it.name] = true; continue }
    try { await U.withTimeout(bot.tossStack(it), 3000, 'toss'); n++ } catch (e_) { swallow('iron_core:q18', e_) }
  }
  return n
}

// ------------------------------------------------------------------ digging the stairwell (one bot at a time holds the lease)
async function claimStairs (bot, M) {
  return update(M.E, d => {
    if (d.dug >= M.lv.g) return false
    const l = d.stairLease
    if (l && l.owner !== bot.username && Date.now() - l.t < 90000) return false
    d.stairLease = { owner: bot.username, t: Date.now() }
    return true
  })
}
// Dig/continue the stairwell down to M.level: walk the down route with opts.dig - every row that is not there yet is "repaired" into existence.
// 'done' | 'paused' (time slice over) | 'blocked' | 'notool'. The bot must stand at the mouth or anywhere on the dug part of the route.
async function digStairs (bot, M, gen, opts = {}) {
  const route = routeDown(M.G, M.level)
  // LOOK at the mouth before the first block is touched: a wrong y in settings.mineHead would start the stairwell in mid-air or inside the pad
  if (M.st.dug < 0) {
    const m = route[0].p; const under = blk(bot, m[0], m[1] - 1, m[2])
    if (under && !isSolid(under)) { sayOnce(bot, 'bad_entrance', 300000, { ev: 'mine_bad_entrance', entrance: [M.E.x, M.E.y, M.E.z], found: under.name, note: 'entrance.y must be the FEET y on solid ground (armyctl.js ground); level the mine-head pad first' }); return 'blocked' }
  }
  refresh(M)
  const ok = await walkRoute(bot, M, route, gen, { dig: true, maxMs: opts.maxMs || 240000, near: 4 })
  if (refresh(M).dug >= M.lv.g) { say(bot, { ev: 'stairs_done', level: M.level, hub: M.lv.hub, steps: route.length, defects: (M.st.defects || []).length }); return 'done' }
  const why = (bot.__ironStairFail || {}).why
  if (why === 'notool' || why === 'needpick') return 'notool'
  if (ok || why === 'budget' || !why) return 'paused'
  blocked(bot, 'stairs_' + why, bot.__ironStairFail)
  return 'blocked'
}

// ------------------------------------------------------------------ branches (ledger per level: cache.lv[<y>].branches, one owner per branch by file claim)
// The level is finite: K_MAX trunk positions x 2 sides. When every branch is done the mine GROWS by itself: branches that simply reached their
// length are re-opened 32 blocks longer (up to 128) - world 1 went silent instead, 12 miners napping at the stairhead. After that: a new level.
function branchLen (M) { return (lvState(M.st, M.level).branchLen) || BRANCH_LEN }
async function claimBranch (bot, M) {
  const bp = bestPick(bot); const rank = bp ? pickRank(bp.name) : 0
  // branches this bot could not reach a moment ago (iron_miner sets bot.__ironSkip[key] = until): not again for a while, else "resume my own branch" loops on it
  const skip = (key) => { const u = bot.__ironSkip && bot.__ironSkip[M.level + '/' + key]; return !!u && u > Date.now() }
  return update(M.E, d => {
    const L = lvState(d, M.level)
    const now = Date.now()
    const tryClaim = () => {
      // resume our own unfinished branch first
      for (const [key, b] of Object.entries(L.branches)) if (b.owner === bot.username && !b.done && !b.hazard && !((b.need || 0) > rank) && !skip(key)) { b.t = now; return Object.assign({ key }, b) }
      for (let k = 0; k < Math.min(K_MAX, L.kStop != null ? L.kStop : K_MAX); k++) { // nearest the hub first
        for (const side of [1, -1]) {
          const key = k + ':' + side
          const b = L.branches[key]
          if (b && b.done) continue
          if (skip(key)) continue
          if (b && (b.need || 0) > rank) continue // its face is an ore this bot's pick cannot harvest (redstone/gold/diamond want iron): left for a better pick
          if (b && b.owner && b.owner !== bot.username && now - b.t < CLAIM_MS) continue
          if (b && b.hazard) {
            // A HAZARD ON RECORD (a miner burned / died there): nobody MINES it. One bot at a time may take it as a REPAIR: never one that was hurt there,
            // only with filler in hand; its walk plugs what it meets from 2 cells away (walkLine/clearHot). Two tries, then the branch is closed for good.
            if ((b.hazardBy || []).includes(bot.username) || cobbleCount(bot) < 16) continue
            if ((b.repairs || 0) >= 2) { b.done = true; b.why = b.hazard; b.owner = null; continue }
            Object.assign(b, { owner: bot.username, t: now, repairBy: bot.username, repairs: (b.repairs || 0) + 1 })
            return Object.assign({ key, repair: true }, b)
          }
          L.branches[key] = { owner: bot.username, t: now, k, side, len: (b && b.len) || 0, done: false, ore: (b && b.ore) || 0 }
          if (b && b.need) L.branches[key].need = b.need
          return Object.assign({ key }, L.branches[key])
        }
      }
      return null
    }
    let got = tryClaim()
    while (!got && (L.branchLen || BRANCH_LEN) < MAX_BRANCH) { // nothing left for THIS bot: grow the level by 32 and re-open the branches that merely reached their length
      L.branchLen = (L.branchLen || BRANCH_LEN) + 32
      for (const b of Object.values(L.branches)) if (b.done && !b.why && (b.len || 0) < L.branchLen) { b.done = false; b.owner = null; b.t = 0 }
      got = tryClaim()
    }
    return got
  })
}
// What is there to do on this level for a pick of `rank`? (sync, from the cache as last read) -> {free, needPick, busy}: free = branches such a bot
// could claim NOW (incl. the level's growth), needPick = open ones that wait for a better pick. iron_miner asks BEFORE it fetches a kit: 09-19 50 bots
// in turn drew pick + sticks + table + cobble, walked to the mine head, found no branch and banked it all again (615 `mine_not_ready` in an hour).
function branchOutlook (bot, M, rank, level = M.level) {
  const L = lvState(M.st, level); const now = Date.now(); const o = { free: 0, needPick: 0, busy: 0 }
  const skip = (key) => { const u = bot.__ironSkip && bot.__ironSkip[level + '/' + key]; return !!u && u > now }
  const grows = (L.branchLen || BRANCH_LEN) < MAX_BRANCH
  for (let k = 0; k < Math.min(K_MAX, L.kStop != null ? L.kStop : K_MAX); k++) {
    for (const side of [1, -1]) {
      const key = k + ':' + side; const b = L.branches[key]
      if (b && b.done) { if (grows && !b.why && (b.len || 0) < MAX_BRANCH) o.free++; continue }
      if (b && (b.need || 0) > rank) { o.needPick++; continue }
      if (skip(key) || (b && b.hazard)) continue // a hazard branch is a repair, not work to go down for
      if (b && b.owner && b.owner !== bot.username && now - b.t < CLAIM_MS) { o.busy++; continue }
      o.free++
    }
  }
  return o
}
async function saveBranch (M, key, patch) { return update(M.E, d => { const b = lvState(d, M.level).branches[key]; if (b) Object.assign(b, patch, { t: Date.now() }) }) }
// EXHAUSTED: the level is at ITS limit - every mouth of the trunk taken (kStop/K_MAX), every branch at MAX_BRANCH, none open. Neither a claim nor the
// level's own growth (claimBranch) can do anything here any more. ONE definition, used by iron_miner's growth guard and by `armyctl.js mine`.
function levelCap (L) { return 2 * Math.min(K_MAX, L && L.kStop != null ? L.kStop : K_MAX) }
function exhausted (L) { const bs = Object.values((L && L.branches) || {}); return bs.length >= levelCap(L) && ((L && L.branchLen) || BRANCH_LEN) >= MAX_BRANCH && !bs.some(b => !b.done) }
// mean COMMUTE of the open branches: blocks from the hub to their working ends. The operator must see "6 open branches, 220 blocks out" before he staffs a
// level (09-20 09:25Z: 11 miners walked to the far ends of y0 - 256-long branches, 0 m/5 min - because the board only showed "open 6").
function commute (L) { const o = Object.values((L && L.branches) || {}).filter(b => !b.done && Number.isFinite(b.k)); return o.length ? Math.round(o.reduce((n, b) => n + branchOff(b.k) + (b.len || 0), 0) / o.length) : null }
// ---- AND THE MINE OPENS THE NEXT LANDING BY ITSELF (docs/BUGS.md 09-20 09:5xZ: y16/0/-16 all stood at the cap of 2x80 branches x 256; the fallback then
// sent 11 miners 220 blocks out to the last 6 branches of y0 - "0 m / 5 min, 4 stuck" - or down to iron-poor y-32, and only an operator's `mine level 32`
// helped). nextLanding = the nearest UNUSED landing to `near` inside lo..hi (multiples of LANDING_EVERY) that this stairwell accepts WITHOUT moving a row
// that is already dug - the same pure check mine() refuses a level with, so a candidate from here is never `mine_level_refused`. null = nothing to open.
function nextLanding (M, lo, hi, near = LEVEL_Y) {
  const st = M.st; const have = new Set((st.levels || []).map(Number)); const cand = []
  for (let y = Math.ceil(lo / LANDING_EVERY) * LANDING_EVERY; y <= hi; y += LANDING_EVERY) if (!have.has(y)) cand.push(y)
  cand.sort((a, b) => (Math.abs(a - near) - Math.abs(b - near)) || (b - a)) // nearest the iron band first, the shallower one on a tie (shorter commute, warmer rock)
  for (const y of cand) {
    try {
      const levels = [...have]
      if (!levels.length || !(st.dug >= 0)) { stairCells(M.E, y, { levels }); return y }
      const deepest = Math.min(...levels)
      const oldG = stairCells(M.E, deepest, { levels }); const newG = stairCells(M.E, Math.min(y, deepest), { levels: levels.concat([y]) })
      let same = true
      for (let g = 0; g <= Math.min(st.dug, oldG.groups.length - 1); g++) if (!newG.groups[g] || rowSig(newG.groups[g]) !== rowSig(oldG.groups[g])) { same = false; break }
      if (same) return y // a landing that is already dug gains nothing but its hub door (rowSig ignores door rows): the commuters' own audit opens it
    } catch (e_) { swallow('iron_core:nextLanding', e_) }
  }
  return null
}
// ONE new level per hour for the whole squad, whoever asks first (the stamp lives in the mine's cache, under its lock): eleven miners find the band worked
// out in the same second, and a landing opened every minute is flapping, not growth. -> true = this bot may open `y` now.
async function claimGrowth (E, y, ms = 3600000) { return update(E, d => { if (Date.now() - (d.grewT || 0) < ms) return false; d.grewT = Date.now(); d.grewY = y; return true }) }

// A BRANCH THAT HURTS goes on record and off the market. rec: {kind:'lava'|'fire', at:[x,y,z], died?, close?, len?}. The claim is released, this bot does
// not get the branch again (hazardBy + an hour's skip), claimBranch hands it out only as a repair; `close` (the walk could not make it safe and walled
// it off) or the death of its repairer ends the branch for good (done, why = kind). ONE `mine_hazard` for the squad per branch (said under the lock).
async function markHazard (bot, E, level, key, rec) {
  try {
    (bot.__ironSkip = bot.__ironSkip || {})[level + '/' + key] = Date.now() + 3600000
    const first = await update(E, d => {
      const L = lvState(d, level); let b = L.branches[key]
      if (!b) { const q = key.split(':').map(Number); b = L.branches[key] = { owner: null, t: 0, k: q[0], side: q[1], len: 0, done: false, ore: 0 } }
      const was = !!b.hazard
      b.hazard = rec.kind || 'lava'; b.hazardAt = rec.at || b.hazardAt || null; b.hazardT = Date.now()
      b.hazardBy = [...new Set((b.hazardBy || []).concat([bot.username]))]
      if (rec.died) b.deaths = (b.deaths || 0) + 1
      if (rec.len != null && rec.len < (b.len || 0)) b.len = Math.max(0, rec.len)
      if (rec.close || (rec.died && b.repairBy === bot.username) || (b.deaths || 0) >= 3) { b.done = true; b.why = b.hazard; if (rec.walled != null) b.sealed = !!rec.walled }
      if (b.owner === bot.username || rec.close) { b.owner = null; b.t = 0 }
      return !was || (rec.close && !b.saidClosed && (b.saidClosed = true))
    })
    if (first === true) say(bot, { ev: 'mine_hazard', level, branch: key, at: rec.at || null, kind: rec.kind || 'lava', died: !!rec.died, closed: !!rec.close, note: 'the claim is released and nobody mines this branch; one miner with filler (never ' + bot.username + ') may take it as a repair: lava is plugged from 2 cells away, else the branch is walled off and closed' })
    return true
  } catch (e_) { swallow('iron_core:markHazard', e_); return false }
}
// which branch is position p on / right beside (a vein excursion, a drop pushed us one cell off)? -> {level, key} | null
function branchAt (G, p) {
  for (const [dx, dz] of [[0, 0]].concat(DIRS)) { const l = locate(G, { x: p.x + dx, y: p.y, z: p.z + dz }); if (l && l.part === 'branch') return { level: l.level, key: l.k + ':' + l.side, len: l.len } }
  return null
}

// the trunk is walked KEEP RIGHT: away from the hub on lane R (1), towards it on lane L (0); the walker opens the other lane beside it as it goes
// A trunk cell this bot's picks cannot HARVEST (redstone/gold/diamond ore under a stone pick) stays a pillar in its lane - and must not shut the trunk:
// 09-19 23:03Z two deepslate_redstone_ore in lane R at offset 23 of level -54 stopped every stone-pick miner (`needpick`); each of them then marked
// the branch it was heading for `need:3`, 66 untouched branches in a row, and the whole army bounced off `no_branch` for an hour. So the walker LOOKS
// along its lane first: ore in the keep-right lane -> the other lane for this walk; ore in both -> the block is sacrificed (digCell opts.sacrifice).
function hardCell (bot, x, y, z) { const b = blk(bot, x, y, z); return isSolid(b) && !!b.harvestTools && !U.protectedBlock(b) && !pickaxes(bot).some(i => b.harvestTools[i.type] && durLeft(bot, i) > 0) }
function laneHard (bot, hub, from, to, lane) { // first offset after `from` up to `to` whose two cells hold such a block (null = none in what is loaded)
  if (!pickaxes(bot).length) return null // no pick at all (opts.hand walks): every stone is "hard", the scan says nothing
  for (let o = from; o !== to;) { o += Math.sign(to - o); const c = trunkCell(hub, o, lane); if (hardCell(bot, c.x, hub.y, c.z) || hardCell(bot, c.x, hub.y + 1, c.z)) return o }
  return null
}
async function walkTrunk (bot, M, hub, toOff, gen, opts = {}) {
  const q0 = relTo(hub, feet(bot).x, feet(bot).z)
  const pref = toOff > q0.along ? 1 : toOff < q0.along ? 0 : (q0.across === 1 ? 1 : 0)
  let last = null; let hotLane = null
  for (let round = 0; round < 3; round++) {
    const q = relTo(hub, feet(bot).x, feet(bot).z)
    const from = Math.max(0, q.along)
    let lane = pref; let sacrifice = false
    if (hotLane != null) lane = 1 - hotLane
    else if (laneHard(bot, hub, from, toOff, pref) != null) { if (laneHard(bot, hub, from, toOff, 1 - pref) == null) lane = 1 - pref; else sacrifice = true }
    if (last === lane) sacrifice = true // the second look chose the same lane that just said `needpick` (ore in the lane change itself): open it
    last = lane
    const r = DIRS[(hub.dir + 1) % 4]; const wide = hotLane != null ? null : (lane ? [-r[0], -r[1]] : [r[0], r[1]]) // beside a lava wall the other lane stays SHUT
    let ok = true
    if (q.across !== lane) { const c = trunkCell(hub, from, lane); ok = await walkLine(bot, c.x, c.z, gen, 30000, { y: hub.y, hand: opts.hand, sacrifice }) }
    if (ok) { const t = trunkCell(hub, toOff, lane); ok = await walkLine(bot, t.x, t.z, gen, opts.ms || 90000, { y: hub.y, light: true, space: !!opts.space, wide, hand: opts.hand, sacrifice }) }
    if (ok) return true
    // `needpick` although the scan saw nothing (the far end was not loaded yet, the ore sits in the lane change): look again from where we stand now
    if (stale(bot, gen)) return false
    // LAVA in this lane (clearHot walled it off and stepped back): the trunk is 2 wide - the other lane is the way on, and above all the way HOME
    if ((bot.__ironLineFail || {}).why === 'lava' && hotLane == null) { hotLane = lane; last = null; continue }
    if ((bot.__ironLineFail || {}).why !== 'needpick' || sacrifice) return false
  }
  return false
}
// From anywhere ON THE GRAPH: get to the working face of branch `br`. Each leg has its own TRUE task label: iron:descend (stairs, audited) ->
// iron:trunk <key> (lit, spaced, 2 wide) -> iron:to-face <key>. Off the graph / on another level -> false with __ironLineFail.why = 'off_line'
// (the caller goes up through toSurface and comes down again properly). A bot up to 3 blocks under a line still counts as on it: walkLine climbs back.
async function gotoBranchFace (bot, M, br, gen) {
  const hub = M.lv.hub
  const f = feet(bot)
  const loc = locate(M.G, f)
  bot.__ironLineFail = null
  if (!loc || (loc.part !== 'stair' && loc.level !== M.level)) { bot.__ironLineFail = { why: 'off_line', at: [f.x, f.y, f.z], t: Date.now() }; return false }
  const inOwn = loc.part === 'branch' && loc.k === br.k && loc.side === br.side && loc.len <= Math.max(1, br.len)
  if (!inOwn) {
    if (loc.part === 'stair') {
      bot.state.task = 'iron:descend'
      // in the stairwell but not on the way DOWN to this level (the board changed the level while we were below its landing: 09-19 23:43Z eleven
      // miners at y-48 "descended" to level 0, skipped all 80 branches one by one and stood there until the hang watchdog): out and down again properly
      if (nearestWp(bot, routeDown(M.G, M.level), 4) < 0) { bot.__ironLineFail = { why: 'off_line', at: [f.x, f.y, f.z], t: Date.now() }; return false }
      if (!await walkRoute(bot, M, routeDown(M.G, M.level), gen, { near: 4 })) return false
    } else if (loc.part === 'branch') {
      // standing in ANOTHER branch (the one we just finished / handed back): out to its mouth, then along the trunk - never via the hub
      const m = trunkCell(hub, branchOff(loc.k), loc.side > 0 ? 1 : 0)
      bot.state.task = 'iron:to-trunk'
      if (!await walkLine(bot, m.x, m.z, gen, 90000, { y: hub.y })) return false
    }
    bot.state.task = 'iron:trunk ' + br.key
    if (!await walkTrunk(bot, M, hub, branchOff(br.k), gen, { space: true })) { await trunkTrouble(bot, M); return needPick(bot, M, br) } // digs the trunk where it does not exist yet
    const m = trunkCell(hub, branchOff(br.k), br.side > 0 ? 1 : 0)
    if (!await walkLine(bot, m.x, m.z, gen, 20000, { y: hub.y })) return needPick(bot, M, br) // the mouth itself is such an ore: this branch waits for a better pick
  }
  bot.state.task = (br.repair ? 'iron:repair ' : 'iron:to-face ') + br.key
  const face = branchCell(hub, br.k, br.side, br.len)
  if (await walkLine(bot, face.x, face.z, gen, 90000, { y: hub.y })) {
    const pl = bot.__ironLinePlugs
    if (br.repair || pl) {
      await update(M.E, d => { const b = lvState(d, M.level).branches[br.key]; if (b && b.hazard) { b.hazardWas = { kind: b.hazard, at: b.hazardAt, by: b.hazardBy, t: b.hazardT }; b.hazard = null; b.sealedBy = bot.username; b.sealedT = Date.now() } })
      say(bot, { ev: 'mine_hazard_sealed', level: M.level, branch: br.key, plugs: pl ? pl.n : 0, at: pl ? pl.at : (br.hazardAt || null), note: pl ? 'lava on the way to the face was plugged from 2 cells away and the line re-opened cell by cell' : 'walked to the face: nothing hot on the line any more' })
    }
    return true
  }
  const lf = bot.__ironLineFail
  if (lf && lf.why === 'lava' && !stale(bot)) { // met on THIS branch's line -> the branch is closed behind the wall; met elsewhere (trunk) -> no fault of the branch
    const hit = lf.hot ? branchAt(M.G, { x: lf.hot[0], y: hub.y, z: lf.hot[2] }) : null
    if (hit && hit.key === br.key && hit.level === M.level) await markHazard(bot, M.E, M.level, br.key, { kind: lf.kind || 'lava', at: lf.hot, close: true, walled: lf.walled, len: hit.len - 3 })
    else await saveBranch(M, br.key, { owner: null })
    return false
  }
  return needPick(bot, M, br)
}
// THE TRUNK CANNOT BE DRIVEN ON (an aquifer, a void nobody can floor - level 16: every branch from k 35 on ended `liquid` at its first cell): when TWO
// different miners fail with blocked / no_floor at the same stretch BEYOND the old trunk end, the level ends there (`kStop`: claimBranch and
// branchOutlook offer nothing further out) - else 26 miners in turn walk 240 blocks to branches nobody can reach. One report.
async function trunkTrouble (bot, M) {
  const lf = bot.__ironLineFail
  if (!lf || !(lf.why === 'blocked' || lf.why === 'no_floor') || stale(bot)) return
  const q = relTo(M.lv.hub, lf.at[0], lf.at[2]); const k = Math.max(0, Math.ceil((q.along - FIRST_OFF) / SPACING))
  if ((q.across !== 0 && q.across !== 1) || k < 40) return // the first 40 mouths are the proven trunk: trouble there is a repair, not the end of the level
  const stop = await update(M.E, d => {
    const L = lvState(d, M.level); const t = L.trunkFail && Math.abs(L.trunkFail.k - k) <= 1 ? L.trunkFail : { k, bots: [] }
    if (!t.bots.includes(bot.username)) t.bots.push(bot.username)
    t.t = Date.now(); t.why = lf.why; t.at = lf.at; L.trunkFail = t
    if (t.bots.length >= 2 && (L.kStop == null || k < L.kStop)) { L.kStop = k; for (const [key, b] of Object.entries(L.branches)) if (!b.done && b.k >= k) delete L.branches[key]; return k }
    return null
  })
  if (stop != null) say(bot, { ev: 'mine_trunk_end', level: M.level, k: stop, at: lf.at, why: lf.why, note: 'two miners could not drive the trunk on here: the level ends at branch pair ' + stop })
}
// the way to the branch runs through an ore this bot's pick cannot harvest (world 1: deepslate_gold_ore in the trunk head held two stone-pick
// miners until the hang watchdog): the branch goes to a better pick (`need`), this bot takes another one. Always returns false.
async function needPick (bot, M, br) {
  const lf = bot.__ironLineFail
  if (lf && lf.why === 'needpick') await update(M.E, d => { const b = lvState(d, M.level).branches[br.key]; if (b) Object.assign(b, { need: 3, owner: null, t: 0 }) })
  return false
}

// a cell of a dug 1x2 gallery running along d: solid floor and roof, and rock on at least 2 of its 4 side cells (an ore pocket taken out of a wall
// leaves a hole or two; a cave has no such tube)
function galleryCell (bot, x, y, z, d) {
  if (!isSolid(blk(bot, x, y - 1, z)) || !isSolid(blk(bot, x, y + 2, z))) return false
  let n = 0
  for (const s of [[-d[1], d[0]], [d[1], -d[0]]]) for (const dy of [0, 1]) if (isSolid(blk(bot, x + s[0], y + dy, z + s[1]))) n++
  return n >= 2
}
// Mine our branch for a stint. Returns {why, ore, dug}
async function mineBranch (bot, M, br, gen, opts = {}) {
  const hub = M.lv.hub
  const dirIdx = branchDir(hub, br.side)
  const d = DIRS[dirIdx]
  const y = hub.y
  let len = br.len
  let ore = 0
  let fails = 0
  const hotSt = { plugs: 0 }
  const t0 = Date.now()
  const maxMs = opts.maxMs || 20 * 60000
  let why = 'time'
  while (Date.now() - t0 < maxMs) {
    await sleep(25)
    if (stale(bot, gen)) { why = 'stale'; break }
    if (await defend(bot, gen)) { if (bot.health < 6) { why = 'hurt'; break } continue }
    await eat(bot)
    { const ex = exitReason(bot); if (ex) { why = ex; break } }
    if (U.freeSlots(bot) <= 3) await tossJunk(bot, false, [-d[0], -d[1]])
    if (!bestPick(bot)) { let ok = false; for (let i = 0; i < 3 && !ok; i++) { ok = await ensurePick(bot, 1); if (!ok) await sleep(800) } if (!ok) { why = 'notool'; break } }
    if (len >= branchLen(M)) { // (a dug gallery that runs on beyond the level's length is still walked to its true face: re-learning costs no pick)
      const c = branchCell(hub, br.k, br.side, len + 1)
      if (!(isOpen(blk(bot, c.x, y, c.z)) && isOpen(blk(bot, c.x, y + 1, c.z)) && galleryCell(bot, c.x, y, c.z, d))) { why = 'end'; break }
    }
    const face = branchCell(hub, br.k, br.side, len)
    const f = feet(bot)
    if (f.x !== face.x || f.z !== face.z || f.y !== y) {
      if (!await returnTo(bot, face, gen)) { if (++fails > 3) { why = 'lost'; break } continue }
    }
    const nx = face.x + d[0]; const nz = face.z + d[1]
    // cave ahead? (both cells already open and the one after too) -> seal and finish this branch
    const a0 = blk(bot, nx, y, nz); const a1 = blk(bot, nx, y + 1, nz)
    const b0 = blk(bot, nx + d[0], y, nz + d[1])
    // OUR OWN OLD GALLERY (the ledger was lost / the record is short): open, floor and roof solid, a wall to the sides = a branch somebody dug. It is
    // WALKED and counted, not sealed as a "cave" (09-20 05:40Z the cache was wiped: every dug branch would have been shut at its mouth with 2 blocks,
    // `done cave len 1`, one round trip each). The same look-ahead as walkLine: lava in it is plugged from 2 cells away or the branch ends `lava`.
    if (isOpen(a0) && isOpen(a1) && galleryCell(bot, nx, y, nz, d)) {
      const hz = await clearHot(bot, face, d, y, hotSt, gen)
      if (hz === 'plugged') continue // the plugs in the line are opened below by openCell/digCell with the full liquid protocol
      if (hz === 'lava') { why = 'lava'; await saveBranch(M, br.key, Object.assign({ len, ore: (br.ore || 0) + ore }, lavaAhead(bot, M, br, len))); await markHazard(bot, M.E, M.level, br.key, { kind: hotSt.kind || 'lava', at: hotSt.at, close: true, walled: hotSt.walled, len: len - 3 }); return { why, ore, len } }
      if (!await stepTo(bot, nx, nz, { ms: 3000, gen })) { if (++fails > 4) { why = 'stuck'; break } continue }
      fails = 0; len++; bump(bot, 'relearned')
      if (len % 8 === 0) { await saveBranch(M, br.key, { len }); hb(bot, { phase: 'relearn', branch: br.key, len, stats: bot.__ironStats }) }
      continue
    }
    if (isOpen(a0) && isOpen(a1) && isOpen(b0) && !/torch/.test(a0.name)) {
      for (const dy of [0, 1]) { const it = fillItem(bot); if (it) await placeAt(bot, it, new Vec3(nx, y + dy, nz)) }
      why = 'cave'; len = Math.max(len, 1); await saveBranch(M, br.key, Object.assign({ len, done: true, ore: (br.ore || 0) + ore, why }, lavaAhead(bot, M, br, len))); return { why, ore, len }
    }
    const r = await openCell(bot, nx, y, nz)
    if (r === 'notool') { why = 'notool'; break }
    if (r === 'needpick') {
      // The face is an ore our pick cannot harvest. 09-19: `notool` sent the miner up 140 steps for a "kit", it came back with the same stone pick to
      // the same face - 25:1 stopped three miners at len 23, a dozen round trips, rawDelivered 0. Now the branch is handed back with `need` = the pick
      // rank it wants (3 iron, 4 diamond) and this miner takes another branch; claimBranch gives it only to a bot whose pick can do it.
      const hard = [0, 1].map(dy => blk(bot, nx, y + dy, nz)).find(b => b && b.harvestTools) || null
      const need = hard && /obsidian|ancient_debris|netherite/.test(hard.name) ? 4 : 3
      why = 'needpick'
      await update(M.E, dd => { const b = lvState(dd, M.level).branches[br.key]; if (b) Object.assign(b, { len, ore: (br.ore || 0) + ore, need, owner: null, t: 0 }) })
      U.note(bot, 'info', 'branch ' + br.key + ' needs pick rank ' + need + ' @' + len + (hard ? ' (' + hard.name + ')' : ''))
      return { why, ore, len, need }
    }
    if (r !== 'ok') {
      U.note(bot, 'info', 'branch ' + br.key + ' ' + r + ' @' + len)
      for (const dy of [0, 1]) { const b = blk(bot, nx, y + dy, nz); if (b && !isSolid(b)) { const it = fillItem(bot); if (it) await placeAt(bot, it, b.position) } }
      why = r; await saveBranch(M, br.key, Object.assign({ len, done: true, ore: (br.ore || 0) + ore, why }, lavaAhead(bot, M, br, len))); return { why, ore, len }
    }
    await sealSides(bot, nx, [y + 1, y], nz, dirIdx)
    const cells = [[nx, y + 1, nz], [nx, y, nz]]
    if (!await stepTo(bot, nx, nz, { ms: 3000, gen })) {
      if (++fails > 4) {
        why = 'stuck'
        const p = bot.entity.position
        U.note(bot, 'warn', 'stuck @' + p.x.toFixed(2) + ',' + p.y.toFixed(2) + ',' + p.z.toFixed(2) + ' -> ' + nx + ',' + nz + ' cells ' + [0, 1, 2, -1].map(dy => (blk(bot, nx, y + dy, nz) || {}).name).join('/'))
        break
      }
      continue
    }
    fails = 0
    len++
    bump(bot, 'advance')
    for (const o of exposedOre(bot, cells)) {
      if (stale(bot, gen)) break
      const b = bot.blockAt(o.position)
      if (!b || !ORE_RE.test(b.name)) continue
      ore += await mineVein(bot, b, y, { x: nx, y, z: nz }, gen)
    }
    if (len % TORCH_EVERY === 2) { if (U.count(bot, 'torch') < 2) await ensureTorches(bot, 12); await torchNear(bot, nx, y, nz, dirIdx) }
    // (no toss while digging on: a pile in the branch lies on the miner's own way out and comes home in its pockets - a stint's stone fits the pack;
    //  the pack is emptied at the FACE when the miner leaves, I.toSurface, and thrown behind only when it is full, above)
    if (len % 4 === 0) { await sweep(bot, 500, 2.5); await saveBranch(M, br.key, { len, ore: (br.ore || 0) + ore, need: 0 }); hb(bot, { phase: 'branch', branch: br.key, len, stats: bot.__ironStats }) } // need: 0 = the hard face is behind us
  }
  refresh(M)
  await saveBranch(M, br.key, Object.assign({ len, ore: (br.ore || 0) + ore, done: len >= branchLen(M) }, len > br.len ? { need: 0 } : {}))
  return { why, ore, len }
}

function rawIron (bot) { return U.count(bot, 'raw_iron') }
// what a trip up is worth: the level at y-54 yields diamonds/redstone/lapis/gold and almost no iron, so "20 raw iron" alone never triggered a haul
// (09-19: 70 slices, nothing delivered). raw iron/gold 1, diamond/emerald 4, redstone/lapis 1/8, coal 1/16.
const LOOT = { raw_iron: 1, raw_gold: 1, diamond: 4, emerald: 4, redstone: 1 / 8, lapis_lazuli: 1 / 8, coal: 1 / 16 }
function lootScore (bot) { let v = 0; for (const [n, w] of Object.entries(LOOT)) v += U.count(bot, n) * w; return Math.floor(v) }
function needHaul (bot) {
  if (rawIron(bot) >= (bot.__ironHaulAt || 20)) return true
  if (lootScore(bot) >= 32) return true
  // THE QUARRY (stoneWanted): 4 stacks of stone beyond the kit's 48 = a load worth the stairs. Without this a miner in an ore-poor branch carried
  // stone until the pack was FULL (~30 stacks, hours) while 23 builders stood at `build_blocked: no cobblestone`.
  if (cobbleCount(bot) >= 48 + 256 && stoneWanted()) return true
  // keep_inventory is OFF: anything of value goes up at least every 25 min (bot.__ironLastBase is kept by iron_miner across slices)
  if (lootScore(bot) >= 2 && Date.now() - (bot.__ironLastBase || Date.now()) > 25 * 60000) return true
  // wanted stone IS of value: 2 stacks beyond the kit go up on the same 25-min clock (an ore-poor branch + a worn pick never reached 304)
  if (cobbleCount(bot) >= 48 + 128 && Date.now() - (bot.__ironLastBase || Date.now()) > 25 * 60000 && stoneWanted()) return true
  if (U.freeSlots(bot) <= 1 && !bot.inventory.items().some(i => JUNK_RE.test(i.name) && !(i.name === 'cobbled_deepslate' && stoneWanted()))) return true // full of things worth carrying (wanted stone counts)
  return false
}

// ------------------------------------------------------------------ going down PREPARED, coming up for a REASON
// bread-equivalents in the pockets - ONE definition of "food": army/stock.js groups.food (hunger points / 5)
function foodUnits (bot) {
  let w = null
  try { w = require('../../army/stock.js').groups.food } catch (e_) { swallow('iron_core:stockGroups', e_) }
  let v = 0
  for (const i of bot.inventory.items()) { const f = bot.registry.foodsByName[i.name]; if (!f || /rotten_flesh|spider_eye|poisonous|pufferfish|chorus/.test(i.name)) continue; v += i.count * (w ? w(i.name) : (f.foodPoints || 0) / 5) }
  return Math.floor(v)
}
function pickUses (bot) { return pickaxes(bot).reduce((n, i) => n + Math.max(0, durLeft(bot, i)), 0) }
// World 1 (d): miners went down hungry, with one worn pick and no torches; every broken pick was a 280-step round trip and the dark trunk bred
// creepers. missing = nobody descends without it · short = taken along "when available" (the depot may simply have none yet)
function readiness (bot) {
  const missing = []; const short = []
  // A NEW WORLD HAS NO LARDER (world 2 day one: food 19/448 for 50 bots; the food gate kept every miner up while coal, iron and cobblestone -
  // i.e. torches, furnaces, the bucket, COOKED food - all wait for the mine). While the army's food stock is under 64 a well-fed bot
  // (hunger >= 14) may go down; the `hungry` exit still brings it up through the stairs.
  let larder = 1e9; try { larder = require('../../army/stock.js').have('food') } catch (e_) { swallow('iron_core:larder', e_) }
  if (foodUnits(bot) < 8 && !(larder < 64 && (bot.food || 0) >= 14)) missing.push('food')
  if (!bestPick(bot)) missing.push('pickaxe'); else if (pickaxes(bot).length < 2 && U.count(bot, 'stick') < 2 && woodUnits(bot) < 2) missing.push('pick_spare') // stone is down there, sticks are not
  if (U.count(bot, 'torch') < 16) short.push('torch')
  if (!fillItem(bot)) short.push('cobblestone') // a stair repair needs a block in hand
  return { missing, short }
}
// why a miner underground should go UP now (null = stay): every one of these leaves through toSurface
function exitReason (bot) {
  if (needHaul(bot)) return 'haul'
  if (!bestPick(bot) && !canCraftPick(bot)) return 'notool'
  if (pickUses(bot) < 24 && !canCraftPick(bot)) return 'pick_worn'
  if (bot.food != null && bot.food <= 8 && foodUnits(bot) < 1) return 'hungry'
  return null
}

// ------------------------------------------------------------------ THE WAY OUT
// Off the graph (fell into a cave, a vein excursion that lost its trail, knocked off a line): ONE short 1x2 connection to the nearest graph cell -
// the stair row at our own height (every y has one), else the nearest trunk - stepped one block per cell where the height differs. Only inside
// the mine's box, never further than 64, never towards the sky; `mine_reconnect` tells the board where the hole is (from -> to) and whether the
// bot is verifiably back on the graph.
function reconnectTarget (M, f) {
  let best = null
  const take = (p, part) => { const cost = Math.abs(p[0] - f.x) + Math.abs(p[2] - f.z) + 2 * Math.abs(p[1] - f.y); if (!best || cost < best.cost) best = { p, part, cost } }
  const st = refresh(M)
  for (const [k, g] of M.G.feet) { if (g > st.dug) continue; const p = k.split(',').map(Number); if (p[1] === f.y || (g === Math.max(0, st.dug) && p[1] > f.y)) take(p, 'stair') }
  for (const lv of Object.values(M.G.levels)) {
    if (lv.g > st.dug || Math.abs(lv.y - f.y) > 24) continue
    const ks = Object.values(lvState(st, lv.y).branches).map(b => b.k); const maxOff = ks.length ? branchOff(Math.max(...ks)) : 1
    const q = relTo(lv.hub, f.x, f.z); const c = trunkCell(lv.hub, Math.max(0, Math.min(maxOff, q.along)), 0)
    take([c.x, c.y, c.z], 'trunk')
    for (const b of Object.values(lvState(st, lv.y).branches)) { // a cave at the end of a 128-block branch: the branch itself is the nearest graph line
      if (!(b.len > 0)) continue
      const n = Math.max(1, Math.min(b.len, b.side > 0 ? q.across - 1 : -q.across)); const bc = branchCell(lv.hub, b.k, b.side, n)
      take([bc.x, bc.y, bc.z], 'branch')
    }
  }
  return best
}
// one cell of a stepped 1x2 connection (dy = +1 up / -1 down): 'ok' or why not
async function stepDig (bot, sx, sz, dy, gen) {
  const f = feet(bot); const nx = f.x + sx; const nz = f.z + sz; const ny = f.y + dy
  const open = dy > 0 ? [[f.x, f.y + 2, f.z], [nx, ny + 1, nz], [nx, ny, nz]] : [[nx, f.y + 1, nz], [nx, f.y, nz], [nx, ny, nz]]
  for (const c of open) { const r = await digCell(bot, new Vec3(c[0], c[1], c[2]), { hand: true, breach: true }); if (r !== 'ok' && r !== 'air') return r }
  if (!isSolid(blk(bot, nx, ny - 1, nz))) { const it = fillItem(bot); if (!it || !await placeAt(bot, it, new Vec3(nx, ny - 1, nz))) return 'nofloor' }
  await stepTo(bot, nx, nz, { ms: 3000, gen, up: dy > 0 })
  await settle(bot, 1200, ny)
  const g = feet(bot)
  return g.x === nx && g.z === nz && g.y === ny ? 'ok' : 'fail'
}
async function reconnect (bot, M, gen) {
  const from = feet(bot)
  const out = (ok, why, extra) => { const p = feet(bot); const rec = Object.assign({ ev: 'mine_reconnect', ok, from: [from.x, from.y, from.z], at: [p.x, p.y, p.z] }, why ? { why } : {}, extra || {}); say(bot, rec); if (!ok) { try { army().askHelp(bot, 'mine_lost', 'off the mine graph at ' + rec.at.join(',') + ': ' + why, { at: rec.at }) } catch (e_) { swallow('iron_core:lostHelp', e_) } } return { ok, why } }
  if (!inBox(M.box, from, 12)) return out(false, 'outside_mine_box')
  const tgt = reconnectTarget(M, from)
  if (!tgt || tgt.cost > 64) return out(false, tgt ? 'too_far' : 'no_target', tgt ? { to: tgt.p } : null)
  bot.state.task = 'iron:reconnect ' + tgt.p.join(',')
  const dug0 = (bot.__ironStats || {}).dug || 0
  let moves = tgt.cost + 16; let bad = 0
  while (moves-- > 0 && !stale(bot, gen) && !locate(M.G, feet(bot), 0)) {
    const f = feet(bot); const dy = Math.sign(tgt.p[1] - f.y)
    if (dy === 0) { await walkLine(bot, tgt.p[0], tgt.p[2], gen, 60000 + tgt.cost * 4000, { y: tgt.p[1], hand: true, breach: true }); break }
    const dx = tgt.p[0] - f.x; const dz = tgt.p[2] - f.z
    const dirs = Math.abs(dx) >= Math.abs(dz) ? [[Math.sign(dx) || 1, 0], [0, Math.sign(dz) || 1], [0, -(Math.sign(dz) || 1)]] : [[0, Math.sign(dz) || 1], [Math.sign(dx) || 1, 0], [-(Math.sign(dx) || 1), 0]]
    let r = null
    for (const [sx, sz] of dirs) { r = await stepDig(bot, sx, sz, dy, gen); if (r === 'ok') break }
    if (r !== 'ok' && ++bad >= 3) return out(false, 'step_' + r, { to: tgt.p })
  }
  const ok = !!locate(M.G, feet(bot), 0)
  return out(ok, ok ? null : ((bot.__ironLineFail || {}).why || 'not_arrived'), { to: tgt.p, part: tgt.part, dug: ((bot.__ironStats || {}).dug || 0) - dug0 })
}

// toSurface(bot, opts) - exported for army_jobs' upTheStairs and used by every exit of iron_miner. From ANY cell of the mine: locate the bot on
// the graph by geometry -> branch line -> trunk (home lane) -> hub -> the audited stairs, all with raw controls. Never a pathfinder search through
// rock (world 1 (b): re-assigned miners tunnelled straight up). opts: {args (the job's params.args), why, gen, mine}
// -> {ok, was:'up'|'underground', why?, pos}
async function toSurface (bot, opts = {}) {
  const gen = opts.gen != null ? opts.gen : (bot.__ironGen = (bot.__ironGen || 0) + 1) // a caller from outside the skill makes any running mine routine stale
  const M = opts.mine || await mine(bot, opts.args || bot.__ironArgs || {}, { recall: true })
  const pos = () => { const p = feet(bot); return [p.x, p.y, p.z] }
  if (!M) return { ok: false, why: 'mine_no_entrance', pos: pos() }
  if (!underground(bot, M)) return { ok: true, was: 'up', pos: pos() }
  const label = 'iron:surface(' + (opts.why || 'recall') + ')'
  bot.state.task = label // BEFORE the first stale(): any other task string reads as "another skill took this bot"
  // EVERY way up leaves the junk stone below (only iron_miner's own exits tossed it: a recall by the army, `no_branch`, `lost` carried full packs up
  // 140 steps and the bank threw 1280 cobbled deepslate on the base); wanted stone (stoneWanted) is kept by tossJunk itself
  try {
    const loc = locate(M.G, feet(bot)); const hub = loc && loc.part !== 'stair' ? M.G.levels[loc.level].hub : null
    await tossJunk(bot, true, !hub ? null : loc.part === 'branch' ? DIRS[branchDir(hub, loc.side)] : DIRS[hub.dir]) // away from the way home
  } catch (e_) { swallow('iron_core:surfaceToss', e_) }
  let why = 'failed'
  for (let round = 0; round < 4 && !stale(bot, gen); round++) {
    if (!underground(bot, M)) break
    bot.state.task = label
    refresh(M)
    const plan = planUp(M.G, feet(bot))
    if (!plan) { const r = await reconnect(bot, M, gen); if (!r.ok) { why = r.why; break } continue }
    let ok = true
    for (const leg of plan.legs) {
      if (leg.line) {
        const hub = M.G.levels[plan.level].hub
        const home = leg.line[0] === hub.x && leg.line[2] === hub.z
        // the way out of a 192-long branch at the far end of a 240-block trunk is a REAL walk: the budget follows the route planUp measured (cells =
        // branch + trunk + stairs), never a flat 90 s (11:0xZ: `recalled surfaced:false why:budget` from branch 30:-1 of the new level y32)
        const legMs = Math.max(90000, plan.cells.length * 1500)
        ok = home ? await walkTrunk(bot, M, hub, 0, gen, { hand: true, ms: legMs }) : await walkLine(bot, leg.line[0], leg.line[2], gen, legMs, { y: hub.y, hand: true })
        if (!ok) { why = (bot.__ironLineFail || {}).why || 'line'; break }
      } else {
        ok = await walkRoute(bot, M, leg.stairs, gen, { near: 3 })
        if (!ok) why = (bot.__ironStairFail || {}).why || 'stairs'
      }
    }
    if (ok) break
    await sleep(1500)
  }
  const up = !underground(bot, M)
  // an INTERRUPTED walk is not a blocked one: walkLine/walkRoute return false WITHOUT a failure record only when the run went stale (slice end, hot
  // reload, recall by the army). 09-20: `mine_blocked surface_stairs|surface_line` x9 by 6 bots read as "miners cannot climb" - every one of them was
  // followed within 40 s by `recalled surfaced:true` or carried on in its next slice to `banked` (240 banks/h); the 02:13:46Z cluster was a hot reload.
  if (!up && stale(bot, gen) && (why === 'line' || why === 'stairs' || why === 'failed')) return { ok: false, why: 'interrupted', pos: pos() } // 'line'/'stairs' = the leg left no failure record
  if (!up) blocked(bot, 'surface_' + why, { want: 'up' })
  return up ? { ok: true, was: 'underground', pos: pos() } : { ok: false, why, pos: pos(), fail: bot.__ironStairFail || bot.__ironLineFail || null }
}

// ------------------------------------------------------------------ LAVA ON RECORD + THE OBSIDIAN TRIP (roadmap P4: enchanting table 4 · P5: portal 10-14)
// Lava goes on record where miners MEET it: digCell (a lava face beside / in a cell it opens) -> cache.lava [{at, where, by, t}], and a branch that
// ends at a cave or a liquid looks ahead along its floor (`lava: n` on the branch record = a lake in front of that face). No x-ray: what a cell we
// opened touches, and what lies open in front of a face.
const LAVA_SEEN = global.__ironLavaSeen = global.__ironLavaSeen || new Set()
function noteLava (bot, p) {
  try {
    const M = CUR; if (!M || !p) return
    const g = [Math.floor(p.x / 8), Math.floor(p.y / 8), Math.floor(p.z / 8)].join(',')
    if (LAVA_SEEN.has(g)) return
    LAVA_SEEN.add(g)
    const loc = bot.entity ? locate(M.G, feet(bot)) : null
    const where = !loc ? null : loc.part === 'stair' ? 'stair ' + loc.g : loc.part === 'trunk' ? loc.level + '/trunk@' + loc.along : loc.level + '/' + loc.k + ':' + loc.side + '@' + loc.len
    update(M.E, d => {
      d.lava = (d.lava || []).filter(e => Math.abs(e.at[0] - p.x) + Math.abs(e.at[1] - p.y) + Math.abs(e.at[2] - p.z) > 8)
      d.lava.push({ at: [p.x, p.y, p.z], where, by: bot.username, t: Date.now() })
      if (d.lava.length > 200) d.lava = d.lava.slice(-200)
    }).catch(e_ => swallow('iron_core:noteLavaSave', e_))
  } catch (e_) { swallow('iron_core:noteLava', e_) }
}
// still lava with open air over it on the floor in front of a branch face (8 cells ahead, 2 to each side) -> {lava: n} for the branch record
function lavaAhead (bot, M, br, len) {
  try {
    const hub = M.G.levels[M.level].hub; const d = DIRS[branchDir(hub, br.side)]; const c0 = branchCell(hub, br.k, br.side, len); let n = 0
    for (let i = 1; i <= 8; i++) for (let j = -2; j <= 2; j++) { const x = c0.x + d[0] * i - d[1] * j; const z = c0.z + d[1] * i + d[0] * j; const b = blk(bot, x, hub.y - 1, z); if (b && b.name === 'lava' && b.metadata === 0 && isOpen(blk(bot, x, hub.y, z))) n++ }
    if (n) noteLava(bot, new Vec3(c0.x + d[0], hub.y - 1, c0.z + d[1]))
    return n ? { lava: n } : {}
  } catch (e_) { swallow('iron_core:lavaAhead', e_); return {} }
}

// OBSIDIAN the way a careful player makes it, WITHOUT LEAVING THE GRAPH: the spot is the FACE of a finished branch whose line runs onto a lava lake at
// floor level (level -54: the lakes of the deep caves stand at y-55 = exactly the floor of that level). Cells along the branch line:
//   B = dam (a temporary block: the water must not run down the branch nor push the miner away) · S = where the miner stands for the cast (2 cells
//   from the lava) · F = the shore cell, solid floor: the water SOURCE goes here · A1.. = the lake.
// cast: pour at F -> the water runs up to 7 cells over the lake: still lava under/beside it becomes obsidian, flowing lava cobblestone -> the water is
// taken up again (from the pour to the scoop nothing but death interrupts) -> the sheet is mined as a 1-deep TRENCH from A1 on: the miner stands IN the
// trench, digs the obsidian beside it at foot level (drops at its feet, never over lava), and only cells with SOLID ground under them and NO lava on
// any face (= a block always stays between every open cell and the lake; never the block under the feet, never down).
// Spot states on the branch record (`obs.state`): none (no lake at our level) · poor · deep (a lake, but lava UNDER the sheet: the drop would burn) ·
// near_trunk (the dam would stand in the trunk) · unsafe (lava at walking height) · done · open (more to fetch) · others = retry after 20 min.
const OBS_FINAL = new Set(['none', 'poor', 'deep', 'near_trunk', 'unsafe', 'done'])
function obsCandidates (bot, M, level) {
  const out = []; const now = Date.now(); const st = M.st
  for (const [lvS, L] of Object.entries(st.lv || {})) {
    const lv = Number(lvS); const gl = M.G.levels[lv]
    if (!gl || st.dug < gl.g || (Number.isFinite(level) && lv !== level)) continue
    for (const [key, b] of Object.entries(L.branches || {})) {
      const o = b.obs || {}
      if (!b.done || !(b.len >= 1) || OBS_FINAL.has(o.state) || (o.until && o.until > now)) continue
      if (o.owner && o.owner !== bot.username && now - (o.claimed || 0) < CLAIM_MS) continue
      const known = (b.lava || 0) > 0 || o.state === 'open'
      // not on record yet: the lava lakes of the deep caves (y <= -54) lie in front of cave / liquid ends of the deep levels - those are worth a look
      if (!known && !((b.why === 'cave' || b.why === 'liquid') && lv <= -50)) continue
      const [k, side] = key.split(':').map(Number)
      out.push({ level: lv, key, k, side, len: b.len, known, own: o.owner === bot.username && o.state === 'open' })
    }
  }
  return out.sort((p, q) => (q.own - p.own) || (q.known - p.known) || (p.level - q.level) || (p.k - q.k))
}
function obsidianOutlook (bot, M, level) { const c = obsCandidates(bot, M, level); return { n: c.length, known: c.filter(s => s.known).length } }
async function claimObsidianSpot (bot, M, level) {
  return update(M.E, d => {
    const c = obsCandidates(bot, Object.assign({}, M, { st: d }), level)[0]
    if (!c) return null
    const b = lvState(d, c.level).branches[c.key]
    b.obs = Object.assign({}, b.obs, { owner: bot.username, claimed: Date.now() })
    return c
  })
}
async function saveSpot (M, key, rec, len) { return update(M.E, d => { const b = lvState(d, M.level).branches[key]; if (!b) return; b.obs = Object.assign({}, b.obs, rec, { t: Date.now() }); if (len > (b.len || 0)) b.len = len }) }
function diamondPick (bot) { return pickaxes(bot).find(i => pickRank(i.name) >= 4 && durLeft(bot, i) > 12) || null }
function obsidianReady (bot) {
  const missing = []; const short = []
  if (!diamondPick(bot)) missing.push('diamond_pickaxe') // nothing else harvests obsidian
  const w = U.count(bot, 'water_bucket')
  if (w < 1) missing.push('water_bucket'); else if (w < 2) short.push('water_bucket_spare')
  return { missing, short }
}
// WHERE WOULD THE WATER GO, and which lava would it touch? Source in cell F at feet level y: it spreads <= 7 cells over open cells, falls into open
// pits (at most 2 down: deeper is not our business) and spreads again; lava UNDER or BESIDE a water cell turns. -> {cells:[{x,y,z,src,shallow}], src, shallow}
// (src = still lava = obsidian; shallow = solid ground under it = its drop cannot fall into lava).
function lakeSurvey (bot, F, y) {
  const seen = new Set(); const lava = new Map()
  const hit = (x, L, z) => { const b = blk(bot, x, L, z); const k = ck(x, L, z); if (!b || b.name !== 'lava' || lava.has(k)) return; lava.set(k, { x, y: L, z, src: b.metadata === 0, shallow: isSolid(blk(bot, x, L - 1, z)) }) }
  const q = [{ x: F.x, z: F.z, L: y, n: 0 }]
  while (q.length && seen.size < 600) {
    const c = q.shift(); const k = ck(c.x, c.L, c.z)
    if (seen.has(k)) continue
    seen.add(k)
    const under = blk(bot, c.x, c.L - 1, c.z)
    if (under && under.name === 'lava') hit(c.x, c.L - 1, c.z)
    else if (under && isOpen(under)) { if (c.L - 1 >= y - 2) q.push({ x: c.x, z: c.z, L: c.L - 1, n: 0 }); continue } // falling water does not spread sideways
    if (c.n >= 7) continue
    for (const [dx, dz] of DIRS) { const b = blk(bot, c.x + dx, c.L, c.z + dz); if (!b) continue; if (b.name === 'lava') hit(c.x + dx, c.L, c.z + dz); else if (isOpen(b)) q.push({ x: c.x + dx, z: c.z + dz, L: c.L, n: c.n + 1 }) }
  }
  const cells = [...lava.values()]
  return { cells, src: cells.filter(c => c.src).length, shallow: cells.filter(c => c.src && c.shallow).length }
}
// the server ray-traces a bucket click from the EYE along the look direction: look, wait for the look to arrive, click, then trust only the world
async function useBucket (bot, item, target) {
  if (!await U.equip(bot, item, 'hand')) return false
  try { await bot.lookAt(target, true) } catch (e_) { swallow('iron_core:bucketLook', e_) }
  await sleep(250)
  try { bot.activateItem() } catch (e_) { swallow('iron_core:bucketUse', e_) }
  await sleep(450)
  try { bot.deactivateItem() } catch (e_) { swallow('iron_core:bucketRelease', e_) }
  return true
}
// a water SOURCE into `cell` (its floor is solid; we stand in S beside it). true = the source is THERE 1.3 s later.
async function pourAt (bot, cell, S) {
  const isSrc = () => { const b = bot.blockAt(cell); return !!b && b.name === 'water' && b.metadata === 0 }
  for (let i = 0; i < 3 && !isSrc(); i++) {
    if (U.count(bot, 'water_bucket') < 1) return false
    const tgt = new Vec3(cell.x + 0.5, cell.y + 0.02, cell.z + 0.5)
    let hit = null; try { const e = eye(bot); hit = bot.world.raycast(e, tgt.minus(e).normalize(), 5) } catch (e_) { swallow('iron_core:pourRay', e_) }
    // the click lands on the first block of the ray: it must be the FLOOR of the cell (else the water would stand somewhere else)
    if (!(hit && hit.position && hit.position.x === cell.x && hit.position.y === cell.y - 1 && hit.position.z === cell.z)) { await stepTo(bot, S.x, S.z, { ms: 1500, tol: 0.15, force: true }); await sleep(200); if (i < 2) continue }
    await useBucket(bot, 'water_bucket', tgt)
    await sleep(1300)
  }
  return isSrc()
}
// take the source in `cell` up again. true = the source is GONE (the bucket is judged separately: count of water_bucket)
async function scoopAt (bot, cell) {
  const isSrc = () => { const b = bot.blockAt(cell); return !!b && b.name === 'water' && b.metadata === 0 }
  for (let i = 0; i < 4 && isSrc(); i++) {
    if (U.count(bot, 'bucket') < 1) return false
    await useBucket(bot, 'bucket', new Vec3(cell.x + 0.5, cell.y + 0.45, cell.z + 0.5))
    for (let w = 0; w < 10 && isSrc(); w++) await sleep(150)
  }
  return !isSrc()
}
// MINE THE SHEET as a trench (see above). F = shore cell (Vec3, feet level), d = the branch direction. -> {why, got}
async function mineSheet (bot, F, d, gen, want, access) {
  const y = F.y; const y1 = y - 1; const have0 = U.count(bot, 'obsidian'); const bad = new Set()
  const got = () => U.count(bot, 'obsidian') - have0
  // a trench cell is CLEAR when lava touches none of its faces (lava moves through faces only: every open cell keeps a solid block between itself and
  // the lake; a lake's rim under a rock overhang is never touched by the water and stays lava - 09-20 02:11Z: such a cell DIAGONALLY beside the entry
  // made a 3x3 rule refuse a whole sheet of 32), no lava stands at walking height in the 3x3 over it, and the ground under it is solid
  const clear = (x, z) => {
    for (const [dx, dz] of DIRS) { const b = blk(bot, x + dx, y1, z + dz); if (!b || b.name === 'lava') return false }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const yy of [y, y + 1]) { const b = blk(bot, x + dx, yy, z + dz); if (!b || b.name === 'lava') return false }
    return isSolid(blk(bot, x, y1 - 1, z))
  }
  const pit = (x, z) => isOpen(blk(bot, x, y1, z)) && isOpen(blk(bot, x, y, z)) && clear(x, z) // a trench cell we may stand in
  // what we dig: OBSIDIAN - and, second choice, the cobblestone/stone that flowing lava became in this cast (`access`: else one such cell at the shore shuts the whole sheet off)
  const target = (x, z, second) => { const b = blk(bot, x, y1, z); return !!b && (second ? (/^(cobblestone|stone)$/.test(b.name) && !!access && access.has(x + ',' + z)) : b.name === 'obsidian') && !bad.has(x + ',' + z) && Math.abs(x - F.x) + Math.abs(z - F.z) <= 9 && isOpen(blk(bot, x, y, z)) && clear(x, z) }
  const any = (x, z) => target(x, z) || target(x, z, true)
  const A1 = { x: F.x + d[0], z: F.z + d[1] }
  // from `from` through trench cells to the nearest cell accepted by `goal` -> [cells after from] | null
  const route = (from, goal) => {
    const prev = new Map([[from.x + ',' + from.z, null]]); const q = [from]
    while (q.length && prev.size < 300) {
      const c = q.shift()
      if (goal(c)) { const out = []; for (let p = c; p && !(p.x === from.x && p.z === from.z); p = prev.get(p.x + ',' + p.z)) out.unshift(p); return out }
      for (const [dx, dz] of DIRS) { const n = { x: c.x + dx, z: c.z + dz }; const k = n.x + ',' + n.z; if (!prev.has(k) && pit(n.x, n.z)) { prev.set(k, c); q.push(n) } }
    }
    return null
  }
  const hasWork = c => DIRS.some(([dx, dz]) => any(c.x + dx, c.z + dz))
  const dig = async (t) => {
    const had = U.count(bot, 'obsidian')
    const r = await digCell(bot, new Vec3(t.x, y1, t.z), { obsidian: true })
    if (r !== 'ok') { bad.add(t.x + ',' + t.z); return false }
    bump(bot, 'obsidian')
    for (let w = 0; w < 10 && U.count(bot, 'obsidian') <= had; w++) await sleep(150)
    return true
  }
  let why = 'exhausted'
  if (feet(bot).y !== y1) { // ENTRY from the shore cell: A1 is dug from above (diagonally, never the block under the feet), then we step down into it
    if (!any(A1.x, A1.z) && !(pit(A1.x, A1.z) && route(A1, hasWork))) return { why: 'no_entry', got: 0 }
    if (!await returnTo(bot, { x: F.x, y, z: F.z }, gen)) return { why: 'move', got: 0 }
    if (any(A1.x, A1.z) && !await dig(A1)) return { why: 'entry_dig', got: 0 }
    if (!pit(A1.x, A1.z)) return { why: 'entry_unsafe', got: got() }
    await stepTo(bot, A1.x, A1.z, { ms: 3000, gen }); await settle(bot, 1200, y1)
    const f = feet(bot); if (f.x !== A1.x || f.z !== A1.z || f.y !== y1) return { why: 'entry_step', got: got() }
  }
  for (let guard = 0; guard < 160; guard++) {
    await sleep(20)
    if (stale(bot, gen)) { why = 'stale'; break }
    if (bot.health < 12) { why = 'hurt'; break }
    if (got() >= want) { why = 'want'; break }
    if (!diamondPick(bot)) { why = 'pick_worn'; break }
    if (U.freeSlots(bot) <= 0) { why = 'full'; break }
    if (await defend(bot, gen)) continue
    const f = feet(bot)
    if (f.y !== y1 || !pit(f.x, f.z)) { why = f.y !== y1 ? 'off_trench' : 'lava_near'; break }
    const nb = DIRS.map(([dx, dz]) => ({ x: f.x + dx, z: f.z + dz }))
    const t = nb.find(c => target(c.x, c.z)) || (route(f, c => DIRS.some(([dx, dz]) => target(c.x + dx, c.z + dz))) ? null : nb.find(c => target(c.x, c.z, true)))
    if (t) {
      const had = U.count(bot, 'obsidian')
      if (await dig(t) && U.count(bot, 'obsidian') <= had && pit(t.x, t.z)) { await stepTo(bot, t.x, t.z, { ms: 2500, gen }); await sleep(500) } // the drop did not come to us: go and stand on it
      hb(bot, { phase: 'obsidian', got: got(), stats: bot.__ironStats })
      continue
    }
    const path = route(f, hasWork)
    if (!path || !path.length) break
    for (const c of path) { if (!pit(c.x, c.z) || !await stepTo(bot, c.x, c.z, { ms: 2500, gen })) break }
  }
  // BACK onto the branch line - also when the slice ended or we are hurt (force: only death stops this walk)
  for (let tries = 0; tries < 3 && bot.entity && feet(bot).y === y1; tries++) {
    const f = feet(bot)
    const path = (f.x === A1.x && f.z === A1.z) ? [] : route(f, c => c.x === A1.x && c.z === A1.z)
    if (path) for (const c of path) await stepTo(bot, c.x, c.z, { ms: 2500, force: true })
    await stepTo(bot, F.x, F.z, { ms: 3000, up: true, force: true }); await settle(bot, 1000)
  }
  return { why, got: got() }
}
// THE SPOT: look, approach, cast, mine (up to 3 rounds). `br` = {key,k,side,len} of M.level; the bot stands at the branch's face (gotoBranchFace).
// -> {state, got, cast, casts, why?}; the state is saved on the branch record.
async function obsidianAt (bot, M, br, gen, opts = {}) {
  const hub = M.lv.hub; const y = hub.y; const d = DIRS[branchDir(hub, br.side)]
  const want = opts.want || 16; const have0 = U.count(bot, 'obsidian')
  const got = () => U.count(bot, 'obsidian') - have0
  const cell = n => { const c = branchCell(hub, br.k, br.side, n); return new Vec3(c.x, y, c.z) }
  let len = br.len; let casts = 0; let cast = 0; let shore = null
  // THE MINE STAYS A CLOSED TUBE: the shore cell is walled up again whenever we leave (09-20 02:42Z: a skeleton shot the second obsidian miner in the
  // -54 trunk - the first version left every lake it had opened open to the caves). The next visitor's walk to the face digs the two blocks out.
  const seal = async () => {
    if (shore == null || !bot.entity || bot.health <= 0) return null
    const Fc = cell(shore); const Sc = cell(shore - 1); const f = feet(bot)
    if (f.y !== y || Math.abs(f.x - Sc.x) + Math.abs(f.z - Sc.z) > 1) return false
    // wall the shore cell up from the cell behind it; if that does not hold (nothing to place against, a mob in the cell), one cell further back
    for (const back of [0, 1]) {
      const W = cell(shore - back); const St = cell(shore - back - 1)
      await stepTo(bot, St.x, St.z, { ms: 3000, force: true, tol: 0.3 })
      for (const dy of [0, 1]) if (!isSolid(blk(bot, W.x, y + dy, W.z))) await placeAt(bot, fillItem(bot), W.offset(0, dy, 0), { temp: true })
      if ([0, 1].every(dy => isSolid(blk(bot, W.x, y + dy, W.z)))) return true
      if (shore - back - 2 < 1) break
    }
    return false
  }
  const done = async (state, extra) => {
    const rec = Object.assign({ state, n: got(), casts, by: bot.username, why: null }, extra || {})
    const sealed = await seal(); if (sealed != null) rec.sealed = sealed
    if (!OBS_FINAL.has(state) && state !== 'open') rec.until = Date.now() + 20 * 60000
    await saveSpot(M, br.key, rec, len)
    U.note(bot, 'info', 'obsidian spot ' + M.level + '/' + br.key + ' -> ' + JSON.stringify(rec).slice(0, 160))
    return Object.assign({ got: got(), cast }, rec)
  }
  const floorOf = c => blk(bot, c.x, y - 1, c.z)
  // the lake begins at cell c: lava or cast obsidian in its floor - or the TRENCH an earlier trip dug into the sheet (09-20 02:20Z: the second miner
  // read the first one's trench as "a hole before the lake" and wrote a sheet of 28 off as `none`)
  const lakeAt = c => { const b = floorOf(c); return !!b && (b.name === 'lava' || b.name === 'obsidian' || (isOpen(b) && isOpen(blk(bot, c.x, y, c.z)) && isSolid(blk(bot, c.x, y - 2, c.z)) && [-2, -1, 0, 1, 2].some(dx => [-2, -1, 0, 1, 2].some(dz => (blk(bot, c.x + dx, y - 1, c.z + dz) || {}).name === 'obsidian')))) } // a trench: a 1-deep pit with cast obsidian within 2 cells
  const lavaWalk = c => { for (const j of [-1, 0, 1]) for (const dy of [0, 1, 2]) { const b = blk(bot, c.x - d[1] * j, y + dy, c.z + d[0] * j); if (b && b.name === 'lava') return true } return false }
  // ---- LOOK: lava (or the obsidian of an earlier cast) on the floor of our line within 8 cells? else this cave has no lake at our level
  bot.state.task = 'iron:mine obsidian-look ' + br.key // `iron:mine…` = a task that legitimately stands still (the army's hang watchdog)
  let seen = false
  for (let i = 1; i <= 8 && !seen; i++) seen = lakeAt(cell(len + i))
  if (!seen) return done('none')
  // ---- APPROACH along the line while the floor is solid rock; F = the last cell before the lake (opened, never walked past)
  let atLake = false
  for (let i = 0; i < 8 && !atLake; i++) {
    if (stale(bot, gen)) return done('interrupted')
    const n1 = cell(len + 1); const n2 = cell(len + 2)
    if (lavaWalk(n1) || lavaWalk(n2)) return done('unsafe', { why: 'lava at walking height ahead of ' + [n1.x, y, n1.z].join(',') })
    if (lakeAt(n1)) { atLake = true; break }
    if (!isSolid(floorOf(n1))) { shore = len + 1; return done('none', { why: 'a hole before the lake' }) } // walled up at the hole's edge
    if (len + 2 > MAX_BRANCH) return done('none', { why: 'beyond the branch' })
    for (const dy of [1, 0]) { const r = await digCell(bot, n1.offset(0, dy, 0)); if (r !== 'ok' && r !== 'air') return done('blocked', { why: 'approach: ' + r }) }
    if (lakeAt(n2)) { len++; atLake = true; break } // n1 = F: opened, not entered - we stay 2 cells from the lava
    if (!await stepTo(bot, n1.x, n1.z, { ms: 3000, gen }) || feet(bot).y !== y) return done('blocked', { why: 'approach step' })
    len++
  }
  if (!atLake) return done('none', { why: 'no lake within 8 cells' })
  const F = cell(len); const S = cell(len - 1); const B = cell(len - 2); const A1 = cell(len + 1)
  shore = len
  const access = new Set()
  const waterAt = c => { const b = blk(bot, c.x, y, c.z); return !!b && b.name === 'water' }
  // a source somebody left at the shore (a caster that died between pour and scoop): take it up first - nothing is mined under running water
  if (waterAt(F) && U.count(bot, 'bucket') > 0) { await returnTo(bot, { x: S.x, y, z: S.z }, gen); await scoopAt(bot, F); for (let i = 0; i < 30 && [S, F, A1].some(waterAt); i++) await sleep(500) }
  for (let round = 0; round < 3; round++) {
    if (stale(bot, gen)) return done('open', { why: 'stale' })
    // ---- MINE what is cast already (this round's sheet, or one an earlier trip left)
    if (!lavaWalk(A1) && (floorOf(A1) || {}).name !== 'lava') {
      if (!diamondPick(bot)) return done('open', { why: 'no diamond pickaxe' })
      bot.state.task = 'iron:mine obsidian ' + br.key
      const m = await mineSheet(bot, F, d, gen, want - got(), access)
      if (m.why === 'want' || m.why === 'stale' || m.why === 'hurt' || m.why === 'pick_worn' || m.why === 'full') return done('open', { why: m.why })
      if (m.why === 'off_trench' || m.why === 'lava_near' || m.why === 'move') return done('retry', { why: m.why })
      if (casts && !m.got) return done(/entry/.test(m.why) ? 'deep' : 'retry', { why: 'sheet cast but nothing mined: ' + m.why, cast })
    }
    if ((floorOf(A1) || {}).name !== 'lava') return done(casts || got() ? 'done' : 'none', { why: 'no lava at the shore' })
    // ---- CAST
    if (lavaWalk(A1) || lavaWalk(F)) return done('unsafe', { why: 'lava at walking height at the shore' })
    // the branch's own SEAL (or a rock lip) stands on the lake's first cell: taken out from the casting cell so the water can run out over the lake -
    // noPlug: the lava UNDER it cannot rise, and a block put into it would be one obsidian less. Lava at walking height behind it -> shut again, unsafe.
    if ([0, 1].some(dy => isSolid(blk(bot, A1.x, y + dy, A1.z)))) {
      if (lavaWalk(cell(len + 2))) return done('unsafe', { why: 'lava at walking height behind the seal' })
      if (!await returnTo(bot, { x: S.x, y, z: S.z }, gen)) return done('retry', { why: 'cannot stand at the casting cell' })
      for (const dy of [1, 0]) { const r = await digCell(bot, A1.offset(0, dy, 0), { noPlug: true }); if (r !== 'ok' && r !== 'air') return done('blocked', { why: 'seal: ' + r }) }
      await sleep(1500)
      if (lavaWalk(A1) || lavaWalk(cell(len + 2))) { for (const dy of [0, 1]) await placeAt(bot, fillItem(bot), A1.offset(0, dy, 0), { temp: true }); return done('unsafe', { why: 'lava came at walking height when the seal was opened (shut again)' }) }
    }
    const sv = lakeSurvey(bot, F, y)
    // worth a cast only when the ENTRY (the lake's first cell on our line) has ground under it - the trench starts there - and a handful of others do
    const a1 = sv.cells.find(c => c.x === A1.x && c.z === A1.z && c.y === y - 1)
    if (sv.shallow < 4 || !a1 || !a1.shallow) return done(sv.src >= 3 ? 'deep' : 'poor', { lava: sv.src, shallow: sv.shallow, entry: !!(a1 && a1.shallow) })
    if (len - 2 < 2) return done('near_trunk', { lava: sv.src, shallow: sv.shallow })
    if (U.count(bot, 'water_bucket') < 1) return done('open', { why: 'no water_bucket', lava: sv.src, shallow: sv.shallow })
    bot.state.task = 'iron:mine obsidian-cast ' + br.key
    if (!await returnTo(bot, { x: S.x, y, z: S.z }, gen)) return done('retry', { why: 'cannot stand at the casting cell' })
    for (const dy of [1, 0]) { const r = await digCell(bot, F.offset(0, dy, 0)); if (r !== 'ok' && r !== 'air') return done('blocked', { why: 'shore cell: ' + r }) }
    let dam = false
    if (!isSolid(blk(bot, B.x, y, B.z))) { if (!await placeAt(bot, fillItem(bot), B, { temp: true })) return done('retry', { why: 'no dam behind the casting cell (filler?)' }); dam = true }
    const poured = await pourAt(bot, F, S)
    if (poured) {
      casts++
      await sleep(6000) // 7 cells of spread = ~2 s; lava turns the moment the water is over / beside it
    }
    const dry = await scoopAt(bot, F)
    for (let i = 0; i < 30 && [S, F, A1].some(waterAt); i++) await sleep(500)
    for (const c of sv.cells) if (!c.src && c.y === y - 1) access.add(c.x + ',' + c.z)
    if (dam) { await digCell(bot, B, { noPlug: true }); await sweep(bot, 1200, 2.5) }
    const n = sv.cells.filter(c => (blk(bot, c.x, c.y, c.z) || {}).name === 'obsidian').length; cast += n
    say(bot, { ev: 'obsidian_cast', at: [F.x, y, F.z], n, lava: sv.src, shallow: sv.shallow, level: M.level, branch: br.key, poured, waterBack: dry && U.count(bot, 'water_bucket') > 0 })
    if (!poured) return done('retry', { why: 'pour failed (aim / no water placed)' })
    if (!dry) return done('retry', { why: 'the water source is still at ' + [F.x, y, F.z].join(',') })
    if (!n) return done('retry', { why: 'cast made no obsidian' })
  }
  return done('open', { why: 'rounds' })
}

// ------------------------------------------------------------------ surface legs: the army's READ-ONLY travel (world 1 used a digging pathfinder here)
async function toEntrance (bot, M, gen) {
  const route = routeDown(M.G, M.level)
  // AT the entrance = near the route AND on a graph cell: gotoBranchFace starts from locate(). 09-19 23:47Z Aoi stood one block beside the mouth
  // (-331 for -330): "at the entrance" here, `off_line` there - it skipped all 80 branches in turn and hung at the mine head.
  const onIt = () => nearestWp(bot, route, 3) >= 0 && !!locate(M.G, feet(bot))
  if (onIt()) return true
  if (underground(bot, M)) return false // underground there is only the graph: the caller goes through toSurface
  const m = route[0].p
  if (nearestWp(bot, route, 3) < 0) await army().travel(bot, { x: m[0], y: m[1], z: m[2] }, { range: 1, ms: 180000, stop: () => stale(bot, gen) })
  if (!onIt()) await stepTo(bot, m[0], m[2], { ms: 4000, gen, tol: 0.4 })
  return onIt()
}

module.exports = {
  FILE, DIRS, LEVEL_Y, LANDING_EVERY, SPACING, FIRST_OFF, BRANCH_LEN, MAX_BRANCH, K_MAX, STAIR_TORCH, ORE_RE, JUNK_RE, FILL,
  // geometry (pure)
  normEntrance, stairCells, routeDown, routeUp, trunkCell, branchOff, branchCell, branchDir, locate, onGraph, planUp, mineBox, inBox, isWalk, isRepairable,
  // the mine of this job + its cache
  mine, refresh, read, update, lvState, underground, hb, bump, ledger, stale,
  blk, isLiquid, isSolid, isOpen, feet, eyeDist, fillItem, placeAt, plug,
  pickaxes, durLeft, bestPick, stonePickCount, cobbleCount, woodUnits, canCraftPick, withTable, ensurePick, ensureTorches,
  digCell, openCell, sealSides, torchNear, stepTo, settle, walkLine, pillarOne, blocked, sweep, returnTo,
  auditStairs, repairStairs, walkRoute, nearestWp, treadState, layTreads, stairItem, STAIR_RE, isSupport, supportChain, placeSupported,
  exposedOre, veinOf, mineVein, threat, defend, wallOff, eat, tossJunk,
  claimStairs, digStairs, claimBranch, branchOutlook, exhausted, levelCap, commute, nextLanding, claimGrowth, sayMine, pickRank, stoneWanted, saveBranch, gotoBranchFace, mineBranch, walkTrunk,
  rawIron, lootScore, needHaul, foodUnits, pickUses, readiness, exitReason, reconnect, toSurface, toEntrance,
  // lava on record + the obsidian trip
  cur: () => CUR, markHazard, branchAt, isHot, hotAhead, clearHot,
  noteLava, lavaAhead, obsidianOutlook, claimObsidianSpot, saveSpot, diamondPick, obsidianReady, lakeSurvey, pourAt, scoopAt, mineSheet, obsidianAt
}
