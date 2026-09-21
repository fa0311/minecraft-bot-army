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
// params: w=9, d=9 (OUTER size, odd, walls included -> 7x7 of floor for 8 bots), h=3 (interior height). `door` only names the
//         bearing the ROAD starts on: there is a doorway in every wall.
// Cells: block 'stone' = any stone sort the squad carries · 'air' = must be clear · 'torch' · 'chest' · 'crafting_table'.
const DIRS = { 'x+': [1, 0], 'x-': [-1, 0], 'z+': [0, 1], 'z-': [0, -1] }
// GATE HALL params (owner 09-21 17:2xZ 「もっと空間空けて、丸石とかで壁作ったほうが良い、見栄えも悪いし」): w/d up to 31, h up to 6,
//   block: 'cobblestone' (the one look, exact block), doors:false (no automatic doorways - the ways out are the routes that cross the
//   walls, merged in by the job with air winning), furniture:false, torchEvery: n (a grid of floor torches inside, off the gate plane).
const size = (p = {}) => ({ w: Math.min(31, Math.max(7, (p.w || 9) | 1)), d: Math.min(31, Math.max(7, (p.d || 9) | 1)), h: Math.min(6, Math.max(3, p.h || 3)), door: DIRS[p.door] ? String(p.door) : 'x+', block: p.block || 'stone', doors: p.doors !== false, furniture: p.furniture !== false, torchEvery: p.torchEvery || 0 })
module.exports = (o, p = {}) => {
  const { w, d, h, block, doors, furniture, torchEvery } = size(p)
  const hx = (w - 1) / 2; const hz = (d - 1) / 2
  const out = []
  const put = (x, y, z, block, extra) => out.push(Object.assign({ x: o.x + x, y, z: o.z + z, block }, extra || {}))
  for (let x = -hx; x <= hx; x++) {
    for (let z = -hz; z <= hz; z++) {
      const wall = Math.abs(x) === hx || Math.abs(z) === hz
      put(x, o.y - 1, z, block, { floor: true }) // the floor: nothing left to fall through
      for (let k = 0; k < h; k++) put(x, o.y + k, z, wall ? block : 'air')
      put(x, o.y + h, z, block) // the roof
    }
  }
  // ONE door, 1 wide and 2 high, in the middle of a wall — a sealed box is a trap, and the road starts here
  // FOUR PLAIN DOORWAYS, NO GATE (owner 13:4xZ: "ネザーゲートの周り囲みすぎててハングしてる" — six scouts stood INSIDE this room
  // with `stranded {dim:"the_nether"}` and could not path out. `A.strictMovements` does set `canOpenDoors` and does make an OPEN
  // gate passable, but a hub that keeps mobs out by keeping the army in is worse than no hub. So: one doorway in the middle of
  // EACH wall, 2 wide and 2 HIGH, plain air — the four bearings the squads leave by — with a stone landing and a torch outside
  // it, because the gate sits on a ledge and the first step out must be onto something.
  for (const dir of (doors ? Object.keys(DIRS) : [])) {
    const [ex, ez] = DIRS[dir]
    const lx = -ez; const lz = ex // along the wall
    const wx = ex * hx; const wz = ez * hz
    for (const l of [0, 1]) {
      for (let k = 0; k < 2; k++) put(wx + lx * l, o.y + k, wz + lz * l, 'air') // the doorway itself
      put(wx + ex + lx * l, o.y - 1, wz + ez + lz * l, 'stone') // the landing outside it
      for (let k = 0; k < 2; k++) put(wx + ex + lx * l, o.y + k, wz + ez + lz * l, 'air')
    }
    put(wx + ex, o.y, wz + ez, 'torch', { needs: 'below' }) // lit outside: nothing spawns on the step we leave by
  }
  // light (nothing spawns on a lit floor) and the furniture, both off the gate's own plane
  for (const [x, z] of [[-hx + 1, -hz + 1], [hx - 1, hz - 1], [-hx + 1, hz - 1], [hx - 1, -hz + 1]]) put(x, o.y, z, 'torch', { needs: 'below' })
  if (torchEvery) for (let x = -hx + 1 + torchEvery; x < hx - 1; x += torchEvery) for (let z = -hz + 1 + torchEvery; z < hz - 1; z += torchEvery) if (z !== 0) put(x, o.y, z, 'torch', { needs: 'below' })
  if (furniture) { put(0, o.y, -hz + 1, 'chest'); put(0, o.y, hz - 1, 'crafting_table') }
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
    doors: Object.keys(DIRS).map(k => ({ bearing: k, at: [o.x + DIRS[k][0] * hx, o.y, o.z + DIRS[k][1] * hz], out: [o.x + DIRS[k][0] * (hx + 1), o.y, o.z + DIRS[k][1] * (hz + 1)] })),
    outside: [o.x + dx * (hx + 1), o.y, o.z + dz * (hz + 1)], // the first cell of the road
    bearing: door,
    chest: [o.x, o.y, o.z - hz + 1],
    table: [o.x, o.y, o.z + hz - 1]
  }
}
