// bridge -- a stone arch bridge with railings and lamp posts.
//
// origin = the START of the deck (centre line), y = deck level.
// params:
//   toX, toZ   end of the deck (one of them must differ from the origin)
//   width      deck width, odd                      (default 5)
//   rise       how far the arch springs below deck   (default 6)
//   spans      number of arches                      (default 2)
//   pierW      half-width of the piers               (default 1)
//   lamp       lamp post spacing, 0 = none           (default 8)
//   deck/arch/rail/post/light                        block names
// The arch ribs stop at `rise` below the deck: piers are carried down another
// `footing` blocks so the bridge still meets the ground in a shallow valley.
module.exports = (o, p = {}) => {
  const width = ((p.width || 5) | 1)
  const rise = p.rise == null ? 6 : p.rise
  const spans = Math.max(1, p.spans || 2)
  const pierW = p.pierW == null ? 1 : p.pierW
  const lamp = p.lamp == null ? 8 : p.lamp
  const footing = p.footing == null ? 6 : p.footing
  const deckB = p.deck || 'cobblestone'
  const archB = p.arch || 'cobblestone'
  const railB = p.rail || 'cobblestone'
  const postB = p.post || 'log'
  const lightB = p.light || 'torch'

  const toX = p.toX == null ? o.x + 40 : p.toX
  const toZ = p.toZ == null ? o.z : p.toZ
  const dx = toX - o.x
  const dz = toZ - o.z
  const alongX = Math.abs(dx) >= Math.abs(dz)
  const L = Math.max(Math.abs(dx), Math.abs(dz))
  const dir = (alongX ? dx : dz) >= 0 ? 1 : -1
  const half = (width - 1) / 2

  const out = []
  // a = distance along the bridge, b = sideways offset
  const put = (a, y, b, block) => {
    const x = alongX ? o.x + dir * a : o.x + b
    const z = alongX ? o.z + b : o.z + dir * a
    out.push({ x, y, z, block })
  }

  const spanLen = L / spans
  for (let a = 0; a <= L; a++) {
    // ---- deck + clearance above it
    for (let b = -half; b <= half; b++) {
      put(a, o.y, b, deckB)
      for (let h = 1; h <= 4; h++) put(a, o.y + h, b, 'air')
    }
    // ---- railings
    for (const b of [-half, half]) {
      put(a, o.y + 1, b, railB)
      if (a % 4 === 0) put(a, o.y + 2, b, railB)
    }
    // ---- lamp posts
    if (lamp > 0 && a > 0 && a < L && a % lamp === 0) {
      for (const b of [-half, half]) {
        put(a, o.y + 2, b, postB)
        put(a, o.y + 3, b, postB)
        put(a, o.y + 4, b, lightB)
      }
    }
    // ---- arch ribs under the deck
    const t = (a % spanLen) / spanLen // 0..1 within this span
    const k = Math.abs(2 * t - 1) // 0 at the crown, 1 at a pier
    const depth = Math.round(rise * (1 - k * k))
    for (let h = 1; h <= rise - depth; h++) {
      for (const b of [-half, half]) put(a, o.y - h, b, archB)
      if (h > rise - depth - 1) for (let b = -half; b <= half; b++) put(a, o.y - h, b, archB)
    }
    // ---- piers at the span joints (and both abutments)
    const atPier = a === 0 || a === L || Math.abs(a % spanLen) < 0.5 || Math.abs(spanLen - (a % spanLen)) < 0.5
    if (atPier) {
      for (let h = 1; h <= rise + footing; h++) {
        for (let b = -pierW; b <= pierW; b++) put(a, o.y - h, b, archB)
      }
    }
  }
  return out
}
