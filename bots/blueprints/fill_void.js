// fill_void: FILL A HOLE / TRENCH / CRATER **SOLID** up to one grade (never a deck over air).
// origin = centre of the box, y = the finished ground level (grade). Pure cell list; the `build` job gives `solid` cells their own rules:
//   - a cell is placed only when the block BELOW it is solid (strict bottom-up)  -> whatever is placed has no air under it
//   - the LOWEST open cell of the whole box goes first                           -> the floor rises evenly, builders inside ride up with it
//   - only air that is connected to the open sky inside the box counts           -> sealed pockets in the rock are not "work left"
//   - any solid block counts as filled; builders place what they carry from `mats`
//   - a cell nobody can reach gets a GRAVITY block (gravel/sand) dropped down its shaft from wherever a builder can stand
// params: w=5, d=w  (or box:[x1,z1,x2,z2] absolute, overrides origin x/z + w/d), depth=12 (layers below grade that are filled),
//   fill='cobblestone' (body), top=fill (block of the grade layer), mats=[…] accepted substitutes for the body,
//   ramp:[[x,z,h],…]  columns raised FIRST up to height h: a 1-step walk-in/walk-out stair for the builders (it is part of the fill),
//   keep:[[x1,y1,z1,x2,y2,z2],…]  boxes that are never filled (a mine stair, a tunnel that must stay open),
//   keepLid:[[x1,z1,x2,z2],…]  columns whose roof is never taken off by the job's `unlid:true` (a building stands on it): their void is filled from the side only.
module.exports = (o, p = {}) => {
  const w = p.w || 5; const d = p.d || w; const depth = p.depth == null ? 12 : p.depth
  const fill = p.fill || 'cobblestone'; const top = p.top || fill
  const mats = p.mats || ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'dirt']
  const hx = Math.floor(w / 2); const hz = Math.floor(d / 2)
  const [x1, z1, x2, z2] = p.box ? [Math.min(p.box[0], p.box[2]), Math.min(p.box[1], p.box[3]), Math.max(p.box[0], p.box[2]), Math.max(p.box[1], p.box[3])] : [o.x - hx, o.z - hz, o.x + hx, o.z + hz]
  const kept = (x, y, z) => (p.keep || []).some(k => x >= Math.min(k[0], k[3]) && x <= Math.max(k[0], k[3]) && y >= Math.min(k[1], k[4]) && y <= Math.max(k[1], k[4]) && z >= Math.min(k[2], k[5]) && z <= Math.max(k[2], k[5]))
  const lidKept = (x, z) => (p.keepLid || []).some(k => x >= Math.min(k[0], k[2]) && x <= Math.max(k[0], k[2]) && z >= Math.min(k[1], k[3]) && z <= Math.max(k[1], k[3]))
  const rampH = {}; for (const r of p.ramp || []) rampH[r[0] + ',' + r[1]] = r[2]
  const out = []
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
    const rh = rampH[x + ',' + z]
    for (let y = o.y - depth + 1; y <= o.y; y++) {
      if (kept(x, y, z)) continue
      const c = { x, y, z, block: y === o.y ? top : fill, fillOnly: true, solid: true, g: o.y, mats: (y === o.y && p.top) ? [top] : mats }
      if (y === o.y - depth + 1 || kept(x, y - 1, z)) c.floor = true // lowest layer of the job: may hang on a side neighbour (nothing below it is ours)
      if (rh != null && y <= rh) c.ramp = true
      if (lidKept(x, z)) c.keepLid = true
      out.push(c)
    }
  }
  return out
}
