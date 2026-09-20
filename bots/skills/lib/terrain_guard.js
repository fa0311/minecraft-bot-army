// TERRAIN GUARD — army-wide pathfinder policy (owner: "mineflayerって移動する時にブロック置きながら移動する").
//
// mineflayer-pathfinder's default Movements bridges/pillars with scaffolding blocks and digs through
// terrain while travelling. Every team builds its own `new Movements(bot)`, so the policy is enforced
// where no skill can bypass it: `bot.pathfinder.setMovements` is wrapped, and a 2 s timer re-applies the
// policy to whatever Movements object is live (so later mutation such as `bot.mv.canDig = true` does
// not stick either).
//
//   SURFACE  (feet y >= 58 and open sky above — leaves/logs count as sky — and not in a registered mine):
//            pathfinder may NOT dig and may NOT place: canDig=false, allow1by1towers=false,
//            scafoldingBlocks=[], liquidCost>=30, dig/placeCost prohibitive. Sprinting is the caller's choice (army.js strictMovements).
//   UNDERGROUND (y < 58, roofed over, or inside a box of bots/mine_zones.json):
//            limited: digging only with a pickaxe in the inventory (no 7.5 s stick-digging that drops
//            nothing), digCost >= 4, scaffolding limited to dirt/cobble-like filler.
//   OPT-OUT  bot.state.terrainEditOK = { until: <epoch ms>, reason: '...' }  (max 15 min, logged).
//            For approved build jobs / escape routines only. While active the skill's own settings apply.
//
// If a bot then has no path it must fail fast and report / walk around / use an escape routine
// (bot.unwedge, lib/blocks.js pillarUp+cleanup) — not terraform.
//
// Usage:  require('./terrain_guard').install(bot)     (idempotent, hot-upgradeable)
//         require('./terrain_guard').stats(bot)       -> { mode, pfPlaced, pfDug, blocked... }
const fs = require('fs')
const path = require('path')

const VERSION = 7 // 7 (09-20): the 2 s tick and the setMovements wrapper call the LIVE module's apply() - v6's tick kept its OWN closure, so the hot-loaded
                  // "sprinting is the caller's choice" never reached a running bot: all 50 measured allowSprinting=false, 0 % sprint samples, 3.96 m/s
const SURFACE_Y = 58
const SKY_SCAN = 24
const ROOF_MIN = 4
const MAX_OPTOUT_MS = 15 * 60 * 1000
const BOTS_DIR = path.join(__dirname, '..', '..')
const LOG_FILE = path.join(BOTS_DIR, 'terrain_guard.log')
const MINE_FILE = path.join(BOTS_DIR, 'mine_zones.json') // [{x1,y1,z1,x2,y2,z2,name}] — registered mines / quarries

const FILLER = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff']
const SEE_THROUGH = /^(air|cave_air|void_air|.*_leaves|.*_log|.*_wood|snow|short_grass|grass|tall_grass|fern|large_fern|vine|torch|wall_torch|.*_sapling|dead_bush|sweet_berry_bush|.*_fence|.*_fence_gate|.*_sign|water|ice)$/

let mineCache = { t: 0, zones: [] }
function mineZones () {
  const now = Date.now()
  if (now - mineCache.t < 15000) return mineCache.zones
  mineCache.t = now
  try {
    const raw = JSON.parse(fs.readFileSync(MINE_FILE, 'utf8'))
    mineCache.zones = (Array.isArray(raw) ? raw : raw.zones || []).map(z => ({
      x1: Math.min(z.x1, z.x2), x2: Math.max(z.x1, z.x2), y1: Math.min(z.y1, z.y2), y2: Math.max(z.y1, z.y2), z1: Math.min(z.z1, z.z2), z2: Math.max(z.z1, z.z2)
    }))
  } catch { mineCache.zones = [] }
  return mineCache.zones
}
function inMine (p) {
  for (const z of mineZones()) if (p.x >= z.x1 && p.x <= z.x2 && p.y >= z.y1 && p.y <= z.y2 && p.z >= z.z1 && p.z <= z.z2) return true
  return false
}

function log (bot, o) {
  const e = Object.assign({ t: new Date().toISOString(), bot: bot.username, type: 'terrain_guard' }, o)
  try { if (typeof bot.__logEvent === 'function') bot.__logEvent(e) } catch {}
  try { fs.appendFile(LOG_FILE, JSON.stringify(e) + '\n', () => {}) } catch {}
}

function optOut (bot) {
  const o = bot.state && bot.state.terrainEditOK
  if (!o || typeof o !== 'object') return null
  const now = Date.now()
  if (!(o.until > now)) return null
  if (o.until - now > MAX_OPTOUT_MS) o.until = now + MAX_OPTOUT_MS
  if (!o.reason) return null // an opt-out without a reason is not an opt-out
  return o
}

