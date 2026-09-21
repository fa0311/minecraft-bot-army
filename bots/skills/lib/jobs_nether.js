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
//   maxDeaths:6      deaths IN THE LAST 30 MIN (settings.nether.deathLog) before the job pauses itself. Death is an accepted cost
//                    of exploring the Nether; a squad wiped in a quarter of an hour is not.
//   work:'barter'    1006 gold ingots in the depot -> ender pearls, fire resistance, obsidian. Wears a GOLD piece (piglins stay
//                    neutral), drops ONE ingot at a time at an adult piglin within 8, picks up what comes back, NEVER attacks.
//                    `ingots:64` per trip. A standing job: it ends when an operator pauses it.
//   work:'pair'      build the gate's EXACT partner at floor(x/8), floor(z/8) (`params.at`): probe the column, walk there
//                    read-only, platform first, then the frame centred on the partner point, then light it. A partner more than
//                    a few blocks off means every return is a coin toss inside Paper's 128-block search - that is what breeds gates.
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
  // A DIMENSION WE CANNOT READ IS NOT A DIMENSION CHANGE (camera census 15:4xZ: there is exactly ONE overworld gate, ours, and no
  // gate at all near -130,-240 or -203,-338 — so the bots that reported `portal_through to:"overworld"` there never transferred.
  // `bot.game.dimension` is briefly falsy while a respawn packet is processed; 'unknown' !== 'overworld' read as "we moved".)
  const KNOWN_DIM = /^(overworld|the_nether|the_end)$/
  const dimOf = bot => String((bot.game && bot.game.dimension) || 'unknown')
  const dimKnown = bot => KNOWN_DIM.test(dimOf(bot))
  const dimChanged = (bot, dim0) => dimKnown(bot) && dimOf(bot) !== dim0
  // what may stand in a frame CORNER (vanilla leaves them empty; ours carry any stone sort, see the blueprint)
  const STONE_RE = /^(cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|tuff|deepslate|stone_bricks|blackstone|basalt|smooth_stone|netherrack)$/
  // THE SHELL IS BUILT FROM WHATEVER STONE WE HAVE, not from one name (11:53Z: the scout refused to cross with `cobblestone 0/32`
  // while the depot held 299 diorite — the ravine fill drains cobblestone faster than the mine banks it). Order = what a depot
  // usually has most of; `stoneItem` re-reads the pockets for every block placed, so a pile running out costs nothing.
  const SHELL_STONE = ['cobblestone', 'cobbled_deepslate', 'diorite', 'andesite', 'granite', 'stone', 'tuff', 'deepslate', 'blackstone', 'dirt']
  const stoneCarried = bot => SHELL_STONE.reduce((n, k) => n + A.count(bot, k), 0)
  const stoneItem = bot => SHELL_STONE.filter(k => A.count(bot, k) > 0).sort((a, b) => A.count(bot, b) - A.count(bot, a))[0] || null

  // ---------------------------------------------------------------- WHAT GOES THROUGH THE GATE IS WHAT THE ARMY LOSES
  // Owner 09-21, reading the bill: 「もったいな」. 115 deaths have cost 1519 iron-equivalents and 580 diamonds, and two of them were
  // mine: 46 iron + 7 diamonds in six minutes. A bot that dies over there drops everything, and no recovery run reaches another
  // dimension inside the five minutes an item lives on the ground — so the crossing kit is the CHEAP tier. The diamond gear is
  // banked at home and the iron one withdrawn in its place; what cannot be swapped is reported, and `portal_kit.worth` puts the
  // price of every crossing in the events so the bill is never invisible again. Target: ~15 iron, 0 diamonds.
  const DIA_W = { diamond: 1, diamond_pickaxe: 3, diamond_sword: 2, diamond_axe: 3, diamond_shovel: 1, diamond_hoe: 2, diamond_helmet: 5, diamond_chestplate: 8, diamond_leggings: 7, diamond_boots: 4, netherite_ingot: 4, netherite_pickaxe: 7, netherite_sword: 6 }
  const IRON_W = { iron_ingot: 1, raw_iron: 1, iron_pickaxe: 3, iron_sword: 2, iron_axe: 3, iron_shovel: 1, iron_hoe: 2, iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4, shield: 1, bucket: 3, flint_and_steel: 1, iron_nugget: 0 }
  function kitWorth (bot) {
    let iron = 0; let diamond = 0
    const all = bot.inventory.items().concat([5, 6, 7, 8, 45].map(q => bot.inventory.slots[q]).filter(Boolean))
    for (const it of all) { const n = it.name; const c = it.count || 1; if (DIA_W[n] != null) diamond += DIA_W[n] * c; else if (IRON_W[n] != null) iron += IRON_W[n] * c; else if (/^(diamond|netherite)_/.test(n)) diamond += 3 * c }
    return { iron, diamond }
  }
  // The replacement is ALWAYS fetched before the good piece is given up — a bot that loses both is worse off than one carrying
  // diamonds. NOTE for the army.js owner: neither library primitive can bank a tier DOWN. `A.bank` force-keeps the BEST tool of
  // every class (`bestNames`) and any armour better than what is worn; `A.stash` skips tools by name. So the deposit is done here
  // by hand, into a tools chest, and the request upstream is `bank(bot, keep, {maxTier:'iron'})`.
  const DIA_RE = /^(diamond|netherite)_(pickaxe|sword|axe|shovel|hoe)$/
  async function swapDown (bot, api, keepDia) {
    const out = { swapped: [], kept: [], deposited: 0 }
    const spare = () => bot.inventory.items().filter(i => DIA_RE.test(i.name) && !(keepDia && keepDia.test(i.name.split('_')[1])) && A.count(bot, i.name.replace(/^(diamond|netherite)/, 'iron')) > 0)
    // 1. ARMOUR first — it is the biggest single item on the bill (a diamond chestplate is 8 diamonds)
    for (const [slot, part, sl] of [[5, 'helmet', 'head'], [6, 'chestplate', 'torso'], [7, 'leggings', 'legs'], [8, 'boots', 'feet']]) {
      const w = bot.inventory.slots[slot]; if (!w || !/^(diamond|netherite)_/.test(w.name)) continue
      const want = 'iron_' + part
      if (!A.count(bot, want) && A.stockOf(want) > 0) await A.obtain(bot, want, 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:swapArm', e_))
      const it = bot.inventory.items().find(i => i.name === want)
      if (!it) { out.kept.push(w.name); continue }
      try { await U.withTimeout(bot.equip(it, sl), 5000, 'wearIron'); out.swapped.push(w.name) } catch (e_) { swallow('jobs_nether:wearIron', e_); out.kept.push(w.name) }
    }
    // 2. TOOLS: fetch the iron tier, so the good one is only spare once its replacement is in the pocket
    for (const cls of ['pickaxe', 'sword', 'axe', 'shovel']) {
      if (keepDia && keepDia.test(cls)) continue // `pair` and `degate` genuinely need a diamond pickaxe: obsidian comes out for nothing else
      if (!bot.inventory.items().some(i => new RegExp('^(diamond|netherite)_' + cls + '$').test(i.name))) continue
      const want = 'iron_' + cls
      if (!A.count(bot, want) && A.stockOf(want) > 0) await A.obtain(bot, want, 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:swapGet', e_))
    }
    // 3. put the good tier back in a chest by hand; any failure keeps the gear and is REPORTED, never a blocked crossing
    if (spare().length) {
      const chests = [].concat(A.chestsOf ? A.chestsOf('tools') : [], A.chestsOf ? A.chestsOf('build') : [])
      for (const c of chests.slice(0, 3)) {
        if (!spare().length || api.stop()) break
        if (bot.entity.position.distanceTo(c) > 3.5 && !await A.travel(bot, c, { range: 2, ms: 60000, stop: api.stop, quiet: true })) continue
        let win = null
        try { win = await U.withTimeout(bot.openContainer(bot.blockAt(c)), 8000, 'openTools') } catch (e_) { swallow('jobs_nether:openTools', e_); continue }
        if (!win) continue
        try { for (const it of spare()) { await U.withTimeout(win.deposit(it.type, null, it.count), 8000, 'depositDia'); out.deposited += it.count; out.swapped.push(it.name) } } catch (e_) { swallow('jobs_nether:depositDia', e_) } finally { try { win.close() } catch (e2_) { swallow('jobs_nether:closeTools', e2_) } }
      }
    }
    for (const it of bot.inventory.items()) if (DIA_RE.test(it.name) || /^(diamond|netherite)_(helmet|chestplate|leggings|boots)$/.test(it.name)) out.kept.push(it.name)
    return out
  }

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

  // ---------------------------------------------------------------- GET OUT OF THE FRAME FIRST (owner 15:3xZ)
  // 「ネザーゲートブロックと同じ位置にいる場合、ブロックを置くことが出来ません、ネザーゲート周辺が狭すぎるせいでハングします」 — and he is
  // right: a player standing IN a portal cell cannot place a block, and five bots had to be rescued (losing their whole kit)
  // because every arrival routine ran from inside the frame. So the FIRST act after ANY arrival, in either dimension, is to walk
  // OUT — onto a cell at least 2 clear of the frame — and nothing else (no look, no place, no dig, no window) happens before it.
  // If the pathfinder refuses to plan from inside a portal block (it often does: the cell is not "standable"), we walk by hand
  // with control states, away from the gate, which is what a player does.
  const inGate = (bot, p) => { const b = bot.blockAt(p); return !!b && b.name === 'nether_portal' }
  const inGateNow = bot => { const f = bot.entity.position.floored(); return inGate(bot, f) || inGate(bot, f.offset(0, 1, 0)) }
  // A PORTAL CELL IS A TELEPORTER AND THE PATHFINDER DOES NOT KNOW IT. Measured 15:50:23Z: Ichika crossed, stood in the_nether at
  // -44,98,-80 (`stranded`, 15:49:11), and 72 s later she was in the OVERWORLD at -177,62,-286 — `clearOfGate` had asked the
  // pathfinder for a cell on the far side of the frame, the route went straight back THROUGH the six portal blocks, the gate sent
  // her home, and she then walked the NETHER goal on overworld ground (that is the whole "revolving door", and every "extra gate"
  // it bred). So every walk of ours prices portal cells out of the graph, in both dimensions; the ONE deliberate entry lifts the
  // guard for as long as it takes and puts it straight back.
  // the set is kept ON THE BOT, never in this module: 50 bots share one process pool and one bot's gate is not another's world
  function gateSet (bot, force) {
    const g = bot.__armyGateCells = bot.__armyGateCells || { t: 0, s: new Set() }
    if (!force && Date.now() - g.t < 4000) return g.s
    const s2 = new Set()
    try {
      const id = bot.registry.blocksByName.nether_portal && bot.registry.blocksByName.nether_portal.id
      if (id != null) for (const q of bot.findBlocks({ matching: [id], maxDistance: 40, count: 200 })) s2.add(q.x + ',' + q.y + ',' + q.z)
    } catch (e_) { swallow('jobs_nether:gateSet', e_) }
    g.t = Date.now(); g.s = s2
    return s2
  }
  const gateCell = (bot, p) => { const s2 = (bot.__armyGateCells || {}).s; return !!s2 && s2.size > 0 && (s2.has(p.x + ',' + p.y + ',' + p.z) || s2.has(p.x + ',' + (p.y + 1) + ',' + p.z)) }
  function gateGuardOn (bot, force) {
    try {
      gateSet(bot, force)
      const mv = bot.pathfinder && bot.pathfinder.movements; if (!mv) return
      // A COST IS NOT A WALL (measured 16:04:15Z: priced at 400 the portal was still the cheapest way across a 9-cell pocket, and
      // the bot was sent home 14 s after it arrived). A portal block belongs in blocksToAvoid: the graph then has no edge through
      // the gate at all, and the one deliberate entry takes it out again for as long as it needs.
      try { const id = bot.registry.blocksByName.nether_portal && bot.registry.blocksByName.nether_portal.id; if (id != null && mv.blocksToAvoid && !mv.blocksToAvoid.has(id)) { mv.blocksToAvoid.add(id); mv.__gateAvoid = id } } catch (e2_) { swallow('jobs_nether:gateAvoid', e2_) }
      if (!mv.__gateRule) { const r = b => (b && b.position && gateCell(bot, b.position) ? 400 : 0); mv.__gateRule = r; mv.exclusionAreasStep.push(r) }
    } catch (e_) { swallow('jobs_nether:gateGuardOn', e_) }
  }
  function gateGuardOff (bot) {
    try {
      const mv = bot.pathfinder && bot.pathfinder.movements; if (!mv) return
      if (mv.__gateAvoid != null) { try { mv.blocksToAvoid.delete(mv.__gateAvoid) } catch (e2_) { swallow('jobs_nether:gateAvoidOff', e2_) } mv.__gateAvoid = null }
      if (!mv.__gateRule) return
      mv.exclusionAreasStep = mv.exclusionAreasStep.filter(f => f !== mv.__gateRule); mv.__gateRule = null
    } catch (e_) { swallow('jobs_nether:gateGuardOff', e_) }
  }
  async function clearOfGate (bot, api, body, want) {
    if (!inGateNow(bot)) return true
    const near = p => body.length ? Math.min(...body.map(q => Math.max(Math.abs(q.x - p.x), Math.abs(q.z - p.z)))) : 9
    const candsFor = min => {
      const me = bot.entity.position.floored()
      const cands = []
      for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (const dy of [0, 1, -1]) {
        const c = me.offset(dx, dy, dz)
        if (inGate(bot, c) || inGate(bot, c.offset(0, 1, 0))) continue
        if (near(c) < min) continue
        if (!BL().standable(bot, c)) continue
        cands.push(c)
      }
      cands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      return cands
    }
    // OUT IS OUT, AND ROOM IS A LUXURY (measured 15:35:37Z: Ichika filed `gate_stuck` at the home gate — "the gate area is too
    // tight to stand beside" — and the whole crossing was abandoned, although the cobblestone apron one cell off the frame would
    // have done). The thing that matters is being OUT of a portal cell, because the cooldown only ticks down outside one; three
    // cells of room is what we ask for, one cell is what we accept before we leave a bot standing in the fire.
    // BY HAND FIRST, AND FAST. The arrival cooldown is 15 s long and it is ALL the time we have: stay in the cells longer than
    // that and the gate takes us straight back (measured 15:50:23Z: `offCellS 72.9` and a bot in the wrong dimension). A step out
    // of a portal cell is one block of walking, so it is done with control states, and only then is the pathfinder asked — with
    // portal cells priced out of its graph, because its idea of "the nearest free cell" was a route through the gate itself.
    gateGuardOn(bot, true)
    const deadline = Date.now() + 25000
    // ONE list, roomy cells first, near ones right behind them — never three rounds of it. (Measured at the far gate: the only
    // cells 2 clear of that frame lie BEHIND its west wall, so a `min:2` round burns the whole cooldown walking into obsidian
    // while a cell one step to the east is free. Being OUT is the thing; room is a preference, not a condition.)
    const cands = candsFor(1)
    const me0 = bot.entity.position
    cands.sort((a, b) => (Math.round(a.distanceTo(me0) * 2) - Math.round(b.distanceTo(me0) * 2)) || (near(b) - near(a))) // nearest out, roomiest of the equally near
    for (const c of cands.slice(0, 6)) {
      if (api.stop() || Date.now() > deadline || !inGateNow(bot)) break
      try {
        task(bot, 'portal: out of the frame first')
        bot.pathfinder.setGoal(null); bot.clearControlStates()
        await bot.lookAt(c.offset(0.5, 1.2, 0.5), true)
        bot.setControlState('forward', true)
        if (c.y > bot.entity.position.y + 0.4) bot.setControlState('jump', true) // a step UP out of the frame is a jump, not a walk
        for (let t = 0; t < 12 && inGateNow(bot) && !api.stop(); t++) await sleep(250)
        bot.setControlState('forward', false); bot.setControlState('jump', false)
      } catch (e_) { swallow('jobs_nether:walkOut', e_) }
      if (!inGateNow(bot)) return true
    }
    for (const c of cands.slice(0, 4)) {
      if (api.stop() || Date.now() > deadline || !inGateNow(bot)) break
      task(bot, 'portal: out of the frame first')
      if (await A.travel(bot, c, { range: 0, ms: 6000, stop: api.stop, quiet: true, anyDepth: true }) && !inGateNow(bot)) return true
    }
    if (!inGateNow(bot)) return true
    try { bot.clearControlStates() } catch (e_) { swallow('jobs_nether:walkOutClear', e_) }
    if (inGateNow(bot)) A.result(bot, { ev: 'gate_stuck', at: xyz(bot.entity.position), dim: dimOf(bot), why: 'cannot get out of the portal cells - the gate area is too tight to stand beside' })
    return !inGateNow(bot)
  }
  // SEVERAL BOTS ARRIVE TOGETHER: the arrival cell must be vacated at once or the next one is pushed back into the frame. Each bot
  // takes a DIFFERENT platform cell, chosen by its roster index, so no coordination message is needed.
  async function spreadOut (bot, api, body) {
    try {
      const idx = Math.max(0, (A.settings().roster || []).indexOf(bot.username))
      const me = bot.entity.position.floored()
      const near = p => body.length ? Math.min(...body.map(q => Math.max(Math.abs(q.x - p.x), Math.abs(q.z - p.z)))) : 9
      const ring = []
      // THE WHOLE PLATFORM, NOT EIGHT CELLS (owner 16:3xZ: the arrival is sized for 50 bots now — 15x15 with the gate in the
      // middle — so the spread targets run out to 7 cells and every roster index gets a different one; 3 cells of clearance in
      // front of the faces, because a bot standing right at a face is the next arrival's obstacle).
      for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) { const c = me.offset(dx, 0, dz); const d = near(c); if (d >= 3 && d <= 7 && !inGate(bot, c) && BL().standable(bot, c)) ring.push(c) }
      if (!ring.length) for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) { const c = me.offset(dx, 0, dz); const d = near(c); if (d >= 2 && d <= 4 && !inGate(bot, c) && BL().standable(bot, c)) ring.push(c) }
      if (!ring.length) return false
      ring.sort((a, b) => (a.x * 31 + a.z) - (b.x * 31 + b.z))
      const pick = ring[idx % ring.length]
      const p = bot.entity.position.floored()
      if (p.equals(pick)) return true
      return !!await A.travel(bot, pick, { range: 0, ms: 10000, stop: api.stop, quiet: true, anyDepth: true })
    } catch (e_) { swallow('jobs_nether:spreadOut', e_); return false }
  }

  // ---------------------------------------------------------------- walk INTO the gate (never stand in it waiting)
  // Minecraft resets the portal cooldown on every tick an entity is still inside, so a bot the gate just spat out is never taken
  // again by standing there. The move is a player's: walk 3 cells CLEAR, then walk back in and hold only while the transfer runs.
  // Two failed attempts and we stop - no loops in the frame, ever (that is what had to be rescued five times).
  async function stepThrough (bot, api, cells, seconds, why, body) {
    const dim0 = dimOf(bot)
    const tgt = cells.map(q => v(q))
    const bod = body && body.length ? body : tgt
    // ALREADY IN THE GATE? STAND STILL AND LET IT TAKE YOU. A player who walks into a lit portal is moved after 80 ticks (4 s);
    // measured 15:35:37Z the opposite happened — Ichika was standing IN the home gate's cells, `clearOfGate` could not find three
    // cells of room, and the crossing was abandoned from the one place it was already winning (`gate_stuck` + "stood in the gate
    // for 30 s"). Standing is free, and it also TELLS US WHICH CASE WE ARE IN: if 12 s of standing changes nothing, this bot is on
    // a portal COOLDOWN (300 ticks), and Minecraft RESETS that cooldown on every tick the entity is still inside — so the only
    // cure is to be OUT of the cells for the whole of it and walk back in, which is what the attempts below do.
    if (inGateNow(bot)) {
      task(bot, 'portal: ' + why + ' (in the gate, waiting for the transfer)')
      for (let t = 0; t < 24 && !api.stop() && inGateNow(bot); t++) { if (dimChanged(bot, dim0)) return dimOf(bot); await sleep(500) }
      if (dimChanged(bot, dim0)) return dimOf(bot)
    }
    const cooling = inGateNow(bot) // 12 s inside a lit portal and still here = a cooldown that resets while we stand in it
    for (let attempt = 0; attempt < 2 && !api.stop() && dimOf(bot) === dim0; attempt++) {
      if (!await clearOfGate(bot, api, bod, 3)) break // 3 cells clear: the cooldown only expires outside
      // THE COOLDOWN IS 15 SECONDS, NOT ONE (this is why a bot that had just come home walked straight back in and hung there):
      // out of the cells, wait it out, then in again. A bot that walked up from base has no cooldown and waits a moment.
      for (let w = 0; w < (cooling ? 36 : 3) && !api.stop() && !dimChanged(bot, dim0); w++) await sleep(500)
      const c = tgt.slice().sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
      task(bot, 'portal: ' + why)
      gateGuardOff(bot) // the ONE deliberate entry: the guard that keeps every other walk out of the gate is lifted for it
      const walkedIn = await A.travel(bot, c, { range: 0, ms: 30000, stop: api.stop, quiet: true, anyDepth: true })
      if (!walkedIn) { gateGuardOn(bot, true); continue }
      const end = Date.now() + Math.min(seconds, 30) * 1000
      while (Date.now() < end && !api.stop()) {
        if (dimChanged(bot, dim0)) return dimOf(bot)
        if (!inGateNow(bot)) { try { await A.travel(bot, c, { range: 0, ms: 8000, stop: api.stop, quiet: true, anyDepth: true }) } catch (e_) { swallow('jobs_nether:hold', e_) } }
        await sleep(500)
      }
      if (dimChanged(bot, dim0)) return dimOf(bot)
      gateGuardOn(bot, true)
    }
    if (!dimChanged(bot, dim0)) await clearOfGate(bot, api, bod, 2) // never be left standing in the frame
    return dimChanged(bot, dim0) ? dimOf(bot) : null
  }

  // ---------------------------------------------------------------- building in the Nether: what a cell wants, and the ONE walk allowed
  // A cell is `{x,y,z,block}`; `stone` means any stone sort the squad carries (the depot's mix changes by the hour), `air` means
  // the cell must be clear. Satisfaction is always READ FROM THE WORLD, never from what we think we placed.
  // AN UNLOADED CELL IS NOT A FINISHED CELL (measured 13:06:55Z: the first road squad came home with `left:0` on a 64-block road
  // it had not laid a single block of — the far end was outside the bots' loaded chunks, `blockAt` gave null, and null read as
  // "already right"). Unloaded cells are counted on their own so a pass can never claim a road it cannot even see.
  // ---------------------------------------------------------------- A CHUNK THAT READS NULL IS UNKNOWN, AND UNKNOWN IS NEVER SAFE
  // THE bug behind both deaths of 09-21 (Erika -51,27,-75, Chika -52,27,-75, 46 iron + 7 diamond in six minutes; owner: 「もったいな」).
  // Every pass reported `unloaded: 1053 of 1053` — 30 s after arrival `blockAt` was null across a work area 25 blocks away — and the
  // two halves of this file then disagreed about what that meant: `cellOK()` counted an unreadable cell as DONE, while `noFloor` /
  // `edgeNear` counted it as a DROP. So a bot stood at the lip of a 70-block void placing blocks it could not read back, and the
  // second one went over the rim having taken no `safeStep` at all (`steps: 0`).
  // The rule, asserted HERE so every Nether routine inherits it: a cell whose column is not loaded is not work, not floor, not
  // safe — it is unknown. Nothing is placed on it, dug from it, stepped towards it or judged about it; the pass waits for the
  // chunk (the loaded-check of `ops/skyshot.js survey()`: ask `bot.world.getColumnAt`, not `blockAt`) and reports what never came.
  const knownAt = (bot, p) => { try { const q = v(p); return !!bot.world.getColumnAt(q) && !!bot.blockAt(q) } catch (e_) { swallow('jobs_nether:knownAt', e_); return false } }
  // a cell we might STAND on is only known when its ring is: the floor under it, the body space, and the neighbours a shove could take us to
  const knownRing = (bot, c, r = 1, below = 3, above = 2) => {
    const q = v(c)
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -below; dy <= above; dy++) if (!knownAt(bot, q.offset(dx, dy, dz))) return false
    return true
  }
  const loadedAt = (bot, c) => knownAt(bot, [c.x, c.y, c.z])
  const cellOK = (bot, c) => {
    if (!knownAt(bot, [c.x, c.y, c.z])) return false // UNKNOWN is never "already right": it is counted as `unloaded` and waited for
    const b = bot.blockAt(v([c.x, c.y, c.z])); if (!b) return false
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
  // NOBODY BRIDGES OVER A VOID WITHOUT SNEAKING (measured 16:53:11Z: Aoi "tried to swim in lava" at the_nether -39,24,-64 — she
  // walked off the HEAD of the causeway at y98, fell 74 blocks into the lava sea and took 26 iron and 9 diamond with her. A
  // sneaking player cannot walk off an edge; that is the Minecraft basic this code was missing).
  const sneakOn = bot => { try { bot.setControlState('sneak', true) } catch (e_) { swallow('jobs_nether:sneakOn', e_) } }
  const sneakOff = bot => { try { if (!(bot.__netherHold > 0)) bot.setControlState('sneak', false) } catch (e_) { swallow('jobs_nether:sneakOff', e_) } }
  // A SNEAK HOLD NOTHING MAY CLEAR (Erika, 09-21 05:46:19Z, "tried to swim in lava" at -51,27,-75 with 31 iron and 5 diamond,
  // four blocks into the barter lane). `buildCells` holds sneak for a whole build — but every `safeStep` inside it goes through
  // `nTravel`, and `nTravel` released sneak in its `finally` when it was done. So the build's own sneak was switched off by its
  // own walk, over and over, and the fourth time it happened the bot was standing on a 1-wide lane head over 70 blocks of void.
  // A hold is a COUNT, not a flag: the build takes one, every walk inside it may take and drop its own, and sneak only ever
  // comes off when the last holder lets go.
  const sneakHold = (bot, on) => { bot.__netherHold = Math.max(0, (bot.__netherHold || 0) + (on ? 1 : -1)); if (bot.__netherHold > 0) sneakOn(bot); else { try { bot.setControlState('sneak', false) } catch (e_) { swallow('jobs_nether:holdOff', e_) } } }
  // is this cell within one of a drop? (no solid block within 3 under any neighbour)
  const edgeNear = (bot, c) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      let solid = false
      for (let dy = -1; dy >= -3; dy--) { const b = bot.blockAt(c.offset(dx, dy, dz)); if (b && b.boundingBox === 'block') { solid = true; break } }
      if (!solid) return true
    }
    return false
  }
  // ONE CELL, BY HAND, SNEAKING. The pathfinder plans a route and cuts corners over air; at an edge the only safe move is a short
  // control-state step with sneak held, and it is only taken when the block we are stepping onto READS solid (re-read, never the
  // place result).
  async function sneakStep (bot, api, c) {
    try {
      if (!knownRing(bot, c, 1)) return false // unknown ground is not stepped onto, however close it is
      const u = bot.blockAt(c.offset(0, -1, 0)); if (!u || u.boundingBox !== 'block' || /lava|magma/.test(u.name)) return false
      bot.pathfinder.setGoal(null); bot.clearControlStates(); sneakOn(bot)
      await bot.lookAt(c.offset(0.5, 0.1, 0.5), true)
      bot.setControlState('forward', true)
      // sneak is RE-ASSERTED on every tick of the step, never set once: `clearControlStates()` above and anything else that
      // resets the controls mid-step would otherwise leave the bot walking a 1-wide lane head upright (05:46:19Z)
      for (let t = 0; t < 14 && !api.stop(); t++) { sneakOn(bot); await sleep(250); if (bot.entity.position.floored().equals(c)) break }
      bot.setControlState('forward', false)
      return bot.entity.position.distanceTo(c.offset(0.5, 0, 0.5)) < 1.2
    } catch (e_) { swallow('jobs_nether:sneakStep', e_); try { bot.setControlState('forward', false) } catch (e2_) { swallow('jobs_nether:sneakStepClear', e2_) } return false }
  }
  // ONE CELL UP, SNEAKING, WITH ONE PULSE OF JUMP. `sneakStep` walks; it cannot climb, because a 1-block rise needs a jump and
  // holding `forward` against a wall for 3.5 s simply fails (07:27:13Z). Jump is PULSED, never held: a held jump bunny-hops a bot
  // forward off the far side of a 1-wide stair, and sneak does not help a body that is already airborne.
  async function climbStep (bot, api, c) {
    try {
      if (!knownRing(bot, c, 1)) return false
      const u = bot.blockAt(c.offset(0, -1, 0)); if (!u || u.boundingBox !== 'block' || /lava|magma/.test(u.name)) return false
      // SNEAK IS WHAT STOPS THE CLIMB, and only where it is not earning anything. A crouched body is held at the lip of the block
      // it stands on, so the hop onto a block one up and one across never leaves the ground (07:31:08Z, `could not climb onto
      // -35,103,-80`, after five cells of the same route worked). The doctrine's own rule is the answer: a rim is walked by hand
      // sneaking, open ground is simply walked. So the crouch comes off for ONE hop, and only when there is no drop within 1 of
      // either the cell we leave or the cell we land on - at a rim it stays on and the climb is refused and reported instead.
      const here = bot.entity.position.floored()
      const rim = edgeNear(bot, c) || edgeNear(bot, here)
      bot.pathfinder.setGoal(null); bot.clearControlStates(); if (rim) sneakOn(bot)
      await bot.lookAt(c.offset(0.5, 0.1, 0.5), true)
      bot.setControlState('forward', true)
      for (let hop = 0; hop < 4 && !api.stop(); hop++) {
        bot.setControlState('jump', true); await sleep(200); bot.setControlState('jump', false)
        for (let t = 0; t < 7 && !api.stop(); t++) { if (rim) sneakOn(bot); await sleep(200); if (bot.entity.position.floored().equals(c)) break }
        if (bot.entity.position.floored().equals(c)) break
      }
      bot.setControlState('jump', false); bot.setControlState('forward', false); sneakOn(bot)
      return bot.entity.position.distanceTo(c.offset(0.5, 0, 0.5)) < 1.2
    } catch (e_) { swallow('jobs_nether:climbStep', e_); try { bot.setControlState('jump', false); bot.setControlState('forward', false) } catch (e2_) { swallow('jobs_nether:climbClear', e2_) } return false }
  }
  async function safeStep (bot, api, c, box) {
    try {
      if (!box || c.x < box[0] || c.x > box[2] || c.z < box[1] || c.z > box[3]) return false
      if (!knownRing(bot, c, 1)) return false // the destination and its ring must be READABLE before a foot leaves the ground
      if (!BL().standable(bot, c)) return false
      const u = bot.blockAt(c.offset(0, -1, 0)); if (!u || u.boundingBox !== 'block' || /lava|magma/.test(u.name)) return false
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) { const b = bot.blockAt(c.offset(dx, dy, dz)); if (b && /^(lava|fire)$/.test(b.name)) return false }
      // NEAR A DROP THE PATHFINDER IS NEVER ASKED: one cell, by hand, sneaking (16:53:11Z cost a bot and a kit)
      // ...and a step that RISES is a hop, not a walk: `sneakStep` holds forward against the side of a block for 3.5 s and calls
      // it a failure. A bot that cannot step up cannot walk the stair it is building (07:31-07:34Z), so the rise goes to
      // `climbStep`, which is the same hand-driven single cell with one pulse of jump.
      if (edgeNear(bot, c) || bot.entity.position.distanceTo(c.offset(0.5, 0, 0.5)) < 2.6) return await (c.y > bot.entity.position.floored().y ? climbStep : sneakStep)(bot, api, c)
      sneakOn(bot)
      return !!await nTravel(bot, c, { range: 0, ms: 12000, stop: api.stop })
    } catch (e_) { swallow('jobs_nether:safeStep', e_); return false }
  }
  // Place/clear a list of cells from where the bot stands; when nothing is left in reach, take ONE safe step towards the nearest
  // unfinished cell and go again. Bounded by `until` and by api.stop(); it never scaffolds and never lets the placer walk itself
  // (`place:{noMove:true}`). Returns what was MEASURED, plus what is still left.
  async function buildCells (bot, job, api, cells, box, until, what) {
    let placed = 0; let dug = 0; let steps = 0; let waits = 0
    const held = netherHere(bot)
    if (held) sneakHold(bot, true) // held for the WHOLE build, and no walk inside it may let go (Erika 05:46:19Z paid for the old flag)
    const done = new Set(); const tried = []; const why = {} // cells our own floor cannot reach: REPORTED with the reason, never chased round the box
    try {
    // WAIT FOR THE WORLD BEFORE DECIDING THERE IS NOTHING TO DO (measured 14:49Z: pass after pass came home `unloaded:1330 of
    // 1330` — the chunks of the stair had simply not arrived yet, ~14 s after the gate spat the bot out). Up to 20 s, then work.
    // WAIT FOR THE COLUMNS, NOT FOR THE FIRST BLOCK (09-21: the old test stopped as soon as ONE cell read back — and the first
    // cell to arrive is usually a piece of shelf that is already right, so the pass broke while 1049 cells were still unknown).
    // Now it waits until MOST of the work is readable, up to 60 s, and says so when it never came.
    const tW = Date.now(); const enough = () => cells.filter(c => loadedAt(bot, c)).length >= Math.max(1, Math.floor(cells.length * 0.6))
    for (let w = 0; w < 120 && !api.stop() && Date.now() < until && !enough(); w++) { task(bot, 'nether ' + what + ': waiting for the world (' + cells.filter(c => loadedAt(bot, c)).length + '/' + cells.length + ' readable)'); await sleep(500) }
    if (!enough()) A.result(bot, { ev: 'nether_unloaded', job: job.id, work: what, cells: cells.filter(c => !loadedAt(bot, c)).length, of: cells.length, waitedS: Math.round((Date.now() - tW) / 1000), at: xyz(bot.entity.position), why: 'the chunks of this work never arrived - nothing was placed, dug or judged there' })
    for (let round = 0; round < 120 && Date.now() < until && !api.stop(); round++) {
      // PACING IS NOT WORKING (measured 16:19:08Z: `steps 118, placed 2` — the cells left were pockets sealed under the shelf's
      // own rock, so every round walked to another one and placed nothing). Forty steps without a block is this pass's answer:
      // the trip has a walk to retry and a gate to catch.
      if (steps >= 40 && placed + dug === 0) break
      const todo = cells.filter(c => !done.has(c.x + ',' + c.y + ',' + c.z) && loadedAt(bot, c) && !cellOK(bot, c))
      // AN EMPTY todo IS NOT A FINISHED JOB WHILE THE WORLD IS STILL ARRIVING (measured 09-21 05:46-05:47Z: two passes of the
      // barter lane came home after 30 s of a 9-minute slice with `placed:0-4, unloaded:1053 of 1053`). The wait above stops as
      // soon as ONE cell is readable — and that first cell is usually a piece of the shelf that is already right, so the loop
      // broke while 1049 cells were still loading. Now a pass only gives up when there is nothing left to do AND nothing left to
      // wait for; otherwise it waits out the chunks it came all this way for.
      if (!todo.length) {
        const waiting = cells.filter(c => !loadedAt(bot, c)).length
        if (!waiting || Date.now() >= until - 1000 || api.stop() || ++waits > 90) break // 90 s is generous; the chunks arrive in ~14
        task(bot, 'nether ' + what + ': waiting for ' + waiting + ' cells of the world to arrive')
        await sleep(1000); round--; continue // a wait is not a round of work
      }
      const me = bot.entity.position
      // FLOOR, THEN BOTH RAILS OF THAT LEG, THEN FORWARD (the head is never more than one floor cell ahead of its rails — that is
      // what a player does and what 16:53:11Z cost us). `seq` is the leg index, `rank` 0 = floor, 1 = rail, 2 = headroom.
      const rank = q => q.rim ? 1 : q.block === 'air' ? 2 : 0
      todo.sort((a, b) => ((a.seq == null ? 0 : a.seq) - (b.seq == null ? 0 : b.seq)) || (rank(a) - rank(b)) || (v([a.x, a.y, a.z]).distanceTo(me) - v([b.x, b.y, b.z]).distanceTo(me)))
      let prog = 0
      for (const c of todo) {
        if (Date.now() >= until || api.stop()) break
        if (inGateNow(bot)) { await clearOfGate(bot, api, [], 2); if (inGateNow(bot)) break } // a bot in a portal cell can place nothing
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
      // WALK THE ROAD WE HAVE ALREADY BUILT (measured 16:13:31Z: `placed 0, dug 0, steps 3, left 54` on a causeway whose first
      // half stands — every stand candidate above is within 3 cells of the TARGET, and over a void those cells ARE the void that
      // is still to be bridged. The way to the head of the work is the finished part of it: our own floor, walked read-only.)
      if (!moved) {
        const road = cells.filter(c => c.block === 'stone' && cellOK(bot, c)).map(c => new Vec3(c.x, c.y + 1, c.z))
          .filter(s2 => s2.distanceTo(bot.entity.position) > 1.5 && BL().standable(bot, s2))
          .sort((a, b) => a.distanceTo(tp) - b.distanceTo(tp))
        for (const s2 of road.slice(0, 6)) { if (api.stop()) break; if (await safeStep(bot, api, s2, box)) { moved = true; steps++; break } }
      }
      if (!moved) { tried.push([t.x, t.y, t.z]); if (!why[t.x + ',' + t.y + ',' + t.z]) why[t.x + ',' + t.y + ',' + t.z] = 'no safe stand of ours within reach of it'; done.add(t.x + ',' + t.y + ',' + t.z); continue } // this one cannot be reached from our own floor: leave it, take the next
    }
    } finally { if (held) sneakHold(bot, false) }
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
    // WHICH WAY DOES THE GATE FACE? the frame spans 2 along its own axis and 1 through it; you walk through the SHORT one.
    const alongX = (bx[1] - bx[0]) >= (bz[1] - bz[0])
    // SIZED FOR FIFTY (owner 16:3xZ): 15x15 round the gate, seven clear cells in front of and behind it, both faces exits.
    const RA = 7 // half-width along the frame  -> 15 wide
    const RT = 7 // half-depth through the gate -> 15 deep
    const cell = (a2, t) => alongX ? new Vec3(cx + a2, 0, cz + t) : new Vec3(cx + t, 0, cz + a2)
    const inPortal = c => body.some(q => q.x === c.x && q.z === c.z)
    // NOTHING WITHIN 2 OF A PORTAL FACE (owner: 「ネザーゲート周辺が狭すぎるせいでハングします」 — the old 5x5 put a wall one cell off
    // the frame and bots could not get out of their own landing). Walls live ONLY on the outer rim, and only over a real drop.
    const tooNear = c => { const t = alongX ? Math.abs(c.z - cz) : Math.abs(c.x - cx); const a3 = alongX ? Math.abs(c.x - cx) : Math.abs(c.z - cz); return t <= 3 && a3 <= RA } // nothing within 3 of a portal face
    const floorCells = []; const clearCells = []; const rimCells = []
    for (let a2 = -RA; a2 <= RA; a2++) for (let t = -RT; t <= RT; t++) {
      const c = cell(a2, t)
      floorCells.push(new Vec3(c.x, y0 - 1, c.z))
      if (!inPortal(c)) for (let k = 0; k < 3; k++) clearCells.push(new Vec3(c.x, y0 + k, c.z)) // 3 high clear everywhere
      if ((Math.abs(a2) === RA || Math.abs(t) === RT) && !tooNear(c)) rimCells.push(new Vec3(c.x, y0, c.z)) // a rail, not a cage
    }
    const eye = () => eyeOf(bot)
    let floor = 0; let rail = 0; let out = 0; let lava = 0; let cleared = 0; const t0 = Date.now()
    const lay = async (c, what) => {
      if (api.stop() || floor + rail >= budget || Date.now() - t0 > 150000 || inGateNow(bot)) return false
      const b2 = bot.blockAt(c); if (!b2 || b2.name === 'obsidian' || b2.name === 'nether_portal' || b2.boundingBox === 'block') return false
      if (eye().distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0 || !hasRef(bot, c)) { out++; return false }
      const item = stoneItem(bot); if (!item) return false
      if (b2.name === 'lava') lava++
      task(bot, 'portal: ' + what + ' the landing (' + (floor + rail) + ')')
      return (await placeStill(bot, api, c, item)).ok
    }
    // FLOOR FIRST, nearest column out — a platform you can stand on everywhere is what makes the rest possible
    for (const c of floorCells.slice().sort((x, y) => x.distanceTo(bot.entity.position) - y.distanceTo(bot.entity.position))) if (await lay(c, 'flooring')) floor++
    // then CLEAR the headroom: a landing you cannot walk out of is the bug we are fixing
    for (const c of clearCells.slice().sort((x, y) => x.distanceTo(bot.entity.position) - y.distanceTo(bot.entity.position))) {
      if (api.stop() || Date.now() - t0 > 170000 || inGateNow(bot)) break
      const b2 = bot.blockAt(c); if (!b2 || b2.boundingBox !== 'block' || /obsidian|portal/.test(b2.name)) continue
      if (eye().distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0) { out++; continue }
      const r = await BL().digBlock(bot, c, { collect: true, requireHarvest: false, noMove: true }).catch(() => ({ ok: false }))
      if (r && r.ok) cleared++
    }
    // a RAIL on the outer rim only where the floor really falls away (never a wall beside the gate)
    for (const c of rimCells.slice().sort((x, y) => x.distanceTo(bot.entity.position) - y.distanceTo(bot.entity.position))) {
      const below = bot.blockAt(c.offset(0, -1, 0))
      if (below && below.boundingBox === 'block') continue // solid ground outside: nothing to fall off
      if (await lay(c, 'railing')) rail++
    }
    let torches = 0
    if (A.count(bot, 'torch')) {
      for (const q of [[RA - 1, RT - 1], [-(RA - 1), RT - 1], [RA - 1, -(RT - 1)], [-(RA - 1), -(RT - 1)]]) {
        if (api.stop() || torches >= 4 || !A.count(bot, 'torch') || inGateNow(bot)) break
        const cc = cell(q[0], q[1]); const c = new Vec3(cc.x, y0, cc.z)
        const b2 = bot.blockAt(c); const u = bot.blockAt(c.offset(0, -1, 0))
        if (!b2 || b2.boundingBox === 'block' || inPortal(c) || !u || u.boundingBox !== 'block') continue
        if (eye().distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.0) { out++; continue }
        await placeStill(bot, api, c, 'torch')
        const nb = bot.blockAt(c); if (nb && /torch/.test(nb.name)) torches++
      }
    }
    // THE VERDICT IS READ: holes you could fall through, headroom still blocked, and lava/fire within 5 of the platform
    const holes = floorCells.filter(c => !floorSafe(bot, { x: c.x, y: c.y, z: c.z }))
    const blocked = clearCells.filter(c => { const b2 = bot.blockAt(c); return !!b2 && b2.boundingBox === 'block' && !/obsidian/.test(b2.name) })
    const hotIds = ['lava', 'fire'].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(q => q != null)
    const hot = hotIds.length ? bot.findBlocks({ matching: hotIds, maxDistance: 12, count: 400, point: new Vec3(cx, y0, cz) }) : []
    const near = hot.filter(q => floorCells.some(c => Math.max(Math.abs(q.x - c.x), Math.abs(q.y - c.y), Math.abs(q.z - c.z)) <= 5))
    // ... and only when we are actually standing at this gate (15:26Z: a bot 200 blocks away "measured" 63 holes in a platform
    // it had never seen, because `far` had been found in chunk data that was still the other dimension's)
    const atGate = bot.entity.position.distanceTo(new Vec3(cx + 0.5, y0, cz + 0.5)) < 24
    const safe = atGate && holes.length === 0 && blocked.length === 0 && near.length === 0
    return { floor, rail, torches, cleared, placed: floor + rail, outOfReach: out, lavaPlugged: lava, holes: holes.length, blocked: blocked.length, hotNear: near.length, atGate, safe, box: alongX ? [cx - RA, cz - RT, cx + RA, cz + RT] : [cx - RT, cz - RA, cx + RT, cz + RA], y: y0, cells: floorCells.map(c => ({ x: c.x, y: c.y, z: c.z, block: 'stone' })) }
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
      if (api.stop() || sealed >= budget || Date.now() - t0 > 90000 || inGateNow(bot)) break
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
  // THE EDGE DOCTRINE BELONGS TO EVERY NETHER WALK, NOT TO ONE HANDLER (measured 17:17-17:18Z: the protections written for
  // `work:'pair'` did nothing for `work:'fortress'`, which walked the same ledges and lost Aoi, Fuuka and Koharu to the lava sea
  // at -54..-55,28,-80 inside two minutes — 40 iron, 5 diamond, 479 items). Everything below now applies to `nTravel`, and every
  // Nether job goes through `nTravel`.
  const noFloor = (bot, c, depth = 3) => { for (let dy = -1; dy >= -depth; dy--) { const b = bot.blockAt(c.offset(0, dy, 0)); if (b && b.boundingBox === 'block') return false } return true }
  const lavaTouching = (bot, c) => [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(d => { const b = bot.blockAt(c.offset(d[0], d[1], d[2])); return !!b && /^(lava|fire)$/.test(b.name) })
  const edgeWithin = (bot, c, r = 3) => { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (noFloor(bot, c.offset(dx, 0, dz))) return true; return false }
  async function nTravel (bot, target, opts) {
    lavaSet(bot, true); netherWalkOn(bot)
    const mv = bot.pathfinder && bot.pathfinder.movements; if (mv) mv.maxDropDown = 1
    const tgt = target && target.x != null ? new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)) : null
    if (tgt && netherHere(bot)) {
      // 0. NEVER A GOAL IN GROUND WE CANNOT READ. The pathfinder plans on the chunks it has; where it has none it has no edges,
      //    and a bot that walks to the last cell of a loaded column is standing on the lip of whatever comes next.
      if (!knownRing(bot, tgt, 1)) {
        A.result(bot, { ev: 'nether_unloaded', to: [tgt.x, tgt.y, tgt.z], at: xyz(bot.entity.position), why: 'the chunks at the goal are not loaded - unknown ground is not walked to' })
        return false
      }
      // 1. NEVER A GOAL IN A CELL WITH NO FLOOR OR ONE TOUCHING LAVA — the pathfinder happily walks to the lip of a drop
      if (noFloor(bot, tgt) || lavaTouching(bot, tgt)) {
        A.result(bot, { ev: 'nether_refused', to: [tgt.x, tgt.y, tgt.z], why: noFloor(bot, tgt) ? 'that cell has no floor within 3' : 'that cell touches lava or fire' })
        return false
      }
      // 2. CLOSE TO AN EDGE: one cell at a time, by hand, sneaking — never a pathfinder route that can cut a corner over air
      if (edgeWithin(bot, tgt, 1) && bot.entity.position.distanceTo(tgt.offset(0.5, 0, 0.5)) <= 4.5) return await sneakStep(bot, { stop: (opts && opts.stop) || (() => false) }, tgt)
    }
    // 3. THE EDGE IS WHERE THE BOT IS *NOW*, NOT WHERE IT SET OFF FROM (top model 09-21, reading the 17:17-17:18Z deaths again).
    //    Sneak used to be decided ONCE, from the two ends of the walk — so a hop that started on the middle of a wide shelf and
    //    met a 1-wide arch nine blocks later walked it upright. That is exactly the shape of the ground that killed Aoi, Fuuka
    //    and Koharu at -54..-55,28,-80 inside two minutes. Now the question is asked again twice a second, of the cell the bot is
    //    standing in, for the whole length of every Nether walk: a drop within 2 -> sneak (prismarine-physics stops a sneaking
    //    body at a rim, proven live on a 6-block drop at -328,16,-389), clear ground -> let it walk. The lava picture is refreshed
    //    on the same beat, so lava that flows across the route mid-walk is priced out of the graph before the next step is planned.
    // A CHECK ON A BEAT IS NOT A CHECK (Erika again): a bot walks ~1.7 blocks between two 400 ms samples, so "is there an edge
    // within 2 of where I am NOW?" can read false and be a fall by the time it is asked again. Over there the answer is simply
    // YES: **every Nether walk sneaks for its whole length**, and the hold is what no other walk or build may take away. It costs
    // ~a third of the walking speed on ground that is one long rim; a death costs the kit, the iron, and the road's progress.
    let watch = null
    const nether = netherHere(bot)
    if (nether) {
      sneakHold(bot, true)
      // re-assert, because `clearControlStates()` (sneakStep, the pathfinder's own resets) silently drops it, and refresh the
      // lava picture on the same beat so lava that flows across the route mid-walk is priced out before the next step is planned
      watch = setInterval(() => { try { if (bot.entity && bot.health > 0) { lavaSet(bot); bot.setControlState('sneak', true) } } catch (e_) { swallow('jobs_nether:edgeWatch', e_) } }, 400)
      if (watch.unref) watch.unref()
    }
    try {
      return await A.travel(bot, target, Object.assign({ anyDepth: true, quiet: true }, opts || {}))
    } finally { if (watch) clearInterval(watch); if (nether) sneakHold(bot, false) }
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
  // THE DIMENSION FIELD LAGS, THE WORLD DOES NOT (measured 15:51:51Z: Ichika had been back in the overworld for a minute — she
  // was walking home across the plains and was killed by a mob at -349,-543 — and her next slice still ran the far-side code and
  // reported `portal_through to:"overworld"`, because `bot.game.dimension` still read the_nether). So the packet gets a second
  // opinion from the ground under the bot's feet before anything on the far side runs.
  function netherHere (bot) {
    if (!isNether(bot)) return false
    try {
      const bi = String(biomeOf(bot) || '?')
      if (bi === '?') return true // the column has not arrived yet: the packet is all we have
      if (/nether|crimson|warped|basalt|soul_sand/.test(bi)) return true
      const u = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      return !!u && /netherrack|soul_|basalt|blackstone|magma|nether_|crimson|warped|glowstone|obsidian|lava/.test(u.name)
    } catch (e_) { swallow('jobs_nether:netherHere', e_); return true }
  }
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
          if (eyeOf(bot).distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.2) { await nTravel(bot, new Vec3(a.x, a.y, a.z), { range: 2, ms: 15000, stop: api.stop }); if (eyeOf(bot).distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.5) continue }
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

  // ---------------------------------------------------------------- BARTER NEEDS A PLACE, AND THE PLACE IS NOT WHERE WE LAND
  // 09-21 04:0x-05:1xZ `nether_barter` crossed and came home **36 times and traded nothing**. Every pass ended
  // `nether_pass {work:'barter', why:"too near the hub chest at -37,98,-79"}`: the old test was the bot's CURRENT position and the
  // arrival cells are 10 blocks from that chest, so the job could do nothing but bounce. The spectator camera, flown under the
  // bedrock roof this shift, then measured WHY there was nothing to trade with either — and both facts are terrain, not code:
  //  * our arrival shelf is ONE connected ground of 383 standable cells (x -56..-30 / z -96..-72, y95-103) and it IS nether_wastes
  //    — but **Minecraft never spawns a mob within 24 blocks of a player**, and no cell of that shelf is further than 24 from a
  //    squad standing on it. No piglin can ever appear there, and the census found none: 0 of the 6 in the region.
  //  * all 6 piglins and 17 of the 69 zombified piglins stand on ONE other ground: 291 standable cells, x -69..-52 / z -83..-47,
  //    y100-116, netherrack, with natural rock at y113 three cells over its y109/110 plateau — a roof no ghast can shoot through.
  //  * the cheapest walkable line from our shelf to that plateau (Dijkstra over the camera's solid/air map, cost = blocks that
  //    must be PLACED) is **26 blocks**: west along z-75, a 13-cell span at y96 over the void at x-57, then up the natural ramp.
  // So bartering gets a lane and a pad of its own (`work:'barterspot'`), registered in `settings.nether.barterSpot`, and
  // `work:'barter'` walks there and trades. The pad centre -65,110,-72 is 32 blocks from the hub chest, which is the distance
  // Paper's `piglins-guard-chests: true` asks for (vanilla angers every piglin within 16 of a container that is OPENED or BROKEN;
  // we never open one over there — the loot is banked at home).
  // The trading rules a player follows and a bot must too: wear at least ONE gold armour piece or every piglin in sight turns
  // hostile; NEVER attack a piglin (`util.js HOSTILE` has neither `piglin` nor `zombified_piglin`, so the melee reflex leaves the
  // 17 zombified piglins on that ground alone); drop ONE ingot at a time at an ADULT within 8 and pick up what comes back;
  // babies barter nothing. Paper `entity-activation-range.monsters: 32`: a piglin further than 32 from a bot barely ticks and will
  // never finish examining the gold, so the squad STANDS among them.
  const barterOf = P => {
    const S = netherOf().barterSpot || {}
    const at = Array.isArray(P.at) ? P.at : (Array.isArray(S.at) ? S.at : null)
    const stand = Array.isArray(P.stand) ? P.stand : (Array.isArray(S.stand) ? S.stand : at)
    const route = (Array.isArray(P.route) && P.route.length) ? P.route : (Array.isArray(S.route) ? S.route : [])
    return { at, stand, route, built: !!S.built }
  }
  // A LANE IS A ROAD FOR THE NEXT 1000 TRIPS (owner 09-21 「何度も通るであろう道は先に整備し」), never a private shortcut: the measured
  // line is the spine, the lane is `width` walkable cells wide with a one-block kerb on each rim (a ghast's fireball SHOVES, it
  // does not kill — the kerb is what keeps the shoved bot on the road), 3 cells of headroom, and a torch on top of the kerb every
  // `torchEvery` legs. Cells that already read solid cost nothing (`cellOK` skips them), so a lane over rock is free and only the
  // spans over void are actually built. `seq` = the leg index, so `buildCells` lays floor, then that leg's rails, then moves on.
  function laneCells (route, width, torchEvery) {
    const at = new Map() // one block per cell: floor (rank 0) beats kerb (1) beats torch (2) beats cleared headroom (3)
    const put = (x, y, z, block, rank, rim, seq) => { const k = x + ',' + y + ',' + z; const cur = at.get(k); if (cur && cur.rank <= rank) return; at.set(k, { x, y, z, block, rim: !!rim, seq, rank }) }
    const w = Math.max(1, Math.min(width || 3, 5)); const half = Math.floor(w / 2)
    for (let i = 0; i < route.length; i++) {
      const p = route[i]; const a = route[i - 1] || p; const b = route[i + 1] || p
      const lat = Math.abs(b[0] - a[0]) >= Math.abs(b[2] - a[2]) ? [0, 1] : [1, 0] // perpendicular to travel
      // `width:1` = a BARE SPINE, no kerbs (owner 09-21, dragon deadline): with a bare kit and `moves.bridgeTo` laying the floor
      // under a sneaking bot, the spine is what gets us to the piglins TODAY; the widening and the rails are a later pass on a
      // road that already exists. Any width >= 3 builds the full lane with a kerb on each rim.
      const lo = w <= 1 ? 0 : -half - 1; const hi = w <= 1 ? 0 : half + 1
      for (let o = lo; o <= hi; o++) {
        const x = p[0] + lat[0] * o; const z = p[2] + lat[1] * o; const rim = Math.abs(o) > half
        put(x, p[1] - 1, z, 'stone', 0, false, i)
        if (rim) put(x, p[1], z, 'stone', 1, true, i)
        else for (let k = 0; k < 3; k++) put(x, p[1] + k, z, 'air', 3, false, i)
      }
      if (torchEvery && i && i % torchEvery === 0) put(p[0] + lat[0] * (half + 1), p[1] + 1, p[2] + lat[1] * (half + 1), 'torch', 2, false, i)
    }
    return [...at.values()]
  }
  // THE PAD: ONE SITE, ONE HEIGHT (owner, both dimensions). The level is the MEDIAN ground of the whole box read back from the
  // world — never the centre column's own knoll, which is what left `pair_built overVoid:139 of 225` floating over the shelf —
  // and a column with no support within 3 below is dropped from the plan, never bridged. Kerb on the whole boundary, torches on a
  // pitch of 8 (nether mobs ignore light, so the torches are for OUR eyes and the camera, not for spawn-proofing), no roof: the
  // rock over this ground already stands 3 cells up.
  function padCells (bot, at, half, seq0) {
    const cx = Math.floor(at[0]); const cz = Math.floor(at[2]); const y0 = Math.floor(at[1])
    const ground = new Map(); const ys = []
    for (let dx = -half - 1; dx <= half + 1; dx++) for (let dz = -half - 1; dz <= half + 1; dz++) {
      for (let dy = 2; dy >= -3; dy--) {
        const b = bot.blockAt(new Vec3(cx + dx, y0 - 1 + dy, cz + dz))
        if (b && b.boundingBox === 'block' && !/^(lava|magma_block)$/.test(b.name)) { ground.set(dx + ',' + dz, y0 - 1 + dy); if (Math.abs(dx) <= half && Math.abs(dz) <= half) ys.push(y0 - 1 + dy); break }
      }
    }
    ys.sort((a, b) => a - b)
    const floorY = ys.length >= (2 * half + 1) ? ys[Math.floor(ys.length / 2)] : y0 - 1
    const cells = []; let overVoid = 0
    for (let dx = -half - 1; dx <= half + 1; dx++) for (let dz = -half - 1; dz <= half + 1; dz++) {
      const rim = Math.abs(dx) > half || Math.abs(dz) > half
      const g = ground.get(dx + ',' + dz)
      if (g == null || g < floorY - 3) { overVoid++; continue } // no support within 3: dropped from the plan, never bridged
      cells.push({ x: cx + dx, y: floorY, z: cz + dz, block: 'stone', rim: false, seq: seq0 })
      if (rim) cells.push({ x: cx + dx, y: floorY + 1, z: cz + dz, block: 'stone', rim: true, seq: seq0 + 1 })
      else for (let k = 1; k <= 3; k++) cells.push({ x: cx + dx, y: floorY + k, z: cz + dz, block: 'air', rim: false, seq: seq0 + 2 })
    }
    for (const [dx, dz] of [[-half - 1, -half - 1], [half + 1, -half - 1], [-half - 1, half + 1], [half + 1, half + 1]]) {
      if (ground.get(dx + ',' + dz) == null) continue
      cells.push({ x: cx + dx, y: floorY + 2, z: cz + dz, block: 'torch', rim: false, seq: seq0 + 3 })
    }
    return { cells, floorY, overVoid, box: [cx - half - 1, cz - half - 1, cx + half + 1, cz + half + 1] }
  }
  // ---------------------------------------------------------------- A SPAN OVER THE VOID IS A LIBRARY CALL, NOT HAND-PLACEMENT
  // Both deaths of 09-21 happened the same way: a bot standing at the rim of the lane's first leg, hand-placing floor cells into
  // 70 blocks of nothing. `moves.bridgeTo` is the one method that has never lost a bot here — the pathfinder places its own
  // scaffolding inside a corridor, with sneak re-asserted every tick and the terrain guard's time-boxed opt-out. So: measure the
  // gap first (`voidSize`, the terrain engineer's ONE implementation, required lazily), then bridge it in spans of <= 6, then let
  // `buildCells` widen and rail that span from the spine before the next one is opened.
  const VOID = () => { try { return require('./jobs_cavity').voidSize } catch (e_) { swallow('jobs_nether:voidSize', e_); return null } }
  const MOVES = () => { try { return require('./moves') } catch (e_) { swallow('jobs_nether:moves', e_); return null } }
  async function spanAhead (bot, job, api, route, until) {
    const mv = MOVES(); if (!mv || !mv.bridgeTo) return { spans: 0, placed: 0, why: 'moves.bridgeTo is not available' }
    let spans = 0; let placed = 0; const notes = []
    for (let guard = 0; guard < 8 && Date.now() < until && !api.stop(); guard++) {
      const here = bot.entity.position.floored()
      // the head of the road we already have = the last route cell with a floor we can read; the next unsupported one is the gap
      let head = -1
      for (let i = 0; i < route.length; i++) { const c = route[i]; if (!knownRing(bot, new Vec3(c[0], c[1], c[2]), 0)) break; const u = bot.blockAt(new Vec3(c[0], c[1] - 1, c[2])); if (u && u.boundingBox === 'block' && !/lava/.test(u.name)) head = i; else break }
      if (head < 0 || head >= route.length - 1) break
      const from = route[head]; const to = route[Math.min(head + 6, route.length - 1)] // spans of at most 6, then widen and rail
      // MEASURE THE GAP BEFORE TOUCHING IT (owner 09-21): a 3-cell step is bridged, the open lava sea never is
      const vs = VOID(); let gap = null
      if (vs) { try { gap = vs(bot, new Vec3(from[0], from[1] - 1, from[2]).offset(Math.sign(to[0] - from[0]), 0, Math.sign(to[2] - from[2])), { cap: 900, radius: 24 }) } catch (e_) { swallow('jobs_nether:gapSize', e_) } }
      // WHAT THE MEASUREMENT IS FOR. `voidSize` at the head of this lane reads **900 cells (capped), klass 'cavern', h 37** — the
      // open cavern both bots fell into on 09-21. That number says one thing loudly: this gap is NEVER to be FILLED, and a bot
      // must never stand beside it hand-placing floor, which is exactly what killed Erika and Chika. It does NOT say "do not
      // cross": `moves.bridgeTo` carries its own floor under a sneaking body, so what matters for a CROSSING is whether the line
      // runs next to lava, not how big the room underneath is. So: lava in the connected air is a refusal, volume is a warning.
      if (gap && gap.touchesLava) {
        A.result(bot, { ev: 'nether_gap', job: job.id, at: from, gap: { cells: gap.cells, klass: gap.klass, h: gap.h, touchesLava: true, capped: gap.capped }, why: 'the air this span would cross touches lava - not bridged, the lane is re-routed instead' })
        notes.push('lava in the gap at ' + from.join(',')); break
      }
      if (gap && (gap.klass === 'cavern' || gap.capped)) A.result(bot, { ev: 'nether_gap', job: job.id, at: from, gap: { cells: gap.cells, klass: gap.klass, h: gap.h, touchesLava: false, capped: gap.capped }, why: 'an open cavern, not a step: never filled and never hand-placed from the rim - crossed only by moves.bridgeTo, which lays its own floor under a sneaking bot' })
      if (bot.entity.position.distanceTo(new Vec3(from[0] + 0.5, from[1], from[2] + 0.5)) > 2 && !await nTravel(bot, new Vec3(from[0], from[1], from[2]), { range: 1, ms: 40000, stop: api.stop })) { notes.push('cannot reach the head ' + from.join(',')); break }
      task(bot, 'nether lane: bridging ' + from.join(',') + ' -> ' + to.join(','))
      // CARRY THE BRIDGE OR DO NOT GO (09-21 07:07:11Z: the first real span came back `ok:false, placed:0, "No path to the goal!"`
      // and the bot was carrying ZERO stone - the bare kit had left the builder with nothing to build from). `bridgeTo` needs
      // |dx|+|dz|+2 blocks; the count goes into the event so this is never diagnosed twice. `half:1` gives the pathfinder a
      // 3-wide corridor to plan in - a 1-wide line leaves it no room to step aside while it places.
      const blocks = SHELL_STONE.filter(n => A.count(bot, n) > 0)
      const carry = stoneCarried(bot); const need = Math.abs(to[0] - from[0]) + Math.abs(to[2] - from[2]) + 2
      if (carry < need) { A.result(bot, { ev: 'nether_span', job: job.id, from, to, ok: false, placed: 0, carried: carry, need, why: 'nothing to bridge with: the crossing kit must carry the span (params.cobble), and params.bare must not strip it' }); notes.push('no blocks: ' + carry + '/' + need); break }
      const r = await mv.bridgeTo(bot, [to[0], to[1], to[2]], { half: 1, ms: 90000, stop: api.stop, blocks }).catch(e_ => { swallow('jobs_nether:bridgeTo', e_); return { ok: false, why: 'threw' } })
      sneakOn(bot) // bridgeTo drops sneak in its own finally; over here it goes straight back on
      spans++; placed += (r && r.placed) || 0
      A.result(bot, { ev: 'nether_span', job: job.id, from, to, ok: !!(r && r.ok), placed: (r && r.placed) || 0, carried: carry, need, at: xyz(bot.entity.position), gap: gap ? gap.klass + ' ' + gap.cells : null, why: (r && r.why) || undefined })
      if (!r || !r.ok) { notes.push(String((r && r.why) || 'span failed')); break }
      break // ONE span per pass: it is widened and railed by buildCells before the next is opened
    }
    return { spans, placed, notes }
  }
  // ---------------------------------------------------------------- A STAIRCASE IS CHEAPER THAN A ROAD (top model 09-21, dragon deadline)
  // The 48-cell lane to the piglin ground was sited by the camera as the cheapest walkable line AT THE ARRIVAL LEVEL, and it cost
  // three bots at -51..-55,98,-75 (Erika, Chika, Honoka) because that line crosses a 900-cell cavern at y98 and every pass built
  // blind over it. Asked again at step 1 with the same camera, but as a different question — "where is the nearest cell we can
  // STAND on within 8 of an adult piglin, counting only blocks we must PLACE?" — the answer is not a road at all: from the SW
  // corner of the arrival shelf (-55,101,-83) a SEVEN-cell staircase of SIX placed blocks,
  //     -55,101,-82  -55,102,-81  -55,103,-80  -55,104,-79  -56,105,-79  -57,106,-79
  // stands 6.4 blocks from the piglin at -57,110,-74. Nothing is bridged, every step is +1, and a step up onto a block placed at
  // your own FOOT level is the one construction move that cannot drop you — you are standing on the reference block while you
  // place it. 6 blocks against 213, and no void over a lava sea.
  // The route is not written down here: a coordinate in code is a coordinate nobody can fix from the board, and the piglins walk
  // about. It is SEARCHED every time over what this bot can actually READ, cost = blocks placed, minimum first (a bucket queue,
  // so the first cell popped inside `reach` is the cheapest one). Unknown chunks are simply not in the graph — rule 1.
  function stairSearch (bot, from, target, opts = {}) {
    const reach = opts.reach || 8; const maxPlace = opts.maxPlace || 48; const R = opts.box || 20
    const tx = target.x; const ty = Math.floor(target.y); const tz = target.z
    const b1 = Math.min(from.x, Math.floor(tx)) - R; const b2 = Math.max(from.x, Math.floor(tx)) + R
    const b3 = Math.min(from.z, Math.floor(tz)) - R; const b4 = Math.max(from.z, Math.floor(tz)) + R
    const y1 = Math.min(from.y, ty) - 6; const y2 = Math.max(from.y, ty) + 6
    // one block cache for BOTH passes and one for the 150-lookup lava question: without them a 48-block budget is seconds of
    // blocked event loop on a live bot, and a bot that does not tick is a bot that does not sneak
    const seen = (opts.cache && opts.cache.blk) || new Map(); const cooled = (opts.cache && opts.cache.cool) || new Map()
    const at = (x, y, z) => {
      const k = x + ',' + y + ',' + z; let s = seen.get(k)
      if (s === undefined) { const b = bot.blockAt(new Vec3(x, y, z)); s = b == null ? null : (/^(lava|fire|magma_block)$/.test(b.name) ? 'hot' : b.boundingBox === 'block' ? 'solid' : 'air'); seen.set(k, s) }
      return s
    }
    const body = (x, y, z) => at(x, y, z) === 'air' && at(x, y + 1, z) === 'air'
    const cool = (x, y, z) => { const k = x + ',' + y + ',' + z; let c = cooled.get(k); if (c === undefined) { c = !lavaNear({ x, y, z }, 2, 3, 2); cooled.set(k, c) } return c }
    const hasSolidFace = (x, y, z) => at(x + 1, y, z) === 'solid' || at(x - 1, y, z) === 'solid' || at(x, y - 1, z) === 'solid' || at(x, y, z + 1) === 'solid' || at(x, y, z - 1) === 'solid'
    const canStand = (x, y, z) => at(x, y - 1, z) === 'solid' && body(x, y, z) && cool(x, y, z)
    const canLay = (x, y, z) => at(x, y - 1, z) === 'air' && body(x, y, z) && cool(x, y, z) // we place the floor under it
    const K = (x, y, z) => x + ',' + y + ',' + z
    // A CORRIDOR, AND THE NEAREST CELL FIRST. An unguided flood fill over Nether air is hopeless: walking is free, so cost 0
    // drains the whole 383-cell shelf, and every cost after that is a SHELL through open cavern — tens of thousands of cells
    // before the budget is half spent, and the search comes back "no stair" having never looked at the plateau. So the graph is
    // cut to a corridor `wide` cells either side of the straight line bot -> piglin, and the frontier is a heap keyed on
    // (blocks placed, then distance to the target): cost stays the primary key, so the answer is still the CHEAPEST stair, but it
    // is found walking towards the piglin instead of away from it.
    const ax = from.x; const az = from.z; const bx = Math.floor(tx); const bz = Math.floor(tz)
    const ddx = bx - ax; const ddz = bz - az; const L2 = ddx * ddx + ddz * ddz
    const wide = opts.wide || 8
    const inCorridor = (x, z) => {
      let u = L2 ? ((x - ax) * ddx + (z - az) * ddz) / L2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u
      return Math.hypot(x - (ax + u * ddx), z - (az + u * ddz)) <= wide
    }
    const dTo = (x, y, z) => Math.sqrt((x + 0.5 - tx) ** 2 + (y - target.y) ** 2 + (z + 0.5 - tz) ** 2)
    const heap = []; const hpush = (key, n) => { heap.push([key, n]); let i = heap.length - 1; while (i > 0) { const p2 = (i - 1) >> 1; if (heap[p2][0] <= heap[i][0]) break; const t2 = heap[p2]; heap[p2] = heap[i]; heap[i] = t2; i = p2 } }
    const hpop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; const t2 = heap[m]; heap[m] = heap[i]; heap[i] = t2; i = m } } return top }
    const dist = new Map(); const prev = new Map()
    dist.set(K(from.x, from.y, from.z), 0); hpush(0, [from.x, from.y, from.z, 0])
    let pops = 0
    {
      while (heap.length) {
        if (++pops > (opts.pops || 30000)) return null
        const [, [x, y, z, c]] = hpop(); const k = K(x, y, z)
        if (dist.get(k) !== c) continue
        const d = Math.sqrt((x + 0.5 - tx) ** 2 + (y - target.y) ** 2 + (z + 0.5 - tz) ** 2)
        // `natural` = the goal must be REAL GROUND, not the last block of our own pillar. The piglins wander over a plateau at
        // y107-116 while the shelf is at y98, so the climb is the investment and where it ENDS decides whether the next trade is
        // a walk or another stair: a first pass asks for a landing on their own ground, and only then do we settle for a perch.
        if (d <= reach && !(x === from.x && y === from.y && z === from.z) && (!opts.natural || at(x, y - 1, z) === 'solid')) {
          const route = []; for (let q = k; q && q !== K(from.x, from.y, from.z); q = prev.get(q)) route.unshift(q.split(',').map(Number))
          return { cost: c, at: [x, y, z], d: Math.round(d * 10) / 10, route }
        }
        // ONLY FLAT AND ONLY UP. A sneaking body is stopped at every rim by prismarine-physics — which is exactly what keeps it
        // alive, and also what makes it unable to step DOWN a block. We are climbing to a plateau, so a descent is not needed;
        // planning one would only plan a step the bot cannot take (07:27Z, `could not step onto -50,99,-88`).
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
          const nx = x + dx; const ny = y + dy; const nz = z + dz
          if (nx < b1 || nx > b2 || nz < b3 || nz > b4 || ny < y1 || ny > y2) continue
          if (!inCorridor(nx, nz)) continue
          if (dy === 1 && at(x, y + 2, z) !== 'air') continue // no headroom over our own head to climb
          // A BLOCK NEEDS SOMETHING TO BE PLACED AGAINST, and the plan has to know it (07:26:59Z: a 23-block stair died on its
          // FIRST cell, `nothing to place the stair block at -53,98,-74 against`). The floor we are about to lay must touch a
          // face of something solid: natural rock, or the floor we are standing on — and that second case only happens on a FLAT
          // step, because a floor one up and one across is diagonal to ours. So a climb only goes up where rock is beside it,
          // which is the honest physical truth: you cannot build a staircase up through empty air without pillaring, and
          // pillaring is what the doctrine forbids.
          const w = canStand(nx, ny, nz) ? 0 : (canLay(nx, ny, nz) && (hasSolidFace(nx, ny - 1, nz) || dy === 0)) ? 1 : null
          if (w === null || c + w > maxPlace) continue
          const nk = K(nx, ny, nz); if (dist.get(nk) != null && dist.get(nk) <= c + w) continue
          dist.set(nk, c + w); prev.set(nk, k); hpush((c + w) * 1000 + Math.min(999, Math.round(dTo(nx, ny, nz))), [nx, ny, nz, c + w])
        }
      }
    }
    return null
  }
  // Walk that staircase: for every cell in order, place its floor from where we already stand (never moving to place — `placeStill`),
  // then take ONE hand-driven sneaking step onto it. Sneak is held for the whole climb and the ring of every cell is re-read before
  // a foot leaves the ground, so an unloaded chunk stops the climb instead of ending it in the lava sea.
  async function stairTo (bot, job, api, until, target, opts = {}) {
    lavaSet(bot, true)
    const t0 = Date.now(); const from = bot.entity.position.floored()
    // EVERY refusal is REPORTED. The first cut of this returned quietly, so four failed attempts looked exactly like "no piglin
    // came" in the log and cost a slice to tell apart (07:2xZ).
    const no = why => { A.result(bot, { ev: 'nether_stair', job: job.id, at: xyz(from), target: target && target.x != null ? xyz(target) : String(target), ok: false, placed: 0, why }); return { ok: false, placed: 0, why } }
    if (!target || target.x == null || target.y == null) return no('stairTo was given no target position (an entity is not a position)')
    if (!safeStand(bot)) return no('the ground we stand on is not safe to build from (lava within 2, or fewer than 8 walkable cells)')
    if (stoneCarried(bot) < 8) return no('only ' + stoneCarried(bot) + ' blocks carried - a stair needs params.cobble through the gate')
    const cache = { blk: new Map(), cool: new Map() }
    const plan = stairSearch(bot, from, target, Object.assign({ natural: true, cache }, opts)) || stairSearch(bot, from, target, Object.assign({ cache }, opts))
    if (!plan) return no('no stair of ' + (opts.maxPlace || 48) + ' blocks or fewer reaches within ' + (opts.reach || 8) + ' of ' + xyz(target).join(',') + ' through ground we can read (it is ' + Math.round(Math.abs(Math.floor(target.y) - from.y)) + ' up and ' + (Math.abs(Math.floor(target.x) - from.x) + Math.abs(Math.floor(target.z) - from.z)) + ' across)')
    A.result(bot, { ev: 'nether_stair', job: job.id, from: xyz(from), to: plan.at, target: xyz(target), place: plan.cost, cells: plan.route.length, dToPig: plan.d })
    // THE PLACING IS `buildCells`, NOT A SECOND IMPLEMENTATION OF IT. A hand-rolled loop of my own lost a whole shift to the
    // things that engine already knows: what is in reach of an eye, what has a face to be placed against, when to wait for the
    // chunks, and - the part that makes a STAIR possible at all - when nothing is in reach, take ONE safe step towards the
    // nearest unfinished cell, including along the floor we have just laid. It built the 413-cell hub and both landings.
    // So the search says WHICH cells, in order (`seq` = the leg index, so the engine lays them from the bottom up), and the
    // engine lays them. The last cell gets a skirt: the pearls come back as items on the ground and nobody picks them up off a
    // 1-wide pillar.
    const cells = plan.route.map((c, i) => ({ x: c[0], y: c[1] - 1, z: c[2], block: 'stone', seq: i }))
    const end = plan.at
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) cells.push({ x: end[0] + dx, y: end[1] - 1, z: end[2] + dz, block: 'stone', seq: plan.route.length + 1 })
    const xs = cells.map(c => c.x); const zs = cells.map(c => c.z)
    const box = [Math.min(...xs) - 3, Math.min(...zs) - 3, Math.max(...xs) + 3, Math.max(...zs) + 3]
    const r = await buildCells(bot, job, api, cells, box, until, 'barter stair')
    // WALK WHAT NOW STANDS. The goal is not a guess and not a piglin: it is a cell of our own floor that this bot's own search
    // reached over blocks it can read. That is the difference between this walk and the two that ended in the lava sea.
    if (r.placed || r.done) await nTravel(bot, v(end), { range: 1, ms: Math.min(60000, Math.max(15000, until - Date.now())), stop: api.stop })
    const arrived = bot.entity.position.distanceTo(v(end).offset(0.5, 0, 0.5)) <= 2.5
    const out = { ok: arrived, placed: r.placed, planned: plan.cost, left: r.left, steps: r.steps, unloaded: r.unloaded, done: r.done, of: r.of, leftAt: r.leftAt, to: end, at: xyz(bot.entity.position), s: Math.round((Date.now() - t0) / 1000), why: arrived ? undefined : 'the stair is ' + r.left + ' cells short of ' + end.join(',') }
    A.result(bot, Object.assign({ ev: 'nether_stair', job: job.id, target: xyz(target) }, out))
    return out
  }
  async function barter (bot, job, api, P, until) {
    // 1. THE GOLD THAT KEEPS THEM NEUTRAL: any worn gold piece will do, a helmet is the cheapest (5 ingots)
    const worn = [5, 6, 7, 8].map(q => bot.inventory.slots[q]).filter(Boolean).map(i => i.name)
    if (!worn.some(n => /^golden_/.test(n))) {
      if (!A.count(bot, 'golden_helmet')) await A.obtain(bot, 'golden_helmet', 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:goldHelm', e_))
      const gh = bot.inventory.items().find(i => /^golden_(helmet|chestplate|leggings|boots)$/.test(i.name))
      if (gh) { try { await U.withTimeout(bot.equip(gh, gh.name === 'golden_helmet' ? 'head' : gh.name === 'golden_chestplate' ? 'torso' : gh.name === 'golden_leggings' ? 'legs' : 'feet'), 5000, 'wearGold') } catch (e_) { swallow('jobs_nether:wearGold', e_) } }
    }
    if (![5, 6, 7, 8].map(q => bot.inventory.slots[q]).filter(Boolean).some(i => /^golden_/.test(i.name))) return { work: 'barter', why: 'no gold armour piece to wear - every piglin in sight would turn hostile' }
    // 2. GET WITHIN 8 OF AN ADULT PIGLIN — that is the WHOLE requirement of a barter (owner 09-21, dragon deadline). Not a lane,
    //    not a pad, not a cavern crossed. THE PAD IS USED ONLY WHEN IT STANDS: while it does not, the bot never walks towards it,
    //    because that walk is what killed Wakana (07:02:45Z, -55,28,-79, 17 diamonds and 159 items into the lava sea) — `nTravel`
    //    refuses a GOAL over a void, but the 20 blocks of rim between here and there are the pathfinder's business, not ours.
    //    Instead the bot goes to the nearest piglin it can SEE, and where walking cannot arrive it builds a staircase (above).
    const isAdult = e => e && e.name === 'piglin' && e.position && !(e.metadata && e.metadata[17] === true)
    const adults = r => Object.values(bot.entities).filter(e => isAdult(e) && e.position.distanceTo(bot.entity.position) <= r)
    // A ZOMBIFIED PIGLIN IS NOT A PIGLIN AND THE REPORT MUST NOT SAY IT IS (07:2xZ: `pigsSeen: 30` was thirty zombie pigmen and
    // sent a whole shift looking for a way to reach them; the live piglins were five, on a plateau at y107-116, 20 blocks off).
    const anyPig = r => Object.values(bot.entities).filter(e => e && /^(piglin|zombified_piglin)$/.test(e.name) && e.position && e.position.distanceTo(bot.entity.position) <= r).length
    const zombies = r => Object.values(bot.entities).filter(e => e && e.name === 'zombified_piglin' && e.position && e.position.distanceTo(bot.entity.position) <= r).length
    const nearestAdult = () => Object.values(bot.entities).filter(isAdult).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    // WHERE A BOT WAITS IS A DESIGN DECISION, AND THE WRONG ONE HAS KILLED FOUR. Erika, Chika, Honoka and Chino all ended in the
    // lava sea at -51..-55,26..28,-75: the lip of the 900-cell cavern, three of them while the code thought they were safe and
    // Chino (07:28:28Z) while literally `waiting for a piglin`. Sneak stops a body that WALKS at a rim; it does nothing for one
    // that is SHOVED, and a zombified piglin wandering past on a 1-wide lip is a shove. So the bot remembers the wide arrival
    // ground it came in on and goes back to it to wait — the stair is built from the rim, but nobody stands there doing nothing.
    const anchor = bot.entity.position.floored()
    const S0 = barterOf(P); const stand = S0.stand; const built = !!S0.built && Array.isArray(stand)
    if (built) {
      const roster = A.settings().roster || []
      const idx = Math.max(0, roster.indexOf(bot.username))
      const tgt = v(stand).offset((idx % 5) - 2, 0, (Math.floor(idx / 5) % 5) - 2) // fifty bots, not one: a pad cell each
      if (bot.entity.position.distanceTo(tgt) > 5) {
        task(bot, 'nether barter: walking to the spot ' + stand.join(','))
        await nTravel(bot, tgt, { range: 2, ms: Math.min(150000, Math.max(20000, until - Date.now() - 60000)), stop: api.stop })
      }
    }
    // 3. A CONTAINER OF OURS WITHIN 16 IS THE ONE THING THAT WOULD ANGER THEM. We never open one here; it is reported, not obeyed.
    const cids = ['chest', 'trapped_chest', 'barrel'].map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
    const box2 = cids.length ? bot.findBlocks({ matching: cids, maxDistance: 16, count: 1 }) : []
    if (box2.length) A.result(bot, { ev: 'barter_chest_near', job: job.id, at: xyz(box2[0]), why: 'a container of ours stands within 16 of the barter spot - opening or breaking it would anger every piglin here (paper piglins-guard-chests)' })
    // 4. TRADE, and MEASURE: pearls per 64 gold is the number this whole front is judged by.
    const roam = Math.max(4, Math.min(P.roam || 16, 32))
    const pearls0 = A.count(bot, 'ender_pearl'); const gold0 = A.count(bot, 'gold_ingot')
    let offered = 0; let back = 0; let seen = 0; let stairs = 0; let stairPlaced = 0; let dry = 0; const notes = []
    const t0 = Date.now()
    let adultsMax = 0
    while (Date.now() < until && !api.stop() && A.count(bot, 'gold_ingot') > 0) {
      seen = Math.max(seen, anyPig(32)); adultsMax = Math.max(adultsMax, adults(48).length)
      let t = adults(8)[0]
      if (!t) {
        const far2 = nearestAdult()
        if (far2) {
          // NEVER A PATHFINDER ROUTE TOWARDS A PIGLIN. It is the third death on the same shape and the second on this job: the
          // piglins live on a plateau that is NOT connected to our shelf, `nTravel` accepts the goal (it reads solid ground under
          // the piglin, no lava, chunks loaded) and then the pathfinder walks the bot at the void between the two grounds —
          // Wakana 07:02:45Z at -55,28,-79 "walking to the spot", and 07:23:43Z at -53,28,-77 "walking to a piglin at
          // -69,113,-73", 18 iron and 7 diamonds each. The edge doctrine cannot save a route it did not plan.
          // So there is ONE way to a piglin and it is `stairTo`: a cell list found over blocks we can READ, then cell by cell, each
          // ring re-read, each foot moved by a hand-driven sneakStep, placing a floor only where there is none. Where the route
          // costs nothing to build it IS the walk; where it costs blocks it is the stair. Same code, no pathfinder, no gamble.
          // `roam` bounds the chase: a piglin 40 blocks off over strange ground is not worth a staircase, it is worth waiting for
          // ONE GOAL, AND THE SAME GOAL FOR EVERY BOT AND EVERY TRIP. Piglins wander, so re-reading "the nearest adult" before
          // every attempt started a NEW stair towards a NEW piglin: 5 attempts, 4 blocks placed, nothing finished (07:33Z). But
          // the registered pad centre -65,111,-72 is the WRONG shared goal - it is 26+ blocks away and only by a route that goes
          // DOWN first, which a crouched bot cannot walk, so every search refused it (07:35-07:36Z, `no stair of 48 or fewer`).
          // So the goal is the first adult piglin we can actually reach, and it is written to the BOARD: the next bot reads it,
          // aims at the same cell, and the blocks this one laid read back as free ground to its search. The stair GROWS across
          // trips instead of restarting - the same doctrine as every road we build, one thing built once for everybody.
          const NB = netherOf().barterGoal
          let goal = NB && Array.isArray(NB.at) && Date.now() - (NB.t || 0) < 3600000 ? v(NB.at) : null
          if (!goal) { goal = (nearestAdult() || far2).position.floored(); netherEdit({ barterGoal: { at: xyz(goal), t: Date.now(), by: bot.username, why: 'the piglin this stair is aimed at - every bot extends the same stair' } }) }
          if (far2.position.distanceTo(bot.entity.position) <= roam && stairs < (P.stairs || 3) && Date.now() < until - 45000) {
            const st = await stairTo(bot, job, api, Math.min(until - 30000, Date.now() + 240000), goal, { reach: 8, maxPlace: P.maxPlace || 48 })
            // the goal is unreachable for everybody, not just for this bot: drop it so the next attempt picks a fresh piglin
            if (!st.ok && /no stair of/.test(st.why || '')) netherEdit({ barterGoal: null })
            stairs++; stairPlaced += st.placed || 0; if (st.why) notes.push(st.why)
            t = adults(8)[0]
          }
        }
        // (c) PIGLINS WANDER, so standing still is a strategy and coming home is not. The old code gave up after one failed walk
        //     and re-queued for the gate; a bot that waits where they walk trades, and a crossing costs 4.5 s of a queue of six.
        if (!t) {
          dry = nearestAdult() ? 0 : dry + 1
          if (dry > 60) { notes.push('no adult piglin in sight for 3 min'); break }
          if (edgeWithin(bot, bot.entity.position.floored(), 3) && bot.entity.position.distanceTo(anchor) > 3) {
            task(bot, 'nether barter: stepping back off the rim to ' + xyz(anchor).join(','))
            await nTravel(bot, anchor, { range: 2, ms: 20000, stop: api.stop })
          }
          task(bot, 'nether barter: waiting for a piglin (' + adults(48).length + ' adult, ' + zombies(32) + ' zombified within 32)'); await sleep(3000); continue
        }
      }
      dry = 0
      const it = bot.inventory.items().find(i => i.name === 'gold_ingot'); if (!it) break
      task(bot, 'nether barter: ' + offered + ' offered, ' + (A.count(bot, 'ender_pearl') - pearls0) + ' pearls')
      try { await bot.lookAt(t.position.offset(0, 1, 0), true); await U.withTimeout(bot.toss(it.type, null, 1), 5000, 'tossGold'); offered++ } catch (e_) { swallow('jobs_nether:toss', e_); break }
      await sleep(7000) // a piglin examines the gold for about 6 s before it throws something back
      const before = Object.values(A.inv(bot)).reduce((n, x) => n + x, 0)
      // the pearls come back as items on the ground and `pickup` walks to them: over here that walk is held sneaking, because a
      // stair-top stand is a rim and prismarine-physics is what stops a sneaking body at one
      sneakHold(bot, true)
      try { await A.pickup(bot, 7, 4000) } finally { sneakHold(bot, false) }
      back += Math.max(0, Object.values(A.inv(bot)).reduce((n, x) => n + x, 0) - before)
      if (offered === 1) A.result(bot, { ev: 'nether_barter', job: job.id, at: xyz(bot.entity.position), first: true, offered, pearls: A.count(bot, 'ender_pearl') - pearls0, itemsBack: back, piglin: xyz(t.position), why: 'FIRST TRADE ON THIS FRONT - a piglin took our gold' })
    }
    const pearls = A.count(bot, 'ender_pearl') - pearls0
    const loot = {}; for (const [k, n] of Object.entries(A.inv(bot))) if (/pearl|potion|obsidian|glowstone|string|quartz|leather|soul_sand|crying|arrow|iron_nugget/.test(k)) loot[k] = n
    const out = { work: 'barter', offered, itemsBack: back, pearls, per64: offered ? Math.round(pearls / offered * 64 * 10) / 10 : null, pigsSeen: seen, adultsSeen: adultsMax, zombified: zombies(48), stairs, stairPlaced, goldLeft: A.count(bot, 'gold_ingot'), goldTook: gold0, loot, notes: notes.slice(0, 3), min: Math.round((Date.now() - t0) / 6000) / 10 }
    if (offered || seen) A.result(bot, Object.assign({ ev: 'nether_barter', job: job.id, at: xyz(bot.entity.position) }, out))
    else A.result(bot, { ev: 'nether_barter', job: job.id, at: xyz(bot.entity.position), offered: 0, pigsSeen: seen, adultsSeen: adultsMax, zombified: zombies(48), stairs, stairPlaced, notes: notes.slice(0, 3), why: 'stood in the Nether for ' + out.min + ' min and not one piglin came within 32 - this is the wrong ground, not a slow day' })
    return out
  }
  // ---------------------------------------------------------------- PAIR THE GATES EXACTLY (top model 15:4xZ)
  // A gate's partner is not "somewhere near": it is floor(x/8), floor(z/8). Home is -327,68,-518, so its Nether partner is
  // -41,-65. The gate we have sits at -44,-80 — 15 Nether blocks off, i.e. 124 overworld blocks from home, just inside Paper's
  // 128-block search: every return was a coin toss between our gate and a freshly generated one, and that is why gates kept
  // multiplying. So we build the partner where it belongs: probe the column, walk there, platform first (the 7x9 rule), then the
  // frame centred on -41,-65, then light it. Every step reports what it READ.
  // A CAUSEWAY IS A ROAD FOR THE NEXT 1000 TRIPS (doctrine Q2), never a private shortcut: 3 walkable cells wide, a rail on each
  // outer rim so nobody is shoved off, 3 cells of headroom, laid at the ARRIVAL level in an L (z first, then x). It is generated
  // as a plain cell list so `buildCells` lays it from safe stands of its own and reports what it could not reach.
  function causewayCells (from, to, y) {
    const cells = []; const seen = new Set(); const legCells = []
    let cur = null
    let leg = 0
    const add = (x, yy, z, block, rim) => { const k = x + ',' + yy + ',' + z; if (seen.has(k)) return; seen.add(k); const c = { x, y: yy, z, block, rim: !!rim, seq: leg }; cells.push(c); if (cur) cur.push(c) }
    const legs = []
    let cx = Math.floor(from[0]); let cz = Math.floor(from[2])
    while (cz !== Math.floor(to[2]) && legs.length < 96) { cz += Math.sign(Math.floor(to[2]) - cz); legs.push([cx, cz, 'z']) }
    while (cx !== Math.floor(to[0]) && legs.length < 128) { cx += Math.sign(Math.floor(to[0]) - cx); legs.push([cx, cz, 'x']) }
    // FIFTY BOTS, NOT ONE (owner 16:3xZ 「50人でマインクラフトをやっていることを忘れているのでは？」, CLAUDE.md rule 0): a road that
    // carries a 20-bot shift change needs two lanes each way and a spare — 5 walkable cells wide, floor 7 wide, a solid rail on
    // both rims. A RAIL NEEDS SOMETHING TO STAND ON (16:15:09Z: rim cells over the void had no face to be placed against), so the
    // floor runs under the rails too.
    for (const [px, pz, axis] of legs) {
      cur = []; legCells.push(cur); leg++
      for (let o = -3; o <= 3; o++) {
        const x = axis === 'z' ? px + o : px; const z = axis === 'z' ? pz : pz + o
        add(x, y - 1, z, 'stone', Math.abs(o) === 3)
        if (Math.abs(o) <= 2) { for (let k = 0; k < 3; k++) add(x, y + k, z, 'air') } else add(x, y, z, 'stone')
      }
    }
    const xs = cells.map(c => c.x); const zs = cells.map(c => c.z)
    return { cells, legs: legCells, box: [Math.min(...xs) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...zs) + 1], len: legs.length }
  }
  async function pairGate (bot, job, api, P, until) {
    const at = P.at || [-41, null, -65]
    const tx = Math.floor(at[0]); const tz = Math.floor(at[2])
    const here = bot.entity.position.floored()
    // 1. WHAT IS THERE? the highest solid, non-lava block of the column, and the first free cell over it
    // THE BEDROCK ROOF IS A SLAB, NOT A BLOCK (measured 15:57:55Z: `groundY 121` for a column whose floor is 60 blocks under the
    // bot — the scan started at y122, took the first solid under the topmost one for "ground" and reported the roof's underside).
    // So we walk DOWN THROUGH the roof until the first gap, and the ground is the first solid block under THAT.
    let groundY = null; let roofY = null; let sawAir = false
    for (let y = Math.min(122, here.y + 24); y >= 20; y--) {
      const b = bot.blockAt(new Vec3(tx, y, tz)); if (!b) continue
      const solid = b.boundingBox === 'block' && !/lava/.test(b.name)
      if (!sawAir) { if (solid) { if (roofY == null && y > here.y + 2) roofY = y; continue } sawAir = true; continue }
      if (solid) { groundY = y; break }
    }
    if (groundY == null) { A.result(bot, { ev: 'pair_probe', job: job.id, at: [tx, null, tz], from: xyz(here), why: 'the column at ' + tx + ',' + tz + ' is not loaded or has no solid block between y20 and y' + Math.min(122, here.y + 24) }); return { work: 'pair', at: [tx, null, tz], groundY: null, why: 'column unreadable from here' } }
    // WHICH LEVEL? The partner point is an x,z point — the game pairs by column, not by height. So the gate goes on the ground of
    // that column when the ground is where we stand (a road that is level is a road that is safe), and at the ARRIVAL level when
    // the column's floor is far below us: the far gate sits on a ledge at y98 and the floor is ~65 blocks down, and a stair to it
    // is `nether_stair`'s work, not the pairing's.
    // ONE SITE = ONE HEIGHT, AND THE HEIGHT IS THE GROUND THE PLATFORM STANDS ON (measured 17:15:24Z: `pair_built overVoid:139` of
    // 225 — the probe had taken the target column's own little knoll at y101, so the 15x15 sat 4 blocks above the shelf around it
    // and two thirds of it had nothing under it). The level is the MEDIAN ground of the whole platform box: then the pad is
    // LEVELLED into the rock (dig the knolls, fill the dips) instead of floating over it.
    const groundCol = (x, z) => {
      let air = false
      for (let y = Math.min(122, here.y + 24); y >= 20; y--) {
        const b = bot.blockAt(new Vec3(x, y, z)); if (!b) continue
        const sol = b.boundingBox === 'block' && !/lava/.test(b.name)
        if (!air) { if (sol) continue; air = true; continue }
        if (sol) return y
      }
      return null
    }
    const hs = []
    for (let dx = -7; dx <= 7; dx += 2) for (let dz = -7; dz <= 7; dz += 2) { const g = groundCol(tx + dx, tz + dz); if (g != null) hs.push(g) }
    hs.sort((a, b) => a - b)
    const median = hs.length ? hs[Math.floor(hs.length / 2)] : groundY
    const y0 = Math.abs(median + 1 - here.y) <= 6 ? median + 1 : Math.floor(here.y)
    A.result(bot, { ev: 'pair_probe', job: job.id, at: [tx, y0, tz], groundY, medianGround: median, samples: hs.length, spread: hs.length ? (hs[0] + '..' + hs[hs.length - 1]) : '-', roofY, from: xyz(here), atArrivalLevel: y0 !== median + 1, dy: y0 - here.y, d: Math.round(Math.hypot(tx - here.x, tz - here.z)) })
    // 2. CAN WE WALK THERE? read-only, lava-aware, short hops - the walk is tried first and again after any earthworks
    const walk = async () => {
      for (let h = 0; h < 10 && !api.stop() && Date.now() < until; h++) {
        if (!netherHere(bot)) return false // the gate took us home mid-walk: Nether coordinates mean nothing on overworld ground
        const me = bot.entity.position; const dv = new Vec3(tx + 0.5 - me.x, 0, tz + 0.5 - me.z); const len = Math.hypot(dv.x, dv.z)
        if (len < 4) return true
        const k = Math.min(8, len) / len
        const sub = new Vec3(Math.round(me.x + dv.x * k), y0, Math.round(me.z + dv.z * k))
        if (!await nTravel(bot, sub, { range: 2, ms: 25000, stop: api.stop })) break
      }
      return bot.entity.position.distanceTo(new Vec3(tx + 0.5, y0, tz + 0.5)) < 6
    }
    let reached = await walk()
    let bridged = null
    // 2b. NO WALK? THEN LAY THE ROAD. The far gate is on a ledge and the pathfinder is right that there is nowhere to walk; the
    // answer a good player gives is a causeway everybody reuses — 3 wide, railed both sides, level, from where we stand to the
    // partner column. It is built with carried stone from safe stands only, and then the same read-only walk is tried again.
    if (!reached && !netherHere(bot)) return { work: 'pair', at: [tx, y0, tz], groundY, reached: false, why: 'the gate sent me back to the overworld during the walk - nothing is built from here' }
    if (!reached && stoneCarried(bot) >= 32) {
      // WHERE THE ROAD IS BEING BUILT IS ON THE BOARD, so a later trip and an operator can see it (settings.nether.pairRoad).
      const N0 = netherOf()
      const from0 = xyz(bot.entity.position)
      netherEdit({ pairRoad: { from: from0, to: [tx, y0, tz], y: y0, at: Date.now() } })
      // SPAN BY SPAN, WITH THE LIBRARY, NOT BY HAND (owner 17:0xZ 「mineflyerに置きながら移動するのあるのでは？橋建設に利用できそう」).
      // mineflayer-pathfinder bridges by itself: `moves.bridgeTo` hands it scaffolding blocks, a corridor it may not leave, the
      // terrain guard's own time-boxed opt-out and SNEAK on every physics tick (proven live 17:1xZ, a 2-wide 9-deep gap, 0 hp
      // lost). My hand-written spine builder is gone: it was 13 passes of `placed:0` and one bot in the lava sea (16:53:11Z).
      // A span is at most 6 cells; the span is then WIDENED and RAILED from the spine we just walked, and only then the next one -
      // so the head is never more than one span ahead of its rails.
      const MV = require('./moves')
      const spanBlocks = SHELL_STONE.filter(n => A.count(bot, n) > 0)
      let spans = 0; let spanPlaced = 0; let lastWhy = null
      for (let sp = 0; sp < 4 && !reached && Date.now() < until && !api.stop(); sp++) {
        const me = bot.entity.position.floored()
        const dv = new Vec3(tx - me.x, 0, tz - me.z); const len = Math.hypot(dv.x, dv.z)
        if (len < 3) { reached = true; break }
        const k = Math.min(6, len) / len
        const next = [Math.round(me.x + dv.x * k), y0, Math.round(me.z + dv.z * k)]
        const r = await MV.bridgeTo(bot, next, { half: 1, blocks: spanBlocks, ms: 60000, stop: api.stop })
        spans++; spanPlaced += (r.placed || 0); lastWhy = r.why || null
        A.result(bot, { ev: 'pair_span', job: job.id, from: [me.x, me.y, me.z], to: next, ok: !!r.ok, placed: r.placed || 0, tookMs: r.tookMs, hp: bot.health, why: r.why })
        if (!r.ok) break
        // WIDEN AND RAIL THE SPAN WE JUST WALKED, from the spine itself (floor 7 wide, 5 walkable, 2-high rail on both rims)
        const cw = causewayCells([me.x, y0, me.z], next, y0)
        const rb2 = await buildCells(bot, job, api, cw.cells, cw.box, Math.min(until, Date.now() + 90000), 'pair-span-widen')
        A.result(bot, { ev: 'pair_bridge', job: job.id, from: [me.x, me.y, me.z], to: next, span: sp + 1, placed: rb2.placed, dug: rb2.dug, left: rb2.left, of: rb2.of, leftAt: rb2.leftAt })
        bridged = { spans, spanPlaced, widen: rb2.placed, left: rb2.left }
        reached = bot.entity.position.distanceTo(new Vec3(tx + 0.5, y0, tz + 0.5)) < 4 || await walk()
      }
      // A TRIP THAT CROSSED NOTHING IS A BOT AT A LETHAL EDGE (16:40-16:53Z: thirteen empty passes, then the lava sea). Two in a
      // row and the trip goes home; three and the job pauses itself and says what it is waiting for.
      const idle = spanPlaced > 0 || reached ? 0 : ((netherOf().pairIdle || 0) + 1)
      netherEdit({ pairIdle: idle })
      if (!reached && idle >= 2) {
        A.result(bot, { ev: 'pair_idle', job: job.id, passes: idle, at: [tx, y0, tz], spans, why: 'two trips in a row bridged nothing (' + (lastWhy || 'no reason given') + ') - going home rather than standing at the edge' })
        if (idle >= 3) A.boardEdit(b2 => { const j = (b2.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: three trips bridged nothing towards ' + [tx, y0, tz].join(',') + ' (' + (lastWhy || '') + '). Re-site the work or change the design - do not send another bot to that edge' } })
        return { work: 'pair', at: [tx, y0, tz], groundY, reached: false, bridge: bridged, idlePasses: idle }
      }
    }
    if (!reached) {
      A.result(bot, { ev: 'pair_unreachable', job: job.id, at: [tx, y0, tz], stoppedAt: xyz(bot.entity.position), groundY, bridge: bridged, carried: stoneCarried(bot), why: 'no read-only walk to the partner column' + (bridged ? ' even after ' + (bridged.spans || 0) + ' bridged span(s) (' + (bridged.spanPlaced || 0) + ' blocks placed, ' + (bridged.widen || 0) + ' widened)' : ' and too little stone carried to bridge (' + stoneCarried(bot) + ')') })
      return { work: 'pair', at: [tx, y0, tz], groundY, reached: false, bridge: bridged }
    }
    // 3. PLATFORM FIRST, then the frame: both from the cell list, both placed without ever standing in a portal
    const body = []; for (let dx = -1; dx <= 0; dx++) for (let dy = 1; dy <= 3; dy++) body.push(new Vec3(tx + dx, y0 + dy, tz)) // where the portal WILL be
    const plat = []
    // A PLATFORM FOR FIFTY, NOT FOR ONE (owner 16:3xZ 「ネザーゲート周りが狭すぎる」): **15x15 with the gate in the middle**, three
    // cells of headroom over all of it, a solid rail on the whole outer rim (a ghast's fireball knocks bots off, it does not kill
    // them), and seven clear cells in front of AND behind the frame — both faces are exits, and a squad of 20 arriving inside a
    // few seconds has to spread without anyone being shoved back into the portal or over the edge.
    const R = 7
    // WE DO NOT BUILD OVER OPEN AIR ANY MORE (16:53:11Z: Aoi walked off the head of a causeway at y98 and fell 74 blocks into the
    // lava sea). A platform cell is laid only where the world can carry it — solid ground within 3 below — and the cells beyond
    // that are DROPPED from the plan and counted as `overVoid`; the boundary of what stands gets the rail. A 15x15 that is 15x10
    // of real rock with a railed edge is a safe arrival; a 15x15 half of which hangs over a lava sea is a funeral.
    const support = (x, z) => { for (let dy = -1; dy >= -3; dy--) { const b = bot.blockAt(new Vec3(x, y0 - 1 + dy + 1, z)); if (b && b.boundingBox === 'block' && !/lava/.test(b.name)) return true } return false }
    const live = new Set()
    try {
      const pid = bot.registry.blocksByName.nether_portal && bot.registry.blocksByName.nether_portal.id
      if (pid != null) for (const q of bot.findBlocks({ matching: [pid], maxDistance: 32, count: 300 })) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) live.add((q.x + dx) + ',' + (q.y + dy) + ',' + (q.z + dz))
    } catch (e_) { swallow('jobs_nether:platLive', e_) }
    let overVoid = 0
    const carried = (a2, t) => support(tx + a2, tz + t)
    for (let a2 = -R; a2 <= R; a2++) for (let t = -R; t <= R; t++) {
      if (!carried(a2, t)) { overVoid++; continue }
      const rim = Math.abs(a2) === R || Math.abs(t) === R ||
        !carried(a2 + 1, t) || !carried(a2 - 1, t) || !carried(a2, t + 1) || !carried(a2, t - 1) // the edge of what the rock carries
      const push = c => { if (!live.has(c.x + ',' + c.y + ',' + c.z)) plat.push(c) } // never a cell that holds a burning portal
      push({ x: tx + a2, y: y0 - 1, z: tz + t, block: 'stone' })
      if (rim) { push({ x: tx + a2, y: y0, z: tz + t, block: 'stone' }); push({ x: tx + a2, y: y0 + 1, z: tz + t, block: 'stone' }); continue } // 2 high at the edge: knock-back
      for (let k = 0; k < 3; k++) if (!(t === 0 && a2 >= -1 && a2 <= 0)) push({ x: tx + a2, y: y0 + k, z: tz + t, block: 'air' })
    }
    const box = [tx - R - 1, tz - R - 1, tx + R + 1, tz + R + 1]
    const rp = await buildCells(bot, job, api, plat, box, Math.min(until, Date.now() + 150000), 'pair-platform')
    // 4. THE FRAME, from the same blueprint the home gate uses, with an inner column exactly on the partner point
    const fr = bpCells('nether_portal', [tx, y0, tz], { axis: 'x', clear: 3, margin: 3, torch: false })
    const frame = fr.cells.filter(c => c.block === 'obsidian' || (c.block !== 'air' && c.y >= y0 && c.y <= y0 + 4 && Math.abs(c.z - tz) === 0))
    const rf = await buildCells(bot, job, api, frame.map(c => ({ x: c.x, y: c.y, z: c.z, block: c.block === 'obsidian' ? 'obsidian' : 'stone' })), box, Math.min(until, Date.now() + 150000), 'pair-frame')
    const G2 = require(require.resolve(path.join(A.DIR, '..', 'blueprints', 'nether_portal.js'))).geom({ x: tx, y: y0, z: tz }, { axis: 'x' })
    const gaps = frameGaps(bot, G2).length
    let lit2 = litCells(bot, G2.inner).length
    if (!gaps && lit2 < G2.inner.length) { if (A.count(bot, 'flint_and_steel') || await A.obtain(bot, 'flint_and_steel', 1, { stop: api.stop }).catch(() => false)) { await strike(bot, job, api, G2); lit2 = litCells(bot, G2.inner).length } }
    if (!gaps && lit2 >= G2.inner.length) netherEdit({ portal: [tx, y0 + 1, tz], paired: true, pairAt: Date.now(), pairY: y0, oldPortal: netherOf().portal || null })
    A.result(bot, { ev: 'pair_built', job: job.id, at: [tx, y0, tz], platform: rp.placed, platformLeft: rp.left, overVoid, frameGaps: gaps, lit: lit2 + '/' + G2.inner.length, obsidian: A.count(bot, 'obsidian') })
    return { work: 'pair', at: [tx, y0, tz], groundY, reached: true, platform: rp.placed, platformLeft: rp.left, frameGaps: gaps, lit: lit2 }
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
    if (!netherHere(bot)) return { work: String(P.work || ''), why: 'not in the Nether - no far-side work runs from the overworld' }
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
    } else if (work === 'pair') {
      return await pairGate(bot, job, api, P, until)
    } else if (work === 'degate') {
      // TAKE A STRAY FRAME DOWN ON THE FAR SIDE (owner 15:0xZ "余計なネザーゲート壊して"). `degate` on its own is the overworld job;
      // as a `work` it runs inside a crossing, so the frames that stand in the NETHER can be taken down by a bot that got there
      // through our own gate. The registered pair is protected by `degate` itself and is never touched.
      if (!Array.isArray(P.at) || P.at.length !== 3) return { work, why: 'params.at [x,y,z] is missing: which frame comes down?' }
      return Object.assign({ work, at: P.at }, await degate(bot, job, api, P.at))
    } else if (work === 'fortress') {
      return await explore(bot, job, api, P, until)
    } else if (work === 'barter') {
      return await barter(bot, job, api, P, until)
    } else if (work === 'barterspot') {
      // THE LANE AND THE PAD THAT MAKE BARTERING POSSIBLE (see the note over `barter`): the spine was measured by the camera and
      // lives on the BOARD (`params.route`, or `settings.nether.barterSpot.route`), never in this file — a coordinate in code is
      // a coordinate nobody can fix from the board.
      const b2 = barterOf(P)
      if (!Array.isArray(b2.at)) return { work, why: 'params.at [x,y,z] (the pad centre on the piglin ground) is missing' }
      if (!b2.route.length) return { work, why: 'params.route (the measured line from the arrival shelf to the piglin ground) is missing' }
      // THE SPINE IS BRIDGED, THE LANE IS BUILT. One span of <= 6 with `moves.bridgeTo` first (that is the part that killed two
      // bots when it was hand-placed), then `buildCells` widens and rails everything that now has a floor under it.
      const sp = await spanAhead(bot, job, api, b2.route, Math.min(until, Date.now() + 120000))
      const lane = laneCells(b2.route, P.width || 3, 8)
      const pad = padCells(bot, b2.at, Math.max(3, Math.min(P.pad || 4, 7)), b2.route.length + 1)
      st.span = sp
      cells = lane.concat(pad.cells); meta = { at: b2.at, route: b2.route, floorY: pad.floorY, overVoid: pad.overVoid, padBox: pad.box, lane: lane.length, pad: pad.cells.length }
      // THE BOX MUST HOLD THE CELL THE GATE PUTS US IN (measured 14:44Z on the stair: `left:840, placed:0, steps:0` — every
      // safeStep candidate was outside the job's own box and the squad could not walk into its own work)
      const xs2 = cells.map(c => c.x); const zs2 = cells.map(c => c.z)
      box = unionBox([Math.min(...xs2) - 2, Math.min(...zs2) - 2, Math.max(...xs2) + 2, Math.max(...zs2) + 2], null, xyz(bot.entity.position))
    } else return { work, why: 'unknown params.work' }

    if (!cells || !cells.length) return { work, why: 'nothing to build' }
    // THE GATE IS NEVER BUILT OVER: the portal blocks and the obsidian that holds them are dropped from the plan
    const gate = new Set(); for (const q of body) { gate.add(q.x + ',' + q.y + ',' + q.z); for (const d of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) gate.add((q.x + d[0]) + ',' + (q.y + d[1]) + ',' + (q.z + d[2])) }
    cells = cells.filter(c => !gate.has(c.x + ',' + c.y + ',' + c.z))
    // A PASS WORKS WHAT IT CAN SEE (owner 15:3xZ: `nether_pass unloaded:1330, done:0` with a bot standing at the stair head — the
    // pass was judging a 65-block stair through chunks it had not loaded). Only cells within `reach` of the bot count this pass;
    // the rest are reported as `outOfRange`, so the number never pretends the job is finished or untouched.
    const reach = Math.max(24, Math.min(P.reach || 64, 128))
    const here = bot.entity.position
    const all = cells
    cells = all.filter(c => Math.hypot(c.x - here.x, c.z - here.z) <= reach)
    const outOfRange = all.length - cells.length
    const r = await buildCells(bot, job, api, cells, box, until, work)
    r.outOfRange = outOfRange; r.ofAll = all.length
    const min = Math.max(0.1, (Date.now() - t0) / 60000)
    const out = Object.assign({ work, box, y: y0 }, r, { min: Math.round(min * 10) / 10, perBotMin: Math.round((r.placed + r.dug) / min * 10) / 10, carried: stoneCarried(bot) })

    if (work === 'landing') { // the verdict again, read back
      const holes = cells.filter(c => c.block === 'stone' && c.y === y0 - 1 && !floorSafe(bot, c))
      const hotIds = ['lava', 'fire'].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(q => q != null)
      const hot = hotIds.length ? bot.findBlocks({ matching: hotIds, maxDistance: 12, count: 400, point: new Vec3(cx, y0, cz) }) : []
      const near = hot.filter(q => Math.abs(q.x - cx) <= 7 && Math.abs(q.z - cz) <= 7 && Math.abs(q.y - y0) <= 6)
      // AN EMPTY CELL LIST IS NOT A SAFE LANDING (15:26:42Z: the new `reach` filter left `of:0` and the verdict read `safe:true`
      // on nothing at all). A verdict needs cells it actually looked at, and none out of range.
      out.holes = holes.length; out.hotNear = near.length
      out.safe = cells.length > 0 && !outOfRange && holes.length === 0 && near.length === 0
      if (out.safe) netherEdit({ landingSafe: true, landingAt: Date.now(), landing: box, landingY: y0 })
      else netherEdit({ landingSafe: false, landingAt: Date.now() })
    }
    if (work === 'hub' && meta) {
      // the furniture is registered under settings.nether ONLY (the overworld depot must not learn about a chest in another world)
      const stands = { chest: cellOK(bot, { x: meta.chest[0], y: meta.chest[1], z: meta.chest[2], block: 'chest' }), table: cellOK(bot, { x: meta.table[0], y: meta.table[1], z: meta.table[2], block: 'crafting_table' }) }
      out.chest = stands.chest; out.table = stands.table
      netherEdit({ hub: Object.assign({}, meta, { built: r.left === 0, chestStands: stands.chest, tableStands: stands.table, at: Date.now() }) })
    }
    if (work === 'stair' && meta) {
      const reached = !r.left && !r.unloaded && !r.outOfRange
      netherEdit({ stair: { from: Array.isArray(P.from) ? P.from : null, bearing: meta.bearing, end: meta.end, toY: meta.toY, box: meta.box, left: r.left, unloaded: r.unloaded, at: Date.now(), done: reached } })
      if (reached) netherEdit({ floorHub: meta.end })
      out.bearing = meta.bearing; out.end = meta.end; out.toY = meta.toY
    }
    if (work === 'barterspot' && meta) {
      // the pad's own cells decide whether it is finished, not the lane's (a lane pass works only what is within `reach`)
      const padLeft = cells.filter(c => c.seq > meta.route.length && loadedAt(bot, c) && !cellOK(bot, c)).length
      const laneLeft = cells.filter(c => c.seq <= meta.route.length && loadedAt(bot, c) && !cellOK(bot, c)).length
      const built = !padLeft && !laneLeft && !r.outOfRange && !r.unloaded
      netherEdit({ barterSpot: Object.assign({}, N.barterSpot || {}, { at: meta.at, stand: [meta.at[0], meta.floorY + 1, meta.at[2]], route: meta.route, pad: meta.padBox, floorY: meta.floorY, overVoid: meta.overVoid, laneLeft, padLeft, built, t: Date.now() }) })
      out.at2 = meta.at; out.floorY = meta.floorY; out.overVoid = meta.overVoid; out.laneLeft = laneLeft; out.padLeft = padLeft; out.built = built
      if (st.span) { out.spans = st.span.spans; out.bridged = st.span.placed; if (st.span.notes && st.span.notes.length) out.spanWhy = st.span.notes.slice(0, 2) }
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
    // NEVER STEP IN WHILE HOME IS OUT: an unlit overworld gate is what makes the game generate a new one on the way back.
    if (netherOf().lit === false) {
      A.result(bot, { ev: 'home_gate_out', job: job.id, pos: xyz(bot.entity.position), why: 'settings.nether.lit is false - waiting rather than making the game generate a new gate' })
      A.askHelp(bot, 'home_gate_out', 'I am in the Nether and the home gate at ' + ((netherOf().gate) || []).join(',') + ' is not lit: re-light it')
      for (let w = 0; w < 40 && !api.stop() && netherOf().lit === false; w++) await sleep(3000)
      if (netherOf().lit === false) return 'waiting in the Nether: the home gate is out'
    }
    // THE GATE MAY BE BELOW US (measured 17:16Z: Nanami finished a pass standing at the_nether -43,102,-80 — on the pad she had
    // just laid, 4 blocks over the portal — and reported "the gate did not take me": `maxDropDown 1` is right for a Nether walk
    // and it also means a bot cannot get DOWN to its own way home). A player steps off the rim; `moves.stepOff` is that step,
    // with the landing column checked open and the hp cost known in advance.
    if (far.position.y < bot.entity.position.y - 1.5 && bot.entity.position.y - far.position.y <= 8) {
      const land = [far.position.x, far.position.y, far.position.z + (far.position.z > bot.entity.position.z ? -1 : 1)]
      const lb = bot.blockAt(new Vec3(land[0], land[1] - 1, land[2]))
      if (lb && lb.boundingBox === 'block') {
        await nTravel(bot, new Vec3(land[0], bot.entity.position.y, land[2]), { range: 1, ms: 20000, stop: api.stop }).catch(e_ => swallow('jobs_nether:toRim', e_))
        const r = await require('./moves').stepOff(bot, land, { stop: api.stop }).catch(e => ({ ok: false, why: String(e && e.message) }))
        A.result(bot, { ev: 'gate_below', job: job.id, gate: xyz(far.position), land, ok: !!r.ok, drop: r.drop, lost: r.lost, why: r.why })
      }
    }
    const cells = portalBody(bot, far.position, 10).map(p => [p.x, p.y, p.z])
    const to = await stepThrough(bot, api, cells.length ? cells : [xyz(far.position)], Math.min(P.crossS || 45, 120), 'walking into the far gate', cells)
    if (to && !/nether/.test(to)) {
      netherWalkOff(bot); gateGuardOn(bot, true) // home: the guard now holds the HOME gate cells, so no later walk of this bot wanders into it
      // AND STEP OUT OF THE HOME GATE (measured 16:15:57Z: `portal: cannot reach the gate at -327,68,-518` — the bot was standing
      // IN it at -326,69,-518, and a cell the pathfinder must avoid is no place to plan a route from; left there it would also be
      // taken back the moment the cooldown ran out).
      for (let w = 0; w < 20 && biomeOf(bot) === '?' && !api.stop(); w++) await sleep(250)
      const here = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 6 })
      await clearOfGate(bot, api, here ? portalBody(bot, here.position, 6) : [], 2)
      A.result(bot, { ev: 'portal_back', job: job.id, to, pos: xyz(bot.entity.position), from: xyz(far.position) })
      netherEdit({ back: Date.now(), portal: xyz(far.position) })
      st.home = true
      return 'portal_back: ' + to
    }
    return 'still in the Nether at ' + xyz(bot.entity.position).join(',') + ' (' + (api.stop() ? 'slice over' : 'the gate did not take me') + ')'
  }

  // ---------------------------------------------------------------- the far side (also the entry point when a new slice starts over there)
  async function netherSide (bot, job, api, ctx2, st, P) {
    // WE MUST ACTUALLY BE THERE (measured 15:33:40Z: Riko reported `pair_probe from:[-122,64,-218] groundY:86` — an OVERWORLD
    // column, because the crossing had double-transferred her through a stray gate and back out, while `dimOf` sampled inside
    // `stepThrough` had briefly read `the_nether`. Every number after that was Nether coordinates measured on overworld ground).
    // Nothing on this side of the code runs unless the bot is standing in the Nether, checked here and again before each work.
    // THE CLIENT LAGS THE WORLD AFTER A TRANSFER (measured 16:07:58Z: Aoi was standing at the far gate — `nether_look at
    // -43,98,-80` with six portal cells in view — while `bot.entity.position` still read an overworld cell 300 blocks away and
    // `game.dimension` still said overworld, so the far-side work refused itself and a whole trip was wasted; she then came home
    // correctly at -326,69,-518). The first act of an arrival is therefore to WAIT until the ground under our feet can be read at
    // all, and only then ask which world we are in.
    for (let w = 0; w < 40 && biomeOf(bot) === '?' && !api.stop(); w++) await sleep(250)
    if (!netherHere(bot)) {
      netherWalkOff(bot); gateGuardOff(bot)
      A.result(bot, { ev: 'portal_bounced', job: job.id, at: xyz(bot.entity.position), dim: dimOf(bot), biome: biomeOf(bot), why: 'the world under my feet is not the Nether (the gate sent me back, or the dimension packet lagged) - no far-side work runs from here' })
      st.through = 0; st.looked = false; st.landed = false; st.sealed = false; st.worked = false
      return 'bounced back to ' + dimOf(bot) + ' at ' + xyz(bot.entity.position).join(',') + ': the gates are not paired'
    }
    netherWalkOn(bot); gateGuardOn(bot, true)
    // A SCOUT AT A GATE IS NOT A STRANDED BOT (measured today: BOTH scouts of this shift were killed by an operator's `rescue`
    // within 3 minutes of arriving — Ichika 15:51:49 and Hazuki 16:04:15, "was killed", two full kits and 14 obsidian lost. The
    // arrival pocket of the far gate is 8 cells wide, so `walkableArea` reads boxed-in, army.js files `stranded` (its only move
    // off the overworld), and the digest tells an operator to rescue = KILL. A portal trip reports for itself — `portal_through`,
    // `gate_stuck`, `nether_lost`, `nether_pass` — and it always ends at the gate, so the generic alarm is held down for the trip
    // (army.js's own 10-minute throttle field; nothing in army.js is changed). armyctl's `rescue` refusing off-overworld bots is
    // the real fix and is filed in docs/BUGS.md.
    bot.__armyStrandedT = Date.now()
    // OFF THE ARRIVAL CELLS FIRST — before the wait for the world, before the look (owner 15:3xZ: from inside a portal cell a bot
    // can place nothing, and that is what every rescue was about). The bot's OWN column is there the moment the gate spits it out;
    // the rest of the world may arrive while it stands beside the gate rather than in it. `offCellS` is measured, not assumed.
    // AN UNREADABLE WORLD IS NOT AN EMPTY WORLD (measured 15:57:55Z: `offCellS 0.6, offCell:false` — 0.6 s after the gate spat
    // Hazuki out `blockAt` still gave null, so `inGateNow` read false, the routine believed she was clear of the frame, nobody
    // walked her out, and 15 s later the cooldown ran out under her feet and the gate took her straight home again. She then
    // "worked" the Nether plan on overworld ground at -317,69,-476). So: wait for the block under our feet to be READABLE, then
    // get out and CHECK, up to four times, inside the 15 s the cooldown gives us.
    const tArr = Date.now()
    for (let w = 0; w < 40 && !bot.blockAt(bot.entity.position.floored()); w++) await sleep(250)
    let first = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 8 })
    let body0 = first ? portalBody(bot, first.position, 6) : []
    for (let t = 0; t < 4 && inGateNow(bot) && !api.stop() && Date.now() - tArr < 20000; t++) {
      await clearOfGate(bot, api, body0, 2)
      if (!inGateNow(bot)) break
      first = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 8 })
      if (first) body0 = portalBody(bot, first.position, 6)
    }
    const offCellS = Math.round((Date.now() - tArr) / 100) / 10
    task(bot, 'portal: the Nether — waiting for the world')
    for (let w = 0; w < 80 && !bot.world.getColumnAt(bot.entity.position); w++) await sleep(500)
    await sleep(1500)
    let far = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 32 })
    const body = far ? portalBody(bot, far.position, 10) : []
    // OUT OF THE FRAME BEFORE ANYTHING ELSE (owner 15:3xZ): no look, no place, no dig, no window while feet or head are a portal
    // cell - a bot cannot place from there and it is what every rescue was about. Then spread off the arrival cell for the next one.
    await clearOfGate(bot, api, body, 2)
    await spreadOut(bot, api, body)
    if (inGateNow(bot)) await clearOfGate(bot, api, body, 2) // spreading out must never end ON a cell
    const me = bot.entity.position.floored()
    if (!st.through) {
      st.through = Date.now()
      A.result(bot, { ev: 'portal_through', job: job.id, from: st.fromDim || 'overworld', to: dimOf(bot), pos: xyz(me), portal: far ? xyz(far.position) : null, cells: body.length, offCellS, offCell: !inGateNow(bot), hp: bot.health })
      netherEdit({ portal: far ? xyz(far.position) : xyz(me), through: Date.now(), scoutRev: job.rev || 0, by: bot.username })
    }
    // STILL ON A CELL = THE TRIP IS OVER BEFORE IT STARTS: the cooldown will send this bot home under its own feet, and anything
    // it "measures" or "builds" from here belongs to the wrong world. Say so and let the gate do it, rather than work on a lie.
    if (inGateNow(bot)) {
      A.result(bot, { ev: 'gate_stuck', job: job.id, at: xyz(bot.entity.position), dim: dimOf(bot), offCellS, area: A.walkableArea(bot, 60, 1), why: 'still standing in the arrival cells after ' + offCellS + ' s - no work starts from a portal cell; the cooldown will take me home' })
      return 'in the Nether standing in the gate at ' + xyz(me).join(',') + ': could not get clear of the arrival cells'
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
      st.deathsAtGo = null
      if (P.work) { st.phase = 'gate'; st.home = false; st.through = 0; st.looked = false; st.landed = false; st.sealed = false; st.worked = false; st.kitted = false } else st.phase = 'done'
    }
    return r
  }

  // is anybody of ours still off the overworld? (heartbeats carry `dim`) — the gate stays lit while one bot is over there
  function anyoneOverThere (self) {
    try { return A.liveBots(600000).some(h => h && h.bot !== self && /nether|end/.test(String(h.dim || ''))) } catch (e_) { swallow('jobs_nether:anyoneOverThere', e_); return true }
  }

  // ---------------------------------------------------------------- TAKE AN EXTRA GATE DOWN (owner 15:0xZ "余計なネザーゲート壊して")
  // Our own close/relight cycle made the game generate spare portals. Removing one is a player's job: take ALL the obsidian of the
  // frame with a diamond pickaxe (which also puts it out), bank it - we need 10 for the planned second gate and the depot holds 2 -
  // and never, ever touch the registered pair (`settings.nether.gate` / `settings.nether.portal`).
  async function degate (bot, job, api, at) {
    const dim0 = dimOf(bot)
    const N = netherOf()
    // WHAT MUST NEVER BE TOUCHED IS WHAT HOLDS A BURNING PORTAL, not a box drawn round a coordinate (owner 16:2xZ "ネザー側に不要
    // なゲートがあります"; camera cell census 16:2xZ: the far side holds 28 obsidian = ONE live frame, -45..-42 / y97..101 / z-80,
    // holding six `nether_portal` cells, and ONE DEAD frame, -39..-36 / y97..101 / z-76, four blocks away. The old ±4 keep box
    // round the registered gate covered the dead frame's first column too, so the dead frame could never come down).
    const keep = new Set()
    for (const q of [N.gate, N.portal]) if (Array.isArray(q)) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 6; dy++) for (let dz = -2; dz <= 2; dz++) keep.add((q[0] + dx) + ',' + (q[1] + dy) + ',' + (q[2] + dz))
    const c0 = v(at)
    // every obsidian that touches a LIVE portal block: taking one of those out puts the whole surface out, which is the one thing
    // this job must never do to the gate we still travel through.
    const holdsFire = () => {
      const s2 = new Set()
      try {
        const pid = bot.registry.blocksByName.nether_portal && bot.registry.blocksByName.nether_portal.id
        if (pid != null) for (const q of bot.findBlocks({ matching: [pid], maxDistance: 24, count: 300, point: c0 })) { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) s2.add((q.x + dx) + ',' + (q.y + dy) + ',' + (q.z + dz)) }
      } catch (e_) { swallow('jobs_nether:holdsFire', e_) }
      return s2
    }
    const trav = (t, o) => netherHere(bot) ? nTravel(bot, t, o) : A.travel(bot, t, o) // over there every walk is lava-aware
    if (A.dist2(bot, c0.x, c0.z) > 24 && !await trav({ x: c0.x, y: c0.y, z: c0.z }, { range: 4, ms: 300000, stop: api.stop })) return { ok: false, why: 'cannot reach ' + at.join(',') }
    await sleep(500)
    // CLOSE WHAT CAN BURN YOU BEFORE YOU TOUCH THE FRAME (measured 16:44:55Z: Sakura 'went up in flames' at the_nether
    // -36,97,-75 taking the dead frame's last column down — there is a lava pocket at -36,98,-78, two blocks from it, and 28 iron
    // + 5 diamond went with her). The arrival has had this rule since stage 1; the WORK SITE is just as hot.
    if (netherHere(bot)) { const sealed = await sealNear(bot, api, 24); if (sealed) A.result(bot, { ev: 'nether_sealed', job: job.id, at: xyz(bot.entity.position), blocks: sealed, why: 'lava within arm\'s reach of the frame coming down' }) }
    const pk = A.bestOf(bot, 'pickaxe')
    if (!pk || !/diamond|netherite/.test(pk.name)) { if (!await A.obtain(bot, 'diamond_pickaxe', 1, { stop: api.stop }).catch(() => false)) return { ok: false, why: 'no diamond pickaxe' } }
    let got = 0; let left = 0
    for (let round = 0; round < 6 && !api.stop(); round++) {
      const ids = ['obsidian', 'crying_obsidian'].map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
      const fire = holdsFire()
      const found = bot.findBlocks({ matching: ids, maxDistance: 12, count: 60, point: c0 }).filter(q => !keep.has(q.x + ',' + q.y + ',' + q.z) && !fire.has(q.x + ',' + q.y + ',' + q.z))
      if (!found.length) break
      let did = 0
      for (const q of found) {
        if (api.stop()) break
        if (eyeOf(bot).distanceTo(q.offset(0.5, 0.5, 0.5)) > 4.2 && !await trav(q, { range: 2, ms: 30000, stop: api.stop, quiet: true })) continue
        await A.equipBest(bot, 'pickaxe').catch(e_ => swallow('jobs_nether:degatePick', e_))
        const r = await BL().digBlock(bot, q, { collect: true, requireHarvest: true, allowProtected: true, own: true }).catch(() => ({ ok: false }))
        if (r && r.ok) { got++; did++ }
      }
      await A.pickup(bot, 6, 3000)
      if (!did) break
    }
    { const ids = ['obsidian'].map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
      const fire2 = holdsFire()
      left = ids.length ? bot.findBlocks({ matching: ids, maxDistance: 12, count: 60, point: c0 }).filter(q => !keep.has(q.x + ',' + q.y + ',' + q.z) && !fire2.has(q.x + ',' + q.y + ',' + q.z)).length : 0 }
    const portalLeft = bot.findBlocks({ matching: b2 => !!b2 && b2.name === 'nether_portal', maxDistance: 12, count: 20, point: c0 }).length
    // A COUNT TAKEN IN THE WRONG WORLD IS NOT A COUNT (measured 16:46:53Z: Sakura reported `gate_removed {dim:'overworld', at:
    // [-38,99,-76], obsidianLeft:0, portalCellsLeft:0}` — the trip had ended and she was home, so the chunk data under those Nether
    // coordinates was the overworld's: a frame with FIVE blocks still standing read as taken down. A verdict says which world it
    // was measured in, and an unverified pass never claims the job is finished.)
    const verified = dimOf(bot) === dim0 && (dim0 !== 'the_nether' || netherHere(bot))
    A.result(bot, { ev: 'gate_removed', job: job.id, dim: dimOf(bot), at, obsidian: got, obsidianLeft: verified ? left : null, portalCellsLeft: verified ? portalLeft : null, verified, why: verified ? undefined : 'the trip ended before the count: these coordinates were read in ' + dimOf(bot) })
    if (got && !netherHere(bot)) await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop }).catch(e_ => swallow('jobs_nether:degateBank', e_)) // there is no depot on the far side: the obsidian comes home in the pocket
    // a DEAD frame is down when no obsidian of it is left; the LIVE gate we still travel through is expected to stand, so
    // its six cells are not counted against us (this job takes the dead ones only until the new pair has its round trips).
    return { ok: verified && left === 0, verified, obsidian: got, left: verified ? left : null, portalLeft: verified ? portalLeft : null }
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
    if (w === 'barterspot') { const b = N.barterSpot || {}; return b.built ? 'the barter lane and pad stand at ' + (b.stand || []).join(',') : false }
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
      if (!netherHere(bot)) { A.decline(bot, job, 45 * 60000, 'not in the Nether'); return muster(bot, job, api, ctx2, 'portal: the return job only carries bots that are in the Nether') }
      const rk = job.id + ':' + (job.rev || 0)
      const rs = bot.__armyPortalBack = (bot.__armyPortalBack && bot.__armyPortalBack.key === rk) ? bot.__armyPortalBack : { key: rk }
      return await comeHome(bot, job, api, ctx2, rs, P)
    }
    // TAKE A SPARE GATE DOWN (either dimension); it needs no gate geometry of its own
    if (Array.isArray(P.degate) && P.degate.length === 3) {
      const r = await degate(bot, job, api, P.degate)
      if (r.ok) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: the spare gate at ' + P.degate.join(',') + ' is down, ' + (r.obsidian || 0) + ' obsidian banked' } })
      return 'degate ' + P.degate.join(',') + ': ' + JSON.stringify(r)
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
    if (netherHere(bot)) return await netherSide(bot, job, api, ctx2, st, P)

    // ---- 1. the FRAME is the build job's, never this one's
    const gate = v(G.floor[0])
    gateGuardOn(bot, true) // walking UP TO a lit gate must never mean walking INTO it: the entry is a decision, not a step on a path
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
    // THE HOME GATE STAYS LIT, FULL STOP (owner 15:2xZ "拠点のが壊されて余計なやつが残ってね"). The close/relight trick cost us the
    // home gate itself: on 14:52:01 it reported `portal_out {ok:true, frameBack:false, gaps:1}` — the frame obsidian never went
    // back, the home gate died, and with Paper's 16-block Nether search every crossing then linked to the spare gate the cycle had
    // already generated at -284,84,-607. There is no closing any more: no `closeGate`, no `params.close`, no "last one home puts
    // it out". A lit gate costs a piglin trickle; a dead gate costs the whole route and breeds new gates.
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
      // MINIMAL KIT THROUGH THE GATE (owner 09-21 「もったいな」): swap the good tier DOWN before anything is loaded up, while the
      // pockets are still light. `pair` and `degate` keep a diamond PICKAXE — obsidian comes out of the world for nothing else.
      st.worth0 = kitWorth(bot)
      // `params.bare:true` (owner 09-21): army.js `bareDown` strips the valuables for the whole trip and leaves stone tools. That
      // is the same job done better and it is not ours to duplicate - our swap would only re-fetch the iron it just took off.
      st.swap = P.bare ? { swapped: ['(params.bare: army.js bareDown owns the kit)'], kept: [], deposited: 0 }
        : await swapDown(bot, api, /pair|degate/.test(String(P.work)) ? /pickaxe/ : null).catch(e_ => { swallow('jobs_nether:swapDown', e_); return null })
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
      if (P.work === 'barter') { for (const it of ['golden_helmet', 'gold_ingot']) if (A.count(bot, it) < (it === 'gold_ingot' ? (P.ingots || 64) : 1)) await A.obtain(bot, it, it === 'gold_ingot' ? (P.ingots || 64) : 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:gold', e_)) }
      if (P.work === 'fortress') for (const it of ['bow', 'arrow']) if (A.stockOf(it) > 0 && A.count(bot, it) < (it === 'arrow' ? 16 : 1)) await A.obtain(bot, it, it === 'arrow' ? 32 : 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:bow', e_))
      // THE PARTNER GATE IS BUILT, NOT FOUND: 10 obsidian for the frame (the 4 corners are any stone), the fire to light it, and a
      // diamond pickaxe, because obsidian is the one block that comes back out of the world only with one.
      if (P.work === 'pair') {
        const wantObs = Math.max(10, P.obsidian || 14)
        if (A.count(bot, 'obsidian') < wantObs) await A.obtain(bot, 'obsidian', wantObs, { stop: api.stop }).catch(e_ => swallow('jobs_nether:obsidian', e_))
        if (!A.count(bot, 'flint_and_steel')) await A.obtain(bot, 'flint_and_steel', 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:fs', e_))
        if (!/diamond|netherite/.test(String((A.bestOf(bot, 'pickaxe') || {}).name || ''))) await A.obtain(bot, 'diamond_pickaxe', 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:pick', e_))
      }
      // a shield is the difference between a ghast fireball and a death (top model 12:4xZ)
      if (!A.count(bot, 'shield') && !(bot.inventory.slots[45] || {}).name) await A.obtain(bot, 'shield', 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:shield', e_))
      if (!bot.registry.foodsByName || !bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) await A.obtain(bot, 'bread', 16, { stop: api.stop }).catch(e_ => swallow('jobs_nether:food', e_))
      // THE KIT IS FETCHED, NOT HOPED FOR (16:4xZ: Sakura came back from a death and declined her own job with 'no sword, no
      // diamond pickaxe' while the depot held both). A sword is the difference between a piglin and a funeral.
      // CHEAPEST BLADE THAT WORKS, not the best one in the depot (owner 09-21 「もったいな」): a crossing takes iron or stone and
      // the diamond swords stay home for the overworld. Then swapDown once more, because the fetches above run AFTER the first pass.
      if (!A.bestOf(bot, 'sword')) { for (const sw of ['iron_sword', 'stone_sword', 'diamond_sword']) { if (A.stockOf(sw) > 0 && await A.obtain(bot, sw, 1, { stop: api.stop }).catch(() => false)) break } }
      if (!P.bare) st.swap2 = await swapDown(bot, api, /pair|degate/.test(String(P.work)) ? /pickaxe/ : null).catch(e_ => { swallow('jobs_nether:swapDown2', e_); return null })
      if ((P.work === 'degate' || P.work === 'pair') && !/diamond|netherite/.test(String((A.bestOf(bot, 'pickaxe') || {}).name || ''))) await A.obtain(bot, 'diamond_pickaxe', 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:pick2', e_))
      await A.equipBest(bot, 'sword').catch(e_ => swallow('jobs_nether:sword', e_))
      // ONE OF EACH, AND NOTHING ELSE (recover engineer 16:2xZ: TWO Nether deaths were 54 % of all the iron the army lost in half
      // an hour, and no recovery run reaches another dimension inside the five minutes an item lives on the ground. Aoi was
      // carrying 3 diamond pickaxes, 2 diamond swords and 2 diamond axes on a trip that needs one of each). `A.bank` already keeps
      // the best of every tool class and the armour that is worn, so this list only has to name what THIS TRIP needs; everything
      // else goes back in the depot where the next bot can use it, instead of onto the floor of the Nether.
      const spareTools = bot.inventory.items().filter(i => /_(pickaxe|axe|sword|shovel|hoe)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
      const spareArmour = bot.inventory.items().filter(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name)).reduce((n, i) => n + i.count, 0) // worn pieces are not in items()
      const treasure = ['diamond', 'emerald', 'gold_ingot', 'iron_ingot', 'netherite_ingot'].reduce((n, k) => n + (P.work === 'barter' && k === 'gold_ingot' ? 0 : A.count(bot, k)), 0)
      if (spareTools > 5 || spareArmour > 0 || treasure > 0) {
        const keep = { torch: 64, shield: 1, flint_and_steel: 1, bread: 16, cooked_beef: 16, cooked_mutton: 16, cooked_porkchop: 16, cooked_cod: 16, cooked_chicken: 16, baked_potato: 16 }
        for (const k of SHELL_STONE) keep[k] = Math.max(64, P.cobble || 128)
        if (P.work === 'pair') keep.obsidian = Math.max(10, P.obsidian || 14)
        if (P.work === 'hub') { keep.chest = 1; keep.crafting_table = 1; keep.oak_fence_gate = 1; keep.spruce_fence_gate = 1; keep.birch_fence_gate = 1 }
        if (P.work === 'barter') { keep.gold_ingot = P.ingots || 64; keep.golden_helmet = 1 }
        // THE SPAN IS CARGO TOO (09-21 07:07Z: the first bridge attempt failed with the builder carrying zero stone). Whatever
        // this trip is meant to build with is kept through every banking step, exactly like the barter gold.
        for (const k of SHELL_STONE) if (A.count(bot, k)) keep[k] = Math.max(keep[k] || 0, A.count(bot, k))
        keep.torch = Math.max(keep.torch || 0, A.count(bot, 'torch'))
        if (P.work === 'fortress') { keep.bow = 1; keep.arrow = 64 }
        task(bot, 'portal: banking what this trip does not need')
        await A.bank(bot, keep, { job: job.id, stop: api.stop }).catch(e_ => swallow('jobs_nether:trim', e_))
        A.result(bot, { ev: 'portal_kit', job: job.id, work: P.work || 'cross', tools: bot.inventory.items().filter(i => /_(pickaxe|axe|sword|shovel|hoe)$/.test(i.name)).reduce((n, i) => n + i.count, 0), spareArmour: bot.inventory.items().filter(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name)).reduce((n, i) => n + i.count, 0), stone: stoneCarried(bot), obsidian: A.count(bot, 'obsidian'), worth: kitWorth(bot), worthBefore: st.worth0 || null, swapped: (st.swap && st.swap.swapped) || [], stillRich: (st.swap && st.swap.kept) || [], why: 'THIS is what the army loses if this bot dies over there - nothing of ours can fetch it back (target: ~15 iron, 0 diamonds)' })
      }
      const short = []
      if (stoneCarried(bot) < 32) short.push('stone to build with ' + stoneCarried(bot) + '/32 (depot: ' + SHELL_STONE.map(k => k + ' ' + A.stockOf(k)).join(', ') + ')')
      // A WEAPON, NOT A SWORD (09-21 06:0xZ: the depot holds 0 swords and 0 iron of any kind - every piece is in a bot's pocket -
      // so a lane job with an iron axe in hand was refusing to cross). `army.js startGuard` already swings `bestOf('sword') ||
      // bestOf('axe')`, so an axe IS the army's fallback weapon and this gate may not be stricter than the code that fights.
      if (!A.bestOf(bot, 'sword') && !A.bestOf(bot, 'axe')) short.push('no weapon (no sword and no axe; depot swords: ' + ['iron_sword', 'stone_sword', 'diamond_sword'].map(k => k + ' ' + A.stockOf(k)).join(', ') + ')')
      // GOLD IS THE CARGO, NOT THE LOOT (09-21 06:58:24Z: `bare_handed {banked:{... gold_ingot:20}}` — army.js `bareDown` strips
      // valuables before an `experimental` trip, and a gold ingot reads as valuable. A barter bot that crosses without gold trades
      // nothing and we only find out a slice later, so the kit is re-checked HERE, after bare/kit have both run, and the trip is
      // refused loudly rather than wasted. Same for the worn gold piece: without it every piglin in sight turns hostile.
      if (P.work === 'barter') {
        if (A.count(bot, 'gold_ingot') < 16) { await A.obtain(bot, 'gold_ingot', P.ingots || 64, { stop: api.stop }).catch(e_ => swallow('jobs_nether:goldAgain', e_)) }
        if (A.count(bot, 'gold_ingot') < 16) short.push('gold to trade ' + A.count(bot, 'gold_ingot') + '/16 (depot: ' + A.stockOf('gold_ingot') + ') - params.bare banks gold as a valuable, so it must be re-drawn after bareDown')
        const wearGold = [5, 6, 7, 8].map(q => bot.inventory.slots[q]).filter(Boolean).some(i => /^golden_/.test(i.name)) || A.count(bot, 'golden_helmet') || bot.inventory.items().some(i => /^golden_(helmet|chestplate|leggings|boots)$/.test(i.name))
        // ANY gold piece will do, and the cheapest is BOOTS (4 ingots vs 5). Measured 09-21 07:1xZ: `craft_gold_boots` is making
        // them but they stay in the crafters' pockets - depot golden_helmet 0 / carried 17, golden_boots 0 / 4 - so a barter bot
        // that only asks the DEPOT is blocked for ever. It carries 64 gold ingots of its own: if the shelf is empty it makes its
        // own boots out of the cargo (4 of 64) rather than come home for want of 4 ingots.
        if (!wearGold) {
          for (const g of ['golden_boots', 'golden_helmet']) { if (A.stockOf(g) > 0) await A.obtain(bot, g, 1, { stop: api.stop }).catch(e_ => swallow('jobs_nether:goldGet', e_)); if (A.count(bot, g)) break }
          if (!bot.inventory.items().some(i => /^golden_(helmet|chestplate|leggings|boots)$/.test(i.name)) && A.count(bot, 'gold_ingot') >= 4 + 16) await A.obtain(bot, 'golden_boots', 1, { stop: api.stop, craft: true }).catch(e_ => swallow('jobs_nether:goldCraft', e_))
          if (!bot.inventory.items().some(i => /^golden_(helmet|chestplate|leggings|boots)$/.test(i.name))) short.push('no gold armour piece to wear (depot: helmet ' + A.stockOf('golden_helmet') + ', boots ' + A.stockOf('golden_boots') + '; carrying ' + A.count(bot, 'gold_ingot') + ' ingots) - every piglin in sight would turn hostile')
        }
      }
      if (!bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) short.push('no food')
      if (P.work === 'pair') {
        if (A.count(bot, 'obsidian') < 10) short.push('obsidian ' + A.count(bot, 'obsidian') + '/10 (depot: ' + A.stockOf('obsidian') + ') - a frame cannot be built without it')
        if (!A.count(bot, 'flint_and_steel')) short.push('no flint_and_steel - the new gate could not be lit')
      }
      if (short.length) { A.decline(bot, job, 10 * 60000, 'kit short: ' + short.join(', ')); return muster(bot, job, api, ctx2, 'portal: not going through under-equipped (' + short.join(', ') + ')') }
      st.kitted = true
    }
    if (api.stop()) return 'portal: kitted, crossing next slice'

    // CROSS
    st.fromDim = dimOf(bot); st.deathsAtGo = bot.__armyDeaths || 0; st.through = 0; st.looked = false; st.landed = false; st.sealed = false; st.worked = false
    const to = await stepThrough(bot, api, G.inner.filter(q => q[1] === P.origin[1] + 1), P.crossS || 90, 'walking into the gate', G.inner)
    if (!to) {
      st.deathsAtGo = null
      // WHY did a lit gate not take us? (two bots, 45 s, 14:45Z). Paper has no portal-cooldown knob here, so record what we CAN
      // see: the cell we actually stood in, whether a mate shared it (max-entity-collisions 8 / shoving), and the live cell states.
      const me2 = bot.entity.position.floored(); const sharing = Object.values(bot.entities).filter(e => e && e.type === 'player' && e.position && e.position.floored().equals(me2)).length
      A.result(bot, { ev: 'portal_light_failed', job: job.id, at: G.floor[0], cells: litCells(bot, G.inner).length + '/' + G.inner.length, stoodAt: [me2.x, me2.y, me2.z], inPortal: /nether_portal/.test(((bot.blockAt(me2) || {}).name) || ''), sharingCell: sharing, why: 'stood in the gate for ' + (P.crossS || 90) + ' s and stayed in ' + dimOf(bot) })
      return 'portal: stood in the gate, no dimension change (still ' + dimOf(bot) + ')'
    }
    return await netherSide(bot, job, api, ctx2, st, P)
  }

  return { types: { portal }, verbs: {} }
}
module.exports.TYPES = ['portal']
module.exports.VERBS = []
