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
//   work:'trade'   (default) the standing round trip: load the glut at the depot -> walk to the village -> sell to every villager
//                  that buys what we carry -> buy what the army lacks with the emeralds -> walk home -> bank. `shiftMin` keeps the
//                  bot on the job across 15-min slices; the phase lives on the bot (bot.__industry), so a slice boundary costs nothing.
//   at:[x,y,z]     the village rally point (default settings.industry.village)         radius:48   how far villagers are looked for
//   sell:[{item,n}]  what to carry out (default: SELL below, capped by the depot reserve so the army never sells its own supply)
//   buy:[{re,want}]  what to bring back, in priority order (default: BUY below — iron armour first)
//   maxPrice:20    never pay more than this many emeralds for one item (an enchanted book can ask 64)
//   farmChest:[x,y,z]  the iron farm's collection chest; emptied on every visit (see the verb `collect_farm`)
// VERB (usable in any `steps` plan): collect_farm {at:[x,y,z]} — empty the farm chest and MEASURE the yield per hour
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
  // priority order: what unblocks the army first. `want` = pieces per trip.
  const BUY = [
    { re: /^iron_(helmet|chestplate|leggings|boots)$/, want: 12 },
    { re: /^iron_(pickaxe|axe|shovel|sword)$/, want: 6 },
    { re: /^(chainmail_(helmet|chestplate|leggings|boots))$/, want: 4 },
    { re: /^enchanted_book$/, want: 2 },
    { re: /^arrow$/, want: 128 }
  ]

  // ---------------------------------------------------------------- reading the village back
  const WORKSTATION = {
    composter: 'farmer', barrel: 'fisherman', blast_furnace: 'armorer', smoker: 'butcher', cartography_table: 'cartographer', brewing_stand: 'cleric', cauldron: 'leatherworker', fletching_table: 'fletcher', grindstone: 'weaponsmith', lectern: 'librarian', loom: 'shepherd', smithing_table: 'toolsmith', stonecutter: 'mason'
  }
  const villagersNear = (bot, r) => Object.values(bot.entities)
    .filter(e => e && e.position && e.name === 'villager' && e.position.distanceTo(bot.entity.position) <= r)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  const golemsNear = (bot, r) => Object.values(bot.entities).filter(e => e && e.position && e.name === 'iron_golem' && e.position.distanceTo(bot.entity.position) <= r)

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
    task(bot, 'village: looking around')
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
    industryEdit({ village: at, surveyed: Date.now(), villagers: vs.length, professions: prof, beds: beds.length, stations: stationKinds, golems: golems.length, bounds })
    return 'village: ' + vs.length + ' villagers, ' + beds.length + ' beds, ' + Object.keys(stationKinds).length + ' kinds of workstation, ' + golems.length + ' golems'
  }

  // ---------------------------------------------------------------- one trade window
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
      left: t.tradeDisabled ? 0 : left
    }
  }

  // ONE villager: sell what it buys, then buy what we lack. Returns a summary; never throws, always closes the window.
  async function dealWith (bot, ent, job, api, want) {
    const P = job.params || {}
    const maxPrice = P.maxPrice == null ? 20 : P.maxPrice
    if (!await A.travel(bot, ent.position, { range: 2, ms: 45000, stop: api.stop, quiet: true })) return { why: 'unreachable' }
    let win = null
    const sold = {}; const bought = {}
    const em0 = A.count(bot, 'emerald')
    try {
      try { await bot.lookAt(ent.position.offset(0, 1, 0), true) } catch (e_) { swallow('jobs_industry:lookAt', e_) }
      win = await U.withTimeout(bot.openVillager(ent), 12000, 'openVillager')
      const offers = (win.trades || []).map(offerOf)
      if (!offers.some(Boolean)) return { why: 'no offers' }
      // say ONCE per profession what this village really pays — the numbers in a wiki are not this server's numbers
      const key = offers.filter(Boolean).map(o => o.in1 + '->' + o.out).join(' ')
      if (!seenOffers.has(key)) {
        seenOffers.add(key)
        A.result(bot, { ev: 'trade_offer', job: job.id, at: xyz(ent.position), title: String(win.title || '').slice(0, 40), offers: offers.filter(Boolean).map(o => (o.price + ' ' + o.in1 + (o.in2 ? ' + ' + o.price2 + ' ' + o.in2 : '') + ' -> ' + o.outN + ' ' + o.out + (o.left ? '' : ' [locked]'))) })
      }

      // SELL: every offer that pays emeralds for something in our pockets
      for (let i = 0; i < offers.length; i++) {
        if (api.stop()) break
        const o = offers[i]
        if (!o || o.out !== 'emerald' || o.in2 || !o.left) continue
        const have = A.count(bot, o.in1)
        const n = Math.min(o.left, Math.floor(have / o.price))
        if (n <= 0) continue
        const got = await runTrade(bot, win, i, n)
        if (got > 0) { sold[o.in1] = (sold[o.in1] || 0) + got * o.price; await sleep(250) }
      }

      // BUY: priority order, only what we still want, only with emeralds we actually hold
      for (const b of want) {
        if (api.stop() || b.want <= 0) continue
        for (let i = 0; i < offers.length; i++) {
          const o = offers[i]
          if (!o || !o.left || o.in1 !== 'emerald' || o.in2 || !b.re.test(o.out)) continue
          if (o.price > maxPrice) continue
          const canPay = Math.floor(A.count(bot, 'emerald') / o.price)
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
      await sleep(300)
    }
    return { sold, bought, emeralds: A.count(bot, 'emerald') - em0 }
  }
  const seenOffers = new Set()

  // Run one offer `n` times and report what the SERVER actually gave us (bot.trade resolves optimistically).
  async function runTrade (bot, win, index, n) {
    const t = (win.trades || [])[index]
    const out = t && (t.outputItem || (t.outputs && t.outputs[0]))
    if (!out || !out.name) return 0
    const before = A.count(bot, out.name)
    try { await U.withTimeout(bot.trade(win, index, n), 15000, 'trade') } catch (e_) { swallow('jobs_industry:runTrade', e_) }
    await sleep(400)
    const gained = A.count(bot, out.name) - before
    return Math.max(0, Math.round(gained / (out.count || 1)))
  }

  // ---------------------------------------------------------------- the round trip
  function cargoPlan (P) {
    const list = Array.isArray(P.sell) && P.sell.length ? P.sell : SELL
    const out = []
    for (const s of list) {
      const spare = A.stockOf(s.item) - (s.reserve || 0)
      if (spare < (s.min || 32)) continue
      out.push({ item: s.item, n: Math.min(s.n || 128, spare) })
    }
    return out.slice(0, 6) // six kinds of cargo leave enough pockets for the emeralds and everything we buy back
  }

  async function loadCargo (bot, job, api) {
    const P = job.params || {}
    const plan = cargoPlan(P)
    if (!plan.length) return { why: 'the depot holds nothing spare to sell' }
    task(bot, 'trade: loading the glut at the depot')
    await A.kitUp(bot, { risk: true, why: job.id, stop: api.stop }).catch(e_ => swallow('jobs_industry:kitUp', e_))
    const got = {}
    for (const c of plan) {
      if (api.stop()) break
      if (U.freeSlots(bot) < 6) break
      const n = await A.withdraw(bot, c.item, c.n, { stop: api.stop })
      if (n > 0) got[c.item] = n
    }
    if (!A.count(bot, 'bread') && !bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) await A.obtain(bot, 'bread', 16, { stop: api.stop }).catch(e_ => swallow('jobs_industry:bread', e_))
    return { got }
  }

  async function tradeRound (bot, job, api, ctx2) {
    const P = job.params || {}
    const at = P.at || industryOf().village
    if (!Array.isArray(at)) return muster(bot, job, api, ctx2, 'trade: no village yet — run a `work:"survey"` job first')
    const st = bot.__industry = (bot.__industry && bot.__industry.key === job.id + ':' + (job.rev || 0)) ? bot.__industry : { key: job.id + ':' + (job.rev || 0), phase: 'load' }
    const home = A.chestsOf('food')[0] || A.musterPos()

    if (st.phase === 'load') {
      if (home && A.dist2(bot, home.x, home.z) > 40) {
        task(bot, 'trade: walking back to the depot to load')
        if (!await A.travel(bot, v([home.x, home.y, home.z]), { range: 6, ms: 12 * 60000, stop: api.stop })) return 'trade: no route home to load'
      }
      const r = await loadCargo(bot, job, api)
      if (r.why) { A.decline(bot, job, 20 * 60000, r.why); return muster(bot, job, api, ctx2, 'trade: ' + r.why) }
      st.cargo = r.got; st.phase = 'out'
      A.result(bot, { ev: 'trade_load', job: job.id, items: r.got })
    }
    if (api.stop()) return 'trade: loaded, walking out next slice'

    if (st.phase === 'out') {
      task(bot, 'trade: walking to the village (' + at.join(',') + ')')
      if (!await A.travel(bot, v(at), { range: 10, ms: 14 * 60000, stop: api.stop })) return 'trade: still on the road to the village'
      st.phase = 'trade'
    }
    if (api.stop()) return 'trade: at the village, trading next slice'

    if (st.phase === 'trade') {
      if (P.farmChest) await collectFarm(bot, { at: P.farmChest }, api).catch(e_ => swallow('jobs_industry:farmChest', e_))
      const want = (Array.isArray(P.buy) && P.buy.length ? P.buy.map(b => ({ re: new RegExp(b.re), want: b.want || 1 })) : BUY.map(b => ({ re: b.re, want: b.want })))
      const sold = {}; const bought = {}
      let n = 0
      for (const e of villagersNear(bot, P.radius || 48)) {
        if (api.stop()) break
        if (A.hostiles(bot, 12).length) { task(bot, 'trade: mobs near — not trading'); await sleep(3000); continue } // the combat module fights them; a trader does not
        if (!e.isValid) continue
        const r = await dealWith(bot, e, job, api, want)
        if (r.sold) for (const [k, q] of Object.entries(r.sold)) sold[k] = (sold[k] || 0) + q
        if (r.bought) for (const [k, q] of Object.entries(r.bought)) bought[k] = (bought[k] || 0) + q
        if (Object.keys(r.sold || {}).length || Object.keys(r.bought || {}).length) n++
        // nothing left to sell and nothing left to buy: stop walking the village
        if (!cargoInPockets(bot) && !want.some(w => w.want > 0)) break
      }
      st.sold = sold; st.bought = bought
      if (n) A.result(bot, { ev: 'trade_done', job: job.id, villagers: n, sold, bought, emeralds: A.count(bot, 'emerald') })
      else A.result(bot, { ev: 'trade_none', job: job.id, at: xyz(bot.entity.position), villagers: villagersNear(bot, P.radius || 48).length, carrying: Object.keys(cargoNames(bot)).join(',') || 'nothing' })
      st.phase = 'home'
    }
    if (api.stop()) return 'trade: traded, walking home next slice'

    if (st.phase === 'home') {
      if (!home) { st.phase = 'load'; return 'trade: no depot to bank at' }
      task(bot, 'trade: walking home with the goods')
      if (!await A.travel(bot, v([home.x, home.y, home.z]), { range: 6, ms: 14 * 60000, stop: api.stop })) return 'trade: still on the road home'
      const keep = { bread: 16 }
      const moved = await A.bank(bot, keep, { job: job.id, stop: api.stop })
      A.result(bot, { ev: 'trade_banked', job: job.id, items: moved })
      st.phase = 'load'
    }
    return 'trade: round trip done'
  }

  const cargoNames = bot => { const m = {}; for (const s of SELL) { const n = A.count(bot, s.item); if (n) m[s.item] = n } return m }
  const cargoInPockets = bot => Object.keys(cargoNames(bot)).length > 0

  // ---------------------------------------------------------------- the iron farm's chest, and the MEASUREMENT of its yield
  async function collectFarm (bot, st, api) {
    const at = st.at
    if (!Array.isArray(at)) return 'collect_farm needs at:[x,y,z]'
    if (!await A.travel(bot, v(at), { range: 3, ms: 120000, stop: api && api.stop })) return 'no route to the farm chest at ' + at.join(',')
    const got = await A.unstash(bot, v(at), { stop: api && api.stop })
    if (!got) return 'no chest at ' + at.join(',')
    const iron = (got.iron_ingot || 0) + (got.iron_block || 0) * 9
    const F = industryOf().farm || {}
    const hours = F.t ? (Date.now() - F.t) / 3600000 : 0
    const total = (F.iron || 0) + iron
    industryEdit({ farm: { at, t: Date.now(), iron: total, lastIron: iron, lastHours: Math.round(hours * 100) / 100 } })
    A.result(bot, { ev: 'iron_farm_take', at, items: got, iron, hours: Math.round(hours * 100) / 100, perHour: hours > 0.05 ? Math.round(iron / hours * 10) / 10 : null, totalIron: total })
    return true
  }

  // ---------------------------------------------------------------- the job type
  async function trade (bot, job, api, ctx2) {
    const P = job.params || {}
    if (P.work === 'survey') return await survey(bot, job, api, ctx2)
    return await tradeRound(bot, job, api, ctx2)
  }

  return {
    types: { trade },
    verbs: { collect_farm: async (bot, st, api) => await collectFarm(bot, st, api) }
  }
}
module.exports.TYPES = ['trade']
module.exports.VERBS = ['collect_farm']
