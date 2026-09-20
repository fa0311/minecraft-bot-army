// nether_hub: the far side's ONE safe room — a walled, roofed, lit box around the Nether gate, big enough for a squad of 8,
// with a chest and a crafting table carried over from the overworld.
//
// WHY A ROOF (top model 12:4xZ): a ghast does not kill with damage, it kills with knock-back — a fireball through an open
// ceiling puts a bot in the lava it is standing beside. Stone floor, stone walls, stone roof, torches inside, ONE door gap.
// WHY THE FURNITURE IS REGISTERED IN `settings.nether` AND NOT IN `settings.chests`: the depot logic (`A.chestsOf`, `bank`,
// `withdraw`, the chest index) is overworld coordinates from end to end. Until army.js is dimension-aware, an overworld bot
// that "knows" about a chest at -37,98,-76 would walk to -37,98,-76 IN THE OVERWORLD. So the hub's chest lives on the board
// under `settings.nether.hub`, and only jobs of this file read it.
//
// origin = the centre column of the far gate; y = the level of the gate's LOWEST portal cell (the floor you walk on is y-1).
// params: w=9, d=9 (OUTER size, odd, walls included -> 7x7 of floor for 8 bots), h=3 (interior height), door='x+'|'x-'|'z+'|'z-'.
// Cells: block 'stone' = any stone sort the squad carries · 'air' = must be clear · 'torch' · 'chest' · 'crafting_table'.
const DIRS = { 'x+': [1, 0], 'x-': [-1, 0], 'z+': [0, 1], 'z-': [0, -1] }
const size = (p = {}) => ({ w: Math.max(7, (p.w || 9) | 1), d: Math.max(7, (p.d || 9) | 1), h: Math.max(3, p.h || 3), door: DIRS[p.door] ? String(p.door) : 'x+' })
module.exports = (o, p = {}) => {
  const { w, d, h, door } = size(p)
  const hx = (w - 1) / 2; const hz = (d - 1) / 2
  const out = []
  const put = (x, y, z, block, extra) => out.push(Object.assign({ x: o.x + x, y, z: o.z + z, block }, extra || {}))
  for (let x = -hx; x <= hx; x++) {
    for (let z = -hz; z <= hz; z++) {
      const wall = Math.abs(x) === hx || Math.abs(z) === hz
      put(x, o.y - 1, z, 'stone') // the floor: nothing left to fall through
      for (let k = 0; k < h; k++) put(x, o.y + k, z, wall ? 'stone' : 'air')
      put(x, o.y + h, z, 'stone') // the roof
    }
  }
  // ONE door, 1 wide and 2 high, in the middle of a wall — a sealed box is a trap, and the road starts here
  const [dx, dz] = DIRS[door]
  const door0 = [dx * hx, dz * hz]
  for (let k = 0; k < 2; k++) put(door0[0], o.y + k, door0[1], 'air')
  // light (nothing spawns on a lit floor) and the furniture, both off the gate's own plane
  for (const [x, z] of [[-hx + 1, -hz + 1], [hx - 1, hz - 1], [-hx + 1, hz - 1], [hx - 1, -hz + 1]]) put(x, o.y, z, 'torch', { needs: 'below' })
  put(0, o.y, -hz + 1, 'chest')
  put(0, o.y, hz - 1, 'crafting_table')
  return out
}
// meta(origin, params) -> what the `portal` job needs to know about the room it just built
module.exports.meta = (o, p = {}) => {
  const { w, d, h, door } = size(p)
  const hx = (w - 1) / 2; const hz = (d - 1) / 2; const [dx, dz] = DIRS[door]
  return {
    room: [o.x - hx, o.z - hz, o.x + hx, o.z + hz],
    y: o.y,
    h,
    door: [o.x + dx * hx, o.y, o.z + dz * hz],
    outside: [o.x + dx * (hx + 1), o.y, o.z + dz * (hz + 1)], // the first cell of the road
    bearing: door,
    chest: [o.x, o.y, o.z - hz + 1],
    table: [o.x, o.y, o.z + hz - 1]
  }
}
