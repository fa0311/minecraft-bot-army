// well: THE ARMY'S INFINITE WATER at the base (owner 09-21: 「水バケツ持ってないやつ多い」). Every overworld bot carries ONE water bucket for the fall reflex
// (lib/moves.js fallGuard / waterDrop), and an empty bucket is filled HERE by army.js kitUp (moves.scoop) - never from a field's or the cane block's water.
// A 2x2 pool of sources is infinite: a scooped cell refills from its two neighbours at once. The four cells are blueprint `water` cells with `pool:true`: the
// build job treats a neighbouring SOURCE of the same pool as a closed side and pours with allowFlow, so it makes two sources and the rest fill by themselves.
//
//      # # # #      # = rim, flush with the ground (stone): the stand from which bots scoop
//      # W W #      W = water cell at the ground level y (floor y-1 filled where it is a hole)
//      # W W #
//      # # # #
//
// origin = NW corner (min x, min z) of the rim, y = the ground level (the rim's own level). params: path='stone'. Headroom 3 over the footprint stays air.
const M = require('./lib/mats')
module.exports = (o, p = {}) => {
  const path = M.mat(p.path, 'stone'); const out = []
  const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) {
    const pool = dx >= 1 && dx <= 2 && dz >= 1 && dz <= 2
    if (pool) { put(dx, -1, dz, { block: 'dirt', fillOnly: true }); put(dx, 0, dz, { block: 'water', pool: true }) } else put(dx, 0, dz, Object.assign({}, path))
    for (let y = 1; y <= 3; y++) put(dx, y, dz, { block: 'air' })
  }
  return out
}
module.exports.meta = () => ({ origin: 'nw', y: 'ground', w: 4, d: 4 })
// the scoop point for kitUp: the pool's four cells
module.exports.pool = o => [[1, 1], [2, 1], [1, 2], [2, 2]].map(([dx, dz]) => [o[0] + dx, o[1], o[2] + dz])
