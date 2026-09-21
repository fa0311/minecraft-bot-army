'use strict'
// bots/skills/lib/route.js — THE STRATEGIC LAYER OF army.js travel(), used ONLY from there (owner 09-21 18:0xZ 「全然遠くまでpath findをしてない気がする」,
// 「村まで美しい幹線道路出来てるじゃん、けどこれ使ってないね」).
// WHY: mineflayer-pathfinder plans ~40 blocks. travel() used to aim every hop 38 blocks along the STRAIGHT LINE to a far target, so a lake, a
// cliff or a sinkhole on the beeline was walked INTO, never round (09-21: 25+ bots in the water cave W of the base; village traders wading
// rivers and ending up 500 blocks east). This file gives travel two things a player has and the pathfinder has not:
//   1 THE ROAD NETWORK (macro): settings.roads + each road job's params.segments form a polyline from `from` to `to`. A long trip whose road
//     leg is cheaper than the beeline (built deck x `road`, planned-but-unbuilt x `planned`, the access legs and the beeline x `direct` = unknown
//     land) goes: nearest road point -> along the road -> leave it where it passes nearest the target. Once chosen it sticks for the trip.
//   2 A COARSE A* (micro) over what the bot has LOADED (chunk data, no Block objects: a state-id table, ~1 M cells/s): nodes are standable
//     cells (feet y), moves = walk / step up 1 / drop <= maxDrop (the SAME drop rule the live Movements have) / swim at the water surface; cost =
//     distance x (road 1 : off-road `offroad`) + height (settings.heightCost, the heightRule numbers) + water/flowing water + settings.avoid boxes +
//     farm boxes + the surface floor / keep-out rules of this trip. Its target is a CARROT `carrot` blocks ahead along the macro line; an
//     unloaded or out-of-window neighbour makes the node a FRONTIER that may end the plan (cost g + direct x rest).
//   travel() then gives the pathfinder the farthest route point within `hop` path-blocks as its goal, re-plans every hop (chunks load as it
//   walks), marks a hop goal that failed as BAD for 5 min and judges progress on the route (a detour away from the target is not a failure).
// Budget: <= `nodes` expansions, sliced every `sliceMs` with setImmediate (loop_stall is watched), <= `maxMs` per plan. Knobs: settings.routePlan
// ({off:true} or false switches the layer off army-wide, {off:[names]} for an A/B crew; any DEF key below overrides).
const swallow = require('./swallow')

const FREE = 0; const FLOOR = 1; const TALL = 2; const WATER = 3; const FLOW = 4; const DANGER = 5; const UNK = 7
const DEF = { road: 1, planned: 1.1, offroad: 1.5, direct: 2.0, water: 86, flow: 206, carrot: 100, hop: 40, window: 150, nodes: 40000, sliceMs: 6, maxMs: 1500, eps: 1.3, minRoad: 60, bad: 80 }
const A_ = () => require('./army')
function W () { const s = (A_().settings().routePlan) || {}; const w = Object.assign({}, DEF); for (const k of Object.keys(DEF)) if (typeof s[k] === 'number' && isFinite(s[k])) w[k] = s[k]; return w } // numbers only: a non-number knob never reaches a cost
function enabled (bot) { const s = A_().settings().routePlan; if (s === false || (s && s.off === true)) return false; return !(s && Array.isArray(s.off) && bot && s.off.includes(bot.username)) } // off: [names] = an A/B crew walking the old beeline

