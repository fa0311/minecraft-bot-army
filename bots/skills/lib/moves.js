// bots/skills/lib/moves.js — PLAYER TECHNIQUES, one place (owner 09-20: "バケツ降りが100%出来るなら基本動作として組み込んでいいだろ",
// "抽象化とか出来てないスパゲッティコードだからこうするしか無いのか？"). Jobs used to grow their own way down / up / in / out (dropIn, rideUp, ladderWay,
// stairUp, clearOfGate …). A technique lives HERE, takes (bot, target, opts), VERIFIES the world afterwards and returns
//   { ok, how, lost (hp), tookMs, why, … }            — jobs call it, they do not re-implement it.
// Contract for everything in this file: never digs or places terrain (water it pours is taken back), overworld only where water is involved
// (water evaporates in the Nether), one technique at a time per bot (`bot.__moveBusy`).
//
// MEASURED (09-20, Yuzu, ravine S, Paper 26.2 via ViaBackwards): a water-bucket landing is NOT lag-sensitive, it is ORDER-sensitive.
//  - mineflayer emits `physicsTick` BEFORE it sends that tick's position packet (plugins/physics.js tickPhysics): a `use_item` sent from the handler
//    reaches the server while it still holds the PREVIOUS tick's position = ~1.1 blocks higher at a 9-block fall -> eye-to-floor 5.2 > reach 4.5 ->
//    no water, full damage (trials 1+2: lost 5 / 5.3). `setImmediate` puts the use AFTER the position packet: trial 3, 9 blocks, lost 0, one use, scooped.
//  - reach is measured from the EYE (feet + 1.62): fire at feet-to-floor <= 2.8.
//  - repeat the use every tick ONLY while the hand still holds `water_bucket` and the landing cell is not water yet: a blind second use with the
//    emptied bucket scoops the water back up (owner: "設置連打で良いのでは" - yes, guarded).
const { Vec3 } = require('vec3')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const FIRE_AT = 2.8 // feet above the landing cell's floor

const solid = b => !!b && b.boundingBox === 'block'
const isWater = b => !!b && b.name === 'water'
const bucketOf = (bot, name) => bot.inventory.items().find(i => i.name === name)
const overworld = bot => /overworld/.test(String(bot.game && bot.game.dimension))

// the column under a point: first solid block below `from` (<= max down) -> { y: feet level on it, on: block name, wet: a water cell on the way }
function groundBelow (bot, x, z, fromY, max = 48) {
  for (let y = Math.floor(fromY); y >= fromY - max; y--) {
    const b = bot.blockAt(new Vec3(x, y, z)); if (!b) return null
    if (isWater(b) || b.name === 'lava' || b.name === 'cobweb' || b.name === 'powder_snow') return { y: y, on: b.name, soft: true }
    if (solid(b)) return { y: y + 1, on: b.name, soft: /^(slime_block|hay_block|honey_block)$/.test(b.name) }
  }
  return null
}

// the landing itself: call while falling. Arms a per-tick trigger, resolves when the bot stands/swims at the bottom. Returns { shots }
function armLanding (bot, landY, lx, lz, state) {
  const land = new Vec3(lx, landY, lz)
  const onTick = () => {
    const e = bot.entity; if (!e || e.onGround || e.velocity.y > -0.08) return
    const dy = e.position.y - landY; if (dy > FIRE_AT || dy < 0.05) return
    const h = bot.heldItem; if (!h || h.name !== 'water_bucket') return
    if (isWater(bot.blockAt(land))) return
    if (state.shots === 0) state.firedAt = +dy.toFixed(2)
    state.shots++
    setImmediate(() => { try { bot.activateItem() } catch {} }) // AFTER this tick's position packet (see header) // why: best effort - the caller checks the world afterwards
  }
  bot.on('physicsTick', onTick)
  return () => bot.removeListener('physicsTick', onTick)
}

async function scoop (bot, near, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const b = bucketOf(bot, 'bucket'); if (!b) return !!bucketOf(bot, 'water_bucket')
    const src = bot.findBlocks({ matching: x => isWater(x) && x.metadata === 0, maxDistance: 4, count: 6, point: near })[0]; if (!src) return false
    try { await bot.equip(b, 'hand'); await bot.lookAt(src.offset(0.5, 0.5, 0.5), true); await sleep(200); bot.activateItem(); await sleep(600) } catch {} // why: best effort - the caller checks the world afterwards
    if (bucketOf(bot, 'water_bucket') && !isWater(bot.blockAt(src))) return true
  }
  return !!bucketOf(bot, 'water_bucket')
}

