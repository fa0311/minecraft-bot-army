// bots/army/plan.js — THE PLAN COMPILER: ONE authoritative target for every cell of the base.
//
// WHY (owner 09-21 「土被せと道路が干渉してる / てかさっきから干渉とかどうしてそういう事が起こるわけ？ lockみたいな仕組みがないの？
// 目標のブロックが決まってないわけ？差分管理というか / 管理アルゴリズムが現実的に無理な方法で行っているのでは？」) — he is right, and the
// evidence is measured: NINE pairs of build jobs claim the same ground (fill_ravine_s x cap_base_core_pad 169 columns,
// cap_base_mine_pad x cap_base_core_pad 153, fill_ravine_s x cap_base_yard_pad 150 …) and the 20-hour dig/place war
// (`build_runaway` every few hours, docs/GOALS.md 09-21) came from exactly that: TWO JOBS WITH DIFFERENT TARGETS FOR ONE CELL.
// The cap's `only` list holds cobblestone, so it digs the fill's grade block and lays dirt; the fill's crew puts cobblestone back.
// Whoever ran last won, for ever, in a loop.
//
// LOCKS CANNOT FIX THIS. `job.noDig`, the per-column ownership in army_jobs `ownedCols()` and the blocks.js claims all answer
// "who may swing now" — a mutual-exclusion question. The question here is "what is supposed to STAND here", and two jobs each
// had a different, equally authoritative answer. A lock over contradictory specifications only picks the loop's period.
//
// THE FIX IS A COMPILER, NOT A GUARD. Every source of intent (build jobs, road segments, the base plan's zones, keep-outs) is
// expanded ONCE into cells; every contested cell is decided ONCE, at plan time, by a stated order of precedence; the loser's
// cells are REWRITTEN AWAY (a pad under a road simply ends where the road begins) or, when the two cannot be reconciled, the
// pair is reported as a PLAN ERROR for a human. Both never survive. A build job then works from `plan.diff(world, box)` —
// the cells where the WORLD does not match the TARGET — instead of from its own box, so it can no longer undo a neighbour.
//
// THE OWNER'S MATERIAL RULE (09-21) LIVES HERE, NOT IN THE JOBS: the cell a player SEES — the top of the ground, a road's
// pavement, a structure's face — carries its exact material; everything buried is `layer:'body'` and accepts ANY stone sort.
// That alone retires the whole `cap_*` class of jobs (a dirt skin laid over a finished fill by a SECOND job), which is where
// the war started: the fill's own grade cell is now `surface` = dirt, so there is nothing left for a cap to do.
//
// STORAGE (sparse, chunked, memoised — it must cover the base box without exploding memory):
//   palette   one descriptor {block, mats, owner, layer, kind, flags} per DISTINCT combination — a few hundred for the whole base
//   chunks    Map 'cx,cz' -> Map(int key -> palette index); key = ((y+128)<<8) | (lx<<4) | lz, so one int->int entry per cell
//             (~40 B in V8). The current board compiles to ~2.5e5 cells ≈ 12 MB, and a query or a diff walks only the chunks of
//             its box. Nothing stores a per-cell object.
//   ownCols   Map jobId -> Set('x,z') for `owns(jobId, x, z)` in O(1).
// Memoised on the board's mtime: a second call in the same process is free; `compile({fresh:true})` forces a re-read.
//
// THIS FILE IS A LIBRARY. It reads the board and the blueprints and touches NOTHING: no world edit, no board write, no daemon,
// no state file. Callers: ops/plan-check.js (the report), and — once wired — the `build` handler and ops/base-audit.js.
const fs = require('fs'); const path = require('path')
const DIR = __dirname
const A = require('../skills/lib/army.js')
const swallow = require('../skills/lib/swallow.js')

// ---------------------------------------------------------------- vocabulary
// A source's KIND decides precedence; a cell's LAYER decides its material rule. They are orthogonal on purpose:
// a road's pavement is kind 'road' + layer 'surface'; the rubble under it is kind 'road' + layer 'body'.
const RANK = { structure: 60, road: 50, pad: 40, fill: 30, deco: 10 }
const TERRAIN_BP = /^(level|fill_void|clear_area|quarry)$/
const ROAD_BP = /^(road|road_path|bridge)$/
// what a BODY cell accepts: any stone sort, any fill (the owner's rule — nobody sees it). Deliberately generous: the whole point
// is that a buried cell is never "wrong material" and so never worth a dig.
const BODY_OK = /^(cobblestone|cobbled_deepslate|stone|deepslate|tuff|andesite|diorite|granite|blackstone|basalt|smooth_basalt|calcite|dripstone_block|gravel|sand|red_sand|sandstone|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|terracotta|moss_block|netherrack|.*_ore|.*_bricks|.*_planks|packed_mud)$/
// the default SURFACE of the ground a player walks on (docs/WORLD.md MATERIALS: "ground = dirt/grass, never bare filler").
const SURFACE_BLOCK = 'dirt'
const SURFACE_OK = ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'farmland', 'dirt_path', 'moss_block']
// what a `natural:true` air cell (a road shoulder) may take away — everything else standing there belongs to somebody else
const NATURAL = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|stone|granite|diorite|andesite|tuff|calcite|deepslate|gravel|sand|red_sand|sandstone|terracotta|moss_block|snow|snow_block|powder_snow|short_grass|tall_grass|fern|large_fern|dead_bush|.*_ore)$/
// A block that does not COVER the cell below it (the one below is still the visible ground, i.e. still `surface`), and — in the
// diff — never something a build job may clear out of an `air` cell: our torch grid, the cane we planted, a crop, a sapling.
// (`grass_block` must NOT match: it is solid ground. An earlier /grass/ here made every cell under turf read as `surface`.)
const THIN = /^(air|cave_air|void_air|water|lava|torch|wall_torch|soul_torch|soul_fire|fire|lantern|soul_lantern|snow|ladder|lever|tripwire|vine|light|short_grass|tall_grass|fern|large_fern|dead_bush|bush|sugar_cane|bamboo|bamboo_sapling|cactus|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|sweet_berry_bush|kelp|seagrass|cobweb|scaffolding|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|wildflowers|pink_petals|leaf_litter|firefly_bush|torchflower)$|_button$|_sign$|_carpet$|_door$|_pressure_plate$|_sapling$|_tulip$|_rail$|^rail$|_banner$|_candle$/
// furniture is a STRUCTURE cell whatever blueprint placed it (a chest in a pad's footprint is not ground)
const FURNITURE = /_bed$|^(chest|trapped_chest|barrel|furnace|smoker|blast_furnace|crafting_table|enchanting_table|bookshelf|anvil|campfire|lantern|torch)$/

