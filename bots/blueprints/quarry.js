// quarry: a TERRACED OPEN PIT - where the army's first cobblestone comes from (world 2, 09-19: 23 builders `build_blocked: no cobblestone`,
// stock 1 / target 1728, the mine closed behind a mine head that needs stone itself; the pads' cuts are grass and dirt - 10 stone in 3000 cells).
// Every ring steps down ONE block, 1 wide: the pit is a staircase on all four sides, nobody is ever trapped in it and no bot digs a private
// shaft (movement stays read-only). The `build` job digs it LAYER BY LAYER (cells carry `layer`: a cell opens only when its four neighbours one
// layer up are gone), with a pickaxe (stone is never punched: no drops), any number of bots.
// LEGAL ONLY INSIDE `settings.keepOut` boxes (the ravine = the quarry zone): the build job refuses any other footprint (rule 4: no holes in natural ground).
// origin = centre, y = the GROUND BLOCK level there (`armyctl.js ground`). params: w=21, d=w, depth=8 (rings deeper than the pit's half width do not exist),
// clear=4 (headroom over the pit: bushes, logs). Yield: ~ (w-6)^2 + (w-8)^2 + ... stone below 3 layers of dirt; w=21 depth=8 -> ~640 cobblestone.
module.exports = (o, p = {}) => {
  const w = p.w || 21; const d = p.d || w; const depth = Math.max(1, p.depth || 8); const clear = p.clear == null ? 4 : p.clear
  const hx = Math.floor(w / 2); const hz = Math.floor(d / 2); const out = []
  for (let x = -hx; x <= hx; x++) for (let z = -hz; z <= hz; z++) {
    for (let y = clear; y >= 1; y--) out.push({ x: o.x + x, y: o.y + y, z: o.z + z, block: 'air', layer: true })
    const ring = Math.min(hx - Math.abs(x), hz - Math.abs(z)) // 0 = the rim: one block under the ground around it
    for (let i = 0; i <= Math.min(ring, depth - 1); i++) out.push({ x: o.x + x, y: o.y - i, z: o.z + z, block: 'air', layer: true })
  }
  return out
}
