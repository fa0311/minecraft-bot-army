// craft.js — THE crafting implementation: recipe chooser (LLM-free, registry-driven) + the hands that click a recipe into a table.
//
// WOOD-AGNOSTIC (docs/PLAN-world2.md §6/§9): nothing here names a wood species. minecraft-data lists a tag recipe ("any planks") as one
// recipe PER member, so a chest has 12 recipes, a white bed 12, a stick 13. The chooser folds them back into what vanilla really checks:
//   plan  = recipes of one item with the same shape, the same result count and the same ingredient CLASS per cell (planks / wooden slab /
//           log / tool stone / coal, else the item itself) -> every cell ACCEPTS the union of what the folded recipes put there.
//   cells of a class may be MIXED (2 oak + 2 birch planks make a table — true in vanilla, impossible with minecraft-data's per-species
//   recipes); species-bound items (boat, door, fence, gate, sign, slab, stairs) have ONE recipe, so nothing is mixed there, and a bed's
//   wool cells accept exactly one colour (3 wool of ONE colour).
// What is used is decided by what is IN STOCK (`have` = {item:count}: the pockets, or pockets + depot index for planning): uniform
// before mixed, biggest pile first. GENERIC names resolve by stock: planks, slab, stairs, fence, fence_gate, door, trapdoor, sign, button,
// pressure_plate, boat (bamboo -> raft), bed (the colour we own 3 wool of), wool.
// DATA GAP (minecraft-data 26.1, same in 1.21.11): `<species>_planks` has ONE recipe (from `<species>_log`); wood / stripped log / stripped
// wood / hyphae are missing although vanilla accepts them -> PLANK SOURCES are matched by name (U.LOG_RE + plankNameFor), never by that list.
const U = require('./util')
const swallow = require('./swallow')

// copper (tools + armour) exists since 1.21.9: between stone and iron
const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const TIER_RANK = { wooden: 1, golden: 1, stone: 2, copper: 3, iron: 4, diamond: 5, netherite: 6 }
const ARMOR_RANK = { leather: 1, copper: 2, golden: 3, chainmail: 4, iron: 5, diamond: 6, netherite: 7 }
const MAT_NEED = { pickaxe: 3, axe: 3, sword: 2, shovel: 1, hoe: 2 }

