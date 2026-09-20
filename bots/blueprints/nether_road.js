// nether_road: a 2-wide COVERED walkway through the Nether — the reusable road doctrine (GOALS Q2) applied to a world where
// the alternative is a private tunnel over a lava sea.
//
// Movement stays READ-ONLY: a bot never digs its way anywhere. What a squad builds here is a road everyone uses afterwards —
// floor, two parapets, a stone roof against ghast fireballs, torches every 8 so nothing spawns inside it.
//
//        roof   # # # #          interior: 2 wide, 2 high (l = 0,1)
//        y+1    # . . #          walls at l = -1 and l = 2, two high
//        y      # . . #          floor at y-1 under all four columns
//        y-1    # # # #
//
// origin = the first INTERIOR cell at foot level (`settings.nether.hub.outside`); y = feet level, so the floor is y-1.
// params: bearing 'x+'|'x-'|'z+'|'z-', length=64, torchEvery=8.
const DIRS = { 'x+': [1, 0], 'x-': [-1, 0], 'z+': [0, 1], 'z-': [0, -1] }
const size = (p = {}) => ({ bearing: DIRS[p.bearing] ? String(p.bearing) : 'x+', length: Math.max(1, Math.min(256, p.length || 64)), torchEvery: p.torchEvery == null ? 8 : p.torchEvery })
module.exports = (o, p = {}) => {
  const { bearing, length, torchEvery } = size(p)
  const [ax, az] = DIRS[bearing]
  const lx = -az; const lz = ax // the lateral axis, 90 degrees to the bearing
  const out = []
  const put = (i, l, y, block, extra) => out.push(Object.assign({ x: o.x + ax * i + lx * l, y, z: o.z + az * i + lz * l, block }, extra || {}))
  for (let i = 0; i < length; i++) {
    for (let l = -1; l <= 2; l++) {
      put(i, l, o.y - 1, 'stone') // floor
      put(i, l, o.y + 2, 'stone') // roof
      const wall = l === -1 || l === 2
      for (const y of [o.y, o.y + 1]) put(i, l, y, wall ? 'stone' : 'air')
    }
    if (torchEvery && i > 0 && i % torchEvery === 0) put(i, 0, o.y, 'torch', { needs: 'below' })
  }
  return out
}
module.exports.meta = (o, p = {}) => {
  const { bearing, length } = size(p)
  const [ax, az] = DIRS[bearing]
  const end = [o.x + ax * (length - 1), o.y, o.z + az * (length - 1)]
  const box = [Math.min(o.x, end[0]) - 2, Math.min(o.z, end[2]) - 2, Math.max(o.x, end[0]) + 2, Math.max(o.z, end[2]) + 2]
  return { bearing, length, end, box, y: o.y }
}
