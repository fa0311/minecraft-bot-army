// feed.js — EATING (the one implementation; the worker calls eat() between job slices, jobs call it on long tasks).
// PLAYBOOK eat rule: hurt -> keep food >= 18 so regen runs; healthy -> only when the item fits without waste; best saturation first; raw
// meat/fish only at food <= 6 (or opts.rawOk), rotten flesh only at food <= 3; never while a hostile is within 8 blocks unless starving.
// Where food COMES from is the board's business (canteen in army_jobs.js, FOOD chests in settings.chests): nothing here walks anywhere.
const U = require('./util')
const swallow = require('./swallow')

const TOXIC = new Set(['spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const RAW = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'tropical_fish', 'potato'])
const KEEP_FOR_CRAFT = new Set(['golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'cake', 'pumpkin_pie', 'honey_bottle'])

// ---------------------------------------------------------------- food knowledge
function foodInfo (bot, name) { return bot.registry.foodsByName[name] || null }
function isEdible (bot, name, allowRaw, allowRotten) {
  const f = foodInfo(bot, name)
  if (!f || TOXIC.has(name) || KEEP_FOR_CRAFT.has(name)) return false
  if (name === 'rotten_flesh') return !!allowRotten
  if (RAW.has(name)) return !!allowRaw
  return true
}
function edibleItems (bot, allowRaw, allowRotten) {
  return bot.inventory.items().filter(i => isEdible(bot, i.name, allowRaw, allowRotten))
}
function edibleCount (bot, allowRaw) { return edibleItems(bot, allowRaw, false).reduce((s, i) => s + i.count, 0) }
function sat (bot, name) { const f = foodInfo(bot, name); return f ? (f.saturation || 0) : 0 }
function pts (bot, name) { const f = foodInfo(bot, name); return f ? (f.foodPoints || 0) : 0 }
function hostileNear (bot, r) {
  const me = bot.entity.position
  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (!e || !e.position || !U.HOSTILE.has(e.name)) continue
    if (e.position.distanceTo(me) <= r) return true
  }
  return false
}

// ---------------------------------------------------------------- 1. eat
// PLAYBOOK §3 eat rule. Returns number of items eaten.
// ONE MEAL AT A TIME (09-20 11:3xZ: `Consuming cancelled due to calling bot.consume() again` 75/h - the worker's between-slice meal and army.js mealReflex ate at once)
async function eat (bot, opts = {}) {
  if (!bot.entity || bot.food == null || bot.__feedBusy) return 0
  bot.__feedBusy = true
  try { return await eat1(bot, opts) } finally { bot.__feedBusy = false }
}
async function eat1 (bot, opts = {}) {
  let eaten = 0
  for (let n = 0; n < 4; n++) {
    const food = bot.food
    const hurt = (bot.health != null && bot.health < 20)
    if (food >= 20) break
    const starving = food <= 6
    if (!starving && hostileNear(bot, 8)) break
    let items = edibleItems(bot, false, false)
    if (!items.length && (starving || opts.rawOk)) items = edibleItems(bot, true, false)
    if (!items.length && food <= 3) items = edibleItems(bot, true, true)
    if (!items.length) break
    // hurt: keep the bar >= 18 so natural regen runs. healthy: no waste.
    const room = 20 - food
    let pick = null
    if (hurt && food <= 17) {
      items.sort((a, b) => sat(bot, b.name) - sat(bot, a.name))
      // do not burn a steak to fill 2 points if something smaller is there
      pick = items.find(i => pts(bot, i.name) <= room + 2) || items[0]
    } else if (!hurt || food <= 17) {
      const fit = items.filter(i => pts(bot, i.name) <= room)
      fit.sort((a, b) => sat(bot, b.name) - sat(bot, a.name))
      pick = fit[0] || (food <= (opts.forceBelow != null ? opts.forceBelow : 10) ? items.sort((a, b) => pts(bot, a.name) - pts(bot, b.name))[0] : null)
    }
    if (!pick) break
    try {
      await U.withTimeout(bot.equip(pick, 'hand'), 5000, 'equipFood')
      await U.withTimeout(bot.consume(), 6000, 'eat')
      eaten++
    } catch (e_) { swallow('feed:eat', e_); break } // interrupted (hit, hand taken by a reflex): next slice tries again
    await U.sleep(150)
  }
  return eaten
}

module.exports = { eat, edibleCount, edibleItems, isEdible }
