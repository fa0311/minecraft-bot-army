// castle: crenellated curtain wall with corner towers and a gatehouse.
// origin = centre of the courtyard, y = base layer.
// params: {size=61, wallH=7, thickness=2, towerSize=9, towerH=14,
//          wall='cobblestone', pillar='log', floor='planks', gate=true}
module.exports = (o, p = {}) => {
  const size = (p.size || 61) | 1
  const wallH = p.wallH || 7
  const th = p.thickness || 2
  const ts = (p.towerSize || 9) | 1
  const tH = p.towerH || 14
  const wall = p.wall || 'cobblestone'
  const pillar = p.pillar || 'log'
  const floorB = p.floor || 'planks'
  const R = (size - 1) / 2
  const out = []
  const put = (x, y, z, b) => out.push({ x: o.x + x, y, z: o.z + z, block: b })

  const onWall = (x, z) => {
    const ax = Math.abs(x); const az = Math.abs(z)
    return (ax > R - th && az <= R) || (az > R - th && ax <= R)
  }
  // ---- curtain wall
  for (let i = 0; i <= wallH; i++) {
    const y = o.y + i
    for (let x = -R; x <= R; x++) {
      for (let z = -R; z <= R; z++) {
        if (!onWall(x, z)) continue
        // gatehouse opening on the -z face
        if (p.gate !== false && z < -R + th && Math.abs(x) <= 2 && i >= 1 && i <= 4) { put(x, y, z, 'air'); continue }
        if (i === wallH) {
          // walkway with crenellations on the outer edge
          const outer = Math.abs(x) === R || Math.abs(z) === R
          if (outer) put(x, y, z, ((x + z) % 2 === 0) ? wall : 'air')
          else put(x, y, z, 'air')
          continue
        }
        if (i === wallH - 1) { put(x, y, z, wall); continue }
        put(x, y, z, wall)
      }
    }
    // keep the parapet level clear inside the courtyard
  }
  // walkway floor one below the crenellations
  for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) if (onWall(x, z)) put(x, o.y + wallH - 1, z, wall)

  // ---- corner towers
  const tr = (ts - 1) / 2
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * R; const cz = sz * R
      for (let i = 0; i <= tH + 2; i++) {
        const y = o.y + i
        for (let x = -tr; x <= tr; x++) {
          for (let z = -tr; z <= tr; z++) {
            const gx = cx + x; const gz = cz + z
            const edge = Math.abs(x) === tr || Math.abs(z) === tr
            const corner = Math.abs(x) === tr && Math.abs(z) === tr
            if (i === 0) { put(gx, y, gz, wall); continue }
            if (i > tH) {
              if (!edge) { put(gx, y, gz, 'air'); continue }
              if (i === tH + 1) put(gx, y, gz, wall)
              else put(gx, y, gz, ((gx + gz) % 2 === 0) ? wall : 'air')
              continue
            }
            if (!edge) {
              if (i % 6 === 0 || i === tH) put(gx, y, gz, floorB)
              else put(gx, y, gz, 'air')
              continue
            }
            if (corner) { put(gx, y, gz, pillar); continue }
            if (i % 6 === 3 && (x === 0 || z === 0)) { put(gx, y, gz, 'air'); continue }
            // doorway from the wall walkway into the tower
            if (i >= wallH - 1 && i <= wallH && ((Math.abs(x) === tr && Math.abs(z) < tr && x * sx < 0) || (Math.abs(z) === tr && Math.abs(x) < tr && z * sz < 0))) { put(gx, y, gz, 'air'); continue }
            put(gx, y, gz, wall)
          }
        }
      }
    }
  }
  // ---- gatehouse towers flanking the entrance
  if (p.gate !== false) {
    for (const sx of [-1, 1]) {
      const cx = sx * 5
      for (let i = 0; i <= wallH + 4; i++) {
        const y = o.y + i
        for (let x = -2; x <= 2; x++) {
          for (let z = -2; z <= 2; z++) {
            const gz = -R + th - 1 + z
            const edge = Math.abs(x) === 2 || Math.abs(z) === 2
            if (!edge) { put(cx + x, y, gz, i === 0 ? wall : 'air'); continue }
            if (i > wallH + 2) put(cx + x, y, gz, ((cx + x + gz) % 2 === 0) ? wall : 'air')
            else put(cx + x, y, gz, wall)
          }
        }
      }
    }
  }
  return out
}
