// Shared low-level helpers for survival skills. Everything here is defensive:
// every await that can hang is wrapped in a timeout, every failure returns false
// instead of throwing (except cancellation).
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const swallow = require('./swallow')

// bots/ dir – shared state + lock files live here (the manager is sharded into
// several processes, so in-process locks are NOT enough).
const DIR = path.join(__dirname, '..', '..')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

class Cancelled extends Error {
  constructor (m = 'cancelled') { super(m); this.cancelled = true }
}

// --- cancellation ---------------------------------------------------------
function ck (bot) {
  if (!bot || !bot.entity) throw new Cancelled('no entity')
  if (bot.state && bot.state.cancel) throw new Cancelled()
}
function cancelled (bot) { return !bot || !bot.entity || (bot.state && bot.state.cancel) }

// cancel-aware sleep
async function nap (bot, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    ck(bot)
    await sleep(Math.min(400, end - Date.now()))
  }
}

function withTimeout (p, ms, label = 'op') {
  let t
  return Promise.race([
    Promise.resolve(p).then(v => { clearTimeout(t); return v }, e => { clearTimeout(t); throw e }),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout:' + label)), ms) })
  ])
}

// run fn, swallow non-cancel errors
async function safe (bot, fn, label = '') {
  try { return await fn() } catch (e) {
    if (e && e.cancelled) throw e
    if (bot) note(bot, 'warn', label + ': ' + String(e && e.message || e).slice(0, 120))
    return null
  }
}

function note (bot, kind, msg) {
  const g = G()
  if (!g.log) g.log = []
  g.log.push({ t: Date.now(), bot: bot && bot.username, kind, msg })
  if (g.log.length > 400) g.log.shift()
  if (bot) bot.__lastNote = msg
}

// --- global (survives skills/ hot-reload because it lives on globalThis) ---
function G () {
  if (!global.__squad) global.__squad = { locks: new Map(), log: [], mem: {} }
  return global.__squad
}
// Cross-process advisory lock (tmp file + exclusive create). Best effort: after
// `ms` we proceed anyway so a crashed holder can never deadlock the squad.
async function withLock (name, fn, ms = 45000) {
  const f = path.join(DIR, '.lock-' + String(name).replace(/[^\w.-]/g, '_'))
  const start = Date.now()
  let held = false
  while (Date.now() - start < ms) {
    try {
      const fd = fs.openSync(f, 'wx')
      fs.writeSync(fd, process.pid + ' ' + Date.now())
      fs.closeSync(fd)
      held = true
      break
    } catch (e) {
      try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs > 90000) fs.unlinkSync(f) } catch (e_) { /* the holder released it between the openSync and the stat: nothing to break, we retry */ }
      await sleep(200 + Math.random() * 400)
    }
  }
  try { return await fn() } finally { if (held) { try { fs.unlinkSync(f) } catch (e_) { /* another process stole the stale lock and removed the file; the work is done either way */ } } }
}

// --- per-bot blacklist of unreachable blocks / items (TTL) ----------------
function badMap (bot) { if (!bot.__bad) bot.__bad = new Map(); return bot.__bad }
function markBad (bot, key, ms = 240000) {
  const m = badMap(bot)
  m.set(key, Date.now() + ms)
  if (m.size > 400) { const now = Date.now(); for (const [k, v] of m) if (v < now) m.delete(k) }
}
function isBad (bot, key) {
  const m = badMap(bot)
  const v = m.get(key)
  if (!v) return false
  if (v < Date.now()) { m.delete(key); return false }
  return true
}
function kpos (p) { return p.x + ',' + p.y + ',' + p.z }

