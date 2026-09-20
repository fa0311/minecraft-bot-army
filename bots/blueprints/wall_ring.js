// wall_ring: a wall around a rectangular yard (creepers cannot blow up what they cannot reach).
// FLAT mode (default): origin = centre, y = ground level (the wall stands ON y, i.e. first wall layer is y+1). params:
//   w=25, d=17 (outer size), height=3, block='cobblestone', gates: openings on each side at the centre (default true; gateHalf=1 -> 3 wide, 0 -> 1 wide),
//   torches=true: a torch on top of the wall every 6 blocks (lights both sides)
// FOLLOW mode (params.profile = '<name>.profile.json' in this directory: {"x,z": groundY} for the wall line and its neighbours, probed BEFORE building;
//   the build job needs `pad:false`): the wall FOLLOWS THE GROUND - every column stands on its own ground and is `height` high, and never lower than
//   height-1 above any ground next to it (3x3), so a slope gives no step over the wall. No levelling, no digging; a tree on the line is felled beforehand by a `steps` plan (verb fell) - its trunk cells are replaced by wall.
//   box:[x1,z1,x2,z2] absolute outer line (instead of origin/w/d), mats=[accepted substitutes for `block`],
//   gatesAt:{n:x, s:x, w:z, e:z}  ONE-wide gates at hand-picked FLAT spots (ground equal 2 cells in and out): a FENCE GATE (`gateBlock`, default 'fence_gate' = any wood) at foot
//   level + one block of air above + wall over it. Fence gate, not a door: our pathfinder (canOpenDoors) opens only "gate" blocks; a door locks the army out.
module.exports = (o, p = {}) => {
  const h = p.height || 3; const block = p.block || 'cobblestone'; const out = []
  if (p.profile) {
    const prof = require('path').join(__dirname, String(p.profile).replace(/[^a-z0-9_.]/gi, ''))
    delete require.cache[require.resolve(prof)]; const G = require(prof)
    const mats = p.mats || ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite']
    const [x1, z1, x2, z2] = p.box; const ga = p.gatesAt || {}; const gateBlock = p.gateBlock || 'fence_gate'
    const g = (x, z) => { const q = G[x + ',' + z]; return Array.isArray(q) ? q[0] : q }
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      if (x !== x1 && x !== x2 && z !== z1 && z !== z2) continue
      let g0 = g(x, z); if (g0 == null) continue
      let hi = g0; for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const q = g(x + dx, z + dz); if (q != null && q > hi) hi = q }
      const gate = (z === z1 && ga.n === x) ? 'x' : (z === z2 && ga.s === x) ? 'x' : (x === x1 && ga.w === z) ? 'z' : (x === x2 && ga.e === z) ? 'z' : null
      if (gate) { // the threshold is level with the ground inside and outside (a gate in a dip cannot be walked: the lintel is in the way)
        const a = gate === 'x' ? g(x, z - 1) : g(x - 1, z); const b = gate === 'x' ? g(x, z + 1) : g(x + 1, z)
        if (a !== b || a < g0) throw new Error('gate ' + x + ',' + z + ' is not on flat ground (' + a + '/' + g0 + '/' + b + ')')
        for (let y = g0 + 1; y <= a; y++) out.push({ x, y, z, block: 'dirt', fillOnly: true })
        g0 = a
      }
      const top = Math.min(Math.max(g0 + h, hi + h - 1), g0 + h + 4)
      for (let y = g0 + 1; y <= top; y++) {
        if (gate && y === g0 + 1) out.push({ x, y, z, block: gateBlock, axis: gate })
        else if (gate && y === g0 + 2) out.push({ x, y, z, block: 'air' })
        else out.push({ x, y, z, block, mats })
      }
    }
    return out
  }
  const w = p.w || 25; const d = p.d || 17
  const gates = p.gates !== false
  const hx = Math.floor(w / 2); const hz = Math.floor(d / 2)
  for (let x = -hx; x <= hx; x++) for (let z = -hz; z <= hz; z++) {
    if (Math.abs(x) !== hx && Math.abs(z) !== hz) continue
    const gw = p.gateHalf == null ? 1 : p.gateHalf // gate = 2*gw+1 wide
    const gate = gates && ((Math.abs(x) <= gw && Math.abs(z) === hz) || (Math.abs(z) <= gw && Math.abs(x) === hx))
    for (let y = 1; y <= h; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: gate && y <= 2 ? 'air' : block })
    if (p.torches !== false && !gate && (x + z) % 6 === 0) out.push({ x: o.x + x, y: o.y + h + 1, z: o.z + z, block: 'torch' })
  }
  return out
}
