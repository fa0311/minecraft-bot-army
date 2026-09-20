// jobs_cavity.js — THE DARK HOLES UNDER THE BASE. Owner 09-20: "地下にbotが誤って掘った穴が多すぎます、敵mobが変な位置に湧く原因になります /
// 該当の穴の上の座標に立つ->穴まで掘って水バケツ降り->埋めながら上まで上がる、で簡単に解消できます", and the same day "地下から緊急脱出を試みる際に
// 作った階段を埋めないのは何故か？" and "バケツ降り出来ないのか？". Nothing we had SEES any of it: ops/base-audit.js looks from ABOVE, so a sealed
// pocket 8 blocks under a finished pad and a 1x2 escape staircase that comes out in the middle of the yard are both invisible to it. A dark cell
// with a solid floor is a mob spawner; an open staircase is a hole the next bot falls into.
// EXTENSION MODULE (contract at the end of army_jobs.js): one job type, `cavity`. No new daemon, no cheats; every number is READ BACK from the world.
//
// THE JOB (type `cavity`, params):
//   work:'survey'  LOOK: flood-fill every connected AIR component under the base box (6-neighbour, y `yMin`..`yTop`) through the eyes of the bot
//                  that holds the job (its loaded chunks), classify it, write bots/army/cavities.json (atomic, merged with what other eyes saw)
//                  and report `cavity_census`. One pass, then the job pauses itself (`standing:true` = keep surveying).
//                  FULL coverage of the base box needs the spectator camera: `node ops/cavity-census.js` (the same code, SkyEye's eyes).
//   work:'fill'    FIX (default): claim ONE cavity (bots/army/cavity_claims.json, never two bots on one), fetch filler + a water bucket + torches,
//                  run the OWNER'S ALGORITHM, verify by re-reading the world, report `cavity_filled` / `cavity_failed`.
//   box,yMin,yTop  the survey volume (default: the tidy sponge's box = the base site, y 30 .. base.y+52)
//   filler:'cobblestone'   needStock:{cobblestone:512}   minutes:12 (one bot's budget for one cavity)   maxCells:400
//
// THE CLASSES (bots/army/cavities.json, `type`):
//   mine          touches the miners' registered stairwell/hub/trunk/branches, or any cell within 2 of them — NEVER filled
//   planned       >= 60 % of its cells are blueprint cells of a build job (a cellar, a hall, a water cell) — not ours to close
//   open          connected to the sky and WIDE: that is a pit, the build job's `fill_void` — listed only
//   escape_stair  connected to the sky and NARROW (<= 4.5 cells per y level, rises with its height): a 1x2 escape staircase or a 1x1 escape
//                 shaft one of our own bots dug on its way out (army.js stairUp/digOut, events `dug_out` / `escape_scar`) — A TARGET
//   natural_cave  > `maxCells` cells, or it leaves the surveyed box / goes below `yMin` — listed only (a cave system is not our hole)
//   unknown       it touches a column nobody has loaded — listed only, until better eyes see it
//   cavity        enclosed, <= `maxCells` cells, at least one DARK SPAWNABLE floor cell — THE TARGET the owner pointed at
//
// THE ALGORITHM (his, not a variation): stand on the surface cell ABOVE the hole -> dig a 1x1 shaft straight down, reading the two cells under
// the feet BEFORE every dig (lava/water/gravel/bedrock/our own blocks veto the column) -> descend (a drop > 3 is taken with the WATER BUCKET,
// see waterDescent below; <= 3 it just steps down) -> torch -> FILL the component bottom-up while standing on its own fill -> ride the shaft up
// placing under the feet -> restore the top cell with what was there (grass_block -> dirt, dirt_path/cobblestone as found) -> scoop the water
// back. An escape staircase is WALKED down instead of dug into: it is already open, and its mouth is closed back to the grade of the yard.
//
// WHAT THIS FILE MUST NOT DO: no cheats, no new daemon, no state file beyond cavities.json + cavity_claims.json, never dig or place outside the
// claimed component and its own shaft, never open a shaft in a building, a field, a pen, a road or within 2 of registered furniture.
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')

const LIBDIR = __dirname
const ARMY = path.join(LIBDIR, '..', '..', 'army')
const CAV_F = path.join(ARMY, 'cavities.json')
const CLAIM_F = path.join(ARMY, 'cavity_claims.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- block classes (pure, name-based; cached per block STATE id)
const AIR_RE = /^(air|cave_air|void_air)$/
const LIQUID_RE = /^(water|lava|bubble_column)$/
// solid, but it does not stop the sky: air under leaves or glass is OUTDOORS, not a cavity
const SKY_BLIND_RE = /_leaves$|glass|^(barrier|light|structure_void)$/
const LIGHT_RE = /torch|lantern|glowstone|campfire|shroomlight|sea_lantern|magma_block|^fire$|soul_fire|candle|redstone_lamp|jack_o_lantern|crying_obsidian|^beacon$|^conduit$|^lava$|end_rod|froglight|^furnace$|^smoker$|^blast_furnace$/
const GRAVITY_RE = /^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel|.*_concrete_powder|anvil|.*_anvil)$/
const HARD_RE = /^(bedrock|obsidian|crying_obsidian|reinforced_deepslate|end_portal|end_portal_frame|end_gateway|spawner|trial_spawner|vault|budding_amethyst|.*_shulker_box|chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|enchanting_table|.*_bed|.*_sign|lodestone|beacon|conduit|nether_portal|ancient_debris)$/
const RESTORE = { grass_block: 'dirt', dirt_path: 'dirt', podzol: 'dirt', coarse_dirt: 'dirt', rooted_dirt: 'dirt', mycelium: 'dirt', farmland: 'dirt', mud: 'dirt', muddy_mangrove_roots: 'dirt', moss_block: 'dirt', snow_block: 'dirt', stone: 'cobblestone', deepslate: 'cobbled_deepslate' }
const FILLERS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'deepslate', 'coarse_dirt', 'netherrack']
const INSIDE_FILL_RE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|gravel|sand|netherrack|[a-z_]+_planks|stone_bricks)$/

const C_UNKNOWN = 0; const C_AIR = 1; const C_SOLID = 2; const C_LIQUID = 3; const C_THIN = 4
const M_MINE = 1; const M_PLANNED = 2; const M_SCAR = 4; const M_GRAVITY = 8; const M_HARD = 16
const NOTOP = -32768

const vv = p => Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z)
const xyzOf = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
const keyOf = p => Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z)
const isAirB = b => !!b && b.boundingBox === 'empty' && !LIQUID_RE.test(b.name)
const isSolidB = b => !!b && b.boundingBox === 'block'

// A CODER, not a name lookup per cell: 3 million cells per survey, so every question about a block is answered once per STATE id.
function coder (registry) {
  const N = ((registry && registry.blocksByStateId) || []).length || 32768
  const cCode = new Int8Array(N + 1).fill(-1); const cFlag = new Int8Array(N + 1).fill(-1)
  const nameOf = sid => { const b = sid == null ? null : registry.blocksByStateId[sid]; return b ? b.name : null }
  const codeOf = sid => {
    if (sid == null) return C_UNKNOWN
    let c = cCode[sid]; if (c >= 0) return c
    const b = registry.blocksByStateId[sid]; const n = b ? b.name : 'air'
    c = AIR_RE.test(n) ? C_AIR
      : LIQUID_RE.test(n) ? C_LIQUID
        : (b && b.boundingBox === 'block') ? (SKY_BLIND_RE.test(n) ? C_THIN : C_SOLID)
          : C_AIR // torches, plants, rails, snow layers, buttons: a mob stands there and the fill must close it
    cCode[sid] = c; return c
  }
  const flagOf = sid => { // M_GRAVITY | M_HARD | 32 = light source
    if (sid == null) return 0
    let f = cFlag[sid]; if (f >= 0) return f
    const n = nameOf(sid) || 'air'
    f = (GRAVITY_RE.test(n) ? M_GRAVITY : 0) | (HARD_RE.test(n) ? M_HARD : 0) | (LIGHT_RE.test(n) ? 32 : 0)
    cFlag[sid] = f; return f
  }
  return { codeOf, flagOf, nameOf }
}

// ---------------------------------------------------------------- the grid (one typed-array book per survey)
function newGrid (box, yMin, yTop) {
  const x1 = Math.min(box[0], box[2]); const z1 = Math.min(box[1], box[3]); const x2 = Math.max(box[0], box[2]); const z2 = Math.max(box[1], box[3])
  const W = x2 - x1 + 1; const D = z2 - z1 + 1; const H = yTop - yMin + 1
  return { box: [x1, z1, x2, z2], yMin, yTop, W, D, H, code: new Uint8Array(W * D * H), mask: new Uint8Array(W * D * H), top: new Int16Array(W * D).fill(NOTOP), seen: new Uint8Array(W * D), lights: [], cols: 0 }
}
const gIdx = (G, x, y, z) => (((z - G.box[1]) * G.W) + (x - G.box[0])) * G.H + (y - G.yMin)
const gCol = (G, x, z) => ((z - G.box[1]) * G.W) + (x - G.box[0])
const gIn = (G, x, z) => x >= G.box[0] && x <= G.box[2] && z >= G.box[1] && z <= G.box[3]
function gDecode (G, i) { const y = G.yMin + (i % G.H); const r = (i - (y - G.yMin)) / G.H; const x = G.box[0] + (r % G.W); const z = G.box[1] + Math.floor(r / G.W); return { x, y, z } }

// read one sub-box of the grid with any pair of eyes: sid(x,y,z) -> block state id | null (not loaded)
function readInto (G, sub, sid, cd) {
  const ax = Math.max(sub[0], G.box[0]); const az = Math.max(sub[1], G.box[1]); const bx = Math.min(sub[2], G.box[2]); const bz = Math.min(sub[3], G.box[3])
  let cols = 0
  for (let z = az; z <= bz; z++) {
    for (let x = ax; x <= bx; x++) {
      const ci = gCol(G, x, z); let t = NOTOP; let any = false; const base = ci * G.H
      for (let y = G.yMin; y <= G.yTop; y++) {
        const s = sid(x, y, z)
        if (s == null) { G.code[base + y - G.yMin] = C_UNKNOWN; continue }
        any = true
        const c = cd.codeOf(s); G.code[base + y - G.yMin] = c
        if (c === C_SOLID) t = y
        const f = cd.flagOf(s)
        if (f & 32) G.lights.push([x, y, z])
        if (f & (M_GRAVITY | M_HARD)) G.mask[base + y - G.yMin] |= (f & (M_GRAVITY | M_HARD))
      }
      if (any) { G.top[ci] = t; if (!G.seen[ci]) { G.seen[ci] = 1; G.cols++ } ; cols++ }
    }
  }
  return cols
}

// ---------------------------------------------------------------- what is OURS and what is the MINE (the two things we must never fill)
function markPlan (G, P) {
  for (const k of P.planned || []) { const [x, y, z] = k.split(',').map(Number); if (gIn(G, x, z) && y >= G.yMin && y <= G.yTop) G.mask[gIdx(G, x, y, z)] |= M_PLANNED }
  for (const k of P.mine || []) { // "or any cell within 2 of them"
    const [x, y, z] = k.split(',').map(Number)
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) { const a = x + dx; const b = y + dy; const c = z + dz; if (gIn(G, a, c) && b >= G.yMin && b <= G.yTop) G.mask[gIdx(G, a, b, c)] |= M_MINE }
  }
  for (const k of P.scars || []) { const [x, y, z] = k.split(',').map(Number); for (let dy = -1; dy <= 1; dy++) { const b = y + dy; if (gIn(G, x, z) && b >= G.yMin && b <= G.yTop) G.mask[gIdx(G, x, b, z)] |= M_SCAR } }
}

