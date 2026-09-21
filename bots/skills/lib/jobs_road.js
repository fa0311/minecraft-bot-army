// jobs_road.js — THE ROAD NETWORK (owner 09-21 「幹線道路という仕組みを強化し、地上や他のディメンションでも応用できるようにする、何度も通るであろう道は
// 先に整備し、botが安定して拠点や行き先に移動できるようにする、skyeyeでの緻密な設計が必要」).
//
// EXTENSION MODULE (see the end of army_jobs.js): ONE job type, `road`. A road is designed by ops/road-plan.js FROM THE CAMERA and
// arrives here as a list of straight SEGMENTS, each at ONE height. Any number of bots may join: a bot claims the nearest unbuilt
// segment, builds it, READS IT BACK out of the world, marks it `built` on the board and takes the next. Nothing here drives a
// single bot by hand, and nothing here decides where a road goes — that is the camera's job.
//
// WHY THIS IS THE HIGHEST-LEVERAGE BUILD THE ARMY HAS (all measured): the village trade route is 624 blocks each way and 5 of every
// 6 trip-minutes are walking (docs/INDUSTRY.md); the mine commute is minutes per shift; the `no_route` storms came from terrain
// nobody prepared (366 in 30 min from ONE 3-deep pit); two bots died walking the open Nether. A road is built once and walked ten
// thousand times — CLAUDE.md rule 0, "optimise for everyone's next 1000 trips".
//
// THE STANDARD (docs/ROADS.md): 5 wide for a trunk, 3 for a spur · ONE height per segment, no step over 1 · paving = COBBLESTONE
// (the owner's material rule, docs/WORLD.md "paths = cobblestone": the depot holds thousands and the mine banks more every shift,
// it reads grey against grass AND against netherrack, and the base lattice is already cobble so a junction never changes material;
// cobbled_deepslate stays what it is — hidden sub-base, via `mats`) · torches every 8 on both shoulders (the road blueprint) · a
// FENCE RAIL wherever the drop beside the paving is >= 3, MEASURED in the world · a gap crossed by `lib/moves.js bridgeTo` span by
// span (<= 6 cells, widened and railed before the next span) · in the Nether the rail is a 2-high WALL and the deck is ROOFED
// where the sky over it is open, because that is exactly where a ghast has line of sight.
//
// PARAMS (written by ops/road-plan.js, never by hand):
//   road:'<id>' · dim:'overworld'|'the_nether' · width:5 · block:'stone' (the cobblestone family) · from/to:[x,y,z] · spur:bool
//   segments:[{ i, kind:'road'|'bridge'|'spur', origin:[x,y,z], to:[x,y,z], len, args:{toX,toZ,width,block,clear,torchEvery,shoulder},
//               built:false, rails:[[x,y,z]…] }]
// EVENTS: road_seg_start · road_seg_built · road_rails · road_roof · road_span · road_span_failed · road_done · road_damaged · road_blocked
// BOARD: settings.roads = [{id, job, from, to, dim, width, cells, built, checked}] — the network. It is bookkeeping AND the map the
//        pathfinder prices every step against (roadCost below).
//
// THE SPUR (owner 09-21 「幹線道路以外から幹線道路への行き方は穴を掘ったり、ブロックを置いたりしても良いのでは？」): reaching the network is
// CONSTRUCTION, not travel. A segment of kind 'spur' is the last <= 32 blocks from a work site to the nearest trunk road and it MAY
// cut a step, fill a dip or lay a ramp. It is planned, registered, repairable and audited like every other segment — never a private
// shortcut a bot digs on its own initiative (CLAUDE.md rule 4) — and while a builder works one it holds the terrain guard's opt-out
// WITH a reason and a time box (lib/terrain_guard.js allowTerrainEdit, the same door lib/moves.js bridgeTo uses), revoked in `finally`.
//
// WHAT THIS FILE MUST NOT DO: no cheats, no new state file (segment state lives on the board, claims in asset_audit.json like the
// herd's pen visit), no new daemon. It never edits army.js / army_jobs.js / moves.js — it calls them.
const { Vec3 } = require('vec3')
const swallow = require('./swallow')

