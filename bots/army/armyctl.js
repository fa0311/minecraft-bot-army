#!/usr/bin/env node
// armyctl.js — operator CLI (LLM-free).
//   node armyctl.js field              one line per bot: pos, distance to muster, hp, food, job, task, key items  <- LOOK HERE FIRST
//   node armyctl.js look <bot> [radius=16] [surface|cave]   ASCII terrain map around a bot (the operator's eyes): heights relative to its feet,
//                                      water/ice/trees/chests/crops/torches, exact coords of notable things, nearby entities. North is up.
//   --- knowing things (all LLM-free, all short) ---
//   node armyctl.js stock [regex]      what the ARMY owns: depot chests (index) + what bots carry, per item, with who carries the most
//   node armyctl.js recipe <item> [n]  ingredients for n items, expanded one level, compared with stock -> "have / missing"
//   node armyctl.js errors [n=20] [all]   SWALLOWED errors (every catch that continues is counted, lib/swallow.js): what keeps failing quietly NOW - only the
//                                      counters of LIVE processes (count, per hour, last seen); files of dead pids are ignored unless `all`
//   node armyctl.js blueprints [name]  templates for `build` jobs (house=shelter, wall_ring, level=整地, platform, road, storage_hall …) + their params
//   node armyctl.js deaths [minutes=30]   death CAUSES from the server log (slain by X / fell / drowned / blown up …), newest last + totals
//   node armyctl.js mine [level <y> [dry]]   mine status from the miners' cache (levels, stair rows dug, branches, ore, defects) | order another LEVEL:
//                                      patches the mine job's params.args.level + rev (iron/coal ~16, diamonds -54). The miners own the stairwell: a
//                                      level that would move dug rows is refused BY THEM (`mine_level_refused`); `dry` only says what would happen
//   node armyctl.js animals            where bots have SEEN livestock (kind, count, coords, age) — take hunt/shear sites from here
//   node armyctl.js howto [thing]      Minecraft common sense: how a good player gets string/wool/iron/food/bed/obsidian/pearls… and which job or verb does it here
//   node armyctl.js bot <name>         one bot's dossier: pos, hp/food, job, task, full inventory, walkable area, its last 8 reports
//   node armyctl.js who [idle] [fit] [has:<item>] [near:x,z] [n:5]   candidate bots for a job, nearest first
//   node armyctl.js ground <bot> x,z [x,z ...]    ground level (top solid Y) + block name at those columns, seen through <bot> (must be within ~40 blocks)
//   node armyctl.js template [kind]    ready-to-edit job JSON: toolsmith | lumber | torches | haul | farm | cane | deck | smelt | goto_look | build | hunt | herd
//                                      (coordinates come from the board - settings.craftTable - or stay <placeholders> you must fill in)
//   (put/patch validate the job first: unknown verbs/items/bots, missing fields, y out of range, a blueprint that fails or names unknown cells
//    (kinds: block names, air, water), produces/minBots/maxBots (labour by demand), `after` -> refused with the reason)
//   node armyctl.js board              the job board (BOARD.md); --help = this list
//   node armyctl.js job <id> active|paused      switch a job on/off (dispatcher picks it up within 5 s)
//   node armyctl.js events [n] [regex|all]   the last n DISTINCT worker reports: repeats are collapsed per signature (xN, how many bots), bookkeeping
//                                      (job_slice/job_start/pockets…) is dropped. regex filters ev/job/bot; `all` = the raw tail
//   --- a new world: survey -> base -> plan (docs/PLAN-world2.md §1, §2, §8) ---
//   node armyctl.js bootstrap [--spawn x,y,z] [--replace]   the STARTING board of a new world: no old coordinate, muster = world spawn, targets, scouts on 8
//                                      bearings (far + near ring), hunt, forage, wood, night guard, sponge. Refuses a board with history unless --replace
//   node armyctl.js sites [n]          BASE sites from scout.jsonl: neighbouring samples (64 blocks, same y +-2) are ONE site; scored for flat area, climate,
//                                      liquid water, trees/animals/cane within 100, village; one line per site with the reasons + the `base set` line
//   node armyctl.js base [set x,y,z [--wood x1,z1,x2,z2] [--move]]   show / freeze THE base (from `sites`, or picked from the air: ops/skyshot.js). y = GROUND
//                                      level of the whole base. Writes settings.base + settings.muster (the yard) and takes the bootstrap jobs along:
//                                      4-bot detail survey, wood_site clears the footprint, hunt/forage/sponge at the base. Never moved by accident: --move
//   node armyctl.js base keepout add <id> x1,z1,x2,z2 <why…> | base keepout rm <id> | base keepout exit <id> x,y,z   land the plan leaves alone (settings.keepOut: a ravine, a pond): no zone,
//                                      no road within 3; the sponge stops tidying there at once; `plan-base` lays the lattice AROUND it. `base` lists them
//   node armyctl.js plan-base [--at x,y,z] [--survey <skyshot.json>] [--force-zone <id>,…] [--move-zone <id>,…] [--put]   the base as ZONES on one level (core,
//                                      yard, dorm, fields 27x27, tree farm 48x48, pens, mine head, roads, torch grid, wall) on a lattice of 32x32 slots around
//                                      the keep-outs: per zone a `level` pad job + its blueprint `build` job, production jobs behind them, in the order of
//                                      PLAN §8 (`after` = predecessor). IT LOOKS FIRST: with a survey (default bots/army/survey-base.json = the .json that
//                                      `node ops/skyshot.js x z 256 out.png` writes) a slot with holes/steps/water is skipped, every pad, road and the wall
//                                      line gets a verdict (`ok` | `BAD: 37 columns >=4 below y68 (down to y41) at x.. / z..`), and BAD is never put (unless
//                                      --force-zone). Prints an ASCII map (1 char = 8 blocks), zone/origin/size/jobs/materials, what would MOVE on the board.
//                                      --put writes the jobs (validated, locked), all PAUSED but the first pads; a re-run keeps each job's status, a zone
//                                      whose jobs made progress stays where it is (unless BAD or --move-zone); no survey = a loud warning
//   node armyctl.js targets [<item|group> <n|none>]   stock targets that steer labour by demand (settings.targets): have / target / deficit / producers | set one
//   node armyctl.js wait <operator> [maxSec=600] [topics]   BLOCKS (zero tokens) until something needs JUDGEMENT, then prints a short digest once:
//                                      plan_failed/plan_done, stranded, no_route, deck_done, deaths piling up on a job, fit bots idling by day,
//                                      active jobs nobody staffs, low stock (food, pickaxes); damage audits (hedge/structure_damaged, crops_vanished,
//                                      farm_degrading, flood), bed_missing, build_done, build_stuck, void_under_pad, ores_exhausted, the mine (mine_blocked, stair_broken /
//                                      _no_filler / _repair_refused, miner off the graph, mine_not_ready / _kit_short / _bad_entrance / _level_refused)
//                                      (each signature at most once per 30 min); spawn_set, bed_replaced, forged, job_activated (`after` chains), stairs_done, stair_repaired = one `info` line.
//                                      topics = comma list of job-id prefixes to watch (default all; the info line goes to topic-less operators only).
//   node armyctl.js putjson '<json>'   same as put, JSON given inline (no file needed)
//   node armyctl.js put <file.json>    add/replace ONE job from a JSON file (locked read-modify-write: safe with several operators)
//   node armyctl.js patch <id> '<json>'  merge fields into a job (e.g. '{"maxBots":12,"rev":3}'); params are merged one level deep, null drops a field
//   node armyctl.js rm <id>
//   node armyctl.js prune              finished one-off jobs (paused, last terminal event *_done) leave the board -> bots/army/jobs-archive.jsonl
//   node armyctl.js census [ores|func] every bot looks around: functional blocks (chests, furnaces, tables, beds …) that are NOT in our books + exposed ores
//   node armyctl.js chest list | chest add <cat> x,y,z     register an extra depot chest (after a plan placed it) when `wait` says CHEST FULL
//   node armyctl.js rescue <bot>       the ONLY permitted kill: "hand of god" (rcon kill) on a bot that is really HUNG (boxed in, or a
//                                      hung/stranded report at its spot, or a stale heartbeat). Refuses otherwise; there is no --force.
//   node armyctl.js enlist A,B | discharge A,B | start A,B (re-launch worker)
//   ARMY_DIR=<dir> node armyctl.js …   work on a COPY of the state files (jobs.json, scout.jsonl, hb/ …): dry runs and tests, never the live board
const fs = require('fs'); const path = require('path'); const http = require('http')
const DIR = process.env.ARMY_DIR ? path.resolve(process.env.ARMY_DIR) : __dirname // state files; code and world files next to the code stay under BOTS
const BOTS = path.join(__dirname, '..'); const BOARD = path.join(DIR, 'jobs.json'); const ASSIGN = path.join(BOTS, 'assignments.json')
const rj = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const wj = (f, d) => { const t = f + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(d, null, 1)); fs.renameSync(t, f) }
function post (p, body, max = 300) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: 3000, path: p, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 60000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d.slice(0, max))) })
    req.on('error', e => resolve('ERR ' + e.message)); req.on('timeout', () => { req.destroy(); resolve('TIMEOUT') })
    req.end(JSON.stringify(body))
  })
}

// ---- locked board edits (several operators may edit concurrently)
function withBoardLock (fn) {
  const lock = BOARD + '.lock'
  const t0 = Date.now()
  for (;;) {
    try { fs.mkdirSync(lock); break } catch { if (Date.now() - t0 > 8000) { try { fs.rmdirSync(lock) } catch {} } else require('child_process').execSync('sleep 0.1') }
  }
  try { const b = rj(BOARD); const r = fn(b); wj(BOARD, b); return r } finally { try { fs.rmdirSync(lock) } catch {} }
}

// ---- operator utilities
const settings = () => { try { return rj(BOARD).settings || {} } catch { return {} } }
const musterOf = S => { const m = S && S.muster; return Array.isArray(m) ? { x: m[0], y: m[1], z: m[2] } : m || { x: 0, y: 64, z: 0 } } // a fresh board may have no muster yet: distances are then from 0,0
const tableOf = S => (S && Array.isArray(S.craftTable) && S.craftTable.length === 3) ? S.craftTable : null // the depot crafting table, set once on the board
let _mc = null
function mc () { // item/recipe data: MC_VERSION when given (like bots/manager.js), else 26.1 = world 2 - this CLI runs from plain shells without that env
  if (_mc) return _mc; const md = require(path.join(BOTS, 'node_modules', 'minecraft-data'))
  for (const v of [process.env.MC_VERSION, '26.1', '1.21.11', '1.21.4']) { try { if (v && (_mc = md(v))) return _mc } catch {} }
  throw new Error('minecraft-data knows none of MC_VERSION / 26.1 / 1.21.11 / 1.21.4')
}
function allHb () { let l = []; try { l = fs.readdirSync(path.join(DIR, 'hb')) } catch {} return l.map(f => { try { return rj(path.join(DIR, 'hb', f)) } catch { return null } }).filter(h => h && Date.now() - h.t < 180000) }
const STOCK = () => require(path.join(__dirname, 'stock.js')) // THE one definition of stock + stock groups (PLAN §9), shared with the dispatcher
function armyStock () { return STOCK().detail({ dir: DIR }) } // {chest, carried, top}
function ingredientsOf (item, n) { // -> {name: count} for n items, or null when not craftable
  const d = mc(); const it = d.itemsByName[item]; if (!it) return null
  const rs = d.recipes[it.id]; if (!rs || !rs.length) return null
  // several variants (cobblestone / blackstone / deepslate, any planks …): take the one the army can best afford, plain materials first
  const st = armyStock(); const have = k => (st.chest[k] || 0) + (st.carried[k] || 0)
  const namesOf = r => { const l = []; const add = c => { const id = c == null ? null : (typeof c === 'object' ? c.id : c); if (id != null && id >= 0) l.push(d.items[id].name) }; if (r.inShape) r.inShape.forEach(row => row.forEach(add)); else (r.ingredients || []).forEach(add); return l }
  const score = r => namesOf(r).reduce((a, k) => a + Math.min(have(k), 64) + (/^(cobblestone|stick)$|_planks$/.test(k) ? 1 : 0), 0)
  const r = rs.slice().sort((a, b) => score(b) - score(a))[0]; const per = (r.result && r.result.count) || 1; const runs = Math.ceil(n / per); const need = {}
  const add = c => { const id = c == null ? null : (typeof c === 'object' ? c.id : c); if (id == null || id < 0) return; const nm = d.items[id].name; need[nm] = (need[nm] || 0) + runs }
  if (r.inShape) r.inShape.forEach(row => row.forEach(add)); else (r.ingredients || []).forEach(add)
  return { need, runs, per }
}