function boxOfPts (pts) {
  const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]
  for (const p of pts) { if (p.x < bb[0]) bb[0] = p.x; if (p.y < bb[1]) bb[1] = p.y; if (p.z < bb[2]) bb[2] = p.z; if (p.x > bb[3]) bb[3] = p.x; if (p.y > bb[4]) bb[4] = p.y; if (p.z > bb[5]) bb[5] = p.z }
  return bb
}
// THE NECK of a sky-touching component: from the narrowest mouth downward, level by level, while the cross-section stays <= neckMax.
// It stops where the chimney opens into the cave — that widening IS the boundary between "the hole we dug" and "the cave that was there".
function neckOf (G, cells, mouths, neckMax, cap) {
  if (!mouths.length) return null
  const inComp = new Set(cells); const dY = 1
  const lvlFlood = (seed, seen) => {
    const p0 = gDecode(G, seed); const out = [seed]; const q = [seed]; seen.add(seed)
    while (q.length && out.length <= neckMax + 1) {
      const j = q.pop(); const pj = gDecode(G, j)
      for (const d of [G.H, -G.H, G.W * G.H, -G.W * G.H]) {
        const n = j + d
        if (!inComp.has(n) || seen.has(n)) continue
        const pn = gDecode(G, n)
        if (pn.y !== pj.y || Math.abs(pn.x - pj.x) + Math.abs(pn.z - pj.z) !== 1) continue
        seen.add(n); q.push(n); out.push(n)
      }
    }
    void p0
    return out
  }
  // the NARROWEST mouth of this component is the one a bot cut; a cave's own wide entrance is not a neck
  const tried = new Set(); const cands = []
  for (const j of mouths.slice(0, 40)) { if (tried.has(j)) continue; const lv = lvlFlood(j, tried); cands.push(lv) }
  cands.sort((a, b) => a.length - b.length)
  if (!cands.length || cands[0].length > neckMax) return null
  const neck = []; const seen = new Set()
  let level = cands[0]
  for (const j of level) seen.add(j)
  while (level.length && neck.length < cap) {
    if (level.length > neckMax) break
    for (const j of level) neck.push(j)
    const nxt = []
    for (const j of level) { const n = j - dY; if (!inComp.has(n) || seen.has(n)) continue; const pn = gDecode(G, n); const pj = gDecode(G, j); if (pn.x !== pj.x || pn.z !== pj.z || pn.y !== pj.y - 1) continue; nxt.push(n) }
    const lv = []; for (const s of nxt) { if (seen.has(s)) continue; for (const q of lvlFlood(s, seen)) lv.push(q) }
    level = lv
  }
  return neck.length >= 4 ? neck : null
}
// one census entry: what this hole is, how dark its floor is, how deep under the grade it lies, and where a shaft may be cut into it
function entryOf (G, P, type, pts, bb, colset, nCells, perY, wet, scarHit, sky) {
  const code = G.code; const mask = G.mask
  const blocked = P.blockedCol || (() => false)
  const near = G.lights.filter(l => l[0] >= bb[0] - 8 && l[0] <= bb[3] + 8 && l[1] >= bb[1] - 8 && l[1] <= bb[4] + 8 && l[2] >= bb[2] - 8 && l[2] <= bb[5] + 8)
  const dark = p => !near.some(l => Math.hypot(l[0] - p.x, l[1] - p.y, l[2] - p.z) <= 7)
  let spawnable = 0; const floors = []
  for (const p of pts) {
    if (p.y - 1 < G.yMin || p.y + 1 > G.yTop) continue
    const below = code[gIdx(G, p.x, p.y - 1, p.z)]; const above = code[gIdx(G, p.x, p.y + 1, p.z)]
    if ((below !== C_SOLID && below !== C_THIN) || above !== C_AIR) continue
    floors.push(p); if (dark(p)) spawnable++
  }
  const sys = []
  for (const k of colset) { const [x, z] = k.split(',').map(Number); const t = G.top[gCol(G, x, z)]; if (t !== NOTOP) sys.push(t) }
  sys.sort((a, b) => a - b)
  const surfaceY = sys.length ? sys[Math.floor(sys.length / 2)] : null
  const depth = surfaceY == null ? null : surfaceY - bb[4] // how far the roof of the hole lies under the grade of its own ground
  const topY = new Map()
  for (const p of pts) { const k = p.x + ',' + p.z; if (!topY.has(k) || topY.get(k) < p.y) topY.set(k, p.y) }
  const cell = (x, y, z) => (y < G.yMin || y > G.yTop || !gIn(G, x, z)) ? C_UNKNOWN : code[gIdx(G, x, y, z)]
  const pure = (x, z, y0, y1) => { // may a 1x1 shaft be cut through this stretch of column?
    if (y1 < y0) return false
    for (let y = y0; y <= y1; y++) { if (y < G.yMin || y > G.yTop) return false; const ii = gIdx(G, x, y, z); if (code[ii] === C_AIR || code[ii] === C_LIQUID || code[ii] === C_UNKNOWN) return false; if (mask[ii] & (M_GRAVITY | M_HARD | M_PLANNED | M_MINE)) return false }
    return true
  }
  const dropAt = (x, z, ey) => { let d = 0; for (let y = ey; y >= G.yMin && cell(x, y, z) === C_AIR; y--) d++; return d }
  const tops = []
  const colList = [...colset].slice(0, 400)
  for (const k of colList) { // straight down, the way the owner described it
    const [x, z] = k.split(',').map(Number); const ci = gCol(G, x, z); const sy = G.top[ci]; const ey = topY.get(k)
    if (!G.seen[ci] || sy === NOTOP || sy <= ey || sy - ey > 28 || blocked(x, z)) continue
    if (!pure(x, z, ey + 1, sy)) continue
    tops.push({ at: [x, sy, z], entryY: ey, drop: dropAt(x, z, ey), shaft: sy - ey, tunnel: null, score: (dropAt(x, z, ey) > 3 ? 10 : 0) + (sy - ey) * 0.2 })
  }
  // HIS FALLBACK when the ground over the hole is a building, a field, a pen or a road: the nearest FREE surface cell, and 1-3 cells of
  // tunnel at depth. The bot walks in at foot level, so the column must offer two cells of air where the tunnel arrives.
  if (tops.length < 2) {
    for (const k of colList) {
      if (tops.length >= 4) break
      const [cx, cz] = k.split(',').map(Number)
      let ey2 = null
      for (let y = topY.get(k); y >= bb[1]; y--) if (cell(cx, y, cz) === C_AIR && cell(cx, y + 1, cz) === C_AIR) { ey2 = y; break }
      if (ey2 == null) continue
      for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let d = 1; d <= 3; d++) {
          const rx = cx + ux * d; const rz = cz + uz * d
          if (!gIn(G, rx, rz) || colset.has(rx + ',' + rz) || blocked(rx, rz)) continue
          const ci = gCol(G, rx, rz); const sy = G.top[ci]
          if (!G.seen[ci] || sy === NOTOP || sy <= ey2 + 1 || sy - ey2 > 28) continue
          if (!pure(rx, rz, ey2, sy)) continue
          const st = cell(rx, ey2 - 1, rz); if (st !== C_SOLID && st !== C_THIN) continue // something to stand on at the shaft's foot
          const tun = []; let ok = true
          for (let s = d - 1; s >= 1 && ok; s--) { const tx = cx + ux * s; const tz = cz + uz * s; for (const yy of [ey2, ey2 + 1]) { if (!pure(tx, tz, yy, yy)) { ok = false; break } ; tun.push([tx, yy, tz]) } }
          if (!ok) continue
          tops.push({ at: [rx, sy, rz], entryY: ey2, drop: 0, shaft: sy - ey2, tunnel: tun, to: [cx, cz], score: 4 + d })
          break
        }
        if (tops.length >= 4) break
      }
    }
  }
  tops.sort((a, b) => a.score - b.score)
  const cx = (bb[0] + bb[3]) / 2; const cz = (bb[2] + bb[5]) / 2
  const darkFloors = floors.filter(dark)
  const rep = (darkFloors.length ? darkFloors : floors.length ? floors : pts).slice().sort((a, b) => a.y - b.y || (Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz)))[0]
  if (!rep) return null
  return {
    id: 'c' + rep.x + '_' + rep.y + '_' + rep.z,
    type,
    at: [rep.x, rep.y, rep.z],
    cells: nCells,
    bbox: bb,
    height: bb[4] - bb[1] + 1,
    perY: Math.round(perY * 10) / 10,
    surfaceY,
    depth,
    spawnable,
    floors: floors.length,
    wet,
    sky: !!sky,
    scar: !!scarHit,
    lit: near.length > 0,
    tops: tops.slice(0, 6).map(t => ({ at: t.at, entryY: t.entryY, drop: t.drop, shaft: t.shaft, tunnel: t.tunnel, to: t.to || null })),
    seen: Date.now()
  }
}

