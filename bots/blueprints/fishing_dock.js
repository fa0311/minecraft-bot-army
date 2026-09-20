// fishing_dock: a safe fishing platform over water (Gate 1 food infrastructure).
//
// Bots drown/freeze in this world's water, so the rule is "never stand in it":
// a solid deck one block above the surface, a fence rim so nobody walks off,
// open sky above the deck (fishing needs sky over the bobber), a chest for the
// catch, campfires to cook it without fuel, and torches so the dock is lit.
//
// origin = centre of the DECK (y = deck level = waterY + 1)
// params:
//   w, d        deck size (default 9x7)
//   block       deck material (default 'planks' = any wood)
//   fence       rim material (default 'fence' = any wood)
//   gap         side left open as the walkway to shore: 'north'|'south'|'east'|'west'|null
//   headroom    air blocks cleared above the deck (default 5 -- keep the sky open)
//   campfires   how many campfires on the deck (default 2, max 4)
//   chest       place a chest on the deck (default true)
//   torches     place torches in the deck corners (default true)
module.exports = (o, p = {}) => {
  const w = p.w || 9
  const d = p.d || 7
  const deck = p.block || 'cobblestone'
  const fence = p.fence || 'cobblestone_wall'
  const headroom = p.headroom == null ? 5 : p.headroom
  const gap = p.gap || null
  const hx = Math.floor(w / 2)
  const hz = Math.floor(d / 2)
  const out = []

  // 1. deck + headroom (air first: later entries win when the compiler dedupes)
  for (let x = -hx; x <= hx; x++) {
    for (let z = -hz; z <= hz; z++) {
      out.push({ x: o.x + x, y: o.y, z: o.z + z, block: deck })
      for (let y = 1; y <= headroom; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: 'air' })
    }
  }

  // 2. fence rim, with a 3-wide opening on the shore side
  const isGap = (x, z) => {
    if (!gap) return false
    if (gap === 'north') return z === -hz && Math.abs(x) <= 1
    if (gap === 'south') return z === hz && Math.abs(x) <= 1
    if (gap === 'west') return x === -hx && Math.abs(z) <= 1
    if (gap === 'east') return x === hx && Math.abs(z) <= 1
    return false
  }
  for (let x = -hx; x <= hx; x++) {
    for (let z = -hz; z <= hz; z++) {
      if (Math.abs(x) !== hx && Math.abs(z) !== hz) continue
      if (isGap(x, z)) continue
      out.push({ x: o.x + x, y: o.y + 1, z: o.z + z, block: fence })
    }
  }

  // 3. open water in front of the deck: this lake is frozen, and breaking ice
  // over water turns it back into water. Only the columns a bot can reach from
  // the deck are opened, so nobody has to stand on ice it is about to break.
  const open = p.open == null ? 2 : p.open
  const side = p.openSide || 'east'
  for (let i = 1; i <= open; i++) {
    for (let k = -hz + 1; k <= hz - 1; k++) {
      let x, z
      if (side === 'east') { x = hx + i; z = k } else if (side === 'west') { x = -hx - i; z = k } else if (side === 'south') { x = k; z = hz + i } else { x = k; z = -hz - i }
      out.push({ x: o.x + x, y: o.y - 1, z: o.z + z, block: 'air' })
    }
  }

  // 4. furniture: chest, campfires, corner torches
  if (p.chest !== false) out.push({ x: o.x - hx + 1, y: o.y + 1, z: o.z - hz + 1, block: 'chest' })
  const nFires = Math.max(0, Math.min(4, p.campfires == null ? 2 : p.campfires))
  const firePos = [[0, 0], [2, 0], [-2, 0], [0, 2]]
  for (let i = 0; i < nFires; i++) {
    out.push({ x: o.x + firePos[i][0], y: o.y + 1, z: o.z + firePos[i][1], block: 'campfire' })
  }
  if (p.torches !== false) {
    for (const c of [[-hx + 1, -hz + 1], [hx - 1, -hz + 1], [-hx + 1, hz - 1], [hx - 1, hz - 1]]) {
      if (c[0] === -hx + 1 && c[1] === -hz + 1) continue // that corner holds the chest
      out.push({ x: o.x + c[0], y: o.y + 1, z: o.z + c[1], block: 'torch' })
    }
  }
  return out
}
