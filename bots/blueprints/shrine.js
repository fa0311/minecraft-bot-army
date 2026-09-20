// shrine -- 神社の社殿: a timber shrine hall on a stone podium, with a veranda,
// a front stair, a gabled (切妻) roof with deep eaves, and 千木/鰹木 on the ridge.
//
// origin = centre of the building, y = ground layer. The entrance faces -z.
// params:
//   w, d      building width (x) and depth (z), odd   (default 11, 13)
//   podium    height of the stone platform            (default 2)
//   wallH     wall height                             (default 5)
//   eaves     roof overhang beyond the walls          (default 2)
//   pitch     roof layers (height of the gable)       (default 4)
//   stone/wall/frame/roof/floor/window                block names
module.exports = (o, p = {}) => {
  const w = ((p.w || 11) | 1)
  const d = ((p.d || 13) | 1)
  const podium = p.podium == null ? 2 : p.podium
  const wallH = p.wallH == null ? 5 : p.wallH
  const eaves = p.eaves == null ? 2 : p.eaves
  const pitch = p.pitch == null ? 4 : p.pitch
  const stoneB = p.stone || 'cobblestone'
  const wallB = p.wall || 'planks'
  const frameB = p.frame || 'log'
  const roofB = p.roof || 'cobblestone'
  const floorB = p.floor || 'planks'
  const winB = p.window || 'glass'

  const out = []
  const put = (x, y, z, b) => out.push({ x: o.x + x, y, z: o.z + z, block: b })
  const rx = (w - 1) / 2
  const rz = (d - 1) / 2
  const px = rx + 2 // podium / veranda half-widths
  const pz = rz + 2

  // ------------------------------------------------------------- stone podium
  for (let i = 0; i < podium; i++) {
    for (let x = -px; x <= px; x++) for (let z = -pz; z <= pz; z++) put(x, o.y + i, z, stoneB)
  }
  let y = o.y + podium
  // front stair down from the veranda, 5 wide on the -z side
  for (let s = 0; s < podium; s++) {
    for (let x = -2; x <= 2; x++) put(x, y - 1 - s, -pz - 1 - s, stoneB)
  }

  // --------------------------------------------------------- veranda + floor
  for (let x = -px; x <= px; x++) for (let z = -pz; z <= pz; z++) put(x, y, z, floorB)
  // veranda railing posts (leave the front open)
  for (let x = -px; x <= px; x += 2) { put(x, y + 1, pz, frameB) }
  for (let z = -pz; z <= pz; z += 2) { put(px, y + 1, z, frameB); put(-px, y + 1, z, frameB) }
  y += 1

  // ---------------------------------------------------------------- the hall
  for (let h = 0; h < wallH; h++) {
    const yy = y + h
    for (let x = -rx; x <= rx; x++) {
      for (let z = -rz; z <= rz; z++) {
        const onX = Math.abs(x) === rx
        const onZ = Math.abs(z) === rz
        if (!onX && !onZ) { put(x, yy, z, 'air'); continue }
        // doorway, 3 wide and 3 high, in the middle of the -z wall
        if (z === -rz && Math.abs(x) <= 1 && h < 3) { put(x, yy, z, 'air'); continue }
        if (onX && onZ) { put(x, yy, z, frameB); continue }
        const along = onX ? z : x
        if (h >= 1 && h <= wallH - 2 && along % 3 === 0 && Math.abs(along) < (onX ? rz : rx)) { put(x, yy, z, winB); continue }
        put(x, yy, z, along % 4 === 0 ? frameB : wallB)
      }
    }
  }
  y += wallH

  // ------------------------------------------------------------- gabled roof
  // Narrows in x only, so the ridge runs along z -- the classic 切妻 profile.
  for (let j = 0; j < pitch + eaves; j++) {
    const half = rx + eaves - j
    if (half < 0) break
    const zEnd = rz + eaves - Math.max(0, j - eaves) // the ends draw in a little too
    for (let x = -half; x <= half; x++) {
      for (let z = -zEnd; z <= zEnd; z++) {
        if (Math.abs(x) === half || Math.abs(z) === zEnd || j === pitch + eaves - 1) put(x, y + j, z, roofB)
        else put(x, y + j, z, 'air')
      }
    }
    if (half === 0) break
  }
  const ridgeY = y + Math.min(pitch + eaves - 1, rx + eaves)
  const ridgeZ = rz + eaves - Math.max(0, (rx + eaves) - eaves)
  for (let z = -Math.abs(ridgeZ); z <= Math.abs(ridgeZ); z++) put(0, ridgeY, z, roofB)
  // 鰹木: short logs laid across the ridge
  for (let z = -Math.abs(ridgeZ) + 1; z <= Math.abs(ridgeZ) - 1; z += 3) {
    put(-1, ridgeY + 1, z, frameB); put(0, ridgeY + 1, z, frameB); put(1, ridgeY + 1, z, frameB)
  }
  // 千木: crossed finials at both gable ends
  for (const s of [-1, 1]) {
    const z = s * Math.abs(ridgeZ)
    put(0, ridgeY + 1, z, frameB)
    put(0, ridgeY + 2, z, frameB)
    put(-1, ridgeY + 2, z, frameB)
    put(1, ridgeY + 2, z, frameB)
    put(0, ridgeY + 3, z, frameB)
  }
  return out
}
