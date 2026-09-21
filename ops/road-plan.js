#!/usr/bin/env node
// ops/road-plan.js — DESIGN A TRUNK ROAD FROM THE CAMERA (owner 09-21 「幹線道路という仕組みを強化し…skyeyeでの緻密な設計が必要」).
//
//   node ops/road-plan.js <fromX,fromZ> <toX,toZ> [--id <name>] [--width 5] [--dim the_nether]
//                         [--half 64] [--survey /tmp/f.json] [--out /tmp/road-<id>.png] [--spur] [--put]
//
// It does NOT draw a line between two points. It LOOKS first: the spectator camera `SkyEye` (ops/skyshot.js `fly`) reads the real
// ground height of every column of the corridor at step 1, then an A* over that grid picks the line a road builder would pick —
// follow the contour, at most 1 block of climb per step, never through a keep-out or a zone, water/ravine crossed by a BRIDGE
// segment, a hill cut only when going round costs more earth than going through. The output is a `road` job (type `road`,
// bots/skills/lib/jobs_road.js) whose SEGMENTS are each straight and at ONE height, an ASCII profile, and a picture to READ.
//
// WHY A GRID AND NOT A STRAIGHT LINE (measured): the village trade route is 624 blocks and 5 of every 6 trip-minutes are walking
// (docs/INDUSTRY.md); the `no_route` storms of 09-19/20 came from terrain nobody prepared — 366 in 30 min from ONE 3-deep pit.
// A road is only worth its stone if a bot can walk it end to end with canDig:false, and that is a property of the TERRAIN, not
// of the drawing. So the terrain decides the line and the tool prints what it decided.
//
// COST MODEL (one block stepped): 1 + earth(|Δground|) + kind + turn. earth(0)=0, 1=1.2, 2=5, 3=12, >3=30+ — so the route buys a
// 12-block detour rather than a 3-block cut, which is what a player does. Water/void = 10 (a bridge is real work). Lava, a
// keep-out, an unreadable column, or a structure of ours = refused.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const ROOT = '/root/workspace'
const NM = ROOT + '/bots/node_modules/'
const sky = require(ROOT + '/ops/skyshot.js')

// ---------------------------------------------------------------- what is NOT ground (a road follows the soil, not the canopy)
const FOLIAGE = /(_leaves|_log|_wood|_stem|_hyphae|_sapling|_mushroom|_mushroom_block|_flower|_tulip|_carpet|_banner|_sign|_button|_pressure_plate|_slab|_wall|_fence|_fence_gate)$/
const PLANT = /^(air|cave_air|void_air|snow|powder_snow|short_grass|tall_grass|short_dry_grass|tall_dry_grass|fern|large_fern|dead_bush|bush|firefly_bush|wildflowers|pink_petals|leaf_litter|vine|glow_lichen|sugar_cane|cactus|bamboo|torch|wall_torch|soul_torch|soul_wall_torch|lantern|poppy|dandelion|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|kelp|tall_seagrass|seagrass|lily_pad|sweet_berry_bush|cobweb|mushroom_stem|brown_mushroom|red_mushroom|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|fire|soul_fire|nether_sprouts|crimson_roots|warped_roots|twisting_vines|weeping_vines|nether_wart)$/
const isPlant = n => n == null || PLANT.test(n) || FOLIAGE.test(n)
const K_LAND = 1; const K_WATER = 2; const K_LAVA = 3; const K_VOID = 4

// ---------------------------------------------------------------- binary heap (A* over ~1 M nodes: an array sort is not an option)
class Heap {
  constructor () { this.k = []; this.v = [] }
  get size () { return this.k.length }
  push (k, v) {
    const a = this.k; const b = this.v; a.push(k); b.push(v); let i = a.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (a[p] <= a[i]) break; const tk = a[p]; a[p] = a[i]; a[i] = tk; const tv = b[p]; b[p] = b[i]; b[i] = tv; i = p }
  }

  pop () {
    const a = this.k; const b = this.v; if (!a.length) return -1
    const top = b[0]; const lk = a.pop(); const lv = b.pop()
    if (a.length) {
      a[0] = lk; b[0] = lv; let i = 0
      for (;;) {
        const l = 2 * i + 1; const r = l + 1; let m = i
        if (l < a.length && a[l] < a[m]) m = l
        if (r < a.length && a[r] < a[m]) m = r
        if (m === i) break
        const tk = a[m]; a[m] = a[i]; a[i] = tk; const tv = b[m]; b[m] = b[i]; b[i] = tv; i = m
      }
    }
    return top
  }
}

