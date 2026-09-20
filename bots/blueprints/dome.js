// dome: hemispherical shell sitting on a circular floor.
// origin = centre of the floor, y = base layer.
// params: {radius=12, wall='cobblestone', floor='planks', hollow=true}
module.exports = (o, p = {}) => {
  const R = p.radius || 12
  const wall = p.wall || 'cobblestone'
  const floorB = p.floor || 'planks'
  const out = []
  const put = (x, y, z, b) => out.push({ x: o.x + x, y, z: o.z + z, block: b })
  for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) if (x * x + z * z <= R * R) put(x, o.y, z, floorB)
  for (let i = 1; i <= R; i++) {
    const y = o.y + i
    for (let x = -R; x <= R; x++) {
      for (let z = -R; z <= R; z++) {
        const d2 = x * x + z * z + i * i
        if (d2 > R * R) continue
        const shell = d2 > (R - 1) * (R - 1)
        if (shell) {
          if (i <= 3 && z < 0 && Math.abs(x) <= 1) { put(x, y, z, 'air'); continue }
          put(x, y, z, wall)
        } else if (p.hollow !== false) put(x, y, z, 'air')
        else put(x, y, z, wall)
      }
    }
  }
  return out
}
