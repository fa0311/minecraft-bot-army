// great_tower: tall round tower shell with floors, windows and battlements.
// origin = centre, y = base layer.
// params: {radius=9, height=40, wall='cobblestone', floor='planks', floorEvery=6}
module.exports = (o, p = {}) => {
  const R = p.radius || 9
  const h = p.height || 40
  const wall = p.wall || 'cobblestone'
  const floorB = p.floor || 'planks'
  const fe = p.floorEvery || 6
  const out = []
  const put = (x, y, z, b) => out.push({ x: o.x + x, y, z: o.z + z, block: b })
  const inside = (x, z, r) => x * x + z * z <= r * r
  for (let i = 0; i <= h + 2; i++) {
    const y = o.y + i
    // slight taper near the top
    const r = i > h ? R : R
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        if (!inside(x, z, r)) continue
        const shell = !inside(x, z, r - 1)
        if (i === 0) { put(x, y, z, wall); continue }
        if (!shell) {
          if (i % fe === 0 && i <= h) put(x, y, z, floorB)
          else put(x, y, z, 'air')
          continue
        }
        if (i > h) { put(x, y, z, ((x + z) % 2 === 0) ? wall : 'air'); continue }
        // door at the base, windows every floor
        if (i <= 3 && z < 0 && Math.abs(x) <= 1 && i >= 1) { put(x, y, z, 'air'); continue }
        if (i % fe === 3 && (Math.abs(x) <= 1 || Math.abs(z) <= 1)) { put(x, y, z, 'air'); continue }
        put(x, y, z, wall)
      }
    }
  }
  return out
}
