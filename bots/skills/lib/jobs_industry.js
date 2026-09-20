// jobs_industry.js — INDUSTRY stage 1: a staffed VILLAGE OUTPOST that turns the army's GLUT into what it LACKS.
// EXTENSION MODULE (see the end of army_jobs.js): one job type, `trade`, and one verb, `collect_farm`. Nothing here drives a
// single bot by hand — it is an ordinary board job on ordinary primitives (A.travel, A.withdraw, A.bank, A.kitUp), and every
// number reported is READ BACK from the world or from a container window, never what was intended.
//
// WHY THIS EXISTS (owner 09-20 "工業化しないのか？ / 在庫の有効活用はしないのか？"): iron is the bottleneck (620 ingots of armour
// missing, depot iron ~24) while the depot rots under 17 828 wheat, 10 328 wool, 2 995 sugar cane, 1 876 coal. A plains village
// 624 blocks SW buys exactly that glut for emeralds and SELLS iron armour and tools. One trader is worth several miners.
//
// THE JOB (type `trade`, params):
//   work:'survey'  walk to `at`, LOOK, and write what stands there to settings.industry.village (villagers + professions + beds +
//                  workstations + golems + bounds). Read-only; the one thing that must run before anything is built or traded.
//   work:'post'    MAKE THE BUYERS: craft the workstations this village lacks at the depot, carry them out and place them beside
//                  the villagers (`params.cells:[{block,at:[x,y,z]}]`, coordinates probed with `armyctl.js ground`). An
//                  unemployed villager claims the nearest unclaimed station, so a loom makes a shepherd who buys our wool and a
//                  blast furnace makes an armorer who sells us iron armour. Nothing that already stands is touched.
//   work:'breed'   MORE VILLAGERS: throw bread at every adult (3 loaves make one willing) so pairs breed into the free beds.
//                  The village had 9 villagers and 1 unemployed, so four of our new workstations could never be claimed.
//   work:'librarian' RE-ROLL THE BOOK: read the librarian's enchanted-book offer and, while he has never traded, break OUR
//                  lectern and put it straight back until the book is one of `want` (fortune/mending/unbreaking/efficiency);
//                  then BUY it, which locks it for ever. The way round the XP wall: book + tool on an anvil costs a few levels.
//   work:'trade'   (default) the standing round trip: load the glut at the depot -> walk to the village -> sell to every villager
//                  that buys what we carry -> buy what the army lacks with the emeralds -> walk home -> bank. `shiftMin` keeps the
//                  bot on the job across 15-min slices; the phase lives on the bot (bot.__industry), so a slice boundary costs nothing.
//   at:[x,y,z]     the village rally point (default settings.industry.village)         radius:48   how far villagers are looked for
//   sell:[{item,n}]  what to carry out (default: SELL below, capped by the depot reserve so the army never sells its own supply)
//   buy:[{re,want}]  what to bring back, in priority order (default: BUY below — iron armour first)
//   maxPrice:20    never pay more than this many emeralds for one item (an enchanted book can ask 64)
//   siteChest:[x,y,z]  a WORK-SITE chest at the village (A.stash/A.unstash, so it never enters the depot's chest index):
//                  topped up from on arrival, and whatever did not sell is left in it instead of walking 1 250 blocks
//   purse:448      emeralds carried out as working capital — big enough to buy an armorer's whole armour stock in one visit
//   farmChest:[x,y,z]  the iron farm's collection chest; emptied on every visit (see the verb `collect_farm`)
// VERBS (usable in any `steps` plan): collect_farm {at:[x,y,z]} — empty the farm chest and MEASURE the yield per hour
//   · anvil {item:'diamond_pickaxe', with:'enchanted_book', at:[x,y,z]} — combine them on an anvil (31 iron) and read the
//   result back off the tool. EVENTS: + breed_fed · book_offer · book_locked · book_locked_bad · trade_price · anvil_done
//   (settings.industry.farm keeps the last emptying's time + total, so the rate is a measurement, not a guess).
// EVENTS: village_seen · trade_offer (what a profession really buys/sells here) · trade_done {villager,sold,bought,emeralds} ·
//   trade_none · trade_blocked (restock/locked) · iron_farm_take {items,iron,perHour}
//
// PAPER + REDSTONE: every design of this front is REDSTONE-FREE (owner 09-20: Paper's redstone is not vanilla's). Villager
// trading itself only needs a villager within reach. Paper's `entity-activation-range: villagers 32` means a villager barely
// ticks unless a player stands within 32 blocks — restock and golem spawning therefore need the standing traders, not merely a
// loaded chunk. See docs/INDUSTRY.md.
//
// WHAT THIS FILE MUST NOT DO: no cheats, no new state file or daemon (settings.industry only), never hit a villager, never trade
// with mobs near (the combat module owns mobs), never sell what the army still needs (the reserve below).
const { Vec3 } = require('vec3')

