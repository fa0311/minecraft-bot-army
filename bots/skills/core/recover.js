// core/recover.js — GO BACK FOR YOUR STUFF (owner 09-20: "アイテム回収に行かないせいでアイテムがロストします / マイクラの基礎が分かっていればこんなミスはしません").
// A bot that died respawned at its bed, re-kitted from the depot and walked back to work; the diamond pickaxe, the iron armour and the 900
// cobblestone it was carrying lay where it fell and despawned 5 minutes later. Every good player runs back. There was no recovery code at all.
// Shape: a core module (contract: core/index.js). The 'death' listener (idempotent, re-bound on hot reload) records WHERE, WHEN, WHAT was carried
// and WHETHER the items burned; onDeath() decides once (overworld only, not lava/fire/void, worth a trip, not a keep-out, not a spot that killed
// this bot twice in 10 min); onTick() re-raises the alert each second while the drop can still be reached (the alert goes stale in 30 s and kitUp
// runs first, so ONE raise is not enough), and handle() owns the legs: A.travel there (read-only movement — nothing is dug or placed for a trip),
// A.pickup within 10 blocks until the 5-minute mark or 60 s on site, A.wear what came back, then ONE report with the MEASURED inventory difference.
// Fights nothing (core/combat.js raises prio 80, this one 70), one attempt per death, aborts at hp < 8.
const LIFETIME = 300000 // an item entity despawns 5 min after it dropped (vanilla; Paper's `alt-item-despawn-rate` is off by default)
const SPEED = 4 // blocks per second a bot really makes with strictMovements (measured: 13214 m / 15 min / ~45 bots ≈ 4)
const MARGIN = 20000 // slack for the path around hills, the mobs on the way and the last metres of chasing the stack
const ON_SITE = 60000 // at most a minute of picking up: what is not in reach by then is gone or unreachable
const KILL_ZONE_MS = 600000
const KILL_ZONE_R = 8
const VER = 1 // bump to re-bind the listeners after a hot reload that changed them

