// tree_farm: THE PLANTATION, 48x48 - soil on a 3-grid for the `lumber` squad, lit so saplings grow at night and nothing spawns under the crowns.
// World 1: LLM-written fell plans ran dry after one stand ("no tree within 12") and the forest around the base became stumps and floating crowns.
// The blueprint only PREPARES the ground; planting, felling and replanting (whatever sapling the tree dropped) is the lumber job's:
//     lumber.params.box = [x, z, x + 47, z + 47], pitch 3   (its grid is relative to the box corner = this origin)
//
//   grid point (dx % 3 == 0 and dz % 3 == 0): SOIL (dirt; any soil accepted - stone or sand there is replaced, a sapling needs dirt)
//   torch      (dx % 6 == 1 and dz % 6 == 1): on the ground, diagonal to four grid points, never ON one: every sapling is within 4 of a torch (light >= 10)
//   everything else: ground filled where there is a hole. NO `air` cells: a build job never fells the trees of its own farm (clear the site first
//   with a `lumber` job, clear:true, then level it with blueprint `level`). In the build job's NO_PAD list for the same reason.
//
// origin = NW corner (min x, min z), y = GROUND level (saplings stand at y+1). params: w=48, d=w, pitch=3, torch=true
const M = require('./lib/mats')
const size = (p = {}) => ({ w: p.w || 48, d: p.d || p.w || 48 })
module.exports = (o, p = {}) => {
  const { w, d } = size(p); const pitch = Math.max(2, p.pitch || 3); const out = []
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
    const grid = dx % pitch === 0 && dz % pitch === 0
    out.push(Object.assign({ x: o.x + dx, y: o.y, z: o.z + dz }, grid ? M.soil({ plant: true }) : { block: 'dirt', fillOnly: true }))
    if (p.torch !== false && dx % (2 * pitch) === 1 && dz % (2 * pitch) === 1) out.push({ x: o.x + dx, y: o.y + 1, z: o.z + dz, block: 'torch', needs: 'below' })
  }
  return out
}
module.exports.meta = p => Object.assign({ origin: 'nw', y: 'ground' }, size(p))
