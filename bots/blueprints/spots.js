// spots -- the generic "place exactly these blocks" blueprint.
//
// Blueprint generators cannot look at the world, so anything that has to follow the
// terrain (torch grids, fence lines along a cliff lip, markers) is sampled once with a
// bot and passed in as data. This is the primitive for all of those.
//
// origin is ignored unless `relative` is set.
// params:
//   blocks    [[x,y,z,'block'], ...]  -- absolute coords (or relative to origin)
//   relative  treat the coords as offsets from origin       (default false)
//   clear     air blocks to guarantee above each entry      (default 0)
//   support   block name to place UNDER each entry if given (e.g. 'cobblestone'
//             under a torch that would otherwise have nothing to stand on)
module.exports = (o, p = {}) => {
  const list = p.blocks || []
  const rel = !!p.relative
  const clear = p.clear == null ? 0 : p.clear
  const out = []
  for (const e of list) {
    if (!e || e.length < 4) continue
    const x = (rel ? o.x : 0) + e[0]
    const y = (rel ? o.y : 0) + e[1]
    const z = (rel ? o.z : 0) + e[2]
    if (p.support) out.push({ x, y: y - 1, z, block: p.support })
    out.push({ x, y, z, block: e[3] })
    for (let h = 1; h <= clear; h++) out.push({ x, y: y + h, z, block: 'air' })
  }
  return out
}