// WORTH A TRIP (owner's rule): any iron/diamond(+netherite) tool or armour piece, or >= 64 items of anything. Everything else is an empty-pocket
// death and is ignored — walking 200 blocks for 3 dirt is exactly the make-work the owner banned.
const GOOD_GEAR = /^(iron|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/
const TIER_VALUE = { netherite: 200, diamond: 80, iron: 25, chainmail: 12, copper: 6, golden: 6, turtle: 20, stone: 2, leather: 2, wooden: 1 }
const GEAR_RE = /^(\w+)_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/
const ITEM_VALUE = { // per unit; everything not named here is bulk (0.05) — 900 cobblestone is worth a trip through the `>= 64` rule, not through its price
  netherite_ingot: 120, netherite_scrap: 60, ancient_debris: 60, diamond: 40, enchanted_book: 40, elytra: 200, totem_of_undying: 100,
  emerald: 8, iron_ingot: 10, gold_ingot: 8, ender_eye: 20, ender_pearl: 10, blaze_rod: 10, name_tag: 20, saddle: 10,
  shield: 8, bow: 6, crossbow: 8, bucket: 10, water_bucket: 10, lava_bucket: 12, flint_and_steel: 5, shears: 6, fishing_rod: 5, obsidian: 4
}
function value (inv) { // -> {score, worth, why}
  let score = 0; let gear = null; let bulk = null; let bulkN = 0
  for (const [k, n] of Object.entries(inv || {})) {
    if (!(n > 0)) continue
    const g = GEAR_RE.exec(k)
    score += n * (g && TIER_VALUE[g[1]] ? TIER_VALUE[g[1]] : ITEM_VALUE[k] != null ? ITEM_VALUE[k] : 0.05)
    if (GOOD_GEAR.test(k) && !gear) gear = k
    if (n > bulkN) { bulkN = n; bulk = k }
  }
  const worth = !!gear || bulkN >= 64
  return { score: Math.round(score), worth, why: gear ? gear : bulkN >= 64 ? bulkN + ' ' + bulk : 'nothing of value' }
}
const top = (inv, n = 3) => Object.entries(inv || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + ':' + v).join(' ') || 'empty'

// WHAT A DEATH REALLY COSTS, in the unit the forge speaks (top model 09-20: 2580 raw iron mined in 20 h, 1891 forged into gear, 113 pieces still
// standing — 267 deaths ate ~1300 iron and NOTHING measured it). ONE table, used by the `death` event (army_worker.js) and by `recovered` here, so
// "lost minus recovered" is one subtraction. Worn armour is counted: A.carried() reads the armour + off-hand slots, not just the pockets.
const PIECE = { helmet: 5, chestplate: 8, leggings: 7, boots: 4, pickaxe: 3, axe: 3, sword: 2, shovel: 1, hoe: 2 }
const IRON_FLAT = { iron_ingot: 1, raw_iron: 1, iron_block: 9, shield: 1, bucket: 3, water_bucket: 3, lava_bucket: 3, milk_bucket: 3, shears: 2, flint_and_steel: 1, crossbow: 1, chain: 1, iron_bars: 0.375, rail: 0.1, minecart: 5, hopper: 5, iron_door: 2, iron_trapdoor: 4, smithing_table: 2, stonecutter: 1, blast_furnace: 5, cauldron: 7, anvil: 31, compass: 4, tripwire_hook: 1, piston: 1, sticky_piston: 1 }
const DIAMOND_FLAT = { diamond: 1, diamond_block: 9 }
function lost (inv) { // -> {iron, diamond, items}   iron = INGOT equivalents, diamond = diamond equivalents, items = everything counted
  let iron = 0; let diamond = 0; let items = 0
  for (const [k, n] of Object.entries(inv || {})) {
    if (!(n > 0)) continue
    items += n
    const g = GEAR_RE.exec(k)
    if (g && PIECE[g[2]]) { if (g[1] === 'iron') iron += n * PIECE[g[2]]; else if (g[1] === 'diamond') diamond += n * PIECE[g[2]]; else if (g[1] === 'netherite') { diamond += n * PIECE[g[2]]; iron += n * PIECE[g[2]] } continue }
    if (IRON_FLAT[k]) iron += n * IRON_FLAT[k]
    if (DIAMOND_FLAT[k]) diamond += n * DIAMOND_FLAT[k]
  }
  return { iron: Math.round(iron), diamond: Math.round(diamond), items }
}

// ITEMS BURN (Minecraft basics): a bot that died in lava, in fire or in the void dropped nothing that still exists. Two independent readings, because
// the death message can be late or absent: the server's own line, and the blocks at the death spot read while the chunk is still loaded.
const BURN_MSG = /lava|flames|burn|fire|magma|fireball|out of the world|into the void/i
const BURN_BLOCK = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/
function burnAt (bot) {
  try {
    const p = bot.entity && bot.entity.position; if (!p) return null
    if (p.y <= -62) return 'void'
    const q = p.floored()
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = bot.blockAt(q.offset(dx, dy, dz))
      if (b && BURN_BLOCK.test(b.name)) return b.name
    }
  } catch { /* the connection died with the bot: no reading, the message decides */ }
  return null
}

function state (bot) { return bot.__core_recover = bot.__core_recover || { hist: [], want: null, msg: null, fns: null } }
function unbind (bot) {
  const st = bot.__core_recover
  if (st && st.fns) { for (const [ev, fn] of st.fns) { try { bot.removeListener(ev, fn) } catch { /* already gone with the connection */ } } st.fns = null }
  bot.__recoverInstalled = 0
}
function arm (bot) { // idempotent across hot reloads: the OLD listeners are removed before the new copy binds its own
  if (bot.__recoverInstalled === VER) return
  unbind(bot)
  const st = state(bot)
  // the death message is the server's own word on the cause. It arrives with the scoreboard team's prefix ("[BOT] Rin was slain by …", see the
  // `deaths` parser in armyctl.js), so the tag is stripped before the name is matched.
  const onMsg = s => {
    const line = String(s || '').replace(/^\[[^\]]{1,24}\]\s*/, '')
    if (line.startsWith(bot.username + ' ') && /(slain|shot|blown|killed|fell|drowned|suffocated|burn|flames|lava|starved|ground|poked|froze|fireballed|withered|squashed|pricked|impaled|skewered|squished|doomed|out of the world)/.test(line)) st.msg = { t: Date.now(), line: line.slice(0, 120) }
  }
  const onDeath = () => {
    try {
      const p = bot.entity && bot.entity.position
      st.death = { t: Date.now(), pos: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null, dim: require('../lib/army').dimOf(bot), burn: burnAt(bot) }
    } catch (e) { st.death = { t: Date.now(), pos: null, dim: null, burn: null, err: String(e && e.message).slice(0, 80) } }
  }
  bot.on('messagestr', onMsg)
  bot.on('death', onDeath)
  st.fns = [['messagestr', onMsg], ['death', onDeath]]
  bot.__recoverInstalled = VER
}