// ---------------------------------------------------------------- the camera reads the corridor, column by column, at step 1
async function surveyCorridor (box, dim, opt = {}) {
  const [X0, Z0, X1, Z1] = box
  const W = X1 - X0 + 1; const D = Z1 - Z0 + 1
  const g = new Int16Array(W * D).fill(-999); const kind = new Uint8Array(W * D); const top = new Array(W * D).fill(null)
  const release = sky.lock('road-plan'); if (!release) throw new Error('another SkyEye session is flying (/tmp/skyeye.lock) - try again in a minute')
  process.on('exit', release)
  const mineflayer = require(NM + 'mineflayer')
  const nether = /nether/.test(dim)
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'SkyEye', version: process.env.MC_VERSION || '26.1', auth: 'offline', viewDistance: 'far' })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('kicked', r => rej(new Error('kicked ' + JSON.stringify(r)))); bot.once('error', rej) })
  await new Promise(r => setTimeout(r, 2500))
  if (bot.game.gameMode !== 'spectator') { bot.quit(); throw new Error('SkyEye is not a spectator (datapack `modes` missing?) - refusing to fly') }
  const FLY = nether ? 122 : 180
  const tp = (x, y, z) => { try { execFileSync('node', [ROOT + '/bots/rcon.js', (nether ? 'execute in minecraft:the_nether run ' : '') + 'tp SkyEye ' + x + ' ' + FLY + ' ' + z], { timeout: 15000 }) } catch (e) { console.log('rcon failed:', e.message) } }
  const TOP = nether ? 121 : 200; const BOT = nether ? 5 : 45
  let hint = null
  const r = await sky.fly(bot, tp, [[X0, Z0, X1, Z1]], async ({ cell, name, ok }) => {
    if (!ok) return
    const [cx1, cz1, cx2, cz2] = cell
    for (let x = Math.max(cx1, X0); x <= Math.min(cx2, X1); x++) {
      for (let z = Math.max(cz1, Z0); z <= Math.min(cz2, Z1); z++) {
        // start from the neighbour column's answer and walk to the surface (a full 150-deep scan per column is 20x the work)
        let y = hint == null ? TOP : Math.min(TOP, hint + 10)
        let n = name(x, y, z)
        if (n == null) { y = TOP; n = name(x, y, z) }
        if (!isPlant(n) && n !== 'water' && n !== 'lava') { while (y < TOP) { const u = name(x, y + 1, z); if (u == null || isPlant(u) || u === 'water' || u === 'lava') break; y++ } }
        while (y > BOT) { const b = name(x, y, z); if (b != null && !isPlant(b)) break; y-- }
        const i = (z - Z0) * W + (x - X0); const b = name(x, y, z)
        if (b == null || y <= BOT) { kind[i] = K_VOID; continue }
        hint = y
        g[i] = y; top[i] = b
        kind[i] = b === 'water' || b === 'ice' || b === 'frosted_ice' ? K_WATER : /^lava$/.test(b) ? K_LAVA : K_LAND
      }
      hint = null // a new x row: the z-neighbour hint is 128 blocks away
    }
    process.stdout.write('.')
  }, { cell: 128, loadMs: 25000, settleMs: 400, deadline: Date.now() + (opt.deadline || 420000) })
  bot.quit(); release()
  console.log('')
  return { X0, Z0, X1, Z1, W, D, g, kind, top, dim, hovers: r.hovers.length, bad: r.hovers.filter(h => !h.ok).length }
}