// --- inventory ------------------------------------------------------------
// WOOD IS ANY WOOD (docs/PLAN-world2.md §9): nothing names a species. A "log" is every item that crafts into planks — logs, stems, wood,
// hyphae, stripped or not, and bamboo blocks (2 planks instead of 4). `mushroom_stem` ends in _stem and is NOT wood.
const LOG_RE = /^(?!mushroom_)\w+_(log|wood|stem|hyphae)$|^(stripped_)?bamboo_block$/
const PLANK_RE = /_planks$/
// ONE list of mobs that attack on sight and can be answered with a sword (every name exists in minecraft-data 26.1: checked 2026-09-19; a name
// an older version lacks is simply never seen). NEVER in this list, whatever a registry calls "hostile":
//   enderman (calm until stared at/hit — army.js decides per entity), zombified_piglin + piglin (neutral), warden (unbeatable: leave),
//   creaking (invulnerable; its heart is the target), iron_golem/wolf/bee/llama/polar_bear/dolphin/goat/panda (neutral), every player.
const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'parched', 'wither_skeleton',
  'spider', 'cave_spider', 'creeper', 'witch', 'slime', 'magma_cube', 'phantom', 'silverfish', 'endermite', 'pillager', 'vindicator',
  'evoker', 'vex', 'ravager', 'guardian', 'breeze', 'blaze', 'zoglin', 'hoglin', 'piglin_brute'])
const TOOL_RE = /_(pickaxe|axe|sword|shovel|hoe)$/
const ARMOR_RE = /_(helmet|chestplate|leggings|boots)$/

function invMap (bot) {
  const m = {}
  for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count
  return m
}
function count (bot, name) {
  let n = 0
  for (const i of bot.inventory.items()) if (i.name === name) n += i.count
  return n
}
function countRe (bot, re) {
  let n = 0
  for (const i of bot.inventory.items()) if (re.test(i.name)) n += i.count
  return n
}
function firstRe (bot, re) { return bot.inventory.items().find(i => re.test(i.name)) }
function has (bot, name, n = 1) { return count(bot, name) >= n }
function freeSlots (bot) { return bot.inventory.emptySlotCount() }

async function equip (bot, name, dest = 'hand') {
  const it = bot.inventory.items().find(i => i.name === name)
  if (!it) return false
  if (dest === 'hand' && bot.heldItem && bot.heldItem.name === name) return true
  try { await withTimeout(bot.equip(it, dest), 6000, 'equip'); return true } catch { return false }
}

