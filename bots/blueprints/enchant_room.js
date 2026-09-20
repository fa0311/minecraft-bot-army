// enchant_room: THE ENCHANTING RING - one enchanting table at FULL power (15) in the standard 5x5 player ring.
// Vanilla's rule (verified live 09-20 on Paper 26.2: with this ring the third offer asks exactly 30 levels = power 15):
// a bookshelf counts when it stands 2 blocks out from the table, at the table's own level or one above, AND the cell
// BETWEEN table and shelf is empty at both of those levels. So:
//
//        z-2  B B B B B        B = bookshelf at table level (y), 15 of them
//        z-1  . . . . .        . = AIR at y and y+1 - a torch, a carpet, a slab or a stray block HERE cuts the power
//        z+0  B . T . B        T = the enchanting table (the origin), y
//        z+1  . . . . .
//        z+2  B B B B B
//             x-2     x+2
//
// The 16th ring cell is the DOOR GAP: a bot walks in through it to reach the table. It carries a TORCH (a torch is not a
// bookshelf, so the ring keeps exactly 15 = max power, and the room is lit against spawns) - `torch:false` leaves it open.
// Nothing is placed above y+1 anywhere: extra shelves would be books burnt for power the game caps at 15.
//
// origin = THE TABLE's cell (centre), y = table level = ground + 1. Footprint 5x5 (+1 pad ring -> give the build job `pad:false`
// where the ground is already one level, as inside the base hall).
// params: door='north'|'south'|'east'|'west' (which edge-midpoint of the ring is the way in, default north = -z), torch=true,
//         floor=true (mark the ground layer at y-1 so a hole under the room is filled before the shelves go up).
const DOORS = { north: [0, -2], south: [0, 2], west: [-2, 0], east: [2, 0] }
module.exports = (o, p = {}) => {
  const d = DOORS[p.door] || DOORS.north
  const out = []
  const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (p.floor !== false) put(dx, -1, dz, { block: 'dirt', fillOnly: true }) // the ground layer marks y-1 as THE ground for the pad rule
      const ring = Math.max(Math.abs(dx), Math.abs(dz)) === 2
      const door = dx === d[0] && dz === d[1]
      if (dx === 0 && dz === 0) put(0, 0, 0, { block: 'enchanting_table' })
      else if (ring && !door) put(dx, 0, dz, { block: 'bookshelf' })
      else if (ring && door) put(dx, 0, dz, p.torch === false ? { block: 'air' } : { block: 'torch', needs: 'below' })
      else put(dx, 0, dz, { block: 'air' }) // the 8 inner cells: EMPTY is what carries the power
      put(dx, 1, dz, { block: 'air' }) // head height everywhere: no shelf, no torch, no stray block over the ring
    }
  }
  return out
}
module.exports.meta = () => ({ origin: 'centre', y: 'table (ground + 1)', w: 5, d: 5 })