// ---------------------------------------------------------------- what the road may never cross (docs/WORLD.md + the board)
function forbidden (M, board) {
  const { X0, Z0, W, D } = M; const f = new Uint8Array(W * D); const why = []
  const mark = (x1, z1, x2, z2, tag) => {
    let n = 0
    for (let x = Math.max(x1, X0); x <= Math.min(x2, M.X1); x++) for (let z = Math.max(z1, Z0); z <= Math.min(z2, M.Z1); z++) { const i = (z - Z0) * W + (x - X0); if (!f[i]) n++; f[i] = 1 }
    if (n) why.push(tag + ' ' + x1 + ',' + z1 + '..' + x2 + ',' + z2 + ' (' + n + ' cells)')
  }
  for (const k of (board.settings || {}).keepOut || []) {
    const b = k && k.box; if (!Array.isArray(b) || b.length !== 4) continue
    mark(Math.min(b[0], b[2]) - 3, Math.min(b[1], b[3]) - 3, Math.max(b[0], b[2]) + 3, Math.max(b[1], b[3]) + 3, 'keep-out ' + k.id)
  }
  // WORKING LAND IS NOT TERRAIN EITHER (measured 09-21: the first village design ran segment 0 straight through the wheat at
  // -367,68,-400 - `road_blocked: 80 cells = farmland`. A `farm`/`cane`/`lumber` job has a BOX and no blueprint, and a finished
  // field's build job has been PRUNED to the archive, so neither was in the board scan below. `tidy`/`deck`/`light` are
  // groundskeeping, not land use - their boxes cover the whole base and masking them leaves no route at all.)
  for (const j of board.jobs || []) {
    const q = j.params || {}
    if (/^(farm|cane|lumber)$/.test(j.type) && Array.isArray(q.box) && q.box.length === 4) mark(Math.min(q.box[0], q.box[2]) - 1, Math.min(q.box[1], q.box[3]) - 1, Math.max(q.box[0], q.box[2]) + 1, Math.max(q.box[1], q.box[3]) + 1, j.type + ' ' + j.id)
    if (j.type === 'herd' && Array.isArray(q.pen) && q.pen.length === 4) mark(Math.min(q.pen[0], q.pen[2]) - 1, Math.min(q.pen[1], q.pen[3]) - 1, Math.max(q.pen[0], q.pen[2]) + 1, Math.max(q.pen[1], q.pen[3]) + 1, 'pen ' + j.id)
  }
  // STRUCTURES ARE NOT TERRAIN: a road never runs through a hall, a pen, a field or a depot. Terrain blueprints (a level pad, a
  // fill, another road) are exactly what a road MAY meet - that is where the junctions are. The ARCHIVE counts: `prune` moves a
  // FINISHED structure off the board, and a finished structure is the one thing that certainly stands in the world.
  const SKIP = /^(level|fill_void|clear_area|road|road_path|quarry|platform)$/
  const all = (board.jobs || []).slice()
  try { for (const l of fs.readFileSync(ROOT + '/bots/army/jobs-archive.jsonl', 'utf8').split('\n')) { if (!l) continue; try { const j = JSON.parse(l); if (j && j.type === 'build') all.push(j) } catch (e) { /* a truncated tail line is not a zone */ } } } catch (e) { /* no archive yet */ }
  for (const j of all) {
    const P = j.params || {}
    if (j.type !== 'build' || !P.blueprint || SKIP.test(String(P.blueprint)) || !Array.isArray(P.origin)) continue
    try {
      const file = path.join(ROOT, 'bots', 'blueprints', String(P.blueprint).replace(/[^a-z0-9_]/gi, '') + '.js')
      if (!fs.existsSync(file)) continue
      const cells = require(file)({ x: P.origin[0], y: P.origin[1], z: P.origin[2] }, P.args || {})
      let a1 = Infinity; let c1 = Infinity; let a2 = -Infinity; let c2 = -Infinity
      for (const c of cells) { if (c.block === 'air') continue; if (c.x < a1) a1 = c.x; if (c.x > a2) a2 = c.x; if (c.z < c1) c1 = c.z; if (c.z > c2) c2 = c.z }
      if (Number.isFinite(a1)) mark(a1 - 1, c1 - 1, a2 + 1, c2 + 1, j.id)
    } catch (e) { /* a blueprint that will not run is not a zone we can respect; plan-base reports those */ }
  }
  return { f, why }
}
// A ROAD IS NOT A LINE, IT IS A BAND (measured on the first design, base -> mine head: the centre line at z -488 was legal and the
// SOUTH SHOULDER of the 5-wide road sat in the `ravine_s` keep-out at -337,-488 - the very hole the keep-out exists to stop bots
// falling into). So the mask is grown by half the road's width + 1 before a single cell is routed: whatever the paving covers
// obeys the keep-out, not only the cell the A* walks. Separable max-filter, two passes.
function dilate (f, W, D, r) {
  if (r <= 0) return f
  const a = new Uint8Array(W * D); const b = new Uint8Array(W * D)
  for (let z = 0; z < D; z++) { const o = z * W; for (let x = 0; x < W; x++) { let v = 0; for (let k = -r; k <= r && !v; k++) { const q = x + k; if (q >= 0 && q < W && f[o + q]) v = 1 } a[o + x] = v } }
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) { let v = 0; for (let k = -r; k <= r && !v; k++) { const q = z + k; if (q >= 0 && q < D && a[q * W + x]) v = 1 } b[z * W + x] = v }
  return b
}