const box4 = b => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]
const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
const ck = (x, z) => (x >> 4) + ',' + (z >> 4)
const cellKey = (x, y, z) => (((y + 128) << 8) | ((x & 15) << 4) | (z & 15))

// ONE cell loader. army_jobs' `blueprintCells` adds the PAD RULE (footprint+1 ground layer + 4 headroom) that the build job
// really works from, so the compiler must see the same cells; it is required LAZILY so that army_jobs may one day require this
// file at load time without a circular half-initialised module. Fallback: the raw blueprint (lib/army.js), the ONE loader.
function cellsOf (params) {
  try { const J = require('../skills/lib/army_jobs.js'); if (J._internals && J._internals.blueprintCells) return J._internals.blueprintCells(params).slice() } catch (e_) { swallow('plan:cellsOf', e_) }
  return A.blueprintCellsOf(params, true)
}

// ---------------------------------------------------------------- sources of intent
// Everything that says what SHOULD stand somewhere. One shape: {id, owner, kind, dim, blueprint, params, priority, status, zone}.
function sourcesOf (board, opt) {
  const dim = opt.dim || 'overworld'; const out = []
  // THE PLAN IS BIGGER THAN THE BOARD. `prune` archives a finished one-off job, but the hall it built still stands and is still
  // the authoritative target for its cells (ops/base-audit.js reads the same archive, and a damaged structure's own job is
  // re-activated as the repair). A target map that forgot them would call every finished wall "stray".
  const jobs = (board.jobs || []).slice(); const known = new Set(jobs.map(j => j.id))
  if (opt.archive !== false) {
    try {
      for (const l of fs.readFileSync(path.join(DIR, 'jobs-archive.jsonl'), 'utf8').split('\n')) {
        if (!l) continue
        try { const j = JSON.parse(l); if (j && j.type === 'build' && j.params && j.params.blueprint && Array.isArray(j.params.origin) && !known.has(j.id)) { known.add(j.id); jobs.push(Object.assign({}, j, { status: 'done' })) } } catch (e_) { swallow('plan:archiveLine', e_) }
      }
    } catch (e_) { swallow('plan:archive', e_) }
  }
  for (const j of jobs) {
    if ((j.dim || 'overworld') !== dim) continue
    const p = j.params || {}
    if (j.type === 'build' && p.blueprint && Array.isArray(p.origin)) {
      out.push({ id: j.id, owner: j.id, job: j, kind: kindOf(p), blueprint: String(p.blueprint), params: p, priority: j.priority || 0, status: j.status || 'paused', zone: zoneOf(j) })
    } else if (j.type === 'road' && Array.isArray(p.segments)) {
      // a road is designed by ops/road-plan.js as straight segments, each at ONE height, and built cell by cell from the `road`
      // blueprint (jobs_road.js `argsOf`): one source per segment, all owned by the road job.
      for (const s of p.segments) {
        if (!Array.isArray(s.origin)) continue
        const args = s.args || { toX: s.to && s.to[0], toZ: s.to && s.to[2], width: p.width || 5, block: p.block || 'stone', clear: 3, torchEvery: 8, shoulder: p.spur ? 1 : 2 }
        out.push({ id: j.id + '#' + s.i, owner: j.id, job: j, kind: 'road', blueprint: 'road', params: { blueprint: 'road', origin: s.origin, args, pad: false }, priority: j.priority || 0, status: j.status || 'paused', zone: zoneOf(j) })
      }
    }
  }
  return out
}
// KIND = precedence class. A `cap:true` level job is DECO (a skin laid over somebody else's finished ground) — the class the
// material rule retires; a plain `level` is the pad; fill_void/clear_area/quarry move terrain; everything else is a structure.
function kindOf (p) {
  const bp = String(p.blueprint)
  if (ROAD_BP.test(bp)) return 'road'
  if (bp === 'level') return (p.args || {}).cap ? 'deco' : 'pad'
  if (TERRAIN_BP.test(bp)) return 'fill'
  return 'structure'
}
function zoneOf (j) { const m = /zone ([a-z0-9_ ]+?)(?: x |:|,)/i.exec(String(j.plan || '')); return (m && m[1].trim()) || j.front || 'other' }

