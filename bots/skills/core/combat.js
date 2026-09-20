// core/combat.js - EVERY BOT DEFENDS ITSELF (owner 09-20: "護衛っているの？本質的じゃなくない？全員が武装すれば良いのでは"). Guard posts treated the symptom: the melee reflex
// in lib/army.js only hits what stands within 3.4 blocks, so a builder shot by a skeleton from 12 blocks kept placing blocks until it died (24 deaths/h, 9 by skeleton in
// 30 min on the ravine floor, keep_inventory off). A good player turns round and kills it. onTick (1 Hz, cheap): an ARMED bot in fair health that sees a ranged mob
// within 16 blocks, or any hostile within 6, or was just hurt with a hostile within 16, raises ONE alert; the worker ends the running slice and calls handle(), which
// owns the legs: A.kill (the one implementation - creeper and enderman rules live there), at most 20 s, then the job goes on. Never: witches (poison splash, keep working
// at a distance), creepers beyond melee (A.kill handles the fuse), fights at hp < 8 (eat first: army.js mealReflex), fights underground on a mine job (the miners have
// their own rules), chases further than 24 blocks from where the bot stood.
const RANGED = /^(skeleton|stray|bogged|pillager|drowned)$/
// NEUTRAL MOBS ARE NEVER ATTACKED FIRST (13:0xZ: a zombified piglin walked out of our new portal into the base - hit one and every piglin in range turns on the army)
const SKIP = /^(witch|enderman|creeper|phantom|ghast|warden|zombified_piglin|piglin|piglin_brute|iron_golem|wolf|bee|polar_bear|llama|trader_llama|panda|dolphin)$/
module.exports = {
  name: 'combat',
  install (bot) { bot.__core_combat = { hp: bot.health, t: 0 } },
  onTick (bot, core) {
    const st = bot.__core_combat = bot.__core_combat || { hp: bot.health, t: 0 }; const hurt = bot.health < st.hp - 0.5; st.hp = bot.health
    if (!bot.entity || bot.health < 8 || Date.now() - st.t < 4000 || bot.isSleeping || core.pending(bot)) return
    const A = core.A; if (/^iron:/.test(String(bot.state && bot.state.task || '').replace(/^army:/, ''))) return
    if (!(A.bestOf(bot, 'sword') || A.bestOf(bot, 'axe'))) return // unarmed: the kit rule arms it at the next depot visit
    // NO DOGPILE, NO LOST CAUSES (owner 09-20 14:5xZ "-376 72 -510でハング": 13 bots stood on one cell, all `core:combat:threat`, chasing ONE skeleton on a roof 3 blocks up that
    // nobody could reach - `defended {killed:false, ms:18021, fights:17}`, over and over): a mob this bot failed to kill is ignored for 5 min; a mob that already has two
    // armed mates within 6 blocks is theirs; a mob more than 2 blocks above or below that is not within melee reach is not chased at all (arrows from a roof are walked away from).
    const ban = st.ban = st.ban || {}; const now = Date.now(); for (const k of Object.keys(ban)) if (ban[k] < now) delete ban[k]
    const matesAt = e => { let n = 0; for (const p of Object.values(bot.players || {})) { const q = p.entity; if (q && q !== bot.entity && q.position.distanceTo(e.position) <= 6) n++ } return n }
    const near = A.hostiles(bot, 16).filter(h => h.e && h.e.isValid && !SKIP.test(h.e.name) && !ban[h.e.id] && (h.d <= 4 || Math.abs(h.e.position.y - bot.entity.position.y) <= 2) && (h.d <= 4 || matesAt(h.e) < 2))
    const pick = near.find(h => h.d <= 6) || near.find(h => RANGED.test(h.e.name)) || (hurt ? near[0] : null)
    if (!pick) return
    st.t = Date.now(); core.raise(bot, { kind: 'threat', by: 'combat', prio: 80, ms: 20000, data: { id: pick.e.id, name: pick.e.name } })
  },
  async handle (bot, alert, core) {
    const A = core.A; const e = bot.entities[alert.data && alert.data.id]; if (!e || !e.isValid) return
    const from = bot.entity.position.clone(); const t0 = Date.now()
    const ok = await A.kill(bot, e, 12000, () => core.cancelled(bot) || bot.health < 6 || bot.entity.position.distanceTo(from) > 24)
    if (!ok) { const st0 = bot.__core_combat = bot.__core_combat || {}; (st0.ban = st0.ban || {})[e.id] = Date.now() + 300000 }
    const st = bot.__core_combat || {}; st.n = (st.n || 0) + 1
    if (!st.saidT || Date.now() - st.saidT > 300000) { st.saidT = Date.now(); core.log(bot, 'defended', { mob: e.name, killed: !!ok, ms: Date.now() - t0, fights: st.n, hp: Math.round(bot.health) }); st.n = 0 }
  }
}
