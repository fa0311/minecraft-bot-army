// torii -- 鳥居: a giant shrine gate. Two thick pillars carrying a curved top
// lintel (笠木/島木) and a lower tie beam (貫), with a stone plinth under each pillar.
//
// origin = centre of the gateway (between the pillars), y = ground layer.
// params:
//   span    distance between pillar centres      (default 15, odd)
//   height  pillar height above ground           (default 16)
//   thick   pillar thickness (1..3)              (default 3)
//   axis    'x' or 'z' -- the gate faces across it (default 'x')
//   over    how far the top lintel oversails     (default 4)
//   pillar/beam/plinth                           block names
module.exports = (o, p = {}) => {
  const span = ((p.span || 15) | 1)
  const height = p.height || 16
  const thick = Math.min(3, Math.max(1, p.thick || 3))
  const axis = p.axis === 'z' ? 'z' : 'x'
  const over = p.over == null ? 4 : p.over
  const pillarB = p.pillar || 'log'
  const beamB = p.beam || 'log'
  const plinthB = p.plinth || 'cobblestone'

  const out = []
  // a/b are "along the gate" / "through the gate"
  const put = (a, y, b, block) => {
    if (axis === 'x') out.push({ x: o.x + a, y, z: o.z + b, block })
    else out.push({ x: o.x + b, y, z: o.z + a, block })
  }
  const half = (span - 1) / 2
  const t = Math.floor(thick / 2)

  for (const s of [-1, 1]) {
    const c = s * half
    // 亀腹 stone plinth
    for (let a = -t - 1; a <= t + 1; a++) {
      for (let b = -t - 1; b <= t + 1; b++) put(c + a, o.y, b, plinthB)
    }
    // 柱 pillar, very slightly battered: full thickness low down, thinner on top
    for (let h = 1; h <= height; h++) {
      const tt = h > height - 3 ? Math.max(0, t - 1) : t
      for (let a = -tt; a <= tt; a++) for (let b = -tt; b <= tt; b++) put(c + a, o.y + h, b, pillarB)
    }
  }

  // 貫 lower tie beam, passing through both pillars
  const tieY = o.y + height - 4
  for (let a = -half - 1; a <= half + 1; a++) for (let b = -1; b <= 1; b++) put(a, tieY, b, beamB)
  // 額束 the small central strut between the two beams
  for (let h = tieY + 1; h < o.y + height + 1; h++) put(0, h, 0, beamB)

  // 島木 the deep beam sitting on the pillars
  const shimaY = o.y + height + 1
  for (let a = -half - over; a <= half + over; a++) for (let b = -1; b <= 1; b++) put(a, shimaY, b, beamB)
  // 笠木 the crowning beam, one wider, and turned up at both tips (反り)
  const kasaY = shimaY + 1
  for (let a = -half - over; a <= half + over; a++) for (let b = -2; b <= 2; b++) put(a, kasaY, b, beamB)
  for (const s of [-1, 1]) {
    const tip = s * (half + over)
    for (let b = -2; b <= 2; b++) {
      put(tip, kasaY + 1, b, beamB)
      put(tip - s, kasaY + 1, b, beamB)
      put(tip, kasaY + 2, b, beamB)
    }
  }

  // keep the gateway itself clear
  for (let h = 1; h <= height; h++) {
    for (let a = -half + t + 1; a <= half - t - 1; a++) {
      for (let b = -2; b <= 2; b++) {
        if (h === tieY - o.y) continue
        if (a === 0 && h > tieY - o.y) continue
        out.push(axis === 'x'
          ? { x: o.x + a, y: o.y + h, z: o.z + b, block: 'air' }
          : { x: o.x + b, y: o.y + h, z: o.z + a, block: 'air' })
      }
    }
  }
  return out
}