// --- movement -------------------------------------------------------------
function setupMovements (bot, opts = {}) {
  try {
    const mv = new Movements(bot)
    mv.allowSprinting = opts.sprint === true // [food-eng] walk by default: sprint = 1 food pt per 40 m, walking = 0 (PLAYBOOK §3, commander ruling c)
    mv.allowParkour = opts.parkour !== false
    mv.canDig = opts.dig !== false
    mv.digCost = opts.digCost || 6      // prefer walking around over tunnelling
    mv.placeCost = 3
    mv.canOpenDoors = true
    mv.allow1by1towers = true
    mv.maxDropDown = opts.maxDropDown || 3
    mv.infiniteLiquidDropdownDistance = false
    const reg = bot.registry
    const scaf = ['cobblestone', 'dirt', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite']
    mv.scafoldingBlocks = scaf.map(n => reg.itemsByName[n] && reg.itemsByName[n].id).filter(x => x != null)
    mv.liquidCost = 40 // bots get PINNED in water on this server: never plan through it
    if (reg.blocksByName.water) mv.blocksToAvoid.add(reg.blocksByName.water.id)
    for (const n of ['sweet_berry_bush', 'powder_snow', 'magma_block', 'cactus', 'campfire', 'lava', 'fire',
      'wither_rose']) {
      const b = reg.blocksByName[n]
      if (b) mv.blocksToAvoid.add(b.id)
    }
    // never break base infrastructure / player stuff
    for (const n of PROTECT) { const b = reg.blocksByName[n]; if (b) mv.blocksCantBreak.add(b.id) }
    for (const b of reg.blocksArray) if (/_bed$|_sign$|shulker_box|spawner|_door$|banner/.test(b.name)) mv.blocksCantBreak.add(b.id)
    bot.pathfinder.setMovements(mv)
    bot.mv = mv
  } catch (e) { note(bot, 'warn', 'movements: ' + e.message) }
}

const PROTECT = ['chest', 'trapped_chest', 'ender_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'anvil', 'brewing_stand', 'enchanting_table', 'bookshelf', 'beacon', 'lodestone',
  'torch', 'wall_torch', 'lantern', 'campfire', 'bell', 'hopper', 'dispenser', 'dropper', 'observer',
  'note_block', 'jukebox', 'cauldron', 'composter', 'loom', 'smithing_table', 'stonecutter', 'grindstone',
  'cartography_table', 'fletching_table', 'farmland', 'water', 'lava', 'obsidian', 'end_portal_frame', 'spawner']
const PROTECT_SET = new Set(PROTECT)
function protectedBlock (b) {
  if (!b) return true
  return PROTECT_SET.has(b.name) || /_bed$|_sign$|shulker_box|_door$|banner/.test(b.name)
}

function near (bot, v, r, xzOnly) {
  const p = bot.entity.position
  if (xzOnly) return Math.hypot(p.x - v.x, p.z - v.z) <= r
  return p.distanceTo(v) <= r
}

// One pathfinder attempt with a progress watchdog: if the bot stops making
// progress (pathfinder happily reports "moving" while wedged) we abort early.
async function pathTo (bot, goal, ms) {
  let last = bot.entity.position.clone()
  let lastMove = Date.now()
  let stuck = false
  const timer = setInterval(() => {
    try {
      if (!bot.entity) return
      const p = bot.entity.position
      if (p.distanceTo(last) > 0.7) { last = p.clone(); lastMove = Date.now(); return }
      if (Date.now() - lastMove > 7000) { stuck = true; bot.pathfinder.setGoal(null) }
    } catch (e_) { swallow('util:pathTick', e_) } // the bot ended/respawned under the timer
  }, 1500)
  if (timer.unref) timer.unref()
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'goto')
    // goto RESOLVES on an EMPTY path (pathfinder lib/goto.js: `path.length === 0` is tested before `noPath`), so "no path at all" read as 'ok' (09-21 19:2xZ)
    const f = bot.entity.position.floored()
    if (goal && typeof goal.isEnd === 'function' && !goal.isEnd(f) && !goal.isEnd(f.offset(0, 1, 0))) return 'fail'
    return 'ok'
  } catch (e) {
    if (cancelled(bot)) throw new Cancelled()
    return stuck ? 'stuck' : 'fail'
  } finally {
    clearInterval(timer)
    try { bot.pathfinder.setGoal(null) } catch (e_) { /* no pathfinder any more (bot ended): there is no goal left to clear */ }
  }
}

// Walk to (x,y,z). Long trips are split into <=40 block hops (pathfinder's
// think/tick budget is small), and we bail out of hopeless goals quickly.
async function goTo (bot, x, y, z, range = 2, ms = 60000) {
  ck(bot)
  const start = Date.now()
  const flatTarget = new Vec3(x, 0, z)
  const left = () => ms - (Date.now() - start)
  // waypoint hops
  for (let hop = 0; hop < 8; hop++) {
    ck(bot)
    const p = bot.entity.position
    const d = Math.hypot(p.x - x, p.z - z)
    if (d <= 45 || left() < 8000) break
    const t = Math.min(40 / d, 1)
    const wx = Math.round(p.x + (x - p.x) * t)
    const wz = Math.round(p.z + (z - p.z) * t)
    const r = await pathTo(bot, new goals.GoalNearXZ(wx, wz, 4), Math.min(left(), 35000))
    if (r !== 'ok') {
      if (r === 'stuck') await unstuck(bot)
      await sleep(600)
      const p2 = bot.entity.position
      if (Math.hypot(p2.x - p.x, p2.z - p.z) < 3) break // no progress -> stop hopping
    }
  }
  const target = new Vec3(x, y == null ? bot.entity.position.y : y, z)
  for (let i = 0; i < 3; i++) {
    ck(bot)
    if (near(bot, target, range + 0.5, y == null)) return true
    if (left() < 2000) break
    const goal = (y == null) ? new goals.GoalNearXZ(x, z, range) : new goals.GoalNear(x, y, z, range)
    const r = await pathTo(bot, goal, Math.min(left(), 30000))
    if (r === 'ok') return true
    if (r === 'stuck') await unstuck(bot)
    await sleep(500 + i * 500)
  }
  return near(bot, target, range + 2, y == null)
}

