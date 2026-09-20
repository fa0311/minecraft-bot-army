// fishery.js — FISHING from the bank (the `fish` job's engine): open water, or an ice hole where the water is frozen. We
//   1. pick a dry stand next to deep open-sky water (liquid, or covered by ice),
//   2. break a small hole if it is ice (ice -> water when water is below),
//   3. cast INTO the water, verify the bobber really floats in water (bot.fish() alone casts onto ice/stone and never gets a bite),
//   4. detect the bite ourselves (particles OR bobber dip) and reel in,
//   5. re-open the hole whenever it refreezes (a torch next to it prevents that).
// No shared state in memory and no file: the caller owns the site, travel and safety.
const U = require('./util')
const swallow = require('./swallow')
const { Vec3 } = require('vec3')

const sleep = U.sleep
const WET = new Set(['water', 'ice', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

function blk (bot, x, y, z) { return bot.blockAt(new Vec3(x, y, z)) }
function isWaterLike (b) { return !!b && (b.name === 'water' || b.name === 'seagrass' || b.name === 'tall_seagrass' || b.name === 'kelp' || b.name === 'kelp_plant' || b.name === 'bubble_column') }
function passable (b) { return !!b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava' }

// depth of water below a surface cell (ice or water at x,y,z)
function depthBelow (bot, x, y, z, max = 6) {
  let d = 0
  for (let yy = y - 1; yy > y - 1 - max; yy--) { if (isWaterLike(blk(bot, x, yy, z))) d++; else break }
  return d
}
function skyOpen (bot, x, y, z, h = 24) {
  for (let yy = y + 1; yy <= y + h; yy++) {
    const b = blk(bot, x, yy, z)
    if (!b) return true
    if (b.boundingBox !== 'empty' || b.name === 'water') return false
  }
  return true
}
// a cell we can fish in: ice/water surface, >=2 water below, sky above
function holeCell (bot, x, y, z) {
  const b = blk(bot, x, y, z)
  if (!b || (b.name !== 'ice' && b.name !== 'water')) return false
  const up = blk(bot, x, y + 1, z)
  if (!up || !passable(up)) return false
  const depth = depthBelow(bot, x, y, z) + (b.name === 'water' ? 1 : 0)
  if (depth < 2) return false
  return skyOpen(bot, x, y, z)
}

// Geometry (measured in the sandbox, 2026-09-18): a catch is thrown towards the angler but it does NOT clear a
// rim — with 2 blocks of ice between the bot and the hole 6/6 catches stayed floating in the hole. So the bot
// stands DIRECTLY at the edge of a channel that leads to the casting pad; the catch swims/flies along the
// channel into pickup range:
//        S = stand (dry block or ice)      . = channel (1 wide)      P = pad (3 wide, bobber lands here)
//        S . . P P
//            P P          (and the mirrored P row)
const PATTERN = [[1, 0, 1], [2, 0, 1], [3, 0, 2], [3, -1, 2], [3, 1, 2], [4, 0, 2], [4, -1, 2], [4, 1, 2]] // [forward, side, minDepth]
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function cellOk (bot, x, y, z, minDepth) {
  const b = blk(bot, x, y, z)
  if (!b || (b.name !== 'ice' && b.name !== 'water')) return false
  const up = blk(bot, x, y + 1, z)
  if (!up || !passable(up)) return false
  // depth matters for ICE HOLES (a catch must swim up the channel); OPEN water (world 2: a lake with a shallow sandy shore, 5 anglers found
  // 'no fishing spot' 80 blocks from the camp) only needs the bobber to float: 1 deep is enough, exactly as for a player.
  if (b.name === 'ice' && depthBelow(bot, x, y, z) + 1 < minDepth + 1) return false
  return skyOpen(bot, x, y, z)
}

// Find {stand, surfaceY, centre, cells[], dir} near the bot. stand = feet position; lake surface = stand.y - 1.
function findSite (bot, r = 20, avoid = []) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -6; dy <= 6; dy++) {
        const x = me.x + dx; const y = me.y + dy; const z = me.z + dz
        const floor = blk(bot, x, y - 1, z)
        if (!floor || floor.boundingBox !== 'block' || floor.name === 'water') continue
        if (/leaves|sweet_berry|cactus|magma|campfire|farmland|chest|furnace/.test(floor.name)) continue
        const feet = blk(bot, x, y, z); const head = blk(bot, x, y + 1, z)
        if (!passable(feet) || !passable(head)) continue
        if (avoid.some(a => Math.hypot(a.x - x, a.z - z) < 6)) continue
        const sy = y - 1
        for (const [fx, fz] of DIRS) {
          const cells = []
          let ok = true
          for (const [f, sd, minD] of PATTERN) {
            const cx = x + fx * f + (fz !== 0 ? sd : 0)
            const cz = z + fz * f + (fx !== 0 ? sd : 0)
            if (!cellOk(bot, cx, sy, cz, minD)) { ok = false; break }
            cells.push(new Vec3(cx, sy, cz))
          }
          if (!ok) continue
          const d = Math.hypot(dx, dz) + Math.abs(dy) * 2
          const score = d + (floor.name === 'ice' ? 3 : 0)
          if (!best || score < best.score) {
            best = { stand: new Vec3(x, y, z), surfaceY: sy, cells, centre: new Vec3(x + fx * 4, sy, z + fz * 4), dir: [fx, fz], score }
          }
        }
      }
    }
  }
  return best
}