// ------------------------------------------------------------------ chooser (pure: registry + {item:count}; no bot, no world)
const _rc = new WeakMap() // registry -> { species, plans:{} }
function ctx (reg) {
  let c = _rc.get(reg)
  if (!c) { c = { species: reg.itemsArray.filter(i => U.PLANK_RE.test(i.name)).map(i => i.name.replace(/_planks$/, '')), plans: {} }; _rc.set(reg, c) }
  return c
}
function plankNameFor (logName) {
  if (/bamboo_block$/.test(logName)) return 'bamboo_planks'
  return logName.replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae)$/, '') + '_planks'
}
function classOf (reg, name) {
  if (U.PLANK_RE.test(name)) return '#planks'
  if (/_slab$/.test(name) && ctx(reg).species.includes(name.replace(/_slab$/, ''))) return '#wooden_slab'
  if (U.LOG_RE.test(name)) return '#log'
  if (/^(cobblestone|cobbled_deepslate|blackstone)$/.test(name)) return '#tool_stone'
  if (/^(coal|charcoal)$/.test(name)) return '#coal'
  return name
}
// plans(reg, item) -> [{ name, count, w, h, cells:[{x, y, accept:[names]}], variants }] — most variants first (the tag recipe before the odd one:
// stick from planks before stick from bamboo)
function plans (reg, name) {
  const c = ctx(reg); if (c.plans[name]) return c.plans[name]
  const it = reg.itemsByName[name]; const out = []; const byKey = {}
  const nm = x => { const id = x == null ? null : (typeof x === 'object' ? x.id : x); return id == null || id < 0 ? null : (reg.items[id] || {}).name || null }
  for (const r of (it && reg.recipes && reg.recipes[it.id]) || []) {
    let rows
    if (r.inShape) rows = r.inShape.map(row => row.map(nm))
    else { const ing = (r.ingredients || []).map(nm); const w = ing.length <= 4 ? 2 : 3; rows = []; for (let i = 0; i < ing.length; i += w) rows.push(ing.slice(i, i + w)) } // shapeless: any cells do
    const cells = []; rows.forEach((row, y) => row.forEach((n, x) => { if (n) cells.push({ x, y, n }) }))
    if (!cells.length) continue
    const count = (r.result && r.result.count) || 1
    const key = count + '|' + cells.map(q => q.x + ',' + q.y + ':' + classOf(reg, q.n)).join(' ')
    let p = byKey[key]
    if (!p) { p = byKey[key] = { name, count, w: Math.max(...rows.map(q => q.length)), h: rows.length, cells: cells.map(q => ({ x: q.x, y: q.y, accept: [] })), variants: 0 }; out.push(p) }
    p.variants++
    cells.forEach((q, i) => { if (!p.cells[i].accept.includes(q.n)) p.cells[i].accept.push(q.n) })
  }
  if (U.PLANK_RE.test(name)) { // the data gap (header): every log-like item of the species makes these planks
    const src = reg.itemsArray.map(i => i.name).filter(n => U.LOG_RE.test(n) && plankNameFor(n) === name)
    if (out[0]) { for (const n of src) if (!out[0].cells[0].accept.includes(n)) out[0].cells[0].accept.push(n) } else if (src.length) out.push({ name, count: 4, w: 1, h: 1, cells: [{ x: 0, y: 0, accept: src }], variants: 1 })
  }
  out.sort((a, b) => b.variants - a.variants)
  c.plans[name] = out
  return out
}
// GENERIC names -> the concrete item our stock can make (or already holds). Unknown names come back unchanged.
const GENERIC = ['planks', 'slab', 'stairs', 'fence', 'fence_gate', 'door', 'trapdoor', 'sign', 'button', 'pressure_plate', 'boat', 'bed', 'wool', 'log']
function resolve (reg, name, have = {}) {
  if (reg.itemsByName[name] || !GENERIC.includes(name)) return name
  const best = (cands, score) => { let b = null; let bs = -1; for (const q of cands) { const s = score(q); if (s > bs) { b = q; bs = s } } return b }
  const colours = reg.itemsArray.filter(i => /_wool$/.test(i.name)).map(i => i.name.replace(/_wool$/, ''))
  if (name === 'wool') return best(colours, q => have[q + '_wool'] || 0) + '_wool'
  if (name === 'bed') { const ready = colours.find(q => have[q + '_bed'] > 0); return (ready || best(colours, q => Math.min(3, have[q + '_wool'] || 0) * 1000 + (have[q + '_wool'] || 0))) + '_bed' } // 3 of ONE colour, never a mix
  if (name === 'log') return best(reg.itemsArray.map(i => i.name).filter(n => U.LOG_RE.test(n)), q => have[q] || 0)
  // wood of a species = its planks + what its logs would give; a finished item of the species wins
  const item = sp => (name === 'boat' && sp === 'bamboo') ? 'bamboo_raft' : sp + '_' + name
  const sps = ctx(reg).species.filter(sp => reg.itemsByName[item(sp)])
  const wood = sp => { let n = (have[sp + '_planks'] || 0) + (sp === 'bamboo' ? Math.floor((have.bamboo || 0) / 9) * 2 : 0); for (const k of Object.keys(have)) if (U.LOG_RE.test(k) && plankNameFor(k) === sp + '_planks') n += have[k] * (sp === 'bamboo' ? 2 : 4); return n }
  return item(best(sps, sp => (have[item(sp)] || 0) * 1e6 + wood(sp)))
}
// one cell group = cells with the same accept list; take k items for it out of `have`: ONE kind if a pile is big enough (biggest first), else mixed
function takeFor (have, accept, k) {
  const piles = accept.filter(n => have[n] > 0).sort((a, b) => have[b] - have[a])
  const one = piles.find(n => have[n] >= k); const got = []
  if (one) { have[one] -= k; for (let i = 0; i < k; i++) got.push(one); return got }
  for (const n of piles) while (have[n] > 0 && got.length < k) { have[n]--; got.push(n) }
  if (got.length < k) { for (const n of got) have[n]++; return null }
  return got
}
function groupsOf (plan) { const g = {}; for (const c of plan.cells) (g[c.accept.join('|')] = g[c.accept.join('|')] || { accept: c.accept, cells: [] }).cells.push(c); return Object.values(g) }
// choose(reg, name, have) -> ONE run that `have` can pay right now: { item, count, w, h, fill:[{x,y,name}], uses:{name:n} } or null. `have` is not changed.
function choose (reg, name, have = {}) {
  const item = resolve(reg, name, have)
  for (const p of plans(reg, item)) {
    const h = Object.assign({}, have); const fill = []; let ok = true
    for (const g of groupsOf(p)) { const got = takeFor(h, g.accept, g.cells.length); if (!got) { ok = false; break } g.cells.forEach((c, i) => fill.push({ x: c.x, y: c.y, name: got[i] })) }
    if (!ok) continue
    const uses = {}; for (const f of fill) uses[f.name] = (uses[f.name] || 0) + 1
    return { item, count: p.count, w: p.w, h: p.h, fill, uses }
  }
  return null
}
// solve(reg, name, n, have) -> { ok, item, steps:[{item, runs}] (dependencies first), missing:{class|item: n}, left: have after } — the whole chain
// from what is in stock (bamboo -> block -> planks -> sticks -> pickaxe). Pure planning: obtain() uses `missing` to know what to fetch.
function solve (reg, name, n, have = {}) {
  const steps = []; const missing = {}
  const item = resolve(reg, name, have)
  const h = Object.assign({}, have)
  const ok = make(reg, item, n, h, steps, missing, [])
  return { ok, item, steps, missing: ok ? {} : missing, left: h }
}
function make (reg, item, n, have, steps, missing, stack) { // raises have[item] to >= n; mutates have/steps; false = cannot
  if ((have[item] || 0) >= n) return true
  if (stack.includes(item) || stack.length > 5) return false // iron_ingot <-> iron_block <-> nugget loops
  for (const p of plans(reg, item)) {
    const h = Object.assign({}, have); const st = []; const miss = {}
    const runs = Math.ceil((n - (h[item] || 0)) / p.count); let ok = true
    for (const g of groupsOf(p)) {
      const k = g.cells.length * runs
      const sum = () => g.accept.reduce((a, q) => a + (h[q] || 0), 0)
      // short: make more of the members — first ONE member for the whole deficit, then whatever each member can add (1 oak log + 1 birch log = 8 planks).
      // make() changes `h`/`st` only when it succeeds, so failed candidates cost nothing.
      for (const partial of [false, true]) {
        for (const cand of g.accept) {
          if (sum() >= k) break
          const per = (plans(reg, cand)[0] || {}).count || 1
          for (let r = Math.ceil((k - sum()) / per); r >= 1; r--) { if (make(reg, cand, (h[cand] || 0) + (partial ? r * per : k - sum()), h, st, {}, stack.concat(item)) || !partial) break }
        }
      }
      if (sum() < k) { ok = false; miss[g.accept.length > 1 ? classOf(reg, g.accept[0]) : g.accept[0]] = k - sum(); continue }
      let left = k; for (const q of g.accept.filter(q => h[q] > 0).sort((a, b) => h[b] - h[a])) { const t = Math.min(left, h[q]); h[q] -= t; left -= t; if (!left) break }
    }
    if (!ok) { if (!Object.keys(missing).length) Object.assign(missing, miss); continue }
    h[item] = (h[item] || 0) + runs * p.count
    for (const k2 of Object.keys(have)) delete have[k2]
    Object.assign(have, h); steps.push(...st, { item, runs })
    return true
  }
  if (!plans(reg, item).length && !Object.keys(missing).length) missing[item] = n - (have[item] || 0)
  return false
}
// what ONE unit of `name` needs at the first level, by class — `armyctl recipe`-style listing and obtain()'s shopping list
function needs (reg, name, have = {}) {
  const p = plans(reg, resolve(reg, name, have))[0]; if (!p) return null
  const out = {}; for (const g of groupsOf(p)) out[g.accept.length > 1 ? classOf(reg, g.accept[0]) : g.accept[0]] = { n: g.cells.length, accept: g.accept }
  return { count: p.count, needs: out }
}