// ---- a state id -> class table, once per registry
const _coders = new WeakMap()
function coder (registry) {
  let c = _coders.get(registry); if (c) return c
  let N = 0; for (const b of registry.blocksArray || []) if (b.maxStateId > N) N = b.maxStateId
  const T = new Uint8Array(N + 2).fill(255)
  const WATERY = /^(bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
  const HARM = /^(lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush|powder_snow|campfire|soul_campfire|wither_rose|cobweb|pointed_dripstone)$/
  c = sid => {
    if (sid == null || sid < 0) return UNK
    let v = T[sid]; if (v !== 255 && v !== undefined) return v
    const b = registry.blocksByStateId[sid]; const n = b ? b.name : 'air'
    if (n === 'water') v = (sid - b.minStateId) > 0 ? FLOW : WATER // water's only property is `level`: 0 = source/still
    else if (WATERY.test(n)) v = WATER
    else if (HARM.test(n)) v = DANGER
    else if (/_door$|_fence_gate$/.test(n) && n !== 'iron_door') v = FREE // the pathfinder opens them
    else if (/_fence$|_wall$|^iron_bars$|glass_pane$|^iron_door$/.test(n)) v = TALL // neither a floor to jump onto nor a gap
    else v = b && b.boundingBox === 'block' ? FLOOR : FREE
    if (sid < T.length) T[sid] = v
    return v
  }
  _coders.set(registry, c)
  return c
}
// the bot's own chunk data; an UNLOADED column reads UNK (never air - tests/unknown_cells.js)
function reader (bot) {
  const cod = coder(bot.registry)
  const minY = (bot.game && bot.game.minY != null) ? bot.game.minY : -64; const maxY = minY + ((bot.game && bot.game.height) || 384)
  const cols = new Map(); const P = { x: 0, y: 0, z: 0 }; let lk = null; let lc = null
  return (x, y, z) => {
    if (y < minY) return DANGER
    if (y >= maxY) return FREE
    const k = ((x >> 4) + 4096) * 8192 + ((z >> 4) + 4096)
    let col
    if (k === lk) col = lc
    else { col = cols.get(k); if (col === undefined) { try { col = bot.world.getColumn(x >> 4, z >> 4) || null } catch (e_) { col = null } cols.set(k, col) } lk = k; lc = col }
    if (!col) return UNK
    P.x = x & 15; P.y = y; P.z = z & 15
    try { return cod(col.getBlockStateId(P)) } catch (e_) { return UNK }
  }
}

// ---- roads: numeric cell map + polylines (60 s cache, shared by the bots of one process)
let _roads = { t: 0, cells: null, lines: [] }
function roads () {
  if (Date.now() - _roads.t < 60000 && _roads.cells) return _roads
  const cells = new Map(); const lines = []
  try {
    const m = require('./jobs_road').roadCells()
    for (const [k, y] of m) { const [x, z] = k.split(',').map(Number); cells.set((x + 30000) * 65536 + (z + 30000), y) }
    const A = A_(); const board = A.readJSON(A.F.board, {}) || {}
    const jobs = new Map((board.jobs || []).map(j => [j.id, j]))
    for (const r of ((board.settings || {}).roads) || []) {
      if (!r || (r.dim && r.dim !== 'overworld')) continue
      const j = jobs.get(r.job || r.id); const segs = j && j.params && Array.isArray(j.params.segments) ? j.params.segments.filter(s => s && Array.isArray(s.origin) && Array.isArray(s.to)) : []
      if (!segs.length) continue
      const pts = [{ x: segs[0].origin[0], y: segs[0].origin[1], z: segs[0].origin[2] }]; const built = []
      for (const s of segs) { pts.push({ x: s.to[0], y: s.to[1], z: s.to[2] }); built.push(!!s.built) }
      const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
      lines.push({ id: r.id, pts, built, cum })
    }
  } catch (e_) { swallow('route:roads', e_) }
  _roads = { t: Date.now(), cells, lines }
  return _roads
}
const roadY = (R, x, z) => R.cells.get((x + 30000) * 65536 + (z + 30000))
// feet on the deck (deck y .. deck+2, like jobs_road.roadCost)
function onRoad (R, x, y, z) { const d = roadY(R, x, z); return d != null && y - 1 >= d - 1 && y - 1 <= d + 1 }

// ---- polyline geometry
function project (L, p, lo = -Infinity, hi = Infinity) { // nearest point of the line to p (xz) with lo <= arc <= hi
  let best = null
  for (let i = 0; i + 1 < L.pts.length; i++) {
    const s0 = L.cum[i]; const s1 = L.cum[i + 1]; if (s1 < lo || s0 > hi) continue
    const a = L.pts[i]; const b = L.pts[i + 1]; const ex = b.x - a.x; const ez = b.z - a.z; const l2 = ex * ex + ez * ez
    let t = l2 ? ((p.x - a.x) * ex + (p.z - a.z) * ez) / l2 : 0
    const seg = s1 - s0; const tLo = seg ? Math.max(0, (lo - s0) / seg) : 0; const tHi = seg ? Math.min(1, (hi - s0) / seg) : 1
    t = Math.max(tLo, Math.min(tHi, Math.max(0, Math.min(1, t))))
    const q = { x: a.x + ex * t, y: a.y + (b.y - a.y) * t, z: a.z + ez * t }; const d = Math.hypot(p.x - q.x, p.z - q.z)
    if (!best || d < best.d) best = { s: s0 + t * seg, d, q, i }
  }
  return best
}
function pointAt (L, s) { // the point at arc s
  s = Math.max(0, Math.min(L.cum[L.cum.length - 1], s))
  for (let i = 0; i + 1 < L.pts.length; i++) {
    if (s > L.cum[i + 1] && i + 2 < L.pts.length) continue
    const seg = L.cum[i + 1] - L.cum[i]; const t = seg ? (s - L.cum[i]) / seg : 0; const a = L.pts[i]; const b = L.pts[i + 1]
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
  }
  return L.pts[L.pts.length - 1]
}
function arcCost (L, s1, s2, w) { // walking the line between two arcs: built edges x road, planned x planned
  const lo = Math.min(s1, s2); const hi = Math.max(s1, s2); let c = 0
  for (let i = 0; i + 1 < L.pts.length; i++) { const a = Math.max(lo, L.cum[i]); const b = Math.min(hi, L.cum[i + 1]); if (b > a) c += (b - a) * (L.built[i] ? w.road : w.planned) }
  return c
}
// the road choice for this trip (sticky: kept while its cost stays under 1.25 x the beeline)
function macro (bot, S, T, w) {
  const st = bot.__armyRoute
  const tk = Math.round(T.x) + ',' + Math.round(T.z)
  const direct = Math.hypot(T.x - S.x, T.z - S.z) * w.direct
  let best = null
  for (const L of roads().lines) {
    const pT = project(L, T); if (!pT) continue
    const keep = st && st.tk === tk && st.road === L.id
    const pS = keep ? (st.dir > 0 ? project(L, S, st.s - 16) : project(L, S, -Infinity, st.s + 16)) : project(L, S); if (!pS) continue
    if (Math.abs(pT.s - pS.s) < w.minRoad && !keep) continue
    const cost = (pS.d + pT.d) * w.direct + arcCost(L, pS.s, pT.s, w)
    if (cost < direct * (keep ? 1.25 : 1) && (!best || cost < best.cost)) best = { L, pS, pT, cost }
  }
  const same = best && st && st.tk === tk && st.road === best.L.id; const dir = best ? (best.pT.s >= best.pS.s ? 1 : -1) : 0
  bot.__armyRoute = { tk, road: best ? best.L.id : null, dir, s: best ? (same ? (dir > 0 ? Math.max(st.s, best.pS.s) : Math.min(st.s, best.pS.s)) : best.pS.s) : 0, t: Date.now(), bad: (st && st.bad) || [], last: st && st.last }
  return best
}
// a point `ahead` blocks along S -> [road] -> T
function carrot (bot, S, T, w) {
  const m = macro(bot, S, T, w)
  const ahead = w.carrot
  if (!m) { const d = Math.hypot(T.x - S.x, T.z - S.z); const t = Math.min(1, ahead / Math.max(1, d)); return { c: { x: S.x + (T.x - S.x) * t, z: S.z + (T.z - S.z) * t }, rest: Math.max(0, d - ahead), road: null } }
  const { L, pS, pT } = m; const dir = pT.s >= pS.s ? 1 : -1
  if (pS.d <= 10) bot.__armyRoute.s = pS.s // on the road: the arc only moves on (a loop of the road never sends the bot back: macro() projects with a bound)
  const l0 = pS.d
  if (l0 >= ahead) { const t = ahead / l0; return { c: { x: S.x + (pS.q.x - S.x) * t, z: S.z + (pS.q.z - S.z) * t }, rest: (l0 - ahead) + Math.abs(pT.s - pS.s) + pT.d + Math.hypot(T.x - pT.q.x, T.z - pT.q.z), road: L.id } }
  const along = Math.abs(pT.s - pS.s); const need = ahead - l0
  if (need < along) { const s = pS.s + dir * need; return { c: pointAt(L, s), rest: along - need + Math.hypot(T.x - pT.q.x, T.z - pT.q.z), road: L.id } }
  const d2 = Math.hypot(T.x - pT.q.x, T.z - pT.q.z); const t = Math.min(1, (need - along) / Math.max(1, d2))
  return { c: { x: pT.q.x + (T.x - pT.q.x) * t, z: pT.q.z + (T.z - pT.q.z) * t }, rest: Math.max(0, d2 - (need - along)), road: L.id }
}

// ---- binary heap (lazy deletion)
function Heap () { const k = []; const f = []; return {
  get size () { return k.length },
  push (id, v) { k.push(id); f.push(v); let i = k.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (f[p] <= f[i]) break; [k[p], k[i]] = [k[i], k[p]]; [f[p], f[i]] = [f[i], f[p]]; i = p } },
  topF () { return f[0] },
  pop () { const id = k[0]; const lk = k.pop(); const lf = f.pop(); if (k.length) { k[0] = lk; f[0] = lf; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < k.length && f[l] < f[m]) m = l; if (r < k.length && f[r] < f[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [f[m], f[i]] = [f[i], f[m]]; i = m } } return id }
} }
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
const NONE = -99999; const BLIND = -99998
const tick = () => new Promise(resolve => setImmediate(resolve))

