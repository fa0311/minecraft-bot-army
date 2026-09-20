// pen: an ANIMAL PEN - fence ring (any wood), ONE fence gate, lit. World 1 had no animals within reach and lived on berries; a base chosen for its
// animals keeps them: breeders lead/lure the herd in, the gate is the only opening (our pathfinder opens "gate" blocks, never doors).
// The ground stays grass (holes filled): sheep regrow wool by eating it. Torches stand on the ground INSIDE the corners and along the sides.
//
// origin = NW corner (min x, min z) of the fence ring, y = GROUND level (the fence stands on it). params: w=16, d=w, gate='w' ('n'|'s'|'e'|'w': the
//         side whose middle holds the gate; the base plan's pens lie east of a road, so west is the default), torch=true
const M = require('./lib/mats')
const size = (p = {}) => ({ w: Math.max(5, p.w || 16), d: Math.max(5, p.d || p.w || 16) })
module.exports = (o, p = {}) => {
  const { w, d } = size(p); const side = /^[nsew]$/.test(p.gate || '') ? p.gate : 'w'; const out = []
  const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  const gx = side === 'w' ? 0 : side === 'e' ? w - 1 : Math.floor(w / 2); const gz = side === 'n' ? 0 : side === 's' ? d - 1 : Math.floor(d / 2)
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
    put(dx, 0, dz, { block: 'dirt', fillOnly: true })
    const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1
    if (edge) { put(dx, 1, dz, dx === gx && dz === gz ? M.wood('fence_gate', { axis: side === 'n' || side === 's' ? 'x' : 'z' }) : M.wood('fence')); continue }
    const ix = dx === 1 || dx === w - 2 ? 0 : (dx - 1) % 7; const iz = dz === 1 || dz === d - 2 ? 0 : (dz - 1) % 7
    if (p.torch !== false && (dx === 1 || dx === w - 2 || dz === 1 || dz === d - 2) && ix === 0 && iz === 0) put(dx, 1, dz, { block: 'torch', needs: 'below' })
  }
  return out
}
module.exports.meta = p => Object.assign({ origin: 'nw', y: 'ground' }, size(p))