// ---------------------------------------------------------------- the compiler
let _memo = null
function compile (opt = {}) {
  const file = opt.board || A.F.board
  const board = A.readJSON(file, {}) || {}
  // The dispatcher rewrites jobs.json every few seconds, so an mtime key would throw the memo away on every call and cost 2 s
  // per bot loop. The signature is what the PLAN actually depends on: the build/road jobs' geometry and the keep-outs.
  const sig = JSON.stringify([
    (board.jobs || []).filter(j => j.type === 'build' || j.type === 'road').map(j => [j.id, j.type, j.status, j.priority, j.dim, j.after, j.plan, j.front, j.params]),
    (board.settings || {}).keepOut, (board.settings || {}).base,
    (() => { try { return fs.statSync(path.join(DIR, 'jobs-archive.jsonl')).size } catch { return 0 } })()
  ])
  const key = JSON.stringify([file, opt.dim || 'overworld', opt.box || null, opt.includePaused !== false, opt.archive !== false]) + '|' + sig
  if (!opt.fresh && _memo && _memo.key === key) return _memo.plan
  const plan = build(board, file, opt, key)
  _memo = { key, plan }
  return plan
}

function build (board, file, opt, key) {
  const S = board.settings || {}
  const keepOut = (S.keepOut || []).filter(k => k && Array.isArray(k.box)).map(k => ({ id: k.id, box: box4(k.box), why: k.why || '' }))
  const src = sourcesOf(board, opt).filter(s => opt.includePaused === false ? s.status === 'active' : true)
  const limit = opt.box ? box4(opt.box) : null

  // ---- pass 0: expand every source once, remember its footprint (for tie-breaks and for the overlap report)
  const cells = []           // per source: the raw cell list
  src.forEach((s, i) => { s.i = i })
  for (const s of src) {
    let cs = []
    try { cs = cellsOf(s.params) } catch (e) { s.error = String(e.message).slice(0, 90); cs = [] }
    if (limit) cs = cs.filter(c => c.x >= limit[0] && c.x <= limit[2] && c.z >= limit[1] && c.z <= limit[3])
    // A FINISHED EXCAVATION IS NOT A STANDING ORDER TO KEEP DIGGING. The two day-one quarries and the terrace cuts are archived
    // `quarry`/`clear_area`/`fill_void` jobs whose cells are AIR; the world has since grown grass over them and the ravine fill
    // is closing them on purpose. Their air cells are dropped (measured: 67 `extra` grass columns ordered dug by quarry_ne).
    // A finished PAD or STRUCTURE keeps its air: headroom over a hall and the inside of a building must stay clear for ever.
    if (!s.live && s.kind === 'fill') cs = cs.filter(c => c.block !== 'air')
    let x1 = Infinity; let z1 = Infinity; let x2 = -Infinity; let z2 = -Infinity; const cols = new Set()
    for (const c of cs) { if (c.x < x1) x1 = c.x; if (c.x > x2) x2 = c.x; if (c.z < z1) z1 = c.z; if (c.z > z2) z2 = c.z; cols.add(c.x + ',' + c.z) }
    s.n = cs.length; s.rect = cs.length ? [x1, z1, x2, z2] : null; s.area = cs.length ? (x2 - x1 + 1) * (z2 - z1 + 1) : 0; s.cols = cols.size
    s.rank = RANK[s.kind]; s.live = s.status !== 'done'
    cells.push(cs)
  }

  // ---- pass 1: RESOLVE. One winner per cell, by the stated order of precedence. Nothing is decided later, in the field.
  // value packed as (sourceIndex << 12) | variantIndex — one int per cell, no per-cell object.
  const chunks = new Map()
  const variants = src.map(() => ({ list: [], ix: new Map() }))
  const contest = new Map()  // 'ownerA|ownerB' -> {cells, disagree, cols:Set, at}
  const claims = new Map()   // only CONTESTED cells: 'cx,cz:cellKey' -> [sourceIndex …]
  const vIx = (si, c) => {
    const V = variants[si]; const k = c.block + '|' + ((c.mats || []).join(',')) + '|' + (c.fillOnly ? 'f' : '') + (c.solid ? 's' : '') + (c.natural ? 'n' : '') + (c.only ? 'o' + c.only.length : '')
    let i = V.ix.get(k); if (i === undefined) { i = V.list.length; if (i > 4095) throw new Error('plan: blueprint ' + src[si].blueprint + ' has more than 4096 distinct cell kinds — widen the packed value'); V.list.push(c); V.ix.set(k, i) } return i
  }
  // TWO JOBS ON ONE CELL is normal (a pad under a hall); TWO JOBS WITH DIFFERENT TARGETS ON ONE CELL is the war. `agree` is the
  // symmetric test: each side's accept set must contain the other's block. cap(dirt|grass family) x fill(cobble|stone family)
  // fails it in both directions — that is the pair that dug and placed the same cell for 20 hours.
  const acc = c => new Set([c.block].concat(c.mats || []))
  const agree = (p, q) => (p.block === 'air') === (q.block === 'air') && (p.block === 'air' || (acc(p).has(q.block) && acc(q).has(p.block)))
  const note = (a, b, c, ok) => { // a's cell lost to b's at cell c
    if (a.owner === b.owner) return // segments of ONE road share their joint columns by design: that is a ramp, not a conflict
    const k = a.owner + '|' + b.owner; let e = contest.get(k)
    if (!e) { e = { a: a.owner, b: b.owner, ka: a.kind, kb: b.kind, za: a.zone, zb: b.zone, live: a.live && b.live, chain: chained(a.owner, b.owner), cells: 0, disagree: 0, cols: new Set(), sample: [c.x, c.y, c.z], at: null }; contest.set(k, e) }
    e.cells++; e.cols.add(c.x + ',' + c.z); if (!ok) { e.disagree++; if (!e.at) e.at = [c.x, c.y, c.z] }
  }
  // A PAD AND THE THING BUILT ON IT ARE NOT RIVALS. `plan-base` chains them (`after`) and names them `<zone>_pad` -> `<zone>`:
  // the pad's headroom exists so the wall can stand there. Such a pair overlaps by design; only UNCHAINED pairs are the war.
  const afterOf = new Map(); for (const j of (board.jobs || [])) if (j.after) afterOf.set(j.id, j.after)
  function chained (a, b) {
    const up = id => { const out = new Set(); let c = id; for (let i = 0; i < 12 && afterOf.get(c); i++) { c = afterOf.get(c); out.add(c) } return out }
    if (up(a).has(b) || up(b).has(a)) return true
    return a.replace(/_pad$/, '') === b.replace(/_pad$/, '') // `<zone>_pad` -> `<zone>` (a cap_* is NOT a chain: it is a second, contradictory spec for the same ground)
  }
  for (let si = 0; si < src.length; si++) {
    for (const c of cells[si]) {
      const k = ck(c.x, c.z); let m = chunks.get(k); if (!m) { m = new Map(); chunks.set(k, m) }
      const ckey = cellKey(c.x, c.y, c.z); const pk = (si << 12) | vIx(si, c); const cur = m.get(ckey)
      if (cur === undefined) { m.set(ckey, pk); continue }
      // EVERY claimant of a contested cell is kept (a list only for cells that have more than one), so the overlap report can
      // name ALL the pairs. Without it a third job hides the pair that started the war: cap_base_core_pad lost its cells to
      // road_mine first, and its real opponent fill_ravine_s never appeared in the report at all.
      const id = k + ':' + ckey; const cl = claims.get(id); if (cl) cl.push(pk); else claims.set(id, [cur, pk])
      if (winner(src[cur >>> 12], src[si]) === si) m.set(ckey, pk)
    }
  }
  // the order of precedence, in one place. structure > road > pad/level > terrain fill > decoration; inside a rank the board's
  // own priority decides, then the SMALLER footprint (the more specific plan), then the id — so the answer never depends on the
  // order the jobs happen to stand in on the board.
  function winner (a, b) { // returns the index of the winner (a.i / b.i are set below)
    if (a.rank !== b.rank) return a.rank > b.rank ? a.i : b.i
    // THE BOARD IS THE PRESENT TENSE, the archive only remembers. Within one rank a LIVE terrain job beats a finished one:
    // the two day-one quarry pits are archived `quarry` jobs whose cells are AIR, and fill_ravine_s exists precisely to fill
    // them (docs/WORLD.md) - without this rule 2052 cells of the ravine fill were "owned" by a pit nobody wants any more.
    // STRUCTURES are not remediable that way: a live building inside a finished building is a planning mistake, so they keep
    // the priority tie-break and the pair is reported as a `buried` plan error for a human.
    if (a.kind !== 'structure' && a.live !== b.live) return a.live ? a.i : b.i
    if ((a.priority || 0) !== (b.priority || 0)) return (a.priority || 0) > (b.priority || 0) ? a.i : b.i
    if (a.area !== b.area) return a.area < b.area ? a.i : b.i
    return a.id <= b.id ? a.i : b.i
  }
  // every PAIR of claimants on every contested cell (not just the one that happened to be incumbent)
  for (const [id, list] of claims) {
    const cs = id.split(':'); const ckey = +cs[1]; const cc = cs[0].split(',').map(Number)
    const y = (ckey >>> 8) - 128; const x = (cc[0] << 4) + ((ckey >>> 4) & 15); const z = (cc[1] << 4) + (ckey & 15); const at = { x, y, z }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const ai = list[i] >>> 12; const bi = list[j] >>> 12; if (ai === bi) continue
      const ca = variants[ai].list[list[i] & 4095]; const cb = variants[bi].list[list[j] & 4095]
      const w = winner(src[ai], src[bi]) === bi ? [ai, bi] : [bi, ai]
      note(src[w[0]], src[w[1]], at, agree(ca, cb))
    }
  }

  // ---- pass 2: LAYER + MATERIAL. A cell is `structure` when a blueprint face or furniture stands there, `body` when another
  // solid target covers it, else `surface`. Only surface and structure carry an exact material; body accepts any stone sort.
  const pal = []; const palIx = new Map()
  const P = (d) => { const k = d.block + '|' + d.layer + '|' + d.owner + '|' + d.kind + '|' + (d.mats || []).join(',') + '|' + (d.natural ? 'n' : '') + (d.fillOnly ? 'f' : ''); let i = palIx.get(k); if (i === undefined) { i = pal.length; pal.push(d); palIx.set(k, i) } return i }
  const ownCols = new Map(); const perSource = src.map(() => ({ cells: 0, surface: 0, body: 0, structure: 0, air: 0, rewrote: 0 }))
  // is the cell ABOVE covered by a solid target? (same x,z = the same chunk map, still raw while this pass reads it)
  const covers = (m, x, y, z) => { const v = m.get(cellKey(x, y + 1, z)); if (v === undefined) return false; return !THIN.test(variants[v >>> 12].list[v & 4095].block) }
  let total = 0
  for (const [k, m] of chunks) {
    const out = new Map()
    for (const [ckey, v] of m) {
      const si = v >>> 12; const c = variants[si].list[v & 4095]; const s = src[si]
      const y = (ckey >>> 8) - 128; const x = (parseInt(k.split(',')[0], 10) << 4) + ((ckey >>> 4) & 15); const z = (parseInt(k.split(',')[1], 10) << 4) + (ckey & 15)
      let layer; let block = c.block; let mats = c.mats || null
      const ground = SURFACE_OK.includes(c.block) && !FURNITURE.test(c.block)
      if (c.block === 'air') { layer = 'none'; mats = null } else if ((s.kind === 'structure' || FURNITURE.test(c.block)) && !(ground && !covers(m, x, y, z))) {
        layer = 'structure' // a structure's SOIL cell that nothing covers is the ground a player walks on, not a face: it falls through to `surface`
        // (measured: the tree farm's 2070 `dirt` floor cells read as "wrong material" against the grass_block that grew on them)
      } else if (covers(m, x, y, z)) {
        layer = 'body'; block = c.block; mats = null                            // the material rule: buried = ANY stone sort
      } else {
        // THE REWRITE THAT RETIRES cap_*: a terrain job's TOP cell is what a player sees, so it carries the GROUND material
        // here, in the map — not through a second job laying a dirt skin over the first job's finished cobble (that pair is
        // the whole `cap_* x fill_*` war). A source that already named its own visible top keeps it.
        layer = 'surface'
        if (s.kind === 'road') mats = c.mats || [block]                      // pavement: the road standard's own block
        else if (c.only) mats = c.mats || SURFACE_OK                         // `level cap`: the blueprint already names the skin
        else if (c.mats && c.mats.length === 1) mats = c.mats                // `fill_void params.top`
        else if (!SURFACE_OK.includes(block)) { block = SURFACE_BLOCK; mats = SURFACE_OK; perSource[si].rewrote++ }
        else mats = SURFACE_OK
      }
      const d = { block, mats, owner: s.owner, src: s.id, kind: s.kind, layer, natural: !!c.natural, fillOnly: !!c.fillOnly }
      out.set(ckey, P(d))
      perSource[si].cells++; perSource[si][layer === 'none' ? 'air' : layer]++
      let cs = ownCols.get(s.owner); if (!cs) { cs = new Set(); ownCols.set(s.owner, cs) } cs.add(x + ',' + z)
      total++
    }
    chunks.set(k, out)
  }
  src.forEach((s, i) => { s.stats = perSource[i] })

  // ---- PLAN ERRORS: what precedence cannot reconcile, and what a human must decide.
  const errors = []; const overlaps = []
  const left = new Map(); for (const s of src) left.set(s.owner, (left.get(s.owner) || 0) + s.stats.cells)
  const had = new Map(); for (const s of src) had.set(s.owner, (had.get(s.owner) || 0) + s.n)
  for (const e of contest.values()) {
    overlaps.push({ loser: e.a, winner: e.b, cells: e.cells, disagree: e.disagree, columns: e.cols.size, at: e.at || e.sample, ka: e.ka, kb: e.kb, kinds: e.ka + ' < ' + e.kb, zones: e.za + ' / ' + e.zb, live: e.live, chain: e.chain, lostAll: left.get(e.a) === 0, resolution: resolutionText(e) })
  }
  // worst first: a LIVE, UNCHAINED pair that disagrees about a block is a dig/place war on the board right now
  const war = o => (o.live ? 2 : 0) + (o.chain ? 0 : 1)
  overlaps.sort((p, q) => war(q) - war(p) || q.disagree - p.disagree || q.columns - p.columns || q.cells - p.cells)
  // 1. TWO HEIGHTS FOR ONE COLUMN. "One site = ONE height" (CLAUDE.md §1b). Two terrain sources whose surface cells sit at
  //    different y in the same column cannot both be right, whatever wins: the loser's crew will keep finding the ground wrong.
  const gradeOf = new Map()   // 'x,z' -> Map(owner -> top y of its solid cells)
  for (let si = 0; si < src.length; si++) {
    if (src[si].kind === 'structure' || !src[si].live) continue
    for (const c of cells[si]) { if (c.block === 'air') continue; const k = c.x + ',' + c.z; let m = gradeOf.get(k); if (!m) { m = new Map(); gradeOf.set(k, m) } const cur = m.get(src[si].owner); if (cur === undefined || c.y > cur) m.set(src[si].owner, c.y) }
  }
  const grade = new Map()
  for (const [k, m] of gradeOf) {
    if (m.size < 2) continue
    const ys = [...m.entries()]
    for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) {
      if (ys[i][1] === ys[j][1]) continue
      const id = [ys[i][0], ys[j][0]].sort().join(' x ')
      let g = grade.get(id); if (!g) { g = { a: ys[i][0], b: ys[j][0], dy: Math.abs(ys[i][1] - ys[j][1]), columns: 0, at: k.split(',').map(Number), ys: [ys[i][1], ys[j][1]] }; grade.set(id, g) }
      g.columns++; g.dy = Math.max(g.dy, Math.abs(ys[i][1] - ys[j][1]))
    }
  }
  // dy >= 2 is always a plan error; a 1-block step is a junction ramp until it covers a whole shared area (>= 8 columns)
  for (const g of grade.values()) if (!chained(g.a, g.b) && (g.dy >= 2 ? g.columns >= (opt.minGrade || 4) : g.columns >= 8)) errors.push({ kind: 'grade_conflict', a: g.a, b: g.b, columns: g.columns, at: g.at, why: g.a + ' wants the ground at y' + g.ys[0] + ' and ' + g.b + ' at y' + g.ys[1] + ' in ' + g.columns + ' shared columns (one site = ONE height): re-site one of them, cut its box, or make the step a planned ramp' })
  // 2. SAME PRECEDENCE, DIFFERENT TARGET — nobody outranks anybody, so the compiler decides on footprint/id alone and a human
  //    should say which box is wrong. Only pairs that actually DISAGREE about a block count (a shared cell both want identical
  //    is harmless duplication).
  for (const o of overlaps) {
    if (o.ka !== o.kb || o.chain || !o.live || !o.disagree || o.disagree < (opt.minCells || 8)) continue
    errors.push({ kind: 'same_rank', a: o.loser, b: o.winner, columns: o.columns, at: o.at, why: 'same precedence class (' + o.ka + ') and ' + o.disagree + ' cells where the two want DIFFERENT blocks — decided only by footprint/id; one of the two boxes is wrong' })
  }
  // 3. A STRUCTURE OR ROAD PLANNED INSIDE A KEEP-OUT (the ravine, the pond): plan-base lays the lattice around them for a reason.
  for (const s of src) {
    if (!s.rect || !s.live || s.kind === 'fill' || s.kind === 'pad') continue
    for (const k of keepOut) if (overlap(s.rect, k.box)) errors.push({ kind: 'keepout', a: s.id, b: k.id, at: [k.box[0], 0, k.box[1]], why: s.kind + ' ' + s.id + ' is planned inside keep-out ' + k.id + ' — ' + String(k.why).slice(0, 80) })
  }
  // 4. SUBSUMED: a job with (next to) nothing left of its own. Not an error — an ACTION: take it off the board.
  const subsumed = []
  for (const [owner, n] of had) {
    const s0 = src.find(q => q.owner === owner); if (!s0 || !s0.live) continue // a finished job has nothing to take off the board
    const lf = left.get(owner) || 0; if (!(n > 0 && lf < 0.05 * n)) continue
    const by = [...new Set(overlaps.filter(o => o.loser === owner).map(o => o.winner))]
    // A CAP with nothing left is the material rule doing its job: strike it off the board. A real job buried under FINISHED
    // work is something else — somebody planned a building inside a building, and a human has to say which one is wrong.
    const buried = s0.kind !== 'deco' && by.every(id => { const q = src.find(r => r.owner === id); return q && !q.live })
    subsumed.push({ id: owner, kind: s0.kind, status: s0.status, had: n, left: lf, by: by.slice(0, 4), verdict: buried ? 'plan error' : 'remove', why: lf === 0 ? 'every cell belongs to a higher-precedence plan' : '95 %+ of its cells belong to a higher-precedence plan' })
    if (buried) errors.push({ kind: 'buried', a: owner, b: by[0], at: s0.rect ? [s0.rect[0], 0, s0.rect[1]] : null, why: owner + ' (' + s0.kind + ', ' + n + ' cells) lies entirely inside FINISHED work (' + by.slice(0, 3).join(', ') + '): it can never build anything — re-site it or take it off the board' })
  }

  return {
    key, file, dim: opt.dim || 'overworld', t: Date.now(), settings: S, keepOut, sources: src, chunks, pal, variants, cellCount: total, chunkCount: chunks.size,
    box: src.reduce((a, s) => s.rect ? (a ? [Math.min(a[0], s.rect[0]), Math.min(a[1], s.rect[1]), Math.max(a[2], s.rect[2]), Math.max(a[3], s.rect[3])] : s.rect.slice()) : a, null),
    overlaps, errors, subsumed, ownCols,
    at (x, y, z) { const m = chunks.get(ck(x, z)); if (!m) return null; const v = m.get(cellKey(x, y, z)); return v === undefined ? null : pal[v] },
    owns (jobId, x, z) { const s = ownCols.get(jobId); return !!s && s.has(x + ',' + z) },
    ownerAt (x, z) { const m = chunks.get(ck(x, z)); if (!m) return null; let best = null; let by = -1e9; for (const [k, v] of m) { const y = (k >>> 8) - 128; if (((k >>> 4) & 15) !== (x & 15) || (k & 15) !== (z & 15)) continue; if (y > by && pal[v].layer !== 'none') { by = y; best = pal[v] } } return best },
    lock (cells, who, ms, o) { return lock(this, cells, who, ms, o) },
    lockStanding (bot, o) { return lockStanding(this, bot, o) },
    release, releaseAll, lockedBy, persistent,
    inKeepOut (x, z) { for (const k of keepOut) if (x >= k.box[0] && x <= k.box[2] && z >= k.box[1] && z <= k.box[3]) return k.id; return null },
    cells: function * (b) { const B = b ? box4(b) : null; for (const [k, m] of chunks) { const [cx, cz] = k.split(',').map(Number); if (B && !overlap([cx << 4, cz << 4, (cx << 4) + 15, (cz << 4) + 15], B)) continue; for (const [key2, v] of m) { const y = (key2 >>> 8) - 128; const x = (cx << 4) + ((key2 >>> 4) & 15); const z = (cz << 4) + (key2 & 15); if (B && (x < B[0] || x > B[2] || z < B[1] || z > B[3])) continue; yield { x, y, z, t: pal[v] } } } },
    diff (world, b, o) { return diff(this, world, b, o || {}) }
  }
}
function resolutionText (e) {
  if (e.ka === 'deco') return e.a + ' (cap) drops ' + e.cells + ' cells: ' + e.b + ' owns this ground and its OWN top cell is now the visible surface — the cap has nothing to lay'
  if (e.ka === 'pad' && e.kb === 'road') return e.a + ' ends where ' + e.b + ' begins (' + e.cols.size + ' columns): the pad is rewritten to the road edge'
  if (e.kb === 'structure') return e.a + ' yields ' + e.cells + ' cells under ' + e.b + ' (a structure outranks terrain); it keeps the rest of its box'
  return e.a + ' yields ' + e.cells + ' cells to ' + e.b + ' (' + e.ka + ' < ' + e.kb + ')'
}

