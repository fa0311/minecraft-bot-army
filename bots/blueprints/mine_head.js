// mine_head: THE MINE ENTRANCE on the surface - a level pad, a roofed hut (mob-proof rest between shifts), a bed
// slot, light - laid AROUND the stair mouth. The stairwell itself is dug, walled, lit and OWNED by the miner (contract: settings.mineHead
// {x,y,z,facing} = this origin + `facing`); this blueprint never places or clears a cell of the STAIR STRIP (3 wide from the mouth along
// `facing`, the entrance column in its middle - whichever side the miner's 2nd column lies, it is free), and it is in the build job's NO_PAD
// list: the generic pad rule fills holes in the ground layer, and the stair IS a hole (world 1: a 140-step commute began at a bare hole in the
// yard, 39 exposed coal ores around it, no chest, no bed - hauls were carried 200 blocks to the depot).
//
// Local axes: u = along `facing` (the way the stairs descend), v = across. Mouth = (u 0, v 0).
//   u -5        # # # # # # #      back wall           # = wall (any stone sort) 3 high, roof (stone sorts) over u -5..-1, torches on the roof
//   u -4        # . . i . . #      i = ground torch (no chests: the army has ONE storage complex, the depot)
//   u -3        # . . . . h #      h/f = bed slot (param bed:true when a bed is in stock; head towards the back wall)
//   u -2        # . . . . f #
//   u -1        # . . . . . #      open front: no wall, no door - the hut opens onto the mouth
//   u  0..      i  [stairs]  i     the miner's strip v -1..1 (untouched), a torch on either side of the mouth
// Pad: u -6..2, v -4..4 without the strip: ground filled where there is a hole, 4 cells of headroom.
//
// origin = centre = the STAIR MOUTH [x, y, z] (`armyctl.js plan-base`: the middle of the 15x15 mine zone = the miner's entrance), y = GROUND level at the
// mouth. Everything stays within 6 of the origin. params: facing='south' ('north'|'south'|'east'|'west'), bed=false, torch=true
const M = require('./lib/mats')
const DIR = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
module.exports = (o, p = {}) => {
  const facing = DIR[p.facing] ? p.facing : 'south'; const [fx, fz] = DIR[facing]; const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[facing]
  const out = []; const put = (u, dy, v, cell) => out.push(Object.assign({ x: o.x + u * fx - v * fz, y: o.y + dy, z: o.z + u * fz + v * fx }, cell))
  const strip = (u, v) => u >= 0 && Math.abs(v) <= 1
  // NO CHESTS HERE (owner 09-20 「鉱山出入り口の謎のチェスト、謎の土の盛り上がりはどうなってんの」): ONE storage complex for the army (the depot + base_depot_south, 45
  // blocks away). A satellite store scatters the stock, hides the haul from the chest index and reads as litter to everyone who walks past. The hut, its roof, the
  // torches and the free stair mouth stay - the miners bank at the depot like everybody else, and tidy's furniture-litter rule empties and removes the four old ones.
  const furn = {}
  if (p.torch !== false) furn['-4,0'] = { block: 'torch', needs: 'below' }
  if (p.bed) furn['-2,2'] = M.bed({ facing: back })
  for (let u = -6; u <= 2; u++) for (let v = -4; v <= 4; v++) {
    if (strip(u, v)) continue
    put(u, 0, v, { block: 'dirt', fillOnly: true })
    const hut = u >= -5 && u <= -1 && Math.abs(v) <= 3; const wall = hut && (u === -5 || Math.abs(v) === 3)
    for (let y = 1; y <= 3; y++) {
      const f = y === 1 ? furn[u + ',' + v] : null
      if (wall) put(u, y, v, M.stone())
      else if (f) put(u, y, v, Object.assign({}, f))
      else if (y === 1 && p.torch !== false && ((u === 0 && Math.abs(v) === 2) || ((u === -6 || u === 2) && Math.abs(v) === 4))) put(u, y, v, { block: 'torch', needs: 'below' })
      else put(u, y, v, { block: 'air' })
    }
    if (hut) { put(u, 4, v, M.stone()); if (p.torch !== false && (u === -5 || u === -1) && Math.abs(v) === 3) put(u, 5, v, { block: 'torch', needs: 'below' }) } else put(u, 4, v, { block: 'air' })
  }
  return out
}
module.exports.meta = () => ({ origin: 'centre', y: 'ground', w: 13, d: 13, reach: { u: [-6, 2], v: [-4, 4] } })