// ---------------------------------------------------------------- A* : the line the terrain allows
function route (M, F, from, to, opt = {}) {
  const { X0, Z0, X1, Z1, W, D, g, kind } = M
  const idx = (x, z) => (z - Z0) * W + (x - X0)
  const inBox = (x, z) => x >= X0 && x <= X1 && z >= Z0 && z <= Z1
  const N = W * D
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const dist = new Float64Array(N * 4).fill(Infinity); const prev = new Int32Array(N * 4).fill(-1); const done = new Uint8Array(N * 4)
  const TURN = opt.turn == null ? 8 : opt.turn
  const BRIDGE = opt.bridge == null ? 10 : opt.bridge
  const MAXSTEP = opt.maxStep == null ? 6 : opt.maxStep // steeper than this is a cliff, not a road
  const earth = dh => { const a = Math.abs(dh); return a === 0 ? 0 : a === 1 ? 1.2 : a === 2 ? 5 : a === 3 ? 12 : 30 + 10 * (a - 3) }
  const s = idx(from[0], from[1]); const t = idx(to[0], to[1])
  // the two ENDS are a work site and a junction - they may sit inside a zone, so the first and last `freeEnd` cells ignore the mask
  const freeEnd = opt.freeEnd == null ? 10 : opt.freeEnd
  const nearEnd = (x, z) => Math.abs(x - from[0]) + Math.abs(z - from[1]) <= freeEnd || Math.abs(x - to[0]) + Math.abs(z - to[1]) <= freeEnd
  const h = i => { const x = X0 + (i % W); const z = Z0 + Math.floor(i / W); return Math.abs(x - to[0]) + Math.abs(z - to[1]) }
  const heap = new Heap()
  for (let d = 0; d < 4; d++) { dist[s * 4 + d] = 0; heap.push(h(s), s * 4 + d) }
  let best = -1
  while (heap.size) {
    const node = heap.pop(); if (node < 0) break
    if (done[node]) continue
    done[node] = 1
    const ci = node >> 2; const cd = node & 3
    if (ci === t) { best = node; break }
    const cx = X0 + (ci % W); const cz = Z0 + Math.floor(ci / W); const cg = g[ci]
    for (let nd = 0; nd < 4; nd++) {
      const nx = cx + DIRS[nd][0]; const nz = cz + DIRS[nd][1]
      if (!inBox(nx, nz)) continue
      const ni = idx(nx, nz); const nn = ni * 4 + nd
      if (done[nn]) continue
      if (kind[ni] === K_LAVA || kind[ni] === K_VOID || g[ni] === -999) continue
      if (F.f[ni] && !nearEnd(nx, nz)) continue
      const dh = g[ni] - cg
      if (Math.abs(dh) > MAXSTEP) continue
      const c = 1 + earth(dh) + (kind[ni] === K_WATER ? BRIDGE : 0) + (nd === cd ? 0 : TURN)
      const nDist = dist[node] + c
      if (nDist < dist[nn]) { dist[nn] = nDist; prev[nn] = node; heap.push(nDist + h(ni), nn) }
    }
  }
  if (best < 0) return null
  const cells = []
  for (let n = best; n >= 0; n = prev[n]) { const i = n >> 2; cells.push([X0 + (i % W), Z0 + Math.floor(i / W)]) }
  cells.reverse()
  return { cells, cost: dist[best] }
}

