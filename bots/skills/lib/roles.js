// roles.js — what is left of world 1's role skills: chopWood(), used ONLY by skills/iron_miner.js `bootstrap` (a bare miner after a death makes
// a wooden pick from the nearest tree). Any log of any species counts. Iron engineer: switch to the army's lumber primitive
// (blocks.js harvestTree), then DELETE this file. Do not add anything here.
const U = require('./util')

async function chopWood (bot, args = {}) {
  const names = bot.registry.blocksArray.filter(b => U.LOG_RE.test(b.name) && /_(log|stem)$/.test(b.name)).map(b => b.name)
  let cut = 0
  for (let round = 0; round < 3 && cut < (args.perCall || 12); round++) {
    U.ck(bot)
    const me = bot.entity.position
    const found = U.findBlocksByName(bot, names, args.radius || 32, 12).sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    let progressed = false
    for (const cand of found.slice(0, 4)) { // unreachable trunks get blacklisted by mineAt
      if (U.freeSlots(bot) <= 1) return cut
      let bottom = cand
      for (let i = 0; i < 6; i++) { const b = bot.blockAt(bottom.offset(0, -1, 0)); if (b && names.includes(b.name)) bottom = bottom.offset(0, -1, 0); else break }
      for (let dy = 0; dy < 12; dy++) {
        U.ck(bot)
        const blk = bot.blockAt(bottom.offset(0, dy, 0))
        if (!blk || !names.includes(blk.name) || U.freeSlots(bot) <= 1 || !await U.mineAt(bot, bottom.offset(0, dy, 0), 25000)) break
        cut++; progressed = true
      }
      if (progressed) break
    }
    if (!progressed) break
  }
  await U.pickupNear(bot, 2500, 6)
  return cut
}

module.exports = { chopWood }
