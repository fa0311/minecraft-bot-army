// dorm: THE DORMITORY - a roofed, lit hall with a bed slot for every bot. World 1: ONE bed for 30 bots; when a creeper took it nights were real
// again and 7 bots died; respawn points were "the world spawn, far from the work". Beds come as wool arrives: raise `beds` and bump `rev` -
// bed i keeps its place for ever, so nothing moves. The `build` job registers every bed that stands in settings.respawnBeds (the foot cell),
// and the sleeper job uses the first of them.
//
//   z+0  # # # # # # # # #      # = wall (any stone sort), 3 high, roof (any planks; `roof:'stone'`) on top, torches on the roof: nothing spawns up there
//   z+1  h h h h h h h h #      h = bed HEAD, f = bed FOOT (`facing` north row: north / south row: south - the builder stands in the aisle, behind the foot)
//   z+2  f f f f f f f f #
//   z+3  . i . . . i . . G      aisle 2 wide, ground torches (i) every 4; G = FENCE GATES in both end walls (our pathfinder opens gates, never doors)
//   z+4  . . . . . . . . G
//   z+5  f f f f f f f f #
//   z+6  h h h h h h h h #
//   z+7  # # # # # # # # #
//
// origin = NW corner (min x, min z), y = GROUND level (the floor IS the ground: filled where there is a hole; floor:'planks'|'stone' paves it).
// Footprint: (slots / 2 + 2) x 8, inside the slot w x d when given. params: w, d = the slot, slots=30 (bed places; even; at most 2 * (w - 2)), beds=1 (how many beds to PLACE now, 0..slots; bed 0 = the sleeper's),
//         wall='stone', roof='planks', floor=null, torch=true
const M = require('./lib/mats')
const size = (p = {}) => { const slots = Math.max(2, (Math.min(p.slots || 30, p.w ? 2 * (p.w - 2) : 1e9) + 1) & ~1); return { slots, w: slots / 2 + 2, d: 8 } }
module.exports = (o, p = {}) => {
  const { slots, w, d } = size(p); const beds = Math.max(0, Math.min(slots, p.beds == null ? 1 : p.beds)); const H = 3
  const wall = M.mat(p.wall, 'stone'); const roof = M.mat(p.roof, 'planks'); const floor = p.floor ? M.mat(p.floor) : { block: 'dirt', fillOnly: true }
  const out = []; const put = (dx, dy, dz, cell) => out.push(Object.assign({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, cell))
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
    put(dx, 0, dz, Object.assign({}, floor))
    const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1; const gate = (dx === 0 || dx === w - 1) && (dz === 3 || dz === 4)
    for (let y = 1; y <= H; y++) {
      if (gate && y === 1) put(dx, y, dz, M.wood('fence_gate', { axis: 'z' }))
      else if (gate && y === 2) put(dx, y, dz, { block: 'air' })
      else if (edge) put(dx, y, dz, Object.assign({}, wall))
      else if (y === 1 && dz === 3 && dx % 4 === 2 && p.torch !== false) put(dx, y, dz, { block: 'torch', needs: 'below' })
      else put(dx, y, dz, { block: 'air' })
    }
    put(dx, H + 1, dz, Object.assign({}, roof))
    if (p.torch !== false && dx % 6 === 1 && (dz === 1 || dz === 6)) put(dx, H + 2, dz, { block: 'torch', needs: 'below' })
  }
  // bed i: even = north row, odd = south row, filling from the west; the foot is the cell the builder clicks, the head lands one further along `facing`
  for (let i = 0; i < beds; i++) { const dx = 1 + Math.floor(i / 2); if (i % 2 === 0) put(dx, 1, 2, M.bed({ facing: 'north' })); else put(dx, 1, 5, M.bed({ facing: 'south' })) }
  return out
}
module.exports.meta = p => { const s = size(p); return { origin: 'nw', y: 'ground', w: s.w, d: s.d } }