// ---- the coarse A*: from feet cell `from` to within `goal.r` (xz) of goal; ctx from travel (maxDrop, floorY, inKO, avoid, fields, heightW)
async function plan (bot, from, goal, ctx, w) {
  const t0 = Date.now(); const C = reader(bot); const R = roads()
  const maxDrop = Math.max(1, ctx.maxDrop || 1); const hw = ctx.heightW || { up: 1, down: [0, 1, 4, 8] }
  const avoid = ctx.avoid || []; const fields = ctx.fields || []; const bad = ctx.bad || []
  const isW = c => c === WATER || c === FLOW
  const stand = (x, y, z) => { const c0 = C(x, y, z); if (c0 === UNK) return BLIND; const c1 = C(x, y + 1, z); if (c1 === UNK) return BLIND; if (c1 !== FREE) return NONE; if (isW(c0)) return y; if (c0 !== FREE) return NONE; const cb = C(x, y - 1, z); if (cb === UNK) return BLIND; return cb === FLOOR ? y : NONE }
  // where a body that leaves (ox,y,oz) towards the column (x,z) ends up: step up 1, level, or a drop <= maxDrop (into water: the surface)
  const land = (x, z, y, ox, oz) => {
    const c1 = C(x, y + 1, z); const c0 = C(x, y, z)
    if (c0 === UNK || c1 === UNK) return BLIND
    if (c1 !== FREE) return NONE
    if (c0 === FLOOR) { const c2 = C(x, y + 2, z); const o2 = C(ox, y + 2, oz); if (c2 === UNK) return BLIND; return c2 === FREE && o2 === FREE ? y + 1 : NONE }
    if (isW(c0)) return y
    if (c0 !== FREE) return NONE
    for (let k = 0; k <= maxDrop; k++) {
      const yy = y - k; const cb = C(x, yy - 1, z)
      if (cb === UNK) return BLIND
      if (cb === FLOOR) return yy
      if (isW(cb)) return k + 1 <= maxDrop + 1 ? yy - 1 : NONE
      if (cb !== FREE) return NONE
    }
    return NONE
  }
  const extra = (x, y, z, c0) => {
    let e = 0
    if (c0 === WATER) e += w.water; else if (c0 === FLOW) e += w.flow
    if (ctx.floorY != null && y < ctx.floorY) e += 100
    if (ctx.inKO && ctx.inKO(x, y, z)) e += 100
    for (const a of avoid) { const q = a.box; if (x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]) { e += a.w || 60; break } }
    for (const q of fields) if (x >= q[0] - 1 && x <= q[2] + 1 && z >= q[1] - 1 && z <= q[3] + 1) { e += 40; break }
    for (const b of bad) if (Math.abs(x - b.x) <= 3 && Math.abs(z - b.z) <= 3) { e += w.bad; break }
    return e
  }
  const WIN = Math.min(500, w.window)
  const key = (x, y, z) => ((x - from.x + 512) * 1024 + (z - from.z + 512)) * 1024 + (y + 512)
  const X = []; const Y = []; const Z = []; const G = []; const PAR = []; const CLOSED = []
  const idx = new Map(); const open = Heap()
  const h = (x, z) => Math.hypot(goal.x - x, goal.z - z)
  const ok = v => v > -90000 // NONE / BLIND are sentinels far below any world
  let y0 = stand(from.x, from.y, from.z)
  if (!ok(y0)) { for (const dy of [1, -1, 2]) { const yy = stand(from.x, from.y + dy, from.z); if (ok(yy)) { y0 = yy; break } } }
  if (!ok(y0)) y0 = from.y // standing on a slab/path edge the classes misread: start where the body is
  const add = (x, y, z, g, par) => { const k = key(x, y, z); let i = idx.get(k); if (i === undefined) { i = X.length; idx.set(k, i); X.push(x); Y.push(y); Z.push(z); G.push(Infinity); PAR.push(-1); CLOSED.push(0) } if (g < G[i]) { G[i] = g; PAR[i] = par; open.push(i, g + w.eps * h(x, z)) } return i }
  add(from.x, y0, from.z, 0, -1)
  let reached = -1; let front = -1; let frontF = Infinity; let closest = 0; let closestH = h(from.x, from.z); let n = 0; let slice = Date.now(); let why = 'exhausted'
  while (open.size) {
    if (open.topF() >= frontF) { why = 'frontier'; break }
    const i = open.pop(); if (CLOSED[i]) continue; CLOSED[i] = 1; n++
    const x = X[i]; const y = Y[i]; const z = Z[i]; const hi = h(x, z)
    if (hi <= goal.r) { reached = i; why = 'reached'; break }
    if (hi < closestH) { closestH = hi; closest = i }
    if (n >= w.nodes) { why = 'nodes'; break }
    if ((n & 255) === 0 && Date.now() - slice > w.sliceMs) { if (Date.now() - t0 > w.maxMs) { why = 'time'; break } await tick(); slice = Date.now() }
    let blind = false
    for (const [dx, dz] of DIRS) {
      const nx = x + dx; const nz = z + dz
      if (Math.abs(nx - from.x) > WIN || Math.abs(nz - from.z) > WIN) { blind = true; continue }
      const ny = land(nx, nz, y, x, z)
      if (ny === BLIND) { blind = true; continue }
      if (ny === NONE) continue
      if (dx && dz) { // a corner is cut only on the level with both sides open (the pathfinder's own diagonal rule)
        if (ny !== y) continue
        const a0 = C(x + dx, y, z); const a1 = C(x + dx, y + 1, z); const b0 = C(x, y, z + dz); const b1 = C(x, y + 1, z + dz)
        if (!((a0 === FREE || isW(a0)) && a1 === FREE && (b0 === FREE || isW(b0)) && b1 === FREE)) continue
      }
      const c0 = C(nx, ny, nz)
      let cost = (dx && dz ? 1.4142 : 1) * (onRoad(R, nx, ny, nz) ? w.road : w.offroad)
      const dy = ny - y; if (dy > 0) cost += 1 + hw.up * dy; else if (dy < 0) cost += (hw.down[Math.min(-dy, hw.down.length - 1)] || 0)
      cost += extra(nx, ny, nz, c0)
      add(nx, ny, nz, G[i] + cost, i)
    }
    if (blind) { const fv = G[i] + w.direct * hi; if (fv < frontF) { frontF = fv; front = i } }
  }
  const end = reached >= 0 ? reached : front >= 0 ? front : closest
  const pts = []; for (let i = end; i >= 0; i = PAR[i]) pts.push({ x: X[i], y: Y[i], z: Z[i] })
  pts.reverse()
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z, pts[i].y - pts[i - 1].y))
  const water = pts.filter(p => isW(C(p.x, p.y, p.z))).length; const road = pts.filter(p => onRoad(R, p.x, p.y, p.z)).length
  return { y0, pts, cum, end: reached >= 0 ? 'goal' : front >= 0 ? 'frontier' : 'closest', why, nodes: n, ms: Date.now() - t0, water, road, g: G[end] }
}