// READ-ONLY (movement doctrine): never digs. A wedged bot lets go, leaves water, and walks by hand towards the most open side (the pathfinder
// refuses to plan from some spots). A bot that is really boxed in is army.js travel()'s business (digOut: one logged escape edit).
async function unstuck (bot) {
  try {
    ck(bot)
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    if (bot.entity.isInWater) { await escapeWater(bot, 20000); return }
    const feet = bot.entity.position.floored()
    let best = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let score = 0
      for (let d = 1; d <= 3; d++) { if (isAirish(bot, feet.offset(dx * d, 0, dz * d)) && isAirish(bot, feet.offset(dx * d, 1, dz * d))) score++; else break }
      if (!best || score > best.score) best = { dx, dz, score }
    }
    if (!best.score) return
    await bot.lookAt(feet.offset(best.dx * 6 + 0.5, 1.4, best.dz * 6 + 0.5), true).catch(e_ => swallow('util:unstuckLook', e_))
    bot.setControlState('jump', true); bot.setControlState('forward', true)
    await sleep(1500)
  } catch (e) { if (e && e.cancelled) throw e; swallow('util:unstuck', e) } finally { try { bot.clearControlStates() } catch (e_) { swallow('util:unstuckClear', e_) } }
}

// Swim out of water. NOTE: holding 'jump' while in water freezes horizontal
// movement in mineflayer's physics, so we only ever hold 'forward' here.
function shoreNear (bot, maxR = 20) {
  const me = bot.entity.position.floored()
  // NOTE: start at r=1 — a bot bobbing in a 1-block hole in a frozen lake has
  // its shore at distance 1 and used to be reported as "no shore at all".
  for (let r = 1; r <= maxR; r += 1) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (let dy = -1; dy <= 3; dy++) {
          const p = me.offset(dx, dy, dz)
          const b = bot.blockAt(p)
          if (!b || b.boundingBox !== 'block' || b.name === 'ice' || b.name === 'packed_ice' || b.name === 'blue_ice') continue
          const a1 = bot.blockAt(p.offset(0, 1, 0))
          const a2 = bot.blockAt(p.offset(0, 2, 0))
          if (a1 && a1.boundingBox === 'empty' && a1.name !== 'water' && a2 && a2.boundingBox === 'empty') return p
        }
      }
    }
  }
  return null
}

async function escapeWater (bot, ms = 15000) {
  if (!bot.entity || !bot.entity.isInWater) return false
  const end = Date.now() + ms
  try { bot.pathfinder.setGoal(null) } catch (e_) { /* no pathfinder any more (bot ended): there is no goal left to clear */ }
  while (Date.now() < end) {
    ck(bot)
    if (!bot.entity.isInWater) break
    const shore = shoreNear(bot, 24)
    if (!shore) break
    // level pitch: looking down (or holding jump) kills swim motion
    const me = bot.entity.position
    const yaw = Math.atan2(-(shore.x + 0.5 - me.x), -(shore.z + 0.5 - me.z))
    await bot.look(yaw, 0, true).catch(() => {})
    bot.clearControlStates()
    bot.setControlState('forward', true)
    await sleep(2000)
    bot.setControlState('jump', true)
    await sleep(200)
    bot.setControlState('jump', false)
    await sleep(400)
  }
  bot.clearControlStates()
  return !bot.entity.isInWater
}

