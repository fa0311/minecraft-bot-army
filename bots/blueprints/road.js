// road: a straight PAVED road from origin towards {toX,toZ}, flush with the ground, lit. World 1 had no roads: 30 bots wore private paths, and every
// "no_route" was answered with a dig. A road is the reusable answer - 3 wide (two bots pass), any stone sort, a ground torch on its edge every 8
// (alternating sides; a torch has no collision, nothing spawns on the road, and the pitch-8 torch grid of the base never has to stand ON it).
// Terrain-spanning (NO_PAD list of the build job). ONE HEIGHT: this is the flat road of a levelled site (base lattice: every pad beside it has the same y); it cuts
// through a rise (headroom `clear`) and fills a dip (sub-base cell under the paving). Across open country use `road_path` (follows a sampled terrain profile).
// origin = the START of the centre line, y = GROUND level (the paving replaces the top block). params: toX, toZ (end of the centre line),
//         width=3, block='stone' ('stone' = any stone sort | 'planks' | a block name), clear=3 (headroom), torchEvery=8 (0 = none), shoulder=4 (0 = none)
// NEVER A TRENCH (foreman 09-20 03:58Z: road 11 = cobble y68 with natural grass y72 one block beside it; roads 6 and 11 ran between 4-block walls - a bot on
// the road could not leave it, a bot beside it could not enter: the no_route tickets at the base edge). The road keeps its ONE height; its SHOULDERS are
// TERRACED: s cells out from the paving the ground may stand at most s above the road, so the bank is cut back in 1-block steps, `shoulder` cells wide on
// both sides (4 = a 4-block bank becomes a stair anybody walks up). Shoulder cells are `natural:true` air: the build job takes ONLY natural ground there
// (dirt, grass, stone, sand ...), never a wall, a fence, a crop or a block with furniture on it - the pads, fields and halls beside the road are not terrain.
const M = require('./lib/mats')
module.exports = (o, p = {}) => {
  const out = []
  const w = p.width || 3; const block = M.mat(p.block, 'stone'); const clear = p.clear == null ? 3 : p.clear; const every = p.torchEvery == null ? 8 : p.torchEvery
  const dx = (p.toX == null ? o.x + 20 : p.toX) - o.x
  const dz = (p.toZ == null ? o.z : p.toZ) - o.z
  const n = Math.max(Math.abs(dx), Math.abs(dz)) || 1
  const half = Math.floor(w / 2); const alongX = Math.abs(dx) >= Math.abs(dz)
  const seen = new Set(); const lamps = new Set(); const sh = p.shoulder == null ? 4 : p.shoulder; const line = []
  if (every) for (let i = 0, k = 0; i <= n; i += every, k++) { const cx = Math.round(o.x + dx * i / n); const cz = Math.round(o.z + dz * i / n); const s = (k % 2 ? 1 : -1) * half; lamps.add(alongX ? cx + ',' + (cz + s) : (cx + s) + ',' + cz) }
  for (let i = 0; i <= n; i++) {
    const cx = Math.round(o.x + dx * i / n); const cz = Math.round(o.z + dz * i / n); line.push([cx, cz])
    for (let a = -half; a <= half; a++) for (let b = -half; b <= half; b++) {
      const k = (cx + a) + ',' + (cz + b)
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ x: cx + a, y: o.y - 1, z: cz + b, block: 'dirt', fillOnly: true, unlid: true }) // SUB-BASE: a hole under the line is filled from the natural ground up BEFORE the paving goes on; paving that stands as a deck over air is taken off first (build job: never a deck over air)
      out.push(Object.assign({ x: cx + a, y: o.y, z: cz + b }, block))
      for (let y = 1; y <= clear; y++) out.push(lamps.has(k) && y === 1 ? { x: cx + a, y: o.y + y, z: cz + b, block: 'torch', needs: 'below' } : { x: cx + a, y: o.y + y, z: cz + b, block: 'air' })
      for (let y = clear + 1; sh && y <= sh + 3; y++) out.push({ x: cx + a, y: o.y + y, z: cz + b, block: 'air', natural: true }) // no ROOF of turf over the road either: under a 4-block bank the 3 cells of headroom left y72 floating over the paving (the red float line at x -272..-261 / z -492 in the foreman's picture)
    }
  }
  // shoulders: AFTER the paving, so a paving column is never a shoulder cell (seen); across the line only (the ends of a road meet other roads and pads)
  for (const [cx, cz] of line) for (let s = 1; s <= sh; s++) for (const side of [-1, 1]) {
    const x = alongX ? cx : cx + side * (half + s); const z = alongX ? cz + side * (half + s) : cz; const k = x + ',' + z
    if (seen.has(k)) continue
    seen.add(k)
    for (let y = o.y + s + 1; y <= o.y + sh + 3; y++) out.push({ x, y, z, block: 'air', natural: true }) // ground here may stand at o.y + s; everything natural above goes (2 cells of headroom over the top step)
  }
  return out
}
