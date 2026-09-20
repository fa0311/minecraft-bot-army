// stairwell -- an open helical staircase: one step per level, walking around the
// perimeter of a square ring. Built to get bots OUT of a hole they cannot path out
// of (the spawn pool is 20 blocks below the plateau with a near-vertical wall).
//
// Every step is orthogonally adjacent to the one below it, so the pathfinder can
// simply walk up; there are no stairs/slabs, which the placement system cannot orient.
//
// origin = centre of the ring, y = the level of the FIRST step.
// params:
//   to       top level (exclusive-ish: the last step lands here)  (default y+16)
//   size     ring size, odd, >= 3                                  (default 5)
//   block    step block                                            (default 'cobblestone')
//   post     central support column, '' for none                   (default 'cobblestone')
//   light    torch block, '' for none                              (default 'torch')
//   lightEvery  levels between torches                             (default 5)
//   wide     make each step 2 wide (safer to walk)                 (default true)
module.exports = (o, p = {}) => {
  const top = p.to == null ? o.y + 16 : p.to
  const size = Math.max(3, (p.size || 5) | 1)
  const block = p.block || 'cobblestone'
  const post = p.post === undefined ? 'cobblestone' : p.post
  const light = p.light === undefined ? 'torch' : p.light
  const lightEvery = p.lightEvery || 5
  const wide = p.wide !== false

  const r = (size - 1) / 2
  // perimeter of the ring, in walking order, each cell orthogonally adjacent to the next
  const ring = []
  for (let x = -r; x <= r; x++) ring.push([x, -r])
  for (let z = -r + 1; z <= r; z++) ring.push([r, z])
  for (let x = r - 1; x >= -r; x--) ring.push([x, r])
  for (let z = r - 1; z >= -r + 1; z--) ring.push([-r, z])

  const out = []
  const put = (x, y, z, b) => out.push({ x: o.x + x, y, z: o.z + z, block: b })

  const levels = Math.max(1, top - o.y)
  for (let i = 0; i <= levels; i++) {
    const y = o.y + i
    const [sx, sz] = ring[i % ring.length]
    put(sx, y, sz, block)
    if (wide) {
      // widen inwards so a bot cannot clip off the outside edge
      const ix = sx === 0 ? 0 : sx - Math.sign(sx)
      const iz = sz === 0 ? 0 : sz - Math.sign(sz)
      if (ix !== sx || iz !== sz) put(ix, y, iz, block)
    }
    // head room over the step we just made
    put(sx, y + 1, sz, 'air')
    put(sx, y + 2, sz, 'air')
    if (post) put(0, y, 0, post)
    if (light && i > 0 && i % lightEvery === 0) put(sx, y + 1, sz === 0 ? 1 : sz - Math.sign(sz), light)
  }
  // a small landing at the top so the pathfinder has somewhere flat to arrive
  const [tx, tz] = ring[levels % ring.length]
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      put(tx + dx, o.y + levels, tz + dz, block)
      put(tx + dx, o.y + levels + 1, tz + dz, 'air')
      put(tx + dx, o.y + levels + 2, tz + dz, 'air')
    }
  }
  return out
}
