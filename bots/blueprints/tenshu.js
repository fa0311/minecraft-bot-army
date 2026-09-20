// tenshu -- 天守閣: a Japanese castle keep with a battered stone base (石垣) and
// several tiers of flared, layered roofs, each tier smaller than the one below.
//
// origin = centre of the footprint, y = the base layer (first layer built).
// params:
//   size    base footprint width, odd            (default 25)
//   baseH   height of the stone base             (default 6)
//   tiers   number of roofed storeys             (default 5)
//   tierH   wall height of each storey           (default 4)
//   shrink  half-width lost per storey           (default 2)
//   eaves   how far a roof oversails its walls   (default 2)
//   base/wall/frame/roof/floor/window            block names
//   hollow  carve the interior to air            (default true)
//
// Everything is full blocks (no stairs/slabs): the placement system cannot control
// block facing, so a stepped roof is what actually survives contact with the bots.
module.exports = (o, p = {}) => {
  const size = ((p.size || 25) | 1)
  const baseH = p.baseH == null ? 6 : p.baseH
  const tiers = p.tiers == null ? 5 : p.tiers
  const tierH = p.tierH == null ? 4 : p.tierH
  const shrink = p.shrink == null ? 2 : p.shrink
  const eaves = p.eaves == null ? 2 : p.eaves
  const baseB = p.base || 'cobblestone'
  const wallB = p.wall || 'planks'
  const frameB = p.frame || 'log'
  const roofB = p.roof || 'cobblestone'
  const floorB = p.floor || 'planks'
  const winB = p.window || 'glass'
  const hollow = p.hollow !== false

  const out = []
  const put = (x, y, z, b) => out.push({ x: o.x + x, y, z: o.z + z, block: b })
  const ring = (y, r, b) => {
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== r) continue
        put(x, y, z, b)
      }
    }
  }
  const slab = (y, r, b) => { for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) put(x, y, z, b) }

  const R0 = (size - 1) / 2
  let y = o.y

  // ---------------------------------------------------------------- 石垣 base
  // Battered (inward-sloping) stone plinth, 2 blocks thick, hollow inside.
  for (let i = 0; i < baseH; i++) {
    const r = R0 - Math.floor(i / 2)
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        const m = Math.max(Math.abs(x), Math.abs(z))
        // main gate: a 5-wide, 4-high tunnel through the -z face
        if (Math.abs(x) <= 2 && z <= -r + 2 && i >= 1 && i <= 4) { put(x, y + i, z, 'air'); continue }
        if (m > r - 2) put(x, y + i, z, baseB)
        else if (hollow) put(x, y + i, z, i === 0 ? baseB : 'air')
      }
    }
  }
  y += baseH
  // floor of the first storey, flush with the top of the plinth
  const rTop = R0 - Math.floor((baseH - 1) / 2)
  slab(y, rTop, floorB)
  y += 1

  // ---------------------------------------------------------------- storeys
  let r = rTop - 1
  for (let k = 0; k < tiers && r >= 2; k++) {
    // ---- walls
    for (let h = 0; h < tierH; h++) {
      const yy = y + h
      for (let x = -r; x <= r; x++) {
        for (let z = -r; z <= r; z++) {
          const m = Math.max(Math.abs(x), Math.abs(z))
          if (m < r) { if (hollow) put(x, yy, z, 'air'); continue }
          const corner = Math.abs(x) === r && Math.abs(z) === r
          if (corner) { put(x, yy, z, frameB); continue }
          // 連子窓: a band of windows on the middle rows, every third column
          const along = Math.abs(x) === r ? z : x
          if (h >= 1 && h <= Math.max(1, tierH - 2) && along % 3 === 0 && Math.abs(along) < r - 1) {
            put(x, yy, z, winB); continue
          }
          // a vertical timber every 4th column
          put(x, yy, z, along % 4 === 0 ? frameB : wallB)
        }
      }
    }
    // veranda / 廻縁 around the first storey only
    if (k === 0) ring(y, r + 1, floorB)

    // ---- roof: stepped hip roof, oversailing the walls by `eaves`
    const roofY = y + tierH
    const layers = eaves + 2
    for (let j = 0; j < layers; j++) {
      const rr = r + eaves - j
      if (rr < 1) break
      if (j === layers - 1) slab(roofY + j, rr, roofB)
      else {
        ring(roofY + j, rr, roofB)
        if (hollow) for (let x = -(rr - 1); x <= rr - 1; x++) for (let z = -(rr - 1); z <= rr - 1; z++) put(x, roofY + j, z, 'air')
      }
    }
    // 降り棟: a ridge line along the roof crest for definition
    const crest = roofY + layers - 1
    const rc = r + eaves - (layers - 1)
    for (let x = -rc; x <= rc; x++) put(x, crest + 1, 0, roofB)
    for (let z = -rc; z <= rc; z++) put(0, crest + 1, z, roofB)

    // next storey stands on the closed top of this roof
    const nr = r - shrink
    if (nr < 2 || k === tiers - 1) {
      // 鯱 ornament: a short timber finial on the very top
      put(0, crest + 2, 0, frameB)
      put(0, crest + 3, 0, frameB)
      put(1, crest + 2, 0, roofB)
      put(-1, crest + 2, 0, roofB)
      put(0, crest + 2, 1, roofB)
      put(0, crest + 2, -1, roofB)
      break
    }
    y = crest + 1
    slab(y, nr, floorB)
    y += 1
    r = nr
  }

  return out
}
