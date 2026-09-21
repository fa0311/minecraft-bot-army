// iron_miner.js -- the MINER role (delegate job `params.skill:"iron_miner"`); all mine logic lives in skills/lib/iron_core.js.
//
//   params.args read by this skill:
//     entrance {x,y,z,facing}  mine head (FEET cell of the left mouth lane on the pad; the second lane is to its right, stairs go down towards
//                              `facing` north|south|east|west). Missing -> settings.mineHead. Neither -> `mine_no_entrance`, the bot is handed back.
//     level    <y>             feet y of this squad's level (default: the cache's last level, else 16). 16 = iron/coal first, -54 = diamonds.
//     haulAt   20              raw iron that triggers a haul  ·  job:'surface' = only walk out (toSurface)  ·  job:'trip' = measure a stair round trip
//     job:'obsidian'           the OBSIDIAN trip (P4/P5): want 16 = obsidian the DEPOT shall hold · waterFrom [x,y,z] = open water where empty buckets are
//                              filled (the army's `fill` verb) · level <y> = only spots of that level (default: every dug level, deepest first).
//                              Kit: diamond pickaxe + 2 water buckets (missing -> `mine_not_ready`). Spot = the face of a finished branch in front of a
//                              lava lake; casting and mining: iron_core.js obsidianAt. Events: obsidian_cast {at,n} · obsidian_banked {n} · obsidian_no_lava.
//
// Loop: eat/defend -> a reason to go UP? (haul, no/worn pick, hungry: ALL through I.toSurface, then the depot) -> on the surface: READY to go down?
// (food >= 8 bread-equivalents, pickaxe + spare, torches >= 16 when there are any: `mine_not_ready` says what is missing, the normal
// withdraw/obtain path fetches it, a bot that still lacks it hands itself back) -> stairwell not down to the level yet: ONE bot digs it (lease),
// the others hand themselves back -> claim a branch -> walk the graph to its face -> mine it.
// Underground there is no pathfinder and no private tunnel: see iron_core.js (world 1: "採掘にいったbotが拠点に戻れない").
const U = require('./lib/util')
const I = require('./lib/iron_core')
const ARMY = require('./lib/army')

const jobRef = (bot) => { const a = ARMY.assignment(bot) || {}; return { id: bot.__armyJob || (a.job && a.job.id) || 'mine', rev: (a.job && a.job.rev) || 0 } }
// hand the bot back to the dispatcher for `ms` (it takes the next job it is eligible for) - nobody naps at the mine head waiting for something
// The task text says so TRUTHFULLY ("muster (handed back: ...)"): 09-20 02:47Z eight miners handed back from the worked-out mine were reported `hung
// task iron:start` within 3 s of each new assignment - the army's hang watchdog counts the minutes a bot stood at the muster and met the stale label.
function handBack (bot, ms, why) { try { if (bot.state) bot.state.task = 'muster (handed back: ' + String(why).slice(0, 60) + ')' } catch (e) { U.note(bot, 'warn', 'task: ' + String(e && e.message || e).slice(0, 60)) } try { ARMY.decline(bot, jobRef(bot), ms, why) } catch (e) { U.note(bot, 'warn', 'decline: ' + String(e && e.message || e).slice(0, 80)) } return { declined: why } }

// nothing to claim on this level for this bot's pick: ONE report per squad and 10 min (not one per bot: 47 bots said it 113 times in an hour), the
// bot is handed back for 10 min. The numbers tell the operator what to do: needPick > 0 = branches wait behind an ore face for an IRON pickaxe
// (smelt / craft one), all 0 = the level is worked out -> `armyctl.js mine level <y>`.
async function noBranch (bot, M, o) {
  o = o || I.branchOutlook(bot, M, (I.bestPick(bot) ? I.pickRank(I.bestPick(bot).name) : 2))
  // EVERY dug level at its limit (nothing free, waiting for a pick or in work - for ANY pick): the mine itself is worked out. Once an hour, for the board.
  const all = M.levels.filter(lv => M.G.levels[lv] && M.st.dug >= M.G.levels[lv].g).map(lv => I.branchOutlook(bot, M, 4, lv))
  if (all.length && all.every(q => !q.free && !q.needPick && !q.busy)) await I.sayMine(bot, M.E, 'mine_exhausted', 3600000, { ev: 'mine_exhausted', job: jobRef(bot).id, levels: M.levels, limit: { branchPairs: I.K_MAX, branchLen: I.MAX_BRANCH }, note: 'every level is at its limit (all mouths taken, every branch at full length or ended at a cave/liquid) AND the miners found no landing of the iron band left to open themselves (growLevel): open another level (armyctl.js mine level <y>, >= 3 from the others) or a second mine head' })
  await I.sayMine(bot, M.E, 'no_branch@' + M.level, 600000, { ev: 'mine_no_branch', job: jobRef(bot).id, level: M.level, needPick: o.needPick, busy: o.busy, note: o.needPick ? o.needPick + ' open branches wait for an iron pickaxe (ore face a stone pick cannot harvest)' : o.busy ? 'every open branch is claimed' : 'level worked out: open the next level (armyctl.js mine level <y>)' })
  return handBack(bot, o.busy && !o.needPick ? 180000 : 600000, 'mine: no branch for this pick on level ' + M.level + ' (need better pick: ' + o.needPick + ', claimed: ' + o.busy + ')')
}