function keepOutAt (A, pos) {
  for (const k of (A.settings().keepOut || [])) {
    const b = k && k.box
    if (!Array.isArray(b) || b.length !== 4) continue
    if (pos[0] >= Math.min(b[0], b[2]) && pos[0] <= Math.max(b[0], b[2]) && pos[2] >= Math.min(b[1], b[3]) && pos[2] <= Math.max(b[1], b[3])) return k.id || 'keep-out'
  }
  return null
}
const dist3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
function itemsNear (bot, r) {
  let n = 0; const me = bot.entity && bot.entity.position; if (!me) return 0
  for (const e of Object.values(bot.entities)) if (e && e.name === 'item' && e.position && e.position.distanceTo(me) <= r) n++
  return n
}

module.exports = {
  name: 'recover',
  lost, // the death event in army_worker.js prices its own loss with THIS table
  install (bot) { arm(bot) },
  uninstall (bot) { unbind(bot) },

  // THE DECISION, once per death (the worker calls this after the respawn, before kitUp). Everything that cannot change later is settled here;
  // the reach test belongs to onTick because the clock keeps running while the bot dresses at the depot.
  async onDeath (bot, info, core) {
    arm(bot)
    const A = core.A; const st = state(bot)
    const d = st.death && Date.now() - st.death.t < 120000 ? st.death : {}
    const pos = (info && info.pos) || d.pos
    const t = (info && info.t) || d.t || Date.now()
    const dim = d.dim || (info && String(info.dim || '').replace(/^minecraft:/, '')) || 'overworld'
    const inv = (info && info.inv) || {}
    const v = value(inv)
    const rec = { pos, t, dim, inv, value: v.score, job: info && info.job, done: false, said: false }
    st.want = null
    const skip = why => { core.log(bot, 'recover_skipped', { at: pos || null, why, lost: lost(inv), top: top(inv), lostValue: v.score }); return null }
    if (pos) st.hist = (st.hist || []).filter(h => Date.now() - h.t < 3 * KILL_ZONE_MS).concat([{ t, pos }])
    if (!pos) return skip('the death position was not recorded')
    if (!v.worth) { // an empty-pocket death is not news: no trip, and the report at most once per bot per 10 min (10 deaths/h would be pure noise)
      if (Date.now() - (st.poorT || 0) > 600000) { st.poorT = Date.now(); skip('not worth the trip (' + v.why + ', carried ' + top(inv) + ')') }
      return
    }
    if (dim !== 'overworld') return skip('died in ' + dim + ' (v1 recovers in the overworld only: the portal trip alone outlasts the 5-min despawn)')
    if (A.dimOf(bot) !== 'overworld') return skip('respawned in ' + A.dimOf(bot))
    const burn = d.burn || (st.msg && Date.now() - st.msg.t < 20000 && BURN_MSG.test(st.msg.line) ? st.msg.line.replace(bot.username + ' ', '') : null)
    if (burn) return skip('items burned: ' + burn)
    const ko = keepOutAt(A, pos)
    if (ko) return skip('death spot is inside keep-out ' + ko)
    if ((st.hist || []).some(h => h.t !== t && t - h.t < KILL_ZONE_MS && dist3(h.pos, pos) <= KILL_ZONE_R)) return skip('kill zone')
    st.want = rec
  },

  // 1 Hz, synchronous, arithmetic only: is the kit still reachable in the time that is left? The alert is re-raised every second (core.raise
  // de-duplicates) because runAlerts drops an alert older than 30 s and A.kitUp runs between onDeath and the first runAlerts.
  onTick (bot, core) {
    arm(bot)
    const st = state(bot); const rec = st.want
    if (!rec || rec.done || !bot.entity || bot.health <= 0 || bot.isSleeping || core.pending(bot)) return
    const left = rec.t + LIFETIME - Date.now()
    const me = bot.entity.position
    const d = dist3([me.x, me.y, me.z], rec.pos)
    if (d * 1000 / SPEED + MARGIN >= left) {
      rec.done = true; st.want = null
      core.log(bot, 'recover_skipped', { at: rec.pos, why: 'out of reach: ' + Math.round(d) + ' m away, ' + Math.max(0, Math.round(left / 1000)) + ' s before the drop despawns', lost: lost(rec.inv), top: top(rec.inv), lostValue: rec.value })
      return
    }
    if (bot.health < 14 || bot.food < 8) return // hurt or hungry: the meal reflex + regeneration have a few seconds, the reach test above gives up by itself
    core.raise(bot, { kind: 'drops', by: 'recover', prio: 70, ms: Math.min(Math.max(10000, left - 5000), 240000), data: { at: rec.pos } })
  },

  // THE TRIP. Read-only movement (A.travel with strictMovements), no fighting (combat.js outranks this alert), ONE attempt per death whatever happens.
  async handle (bot, alert, core) {
    const A = core.A; const st = state(bot); const rec = st.want
    if (!rec || rec.done) return
    rec.done = true; st.want = null // one attempt per death: a second walk to a spot that is empty (or that kills) is waste
    const t0 = Date.now()
    const deadline = rec.t + LIFETIME
    const pos = rec.pos
    const before = A.carried(bot)
    const took = () => Math.round((Date.now() - t0) / 1000)
    const fail = why => core.log(bot, 'recover_failed', { at: pos, why, lost: lost(rec.inv), top: top(rec.inv), lostValue: rec.value, tookS: took() })
    const stop = () => core.cancelled(bot) || bot.health < 8 || !!bot.__armyDied || Date.now() > deadline - 4000 // died AGAIN on the way: this trip is over, the new death gets its own decision
    try { bot.state.task = 'recover: ' + pos.join(',') } catch { /* no state on a bot that is going away */ }
    if (bot.food < 8) { try { await require('../lib/feed').eat(bot, {}) } catch (e) { /* nothing edible carried: the hp gate below decides */ } }
    if (bot.health < 14) return fail('hp ' + Math.round(bot.health) + ' < 14 at the start')

    const ms = Math.max(5000, deadline - ON_SITE / 2 - Date.now())
    const ok = await A.travel(bot, { x: pos[0], y: pos[1], z: pos[2] }, { range: 2, ms, stop, dim: 'overworld', _noOffload: true, quiet: true })
    const me = () => { const p = bot.entity.position; return dist3([p.x, p.y, p.z], pos) }
    if (bot.health < 8) return fail('hurt on the way (hp ' + Math.round(bot.health) + ')')
    if (core.cancelled(bot)) return fail('cancelled on the way')
    if (!ok && me() > 12) return fail('no route: stopped ' + Math.round(me()) + ' m short' + (Date.now() > deadline ? ' (too late anyway)' : ''))

    // ON SITE: the entity packets of the drop arrive a moment after the legs stop, and a stack lands a few blocks from where the bot fell —
    // so give the spot 5 empty passes (5 s) before calling it gone, and keep picking up while anything is in sight.
    const end = Math.min(deadline, Date.now() + ON_SITE)
    let dry = 0
    while (Date.now() < end && !core.cancelled(bot) && bot.health >= 8) {
      const seen = itemsNear(bot, 12)
      if (!seen) { if (++dry >= 5) break; await A.sleep(1000); continue }
      dry = 0
      await A.pickup(bot, 12, Math.min(7000, end - Date.now()))
    }
    await A.wear(bot).catch(() => { /* wear() swallows its own failures; the armour stays in the pockets and the next kitUp puts it on */ })

    const after = A.carried(bot)
    const got = {}
    for (const [k, n] of Object.entries(after)) { const g = n - (before[k] || 0); if (g > 0) got[k] = g }
    if (!Object.keys(got).length) return fail('nothing left at the spot (despawned, burned, or in another bot\'s pockets)')
    core.log(bot, 'recovered', { at: pos, items: got, lost: lost(rec.inv), back: lost(got), lostValue: rec.value, tookS: took() })
  }
}
