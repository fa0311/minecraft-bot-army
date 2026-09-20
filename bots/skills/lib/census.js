'use strict'
// census: what stands in the world that the ARMY'S BOOKS do not know? One bot's view (loaded chunks, ~96 blocks): functional blocks
// (containers, furnaces, crafting tables, beds) and EXPOSED ores (an ore with air/water beside it = a player would see it and mine it).
// Pure perception - reads the client's chunk data, touches nothing. Called through the eval API by `armyctl.js census`.
const Vec3 = require('vec3')
const FUNC = /^(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|hopper|dropper|dispenser|brewing_stand|enchanting_table|anvil|.*_bed|.*shulker_box|ender_chest|lectern|composter)$/
const ORE = /^(deepslate_)?(diamond|emerald|gold|redstone|lapis|iron|coal|copper)_ore$|^ancient_debris$/
function census (bot, radius = 96) {
  const reg = bot.registry
  const ids = n => Object.values(reg.blocksByName).filter(b => n.test(b.name)).map(b => b.id)
  const out = { bot: bot.username, pos: bot.entity.position.floored().toArray(), func: [], ores: [] }
  for (const p of bot.findBlocks({ matching: ids(FUNC), maxDistance: radius, count: 3000 })) {
    const b = bot.blockAt(p); if (!b) continue
    if (/_bed$/.test(b.name)) { try { if (b.getProperties().part === 'head') continue } catch (e) {} } // one entry per bed
    out.func.push([b.name, p.x, p.y, p.z])
  }
  const open = q => { const n = bot.blockAt(q); return !!n && (n.boundingBox !== 'block' || /leaves|glass/.test(n.name)) }
  for (const p of bot.findBlocks({ matching: ids(ORE), maxDistance: Math.min(radius, 64), count: 4000 })) {
    const b = bot.blockAt(p); if (!b) continue
    if (![[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => open(p.offset(dx, dy, dz)))) continue
    out.ores.push([b.name.replace('deepslate_', ''), p.x, p.y, p.z])
  }
  return out
}
module.exports = { census }