// ------------------------------------------------------------------ hands
function invOf (w) { const m = {}; for (const i of w.items()) if (i.slot >= w.inventoryStart) m[i.name] = (m[i.name] || 0) + i.count; return m }

// Crafting-table crafting done by hand (window clicks) instead of bot.craft(): on Paper bot.craft() silently produces NOTHING for some
// shaped recipes (measured in world 1: stone_pickaxe, stone_hoe — the grid was right, the server showed the result, but mineflayer's blind
// "take result" click was rejected and the ingredients came back). Here we wait for the SERVER's result slot and take it with a normal click.
// ONE WINDOW FOR THE WHOLE BATCH (review row 10 / BUGS 11:3xZ, measured 09-20 12:45Z: 206 short-batch reports in 3 h — `toolsmith_picks 0/2
// crafted (ingredients ran out?)` x13 and `2/32` while the bot carried 90 cobblestone + 28 sticks, `armoury_diamond_tools 0/2` x11 with diamonds
// and sticks in the pockets). Every run used to re-open the table, and the window that comes back is EMPTY for a moment: `choose()` then saw no
// ingredients and reported "ingredients ran out" with full pockets. Now the table is opened once, each run waits for the window to show the
// ingredients, the result is counted as a TOTAL over all inventory slots (32 pickaxes are 32 slots, not one stack) and the run is only counted
// when the server confirmed it. Every give-up writes its reason to `armyctl.js errors` (craft:*). -> number of runs that really produced the item.
async function craftOnTable (bot, name, tbl, times = 1) {
  const reg = bot.registry
  const w = await U.withTimeout(bot.openBlock(tbl), 8000, 'openTable')
  let made = 0
  // A CLICK THAT IS NOT CONFIRMED IS NOT A FAILED CRAFT (measured 09-20 12:5xZ - this is what was behind `0/2 crafted` with full pockets:
  // `craft:run stone_pickaxe | Event updateSlot:N did not fire within timeout`. mineflayer waits for the server to send the slot back and
  // Paper does not always send one for a slot it considers unchanged.) The truth is the WINDOW, read after the click: swallow the missing
  // confirmation, go on, and let the result COUNT decide whether the run worked.
  const clk = async (slot, button, mode) => {
    try { await bot.clickWindow(slot, button, mode) } catch (e_) {
      if (!/updateSlot|did not fire|timeout/i.test(String(e_ && e_.message))) throw e_
      swallow('craft:click not confirmed ' + name, e_); await U.sleep(120)
    }
  }
  try {
    for (let k = 0; k < times; k++) {
      if (U.cancelled(bot)) break
      try { // a run that throws (the bot was walked away, the server closed the window) ends the batch but keeps what was made
      // the OPEN WINDOW is the truth while it is open (bot.inventory lags): wait for it to list the ingredients before giving up on them
      let run = null
      for (let i = 0; i < 10 && !(run = choose(reg, name, invOf(w))); i++) await U.sleep(200)
      if (!run) { swallow('craft:nothing to make ' + name, new Error('window lists no ingredients')); break }
      const resId = reg.itemsByName[run.item].id
      const cnt = () => w.items().filter(i => i.type === resId).reduce((a, i) => a + i.count, 0) // TOTAL over the slots, not one stack
      const before = cnt()
      // AN UNSTACKABLE RESULT NEEDS A SLOT OF ITS OWN: with a full inventory the result stays on the cursor and the run is lost
      const stackSize = (reg.itemsByName[run.item] || {}).stackSize || 64
      if (stackSize <= 1 && w.firstEmptySlotRange(w.inventoryStart, w.inventoryEnd) == null) { swallow('craft:no free slot for ' + name, new Error('inventory full')); break }
      const cells = {} // ingredient id -> [grid slots]
      for (const f of run.fill) { const id = reg.itemsByName[f.name].id; (cells[id] = cells[id] || []).push(1 + f.x + 3 * f.y) }
      let short = null
      for (const [id, slots] of Object.entries(cells)) {
        // an ingredient may be spread over several small stacks (8 planks for a chest as 3+5): keep drawing stacks until every cell is filled
        const todo = slots.slice()
        while (todo.length) {
          const src = w.items().find(i => i.type === +id && i.slot >= w.inventoryStart)
          if (!src) { short = (reg.items[id] || {}).name || id; break }
          const srcSlot = src.slot
          await clk(srcSlot, 0, 0) // pick the stack up
          while (todo.length && w.selectedItem) await clk(todo.shift(), 1, 0) // right click = put ONE down
          if (w.selectedItem) await clk(srcSlot, 0, 0) // put the rest back where it came from
        }
        if (short) break
      }
      if (short) { swallow('craft:ingredient gone ' + short, new Error('the window lost ' + short + ' while filling the grid')); break }
      // 3 s for the result (measured 12:5xZ: `craft:no result slot stick` x6/h - when a grid click was not confirmed the server never builds a result;
      // the batch retry in craft() opens a fresh window for what is left, which is the honest remedy)
      for (let i = 0; i < 30 && !(w.slots[0] && w.slots[0].type === resId); i++) await U.sleep(100)
      if (!(w.slots[0] && w.slots[0].type === resId)) { swallow('craft:no result slot ' + name, new Error('the server sent no result')); break }
      await clk(0, 0, 0) // take the result onto the cursor …
      // … and put it onto an existing stack with room, else into a free slot (world 1: every run took a NEW slot, so 32 torch runs stopped after 3
      // when the pockets were full of 4-torch stacks; the result stayed on the cursor and counted as "nothing crafted")
      const held = w.selectedItem; const need = held ? held.count : run.count
      const stack = w.items().find(i => i.type === resId && i.slot >= w.inventoryStart && i.count + need <= (i.stackSize || 64))
      const free = stack ? stack.slot : w.firstEmptySlotRange(w.inventoryStart, w.inventoryEnd)
      if (free == null) { swallow('craft:nowhere to put ' + name, new Error('no free slot for the result')); break }
      await clk(free, 0, 0)
      // WAIT FOR THE SERVER between runs (the next run reads this window again): a run counts only when the item really arrived
      let ok = false
      for (let i = 0; i < 20 && !(ok = cnt() > before); i++) await U.sleep(100)
      if (!ok) { swallow('craft:result not confirmed ' + name, new Error('count did not rise')); break }
      made++
      } catch (e_) { swallow('craft:run ' + name, e_); break }
    }
  } finally {
    // give back what is on the cursor and clear the grid, whatever happened
    try { if (w.selectedItem) { const f = w.firstEmptySlotRange(w.inventoryStart, w.inventoryEnd); if (f != null) await clk(f, 0, 0) } } catch (e_) { swallow('craft:cursorBack', e_) }
    try { for (let sl = 1; sl <= 9; sl++) if (w.slots[sl]) { await clk(sl, 0, 0); const f = w.firstEmptySlotRange(w.inventoryStart, w.inventoryEnd); if (f != null) await clk(f, 0, 0) } } catch (e_) { swallow('craft:gridBack', e_) }
    try { w.close() } catch (e_) { swallow('craft:close', e_) }
    await U.sleep(200)
  }
  return made
}