// walk to the CENTRE of the landing column and let go the moment the feet leave the rim. Holding `forward` until "not on the ground" carries a walking body ACROSS a
// 1-wide shaft (trial 4, and fill_ravine_s 16:01-16:11Z: Aika, Himari, Kaede `fill_dropped_in ok:false at -300,68,-474 want -301,57,-474` = they crossed it three times)
function walkIn (bot, c, ly, p0, t0, stop) {
  bot.setControlState('forward', true)
  return new Promise(resolve => { const iv = setInterval(() => { const e = bot.entity; const d = Math.hypot(e.position.x - c.x, e.position.z - c.z); if (d < 0.22 || e.velocity.y < -0.1 || e.position.y < p0.y - 0.4) bot.setControlState('forward', false); if ((e.position.y <= ly + 1.2 && (e.onGround || e.isInWater)) || Date.now() - t0 > 12000 || (stop && stop())) { clearInterval(iv); bot.setControlState('forward', false); resolve() } }, 10) })
}

// STEP OFF A RIM AND TAKE THE DAMAGE (fall - 3): the entry for a bot without a bucket. Refuses what would leave it under `keepHp` (default 8).
async function stepOff (bot, landArr, opts = {}) {
  const t0 = Date.now(); const fail = (why, x = {}) => ({ ok: false, how: 'step_off', why, tookMs: Date.now() - t0, ...x })
  if (bot.__moveBusy) return fail('another technique is running')
  const [lx, ly, lz] = landArr; const land = new Vec3(lx, ly, lz); const c = new Vec3(lx + 0.5, ly, lz + 0.5); const p0 = bot.entity.position.clone(); const drop = Math.floor(p0.y) - ly
  if (Math.hypot(p0.x - c.x, p0.z - c.z) > 1.6) return fail('not on the rim next to the landing column'); if (bot.health - Math.max(0, drop - 3) < (opts.keepHp || 8)) return fail('drop ' + drop + ' would leave ' + (bot.health - (drop - 3)) + ' hp')
  if (!solid(bot.blockAt(land.offset(0, -1, 0)))) return fail('the landing has no solid floor')
  for (let y = ly; y <= Math.floor(p0.y) + 1; y++) { const b = bot.blockAt(new Vec3(lx, y, lz)); if (!b || solid(b) || b.name === 'lava') return fail('the shaft is not open at y' + y) }
  bot.__moveBusy = 'step_off'; const hp0 = bot.health
  try {
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} // why: best effort - the caller checks the world afterwards
    await bot.lookAt(new Vec3(c.x, p0.y + 1, c.z), true).catch(() => {})
    await walkIn(bot, c, ly, p0, t0, opts.stop); await sleep(400)
    const at = bot.entity.position; const down = at.y <= ly + 1.2
    return { ok: down, how: 'step_off', drop, lost: +(hp0 - bot.health).toFixed(1), at: [Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)], tookMs: Date.now() - t0, why: down ? undefined : 'did not reach the landing' }
  } catch (e) { return fail('error: ' + (e && e.message)) } finally { bot.setControlState('forward', false); bot.__moveBusy = null }
}