// break the ice of the hole; cells out of reach are approached on foot (on the ice), then we return to the stand
async function openHole (bot, site) {
  let opened = 0
  for (const c of site.cells) {
    U.ck(bot)
    let b = bot.blockAt(c)
    if (!b || b.name !== 'ice') continue
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.3) {
      // stand on the channel side of the stand, never walk INTO the open water
      const sx = site.stand.x + site.dir[0] * 0; const sz = site.stand.z + site.dir[1] * 0
      await U.safe(bot, () => U.goTo(bot, sx, site.stand.y, sz, 0, 15000), 'toStand')
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(c.offset(0.5, 0.5, 0.5)) > 5.2) continue
    }
    b = bot.blockAt(c)
    await bot.lookAt(c.offset(0.5, 1, 0.5), true).catch(e_ => swallow('fishery:118', e_))
    if (b && b.name === 'ice' && await U.digBlock(bot, b, 8000, true)) opened++
    await sleep(120)
  }
  return opened
}
function openCells (bot, site) {
  return site.cells.filter(c => { const b = bot.blockAt(c); return b && b.name === 'water' })
}
// keep the hole from refreezing: a torch on the bank right next to it (block light >= 10 blocks ice formation)
async function lightHole (bot, site) {
  if (!U.has(bot, 'torch')) return false
  const near = U.findBlocksByName(bot, ['torch', 'wall_torch'], 5, 4)
  if (near.some(p => p.distanceTo(site.centre) <= 3.5)) return true
  const s = site.stand
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const p = s.offset(dx, 0, dz)
    const under = bot.blockAt(p.offset(0, -1, 0)); const at = bot.blockAt(p)
    if (!under || under.boundingBox !== 'block' || WET.has(under.name)) continue
    if (!at || !(at.name === 'air' || at.name === 'snow')) continue
    if (p.distanceTo(site.centre) > 4.2) continue
    if (await U.safe(bot, () => U.placeBlockAt(bot, 'torch', p), 'torch')) return true
  }
  return false
}

function myBobber (bot) {
  let best = null
  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (!e || e.name !== 'fishing_bobber' || !e.position) continue
    if (bot.__bobberId != null && e.id === bot.__bobberId) return e
    const d = e.position.distanceTo(bot.entity.position)
    if (d < 12 && (!best || d < best.d)) best = { e, d }
  }
  return bot.__bobberId != null ? null : (best && best.e)
}