// ---------------------------------------------------------------- the PROFILE: one height per segment, no step greater than 1
// The road's deck is a 1-Lipschitz curve near the ground: the mean of the two Lipschitz envelopes of a median-filtered ground
// line (peaks clipped, hollows raised, both by the same amount), then rounded and clamped so |Δy| <= 1 holds exactly.
function profile (gs, endA, endB) {
  const n = gs.length; const m = new Array(n)
  for (let i = 0; i < n; i++) { const w = []; for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) w.push(gs[j]); w.sort((a, b) => a - b); m[i] = w[w.length >> 1] }
  const L = m.slice(); const U = m.slice()
  for (let i = 1; i < n; i++) L[i] = Math.min(L[i], L[i - 1] + 1)
  for (let i = n - 2; i >= 0; i--) L[i] = Math.min(L[i], L[i + 1] + 1)
  for (let i = 1; i < n; i++) U[i] = Math.max(U[i], U[i - 1] - 1)
  for (let i = n - 2; i >= 0; i--) U[i] = Math.max(U[i], U[i + 1] - 1)
  const y = new Array(n); for (let i = 0; i < n; i++) y[i] = Math.round((L[i] + U[i]) / 2)
  if (endA != null) y[0] = endA
  if (endB != null) y[n - 1] = endB
  for (let pass = 0; pass < 64; pass++) {
    let ch = false
    for (let i = 1; i < n; i++) { const lo = y[i - 1] - 1; const hi = y[i - 1] + 1; if (y[i] < lo) { y[i] = lo; ch = true } else if (y[i] > hi) { y[i] = hi; ch = true } }
    for (let i = n - 2; i >= 0; i--) { if (i === 0 && endA != null) continue; const lo = y[i + 1] - 1; const hi = y[i + 1] + 1; if (y[i] < lo) { y[i] = lo; ch = true } else if (y[i] > hi) { y[i] = hi; ch = true } }
    if (!ch) break
  }
  // A LANDING EVERY 6 RISERS (owner 09-21「段差に対して弱すぎ、階段もなしか？」): an unbroken 1:1 climb is a ladder, not a road - a
  // player cuts a flat landing into a long flight to stand, turn and let somebody past. Six risers in a row and the seventh cell
  // is flattened to the one before it; the profile stays 1-Lipschitz, the road simply climbs a block later.
  let run = 0
  for (let i = 1; i < n - 1; i++) {
    if (y[i] === y[i - 1]) { run = 0; continue }
    if (++run < 6) continue
    y[i] = y[i - 1]; run = 0
  }
  return y
}

// ---------------------------------------------------------------- cells -> SEGMENTS (straight, one height, road | bridge)
function segments (M, cells, y, opt) {
  const { X0, Z0, W } = M; const idx = (x, z) => (z - Z0) * W + (x - X0)
  const n = cells.length
  const kindAt = i => { const j = idx(cells[i][0], cells[i][1]); return (M.kind[j] === K_WATER || y[i] - M.g[j] >= 2) ? 'bridge' : 'road' }
  const dirOf = i => cells[i][0] !== cells[i - 1][0] ? 'x' : 'z' // i >= 1
  // A SEGMENT IS A STRAIGHT RUN, NOT A FLAT ONE (owner 09-21: 118 stubs of seven cells is why the village road built nothing).
  // It breaks on a TURN and on a change of kind; a height change is carried INSIDE it as a grade (blueprint `road_ramp`, risers
  // laid as real stair blocks by the job). The only extra break is a change of SIGN - a run never climbs and drops in one piece,
  // because `road_ramp` interpolates linearly and a V would be paved as a straight slope through the ground.
  const sgn = i => Math.sign(y[i] - y[i - 1])
  const runs = []; let a = 0; let s0 = 0
  for (let i = 1; i < n; i++) {
    const turned = i > a + 1 && dirOf(i) !== dirOf(a + 1)
    const d = sgn(i)
    const flip = d !== 0 && s0 !== 0 && d !== s0
    if (!turned && !flip && kindAt(i) === kindAt(a)) { if (d !== 0) s0 = d; continue }
    runs.push({ a, b: i - 1 })
    a = turned ? i - 1 : i // a CORNER belongs to both runs (a road with a 1-cell notch at every bend is not a road)
    s0 = 0
  }
  runs.push({ a, b: n - 1 })
  return runs.map((s, k) => {
    const A = cells[s.a]; const B = cells[s.b]; const kind = kindAt(s.a); const rise = y[s.b] - y[s.a]
    const o = { i: k, kind: kind === 'bridge' ? 'bridge' : (rise ? 'ramp' : 'road'), origin: [A[0], y[s.a], A[1]], to: [B[0], y[s.b], B[1]], len: Math.abs(B[0] - A[0]) + Math.abs(B[1] - A[1]) + 1, rise, built: false }
    if (o.kind === 'bridge') o.width = opt.width
    else o.args = Object.assign({ toX: B[0], toZ: B[1], width: opt.width, block: opt.block, clear: opt.clear, torchEvery: opt.torchEvery, shoulder: opt.shoulder }, rise ? { toY: y[s.b] } : {})
    return o
  })
}