// ================================================================ THE PRICE OF BEING OFF THE ROAD
// The owner's second order of 09-21:「空が見えているか、ディメンションがどこか、によって重み付けする必要はありそう」. Walking a built road is
// free; every block off it costs extra, and the extra depends on WHERE "off it" is. mineflayer-pathfinder's `exclusionAreasStep` is
// a list of (block) => NUMBER summed into the move cost (movements.js `exclusionStep`) — a weighting, never a veto: a bot with no
// road near it walks exactly as it always did, only a little "uphill" in the A*.
//
// THE TABLE (per BODY CELL; `getMoveForward` prices two — the feet cell and the head cell — so the effective penalty per block
// walked is twice the number below), and the measurement behind each one:
//   on a road cell                   0      paved, flat, lit, 3 lanes wide, no jump: the fastest ground the army owns
//   off-road, overworld, open sky    0.3    -> 0.6/block. A bot on real stair TREADS walks 3.9 steps/s, on broken ground 2.5
//                                           (docs/DEV.md §7, the mine stairwell measurement): 3.9/2.5 = 1.56, so an off-road block
//                                           is worth ~1.6 road blocks and a detour of up to ~60 % onto pavement is a win.
//   off-road, underground / roofed   1.25   -> 2.5/block. Underground movement is GRAPH-ONLY doctrine (docs/DEV.md §7): off the
//                                           graph is where the `no_route` storms, the falls and the 12-hour rescues happen.
//   off-road, the Nether             2.0    -> 4.0/block. Two bots died walking the open Nether on 09-20; one of those deaths cost
//                                           26 iron + 9 diamond (docs/NETHER.md) and nothing of ours fetches a kit back from
//                                           another dimension. 4x is still cheaper than one funeral per hundred trips.
// The MODE is read once per trip (dimension + terrain_guard.modeOf), never per A* node: an exclusion function that reads the world
// would be called a hundred thousand times per path.
const OFF = { surface: 0.3, underground: 1.25, nether: 2.0 }
const A_ = () => require('./army')
let _net = { t: 0, cells: new Map() }
// "x,z" -> paving y, for every BUILT segment of every road in settings.roads. 60 s cache per process (5 bots share one).
function roadCells () {
  if (Date.now() - _net.t < 60000) return _net.cells
  const m = new Map()
  try {
    const A = A_(); const board = A.readJSON(A.F.board, {}) || {}
    const jobs = new Map((board.jobs || []).map(j => [j.id, j]))
    for (const r of ((board.settings || {}).roads) || []) {
      const j = r && jobs.get(r.job || r.id); const P = j && j.params
      if (!P || !Array.isArray(P.segments)) continue
      for (const s of P.segments) {
        if (!s || !s.built || !Array.isArray(s.origin) || !Array.isArray(s.to)) continue
        const w = (s.args || {}).width || s.width || P.width || 5; const half = Math.floor(w / 2)
        const [x1, y, z1] = s.origin; const [x2, , z2] = s.to
        const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1)) || 1; const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1)
        for (let i = 0; i <= n; i++) {
          const cx = Math.round(x1 + (x2 - x1) * i / n); const cz = Math.round(z1 + (z2 - z1) * i / n)
          for (let a = -half; a <= half; a++) m.set((alongX ? cx : cx + a) + ',' + (alongX ? cz + a : cz), y)
        }
      }
    }
  } catch (e_) { swallow('jobs_road:roadCells', e_) }
  _net = { t: Date.now(), cells: m }
  return m
}
// THE HOOK army.js asks for: ONE line in `strictMovements`, just before `bot.pathfinder.setMovements(mv)`:
//     try { require('./jobs_road').roadCost(bot, mv) } catch (e_) { swallow('army:roadCost', e_) }
// With no road built it is a no-op, so it is safe to install before the first road stands.
function roadCost (bot, mv) {
  try {
    if (!mv || !Array.isArray(mv.exclusionAreasStep)) return false
    mv.exclusionAreasStep = mv.exclusionAreasStep.filter(f => !f.__road) // a re-install must never stack penalties
    const cells = roadCells(); if (!cells.size) return false
    const dim = String((bot.game && bot.game.dimension) || 'overworld')
    let mode = 'surface'
    if (!/overworld/.test(dim)) mode = 'nether'
    else { try { const g = require('./terrain_guard'); if (g.modeOf(bot) === 'underground') mode = 'underground' } catch (e_) { swallow('jobs_road:mode', e_) } }
    const off = OFF[mode] || OFF.surface
    const f = block => {
      if (!block || !block.position) return off
      const y = cells.get(block.position.x + ',' + block.position.z)
      // the paving is at y; a walking body occupies y+1 (feet) and y+2 (head), and both are priced
      return y == null || block.position.y < y || block.position.y > y + 2 ? off : 0
    }
    f.__road = true
    mv.exclusionAreasStep.push(f)
    bot.__roadCost = { mode, off, cells: cells.size }
    return true
  } catch (e_) { swallow('jobs_road:roadCost', e_); return false }
}

