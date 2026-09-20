// jobs_enchant.js — P4 ENCHANTING: the army stops digging more rock and starts MULTIPLYING the ore it already breaks.
// EXTENSION MODULE (see the end of army_jobs.js): one verb `enchant`, one job type `enchant`. Nothing here drives a single bot by hand;
// every report states what was READ BACK from the item, never what was intended.
//
// WHY (owner 09-20: "エンチャント,工業化など鉄は様々な方法で産出できます"): 2580 raw iron in 20 h and every mine level y48..y-32 exhausted, iron
// 100/800. FORTUNE III gives x2.2 raw iron per ore block (and diamond/coal/lapis/redstone) — the same rock, twice the metal. We own the
// whole chain and used none of it: lapis 7038, diamonds 336, books 22, 15 bookshelves already standing.
//
// THE ROOM (blueprint `enchant_room`, zone row in docs/WORLD.md): table + 15 bookshelves in the 5x5 ring, the 8 cells between them AIR,
// one ring cell left as a lit door gap. Verified live on Paper 26.2 through ViaBackwards: the third offer asks exactly 30 levels = power 15.
//
// THE WINDOW ON 26.1 (all four unknowns measured 09-20 15:5xZ, Karin at -344,69,-517):
//   • `bot.openEnchantmentTable(block)` works — the window type is `minecraft:enchantment`, and mineflayer's assert tests the PREFIX
//     `minecraft:enchant`, so it passes. 38 slots, inventory part starts at 2 (0 = the item, 1 = the lapis).
//   • the hints arrive: ViaBackwards translates the container-property packet (mineflayer calls it `craft_progress_bar`), so
//     `win.enchantments[i] = {level: <cost shown>, expected: {enchant: <registry id>, level: <roman numeral>}}` and `win.xpseed` fill in.
//     `level` stays 0 until an ITEM is in slot 0 — that, not a timer, is what "the offers are ready" means.
//   • the id in the hint indexes `bot.registry.enchantmentsArray` (40 = unbreaking, 13 = fortune, 8 = efficiency).
//   • the RESULT is read back from the item: on 26.1 `item.enchants` is `{enchantments:[{id,level}]}` (not the old array) and the same
//     data sits in `item.components` as `{type:'enchantments'}`. Both are read here; a rename breaks neither.
//   • COST (vanilla, confirmed: 19 -> 18 levels, 32 -> 31 lapis on a slot-1 click): the offer NUMBER is the level you must HAVE; the
//     click costs slot+1 levels and slot+1 lapis. So a bot needs >= 30 levels for the third offer and pays only 3 of them.
//   • a successful enchant RESEEDS the player's enchantment seed — that is the player's re-roll: burn a book (or a stone tool) in slot 1
//     for 1 level + 1 lapis and the three offers for the real item are new.
//
// THE VERB  {do:'enchant', item:'diamond_pickaxe', want:['fortune'], minLevel:30, rerolls:5, at:[x,y,z], settle:false}
//   opens the table, puts item + lapis, READS the three offers, takes the third only when the bot has >= minLevel levels and the hint is
//   in `want` (or blind when `want` is empty), re-rolls with a throw-away otherwise, and reports `enchanted {item,got,levelsSpent,rerolls}`
//   with `got` read back off the item. Books are valid items (Fortune books for the anvil later). `slot:1|2|3` (default 3) picks the offer:
//   the third is the only one worth a diamond pick, but offer 1 costs 1 level + 1 lapis and is how a player enchants BOOKS in bulk.
// THE JOB  type `enchant` — params: {at, minLevel:30, items:['diamond_pickaxe','iron_pickaxe'], want:['fortune'], avoid:['silk_touch',…],
//   rerolls:5, throwaway:'book', lapis:8, issue:'tools'|'keep', settle:false, everyMs}. It picks bots that HAVE the levels (a bot under
//   minLevel declines in one tick and says its level, so the board can SEE the XP supply: `enchant_no_xp {level,need}`), draws a pickaxe
//   from the depot, enchants towards Fortune and ISSUES the pick — to the TOOLS chest, where `kitUp`'s fair-share rule hands the best
//   pickaxe to the risk jobs (the mine) first, or straight into the pockets of a bot that already carries mining kit (`issue:'keep'`).
// EVENTS: enchanted · enchant_pass · enchant_reroll · enchant_failed · enchant_no_xp · enchant_issued · enchant_no_table
//
// WHAT THIS FILE MUST NOT DO: no /enchant, no /xp, no /give (levels are earned by mining ore and emptying furnaces), no new state file,
// no new daemon, no second implementation of travel/obtain/bank.
module.exports = ctx => {
  const { A, U, muster, task, swallow } = ctx
  const { Vec3 } = require('vec3')
  const sleep = A.sleep
  const v = p => Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z)
  const xyz = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  const msg = e => String((e && e.message) || e).slice(0, 90)
  const DEFAULT_AVOID = ['silk_touch', 'binding_curse', 'vanishing_curse'] // silk touch EXCLUDES fortune: on a miner's pick it halves the yield

  // ---------------------------------------------------------------- reading the world back
  // the hint carries a registry id; `enchantmentsArray` is indexed by it, but never trust an index blindly
  function enchName (bot, id) {
    if (id == null || id < 0) return null
    try {
      const arr = bot.registry.enchantmentsArray || []
      const e = (arr[id] && arr[id].id === id) ? arr[id] : arr.find(q => q && q.id === id)
      if (e && e.name) return String(e.name).replace(/^minecraft:/, '')
    } catch (e_) { swallow('jobs_enchant:enchName', e_) }
    return 'id' + id
  }
  // WHAT ACTUALLY SITS ON THE ITEM (26.1: `item.enchants` = {enchantments:[{id,level}]}, plus the same under components).
  // A BOOK IS NOT A TOOL: enchanting a `book` turns it into an `enchanted_book` whose enchantments live under the
  // `stored_enchantments` component (measured 09-20: the re-roll's byproduct read back as "no enchantment" until this was added).
  function enchantsOf (bot, it) {
    if (!it) return []
    let raw = null
    try { raw = it.enchants } catch (e_) { swallow('jobs_enchant:enchants', e_) }
    if (raw && !Array.isArray(raw) && Array.isArray(raw.enchantments)) raw = raw.enchantments
    if (!Array.isArray(raw) || !raw.length) {
      try {
        const c = (it.components || []).find(q => q && /^(minecraft:)?(stored_)?enchantments$/.test(String(q.type)))
        if (c && c.data && Array.isArray(c.data.enchantments)) raw = c.data.enchantments
        else if (c && Array.isArray(c.data)) raw = c.data
      } catch (e_) { swallow('jobs_enchant:components', e_) }
    }
    if (!Array.isArray(raw)) return []
    return raw.map(e => ({
      name: typeof e.id === 'string' ? String(e.id).replace(/^minecraft:/, '') : enchName(bot, e.id),
      lvl: e.level || e.lvl || e.amplifier || 1
    })).filter(e => e.name)
  }
  const plain = (bot, it) => !!it && !enchantsOf(bot, it).length
  const carried = (bot, name, onlyPlain) => bot.inventory.items().filter(i => i.name === name && (!onlyPlain || plain(bot, i)))[0] || null

  // ---------------------------------------------------------------- the table
  function tableAt (bot, P) {
    const S = A.settings()
    const p = (P && P.at) || S.enchantTable
    if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) return v(p)
    const b = bot.findBlock ? bot.findBlock({ matching: q => q && q.name === 'enchanting_table', maxDistance: 48 }) : null
    return b ? b.position : null
  }
  const offersReady = t => t.enchantments.every(e => e && e.level > 0) // 0 = no item in slot 0 yet; a timer would lie
  async function waitOffers (t, ms) {
    const end = Date.now() + (ms || 5000)
    while (Date.now() < end && !offersReady(t)) await sleep(200)
    return offersReady(t)
  }
  const readOffers = (bot, t) => t.enchantments.map((e, i) => ({ i, cost: e.level, hint: enchName(bot, e.expected.enchant), hintLvl: e.expected.level }))
  // slot 0 of the window holds whatever is on the table right now
  async function clearTarget (t) {
    if (!t.slots[0]) return true
    try { await U.withTimeout(t.takeTargetItem(), 6000, 'takeTarget'); await sleep(350); return !t.slots[0] } catch (e_) { swallow('jobs_enchant:takeTarget', e_); return false }
  }
  async function putTarget (t, name) {
    const it = t.items().find(i => i.name === name)
    if (!it) return false
    try { await U.withTimeout(t.putTargetItem(it), 6000, 'putTarget'); await sleep(400) } catch (e_) { swallow('jobs_enchant:putTarget', e_) }
    return !!t.slots[0] && t.slots[0].name === name
  }

  // ---------------------------------------------------------------- THE VERB
  // returns true, or a STRING saying what stopped it (the steps contract)
  async function enchantVerb (bot, st, api, job) {
    const stop = () => (api && api.stop && api.stop()) || U.cancelled(bot)
    const name = String(st.item || 'diamond_pickaxe')
    const want = (Array.isArray(st.want) ? st.want : st.want ? [st.want] : []).map(s => String(s).replace(/^minecraft:/, ''))
    const avoid = Array.isArray(st.avoid) ? st.avoid : DEFAULT_AVOID
    const minLevel = st.minLevel == null ? 30 : Math.max(1, +st.minLevel)
    const maxRerolls = st.rerolls == null ? 5 : Math.max(0, Math.min(8, +st.rerolls))
    const slotIx = Math.max(0, Math.min(2, (st.slot == null ? 3 : +st.slot) - 1)) // 0-based: the third offer is the only one worth a diamond pick
    const throwaway = String(st.throwaway || 'book')
    const jid = (job && job.id) || (st.job || 'enchant')

    const pos = tableAt(bot, st)
    if (!pos) { A.result(bot, { ev: 'enchant_no_table', job: jid, why: 'no settings.enchantTable and no enchanting table within 48' }); return 'no enchanting table (register it: armyctl.js patch-settings enchantTable)' }
    if (bot.experience.level < minLevel) return 'level ' + bot.experience.level + '/' + minLevel + ' — not enough experience for offer ' + (slotIx + 1)

    // the item, the lapis and the re-roll fodder come from the depot BEFORE the walk to the table (one trip, like a player)
    if (!carried(bot, name, true)) {
      task(bot, 'enchant: fetching ' + name)
      await A.obtain(bot, name, A.count(bot, name) + 1, { stop }).catch(e_ => swallow('jobs_enchant:obtainItem', e_))
      if (!carried(bot, name, true)) return 'no unenchanted ' + name + ' carried and none in the depot (stock ' + A.stockOf(name) + ')'
    }
    const needLapis = (slotIx + 1) + maxRerolls + 2
    if (A.count(bot, 'lapis_lazuli') < needLapis) {
      task(bot, 'enchant: fetching lapis')
      await A.obtain(bot, 'lapis_lazuli', needLapis, { stop }).catch(e_ => swallow('jobs_enchant:obtainLapis', e_))
    }
    if (A.count(bot, 'lapis_lazuli') < 1) return 'no lapis_lazuli (depot stock ' + A.stockOf('lapis_lazuli') + ')'
    let fodder = null
    if (maxRerolls > 0 && want.length) {
      for (const k of [throwaway, 'book', 'stone_pickaxe', 'stone_shovel']) {
        if (A.count(bot, k) > 0 || (A.stockOf(k) > 0 && await A.obtain(bot, k, Math.min(maxRerolls, 4), { stop }).catch(() => false))) { if (A.count(bot, k) > 0) { fodder = k; break } }
      }
    }

    task(bot, 'enchant: walking to the table')
    if (!await A.travel(bot, pos, { range: 3, ms: 120000, stop })) return 'no route to the enchanting table at ' + xyz(pos)
    const b = bot.blockAt(pos)
    if (!b || b.name !== 'enchanting_table') { A.result(bot, { ev: 'enchant_no_table', job: jid, at: xyz(pos), found: b ? b.name : 'unloaded' }); return 'no enchanting table at ' + xyz(pos) + (b ? ' (found ' + b.name + ')' : '') }

    let t = null
    try { await bot.lookAt(pos.offset(0.5, 0.6, 0.5), true) } catch (e_) { swallow('jobs_enchant:lookAt', e_) }
    try { t = await U.withTimeout(bot.openEnchantmentTable(b), 10000, 'openEnch') } catch (e) { A.result(bot, { ev: 'enchant_failed', job: jid, why: 'open: ' + msg(e) }); return 'could not open the table: ' + msg(e) }

    const lvl0 = bot.experience.level
    let rerolls = 0
    let out = null
    let why = 'no acceptable offer'
    try {
      // the lapis goes in ONCE and stays: every click takes slot+1 out of the stack
      const lap = t.items().find(i => i.name === 'lapis_lazuli')
      if (lap) { try { await U.withTimeout(t.putLapis(lap), 6000, 'putLapis'); await sleep(400) } catch (e_) { swallow('jobs_enchant:putLapis', e_) } }
      if (!t.slots[1]) { why = 'the lapis did not reach the table'; throw new Error(why) }

      for (let round = 0; round <= maxRerolls && !stop(); round++) {
        if (!t.slots[0] || t.slots[0].name !== name) { await clearTarget(t); if (!await putTarget(t, name)) { why = 'the ' + name + ' did not reach the table'; break } }
        if (!await waitOffers(t, 6000)) { why = 'the table sent no offers in 6 s (cost ' + t.enchantments.map(e => e.level).join('/') + ')'; break }
        const off = readOffers(bot, t)
        const top = off[slotIx]
        const lvl = bot.experience.level
        const ok = lvl >= Math.max(minLevel, top.cost)
        const wanted = !want.length || want.includes(top.hint)
        const bad = avoid.includes(top.hint)
        const last = round === maxRerolls || !fodder || lvl - 1 < Math.max(minLevel, slotIx + 1)
        const take = ok && !bad && (wanted || (st.settle && last))
        A.result(bot, { ev: take ? 'enchant_offer_taken' : 'enchant_offer', job: jid, item: name, level: lvl, offers: off.map(o => o.cost + ':' + o.hint + (o.hintLvl > 0 ? ' ' + o.hintLvl : '')), round })
        if (take) {
          try { await U.withTimeout(t.enchant(slotIx), 12000, 'enchantClick') } catch (e) { why = 'the click was refused: ' + msg(e); break }
          await sleep(900)
          const got = enchantsOf(bot, t.slots[0])
          out = { item: name, got, levelsSpent: lvl0 - bot.experience.level, rerolls, cost: top.cost, hint: top.hint }
          if (!got.length) { why = 'the table took ' + out.levelsSpent + ' levels and the item came back with NO enchantment'; out = null }
          break
        }
        if (!ok) { why = 'offer ' + (slotIx + 1) + ' asks ' + top.cost + ' levels, the bot has ' + lvl; break }
        if (last) { why = 'hint ' + top.hint + ' is not in [' + want.join(',') + '] and no re-roll is left (level ' + lvl + ', fodder ' + (fodder || 'none') + ')'; break }
        // RE-ROLL THE WAY A PLAYER DOES: burn one throw-away in offer 1 (1 level + 1 lapis) — the successful enchant reseeds the offers
        if (!await clearTarget(t)) { why = 'could not take the ' + name + ' back off the table'; break }
        if (!await putTarget(t, fodder)) { why = 'the re-roll fodder (' + fodder + ') did not reach the table'; break }
        if (!await waitOffers(t, 6000)) { why = 're-roll: the table sent no offers for the ' + fodder; break }
        if (bot.experience.level < Math.max(1, t.enchantments[0].level)) { why = 're-roll needs ' + t.enchantments[0].level + ' levels, the bot has ' + bot.experience.level; break }
        const seed0 = t.xpseed
        try { await U.withTimeout(t.enchant(0), 12000, 'rerollClick') } catch (e) { why = 're-roll refused: ' + msg(e); break }
        await sleep(900)
        rerolls++
        A.result(bot, { ev: 'enchant_reroll', job: jid, n: rerolls, burnt: fodder, got: enchantsOf(bot, t.slots[0]).map(e => e.name + ' ' + e.lvl), seedChanged: t.xpseed !== seed0, level: bot.experience.level })
        await clearTarget(t)
        if (A.count(bot, fodder) < 1 && !t.items().some(i => i.name === fodder)) fodder = null
      }
    } catch (e) { if (!/^(the lapis did not)/.test(msg(e))) swallow('jobs_enchant:table', e) } finally {
      await clearTarget(t).catch(e_ => swallow('jobs_enchant:finalTake', e_))
      A.closeWin(t)
      await sleep(600) // closing hands slot 0 and the rest of the lapis back to the inventory (verified)
    }

    if (!out) { A.result(bot, { ev: 'enchant_pass', job: jid, item: name, level: bot.experience.level, rerolls, spent: lvl0 - bot.experience.level, why }); return 'no enchant: ' + why }
    // READ IT BACK OFF THE ITEM IN THE POCKETS, not off the window
    const outName = name === 'book' ? 'enchanted_book' : name // an enchanted book is a DIFFERENT item, so look for what the table actually handed back
    const mine = bot.inventory.items().filter(i => i.name === outName || i.name === name).map(i => ({ i, e: enchantsOf(bot, i) })).filter(q => q.e.length).sort((a, b) => b.e.length - a.e.length)[0]
    if (mine) { out.got = mine.e; out.item = mine.i.name }
    A.result(bot, { ev: 'enchanted', job: jid, item: out.item, got: out.got.map(e => ({ name: e.name, lvl: e.lvl })), levelsSpent: out.levelsSpent, rerolls: out.rerolls, cost: out.cost, level: bot.experience.level })
    bot.__armyEnchanted = { item: out.item, got: out.got, t: Date.now() }
    return true
  }

  // ---------------------------------------------------------------- THE JOB
  async function enchantJob (bot, job, api, ctx2) {
    const P = job.params || {}
    const minLevel = P.minLevel == null ? 30 : Math.max(1, +P.minLevel)
    const lvl = bot.experience.level
    // DECLINE FAST AND SAY THE LEVEL: the board cannot see experience (it is not in the heartbeat), so every pass of this job
    // publishes one bot's level. That is the honest measurement of the XP supply, not a guess.
    if (lvl < minLevel) {
      const gap = minLevel - lvl
      const mins = Math.max(10, Math.min(60, gap * 2))
      const seen = bot.__armyEnchXp || 0
      if (Date.now() - seen > 1800000) { bot.__armyEnchXp = Date.now(); A.result(bot, { ev: 'enchant_no_xp', job: job.id, level: lvl, need: minLevel, why: 'offer 3 needs ' + minLevel + ' levels; ore XP (coal/lapis/diamond) and emptying furnaces are what feed it' }) }
      // NOBODY IDLES AND NOBODY CHURNS: a job no bot in the army can do must not keep taking bots off the board to decline. The tally of
      // who tried and with how many levels lives on the JOB, and after `tries` different bots it pauses itself with the best level seen -
      // that note IS the measurement of the XP supply an operator acts on (re-activate when a bot reaches minLevel).
      A.boardEdit(b => {
        const j = (b.jobs || []).find(q => q.id === job.id); if (!j || j.status !== 'active') return
        const s = j.xpSeen = (j.xpSeen && Date.now() - (j.xpSeen.t0 || 0) < 3600000) ? j.xpSeen : { t0: Date.now(), n: {} }
        s.n[bot.username] = lvl
        const names = Object.keys(s.n); const best = Math.max.apply(null, Object.values(s.n))
        if (names.length >= (P.tries || 12)) { j.status = 'paused'; j.note = 'auto-paused ' + new Date().toISOString().slice(11, 16) + 'Z: ' + names.length + ' bots tried, best level ' + best + '/' + minLevel + ' - EXPERIENCE is the bottleneck, not the table. Re-activate when a bot reaches ' + minLevel + '.' }
      })
      A.decline(bot, job, mins * 60000, 'level ' + lvl + '/' + minLevel)
      return muster(bot, job, api, ctx2, 'enchant: level ' + lvl + '/' + minLevel + ' — not enough experience')
    }
    const items = Array.isArray(P.items) && P.items.length ? P.items : ['diamond_pickaxe', 'iron_pickaxe']
    let name = items.find(n => carried(bot, n, true))
    if (!name) name = items.find(n => A.stockOf(n) > 0)
    if (!name) { A.decline(bot, job, 20 * 60000, 'no plain pickaxe in stock'); return muster(bot, job, api, ctx2, 'enchant: no unenchanted ' + items.join('/') + ' carried or in the depot') }

    const r = await enchantVerb(bot, {
      item: name, at: P.at, minLevel, want: P.want || ['fortune'], avoid: P.avoid, rerolls: P.rerolls,
      throwaway: P.throwaway, settle: P.settle === true, slot: P.slot
    }, api, job)
    if (r !== true) {
      // nothing achieved: rest the JOB (not the bot) so a hopeless offer stream cannot burn the whole army's levels
      A.decline(bot, job, (P.restMin || 20) * 60000, String(r).slice(0, 70))
      return 'enchant: ' + r
    }

    // ISSUE IT. `keep` = the bot walks away with it (it is a miner and the pick is already in its hand).
    // Default: the TOOLS chest — kitUp's fair share hands the best pickaxe to the risk jobs (the mine) first, so that is where a
    // Fortune pick reaches a miner without anybody assigning it by hand.
    const got = (bot.__armyEnchanted || {}).got || []
    if (P.issue === 'keep') { A.result(bot, { ev: 'enchant_issued', job: job.id, item: name, to: 'pockets', got: got.map(e => e.name + ' ' + e.lvl) }); return 'enchant: ' + name + ' ' + got.map(e => e.name + ' ' + e.lvl).join('+') + ' kept' }
    const it = bot.inventory.items().filter(i => (i.name === name || i.name === 'enchanted_book') && enchantsOf(bot, i).length)[0]
    const chest = A.chestsOf('tools')[0]
    if (!it || !chest) { A.result(bot, { ev: 'enchant_issued', job: job.id, item: name, to: 'pockets', why: chest ? 'the enchanted item left the pockets' : 'no tools chest registered', got: got.map(e => e.name + ' ' + e.lvl) }); return 'enchant: done, kept in the pockets' }
    task(bot, 'enchant: banking the ' + name + ' in the tools chest')
    const w = await A.openChest(bot, chest, { stop: api.stop })
    let banked = false
    if (w) {
      try { await U.withTimeout(w.deposit(it.type, null, 1), 8000, 'depositEnch'); banked = true } catch (e_) { swallow('jobs_enchant:deposit', e_) }
      A.closeWin(w)
    }
    A.result(bot, { ev: 'enchant_issued', job: job.id, item: name, to: banked ? 'tools chest ' + xyz(chest) : 'pockets (the chest refused it)', got: got.map(e => e.name + ' ' + e.lvl) })
    return 'enchant: ' + name + ' ' + got.map(e => e.name + ' ' + e.lvl).join('+') + (banked ? ' banked in the tools chest' : ' kept')
  }

  return { types: { enchant: enchantJob }, verbs: { enchant: enchantVerb } }
}
module.exports.TYPES = ['enchant']
module.exports.VERBS = ['enchant']
