// mapshot.js — top-down data for a rendered MAP IMAGE (the top model's real eyes). columns(bot, r) returns, for every column within r of
// the bot, the top block name + its y, plus whether something FLOATS above it (solid with 2+ air below) — cheap, synchronous, read-only.
const { Vec3 } = require('vec3')
function columns (bot, r = 48) {
  r = Math.max(8, Math.min(64, r | 0)); const me = bot.entity.position.floored(); const out = []
  const roofed = !/overworld/.test(String(bot.game && bot.game.dimension)) // the_nether (bedrock roof at y127) and any scan under a ceiling
  for (let z = me.z - r; z <= me.z + r; z++) for (let x = me.x - r; x <= me.x + r; x++) {
    let top = null
    // THE NETHER HAS A ROOF (owner 09-20 17:3xZ: "eye" = the camera, and it had never looked at the Nether - a mapshot there rendered a flat
    // bedrock ceiling, y127..127, because the scan starts above the bot). Under a roof the scan starts at the bot's HEAD and looks DOWN:
    // that is what a player sees standing there. Overworld unchanged (start 40 above).
    const top0 = roofed ? me.y + 2 : Math.min(me.y + 40, 319)
    for (let y = top0; y >= me.y - 40; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) break; if (b.name !== 'air' && b.name !== 'cave_air') { top = [b.name, y]; break } }
    if (!top) { out.push(null); continue }
    // look below the top block: a gap of 2+ air right under it = floating (tree crown without trunk, stray block, roof)
    let gap = 0; for (let y = top[1] - 1; y >= top[1] - 6; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && (b.name === 'air' || b.name === 'cave_air')) gap++; else break }
    out.push([top[0], top[1], (gap >= 2 && !/_leaves$|snow$/.test(top[0])) ? 1 : 0]) // a leaf canopy always overhangs: only non-leaf tops count as floating
  }
  const ents = []
  for (const e of Object.values(bot.entities)) { if (!e.position || e === bot.entity) continue; const d = e.position.distanceTo(bot.entity.position); if (d > r * 1.4) continue; ents.push([e.type === 'player' ? 'P:' + e.username : (e.name || e.type), Math.round(e.position.x), Math.round(e.position.z)]) }
  return { cx: me.x, cy: me.y, cz: me.z, r, cols: out, ents }
}
module.exports = { columns }
