// berry_hedge: a SAFE sweet-berry farm (the first hedge killed bots: they walked INTO the bushes). Built on its own level pad (PAD RULE of
// the `build` job), away from traffic. The layout is exactly what the `berries` job expects of its plantBox (isLane / isPost there):
//
//   z+0  lane   i───────i──────  walkable soil, open sky
//   z+1  bush   P r r r r r r r  P = 2-high cobble post, r = ROOF block at y+2 over an (empty) bush cell; i = torch at a lane crossing
//   z+2  bush   P r r r r r r r
//   z+3  lane   ───────────────          … repeated `pairs` times; x+0, x+9, x+18 … are CROSS LANES (no roof, no bush)
//
// * every bush cell touches a lane -> bushes are planted and picked from the lane (reach 3), nobody ever stands between the rows;
// * the roof leaves a 1-high gap above the soil: no bot, player or pathfinder node fits INTO a bush cell, before or after planting;
// * ROOF = cobblestone_wall, NOT a full block: SweetBerryBushBlock.randomTick only grows when the light in the block ABOVE the bush is
//   >= 9, and an opaque block there reads 0 (a cobblestone roof stops all growth). A wall has collision but lets the sky light in;
// * soil is dirt/grass (fillOnly: only holes are filled) - the berries job plants on grass_block|dirt|podzol|coarse_dirt only, so the
//   lanes are NOT paved. Torches stand ON THE GROUND at the lane crossings (x+0|9|18… , z+0|3|6…): a torch has no collision, and a bot
//   in a lane cannot see the top face of a 2-high post (eye y+2.6 < y+3), so a torch up there can never be placed from the ground.
// The bushes themselves are planted by the berry squad:  food_berries.params.plantBox = [x, z, x + 9*strips, z + 3*pairs], plantY = y.
//
// origin = NORTH-WEST corner (min x, min z) of the hedge, y = the SOIL level (bushes stand at y+1).
// params: strips=3 (8-long roofed strips per row; width = 9*strips+1), pairs=4 (double bush rows; depth = 3*pairs+1),
//         roof='cobblestone_wall', post='cobblestone', soil='dirt', torch=true
module.exports = (o, p = {}) => {
  const strips = Math.max(1, p.strips || 3); const pairs = Math.max(1, p.pairs || 4)
  const w = 9 * strips + 1; const d = 3 * pairs + 1
  const roof = p.roof || 'cobblestone_wall'; const post = p.post || 'cobblestone'; const soil = p.soil || 'dirt'
  const out = []
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
    const x = o.x + dx; const z = o.z + dz
    out.push({ x, y: o.y, z, block: soil, fillOnly: true })
    const lane = (dz % 3 === 0) || (dx % 9 === 0)
    if (lane) {
      const crossing = (dz % 3 === 0) && (dx % 9 === 0)
      for (let y = 1; y <= 3; y++) out.push({ x, y: o.y + y, z, block: (y === 1 && crossing && p.torch !== false) ? 'torch' : 'air' })
      continue
    }
    if (dx % 9 === 1) { // post: carries the roof strip
      out.push({ x, y: o.y + 1, z, block: post }, { x, y: o.y + 2, z, block: post })
    } else { // bush cell: stays empty (the build job never digs a sweet_berry_bush), roofed
      out.push({ x, y: o.y + 1, z, block: 'air' }, { x, y: o.y + 2, z, block: roof })
    }
  }
  return out
}