// how a competent player GETS things that cannot simply be crafted — and which job/verb does it here
const HOWTO = {
  base: 'choose the land, do not fight it: scouts walk 8 bearings (`bootstrap` board) -> `sites` ranks flat, warm, watered areas -> LOOK at the best (template goto_look, mapshot.js) -> `base set x,y,z` (y = ground level) -> `node ops/skyshot.js x z 256 out.png` (the survey plan-base checks every pad against; a ravine or pond it shows -> `base keepout add`) -> `plan-base --put`: every zone is levelled first, then built from its blueprint, in the order of PLAN-world2 §8. Steer labour with `targets`, not with head-counts.',
  string: 'spiders (night, surface; 0-2 each) or cobwebs in mineshafts (sword). Here: muster bots kill what comes close at night and bank string into SALVAGE; a `steps` kill plan {do:"kill",kinds:["spider"],n:6,radius:40} for armed fit bots near the lit base. 2 string = fishing rod, 4 string = 1 wool, 12 string = a bed.',
  white_wool: 'sheep: shears give 1-3 wool without killing (shears = 2 iron ingots) — far better than killing (1 wool). Or 4 string -> 1 wool. 3 wool of ONE colour + 3 planks = bed. Known herds: `armyctl.js animals`; a flock at home: `howto livestock`.',
  livestock: 'a pen (blueprint `pen`: fence ring + ONE fence gate) and a `herd` job per kind (`template herd`): herders lure animals in with food in hand - sheep/cow: wheat, pig: carrot/potato/beetroot, chicken: any seeds - shut the gate, then feed pairs (5 min cooldown, a baby is an adult after 20 min). Events: herded {n,inPen} · bred {pairs,babies} · herd_lost · pen_open (ring gap / gate: re-activate the pen\'s build job). The depot\'s last 64 of the lure item are never taken. Pause `hunt` near the base while pens fill; wool: `shear` verb inside the pen.',
  leather: 'cows (0-2 each), also horses/llamas; rabbit hide x4. Needed for books -> bookshelves -> enchanting. Breed cows with wheat in a pen instead of hunting them out (`howto livestock`).',
  wheat_seeds: 'break short_grass/ferns (12.5% each): `collect` verb with block:["short_grass","fern"]; every harvested ripe wheat returns 0-3 seeds — replant everything until the field is full (the `farm` job does both).',
  raw_iron: 'the mine squad (the board\'s mine job, long `shiftMin` because of the commute) works ONE level below the mine head; status: `mine`. Iron is richest around y 16, diamonds/redstone/gold around y -54 (almost no iron there): `mine level <y> dry` tells what moving the level does (pause the mine job first so nobody is below).',
  iron_ingot: 'smelt raw_iron (template smelt). Priorities: bucket (3) -> shears (2) -> shield (1 + 6 planks) -> iron pickaxe (3) -> sword (2) -> armour (24 full set).',
  coal: 'coal ore, anywhere in stone, richest y 96 and up in hills; miners bank it. No coal? charcoal = smelt logs (fuel: planks).',
  charcoal: 'smelt any log in a furnace (fuel: planks or more logs). 1 charcoal = 1 coal for torches and smelting.',
  torch: '1 coal/charcoal + 1 stick -> 4 torches. Light level 1+ stops most hostile spawns (1.18+): a torch every ~12 blocks on flat ground.',
  cobblestone: 'mine stone with any pickaxe — the branch mine produces thousands; never quarry the surface outside a quarry zone (docs/WORLD.md).',
  log: 'fell whole trees inside a lumber zone (docs/WORLD.md), replant saplings of the same kind: template lumber.',
  food: 'fastest here: fishing (rod: 3 sticks + 2 string; ~2.8 fish/min/rod), cook in a furnace/smoker/campfire. Sustainable: wheat -> bread (3 wheat), potatoes/carrots if zombies drop them, bred animals in pens. Regeneration needs food >= 18.',
  bed: '3 wool of one colour + 3 planks. ONE sleeping bot skips the night for everyone here (players_sleeping_percentage=1) and sleeping resets phantoms. Place inside the lit base (dorm zone, docs/WORLD.md).',
  bucket: '3 iron ingots. Water bucket: `fill` verb at an open water source (ice hole / lake); `pour` places a source. Two sources diagonal in a 2x2 hole = infinite water.',
  obsidian: 'pour water onto a lava SOURCE (find lava lakes below y 0 or on the surface), mine with a DIAMOND pickaxe (9.4 s). Portal frame = 10 (corners optional).',
  diamond: 'deepslate layers, best y -59, branch mine with an IRON pickaxe or better; carry a water bucket for lava. 3 = pickaxe, 2 = sword, 2 + 4 obsidian + 1 book = enchanting table.',
  ender_pearl: 'endermen (night, open plains/desert; warped forest in the Nether is full of them): look at their feet, fight from under a 2-high roof; or barter gold ingots with piglins. ~16 pearls for 12+ eyes.',
  blaze_rod: 'blazes at spawners in Nether fortresses; shield + bow/snowballs, fire resistance helps. 1 rod -> 2 blaze powder; eye of ender = pearl + powder. Get ~12 rods.',
  gold_ingot: 'gold ore y -16 (or badlands), nether gold ore in the Nether (iron pickaxe). Needed for piglin barter and golden apples.',
  sugar_cane: 'grows on sand/dirt/grass whose soil block touches water, up to 3 high (~18 min per block). Job type `cane` (`template cane`): a FARM box over a lake/river shore (cells are found by looking; cut = the 2nd block, the base regrows) and WILD trips to stands the scouts saw (`grep cane bots/army/scout.jsonl`) for the first stock. 3 cane -> 3 paper; 3 paper + 1 leather -> book; 3 books + 6 planks -> bookshelf (15 + table = 46 books = 138 cane, 46 leather). Events: cane_pass · cane_trip · cane_wild_done.',
  book: '3 paper + 1 leather (shapeless). Paper = 3 sugar cane in a row (`howto sugar_cane`), leather = surplus adult cows (`herd` with params.cull, `howto leather`). The quartermaster crafts paper/book/bookshelf up to `armyctl.js targets`.',
  arrow: 'flint + stick + feather -> 4 arrows: gravel gives flint (10%), chickens give feathers; skeletons drop arrows and bows.'
}
const KNOWN_TYPES = ['ores', 'lumber', 'tidy', 'build', 'berries', 'light', 'sleeper', 'guard', 'muster', 'hunt', 'herd', 'fish', 'scan', 'delegate', 'scout', 'depot', 'farm', 'cane', 'deck', 'haul', 'steps']
const KNOWN_VERBS = ['goto', 'bank', 'withdraw', 'stash', 'unstash', 'place', 'dig', 'collect', 'fell', 'craft', 'smelt', 'kill', 'pickup', 'drop', 'shear', 'till', 'equip', 'eat', 'sleep', 'wait', 'say', 'sample', 'fill', 'pour']
// extension modules bots/skills/lib/jobs_<name>.js bring their own job types and verbs (static TYPES / VERBS lists): see the end of army_jobs.js
try { for (const f of fs.readdirSync(path.join(__dirname, '..', 'skills', 'lib')).filter(q => /^jobs_[a-z0-9]+\.js$/.test(q))) { const m = require(path.join(__dirname, '..', 'skills', 'lib', f)); for (const t of m.TYPES || []) if (!KNOWN_TYPES.includes(t)) KNOWN_TYPES.push(t); for (const v of m.VERBS || []) if (!KNOWN_VERBS.includes(v)) KNOWN_VERBS.push(v) } } catch (e_) { console.error('armyctl: extension list failed: ' + (e_ && e_.message)) }
const stockKey = k => typeof k === 'string' && (!!STOCK().groups[k] || !!mc().itemsByName[k]) // a stock group (log, planks, food, fuel …) or an item name
function blueprintFile (name) { const f = path.join(BOTS, 'blueprints', String(name).replace(/[^a-z0-9_]/gi, '') + '.js'); return fs.existsSync(f) ? f : null }
function blueprintCells (P) { const f = blueprintFile(P.blueprint); delete require.cache[f]; return require(f)({ x: P.origin[0], y: P.origin[1], z: P.origin[2] }, P.args || {}) } // fresh: another engineer may have edited it
function validateSettings (S) { // what the CLI itself writes into settings (bootstrap, base set, targets); PLAN §9
  const errs = []; const num3 = o => o && ['x', 'y', 'z'].every(k => Number.isFinite(o[k]))
  if (!Array.isArray(S.roster) || !S.roster.length) errs.push('settings.roster is empty')
  if (S.base != null && (!num3(S.base) || S.base.y < -60 || S.base.y > 300)) errs.push('settings.base must be {x,y,z} (y = ground level of the base)')
  if (S.muster != null && !num3(S.muster)) errs.push('settings.muster must be {x,y,z[,cols,step]} (what the workers read)')
  for (const [k, n] of Object.entries(S.targets || {})) { if (!stockKey(k)) errs.push('settings.targets: "' + k + '" is neither an item nor a stock group (' + Object.keys(STOCK().groups).join(' ') + ')'); if (!(Number.isFinite(n) && n >= 0)) errs.push('settings.targets.' + k + ' must be a number >= 0 (0 = we want none)') }
  if (S.fallback != null && typeof S.fallback !== 'string') errs.push('settings.fallback must be a job id')
  if (S.keepOut != null && !Array.isArray(S.keepOut)) errs.push('settings.keepOut must be a list of {id, box:[x1,z1,x2,z2], why}')
  else (S.keepOut || []).forEach((k, i, l) => { const b = k && k.box; if (!k || !/^[a-z0-9_]+$/i.test(k.id || '') || l.findIndex(q => q && q.id === k.id) !== i) errs.push('settings.keepOut[' + i + ']: id must be unique letters/digits/_'); if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isInteger) || b[0] > b[2] || b[1] > b[3]) errs.push('settings.keepOut[' + i + '].box must be [x1,z1,x2,z2] integers, x1<=x2, z1<=z2'); if (!k || typeof k.why !== 'string' || !k.why.trim()) errs.push('settings.keepOut[' + i + '].why is mandatory (the next operator must know what is there)') })
  return errs
}
function validateJob (job, S, ids) { // S = the settings the job will live under (default: the board), ids = job ids that will exist beside it (for `after`)
  const errs = []; const d = mc(); let b0 = null; if (!S || !ids) { try { b0 = rj(BOARD) } catch { b0 = {} } }
  const roster = (S || b0.settings || {}).roster || []; const known = ids || (b0.jobs || []).map(j => j.id)
  if (!/^[a-z0-9_]+$/i.test(job.id || '')) errs.push('id must be letters/digits/_')
  if (!KNOWN_TYPES.includes(job.type)) errs.push('unknown type ' + job.type + ' (known: ' + KNOWN_TYPES.join(' ') + ')')
  if (!['active', 'paused'].includes(job.status)) errs.push('status must be active|paused')
  if (job.when && !['day', 'night', 'any'].includes(job.when)) errs.push('when must be day|night|any')
  if (!job.names && !job.bots && !(job.produces && job.maxBots)) errs.push('give names:[…], bots:<head-count>, or produces + minBots/maxBots (labour by demand)')
  for (const n of job.names || []) if (!roster.includes(n)) errs.push('unknown bot ' + n)
  if (!job.plan) errs.push('plan (zone / why) is mandatory')
  // labour by demand (PLAN §3/§9): the dispatcher scales head-count between minBots and maxBots with the worst deficit of what the job produces
  if (job.produces != null) {
    if (!Array.isArray(job.produces) || !job.produces.length) errs.push('produces must be a list of items / stock groups')
    else for (const k of job.produces) if (!stockKey(k)) errs.push('produces: "' + k + '" is neither an item nor a stock group (' + Object.keys(STOCK().groups).join(' ') + ')')
    if (!Number.isInteger(job.maxBots) || job.maxBots < 1) errs.push('a job with produces needs maxBots (head-count at full deficit)')
    if (job.names) errs.push('produces scales a head-count: use minBots/maxBots, not names')
  }
  for (const k of ['minBots', 'maxBots', 'bots']) if (job[k] != null && !(Number.isInteger(job[k]) && job[k] >= 0 && job[k] <= Math.max(roster.length, 1))) errs.push(k + ' must be an integer 0..' + roster.length + ' (the roster)')
  if (job.minBots != null && job.maxBots != null && job.minBots > job.maxBots) errs.push('minBots > maxBots')
  if (job.maxBots != null && !job.produces) errs.push('maxBots without produces does nothing: jobs without produces are staffed by `bots`')
  if (job.alertBots != null) errs.push('alertBots is dead (world 2: humans are spectators, there is nobody to be alerted about) - drop the field')
  const archivedIds = () => { try { return fs.readFileSync(path.join(DIR, 'jobs-archive.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).id } catch { return null } }) } catch { return [] } } // a FINISHED predecessor that `prune` archived is still a predecessor (09-20: `patch base_dorm` was refused for its archived pad)
  if (job.after != null && (typeof job.after !== 'string' || job.after === job.id || !(known.includes(job.after) || archivedIds().includes(job.after)))) errs.push('after must name ANOTHER job on the board (the predecessor in a build order)')
  const xyz = (c, what, yOpt) => { if (!Array.isArray(c) || c.length !== 3 || [c[0], c[2]].some(v => typeof v !== 'number') || (c[1] == null ? !yOpt : typeof c[1] !== 'number')) errs.push(what + ' must be [x,y,z]'); else if (c[1] != null && (c[1] < -64 || c[1] > 319)) errs.push(what + ' y out of range') }
  const P = job.params || {}
  if (job.type === 'steps') {
    if (!Array.isArray(P.steps) || !P.steps.length) errs.push('params.steps missing')
    ;(P.steps || []).forEach((st, i) => {
      const at = 'step ' + (i + 1) + ' (' + st.do + '): '
      if (!KNOWN_VERBS.includes(st.do)) return errs.push(at + 'unknown verb (known: ' + KNOWN_VERBS.join(' ') + ')')
      if (st.do === 'goto') xyz(st.to, at + 'to', true)
      if (['place', 'dig'].includes(st.do)) { if (st.cells) st.cells.forEach(c => xyz(c, at + 'cell')); else xyz(st.at, at + 'at') }
      if (['fill', 'pour', 'till', 'stash', 'unstash'].includes(st.do)) xyz(st.at, at + 'at')
      for (const k of ['item', 'block', 'seed']) for (const nm of [].concat(st[k] || [])) if (typeof nm !== 'string' || (!d.itemsByName[nm] && !d.blocksByName[nm])) errs.push(at + 'unknown ' + k + ' "' + nm + '"')
      if (st.do === 'place' && !st.block) errs.push(at + 'block missing')
      if (st.do === 'place' && /^(water|lava)$/.test(String(st.block))) errs.push(at + 'liquids are POURED from a bucket (verb pour), or built as a `water` cell of a blueprint - never placed')
      if (['withdraw', 'craft', 'smelt'].includes(st.do) && !st.item) errs.push(at + 'item missing')
      if (st.do === 'craft' && st.item && !ingredientsOf(st.item, 1)) errs.push(at + st.item + ' has no crafting recipe (smelt it?)')
    })
  }
  if (['farm', 'deck', 'light', 'tidy'].includes(job.type)) { if (!Array.isArray(P.box) || P.box.length !== 4) errs.push('params.box must be [x1,z1,x2,z2]'); if (typeof P.y !== 'number') errs.push('params.y (layer/soil level) missing') }
  if (job.type === 'haul') xyz(P.from, 'params.from')
  if (job.type === 'lumber' && (!Array.isArray(P.box) || P.box.length !== 4 || P.box.some(n => typeof n !== 'number'))) errs.push('params.box must be [x1,z1,x2,z2]')
  if (job.type === 'build') {
    xyz(P.origin, 'params.origin')
    if (!P.blueprint || !blueprintFile(P.blueprint)) errs.push('params.blueprint: unknown (see `armyctl.js blueprints`)')
    else if (!errs.length) { // RUN it: a blueprint that throws on these args, or names a block nobody can place, fails here and not in 30 bots
      // cell kinds (PLAN §9): block names, `air` = dig, `water` = a BUILT water cell (dig -> solid floor/sides -> pour -> verify source)
      try {
        const cells = blueprintCells(P); const bad = new Set(); let oob = 0
        for (const c of cells) { if (!d.blocksByName[c.block]) bad.add(String(c.block)); if (![c.x, c.y, c.z].every(Number.isInteger) || c.y < -64 || c.y > 319) oob++ }
        if (!cells.length) errs.push('blueprint ' + P.blueprint + ' yields no cells with these args')
        if (cells.length > 120000) errs.push('blueprint yields ' + cells.length + ' cells - split the work into several jobs (every bot computes and scans them)')
        if (bad.size) errs.push('blueprint cells name unknown blocks: ' + [...bad].slice(0, 6).join(', ') + ' (cell kinds: block names, air, water)')
        if (oob) errs.push(oob + ' blueprint cells have non-integer coordinates or y out of range')
      } catch (e) { errs.push('blueprint ' + P.blueprint + ' fails with these args: ' + String(e.message).slice(0, 100)) }
    }
  }
  if (['hunt', 'fish', 'berries', 'cane'].includes(job.type)) xyz(job.site, 'site')
  if (job.type === 'cane') { // farm: a box of lake/river shore + its soil level; wild: stands seen by scouts (`grep cane bots/army/scout.jsonl`)
    if (P.wild) { for (const s of P.sites || []) xyz(s, 'params.sites[]'); if (P.farm != null && !known.includes(P.farm)) errs.push('params.farm must name the cane FARM job on the board (the wild trips end when it holds `until` plants)') } else { if (!Array.isArray(P.box) || P.box.length !== 4 || !P.box.every(Number.isInteger)) errs.push('params.box must be [x1,z1,x2,z2] over a SHORE (cane cells = sand/dirt/grass whose soil block touches water; found by looking)'); if (typeof P.y !== 'number') errs.push('params.y (soil level of the shore = the water level) missing') }
    for (const k of ['radius', 'haul', 'until', 'bankAt']) if (P[k] != null && !(Number.isFinite(P[k]) && P[k] > 0)) errs.push('params.' + k + ' must be a number > 0')
  }
  if (job.type === 'herd') { // the pen is a FENCE RING that stands (blueprint `pen`), the gate is a cell ON that ring, the kind decides the lure item
    const LURE = { sheep: 'wheat', cow: 'wheat', pig: 'carrot / potato / beetroot', chicken: 'any seeds' }
    if (!LURE[P.kind]) errs.push('params.kind must be one of ' + Object.keys(LURE).join(' | '))
    const okPen = Array.isArray(P.pen) && P.pen.length === 4 && P.pen.every(Number.isInteger); if (!okPen) errs.push('params.pen must be [x1,z1,x2,z2] = the fence ring (integers)')
    xyz(P.gate, 'params.gate')
    if (okPen && Array.isArray(P.gate) && P.gate.length === 3) { const x1 = Math.min(P.pen[0], P.pen[2]); const x2 = Math.max(P.pen[0], P.pen[2]); const z1 = Math.min(P.pen[1], P.pen[3]); const z2 = Math.max(P.pen[1], P.pen[3]); const [gx, , gz] = P.gate; const inBox = gx >= x1 && gx <= x2 && gz >= z1 && gz <= z2; if (!inBox || !(gx === x1 || gx === x2 || gz === z1 || gz === z2)) errs.push('params.gate must be a cell ON the ring of params.pen (the fence gate itself; blueprint `pen`: middle of the gate side, y = ground + 1)'); if (x2 - x1 < 4 || z2 - z1 < 4) errs.push('params.pen is smaller than 5x5') }
    for (const k of ['want', 'radius', 'budget', 'keepStock', 'max', 'keep']) if (P[k] != null && !(Number.isFinite(P[k]) && P[k] >= 0)) errs.push('params.' + k + ' must be a number >= 0')
    if (P.radius > 400) errs.push('params.radius > 400: an animal walks ~2.5 blocks/s behind the lure - build a pen near the herd instead')
  }
  if (job.type === 'delegate' && P.skill !== 'iron_miner') errs.push('delegate skill must be iron_miner')
  if (job.type === 'delegate' && P.args && P.args.level != null && !(Number.isFinite(P.args.level) && P.args.level >= -59 && P.args.level <= 60)) errs.push('params.args.level must be a y between -59 and 60')
  if (job.type === 'scout' && P.bearings && (!Array.isArray(P.bearings) || P.bearings.some(a => !Number.isFinite(a)))) errs.push('params.bearings must be degrees [0 = north, 90 = east …]')
  return errs
}
function templates () { // coordinates: from the board (settings.craftTable) or <placeholders> - never a number from an old world
  const t = tableOf(settings()); const atTable = t || ['<craft table x>', '<y>', '<z>']; const tableTxt = t ? 'the depot crafting table (' + t.join(',') + ')' : 'the depot crafting table (set settings.craftTable on the board)'
  return {
    toolsmith: { id: 'toolsmith_X', type: 'steps', priority: 94, status: 'active', when: 'any', names: ['<idle bot>'], plan: 'crafting at ' + tableTxt + '; no world change', params: { onFail: 'continue', steps: [{ do: 'withdraw', item: 'cobblestone', n: 64 }, { do: 'withdraw', item: 'stick', n: 40 }, { do: 'goto', to: atTable, range: 2 }, { do: 'craft', item: 'stone_pickaxe', n: 8 }, { do: 'craft', item: 'stone_hoe', n: 4 }, { do: 'bank', keep: { stone_sword: 1 } }] } },
    lumber: { id: 'lumber_<zone>', type: 'lumber', priority: 84, front: 'lumber', status: 'active', when: 'any', produces: ['log'], minBots: 2, maxBots: 8, site: ['<x centre>', '<y>', '<z centre>'], plan: 'TREE FARM zone <name from docs/WORLD.md>: squad fells the trees inside the box, replants saplings on a 3-block grid, banks logs; bots are handed back while saplings grow', requires: { minHp: 8 }, params: { box: ['<x1>', '<z1>', '<x2>', '<z2>'], pitch: 3, bankAt: 48 } },
    torches: { id: 'pw_torches_X', type: 'steps', priority: 72, front: 'works', status: 'active', when: 'day', names: ['<idle bot>'], plan: 'lighting grid (docs/WORLD.md); torches on the ground at groundY+1 (use `ground` first)', params: { onFail: 'continue', steps: [{ do: 'withdraw', item: 'coal', n: 4 }, { do: 'withdraw', item: 'stick', n: 4 }, { do: 'goto', to: atTable, range: 2 }, { do: 'craft', item: 'torch', n: 4 }, { do: 'place', block: 'torch', at: ['<x>', '<groundY+1>', '<z>'] }] } },
    haul: { id: 'haul_X', type: 'haul', priority: 78, status: 'active', when: 'day', bots: 1, requires: { minHp: 14, minFood: 12 }, plan: 'no world change', params: { from: ['<site chest x>', '<y>', '<z>'], min: 24 } },
    farm: { id: 'farm_X', type: 'farm', priority: 75, front: 'farm', status: 'active', when: 'day', produces: ['food', 'wheat_seeds'], minBots: 1, maxBots: 6, site: ['<cx>', '<y+1>', '<cz>'], requires: { anyItem: ['stone_hoe', 'wooden_hoe', 'iron_hoe'] }, plan: '<zone>: every cell needs water within 4 blocks at soil level or one above', params: { box: ['<x1>', '<z1>', '<x2>', '<z2>'], y: '<soil y>', seed: 'wheat_seeds', forage: true, bankAt: 48 } },
    deck: { id: 'deck_X', type: 'deck', priority: 80, front: 'works', status: 'active', when: 'day', bots: 6, requires: { anyItem: ['cobblestone'] }, plan: '<zone>: close the layer y=<Y> from the rim inwards', params: { box: ['<x1>', '<z1>', '<x2>', '<z2>'], y: '<layer y>', block: 'cobblestone' } },
    smelt: { id: 'smelt_X', type: 'steps', priority: 88, status: 'active', when: 'any', names: ['<idle bot>'], plan: 'depot furnaces (settings.furnaces, registered by the build job); no world change', params: { repeat: true, onFail: 'continue', steps: [{ do: 'withdraw', item: 'raw_iron', n: 32 }, { do: 'withdraw', item: 'coal', n: 4 }, { do: 'smelt', item: 'raw_iron', n: 32 }, { do: 'bank', keep: { stone_sword: 1 } }, { do: 'wait', s: 30 }] } },
    goto_look: { id: 'probe_X', type: 'steps', priority: 60, status: 'active', when: 'day', names: ['<fit idle bot>'], plan: 'read-only probe: walk there, stand 10 min so the operator can `look`', params: { steps: [{ do: 'goto', to: ['<x>', null, '<z>'], range: 4, s: 400 }, { do: 'sample' }, { do: 'wait', s: 600 }] } },
    build: { id: 'build_X', type: 'build', priority: 84, front: 'works', status: 'active', when: 'day', bots: 6, site: ['<x>', '<y>', '<z>'], plan: '<zone from docs/WORLD.md>: <what and why>', params: { blueprint: '<name from `armyctl.js blueprints`>', origin: ['<centre x>', '<ground y (use `ground`)>', '<centre z>'], args: {} } },
    cane: { id: 'cane_farm', type: 'cane', priority: 80, front: 'farm', status: 'active', when: 'any', bots: 1, site: ['<dry spot on the shore x>', '<y>', '<z>'], requires: { minHp: 12, minFood: 8 }, plan: '<shore zone from docs/WORLD.md>: sugar cane is planted on the natural shore cells (sand/dirt/grass touching water) - nothing is dug, tilled or poured', params: { box: ['<x1>', '<z1>', '<x2>', '<z2>'], y: '<soil y = water level>', bankAt: 48 }, note: 'WILD trips for the first stock: same type with params {wild:true, sites:[[x,y,z],…], radius:32, haul:64, farm:"cane_farm", until:32} and site = the first stand (`grep cane bots/army/scout.jsonl`); pauses itself at `until` plants' },
    herd: { id: 'herd_<kind>', type: 'herd', priority: 86, front: 'pens', status: 'active', when: 'day', bots: 3, site: ['<gate x>', '<gate y>', '<gate z>'], requires: { minHp: 14, minFood: 10 }, plan: '<pen zone from docs/WORLD.md>: livestock is LURED into the finished pen and bred there; no world change (the gate is opened and shut)', params: { pen: ['<ring x1>', '<ring z1>', '<ring x2>', '<ring z2>'], gate: ['<gate x>', '<gate y = ground + 1>', '<gate z>'], kind: '<sheep|cow|pig|chicken>', want: 10, radius: 250 } },
    hunt: { id: 'hunt_X', type: 'hunt', priority: 90, front: 'herd', status: 'active', when: 'day', produces: ['food'], minBots: 2, maxBots: 8, site: ['<herd x>', '<y>', '<z>'], requires: { minHp: 14, minFood: 12 }, plan: 'gathering (no world change)', params: { kinds: ['sheep', 'cow', 'pig', 'chicken'], leave: 2, haul: 20, departBefore: 3000, leaveBy: 7000 } }
  }
}
// ---- a new world: survey -> base -> plan (docs/PLAN-world2.md §1, §2, §8). World 1's base was built blind in a snowy taiga and grew where bots stood.
const flag = name => process.argv.includes(name)
const flagXYZ = name => { const i = process.argv.indexOf(name); if (i < 0) return null; const c = String(process.argv[i + 1] || '').split(',').map(Number); return c.length === 3 && c.every(Number.isFinite) ? c.map(Math.round) : 'bad' }
// BASE SITES. A scout sample describes 17x17 columns; a base needs ~130x150 on ONE level. So a site = the samples within 64 blocks of a seed sample whose
// feet are within +-2 of it, and its score says why: flat area (mean `flat` + how many distinct flat neighbours), climate (cold/frozen = out: world 1),
// LIQUID water, trees / animals / cane within 100, a village within 300, a dead scout within 100. Distance from spawn is irrelevant (humans = spectators).
const SITE_OK = 70 // base-grade: flat neighbours + kind climate + liquid water + most of the bonuses
function rankSites (rows) {
  const tempOf = r => r.temp || (/snowy|frozen|ice|peaks|grove/.test(r.biome || '') ? 'cold' : /desert|badlands/.test(r.biome || '') ? 'dry' : /savanna|jungle/.test(r.biome || '') ? 'warm' : 'temperate')
  const S = rows.filter(r => Array.isArray(r.pos) && r.pos.length === 3).map(r => ({ // old samples (world-1 format) have no flat/temp/cane: derived from relief/biome/crops
    x: r.pos[0], y: r.pos[1], z: r.pos[2], biome: r.biome || '?', hazard: !!r.hazard, temp: tempOf(r), ice: !!r.ice, water: r.water && !r.ice ? r.water : null, icy: !!(r.water && r.ice),
    flat: typeof r.flat === 'number' ? r.flat : r.relief == null ? 0 : r.relief <= 1 ? 0.9 : r.relief <= 2 ? 0.75 : r.relief <= 4 ? 0.5 : 0.2,
    tree: !!r.tree, cane: !!r.cane, village: r.village || null, animals: r.animals || {}, wet: /ocean|river|beach|swamp|mangrove/.test(r.biome || '') || /water|ice/.test(r.ground || '')
  }))
  const G = new Map(); const gk = (x, z) => Math.floor(x / 128) + ',' + Math.floor(z / 128)
  for (const s of S) { const k = gk(s.x, s.z); if (!G.has(k)) G.set(k, []); G.get(k).push(s) }
  const within = (c, r) => { const out = []; const n = Math.ceil(r / 128); for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const s of G.get(gk(c.x + i * 128, c.z + j * 128)) || []) if (Math.hypot(s.x - c.x, s.z - c.z) <= r) out.push(s); return out }
  const sites = []; const seeded = new Set()
  for (const seed of S) {
    const cell = Math.floor(seed.x / 16) + ',' + Math.floor(seed.z / 16) + ',' + seed.y; if (seed.hazard || seed.wet || seeded.has(cell)) continue; seeded.add(cell) // one seed per 16-block cell
    const mem = within(seed, 64).filter(s => !s.hazard && !s.wet && Math.abs(s.y - seed.y) <= 2); const near = within(seed, 100)
    const cells = new Map(); for (const s of mem) if (s.flat >= 0.6) { const k = Math.floor(s.x / 16) + ',' + Math.floor(s.z / 16); if (!cells.has(k) || cells.get(k).flat < s.flat) cells.set(k, s) } // a bot standing still must not count as ten neighbours
    const fl = [...cells.values()]; if (!fl.length) continue
    const mean = fl.reduce((a, s) => a + s.flat, 0) / fl.length
    const why = []; let score = 0; const add = (n, t) => { score += n; why.push((n >= 0 ? '+' : '') + n + ' ' + t) }
    add(Math.round(25 * mean), 'flat ' + mean.toFixed(2)); add(Math.min(15, 3 * (fl.length - 1)), fl.length + ' flat neighbour cells on y' + seed.y + '+-2')
    const cold = near.filter(s => s.temp === 'cold' || s.ice).length; const temps = {}; for (const s of mem) temps[s.temp] = (temps[s.temp] || 0) + 1
    const temp = Object.entries(temps).sort((a, b) => b[1] - a[1])[0][0]
    if (cold) add(-40, 'COLD/ice in ' + cold + '/' + near.length + ' samples within 100'); else add(temp === 'dry' ? 5 : 15, temp)
    const wIn = mem.find(s => s.water); const wNear = near.find(s => s.water)
    if (wIn) add(20, 'liquid water @' + wIn.water); else if (wNear) add(10, 'liquid water within 100 @' + wNear.water); else why.push(near.some(s => s.icy) ? 'the water is ICE' : 'NO liquid water seen')
    if (near.some(s => s.tree)) add(10, 'trees'); else why.push('no trees within 100')
    const an = {}; for (const s of near) for (const [k, n] of Object.entries(s.animals)) an[k] = Math.max(an[k] || 0, n) // the same herd is seen from several samples
    const nAn = Object.values(an).reduce((a, b) => a + b, 0); if (nAn) add(Math.min(10, 2 * nAn), 'animals ' + Object.entries(an).map(([k, n]) => k + ':' + n).join(' ')); else why.push('no animals')
    if (near.some(s => s.cane)) add(5, 'sugar cane')
    const vil = within(seed, 300).find(s => s.village); if (vil) add(5, 'village @' + vil.village)
    if (near.some(s => s.hazard)) add(-10, 'a scout DIED within 100')
    const ys = {}; for (const s of fl) ys[s.y] = (ys[s.y] || 0) + 1; const y = +Object.entries(ys).sort((a, b) => b[1] - a[1])[0][0]
    const at = fl.filter(s => Math.abs(s.y - y) <= 1); const cx = Math.round(at.reduce((a, s) => a + s.x, 0) / at.length); const cz = Math.round(at.reduce((a, s) => a + s.z, 0) / at.length)
    const biomes = {}; for (const s of mem) biomes[s.biome] = (biomes[s.biome] || 0) + 1
    sites.push({ score, x: cx, y, z: cz, ground: y - 1, n: fl.length, flat: mean, biome: Object.entries(biomes).sort((a, b) => b[1] - a[1])[0][0], why, ok: score >= SITE_OK && fl.length >= 3 && !cold && !!(wIn || wNear) })
  }
  sites.sort((a, b) => b.score - a.score)
  const out = []; for (const s of sites) if (!out.some(q => Math.hypot(q.x - s.x, q.z - s.z) < 96)) out.push(s) // one line per neighbourhood
  return out
}

// THE BASE PLAN: zones on a LATTICE relative to settings.base, x east / z south, [x1,z1,x2,z2] inclusive, all on the base level y (GROUND block level).
// Lattice = 32x32 slots between 3-wide roads (pitch 35). With no keep-out the two avenues cross at the origin (the PLAZA) and zones keep 2 off the axes.
// Order = PLAN §8: field 1 -> core pad + hall + depot rows (+ muster yard) -> tree farm -> mine head -> roads -> torch grid -> dorm -> fields 2..n, pens -> wall.
// Every zone takes the free slot NEAREST THE PLAZA (ties: its traditional quarter - field 1 SW, core NE, yard/dorm NW, mine SE); yard + dorm share one
// slot, two pens share one; the tree farm (48x48) spans 2x2 slots; what stays free is RESERVE for fields n+1.. and what comes later.
// KEEP-OUTS (settings.keepOut; incident 09-19 19:00Z: the first plan was laid BLIND from an aerial "relief 4" score - a ravine down to y41 ran through
// the core pad beside the plaza, bots fell in on the first night, the foreman paused base_core_pad and the whole `after` chain stalled): a keep-out (+3)
// is a BLOCK OF THE LATTICE. A road runs along each of its sides (the avenues are the lattice lines nearest the origin), slots are re-fitted between the
// lines from the side nearest the origin, no zone and no road touches it, the wall encloses it when it lies in or beside the base.
// THE PLAN LOOKS (opt.check = the aerial survey, ops/skyshot.js): a slot that is BAD (holes, steps, water) is skipped and rough ground counts as distance
// (1 block of mean earthwork = 8 blocks of walking; 1 block the base outline grows = 1 block). A zone whose jobs made progress is PINNED where it stands - unless that place is BAD or kept out.
// SIZED BY THE ROSTER (owner: everything x N bots): 4 field blocks, 2 pens, 16 furnaces, 8 chest columns per depot row are the numbers for 30 bots.
const CELL = 32; const KEEP = 3; const SHORT = 13; const REACH = 6 * 35 - 3 // slot, margin around a keep-out, the smallest useful band (a pen, the mine head), lattice reach beyond the outermost line
const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
const grow = (r, n) => [r[0] - n, r[1] - n, r[2] + n, r[3] + n]
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
const padOf = r => { const p = grow(r, 1); if ((p[2] - p[0]) % 2) p[2]++; if ((p[3] - p[1]) % 2) p[3]++; return p } // `level` is centred: odd sizes only; the spare column falls into a road
const roadRect = c => c[1] === c[3] ? [c[0], c[1] - 1, c[2], c[3] + 1] : [c[0] - 1, c[1], c[2] + 1, c[3]]
function baseZones (N) { // w x d = the zone's rect; builds(r, zone) = [blueprint, rect it is laid out in (default: the zone), job name, args (default {w,d})]; room = slot depth it claims for its group
  const even = n => 2 * Math.ceil(n / 2); const nF = Math.min(8, Math.max(4, Math.ceil(4 * N / 30))); const nP = Math.min(4, Math.max(2, Math.ceil(2 * N / 30)))
  const field = i => ({ id: 'field_' + (i + 1), w: 29, d: 29, pref: i ? null : [-1, 1], builds: r => [['field_block', grow(r, -1), null, {}]], prod: 'farm', what: 'field block 27x27 in a 29x29 slot (its torch ring): nine 9x9 plots, water cells BUILT by the blueprint' })
  const pen = i => ({ id: 'pen_' + (i + 1), w: 27, d: 13, group: 'pens', room: 28, pref: [1, 1], builds: (r, z) => [['pen', null, null, { w: 27, d: 13, gate: z.hugW ? 'w' : 'e' }]], what: 'animal pen 27x13: fence ring, ONE gate onto the road beside it' })
  const halls = Math.min(2, Math.ceil(N / 54)); const per = even(Math.ceil(N / halls)) // a dorm hall holds 2 * (29 - 2) = 54 bed slots; two halls fit the 29x17 zone
  const F = []; for (let i = 0; i < nF; i++) F.push(field(i)); const P = []; for (let i = 0; i < nP; i++) P.push(pen(i))
  return [
    F[0],
    { id: 'core', w: 32, d: 32, pref: [1, -1], builds: r => [['core', [r[0], r[1], r[2], r[1] + 9], 'hall', { w: 32, d: 10, furnaces: Math.min(20, Math.ceil(16 * N / 30)) }], ['depot_rows', [r[0], r[1] + 12, r[2], r[3]], 'depot', { w: 32, d: 20, len: Math.min(30, even(Math.max(8, Math.round(8 * N / 30)))) }]], what: 'core 32x32: THE craft table + furnace bank (north strip 32x10), depot rows of double chests by category (south 32x20; grow them with len/high + rev)' },
    { id: 'yard', w: 29, d: 13, group: 'civic', room: 32, pref: [-1, -1], builds: () => [], what: 'muster yard 29x13 (settings.muster): a level pad, nothing built on it' },
    { id: 'tree', w: 48, d: 48, pref: [1, -1], builds: () => [['tree_farm', null, null, { w: 48, d: 48 }]], prod: 'lumber', what: 'tree farm 48x48: soil on a 3-grid, lit; clear + level first, the lumber squad plants' },
    { id: 'mine', w: 15, d: 15, pref: [1, 1], builds: (r, z) => [['mine_head', null, null, { facing: z.facing || 'south' }]], prod: 'mine', what: 'mine head: hut, haul chests and light AROUND the stair mouth (zone centre); the stairwell itself is dug and owned by the miners' },
    { id: 'dorm', w: 29, d: 17, group: 'civic', pref: [-1, -1], builds: r => { const l = []; for (let h = 0; h < halls; h++) l.push(['dorm', [r[0], r[1] + 9 * h, r[2], r[1] + 9 * h + 7], 'dorm' + (h ? '_' + (h + 1) : ''), { w: 29, d: 8, slots: per, beds: h ? 0 : 1 }]); return l }, what: 'dorm: ' + halls + ' hall(s) with ' + per * halls + ' bed slots for ' + N + ' bots, 1 bed now (the sleeper\'s) - raise `beds` + rev as wool arrives; beds register as respawnBeds' }
  ].concat(F.slice(1), P, [
    // LAST in the list = it takes a free slot and moves nothing that stands (owner 09-20: the cane farm on the lake shore lay 100-180 blocks from the army - chunks
    // beyond ~128 of a player do not tick, 8-22 plants after 3 hours)
    { id: 'cane', w: 21, d: 21, pref: [-1, -1], builds: () => [['cane_block', null, null, { w: 21, d: 21 }]], prod: 'cane', what: 'sugar cane block 21x21 INSIDE the base (crops grow only in ticked chunks): plus-tiling of isolated water cells BUILT by the blueprint (one bucket each from settings/params waterFrom), ~270 cane cells, paved ring, lit' }
  ])
}
const keepOutRel = (base, keepOut) => (keepOut || []).map(k => ({ id: k.id, why: k.why, rect: grow([k.box[0] - base.x, k.box[1] - base.z, k.box[2] - base.x, k.box[3] - base.z], KEEP) }))
function baseLayout (base, N, keepOut, opt = {}) { // -> { zones (with rect), roads [{c, avenue}], wall, K, plaza, notes, unpinned }; everything RELATIVE to base
  const K = keepOutRel(base, keepOut); const check = opt.check || null; const force = opt.force || new Set(); const notes = []; const unpinned = new Set()
  const fixed = (opt.fixed || []).map(p => [p[0], p[1], p[0], p[1]]) // furniture that stands already (the first craft table, chests, beds): no pad and no road of a zone that is still to come goes over it
  const axis = (lo, hi) => { // lattice lines + slot bands of one axis: the origin avenue (unless a keep-out covers it) + a road on either side of every keep-out
    // only a keep-out BIGGER THAN A SLOT re-cuts the lattice (a pond just blocks the slots it touches); lines are added in the order of settings.keepOut and
    // never within a road's width of an older one, so the next keep-out does not shift what the last plan laid out
    const big = K.filter(k => k.rect[2] - k.rect[0] + 1 > CELL || k.rect[3] - k.rect[1] + 1 > CELL); const forced = []; const add = c => { if (!forced.some(f => Math.abs(f - c) < 3)) forced.push(c) }
    if (!big.some(k => k.rect[lo] - 3 <= 0 && 0 <= k.rect[hi] + 3 && k.rect[1 - lo] <= 96 && k.rect[3 - lo] >= -96)) add(0) // a keep-out far down the avenue does not move the plaza
    for (const k of big) { add(k.rect[lo] - 2); add(k.rect[hi] + 2) }
    const F = forced.sort((a, b) => a - b); const bands = []; const roads = F.slice()
    const fill = (a, b, fromLo) => { for (let first = true; b - a + 1 >= SHORT; first = false) { const w = Math.min(CELL, b - a + 1); if (!first) roads.push(fromLo ? a - 2 : b + 2); if (fromLo) { bands.push([a, a + w - 1]); a += w + 3 } else { bands.push([b - w + 1, b]); b -= w + 3 } } }
    fill(F[0] - 1 - REACH, F[0] - 2, false); for (let i = 0; i + 1 < F.length; i++) fill(F[i] + 2, F[i + 1] - 2, Math.abs(F[i]) <= Math.abs(F[i + 1])); fill(F[F.length - 1] + 2, F[F.length - 1] + 1 + REACH, true)
    return { bands: bands.sort((p, q) => p[0] - q[0]), roads: roads.sort((p, q) => p - q), avenue: F.slice().sort((p, q) => Math.abs(p) - Math.abs(q) || p - q)[0] }
  }
  const X = axis(0, 2); const Z = axis(1, 3); const plaza = [X.avenue, Z.avenue]; const zones = baseZones(N); const used = new Map(); const stacks = [] // used: slot 'i,j' -> true | the GROUP a pinned zone holds it for (its mates may still move in beside it)
  const inK = r => K.find(k => overlap(k.rect, r)); const verdict = (z, r) => check && !force.has(z.id) ? check(padOf(r)) : null
  const spans = (B, need) => { const out = []; for (let i = 0; i < B.length; i++) { let j = i; while (B[j][1] - B[i][0] + 1 < need && j + 1 < B.length && B[j + 1][0] - B[j][1] === 4) j++; if (B[j][1] - B[i][0] + 1 >= need) out.push([i, j]) } return out } // neighbouring slots (one road between) count as one
  for (const z of zones) { // PINS: what is being built stays, the rest plans around it. Its slots are reserved now, the zone itself takes its turn in the order below - a re-run that pins what the last run placed lays out the rest exactly as before
    const pin = (opt.pins || {})[z.id]; if (!pin) continue // {rect, args}: where the board's jobs stand, and the args they were built with (a pen's gate, the mine's facing)
    // work in progress moves only for a REASON ON THE GROUND: the survey calls its place BAD (no survey: it lies inside the keep-out box itself), or the
    // operator says so (--move-zone). A keep-out box is a rough rectangle - 09-19 the foreman had LOOKED and moved field 1 just off the rim, 3 inside the box
    const p = pin.rect; const k = inK(p); const v = verdict(z, p); const raw = k && overlap(grow(k.rect, -KEEP), p)
    const why = (opt.move || new Set()).has(z.id) ? '--move-zone' : v && v.bad ? 'its place is ' + v.text : !v && raw ? 'it lies in keep-out ' + k.id + ' and no survey says the ground is good' : null
    if (why) { unpinned.add(z.id); notes.push('zone ' + z.id + ' MOVES although its jobs made progress (' + pin.done + ' cells): ' + why); continue }
    z.pin = p; z.pinned = true; z.hugW = (pin.args || {}).gate !== 'e'; z.facing = (pin.args || {}).facing; notes.push('zone ' + z.id + ' is PINNED at x ' + (base.x + p[0]) + '..' + (base.x + p[2]) + ' / z ' + (base.z + p[1]) + '..' + (base.z + p[3]) + ': its jobs made progress (' + pin.done + ' cells)' + (v ? ', survey ' + v.text : '') + (k ? ' - it REACHES INTO keep-out ' + k.id + (raw ? '' : '\'s margin') + ': look at that edge (--move-zone ' + z.id + ' re-plans it)' : ''))
    X.bands.forEach((bx, i) => Z.bands.forEach((bz, j) => {
      const B = [bx[0], bz[0], bx[1], bz[1]]; if (!overlap(B, grow(p, 1))) return; used.set(i + ',' + j, z.group || true)
      if (z.group && p[0] >= B[0] && p[2] <= B[2] && (p[1] === B[1] || p[3] === B[3])) z.stack = { group: z.group, B, hugW: p[0] === B[0], hugN: p[1] === B[1], used: p[1] === B[1] ? p[3] - B[1] + 1 : B[3] - p[1] + 1 } // its group mate still finds the room behind it
    }))
  }
  const place = (z, look) => {
    let best = null; const lex = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 } // distance (+ earthwork), then the traditional quarter, then west/north first
    const offer = (r, B, hugW, hugN, cells) => {
      if (inK(r) || zones.some(q => (q.rect || q.pin) && overlap(q.rect || q.pin, r)) || fixed.some(f => overlap(padOf(r), f))) return
      const v = look ? verdict(z, r) : null; if (v && v.bad) return
      const c = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]; const miss = z.pref ? (Math.sign(c[0] - plaza[0]) !== z.pref[0]) + (Math.sign(c[1] - plaza[1]) !== z.pref[1]) : 0
      const bb0 = zones.filter(q => q.rect).map(q => q.rect).reduce((a, q) => a ? union(a, q) : q, null); const bb1 = bb0 ? union(bb0, r) : r; const dim = (b, i) => Math.max(4 * 35, b[i + 2] - b[i] + 1); const sprawl = bb0 ? dim(bb1, 0) + dim(bb1, 1) - dim(bb0, 0) - dim(bb0, 1) : 0 // beyond 4x4 slots every block the outline grows is wall to build and ground to light
      const o = { r, B, hugW, hugN, cells, key: [Math.round(Math.hypot(c[0] - plaza[0], c[1] - plaza[1]) + (v ? 8 * v.rough : 0) + sprawl), miss, r[0], r[1]] }; if (!best || lex(o.key, best.key) < 0) best = o
    }
    for (const s of stacks) if (s.group === z.group && s.used + 2 + z.d <= s.B[3] - s.B[1] + 1 && z.w <= s.B[2] - s.B[0] + 1) { // a group mate's slot has room behind it
      const x1 = s.hugW ? s.B[0] : s.B[2] - z.w + 1; const z1 = s.hugN ? s.B[1] + s.used + 2 : s.B[3] - s.used - 2 - z.d + 1; offer([x1, z1, x1 + z.w - 1, z1 + z.d - 1], s.B, s.hugW, s.hugN, null); if (best) { best.stack = s; break }
    }
    if (!best) for (const [i1, i2] of spans(X.bands, z.w)) for (const [j1, j2] of spans(Z.bands, Math.max(z.d, z.room || 0))) {
      const cells = []; for (let i = i1; i <= i2; i++) for (let j = j1; j <= j2; j++) cells.push(i + ',' + j); if (cells.some(c => used.has(c) && !(z.group && used.get(c) === z.group))) continue
      const B = [X.bands[i1][0], Z.bands[j1][0], X.bands[i2][1], Z.bands[j2][1]]; const hugW = (B[0] + B[2]) / 2 >= plaza[0]; const hugN = (B[1] + B[3]) / 2 >= plaza[1] // the zone sits in the corner of its slot that faces the plaza
      const x1 = hugW ? B[0] : B[2] - z.w + 1; const z1 = hugN ? B[1] : B[3] - z.d + 1; offer([x1, z1, x1 + z.w - 1, z1 + z.d - 1], B, hugW, hugN, cells)
    }
    if (!best) return false
    z.rect = best.r; z.hugW = best.hugW; if (best.stack) best.stack.used += 2 + z.d; else { best.cells.forEach(c => used.set(c, true)); if (z.group) stacks.push({ group: z.group, B: best.B, hugW: best.hugW, hugN: best.hugN, used: z.d }) }
    return true
  }
  for (const z of zones) if (z.pin) { z.rect = z.pin; if (z.stack) stacks.push(z.stack) } else if (!place(z, true) && !place(z, false)) notes.push('zone ' + z.id + ': NO free slot within ' + REACH + ' of the lattice lines')
  const placed = zones.filter(z => z.rect)
  for (const z of placed) if (z.id === 'mine' && !z.facing) { // the miners' stairs descend ~60 blocks along `facing`: never towards a keep-out (a ravine would open the stairwell)
    const cx = Math.floor((z.rect[0] + z.rect[2]) / 2); const cz = Math.floor((z.rect[1] + z.rect[3]) / 2)
    const way = { south: [cx - 2, cz, cx + 2, cz + 64], north: [cx - 2, cz - 64, cx + 2, cz], east: [cx, cz - 2, cx + 64, cz + 2], west: [cx - 64, cz - 2, cx, cz + 2] }
    z.facing = Object.keys(way).find(f => !K.some(k => overlap(grow(k.rect, 5), way[f]))) || 'south'
  }
  let bb = placed.map(z => z.rect).reduce((a, r) => a ? union(a, r) : r, null) || [-16, -16, 16, 16]
  const cutBy = (W, r) => overlap(W, r) && (r[0] <= W[0] || r[1] <= W[1] || r[2] >= W[2] || r[3] >= W[3]) // the wall LINE of W meets r
  for (let again = true; again;) { again = false; for (const k of K) { const ring = grow(k.rect, 3); if ((overlap(bb, k.rect) || cutBy(grow(bb, 4), grow(k.rect, -KEEP))) && (ring[0] < bb[0] || ring[1] < bb[1] || ring[2] > bb[2] || ring[3] > bb[3])) { bb = union(bb, ring); again = true } } } // a keep-out BETWEEN zones is taken in, ring road and all (the wall never crosses a ravine); one beside the base (a river) stays outside, the wall runs along its margin
  const obstacles = K.map(k => k.rect).concat(placed.map(z => z.rect)); const roads = []; const inZone = f => placed.some(z => overlap(z.rect, f))
  const line = (c, alongZ, avenue) => { // one lattice line across the base, cut where a keep-out or a zone (the tree farm spans slots) lies on it; a piece stays when it serves something
    const a0 = alongZ ? bb[1] : bb[0]; const b0 = alongZ ? bb[3] : bb[2]; const lat = r => alongZ ? [r[0], r[2]] : [r[1], r[3]]; const lon = r => alongZ ? [r[1], r[3]] : [r[0], r[2]]
    const cuts = obstacles.concat(fixed.filter(f => !inZone(f)).map(f => grow(f, 1))).filter(r => lat(r)[0] <= c + 1 && lat(r)[1] >= c - 1).map(lon).sort((p, q) => p[0] - q[0]); const pieces = []; let a = a0
    for (const [p, q] of cuts) { if (p - 1 >= a) pieces.push([a, p - 1]); a = Math.max(a, q + 1) } if (b0 >= a) pieces.push([a, b0])
    for (const [p, q] of pieces) { // an avenue runs through; a side road is as long as what it serves, on to the next crossing on either end (one network, no paving for nobody)
      let a = p; let b = q; const sv = obstacles.filter(r => lat(r)[0] <= c + 4 && lat(r)[1] >= c - 4 && lon(r)[0] <= q && lon(r)[1] >= p).map(lon)
      if (!avenue) { if (!sv.length) continue; const lo = Math.max(p, Math.min(...sv.map(i => i[0])) - 2); const hi = Math.min(q, Math.max(...sv.map(i => i[1])) + 2); const cross = alongZ ? Z.roads : X.roads; const c1 = cross.filter(v => v <= lo && v - 1 >= p).pop(); const c2 = cross.find(v => v >= hi && v + 1 <= q); a = c1 != null ? c1 - 1 : lo; b = c2 != null ? c2 + 1 : hi }
      if (b - a + 1 >= 8) roads.push({ c: alongZ ? [c, a, c, b] : [a, c, b, c], avenue })
    }
  }
  for (const c of X.roads) if (c - 1 >= bb[0] && c + 1 <= bb[2]) line(c, true, c === X.avenue)
  for (const c of Z.roads) if (c - 1 >= bb[1] && c + 1 <= bb[3]) line(c, false, c === Z.avenue)
  const mid = r => Math.hypot((r.c[0] + r.c[2]) / 2 - plaza[0], (r.c[1] + r.c[3]) / 2 - plaza[1]); roads.sort((p, q) => (q.avenue - p.avenue) || mid(p) - mid(q) || p.c[0] - q.c[0] || p.c[1] - q.c[1])
  const wall = grow(bb, 4); if ((wall[2] - wall[0]) % 2) wall[2]++; if ((wall[3] - wall[1]) % 2) wall[3]++ // wall_ring is centred: odd sizes; every zone + 4 blocks of air inside the wall line
  return { zones, roads, wall, K, plaza, notes, unpinned }
}
function layoutMap (base, L) { // the layout at a glance, 1 char = 8 blocks, north up: zone letters, # keep-out, = road, : wall line
  const W = L.wall; const letter = z => /^field_/.test(z.id) ? (z.id.split('_')[1].slice(-1)) : /^pen_/.test(z.id) ? 'P' : z.id[0].toUpperCase(); const out = []
  const ring = r => overlap(r, W) && (r[0] <= W[0] || r[2] >= W[2] || r[1] <= W[1] || r[3] >= W[3])
  for (let z = W[1]; z <= W[3]; z += 8) {
    let l = ''
    for (let x = W[0]; x <= W[2]; x += 8) { const t = [x, z, Math.min(x + 7, W[2]), Math.min(z + 7, W[3])]; const zn = L.zones.find(q => q.rect && overlap(q.rect, t)); l += L.K.some(k => overlap(grow(k.rect, -KEEP), t)) ? '#' : zn ? letter(zn) : L.roads.some(r => overlap(roadRect(r.c), t)) ? '=' : ring(t) ? ':' : '.' }
    out.push(String(base.z + z).padStart(6) + ' ' + l)
  }
  return '       x ' + (base.x + W[0]) + ' .. ' + (base.x + W[2]) + '   (1 char = 8 blocks, north up; 1-9 field blocks, C core, Y yard, D dorm, T tree farm, M mine head, P pens, # keep-out, = road, : wall line)\n' + out.join('\n')
}
// THE SURVEY (ops/skyshot.js writes <out>.json: {n, step, x0, z0, cols:[[topBlock, y]|null …]}; column i = gz*n+gx): what the ground under a rect looks like
// from the air. Ground = the top block (a plant stands ON it); a crown hides its ground and is only counted. BAD = a fall (>= 6 below: capping it would deck a hole), or more than 5 % of
// the columns (and more than 2) >= 4 off the base level or wet - `level` cuts 4 of headroom and caps holes, it does not fill a ravine. Lines (roads, wall): a fall or water.
function loadSurvey (file) { const M = rj(file); if (!M || !Array.isArray(M.cols) || !(M.n > 0) || !(M.step > 0)) throw new Error('not a skyshot survey (n, step, x0, z0, cols)'); M.file = file; M.age = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000); return M }
function surveyRect (M, R, y, kind) { // R absolute; kind 'line' (road) | 'ring' (wall) | zone
  const d = mc(); const g1 = (v, o) => Math.ceil((v - o) / M.step); const g2 = (v, o) => Math.floor((v - o) / M.step)
  let [ax, az, bx, bz] = [g1(R[0], M.x0), g1(R[1], M.z0), g2(R[2], M.x0), g2(R[3], M.z0)]; if (ax > bx) ax = bx = Math.round(((R[0] + R[2]) / 2 - M.x0) / M.step); if (az > bz) az = bz = Math.round(((R[1] + R[3]) / 2 - M.z0) / M.step) // a road is thinner than the survey step: the nearest line of columns
  const s = { n: 0, low: 0, high: 0, water: 0, trees: 0, unseen: 0, deep: 0, min: y, max: y, sum: 0, box: null }
  for (let gz = az; gz <= bz; gz++) for (let gx = ax; gx <= bx; gx++) {
    if (kind === 'ring' && gx !== ax && gx !== bx && gz !== az && gz !== bz) continue
    const c = gx < 0 || gz < 0 || gx >= M.n || gz >= M.n ? null : M.cols[gz * M.n + gx]; if (!c) { s.unseen++; continue }
    if (/_leaves$|_log$|_stem$|bamboo|vine/.test(c[0])) { s.trees++; continue }
    const wet = /water|kelp|seagrass|bubble_column|lava|ice$/.test(c[0]); const blk = d.blocksByName[c[0]]; const g = blk && blk.boundingBox === 'empty' && !wet ? c[1] - 1 : c[1]; const off = g - y; s.n++
    if (wet) s.water++; else { s.sum += Math.abs(off); if (off <= -4) { s.low++; if (off <= -6) s.deep++ } else if (off >= 4) s.high++; s.min = Math.min(s.min, g); s.max = Math.max(s.max, g) }
    if (wet || Math.abs(off) >= 4) { const x = M.x0 + gx * M.step; const z = M.z0 + gz * M.step; s.box = s.box ? union(s.box, [x, z, x, z]) : [x, z, x, z] }
  }
  const off = s.low + s.high + s.water; s.rough = s.n ? s.sum / s.n : 0
  s.bad = kind ? s.deep + s.water > 0 : s.deep > 0 || off > Math.max(2, 0.05 * s.n)
  const parts = []; if (s.low) parts.push(s.low + ' columns >=4 below y' + y + ' (down to y' + s.min + ')'); if (s.high) parts.push(s.high + ' columns >=4 above (up to y' + s.max + ')'); if (s.water) parts.push(s.water + ' WATER columns')
  const where = s.box ? ' at x ' + s.box[0] + '..' + s.box[2] + ' / z ' + s.box[1] + '..' + s.box[3] : ''; const seen = s.n + ' columns, mean +-' + s.rough.toFixed(1) + (s.trees ? ', ' + s.trees + ' under trees' : '') + (s.unseen ? ', ' + s.unseen + ' UNSEEN (outside the survey)' : '')
  s.text = s.bad ? 'BAD: ' + parts.join(', ') + where + ' (of ' + seen + ')' : 'ok (' + seen + (parts.length ? '; ' + parts.join(', ') + where : '') + ')'
  return s
}
const musterIn = (base, N, yard) => ({ x: base.x + yard[0] + 2, y: base.y + 1, z: base.z + yard[1] + 1, cols: Math.min(13, Math.ceil(N / 6)), step: 2 }) // 6 rows x N/6 columns, pitch 2, inside the 29x13 yard (<= 78 bots)
const ROADS_AFTER = 'mine'; const FIRST_ACTIVE = ['base_field_1_pad', 'base_core_pad']
// a road keeps the NUMBER the board knows it by (matched by its line): a re-plan that adds or cuts a piece must not hand a half-paved road's id to another line.
// known = {'x1,z1,x2,z2' (absolute centre line): n} from the board's road jobs, reserved = numbers not to hand out again (a road with progress that left the plan)
function numberRoads (base, L, known = {}, reserved = []) { const key = rd => [base.x + rd.c[0], base.z + rd.c[1], base.x + rd.c[2], base.z + rd.c[3]].join(','); const taken = new Set(reserved.concat(L.roads.map(rd => known[key(rd)]).filter(Boolean))); let n = 1; for (const rd of L.roads) { rd.n = known[key(rd)]; if (!rd.n) { while (taken.has(n)) n++; rd.n = n; taken.add(n) } } }
function basePlan (base, N, L, skip = new Set(), opt = {}) { // opt: check (the survey, for infill tiles), waterFrom [x,y,z] (where water-cell blueprints fill their bucket)
  // L = baseLayout(); skip = zone ids / 'road <n>' / 'wall' that get NO jobs (BAD in the survey): the `after` chains close over them
  const BASE_ZONES = L.zones.filter(z => z.rect)
  const abs = r => [base.x + r[0], base.z + r[1], base.x + r[2], base.z + r[3]]; const size = r => [r[2] - r[0] + 1, r[3] - r[1] + 1]
  const jobs = []; const lines = []; const problems = L.notes.filter(n => /NO free slot/.test(n)).map(text => ({ text })); let seq = 0
  // TWO build orders run side by side (the dispatcher activates `after` successors by itself): FOOD = field blocks, then pens; BASE = core, yard, tree
  // farm, mine head, roads, torch grid, dorm, wall. Inside each the order is PLAN §8; one linear chain would leave most of the army in the sponge.
  const last = { food: null, base: null }; let chain = 'base'
  const anchorOf = bp => { const f = blueprintFile(bp); if (!f) return 'nw'; const m = /origin\s*=\s*(?:the\s+)?(nw|north-west|centre|center)/i.exec(fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('//')).join(' ')); return m && /^c/i.test(m[1]) ? 'centre' : 'nw' } // the blueprint's own header says where its origin is
  const mk = (id, zone, r, blueprint, args, bots, what, originAt, slot) => { // one `build` job; r = the rect (relative) it is laid out in, slot = what it may touch (default r)
    const R = abs(r); const [w, d] = size(r); const centre = [Math.floor((R[0] + R[2]) / 2), base.y, Math.floor((R[1] + R[3]) / 2)]
    const origin = originAt || (anchorOf(blueprint) === 'centre' ? centre : [R[0], base.y, R[1]])
    const job = { id, type: 'build', priority: Math.max(40, 90 - seq), front: 'base', status: FIRST_ACTIVE.includes(id) ? 'active' : 'paused', when: 'any', bots, site: [centre[0], base.y + 1, centre[2]], requires: { minHp: 10 }, plan: 'BASE PLAN zone ' + zone + ' x ' + R[0] + '..' + R[2] + ' / z ' + R[1] + '..' + R[3] + ' on the base level y' + base.y + ' (armyctl plan-base, docs/PLAN-world2.md §2): ' + what, params: { blueprint, origin, args } }
    if (last[chain]) job.after = last[chain]; last[chain] = id; seq++; jobs.push(job)
    if (Array.isArray(opt.waterFrom) && /^(field_block|cane_block)$/.test(blueprint)) job.params.waterFrom = opt.waterFrom.slice() // the bucket is filled at the lake/river, never at a cell of ours
    let mats = '(blueprint pending)'; const pending = !blueprintFile(blueprint)
    if (!pending) {
      try {
        const m = {}; let x1 = 1e9; let z1 = 1e9; let x2 = -1e9; let z2 = -1e9
        for (const c of blueprintCells(job.params)) { if (c.block === 'air') continue; const k = c.block + (c.fillOnly ? '<=' : ' '); m[k] = (m[k] || 0) + 1; x1 = Math.min(x1, c.x); x2 = Math.max(x2, c.x); z1 = Math.min(z1, c.z); z2 = Math.max(z2, c.z) }
        mats = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k.trim() + n).join(' ') || 'nothing to place' // "dirt<=841" = at most (only where there is a hole); water = buckets poured
        const lim = blueprint === 'road' ? [R[0] - 1, R[1] - 1, R[2] + 1, R[3] + 1] : abs(slot || r) // the road blueprint rounds its ends
        if (x1 < lim[0] || z1 < lim[1] || x2 > lim[2] || z2 > lim[3]) problems.push({ job: id, text: id + ': blueprint ' + blueprint + ' builds x ' + x1 + '..' + x2 + ' / z ' + z1 + '..' + z2 + ' - OUTSIDE its slot x ' + lim[0] + '..' + lim[2] + ' / z ' + lim[1] + '..' + lim[3] + ' (origin/size args do not fit this blueprint)' })
      } catch (e) { mats = 'blueprint error: ' + String(e.message).slice(0, 60); problems.push({ job: id, text: id + ': ' + mats }) }
    }
    lines.push({ seq, id, zone, blueprint, origin, size: w + 'x' + d, mats, pending, status: job.status, after: job.after })
    return job
  }
  if (L.roads.some(rd => !rd.n)) numberRoads(base, L)
  const roads = () => L.roads.forEach(rd => { const c = rd.c; const R = abs(c); if (!skip.has('road ' + rd.n)) mk('base_road_' + rd.n, 'road ' + rd.n, roadRect(c), 'road', { toX: R[2], toZ: R[3], width: 3 }, 6, '3-wide ' + (rd.avenue ? 'AVENUE ' : 'road ') + (c[1] === c[3] ? 'east-west' : 'north-south') + ', paved at ground level', [R[0], base.y, R[1]]) })
  const fields = BASE_ZONES.filter(z => z.prod === 'farm').map(z => abs(z.rect)); const roadRects = L.roads.map(rd => abs(roadRect(rd.c)))
  for (const z of BASE_ZONES) {
    if (!skip.has(z.id)) {
      chain = /^(field|pen)_/.test(z.id) ? 'food' : 'base'
      const R = abs(z.rect); const p = padOf(z.rect); const [pw, pd] = size(p); const builds = z.builds(z.rect, z)
      mk('base_' + z.id + '_pad', z.id, p, 'level', { w: pw, d: pd }, Math.ceil(N / 4), 'LEVEL the pad first (one site = one height): cut above, fill holes, 4 headroom. ' + z.what)
      let built = z.rect; for (const [bp, sub, name, args] of builds) { built = sub || z.rect; const [w, d] = size(built); mk('base_' + (name || z.id), z.id, built, bp, args || { w, d }, Math.ceil(N / 5), z.what, null, builds.length === 1 ? z.rect : built) }
      const B = abs(built)
      const pj = { priority: 80, front: z.prod, status: 'paused', when: 'any', site: [Math.floor((R[0] + R[2]) / 2), base.y + 1, Math.floor((R[1] + R[3]) / 2)], after: last[chain] }
      if (z.prod === 'farm') jobs.push(Object.assign({ id: 'farm_' + z.id.split('_')[1], type: 'farm' }, pj, { produces: ['food', 'wheat_seeds'], minBots: 1, maxBots: 6, plan: 'BASE PLAN zone ' + z.id + ': farmers till, plant, harvest, replant and clear junk - they never touch water (the field blueprint built it)', params: { box: B, y: base.y, seed: 'wheat_seeds', forage: true, bankAt: 64 } }))
      if (z.prod === 'lumber') jobs.push(Object.assign({ id: 'lumber_base', type: 'lumber' }, pj, { produces: ['log'], minBots: 2, maxBots: Math.ceil(N / 4), requires: { minHp: 8 }, plan: 'BASE PLAN zone tree: fell whole trees inside the tree farm, replant on the 3-grid with the saplings of what grew there (no species named), bank logs', params: { box: R, pitch: 3, bankAt: 48 } }))
      if (z.prod === 'cane') jobs.push(Object.assign({ id: 'cane_farm', type: 'cane' }, pj, { priority: 84, produces: ['sugar_cane'], minBots: 1, maxBots: 2, requires: { minHp: 12, minFood: 8 }, plan: 'BASE PLAN zone cane: sugar cane on the cane block inside the base (the blueprint built soil and water; the job only plants from the depot stock, cuts the tops and banks) - paper, books, bookshelves', params: { box: [B[0] + 1, B[1] + 1, B[2] - 1, B[3] - 1], y: base.y, bankAt: 48 } }))
      if (z.prod === 'mine') jobs.push(Object.assign({ id: 'mine_iron', type: 'delegate' }, pj, { priority: 86, shiftMin: 60, produces: ['iron', 'fuel', 'cobblestone'], minBots: 2, maxBots: Math.ceil(N / 3), requires: { minHp: 14, minFood: 14 }, plan: 'BASE PLAN zone mine: ONE squad on the iron/coal level y16 under the mine head (PLAN §5); the diamond level comes with `mine level -54` when iron picks exist', params: { skill: 'iron_miner', args: { entrance: { x: pj.site[0], y: base.y + 1, z: pj.site[2], facing: z.facing || 'south' }, level: 16 } } }))
    }
    if (z.id === ROADS_AFTER) {
      chain = 'base'; roads()
      const W = abs(grow(L.wall, -1))
      jobs.push({ id: 'base_light', type: 'light', priority: Math.max(40, 90 - seq), front: 'base', status: 'paused', when: 'any', bots: 6, site: [base.x + L.plaza[0], base.y + 1, base.z + L.plaza[1]], after: last.base, plan: 'BASE PLAN torch grid pitch 8 over everything inside the wall line x ' + W[0] + '..' + W[2] + ' / z ' + W[1] + '..' + W[3] + '; never on farm soil, on a road or in a keep-out', params: { box: W, y: base.y, step: 8, avoid: fields.concat(roadRects, L.K.map(k => abs(k.rect))) } })
      lines.push({ seq: ++seq, id: 'base_light', zone: 'torch grid', blueprint: '(job type light)', origin: [base.x + L.plaza[0], base.y, base.z + L.plaza[1]], size: size(W).join('x'), mats: 'torch ~' + Math.ceil(size(W)[0] / 8) * Math.ceil(size(W)[1] / 8), status: 'paused' }); last.base = 'base_light'
    }
  }
  // INFILL (owner 09-20 05:00Z "the base is bumpy"): only the zones had pads - between them lay natural +-2 ground, half-filled moats, escape staircases, crater
  // patches. Doctrine: the whole base is ONE level. Everything inside the wall line that is no zone pad, no road and no keep-out (+3: the fill stops 3 blocks before
  // the rim - `level` fills from the natural ground up and leaves a drop of 7+ open, it never decks the ravine) is cut into `level` tiles <= 31x31 (odd sizes: the
  // blueprint is centred). Six chains run side by side, nearest the plaza first; a tile the survey calls BAD (a fall, water) is left out and named.
  const infill = { n: 0, bad: [], tiny: 0 }
  {
    const I = grow(L.wall, -1); const w0 = I[2] - I[0] + 1; const d0 = I[3] - I[1] + 1; const G = new Uint8Array(w0 * d0)
    const block = r => { for (let x = Math.max(r[0], I[0]); x <= Math.min(r[2], I[2]); x++) for (let z = Math.max(r[1], I[1]); z <= Math.min(r[3], I[3]); z++) G[(z - I[1]) * w0 + (x - I[0])] = 1 }
    for (const z of L.zones.filter(q => q.rect)) block(padOf(z.rect)); for (const rd of L.roads) block(roadRect(rd.c)); for (const k of L.K) block(k.rect)
    const free = (x, z) => x < w0 && z < d0 && !G[z * w0 + x]; const tiles = []
    for (let z = 0; z < d0; z++) for (let x = 0; x < w0; x++) {
      if (!free(x, z)) continue
      let w = 0; while (w < 31 && free(x + w, z)) w++; if (w % 2 === 0) w--
      let d = 1; while (d < 31 && (() => { for (let i = 0; i < w; i++) if (!free(x + i, z + d)) return false; return true })()) d++; if (d % 2 === 0) d--
      for (let i = 0; i < w; i++) for (let k = 0; k < d; k++) G[(z + k) * w0 + x + i] = 1
      if (w * d < 6) { infill.tiny++; continue }
      tiles.push([I[0] + x, I[1] + z, I[0] + x + w - 1, I[1] + z + d - 1])
    }
    const dist = r => Math.hypot((r[0] + r[2]) / 2 - L.plaza[0], (r[1] + r[3]) / 2 - L.plaza[1]); tiles.sort((p, q) => dist(p) - dist(q) || p[0] - q[0] || p[1] - q[1])
    const tag = v => (v < 0 ? 'n' : 'p') + Math.abs(v); let i = 0
    for (const r of tiles) {
      const R = abs(r); const id = 'base_infill_' + tag(R[0]) + '_' + tag(R[1]); const v = opt.check ? opt.check(r, 'line') : null // judged like a line: only a FALL (>= 6) or WATER is bad - a hill is cut (clear = its height), a dent <= 5 is filled from its floor
      if (v && v.bad) { infill.bad.push(id + ' x ' + R[0] + '..' + R[2] + ' / z ' + R[1] + '..' + R[3] + ': ' + v.text); continue }
      chain = 'infill' + (i % 6); const head = !last[chain]; const [w, d] = size(r)
      const clear = v ? Math.max(4, Math.min(24, v.max - base.y + 2)) : 4
      const job = mk(id, 'infill', r, 'level', clear > 4 ? { w, d, clear } : { w, d }, 5, 'INFILL between the zones: the whole base is ONE level - cut what stands above y' + base.y + ', fill dents from the natural ground up, 4 headroom; nothing is built on it')
      job.priority = 62; if (head) job.status = 'active'; const ln = lines[lines.length - 1]; ln.status = job.status; i++; infill.n++
    }
  }
  const [ww, wd] = size(L.wall); chain = 'base'; if (!skip.has('wall')) mk('base_wall', 'wall', L.wall, 'wall_ring', { w: ww, d: wd, height: 3 }, Math.ceil(N / 2.5), 'perimeter wall LAST: 3 high, torches on top, a gate in the middle of each side')
  // the lattice cannot overlap by construction - this is the check that it did not (pins come from the board, not from the lattice; pads, torch grid and wall are overlays)
  BASE_ZONES.forEach((a, i) => { BASE_ZONES.slice(i + 1).forEach(b => { if (overlap(a.rect, b.rect)) problems.push({ text: 'zones ' + a.id + ' and ' + b.id + ' OVERLAP' }) }); L.roads.forEach(rd => { if (overlap(a.rect, roadRect(rd.c))) problems.push({ text: 'zone ' + a.id + ' lies on road ' + rd.n }) }); for (const k of L.K) if (!a.pinned && overlap(a.rect, k.rect)) problems.push({ text: 'zone ' + a.id + ' lies in keep-out ' + k.id + ' (+' + KEEP + ')' }) })
  L.roads.forEach(rd => { for (const k of L.K) if (overlap(roadRect(rd.c), k.rect)) problems.push({ text: 'road ' + rd.n + ' crosses keep-out ' + k.id }) })
  for (const z of BASE_ZONES) { const bl = z.builds(z.rect, z).filter(b => b[1]); for (const [, sub] of bl) if (sub[0] < z.rect[0] || sub[1] < z.rect[1] || sub[2] > z.rect[2] || sub[3] > z.rect[3]) problems.push({ text: 'a part of zone ' + z.id + ' lies outside it' }); bl.forEach((a, i) => bl.slice(i + 1).forEach(b => { if (overlap(a[1], b[1])) problems.push({ text: 'parts ' + a[0] + ' and ' + b[0] + ' of zone ' + z.id + ' OVERLAP' }) })) }
  return { jobs, lines, problems, infill }
}
// THE STARTING BOARD of a new world (PLAN §8 "survey"): nothing here needs a base, a chest or an old coordinate. Everything is measured from the
// world spawn = muster until `base set`. Producing jobs carry produces/minBots/maxBots (labour by demand), scouts are pinned so that each bot
// keeps ITS bearing (the scout handler takes the bearing from the bot's place in `names`), the rest of the army falls into the sponge.
function bootstrapBoard (old, spawn) {
  const [sx, sy, sz] = spawn; const roster = ((old.settings || {}).roster || []).slice(); const N = roster.length; const box = r => [sx - r, sz - r, sx + r, sz + r]
  const per = (n, step) => Math.ceil(n * N / 30 / step) * step // the numbers below are world 1's for 30 bots; everything scales with the roster
  const keep = k => (old.settings || {})[k]
  const settings = {
    roster, maxFronts: 10, dusk: keep('dusk') || 11800, dawn: keep('dawn') || 23300, muster: { x: sx, y: sy, z: sz, cols: Math.ceil(N / 6), step: 2 }, chests: {}, respawnBeds: [],
    nightSkip: false, // TRUE only when a bed + a `sleeper` job exist (CLAUDE.md §1b); until then nights are real and the night guard is the sponge
    fallback: 'tidy_spawn',
    targets: { food: per(256, 32), log: per(256, 32), planks: per(128, 32), cobblestone: per(1024, 64), fuel: per(128, 32), iron: per(128, 32), iron_ingot: per(128, 32), torch: per(128, 32), wheat_seeds: per(128, 32), string: per(24, 8) } // PLAN §3 x roster/30; steer with `armyctl.js targets`
  }
  if (keep('talk') === false) settings.talk = false
  const far = roster.slice(0, 8); const ring = roster.slice(8, 14) // 14 scouts whatever the roster (8 + 6 bearings); every other hand gathers food and wood: N/6 + N/5 + N/15 at full deficit, the rest tidies (later: levels the first pads)
  const jobs = [
    { id: 'scout_far', type: 'scout', priority: 97, front: 'scouting', status: 'active', when: 'any', names: far, shiftMin: 60, requires: { minHp: 14, minFood: 10 }, plan: 'SURVEY (PLAN §1), read-only walk: 8 bearings, 25 min out (~3000 blocks: climate zones are thousands of blocks wide), home on the breadcrumbs; every trip turns 25 degrees on. Samples -> scout.jsonl -> `armyctl.js sites`', params: { bearings: [0, 45, 90, 135, 180, 225, 270, 315], range: 3000, step: 64, budgetMin: 25 } },
    { id: 'scout_ring', type: 'scout', priority: 96, front: 'scouting', status: 'active', when: 'any', names: ring, shiftMin: 25, requires: { minHp: 14, minFood: 10 }, plan: 'SURVEY (PLAN §1), read-only walk: the land within 600 of spawn, DENSE (step 36) between the far bearings - a site needs several neighbouring flat samples, one line of samples is not an area', params: { bearings: [20, 80, 140, 200, 260, 320], range: 600, step: 36, budgetMin: 8 } },
    { id: 'hunt_spawn', type: 'hunt', priority: 92, front: 'herd', status: 'active', when: 'day', produces: ['food'], minBots: 2, maxBots: Math.ceil(N / 6), site: [sx, sy, sz], requires: { minHp: 12, minFood: 8 }, plan: 'gathering, no world change: first food. Hunters go where bots SAW herds (animals.jsonl) within 300 of muster, leave 2 of every kind alive for the pens', params: { kinds: ['cow', 'pig', 'sheep', 'chicken'], leave: 2, haul: 20, maxDist: 300 } },
    { id: 'forage_spawn', type: 'steps', priority: 91, front: 'forage', status: 'active', when: 'day', produces: ['wheat_seeds', 'food'], minBots: 1, maxBots: Math.ceil(N / 15), requires: { minHp: 10 }, plan: 'gathering, no world change: grass/ferns for the seeds of field block 1, small game on the way; banked once a depot exists', params: { repeat: true, onFail: 'continue', steps: [{ do: 'collect', block: ['short_grass', 'tall_grass', 'fern'], n: 24, radius: 32 }, { do: 'kill', kinds: ['chicken', 'rabbit'], n: 2, radius: 32 }, { do: 'pickup', radius: 8 }, { do: 'bank' }] } },
    { id: 'wood_spawn', type: 'lumber', priority: 90, front: 'lumber', status: 'active', when: 'any', produces: ['log'], minBots: 2, maxBots: Math.ceil(N / 5), site: [sx, sy, sz], requires: { minHp: 8 }, plan: 'WOOD around muster x ' + (sx - 64) + '..' + (sx + 64) + ' / z ' + (sz - 64) + '..' + (sz + 64) + ': whole trees, replanted with their own saplings on a 3-grid (no species named: PLAN §9); first axes and tables come out of these logs', params: { box: box(64), pitch: 3, bankAt: 48 } },
    { id: 'guard_night', type: 'guard', priority: 93, front: 'muster', status: 'active', when: 'night', bots: N, requires: { minHp: 8 }, plan: 'no world change: the NIGHT SPONGE until a bed stands - the army holds muster together, kills what comes within 24 and keeps string (wool -> the first bed), bones, arrows', params: { radius: 24, minHp: 8 } },
    { id: 'tidy_spawn', type: 'tidy', priority: 60, front: 'works', status: 'active', when: 'any', bots: N, site: [sx, sy, sz], plan: 'GROUNDSKEEPING around muster (the FALLBACK sponge, settings.fallback) x ' + (sx - 48) + '..' + (sx + 48) + ' / z ' + (sz - 48) + '..' + (sz + 48) + ': holes filled, stray blocks and creeper craters repaired - the commons of the first days. `plan-base --put` brings the real sponges (pads, builds)', params: { box: box(48), y: sy - 1 } }
  ]
  return { settings, enlisted: roster.slice(), jobs } // everybody on the roster works
}
// ---- reading the ledger (shared by `events` and `wait`)
const INFO_EVS = ['spawn_set', 'bed_replaced', 'forged', 'job_activated', 'stairs_done', 'stair_repaired'] // good news that needs no judgement: ONE line
function tailRows (from, maxBytes = 3e6) { // parsed reports from byte `from` (or the last maxBytes) to the end of results.jsonl
  const f = path.join(DIR, 'results.jsonl'); const size = fs.statSync(f).size; const start = Math.max(0, from == null ? size - maxBytes : Math.max(from, size - maxBytes))
  const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd)
  const rows = []; for (const l of buf.toString('utf8').split('\n')) { try { const r = JSON.parse(l); if (r && r.ev) rows.push(r) } catch {} }
  return rows
}
function infoSummary (rows) { // quiet good news, ONE line, or null
  const by = {}; for (const r of rows) if (INFO_EVS.includes(r.ev)) (by[r.ev] = by[r.ev] || []).push(r)
  const parts = []
  if (by.spawn_set) parts.push('respawn point set (spawn_set) by ' + new Set(by.spawn_set.map(r => r.bot)).size + ' bots at ' + [...new Set(by.spawn_set.map(r => String(r.at)))].slice(-2).join(' | '))
  if (by.bed_replaced) parts.push('bed_replaced x' + by.bed_replaced.length + ' at ' + String(by.bed_replaced[by.bed_replaced.length - 1].at))
  if (by.forged) { const m = {}; for (const r of by.forged) for (const [k, v] of Object.entries(r.made || {})) m[k] = (m[k] || 0) + v; parts.push('forged ' + Object.entries(m).map(([k, v]) => k + ':' + v).join(' ')) }
  if (by.job_activated) parts.push('build order: the dispatcher activated ' + [...new Set(by.job_activated.map(r => r.job + ' (after ' + r.after + ')'))].join(', '))
  if (by.stairs_done) { const r = by.stairs_done[by.stairs_done.length - 1]; parts.push('mine stairwell DONE down to level y ' + r.level + ' (' + r.steps + ' steps, ' + (r.defects || 0) + ' defects)') }
  if (by.stair_repaired) parts.push('mine stairs repaired: ' + by.stair_repaired.reduce((n, r) => n + (r.fixed || 0), 0) + ' cells, ' + (by.stair_repaired[by.stair_repaired.length - 1].left || 0) + ' left')
  return parts.length ? 'info: ' + parts.join(' · ') : null
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main () {
  const [cmd, arg] = process.argv.slice(2)
  const names = (arg || '').split(',').filter(Boolean)
  if (cmd === 'enlist') {
    const b = rj(BOARD); b.enlisted = [...new Set([...(b.enlisted || []), ...names])]; wj(BOARD, b)
    const a = rj(ASSIGN); for (const n of names) a[n] = { skill: 'army_worker', args: {} }; wj(ASSIGN, a)
    console.log('stop:', await post('/cmd', { bots: names, action: 'stop' }))
    await sleep(6000)
    console.log('start:', await post('/skill', { bots: names, skill: 'army_worker', args: {} }))
  } else if (cmd === 'start') {
    console.log('start:', await post('/skill', { bots: names, skill: 'army_worker', args: {} }))
  } else if (cmd === 'discharge') {
    const b = rj(BOARD); b.enlisted = (b.enlisted || []).filter(n => !names.includes(n)); wj(BOARD, b)
    console.log('stop:', await post('/cmd', { bots: names, action: 'stop' }))
  } else if (cmd === 'field') {
    const m = musterOf(settings())
    const hb = fs.readdirSync(path.join(DIR, 'hb')).map(f => { try { return rj(path.join(DIR, 'hb', f)) } catch { return null } }).filter(Boolean).sort((a, b) => a.bot < b.bot ? -1 : 1)
    const KEY = /pickaxe|sword|_axe|rod|torch|iron|coal|bread|cooked|salmon|cod|beef|mutton|porkchop|chicken|seed|string|wool|shield|bucket|apple|bed$/
    for (const h of hb) {
      const age = Math.round((Date.now() - h.t) / 1000)
      const inv = Object.entries(h.inv || {}).filter(([k]) => KEY.test(k)).map(([k, v]) => k.replace('stone_', 's_').replace('wooden_', 'w_').replace('iron_', 'i_') + ':' + v).join(' ')
      console.log(h.bot.padEnd(8), String(h.pos).padEnd(14), ('d' + Math.round(Math.hypot(h.pos[0] - m.x, h.pos[2] - m.z))).padEnd(5), ('hp' + h.hp).padEnd(5), ('f' + h.food).padEnd(4),
        String(h.job || '-').padEnd(14), String(h.task || '').slice(0, 34).padEnd(34), age > 60 ? 'STALE ' + age + 's' : '', inv)
    }
  } else if (cmd === 'rescue') {
    if (names.length !== 1) return console.log('usage: rescue <bot>')
    const code = 'for(const k of Object.keys(require.cache))if(k.includes("/skills/lib/army"))delete require.cache[k];const A=require("/root/workspace/bots/skills/lib/army.js");return {area:A.walkableArea(bot),inv:A.inv(bot),pos:bot.entity.position.floored(),hp:bot.health}'
    const r = JSON.parse(await post('/cmd', { bots: names, action: 'eval', args: { code } }, 4000) || '[]')[0]
    if (!r || !r.ok) return console.log('cannot probe', names[0], r && r.error)
    const { area, inv, pos } = r.result
    const valuable = Object.keys(inv).filter(k => /iron|diamond|gold|fishing_rod|bucket|shield|bow$|_wool|string|emerald|lapis/.test(k))
    console.log(names[0], 'pos', [pos.x, pos.y, pos.z].join(','), 'walkable area', area, 'valuables', valuable.join(',') || 'none')
    // OWNER'S RULE (09-19): no forced respawns. The ONLY permitted kill is the "hand of god" (server console) on a bot that is really HUNG:
    // boxed in (walkable area < 60), or it reported `hung`/`stranded` in the last 15 min and still stands within 3 blocks of that spot,
    // or its heartbeat is stale (> 3 min: the worker loop itself is stuck). Never to heal, never as fast travel. There is no --force.
    const hbF = path.join(DIR, 'hb', names[0] + '.json'); let stale = true; try { stale = Date.now() - rj(hbF).t > 180000 } catch {}
    let reported = false
    try { for (const l of fs.readFileSync(path.join(DIR, 'results.jsonl'), 'utf8').trim().split('\n').slice(-4000)) { const r = JSON.parse(l); if (r.bot === names[0] && (r.ev === 'hung' || r.ev === 'stranded') && Date.now() - r.t < 900000 && r.at && Math.hypot(r.at[0] - pos.x, r.at[2] - pos.z) <= 3) reported = true } } catch {}
    if (!(area < 60 || reported || stale)) return console.log('REFUSED: not hung (can walk: area ' + area + ', no hung/stranded report at this spot, heartbeat fresh). Forced respawns are forbidden - fix its job instead.')
    if (valuable.length) console.log('note: it will drop ' + valuable.join(',') + ' at ' + [pos.x, pos.y, pos.z].join(',') + ' (recorded in terrain_debt.jsonl for pickup)')
    require('child_process').execFileSync('node', [path.join(BOTS, 'rcon.js'), 'kill ' + names[0]])
    fs.appendFileSync(path.join(DIR, 'results.jsonl'), JSON.stringify({ t: Date.now(), bot: names[0], ev: 'rescue_kill', pos: [pos.x, pos.y, pos.z], area, lost: inv }) + '\n')
    fs.appendFileSync(path.join(DIR, 'terrain_debt.jsonl'), JSON.stringify({ t: Date.now(), bot: names[0], kind: 'trap', at: [pos.x, pos.y, pos.z], note: 'bot was boxed in here (rescued by kill) - fill/fix this spot' }) + '\n')
    console.log('killed; respawns at world spawn and walks to muster')
  } else if (cmd === 'look') {
    const r = +(process.argv[4] || 16); const mode = process.argv[5] || 'auto'
    const code = 'const f="/root/workspace/bots/skills/lib/look.js";delete require.cache[f];return require(f).look(bot,' + r + ',' + JSON.stringify(mode) + ')'
    const out = JSON.parse(await post('/cmd', { bots: names, action: 'eval', args: { code } }, 200000) || '[]')[0]
    if (!out || !out.ok) return console.log('cannot look through', arg, out && out.error)
    const L = out.result
    console.log(arg + ' at ' + L.pos + ' (' + L.biome + ', on ' + L.standing_on + ') mode=' + L.mode + ' — map x ' + L.top_left[0] + '..' + (L.top_left[0] + 2 * L.radius) + ' (left→right), z ' + L.top_left[1] + '..' + (L.top_left[1] + 2 * L.radius) + ' (top→bottom); heights relative to feet y=' + L.pos[1])
    L.rows.forEach((row, i) => console.log(String(L.top_left[1] + i).padStart(5) + ' ' + row))
    console.log(L.legend)
    if (Object.keys(L.things).length) console.log('things: ' + Object.entries(L.things).map(([k, v]) => k + ' ' + v.map(c => c.join(',')).join(' | ')).join('  ;  '))
    if (Object.keys(L.entities).length) console.log('entities: ' + Object.entries(L.entities).map(([k, v]) => k + (Array.isArray(v) ? ' ' + v.map(c => c.join(',')).join(' | ') : ' x' + v)).join('  ;  '))
  } else if (cmd === 'stock') {
    const { chest, carried, top } = armyStock(); const re = arg ? new RegExp(arg) : null
    const names = [...new Set([...Object.keys(chest), ...Object.keys(carried)])].filter(k => !re || re.test(k)).sort((a, b) => ((chest[b] || 0) + (carried[b] || 0)) - ((chest[a] || 0) + (carried[a] || 0)))
    console.log('item'.padEnd(24), 'depot'.padStart(6), 'carried'.padStart(8), '  top carrier')
    for (const k of names.slice(0, re ? 60 : 40)) console.log(k.padEnd(24), String(chest[k] || 0).padStart(6), String(carried[k] || 0).padStart(8), '  ' + (top[k] ? top[k][0] + ':' + top[k][1] : ''))
    if (!re && names.length > 40) console.log('… ' + (names.length - 40) + ' more (give a regex, e.g. stock "iron|coal")')
  } else if (cmd === 'recipe') {
    const n = +(process.argv[4] || 1); const r = ingredientsOf(arg, n)
    if (!r) return console.log(arg + ': no crafting recipe' + (mc().itemsByName[arg] ? ' (smelted / mined / dropped?)' : ' — unknown item name'))
    const { chest, carried } = armyStock()
    console.log(n + ' x ' + arg + ' = ' + r.runs + ' craft run(s), ' + r.per + ' per run. Needs a crafting table (depot table: ' + (tableOf(settings()) || ['settings.craftTable not set']).join(',') + ').')
    for (const [k, c] of Object.entries(r.need)) {
      const have = chest[k] || 0; const sub = ingredientsOf(k, c)
      console.log('  ' + (k + ' x' + c).padEnd(26) + 'depot ' + have + ', carried ' + (carried[k] || 0) + (have >= c ? '  OK' : '  MISSING ' + (c - have) + (sub ? '  <- craft from ' + Object.entries(sub.need).map(([a, b]) => a + ' x' + b).join(' + ') : '  <- not craftable: node armyctl.js howto ' + k)))
    }
    console.log('  note: planks/logs of any wood work where the recipe names one; stone tools accept cobblestone.')
  } else if (cmd === 'errors') { // errors [n=20] [all] : counters of LIVE processes only (a dead pid's file is history: its bugs may be fixed long ago)
    const d = path.join(DIR, 'swallowed'); const live = {}; const dead = {}; let nLive = 0; let nDead = 0; const withDead = process.argv.includes('all')
    const alive = pid => { try { return /node/.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')) } catch { return false } }
    try {
      for (const f of fs.readdirSync(d)) {
        let c; try { c = rj(path.join(d, f)) } catch { continue }
        const isLive = alive(parseInt(f)); if (isLive) nLive++; else nDead++
        const tot = isLive || withDead ? live : dead
        for (const [k, v] of Object.entries(c)) { const t = tot[k] = tot[k] || { n: 0, last: 0, first: Infinity, deadN: 0 }; t.n += v.n; t.last = Math.max(t.last, v.last || 0); t.first = Math.min(t.first, v.first || v.last || Date.now()); if (!isLive) t.deadN += v.n }
      }
    } catch {}
    const rows = Object.entries(live).sort((a, b) => b[1].n - a[1].n).slice(0, +arg || 20)
    if (!rows.length) console.log('no swallowed errors in the ' + nLive + ' live processes')
    else console.log(' count   per h      last   where | message      (' + (withDead ? 'ALL files: ' + nLive + ' live + ' + nDead + ' dead processes; "+dead" = share from dead ones' : nLive + ' LIVE processes; counters start at each process start') + ')')
    for (const [k, v] of rows) { const ago = Math.round((Date.now() - v.last) / 60000); const hrs = Math.max((Date.now() - v.first) / 3600000, 1 / 6); console.log(String(v.n).padStart(6), String(Math.round((v.n - v.deadN) / hrs)).padStart(7), (ago + 'm ago').padStart(9), ' ', k + (ago >= 30 ? '   [quiet 30+ min]' : '') + (v.deadN ? '   [+dead ' + v.deadN + ']' : '')) }
    if (!withDead && nDead) { const top = Object.entries(dead).filter(([k]) => !live[k]).sort((a, b) => b[1].n - a[1].n); console.log('ignored: ' + nDead + ' counter files of dead processes (' + Object.values(dead).reduce((a, v) => a + v.n, 0) + ' errors; `errors ' + (+arg || 20) + ' all` merges them). Signatures seen ONLY there (fixed, or not hit since the restart): ' + (top.slice(0, 3).map(([k, v]) => v.n + 'x ' + k.slice(0, 60)).join(' ; ') || 'none')) }
  } else if (cmd === 'blueprints') {
    const bd = path.join(BOTS, 'blueprints')
    if (arg && !fs.existsSync(path.join(bd, arg.replace(/[^a-z0-9_]/gi, '') + '.js'))) return console.log('no blueprint `' + arg + '` - known: ' + fs.readdirSync(bd).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).join('  '))
    if (arg) { const src = fs.readFileSync(path.join(bd, arg.replace(/[^a-z0-9_]/gi, '') + '.js'), 'utf8'); console.log(src.split('\n').filter(l => l.startsWith('//')).join('\n')); try { const cells = require(path.join(bd, arg + '.js'))({ x: 0, y: 64, z: 0 }, {}); const m = {}; for (const c of cells) m[c.block] = (m[c.block] || 0) + 1; console.log('default size -> ' + JSON.stringify(m)) } catch (e) { console.log('preview failed: ' + e.message) } return }
    console.log(fs.readdirSync(bd).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).join('  '))
    console.log('details + material count: blueprints <name>   |   job: template build -> put')
  } else if (cmd === 'deaths') {
    const mins = +(arg || 30); const roster = rj(BOARD).settings.roster || []
    const lines = fs.readFileSync(path.join(BOTS, '..', 'server', 'console.log'), 'utf8').split('\n').slice(-20000)
    const now = new Date(); const out = []; const tot = {}
    for (const l0 of lines) {
      const l = l0.replace(/\x1b\[[0-9;]*m/g, '').replace(/INFO\]: \[[^\]]{1,24}\] /, 'INFO]: ') // the `army` team prefix arrives coloured in console.log (09-19: deaths were invisible for 2 h)
      const m = /^\[(\d\d):(\d\d):(\d\d) INFO\]: (\w+) (was slain by|was shot by|was blown up by|was killed|fell from|drowned|suffocated|burned|went up in flames|tried to swim in lava|starved|hit the ground|was doomed to fall|was poked|froze|was fireballed|withered)(.*)$/.exec(l)
      if (!m || !roster.includes(m[4])) continue
      const t = new Date(now); t.setUTCHours(+m[1], +m[2], +m[3], 0); let age = (now - t) / 60000; if (age < 0) age += 1440
      if (age > mins) continue
      const cause = (m[5] + m[6]).replace(/ using .*/, '').trim(); tot[cause] = (tot[cause] || 0) + 1
      out.push(m[1] + ':' + m[2] + ':' + m[3] + ' ' + m[4].padEnd(8) + ' ' + cause)
    }
    console.log(out.slice(-25).join('\n')); console.log('totals ' + mins + ' min: ' + Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([k, n]) => n + 'x ' + k).join(' | '))
  } else if (cmd === 'mine') {
    // bots/iron_mine.json is the MINERS' cache (keyed by the entrance; format owned by skills/lib/iron_core.js) - read-only here, every field optional.
    // The LEVEL is an order on the board: params.args.level of the mine job. The miner works out what that means for the stairwell and REFUSES a level
    // that would move rows that are already dug (`mine_level_refused` - the job keeps its old level); nothing is decided twice.
    let st = {}; try { st = rj(path.join(BOTS, 'iron_mine.json')) || {} } catch {}
    const job = (rj(BOARD).jobs || []).find(j => j.type === 'delegate' && j.params && j.params.skill === 'iron_miner')
    const lvOf = j => j && j.params && j.params.args && Number.isFinite(j.params.args.level) ? j.params.args.level : null
    if (arg === 'level') { // mine level <y> [dry]
      const y = +process.argv[4]; const dry = process.argv[5] === 'dry'
      if (!Number.isInteger(y) || y < -59 || y > 60) return console.log('usage: mine level <y> [dry]   (-59..60; iron/coal ~16, diamonds -54; `dry` = only say what would happen)')
      if (!job) return console.log('REFUSED: no mine job on the board (type delegate, params.skill iron_miner; `plan-base --put` writes mine_iron)')
      if (lvOf(job) === y) return console.log('REFUSED: ' + job.id + ' already works level y ' + y)
      let verdict = ''
      try { // the same pure geometry the miner uses: a level the stairwell cannot serve fails here, not in 17 bots
        const I = require(path.join(BOTS, 'skills', 'lib', 'iron_core.js')); const E = I.normEntrance((job.params.args || {}).entrance || settings().mineHead || (st.entrance && [].concat(st.entrance, [st.facing])))
        if (!E) verdict = ' (no entrance known yet: params.args.entrance / settings.mineHead)'; else I.stairCells(E, Math.min(y, ...(st.levels || [])), { levels: (st.levels || []).filter(l => l !== y).concat([y]) })
      } catch (e) { return console.log('REFUSED: the stairwell cannot serve y ' + y + ': ' + String(e.message).slice(0, 160)) }
      const known = (st.levels || []).includes(y); const br = Object.keys(((st.lv || {})[y] || {}).branches || {}).length
      const say = job.id + ': level ' + (lvOf(job) == null ? '(default ' + (st.levelY == null ? 16 : st.levelY) + ')' : lvOf(job)) + ' -> ' + y + verdict + '. ' + (known ? 'y ' + y + ' is a level of this mine already (' + br + ' branches in its ledger): the squad goes back to it.' : 'NEW level: one miner takes the stair lease and digs the stairwell on (dug so far: row ' + (st.dug == null ? '-' : st.dug) + '), the others are handed back until `stairs_done`. If it would move rows that are already dug the miners refuse (`events 10 mine_level`) and keep the old level.') + (y < 0 ? ' Below y 0: iron pickaxes or better (`mine_not_ready` says what is missing).' : '')
      if (dry) return console.log('DRY RUN - ' + say)
      withBoardLock(b => { const j = b.jobs.find(x => x.id === job.id); j.params.args = Object.assign({}, j.params.args, { level: y }); j.rev = (j.rev || 0) + 1 })
      return console.log(say + ' (rev bumped: miners re-read it at their next slice)')
    }
    const lv = st.lv || {}; const cur = st.levelY == null ? null : st.levelY
    console.log('mine job ' + (job ? job.id + ' (' + job.status + ', level arg ' + (lvOf(job) == null ? 'unset' : lvOf(job)) + ')' : 'NONE on the board') + '  entrance ' + JSON.stringify(st.entrance || (job && (job.params.args || {}).entrance) || settings().mineHead || null) + (st.facing != null ? ' facing ' + st.facing : ''))
    if (!Object.keys(st).length) return console.log('no mine cache yet (bots/iron_mine.json is written by the first miner)')
    console.log('working level y ' + cur + '  levels ' + JSON.stringify(st.levels || []) + '  stair rows dug ' + (st.dug == null ? '-' : st.dug) + '  hub ' + JSON.stringify(st.hub || null) + '  steps ' + (st.steps || []).length + '  stair lease ' + ((st.stairLease && (st.stairLease.owner || st.stairLease.bot)) || '-') + '  defects ' + (st.defects || []).length)
    // EXHAUSTED and the COMMUTE come from iron_core (ONE definition, the miners' own growth guard): exhausted = every trunk mouth taken, every branch at
    // MAX_BRANCH, none open - such a level needs a NEW landing, not more bots (the miners open one themselves, `mine_level_opened`, at most one per hour).
    let IC = null; try { IC = require(path.join(BOTS, 'skills', 'lib', 'iron_core.js')) } catch {}
    if (st.grewT) console.log('last level the miners opened themselves: y ' + st.grewY + ' ' + Math.round((Date.now() - st.grewT) / 60000) + ' min ago (at most one per hour; `mine level <y>` overrules it)')
    for (const [y, L] of Object.entries(lv)) {
      const bs = Object.values((L && L.branches) || {}); const open = bs.filter(x => !x.done)
      const out = IC ? IC.commute(L) : null // mean blocks from the hub to the open branch ends: "6 open branches, 220 blocks out" is a 4-minute walk each way
      console.log('  level y ' + String(y).padEnd(4) + ' branches ' + bs.length + ' (open ' + open.length + ', claimed ' + open.filter(x => x.owner).length + '), length ' + ((L && L.branchLen) || '-') + ', ore blocks ' + bs.reduce((n, x) => n + (x.ore || 0), 0) + (out == null ? '' : ', ' + out + ' blocks out') + (IC && IC.exhausted(L) ? '  EXHAUSTED (' + IC.levelCap(L) + ' branches x ' + IC.MAX_BRANCH + ', none open)' : '') + (+y === cur ? '   <- working' : ''))
    }
  } else if (cmd === 'animals') {
    let rows = []; try { rows = fs.readFileSync(path.join(DIR, 'animals.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch {}
    const S = musterOf(settings()); const best = {}
    for (const r of rows) { const k = r.kind + '@' + Math.round(r.at[0] / 48) + ',' + Math.round(r.at[2] / 48); if (!best[k] || r.t > best[k].t) best[k] = r }
    const l = Object.values(best).sort((a, b) => b.t - a.t)
    if (!l.length) return console.log('no livestock seen yet (bots record herds of >=2 automatically; send a `scout` job out)')
    for (const r of l.slice(0, 15)) console.log(r.kind.padEnd(9), ('x' + r.n).padEnd(4), String(r.at).padEnd(16), ('d' + Math.round(Math.hypot(r.at[0] - S.x, r.at[2] - S.z))).padEnd(6), Math.round((Date.now() - r.t) / 60000) + ' min ago by ' + r.bot)
  } else if (cmd === 'howto') {
    const k = Object.keys(HOWTO).find(x => x === arg) || Object.keys(HOWTO).find(x => arg && (x.includes(arg) || arg.includes(x)))
    if (!k) return console.log('topics: ' + Object.keys(HOWTO).join(' ') + '\n(more depth: grep -i "<word>" docs/PLAYBOOK.md)')
    console.log(k + ': ' + HOWTO[k])
  } else if (cmd === 'bot') {
    const h = allHb().find(x => x.bot === arg); if (!h) return console.log('no fresh heartbeat for', arg)
    const code = 'const A=require("/root/workspace/bots/skills/lib/army.js");return {area:A.walkableArea(bot),sky:A.skyAbove(bot),held:bot.heldItem&&bot.heldItem.name,armor:[5,6,7,8].map(i=>bot.inventory.slots[i]&&bot.inventory.slots[i].name).filter(Boolean)}'
    let x = {}; try { x = JSON.parse(await post('/cmd', { bots: [arg], action: 'eval', args: { code } }, 3000))[0].result || {} } catch {}
    console.log(arg + '  pos ' + h.pos + ' (' + h.dim + ')  hp ' + h.hp + '  food ' + h.food + '  job ' + h.job + '  task "' + h.task + '"  deaths ' + h.deaths)
    console.log('walkable area ' + x.area + (x.area < 60 ? ' (BOXED IN)' : '') + '  sky ' + x.sky + '  held ' + x.held + '  armour ' + JSON.stringify(x.armor || []))
    console.log('inventory: ' + Object.entries(h.inv || {}).map(([k, v]) => k + ':' + v).join(' '))
    const lines = fs.readFileSync(path.join(DIR, 'results.jsonl'), 'utf8').trim().split('\n').slice(-4000).filter(l => l.includes('"bot":"' + arg + '"')).slice(-8)
    for (const l of lines) { try { const { t, bot, ev, ...rest } = JSON.parse(l); console.log('  ' + new Date(t).toISOString().slice(11, 19) + ' ' + String(ev).padEnd(12) + JSON.stringify(rest).slice(0, 150)) } catch {} }
  } else if (cmd === 'who') {
    const args = process.argv.slice(3); const M = musterOf(settings())
    let near = [M.x, M.z]; let has = null; let lim = 8
    for (const a of args) { if (a.startsWith('near:')) near = a.slice(5).split(',').map(Number); if (a.startsWith('has:')) has = new RegExp(a.slice(4)); if (a.startsWith('n:')) lim = +a.slice(2) }
    let l = allHb()
    if (args.includes('idle')) l = l.filter(h => h.job === 'muster')
    if (args.includes('fit')) l = l.filter(h => h.hp >= 12 && h.food >= 10)
    if (has) l = l.filter(h => Object.keys(h.inv || {}).some(k => has.test(k)))
    l.sort((a, b) => Math.hypot(a.pos[0] - near[0], a.pos[2] - near[1]) - Math.hypot(b.pos[0] - near[0], b.pos[2] - near[1]))
    console.log(l.length + ' match' + (l.length === 1 ? '' : 'es') + (l.length > lim ? ' (showing ' + lim + ')' : ''))
    for (const h of l.slice(0, lim)) console.log(h.bot.padEnd(8), ('d' + Math.round(Math.hypot(h.pos[0] - near[0], h.pos[2] - near[1]))).padEnd(6), ('hp' + h.hp).padEnd(5), ('f' + h.food).padEnd(4), String(h.job).padEnd(14), Object.entries(h.inv || {}).filter(([k]) => /pickaxe|_axe|sword|hoe|rod|bucket|shield|torch|cobblestone|_log$/.test(k)).map(([k, v]) => k + ':' + v).join(' '))
  } else if (cmd === 'ground') {
    const pts = process.argv.slice(4).map(a => a.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite))
    if (!pts.length) return console.log('usage: ground <bot> x,z [x,z ...]')
    const code = 'const out=[];for(const [x,z] of ' + JSON.stringify(pts) + '){let r=null;for(let y=Math.min(319,Math.floor(bot.entity.position.y)+40);y>=-64;y--){const b=bot.blockAt(new Vec3(x,y,z));if(!b){r="not loaded";break}if(b.boundingBox==="block"&&!/leaves|_log$/.test(b.name)){const a=bot.blockAt(new Vec3(x,y+1,z));r={ground:y,block:b.name,above:a&&a.name};break}}out.push([x,z,r])}return out'
    const out = JSON.parse(await post('/cmd', { bots: names, action: 'eval', args: { code } }, 20000) || '[]')[0]
    if (!out || !out.ok) return console.log('cannot probe through', arg, out && out.error)
    for (const [x, z, r] of out.result) console.log((x + ',' + z).padEnd(12), typeof r === 'string' || !r ? r : 'ground y=' + r.ground + ' (' + r.block + '), above: ' + r.above + '  -> place ON the ground at [' + x + ',' + (r.ground + 1) + ',' + z + ']')
  } else if (cmd === 'template') {
    const TEMPLATES = templates()
    if (!arg || !TEMPLATES[arg]) return console.log('kinds: ' + Object.keys(TEMPLATES).join(' | ') + '\nusage: node armyctl.js template lumber > /tmp/job.json ; edit the <…> fields and the id ; node armyctl.js put /tmp/job.json')
    console.log(JSON.stringify(TEMPLATES[arg], null, 1))
  } else if (cmd === 'sites') {
    let rows = []
    try { rows = fs.readFileSync(path.join(DIR, 'scout.jsonl'), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch {}
    const biomes = {}; for (const r of rows) if (r.biome) biomes[r.biome] = (biomes[r.biome] || 0) + 1
    console.log(rows.length + ' samples (' + rows.filter(r => r.hazard).length + ' scout deaths); biomes: ' + (Object.entries(biomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join(' ') || 'none - send the `scout` squads out'))
    const S = settings(); const sites = rankSites(rows); const n = +arg || 10
    console.log('BASE sites, best first (site = flat samples within 64 blocks on one y +-2; BASE = score >= ' + SITE_OK + ', >= 3 flat neighbours, liquid water, not cold). y = GROUND level' + (S.base ? '   [base is set: ' + [S.base.x, S.base.y, S.base.z].join(',') + ']' : ''))
    for (const s of sites.slice(0, n)) console.log(('score ' + s.score).padEnd(10) + (s.ok ? 'BASE ' : '  -  ') + (s.x + ',' + s.ground + ',' + s.z).padEnd(18) + s.biome.padEnd(16) + ' ' + s.why.join(', ') + (s.ok ? '   -> LOOK (template goto_look, mapshot), then: base set ' + s.x + ',' + s.ground + ',' + s.z : ''))
    if (sites.length && !sites.some(s => s.ok)) console.log('no base-grade site yet: keep the scouts walking (scout_ring fills the area between the far bearings)')
  } else if (cmd === 'base' && arg === 'keepout') {
    // KEEP-OUTS: land the base plan must leave alone (a ravine, a pond, a village) - no zone, no road within 3 of it; `plan-base` lays the lattice around
    // it, the sponge (`tidy`) stops groundskeeping there at once. A keep-out is a decision about the WORLD: it outlives every re-plan.
    const [, , , , op, id, boxArg, ...why] = process.argv; const usage = 'usage: base keepout add <id> x1,z1,x2,z2 <why…> | base keepout rm <id>   (list: `base`)'
    if (op === 'exit') { // the hole's WALKABLE way out (A.travel sends a bot inside the box there first): `base keepout exit <id> x,y,z`; it must be re-set when the way out changes (a fill buries a natural ramp)
      const c = String(boxArg || '').split(',').map(Number); if (c.length !== 3 || !c.every(Number.isInteger)) return console.log('usage: base keepout exit <id> x,y,z')
      try { console.log(withBoardLock(b => { const k = ((b.settings || {}).keepOut || []).find(q => q.id === id); if (!k) throw new Error('no keep-out ' + id); k.exit = c; return 'keep-out ' + id + ': exit ' + c.join(',') })) } catch (e) { console.log('REFUSED: ' + e.message) }
      return
    }
    if (!['add', 'rm'].includes(op) || !/^[a-z0-9_]+$/i.test(id || '')) return console.log(usage)
    let box = null; if (op === 'add') { const c = String(boxArg || '').split(',').map(Number); if (c.length !== 4 || !c.every(Number.isInteger) || !why.join(' ').trim()) return console.log(usage); box = [Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3])] }
    let r; try { r = withBoardLock(b => {
      const S = b.settings = b.settings || {}; const old = (S.keepOut || []).find(k => k.id === id); if (op === 'rm' && !old) throw new Error('no keep-out ' + id)
      S.keepOut = (S.keepOut || []).filter(k => k.id !== id); if (box) S.keepOut.push(Object.assign({ id, box, why: why.join(' ') }, old && old.exit ? { exit: old.exit } : {})); if (!S.keepOut.length) delete S.keepOut
      const errs = validateSettings(S).filter(e => /keepOut/.test(e)); if (errs.length) throw new Error(errs.join('; '))
      const same = (p, q) => JSON.stringify(p) === JSON.stringify(q); const tidied = []
      for (const j of b.jobs || []) { // the sponge leaves it alone from the next slice on (params.exclude of `tidy`): nobody tends the rim of a ravine
        if (j.type !== 'tidy' || !j.params || !Array.isArray(j.params.box)) continue
        const ex = (j.params.exclude || []).filter(e => !(old && same(e, grow(old.box, KEEP)))); if (box && overlap(box, j.params.box)) ex.push(grow(box, KEEP))
        if (!same(ex, j.params.exclude || [])) { if (ex.length) j.params.exclude = ex; else delete j.params.exclude; j.rev = (j.rev || 0) + 1; tidied.push(j.id) }
      }
      const hit = box ? (b.jobs || []).filter(j => j.type === 'build' && j.params && Array.isArray(j.params.origin) && /^BASE PLAN/.test(j.plan || '') && (() => { try { return blueprintCells(j.params).some(c => c.x >= box[0] - KEEP && c.x <= box[2] + KEEP && c.z >= box[1] - KEEP && c.z <= box[3] + KEEP) } catch { return false } })()).map(j => j.id + (j.status === 'active' ? ' (ACTIVE)' : '')) : []
      return (box ? 'keep-out ' + id + ' x ' + box[0] + '..' + box[2] + ' / z ' + box[1] + '..' + box[3] + ' (' + why.join(' ') + ')' + (old ? ' - replaced' : '') : 'keep-out ' + id + ' removed') + (tidied.length ? '\nsponge excludes it: ' + tidied.join(', ') : '') +
        (hit.length ? '\nBASE PLAN jobs that build inside it (+' + KEEP + '): ' + hit.join(', ') : '') + '\nnext: `plan-base` (look at the map), then `plan-base --put` - zones that were never started move, zones in progress stay unless they are BAD or kept out'
    }) } catch (e) { r = 'REFUSED: ' + e.message }
    console.log(r)
  } else if (cmd === 'base') {
    if (arg !== 'set') {
      const S = settings(); const n = o => Object.values(o || {}).reduce((a, l) => a + l.length, 0)
      if (!S.base) return console.log('no base yet (muster ' + JSON.stringify(S.muster || null) + '). Survey first: `sites` -> look at the best one -> `base set x,y,z` (y = ground level) -> `plan-base`')
      console.log('base ' + [S.base.x, S.base.y, S.base.z].join(',') + ' (y = the ONE ground level of the base)  muster ' + JSON.stringify(S.muster) + '\ncraftTable ' + JSON.stringify(S.craftTable || null) + '  mineHead ' + JSON.stringify(S.mineHead || null) + '  furnaces ' + (S.furnaces || []).length + '  respawnBeds ' + (S.respawnBeds || []).length + '  containers ' + n(S.chests) +
        '\nkeep-outs (no zone, no road within ' + KEEP + '; `base keepout add <id> x1,z1,x2,z2 <why…>` | `base keepout rm <id>`): ' + ((S.keepOut || []).map(k => '\n  ' + k.id.padEnd(10) + ' x ' + k.box[0] + '..' + k.box[2] + ' / z ' + k.box[1] + '..' + k.box[3] + '  ' + k.why).join('') || 'none') + '\nzones: `plan-base`')
      return
    }
    const c = String(process.argv[4] || '').split(',').map(Number); if (c.length !== 3 || !c.every(Number.isInteger) || c[1] < -60 || c[1] > 300) return console.log('usage: base set x,y,z [--move]   (integers; y = GROUND level: take the line `sites` prints, check it with `ground`)')
    let wood = null; if (flag('--wood')) { wood = String(process.argv[process.argv.indexOf('--wood') + 1] || '').split(',').map(Number); if (wood.length !== 4 || !wood.every(Number.isInteger)) return console.log('usage: --wood x1,z1,x2,z2 (a forest box outside the wall line)'); wood = [Math.min(wood[0], wood[2]), Math.min(wood[1], wood[3]), Math.max(wood[0], wood[2]), Math.max(wood[1], wood[3])]; }
    const S0 = settings(); const L0 = baseLayout({ x: c[0], y: c[1], z: c[2] }, (S0.roster || []).length || 30, S0.keepOut); const W0 = [c[0] + L0.wall[0], c[2] + L0.wall[1], c[0] + L0.wall[2], c[2] + L0.wall[3]] // the wall line of the plan (keep-outs known so far included; no survey yet)
    if (wood && overlap(wood, W0)) return console.log('REFUSED: the wood box overlaps the base (wall line ' + W0.join(',') + '): the lumber squad REPLANTS on its grid - that would be the zones')
    let r; try { r = withBoardLock(b => {
      const S = b.settings = b.settings || {}; const old = { muster: S.muster }
      if (S.base && !flag('--move')) return 'REFUSED: the base is set (' + [S.base.x, S.base.y, S.base.z].join(',') + '). A base is a decision for the whole world - moving it needs --move (then re-run `plan-base --put`: its jobs still point at the old place)'
      S.base = { x: c[0], y: c[1], z: c[2] }; S.muster = musterIn(S.base, (S.roster || []).length || 30, L0.zones.find(z => z.id === 'yard').rect) // the yard of the plan (`plan-base --put` moves it along when the survey moves the yard)
      // THE BOOTSTRAP SQUADS FOLLOW THE ARMY - also when the base was picked from the air (ops/skyshot.js) before any scout walked: nothing here
      // needs a scout sample. Bots walk from the spawn to the new muster by themselves (read-only travel, slice after slice).
      //   survey  -> a DETAIL survey of 4 around the base (animals, sugar cane, villages for `animals`/`sites`), the ring is paused
      //   wood    -> wood_site CLEARS the footprint of trees before the pads are levelled (`level` digs trunks but leaves crowns hanging; the
      //              tree farm blueprint never fells). The producing squad gets a forest OUTSIDE the wall line when --wood names one (it replants
      //              on its grid - inside the wall that would be the zones); without it the clearing itself is the wood supply until the tree farm
      //   hunt / forage / sponge -> measured from the base; guard and hunt range follow muster anyway
      const N = (S.roster || []).length || 30; const W = W0; const at = [c[0], c[1] + 1, c[2]]; const moved = []
      const site = 'BASE SITE x ' + W[0] + '..' + W[2] + ' / z ' + W[1] + '..' + W[3]
      const clearing = { id: 'wood_site', type: 'lumber', priority: 91, front: 'lumber', status: 'active', when: 'any', bots: Math.ceil(N / 6), site: at, requires: { minHp: 8 }, plan: site + ': fell every tree inside the wall line WHOLE (clear: no replanting here - the tree farm zone replants), bank the logs; ends when no trunk stands', params: { box: W, pitch: 3, bankAt: 48, clear: true } }
      for (const j of b.jobs || []) {
        if (j.id === 'scout_ring' && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: the base is chosen (re-activate to explore further)' } else if (j.id === 'scout_far' && j.type === 'scout') { j.names = (j.names || []).slice(0, 4); j.shiftMin = 30; j.params = { bearings: [45, 135, 225, 315], range: 800, step: 48, budgetMin: 12 }; j.plan = 'DETAIL SURVEY around the base, read-only walk: 4 bots, 12 min out, every trip 25 degrees on - herds for the pens (`animals`), sugar cane, villages, water; the base itself is chosen' } else if (j.id === 'wood_spawn' && j.type === 'lumber' && wood) { j.params = { box: wood, pitch: 3, bankAt: 48 }; j.site = [Math.round((wood[0] + wood[2]) / 2), c[1] + 1, Math.round((wood[1] + wood[3]) / 2)]; j.plan = 'WOOD for the base: the forest x ' + wood[0] + '..' + wood[2] + ' / z ' + wood[1] + '..' + wood[3] + ' outside the wall line - whole trees, replanted with their own saplings on a 3-grid, until the tree farm carries the army' } else if (j.id === 'wood_spawn' && j.type === 'lumber') { Object.assign(j, { site: at, plan: clearing.plan, params: clearing.params }) } else if (j.id === 'tidy_spawn' && j.type === 'tidy') { j.site = at; j.params = Object.assign(j.params || {}, { box: W, y: c[1] }); j.plan = 'GROUNDSKEEPING of the base site (the FALLBACK sponge) ' + site.slice(10) + ': holes filled, stray blocks removed; build footprints are left alone' } else if (j.id === 'hunt_spawn' && j.type === 'hunt') { j.site = at } else if (j.id === 'forage_spawn' && j.type === 'steps' && j.params && Array.isArray(j.params.steps)) { j.site = at; j.params.steps = [{ do: 'goto', to: [S.muster.x, null, S.muster.z], range: 32, s: 600 }].concat(j.params.steps.filter(s => s.do !== 'goto')) } else continue
        j.rev = (j.rev || 0) + 1; moved.push(j.id)
      }
      if (wood && (b.jobs || []).some(j => j.id === 'wood_spawn') && !(b.jobs || []).some(j => j.id === 'wood_site')) { b.jobs.push(clearing); moved.push('wood_site (new)') }
      const bad = (b.jobs || []).filter(j => moved.includes(j.id)).map(j => validateJob(j, S, b.jobs.map(x => x.id)).map(e => j.id + ': ' + e)).flat(); if (bad.length) throw new Error('base set produced an invalid job (nothing written): ' + bad.join('; '))
      const m = old.muster ? Math.round(Math.hypot(S.muster.x - musterOf(old).x, S.muster.z - musterOf(old).z)) : 0
      return 'base set ' + c.join(',') + '; muster -> ' + [S.muster.x, S.muster.y, S.muster.z].join(',') + ' (the yard, ' + S.muster.cols + ' columns)' + (moved.length ? '\nbootstrap jobs follow: ' + moved.join(', ') : '') + (wood ? '' : '\nwood: the footprint clearing is the only wood now. A forest OUTSIDE the wall line (skyshot/look): `patch wood_spawn \'{"params":{"box":[x1,z1,x2,z2],"clear":null}}\'`, or `base set … --move --wood x1,z1,x2,z2`') +
        '\n' + (m ? 'the army walks ' + m + ' blocks to the new muster by itself (read-only): `events 20 no_route` shows where water or a cliff stops it -> LOOK there, then ONE bridge/stair for everybody (`template build`, blueprint bridge), never a dig. ' : '') + 'Next: `node ops/skyshot.js ' + c[0] + ' ' + c[2] + ' 256 out.png` and save out.json as bots/army/survey-base.json (plan-base LOOKS at it: BAD ground is never planned on; a ravine/pond -> `base keepout add`), `plan-base`, `plan-base --put`, one line in docs/WORLD.md'
    }) } catch (e) { r = 'REFUSED: ' + e.message }
    console.log(r)
  } else if (cmd === 'plan-base') {
    const S = settings(); const at = flagXYZ('--at'); const usage = 'usage: plan-base [--at x,y,z] [--survey <skyshot.json>] [--force-zone <id>[,…]] [--move-zone <id>[,…]] [--put]'; if (at === 'bad') return console.log(usage)
    const base = at ? { x: at[0], y: at[1], z: at[2] } : S.base
    if (!base) return console.log('no base yet: `sites` -> `base set x,y,z` (or a dry run: plan-base --at x,y,z)')
    if (at && flag('--put')) return console.log('REFUSED: --put builds at settings.base only (`base set` first)')
    const val = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] || '' }
    // LOOK BEFORE PLANNING (09-19: the blind plan put the core pad across a ravine): the aerial survey decides where zones may go and is printed per zone
    let M = null; const sf = val('--survey') != null ? path.resolve(val('--survey')) : path.join(DIR, 'survey-base.json')
    try { M = loadSurvey(sf) } catch (e) { if (val('--survey') != null) return console.log('REFUSED: --survey ' + sf + ': ' + e.message) }
    const force = new Set(String(val('--force-zone') || '').split(',').filter(Boolean)); const N = (S.roster || []).length || 30
    const check = M ? (r, kind) => surveyRect(M, [base.x + r[0], base.z + r[1], base.x + r[2], base.z + r[3]], base.y, kind) : null
    // PINS: a zone whose pad/build job reported progress stays where the BOARD has it (its rect from the pad job), whatever the lattice says today
    // THE ARCHIVE IS PART OF THE BOOKS (09-20: `prune` had archived every finished pad and build, the pins were read from the board alone - and the dry run laid the
    // whole base out anew, core 70 blocks east of the core that stands; a --put would have started 44 jobs on top of the base): a finished job pins its zone and
    // keeps its road number exactly like a job on the board, and --put never puts it again (the structure audit brings it back when it is damaged).
    const board = (() => { try { return rj(BOARD) } catch { return {} } })(); const archive = new Map()
    try { for (const l of fs.readFileSync(path.join(DIR, 'jobs-archive.jsonl'), 'utf8').split('\n')) { if (!l) continue; try { const j = JSON.parse(l); if (j && j.id && /^BASE PLAN/.test(j.plan || '')) archive.set(j.id, j) } catch {} } } catch {}
    const cur = id => (board.jobs || []).find(j => j.id === id && /^BASE PLAN/.test(j.plan || '')) || archive.get(id) || null
    const prog = {}; try { for (const r of tailRows(null, 2e8)) if (r.job && ((r.ev === 'build_pass' && r.done > 0) || r.ev === 'build_done')) prog[r.job] = (prog[r.job] || 0) + (r.done || 1) } catch {}
    const pins = {}
    if (!at) for (const z of baseZones(N)) {
      const pad = cur('base_' + z.id + '_pad'); const o = pad && pad.params && pad.params.origin; const a = pad && pad.params && pad.params.args; if (!o || !a || !(o[0] === Math.round(o[0]))) continue
      const x1 = o[0] - Math.floor(a.w / 2) + 1 - base.x; const z1 = o[2] - Math.floor(a.d / 2) + 1 - base.z; const rect = [x1, z1, x1 + z.w - 1, z1 + z.d - 1]
      const mine = [pad].concat(z.builds(rect, z).map(b => cur('base_' + (b[2] || z.id)))).filter(Boolean); const done = mine.reduce((n, j) => n + (prog[j.id] || 0), 0)
      if (done) pins[z.id] = { rect, args: (mine[1] && mine[1].params && mine[1].params.args) || {}, done }
    }
    const fixed = [S.craftTable].concat(S.furnaces || [], S.respawnBeds || [], ...Object.values(S.chests || {})).filter(p => Array.isArray(p) && p.length === 3).map(p => [p[0] - base.x, p[2] - base.z])
    const L = baseLayout(base, N, S.keepOut, { check, force, pins, fixed: at ? [] : fixed, move: new Set(String(val('--move-zone') || '').split(',').filter(Boolean)) }); const A = r => [base.x + r[0], base.z + r[1], base.x + r[2], base.z + r[3]]
    const known = {}; const reserved = []; for (const j of [...archive.values()].filter(a => !(board.jobs || []).some(q => q.id === a.id)).concat(board.jobs || [])) { const m = /^base_road_(\d+)$/.exec(j.id); const P = j.params || {}; if (!m || !/^BASE PLAN/.test(j.plan || '') || !Array.isArray(P.origin) || !P.args) continue; known[[P.origin[0], P.origin[2], P.args.toX, P.args.toZ].join(',')] = +m[1]; if (prog[j.id]) reserved.push(+m[1]) }
    numberRoads(base, L, at ? {} : known, at ? [] : reserved)
    // verdicts on what was laid out (a forced zone and lines are judged too - only judged, a forced zone is put whatever the survey says)
    const verdicts = []; const skip = new Set()
    if (check) {
      for (const z of L.zones.filter(q => q.rect)) verdicts.push({ key: z.id, v: check(padOf(z.rect)) })
      L.roads.forEach(rd => verdicts.push({ key: 'road ' + rd.n, v: check(roadRect(rd.c), 'line') })); verdicts.push({ key: 'wall', v: check(L.wall, 'ring') })
      for (const q of verdicts) if (q.v.bad && !force.has(q.key.replace(' ', '_'))) skip.add(q.key)
    }
    const waterFrom = Array.isArray(S.waterFrom) ? S.waterFrom : ((board.jobs || []).concat([...archive.values()]).map(j => j.params && j.params.waterFrom).find(p => Array.isArray(p) && p.length === 3) || null)
    const { jobs, lines, problems, infill } = basePlan(base, N, L, skip, { check, waterFrom }); const W = A(L.wall)
    console.log('BASE PLAN for ' + N + ' bots at ' + [base.x, base.y, base.z].join(',') + ' - everything on ground level y' + base.y + '; wall line x ' + W[0] + '..' + W[2] + ' / z ' + W[1] + '..' + W[3] + '; the avenues cross at the plaza ' + (base.x + L.plaza[0]) + ',' + (base.z + L.plaza[1]) + '. Two build orders (FOOD: fields, pens · BASE: the rest), each in the order of PLAN §8; the dispatcher starts a job when its `after` job is done:')
    console.log(layoutMap(base, L))
    for (const k of S.keepOut || []) console.log('keep-out ' + k.id + ' x ' + k.box[0] + '..' + k.box[2] + ' / z ' + k.box[1] + '..' + k.box[3] + ' (+' + KEEP + '): ' + k.why)
    for (const n of L.notes) console.log('NOTE ' + n)
    console.log(' #  job                 zone       blueprint     origin            size     materials (x<=n = at most, only where a hole is)')
    for (const l of lines) console.log(String(l.seq).padStart(2) + '  ' + l.id.padEnd(20) + l.zone.padEnd(11) + l.blueprint.padEnd(14) + l.origin.join(',').padEnd(18) + l.size.padEnd(9) + l.mats + (l.status === 'active' ? '   [starts ACTIVE]' : l.after ? '   <- ' + l.after : ''))
    console.log('INFILL: ' + infill.n + ' level tiles between the zones (six chains, the first of each ACTIVE)' + (infill.tiny ? ', ' + infill.tiny + ' slivers < 6 columns left to tidy' : '') + (infill.bad.length ? '\n  NOT LEVELLED (BAD in the survey - a fall or water; look, then a bridge/fill_void/keep-out):\n    ' + infill.bad.join('\n    ') : ''))
    console.log('production behind the builds: ' + jobs.filter(j => j.type !== 'build' && j.type !== 'light').map(j => j.id + ' (' + j.type + ' ' + j.minBots + '-' + j.maxBots + ' bots -> ' + j.produces.join('/') + ', after ' + j.after + ')').join(' · '))
    if (M) {
      console.log('SURVEY ' + path.relative(process.cwd(), M.file) + ' (step ' + M.step + ', x ' + M.x0 + '..' + (M.x0 + (M.n - 1) * M.step) + ' / z ' + M.z0 + '..' + (M.z0 + (M.n - 1) * M.step) + ', ' + (M.age < 120 ? M.age + ' min' : Math.round(M.age / 60) + ' h') + ' old) - pads, road lines and the wall line against y' + base.y + ' (BAD = a fall >= 6, or > 5 % of a pad >= 4 off / wet; lines: a fall or water):')
      for (const q of verdicts) if (q.v.bad || q.v.unseen || !/^road/.test(q.key)) console.log('  ' + q.key.padEnd(9) + (force.has(q.key.replace(' ', '_')) ? 'FORCED ' : '') + q.v.text)
      const okRoads = verdicts.filter(q => /^road/.test(q.key) && !q.v.bad && !q.v.unseen).length; if (okRoads) console.log('  roads    ' + okRoads + ' of ' + L.roads.length + ' ok')
      if (skip.size) console.log('  -> BAD is never put: `base keepout add <id> x1,z1,x2,z2 <why…>` around what is wrong there and re-plan (the lattice goes around it), or --force-zone ' + [...skip].map(k => k.replace(' ', '_')).join(',') + ' when you have LOOKED and know better')
    } else console.log('NO SURVEY (' + path.relative(process.cwd(), sf) + ' is missing): THIS PLAN IS BLIND - it has not looked at the ground. `node ops/skyshot.js ' + base.x + ' ' + base.z + ' 256 out.png` writes out.json; then `plan-base --survey out.json` (or save it as ' + path.relative(process.cwd(), path.join(DIR, 'survey-base.json')) + ')')
    console.log(problems.length ? 'PROBLEMS:\n  - ' + problems.map(p => p.text).join('\n  - ') : 'checked: no zone overlaps a zone, a road or a keep-out, no road crosses a keep-out, every existing blueprint stays inside its zone')
    // what a --put would MOVE on the board (origins before -> after)
    const moves = jobs.map(j => { const c = cur(j.id); const o = c && c.params && c.params.origin; const n = j.params && j.params.origin; return o && n && String(o) !== String(n) ? { id: j.id, from: o, to: n, done: prog[j.id] || 0, status: c.status } : null }).filter(Boolean)
    if (moves.length) console.log('MOVES ' + moves.length + ' (board origin -> plan): ' + moves.map(m => m.id.replace(/^base_/, '') + ' ' + m.from[0] + ',' + m.from[2] + ' -> ' + m.to[0] + ',' + m.to[2] + (m.done ? ' [had ' + m.done + ' cells done]' : '')).join(' · '))
    if (!flag('--put')) return console.log('nothing written. `plan-base --put` writes these ' + jobs.length + ' jobs PAUSED (active: ' + FIRST_ACTIVE.join(', ') + '); pending blueprints are skipped until they exist - re-run then')
    if (problems.some(p => !p.job)) return console.log('REFUSED: the layout itself is wrong (see PROBLEMS)')
    if (!M) console.log('\n' + '!'.repeat(100) + '\n!! WARNING: --put WITHOUT A SURVEY. Nobody has looked at this ground: a ravine, a pond or a cliff under a pad stalls the whole build order\n!! (09-19: the core pad lay across a ravine down to y41). Run `node ops/skyshot.js ' + base.x + ' ' + base.z + ' 256 out.png` and re-run with --survey out.json.\n' + '!'.repeat(100) + '\n')
    const yard = L.zones.find(z => z.id === 'yard' && z.rect); const muster = yard && !skip.has('yard') ? musterIn(base, N, yard.rect) : null
    const res = withBoardLock(b => {
      const planIds = jobs.map(j => j.id); const ids = [...new Set((b.jobs || []).map(j => j.id).concat(planIds))]; const put = []; const kept = []; const skipped = []; const gone = []
      for (const job of jobs) {
        const line = lines.find(l => l.id === job.id); const bad = problems.find(p => p.job === job.id)
        if (line && line.pending) { skipped.push(job.id + ' (blueprint ' + job.params.blueprint + ' pending)'); continue }
        if (bad) { skipped.push(bad.text); continue }
        const errs = validateJob(job, b.settings, ids); if (errs.length) { skipped.push(job.id + ': ' + errs.join('; ')); continue }
        const i = b.jobs.findIndex(j => j.id === job.id)
        if (i < 0 && archive.has(job.id)) { kept.push(job.id + ' (finished, archived)'); continue }
        // a NEW road number over paving that exists (the lattice cut a line differently: road 13 = the finished roads 1 + 3) is not work - and re-running paving is not
        // free: a road re-run takes decks off to fill them from the ground (BUGS 09-20 04:50Z: the cave under road 1 opened and swallowed six bots)
        if (i < 0 && job.params && job.params.blueprint === 'road') {
          const a = job.params.args; const o = job.params.origin; const rr = roadRect([Math.min(o[0], a.toX), Math.min(o[2], a.toZ), Math.max(o[0], a.toX), Math.max(o[2], a.toZ)])
          const olds = (b.jobs || []).concat([...archive.values()]).filter(j => j.id !== job.id && j.params && j.params.blueprint === 'road' && Array.isArray(j.params.origin) && j.params.args).map(j => { const q = j.params.origin; const g = j.params.args; return { id: j.id, r: roadRect([Math.min(q[0], g.toX), Math.min(q[2], g.toZ), Math.max(q[0], g.toX), Math.max(q[2], g.toZ)]) } })
          let cov = 0; let all = 0; const by = new Set(); for (let x = rr[0]; x <= rr[2]; x++) for (let z = rr[1]; z <= rr[3]; z++) { all++; const h = olds.find(q => x >= q.r[0] && x <= q.r[2] && z >= q.r[1] && z <= q.r[3]); if (h) { cov++; by.add(h.id) } }
          if (cov >= 0.8 * all) { skipped.push(job.id + ': ' + Math.round(100 * cov / all) + ' % of it is paved already by ' + [...by].join(' + ') + ' - not put'); continue }
        }
        if (i < 0 && job.after && !b.jobs.some(j => j.id === job.after) && !jobs.some(j => j.id === job.after && !archive.has(j.id))) { delete job.after; if (job.type === 'build') job.status = 'active' } // its predecessor is finished and archived: it starts now
        if (i < 0) { b.jobs.push(job); put.push(job.id); continue }
        const cur = b.jobs[i]; job.status = cur.status; if (cur.note) job.note = cur.note // a re-run never restarts finished work or stops running work
        // THE PLAN OWNS WHAT AND WHERE, THE OPERATORS OWN HOW MUCH (09-20 05:5xZ, the first --put after a day of operations: base_dorm went from beds 50 back to the
        // blueprint default 1, and mine_iron's entrance moved one block east because the zone centre is computed, not read): a build job that stands where the plan
        // wants it keeps the args and extra params its operators tuned (beds, len, waterFrom); a delegate job that exists (the MINE: its stairwell is dug) is never re-aimed.
        if (cur.params && job.params && job.type === 'build' && cur.params.blueprint === job.params.blueprint && String(cur.params.origin) === String(job.params.origin)) { job.params.args = Object.assign({}, job.params.args, cur.params.args); for (const k of Object.keys(cur.params)) if (!(k in job.params)) job.params[k] = cur.params[k] }
        if (cur.params && job.type === 'delegate') { job.params = cur.params; job.site = cur.site }
        if (cur.after === undefined && job.after && !b.jobs.some(j => j.id === job.after)) delete job.after // its predecessor is finished and archived
        const shape = j => JSON.stringify([j.type, j.params, j.after || null, j.site]); if (shape(cur) === shape(job)) { kept.push(job.id); continue }
        const zone = (/^BASE PLAN zone (\S+)/.exec(job.plan) || [])[1]; const o = cur.params && cur.params.origin
        if (prog[cur.id] && o && String(o) !== String(job.params.origin) && !L.unpinned.has(zone)) { skipped.push(job.id + ': HAS PROGRESS (' + prog[cur.id] + ' cells) at ' + o.join(',') + ' and the plan wants it at ' + job.params.origin.join(',') + ' - left as it is: LOOK (mapshot), then finish it there or `rm` it and re-run'); continue } // only zones are pinned; a half-paved road is a human decision
        for (const k of ['bots', 'minBots', 'maxBots', 'priority', 'requires']) if (cur[k] != null) job[k] = cur[k] // head-counts are the operators' to steer; the plan owns WHAT and WHERE
        job.rev = (cur.rev || 0) + 1; b.jobs[i] = job; put.push(job.id + ' (rev ' + job.rev + ')')
      }
      // what the plan no longer contains must not start by itself at its OLD place (the `after` chains would activate it on top of a moved zone): a BAD
      // zone's jobs and numbered roads the lattice no longer has. Never started -> off the board; started -> paused with the reason, a human looks.
      for (const j of (b.jobs || []).slice()) {
        if (!/^BASE PLAN/.test(j.plan || '') || planIds.includes(j.id)) continue
        if (!/^(base_|farm_\d+$|lumber_base$|mine_iron$|cane_farm$)/.test(j.id)) continue // only what THIS planner writes: herd_sheep's plan text also begins "BASE PLAN zone pen_1" - an operator's job is never the planner's to remove
        if (prog[j.id]) { j.status = 'paused'; delete j.after; j.note = 'plan-base: no longer in the base plan (BAD in the survey, or the lattice changed) but it has progress - look, then rm'; j.rev = (j.rev || 0) + 1; gone.push(j.id + ' (paused: has progress)') } else { b.jobs.splice(b.jobs.indexOf(j), 1); gone.push(j.id) }
      }
      let mu = null; const m0 = b.settings.muster; if (muster && (!m0 || m0.x !== muster.x || m0.z !== muster.z || m0.y !== muster.y)) { b.settings.muster = muster; mu = (m0 ? [m0.x, m0.y, m0.z].join(',') : 'none') + ' -> ' + [muster.x, muster.y, muster.z].join(',') }
      // THE BOOTSTRAP JOBS FOLLOW THE PLAN (as in `base set`): the sponge and the footprint clearing work the wall line of THIS layout and stay out of the
      // keep-outs; nobody is staged at a base origin that lies inside a keep-out (09-19 it was the rim of the ravine) or sent to the old yard
      const mN = b.settings.muster; const KA = (b.settings.keepOut || []).map(k => grow(k.box, KEEP)); const span = 'x ' + W[0] + '..' + W[2] + ' / z ' + W[1] + '..' + W[3]; const same = (p, q) => JSON.stringify(p) === JSON.stringify(q); const follow = []
      for (const j of b.jobs || []) {
        if (/^BASE PLAN/.test(j.plan || '')) continue; const P = j.params || {}; const before = JSON.stringify([j.site, P, j.plan])
        if ((j.type === 'tidy' && j.id === b.settings.fallback && /^GROUNDSKEEPING of the base site/.test(j.plan)) || (j.type === 'lumber' && P.clear && /^BASE SITE/.test(j.plan))) { P.box = W.slice(); j.plan = j.plan.replace(/x -?\d+\.\.-?\d+ \/ z -?\d+\.\.-?\d+/, span) }
        if (j.type === 'tidy' && Array.isArray(P.box)) { const ex = (P.exclude || []).slice(); for (const k of KA) if (overlap(k, P.box) && !ex.some(e => same(e, k))) ex.push(k); if (ex.length) P.exclude = ex }
        if (mN && Array.isArray(j.site) && j.site[0] === base.x && j.site[2] === base.z && KA.some(k => overlap(k, [base.x, base.z, base.x, base.z]))) j.site = [mN.x, mN.y, mN.z] // only what `base set` staged at the origin - a repair job beside the ravine belongs where it is
        if (mN && m0 && j.type === 'steps' && Array.isArray(P.steps)) for (const st of P.steps) if (st.do === 'goto' && Array.isArray(st.to) && st.to[0] === m0.x && st.to[2] === m0.z) st.to = [mN.x, st.to[1], mN.z]
        if (JSON.stringify([j.site, P, j.plan]) !== before) { j.rev = (j.rev || 0) + 1; follow.push(j.id) }
      }
      return { put, kept, skipped, gone, mu, follow }
    })
    console.log((res.follow.length ? 'bootstrap jobs follow the plan (wall line, keep-outs, muster): ' + res.follow.join(', ') + '\n' : '') + 'put ' + res.put.length + ': ' + res.put.join(' ') + (res.kept.length ? '\nunchanged ' + res.kept.length : '') + (res.gone.length ? '\nleft the plan ' + res.gone.length + ': ' + res.gone.join(' ') : '') + (res.mu ? '\nmuster (the yard) ' + res.mu + ' - the army walks over by itself' : '') + (res.skipped.length ? '\nSKIPPED ' + res.skipped.length + ':\n  - ' + res.skipped.join('\n  - ') : '') + (skip.size ? '\nNOT PUT (BAD in the survey): ' + [...skip].join(', ') : ''))
  } else if (cmd === 'bootstrap') {
    let old = {}; try { old = rj(BOARD) } catch {}
    const everyone = ((old.settings || {}).roster || []).slice(); for (const f of [path.join(BOTS, 'roster.json'), ASSIGN]) { try { const r = rj(f); for (const n of Array.isArray(r) ? r : Object.keys(r)) if (typeof n === 'string' && !everyone.includes(n)) everyone.push(n) } catch {} } // union, order kept: the old board first (muster slots stay), then bots/roster.json (the owner raised the army), then assignments.json
    old.settings = Object.assign({}, old.settings, { roster: everyone })
    let spawn = flagXYZ('--spawn'); if (spawn === 'bad') return console.log('usage: bootstrap [--spawn x,y,z] [--replace]')
    if (!spawn) { // the world says where its spawn is (same read as ops/new-world.sh)
      try { const nbt = require(path.join(BOTS, 'node_modules', 'prismarine-nbt')); const D = nbt.simplify((await nbt.parse(fs.readFileSync(path.join(BOTS, '..', 'server', 'world', 'level.dat')))).parsed).Data; const p = (D.spawn && (D.spawn.pos || D.spawn)) || [D.SpawnX, D.SpawnY, D.SpawnZ]; if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) spawn = p.map(Math.round) } catch {}
      if (!spawn) return console.log('cannot read the world spawn from server/world/level.dat - give it: bootstrap --spawn x,y,z')
    }
    let history = 0; try { history = fs.statSync(path.join(DIR, 'results.jsonl')).size } catch {}
    if ((history > 0 || (old.settings || {}).base) && !flag('--replace')) return console.log('REFUSED: this board has a history (' + history + ' bytes of reports' + ((old.settings || {}).base ? ', a base' : '') + '). bootstrap REPLACES every job and setting - it is for the empty board of a new world (ops/new-world.sh). Really? --replace (the old board goes to jobs.json.bak)')
    const board = bootstrapBoard(old, spawn); const ids = board.jobs.map(j => j.id)
    const errs = validateSettings(board.settings).concat(...board.jobs.map(j => validateJob(j, board.settings, ids).map(e => j.id + ': ' + e)))
    if (!ids.includes(board.settings.fallback)) errs.push('settings.fallback names no job')
    if (errs.length) return console.log('REFUSED:\n  - ' + errs.join('\n  - '))
    if (old.jobs) { wj(BOARD + '.bak', old); withBoardLock(b => { for (const k of Object.keys(b)) delete b[k]; Object.assign(b, board) }) } else wj(BOARD, board)
    console.log('bootstrap board written: muster = spawn ' + spawn.join(',') + ', ' + board.settings.roster.length + ' bots, nightSkip off until a bed + sleeper exist, targets ' + Object.entries(board.settings.targets).map(([k, v]) => k + ':' + v).join(' '))
    for (const j of board.jobs) console.log('  ' + j.id.padEnd(14) + j.type.padEnd(8) + (j.names ? j.names.length + ' pinned' : j.produces ? j.minBots + '-' + j.maxBots + ' bots -> ' + j.produces.join('/') : j.bots + ' bots' + (j.id === board.settings.fallback ? ' (fallback sponge)' : '')).padEnd(34) + j.when)
    console.log('next: `base set x,y,z` at once when the site was picked from the air (ops/skyshot.js, docs/WORLD.md), else ops/up.sh -> scouts -> `sites` -> look -> `base set`; then `plan-base --put`')
  } else if (cmd === 'targets') {
    const K = STOCK(); const n = process.argv[4]
    if (arg) {
      if (!stockKey(arg) || n == null || !(n === 'none' || (Number.isFinite(+n) && +n >= 0))) return console.log('usage: targets <item|group> <n|none>   (groups: ' + Object.keys(K.groups).join(' ') + '; 0 = we want none: its producers drop to minBots; none = no target: the dispatcher guesses)')
      withBoardLock(b => { const T = b.settings.targets = b.settings.targets || {}; if (n === 'none') delete T[arg]; else T[arg] = +n }); return console.log('target ' + arg + ' -> ' + n)
    }
    const b = rj(BOARD); const st = K.stock({ dir: DIR }); const D = K.detail({ dir: DIR }); const T = (b.settings || {}).targets || {}
    console.log('stock targets (labour by demand: a producing job gets minBots + ceil((maxBots - minBots) * worst deficit of what it produces))\n' + 'key'.padEnd(16) + 'have'.padStart(7) + ' =  depot'.padStart(9) + ' + carried'.padStart(10) + 'target'.padStart(8) + ' deficit  produced by   (SUPPLY rows = what jobs WITHDRAW: the quartermaster crafts against the DEPOT column, pockets are not a shelf)')
    for (const [k, t] of Object.entries(T)) { const h = K.count(k, st); const by = (b.jobs || []).filter(j => (j.produces || []).includes(k)).map(j => j.id + (j.status === 'active' ? '' : '(paused)') + ' ' + (j.minBots || 0) + '-' + j.maxBots); const sup = /^(torch|planks|stick|book|bookshelf|enchanting_table)$/.test(k); const dep = K.count(k, D.chest); const hh = sup ? dep : h; console.log(k.padEnd(16) + String(h).padStart(7) + String(dep).padStart(9) + String(K.count(k, D.carried)).padStart(10) + String(t).padStart(8) + (Math.round((t > 0 ? Math.max(0, Math.min(1, 1 - hh / t)) : 0) * 100) + '%').padStart(8) + (sup ? ' SUPPLY' : '       ') + '  ' + (by.join(', ') || (/^(torch|planks|stick|book|bookshelf|enchanting_table)$/.test(k) ? 'the quartermaster (scan job) crafts it from depot stock, one batch per round, when the materials are there (`recipe ' + k + '`)' : 'NOBODY - a target without a producing job moves no bot'))) }
    if (!Object.keys(T).length) console.log('(none: settings.targets is empty - `targets food 256`)')
  } else if (cmd === 'put' || cmd === 'putjson') { // putjson '<json>' = same as put, without needing a file (headless operators may not write files)
    let job; try { job = cmd === 'putjson' ? JSON.parse(process.argv.slice(3).join(' ')) : rj(path.resolve(arg)) } catch (e) { return console.log('bad JSON: ' + e.message) } if (!job.id || !job.type) return console.log('job needs id and type')
    if (JSON.stringify(job).includes('<')) return console.log('REFUSED: the job still contains <placeholders>')
    const errs = validateJob(job); if (errs.length) return console.log('REFUSED:\n  - ' + errs.join('\n  - '))
    withBoardLock(b => { const i = b.jobs.findIndex(j => j.id === job.id); if (i >= 0) { job.rev = Math.max(job.rev || 0, (b.jobs[i].rev || 0) + 1); b.jobs[i] = job } else b.jobs.push(job) })
    console.log('put', job.id, 'rev', job.rev || 0)
  } else if (cmd === 'patch') {
    let patch; try { patch = JSON.parse(process.argv[4]) } catch { return console.log('usage: patch <id> \'{"bots":12}\'') }
    const r = withBoardLock(b => { // the merged job must pass the same validator as `put`; a null value drops the field
      const i = b.jobs.findIndex(x => x.id === arg); if (i < 0) return null; const j = JSON.parse(JSON.stringify(b.jobs[i])); const { params, ...rest } = patch
      Object.assign(j, rest); if (params) j.params = Object.assign(j.params || {}, params); for (const o of [j, j.params || {}]) for (const k of Object.keys(o)) if (o[k] === null) delete o[k]
      if (patch.rev == null) j.rev = (j.rev || 0) + 1
      const errs = validateJob(j, b.settings, b.jobs.map(x => x.id)); if (errs.length) return { errs }
      b.jobs[i] = j; return j
    })
    if (r && r.errs) return console.log('REFUSED:\n  - ' + r.errs.join('\n  - '))
    console.log(r ? 'patched ' + arg + ' -> ' + JSON.stringify({ status: r.status, bots: r.bots, minBots: r.minBots, maxBots: r.maxBots, names: r.names, rev: r.rev, priority: r.priority }) : 'no such job')
  } else if (cmd === 'chest') { // chest add <cat> x,y,z | chest list
    const S0 = rj(BOARD).settings.chests || {}
    if (arg !== 'add') return console.log(Object.entries(S0).map(([k, v]) => k + ': ' + v.map(c => c.join(',')).join(' | ')).join('\n') + '\nusage: chest add <food|tools|ores|build|salvage> x,y,z   (the chest must already stand there)')
    const cat = process.argv[4]; const c = (process.argv[5] || '').split(',').map(Number)
    if (!['food', 'tools', 'ores', 'build', 'salvage'].includes(cat) || c.length !== 3 || c.some(n => !Number.isFinite(n))) return console.log('usage: chest add <food|tools|ores|build|salvage> x,y,z')
    withBoardLock(b => { const l = b.settings.chests[cat] = b.settings.chests[cat] || []; if (!l.some(q => q[0] === c[0] && q[1] === c[1] && q[2] === c[2])) l.push(c) })
    console.log('registered', cat, 'chest at', c.join(','))
  } else if (cmd === 'census') { // census [ores|func] : what stands in the world that our books do not know (every bot looks around; pure perception)
    const roster = rj(BOARD).settings.roster || Object.keys(rj(path.join(BOTS, 'assignments.json')))
    const S = rj(BOARD).settings; const known = new Set()
    for (const l of Object.values(S.chests || {})) for (const c of l) known.add(c.join(','))
    for (const l of Object.values(S.legacyChests || {})) for (const c of l) known.add(c.join(','))
    try { for (const f of rj(path.join(BOTS, 'base.json')).furnaces || []) known.add([f.x, f.y, f.z].join(',')) } catch {}
    for (const f of (S.furnaces || []).concat(S.respawnBeds || [])) known.add(Array.isArray(f) ? f.slice(0, 3).join(',') : [f.x, f.y, f.z].join(',')) // what the build job registered (PLAN §9)
    for (const j of rj(BOARD).jobs || []) for (const c of [j.params && j.params.siteChest, j.params && j.params.chest, j.params && j.params.bed].filter(Array.isArray)) known.add(c.join(','))
    for (const j of rj(BOARD).jobs || []) for (const t of (j.params && j.params.keepTables) || []) known.add(t.join(','))
    if (tableOf(S)) known.add(tableOf(S).join(','))
    const func = new Map(); const ores = new Map(); let seen = 0
    for (const n of roster) { // one bot after the other: findBlocks over 96 blocks is heavy, and three bots share one process
      const code = 'const f="/root/workspace/bots/skills/lib/census.js";delete require.cache[f];return require(f).census(bot)'
      let r; try { r = JSON.parse(await post('/cmd', { bots: n, action: 'eval', args: { code, timeout: 25000 }, wait: true }, 30000) || '[]')[0] } catch { continue }
      if (!r || !r.ok || !r.result) continue
      seen++
      for (const [name, x, y, z] of r.result.func) func.set(x + ',' + y + ',' + z, name)
      for (const [name, x, y, z] of r.result.ores) ores.set(x + ',' + y + ',' + z, name)
    }
    const out = { t: Date.now(), bots: seen, unknown: [...func].filter(([k]) => !known.has(k)).map(([k, name]) => ({ name, at: k.split(',').map(Number) })), ores: [...ores].map(([k, name]) => ({ name, at: k.split(',').map(Number) })) }
    fs.writeFileSync(path.join(DIR, 'census.json'), JSON.stringify(out))
    const m = musterOf(S); const d = a => Math.round(Math.hypot(a[0] - m.x, a[2] - m.z))
    if (arg !== 'ores') {
      const by = {}; for (const u of out.unknown) (by[u.name] = by[u.name] || []).push(u.at)
      console.log('CENSUS through ' + seen + ' bots: ' + func.size + ' functional blocks seen, ' + out.unknown.length + ' NOT in our books (registry: chests/barrels, furnaces, job chests, kept tables). d = distance from muster')
      for (const [name, l] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) console.log('  ' + name.padEnd(16) + String(l.length).padStart(4) + '  ' + l.sort((a, b) => d(a) - d(b)).slice(0, 14).map(a => a.join(',') + '(d' + d(a) + ')').join(' ') + (l.length > 14 ? ' …' : ''))
    }
    if (arg !== 'func') {
      const by = {}; for (const o of out.ores) (by[o.name] = by[o.name] || []).push(o.at)
      console.log('EXPOSED ORES (air/water beside them - a player would see them): ' + out.ores.length)
      for (const name of ['diamond_ore', 'emerald_ore', 'ancient_debris', 'gold_ore', 'redstone_ore', 'lapis_ore', 'iron_ore', 'coal_ore', 'copper_ore']) { const l = by[name]; if (!l) continue; console.log('  ' + name.padEnd(14) + String(l.length).padStart(5) + '  ' + l.sort((a, b) => d(a) - d(b)).slice(0, 10).map(a => a.join(',')).join(' ') + (l.length > 10 ? ' …' : '')) }
    }
    console.log('full list: bots/army/census.json')
  } else if (cmd === 'prune') { // finished one-off jobs (paused + last terminal event *_done) leave the board; they are kept in bots/army/jobs-archive.jsonl
    const last = {}
    for (const l of fs.readFileSync(path.join(DIR, 'results.jsonl'), 'utf8').split('\n')) { if (!/"ev":"(plan|build|deck|light)_(done|failed)"/.test(l)) continue; try { const r = JSON.parse(l); last[r.job] = r.ev } catch {} }
    const gone = []
    withBoardLock(b => { b.jobs = b.jobs.filter(j => { const done = j.status !== 'active' && /_done$/.test(last[j.id] || '') && j.id !== b.settings.fallback; if (done) gone.push(j); return !done }) })
    if (gone.length) fs.appendFileSync(path.join(DIR, 'jobs-archive.jsonl'), gone.map(j => JSON.stringify(j)).join('\n') + '\n')
    console.log('pruned ' + gone.length + ': ' + gone.map(j => j.id).join(' '))
  } else if (cmd === 'rm') {
    withBoardLock(b => { b.jobs = b.jobs.filter(j => j.id !== arg) }); console.log('removed', arg)
  } else if (cmd === 'wait') {
    const who = arg || 'op'; const maxSec = +(process.argv[4] || 600); const topics = (process.argv[5] || '').split(',').filter(Boolean)
    const curF = path.join(DIR, 'attention.' + who.replace(/[^a-z0-9_]/gi, '') + '.json')
    let cur = { pos: 0, seen: {} }; try { cur = rj(curF) } catch { try { cur.pos = fs.statSync(path.join(DIR, 'results.jsonl')).size } catch {} }
    const mine = id => !topics.length || topics.some(t => String(id || '').startsWith(t)); const general = !topics.length
    const end = Date.now() + maxSec * 1000
    const digest = () => {
      const out = []
      const f = path.join(DIR, 'results.jsonl'); const size = fs.statSync(f).size
      if (size < cur.pos) { cur.pos = 0; cur.quietPos = 0 }
      if (cur.quietPos == null || cur.quietPos > size) cur.quietPos = cur.pos
      if (size > cur.pos) {
        const rows = tailRows(cur.pos, 2e6); cur.pos = size
        const agg = {}
        const LOUD = ['plan_failed', 'plan_done', 'plan_idle', 'hung', 'stranded', 'no_route', 'deck_done', 'build_done', 'light_done', 'depot_ready', 'death', 'error', 'scout_trip', 'chest_full']
        // today's sensors/audits: ONE line per signature (not per bot), the same signature at most once per 30 min (they repeat every pass)
        const SLOW = { hedge_damaged: r => r.job, structure_damaged: r => r.job, crops_vanished: r => r.job, farm_degrading: r => r.job, flood: r => r.job, bed_missing: r => String(r.at), mine_blocked: r => r.job + '|' + r.why, stair_broken: r => 'g' + r.group + (r.unrepaired ? 'U' : ''), stair_no_filler: r => '', stair_repair_refused: r => String(r.at), mine_reconnect: r => r.ok ? null : String(r.why).slice(0, 30), mine_not_ready: r => /could not/.test(String(r.note)) ? String(r.missing) : null, mine_kit_short: r => String(r.short), mine_bad_entrance: r => '', mine_no_entrance: r => '', mine_level_refused: r => 'y' + r.level, mine_bad_level: r => 'y' + r.level, build_stuck: r => r.job, void_under_pad: r => r.job, ores_exhausted: r => r.job, chest_missing: r => '', chest_rebuild_failed: r => String(r.why).replace(/[0-9]+/g, 'N').slice(0, 30) }
        const places = {}
        for (const r of rows) {
          if (INFO_EVS.includes(r.ev)) continue
          if (!LOUD.includes(r.ev) && !SLOW[r.ev]) continue
          if (SLOW[r.ev] && SLOW[r.ev](r) === null) continue // the quiet variant of an event (a reconnect that worked, kit being fetched)
          if (r.job && !mine(r.job) && !['stranded', 'no_route'].includes(r.ev)) continue
          if (!r.job && SLOW[r.ev] && !general) continue
          const k = SLOW[r.ev] ? r.ev + '|' + SLOW[r.ev](r) : r.ev + '|' + (r.job || '') + '|' + (r.ev === 'plan_failed' ? r.do + ':' + r.why : ['death', 'plan_done', 'build_done', 'light_done'].includes(r.ev) ? '' : r.bot)
          const a = agg[k] = agg[k] || { n: 0, bots: new Set(), r, k, ats: new Set() }; a.n++; a.bots.add(r.bot); a.r = r; if (r.at) a.ats.add(String(r.at))
          if (r.ev === 'chest_missing') places[String(r.at)] = 1
        }
        for (const a of Object.values(agg)) {
          const r = a.r; const who = ' [' + [...a.bots].slice(0, 6).join(' ') + (a.bots.size > 6 ? ' +' + (a.bots.size - 6) : '') + (a.n > 1 ? ', x' + a.n : '') + ']'
          if (SLOW[r.ev]) { if (Date.now() - (cur.seen['ev:' + a.k] || 0) < 1800000) continue; cur.seen['ev:' + a.k] = Date.now() }
          if (r.ev === 'death') { if (a.n >= 3) out.push('DEATHS x' + a.n + ' on job ' + (r.job || '?') + ' (' + [...a.bots].slice(0, 5).join(' ') + ') -> pause or fix the job; causes: `armyctl.js deaths 15`') } else if (r.ev === 'plan_failed') out.push('PLAN FAILED ' + r.job + ' step ' + r.at + ' ' + r.do + ': ' + r.why + ' [' + [...a.bots].join(' ') + '] -> re-plan (patch params.steps) or log a bug')
          else if (r.ev === 'hung') out.push('HUNG ' + [...a.bots].join(' ') + ' on ' + r.job + ' (task "' + r.task + '", at ' + r.at + ', walkable ' + r.area + ') -> look at the place: armyctl.js look ' + r.bot + ' 8; blocked path? wrong coords? log a bug if the job is at fault')
          else if (r.ev === 'plan_idle') out.push('PLAN IDLE ' + r.job + ': a whole repeat pass produced nothing (no stock / nothing left to do) [' + [...a.bots].join(' ') + '] -> pause it or feed it')
          else if (r.ev === 'plan_done') out.push('plan done ' + r.job + ' [' + [...a.bots].join(' ') + '] -> next plan for these bots?')
          else if (r.ev === 'build_done' || r.ev === 'light_done') { let nx = []; try { nx = (rj(BOARD).jobs || []).filter(j => j.after === r.job) } catch {} out.push('BUILD DONE ' + r.job + (nx.length ? ' -> the dispatcher starts its successors by itself (' + nx.map(j => j.id).join(', ') + '): check they get bots (`board`)' : r.standing ? ' (standing repair order)' : '')) }
          else if (r.ev === 'stranded') out.push('STRANDED ' + r.bot + ' at ' + r.at + ' -> armyctl rescue ' + r.bot)
          else if (r.ev === 'no_route') out.push('no_route ' + r.bot + ' -> ' + JSON.stringify(r.to) + ' (needs a road/stairs/fill job, or a different target)')
          else if (r.ev === 'chest_full') out.push('CHEST FULL: category ' + r.cat + ' (' + (r.left || []).join(',') + ' not banked) -> place a chest next to the depot row (steps: withdraw chest, place at a `ground`-checked cell) then `armyctl.js chest add ' + r.cat + ' x,y,z`')
          else if (r.ev === 'error') out.push('WORKER ERROR ' + r.bot + ' ' + String(r.err).slice(0, 140) + ' -> docs/BUGS.md')
          else if (r.ev === 'scout_trip') out.push('scout back: ' + r.bot + ' best ' + JSON.stringify(r.best && { pos: r.best.pos, biome: r.best.biome, score: r.best.score, water: !!r.best.water }))
          else if (r.ev === 'hedge_damaged') out.push('HEDGE DAMAGED ' + r.job + ': bushes ' + r.was + ' -> ' + r.now + who + ' -> mobs/bots trample them or one of our own jobs digs there: look (`look <bot> 12`), the berries job replants by itself')
          else if (r.ev === 'structure_damaged') out.push('STRUCTURE DAMAGED ' + r.job + ': ' + r.missing + ' of ' + r.of + ' cells differ from the blueprint (' + (r.examples || []).slice(0, 2).join(', ') + ') -> its build job was re-activated = the repair; check it is staffed (`board`), do not start a second job')
          else if (r.ev === 'crops_vanished' && r.was != null) out.push('CROPS VANISHED ' + r.job + ' near ' + r.at + ': plants ' + r.was + ' -> ' + r.now + who + ' -> cane cannot be trampled: LOOK who digs there (`look <bot> 12`); the job replants by itself')
          else if (r.ev === 'crops_vanished') out.push('CROPS VANISHED ' + r.job + ' near ' + r.at + ': replanted ' + r.replanted + ' vs harvested ' + r.harvested + who + ' -> farmland trampled (bots/mobs jumping on it), or water is gone (see farm_degrading/flood)')
          else if (r.ev === 'farm_degrading') out.push('FARM DEGRADING ' + r.job + ': dry cells ' + r.dry + ' (best ever ' + r.best + ')' + who + ' -> the field loses its water: look at the holes (`look <farmer> 14`); plugged water = a CODE/board gap -> docs/BUGS.md once, not per pass')
          else if (r.ev === 'flood') out.push('FLOOD ' + r.job + ': ' + r.flowing + ' flowing water cells, open sources ' + JSON.stringify((r.openSources || []).slice(0, 3)) + ' -> pause planting there, cap the sources (steps: place a block ON each source)')
          else if (r.ev === 'bed_missing') out.push('BED MISSING at ' + r.at + ' (' + r.why + ')' + who + ' -> nights are real until a bed stands there: `recipe white_bed`, `stock bed|wool`, then a `steps` plan places it')
          else if (r.ev === 'mine_blocked') out.push('MINE BLOCKED ' + r.job + ' "' + r.task + '": ' + r.why + ' at ' + r.at + (r.to ? ' -> ' + r.to : '') + who + ' -> `look ' + r.bot + ' 8 cave`; water/lava/gravel in the line? the helpdesk answers single bots - the same cell again and again = docs/BUGS.md')
          else if (r.ev === 'stair_broken') out.push('MINE STAIR BROKEN, flight ' + r.group + (r.y != null ? ' (y ' + r.y + ')' : '') + (r.unrepaired ? ': NOT repaired (' + r.left + ' cells left, filler ' + r.filler + ', pick ' + r.pick + ') - the only way down is closed' : ': ' + r.n + ' cells ' + String(r.cells || '').slice(0, 60)) + who + ' -> the miners audit and repair their stairwell on every commute (`stair_repaired` follows); unrepaired = no cobblestone/pick in the kit: `stock "cobblestone|pickaxe"`')
          else if (r.ev === 'stair_no_filler') out.push('MINE STAIR REPAIR WITHOUT FILLER' + who + ' -> a repair needs cobblestone in the pockets and the depot has none to draw: `stock cobblestone`, the `ores`/mine squads bank it')
          else if (r.ev === 'stair_repair_refused') out.push('MINE STAIR REPAIR REFUSED at ' + r.at + who + ' -> the broken cell is not floor/wall/ceiling of the stairwell (a cave cut in?): `look ' + r.bot + ' 8 cave`, then docs/BUGS.md')
          else if (r.ev === 'mine_reconnect') out.push('MINER OFF THE GRAPH ' + r.bot + ' at ' + r.at + ': ' + r.why + ' -> it moves only along branch-trunk-hub-stairs and could not get back on (helpdesk ticket mine_lost); `bot ' + r.bot + '`, rescue ONLY if it is really hung')
          else if (r.ev === 'mine_not_ready') out.push('MINE NOT READY: the depot could not supply ' + r.missing + (String(r.short || '') ? ' (short: ' + r.short + ')' : '') + who + ' -> miners were handed back: food (>= 8 bread-equivalents), pickaxe + spare: `targets`, toolsmith plan')
          else if (r.ev === 'mine_kit_short') out.push('mine kit short: ' + r.short + who + ' -> they went down without it; torches = `targets torch`, a torch plan')
          else if (r.ev === 'mine_bad_entrance') out.push('MINE BAD ENTRANCE ' + r.entrance + ' (found ' + r.found + ' under it)' + who + ' -> entrance.y = FEET y on solid ground: `ground`, level the mine-head pad (base_mine_pad), then patch params.args.entrance')
          else if (r.ev === 'mine_no_entrance') out.push('MINE HAS NO ENTRANCE' + who + ' -> patch the mine job: params.args.entrance {x,y,z,facing} (plan-base writes it) or settings.mineHead')
          else if (r.ev === 'mine_level_refused' || r.ev === 'mine_bad_level') out.push('MINE LEVEL y ' + r.level + ' REFUSED by the miners: ' + r.why + who + ' -> the squad keeps its old level; order a level the stairwell can serve: `mine level <y> dry`')
          else if (r.ev === 'build_stuck') out.push('BUILD STUCK ' + r.job + ': ' + r.left + ' cell(s) left that nobody can do: ' + String(r.cells).slice(0, 80) + ' -> `ground`/`look` that cell; unreachable or protected? finish it with a `steps` plan or `rm` the job')
          else if (r.ev === 'void_under_pad') out.push('VOID UNDER PAD ' + r.job + ': ' + r.n + ' air cells under a finished pad (' + String(r.cells).slice(0, 60) + ' …) -> never deck a hole: `template build` with blueprint fill_void for that box')
          else if (r.ev === 'chest_missing') out.push('CHEST MISSING x' + a.n + ' at ' + Object.keys(places).length + ' registered place(s): ' + Object.keys(places).slice(0, 4).join(' | ') + ' -> broken (creeper?) - the quartermaster rebuilds them (`chest_rebuilt`); only a place that stays missing needs you: `events 20 chest_re`')
          else if (r.ev === 'chest_rebuild_failed') out.push('CHEST REBUILD FAILED at ' + [...a.ats].slice(0, 4).join(' | ') + (a.ats.size > 4 ? ' +' + (a.ats.size - 4) + ' more' : '') + ': ' + r.why + who + ' -> `ground`/`look` the cell; something else stands there -> drop the entry or clear the cell with a `steps` plan')
          else if (r.ev === 'ores_exhausted') out.push('ORES EXHAUSTED ' + r.job + who + ' -> no reachable exposed ore left: `armyctl.js census ores`, raise params.radius / lower params.minY, or pause it (bots fall to the sponge job)')
          else out.push(r.ev + ' ' + (r.job || '') + ' ' + r.bot)
        }
      }
      // standing conditions (reported when they change, at most every 10 min each)
      let st = {}; try { st = rj(path.join(DIR, 'status.json')) } catch {} // a new world has no status.json until the dispatcher's first tick
      const b = rj(BOARD)
      const hb = allHb().filter(h => Date.now() - h.t < 120000)
      const cond = (key, text) => { if (Date.now() - (cur.seen[key] || 0) > 600000) { cur.seen[key] = Date.now(); out.push(text) } }
      { // OUTCOME, not mechanism (main 09-20: 8 of 50 bots at food <= 10 with bread IN THE POCKET and nobody saw it - "weak" was read as "no food"): a hungry bot that carries food = the eat rule is not running
        const EAT = /bread|cooked_|baked_potato|^apple$|golden_carrot|^carrot$|pumpkin_pie|cookie/; const fed = hb.filter(h => h.food != null && h.food <= 8 && Object.keys(h.inv || {}).some(k => EAT.test(k))).map(h => h.bot + '(f' + h.food + ')')
        if (fed.length >= 4) cond('starving_fed', 'HUNGRY WITH FOOD IN THE POCKET: ' + fed.length + ' bots — ' + fed.slice(0, 10).join(' ') + ' -> the eat rule is not running (army.js mealReflex / feed.js): CODE bug, one line in docs/BUGS.md') }
      if (st.phase === 'day') { const idle = hb.filter(h => h.job === 'muster' && h.hp >= 12 && h.food >= 10).map(h => h.bot); if (idle.length >= 4) cond('idle', 'IDLE by day (fit): ' + idle.length + ' bots — ' + idle.slice(0, 12).join(' ') + ' -> staff a squad job (raise bots / new job)') }
      for (const j of b.jobs) if (j.status === 'active' && !(j.restUntil > Date.now()) && mine(j.id) && !(st.staffed || {})[j.id] && (j.when || 'any') !== (st.phase === 'day' ? 'night' : 'day')) cond('unstaffed:' + j.id, 'UNSTAFFED active job ' + j.id + ' (requires ' + JSON.stringify(j.requires || {}) + ', names ' + JSON.stringify(j.names || j.bots || (j.minBots || 0) + '-' + j.maxBots) + ')')
      const idx = (() => { try { return rj(path.join(DIR, 'chests.json')) } catch { return {} } })(); const stock = re => Object.values(idx).reduce((n, v) => n + Object.entries(v.items || {}).filter(([k]) => re.test(k)).reduce((a, [, c]) => a + c, 0), 0)
      if (stock(/^(cooked_|bread$|baked_potato$)/) < 16) cond('lowfood', 'LOW cooked food in stock: ' + stock(/^(cooked_|bread$)/) + ' (raw fish ' + stock(/^(cod|salmon)$/) + ')')
      if (stock(/_pickaxe$/) < 2) cond('lowpicks', 'LOW pickaxes in stock: ' + stock(/_pickaxe$/) + ' -> toolsmith plan')
      { // GEMBA (ops/gemba.js, one 60 s watch every 10 min, the inspector is its clock): the CLASS-AGNOSTIC yardsticks the owner uses - who STANDS,
        // which job CRAWLS against one player by hand, who produced NOTHING in 10 min. The line says WHERE and WHAT TO LOOK AT; the diagnosis is
        // yours AFTER you looked (`look`, `mapshot.js`). At most one line per finding per 20 min. Full block: REPORT.md § GEMBA.
        let G = null; try { G = rj(path.join(BOTS, 'metrics', 'gemba.json')) } catch {}
        const gcond = (key, text) => { if (Date.now() - (cur.seen[key] || 0) > 1200000) { cur.seen[key] = Date.now(); out.push(text) } }
        if (G && Array.isArray(G.bangs) && Date.now() - G.t < 25 * 60000) for (const b of G.bangs) {
          if (b.kind === 'slow_job' ? (b.job && !mine(b.job)) : !general) continue
          gcond('gemba:' + b.key, b.digest)
        }
      }
      for (const pre of ['HUNG ', 'no_route ', 'STRANDED ']) { // a backlog must not push the rest out of the 25 lines: 3 of a kind, then a count
        const l = out.filter(x => x.startsWith(pre)); if (l.length <= 3) continue
        const rest = l.slice(3); for (const x of rest) out.splice(out.indexOf(x), 1)
        out.push('+' + rest.length + ' more ' + pre.trim() + ': ' + rest.map(x => x.slice(pre.length).split(' ')[0]).join(' ') + ' (details: `armyctl.js events 40 ' + pre.trim().toLowerCase() + '`)')
      }
      if (out.length && general) { // quiet good news rides along: ONE info line for everything since the last digest
        const q = tailRows(cur.quietPos, 3e6); cur.quietPos = size
        const info = infoSummary(q); if (info) out.unshift(info)
      }
      return out
    }
    for (;;) {
      const out = digest()
      if (out.length || Date.now() > end) { for (const k of Object.keys(cur.seen)) if (Date.now() - cur.seen[k] > 86400000) delete cur.seen[k]; wj(curF, cur); console.log(out.length ? out.slice(0, 25).join('\n') : 'nothing needs attention (' + maxSec + ' s)'); return }
      await sleep(5000)
    }
  } else if (cmd === 'job') {
    const b = rj(BOARD); const j = (b.jobs || []).find(x => x.id === arg); const st = process.argv[4]
    if (!j || !['active', 'paused'].includes(st)) return console.log('usage: job <id> active|paused   ids:', (b.jobs || []).map(x => x.id + '=' + x.status).join(' '))
    if (st === 'paused' && b.settings.fallback === j.id) return console.log('REFUSED: ' + j.id + ' is the FALLBACK sponge (settings.fallback) - pausing it parks the whole army at muster. Lower its `bots` or fix its handler instead.')
    j.status = st; wj(BOARD, b); console.log(j.id, '->', st)
  } else if (cmd === 'events') { // events [n] [regex|all]
    const n = +arg || 30; const flt = process.argv[4] || (arg && !+arg ? arg : ''); const fmt = (t, bot, ev, rest, extra) => console.log(new Date(t).toISOString().slice(11, 19), String(bot).padEnd(8), String(ev).padEnd(12), (extra || '') + JSON.stringify(rest).slice(0, 160))
    if (flt === 'all') { for (const r of tailRows(null, 1e6).slice(-n)) { const { t, bot, ev, ...rest } = r; fmt(t, bot, ev, rest) } return }
    const re = flt ? new RegExp(flt, 'i') : null
    const BOOKKEEPING = /^(job_slice|job_start|pockets|gaze_averted)$/ // who-took-which-job lives on the board (`field`), not here
    const SHARED = /^(job_activated|stairs_done|stair_.*|mine_.*|chest_missing|chest_full|chest_rebuilt|chest_rebuild_failed|bank_unreachable|ores_exhausted|mine_blocked|stair_broken|bed_missing|bed_replaced|spawn_set|structure_damaged|hedge_damaged|farm_degrading|crops_vanished|flood|build_stuck|build_blocked|void_under_pad|travel_fail|no_route|declined|death|banked|canteen|cooked|step|.*_pass)$/
    let rows = tailRows(null, 3e6).filter(r => r.t > Date.now() - 3600000); const all = rows.length; const t0 = rows.length ? rows[0].t : Date.now()
    rows = rows.filter(r => !BOOKKEEPING.test(r.ev) && (!re || re.test(r.ev) || re.test(r.job || '') || re.test(r.bot || '')))
    const agg = new Map()
    for (const r of rows) {
      const sig = [r.ev, r.job || '', SHARED.test(r.ev) ? '' : r.bot, String(r.why || '').replace(/[0-9]+/g, 'N').slice(0, 40), r.ev === 'step' ? r.i + ':' + r.ok : '', /^stair_/.test(r.ev) ? 'g' + r.group + (r.unrepaired ? 'U' : '') : '', r.ok === false ? 'FAIL' : '', /^(chest_|place_failed|hung|stranded|marooned)/.test(r.ev) ? String(r.at) : '', /^(no_route|travel_fail)$/.test(r.ev) ? String(r.to) : ''].join('|')
      const a = agg.get(sig) || { n: 0, bots: new Set() }; agg.delete(sig); a.n++; a.bots.add(r.bot); a.r = r; agg.set(sig, a) // re-insert: the map stays ordered by LATEST occurrence
    }
    const lines = [...agg.values()].slice(-n)
    console.log('# last ' + Math.round((Date.now() - t0) / 60000) + ' min: ' + all + ' reports -> ' + agg.size + ' distinct signatures, newest last (xN = repeats; raw tail: events ' + n + ' all; filter: events ' + n + ' <regex>)')
    for (const a of lines) { const { t, bot, ev, ...rest } = a.r; fmt(t, a.bots.size > 1 ? a.bots.size + ' bots' : bot, ev, rest, a.n > 1 ? 'x' + a.n + ' ' : '') }
    const is = infoSummary(rows); if (is && !re) console.log(is)
  } else if (!cmd || cmd === 'board') {
    try { console.log(fs.readFileSync(path.join(DIR, 'BOARD.md'), 'utf8')) } catch { let ids = 'no jobs.json - `bootstrap`'; try { ids = rj(BOARD).jobs.map(j => j.id + '=' + j.status).join(' ') } catch {} console.log('no BOARD.md yet (the dispatcher writes it on its first tick). Jobs: ' + ids) }
  } else { // --help, or a typo: the header of this file IS the help (one place to keep true)
    const head = fs.readFileSync(__filename, 'utf8').split('\n').slice(1); console.log((/^(-h|--help|help)$/.test(cmd) ? '' : 'unknown command "' + cmd + '"\n') + head.slice(0, head.findIndex(l => !l.startsWith('//'))).map(l => l.slice(3)).join('\n'))
  }
}
main()