// THE IRON BAND, one definition (iron spawns y -24..56, peak y16): the landings the squad works and may OPEN BY ITSELF while iron is short. A landing of
// the band that the BOARD names beats an old level's far ends (09-20 09:4xZ: the tie |32-16| = |0-16| sent every miner back to the last 6 branches of
// level 0, 220 blocks from the hub) - and a level the miners opened themselves (growLevel) is exactly such a board level.
const BAND = [-16, 48]
const rich = lv => lv >= BAND[0] && lv <= BAND[1]
// BY YIELD, NOT BY DEPTH AND NOT BY THE BOOK (owner 09-20: "ブランチマイニングのアルゴリズム悪いのでは？"). What a level pays is MEASURED - iron ore
// blocks per 100 cells advanced, from the branch ledger (I.levelYield). Until a level has been driven 400 cells the book stands in for it: iron peaks at
// y16 and falls off roughly linearly to nothing at y-24 and y56, scaled so the peak reads ~4 ore per 100 cells - the same unit, so the two compare.
const bookIron = lv => 4 * Math.max(0, 1 - Math.abs(lv - 16) / 40)
function ironYield (M, lv) { try { const q = I.levelYield((M.st.lv || {})[String(lv)]); return q.iron == null ? bookIron(lv) : q.iron } catch (e) { return bookIron(lv) } }
// WHICH LEVEL? The miners decide it themselves among the levels whose stairs are dug (09-19 23:37Z the job pointed at the worked-out level 16 while 66
// branches of level -54 lay open; 09-20 03:00Z iron stood at 8/224 while the squad was sent to y-48): while the army is short of IRON (stock group `iron`
// under settings.targets.iron) the iron-rich levels come first (nearest y16: 16, 0, -16 ...); else the board's level, then the deep ones (diamonds,
// redstone) for iron picks / the shallow ones for stone picks. PICK-AWARE (foreman 23:44Z): a stone pick goes below y-32 only as a QUARRYMAN while stone is
// wanted. The first level with a branch this bot could claim NOW (incl. the level's own growth, I.branchOutlook) wins; the cache's working level stays
// the board's (visit). -> M of that level | null = nothing anywhere
function ironWanted (bot) { try { const t = (ARMY.settings().targets || {}).iron || 0; return t > 0 && require('../army/stock.js').have('iron') < t } catch (e) { U.note(bot, 'warn', 'ironWanted: ' + String(e && e.message || e).slice(0, 60)); return false } }
async function pickLevel (bot, M, args, rank) {
  const board = Number.isFinite(args.level) ? Math.floor(args.level) : M.level
  const deepOk = rank >= 3 || I.stoneWanted()
  const iron = ironWanted(bot)
  const skip = bot.__ironLvSkip = bot.__ironLvSkip || {} // a level that just refused us (claimBranch null although the outlook said free): not again for a minute
  // THE BOARD'S LEVEL FIRST WHEN IT IS IRON-RICH ITSELF (09-20 09:4xZ: levels 16/0/-16 at the cap of 160 branches x 256, the operator opened y32 - and the tie
  // |32-16| = |0-16| sent every miner back to the 6 last branches of level 0, 220 blocks from the hub): a fresh landing in the iron BAND beats old far ends.
  const order = M.levels.slice().sort((a, b) => iron ? ((((b === board && rich(b)) ? 1 : 0) - ((a === board && rich(a)) ? 1 : 0)) || (ironYield(M, b) - ironYield(M, a)) || (Math.abs(a - 16) - Math.abs(b - 16))) : (((b === board) - (a === board)) || (rank >= 3 ? a - b : b - a)))
  for (const lv of order) {
    if ((lv < -32 && !deepOk) || (skip[lv] || 0) > Date.now() || !M.G.levels[lv] || M.st.dug < M.G.levels[lv].g || !I.branchOutlook(bot, M, rank, lv).free) continue
    if (lv === M.level) return M
    const M2 = await I.mine(bot, Object.assign({}, args, { level: lv }), lv === board ? {} : { visit: true })
    if (!M2 || M2.level !== lv) continue
    if (lv !== board) await I.sayMine(bot, M.E, 'level_fallback@' + board + '>' + lv, 1800000, { ev: 'mine_level_fallback', job: jobRef(bot).id, from: board, to: lv, why: iron ? 'iron wanted' : 'no branch', note: iron ? 'the army is short of iron (settings.targets.iron): miners work the iron-rich levels first, level ' + lv + ' now' : 'level ' + board + ' has no branch for this pick; miners work the open branches of level ' + lv })
    return M2
  }
  return null
}

// MINE GROWTH WITHOUT AN OPERATOR (docs/BUGS.md 09-20 09:5xZ). Every DUG level of the band the army needs NOW is EXHAUSTED (I.exhausted: every trunk mouth
// taken, every branch at MAX_BRANCH, none open - neither a claim nor the level's own growth can do anything there), so the squad opens the NEXT landing
// itself instead of falling back to the last branches 220 blocks out or to iron-poor y-32. Band: iron short -> BAND, else the board's level alone; deeper
// than the band only for an iron pick or while stone is wanted, as ever. Asked BEFORE pickLevel - the point is not to fall back at all. The new level goes
// ON THE BOARD the way `armyctl.js mine level` writes it (params.args.level + rev, so `armyctl.js mine`, the digest and the other miners see the truth),
// at most ONE per hour for the whole squad (I.claimGrowth: no flapping between landings when eleven miners see the same second). Then the existing
// "NEW level" path does the work: this bot takes the stair lease - or, when that landing is already dug, walks down and cuts the hub with walkTrunk - while
// the others keep the branches that are left. The board's own order is never overruled while it still has work. -> M of the new level | null.
async function growLevel (bot, M, args, rank) {
  const board = Number.isFinite(args.level) ? Math.floor(args.level) : M.level
  const bg = M.G.levels[board]
  if (!bg || M.st.dug < bg.g || I.branchOutlook(bot, M, 4, board).free > 0) return null // the board's level is still being dug / still has a branch to give out (a diamond level at y-54)
  const iron = ironWanted(bot)
  const band = iron ? BAND : [board, board]
  const dug = M.levels.filter(lv => lv >= band[0] && lv <= band[1] && M.G.levels[lv] && M.st.dug >= M.G.levels[lv].g)
  // FREE, not merely un-exhausted: a level whose last six branches are all CLAIMED has nothing for the miner standing here either (12:3xZ gemba: y32 at
  // the cap, y0 with 6 claimed branches 200 blocks out -> `mine_level_fallback 32 -> -32`, an iron-poor level 300 blocks from the hub). `free` counts
  // the level's own growth (branchOutlook), so free = 0 everywhere in the band means exactly "no free branch and none that can grow".
  if (!dug.length || dug.some(lv => I.branchOutlook(bot, M, 4, lv).free > 0)) return null
  const y = I.nextLanding(M, rank >= 3 || I.stoneWanted() ? -48 : BAND[0], BAND[1], iron ? I.LEVEL_Y : board)
  if (y == null || !await I.claimGrowth(M.E, y)) return null // nothing left to open (noBranch says `mine_exhausted`) / somebody opened a level within the hour
  const M2 = await I.mine(bot, Object.assign(args, { level: y })) // args.level: this bot works the new level from here on; the cache's levelY follows it (armyctl `mine`)
  if (!M2 || M2.level !== y) return null // refused after all (`mine_level_refused`): the hour's stamp stays and the caller falls back as before
  const why = 'no free branch on any dug level of y' + band[0] + '..' + band[1] + ' (' + dug.join(', ') + '): every mouth of ' + 2 * I.K_MAX + ' is taken or claimed and nothing can grow (' + I.MAX_BRANCH + ' blocks)'
  let onBoard = false // the ORDER moves too, not just this bot: params.args.level + rev (the rev ends the squad's slices, so every miner re-reads the level within seconds)
  ARMY.boardEdit(b => { const j = (b.jobs || []).find(x => x.id === jobRef(bot).id); if (!j) return; j.params = j.params || {}; j.params.args = Object.assign({}, j.params.args, { level: y }); j.rev = (j.rev || 0) + 1; j.note = 'mine growth ' + new Date().toISOString().slice(11, 16) + 'Z: level y' + y + ' opened by ' + bot.username + ' (' + why + ')'; onBoard = true })
  ARMY.result(bot, { ev: 'mine_level_opened', job: jobRef(bot).id, level: y, from: board, why, board: onBoard, note: 'the miners opened this landing themselves (at most one per hour): one takes the stair lease, the rest work what branches are left. Wrong level? `armyctl.js mine level <y>` overrules it' })
  return M2
}