// --- digging / collecting -------------------------------------------------
// Plants/crops have boundingBox 'empty' but ARE breakable and are the whole
// point of farming: refusing them here made wheat harvesting and seed gathering
// silently impossible army-wide (collectSeeds/farmWork/mineAt all go through
// digBlock). Liquids and air stay excluded.
const BREAKABLE_EMPTY = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|wheat|carrots|potatoes|beetroots|torchflower_crop|pitcher_crop|melon_stem|pumpkin_stem|sweet_berry_bush|sugar_cane|bamboo|kelp|kelp_plant|seagrass|tall_seagrass|vine|cave_vines|cave_vines_plant|nether_wart|cocoa|lily_pad|snow|red_mushroom|brown_mushroom|crimson_fungus|warped_fungus|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|.*_tulip|.*_sapling|moss_carpet|.*_carpet|hanging_roots|glow_lichen|sculk_vein)$/

async function digBlock (bot, block, ms = 25000, force = false) {
  if (!block || block.name === 'air') return false
  if (block.boundingBox === 'empty' && !BREAKABLE_EMPTY.test(block.name)) return false
  if (PROTECT_SET.has(block.name)) return false
  if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 5) return false
  try { await withTimeout(bot.tool.equipForBlock(block, { requireHarvest: !force }), 5000, 'equipForBlock') } catch (e_) { swallow('util:equipForBlock', e_) } // no tool / equip timed out: canDigBlock + canHarvest below still gate the dig
  if (!bot.canDigBlock(block)) return false
  // never waste minutes hand-digging something that drops nothing (unless we
  // are digging ourselves out of a hole, where we don't care about drops)
  if (!force && !canHarvest(bot, block)) return false
  try {
    await withTimeout(bot.dig(block, true), ms, 'dig')
    return true
  } catch (e) {
    try { bot.stopDigging() } catch (e_) { /* nothing was being dug (the dig threw before it started) */ }
    return false
  }
}

// does the currently held item actually let us harvest this block?
function canHarvest (bot, block) {
  const need = block.harvestTools
  if (!need) return true
  const held = bot.heldItem
  return !!(held && need[held.type])
}

// walk to a block then mine it (and pick up the drops)
async function mineAt (bot, pos, ms = 45000) {
  ck(bot)
  const key = kpos(pos)
  if (isBad(bot, key)) return false
  let b = bot.blockAt(pos)
  // "not loaded" is not "nothing there" (owner 09-21): the cell is parked for a minute and the blind read is REPORTED, not counted as done.
  if (!b) { swallow.blind(bot, 'util:mineAt', 'target cell not loaded, it is not empty'); markBad(bot, key, 60000); return false }
  if (b.name === 'air') return false
  if (PROTECT_SET.has(b.name)) { markBad(bot, key, 600000); return false }
  const d = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5))
  if (d > 4.2) {
    const ok = await goTo(bot, pos.x, pos.y, pos.z, 3, Math.min(ms, 25000))
    if (!ok || bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 5) { markBad(bot, key, 180000); return false }
    b = bot.blockAt(pos)
    if (!b) { swallow.blind(bot, 'util:mineAt', 'target cell still not loaded after walking to it'); markBad(bot, key, 60000); return false }
    if (b.name === 'air') return false
  }
  const dug = await digBlock(bot, b, 25000)
  if (!dug) { markBad(bot, key, 120000); return false }
  await pickupNear(bot, 2000, 5)
  return true
}

async function pickupNear (bot, ms = 3000, radius = 5) {
  const end = Date.now() + ms
  let chased = 0
  while (Date.now() < end && chased < 3) {
    ck(bot)
    if (freeSlots(bot) <= 0) return
    const me = bot.entity.position
    const list = Object.values(bot.entities).filter(e => e && e.position && e.name === 'item' &&
      !isBad(bot, 'item' + e.id) &&
      e.position.distanceTo(me) < radius &&
      e.position.y - me.y < 2.5 && me.y - e.position.y < 6)
    if (!list.length) { await sleep(250); continue }
    list.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    const it = list[0]
    if (it.position.distanceTo(me) < 1.4) { await sleep(300); continue }
    chased++
    markBad(bot, 'item' + it.id, 120000) // one attempt per item, then forget it
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 1)), 5000, 'pickup')
    } catch (e_) { swallow('util:pickupGoto', e_); try { bot.pathfinder.setGoal(null) } catch (e2) { /* no pathfinder any more */ } } // the drop is out of reach; markBad above means one try per item
    await sleep(150)
  }
}