// DELIBERATE DESCENT: step off a rim onto `land` = [x, y, z] (the FEET cell of the landing, i.e. floor y + 1) with a water-bucket landing.
// The bot must stand on the rim next to that column (<= 1.6 horizontally from its centre). opts: { maxDrop = 60, scoop = true, stop }
async function waterDrop (bot, landArr, opts = {}) {
  const t0 = Date.now(); const fail = (why, x = {}) => ({ ok: false, how: 'water_drop', why, tookMs: Date.now() - t0, ...x })
  if (bot.__moveBusy) return fail('another technique is running'); if (!overworld(bot)) return fail('water does not exist here (' + (bot.game && bot.game.dimension) + ')')
  const [lx, ly, lz] = landArr; const land = new Vec3(lx, ly, lz); const c = new Vec3(lx + 0.5, ly, lz + 0.5)
  const p0 = bot.entity.position.clone(); const drop = Math.floor(p0.y) - ly
  if (drop < 4) return fail('a drop of ' + drop + ' needs no water'); if (drop > (opts.maxDrop || 60)) return fail('drop ' + drop + ' over the limit')
  if (Math.hypot(p0.x - c.x, p0.z - c.z) > 1.6) return fail('not on the rim next to the landing column', { d: +Math.hypot(p0.x - c.x, p0.z - c.z).toFixed(2) })
  const floor = bot.blockAt(land.offset(0, -1, 0)); if (!solid(floor)) return fail('the landing has no solid floor (' + (floor && floor.name) + ')')
  for (let y = ly; y <= Math.floor(p0.y) + 1; y++) { const b = bot.blockAt(new Vec3(lx, y, lz)); if (!b || (b.name !== 'air' && b.name !== 'cave_air')) return fail('the shaft is not open at y' + y + ' (' + (b && b.name) + ')') }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const b = bot.blockAt(land.offset(dx, 0, dz)); if (!b) return fail('cannot see the cell beside the landing (chunk not loaded)'); if (b.name === 'lava') return fail('lava beside the landing') }
  const wb = bucketOf(bot, 'water_bucket'); if (!wb) return fail('no water_bucket carried')
  bot.__moveBusy = 'water_drop'; const prev = bot.heldItem && bot.heldItem.name; const hp0 = bot.health; const st = { shots: 0, firedAt: null }; let disarm = null
  try {
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} // why: best effort - the caller checks the world afterwards
    await bot.equip(wb, 'hand')
    const yaw = Math.atan2(-(c.x - p0.x), -(c.z - p0.z)); await bot.look(yaw, -Math.PI / 2, true)
    disarm = armLanding(bot, ly, lx, lz, st)
    // walk to the CENTRE of the landing column and let go the moment the feet leave the rim (trial 4: holding `forward` carried the bot across a 1-wide shaft)
    await walkIn(bot, c, ly, p0, t0, opts.stop)
    await sleep(500)
    const at = bot.entity.position; const down = at.y <= ly + 1.2; const lost = +(hp0 - bot.health).toFixed(1)
    let scooped = null; if (opts.scoop !== false) scooped = await scoop(bot, land)
    const left = bot.findBlocks({ matching: b => isWater(b) && b.metadata === 0, maxDistance: 5, count: 8, point: land }).length // SOURCES: flowing cells drain by themselves in seconds (trial 6 counted 7 of them)
    if (prev && prev !== 'water_bucket') { const it = bucketOf(bot, prev); if (it) await bot.equip(it, 'hand').catch(() => {}) }
    return { ok: down && lost <= 0.5, how: 'water_drop', drop, lost, shots: st.shots, firedAt: st.firedAt, scooped, waterLeft: left, at: [Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)], tookMs: Date.now() - t0, why: !down ? 'did not reach the landing' : lost > 0.5 ? 'took fall damage (water late or not placed)' : undefined }
  } catch (e) { return fail('error: ' + (e && e.message)) } finally { if (disarm) disarm(); bot.setControlState('forward', false); bot.__moveBusy = null }
}

