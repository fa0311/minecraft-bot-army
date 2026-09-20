// camp: a compact walled CAMP for a squad that lives where it works (a later option: distributed camps far from the base, each with its own
// storage and bed). A camp = mob-proof wall + gate + own storage + furnace + table + bed nook.
// origin = CENTRE of the footprint, y = GROUND level (the wall stands ON y: first wall layer is y+1). Pick open, flat ground (`armyctl.js ground`);
// trees on the footprint are felled first by a `lumber` job with clear:true - the pad rule of `build` only cuts 4 blocks of headroom.
// params:
//   size=13   outer edge (odd, >= 11)          high=4   wall height          gate='s'  side of the ONE 1-wide gate ('n'|'s'|'e'|'w'), gateAt=0 offset from the side's centre
//   block='cobblestone', mats=[accepted substitutes: the wall takes what the depot has - cobbled_deepslate, stone sorts]
//   floor=null  keep the natural ground (holes are filled with dirt by the pad); 'cobblestone' = paved yard (size*size more blocks)
//   bed=false   true = a bed (any colour) in the nook, head towards the furniture wall (set it when a bed is in stock, bump `rev`; the build job registers it in settings.respawnBeds)
//   cats=[8 categories]  barrels, bottom row then top row; default 2 food, 2 tools, 2 build, 1 ores, 1 salvage
// Layout (gate 's', looking north; furniture flips to the south wall when the gate is 'n'):
//   NW corner = ROOFED BED NOOK 3x4 (roof flush with the wall top, open sides - no door to lock the army out), bed foot in its middle,
//   north wall inside: 8 BARRELS (dx -1..2, two high, `cat` tags -> the build job registers them in settings.chests), crafting table dx 4, furnace dx 5
//   (the build job registers furnaces in bots/base.json), ground torches in the inner and outer corners and beside the gate (wallTorches:true = 8 more on the wall inside).
//   Fence gate + 1 air above it + wall over it: our pathfinder opens "gate" blocks only, never doors.
module.exports = (o, p = {}) => {
  const size = Math.max(11, (p.size || 13) | 1); const h = Math.max(3, p.high || 4); const H = (size - 1) / 2; const I = H - 1
  const block = p.block || 'cobblestone'; const mats = p.mats || ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff']
  const side = /^[nsew]$/.test(p.gate || '') ? p.gate : 's'; const ga = Math.max(-I + 1, Math.min(I - 1, p.gateAt | 0))
  const fz = side === 'n' ? 1 : -1 // furniture wall: north, unless the gate is there
  const cats = Array.isArray(p.cats) && p.cats.length === 8 ? p.cats : ['food', 'tools', 'build', 'ores', 'food', 'tools', 'build', 'salvage'] // bottom row, then top row
  const out = []; const put = (dx, dy, dz, b, extra) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz, block: b }, extra || {}))
  // ground layer: marks y as THE ground for the pad rule (the pad adds the ring outside and the headroom); natural ground stays unless floor is given
  for (let dx = -H; dx <= H; dx++) for (let dz = -H; dz <= H; dz++) put(dx, 0, dz, p.floor || 'dirt', p.floor ? { mats: [p.floor].concat(mats) } : { fillOnly: true })
  // wall + gate
  const gx = side === 'n' || side === 's' ? ga : (side === 'w' ? -H : H); const gz = side === 'n' ? -H : side === 's' ? H : ga
  for (let dx = -H; dx <= H; dx++) for (let dz = -H; dz <= H; dz++) {
    if (Math.abs(dx) !== H && Math.abs(dz) !== H) continue
    for (let y = 1; y <= h; y++) {
      if (dx === gx && dz === gz && y === 1) put(dx, y, dz, p.gateBlock || 'fence_gate', { axis: side === 'n' || side === 's' ? 'x' : 'z' })
      else if (dx === gx && dz === gz && y === 2) put(dx, y, dz, 'air')
      else put(dx, y, dz, block, { mats })
    }
  }
  // bed nook: roof over the corner on the furniture side (west end), flush with the wall top
  for (let dx = -I; dx <= -I + 2; dx++) for (let k = 0; k <= 3; k++) put(dx, h, fz * (I - k), block, { mats })
  if (p.bed) put(-I + 1, 1, fz * (I - 2), p.bed === true ? 'bed' : String(p.bed), { facing: fz > 0 ? 'south' : 'north' })
  // storage, table, furnace along the furniture wall
  for (let i = 0; i < 4; i++) for (let lvl = 0; lvl < 2; lvl++) put(-1 + i, 1 + lvl, fz * I, 'barrel', { cat: cats[lvl * 4 + i] })
  put(I - 1, 1, fz * I, 'crafting_table'); put(I, 1, fz * I, 'furnace')
  // light: GROUND torches only by default (always placeable: the pad is their floor) - the four inner corners, the four outer corners, a pair outside the gate.
  // wallTorches:true adds 8 side-mounted torches inside at y+3 (mats:['wall_torch'] = accepted); a builder that tries one before its wall block stands gives that cell up.
  put(-I, 1, fz * I, 'torch'); put(I, 1, fz * (I - 1), 'torch'); put(-I, 1, -fz * I, 'torch'); put(I, 1, -fz * I, 'torch')
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(sx * (H + 1), 1, sz * (H + 1), 'torch')
  const ox = side === 'w' ? -1 : side === 'e' ? 1 : 0; const oz = side === 'n' ? -1 : side === 's' ? 1 : 0
  for (const s of [-1, 1]) put(gx + ox + (oz ? s : 0), 1, gz + oz + (ox ? s : 0), 'torch')
  if (p.wallTorches) { const q = Math.min(3, I - 1); for (const s of [-q, q]) for (const [dx, dz] of [[s, -I], [s, I], [-I, s], [I, s]]) put(dx, 3, dz, 'torch', { mats: ['wall_torch'] }) }
  return out
}