// ---------------------------------------------------------------- flood fill + classify. 6-neighbour: that is how a mob walks and how water runs;
// 26 would weld two pockets that share one diagonal corner into one "cavity" nobody can fill in one go.
function analyse (G, P) {
  const maxCells = P.maxCells || 400
  const hardCap = P.hardCap || 20000
  const code = G.code; const mask = G.mask; const vis = new Uint8Array(code.length)
  const dY = 1; const dX = G.H; const dZ = G.W * G.H
  const out = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== C_AIR || vis[i]) continue
    const p0 = gDecode(G, i); const ci0 = gCol(G, p0.x, p0.z)
    if (!G.seen[ci0] || p0.y >= G.top[ci0]) continue // sky air, or a column nobody loaded
    const st = [i]; vis[i] = 1
    const cells = []; const mouths = []; let sky = false; let unk = false; let bound = false; let wet = false; let capped = false
    let mineHit = 0; let plannedHit = 0; let scarHit = 0
    while (st.length) {
      const j = st.pop(); cells.push(j)
      if (cells.length >= hardCap) { capped = true; break }
      const m = mask[j]; if (m & M_MINE) mineHit++; if (m & M_PLANNED) plannedHit++; if (m & M_SCAR) scarHit++
      const q = gDecode(G, j)
      for (let k = 0; k < 6; k++) {
        const dx = k === 0 ? 1 : k === 1 ? -1 : 0; const dy = k === 2 ? 1 : k === 3 ? -1 : 0; const dz = k === 4 ? 1 : k === 5 ? -1 : 0
        const nx = q.x + dx; const ny = q.y + dy; const nz = q.z + dz
        if (!gIn(G, nx, nz) || ny < G.yMin || ny > G.yTop) { bound = true; continue }
        const ni = j + dx * dX + dy * dY + dz * dZ
        const nci = gCol(G, nx, nz)
        if (!G.seen[nci] || code[ni] === C_UNKNOWN) { unk = true; continue }
        if (code[ni] === C_LIQUID) { wet = true; continue }
        if (code[ni] !== C_AIR) continue
        if (ny > G.top[nci]) { sky = true; if (mouths.length < 200) mouths.push(j); continue } // open to the sky: a pit, or a staircase mouth
        if (!vis[ni]) { vis[ni] = 1; st.push(ni) }
      }
    }
    if (cells.length < 2) continue // a single loose cell is noise (a torch hole, a flower cell)
    const pts = cells.map(j => gDecode(G, j))
    const bb = boxOfPts(pts)
    const colset = new Set(); for (const p of pts) colset.add(p.x + ',' + p.z)
    const height = bb[4] - bb[1] + 1; const horiz = Math.max(bb[3] - bb[0] + 1, bb[5] - bb[2] + 1)
    const perY = cells.length / height
    // NARROW AND RISING = an escape staircase / escape shaft one of ours dug (army.js stairUp = 1 wide, 2 high, one step per block; digOut the same)
    const stairy = cells.length <= 160 && perY <= 4.5 && height >= 3 && height >= 0.55 * horiz
    let type
    if (mineHit) type = 'mine'
    else if (plannedHit >= 0.6 * cells.length) type = 'planned'
    else if (unk) type = 'unknown'
    else if (capped || cells.length > maxCells || bound) type = 'natural_cave'
    else if (sky) type = (stairy || scarHit) ? 'escape_stair' : 'open'
    else type = 'cavity'
    const e = entryOf(G, P, type, pts, bb, colset, cells.length, perY, wet, scarHit, sky)
    if (e) out.push(e)
    // A STAIRCASE WELDED TO THE CAVE IT ESCAPED FROM (490 `dug_out` events in this world, and the census found 2 free-standing ones): the
    // component is the whole cave, but the HOLE we made is the narrow NECK that reaches daylight. Cut it out and plug THAT - filling a cave
    // system is not survival work, closing the chimney our bot dug through its roof is.
    if (sky && !mineHit && plannedHit < 0.6 * cells.length && (type === 'open' || type === 'natural_cave')) {
      const nk = neckOf(G, cells, mouths, P.neckMax || 5, P.neckCells || 140)
      if (nk) {
        const npts = nk.map(j => gDecode(G, j))
        const nbb = boxOfPts(npts); const ncols = new Set(); for (const p of npts) ncols.add(p.x + ',' + p.z)
        const nScar = nk.some(j => mask[j] & M_SCAR)
        const nPerY = nk.length / (nbb[4] - nbb[1] + 1)
        // a 1-2 wide chimney is ours (nature does not dig 1x1); anything wider needs the ledger's word that a bot cut it
        if ((nbb[4] - nbb[1] + 1) >= 4 && (nScar || nPerY <= 2.2)) {
          const ne = entryOf(G, P, 'escape_stair', npts, nbb, ncols, nk.length, nPerY, false, nScar ? 1 : 0, true)
          if (ne) { ne.neck = true; ne.list = npts.map(p => [p.x, p.y, p.z]); ne.scar = !!nScar; out.push(ne) }
        }
      }
    }
  }
  // what is the same hole twice (a neck inside its own narrow component) never gets two entries
  const byId = new Map(); for (const e of out) if (!byId.has(e.id)) byId.set(e.id, e)
  out.length = 0; for (const e of byId.values()) out.push(e)
  out.sort((a, b) => (isTarget(b) ? 1 : 0) - (isTarget(a) ? 1 : 0) || b.spawnable - a.spawnable || b.cells - a.cells)
  return out
}
// NO MAKE-WORK (owner 09-20): a sealed pocket deep in the rock is geology - no mob ever walks out of it, and 200 of them are 30 000 blocks of
// pointless carrying. What the owner pointed at is the hole a BOT dug and the ground we then closed over it (its roof within CAVITY_DEPTH of the
// grade of its own ground), and every scar that still reaches daylight.
const CAVITY_DEPTH = 8
const isTarget = e => !!e && (e.type === 'escape_stair' ? true : e.type === 'cavity' && e.spawnable > 0 && e.tops.length > 0 && e.depth != null && e.depth <= CAVITY_DEPTH)

// ---------------------------------------------------------------- the plan: what is ours, where no shaft may be opened, what the miners own
let _plan = { t: 0 }
function planSets (A, box, fresh) {
  if (!fresh && _plan.t && Date.now() - _plan.t < 300000 && String(_plan.box) === String(box)) return _plan
  const planned = new Set(); const blockedCols = new Set(); const mine = new Set(); const scars = new Set()
  const board = A.readJSON(A.F.board, {}) || {}; const S = board.settings || {}
  const inBox = (x, z) => x >= Math.min(box[0], box[2]) - 8 && x <= Math.max(box[0], box[2]) + 8 && z >= Math.min(box[1], box[3]) - 8 && z <= Math.max(box[1], box[3]) + 8
  // every cell of every blueprint we ever planned here — INCLUDING its `air` cells: a cellar, a doorway or a water cell is a planned void
  try {
    for (const j of A.buildJobs()) {
      if (j.dim) continue
      let cells = []
      try { cells = A.blueprintCellsOf(j.params) } catch (e_) { cells = [] }
      // TERRAIN BLUEPRINTS ARE GROUND, NOT PLAN (measured 09-20: with `level`/`fill_void` cells counted as planned, 96 % of the base was off
      // limits for a shaft and the census found 3 targets against 33 holes right under the pads). A pad is ground a shaft may go through and be
      // closed again; a wall, a road, a field or a house is not.
      // ...but a crew that is WORKING a terrain job right now owns its columns: two jobs in one column is exactly the dig/place runaway of
      // 09-20 14:4xZ. An ACTIVE build job of any blueprint keeps this front out of its box until it pauses itself.
      if (A.TERRAIN_BP.test(String(j.params.blueprint))) {
        // ...but an ACTIVE `fill_void` owns the very thing this front works on - a void. Two jobs in one column is the dig/place runaway of
        // 09-20 14:4xZ, so its own cells are off limits while it runs. (`level`/`clear_area` cap the GRADE: a shaft that is opened and closed
        // again inside one slice does not fight them, and blocking their boxes would blanket the whole base.)
        if (j.status === 'active' && j.params.blueprint === 'fill_void') for (const c of cells) if (inBox(c.x, c.z)) blockedCols.add(c.x + ',' + c.z)
        continue
      }
      for (const c of cells) {
        if (!inBox(c.x, c.z)) continue
        planned.add(c.x + ',' + c.y + ',' + c.z)
        blockedCols.add(c.x + ',' + c.z) // a building, a wall, a road: never cut a shaft through it
      }
    }
  } catch (e_) { /* a thin plan is reported as coverage, it never kills the survey */ }
  for (const j of board.jobs || []) {
    const p = j.params || {}
    if (Array.isArray(p.pen) && p.pen.length === 4) for (let x = Math.min(p.pen[0], p.pen[2]) - 1; x <= Math.max(p.pen[0], p.pen[2]) + 1; x++) for (let z = Math.min(p.pen[1], p.pen[3]) - 1; z <= Math.max(p.pen[1], p.pen[3]) + 1; z++) blockedCols.add(x + ',' + z)
    if (/^(farm|cane|lumber)$/.test(j.type) && Array.isArray(p.box) && p.box.length === 4) for (let x = Math.min(p.box[0], p.box[2]); x <= Math.max(p.box[0], p.box[2]); x++) for (let z = Math.min(p.box[1], p.box[3]); z <= Math.max(p.box[1], p.box[3]); z++) blockedCols.add(x + ',' + z)
  }
  // registered furniture: no shaft within 2 (a chest falls into a hole under it)
  const furn = []
  for (const l of Object.values(S.chests || {})) for (const c of l || []) furn.push(c)
  for (const c of S.furnaces || []) furn.push(c)
  if (S.craftTable) furn.push(S.craftTable)
  for (const c of S.respawnBeds || []) furn.push(c)
  if (S.mineHead) furn.push([S.mineHead.x, S.mineHead.y, S.mineHead.z])
  for (const c of furn) if (Array.isArray(c) && c.length >= 3) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) blockedCols.add((c[0] + dx) + ',' + (c[2] + dz))
  // THE MINE IS THE MINERS' (armyctl.js `mine` reads the same cache): the stairwell's geometry, every level's hub, the recorded steps
  try {
    const IC = require('./iron_core.js')
    const st = A.readJSON(path.join(LIBDIR, '..', '..', 'iron_mine.json'), {}) || {}
    const job = (board.jobs || []).find(j => j.type === 'delegate' && j.params && j.params.skill === 'iron_miner')
    const E = IC.normEntrance((job && job.params.args && job.params.args.entrance) || S.mineHead || (st.entrance && [].concat(st.entrance, [st.facing])))
    if (E) {
      const levels = (st.levels || []).filter(Number.isFinite)
      const lo = Math.min(...(levels.length ? levels : [16]))
      const G = IC.stairCells(E, lo, { levels })
      for (const k of G.cells.keys()) mine.add(k)
      for (const L of Object.values(st.lv || {})) { const h = L && L.hub; if (h) for (let dx = -4; dx <= 4; dx++) for (let dy = 0; dy <= 3; dy++) for (let dz = -4; dz <= 4; dz++) mine.add((h.x + dx) + ',' + (h.y + dy) + ',' + (h.z + dz)) }
      for (const s of st.steps || []) if (Array.isArray(s)) mine.add(s[0] + ',' + s[1] + ',' + s[2])
    }
  } catch (e_) { /* no mine yet */ }
  // the army's own escape scars: `dug_out {from,to}` (the staircase army.js cut) and `escape_scar {cells}` (what the new escape code leaves open)
  try {
    const f = A.F.results; const sz = fs.statSync(f).size; const from = Math.max(0, sz - 512 * 1024)
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(sz - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd)
    for (const line of buf.toString('utf8').split('\n')) {
      if (!/escape_scar|dug_out/.test(line)) continue
      let r = null; try { r = JSON.parse(line) } catch (e2_) { continue }
      if (!r) continue
      if (r.ev === 'escape_scar') for (const c of r.cells || []) if (Array.isArray(c)) scars.add(c[0] + ',' + c[1] + ',' + c[2])
      if (r.ev === 'dug_out') for (const c of [r.from, r.to]) if (Array.isArray(c) && c.length === 3) scars.add(c[0] + ',' + c[1] + ',' + c[2])
    }
  } catch (e_) { /* no ledger yet */ }
  _plan = { t: Date.now(), box: box.slice(), planned, blockedCols, mine, scars, blockedCol: (x, z) => blockedCols.has(x + ',' + z) }
  return _plan
}

// the base box = what the groundskeeping sponge sweeps (the same fallback ops/base-audit.js uses), else base +-128
function baseBox (A) {
  const b = A.readJSON(A.F.board, {}) || {}; const S = b.settings || {}
  const t = (b.jobs || []).find(j => j.type === 'tidy' && j.status === 'active' && Array.isArray((j.params || {}).box) && j.params.box.length === 4)
  if (t) return t.params.box.slice()
  const base = S.base || { x: 0, y: 64, z: 0 }
  return [base.x - 128, base.z - 128, base.x + 128, base.z + 128]
}
function baseY (A) { const S = (A.readJSON(A.F.board, {}) || {}).settings || {}; return (S.base && S.base.y) || 68 }

