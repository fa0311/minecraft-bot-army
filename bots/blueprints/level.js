// level: LEVEL a rectangle to one height — cut everything above, fill everything below with a cap (整地).
// origin = centre, y = the finished ground level. params: w=15, d=15, fill='dirt' (top layer block), depth=3 (how far down holes are filled),
// (depth 1 is enough: A.placeHard builds the support column under a floating top cell by itself)
// clear=4 (headroom cleared above). Trees inside are NOT felled by this (air cells skip logs/leaves is up to the builder: logs are dug too).
module.exports = (o, p = {}) => {
  const w = p.w || 15; const d = p.d || w; const fill = p.fill || 'dirt'
  const depth = p.depth == null ? 1 : p.depth; const clear = p.clear == null ? 4 : p.clear
  const hx = Math.floor(w / 2); const hz = Math.floor(d / 2); const out = []
  for (let x = -hx; x <= hx; x++) for (let z = -hz; z <= hz; z++) {
    for (let y = -depth + 1; y <= 0; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: fill, fillOnly: true }) // only where there is a hole
    for (let y = 1; y <= clear; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: 'air' })
  }
  return out
}