// 'free' | 'surface' | 'underground'
function modeOf (bot) {
  if (!bot.entity) return 'surface'
  if (bot.game && bot.game.dimension && !/overworld/.test(bot.game.dimension)) return 'underground' // nether/end: limited
  const oo = optOut(bot)
  if (oo) return 'free'
  const p = bot.entity.position.floored()
  if (p.y < SURFACE_Y) return 'underground'
  if (inMine(p)) return 'underground'
  // "roofed over by terrain" = at least ROOF_MIN solid blocks in the column above the head. One block is a
  // hut roof / chest / overhang (still the surface!); a cave, tunnel or staircase has metres of rock above.
  let solid = 0
  for (let dy = 2; dy <= SKY_SCAN; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0), false)
    if (!b) break // unloaded / above build height -> sky
    if (!SEE_THROUGH.test(b.name) && ++solid >= ROOF_MIN) return 'underground'
  }
  return 'surface'
}

function hasPickaxe (bot) {
  try { return bot.inventory.items().some(i => /_pickaxe$/.test(i.name)) } catch { return false }
}

// remember what the skill asked for, so leaving the surface restores it
const KEYS = ['canDig', 'allow1by1towers', 'allowSprinting', 'digCost', 'placeCost']
function remember (mv) {
  let w = mv.__tgWant
  if (!w) {
    w = {
      canDig: mv.canDig, allow1by1towers: mv.allow1by1towers, scafoldingBlocks: (mv.scafoldingBlocks || []).slice(),
      allowSprinting: mv.allowSprinting, digCost: mv.digCost, placeCost: mv.placeCost
    }
    Object.defineProperty(mv, '__tgWant', { value: w, enumerable: false, writable: true, configurable: true })
    return w
  }
  // the skill changed a field after we applied the policy -> that is its new wish (the policy is re-applied on top)
  const a = mv.__tgApplied
  if (a) {
    for (const k of KEYS) if (mv[k] !== a[k]) w[k] = mv[k]
    const cur = mv.scafoldingBlocks || []
    if (cur.length !== a.scafN) w.scafoldingBlocks = cur.slice()
  }
  return w
}
function applied (mv) {
  const a = { scafN: (mv.scafoldingBlocks || []).length }
  for (const k of KEYS) a[k] = mv[k]
  if (mv.__tgApplied) mv.__tgApplied = a
  else Object.defineProperty(mv, '__tgApplied', { value: a, enumerable: false, writable: true, configurable: true })
}

function apply (bot, mv, mode) {
  if (!mv) return mv
  const want = remember(mv)
  if (!(mv.liquidCost >= 30)) mv.liquidCost = 30
  mv.infiniteLiquidDropdownDistance = false
  if (!(mv.maxDropDown <= 4)) mv.maxDropDown = 4
  if (mode === 'free') {
    mv.canDig = want.canDig; mv.allow1by1towers = want.allow1by1towers; mv.scafoldingBlocks = want.scafoldingBlocks.slice()
    mv.allowSprinting = want.allowSprinting; mv.digCost = want.digCost; mv.placeCost = want.placeCost
  } else if (mode === 'surface') {
    mv.canDig = false
    mv.allow1by1towers = false
    mv.scafoldingBlocks = []
    // sprinting is the caller's choice (army.js strictMovements: on while the larder is full; owner 09-20 "走る") - the guard only forbids world edits
    mv.digCost = 1000
    mv.placeCost = 1000
  } else { // underground: limited
    mv.canDig = !!want.canDig && hasPickaxe(bot)
    mv.allow1by1towers = want.allow1by1towers
    const reg = bot.registry
    const ok = new Set(FILLER.map(n => reg.itemsByName[n] && reg.itemsByName[n].id).filter(x => x != null))
    mv.scafoldingBlocks = want.scafoldingBlocks.filter(id => ok.has(id))
    mv.allowSprinting = !!want.allowSprinting
    mv.digCost = Math.max(4, want.digCost || 1)
    mv.placeCost = Math.max(2, want.placeCost || 1)
  }
  applied(mv)
  return mv
}