// what stays in the pockets at the bank: the kit. Wood and food are matched by KIND, never by species (world 1 kept only spruce and bread)
function kitKeep (bot, ob) {
  const keep = { stone_pickaxe: 2, iron_pickaxe: 2, diamond_pickaxe: 1, torch: 48, cobblestone: 48, cobbled_deepslate: 24, stick: 16, crafting_table: 1, coal: 12, charcoal: 12 }
  for (const i of bot.inventory.items()) {
    if (U.LOG_RE.test(i.name)) keep[i.name] = 3; else if (U.PLANK_RE.test(i.name)) keep[i.name] = 8
    else if (bot.registry.foodsByName[i.name] && !/rotten_flesh|spider_eye|poisonous|pufferfish/.test(i.name)) keep[i.name] = 24
  }
  if (ob) { keep.water_bucket = 2; keep.bucket = 2 }
  return keep
}

// everything that happens at the depot: bank the haul (RAW: the quartermaster runs the furnaces - nobody waits at one), take the kit for the next
// descent. Surface legs are the army's read-only travel (bank/withdraw/obtain walk by themselves).
async function baseVisit (bot, why, ob) { // ob = the args of an obsidian trip: its kit on top of the miner's
  bot.state.task = 'iron:base(' + why + ')'
  const job = jobRef(bot).id
  const before = { raw_iron: U.count(bot, 'raw_iron'), iron_ingot: U.count(bot, 'iron_ingot'), diamond: U.count(bot, 'diamond'), coal: U.count(bot, 'coal'), obsidian: U.count(bot, 'obsidian') }
  // ONE bank for the whole army (category chests, the chest index stays true, a `banked` event tells the board what the mine delivered; it also
  // wears/fetches better armour and a sword: A.kitUp, first call for risk jobs)
  try { await ARMY.bank(bot, kitKeep(bot, ob), { job, risk: true }) } catch (e) { U.note(bot, 'warn', 'bank: ' + String(e && e.message || e).slice(0, 80)) }
  const delivered = {}; for (const [k, n] of Object.entries(before)) { const d = n - U.count(bot, k); if (d > 0) delivered[k] = d }
  if (Object.keys(delivered).length) await I.ledger({ bot: bot.username, type: 'bank', delivered })
  if (delivered.obsidian) ARMY.result(bot, { ev: 'obsidian_banked', job, n: delivered.obsidian, stock: ARMY.stockOf('obsidian') })
  I.bump(bot, 'rawDelivered', delivered.raw_iron || 0)
  const stop = () => I.stale(bot)
  const draw = async (names, n) => { let got = 0; for (const nm of names) { if (got >= n || stop()) break; if (ARMY.stockOf(nm) > 0) got += (await ARMY.withdraw(bot, nm, n - got, { ms: 60000, stop })) || 0 } return got }
  // the BEST the depot has goes down the mine (world 1: 43 diamonds in the depot while 8 miners dug deepslate with stone picks, 131 uses each)
  if (!U.has(bot, 'diamond_pickaxe')) await draw(['diamond_pickaxe'], 1)
  if (ob) {
    // obsidian wants a DIAMOND pickaxe (depot, else crafted: 3 diamonds + 2 sticks through the army's obtain) and water in buckets: full ones from the
    // depot, else empty ones (depot / 3 iron ingots) filled at args.waterFrom with the army's own `fill` verb (one implementation of bucket work)
    if (!I.diamondPick(bot) && !stop()) await ARMY.obtain(bot, 'diamond_pickaxe', 1, { stop })
    if (U.count(bot, 'water_bucket') < 2) await draw(['water_bucket'], 2 - U.count(bot, 'water_bucket'))
    const lack = () => 2 - U.count(bot, 'water_bucket') - U.count(bot, 'bucket')
    if (lack() > 0) await draw(['bucket'], lack())
    if (U.count(bot, 'water_bucket') + U.count(bot, 'bucket') < 1 && !stop()) await ARMY.obtain(bot, 'bucket', 1, { stop })
    if (U.count(bot, 'bucket') > 0 && U.count(bot, 'water_bucket') < 2 && Array.isArray(ob.waterFrom) && ob.waterFrom.length === 3) {
      bot.state.task = 'iron:base(water)'
      try {
        const fill = require('./lib/army_jobs')._internals.VERBS.fill
        for (let i = 0; i < 2 && U.count(bot, 'bucket') > 0 && U.count(bot, 'water_bucket') < 2 && !stop(); i++) { const r = await fill(bot, { at: ob.waterFrom, radius: 12 }, { stop }); if (r !== true) { U.note(bot, 'warn', 'obsidian kit: fill -> ' + String(r).slice(0, 100)); break } }
      } catch (e) { U.note(bot, 'warn', 'obsidian kit: fill: ' + String(e && e.message || e).slice(0, 80)) }
      bot.state.task = 'iron:base(' + why + ')'
    }
  }
  if (I.pickaxes(bot).length < 2) await draw(['iron_pickaxe', 'stone_pickaxe'], 2 - I.pickaxes(bot).length)
  // the miners' own iron pickaxe (250 uses) once the bank holds a cushion of ingots
  if (!bot.inventory.items().some(i => /^(iron|diamond|netherite)_pickaxe$/.test(i.name)) && ARMY.stockOf('iron_ingot') >= 12 && await ARMY.obtain(bot, 'iron_pickaxe', 1, { stop })) { I.bump(bot, 'ironPicks'); await I.ledger({ bot: bot.username, type: 'spend', item: 'iron_pickaxe', ingots: 3 }) }
  if (!I.bestPick(bot)) { if (!await ARMY.obtain(bot, 'stone_pickaxe', 1, { stop })) await ARMY.obtain(bot, 'wooden_pickaxe', 1, { stop }) }
  // what makes the NEXT pick down there: sticks + a table in the pocket (stone is underground). The table is placed in a niche and taken back.
  if (U.count(bot, 'stick') < 8) await ARMY.obtain(bot, 'stick', 8, { stop })
  if (!U.has(bot, 'crafting_table')) await ARMY.obtain(bot, 'crafting_table', 1, { stop })
  if (U.count(bot, 'torch') < 16) await ARMY.obtain(bot, 'torch', 32, { stop }) // coal OR charcoal + any sticks (A.obtain); lights the stairwell and the trunk
  // REAL STAIRS: while a climb still counts jumped blocks (iron_mine.json `treadsLeft`), every miner takes 32 stair blocks down (6 cobbled deepslate -> 4, the depot
  // holds thousands) and lays up to 8 rows on its way UP (I.walkRoute). Nothing is fetched once the stairwell is done.
  try { const ms = I.read() || {}; const cm = I.cur(); const left = cm ? (ms.treadsLeftBy || {})[String(cm.level)] : ms.treadsLeft; if (ms.treadsOK === true && (left == null || left > 0) && !I.stairItem(bot) && !stop()) await ARMY.obtain(bot, 'cobbled_deepslate_stairs', 32, { stop }) } catch (e) { U.note(bot, 'warn', 'treads: ' + String(e && e.message || e).slice(0, 60)) }
  if (I.cobbleCount(bot) < 24) await draw(['cobblestone', 'cobbled_deepslate'], 48 - I.cobbleCount(bot)) // stair repairs, trunk floors and lava plugs need a block in hand (03:05Z: a miner mended 13 stair cells on the way down and stood in the new trunk with `no_filler`)
  if (I.foodUnits(bot) < 10) {
    const w = (() => { try { return require('../army/stock.js').groups.food } catch (e) { U.note(bot, 'warn', 'stock.js: ' + String(e && e.message || e).slice(0, 60)); return () => 0 } })()
    const foods = Object.keys(ARMY.stockMap()).filter(n => w(n) > 0 && bot.registry.foodsByName[n] && !/^(wheat|hay_block)$/.test(n)).sort((a, b) => w(b) - w(a))
    for (const n of foods) { if (I.foodUnits(bot) >= 10 || stop()) break; await draw([n], Math.ceil((10 - I.foodUnits(bot)) / w(n))) }
  }
  await ARMY.kitUp(bot, { risk: true, why: 'mine', stop })
  await I.eat(bot)
  bot.__ironLastBase = Date.now()
}