// craft `times` runs of `name` (a concrete or GENERIC item) from the POCKETS. With a table (given, or within 6 blocks): the table window, always
// — 2x2 recipes crafted on the player-inventory grid often never get their result slot from the server ("Event updateSlot:0 did not fire"
// after 20 s, ingredients stuck in the grid). Without any table (the very first planks/table of a world): bot.craft() with a recipe BUILT
// from the chosen run, so it is wood-agnostic too. Returns true when at least one run really produced the item.
async function craft (bot, name, times = 1, table = null) {
  U.ck(bot)
  const reg = bot.registry
  // an open container (chest/furnace) makes crafting hang until the timeout
  try { if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await U.sleep(250) } } catch (e_) { swallow('craft:closeOpen', e_) }
  let tbl = table
  if (!tbl) { try { tbl = bot.findBlock({ matching: reg.blocksByName.crafting_table.id, maxDistance: 6 }) } catch (e_) { swallow('craft:findTable', e_) } }
  if (tbl) {
    try {
      U.ck(bot)
      // the WHOLE batch in one window; one retry for the rest (a table window that came back empty used to cost the whole batch)
      const budget = n => Math.min(240000, 20000 + 8000 * n)
      let made = await U.withTimeout(craftOnTable(bot, name, tbl, times), budget(times), 'craftOnTable:' + name)
      if (made < times && !U.cancelled(bot)) {
        await U.sleep(900)
        made += await U.withTimeout(craftOnTable(bot, name, tbl, times - made), budget(times - made), 'craftOnTable:' + name)
      }
      return made > 0
    } catch (e) { U.note(bot, 'warn', 'craftOnTable ' + name + ': ' + String(e.message || e).slice(0, 80)); swallow('craft:onTable', e); try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e_) { swallow('craft:closeAfter', e_) } return false }
  }
  let made = 0
  for (let k = 0; k < times; k++) {
    const run = choose(reg, name, U.invMap(bot))
    if (!run || run.w > 2 || run.h > 2) break // needs a table we do not have
    const id = n => reg.itemsByName[n].id; const shape = []
    for (let y = 0; y < run.h; y++) { shape.push([]); for (let x = 0; x < run.w; x++) { const f = run.fill.find(q => q.x === x && q.y === y); shape[y].push(f ? id(f.name) : null) } }
    const before = U.count(bot, run.item)
    try {
      const { Recipe } = require('prismarine-recipe')(reg) // the module exports {Recipe, RecipeItem} (world 2, 09-19: taking the module itself as the class made EVERY 2x2 craft throw 'Recipe is not a constructor' -> no first table, no tool, no sword on day one)
      await U.withTimeout(bot.craft(new Recipe({ result: { id: id(run.item), count: run.count }, inShape: shape }), 1, null), 30000, 'craft:' + name)
      await U.sleep(250) // bot.inventory lags the server by a tick or two: without this the caller's count check reads the pre-craft state
    } catch (e) {
      U.note(bot, 'warn', 'craft ' + name + ': ' + String(e.message || e).slice(0, 80)); swallow('craft:inventoryGrid', e)
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e_) { swallow('craft:closeInv', e_) }
      try { bot._client.write('close_window', { windowId: 0 }) } catch (e_) { swallow('craft:releaseGrid', e_) } // releases ingredients left behind in the 2x2 grid
    }
    if (U.count(bot, run.item) > before) made++; else break
  }
  return made > 0
}