// ---------------------------------------------------------------- cavities.json (atomic; a partial survey MERGES, it never forgets what it could not see)
function writeCensus (A, G, list, by) {
  const old = A.readJSON(CAV_F, null)
  const kept = []
  if (old && Array.isArray(old.list)) {
    for (const e of old.list) {
      const a = e.at || [0, 0, 0]
      const covered = gIn(G, a[0], a[2]) && G.seen[gCol(G, a[0], a[2])] === 1
      if (!covered) kept.push(e) // nobody looked there this time: the old word stands
    }
  }
  const all = list.concat(kept)
  const counts = {}
  for (const e of all) counts[e.type] = (counts[e.type] || 0) + 1
  const doc = {
    t: Date.now(),
    by,
    box: G.box,
    yMin: G.yMin,
    yTop: G.yTop,
    cols: G.cols,
    colsTotal: G.W * G.D,
    coverage: Math.round(1000 * G.cols / (G.W * G.D)) / 10,
    counts,
    targets: all.filter(isTarget).length,
    spawnable: all.filter(isTarget).reduce((n, e) => n + e.spawnable, 0),
    list: all.sort((a, b) => (isTarget(b) ? 1 : 0) - (isTarget(a) ? 1 : 0) || b.spawnable - a.spawnable || b.cells - a.cells).slice(0, 400)
  }
  A.writeJSON(CAV_F, doc)
  return doc
}
function table (doc) {
  const pad = (s, n) => String(s).padEnd(n)
  const rows = [pad('', 2) + pad('type', 14) + pad('at', 18) + pad('cells', 7) + pad('spawn', 7) + pad('depth', 7) + pad('h', 4) + pad('per-y', 7) + pad('enter at', 20) + 'flags']
  for (const e of doc.list.slice(0, 45)) {
    const t = e.tops && e.tops[0]
    rows.push(pad(isTarget(e) ? '->' : '', 2) + pad(e.type + (e.neck ? '/neck' : ''), 14) + pad(e.at.join(','), 18) + pad(e.cells, 7) + pad(e.spawnable, 7) + pad(e.depth == null ? '-' : e.depth, 7) + pad(e.height, 4) + pad(e.perY, 7) +
      pad(e.sky ? 'walk in (open)' : t ? t.at.join(',') + (t.tunnel && t.tunnel.length ? '+t' : '') + ' d' + t.drop : '-', 20) + (e.wet ? 'wet ' : '') + (e.lit ? 'lit ' : '') + (e.scar ? 'scar' : ''))
  }
  return rows.join('\n')
}

// ================================================================ WATER-BUCKET DESCENT (owner 09-20 "バケツ降り出来ないのか？")
// The reliable form, not the MLG timing trick: pour the source into the TOP cell of an open column so a falling column of water reaches the
// floor, step in, sink with the head under control, step out on the floor. `dropIn` in army_jobs.js takes 3-7 hp for a 9-14 block drop; this
// takes none. ONE implementation, exported, so any job can use it (a fill shaft, a builder under 18 hp, a pit entry).
//   waterDescent(bot, {rim:[x,y,z] the cell the bot stands IN, column:[x,z] the shaft, floorY, stop, scoop, openBelow})
//     openBelow: optional async () => boolean — the caller's own dig of the LAST solid block under the rim, run AFTER the source is in place
//                (that is the fill shaft's case: the column is not open until the bot breaks the floor it stands on).
//     scoop:true — this is the LAST user: take the source back into the bucket from the floor if it is in reach, else say so.
//   -> { ok, how:'column', from, to, drop, lost:<hp>, tookS, scooped, source:[x,y,z]|null, sources:<sources left>, why }
// Never digs, never places a block; the only world edit is the water source, and the result says whether it is still standing.
async function waterDescent (bot, opts = {}) {
  const A = require('./army'); const U = require('./util'); const swallow = require('./swallow')
  const stop = () => U.cancelled(bot) || !!(opts.stop && opts.stop())
  const t0 = Date.now(); const hp0 = bot.health
  const rim = vv(opts.rim || bot.entity.position.floored())
  const cx = opts.column ? opts.column[0] : rim.x; const cz = opts.column ? opts.column[1] : rim.z
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  let floorY = opts.floorY
  const out = (ok, why, extra) => {
    const r = Object.assign({ ok, how: 'column', from: xyzOf(rim), to: xyzOf(bot.entity.position), drop: floorY == null ? 0 : Math.max(0, rim.y - floorY - 1), lost: Math.max(0, Math.round((hp0 - bot.health) * 10) / 10), tookS: Math.round((Date.now() - t0) / 1000), scooped: false, source: null, sources: 0, why: why || null }, extra || {})
    try { A.result(bot, { ev: 'water_descent', from: r.from, to: r.to, drop: r.drop, lost: r.lost, scooped: r.scooped, ok: r.ok, why: r.why }) } catch (e_) { swallow('jobs_cavity:wdResult', e_) }
    return r
  }
  // ---- 1. READ THE COLUMN. A falling column of water needs an open shaft and a landing that is not lava.
  if (floorY == null) { for (let y = rim.y - (opts.openBelow ? 2 : 1); y >= rim.y - 40; y--) { const b = at(cx, y, cz); if (!b) break; if (isSolidB(b)) { floorY = y; break } } }
  if (floorY == null) return out(false, 'no floor within 40 blocks under ' + [cx, rim.y, cz].join(','))
  const land = at(cx, floorY, cz)
  if (!land || !isSolidB(land)) return out(false, 'the landing ' + [cx, floorY, cz].join(',') + ' is not solid')
  if (/lava|magma/.test(land.name)) return out(false, 'the landing is ' + land.name)
  const firstOpen = rim.y - (opts.openBelow ? 2 : 1)
  for (let y = firstOpen; y > floorY; y--) {
    const b = at(cx, y, cz)
    if (!b) return out(false, 'the column is not loaded at y ' + y)
    if (b.name === 'lava') return out(false, 'lava in the column at y ' + y)
    if (!isAirB(b) && b.name !== 'water') return out(false, 'the column is blocked by ' + b.name + ' at ' + [cx, y, cz].join(',') + ' - it is not one open shaft')
  }
  const drop = rim.y - floorY - 1
  // ---- 2. THE BUCKET IS CARRIED, NEVER FETCHED FROM HERE (15:55Z: the withdraw walked Ume 66 blocks to the depot and it then poured at a
  // rim it no longer stood on). The caller stocks up before it walks out; `fill` at a pond turns an empty bucket into a full one.
  if (!A.count(bot, 'water_bucket')) return out(false, 'no water_bucket carried (depot holds ' + A.stockOf('water_bucket') + '; fill an empty one at water first: verb `fill`)')
  // ---- 3. OPEN THE COLUMN FROM BESIDE IT, then pour against the TOP OF THE WALL (the owner's words). Two shapes, one rule:
  //   * the bot stands ON the plug over an open drop  -> it steps off first, the caller opens the cell from the side (no 18-block fall),
  //     and the source goes into the shaft's own top cell, whose four walls hold the water in a falling column.
  //   * the bot is already INSIDE a 1x1 shaft (no free cell beside it) -> the source goes into its own cell; the same four walls hold it,
  //     and the water follows the bot down as the caller opens the floor.
  // Measured 16:0xZ on an 18-block shaft: with the source on OPEN GROUND at the rim the flow simply washed the bot 4 blocks sideways.
  let srcCell = null; let steppedOff = false
  const standable = c => { const f = at(c.x, c.y - 1, c.z); const a = at(c.x, c.y, c.z); const h = at(c.x, c.y + 1, c.z); return isSolidB(f) && !/lava|magma/.test(f.name) && isAirB(a) && isAirB(h) }
  if (opts.openBelow) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const c = new Vec3(rim.x + dx, rim.y, rim.z + dz)
      if (!standable(c)) continue
      if (await A.travel(bot, c, { range: 0, ms: 15000, stop: opts.stop, quiet: true })) { steppedOff = true; break }
    }
    if (!steppedOff) { // inside the shaft: pour first, the water comes down with us
      srcCell = rim.clone()
      if (!await pourInto(bot, srcCell, opts.stop)) return out(false, 'the bucket would not go into ' + xyzOf(srcCell).join(',') + ' (nothing solid under or beside the rim to click)')
    }
    if (!await opts.openBelow()) return out(false, 'the cell under the rim could not be opened', { source: srcCell ? xyzOf(srcCell) : null })
    await sleep(500)
  }
  if (!srcCell) { // the column is open: the source goes into its highest air cell at or below the rim
    // the TOP OF THE WALL, not the open air over it: the highest cell of the column that still has walls around it (>= 3 solid sides).
    // A source on open ground washes the bot sideways instead of falling (measured 16:0xZ, the bot ended 4 blocks away).
    const walls = y => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => isSolidB(at(cx + dx, y, cz + dz))).length
    const open = y => { const b = at(cx, y, cz); return !!b && (isAirB(b) || b.name === 'water') } // water left by an earlier descent is an OPEN column, not a wall
    let ty = null
    for (let y = rim.y; y > floorY; y--) if (open(y) && walls(y) >= 3) { ty = y; break }
    if (ty == null) for (let y = rim.y; y > floorY; y--) if (open(y)) { ty = y; break }
    if (ty == null) return out(false, 'the column has no open cell under ' + [cx, rim.y, cz].join(','))
    srcCell = new Vec3(cx, ty, cz)
    const already = at(cx, ty, cz)
    if (!(already && already.name === 'water' && already.metadata === 0) && !await pourInto(bot, srcCell, opts.stop)) return out(false, 'the bucket would not go into ' + xyzOf(srcCell).join(',') + ' (no face of a wall beside it that the eye can see)')
  }
  await sleep(700)
  // ---- 4/5. STEP IN and SINK. A player does not fall through water, he SWIMS DOWN: sneak is held for the whole descent (1.13+ makes a
  // sneaking swimmer descend; measured 15:59Z without it: the bot floated at the top of the column for 40 s and went down 1 block).
  // Head under control: at most 20 s under water, and a jump for air whenever the bubbles run low.
  const inCol = () => { const p = bot.entity.position; return Math.floor(p.x) === cx && Math.floor(p.z) === cz }
  // ONE loop: step in, and stay in. Short 120 ms pulses, because a 250 ms pulse carried the bot straight ACROSS the 1-wide column and out
  // the other side (measured 16:1xZ). The instant the bot is over the column the legs stop and sneak takes over - that is the swim down.
  const tIn = Date.now(); let lastY = bot.entity.position.y; let still = 0; let air = 0; let pushes = 0
  while (!stop() && Date.now() - tIn < 45000) {
    const p = bot.entity.position
    if (Math.floor(p.y) <= floorY + 1) break
    if (!inCol()) {
      if (++pushes > 24) break
      try { bot.setControlState('forward', false); bot.setControlState('sneak', false) } catch (e_) { swallow('jobs_cavity:wdSn0', e_) }
      // WALK IN, do not charge in: the step down into the column is one block, which the read-only pathfinder does by itself. Raw forward
      // pulses carried the bot clean ACROSS the 1-wide column twice (16:1xZ, it ended one block past it on both tries).
      if (pushes <= 2) { if (await A.travel(bot, new Vec3(cx, srcCell.y, cz), { range: 0, ms: 12000, stop: opts.stop, quiet: true }) || inCol()) continue }
      if (Math.hypot(p.x - (cx + 0.5), p.z - (cz + 0.5)) > 3.5) { await A.travel(bot, { x: cx, y: null, z: cz }, { range: 2, ms: 15000, stop: opts.stop, quiet: true }); continue }
      // CREEP in and stop the LEGS the instant the body is over the column. A 110 ms pulse plus a poll carried the bot clean across the
      // 1-wide shaft (measured 16:1xZ: it crossed x -307 in 0.5 s at 69.4 and walked out the other side, sinking all the while).
      try {
        await bot.lookAt(new Vec3(cx + 0.5, p.y + 1.4, cz + 0.5), true)
        bot.setControlState('forward', true)
        for (let t = 0; t < 30 && !inCol() && !stop(); t++) await sleep(50)
      } catch (e_) { swallow('jobs_cavity:wdIn', e_) }
      try { bot.setControlState('forward', false) } catch (e_) { swallow('jobs_cavity:wdIn2', e_) }
      await sleep(150)
      continue
    }
    try { bot.setControlState('forward', false); bot.setControlState('sneak', true) } catch (e_) { swallow('jobs_cavity:wdSneak', e_) }
    if (bot.oxygenLevel != null && bot.oxygenLevel <= 6) { air++; try { bot.setControlState('sneak', false); bot.setControlState('jump', true); await sleep(700); bot.setControlState('jump', false) } catch (e_) { swallow('jobs_cavity:wdAir', e_) } ; if (air > 3) break }
    if (Date.now() - tIn > 20000 && bot.oxygenLevel != null && bot.oxygenLevel < 20) break // 20 s of head time is the budget
    if (Math.abs(p.y - lastY) < 0.02) { still++; if (still > 25) break } else still = 0 // it sinks ~0.6 blocks/s; 5 s without movement is a stall
    lastY = p.y
    await sleep(200)
  }
  try { bot.clearControlStates() } catch (e_) { swallow('jobs_cavity:wdClear', e_) }
  await sleep(600)
  const landed = Math.floor(bot.entity.position.y) <= floorY + 2
  // ---- 6. the LAST user takes the source back; then READ BACK whether any source is left (a forgotten source floods a fill site)
  let scooped = false
  if (opts.scoop) scooped = await scoopSource(bot, srcCell, opts.stop)
  const seenSrc = new Set()
  for (let y = floorY; y <= rim.y + 1; y++) for (const [x, z] of [[cx, cz], [rim.x, rim.z]]) { const b = at(x, y, z); if (b && b.name === 'water' && b.metadata === 0) seenSrc.add(x + ',' + y + ',' + z) }
  return out(landed, landed ? null : 'did not reach the floor ' + [cx, floorY, cz].join(','), { drop, scooped, source: xyzOf(srcCell), sources: seenSrc.size })
}
// put a liquid from the bucket INTO `cell`: click the face of a solid neighbour that points at the cell, then trust only what the server shows
async function pourInto (bot, cell, stop) {
  const A = require('./army'); const swallow = require('./swallow')
  const p = vv(cell)
  const is = () => { const b = bot.blockAt(p); return !!b && b.name === 'water' }
  if (is()) return true
  const e0 = bot.inventory.items().find(i => i.name === 'water_bucket'); if (!e0) return false
  // the floor under the cell FIRST (its top face is what a player clicks), then the walls, then the ceiling
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    if (stop && stop()) break
    const n = p.offset(dx, dy, dz); const nb = bot.blockAt(n)
    if (!isSolidB(nb) || SKY_BLIND_RE.test(nb.name)) continue
    // the centre of the face the two cells share, pulled 1/20 block into the neighbour so the ray lands on IT
    const pt = new Vec3(n.x + 0.5 - dx * 0.45, n.y + 0.5 - dy * 0.45, n.z + 0.5 - dz * 0.45)
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(pt) > 4.3) continue
    try {
      const hit = bot.world.raycast(eye, pt.minus(eye).normalize(), 5)
      if (!hit || !hit.position || hit.position.x !== n.x || hit.position.y !== n.y || hit.position.z !== n.z) continue
    } catch (e_) { swallow('jobs_cavity:pourRay', e_) }
    try {
      const it = bot.inventory.items().find(i => i.name === 'water_bucket'); if (!it) return false
      await bot.equip(it, 'hand')
      await bot.lookAt(pt, true); await sleep(200)
      bot.activateItem(); await sleep(450); bot.deactivateItem()
    } catch (e_) { swallow('jobs_cavity:pour', e_) }
    await sleep(400)
    if (is()) return true
    void A
  }
  return is()
}
// take a water SOURCE back into an empty bucket (only a source, never flowing water)
async function scoopSource (bot, at, stop) {
  const A = require('./army'); const swallow = require('./swallow')
  const p = vv(at)
  const b = bot.blockAt(p); if (!b || b.name !== 'water' || b.metadata !== 0) return false
  if (!A.count(bot, 'bucket')) return false
  const eye = bot.entity.position.offset(0, 1.62, 0); const tgt = p.offset(0.5, 0.9, 0.5)
  if (eye.distanceTo(tgt) > 4.3) return false
  if (stop && stop()) return false
  const had = A.count(bot, 'water_bucket')
  try {
    const e = bot.inventory.items().find(i => i.name === 'bucket'); if (!e) return false
    await bot.equip(e, 'hand'); await bot.lookAt(tgt, true); await sleep(200)
    bot.activateItem(); await sleep(450); bot.deactivateItem()
  } catch (e_) { swallow('jobs_cavity:scoop', e_) }
  for (let w = 0; w < 8 && A.count(bot, 'water_bucket') <= had; w++) await sleep(150)
  const nb = bot.blockAt(p)
  return A.count(bot, 'water_bucket') > had || !nb || nb.name !== 'water'
}