// THE OBSIDIAN TRIP (args.job:'obsidian'): bank what we carry -> the depot has `want`? done -> kit (diamond pickaxe, water buckets; refuse with
// `mine_not_ready`) -> claim a spot (a branch face at a lava lake: on record, or a cave end of a deep level worth a look) -> down the graph to its face
// -> I.obsidianAt (look, cast, mine the sheet) -> next spot, or up the graph for a reason (enough, hurt, kit, hungry, no spot) -> bank.
async function obsidianJob (bot, args, gen) {
  const stale = () => I.stale(bot, gen)
  const job = jobRef(bot).id
  const want = Math.max(1, Math.min(128, Math.floor(args.want || 16)))
  const onlyLevel = Number.isFinite(args.level) ? Math.floor(args.level) : null
  const base = Object.assign({}, args); delete base.level // the board's WORKING level belongs to the mine job: we only ever VISIT levels
  bot.state.task = 'iron:base(obsidian start)'
  let M = await I.mine(bot, base)
  if (!M) return handBack(bot, 600000, 'mine_no_entrance (see events)')
  let up = null // a reason to go up that the spot work found
  while (!stale()) {
    await U.sleep(400)
    try {
      if (!bot.entity || bot.health <= 0) { await U.sleep(1500); continue }
      I.refresh(M)
      I.hb(bot, { stats: bot.__ironStats, gen, level: M.level, obsidian: U.count(bot, 'obsidian') })
      await I.eat(bot)
      if (await I.defend(bot, gen)) continue
      const under = I.underground(bot, M)
      const have = U.count(bot, 'obsidian')
      const need = want - ARMY.stockOf('obsidian') // what the depot still lacks
      if (under) {
        if (U.freeSlots(bot) <= 2) await I.tossJunk(bot, true)
        const why = up || (have > 0 && have >= need ? 'haul' : bot.health < 12 ? 'hurt' : I.obsidianReady(bot).missing.length ? 'kit' : I.exitReason(bot))
        if (why) {
          bot.state.task = 'iron:obsidian up(' + why + ')'
          const r = await I.toSurface(bot, { gen, mine: M, why: 'obsidian_' + why })
          if (!r.ok) { U.note(bot, 'warn', 'cannot surface (' + why + '): ' + r.why); await U.nap(bot, 5000) } else up = null
          continue
        }
      } else {
        up = null
        if (have > 0) { await baseVisit(bot, 'obsidian', args); if (stale()) break }
        if (ARMY.stockOf('obsidian') >= want) {
          await I.sayMine(bot, M.E, 'obsidian_done', 1800000, { ev: 'obsidian_done', job, stock: ARMY.stockOf('obsidian'), want, note: 'the depot holds what the job wants: raise params.args.want or pause the job' })
          return handBack(bot, 1800000, 'obsidian: the depot holds ' + ARMY.stockOf('obsidian') + ' >= ' + want)
        }
        if (bot.health < 12) return handBack(bot, 600000, 'obsidian: hurt (hp ' + Math.round(bot.health) + ')')
        const o = I.obsidianOutlook(bot, M, onlyLevel)
        if (!o.n) {
          await I.sayMine(bot, M.E, 'obsidian_no_lava', 1800000, { ev: 'obsidian_no_lava', job, levels: M.levels, note: 'no branch face at a lava lake is left on record (every candidate is none/deep/done - see obs.state in bots/iron_mine.json): dig a deeper level (armyctl.js mine level -54) or wait for miners to meet lava' })
          return handBack(bot, 1800000, 'obsidian: no lava spot on record')
        }
        let rd = { missing: I.readiness(bot).missing.concat(I.obsidianReady(bot).missing), short: I.obsidianReady(bot).short }
        if (rd.missing.length || (rd.short.length && Date.now() - (bot.__ironKitT || 0) > 10 * 60000)) {
          bot.__ironKitT = Date.now()
          await baseVisit(bot, 'kit', args)
          if (stale()) break
          rd = { missing: I.readiness(bot).missing.concat(I.obsidianReady(bot).missing), short: I.obsidianReady(bot).short }
          if (rd.missing.length) { ARMY.result(bot, { ev: 'mine_not_ready', job, missing: rd.missing, short: rd.short, note: 'obsidian needs a DIAMOND pickaxe and water buckets (armyctl.js recipe diamond_pickaxe / bucket; params.args.waterFrom = open water): bot handed back' }); return handBack(bot, 600000, 'obsidian: missing ' + rd.missing.join('+')) }
        }
      }
      // ---- a spot, the way to its face, the work
      const spot = await I.claimObsidianSpot(bot, M, onlyLevel)
      if (!spot) { if (under) up = 'no_spot'; continue }
      const Ms = await I.mine(bot, Object.assign({}, base, { level: spot.level }), { visit: true })
      if (!Ms || Ms.level !== spot.level) { await I.saveSpot(Object.assign({}, M, { level: spot.level }), spot.key, { state: 'retry', why: 'level not available', until: Date.now() + 20 * 60000 }); continue }
      M = Ms
      bot.state.task = under ? 'iron:to-branch' : 'iron:to-entrance'
      if (!under && !await I.toEntrance(bot, M, gen)) { I.blocked(bot, 'no_way_to_entrance'); await U.nap(bot, 5000); continue }
      if (!await I.gotoBranchFace(bot, M, spot, gen)) {
        if (stale()) continue
        const lf = bot.__ironLineFail; const sf = bot.__ironStairFail
        U.note(bot, 'warn', 'cannot reach obsidian spot ' + spot.level + '/' + spot.key + ': ' + ((lf && lf.why) || (sf && sf.why) || '?'))
        const lost = !!lf && (lf.why === 'off_line' || lf.why === 'off_level')
        if (!lost) await I.saveSpot(M, spot.key, { state: 'retry', why: 'unreachable: ' + ((lf && lf.why) || (sf && sf.why) || '?'), until: Date.now() + 20 * 60000 })
        if (lost && I.underground(bot, M)) await I.toSurface(bot, { gen, mine: M, why: 'lost' }); else await U.nap(bot, 3000)
        continue
      }
      const res = await I.obsidianAt(bot, M, spot, gen, { want: Math.max(1, need - have) })
      I.hb(bot, { lastSpot: Object.assign({ level: spot.level, key: spot.key, t: Date.now() }, res), stats: bot.__ironStats })
      if (res.state === 'open' && /diamond|water/.test(res.why || '')) up = 'kit'
      if (!I.locate(M.G, I.feet(bot)) && I.underground(bot, M)) await I.toSurface(bot, { gen, mine: M, why: 'lost' })
    } catch (e) {
      if (e && e.cancelled) break
      U.note(bot, 'warn', 'obsidian loop: ' + String(e && e.stack || e).slice(0, 300))
      try { bot.clearControlStates() } catch (e2) { U.note(bot, 'warn', 'clear: ' + String(e2 && e2.message || e2).slice(0, 60)) }
      await U.sleep(1500)
    }
  }
  try { bot.clearControlStates() } catch (e) { U.note(bot, 'warn', 'clear: ' + String(e && e.message || e).slice(0, 60)) }
  return { ended: true, stats: bot.__ironStats }
}