module.exports = ctx => {
  const { A, U, muster, task, swallow } = ctx
  const sleep = A.sleep
  const v = p => Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z)
  const xyz = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]

  // settings.industry is written by the bots themselves, so it is read FRESH (A.settings() caches for 5 s — the nether module
  // paid for that lesson with a scout that crossed its own gate twice).
  const industryOf = () => {
    try { return ((A.readJSON(A.F.board, {}) || {}).settings || {}).industry || {} } catch (e_) { swallow('jobs_industry:industryOf', e_); return A.settings().industry || {} }
  }
  const industryEdit = patch => A.boardEdit(b => { const S = b.settings = b.settings || {}; S.industry = Object.assign({}, S.industry || {}, patch) })

  // EAT ON THE ROAD. This front's legs are 624 blocks at a sprint and the handler owns the bot for the whole of them; the
  // canteen in withHandover only runs at a slice start near the depot. Measured 16:35Z: Tamaki reached hp 1 / food 0 with 6 iron
  // axes and 24 emeralds in her pockets, four loaves in hand and nothing calling eat(). Called at every phase boundary.
  async function nibble (bot) {
    try { if (bot.food < 18) await U.withTimeout(require('./feed').eat(bot, { rawOk: true }), 15000, 'tradeEat') } catch (e_) { swallow('jobs_industry:nibble', e_) }
  }

  // ---------------------------------------------------------------- what we sell and what we buy
  // reserve = what stays in the depot whatever happens. Glut above the reserve is dead weight; below it, it is the army's supply.
  // n = how much one trip carries (16 uses of the vanilla trade, which is about one restock cycle of one villager).
  const SELL = [
    { item: 'wheat', reserve: 4000, n: 320 }, // farmer 20 -> 1 emerald
    { item: 'gray_wool', reserve: 64, n: 288 }, // shepherd 18 -> 1
    { item: 'light_gray_wool', reserve: 64, n: 288 },
    { item: 'black_wool', reserve: 64, n: 288 },
    { item: 'white_wool', reserve: 64, n: 288 },
    { item: 'brown_wool', reserve: 64, n: 288 },
    { item: 'paper', reserve: 96, n: 384 }, // librarian 24 -> 1 (the cane glut becomes paper at the depot table)
    { item: 'coal', reserve: 768, n: 240 }, // armorer/toolsmith/weaponsmith/fisherman 15 -> 1 — and it LEVELS the smiths we buy from
    { item: 'leather', reserve: 64, n: 96 }, // leatherworker 6 -> 1
    { item: 'rotten_flesh', reserve: 0, n: 256 } // cleric 32 -> 1
  ]
  // WHAT TO BUY, in priority order. `max` = the most of that kind one visit may take; the AMOUNT is always the army's real
  // deficit (`settings.targets` minus what stock.js counts), never a fixed number.
  // A BOUGHT TOOL IS NOT IRON (coordinator 09-20): smelting an iron tool gives ONE nugget, so an axe is worth ingots only while
  // the army is short of axes — and it holds 53 for 50 bots. The iron the army actually lacks is ARMOUR, shields, buckets and an
  // anvil, so buying stops at the target of each kind and the emeralds are HOARDED for the two things only trade can give:
  // the armorer's iron armour and the librarian's books.
  const IRON_COST = { iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4, iron_sword: 2, iron_pickaxe: 3, iron_axe: 3, iron_shovel: 1, iron_hoe: 2, shield: 1, bucket: 3, iron_ingot: 1 }
  const BUY = [
    { re: /^iron_(helmet|chestplate|leggings|boots)$/, max: 64, maxPrice: 12 }, // x50: one armorer visit should kit MANY bots
    { re: /^enchanted_book$/, max: 4, maxPrice: 64 }, // Fortune/Mending/Unbreaking: the only road round our XP wall
    { re: /^(chainmail_(helmet|chestplate|leggings|boots))$/, max: 16, maxPrice: 12 },
    { re: /^iron_(pickaxe|axe|shovel|sword)$/, max: 8, maxPrice: 6 },
    { re: /^(shield|bucket)$/, max: 8, maxPrice: 6 },
    { re: /^arrow$/, max: 128, maxPrice: 2 }
  ]

  // ---------------------------------------------------------------- reading the village back
  const WORKSTATION = {
    composter: 'farmer', barrel: 'fisherman', blast_furnace: 'armorer', smoker: 'butcher', cartography_table: 'cartographer', brewing_stand: 'cleric', cauldron: 'leatherworker', fletching_table: 'fletcher', grindstone: 'weaponsmith', lectern: 'librarian', loom: 'shepherd', smithing_table: 'toolsmith', stonecutter: 'mason'
  }
  const villagersNear = (bot, r) => Object.values(bot.entities)
    .filter(e => e && e.position && e.name === 'villager' && e.position.distanceTo(bot.entity.position) <= r)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  const golemsNear = (bot, r) => Object.values(bot.entities).filter(e => e && e.position && e.name === 'iron_golem' && e.position.distanceTo(bot.entity.position) <= r)
  // A SLEEPING VILLAGER HAS NO TRADE WINDOW: it is skipped, never poked (a poke is a hit, and 12 s of window timeout per villager
  // would burn a whole slice). The bed it lies in is in the `sleeping_pos` metadata the server sends.
  function isAsleep (bot, e) {
    try {
      const keys = ((bot.registry.entitiesByName || {}).villager || {}).metadataKeys || []
      const i = keys.indexOf('sleeping_pos')
      return i >= 0 && e.metadata && e.metadata[i] != null
    } catch (e_) { swallow('jobs_industry:isAsleep', e_); return false }
  }

  // The profession lives in the `villager_data` entity metadata; its wire shape differs between versions and ViaBackwards
  // translates it on the way down, so this NEVER guesses: it reads whatever is there and falls back to the trade window's
  // title, which the server writes itself. Unknown stays 'unknown' — a wrong label is worse than no label.
  function professionOf (bot, e) {
    try {
      const keys = ((bot.registry.entitiesByName || {}).villager || {}).metadataKeys || []
      const idx = keys.indexOf('villager_data')
      const raw = idx >= 0 && e.metadata ? e.metadata[idx] : null
      if (raw == null) return 'unknown'
      const p = raw.profession != null ? raw.profession : raw.villagerProfession != null ? raw.villagerProfession : Array.isArray(raw) ? raw[1] : null
      if (typeof p === 'string') return p.replace(/^minecraft:/, '')
      if (typeof p === 'number') return (VILLAGER_PROFESSIONS[p] || ('profession#' + p))
      return 'unknown'
    } catch (e_) { swallow('jobs_industry:professionOf', e_); return 'unknown' }
  }
  // vanilla registry order (1.14+); only used when the metadata carries a numeric id
  const VILLAGER_PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith']

  async function survey (bot, job, api, ctx2) {
    const P = job.params || {}
    const at = P.at || industryOf().village
    if (!Array.isArray(at)) return muster(bot, job, api, ctx2, 'trade survey: no params.at and no settings.industry.village')
    const r = P.radius || 48
    if (A.dist2(bot, at[0], at[2]) > 24) {
      task(bot, 'village: walking to ' + at.join(','))
      if (!await A.travel(bot, v(at), { range: 8, ms: 15 * 60000, stop: api.stop })) return 'village: no route to ' + at.join(',') + ' yet'
    }
    if (api.stop()) return 'village: arrived, surveying next slice'
    // THE SURVEYOR STAYS. Paper's `entity-activation-range: villagers 32` means villagers barely tick unless a player stands
    // near them, so the surveyor IS the village's presence for the rest of its slice; it re-measures every REDO ms and reports
    // only when the picture changed (the first version fired 15 identical reports in a minute, once per worker loop).
    let last = ''
    let lastT = 0
    while (!api.stop()) {
      await nibble(bot)
      const line = await surveyOnce(bot, job, at, r, Date.now() - lastT > 10 * 60000 || !last)
      if (line !== last || Date.now() - lastT > 10 * 60000) { last = line; lastT = Date.now() }
      task(bot, 'village: ' + line)
      // A PATROL, NOT A STATUE. Paper activates a villager only within 32 blocks of a player, and this village is 63x47, so one
      // standing spot leaves most of it frozen; walking the clusters keeps them ticking (and the army's hang watchdog rightly
      // counts a motionless bot with an unchanging inventory as hung).
      const stops = (industryOf().nearest || []).concat(villagersNear(bot, r).slice(0, 6).map(e => xyz(e.position)))
      const to = stops[Math.floor(Math.random() * stops.length)]
      if (to) await A.travel(bot, v(to), { range: 6, ms: 90000, stop: api.stop, quiet: true })
      else for (let i = 0; i < 20 && !api.stop(); i++) await sleep(3000)
    }
    return 'village: ' + last
  }

  async function surveyOnce (bot, job, at, r, report) {
    await sleep(4000) // let the chunks and their entities arrive before counting anything

    const vs = villagersNear(bot, r)
    const prof = {}
    for (const e of vs) { const p = professionOf(bot, e); prof[p] = (prof[p] || 0) + 1 }
    const beds = bot.findBlocks({ matching: b => !!b && /_bed$/.test(b.name), maxDistance: r, count: 256 })
    const stations = bot.findBlocks({ matching: b => !!b && WORKSTATION[b.name] != null, maxDistance: r, count: 128 })
    const stationKinds = {}
    for (const p of stations) { const b = bot.blockAt(p); if (b) stationKinds[b.name] = (stationKinds[b.name] || 0) + 1 }
    const golems = golemsNear(bot, r)
    // the village's bounds = the box its beds and workstations stand in (that is what the golem-spawn box follows, not the houses)
    const pts = beds.concat(stations)
    const bounds = pts.length ? [Math.min(...pts.map(p => p.x)), Math.min(...pts.map(p => p.z)), Math.max(...pts.map(p => p.x)), Math.max(...pts.map(p => p.z))] : null

    const me = xyz(bot.entity.position)
    const line = vs.length + ' villagers ' + JSON.stringify(prof) + ', ' + beds.length + ' beds, ' + JSON.stringify(stationKinds) + ', ' + golems.length + ' golems'
    if (report || line !== bot.__industrySurvey) {
      bot.__industrySurvey = line
      A.result(bot, {
        ev: 'village_seen',
        job: job.id,
        at: me,
        villagers: vs.length,
        professions: prof,
        beds: beds.length,
        stations: stationKinds,
        golems: golems.length,
        golemAt: golems.slice(0, 4).map(g => xyz(g.position)),
        bounds,
        nearest: vs.slice(0, 6).map(e => xyz(e.position))
      })
      industryEdit({ village: at, surveyed: Date.now(), villagers: vs.length, professions: prof, beds: beds.length, stations: stationKinds, golems: golems.length, bounds, nearest: vs.slice(0, 8).map(e => xyz(e.position)) })
    }
    return line
  }

  // ---------------------------------------------------------------- one trade window
  // THE OPEN WINDOW IS THE TRUTH, NEVER bot.inventory (docs/DEV.md §3, and measured here 15:16Z: Tamaki really sold 320 wheat for
  // 16 emeralds and this file reported `trade_none` and bought nothing, because `A.count` still read 0 emeralds while the villager
  // window was open). Every count taken between opening and closing a trade window goes through inWin().
  const inWin = (win, name) => { let n = 0; for (const i of win.items()) if (i.name === name) n += i.count; return n }

  // Reading an offer: mineflayer turns the packet into Items. `realPrice` already carries demand + reputation; a trade that the
  // server marks disabled or used up is SKIPPED, never retried (the villager restocks at its workstation by itself).
  function offerOf (t) {
    const in1 = t.inputItem1 || (t.inputs && t.inputs[0])
    const in2 = t.hasItem2 ? (t.inputItem2 || (t.inputs && t.inputs[1])) : null
    const out = t.outputItem || (t.outputs && t.outputs[0])
    if (!in1 || !out || !in1.name || !out.name) return null
    const left = Math.max(0, (t.maximumNbTradeUses || 0) - (t.nbTradeUses || 0))
    return {
      in1: in1.name,
      price: Math.max(1, t.realPrice || in1.count || 1),
      in2: in2 && in2.name ? in2.name : null,
      price2: in2 ? (in2.count || 1) : 0,
      out: out.name,
      outN: out.count || 1,
      outItem: out,
      used: t.nbTradeUses || 0,
      max: t.maximumNbTradeUses || 0,
      left: t.tradeDisabled ? 0 : left
    }
  }

  // WHICH enchantment a book carries. The id may arrive as a number (an index into `bot.registry.enchantmentsArray`, see
  // jobs_enchant.js) or as a string, and it sits in `components`, `enchants` or the nbt depending on the version and on what
  // ViaBackwards made of it — so this walks whatever is there for {id, level} pairs instead of trusting one shape.
  function enchantNames (bot, item) {
    const found = []
    const walk = (o, d) => {
      if (!o || typeof o !== 'object' || d > 6) return
      if (Array.isArray(o)) { for (const q of o) walk(q, d + 1); return }
      if (o.id != null && o.level != null) found.push([o.id, o.level])
      for (const k of Object.keys(o)) walk(o[k], d + 1)
    }
    try { walk(item && item.components, 0); walk(item && item.enchants, 0); walk(item && item.nbt, 0) } catch (e_) { swallow('jobs_industry:enchantNames', e_) }
    const out = []
    for (const [id, lvl] of found) {
      const e = typeof id === 'number' ? (bot.registry.enchantmentsArray || [])[id] : null
      const name = String(e ? e.name : id).replace(/^minecraft:/, '')
      out.push(name + (lvl > 1 ? ' ' + lvl : ''))
    }
    return [...new Set(out)]
  }

  // ONE villager: sell what it buys, then buy what we lack. Returns a summary; never throws, always closes the window.
  // `absorb` (optional) collects what this village could still take, per item, for the next trip's cargo size.
  async function dealWith (bot, ent, job, api, want, absorb) {
    const P = job.params || {}
    const maxPrice = P.maxPrice == null ? 20 : P.maxPrice
    if (!await A.travel(bot, ent.position, { range: 2, ms: 45000, stop: api.stop, quiet: true })) return { why: 'unreachable' }
    let win = null
    const sold = {}; const bought = {}
    const em0 = A.count(bot, 'emerald')
    try {
      try { await bot.lookAt(ent.position.offset(0, 1, 0), true) } catch (e_) { swallow('jobs_industry:lookAt', e_) }
      win = await U.withTimeout(bot.openVillager(ent), 12000, 'openVillager')
      // the offer list is re-read from the window before every decision: a finished trade changes `nbTradeUses` and the server
      // sends a fresh trade_list, so a list cached at the top of the visit goes stale halfway through it
      const offersNow = () => (win.trades || []).map(offerOf)
      const offers = offersNow()
      if (!offers.some(Boolean)) return { why: 'no offers' }
      // say ONCE per profession what this village really pays — the numbers in a wiki are not this server's numbers
      const key = offers.filter(Boolean).map(o => o.in1 + '->' + o.out).join(' ')
      if (!seenOffers.has(key)) {
        seenOffers.add(key)
        A.result(bot, { ev: 'trade_offer', job: job.id, at: xyz(ent.position), title: titleOf(win), offers: offers.filter(Boolean).map(o => (o.price + ' ' + o.in1 + (o.in2 ? ' + ' + o.price2 + ' ' + o.in2 : '') + ' -> ' + o.outN + ' ' + o.out + (o.left ? '' : ' [locked]'))) })
      }

      // WHAT THIS VILLAGER COULD STILL TAKE — measured before a single trade, so the next trip carries that much and no more
      if (absorb) for (const o of offers) if (o && o.out === 'emerald' && !o.in2 && o.left) absorb[o.in1] = (absorb[o.in1] || 0) + o.left * o.price

      // SELL: every offer that pays emeralds for something in our pockets, down to `tradeDisabled`
      for (let i = 0; i < offers.length; i++) {
        if (api.stop()) break
        const o = offersNow()[i]
        if (!o || o.out !== 'emerald' || o.in2 || !o.left) continue
        const n = Math.min(o.left, Math.floor(inWin(win, o.in1) / o.price))
        if (n <= 0) continue
        const got = await runTrade(bot, win, i, n)
        if (got > 0) { sold[o.in1] = (sold[o.in1] || 0) + got * o.price; await sleep(250) }
        // DEMAND: selling into one trade raises its price. Say so once per item per price, so the operator can see whether the
        // sales are spread widely enough (vanilla: the demand counter rises with every use and decays when the villager restocks).
        const after = offersNow()[i]
        if (after && after.price > o.price) {
          const k = o.in1 + '@' + after.price
          if (!seenPrice.has(k)) { seenPrice.add(k); A.result(bot, { ev: 'trade_price', job: job.id, item: o.in1, was: o.price, now: after.price, at: xyz(ent.position), why: 'demand rose while selling ' + got + ' lots to this villager - spread the next sales over more of them' }) }
        }
      }

      // BUY: priority order, only what we still want, only with emeralds we actually hold
      for (const b of want) {
        if (api.stop() || b.want <= 0) continue
        for (let i = 0; i < offers.length; i++) {
          const o = offersNow()[i]
          if (!o || !o.left || o.in1 !== 'emerald' || o.in2 || !b.re.test(o.out)) continue
          if (o.price > (b.maxPrice == null ? maxPrice : b.maxPrice)) continue
          const canPay = Math.floor(inWin(win, 'emerald') / o.price)
          const n = Math.min(o.left, canPay, Math.ceil(b.want / o.outN))
          if (n <= 0) continue
          const got = await runTrade(bot, win, i, n)
          if (got > 0) { bought[o.out] = (bought[o.out] || 0) + got * o.outN; b.want -= got * o.outN; await sleep(250) }
        }
      }
    } catch (e) {
      // capture the EXACT symptom: villager windows cross ViaBackwards and a workaround written blind would hide the cause
      A.result(bot, { ev: 'trade_blocked', job: job.id, at: xyz(ent.position), why: String(e && e.message || e).slice(0, 120) })
      return { sold, bought, why: 'error' }
    } finally {
      if (win) A.closeWin(win)
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e_) { swallow('jobs_industry:closeCur', e_) }
      // the NEXT openVillager fails with `timeout:openVillager` while this window is still open server-side (measured 15:16Z):
      // wait for the client to have no window before walking on
      for (let i = 0; i < 20 && bot.currentWindow; i++) await sleep(150)
    }
    // `dry` = this villager has nothing left for us and we nothing for him: the next pass of the visit skips him
    const dry = !Object.keys(sold).length && !Object.keys(bought).length
    return { sold, bought, dry, emeralds: A.count(bot, 'emerald') - em0 }
  }
  const seenOffers = new Set()
  const seenPrice = new Set()
  const titleOf = win => { const t = win && win.title; return typeof t === 'string' ? t.slice(0, 40) : JSON.stringify(t || null).slice(0, 80) }

  // Run one offer `n` times and report what the SERVER actually gave us (bot.trade resolves optimistically), counted on the
  // OPEN WINDOW — bot.inventory does not update until the window closes.
  async function runTrade (bot, win, index, n) {
    const t = (win.trades || [])[index]
    const out = t && (t.outputItem || (t.outputs && t.outputs[0]))
    if (!out || !out.name) return 0
    const before = inWin(win, out.name)
    try { await U.withTimeout(bot.trade(win, index, n), 20000, 'trade') } catch (e_) { swallow('jobs_industry:runTrade', e_) }
    for (let i = 0; i < 12 && inWin(win, out.name) <= before; i++) await sleep(150) // the window lags the server by a tick or two
    const gained = inWin(win, out.name) - before
    return Math.max(0, Math.round(gained / (out.count || 1)))
  }

  // ---------------------------------------------------------------- the round trip
  // CARRY WHAT THE VILLAGE CAN ABSORB, NOT A ROUND NUMBER. `settings.industry.absorb` is measured on every visit: for each thing
  // the village buys it is the sum over all villagers of (remaining uses x price) — exactly how much of it a trip can turn into
  // emeralds before every one of those trades reads `tradeDisabled`. Villagers restock TWICE A DAY at their workstation, so a
  // measurement older than ~20 min is taken at half weight rather than trusted (it may already have restocked, or not yet).
  function cargoPlan (P) {
    const list = Array.isArray(P.sell) && P.sell.length ? P.sell : SELL
    const I = industryOf()
    const fresh = I.absorbT && Date.now() - I.absorbT < 20 * 60000
    const room = (P.cargoSlots || 20) * 64 // pockets kept for the emeralds and everything we buy back
    const out = []
    let used = 0
    for (const s of list) {
      const spare = A.stockOf(s.item) - (s.reserve || 0)
      if (spare < (s.min || 32)) continue
      const learned = I.absorb && I.absorb[s.item]
      // A FRESH MEASUREMENT THAT DOES NOT MENTION THIS ITEM MEANS NOBODY THERE BUYS IT. Measured 16:45Z: both traders sprinted
      // 624 blocks under 416 gray wool because the village still has no shepherd — five slots of dead weight per trip. `force`
      // on a sell entry overrides this (a profession we are about to create).
      if (fresh && learned == null && !s.force) continue
      // + a restock's worth of margin: a villager that restocks while we are there takes more than the last reading showed
      const wantN = learned != null ? Math.ceil(learned * (fresh ? 1.5 : 2.5)) : (s.n || 128)
      const n = Math.min(Math.max(wantN, s.min || 32), spare, Math.max(0, room - used))
      if (n < (s.min || 32)) continue
      out.push({ item: s.item, n })
      used += n
      if (used >= room) break
    }
    return out.slice(0, 6)
  }

  // COME HOME WITH WHAT THE ARMY IS SHORT OF — counted in PIECES of that kind, never in "iron-equivalents". `settings.targets`
  // holds how many of each kind we want on the shelf (an operator sets them; `armyctl.js targets <key> <n>`), stock.js counts
  // chests + what the bots carry. A kind at or over its target is not bought at all, however cheap it is on offer.
  function armyShort () {
    let have = {}
    try { have = require('../../army/stock.js').stock() || {} } catch (e_) { swallow('jobs_industry:stock', e_); try { have = A.stockMap() || {} } catch (e2) { swallow('jobs_industry:stockMap', e2) } }
    return { have, targets: A.settings().targets || {} }
  }
  function buyList (P) {
    if (Array.isArray(P.buy) && P.buy.length) return P.buy.map(b => ({ re: new RegExp(b.re), want: b.want || 1, maxPrice: b.maxPrice }))
    const { have, targets } = armyShort()
    const out = []
    for (const b of BUY) {
      let deficit = 0
      for (const [k, t] of Object.entries(targets)) if (b.re.test(k)) deficit += Math.max(0, t - (have[k] || 0))
      if (deficit <= 0) continue // AT TARGET: do not buy it, hoard the emeralds instead
      out.push({ re: b.re, want: Math.min(b.max || deficit, deficit), maxPrice: b.maxPrice })
    }
    return out
  }
  // ingots the army did NOT have to forge, counted only for kinds it was short of
  const ironSaved = bought => Object.entries(bought).reduce((n, [k, q]) => n + (IRON_COST[k] || 0) * q, 0)

  async function loadCargo (bot, job, api) {
    const P = job.params || {}
    const plan = cargoPlan(P)
    if (!plan.length && A.count(bot, 'emerald') < 8) return { why: 'the depot holds nothing spare to sell' }
    if (!plan.length) return { why: 'the depot holds nothing spare to sell' }
    task(bot, 'trade: loading the glut at the depot')
    // WHAT THE VILLAGE DID NOT BUY GOES BACK ON THE SHELF (measured 15:30Z: 480 coal + 576 wool rode 1 250 blocks twice because
    // this village has no smith and no shepherd). Only the cargo of THIS trip and the purse stay in the pockets.
    const keep = { bread: 16, emerald: 64 }
    for (const c of plan) keep[c.item] = c.n
    await A.bank(bot, keep, { job: job.id, stop: api.stop, noKit: true }).catch(e_ => swallow('jobs_industry:bankBack', e_))
    await A.kitUp(bot, { risk: true, why: job.id, stop: api.stop }).catch(e_ => swallow('jobs_industry:kitUp', e_))
    const got = {}
    for (const c of plan) {
      if (api.stop()) break
      if (U.freeSlots(bot) < 6) break
      const n = await A.withdraw(bot, c.item, c.n, { stop: api.stop })
      if (n > 0) got[c.item] = n
    }
    // EMERALDS ARE WORKING CAPITAL, not loot: whatever a previous trip banked goes back out, so a visit can buy even when this
    // village has little left to buy from us that day.
    // A PURSE BIG ENOUGH FOR THE ARMORER. 105 armour pieces at 4-9 emeralds is ~700 emeralds, and one bot now earns that in an
    // hour: a visit that finds iron armour on offer must be able to buy every piece until the trade reads `tradeDisabled`.
    const purse = Math.min(P.purse || 448, A.stockOf('emerald'))
    if (purse > 0) { const n = await A.withdraw(bot, 'emerald', purse, { stop: api.stop }); if (n > 0) got.emerald = n }
    // FOOD FOR 1 250 BLOCKS. A trader SPRINTS both ways and eats all the way (measured 16:32Z: Tamaki reached the village on
    // hp 6 / food 0 carrying 51 emeralds — one mob and the whole trip is on the ground). A full trip needs about a stack.
    const food = bot.inventory.items().filter(i => bot.registry.foodsByName[i.name]).reduce((n, i) => n + i.count, 0)
    if (food < (P.food || 24)) await A.obtain(bot, 'bread', (P.food || 24) - food + A.count(bot, 'bread'), { stop: api.stop }).catch(e_ => swallow('jobs_industry:bread', e_))
    return { got }
  }

  async function tradeRound (bot, job, api, ctx2) {
    const P = job.params || {}
    const at = P.at || industryOf().village
    if (!Array.isArray(at)) return muster(bot, job, api, ctx2, 'trade: no village yet — run a `work:"survey"` job first')
    await nibble(bot)
    const st = bot.__industry = (bot.__industry && bot.__industry.key === job.id + ':' + (job.rev || 0)) ? bot.__industry : { key: job.id + ':' + (job.rev || 0), phase: 'load' }
    const home = A.chestsOf('food')[0] || A.musterPos()

    if (st.phase === 'load') {
      if (home && A.dist2(bot, home.x, home.z) > 40) {
        task(bot, 'trade: walking back to the depot to load')
        if (!await A.travel(bot, v([home.x, home.y, home.z]), { range: 6, ms: (P.legS || 300) * 1000, stop: api.stop })) { await nibble(bot); return 'trade: no route home to load' }
      }
      const r = await loadCargo(bot, job, api)
      if (r.why) { A.decline(bot, job, 20 * 60000, r.why); return muster(bot, job, api, ctx2, 'trade: ' + r.why) }
      st.cargo = r.got; st.phase = 'out'; st.t0 = Date.now() // the trip clock: emeralds per BOT-HOUR is the only number that ranks this front against mining
      A.result(bot, { ev: 'trade_load', job: job.id, items: r.got })
    }
    if (api.stop()) return 'trade: loaded, walking out next slice'

    if (st.phase === 'out') {
      task(bot, 'trade: walking to the village (' + at.join(',') + ')')
      if (!await A.travel(bot, v(at), { range: 10, ms: (P.legS || 300) * 1000, stop: api.stop })) { await nibble(bot); return 'trade: still on the road to the village' }
      await nibble(bot)
      // THE SITE CHEST (coordinator 09-20, accepted): five of every six trip-minutes are walking, so the cargo should already be
      // HERE. It is a work-site chest read through A.stash/A.unstash (`siteInfo`, not `record`), so the depot's chest index never
      // counts it as base stock and no bank/withdraw ever walks 624 blocks to it.
      if (Array.isArray(P.siteChest) && U.freeSlots(bot) > 6) {
        const got = await A.unstash(bot, v(P.siteChest), { stop: api.stop }).catch(e_ => { swallow('jobs_industry:siteTake', e_); return null })
        if (got && Object.keys(got).length) A.result(bot, { ev: 'trade_site_take', job: job.id, at: P.siteChest, items: got })
      }
      st.phase = 'trade'
    }
    if (api.stop()) return 'trade: at the village, trading next slice'

    if (st.phase === 'trade') {
      if (P.farmChest) await collectFarm(bot, { at: P.farmChest }, api).catch(e_ => swallow('jobs_industry:farmChest', e_))
      const want = buyList(P)
      const sold = {}; const bought = {}
      const absorb = {} // what this village could still take, learned from the offers — next trip's cargo size
      let n = 0
      let asleep = 0
      let gained = 0 // emeralds EARNED on this visit, not the purse we walked in with (the purse would flatter every number)
      const seen = new Set()
      // SEVERAL PASSES. 624 blocks each way is the cost of the trip, so the trip is not over while a buyer is still unserved:
      // villagers walk away mid-visit, one is out of reach on a roof, one is asleep at dusk and awake ten minutes later. A pass
      // that trades nothing new ends the visit (measured 16:18Z: 3 of 9 villagers served in a one-pass visit).
      for (let pass = 0; pass < (P.passes || 3) && !api.stop(); pass++) {
        let did = 0
        for (const e of villagersNear(bot, P.radius || 48)) {
          if (api.stop()) break
          if (A.hostiles(bot, 12).length) { task(bot, 'trade: mobs near — not trading'); await sleep(3000); continue } // the combat module fights them; a trader does not
          if (!e.isValid || seen.has(e.id)) continue
          if (isAsleep(bot, e)) { asleep++; continue }
          const r = await dealWith(bot, e, job, api, want, absorb)
          if (r.dry) seen.add(e.id) // nothing left on either side with this one: never open him again this visit
          if (r.sold) for (const [k, q] of Object.entries(r.sold)) sold[k] = (sold[k] || 0) + q
          if (r.bought) for (const [k, q] of Object.entries(r.bought)) bought[k] = (bought[k] || 0) + q
          if (Number.isFinite(r.emeralds) && r.emeralds > 0) gained += r.emeralds
          if (Object.keys(r.sold || {}).length || Object.keys(r.bought || {}).length) { n++; did++ }
          // nothing left to sell and nothing left to buy: stop walking the village
          if (!cargoInPockets(bot) && !want.some(w => w.want > 0)) { pass = 99; break }
        }
        if (!did) break
      }
      st.sold = sold; st.bought = bought
      if (Object.keys(absorb).length) industryEdit({ absorb, absorbT: Date.now() })
      const mins = st.t0 ? (Date.now() - st.t0) / 60000 : 0
      if (n) A.result(bot, { ev: 'trade_done', job: job.id, villagers: n, sold, bought, ironSaved: ironSaved(bought), earned: gained, purse: A.count(bot, 'emerald'), tripMin: Math.round(mins * 10) / 10, emPerBotHour: mins > 1 ? Math.round(gained / mins * 60) : null, absorb })
      else A.result(bot, { ev: 'trade_none', job: job.id, at: xyz(bot.entity.position), villagers: villagersNear(bot, P.radius || 48).length, asleep, carrying: Object.keys(cargoNames(bot)).join(',') || 'nothing' })
      // everybody was in bed: hold the goods and try again rather than walking 624 blocks home with a full load
      if (!n && asleep) { await sleep(20000); return 'trade: ' + asleep + ' villagers asleep — waiting for morning' }
      // WHAT DID NOT SELL STAYS HERE. It will sell at the next restock; carrying it 624 blocks home and 624 back is pure walking.
      // Emeralds, the purchases and the kit go home; only cargo is left behind.
      if (Array.isArray(P.siteChest) && cargoInPockets(bot)) {
        const keep = { bread: 32, emerald: 512 }
        for (const k of Object.keys(bought)) keep[k] = 512
        const left = await A.stash(bot, v(P.siteChest), keep, { stop: api.stop }).catch(e_ => { swallow('jobs_industry:siteLeave', e_); return null })
        if (left && Object.keys(left).length) A.result(bot, { ev: 'trade_site_leave', job: job.id, at: P.siteChest, items: left })
      }
      st.phase = 'home'
    }
    if (api.stop()) return 'trade: traded, walking home next slice'

    if (st.phase === 'home') {
      if (!home) { st.phase = 'load'; return 'trade: no depot to bank at' }
      task(bot, 'trade: walking home with the goods')
      if (!await A.travel(bot, v([home.x, home.y, home.z]), { range: 6, ms: (P.legS || 300) * 1000, stop: api.stop })) { await nibble(bot); return 'trade: still on the road home' }
      const keep = { bread: 16 }
      const moved = await A.bank(bot, keep, { job: job.id, stop: api.stop })
      A.result(bot, { ev: 'trade_banked', job: job.id, items: moved })
      st.phase = 'load'
    }
    return 'trade: round trip done'
  }

  const cargoNames = bot => { const m = {}; for (const s of SELL) { const n = A.count(bot, s.item); if (n) m[s.item] = n } return m }
  const cargoInPockets = bot => Object.keys(cargoNames(bot)).length > 0

  // ---------------------------------------------------------------- work:'post' — MAKE THE BUYERS WE NEED
  // Measured at this village 15:25Z: its professions are 2 farmers and 4 leatherworkers, so it buys wheat, carrots, beetroot,
  // pumpkin, leather and flint — and sells LEATHER armour. Our glut is wool (10 328), sugar cane (2 995) and coal (1 876), and
  // what we lack is IRON. No amount of walking fixes that: the village has no shepherd, no librarian and no smith.
  // A villager without a profession takes the nearest unclaimed WORKSTATION it can reach, so the buyers we lack are a crafting
  // recipe away. This mode makes the stations at the depot (the only place with a table, a furnace bank and the stock), carries
  // them out and places them beside the villagers. Redstone-free; it changes nothing that already stands in the village.
  const STATION_WHY = {
    blast_furnace: 'armorer: buys 15 coal -> 1 emerald AND SELLS IRON ARMOUR (4-9 emeralds a piece)',
    smithing_table: 'toolsmith: buys coal, sells iron tools from journeyman',
    loom: 'shepherd: buys 18 wool -> 1 emerald',
    grindstone: 'weaponsmith: buys 15 coal, sells iron sword/axe from journeyman',
    lectern: 'librarian: buys 24 paper -> 1 emerald',
    barrel: 'fisherman: buys 20 string / 15 coal',
    smoker: 'butcher: buys 10 wheat and raw meat'
  }

  async function makeStations (bot, job, api, cells) {
    const short = []
    // stone and smooth_stone are SMELTED, not crafted, so the recipe solver can never reach a blast furnace (3 smooth_stone) or a
    // grindstone (a stone slab) on its own. Two furnace passes up front; everything else is an ordinary A.obtain chain.
    const needStone = cells.some(c => /^(blast_furnace|grindstone)$/.test(c.block) && !A.count(bot, c.block))
    if (needStone && A.count(bot, 'smooth_stone') < 3) {
      task(bot, 'post: smelting stone for the smith stations')
      await A.obtain(bot, 'coal', 16, { stop: api.stop }).catch(e_ => swallow('jobs_industry:fuel', e_))
      if (A.count(bot, 'stone') < 8) { await A.obtain(bot, 'cobblestone', 16, { stop: api.stop }).catch(e_ => swallow('jobs_industry:cobble', e_)); await A.smelt(bot, 'cobblestone', 16).catch(e_ => swallow('jobs_industry:smeltStone', e_)) }
      if (A.count(bot, 'stone') >= 4) await A.smelt(bot, 'stone', Math.max(3, A.count(bot, 'stone') - 3)).catch(e_ => swallow('jobs_industry:smeltSmooth', e_))
      A.result(bot, { ev: 'post_stone', job: job.id, stone: A.count(bot, 'stone'), smooth: A.count(bot, 'smooth_stone') })
    }
    for (const c of cells) {
      if (api.stop()) break
      if (A.count(bot, c.block) >= 1) continue
      task(bot, 'post: making a ' + c.block)
      const ok = await A.obtain(bot, c.block, 1, { stop: api.stop }).catch(e_ => { swallow('jobs_industry:station', e_); return false })
      if (!ok) short.push(c.block)
    }
    return short
  }

  async function post (bot, job, api, ctx2) {
    const P = job.params || {}
    const cells = (P.cells || []).filter(c => c && c.block && Array.isArray(c.at))
    if (!cells.length) return muster(bot, job, api, ctx2, 'post: params.cells [{block,at:[x,y,z]}] is empty — probe the ground first (armyctl.js ground)')
    const st = bot.__industryPost = (bot.__industryPost && bot.__industryPost.key === job.id + ':' + (job.rev || 0)) ? bot.__industryPost : { key: job.id + ':' + (job.rev || 0), phase: 'make', done: {} }
    const home = A.chestsOf('build')[0] || A.musterPos()

    if (st.phase === 'make') {
      if (home && A.dist2(bot, home.x, home.z) > 40) {
        task(bot, 'post: back to the depot to make the workstations')
        if (!await A.travel(bot, v([home.x, home.y, home.z]), { range: 6, ms: (P.legS || 300) * 1000, stop: api.stop })) return 'post: no route to the depot'
      }
      // EMPTY POCKETS FIRST. Measured 15:44Z: Tamaki carried 800 wheat from an interrupted trade load, so every withdrawal in the
      // recipe chain hit `Bot inventory is full` and `obtain` reported `missing {iron_ingot:5, furnace:1}` while those very items
      // were in her hands. A station is crafted out of the DEPOT, so the pockets must be empty when the chain is solved.
      task(bot, 'post: banking the pockets before crafting')
      await A.bank(bot, { bread: 16, emerald: 64 }, { job: job.id, stop: api.stop, noKit: true }).catch(e_ => swallow('jobs_industry:postBank', e_))
      const short = await makeStations(bot, job, api, cells)
      const have = cells.filter(c => A.count(bot, c.block) > 0).map(c => c.block)
      A.result(bot, { ev: 'post_made', job: job.id, carrying: have, short })
      if (!have.length) { A.decline(bot, job, 20 * 60000, 'no workstation could be made: ' + short.join(',')); return muster(bot, job, api, ctx2, 'post: could not make any workstation (' + short.join(',') + ')') }
      st.phase = 'out'
    }
    if (api.stop()) return 'post: workstations made, walking out next slice'

    if (st.phase === 'out') {
      task(bot, 'post: carrying the workstations to the village')
      const first = cells[0].at
      if (!await A.travel(bot, v(first), { range: 12, ms: 14 * 60000, stop: api.stop })) { await nibble(bot); return 'post: still on the road to the village' }
      st.phase = 'place'
    }
    if (api.stop()) return 'post: at the village, placing next slice'

    for (const c of cells) {
      if (api.stop()) break
      const p = v(c.at)
      const b0 = bot.blockAt(p)
      if (b0 && b0.name === c.block) { st.done[c.block] = c.at; continue } // already standing: never place twice
      if (!A.count(bot, c.block)) continue
      task(bot, 'post: placing the ' + c.block)
      const r = await A.placeHard(bot, p, c.block, { stop: api.stop, want: 1 })
      const b1 = bot.blockAt(p) // TRUST THE SERVER, not placeHard's opinion
      const ok = !!b1 && b1.name === c.block
      if (ok) st.done[c.block] = c.at
      A.result(bot, { ev: ok ? 'station_placed' : 'station_failed', job: job.id, block: c.block, at: c.at, why: ok ? STATION_WHY[c.block] || '' : String((r && r.reason) || 'unknown').slice(0, 80), tried: ok ? undefined : (r && r.remedies) })
    }
    industryEdit({ post: { at: cells[0].at, stations: st.done, t: Date.now() } })
    const left = cells.filter(c => !st.done[c.block])
    if (!left.length) {
      A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active' && (j.rev || 0) === (job.rev || 0)) { j.status = 'paused'; j.note = 'auto-paused: every workstation stands; the survey job now watches which professions the villagers take' } })
      return 'post: every workstation stands (' + Object.keys(st.done).join(', ') + ')'
    }
    st.phase = 'make' // fetch what could not be made or placed and come back
    return 'post: ' + Object.keys(st.done).length + '/' + cells.length + ' stations stand; still to do: ' + left.map(c => c.block).join(',')
  }

  // ---------------------------------------------------------------- work:'breed' — MORE VILLAGERS, NOT A LONGER WALK
  // Measured 16:35Z, after the seven workstations went down: professions farmer 2, leatherworker 4, toolsmith 1, weaponsmith 1,
  // unknown 1. Nine villagers and only ONE still unemployed — so the loom, the lectern, the barrel and the smoker can never all
  // be claimed here, and our wool and paper stay unsellable. The village is not short of workstations, it is short of PEOPLE.
  // A villager becomes willing to breed when it picks up 3 bread (or 12 carrots/potatoes/beetroot), and a pair breeds when there
  // is a FREE BED in the village. We have 12 beds for 9 villagers and 17 000 wheat: bread is the cheapest thing we own.
  // No transport, no redstone, no cheat — a player throws bread at a village and comes back to more villagers.
  async function breed (bot, job, api, ctx2) {
    const P = job.params || {}
    const at = P.at || industryOf().village
    if (!Array.isArray(at)) return muster(bot, job, api, ctx2, 'breed: no village yet')
    const loaves = P.loaves || 96
    const home = A.chestsOf('food')[0] || A.musterPos()

    if (A.count(bot, 'bread') < loaves / 2 && home && A.dist2(bot, home.x, home.z) < 200) {
      task(bot, 'breed: drawing bread for the village')
      if (A.dist2(bot, home.x, home.z) > 40) await A.travel(bot, v([home.x, home.y, home.z]), { range: 6, ms: (P.legS || 300) * 1000, stop: api.stop })
      await A.obtain(bot, 'bread', loaves, { stop: api.stop }).catch(e_ => swallow('jobs_industry:breadBreed', e_))
      await nibble(bot)
    }
    if (A.count(bot, 'bread') < 12) { A.decline(bot, job, 20 * 60000, 'no bread to feed the village with (bake wheat first)'); return muster(bot, job, api, ctx2, 'breed: no bread') }
    if (A.dist2(bot, at[0], at[2]) > 40) {
      task(bot, 'breed: carrying ' + A.count(bot, 'bread') + ' bread to the village')
      if (!await A.travel(bot, v(at), { range: 10, ms: (P.legS || 300) * 1000, stop: api.stop })) { await nibble(bot); return 'breed: still on the road' }
      await nibble(bot)
    }

    // FEED EVERY ADULT, 4 loaves each (3 makes it willing, the 4th covers a loaf another villager grabs first)
    const bread = bot.registry.itemsByName.bread
    let fed = 0
    const each = P.each || 4
    for (const e of villagersNear(bot, P.radius || 48)) {
      if (api.stop() || A.count(bot, 'bread') < each) break
      if (isAsleep(bot, e)) continue
      if (!await A.travel(bot, e.position, { range: 2, ms: 30000, stop: api.stop, quiet: true })) continue
      try {
        await bot.lookAt(e.position.offset(0, 0.5, 0), true)
        await U.withTimeout(bot.toss(bread.id, null, each), 6000, 'tossBread')
        fed++
      } catch (e_) { swallow('jobs_industry:toss', e_) }
      await sleep(600)
    }
    const I = industryOf()
    A.result(bot, { ev: 'breed_fed', job: job.id, villagers: fed, loaves: fed * each, left: A.count(bot, 'bread'), population: I.villagers || null, beds: I.beds || null, why: 'fed villagers breed when a FREE BED stands in the village (' + (I.beds || '?') + ' beds for ' + (I.villagers || '?') + ' villagers); the survey job counts the babies' })
    if (!fed) { await sleep(20000); return 'breed: nobody to feed (all asleep or out of reach)' }
    return 'breed: fed ' + fed + ' villagers ' + (fed * each) + ' bread'
  }

  // ---------------------------------------------------------------- work:'librarian' — THE WAY AROUND OUR XP WALL
  // The enchant engineer measured that no bot ever reaches level 30 (deaths wipe XP), so Fortune III off the table is out of
  // reach. A LIBRARIAN sells enchanted books for emeralds + a book, and book + pickaxe on an ANVIL costs only a few levels.
  // A librarian who has NEVER TRADED re-rolls his whole offer set when his lectern is broken and put back — that is a plain
  // player move, no cheat, no redstone. So: read his book, and if it is not one we want, break our own lectern and look again.
  // The moment we buy one trade he is level 2 and the offer is LOCKED for good, so the buy is the last step, never the first.
  const BOOK_WANT = ['fortune', 'mending', 'unbreaking', 'efficiency', 'looting', 'silk_touch']

  const librarianAt = (bot, at) => villagersNear(bot, 12)
    .filter(e => e.position.distanceTo(v(at)) <= 6)
    .sort((a, b) => a.position.distanceTo(v(at)) - b.position.distanceTo(v(at)))[0] || null

  // open a villager, read the offers, close again — no trading (the re-roll must not level him by accident)
  async function readOffers (bot, ent, job, api) {
    let win = null
    try {
      try { await bot.lookAt(ent.position.offset(0, 1, 0), true) } catch (e_) { swallow('jobs_industry:lookAt2', e_) }
      win = await U.withTimeout(bot.openVillager(ent), 12000, 'openVillager')
      return { offers: (win.trades || []).map(offerOf).filter(Boolean), win }
    } catch (e) {
      A.result(bot, { ev: 'trade_blocked', job: job.id, at: xyz(ent.position), why: String(e && e.message || e).slice(0, 120) })
      return { offers: [], win: null }
    }
  }
  async function closeOffers (bot, win) {
    if (win) A.closeWin(win)
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e_) { swallow('jobs_industry:closeCur2', e_) }
    for (let i = 0; i < 20 && bot.currentWindow; i++) await sleep(150)
  }

  async function librarian (bot, job, api, ctx2) {
    const P = job.params || {}
    const lect = P.lectern || ((industryOf().post || {}).stations || {}).lectern
    if (!Array.isArray(lect)) return muster(bot, job, api, ctx2, 'librarian: no lectern known — params.lectern:[x,y,z] or run work:"post" first')
    const wantRe = new RegExp('(' + (P.want || BOOK_WANT).join('|') + ')', 'i')
    const st = bot.__industryLib = (bot.__industryLib && bot.__industryLib.key === job.id + ':' + (job.rev || 0)) ? bot.__industryLib : { key: job.id + ':' + (job.rev || 0), rolls: 0, dry: 0, same: 0, last: '' }

    // KIT: a book and emeralds are what the trade costs; a spare lectern saves a walk if the broken one is not picked up
    if (A.dist2(bot, lect[0], lect[2]) > 64) {
      const home = A.chestsOf('build')[0] || A.musterPos()
      if (home && A.dist2(bot, home.x, home.z) < 150 && (A.count(bot, 'book') < 4 || A.count(bot, 'emerald') < 24)) {
        task(bot, 'librarian: drawing books and emeralds')
        await A.obtain(bot, 'book', 8, { stop: api.stop }).catch(e_ => swallow('jobs_industry:book', e_))
        await A.withdraw(bot, 'emerald', Math.min(64, A.stockOf('emerald')), { stop: api.stop }).catch(e_ => swallow('jobs_industry:purse', e_))
      }
      task(bot, 'librarian: walking to the lectern at ' + lect.join(','))
      if (!await A.travel(bot, v(lect), { range: 3, ms: 14 * 60000, stop: api.stop })) { await nibble(bot); return 'librarian: still on the road to the lectern' }
    }

    while (st.rolls < (P.rerolls || 12) && !api.stop()) {
      const ent = librarianAt(bot, lect)
      if (!ent) { task(bot, 'librarian: waiting for a villager to claim the lectern'); await sleep(6000); if (++st.dry > 10) { A.result(bot, { ev: 'book_no_librarian', job: job.id, at: lect, why: 'no villager came to the lectern in a minute — is one unemployed and able to reach it?' }); return 'librarian: nobody claimed the lectern' } continue }
      st.dry = 0
      const { offers, win } = await readOffers(bot, ent, job, api)
      const book = offers.find(o => o.out === 'enchanted_book')
      // HAS HE ALREADY TRADED? Then his offers are frozen and breaking the lectern only annoys him. `nbTradeUses` resets on every
      // restock, so it is only half the test; a levelled librarian also has MORE than the two offers a novice starts with, and a
      // re-roll that hands back the same book three times running means the same thing whatever the counters say.
      const traded = offers.some(o => o.used > 0) || offers.length > 3
      if (!book) {
        await closeOffers(bot, win)
        A.result(bot, { ev: 'book_none', job: job.id, at: xyz(ent.position), offers: offers.map(o => o.in1 + '->' + o.out), why: 'this villager has no enchanted_book offer (not a librarian yet, or the window did not open)' })
        await sleep(5000)
        st.rolls++
        continue
      }
      const names = enchantNames(bot, book.outItem)
      const good = wantRe.test(names.join(' '))
      A.result(bot, { ev: 'book_offer', job: job.id, roll: st.rolls, at: xyz(ent.position), book: names, price: book.price, price2: book.price2 + ' ' + book.in2, want: good })
      if (good) {
        // LOCK IT: one trade makes him level 2 and the offer never changes again
        const i = offers.indexOf(book)
        const n = Math.min(book.left, Math.floor(inWin(win, 'emerald') / book.price), book.in2 ? Math.floor(inWin(win, book.in2) / Math.max(1, book.price2)) : 99)
        let got = 0
        if (n > 0) got = await runTrade(bot, win, i, n)
        await closeOffers(bot, win)
        A.result(bot, { ev: got > 0 ? 'book_locked' : 'book_short', job: job.id, book: names, paid: book.price, got, at: xyz(ent.position), why: got > 0 ? 'bought and therefore LOCKED - this librarian sells it for ever now' : 'could not pay: ' + book.price + ' emerald + ' + book.price2 + ' ' + book.in2 + ' (carried ' + A.count(bot, 'emerald') + ' emerald, ' + A.count(bot, 'book') + ' book)' })
        if (got > 0) {
          const bk = industryOf().books || {}
          industryEdit({ books: Object.assign({}, bk, { [names.join('+')]: { at: xyz(ent.position), price: book.price, t: Date.now() } }) })
          return 'librarian: locked ' + names.join('+') + ' at ' + book.price + ' emeralds'
        }
        return 'librarian: the book we want is on offer but we cannot pay for it yet'
      }
      await closeOffers(bot, win)
      const sig = names.join('+')
      st.same = sig === st.last ? st.same + 1 : 0
      st.last = sig
      if (traded || st.same >= 3) { A.result(bot, { ev: 'book_locked_bad', job: job.id, book: names, offers: offers.length, sameRolls: st.same, why: 'this librarian will not re-roll (already traded, or the same book came back ' + (st.same + 1) + ' times). Place a SECOND lectern for a fresh, unemployed villager' }); return 'librarian: cannot re-roll this one (' + sig + ')' }
      // RE-ROLL: break our own lectern and put it straight back. Only ever OUR lectern, never a block the village built.
      st.rolls++
      task(bot, 'librarian: re-roll ' + st.rolls + ' (' + names.join('+') + ' is not what we need)')
      const BL = require('./blocks')
      await BL.digBlock(bot, v(lect), { collect: true, requireHarvest: false }).catch(e_ => swallow('jobs_industry:digLectern', e_))
      await sleep(3000)
      const r = await A.placeHard(bot, v(lect), 'lectern', { stop: api.stop, want: 1 })
      const back = bot.blockAt(v(lect))
      if (!back || back.name !== 'lectern') { A.result(bot, { ev: 'book_reroll_failed', job: job.id, at: lect, why: String((r && r.reason) || 'the lectern did not go back') }); return 'librarian: the lectern did not go back — stopping rather than leaving a hole' }
      await sleep(9000) // he has to walk to it and claim it again
    }
    A.result(bot, { ev: 'book_rerolls_done', job: job.id, rolls: st.rolls, why: 'no wanted book in ' + st.rolls + ' re-rolls' })
    return 'librarian: ' + st.rolls + ' re-rolls, nothing we want yet'
  }

  // ---------------------------------------------------------------- the anvil verb: book + tool, for a few levels instead of 30
  async function anvilVerb (bot, st, api) {
    const at = st.at
    let blk = Array.isArray(at) ? bot.blockAt(v(at)) : null
    if (!blk || !/anvil$/.test(blk.name)) blk = bot.findBlock({ matching: b => !!b && /anvil$/.test(b.name), maxDistance: 16 })
    if (!blk) return 'no anvil within 16 blocks' + (Array.isArray(at) ? ' and none at ' + at.join(',') : '') + ' (an anvil is 31 iron: 3 blocks + 4 ingots)'
    if (!await A.travel(bot, blk.position, { range: 3, ms: 120000, stop: api && api.stop })) return 'anvil unreachable at ' + xyz(blk.position).join(',')
    const tool = bot.inventory.items().find(i => i.name === st.item)
    const book = bot.inventory.items().find(i => i.name === (st.with || 'enchanted_book'))
    if (!tool) return 'no ' + st.item + ' carried'
    if (!book) return 'no ' + (st.with || 'enchanted_book') + ' carried'
    const was = enchantNames(bot, tool)
    let win = null
    try {
      win = await U.withTimeout(bot.openAnvil(blk), 12000, 'openAnvil')
      await U.withTimeout(win.combine(tool, book, null), 20000, 'anvilCombine')
    } catch (e) {
      A.closeWin(win)
      return 'anvil: ' + String(e && e.message || e).slice(0, 100) + ' (levels ' + bot.experience.level + ')'
    }
    A.closeWin(win)
    await sleep(800)
    // TRUST THE ITEM, not the window: read the enchantments back off the tool that is now in the pockets
    const now = bot.inventory.items().find(i => i.name === st.item)
    const got = now ? enchantNames(bot, now) : []
    A.result(bot, { ev: 'anvil_done', item: st.item, was, got, levels: bot.experience.level, at: xyz(blk.position) })
    return got.length > was.length || got.join() !== was.join() ? true : 'the anvil took the book but the tool reads ' + (got.join('+') || 'unenchanted')
  }

  // ---------------------------------------------------------------- the iron farm's chest, and the MEASUREMENT of its yield
  async function collectFarm (bot, st, api) {
    const at = st.at
    if (!Array.isArray(at)) return 'collect_farm needs at:[x,y,z]'
    if (!await A.travel(bot, v(at), { range: 3, ms: 120000, stop: api && api.stop })) return 'no route to the farm chest at ' + at.join(',')
    const got = await A.unstash(bot, v(at), { stop: api && api.stop })
    if (!got) return 'no chest at ' + at.join(',')
    const iron = (got.iron_ingot || 0) + (got.iron_block || 0) * 9
    const F = industryOf().farm || {}
    const mine = Array.isArray(F.at) && F.at.join(',') === at.join(',')
    const hours = mine && F.t ? (Date.now() - F.t) / 3600000 : 0
    const total = (mine ? F.iron || 0 : 0) + iron
    // the rate record belongs to the FARM chest: a `collect_farm` step aimed anywhere else reports and changes no bookkeeping
    if (mine || iron > 0) industryEdit({ farm: { at, t: Date.now(), iron: total, lastIron: iron, lastHours: Math.round(hours * 100) / 100 } })
    A.result(bot, { ev: 'iron_farm_take', at, items: got, iron, hours: Math.round(hours * 100) / 100, perHour: hours > 0.05 ? Math.round(iron / hours * 10) / 10 : null, totalIron: total })
    return true
  }

  // ---------------------------------------------------------------- the job type
  async function trade (bot, job, api, ctx2) {
    const P = job.params || {}
    if (P.work === 'survey') return await survey(bot, job, api, ctx2)
    if (P.work === 'post') return await post(bot, job, api, ctx2)
    if (P.work === 'librarian') return await librarian(bot, job, api, ctx2)
    if (P.work === 'breed') return await breed(bot, job, api, ctx2)
    return await tradeRound(bot, job, api, ctx2)
  }

  return {
    types: { trade },
    verbs: {
      collect_farm: async (bot, st, api) => await collectFarm(bot, st, api),
      anvil: async (bot, st, api) => await anvilVerb(bot, st, api)
    }
  }
}
module.exports.TYPES = ['trade']
module.exports.VERBS = ['collect_farm', 'anvil']