// ================================================================ the factory
module.exports = ctx => {
  const { A, U, VERBS, muster, task, swallow } = ctx
  const BL = () => require('./blocks') // the worker drops the whole lib cache on any edit: always the live copy

  // ---- eyes: the chunk data the bot itself has loaded (no Block objects, ~1 M cells/s)
  function botSid (bot) {
    let ck = null; let col = null
    return (x, y, z) => {
      const k = (x >> 4) + ',' + (z >> 4)
      if (k !== ck) { ck = k; try { col = bot.world.getColumn(x >> 4, z >> 4) } catch (e_) { col = null } }
      if (!col) return null
      try { return col.getBlockStateId({ x: x & 15, y, z: z & 15 }) } catch (e_) { return null }
    }
  }
  // THE POCKET TIDY BANKS OUR FILLER (army_jobs.js handover, ~line 4319: every 2 min a bot within 150 of the depot, above ground, carrying
  // `bulk > 96` gives back everything outside `keep`, and `keep.cobblestone` is 64 only for build/deck/tidy/light - for `cavity` it is 0).
  // Measured 16:2xZ: Riko stood in a 276-cell hole with an empty inventory and placed nothing for a whole slice. Until `cavity` is in that
  // regex (REQUESTED from the army_jobs.js owner), this front postpones the tidy while it is carrying its own load - it never disables it.
  const holdPockets = bot => { try { bot.__armyPocketT = Date.now() } catch (e_) { swallow('jobs_cavity:hold', e_) } }
  const paramsBox = P => Array.isArray(P.box) && P.box.length === 4 ? P.box.slice() : baseBox(A)
  const paramsYMin = P => Number.isFinite(P.yMin) ? P.yMin : 30
  const paramsYTop = P => Number.isFinite(P.yTop) ? P.yTop : baseY(A) + 52

  // ---------------------------------------------------------------- PART 1: SEE
  async function survey (bot, job, api, P) {
    const full = paramsBox(P); const yMin = paramsYMin(P); const yTop = paramsYTop(P)
    // A BOT IS NOT A CAMERA. The whole base box is 3.1 M cells: reading it in one go blocks the shard's event loop for seconds (the shard
    // watchdog kills a hung API), and a bot only has ~12 chunks loaded anyway. So a bot surveys its OWN window and the merge in
    // writeCensus keeps what other eyes saw; full coverage of the box is `node ops/cavity-census.js` (SkyEye, 17 s, one process).
    const me = bot.entity.position; const r = Math.max(16, Math.min(P.radius || 80, 128))
    const box = [Math.max(full[0], Math.floor(me.x) - r), Math.max(full[1], Math.floor(me.z) - r), Math.min(full[2], Math.floor(me.x) + r), Math.min(full[3], Math.floor(me.z) + r)]
    if (box[0] > box[2] || box[1] > box[3]) return 'cavity: this bot stands outside the surveyed box ' + full.join(',')
    task(bot, 'cavity: surveying x ' + box[0] + '..' + box[2] + ' / z ' + box[1] + '..' + box[3] + ' y ' + yMin + '..' + yTop)
    const t0 = Date.now()
    const G = newGrid(box, yMin, yTop)
    readInto(G, G.box, botSid(bot), coder(bot.registry))
    if (!G.cols) return 'cavity: not one column of the box is loaded here'
    const PS = planSets(A, box)
    markPlan(G, PS)
    const list = analyse(G, { maxCells: P.maxCells || 400, blockedCol: PS.blockedCol })
    const doc = writeCensus(A, G, list, bot.username)
    const worst = doc.list.filter(isTarget).slice(0, 5).map(e => ({ at: e.at, cells: e.cells, depth: e.depth }))
    A.result(bot, { ev: 'cavity_census', n: doc.targets, cells: doc.list.filter(isTarget).reduce((n, e) => n + e.cells, 0), spawnable: doc.spawnable, coverage: doc.coverage, counts: doc.counts, worst, ms: Date.now() - t0 })
    return 'cavity: census ' + doc.targets + ' targets (' + doc.spawnable + ' spawnable cells) from x ' + box[0] + '..' + box[2] + ' / z ' + box[1] + '..' + box[3]
  }

  // ---------------------------------------------------------------- claims: two bots are never on one cavity
  function claimRead () { return A.readJSON(CLAIM_F, {}) || {} }
  async function claimTake (bot, id, ttl) {
    let got = false
    await U.withLock('cavity_claims', () => {
      const d = A.readJSON(CLAIM_F, {}) || {}; const now = Date.now()
      for (const k of Object.keys(d)) if (!d[k].done && now - (d[k].t || 0) > (d[k].ttl || 900000)) delete d[k]
      const cur = d[id]
      if (cur && cur.done) return
      if (cur && cur.bot !== bot.username && now - cur.t < (cur.ttl || 900000)) return
      d[id] = { bot: bot.username, t: now, ttl }
      A.writeJSON(CLAIM_F, d); got = true
    }, 15000)
    return got
  }
  async function claimEnd (bot, id, rec) {
    await U.withLock('cavity_claims', () => {
      const d = A.readJSON(CLAIM_F, {}) || {}
      if (rec && rec.done) d[id] = Object.assign({ bot: bot.username, t: Date.now(), done: true }, rec)
      else if (d[id] && d[id].bot === bot.username) {
        if (rec && rec.cool) d[id] = { bot: bot.username, t: Date.now(), ttl: rec.cool, why: rec.why, cool: true }
        else delete d[id]
      }
      A.writeJSON(CLAIM_F, d)
    }, 15000)
  }
  function markDone (id, patch) { // cavities.json is the board of this front: a filled cavity leaves it at once
    try {
      const doc = A.readJSON(CAV_F, null); if (!doc || !Array.isArray(doc.list)) return
      const e = doc.list.find(q => q.id === id); if (!e) return
      Object.assign(e, patch)
      doc.targets = doc.list.filter(isTarget).length; doc.spawnable = doc.list.filter(isTarget).reduce((n, q) => n + q.spawnable, 0)
      A.writeJSON(CAV_F, doc)
    } catch (e_) { swallow('jobs_cavity:markDone', e_) }
  }

  // ---------------------------------------------------------------- reading the world back, live, through the bot's own eyes
  function topOpaqueAt (bot, x, z, cache) {
    const k = x + ',' + z; if (cache.has(k)) return cache.get(k)
    let t = NOTOP
    for (let y = 150; y >= 0; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.boundingBox === 'block' && !SKY_BLIND_RE.test(b.name)) { t = y; break } }
    cache.set(k, t); return t
  }
  // the component around `seed` as it stands NOW (the census file may be an hour old)
  function liveComponent (bot, seed, limit) {
    const cache = new Map(); const seen = new Set(); const cells = []
    let sky = false; let partial = false; let wet = false; let capped = false
    const st = [vv(seed)]; seen.add(keyOf(st[0]))
    while (st.length) {
      const p = st.pop(); cells.push(p)
      if (cells.length >= limit) { capped = true; break }
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = p.offset(dx, dy, dz); const k = keyOf(q)
        if (seen.has(k)) continue
        seen.add(k)
        const b = bot.blockAt(q)
        if (!b) { partial = true; continue }
        if (LIQUID_RE.test(b.name)) { wet = true; continue }
        if (!isAirB(b)) continue
        if (q.y > topOpaqueAt(bot, q.x, q.z, cache)) { sky = true; continue }
        st.push(q)
      }
    }
    const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]
    for (const p of cells) { if (p.x < bb[0]) bb[0] = p.x; if (p.y < bb[1]) bb[1] = p.y; if (p.z < bb[2]) bb[2] = p.z; if (p.x > bb[3]) bb[3] = p.x; if (p.y > bb[4]) bb[4] = p.y; if (p.z > bb[5]) bb[5] = p.z }
    return { cells, sky, partial, wet, capped, bbox: bb, topAt: (x, z) => topOpaqueAt(bot, x, z, cache) }
  }
  // GRADE: the ground level AROUND an open scar, so its mouth is closed level with the yard and not one block short or proud
  function gradeOf (comp, cols) {
    const ys = []; const names = {}
    for (const k of cols) {
      const [x, z] = k.split(',').map(Number)
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue
        if (cols.has((x + dx) + ',' + (z + dz))) continue
        const t = comp.topAt(x + dx, z + dz); if (t !== NOTOP) ys.push(t)
      }
    }
    if (!ys.length) return null
    ys.sort((a, b) => a - b)
    void names
    return ys[Math.floor(ys.length / 2)]
  }

  // ---------------------------------------------------------------- kit
  const fillerIn = (bot, prefer) => (prefer ? [prefer].concat(FILLERS) : FILLERS).find(n => A.count(bot, n) > 0) || null
  const restoreItem = (bot, name) => { const n = RESTORE[name] || name; return bot.registry.itemsByName[n] ? n : 'dirt' }
  async function stockUp (bot, job, api, P, need) {
    const filler = P.filler || 'cobblestone'
    const reserve = ((P.needStock || {})[filler]) || 0
    if (A.stockOf(filler) <= reserve && !A.count(bot, filler)) { A.decline(bot, job, 900000, 'cavity: the depot holds ' + A.stockOf(filler) + ' ' + filler + ', at or below the reserve ' + reserve); return null }
    await A.kitUp(bot, { stop: api.stop, why: 'cavity' }).catch(e_ => swallow('jobs_cavity:kit', e_))
    const want = Math.max(64, Math.min(448, need))
    if (A.count(bot, filler) < want) await A.withdraw(bot, filler, want - A.count(bot, filler), { stop: api.stop })
    if (!fillerIn(bot, filler)) for (const alt of FILLERS) { if (A.stockOf(alt) > 64) { await A.withdraw(bot, alt, want, { stop: api.stop }); if (A.count(bot, alt)) break } }
    if (A.count(bot, 'dirt') < 8) await A.withdraw(bot, 'dirt', 16, { stop: api.stop })
    if (A.count(bot, 'torch') < 4) await A.withdraw(bot, 'torch', 8, { stop: api.stop })
    if (!A.count(bot, 'water_bucket')) await A.withdraw(bot, 'water_bucket', 1, { stop: api.stop })
    if (!A.count(bot, 'bucket')) await A.withdraw(bot, 'bucket', 1, { stop: api.stop })
    // THE DEPOT HOLDS 16 EMPTY BUCKETS AND ONE FULL ONE: a bot that is going to need the water descent fills its own at the nearest water,
    // the way a player does, instead of queueing for the single water_bucket on the shelf (verb `fill` = ONE implementation of that click)
    if (!A.count(bot, 'water_bucket') && A.count(bot, 'bucket')) {
      const w = U.findBlocksByName(bot, ['water'], 64, 4)[0]
      if (w) { task(bot, 'cavity: filling the bucket at ' + [w.x, w.y, w.z].join(',')); await VERBS.fill(bot, { at: [w.x, w.y, w.z] }, api).catch(e_ => swallow('jobs_cavity:fillBucket', e_)) }
    }
    if (!A.bestOf(bot, 'pickaxe')) await A.obtain(bot, 'stone_pickaxe', 1, { stop: api.stop })
    // GO OUT LOADED OR DO NOT GO (16:1xZ: a bot stood in a 155-cell cavity with `placed:0` because its pockets held one stray block): the
    // walk out is 60-150 blocks, so a half-empty trip is a wasted slice, not a partial fill.
    const it = fillerIn(bot, filler)
    holdPockets(bot)
    const have = FILLERS.reduce((n, k) => n + A.count(bot, k), 0)
    if (!it || have < 32) { A.result(bot, { ev: 'cavity_no_filler', want, have, depot: A.stockOf(filler) }); A.decline(bot, job, 300000, 'cavity: only ' + have + ' filler blocks came out of the depot'); return null }
    return it
  }

  // ---- THE SHAFT: stand on the top cell, read the two cells under the feet before every dig, go down
  async function digShaft (bot, job, api, top, log) {
    const B = BL()
    const x = top.at[0]; const z = top.at[2]; const sy = top.at[1]; const feetY = top.entryY
    if (!await A.travel(bot, { x, y: sy + 1, z }, { range: 0, ms: 120000, stop: api.stop, quiet: true }) &&
        !await A.travel(bot, { x, y: null, z }, { range: 3, ms: 90000, stop: api.stop })) return { ok: false, why: 'no_route to the surface cell ' + top.at.join(',') }
    await sleep(300)
    let source = null; let off = 0; let dug = 0
    for (let guard = 0; guard < 64 && !api.stop(); guard++) {
      holdPockets(bot)
      const feet = bot.entity.position.floored()
      if (feet.y <= feetY) return { ok: true, source }
      if (feet.x !== x || feet.z !== z) {
        off++
        if (off > 6 || !await A.travel(bot, { x, y: feet.y, z }, { range: 0, ms: 15000, stop: api.stop, quiet: true })) return { ok: false, why: 'stepped off the shaft column at ' + xyzOf(feet).join(','), source }
        await B.centreOn(bot, new Vec3(x, bot.entity.position.floored().y, z)).catch(e_ => swallow('jobs_cavity:centre', e_))
        continue
      }
      const below = feet.offset(0, -1, 0)
      const b = bot.blockAt(below)
      if (!b) return { ok: false, why: 'the chunk under ' + xyzOf(below).join(',') + ' is not loaded', source }
      if (isAirB(b)) { await sleep(500); continue } // gravity has not finished with us yet
      // READ BEFORE YOU DIG
      if (HARD_RE.test(b.name) || A.ourBlock(below, b.name) || U.protectedBlock(b)) return { ok: false, why: b.name + ' at ' + xyzOf(below).join(',') + ' is not ours to dig', source }
      if (GRAVITY_RE.test(b.name)) return { ok: false, why: 'gravel/sand at ' + xyzOf(below).join(',') + ' - another column', source }
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) {
        const q = below.offset(dx, dy, dz); const n = bot.blockAt(q)
        if (n && n.name === 'lava') return { ok: false, why: 'lava at ' + xyzOf(q).join(',') + ' beside the shaft', source }
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { // water beside the cell we are about to open is PLUGGED first
        const q = below.offset(dx, 0, dz); const n = bot.blockAt(q)
        if (n && n.name === 'water') {
          const item = fillerIn(bot); if (!item) return { ok: false, why: 'water at ' + xyzOf(q).join(',') + ' and nothing to plug it with', source }
          const r = await A.placeHard(bot, q, item, { stop: api.stop, noRest: true })
          if (!r.ok) return { ok: false, why: 'water at ' + xyzOf(q).join(',') + ' could not be plugged: ' + r.reason, source }
          log.push(keyOf(q))
        }
      }
      // how far would we FALL if we opened this cell?
      let floorY = null
      for (let y = below.y - 1; y >= below.y - 34; y--) { const q = bot.blockAt(new Vec3(x, y, z)); if (!q) break; if (q.name === 'lava') return { ok: false, why: 'lava in the column under ' + xyzOf(below).join(','), source } ; if (isSolidB(q)) { floorY = y; break } }
      const drop = floorY == null ? 99 : below.y - floorY - 1 + 1 // the fall from the feet to the landing
      if (drop > 3) {
        // THE OWNER'S 水バケツ降り, through the one exported implementation: the source goes in first, THEN the floor under us is opened
        task(bot, 'cavity: water bucket, ' + drop + ' blocks down')
        const wd = await waterDescent(bot, {
          rim: xyzOf(feet),
          column: [x, z],
          floorY,
          stop: api.stop,
          openBelow: async () => { const r = await B.digBlock(bot, below, { collect: true, requireHarvest: false, allowUnderFeet: true }); if (r.ok) log.push(keyOf(below)); return r.ok }
        })
        source = wd.source ? vv(wd.source) : source
        if (!wd.ok) return { ok: false, why: 'water descent: ' + wd.why, source }
        continue
      }
      // allowUnderFeet: a 1x1 shaft IS dug from on top of it - and it is only safe because the two cells below were READ first (above)
      const r = await B.digBlock(bot, below, { collect: true, requireHarvest: false, allowUnderFeet: true })
      if (!r.ok) return { ok: false, why: 'dig ' + b.name + ' at ' + xyzOf(below).join(',') + ': ' + r.reason, source }
      log.push(keyOf(below)); dug++
      await sleep(400)
    }
    return { ok: false, why: 'the shaft stopped at y ' + bot.entity.position.floored().y + ' short of ' + feetY + ' (' + dug + ' cells dug)', source }
  }
  // 1-3 cells of tunnel at depth, when the ground straight over the hole is a building, a field, a pen or a road
  async function digTunnel (bot, api, cells) {
    const B = BL()
    for (const c of cells || []) {
      if (api.stop()) return false
      const p = vv(c); const b = bot.blockAt(p)
      if (!b || isAirB(b)) continue
      if (HARD_RE.test(b.name) || GRAVITY_RE.test(b.name) || A.ourBlock(p, b.name) || U.protectedBlock(b)) return false
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) { const n = bot.blockAt(p.offset(dx, dy, dz)); if (n && n.name === 'lava') return false }
      const r = await B.digBlock(bot, p, { collect: true, requireHarvest: false })
      if (!r.ok) return false
      await sleep(200)
    }
    return true
  }

  // ---- THE FILL: lowest cell first, from inside, standing on its own fill (a player never decks a hole)
  async function fillCells (bot, api, want, item0, deadline, opts) {
    let item = item0; let placed = 0; let dry = 0
    const fails = new Map()
    const bump = (p, n) => fails.set(keyOf(p), (fails.get(keyOf(p)) || 0) + (n || 1))
    const bad = p => (fails.get(keyOf(p)) || 0) >= 5 // a cell is given up on only after five real tries: 16:3xZ a 9-cell hole was left with ONE cell open
    while (!api.stop() && Date.now() < deadline) {
      holdPockets(bot)
      for (const [k, p] of [...want]) { const b = bot.blockAt(p); if (b && isSolidB(b)) want.delete(k) }
      if (!want.size) break
      if (A.count(bot, item) < 1) {
        const nx = fillerIn(bot)
        if (nx) item = nx
        else if (opts && opts.refill && await opts.refill()) { item = fillerIn(bot) || item; if (A.count(bot, item) < 1) break } else break
      }
      const me = bot.entity.position; const eye = me.offset(0, 1.62, 0); const feet = me.floored()
      const list = [...want.values()].sort((a, b) => a.y - b.y || a.distanceTo(me) - b.distanceTo(me))
      const open = list.filter(p => !bad(p)); if (!open.length) break
      const lowest = open[0].y
      let did = false
      if (dry > 20) break // twelve passes in a row that changed nothing in the world: the rest of this hole is out of reach from in here
      // the cell I stand in, and it is the lowest work left: jump, place under the feet, ride up with it
      const mineCell = open.find(p => p.x === feet.x && p.z === feet.z && p.y === feet.y && p.y <= lowest)
      if (mineCell) {
        const it = INSIDE_FILL_RE.test(item) ? item : (FILLERS.find(n => A.count(bot, n) > 0 && INSIDE_FILL_RE.test(n)) || item)
        if (await A.fillInside(bot, mineCell, it, { stop: api.stop })) { placed++; want.delete(keyOf(mineCell)); did = true } else bump(mineCell)
      }
      if (!did) {
        for (const p of open.filter(q => q.y <= lowest + 1).slice(0, 8)) {
          if (api.stop()) break
          if (p.distanceTo(eye) > 4.2) continue
          if (p.x === feet.x && p.z === feet.z && (p.y === feet.y || p.y === feet.y + 1)) continue // never brick myself in
          const r = await A.placeHard(bot, p, item, { stop: api.stop, fill: true, noInside: true, noRest: true })
          if (r.ok) { placed++; want.delete(keyOf(p)); did = true; break }
          bump(p)
        }
      }
      if (!did) { // walk to it: a stand beside the cell, at its level or one under it
        const tgt = open[0]; let moved = false
        const stands = []
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          for (const dy of [0, -1, 1]) {
            const c = tgt.offset(dx, dy, dz)
            if (isSolidB(bot.blockAt(c.offset(0, -1, 0))) && isAirB(bot.blockAt(c)) && isAirB(bot.blockAt(c.offset(0, 1, 0)))) stands.push(c)
          }
        }
        stands.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
        for (const s of stands.slice(0, 4)) { if (api.stop()) break; if (await A.travel(bot, s, { range: 0, ms: 20000, stop: api.stop, quiet: true })) { moved = true; break } }
        if (!moved) bump(tgt, 2)
      }
      dry = did ? 0 : dry + 1
      await sleep(60)
    }
    return { placed, left: want.size, item }
  }

  // RIDE THE SHAFT OUT (the owner's 埋めながら上まで上がる): place under the feet, rise with the block, repeat. fillCells does this too, but only
  // while the shaft cell is the LOWEST work left - a cavity whose last cells sit beside the shaft foot left 1-2 shaft cells open (16:07Z Ume).
  async function rideOut (bot, api, col, topY, item) {
    let n = 0
    for (let guard = 0; guard < 48 && !api.stop(); guard++) {
      const feet = bot.entity.position.floored()
      if (feet.y >= topY) break
      if (feet.x !== col[0] || feet.z !== col[1]) { if (!await A.travel(bot, { x: col[0], y: feet.y, z: col[1] }, { range: 0, ms: 15000, stop: api.stop, quiet: true })) break; continue }
      const b = bot.blockAt(feet); if (b && isSolidB(b)) break
      const it = INSIDE_FILL_RE.test(item) ? item : (fillerIn(bot) || item)
      if (!it || !await A.fillInside(bot, feet, it, { stop: api.stop })) break
      n++
    }
    return n
  }

  // ---------------------------------------------------------------- PART 2: FIX — one bot, one cavity, the owner's algorithm
  async function fillOne (bot, job, api, P, ent) {
    const B = BL()
    const t0 = Date.now()
    const deadline = t0 + Math.min((P.minutes || 12) * 60000, 13 * 60000)
    // 1. KIT FIRST, at the depot, before the walk out (a bot that walks out and then remembers the cobblestone walks twice)
    const item0 = await stockUp(bot, job, api, P, ent.cells + 48)
    if (!item0) return { ok: false, why: 'no filler: depot ' + (P.filler || 'cobblestone') + ' ' + A.stockOf(P.filler || 'cobblestone'), declined: true }
    // 2. GO AND LOOK
    const tops0 = (ent.tops || []).map(t => t.at)
    const to = tops0[0] || [ent.at[0], ent.at[1], ent.at[2]]
    task(bot, 'cavity: walking to ' + to.join(','))
    holdPockets(bot)
    if (!await A.travel(bot, { x: to[0], y: null, z: to[2] }, { range: 4, ms: 300000, stop: api.stop, onHop: () => holdPockets(bot) })) return { ok: false, why: 'no_route to ' + to.join(',') }
    holdPockets(bot)
    await sleep(600)
    // 3. re-read the hole in the world. A NECK carries its own cell list (it was cut out of a cave component the bot must not flood-fill).
    let comp
    if (Array.isArray(ent.list) && ent.list.length) {
      const all = ent.list.map(vv)
      if (all.some(p => !bot.blockAt(p))) return { ok: false, why: 'chunks around ' + ent.at.join(',') + ' are not loaded' }
      const cells = all.filter(p => isAirB(bot.blockAt(p)))
      if (!cells.length) return { ok: false, why: 'the scar at ' + ent.at.join(',') + ' is already closed', done: true }
      const cache = new Map()
      comp = { cells, sky: true, partial: false, wet: false, capped: false, bbox: boxOfPts(cells), topAt: (x, z) => topOpaqueAt(bot, x, z, cache) }
    } else {
      comp = liveComponent(bot, vv(ent.at), (P.maxCells || 400) + 60)
      if (!comp.cells.length) return { ok: false, why: 'nothing but rock at ' + ent.at.join(',') + ' - already filled', done: true }
      if (comp.partial) return { ok: false, why: 'chunks around ' + ent.at.join(',') + ' are not loaded' }
      if (comp.capped) return { ok: false, why: 'the component at ' + ent.at.join(',') + ' is over ' + ((P.maxCells || 400) + 60) + ' cells now - not a cavity', stale: true }
      if (comp.sky && ent.type !== 'escape_stair') return { ok: false, why: 'the component at ' + ent.at.join(',') + ' is open to the sky now - that is fill_void work', stale: true }
    }
    const cols = new Set(comp.cells.map(p => p.x + ',' + p.z))
    // 4. the work set: the hole; for an open scar also everything up to the GRADE of the ground around it, its top cells restored as surface.
    // A NECK over a cave is plugged from its lowest cell WITH A FLOOR: what hangs under that is the cave's own ceiling, not our hole.
    let hang = 0
    if (ent.neck) {
      const base = comp.cells.filter(p => isSolidB(bot.blockAt(p.offset(0, -1, 0)))).map(p => p.y).sort((a, b) => a - b)[0]
      if (base != null) { const before = comp.cells.length; comp.cells = comp.cells.filter(p => p.y >= base); hang = before - comp.cells.length }
    }
    const want = new Map(); for (const p of comp.cells) want.set(keyOf(p), p)
    const restoreList = []; const capCells = []
    if (comp.sky) {
      const grade = gradeOf(comp, cols)
      if (grade == null) return { ok: false, why: 'cannot read the ground level around ' + ent.at.join(',') }
      for (const k of cols) {
        const [x, z] = k.split(',').map(Number)
        for (let y = comp.bbox[1]; y <= grade; y++) { const q = new Vec3(x, y, z); if (want.has(keyOf(q))) continue; const b = bot.blockAt(q); if (b && isAirB(b)) { want.set(keyOf(q), q); capCells.push(q) } }
        const topQ = new Vec3(x, grade, z); const tb = bot.blockAt(topQ)
        if (tb && isAirB(tb)) { want.delete(keyOf(topQ)); const ring = bot.blockAt(new Vec3(x + 2, comp.topAt(x + 2, z), z)); restoreList.push({ at: topQ, name: ring ? ring.name : 'grass_block' }) }
      }
      if (capCells.length > 160) return { ok: false, why: 'the scar at ' + ent.at.join(',') + ' needs ' + capCells.length + ' cells above the component - that is a pit, not a staircase', stale: true }
    }
    // 5. GET IN
    const log = []; let source = null
    if (comp.sky) { // an escape staircase is already open: walk down it, never cut a second hole
      const low = comp.cells.slice().sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
      task(bot, 'cavity: down the escape stair to ' + xyzOf(low).join(','))
      if (!await A.travel(bot, low, { range: 1, ms: 180000, stop: api.stop })) return { ok: false, why: 'no_route down the scar to ' + xyzOf(low).join(',') }
    } else {
      const PS = planSets(A, paramsBox(P))
      const tops = (ent.tops || []).filter(t => !PS.blockedCol(t.at[0], t.at[2]))
      if (!tops.length) return { ok: false, why: 'no free surface cell over ' + ent.at.join(',') + ' (building / field / pen / road / furniture)' }
      let got = null; const sCache = new Map(); const skipped = []
      for (const t0 of tops.slice(0, 4)) {
        if (api.stop()) break
        // THE SURFACE MOVES while we walk: the cap crews lay dirt over the base all day, so the census's y is a hint and the world is the
        // truth (16:2xZ: `no shaft could be cut` x6 because every candidate's recorded top cell now read `air`).
        const sy = topOpaqueAt(bot, t0.at[0], t0.at[2], sCache)
        if (sy === NOTOP || sy <= t0.entryY) { skipped.push(t0.at.join(',') + ':no ground'); continue }
        const t = Object.assign({}, t0, { at: [t0.at[0], sy, t0.at[2]], shaft: sy - t0.entryY })
        const sb = bot.blockAt(vv(t.at))
        if (!sb || !isSolidB(sb) || GRAVITY_RE.test(sb.name) || HARD_RE.test(sb.name) || A.ourBlock(vv(t.at), sb.name) || A.penAt(t.at[0], t.at[1], t.at[2], bot)) { skipped.push(t.at.join(',') + ':' + (sb ? sb.name : 'not loaded')); continue }
        task(bot, 'cavity: shaft at ' + t.at.join(',') + ' down to ' + t.entryY + (t.tunnel && t.tunnel.length ? ' + ' + t.tunnel.length + ' tunnel cells' : ''))
        const r = await digShaft(bot, job, api, t, log)
        source = r.source || source
        if (r.ok && t.tunnel && t.tunnel.length && !await digTunnel(bot, api, t.tunnel)) { A.result(bot, { ev: 'cavity_shaft_failed', at: t.at, why: 'the sideways tunnel to ' + (t.to || []).join(',') + ' could not be cut' }); continue }
        if (r.ok) { got = Object.assign({ name: sb.name }, t); break }
        A.result(bot, { ev: 'cavity_shaft_failed', at: t.at, why: String(r.why).slice(0, 90) })
      }
      if (!got) return { ok: false, why: 'no shaft could be cut over ' + ent.at.join(',') + (skipped.length ? ' (' + skipped.slice(0, 4).join(' ') + ')' : ''), source }
      for (let y = got.at[1] - 1; y >= got.entryY; y--) { const q = new Vec3(got.at[0], y, got.at[2]); want.set(keyOf(q), q) } // the shaft is filled too
      for (const c of got.tunnel || []) { const q = vv(c); want.set(keyOf(q), q) } // ...and so is the tunnel
      restoreList.push({ at: vv(got.at), name: got.name }) // ...and its top cell gets the surface material back
    }
    // 6. a torch first: the light stops the spawns, the core combat module fights what is already in here
    try { if (A.count(bot, 'torch')) await B.placeTorch(bot, bot.entity.position.floored(), { stop: api.stop }).catch(e_ => swallow('jobs_cavity:torch', e_)) } catch (e_) { swallow('jobs_cavity:torch2', e_) }
    // 7. FILL, bottom-up, from the inside
    task(bot, 'cavity: filling ' + want.size + ' cells at ' + ent.at.join(','))
    // ONE walk back for more when the pockets run dry mid-hole (a player does exactly that); after it the loop walks itself back to the work
    let refills = 0
    const refill = async () => {
      if (refills >= 1 || Date.now() > deadline - 180000 || api.stop()) return false
      refills++
      const f = P.filler || 'cobblestone'
      task(bot, 'cavity: back to the depot for more ' + f)
      const n = await A.withdraw(bot, f, 256, { stop: api.stop })
      A.result(bot, { ev: 'cavity_refill', item: f, n, at: ent.at })
      return n > 0
    }
    let r1 = await fillCells(bot, api, want, item0, deadline, { refill })
    // 7b. whatever is left of the shaft column is ridden out from the inside, then one more pass for anything that fell behind
    for (const q of restoreList) {
      if (api.stop() || Date.now() > deadline) break
      const rose = await rideOut(bot, api, [q.at.x, q.at.z], q.at.y, r1.item)
      if (rose) { r1.placed += rose; for (const k of [...want.keys()]) { const p = want.get(k); const bb = bot.blockAt(p); if (bb && isSolidB(bb)) want.delete(k) } }
    }
    if (want.size) { const r2 = await fillCells(bot, api, want, r1.item, deadline, { refill }); r1 = { placed: r1.placed + r2.placed, left: r2.left, item: r2.item } }
    // 8. the surface cells, as they were
    const restored = []
    for (const q of restoreList) {
      const it = restoreItem(bot, q.name)
      if (!A.count(bot, it)) await A.withdraw(bot, it, 8, { stop: api.stop })
      const b = bot.blockAt(q.at)
      if (b && isAirB(b) && A.count(bot, it)) {
        const feet = bot.entity.position.floored()
        if (feet.x === q.at.x && feet.z === q.at.z && feet.y === q.at.y) await A.fillInside(bot, q.at, it, { stop: api.stop })
        else await A.placeHard(bot, q.at, it, { stop: api.stop, fill: true, noRest: true })
      }
      const nb = bot.blockAt(q.at); restored.push(nb ? nb.name : 'air')
    }
    // 9. the water comes back into the bucket (if the shaft fill has not already taken the source)
    let scooped = false
    if (source) scooped = await scoopSource(bot, source, api.stop)
    try { await B.removeScaffold(bot).catch(e_ => swallow('jobs_cavity:scaf', e_)) } catch (e_) { swallow('jobs_cavity:scaf2', e_) }
    // 10. VERIFY against the world, never against the intention
    await sleep(600)
    let left = 0; const leftAt = []
    for (const p of comp.cells.concat(capCells)) { const b = bot.blockAt(p); if (!b || isAirB(b) || LIQUID_RE.test(b.name)) { left++; if (leftAt.length < 3) leftAt.push(xyzOf(p).join(',')) } }
    let shaftLeft = 0
    for (const q of restoreList) for (let y = q.at.y; y >= comp.bbox[4]; y--) { const b = bot.blockAt(new Vec3(q.at.x, y, q.at.z)); if (!b || isAirB(b) || LIQUID_RE.test(b.name)) shaftLeft++ }
    const badTop = restored.filter(n => n === 'air').length
    const ok = left === 0 && shaftLeft === 0 && badTop === 0
    return {
      ok,
      placed: r1.placed,
      cells: comp.cells.length + capCells.length,
      left,
      shaftLeft,
      leftAt,
      restored,
      scooped,
      hang,
      top: restoreList.map(q => xyzOf(q.at).join(',')),
      tookS: Math.round((Date.now() - t0) / 1000),
      why: ok ? null : left + ' cells + ' + shaftLeft + ' shaft cells still open, ' + badTop + ' surface cells not restored' + (leftAt.length ? ' (' + leftAt.join(' ') + ')' : '')
    }
  }

  // ---------------------------------------------------------------- the handler
  async function cavity (bot, job, api, ctx2) {
    const P = job.params || {}
    if (A.dimOf(bot) !== 'overworld') return muster(bot, job, api, ctx2, 'cavity: overworld only')
    if ((P.work || 'fill') === 'survey') {
      const r = await survey(bot, job, api, P)
      if (!P.standing) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && (j.rev || 0) === (job.rev || 0) && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: ' + r } })
      return r
    }
    // the census is the work list. Stale or missing -> this bot LOOKS first (with its own eyes, over what it can see).
    let doc = A.readJSON(CAV_F, null)
    if (!doc || !Array.isArray(doc.list) || Date.now() - (doc.t || 0) > (P.maxAgeMin || 90) * 60000) {
      await survey(bot, job, api, P)
      doc = A.readJSON(CAV_F, null)
    }
    if (!doc || !Array.isArray(doc.list)) return muster(bot, job, api, ctx2, 'cavity: no census could be written')
    const claims = claimRead(); const now = Date.now()
    const free = doc.list.filter(isTarget).filter(e => {
      const c = claims[e.id]
      if (!c) return true
      if (c.done) return false
      // a cavity that just beat somebody RESTS - including for the bot that lost against it (15:57Z: Noa re-took -355,52,-508 three times in 12 s)
      if (c.cool) return now - (c.t || 0) > (c.ttl || 900000)
      if (c.bot === bot.username) return true
      return now - (c.t || 0) > (c.ttl || 900000)
    })
    if (!free.length) {
      const open = doc.list.filter(isTarget).length
      if (!open && !P.standing) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: the census reads 0 targets under the base (' + JSON.stringify(doc.counts) + ')' } })
      A.result(bot, { ev: 'cavity_none', open, claimed: Object.keys(claims).length })
      A.decline(bot, job, 600000, 'cavity: every target is claimed by a mate')
      return muster(bot, job, api, ctx2, 'cavity: nothing free to fill')
    }
    // SMALL AND NEAR FIRST: a bot has ~12 min, and one 275-cell hole spends it all while nine 15-cell holes beside it keep spawning mobs.
    // The big ones are still taken - they just wait until the cheap ones are gone (and each pass leaves them smaller).
    const me = bot.entity.position
    const cost = e => Math.hypot(e.at[0] - me.x, e.at[2] - me.z) + e.cells * 1.5 - e.spawnable * 0.5
    free.sort((a, b) => cost(a) - cost(b))
    let ent = null
    for (const e of free.slice(0, 6)) { if (await claimTake(bot, e.id, 16 * 60000)) { ent = e; break } }
    if (!ent) return muster(bot, job, api, ctx2, 'cavity: a mate took every target first')
    task(bot, 'cavity: ' + ent.type + ' ' + ent.at.join(',') + ' (' + ent.cells + ' cells, ' + ent.spawnable + ' spawnable)')
    let r = null
    try { r = await fillOne(bot, job, api, P, ent) } catch (e_) { swallow('jobs_cavity:fillOne', e_); r = { ok: false, why: 'error: ' + String(e_ && e_.message).slice(0, 80) } }
    if (r.ok) {
      await claimEnd(bot, ent.id, { done: true, placed: r.placed })
      markDone(ent.id, { type: 'filled', spawnable: 0, filled: Date.now(), by: bot.username })
      A.result(bot, { ev: 'cavity_filled', at: ent.at, kind: ent.type + (ent.neck ? '/neck' : ''), cells: r.cells, placed: r.placed, top: r.top, restored: r.restored, scooped: r.scooped, hang: r.hang || 0, tookS: r.tookS })
      return 'cavity: filled ' + ent.at.join(',') + ' (' + r.placed + ' blocks, ' + r.tookS + ' s)'
    }
    if (r.done || r.stale) { markDone(ent.id, { type: r.done ? 'filled' : 'stale', spawnable: 0 }); await claimEnd(bot, ent.id, { done: true, why: r.why }) } else await claimEnd(bot, ent.id, { cool: 20 * 60000, why: String(r.why).slice(0, 80) })
    A.result(bot, { ev: 'cavity_failed', at: ent.at, kind: ent.type, why: String(r.why).slice(0, 110), placed: r.placed || 0, left: r.left == null ? null : r.left })
    if (r.declined) return muster(bot, job, api, ctx2, 'cavity: ' + r.why)
    return 'cavity: ' + ent.at.join(',') + ' not closed - ' + String(r.why).slice(0, 80)
  }

  return { types: { cavity }, verbs: {} }
}
module.exports.TYPES = ['cavity']
module.exports.VERBS = []
// ONE implementation, used by the job and by anybody else: the water-bucket descent (owner 09-20) and the census with two pairs of eyes —
// the bot's loaded chunks (job `cavity` work:'survey') and the spectator camera (ops/cavity-census.js, full coverage). All of it pure/serverless.
module.exports.waterDescent = waterDescent
module.exports.pourInto = pourInto
module.exports.scoopSource = scoopSource
module.exports.census = { newGrid, readInto, markPlan, analyse, coder, planSets, baseBox, baseY, writeCensus, table, isTarget, gIdx, gCol, gIn, gDecode, CAV_F, CLAIM_F, C_UNKNOWN, C_AIR, C_SOLID, C_LIQUID, C_THIN }