const HOOK_V = 2
const hotHere = (bot) => { const e = bot.entity; if (!e) return null; const f = e.position.floored(); const names = [0, 1].map(dy => (bot.blockAt(f.offset(0, dy, 0)) || {}).name); if (e.isInLava || names.includes('lava')) return 'lava'; if (names.some(n => n === 'fire' || n === 'soul_fire')) return 'fire'; return null }
const onFire = (bot) => { try { const m = bot.entity && bot.entity.metadata; return !!m && (Number(m[0]) & 1) === 1 } catch { return false } }
// which branch does this belong to: the one the position lies on / beside, else the claim we were walking to or working
function branchOf (bot, p) {
  const M = I.cur(); if (!M || !p) return null
  const hit = I.branchAt(M.G, p); if (hit) return { M, level: hit.level, key: hit.key }
  const cl = bot.__ironClaim; const task = String((bot.state && bot.state.task) || '')
  if (cl && /^iron:(to-face|repair|branch) /.test(task) && Math.abs(p.y - cl.level) <= 3) return { M, level: cl.level, key: cl.key }
  return null
}
function onDeath (bot) {
  if (!bot.__ironLegacyDeath) bot.__ironGen = (bot.__ironGen || 0) + 1
  try {
    const p = bot.entity && bot.entity.position
    const at = p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null
    if (!bot.__ironLegacyDeath) {
      I.bump(bot, 'deaths')
      bot.clearControlStates()
      I.ledger({ bot: bot.username, type: 'death', pos: at, task: bot.state && bot.state.task }).catch(e => U.note(bot, 'warn', 'ledger: ' + String(e && e.message || e).slice(0, 60)))
    }
    const br = p ? branchOf(bot, p.floored()) : null
    if (!br) return
    const burn = bot.__ironBurn && Date.now() - bot.__ironBurn.t < 8000 ? bot.__ironBurn.kind : (hotHere(bot) || (onFire(bot) ? 'fire' : null))
    bot.__ironSkip = bot.__ironSkip || {}; bot.__ironSkip[br.level + '/' + br.key] = Date.now() + 3600000 // whatever killed us: not our next claim
    if (burn) I.markHazard(bot, br.M.E, br.level, br.key, { kind: burn, at, died: true }).catch(e => U.note(bot, 'warn', 'hazard: ' + String(e && e.message || e).slice(0, 60)))
    else I.update(br.M.E, d => { const b = I.lvState(d, br.level).branches[br.key]; if (b && b.owner === bot.username) { b.owner = null; b.t = 0 } }).catch(e => U.note(bot, 'warn', 'release: ' + String(e && e.message || e).slice(0, 60)))
  } catch (e) { U.note(bot, 'warn', 'death hook: ' + String(e && e.message || e).slice(0, 80)) }
}
function onHealth (bot) {
  try {
    const hp = bot.health; const last = bot.__ironHp; bot.__ironHp = hp
    if (!(hp < last) || hp <= 0 || !bot.entity) return
    const here = hotHere(bot); const kind = here || (onFire(bot) ? 'fire' : null)
    if (!kind) return
    const p = bot.entity.position.floored()
    bot.__ironBurn = { t: Date.now(), kind: here || 'lava', at: [p.x, p.y, p.z] } // on fire with nothing hot in our cell = we just came out of it
    if (!/^iron:/.test(String((bot.state && bot.state.task) || '')) || Date.now() - (bot.__ironBurnActed || 0) < 15000) return
    bot.__ironBurnActed = Date.now()
    const br = branchOf(bot, p)
    if (br) I.markHazard(bot, br.M.E, br.level, br.key, { kind: bot.__ironBurn.kind, at: bot.__ironBurn.at }).catch(e => U.note(bot, 'warn', 'hazard: ' + String(e && e.message || e).slice(0, 60)))
    if (!here) return
    // STANDING IN IT: the routine that walked us here ends (gen bump), and we swim/run for the branch mouth (else straight back) for up to 4 s
    bot.__ironGen = (bot.__ironGen || 0) + 1
    let to = null
    if (br) { const q = br.key.split(':').map(Number); const hub = br.M.G.levels[br.level] && br.M.G.levels[br.level].hub; if (hub) to = I.branchCell(hub, q[0], q[1], 0) }
    bot.__ironEscape = (async () => {
      const t0 = Date.now()
      try {
        try { bot.pathfinder.setGoal(null) } catch (e) { U.note(bot, 'warn', 'escape goal: ' + String(e && e.message || e).slice(0, 40)) }
        const yaw = to ? Math.atan2(-(to.x + 0.5 - bot.entity.position.x), -(to.z + 0.5 - bot.entity.position.z)) : bot.entity.yaw + Math.PI
        while (Date.now() - t0 < 4000 && bot.entity && bot.health > 0) { // (the next run of this skill waits for us: bot.__ironEscape)
          await bot.look(yaw, 0, true)
          bot.setControlState('forward', true); bot.setControlState('jump', true); bot.setControlState('sprint', true)
          await U.sleep(100)
          if (!hotHere(bot) && Date.now() - t0 > 1500) break
        }
      } finally { try { bot.clearControlStates() } catch (e) { U.note(bot, 'warn', 'clear: ' + String(e && e.message || e).slice(0, 40)) } bot.__ironEscape = null }
    })()
    bot.__ironEscape.catch(e => U.note(bot, 'warn', 'escape: ' + String(e && e.message || e).slice(0, 60)))
  } catch (e) { U.note(bot, 'warn', 'health hook: ' + String(e && e.message || e).slice(0, 80)) }
}

