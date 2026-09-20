// sakura -- 桜の木: a giant cherry-blossom tree sculpture. A leaning, tapering
// trunk of logs, several main boughs, and blossom clouds at every bough tip.
//
// Fully deterministic (fixed LCG seed): every bot must generate exactly the same
// blocks or they would fight over the build.
//
// origin = foot of the trunk, y = ground layer.
// params:
//   height    trunk height                        (default 16)
//   boughs    number of main branches             (default 7)
//   spread    how far the boughs reach outwards   (default 9)
//   blossom   canopy block (pink_wool when the food team has sheep; snow_block,
//             white_wool or cherry_leaves also look right)  (default 'pink_wool')
//   trunk     log block                           (default 'log')
//   root      block for the root flare / mound    (default 'coarse_dirt')
//   seed      integer, changes the shape          (default 7)
module.exports = (o, p = {}) => {
  const height = p.height || 16
  const boughs = p.boughs || 7
  const spread = p.spread || 9
  const blossomB = p.blossom || 'pink_wool'
  const trunkB = p.trunk || 'log'
  const rootB = p.root || 'coarse_dirt'
  let s = (p.seed == null ? 7 : p.seed) >>> 0 || 7
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }

  const map = new Map()
  const put = (x, y, z, b) => {
    const k = x + ',' + y + ',' + z
    // logs win over blossom where they overlap, so boughs stay readable
    if (map.has(k) && b === blossomB) return
    map.set(k, { x: o.x + x, y, z: o.z + z, block: b })
  }
  const blob = (cx, cy, cz, r) => {
    const r2 = r * r
    for (let x = -r; x <= r; x++) {
      for (let y = -r; y <= r; y++) {
        for (let z = -r; z <= r; z++) {
          // squash vertically -> a cloud rather than a ball, and nibble the edge
          const dd = x * x + (y * 1.6) * (y * 1.6) + z * z
          if (dd > r2) continue
          if (dd > r2 * 0.55 && rnd() < 0.35) continue
          put(cx + x, cy + y, cz + z, blossomB)
        }
      }
    }
  }

  // ------------------------------------------------------------- root flare
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      const m = Math.abs(x) + Math.abs(z)
      if (m > 3) continue
      put(x, o.y, z, m >= 2 ? rootB : trunkB)
      if (m <= 1) put(x, o.y + 1, z, trunkB)
    }
  }

  // ----------------------------------------------------------------- trunk
  // leans gently and thins out with height
  let tx = 0; let tz = 0
  const leanX = rnd() < 0.5 ? 1 : -1
  const trunkPts = []
  for (let h = 1; h <= height; h++) {
    if (h % 5 === 0) { tx += leanX; tz += rnd() < 0.5 ? 1 : 0 }
    const r = h < height * 0.45 ? 1 : 0
    for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) put(tx + x, o.y + h, tz + z, trunkB)
    trunkPts.push({ x: tx, y: o.y + h, z: tz })
  }

  // ----------------------------------------------------------------- boughs
  for (let i = 0; i < boughs; i++) {
    const frac = 0.45 + 0.55 * (i / Math.max(1, boughs - 1))
    const start = trunkPts[Math.min(trunkPts.length - 1, Math.floor(trunkPts.length * frac) - 1)]
    const ang = (i / boughs) * Math.PI * 2 + rnd() * 0.6
    const len = Math.round(spread * (0.55 + 0.45 * rnd()))
    const rise = 0.55 + rnd() * 0.5
    let bx = start.x; let by = start.y; let bz = start.z
    for (let t = 1; t <= len; t++) {
      bx = start.x + Math.round(Math.cos(ang) * t)
      bz = start.z + Math.round(Math.sin(ang) * t)
      by = start.y + Math.round(rise * t * 0.7)
      put(bx, by, bz, trunkB)
      if (t % 3 === 0) put(bx, by - 1, bz, trunkB) // thicken a little underneath
    }
    blob(bx, by + 2, bz, 4 + Math.floor(rnd() * 2))
  }
  // a crown of blossom over the top of the trunk
  const top = trunkPts[trunkPts.length - 1]
  blob(top.x, top.y + 3, top.z, 5)

  return [...map.values()]
}