// BRIDGE while walking (owner 09-20: "mineflyerに置きながら移動するのあるのでは？橋建設に利用できそう"): mineflayer-pathfinder can place scaffolding as it goes
// (`Movements.scafoldingBlocks` + `moveToEdge`); the army switches that OFF for travel (movement is read-only) - a BRIDGE is construction, so this technique
// switches it on for ONE goal, inside ONE corridor, and restores the bot's strict movements afterwards. Rules: never digs, no 1x1 towers, no parkour, no sprint,
// blocks only from `opts.blocks` (default cobblestone/netherrack/cobbled_deepslate), steps and placements only inside the corridor (the straight line from the
// start to `to`, `opts.half` cells to each side, default 0 = a 1-wide spine: the job widens and rails it from the safe spine afterwards), and SNEAK is held the
// whole way (prismarine-physics stops a sneaking body at an edge; the pathfinder drops sneak after each placement, so it is re-asserted every tick).
// -> { ok, how:'bridge', placed, at, tookMs, why }. `placed` is MEASURED (inventory difference), and the far end is re-read before ok is claimed.
async function bridgeTo (bot, toArr, opts = {}) {
  const t0 = Date.now(); const fail = (why, x = {}) => ({ ok: false, how: 'bridge', why, tookMs: Date.now() - t0, ...x })
  if (bot.__moveBusy) return fail('another technique is running'); if (!bot.pathfinder) return fail('no pathfinder')
  const { Movements, goals } = require('mineflayer-pathfinder'); const [tx, ty, tz] = toArr; const p0 = bot.entity.position.floored()
  const names = (opts.blocks || ['cobblestone', 'cobbled_deepslate', 'netherrack']).filter(n => bot.registry.itemsByName[n]); const count = () => names.reduce((s, n) => s + bot.inventory.items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0), 0)
  const need = Math.abs(tx - p0.x) + Math.abs(tz - p0.z) + 2; const have0 = count(); if (have0 < need) return fail('carries ' + have0 + ' bridge blocks, the span may need ' + need)
  const half = opts.half || 0; const x1 = Math.min(p0.x, tx) - half; const x2 = Math.max(p0.x, tx) + half; const z1 = Math.min(p0.z, tz) - half; const z2 = Math.max(p0.z, tz) + half
  const outside = b => (b.position.x < x1 || b.position.x > x2 || b.position.z < z1 || b.position.z > z2 || b.position.y < ty - 2 || b.position.y > ty + 2) ? 1000 : 0
  const mv = new Movements(bot); mv.canDig = false; mv.allow1by1towers = false; mv.allowParkour = false; mv.allowSprinting = false; mv.maxDropDown = 1; mv.dontCreateFlow = true
  mv.scafoldingBlocks = names.map(n => bot.registry.itemsByName[n].id); mv.exclusionAreasStep = [outside]; mv.exclusionAreasPlace = [outside]
  // the army's terrain guard re-applies read-only movements every 2 s and on every setMovements (first live test: the plan came back EMPTY in 43 ms and
  // pathfinder's goto RESOLVES on an empty path): a bridge is construction, so it takes the guard's own, time-boxed, reasoned opt-out for exactly this call
  const TG = (() => { try { return require('./terrain_guard') } catch { return null } })(); const okBefore = bot.state && bot.state.terrainEditOK
  if (TG) { TG.allowTerrainEdit(bot, 'moves.bridgeTo ' + p0.x + ',' + p0.z + ' -> ' + tx + ',' + tz, (opts.ms || 120000) + 2000); if (bot.__tg) bot.__tg.mode = TG.modeOf(bot) } // the guard caches its mode between its 2 s ticks (second live test: still an empty plan in 22 ms)
  const old = bot.pathfinder.movements; bot.__moveBusy = 'bridge'; const sneak = () => { try { bot.setControlState('sneak', true) } catch {} }; bot.on('physicsTick', sneak) // why: best effort - the caller checks the world afterwards
  try {
    bot.pathfinder.setMovements(mv)
    const done = bot.pathfinder.goto(new goals.GoalBlock(tx, ty, tz)); let timer; const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), opts.ms || 120000) })
    const stopper = opts.stop ? setInterval(() => { if (opts.stop()) { try { bot.pathfinder.setGoal(null) } catch {} } }, 250) : null // why: best effort - the caller checks the world afterwards
    let empty = false; const onPU = r => { if (r && r.path && r.path.length === 0 && r.status !== 'success') empty = true }; bot.on('path_update', onPU)
    let err = null; try { await Promise.race([done, limit]) } catch (e) { err = e } finally { clearTimeout(timer); if (stopper) clearInterval(stopper); bot.removeListener('path_update', onPU); try { bot.pathfinder.setGoal(null) } catch {} } // why: best effort - the caller checks the world afterwards
    const at = bot.entity.position.floored(); const under = bot.blockAt(at.offset(0, -1, 0)); const arrived = Math.abs(at.x - tx) <= 1 && Math.abs(at.z - tz) <= 1 && Math.abs(at.y - ty) <= 1
    return { ok: arrived && solid(under), how: 'bridge', placed: have0 - count(), at: [at.x, at.y, at.z], tookMs: Date.now() - t0, why: arrived ? undefined : String((err && err.message) || (empty ? 'the pathfinder found no bridge path (guard mode / corridor / blocks?)' : 'stopped short')) }
  } catch (e) { return fail('error: ' + (e && e.message)) } finally { bot.removeListener('physicsTick', sneak); try { bot.setControlState('sneak', false) } catch {} if (TG) { TG.revokeTerrainEdit(bot); if (okBefore && bot.state) bot.state.terrainEditOK = okBefore; if (bot.__tg) bot.__tg.mode = TG.modeOf(bot) } try { bot.pathfinder.setMovements(old) } catch {} bot.__moveBusy = null } // why: best effort - the caller checks the world afterwards
}

