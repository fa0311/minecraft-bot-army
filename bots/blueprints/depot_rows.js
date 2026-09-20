// depot_rows: THE DEPOT - rows of DOUBLE CHESTS, one row per category, 2 high, 2-wide aisles between the rows (x30: a whole squad banks at once),
// ground torches at both ends of every row. Every chest cell carries `cat` (+ `half` 0|1 = its place in the pair): the `build` job registers
// what stands in settings.chests[cat] as it goes - the depot works while it grows - and books a merged double ONCE (both halves open the same
// 54 slots; world 1 used barrels to dodge this and paid 6 planks + 2 slabs a piece; a chest is 8 planks of ANY wood).
// World 1's depot grew where a bot happened to stand (chests floating over 6-16 deep pits); this one is a zone of the base plan, on the core's pad.
//
//   z+0   T C C C C C C C C T     C = chest column (chests at y+1 and y+2), pairs (C C) merge into doubles along the row
//   z+1   . . . . . . . . . .     aisle (2 wide, kept clear 3 high, floor filled where there is a hole)
//   z+2   . . . . . . . . . .
//   z+3   T C C C C C C C C T     next category …
//
// origin = NW corner (min x, min z), y = GROUND level (chests stand on it). Footprint: (len + 2) x (3 * rows), always inside the slot w x d.
// params: w, d = the SLOT (`armyctl.js plan-base` passes 32x20); len=8 (chest columns per row, even, <= w - 2), high=1 (1..3), rows=['food','tools','ores',
//         'build','build','salvage'] (one entry per row, as many as fit d; the categories of lib/army.js CATS), container='chest' ('barrel' = never
//         merges), torch=true. START SMALL, GROW LATER: the default is 48 chests (96 logs of any wood) so the job completes on day one and its
//         successors start; raise `len` / `high` and bump `rev` when the stock needs room - every chest keeps its place.
const size = (p = {}) => { const len = Math.max(2, Math.min(p.len || 8, p.w ? p.w - 2 : 1e9) & ~1); let rows = Array.isArray(p.rows) && p.rows.length ? p.rows : ['food', 'tools', 'ores', 'build', 'build', 'salvage']; if (p.d) rows = rows.slice(0, Math.max(1, Math.floor(p.d / 3))); return { len, rows, w: len + 2, d: 3 * rows.length } }
module.exports = (o, p = {}) => {
  const { len, rows, w } = size(p); const high = Math.max(1, Math.min(3, p.high || 1)); const box = p.container === 'barrel' ? 'barrel' : 'chest'
  const out = []; const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  rows.forEach((cat, r) => {
    const z = r * 3
    for (let dx = 0; dx < w; dx++) {
      for (const dz of [z, z + 1, z + 2]) put(dx, 0, dz, { block: 'dirt', fillOnly: true }) // the ground layer marks y as THE ground for the pad rule
      const chest = dx >= 1 && dx <= len
      for (let h = 1; h <= 3; h++) {
        if (chest && h <= high) put(dx, h, z, Object.assign({ block: box, cat, half: (dx - 1) % 2 }, box === 'chest' ? { facing: 'south' } : {})) // every chest faces ITS aisle (z+1): same facing = the pair merges; the build job places and verifies it (placeChest), 09-20: 70 of 80 stood single
        else if (!chest && h === 1 && p.torch !== false) put(dx, h, z, { block: 'torch', needs: 'below' })
        else put(dx, h, z, { block: 'air' })
        put(dx, h, z + 1, { block: 'air' }); put(dx, h, z + 2, { block: 'air' })
      }
    }
  })
  return out
}
module.exports.meta = p => { const s = size(p); return { origin: 'nw', y: 'ground', w: s.w, d: s.d } }
