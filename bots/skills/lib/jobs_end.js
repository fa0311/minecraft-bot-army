// jobs_end.js — P6/P7: ENDER PEARLS -> EYES -> STRONGHOLD -> THE DRAGON.
// EXTENSION MODULE (contract at the end of army_jobs.js): one job type, `end`, switched by `params.work`. Nothing here drives a
// single bot by hand — it is an ordinary board job made of ordinary primitives (A.travel, A.obtain, A.bank, blocks.js), and every
// report states what was READ BACK FROM THE WORLD, never what was intended (lesson 3 of world 1).
//
// THE JOB (type `end`, params):
//   work:'enderhunt'  NIGHT hunt in the open (needs `params.needsNight:true`, else nightSkip snaps the night away before the squad
//                     arrives). `post:[x,y,z]` = the dark hunting ground AWAY from the lit base, `radius:80`, `minutes:12`.
//                     A pair-and-disengage fight: iron armour + shield + sword, one target at a time, break off at `minHp` (8).
//                     A bot never STARTS a fight with an enderman anywhere else in this army (army.js `kill` refuses, `safePitch`
//                     makes it impossible to even look at one) — here, and only here and only at ONE chosen target, the gaze guard
//                     is lifted (`gazeAllow`). `dy` (8) is the fight gate: an enderman in a cave/ravine below is counted and
//                     reported, never chased. Events: ender_seen · ender_fight · ender_kill · ender_hunt · ender_dry · ender_far.
//   work:'eyes'       craft every eye_of_ender the depot allows (1 ender_pearl + 1 blaze_powder; 1 blaze_rod -> 2 powder) and bank
//                     it. `target:16` (12 frames + breakage). Pauses itself at the target; says what is missing when it cannot.
//                     Events: eyes_crafted · eyes_blocked.
//   work:'stronghold' THROW AND TRIANGULATE: hold an eye, `bot.activateItem()`, read the THROWN ENTITY's flight over ~20 ticks
//                     (never the bot's yaw), record the bearing on the board, walk `leg` blocks across it, throw again, intersect.
//                     Then walk the fix down in legs and throw again to refine; within `near` the eye DIPS and the squad digs a
//                     lit staircase (never straight down under the feet) until a stone-brick wall or an end_portal_frame is read.
//                     Events: eye_thrown · eye_lost · sh_fix · sh_leg · sh_arrived · sh_stairs · sh_found · sh_blocked.
//   work:'portal'     fill the 12 end_portal_frame cells with eyes (activateBlock, read the `eye` property back) -> the portal
//                     lights itself. Events: frame_filled · end_portal_lit · portal_frames.
//   work:'dragon'     THE STRIKE SQUAD, in its best gear (never `bare`): through the portal, bridge off the arrival platform,
//                     shoot every end crystal out of the sky FIRST (a live crystal heals the dragon 1 hp / 0.5 s), then hit the
//                     head while it perches on the fountain. Events: end_arrived · crystal_down · crystal_caged · dragon_hit ·
//                     dragon_perch · dragon_dead · end_retreat.
// BOARD: settings.end = {throws:[{at,dir,by,t}], fix:{x,z,t,legs}, room:{frames:[[x,y,z]…], portal:[x,y,z], at}, lit, pearls}
// WHAT THIS FILE MUST NOT DO: no cheats (no /give, /tp, no creative, no /locate for the army), no new state file, no new daemon.
const { Vec3 } = require('vec3')