// ---------------------------------------------------------------- ASCII profile: height per 8 blocks, the way a surveyor draws it
function asciiProfile (M, cells, y, step = 8) {
  const { X0, Z0, W } = M; const idx = (x, z) => (z - Z0) * W + (x - X0)
  const gsm = []; const ysm = []; const kd = []
  for (let i = 0; i < cells.length; i += step) { const j = idx(cells[i][0], cells[i][1]); gsm.push(M.g[j]); ysm.push(y[i]); kd.push(M.kind[j]) }
  const hi = Math.max(...ysm, ...gsm); const lo = Math.min(...ysm, ...gsm)
  const rows = []
  for (let h = hi; h >= lo; h--) {
    let s = 'y' + String(h).padStart(3) + ' |'
    for (let c = 0; c < ysm.length; c++) s += ysm[c] === h ? (kd[c] === K_WATER ? '~' : '#') : (gsm[c] === h ? (kd[c] === K_WATER ? 'w' : '.') : (gsm[c] > h && ysm[c] > h ? ' ' : gsm[c] > h ? ':' : ' '))
    rows.push(s)
  }
  let ruler = '     +'; for (let c = 0; c < ysm.length; c++) ruler += (c % 10 === 0 ? '|' : '-')
  let marks = '      '; for (let c = 0; c < ysm.length; c += 10) marks += String(c * step).padEnd(10)
  rows.push(ruler, marks.slice(0, ruler.length + 8))
  rows.push('      # = road deck   ~ = bridge deck   . = natural ground   : = ground ABOVE the deck (a cut)   w = water   one column = ' + step + ' blocks')
  return rows.join('\n')
}

// ---------------------------------------------------------------- the picture a human checks before a single block is laid
function picture (M, cells, y, segs, out, S = 1) {
  const { X0, Z0, W, D, g, kind, top } = M
  let lo = Infinity; let hi = -Infinity // a loop, not Math.min(...ys): a 300 000-column corridor blew the call stack on the first village design
  for (let i = 0; i < g.length; i++) { const q = g[i]; if (q === -999) continue; if (q < lo) lo = q; if (q > hi) hi = q }
  const PW = W * S; const PD = D * S; const img = Buffer.alloc(PW * PD * 3)
  for (let i = 0; i < W * D; i++) {
    const base = kind[i] === K_VOID ? [0, 0, 0] : kind[i] === K_LAVA ? [255, 100, 0] : sky.colour(top[i] || 'air')
    const k = g[i] === -999 ? 1 : 0.55 + 0.45 * ((g[i] - lo) / Math.max(1, hi - lo))
    const gx = (i % W) * S; const gz = Math.floor(i / W) * S
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) { const o = ((gz + b) * PW + gx + a) * 3; img[o] = base[0] * k; img[o + 1] = base[1] * k; img[o + 2] = base[2] * k }
  }
  const dot = (x, z, c) => { const X = (x - X0) * S; const Z = (z - Z0) * S; if (X < 0 || Z < 0 || X >= PW || Z >= PD) return; for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) { const o = ((Z + b) * PW + X + a) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2] } }
  for (let gx = Math.ceil(X0 / 128) * 128; gx <= M.X1; gx += 128) for (let z = Z0; z <= M.Z1; z += 4) dot(gx, z, [0, 0, 0])
  for (let gz = Math.ceil(Z0 / 128) * 128; gz <= M.Z1; gz += 128) for (let x = X0; x <= M.X1; x += 4) dot(x, gz, [0, 0, 0])
  for (let i = 0; i < cells.length; i++) {
    const j = (cells[i][1] - Z0) * W + (cells[i][0] - X0)
    const c = (kind[j] === K_WATER || y[i] - g[j] >= 2) ? [0, 230, 255] : [255, 40, 40]
    dot(cells[i][0], cells[i][1], c)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) dot(cells[i][0] + dx, cells[i][1] + dz, c) // 3 blocks wide: the line is visible at any scale
  }
  for (const s of segs) { for (let a = -3; a <= 3; a++) { dot(s.origin[0] + a, s.origin[2], [255, 255, 0]); dot(s.origin[0], s.origin[2] + a, [255, 255, 0]) } }
  fs.writeFileSync(out, sky.png(PW, PD, img))
  return out
}

// ---------------------------------------------------------------- CLI
function argOf (k, d) { const i = process.argv.indexOf('--' + k); return i > 0 && process.argv[i + 1] != null && !/^--/.test(process.argv[i + 1]) ? process.argv[i + 1] : d }
const flag = k => process.argv.includes('--' + k)

