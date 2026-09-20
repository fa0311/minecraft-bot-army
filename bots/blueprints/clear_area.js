// clear_area: make a box empty (trees, snow, terrain bumps above the base level).
// params: {w=21, d=21, h=8, yOffset=0}
module.exports = (o, p = {}) => {
  const w = p.w || 21; const d = p.d || w; const h = p.h || 8
  const y0 = o.y + (p.yOffset || 0)
  const out = []
  const hx = Math.floor(w / 2); const hz = Math.floor(d / 2)
  for (let y = y0; y < y0 + h; y++) {
    for (let x = -hx; x <= hx; x++) for (let z = -hz; z <= hz; z++) out.push({ x: o.x + x, y, z: o.z + z, block: 'air' })
  }
  return out
}
