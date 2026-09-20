// nether_stair: THE WAY DOWN from a gate that landed on a ledge to the real Nether floor.
//
// WHY A CUT STAIR AND NOT A WALK (measured 13:4xZ: 42 of 81 columns within 12 blocks of the far gate have no floor within 4 below;
// 10 deaths in 45 min, every fall at y24-38, six of them "tried to swim in lava" inside two minutes): a 2-wide, 3-high corridor
// cut through netherrack is deterministic — no ghast sees into it, nobody falls off it, and netherrack breaks instantly. Where
// there is no rock the same cells are BUILT of carried stone, which is why every cell is listed: `air` where the corridor must be
// clear, `stone` where floor, wall or roof must exist. The build routine digs the first and places the second, so one blueprint
// serves both cases and a half-rock, half-void slope needs no decision.
//
//        roof   # # # #        interior 2 wide (l = 0,1), 3 high; walls at l = -1 and l = 2
//        y+2    # . . #        floor at y-1; each step descends 1 and advances 1 along the bearing
//        y+1    # . . #        torch every `torchEvery` steps on the interior floor
//        y      # . . #
//        y-1    # # # #
//
// origin = the first INTERIOR cell at foot level, just outside the hub doorway; y = that foot level.
// params: bearing 'x+'|'x-'|'z+'|'z-', toY (the floor we are going down to, default y-64), torchEvery=6, run=1
//         (`run` = horizontal cells per 1 of descent; 1 = a 45-degree flight, 2 = a gentler one that costs twice the length).
const DIRS = { 'x+': [1, 0], 'x-': [-1, 0], 'z+': [0, 1], 'z-': [0, -1] }
const size = (o, p = {}) => {
  const bearing = DIRS[p.bearing] ? String(p.bearing) : 'z-'
  const toY = Number.isFinite(p.toY) ? p.toY : o.y - 64
  const drop = Math.max(1, Math.min(120, o.y - toY))
  return { bearing, toY, drop, run: Math.max(1, Math.min(4, p.run || 1)), torchEvery: p.torchEvery == null ? 6 : p.torchEvery }
}
module.exports = (o, p = {}) => {
  const { bearing, drop, run, torchEvery } = size(o, p)
  const [ax, az] = DIRS[bearing]
  const lx = -az; const lz = ax
  const out = []
  const put = (i, l, y, block, extra) => out.push(Object.assign({ x: o.x + ax * i + lx * l, y, z: o.z + az * i + lz * l, block }, extra || {}))
  let i = 0
  for (let s = 0; s <= drop; s++) {
    const y = o.y - s
    for (let r = 0; r < run; r++, i++) {
      for (let l = -1; l <= 2; l++) {
        put(i, l, y - 1, 'stone') // the tread we walk on
        put(i, l, y + 3, 'stone') // the roof: no ghast sees into a cut stair
        const wall = l === -1 || l === 2
        for (const yy of [y, y + 1, y + 2]) put(i, l, yy, wall ? 'stone' : 'air')
      }
      if (torchEvery && i > 0 && i % torchEvery === 0) put(i, 0, y, 'torch', { needs: 'below' })
    }
  }
  return out
}
module.exports.meta = (o, p = {}) => {
  const { bearing, toY, drop, run } = size(o, p)
  const [ax, az] = DIRS[bearing]
  const n = (drop + 1) * run
  const end = [o.x + ax * (n - 1), toY, o.z + az * (n - 1)]
  return {
    bearing, toY, drop, run, steps: n, end,
    box: [Math.min(o.x, end[0]) - 2, Math.min(o.z, end[2]) - 2, Math.max(o.x, end[0]) + 2, Math.max(o.z, end[2]) + 2],
    yTop: o.y
  }
}