// ---- what travel() calls for a far target: the next hop goal, or null (= the old beeline hop)
async function hop (bot, target, ctx) {
  if (!enabled(bot)) return null
  const w = W(); const p = bot.entity.position; const S = { x: Math.floor(p.x), y: Math.floor(p.y + 0.2), z: Math.floor(p.z) }
  const st0 = bot.__armyRoute; const bad = ((st0 && st0.bad) || []).filter(b => Date.now() - b.t < 300000)
  const k = carrot(bot, S, target, w); bot.__armyRoute.bad = bad
  const goal = { x: Math.round(k.c.x), z: Math.round(k.c.z), r: 4 }
  const r = await plan(bot, S, goal, Object.assign({}, ctx, { bad }), w)
  const st = bot.__armyRoute; st.last = { at: Date.now(), from: [S.x, S.y, S.z], y0: r.y0, drop: ctx.maxDrop, ms: r.ms, nodes: r.nodes, end: r.end, why: r.why, len: Math.round(r.cum[r.cum.length - 1] || 0), water: r.water, road: r.road, via: k.road, goal: [goal.x, goal.z] }
  if (r.pts.length < 2) return null
  const tail = Math.hypot(r.pts[r.pts.length - 1].x - goal.x, r.pts[r.pts.length - 1].z - goal.z) + k.rest
  if (r.end === 'closest' && tail > Math.hypot(target.x - S.x, target.z - S.z) - 8) return null // the plan found nothing closer: the old way
  let j = 1; while (j + 1 < r.pts.length && r.cum[j + 1] <= w.hop) j++
  if (r.cum[j] < 6 && r.pts.length > 2) return null
  const q = r.pts[j]
  const rt = { x: q.x, y: q.y, z: q.z, pts: r.pts, cum: r.cum, tail, j, plan: st.last }
  rt.left0 = left(bot, rt)
  return rt
}
// what is left of the trip on THIS route: bot -> nearest route point -> end of route -> carrot -> target
function left (bot, rt) {
  const p = bot.entity.position; let bj = 0; let bd = Infinity
  for (let i = 0; i < rt.pts.length; i++) { const q = rt.pts[i]; const d = Math.hypot(q.x + 0.5 - p.x, q.z + 0.5 - p.z, (q.y - p.y) * 0.5); if (d < bd) { bd = d; bj = i } }
  return bd + (rt.cum[rt.cum.length - 1] - rt.cum[bj]) + rt.tail
}
// a hop that did not get anywhere: its goal is BAD for 5 min, the next plan goes round it
function fail (bot, rt) { try { const st = bot.__armyRoute; if (!st || !rt) return; st.bad = (st.bad || []).filter(b => Date.now() - b.t < 300000).concat([{ x: rt.x, z: rt.z, t: Date.now() }]).slice(-12) } catch (e_) { swallow('route:fail', e_) } }

module.exports = { hop, left, fail, plan, roads, onRoad, macro, carrot, enabled, coder, DEF }