module.exports = async (bot, args = {}, ctx) => {
  const gen = (bot.__ironGen = (bot.__ironGen || 0) + 1)
  bot.state.cancel = false
  if (args.job !== 'surface') bot.__ironArgs = args // a later recall (army_jobs upTheStairs -> I.toSurface) finds the same mine
  if (args.haulAt) bot.__ironHaulAt = args.haulAt
  // a DEATH ends the running routine (gen bump -> stale): world 1's walkLine carried on from the respawn point on the SURFACE towards the old x,z.
  // The respawned bot starts a fresh run: kit -> mine head -> down the stairs. Never a path "back to where I died".
  // + THE BRANCH REMEMBERS (09-20: 11 lava deaths in a row at the face of -32 67:1 - the respawned miner resumed "its own branch" every 3 min): a death
  // on / beside a branch releases the claim and this bot does not get that branch again; burned (lava, fire) -> `hazard` on the branch record
  // (I.markHazard: nobody mines it, one repair by another miner). A burn while ALIVE does the same, ends the routine and runs for the branch mouth.
  if (bot.__ironHookV !== HOOK_V) {
    if (bot.__ironDeathHook === true && !bot.__ironDeathFn) bot.__ironLegacyDeath = true // a closure of the older code is installed and stays: it does the gen bump + ledger
    bot.__ironDeathHook = true; bot.__ironHookV = HOOK_V
    if (bot.__ironDeathFn) bot.removeListener('death', bot.__ironDeathFn)
    if (bot.__ironHealthFn) bot.removeListener('health', bot.__ironHealthFn)
    bot.__ironDeathFn = () => onDeath(bot)
    bot.__ironHealthFn = () => onHealth(bot)
    bot.on('death', bot.__ironDeathFn)
    bot.on('health', bot.__ironHealthFn)
  }
  if (bot.__ironEscape) { try { await bot.__ironEscape } catch (e) { U.note(bot, 'warn', 'escape: ' + String(e && e.message || e).slice(0, 60)) } }
  const stale = () => I.stale(bot, gen)
  try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e) { U.note(bot, 'warn', 'reset: ' + String(e && e.message || e).slice(0, 60)) }

  if (args.job === 'surface') { // the army takes a miner off the job: leave by the stairs, never through the rock
    bot.state.task = 'iron:surface(recall)'
    const r = await I.toSurface(bot, { gen, args: bot.__ironArgs || args, why: 'recall' })
    return { surfaced: r.ok, was: r.was, why: r.why, pos: r.pos, fail: r.fail }
  }

  if (args.job === 'obsidian') return obsidianJob(bot, args, gen)

  bot.state.task = 'iron:base(start)' // reading the mine's books at the mine head: a task that legitimately stands still
  let M = await I.mine(bot, args)
  if (!M) return handBack(bot, 600000, 'mine_no_entrance / bad level (see events)')

  if (args.job === 'trip') {
    if (M.st.dug < M.lv.g) return { error: 'stairs not down to level ' + M.level + ' yet' }
    bot.state.task = 'iron:trip'
    if (I.underground(bot, M)) { if (!(await I.toSurface(bot, { gen, mine: M, why: 'trip' })).ok) return { error: 'cannot surface' } }
    if (args.treads && !I.stairItem(bot)) { bot.state.task = 'iron:base(treads)'; await ARMY.obtain(bot, 'cobbled_deepslate_stairs', 64, { stop: () => I.stale(bot, gen) }); if (!I.bestPick(bot)) await ARMY.obtain(bot, 'stone_pickaxe', 1, { stop: () => I.stale(bot, gen) }); bot.state.task = 'iron:trip' }
    if (!await I.toEntrance(bot, M, gen)) return { error: 'cannot reach entrance' }
    const t0 = Date.now()
    const okD = await I.walkRoute(bot, M, I.routeDown(M.G, M.level), gen, { near: 4 })
    const t1 = Date.now()
    const okU = await I.walkRoute(bot, M, I.routeUp(M.G, M.level), gen, { near: 4 })
    const rec = { bot: bot.username, t: t0, level: M.level, downS: (t1 - t0) / 1000, upS: (Date.now() - t1) / 1000, okD, okU, steps: M.E.y - M.level, treads: (bot.__ironStats || {}).treads || 0, treadsLeft: (I.refresh(M) || {}).treadsLeft }
    await I.update(M.E, d => { d.trips = (d.trips || []).concat([rec]).slice(-20) })
    return rec
  }

  // survives the worker's 15-min slices (a local variable restarted the haul clock at every slice, so the timed haul never came)
  if (!bot.__ironLastBase) bot.__ironLastBase = Date.now()
  while (!stale()) {
    await U.sleep(400)
    try {
      if (!bot.entity || bot.health <= 0) { await U.sleep(1500); continue }
      I.refresh(M)
      I.hb(bot, { stats: bot.__ironStats, gen, level: M.level })
      await I.eat(bot)
      if (await I.defend(bot, gen)) continue
      const under = I.underground(bot, M)

      // ---- craft a pick on the spot when the last one is gone (stone is everywhere down here)
      if (!I.bestPick(bot) && I.canCraftPick(bot)) { bot.state.task = 'iron:craftPick'; await I.ensurePick(bot, 1); if (I.bestPick(bot)) continue }

      // ---- UP for a reason - always by the graph (I.toSurface), then the depot
      const ex = I.exitReason(bot) || (!under && U.count(bot, 'raw_iron') + U.count(bot, 'iron_ingot') > 0 && Date.now() - bot.__ironLastBase > 60000 ? 'haul' : null)
      if (ex) {
        const t0 = Date.now()
        // junk stone stays IN THE MINE (world 1: 4105 cobbled_deepslate + 356 tuff per hour were carried up 140 steps into the warehouse): I.toSurface
        // drops it before the first step - on EVERY way up, also the army's recall
        if (under) { const r = await I.toSurface(bot, { gen, mine: M, why: ex }); if (!r.ok) { U.note(bot, 'warn', 'cannot surface (' + ex + '): ' + r.why); await U.nap(bot, 5000); continue } }
        const t1 = Date.now()
        await baseVisit(bot, ex)
        I.hb(bot, { lastHaul: { t: Date.now(), why: ex, upS: (t1 - t0) / 1000, baseS: (Date.now() - t1) / 1000 } })
        if (ex !== 'haul' && I.exitReason(bot) === ex) return handBack(bot, 600000, 'mine: ' + ex + ' and the depot cannot fix it') // no pick / no food anywhere: other work until there is
        continue
      }

      // ---- is there WORK for this bot down there? Asked on the surface BEFORE any kit is fetched (09-19: 50 bots in turn drew a kit, found no branch
      // at the mine head and banked the kit again). The rank is the best pick this bot holds or the depot can give it (a stone pick at least).
      if (!under) {
        const bp = I.bestPick(bot)
        const rank = Math.max(2, bp ? I.pickRank(bp.name) : 0, ARMY.stockOf('diamond_pickaxe') > 0 ? 4 : 0, (ARMY.stockOf('iron_pickaxe') > 0 || ARMY.stockOf('iron_ingot') >= 12) ? 3 : 0)
        // growth FIRST: when the band the army needs is worked out, a new landing beats any fallback to far ends / iron-poor depths (pickLevel)
        const M2 = await growLevel(bot, M, args, rank) || await pickLevel(bot, M, args, rank)
        if (M2) M = M2
        else {
          // nothing on any dug level: is the BOARD's level still to be dug (a new `mine level`)? then its stairwell is the work (one digger, below)
          const Mb = await I.mine(bot, args)
          if (Mb && Mb.st.dug < Mb.lv.g) M = Mb; else return noBranch(bot, M, I.branchOutlook(bot, M, rank))
        }
      }

      // ---- READY to go down? (checked on the surface only: nobody turns round on the stairs for a torch)
      if (!under) {
        let rd = I.readiness(bot)
        if (rd.missing.length || (rd.short.length && Date.now() - (bot.__ironKitT || 0) > 10 * 60000)) {
          U.note(bot, 'info', 'mine kit: missing ' + rd.missing.join('+') + ' short ' + rd.short.join('+') + ' - fetching from the depot') // routine, no board event
          bot.__ironKitT = Date.now()
          await baseVisit(bot, 'kit')
          if (stale()) break
          rd = I.readiness(bot, { afterDepot: true }) // we HAVE stood at the chests now: a shift's worth in the pocket beats an empty mine (readiness)
          if (rd.missing.length) { ARMY.result(bot, { ev: 'mine_not_ready', job: jobRef(bot).id, missing: rd.missing, short: rd.short, note: 'the depot could not supply it: bot handed back' }); return handBack(bot, 600000, 'mine: missing ' + rd.missing.join('+')) }
          if (rd.short.length) ARMY.result(bot, { ev: 'mine_kit_short', job: jobRef(bot).id, short: rd.short, note: 'not available in the depot: going down without' })
        }
      }

      // ---- the stairwell is not down to our level yet: ONE digger (lease); everybody else does other work meanwhile
      if (M.st.dug < M.lv.g) {
        if (!await I.claimStairs(bot, M)) return handBack(bot, 180000, 'stairwell to y ' + M.level + ' is being dug by ' + ((M.st.stairLease || {}).owner || 'another bot'))
        bot.state.task = 'iron:stairs'
        if (!await I.toEntrance(bot, M, gen)) { I.blocked(bot, 'no_way_to_entrance'); await U.nap(bot, 5000); continue }
        const r = await I.digStairs(bot, M, gen, { maxMs: 240000 })
        U.note(bot, 'info', 'stairs: ' + r + ' (dug ' + I.refresh(M).dug + '/' + M.lv.g + ')')
        // blocked TWICE in a row at the same place = this bot cannot mend it from here (no filler, a void out of reach, a block it cannot dig): it
        // said why ONCE (stair_broken unrepaired, reason) - now up the stairs and other work; the lease lapses, the next digger comes with a fresh kit.
        // (09-19 20:29Z: the digger retried every 5 s for an hour - 39 identical reports in 3 min - while the whole base waited for the mine.)
        if (r === 'blocked') {
          const sf = bot.__ironStairFail || {}; const sig = sf.why + '@' + (sf.g != null ? sf.g : '?')
          bot.__ironStairBlocked = bot.__ironStairBlocked && bot.__ironStairBlocked.sig === sig ? { sig, n: bot.__ironStairBlocked.n + 1 } : { sig, n: 1 }
          if (bot.__ironStairBlocked.n >= 2) {
            bot.__ironStairBlocked = null
            await I.update(M.E, d => { if (d.stairLease && d.stairLease.owner === bot.username) d.stairLease = null })
            if (I.underground(bot, M)) await I.toSurface(bot, { gen, mine: M, why: 'stairs_blocked' })
            return handBack(bot, 600000, 'stairwell blocked at group ' + sf.g + ': ' + (sf.reason || sf.why || '?'))
          }
          await U.nap(bot, 4000)
        } else bot.__ironStairBlocked = null
        continue // 'notool' -> exitReason sends it up next round
      }

      // ---- branch mining (task labels say the LEG we are on: descend -> trunk <key> -> to-face <key> -> branch <key>; set in gotoBranchFace)
      bot.state.task = under ? 'iron:to-branch' : 'iron:to-entrance'
      if (!under && !await I.toEntrance(bot, M, gen)) { I.blocked(bot, 'no_way_to_entrance'); await U.nap(bot, 5000); continue }
      const br = await I.claimBranch(bot, M)
      bot.__ironClaim = br ? { level: M.level, key: br.key, t: Date.now() } : null
      if (!br) {
        (bot.__ironLvSkip = bot.__ironLvSkip || {})[M.level] = Date.now() + 60000
        const M2 = await pickLevel(bot, M, args, Math.max(2, I.bestPick(bot) ? I.pickRank(I.bestPick(bot).name) : 0)); if (M2 && M2.level !== M.level) { M = M2; continue }
        if (!under) return noBranch(bot, M); await I.toSurface(bot, { gen, mine: M, why: 'no_branch' }); continue
      }
      if (!await I.gotoBranchFace(bot, M, br, gen)) {
        if (stale()) continue
        const lf = bot.__ironLineFail; const sf = bot.__ironStairFail
        U.note(bot, 'warn', 'cannot reach branch ' + br.key + ': ' + ((lf && lf.why) || (sf && sf.why) || '?'))
        const lost = !!lf && (lf.why === 'off_line' || lf.why === 'off_level') // WE are in the wrong place: no fault of the branch, no skip for it
        if (!(lf && lf.why === 'needpick')) {
          // give it back and do not take it again for 10 min: "resume my own branch first" would walk into the same wall for ever
          if (!lost) { bot.__ironSkip = bot.__ironSkip || {}; bot.__ironSkip[M.level + '/' + br.key] = Date.now() + 10 * 60000 }
          await I.saveBranch(M, br.key, { owner: null })
        }
        // off the graph ON THE SURFACE five times running (toEntrance cannot put us on the mouth cell): other work for 5 min, not a spin at the mine head
        bot.__ironLostN = lost && !I.underground(bot, M) ? (bot.__ironLostN || 0) + 1 : 0
        if (bot.__ironLostN >= 5) { bot.__ironLostN = 0; return handBack(bot, 300000, 'mine: cannot get onto the mine mouth (off the graph at ' + (lf.at || []).join(',') + ')') }
        // OFF the graph (fell into a cave, another level): the only way on is the way out - reconnect to the graph, up, and down again properly
        if (lf && (lf.why === 'off_line' || lf.why === 'off_level') && I.underground(bot, M)) { if (!(await I.toSurface(bot, { gen, mine: M, why: 'lost' })).ok) await U.nap(bot, 3000) } // (no nap here was a 0.4 s spin: Noa 494 reconnects in 3 min)
        else if (sf && sf.why === 'undug') await U.nap(bot, 8000)
        else await U.nap(bot, 2000)
        continue
      }
      bot.state.task = 'iron:branch ' + br.key
      const res = await I.mineBranch(bot, M, br, gen, { maxMs: 12 * 60000 })
      U.note(bot, 'info', 'branch ' + br.key + ' -> ' + JSON.stringify(res))
      I.hb(bot, { lastBranch: Object.assign({ key: br.key, t: Date.now() }, res), stats: bot.__ironStats })
      if ((res.why === 'lost' || res.why === 'stuck') && !I.locate(M.G, I.feet(bot))) await I.toSurface(bot, { gen, mine: M, why: res.why })
    } catch (e) {
      if (e && e.cancelled) break
      U.note(bot, 'warn', 'iron loop: ' + String(e && e.stack || e).slice(0, 300))
      try { bot.clearControlStates() } catch (e2) { U.note(bot, 'warn', 'clear: ' + String(e2 && e2.message || e2).slice(0, 60)) }
      await U.sleep(1500)
    }
  }
  try { bot.clearControlStates() } catch (e) { U.note(bot, 'warn', 'clear: ' + String(e && e.message || e).slice(0, 60)) }
  return { ended: true, stats: bot.__ironStats }
}
