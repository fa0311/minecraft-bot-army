// road_ramp: a road segment that CHANGES HEIGHT (owner 09-21「幹線道路、全然置けてない、段差に対して弱すぎ、階段もなしか？」). `road` is one height, so
// every rise ended a segment: the village road came out as 118 stubs of seven cells and nothing was ever finished. A ramp is ONE
// segment that climbs (or drops) along a straight line - same sub-base, same terraced shoulders, same torch pitch as `road`, but
// the deck follows a linear grade from `o.y` to `toY`. The RISER rows are laid afterwards as real `*_stairs` blocks by the road
// job (jobs_road.js `stairPass`, which can aim the bot and so control the block's `facing`; a blueprint cannot) - the blueprint
// puts a full block there so the ramp is walkable from the first pass and the stairs only make it fast.
//
// origin = the START of the centre line, y = the deck level THERE (ground level: the deck replaces the top block).
// params: toX, toZ (end of the centre line), toY (deck level at the end), width=5, block='stone', clear=3 (headroom),
//         torchEvery=8 (0 = none), shoulder=2 (0 = none; terraced like `road`: s cells out the ground may stand at most s above)
// A grade steeper than 1:1 is refused here rather than half-built: ops/road-plan.js never emits one (its profile is 1-Lipschitz
// and it forces a flat LANDING after six risers), so this throw only ever catches a hand-written job.
const M = require('./lib/mats')
module.exports = (o, p = {}) => {
  const out = []
  const w = p.width || 5; const half = Math.floor(w / 2)
  const block = M.mat(p.block, 'stone'); const clear = p.clear == null ? 3 : p.clear
  const every = p.torchEvery == null ? 8 : p.torchEvery; const sh = p.shoulder == null ? 2 : p.shoulder
  const toX = p.toX == null ? o.x + 16 : p.toX; const toZ = p.toZ == null ? o.z : p.toZ; const toY = p.toY == null ? o.y : p.toY
  const dx = toX - o.x; const dz = toZ - o.z; const dy = toY - o.y
  const n = Math.max(Math.abs(dx), Math.abs(dz)) || 1
  if (Math.abs(dy) > n) throw new Error('road_ramp: a grade of ' + dy + ' over ' + n + ' cells is steeper than 1:1 - plan a switchback (ops/road-plan.js)')
  const alongX = Math.abs(dx) >= Math.abs(dz)
  const yAt = i => o.y + Math.round(dy * i / n)
  const lamps = new Set()
  if (every) for (let i = 0, k = 0; i <= n; i += every, k++) { const cx = Math.round(o.x + dx * i / n); const cz = Math.round(o.z + dz * i / n); const s = (k % 2 ? 1 : -1) * half; lamps.add(alongX ? cx + ',' + (cz + s) : (cx + s) + ',' + cz) }
  const seen = new Set(); const line = []
  for (let i = 0; i <= n; i++) {
    const cx = Math.round(o.x + dx * i / n); const cz = Math.round(o.z + dz * i / n); const cy = yAt(i)
    line.push([cx, cz, cy])
    for (let a = -half; a <= half; a++) {
      const x = alongX ? cx : cx + a; const z = alongX ? cz + a : cz; const k = x + ',' + z
      if (seen.has(k)) continue
      seen.add(k)
      // SUB-BASE: the column under the deck is filled from the natural ground up before the deck goes on (never a deck over air)
      out.push({ x, y: cy - 1, z, block: 'dirt', fillOnly: true, unlid: true })
      out.push(Object.assign({ x, y: cy, z }, block))
      for (let y = 1; y <= clear; y++) out.push(lamps.has(k) && y === 1 ? { x, y: cy + y, z, block: 'torch', needs: 'below' } : { x, y: cy + y, z, block: 'air' })
      for (let y = clear + 1; sh && y <= sh + 3; y++) out.push({ x, y: cy + y, z, block: 'air', natural: true })
    }
  }
  // shoulders across the line, AFTER the deck (a deck column is never a shoulder cell); each shoulder is terraced from ITS OWN deck level
  for (const [cx, cz, cy] of line) for (let s = 1; s <= sh; s++) for (const side of [-1, 1]) {
    const x = alongX ? cx : cx + side * (half + s); const z = alongX ? cz + side * (half + s) : cz; const k = x + ',' + z
    if (seen.has(k)) continue
    seen.add(k)
    for (let y = cy + s + 1; y <= cy + sh + 3; y++) out.push({ x, y, z, block: 'air', natural: true })
  }
  return out
}
// risers(o, p) -> [{ y, dir:'x+'|'x-'|'z+'|'z-', row:[[x,y,z]…] }] : the cells whose deck is one higher than the cell before it,
// i.e. where a real stair block belongs, with the direction a walker CLIMBS. jobs_road.js `stairPass` is the only caller; it is
// exported from the blueprint so the geometry of a step can never drift from the geometry of the ramp (lesson of the mine's treads).
module.exports.risers = (o, p = {}) => {
  const w = p.width || 5; const half = Math.floor(w / 2)
  const toX = p.toX == null ? o.x + 16 : p.toX; const toZ = p.toZ == null ? o.z : p.toZ; const toY = p.toY == null ? o.y : p.toY
  const dx = toX - o.x; const dz = toZ - o.z; const dy = toY - o.y
  const n = Math.max(Math.abs(dx), Math.abs(dz)) || 1; const alongX = Math.abs(dx) >= Math.abs(dz)
  const yAt = i => o.y + Math.round(dy * i / n)
  const dir = alongX ? (dx >= 0 ? 'x+' : 'x-') : (dz >= 0 ? 'z+' : 'z-')
  const out = []
  for (let i = 1; i <= n; i++) {
    if (yAt(i) <= yAt(i - 1)) continue // only a RISE gets a stair; a drop is walked down (and its stair belongs to the other direction)
    const cx = Math.round(o.x + dx * i / n); const cz = Math.round(o.z + dz * i / n); const cy = yAt(i)
    const row = []
    for (let a = -half; a <= half; a++) row.push([alongX ? cx : cx + a, cy, alongX ? cz + a : cz])
    out.push({ y: cy, dir, row })
  }
  return out
}
