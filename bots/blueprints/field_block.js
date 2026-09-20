// field_block: ONE FIELD of 27x27 = nine plots, each with its own WATER CELL - the water belongs to the blueprint, never to the farmers.
// World 1: farmers poured, plugged and capped water through five patch layers -> a flood of 309 flowing blocks, holes re-poured 7-12 times,
// crafting tables dropped into water holes, wheat 911 -> 373. Here the `build` job makes every water cell ONCE (cell kind `water`: floor and
// 4 sides solid -> dig -> pour one bucket -> verify a SOURCE -> never touched again) and job type `farm` only tills, plants and harvests.
//
//      x+0 ........ x+8  9  x+10 ... x+16 17  x+18 ....... x+26          ~ = farmland tile (cell `soil:true`: dirt, any soil accepted)
//   T  ~ ~ ~ ~ ~ ~ ~ ~ ~  #  ~ ~ ~ ~ ~ ~ ~  #  ~ ~ ~ ~ ~ ~ ~ ~ ~  T       W = water cell at the FIELD LEVEL y, plot centre (x|z + 4, 13, 22)
//      ~ ~ ~ ~ P ~ ~ ~ ~  #  ~ ~ ~ P ~ ~ ~  #  ~ ~ ~ ~ P ~ ~ ~ ~          P = post (y+1) north of W: the side the CAP over W is placed against
//      ~ ~ ~ ~ W ~ ~ ~ ~  #  ~ ~ ~ W ~ ~ ~  #  ~ ~ ~ ~ W ~ ~ ~ ~              (world 1: a cap with no neighbour made placeHard build its support INTO
//      ~ ~ ~ ~ ~ ~ ~ ~ ~  #  ~ ~ ~ ~ ~ ~ ~  #  ~ ~ ~ ~ ~ ~ ~ ~ ~               the water); the cap carries a torch, nobody falls in, nothing freezes
//   T  # # # # # # # # #  T  # # # # # # #  T  # # # # # # # # #  T       # = path, 1 wide, flush with the field (lines +9 and +17, both axes)
//                                                                         T = ground torch at every plot corner (path crossings + the ring)
// Every tile is within 4 of its plot's water (same level) and within light >= 9 of a torch (corner torch: distance <= 5, cap torch <= 4 + 1):
// crops grow at night, nothing spawns. The blueprint brings its OWN pad (it is in the build job's NO_PAD list: the generic pad rule would take
// the 9 floor cells under the water for the ground level and cut a moat): a ring of 1 around the field at y, 4 cells of headroom over everything.
// LEVEL THE SITE FIRST (blueprint `level`): water in a cell with a missing side runs 7 blocks.
//
// origin = NW corner (min x, min z) of the 27x27, y = FIELD LEVEL (soil; crops stand at y+1). Farm job: box [x, z, x+26, z+26], y.
// params: cap=true (false: open water cells, no post, no centre torch), path='stone' ('stone'|'planks'|block name), post='stone',
//         torch=true, fence=false (true: fence on the ring x-1..x+27 with a gate in the middle of every side; ring torches then stand on it)
const M = require('./lib/mats')
module.exports = (o, p = {}) => {
  const N = 27; const LINES = [9, 17]; const CENTRES = [4, 13, 22]; const CORNERS = [-1, 9, 17, 27]
  const cap = p.cap !== false; const torch = p.torch !== false
  const path = M.mat(p.path, 'stone'); const post = M.mat(p.post, 'stone')
  const out = []; const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  const isW = (dx, dz) => CENTRES.includes(dx) && CENTRES.includes(dz)
  const isPost = (dx, dz) => cap && CENTRES.includes(dx) && CENTRES.includes(dz + 1)
  for (let dx = -1; dx <= N; dx++) for (let dz = -1; dz <= N; dz++) {
    const ring = dx < 0 || dz < 0 || dx >= N || dz >= N; const corner = CORNERS.includes(dx) && CORNERS.includes(dz)
    let top = 1 // first headroom layer this column keeps clear
    if (ring) {
      put(dx, 0, dz, { block: 'dirt', fillOnly: true })
      const mid = (dx === 13 && (dz < 0 || dz >= N)) || (dz === 13 && (dx < 0 || dx >= N))
      if (p.fence) { put(dx, 1, dz, mid ? M.wood('fence_gate', { axis: dz < 0 || dz >= N ? 'x' : 'z' }) : M.wood('fence')); top = 2; if (mid) { put(dx, 2, dz, { block: 'air' }); top = 3 } }
      if (torch && corner) { put(dx, top, dz, { block: 'torch', needs: 'below' }); top++ }
    } else if (isW(dx, dz)) {
      put(dx, -1, dz, { block: 'dirt', fillOnly: true }) // the floor of the water cell
      put(dx, 0, dz, { block: 'water' })
      if (cap) { put(dx, 1, dz, Object.assign({}, post, { needs: 'water' })); top = 2; if (torch) { put(dx, 2, dz, { block: 'torch', needs: 'below' }); top = 3 } }
    } else if (LINES.includes(dx) || LINES.includes(dz)) {
      put(dx, 0, dz, Object.assign({}, path))
      if (torch && corner) { put(dx, 1, dz, { block: 'torch', needs: 'below' }); top = 2 }
    } else {
      put(dx, 0, dz, M.soil(isPost(dx, dz) ? {} : { soil: true }))
      if (isPost(dx, dz)) { put(dx, 1, dz, Object.assign({}, post)); top = 2 }
    }
    for (let y = top; y <= 4; y++) put(dx, y, dz, { block: 'air' })
  }
  return out
}