// build(bot, name, n, tbl): run the WHOLE chain for n of `name` out of the pockets (logs -> planks -> sticks -> tool). true = the pockets hold n.
async function build (bot, name, n = 1, tbl = null) {
  const s = solve(bot.registry, name, n, U.invMap(bot))
  if (!s.ok) return false
  for (const st of s.steps) { U.ck(bot); if (!await craft(bot, st.item, st.runs, tbl)) break }
  return U.count(bot, s.item) >= n
}
function countPlanks (bot) { return U.countRe(bot, U.PLANK_RE) }
// `tbl` (optional): a reachable crafting-table BLOCK. Always pass it when you have one (see craft()).
async function ensurePlanks (bot, need, tbl) {
  for (let i = 0; i < 24 && countPlanks(bot) < need; i++) {
    const log = bot.inventory.items().filter(q => U.LOG_RE.test(q.name)).sort((a, b) => b.count - a.count)[0]
    if (!log) return false
    const per = /bamboo/.test(log.name) ? 2 : 4
    if (!await craft(bot, plankNameFor(log.name), Math.max(1, Math.min(Math.ceil((need - countPlanks(bot)) / per), log.count)), tbl)) return false
  }
  return countPlanks(bot) >= need
}
async function ensureSticks (bot, need, tbl) {
  if (U.count(bot, 'stick') >= need) return true
  const times = Math.max(1, Math.ceil((need - U.count(bot, 'stick')) / 4))
  if (countPlanks(bot) < times * 2 && !await ensurePlanks(bot, times * 2, tbl) && U.count(bot, 'bamboo') < 2) return false
  await craft(bot, 'stick', times, tbl) // planks first; the chooser falls back to bamboo (2 -> 1 stick) by itself
  return U.count(bot, 'stick') >= need
}
async function ensureCraftingTable (bot, tbl) {
  if (U.has(bot, 'crafting_table')) return true
  if (!await ensurePlanks(bot, 4, tbl)) return false
  await craft(bot, 'crafting_table', 1, tbl)
  return U.has(bot, 'crafting_table')
}