// REFLEX (owner: "落下死しそうだったらアルゴリズム的に水を置くことは出来ないのか？"): installed once per bot. A fall that was NOT planned (knock-back off a
// rim, a floor dug away) and would cost >= `minDamage` hp gets the same landing, when a water_bucket is carried. Results are reported through `report`.
const LOADED = Date.now() // a hot reload of this file re-installs the reflex once; repeated calls from the heartbeat are free
function fallGuard (bot, report = () => {}, opts = {}) {
  if (bot.__fallGuard && bot.__fallGuardV === LOADED) return
  if (bot.__fallGuard) bot.removeListener('physicsTick', bot.__fallGuard)
  bot.__fallGuardV = LOADED
  const minDamage = opts.minDamage || 4; const S = { lastGroundY: null, armed: null, busy: false }
  const onTick = () => {
    const e = bot.entity; if (!e) return
    if (e.onGround || e.isInWater) { if (!S.armed) S.lastGroundY = e.position.y; return }
    if (S.busy || S.armed || bot.__moveBusy || S.lastGroundY == null || e.velocity.y > -0.55 || !overworld(bot)) return // -0.55 ~ 2.5 blocks fallen
    const wb = bucketOf(bot, 'water_bucket'); if (!wb) return
    const x = Math.floor(e.position.x); const z = Math.floor(e.position.z); const g = groundBelow(bot, x, z, e.position.y); if (!g || g.soft) return
    const fall = S.lastGroundY - g.y; if (fall - 3 < minDamage) return
    S.busy = true; const hp0 = bot.health; const t0 = Date.now(); const prev = bot.heldItem && bot.heldItem.name; const st = { shots: 0, firedAt: null }
    const disarm = armLanding(bot, g.y, x, z, st); S.armed = true
    ;(async () => {
      try {
        try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} // why: best effort - the caller checks the world afterwards
        if (!bot.heldItem || bot.heldItem.name !== 'water_bucket') await bot.equip(wb, 'hand') // a hotbar bucket = one packet; from the backpack it may be too late - the result says so
        await bot.look(e.yaw, -Math.PI / 2, true)
        const tEnd = Date.now() + 8000; while (Date.now() < tEnd && !(bot.entity.onGround || bot.entity.isInWater)) await sleep(20)
        await sleep(450); const lost = +(hp0 - bot.health).toFixed(1); const scooped = await scoop(bot, new Vec3(x, g.y, z))
        if (prev && prev !== 'water_bucket') { const it = bucketOf(bot, prev); if (it) await bot.equip(it, 'hand').catch(() => {}) }
        report({ ev: 'fall_saved', ok: lost <= 0.5, fall, wouldLose: fall - 3, lost, shots: st.shots, firedAt: st.firedAt, scooped, at: [x, g.y, z], tookMs: Date.now() - t0 })
      } catch (err) { report({ ev: 'fall_saved', ok: false, fall, why: String(err && err.message) }) } finally { disarm(); S.armed = null; S.busy = false; S.lastGroundY = bot.entity.position.y }
    })()
  }
  bot.__fallGuard = onTick; bot.on('physicsTick', onTick)
}