module.exports = ctx => {
  const { A, U, muster, task, swallow } = ctx
  const sleep = A.sleep
  const v = p => Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z)
  const xyz = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  // blocks.js is required per call: army_worker drops the WHOLE lib cache on any edit, so this always resolves to the live copy
  const BL = () => require('./blocks')
  const dimOf = bot => String((bot.game && bot.game.dimension) || 'unknown')
  const isEnd = bot => dimOf(bot) === 'the_end'
  const isOver = bot => dimOf(bot) === 'overworld'
  const now = () => Date.now()
  const round1 = n => Math.round(n * 10) / 10

  // ---------------------------------------------------------------- board state (settings.end — no new state file)
  function endS () { const s = A.settings().end; return (s && typeof s === 'object') ? s : {} }
  function endEdit (fn) {
    A.boardEdit(b => { b.settings = b.settings || {}; b.settings.end = b.settings.end || {}; fn(b.settings.end) })
  }
  function pauseSelf (job, note) {
    A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && j.status === 'active' && (j.rev || 0) === (job.rev || 0)) { j.status = 'paused'; j.note = note } })
  }
  // a stable index per bot so a squad SPREADS over the hunting ground instead of walking in one file
  function seat (bot) {
    const r = A.settings().roster
    const i = Array.isArray(r) ? r.indexOf(bot.username) : -1
    if (i >= 0) return i
    let h = 0; for (const c of bot.username) h = (h * 31 + c.charCodeAt(0)) & 0xffff
    return h
  }

  // ---------------------------------------------------------------- THE GAZE GUARD, LIFTED FOR ONE TARGET
  // army.js installs `safePitch` on every look of every bot: the view may never rest on a CALM enderman's eyes, because that is a
  // STARE and starts a fight (endermen were the #1 killer of world 1). A HUNTER has to aim at exactly one of them. The guard reads
  // its calm list from the 400 ms cache `bot.__armyEnders = {t,list}` — a cache stamped in the FUTURE with our target removed lets
  // this bot aim at its target and keeps its eyes off every other enderman in the field. Refreshed each loop, dropped in `finally`.
  function gazeAllow (bot, id) {
    const list = []; const me = bot.entity && bot.entity.position
    if (!me) return
    for (const k in bot.entities) { const e = bot.entities[k]; if (e && e.name === 'enderman' && e.id !== id && e.position && e.position.distanceTo(me) < 66) list.push(e) }
    bot.__armyEnders = { t: now() + 60000, list }
  }
  const gazeRestore = bot => { bot.__armyEnders = null }

  // ---------------------------------------------------------------- kit
  const armourOn = bot => [5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean)
  async function equipShield (bot) {
    try { const sh = bot.inventory.items().find(i => i.name === 'shield'); if (sh && !(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')) await U.withTimeout(bot.equip(sh, 'off-hand'), 3000, 'shield') } catch (e_) { swallow('jobs_end:shield', e_) }
  }
  // fetch what this work needs from the depot; returns the list of what is still missing
  async function need (bot, api, wants) {
    const short = []
    for (const [item, n] of Object.entries(wants)) {
      if (api.stop()) break
      if (A.count(bot, item) >= n) continue
      await A.withdraw(bot, item, n - A.count(bot, item), { stop: api.stop }).catch(e_ => swallow('jobs_end:need', e_))
      if (A.count(bot, item) < n) short.push(item + ' ' + A.count(bot, item) + '/' + n + ' (depot ' + A.stockOf(item) + ')')
    }
    return short
  }

  // ================================================================ 1. ENDERHUNT
  // WHAT IS IN VIEW vs WHAT IS FIGHTABLE. A live probe of a hunter at 06:41Z found two endermen loaded and BOTH underground
  // (-375,-43,-380 and -339,52,-438, the ravine) while the bot stood at y69: endermen are plentiful in the dark under the base and
  // scarce on the night surface. A surface squad must not chase one down a ravine (travel refuses below grade in a keep-out and the
  // fall is what kills), so `dy` (8) stays the fight gate — but the ones it rejects are COUNTED and reported (`ender_far`), so the
  // measurement says "none on this ground" instead of "none anywhere".
  const enderAll = (bot, r) => {
    const me = bot.entity.position; const out = []
    for (const k in bot.entities) {
      const e = bot.entities[k]
      if (!e || e.name !== 'enderman' || !e.position || !e.isValid) continue
      const d = e.position.distanceTo(me)
      if (d <= r) out.push({ e, d, dy: e.position.y - me.y })
    }
    return out.sort((a, b) => a.d - b.d)
  }
  const enderNear = (bot, r, dy) => enderAll(bot, r).filter(q => Math.abs(q.dy) <= (dy || 8))
  // WHERE A PLAYER FIGHTS ONE: never in water, never in the rain (water hurts an enderman — it teleports out of every fight and the
  // pearl is lost), and with a roof over the head if there is one within reach, because an enderman is 2.9 tall and cannot follow.
  const badGround = bot => {
    try {
      if (bot.isRaining || bot.thunderState > 0) return 'rain (an enderman teleports out of every fight in the rain)'
      const f = bot.blockAt(bot.entity.position.floored())
      if (f && /water|lava/.test(f.name)) return 'standing in ' + f.name
      return null
    } catch (e_) { swallow('jobs_end:badGround', e_); return null }
  }
  async function fightEnder (bot, ent, o) {
    const id = ent.id; const t0 = now()
    const floor = o.minHp
    // HOW FAR IS "GONE"? First live engagement 06:49:2xZ: Aika and Chino opened on endermen 28-30 blocks off and EVERY fight ended
    // `it teleported out of reach` within 250 ms — the abort was measured against a flat 28 blocks while the bot had not taken a
    // step yet. An enderman that teleports goes a few dozen blocks; one we are still walking to is not gone. So the gate is
    // "clearly FARTHER than where it started" (+16, never under 36) and it only counts after 4 s of closing.
    const d0 = ent.position ? ent.position.distanceTo(bot.entity.position) : 8
    const gone = Math.max(36, d0 + 16)
    await A.equipBest(bot, 'sword') || await A.equipBest(bot, 'axe')
    await equipShield(bot)
    try { if (bot.pathfinder.movements) bot.pvp.movements = bot.pathfinder.movements } catch (e_) { swallow('jobs_end:pvpMv', e_) } // fights stay read-only too
    gazeAllow(bot, id)
    try { bot.pvp.attack(bot.entities[id] || ent) } catch (e_) { swallow('jobs_end:pvpAttack', e_); return { ok: false, why: 'pvp refused the target' } }
    try {
      while (now() - t0 < (o.ms || 60000) && !U.cancelled(bot) && !(o.stop && o.stop())) {
        await sleep(250)
        gazeAllow(bot, id)
        const cur = bot.entities[id]
        if (!cur || !cur.isValid) return { ok: true, s: round1((now() - t0) / 1000) }
        if (bot.health <= floor) return { ok: false, why: 'disengaged at hp ' + Math.round(bot.health) }
        const d = cur.position.distanceTo(bot.entity.position)
        if (now() - t0 > 4000 && d > gone) return { ok: false, why: 'it teleported out of reach (' + Math.round(d) + ' blocks, opened at ' + Math.round(d0) + ')' }
      }
      return { ok: false, why: 'no kill in ' + Math.round((now() - t0) / 1000) + ' s' }
    } finally {
      try { bot.pvp.stop() } catch (e_) { swallow('jobs_end:pvpStop', e_) }
      try { bot.pathfinder.setGoal(null) } catch (e_) { swallow('jobs_end:goal', e_) }
      gazeRestore(bot)
    }
  }
  async function enderhunt (bot, job, api, ctx2, P) {
    if (!isOver(bot)) return muster(bot, job, api, ctx2, 'enderhunt: this is overworld work (' + dimOf(bot) + ')')
    const m = A.musterPos()
    const post = Array.isArray(P.post) ? v(P.post) : m ? new Vec3(m.x, m.y, m.z) : bot.entity.position.floored()
    const R = P.radius || 80
    const minHp = P.minHp || 8
    const endT = now() + (P.minutes || 12) * 60000
    // GEAR. `params.bare:true` (an unproven job) strips the armour: then the bot may only engage from full health and breaks off
    // much earlier — 40 hp and 7 damage a hit is not a fight a naked bot finishes twice.
    const short = await need(bot, api, { bread: 8 })
    await equipShield(bot)
    const naked = armourOn(bot).length === 0
    const engageHp = naked ? 18 : 12
    const breakHp = naked ? Math.max(minHp, 12) : minHp
    if (!A.bestOf(bot, 'sword') && !A.bestOf(bot, 'axe')) {
      await A.obtain(bot, 'stone_sword', 1, { stop: api.stop }).catch(e_ => swallow('jobs_end:sword', e_))
      if (!A.bestOf(bot, 'sword') && !A.bestOf(bot, 'axe')) { A.decline(bot, job, 8 * 60000, 'enderhunt: no weapon'); return muster(bot, job, api, ctx2, 'enderhunt: no sword and no axe (depot ' + A.stockOf('iron_sword') + ' iron / ' + A.stockOf('stone_sword') + ' stone swords)') }
    }
    // SPREAD IN PAIRS (PLAYBOOK: 40 hp and 7 damage a hit — one bot trades badly, two end it in under three seconds). The ground is
    // cut into ceil(bots/2) patches, so a squad covers many patches of darkness AND two hunters share each one.
    const patches = Math.max(1, Math.ceil((P.patches || job.bots || (job.names || []).length || 8) / 2))
    const s = seat(bot) % patches; const ang = (s * 2.39996) % (Math.PI * 2); const rad = R * 0.45 + (s % 5) * (R * 0.1)
    const mine = new Vec3(Math.round(post.x + Math.cos(ang) * rad), post.y, Math.round(post.z + Math.sin(ang) * rad))
    if (A.dist2(bot, mine.x, mine.z) > 24) {
      task(bot, 'enderhunt: to the dark ground ' + mine.x + ',' + mine.z)
      if (!await A.travel(bot, { x: mine.x, y: null, z: mine.z }, { range: 6, ms: 240000, stop: api.stop })) {
        A.result(bot, { ev: 'ender_hunt', job: job.id, ok: false, why: 'no route to the hunting ground ' + [mine.x, mine.z].join(','), from: xyz(bot.entity.position) })
        return 'enderhunt: no route to ' + mine.x + ',' + mine.z
      }
    }
    let killed = 0; let fought = 0; let seen = 0; let broke = 0; let outOfReach = 0; let lowest = null
    const pearls0 = A.count(bot, 'ender_pearl')
    const t0 = now()
    while (now() < endT && !api.stop()) {
      if (bot.health < engageHp) { task(bot, 'enderhunt: hurt, holding back'); await sleep(3000); continue }
      const bad = badGround(bot)
      const all = enderAll(bot, R)
      const list = all.filter(q => Math.abs(q.dy) <= (P.dy || 8))
      for (const q of all) if (Math.abs(q.dy) > (P.dy || 8)) { outOfReach++; if (lowest == null || q.dy < lowest) lowest = Math.round(q.dy) }
      if (!list.length) {
        task(bot, 'enderhunt: looking for endermen')
        // walk a short ring inside my patch — moving finds spawns, standing does not; never a long march (spawns follow the bot)
        const a2 = Math.random() * Math.PI * 2; const r2 = 8 + Math.random() * 14
        await A.travel(bot, { x: Math.round(mine.x + Math.cos(a2) * r2), y: null, z: Math.round(mine.z + Math.sin(a2) * r2) }, { range: 3, ms: 20000, quiet: true, stop: () => api.stop() || !!enderNear(bot, R, P.dy)[0] })
        await sleep(600)
        continue
      }
      seen++
      if (bad) { task(bot, 'enderhunt: ' + bad); await sleep(4000); continue }
      // ONE TARGET AT A TIME, AND NEVER THE SAME ONE IN A LOOP. 06:50:0xZ: Kanade opened on the same enderman 42 blocks off eight
      // times in two seconds and filed 16 events doing it. A target that beat us twice is left alone for a minute; the squad has
      // other patches and the night is short.
      const give = bot.__endGaveUp = bot.__endGaveUp || {}
      for (const k of Object.keys(give)) if (give[k] < now()) delete give[k]
      const t = list.find(q => !give[q.e.id])
      if (!t) { task(bot, 'enderhunt: the ones in view all got away — looking further'); await sleep(4000); continue }
      A.result(bot, { ev: 'ender_seen', job: job.id, at: xyz(t.e.position), d: round1(t.d), hp: Math.round(bot.health), armour: armourOn(bot).length })
      task(bot, 'enderhunt: fighting an enderman at ' + xyz(t.e.position).join(','))
      fought++
      const had = A.count(bot, 'ender_pearl')
      const r = await fightEnder(bot, t.e, { minHp: breakHp, stop: api.stop, ms: P.fightS ? P.fightS * 1000 : 60000 })
      if (r.ok) { killed++; await sleep(400); await A.pickup(bot, 10, 6000) } else {
        if (/disengag/.test(r.why || '')) broke++
        const fails = bot.__endFails = bot.__endFails || {}
        fails[t.e.id] = (fails[t.e.id] || 0) + 1
        if (fails[t.e.id] >= 2) give[t.e.id] = now() + 60000
        await sleep(1500)
      }
      const got = A.count(bot, 'ender_pearl') - had
      A.result(bot, { ev: r.ok ? 'ender_kill' : 'ender_fight', job: job.id, ok: !!r.ok, why: r.why || null, s: r.s || null, pearl: got, openedAt: Math.round(t.d), hp: Math.round(bot.health), at: xyz(bot.entity.position) })
      if (bot.health < breakHp + 4) { task(bot, 'enderhunt: hurt, eating'); await sleep(5000) }
    }
    const pearls = A.count(bot, 'ender_pearl') - pearls0
    const botH = (now() - t0) / 3600000
    if (pearls > 0 || killed > 0) {
      // the pearls are the POINT: they go on the shelf the same trip, so `armyctl.js stock ender_pearl` is the measurement
      await A.bank(bot, { bread: 8, torch: 16 }, { job: job.id, stop: api.stop }).catch(e_ => swallow('jobs_end:bank', e_))
    }
    A.result(bot, {
      ev: 'ender_hunt', job: job.id, ok: true, seen, fought, killed, broke, pearls, outOfReach, lowestDy: lowest, min: Math.round(botH * 60),
      perBotH: botH > 0.02 ? round1(pearls / botH) : null, armour: armourOn(bot).length, at: xyz(bot.entity.position),
      why: 'pearls per bot-hour is the number this job is judged on'
    })
    if (!seen) A.result(bot, { ev: outOfReach ? 'ender_far' : 'ender_dry', job: job.id, at: xyz(bot.entity.position), min: Math.round(botH * 60), outOfReach, lowestDy: lowest, why: outOfReach ? outOfReach + ' enderman sighting(s) in view but ' + lowest + ' blocks below this ground (a cave/ravine, not the night surface): a surface squad does not chase one down' : 'no enderman came into view at all — the ground is too bright, too small, or the night was skipped' })
    return 'enderhunt: ' + killed + ' killed, ' + pearls + ' pearls in ' + Math.round(botH * 60) + ' min'
  }

  // ================================================================ 2. THE EYES
  async function eyes (bot, job, api, ctx2, P) {
    if (!isOver(bot)) return muster(bot, job, api, ctx2, 'eyes: overworld work (' + dimOf(bot) + ')')
    const target = P.target || 16
    const stockAll = k => A.stockOf(k) + A.count(bot, k)
    const have = stockAll('ender_eye')
    if (have >= target) {
      pauseSelf(job, 'auto-paused: ' + have + '/' + target + ' eyes of ender stand in the depot')
      A.result(bot, { ev: 'eyes_crafted', job: job.id, made: 0, have, target, done: true })
      return muster(bot, job, api, ctx2, 'eyes: ' + have + '/' + target + ' — done')
    }
    const pearls = stockAll('ender_pearl'); const powder = stockAll('blaze_powder'); const rods = stockAll('blaze_rod')
    const can = Math.min(pearls, powder + rods * 2, target - have)
    if (can < 1) {
      const miss = []
      if (pearls < 1) miss.push('ender_pearl 0 (enderhunt at night, or piglin bartering with gold)')
      if (powder + rods * 2 < 1) miss.push('blaze_powder 0 and blaze_rod 0 (the Nether front owns this — a rod makes 2 powder)')
      A.result(bot, { ev: 'eyes_blocked', job: job.id, have, target, pearls, rods, powder, missing: miss })
      // THE JOB rests, not the bot: an ingredient nobody holds is a fact about the depot, so handing the job to the next bot every
      // five seconds only churns the dispatcher (3 bots in 15 s on the first live round). `restUntil` parks the JOB for everybody.
      A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j) j.restUntil = now() + (P.restMin || 8) * 60000 })
      A.decline(bot, job, 6 * 60000, 'eyes: ' + miss.join(' + '))
      return muster(bot, job, api, ctx2, 'eyes: nothing to craft with — ' + miss.join(' + '))
    }
    task(bot, 'eyes: crafting ' + can + ' eye_of_ender')
    const had = A.count(bot, 'ender_eye')
    await A.obtain(bot, 'ender_eye', had + can, { stop: api.stop }).catch(e_ => swallow('jobs_end:obtainEye', e_))
    const made = A.count(bot, 'ender_eye') - had
    if (made > 0) await A.bank(bot, { bread: 8, torch: 16 }, { job: job.id, stop: api.stop }).catch(e_ => swallow('jobs_end:bankEye', e_))
    const nowHave = A.stockOf('ender_eye') + A.count(bot, 'ender_eye')
    A.result(bot, { ev: 'eyes_crafted', job: job.id, made, have: nowHave, target, pearlsLeft: A.stockOf('ender_pearl'), rodsLeft: A.stockOf('blaze_rod') })
    if (!made) A.decline(bot, job, 5 * 60000, 'eyes: the ingredients are on the books but the craft produced none')
    return 'eyes: ' + made + ' crafted, ' + nowHave + '/' + target + ' in stock'
  }

  // ================================================================ 3. THE STRONGHOLD
  // A THROWN EYE IS THE ONLY LEGITIMATE COMPASS (no /locate for the army). It flies towards the nearest stronghold, so its
  // DISPLACEMENT over the first ~20 ticks is the bearing. Read from the ENTITY, never from the bot's yaw.
  const EYE_RE = /eye_of_ender|ender_eye|eye_of_ender_signal/
  async function throwEye (bot, api) {
    const it = bot.inventory.items().find(i => i.name === 'ender_eye')
    if (!it) return { ok: false, why: 'no eye_of_ender in hand or pockets' }
    try { await U.withTimeout(bot.equip(it, 'hand'), 3000, 'eyeHand') } catch (e_) { swallow('jobs_end:eyeHand', e_); return { ok: false, why: 'could not hold the eye' } }
    const before = new Set(Object.keys(bot.entities))
    try { await bot.look(bot.entity.yaw, -0.35, true) } catch (e_) { swallow('jobs_end:eyeLook', e_) } // a little upward: the eye flies over the ground, not into it
    try { bot.activateItem() } catch (e_) { swallow('jobs_end:activate', e_); return { ok: false, why: 'activateItem threw' } }
    await sleep(150)
    try { bot.deactivateItem() } catch (e_) { swallow('jobs_end:deactivate', e_) }
    // find the new entity: the eye is the only thing that appears beside us in the next second. Matched by NAME and by the numeric
    // type id out of this bot's own registry — `entity.objectType` is never read (it logs a stack trace per read, DEV.md §6).
    const typeId = ((bot.registry.entitiesByName || {}).eye_of_ender || {}).id
    let eye = null
    for (let i = 0; i < 12 && !eye; i++) {
      await sleep(100)
      for (const k in bot.entities) {
        const e = bot.entities[k]
        if (!e || before.has(k) || !e.position) continue
        const nm = String(e.name || e.displayName || '').toLowerCase()
        if (!EYE_RE.test(nm) && !(typeId != null && e.entityType === typeId)) continue
        if (e.position.distanceTo(bot.entity.position) > 12) continue
        eye = e; break
      }
    }
    if (!eye) return { ok: false, why: 'the thrown eye never appeared as an entity (it may have flown out of view)' }
    const p0 = eye.position.clone(); const t0 = now()
    let p1 = p0
    for (let i = 0; i < 20; i++) { await sleep(50); const cur = bot.entities[eye.id]; if (!cur || !cur.position) break; p1 = cur.position.clone() }
    const dx = p1.x - p0.x; const dz = p1.z - p0.z; const dy = p1.y - p0.y
    const len = Math.hypot(dx, dz)
    if (!(len > 0.05)) return { ok: false, why: 'the eye did not move in ' + (now() - t0) + ' ms (len ' + round1(len) + ')' }
    // AN EYE SURVIVES FOUR THROWS IN FIVE: it falls back as an item ~12 blocks along the bearing. A player walks over and picks it
    // up, and so does this — eyes cost a blaze rod each and the whole search is rationed by them.
    const had = A.count(bot, 'ender_eye')
    await sleep(2500)
    await A.pickup(bot, 14, 6000)
    return { ok: true, dir: [dx / len, dz / len], dy: round1(dy), from: xyz(bot.entity.position), speed: round1(len), kept: A.count(bot, 'ender_eye') > had }
  }
  // t along d1 where the two bearings cross (PLAYBOOK "Stronghold"); null when the legs are too parallel to trust
  function triangulate (a, b) {
    const [dx1, dz1] = a.dir; const [dx2, dz2] = b.dir
    const den = dx1 * dz2 - dz1 * dx2
    if (Math.abs(den) < 0.12) return null // legs within ~7 degrees: the crossing is noise
    const t = ((b.at[0] - a.at[0]) * dz2 - (b.at[2] - a.at[2]) * dx2) / den
    if (!(t > 40)) return null
    return { x: Math.round(a.at[0] + t * dx1), z: Math.round(a.at[2] + t * dz1), t: Math.round(t), den: round1(den) }
  }
  // A LIT STAIRCASE, NEVER A HOLE UNDER THE FEET (movement doctrine rule 4 does not cover this: the descent IS the work here, so the
  // job carries a `plan`). 1 down / 1 forward, both the head and the body cell opened, the 6 neighbours of every cell read before the
  // pick touches it, a torch every 5 steps, and the way back up is the stair itself.
  const SH_RE = /^(stone_bricks|mossy_stone_bricks|cracked_stone_bricks|infested_stone_bricks|infested_mossy_stone_bricks|infested_cracked_stone_bricks|stone_brick_stairs|stone_brick_slab|iron_bars|end_portal_frame|end_portal|chiseled_stone_bricks|infested_chiseled_stone_bricks)$/
  function sniffStronghold (bot, r) {
    const ids = Object.values(bot.registry.blocksByName).filter(b => SH_RE.test(b.name)).map(b => b.id)
    if (!ids.length) return []
    try { return bot.findBlocks({ matching: ids, maxDistance: Math.min(r || 24, 40), count: 8 }) } catch (e_) { swallow('jobs_end:sniff', e_); return [] }
  }
  async function stairDown (bot, api, P, job) {
    const B = BL()
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
    const d = dirs[seat(bot) % 4]
    const floorY = P.toY == null ? 10 : P.toY
    let steps = 0; let torches = 0
    const endT = now() + (P.minutes || 10) * 60000
    while (now() < endT && !api.stop()) {
      const me = bot.entity.position.floored()
      if (me.y <= floorY) return { ok: false, why: 'reached y' + me.y + ' without a stronghold wall', steps }
      const hit = sniffStronghold(bot, 22)
      if (hit.length) return { ok: true, at: xyz(hit[0]), steps, torches }
      // the next tread: one forward, one down. Body + head cell of the tread, and the head cell of the step we stand on.
      const cells = [
        new Vec3(me.x + d[0], me.y - 1, me.z + d[1]),
        new Vec3(me.x + d[0], me.y, me.z + d[1]),
        new Vec3(me.x + d[0], me.y + 1, me.z + d[1])
      ]
      let bad = null
      for (const c of cells) {
        // READ THE SIX NEIGHBOURS FIRST (lava/water behind a wall is what kills a digger)
        for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const b = bot.blockAt(c.offset(n[0], n[1], n[2]))
          if (b && /lava/.test(b.name)) { bad = 'lava at ' + xyz(b.position).join(','); break }
        }
        if (bad) break
        const b0 = bot.blockAt(c)
        if (b0 && /water|lava/.test(b0.name)) { bad = b0.name + ' in the tread'; break }
        const r = await B.digBlock(bot, c, { collect: true, requireHarvest: false, allowUnderFeet: false })
        if (!r.ok && !r.already && r.reason !== 'unloaded') { bad = 'cannot dig ' + xyz(c).join(',') + ': ' + r.reason; break }
      }
      if (bad) return { ok: false, why: bad, steps, at: xyz(bot.entity.position) }
      if (!await A.travel(bot, { x: me.x + d[0], y: me.y - 1, z: me.z + d[1] }, { range: 0, ms: 12000, quiet: true, stop: api.stop, anyDepth: true })) return { ok: false, why: 'could not step onto the tread at ' + [me.x + d[0], me.y - 1, me.z + d[1]].join(','), steps }
      steps++
      if (steps % 5 === 0 && A.count(bot, 'torch')) { const t = await B.placeTorch(bot, new Vec3(me.x + d[0], me.y, me.z + d[1]), { stop: api.stop }).catch(() => null); if (t) torches++ }
      task(bot, 'stronghold: staircase ' + steps + ' steps, y' + bot.entity.position.y.toFixed(0))
    }
    return { ok: false, why: 'slice over', steps, torches }
  }
  async function stronghold (bot, job, api, ctx2, P) {
    if (!isOver(bot)) return muster(bot, job, api, ctx2, 'stronghold: overworld work (' + dimOf(bot) + ')')
    const S = endS()
    const want = P.eyes || 6
    const short = await need(bot, api, { ender_eye: want, torch: 32, bread: 12, cobblestone: 32 })
    if (A.count(bot, 'ender_eye') < 1) {
      A.result(bot, { ev: 'sh_blocked', job: job.id, why: 'no eye_of_ender to throw', short })
      A.decline(bot, job, 8 * 60000, 'stronghold: no eyes yet')
      return muster(bot, job, api, ctx2, 'stronghold: no eye_of_ender (stock ' + A.stockOf('ender_eye') + ') — staff work:"eyes" first')
    }
    // ---- already dug in? keep digging / look around
    const room = S.room || {}
    if (Array.isArray(room.portal) || (Array.isArray(room.frames) && room.frames.length)) return muster(bot, job, api, ctx2, 'stronghold: the portal room is on the board — staff work:"portal"')

    const fix = S.fix && Number.isFinite(S.fix.x) ? S.fix : null
    const me = () => bot.entity.position
    const dFix = fix ? Math.hypot(me().x - fix.x, me().z - fix.z) : Infinity
    const near = P.near || 90

    // ---- PHASE C: we are on top of it — sniff, then dig
    if (fix && dFix <= near) {
      const hit = sniffStronghold(bot, 40)
      if (hit.length) {
        A.result(bot, { ev: 'sh_found', job: job.id, at: xyz(hit[0]), block: (bot.blockAt(hit[0]) || {}).name, from: xyz(me()) })
        endEdit(e => { e.found = { at: xyz(hit[0]), by: bot.username, t: now() } })
        // the frames may already be in view
        await noteFrames(bot, job)
        return 'stronghold: stronghold blocks at ' + xyz(hit[0]).join(',')
      }
      // one confirming throw before we cut into the ground: an eye that DIPS says we are within ~12 blocks
      const th = await throwEye(bot, api)
      if (th.ok) {
        A.result(bot, { ev: 'eye_thrown', job: job.id, at: th.from, dir: th.dir.map(round1), dy: th.dy, phase: 'confirm' })
        if (th.dy < -0.02) { /* it is under us */ } else {
          const step = Math.min(P.step || 40, 60)
          const to = { x: Math.round(me().x + th.dir[0] * step), y: null, z: Math.round(me().z + th.dir[1] * step) }
          task(bot, 'stronghold: closing in ' + to.x + ',' + to.z)
          await A.travel(bot, to, { range: 4, ms: 180000, stop: api.stop })
          endEdit(e => { e.fix = { x: Math.round(me().x + th.dir[0] * step), z: Math.round(me().z + th.dir[1] * step), t: now(), legs: (e.fix && e.fix.legs) || 2, refined: true } })
          return 'stronghold: refined the fix by one throw'
        }
      } else A.result(bot, { ev: 'eye_lost', job: job.id, why: th.why, at: xyz(me()) })
      if (P.dig === false) return 'stronghold: at the fix, digging is switched off (params.dig:false)'
      task(bot, 'stronghold: cutting the staircase')
      const r = await stairDown(bot, api, P, job)
      A.result(bot, { ev: r.ok ? 'sh_found' : 'sh_stairs', job: job.id, ok: !!r.ok, steps: r.steps, torches: r.torches || 0, at: r.at || xyz(me()), why: r.why || null })
      if (r.ok) { endEdit(e => { e.found = { at: r.at, by: bot.username, t: now() } }); await noteFrames(bot, job) }
      return 'stronghold: staircase ' + r.steps + ' steps' + (r.ok ? ' — stronghold reached' : '')
    }

    // ---- PHASE B: we have a fix, walk it down in legs
    if (fix) {
      const hop = P.hop || 120
      const a = Math.atan2(fix.z - me().z, fix.x - me().x)
      const to = { x: Math.round(me().x + Math.cos(a) * Math.min(hop, dFix)), y: null, z: Math.round(me().z + Math.sin(a) * Math.min(hop, dFix)) }
      task(bot, 'stronghold: leg towards ' + fix.x + ',' + fix.z + ' (' + Math.round(dFix) + ' left)')
      const ok = await A.travel(bot, to, { range: 8, ms: 300000, stop: api.stop })
      A.result(bot, { ev: 'sh_leg', job: job.id, ok, to: [to.x, to.z], fix: [fix.x, fix.z], left: Math.round(Math.hypot(me().x - fix.x, me().z - fix.z)), at: xyz(me()) })
      if (!ok) return 'stronghold: no route on the leg to ' + to.x + ',' + to.z + ' (' + Math.round(dFix) + ' to go)'
      if (Math.hypot(me().x - fix.x, me().z - fix.z) <= near) A.result(bot, { ev: 'sh_arrived', job: job.id, at: xyz(me()), fix: [fix.x, fix.z] })
      return 'stronghold: ' + Math.round(Math.hypot(me().x - fix.x, me().z - fix.z)) + ' blocks to the fix'
    }

    // ---- PHASE A: no fix yet — throw, cross the bearing, throw again
    const throws = Array.isArray(S.throws) ? S.throws.slice() : []
    const fresh = throws.filter(q => now() - q.t < 6 * 3600000)
    const th = await throwEye(bot, api)
    if (!th.ok) { A.result(bot, { ev: 'eye_lost', job: job.id, why: th.why, at: xyz(me()) }); return 'stronghold: the throw gave no bearing (' + th.why + ')' }
    const rec = { at: th.from, dir: th.dir, dy: th.dy, by: bot.username, t: now() }
    A.result(bot, { ev: 'eye_thrown', job: job.id, at: rec.at, dir: rec.dir.map(round1), dy: rec.dy, phase: 'bearing', have: A.count(bot, 'ender_eye') })
    endEdit(e => { e.throws = (Array.isArray(e.throws) ? e.throws : []).filter(q => now() - q.t < 6 * 3600000).concat([rec]).slice(-12) })
    // can we cross this with an earlier bearing?
    let best = null
    for (const q of fresh) { const c = triangulate(q, rec); if (c && (!best || c.t < best.t)) best = c }
    if (best) {
      endEdit(e => { e.fix = { x: best.x, z: best.z, t: now(), legs: fresh.length + 1, den: best.den } })
      A.result(bot, { ev: 'sh_fix', job: job.id, fix: [best.x, best.z], from: rec.at, legs: fresh.length + 1, den: best.den, dist: Math.round(Math.hypot(best.x - rec.at[0], best.z - rec.at[2])), why: 'two eye bearings crossed — this is where the stronghold is' })
      return 'stronghold: FIX at ' + best.x + ',' + best.z
    }
    // no crossing yet: walk ACROSS the bearing so the next throw gives a real angle
    const leg = P.leg || 320
    const per = [-rec.dir[1], rec.dir[0]] // perpendicular
    const sign = ((seat(bot) % 2) ? -1 : 1)
    const to = { x: Math.round(me().x + per[0] * leg * sign + rec.dir[0] * leg * 0.35), y: null, z: Math.round(me().z + per[1] * leg * sign + rec.dir[1] * leg * 0.35) }
    task(bot, 'stronghold: crossing the bearing to ' + to.x + ',' + to.z)
    const ok = await A.travel(bot, to, { range: 10, ms: 420000, stop: api.stop })
    A.result(bot, { ev: 'sh_leg', job: job.id, ok, to: [to.x, to.z], phase: 'cross', at: xyz(me()), why: 'a second bearing needs a base line across the first' })
    // THE SECOND THROW HAPPENS WHERE THE LEG ENDS, IN THIS SLICE (top model 09-21 14:2xZ: the next slice opens with `need()`, which walks
    // the bot back to the depot for its kit - so Hina threw 5 times from the base, all bearing 0.2,1, and never got a crossing).
    if (ok && !api.stop() && A.count(bot, 'ender_eye') > 0) {
      const t2 = await throwEye(bot, api)
      if (t2.ok) {
        const rec2 = { at: t2.from, dir: t2.dir, dy: t2.dy, by: bot.username, t: now() }
        A.result(bot, { ev: 'eye_thrown', job: job.id, at: rec2.at, dir: rec2.dir.map(round1), dy: rec2.dy, phase: 'cross', have: A.count(bot, 'ender_eye') })
        endEdit(e => { e.throws = (Array.isArray(e.throws) ? e.throws : []).filter(q => now() - q.t < 6 * 3600000).concat([rec2]).slice(-12) })
        const c = triangulate(rec, rec2)
        if (c) {
          endEdit(e => { e.fix = { x: c.x, z: c.z, t: now(), legs: 2, den: c.den } })
          A.result(bot, { ev: 'sh_fix', job: job.id, fix: [c.x, c.z], from: rec2.at, legs: 2, den: c.den, dist: Math.round(Math.hypot(c.x - rec2.at[0], c.z - rec2.at[2])), why: 'two eye bearings crossed - this is where the stronghold is (within ~20-50 blocks)' })
          return 'stronghold: FIX at ' + c.x + ',' + c.z
        }
      } else A.result(bot, { ev: 'eye_lost', job: job.id, why: t2.why, at: xyz(me()) })
    }
    return 'stronghold: bearing ' + rec.dir.map(round1).join(',') + ', crossing leg ' + (ok ? 'walked' : 'blocked')
  }
  // write every end_portal_frame in view onto the board (the portal work needs the exact cells)
  async function noteFrames (bot, job) {
    try {
      const fr = bot.registry.blocksByName.end_portal_frame
      if (!fr) return 0
      const cells = bot.findBlocks({ matching: [fr.id], maxDistance: 48, count: 16 })
      if (!cells.length) return 0
      const arr = cells.map(xyz)
      const cx = Math.round(arr.reduce((n, q) => n + q[0], 0) / arr.length)
      const cy = arr[0][1]
      const cz = Math.round(arr.reduce((n, q) => n + q[2], 0) / arr.length)
      endEdit(e => { e.room = Object.assign({}, e.room, { frames: arr, portal: [cx, cy, cz], at: now(), by: bot.username }) })
      A.result(bot, { ev: 'portal_frames', job: job.id, n: arr.length, centre: [cx, cy, cz], filled: cells.filter(q => { const b = bot.blockAt(q); try { return String(b.getProperties().eye) === 'true' } catch (e_) { return false } }).length })
      return arr.length
    } catch (e_) { swallow('jobs_end:noteFrames', e_); return 0 }
  }

  // ================================================================ 4. THE PORTAL
  async function portal (bot, job, api, ctx2, P) {
    if (!isOver(bot)) return muster(bot, job, api, ctx2, 'end portal: overworld work (' + dimOf(bot) + ')')
    const S = endS(); const room = (S.room || {})
    const centre = Array.isArray(P.at) ? P.at : room.portal
    if (!Array.isArray(centre)) return muster(bot, job, api, ctx2, 'end portal: the portal room is not on the board yet (settings.end.room) — staff work:"stronghold"')
    const need12 = P.eyes || 12
    const short = await need(bot, api, { ender_eye: need12, torch: 16, bread: 8 })
    if (A.count(bot, 'ender_eye') < 1) { A.result(bot, { ev: 'portal_frames', job: job.id, blocked: 'no eye_of_ender carried', short }); A.decline(bot, job, 6 * 60000, 'end portal: no eyes'); return muster(bot, job, api, ctx2, 'end portal: no eye to place (' + short.join(', ') + ')') }
    const c = v(centre)
    if (bot.entity.position.distanceTo(c) > 6) {
      task(bot, 'end portal: to the portal room')
      if (!await A.travel(bot, c, { range: 3, ms: 300000, stop: api.stop, anyDepth: true })) return 'end portal: no route to the portal room ' + centre.join(',')
    }
    await noteFrames(bot, job)
    const fr = bot.registry.blocksByName.end_portal_frame
    if (!fr) return 'end portal: this registry has no end_portal_frame'
    let placed = 0; let filled = 0; let total = 0
    for (let pass = 0; pass < 3 && !api.stop(); pass++) {
      const cells = bot.findBlocks({ matching: [fr.id], maxDistance: 12, count: 16 })
      total = cells.length
      let open = 0
      for (const q of cells) {
        if (api.stop()) break
        const b = bot.blockAt(q)
        let eye = false
        try { eye = String(b.getProperties().eye) === 'true' } catch (e_) { swallow('jobs_end:frameProps', e_) }
        if (eye) { filled++; continue }
        open++
        if (!A.count(bot, 'ender_eye')) break
        if (bot.entity.position.distanceTo(q) > 3.5 && !await A.travel(bot, q, { range: 2, ms: 30000, quiet: true, stop: api.stop, anyDepth: true })) continue
        const it = bot.inventory.items().find(i => i.name === 'ender_eye')
        if (!it) break
        try { await U.withTimeout(bot.equip(it, 'hand'), 3000, 'eyeHand') } catch (e_) { swallow('jobs_end:portalHand', e_); continue }
        try { await bot.lookAt(q.offset(0.5, 0.9, 0.5), true); await U.withTimeout(bot.activateBlock(bot.blockAt(q)), 4000, 'frame') } catch (e_) { swallow('jobs_end:frameClick', e_) }
        await sleep(400)
        const b2 = bot.blockAt(q)
        let now2 = false
        try { now2 = String(b2.getProperties().eye) === 'true' } catch (e_) { swallow('jobs_end:frameProps2', e_) }
        if (now2) { placed++; filled++; A.result(bot, { ev: 'frame_filled', job: job.id, at: xyz(q), filled, of: total }) }
      }
      if (!open) break
      filled = 0
    }
    // did it light? the 3x3 inside becomes end_portal
    const ep = bot.registry.blocksByName.end_portal
    const lit = ep ? bot.findBlocks({ matching: [ep.id], maxDistance: 10, count: 1 }) : []
    if (lit.length) {
      endEdit(e => { e.lit = now(); e.room = Object.assign({}, e.room, { portal: xyz(lit[0]) }) })
      A.result(bot, { ev: 'end_portal_lit', job: job.id, at: xyz(lit[0]), placed, why: 'the 12 frames are full and the portal stands' })
      pauseSelf(job, 'auto-paused: the end portal is lit at ' + xyz(lit[0]).join(','))
      return 'end portal: LIT at ' + xyz(lit[0]).join(',')
    }
    A.result(bot, { ev: 'portal_frames', job: job.id, placed, filled, of: total, carried: A.count(bot, 'ender_eye'), why: total < 12 ? 'fewer than 12 frames in view — walk the room' : 'frames still open' })
    return 'end portal: ' + placed + ' eyes set, ' + filled + '/' + total + ' frames full'
  }

  // ================================================================ 5. THE DRAGON
  const CRYSTAL_RE = /end_crystal|ender_crystal/
  function crystals (bot, r) {
    const me = bot.entity.position; const out = []
    for (const k in bot.entities) {
      const e = bot.entities[k]
      if (!e || !e.position || !e.isValid) continue
      const nm = String(e.name || e.displayName || '').toLowerCase()
      if (!CRYSTAL_RE.test(nm)) continue
      const d = e.position.distanceTo(me)
      if (d <= (r || 128)) out.push({ e, d })
    }
    return out.sort((a, b) => a.d - b.d)
  }
  function theDragon (bot) {
    for (const k in bot.entities) { const e = bot.entities[k]; if (e && e.position && /ender_dragon/.test(String(e.name || e.displayName || '').toLowerCase())) return e }
    return null
  }
  // SHOOT: charge the bow ~1.1 s, release, verify the target is gone. Any projectile pops a crystal.
  // the bow technique lives in lib/moves.js (one implementation; the blaze doorway uses it too)
  const shoot = (bot, ent, o) => require('./moves').shoot(bot, ent, o)
  async function dragon (bot, job, api, ctx2, P) {
    const endT = now() + (P.minutes || 12) * 60000
    // ---- OVERWORLD: kit and step into the portal
    if (isOver(bot)) {
      const S = endS(); const room = S.room || {}
      const gate = Array.isArray(P.at) ? P.at : room.portal
      if (!Array.isArray(gate)) return muster(bot, job, api, ctx2, 'dragon: no end portal on the board (settings.end.room.portal)')
      const short = await need(bot, api, { bow: 1, arrow: P.arrows || 64, bread: 16, cobblestone: P.blocks || 64, torch: 8 })
      await need(bot, api, { water_bucket: 1 }).catch(() => [])
      if (P.beds !== false) await need(bot, api, { gray_bed: P.beds || 2 }).catch(() => [])
      await A.kitUp(bot, { risk: true, force: true, why: 'dragon', stop: api.stop }).catch(e_ => swallow('jobs_end:kit', e_))
      await equipShield(bot)
      if (!A.count(bot, 'arrow') || !A.count(bot, 'bow')) {
        A.result(bot, { ev: 'end_retreat', job: job.id, why: 'no bow/arrows: ' + short.join(', ') })
        A.decline(bot, job, 6 * 60000, 'dragon: unarmed for the crystals')
        return muster(bot, job, api, ctx2, 'dragon: no bow/arrows (' + short.join(', ') + ')')
      }
      const g = v(gate)
      task(bot, 'dragon: to the end portal')
      if (bot.entity.position.distanceTo(g) > 3 && !await A.travel(bot, g, { range: 1, ms: 420000, stop: api.stop, anyDepth: true })) return 'dragon: no route to the end portal ' + gate.join(',')
      task(bot, 'dragon: stepping into the portal')
      const dim0 = dimOf(bot)
      for (let i = 0; i < 60 && dimOf(bot) === dim0 && !api.stop(); i++) {
        await A.travel(bot, g, { range: 0, ms: 6000, quiet: true, stop: api.stop, anyDepth: true }).catch(() => false)
        await sleep(1000)
      }
      if (dimOf(bot) === dim0) return 'dragon: stood in the end portal and stayed in ' + dim0
      A.result(bot, { ev: 'end_arrived', job: job.id, from: gate, pos: xyz(bot.entity.position), hp: Math.round(bot.health) })
      return 'dragon: through — in ' + dimOf(bot)
    }
    if (!isEnd(bot)) return muster(bot, job, api, ctx2, 'dragon: wrong dimension (' + dimOf(bot) + ')')

    // ---- THE END
    const B = BL()
    await equipShield(bot)
    A.result(bot, { ev: 'end_arrived', job: job.id, pos: xyz(bot.entity.position), hp: Math.round(bot.health), crystals: crystals(bot, 200).length, dragon: !!theDragon(bot) })
    // the arrival platform is at (100,49,0) and may hang over the void: bridge west to the island before anything else
    const me = () => bot.entity.position
    if (Math.abs(me().x) > 60 || Math.abs(me().z) > 60) {
      task(bot, 'dragon: crossing from the arrival platform')
      const STONE = ['cobblestone', 'cobbled_deepslate', 'end_stone', 'dirt', 'stone', 'obsidian']
      for (let i = 0; i < 12 && !api.stop() && (Math.abs(me().x) > 45 || Math.abs(me().z) > 45); i++) {
        // the island is at the origin: step towards it on the DOMINANT axis, because blocks.js `bridge` spans one axis at a time
        const dx = -Math.sign(Math.round(me().x)); const dz = -Math.sign(Math.round(me().z))
        const axis = Math.abs(me().x) >= Math.abs(me().z) ? new Vec3(dx, 0, 0) : new Vec3(0, 0, dz)
        const to = { x: Math.round(me().x + axis.x * 16), y: null, z: Math.round(me().z + axis.z * 16) }
        if (await A.travel(bot, to, { range: 3, ms: 30000, quiet: true, stop: api.stop, anyDepth: true })) continue
        const item = STONE.find(k => A.count(bot, k) > 0)
        if (!item) { A.result(bot, { ev: 'end_retreat', job: job.id, at: xyz(me()), why: 'nothing left to bridge the void with' }); break }
        const adv = await B.bridge(bot, axis, 16, item, { stop: api.stop }).catch(e_ => { swallow('jobs_end:bridge', e_); return 0 })
        if (!adv) break
      }
    }
    let crys = 0; let hits = 0; let perches = 0
    while (now() < endT && !api.stop() && bot.health > 0) {
      if (bot.health < (P.minHp || 10)) { A.result(bot, { ev: 'end_retreat', job: job.id, hp: Math.round(bot.health), at: xyz(me()) }); await sleep(6000); continue }
      // PHASE 1: every crystal, because one alive heals the dragon 1 hp / 0.5 s
      const cs = crystals(bot, P.crystalR || 160)
      if (cs.length) {
        const t = cs[0]
        task(bot, 'dragon: crystal at ' + xyz(t.e.position).join(','))
        if (t.d > 48) await A.travel(bot, { x: Math.round(t.e.position.x), y: null, z: Math.round(t.e.position.z) }, { range: 24, ms: 60000, quiet: true, stop: api.stop, anyDepth: true })
        const r = await shoot(bot, t.e, { shots: P.shots || 4, stop: api.stop })
        if (r.ok) { crys++; A.result(bot, { ev: 'crystal_down', job: job.id, n: crys, left: crystals(bot, 200).length, at: xyz(t.e.position), shots: r.shots }) } else A.result(bot, { ev: 'crystal_caged', job: job.id, at: xyz(t.e.position), why: r.why, note: 'the y79/y82 pillars are caged in iron bars: a climber pillars up BESIDE it, breaks one bar and shoots from 5+ blocks' })
        continue
      }
      // PHASE 2: the head, while it perches on the fountain
      const d = theDragon(bot)
      if (!d) {
        if (crys) { A.result(bot, { ev: 'dragon_dead', job: job.id, crystals: crys, hits, perches, at: xyz(me()), why: 'no ender_dragon entity in view — verify with the camera before believing it' }); return 'dragon: no dragon in view after ' + crys + ' crystals' }
        task(bot, 'dragon: waiting for the dragon')
        await sleep(3000); continue
      }
      const dd = d.position.distanceTo(me())
      const perched = d.position.y < 72 && dd < 20
      if (perched) {
        perches++
        task(bot, 'dragon: the head is down — hitting')
        await A.equipBest(bot, 'axe') || await A.equipBest(bot, 'sword')
        const t0 = now()
        while (now() - t0 < 12000 && !api.stop() && bot.health > (P.minHp || 10)) {
          const cur = bot.entities[d.id]
          if (!cur || !cur.isValid) break
          if (cur.position.distanceTo(me()) > 5) await A.travel(bot, { x: Math.round(cur.position.x), y: null, z: Math.round(cur.position.z) }, { range: 3, ms: 5000, quiet: true, stop: api.stop, anyDepth: true })
          try { await bot.lookAt(cur.position.offset(0, 1.2, 0), true); bot.attack(cur); hits++ } catch (e_) { swallow('jobs_end:hit', e_) }
          await sleep(650) // sword cooldown 1.6 -> 12.5 ticks; never faster than the mob's 10-tick hit immunity
        }
        A.result(bot, { ev: 'dragon_perch', job: job.id, perches, hits, hp: Math.round(bot.health), at: xyz(me()) })
        continue
      }
      // flying: arrows bounce off a perched dragon but hit a flying one; keep off the breath
      task(bot, 'dragon: flying — shooting')
      await shoot(bot, d, { shots: 2, stop: api.stop })
      hits++
      await sleep(600)
    }
    A.result(bot, { ev: 'dragon_hit', job: job.id, crystals: crys, hits, perches, hp: Math.round(bot.health), at: xyz(me()) })
    return 'dragon: ' + crys + ' crystals, ' + hits + ' hits, ' + perches + ' perches'
  }

  // ================================================================ the type
  async function end (bot, job, api, ctx2) {
    const P = job.params || {}
    const work = String(P.work || 'enderhunt')
    // NOBODY ON THIS FRONT IS CALLED HOME TO BED. `bedDue` (army_jobs.js) sends a bot up to 150 blocks to its own bed at dusk once
    // per 6 h — on a NIGHT job that is the whole night gone to a walk (measured 09-21 06:27Z: 2 of 8 hunters left at dusk), and its
    // own `api.stop` hook then cuts the slice short. `bedDue` (army_jobs.js) now skips type `end` and every `needsNight` job.
    switch (work) {
      case 'enderhunt': return await enderhunt(bot, job, api, ctx2, P)
      case 'eyes': return await eyes(bot, job, api, ctx2, P)
      case 'stronghold': return await stronghold(bot, job, api, ctx2, P)
      case 'portal': return await portal(bot, job, api, ctx2, P)
      case 'dragon': return await dragon(bot, job, api, ctx2, P)
      default: return muster(bot, job, api, ctx2, 'end: unknown params.work "' + work + '" (enderhunt|eyes|stronghold|portal|dragon)')
    }
  }

  return { types: { end }, verbs: {} }
}
module.exports.TYPES = ['end']
module.exports.VERBS = []