// find blocks by name(s)
function findBlocksByName (bot, names, maxDistance = 48, cnt = 16) {
  const arr = Array.isArray(names) ? names : [names]
  const ids = []
  for (const n of arr) { const b = bot.registry.blocksByName[n]; if (b) ids.push(b.id) }
  if (!ids.length) return []
  try {
    return bot.findBlocks({ matching: ids, maxDistance, count: cnt }).filter(v => !isBad(bot, kpos(v)))
  } catch (e_) { swallow('util:findBlocks', e_); return [] } // findBlocks throws while the chunk column is being swapped; the caller re-scans next pass
}

// --- placing --------------------------------------------------------------
const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

// UNKNOWN IS AN ANSWER (owner 09-21; the one reader is lib/blocks.js readAt): bot.blockAt() is null for an UNLOADED chunk, and a cell we
// cannot see is neither air nor solid. Both predicates say FALSE for it — so nothing is placed into it and nothing is stood on it — and
// isUnknownAt() lets a caller tell "no" from "I could not look".
function isUnknownAt (bot, pos) { try { return !bot.blockAt(pos) } catch (e_) { swallow('util:isUnknownAt', e_); return true } }
function isAirish (bot, pos) {
  const b = bot.blockAt(pos)
  return !!b && (b.boundingBox === 'empty') && b.name !== 'water' && b.name !== 'lava'
}
function isSolid (bot, pos) {
  const b = bot.blockAt(pos)
  return !!b && b.boundingBox === 'block'
}

async function placeBlockAt (bot, itemName, pos) {
  ck(bot)
  if (isUnknownAt(bot, pos)) { swallow.blind(bot, 'util:placeBlockAt', 'target cell not loaded, refusing to place into a cell we cannot see'); return false }
  if (!isAirish(bot, pos)) return false
  const feet = bot.entity.position.floored()
  if (pos.equals(feet) || pos.equals(feet.offset(0, 1, 0))) {
    await goTo(bot, pos.x + 2, pos.y, pos.z + 2, 1, 10000).catch(() => {})
  }
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
    await goTo(bot, pos.x, pos.y, pos.z, 2, 20000)
  }
  if (!await equip(bot, itemName, 'hand')) return false
  for (const d of FACES) {
    const refPos = pos.minus(d)
    const ref = bot.blockAt(refPos)
    if (!ref || ref.boundingBox !== 'block') continue
    if (ref.name === 'water' || ref.name === 'lava') continue
    try {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
      await withTimeout(bot.placeBlock(ref, d), 8000, 'place')
      await sleep(120)
      const nb = bot.blockAt(pos)
      if (nb && nb.name !== 'air') return true
    } catch (e) { /* try next face */ }
  }
  return false
}

// find a free spot next to the bot to place a utility block
function freeSpotNear (bot, radius = 3) {
  const base = bot.entity.position.floored()
  const cands = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dz === 0) continue
        const p = base.offset(dx, dy, dz)
        if (!isAirish(bot, p)) continue
        if (!isSolid(bot, p.offset(0, -1, 0))) continue
        if (!isAirish(bot, p.offset(0, 1, 0))) continue
        cands.push(p)
      }
    }
  }
  cands.sort((a, b) => a.distanceTo(base) - b.distanceTo(base))
  return cands[0] || null
}

module.exports = {
  DIR, Vec3, goals, sleep, nap, ck, cancelled, Cancelled, withTimeout, safe, note, G, withLock,
  LOG_RE, PLANK_RE, TOOL_RE, ARMOR_RE, HOSTILE, invMap, count, countRe, firstRe, has, freeSlots, equip,
  setupMovements, goTo, pathTo, unstuck, digBlock, canHarvest, mineAt, pickupNear, findBlocksByName,
  placeBlockAt, freeSpotNear, escapeWater, shoreNear, markBad, isBad, kpos, isAirish, isSolid, isUnknownAt, PROTECT_SET, protectedBlock
}