// SHOOT (moved here from jobs_end.js 09-21 so the blaze doorway and the End crystals share ONE bow technique): hold the bow, aim a
// touch high (an arrow drops ~0.035 per block), draw 1.15 s = full power, loose; up to `shots` arrows or until the target is gone.
// -> { ok, shots, why }. `ok` = the entity is gone (dead or out of the world), nothing else.
async function shoot (bot, ent, o = {}) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow || !bot.inventory.items().some(i => i.name === 'arrow')) return { ok: false, why: 'no bow or no arrows' }
  try { await bot.equip(bow, 'hand') } catch (e) { return { ok: false, why: 'could not hold the bow' } }
  const id = ent.id
  for (let i = 0; i < (o.shots || 4); i++) {
    if (o.stop && o.stop()) break
    const cur = bot.entities[id]
    if (!cur || !cur.isValid) return { ok: true, shots: i }
    try {
      const d = cur.position.distanceTo(bot.entity.position)
      await bot.lookAt(cur.position.offset(0, (o.aimY == null ? 0.6 : o.aimY) + d * 0.035, 0), true)
      bot.activateItem()
      await sleep(o.drawMs || 1150)
      const c1 = bot.entities[id]; if (c1 && c1.isValid) { const d1 = c1.position.distanceTo(bot.entity.position); await bot.lookAt(c1.position.offset(0, (o.aimY == null ? 0.6 : o.aimY) + d1 * 0.035, 0), true) } // it moved while we drew
      bot.deactivateItem()
    } catch (e) { try { bot.deactivateItem() } catch {} } // why: best effort - the next arrow or the caller's check decides
    await sleep(o.gapMs || 900)
    const c2 = bot.entities[id]
    if (!c2 || !c2.isValid) return { ok: true, shots: i + 1 }
  }
  return { ok: false, shots: o.shots || 4, why: 'still standing after ' + (o.shots || 4) + ' arrows' }
}
// WALK INTO ONE CELL, CENTRED (a portal): the pathfinder calls a goal reached when the feet's cell is next to it, and a body 0.6 wide standing 0.06 off the
// centre line rubs the FRAME. MEASURED 09-21 18:3xZ: Hinata stood at x -47.94 z -77.30 for 1 h before the far gate (portal x -48..-47, z -77, frame x -49): the
// hitbox reached x -48.24 into the obsidian column, so every `forward` stopped flush at z -77.0 and 60 slices said "the gate did not take me". A player steps to
// the middle of the opening first. `cell` = [x, y, z] (feet); walks to the centre of the cell in front on the same level, then presses on to its centre.
async function walkInto (bot, cell, opts = {}) {
  const t0 = Date.now(); const fail = (why) => ({ ok: false, how: 'walk_into', why, tookMs: Date.now() - t0 })
  if (bot.__moveBusy) return fail('another technique is running')
  const [cx, cy, cz] = cell; const c = new Vec3(cx + 0.5, cy, cz + 0.5); const p0 = bot.entity.position
  if (Math.abs(p0.y - cy) > 1.2 || Math.hypot(p0.x - c.x, p0.z - c.z) > 2.2) return fail('not next to the cell')
  // the approach point: centre of the cell we stand in, lined up with the target on the axis we move along
  const dx = Math.abs(c.x - p0.x) >= Math.abs(c.z - p0.z) ? Math.sign(c.x - p0.x) : 0; const dz = dx ? 0 : Math.sign(c.z - p0.z)
  const a = new Vec3(c.x - dx, p0.y, c.z - dz)
  bot.__moveBusy = 'walk_into'
  const go = (to, ms, done) => new Promise(resolve => {
    const end = Date.now() + ms
    const iv = setInterval(() => {
      const e = bot.entity.position; const d = Math.hypot(e.x - to.x, e.z - to.z)
      if (done() || d < 0.15 || Date.now() > end || (opts.stop && opts.stop())) { clearInterval(iv); bot.setControlState('forward', false); resolve(d) } else bot.lookAt(new Vec3(to.x, e.y + 1.6, to.z), true).catch(() => {})
    }, 50)
    bot.lookAt(new Vec3(to.x, bot.entity.position.y + 1.6, to.z), true).catch(() => {}).then(() => bot.setControlState('forward', true))
  })
  try {
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} // why: best effort - the walk below is what counts
    const done = opts.done || (() => false)
    await go(a, 1500, done); if (!done()) await go(c, opts.ms || 2000, done)
    const e = bot.entity.position; const inside = Math.floor(e.x) === cx && Math.floor(e.z) === cz
    return { ok: inside || done(), how: 'walk_into', at: [Math.floor(e.x), Math.floor(e.y), Math.floor(e.z)], off: +Math.hypot(e.x - c.x, e.z - c.z).toFixed(2), lost: 0, tookMs: Date.now() - t0 }
  } catch (e) { return fail('error: ' + (e && e.message)) } finally { bot.setControlState('forward', false); bot.__moveBusy = null }
}

module.exports = { waterDrop, stepOff, bridgeTo, fallGuard, groundBelow, scoop, shoot, walkInto }
