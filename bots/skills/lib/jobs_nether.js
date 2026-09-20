// jobs_nether.js — P5 NETHER, stage 1: the army LIGHTS its gate, walks through, makes the far side safe and comes back.
// EXTENSION MODULE (see the end of army_jobs.js): one job type, `portal`. Nothing here drives a single bot by hand — it is an
// ordinary board job with ordinary primitives (A.travel, A.obtain, A.placeHard, blocks.js), and every report states what was
// READ BACK FROM THE WORLD, never what was intended (lesson 3 of world 1).
//
// THE JOB (type `portal`, params):
//   origin:[x,y,z]   the origin of the `nether_portal` BUILD job (the gate's geometry comes from that blueprint's geom(), so the
//                    lighting can never drift from what stands in the world)   args:{axis}   blueprint:'nether_portal'
//   buildJob:'<id>'  the build job that owns the frame — re-activated (= the repair) when a frame cell is missing
//   go:true          ONE pinned bot (job.names length 1) crosses: 128 blocks of ANY stone + food + sword, walks in, waits for the
//                    dimension change, looks, walks back. Bump `rev` to send another expedition (settings.nether.scoutRev
//                    remembers which rev already went).
//   landing          make the arrival safe: seal the lava faces in reach, then a 5x5 floor + walls 2 high + a door gap + torches,
//                    STRICTLY without walking (arm's reach from where the gate put the bot). `false` switches it off.
//   return:true      THE RETURN JOB (`dim:"the_nether"`, its id in `settings.nether.returnJob`): the one job a bot that is in the
//                    Nether with nothing to do there may hold. No origin needed; a no-op in the overworld.
//   close:true       put the gate OUT and stop (no crossing): one frame obsidian out with a diamond pickaxe, the six inner cells
//                    read back as air, the obsidian straight back in. `closeGate:false` keeps a gate burning between trips.
//                    A lit gate spawns zombified piglins in the OVERWORLD outside the mob cap - that is TPS the owner pays for.
//   maxDeaths:6      deaths IN THE LAST 30 MIN (settings.nether.deathLog) before the job pauses itself. Death is an accepted cost
//                    of exploring the Nether; a squad wiped in a quarter of an hour is not.
//   work:'stair'     THE WAY DOWN from a hub doorway to `toY` (blueprint nether_stair): a 2-wide, 3-high, roofed, lit corridor,
//                    cut through rock and built of carried stone over void. Writes settings.nether.stair / floorHub.
//   work:'fortress'  4 squads, one per bearing (+x/-x/+z/-z by roster index, or params.bearing), `range` blocks out in `step`
//                    legs, `nether_scout` every leg, a <=4-cell BRIDGE where the read-only pathfinder finds no way, and the first
//                    nether brick pulls everybody to `settings.nether.sightings`.
//   work             STAGE 2, one round trip per slice: 'landing' (finish the 5x5 until it reads safe) · 'hub' (blueprint
//                    nether_hub: walled, roofed, lit room for 8 + chest + crafting table, registered under settings.nether ONLY)
//                    · 'road' (blueprint nether_road: 2-wide covered walkway on one bearing from the hub door) · 'scout'
//                    (walk the finished road, look 96 blocks, write sightings to settings.nether.sightings).
//   minutes:6 · at/from/bearing/length/door — where the work is; the road defaults to settings.nether.hub.outside + its bearing
//   cobble:128 (blocks of stone to carry, any sort) · crossS:90 (seconds to stand in the portal, both ways)
// EVENTS (all verified): portal_frame_incomplete · flint_knapped · portal_lit · portal_light_failed · portal_through · nether_sealed ·
//   nether_look · nether_landing · nether_unsafe · nether_pass · nether_scout · nether_sighting · portal_back · portal_out · nether_lost · portal_scout_died · portal_unsafe · portal_scout_missing
// BOARD: settings.nether = {gate:[x,y,z] overworld, lit, portal:[x,y,z] NETHER coords, hub, through, back, scoutRev, returnJob, deaths}
//
// WHAT THIS FILE MUST NOT DO: no cheats (no /give, /tp, no creative), no new state file, no new daemon. A bot that dies over
// there declines the job for 30 min, so one bad gate can never burn a bot in a loop.
const { Vec3 } = require('vec3')

