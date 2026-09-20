// cane_block: THE SUGAR CANE FARM INSIDE THE BASE. Crops only grow in LOADED, TICKED chunks (a player within ~128 blocks): the first cane farm lay on the
// lake shore 100-180 blocks from where the army works and grew 8-22 plants in 3 hours (owner 09-20 05:00Z). Cane needs a soil block with WATER BESIDE IT at
// the same level and no light - so the block is a PLUS TILING: every water cell W (blueprint cell kind `water`: the build job makes floor + 4 sides solid,
// pours ONE bucket from params.waterFrom, verifies a source; cells are isolated = the proven field_block routine) wets exactly its four neighbours, and the
// plus shapes tile the plane: (dx + 2*dz) % 5 == 0 -> 20 % water, 80 % cane soil, no cell is dry. Cane has no collision: the cutters walk through the stand,
// a 1-deep water cell is stepped out of. A paved ring (1 wide, flush) closes the water cells on the rim and is the walkway; torches on the ring corners /
// every 6 and on a sparse interior lattice (the soil under an interior torch is lost to cane) - nothing spawns. LEVEL THE SITE FIRST (blueprint `level`).
//
//      ring  # # # # # # # #        W ~ ~ ~ ~ W ...     ~ = cane soil (dirt, any soil accepted; the `cane` job plants and cuts)
//            # W ~ ~ ~ ~ W ~        ~ ~ W ~ ~ ~ ~       W = water cell at the block's level y (floor filled below)
//            # ~ ~ W ~ ~ ~ ~        ~ ~ ~ ~ W ~ ~
//
// origin = NW corner (min x, min z) of the RING, y = the block's level (soil; cane stands at y+1). params: w=21, d=w (incl. the ring), path='stone', torch=true.
// Cane job: box [x+1, z+1, x+w-2, z+d-2], y. 21x21 -> 19x19 inside = 72 water cells, ~280 cane cells (>= 200 plants).
const M = require('./lib/mats')
const size = (p = {}) => ({ w: Math.max(7, p.w || 21), d: Math.max(7, p.d || p.w || 21) })
module.exports = (o, p = {}) => {
  const { w, d } = size(p); const torch = p.torch !== false; const path = M.mat(p.path, 'stone')
  const out = []; const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  const isW = (dx, dz) => dx > 0 && dz > 0 && dx < w - 1 && dz < d - 1 && (dx + 2 * dz) % 5 === 0
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
    const ring = dx === 0 || dz === 0 || dx === w - 1 || dz === d - 1; let top = 1
    if (ring) {
      put(dx, 0, dz, Object.assign({}, path))
      const corner = (dx === 0 || dx === w - 1) && (dz === 0 || dz === d - 1)
      if (torch && (corner || ((dx === 0 || dx === w - 1) && dz % 6 === 3) || ((dz === 0 || dz === d - 1) && dx % 6 === 3))) { put(dx, 1, dz, { block: 'torch', needs: 'below' }); top = 2 }
    } else if (isW(dx, dz)) {
      put(dx, -1, dz, { block: 'dirt', fillOnly: true }) // the floor of the water cell
      put(dx, 0, dz, { block: 'water' })
    } else {
      put(dx, 0, dz, M.soil())
      // interior light: a torch on the soil, pitch 7, never beside a water cell's own column (lost cane cell: ~6 of 280)
      if (torch && dx % 7 === 3 && dz % 7 === 3 && !isW(dx, dz)) { put(dx, 1, dz, { block: 'torch', needs: 'below' }); top = 2 }
    }
    for (let y = top; y <= 4; y++) put(dx, y, dz, { block: 'air' })
  }
  return out
}
module.exports.meta = p => Object.assign({ origin: 'nw', y: 'ground' }, size(p))