function installHooks (bot) {
  if (bot.__fishHooks) return
  bot.__fishHooks = true
  bot.__fishSig = { bite: 0, particle: 0, dip: 0 }
  bot._client.on('spawn_entity', (p) => {
    try {
      const reg = bot.registry.entitiesByName.fishing_bobber
      if (reg && p.type === reg.id && bot.entity && p.objectData === bot.entity.id) { bot.__bobberId = p.entityId; bot.__bobberT = Date.now() }
    } catch (e_) { swallow('fishery:164', e_) }
  })
  bot._client.on('entity_destroy', (p) => {
    try { if (bot.__bobberId != null && (p.entityIds || []).includes(bot.__bobberId)) bot.__bobberId = null } catch (e_) { swallow('fishery:167', e_) }
  })
  bot._client.on('world_particles', (p) => {
    try {
      if (bot.__bobberId == null) return
      const e = bot.entities[bot.__bobberId]; if (!e) return
      const type = p.particle && p.particle.type
      const n = p.amount != null ? p.amount : p.particles
      if ((type === 'fishing' || type === 'bubble') && n >= 4 && Math.hypot(p.x - e.position.x, p.z - e.position.z) <= 1.3) {
        bot.__fishSig.particle = Date.now()
      }
    } catch (e_) { swallow('fishery:178', e_) }
  })
  bot._client.on('entity_velocity', (p) => {
    try {
      if (bot.__bobberId == null || p.entityId !== bot.__bobberId) return
      const vy = p.velocity ? p.velocity.y : p.velocityY
      // a bite pulls the bobber down with -0.24..-0.4 blocks/tick; idle bobbing is < 0.05
      const v = Math.abs(vy) > 50 ? vy / 8000 : vy
      if (v < -0.15 && Date.now() - (bot.__bobberT || 0) > 2500) bot.__fishSig.dip = Date.now()
    } catch (e_) { swallow('fishery:187', e_) }
  })
}

// One cast. Returns 'catch' | 'miss' (bobber not in water) | 'timeout' | 'lost'
async function fishOnce (bot, aim, opts = {}) {
  installHooks(bot)
  const maxMs = opts.maxMs || 60000
  if (!await U.equip(bot, 'fishing_rod', 'hand')) return 'norod'
  // make sure no old line is out
  if (myBobber(bot)) { try { bot.activateItem() } catch (e_) { swallow('fishery:197', e_) }; await sleep(600) }
  bot.__bobberId = null
  await bot.lookAt(aim, true).catch(e_ => swallow('fishery:199', e_))
  await sleep(250)
  const sig = bot.__fishSig; sig.particle = 0; sig.dip = 0
  const t0 = Date.now()
  try { bot.activateItem() } catch { return 'lost' }
  // wait for the bobber and let it settle
  while (Date.now() - t0 < 3000 && bot.__bobberId == null) await sleep(100)
  if (bot.__bobberId == null && !myBobber(bot)) return 'lost'
  await sleep(2200)
  const bob = myBobber(bot)
  if (!bob) return 'lost'
  const at = bot.blockAt(bob.position.floored())
  const below = bot.blockAt(bob.position.offset(0, -0.4, 0).floored())
  bot.__lastBobber = { x: +bob.position.x.toFixed(2), y: +bob.position.y.toFixed(2), z: +bob.position.z.toFixed(2), in: at && at.name, below: below && below.name }
  if (!(isWaterLike(at) || isWaterLike(below))) {
    try { bot.activateItem() } catch (e_) { swallow('fishery:214', e_) }
    await sleep(500)
    return 'miss'
  }
  sig.particle = 0; sig.dip = 0
  while (Date.now() - t0 < maxMs) {
    if (U.cancelled(bot)) { try { bot.activateItem() } catch (e_) { swallow('fishery:220', e_) }; U.ck(bot) }
    if (sig.particle || sig.dip) {
      bot.__lastBite = sig.dip ? (sig.particle ? 'both' : 'dip') : 'particle'
      try { bot.activateItem() } catch (e_) { swallow('fishery:223', e_) }
      await sleep(900) // the catch flies to us
      return 'catch'
    }
    if (!myBobber(bot)) return 'lost'
    if (opts.abort && opts.abort()) { try { bot.activateItem() } catch (e_) { swallow('fishery:228', e_) }; await sleep(400); return 'abort' }
    await sleep(80)
  }
  try { bot.activateItem() } catch (e_) { swallow('fishery:231', e_) }
  await sleep(500)
  return 'timeout'
}

