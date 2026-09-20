// nether_portal: THE gate to the Nether (P5). A 4x5 obsidian frame on a stone plinth, standing in a paved, lit apron so a whole
// squad can walk through without queueing on the frame — 50 bots use ONE portal, so it is a piece of base infrastructure, not a
// 10-block hack (doctrine Q2/Q4: fix it once, properly, for everybody).
//
// WHY the apron is stone and not dirt/grass: the portal is lit with flint and steel and zombified piglins come through it. Fire
// spreads on anything flammable next to the ignition cell, and a grass/dirt yard is also what `tidy` and the farmers dig. Stone
// under and around it is fireproof AND registered as ours (lib/army.js `ours()`), so no other job ever takes a cell of it away.
//
// WHY THE SHOULDERS ARE STEPPED (measured 09-20 11:33-11:40Z, the first build of this gate): a block is placed against the TOP
// FACE of the block below it, and that face is only VISIBLE when the builder's eye (feet + 1.62) is above it — so from the apron
// (feet y+1) nothing above y+2 can ever be placed on an isolated 1-wide post. The frame stood 9/14 and `base_portal` auto-paused
// with `no_los`/`unreachable` on -328,71 and the whole top row. Two stepped stone piers flanking the gate (1 high, then 2 high)
// are the fix a player would build anyway: the builder walks UP them and tops the frame out from feet y+3.
//
// Cross-section (axis 'x' — the frame runs along x, you walk through along z; `u` = along the frame, `v` = through it; v = 0 here):
//
//   u    -5   -4   -3   -2   -1    0    1    2    3    4
//   y+5   .    .    .    .    .    .    .    .    .    .      air (nothing hangs over the gate)
//   y+4   .    .    .    S    O    O    S    .    .    .      S = corner, any stone    O = obsidian (10 of them)
//   y+3   .    .    .    O    P    P    O    .    .    .      P = the PORTAL cells: NO blueprint cell at all, so no job ever digs
//   y+2   .    .    #    O    P    P    O    #    .    .          them (a `nether_portal` block breaks at a touch and takes the
//   y+1   .    #    #    O    P    P    O    #    #    .          whole portal with it). The `portal` job clears and lights them.
//   y+0   #    #    #    S    O    O    S    #    #    #      # = stone: the apron AT GRADE (y = the base's ONE ground level)
//   y-1             # # # # # #                               + one layer under the frame ring = the 2-deep plinth.
//
// The frame's bottom row lies flush in the apron, so a bot walks straight in; `clear` free cells lie in front of and behind it.
// origin = the LEFT inner cell of the frame's bottom row (u=0, v=0), y = the base ground level (the TOP ground block, `armyctl.js ground`).
// params: axis 'x'|'z' (default 'x' = the frame runs along x), clear=3 (free cells in front of and behind the frame),
//         margin=3 (apron cells beyond the frame along the frame axis; 3 = room for the stepped shoulders), stone='stone', torch=true.
// Materials for the defaults: ~116 stone, 10 obsidian, 4 torches.  Job: type `build`, **params.pad:false** — the apron IS the pad,
// and the generic PAD RULE would put `air` cells into the portal columns and break the lit portal on every round.
const M = require('./lib/mats')
const SIZE = (p = {}) => ({ clear: Math.max(1, p.clear == null ? 3 : p.clear), margin: Math.max(2, p.margin == null ? 3 : p.margin), axis: p.axis === 'z' ? 'z' : 'x' })
// the 4 columns of the frame, in frame-axis coordinates: -2 and 1 are the (empty in vanilla) corners, -1 and 0 carry obsidian
const FRAME_U = [-2, -1, 0, 1]
const isFrame = (u, v) => v === 0 && u >= -2 && u <= 1

