// pyramid: stepped pyramid. Hollow by default (shell + floor) so it is buildable
// in a sane amount of time, but `solid:true` gives the real thing.
// origin = centre of the base, y = base layer.
// params: {base=41, block='cobblestone', accent=null, hollow=true, shell=1, chamber=true}
module.exports = (o, p = {}) => {
  const base = (p.base || 41) | 1
  const block = p.block || 'cobblestone'
  const accent = p.accent || null
  const hollow = p.hollow !== false
  const shell = p.shell || 1
  const out = []
  const put = (x, y, z, b) => out.push({ x: o.x + x, y, z: o.z + z, block: b })
  const levels = (base - 1) / 2 + 1
  for (let i = 0; i < levels; i++) {
    const r = (base - 1) / 2 - i
    const y = o.y + i
    if (r < 0) break
    const b = (accent && i % 5 === 4) ? accent : block
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        const ring = Math.max(Math.abs(x), Math.abs(z))
        if (!hollow || i === 0 || ring > r - shell) put(x, y, z, b)
        else put(x, y, z, 'air')
      }
    }
  }
  // entrance tunnel on the -z side at the base
  if (p.entrance !== false) {
    const r0 = (base - 1) / 2
    for (let z = -r0; z <= -r0 + 3; z++) for (let i = 1; i <= 3; i++) for (const x of [-1, 0, 1]) put(x, o.y + i, z, 'air')
  }
  return out
}
