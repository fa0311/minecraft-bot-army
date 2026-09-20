// stock.js — what the ARMY owns. THE one definition of stock and of the stock GROUPS (docs/PLAN-world2.md §9 CONTRACT); used by the dispatcher
// (labour by demand) and meant for armyctl (`stock`, `recipe`) and the workers' "is fuel under target?" questions. LLM-free, pure file reads:
//   chests.json (chest index kept by the workers: {"x,y,z":{items:{name:n}}}) + what bots CARRY as reported in hb/<bot>.json ({bot,t,inv:{name:n}}).
// WHY (world 1): nobody compared stock with need — 9 farmers kept farming on 500 bread while coal was 0 and iron 2. A number that every
// process computes the same way is the precondition for staffing by deficit.
//   stock(opts)      -> {name: count}  chests + carried                     opts = {dir, maxAgeMs} (dir = a fake field for dry runs / tests)
//   detail(opts)     -> {chest, carried, top:{name:[bot,n]}}                (the three columns of `armyctl.js stock`)
//   count(key, st)   -> number; key = a group name or an item name; st = a {name:count} map (pure)
//   have(key, opts)  -> count(key, stock(opts))
// Tolerant: a missing file/dir is an empty stock (new world); a file that EXISTS but cannot be read is counted by swallow (`armyctl.js errors`).
const fs = require('fs'); const path = require('path')
const swallow = (() => { try { return require(path.join(__dirname, '..', 'skills', 'lib', 'swallow.js')) } catch { return () => {} } })()
const DIR = __dirname
const HB_MAX_AGE = 180000 // a bot that has been silent for 3 min is not "carrying for the army" (same cut as armyctl's allHb)

// hunger points per item. Raw meat/fish count with their RAW points (what a starving bot gets now; cooking needs fuel we may not have). Wheat counts
// as the bread it becomes (3 wheat = 1 bread = 5 points; baking needs only a table) — otherwise a full wheat chest reads as "no food" and the
// farm is staffed to maxBots for ever. Never counted: rotten_flesh, spider_eye, poisonous_potato, pufferfish (safety.js TOXIC / blacklist).
const FOOD = {
  bread: 5, wheat: 5 / 3, hay_block: 15, baked_potato: 5, potato: 1, carrot: 3, golden_carrot: 6, beetroot: 1, beetroot_soup: 6, apple: 4, golden_apple: 4,
  enchanted_golden_apple: 4, melon_slice: 2, pumpkin_pie: 8, cookie: 2, sweet_berries: 2, glow_berries: 2, dried_kelp: 1, mushroom_stew: 6, rabbit_stew: 10,
  suspicious_stew: 6, honey_bottle: 6, chorus_fruit: 4, cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_rabbit: 5,
  cooked_cod: 5, cooked_salmon: 6, beef: 3, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3, cod: 2, salmon: 2, tropical_fish: 1
}
// group -> weight of ONE item of that name (0 = not in the group). Wood is species-agnostic (world 1 hard-coded spruce and starved in a birch forest).
const groups = {
  log: n => /_(log|stem)$/.test(n) ? 1 : 0, // any *_log / *_stem, stripped ones too (they all make planks)
  planks: n => /_planks$/.test(n) ? 1 : 0,
  food: n => (FOOD[n] || 0) / 5, // bread-equivalents
  fuel: n => (n === 'coal' || n === 'charcoal') ? 1 : 0,
  wool: n => /_wool$/.test(n) ? 1 : 0, // any colour (a bed needs 3 of ONE colour; the target only steers the sheep squad)
  cobblestone: n => (n === 'cobblestone' || n === 'cobbled_deepslate') ? 1 : 0, // building stone of either depth: the deep mine hauls deepslate (09-19: 1432 banked while the board read "cobblestone 263/1728" and kept asking for a quarry)
  iron: n => ({ iron_ingot: 1, raw_iron: 1, iron_ore: 1, deepslate_iron_ore: 1, iron_block: 9, raw_iron_block: 9 })[n] || 0 // the MINERS' output (ingots only = item `iron_ingot`): unsmelted ore is not their deficit
}

function rj (f) { // -> parsed JSON or null. ENOENT = a new world, not an error; a half-written/corrupt file is counted, never silent
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') swallow('stock.js:rj ' + path.basename(path.dirname(f)) + '/' + (/hb$/.test(path.dirname(f)) ? '*' : path.basename(f)), e); return null }
}
const memo = {} // dir|age -> {at, d}: one tick of the dispatcher asks have() dozens of times; 30 heartbeats are read once per 3 s, not per question
function detail (opts) {
  const dir = (opts && opts.dir) || DIR; const maxAge = (opts && opts.maxAgeMs) || HB_MAX_AGE; const key = dir + '|' + maxAge
  if (memo[key] && Date.now() - memo[key].at < 3000) return memo[key].d
  const chest = {}; const carried = {}; const top = {}
  const add = (m, k, n) => { if (typeof n === 'number' && n > 0) m[k] = (m[k] || 0) + n }
  for (const v of Object.values(rj(path.join(dir, 'chests.json')) || {})) for (const [k, n] of Object.entries((v && v.items) || {})) add(chest, k, n)
  let files = []; try { files = fs.readdirSync(path.join(dir, 'hb')) } catch (e) { if (e.code !== 'ENOENT') swallow('stock.js:hb readdir', e) }
  for (const f of files) {
    const h = f.endsWith('.json') && rj(path.join(dir, 'hb', f)); if (!h || !(Date.now() - h.t < maxAge)) continue
    for (const [k, n] of Object.entries(h.inv || {})) { add(carried, k, n); if (n > 0 && (!top[k] || n > top[k][1])) top[k] = [h.bot || f.slice(0, -5), n] }
  }
  memo[key] = { at: Date.now(), d: { chest, carried, top } }
  return memo[key].d
}
function stock (opts) { const { chest, carried } = detail(opts); const st = Object.assign({}, chest); for (const [k, n] of Object.entries(carried)) st[k] = (st[k] || 0) + n; return st }
function count (key, st) {
  const g = groups[key]; if (!g) return (st && st[key]) || 0
  let n = 0; for (const [k, c] of Object.entries(st || {})) { const w = g(k); if (w) n += w * c }
  return Math.round(n * 10) / 10
}
function have (key, opts) { return count(key, stock(opts)) }

module.exports = { groups, FOOD, stock, detail, count, have }
// `node bots/army/stock.js [key …]` — the groups (and any item/group asked for) as the dispatcher sees them
if (require.main === module) { const st = stock(); for (const k of [...new Set([...Object.keys(groups), ...process.argv.slice(2)])]) console.log(k.padEnd(20), count(k, st)) }