// Returns a *placed* crafting table block we can reach, placing one if needed. Callers that know `settings.craftTable` go there first
// (army.js obtain): this function only looks 12 blocks around the bot.
async function table (bot) {
  U.ck(bot)
  const found = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 12 })
  if (found) {
    if (bot.entity.position.distanceTo(found.position) > 3.5) await U.goTo(bot, found.position.x, found.position.y, found.position.z, 2, 20000)
    const b = bot.blockAt(found.position)
    if (b && b.name === 'crafting_table' && bot.entity.position.distanceTo(b.position) < 5) return b
  }
  if (!await ensureCraftingTable(bot)) return null
  const spot = U.freeSpotNear(bot, 3)
  if (!spot) return null
  if (!await U.placeBlockAt(bot, 'crafting_table', spot)) return null
  const b = bot.blockAt(spot)
  if (b && b.name === 'crafting_table') { bot.__placedTable = spot; return b }
  return null
}
// pick a field-placed crafting table back up (keeps the world tidy)
async function releaseTable (bot) {
  const p = bot.__placedTable
  bot.__placedTable = null
  if (!p) return false
  const b = bot.blockAt(p)
  if (!b || b.name !== 'crafting_table' || bot.entity.position.distanceTo(p) >= 4.5) return false
  const ok = await U.digBlock(bot, b, 10000)
  if (ok) await U.pickupNear(bot, 1500, 4)
  return ok
}

function bestToolRank (bot, kind) {
  let best = 0
  for (const i of bot.inventory.items()) { const m = /^(\w+)_(pickaxe|axe|sword|shovel|hoe)$/.exec(i.name); if (m && m[2] === kind && (TIER_RANK[m[1]] || 0) > best) best = TIER_RANK[m[1]] }
  return best
}
// Craft a tool of the given tier from the pockets if we don't already hold that tier or better (wooden = any planks, stone = any tool stone).
async function ensureTool (bot, kind, tier, tbl) {
  if (bestToolRank(bot, kind) >= TIER_RANK[tier]) return true
  if (!solve(bot.registry, tier + '_' + kind, 1, U.invMap(bot)).ok) return false // before a table is placed for nothing
  const t = tbl || await table(bot)
  if (!t) return false
  await build(bot, tier + '_' + kind, 1, t)
  return bestToolRank(bot, kind) >= TIER_RANK[tier]
}

module.exports = {
  TIERS, TIER_RANK, ARMOR_RANK, MAT_NEED, GENERIC, plans, resolve, choose, solve, needs, classOf, plankNameFor,
  craft, build, ensurePlanks, ensureSticks, ensureCraftingTable, table, releaseTable, ensureTool, bestToolRank
}
