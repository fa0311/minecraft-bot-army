// fishing_pier: a FLUSH pier for lib/fishery.js anglers on a frozen lake.
//
// Measured constraints (food-security engineer, 19:16Z): a catch is thrown to the
// angler but is only picked up within 1 block horizontally and <=0.5 below the
// bot's feet, and it does not clear a rim. So the angler's floor must be AT lake
// surface level (block at y = lakeY, feet at lakeY+1) and there must be NO wall on
// the water side. This blueprint therefore only lays flush cobble + lit posts; the
// fishers cut their own channel/pad holes (`openHole`).
//
// origin = (x0, lakeY, z0) -- the pier's first block.
// params:
//   x1, z1      inclusive far end of the pier rectangle (default = origin, i.e. 1 block)
//   block       pier material (default cobblestone)
//   headroom    air cleared above the pier (default 4; the bobber needs open sky)
//   torches     [[x, z], ...] absolute XZ for torches standing ON the pier (y+1)
//   posts       [[x, z], ...] absolute XZ where a block is set into the ice (y) with
//               a torch on top (y+1) to keep a fishing pad from re-freezing
module.exports = (o, p = {}) => {
  const x0 = Math.min(o.x, p.x1 == null ? o.x : p.x1)
  const x1 = Math.max(o.x, p.x1 == null ? o.x : p.x1)
  const z0 = Math.min(o.z, p.z1 == null ? o.z : p.z1)
  const z1 = Math.max(o.z, p.z1 == null ? o.z : p.z1)
  const block = p.block || 'cobblestone'
  const headroom = p.headroom == null ? 4 : p.headroom
  const out = []
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = 1; y <= headroom; y++) out.push({ x, y: o.y + y, z, block: 'air' })
      out.push({ x, y: o.y, z, block })
    }
  }
  for (const t of (p.torches || [])) {
    out.push({ x: t[0], y: o.y + 1, z: t[1], block: 'torch' })
  }
  for (const q of (p.posts || [])) {
    out.push({ x: q[0], y: o.y, z: q[1], block })
    out.push({ x: q[0], y: o.y + 1, z: q[1], block: 'torch' })
  }
  return out
}
