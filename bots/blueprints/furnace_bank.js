// furnace_bank: a ROW of furnaces with a paved walkway in front (x30 rule: two furnaces starve every charcoal/torch/iron plan).
//
//   back │ F F F F F F F F F F F F │   F = furnace at y (torch on top of every 3rd one: the bank is lit, nothing spawns on it)
//        │ w w w w w w w w w w w w │   w = walkway, `walk` cells deep, paved at y-1, 3 cells of headroom kept clear
//
// Made to be built INTO a terrace step (furnace tops flush with the upper ground, walkway on the lower one) or free-standing on level
// ground. Use params.pad:false on the job when it stands against a terrace/wall (the PAD RULE would cut the neighbour column).
// The `build` job registers every furnace that stands in bots/base.json `furnaces` (what lib/base.js smelt and the quartermaster read).
//
// origin = the FIRST furnace, y = furnace level (ground + 1).
// params: n=12 furnaces, axis='z'|'x' (the row runs towards +axis), front=1|-1 (walkway side on the other axis), walk=2,
//         floor='stone' (any stone sort under furnaces and walkway; '' = leave the ground), torchEvery=3 (0 = none), high=1 (2 = double-decker)
module.exports = (o, p = {}) => {
  const n = p.n || 12; const axis = p.axis === 'x' ? 'x' : 'z'; const front = p.front === -1 ? -1 : 1
  const walk = p.walk == null ? 2 : p.walk; const M = require('./lib/mats'); const floor = p.floor === undefined ? M.stone() : p.floor ? M.mat(p.floor) : null
  const every = p.torchEvery == null ? 3 : p.torchEvery; const high = p.high === 2 ? 2 : 1
  const at = (i, k, y) => axis === 'z' ? { x: o.x + k * front, y, z: o.z + i } : { x: o.x + i, y, z: o.z + k * front }
  const out = []
  for (let i = 0; i < n; i++) {
    if (floor) out.push(Object.assign(at(i, 0, o.y - 1), floor))
    for (let h = 0; h < high; h++) out.push(Object.assign(at(i, 0, o.y + h), { block: 'furnace' }))
    if (every && i % every === 1) out.push(Object.assign(at(i, 0, o.y + high), { block: 'torch', needs: 'below' }))
    for (let k = 1; k <= walk; k++) {
      if (floor) out.push(Object.assign(at(i, k, o.y - 1), floor))
      for (let y = 0; y <= 2; y++) out.push(Object.assign(at(i, k, o.y + y), { block: 'air' }))
    }
  }
  return out
}