module.exports = (o, p = {}) => {
  const { clear, margin, axis } = SIZE(p)
  const stone = () => p.stone ? M.mat(p.stone, 'stone') : M.stone()
  const out = []
  // (u,v) -> world: for axis 'x' the frame runs along x and you pass through along z; for 'z' the other way round
  const put = (u, v, y, cell) => out.push(Object.assign(axis === 'x' ? { x: o.x + u, y, z: o.z + v } : { x: o.x + v, y, z: o.z + u }, cell))
  const u0 = -2 - margin; const u1 = 1 + margin; const v0 = -clear - 1; const v1 = clear + 1
  // 1. THE APRON at grade + headroom. Frame columns are skipped: their y..y+4 belong to the frame and the portal.
  for (let u = u0; u <= u1; u++) {
    for (let v = v0; v <= v1; v++) {
      const f = isFrame(u, v)
      if (!f) put(u, v, o.y, stone())
      for (let y = o.y + 1; y <= o.y + 5; y++) if (!f || y === o.y + 5) put(u, v, y, { block: 'air' })
    }
  }
  // 2. THE PLINTH: one layer below grade under the frame + a ring of 1 — nothing can undermine the obsidian, no dirt under the gate
  for (let u = -3; u <= 2; u++) for (let v = -1; v <= 1; v++) put(u, v, o.y - 1, stone())
  // 3. THE STEPPED SHOULDERS (see the header): the stair a builder climbs to top the frame out, and the gate's face towards the yard
  for (const [u, h] of [[-4, 1], [-3, 2], [2, 2], [3, 1]]) for (let k = 1; k <= h; k++) put(u, 0, o.y + k, stone())
  // 4. THE FRAME. 10 obsidian; the 4 corners are any stone (vanilla leaves them empty — here they tie the frame into the shoulders).
  //    The 6 cells between the posts get NO cell at all: that is the portal itself.
  for (const u of FRAME_U) {
    const corner = u === -2 || u === 1
    put(u, 0, o.y, corner ? stone() : { block: 'obsidian' })
    put(u, 0, o.y + 4, corner ? stone() : { block: 'obsidian' })
  }
  for (let y = o.y + 1; y <= o.y + 3; y++) { put(-2, 0, y, { block: 'obsidian' }); put(1, 0, y, { block: 'obsidian' }) }
  // 5. TORCHES on the four apron corners (last cell wins over the air cell above them): nothing spawns on the apron at night
  if (p.torch !== false) for (const u of [u0, u1]) for (const v of [v0, v1]) put(u, v, o.y + 1, { block: 'torch', needs: 'below' })
  return out
}

// geom(): the ONE description of where the gate's working parts are — read by lib/jobs_nether.js (job type `portal`) so the
// lighting, the walk-in and the far-side registration can never drift from what the `build` job puts in the world.
module.exports.geom = (o, p = {}) => {
  const { clear, margin, axis } = SIZE(p)
  const w = (u, v, y) => axis === 'x' ? [o.x + u, y, o.z + v] : [o.x + v, y, o.z + u]
  const inner = []
  for (const u of [-1, 0]) for (let y = o.y + 1; y <= o.y + 3; y++) inner.push(w(u, 0, y))
  const frame = []
  for (const u of FRAME_U) { frame.push({ at: w(u, 0, o.y), corner: u === -2 || u === 1 }); frame.push({ at: w(u, 0, o.y + 4), corner: u === -2 || u === 1 }) }
  for (let y = o.y + 1; y <= o.y + 3; y++) { frame.push({ at: w(-2, 0, y), corner: false }); frame.push({ at: w(1, 0, y), corner: false }) }
  return {
    axis,
    y: o.y,
    inner, // the 6 cells a lit portal fills
    floor: [w(-1, 0, o.y), w(0, 0, o.y)], // the bottom obsidian: struck on its TOP face with flint and steel
    top: [w(-1, 0, o.y + 4), w(0, 0, o.y + 4)],
    frame, // all 14 frame cells (corner:true = any stone, false = obsidian)
    stands: [w(-1, 1, o.y + 1), w(0, 1, o.y + 1), w(-1, -1, o.y + 1), w(0, -1, o.y + 1)], // free cells in front of / behind the gate
    apron: axis === 'x' ? [o.x - 2 - margin, o.z - clear - 1, o.x + 1 + margin, o.z + clear + 1] : [o.x - clear - 1, o.z - 2 - margin, o.x + clear + 1, o.z + 1 + margin]
  }
}
