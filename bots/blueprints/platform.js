// platform: a flat pad + cleared headroom. Good for levelling a build site.
// params: {w=21, d=21, block='cobblestone', clear=6, border=null}
module.exports = (o, p = {}) => {
  const w = p.w || 21; const d = p.d || w
  const block = p.block || 'cobblestone'
  const clear = p.clear == null ? 6 : p.clear
  const hx = Math.floor(w / 2); const hz = Math.floor(d / 2)
  const out = []
  for (let x = -hx; x <= hx; x++) {
    for (let z = -hz; z <= hz; z++) {
      const edge = (Math.abs(x) === hx || Math.abs(z) === hz)
      out.push({ x: o.x + x, y: o.y, z: o.z + z, block: (p.border && edge) ? p.border : block })
      for (let y = 1; y <= clear; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: 'air' })
    }
  }
  return out
}