function invTotal (bot) { let n = 0; for (const i of bot.inventory.items()) n += i.count; return n }
const FISH_RE = /^(cod|salmon|tropical_fish|pufferfish|cooked_cod|cooked_salmon)$/
function fishCount (bot) { let n = 0; for (const i of bot.inventory.items()) if (i.name === 'cod' || i.name === 'salmon') n += i.count; return n }

// Fish for up to `ms` at `site`. Returns stats. The caller owns travel + safety.
async function session (bot, site, opts = {}) {
  const ms = opts.ms || 120000
  const end = Date.now() + ms
  const st = { casts: 0, catches: 0, miss: 0, timeout: 0, lost: 0, fish: 0, opened: 0, ms: 0 }
  const t0 = Date.now()
  const fish0 = fishCount(bot)
  let aimIdx = 0
  let badRun = 0
  while (Date.now() < end && badRun < 6) {
    U.ck(bot)
    if (opts.abort && opts.abort()) break
    if (opts.between) { try { await opts.between(st) } catch (e) { if (e && e.cancelled) throw e } }
    if (bot.entity.position.distanceTo(site.stand.offset(0.5, 0, 0.5)) > 1.2) {
      if (!await U.safe(bot, () => U.goTo(bot, site.stand.x, site.stand.y, site.stand.z, 0, 30000), 'toStand')) { badRun++; continue }
      // centre on the block so the geometry (reach / cast distance) holds
      await sleep(200)
    }
    let open = openCells(bot, site)
    if (open.length < Math.min(3, site.cells.length)) {
      st.opened += await openHole(bot, site)
      await sleep(300)
      open = openCells(bot, site)
      if (!open.length) { badRun++; await sleep(1000); continue }
      await U.safe(bot, () => lightHole(bot, site), 'light')
    }
    // aim at an open cell; prefer the one closest to the hole centre, rotate on misses
    // only the pad (>= 3 blocks out) is a casting target; the channel is for the catch to come home
    const s0 = site.stand
    let pad = open.filter(c => Math.max(Math.abs(c.x - s0.x), Math.abs(c.z - s0.z)) >= 3)
    if (!pad.length) pad = open
    pad.sort((a, b) => a.distanceTo(site.centre) - b.distanceTo(site.centre))
    const c = pad[aimIdx % pad.length]
    const aim = c.offset(0.5, 1.0, 0.5)
    st.casts++
    const r = await fishOnce(bot, aim, { maxMs: opts.castMs || 60000, abort: opts.abort })
    if (r === 'catch') { st.catches++; badRun = 0 } else if (r === 'miss') { st.miss++; aimIdx++; badRun++ } else if (r === 'timeout') { st.timeout++; badRun++ } else if (r === 'norod') { break } else { st.lost++; badRun++; await sleep(500) }
    bot.state.task = 'food:fish ' + st.catches + '/' + st.casts
  }
  st.fish = fishCount(bot) - fish0
  st.ms = Date.now() - t0
  return st
}

module.exports = { findSite, openHole, openCells, lightHole, fishOnce, session, fishCount, holeCell, installHooks, myBobber, FISH_RE, invTotal }