module.exports = ctx => {
  const { A, U, muster, task, swallow } = ctx
  const sleep = A.sleep
  const path = require('path')
  const fs = require('fs')
  const v = p => Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z)
  const xyz = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  // blocks.js is required per call: army_worker drops the WHOLE lib cache on any edit, so this always resolves to the live copy
  const BL = () => require('./blocks')
  const isNether = bot => /nether/.test(String((bot.game && bot.game.dimension) || ''))
  const dimOf = bot => String((bot.game && bot.game.dimension) || 'unknown')
  // what may stand in a frame CORNER (vanilla leaves them empty; ours carry any stone sort, see the blueprint)
  const STONE_RE = /^(cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|tuff|deepslate|stone_bricks|blackstone|basalt|smooth_stone|netherrack)$/
  // THE SHELL IS BUILT FROM WHATEVER STONE WE HAVE, not from one name (11:53Z: the scout refused to cross with `cobblestone 0/32`
  // while the depot held 299 diorite — the ravine fill drains cobblestone faster than the mine banks it). Order = what a depot
  // usually has most of; `stoneItem` re-reads the pockets for every block placed, so a pile running out costs nothing.
  const SHELL_STONE = ['cobblestone', 'cobbled_deepslate', 'diorite', 'andesite', 'granite', 'stone', 'tuff', 'deepslate', 'blackstone', 'dirt']
  const stoneCarried = bot => SHELL_STONE.reduce((n, k) => n + A.count(bot, k), 0)
  const stoneItem = bot => SHELL_STONE.filter(k => A.count(bot, k) > 0).sort((a, b) => A.count(bot, b) - A.count(bot, a))[0] || null

  // ---------------------------------------------------------------- the gate's geometry comes from the BLUEPRINT, never from here
  let _bpM = 0
  function geomOf (P) {
    const name = String(P.blueprint || 'nether_portal').replace(/[^a-z0-9_]/gi, '')
    const f = require.resolve(path.join(A.DIR, '..', 'blueprints', name + '.js'))
    try { const m = fs.statSync(f).mtimeMs; if (_bpM !== m) { delete require.cache[f]; _bpM = m } } catch (e_) { swallow('jobs_nether:bpStat', e_) }
    const mod = require(f)
    if (typeof mod.geom !== 'function') throw new Error('blueprint ' + name + ' has no geom()')
    return mod.geom({ x: P.origin[0], y: P.origin[1], z: P.origin[2] }, P.args || {})
  }
  const netherEdit = patch => A.boardEdit(b => { const S = b.settings = b.settings || {}; S.nether = Object.assign({}, S.nether || {}, patch) })
  // READ THE BOARD, NOT THE 5-SECOND CACHE (measured 12:30:15Z: Kanade reported `portal_back` at 12:29:54 and crossed straight back
  // into the Nether — `A.settings()` caches for 5 s, so the `back` this very bot had just written was not there yet and the gate
  // sent it round again). `settings.nether` is read a handful of times per slice; a fresh read costs nothing.
  const netherOf = () => { try { return ((A.readJSON(A.F.board, {}) || {}).settings || {}).nether || {} } catch (e_) { swallow('jobs_nether:netherOf', e_); return A.settings().nether || {} } }

  // ---------------------------------------------------------------- reading the world back
  const frameGaps = (bot, G) => G.frame.filter(f => { const b = bot.blockAt(v(f.at)); return !b || (f.corner ? !STONE_RE.test(b.name) : b.name !== 'obsidian') })
  const litCells = (bot, cells) => cells.filter(q => { const b = bot.blockAt(v(q)); return !!b && b.name === 'nether_portal' })
  // the whole portal surface a `nether_portal` block belongs to (the far side's gate is 2x3 like ours, but the world may have built it wider)
  function portalBody (bot, from, r = 8) {
    const out = []; const seen = new Set(); const q = [from.clone ? from.clone() : v(from)]
    while (q.length && out.length < 48) {
      const p = q.pop(); const k = p.x + ',' + p.y + ',' + p.z
      if (seen.has(k) || p.distanceTo(from) > r) continue
      seen.add(k)
      const b = bot.blockAt(p); if (!b || b.name !== 'nether_portal') continue
      out.push(p)
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) q.push(p.offset(d[0], d[1], d[2]))
    }
    return out
  }

  // ---------------------------------------------------------------- flint: it comes OUT OF GRAVEL, not out of a recipe (10 % a block)
  async function knapGravel (bot, api) {
    const t0 = Date.now(); let broke = 0
    while (!A.count(bot, 'flint') && broke < 64 && Date.now() - t0 < 180000 && !api.stop()) {
      const nat = U.findBlocksByName(bot, ['gravel'], 40, 8)
      if (!nat.length) break
      task(bot, 'portal: knapping gravel for flint (' + broke + ' broken)')
      if (await U.mineAt(bot, nat[0], 30000).catch(() => false)) broke++
      await A.pickup(bot, 5, 2000)
    }
    if (broke) A.result(bot, { ev: 'flint_knapped', broke, flint: A.count(bot, 'flint') })
    return A.count(bot, 'flint') > 0
  }

  // ---------------------------------------------------------------- strike the gate
  // The fire goes on the TOP FACE of a bottom obsidian block, so it lands in the lowest inner cell. Every stand is tried from
  // both bottom cells; after each strike the SIX inner cells are read back — "lit" means six `nether_portal` blocks, nothing else.
  async function strike (bot, job, api, G) {
    let last = 'not struck'
    for (const ref of G.floor) {
      for (const s of G.stands) {
        if (api.stop()) return last
        if (litCells(bot, G.inner).length >= G.inner.length) return true
        if (!await A.travel(bot, v(s), { range: 0, ms: 45000, stop: api.stop, quiet: true })) { last = 'cannot stand at ' + s.join(','); continue }
        // a portal only forms in AIR: anything that blew/grew into the frame comes out first (never the portal blocks themselves)
        for (const q of G.inner) {
          const b = bot.blockAt(v(q)); if (!b || /^(air|cave_air|nether_portal|fire)$/.test(b.name)) continue
          await BL().digBlock(bot, v(q), { collect: true, requireHarvest: false }).catch(e_ => swallow('jobs_nether:clearInner', e_))
        }
        const rb = bot.blockAt(v(ref)); if (!rb || rb.name !== 'obsidian') { last = 'the bottom obsidian at ' + ref.join(',') + ' is ' + (rb ? rb.name : 'not loaded'); continue }
        const fs2 = bot.inventory.items().find(i => i.name === 'flint_and_steel'); if (!fs2) return 'the flint and steel left my pockets'
        try {
          await U.withTimeout(bot.equip(fs2, 'hand'), 5000, 'equipFlint')
          await U.withTimeout(bot.activateBlock(rb, new Vec3(0, 1, 0)), 8000, 'strike')
        } catch (e) { last = 'strike threw: ' + String(e && e.message).slice(0, 60); swallow('jobs_nether:strike', e); continue }
        for (let w = 0; w < 16 && litCells(bot, G.inner).length < G.inner.length; w++) await sleep(250)
        const n = litCells(bot, G.inner).length
        if (n >= G.inner.length) return true
        last = 'struck ' + ref.join(',') + ' from ' + s.join(',') + ': ' + n + '/' + G.inner.length + ' cells are nether_portal'
      }
    }
    return last
  }

  // ---------------------------------------------------------------- stand in the gate until the server moves us
  // The player delay is 80 ticks; the bot must STAY on the cell, so the goal is dropped and the position re-centred every 2 s.
  async function stepThrough (bot, api, cells, seconds, why) {
    const dim0 = dimOf(bot)
    const inGate = p => { const b = bot.blockAt(p); return !!b && b.name === 'nether_portal' }
    // A GATE ONLY TAKES SOMEBODY WHO WALKED INTO IT (measured 12:05-12:08Z: Koharu stood in the far gate at -38,98,-76 for 90 s and
    // stayed in the Nether). Minecraft RESETS the portal cooldown on every tick an entity is STILL inside the portal, so the bot
    // that the gate just spat out has to leave it and come back. One cell, to a cell verified standable — never a walkabout.
    const stepOut = async () => {
      if (!inGate(bot.entity.position.floored())) return true
      const BLL = BL(); const me = bot.entity.position.floored()
      const outs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(d => me.offset(d[0], 0, d[1])).filter(q => !inGate(q) && BLL.standable(bot, q))
      for (const q of outs) {
        task(bot, 'portal: stepping out of the gate so it takes me again')
        if (await A.travel(bot, q, { range: 0, ms: 15000, stop: api.stop, quiet: true, anyDepth: true })) { await sleep(2500); return true }
      }
      return false
    }
    const target = cells.map(q => v(q)).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    for (const c of target) {
      if (api.stop() || dimOf(bot) !== dim0) break
      await stepOut()
      task(bot, 'portal: ' + why)
      if (!await A.travel(bot, c, { range: 0, ms: 45000, stop: api.stop, quiet: true, anyDepth: true })) continue
      try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { swallow('jobs_nether:hold', e_) }
      const end = Date.now() + seconds * 1000
      while (Date.now() < end && !api.stop()) {
        if (dimOf(bot) !== dim0) return dimOf(bot)
        const p = bot.entity.position.floored()
        if (p.x !== c.x || p.z !== c.z || Math.abs(p.y - c.y) > 1) { if (!await A.travel(bot, c, { range: 0, ms: 15000, stop: api.stop, quiet: true, anyDepth: true })) break; try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { swallow('jobs_nether:hold2', e_) } }
        else { await BL().centreOn(bot, c).catch(e_ => swallow('jobs_nether:centre', e_)) }
        await sleep(1000)
      }
      if (dimOf(bot) !== dim0) return dimOf(bot)
    }
    return dimOf(bot) !== dim0 ? dimOf(bot) : null
  }

  // ---------------------------------------------------------------- building in the Nether: what a cell wants, and the ONE walk allowed
  // A cell is `{x,y,z,block}`; `stone` means any stone sort the squad carries (the depot's mix changes by the hour), `air` means
  // the cell must be clear. Satisfaction is always READ FROM THE WORLD, never from what we think we placed.
  // AN UNLOADED CELL IS NOT A FINISHED CELL (measured 13:06:55Z: the first road squad came home with `left:0` on a 64-block road
  // it had not laid a single block of — the far end was outside the bots' loaded chunks, `blockAt` gave null, and null read as
  // "already right"). Unloaded cells are counted on their own so a pass can never claim a road it cannot even see.
  const loadedAt = (bot, c) => !!bot.blockAt(v([c.x, c.y, c.z]))
  const cellOK = (bot, c) => {
    const b = bot.blockAt(v([c.x, c.y, c.z])); if (!b) return true // not loaded: skipped this pass, counted as `unloaded`, never as done
    if (c.block === 'stone') return b.boundingBox === 'block' && !/^(lava|water)$/.test(b.name)
    if (c.block === 'air') return b.boundingBox !== 'block'
    if (c.block === 'torch') return /torch/.test(b.name)
    if (c.block === 'fence_gate') return /_fence_gate$/.test(b.name)
    return b.name === c.block
  }
  // 'stone' = the biggest stone pile in the pockets; 'fence_gate' = whatever wood we carry one of (a plan never names a species)
  const itemFor = (bot, c) => c.block === 'stone' ? stoneItem(bot) : c.block === 'fence_gate' ? (bot.inventory.items().find(i => /_fence_gate$/.test(i.name)) || {}).name || null : c.block
  // A FLOOR CELL IS SAFE WHEN NOBODY CAN FALL THROUGH IT (measured 12:44-12:46Z: the last two cells of this landing, -38,97,-74 and
  // -35,97,-74, read `place: unreachable` from an adjacent stand with `noMove` — they are SEALED VOIDS one layer under the surface
  // the bot walks on, with solid netherrack at y98 over them. A pocket you cannot see, cannot reach and cannot fall into is not a
  // hole; calling it one kept a landing "unsafe" for ever and would have sent the gate to be relocated for nothing).
  // PLACING IN THE NETHER NEVER MOVES THE BOT. `A.placeHard` is the right primitive in the overworld — but its remedy loop is
  // OUTSIDE the `place:{noMove:true}` it forwards to blocks.js: on `noref` it walks a support column in, on `unreachable` it
  // repositions, on a high cell it pillars up and takes the scaffold away again. Measured 12:55:43Z: Kanade was building the hub
  // with steps:0 (she never took a safeStep of ours) and still "fell from a high place" — y98 to y33. So over there we call
  // blocks.js directly: one placement from where we stand, or nothing. -> ok when the block STANDS (read back).
  async function placeStill (bot, api, q, item) {
    try {
      const r = await BL().placeBlock(bot, q, item, { retries: 1, noMove: true }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      const b = bot.blockAt(q)
      return { ok: !!((r && r.ok) || (b && b.boundingBox === 'block')), reason: (r && r.reason) || '?' }
    } catch (e_) { swallow('jobs_nether:placeStill', e_); return { ok: false, reason: 'threw' } }
  }
  const floorSafe = (bot, c) => { const b = bot.blockAt(v([c.x, c.y, c.z])); if (b && b.boundingBox === 'block' && !/^(lava|water)$/.test(b.name)) return true; const up = bot.blockAt(v([c.x, c.y + 1, c.z])); return !!up && up.boundingBox === 'block' && !/^(lava|water)$/.test(up.name) }
  const hasRef = (bot, c) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(d => { const n = bot.blockAt(c.offset(d[0], d[1], d[2])); return !!n && n.boundingBox === 'block' })
  const eyeOf = bot => bot.entity.position.offset(0, 1.62, 0)
  // THE ONLY WALKING ALLOWED OVER THERE (both deaths of stage 1 were steps onto ground nobody had checked): one cell at a time,
  // inside a box this squad has floored itself, onto a cell that is standable, has a solid non-magma block under it, and has no
  // lava or fire within 2. Anything else and the bot stays where it is and reports what it could not reach.
  async function safeStep (bot, api, c, box) {
    try {
      if (!box || c.x < box[0] || c.x > box[2] || c.z < box[1] || c.z > box[3]) return false
      if (!BL().standable(bot, c)) return false
      const u = bot.blockAt(c.offset(0, -1, 0)); if (!u || u.boundingBox !== 'block' || /lava|magma/.test(u.name)) return false
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) { const b = bot.blockAt(c.offset(dx, dy, dz)); if (b && /^(lava|fire)$/.test(b.name)) return false }
      return !!await nTravel(bot, c, { range: 0, ms: 12000, stop: api.stop })
    } catch (e_) { swallow('jobs_nether:safeStep', e_); return false }
  }
  // Place/clear a list of cells from where the bot stands; when nothing is left in reach, take ONE safe step towards the nearest
  // unfinished cell and go again. Bounded by `until` and by api.stop(); it never scaffolds and never lets the placer walk itself
  // (`place:{noMove:true}`). Returns what was MEASURED, plus what is still left.
  async function buildCells (bot, job, api, cells, box, until, what) {
    let placed = 0; let dug = 0; let steps = 0
    const done = new Set(); const tried = []; const why = {} // cells our own floor cannot reach: REPORTED with the reason, never chased round the box
    for (let round = 0; round < 120 && Date.now() < until && !api.stop(); round++) {
      const todo = cells.filter(c => !done.has(c.x + ',' + c.y + ',' + c.z) && loadedAt(bot, c) && !cellOK(bot, c))
      if (!todo.length) break
      const me = bot.entity.position
      todo.sort((a, b) => v([a.x, a.y, a.z]).distanceTo(me) - v([b.x, b.y, b.z]).distanceTo(me))
      let prog = 0
      for (const c of todo) {
        if (Date.now() >= until || api.stop()) break
        const q = v([c.x, c.y, c.z]); const k = c.x + ',' + c.y + ',' + c.z
        if (eyeOf(bot).distanceTo(q.offset(0.5, 0.5, 0.5)) > 4.0) { why[k] = 'out of reach'; continue }
        task(bot, 'nether ' + what + ': ' + placed + ' placed, ' + dug + ' cleared')
        if (c.block === 'air') { const r = await BL().digBlock(bot, q, { collect: true, requireHarvest: false, noMove: true }).catch(e => ({ ok: false, reason: String(e && e.message) })); if (r && r.ok) { dug++; prog++ } else why[k] = 'dig: ' + String((r || {}).reason).slice(0, 40); continue }
        if (!hasRef(bot, q)) { why[k] = 'no solid face to place against'; continue }
        const item = itemFor(bot, c)
        if (!item || !A.count(bot, item)) { why[k] = 'none of ' + (item || c.block) + ' carried'; continue }
        const pr = await placeStill(bot, api, q, item)
        if (cellOK(bot, c)) { placed++; prog++; delete why[k] } else why[k] = 'place: ' + String(pr.reason).slice(0, 44)
      }
      if (prog) continue
      // nothing in reach: ONE step towards the nearest unfinished cell, inside our own box
      // A STEP MUST CLOSE THE DISTANCE (measured 12:42:14Z: 12 steps, 0 blocks — the candidates were sorted by distance from the
      // BOT, so it kept stepping to the cell it was already nearest to and wandered the box instead of reaching the two holes).
      // Nearest to the TARGET first, and never a cell that is not strictly closer to it than where we stand.
      const t = todo[0]; const tp = v([t.x, t.y, t.z]); let moved = false
      const here = bot.entity.position.floored(); const d0 = here.distanceTo(tp)
      const cands = []
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, 1, -1]) { const c2 = new Vec3(t.x + dx, t.y + dy + 1, t.z + dz); if (!c2.equals(here) && c2.distanceTo(tp) < d0 - 0.2) cands.push(c2) }
      cands.sort((a, b) => a.distanceTo(tp) - b.distanceTo(tp))
      for (const s2 of cands.slice(0, 20)) { if (api.stop()) break; if (await safeStep(bot, api, s2, box)) { moved = true; steps++; break } }
      if (!moved) { tried.push([t.x, t.y, t.z]); if (!why[t.x + ',' + t.y + ',' + t.z]) why[t.x + ',' + t.y + ',' + t.z] = 'no safe stand of ours within reach of it'; done.add(t.x + ',' + t.y + ',' + t.z); continue } // this one cannot be reached from our own floor: leave it, take the next
    }
    const left = cells.filter(c => loadedAt(bot, c) && !cellOK(bot, c))
    const unloaded = cells.filter(c => !loadedAt(bot, c)).length
    return { placed, dug, steps, left: left.length, unloaded, done: cells.length - left.length - unloaded, of: cells.length, leftAt: left.slice(0, 4).map(c => c.x + ',' + c.y + ',' + c.z + '=' + c.block + ' (' + (why[c.x + ',' + c.y + ',' + c.z] || '?') + ')'), unreachable: tried.length }
  }

  // ---------------------------------------------------------------- THE LANDING: a 5x5 floor, walls 2 high, a door gap, torches
  // STAGE 1b (top model 12:3xZ). The far gate opened over lava at y98-100 and BOTH deaths (11:59:14Z "tried to swim in lava",
  // 12:02:24Z "fell from a high place") happened in a step that MOVED the builder — the placer's own reposition/support remedies
  // and the walk to the next stand. So the arrival is made safe from EXACTLY where the gate puts the bot: floor first (nothing
  // left to fall through), then the open sides, then light. Every cell goes in at arm's length with `place:{noMove:true}`; what
  // is out of reach is COUNTED and left for an expedition that already knows the terrain, never chased.
  // The verdict is read back from the world, not from what we placed: `safe` = every floor cell solid AND no lava/fire within 5.
  async function landing (bot, job, api, body, budget) {
    if (!body.length) return { placed: 0, safe: false, why: 'no portal block to build a landing around' }
    const bx = [Math.min(...body.map(p => p.x)), Math.max(...body.map(p => p.x))]
    const bz = [Math.min(...body.map(p => p.z)), Math.max(...body.map(p => p.z))]
    const y0 = Math.min(...body.map(p => p.y))
    const cx = Math.round((bx[0] + bx[1]) / 2); const cz = Math.round((bz[0] + bz[1]) / 2)
    // the gate and the ring of blocks that holds it up are never touched
    const keep = new Set(); for (const p of body) { keep.add(p.x + ',' + p.y + ',' + p.z); for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) keep.add((p.x + d[0]) + ',' + (p.y + d[1]) + ',' + (p.z + d[2])) }
    const inBody = c => body.some(p => p.equals(c))
    const ring = []
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) if (Math.abs(x - cx) === 2 || Math.abs(z - cz) === 2) ring.push([x, z])
    // the door gap: the ring cell nearest to where we stand, 2 high — the way out for the next expedition (never a sealed box)
    const me = bot.entity.position
    const gap = ring.slice().sort((a, b) => Math.hypot(a[0] + 0.5 - me.x, a[1] + 0.5 - me.z) - Math.hypot(b[0] + 0.5 - me.x, b[1] + 0.5 - me.z))[0]
    const floorCells = []; for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) floorCells.push(new Vec3(x, y0 - 1, z))
    const wallCells = []; for (const [x, z] of ring) for (const y of [y0, y0 + 1]) { if (gap && x === gap[0] && z === gap[1]) continue; wallCells.push(new Vec3(x, y, z)) }
    const eye = () => eyeOf(bot)
    let floor = 0; let walls = 0; let out = 0; let lava = 0; const t0 = Date.now()
    const lay = async (c, what) => {
      if (api.stop() || floor + walls >= budget || Date.now() - t0 > 150000) return false
      if (keep.has(c.x + ',' + c.y + ',' + c.z) || inBody(c)) return false
      const b = bot.blockAt(c); if (!b || b.name === 'obsidian' || b.name === 'nether_portal' || b.boundingBox === 'block') return false
      if (eye().distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0 || !hasRef(bot, c)) { out++; return false }
      const item = stoneItem(bot); if (!item) return false
      if (b.name === 'lava') lava++
      task(bot, 'portal: ' + what + ' at the far gate (' + (floor + walls) + ')')
      return (await placeStill(bot, api, c, item)).ok
    }
    // FLOOR FIRST — nearest column out, so the cell under our own feet closes before anything else
    for (const c of floorCells.slice().sort((a, b) => a.distanceTo(me) - b.distanceTo(me))) if (await lay(c, 'flooring')) floor++
    for (const c of wallCells.slice().sort((a, b) => a.distanceTo(me) - b.distanceTo(me))) if (await lay(c, 'walling')) walls++
    // LIGHT: torches on the finished floor (nothing spawns on a lit landing); only where the floor really is solid under them
    let torches = 0
    if (A.count(bot, 'torch')) {
      for (const c of [[cx - 1, cz - 1], [cx + 1, cz + 1], [cx - 1, cz + 1], [cx + 1, cz - 1]].map(q => new Vec3(q[0], y0, q[1]))) {
        if (api.stop() || torches >= 4 || !A.count(bot, 'torch')) break
        const b = bot.blockAt(c); const u = bot.blockAt(c.offset(0, -1, 0))
        if (!b || b.boundingBox === 'block' || inBody(c) || !u || u.boundingBox !== 'block') continue
        if (eye().distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0) { out++; continue }
        await placeStill(bot, api, c, 'torch')
        const nb = bot.blockAt(c); if (nb && /torch/.test(nb.name)) torches++
      }
    }
    // THE VERDICT IS READ, NOT COUNTED: holes left in the floor, and lava/fire still within 5 of any landing cell
    const holes = floorCells.filter(c => !floorSafe(bot, { x: c.x, y: c.y, z: c.z }))
    const covered = floorCells.filter(c => { const b = bot.blockAt(c); return (!b || b.boundingBox !== 'block') && floorSafe(bot, { x: c.x, y: c.y, z: c.z }) }).length
    const hotIds = ['lava', 'fire'].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(q => q != null)
    const hot = hotIds.length ? bot.findBlocks({ matching: hotIds, maxDistance: 12, count: 400, point: new Vec3(cx, y0, cz) }) : []
    const near = hot.filter(q => floorCells.some(c => Math.max(Math.abs(q.x - c.x), Math.abs(q.y - c.y), Math.abs(q.z - c.z)) <= 5))
    const safe = holes.length === 0 && near.length === 0
    return { floor, walls, torches, placed: floor + walls, outOfReach: out, lavaPlugged: lava, holes: holes.length, coveredVoids: covered, hotNear: near.length, safe, gap: gap ? [gap[0], y0, gap[1]] : null, box: [cx - 2, cz - 2, cx + 2, cz + 2], y: y0, cells: floorCells.map(c => ({ x: c.x, y: c.y, z: c.z, block: 'stone' })).concat(wallCells.map(c => ({ x: c.x, y: c.y, z: c.z, block: 'stone' }))).filter(c => !keep.has(c.x + ',' + c.y + ',' + c.z)) }
  }

  // ---------------------------------------------------------------- ON ARRIVAL NOBODY WALKS
  // Both deaths at this gate (11:59:14Z "tried to swim in lava", 12:02:24Z "fell from a high place") happened in a step that MOVED
  // the builder, and `nether_look` had reported lava at the arrival both times. So the FIRST thing a scout does after the gate spits
  // it out is close the lava/fire faces it can reach from exactly where it stands, and put a floor under its own feet — no travel,
  // no scaffold, arm's length only. `sealed` is read back from the world.
  async function sealNear (bot, api, budget) {
    const me = bot.entity.position.floored(); const eye = () => bot.entity.position.offset(0, 1.62, 0)
    const cells = []
    for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) cells.push(me.offset(dx, dy, dz))
    cells.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const foot = me.offset(0, -1, 0)
    let sealed = 0; const t0 = Date.now()
    for (const c of [foot].concat(cells)) {
      if (api.stop() || sealed >= budget || Date.now() - t0 > 90000) break
      const b = bot.blockAt(c); if (!b) continue
      const isFoot = c.equals(foot)
      if (!isFoot && !/^(lava|fire)$/.test(b.name)) continue
      if (isFoot && b.boundingBox === 'block') continue
      if (b.name === 'nether_portal' || b.name === 'obsidian') continue
      if (eye().distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0) continue
      const item = stoneItem(bot); if (!item) break
      task(bot, 'portal: closing the lava at the far gate (' + sealed + ')')
      if ((await placeStill(bot, api, c, item)).ok) sealed++
    }
    return sealed
  }

  // ---------------------------------------------------------------- HOW A BOT WALKS IN THE NETHER
  // SIX BOTS "tried to swim in lava" between 13:36 and 13:37Z on one job. Six in two minutes is one cause, not bad luck: lava is
  // in `blocksToAvoid`, so the pathfinder never routes INTO it — but it happily routes ALONGSIDE it, cuts a diagonal corner over
  // it, and drops 3-4 onto a ledge beside it, and then a shove, a ghast, or lava that flowed after the path was planned finishes
  // the job. So over there every walk gets its own rule: any cell with lava or fire within 2 horizontally, 3 below or 2 above is
  // priced out of the graph, the drop is 1, and there is no parkour, no sprint and no 1x1 tower. `A.travel` re-asserts sprinting
  // from the larder on every trip, so `allowSprinting` is pinned to false with a property while the bot is off the overworld.
  let _lava = { t: 0, s: new Set() }
  function lavaSet (bot, force) {
    if (!force && Date.now() - _lava.t < 4000) return _lava.s
    const s2 = new Set()
    try {
      const ids = ['lava', 'fire'].map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
      if (ids.length) for (const q of bot.findBlocks({ matching: ids, maxDistance: 48, count: 900 })) s2.add(q.x + ',' + q.y + ',' + q.z)
    } catch (e_) { swallow('jobs_nether:lavaSet', e_) }
    _lava = { t: Date.now(), s: s2 }
    return s2
  }
  const lavaNear = (p, r = 2, below = 3, above = 2) => { const s2 = _lava.s; if (!s2.size) return false; for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -below; dy <= above; dy++) if (s2.has((p.x + dx) + ',' + (p.y + dy) + ',' + (p.z + dz))) return true; return false }
  function netherWalkOn (bot) {
    try {
      const mv = bot.pathfinder && bot.pathfinder.movements; if (!mv) return null
      mv.maxDropDown = 1; mv.allowParkour = false; mv.allow1by1towers = false; mv.canDig = false; mv.scafoldingBlocks = []
      if (!mv.__netherPinned) { mv.__netherPinned = true; try { Object.defineProperty(mv, 'allowSprinting', { get: () => false, set: () => {}, configurable: true }) } catch (e_) { swallow('jobs_nether:pinSprint', e_) } }
      if (!mv.__netherRule) { const rule = b => (b && b.position && lavaNear(b.position) ? 100 : 0); mv.__netherRule = rule; mv.exclusionAreasStep.push(rule) }
      return mv
    } catch (e_) { swallow('jobs_nether:walkOn', e_); return null }
  }
  function netherWalkOff (bot) {
    try {
      const mv = bot.pathfinder && bot.pathfinder.movements; if (!mv) return
      if (mv.__netherRule) { mv.exclusionAreasStep = mv.exclusionAreasStep.filter(f => f !== mv.__netherRule); mv.__netherRule = null }
      if (mv.__netherPinned) { mv.__netherPinned = false; try { delete mv.allowSprinting; mv.allowSprinting = false } catch (e_) { swallow('jobs_nether:unpinSprint', e_) } }
      mv.maxDropDown = A.DROP && A.DROP.normal ? A.DROP.normal : 3
    } catch (e_) { swallow('jobs_nether:walkOff', e_) }
  }
  // every walk over there goes through here: fresh lava picture, rule on, then the ordinary read-only A.travel
  async function nTravel (bot, target, opts) {
    lavaSet(bot, true); netherWalkOn(bot)
    const mv = bot.pathfinder && bot.pathfinder.movements; if (mv) mv.maxDropDown = 1
    return await A.travel(bot, target, Object.assign({ anyDepth: true, quiet: true }, opts || {}))
  }
  // is where we STAND safe enough to build from? (never bridge off a 1-wide ledge with lava under it)
  const safeStand = bot => { const p = bot.entity.position.floored(); return !lavaNear(p, 2, 3, 2) && A.walkableArea(bot, 60, 1) >= 8 }
  // ---------------------------------------------------------------- what a pair of eyes sees from where it stands
  const SIGHT = { nether_bricks: 'fortress', nether_brick_fence: 'fortress', nether_brick_stairs: 'fortress', nether_brick_slab: 'fortress', spawner: 'spawner', nether_wart: 'wart', soul_sand: 'soul_sand', ancient_debris: 'debris' }
  function sightNear (bot, r) {
    const ids = Object.keys(SIGHT).map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(q => q != null)
    const hits = ids.length ? bot.findBlocks({ matching: ids, maxDistance: Math.min(r || 96, 112), count: 500 }) : []
    const seen = {}
    for (const q of hits) { const b = bot.blockAt(q); if (!b) continue; const k = SIGHT[b.name]; if (!k) continue; const e = seen[k] = seen[k] || { kind: k, n: 0, at: null, d: 1e9 }; e.n++; const d = q.distanceTo(bot.entity.position); if (d < e.d) { e.d = Math.round(d); e.at = [q.x, q.y, q.z] } }
    return Object.values(seen).map(e => ({ kind: e.kind, n: e.n, at: e.at, d: e.d, by: bot.username, t: Date.now(), from: xyz(bot.entity.position) }))
  }
  function biomeOf (bot) { try { const b = bot.blockAt(bot.entity.position.floored()); return (b && b.biome && b.biome.name) || '?' } catch (e_) { swallow('jobs_nether:biome', e_); return '?' } }
  // A BRIDGE IS A ROAD (doctrine Q2), not a private shortcut: where the read-only pathfinder finds no way over a gap the squad
  // lays a FLOOR across it, at most 4 cells, at arm's length, and everybody who comes after walks it. Never a tunnel, never a pillar.
  async function bridgeAhead (bot, api, tgt) {
    let n = 0
    const me = bot.entity.position.floored()
    const d = v(tgt).minus(bot.entity.position); const len = Math.hypot(d.x, d.z); if (!len) return 0
    for (let i = 1; i <= 4; i++) {
      const c = new Vec3(Math.floor(me.x + d.x / len * i + 0.5), me.y - 1, Math.floor(me.z + d.z / len * i + 0.5))
      const b = bot.blockAt(c); if (!b) break
      if (b.boundingBox === 'block') continue
      if (eyeOf(bot).distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0 || !hasRef(bot, c)) break
      const item = stoneItem(bot); if (!item) break
      if (b.name === 'lava') { /* a causeway cell OVER lava is exactly what we want to close */ }
      if (!(await placeStill(bot, api, c, item)).ok) break
      n++
    }
    return n
  }
  // ---------------------------------------------------------------- FIND THE FORTRESS (owner 13:2xZ: "ネザービビりすぎじゃない？")
  // Four squads of three, one per bearing, on the NATURAL terrain with the ordinary read-only pathfinder — no road first, because
  // a road along four bearings is three roads too many. Every 50 blocks the bot says where it is and what it can see. The first
  // nether brick stops its finder and pulls everybody else towards it (`settings.nether.sightings` is the rendezvous).
  const BEARINGS = [[1, 0, 'x+'], [-1, 0, 'x-'], [0, 1, 'z+'], [0, -1, 'z-']]
  // THE WAY OUT IS PART OF THE JOB, AND IT IS A HOLE, NOT A GATE (owner 13:4xZ: "ネザーゲートの周り囲みすぎててハングしてる" —
  // six scouts reported `stranded {dim:"the_nether"}` INSIDE the room they had walled, at -34..-35,98,-74..-79). Every scout cuts
  // the four doorways open before its first leg: 2 wide, 2 HIGH, plain air, and a stone landing outside because the gate sits on
  // a ledge. A hub that keeps mobs out by keeping the army in is worse than no hub — in doubt the wall comes down.
  async function openDoors (bot, api, N0) {
    const doors = (N0.hub && Array.isArray(N0.hub.doors)) ? N0.hub.doors : (N0.hub && Array.isArray(N0.hub.door) ? [{ bearing: '?', at: N0.hub.door, out: null }] : [])
    if (!doors.length) return 0
    let opened = 0; let landed = 0
    for (const d of doors) {
      if (api.stop()) break
      const a = v(d.at)
      const lat = [[0, 0], Math.abs(a.x - ((N0.hub.room[0] + N0.hub.room[2]) / 2)) > Math.abs(a.z - ((N0.hub.room[1] + N0.hub.room[3]) / 2)) ? [0, 1] : [1, 0]]
      for (const [lx, lz] of lat) {
        for (const dy of [0, 1]) {
          const c = new Vec3(a.x + lx, a.y + dy, a.z + lz); const b = bot.blockAt(c)
          if (!b || b.boundingBox !== 'block') continue
          if (eyeOf(bot).distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.2) { await A.travel(bot, new Vec3(a.x, a.y, a.z), { range: 2, ms: 15000, stop: api.stop, quiet: true, anyDepth: true }); if (eyeOf(bot).distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.5) continue }
          const r = await BL().digBlock(bot, c, { collect: true, requireHarvest: false, allowProtected: true, own: true }).catch(() => ({ ok: false }))
          if (r && r.ok) opened++
        }
        if (d.out) { // a landing to step onto, or the first step out is a fall
          const o = new Vec3(d.out[0] + lx, d.out[1] - 1, d.out[2] + lz); const ob = bot.blockAt(o)
          if (ob && ob.boundingBox !== 'block' && hasRef(bot, o) && eyeOf(bot).distanceTo(o.offset(0.5, 0.5, 0.5)) <= 4.2) { const it = stoneItem(bot); if (it && (await placeStill(bot, api, o, it)).ok) landed++ }
        }
      }
    }
    if (opened || landed) A.result(bot, { ev: 'nether_door', doors: doors.length, opened, landed, at: doors.map(d => d.bearing).join(',') })
    return opened
  }
  async function explore (bot, job, api, P, until) {
    const N0 = netherOf()
    await openDoors(bot, api, N0)
    const hub = (N0.hub && Array.isArray(N0.hub.outside)) ? N0.hub.outside : (Array.isArray(N0.portal) ? N0.portal : xyz(bot.entity.position))
    const roster = A.settings().roster || []
    const idx = Math.max(0, roster.indexOf(bot.username))
    const b = BEARINGS[(P.bearing && BEARINGS.findIndex(q => q[2] === P.bearing) >= 0 ? BEARINGS.findIndex(q => q[2] === P.bearing) : idx) % 4]
    const step = Math.max(25, P.step || 50); const max = Math.min(P.range || 300, 512)
    let walked = 0; let bridged = 0; let legs = 0; let found = null
    // SHORT HOPS (measured 13:34Z: twelve scouts with a 50-block goal all came back `routed:false, walked 5-19` — over broken
    // Nether terrain A* gives up on a far goal, and the code base's own rule is hops <= 40 blocks). Each leg is walked in hops of
    // `hop`, each hop is allowed to fail, and a leg counts as routed when the bot actually got most of the way.
    const hop = Math.max(8, Math.min(P.hop || 16, 32))
    for (let d = step; d <= max && Date.now() < until && !api.stop(); d += step) {
      // THE GATE SENDS YOU HOME IF YOU WALK INTO IT (13:34Z: Mei's leg crossed the portal cells, she arrived in the overworld and
      // went on "exploring" on overworld coordinates, 563 blocks, and filed a DUNGEON spawner as a Nether sighting)
      if (!isNether(bot)) break
      const conv = (netherOf().sightings || []).filter(e => e && e.kind === 'fortress' && Array.isArray(e.at))
      const tgt = conv.length ? v(conv[conv.length - 1].at) : new Vec3(hub[0] + b[0] * d, hub[1], hub[2] + b[1] * d)
      task(bot, 'nether scout ' + b[2] + ' ' + d + '/' + max)
      const p0 = bot.entity.position.clone()
      let ok = false
      for (let h = 0; h < Math.ceil(step / hop) + 2 && Date.now() < until && !api.stop() && isNether(bot); h++) {
        const me = bot.entity.position; const dv = tgt.minus(me); const len = Math.hypot(dv.x, dv.z)
        if (len < 8) { ok = true; break }
        const k = Math.min(hop, len) / len
        const sub = new Vec3(Math.round(me.x + dv.x * k), tgt.y, Math.round(me.z + dv.z * k))
        const q0 = me.clone()
        let got = await nTravel(bot, sub, { range: 3, ms: 30000, stop: api.stop })
        if (!got && safeStand(bot)) { const nb = await bridgeAhead(bot, api, sub); bridged += nb; if (nb) got = await nTravel(bot, sub, { range: 3, ms: 20000, stop: api.stop }) }
        if (!got && bot.entity.position.distanceTo(q0) < 2) break // this hop is closed even to a bridge
      }
      walked += Math.round(p0.distanceTo(bot.entity.position)); legs++
      if (!isNether(bot)) break
      const s2 = sightNear(bot, 96)
      A.result(bot, { ev: 'nether_scout', job: job.id, pos: xyz(bot.entity.position), bearing: b[2], d, walked, bridged, biome: biomeOf(bot), routed: ok, sight: s2.map(e => e.kind + ' x' + e.n + ' @' + (e.at || []).join(',')) })
      const f = s2.find(e => e.kind === 'fortress') || s2.find(e => e.kind === 'spawner')
      if (f) {
        found = f
        const all = ((netherOf().sightings) || []).concat([f]).slice(-40)
        netherEdit({ sightings: all, fortress: f.kind === 'fortress' ? f.at : (netherOf().fortress || null) })
        A.result(bot, { ev: 'nether_sighting', job: job.id, kind: f.kind, at: f.at, d: f.d, from: xyz(bot.entity.position), bearing: b[2], walked })
        break
      }
      if (!ok && !conv.length) break // this bearing is closed to a read-only walk and a 4-cell bridge
    }
    return { work: 'fortress', bearing: b[2], walked, bridged, legs, sighted: found ? found.at : null, kind: found ? found.kind : null }
  }

  // ---------------------------------------------------------------- STAGE 2: the work a squad does on the far side, then home
  // ONE round trip per slice while `skyAbove`/`digOut` are still overworld-blind (a bot left over there cuts a staircase into
  // the bedrock roof, measured 12:30:23Z): cross, work for `params.minutes`, come home. Nobody is ever idle on the far side.
  // `params.work`: 'landing' (finish the 5x5 until it reads safe) · 'hub' (blueprint nether_hub) · 'road' (blueprint nether_road,
  // one bearing) · 'scout' (walk the finished road, look, report sightings). Blocks per bot-minute is in every `nether_pass`.
  // the area a squad may step inside = its own work plus the way in (a box that does not hold the door is a box nobody reaches)
  function unionBox (a, b, p) {
    const out = Array.isArray(a) ? a.slice() : null; if (!out) return null
    const grow = q => { if (!Array.isArray(q) || q.length !== 4) return; out[0] = Math.min(out[0], q[0], q[2]); out[1] = Math.min(out[1], q[1], q[3]); out[2] = Math.max(out[2], q[0], q[2]); out[3] = Math.max(out[3], q[1], q[3]) }
    grow(b)
    if (Array.isArray(p) && p.length === 3) grow([p[0] - 3, p[2] - 3, p[0] + 3, p[2] + 3])
    return out
  }
  function bpCells (name, origin, args) {
    const f = require.resolve(path.join(A.DIR, '..', 'blueprints', String(name).replace(/[^a-z0-9_]/gi, '') + '.js'))
    try { const m = fs.statSync(f).mtimeMs; if (_wpM[f] !== m) { delete require.cache[f]; _wpM[f] = m } } catch (e_) { swallow('jobs_nether:bpStat2', e_) }
    const mod = require(f)
    return { cells: mod({ x: origin[0], y: origin[1], z: origin[2] }, args || {}), meta: mod.meta ? mod.meta({ x: origin[0], y: origin[1], z: origin[2] }, args || {}) : null }
  }
  const _wpM = {}
  async function doWork (bot, job, api, st, P, body, landed) {
    const until = Date.now() + Math.min(Math.max(1, P.minutes || 6), 10) * 60000
    const t0 = Date.now()
    const N = netherOf()
    const y0 = body.length ? Math.min(...body.map(p => p.y)) : Math.floor(bot.entity.position.y)
    const cx = body.length ? Math.round((Math.min(...body.map(p => p.x)) + Math.max(...body.map(p => p.x))) / 2) : Math.floor(bot.entity.position.x)
    const cz = body.length ? Math.round((Math.min(...body.map(p => p.z)) + Math.max(...body.map(p => p.z))) / 2) : Math.floor(bot.entity.position.z)
    let cells = null; let box = null; let meta = null; const work = String(P.work)

    if (work === 'landing') {
      cells = (landed && landed.cells) || []
      box = (landed && landed.box) || [cx - 2, cz - 2, cx + 2, cz + 2]
    } else if (work === 'hub') {
      const o = Array.isArray(P.at) ? P.at : [cx, y0, cz]
      const r = bpCells('nether_hub', o, P.args2 || { door: P.door || 'x+' }); cells = r.cells; meta = r.meta
      box = unionBox(meta.room, null, xyz(bot.entity.position))
    } else if (work === 'road') {
      const hub = N.hub && N.hub.outside ? N.hub : null
      const from = Array.isArray(P.from) ? P.from : hub ? hub.outside : null
      const bearing = P.bearing || (hub && hub.bearing) || 'x+'
      if (!from) return { work, why: 'no start: settings.nether.hub.outside is not set (build the hub first) and params.from is missing' }
      const r = bpCells('nether_road', from, { bearing, length: P.length || 64 }); cells = r.cells; meta = r.meta
      box = unionBox(meta.box, (N.hub && N.hub.room), xyz(bot.entity.position))
    } else if (work === 'scout') {
      return await lookAround(bot, job, api, P, until)
    } else if (work === 'stair') {
      // THE WAY DOWN (top model 13:5xZ): from a hub doorway to the first real floor. The blueprint lists every cell, so the same
      // job cuts through netherrack where there is rock and builds of carried stone where there is void — no decision needed on
      // a half-rock slope. `buildCells` digs the `air` cells, places the `stone` ones, and only ever steps inside the stair's box.
      const N2 = netherOf()
      const doors = (N2.hub && Array.isArray(N2.hub.doors)) ? N2.hub.doors : []
      const dr = doors.find(q => q.bearing === (P.bearing || 'z-')) || doors[0]
      const from = Array.isArray(P.from) ? P.from : dr ? dr.out : null
      if (!from) return { work, why: 'no start: settings.nether.hub.doors is not set and params.from is missing' }
      const r2 = bpCells('nether_stair', from, { bearing: P.bearing || (dr && dr.bearing) || 'z-', toY: P.toY == null ? 33 : P.toY, run: P.run || 1 })
      cells = r2.cells; meta = r2.meta
      // THE BOX MUST HOLD THE DOOR WE COME IN BY (measured 14:44Z: `left:840, placed:0, steps:0` — the gate is at z -76, the stair
      // box started at z -79, so every safeStep candidate was outside our own box and the squad could not walk into its own work)
      box = unionBox(meta.box, N2.hub && N2.hub.room, xyz(bot.entity.position))
    } else if (work === 'fortress') {
      return await explore(bot, job, api, P, until)
    } else return { work, why: 'unknown params.work' }

    if (!cells || !cells.length) return { work, why: 'nothing to build' }
    // THE GATE IS NEVER BUILT OVER: the portal blocks and the obsidian that holds them are dropped from the plan
    const gate = new Set(); for (const q of body) { gate.add(q.x + ',' + q.y + ',' + q.z); for (const d of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) gate.add((q.x + d[0]) + ',' + (q.y + d[1]) + ',' + (q.z + d[2])) }
    cells = cells.filter(c => !gate.has(c.x + ',' + c.y + ',' + c.z))
    const r = await buildCells(bot, job, api, cells, box, until, work)
    const min = Math.max(0.1, (Date.now() - t0) / 60000)
    const out = Object.assign({ work, box, y: y0 }, r, { min: Math.round(min * 10) / 10, perBotMin: Math.round((r.placed + r.dug) / min * 10) / 10, carried: stoneCarried(bot) })

    if (work === 'landing') { // the verdict again, read back
      const holes = cells.filter(c => c.block === 'stone' && c.y === y0 - 1 && !floorSafe(bot, c))
      const hotIds = ['lava', 'fire'].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(q => q != null)
      const hot = hotIds.length ? bot.findBlocks({ matching: hotIds, maxDistance: 12, count: 400, point: new Vec3(cx, y0, cz) }) : []
      const near = hot.filter(q => Math.abs(q.x - cx) <= 7 && Math.abs(q.z - cz) <= 7 && Math.abs(q.y - y0) <= 6)
      out.holes = holes.length; out.hotNear = near.length; out.safe = holes.length === 0 && near.length === 0
      netherEdit({ landingSafe: out.safe, landingAt: Date.now(), landing: box, landingY: y0 })
    }
    if (work === 'hub' && meta) {
      // the furniture is registered under settings.nether ONLY (the overworld depot must not learn about a chest in another world)
      const stands = { chest: cellOK(bot, { x: meta.chest[0], y: meta.chest[1], z: meta.chest[2], block: 'chest' }), table: cellOK(bot, { x: meta.table[0], y: meta.table[1], z: meta.table[2], block: 'crafting_table' }) }
      out.chest = stands.chest; out.table = stands.table
      netherEdit({ hub: Object.assign({}, meta, { built: r.left === 0, chestStands: stands.chest, tableStands: stands.table, at: Date.now() }) })
    }
    if (work === 'stair' && meta) {
      const reached = !r.left && !r.unloaded
      netherEdit({ stair: { from: Array.isArray(P.from) ? P.from : null, bearing: meta.bearing, end: meta.end, toY: meta.toY, box: meta.box, left: r.left, unloaded: r.unloaded, at: Date.now(), done: reached } })
      if (reached) netherEdit({ floorHub: meta.end })
      out.bearing = meta.bearing; out.end = meta.end; out.toY = meta.toY
    }
    if (work === 'road' && meta) {
      const roads = Object.assign({}, N.roads || {}); roads[meta.bearing] = { from: Array.isArray(P.from) ? P.from : (N.hub || {}).outside, end: meta.end, length: meta.length, box: meta.box, left: r.left, at: Date.now() }
      netherEdit({ roads })
      out.bearing = meta.bearing; out.end = meta.end
    }
    return out
  }
  // SCOUT: what a pair of eyes can see from inside the finished road — no wandering, no ledges. Sightings go on the board.
  async function lookAround (bot, job, api, P, until) {
    const N = netherOf(); const road = (N.roads || {})[P.bearing || 'x+']
    if (road && Array.isArray(road.end) && !api.stop()) {
      // walk the road, inside its own box, to the far end
      const box = road.box
      for (let i = 0; i < 40 && Date.now() < until && !api.stop(); i++) {
        const me = bot.entity.position.floored(); const to = v(road.end)
        if (me.distanceTo(to) < 3) break
        const step = new Vec3(me.x + Math.sign(to.x - me.x) * 2, me.y, me.z + Math.sign(to.z - me.z) * 2)
        if (!await safeStep(bot, api, step, box)) break
      }
    }
    const list = sightNear(bot, 96)
    if (list.length) {
      const all = ((netherOf().sightings) || []).concat(list).slice(-40)
      netherEdit({ sightings: all })
      A.result(bot, { ev: 'nether_sighting', job: job.id, from: xyz(bot.entity.position), seen: list.map(e => e.kind + ' x' + e.n + ' @' + (e.at || []).join(',')) })
    }
    return { work: 'scout', at: xyz(bot.entity.position), seen: list.length, kinds: list.map(e => e.kind) }
  }

  // ---------------------------------------------------------------- THE WAY HOME (shared by the crossing job and the return job)
  // A bot that is in the Nether always has this one thing to do. The gate is whatever `nether_portal` block is in view; only if
  // none is, it walks towards the one the board registered (`settings.nether.portal`) — that walk is the ONE walk allowed over
  // there, and it is bounded, because standing still in the Nether is not a plan either.
  async function comeHome (bot, job, api, ctx2, st, P) {
    task(bot, 'portal: finding the way home')
    for (let w = 0; w < 40 && !bot.world.getColumnAt(bot.entity.position); w++) await sleep(500)
    let far = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 48 })
    if (!far) {
      const reg = netherOf().portal
      if (!Array.isArray(reg) || reg.length !== 3) { A.result(bot, { ev: 'nether_lost', job: job.id, pos: xyz(bot.entity.position), why: 'no gate in view and settings.nether.portal is not set' }); return 'in the Nether with no gate in view and none on the board' }
      task(bot, 'portal: walking to the far gate ' + reg.join(','))
      if (!await nTravel(bot, v(reg), { range: 2, ms: 240000, stop: api.stop })) {
        if (!api.stop()) { A.result(bot, { ev: 'nether_lost', job: job.id, pos: xyz(bot.entity.position), to: reg, why: 'no route to the registered far gate' }); A.askHelp(bot, 'nether_lost', 'I am in the Nether at ' + xyz(bot.entity.position).join(',') + ' and cannot reach the gate at ' + reg.join(',')) }
        return 'in the Nether at ' + xyz(bot.entity.position).join(',') + ': no route to the gate'
      }
      far = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 16 })
      if (!far) { A.result(bot, { ev: 'nether_lost', job: job.id, pos: xyz(bot.entity.position), to: reg, why: 'arrived at the registered gate and there is no nether_portal block there' }); return 'the registered far gate is gone' }
    }
    const cells = portalBody(bot, far.position, 10).map(p => [p.x, p.y, p.z])
    const to = await stepThrough(bot, api, cells.length ? cells : [xyz(far.position)], Math.min(P.crossS || 45, 120), 'standing in the far gate')
    if (to && !/nether/.test(to)) {
      netherWalkOff(bot)
      A.result(bot, { ev: 'portal_back', job: job.id, to, pos: xyz(bot.entity.position), from: xyz(far.position) })
      netherEdit({ back: Date.now(), portal: xyz(far.position) })
      st.home = true
      return 'portal_back: ' + to
    }
    return 'still in the Nether at ' + xyz(bot.entity.position).join(',') + ' (' + (api.stop() ? 'slice over' : 'the gate did not take me') + ')'
  }

  // ---------------------------------------------------------------- the far side (also the entry point when a new slice starts over there)
  async function netherSide (bot, job, api, ctx2, st, P) {
    netherWalkOn(bot)
    task(bot, 'portal: the Nether — waiting for the world')
    for (let w = 0; w < 80 && !bot.world.getColumnAt(bot.entity.position); w++) await sleep(500)
    await sleep(1500)
    const me = bot.entity.position.floored()
    let far = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 32 })
    const body = far ? portalBody(bot, far.position, 10) : []
    if (!st.through) {
      st.through = Date.now()
      A.result(bot, { ev: 'portal_through', job: job.id, from: st.fromDim || 'overworld', to: dimOf(bot), pos: xyz(me), portal: far ? xyz(far.position) : null, cells: body.length })
      netherEdit({ portal: far ? xyz(far.position) : xyz(me), through: Date.now(), scoutRev: job.rev || 0, by: bot.username })
    }
    if (!far) {
      // no gate in sight = no way home on foot. Say it and stand still; the operator decides (a second gate, a rescue expedition).
      A.result(bot, { ev: 'nether_lost', job: job.id, pos: xyz(me), why: 'no nether_portal block within 32 of where I arrived' })
      A.askHelp(bot, 'nether_lost', 'I am in the Nether at ' + xyz(me).join(',') + ' and see no portal within 32 blocks')
      return 'in the Nether at ' + xyz(me).join(',') + ' with no portal in sight'
    }
    // SAFETY BEFORE EVERYTHING ELSE (top model 12:15Z): close what can burn us from where we stand, then look.
    if (!st.sealed && stoneCarried(bot) > 0) {
      st.sealed = true
      const n = await sealNear(bot, api, 48)
      if (n) A.result(bot, { ev: 'nether_sealed', job: job.id, at: xyz(bot.entity.position), blocks: n })
    }
    // LOOK: what a player checks in the first three seconds
    if (!st.looked) {
      st.looked = true
      const lavaIds = [bot.registry.blocksByName.lava && bot.registry.blocksByName.lava.id].filter(q => q != null)
      const lava = lavaIds.length ? bot.findBlocks({ matching: lavaIds, maxDistance: 16, count: 200, point: far.position }).length : 0
      const mobs = A.hostiles(bot, 16).map(e => e.name)
      let drop = 0; { const p0 = far.position; for (let y = p0.y - 1; y >= p0.y - 24; y--) { const b = bot.blockAt(new Vec3(p0.x, y, p0.z)); if (!b) { drop = -1; break } if (b.boundingBox === 'block') break; drop++ } }
      st.unsafe = lava > 0 || mobs.length > 0 || drop > 2 || drop < 0
      A.result(bot, { ev: 'nether_look', job: job.id, at: xyz(far.position), lava, mobs: mobs.slice(0, 8), drop, hp: bot.health, unsafe: st.unsafe })
    }
    // THE LANDING: floor, walls, light — from where we stand, once. `params.landing:false` switches it off.
    if (P.landing !== false && !st.landed && stoneCarried(bot) >= 16) {
      st.landed = true
      const r = await landing(bot, job, api, body, Math.min(stoneCarried(bot), 220))
      st.landedR = r
      A.result(bot, Object.assign({ ev: 'nether_landing', job: job.id }, r, { cells: undefined }))
      // the LANDING is this step's business; `settings.nether.hub` belongs to the hub job alone (13:0xZ: writing a bare [x,y,z]
      // here clobbered the hub's whole record and the road squad arrived to "settings.nether.hub.outside is not set")
      netherEdit({ landing: r.box || null, landingY: r.y, landingSafe: !!r.safe, landingAt: Date.now() })
      // ONE ATTEMPT. A landing that still reads lethal is not walked around and not dug out: the scout goes home and says so, and
      // the answer is a SECOND overworld gate 128+ blocks away in x or z (its Nether exit lands 16+ blocks off) — docs/NETHER.md.
      if (!r.safe) A.result(bot, { ev: 'nether_unsafe', job: job.id, at: r.box, holes: r.holes, hotNear: r.hotNear, outOfReach: r.outOfReach, why: 'the landing still reads lethal after one attempt — relocate the gate rather than dig here' })
    }
    // STAGE 2 WORK, then home whatever happened (the `finally` of this trip is the gate, not a hope)
    if (P.work && !st.worked && !api.stop()) {
      st.worked = true
      let w = null
      try { w = await doWork(bot, job, api, st, P, body, st.landedR || null) } catch (e) { w = { work: String(P.work), why: 'threw: ' + String(e && e.message).slice(0, 90) }; swallow('jobs_nether:doWork', e) }
      const away = Math.round((Date.now() - (st.through || Date.now())) / 1000)
      A.result(bot, Object.assign({ ev: 'nether_pass', job: job.id }, w || {}, { awayS: away }))
    }
    // HOME. Never stay: keep_inventory is OFF, a slice is 15 min, and whatever the landing could not reach is the next trip's work.
    if (api.stop()) return 'in the Nether at ' + xyz(me).join(',') + ' (slice over, the return job takes it from here)'
    const r = await comeHome(bot, job, api, ctx2, st, P)
    // A FINISHED TRIP IS NOT A FINISHED JOB (owner 14:0xZ "待機してるやつ何": 27 of 50 bots at muster because the stair, the hub and
    // the fortress hunt had all auto-paused themselves at "the round trip is done" — the stage-1 SCOUT's completion rule fired for
    // every `portal` job whatever its `params.work`, the moment any one bot came home, with the stair at 490 of 1330 cells).
    // An exploratory crossing is done when it has been once; a work job is done when ITS work is done (`workDone`), and until
    // then every slice crosses again — so the per-trip state is reset here instead of being closed.
    if (st.home) {
      st.deathsAtGo = null; st.closeDue = true
      if (P.work) { st.phase = 'gate'; st.home = false; st.through = 0; st.looked = false; st.landed = false; st.sealed = false; st.worked = false; st.kitted = false } else st.phase = 'done'
    }
    return r
  }

  // ---------------------------------------------------------------- PUT THE GATE OUT BETWEEN TRIPS
  // A LIT PORTAL IS A COST WE PAY ALL DAY (owner 13:0xZ, low TPS: 74 zombified piglins standing around the base — a lit gate
  // spawns them in the OVERWORLD, they ignore the mob cap, and the bots rightly never attack a neutral mob). So the gate burns
  // only while a trip is out. The cheap, reversible, VERIFIABLE way is a player's way: take ONE obsidian out of the frame with a
  // diamond pickaxe — the whole surface goes out at once — read the six inner cells back as air, then put the obsidian straight
  // back so the frame is whole and the next trip only has to strike it. Water does not put a portal out, and nothing can be
  // placed inside a portal block; this is the only move that can be proved from the world. `settings.nether.lit` is the truth.
  async function closeGate (bot, job, api, G) {
    const lit0 = litCells(bot, G.inner).length
    if (!lit0) { netherEdit({ lit: false, outAt: Date.now() }); return { ok: true, was: 0, note: 'already out' } }
    const pick = A.bestOf(bot, 'pickaxe')
    if (!pick || !/diamond|netherite/.test(pick.name)) { if (!await A.obtain(bot, 'diamond_pickaxe', 1, { stop: api.stop }).catch(() => false)) return { ok: false, why: 'no diamond pickaxe: obsidian cannot be mined with ' + ((pick || {}).name || 'bare hands') } }
    const ref = G.floor[0] // the bottom row: flush in the apron, a stand on every side, and the easiest cell to put back
    const q = v(ref)
    for (const stnd of G.stands) {
      if (api.stop()) break
      if (litCells(bot, G.inner).length === 0) break
      if (!await A.travel(bot, v(stnd), { range: 0, ms: 45000, stop: api.stop, quiet: true })) continue
      await A.equipBest(bot, 'pickaxe').catch(e_ => swallow('jobs_nether:closePick', e_))
      await BL().digBlock(bot, q, { collect: true, requireHarvest: true, allowProtected: true, own: true }).catch(e_ => swallow('jobs_nether:closeDig', e_))
      await sleep(800)
    }
    const left = litCells(bot, G.inner).length
    // PUT THE FRAME BACK whatever happened: a gate with a hole in it is not a gate, and the next trip must only have to strike it
    let back = !!(bot.blockAt(q) && bot.blockAt(q).name === 'obsidian')
    for (let t = 0; t < 3 && !back && !api.stop(); t++) {
      if (!A.count(bot, 'obsidian') && !await A.obtain(bot, 'obsidian', 1, { stop: api.stop }).catch(() => false)) break
      await A.placeHard(bot, q, 'obsidian', { stop: api.stop }).catch(e_ => swallow('jobs_nether:closePut', e_))
      back = !!(bot.blockAt(q) && bot.blockAt(q).name === 'obsidian')
    }
    const gaps = frameGaps(bot, G).length
    const out = { ok: left === 0, was: lit0, cells: left, frameBack: back, gaps, at: ref }
    netherEdit({ lit: left > 0, outAt: Date.now(), outBy: bot.username })
    A.result(bot, Object.assign({ ev: left === 0 ? 'portal_out' : 'portal_out_failed', job: job.id }, out))
    if (gaps) A.result(bot, { ev: 'portal_frame_incomplete', job: job.id, missing: gaps, at: [ref.join(',')], note: 'left behind by putting the gate out - the next trip re-places it, or ' + (job.params || {}).buildJob })
    return out
  }
  // is anybody of ours still off the overworld? (heartbeats carry `dim`) — the gate stays lit while one bot is over there
  function anyoneOverThere (self) {
    try { return A.liveBots(600000).some(h => h && h.bot !== self && /nether|end/.test(String(h.dim || ''))) } catch (e_) { swallow('jobs_nether:anyoneOverThere', e_); return true }
  }

  // WHEN IS A WORK JOB FINISHED? Read from the BOARD, never from one bot's memory — the next bot is in another process.
  // A short human reason when it is done, false while there is work left.
  function workDone (N, P) {
    const w = String(P.work || '')
    if (!w) return false
    if (w === 'stair') return (N.stair && N.stair.done) ? 'the stair reaches y' + N.stair.toY + ' at ' + (N.stair.end || []).join(',') : false
    if (w === 'hub') return (N.hub && N.hub.built) ? 'the hub stands, chest and table registered' : false
    if (w === 'landing') return N.landingSafe ? 'the landing reads safe' : false
    if (w === 'road') { const r = (N.roads || {})[P.bearing || (N.hub || {}).bearing || 'x+']; return r && r.left === 0 ? 'the road reaches ' + (r.end || []).join(',') : false }
    if (w === 'fortress') { const f = (N.sightings || []).find(e => e && e.kind === 'fortress'); return f ? 'a fortress is sighted at ' + (f.at || []).join(',') : false }
    return false // barter and anything else: a standing job that ends when an operator pauses it
  }
  // ================================================================ the job
  async function portal (bot, job, api, ctx2) {
    const P = job.params || {}
    // THE RETURN JOB (`params.return:true`, `dim:"the_nether"`, id in settings.nether.returnJob): the only job a bot that is in the
    // Nether with nothing to do there may hold (the dispatcher hands it out by `hb.dim`). It needs no gate geometry — the far gate
    // is wherever the world put it. In the overworld it is a no-op that frees its bot at once: it must never hold anybody at base.
    if (P.return === true) {
      // 45 min, not 5: until the dispatcher filters by `hb.dim` this job is offered to overworld bots too, and a short decline would
      // bounce the whole army through it every few minutes (churn is backlog item 1). One bounce per bot per 45 min costs nothing.
      if (!isNether(bot)) { A.decline(bot, job, 45 * 60000, 'not in the Nether'); return muster(bot, job, api, ctx2, 'portal: the return job only carries bots that are in the Nether') }
      const rk = job.id + ':' + (job.rev || 0)
      const rs = bot.__armyPortalBack = (bot.__armyPortalBack && bot.__armyPortalBack.key === rk) ? bot.__armyPortalBack : { key: rk }
      return await comeHome(bot, job, api, ctx2, rs, P)
    }
    if (!Array.isArray(P.origin) || P.origin.length !== 3 || !P.origin.every(Number.isFinite)) return muster(bot, job, api, ctx2, 'portal: params.origin [x,y,z] is missing (it is the origin of the nether_portal BUILD job)')
    let G; try { G = geomOf(P) } catch (e) { return muster(bot, job, api, ctx2, 'portal: blueprint error ' + String(e && e.message).slice(0, 80)) }
    const key = job.id + ':' + (job.rev || 0)
    const st = bot.__armyPortal = (bot.__armyPortal && bot.__armyPortal.key === key) ? bot.__armyPortal : { key, phase: 'gate' }

    // A BOT THAT DIED ON THE TRIP DOES NOT GO AGAIN (30 min): one bad gate must never burn a bot in a loop. Deaths are counted
    // from the moment the expedition started, so a creeper at base on another job never blocks the gate.
    if (st.deathsAtGo != null && (bot.__armyDeaths || 0) > st.deathsAtGo) {
      // TWO DEATHS AT ONE GATE AND NOBODY ELSE GOES (top model 12:15Z). The count lives on the board, not in this process, because
      // the next scout is another bot in another shard; an operator who has made the far side safe clears settings.nether.deaths.
      // DEATH IS AN ACCEPTED COST OF EXPLORATION HERE (owner 13:2xZ, "ネザービビりすぎじゃない？"): 390 diamonds, 50 bots, every one
      // respawns at its bed and re-kits from the depot. What must not happen is a job that kills a squad in a quarter of an hour,
      // so the brake is a ROLLING WINDOW on the board - 6 deaths in 30 min - not a lifetime total.
      const log = ((netherOf().deathLog) || []).filter(t => Date.now() - t < 30 * 60000).concat([Date.now()]).slice(-40)
      const n = log.length
      netherEdit({ deathLog: log, deaths: n, lastDeath: Date.now(), lastDeathBy: bot.username })
      A.result(bot, { ev: 'portal_scout_died', job: job.id, deaths: n, window: '30min', at: st.through ? 'the_nether' : 'the gate' })
      st.deathsAtGo = null; st.phase = 'gate'; st.through = 0; st.looked = false; st.landed = false; st.sealed = false; st.worked = false
      A.decline(bot, job, 3 * 60000, 'died on the nether trip - re-kitting')
      return muster(bot, job, api, ctx2, 'portal: I died over there; re-kitting and going again in 3 min')
    }
    // already over there (a new slice, or the dispatcher handed the job back): only nether work happens in the nether
    if (isNether(bot)) return await netherSide(bot, job, api, ctx2, st, P)

    // ---- 1. the FRAME is the build job's, never this one's
    const gate = v(G.floor[0])
    if (A.dist2(bot, gate.x, gate.z) > 24 && !await A.travel(bot, { x: gate.x, y: gate.y + 1, z: gate.z }, { range: 3, ms: 300000, stop: api.stop })) return 'portal: cannot reach the gate at ' + G.floor[0].join(',')
    await sleep(500)
    const gaps = frameGaps(bot, G)
    if (gaps.length) {
      A.result(bot, { ev: 'portal_frame_incomplete', job: job.id, missing: gaps.length, at: gaps.slice(0, 4).map(f => f.at.join(',')), build: P.buildJob || null })
      if (P.buildJob) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === P.buildJob); if (j && j.status !== 'active') { j.status = 'active'; j.note = 'auto-reactivated: the portal job found ' + gaps.length + ' frame cells missing' } })
      A.decline(bot, job, 6 * 60000, 'the frame is ' + gaps.length + ' cells short')
      return muster(bot, job, api, ctx2, 'portal: ' + gaps.length + ' frame cells are missing — that is ' + (P.buildJob || 'the build job') + "'s work")
    }

    // ---- 2. LIGHT it (nothing to do when it already burns)
    let lit = litCells(bot, G.inner).length
    if (lit < G.inner.length) {
      if (!A.count(bot, 'flint_and_steel')) {
        task(bot, 'portal: fetching flint and steel')
        if (!await A.obtain(bot, 'flint_and_steel', 1, { stop: api.stop })) {
          if (A.count(bot, 'flint') || await knapGravel(bot, api)) await A.obtain(bot, 'flint_and_steel', 1, { stop: api.stop })
        }
      }
      if (!A.count(bot, 'flint_and_steel')) { A.decline(bot, job, 10 * 60000, 'no flint_and_steel'); return muster(bot, job, api, ctx2, 'portal: no flint_and_steel and none craftable (needs 1 iron_ingot + 1 flint; flint drops from gravel)') }
      const r = await strike(bot, job, api, G)
      lit = litCells(bot, G.inner).length
      if (lit < G.inner.length) {
        st.fails = (st.fails || 0) + 1
        A.result(bot, { ev: 'portal_light_failed', job: job.id, at: G.floor[0], cells: lit + '/' + G.inner.length, why: String(r).slice(0, 140), tries: st.fails })
        if (st.fails >= 3) { A.askHelp(bot, 'portal_light_failed', 'the gate at ' + G.floor[0].join(',') + ' will not light: ' + String(r).slice(0, 120)); A.decline(bot, job, 15 * 60000, 'the gate will not light') }
        return 'portal: not lit — ' + String(r).slice(0, 120)
      }
      st.fails = 0
      A.result(bot, { ev: 'portal_lit', job: job.id, at: G.floor[0], cells: lit, axis: G.axis })
      netherEdit({ gate: G.floor[0], axis: G.axis, lit: Date.now(), by: bot.username })
    } else if (!netherOf().lit) netherEdit({ gate: G.floor[0], axis: G.axis, lit: Date.now(), by: bot.username })

    // ---- 3. GO (one pinned scout, once per rev)
    const N = netherOf()
    // PUT IT OUT BETWEEN TRIPS (owner: low TPS, 74 zombified piglins round the base from a gate that burned all day). The bot that
    // comes home last does it; while any heartbeat is still off the overworld the gate stays lit, because it is somebody's way back.
    if ((st.closeDue || P.close === true) && P.closeGate !== false) {
      if (anyoneOverThere(bot.username)) { if (P.close === true) return 'portal: leaving the gate lit - a bot is still on the far side' } else {
        st.closeDue = false
        const c = await closeGate(bot, job, api, G)
        lit = litCells(bot, G.inner).length
        if (P.close === true) return 'portal: gate out (' + lit + '/' + G.inner.length + ' cells burning, frame back: ' + (c.frameBack !== false) + ')'
      }
    }
    if (P.close === true) return 'portal: nothing to put out'
    // A SERVER RESTART IS PENDING: no bot crosses (the top model only restarts while nobody is off the overworld)
    if (A.settings().restartPending) { A.decline(bot, job, 5 * 60000, 'settings.restartPending'); return muster(bot, job, api, ctx2, 'portal: a server restart is pending - no crossing until settings.restartPending is cleared') }
    const done = workDone(N, P)
    const wanted = P.go === true && !done && (P.work ? true : (st.phase !== 'done' && (N.scoutRev !== (job.rev || 0) || !N.back)))
    if (!wanted) {
      // nothing left to do here: free the bot, and say WHY it stopped
      const why = done ? 'auto-paused: ' + P.work + ' is finished (' + done + ')' : 'auto-paused: the gate is lit and the round trip is done (bump rev to send another expedition)'
      if (!P.standing && (P.work ? !!done : (job.names || []).length <= 1)) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && (j.rev || 0) === (job.rev || 0) && j.status === 'active') { j.status = 'paused'; j.note = why } })
      return muster(bot, job, api, ctx2, 'portal: ' + (done ? P.work + ' is finished (' + done + ')' : 'the gate stands and burns (' + lit + '/' + G.inner.length + ' cells)'))
    }
    // TWO DEATHS AT THIS GATE = NOBODY ELSE GOES (top model 12:15Z). The gate stays lit and the board keeps the count; an operator
    // who has made the arrival safe (or moved the gate) clears `settings.nether.deaths` and re-activates this job.
    const maxD = P.maxDeaths == null ? 6 : P.maxDeaths
    const recentDeaths = ((N.deathLog) || []).filter(t => Date.now() - t < 30 * 60000).length
    if (recentDeaths >= maxD) {
      A.result(bot, { ev: 'portal_unsafe', job: job.id, deaths: recentDeaths, portal: N.portal || null, why: recentDeaths + ' bots died over there in 30 minutes — the squad stops, the cause gets fixed, then it goes again' })
      A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: ' + recentDeaths + ' deaths in 30 min on the far side (' + JSON.stringify(N.portal || null) + '). Fix the cause you can see, clear settings.nether.deathLog, re-activate - do not wait' } })
      return muster(bot, job, api, ctx2, 'portal: the gate is lit; ' + N.deaths + ' scouts died on the far side, so nobody else crosses')
    }
    // ONE PINNED BOT is the rule for an EXPLORATORY crossing (`go` without `work`): nobody knows what is on the other side yet.
    // A `work` job may go as a SQUAD (top model 12:4xZ, 3-4 per road): the dispatcher exempts type `portal` from its dimension
    // filter, so it never pulls a bot out mid-trip, and this handler brings every bot home inside its own slice.
    if (!P.work && (job.names || []).length !== 1) {
      if (!st.saidScout) { st.saidScout = true; A.result(bot, { ev: 'portal_scout_missing', job: job.id, why: 'an exploratory crossing (go without work) needs exactly ONE pinned bot: set job.names:["<bot>"]. A `work` job may take a squad' }) }
      return 'portal: lit; the exploratory crossing waits for job.names with exactly one bot'
    }

    // KIT: bank first (keep_inventory is OFF), then 128 cobblestone + torches + food + the best sword we may take
    if (!st.kitted) {
      task(bot, 'portal: kitting up for the crossing')
      await A.kitUp(bot, { risk: true, force: true, why: job.id, stop: api.stop }).catch(e_ => swallow('jobs_nether:kitUp', e_))
      const want = Math.max(32, P.cobble || 128)
      for (const k of SHELL_STONE.slice().sort((a, b) => A.stockOf(b) - A.stockOf(a))) {
        if (stoneCarried(bot) >= want || api.stop()) break
        if (A.stockOf(k) < 16) continue
        await A.obtain(bot, k, Math.min(A.count(bot, k) + (want - stoneCarried(bot)), 256), { stop: api.stop }).catch(e_ => swallow('jobs_nether:obtain', e_))
      }
      if (A.count(bot, 'torch') < 16) await A.obtain(bot, 'torch', 32, { stop: api.stop }).catch(e_ => swallow('jobs_nether:torch', e_))
      // the hub's furniture is CARRIED OVER (there is no depot on the far side and there must not be one in the overworld's books)
      if (P.work === 'hub') for (const it of ['chest', 'crafting_table', 'fence_gate']) if (!A.count(bot, it) && !bot.inventory.items().some(i => /_fence_gate$/.test(i.name) && it === 'fence_gate')) await A.obtain(bot, it, 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:furniture', e_))
      // a scout that finds the fortress must be able to say so from 100 blocks out and get home: bow + arrows when the depot has them
      if (P.work === 'fortress') for (const it of ['bow', 'arrow']) if (A.stockOf(it) > 0 && A.count(bot, it) < (it === 'arrow' ? 16 : 1)) await A.obtain(bot, it, it === 'arrow' ? 32 : 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:bow', e_))
      // a shield is the difference between a ghast fireball and a death (top model 12:4xZ)
      if (!A.count(bot, 'shield') && !(bot.inventory.slots[45] || {}).name) await A.obtain(bot, 'shield', 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:shield', e_))
      if (!bot.registry.foodsByName || !bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) await A.obtain(bot, 'bread', 16, { stop: api.stop }).catch(e_ => swallow('jobs_nether:food', e_))
      await A.equipBest(bot, 'sword').catch(e_ => swallow('jobs_nether:sword', e_))
      const short = []
      if (stoneCarried(bot) < 32) short.push('stone to build with ' + stoneCarried(bot) + '/32 (depot: ' + SHELL_STONE.map(k => k + ' ' + A.stockOf(k)).join(', ') + ')')
      if (!A.bestOf(bot, 'sword')) short.push('no sword')
      if (!bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) short.push('no food')
      if (short.length) { A.decline(bot, job, 10 * 60000, 'kit short: ' + short.join(', ')); return muster(bot, job, api, ctx2, 'portal: not going through under-equipped (' + short.join(', ') + ')') }
      st.kitted = true
    }
    if (api.stop()) return 'portal: kitted, crossing next slice'

    // CROSS
    st.fromDim = dimOf(bot); st.deathsAtGo = bot.__armyDeaths || 0; st.through = 0; st.looked = false; st.landed = false; st.sealed = false; st.worked = false
    const to = await stepThrough(bot, api, G.inner.filter(q => q[1] === P.origin[1] + 1), P.crossS || 90, 'standing in the gate')
    if (!to) {
      st.deathsAtGo = null
      A.result(bot, { ev: 'portal_light_failed', job: job.id, at: G.floor[0], cells: litCells(bot, G.inner).length + '/' + G.inner.length, why: 'stood in the gate for ' + (P.crossS || 90) + ' s and stayed in ' + dimOf(bot) })
      return 'portal: stood in the gate, no dimension change (still ' + dimOf(bot) + ')'
    }
    return await netherSide(bot, job, api, ctx2, st, P)
  }

  return { types: { portal }, verbs: {} }
}
module.exports.TYPES = ['portal']
module.exports.VERBS = []
