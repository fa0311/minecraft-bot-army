// core: THE HEART OF THE BASE on one level - the ONE crafting table and a furnace bank of 16 in a hall strip, with the ground for the depot rows
// south of it. World 1: two furnaces starved every charcoal/torch/iron plan, 62 crafting tables littered the map, the depot grew over pits. Here
// everything a returning bot needs stands on one pad, a few steps apart, and is registered by the `build` job (settings.craftTable - first
// table wins; settings.furnaces; the depot's chests -> settings.chests when `depot_rows` is built).
//
//   z+0        free walkway
//   z+1        . . . . . . . . F F F F F F F F F F F F F F F F . X . . . . . .      F = furnace (x+8..), a torch on every 3rd; X = crafting table
//   z+2,3      paved walkway in front of the bank (any stone sort)
//   z+4..z+9   free ground, ground torches on a pitch-8 lattice (nothing spawns)
//   z+12..     (only when d >= 30) the DEPOT SLOT: left untouched for `depot_rows` at origin [x, y, z+12], args {w, d: d-12}
// `armyctl.js plan-base` builds the hall as w=32, d=10 and lays `depot_rows` 32x20 south of it inside the same 32x32 zone.
//
// origin = NW corner (min x, min z), y = GROUND level (the pad; furniture stands on it). params: w=32, d=32 (w >= 14, d >= 6), furnaces=16
//         (as many as fit: w - 12), floor=null (keep the levelled ground; 'stone' = pave it), torch=true
const M = require('./lib/mats')
const size = (p = {}) => { const w = Math.max(14, p.w || 32); const d = Math.max(6, p.d || 32); return { w, d, hall: d >= 30 ? 10 : d } }
module.exports = (o, p = {}) => {
  const { w, hall } = size(p); const n = Math.max(1, Math.min(w - 12, p.furnaces || 16)); const fx0 = Math.max(1, Math.floor((w - n - 2) / 2) + 1); const out = []
  const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  const floor = p.floor ? M.mat(p.floor) : { block: 'dirt', fillOnly: true }
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < hall; dz++) {
    put(dx, 0, dz, Object.assign({}, floor))
    const lamp = p.torch !== false && dx % 8 === 4 && dz % 8 === 5
    for (let y = 1; y <= 4; y++) put(dx, y, dz, lamp && y === 1 ? { block: 'torch', needs: 'below' } : { block: 'air' })
  }
  // the furnace bank (ONE implementation: blueprint furnace_bank), row along +x, walkway to the south; later cells win over the pad cells above
  for (const c of require('./furnace_bank')({ x: o.x + fx0, y: o.y + 1, z: o.z + 1 }, { n, axis: 'x', front: 1, walk: 2, floor: 'stone', torchEvery: 3 })) out.push(c)
  put(fx0 + n + 1, 1, 1, { block: 'crafting_table' })
  return out
}
module.exports.meta = p => { const s = size(p); return { origin: 'nw', y: 'ground', w: s.w, d: s.hall, slots: s.hall < s.d ? { depot_rows: { dx: 0, dz: 12, w: s.w, d: s.d - 12 } } : {} } }