// ---------------------------------------------------------------- THE DIFF: what a build job should work from
// `world(x, y, z)` -> block name, or null/undefined when the chunk is not loaded (the SkyEye camera's `name()` and a bot's
// `blockAt().name` both fit). Classification is the whole point: a build job that works from THIS never digs a cell that is
// already right, and never digs a cell that belongs to somebody else — the cell simply is not in its list.
function diff (plan, world, b, opt = {}) {
  const counts = { missing: 0, wrong: 0, extra: 0, ok: 0, unknown: 0 }
  const byOwner = new Map(); const byZone = new Map(); const out = []
  const cap = opt.max || 200000
  const zoneFor = id => { const s = plan.sources.find(q => q.owner === id); return s ? s.zone : 'other' }
  for (const c of plan.cells(b)) {
    const t = c.t
    if (opt.owner && t.owner !== opt.owner) continue
    let have
    try { have = world(c.x, c.y, c.z) } catch (e_) { have = null }
    let how
    if (have === null || have === undefined) how = 'unknown'
    // AN AIR CELL IS NOT A LICENCE TO CLEAR. Our own torch grid, the cane we planted and every crop stand in `air` cells of a
    // pad's headroom; a build job working from this list would have dug them out (measured: 804 `extra` cane cells under
    // base_cane's own clear layer, torches under every infill tile). Only a real placed BLOCK counts as extra — and on a road
    // shoulder (`natural:true`) only natural ground does.
    else if (t.layer === 'none') how = (t.natural ? NATURAL.test(have) : !THIN.test(have) && !FURNITURE.test(have)) ? 'extra' : 'ok'
    else if (have === 'air' || have === 'cave_air' || have === 'void_air') how = 'missing'
    else if (accepts(t, have)) how = 'ok'
    else how = t.fillOnly && t.layer === 'body' ? 'ok' : 'wrong'
    counts[how]++
    const bo = byOwner.get(t.owner) || { missing: 0, wrong: 0, extra: 0, ok: 0, unknown: 0 }; bo[how]++; byOwner.set(t.owner, bo)
    const zk = zoneFor(t.owner); const bz = byZone.get(zk) || { missing: 0, wrong: 0, extra: 0, ok: 0, unknown: 0 }; bz[how]++; byZone.set(zk, bz)
    if (how !== 'ok' && how !== 'unknown' && out.length < cap) out.push({ x: c.x, y: c.y, z: c.z, want: t.block, have, how, owner: t.owner, layer: t.layer })
  }
  return { counts, byOwner: Object.fromEntries(byOwner), byZone: Object.fromEntries(byZone), cells: out }
}
// THE MATERIAL RULE, in one function. surface/structure = exact (or an accepted substitute the blueprint named: wood species,
// bed colours, soil family); body = any stone sort, nobody will ever see it.
function accepts (t, have) {
  if (t.layer === 'body') return BODY_OK.test(have)
  if (t.block === have) return true
  if (t.mats && t.mats.includes(have)) return true
  if (t.layer === 'surface' && SURFACE_OK.includes(t.block) && SURFACE_OK.includes(have)) return true
  return false
}

