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
//   shell            wall the far gate in (5x5x3 with a door gap) when `nether_look` calls the far side unsafe; `false` switches it
//                    off. Built STRICTLY without walking (arm's reach from where the gate put the bot) — see sealNear/shell.
//   return:true      THE RETURN JOB (`dim:"the_nether"`, its id in `settings.nether.returnJob`): the one job a bot that is in the
//                    Nether with nothing to do there may hold. No origin needed; a no-op in the overworld.
//   maxDeaths:2      scouts that may die at this gate before the crossing job pauses itself (count on the board, `settings.nether.deaths`)
//   cobble:128 (blocks of stone to carry, any sort) · crossS:90 (seconds to stand in the portal, both ways)
// EVENTS (all verified): portal_frame_incomplete · flint_knapped · portal_lit · portal_light_failed · portal_through · nether_sealed ·
//   nether_look · nether_shell · portal_back · nether_lost · portal_scout_died · portal_unsafe · portal_scout_missing
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
  const netherOf = () => A.settings().nether || {}

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

  // ---------------------------------------------------------------- a 5x5x3 cobblestone shell with a door gap around the far gate
  // What a player builds the second he arrives: the far portal usually opens in the open, in sight of ghasts and over lava. Only
  // cells that are NOT already solid are placed, the portal and its obsidian are never touched, and the count reported is the
  // count read back from the world.
  async function shell (bot, job, api, body, budget) {
    if (!body.length) return { placed: 0, why: 'no portal block to wrap' }
    const bx = [Math.min(...body.map(p => p.x)), Math.max(...body.map(p => p.x))]
    const bz = [Math.min(...body.map(p => p.z)), Math.max(...body.map(p => p.z))]
    const y0 = Math.min(...body.map(p => p.y))
    const cx = Math.round((bx[0] + bx[1]) / 2); const cz = Math.round((bz[0] + bz[1]) / 2)
    const keep = new Set(); for (const p of body) { keep.add(p.x + ',' + p.y + ',' + p.z); for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) keep.add((p.x + d[0]) + ',' + (p.y + d[1]) + ',' + (p.z + d[2])) }
    // the door gap: the ring cell nearest to where we stand, 2 high — the way out for the next expedition
    const me = bot.entity.position
    const ring = []
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) if (Math.abs(x - cx) === 2 || Math.abs(z - cz) === 2) ring.push([x, z])
    const gap = ring.slice().sort((a, b) => Math.hypot(a[0] + 0.5 - me.x, a[1] + 0.5 - me.z) - Math.hypot(b[0] + 0.5 - me.x, b[1] + 0.5 - me.z))[0]
    const cells = []
    for (const [x, z] of ring) for (let y = y0; y <= y0 + 2; y++) { if (gap && x === gap[0] && z === gap[1] && y <= y0 + 1) continue; cells.push(new Vec3(x, y, z)) }
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) { cells.push(new Vec3(x, y0 + 3, z)); cells.push(new Vec3(x, y0 - 1, z)) } // roof + floor (only where there is a hole)
    // THE BUILDER NEVER LEAVES A SAFE STAND (measured 11:59:14Z: Chino fell from y98 to y26 and died on her 46th shell block — the
    // far gate had generated on a ledge over open Nether, and the placer's own `reposition`/`support` remedies walk). So: anchors =
    // the standable cells right beside the gate, reached from the gate itself; from each anchor only cells within arm's reach are
    // placed, the bot is walked back to its anchor the moment it has drifted, and a cell with no solid neighbour to place against
    // is left alone (that is what sends the placer looking for a support column six blocks down).
    // NOBODY WALKS IN THE NETHER ON THE FIRST TRIP (measured twice, 11:59:14Z Chino y98 -> y26 after 46 blocks and 12:02:24Z Hotaru
    // y98 -> y33 after 3: the far gate generated on a narrow ledge near the Nether roof, and BOTH deaths happened in a step that
    // MOVED the builder — the placer's own `reposition`/`support` remedies, and the walk to the next stand). So the shell is built
    // from exactly where the bot arrives, arm's length, no travel, no scaffold: a cell out of reach or without a solid neighbour to
    // place against is left for a later expedition that knows the terrain. `placed` is read back from the world.
    const hasRef = c => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(d => { const n = bot.blockAt(c.offset(d[0], d[1], d[2])); return !!n && n.boundingBox === 'block' })
    const todo = cells.filter(c => !keep.has(c.x + ',' + c.y + ',' + c.z))
    let placed = 0; let lava = 0; let far = 0; const t0 = Date.now()
    for (const c of todo) {
      if (api.stop() || placed >= budget || Date.now() - t0 > 120000) break
      const b = bot.blockAt(c); if (!b || b.name === 'obsidian' || b.name === 'nether_portal' || b.boundingBox === 'block') continue
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0) { far++; continue }
      if (!hasRef(c)) { far++; continue }
      const item = stoneItem(bot); if (!item) break
      if (b.name === 'lava') lava++
      task(bot, 'portal: walling the far gate in (' + placed + ')')
      const r = await A.placeHard(bot, c, item, { stop: api.stop, noRest: true, place: { noMove: true } }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      const nb = bot.blockAt(c)
      if ((r && r.ok) || (nb && nb.boundingBox === 'block')) placed++
    }
    return { placed, lava, outOfReach: far, gap: gap ? [gap[0], y0, gap[1]] : null, box: [cx - 2, cz - 2, cx + 2, cz + 2], y: y0 }
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
      const r = await A.placeHard(bot, c, item, { stop: api.stop, noRest: true, place: { noMove: true } }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      const nb = bot.blockAt(c)
      if ((r && r.ok) || (nb && nb.boundingBox === 'block')) sealed++
    }
    return sealed
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
      if (!await A.travel(bot, v(reg), { range: 2, ms: 240000, stop: api.stop, anyDepth: true })) {
        if (!api.stop()) { A.result(bot, { ev: 'nether_lost', job: job.id, pos: xyz(bot.entity.position), to: reg, why: 'no route to the registered far gate' }); A.askHelp(bot, 'nether_lost', 'I am in the Nether at ' + xyz(bot.entity.position).join(',') + ' and cannot reach the gate at ' + reg.join(',')) }
        return 'in the Nether at ' + xyz(bot.entity.position).join(',') + ': no route to the gate'
      }
      far = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 16 })
      if (!far) { A.result(bot, { ev: 'nether_lost', job: job.id, pos: xyz(bot.entity.position), to: reg, why: 'arrived at the registered gate and there is no nether_portal block there' }); return 'the registered far gate is gone' }
    }
    const cells = portalBody(bot, far.position, 10).map(p => [p.x, p.y, p.z])
    const to = await stepThrough(bot, api, cells.length ? cells : [xyz(far.position)], Math.min(P.crossS || 45, 120), 'standing in the far gate')
    if (to && !/nether/.test(to)) {
      A.result(bot, { ev: 'portal_back', job: job.id, to, pos: xyz(bot.entity.position), from: xyz(far.position) })
      netherEdit({ back: Date.now(), portal: xyz(far.position) })
      st.home = true
      return 'portal_back: ' + to
    }
    return 'still in the Nether at ' + xyz(bot.entity.position).join(',') + ' (' + (api.stop() ? 'slice over' : 'the gate did not take me') + ')'
  }

  // ---------------------------------------------------------------- the far side (also the entry point when a new slice starts over there)
  async function netherSide (bot, job, api, ctx2, st, P) {
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
    // SHELL: only when the look calls the far side unsafe, only with what we carried in, and (since 12:1xZ) STRICTLY WITHOUT WALKING —
    // `params.shell:false` switches it off. Whatever it could not reach stays for an expedition that knows the terrain.
    if (P.shell !== false && st.unsafe && !st.shelled && stoneCarried(bot) >= 16) {
      st.shelled = true
      const r = await shell(bot, job, api, body, Math.min(stoneCarried(bot), 160))
      A.result(bot, Object.assign({ ev: 'nether_shell', job: job.id }, r))
      if (r.placed) netherEdit({ hub: [r.box[0] + 2, r.y, r.box[1] + 2], shell: r.box, shellY: r.y })
    }
    // HOME. Never stay: keep_inventory is OFF, a slice is 15 min, and whatever the shell could not reach is the next trip's work.
    if (api.stop()) return 'in the Nether at ' + xyz(me).join(',') + ' (slice over, the return job takes it from here)'
    const r = await comeHome(bot, job, api, ctx2, st, P)
    if (st.home) { st.phase = 'done'; st.deathsAtGo = null }
    return r
  }

  // ================================================================ the job
  async function portal (bot, job, api, ctx2) {
    const P = job.params || {}
    // THE RETURN JOB (`params.return:true`, `dim:"the_nether"`, id in settings.nether.returnJob): the only job a bot that is in the
    // Nether with nothing to do there may hold (the dispatcher hands it out by `hb.dim`). It needs no gate geometry — the far gate
    // is wherever the world put it. In the overworld it is a no-op that frees its bot at once: it must never hold anybody at base.
    if (P.return === true) {
      if (!isNether(bot)) { A.decline(bot, job, 15 * 60000, 'not in the Nether'); return muster(bot, job, api, ctx2, 'portal: the return job only carries bots that are in the Nether') }
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
      const n = (netherOf().deaths || 0) + 1
      netherEdit({ deaths: n, lastDeath: Date.now(), lastDeathBy: bot.username })
      A.result(bot, { ev: 'portal_scout_died', job: job.id, deaths: n, at: st.through ? 'the_nether' : 'the gate' })
      st.deathsAtGo = null; st.phase = 'gate'; st.through = 0; st.looked = false; st.shelled = false; st.sealed = false
      A.decline(bot, job, 30 * 60000, 'died on the nether trip')
      return muster(bot, job, api, ctx2, 'portal: I died on the trip — this job is declined for 30 min')
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
    const wanted = P.go === true && (N.scoutRev !== (job.rev || 0) || !N.back)
    if (!wanted) {
      // the gate stands and burns and nobody has to watch it: free the bot (a job that holds a bot for nothing is a planning failure)
      if ((job.names || []).length <= 1 && !P.standing) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && (j.rev || 0) === (job.rev || 0) && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: the gate is lit' + (P.go === true ? ' and the round trip is done (bump rev to send another expedition)' : '') } })
      return muster(bot, job, api, ctx2, 'portal: the gate stands and burns (' + lit + '/' + G.inner.length + ' cells)')
    }
    // TWO DEATHS AT THIS GATE = NOBODY ELSE GOES (top model 12:15Z). The gate stays lit and the board keeps the count; an operator
    // who has made the arrival safe (or moved the gate) clears `settings.nether.deaths` and re-activates this job.
    const maxD = P.maxDeaths == null ? 2 : P.maxDeaths
    if ((N.deaths || 0) >= maxD) {
      A.result(bot, { ev: 'portal_unsafe', job: job.id, deaths: N.deaths, portal: N.portal || null, why: N.deaths + ' scouts died at this gate — no third goes through until the arrival is safe' })
      A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: ' + N.deaths + ' scouts died at the far gate ' + JSON.stringify(N.portal || null) + ' (lava at the arrival). Make it safe, clear settings.nether.deaths, then re-activate' } })
      return muster(bot, job, api, ctx2, 'portal: the gate is lit; ' + N.deaths + ' scouts died on the far side, so nobody else crosses')
    }
    if ((job.names || []).length !== 1) {
      if (!st.saidScout) { st.saidScout = true; A.result(bot, { ev: 'portal_scout_missing', job: job.id, why: 'params.go needs exactly ONE pinned bot: set job.names:["<bot>"] (a squad would queue in the frame and the dispatcher could pull a bot while it is in the Nether)' }) }
      return 'portal: lit; the crossing waits for job.names with exactly one bot'
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
    st.fromDim = dimOf(bot); st.deathsAtGo = bot.__armyDeaths || 0; st.through = 0; st.looked = false; st.shelled = false
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
