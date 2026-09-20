// level: LEVEL a rectangle to one height — cut everything above, fill everything below with a cap (整地).
// origin = centre, y = the finished ground level. params: w=15, d=15, fill='dirt' (top layer block), depth=3 (how far down holes are filled),
// (depth 1 is enough: A.placeHard builds the support column under a floating top cell by itself)
// clear=4 (headroom cleared above). Trees inside are NOT felled by this (air cells skip logs/leaves is up to the builder: logs are dug too).
//
// cap:true — CAP MODE (owner 09-20 11:2xZ "明らかに地形が悪い"; the base-audit picture showed the filled ravine as a bare grey slab and the northern cuts as bare
// stone): no cut, no hole filling, only the SKIN. The grade layer becomes `fill` (dirt) in every column where bare stone, gravel or plain air stands (`only`), while
// soil that is already soil counts as built (`mats`) and everything else — paving, a crop, farmland, a chest, another blueprint's block — is not a cell of this job
// at all, because the build handler drops a cell whose standing block is outside `only`. Grass spreads over dirt by itself; this is the job a finished terrain fill
// puts on the board as `cap_<id>`. clear defaults to 0 in cap mode: a cap never touches what stands above the ground.
const CAP_ONLY = ['air', 'cave_air', 'stone', 'cobblestone', 'cobbled_deepslate', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'smooth_basalt', 'basalt', 'blackstone', 'dripstone_block', 'gravel', 'sand', 'red_sand', 'sandstone', 'netherrack']
const CAP_MATS = ['grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'moss_block', 'dirt_path', 'farmland']
module.exports = (o, p = {}) => {
  const w = p.w || 15; const d = p.d || w; const fill = p.fill || 'dirt'
  const hx = Math.floor(w / 2); const hz = Math.floor(d / 2); const out = []
  if (p.cap) {
    const only = p.only || CAP_ONLY; const mats = p.mats || CAP_MATS; const clear = p.clear == null ? 0 : p.clear
    for (let x = -hx; x <= hx; x++) for (let z = -hz; z <= hz; z++) {
      out.push({ x: o.x + x, y: o.y, z: o.z + z, block: fill, mats, only })
      for (let y = 1; y <= clear; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: 'air' })
    }
    return out
  }
  const depth = p.depth == null ? 1 : p.depth; const clear = p.clear == null ? 4 : p.clear
  for (let x = -hx; x <= hx; x++) for (let z = -hz; z <= hz; z++) {
    for (let y = -depth + 1; y <= 0; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: fill, fillOnly: true }) // only where there is a hole
    for (let y = 1; y <= clear; y++) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: 'air' })
  }
  return out
}