// the policy is looked up in the module that is loaded NOW (skills/lib hot-reloads): a timer installed by an older copy must not keep enforcing the old policy
function live () { try { const m = require(__filename); return m && typeof m.apply === 'function' ? m : module.exports } catch { return module.exports } }
function install (bot, opts = {}) {
  if (!bot || !bot.pathfinder) return false
  const prev = bot.__tg
  if (prev && prev.version === VERSION && prev.timer) return true
  const st = { version: VERSION, mode: null, since: Date.now(), pfPlaced: 0, pfDug: 0, modeChanges: 0, optOuts: 0, lastOptReason: null }
  if (prev) { // hot upgrade: keep the original setMovements + counters, drop the old timer/listeners
    try { clearInterval(prev.timer) } catch {}
    try { if (prev.onPlaced) bot.removeListener('blockPlaced', prev.onPlaced) } catch {}
    try { if (prev.onDug) bot.removeListener('diggingCompleted', prev.onDug) } catch {}
    st.orig = prev.orig
    if (prev.version >= 6) for (const k of ['pfPlaced', 'pfDug', 'pfPlacedSurface', 'pfDugSurface', 'skillPlaced', 'skillDug', 'since', 'optOuts', 'pfLog']) if (prev[k] != null) st[k] = prev[k]
  } else {
    st.orig = bot.pathfinder.setMovements.bind(bot.pathfinder)
  }
  bot.__tg = st
  // the wrapper looks the policy up through bot.__tg, so a later install() upgrades it in place
  bot.pathfinder.setMovements = (mv) => {
    const g = bot.__tg
    try { if (mv) { live().apply(bot, mv, g.mode || (g.mode = modeOf(bot))) } } catch (e) { try { apply(bot, mv, 'surface') } catch {} }
    bot.mv = mv
    return g.orig(mv)
  }
  const tick = () => {
    try {
      if (!bot.entity || !bot.pathfinder) return
      const mode = modeOf(bot)
      const g = bot.__tg
      if (mode !== g.mode) {
        g.modeChanges++
        if (mode === 'free') { g.optOuts++; g.lastOptReason = bot.state.terrainEditOK.reason; log(bot, { ev: 'opt_out', reason: String(bot.state.terrainEditOK.reason).slice(0, 120), until: bot.state.terrainEditOK.until, task: bot.state.task }) }
        g.mode = mode
        // re-install so the pathfinder drops a path that was planned under the old rules (it may hold toPlace/toBreak steps)
        const mv0 = bot.pathfinder.movements
        if (mv0) { live().apply(bot, mv0, mode); try { g.orig(mv0) } catch {} }
      }
      const mv = bot.pathfinder.movements
      if (mv) live().apply(bot, mv, mode)
    } catch {}
  }
  // count pathfinder-initiated edits at packet level (the pathfinder's isBuilding() flag is already reset
  // by its own blockUpdate handler when 'blockPlaced' fires, so events under-count)
  st.onWrite = function (name, params) {
        try {
          const g = bot.__tg
          if (name === 'block_place') {
            // isBuilding() can be stale (goal dropped mid-placement), so also require a live goal + a block-ish item on a non-container
            const held = bot.heldItem
            const pf = bot.pathfinder.isBuilding() && bot.pathfinder.isMoving() && held && bot.registry.blocksByName[held.name]
            if (pf) {
              g.pfPlaced++; g.lastPf = Date.now()
              if (g.mode === 'surface') g.pfPlacedSurface = (g.pfPlacedSurface || 0) + 1
              const ev = (g.pfLog = g.pfLog || []); ev.push({ t: Date.now(), mode: g.mode, item: held.name, at: params && params.location, task: bot.state && bot.state.task }); if (ev.length > 10) ev.shift()
            } else g.skillPlaced = (g.skillPlaced || 0) + 1
          } else if (params && params.status === 0) { if (bot.pathfinder.isMining()) { g.pfDug++; g.lastPf = Date.now(); if (g.mode === 'surface') g.pfDugSurface = (g.pfDugSurface || 0) + 1 } else g.skillDug = (g.skillDug || 0) + 1 }
        } catch {}
  }
  // the wrapper only delegates to bot.__tg.onWrite, so install() upgrades the logic in place
  if (prev && prev.rawWrite && prev.delegating) { st.rawWrite = prev.rawWrite; st.delegating = true } else {
    if (prev && prev.rawWrite && /pfPlaced\+\+/.test(String(bot._client.write))) bot._client.write = prev.rawWrite // unwrap a pre-v6 wrapper
    st.rawWrite = bot._client.write
    st.delegating = true
    const raw = st.rawWrite
    bot._client.write = function (name, params) {
      if (name === 'block_place' || name === 'block_dig') { const g = bot.__tg; if (g && g.onWrite) g.onWrite(name, params) }
      return raw.apply(this, arguments)
    }
  }
  st.timer = setInterval(tick, opts.intervalMs || 2000)
  if (st.timer.unref) st.timer.unref()
  bot.once('end', () => { try { clearInterval(st.timer) } catch {} })
  tick()
  return true
}

function stats (bot) {
  const g = bot.__tg
  if (!g) return null
  const mv = bot.pathfinder && bot.pathfinder.movements
  return { v: g.version, mode: g.mode, mins: +((Date.now() - g.since) / 60000).toFixed(1), pfPlaced: g.pfPlaced, pfDug: g.pfDug, pfPlacedSurface: g.pfPlacedSurface || 0, pfDugSurface: g.pfDugSurface || 0, skillPlaced: g.skillPlaced || 0, skillDug: g.skillDug || 0, optOuts: g.optOuts, lastOptReason: g.lastOptReason,
    canDig: mv && mv.canDig, towers: mv && mv.allow1by1towers, scaf: mv && mv.scafoldingBlocks && mv.scafoldingBlocks.length }
}

// Skills with an APPROVED plan (or an escape routine) may let the pathfinder edit terrain for a while.
function allowTerrainEdit (bot, reason, ms = 5 * 60 * 1000) {
  if (!reason) throw new Error('terrainEditOK needs a reason')
  bot.state.terrainEditOK = { until: Date.now() + Math.min(ms, MAX_OPTOUT_MS), reason: String(reason) }
  return bot.state.terrainEditOK
}
function revokeTerrainEdit (bot) { if (bot.state) delete bot.state.terrainEditOK }

module.exports = { VERSION, install, apply, modeOf, stats, allowTerrainEdit, revokeTerrainEdit, SURFACE_Y }