// ---------------------------------------------------------------- CELL LEASES (owner 09-21 「ブロック単位のロックを行うことで帰り道を
// 他のbotが塞ぐことが防げるのではないか？」) — the second half of the answer. The target map says WHAT belongs in a cell; a lease says
// "for the next few minutes this cell is MINE — not to build, but to stay alive". Kokoro was buried under 19 blocks this morning
// because a mate's fill closed the column she was standing in and the shaft she came down; a crew would have died the same way.
//
// ONE IMPLEMENTATION: leases are written into the SAME per-cell lock files blocks.js already checks before every place and dig
// (`bots/.blocklocks/<x>_<y>_<z>`, content `who <expiryMs>`). No new state file, no new directory, and no patch to blocks.js —
// every placeBlock/digBlock in the army already refuses a cell another bot holds. A lease is just a longer, deliberate one.
// LIMITS (a bot cannot lock the world): at most 64 cells per call, at most 10 minutes, and only cells that HAVE a target in the
// map or lie within 6 blocks of the holder — the way out of a hole is always both. Leases expire by themselves; `releaseAll`
// clears a dead bot's (core/recover.js calls it on death), and a stale file is stolen by blocks.js exactly as before.
const LOCKS = path.join(DIR, '..', '.blocklocks')
const lockPath = (x, y, z) => path.join(LOCKS, x + '_' + y + '_' + z)
const nameOf = who => typeof who === 'string' ? who : (who && who.username) || 'unknown'
const MAX_CELLS = 64; const MAX_MS = 600000
function lock (plan, cells, who, ms = 60000, opt = {}) {
  const me = nameOf(who); const until = Date.now() + Math.min(ms, MAX_MS)
  const near = opt.near || (typeof who === 'object' && who && who.entity ? who.entity.position.floored() : null)
  const got = []; const refused = []
  try { fs.mkdirSync(LOCKS, { recursive: true }) } catch (e_) { swallow('plan:lockDir', e_) }
  for (const c of cells.slice(0, MAX_CELLS)) {
    const [x, y, z] = Array.isArray(c) ? c : [c.x, c.y, c.z]
    const inMap = !!(plan && plan.at(x, y, z))
    const close = near && Math.abs(near.x - x) <= 6 && Math.abs(near.y - y) <= 6 && Math.abs(near.z - z) <= 6
    if (!inMap && !close) { refused.push({ at: [x, y, z], why: 'outside the plan and more than 6 blocks from the holder' }); continue }
    const f = lockPath(x, y, z)
    try {
      let holder = null
      try { const s = fs.readFileSync(f, 'utf8').split(' '); if (+s[1] > Date.now()) holder = s[0] } catch (e_) { holder = null }
      if (holder && holder !== me) { refused.push({ at: [x, y, z], why: 'held by ' + holder }); continue }
      fs.writeFileSync(f, me + ' ' + until)
      got.push([x, y, z])
    } catch (e_) { swallow('plan:lock', e_); refused.push({ at: [x, y, z], why: 'fs' }) }
  }
  return { ok: refused.length === 0, got, refused, until }
}
function release (cells, who) {
  const me = nameOf(who); let n = 0
  for (const c of cells || []) {
    const [x, y, z] = Array.isArray(c) ? c : [c.x, c.y, c.z]; const f = lockPath(x, y, z)
    try { if (fs.readFileSync(f, 'utf8').split(' ')[0] === me) { fs.unlinkSync(f); n++ } } catch (e_) { /* gone or another holder */ }
  }
  return n
}
function releaseAll (who) { // a dead bot holds nothing (call it from the death handler; leases expire on their own anyway)
  const me = nameOf(who); let n = 0
  try { for (const f of fs.readdirSync(LOCKS)) { const p = path.join(LOCKS, f); try { if (fs.readFileSync(p, 'utf8').split(' ')[0] === me) { fs.unlinkSync(p); n++ } } catch (e_) { swallow('plan:releaseAllFile', e_) } } } catch (e_) { swallow('plan:releaseAll', e_) }
  return n
}
function lockedBy (x, y, z) { try { const s = fs.readFileSync(lockPath(x, y, z), 'utf8').split(' '); return +s[1] > Date.now() ? s[0] : null } catch (e_) { return null } }
// THE WAY OUT IS NOT WORK — IT IS SURVIVAL. The column a bot stands in plus the shaft it climbs: leased in one call so no mate's
// fill, deck or cap can close it (docs/DEV.md `cavity`: "THE WAY OUT IS THE SHAFT YOU ARE FILLING UPWARD").
function lockStanding (plan, bot, opt = {}) {
  const p = bot.entity.position.floored(); const up = opt.up == null ? 3 : opt.up; const down = opt.down == null ? 1 : opt.down
  const cells = []; for (let dy = -down; dy <= up; dy++) cells.push([p.x, p.y + dy, p.z])
  for (const c of opt.shaft || []) cells.push(c)
  return lock(plan, cells, bot, opt.ms || 120000, { near: p })
}

