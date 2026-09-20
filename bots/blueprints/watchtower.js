// watchtower: square tower with corner pillars, windows, floors and battlements.
// origin = centre of the footprint, y = base layer.
// params: {size=7, height=14, wall='cobblestone', pillar='log',
//          floor='planks', window='air', floorEvery=5, clear=true}
module.exports = (o, p = {}) => {
  const size = (p.size || 7) | 1 // force odd
  const h = p.height || 14
  const wall = p.wall || 'cobblestone'
  const pillar = p.pillar || 'log'
  const floorB = p.floor || 'planks'
  const floorEvery = p.floorEvery || 5
  const r = (size - 1) / 2
  const out = []
  const put = (x, y, z, block) => out.push({ x: o.x + x, y, z: o.z + z, block })
  const edge = (x, z) => Math.abs(x) === r || Math.abs(z) === r
  const corner = (x, z) => Math.abs(x) === r && Math.abs(z) === r

  // headroom clear
  if (p.clear !== false) {
    for (let y = o.y; y <= o.y + h + 2; y++) for (let x = -r - 1; x <= r + 1; x++) for (let z = -r - 1; z <= r + 1; z++) put(x, y, z, 'air')
  }
  // foundation
  for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) put(x, o.y, z, wall)

  for (let i = 1; i <= h; i++) {
    const y = o.y + i
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        if (!edge(x, z)) {
          // interior: floors every N levels, otherwise air
          if (i % floorEvery === 0 && i < h) put(x, y, z, floorB)
          else put(x, y, z, 'air')
          continue
        }
        if (corner(x, z)) { put(x, y, z, pillar); continue }
        // door on the -z face
        if (z === -r && x === 0 && (i === 1 || i === 2)) { put(x, y, z, 'air'); continue }
        // windows: a slit on each face every floorEvery levels
        if (i % floorEvery === 2 && (x === 0 || z === 0)) { put(x, y, z, p.window || 'air'); continue }
        put(x, y, z, wall)
      }
    }
  }
  // observation deck + battlements
  const topY = o.y + h
  for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) if (!edge(x, z)) put(x, topY, z, floorB)
  for (let k = 1; k <= 2; k++) {
    const y = topY + k
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        if (!edge(x, z)) { put(x, y, z, 'air'); continue }
        const merlon = (Math.abs(x) + Math.abs(z)) % 2 === 0
        if (k === 1 || merlon) put(x, y, z, wall)
        else put(x, y, z, 'air')
      }
    }
  }
  return out
}