module.exports = ctx => {
  const { A, U, muster, task } = ctx
  const path = require('path')
  const v = p => new Vec3(p[0], p[1], p[2])
  const BL = () => require('./blocks') // required per call: the worker drops the whole lib cache on any edit
  const MV = () => require('./moves')
  const TG = () => { try { return require('./terrain_guard') } catch (e_) { swallow('jobs_road:tg', e_); return null } }
  // the RAW build handler, not the wrapped one: a segment is not a new job, so it must not re-run the slice handover
  // (bedtime / canteen / pocket banking / `<id>: starting`) fifty times down a 600-block road.
  const rawBuild = () => { const m = require('./army_jobs'); return (m._internals && m._internals.raw && m._internals.raw.build) || m.build }
  const solid = b => !!b && b.boundingBox === 'block'
  const STONE = ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'blackstone', 'netherrack']
  const FENCE = ['oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence', 'acacia_fence', 'dark_oak_fence', 'mangrove_fence', 'cherry_fence', 'pale_oak_fence', 'bamboo_fence', 'crimson_fence', 'warped_fence', 'cobblestone_wall', 'cobbled_deepslate_wall', 'nether_brick_fence']

  // ---------------------------------------------------------------- board bookkeeping (no new state file)
  const boardJob = id => { try { return (((A.readJSON(A.F.board, {}) || {}).jobs) || []).find(j => j.id === id) || null } catch (e_) { swallow('jobs_road:boardJob', e_); return null } }
  function segEdit (jobId, i, patch) { // ONE locked edit: several builders finish segments in the same second
    return A.boardEdit(b => {
      const j = (b.jobs || []).find(q => q.id === jobId); if (!j || !j.params || !Array.isArray(j.params.segments)) return
      const P = j.params; const s = P.segments[i]
      if (s && patch) Object.assign(s, patch)
      // settings.roads is the network: what every bot's pathfinder prices its steps against (roadCost). Geometry is NOT copied here
      // - it stays in the job's own params, and roadCells() follows `job` - so the board never holds the same road twice.
      const S = b.settings = b.settings || {}; const list = S.roads = Array.isArray(S.roads) ? S.roads : []
      const e = { id: P.road || j.id, job: j.id, dim: P.dim || 'overworld', from: P.from, to: P.to, width: P.width || 5, spur: !!P.spur, cells: P.segments.reduce((n, q) => n + (q.len || 0), 0), built: P.segments.filter(q => q.built).length + '/' + P.segments.length, checked: Date.now() }
      const k = list.findIndex(q => q && q.id === e.id)
      if (k >= 0) list[k] = e; else list.push(e)
    })
  }
  const AF = () => path.join(A.DIR, 'asset_audit.json')
  function take (bot, jobId, i) { // per-SEGMENT ownership - the same file claim the herd uses for a pen visit
    try {
      const f = AF(); const k = jobId + ':seg' + i; const au = A.readJSON(f, {}) || {}; const c = au[k]
      if (c && c.by !== bot.username && Date.now() - (c.t || 0) < 900000) return false
      au[k] = { by: bot.username, t: Date.now() }; A.writeJSON(f, au); return true
    } catch (e_) { swallow('jobs_road:take', e_); return true }
  }
  function drop (bot, jobId, i) { try { const f = AF(); const k = jobId + ':seg' + i; const au = A.readJSON(f, {}) || {}; if (au[k] && au[k].by === bot.username) { delete au[k]; A.writeJSON(f, au) } } catch (e_) { swallow('jobs_road:drop', e_) } }

  // ---------------------------------------------------------------- the geometry of a segment (ONE description, used by build,
  // by the rail pass and by the audit alike: the `road` blueprint for a paved run, the deck line for a bridge)
  const argsOf = (P, s) => s.args || { toX: s.to[0], toZ: s.to[2], width: P.width || 5, block: P.block || 'stone', clear: 3, torchEvery: 8, shoulder: P.spur ? 1 : 2 }
  const widthOf = (P, s) => (s.args || {}).width || s.width || P.width || 5
  function deckCells (s, width) {
    const out = []; const [x1, y, z1] = s.origin; const [x2, , z2] = s.to
    const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1)) || 1; const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1); const half = Math.floor(width / 2)
    for (let i = 0; i <= n; i++) {
      const cx = Math.round(x1 + (x2 - x1) * i / n); const cz = Math.round(z1 + (z2 - z1) * i / n)
      for (let a = -half; a <= half; a++) out.push({ x: alongX ? cx : cx + a, y, z: alongX ? cz + a : cz, rim: Math.abs(a) === half })
    }
    return out
  }
  // WHAT IS MISSING, AS THE WORLD READS IT NOW. The same question `auditStructures` asks of a hall - a road is a structure that
  // happens to be 600 blocks long. `seen` counts the cells whose chunk is loaded for this bot, so a judgement is never made blind.
  function segState (bot, P, s) {
    const wrong = []; let seen = 0; let total = 0
    if (s.kind === 'bridge') {
      for (const c of deckCells(s, widthOf(P, s))) { total++; const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!b) continue; seen++; if (!solid(b)) wrong.push(c.x + ',' + c.y + ',' + c.z + '=' + b.name) }
    } else {
      let cells = []
      try { cells = A.blueprintCellsOf({ blueprint: 'road', origin: s.origin, args: argsOf(P, s), pad: false }) } catch (e_) { swallow('jobs_road:cells', e_) }
      for (const c of cells) {
        if (c.block === 'air' || c.fillOnly || /torch/.test(c.block)) continue
        total++; const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!b) continue
        seen++
        if (!(b.name === c.block || (Array.isArray(c.mats) && c.mats.includes(b.name)))) wrong.push(c.x + ',' + c.y + ',' + c.z + '=' + b.name)
      }
    }
    for (const r of s.rails || []) { total++; const b = bot.blockAt(v(r)); if (!b) continue; seen++; if (!solid(b)) wrong.push(r.join(',') + '=' + b.name) }
    return { wrong, seen, total }
  }

  // ---------------------------------------------------------------- RAILS (and, in the Nether, the WALL and the ROOF)
  // A blueprint has no world access, so it cannot know whether the drop beside the paving is 3 blocks or 30. The builder LOOKS:
  // for every cell of the outer paving row, how far down is the first solid block one step further out? >= 3 -> a fence post on
  // that cell. Every cell that ends up standing is written back to the board, so the audit can tell a stolen rail from a rail
  // that was never needed. In the Nether the rail is 2 high (a ghast fires straight through a kerb) and the deck is roofed
  // wherever the ceiling over it is more than 5 blocks away - that is exactly the line of sight a ghast uses.
  async function railPass (bot, job, P, s, api, opt = {}) {
    const nether = /nether/.test(String(P.dim || 'overworld'))
    const width = widthOf(P, s); const half = Math.floor(width / 2)
    const [x1, y, z1] = s.origin; const [x2, , z2] = s.to
    const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1)) || 1; const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1)
    const want = []; const roof = []
    for (let i = 0; i <= n; i++) {
      const cx = Math.round(x1 + (x2 - x1) * i / n); const cz = Math.round(z1 + (z2 - z1) * i / n)
      for (const side of [-1, 1]) {
        const ox = alongX ? cx : cx + side * half; const oz = alongX ? cz + side * half : cz // outer paving cell
        const bx = alongX ? ox : ox + side; const bz = alongX ? oz + side : oz // one step further out
        let drop = 0; let known = false
        for (let dy = 0; dy <= 6; dy++) { const b = bot.blockAt(new Vec3(bx, y - dy, bz)); if (!b) { drop = -1; break } if (solid(b)) { drop = dy; known = true; break } drop = dy + 1 }
        if (drop < 0) continue // unloaded: judged another time, never guessed
        if (!known) drop = 7 // nothing solid within 6 = a void beside the road
        if (drop < 3) continue
        want.push([ox, y + 1, oz])
        if (nether) want.push([ox, y + 2, oz])
      }
      if (nether && opt.roof !== false) {
        for (let a = -half; a <= half; a++) {
          const rx = alongX ? cx : cx + a; const rz = alongX ? cz + a : cz
          let open = 0; for (let dy = 3; dy <= 8; dy++) { const b = bot.blockAt(new Vec3(rx, y + dy, rz)); if (!b) { open = -1; break } if (solid(b)) break; open = dy }
          if (open >= 8) roof.push([rx, y + 4, rz]) // the sky over the deck is open for 5+ cells: a ghast can see the crew
        }
      }
    }
    let placed = 0
    if (want.length) {
      const item = FENCE.find(k => A.count(bot, k) > 0) || FENCE.find(k => A.stockOf(k) > 0)
      if (!item) A.result(bot, { ev: 'road_blocked', job: job.id, seg: s.i, why: 'the drop beside ' + want.length + ' cells of this segment is 3+ and neither pockets nor depot hold a fence or wall (' + FENCE.slice(0, 3).join('/') + ')' })
      else {
        if (A.count(bot, item) < Math.min(32, want.length)) await A.obtain(bot, item, Math.min(64, want.length), { stop: api.stop }).catch(e_ => swallow('jobs_road:railGet', e_))
        const todo = want.filter(q => { const b = bot.blockAt(v(q)); return b && !solid(b) })
        if (todo.length) {
          task(bot, 'road: railing ' + todo.length + ' cells of segment ' + s.i)
          const r = await BL().buildCells(bot, todo.map(q => ({ pos: v(q), name: item })), { place: { stop: api.stop } }).catch(e => { swallow('jobs_road:railBuild', e); return { placed: 0 } })
          placed += r.placed || 0
        }
        const stood = want.filter(q => solid(bot.blockAt(v(q))))
        A.result(bot, { ev: 'road_rails', job: job.id, seg: s.i, kind: nether ? 'wall' : 'rail', placed, standing: stood.length, of: want.length, item })
        segEdit(job.id, s.i, { rails: stood })
      }
    }
    if (roof.length) {
      const stone = STONE.filter(k => A.count(bot, k) > 0)[0] || STONE.find(k => A.stockOf(k) > 0)
      if (stone) {
        if (A.count(bot, stone) < Math.min(32, roof.length)) await A.obtain(bot, stone, Math.min(128, roof.length), { stop: api.stop }).catch(e_ => swallow('jobs_road:roofGet', e_))
        const todo = roof.filter(q => { const b = bot.blockAt(v(q)); return b && !solid(b) })
        task(bot, 'road: roofing ' + todo.length + ' cells of segment ' + s.i + ' (ghast line of sight)')
        const r = await BL().buildCells(bot, todo.map(q => ({ pos: v(q), name: stone })), { place: { stop: api.stop } }).catch(e => { swallow('jobs_road:roofBuild', e); return { placed: 0 } })
        A.result(bot, { ev: 'road_roof', job: job.id, seg: s.i, placed: r.placed || 0, of: roof.length, why: 'the sky over the deck was open: a ghast has line of sight on the crew' })
      }
    }
    return { placed, want: want.length, roof: roof.length }
  }

  // ---------------------------------------------------------------- a BRIDGE segment: spans of <= 6, widened and railed before the next
  // `moves.bridgeTo` is the proven technique (pathfinder scaffolding inside a corridor + sneak asserted every tick + its own
  // time-boxed terrain-guard opt-out, the far end re-read before it claims ok). The job's part is: carry the stone, stand on the
  // head of what already stands, take <= 6 cells, widen the spine to the road's width FROM the safe spine, rail it, then step on.
  async function bridgeSeg (bot, job, P, s, api) {
    const width = widthOf(P, s); const half = Math.floor(width / 2)
    const [x1, y, z1] = s.origin; const [x2, , z2] = s.to
    const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1)) || 1; const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1)
    const spine = i => { const cx = Math.round(x1 + (x2 - x1) * i / n); const cz = Math.round(z1 + (z2 - z1) * i / n); return [cx, y, cz] }
    const stoneItem = () => STONE.filter(k => A.count(bot, k) > 0).sort((a, b) => A.count(bot, b) - A.count(bot, a))[0] || null
    const carried = () => STONE.reduce((q, k) => q + A.count(bot, k), 0)
    const need = Math.min(256, (n + 1) * width + 16)
    if (carried() < need) {
      const have = STONE.filter(k => A.stockOf(k) > 0).sort((a, b) => A.stockOf(b) - A.stockOf(a))[0]
      if (!have) { A.result(bot, { ev: 'road_blocked', job: job.id, seg: s.i, why: 'a bridge of ' + (n + 1) + ' cells needs ~' + need + ' stone and the depot holds none' }); A.decline(bot, job, 600000, 'road: no stone for the bridge'); return 'road: no stone for the bridge' }
      task(bot, 'road: fetching ' + need + ' ' + have + ' for the bridge')
      await A.obtain(bot, have, need, { stop: api.stop }).catch(e_ => swallow('jobs_road:bridgeStone', e_))
    }
    let head = 0
    while (head < n && solid(bot.blockAt(v(spine(head + 1))))) head++ // a re-run CONTINUES the same bridge, it never starts it again
    let spans = 0
    while (head < n && !api.stop() && carried() > width * 8) {
      const step = Math.min(6, n - head) // the proven span of moves.bridgeTo
      const from = spine(head); const to = spine(head + step)
      task(bot, 'road: bridging ' + from.join(',') + ' -> ' + to.join(',') + ' (' + head + '/' + n + ')')
      if (!await A.travel(bot, { x: from[0], y: from[1] + 1, z: from[2] }, { range: 1, ms: 90000, stop: api.stop, quiet: true })) { A.result(bot, { ev: 'road_span_failed', job: job.id, seg: s.i, at: from, why: 'cannot stand on the head of the deck' }); break }
      const r = await MV().bridgeTo(bot, [to[0], to[1] + 1, to[2]], { blocks: STONE.filter(k => A.count(bot, k) > 0), half, ms: 120000, stop: api.stop })
      A.result(bot, { ev: r.ok ? 'road_span' : 'road_span_failed', job: job.id, seg: s.i, from, to, placed: r.placed, ms: r.tookMs, why: r.why })
      if (!r.ok) break
      spans++
      // WIDEN AND RAIL FROM THE SPINE, BEFORE THE NEXT SPAN (docs/NETHER.md, paid for with one death): a rail over the void has
      // nothing to be placed against once the crew has walked past it.
      const side = []
      for (let i = head; i <= head + step; i++) { const c = spine(i); for (let a = -half; a <= half; a++) { if (!a) continue; const q = new Vec3(alongX ? c[0] : c[0] + a, y, alongX ? c[2] + a : c[2]); if (!solid(bot.blockAt(q))) side.push({ pos: q, name: stoneItem() || 'cobblestone' }) } }
      if (side.length) await BL().buildCells(bot, side, { place: { stop: api.stop } }).catch(e_ => swallow('jobs_road:widen', e_))
      await railPass(bot, job, P, Object.assign({}, s, { origin: spine(head), to: spine(head + step) }), api, { roof: false }).catch(e_ => swallow('jobs_road:bridgeRail', e_))
      head += step
    }
    return 'road: bridge ' + head + '/' + n + ' cells (' + spans + ' spans this slice)'
  }

  // ---------------------------------------------------------------- the handler
  async function road (bot, job, api, ctx2) {
    const P = job.params || {}
    if (!Array.isArray(P.segments) || !P.segments.length) return muster(bot, job, api, ctx2, 'road: params.segments is empty - design it with `node ops/road-plan.js <fromX,fromZ> <toX,toZ>` and READ the picture first')
    const dim = String(P.dim || 'overworld')
    const here = String((bot.game && bot.game.dimension) || 'overworld')
    if (!here.includes(dim.replace('minecraft:', '')) && !(dim === 'overworld' && /overworld/.test(here))) return muster(bot, job, api, ctx2, 'road: this road is in ' + dim + ' and I am in ' + here + ' (a `portal` job takes bots across, not this one)')

    const live = boardJob(job.id) // the board's copy: mates mark segments built while my assignment sits in a file
    const cur = (live && live.params && Array.isArray(live.params.segments)) ? live.params.segments : P.segments
    const me = bot.entity.position
    const dist = s => Math.min(Math.hypot(s.origin[0] - me.x, s.origin[2] - me.z), Math.hypot(s.to[0] - me.x, s.to[2] - me.z))

    // ---- every segment built? the job is a build order, not a standing post: it reads the nearest one back, then pauses itself
    const left = cur.filter(s => !s.built)
    if (!left.length) {
      const near = cur.slice().sort((a, b) => dist(a) - dist(b))[0]
      const st = near ? segState(bot, P, near) : { wrong: [], seen: 1, total: 1 }
      if (st.seen >= st.total * 0.8 && st.wrong.length >= Math.max(4, Math.ceil(st.total * 0.03))) {
        segEdit(job.id, near.i, { built: false })
        A.result(bot, { ev: 'road_damaged', job: job.id, road: P.road || job.id, seg: near.i, at: near.origin, cells: st.wrong.length, of: st.total, examples: st.wrong.slice(0, 4) })
        return 'road: segment ' + near.i + ' is damaged (' + st.wrong.length + '/' + st.total + ') - re-opened, the job repairs it'
      }
      segEdit(job.id, 0, null)
      A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: road complete - ' + cur.length + ' segments, ' + cur.reduce((n, s) => n + (s.len || 0), 0) + ' cells' } })
      A.result(bot, { ev: 'road_done', job: job.id, road: P.road || job.id, segments: cur.length, cells: cur.reduce((n, s) => n + (s.len || 0), 0) })
      return muster(bot, job, api, ctx2, 'road: complete')
    }

    // ---- the nearest unbuilt segment nobody is on (a claim older than 15 min falls free by itself)
    let s = null
    for (const q of left.slice().sort((a, b) => dist(a) - dist(b))) { if (take(bot, job.id, q.i)) { s = q; break } }
    if (!s) { A.decline(bot, job, 120000, 'road: every unbuilt segment is claimed by a mate'); return muster(bot, job, api, ctx2, 'road: all ' + left.length + ' open segments are claimed') }

    let opted = false
    try {
      if (dist(s) < 48) { // a mate may have finished it between my board read and my walk: that costs one look, not one trip
        const st0 = segState(bot, P, s)
        if (st0.seen >= st0.total * 0.8 && !st0.wrong.length) { segEdit(job.id, s.i, { built: true, at: Date.now() }); A.result(bot, { ev: 'road_seg_built', job: job.id, seg: s.i, kind: s.kind, cells: st0.total, by: 'already standing' }); return 'road: segment ' + s.i + ' already stands' }
      }
      A.result(bot, { ev: 'road_seg_start', job: job.id, road: P.road || job.id, seg: s.i, kind: s.kind, at: s.origin, to: s.to, len: s.len, left: left.length })

      // THE SPUR'S NAMED OPT-OUT (owner 09-21): reaching the network is construction, so the pathfinder may cut a step or lay a
      // ramp here - with a REASON, a time box, and revoked in `finally`. Nowhere else in this file.
      if (s.kind === 'spur') {
        const g = TG()
        if (g) { g.allowTerrainEdit(bot, 'road spur ' + (P.road || job.id) + ' seg' + s.i + ' ' + s.origin.join(',') + ' -> ' + s.to.join(',') + ' (planned, <= 32 blocks, registered in settings.roads)', 13 * 60000); opted = true; try { if (bot.__tg) bot.__tg.mode = g.modeOf(bot) } catch (e_) { swallow('jobs_road:tgMode', e_) } }
      }

      if (s.kind === 'bridge') {
        const r = await bridgeSeg(bot, job, P, s, api)
        const st = segState(bot, P, s)
        if (st.seen >= st.total * 0.8 && !st.wrong.length) { segEdit(job.id, s.i, { built: true, at: Date.now() }); A.result(bot, { ev: 'road_seg_built', job: job.id, seg: s.i, kind: 'bridge', cells: st.total }) }
        return r
      }

      // A ROAD SEGMENT *IS* A `road` BLUEPRINT: the build handler already lays a sub-base from the natural ground up, cuts the
      // headroom, terraces the shoulders, sets the torches and never decks a hole. One implementation, not two (CLAUDE.md rule 5).
      // The inner job carries a SYNTHETIC id (`<road>#<seg>`) that is not on the board, so every board edit build makes - pause,
      // cap, void-fix, stuckBy - finds no job and is a no-op: the road job alone owns the board.
      const inner = { id: job.id + '#' + s.i, type: 'build', rev: job.rev || 0, priority: job.priority, front: job.front, site: [s.origin[0], s.origin[1] + 1, s.origin[2]], plan: job.plan, params: { blueprint: 'road', origin: s.origin, args: argsOf(P, s), pad: false, order: 'near', walkRadius: 20 } }
      const r = await rawBuild()(bot, inner, api, ctx2)
      const st = segState(bot, P, s)
      if (st.seen >= st.total * 0.8 && st.wrong.length <= Math.floor(st.total * 0.01)) {
        await railPass(bot, job, P, s, api).catch(e_ => swallow('jobs_road:rail', e_))
        segEdit(job.id, s.i, { built: true, at: Date.now() })
        A.result(bot, { ev: 'road_seg_built', job: job.id, road: P.road || job.id, seg: s.i, kind: s.kind, cells: st.total, left: left.length - 1 })
        return 'road: segment ' + s.i + ' built (' + st.total + ' cells, ' + (left.length - 1) + ' segments left)'
      }
      return typeof r === 'string' ? r : 'road: segment ' + s.i + ' (' + st.wrong.length + '/' + st.total + ' cells still open)'
    } finally {
      if (opted) { const g = TG(); if (g) { g.revokeTerrainEdit(bot); try { if (bot.__tg) bot.__tg.mode = g.modeOf(bot) } catch (e_) { swallow('jobs_road:tgMode2', e_) } } }
      drop(bot, job.id, s.i)
    }
  }

  return { types: { road }, verbs: {} }
}
module.exports.TYPES = ['road']
module.exports.VERBS = []
module.exports.roadCost = roadCost // army.js strictMovements hook
module.exports.roadCells = roadCells // ops/ and probes: what the army has actually paved
module.exports.OFF = OFF
