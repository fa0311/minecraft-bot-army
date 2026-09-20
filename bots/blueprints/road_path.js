// road_path -- a paved road that FOLLOWS THE TERRAIN, with lamp posts.
//
// Blueprint generators get no world access, so the terrain profile is passed in:
// sample it once with a bot and bake it into the job params (see
// `bots/tools/sample_path.js`, which writes ready-made params).
//
// origin is ignored except as a fallback; y comes from the points themselves.
// params:
//   points   [[x,y,z], ...] centre line, y = the block the road surface sits ON
//            (the surface is placed AT y, i.e. it replaces the top terrain block).
//            An optional 4th element is the ORIGINAL ground height there: the road
//            is then carried down to it as a solid causeway, so a smoothed, walkable
//            grade can cross a dip without floating in the air.
//   width    road width, odd                     (default 3)
//   block    paving                              (default 'cobblestone')
//   edge     edging block, '' for none           (default 'stone')
//   clear    air blocks above the road           (default 3)
//   base     extra paving carried downwards everywhere (default 0 -- filling below
//            ground level just makes bots dig out buried terrain and replace it)
//   lamp     lamp post spacing in metres, 0=none (default 12)
//   post     lamp post block                     (default 'log')
//   light    lamp block on top                   (default 'torch')
//   postH    lamp post height                    (default 3)
module.exports = (o, p = {}) => {
  const pts = (p.points || []).map(q => Array.isArray(q) ? { x: q[0], y: q[1], z: q[2], g: q[3] } : q)
  if (pts.length < 2) return []
  const width = ((p.width || 3) | 1)
  const block = p.block || 'cobblestone'
  const edge = p.edge === undefined ? 'stone' : p.edge
  const clear = p.clear == null ? 3 : p.clear
  const base = p.base == null ? 0 : p.base
  const maxFill = p.maxFill == null ? 10 : p.maxFill
  const lamp = p.lamp == null ? 12 : p.lamp
  const postB = p.post || 'log'
  const lightB = p.light || 'torch'
  const postH = p.postH == null ? 3 : p.postH

  const out = []
  const seen = new Set()
  let travelled = 0
  let nextLamp = lamp

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]; const b = pts[i + 1]
    const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z
    const n = Math.max(Math.abs(dx), Math.abs(dz)) || 1
    for (let s = 0; s < n || (i === pts.length - 2 && s === n); s++) {
      const cx = Math.round(a.x + dx * s / n)
      const cz = Math.round(a.z + dz * s / n)
      const cy = Math.round(a.y + dy * s / n)
      const ground = (a.g == null || b.g == null) ? null : Math.round(a.g + (b.g - a.g) * s / n)
      const fill = ground == null ? base : Math.max(base, Math.min(maxFill, cy - ground))
      // road runs across the direction of travel
      const acrossX = Math.abs(dx) < Math.abs(dz)
      const half = (width - 1) / 2
      for (let w = -half; w <= half; w++) {
        const x = acrossX ? cx + w : cx
        const z = acrossX ? cz : cz + w
        const key = x + ',' + cy + ',' + z
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ x, y: cy, z, block: (edge && Math.abs(w) === half) ? edge : block })
          for (let d = 1; d <= fill; d++) out.push({ x, y: cy - d, z, block })
          for (let h = 1; h <= clear; h++) out.push({ x, y: cy + h, z, block: 'air' })
        }
      }
      travelled++
      if (lamp > 0 && travelled >= nextLamp) {
        nextLamp += lamp
        const w = half + 1
        const x = acrossX ? cx + w : cx
        const z = acrossX ? cz : cz + w
        out.push({ x, y: cy, z, block })
        for (let h = 1; h <= postH; h++) out.push({ x, y: cy + h, z, block: postB })
        out.push({ x, y: cy + postH + 1, z, block: lightB })
      }
    }
  }
  return out
}