// ---------------------------------------------------------------- THE DIFF IS ALSO THE REPAIR ORDER (owner 09-21
// 「全てを目標ブロックに記録することでアルゴリズムのミスで壊れた部分もすぐに修復できるのではないか？」): once every cell's intended block is on
// record, damage needs no special audit. A dig/place loop, a fill that ate a road, a creeper, a lava flow — all of them show up
// as the same three classes (missing / wrong / extra) and are repaired by the same crews that built the place. What a repair
// must NOT do is retry for ever: `persistent(prev, cur)` names the cells that were reported wrong in the previous pass AND in
// this one, i.e. the ones a crew has already failed to fix. Those are escalated (docs/BUGS.md), never handed out again.
function persistent (prev, cur) {
  const seen = new Map(); for (const c of (prev && prev.cells) || []) seen.set(c.x + ',' + c.y + ',' + c.z, c.how)
  return ((cur && cur.cells) || []).filter(c => seen.get(c.x + ',' + c.y + ',' + c.z) === c.how)
}

// a world reader for a live bot (read-only; unloaded -> null so the diff says `unknown`, never `missing`)
function botWorld (bot) { const { Vec3 } = require('vec3'); return (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b ? b.name : null } }

module.exports = { compile, diff, accepts, botWorld, lock, release, releaseAll, lockedBy, lockStanding, persistent, RANK, BODY_OK, SURFACE_OK, SURFACE_BLOCK, kindOf, cellsOf }