async function main () {
  const av = process.argv.slice(2)
  const pos = []; for (let i = 0; i < av.length; i++) { if (/^--/.test(av[i])) { if (av[i + 1] != null && !/^--/.test(av[i + 1])) i++; continue } pos.push(av[i]) }
  if (pos.length < 2) {
    console.log('usage: node ops/road-plan.js <fromX,fromZ> <toX,toZ> [--id name] [--width 5] [--dim the_nether] [--half 64] [--survey f.json] [--out png] [--spur] [--put]')
    console.log('  the corridor is surveyed by the spectator camera at step 1, the line is chosen by A* over the real ground, and')
    console.log('  the result is a `road` job with straight one-height segments. READ the picture before you --put.')
    process.exit(1)
  }
  const P0 = pos[0].split(',').map(Number); const P1 = pos[1].split(',').map(Number)
  if (P0.length !== 2 || P1.length !== 2 || [...P0, ...P1].some(v => !Number.isFinite(v))) throw new Error('coordinates are "x,z"')
  const dim = argOf('dim', 'overworld')
  const spur = flag('spur')
  const width = +argOf('width', spur ? 3 : 5)
  const id = argOf('id', 'road_' + (spur ? 'spur_' : '') + [P0[0], P0[1], P1[0], P1[1]].map(v => String(v).replace('-', 'n')).join('_'))
  const len = Math.abs(P1[0] - P0[0]) + Math.abs(P1[1] - P0[1])
  const half = +argOf('half', Math.max(32, Math.min(128, Math.round(len * 0.25))))
  const out = argOf('out', '/tmp/road-' + id + '.png')
  const board = JSON.parse(fs.readFileSync(ROOT + '/bots/army/jobs.json', 'utf8'))

  const box = [Math.min(P0[0], P1[0]) - half, Math.min(P0[1], P1[1]) - half, Math.max(P0[0], P1[0]) + half, Math.max(P0[1], P1[1]) + half]
  const cacheF = argOf('survey', '/tmp/road-survey-' + box.join('_') + '-' + dim + '.json')
  let M
  if (fs.existsSync(cacheF)) {
    console.log('survey: reusing ' + cacheF + ' (delete it to fly again)')
    const raw = JSON.parse(fs.readFileSync(cacheF, 'utf8'))
    M = Object.assign({}, raw, { g: Int16Array.from(raw.g), kind: Uint8Array.from(raw.kind) })
  } else {
    console.log('survey: flying SkyEye over x ' + box[0] + '..' + box[2] + ' / z ' + box[1] + '..' + box[3] + ' (' + ((box[2] - box[0] + 1) * (box[3] - box[1] + 1)) + ' columns, ' + dim + ')')
    M = await surveyCorridor(box, dim)
    fs.writeFileSync(cacheF, JSON.stringify(Object.assign({}, M, { g: Array.from(M.g), kind: Array.from(M.kind) })))
    console.log('survey: ' + M.hovers + ' camera stations, ' + M.bad + ' incomplete -> ' + cacheF)
  }
  const idx = (x, z) => (z - M.Z0) * M.W + (x - M.X0)
  for (const [n, p] of [['from', P0], ['to', P1]]) { const q = M.g[idx(p[0], p[1])]; if (q === -999) throw new Error(n + ' ' + p.join(',') + ' is not readable in the survey (unloaded chunk?)') }

  const F = forbidden(M, board)
  F.f = dilate(F.f, M.W, M.D, Math.floor(width / 2) + 1) // the whole PAVED BAND obeys the keep-outs, not just the centre line
  console.log('no-go: ' + (F.why.length ? F.why.slice(0, 8).join(' | ') + (F.why.length > 8 ? ' | +' + (F.why.length - 8) + ' more' : '') : 'nothing in this corridor') + '   (grown by ' + (Math.floor(width / 2) + 1) + ' for a ' + width + '-wide road)')
  const R = route(M, F, P0, P1, { maxStep: spur ? 12 : 6, turn: spur ? 2 : 8 })
  if (!R) throw new Error('no line through this corridor: every route is blocked by lava, a keep-out, a zone or an unreadable column. Widen --half, or LOOK first (ops/skyshot.js)')
  const gs = R.cells.map(c => M.g[idx(c[0], c[1])])
  const y = profile(gs, M.g[idx(P0[0], P0[1])], M.g[idx(P1[0], P1[1])])
  const segs = segments(M, R.cells, y, { width, block: argOf('block', 'stone'), clear: 3, torchEvery: 8, shoulder: spur ? 1 : 2 })

  const cut = R.cells.reduce((n, c, i) => n + Math.max(0, M.g[idx(c[0], c[1])] - y[i]), 0)
  const fill = R.cells.reduce((n, c, i) => n + Math.max(0, y[i] - M.g[idx(c[0], c[1])]), 0)
  const bridges = segs.filter(s => s.kind === 'bridge'); const ramps = segs.filter(s => s.kind === 'ramp')
  const risers = ramps.reduce((n, s) => n + Math.abs(s.rise || 0), 0)
  console.log('\n' + asciiProfile(M, R.cells, y, 8) + '\n')
  const px = Math.max(1, Math.min(6, +argOf('px', Math.max(1, Math.round(420 / Math.max(M.W, M.D))))))
  console.log('picture: ' + picture(M, R.cells, y, segs, out, px) + '   (' + px + ' px = 1 block; RED = the line, CYAN = a bridge, YELLOW = a segment start; north is up)')
  console.log('line   : ' + R.cells.length + ' cells, straight distance ' + len + ' (+' + Math.round(100 * (R.cells.length - 1 - len) / Math.max(1, len)) + ' %), cost ' + Math.round(R.cost))
  console.log('profile: y ' + Math.min(...y) + '..' + Math.max(...y) + ', ' + (y.filter((v, i) => i && v !== y[i - 1]).length) + ' one-block steps, cut ' + cut + ' / fill ' + fill + ' block-columns')
  console.log('segments: ' + segs.length + ' (' + segs.filter(s => s.kind === 'road').length + ' flat, ' + ramps.length + ' ramp (' + risers + ' stair risers, ' + (ramps.length ? 'steepest 1:' + Math.min(...ramps.map(s => Math.round(s.len / Math.max(1, Math.abs(s.rise))))) : '-') + '), ' + bridges.length + ' bridge' + (bridges.length ? ': ' + bridges.map(s => s.origin.join(',') + '->' + s.to.join(',') + ' ' + s.len).join(' | ') : '') + ')')
  for (const s of bridges) if (s.len > 6 * 12) console.log('  ! bridge ' + s.i + ' is ' + s.len + ' cells: it is built span by span (<= 6) with moves.bridgeTo - check the picture that this is really the best crossing')

  const pave = segs.filter(s => s.kind !== 'bridge').reduce((n, s) => n + s.len * width, 0)
  const job = {
    id,
    type: 'road',
    priority: spur ? 68 : 72,
    front: 'roads',
    status: 'paused',
    when: 'any',
    bots: Math.max(2, Math.min(12, Math.round(R.cells.length / 60))),
    site: [segs[0].origin[0], segs[0].origin[1] + 1, segs[0].origin[2]],
    requires: { minHp: 10 },
    plan: (spur ? 'ROAD SPUR' : 'TRUNK ROAD') + ' ' + id + ' (docs/ROADS.md): ' + P0.join(',') + ' -> ' + P1.join(',') + ' in ' + dim + ', ' + width + ' wide, ' +
      R.cells.length + ' cells in ' + segs.length + ' straight segments (' + ramps.length + ' ramps with ' + risers + ' stair risers, ' + bridges.length + ' bridged), ~' + pave + ' paving blocks. ' +
      'Designed from the spectator camera (ops/road-plan.js, picture ' + out + '): the line follows the contour, no step over 1 block, no keep-out or zone crossed.',
    params: { road: id, dim, width, block: argOf('block', 'stone'), from: [P0[0], y[0], P0[1]], to: [P1[0], y[y.length - 1], P1[1]], spur, segments: segs }
  }
  const jf = '/tmp/' + id + '.json'
  fs.writeFileSync(jf, JSON.stringify(job, null, 1))
  console.log('job    : ' + jf + '  (' + job.bots + ' bots, ' + pave + ' paving blocks)')
  if (flag('put')) {
    console.log(execFileSync('node', [ROOT + '/bots/army/armyctl.js', 'put', jf], { encoding: 'utf8' }))
  } else console.log('nothing written to the board. READ ' + out + ' first, then: node bots/army/armyctl.js put ' + jf)
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.log('road-plan failed: ' + (e && e.message)); process.exit(1) })
module.exports = { surveyCorridor, route, profile, segments, asciiProfile, forbidden }
