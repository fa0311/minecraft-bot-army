// army_jobs.js — job handlers of the ONE ARMY worker. handler(bot, job, api, ctx) runs until api.stop() is true
// (job changed / cancelled / died / slice over) and returns a short string. Handlers never improvise: if a
// precondition is missing they say so (api.idle(reason)) and stand at the muster point.
const { Vec3 } = require('vec3')
const swallow = require('./swallow')
const U = require('./util')
const A = require('./army')
const sleep = A.sleep

// helper libs are require()d lazily by handlers; Node caches them forever, so a fix in craft.js/blocks.js never reached the running bots.
// lib(name) reloads a module when its file changed (mtime) — use it instead of require('./name') inside handlers and verbs.
const _libM = {}
function lib (name) {
  const f = require.resolve('./' + name)
  try { const m = require('fs').statSync(f).mtimeMs; if (_libM[f] !== m) { delete require.cache[f]; _libM[f] = m } } catch (e_) { swallow('army_jobs:14', e_) }
  return require(f)
}
// NIGHT IS NOT A REASON TO WAIT (owner 09-19): with a bed + sleeper the night lasts seconds, and mobs can be fought. While
// settings.nightSkip is true, no handler parks bots for darkness or for "not enough daylight"; only the sleeper/guard jobs care about night.
// STRING NIGHTS: sleeping every night means no spiders = no string = no fishing rods = no food. While the depot holds fewer than
// settings.minString string, nights are REAL: the sleeper stays up and fights with the armoured night watch (spiders: 0-2 string each),
// unarmoured bots work underground. As soon as the stock is reached the army sleeps through the nights again.
function stringNight () { const n = A.readJSON(require('path').join(A.DIR, 'night.json'), {}); return !!(A.settings().nightSkip && n.real && Date.now() - (n.t || 0) < 3600000) } // decided by the dispatcher: string wanted AND >= 6 fit armoured fighters
function isNight (api) { return api.phase() !== 'day' && (!A.settings().nightSkip || stringNight()) }
function v (p) { return Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z) }
// Settings that describe THIS world (muster point, beds …) have NO defaults in code: a missing value is reported once per bot and the feature skips.
function setting (bot, key) {
  const val = key === 'muster' ? A.musterPos() : A.settings()[key] // muster: CONTRACT form [x,y,z] or the old {x,y,z,cols,step} - A.musterPos reads both
  if (val != null) return val
  const said = bot.__armyMissSaid = bot.__armyMissSaid || {}
  if (!said[key]) { said[key] = true; A.result(bot, { ev: 'setting_missing', key, note: 'settings.' + key + ' is not set in jobs.json - what needs it is skipped' }) }
  return null
}
function task (bot, s) { if (bot.state) bot.state.task = 'army:' + s }
// WOOD IS WHATEVER GROWS AT THE BASE (world 1 hard-coded spruce in six places: in any other biome chests, fuel and saplings would have run dry).
// stockNames(re) = depot items matching re, biggest pile first; carriedRe = the same for the pockets.
function stockNames (re) { return Object.entries(A.stockMap()).filter(([k, n]) => n > 0 && re.test(k)).sort((a, b) => b[1] - a[1]).map(([k]) => k) }
function stockRe (re) { return Object.entries(A.stockMap()).reduce((n, [k, q]) => n + (re.test(k) ? q : 0), 0) }
const SAPLING_RE = /_sapling$|^mangrove_propagule$/
// BELOW THE SURFACE = 3 under the surface floor of A.travel's SURFACE RULE (sea level - 5; the same in every overworld - never a base height)
// RATIONS a bot keeps when it banks: 8 of every COOKED food it carries (world 1 listed bread + cooked fish; a base that lives on its herds banked its steaks)
function rationsOf (bot) { const k = {}; for (const i of bot.inventory.items()) if (bot.registry.foodsByName[i.name] && !RAW_FOOD.includes(i.name) && !/^(rotten_flesh|spider_eye|pufferfish|poisonous_potato|potato|carrot|beetroot|wheat|sweet_berries|glow_berries)$/.test(i.name)) k[i.name] = 8; return k }
// DIMENSION (09-20 12:1xZ, docs/BUGS.md: a scout who was in the NETHER was handed the `tidy` sponge and dug herself in under the Nether
// roof at y123 — with overworld coordinates). Everything base-bound in this file — the muster slot, the canteen, banking, the bed, the
// mine stairs — is a set of OVERWORLD coordinates and means nothing anywhere else. A bot that is not in the overworld skips all of it
// and stands still; the dispatcher's dimension rule (`settings.nether.returnJob`, job type `portal`) is what brings it home.
const overworld = bot => !bot.game || /overworld/.test(String(bot.game.dimension))
// `underground` is dimension-safe by construction: A.surfaceFloor() is null outside the overworld, so nothing there counts as below the surface.
function underground (bot, y) { const f = A.surfaceFloor(bot); return f != null && (y == null ? bot.entity.position.y : y) < f - 3 }

// ------------------------------------------------------------------ canteen: a hungry bot near base eats from the FOOD chest
// Index-driven (bots/army/chests.json): no stock on record -> no walk, so nobody circles an empty chest. Cooked first;
// raw only when starving. One visit per 90 s per bot. Returns items taken.
const RAW_FOOD = ['salmon', 'cod', 'mutton', 'beef', 'porkchop', 'chicken', 'rabbit']
function foodStock (bot, rawOk) {
  const tot = {}
  for (const v of Object.values(A.index())) for (const [k, n] of Object.entries(v.items || {})) tot[k] = (tot[k] || 0) + n
  const foods = bot.registry.foodsByName
  return Object.keys(tot).filter(k => foods[k] && !/^(rotten_flesh|spider_eye|pufferfish|poisonous_potato)$/.test(k) && (rawOk || !RAW_FOOD.includes(k)))
    .sort((a, b) => (foods[b].saturation || 0) - (foods[a].saturation || 0))
}
// UNDERGROUND near the mine (`underground`) with business on the surface: leave by the miner's own stairs - the routine delegate() uses for a recall.
// A.travel from down there ends in its boxed-in escape = one more private tunnel under the base (09-19: two miners re-assigned to surface
// jobs while jammed on the stair cut their own staircase through 36 levels of rock). true = the routine ran.
async function upTheStairs (bot, label) {
  const mine = A.readJSON(require('path').join(A.DIR, '..', 'iron_mine.json'), {}) || {}
  const head = (mine.steps || [])[0]
  if (!head || A.dist2(bot, head[0], head[2]) > 100) return false
  // A HOLE UNDER THE OPEN SKY IS NOT THE MINE (09-20 05:50Z: builders filling the ravine at y40-58 were "recalled" through the mine - 19 `mine_reconnect`
  // tunnels towards the stairwell wall, `stair_broken`/`stair_repaired` churn): only a bot that has ROCK over its head is sent up the stairs;
  // under the sky it walks out (travel knows the keep-out exit) or keeps working where its job put it.
  if (A.skyAbove(bot)) return false
  // ...AND THE RAVINE HAS OVERHANGS (measured 09-20 05:30-06:30Z, after the sky rule: 95 `mine_reconnect` from the ravine floor in one hour, 1232 blocks dug through the
  // stairwell's wall at y48, 79 `recalled` of fill_ravine_s alone: at EVERY slice start a filler under an overhang tunnelled to the stairs, climbed to the mine head and
  // walked back down - ~35 s of each slice, and the stair audit re-walled the hole for the next one). A bot inside a `settings.keepOut` box, above that hole's floor
  // (`floor`, default base y - 30), is in the HOLE, not in the mine: it stays at its work, and A.travel knows the hole's exit.
  { const p = bot.entity.position; const by = (A.settings().base || {}).y || 68
    if ((A.settings().keepOut || []).some(k => k && Array.isArray(k.box) && k.box.length === 4 && p.x >= Math.min(k.box[0], k.box[2]) && p.x <= Math.max(k.box[0], k.box[2]) + 1 && p.z >= Math.min(k.box[1], k.box[3]) && p.z <= Math.max(k.box[1], k.box[3]) + 1 && p.y >= (Number.isFinite(k.floor) ? k.floor : by - 30) - 2)) return false }
  task(bot, label + ': up the mine stairs')
  for (const k of Object.keys(require.cache)) if (/\/skills\/iron_miner\.js$|\/skills\/lib\/iron_core\.js$/.test(k)) delete require.cache[k]
  try { const out = await U.withTimeout(require('../iron_miner.js')(bot, { job: 'surface', chain: false }, {}), Math.max(360000, 300000 + mine.steps.length * 4500), 'surface'); A.result(bot, { ev: 'recalled', job: label, out }) } catch (e) { bot.__ironGen = (bot.__ironGen || 0) + 1; A.result(bot, { ev: 'recall_failed', job: label, err: String(e && e.message || e).slice(0, 80) }) }
  try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { swallow('army_jobs:upTheStairs', e_) }
  A.strictMovements(bot)
  return true
}
async function canteen (bot, api) {
  if (bot.food > 12 && !(bot.health < 14 && bot.food < 18)) return 0
  if (Date.now() - (bot.__armyCanteenT || 0) < 90000) return 0
  const rawOk = bot.food <= 6 || bot.health <= 8 // badly hurt: raw fish is fine, regeneration needs food >= 18
  if (lib('feed').edibleCount(bot, rawOk) > 0) return 0 // eat what you carry first (worker does that every loop)
  const home = A.chestsOf('food')[0]
  // STARVING (food <= 6, nothing edible carried) beats every gate: 168 bread sat in stock while 4 miners stood at hp1/food0 (09-19) because the
  // canteen was "too far below". A starving bot walks to the food chest from anywhere within 250 blocks, any depth, and takes a real ration.
  const starving = bot.food <= 6
  if (!home || (!starving && (A.dist2(bot, home.x, home.z) > 90 || Math.abs(bot.entity.position.y - home.y) > 12)) || A.dist2(bot, home.x, home.z) > 250) return 0
  const names = foodStock(bot, rawOk)
  if (!names.length && bot.food <= 6 && A.stockOf('rotten_flesh') > 0) names.push('rotten_flesh') // what a starving player does: hunger effect beats 0 food
  if (!names.length) return 0
  bot.__armyCanteenT = Date.now()
  task(bot, starving ? 'canteen (starving)' : 'canteen')
  // UNDERGROUND near the mine: leave by the miner's own stairs - the same routine delegate() uses for a recall. A.travel from a cave ends in its
  // boxed-in escape = a new private tunnel under the base (foreman 09-19: diagonal bot-dug tunnels x -100..-40 / z -25..50). Only the surface leg is A.travel.
  if (starving && underground(bot)) {
    if (await upTheStairs(bot, 'canteen (starving)')) {
      task(bot, 'canteen (starving)')
      if (underground(bot)) { A.result(bot, { ev: 'canteen_unreached', food: bot.food, hp: Math.round(bot.health), why: 'underground, stairs not reached' }); return 0 }
    }
  }
  if (starving && (A.dist2(bot, home.x, home.z) > 24 || Math.abs(bot.entity.position.y - home.y) > 8)) { if (!await A.travel(bot, home, { range: 3, ms: 600000, stop: api.stop, anyDepth: true })) { A.result(bot, { ev: 'canteen_unreached', food: bot.food, hp: Math.round(bot.health) }); return 0 } }
  const got = await A.withdraw(bot, names[0], starving ? 8 : 3, { stop: api.stop, ms: 60000 })
  if (got) { try { await lib('feed').eat(bot, { rawOk: true }) } catch (e_) { swallow('army_jobs:51', e_) } A.result(bot, { ev: 'canteen', item: names[0], n: got }) }
  return got
}

// ------------------------------------------------------------------ muster: stand in formation at base, defend
function musterSlot (bot) {
  const m = setting(bot, 'muster')
  if (!m) return bot.entity.position.floored() // no muster point in this world yet: stand where you are
  const roster = A.settings().roster || []
  let i = roster.indexOf(bot.username); if (i < 0) i = 0
  const cols = m.cols || 6
  const step = m.step || 1
  return new Vec3(m.x + (i % cols) * step, m.y, m.z + Math.floor(i / cols) * step)
}
async function muster (bot, job, api, ctx, why) {
  // NOT IN THE OVERWORLD (see `overworld` above): the muster slot and the canteen are overworld coordinates. Stand still — walking
  // towards a base that is in another world is how a bot ends up entombed under the Nether roof.
  if (!overworld(bot)) {
    if (why && job && job.id && job.id !== 'muster') A.decline(bot, job, 240000, why)
    task(bot, 'waiting in ' + String((bot.game && bot.game.dimension) || '?') + ' for the way home')
    for (let i = 0; i < 20 && !api.stop(); i++) await sleep(1000)
    return 'not in the overworld: standing still until a job of this dimension (settings.nether.returnJob) takes me home'
  }
  const slot = musterSlot(bot)
  // parked by a real job? hand the bot back to the dispatcher (night reasons: until roughly dawn is re-checked every 3 min anyway)
  if (why && job && job.id && job.id !== 'muster' && job.type !== 'scan') { A.decline(bot, job, /hurt|not fit/.test(why) ? 120000 : 240000, why); if (!bot.__armyDeclSaid || bot.__armyDeclSaid !== job.id + why) { bot.__armyDeclSaid = job.id + why; A.result(bot, { ev: 'declined', job: job.id, why: String(why).slice(0, 80) }) } }
  await canteen(bot, api)
  task(bot, 'muster' + (why ? ' (' + why + ')' : ''))
  const low = Math.abs(bot.entity.position.y - slot.y) > 4 // under/over the slot is NOT at the slot (caves run below the base)
  if (low || A.dist2(bot, slot.x, slot.z) > 1.5) await A.travel(bot, { x: slot.x, y: slot.y, z: slot.z }, { range: 1, ms: 120000, stop: api.stop })
  const end = Date.now() + 20000
  while (Date.now() < end && !api.stop()) {
    // group defence: only close to the formation, only when healthy and armed
    const h = A.hostiles(bot, 10)[0]
    if (h && h.e.name !== 'creeper' && bot.health >= 10 && A.bestOf(bot, 'sword')) {
      await A.kill(bot, h.e, 12000, api.stop)
      await A.pickup(bot, 5, 3000)
      if (A.dist2(bot, slot.x, slot.z) > 1.5) await A.travel(bot, { x: slot.x, y: null, z: slot.z }, { range: 1, ms: 30000, stop: api.stop })
    }
    await sleep(1000)
  }
  return 'muster'
}

// ------------------------------------------------------------------ hunt: squad expedition to a known herd, bring meat + wool home
const PREY = new Set(['sheep', 'cow', 'pig', 'chicken', 'rabbit', 'mooshroom'])
// SHEARED? the sheep byte (colour | 0x10 = sheared) sits at metadata index 18 on 26.1 (probed 09-20: {"18":7}; a white unshorn sheep sends nothing); 17 was 1.20's index
const sheepSheared = e => !!(e && e.metadata && ((e.metadata[18] | 0) & 0x10))
// THE HERD IS NOT GAME (main 09-20: hunt_spawn is back for the 90 roaming pigs; `params.kinds` may be widened to cows/chickens again under this rule): never an animal
// inside or within 6 blocks of a herd job's pen box, never one a herder is leading (within 8 blocks of a player with a lure item in hand). opts.penned: the shear
// verb may look at penned sheep (shearing is not killing).
function preyNear (bot, r, kinds, opts = {}) {
  const me = bot.entity.position
  let pens = []; try { pens = opts.penned ? [] : A.ours().pens } catch (e_) { swallow('army_jobs:preyPens', e_) }
  const lures = new Set([].concat(...Object.values(HERD_LURE)))
  const leaders = opts.penned ? [] : Object.values(bot.entities).filter(p => p && p !== bot.entity && p.type === 'player' && p.position && lures.has(((p.heldItem || (p.equipment && p.equipment[0]) || {}).name) || ''))
  const kept = e => pens.some(q => e.position.x >= q.x1 - 6 && e.position.x <= q.x2 + 7 && e.position.z >= q.z1 - 6 && e.position.z <= q.z2 + 7) || leaders.some(p => p.position.distanceTo(e.position) < 8)
  return Object.values(bot.entities).filter(e => e && e.position && e.isValid !== false && (kinds ? kinds.includes(e.name) : PREY.has(e.name)) && e.position.distanceTo(me) <= r && !kept(e))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}
function haulCount (bot) {
  let n = 0
  for (const i of bot.inventory.items()) if (/^(mutton|beef|porkchop|chicken|rabbit|.*_wool|leather|feather|egg)$/.test(i.name)) n += i.count
  return n
}
// sightings are made from afar (the herd may stand across a lake): a 32-block cell where a trip failed (unreached / nothing killed) is not
// offered again for 6 h — ONE bot pays for the lesson, not fifteen (foreman 09-19: 15 trips, 0 kills, 3 rescue deaths at one shore)
const HUNT_BAD = () => require('path').join(A.DIR, 'hunt_bad.json')
const huntCell = at => Math.floor(at[0] / 32) + ',' + Math.floor(at[2] / 32)
function huntBad (at) { const b = A.readJSON(HUNT_BAD(), {}) || {}; const t = b[huntCell(at)]; return !!t && Date.now() - t < 6 * 3600000 }
function huntMark (at, bad) { const b = A.readJSON(HUNT_BAD(), {}) || {}; if (bad) b[huntCell(at)] = Date.now(); else delete b[huntCell(at)]; A.writeJSON(HUNT_BAD(), b) }
async function hunt (bot, job, api, ctx) {
  const P = job.params || {}
  // go where livestock was actually SEEN lately (bots record herds in animals.jsonl), nearest first; the board's site is only the fallback
  // no fixed site (a new world has none): the hunting ground is measured from settings.muster - each hunter takes its own bearing, 64-112 blocks out
  const base = A.musterPos(); const hIdx = Math.max(0, (A.settings().roster || []).indexOf(bot.username)); const hTrip = (bot.__armyHuntTrips = (bot.__armyHuntTrips || 0))
  const hc = base || bot.entity.position; const ha = (hIdx * 137 + hTrip * 45) * Math.PI / 180
  let far = !(Array.isArray(job.site) && job.site.every(Number.isFinite)) || (!!base && Math.hypot(job.site[0] - base.x, job.site[2] - base.z) < 48) // a job site AT the muster is no hunting ground (hunt_spawn: site = muster -> hunters "hunted" the yard)
  let site = Array.isArray(job.site) && job.site.every(Number.isFinite) ? v(job.site) : new Vec3(Math.round(hc.x + Math.sin(ha) * (64 + 16 * (hTrip % 4))), Math.round(hc.y), Math.round(hc.z - Math.cos(ha) * (64 + 16 * (hTrip % 4))))
  try {
    const rows = require('fs').readFileSync(require('path').join(A.DIR, 'animals.jsonl'), 'utf8').trim().split('\n').slice(-300).map(l => JSON.parse(l)).filter(r => Date.now() - r.t < 90 * 60000 && (!P.kinds || P.kinds.includes(r.kind)) && !underground(bot, r.at[1] - 3) && !huntBad(r.at) && (!base || Math.hypot(r.at[0] - base.x, r.at[2] - base.z) <= (P.maxDist || 170))) // a herd 230 blocks away is a scout's note, not a hunting ground (3 trips, 0 kills, no_route)
    // GO WHERE THE SURPLUS IS (foreman 09-19 20:05Z: 59 of 90 trips `kills:0 moved:{}` - "one of the 3 NEAREST sightings" sent 12 hunters to the hunted-out herds at the
    // base, x2-x3 head with leave:2 = nothing to take). Per 32-block cell and kind only the NEWEST sighting counts (x6 an hour ago, x2 now = x2); a herd is a target
    // when it has more than `leave` head; score = surplus head minus 1 per 80 blocks; the squad spreads over the 6 best by roster index. No herd with a surplus
    // anywhere -> no sighting is used: the hunter takes its own bearing further out (below) and finds new herds (every bot records what it sees).
    if (rows.length && !(bot.__armyHunt && bot.__armyHunt.job === job.id && bot.__armyHunt.site)) {
      const me = bot.entity.position; const leave = P.leave == null ? 2 : P.leave; const newest = {}
      for (const r of rows) { const k = r.kind + ':' + huntCell(r.at); if (!newest[k] || newest[k].t < r.t) newest[k] = r }
      const score = r => (r.n - leave) - Math.hypot(r.at[0] - me.x, r.at[2] - me.z) / 80
      const cands = Object.values(newest).filter(r => (r.n || 0) > leave).sort((a, b) => score(b) - score(a)).slice(0, 6)
      if (cands.length) { site = v(cands[(hIdx + hTrip) % cands.length].at); far = false }
    }
  } catch (e_) { swallow('army_jobs:huntSites', e_) }
  // every known herd is hunted down to `leave`: range further on the hunter's own bearing (112-208 blocks from muster, within params.maxDist) - new land, new herds
  if (far) { const rr = Math.min(P.maxDist || 170, 112 + 32 * (hTrip % 4)); site = new Vec3(Math.round(hc.x + Math.sin(ha) * rr), Math.round(hc.y), Math.round(hc.z - Math.cos(ha) * rr)) }
  if (bot.__armyHunt && bot.__armyHunt.job === job.id && bot.__armyHunt.site) site = v(bot.__armyHunt.site)
  const st = bot.__armyHunt = (bot.__armyHunt && bot.__armyHunt.job === job.id) ? bot.__armyHunt : { job: job.id, phase: 'out', kills: 0, site: [site.x, site.y, site.z] }
  // daylight arithmetic instead of fixed clock times: walking ~3 blocks/s, the trip must fit into what is left of the day
  const dusk = A.settings().dusk || 11800
  const secLeft = () => A.settings().nightSkip ? 1e9 : (dusk - api.time()) / 20
  const legS = () => A.dist2(bot, site.x, site.z) / 3 + 45
  const tooLate = () => isNight(api) || secLeft() < legS()
  if (st.phase === 'out') {
    const tripS = legS() * 2 + 90
    if (isNight(api) || secLeft() < tripS) return muster(bot, job, api, ctx, 'hunt: not enough daylight (trip ' + Math.round(tripS) + ' s, left ' + Math.max(0, Math.round(secLeft())) + ' s)')
    if (!A.bestOf(bot, 'sword') && !A.bestOf(bot, 'axe')) { await A.withdraw(bot, 'stone_sword', 1, { stop: api.stop }) }
    task(bot, 'hunt:out ' + job.id)
    const ok = await A.travel(bot, site, { range: 12, ms: 420000, stop: () => api.stop() || tooLate(), via: P.via })
    if (api.stop()) return 'stopped'
    if (!ok) A.result(bot, { ev: 'hunt_unreached', job: job.id, site: [site.x, site.y, site.z], d: Math.round(A.dist2(bot, site.x, site.z)) })
    if (!ok) huntMark([site.x, site.y, site.z], true)
    st.phase = ok ? 'work' : 'home'
  }
  if (st.phase === 'work') {
    task(bot, 'hunt:work ' + job.id)
    let dry = 0
    while (!api.stop() && !tooLate() && haulCount(bot) < (P.haul || 24) && dry < 6) {
      const list = preyNear(bot, 40, P.kinds)
      const byKind = {}
      for (const e of list) (byKind[e.name] = byKind[e.name] || []).push(e)
      const target = list.find(e => byKind[e.name].length > (P.leave == null ? 2 : P.leave))
      if (!target) {
        dry++
        // sweep around the site to find the herd again
        const a = dry * 1.3
        await A.travel(bot, { x: site.x + Math.cos(a) * 24, y: null, z: site.z + Math.sin(a) * 24 }, { range: 4, ms: 40000, stop: () => api.stop() || tooLate() })
        continue
      }
      dry = 0
      const h0 = haulCount(bot)
      if (await A.kill(bot, target, 25000, api.stop)) { st.kills++; await sleep(400) }
      await A.pickup(bot, 7, 5000) // also after a "failed" kill: the animal often dies to the last blow of a squad mate or after the 25 s (trips said kills:0 and brought 3 porkchop)
      st.haul = (st.haul || 0) + Math.max(0, haulCount(bot) - h0)
      // A HUNTER EATS FROM ITS OWN CATCH (raw is fine until furnaces stand - foreman 09-19: hunters starved at food 12 with mutton in the pockets, and lost it when they died)
      if (bot.food < 18) try { await lib('feed').eat(bot, { rawOk: !A.furnaces().length || bot.food <= 12 }) } catch (e_) { swallow('army_jobs:huntEat', e_) }
    }
    if (!api.stop()) huntMark(st.site, st.kills === 0 && !st.haul)
    st.phase = 'home'
  }
  if (st.phase === 'home') {
    task(bot, 'hunt:home ' + job.id)
    const home = A.chestsOf('food')[0] || musterSlot(bot)
    const ok = await A.travel(bot, home, { range: 4, ms: 420000, stop: api.stop, via: (P.via || []).slice().reverse() })
    if (!ok) return 'hunt: not home yet'
    const carried = haulCount(bot)
    const moved = await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop })
    // the TRUE trip report: kills seen by this hunter, haul = meat/wool/leather that came home in its pockets, banked = what the chests took of it, left = still carried (chest full / unreachable)
    const banked = Object.entries(moved || {}).filter(([k]) => /^(mutton|beef|porkchop|chicken|rabbit|.*_wool|leather|feather|egg)$/.test(k)).reduce((n, [, q]) => n + q, 0)
    A.result(bot, { ev: 'trip', job: job.id, kills: st.kills, haul: carried, banked, left: haulCount(bot), site: st.site, moved })
    bot.__armyHunt = null; bot.__armyHuntTrips = (bot.__armyHuntTrips || 0) + 1
    return 'hunt trip done'
  }
  return 'hunt'
}

// ------------------------------------------------------------------ herd: bring livestock INTO a pen (lured with food, never pushed or hit) and breed it there
// params {pen:[x1,z1,x2,z2] = the fence ring, gate:[x,y,z] = the fence gate ON the ring, kind:'sheep'|'cow'|'pig'|'chicken', want:10, radius:250, budget:24, keepStock:64}
// One slice of a good player's routine, everything judged on the WORLD: ring closed? -> count the kind inside (standing at the gate) -> below `want`: take the lure item,
// walk to the nearest animal outside (in view, else the newest sightings of animals.jsonl, else an own bearing out to `radius`), hold the lure, walk home at the HERD's
// pace (stop when the nearest follower lags > 6.5, step back when it lost interest), open the gate, in, to the far end, lure away, out, gate shut, count again ->
// `herded {n, inPen}`. >= 2 adults inside: feed pairs (a feed counts when the stack shrank or hearts rose), wait for the babies -> `bred {fed, pairs, babies}`.
// Nothing to lure and nothing to breed -> the bot is handed back for 10 min with the reason. 26.1 probe (09-19): entity names sheep/cow/pig/chicken, metadata[16] = baby.
// Squad without messages: an animal that has a team-mate with the lure in hand within 7 blocks is THAT bot's; the gate reflex (army.js gateCloser) is held off with its
// own busy flag while a herd walks through the gate behind the bot - the handler shuts the gate itself and reads the block state back.
const HERD_LURE = { sheep: ['wheat'], cow: ['wheat'], mooshroom: ['wheat'], pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'] }
const HERD_KEEP = 64
// hunt_bad.json also holds cells where a hunter merely killed nothing (6 h): a herder believes such a mark for 45 min only (09-19: every cow herd was 'bad', 3.5 h old)
const herdBad = at => { const t = (A.readJSON(HUNT_BAD(), {}) || {})[huntCell(at)]; return !!t && Date.now() - t < 45 * 60000 }
// the squad's shared memory of the last breeding visit is the report itself (no state file): newest `bred` line of this job in the tail of results.jsonl
function herdLastBred (jobId) {
  try {
    const fs = require('fs'); const f = require('path').join(A.DIR, 'results.jsonl'); const size = fs.statSync(f).size; const len = Math.min(size, 262144); const buf = Buffer.alloc(len)
    const fd = fs.openSync(f, 'r'); try { fs.readSync(fd, buf, 0, len, size - len) } finally { fs.closeSync(fd) }
    const l = buf.toString('utf8').split('\n').filter(x => x.includes('"ev":"bred"') && x.includes('"job":"' + jobId + '"')).pop()
    return l ? JSON.parse(l).t || 0 : 0
  } catch (e_) { swallow('army_jobs:herdLastBred', e_); return 0 }
}
const herdBaby = e => !!(e.metadata && e.metadata[16] === true)
function herdGeo (P) {
  const x1 = Math.min(P.pen[0], P.pen[2]); const z1 = Math.min(P.pen[1], P.pen[3]); const x2 = Math.max(P.pen[0], P.pen[2]); const z2 = Math.max(P.pen[1], P.pen[3])
  const [gx, gy, gz] = P.gate
  const inn = gx === x2 ? [-1, 0] : gx === x1 ? [1, 0] : gz === z2 ? [0, -1] : gz === z1 ? [0, 1] : null
  if (!inn || gx < x1 || gx > x2 || gz < z1 || gz > z2) return null
  const len = inn[0] ? x2 - x1 : z2 - z1
  const at = k => new Vec3(gx + inn[0] * k, gy, gz + inn[1] * k)
  // fence posts stand in the MIDDLE of their block: inside = beyond the centre line of the ring blocks
  return { x1, z1, x2, z2, gate: new Vec3(gx, gy, gz), out: at(-2), inside: at(2), far: at(Math.max(4, len - 3)), has: p => p.x > x1 + 0.5 && p.x < x2 + 0.5 && p.z > z1 + 0.5 && p.z < z2 + 0.5 && Math.abs(p.y - gy) < 4 }
}
function herdCount (bot, G, kind) {
  const l = Object.values(bot.entities).filter(e => e && e.position && e.isValid !== false && e.name === kind && G.has(e.position))
  const babies = l.filter(herdBaby)
  return { n: l.length, adults: l.filter(e => !herdBaby(e)), babies }
}
function herdRing (bot, G) { // cells of the ring that are neither fence, gate nor wall (an unloaded cell is not a gap)
  const gaps = []
  for (let x = G.x1; x <= G.x2; x++) for (let z = G.z1; z <= G.z2; z++) {
    if (x !== G.x1 && x !== G.x2 && z !== G.z1 && z !== G.z2) continue
    const b = bot.blockAt(new Vec3(x, G.gate.y, z)); if (b && !/fence|_wall$/.test(b.name)) gaps.push([x, G.gate.y, z].join(','))
  }
  return gaps
}
function herdGateOpen (bot, G) { const b = bot.blockAt(G.gate); if (!b || !/fence_gate$/.test(b.name)) return null; try { return String(b.getProperties().open) === 'true' } catch (e_) { swallow('army_jobs:herdGateProps', e_); return null } }
async function herdGate (bot, G, open) { // click the gate until the SERVER's block state says what we want
  // two herders at one gate: both read 'open', both click, the gate is open again (09-19 Mio/Chika) -> re-read after a random pause, up to 5 rounds
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(Math.floor(Math.random() * 700))
    const s = herdGateOpen(bot, G); if (s == null) return false; if (s === open) return true
    if (bot.entity.position.distanceTo(G.gate.offset(0.5, 0, 0.5)) > 4.5) return false
    try { await bot.lookAt(G.gate.offset(0.5, 0.5, 0.5), true); await U.withTimeout(bot.activateBlock(bot.blockAt(G.gate)), 2500, 'herdGate') } catch (e_) { swallow('army_jobs:herdGate', e_) }
    await sleep(500)
  }
  return herdGateOpen(bot, G) === open
}
async function herdHold (bot, names) {
  if (bot.heldItem && names.includes(bot.heldItem.name)) return true
  const it = bot.inventory.items().find(i => names.includes(i.name)); if (!it) return false
  try { await U.withTimeout(bot.equip(it, 'hand'), 3000, 'herdEquip') } catch (e_) { swallow('army_jobs:herdEquip', e_) }
  return !!(bot.heldItem && names.includes(bot.heldItem.name))
}
async function herdHide (bot, names) { // the lure OUT of the hand: whoever walks out of the pen with wheat in hand takes the herd along
  if (!(bot.heldItem && names.includes(bot.heldItem.name))) return true
  const all = [].concat(...Object.values(HERD_LURE)); const other = bot.inventory.items().find(i => !all.includes(i.name))
  try { if (other) await U.withTimeout(bot.equip(other, 'hand'), 3000, 'herdHide'); else await U.withTimeout(bot.unequip('hand'), 3000, 'herdHide') } catch (e_) { swallow('army_jobs:herdHide', e_) }
  return !(bot.heldItem && names.includes(bot.heldItem.name))
}
// walk to `target` at the pace of the herd. followers(r) = the animals that set the pace (nearest first). -> 'ok' | 'lost' | 'stuck' | 'stop'
async function herdLead (bot, target, range, names, followers, stop, o = {}) {
  const end = Date.now() + (o.ms || 600000); let noRoute = 0
  const near = () => { const f = followers(24)[0]; return f ? f.position.distanceTo(bot.entity.position) : Infinity }
  while (!stop() && Date.now() < end) {
    await herdHold(bot, names)
    // wait for the herd (<= 8 s); an animal that lost interest is fetched again - never back out through the gate (o.noBack): the penned ones would follow
    const t1 = Date.now() + 8000
    while (Date.now() < t1 && near() > 3.5 && near() < Infinity && !stop()) { const f = followers(24)[0]; try { if (f) await bot.lookAt(f.position.offset(0, 0.6, 0), false) } catch (e_) { swallow('army_jobs:herdLook', e_) } await sleep(300) }
    if (near() > 6.5) {
      const f = followers(24)[0]
      if (!f || o.noBack) { if (o.noBack) followers = () => []; else return 'lost' } else { await A.travel(bot, f.position, { range: 3, ms: 20000, stop, quiet: true }); await sleep(800); if (near() > 9) return 'lost'; continue }
    }
    let lag = false; let busy = false
    const tm = setInterval(() => {
      try {
        if (o.holdGate) { bot.__armyGateBusy = true; bot.__armyGate = null }
        if (!lag && near() > 6.5 && near() < Infinity) { lag = true; bot.pathfinder.setGoal(null) }
        if (!busy && !bot.__armyEating && !(bot.heldItem && names.includes(bot.heldItem.name))) { busy = true; herdHold(bot, names).catch(e_ => swallow('army_jobs:herdRehold', e_)).finally(() => { busy = false }) }
      } catch (e_) { swallow('army_jobs:herdPace', e_) }
    }, 400)
    let ok = false
    try { ok = await A.travel(bot, target, { range, ms: Math.min(120000, Math.max(5000, end - Date.now())), stop: () => stop() || lag, quiet: true }) } finally { clearInterval(tm) }
    if (ok) return 'ok'
    if (stop()) return 'stop'
    if (!lag && ++noRoute >= 3) return 'stuck'
  }
  return stop() ? 'stop' : 'stuck'
}
// out of the pen and the gate SHUT behind us (runs to its end even when the slice is over: an open gate empties the pen)
async function herdLeave (bot, G, kind, names) {
  if (!bot.entity) return false
  await herdHide(bot, names)
  const dead = () => bot.__armyDied || !bot.entity || bot.health <= 0
  if (G.has(bot.entity.position)) {
    await A.travel(bot, G.inside, { range: 1, ms: 40000, stop: dead, quiet: true })
    const t1 = Date.now() + 8000 // nobody slips out with me
    while (Date.now() < t1 && !dead() && Object.values(bot.entities).some(e => e && e.position && e.name === kind && e.position.distanceTo(G.gate.offset(0.5, 0, 0.5)) < 2.5)) await sleep(400)
    await herdGate(bot, G, true)
    bot.__armyGateBusy = true
    try { await A.travel(bot, G.out, { range: 1, ms: 40000, stop: dead, quiet: true }) } finally { bot.__armyGateBusy = false }
  }
  if (bot.entity.position.distanceTo(G.gate.offset(0.5, 0, 0.5)) > 4.3) await A.travel(bot, G.out, { range: 1, ms: 30000, stop: dead, quiet: true })
  return herdGate(bot, G, false)
}
async function herd (bot, job, api, ctx) {
  const P = job.params || {}; const kind = P.kind; const names = HERD_LURE[kind]
  const G = names && Array.isArray(P.pen) && P.pen.length === 4 && Array.isArray(P.gate) && P.gate.length === 3 ? herdGeo(P) : null
  if (!G) return muster(bot, job, api, ctx, 'herd: params need kind (sheep|cow|pig|chicken), pen [x1,z1,x2,z2] and a gate [x,y,z] ON the ring')
  const want = P.want || 10; const radius = P.radius || 250; const keep = P.keepStock == null ? HERD_KEEP : P.keepStock
  // THE STANDING FLOCK (foreman 09-20 02:26Z: pen 1 culled 111 -> 10 for mutton nobody needs): wool regrows, a dead sheep gives 1 - sheep keep 24 adults, the others `want`
  const flock = P.keep || (kind === 'sheep' ? Math.max(24, want) : want)
  const st = bot.__armyHerd = (bot.__armyHerd && bot.__armyHerd.job === job.id) ? bot.__armyHerd : { job: job.id, trips: 0, dry: {}, cool: {}, lastBreed: 0, said: {}, leading: false }
  const have = () => bot.inventory.items().filter(i => names.includes(i.name)).reduce((n, i) => n + i.count, 0)
  // identical reports at most every 10 min per bot (digits do not make a report new)
  const say = (rec, ms) => { const k = rec.ev + ':' + String(rec.why || '').replace(/\d+/g, '#'); if (Date.now() - (st.said[k] || 0) < (ms == null ? 600000 : ms)) return; st.said[k] = Date.now(); A.result(bot, Object.assign({ job: job.id, kind }, rec)) }
  // handed back for 10 min; the dispatcher needs a few seconds to see the decline - wait for the new assignment instead of re-running the slice twice a second
  // NOTHING TO DO IS A FACT ABOUT THE JOB, NOT ABOUT THE BOT (foreman 09-20 00:20Z: `declined herd_cows "no cow to lure… breeding on cooldown"` x29 by 26 bots in a
  // minute - the dispatcher handed the 3-bot job to the next bot as each one declined, every decline a 250-block entity scan): the JOB rests for 5 min on
  // the board (`restUntil`, honoured by the dispatcher) and only then is anybody sent again.
  // (09-20 05:42Z: 87 sheep stood outside pen 1, four herders at the gate - every sheep within 48 was "a team-mate's", the job RESTED with "no sheep to lure": while
  //  animals of the kind stand outside within 100 blocks the job never rests; the bot steps aside for a minute and the lure looks 100 blocks out)
  const back = async why => { const more = !!(c0 && c0.n < want && wild(100).length); if (/to lure within|nobody ready to breed/.test(String(why)) && !more) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j) j.restUntil = Date.now() + 300000 }); A.decline(bot, job, more ? 60000 : 600000, why); say({ ev: 'declined', why: String(why).slice(0, 80) }); task(bot, 'herd: handed back (' + why + ')'); const t1 = Date.now() + 20000; while (Date.now() < t1 && !api.stop()) await sleep(500); return 'herd: ' + why }
  const me = () => bot.entity.position
  const lured = e => Object.values(bot.entities).some(p => p && p !== bot.entity && p.type === 'player' && p.position && p.position.distanceTo(e.position) < 7 && names.includes(((p.heldItem || (p.equipment && p.equipment[0]) || {}).name) || ''))
  const rival = e => Object.values(bot.entities).some(p => p && p !== bot.entity && p.type === 'player' && p.position && p.position.distanceTo(e.position) < 7 && p.position.distanceTo(e.position) < me().distanceTo(e.position) && names.includes(((p.heldItem || (p.equipment && p.equipment[0]) || {}).name) || ''))
  const kindAll = (r, from) => Object.values(bot.entities).filter(e => e && e.position && e.isValid !== false && e.name === kind && e.position.distanceTo(from || me()) <= r).sort((a, b) => a.position.distanceTo(me()) - b.position.distanceTo(me()))
  const wild = (r, from) => kindAll(r, from).filter(e => !G.has(e.position) && Math.hypot(e.position.x - G.gate.x, e.position.z - G.gate.z) <= radius + 32 && !underground(bot, e.position.y))
  const free = r => wild(r).filter(e => !lured(e))
  let c0 = null
  if (!(st.leading && have() > 0 && wild(10).length)) {
    st.leading = false
    // 1. the lure item: pockets, else the depot - but never its last `keepStock` (seed for the fields, wheat for bread)
    if (have() < 4) {
      for (const n of names) {
        const spare = A.stockOf(n) - keep; if (spare < 4) continue
        task(bot, 'herd: fetching ' + n); await A.withdraw(bot, n, Math.min(P.budget || 24, spare), { stop: api.stop })
        if (have() >= 4 || api.stop()) break
      }
    }
    if (api.stop()) return 'stopped'
    if (!have()) return back('no lure item for ' + kind + ' (' + names.slice(0, 3).join('/') + ') beyond the depot reserve of ' + keep)
    // 2. at the gate: is the ring closed, is the gate shut, how many are inside?
    task(bot, 'herd: to the pen ' + job.id)
    await herdHide(bot, names)
    if (!await A.travel(bot, G.out, { range: 1, ms: 420000, stop: api.stop })) return api.stop() ? 'stopped' : back('cannot reach the pen gate')
    const gs = herdGateOpen(bot, G); if (gs == null) return back('no fence gate at params.gate ' + P.gate.join(','))
    const gaps = herdRing(bot, G)
    if (gaps.length) { say({ ev: 'pen_open', n: gaps.length, gaps: gaps.slice(0, 6), why: 'ring' }); return back('the pen ring has ' + gaps.length + ' gaps (first ' + gaps[0] + '): re-activate its build job') }
    if (gs && !await herdGate(bot, G, false)) say({ ev: 'pen_open', why: 'gate stands open and does not shut', at: P.gate })
    c0 = herdCount(bot, G, kind)
  }
  // 3. LURE: below `want` (or animals already walk behind me)
  let brought = null
  if (st.leading || c0.n < want) {
    let t = st.leading ? wild(10)[0] : (free(48)[0] || free(100)[0])
    const seek = async (at, label) => { // walk towards a place, stop as soon as an animal nobody leads comes into view
      task(bot, 'herd: ' + label); let seen = null
      const ok = await A.travel(bot, at, { range: 10, ms: 420000, quiet: true, stop: () => api.stop() || !!(seen = free(40)[0]) })
      return { t: seen || free(48)[0] || null, ok }
    }
    if (!t) {
      let rows = []
      try {
        rows = require('fs').readFileSync(require('path').join(A.DIR, 'animals.jsonl'), 'utf8').trim().split('\n').slice(-400).map(l => { try { return JSON.parse(l) } catch (e_) { return null } })
          .filter(r => r && r.kind === kind && Array.isArray(r.at) && Date.now() - r.t < 120 * 60000 && Math.hypot(r.at[0] - G.gate.x, r.at[2] - G.gate.z) <= radius && !G.has({ x: r.at[0] + 0.5, y: G.gate.y, z: r.at[2] + 0.5 }) && !underground(bot, r.at[1] - 3) && !herdBad(r.at) && !(Date.now() - (st.dry[huntCell(r.at)] || 0) < 1800000))
      } catch (e_) { swallow('army_jobs:herdSightings', e_) }
      const newest = {}; for (const r of rows) { const k = huntCell(r.at); if (!newest[k] || newest[k].t < r.t) newest[k] = r }
      // newest first, a minute of age = 2 blocks of distance; the squad spreads over the 3 best by roster index
      const score = r => Math.hypot(r.at[0] - me().x, r.at[2] - me().z) + (Date.now() - r.t) / 30000
      const cands = Object.values(newest).sort((a, b) => score(a) - score(b)).slice(0, 3)
      const idx = Math.max(0, (A.settings().roster || []).indexOf(bot.username))
      for (let i = 0; i < Math.min(2, cands.length) && !t && !api.stop(); i++) {
        const s = cands[(idx + st.trips + i) % cands.length]
        const r = await seek(new Vec3(s.at[0], s.at[1], s.at[2]), 'to the ' + kind + ' seen at ' + s.at[0] + ',' + s.at[2]); t = r.t
        if (!t && !api.stop()) { st.dry[huntCell(s.at)] = Date.now(); if (!r.ok) { huntMark(s.at, true); say({ ev: 'herd_unreached', why: 'sighting', at: s.at, d: Math.round(A.dist2(bot, s.at[0], s.at[2])) }, 60000) } }
      }
      if (!t && !cands.length && !api.stop()) { // no sighting on record: look around on an own bearing, 96-250 blocks out from the gate
        const a = (idx * 137 + st.trips * 45) * Math.PI / 180; const rr = Math.min(radius, 96 + 48 * (st.trips % 4))
        t = (await seek(new Vec3(Math.round(G.gate.x + Math.sin(a) * rr), G.gate.y, Math.round(G.gate.z - Math.cos(a) * rr)), 'looking for ' + kind + ' ' + rr + ' blocks out')).t
      }
      if (api.stop()) return 'stopped'
      if (!t) st.trips++
    }
    if (t) {
      // gather: up to the animal (it walks: re-aim), lure in hand, then its neighbours one by one - an animal follows within 10 blocks of the lure
      const t0 = Date.now(); const from = [Math.round(t.position.x), Math.round(t.position.y), Math.round(t.position.z)]
      task(bot, 'herd: luring ' + kind + ' at ' + from[0] + ',' + from[2]); st.leading = true
      for (let i = 0; i < 4 && !api.stop() && t.isValid !== false && t.position.distanceTo(me()) > 5; i++) await A.travel(bot, t.position, { range: 4, ms: 45000, stop: api.stop, quiet: true })
      if (t.isValid === false || lured(t)) { const o = free(32)[0]; if (o) { t = o; await A.travel(bot, t.position, { range: 4, ms: 45000, stop: api.stop, quiet: true }) } }
      await herdHold(bot, names); await sleep(1500)
      if (t.isValid !== false && rival(t)) { const o = free(48)[0]; if (o) { t = o; await A.travel(bot, t.position, { range: 4, ms: 45000, stop: api.stop, quiet: true }); await herdHold(bot, names); await sleep(1500) } else await herdHide(bot, names) }
      for (let i = 0; i < 4 && !api.stop(); i++) { const o = free(24).find(e => e.position.distanceTo(me()) > 7); if (!o) break; await A.travel(bot, o.position, { range: 4, ms: 25000, stop: api.stop, quiet: true }); await herdHold(bot, names); await sleep(1200) }
      const n0 = bot.heldItem && names.includes(bot.heldItem.name) ? wild(10).length : 0
      let r = n0 ? await herdLead(bot, G.out, 1, names, rr => wild(rr), api.stop) : 'lost'
      if (r === 'stop') return 'herd: slice over with ' + wild(10).length + ' ' + kind + ' in tow'
      st.leading = false; st.trips++
      if (r !== 'ok' && !n0 && t.isValid !== false && rival(t)) { await herdHide(bot, names); return 'herd: a team-mate leads that ' + kind + ' - looking elsewhere' }
      if (r !== 'ok') { st.lost = (st.lost || 0) + 1; say({ ev: 'herd_lost', why: r === 'lost' ? (n0 ? 'the followers lost interest on the way' : 'the animal did not follow the lure') : 'no walkable way home with the herd', from, at: [Math.round(me().x), Math.round(me().y), Math.round(me().z)], held: (bot.heldItem || {}).name || null }, 120000); await herdHide(bot, names); if (st.lost >= 3) { st.lost = 0; return back(kind + ' do not come along (3 tries) - see herd_lost') } return 'herd: lost the ' + kind + ' on the way (try ' + st.lost + ')' } else {
        // through the gate: open it, 3 blocks in and let them come, then the far end, lure away, out, gate shut - and a real count
        st.lost = 0; const before = herdCount(bot, G, kind).n; const tow = wild(10).length
        const dead = () => bot.__armyDied || !bot.entity || bot.health <= 0
        try {
          await herdGate(bot, G, true); bot.__armyGateBusy = true
          r = await herdLead(bot, G.inside, 1, names, rr => wild(rr), dead, { ms: 90000, holdGate: true, noBack: true })
          const t1 = Date.now() + 15000
          while (Date.now() < t1 && !dead() && wild(10).length) { bot.__armyGateBusy = true; await herdHold(bot, names); await sleep(400) }
          await herdLead(bot, G.far, 2, names, rr => kindAll(rr), dead, { ms: 90000, holdGate: true, noBack: true })
        } catch (e_) { swallow('army_jobs:herdDeliver', e_) } finally { bot.__armyGateBusy = false }
        const shut = await herdLeave(bot, G, kind, names)
        const c = herdCount(bot, G, kind); brought = c.n - before
        A.result(bot, { ev: 'herded', job: job.id, kind, n: Math.max(0, brought), inPen: c.n, adults: c.adults.length, babies: c.babies.length, tow, from, gateShut: shut, s: Math.round((Date.now() - t0) / 1000) })
        if (!shut) say({ ev: 'pen_open', why: 'gate did not shut behind the herd', at: P.gate }, 60000)
        c0 = c
      }
    }
  }
  if (api.stop()) return 'stopped'
  if (!c0) c0 = herdCount(bot, G, kind)
  // 4. BREED: >= 2 adults inside, every 5.5 min (the love cooldown is 5 min and invisible to a client: a refused feed is how we learn it)
  let bredNow = null
  // one visit per pen every 5.5 min for the whole squad (09-19: five herders walked in within 3 min, all refused); two newcomers may pair at once
  // BREEDING HAS A CEILING (main 09-20 02:0xZ: 111 sheep in a 27x13 pen at want 10 = server lag and entity cramming): adults + babies < params.max (default = want).
  // A pen that shall PRODUCE (leather, beef) gets max = 2 x want: bred up to max, the grown surplus is culled back to `want` adults.
  if (c0.adults.length >= 2 && c0.n < (P.max || flock) && have() >= 2 && Date.now() - st.lastBreed > 330000 && (brought >= 2 || Date.now() - herdLastBred(job.id) > 330000)) {
    task(bot, 'herd: breeding ' + kind + ' in ' + job.id)
    if (!await A.travel(bot, G.out, { range: 1, ms: 120000, stop: api.stop })) return api.stop() ? 'stopped' : back('cannot reach the pen gate')
    const hearts = new Set(); const onStatus = p => { if (p && p.entityStatus === 18) hearts.add(p.entityId) }
    let fed = 0; let refused = 0; const b0 = c0.babies.length; const lure0 = have()
    try {
      bot._client.on('entity_status', onStatus)
      await herdGate(bot, G, true)
      if (await A.travel(bot, G.inside, { range: 1, ms: 40000, stop: api.stop, quiet: true })) {
        await herdGate(bot, G, false)
        st.lastBreed = Date.now(); const tried = new Set(); const budget = Math.min(P.budget || 24, have())
        while (!api.stop() && fed < budget && have() > 0) {
          const a = herdCount(bot, G, kind).adults.filter(e => !tried.has(e.id) && !(st.cool[e.id] > Date.now())).sort((p, q) => p.position.distanceTo(me()) - q.position.distanceTo(me()))[0]
          if (!a) break
          tried.add(a.id); await herdHold(bot, names)
          if (a.position.distanceTo(me()) > 2.8) await A.travel(bot, a.position, { range: 2, ms: 15000, stop: api.stop, quiet: true })
          if (a.isValid === false || a.position.distanceTo(me()) > 3.5 || !await herdHold(bot, names)) continue
          const n0 = have(); hearts.delete(a.id) // hearts a team-mate's feed raised are not mine
          try { await bot.lookAt(a.position.offset(0, (a.height || 1) * 0.6, 0), true); await U.withTimeout(Promise.resolve(bot.activateEntity(a)), 2500, 'herdFeed') } catch (e_) { swallow('army_jobs:herdFeed', e_) }
          await sleep(600)
          if (have() < n0 || hearts.has(a.id)) { fed++; st.cool[a.id] = Date.now() + 330000 } else { refused++; st.cool[a.id] = Date.now() + 120000 }
        }
        // the babies are the proof: wait up to 20 s for the count of babies to rise
        const t1 = Date.now() + 20000
        while (fed >= 2 && Date.now() < t1 && !api.stop() && herdCount(bot, G, kind).babies.length < b0 + Math.floor(fed / 2)) await sleep(1000)
      }
    } catch (e_) { swallow('army_jobs:herdBreed', e_) } finally { try { bot._client.removeListener('entity_status', onStatus) } catch (e_) { swallow('army_jobs:herdUnlisten', e_) } }
    const shut = await herdLeave(bot, G, kind, names)
    const c = herdCount(bot, G, kind); bredNow = { fed, babies: Math.max(0, c.babies.length - b0) }
    for (const k of Object.keys(st.cool)) if (st.cool[k] < Date.now()) delete st.cool[k]
    if (fed) A.result(bot, { ev: 'bred', job: job.id, kind, pairs: Math.floor(fed / 2), fed, used: Math.max(0, lure0 - have()), refused, hearts: hearts.size, babies: bredNow.babies, inPen: c.n, gateShut: shut })
    else say({ ev: 'bred', why: refused ? 'all refused (love cooldown)' : 'could not get to the animals', pairs: 0, fed: 0, refused, inPen: c.n, gateShut: shut })
    if (!shut) say({ ev: 'pen_open', why: 'gate did not shut after breeding', at: P.gate }, 60000)
    c0 = c
  }
  // 5. WOOL + LEATHER (the pen is an engine, not a dead end - foreman 09-20 00:55Z: 37 cows at want 10, leather 15 in the depot): ONE visit inside the shut pen
  //    SHEARS every adult sheep that carries wool (`params.shear:false` = off) and CULLS the adults beyond `want` (`params.cull:false` = off) - never a baby,
  //    never below `want`, recounted before every kill; one herder per pen at a time (claim in asset_audit.json, 3 min). Drops are picked up and banked.
  let worked = null
  {
    const woolly = () => kind === 'sheep' && P.shear !== false ? herdCount(bot, G, kind).adults.filter(e => !sheepSheared(e)) : []
    const surplus = () => P.cull === false ? 0 : Math.max(0, herdCount(bot, G, kind).adults.length - flock)
    const shearsOk = A.count(bot, 'shears') > 0 || A.stockOf('shears') > 0
    const wl = shearsOk ? woolly().length : 0
    const AF = require('path').join(A.DIR, 'asset_audit.json'); const ck = job.id + ':visit'
    const claim = () => { const au = A.readJSON(AF, {}) || {}; const c = au[ck]; if (c && c.by !== bot.username && Date.now() - c.t < 180000) return false; au[ck] = { by: bot.username, t: Date.now() }; A.writeJSON(AF, au); return true }
    const unclaim = () => { try { const au = A.readJSON(AF, {}) || {}; if (au[ck] && au[ck].by === bot.username) { delete au[ck]; A.writeJSON(AF, au) } } catch (e_) { swallow('army_jobs:herdUnclaim', e_) } }
    // PEN LITTER (owner 09-20 05:00Z: 76 sheep outside, 7 inside - 11 cobbled_deepslate step blocks of an escape routine lay on the pen floor and one on the fence; an
    // animal on a block beside the fence hops over it): any full block inside the ring from the fence level up (or on top of the ring) that no blueprint of ours
    // put there is dug and carried out by the herder on the same visit. The pen is the herder's: nobody else enters it.
    const litter = () => {
      const out = []
      for (let x = G.x1; x <= G.x2; x++) for (let z = G.z1; z <= G.z2; z++) {
        const ring = x === G.x1 || x === G.x2 || z === G.z1 || z === G.z2
        for (let y = G.gate.y + (ring ? 1 : 0); y <= G.gate.y + 3; y++) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.boundingBox === 'block' && !/_leaves$|_log$|fence|_wall$/.test(b.name) && !U.protectedBlock(b) && !A.ourBlock(b.position, b.name)) out.push(b.position.clone()) }
      }
      return out
    }
    const lit0 = litter().length
    const due = (surplus() > 0 || lit0 > 0 || wl >= Math.min(3, Math.max(1, c0.adults.length))) && !api.stop() && bot.health >= 12
    if (due && !claim()) worked = { mate: true }
    else if (due) {
      const t0 = Date.now(); let sheared = 0; let culled = 0; const inv0 = A.inv(bot); let shut = null
      try {
        if (wl && !A.count(bot, 'shears')) { task(bot, 'herd: fetching shears'); await A.withdraw(bot, 'shears', 1, { stop: api.stop }) }
        if (surplus() > 0 && !A.bestOf(bot, 'sword')) { task(bot, 'herd: fetching a sword'); for (const s of ['diamond_sword', 'iron_sword', 'stone_sword']) { if (api.stop() || (A.stockOf(s) > 0 && await A.withdraw(bot, s, 1, { stop: api.stop }))) break } if (!A.bestOf(bot, 'sword') && !A.bestOf(bot, 'axe') && !api.stop()) await A.obtain(bot, 'stone_sword', 1, { stop: api.stop }) } // an axe kills a sheep in one blow too: no sword is no reason to stay out
        task(bot, 'herd: shearing / culling in ' + job.id)
        await herdHide(bot, names)
        if (!api.stop() && await A.travel(bot, G.out, { range: 1, ms: 240000, stop: api.stop }) && herdGateOpen(bot, G) != null) {
          claim()
          { const t1 = Date.now() + 6000; while (Date.now() < t1 && !api.stop() && Object.values(bot.entities).some(e => e && e.position && e.isValid !== false && e.name === kind && e.position.distanceTo(G.gate.offset(0.5, 0, 0.5)) < 2.2)) await sleep(400) } // a full pen crowds the gate: nobody slips out past me
          await herdGate(bot, G, true)
          if (await A.travel(bot, G.inside, { range: 1, ms: 40000, stop: api.stop, quiet: true })) {
            await herdGate(bot, G, false)
            if (lit0) {
              let cleared = 0; const BLK = lib('blocks')
              for (const q of litter().sort((a, b) => b.y - a.y || a.distanceTo(me()) - b.distanceTo(me()))) { if (api.stop()) break; const r = await BLK.digBlock(bot, q, { collect: true, requireHarvest: false, plug: false }).catch(e => ({ ok: false, reason: String(e && e.message) })); if (r.ok) cleared++ }
              A.result(bot, { ev: 'pen_litter', job: job.id, found: lit0, cleared, left: litter().length })
            }
            const tried = new Set(); const sh = () => bot.inventory.items().find(i => i.name === 'shears')
            while (!api.stop() && sh() && sheared < 24) {
              const t = woolly().filter(e => !tried.has(e.id)).sort((p, q) => p.position.distanceTo(me()) - q.position.distanceTo(me()))[0]; if (!t) break
              tried.add(t.id)
              if (t.position.distanceTo(me()) > 2.8) await A.travel(bot, t.position, { range: 2, ms: 15000, stop: api.stop, quiet: true })
              if (t.isValid === false || t.position.distanceTo(me()) > 3.5) continue
              try { await U.withTimeout(bot.equip(sh(), 'hand'), 3000, 'herdShears'); await bot.lookAt(t.position.offset(0, 0.8, 0), true); await U.withTimeout(Promise.resolve(bot.useOn(t)), 2500, 'herdShear') } catch (e_) { swallow('army_jobs:herdShear', e_) }
              await sleep(600); if (sheepSheared(t)) sheared++
            }
            if (sheared) await A.pickup(bot, 8, 5000)
            while (!api.stop() && culled < 16 && bot.health >= 10) {
              const c = herdCount(bot, G, kind); if (P.cull === false || c.adults.length <= flock) break
              if (kind === 'sheep' && sh() && c.adults.some(e => !sheepSheared(e))) break // never kill while wool still stands in the pen: shear first (next visit)
              claim()
              // shorn sheep first (their wool is already ours), then whoever stands nearest
              const t = c.adults.sort((p, q) => (sheepSheared(q) - sheepSheared(p)) || (p.position.distanceTo(me()) - q.position.distanceTo(me())))[0]
              if (!await A.kill(bot, t, 20000, api.stop)) { if (t.isValid !== false) break; }
              culled++; await A.pickup(bot, 6, 3000)
            }
            if (culled) await A.pickup(bot, 14, 8000)
          }
        }
      } catch (e_) { swallow('army_jobs:herdCull', e_) } finally { shut = await herdLeave(bot, G, kind, names); unclaim() }
      const got = {}; for (const [k, n] of Object.entries(A.inv(bot))) if (n > (inv0[k] || 0) && /leather|beef|mutton|chicken|porkchop|feather|_wool$/.test(k)) got[k] = n - (inv0[k] || 0)
      const c = herdCount(bot, G, kind); c0 = c
      if (lit0 && !(sheared || culled)) worked = { sheared, culled }
      if (sheared || culled) { worked = { sheared, culled }; A.result(bot, { ev: 'pen_harvest', job: job.id, kind, sheared, culled, got, adults: c.adults.length, babies: c.babies.length, want, keep: flock, outside: wild(12).length, gateShut: shut, s: Math.round((Date.now() - t0) / 1000) }) }
      if (!shut) say({ ev: 'pen_open', why: 'gate did not shut after the pen harvest', at: P.gate }, 60000)
      if (Object.values(got).reduce((a, b) => a + b, 0) >= 8 && !api.stop()) { task(bot, 'herd: banking the pen harvest'); const keep = { torch: 16, shears: 1, ...rationsOf(bot) }; for (const n of names) keep[n] = 32; await A.bank(bot, keep, { job: job.id, stop: api.stop }) }
    }
  }
  // a team-mate is in the pen shearing/culling: THIS bot steps aside for 3 min - the job itself has work and must not rest (02:06Z: the second herder's 'nobody ready to breed' rested the job and pulled the first one out)
  if (worked && worked.mate && !(brought > 0 || (bredNow && bredNow.fed))) { A.decline(bot, job, 180000, 'a team-mate works the pen'); task(bot, 'herd: a team-mate works the pen'); const t1 = Date.now() + 20000; while (Date.now() < t1 && !api.stop()) await sleep(500); return 'herd: a team-mate works the pen' }
  if (worked && !(brought > 0 || (bredNow && bredNow.fed))) return 'herd: ' + kind + ' pen harvest - sheared ' + worked.sheared + ', culled ' + worked.culled + ', adults ' + c0.adults.length + '/' + want
  if (brought > 0 || (bredNow && bredNow.fed)) return 'herd: ' + kind + ' in pen ' + c0.n + '/' + want + (brought > 0 ? ', brought ' + brought : '') + (bredNow ? ', fed ' + bredNow.fed + ' babies ' + bredNow.babies : '')
  return back(c0.n >= want ? kind + ' ' + c0.n + '/' + want + ' in the pen, nobody ready to breed yet' : 'no ' + kind + ' to lure within ' + radius + ' of the pen (' + c0.n + '/' + want + ' inside' + (c0.adults.length >= 2 ? ', breeding on cooldown' : '') + ')')
}

// ------------------------------------------------------------------ fish: ice-hole fishing at the job site (food engineer's fishery lib)
async function fish (bot, job, api, ctx) {
  const FI = lib('fishery')
  const P = job.params || {}
  if (!A.count(bot, 'fishing_rod')) {
    await A.withdraw(bot, 'fishing_rod', 1, { stop: api.stop })
    if (!A.count(bot, 'fishing_rod')) return muster(bot, job, api, ctx, 'fish: no rod')
  }
  const fishN = () => A.count(bot, 'salmon') + A.count(bot, 'cod')
  if (isNight(api) && !P.night) {
    if (fishN() > 0) await A.bank(bot, { fishing_rod: 1, torch: 16 }, { job: job.id, stop: api.stop })
    return muster(bot, job, api, ctx, 'fish: night')
  }
  const site = v(job.site)
  task(bot, 'fish:travel')
  if (A.dist2(bot, site.x, site.z) > 10) {
    if (!await A.travel(bot, site, { range: 4, ms: 300000, stop: api.stop, via: P.via })) return 'fish: cannot reach site'
  }
  const spot = FI.findSite(bot, P.r || 12)
  if (!spot) { await sleep(5000); return 'fish: no fishing spot at site' }
  task(bot, 'fish')
  const st = await FI.session(bot, spot, { ms: P.sessionMs || 180000, abort: () => api.stop() || (isNight(api) && !P.night) })
  A.result(bot, { ev: 'fish_session', job: job.id, st })
  await A.pickup(bot, 4, 2000)
  if (fishN() >= (P.haul || 10) || U.freeSlots(bot) <= 2) {
    // work where you stand: with a site chest at the dock (params.siteChest) the fisher never commutes — a `haul` job brings it home
    if (P.siteChest) { task(bot, 'fish:stash'); const m = await A.stash(bot, v(P.siteChest), { cod: 0 }, { stop: api.stop }); if (m) { A.result(bot, { ev: 'stashed', job: job.id, items: m }); return 'fish' } }
    task(bot, 'fish:bank')
    await A.bank(bot, { fishing_rod: 1, torch: 16 }, { job: job.id, stop: api.stop })
  }
  return 'fish'
}

// ------------------------------------------------------------------ haul: bring a site chest's content home in bulk (dock, mine head, outpost, lumber camp …)
// params: from:[x,y,z] (site chest, placed by a plan), min: 24 (items worth the walk), via:[…]. Deposits by category at the depot.
async function haul (bot, job, api, ctx) {
  const P = job.params || {}
  const from = v(P.from)
  if (isNight(api) && !P.night) return muster(bot, job, api, ctx, 'haul: night')
  const info = A.siteInfo(from)
  if (info.n < (P.min || 24) && Date.now() - info.t < 20 * 60000) return muster(bot, job, api, ctx, 'haul: site chest holds ' + info.n + ' (< ' + (P.min || 24) + ')')
  await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop }) // go out empty
  task(bot, 'haul:out')
  if (!await A.travel(bot, from, { range: 3, ms: 420000, stop: api.stop, via: P.via })) return 'haul: cannot reach the site chest'
  const got = await A.unstash(bot, from, { stop: api.stop })
  if (!got) return 'haul: site chest missing at ' + P.from
  try { await lib('feed').eat(bot, { rawOk: true }) } catch (e_) { swallow('army_jobs:196', e_) }
  task(bot, 'haul:home')
  const home = A.chestsOf('food')[0] || musterSlot(bot)
  await A.travel(bot, home, { range: 4, ms: 420000, stop: api.stop, via: (P.via || []).slice().reverse() })
  const moved = await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop })
  A.result(bot, { ev: 'hauled', job: job.id, got, banked: Object.values(moved).reduce((a, b) => a + b, 0) })
  return 'haul'
}

// CRAFTED GOODS HAVE A PRODUCER: the quartermaster (foreman 09-19 21:36Z: `targets` said torch 224 "NOBODY", depot torch 0 while charcoal 362 and
// coal 20 lay in the same depot; 13 miners went down dark, builders `build_blocked: no torch`). Each round ONE batch of the crafted target that
// is furthest below its target is made from depot stock through the normal obtain chain (logs -> planks -> sticks -> torches) and banked.
// (review row 3, 09-20 12:0xZ: this table was born in the stone age and is the army's ONLY automatic tool producer - 19 of 50 bots were on a wooden/stone pickaxe or
// none and the depot held 0 pickaxes of any kind, while 353 diamonds and 66 ingots lay in the same depot. Batches follow the x50 rule: torch 64->256, planks 64->256,
// stick 32->128.) A key only becomes a candidate when `settings.targets` names it, so adding a row here costs nothing until the board wants the thing.
const CRAFTED = { torch: 256, planks: 256, stick: 128, arrow: 32, book: 3, bookshelf: 3, enchanting_table: 1, stone_shovel: 8, stone_axe: 8, stone_pickaxe: 8, iron_pickaxe: 4, diamond_pickaxe: 4, diamond_shovel: 4, diamond_axe: 4, diamond_sword: 4, bucket: 2, shears: 4, bow: 2, shield: 2 } // target key -> batch per round; raw materials and smelted goods have their own jobs
// A TOOL IS NEVER WORTH THE RESERVE IT EATS: a precious material is spent from its SURPLUS only - a diamond batch needs more than 64 diamond in the depot, anything
// made of iron more than 32 iron_ingot (the mine, the buckets and the enchanting chain live on the rest). Below that the key is simply not a candidate this round.
const CRAFT_FROM = { iron_pickaxe: 'iron_ingot', bucket: 'iron_ingot', shears: 'iron_ingot', shield: 'iron_ingot', diamond_pickaxe: 'diamond', diamond_shovel: 'diamond', diamond_axe: 'diamond', diamond_sword: 'diamond' }
const CRAFT_RESERVE = { diamond: 64, iron_ingot: 32 }
// BOOKS (P4): paper <- 3 sugar cane, book <- 3 paper + leather, bookshelf <- 3 books + 6 planks, enchanting_table <- book + 2 diamonds + 4 obsidian: the recipe solver
// walks the whole chain, so `targets bookshelf 15` + `enchanting_table 1` is all the quartermaster needs. Beds are NOT crafted here: the dorm's builders make each bed from the wool in stock when they place it (a second bed maker raced them for the wool, 02:17Z).
// A candidate is only taken when the solver says the depot CAN make a batch now (full, half, or one) - the worst deficit with no material (books without cane)
// must not block torches for ever, and nobody files `obtain_failed` every 5 minutes for it.
const _craftFail = {}
async function craftToTargets (bot, job, api) {
  const T = A.settings().targets || {}; const C = lib('craft'); const reg = bot.registry
  // SUPPLIES ARE JUDGED IN THE DEPOT (foreman 09-20 03:58Z: `targets` read torch 583/224 "done" with depot 0 / carried 494 - every bot keeps a working
  // kit of 16 torches, miners 48 - so nothing was crafted and every job that WITHDRAWS torches starved: base_light, the hall/depot builds). A pocket is
  // not a shelf: have = depot + a small allowance (<= 25 % of the target) for what is carried BEYOND the pocket kits (a builder's load on its way).
  // The 23:02Z overshoot (planks 1553/224, sticks 1106/128 with a depot that read 0) keeps its brake as a HARD CEILING: depot + carried-beyond-kits >= 2x target = no craft.
  let ST = null; try { ST = require('../../army/stock.js') } catch (e_) { swallow('army_jobs:craftTargetsStock', e_) }
  const D = ST ? ST.detail() : { chest: A.stockMap(), carried: {} }; const nBots = (A.settings().roster || []).length || 30
  const POCKET = { torch: 16, stick: 8 } // what bank()/pockets leave with EVERY bot (their keep lists)
  const haveOf = k => { const dep = ST ? ST.count(k, D.chest) : (k === 'planks' ? stockRe(U.PLANK_RE) : A.stockOf(k)); const extra = Math.max(0, (ST ? ST.count(k, D.carried) : 0) - (POCKET[k] || 0) * nBots); return { have: dep + Math.min(extra, Math.ceil(T[k] / 4)), all: dep + extra } }
  const cands = []
  for (const k of Object.keys(CRAFTED)) { if (!(T[k] > 0)) continue; const raw = CRAFT_FROM[k]; if (raw && A.stockOf(raw) <= (CRAFT_RESERVE[raw] || 0)) continue; const { have, all } = haveOf(k); if (all >= 2 * T[k] || Date.now() - (_craftFail[k] || 0) < 1800000) continue; const d = 1 - have / T[k]; if (T[k] <= 32 ? have < T[k] : d > 0.1) cands.push({ k, d, have }) }
  cands.sort((a, b) => b.d - a.d)
  const all = A.stockMap(); for (const [k, n] of Object.entries(A.inv(bot))) all[k] = (all[k] || 0) + n
  let pick = null
  for (const c of cands) {
    const item = C.resolve(reg, /_bed$/.test(c.k) ? 'bed' : c.k, all); if (!reg.itemsByName[item]) continue
    const max = Math.max(1, Math.min(CRAFTED[c.k], Math.ceil(T[c.k] - c.have)))
    for (const b of [...new Set([max, Math.ceil(max / 2), 1])]) { if (C.solve(reg, item, (all[item] || 0) + b, Object.assign({}, all)).ok) { pick = { k: c.k, item, b, have: c.have }; break } }
    if (pick) break
  }
  if (!pick || api.stop()) return
  task(bot, 'quartermaster: crafting ' + pick.b + ' ' + pick.item)
  // obtain() draws the item itself from the depot first: ask for stock + batch, or a depot that already holds a few would satisfy the order with no craft at all
  const total = () => A.stockOf(pick.item) + A.count(bot, pick.item); const before = total()
  await A.obtain(bot, pick.item, before + pick.b, { stop: api.stop })
  const made = total() - before
  if (!(made > 0)) _craftFail[pick.k] = Date.now() // 04:12Z: enchanting_table (deficit 100 %, solver OK, `ingredients did not arrive: book`) would take every round from the torches - a key that made nothing rests 30 min
  A.result(bot, { ev: 'crafted_to_target', job: job.id, item: pick.item, key: pick.k, made, stock: pick.have, target: T[pick.k] })
  if (A.count(bot, pick.item) > 0) await A.bank(bot, {}, { job: job.id, stop: api.stop, noKit: true })
}
// ------------------------------------------------------------------ scan: quartermaster refreshes the chest index
async function scan (bot, job, api, ctx) {
  task(bot, 'scan chests')
  if (job.params && job.params.bank) await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop })
  const n = await A.scanChests(bot, { stop: api.stop })
  A.result(bot, { ev: 'scan', job: job.id, chests: n })
  await rebuildChests(bot, api)
  await expandChests(bot, api)
  await serviceFurnaces(bot, job, api)
  await craftToTargets(bot, job, api)
  adoptStrayChests(bot)
  await forgeArmour(bot, job, api)
  auditStructures(bot)
  await drainLegacy(bot, job, api)
  // A QUARTERMASTER NEVER STANDS AT MUSTER BETWEEN ROUNDS (owner 09-20: "補給係仕事してない" - three bots held the job and stood 5 min after every
  // 1-min round). After a round the JOB rests on the board (`restUntil`, honoured by the dispatcher: nobody is sent meanwhile) and the bot is handed
  // back for other work; the next round starts with whoever is free then.
  if (job.params && job.params.cook) await cook(bot, job, api)
  const gap = (job.params && job.params.everyMs) || 120000
  A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j) j.restUntil = Date.now() + gap })
  return 'scan: round done (next round in ' + Math.round(gap / 1000) + ' s)'
}
// the quartermaster REBUILDS registered depot chests that are gone (creeper blasts): chest from stock, else crafted from planks/logs;
// a missing floor block under it is replaced with cobblestone first. Everything that lay around gets picked up.
async function rebuildChests (bot, api) {
  const BL = lib('blocks')
  for (const cat of A.CATS) for (const pos of A.chestsOf(cat)) {
    if (api.stop()) return
    const b = bot.blockAt(pos)
    if (!b || /^(chest|trapped_chest|barrel)$/.test(b.name)) continue
    task(bot, 'rebuild chest ' + cat)
    if (!A.count(bot, 'chest')) {
      await A.withdraw(bot, 'chest', 2, { stop: api.stop })
      if (!A.count(bot, 'chest')) await A.obtain(bot, 'chest', 1, { stop: api.stop }) // depot, else crafted from ANY planks/logs we own (the recipe solver decides)
    }
    if (!A.count(bot, 'chest')) { A.result(bot, { ev: 'chest_rebuild_failed', at: [pos.x, pos.y, pos.z], why: 'no chest and no planks/logs in stock' }); return }
    if (!await A.travel(bot, pos, { range: 3, ms: 60000, stop: api.stop })) continue
    await A.pickup(bot, 8, 5000)
    if (!BL.isReplaceable(bot.blockAt(pos))) await BL.digBlock(bot, pos, { collect: true, requireHarvest: false }).catch(e_ => swallow('army_jobs:240', e_))
    const under = bot.blockAt(pos.offset(0, -1, 0))
    if (under && under.boundingBox !== 'block') { if (!A.count(bot, 'cobblestone')) await A.withdraw(bot, 'cobblestone', 8, { stop: api.stop }); await BL.placeBlock(bot, pos.offset(0, -1, 0), 'cobblestone', {}).catch(e_ => swallow('army_jobs:242', e_)) }
    let r = null
    for (let k = 0; k < 5 && !api.stop(); k++) { r = await A.placeHard(bot, pos, 'chest', { stop: api.stop }); break } // somebody stands in the cell: wait for them to move on
    A.result(bot, r.ok ? { ev: 'chest_rebuilt', cat, at: [pos.x, pos.y, pos.z] } : { ev: 'chest_rebuild_failed', at: [pos.x, pos.y, pos.z], why: r.reason })
  }
}
// the quartermaster EXPANDS the depot by itself: a category whose registered chests are all (nearly) full gets one more chest stacked on
// top of an existing one (max 3 high — chests open fine under chests) and registers it on the board. No operator, no plan needed.
async function getChest (bot, api) {
  if (A.count(bot, 'chest')) return true
  await A.obtain(bot, 'chest', 1, { stop: api.stop }) // depot, else crafted from ANY planks/logs we own
  return A.count(bot, 'chest') > 0
}
async function expandChests (bot, api) {
  const BL = lib('blocks'); const idx = A.index()
  for (const cat of A.CATS) {
    if (api.stop()) return
    const list = A.chestsOf(cat); if (!list.length || list.length >= 9) continue
    if (list.some(p => { const e = idx[p.x + ',' + p.y + ',' + p.z]; return !e || e.used < (e.size || 27) - 3 })) continue // room left somewhere (a double chest reports up to 54)
    let spot = null
    for (const p of list) for (let h = 1; h <= 2 && !spot; h++) { const c = p.offset(0, h, 0); const b = bot.blockAt(c); const below = bot.blockAt(c.offset(0, -1, 0)); if (b && BL.isReplaceable(b) && below && below.name === 'chest' && !list.some(q => q.equals(c))) spot = c }
    if (!spot) continue
    task(bot, 'expand depot: ' + cat)
    if (!await getChest(bot, api)) { A.result(bot, { ev: 'chest_rebuild_failed', at: [spot.x, spot.y, spot.z], why: 'expand: no chest/planks/logs' }); return }
    if (!await A.travel(bot, spot, { range: 3, ms: 60000, stop: api.stop })) continue
    const r = await A.placeHard(bot, spot, 'chest', { stop: api.stop })
    if (r.ok) { A.boardEdit(b => { const l = b.settings.chests[cat] = b.settings.chests[cat] || []; if (!l.some(q => q[0] === spot.x && q[1] === spot.y && q[2] === spot.z)) l.push([spot.x, spot.y, spot.z]) }); A.result(bot, { ev: 'chest_added', cat, at: [spot.x, spot.y, spot.z] }) }
  }
}
// WAREHOUSE KEEPER duties (owner 09-19): besides the index, cooking, baking, rebuilding and expanding chests, the keeper
//   * runs the FURNACES for ores: raw iron/gold/copper in stock + fuel -> ingots into ORES (8 items per coal)
//   * EMPTIES THE OLD BASE: the legacy crater chests (settings.legacyChests) are carried over to the depot one inventory at a time;
//     an emptied chest is picked up and banked, and removed from the list. Stops when nothing is left.
// FURNACES ARE NEVER WAITED AT (owner saw bots queueing in front of them): a keeper visit = take what is done, top up input + fuel, leave.
// Works for any number of furnaces (settings.furnaces, registered by the build job) and any mix of ores and raw food. 8 items per coal.
async function serviceFurnaces (bot, job, api) {
  const list = A.furnaces(); if (!list.length) return
  // COAL IS LIGHT (09-19: the furnaces burned ~400 coal on 455 raw copper nobody needs - then the torch plans found 0 coal and the base stayed
  // dark). Copper is not smelted at all; ore smelting runs only while the coal reserve stays >= 64 (food is always cooked).
  const coalStock = A.stockOf('coal') + A.stockOf('charcoal')
  // THE FIRST INGOTS COME BEFORE THE TORCH HOARD (world 2 day one: 50 raw iron lay in the depot for an hour while every lump of charcoal
  // became torches - 174 of them - so the reserve never reached 64: no bucket for the field water, no shield, no iron pick). Under 32
  // ingots in stock, iron is smelted whatever the reserve says.
  const firstIron = A.stockOf('iron_ingot') < 32
  const RAW = ['cod', 'salmon', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit'].concat(coalStock >= 64 ? ['raw_iron', 'raw_gold'] : firstIron ? ['raw_iron'] : [])
  // CHARCOAL: no coal, no torches, dark mine trunk, creepers (12:39Z: 5 miners in one blast). While the fuel reserve is under 128 and logs are
  // plentiful, the quartermaster burns logs to charcoal (plank fuel) in the furnace bank - torches are crafted from it by obtain()/the miners.
  const burnLog = coalStock < 128 && stockRe(U.LOG_RE) >= 64 ? stockNames(U.LOG_RE)[0] : null // the biggest pile of ANY log
  if (burnLog) RAW.push(burnLog) // LAST: with the log first, every round carried one stack of logs and nothing else - 50 raw iron and all raw food waited for ever (world 2, 09-19)
  const have = RAW.filter(n => A.stockOf(n) + A.count(bot, n) >= 4); let took = 0; let loaded = 0
  task(bot, 'furnaces')
  // one round serves up to THREE kinds (food first, then ore, then logs for charcoal), 32 of each: 20 furnaces have room for all of them
  // ...but never three kinds of FOOD while the fuel runs dry (09-20 01:28Z: fuel 6/224 with 1704 logs in stock - six raw foods always filled the three
  // slots and the log, last in the list, never got a turn): one slot is the log's whenever charcoal is wanted, one the ore's, the rest is food.
  const pick = []; const ore = have.find(n => /^raw_/.test(n)); const foodKinds = have.filter(n => n !== burnLog && n !== ore)
  if (burnLog && have.includes(burnLog)) pick.push(burnLog); if (ore) pick.push(ore); for (const f of foodKinds) { if (pick.length >= 3) break; pick.push(f) }
  for (const n of pick) { if (api.stop()) break; if (A.count(bot, n) < 8 && A.stockOf(n) > 0) await A.withdraw(bot, n, 32, { stop: api.stop }) }
  if (A.count(bot, 'coal') + A.count(bot, 'charcoal') < 4) await A.withdraw(bot, A.stockOf('coal') ? 'coal' : 'charcoal', 16, { stop: api.stop })
  if (A.count(bot, 'coal') < 4 && !bot.inventory.items().some(i => /_planks$/.test(i.name))) { const pl = stockNames(U.PLANK_RE)[0]; if (pl) await A.withdraw(bot, pl, 48, { stop: api.stop }) } // plank fuel (any wood) when there is no coal
  for (const fp of list) {
    if (api.stop()) break
    const w = await A.openAt(bot, fp, ['furnace', 'blast_furnace', 'smoker']).catch(e_ => { swallow('army_jobs:furnaceOpen', e_); return null }); if (!w) continue
    try {
      if (w.outputItem()) { const n = w.outputItem().count; await U.withTimeout(w.takeOutput(), 6000, 'takeOut').catch(e_ => swallow('army_jobs:takeOut', e_)); took += n }
      const inp = w.inputItem(); const raw = RAW.find(n => A.count(bot, n) > 0 && (!inp || inp.name === n))
      if (raw && (!inp || inp.count < 32)) { const n = Math.min(A.count(bot, raw), 64 - (inp ? inp.count : 0)); await U.withTimeout(w.putInput(bot.registry.itemsByName[raw].id, null, n), 6000, 'putIn').catch(e_ => swallow('army_jobs:putIn', e_)); loaded += n }
      const fuel = w.fuelItem(); const need = Math.ceil(((w.inputItem() || {}).count || 0) / 8) - (fuel ? fuel.count : 0)
      const plank = bot.inventory.items().find(i => /_planks$/.test(i.name))
      const fname = A.count(bot, 'coal') ? 'coal' : A.count(bot, 'charcoal') && !U.LOG_RE.test(String(raw)) ? 'charcoal' : plank ? plank.name : A.count(bot, 'charcoal') ? 'charcoal' : null
      const needF = /_planks$/.test(String(fname)) ? Math.ceil(need * 8 / 1.5) : need // a plank smelts 1.5 items, coal 8
      if (need > 0 && fname) await U.withTimeout(w.putFuel(bot.registry.itemsByName[fname].id, null, Math.min(needF, A.count(bot, fname))), 6000, 'putFuel').catch(e_ => swallow('army_jobs:putFuel', e_))
    } finally { A.closeWin(w); await sleep(200) }
  }
  if (took || loaded) A.result(bot, { ev: 'furnaces', job: job.id, took, loaded })
  await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop, noKit: true })
}
// THE MINE'S STAIRWELL IS NOT TERRAIN (foreman 09-20 03:58Z: base_mine_pad ended "complete - BUT 6 cells are left": -330/-329,-501..-504 = the first steps of
// the iron mine, which the pad wanted back at y68 and the miners cut open again; fill_minepad_void "26 cells nobody could do" = the same stairs one layer down).
// col "x,z" -> floor y of the stair there (both lanes and the cheek blocks: +-1); a ground/fill cell ABOVE that floor is never work and never a "low column".
let _stairCols = { t: 0, m: new Map() }
function stairCols () {
  if (Date.now() - _stairCols.t < 30000) return _stairCols.m
  const m = new Map()
  try { for (const st of (A.readJSON(require('path').join(A.DIR, '..', 'iron_mine.json'), {}) || {}).steps || []) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const k = (st[0] + dx) + ',' + (st[2] + dz); if (!m.has(k) || m.get(k) > st[1] - 1) m.set(k, st[1] - 1) } } catch (e_) { swallow('army_jobs:stairCols', e_) }
  _stairCols = { t: Date.now(), m }
  return m
}
// A PAD IS JUDGED PER COLUMN (same report: the blueprint's own cell list called a pad complete while columns of its box sat 1-2 below pad level - the leftover
// rule lets <= 0.5 % of the cells go, unloaded chunks read as "no work", and a rim like that is a travel dead zone: travel_fail x47/30 min at the haul chest).
// padAudit: every column of a level pad that is in view -> low = the pad-level cell is not solid (first solid below in the list), high = natural ground left in the
// 2 cells of headroom. NOT terrain: furniture and anything else that was built on the pad (chest, furnace, table, bed, fence, torch ... stand ABOVE a solid pad
// cell and are never looked at), water and crops (a field owns them), the mine stairwell, settings.keepOut boxes (quarry), and cells another blueprint of the
// board digs on purpose (a field's water channel, a stair mouth).
function padAudit (bot, q, board) {
  const solid = b => !!b && b.boundingBox === 'block'; const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const cols = new Map(); for (const c of blueprintCellsOf(q)) if (c.fillOnly && c.block !== 'air') { const k = c.x + ',' + c.z; if (!cols.has(k) || cols.get(k).y < c.y) cols.set(k, c) }
  const stairs = stairCols(); const zones = (A.settings().keepOut || []).map(k => k && k.box).filter(b => Array.isArray(b) && b.length === 4).map(b => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])])
  const padY = Math.max(...[...cols.values()].map(c => c.y)); const owned = new Set()
  for (const j of (board && board.jobs) || []) { const p = j.params || {}; if (j.type !== 'build' || !p.blueprint || /^(level|clear_area|fill_void)$/.test(p.blueprint) || !Array.isArray(p.origin) || Math.hypot(p.origin[0] - q.origin[0], p.origin[2] - q.origin[2]) > 120) continue; try { for (const c of blueprintCellsOf(p)) if (c.y <= padY && (c.block === 'air' || c.block === 'water')) owned.add(c.x + ',' + c.z) } catch (e_) { swallow('army_jobs:padAuditOwned', e_) } }
  const out = { total: cols.size, seen: 0, low: [], high: [] }
  for (const [k, c] of cols) {
    const b = at(c.x, c.y, c.z); if (!b) continue
    out.seen++
    if (stairs.has(k) || owned.has(k) || zones.some(z => c.x >= z[0] && c.x <= z[2] && c.z >= z[1] && c.z <= z[3])) continue
    if (!solid(b)) {
      if (/^(water|lava|wheat|carrots|potatoes|beetroots|sweet_berry_bush|sugar_cane)$/.test(b.name) || U.protectedBlock(b)) continue // a field's water / a crop one step down / furniture set into the pad
      const dn = at(c.x, c.y - 1, c.z); if (dn && /^(farmland|water)$/.test(dn.name)) continue
      let y = c.y - 1; while (y > c.y - 8 && !solid(at(c.x, y, c.z))) y--
      out.low.push(c.x + ',' + y + ',' + c.z)
    } else for (let y = c.y + 1; y <= c.y + 2; y++) { const h = at(c.x, y, c.z); if (h && /^(dirt|grass_block|coarse_dirt|podzol|stone|granite|diorite|andesite|gravel|sand|deepslate|tuff)$/.test(h.name)) { out.high.push(c.x + ',' + y + ',' + c.z); break } }
  }
  return out
}
// BUILT IS NOT DONE FOR EVER: every structure the army built from a blueprint (build jobs on the board or archived in bots/army/jobs-archive.jsonl)
// is compared with its blueprint, one structure per quartermaster round, when it stands in view. 6+ cells (or 5 %) no longer what the blueprint
// says = `structure_damaged`, and the structure's own build job is put back on the board ACTIVE - building is idempotent, so that IS the repair.
function auditStructures (bot) {
  try {
    const fs = require('fs'); const pth = require('path')
    const board = A.readJSON(A.F.board, {}) || {}; const jobs = new Map()
    try { for (const l of fs.readFileSync(pth.join(A.DIR, 'jobs-archive.jsonl'), 'utf8').split('\n')) { if (!l) continue; const j = JSON.parse(l); if (j.type === 'build') jobs.set(j.id, j) } } catch (e_) { swallow('army_jobs:auditArchive', e_) }
    // only what was FINISHED once can be damaged (world 2, 09-19 21:3xZ: roads and pens still waiting for their turn in the `after` chain were
    // "auto-reactivated: 507 cells damaged" - an unbuilt structure is 100 % different from its blueprint - and ran before their pads existed)
    // (09-20: base_dorm ended "11 cells nobody could do" = never FINISHED in these words = never audited, and its east wall stood open unseen: a build that gave up
    //  on a few cells is a structure too - its known leftovers are taken off the damage count below)
    for (const j of board.jobs || []) if (j.type === 'build') { if (/build complete|grid complete|auto-reactivated|auto-restored|cells nobody could do/.test(String(j.note || ''))) jobs.set(j.id, j); else jobs.delete(j.id) }
    for (const [id, j] of jobs) if (!/build complete|grid complete|auto-reactivated|auto-restored|cells nobody could do/.test(String(j.note || ''))) jobs.delete(id)
    // A BANG NEAR A STRUCTURE IS LOOKED AT FIRST AND JUDGED HARD (owner 09-20: five furnaces in a row gone from the hall bank = the creeper of 04:00:33Z at -358,69,-525,
    // heard by 14 bots, logged as `crater` debt - and nobody came: 5 cells are under the 6-cell / 5 % rule). Craters of the last 45 min from the debt ledger:
    const booms = []
    try {
      const f = pth.join(A.DIR, 'terrain_debt.jsonl'); const size = fs.statSync(f).size; const len = Math.min(size, 65536); const buf = Buffer.alloc(len); const fd = fs.openSync(f, 'r'); try { fs.readSync(fd, buf, 0, len, size - len) } finally { fs.closeSync(fd) }
      // A TAIL READ STARTS IN THE MIDDLE OF A LINE, and several processes append to the ledger (two records can share a line, a test once wrote bogus ones): the cut
      // first line is dropped, glued records are split, a line that still does not parse is skipped - counted ONCE per process, never thrown (was 11 swallowed errors/h)
      let txt = buf.toString('utf8'); if (size > len) txt = txt.slice(txt.indexOf('\n') + 1)
      let bad = 0
      for (const l of txt.replace(/\}\s*\{"/g, '}\n{"').split('\n')) { if (!l.includes('"crater"')) continue; let r = null; try { r = JSON.parse(l) } catch (e_) { bad++; continue } if (r && r.kind === 'crater' && Array.isArray(r.at) && Date.now() - r.t < 45 * 60000 && !booms.some(q => q.at[0] === r.at[0] && q.at[2] === r.at[2])) booms.push(r) }
      if (bad && !global.__armyBoomBadSaid) { global.__armyBoomBadSaid = true; swallow('army_jobs:auditBoomLine', new Error(bad + ' unparsable line(s) in terrain_debt.jsonl skipped')) }
    } catch (e_) { swallow('army_jobs:auditBooms', e_) }
    const AF0 = pth.join(A.DIR, 'asset_audit.json')
    const boomNear = j => { const o = j.params.origin; const a = j.params.args || {}; const r = Math.max(a.w || 16, a.d || 16, a.len || 0) + 8; return booms.find(q => Math.hypot(q.at[0] - o[0], q.at[2] - o[2]) <= r) || null }
    // LEVEL PADS: one pad in view per round is judged column by column (padAudit). A low column = the pad's own job goes back on the board ACTIVE (levelling is
    // idempotent: that IS the repair) - at most once an hour per pad, so three builders who cannot do it do not spin the board; headroom left standing is reported only.
    try {
      // (09-20: `prune` archives finished pads, and the filter asked for a pad ON THE BOARD - so no archived pad was ever judged again. A pad is a structure: the
      //  archive counts, and a pad that is not on the board any more comes back from the archive ACTIVE when a column of it sank - a crater re-runs its pad.)
      const pads = [...jobs.values()].filter(j => j.params && j.params.blueprint === 'level' && Array.isArray(j.params.origin) && A.dist2(bot, j.params.origin[0], j.params.origin[2]) < 60 && !(board.jobs || []).some(q => q.id === j.id && q.status === 'active'))
      if (pads.length) {
        auditStructures.p = ((auditStructures.p || 0) + 1) % pads.length
        const au0 = A.readJSON(AF0, {}) || {}
        const j = pads.find(q => { const bm = boomNear(q); return bm && ((au0[q.id + ':pad'] || {}).t || 0) < bm.t }) || pads[auditStructures.p]; const r = padAudit(bot, j.params, board)
        const AF = pth.join(A.DIR, 'asset_audit.json'); const au = A.readJSON(AF, {}) || {}; const k = j.id + ':pad'; const e = au[k] || {}
        if (r.seen >= r.total * 0.8 && (r.low.length || r.high.length) && Date.now() - (e.t || 0) > 3600000) {
          au[k] = { t: Date.now(), low: r.low.length, high: r.high.length }; A.writeJSON(AF, au)
          A.result(bot, { ev: 'pad_uneven', job: j.id, low: r.low.length, high: r.high.length, cells: r.low.concat(r.high).slice(0, 6).join(' | ') })
          if (r.low.length) A.boardEdit(b => { const q = (b.jobs || []).find(x => x.id === j.id); const note = 'auto-reactivated: ' + r.low.length + ' columns below pad level (pad_uneven): ' + r.low.slice(0, 6).join(' | '); if (q && q.status !== 'active') { q.status = 'active'; q.rev = (q.rev || 0) + 1; delete q.stuckBy; q.note = note } else if (!q) { const n = Object.assign({}, j, { status: 'active', rev: (j.rev || 0) + 1, note }); delete n.stuckBy; delete n.after; b.jobs.push(n) } })
        }
      }
    } catch (e_) { swallow('army_jobs:padAudit', e_) }
    const list = [...jobs.values()].filter(j => j.params && j.params.blueprint && !/^(level|clear_area)$/.test(j.params.blueprint) && Array.isArray(j.params.origin) && A.dist2(bot, j.params.origin[0], j.params.origin[2]) < 70 && !(board.jobs || []).some(q => q.id === j.id && q.status === 'active'))
    if (!list.length) return
    auditStructures.i = ((auditStructures.i || 0) + 1) % list.length
    const au1 = A.readJSON(AF0, {}) || {}
    const hot = list.find(q => { const bm = boomNear(q); return bm && ((au1[q.id + ':struct'] || {}).t || 0) < bm.t })
    const j = hot || list[auditStructures.i]
    const cells = blueprintCellsOf(j.params).filter(c => c.block !== 'air' && !c.fillOnly && !/torch/.test(c.block))
    let seen = 0; const wrong = []
    const STORE = /^(chest|trapped_chest|barrel)$/ // the quartermaster rebuilds a lost barrel as a CHEST: storage is storage, not damage (14:5xZ: 43 "damaged" cells were rebuilt chests)
    const same = (want, have, c) => want === have || (c && Array.isArray(c.mats) && c.mats.includes(have)) || (STORE.test(want) && STORE.test(have)) || (/^(dirt|grass_block|farmland|podzol|dirt_path)$/.test(want) && /^(dirt|grass_block|farmland|podzol|dirt_path)$/.test(have))
    for (const c of cells) { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!b) continue; seen++; if (!same(c.block, b.name, c) || (c.block === 'water' && b.metadata !== 0)) wrong.push(c.block + '@' + c.x + ',' + c.y + ',' + c.z + '=' + b.name) }
    if (seen < cells.length * 0.8) return // not fully in view: judge another time
    // a LOST WATER CELL dries 60+ tiles: damage by itself, whatever the 5 % rule says (the field's build job is the only one that may pour it again).
    // So is lost FURNITURE and a hole in a FENCE RING (5 furnaces = 5 cells; one fence post = the whole flock), and anything at all right after a bang beside it.
    // Known leftovers of a build that gave up ("N cells nobody could do") are not new damage; one re-activation per structure per hour (asset_audit.json).
    const known = +((/(\d+) cells nobody could do/.exec(String(j.note || '')) || [])[1] || 0)
    const hard = wrong.filter(w => /^(water|furnace|blast_furnace|smoker|chest|barrel|crafting_table|[a-z_]+_bed|[a-z_]+_fence|[a-z_]+_fence_gate)@/.test(w)).length
    const last = (au1[j.id + ':struct'] || {}).t || 0
    if (hot) { au1[j.id + ':struct'] = Object.assign({}, au1[j.id + ':struct'], { t: wrong.length ? last : Date.now(), looked: Date.now() }); if (!wrong.length) A.writeJSON(AF0, au1) }
    if ((wrong.length - known >= Math.max(6, Math.ceil(cells.length * 0.05)) || hard > known || (hot && wrong.length > known)) && Date.now() - last > 3600000) {
      au1[j.id + ':struct'] = { t: Date.now(), wrong: wrong.length }; A.writeJSON(AF0, au1)
      A.result(bot, { ev: 'structure_damaged', job: j.id, blueprint: j.params.blueprint, missing: wrong.length, of: cells.length, furniture: hard, bang: hot ? boomNear(j).at : undefined, examples: wrong.slice(0, 4) })
      A.boardEdit(b => { const q = (b.jobs || []).find(x => x.id === j.id); if (q) { q.status = 'active'; q.rev = (q.rev || 0) + 1; q.note = 'auto-reactivated: ' + wrong.length + ' cells damaged' } else b.jobs.push(Object.assign({}, j, { status: 'active', rev: (j.rev || 0) + 1, note: 'auto-restored from the archive: ' + wrong.length + ' cells damaged' })) })
    }
  } catch (e_) { swallow('army_jobs:auditStructures', e_) }
}
// INGOTS DO NOT SIT IN A CHEST: armour is what keeps bots alive against mobs. Whenever 8+ iron ingots are in stock the quartermaster forges the
// armour piece the army has the fewest of and banks it; `bank()` hands iron gear to every bot that lacks the piece (kit-up).
async function forgeArmour (bot, job, api) {
  try {
    // TOOLS BEFORE MORE ARMOUR (foreman 09-20 00:22Z: every ingot became armour the minute it left the furnace - 10 sets worn while the army had
    // no shears (beds for 50), 0 spare ingots for buckets and ONE iron pickaxe: the diamond level needs iron picks). The forge keeps a RESERVE of
    // 32 ingots for tools; and first of all it makes what the next phase waits for: iron pickaxes up to 8, shears up to 4 (banked for the squads).
    const ing = A.stockOf('iron_ingot'); if (api.stop()) return
    const toolWant = [['iron_pickaxe', 8, 3], ['shears', 4, 2]].map(([name, n, c]) => ({ name, c, short: n - (A.stockOf(name) + A.liveBots().reduce((k, h) => k + ((h.inv || {})[name] ? 1 : 0), 0)) })).filter(x => x.short > 0)
    if (toolWant.length && ing >= toolWant[0].c) {
      const x = toolWant[0]; const n = Math.min(x.short, Math.floor(ing / x.c), 4); task(bot, 'forging ' + x.name)
      if (await A.obtain(bot, x.name, A.count(bot, x.name) + n, { stop: api.stop })) { A.result(bot, { ev: 'forged', job: job.id, made: { [x.name]: n } }); await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop, noKit: true }) }
      return
    }
    if (ing < 8 + 32) return
    const hb = require('fs').readdirSync(require('path').join(A.DIR, 'hb')).map(f => A.readJSON(require('path').join(A.DIR, 'hb', f), null)).filter(Boolean)
    const worn = piece => hb.filter(h => Object.keys(h.inv || {}).some(k => /^(iron|diamond)_/.test(k) && k.endsWith('_' + piece))).length + A.stockOf('iron_' + piece)
    const need = [['chestplate', 8], ['leggings', 7], ['helmet', 5], ['boots', 4]].map(([p, c]) => ({ p, c, have: worn(p) })).filter(x => x.have < 30).sort((a, b) => a.have - b.have)
    if (!need.length) return
    task(bot, 'forging armour')
    const got = await A.withdraw(bot, 'iron_ingot', Math.min(A.stockOf('iron_ingot') - 32, 32), { stop: api.stop })
    if (!got) return
    const tb = A.chestsOf('tools')[0]; if (tb) await A.travel(bot, tb, { range: 4, ms: 60000, stop: api.stop })
    const made = {}
    for (let k = 0; k < 6 && !api.stop(); k++) { const x = need[k % need.length]; if (A.count(bot, 'iron_ingot') < x.c) { const y = need.find(q => q.c <= A.count(bot, 'iron_ingot')); if (!y) break; if (await VERBS.craft(bot, { item: 'iron_' + y.p, n: 1 }, api) === true) made['iron_' + y.p] = (made['iron_' + y.p] || 0) + 1; else break } else if (await VERBS.craft(bot, { item: 'iron_' + x.p, n: 1 }, api) === true) made['iron_' + x.p] = (made['iron_' + x.p] || 0) + 1; else break }
    if (Object.keys(made).length) A.result(bot, { ev: 'forged', job: job.id, made })
    await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop })
  } catch (e_) { swallow('army_jobs:forgeArmour', e_) }
}
// PERCEPTION, not bookkeeping: whatever container stands in the base zone and is NOT one of ours (settings.chests, a job's site chest) is an old
// chest somebody left behind -> it is adopted into settings.legacyChests, drained into the warehouse and taken down. (09-19: the owner saw ten
// old-base chests standing while the board said "0 left" - the list was the only thing anybody looked at.)
function adoptStrayChests (bot) {
  try {
    const S = A.settings(); const m = setting(bot, 'muster'); if (!m) return 0
    const ids = ['chest', 'trapped_chest', 'barrel'].map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
    const K = p => p[0] + ',' + p[1] + ',' + p[2]
    const ours = new Set(); for (const l of Object.values(S.chests || {})) for (const c of l) ours.add(K(c))
    for (const l of Object.values(S.legacyChests || {})) for (const c of l) ours.add(K(c))
    try { for (const [k, e] of Object.entries(A.readJSON(require('path').join(A.DIR, 'sites.json'), {}) || {})) if (e && e.n > 0) ours.add(k) } catch (e_) { swallow('army_jobs:adoptSites', e_) } // field stash chests (stash/unstash verbs)
    const board = A.readJSON(A.F.board, {}) || {}
    for (const j of board.jobs || []) for (const c of [j.params && j.params.siteChest, j.params && j.params.chest].filter(Array.isArray)) ours.add(K(c))
    // THE OTHER HALF OF A DOUBLE CHEST IS OURS TOO (world 2, 09-20 04:10Z: depot_rows books a merged pair ONCE, so its second half counted as a stray
    // "old-base" chest - the quartermaster drained 1278 items out of our own depot and TOOK CHESTS DOWN: `legacy_chest_removed -364,69,-509`). A
    // container that touches a registered one, or stands inside the footprint of one of our build jobs, is never a stray.
    const near1 = q => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => ours.has((q.x + dx) + ',' + q.y + ',' + (q.z + dz)))
    const boxes = []; for (const j of board.jobs || []) { if (j.type !== 'build' || !j.params || !Array.isArray(j.params.origin)) continue; try { const cs = blueprintCellsOf(j.params); let x1 = 1e9, x2 = -1e9, z1 = 1e9, z2 = -1e9; for (const c of cs) { if (c.x < x1) x1 = c.x; if (c.x > x2) x2 = c.x; if (c.z < z1) z1 = c.z; if (c.z > z2) z2 = c.z } if (cs.length) boxes.push([x1, z1, x2, z2]) } catch (e_) { swallow('army_jobs:adoptBoxes', e_) } }
    const inBuilt = q => boxes.some(b => q.x >= b[0] && q.x <= b[2] && q.z >= b[1] && q.z <= b[3])
    const strays = bot.findBlocks({ matching: ids, maxDistance: 80, count: 600 }).filter(q => q.y >= m.y - 7 && Math.hypot(q.x - m.x, q.z - m.z) <= 70 && !ours.has(q.x + ',' + q.y + ',' + q.z) && !near1(q) && !inBuilt(q))
    if (!strays.length) return 0
    A.boardEdit(b => { const L = b.settings.legacyChests = b.settings.legacyChests || {}; const l = L.found = L.found || []; for (const q of strays) if (!l.some(c => c[0] === q.x && c[1] === q.y && c[2] === q.z)) l.push([q.x, q.y, q.z]) })
    A.result(bot, { ev: 'stray_chests_found', n: strays.length, first: [strays[0].x, strays[0].y, strays[0].z] })
    return strays.length
  } catch (e_) { swallow('army_jobs:adoptStrays', e_); return 0 }
}
async function drainLegacy (bot, job, api) {
  const L = A.settings().legacyChests || {}; const all = []
  for (const l of Object.values(L)) for (const c of l) all.push(v(c))
  if (!all.length || api.stop()) return
  // a chest that would not open is skipped for 30 min — the next one is served instead of reporting "0 items" at the same lid for ever
  const LB = drainLegacy.bad = drainLegacy.bad || {}; const kOf = p => p.x + ',' + p.y + ',' + p.z
  const open_ = all.filter(p => !(LB[kOf(p)] > Date.now())); if (!open_.length) return
  const pos = open_.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
  task(bot, 'old base: emptying ' + pos.x + ',' + pos.y + ',' + pos.z)
  await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop, noKit: true })
  const drop = () => A.boardEdit(b => { for (const k of Object.keys(b.settings.legacyChests || {})) b.settings.legacyChests[k] = b.settings.legacyChests[k].filter(c => !(c[0] === pos.x && c[1] === pos.y && c[2] === pos.z)) })
  if (!await A.travel(bot, pos, { range: 3, ms: 120000, stop: api.stop })) { A.result(bot, { ev: 'legacy_unreachable', at: [pos.x, pos.y, pos.z] }); return }
  const blk = bot.blockAt(pos)
  if (!blk || !/chest|barrel/.test(blk.name)) { drop(); return }
  const got = await A.unstash(bot, pos, { stop: api.stop })
  if (!got) { LB[kOf(pos)] = Date.now() + 30 * 60000; A.result(bot, { ev: 'legacy_open_failed', at: [pos.x, pos.y, pos.z], above: (bot.blockAt(pos.offset(0, 1, 0)) || {}).name }); A.askHelp(bot, 'legacy_open_failed', 'chest at ' + kOf(pos) + ' does not open'); return }
  const n = Object.values(got).reduce((a, b) => a + b, 0)
  if (n === 0) { // empty: take the chest itself home. Chests are PROTECTED blocks: say so explicitly, and believe only the world afterwards
    // (09-19: `legacy_chest_removed` x10 while all ten chests still stood - the dig was refused as 'protected' and nobody looked)
    const r = await lib('blocks').digBlock(bot, pos, { collect: true, requireHarvest: false, allowProtected: true }).catch(e => ({ ok: false, reason: String(e && e.message) }))
    const still = bot.blockAt(pos)
    if (still && /chest|barrel/.test(still.name)) { LB[kOf(pos)] = Date.now() + 10 * 60000; A.result(bot, { ev: 'legacy_remove_failed', at: [pos.x, pos.y, pos.z], why: String(r && r.reason || 'still there').slice(0, 60) }); return }
    drop()
    A.result(bot, { ev: 'legacy_chest_removed', at: [pos.x, pos.y, pos.z], left: all.length - 1 })
  } else A.result(bot, { ev: 'legacy_drained', at: [pos.x, pos.y, pos.z], items: n, left: all.length })
  await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop, noKit: true })
}
// the quartermaster BAKES (3 wheat -> 1 bread at the depot table). Raw fish/meat is cooked by serviceFurnaces: fishers/hunters bank RAW and go straight back to work.
async function cook (bot, job, api) {
  const idx = A.index()
  const stock = n => Object.values(idx).reduce((s, v) => s + ((v.items && v.items[n]) || 0), 0)
  if (stock('wheat') + A.count(bot, 'wheat') >= 3) { // BREAD: 3 wheat -> 1 bread (5 food points), no fuel needed
    task(bot, 'baking bread')
    if (A.count(bot, 'wheat') < 3) await A.withdraw(bot, 'wheat', 63, { stop: api.stop })
    const n = Math.floor(A.count(bot, 'wheat') / 3)
    if (n > 0) { const tb = A.chestsOf('tools')[0]; if (tb) await A.travel(bot, tb, { range: 4, ms: 60000, stop: api.stop }); const before = A.count(bot, 'bread'); await VERBS.craft(bot, { item: 'bread', n, silent: true }, api); await sleep(500); const made = A.count(bot, 'bread') - before; await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop, noKit: true }); A.result(bot, { ev: 'cooked', job: job.id, raw: 'wheat->bread', n: made }); if (made > 0) return true }
  }
  return false // raw food is cooked by serviceFurnaces (load and leave) — nobody waits at a furnace
}

// ------------------------------------------------------------------ delegate: run an existing VERIFIED role skill under the worker
// (iron_miner, builder ...). The worker pre-empts it through bot.state.cancel when the job changes.
async function delegate (bot, job, api, ctx) {
  const P = job.params || {}
  if (!/^[a-z0-9_]+$/i.test(P.skill || '')) return 'delegate: bad skill'
  if (isNight(api) && P.dayOnly) return muster(bot, job, api, ctx, P.skill + ': night')
  // nobody goes down a mine starving (09-19: 4 miners at hp1/food0 kept descending while 168 bread sat in stock): eat first (the wrapper's canteen
  // fetched a ration if it could); still nothing to eat -> take a ration along or hand the bot back
  if (bot.food <= 6 && lib('feed').edibleCount(bot, true) === 0) { A.result(bot, { ev: 'starving_no_descent', job: job.id, food: bot.food, hp: Math.round(bot.health) }); A.decline(bot, job, 300000, 'starving and no food reachable'); return 'delegate: starving' }
  if (lib('feed').edibleCount(bot, false) < 4 && !underground(bot)) { const ration = foodStock(bot, false)[0]; if (ration && A.stockOf(ration) >= 16) await A.withdraw(bot, ration, 8, { stop: api.stop }) } // whatever the depot cooks, not "bread"
  // same task string the manager sets for POST /skill: role skills treat any other task as "someone else took this bot" and exit
  if (bot.state) bot.state.task = 'skill:' + P.skill
  // hot-load the delegate and its private libs too (the worker only refreshes the army libs), so a fix reaches the field at the next slice
  for (const k of Object.keys(require.cache)) if (/\/skills\/iron_miner\.js$|\/skills\/lib\/iron_core\.js$/.test(k)) delete require.cache[k]
  const fn = require('../' + P.skill + '.js')
  let done = false
  const run = Promise.resolve().then(() => fn(bot, P.args || {}, ctx)).catch(e => 'ERR ' + String(e && e.message || e).slice(0, 120)).then(r => { done = true; return r })
  while (!done) {
    await sleep(2000)
    if (api.stop() || (isNight(api) && P.dayOnly)) {
      bot.__armyPreempt = true
      bot.state.cancel = true
      await Promise.race([run, sleep(45000)])
      bot.state.cancel = false
      bot.__armyPreempt = false
      break
    }
  }
  try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { swallow('army_jobs:330', e_) }
  // taken off the mine while underground: walk out by the stairs (the skill knows its own way), so the next job does not start by
  // wandering tunnels and caves looking for the sky. The budget is scaled to the stair length (140 steps to y-54 -> ~15 min worst case, ~2 min when
  // the stairs are free); the recall ignores the stop flag on purpose. A timed-out recall is made stale (gen bump) so it never fights the next job.
  const leaving = !api._a || !api._a.job || api._a.job.id !== job.id // only a bot that really leaves the mine is walked out (a rev bump keeps it below)
  // the walk out and the bank run take minutes and nobody polls api.stop() meanwhile: keep the heartbeat alive, or the dispatcher counts the bot as offline
  const hbTimer = setInterval(() => { try { A.heartbeat(bot, { job: job.id }) } catch (e_) { swallow('army_jobs:delegateHb', e_) } }, 20000)
  if (hbTimer.unref) hbTimer.unref()
  if (leaving && P.skill === 'iron_miner' && bot.entity && bot.entity.position.y < (A.surfaceFloor(bot) || 58)) {
    bot.state.cancel = false
    const nSteps = ((A.readJSON(require('path').join(A.DIR, '..', 'iron_mine.json'), {}) || {}).steps || []).length
    try { const out = await U.withTimeout(fn(bot, { job: 'surface', chain: false }, ctx), Math.max(360000, 300000 + nSteps * 4500), 'surface'); A.result(bot, { ev: 'recalled', job: job.id, out }) } catch (e) { bot.__ironGen = (bot.__ironGen || 0) + 1; A.result(bot, { ev: 'recall_failed', job: job.id, err: String(e && e.message || e).slice(0, 80), pos: bot.entity ? [Math.round(bot.entity.position.x), Math.round(bot.entity.position.y), Math.round(bot.entity.position.z)] : null, steps: nSteps }) }
    try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { swallow('army_jobs:337', e_) }
  }
  A.strictMovements(bot)
  // whatever the delegate left in the pockets belongs in the depot (raw iron, ingots, coal …) - when the bot LEAVES the job. A miner that stays (slice end,
  // rev bump) keeps its kit: this bank took the spare pickaxes and sticks of a miner standing at the depot, and its own base visit banks the ore anyway.
  if (leaving && bot.entity && bot.entity.position.y >= (A.surfaceFloor(bot) || 58)) { try { await A.bank(bot, { torch: 16, cobblestone: 32, stick: 8, crafting_table: 1, coal: 8, ...rationsOf(bot) }, { job: job.id }) } catch (e_) { swallow('army_jobs:341', e_) } }
  clearInterval(hbTimer)
  const r = await Promise.race([run, sleep(100).then(() => 'pre-empted')])
  return 'delegate ' + P.skill + ': ' + (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 100)
}

// ------------------------------------------------------------------ land survey: use the WORLD. The point (owner): don't fight a frozen, animal-less biome -
// find land that is kind (liquid water, flat grass, animals, trees, a temperate climate) and settle THERE. Samples -> bots/army/scout.jsonl -> `armyctl.js sites`.
const FARM_ANIMALS = ['sheep', 'cow', 'pig', 'chicken', 'rabbit', 'horse', 'donkey', 'mooshroom']
// BIOME OF A BLOCK -> {name, temp}. `block.biome.name` is EMPTY on 1.20.5+ servers (prismarine-biome keeps the static table it saw at load time, the
// server's registry replaces it afterwards), so the name is looked up by ID in the live registry (object by id, then the array). temp = the climate class
// a BASE is chosen by (world 1 sat in snowy taiga: frozen water, no animals, no crops): the NAME decides first (version-proof), the numbers second.
function biomeOf (bot, block) {
  const reg = bot.registry || {}; const raw = block && block.biome; const id = raw && raw.id
  let bi = (id != null && reg.biomes && reg.biomes[id]) || null
  if ((!bi || !bi.name) && id != null && Array.isArray(reg.biomesArray)) bi = reg.biomesArray.find(q => q && q.id === id) || bi
  const name = String((raw && raw.name) || (bi && bi.name) || '').replace(/^minecraft:/, '') || null
  if (!name) return { name: null, temp: null }
  const t = bi && typeof bi.temperature === 'number' ? bi.temperature : null; const rain = bi ? (bi.has_precipitation != null ? bi.has_precipitation : bi.rainfall != null ? bi.rainfall > 0 : null) : null
  const temp = /snowy|frozen|ice_spikes|^grove$|jagged_peaks/.test(name) ? 'cold'
    : /desert|badlands|savanna/.test(name) ? 'dry'
      : /jungle|swamp|mangrove|warm_ocean|mushroom/.test(name) ? 'warm'
        : t == null ? 'temperate' : t < 0.2 ? 'cold' : (rain === false && t >= 1.5) ? 'dry' : t >= 0.9 ? 'warm' : 'temperate'
  return { name, temp }
}
// ONE SAMPLE OF LAND (one JSON line in scout.jsonl - the CONTRACT with `armyctl.js sites`, which ranks BASE sites from these):
// pos, biome, ground, relief, flat (share of the 17x17 columns around the feet whose ground is within +-1 of the feet: 1 = a pad for free),
// water, ice, tree (ANY log), cane, crops, village, animals, temp (cold|temperate|warm|dry), score (this file's own rough base-site score).
function sampleLand (bot) {
  const p = bot.entity.position.floored()
  const reg = bot.registry
  const ground = bot.blockAt(p.offset(0, -1, 0))
  const topY = (x, z) => { for (let y = p.y + 6; y >= p.y - 8; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.boundingBox === 'block' && !/leaves|_log$|_stem$/.test(b.name)) return y } return null }
  const ys = []
  for (const [dx, dz] of [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, 4], [4, -4], [-4, -4]]) { const y = topY(p.x + dx, p.z + dz); if (y != null) ys.push(y) }
  let cols = 0; let level = 0
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) { cols++; const y = topY(p.x + dx, p.z + dz); const w = y != null && bot.blockAt(new Vec3(p.x + dx, y + 1, p.z + dz)); if (y != null && Math.abs(y - (p.y - 1)) <= 1 && !(w && /^(water|lava)$/.test(w.name))) level++ } // a lake bed is not building ground
  const near = (names, r) => { const ids = names.map(n => reg.blocksByName[n] && reg.blocksByName[n].id).filter(x => x != null); const f = ids.length ? bot.findBlocks({ matching: ids, maxDistance: r, count: 1 }) : []; return f.length ? [f[0].x, f[0].y, f[0].z] : null }
  const animals = {}
  for (const e of Object.values(bot.entities)) if (e && e.position && FARM_ANIMALS.includes(e.name) && e.position.distanceTo(bot.entity.position) < 40) animals[e.name] = (animals[e.name] || 0) + 1
  const bi = biomeOf(bot, ground)
  const LOGS = sampleLand.logs = sampleLand.logs || Object.keys(reg.blocksByName).filter(n => /^(?!stripped_).*(_log|_stem)$/.test(n)) // whatever trees this version has - never a species list
  const s = {
    pos: [p.x, p.y, p.z], biome: bi.name, ground: ground && ground.name, relief: ys.length ? Math.max(...ys) - Math.min(...ys) : null, flat: Math.round(level / cols * 100) / 100,
    water: near(['water'], 20), ice: !!near(['ice'], 12), tree: !!near(LOGS, 16), cane: near(['sugar_cane'], 24),
    crops: near(['wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush', 'pumpkin', 'melon'], 24), village: near(['bell', 'composter', 'hay_block'], 32), animals, temp: bi.temp
  }
  // rough BASE-site score (the ranking that counts is `armyctl.js sites`): liquid water, a flat pad, a kind climate, trees, animals, cane, a village
  let score = 0
  if (s.water && !s.ice) score += 4; else if (s.water) score += 1
  if (/grass_block|dirt|podzol/.test(s.ground || '')) score += 2
  score += Math.round(s.flat * 4)
  if (s.temp === 'temperate' || s.temp === 'warm') score += 3; else if (s.temp === 'cold') score -= 4
  if (bi.name && /ocean|river|beach|shore/.test(bi.name)) score -= 2
  score += Math.min(3, Object.values(animals).reduce((a, b) => a + b, 0))
  if (s.tree) score += 1
  if (s.cane) score += 1
  if (s.village) score += 4
  s.score = score
  return s
}
// ------------------------------------------------------------------ scout: LONG-RANGE land survey for the BASE site (owner on world 1's 600-block radius: "that is no
// exploration" - climate zones are thousands of blocks wide, and world 1's base ended up in snowy taiga 42 blocks from spawn).
// params: bearings:[0,45,…315] degrees (0 = north; default all 8), range: 3000 blocks from home, budgetMin: 30 (minutes OUT; the way home is the same again),
//         step: 36, dayOnly:false (true = world 1's daylight budget), repeat:true (next trip 25 degrees further round; false = one trip per rev).
// A squad needs no names: a scout's bearing = its rank among the bots that hold this job right now (assign/), so 8 scouts cover 8 bearings.
// READ-ONLY movement (A.travel hops; a blocked bearing swerves, 4 blocks in a row = turn home), BREADCRUMBS home (the way we came is known to be walkable;
// lost after a restart -> straight to home), home = settings.muster (else where the trip began). FOOD AWARE: takes rations when the depot has any, eats on
// the march, hunts what it meets when the pockets are empty (a new world has no bread), turns home when hungry with nothing to eat or hurt.
// Every hop writes one `sampleLand` line to scout.jsonl as it walks - a lost scout has reported everything up to its death (`scout_lost` marks the hazard).
function scoutRank (bot, job) {
  if (Array.isArray(job.names) && job.names.includes(bot.username)) return job.names.indexOf(bot.username)
  try {
    const fs = require('fs'); const dir = require('path').join(A.DIR, 'assign'); const mates = []
    for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.json')) continue; const a = A.readJSON(require('path').join(dir, f), null); if (a && a.job && a.job.id === job.id && Date.now() - (a.t || 0) < 180000) mates.push(f.slice(0, -5)) }
    if (!mates.includes(bot.username)) mates.push(bot.username)
    return mates.sort().indexOf(bot.username)
  } catch (e_) { swallow('army_jobs:scoutRank', e_); return Math.max(0, (A.settings().roster || []).indexOf(bot.username)) }
}
async function scout (bot, job, api, ctx) {
  const P = job.params || {}
  const S = A.settings()
  const bearings = Array.isArray(P.bearings) && P.bearings.length ? P.bearings : [0, 45, 90, 135, 180, 225, 270, 315]
  const dusk = S.dusk || 11800
  const st = bot.__armyScout = (bot.__armyScout && bot.__armyScout.job === job.id && bot.__armyScout.rev === (job.rev || 0)) ? bot.__armyScout : { job: job.id, rev: job.rev || 0, phase: 'idle', crumbs: [], turn: 0 }
  const file = require('path').join(A.DIR, 'scout.jsonl')
  const deg = () => Math.round((((st.bearing || 0) * 180 / Math.PI) % 360 + 360) % 360)
  const edible = () => lib('feed').edibleCount(bot, true)
  // died on this trip: do NOT march back out on the same bearing into the same danger. Record the place; the next trip goes 25 degrees further round.
  if (st.phase !== 'idle' && st.phase !== 'done' && (bot.__armyDeaths || 0) > (st.deaths0 || 0)) {
    const at = (st.crumbs && st.crumbs.length) ? st.crumbs[st.crumbs.length - 1] : null
    try { require('fs').appendFileSync(file, JSON.stringify({ t: Date.now(), bot: bot.username, pos: at, hazard: 'scout died near here', score: -5, biome: null, ground: null, relief: null, flat: null, water: null, animals: {}, temp: null }) + '\n') } catch (e_) { swallow('army_jobs:393', e_) }
    A.result(bot, { ev: 'scout_lost', job: job.id, near: at, bearing: deg() })
    st.phase = 'done'
  }
  if (st.phase === 'idle') {
    const budgetMs = P.dayOnly && !S.nightSkip ? ((dusk - api.time()) * 50) * 0.4 - 40000 : (P.budgetMin || 30) * 60000 // dayOnly: 40 % of the remaining daylight is the way OUT (the way home is slower: detours, hunger)
    if (P.dayOnly && (isNight(api) || budgetMs < 90000)) return muster(bot, job, api, ctx, 'scout: not enough daylight left')
    if (bot.food < 14 || bot.health < 14) { try { await lib('feed').eat(bot, { rawOk: true }) } catch (e_) { swallow('army_jobs:scoutEat0', e_) } }
    if ((bot.food < 10 && !edible()) || bot.health < 10) return muster(bot, job, api, ctx, 'scout: not fit')
    const keep = { torch: 16 }; for (const i of bot.inventory.items()) if (bot.registry.foodsByName[i.name]) keep[i.name] = 64
    await A.bank(bot, keep, { job: job.id, stop: api.stop }) // travel light: keep_inventory is OFF
    if (edible() < 12) { const ration = foodStock(bot, false)[0]; if (ration && A.stockOf(ration) >= 16) await A.withdraw(bot, ration, 16, { stop: api.stop }) } // rations for a long march - whatever the depot cooks, not "bread"
    const m = A.musterPos(); const here = bot.entity.position.floored()
    st.idx = scoutRank(bot, job); st.bearing = ((bearings[st.idx % bearings.length] + (st.turn || 0) * 25 + Math.floor(st.idx / bearings.length) * 22) * Math.PI) / 180 // a 9th scout walks between two bearings, not behind the 1st
    st.phase = 'out'; st.deaths0 = bot.__armyDeaths || 0; st.turnAt = Date.now() + budgetMs; st.home = m && Number.isFinite(m.x) ? { x: m.x, y: m.y, z: m.z } : { x: here.x, y: here.y, z: here.z }; st.crumbs = []; st.best = null; st.t0 = Date.now(); st.far = 0
    A.result(bot, { ev: 'scout_depart', job: job.id, bearing: deg(), budgetS: Math.round(budgetMs / 1000), range: P.range || 3000, rations: edible() })
  }
  if (st.phase === 'out') {
    task(bot, 'scout:out ' + deg() + 'deg')
    const range = P.range || 3000; const step = Math.min(64, P.step || 36) // A.travel hops by itself; 64 = one sample per 4 chunks
    let swerve = 0; let blocked = 0; let why = 'time'
    while (!api.stop() && Date.now() < st.turnAt) {
      const p = bot.entity.position
      st.far = Math.max(st.far || 0, Math.round(Math.hypot(p.x - st.home.x, p.z - st.home.z)))
      if (Math.hypot(p.x - st.home.x, p.z - st.home.z) >= range) { why = 'range'; break }
      if (blocked >= 4) { why = 'blocked (water/cliff on every side)'; break }
      if (bot.health < 8 || (bot.food <= 8 && !edible())) { why = bot.health < 8 ? 'hurt' : 'hungry, nothing to eat'; break }
      const a = st.bearing + swerve
      const ok = await A.travel(bot, { x: Math.round(p.x + Math.sin(a) * step), y: null, z: Math.round(p.z - Math.cos(a) * step) }, { range: 6, ms: 60000, stop: () => api.stop() || Date.now() > st.turnAt })
      if (!ok && bot.entity.position.distanceTo(p) < 8) { blocked++; swerve = (blocked % 2 ? 1 : -1) * blocked * 0.6; continue } // cliff/water ahead: go around, never through
      blocked = 0; swerve = 0
      try { await lib('feed').eat(bot, { rawOk: bot.food <= 8 }) } catch (e_) { swallow('army_jobs:416', e_) }
      if (edible() < 4) { const prey = preyNear(bot, 20)[0]; if (prey && bot.health >= 10) { task(bot, 'scout: hunting rations'); if (await A.kill(bot, prey, 20000, api.stop)) await A.pickup(bot, 7, 4000); task(bot, 'scout:out ' + deg() + 'deg') } } // a new world has no depot food: the march feeds itself
      const q = bot.entity.position.floored()
      st.crumbs.push([q.x, q.y, q.z])
      try { const s = sampleLand(bot); s.t = Date.now(); s.bot = bot.username; require('fs').appendFileSync(file, JSON.stringify(s) + '\n'); if (!st.best || s.score > st.best.score) st.best = s } catch (e_) { swallow('army_jobs:419', e_) }
    }
    if (api.stop()) return 'stopped'
    A.result(bot, { ev: 'scout_turn', job: job.id, bearing: deg(), far: st.far, why, samples: st.crumbs.length })
    st.phase = 'home'
  }
  if (st.phase === 'home') {
    task(bot, 'scout:home')
    while (st.crumbs.length && !api.stop()) { // the way we came is known to be walkable
      const c = st.crumbs[st.crumbs.length - 1]
      await A.travel(bot, { x: c[0], y: c[1], z: c[2] }, { range: 6, ms: 60000, stop: api.stop })
      st.crumbs.pop()
      try { await lib('feed').eat(bot, { rawOk: bot.food <= 8 }) } catch (e_) { swallow('army_jobs:scoutEatHome', e_) }
    }
    if (api.stop()) return 'stopped'
    const home = A.musterPos() ? musterSlot(bot) : st.home
    const back = await A.travel(bot, { x: home.x, y: null, z: home.z }, { range: 3, ms: 180000 + 400 * Math.round(A.dist2(bot, home.x, home.z)), stop: api.stop })
    if (api.stop()) return 'stopped'
    A.result(bot, { ev: 'scout_trip', job: job.id, mins: Math.round((Date.now() - st.t0) / 60000), bearing: deg(), far: st.far, home: !!back, best: st.best })
    st.phase = 'done'
  }
  if (P.repeat !== false) { st.phase = 'idle'; st.turn = (st.turn || 0) + 1; return 'scout: next trip' } // no standby: go again, 25 degrees further round
  return muster(bot, job, api, ctx, 'scout: trip done (next trip: bump job.rev)')
}

// ------------------------------------------------------------------ depot: set up category chests on SOUND ground and make them the army's storage.
// Doctrine 3: choose the land, don't fight it.
// params.chests = {food:[[x,y,z],…], tools:[…], …}. Places what is missing (chests from stock via the index), then PREPENDS the
// positions to settings.chests (new deposits go there first; old chests stay indexed and get drained by use) and pauses itself.
async function depot (bot, job, api, ctx) {
  const BL = lib('blocks')
  const P = job.params || {}
  const all = []
  for (const [cat, list] of Object.entries(P.chests || {})) for (const c of list) all.push({ cat, pos: v(c) })
  if (!all.length) return muster(bot, job, api, ctx, 'depot: no chests in params')
  task(bot, 'depot: build')
  const first = all[0].pos
  if (!await A.travel(bot, first, { range: 4, ms: 180000, stop: api.stop })) return 'depot: cannot reach site'
  const isChest = p => { const b = bot.blockAt(p); return !!b && b.name === 'chest' }
  const missing = () => all.filter(c => !isChest(c.pos))
  if (missing().length > A.count(bot, 'chest')) {
    await A.withdraw(bot, 'chest', missing().length - A.count(bot, 'chest'), { stop: api.stop })
    if (!A.count(bot, 'chest')) return muster(bot, job, api, ctx, 'depot: no chests in stock (craft: 8 planks each)')
    if (!await A.travel(bot, first, { range: 4, ms: 180000, stop: api.stop })) return 'depot: cannot reach site'
  }
  for (const c of missing()) {
    if (api.stop() || !A.count(bot, 'chest')) break
    const r = await BL.placeBlock(bot, c.pos, 'chest', {}).catch(e => ({ ok: false, reason: String(e && e.message || e) }))
    A.result(bot, { ev: 'depot_place', cat: c.cat, at: [c.pos.x, c.pos.y, c.pos.z], ok: !!r.ok, reason: r.reason })
    await sleep(300)
  }
  if (missing().length) return 'depot: ' + missing().length + ' chests still missing'
  const board = A.readJSON(A.F.board, null)
  if (board && board.settings) {
    const ch = board.settings.chests = board.settings.chests || {}
    for (const c of all) {
      const key = [c.pos.x, c.pos.y, c.pos.z]
      ch[c.cat] = [key].concat((ch[c.cat] || []).filter(q => !(q[0] === key[0] && q[1] === key[1] && q[2] === key[2])))
    }
    for (const cat of Object.keys(P.chests)) ch[cat] = P.chests[cat].concat((ch[cat] || []).filter(q => !P.chests[cat].some(n => n[0] === q[0] && n[1] === q[1] && n[2] === q[2])))
    const me = (board.jobs || []).find(j => j.id === job.id); if (me) me.status = 'paused'
    require('fs').writeFileSync(A.F.board + '.tmp_depot', JSON.stringify(board, null, 1)); require('fs').renameSync(A.F.board + '.tmp_depot', A.F.board)
  }
  A.result(bot, { ev: 'depot_ready', job: job.id, chests: all.length })
  return 'depot ready'
}

// ------------------------------------------------------------------ steps: the GENERAL interface between an LLM operator and the bots.
// Pure algorithms cannot play Minecraft; pure LLM puppeteering costs a fortune. So: the LLM THINKS (what, where, in which order, reading
// the field) and writes a short plan of verified verbs; the bots EXECUTE it with reflexes (eat, defend, read-only travel) running underneath.
// No new code for a new situation — a new plan. Every step reports; a failed step stops the plan and says why, so the LLM can re-plan.
//   params.steps = [ {do:'withdraw', item:'chest', n:5}, {do:'goto', to:[x,y,z], range:3}, {do:'place', block:'chest', at:[x,y,z]}, … ]
//   params.repeat = true  -> start over after the last step (production loops);  params.onFail = 'continue' -> don't stop on a failed step
// Verbs (all bounded, all cancel-aware):
//   goto {to:[x,y,z]|[x,null,z], range, via}        bank {keep:{item:n}}            withdraw {item, n}
//   stash {at:[x,y,z], keep:{item:n}} / unstash {at}   put into / empty a SITE chest (work-site storage outside the base index)
//   place {block, at:[x,y,z]} | {block, cells:[[x,y,z],…]}     dig {at} | {cells}  (explicit cells only — never "dig to get there")
//   collect {block:'name'|[names], n, radius}       mine/harvest exposed blocks nearby and pick up the drops
//   fell {near:[x,y,z], radius, replant:false}      whole tree + replant (replant:false when CLEARING a field/building site)
//   craft {item, n}                                 uses a table within 12 blocks or places the carried one and picks it up again
//   smelt {item, n}                                 base furnaces, fuel from inventory (withdraw coal first)
//   fill {at: water block} / pour {at: empty cell}  bucket work (2x2 pool = infinite water). NOT for fields: a field's water cells belong to its
//        blueprint (`field_block`) and are made by the `build` job - `pour` refuses cells inside a farm job's box
//   shear {n, radius}                               wool without killing sheep (needs shears)
//   kill {kinds:[…], n, radius}   pickup {radius}   till {at:[x,y,z], seed}   equip {item}   eat   sleep   wait {s}   say {text}
//   sample                                          land sample of the current spot into scout.jsonl (see `scout`)
const VERBS = {
  async goto (bot, st, api) { const t = st.to; return await A.travel(bot, { x: t[0], y: t[1], z: t[2] }, { range: st.range == null ? 2 : st.range, ms: (st.s || 300) * 1000, stop: api.stop, via: st.via }) || 'no route' },
  // bank REPORTS WHAT IT VERIFIED (foreman 09-19 19:34Z: `bank ok:true` with 12 wooden_sword + 56 stick still in the pockets - settings.chests was {} then, A.bank
  // had nowhere to go and the verb said true regardless). ok = everything beyond `keep` (and one tool of a kind / armour) LEFT THE POCKETS; else the reason.
  async bank (bot, st, api, job) {
    const keep = st.keep || { torch: 16 }
    const m = await A.bank(bot, keep, { job: job.id, stop: api.stop }); const n = Object.values(m || {}).reduce((a, b) => a + b, 0)
    const left = {}; for (const [name, c] of Object.entries(A.inv(bot))) { const x = c - (keep[name] || 0) - (/_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|^shield$/.test(name) ? 1 : 0); if (x > 0) left[name] = x }
    if (!Object.keys(left).length) return true
    const cats = [...new Set(Object.keys(left).map(k => A.categoryOf(bot, k)))]; const none = cats.filter(c => !A.chestsOf(c).length)
    return (n ? 'only ' + n + ' items deposited' : 'NOTHING deposited') + ', still carrying ' + JSON.stringify(left).slice(0, 120) + ' - ' + (none.length ? 'no chest registered for ' + none.join('/') + ' (armyctl.js chest add <cat> x,y,z)' : 'chests of ' + cats.join('/') + ' full or unreachable (see chest_full / bank_unreachable)')
  },
  async stash (bot, st, api) { const m = await A.stash(bot, v(st.at), st.keep || {}, { stop: api.stop }); return !!m || 'no chest at ' + st.at },
  async unstash (bot, st, api) { const m = await A.unstash(bot, v(st.at), { stop: api.stop }); return !!m || 'no chest at ' + st.at },
  async withdraw (bot, st, api) { const want = st.n || 1; const n = await A.withdraw(bot, st.item, want, { stop: api.stop }); return n >= want || (st.atLeast && n >= st.atLeast) || (n > 0 ? 'only ' + n + '/' + want + ' ' + st.item + ' (stock ' + A.stockOf(st.item) + '); add atLeast:<k> to accept fewer' : 'none of ' + st.item + ' in the chest index') }, // ok only with the full amount: a craft step after a short withdraw fails with a misleading "ingredients ran out"
  async place (bot, st, api) {
    const BL = lib('blocks'); let bad = 0; let last = null
    for (const c of (st.cells || [st.at])) { if (api.stop()) break; const r = await A.placeHard(bot, v(c), st.block, { stop: api.stop }); if (!r.ok && !r.already) { bad++; last = r.reason + (r.remedies && r.remedies.length ? ' (tried: ' + r.remedies.join(', ') + ')' : '') } }
    // A CHEST A PLAN PLACES IS A DEPOT CHEST ONLY WHEN THE BOARD KNOWS IT (09-19 19:34Z: depot_first placed -338,69,-460, settings.chests stayed {} and nobody could bank):
    // step field cat:'tools' | ['food','build'] registers it; with NO chest registered at all the first one becomes the depot of every category.
    if (/^(chest|barrel)$/.test(st.block)) try {
      const stand = (st.cells || [st.at]).map(v).filter(q => (bot.blockAt(q) || {}).name === st.block)
      const noDepot = !A.CATS.some(c => A.chestsOf(c).length); const cats = st.cat ? [].concat(st.cat).filter(c => A.CATS.includes(c)) : noDepot ? A.CATS.slice() : []
      if (stand.length && cats.length) { let added = 0; A.boardEdit(b => { const S = b.settings = b.settings || {}; S.chests = S.chests || {}; for (const c of cats) { const l = S.chests[c] = S.chests[c] || []; for (const q of stand) if (!l.some(e => e[0] === q.x && e[1] === q.y && e[2] === q.z)) { l.push([q.x, q.y, q.z]); added++ } } }); if (added) A.result(bot, { ev: 'furniture_registered', by: 'place', cats, at: stand.map(q => [q.x, q.y, q.z]) }) }
    } catch (e_) { swallow('army_jobs:placeRegister', e_) }
    return bad === 0 || (bad + ' cells failed: ' + last)
  },
  async dig (bot, st, api) {
    const BL = lib('blocks'); let bad = 0; let last = null
    for (const c of (st.cells || [st.at])) { if (api.stop()) break
      // NEVER BREAK A CONTAINER THAT STILL HOLDS SOMETHING (14:4xZ strike: bots with full pockets broke 30 chests -> the contents spilled and
      // despawned; "33 chests recovered" was true and worthless). force:true on a chest/barrel first looks inside; not empty = the step fails.
      { const cb = bot.blockAt(v(c)); if (st.force && cb && /^(chest|trapped_chest|barrel)$/.test(cb.name)) { const w = await A.openChest(bot, v(c), { stop: api.stop }).catch(() => null); const left = w ? w.containerItems().reduce((n, i) => n + i.count, 0) : -1; if (w) { A.closeWin(w); await sleep(200) } if (left !== 0) { bad++; last = left < 0 ? 'container would not open - not broken' : 'container still holds ' + left + ' items - empty it first (unstash, several trips), not broken'; continue } } }
      const r = await BL.digBlock(bot, v(c), { collect: true, allowProtected: !!st.force, own: st.force ? true : undefined, requireHarvest: false }); if (!r.ok) { bad++; last = r.reason } } // force:true = a protected block (bed, chest ...) on purpose
    return bad === 0 || (bad + ' cells failed: ' + last)
  },
  async collect (bot, st, api) {
    const names = Array.isArray(st.block) ? st.block : [st.block]; const want = st.n || 8; let got = 0; let dry = 0
    while (got < want && dry < 3 && !api.stop()) {
      const found = U.findBlocksByName(bot, names, Math.min(st.radius || 24, 48), 12).filter(p => !U.isBad || !U.isBad(bot, p.x + ',' + p.y + ',' + p.z))
      if (!found.length) { dry++; await sleep(1500); continue }
      const ok = await U.mineAt(bot, found[0], 45000).catch(() => false)
      if (ok) { got++; dry = 0 } else dry++
    }
    return got > 0 || 'nothing collected'
  },
  async fell (bot, st, api) { // nearest tree FIRST, but never the same unreachable trunk twice (52 identical failures in 20 min on 09-19)
    const BL = lib('blocks'); const ids = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name)).map(b => b.id)
    if (st.near && A.dist2(bot, st.near[0], st.near[2]) > (st.radius || 32)) { if (!await A.travel(bot, { x: st.near[0], y: null, z: st.near[2] }, { range: 8, ms: 240000, stop: api.stop, noRelax: true })) return 'cannot reach the felling area ' + st.near }
    const bad = bot.__armyBadTrees = bot.__armyBadTrees || {}
    const all = bot.findBlocks({ matching: ids, maxDistance: Math.min(st.radius || 32, 48), count: 300 })
      .filter(q => { const u = bot.blockAt(q.offset(0, -1, 0)); return u && !/_log$/.test(u.name) && !bad[q.x + ',' + q.y + ',' + q.z] && (!st.box || (q.x >= st.box[0] && q.x <= st.box[2] && q.z >= st.box[1] && q.z <= st.box[3])) }) // st.box [x1,z1,x2,z2]: the lumber job's plantation - fell looks around the BOT, which may stand at the edge
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    // ROOTED trunks (standing on soil) are felled normally. A log with AIR under it is a crown somebody left hanging (live test 09-19: the
    // "nearest trunk" was a floating log at y96) — those are taken from a scaffold pillar built right under them, and the pillar is removed.
    const rooted = all.filter(q => /dirt|grass|podzol|mycelium|moss|farmland|snow_block|stone/.test((bot.blockAt(q.offset(0, -1, 0)) || {}).name || ''))
    const hanging = all.filter(q => !rooted.includes(q))
    // spruce carries leaves down to the ground: the trunk has NO free cell beside it, so "unreachable" (live test: 8 ms). A player just cuts
    // his way in — clear the leaves between us and the trunk at feet/head height, step closer, repeat, then fell.
    const cutIn = async (q) => {
      await A.travel(bot, { x: q.x, y: null, z: q.z }, { range: 5, ms: 60000, stop: api.stop, noRelax: true, quiet: true })
      for (let k = 0; k < 10 && !api.stop(); k++) {
        const me = bot.entity.position; const to = new Vec3(q.x + 0.5, me.y, q.z + 0.5); const d = to.minus(me); const len = Math.hypot(d.x, d.z); if (len < 1.6) return true
        let cut = 0
        for (let t = 1; t <= Math.min(4, Math.ceil(len)); t++) for (const dy of [0, 1, 2]) { const c = new Vec3(Math.floor(me.x + d.x / len * t), Math.floor(me.y) + dy, Math.floor(me.z + d.z / len * t)); const b = bot.blockAt(c); if (b && /_leaves$/.test(b.name) && b.position.distanceTo(me) < 4.8) { const r = await BL.digBlock(bot, c, { collect: false, requireHarvest: false }).catch(() => ({ ok: false })); if (r.ok) cut++ } }
        const moved = await A.travel(bot, { x: q.x, y: null, z: q.z }, { range: 1, ms: 8000, stop: api.stop, noRelax: true, quiet: true })
        if (moved) return true
        if (!cut) return false
      }
      return false
    }
    for (const q of rooted.slice(0, 4)) {
      if (api.stop()) break
      const crown = crownRule() // finish the tree: over our pads / fields / footprints no leaf clump is left hanging (blocks.js harvestTree)
      let r = await BL.harvestTree(bot, q, { replant: st.replant !== false, crown }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (!r.ok && !(r.logs > 0) && r.reason === 'unreachable' && await cutIn(q)) r = await BL.harvestTree(bot, q, { replant: st.replant !== false, crown }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (r.ok || r.logs > 0) return true
      bad[q.x + ',' + q.y + ',' + q.z] = 1
    }
    for (const q of hanging.slice(0, 2)) {
      if (api.stop()) break
      let gy = null; for (let y = q.y - 1; y >= q.y - 24; y--) { const b = bot.blockAt(new Vec3(q.x, y, q.z)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) { gy = y; break } }
      if (gy == null) { bad[q.x + ',' + q.y + ',' + q.z] = 1; continue }
      task(bot, 'fell: hanging crown')
      if (!await A.travel(bot, { x: q.x, y: gy + 1, z: q.z }, { range: 0, ms: 60000, stop: api.stop, noRelax: true, quiet: true })) { bad[q.x + ',' + q.y + ',' + q.z] = 1; continue }
      if (A.count(bot, 'dirt') + A.count(bot, 'cobblestone') < q.y - gy) await A.obtain(bot, 'cobblestone', 16, { stop: api.stop })
      const need = Math.max(0, q.y - Math.floor(bot.entity.position.y) - 3)
      if (need) await BL.pillarUp(bot, Math.min(need, 16), {}).catch(e_ => swallow('army_jobs:fellUp', e_))
      let got = 0
      for (let y = q.y; y <= q.y + 8; y++) { const b = bot.blockAt(new Vec3(q.x, y, q.z)); if (!b || !/_log$/.test(b.name)) break; const r = await BL.digBlock(bot, b.position, { collect: true, requireHarvest: false }).catch(() => ({ ok: false })); if (!r.ok) break; got++ }
      await BL.removeScaffold(bot).catch(e_ => swallow('army_jobs:fellDown', e_))
      await A.pickup(bot, 6, 3000)
      if (got) { A.result(bot, { ev: 'crown_felled', at: [q.x, q.y, q.z], logs: got }); return true }
      bad[q.x + ',' + q.y + ',' + q.z] = 1
    }
    return all.length ? 'trees here are unreachable (' + all.length + ' trunks tried/blacklisted)' : 'no tree within ' + (st.radius || 32)
  },
  async craft (bot, st, api, job) { // always via a table (2x2 inventory crafting hangs on this server); ONE recipe run at a time, counted, so a short batch is reported honestly
    const C = lib('craft')
    // GENERIC names (planks, slab, fence, fence_gate, door, boat, bed, log …) = "of whatever wood/wool we carry": a plan never names a species
    if (!bot.registry.itemsByName[st.item]) { const real = C.resolve(bot.registry, st.item, A.inv(bot)); if (!bot.registry.itemsByName[real]) return 'unknown item ' + st.item; st = Object.assign({}, st, { item: real }) }
    const tbl = await C.table(bot)
    if (!tbl) return 'no crafting table within 12 blocks and none carried'
    const want = st.n || 1; let runs = 0; const had = A.count(bot, st.item)
    try {
      for (; runs < want && !api.stop(); runs++) {
        const before = A.count(bot, st.item)
        const ok = await C.craft(bot, st.item, 1, tbl).catch(() => false)
        for (let w = 0; w < 10 && A.count(bot, st.item) <= before; w++) await sleep(150) // bot.inventory lags the server after a craft
        if (!ok || A.count(bot, st.item) <= before) break
      }
    } finally { try { await C.releaseTable(bot) } catch (e_) { swallow('army_jobs:552', e_) } }
    // FOOD made by a PLAN is production too (foreman 09-20 03:58Z: REPORT's headline said "WHEAT NOT BAKED ... 0 bread baked in 30 min" while the bake_bread plan
    // baked without pause - only the quartermaster's cook() reported `cooked`; `banked` bread cannot stand in for it: hauls move the same 244 loaves again and again)
    if (!st.silent && bot.registry.foodsByName[st.item] && A.count(bot, st.item) > had) A.result(bot, { ev: 'cooked', job: job && job.id, raw: (st.item === 'bread' ? 'wheat' : 'craft') + '->' + st.item, n: A.count(bot, st.item) - had })
    return runs >= want || (runs + '/' + want + ' crafted (ingredients ran out?)')
  },
  async smelt (bot, st) { if (!A.count(bot, st.item)) return 'no ' + st.item + ' carried'; const n = await A.smelt(bot, st.item, st.n || A.count(bot, st.item), st.at ? v(st.at) : undefined); return n > 0 || 'smelted nothing: every furnace stayed busy for 2 min, or no fuel carried (coal/charcoal/planks/logs/sticks)' },
  async kill (bot, st, api) { let n = 0; const want = st.n || 1; let dry = 0; while (n < want && dry < 4 && !api.stop()) { const t = preyNear(bot, st.radius || 32, st.kinds)[0]; if (!t) { dry++; const a = Math.random() * 6.28; const p0 = bot.entity.position; await A.travel(bot, { x: Math.round(p0.x + Math.cos(a) * 14), y: null, z: Math.round(p0.z + Math.sin(a) * 14) }, { range: 3, ms: 15000, quiet: true, stop: () => api.stop() || !!preyNear(bot, st.radius || 32, st.kinds)[0] }); continue } if (await A.kill(bot, t, 25000, api.stop)) { n++; await A.pickup(bot, 7, 4000) } else dry++ } return n > 0 || 'no kills' },
  // bucket work: fill {at:[x,y,z] a WATER source block} -> water_bucket; pour {at:[x,y,z] the empty cell that shall hold the source}
  async fill (bot, st, api) {
    // The server ray-traces the click from the EYE: the water must be the first thing on that ray. Measured 09-19: from the fishing stand
    // the ray to the only open cell hit the grass rim first -> "bucket stayed empty". So: pick an open source cell, WALK to a spot
    // beside it with a clear line of sight (verified with the client's own raycast), look at the water's top, then use the bucket.
    if (!A.count(bot, 'bucket')) return 'no empty bucket'
    const at = v(st.at)
    if (bot.entity.position.distanceTo(at) > 6 && !await A.travel(bot, at, { range: 4, ms: 120000, stop: api.stop })) return 'water unreachable'
    const open = q => { const a = bot.blockAt(q.offset(0, 1, 0)); const b = bot.blockAt(q); return a && a.name === 'air' && b && b.name === 'water' && b.metadata === 0 }
    const cands = bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 12, count: 80 }).filter(open).filter(q => !st.radius || q.distanceTo(at) <= st.radius).filter(q => !st.avoid || !st.avoid(q)).sort((a, b) => a.distanceTo(at) - b.distanceTo(at)).slice(0, 8)
    if (!cands.length) return 'no open water source within 12 blocks of ' + st.at
    const clear = q => { // is the water top the first thing the click ray meets?
      const eye = bot.entity.position.offset(0, 1.62, 0); const tgt = q.offset(0.5, 0.95, 0.5); const d = eye.distanceTo(tgt)
      if (d > 4.3) return false
      const hit = bot.world.raycast(eye, tgt.minus(eye).normalize(), 5)
      return !hit || !hit.intersect || eye.distanceTo(hit.intersect) >= d - 0.05
    }
    const standable = c => { const f = bot.blockAt(c.offset(0, -1, 0)); const a = bot.blockAt(c); const h = bot.blockAt(c.offset(0, 1, 0)); return f && f.boundingBox === 'block' && !/ice/.test(f.name) && a && a.boundingBox === 'empty' && a.name !== 'water' && h && h.boundingBox === 'empty' }
    const had = A.count(bot, 'water_bucket')
    const tryHere = async q => {
      const e = bot.inventory.items().find(i => i.name === 'bucket'); if (!e) return false
      await bot.equip(e, 'hand').catch(e_ => swallow('army_jobs:578', e_))
      await bot.lookAt(q.offset(0.5, 0.95, 0.5), true).catch(e_ => swallow('army_jobs:579', e_)); await sleep(200)
      bot.activateItem(); await sleep(450); bot.deactivateItem()
      for (let w = 0; w < 8 && A.count(bot, 'water_bucket') <= had; w++) await sleep(150)
      return A.count(bot, 'water_bucket') > had
    }
    for (const q of cands) {
      if (api.stop()) break
      if (clear(q) && await tryHere(q)) return true
      const stands = []
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [1, 0, 2]) { const c = q.offset(dx, dy, dz); if ((dx || dz) && standable(c)) stands.push(c) }
      stands.sort((a, b) => a.distanceTo(q) - b.distanceTo(q))
      for (const c of stands.slice(0, 5)) {
        if (api.stop()) break
        if (!await A.travel(bot, c, { range: 0, ms: 20000, stop: api.stop })) continue
        await sleep(300)
        if (clear(q) && await tryHere(q)) return true
      }
    }
    return 'bucket stayed empty: no spot with a clear line of sight to an open source (' + cands.length + ' cells tried)'
  },
  async pour (bot, st, api) {
    // Same lesson as `fill`: the server ray-traces the click from the eye. From 2 blocks away the rim of a 1-deep hole hides its floor, the
    // client PREDICTS water, the server places nothing (09-19: three "ok" pours, three empty holes). So: stand on a cell ADJACENT to the
    // hole with a clear ray to its floor, click, then trust only what is still there 1.5 s later (server state).
    if (!A.count(bot, 'water_bucket')) return 'no water_bucket'
    const at = v(st.at)
    // WATER BELONGS TO THE BLUEPRINT: inside a field only the build job's water-cell routine pours (world 1: plans and farmers poured over each other's holes)
    if (!st.waterCell) { const fj = ((A.readJSON(A.F.board, {}) || {}).jobs || []).find(j => j.type === 'farm' && j.params && Array.isArray(j.params.box) && at.x >= Math.min(j.params.box[0], j.params.box[2]) && at.x <= Math.max(j.params.box[0], j.params.box[2]) && at.z >= Math.min(j.params.box[1], j.params.box[3]) && at.z <= Math.max(j.params.box[1], j.params.box[3])); if (fj) return 'refused: ' + st.at + ' lies in the field of ' + fj.id + ' - a field gets its water from its build job (blueprint field_block), never from a plan' }
    const under = bot.blockAt(at.offset(0, -1, 0)); if (under && under.boundingBox !== 'block') return 'no solid floor under ' + st.at
    const isWater = () => { const c = bot.blockAt(at); return !!c && c.name === 'water' && c.metadata === 0 }
    if (isWater()) return true // already watered: a second bucket can only land BESIDE the hole (09-19 flood: 3 mid-air sources, 309 flowing blocks over the wheat)
    // WATER FLOWS: a source anywhere but inside a closed hole runs 7 blocks and washes crops away (09-19: a stray source ON the field
    // cut a stream through the wheat, another froze to ice on the soil). Pour ONLY into a cell whose 4 sides and floor are solid.
    const open4 = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => { const n = bot.blockAt(at.offset(dx, 0, dz)); return !n || n.boundingBox !== 'block' })
    if (open4.length && !st.allowFlow) return 'not a closed hole: ' + open4.length + ' open side(s) at ' + st.at + ' - water would flow (dig the hole 1 deep into level ground first)'
    const strayBefore = new Set(bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 4, count: 60, point: at }).map(q => q.x + ',' + q.y + ',' + q.z))
    // water that flowed near the hole BEFORE the click is not this pour's leak (a neighbour's flood must not make us plug a good new source)
    const flowKeys = () => bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 3, count: 40, point: at }).filter(q => bot.blockAt(q).metadata !== 0).map(q => q.x + ',' + q.y + ',' + q.z)
    const flowBefore = new Set(flowKeys())
    const standable = c => { const f = bot.blockAt(c.offset(0, -1, 0)); const a = bot.blockAt(c); const h = bot.blockAt(c.offset(0, 1, 0)); return f && f.boundingBox === 'block' && a && a.boundingBox === 'empty' && a.name !== 'water' && h && h.boundingBox === 'empty' }
    const stands = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [1, 0]) { const c = at.offset(dx, dy, dz); if (standable(c)) { stands.push(c); break } }
    if (!stands.length) return 'no free cell next to ' + st.at
    stands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    for (const c of stands) {
      if (api.stop()) break
      if (!await A.travel(bot, c, { range: 0, ms: 30000, stop: api.stop, quiet: true })) continue
      await sleep(300)
      // AIM CHECK (owner SAW water placed beside the hole): the bucket goes where the server's ray from our eye lands. Only click
      // when our own raycast says the first block on that ray is the hole's FLOOR (or a wall INSIDE the hole). Otherwise this stand is no good.
      const eye0 = bot.entity.position.offset(0, 1.62, 0); const tgt0 = at.offset(0.5, 0.02, 0.5)
      const hit0 = bot.world.raycast(eye0, tgt0.minus(eye0).normalize(), 6)
      const inHole = hit0 && hit0.position && ((hit0.position.x === at.x && hit0.position.z === at.z && hit0.position.y === at.y - 1) || (hit0.intersect && Math.floor(hit0.intersect.y + 0.001) <= at.y && Math.abs(hit0.intersect.x - (at.x + 0.5)) <= 0.5 && Math.abs(hit0.intersect.z - (at.z + 0.5)) <= 0.5))
      if (!inHole) { A.result(bot, { ev: 'pour_aim_rejected', at: [at.x, at.y, at.z], from: [Math.round(eye0.x * 10) / 10, Math.round(eye0.z * 10) / 10], hit: hit0 && hit0.position ? [hit0.position.x, hit0.position.y, hit0.position.z] : null }); continue }
      const e = bot.inventory.items().find(i => i.name === 'water_bucket'); if (!e) return 'no water_bucket'
      await bot.equip(e, 'hand').catch(e_ => swallow('army_jobs:622', e_))
      await bot.lookAt(at.offset(0.5, 0.02, 0.5), true).catch(e_ => swallow('army_jobs:623', e_)); await sleep(200)
      bot.activateItem(); await sleep(450); bot.deactivateItem()
      await sleep(1500)
      // anything that appeared OUTSIDE the hole is a mistake: plug it at once (a block placed into a source removes it) and dig the plug out
      // (allowFlow = a POOL being filled: its other cells BECOME sources by design - never scoop or plug those)
      const stray = st.allowFlow ? [] : bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 4, count: 60, point: at }).filter(q => !q.equals(at) && !strayBefore.has(q.x + ',' + q.y + ',' + q.z) && bot.blockAt(q).metadata === 0)
      for (const q of stray) {
        const gone = () => { const b = bot.blockAt(q); return !b || b.name !== 'water' || b.metadata !== 0 }
        const bk = bot.inventory.items().find(i => i.name === 'bucket')
        if (bk) { try { await bot.equip(bk, 'hand'); await bot.lookAt(q.offset(0.5, 0.5, 0.5), true); await sleep(150); bot.activateItem(); await sleep(450); bot.deactivateItem(); await sleep(900) } catch (e_) { swallow('army_jobs:scoop', e_) } }
        if (!gone()) { const it = ['cobblestone', 'dirt'].find(n => A.count(bot, n)); if (it) { const r = await A.placeHard(bot, q, it, { stop: api.stop }).catch(() => ({})); if (r && r.ok) await lib('blocks').digBlock(bot, q, { collect: true, requireHarvest: false, plug: false }).catch(e_ => swallow('army_jobs:628', e_)) } await sleep(600) }
        A.result(bot, { ev: 'stray_water', at: [q.x, q.y, q.z], plugged: gone() })
        if (!gone()) A.askHelp(bot, 'stray_water', 'a water SOURCE I placed by mistake is still at ' + [q.x, q.y, q.z].join(',') + ' and will flood the field')
      }
      if (isWater()) {
        // CONTAINMENT CHECK: a contained source has NO flowing water around it. Any flow within 2 blocks = the hole leaks (uneven ground):
        // plug the source again at once and refuse this cell for good (the 09-19 flood: 71 flowing blocks ran 7 levels downhill).
        // allowFlow: a 2x2 POOL being filled (its cells flow until the 2nd diagonal source makes all four sources)
        const flows = st.allowFlow ? [] : flowKeys().filter(k => !flowBefore.has(k))
        if (!flows.length) return true
        const BL = lib('blocks'); const it = ['cobblestone', 'dirt'].find(n => A.count(bot, n)) || (await A.obtain(bot, 'cobblestone', 4, { stop: api.stop }) ? 'cobblestone' : null)
        if (it) await BL.placeBlock(bot, at, it, {}).catch(e_ => swallow('army_jobs:plug', e_))
        A.result(bot, { ev: 'stray_water', at: [at.x, at.y, at.z], plugged: !!it, flows: flows.length })
        return 'LEAK: water at ' + st.at + ' started to flow (' + flows.length + ' blocks) - source plugged; level this spot before irrigating it'
      }
    }
    return 'water NOT poured at ' + st.at + ': no stand with a verified aim into the hole (bucket kept)'
  },
  // shear {n, radius}: wool WITHOUT killing the flock (needs shears = 2 iron ingots). Sheep regrow wool by eating grass.
  async shear (bot, st, api) {
    const sh = bot.inventory.items().find(i => i.name === 'shears'); if (!sh) return 'no shears (craft: 2 iron_ingot)'
    let n = 0; const want = st.n || 6; const done = new Set(); let dry = 0
    while (n < want && dry < 4 && !api.stop()) {
      const t = preyNear(bot, st.radius || 32, ['sheep'], { penned: true }).find(e => !done.has(e.id) && !sheepSheared(e) && !herdBaby(e))
      if (!t) { dry++; await sleep(2000); continue }
      done.add(t.id)
      if (t.position.distanceTo(bot.entity.position) > 3 && !await A.travel(bot, t.position, { range: 2, ms: 30000, stop: api.stop })) continue
      try { await bot.equip(sh, 'hand'); await bot.lookAt(t.position.offset(0, 0.8, 0), true); await bot.useOn(t); await sleep(600); if (sheepSheared(t)) n++; await A.pickup(bot, 5, 3000) } catch (e_) { swallow('army_jobs:642', e_) }
    }
    return n > 0 || 'no sheep sheared (none within ' + (st.radius || 32) + ' blocks?)'
  },
  async pickup (bot, st) { await A.pickup(bot, st.radius || 6, 6000); return true },
  // drop: HAND MATERIAL DOWN to a mate who cannot be reached on foot (09-20: a hunter in a closed canyon 15 below the forest floor, no_route x38 in 10 min - she builds the
  // `stairwell` out herself, but with what?). {do:'drop', item, n, toward:[x,y,z]}: walk to the rim first (goto), look at the spot, toss. Never near lava; max 256 per step.
  async drop (bot, st) {
    const it0 = bot.inventory.items().filter(i => i.name === st.item); const have = it0.reduce((n, i) => n + i.count, 0); if (!have) return 'no ' + st.item + ' carried'
    const t = Array.isArray(st.toward) ? v(st.toward) : null; if (t) { const lava = bot.findBlock({ point: t, matching: b => b && b.name === 'lava', maxDistance: 4 }); if (lava) return 'drop: lava at the target' ; try { await bot.lookAt(t.offset(0.5, 0.5, 0.5), true) } catch (e_) { swallow('army_jobs:dropLook', e_) } }
    let left = Math.min(have, st.n || have, 256); let n = 0
    while (left > 0) { const it = bot.inventory.items().find(i => i.name === st.item); if (!it) break; const k = Math.min(left, it.count); try { await U.withTimeout(bot.toss(it.type, null, k), 5000, 'toss') } catch (e) { return 'drop: ' + String(e && e.message).slice(0, 60) } left -= k; n += k; await sleep(250) }
    A.result(bot, { ev: 'dropped', item: st.item, n, toward: st.toward || null })
    return true
  },
  async till (bot, st) { const r = await lib('blocks').tillAndPlant(bot, v(st.at), st.seed || 'wheat_seeds', {}); return r.ok || ('till: ' + r.reason) },
  async equip (bot, st) { const it = bot.inventory.items().find(i => i.name === st.item); if (!it) return 'no ' + st.item; await U.withTimeout(bot.equip(it, st.dest || 'hand'), 5000, 'equip'); return true },
  async eat (bot) { if (bot.food >= 20) return true; try { await U.withTimeout(lib('feed').eat(bot, { rawOk: true }), 20000, 'eatStep') } catch (e_) { swallow('army_jobs:eatStep', e_) } return true }, // full or nothing edible = done at once (helpdesk 09-19 20:04Z: Fuuka "hung" 3 min on step eat with food 20 and empty pockets)
  async sleep (bot) { const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 24 }); if (!bed) return 'no bed within 24'; if (!await A.travel(bot, bed.position, { range: 2, ms: 60000 })) return 'bed unreachable'; try { await bot.sleep(bed); return true } catch (e) { return 'sleep: ' + String(e.message).slice(0, 60) } },
  async wait (bot, st, api) { const end = Date.now() + (st.s || 5) * 1000; while (Date.now() < end && !api.stop()) await sleep(500); return true },
  async say (bot, st) { bot.chat(String(st.text || '').replace(/^[/!]+/, '').slice(0, 100)); return true },
  async sample (bot) { const s = sampleLand(bot); s.t = Date.now(); s.bot = bot.username; require('fs').appendFileSync(require('path').join(A.DIR, 'scout.jsonl'), JSON.stringify(s) + '\n'); return true }
}
async function steps (bot, job, api, ctx) {
  const P = job.params || {}
  const list = P.steps || []
  const key = job.id + ':' + (job.rev || 0)
  const st = bot.__armySteps = (bot.__armySteps && bot.__armySteps.key === key) ? bot.__armySteps : { key, i: 0, done: false }
  if (st.done) {
    // a finished plan must not hold its bot hostage: single-bot plans pause themselves (operators re-activate with new steps + rev)
    if ((job.names || []).length <= 1 && !P.repeat) A.boardEdit(b => { const j = (b.jobs || []).find(x => x.id === job.id); if (j && (j.rev || 0) === (job.rev || 0) && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: plan ' + (st.failed ? 'failed' : 'finished') } })
    return muster(bot, job, api, ctx, 'plan finished (new plan: edit params.steps and bump rev)')
  }
  while (st.i < list.length && !api.stop()) {
    const step = list[st.i]
    const fn = VERBS[step.do]
    task(bot, 'step ' + (st.i + 1) + '/' + list.length + ' ' + step.do)
    let r
    try { r = fn ? await U.withTimeout(fn(bot, step, api, job), (step.s || 600) * 1000 + 5000, 'step') : 'unknown verb ' + step.do } catch (e) { r = 'error: ' + String(e && e.message || e).slice(0, 100) }
    if (api.stop()) { // say WHY (foreman 09-19: "stopped at step 1" looked like onFail:continue was ignored - the bot had simply been reassigned)
      const a = api._a && api._a.job; const why = bot.__armyDied ? 'the bot died' : a && a.id !== job.id ? 'the dispatcher reassigned the bot to ' + a.id : a && (a.rev || 0) !== (job.rev || 0) ? 'the plan was edited (rev ' + (a.rev || 0) + ')' : 'interrupted (cancel or the 15-min slice limit)'
      A.result(bot, { ev: 'plan_interrupted', job: job.id, at: st.i + 1, why })
      return 'stopped at step ' + (st.i + 1) + ': ' + why
    }
    const ok = r === true
    if (ok && ['craft', 'place', 'dig', 'smelt', 'fell', 'collect', 'kill', 'shear', 'till', 'fill', 'pour', 'unstash'].includes(step.do)) st.useful = (st.useful || 0) + 1
    if (!ok) st.failedN = (st.failedN || 0) + 1
    A.result(bot, { ev: 'step', job: job.id, i: st.i + 1, do: step.do, ok, why: ok ? undefined : String(r) })
    if (!ok && P.onFail !== 'continue') A.askHelp(bot, 'plan_failed', 'job ' + job.id + ' step ' + (st.i + 1) + ' ' + JSON.stringify(step).slice(0, 120) + ' -> ' + String(r), { remaining: list.slice(st.i + 1, st.i + 6) })
    if (!ok && P.onFail !== 'continue') { st.done = true; st.failed = true; A.result(bot, { ev: 'plan_failed', job: job.id, at: st.i + 1, do: step.do, why: String(r) }); return 'plan failed at step ' + (st.i + 1) + ': ' + r }
    st.i++
    try { await lib('feed').eat(bot, {}) } catch (e_) { swallow('army_jobs:678', e_) }
  }
  if (st.i >= list.length && P.repeat && !st.useful) { // a whole pass achieved nothing (no stock, nothing to fell …): don't spin — rest 2 min, say why once
    if (!st.idleSaid) { st.idleSaid = true; A.result(bot, { ev: 'plan_idle', job: job.id, why: 'a full pass of the repeat plan produced nothing' }) }
    st.i = 0; return muster(bot, job, api, ctx, 'plan idle: a full pass produced nothing (materials?)')
  }
  if (st.i >= list.length) { st.useful = 0 }
  if (st.i >= list.length) { if (P.repeat) st.i = 0; else { st.done = true; st.failed = !!st.failedN; A.result(bot, Object.assign({ ev: 'plan_done', job: job.id, steps: list.length }, st.failedN ? { failed: st.failedN, note: 'onFail:continue - ' + st.failedN + ' steps FAILED (see the step events)' } : {})) } }
  return 'steps'
}

// ------------------------------------------------------------------ farm: a BIG shared field worked by a whole squad (owner: "30 bots -> think big").
// params: box:[x1,z1,x2,z2], y: soil level, seed:'wheat_seeds' (crop 'wheat'), forage:true (break grass/ferns nearby for seeds when out),
//         bankAt: 48 (wheat carried before a trip to the FOOD chest). For a `field_block` at origin [x,y,z]: box [x, z, x+26, z+26], y.
// WATER BELONGS TO THE BLUEPRINT, NOT TO THE FARMER (world 1: farmers dug, poured, plugged and capped water holes through five patch layers ->
// a flood of 309 flowing blocks, holes re-poured 7-12 times, crafting tables dropped into them, wheat 911 -> 373). A farmer tills, plants,
// harvests, replants and clears junk - nothing else. It never digs or places in a column that holds water, carries no bucket, and a field
// without water is REPORTED (`field_dry`, once per 6 h) and handed back: the field's `build` job (blueprint `field_block`) makes the water.
// Squad logic without chatter: each bot sweeps the box in stripes starting at its own offset; blocks.js position locks stop double work.
// Harvest only age 7, replant at once, all seeds go back into the ground until the box is full (then surplus seeds + wheat are banked).
const FARM_JUNK = /^(cobblestone|cobbled_deepslate|deepslate|granite|diorite|andesite|tuff|gravel|stone|crafting_table|.*_button|netherrack|.*_planks)$/
// CROPS ONLY GROW WHERE SOMEBODY IS (owner 09-20 05:00Z: the cane farm on the lake shore, 100-180 blocks from where the army works, grew 8-22 plants in 3 hours):
// chunks tick within ~128 blocks of a player. A growing job (farm, cane farm, tree farm) whose box centre lies > 128 from settings.muster says so once an hour
// (`farm_far {job, d}`, asset_audit.json) - the cure is a plot inside the base (plan-base zones field_n / cane), not more farmers.
function farCheck (bot, job, box) {
  try {
    const m = A.musterPos(); if (!m || !Array.isArray(box) || box.length !== 4) return
    const d = Math.round(Math.hypot((box[0] + box[2]) / 2 - m.x, (box[1] + box[3]) / 2 - m.z)); if (d <= 128) return
    const AF = require('path').join(A.DIR, 'asset_audit.json'); const au = A.readJSON(AF, {}) || {}; const k = job.id + ':far'
    if (Date.now() - ((au[k] || {}).t || 0) < 3600000) return
    au[k] = { t: Date.now(), d }; A.writeJSON(AF, au)
    A.result(bot, { ev: 'farm_far', job: job.id, d, why: 'box centre ' + d + ' blocks from muster: chunks beyond ~128 of a player do not tick, nothing grows while nobody is there' })
  } catch (e_) { swallow('army_jobs:farCheck', e_) }
}
function cropAge (b) { try { const p = b.getProperties(); return p && p.age != null ? +p.age : b.metadata } catch { return b.metadata } }
// THE ZONE'S OWN BLUEPRINT SAYS WHICH COLUMN IS SOIL (foreman 09-20 10:20Z: BASE AUDIT base_field_6/7 `cobblestone@-399,69,-415=wheat` x6 - probed 10:3xZ: all six are the
// POST that carries the cap over a water cell (field_block puts soil at y, the post at y+1 one north of the water), standing as `67:dirt 68:farmland 69:wheat`. cobblestone
// is in FARM_JUNK, so the farmer dug the post as "junk on the field", tilled the dirt under it and planted; re-activating the build job (the audit's remedy) repaves and the
// farmers re-plant next pass = a repave/replant loop that burns bot-hours and an alert that can never clear). A farmer works ONLY columns a registered blueprint of ours
// marks `soil:true`; path, post, water and torch columns are the BUILD job's. Map 'x,z' -> soil y | null (not the farmer's); a column no blueprint of ours claims is not in
// the map at all, so a plain farm box (no blueprint) keeps the old behaviour. One build over the box per 5 min, shared by every farmer in the process.
let _farmSoil = { t: 0, k: '', v: new Map() }
function farmSoil (box, y) {
  const k = box.join(',') + '@' + y
  if (_farmSoil.k === k && Date.now() - _farmSoil.t < 300000) return _farmSoil.v
  const m = new Map()
  try {
    for (const j of A.buildJobs()) {
      const q = j.params; if (!q || A.TERRAIN_BP.test(String(q.blueprint)) || Math.abs(q.origin[1] - y) > 4 || q.origin[0] > box[2] + 64 || q.origin[0] < box[0] - 64 || q.origin[2] > box[3] + 64 || q.origin[2] < box[1] - 64) continue
      let cs; try { cs = A.blueprintCellsOf(q) } catch (e_) { swallow('army_jobs:farmSoilCells', e_); continue }
      for (const c of cs) {
        if (c.block === 'air' || c.fillOnly || c.solid || c.x < box[0] || c.x > box[2] || c.z < box[1] || c.z > box[3] || Math.abs(c.y - y) > 2) continue
        const key = c.x + ',' + c.z; if (m.get(key) === null) continue // a non-soil cell anywhere in the column wins: the column is the build job's
        if (c.soil) { if (!m.has(key)) m.set(key, c.y) } else m.set(key, null)
      }
    }
  } catch (e_) { swallow('army_jobs:farmSoil', e_) }
  _farmSoil = { t: Date.now(), k, v: m }
  return m
}
async function farm (bot, job, api, ctx) {
  const BL = lib('blocks')
  const P = job.params || {}
  const seed = P.seed || 'wheat_seeds'
  const crop = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' }[seed] || 'wheat'
  const ripe = crop === 'beetroots' ? 3 : 7
  const [x1, z1, x2, z2] = [Math.min(P.box[0], P.box[2]), Math.min(P.box[1], P.box[3]), Math.max(P.box[0], P.box[2]), Math.max(P.box[1], P.box[3])]
  const y = P.y
  farCheck(bot, job, [x1, z1, x2, z2])
  const soilMap = farmSoil([x1, z1, x2, z2], y) // which columns of this box are the farmer's at all (see farmSoil)
  if (isNight(api) && !P.night) return muster(bot, job, api, ctx, 'farm: night')
  if (!bot.inventory.items().some(i => /_hoe$/.test(i.name))) {
    for (const h of ['iron_hoe', 'stone_hoe', 'wooden_hoe']) { if (await A.withdraw(bot, h, 1, { stop: api.stop })) break }
    if (!bot.inventory.items().some(i => /_hoe$/.test(i.name))) { // make one - a farmer never waits for a toolsmith. TIER FALLBACK (main 09-19 20:0xZ: the only recipe tried was
      // stone_hoe with 0 cobblestone in the world -> "farm: no hoe and cannot craft one" while food stood at 24/448): stone when 2 tool stones exist anywhere, else the
      // WOODEN hoe of day one (2 planks + 2 sticks from any wood) through A.obtain (depot, the recipe solver, THE craft table)
      task(bot, 'farm: crafting a hoe')
      const stoneN = TOOL_STONE.reduce((n, k) => n + A.count(bot, k) + A.stockOf(k), 0)
      for (const h of (stoneN >= 2 ? ['stone_hoe', 'wooden_hoe'] : ['wooden_hoe'])) { if (api.stop() || await A.obtain(bot, h, 1, { stop: api.stop })) break }
    }
    if (!bot.inventory.items().some(i => /_hoe$/.test(i.name)) && api.stop()) return 'farm: interrupted while fetching a hoe' // an interrupted withdraw is no reason to DECLINE the farm
    if (!bot.inventory.items().some(i => /_hoe$/.test(i.name))) return muster(bot, job, api, ctx, 'farm: no hoe and cannot craft one (cobblestone/sticks/table?)')
  }
  if (!A.count(bot, seed)) await A.withdraw(bot, seed, 64, { stop: api.stop })
  if (bot.__armyFarmDirt === job.id && A.count(bot, 'dirt') < 8 && A.stockOf('dirt') > 64) { await A.withdraw(bot, 'dirt', 32, { stop: api.stop }); bot.__armyFarmDirt = null }
  // FLOOD SENSOR (09-19: 309 blocks of flowing water washed the west half of the field away and only the OWNER noticed): flowing water inside
  // the box is never intended here (water = the blueprint's closed cells). Every farmer looks around at slice start; >= 12 flowing blocks = alarm
  // with the open sources' coordinates (escalate.sh wakes the top model on `flood`).
  try {
    if (Date.now() - (farm.floodT || 0) > 600000) {
      const wid = bot.registry.blocksByName.water.id
      const wat = bot.findBlocks({ matching: wid, maxDistance: 40, count: 400 }).filter(q => q.x >= x1 && q.x <= x2 && q.z >= z1 && q.z <= z2 && q.y >= y - 2)
      const flowing = wat.filter(q => bot.blockAt(q).metadata !== 0)
      if (flowing.length >= 12) {
        farm.floodT = Date.now()
        const srcs = wat.filter(q => bot.blockAt(q).metadata === 0 && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = bot.blockAt(q.offset(dx, 0, dz)); return n && n.boundingBox !== 'block' })).slice(0, 6).map(q => [q.x, q.y, q.z])
        A.result(bot, { ev: 'flood', job: job.id, flowing: flowing.length, openSources: srcs })
      }
    }
  } catch (e_) { swallow('army_jobs:floodSensor', e_) }
  const centre = new Vec3(Math.round((x1 + x2) / 2), y + 1, Math.round((z1 + z2) / 2))
  task(bot, 'farm:travel')
  if (bot.entity.position.x < x1 - 12 || bot.entity.position.x > x2 + 12 || bot.entity.position.z < z1 - 12 || bot.entity.position.z > z2 + 12) {
    if (!await A.travel(bot, centre, { range: Math.max(4, Math.floor(Math.min(x2 - x1, z2 - z1) / 2)), ms: 420000, stop: api.stop, via: P.via })) return 'farm: cannot reach the field'
  }
  // my stripe first, then everybody else's (serpentine rows along x)
  const names = job.names || A.settings().roster || []
  const me = Math.max(0, names.indexOf(bot.username))
  const rows = []
  for (let z = z1; z <= z2; z++) rows.push(z)
  const start = rows.length ? (me * 3) % rows.length : 0
  const order = rows.slice(start).concat(rows.slice(0, start))
  const st = { harvested: 0, planted: 0, dry: 0, skipped: 0 }
  task(bot, 'farm')
  for (let ri = 0; ri < order.length && !api.stop(); ri++) {
    const z = order[ri]
    const xs = []
    for (let x = x1; x <= x2; x++) xs.push(x)
    if (ri % 2) xs.reverse()
    for (const x of xs) {
      if (api.stop()) break
      // a column that holds WATER (the blueprint's cell, its floor, its cap) is not the farmer's: never tilled, dug or built on (the soil search below would find the FLOOR under the water)
      { let wet = false; for (let dy = -2; dy <= 1 && !wet; dy++) wet = (bot.blockAt(new Vec3(x, y + dy, z)) || {}).name === 'water'; if (wet) continue }
      // a column the zone's own blueprint paves (path line, water cell, the POST under a water cap, a torch): not the farmer's - never tilled, never dug, never planted
      if (soilMap.get(x + ',' + z) === null) { st.notMine = (st.notMine || 0) + 1; continue }
      // terrain following: the soil of this column is the top dirt/grass/farmland within +-2 of params.y (a big field is never perfectly flat)
      let soilP = null
      for (const dy of [0, 1, -1, 2, -2]) { const c = bot.blockAt(new Vec3(x, y + dy, z)); const a = bot.blockAt(new Vec3(x, y + dy + 1, z)); if (c && a && /^(farmland|dirt|grass_block|podzol|coarse_dirt|rooted_dirt)$/.test(c.name) && a.boundingBox !== 'block') { soilP = new Vec3(x, y + dy, z); break } }
      if (!soilP) continue
      { const hang = bot.blockAt(soilP.offset(0, 2, 0)); const mid = bot.blockAt(soilP.offset(0, 1, 0)); if (hang && mid && hang.boundingBox === 'block' && FARM_JUNK.test(hang.name) && mid.boundingBox !== 'block' && !A.ourBlock(soilP.offset(0, 2, 0), hang.name)) { const r = await BL.digBlock(bot, soilP.offset(0, 2, 0), { collect: true, requireHarvest: false, plug: false, allowProtected: /crafting_table|button/.test(hang.name) }).catch(() => ({ ok: false })); if (r.ok) st.junk = (st.junk || 0) + 1 } }
      // ONE FIELD = ONE LEVEL (owner 09-20 "the fields are bumpy": probe of fields 1-3 = 19 tiles farmed one step DOWN - the soil block went with an escape staircase
      // or a creeper and the farmer, following the terrain, tilled the bottom of the dent). A tile of a plan field (params.y) that lies 1-2 low with nothing growing on
      // it (just harvested / bare) is filled back to y with dirt and tilled there; a tile 1-2 high is cut down. Not on the path lines of a 27x27 field block (their
      // holes are the build job's: stone goes there); water columns were skipped above. No dirt in the pockets -> the next slice brings 32.
      if (P.flat !== false && soilP.y !== y && Math.abs(soilP.y - y) <= 2 && !(x2 - x1 === 26 && z2 - z1 === 26 && ([9, 17].includes(x - x1) || [9, 17].includes(z - z1)))) {
        const t0 = bot.blockAt(soilP.offset(0, 1, 0)); const ripeNow = t0 && t0.name === crop && cropAge(t0) >= ripe
        if (t0 && t0.boundingBox !== 'block' && (t0.name !== crop || ripeNow)) {
          if (ripeNow) { const r0 = await BL.digBlock(bot, soilP.offset(0, 1, 0), { collect: true, requireHarvest: false, plug: false }).catch(() => ({ ok: false })); if (r0.ok) st.harvested++ }
          if (soilP.y < y) {
            if (!A.count(bot, 'dirt')) { st.noDirt = (st.noDirt || 0) + 1; bot.__armyFarmDirt = job.id } else {
              let ok = true; for (let yy = soilP.y + 1; yy <= y && ok; yy++) { const r0 = await BL.placeBlock(bot, new Vec3(x, yy, z), 'dirt', { retries: 1 }).catch(() => ({ ok: false })); ok = !!r0.ok }
              if (ok) { soilP = new Vec3(x, y, z); st.levelled = (st.levelled || 0) + 1 }
            }
          } else {
            let ok = true; for (let yy = soilP.y; yy > y && ok; yy--) { const r0 = await BL.digBlock(bot, new Vec3(x, yy, z), { collect: true, requireHarvest: false, plug: false, allowProtected: (bot.blockAt(new Vec3(x, yy, z)) || {}).name === 'farmland' }).catch(() => ({ ok: false })); ok = !!r0.ok }
            const dn = bot.blockAt(new Vec3(x, y, z)); if (ok && dn && /^(farmland|dirt|grass_block|podzol|coarse_dirt|rooted_dirt)$/.test(dn.name)) { soilP = new Vec3(x, y, z); st.levelled = (st.levelled || 0) + 1 }
          }
        }
      }
      const soil = bot.blockAt(soilP); const top = bot.blockAt(soilP.offset(0, 1, 0))
      if (!soil || !top) continue
      if (top.name === 'sugar_cane') continue // a shore cell of the `cane` job inside the field's box: never tilled
      if (top.name === crop) {
        if (cropAge(top) < ripe) continue
        const r = await BL.digBlock(bot, soilP.offset(0, 1, 0), { collect: true, requireHarvest: false, plug: false }).catch(() => ({ ok: false })) // plug:false - digBlock's default 'plug the adjacent liquid' put a block INTO a water hole whenever a crop on a low cell beside it was harvested
        if (!r.ok) { st.skipped++; continue }
        st.harvested++
      } else if (!/^(farmland|dirt|grass_block|podzol|coarse_dirt|rooted_dirt|dirt_path)$/.test(soil.name)) continue
      else if (top.boundingBox === 'block' && FARM_JUNK.test(top.name) && (bot.blockAt(soilP.offset(0, -1, 0)) || {}).name !== 'water' && soil.name !== 'water' && !A.ourBlock(soilP.offset(0, 1, 0), top.name)) { // ...but never a block a BLUEPRINT of ours put there (the field's post/path: that is how the water caps were eaten)
        // JUNK ON THE FIELD (owner 14:5xZ "the farm is a mess": 97 stray blocks - cobbled deepslate, granite, gravel, crafting tables - sat on and
        // over the wheat, left by bots' placing remedies; tidy never enters the farm box). The farmer clears the cell, then plants it.
        const r = await BL.digBlock(bot, soilP.offset(0, 1, 0), { collect: true, requireHarvest: false, plug: false, allowProtected: /crafting_table|button/.test(top.name) }).catch(() => ({ ok: false })); if (!r.ok) { st.skipped++; continue } st.junk = (st.junk || 0) + 1
      } else if (top.name === 'snow') { const r = await BL.digBlock(bot, soilP.offset(0, 1, 0), { collect: false, requireHarvest: false, plug: false }).catch(() => ({ ok: false })); if (!r.ok) { st.skipped++; continue } } else if (top.boundingBox === 'block') continue
      if (!A.count(bot, seed)) { st.skipped++; continue }
      const r = await BL.tillAndPlant(bot, soilP, seed, {}).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (r.ok && !r.already) st.planted++
      else if (!r.ok && r.reason === 'no_water') st.dry++
      else if (!r.ok) st.skipped++
    }
    try { await lib('feed').eat(bot, {}) } catch (e_) { swallow('army_jobs:786', e_) }
    if (A.count(bot, crop === 'wheat' ? 'wheat' : seed) >= (P.bankAt || 48) || U.freeSlots(bot) <= 2) break
  }
  await A.pickup(bot, 6, 3000)
  A.result(bot, { ev: 'farm_pass', job: job.id, st, seeds: A.count(bot, seed), wheat: A.count(bot, 'wheat') })
  // A FIELD WITHOUT WATER IS NOT THE FARMER'S TO FIX: dry cells and not one water source standing inside the box (seen from inside the field) ->
  // `field_dry`, once per 6 h for the whole army (asset_audit.json), and a farmer with nothing else to do is handed back. The cure is the field's
  // build job (blueprint `field_block` makes and verifies the water cells; a lost cell re-activates it through `structure_damaged`).
  let fieldDry = false
  try {
    if (st.dry >= 8) {
      const src = bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 48, count: 200 }).filter(q => q.x >= x1 && q.x <= x2 && q.z >= z1 && q.z <= z2 && Math.abs(q.y - y) <= 1 && bot.blockAt(q).metadata === 0)
      if (!src.length) {
        fieldDry = true
        const AF = require('path').join(A.DIR, 'asset_audit.json'); const au = A.readJSON(AF, {}) || {}; const k = job.id + ':fieldDry'
        if (Date.now() - ((au[k] || {}).t || 0) > 6 * 3600000) { au[k] = { t: Date.now(), by: bot.username }; A.writeJSON(AF, au); A.result(bot, { ev: 'field_dry', job: job.id, dry: st.dry, box: [x1, z1, x2, z2], note: 'no water source stands in the field - farmers never pour: staff the field\'s build job (blueprint field_block)' }) }
      }
    }
  } catch (e_) { swallow('army_jobs:fieldDry', e_) }
  // THE FIELD GETS WORSE (14:5xZ: dry cells went 235 -> 425 in 50 min and no alarm existed): remember the best dry count; 100+ above it = `farm_degrading`
  try { const AF = require('path').join(A.DIR, 'asset_audit.json'); const au = A.readJSON(AF, {}) || {}; const k = job.id + ':dry'; const e = au[k] || { best: st.dry, t: Date.now() }; if (st.dry < e.best || Date.now() - e.t > 6 * 3600000) { e.best = st.dry; e.t = Date.now() } if (st.dry - e.best >= 100 && Date.now() - (e.alarmT || 0) > 900000) { e.alarmT = Date.now(); A.result(bot, { ev: 'farm_degrading', job: job.id, dry: st.dry, best: e.best }) } au[k] = e; A.writeJSON(AF, au) } catch (e_) { swallow('army_jobs:farmAudit', e_) }
  // crops that vanish show up as PLANTING WITHOUT HARVESTING (trampling, a flood): 40+ cells replanted in one pass with under 10 harvested
  if (st.planted >= 40 && st.harvested < 10 && Date.now() - (farm.spikeT || 0) > 600000) { farm.spikeT = Date.now(); A.result(bot, { ev: 'crops_vanished', job: job.id, replanted: st.planted, harvested: st.harvested, at: [Math.round(bot.entity.position.x), Math.round(bot.entity.position.z)] }) }
  if (A.count(bot, 'wheat') >= (P.bankAt || 48) || U.freeSlots(bot) <= 2) {
    task(bot, 'farm:bank')
    const keep = { torch: 16 }; keep[seed] = 64
    for (const i of bot.inventory.items()) if (/_hoe$/.test(i.name)) keep[i.name] = 1
    await A.bank(bot, keep, { job: job.id, stop: api.stop })
  }
  if (fieldDry && st.planted + st.harvested === 0) return muster(bot, job, api, ctx, 'farm: the field is dry (no water cell stands) - its build job makes the water')
  // out of seeds with empty soil left: forage grass/ferns around the field (each has a seed chance), never trample the crops.
  // Nothing to forage either -> hand the bot back (decline) instead of sweeping 200 empty cells every few seconds.
  if (!A.count(bot, seed) && st.planted === 0 && st.harvested === 0) {
    let got = false
    if (P.forage !== false) { task(bot, 'farm:forage seeds'); got = (await VERBS.collect(bot, { block: ['short_grass', 'fern', 'tall_grass', 'large_fern'], n: 24, radius: 40 }, api)) === true && A.count(bot, seed) > 0 }
    if (!got) return muster(bot, job, api, ctx, 'farm: no seeds (stock 0, no grass nearby) - seeds come from harvests, foraging trips or chickens')
  } else if (st.harvested + st.planted === 0) {
    // WAITING IS WASTE WHILE THE LARDER IS FULL (review row 6, 12:0xZ: `base-audit --idle` = 44 % of bot time without output, and `gemba` found 9 farmers standing at
    // "waiting for growth" with food 9139 against a target of 448 - twenty times over). Nothing ripe and nothing to plant: at or above `targets.food` the bot is handed
    // back the same tick (10 min) instead of standing 90 s at the field edge. The field is not abandoned - the dispatcher's demand formula re-staffs it the minute the
    // food stock drops under its target. Below the target, standing at a growing field IS the best use of the bot and the old wait holds.
    let full = false
    try { const ST = require('../../army/stock.js'); const T = (A.settings().targets || {}).food; full = T > 0 && ST.have('food') >= T } catch (e_) { swallow('army_jobs:farmLarder', e_) }
    if (full) { const why = 'farm: nothing ripe, nothing to plant and the larder is over target'; A.decline(bot, job, 600000, why); return muster(bot, job, api, ctx, why) }
    const end = Date.now() + 90000 // nothing to do yet: crops are growing — stand at the field edge, don't pace over the farmland
    task(bot, 'farm:waiting for growth')
    while (Date.now() < end && !api.stop()) await sleep(1000)
  }
  return 'farm'
}

// ------------------------------------------------------------------ ores: pick up what a player SEES (owner 09-19: "an ore in plain sight and nobody mines it").
// Census 09-19: 908 exposed ores in view of the army - 256 coal ores at y >= 58, 39 of them around the mine head - while the coal stock was 0.
// params: kinds:['coal_ore','iron_ore',...] (without the deepslate_ prefix), minY: the surface floor (A.surfaceFloor = sea level - 5: the SURFACE RULE keeps surface trips above it), radius: 200
// from muster, bankAt: 48. Each slice: look around (exposed ores within 64), else take the nearest one from bots/army/census.json; walk there
// read-only, mine the whole visible vein within reach, pick up, next. Unreachable ores are remembered for 6 h (ores_bad.json). Nothing left ->
// the bot is handed back for 30 min and says so (`ores_exhausted`: run `armyctl.js census` again or raise radius / lower minY).
// DAY-ONE CHAIN (world 2, 09-19: 17 bots `ores: no pickaxe and cannot craft one` and `obtain_failed stone_pickaxe missing #tool_stone:3` x44 while the
// army owned 400 logs and 1 cobblestone): any pickaxe of the depot -> a stone one when 3 tool stones exist ANYWHERE -> else the WOODEN one a player
// makes first (3 planks + 2 sticks). A wooden pick with 3 cobblestone in the pockets becomes a stone pick at the next call. Tried at most every 3 min per bot.
const TOOL_STONE = ['cobblestone', 'cobbled_deepslate', 'blackstone']
// COBBLESTONE IS NEVER THROWN AWAY WHILE THE ARMY IS SHORT OF IT (settings.targets.cobblestone; 09-19: stock 1 / target 1728 and ONE full chest for every category -
// A.bank tosses what no chest takes beyond 64). stoneKeep(n) = what a bank visit leaves in the pockets: n while the BUILD chests have room (or the target is met),
// else everything - carried cobblestone is stock too (stock.js counts pockets; builders place from their pockets first).
function stoneKeep (n) {
  try {
    const tgt = ((A.settings().targets || {}).cobblestone) || 0; if (!tgt || A.stockOf('cobblestone') >= tgt) return n
    const idx = A.index(); const room = A.chestsOf('build').some(p => { const e = idx[p.x + ',' + p.y + ',' + p.z]; return !e || (e.size || 27) - e.used > 2 })
    return room ? n : 100000
  } catch (e_) { swallow('army_jobs:stoneKeep', e_); return n }
}
// EARTH IS DUG WITH A SHOVEL, WOOD WITH AN AXE (owner 09-20: nobody owned a shovel - builders levelled thousands of dirt/grass/sand/gravel columns BY HAND, 5x
// slower, and the infill pads are all earth). Same chain as getPick: the best one in the depot -> craft a stone one (shovel 1 tool stone + 2 sticks, axe 3 + 2)
// -> the wooden one of day one. One try per kind every 3 min; bank() keeps the best tool of every kind, so ONE trip lasts. -> true when the bot holds one
async function getTool (bot, kind, api) {
  if (kind === 'pickaxe') return getPick(bot, api)
  const best = () => A.bestOf(bot, kind); if (best()) return true
  bot.__armyToolT = bot.__armyToolT || {}; if (Date.now() - (bot.__armyToolT[kind] || 0) < 180000) return false
  bot.__armyToolT[kind] = Date.now(); const was = (bot.state || {}).task; task(bot, 'getting a ' + kind)
  for (const t of ['diamond', 'iron', 'stone', 'wooden']) { if (api.stop()) break; if (A.stockOf(t + '_' + kind) > 0 && await A.withdraw(bot, t + '_' + kind, 1, { stop: api.stop })) break }
  const stoneAll = TOOL_STONE.reduce((n, k) => n + A.count(bot, k) + A.stockOf(k), 0)
  if (!best() && !api.stop() && stoneAll >= (kind === 'shovel' ? 1 : 3)) await A.obtain(bot, 'stone_' + kind, 1, { stop: api.stop })
  if (!best() && !api.stop()) await A.obtain(bot, 'wooden_' + kind, 1, { stop: api.stop })
  if (best()) A.result(bot, { ev: 'tool', kind, item: best().name })
  if (bot.state && was) bot.state.task = was
  return !!best()
}
const toolKindOf = b => { const m = /mineable\/(\w+)/.exec(String((b && b.material) || '')); return m ? m[1] : null } // 'shovel' | 'axe' | 'pickaxe' | 'hoe' | null
async function getPick (bot, api) {
  const best = () => A.bestOf(bot, 'pickaxe'); const b0 = best()
  const stoneOwn = TOOL_STONE.reduce((n, k) => n + A.count(bot, k), 0); const stoneAll = stoneOwn + TOOL_STONE.reduce((n, k) => n + A.stockOf(k), 0)
  if (b0 && !(b0.name === 'wooden_pickaxe' && stoneOwn >= 3)) return true
  if (Date.now() - (bot.__armyPickT || 0) < 180000) return !!b0
  bot.__armyPickT = Date.now(); task(bot, 'getting a pickaxe')
  if (!b0) for (const pk of ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']) { if (A.stockOf(pk) > 0 && await A.withdraw(bot, pk, 1, { stop: api.stop })) break }
  if (best() && best().name !== 'wooden_pickaxe') return true
  if (stoneAll >= 3) await A.obtain(bot, 'stone_pickaxe', 1, { stop: api.stop })
  if (!best()) await A.obtain(bot, 'wooden_pickaxe', 1, { stop: api.stop })
  if (best() && (!b0 || best().name !== b0.name)) A.result(bot, { ev: 'pickaxe', item: best().name })
  return !!best()
}
async function ores (bot, job, api, ctx) {
  const BL = lib('blocks'); const P = job.params || {}
  const kinds = P.kinds || ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'redstone_ore', 'lapis_ore']
  const minY = P.minY == null ? (A.surfaceFloor(bot) || 58) : P.minY; const R = P.radius || 200
  const m = setting(bot, 'muster'); if (!m) return muster(bot, job, api, ctx, 'ores: settings.muster is not set (radius/minDist are measured from it)')
  const BADF = require('path').join(A.DIR, 'ores_bad.json'); const K = p => p.x + ',' + p.y + ',' + p.z
  const bare = n => String(n).replace('deepslate_', '')
  if (!await getPick(bot, api)) return muster(bot, job, api, ctx, 'ores: no pickaxe and cannot craft one')
  const minD = P.minDist == null ? 45 : P.minDist // the ores right under the base sit in its sealed voids (decked pits): in view, never reachable - two bots hung over them (op 13:56)
  const usable = p => p.y >= minY && Math.hypot(p.x - m.x, p.z - m.z) <= R && Math.hypot(p.x - m.x, p.z - m.z) >= minD
  const blocked = () => { const b = A.readJSON(BADF, {}) || {}; const now = Date.now(); return k => !!b[k] && now - b[k].t < (b[k].claim ? 300000 : 6 * 3600000) && b[k].by !== bot.username }
  const mark = (k, claim) => { const b = A.readJSON(BADF, {}) || {}; b[k] = { t: Date.now(), by: bot.username, claim: !!claim }; for (const q of Object.keys(b)) if (Date.now() - b[q].t > 6 * 3600000) delete b[q]; A.writeJSON(BADF, b) }
  const lookAround = () => { try { return lib('census').census(bot, 64).ores.filter(o => kinds.includes(o[0])).map(o => new Vec3(o[1], o[2], o[3])).filter(usable) } catch (e_) { swallow('army_jobs:oresLook', e_); return [] } }
  let mined = 0; let walked = 0
  for (let round = 0; round < 8 && !api.stop(); round++) {
    const isBlocked = blocked()
    let cands = lookAround().filter(p => !isBlocked(K(p)))
    if (!cands.length) { const c = A.readJSON(require('path').join(A.DIR, 'census.json'), {}) || {}; cands = (c.ores || []).filter(o => kinds.includes(o.name)).map(o => new Vec3(o.at[0], o.at[1], o.at[2])).filter(p => usable(p) && !isBlocked(K(p))) }
    if (!cands.length) break
    cands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const t = cands[0]; mark(K(t), true)
    task(bot, 'ores: to ' + K(t))
    { const me = bot.entity.position; if (Math.hypot(t.x - me.x, t.z - me.z) < 8 && Math.abs(t.y - me.y) > 5) { mark(K(t), false); walked++; continue } } // straight below/above me: a cave roof or a cliff face, not a walk
    if (bot.entity.position.distanceTo(t) > 4 && !await A.travel(bot, t, { range: 3, ms: 60000, stop: api.stop, noRelax: true, quiet: true })) { mark(K(t), false); walked++; continue }
    // the vein: every same-kind ore touching what we mine, as long as it is within reach from where we stand
    const first = bot.blockAt(t); if (!first || !kinds.includes(bare(first.name))) { mark(K(t), false); continue }
    const kind = bare(first.name); const queue = [t]; const seen = new Set([K(t)]); let got = 0
    task(bot, 'ores: mining ' + kind)
    while (queue.length && got < 16 && !api.stop()) {
      const q = queue.shift(); const b = bot.blockAt(q); if (!b || bare(b.name) !== kind) continue
      if (bot.entity.position.offset(0, 1.6, 0).distanceTo(q.offset(0.5, 0.5, 0.5)) > 4.6) continue
      const r = await BL.digBlock(bot, q, { collect: true }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (!r.ok) { mark(K(q), false); continue }
      got++
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const n = q.offset(dx, dy, dz); if (!seen.has(K(n))) { seen.add(K(n)); queue.push(n) } }
    }
    mined += got
    await A.pickup(bot, 6, 4000)
    if (U.freeSlots(bot) <= 3) break
  }
  const loot = ['coal', 'raw_iron', 'raw_gold', 'raw_copper', 'diamond', 'emerald', 'redstone', 'lapis_lazuli'].reduce((n, k) => n + A.count(bot, k), 0)
  A.result(bot, { ev: 'ores_pass', job: job.id, mined, unreachable: walked, loot })
  if (loot >= (P.bankAt || 48) || U.freeSlots(bot) <= 3 || (!mined && loot > 0)) await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop })
  if (!mined) { A.result(bot, { ev: 'ores_exhausted', job: job.id, note: 'no reachable exposed ore in view or in census.json - run `armyctl.js census`, raise params.radius or lower params.minY' }); A.decline(bot, job, 1800000, 'ores: nothing reachable in sight'); return 'ores: nothing' }
  return 'ores'
}

// ------------------------------------------------------------------ lumber: a TREE FARM worked by a squad (owner: scale by algorithm, x30; LLM-written
// fell plans ran dry after one stand: "no tree within 12"). params: box:[x1,z1,x2,z2] plantation zone (blueprint `tree_farm`: [x, z, x+47, z+47]), pitch:3
// (the grid is measured from the box corner = the blueprint's soil points), bankAt:48, sapling: optional preference - NO SPECIES IS NAMED: the
// stump gets the sapling of the tree that stood there (blocks.js saplingOf), the grid gets whatever saplings the fellings dropped or the depot holds.
// Every slice: (1) the nearest standing trunk INSIDE the box is felled with the fell verb (whole tree, crowns, replant on the stump);
// (2) free soil on the pitch grid (x,z multiples of `pitch`) gets a sapling from stock, so the natural forest turns into an even, walkable
// plantation that regrows by itself; (3) nothing to cut and nothing to plant -> the bot is handed back for 10 min (trees need time, bots do not wait).
async function lumber (bot, job, api, ctx) {
  const BL = lib('blocks'); const P = job.params || {}
  const [x1, z1, x2, z2] = [Math.min(P.box[0], P.box[2]), Math.min(P.box[1], P.box[3]), Math.max(P.box[0], P.box[2]), Math.max(P.box[1], P.box[3])]
  const pitch = P.pitch || 3
  if (P.pitch != null && !P.clear) farCheck(bot, job, [x1, z1, x2, z2]) // a PLANTED tree farm (a wild forest is cut where it stands)
  // dark oak only grows 2x2: never on a 1-sapling grid point
  const saps = () => bot.inventory.items().filter(i => SAPLING_RE.test(i.name) && i.name !== 'dark_oak_sapling').sort((a, b) => (b.name === P.sapling) - (a.name === P.sapling) || b.count - a.count)
  const sapN = () => saps().reduce((n, i) => n + i.count, 0)
  const inBox = (x, z) => x >= x1 && x <= x2 && z >= z1 && z <= z2
  if (!A.bestOf(bot, 'axe')) { for (const a of ['iron_axe', 'stone_axe']) { if (await A.withdraw(bot, a, 1, { stop: api.stop })) break } if (!A.bestOf(bot, 'axe')) { task(bot, 'lumber: crafting an axe'); await A.obtain(bot, 'stone_axe', 1, { stop: api.stop }) } }
  // DAY ONE: no axe, no cobblestone, no sticks — a player punches the first trees by hand (world 2, 09-19: 43 bots declined the only wood job
  // with 'no axe and cannot craft one' while standing in a forest). A wooden axe is tried from the first logs; bare hands never stop the job.
  if (!A.bestOf(bot, 'axe') && bot.inventory.items().filter(i => /_log$|_stem$|_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0) >= 3) await A.obtain(bot, 'wooden_axe', 1, { stop: api.stop }).catch(e_ => swallow('army_jobs:lumber_wooden_axe', e_))
  if (sapN() < 8) { const names = stockNames(SAPLING_RE).filter(n => n !== 'dark_oak_sapling'); const nm = names.includes(P.sapling) ? P.sapling : names[0]; if (nm) await A.withdraw(bot, nm, 32, { stop: api.stop }) }
  const me0 = bot.entity.position
  if (!inBox(Math.floor(me0.x), Math.floor(me0.z))) {
    task(bot, 'lumber:travel')
    const names = job.names || A.settings().roster || []; const k = Math.max(0, names.indexOf(bot.username)) // spread the squad over the box
    const tx = x1 + 4 + ((k * 7) % Math.max(1, x2 - x1 - 8)); const tz = z1 + 4 + ((k * 11) % Math.max(1, z2 - z1 - 8))
    if (!await A.travel(bot, { x: tx, y: null, z: tz }, { range: 10, ms: 420000, stop: api.stop })) return 'lumber: cannot reach the plantation'
  }
  const ids = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name)).map(b => b.id)
  const bad = bot.__armyBadTrees = bot.__armyBadTrees || {}
  let felled = 0; let planted = 0
  for (let round = 0; round < 6 && !api.stop(); round++) {
    const trunks = bot.findBlocks({ matching: ids, maxDistance: 48, count: 400 })
      .filter(q => { if (!inBox(q.x, q.z) || bad[q.x + ',' + q.y + ',' + q.z]) return false; const u = (bot.blockAt(q.offset(0, -1, 0)) || {}).name || ''; return P.clear ? !/_log$/.test(u) : /dirt|grass|podzol|moss|snow_block|farmland/.test(u) }) // clearing a site also takes the HANGING crowns (lowest log of each column)
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    if (!trunks.length) break
    const q = trunks[0]
    task(bot, 'lumber: felling ' + q.x + ',' + q.z)
    const r = await VERBS.fell(bot, { near: [q.x, q.y, q.z], radius: 14, replant: !P.clear, box: [x1 - 2, z1 - 2, x2 + 2, z2 + 2] }, api) // fell searches around the BOT after walking to within 8 of `near`: radius 6 missed the trunk (7 of 8 passes felled 0)
    if (r === true) felled++; else bad[q.x + ',' + q.y + ',' + q.z] = 1
    await A.pickup(bot, 8, 4000)
    if (U.countRe(bot, U.LOG_RE) >= (P.bankAt || 48) || U.freeSlots(bot) <= 3) break
  }
  // plant the grid around me (saplings need soil + open sky + no trunk right beside them)
  if (sapN() && !api.stop() && !P.clear) {
    task(bot, 'lumber: planting')
    const me = bot.entity.position.floored(); const spots = []
    for (let x = Math.max(x1, me.x - 16); x <= Math.min(x2, me.x + 16); x++) for (let z = Math.max(z1, me.z - 16); z <= Math.min(z2, me.z + 16); z++) {
      if ((x - x1) % pitch || (z - z1) % pitch) continue // the grid hangs on the box corner (tree_farm's soil points), not on world coordinates
      for (let y = me.y + 6; y >= me.y - 6; y--) {
        const g = bot.blockAt(new Vec3(x, y, z)); if (!g || g.boundingBox !== 'block') continue
        const a = bot.blockAt(new Vec3(x, y + 1, z)); const a2 = bot.blockAt(new Vec3(x, y + 2, z))
        if (/^(grass_block|dirt|podzol|coarse_dirt)$/.test(g.name) && a && a2 && (a.name === 'air' || a.name === 'snow' || /grass|fern/.test(a.name)) && a2.name === 'air') spots.push(new Vec3(x, y + 1, z))
        break
      }
    }
    spots.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    for (const sp of spots.slice(0, 12)) {
      const sap = (saps()[0] || {}).name; if (api.stop() || !sap) break
      const top = bot.blockAt(sp); if (top && top.name !== 'air') await BL.digBlock(bot, sp, { collect: false, requireHarvest: false }).catch(e_ => swallow('army_jobs:lumberClear', e_))
      const r = await BL.placeBlock(bot, sp, sap, {}).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (r && r.ok) planted++
    }
  }
  const logs = U.countRe(bot, U.LOG_RE)
  A.result(bot, { ev: 'lumber_pass', job: job.id, felled, planted, logs })
  if (logs >= (P.bankAt || 48) || U.freeSlots(bot) <= 3 || (logs >= 16 && !felled)) {
    task(bot, 'lumber:bank'); const keep = { torch: 16 }; for (const i of saps()) keep[i.name] = 32; await A.bank(bot, keep, { job: job.id, stop: api.stop })
    // NO DEPOT YET (a new world): the logs stay in the pockets. Felling on would only drop them on the ground - the bot is handed back WITH its wood, so the
    // dispatcher can give it a build job (A.obtain crafts the first chests and tables out of what the builder carries). Never a private chest where it stands.
    if (!api.stop() && U.countRe(bot, U.LOG_RE) >= (P.bankAt || 48)) { A.result(bot, { ev: 'lumber_full', job: job.id, logs: U.countRe(bot, U.LOG_RE), note: 'no container took the logs - free for the depot build' }); A.decline(bot, job, 600000, 'lumber: pockets full of logs and no depot took them'); return 'lumber: full, no depot' }
  }
  if (P.clear && !felled) { // params.clear:true = CLEARING a site (a field, a building pad): no replanting, and the job ends when no trunk stands in the box
    const leftT = bot.findBlocks({ matching: ids, maxDistance: 64, count: 200 }).filter(q => inBox(q.x, q.z))
    if (!leftT.length && inBox(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.z))) { A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: no tree left in the box' } }); A.result(bot, { ev: 'clear_done', job: job.id }) }
  }
  if (!felled && !planted) { if (logs) { const keep = { torch: 16 }; for (const i of saps()) keep[i.name] = 32; await A.bank(bot, keep, { job: job.id, stop: api.stop }) } A.decline(bot, job, 600000, 'lumber: nothing to fell or plant right now (saplings are growing)'); return 'lumber: growing' }
  return 'lumber'
}

// ------------------------------------------------------------------ deck: close a cratered area at grade, from the rim inwards — scales with ANY number of bots.
// params: box:[x1,z1,x2,z2], y: grade level (the block layer that must become solid), block:'cobblestone', skip:[[x,z],…] columns to leave open
// Algorithm (no coordination needed): frontier = open cells of the layer that already have something to build against (solid below, or a solid
// neighbour in the same layer). Each bot takes the frontier cell nearest to itself; blocks.js position locks make two bots never take the same
// cell; every placed block creates new frontier, so the deck grows inwards until the layer is closed. One block per column instead of
// filling 6-16 deep pits: a paved yard the pathfinder can cross (WORLD.md Z1: "paved cobble y86"). Material: carried, else the BUILD chest.
async function deck (bot, job, api, ctx) {
  const BL = lib('blocks')
  const P = job.params || {}
  const item = P.block || 'cobblestone'
  const [x1, z1, x2, z2] = [Math.min(P.box[0], P.box[2]), Math.min(P.box[1], P.box[3]), Math.max(P.box[0], P.box[2]), Math.max(P.box[1], P.box[3])]
  const y = P.y
  const skip = new Set((P.skip || []).map(c => c[0] + ',' + c[1]))
  // never pave over a stairwell: the mine's recorded steps (and one ring around them) stay open wherever they come within 4 blocks of the
  // deck layer — a single cobble at head height over the first step froze 10 miners at the stairhead (09-19)
  try { for (const st of (A.readJSON(require('path').join(A.DIR, '..', 'iron_mine.json'), {}).steps || [])) if (Math.abs(st[1] - y) <= 4) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) skip.add((st[0] + dx) + ',' + (st[2] + dz)) } catch (e_) { swallow('army_jobs:826', e_) }
  if (isNight(api) && !P.night) return muster(bot, job, api, ctx, 'deck: night')
  if (A.count(bot, item) < 8) {
    await A.withdraw(bot, item, 128, { stop: api.stop })
    if (!A.count(bot, item)) return muster(bot, job, api, ctx, 'deck: no ' + item + ' carried or in stock')
  }
  const solid = b => !!b && b.boundingBox === 'block'
  const open = b => !!b && (BL.isReplaceable(b) || b.name === 'snow')
  const frontier = () => {
    const me = bot.entity.position
    const out = []
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      if (skip.has(x + ',' + z)) continue
      const c = new Vec3(x, y, z)
      if (c.distanceTo(me) > 48 || !open(bot.blockAt(c))) continue
      const ok = solid(bot.blockAt(c.offset(0, -1, 0))) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => solid(bot.blockAt(c.offset(dx, 0, dz))))
      if (ok) out.push(c)
    }
    return out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  }
  task(bot, 'deck:travel')
  const near = new Vec3(Math.max(x1, Math.min(x2, Math.round(bot.entity.position.x))), y + 1, Math.max(z1, Math.min(z2, Math.round(bot.entity.position.z))))
  if (A.dist2(bot, near.x, near.z) > 30 && !await A.travel(bot, { x: near.x, y: null, z: near.z }, { range: 10, ms: 240000, stop: api.stop })) return 'deck: cannot reach the area'
  task(bot, 'deck')
  let placed = 0; let streak = 0
  const bad = new Set()
  while (!api.stop() && A.count(bot, item) > 0 && streak < 8) {
    const f = frontier().filter(c => !bad.has(c.x + ',' + c.z))
    if (!f.length) break
    const c = f[0]
    const r = await A.placeHard(bot, c, item, { stop: api.stop })
    if (r.ok) { placed++; streak = 0 } else { streak++; bad.add(c.x + ',' + c.z) }
    if (placed % 16 === 15) { try { await lib('feed').eat(bot, {}) } catch (e_) { swallow('army_jobs:858', e_) } }
  }
  const left = frontier().length
  A.result(bot, { ev: 'deck_pass', job: job.id, placed, left, material: A.count(bot, item) })
  if (!left && placed === 0) {
    const board = A.readJSON(A.F.board, null)
    const me = board && (board.jobs || []).find(j => j.id === job.id)
    if (me && me.status === 'active') { me.status = 'paused'; require('fs').writeFileSync(A.F.board + '.tmp_deck', JSON.stringify(board, null, 1)); require('fs').renameSync(A.F.board + '.tmp_deck', A.F.board); A.result(bot, { ev: 'deck_done', job: job.id }) }
    return muster(bot, job, api, ctx, 'deck: layer closed')
  }
  if (streak >= 8) { await sleep(5000); return 'deck: 8 cells in a row failed (' + left + ' open cells left)' }
  return 'deck'
}

// ------------------------------------------------------------------ guard: the NIGHT SHIFT. A squad holds the lit base, kills what spawns around it and banks the drops —
// string (rods, wool, bed), bones (bone meal), arrows, gunpowder. Idle hands at night become P1 progress instead of standing in a grid.
// params: post:[x,y,z] (default muster), radius: 24, kinds (default zombie/skeleton/spider…; never creepers or endermen), minHp: 10
const RANGED_RE = /^(skeleton|stray|bogged|pillager|witch|illusioner)$/
async function guard (bot, job, api, ctx) {
  const P = job.params || {}
  const m = P.post ? null : setting(bot, 'muster')
  const post = P.post ? v(P.post) : m ? new Vec3(m.x, m.y, m.z) : bot.entity.position.floored()
  const R = P.radius || 24
  const kinds = new Set(P.kinds || ['zombie', 'skeleton', 'spider', 'husk', 'stray', 'drowned', 'zombie_villager', 'bogged', 'slime', 'witch'])
  // A NEW WORLD HAS NO ARMOURY: gear from the depot when there is one (A.kitUp), else a sword made on the spot (stone, else wood of any species), else any
  // tool or the fists - a guard that waits for a toolsmith leaves the first nights to the zombies. Unarmed guards keep the higher hp gate below.
  if (!A.bestOf(bot, 'sword') && !A.bestOf(bot, 'axe')) { await A.kitUp(bot, { stop: api.stop, risk: true, why: 'guard' }); for (const w of ['stone_sword', 'wooden_sword']) { if (A.bestOf(bot, 'sword') || A.bestOf(bot, 'axe') || api.stop()) break; await A.obtain(bot, w, 1, { stop: api.stop }) } }
  const armed = () => !!(A.bestOf(bot, 'sword') || A.bestOf(bot, 'axe'))
  if (!armed() && !bot.__armyFistSaid) { bot.__armyFistSaid = true; A.result(bot, { ev: 'guard_unarmed', job: job.id, note: 'no sword/axe carried, in stock or craftable - guarding with what is in hand' }) }
  const end = Date.now() + 120000
  let kills = 0
  task(bot, 'guard')
  while (Date.now() < end && !api.stop()) {
    const minHp = P.minHp || (armed() ? 10 : 14)
    if (bot.health < minHp) { await canteen(bot, api); if (bot.health < minHp) return muster(bot, job, api, ctx, 'guard: hurt, resting') }
    const cr = A.hostiles(bot, R).find(h => h.e.name === 'creeper')
    if (cr && bot.health >= 12 && (A.bestOf(bot, 'sword') || A.bestOf(bot, 'axe'))) { // hit-and-run: one hit, then back off > 7 blocks AWAY from the post (the fuse resets, the creeper follows us off the depot)
      task(bot, 'guard: creeper')
      let killed = false
      for (let k = 0; k < 8 && !api.stop() && bot.health >= 10; k++) {
        const e = bot.entities[cr.e.id]; if (!e || !e.isValid) { killed = true; break }
        await A.equipBest(bot, 'sword') || await A.equipBest(bot, 'axe')
        if (e.position.distanceTo(bot.entity.position) > 3) await A.travel(bot, e.position, { range: 2, ms: 6000, stop: api.stop })
        try { await bot.lookAt(e.position.offset(0, 1, 0), true); bot.attack(e) } catch (e_) { swallow('army_jobs:895', e_) }
        const a = Math.atan2(e.position.z - post.z, e.position.x - post.x)
        await A.travel(bot, { x: Math.round(e.position.x + Math.cos(a) * 9), y: null, z: Math.round(e.position.z + Math.sin(a) * 9) }, { range: 2, ms: 5000, stop: api.stop })
        await sleep(400)
      }
      A.result(bot, { ev: 'creeper', job: job.id, killed }); if (killed) { kills++; await A.pickup(bot, 8, 4000) }
      continue
    }
    const creeper = A.hostiles(bot, 7).find(h => h.e.name === 'creeper')
    if (creeper) { const p = bot.entity.position; const a = Math.atan2(p.z - creeper.e.position.z, p.x - creeper.e.position.x); await A.travel(bot, { x: Math.round(p.x + Math.cos(a) * 10), y: null, z: Math.round(p.z + Math.sin(a) * 10) }, { range: 2, ms: 8000, stop: api.stop }); continue }
    // RANGED MOBS (foreman 09-19 19:34Z: 15x "shot by Skeleton" in 30 min - unarmed, armourless guards ran 20 blocks over open ground at archers): only a guard
    // that is ARMED and (wears armour or has hp >= 14) goes after them - and those take the nearest archer FIRST (focus fire ends the shooting). Everybody
    // else fights an archer only when it stands within 4 blocks, and otherwise HOLDS THE POST in the crowd instead of walking the patrol ring.
    const me = bot.entity.position; const armourN = [5, 6, 7, 8].filter(sl => bot.inventory.slots[sl]).length
    const canChase = armed() && (armourN > 0 || bot.health >= 14)
    const rank = e => RANGED_RE.test(e.name) ? 0 : e.name === 'spider' ? 1 : 2 // archers first, then spiders (string)
    const hs = A.hostiles(bot, R).map(h => h.e).sort((a, b) => (rank(a) - rank(b)) || (a.position.distanceTo(me) - b.position.distanceTo(me)))
    const t = hs.find(e => kinds.has(e.name) && Math.hypot(e.position.x - post.x, e.position.z - post.z) <= R + 6 && Math.abs(e.position.y - me.y) < 6 && (!RANGED_RE.test(e.name) || canChase || e.position.distanceTo(me) <= 4))
    if (!t && !canChase && hs.some(e => RANGED_RE.test(e.name))) { task(bot, 'guard: holding the post (archer about, not fit to chase)'); if (A.dist2(bot, post.x, post.z) > 5) await A.travel(bot, { x: post.x, y: null, z: post.z }, { range: 3, ms: 12000, quiet: true, stop: api.stop }); await sleep(2000); continue }
    if (t) { task(bot, 'guard: ' + t.name); if (await A.kill(bot, t, 20000, api.stop)) { kills++; await sleep(300); await A.pickup(bot, 8, 5000) } continue }
    // PATROL, don't stand: walk the ring (radius 7-12) around the post — never parks on the chest row, sees more, looks alive
    const ang = Math.random() * Math.PI * 2; const rad = 7 + Math.random() * 5
    task(bot, 'guard: patrol')
    await A.travel(bot, { x: Math.round(post.x + Math.cos(ang) * rad), y: null, z: Math.round(post.z + Math.sin(ang) * rad) }, { range: 2, ms: 12000, quiet: true, stop: () => api.stop() || !!A.hostiles(bot, 12)[0] }) // a patrol point is a wish, not a destination: unreachable = pick another, no alarm
    await sleep(800)
  }
  const loot = ['string', 'bone', 'arrow', 'gunpowder', 'spider_eye', 'rotten_flesh', 'iron_ingot', 'carrot', 'potato'].reduce((n, k) => n + A.count(bot, k), 0)
  // a guard walks to the chests only with a real haul, and at most every 5 min (REPORT 09-19: depot_guard 11 chest visits in 15 min, nothing deposited:
  // one rotten_flesh by day sent it to the depot on every pass)
  if ((loot >= 8 || (api.phase() === 'day' && loot >= 4)) && Date.now() - (bot.__guardBankT || 0) > 300000 && (bot.__guardBankT = Date.now())) await A.bank(bot, { torch: 16, ...rationsOf(bot) }, { job: job.id, stop: api.stop })
  if (kills) A.result(bot, { ev: 'guard_pass', job: job.id, kills, string: A.count(bot, 'string') })
  return 'guard'
}

// ------------------------------------------------------------------ sleeper: ONE bot in a bed skips the night for all 30 (players_sleeping_percentage = 1) —
// no night = no mob waves, no creeper craters at the base, no phantoms. params: bed:[x,y,z] (a static bed; a missing one is re-placed from
// pockets/stock). The job is `when:"night"`, highest priority.
async function sleeper (bot, job, api, ctx) {
  const P = job.params || {}
  // the bed: params.bed, else the FIRST bed the build job registered (settings.respawnBeds: blueprint `dorm` bed 0) - a new world needs no hand-written coordinate
  if (!Array.isArray(P.bed)) { const rb = (A.settings().respawnBeds || [])[0]; if (!Array.isArray(rb)) return muster(bot, job, api, ctx, 'sleeper: no params.bed and no bed registered yet (settings.respawnBeds - build the dorm)'); P.bed = rb }
  const bedPos = v(P.bed)
  if (stringNight()) return guard(bot, Object.assign({}, job, { params: { radius: 28 } }), api, ctx) // stay up: tonight we hunt spiders
  // NIGHT EXPEDITION (owner: spiders are hunted on night trips; planner 09-19: the sleeper snapped the night away 60-160 s after dusk, 0 spiders):
  // while an ACTIVE job carries `params.needsNight:true` the sleeper stays up (guards the base) - the night runs its full length for that trip,
  // day jobs keep working (nightSkip stays on). The trip's plan pauses itself when done, and the next dusk is slept through again.
  try { const b = A.readJSON(A.F.board, {}) || {}; const trip = (b.jobs || []).find(j => j.status === 'active' && j.params && j.params.needsNight); if (trip) { task(bot, 'sleeper: staying up for ' + trip.id); return guard(bot, Object.assign({}, job, { params: { radius: 28 } }), api, ctx) } } catch (e_) { swallow('army_jobs:needsNight', e_) }
  if (bot.isSleeping) { task(bot, 'sleeping'); while (bot.isSleeping && !api.stop()) await sleep(1000); A.result(bot, { ev: 'slept', job: job.id }); return 'slept' }
  if (isNight(api) || bot.time.isDay === false || (bot.time.timeOfDay >= 12542 && bot.time.timeOfDay < 23460) || bot.thunderState > 0) {
    task(bot, 'sleeper: to bed')
    if (bot.entity.position.distanceTo(bedPos) > 2.5 && !await A.travel(bot, bedPos, { range: 2, ms: 120000, stop: api.stop })) return 'sleeper: cannot reach the bed'
    const bed = bot.blockAt(bedPos)
    if (!bed || !bot.isABed(bed)) {
      // THE BED IS GONE (a creeper, a mistake; 09-19: the item was banked "like loot" while nights stayed real and 7 bots died).
      // A sleeper puts it back by itself: any bed from its pockets or the stock goes onto the old spot. No bed anywhere -> report, then muster.
      const bedItem = () => bot.inventory.items().find(i => /_bed$/.test(i.name))
      if (!bedItem()) { const idx = A.index(); const names = new Set(); for (const e of Object.values(idx)) for (const k of Object.keys(e.items || {})) if (/_bed$/.test(k)) names.add(k); for (const nm of names) { if (await A.withdraw(bot, nm, 1, { stop: api.stop })) break } }
      const it = bedItem()
      if (it) { const r = await A.placeHard(bot, bedPos, it.name, { stop: api.stop }); const b2 = bot.blockAt(bedPos); if (b2 && bot.isABed(b2)) { A.result(bot, { ev: 'bed_replaced', at: P.bed, item: it.name }); return 'sleeper: bed replaced' } A.result(bot, { ev: 'bed_missing', at: P.bed, why: 'have a bed but could not place it: ' + String(r && r.reason || '?').slice(0, 40) }); return muster(bot, job, api, ctx, 'sleeper: bed not placeable') }
      A.result(bot, { ev: 'bed_missing', at: P.bed, why: 'no bed in pockets or stock' }); return muster(bot, job, api, ctx, 'sleeper: no bed at ' + P.bed)
    }
    try { await U.withTimeout(bot.sleep(bed), 8000, 'sleep'); A.result(bot, { ev: 'in_bed', job: job.id, time: bot.time.timeOfDay }) } catch (e) {
      const m = String(e && e.message || e)
      if (/monsters/i.test(m)) { const h = A.hostiles(bot, 10)[0]; if (h && h.e.name !== 'creeper' && A.bestOf(bot, 'sword')) await A.kill(bot, h.e, 12000, api.stop) } // "monsters nearby": clear them, try again
      else if (!/not night|can only sleep/i.test(m)) A.result(bot, { ev: 'sleep_failed', why: m.slice(0, 80) })
      await sleep(3000)
    }
    return 'sleeper'
  }
  task(bot, 'sleeper: waiting for dusk')
  const slot = bedPos.offset(1, 0, 1)
  if (A.dist2(bot, slot.x, slot.z) > 4) await A.travel(bot, slot, { range: 3, ms: 60000, stop: api.stop })
  const end = Date.now() + 20000; while (Date.now() < end && !api.stop()) await sleep(1000)
  return 'sleeper'
}

// ------------------------------------------------------------------ light: torch grid over an area — algorithmic, any number of bots, no pinned names.
// params: box:[x1,z1,x2,z2], step: 8 (grid pitch; light level 1+ stops hostile spawns in 1.18+, a torch covers ~7 blocks on flat ground),
//         avoid:[[x1,z1,x2,z2],…] boxes that must stay torch-free (farm soil!). Each bot takes the nearest unlit grid point; a point counts as
//         lit when any torch stands within 3 blocks of it. Ground level is read per column; torches go ON the ground, never on pillars.
async function light (bot, job, api, ctx) {
  const BL = lib('blocks')
  const P = job.params || {}
  const [x1, z1, x2, z2] = [Math.min(P.box[0], P.box[2]), Math.min(P.box[1], P.box[3]), Math.max(P.box[0], P.box[2]), Math.max(P.box[1], P.box[3])]
  const step = P.step || 8
  if (isNight(api) && !P.night) return muster(bot, job, api, ctx, 'light: night')
  if (A.count(bot, 'torch') < 4) {
    await A.withdraw(bot, 'torch', 32, { stop: api.stop })
    if (!A.count(bot, 'torch')) { // make them: 1 coal/charcoal + 1 stick -> 4 torches, at the depot table
      task(bot, 'light: crafting torches')
      if (!A.count(bot, 'coal') && !A.count(bot, 'charcoal')) { await A.withdraw(bot, 'coal', 8, { stop: api.stop }); if (!A.count(bot, 'coal')) await A.withdraw(bot, 'charcoal', 8, { stop: api.stop }) }
      if (A.count(bot, 'stick') < 8) await A.withdraw(bot, 'stick', 8, { stop: api.stop })
      const fuel = A.count(bot, 'coal') + A.count(bot, 'charcoal')
      if (fuel && A.count(bot, 'stick')) { const tb = (A.chestsOf('tools')[0] || musterSlot(bot)); await A.travel(bot, tb, { range: 4, ms: 60000, stop: api.stop }); await VERBS.craft(bot, { item: 'torch', n: Math.min(8, fuel, A.count(bot, 'stick')) }, api) }
    }
    if (!A.count(bot, 'torch')) return muster(bot, job, api, ctx, 'light: no torches and no coal+sticks in stock')
  }
  const st = bot.__armyLight = (bot.__armyLight && bot.__armyLight.key === job.id + ':' + (job.rev || 0)) ? bot.__armyLight : { key: job.id + ':' + (job.rev || 0), bad: {}, done: {} }
  const avoid = (x, z) => (P.avoid || []).some(b => x >= Math.min(b[0], b[2]) && x <= Math.max(b[0], b[2]) && z >= Math.min(b[1], b[3]) && z <= Math.max(b[1], b[3]))
  const pts = []
  for (let x = x1; x <= x2; x += step) for (let z = z1; z <= z2; z += step) if (!avoid(x, z) && !st.done[x + ',' + z] && (st.bad[x + ',' + z] || 0) < 2) pts.push([x, z])
  if (!pts.length) { A.result(bot, { ev: 'light_done', job: job.id }); A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: grid complete' } }); return muster(bot, job, api, ctx, 'light: grid complete') }
  const me = bot.entity.position
  pts.sort((a, b) => Math.hypot(a[0] - me.x, a[1] - me.z) - Math.hypot(b[0] - me.x, b[1] - me.z))
  // spread the squad: bot k of the job takes the k-th nearest point
  const names = (job.names && job.names.length ? job.names : (A.settings().roster || []))
  const [px, pz] = pts[Math.min(pts.length - 1, Math.max(0, names.indexOf(bot.username)) % Math.min(pts.length, 4))]
  const key = px + ',' + pz
  task(bot, 'light ' + key)
  if (A.dist2(bot, px, pz) > 5 && !await A.travel(bot, { x: px, y: null, z: pz }, { range: 4, ms: 120000, stop: api.stop })) { st.bad[key] = (st.bad[key] || 0) + 1; return 'light: cannot reach ' + key }
  let gy = null
  for (let y = Math.floor(bot.entity.position.y) + 12; y >= bot.entity.position.y - 16; y--) { const b = bot.blockAt(new Vec3(px, y, pz)); if (b && b.boundingBox === 'block' && !/leaves|_log$/.test(b.name)) { gy = y; break } }
  if (gy == null) { st.bad[key] = 2; return 'light: no ground at ' + key }
  const tid = [bot.registry.blocksByName.torch.id, bot.registry.blocksByName.wall_torch.id]
  if (bot.findBlocks({ matching: tid, maxDistance: 3, count: 1, point: new Vec3(px, gy + 1, pz) }).length) { st.done[key] = 1; return 'light: already lit ' + key }
  const top = bot.blockAt(new Vec3(px, gy + 1, pz))
  if (top && top.name === 'snow') await BL.digBlock(bot, new Vec3(px, gy + 1, pz), { collect: false, requireHarvest: false }).catch(e_ => swallow('army_jobs:987', e_))
  const r = await BL.placeTorch(bot, new Vec3(px, gy + 1, pz), {}).catch(e => ({ ok: false, reason: String(e && e.message) }))
  if (r && r.ok) { st.done[key] = 1; bot.__armyLit = (bot.__armyLit || 0) + 1; A.result(bot, { ev: 'torch', job: job.id, at: [px, gy + 1, pz], n: bot.__armyLit }) } else st.bad[key] = (st.bad[key] || 0) + 1
  return 'light'
}

// ------------------------------------------------------------------ berries: the food engine that fits THIS biome. Sweet berry bushes grow wild in taiga, need no water, no tilling,
// no seeds from grass, survive snow, and regrow after every picking (right-click, the bush stays). Picked berries are food (2 points) AND
// planting stock: a berry placed on grass/dirt becomes a new bush. params: site:[x,y,z] wild patch (from scouts: `crops` in scout.jsonl),
// radius: 40, haul: 48, plantBox:[x1,z1,x2,z2]+plantY (optional hedge-farm at base: every 2nd cell so bots can reach each bush from a gap).
async function berries (bot, job, api, ctx) {
  const BL = lib('blocks')
  const P = job.params || {}
  const site = v(job.site || P.site)
  const bushId = bot.registry.blocksByName.sweet_berry_bush.id
  const age = b => { try { return +b.getProperties().age } catch { return b.metadata } }
  const dusk = A.settings().dusk || 11800
  const secLeft = () => A.settings().nightSkip ? 1e9 : (dusk - api.time()) / 20
  const homeP = A.chestsOf('food')[0] || musterSlot(bot) // where the trip ends: the daylight arithmetic is measured to it
  const st = bot.__armyBerries = (bot.__armyBerries && bot.__armyBerries.key === job.id + ':' + (job.rev || 0)) ? bot.__armyBerries : { key: job.id + ':' + (job.rev || 0), phase: 'idle', picked: 0 }
  const badBush = {}
  const pickAround = async (centre, r, until) => {
    let n = 0; let dry = 0
    while (!api.stop() && dry < 3 && !until()) {
      const ripe = bot.findBlocks({ matching: bushId, maxDistance: Math.min(r, 48), count: 60, point: centre }).map(p => bot.blockAt(p)).filter(b => b && age(b) >= 2)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      if (!ripe.length) { dry++; await sleep(1500); continue }
      // NEVER walk into the bushes (they poke: 4 bots died picking on 09-19). Pick from OUTSIDE: stand on a free cell within reach of the
      // bush; bushes that cannot be reached from a free cell are skipped. Hurt pickers go home.
      if (bot.health < 8) break
      const b = ripe.find(q => !badBush[q.position.x + ',' + q.position.z])
      if (!b) { dry++; await sleep(1500); continue }
      if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 3.2) {
        const free = c => { const f = bot.blockAt(c.offset(0, -1, 0)); const a = bot.blockAt(c); const h = bot.blockAt(c.offset(0, 1, 0)); return f && f.boundingBox === 'block' && a && a.name !== 'sweet_berry_bush' && a.boundingBox === 'empty' && h && h.boundingBox === 'empty' && ![[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => (bot.blockAt(c.offset(dx, 0, dz)) || {}).name === 'sweet_berry_bush') }
        const stands = []
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1, -1]) { const c = b.position.offset(dx, dy, dz); if ((dx || dz) && free(c)) stands.push(c) }
        stands.sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position))
        let ok = false
        for (const c of stands.slice(0, 3)) { if (await A.travel(bot, c, { range: 0, ms: 15000, stop: api.stop, noRelax: true, quiet: true })) { ok = true; break } }
        if (!ok) { badBush[b.position.x + ',' + b.position.z] = 1; continue }
      }
      try { await bot.lookAt(b.position.offset(0.5, 0.4, 0.5), true); await U.withTimeout(bot.activateBlock(bot.blockAt(b.position)), 3000, 'pick'); n++; dry = 0; await sleep(350); await A.pickup(bot, 4, 2500) } catch { dry++ }
    }
    return n
  }
  if (isNight(api)) return muster(bot, job, api, ctx, 'berries: night')
  // DEMOLISH (owner: "sometimes everything must be torn down and rebuilt"): params.demolish = [x1,z1,x2,z2] removes every bush plus the cobble
  // posts/roofs of a failed hedge — dug from outside (blocks.js never stands in a bush), berries and cobble collected. Rebuild = a `build` job
  // on a LEVELLED pad, away from traffic.
  if (P.demolish) {
    const D = P.demolish; const [a1, b1, a2, b2] = [Math.min(D[0], D[2]), Math.min(D[1], D[3]), Math.max(D[0], D[2]), Math.max(D[1], D[3])]
    task(bot, 'berries: demolishing the old hedge')
    if (A.dist2(bot, (a1 + a2) / 2, (b1 + b2) / 2) > 30) await A.travel(bot, { x: Math.round((a1 + a2) / 2), y: null, z: b1 - 2 }, { range: 4, ms: 180000, stop: api.stop, noRelax: true })
    const by0 = Math.floor(bot.entity.position.y); const targets = []
    for (let x = a1; x <= a2; x++) for (let z = b1; z <= b2; z++) for (let y = by0 + 6; y >= by0 - 6; y--) {
      const b = bot.blockAt(new Vec3(x, y, z)); if (!b) continue
      if (b.name === 'sweet_berry_bush') targets.push(b.position)
      else if (b.name === 'cobblestone' && (bot.blockAt(new Vec3(x, y - 1, z)) || {}).name === 'sweet_berry_bush') targets.push(b.position)
    }
    targets.sort((p, q) => (q.y - p.y) || (p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position)))
    let n = 0
    for (const t of targets.slice(0, 40)) { if (api.stop() || bot.health < 8) break; const r = await BL.digBlock(bot, t, { collect: true, requireHarvest: false }).catch(e_ => { swallow('army_jobs:demolish', e_); return { ok: false } }); if (r.ok) n++ }
    A.result(bot, { ev: 'hedge_demolished', job: job.id, removed: n, left: Math.max(0, targets.length - n) })
    if (!targets.length) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.params) { delete j.params.demolish; delete j.params.plantBox } })
    await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop })
    return 'berries: demolish'
  }
  // hedge-farm at base first: pick what is ripe there, plant what we carry
  if (P.plantBox && P.plantY != null) {
    const [x1, z1, x2, z2] = [Math.min(P.plantBox[0], P.plantBox[2]), Math.min(P.plantBox[1], P.plantBox[3]), Math.max(P.plantBox[0], P.plantBox[2]), Math.max(P.plantBox[1], P.plantBox[3])]
    const c = new Vec3(Math.round((x1 + x2) / 2), P.plantY + 1, Math.round((z1 + z2) / 2))
    // HOME MODE (params.wild:false): the hedge is the berry farm - plant it from STOCK, pick it, bank; no 165-block trips to the wild patch
    // (foreman 09-19: trips picked 0-11 berries, one bot suffocated there, while 220 berries sat in the depot and the new hedge stood empty)
    if (P.wild === false) {
      if (A.count(bot, 'sweet_berries') < 8) await A.withdraw(bot, 'sweet_berries', 32, { stop: api.stop })
      if (A.dist2(bot, c.x, c.z) > 16 && !await A.travel(bot, c, { range: 12, ms: 240000, stop: api.stop, noRelax: true })) return 'berries: cannot reach the hedge'
    }
    if (A.dist2(bot, c.x, c.z) < 60) {
      task(bot, 'berries: hedge farm')
      const picked0 = await pickAround(c, 24, () => false); st.picked += picked0
      // HEDGE LAYOUT (owner: "place the berries with more thought"): bushes hurt and block the pathfinder, so the hedge is built like a
      // real berry farm —  lane | bush | bush | lane | bush | bush …  along z, plus a cross lane every 9 blocks along x:
      //   * every bush touches a lane, so it is picked from OUTSIDE (reach 3) and nobody ever walks through a bush;
      //   * lanes stay walkable ground forever (never planted; a bush found on a lane cell is dug up and replanted properly);
      //   * nothing is planted next to a pit/ledge (all 4 neighbours must be level ground or hedge), so no bush can wall a bot in.
      const isLane = (x, z) => ((z - z1) % 3 === 0) || ((x - x1) % 9 === 0)
      // terrain following: find each column's soil within +-2 of plantY
      const soilYOf = (x, z) => { for (const dy of [0, 1, 2, -1, -2]) { const g = bot.blockAt(new Vec3(x, P.plantY + dy, z)); const a = bot.blockAt(new Vec3(x, P.plantY + dy + 1, z)); if (g && a && /^(grass_block|dirt|podzol|coarse_dirt)$/.test(g.name) && a.boundingBox === 'empty') return P.plantY + dy } return null }
      let planted = 0; let moved = 0
      for (let x = x1; x <= x2 && !api.stop(); x++) for (let z = z1; z <= z2 && !api.stop(); z++) { // 1. clear the lanes
        const sy0 = soilYOf(x, z); if (sy0 == null) continue
        const t = bot.blockAt(new Vec3(x, sy0 + 1, z))
        if (t && t.name === 'sweet_berry_bush' && isLane(x, z)) { const r = await BL.digBlock(bot, t.position, { collect: true, requireHarvest: false }).catch(() => ({ ok: false })); if (r.ok) moved++ }
      }
      if (moved) await A.pickup(bot, 6, 3000)
      for (let x = x1; x <= x2 && A.count(bot, 'sweet_berries') > 0 && !api.stop(); x++) for (let z = z1; z <= z2 && A.count(bot, 'sweet_berries') > 0 && !api.stop(); z++) { // 2. fill the bush rows
        if (isLane(x, z)) continue
        const sy = soilYOf(x, z); if (sy == null) continue
        const top = bot.blockAt(new Vec3(x, sy + 1, z)); if (!top) continue
        if (![[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => { const n = soilYOf(x + dx, z + dz); return n != null && Math.abs(n - sy) <= 1 })) continue // no pits/ledges beside a bush
        if (top.name === 'snow') await BL.digBlock(bot, top.position, { collect: false, requireHarvest: false }).catch(e_ => swallow('army_jobs:1059', e_))
        else if (top.name !== 'air') continue
        // stand in a LANE while planting (never between the rows)
        const r = await BL.placeBlock(bot, new Vec3(x, sy + 1, z), 'sweet_berries', { expect: 'sweet_berry_bush', faces: [new Vec3(0, 1, 0)] }).catch(() => ({ ok: false }))
        if (r.ok && !r.already) planted++
      }
      if (moved) A.result(bot, { ev: 'berries_moved', job: job.id, n: moved })
      // 3. ROOF (owner's idea): a solid block right above a bush leaves a 1-high gap — nobody (bot, player, pathfinder) can step INTO the
      //    bush any more, while it is still picked through its side from the lane and keeps growing on the lanes' light. Each 8-long
      //    strip starts with a 2-high cobble POST (first cell after a cross lane); the roof grows from the post, block by block.
      const isPost = (x, z) => !isLane(x, z) && ((x - x1) % 9 === 1)
      if (A.count(bot, 'cobblestone') < 16) await A.withdraw(bot, 'cobblestone', 64, { stop: api.stop })
      let roofed = 0
      for (let x = x1; x <= x2 && roofed < 40 && A.count(bot, 'cobblestone') > 0 && !api.stop(); x++) for (let z = z1; z <= z2 && roofed < 40 && A.count(bot, 'cobblestone') > 0 && !api.stop(); z++) {
        if (isLane(x, z)) continue
        let sy = soilYOf(x, z)
        if (sy == null) { for (const dy of [0, 1, 2, -1, -2]) { const g = bot.blockAt(new Vec3(x, P.plantY + dy, z)); const a = bot.blockAt(new Vec3(x, P.plantY + dy + 1, z)); if (g && a && /^(grass_block|dirt|podzol|coarse_dirt)$/.test(g.name) && a.name === 'cobblestone') { sy = P.plantY + dy; break } } }
        if (sy == null) continue
        const cell = bot.blockAt(new Vec3(x, sy + 1, z)); const roof = bot.blockAt(new Vec3(x, sy + 2, z))
        if (!cell || !roof) continue
        if (isPost(x, z)) {
          if (cell.name === 'air' || cell.name === 'snow') { if (cell.name === 'snow') await BL.digBlock(bot, cell.position, { collect: false, requireHarvest: false }).catch(e_ => swallow('army_jobs:1080', e_)); const r = await BL.placeBlock(bot, new Vec3(x, sy + 1, z), 'cobblestone', {}).catch(() => ({})); if (r.ok) roofed++ }
          if (roof.name === 'air' && (bot.blockAt(new Vec3(x, sy + 1, z)) || {}).name === 'cobblestone') { const r = await BL.placeBlock(bot, new Vec3(x, sy + 2, z), 'cobblestone', {}).catch(() => ({})); if (r.ok) roofed++ }
        } else if (cell.name === 'sweet_berry_bush' && roof.name === 'air') {
          // the roof over a BUSH is a cobblestone WALL, never a full block: a bush only grows while the raw light in the block above it is >= 9
          // (SweetBerryBushBlock.randomTick) - an opaque roof reads 0 and stops the hedge for good (base-works engineer 09-19)
          if (!A.count(bot, 'cobblestone_wall')) { await A.withdraw(bot, 'cobblestone_wall', 16, { stop: api.stop }); if (!A.count(bot, 'cobblestone_wall')) continue }
          const r = await BL.placeBlock(bot, new Vec3(x, sy + 2, z), 'cobblestone_wall', { retries: 0 }).catch(() => ({})) // 'noref' until the strip's roof has grown this far — next visit
          if (r.ok) roofed++
        }
      }
      if (roofed) A.result(bot, { ev: 'berries_roofed', job: job.id, n: roofed })
      if (planted) A.result(bot, { ev: 'berries_planted', job: job.id, n: planted })
      // WHAT WE PLANTED MUST STILL BE THERE (owner 09-19: ~100 of 173 planted bushes had been pulled out and nobody noticed - the squad just
      // replanted empty cells without a word). Count the bushes on the pad every visit; a drop of 10+ against the last count = `hedge_damaged`.
      try {
        const AF = require('path').join(A.DIR, 'asset_audit.json'); const au = A.readJSON(AF, {}) || {}
        let nb = 0; for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) for (const dy of [0, 1, 2]) { const b = bot.blockAt(new Vec3(x, P.plantY + dy, z)); if (b && b.name === 'sweet_berry_bush') { nb++; break } }
        const prev = au[job.id]
        if (prev && prev.n - nb >= 10 && Date.now() - (prev.alarmT || 0) > 600000) { A.result(bot, { ev: 'hedge_damaged', job: job.id, was: prev.n, now: nb }); au[job.id] = { n: nb, t: Date.now(), alarmT: Date.now() } } else au[job.id] = { n: Math.max(nb, 0), t: Date.now(), alarmT: prev && prev.alarmT }
        A.writeJSON(AF, au)
      } catch (e_) { swallow('army_jobs:hedgeAudit', e_) }
      if (P.wild === false) {
        if (A.count(bot, 'sweet_berries') > 24) await A.bank(bot, { torch: 16, sweet_berries: 8 }, { job: job.id, stop: api.stop })
        if (!planted && !picked0) { A.decline(bot, job, 600000, 'berries: hedge planted, nothing ripe yet'); return 'berries: growing' }
        return 'berries: hedge'
      }
    }
    if (P.wild === false) return 'berries: hedge out of range'
  }
  if (st.phase === 'idle') {
    const trip = (A.dist2(bot, site.x, site.z) / 3 + 45) * 2 + 120
    if (secLeft() < trip) { if (A.count(bot, 'sweet_berries') > (P.keep == null ? 8 : P.keep) + 8) await A.bank(bot, { torch: 16 }, { job: job.id, stop: api.stop }); return muster(bot, job, api, ctx, 'berries: not enough daylight for the trip (' + Math.round(trip) + ' s)') }
    st.phase = 'out'
  }
  if (st.phase === 'out') {
    task(bot, 'berries: to the wild patch')
    if (!await A.travel(bot, site, { noRelax: true, range: 10, ms: 420000, stop: () => api.stop() || secLeft() < A.dist2(bot, homeP.x, homeP.z) / 3 + 45, via: P.via })) { st.phase = 'home' } else st.phase = 'work'
  }
  if (st.phase === 'work') {
    task(bot, 'berries: picking')
    const homeLeg = () => A.dist2(bot, homeP.x, homeP.z) / 3 + 60
    st.picked += await pickAround(site, P.radius || 40, () => A.count(bot, 'sweet_berries') >= (P.haul || 48) || secLeft() < homeLeg())
    try { await lib('feed').eat(bot, {}) } catch (e_) { swallow('army_jobs:1104', e_) }
    st.phase = 'home'
  }
  if (st.phase === 'home') {
    task(bot, 'berries: home')
    if (!await A.travel(bot, homeP, { noRelax: true, range: 4, ms: 420000, stop: api.stop, via: (P.via || []).slice().reverse() })) return 'berries: not home yet'
    const keep = { torch: 16 }; if (P.plantBox) keep.sweet_berries = Math.min(A.count(bot, 'sweet_berries'), P.keep == null ? 4 : P.keep) // a little planting stock; the rest FEEDS the army now
    const moved = await A.bank(bot, keep, { job: job.id, stop: api.stop })
    A.result(bot, { ev: 'berry_trip', job: job.id, picked: st.picked, banked: moved.sweet_berries || 0 })
    st.phase = 'idle'; st.picked = 0
  }
  return 'berries'
}

// ------------------------------------------------------------------ cane: sugar cane = paper = books (P4: enchanting table + 15 bookshelves = 46 books = 138 cane)
// Cane is no field crop: no hoe, no tilling, no ripeness. It stands on sand/dirt/grass whose SOIL block touches water horizontally and grows 3 high.
// ONE routine for both places it grows:
//   farm  params {box:[x1,z1,x2,z2], y: shore soil level, bankAt:48} + job.site = a DRY approach point: every shore cell of the box is a cane cell, found by LOOKING
//         (terrain following +-1; farmland and wet cells are never cane cells). Cut, replant the empty cells from the pockets/the depot, bank the surplus.
//   wild  params {wild:true, sites:[[x,y,z],…] (besides job.site), radius:32, haul:64, farm:'<cane farm job id>', until:32}: walk to a wild stand, cut the same way,
//         carry it home; the job pauses itself once the farm holds `until` plants (`cane_wild_done`) - re-activate it whenever more cane is wanted quickly.
// CUT = break the SECOND block of every cane >= 2 high: the base stays and regrows - nothing is replanted that need not die. Water is never touched
// (digBlock plug:false - the default would plug the lake beside every cane). Events: cane_pass {cut,planted,standing,cells} · cane_trip {cut,banked} ·
// cane_wild_done · crops_vanished {was,now} (10+ plants gone between two visits; cane cannot be trampled: look who digs there).
const CANE_SOIL = /^(sand|red_sand|dirt|grass_block|podzol|coarse_dirt|rooted_dirt|moss_block|mud)$/
const caneWet = (bot, p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => (bot.blockAt(p.offset(dx, 0, dz)) || {}).name === 'water')
const caneHeight = (bot, base) => { let h = 0; while (h < 5 && (bot.blockAt(base.offset(0, h, 0)) || {}).name === 'sugar_cane') h++; return h }
function caneCells (bot, x1, z1, x2, z2, y) { // -> [{base: Vec3 of the cane's first block, h: blocks of cane standing (0 = empty shore cell)}]
  const out = []
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) for (const dy of [1, 0, -1]) {
    const soil = bot.blockAt(new Vec3(x, y + dy, z)); if (!soil || !CANE_SOIL.test(soil.name)) continue
    const top = bot.blockAt(new Vec3(x, y + dy + 1, z)); if (!top) continue
    if (top.name === 'sugar_cane') { out.push({ base: top.position, h: caneHeight(bot, top.position) }); break }
    if (/^(air|short_grass|fern|snow)$/.test(top.name) && caneWet(bot, soil.position)) { out.push({ base: top.position, h: 0 }); break }
  }
  return out
}
function caneWild (bot, r) { // every cane stand in view within r: [{base, h}]
  const seen = new Set(); const out = []
  for (const p of bot.findBlocks({ matching: bot.registry.blocksByName.sugar_cane.id, maxDistance: Math.min(r, 48), count: 800 })) {
    let b = p; while ((bot.blockAt(b.offset(0, -1, 0)) || {}).name === 'sugar_cane') b = b.offset(0, -1, 0)
    const k = b.x + ',' + b.y + ',' + b.z; if (seen.has(k)) continue; seen.add(k)
    out.push({ base: b, h: caneHeight(bot, b) })
  }
  return out
}
// cut every stand >= 2 high, nearest first; bad = stands this bot could not get at (skipped for the rest of its shift). -> stands cut
async function caneCut (bot, list, api, bad, until) {
  const BL = lib('blocks'); let n = 0
  const todo = list.filter(c => c.h >= 2 && !bad[c.base.x + ',' + c.base.z])
  while (todo.length && !api.stop() && !(until && until()) && bot.health >= 8) {
    const me = bot.entity.position; todo.sort((a, b) => a.base.distanceTo(me) - b.base.distanceTo(me)); const c = todo.shift()
    if (caneHeight(bot, c.base) < 2) continue // a team-mate was faster
    if (c.base.distanceTo(me) > 4.5 && !await A.travel(bot, c.base, { range: 3, ms: 45000, stop: api.stop, quiet: true })) { if (!api.stop()) bad[c.base.x + ',' + c.base.z] = 1; continue }
    const r = await BL.digBlock(bot, c.base.offset(0, 1, 0), { collect: true, requireHarvest: false, plug: false }).catch(e_ => { swallow('army_jobs:caneCut', e_); return { ok: false } })
    if (r.ok && !r.already) n++; else if (!r.ok && r.reason !== 'locked') bad[c.base.x + ',' + c.base.z] = 1
  }
  if (n) await A.pickup(bot, 6, 4000)
  return n
}
// plant what the pockets hold into the empty shore cells of a farm box, nearest first -> planted. box = [x1,z1,x2,z2] sorted
async function canePlant (bot, box, y, api, bad) {
  const BL = lib('blocks'); let planted = 0
  const todo = caneCells(bot, box[0], box[1], box[2], box[3], y).filter(c => c.h === 0 && !bad[c.base.x + ',' + c.base.z])
  while (todo.length && A.count(bot, 'sugar_cane') > 0 && !api.stop()) {
    const me = bot.entity.position; todo.sort((a, b) => a.base.distanceTo(me) - b.base.distanceTo(me)); const c = todo.shift(); const k = c.base.x + ',' + c.base.z
    if (c.base.distanceTo(me) > 4.5 && !await A.travel(bot, c.base, { range: 3, ms: 45000, stop: api.stop, quiet: true })) { if (!api.stop()) bad[k] = 1; continue }
    const r = await BL.placeBlock(bot, c.base, 'sugar_cane', { expect: 'sugar_cane', faces: [new Vec3(0, 1, 0)] }).catch(e_ => { swallow('army_jobs:canePlant', e_); return { ok: false } })
    if (r.ok && !r.already) planted++; else if (!r.ok && r.reason !== 'locked') bad[k] = 1
  }
  return planted
}
// WHAT WE PLANTED MUST STILL STAND (same audit as the hedge): plants counted at every visit (asset_audit.json, also what `cane_wild` reads); 10+ fewer than last time = alarm
function caneAudit (bot, jobId, cells) {
  const standing = cells.filter(c => c.h > 0).length
  try {
    if (!cells.length) return standing
    const AF = require('path').join(A.DIR, 'asset_audit.json'); const au = A.readJSON(AF, {}) || {}; const prev = au[jobId]
    if (prev && prev.n - standing >= 10 && Date.now() - (prev.alarmT || 0) > 600000) { A.result(bot, { ev: 'crops_vanished', job: jobId, was: prev.n, now: standing, at: [Math.round(bot.entity.position.x), Math.round(bot.entity.position.z)] }); au[jobId] = { n: standing, cells: cells.length, t: Date.now(), alarmT: Date.now() } } else au[jobId] = { n: standing, cells: cells.length, t: Date.now(), alarmT: prev && prev.alarmT }
    A.writeJSON(AF, au)
  } catch (e_) { swallow('army_jobs:caneAudit', e_) }
  return standing
}
async function cane (bot, job, api, ctx) {
  const BL = lib('blocks'); const P = job.params || {}
  const st = bot.__armyCane = (bot.__armyCane && bot.__armyCane.key === job.id + ':' + (job.rev || 0)) ? bot.__armyCane : { key: job.id + ':' + (job.rev || 0), phase: 'idle', cut: 0, trips: 0, empty: {}, bad: {} }
  const AF = require('path').join(A.DIR, 'asset_audit.json')
  // nothing to do for ANYBODY: the job rests on the board (dispatcher: restUntil); the dispatcher needs a few seconds to see it - wait for the new assignment instead of re-running the slice 4x a second
  const rest = async (ms, why) => { A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j) j.restUntil = Date.now() + ms }); A.decline(bot, job, ms, why); task(bot, why); const t1 = Date.now() + 20000; while (Date.now() < t1 && !api.stop()) await sleep(500); return why }
  if (isNight(api) && !P.night) return muster(bot, job, api, ctx, 'cane: night')
  if (P.wild) {
    const sites = [job.site].concat(P.sites || []).filter(q => Array.isArray(q) && q.length === 3 && Number.isFinite(q[0]) && Number.isFinite(q[2]))
    if (!sites.length) return muster(bot, job, api, ctx, 'cane: a wild job needs site [x,y,z] (grep cane bots/army/scout.jsonl)')
    // A STAND FOUND EMPTY IS EMPTY FOR THE WHOLE SQUAD for 30 min (foreman 02:26Z, BUGS 129: every newly assigned bot walked 180 blocks to learn it again): shared in asset_audit.json
    const haul = P.haul || 64; const sk = i => job.id + ':site' + i
    const fresh = i => { const sh = ((A.readJSON(AF, {}) || {})[sk(i)] || {}).t || 0; return !(Date.now() - Math.max(st.empty[i] || 0, sh) < 1800000) }
    const markEmpty = i => { st.empty[i] = Date.now(); try { const au = A.readJSON(AF, {}) || {}; au[sk(i)] = { t: Date.now(), by: bot.username }; A.writeJSON(AF, au) } catch (e_) { swallow('army_jobs:caneSiteEmpty', e_) } }
    if (st.phase === 'idle') {
      if (A.count(bot, 'sugar_cane') >= haul) st.phase = 'home'
      else {
        const farmN = P.farm ? (((A.readJSON(AF, {}) || {})[P.farm] || {}).n || 0) : 0
        if (P.farm && farmN >= (P.until || 32)) {
          A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j) { j.status = 'paused'; j.note = 'auto-paused: ' + P.farm + ' holds ' + farmN + ' plants (re-activate for more wild cane)' } })
          A.result(bot, { ev: 'cane_wild_done', job: job.id, farm: P.farm, plants: farmN })
          if (A.count(bot, 'sugar_cane')) await A.bank(bot, { torch: 16, ...rationsOf(bot) }, { job: job.id, stop: api.stop })
          return 'cane: the farm holds ' + farmN + ' plants - wild trips are over'
        }
        const idx = Math.max(0, (A.settings().roster || []).indexOf(bot.username)); let pick = -1
        for (let k = 0; k < sites.length && pick < 0; k++) { const i = (idx + st.trips + k) % sites.length; if (fresh(i)) pick = i }
        if (pick < 0) { if (A.count(bot, 'sugar_cane')) st.phase = 'home'; else return rest(1200000, 'cane: every wild stand is cut down to its bases - regrowing (20 min)') } else { st.site = pick; st.phase = 'out' }
      }
    }
    if (st.phase === 'out') {
      const s = sites[st.site] || sites[0]
      task(bot, 'cane: to the wild stand ' + s[0] + ',' + s[2])
      if (await A.travel(bot, { x: s[0], y: s[1], z: s[2] }, { range: 6, ms: 420000, stop: api.stop, via: P.via })) st.phase = 'work'
      else if (api.stop()) return 'cane: on the way'
      else { markEmpty(st.site); A.result(bot, { ev: 'cane_unreached', job: job.id, site: s, from: [Math.round(bot.entity.position.x), Math.round(bot.entity.position.y), Math.round(bot.entity.position.z)] }); st.phase = A.count(bot, 'sugar_cane') ? 'home' : 'idle'; st.trips++; return 'cane: wild stand unreachable' }
    }
    if (st.phase === 'work') {
      task(bot, 'cane: cutting wild cane')
      const n = await caneCut(bot, caneWild(bot, P.radius || 32), api, st.bad, () => A.count(bot, 'sugar_cane') >= haul)
      if (api.stop()) return 'cane: cutting'
      st.cut += n
      try { await lib('feed').eat(bot, {}) } catch (e_) { swallow('army_jobs:caneEat', e_) }
      const full = A.count(bot, 'sugar_cane') >= haul
      if (n && !full && caneWild(bot, P.radius || 32).some(c => c.h >= 2 && !st.bad[c.base.x + ',' + c.base.z])) return 'cane: cutting' // more stands here
      if (!full) markEmpty(st.site)
      if (!n) { const all = caneWild(bot, P.radius || 32); A.result(bot, { ev: 'cane_wild_empty', job: job.id, site: sites[st.site], stands: all.length, tall: all.filter(c => c.h >= 2).length, unreachable: all.filter(c => c.h >= 2 && st.bad[c.base.x + ',' + c.base.z]).length, first: all[0] ? [all[0].base.x, all[0].base.y, all[0].base.z] : null }) }
      st.trips++
      st.phase = (!full && sites.some((q, i) => fresh(i))) ? 'idle' : 'home' // the next stand first while the pockets are light
      if (st.phase === 'idle') return 'cane: next stand'
    }
    if (st.phase === 'home') {
      if (!A.count(bot, 'sugar_cane')) { st.phase = 'idle'; st.cut = 0; return 'cane: came home empty' }
      // HOME = THE FARM while it has open cells: the first stock is planted by the bot that carries it (09-20: a trip's 6 cane were banked in a lumber-camp chest 250 blocks from the shore)
      let plantedHome = 0
      const FJ = P.farm ? (((A.readJSON(A.F.board, {}) || {}).jobs) || []).find(j => j.id === P.farm && j.type === 'cane' && j.params && Array.isArray(j.params.box) && j.params.box.length === 4 && typeof j.params.y === 'number' && Array.isArray(j.site)) : null
      if (FJ) {
        task(bot, 'cane: carrying ' + A.count(bot, 'sugar_cane') + ' cane to ' + FJ.id)
        const fb = FJ.params.box; const box = [Math.min(fb[0], fb[2]), Math.min(fb[1], fb[3]), Math.max(fb[0], fb[2]), Math.max(fb[1], fb[3])]
        const p0 = bot.entity.position; const there = p0.x >= box[0] - 6 && p0.x <= box[2] + 6 && p0.z >= box[1] - 6 && p0.z <= box[3] + 6
        if (there || await A.travel(bot, { x: FJ.site[0], y: FJ.site[1], z: FJ.site[2] }, { range: 5, ms: 420000, stop: api.stop })) {
          plantedHome = await canePlant(bot, box, FJ.params.y, api, st.bad)
          if (plantedHome) { const cells = caneCells(bot, box[0], box[1], box[2], box[3], FJ.params.y); A.result(bot, { ev: 'cane_pass', job: FJ.id, by: job.id, cut: 0, planted: plantedHome, standing: caneAudit(bot, FJ.id, cells), cells: cells.length, cane: A.count(bot, 'sugar_cane') }) }
        }
        if (api.stop()) return 'cane: not home yet'
      }
      task(bot, 'cane: carrying ' + A.count(bot, 'sugar_cane') + ' cane home')
      const moved = A.count(bot, 'sugar_cane') ? await A.bank(bot, { torch: 16, ...rationsOf(bot) }, { job: job.id, stop: api.stop }) : {}
      if (A.count(bot, 'sugar_cane') && api.stop()) return 'cane: not home yet'
      A.result(bot, { ev: 'cane_trip', job: job.id, cut: st.cut, planted: plantedHome, banked: moved.sugar_cane || 0, left: A.count(bot, 'sugar_cane') })
      st.phase = 'idle'; st.cut = 0
    }
    return 'cane: wild'
  }
  // ---- farm
  if (!Array.isArray(P.box) || P.box.length !== 4 || typeof P.y !== 'number' || !Array.isArray(job.site)) return muster(bot, job, api, ctx, 'cane: params need box [x1,z1,x2,z2], y (shore soil level) and the job a dry site [x,y,z]')
  const [x1, z1, x2, z2] = [Math.min(P.box[0], P.box[2]), Math.min(P.box[1], P.box[3]), Math.max(P.box[0], P.box[2]), Math.max(P.box[1], P.box[3])]
  farCheck(bot, job, [x1, z1, x2, z2])
  const inside = () => { const p = bot.entity.position; return p.x >= x1 - 6 && p.x <= x2 + 6 && p.z >= z1 - 6 && p.z <= z2 + 6 }
  const toSite = () => A.travel(bot, { x: job.site[0], y: job.site[1], z: job.site[2] }, { range: 5, ms: 420000, stop: api.stop, via: P.via })
  // cane for the open cells is taken along on the way OUT (the depot lies between muster and the shore): the last visit's count says how much
  { const last = (A.readJSON(AF, {}) || {})[job.id]; const openN = last ? Math.max(0, (last.cells || 0) - (last.n || 0)) : 64; if (!inside() && openN > 0 && !A.count(bot, 'sugar_cane') && A.stockOf('sugar_cane') > 0) { task(bot, 'cane: fetching cane to plant'); await A.withdraw(bot, 'sugar_cane', Math.min(64, openN), { stop: api.stop }) } }
  task(bot, 'cane: to the shore')
  if (!inside() && !await toSite()) return api.stop() ? 'stopped' : muster(bot, job, api, ctx, 'cane: cannot reach the shore at ' + job.site.join(','))
  task(bot, 'cane: cutting')
  let cells = caneCells(bot, x1, z1, x2, z2, P.y)
  const cut = await caneCut(bot, cells, api, st.bad)
  let planted = 0
  const empties = () => caneCells(bot, x1, z1, x2, z2, P.y).filter(c => c.h === 0 && !st.bad[c.base.x + ',' + c.base.z])
  let todo = api.stop() ? [] : empties()
  if (todo.length && !A.count(bot, 'sugar_cane') && A.stockOf('sugar_cane') > 0) {
    task(bot, 'cane: fetching cane to plant')
    await A.withdraw(bot, 'sugar_cane', Math.min(64, todo.length), { stop: api.stop })
    if (!api.stop() && !inside()) await toSite()
    todo = api.stop() ? [] : empties()
  }
  task(bot, 'cane: planting')
  if (todo.length && !api.stop()) planted = await canePlant(bot, [x1, z1, x2, z2], P.y, api, st.bad)
  if (api.stop()) return 'cane: slice over (cut ' + cut + ', planted ' + planted + ')'
  cells = caneCells(bot, x1, z1, x2, z2, P.y)
  const standing = caneAudit(bot, job.id, cells); const open = cells.length - standing
  if (cut || planted) A.result(bot, { ev: 'cane_pass', job: job.id, cut, planted, standing, cells: cells.length, cane: A.count(bot, 'sugar_cane') })
  // the surplus goes home: a full haul, or whatever is carried once every reachable cell is planted
  const carried = A.count(bot, 'sugar_cane'); const openLeft = empties().length
  if (carried >= (P.bankAt || 48) || (carried > 0 && !openLeft) || U.freeSlots(bot) <= 2) { task(bot, 'cane: bank'); await A.bank(bot, { torch: 16, ...rationsOf(bot) }, { job: job.id, stop: api.stop }) }
  if (!cut && !planted) return rest(600000, 'cane: ' + standing + ' plants growing, ' + open + ' open cells' + (open ? ' (no cane to plant: stock ' + A.stockOf('sugar_cane') + ')' : ''))
  return 'cane: cut ' + cut + ', planted ' + planted + ', standing ' + standing + '/' + cells.length
}

// ------------------------------------------------------------------ build: ANY blueprint, ANY number of bots (templates for houses, walls, levelling, pads, roads …).
// params: blueprint:'shelter' (file in bots/blueprints/), origin:[x,y,z], args:{…blueprint params}, material fallback = BUILD chest.
// Algorithm without coordination: cells = blueprint(origin,args). 'air' cells are dug TOP-DOWN, solid cells placed BOTTOM-UP; a bot takes
// the nearest cell that is doable now (dig: nothing above it still to dig; place: a solid neighbour/floor exists). blocks.js position locks
// keep two bots off one cell. `fillOnly` cells are placed only where the world has a hole. Done -> the job pauses itself (`build_done`).
// Cell kinds: block names · `air` (dig) · `water` (WATER CELL, see waterCell below) · furniture (chest/barrel + `cat`, furnace, crafting_table,
// `*_bed` + `facing`, torch) - furniture that stands is REGISTERED by the build job itself (settings.chests / craftTable / respawnBeds / furnaces).
// Cell fields: fillOnly · mats:[accepted substitutes] · wood:'planks'|'fence'|… (WOOD-AGNOSTIC: the species comes from the stock, never from the
// blueprint) · axis / facing (oriented) · needs:'water'|'below' (waits until the cell below is a water source / solid) · solid (fill_void) · cat ·
// chest + facing + half:0|1 (a PAIR that must merge into a double chest: placeChest / redoChest) · air + natural:true (only natural ground is cut: a road's terraced shoulder).
// THE LOADER (one for build, audit and tidy): file in bots/blueprints/, cells pass through lib/mats.js `normalise` = no cell is ever bound to a wood
// species or a bed colour, whatever a blueprint default or an operator's args say (world 1 hard-coded spruce: any other biome would have starved the builders).
// FURNITURE IS ORDERED IN THE NUMBER THE DEPOT CAN DELIVER (main 09-20 02:26Z: dorm builders asked for 8 gray beds each, `obtain_failed gray_bed` x9 while 4 finished beds lay
// in the depot): the largest n <= want that stock + the recipe solver can make NOW; beds at most 4 per builder (3 wool each - six builders share one wool pile).
function feasibleN (bot, name, want) {
  try {
    const C = lib('craft'); const all = A.stockMap(); for (const [k, n] of Object.entries(A.inv(bot))) all[k] = (all[k] || 0) + n
    for (let n = Math.min(want, /_bed$/.test(name) ? 4 : want); n > 1; n--) if (C.solve(bot.registry, name, n, Object.assign({}, all)).ok) return n
  } catch (e_) { swallow('army_jobs:feasibleN', e_) }
  return 1
}
function blueprintCellsOf (q, fresh) { return A.blueprintCellsOf(q, fresh) } // ONE loader: lib/army.js (its registry of what we built reads the same cells)
const _bpCache = {}
// columns some OTHER build job's blueprint builds on (walls, floors, fences - never the terrain jobs level / fill_void / clear_area): a hall wall of andesite or
// granite ("any stone sort") reads as natural ground, so a road's shoulder never cuts in a column that is somebody's structure. 5 min cache per process.
let _builtCols = { t: 0, id: null, s: new Set() }
function builtCols (selfId) {
  if (Date.now() - _builtCols.t < 300000 && _builtCols.id === selfId) return _builtCols.s
  const cols = new Set()
  for (const j of (A.readJSON(A.F.board, {}) || {}).jobs || []) { const q = j.params || {}; if (j.type !== 'build' || j.id === selfId || !q.blueprint || !Array.isArray(q.origin) || /^(level|fill_void|clear_area|road|road_path)$/.test(q.blueprint)) continue; try { for (const c of blueprintCellsOf(q)) if (c.block !== 'air' && !c.fillOnly) cols.add(c.x + ',' + c.z) } catch (e_) { swallow('army_jobs:builtCols', e_) } }
  _builtCols = { t: Date.now(), id: selfId, s: cols }
  return cols
}
const TERRAIN_JOB = /^(level|clear_area|road|road_path|field_block|platform)$/ // blueprints whose air cells cut natural trees: a trunk in the cut is felled whole
const WEED_RE = /^(short_grass|tall_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|wildflowers|pink_petals|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|.*_tulip|sweet_berry_bush|short_dry_grass|tall_dry_grass)$/ // = WEED in ops/base-audit.js
const NATURAL_RE = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|stone|granite|diorite|andesite|tuff|calcite|deepslate|gravel|sand|red_sand|sandstone|terracotta|moss_block|snow|snow_block|powder_snow|short_grass|tall_grass|fern|large_fern|dead_bush|.*_ore)$/ // what a `natural:true` air cell may take away
// A TREE IS NOT GROUND: what may stand in a `fillOnly` ground cell and still let it count as filled excludes everything that GREW there (see todo()'s fillOnly rule)
const GROUND_TREE_RE = /_log$|_wood$|_stem$|_hyphae$|_leaves$|_mushroom_block$|^mushroom_stem$|^bamboo|_sapling$|^cactus$|^sugar_cane$/
function blueprintCells (P) {
  const key = JSON.stringify([P.blueprint, P.origin, P.args, P.pad, P.padFill])
  if (_bpCache.key !== key) {
    const m = new Map(); for (const c of blueprintCellsOf(P, true)) m.set(c.x + ',' + c.y + ',' + c.z, c)
    // PAD RULE (owner 09-19: "before any construction the terrain is levelled"): every structure gets a level pad first - its footprint + 1,
    // ground layer (lowest structure block - 1) filled where it is missing, 4 blocks of headroom cut where the blueprint has no block of its
    // own. Digs run before places, so the pad exists before the first wall block. Terrain-spanning blueprints opt out; params.pad:false too.
    const NO_PAD = /^(level|fill_void|clear_area|bridge|road|road_path|stairwell|fishing_dock|fishing_pier|lake_farm|spots|platform|field_block|cane_block|tree_farm|mine_head)$/ // fill_void: its lowest layer is 3-11 BELOW grade - the pad rule took that for the ground level and cut `air` from there up in the ring of 1 around the box = a MOAT 1 wide and 3 deep around every fill (09-19 21:5xZ: rings around fill_field3/dorm/field2/minepad_void = the "road trenches" on the lines x -374, z -491, z -526; zones became islands); field_block brings its own ring + headroom (its lowest cells are the 9 floors under the water: the generic rule would cut a moat); tree_farm: a pad's headroom would fell its trees; mine_head: a pad would fill the miner's stair mouth
    const body = [...m.values()].filter(c => c.block !== 'air' && !/torch/.test(c.block))
    if (P.pad !== false && !NO_PAD.test(String(P.blueprint)) && body.length) {
      const baseY = Math.min(...body.map(c => c.y)); const cols = new Set()
      for (const c of body) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cols.add((c.x + dx) + ',' + (c.z + dz))
      // a blueprint whose lowest layer is a FLOOR (covers most of its footprint) sits flush in the ground: the ground level is that layer
      const ownCols = new Set(body.map(c => c.x + ',' + c.z)); const own = ownCols.size
      const gY = body.filter(c => c.y === baseY).length >= 0.6 * own ? baseY : baseY - 1
      for (const k of cols) {
        const [x, z] = k.split(',').map(Number)
        if (!m.has(x + ',' + gY + ',' + z)) m.set(x + ',' + gY + ',' + z, { x, y: gY, z, block: P.padFill || 'dirt', fillOnly: true })
        // THE RING IS NEVER CUT BELOW THE ORIGIN LEVEL (a blueprint with a basement - water floors, a stair mouth, a fill - has its lowest block under the ground:
        // headroom counted from there is a moat around it; third time this bit us, so it is a rule now and not only a NO_PAD entry)
        const y0 = ownCols.has(k) || gY >= P.origin[1] - 1 ? gY + 1 : P.origin[1] + 1 // (walls standing ON the ground have gY = origin y - 1: unchanged)
        for (let y = y0; y <= y0 + 3; y++) if (!m.has(x + ',' + y + ',' + z)) m.set(x + ',' + y + ',' + z, { x, y, z, block: 'air' })
      }
    }
    _bpCache.key = key; _bpCache.cells = [...m.values()]
  }
  return _bpCache.cells
}
// WHERE A CROWN MAY NOT BE LEFT HANGING (blocks.js harvestTree opts.crown): over a level pad of ours, over the footprint (+1) of anything we built except the tree farm, over a
// farm job's box. Over natural ground outside our zones leaves are left to decay.
function crownRule () {
  const o = A.ours(); const farms = ((A.readJSON(A.F.board, {}) || {}).jobs || []).filter(j => j.type === 'farm' && j.params && Array.isArray(j.params.box)).map(j => j.params.box).map(b => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])])
  return p => o.pads.some(q => p.x >= q.x1 && p.x <= q.x2 && p.z >= q.z1 && p.z <= q.z2) || o.boxes.some(b => b.blueprint !== 'tree_farm' && p.x >= b.x1 - 1 && p.x <= b.x2 + 1 && p.z >= b.z1 - 1 && p.z <= b.z2 + 1) || farms.some(b => p.x >= b[0] && p.x <= b[2] && p.z >= b[1] && p.z <= b[3])
}
// STRANDED ON A POLE (probe 09-20 07:22Z: Yuzu stood on a 4-high birch trunk whose crown it had cut, ground 5 below on all sides, maxDropDown 3 -> `noPath` to every stand,
// every dig `no_los`/`unreachable`, 280 failures in a builder-hour and nothing in any report). A terrain worker whose feet are > 3 above every neighbouring column and whose
// pole is a trunk / leaves / loose ground takes the pole down under its own feet (the cut is its job anyway) until the drop is walkable. Never ours, never protected.
async function offThePole (bot, job) {
  try {
    const BL = lib('blocks'); const f = bot.entity.position.floored(); if (!bot.entity.onGround) return false
    const top = (x, z) => { for (let y = f.y; y >= f.y - 12; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) return null; if (b.boundingBox === 'block') return y + 1 } return f.y - 13 }
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => top(f.x + dx, f.z + dz)); if (nb.some(q => q == null)) return false
    const hi = Math.max(...nb); const drop = f.y - hi; if (drop <= 3 || drop > 12) return false
    let n = 0
    for (let i = 0; i < drop - 3; i++) {
      const u = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)); if (!u || !/_log$|_wood$|_leaves$|^(dirt|coarse_dirt|grass_block|gravel|sand|cobblestone|cobbled_deepslate|netherrack)$|_planks$/.test(u.name) || U.protectedBlock(u) || A.ourBlock(u.position, u.name)) break
      const r = await BL.digBlock(bot, u.position, { allowUnderFeet: true, collect: true, requireHarvest: false, noMove: true, plug: false }).catch(e => ({ ok: false, reason: String(e && e.message) })); if (!r.ok) break
      n++; await sleep(600)
    }
    if (n) A.result(bot, { ev: 'pole_down', job: job.id, at: [f.x, f.y, f.z], blocks: n, drop })
    return n > 0
  } catch (e_) { swallow('army_jobs:offThePole', e_); return false }
}
// HOW BIG IS MY CREW, AND WHERE DO I STAND IN IT (the same read as scoutRank: assign/*.json, one file per bot, written by the dispatcher). Deterministic rank =
// the bot's place in the sorted crew, so every builder reaches the same answer about who stays on a tail and who goes, without one message between them.
function crewOf (job, me) {
  try {
    const fs = require('fs'); const p = require('path'); const dir = p.join(A.DIR, 'assign'); const mates = []
    for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.json')) continue; const a = A.readJSON(p.join(dir, f), null); if (a && a.job && a.job.id === job.id && Date.now() - (a.t || 0) < 180000) mates.push(f.slice(0, -5)) }
    if (!mates.includes(me)) mates.push(me)
    mates.sort(); return { n: mates.length, rank: mates.indexOf(me) }
  } catch (e_) { swallow('army_jobs:crewOf', e_); return { n: 1, rank: 0 } }
}
async function build (bot, job, api, ctx) {
  const BL = lib('blocks'); const P = job.params || {}
  // NO NIGHT GATE (owner: waiting is waste; 09-19 19:42Z: 'build: night' parked 15-25 builders at muster every evening - with no bed in the world the
  // muster yard is no safer than a pad worked by a crowd). A job that must stop at night says so: params.dayOnly:true.
  if (P.dayOnly && isNight(api)) return muster(bot, job, api, ctx, 'build: night (params.dayOnly)')
  let cells; try { cells = blueprintCells(P) } catch (e) { return muster(bot, job, api, ctx, 'build: blueprint error ' + String(e.message).slice(0, 60)) }
  const o = v(P.origin)
  // params.needStock {item:n} = A SURPLUS JOB (the dirt cap a finished terrain fill puts on the board, 11:4xZ): while the DEPOT holds no more than n of the item the
  // builder is handed back at once - checked BEFORE the walk, so a short reserve costs nothing - and says why once per 10 min. The job stays ACTIVE and resumes by
  // itself as soon as the cuts have produced dirt again; a pause would wait for an operator to notice it.
  if (P.needStock) {
    const short = Object.entries(P.needStock).find(([k, q]) => A.stockOf(k) <= q)
    if (short) {
      const why = 'build: the depot holds ' + A.stockOf(short[0]) + ' ' + short[0] + ', at or below the reserve ' + short[1] + ' (params.needStock)'
      if (Date.now() - (bot.__armyNeedStock || 0) > 600000) { bot.__armyNeedStock = Date.now(); A.result(bot, { ev: 'build_blocked', job: job.id, why }) }
      A.decline(bot, job, 600000, why); return muster(bot, job, api, ctx, why)
    }
  }
  // LAYERED PITS (blueprint `quarry`) are legal only inside a settings.keepOut box = the quarry zone (rule 4: never a hole in natural ground)
  const layered = cells.some(c => c.layer); const cellKeys = layered ? new Set(cells.map(c => c.x + ',' + c.y + ',' + c.z)) : null
  if (layered) { const zones = (A.settings().keepOut || []).map(k => k && k.box).filter(q => Array.isArray(q) && q.length === 4).map(q => [Math.min(q[0], q[2]), Math.min(q[1], q[3]), Math.max(q[0], q[2]), Math.max(q[1], q[3])]); if (!cells.every(c => zones.some(q => c.x >= q[0] && c.x <= q[2] && c.z >= q[1] && c.z <= q[3]))) return muster(bot, job, api, ctx, 'build: a ' + P.blueprint + ' pit is legal only inside a settings.keepOut box (quarry zone)') }
  if (!A.bestOf(bot, 'shovel') && cells.some(c => c.block === 'air' || c.fillOnly)) await getTool(bot, 'shovel', api) // on the way OUT (the depot lies at muster): a pad, a road shoulder, a quarry's top layers are earth
  if (A.dist2(bot, o.x, o.z) > 40 && !await A.travel(bot, { x: o.x, y: null, z: o.z }, { range: 12, ms: 300000, stop: api.stop })) return 'build: cannot reach the site'
  const st = bot.__armyBuild = (bot.__armyBuild && bot.__armyBuild.key === job.id + ':' + (job.rev || 0)) ? bot.__armyBuild : { key: job.id + ':' + (job.rev || 0), bad: {} }
  const solid = b => !!b && b.boundingBox === 'block'
  const solidItem = n => !/torch|button|_sign$|carpet|_door$|ladder|lever|rail$|sapling|air/.test(n)
  const K = c => c.x + ',' + c.y + ',' + c.z
  // SOLID FILL cells (blueprint fill_void, `solid:true`): work = the air that is CONNECTED TO THE OPEN SKY inside the box (flood from the grade layer);
  // sealed pockets in the rock are not work. `sealed` = air cells of the box the flood did not reach (reported as void_under_pad).
  const DECOR = /^(torch|wall_torch|redstone_torch|redstone_wall_torch|soul_torch|soul_wall_torch|.*_button)$/
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const skyOpen = () => {
    // ...and the flood itself is cached for 3 s (measured 13:2xZ: on fill_ravine_s ONE bot made 5.1 M `bot.blockAt` calls in 45 s = 14.9 s of CPU per minute, most of
    // it this flood over every air cell of a 33 000-cell box, rebuilt on every walk). Stale for at most 3 s means at worst a cell that has just become sky-connected
    // waits one walk; a cell that has become solid is dropped by the `solid(b)` test above the flood anyway, so nothing is ever placed on stale information.
    if (st.skyT && Date.now() - st.skyT < 3000 && st.sky) return st.sky
    const air = new Map(); for (const c of cells) if (c.solid) { const b = at(c.x, c.y, c.z); if (b && !solid(b)) air.set(K(c), c) }
    const open = new Set(); const q = []
    for (const c of air.values()) if (c.y === c.g) { open.add(K(c)); q.push(c) }
    while (q.length) { const c = q.pop(); for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) { const k = (c.x + dx) + ',' + (c.y + dy) + ',' + (c.z + dz); if (air.has(k) && !open.has(k)) { open.add(k); q.push(air.get(k)) } } }
    open.sealed = [...air.keys()].filter(k => !open.has(k))
    st.skyT = Date.now(); st.sky = open
    return open
  }
  // NOBODY IS BURIED ALIVE (owner 09-20 11:0xZ "渓谷埋めで埋まってるbotいっぱいいる": Mio, Riko and Nagisa stood at y64 in the ravine box with walkableArea 1 - their mates had
  // filled every cell around and above them). A solid fill never places into a mate's BODY, into the two cells over a mate that stands below grade, or into the LAST open
  // side of the cell a mate stands in. The positions are the player entities in view - no new file, no message, half a second of cache (30 bots x 8 cells per pass).
  let _mates = { t: 0, s: new Set() }
  const mateBlocked = () => {
    if (Date.now() - _mates.t < 500) return _mates.s
    const s2 = new Set()
    try {
      const me = bot.entity && bot.entity.id; const mp = bot.entity.position
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e.id === me || e.type !== 'player' || !e.position) continue
        const q = e.position.floored(); if (Math.abs(q.x - mp.x) > 40 || Math.abs(q.z - mp.z) > 40) continue
        for (let dy = 0; dy < (q.y <= o.y ? 3 : 2); dy++) s2.add(q.x + ',' + (q.y + dy) + ',' + q.z) // body + (below grade) the cell over its head: never wall a mate in from above
        const free = SIDES.filter(([dx, dz]) => !solid(at(q.x + dx, q.y, q.z + dz)))
        if (free.length === 1) s2.add((q.x + free[0][0]) + ',' + q.y + ',' + (q.z + free[0][1])) // its last way out
      }
    } catch (e_) { swallow('army_jobs:mateBlocked', e_) }
    _mates = { t: Date.now(), s: s2 }
    return s2
  }
  // NOBODY RAISES A WALL BESIDE A BOT (owner 11:3xZ: "渓谷埋め、座標指定がおかしいのでは？率先して埋まりに行こうとしている"; MEASURED on fill_ravine_s 11:15-11:30Z:
  // 12 fill_ride_up + 11 fill_climb_out + 9 dug_out + 6 pillared_out in 15 min = the crew spent its slice getting walled in and escaping again, 0.2 cells/min/bot).
  // A block ONE cell above a bot's own feet, in any of the 8 columns around it, is a 2-high wall that bot cannot step over: `wallsIn` refuses that cell for EVERY bot
  // in view, itself included. The bot steps up onto the floor it has just laid and the cell is free on the next pass - the floor rises layer by layer instead of
  // growing towers around standing bots. Same half-second entity cache as mateBlocked (30 bots x 8 cells per pass).
  let _crowd = { t: 0, a: [] }
  const crowd = () => {
    if (Date.now() - _crowd.t < 500) return _crowd.a
    const a = []
    try {
      const me = bot.entity && bot.entity.id; const mp = bot.entity.position.floored(); a.push({ x: mp.x, y: mp.y, z: mp.z })
      for (const e of Object.values(bot.entities || {})) { if (!e || e.id === me || e.type !== 'player' || !e.position) continue; const q = e.position.floored(); if (Math.abs(q.x - mp.x) > 40 || Math.abs(q.z - mp.z) > 40) continue; a.push({ x: q.x, y: q.y, z: q.z }) }
    } catch (e_) { swallow('army_jobs:crowd', e_) }
    _crowd = { t: Date.now(), a }
    return a
  }
  const wallsIn = c => { for (const q of crowd()) if (Math.abs(q.x - c.x) <= 1 && Math.abs(q.z - c.z) <= 1 && c.y >= q.y + 1) return true; return false }
  // LAVA (top model 09:5xZ: the builders of fill_ravine_s died "tried to swim in lava" x3 and the job has been paused ever since). In a SOLID fill nobody works below grade
  // beside lava: a LAVA cell of the box is quenched FIRST and only from above (a gravity block dropped down its shaft from the rim) or from a stand that touches no lava and
  // is 2+ away horizontally; every other cell that touches lava waits until its lava neighbour is solid. One findBlocks(32) per 15 s around the builder - beyond that radius
  // nothing changes (the old behaviour), which is enough: the fill is worked from where the builder stands.
  let _lava = { t: 0, s: new Set() }
  const lavaSet = () => {
    if (Date.now() - _lava.t < 15000) return _lava.s
    const s2 = new Set()
    try { const id = bot.registry.blocksByName.lava.id; for (const q of bot.findBlocks({ matching: id, maxDistance: 32, count: 400 })) s2.add(q.x + ',' + q.y + ',' + q.z) } catch (e_) { swallow('army_jobs:lavaSet', e_) }
    _lava = { t: Date.now(), s: s2 }
    return s2
  }
  const nearLava = (x, y, z) => { const s2 = lavaSet(); if (!s2.size) return false; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (s2.has((x + dx) + ',' + (y + dy) + ',' + (z + dz))) return true; return false }
  // WATER CELLS (world 1: farmers poured/plugged/capped water through five patch layers -> 309 flowing blocks over the wheat, holes re-poured 7-12 times).
  // The book lives ON THE BOARD (job.water = {key:'rev<n>', cells:{'x,y,z':{by,t} claim 6 min | {fail,why}}}; 30 bots = 10 processes, no new state file):
  // the claim is taken inside ONE locked board edit, so two builders never pour the same cell; two failures army-wide retire the cell for this rev.
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const isSrc = b => !!b && b.name === 'water' && b.metadata === 0
  // A VISIBLE FACE TAKES THE BLUEPRINT'S OWN BLOCK (owner 12:1xZ: 「適当にブロック使うから見栄えが悪いんだよね。土を置くべきなところに石を置いたり、丸石を置くべきところに
  // 深層岩を置いてる」; `audit_surface` 12:04Z MEASURED it: 705 visible planned cells hold a substitute - road_12 199, road_9 189, road_11 80, road_1 70, field_7 41,
  // e.g. -340,68,-556 wants cobblestone and has stone). `mats` is thrift for what nobody sees: the body of a solid fill, a road's sub-base, the inside of a wall. At the
  // SURFACE it is a patchwork. A cell counts as visible when it is the TOP block of its column in the blueprint and is neither fill body nor sub-base; for those the
  // exact block is the only one accepted and the only one placed - a substitute standing there is work again (dug, then the right block), and with none in the depot the
  // cell WAITS and the job says `needs: <block>`. Two families keep their variety on purpose: species-agnostic WOOD (a birch floor is not a patchwork) and bed colours;
  // SOIL cells keep theirs too (grass/farmland/podzol are all "the ground is there" - the dirt cap, not this rule, is what makes ground ground).
  const HARD_SOIL = /^(dirt|grass_block|farmland|podzol|coarse_dirt|rooted_dirt|dirt_path|mycelium|mud)$/
  const EXACT = new Set()
  { const top = new Map()
    for (const c of cells) { if (c.solid || c.fillOnly || c.block === 'air' || /torch|button|_sign$|_door$|ladder|lever|rail$/.test(c.block)) continue; const k = c.x + ',' + c.z; const e = top.get(k); if (e == null || c.y > e.y) top.set(k, c) }
    for (const c of top.values()) if (c.mats && c.mats.length > 1 && !c.wood && !/_bed$/.test(c.block) && !HARD_SOIL.test(c.block)) EXACT.add(K(c)) }
  const exact = c => EXACT.has(K(c))
  // THE ROAD THAT DUG ITSELF INTO A TRENCH (owner 13:2xZ 「道路Erikaバグってる」; MEASURED: base_road_9 `build_pass done:120` EIGHTEEN times with `left` stuck at 2 and every
  // failure on ONE cell, -285,67,-476, while the strip x -288..-286 / z -486..-468 sank 1-9 blocks). The engine was a pair of old rules, not the visible-material rule
  // itself: `unlid` takes the PAVING off whenever its sub-base cell is open, and the paving cell then measures its column as "open below" and fills one block LOWER -
  // so dig, fill, dig, fill, marching down. It used to close on the first pass because ANY stone could go back on top; with the exact-material rule and cobblestone 0 in
  // the depot the paving could never return, so the pair ran for an hour. Cure: nothing of the blueprint is ever taken off unless the block that must replace it is
  // ALREADY IN THE POCKETS - the depot index is not a promise (it read cobblestone > 0 all afternoon and the chests gave none).
  const cellAt = new Map(cells.map(c => [K(c), c]))
  const allKeys = new Set(cellAt.keys())
  const inHand = q => !q || q.block === 'air' || A.count(bot, q.block) > 0 || (!exact(q) && matsOf(q).some(n => A.count(bot, n) > 0))
  const pickList = c => exact(c) ? [c.block] : matsOf(c) // what this cell may be made of, here and now
  const waterKeys = new Set(cells.filter(c => c.block === 'water').map(K))
  const groundFill = (cells.find(c => c.fillOnly && !c.solid && c.block !== 'air') || {}).block || null // what this blueprint's ground cells are made of (level: dirt)
  const groundKeys = new Set(cells.filter(c => c.fillOnly && !c.solid && c.block !== 'air').map(K)) // the blueprint's ground cells (pad, road sub-base, level)
  const bodyKeys = new Set(cells.filter(c => c.block !== 'air').map(K)) // cells the blueprint itself makes solid (a fill column never reaches into them)
  const nearWater = c => { if (!waterKeys.size) return false; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (waterKeys.has((c.x + dx) + ',' + (c.y + dy) + ',' + (c.z + dz))) return true; return false }
  const revKey = 'rev' + (job.rev || 0)
  const waterBook = () => { if (!waterKeys.size) return {}; if (Date.now() - (st.wbT || 0) > 5000) { st.wbT = Date.now(); const j = ((A.readJSON(A.F.board, {}) || {}).jobs || []).find(q => q.id === job.id); st.wb = (j && j.water && j.water.key === revKey && j.water.cells) || {} } return st.wb || {} }
  const waterClaimed = c => { const e = waterBook()[K(c)]; return !!(e && e.by && e.by !== bot.username && Date.now() - (e.t || 0) < 360000) }
  const waterEdit = fn => { const ok = A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (!j) return; if (!j.water || j.water.key !== revKey) j.water = { key: revKey, cells: {} }; fn(j.water.cells) }); st.wbT = 0; return ok }
  const todo = (all, wide) => {
    // MAKE THE BOTS CHEAP (owner 13:0xZ "tps低いらしい"; MEASURED 13:1xZ with a temporary eval-installed wrapper on Akari/Hinata, 45 s each: **1.17 M and 1.72 M
    // `bot.blockAt` calls** = 3793 and 4497 ms of CPU per MINUTE per bot, plus 747 k / 887 k `A.ourBlock` = 842-958 ms/min - the two of them are ~8 % of a core PER BOT,
    // about 4 cores of the 7 the 17 shards were burning while MSPT sat at 105 ms). One `todo()` walk reads the same neighbour column three to five times (softBelow,
    // groundUnder, shallow, side, the sky flood); there is no `await` anywhere inside this function, so the world cannot change during it and ONE memo per walk is
    // exact, not an approximation.
    const _bm = new Map()
    const _at = (x, y, z) => { const k = x + ',' + y + ',' + z; if (_bm.has(k)) return _bm.get(k); const b = bot.blockAt(new Vec3(x, y, z)); _bm.set(k, b); return b }
    const at = _at
    const me = bot.entity.position; const dig = []; const put = []; let wait = 0; const deep = []; let far = 0
    const matSeen = {}; const haveMat = c => { const k = c.block + '|' + (c.wood || '') + '|' + (exact(c) ? 'x' : ''); if (matSeen[k] == null) matSeen[k] = pickList(c).some(n => A.count(bot, n) > 0 || A.stockOf(n) > 0) || (!exact(c) && !!craftPick(c)); return matSeen[k] }
    const open = cells.some(c => c.solid) ? skyOpen() : null; const roofs = new Set(); const mates = open ? mateBlocked() : null; const lavaOn = !!open && lavaSet().size > 0
    // NEVER A LID (owner: never deck a hole; main 09-19 19:5xZ: base_field_1_pad / base_yard_pad "complete - BUT 7/10 columns are a deck over air", core pad
    // -346,68,-492 = dirt y68 over AIR y67 over grass y66): a `fillOnly` ground cell is filled FROM THE NATURAL GROUND UP. groundUnder = the lowest open cell of
    // its column (first solid within 6 below), null = deeper than that: a real void, left open and reported (void_under_pad -> blueprint fill_void).
    const groundUnder = c => { for (let y = c.y - 1; y >= c.y - 7; y--) { const q = at(c.x, y, c.z); if (!q) return null; if (solid(q)) return y + 1 } return null }
    // shallow(g): the open run at ground cell g is at most 3 deep (a dip, a trench, a moat) = filled in a moment from the rim. Deeper = a CAVE MOUTH: paving over it stays a
    // bridge (22:10Z test on road 5: the deck over the cave at z -505..-501 was taken off, a builder fell to y62 and cut a staircase out through field 2)
    const shallow = g => { for (let y = g.y; y >= g.y - 3; y--) { const q = at(g.x, y, g.z); if (!q || /^(water|lava)$/.test(q.name)) return false; if (solid(q)) return true } return false }
    const softBelow = c => { const q = at(c.x, c.y - 1, c.z); return !!q && !solid(q) && !/^(water|lava)$/.test(q.name) && !bodyKeys.has(c.x + ',' + (c.y - 1) + ',' + c.z) && !waterKeys.has(c.x + ',' + (c.y - 1) + ',' + c.z) }
    const stairs = stairCols(); let _built = null; const built = () => _built || (_built = builtCols(job.id))
    // A WORKING WALK LOOKS AT THE COLUMNS AROUND THE BOT (same measurement): a builder cannot reach a cell 200 blocks away this second, but it walked all 33 000 of them
    // to find the eight it can do. `all` (the closing walk that decides `left` and "complete") still reads every cell, and a near walk that finds NOTHING is redone
    // without the limit at once - so the same cells get built, in the same order, just without reading the far half of the box forty times a second.
    const R = (all || wide) ? 0 : (+P.walkRadius || 24)
    for (const c of cells) {
      if (R && (Math.abs(c.x - me.x) > R || Math.abs(c.z - me.z) > R)) { far++; continue }
      if ((c.fillOnly || c.solid) && c.block !== 'air' && stairs.has(c.x + ',' + c.z) && c.y > stairs.get(c.x + ',' + c.z)) continue // the mine's stairwell: never filled, never counted as left (see stairCols)
      if (!all && ((st.bad[K(c)] || 0) >= 2 || (st.lockSkip && st.lockSkip[K(c)] > Date.now()) || (c.solid && st.colSkip && st.colSkip[c.x + ',' + c.z] > Date.now()))) continue
      const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!b) continue
      // `only`: a cell that may replace ONLY these blocks is no cell of this job at all anywhere else - not work, not `left`, not `wait` (blueprint `level` in cap
      // mode: bare stone, gravel or air becomes dirt; paving, a crop, a chest, soil that is already soil are none of the cap's business)
      if (c.only && !c.only.includes(b.name)) continue
      // A BLOCK THAT STANDS WHERE ANOTHER BLUEPRINT OF OURS PUT IT IS NEVER THIS JOB'S TO DIG (a pad's headroom inside the dorm walls, a road shoulder in the hall): not work, not `left`
      // ...and this was an IIFE run for EVERY cell of the blueprint although only the four branches below ever read it: 747 k - 887 k `A.ourBlock` calls in 45 s on one
      // bot. Lazy, memoised per cell: same answer, called only where it decides something.
      let _fg = null
      const foreign = () => { if (_fg === null) { const oc = b.name === 'air' ? null : A.ourBlock(b.position, b.name); _fg = !!oc && oc.job !== job.id } return _fg }
      if (c.facing && c.half != null && b.name === c.block && /chest$/.test(b.name)) { const w = chestWrong(c, b); if (w) { if (!all && redoClaimed(c)) wait++; else put.push(Object.assign({}, c, { redo: w })) } continue } // a pair that is not a DOUBLE chest is not built (see placeChest)
      if (c.solid) { // strict bottom-up: only on a solid block (lowest layer of the job: a side neighbour will do) -> nothing placed ever has air under it
        if (solid(b)) continue
        // params.unlid (true = 2, or N): a THIN roof (deck block, grass overhang: a solid run of <= N blocks, not above grade) over air of the box is taken off first,
        // sealed or not - then that column is an open shaft and is filled from its floor. Never under a chest/torch/bed, never in blueprint keepLid columns, never thick rock.
        if (P.unlid && !c.keepLid && solid(at(c.x, c.y + 1, c.z))) {
          const maxT = P.unlid === true ? 2 : +P.unlid || 2; const run = []
          for (let y = c.y + 1; y <= c.g && run.length <= maxT; y++) { const r = at(c.x, y, c.z); if (!solid(r)) break; run.push(y) }
          // only the CRUST (run ends within 2 of grade): a rock shelf deep inside the void is out of reach from the rim (09-19: 8x dig:no_los per pass starved the placing)
          const ok = run.length > 0 && run.length <= maxT && run[run.length - 1] >= c.g - 2 && !solid(at(c.x, run[run.length - 1] + 1, c.z)) && run.every(y => { const r = at(c.x, y, c.z); return !U.protectedBlock(r) && r.name !== 'bedrock' }) && !U.protectedBlock(at(c.x, run[run.length - 1] + 1, c.z))
          if (ok) for (const y of run) { const k = c.x + ',' + y + ',' + c.z; if (!roofs.has(k) && (all || !(st.lockSkip && st.lockSkip[k] > Date.now()))) { roofs.add(k); dig.push({ x: c.x, y, z: c.z, block: 'air', roof: true }) } }
        }
        if (!open.has(K(c))) continue
        if (mates && mates.has(K(c))) { wait++; continue } // a mate's body / its last open side / the cell over its head: that block waits for the next pass
        if (wallsIn(c)) { wait++; continue } // it would stand 2 high right beside a bot (mine or a mate's feet): that bot steps up on the new floor first (see wallsIn)
        if (DECOR.test(b.name)) { dig.push(Object.assign({}, c, { block: 'air', then: c, decor: b.name })); continue }
        const side = () => [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => solid(at(c.x + dx, c.y, c.z + dz)))
        const hot = b.name === 'lava'
        if (!hot && lavaOn && nearLava(c.x, c.y, c.z)) { wait++; continue } // touches lava: its lava neighbour is quenched first, nobody stands here meanwhile
        if (solid(at(c.x, c.y - 1, c.z)) || (c.floor && side())) put.push(hot ? Object.assign({}, c, { hot: true }) : c); else wait++
        continue
      }
      if (c.block === 'water') { // WATER CELL: doable when its floor and 4 sides stand; a SOURCE that stands is never touched again
        if (isSrc(b)) continue
        const e = waterBook()[K(c)] || {}
        if (!all && ((e.fail || 0) >= 2 || waterClaimed(c))) continue // failed twice army-wide (stays in `left` -> build_stuck tells the foreman) / another builder is on it
        if (solid(at(c.x, c.y - 1, c.z)) && SIDES.every(([dx, dz]) => solid(at(c.x + dx, c.y, c.z + dz)))) put.push(c); else wait++
        continue
      }
      // `needs`: a cap goes over WATER (placed earlier it would have to come off again for the pour), a torch onto its block
      if (c.needs === 'water' && !isSrc(at(c.x, c.y - 1, c.z))) { if (b.name !== c.block && !(c.mats && c.mats.includes(b.name))) wait++; continue }
      if (c.needs === 'below' && !solid(at(c.x, c.y - 1, c.z))) { if (b.name !== c.block) wait++; continue }
      // LAYER rule (quarry): a cell BELOW the ground level opens only when its four neighbours one layer up are gone -> every step in the pit is 1 high at any
      // moment (above ground the rule would wait for ever on a crown's leaves, which are never cells of work)
      if (c.layer && c.y < o.y && solid(b) && SIDES.some(([dx, dz]) => cellKeys.has((c.x + dx) + ',' + (c.y + 1) + ',' + (c.z + dz)) && solid(at(c.x + dx, c.y + 1, c.z + dz)))) { wait++; continue }
      // a ground cell with `unlid:true` (road sub-base) that is OPEN UNDER A BLOCK OF THE BLUEPRINT (paving laid as a deck over a dip or a trench): the paving comes off,
      // the column is filled from the natural ground up, the paving goes back on (it waits for its ground cell, see below). Never under a torch/chest, never over water.
      if (c.fillOnly && c.unlid && !c.solid && !solid(b) && !/^(water|lava)$/.test(b.name)) { const up = at(c.x, c.y + 1, c.z); const kUp = c.x + ',' + (c.y + 1) + ',' + c.z; if (solid(up) && bodyKeys.has(kUp) && !groundKeys.has(kUp) && !U.protectedBlock(up) && !U.protectedBlock(at(c.x, c.y + 2, c.z)) && shallow(c) && inHand(cellAt.get(kUp))) { dig.push({ x: c.x, y: c.y + 1, z: c.z, block: 'air', unlid: true }); continue } }
      if (c.fillOnly && !c.solid && c.block !== 'air' && softBelow(c) && !(c.unlid && !solid(b) && !shallow(c))) { // the column under this ground cell is open (a road over a CAVE MOUTH, deeper than 3: no ground-up fill - sub-base + paving go in from the rim as a 2-thick bridge)
        const gy = groundUnder(c); const lid = solid(b)
        if (gy == null) { if (!lid) deep.push(K(c)); continue } // bottomless for us: no lid is put over it (a lid that stands is reported by the void audit below)
        if (lid) { if (!foreign() && !U.protectedBlock(b) && !U.protectedBlock(at(c.x, c.y + 1, c.z)) && inHand(c)) dig.push({ x: c.x, y: c.y, z: c.z, block: 'air', unlid: true }); continue } // a deck (ours or an overhang): taken off, the column is then filled from its floor
        put.push(Object.assign({}, c, { y: gy, under: true, g: c.y, deepFill: c.y - gy >= 3 })); continue // deepFill: the floor of a 1x1 shaft 3+ deep is out of reach from the rim (09-20, hall column -342,64..67,-516: 10 builders spun on `put:locked`, 3 reported hung) -> fillCell drops a gravity block down it
      }
      // `natural:true` air (a road's terraced shoulder, 09-20): only NATURAL ground is cut - the hall, fence or field beside the road is not terrain - and never the block something stands on (a torch, a chest, a fence, a TREE: a trunk left hanging over a terrace is tidy work we made ourselves)
      if (c.block === 'air' && c.natural && (!NATURAL_RE.test(b.name) || built().has(c.x + ',' + c.z) || (solid(b) && !/^(air|cave_air)$/.test((at(c.x, c.y + 1, c.z) || { name: 'air' }).name) && !NATURAL_RE.test((at(c.x, c.y + 1, c.z) || {}).name)))) continue
      if (c.block === 'air') { if (!foreign() && b.name !== 'air' && b.name !== 'cave_air' && !(/_leaves$/.test(b.name) && c.y > o.y + 3) && !/^(water|lava|wheat|carrots|potatoes|beetroots|sweet_berry_bush|sugar_cane)$/.test(b.name) && !U.protectedBlock(b) && (bot.blockAt(new Vec3(c.x, c.y - 1, c.z)) || {}).name !== 'water') dig.push(c) } else if (b.name !== c.block) {
        // A TREE IS NOT GROUND (MEASURED 12:37Z by the `level_skipped` line this very pass prints: base_infill_n232_n400 col -232,-377 reads 4 BELOW grade for the
        // camera while the block standing AT grade is an `oak_log` - a trunk growing out of the hole made the fillOnly ground cell look "already solid", so the tile
        // declared itself complete over a 4-deep pit with a tree in it and the dispatcher went on walking bots there, travel_fail x57/30 min). A trunk, stem, leaves,
        // mushroom block, cane or sapling in a ground cell is WORK: it is dug (a `level` job is a TERRAIN_JOB, so the main loop fells the whole tree) and the column
        // is filled from the natural ground up on the next pass.
        if (c.fillOnly && solid(b) && !GROUND_TREE_RE.test(b.name)) continue
        if (c.mats && c.mats.includes(b.name) && !exact(c)) continue // an accepted substitute stands there (never on a VISIBLE face: see EXACT)
        if (b.name === 'water' && waterKeys.size) { put.push(c); continue } // a blueprint that OWNS its water: water anywhere else in it is a leak (a side a creeper opened) - the block goes back in
        // THE OTHER HALF OF THE REPAVE/REPLANT LOOP (foreman 10:20Z): a crop standing where OUR OWN blueprint wants a hard block (the field's path line, the post under a water
        // cap) made the rule below skip the cell for ever, so re-activating the build job could never clear `cobblestone@…=wheat`. A real structure cell wins: the crop is
        // harvested first (dig -> the block goes in on the next pass, like a torch in the way). Terrain jobs and the blueprint's own soil cells keep the rule.
        const ownPave = !c.fillOnly && !c.solid && solidItem(c.block) && !/^(dirt|grass_block|farmland|podzol|coarse_dirt|rooted_dirt|dirt_path)$/.test(c.block) // a cell OUR OWN blueprint paves: the field's path line, the post under a water cap
        if (ownPave && /^(wheat|carrots|potatoes|beetroots|farmland)$/.test(b.name)) { dig.push(Object.assign({}, c, { block: 'air', then: c, decor: b.name })); continue } // the crop is harvested / the tilled tile broken first (`decor` = allowProtected: farmland is a PROTECTED block), the paving goes in on the next pass - 11:1xZ audit: base_field_6 0 MISSING but still 4 `cobblestone@-380,68,-401=farmland`
        if (!ownPave && (/^(wheat|carrots|potatoes|beetroots|water|farmland)$/.test(b.name) || (bot.blockAt(new Vec3(c.x, c.y - 1, c.z)) || {}).name === 'farmland')) continue // levelling a FARM: a growing crop / working farmland one step lower stays - but NOT where the blueprint itself paves (10:5xZ: the 9 posts were dug free and then skipped again, because their soil cell one step lower is farmland)
        // OUR OWN small decoration (a torch of the light job, a button) inside a cell that wants a solid block is MOVED: dug (allowProtected), the block placed, a torch put back on top
        if (DECOR.test(b.name) && solidItem(c.block)) { dig.push(Object.assign({}, c, { block: 'air', then: c, decor: b.name })); continue }
        // ... and only when the block that goes in EXISTS (09-19: field paths were cut out of the grass with 0 cobblestone in the world = a net of trenches)
        if (solid(b) && !BL.isReplaceable(b)) { if (!U.protectedBlock(b) && !foreign()) { if (exact(c) ? A.count(bot, c.block) > 0 : haveMat(c)) dig.push(Object.assign({}, c, { block: 'air', then: c })); else { wait++; st.missing = { item: c.block, t: Date.now() } } } continue } // wrong block in the way (chests/beds/torches are never dug)
        // NOTHING IS PLACED ON A GROUND CELL THAT IS STILL OPEN (road paving / a wall over the blueprint's own `fillOnly` ground cell): with a side neighbour as support the
        // paving went in first = a deck over air (09-19: road 2, cobblestone y68 over air y67-66 on its whole centre line). It waits until the column is filled from the
        // natural ground up; over water/lava or a drop of 7+ (groundUnder null, reported as void) it is placed as before (a deck over water is a bridge).
        if (!c.fillOnly && solidItem(c.block) && groundKeys.has(c.x + ',' + (c.y - 1) + ',' + c.z)) { const q = at(c.x, c.y - 1, c.z); if (q && !solid(q) && !/^(water|lava)$/.test(q.name) && shallow({ x: c.x, y: c.y - 1, z: c.z })) { wait++; continue } }
        // NEVER A LID, FOR THE BLUEPRINT'S OWN GROUND LAYER TOO (09-20, field 1: the path line z -428 lay open 2 deep at x -348..-339 after escapes and a creeper; a path/soil
        // cell has side support, so the re-run would have laid it as a deck over the hole): open below and shallow -> the column is filled from the natural ground up first
        if (!c.fillOnly && solidItem(c.block) && !c.facing && !c.axis && !c.needs && c.y <= o.y && softBelow(c) && shallow({ x: c.x, y: c.y - 1, z: c.z })) { const gy = groundUnder(c); if (gy != null && gy < c.y) { put.push({ x: c.x, y: gy, z: c.z, block: groundFill || 'dirt', fillOnly: true, under: true, g: c.y, deepFill: c.y - gy >= 3 }); continue } }
        const sup = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => solid(bot.blockAt(new Vec3(c.x + dx, c.y + dy, c.z + dz))))
        if (sup || /torch/.test(c.block)) put.push(c)
      }
    }
    // nearest COLUMN first, top-down inside it (09-19 level_farm: strict top-down sent all 8 bots to unreachable tree crowns, done:0 for 5 min;
    // high leaves are skipped above - they decay once the logs are gone)
    const band = c => Math.floor(Math.hypot(c.x - me.x, c.z - me.z) / 4)
    if (layered) dig.sort((a, b) => (b.y - a.y) || (me.distanceTo(new Vec3(a.x, a.y, a.z)) - me.distanceTo(new Vec3(b.x, b.y, b.z)))) // a pit goes down layer by layer
    else dig.sort((a, b) => (band(a) - band(b)) || (b.y - a.y) || (me.distanceTo(new Vec3(a.x, a.y, a.z)) - me.distanceTo(new Vec3(b.x, b.y, b.z))))
    // bottom-up; the walk-in ramp of a solid fill comes first
    // params.order:'near' (long terrain-following walls): nearest COLUMN first, bottom-up inside it - a global bottom-up order marches the whole squad to the lowest corner of a 280-block line
    const near = P.order === 'near'
    // WHERE A GOOD PLAYER PUTS THE NEXT BLOCK IN A PIT (owner 11:3xZ, the rule in two sentences): he stands ON the floor he is making and raises it evenly AROUND
    // himself, stepping up onto each new layer; he never walks down into the deepest hole to wall himself in. Tiers for a SOLID fill (2-block distance bands, lowest
    // cell first inside a band):
    //   0  my own layer within 8 blocks (feet y down to feet-3)   the floor I stand on grows around me
    //   1  one step UP within 8 blocks                            only when tier 0 is empty: placing it walks me onto the new layer and the rise goes on
    //   2  the same height band further away                      walk over the FINISHED floor to the next patch
    //   3  a tower above my head                                  after everything at floor level
    //   4  more than 3 below my feet                              last: a deep pit is entered over the ramp or the rising floor, never by dropping into it
    // Tiers are relative, so nothing ever stalls: a builder on the rim of an empty pit has only tier-4 cells and works them. `params.order:'near'` keeps its meaning
    // for every other blueprint (nearest column first, bottom-up inside it).
    const F = Math.floor(me.y)
    const tier = c => {
      if (!c.solid) return 0
      if (c.y < F - 3) return 4
      if (c.y > F + 1) return 3
      if (Math.hypot(c.x - me.x, c.z - me.z) > 8) return 2
      return c.y <= F ? 0 : 1
    }
    const band2 = c => Math.floor(Math.hypot(c.x - me.x, c.z - me.z) / 2)
    const fillOrder = !!open
    put.sort((a, b) => ((b.ramp ? 1 : 0) - (a.ramp ? 1 : 0)) || ((b.hot ? 1 : 0) - (a.hot ? 1 : 0)) || ((a.redo ? 1 : 0) - (b.redo ? 1 : 0)) ||
      (fillOrder ? ((tier(a) - tier(b)) || (band2(a) - band2(b)) || (a.y - b.y)) : ((near ? band(a) - band(b) : 0) || (a.y - b.y) || ((a.block === 'water') - (b.block === 'water')))) ||
      (me.distanceTo(new Vec3(a.x, a.y, a.z)) - me.distanceTo(new Vec3(b.x, b.y, b.z))))
    return { dig, put, wait, deep, far, sealed: open ? open.sealed : [] }
  }
  let done = 0; let streak = 0; let lockSpins = 0; let dropped = 0; const fails = {}
  // SOLID FILL placing: plain placeBlock (no scaffolds, no pillars, no support columns - the fill itself is the floor the builder rides up on).
  // A cell nobody can reach (deep shaft under the rim, pocket) gets a GRAVITY block dropped down its open shaft from wherever a stand with a
  // visible side face exists; never from inside the column. No luck -> the COLUMN rests for 3 min (not a permanent give-up: access changes as the fill rises).
  const GRAV = ['gravel', 'sand', 'red_sand']
  const getGrav = async () => { const have = GRAV.find(n => A.count(bot, n)); if (have || st.gravTried || !GRAV.some(n => A.stockOf(n) > 0)) return have; st.gravTried = true; const n = GRAV.find(q => A.stockOf(q) > 0); task(bot, 'build: getting ' + n + ' (gravity fill)'); await A.obtain(bot, n, 32, { stop: api.stop }); await A.travel(bot, { x: o.x, y: null, z: o.z }, { range: 14, ms: 120000, stop: api.stop }); task(bot, 'build ' + P.blueprint); return GRAV.find(q => A.count(bot, q)) }
  const fillCell = async (c, item) => {
    const pos = new Vec3(c.x, c.y, c.z)
    // A FLOWER IN THE CELL IS NOT A FILLED CELL AND NOT A PLACE TO PUT A BLOCK (10:4xZ fill_ravine_n: 1386 cells left, `done:0` x393 by 34 bots - the LOWEST open cells were
    // dandelions/poppies on the old ravine floor; placeBlock said `occupied`, the cells rested 30 s, and every pass spent its 8 failures on the same flowers before it
    // reached a single cell of the two open layers): pull the plant first; out of reach -> the COLUMN rests 10 min like any unreachable cell.
    // ...but ANY failed dig resting the whole column for 10 min left the flower cells open as 1-block holes in the finished floor (owner 11:0xZ "花のある位置にブロックが置けず、
    // 穴が空いている"): `locked` is a mate holding the block for a moment (back in 20-45 s like any locked cell) and `no_los` is usually a bad stand (walk up to it and try
    // once). Only a plant we truly cannot reach rests the column.
    { const cur = at(c.x, c.y, c.z)
      if (cur && WEED_RE.test(cur.name)) {
        const pull = () => BL.digBlock(bot, pos, { collect: false, requireHarvest: false, plug: false }).catch(e => ({ ok: false, reason: String(e && e.message) }))
        let d = await pull(); const why = String((d && d.reason) || '')
        if (!(d && d.ok) && /locked/.test(why)) { st.lockSkip = st.lockSkip || {}; st.lockSkip[K(c)] = Date.now() + 20000 + Math.floor(Math.random() * 25000); return { ok: false, reason: 'lock:weed' } }
        if (!(d && d.ok) && /no_los|unreachable/.test(why) && Math.abs(c.y - Math.floor(bot.entity.position.y)) <= 5 && await A.travel(bot, { x: c.x, y: c.y, z: c.z }, { range: 2, ms: 12000, stop: api.stop, quiet: true })) d = await pull()
        if (!(d && d.ok)) { st.colSkip = st.colSkip || {}; st.colSkip[c.x + ',' + c.z] = Date.now() + 600000; return { ok: false, reason: 'rest:weed ' + String(d && d.reason).slice(0, 12) } }
      } }
    if (c.solid && (mateBlocked().has(K(c)) || wallsIn(c))) return { ok: false, reason: 'mate' } // read again right before placing: mates move while a pass runs
    // LAVA FIRST, AND NEVER FROM BESIDE IT: gravity block down the shaft from wherever we stand, else a stand that touches no lava and is 2+ away horizontally (avoidStand);
    // nothing works -> the column rests 3 min and the job says so once. A builder is never sent to a cell that touches lava (todo() makes those wait).
    if (c.solid && (c.hot || nearLava(c.x, c.y, c.z))) {
      if (await getGrav()) { const gd = await A.gravityDrop(bot, pos, c.g + 1); if (gd) { dropped++; return { ok: true, dropped: gd } } }
      const away = q => nearLava(q.x, q.y, q.z) || (Math.abs(q.x - c.x) <= 1 && Math.abs(q.z - c.z) <= 1 && q.y <= c.y)
      const rl = await BL.placeBlock(bot, pos, item, { retries: 0, moveMs: 8000, avoidStand: away }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (rl && rl.ok) return rl
      st.colSkip = st.colSkip || {}; st.colSkip[c.x + ',' + c.z] = Date.now() + 180000
      if (!st.lavaSaid) { st.lavaSaid = true; A.result(bot, { ev: 'lava_blocked', job: job.id, at: [c.x, c.y, c.z], why: 'lava cell: no gravel/sand to drop from the rim and no stand clear of the lava (' + String(rl && rl.reason).slice(0, 24) + ')' }) }
      return { ok: false, reason: 'rest:lava' }
    }
    let r = await BL.placeBlock(bot, pos, item, { retries: 1, moveMs: 8000 }).catch(e => ({ ok: false, reason: String(e && e.message) }))
    if (!r.ok && !/unreachable|no_los|locked/.test(String(r.reason))) { st.lockSkip = st.lockSkip || {}; st.lockSkip[K(c)] = Date.now() + (/occupied/.test(String(r.reason)) ? 300000 : 30000) } // `occupied` does not change in 30 s: 5 min, the pass goes on to cells it CAN do
    if (r.ok || !/unreachable|no_los/.test(String(r.reason))) return r
    // A GROUND COLUMN NO RIM SHOWS (a 1x1 shaft under a pad cell) IS FILLED FROM INSIDE: step in, jump-place under the feet, ride up with it (army.js fillInside; drop <= 3 by
    // the pathfinder's own rule). Big solid fills (fill_void) keep their own way: builders already work inside the void on the rising floor.
    if (!c.solid && await A.fillInside(bot, pos, item, { stop: api.stop })) return { ok: true, inside: true }
    // gravity blocks are fetched from the rim only: a builder down in the void uses what it carries
    const g = depthNow() <= 2 ? await getGrav() : GRAV.find(n => A.count(bot, n)) // from the rim only: a builder down in the void uses what it carries
    if (g) { const gd = await A.gravityDrop(bot, pos, c.g + 1); if (gd) { dropped++; return { ok: true, dropped: gd } } } // ONE implementation: lib/army.js gravityDrop (side faces only, from the rim, never from inside the column)
    st.colSkip = st.colSkip || {}; st.colSkip[c.x + ',' + c.z] = Date.now() + 180000
    return { ok: false, reason: 'rest:' + r.reason }
  }
  // PAIRED CHESTS MUST MERGE (owner 09-20 04:1xZ: the depot "rows of DOUBLE chests" stood as 70 single chests + 10 halves; the probe read facings s/e/w/n at random).
  // A chest takes its facing from the placer (it faces HIM) and joins a neighbour only when both face the same way and the placer is not sneaking - unless he
  // sneak-clicks the partner's side. placeBlock took any stand and any reference, and sneaks whenever the reference is a container. So a chest cell with
  // facing + half (blueprint depot_rows) is placed from the aisle it faces, square in front, against the FLOOR without sneak (over a container: against the
  // partner's side, which merges even while sneaking); then the WORLD is read: wrong facing or still single beside a single partner = taken back (it is
  // empty) and tried again. chestWrong() is the same judgement for chests that already stand: those are re-made by redoChest.
  const FV = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
  const propsOf = b => { try { return (b && b.getProperties()) || {} } catch (e_) { swallow('army_jobs:chestProps', e_); return {} } }
  const partnerOf = c => { const fv = FV[c.facing]; const d = c.half ? -1 : 1; return fv[0] ? [c.x, c.z + d] : [c.x + d, c.z] } // the pair runs ACROSS the facing; half 0 has its partner at +1
  // which neighbour a merged half belongs to (vanilla getConnectedDirection: LEFT -> clockwise of its facing, RIGHT -> counter-clockwise)
  const CW = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }
  const joinedTo = (c, p) => { const d = CW[p.facing]; const k = p.type === 'left' ? 1 : -1; return [c.x + d[0] * k, c.z + d[1] * k] }
  const chestWrong = (c, b) => { const p = propsOf(b); if (!p.facing) return null; if (p.facing !== c.facing) return 'faces ' + p.facing; if (p.type === 'left' || p.type === 'right') { const j = joinedTo(c, p); const w = partnerOf(c); return j[0] === w[0] && j[1] === w[1] ? null : 'merged with the wrong neighbour' } if (p.type !== 'single' || !c.half) return null; const [px, pz] = partnerOf(c); const pb = at(px, c.y, pz); const q = pb && pb.name === b.name ? propsOf(pb) : null; return q && q.facing === c.facing && q.type === 'single' ? 'not merged' : null } // two good singles: the SECOND half is re-made (one bot, one chest)
  const redoBook = () => { if (Date.now() - (st.rbT || 0) > 4000) { st.rbT = Date.now(); const j = ((A.readJSON(A.F.board, {}) || {}).jobs || []).find(q => q.id === job.id); st.rb = (j && j.redo) || {} } return st.rb || {} }
  const redoClaimed = c => { const e = redoBook()[K(c)]; return !!(e && e.by !== bot.username && Date.now() - (e.t || 0) < 480000) }
  const placeChest = async (c, item) => {
    const fv = FV[c.facing]; const pos = new Vec3(c.x, c.y, c.z); const [px, pz] = partnerOf(c); let last = 'no stand square in front of the chest cell'
    for (let k = 0; k < 4 && !api.stop(); k++) {
      const sd = k % 2 ? 2 : 1
      await A.travel(bot, { x: c.x + fv[0] * sd, y: null, z: c.z + fv[1] * sd }, { range: 0, ms: 20000, stop: api.stop, quiet: true })
      const p = bot.entity.position; const along = Math.abs(fv[0] ? p.z - (c.z + 0.5) : p.x - (c.x + 0.5)); const off = (fv[0] ? p.x - (c.x + 0.5) : p.z - (c.z + 0.5)) * (fv[0] + fv[1])
      if (along > 0.45 || off < 0.9 || off > 3.5) continue
      const below = at(c.x, c.y - 1, c.z); const pb = at(px, c.y, pz)
      // WHO it merges with is decided here, not by the server's search order (clockwise neighbour first = the WRONG pair for every half 0): the partner stands,
      // single and square -> sneak-click ITS side (placeBlock sneaks on a container reference): joins exactly that chest. No partner yet -> sneak-click the floor:
      // stays single until the partner comes and clicks us. Last two tries: the plain floor click without sneak (the server pairs it), judged like the others.
      const pq = pb && pb.name === item ? propsOf(pb) : null; const joinable = !!pq && pq.facing === c.facing && pq.type === 'single'
      const faces = joinable && k < 2 ? [new Vec3(c.x - px, 0, c.z - pz)] : solid(below) && !BL.INTERACTABLE.test(below.name) ? [new Vec3(0, 1, 0)] : undefined
      try { bot.setControlState('sneak', !joinable && k < 2) } catch (e_) { swallow('army_jobs:chestSneak', e_) }
      // THE LOOK MUST REACH THE SERVER BEFORE THE CLICK (measured 04:19Z: three chests re-placed from the south aisle came out facing EAST again - placeBlock's forced
      // lookAt only sets the yaw, the packet leaves with the next physics tick, the click leaves at once: the server still had the yaw of the walk along the aisle.
      // That is why 60 of 80 chests faced east/west.) Look at the cell first, let two ticks pass, then place.
      try { await bot.lookAt(new Vec3(c.x + 0.5, c.y, c.z + 0.5), true) } catch (e_) { swallow('army_jobs:chestLook', e_) } await sleep(200)
      const r = await BL.placeBlock(bot, pos, item, { retries: 1, noMove: true, faces }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      try { bot.setControlState('sneak', false) } catch (e_) { swallow('army_jobs:chestSneakOff', e_) }
      if (!r.ok) { last = r.reason; continue }
      await sleep(350); const me = propsOf(at(c.x, c.y, c.z)); const q = pb && pb.name === item ? propsOf(at(px, c.y, pz)) : null
      const bad = me.facing && me.facing !== c.facing ? 'faces ' + me.facing : (me.type === 'left' || me.type === 'right') && joinedTo(c, me).join() !== [px, pz].join() ? 'merged with the wrong neighbour' : (q && q.facing === c.facing && me.type === 'single' && (q.type === 'single')) ? 'did not merge' : null
      if (bad) { await BL.digBlock(bot, pos, { collect: true, requireHarvest: false, allowProtected: true, own: job.id }).catch(e_ => { swallow('army_jobs:chestRedo', e_) }); await A.pickup(bot, 4, 2500); last = bad; continue }
      A.result(bot, { ev: 'chest_placed', job: job.id, at: [c.x, c.y, c.z], facing: me.facing, type: me.type })
      return r
    }
    return { ok: false, reason: 'chest:' + last }
  }
  // RE-MAKE A STANDING CHEST (c.redo = why): claim it on the board (8 min) -> take it OFF settings.chests (nobody banks into it any more; the other processes'
  // settings cache is 5 s old at most) -> carry its contents to the other depot chests (A.bank with avoid; what the bot carried before stays with it) ->
  // open it once more: EMPTY, or nothing is dug -> dig, pick everything up -> placeChest. The registration at the end of every pass books what stands
  // (a merged pair once) - also when this routine gives up half way: a chest that still stands is simply registered again.
  const redoChest = async (c) => {
    const key = K(c); const pos = new Vec3(c.x, c.y, c.z); let mine = false
    A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (!j) return; j.redo = j.redo || {}; for (const k of Object.keys(j.redo)) if (Date.now() - (j.redo[k].t || 0) > 480000) delete j.redo[k]; const e = j.redo[key]; if (e && e.by !== bot.username) return; j.redo[key] = { by: bot.username, t: Date.now() }; mine = true; for (const l of Object.values((b.settings || {}).chests || {})) { const i = l.findIndex(q => q[0] === c.x && q[1] === c.y && q[2] === c.z); if (i >= 0 && l.length > 1) l.splice(i, 1) } })
    st.rbT = 0
    if (!mine) return { ok: false, reason: 'locked' }
    task(bot, 'build: re-making chest ' + key + ' (' + c.redo + ')')
    try {
      const mineBefore = A.inv(bot); await sleep(6000)
      for (let trip = 0; trip < 6 && !api.stop(); trip++) {
        const w = await A.openChest(bot, pos, { stop: api.stop }); if (!w) return { ok: false, reason: 'chest: cannot open it' }
        let left = 0
        try { for (const it of w.containerItems()) { if (w.items().length >= 35) { left++; continue } try { await U.withTimeout(w.withdraw(it.type, null, it.count), 6000, 'chestEmpty') } catch (e_) { left++ } await sleep(80) } left = w.containerItems().length; A.record(bot, pos, w) } finally { A.closeWin(w); await sleep(200) }
        if (!left && !trip && JSON.stringify(A.inv(bot)) === JSON.stringify(mineBefore)) break // it was empty
        await A.bank(bot, mineBefore, { job: job.id, stop: api.stop, noKit: true, avoid: [key] })
        if (!left) break
      }
      const w2 = await A.openChest(bot, pos, { stop: api.stop }); if (!w2) return { ok: false, reason: 'chest: cannot open it' }
      let n2 = 0; try { n2 = w2.containerItems().length } finally { A.closeWin(w2); await sleep(150) }
      if (n2) return { ok: false, reason: 'chest: still holds ' + n2 + ' stacks (depot full?)' }
      const d = await BL.digBlock(bot, pos, { collect: true, requireHarvest: false, allowProtected: true, own: job.id }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (!d.ok) return { ok: false, reason: 'chest dig:' + d.reason }
      await A.pickup(bot, 5, 4000)
      try { const ix = A.index(); if (ix[key]) { delete ix[key]; A.writeJSON(A.F.chests, ix) } } catch (e_) { swallow('army_jobs:redoIndex', e_) }
      if (!A.count(bot, c.block)) await A.obtain(bot, c.block, 1, { stop: api.stop })
      const r = await placeChest(c, c.block)
      A.result(bot, { ev: 'chest_remade', job: job.id, at: [c.x, c.y, c.z], why: c.redo, ok: !!r.ok, type: propsOf(at(c.x, c.y, c.z)).type || null })
      return r
    } finally { A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.redo && j.redo[key] && j.redo[key].by === bot.username) delete j.redo[key] }) }
  }
  // ORIENTED cells (blueprint cell `axis:'x'|'z'` = the direction the WALL runs; fence gates, doors): the block takes its facing from the builder's yaw, so the
  // builder first stands square in front of the opening (2 or 1 cells off the wall line, either side). A gate that came out crosswise is taken out again.
  // `facing:'north'|'south'|'east'|'west'` (beds: the HEAD lands one cell further that way, the blueprint keeps that cell free): ONE stand side - behind the foot, looking that way.
  const placeOriented = async (c, item) => {
    const fv = c.facing ? { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[c.facing] : null; const axis = fv ? (fv[0] ? 'z' : 'x') : c.axis
    const pos = new Vec3(c.x, c.y, c.z); const good = fv ? new RegExp('^' + c.facing + '$') : axis === 'x' ? /^(north|south)$/ : /^(east|west)$/; let last = 'no stand square to the opening'
    for (const s of fv ? [-2 * (fv[0] + fv[1]), -(fv[0] + fv[1])] : [2, -2, 1, -1]) {
      if (api.stop()) break
      await A.travel(bot, axis === 'x' ? { x: c.x, y: null, z: c.z + s } : { x: c.x + s, y: null, z: c.z }, { range: 0, ms: 20000, stop: api.stop, quiet: true })
      const p = bot.entity.position; const along = Math.abs(axis === 'x' ? p.x - (c.x + 0.5) : p.z - (c.z + 0.5)); const off = Math.abs(axis === 'x' ? p.z - (c.z + 0.5) : p.x - (c.x + 0.5))
      if (along > 0.45 || off < 0.9 || off > 3.5) continue
      try { await bot.lookAt(pos.offset(0.5, 0, 0.5), true) } catch (e_) { swallow('army_jobs:orientLook', e_) } await sleep(200) // the yaw must be ON THE SERVER before the click (see placeChest): beds and gates came out crosswise and were re-done
      const r = await BL.placeBlock(bot, pos, item, { retries: 1, noMove: true }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (!r.ok) { last = r.reason; continue }
      await sleep(250); const b = at(c.x, c.y, c.z); let f = null; try { f = b.getProperties().facing } catch (e_) { swallow('army_jobs:orientProps', e_) }
      if (f && !good.test(f)) { await BL.digBlock(bot, pos, { collect: true, requireHarvest: false, allowProtected: true, own: job.id }).catch(e_ => { swallow('army_jobs:orientRedo', e_) }); last = 'crosswise (' + f + ')'; continue }
      A.result(bot, { ev: 'gate_placed', job: job.id, at: [c.x, c.y, c.z], block: item, facing: f })
      return r
    }
    return { ok: false, reason: 'orient:' + last }
  }
  // THE WATER CELL ROUTINE - the only code of the army that pours water into a field. Order: claim -> WATER IN HAND FIRST (an open 1x1 hole never waits
  // for a bucket) -> floor + 4 sides re-checked -> the cell and the cell over it opened (plug:false: digBlock's "plug the adjacent liquid" put blocks INTO
  // world 1's holes) -> ONE bucket through the aim-checked, server-verified `pour` verb (it refuses open sides and contains a leak) -> the world is read
  // again: a SOURCE stands and nothing flows beside it -> `water_cell`. Anything else = `water_cell_failed` with the reason, counted on the board.
  const bucketWater = async () => { // carried -> depot -> a bucket (depot / 3 iron_ingot through the normal obtain path) filled at params.waterFrom or the nearest open source that is not ours
    if (A.count(bot, 'water_bucket')) return true
    if (A.stockOf('water_bucket') > 0) { await A.withdraw(bot, 'water_bucket', 1, { stop: api.stop }); if (A.count(bot, 'water_bucket')) return true }
    if (!A.count(bot, 'bucket')) { task(bot, 'build: getting a bucket'); await A.obtain(bot, 'bucket', 1, { stop: api.stop }) }
    if (!A.count(bot, 'bucket')) return 'no bucket carried, in stock or craftable (3 iron_ingot)'
    const ours = q => waterKeys.has(q.x + ',' + q.y + ',' + q.z)
    let from = Array.isArray(P.waterFrom) ? v(P.waterFrom) : null
    if (!from) { const open = q => { const a = bot.blockAt(q.offset(0, 1, 0)); return isSrc(bot.blockAt(q)) && a && a.name === 'air' && !ours(q) }; from = bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 64, count: 300 }).filter(open).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0] || null }
    if (!from) return 'no open water source within 64 blocks of the site - give the job params.waterFrom:[x,y,z] (a lake/river cell)'
    task(bot, 'build: fetching water')
    const r = await VERBS.fill(bot, { at: [from.x, from.y, from.z], radius: 8, avoid: ours }, api)
    return r === true ? true : String(r)
  }
  const waterCell = async c => {
    const pos = new Vec3(c.x, c.y, c.z); const key = K(c); let won = false
    waterEdit(w => { const e = w[key]; if (e && ((e.fail || 0) >= 2 || (e.by && e.by !== bot.username && Date.now() - (e.t || 0) < 360000))) return; w[key] = Object.assign({}, e, { by: bot.username, t: Date.now() }); won = true })
    if (!won) return { ok: false, reason: 'locked' }
    let out = { ok: false, reason: 'interrupted' }; let counted = false
    try {
      const w = await bucketWater()
      if (w !== true) { out = { ok: false, reason: 'no_water', noWater: String(w) }; return out }
      if (api.stop()) return out
      task(bot, 'build: water cell ' + key)
      if (bot.entity.position.distanceTo(pos) > 5 && !await A.travel(bot, pos.offset(1, 1, 1), { range: 3, ms: 180000, stop: api.stop })) { out = { ok: false, reason: 'unreachable' }; return out }
      if (isSrc(at(c.x, c.y, c.z))) { out = { ok: true, already: true }; return out } // seen from afar the chunk data may have been stale
      if (!solid(at(c.x, c.y - 1, c.z)) || !SIDES.every(([dx, dz]) => solid(at(c.x + dx, c.y, c.z + dz)))) { out = { ok: false, reason: 'locked' }; return out } // floor/sides changed while the water was fetched: their cells come first again
      for (const p of [pos.offset(0, 1, 0), pos]) { // whatever catches the bucket click over the cell, then the cell itself
        const b = at(p.x, p.y, p.z); if (!b || /^(air|cave_air|water)$/.test(b.name)) continue
        if (U.protectedBlock(b) && !DECOR.test(b.name)) { counted = true; out = { ok: false, reason: 'a ' + b.name + ' stands in the water cell' }; return out }
        const f = bot.entity.position.floored(); if (f.x === c.x && f.z === c.z) { for (const [dx, dz] of SIDES) { const q = pos.offset(dx, 1, dz); if (solid(at(q.x, q.y - 1, q.z)) && !solid(at(q.x, q.y, q.z)) && await A.travel(bot, q, { range: 0, ms: 15000, stop: api.stop, quiet: true })) break } } // never dig the column we stand in
        const r = await BL.digBlock(bot, p, { collect: true, requireHarvest: false, plug: false, allowProtected: DECOR.test(b.name), own: job.id }).catch(e => ({ ok: false, reason: String(e && e.message) }))
        await sleep(400); const n = at(p.x, p.y, p.z)
        if (n && !/^(air|cave_air|water)$/.test(n.name)) { counted = true; out = { ok: false, reason: 'cannot open ' + [p.x, p.y, p.z].join(',') + ' (' + n.name + '): ' + String(r && r.reason).slice(0, 30) }; return out }
      }
      await sleep(500)
      const flowing = () => bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 3, count: 40, point: pos }).filter(q => !isSrc(bot.blockAt(q))).length
      const flow0 = flowing() // a neighbour's old leak is not this pour's
      const r = isSrc(at(c.x, c.y, c.z)) ? true : await VERBS.pour(bot, { at: [c.x, c.y, c.z], waterCell: true }, api) // (ice over a floor melts into a source by itself)
      await sleep(1200)
      const flows = Math.max(0, flowing() - flow0)
      if (r === true && isSrc(at(c.x, c.y, c.z)) && !flows) { out = { ok: true }; A.result(bot, { ev: 'water_cell', job: job.id, at: [c.x, c.y, c.z], left: [...waterKeys].filter(k => { const [x, y, z] = k.split(',').map(Number); return !isSrc(at(x, y, z)) }).length }); return out }
      if (api.stop() && r !== true && !/LEAK/.test(String(r))) return out
      counted = true; out = { ok: false, reason: r === true ? 'poured, but ' + (flows ? flows + ' blocks of water flow beside the cell' : 'no source stands there') : String(r).slice(0, 120) }
      return out
    } finally {
      let fails = 0
      waterEdit(w => { const e = Object.assign({}, w[key]); delete e.by; delete e.t; if (counted) { e.fail = (e.fail || 0) + 1; e.why = String(out.reason).slice(0, 120) } fails = e.fail || 0; if (Object.keys(e).length) w[key] = e; else delete w[key] })
      if (counted) A.result(bot, { ev: 'water_cell_failed', job: job.id, at: [c.x, c.y, c.z], why: String(out.reason).slice(0, 120), fails, retired: fails >= 2 })
    }
  }
  // WOOD-AGNOSTIC: nothing carried, nothing of `mats` in the depot -> craft the variant craft.js `resolve` picks from what we own (species by planks/logs, a bed by its wool)
  const craftPick = c => {
    const g = c.wood || (/_bed$/.test(c.block) ? 'bed' : null); if (!g) return null
    const have = A.stockMap(); for (const [k, n] of Object.entries(A.inv(bot))) have[k] = (have[k] || 0) + n
    const n = lib('craft').resolve(bot.registry, g, have); return (c.mats || []).includes(n) ? n : null
  }
  const matsOf = c => (c.solid || c.mats) ? [c.block].concat((c.mats || []).filter(n => n !== c.block)) : [c.block] // `mats` on any cell = accepted substitutes (a wall takes what the depot has)
  // FILL builders work INSIDE the void and ride up on the rising floor. Nobody waits for the last block down there: a builder below grade keeps a RESERVE
  // (its depth + 2) and climbs out on it - a walkable way (ramp / risen floor) when the pathfinder sees one, else a pillar next to the wall of the box
  // (the pillar stands on the solid floor = it is fill). Without this the army's escape cut staircases into the trench walls (dug_out, 09-19 14:47Z).
  const f0 = cells.find(q => q.solid); const fillG = f0 ? f0.g : 0
  const bx = f0 ? cells.reduce((m, q) => q.solid ? { x1: Math.min(m.x1, q.x), x2: Math.max(m.x2, q.x), z1: Math.min(m.z1, q.z), z2: Math.max(m.z2, q.z) } : m, { x1: Infinity, x2: -Infinity, z1: Infinity, z2: -Infinity }) : null
  const fillMats = () => f0 ? matsOf(f0).reduce((n, m) => n + A.count(bot, m), 0) : 0
  const depthNow = () => { if (!f0) return 0; const p = bot.entity.position.floored(); return (p.x >= bx.x1 && p.x <= bx.x2 && p.z >= bx.z1 && p.z <= bx.z2) ? fillG + 1 - p.y : 0 }
  // ONE TRIP, NOT SIX (top model 11:3xZ; MEASURED 11:0xZ: a withdrawal takes 24 s of which 23.9 s is WALKING - the trip is the cost, never the transaction). A fill
  // builder took 192 blocks = 3 stacks per trip and was back at the depot every few minutes. It now takes what its free pockets hold, minus 8 slots for what it digs
  // up on the way (capped at 1024 = 16 stacks), and the bank keep-list below keeps that filler out of the chests again.
  // ...but a big load must not be ONE builder emptying the depot for the other nineteen (11:43Z, the first minute with 20 builders on fill_ravine_s: `build_blocked no
  // filler` x11 and `the depot index promised 64 cobblestone, the chests gave 0` - the first trips had taken the lot). A builder takes its share: the pile divided by
  // the crew, never less than 64, never more than the pockets hold.
  const crewN = () => { if (Date.now() - (st.crewT || 0) > 60000) { st.crewT = Date.now(); st.crewN = crewOf(job, bot.username).n } return st.crewN || 1 }
  const fillBatch = mat => {
    const pockets = Math.max(192, Math.min(1024, (U.freeSlots(bot) - 8) * 64))
    return Math.max(64, mat ? Math.min(pockets, Math.ceil(A.stockOf(mat) / crewN())) : pockets)
  }
  // A FILL'S SUBSTITUTES ARE WITHDRAWN, NEVER CRAFTED (foreman 11:25Z, measured: `obtain_failed {"item":"diorite","n":192,"why":"got 0/192 missing {cobblestone:192,
  // quartz:192}"}` from Riko 11:17:20, the same for granite and andesite - A.obtain falls through to the recipe solver, so a `mats` list of raw stone types sent
  // builders off to CRAFT diorite out of quartz nobody owns). The filler is whatever the depot has MOST of, taken straight out of the chest index (A.withdraw); with
  // nothing in the depot the job says `build_blocked no filler` once and the builder goes back to the board.
  // ...AND A FILL NEVER EATS A RESERVE (11:47Z, measured: depot dirt 1151 -> 0 and cobblestone 578 -> 54 in 15 minutes, because `dirt` stands in the ravine jobs' `mats`
  // list and was the biggest pile - `base_yard_pad` and every other `level` job then reported "no dirt carried or in stock", and the dirt CAP a finished fill wants had
  // nothing left to lay). A fill takes its OWN declared fill/top block freely (that is what the surplus stone of the mine is for), but a SUBSTITUTE only out of the
  // surplus over settings.targets, and soil (dirt/gravel/sand/clay) only when no stone-family filler has any: soil is the skin of the base, rubble is not.
  const SOIL_RE = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mud|gravel|sand|red_sand|clay)$/
  const bestOfMats = list => {
    const m = A.stockMap(); const T = A.settings().targets || {}; const own = new Set([list[0], (P.args || {}).fill, (P.args || {}).top].filter(Boolean))
    const free = q => (m[q] || 0) - (own.has(q) ? 0 : (T[q] || 0))
    return list.filter(q => free(q) > 0).sort((a, b) => (SOIL_RE.test(a) ? 1 : 0) - (SOIL_RE.test(b) ? 1 : 0) || free(b) - free(a))[0] || null
  }
  const bestMat = () => f0 ? bestOfMats(matsOf(f0)) : null
  const restock = async () => { const n = bestMat(); if (!n) return false; task(bot, 'build: getting ' + n); await A.withdraw(bot, n, fillBatch(n), { stop: api.stop }); task(bot, 'build ' + P.blueprint); await A.travel(bot, { x: o.x, y: null, z: o.z }, { range: 14, ms: 120000, stop: api.stop }); return fillMats() > 0 }
  const climbOut = async () => {
    const from = bot.entity.position.floored(); task(bot, 'build: climbing out of the fill (blocks low)')
    try { const { goals } = require('mineflayer-pathfinder'); for (const [x, z] of (bx.z2 - bx.z1 <= bx.x2 - bx.x1 ? [[from.x, bx.z1 - 2], [from.x, bx.z2 + 2]] : [[bx.x1 - 2, from.z], [bx.x2 + 2, from.z]])) { const r = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalNear(x, fillG + 1, z, 2), 500); if (r && r.status === 'success') return 'walk' } } catch (e_) { swallow('army_jobs:climbPath', e_) }
    const edge = (x, z) => x === bx.x1 || x === bx.x2 || z === bx.z1 || z === bx.z2
    if (!edge(from.x, from.z)) { // stand next to the wall of the box first (same level, read-only walk)
      const cand = []; for (let x = Math.max(bx.x1, from.x - 6); x <= Math.min(bx.x2, from.x + 6); x++) for (let z = bx.z1; z <= bx.z2; z++) if (edge(x, z)) for (let y = from.y - 1; y <= from.y + 1; y++) if (solid(at(x, y - 1, z)) && !solid(at(x, y, z)) && !solid(at(x, y + 1, z))) cand.push({ x, y, z })
      cand.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))
      for (const q of cand.slice(0, 3)) if (await A.travel(bot, q, { range: 0, ms: 12000, stop: api.stop })) break
    }
    const p = bot.entity.position.floored(); const up = await BL.pillarUp(bot, fillG + 1 - p.y, {}).catch(e_ => { swallow('army_jobs:climbPillar', e_); return 0 })
    try { require('fs').writeFileSync(require('path').join(A.DIR, '..', '.scaffold', bot.username + '.json'), '[]') } catch (e_) { swallow('army_jobs:climbLedger', e_) } // the pillar is FILL, not scaffold: nobody takes it down again
    A.result(bot, { ev: 'fill_climb_out', job: job.id, from: [from.x, from.y, from.z], at: [p.x, p.y, p.z], blocks: up })
    return 'pillar'
  }
  // A BOXED-IN BUILDER RIDES UP ON ITS OWN FILLER (owner 11:0xZ, part 2): the pillar IS the fill, so the ledger is cleared and nobody takes it down. No filler in the
  // pockets: never dig sideways - wait 20 s for the mates' floor to reach it, then the ONE escape we have (A.digOut).
  const rideUp = async () => {
    const from = bot.entity.position.floored(); const area = () => A.walkableArea(bot, 12)
    if (fillMats() < 1) {
      task(bot, 'build: boxed in, waiting for the floor to rise')
      const t1 = Date.now() + 20000; while (Date.now() < t1 && !api.stop() && area() <= 3) await sleep(2000)
      if (area() > 3) return true
      await A.digOut(bot).catch(e_ => { swallow('army_jobs:rideDigOut', e_) }); return area() > 3
    }
    task(bot, 'build: riding the fill up')
    const up = await BL.pillarUp(bot, Math.max(1, fillG + 1 - from.y), {}).catch(e_ => { swallow('army_jobs:rideUp', e_); return 0 })
    try { require('fs').writeFileSync(require('path').join(A.DIR, '..', '.scaffold', bot.username + '.json'), '[]') } catch (e_) { swallow('army_jobs:rideLedger', e_) }
    if (!st.rodeUp) { st.rodeUp = true; A.result(bot, { ev: 'fill_ride_up', job: job.id, from: [from.x, from.y, from.z], blocks: up }) }
    return area() > 3 || bot.entity.position.y > fillG
  }
  const needNote = (miss, nWait) => { st.miss = st.miss || {}; st.miss[miss] = Date.now(); const all = Object.keys(st.miss).filter(k => Date.now() - st.miss[k] < 600000).sort().join(', '); A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active' && !(j.note || '').startsWith('needs: ' + all + ' ')) j.note = 'needs: ' + all + ' (' + nWait + ' cells wait; every cell whose material exists is done or in work)' }) }
  task(bot, 'build ' + P.blueprint)
  // ONE WALK OF THE BLUEPRINT SERVES A BATCH (same measurement: the loop ran `todo()` again after EVERY single block, so a 30 000-cell fill was walked once per placed
  // block, three times per pass counting the two closing walks). The list is now reused for up to 8 cells or 6 s, and a queued cell is re-read once right before it is
  // worked and dropped when the world already satisfies it - so a mate's block is never placed twice and exactly the same cells get built.
  let qDig = []; let qPut = []; let qUsed = 0; let qT = 0; let qSkip = 0
  const satisfied = (c, cb) => { if (!cb || c.redo || c.block === 'water') return false; if (c.block === 'air') return cb.name === 'air' || cb.name === 'cave_air'; if (c.solid) return solid(cb); if (c.fillOnly && !c.solid) return solid(cb) && !GROUND_TREE_RE.test(cb.name); return cb.name === c.block || !!(c.mats && c.mats.includes(cb.name) && !exact(c)) }
  while (!api.stop() && streak < 8 && done < 120) {
    if (qUsed >= 8 || Date.now() - qT > 6000 || (!qDig.length && !qPut.length)) {
      if (Date.now() - qT < 250) await sleep(250 - (Date.now() - qT)) // a walk that yields nothing must not spin: at most four walks a second
      let t = todo()
      if (!t.dig.length && !t.put.length && t.far) t = todo(0, true) // nothing within reach: read the whole box once, as before
      qDig = t.dig; qPut = t.put; qT = Date.now(); qUsed = 0
    }
    const dig = qDig; const put = qPut
    if (!dig.length && !put.length) break
    if (streak >= 2 && Date.now() - (st.poleT || 0) > 60000) { st.poleT = Date.now(); if (await offThePole(bot, job)) { streak = 0; continue } }
    if (f0) { const d = depthNow(); if (d > 2 && fillMats() <= d + 2) { await climbOut(); if (!await restock()) { A.result(bot, { ev: 'build_blocked', job: job.id, why: 'no filler carried or in stock (' + matsOf(f0).slice(0, 4).join('/') + ' ...)' }); A.decline(bot, job, 180000, 'build: no filler in the depot'); return muster(bot, job, api, ctx, 'build: no filler') } continue } else if (d <= 2 && fillMats() < 256 && !(st.restockAt > Date.now() - 120000) && matsOf(f0).some(m => A.stockOf(m) > 0)) { st.restockAt = Date.now(); await restock() } }
    if (f0 && depthNow() > 0 && A.walkableArea(bot, 12) <= 3) { // entombed by the mates' floor: out first, work afterwards
      const okUp = await rideUp(); st.rideN = okUp ? 0 : (st.rideN || 0) + 1
      if (st.rideN >= 3) { A.askHelp(bot, 'entombed', 'boxed in below grade inside ' + job.id + ' at ' + K(bot.entity.position.floored()) + ' (walkableArea ' + A.walkableArea(bot, 12) + ')'); return muster(bot, job, api, ctx, 'build: boxed in inside the fill') }
      continue
    }
    const feet = bot.entity.position.floored(); const notUnderMe = q => !(q.x === feet.x && q.z === feet.z && q.y === feet.y - 1) // digBlock refuses the block we stand on: another builder takes it, it is not a failure of the cell
    let c = dig.length ? (dig.find(notUnderMe) || (put.length ? put[0] : dig[0])) : put[0]
    // A BUILD JOB THAT DIGS MORE THAN IT MAY STOPS ITSELF (owner 13:2xZ, the road trench). Two rules, both cheap: nothing is ever dug at a coordinate that is not a cell
    // of this blueprint, and no single cell may be dug more than 3 times in one slice - an honest repair digs a cell once, a loop digs it a hundred times (road_9:
    // -285,68,-476, 120 digs per pass). Either one pauses the job with `build_runaway {job, at, dug, allowed}` so the damage stops at four blocks, not four hundred.
    if (c.block === 'air') {
      const dk = K(c); st.dug = st.dug || {}
      const outside = !allKeys.has(dk) && !c.roof
      st.dug[dk] = (st.dug[dk] || 0) + 1
      if (outside || st.dug[dk] > 3) {
        const why = outside ? 'a cell that is not in this blueprint' : st.dug[dk] + ' digs of the same cell in one slice (dig/place loop)'
        A.result(bot, { ev: 'build_runaway', job: job.id, at: [c.x, c.y, c.z], dug: st.dug[dk], allowed: 3, why })
        A.boardEdit(b => { const q = (b.jobs || []).find(z => z.id === job.id); if (q && q.status === 'active') { q.status = 'paused'; q.note = 'auto-paused: build_runaway - ' + why + ' at ' + dk } })
        return muster(bot, job, api, ctx, 'build: runaway dig stopped (' + why + ')')
      }
    }
    { const i = qDig.indexOf(c); if (i >= 0) qDig.splice(i, 1); else { const j = qPut.indexOf(c); if (j >= 0) qPut.splice(j, 1) } qUsed++ } // taken out of the batch: never worked twice
    // a mate got there first while this batch was running. With 30+ bots on one site most of a batch can go that way, and the pass then reported `done:0` although the
    // squad was working (west_terrace_cut_2, half its passes) - which the dispatcher's yield throttle reads as an idle job. Three skips in a row force a fresh walk.
    if (satisfied(c, bot.blockAt(new Vec3(c.x, c.y, c.z)))) { qSkip++; if (qSkip >= 3) { qUsed = 8; qSkip = 0 } continue }
    qSkip = 0
    let r
    // STONE IS NEVER PUNCHED (world 2, 09-19: requireHarvest:false dug stone by hand = 7 s a block and NO drop while the army owned 1 cobblestone): a cell that needs a
    // pickaxe gets one first (getPick: depot -> stone -> the day-one wooden one). A pit (quarry) without a pickaxe is pointless: the builder is handed back.
    if (c.block === 'air') { const cb = at(c.x, c.y, c.z); if (cb && cb.material && /pickaxe/.test(cb.material) && cb.harvestTools) {
      const was = bot.entity.position.clone(); const okP = await getPick(bot, api); task(bot, 'build ' + P.blueprint)
      if (!okP && layered) { A.result(bot, { ev: 'build_blocked', job: job.id, why: 'no pickaxe carried, in stock or craftable (3 planks + 2 sticks)' }); return muster(bot, job, api, ctx, 'build: no pickaxe for the quarry') }
      if (bot.entity.position.distanceTo(was) > 12 && !await A.travel(bot, { x: was.x, y: null, z: was.z }, { range: 6, ms: 180000, stop: api.stop })) return 'build: cannot get back' // getPick walked to the depot / craft table
    } }
    if (c.block === 'air' && toolKindOf(at(c.x, c.y, c.z)) === 'axe' && !A.bestOf(bot, 'axe')) { const was = bot.entity.position.clone(); await getTool(bot, 'axe', api); if (bot.entity.position.distanceTo(was) > 12 && !await A.travel(bot, { x: was.x, y: null, z: was.z }, { range: 6, ms: 180000, stop: api.stop })) return 'build: cannot get back' }
    // A TRUNK IN THE CUT = THE WHOLE TREE (owner 09-20: floating tree remains over pads and fields - `level` clears 4 cells of headroom, the rest of the trunk and its crown
    // stayed hanging): a NATURAL log cell is felled with blocks.js harvestTree (every log of the tree, lowest first, climbing its own scaffold; the crown over our zones by
    // hand, the rest decays), no replanting on a building site. A log a blueprint of ours placed is refused by digBlock ('ours') as before.
    const cb0 = c.block === 'air' ? at(c.x, c.y, c.z) : null
    if (cb0 && BL.isTrunk(cb0.name) && !c.decor && !c.roof && !A.ourBlock(cb0.position, cb0.name) && TERRAIN_JOB.test(String(P.blueprint))) {
      const t = await BL.harvestTree(bot, cb0.position, { replant: false, crown: crownRule(), ms: 150000 }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      r = (t.ok || t.logs > 0) ? { ok: true, tree: t.logs, crown: t.crown } : { ok: false, reason: 'tree:' + String(t.reason || 'left ' + t.left).slice(0, 18) }
      if (t.logs > 0) A.result(bot, { ev: 'tree_cleared', job: job.id, at: [c.x, c.y, c.z], logs: t.logs, left: t.left, crown: t.crown || 0 })
    } else if (c.block === 'air') {
      r = await BL.digBlock(bot, new Vec3(c.x, c.y, c.z), Object.assign({ collect: true, requireHarvest: false, allowProtected: !!c.decor, own: job.id }, nearWater(c) ? { plug: false } : {})).catch(e => ({ ok: false, reason: String(e && e.message) })) // beside a water cell nothing is ever "plugged"
      if (r && r.ok && c.decor && /torch/.test(c.decor)) { st.retorch = st.retorch || {}; st.retorch[K(c)] = true }
      // A SWAP IS ONE STEP, NOT TWO PASSES (owner 13:2xZ): the wrong block comes out and the right one goes in immediately from the pockets - the cell is never left
      // open for the next walk to re-measure as "a hole". If the place fails, what was dug goes straight back so the road keeps its surface either way.
      if (r && r.ok && c.then && !c.decor && c.then.block !== 'air') {
        const want = pickList(c.then).find(q => A.count(bot, q))
        if (want) { const p2 = await A.placeHard(bot, new Vec3(c.x, c.y, c.z), want, { stop: api.stop }).catch(() => ({ ok: false })); if (p2 && p2.ok) done++ }
        const back = at(c.x, c.y, c.z)
        if ((!back || !solid(back)) && c.decorBack !== false && r.block && A.count(bot, r.block)) await BL.placeBlock(bot, new Vec3(c.x, c.y, c.z), r.block, { retries: 0 }).catch(e_ => swallow('army_jobs:swapBack', e_))
      }
    } else if (c.block === 'water') {
      r = await waterCell(c)
      if (r && r.noWater) { // no bucket / no source: every water cell rests 5 min, the rest of the blueprint goes on; said once per rest
        st.lockSkip = st.lockSkip || {}; for (const k of waterKeys) st.lockSkip[k] = Date.now() + 300000
        st.missing = { item: 'water (' + r.noWater + ')', t: Date.now() }; A.result(bot, { ev: 'build_blocked', job: job.id, why: 'water cells wait: ' + r.noWater }); continue
      }
      if (!await A.travel(bot, { x: o.x, y: null, z: o.z }, { range: 30, ms: 120000, stop: api.stop, quiet: true })) return 'build: cannot get back'
    } else if (c.redo) {
      r = await redoChest(c)
    } else {
      let item = pickList(c).find(n => A.count(bot, n))
      // a SOLID fill cell never goes through obtain(): the biggest pile in the depot is withdrawn in one big load (see bestMat/fillBatch above), nothing is crafted
      if (!item && c.solid) {
        const pick = bestOfMats(matsOf(c))
        if (!pick) { A.result(bot, { ev: 'build_blocked', job: job.id, why: 'no filler in the depot (' + matsOf(c).slice(0, 4).join('/') + ' ...)' }); A.decline(bot, job, 180000, 'build: no filler in the depot'); return muster(bot, job, api, ctx, 'build: no filler') }
        task(bot, 'build: getting ' + pick); await A.withdraw(bot, pick, fillBatch(pick), { stop: api.stop }); task(bot, 'build ' + P.blueprint)
        if (!A.count(bot, pick)) { if (api.stop()) return 'build: interrupted while fetching ' + pick; A.result(bot, { ev: 'build_blocked', job: job.id, why: 'the depot index promised ' + pick + ' and the chests gave none' }); A.decline(bot, job, 180000, 'build: the chests gave no filler'); return muster(bot, job, api, ctx, 'build: no filler') }
        if (!await A.travel(bot, { x: o.x, y: null, z: o.z }, { range: 14, ms: 120000, stop: api.stop })) return 'build: cannot get back'
        item = pick; c = Object.assign({}, c, { block: pick })
      }
      if (!item) c = Object.assign({}, c, { block: pickList(c).find(n => A.stockOf(n) > 0) || (!exact(c) && craftPick(c)) || c.block }) // a solid fill takes whatever filler the depot has; wood = the species we own
      if (!item) { const open = put.filter(q => q.block === c.block).length; const bulk = /^(cobblestone|cobbled_deepslate|stone|dirt|gravel|sand|.*_planks|.*_log|.*_slab|.*_stairs|.*_fence|.*bricks?|glass)$/.test(c.block); const batch = c.solid ? 192 : bulk ? 64 : /torch/.test(c.block) ? 16 : Math.max(1, Math.min(open, 8)); // furniture by the piece (09-19: 3 builders crafted ~60 furnaces EACH for a 12-furnace bank)
        task(bot, 'build: getting ' + c.block); await A.obtain(bot, c.block, (bulk || c.solid) ? batch : feasibleN(bot, c.block, batch), { stop: api.stop }); for (const alt of pickList(c)) { if (A.count(bot, c.block) || api.stop()) break; if (alt !== c.block && A.stockOf(alt) > 0) { task(bot, 'build: getting ' + alt); await A.obtain(bot, alt, (bulk || c.solid) ? batch : feasibleN(bot, alt, batch), { stop: api.stop }); if (A.count(bot, alt)) c = Object.assign({}, c, { block: alt }) } } task(bot, 'build ' + P.blueprint); if (!A.count(bot, c.block) && api.stop()) return 'build: interrupted while fetching ' + c.block; if (!A.count(bot, c.block)) { const miss = c.block; A.result(bot, { ev: 'build_blocked', job: job.id, why: 'no ' + miss + ' carried or in stock' }); // A MISSING MATERIAL NEVER STOPS THE CELLS WHOSE MATERIAL EXISTS (w1 bug + main 09-19: base_depot `no torch` / base_hall `no cobblestone` handed every builder back): its cells rest
          // 5 min and the pass goes on; only when NOTHING else is left does the builder step aside - the job stays active and says what it needs in its note (`needs: …`)
          const c0 = put[0]; const same = q => q.block === c0.block
          st.miss = st.miss || {}; st.miss[miss] = Date.now()
          if (put.some(q => !same(q))) { st.lockSkip = st.lockSkip || {}; for (const q of put) if (same(q)) st.lockSkip[K(q)] = Date.now() + 300000; st.missing = { item: miss, t: Date.now() }; continue }
          needNote(miss, put.length)
          return muster(bot, job, api, ctx, 'build: no ' + miss) } if (!await A.travel(bot, { x: o.x, y: null, z: o.z }, { range: 14, ms: 120000, stop: api.stop })) return 'build: cannot get back'; item = c.block }
      r = /torch/.test(item) ? await BL.placeTorch(bot, new Vec3(c.x, c.y, c.z), {}).catch(e => ({ ok: false })) : (c.solid || c.deepFill) ? await fillCell(c, item) : (c.facing && c.half != null && /chest$/.test(item)) ? await placeChest(c, item) : (c.axis || c.facing) ? await placeOriented(c, item) : c.needs === 'water' ? await BL.placeBlock(bot, new Vec3(c.x, c.y, c.z), item, { retries: 1 }).catch(e => ({ ok: false, reason: String(e && e.message) })) : await A.placeHard(bot, new Vec3(c.x, c.y, c.z), item, Object.assign({ stop: api.stop }, c.fillOnly ? { fill: true, fillTop: c.g != null ? c.g : c.y } : {})) // a cap over water: plain placeBlock against its post - placeHard's "support" remedy builds INTO the water (world 1)
      // the torch that stood in this cell goes back on top of the finished block (unless the blueprint builds there)
      if (r && r.ok && st.retorch && st.retorch[K(c)]) { delete st.retorch[K(c)]; const up = cells.find(q => q.x === c.x && q.y === c.y + 1 && q.z === c.z); if ((!up || up.block === 'air') && A.count(bot, 'torch')) await BL.placeTorch(bot, new Vec3(c.x, c.y + 1, c.z), {}).catch(e_ => { swallow('army_jobs:retorch', e_) }) }
    }
    if (!(r && r.ok)) { const w = (c.block === 'air' ? 'dig:' : 'put:') + String(r && r.reason).slice(0, 24); fails[w] = (fails[w] || 0) + 1; fails.last = K(c) }
    if (r && r.ok) { done++; streak = 0 } else if (r && /locked/.test(String(r.reason))) { st.lockSkip = st.lockSkip || {}; st.lockSkip[K(c)] = Date.now() + 45000; lockSpins++; if (lockSpins > 8) break } else { if (!(c.roof || c.decor)) streak++; if (c.roof || c.decor) { st.lockSkip = st.lockSkip || {}; st.lockSkip[K(c)] = Date.now() + 180000 } else if (!c.solid) st.bad[K(c)] = (st.bad[K(c)] || 0) + 1 } // a cell another bot is working on: take the next one, it is not a failure (small sites: 3 of 4 bots burned passes on lock fights)
    // THE CUT FEEDS THE FILL (foreman 09-19 19:34Z: a level pad dug 32 cells, its dirt was banked/tossed down to 64, then 18 builders `build_blocked: no dirt`): a blueprint
    // with ground cells keeps 5 stacks of its fill block in the pockets; cobblestone per stoneKeep (never tossed while the army is short of it)
    if (U.freeSlots(bot) <= 1) await A.bank(bot, Object.assign({ torch: 16, [P.args && P.args.block || 'cobblestone']: 128 }, waterKeys.size ? { bucket: 3, water_bucket: 3, dirt: 64 } : {}, groundFill ? { [groundFill]: 320 } : {}, cells.some(q => q.solid) ? { cobbled_deepslate: 1024, cobblestone: 1024, gravel: 128, sand: 128 } : {}, { cobblestone: stoneKeep(cells.some(q => q.solid) ? 1024 : 128) }), { job: job.id, stop: api.stop })
  }
  // FURNITURE THAT STANDS IS REGISTERED BY THE BUILD JOB (contract) - judged on the world, every pass, idempotent (the depot works while it grows):
  //   containers with `cat` -> settings.chests[cat]. DOUBLE CHESTS: both halves open the SAME 54 slots, so a merged pair is booked ONCE - a chest whose
  //   state says left/right is registered only when it is the first half of its blueprint pair (`half` 0/undefined); a second half that merged is taken
  //   off the books again (it was single while its partner was missing). Whatever merged with whatever, every slot is reachable and none is counted twice.
  //   crafting_table -> settings.craftTable (first table wins) · beds (the foot cell) -> settings.respawnBeds · furnaces -> settings.furnaces (below).
  try {
    const stands = c => { const b = at(c.x, c.y, c.z); return b && (b.name === c.block || (c.mats && c.mats.includes(b.name))) ? b : null }
    const same = (q, c) => q[0] === c.x && q[1] === c.y && q[2] === c.z
    const reg = []; const unreg = []
    for (const c of cells) { if (!c.cat || !/^(barrel|chest|trapped_chest)$/.test(c.block)) continue; const b = stands(c); if (!b) continue; let type = 'single'; if (b.name !== 'barrel') { try { type = (b.getProperties() || {}).type || 'single' } catch (e_) { swallow('army_jobs:chestType', e_) } } if (type === 'single' || !c.half) reg.push(c); else unreg.push(c) }
    const table = cells.find(c => c.block === 'crafting_table' && stands(c)); const beds = cells.filter(c => /_bed$/.test(c.block) && stands(c))
    const S0 = A.settings(); const known = (S0.chests || {}); const bedsKnown = Array.isArray(S0.respawnBeds) ? S0.respawnBeds : []
    const need = reg.some(c => !(known[c.cat] || []).some(q => same(q, c))) || unreg.some(c => (known[c.cat] || []).some(q => same(q, c))) || (table && !S0.craftTable) || beds.some(c => !bedsKnown.some(q => same(q, c)))
    if (need) {
      const news = { chests: 0, beds: 0, table: null }
      A.boardEdit(b => {
        const S = b.settings = b.settings || {}; S.chests = S.chests || {}
        for (const c of reg) { const l = S.chests[c.cat] = S.chests[c.cat] || []; if (!l.some(q => same(q, c))) { l.push([c.x, c.y, c.z]); news.chests++ } }
        for (const c of unreg) { const l = S.chests[c.cat] || []; const i = l.findIndex(q => same(q, c)); if (i >= 0) l.splice(i, 1) }
        if (table && !S.craftTable) { S.craftTable = [table.x, table.y, table.z]; news.table = S.craftTable }
        if (beds.length) { S.respawnBeds = Array.isArray(S.respawnBeds) ? S.respawnBeds : []; for (const c of beds) if (!S.respawnBeds.some(q => same(q, c))) { S.respawnBeds.push([c.x, c.y, c.z]); news.beds++ } }
      })
      if (news.chests || news.beds || news.table) A.result(bot, Object.assign({ ev: 'furniture_registered', job: job.id }, news.chests ? { chests: news.chests } : {}, news.beds ? { beds: news.beds } : {}, news.table ? { craftTable: news.table } : {}))
    }
  } catch (e_) { swallow('army_jobs:furnitureReg', e_) }
  // "complete" is judged on ALL cells: cells this bot gave up on (2 failures) are NOT done (09-19: level_farm auto-paused as complete with
  // hundreds of cells open, because every remaining cell was on somebody's private bad list)
  try { // FURNACES that stand -> settings.furnaces (A.registerFurnaces; world 1: a 12-furnace bank nobody could see, because placing alone registered nothing)
    const fur = cells.filter(c => /^(furnace|smoker|blast_furnace)$/.test(c.block) && (bot.blockAt(new Vec3(c.x, c.y, c.z)) || {}).name === c.block)
    const knownF = A.furnaces(); const fresh = fur.filter(c => !knownF.some(q => q.x === c.x && q.y === c.y && q.z === c.z))
    if (fresh.length) { const n = A.registerFurnaces(fresh.map(c => [c.x, c.y, c.z])); if (n) A.result(bot, { ev: 'furnaces_registered', job: job.id, n }) }
  } catch (e_) { swallow('army_jobs:furnaceReg', e_) }
  // ONE closing walk, not two (same measurement: a fill's pass ended on `nMine === 0` and each end walked the whole 33 000-cell box TWICE - `left` and `mine` differ
  // only by this bot's own rest lists, which is a filter over the result, not a second reading of the world).
  const left = todo(true); const n = left.dig.length + left.put.length + left.wait
  const rested = c => (st.bad[K(c)] || 0) >= 2 || (st.lockSkip && st.lockSkip[K(c)] > Date.now()) || (c.solid && st.colSkip && st.colSkip[c.x + ',' + c.z] > Date.now())
  const nMine = left.dig.concat(left.put).filter(c => !rested(c)).length
  const isFill = cells.some(q => q.solid)
  // A DECK OVER AIR IS NOT "DONE" (09-19: the trench and the east yard were "decked" one block thick over 6-16 deep dark voids). Solid fills report the air
  // their flood could not reach (`sealed`); level pads (params.solidBelow: N layers, default 3 for blueprint `level`, false = off) report every
  // finished column with air right under its fill -> event `void_under_pad` + the job note, so the foreman plans an unlid + fill_void there.
  let voids = left.sealed.concat(left.deep) // deep = ground cells over a drop of 7+ (no lid was put over them)
  const nBelow = P.solidBelow === false ? 0 : (+P.solidBelow || (P.solidBelow || P.blueprint === 'level' ? 3 : 0))
  if (nBelow && !n && !isFill) {
    const cols = new Map(); for (const q of cells) if (q.fillOnly && q.block !== 'air') { const k = q.x + ',' + q.z; const e = cols.get(k); if (!e) cols.set(k, { x: q.x, z: q.z, lo: q.y, hi: q.y }); else { e.lo = Math.min(e.lo, q.y); e.hi = Math.max(e.hi, q.y) } }
    for (const e of cols.values()) { if (!solid(at(e.x, e.hi, e.z))) continue; for (let y = e.lo - 1; y >= e.lo - nBelow; y--) { const b = at(e.x, y, e.z); if (b && !solid(b) && !/^(water|lava)$/.test(b.name)) { voids.push(e.x + ',' + y + ',' + e.z); break } } }
  }
  // PINHOLES: a 1x1 cell that stayed open in a finished floor (a flower cell whose dig failed, then the rising floor closed over it) is SEALED, so the sky flood never
  // offers it again and the fill would report "complete" with holes in it. When nothing is left the world is read once more: every fill cell that is not solid and whose
  // four sides ARE solid at its level is a pinhole -> into the pass event, its column rest dropped (the next pass works it again) and the job STAYS ACTIVE.
  const pin = []
  if (isFill && !n) for (const q of cells) { if (!q.solid) continue; const pb = at(q.x, q.y, q.z); if (!pb || solid(pb)) continue; if (!SIDES.every(([dx, dz]) => solid(at(q.x + dx, q.y, q.z + dz)))) continue; pin.push(q.x + ',' + q.y + ',' + q.z); if (st.colSkip) delete st.colSkip[q.x + ',' + q.z]; if (pin.length >= 64) break }
  // NOTHING A FILL PLACED STAYS ABOVE GRADE (top model 11:20Z, block probe on fill_ravine_m/n: three unbroken lines of 35-40 cobbled_deepslate/tuff at y69 = grade+1,
  // x -328 / -324 / -318 over z -461..-420, two of them sitting directly on top of the two grade cells the job could not close - a fill blueprint has no `air` cells,
  // so whatever a ride-up, a climb-out or a pathfinder bridge left standing on the finished floor stayed there for ever and the base reads as rubble). With nothing
  // left, the builder sweeps the two layers over grade inside its OWN box once: a run of at most 2 blocks with open sky above it, made of this job's own filler
  // materials, in no blueprint of ours (A.ourBlock) and protected by nothing, is dug top-down. A pickaxe is fetched first (stone is never punched). Rock with more
  // rock above it is a hill for a `level` job, not our junk: it stays.
  // The sweep runs as soon as THIS builder has nothing it can do (`!nMine`), not only on a finished box: the two cells fill_ravine_n could never close (-328,68,-426 and
  // -318,68,-420) were unreachable BECAUSE one of those y69 blocks sat on top of them - waiting for "0 cells left" would have waited for ever.
  if (isFill && !nMine && bx && Number.isFinite(bx.x1)) {
    const matSet = new Set(matsOf(f0)); const strays = []
    for (let x = bx.x1; x <= bx.x2 && strays.length < 48; x++) for (let z = bx.z1; z <= bx.z2 && strays.length < 48; z++) {
      const run = []
      for (let y = fillG + 1; y <= fillG + 2; y++) { const q = at(x, y, z); if (!q || !solid(q)) break; run.push(q) }
      if (!run.length || solid(at(x, fillG + run.length + 1, z))) continue
      if (!run.every(q => matSet.has(q.name) && !U.protectedBlock(q) && !A.ourBlock(q.position, q.name))) continue
      for (let i = run.length - 1; i >= 0; i--) strays.push(run[i].position)
    }
    if (strays.length) {
      if (!A.bestOf(bot, 'pickaxe')) await getPick(bot, api)
      let cleared = 0
      for (const q of strays) { if (api.stop()) break; const r = await BL.digBlock(bot, q, { collect: true, requireHarvest: false, plug: false, own: job.id }).catch(e => ({ ok: false, reason: String(e && e.message) })); if (r && r.ok) cleared++ }
      A.result(bot, { ev: 'fill_flush', job: job.id, above: strays.length, cleared, first: [strays[0].x, strays[0].y, strays[0].z] })
      if (cleared) return 'build' // the box changed: the next pass reads it again and only then may call the fill finished
    }
  }
  const voidNote = voids.length ? ' - BUT ' + voids.length + (isFill ? ' air cells stay sealed under it' : ' columns are a deck over air') + ' (void_under_pad): ' + voids.slice(0, 6).join(' | ') : ''
  A.result(bot, Object.assign({ ev: 'build_pass', job: job.id, blueprint: P.blueprint, done, left: n, gaveUp: n - nMine }, isFill ? Object.assign({ dropped, waiting: left.wait, sealed: left.sealed.length }, pin.length ? { pinholes: pin.length } : {}) : {}, Object.keys(fails).length ? { fails } : {}))
  if (!n && voids.length) A.result(bot, { ev: 'void_under_pad', job: job.id, n: voids.length, cells: voids.slice(0, 8).join(' | ') })
  // A FILLED KEEP-OUT SAYS SO ONCE (nothing in the code reads it: the top model removes the zone from settings.keepOut on this event and the base becomes one piece):
  // every grade column of the box solid, no pinhole, nothing above grade.
  if (isFill && !n && !pin.length && bx && Number.isFinite(bx.x1) && !st.completeSaid) {
    let openCols = 0
    for (const k of new Set(cells.filter(q => q.solid && q.y === fillG).map(q => q.x + ',' + q.z))) { const [x, z] = k.split(',').map(Number); if (!solid(at(x, fillG, z))) openCols++ }
    const ko = (A.settings().keepOut || []).find(q => Array.isArray(q && q.box) && q.box.length === 4 && bx.x1 >= Math.min(q.box[0], q.box[2]) && bx.x2 <= Math.max(q.box[0], q.box[2]) && bx.z1 >= Math.min(q.box[1], q.box[3]) && bx.z2 <= Math.max(q.box[1], q.box[3]))
    if (ko && !openCols) { st.completeSaid = true; A.result(bot, { ev: 'fill_complete', job: job.id, box: [bx.x1, bx.z1, bx.x2, bx.z2], grade: fillG, keepOut: ko.id, note: 'flush, no pinhole, nothing above grade - the keep-out can go' }) }
  }
  // A PINHOLE IS CLOSED, AND A TAIL THAT CANNOT BE CLOSED ENDS (owner 14:0xZ 「12時間以上経過して未だに穴埋め終わって無い」). The sky flood never offers a 1x1 cell whose four
  // sides are already solid, so the old branch only REPORTED them and declined for 3 min - fill_ravine_n has been cycling its 64 pinholes like that for an hour while
  // the board called it active. Now the builder works them itself: the cell over the hole is opened when our own filler caps it, a gravity block is dropped down the
  // shaft, else the block is placed from the rim; three rounds (st.pinRound) and whatever is still open is counted as DONE with `fill_pinholes {gaveUp}` - a fill may
  // not hold a squad for ever over cells nobody can reach.
  if (isFill && !n && pin.length) {
    st.pinRound = (st.pinRound || 0) + 1
    let closed = 0
    const item0 = matsOf(f0).find(q => A.count(bot, q)) || (await restock(), matsOf(f0).find(q => A.count(bot, q)))
    if (item0) for (const k of pin.slice(0, 24)) {
      if (api.stop()) break
      const [px, py, pz] = k.split(',').map(Number)
      const up = at(px, py + 1, pz)
      if (up && solid(up) && !U.protectedBlock(up) && !A.ourBlock(up.position, up.name)) { const d = await BL.digBlock(bot, new Vec3(px, py + 1, pz), { collect: true, requireHarvest: false, plug: false, own: job.id }).catch(() => ({ ok: false })); if (!d.ok) continue }
      const r0 = await fillCell({ x: px, y: py, z: pz, g: fillG, solid: true, block: item0 }, item0).catch(() => ({ ok: false }))
      if (r0 && r0.ok) { closed++; done++ }
    }
    const openLeft = pin.filter(k => { const [px, py, pz] = k.split(',').map(Number); return !solid(at(px, py, pz)) }).length
    A.result(bot, { ev: 'fill_pinholes', job: job.id, n: pin.length, closed, left: openLeft, round: st.pinRound, cells: pin.slice(0, 4).join(' | ') })
    if (openLeft && st.pinRound < 3) { A.decline(bot, job, 120000, 'build: ' + openLeft + ' pinholes left in the floor'); return muster(bot, job, api, ctx, 'build: ' + openLeft + ' pinholes left in the floor') }
    if (openLeft) A.result(bot, { ev: 'fill_pinholes', job: job.id, left: openLeft, gaveUp: true, note: 'three rounds could not close them (sealed rock pockets): counted as done, the fill is finished' })
  }
  // A TAIL DOES NOT HOLD A SQUAD (gemba 11:19Z: 25 builders on fill_ravine_m, 153 cells left, 1.0 cells/min/bot, 6 of them standing still; 31 bots cycled through the
  // LAST 2 cells of fill_ravine_n). What is open NOW = the cells left minus the ones that only wait for their support, their mate or their material - a fill's last
  // columns are reached by two or three builders at once, never by twenty. Under 8 open cells per builder, everyone above rank ceil(open/8) in the crew hands itself
  // back for 10 min (the dispatcher spends them elsewhere) and the low ranks stay and finish it. No mass decline, no spinning: at least one builder always stays.
  if (n) {
    const openNow = Math.max(0, n - left.wait); const crew = crewOf(job, bot.username); const keep = Math.max(1, Math.ceil(openNow / 8))
    if (crew.n > keep && crew.rank >= keep) {
      const why = 'build: tail, ' + openNow + ' cells for ' + crew.n + ' builders'
      A.result(bot, { ev: 'build_tail', job: job.id, left: n, open: openNow, crew: crew.n, keep })
      A.decline(bot, job, 600000, why); return muster(bot, job, api, ctx, why)
    }
  }
  if (!done && n) await sleep(4000) // a pass that did nothing must not spin (seen: 2 passes/s)
  // ...and a bot whose passes KEEP doing nothing without even a recorded failure hands itself back for 10 min (world 2, 09-19 21:4xZ: base_mine,
  // 5 cells left, 26 bots cycled through it - `build_pass done:0` x8615 in an hour, 4 of them reported `hung` for standing still)
  st.idlePass = done || Object.keys(fails).length ? 0 : (st.idlePass || 0) + 1
  if (st.idlePass >= 3 && n) { st.idlePass = 0; A.result(bot, { ev: 'build_idle', job: job.id, left: n, cells: left.dig.concat(left.put).slice(0, 5).map(K).join(' | ') }); A.decline(bot, job, 600000, 'build: 3 passes in a row did nothing (' + n + ' cells left)'); return muster(bot, job, api, ctx, 'build: nothing I can do on the last ' + n + ' cells') }
  if (isFill && n && !nMine && done) return 'build' // every open column rests for 3 min, but this pass placed blocks: not stuck
  // everything that is left waits for a water cell ANOTHER builder is pouring right now (its cap, its torch): that is progress, not "stuck"
  if (waterKeys.size && n && !nMine && !left.dig.concat(left.put).some(c => !(c.block === 'water' && waterClaimed(c)))) return muster(bot, job, api, ctx, 'build: the rest waits for a water cell in work')
  if (n && !nMine && st.missing && Date.now() - st.missing.t < 300000) needNote(st.missing.item, n)
  if (n && !nMine && st.missing && Date.now() - st.missing.t < 300000) return muster(bot, job, api, ctx, 'build: waiting for ' + st.missing.item) // only furniture nobody has (a gate, a bed) is left: not "stuck"
  if (n && !nMine) { // three different bots failed on everything that is left -> stop cycling the army through it: pause with the cell list for the foreman
    // the tally lives ON THE BOARD (the 30 bots run in 10 processes: a per-process Set never reached 3 and cap_stair_e spun at 2 passes/s)
    // A HANDFUL OF TERRAIN CELLS MUST NOT STALL THE BUILD ORDER (main 09-19: base_core_pad, 1500 cells, paused as "1 cells nobody could do: -346,68,-492" and its
    // whole `after` chain stood still): when what is left is terrain work only (cut / ground fill - never a wall, furniture or water cell) and <= 0.5 % of the
    // blueprint (min 2), three failed builders = COMPLETE WITH LEFTOVERS: the dispatcher's note prefix is kept, the cells go into the note + event `build_leftover`.
    const leftCells = left.dig.concat(left.put); const cellsLeft = leftCells.slice(0, 6).map(K).join(' | '); let paused = false; let leftover = false
    const minor = !left.wait && leftCells.length <= Math.max(2, Math.floor(cells.length / 200)) && leftCells.every(q => (q.block === 'air' && !q.then) || q.fillOnly || q.unlid) && !layered
    A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (!j || j.status !== 'active') return; const key = 'rev' + (j.rev || 0); if (!j.stuckBy || j.stuckBy.key !== key) j.stuckBy = { key, bots: [] }; if (!j.stuckBy.bots.includes(bot.username)) j.stuckBy.bots.push(bot.username); if (j.stuckBy.bots.length >= 3) { j.status = 'paused'; j.note = minor ? 'auto-paused: build complete - BUT ' + n + ' cells are left that 3 builders could not do (build_leftover): ' + cellsLeft : 'auto-paused: ' + n + ' cells nobody could do: ' + cellsLeft; paused = true; leftover = minor } })
    if (paused && leftover) { A.result(bot, { ev: 'build_leftover', job: job.id, left: n, cells: cellsLeft }); A.result(bot, { ev: 'build_done', job: job.id, blueprint: P.blueprint, leftover: n }); putCap(); return muster(bot, job, api, ctx, 'build: complete') }
    if (paused) A.result(bot, { ev: 'build_stuck', job: job.id, left: n, cells: cellsLeft })
  }
  if (n && !nMine) { A.askHelp(bot, 'build_stuck', n + ' cells of ' + job.id + ' left but I failed twice on each (first: ' + (left.dig[0] || left.put[0] ? K(left.dig[0] || left.put[0]) : 'none listed - only waiting cells') + ')'); A.decline(bot, job, isFill ? 200000 : 600000, 'build: every remaining cell failed twice for me'); return 'build: stuck' }
  // A FINISHED FILL IS GROUND, NOT RUBBLE (owner 11:2xZ "明らかに地形が悪い"; base-audit picture 11:20Z: the filled ravine is a bare grey slab and the cut hills in the
  // north are bare stone - a base is grass or paving, not rubble). A terrain job that is DONE puts ONE low-priority `cap_<id>` over its own footprint, the same way a
  // pad puts its `void_fix_`: blueprint `level` in CAP mode lays DIRT on the grade layer wherever bare stone, gravel or air stands (grass spreads by itself), and the
  // cell's `only` list plus the handler's `foreign` rule keep it off paving, fields, crops and every cell of another blueprint. `needStock` holds it to the SURPLUS
  // over settings.targets.dirt, so the cap can never eat the farms' reserve. Once per job (j.cap), pushed inside the locked edit = never twice.
  function putCap () { // a DECLARATION, hoisted: the leftover path above calls it (12:4xZ: `Cannot access 'putCap' before initialization`, Himari)
    try {
      if (!/^(fill_void|level)$/.test(String(P.blueprint)) || P.cap || (P.args || {}).cap) return
      const tgt = 128; if (A.stockOf('dirt') <= tgt + 64) return
      let x1 = Infinity; let z1 = Infinity; let x2 = -Infinity; let z2 = -Infinity
      for (const c of cells) { if (c.x < x1) x1 = c.x; if (c.x > x2) x2 = c.x; if (c.z < z1) z1 = c.z; if (c.z > z2) z2 = c.z }
      if (!Number.isFinite(x1)) return
      let w = x2 - x1 + 1; let d = z2 - z1 + 1; if (w % 2 === 0) w++; if (d % 2 === 0) d++ // `level` is centred: an even side would drop a row (one row of ground more is no harm)
      const cx = x1 + (w - 1) / 2; const cz = z1 + (d - 1) / 2; const cols = w * d
      const capId = 'cap_' + job.id; let armed = false
      A.boardEdit(b => {
        const j = (b.jobs || []).find(q => q.id === job.id); if (!j || j.cap) return
        if (!(b.jobs || []).some(q => q.id === capId)) {
          // ORDER OF CAPS = WHAT THE OWNER SEES FIRST (owner 12:1xZ): the filled ravine in the middle of the base before the yard before the outer tiles - the
          // distance of the cap's centre from settings.base decides its priority (45 within 40 blocks, 38 within 90, else 30).
          const bs = A.settings().base || {}; const dBase = Number.isFinite(bs.x) ? Math.hypot(cx - bs.x, cz - bs.z) : 999
          b.jobs.push({ id: capId, type: 'build', priority: dBase <= 40 ? 45 : dBase <= 90 ? 38 : 30, front: job.front || 'base', status: 'active', when: 'any', bots: Math.max(2, Math.min(8, Math.round(cols / 300))), site: [cx, o.y + 1, cz],
            plan: 'the finished ' + P.blueprint + ' of ' + job.id + ' is bare stone: cap the grade layer y' + o.y + ' of x ' + x1 + '..' + (x1 + w - 1) + ' / z ' + z1 + '..' + (z1 + d - 1) + ' with DIRT (grass spreads by itself). Only where bare stone, gravel or air stands - never paving, a field, a crop or another blueprint of ours - and only out of the dirt SURPLUS over targets.dirt ' + tgt,
            params: { blueprint: 'level', origin: [cx, o.y, cz], args: { w, d, cap: true, fill: 'dirt' }, needStock: { dirt: 128 } /* a small floor, NOT settings.targets.dirt: the target is what the army wants to OWN (20 000 on 09-20) - a cap that waits for it never starts */, order: 'near' } })
        }
        j.cap = { id: capId, cols, t: Date.now() }; armed = true
      })
      if (armed) A.result(bot, { ev: 'fill_cap', job: job.id, cap: capId, cols, grade: o.y, dirt: A.stockOf('dirt') })
    } catch (e_) { swallow('army_jobs:putCap', e_) }
  }
  // params.standing:true = a STANDING REPAIR ORDER (a perimeter wall creepers keep opening): complete -> the job stays active, the bot steps aside for 10 min and looks again
  if (!n && P.standing) { if (!st.doneSaid) { st.doneSaid = true; A.result(bot, { ev: 'build_done', job: job.id, blueprint: P.blueprint, standing: true }) } A.decline(bot, job, 600000, 'build: complete (standing repair order)'); return muster(bot, job, api, ctx, 'build: complete') }
  if (n) st.doneSaid = false
  // A PAD THAT ENDS OVER VOIDS PUTS ITS OWN REMEDY ON THE BOARD (foreman 09-20 10:20Z: base_infill_n278_n401 reported `build_done` + "12 columns are a deck over air" and then
  // sat paused for ever - re-activating it, the audit's printed remedy, is a NO-OP: it re-declares complete in one pass and the crater stays; n247_n401 the same with 35
  // columns). Doctrine: never deck a hole, fill it. So the job itself puts ONE `fill_void` over the bounding box of the void columns (id derived from its own id, pushed
  // inside the LOCKED edit = never twice however many builders finish the same pass; `unlid` takes the thin deck off so every column is filled from its floor; no `top`,
  // so any stone of `mats` is accepted at grade - dirt is the army's bottleneck and the pad's own ground cells accept every solid block) and goes `after` it WITHOUT a
  // note: the dispatcher activates a successor only while it is paused with no note, so the pad comes back by itself when the fill is done and re-checks the very same
  // columns. TWO rounds at most (j.voidFix.n) - then the plain note stays for the foreman. The pad's own successors wait for that re-check: nothing is built on a deck.
  if (!n && voids.length && !isFill && !P.standing) {
    const pts = voids.map(s2 => String(s2).split(',').map(Number)).filter(q => q.length === 3 && q.every(Number.isFinite))
    const fixId = 'void_fix_' + job.id; let armed = 0
    if (pts.length) {
      const vbox = [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[2])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[2]))]
      const lo = Math.min(...pts.map(q => q[1])); const vdepth = Math.max(3, Math.min(16, o.y - lo + 2))
      const vsite = [Math.round((vbox[0] + vbox[2]) / 2), o.y, Math.round((vbox[1] + vbox[3]) / 2)]
      // `unlid` is MEASURED, not guessed (10:40Z first live round: the fix job declared complete in one pass with `sealed:12`, because unlid:true = 2 and the 12 void columns
      // of n278_n401 sit under 3 solid blocks - a buried oak crown, y66/67 leaves + the pad's grass cap at y68). The deck over the deepest void decides, capped at 4: thicker
      // than that is rock, not a deck, and is left to the foreman.
      const vlid = Math.max(2, Math.min(4, pts.reduce((m, q) => { let k = 0; for (let y = q[1] + 1; y <= o.y && k < 6; y++) { if (!solid(at(q[0], y, q[2]))) break; k++ } return Math.max(m, k) }, 0)))
      const vparams = { blueprint: 'fill_void', origin: vsite, unlid: vlid, args: { box: vbox, depth: vdepth, fill: 'cobblestone', mats: ['cobbled_deepslate', 'cobblestone', 'stone', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'dirt', 'gravel'] } }
      A.boardEdit(b => {
        const j = (b.jobs || []).find(q => q.id === job.id); if (!j || j.status !== 'active') return
        const round = ((j.voidFix || {}).n || 0) + 1; if (round > 2) return
        const ex = (b.jobs || []).find(q => q.id === fixId)
        if (!ex) b.jobs.push(Object.assign({ id: fixId, type: 'build', priority: job.priority || 70, front: job.front || 'works', status: 'active', when: 'any', bots: Math.max(2, Math.min(6, Math.ceil(pts.length / 6))), site: vsite }, job.requires ? { requires: job.requires } : {}, { plan: 'void under the finished pad ' + job.id + ': ' + pts.length + ' columns of x ' + vbox[0] + '..' + vbox[2] + ' / z ' + vbox[1] + '..' + vbox[3] + ' are a deck over air (void_under_pad) - fill SOLID from the natural ground up to grade y' + o.y + ', never deck a hole; ' + job.id + ' is `after` this job and re-checks the columns when it is done', params: vparams }))
        else if (ex.status !== 'active') { ex.status = 'active'; ex.rev = (ex.rev || 0) + 1; ex.params = vparams; ex.site = vsite; delete ex.stuckBy; delete ex.note }
        j.status = 'paused'; j.after = fixId; j.voidFix = { n: round, id: fixId, cols: pts.length, t: Date.now() }; delete j.note; delete j.stuckBy; armed = round
      })
    }
    if (armed) { A.result(bot, { ev: 'void_fix', job: job.id, fill: fixId, cols: pts.length, round: armed, cells: voids.slice(0, 4).join(' | ') }); A.result(bot, { ev: 'build_done', job: job.id, blueprint: P.blueprint, voids: pts.length, fix: fixId }); return muster(bot, job, api, ctx, 'build: complete - ' + pts.length + ' void columns handed to ' + fixId) }
  }
  // the void fix worked (or its job was pruned after its own done report): the pad drops the `after` link again - a dangling `after` makes the CLI refuse every patch of this job
  // A TERRAIN JOB NEVER SAYS "COMPLETE" WITHOUT SHOWING THE CAMERA'S OWN LIST FOR ITS BOX (foreman 12:3xZ + docs/BUGS.md 12:2xZ: base_infill_n232_n400 and
  // base_infill_n252_n558 declared complete in one pass while the base audit named them as the worst hole / bump clusters, so the dispatcher kept walking bots there -
  // `travel_fail x57/30 min`). MEASURED ON THE SPOT before this was written: an eval probe on Yotsuba @-262,69,-558 read groundTop **y68** for -243,-556 / -244,-556 /
  // -243,-555 / -242,-556 / -245,-557, and `ops/skyshot.js -243 -550 20` - the SAME spectator camera the audit flies - reads 68 for the whole tile while the +13 bump
  // stands at x -263..-255, twelve to twenty blocks WEST of the tile's own box (x -252..-232). base_infill_n232_n400 likewise: 68 along the whole 1-wide strip x -232,
  // the 4-deep holes at x -228 and east. Both jobs really are finished; the audit names the NEAREST job for a cluster that lies OUTSIDE its footprint. So the handler
  // proves it rather than arguing: at completion it re-reads the audit's work list, keeps the columns INSIDE its own box, and reports `level_skipped` for each one it
  // did not turn into work (max 5) - or once with `none:true`, which is the evidence an operator needs to stop re-opening the job and to put the tile where the ground is.
  if (!n && !st.lvlSaid && A.TERRAIN_BP.test(String(P.blueprint))) {
    st.lvlSaid = true
    try {
      let x1 = Infinity; let z1 = Infinity; let x2 = -Infinity; let z2 = -Infinity
      for (const c of cells) { if (c.x < x1) x1 = c.x; if (c.x > x2) x2 = c.x; if (c.z < z1) z1 = c.z; if (c.z > z2) z2 = c.z }
      const a = auditWork(); const inBox = []
      if (a && Number.isFinite(x1)) for (const u of a.work || []) for (const q of u.cols || []) if (q[0] >= x1 && q[0] <= x2 && q[1] >= z1 && q[1] <= z2) inBox.push(q)
      if (a && !inBox.length) A.result(bot, { ev: 'level_skipped', job: job.id, none: true, box: [x1, z1, x2, z2], why: 'complete, and the camera lists NO off-level column inside this box - a cluster the audit blames on this job lies OUTSIDE its footprint (put a tile where the ground is, do not re-open this one)' })
      for (const q of inBox.slice(0, 5)) {
        const mineCells = cells.filter(c => c.x === q[0] && c.z === q[1])
        const gb = at(q[0], o.y, q[1])
        const why = !mineCells.length ? 'no cell of this blueprint stands in that column'
          : !gb ? 'blockAt is null there: the chunk is not loaded for me (I judged it unseen)'
            : mineCells.some(c => c.block !== 'air' && !solid(at(c.x, c.y, c.z))) ? 'a ground cell is open but rested (bad/lock/colSkip) - re-run with a new rev'
              : U.protectedBlock(gb) || A.ourBlock(gb.position, gb.name) ? 'the block at grade belongs to another blueprint of ours (' + gb.name + ')'
                : 'the world reads ' + gb.name + ' at grade y' + o.y + ' - the camera and I disagree about this column'
        A.result(bot, { ev: 'level_skipped', job: job.id, col: [q[0], q[1]], d: q[2], why })
      }
    } catch (e_) { swallow('army_jobs:levelSkipped', e_) }
  }
  if (!n) { A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: build complete' + voidNote; if (j.voidFix) { const gone = !(b.jobs || []).some(q => q.id === j.voidFix.id); if (!voids.length || gone) { if (j.after === j.voidFix.id) delete j.after; if (!voids.length) delete j.voidFix } } } }); A.result(bot, { ev: 'build_done', job: job.id, blueprint: P.blueprint }); putCap(); return muster(bot, job, api, ctx, 'build: complete') }
  return 'build'
}

// ------------------------------------------------------------------ tidy: GROUNDSKEEPING at scale (owner: floating junk blocks, lone 1-block pillars, 1x1 holes everywhere).
// Any number of bots; the box is cut into 16x16 tiles, each bot takes the nearest tile nobody tidied in the last 30 min (tidy_state.json).
// Per tile it reads every column and repairs what a careful player would never leave behind:
//   pillar : a 1x1 column of junk (dirt/cobble/planks/netherrack…) >= 2 above all four neighbours      -> dug top-down to their level
//   hole   : a 1x1 pit >= 2 below all four neighbours                                                   -> filled (cobble below, DIRT on top: grass regrows)
//   float  : a junk block with 2+ air under it and no tree/structure touching it                        -> dug (scaffold up if out of reach, scaffold removed)
// Dirt is valuable: everything dug is collected and banked. Never touched: protected blocks (chests, torches, beds, farmland, water…),
// and every area that belongs to a job on the board (farm boxes, berry hedge, build/deck footprints, mine stairs) + params.exclude boxes.
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
const JUNK_RE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack|.*_planks|andesite|diorite|granite|gravel|stone|deepslate|tuff)$/
function tidyExcludes (P) {
  const boxes = (P.exclude || []).map(b => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])])
  const cols = new Set(); boxes.cols = cols
  const board = A.readJSON(A.F.board, {}) || {}
  for (const j of board.jobs || []) {
    const q = j.params || {}
    if (j.type === 'farm' && q.box) boxes.push([Math.min(q.box[0], q.box[2]) - 1, Math.min(q.box[1], q.box[3]) - 1, Math.max(q.box[0], q.box[2]) + 1, Math.max(q.box[1], q.box[3]) + 1])
    if (j.type === 'berries' && q.plantBox) boxes.push([Math.min(q.plantBox[0], q.plantBox[2]) - 1, Math.min(q.plantBox[1], q.plantBox[3]) - 1, Math.max(q.plantBox[0], q.plantBox[2]) + 1, Math.max(q.plantBox[1], q.plantBox[3]) + 1])
  }
  // only the columns a STRUCTURE of ours really builds on (a wall ring does not protect the yard inside it) - from the ONE registry (board + archive, lib/army.js ours()).
  // 09-20: the old rule took every non-air cell of the build jobs ON THE BOARD: a level pad excluded its whole zone while it was on the board (the pit by the depot road
  // that tidy "never saw"), and the hall, depot, dorm and pens lost their protection the moment `prune` archived their jobs.
  try { for (const k of A.ours().cells.keys()) { const i = k.indexOf(','); const j2 = k.lastIndexOf(','); cols.add(k.slice(0, i) + ',' + k.slice(j2 + 1)) } } catch (e_) { swallow('army_jobs:tidyExcl', e_) }
  boxes.soft = boxes.length // boxes from here on keep the ground rules out (mine mouth, depot chests) but not the stray rule
  try { for (const st of (A.readJSON(require('path').join(A.DIR, '..', 'iron_mine.json'), {}).steps || [])) if (st[1] > A.SEA_LEVEL - 3) boxes.push([st[0] - 2, st[2] - 2, st[0] + 2, st[2] + 2]) } catch (e_) { swallow('army_jobs:tidyMine', e_) }
  for (const l of Object.values(A.settings().chests || {})) for (const c of l) boxes.push([c[0] - 1, c[2] - 1, c[0] + 1, c[2] + 1])
  return boxes
}
// ---- THE BASE AUDIT IS THE SPONGE'S WORK LIST (foreman 09-20 07:20Z: `declined x39 "tidy: every tile was tidied in the last 30 min"` by 34 of 50 bots in the minute the camera
// measured 470 columns off the base level: tidy worked from its own memo of what it had VISITED, the audit from what the WORLD looks like, and the two never talked).
// ops/base-audit.js writes `work` (every judged off-level column, grouped by sign and 8x8 tile, `area:1` = land nobody levelled yet) and `strays` into base_audit.json.
// A tidy bot takes the nearest unit nobody holds - the claim is a blocks.js file lock on a pseudo cell (x>>3, -9000 - kind, z>>3), 12 min, renewed while it works, kept
// until the next audit once the unit is finished or hopeless (no new state file, 50 bots in 17 processes spread over 50 units) - walks there, RE-MEASURES every column in the
// world and repairs it with the rules of `level` / the stray rule: holes (<= 6 deep, dry) filled from the natural ground up (dirt on top), bumps (<= 6 high, natural ground
// or junk, never a trunk, nothing standing on it) cut top-down, strays dug and banked; never inside keep-outs / farm boxes / pens / the mine stairwell / the box of an ACTIVE
// terrain build, never a column a blueprint of ours builds on, never a protected block. `tidy_fix {kind, at, n}` counts columns VERIFIED at the level afterwards.
let _auditWork = { m: 0, v: null }
function auditWork () {
  const f = require('path').join(A.DIR, 'base_audit.json')
  try { const m = require('fs').statSync(f).mtimeMs; if (m !== _auditWork.m) _auditWork = { m, v: A.readJSON(f, null) } } catch (e_) { return null }
  const a = _auditWork.v; return a && a.t && Date.now() - a.t < 45 * 60000 && Array.isArray(a.work) ? a : null
}
let _terrainBoxes = { t: 0, v: [] }
function activeTerrainBoxes () { // boxes of terrain builds (level / fill_void / clear_area / quarry) that are ACTIVE on the board: their own squad is on that ground
  if (Date.now() - _terrainBoxes.t < 60000) return _terrainBoxes.v
  const v = []
  for (const j of (A.readJSON(A.F.board, {}) || {}).jobs || []) {
    if (j.type !== 'build' || j.status !== 'active' || !j.params || !A.TERRAIN_BP.test(String(j.params.blueprint)) || !Array.isArray(j.params.origin)) continue
    try { let bx = [Infinity, Infinity, -Infinity, -Infinity]; for (const c of blueprintCellsOf(j.params)) { if (c.x < bx[0]) bx[0] = c.x; if (c.z < bx[1]) bx[1] = c.z; if (c.x > bx[2]) bx[2] = c.x; if (c.z > bx[3]) bx[3] = c.z } if (bx[0] !== Infinity) v.push(bx) } catch (e_) { swallow('army_jobs:terrainBox', e_) }
  }
  _terrainBoxes = { t: Date.now(), v }
  return v
}
const TIDY_GROUND_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|stone|granite|diorite|andesite|tuff|calcite|deepslate|gravel|sand|red_sand|sandstone|moss_block|snow_block|cobblestone|cobbled_deepslate|netherrack|[a-z_]+_planks)$/
// A FLOATING CROWN / LOG STUMP IS TAKEN DOWN LIKE A PLAYER DOES IT: logs first (their leaves then decay by themselves), nearest first, from the ground while the arm reaches;
// higher up from a temporary 1-wide pillar of the bot's own filler (params.pillarMax, default 6, a LOG 10; blocks.js scaffold ledger -> removeScaffold takes it down again at once),
// never pillared on farmland / crops / water / in a pen (a jump tramples the soil): the pillar stands on the nearest plain ground within 2 of the column. What stays out of
// reach is said (`skip.high`). n = columns VERIFIED free of leaf/log afterwards.
async function tidyFloat (bot, job, api, unit) {
  const BL = lib('blocks'); const P = job.params || {}; const maxUp = P.pillarMax == null ? 6 : +P.pillarMax
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z)); const isTree = b => !!b && /_log$|_wood$|_leaves$/.test(b.name); const isLog = b => !!b && /_log$|_wood$/.test(b.name)
  const bad = new Set(); const K3 = p => p.x + ',' + p.y + ',' + p.z; const skip = {}; let blocks = 0; let failed = 0; let firstFail = null; const t0 = Date.now(); let pillars = 0
  const targets = () => { const out = []; for (const [x, z, lo, hi] of unit.cols) for (let y = hi + 2; y >= lo - 2; y--) { const b = at(x, y, z); if (isTree(b) && !bad.has(K3(b.position)) && !A.ourBlock(b.position, b.name)) out.push(b) } return out }
  const dig = async (b, o) => { const r = await BL.digBlock(bot, b.position, Object.assign({ collect: true, requireHarvest: false, plug: false, clearThrough: /_leaves$/ }, o || {})).catch(e => ({ ok: false, reason: String(e && e.message) })); if (r && r.ok) blocks++; return r }
  const plain = (x, z) => { const fy = Math.floor(bot.entity.position.y); for (let y = fy + 3; y >= fy - 4; y--) { const c = new Vec3(x, y, z); if (!BL.standable(bot, c)) continue; const u = at(x, y - 1, z); const h = at(x, y, z); if (!u || /farmland|water|_leaves$/.test(u.name) || (h && h.name !== 'air' && !BL.isReplaceable(h)) || (h && /wheat|carrots|potatoes|beetroots|sapling|sugar_cane/.test(h.name)) || A.penAt(x, y, z) || A.ourBlock(u.position, u.name) && /chest|furnace|bed/.test(u.name)) return null; return c } return null }
  while (!api.stop() && Date.now() - t0 < 8 * 60000 && failed < 10) {
    const T = targets(); if (!T.length) break
    const me = bot.entity.position; const logs = T.filter(isLog); const pick = (logs.length ? logs : T).sort((p, q) => p.position.distanceTo(me) - q.position.distanceTo(me))[0]
    const feetY = Math.floor(me.y + 0.01); const p = pick.position
    if (p.y - feetY <= 4) { const r = await dig(pick); if (!(r && r.ok)) { bad.add(K3(p)); failed++; if (!firstFail) firstFail = K3(p) + ': ' + String(r && r.reason).slice(0, 30) } continue }
    // from a pillar: the nearest plain ground within 2 of the column
    let base = null; for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]) { base = plain(p.x + dx, p.z + dz); if (base) break }
    const need = base ? p.y - base.y - 3 : 99; const cap = isLog(pick) ? Math.max(maxUp, 10) : maxUp // ONE hanging log keeps a hundred leaves alive (field 3, 07:58Z: log at y80 over soil y68, 100 leaves above it): for a LOG the pillar may be 10
    if (!base || need > cap || ['cobblestone', 'dirt', 'cobbled_deepslate'].reduce((n, q) => n + A.count(bot, q), 0) < need) { for (const b of T) if (b.position.x === p.x && b.position.z === p.z && b.position.y >= p.y) bad.add(K3(b.position)); { const w = !base ? 'no plain ground under it' : need > cap ? 'high' : 'no filler'; skip[w] = (skip[w] || 0) + 1 } continue }
    if (!await A.travel(bot, base, { range: 0, ms: 30000, stop: api.stop, quiet: true })) { bad.add(K3(p)); failed++; if (!firstFail) firstFail = K3(p) + ': cannot stand under it'; continue }
    await BL.centreOn(bot, base).catch(e_ => swallow('army_jobs:floatCentre', e_))
    const up = await BL.pillarUp(bot, Math.max(1, need), {}).catch(e_ => { swallow('army_jobs:floatUp', e_); return 0 }); pillars++
    let got = 0
    for (let k = 0; k < 40 && !api.stop(); k++) { // everything the arm reaches from up here, logs first, without taking a step
      const eye = bot.entity.position.offset(0, 1.62, 0); const near = targets().filter(b => b.position.offset(0.5, 0.5, 0.5).distanceTo(eye) <= 4.6).sort((p2, q2) => (isLog(q2) - isLog(p2)) || (p2.position.distanceTo(eye) - q2.position.distanceTo(eye)))
      if (!near.length) break
      const r = await dig(near[0], { noMove: true, collect: false }); if (r && r.ok) got++; else bad.add(K3(near[0].position))
    }
    await BL.removeScaffold(bot).catch(e_ => swallow('army_jobs:floatDown', e_))
    if (!got && !up) { bad.add(K3(p)); failed++; if (!firstFail) firstFail = K3(p) + ': pillar 0/' + need }
    if (U.freeSlots(bot) <= 2) await A.bank(bot, { torch: 16, dirt: 64, cobblestone: 64 }, { job: job.id, stop: api.stop })
  }
  await A.pickup(bot, 6, 3000).catch(e_ => swallow('army_jobs:floatPickup', e_))
  const leftCols = unit.cols.filter(([x, z, lo, hi]) => { for (let y = hi + 2; y >= lo - 2; y--) if (isTree(at(x, y, z))) return true; return false }).length
  const open = targets().length
  A.result(bot, Object.assign({ ev: 'tidy_fix', job: job.id, kind: 'float', at: [unit.x, unit.z], n: unit.cols.length - leftCols, of: unit.cols.length, blocks, pillars }, leftCols ? { left: leftCols } : {}, Object.keys(skip).length ? { skip } : {}, failed ? { failed, firstFail } : {}))
  return { closed: !open, fixed: unit.cols.length - leftCols }
}
async function tidyAudit (bot, job, api, ctx, env) {
  const BL = lib('blocks'); const P = job.params || {}; const a = auditWork(); if (!a) return null
  const { excluded, hardExcluded, box } = env; const me = bot.entity.position
  const _tidyClosed = bot.__tidyClosed = bot.__tidyClosed || new Map() // unit key -> audit t it was closed for (on the bot: survives a hot reload; the kept lock tells the other bots)
  for (const [k, t] of _tidyClosed) if (t !== a.t) _tidyClosed.delete(k)
  const keepOut = (A.settings().keepOut || []).map(k => k && k.box).filter(q => Array.isArray(q) && q.length === 4).map(q => [Math.min(q[0], q[2]), Math.min(q[1], q[3]), Math.max(q[0], q[2]), Math.max(q[1], q[3])])
  const busy = activeTerrainBoxes(); const inB = (b, x, z) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]
  const units = []; const stairs0 = stairCols()
  // what the books already rule out is dropped BEFORE anybody walks (first live pass 07:33Z: Ume walked to a 1-column unit that was an excluded column)
  const ruledOut = (x, z) => excluded(x, z) || hardExcluded(x, z) || keepOut.some(q => inB(q, x, z)) || busy.some(q => inB(q, x, z)) || stairs0.has(x + ',' + z) || !!A.penAt(x, 1e9, z)
  for (const u0 of a.work) { if (!u0 || !Array.isArray(u0.cols)) continue; const cols = u0.cols.filter(c => Math.abs(c[2]) <= 6 && !ruledOut(c[0], c[1])); if (!cols.length) continue; const u = Object.assign({}, u0, { cols, x: Math.round(cols.reduce((n, c) => n + c[0], 0) / cols.length), z: Math.round(cols.reduce((n, c) => n + c[1], 0) / cols.length) }); units.push({ key: u.s + ':' + (u0.cols[0][0] >> 3) + ':' + (u0.cols[0][1] >> 3), kind: u.s > 0 ? 'bump' : 'hole', x: u.x, z: u.z, area: u.area ? 1 : 0, cols: u.cols, lock: new Vec3(u0.cols[0][0] >> 3, -9000 - (u.s > 0 ? 1 : 0), u0.cols[0][1] >> 3) }) }
  { const m = new Map(); for (const q of a.strays || []) { const k = '2:' + (q[0] >> 3) + ':' + (q[2] >> 3); if (hardExcluded(q[0], q[2]) || keepOut.some(b => inB(b, q[0], q[2]))) continue; let u = m.get(k); if (!u) { u = { key: k, kind: 'stray', x: q[0], z: q[2], area: 0, cols: [], lock: new Vec3(q[0] >> 3, -9002, q[2] >> 3) }; m.set(k, u); units.push(u) } u.cols.push(q) } }
  // WEEDS (audit_weeds; owner 09-20: "花の除去が出来てない"): flowers / grass tufts on the base ground, one unit per 8x8 tile, [x,y,z] of each plant's foot
  { const m = new Map(); for (const q of a.weeds || []) { const k = '4:' + (q[0] >> 3) + ':' + (q[2] >> 3); if (hardExcluded(q[0], q[2]) || keepOut.some(b => inB(b, q[0], q[2])) || A.penAt(q[0], 1e9, q[2])) continue; let u = m.get(k); if (!u) { u = { key: k, kind: 'weed', x: q[0], z: q[2], area: 0, cols: [], lock: new Vec3(q[0] >> 3, -9004, q[2] >> 3) }; m.set(k, u); units.push(u) } u.cols.push(q) } }
  // FLOATING TREE REMAINS (audit_floating): one unit per cluster; over a field too (farm boxes are no keep-out for what hangs ABOVE them), never in keep-outs / the tree farm (the audit leaves those out)
  for (const fl of a.floats || []) { if (!fl || !Array.isArray(fl.cols) || !fl.cols.length || keepOut.some(b => inB(b, fl.x, fl.z))) continue; units.push({ key: '3:' + fl.x + ':' + fl.z, kind: 'float', x: fl.x, z: fl.z, area: 0, cols: fl.cols, lock: new Vec3(fl.x, -9003, fl.z) }) }
  const fillers = () => ['dirt', 'cobbled_deepslate', 'cobblestone', 'coarse_dirt'].reduce((n, q) => n + A.count(bot, q), 0)
  const open = units.filter(u => _tidyClosed.get(u.key) !== a.t && inB(box, u.x, u.z) && !keepOut.some(b => inB(b, u.x, u.z)) && (u.kind === 'float' || !busy.some(b => inB(b, u.x, u.z))) && (!P.kinds || new RegExp(P.kinds).test(u.kind))) // params.kinds:'float|stray' = an operator sends the sponge after one kind
  for (const u of open) u.d = Math.hypot(u.x - me.x, u.z - me.z) + (u.area ? 120 : 0) + (u.kind === 'float' ? -60 : u.kind === 'weed' ? -40 : 0) + (u.key === bot.__tidyUnit ? -1000 : 0) // what the owner SEES first (a crown hanging over a field) comes before a dip in the yard
  open.sort((p, q) => p.d - q.d)
  let unit = null
  for (const u of open.slice(0, 60)) { if (BL.acquire(bot, u.lock, 12 * 60000)) { unit = u; break } }
  if (!unit) return null
  bot.__tidyUnit = unit.key
  const close = () => { _tidyClosed.set(unit.key, a.t); BL.acquire(bot, unit.lock, Math.max(60000, a.t + 40 * 60000 - Date.now())); bot.__tidyUnit = null } // held until the next audit re-measures it
  task(bot, 'tidy ' + unit.kind + ' ' + unit.x + ',' + unit.z + ' (audit)')
  if (unit.kind === 'hole' && fillers() < 8) { await A.obtain(bot, 'dirt', 64, { stop: api.stop }); if (!fillers()) await A.obtain(bot, 'cobbled_deepslate', 64, { stop: api.stop }) }
  if (unit.kind === 'hole' && unit.cols.some(c => c[2] <= -4) && !['gravel', 'sand', 'red_sand'].some(q => A.count(bot, q)) && A.stockOf('gravel') > 0) await A.obtain(bot, 'gravel', 16, { stop: api.stop }) // a slot deeper than the arm is long takes a gravity block first (army.js gravityDrop)
  if (unit.kind === 'float' && ['cobblestone', 'dirt', 'cobbled_deepslate'].reduce((n, q) => n + A.count(bot, q), 0) < 8) { await A.obtain(bot, 'cobbled_deepslate', 16, { stop: api.stop }); if (!A.count(bot, 'cobbled_deepslate')) await A.obtain(bot, 'dirt', 16, { stop: api.stop }) } // the short pillar under a high crown (first live pass: `skip {"no filler":7}`)
  if (unit.kind === 'hole' && !fillers()) { BL.release(bot, unit.lock); bot.__tidyUnit = null; _tidyClosed.set(unit.key, a.t); return { none: 'no dirt / filler carried or in stock' } }
  if (unit.kind === 'float' ? !A.bestOf(bot, 'axe') : (unit.kind !== 'hole' && unit.kind !== 'weed' && !A.bestOf(bot, 'shovel'))) await getTool(bot, unit.kind === 'float' ? 'axe' : 'shovel', api)
  if (api.stop()) return { ran: true }
  if (!await A.travel(bot, { x: unit.x, y: null, z: unit.z }, { range: 5, ms: 240000, stop: api.stop })) { if (!api.stop()) { close(); A.result(bot, { ev: 'tidy_fix', job: job.id, kind: unit.kind, at: [unit.x, unit.z], n: 0, of: unit.cols.length, why: 'cannot reach the unit' }) } return { ran: true } }
  if (unit.kind === 'float') { const r = await tidyFloat(bot, job, api, unit); if (r.closed) close(); return { ran: true, fixed: r.fixed } }
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z)); const solid = b => !!b && b.boundingBox === 'block'; const tree = b => !!b && /_log$|_wood$|_leaves$|mushroom_block|mushroom_stem/.test(b.name)
  const stairs = stairCols(); const skip = {}; const why = w => { skip[w] = (skip[w] || 0) + 1 }
  // the column as the WORLD has it now: g = top solid non-tree block within L+8..L-8, trunk above it?, water over it?
  const measure = (x, z, L) => { let g = null; let trunk = false; let wet = false; for (let y = L + 8; y >= L - 8; y--) { const b = at(x, y, z); if (!b) return null; if (/_log$|_wood$/.test(b.name)) trunk = true; if (b.name === 'water' || b.name === 'lava') wet = true; if (solid(b) && !tree(b)) { g = y; break } } return { g, trunk, wet } }
  const stand = (b, up) => !b || U.protectedBlock(b) || A.ourBlock(b.position, b.name) || (up && up.name !== 'air' && up.name !== 'cave_air' && (U.protectedBlock(up) || A.ourBlock(up.position, up.name) || /sapling|_log$|torch|_sign$|rail$|_bed$/.test(up.name)))
  let fixed = 0; let blocks = 0; let failed = 0; let firstFail = null; let already = 0; const t0 = Date.now(); let left = 0; const how = {}
  const fail = (k, r) => { failed++; if (!firstFail) firstFail = k + ': ' + String(r && r.reason || '?').slice(0, 40) }
  const xyz = unit.kind === 'stray' || unit.kind === 'weed' // cols of these kinds are [x,y,z], the others [x,z,dy]
  const order = unit.cols.slice().sort((p, q) => Math.hypot(p[0] - me.x, (xyz ? p[2] : p[1]) - me.z) - Math.hypot(q[0] - me.x, (xyz ? q[2] : q[1]) - me.z))
  for (const c of order) {
    if (api.stop() || failed > 8 || Date.now() - t0 > 8 * 60000) { left++; continue }
    BL.acquire(bot, unit.lock, 12 * 60000)
    if (unit.kind === 'weed') { // by hand, nothing collected (a pocket full of tulips is the next mess); never a crop, never what a blueprint of ours planted
      const [x, y, z] = c; const b = at(x, y, z); if (!b || !WEED_RE.test(b.name)) { already++; continue }
      if (A.ours().cells.has(x + ',' + y + ',' + z) || U.protectedBlock(b)) { why('kept:' + b.name); continue }
      const r = await BL.digBlock(bot, new Vec3(x, y, z), { collect: false, requireHarvest: false }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      const b2 = at(x, y, z); if (r && r.ok && !(b2 && WEED_RE.test(b2.name))) { fixed++; blocks++ } else fail(x + ',' + y + ',' + z, r)
      continue
    }
    if (unit.kind === 'stray') {
      const [x, y, z] = c; const b = at(x, y, z); if (!b || !solid(b)) { already++; continue }
      if (hardExcluded(x, z) || keepOut.some(q => inB(q, x, z))) { why('excluded'); continue }
      if (!(JUNK_RE.test(b.name) || b.name === 'grass_block') || stand(b, at(x, y + 1, z)) || N6.some(([dx, dy, dz]) => { const n = at(x + dx, y + dy, z + dz); return n && /torch|_sign$|ladder|lever|button/.test(n.name) && dy === 0 })) { why('kept:' + b.name); continue }
      const r = await BL.digBlock(bot, new Vec3(x, y, z), { collect: true, requireHarvest: false }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (r && r.ok && !solid(at(x, y, z))) { fixed++; blocks++ } else fail(x + ',' + y + ',' + z, r)
      continue
    }
    const [x, z] = c
    if (excluded(x, z) || hardExcluded(x, z) || keepOut.some(q => inB(q, x, z)) || busy.some(q => inB(q, x, z)) || stairs.has(x + ',' + z) || A.penAt(x, 1e9, z)) { why('excluded'); continue }
    const zy = A.zoneAt(x, z); const L = zy != null ? zy : a.level; const m = measure(x, z, L)
    if (!m || m.g == null) { why('deep'); continue } if (m.g === L) { already++; continue } if (m.trunk) { why('tree'); continue } if (m.wet) { why('water'); continue }
    if (m.g < L) { // HOLE: from the natural ground up, dirt on top; never over a protected / blueprint cell
      if (L - m.g > 6) { why('deep'); continue }
      let ok = true; for (let y = m.g + 1; y <= L + 1 && ok; y++) { const b = at(x, y, z); if (b && b.name !== 'air' && b.name !== 'cave_air' && (U.protectedBlock(b) || A.ours().cells.has(x + ',' + y + ',' + z) || !BL.isReplaceable(b))) ok = false } if (!ok) { why('occupied'); continue }
      for (let y = m.g + 1; y <= L; y++) {
        if (api.stop()) break
        const item = (y === L && A.count(bot, 'dirt')) ? 'dirt' : ['cobbled_deepslate', 'cobblestone', 'dirt', 'coarse_dirt'].find(q => A.count(bot, q)); if (!item) { why('no filler'); break }
        const r = await A.placeHard(bot, new Vec3(x, y, z), item, { stop: api.stop, fill: true, fillTop: L }); if (r && r.ok) { blocks++; if (r.inside) how.inside = (how.inside || 0) + 1; if (r.dropped) how.gravity = (how.gravity || 0) + 1 } else { fail(x + ',' + y + ',' + z, r); break }
      }
    } else { // BUMP: top-down, natural ground / junk only, nothing standing on it, stone only with a pickaxe
      if (m.g - L > 6) { why('high'); continue }
      for (let y = m.g; y > L; y--) {
        if (api.stop()) break
        const b = at(x, y, z); if (!b || !solid(b)) continue
        if (!TIDY_GROUND_RE.test(b.name) || stand(b, at(x, y + 1, z))) { why('kept:' + b.name); break }
        if (toolKindOf(b) === 'pickaxe' && !A.bestOf(bot, 'pickaxe')) { why('no pickaxe'); break }
        const feet = bot.entity.position.floored()
        if (feet.x === x && feet.z === z) { for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const q = new Vec3(x + dx, feet.y, z + dz); const s2 = [0, -1, 1].map(d => q.offset(0, d, 0)).find(p2 => BL.standable(bot, p2)); if (s2 && await A.travel(bot, s2, { range: 0, ms: 8000, stop: api.stop, quiet: true })) break } } // never the block under the own feet
        const r = await BL.digBlock(bot, new Vec3(x, y, z), { collect: true, requireHarvest: false }).catch(e => ({ ok: false, reason: String(e && e.message) })); if (r && r.ok) blocks++; else { fail(x + ',' + y + ',' + z, r); break }
      }
    }
    const m2 = measure(x, z, L); if (m2 && m2.g === L) fixed++ // VERIFIED in the world, not assumed
    if (U.freeSlots(bot) <= 2) await A.bank(bot, { torch: 16, dirt: 128, cobblestone: 64, cobbled_deepslate: 64 }, { job: job.id, stop: api.stop })
  }
  const skipped = Object.values(skip).reduce((n, q) => n + q, 0)
  if (!left) close() // every column was looked at: done, kept or failed - the next audit is the judge; interrupted = the claim stays mine for the next slice
  A.result(bot, Object.assign({ ev: 'tidy_fix', job: job.id, kind: unit.kind, at: [unit.x, unit.z], n: fixed, of: unit.cols.length, blocks, already }, left ? { left } : {}, skipped ? { skip } : {}, failed ? { failed, firstFail } : {}, Object.keys(how).length ? { how } : {}, unit.area ? { area: true } : {}))
  return { ran: true, fixed }
}
async function tidy (bot, job, api, ctx) {
  const BL = lib('blocks'); const P = job.params || {}
  if (P.dayOnly && isNight(api)) return muster(bot, job, api, ctx, 'tidy: night (params.dayOnly)') // no night gate (09-19: tidy/build parked 15-25 bots at muster every evening; no bed = muster is no safer than the crowd)
  const [x1, z1, x2, z2] = [Math.min(P.box[0], P.box[2]), Math.min(P.box[1], P.box[3]), Math.max(P.box[0], P.box[2]), Math.max(P.box[1], P.box[3])]
  { // 1. the audit's work list (what the camera SAW); only when it has nothing for this bot does the tile memory below decide
    const ex0 = tidyExcludes(P); const env = { box: [x1, z1, x2, z2], excluded: (x, z) => ex0.cols.has(x + ',' + z) || ex0.some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]), hardExcluded: (x, z) => ex0.slice(0, ex0.soft).some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) || !!A.penAt(x, 1e9, z) }
    const w = P.audit === false ? null : await tidyAudit(bot, job, api, ctx, env).catch(e_ => { swallow('army_jobs:tidyAudit', e_); return null })
    if (w && w.ran) return 'tidy'
  }
  const SF = require('path').join(A.DIR, 'tidy_state.json'); const state = A.readJSON(SF, {}) || {}
  // THE SPONGE NEVER DECLINES WHILE THE CAMERA HOLDS WORK (review row 5, 12:0xZ: 40 bots x 73 declines of `tidy: the audit lists no open work in reach and every tile
  // was tidied in the last 30 min` ONE MINUTE after a fresh base-audit had listed 274 off-level columns in 56 clusters - this memo IS the muster<->sponge ping-pong the
  // owner named, 285 assignments an hour). The 30-minute per-tile memo and the "in reach" radius are day-one numbers for a 50-block clearing; the base box is 178x190
  // today. With a FRESH audit the memo is ignored and the WHOLE box is searched - a tile that holds measured columns comes first, and a 3-minute claim is all that keeps
  // two bots off the same tile. Only when the camera's list is stale does the 30-minute memo decide again.
  const fresh = P.audit === false ? null : auditWork()
  const hotTiles = new Set()
  if (fresh) for (const u of fresh.work || []) for (const c of u.cols || []) hotTiles.add((x1 + 16 * Math.floor((c[0] - x1) / 16)) + ',' + (z1 + 16 * Math.floor((c[1] - z1) / 16)))
  const tiles = []
  for (let tx = x1; tx <= x2; tx += 16) for (let tz = z1; tz <= z2; tz += 16) { const k = job.id + ':' + tx + ',' + tz; if (Date.now() - (state[k] || 0) <= (fresh ? 5 : 30) * 60000) continue; tiles.push({ k, tx, tz, d: Math.hypot(tx + 8 - bot.entity.position.x, tz + 8 - bot.entity.position.z) - (hotTiles.has(tx + ',' + tz) ? 400 : 0) }) }
  // ...and a bot that finds every tile freshly claimed while the CAMERA still holds work steps aside for 2 minutes, not for 10 (12:10Z, the first live round: 10 bots
  // swept all 144 tiles of the box in two minutes, then 42 bots declined for 10 min and stood at muster - the exact ping-pong this change is meant to end).
  if (!tiles.length) { const why = fresh ? 'tidy: every tile of the box is claimed by a mate right now (the audit list is fresh: back in 2 min)' : 'tidy: the audit list is stale and every tile was tidied in the last 30 min'; const r = await muster(bot, job, api, ctx, why); A.decline(bot, job, fresh ? 120000 : 600000, why); return r }
  tiles.sort((a, b) => a.d - b.d)
  const tile = tiles[0]; state[tile.k] = Date.now(); A.writeJSON(SF, state) // claim it
  task(bot, 'tidy ' + tile.tx + ',' + tile.tz)
  if (!await A.travel(bot, { x: tile.tx + 8, y: null, z: tile.tz + 8 }, { range: 8, ms: 240000, stop: api.stop })) { const st1 = A.readJSON(SF, {}) || {}; st1[tile.k] = Date.now() - 25 * 60000; A.writeJSON(SF, st1); return 'tidy: cannot reach tile ' + tile.k } // a tile nobody LOOKED at is not tidied: the stamp is a claim, it comes off again
  const ex = tidyExcludes(P); const excluded = (x, z) => ex.cols.has(x + ',' + z) || ex.some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3])
  const hardExcluded = (x, z) => ex.slice(0, ex.soft).some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) || !!A.penAt(x, 1e9, z) // params.exclude, farm and berry boxes; pens belong to their herder
  const solid = b => !!b && b.boundingBox === 'block'; const tree = b => !!b && /_log$|_leaves$/.test(b.name)
  const by = Math.floor(bot.entity.position.y)
  const ground = (x, z) => { for (let y = by + 14; y >= by - 14; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) return null; if (solid(b) && !tree(b)) return y } return null }
  const fixes = []
  // THE army's crafting table is furniture, not litter (foreman 09-20 02:00Z: `banked {job:"tidy_spawn", crafting_table:23}` in an hour - the groundskeepers dug
  // up settings.craftTable again and again, `obtain_failed` x39/30 min by 23 bots): the registered table, every furnace and every bed are kept like the depot chests.
  const S_ = A.settings(); const keepTables = (P.keepTables || []).concat(...Object.values(S_.chests || {}), Array.isArray(S_.craftTable) ? [S_.craftTable] : [], S_.furnaces || [], S_.respawnBeds || [])
  for (let x = tile.tx; x < tile.tx + 16 && x <= x2; x++) for (let z = tile.tz; z < tile.tz + 16 && z <= z2; z++) {
    // STRAY (owner 09-20 05:00Z "stray blocks beside the depot"): inside a BUILT ZONE (a level pad of ours / a structure's footprint) the ground is ONE level, so a junk
    // block standing above it that is no cell of any blueprint of ours, carries nothing of ours and is no tree is somebody's leftover (escape steps, supports, a
    // creeper's rim) - dug and banked. This rule also runs in the columns the ground rules below leave alone (roads, hall, depot aisles).
    if (!hardExcluded(x, z)) {
      const zy = A.zoneAt(x, z)
      if (zy != null) for (let y = zy + 4; y >= zy + 1; y--) {
        const b = bot.blockAt(new Vec3(x, y, z)); if (!b || !solid(b) || !(JUNK_RE.test(b.name) || b.name === 'grass_block') || U.protectedBlock(b) || A.ourBlock(b.position, b.name)) continue
        const up = bot.blockAt(new Vec3(x, y + 1, z)); if (up && up.name !== 'air' && (U.protectedBlock(up) || A.ourBlock(up.position, up.name) || tree(up) || /sapling/.test(up.name))) continue
        if (N6.some(([dx, dy, dz]) => { const n = bot.blockAt(new Vec3(x + dx, y + dy, z + dz)); return n && /torch|_sign$|ladder|lever|button/.test(n.name) && dy === 0 })) continue // something may hang on it
        fixes.push({ kind: 'stray', dig: new Vec3(x, y, z) })
      }
    }
    if (excluded(x, z)) continue
    const g = ground(x, z); if (g == null) continue
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ground(x + dx, z + dz)); if (nb.some(n => n == null)) continue
    const top = bot.blockAt(new Vec3(x, g, z))
    if (nb.every(n => g - n >= 2) && JUNK_RE.test(top.name)) { const to = Math.max(...nb); for (let y = g; y > to; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && JUNK_RE.test(b.name)) fixes.push({ kind: 'pillar', dig: new Vec3(x, y, z) }); else break } } else if (nb.every(n => n - g >= 2)) { const to = Math.min(...nb); for (let y = g + 1; y <= to; y++) fixes.push({ kind: 'hole', put: new Vec3(x, y, z), item: y === to ? 'dirt' : 'cobblestone' }) }
    // the owner's "mystery single blocks": ONE placed block sitting on the ground (cobble/planks/netherrack, or dirt on top of GRASS), all four
    // neighbours lower -> pick it up; ONE missing block (1 deep, 1x1, no grass at the bottom = it was dug) -> put dirt back
    else if (nb.every(n => g - n >= 1) && (/^(cobblestone|cobbled_deepslate|netherrack|.*_planks)$/.test(top.name) || (/^(dirt|coarse_dirt)$/.test(top.name) && (bot.blockAt(new Vec3(x, g - 1, z)) || {}).name === 'grass_block'))) fixes.push({ kind: 'pillar', dig: new Vec3(x, g, z) })
    else if (nb.every(n => n - g >= 1) && !/^(grass_block|water|ice|sand|gravel|podzol|snow_block)$/.test(top.name)) fixes.push({ kind: 'hole', put: new Vec3(x, g + 1, z), item: 'dirt' })
    // litter: crafting tables dropped all over the map (kept: within 3 blocks of a params.keepTables entry or of a registered depot chest)
    if (top.name === 'crafting_table' && !keepTables.some(c => Math.hypot(c[0] - x, c[2] - z) < 3)) fixes.push({ kind: 'float', dig: new Vec3(x, g, z), high: 0, litter: true })
    for (let y = g + 2; y <= g + 14; y++) { // floating junk above the ground
      const b = bot.blockAt(new Vec3(x, y, z)); if (!b || !solid(b)) continue
      const isLog = /_log$/.test(b.name)
      if (!JUNK_RE.test(b.name) && !isLog) continue
      if (isLog) { let rooted = false; for (let yy = y - 1; yy >= g; yy--) { const q = bot.blockAt(new Vec3(x, yy, z)); if (!q || q.name === 'air') break; if (yy === g + 1 || /dirt|grass|podzol/.test(q.name)) { rooted = true; break } } if (rooted) continue; if (/_log$/.test((bot.blockAt(new Vec3(x, y - 1, z)) || {}).name)) continue; fixes.push({ kind: 'float', dig: new Vec3(x, y, z), high: y - g }); continue } // a trunk piece hanging in the air (crown left behind by lumberjacks): its lowest log is taken, the next pass takes the next
      const u1 = bot.blockAt(new Vec3(x, y - 1, z)); const u2 = bot.blockAt(new Vec3(x, y - 2, z)); if (solid(u1) || solid(u2)) continue
      const touching = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map(([dx, dy, dz]) => bot.blockAt(new Vec3(x + dx, y + dy, z + dz)))
      if (touching.some(n => n && (tree(n) || U.protectedBlock(n) && n.name !== 'air' && solid(n)))) continue
      // SKY JUNK: old pathfinder skyways/rings of dirt+cobble float 5-10 blocks over the base (seen on the map render). Anything junk that hangs
      // >= 3 above the ground with nothing under it goes, even when it touches more junk. Lower, well-connected pieces may be a real roof: keep.
      if (touching.filter(n => solid(n)).length >= 2 && y - g < 3) continue
      if (U.protectedBlock(bot.blockAt(new Vec3(x, y, z)))) continue // torches, walls, fences, chests ... are somebody's work, never junk (the new hedge's wall roofs were listed as floats and refused as 'protected' every 5 min)
      fixes.push({ kind: 'float', dig: new Vec3(x, y, z), high: y - g })
    }
  }
  // STONE IS NEVER PUNCHED HERE EITHER (owner 11:3xZ: 15 of 47 bots carried no pickaxe and dug by hand = 7 s a block and no drop): a pass with a stray/pillar/float of
  // stone fetches a pickaxe first, exactly as the build handler does.
  if (!A.bestOf(bot, 'pickaxe') && fixes.some(f => f.dig && toolKindOf(bot.blockAt(f.dig)) === 'pickaxe')) { const was = bot.entity.position.clone(); if (await getPick(bot, api) && bot.entity.position.distanceTo(was) > 12) await A.travel(bot, { x: was.x, y: null, z: was.z }, { range: 6, ms: 120000, stop: api.stop, quiet: true }) }
  if (!A.bestOf(bot, 'shovel') && fixes.some(f => f.dig && toolKindOf(bot.blockAt(f.dig)) === 'shovel')) { const was = bot.entity.position.clone(); if (await getTool(bot, 'shovel', api) && bot.entity.position.distanceTo(was) > 12) await A.travel(bot, { x: was.x, y: null, z: was.z }, { range: 6, ms: 120000, stop: api.stop, quiet: true }) }
  let done = { pillar: 0, hole: 0, float: 0, stray: 0 }; let failed = 0; let firstFail = null
  // a cell that failed twice is left alone (REPORT 09-19: "tidy_base - last 10 passes all 0": the same unreachable floats were retried every
  // 5 min for ever and no tile ever counted as clean); the reason of the first failure travels with the pass event
  const badCells = (A.readJSON(SF, {}) || {}).__bad || {}
  for (let i = fixes.length - 1; i >= 0; i--) { const p0 = fixes[i].dig || fixes[i].put; if ((badCells[p0.x + ',' + p0.y + ',' + p0.z] || 0) >= 2) fixes.splice(i, 1) }
  fixes.sort((a, b) => (a.dig || a.put).distanceTo(bot.entity.position) - (b.dig || b.put).distanceTo(bot.entity.position) || ((a.dig ? -a.dig.y : a.put.y) - (b.dig ? -b.dig.y : b.put.y))) // tie: digs top-down, puts bottom-up (a mixed dig/put pair threw on `undefined.y`, 09-20)
  // holes bottom-up, pillars top-down
  const holes = fixes.filter(f => f.kind === 'hole').sort((a, b) => a.put.y - b.put.y); const digs = fixes.filter(f => f.kind !== 'hole').sort((a, b) => b.dig.y - a.dig.y)
  for (const f of digs.concat(holes)) {
    if (api.stop() || failed > 10) break
    let r
    if (f.dig) {
      if (f.kind === 'float' && f.high > 4) { await A.travel(bot, { x: f.dig.x, y: null, z: f.dig.z }, { range: 1, ms: 30000, stop: api.stop, quiet: true }); await BL.pillarUp(bot, Math.min(8, f.high - 3), {}).catch(e_ => swallow('army_jobs:tidyUp', e_)) }
      r = await BL.digBlock(bot, f.dig, { collect: true, requireHarvest: false, allowProtected: !!f.litter }).catch(e => ({ ok: false, reason: String(e && e.message) })) // a littered crafting table is 'protected' for every other job, but picking it up is exactly this job's work
      if (f.kind === 'float' && f.high > 4) await BL.removeScaffold(bot).catch(e_ => swallow('army_jobs:tidyDown', e_))
    } else r = await A.placeHard(bot, f.put, f.item, { stop: api.stop })
    if (r && r.ok) done[f.kind]++; else { failed++; const p0 = f.dig || f.put; const ck = p0.x + ',' + p0.y + ',' + p0.z; badCells[ck] = (badCells[ck] || 0) + 1; if (!firstFail) firstFail = f.kind + ' @' + ck + ': ' + String(r && r.reason || '?').slice(0, 50) }
    if (U.freeSlots(bot) <= 2) await A.bank(bot, { torch: 16, dirt: 64, cobblestone: 64 }, { job: job.id, stop: api.stop })
  }
  { const st2 = A.readJSON(SF, {}) || {}; st2.__bad = Object.assign(st2.__bad || {}, badCells); if (failed > 0 || fixes.length > done.pillar + done.hole + done.float + done.stray) st2[tile.k] = Date.now() - 25 * 60000; A.writeJSON(SF, st2) } // not clean yet: come back in 5 min, not 30
  A.result(bot, { ev: 'tidy_pass', job: job.id, tile: [tile.tx, tile.tz], found: fixes.length, pillars: done.pillar, holes: done.hole, floats: done.float, strays: done.stray, failed, firstFail })
  return 'tidy'
}

// ---- EVERY BOT SLEEPS (foreman 09-20 03:58Z: 49 beds stood in the dorm and phantoms still killed 2-4 bots an hour - Chino 03:24Z, Yuzu 03:27Z).
// Phantoms spawn PER PLAYER, on the time since THAT player last lay in a bed (72000 ticks = 60 real minutes; lying down resets it, no need to
// sleep the night through); the sleeper protects only itself. So every bot owns a bed (roster index -> settings.respawnBeds without the sleeper's)
// and lies down every ~3rd dusk (a skipped-night cycle is ~10.6 min; due after 25 min -> rest at ~32 min, two missed turns still < 60 min):
// near dusk a due bot within 150 blocks of its bed, on the surface, leaves its slice (api.stop is wrapped in withHandover), walks to ITS bed,
// waits for 12600, sleeps (players_sleeping_percentage 1: the night ends ~5 s later for everybody), reports slept {own:true} once and goes back
// to its job. Far away / in the mine / on a plan = skip the turn, next dusk again. On a REAL night (string night, needsNight trip) the bot gets
// up after 1.5 s - 100 ticks in bed would skip the night the expedition needs. First nights after a restart are staggered in thirds (dorm aisle).
// 09-20 11:5xZ (owner: "全体的にタスクの効率が悪すぎる"): measured 42 slept + 44 bed_skip per hour = a third of the army walking up to 150 blocks to the dorm at EVERY dusk, half of
// the trips for nothing, ~10 % of all bot time. Nights are skipped within seconds by the sleeper, so phantoms (they need a real night) never come; what a bot needs from its
// bed is the RESPAWN POINT, and that holds until the bed breaks or the bot dies (death resets the clock above). Once per 6 h is plenty.
const BED_DUE_MS = 6 * 3600000
function bedDue (bot, job) {
  const c = bot.__armyBedChk; if (c && Date.now() - c.t < 3000 && c.job === job.id) return c.v
  let out = null
  try {
    const t = bot.time && bot.time.timeOfDay; const S = A.settings(); const all = (Array.isArray(S.respawnBeds) ? S.respawnBeds : []).filter(q => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite))
    const idx = (S.roster || []).indexOf(bot.username)
    if (bot.__armyBedDeaths == null) bot.__armyBedDeaths = bot.__armyDeaths || 0 // deaths before this code loaded say nothing about rest
    if (bot.__armyBedDeaths !== (bot.__armyDeaths || 0)) { bot.__armyBedDeaths = bot.__armyDeaths || 0; bot.__armySleptT = Date.now() } // dying resets the rest clock too
    const due = bot.__armySleptT ? Date.now() - bot.__armySleptT > BED_DUE_MS : (idx + ((bot.time && bot.time.day) || 0)) % 3 === 0
    if (due && all.length >= 2 && idx >= 0 && Number.isFinite(t) && t >= 10500 && t < 23000 && !/^(delegate|sleeper|steps|scout)$/.test(job.type) && !bot.isSleeping && !underground(bot) && Date.now() - (bot.__armyBedTryT || 0) > 8 * 60000) {
      const board = A.readJSON(A.F.board, {}) || {}; const sj = (board.jobs || []).find(j => j.type === 'sleeper' && j.params && Array.isArray(j.params.bed)); const sb = (sj ? sj.params.bed : all[0]).join(',')
      const beds = all.filter(q => q.join(',') !== sb); const bed = beds[idx % beds.length]; const d = A.dist2(bot, bed[0], bed[2])
      const real = stringNight() || (board.jobs || []).some(j => j.status === 'active' && j.params && j.params.needsNight)
      // leave so that the bot stands at its bed at 12600: 3 blocks/s over ground + 25 s for the dorm aisle; after dusk only when the night is real (a skipped night is over before anybody arrives)
      if (d < 150 && (t < 12600 ? (12600 - t) / 20 <= d / 3 + 25 : (real || d < 12))) out = { bed, beds, real, d: Math.round(d) }
    }
  } catch (e_) { swallow('army_jobs:bedDue', e_) }
  bot.__armyBedChk = { t: Date.now(), job: job.id, v: out }
  return out
}
async function bedtime (bot, job, stop) {
  const c = bedDue(bot, job); if (!c) return false
  bot.__armyBedTryT = Date.now(); bot.__armyBedChk = null
  const night = () => { const t = bot.time.timeOfDay; return t >= 12600 && t < 23400 }
  let bed = c.bed; let why = null
  task(bot, 'bedtime: to my bed ' + bed.join(','))
  if (!await A.travel(bot, v(bed), { range: 2, ms: 60000 + 1000 * c.d, stop, quiet: true })) { if (stop()) { bot.__armyBedTryT = 0; return false } A.result(bot, { ev: 'bed_skip', job: job.id, bed, why: 'cannot reach my bed' }); return false } // re-assigned on the way (04:22Z: 3 of 8 walkers): not a failure, the next job's first slice walks on
  task(bot, 'bedtime: at my bed, waiting for dusk')
  for (const end = Date.now() + 120000; Date.now() < end && !stop() && !night();) await sleep(400)
  for (let k = 0; k < 4 && !stop() && night() && !bot.isSleeping; k++) {
    const bb = bot.blockAt(v(bed))
    try { if (!bb || !bot.isABed(bb)) throw new Error('the bed is occupied'); await U.withTimeout(bot.sleep(bb), 6000, 'sleep') } catch (e) {
      why = String(e && e.message || e).slice(0, 60)
      if (/occupied|not a bed|half bed/.test(why)) { // a room-mate (49 bots, 48 beds) or a broken bed: the nearest free one
        const me = bot.entity.position; const free = c.beds.filter(q => q !== bed && (b => b && bot.isABed(b) && !(b.getProperties && b.getProperties().occupied))(bot.blockAt(v(q)))).sort((p, q) => Math.hypot(p[0] - me.x, p[2] - me.z) - Math.hypot(q[0] - me.x, q[2] - me.z))[k] // k: two bots that lost the same bed do not race for the same spare one for ever
        if (!free) break
        bed = free; await A.travel(bot, v(bed), { range: 2, ms: 30000, stop, quiet: true })
      } else if (/monsters/i.test(why)) { const h = A.hostiles(bot, 10)[0]; if (h && h.e.name !== 'creeper' && A.bestOf(bot, 'sword')) await A.kill(bot, h.e, 12000, stop); else await sleep(1500) } else if (/too far/.test(why)) await A.travel(bot, v(bed), { range: 1, ms: 20000, stop, quiet: true })
      else if (/not night/.test(why)) break
      else await sleep(1000)
    }
  }
  if (!bot.isSleeping) { A.result(bot, { ev: 'bed_skip', job: job.id, bed, why: why || (night() ? 'stopped' : 'the night was over before I lay down') }); return false }
  task(bot, 'bedtime: in bed')
  const t0 = Date.now(); const hold = c.real ? 1500 : 20000
  while (bot.isSleeping && Date.now() - t0 < hold) await sleep(300)
  try { if (bot.isSleeping) await bot.wake() } catch (e_) { swallow('army_jobs:bedtimeWake', e_) }
  bot.__armySleptT = Date.now(); bot.__armySpawnKey = bed.join(',') // lying down set the respawn point as well
  A.result(bot, { ev: 'slept', own: true, job: job.id, bed, ms: Date.now() - t0 })
  return true
}

// ---- HAND-OVER RULE: output never travels on with a bot into its next job. When a bot STARTS a different job while carrying output
// (food, seeds, ores, ingots, wool, string …) and the depot is within 120 blocks, it banks first. (09-19: 41 berries rode around in pockets
// while 6 bots starved; a berry picker was re-assigned to hunting with 18 berries.)
const OUTPUT_RE = /^(sweet_berries|wheat|wheat_seeds|bread|cod|salmon|cooked_.*|beef|porkchop|chicken|mutton|rabbit|raw_iron|raw_copper|raw_gold|iron_ingot|coal|diamond|.*_wool|string|bone|feather|leather|egg|sugar_cane|paper|book)$/
function withHandover (name, fn) {
  if (['muster', 'scan'].includes(name)) return fn
  return async (bot, job, api, ctx) => {
    // BEDTIME (see bedDue): first thing of a slice when due; the running slice is ended through api.stop so a 15-min slice cannot sit through the ~60 s window before dusk
    const ow = overworld(bot) // off the overworld NOTHING base-bound below runs: bed, canteen, banking, respawn point, mine stairs are overworld coordinates
    if (ow) try { const stop0 = api.stop; if (await bedtime(bot, job, stop0)) task(bot, job.id + ': back from bed'); api.stop = () => stop0() || !!bedDue(bot, job) } catch (e_) { swallow('army_jobs:bedtime', e_) }
    if (ow) try { await canteen(bot, api) } catch (e_) { swallow('army_jobs:1189', e_) } // standby is gone, so the canteen visit happens at every slice start (self-limited: hungry/hurt, near base, 90 s)
    // POCKETS: things picked up along the way (drops, other bots' loot, dug blocks) go to the warehouse, not around the world in a pocket.
    // Any job, at every slice start: fewer than 9 free slots and the depot within 150 blocks (surface) -> bank, keeping the working kit.
    try {
      const home = A.chestsOf('build')[0]
      // BULK RULE (foreman 09-19: a rescued bot lost 96 cobblestone + 44 planks + 32 clay): more than ~1.5 stacks of bulk blocks beyond the job's
      // working kit is banked too — whatever happens to the bot then costs tools, not a shift of material.
      const kitOf = n => (n === 'cobblestone' ? stoneKeep(/build|deck|tidy|light/.test(job.type) ? 128 : 0) : n === 'dirt' ? (job.type === 'build' ? 320 : job.type === 'tidy' ? 64 : 0) : 0) // build: the cut feeds the fill (5 stacks of dirt stay)
      const bulk = bot.inventory.items().filter(i => /^(cobblestone|cobbled_deepslate|dirt|gravel|sand|clay_ball|stone|andesite|diorite|granite|tuff|.*_planks|.*_log)$/.test(i.name)).reduce((n, i) => n + Math.max(0, i.count - kitOf(i.name)), 0)
      if (ow && home && job.type !== 'delegate' && (U.freeSlots(bot) < 9 || bulk > 96 || (A.count(bot, 'torch') > 32 && !/^(build|light|ores|deck)$/.test(job.type))) && A.dist2(bot, home.x, home.z) < 150 && !underground(bot) && Date.now() - (bot.__armyPocketT || 0) > 120000) {
        bot.__armyPocketT = Date.now()
        task(bot, 'tidying pockets')
        const keep = { torch: 16, ...rationsOf(bot), sweet_berries: job.type === 'berries' ? 4 : 0, wheat_seeds: job.type === 'farm' ? 64 : 0, cobblestone: stoneKeep(/build|deck|tidy|light/.test(job.type) ? 64 : 0), dirt: job.type === 'build' ? 320 : job.type === 'tidy' ? 64 : 0, bucket: 3, water_bucket: 3, fishing_rod: 1, shears: 1, coal: 8, stick: 8 }
        if (job.type === 'sleeper') for (const i of bot.inventory.items()) if (/_bed$/.test(i.name)) keep[i.name] = 1 // a bed on its way back to the bed spot
        if (job.type === 'herd') for (const n of HERD_LURE[(job.params || {}).kind] || []) keep[n] = 32 // the lure in a herder's pocket is a tool
        for (const i of bot.inventory.items()) if (/_hoe$/.test(i.name) && job.type === 'farm') keep[i.name] = 1
        const m = await A.bank(bot, keep, { job: job.id, stop: api.stop })
        const n = Object.values(m).reduce((a, b) => a + b, 0); if (n) A.result(bot, { ev: 'pockets', job: job.id, n })
      }
    } catch (e_) { swallow('army_jobs:pockets', e_) }
    // HELP DESK answer waiting? run it first: a short plan of verbs written by an LLM for exactly this bot's failure (see A.askHelp)
    try {
      const ans = A.helpAnswer(bot)
      if (ans && ans.action === 'steps' && Array.isArray(ans.steps)) {
        let okAll = true; let n = 0
        for (const stp of ans.steps.slice(0, 12)) { if (api.stop()) break; const fn = VERBS[stp.do]; if (!fn) { okAll = false; break } task(bot, 'help: ' + stp.do); const r = await U.withTimeout(fn(bot, stp, api, job), (stp.s || 300) * 1000, 'helpStep').catch(e => 'error: ' + String(e && e.message)); n++; if (r !== true) { okAll = false; A.result(bot, { ev: 'help_step_failed', do: stp.do, why: String(r).slice(0, 80) }); break } }
        A.result(bot, { ev: 'help_done', ok: okAll, steps: n, note: String(ans.note || '').slice(0, 80), sig: ans.sig })
        try { const rf = require('path').join(A.DIR, 'remedies.json'); const R = A.readJSON(rf, {}) || {}; if (ans.sig && R[ans.sig]) { R[ans.sig][okAll ? 'ok' : 'bad'] = (R[ans.sig][okAll ? 'ok' : 'bad'] || 0) + 1; A.writeJSON(rf, R) } } catch (e_) { swallow('army_jobs:remedyScore', e_) }
      } else if (ans && ans.action === 'decline') A.decline(bot, job, 600000, 'helpdesk: ' + String(ans.note || '').slice(0, 60))
    } catch (e_) { swallow('army_jobs:helpAnswer', e_) }
    if (bot.__armyHandoverJob !== job.id) {
      const prev = bot.__armyHandoverJob; bot.__armyHandoverJob = job.id
      if (job.type !== 'delegate') task(bot, job.id + ': starting') // never keep the previous job's task label (a stale 'iron:wait-stairs' looked like a hang)
      const home = A.chestsOf('food')[0]
      const carrying = bot.inventory.items().filter(i => OUTPUT_RE.test(i.name)).reduce((n, i) => n + i.count, 0)
      if (ow && prev && home && carrying >= 6 && A.dist2(bot, home.x, home.z) < 120 && !underground(bot) && job.type !== 'delegate') {
        task(bot, 'handover: banking ' + carrying + ' items first')
        const keep = { torch: 16, coal: 4, fishing_rod: 1, shears: 1, bucket: 3, water_bucket: 3, ...rationsOf(bot) }; if (job.type === 'farm') keep.wheat_seeds = 64; if (job.type === 'berries') keep.sweet_berries = 4; if (job.type === 'herd') for (const n of HERD_LURE[(job.params || {}).kind] || []) keep[n] = 32; if (job.type === 'sleeper') for (const i of bot.inventory.items()) if (/_bed$/.test(i.name)) keep[i.name] = 1
        await A.bank(bot, keep, { job: prev, stop: api.stop })
      }
    }
    // RESPAWN POINT: a bot that never clicked a bed respawns at the world spawn, far from its work. settings.respawnBeds = [[x,y,z],…] (or the single
    // settings.respawnBed). A bot belongs to the bed NEAREST to its job's `site` (to itself when the job has no site): it clicks that bed once (a bed sets
    // the respawn point by day too) and again when a job moves it clearly (32 blocks) nearer to another bed. Only beds within 150 blocks of where the bot
    // stands are walked to; a bed that is gone is reported (`spawn_bed_missing`); each bed is tried at most every 10 min. Event: spawn_set {at, was}.
    try {
      const S = A.settings()
      const beds = (Array.isArray(S.respawnBeds) ? S.respawnBeds : [S.respawnBed]).filter(q => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite))
      if (ow && beds.length && job.type !== 'delegate' && !underground(bot)) {
        const me = bot.entity.position; const ref = Array.isArray(job.site) && Number.isFinite(job.site[0]) && Number.isFinite(job.site[2]) ? { x: job.site[0], z: job.site[2] } : { x: me.x, z: me.z }
        const dRef = q => Math.hypot(q[0] - ref.x, q[2] - ref.z)
        let rb = beds.slice().sort((p1, p2) => dRef(p1) - dRef(p2))[0]
        const cur = beds.find(q => q.join(',') === bot.__armySpawnKey)
        if (cur && dRef(cur) - dRef(rb) < 32) rb = cur
        const key = rb.join(','); const tries = bot.__armySpawnTries = bot.__armySpawnTries || {}
        if (bot.__armySpawnKey !== key && Date.now() - (tries[key] || 0) > 600000 && A.dist2(bot, rb[0], rb[2]) < 150) {
          tries[key] = Date.now()
          const bp = new Vec3(rb[0], rb[1], rb[2])
          task(bot, 'setting my respawn point')
          if (await A.travel(bot, bp, { range: 2, ms: 90000 + 1000 * Math.round(A.dist2(bot, rb[0], rb[2])), stop: api.stop, quiet: true })) {
            const bb = bot.blockAt(bp)
            if (bb && bot.isABed(bb)) {
              let said = false; const onMsg = m => { if (/respawn point set/i.test(String(m))) said = true }
              bot.on('messagestr', onMsg)
              try { await bot.lookAt(bp.offset(0.5, 0.4, 0.5), true); await U.withTimeout(bot.activateBlock(bb), 4000, 'bedClick') } catch (e_) { swallow('army_jobs:bedClick', e_) }
              await sleep(600)
              try { if (bot.isSleeping) await bot.wake() } catch (e_) { swallow('army_jobs:bedWake', e_) }
              bot.removeListener('messagestr', onMsg)
              const was = bot.__armySpawnKey || null; bot.__armySpawnKey = key
              A.result(bot, { ev: 'spawn_set', at: rb, was, confirmed: said })
            } else if (bb) A.result(bot, { ev: 'spawn_bed_missing', at: rb, found: bb.name })
          }
        }
      }
    } catch (e_) { swallow('army_jobs:respawnPoint', e_) }
    // a SURFACE job for a bot that stands deep in the mine: up the stairs first, then the job's own travel starts from daylight
    try { const sy = Array.isArray(job.site) ? job.site[1] : null; if (ow && job.type !== 'delegate' && underground(bot, bot.entity.position.y + 5) && (sy == null || sy >= (A.surfaceFloor(bot) || 58))) await upTheStairs(bot, job.id) } catch (e_) { swallow('army_jobs:surfaceFirst', e_) }
    return fn(bot, job, api, ctx)
  }
}
// the exports ARE the job types (army_worker: handler = J[job.type])
const _handlers = { ores, lumber, tidy, build, berries, cane, light, sleeper, guard, haul, deck, farm, steps, depot, muster, hunt, herd, fish, scan, delegate, scout }
// EXTENSION MODULES (owner 09-20: "opus subagent をもっと有効活用して" - this file is 3600 dense lines and ONE engineer at a time can own it; new fronts like the Nether
// live in their own file so several engineers work in parallel): lib/jobs_<name>.js exports a factory `(ctx) => ({ types: {<jobType>: handler}, verbs: {<verb>: fn} })`
// plus static `TYPES` / `VERBS` name lists for the board validator (armyctl.js). ctx = the primitives of this file. Still ONE worker, ONE board, ONE dispatcher.
for (const f of require('fs').readdirSync(__dirname).filter(q => /^jobs_[a-z0-9]+\.js$/.test(q)).sort()) {
  try { const ext = require('./' + f)({ A, U, VERBS, muster, task, swallow, handlers: _handlers, blueprintCells, blueprintCellsOf }) || {}; Object.assign(_handlers, ext.types || {}); for (const [k, fn] of Object.entries(ext.verbs || {})) if (!VERBS[k]) VERBS[k] = fn } catch (e_) { swallow('army_jobs:ext:' + f, e_) }
}
for (const k of Object.keys(_handlers)) _handlers[k] = withHandover(k, _handlers[k])
module.exports = _handlers
// offline proofs (ops/check.sh, unit runs without a server) reach the pure parts here; NOT enumerable: the worker and the validator list job types with Object.keys
Object.defineProperty(module.exports, '_internals', { value: { blueprintCells, blueprintCellsOf, padAudit, stairCols, sampleLand, biomeOf, VERBS, raw: { build, farm, scout, lumber } }, enumerable: false })
