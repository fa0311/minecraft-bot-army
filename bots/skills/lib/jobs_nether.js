// jobs_nether.js — P5 NETHER, stage 1: the army LIGHTS its gate, walks through, makes the far side safe and comes back.
// EXTENSION MODULE (see the end of army_jobs.js): one job type, `portal`. Nothing here drives a single bot by hand — it is an
// ordinary board job with ordinary primitives (A.travel, A.obtain, A.placeHard, blocks.js), and every report states what was
// READ BACK FROM THE WORLD, never what was intended (lesson 3 of world 1).
//
// THE JOB (type `portal`, params):
//   origin:[x,y,z]   the origin of the `nether_portal` BUILD job (the gate's geometry comes from that blueprint's geom(), so the
//                    lighting can never drift from what stands in the world)   args:{axis}   blueprint:'nether_portal'
//   buildJob:'<id>'  the build job that owns the frame — re-activated (= the repair) when a frame cell is missing
//   go:true          ONE pinned bot (job.names length 1) crosses: 128 cobblestone + food + sword, walks in, waits for the
//                    dimension change, looks, shells the far portal if the far side is unsafe, walks back. Bump `rev` to send
//                    another expedition (settings.nether.scoutRev remembers which rev already went).
//   cobble:128 · crossS:90 (seconds to stand in the portal) · stayS:300 (seconds on the far side before the way back)
// EVENTS (all verified): portal_frame_incomplete · flint_knapped · portal_lit · portal_light_failed · portal_through ·
//   nether_look · nether_shell · portal_back · portal_scout_died · portal_scout_missing
// BOARD: settings.nether = {gate:[x,y,z] overworld, lit, portal:[x,y,z] NETHER coords, hub:[x,y,z], through, back, scoutRev}
//
// WHAT THIS FILE MUST NOT DO: no cheats (no /give, /tp, no creative), no new state file, no new daemon. A bot that dies over
// there declines the job for 30 min, so one bad gate can never burn a bot in a loop.
const { Vec3 } = require('vec3')

module.exports = ctx => {
  const { A, U, muster, task, swallow } = ctx
  const sleep = A.sleep
  const path = require('path')
  const fs = require('fs')
  const v = p => Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z)
  const xyz = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  // blocks.js is required per call: army_worker drops the WHOLE lib cache on any edit, so this always resolves to the live copy
  const BL = () => require('./blocks')
  const isNether = bot => /nether/.test(String((bot.game && bot.game.dimension) || ''))
  const dimOf = bot => String((bot.game && bot.game.dimension) || 'unknown')
  // what may stand in a frame CORNER (vanilla leaves them empty; ours carry any stone sort, see the blueprint)
  const STONE_RE = /^(cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|tuff|deepslate|stone_bricks|blackstone|basalt|smooth_stone|netherrack)$/

  // ---------------------------------------------------------------- the gate's geometry comes from the BLUEPRINT, never from here
  let _bpM = 0
  function geomOf (P) {
    const name = String(P.blueprint || 'nether_portal').replace(/[^a-z0-9_]/gi, '')
    const f = require.resolve(path.join(A.DIR, '..', 'blueprints', name + '.js'))
    try { const m = fs.statSync(f).mtimeMs; if (_bpM !== m) { delete require.cache[f]; _bpM = m } } catch (e_) { swallow('jobs_nether:bpStat', e_) }
    const mod = require(f)
    if (typeof mod.geom !== 'function') throw new Error('blueprint ' + name + ' has no geom()')
    return mod.geom({ x: P.origin[0], y: P.origin[1], z: P.origin[2] }, P.args || {})
  }
  const netherEdit = patch => A.boardEdit(b => { const S = b.settings = b.settings || {}; S.nether = Object.assign({}, S.nether || {}, patch) })
  const netherOf = () => A.settings().nether || {}

  // ---------------------------------------------------------------- reading the world back
  const frameGaps = (bot, G) => G.frame.filter(f => { const b = bot.blockAt(v(f.at)); return !b || (f.corner ? !STONE_RE.test(b.name) : b.name !== 'obsidian') })
  const litCells = (bot, cells) => cells.filter(q => { const b = bot.blockAt(v(q)); return !!b && b.name === 'nether_portal' })
  // the whole portal surface a `nether_portal` block belongs to (the far side's gate is 2x3 like ours, but the world may have built it wider)
  function portalBody (bot, from, r = 8) {
    const out = []; const seen = new Set(); const q = [from.clone ? from.clone() : v(from)]
    while (q.length && out.length < 48) {
      const p = q.pop(); const k = p.x + ',' + p.y + ',' + p.z
      if (seen.has(k) || p.distanceTo(from) > r) continue
      seen.add(k)
      const b = bot.blockAt(p); if (!b || b.name !== 'nether_portal') continue
      out.push(p)
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) q.push(p.offset(d[0], d[1], d[2]))
    }
    return out
  }

  // ---------------------------------------------------------------- flint: it comes OUT OF GRAVEL, not out of a recipe (10 % a block)
  async function knapGravel (bot, api) {
    const t0 = Date.now(); let broke = 0
    while (!A.count(bot, 'flint') && broke < 64 && Date.now() - t0 < 180000 && !api.stop()) {
      const nat = U.findBlocksByName(bot, ['gravel'], 40, 8)
      if (!nat.length) break
      task(bot, 'portal: knapping gravel for flint (' + broke + ' broken)')
      if (await U.mineAt(bot, nat[0], 30000).catch(() => false)) broke++
      await A.pickup(bot, 5, 2000)
    }
    if (broke) A.result(bot, { ev: 'flint_knapped', broke, flint: A.count(bot, 'flint') })
    return A.count(bot, 'flint') > 0
  }

  // ---------------------------------------------------------------- strike the gate
  // The fire goes on the TOP FACE of a bottom obsidian block, so it lands in the lowest inner cell. Every stand is tried from
  // both bottom cells; after each strike the SIX inner cells are read back — "lit" means six `nether_portal` blocks, nothing else.
  async function strike (bot, job, api, G) {
    let last = 'not struck'
    for (const ref of G.floor) {
      for (const s of G.stands) {
        if (api.stop()) return last
        if (litCells(bot, G.inner).length >= G.inner.length) return true
        if (!await A.travel(bot, v(s), { range: 0, ms: 45000, stop: api.stop, quiet: true })) { last = 'cannot stand at ' + s.join(','); continue }
        // a portal only forms in AIR: anything that blew/grew into the frame comes out first (never the portal blocks themselves)
        for (const q of G.inner) {
          const b = bot.blockAt(v(q)); if (!b || /^(air|cave_air|nether_portal|fire)$/.test(b.name)) continue
          await BL().digBlock(bot, v(q), { collect: true, requireHarvest: false }).catch(e_ => swallow('jobs_nether:clearInner', e_))
        }
        const rb = bot.blockAt(v(ref)); if (!rb || rb.name !== 'obsidian') { last = 'the bottom obsidian at ' + ref.join(',') + ' is ' + (rb ? rb.name : 'not loaded'); continue }
        const fs2 = bot.inventory.items().find(i => i.name === 'flint_and_steel'); if (!fs2) return 'the flint and steel left my pockets'
        try {
          await U.withTimeout(bot.equip(fs2, 'hand'), 5000, 'equipFlint')
          await U.withTimeout(bot.activateBlock(rb, new Vec3(0, 1, 0)), 8000, 'strike')
        } catch (e) { last = 'strike threw: ' + String(e && e.message).slice(0, 60); swallow('jobs_nether:strike', e); continue }
        for (let w = 0; w < 16 && litCells(bot, G.inner).length < G.inner.length; w++) await sleep(250)
        const n = litCells(bot, G.inner).length
        if (n >= G.inner.length) return true
        last = 'struck ' + ref.join(',') + ' from ' + s.join(',') + ': ' + n + '/' + G.inner.length + ' cells are nether_portal'
      }
    }
    return last
  }

  // ---------------------------------------------------------------- stand in the gate until the server moves us
  // The player delay is 80 ticks; the bot must STAY on the cell, so the goal is dropped and the position re-centred every 2 s.
  async function stepThrough (bot, api, cells, seconds, why) {
    const dim0 = dimOf(bot)
    const target = cells.map(q => v(q)).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    for (const c of target) {
      if (api.stop() || dimOf(bot) !== dim0) break
      task(bot, 'portal: ' + why)
      if (!await A.travel(bot, c, { range: 0, ms: 45000, stop: api.stop, quiet: true, anyDepth: true })) continue
      try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { swallow('jobs_nether:hold', e_) }
      const end = Date.now() + seconds * 1000
      while (Date.now() < end && !api.stop()) {
        if (dimOf(bot) !== dim0) return dimOf(bot)
        const p = bot.entity.position.floored()
        if (p.x !== c.x || p.z !== c.z || Math.abs(p.y - c.y) > 1) { if (!await A.travel(bot, c, { range: 0, ms: 15000, stop: api.stop, quiet: true, anyDepth: true })) break; try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { swallow('jobs_nether:hold2', e_) } }
        else { await BL().centreOn(bot, c).catch(e_ => swallow('jobs_nether:centre', e_)) }
        await sleep(1000)
      }
      if (dimOf(bot) !== dim0) return dimOf(bot)
    }
    return dimOf(bot) !== dim0 ? dimOf(bot) : null
  }

  // ---------------------------------------------------------------- a 5x5x3 cobblestone shell with a door gap around the far gate
  // What a player builds the second he arrives: the far portal usually opens in the open, in sight of ghasts and over lava. Only
  // cells that are NOT already solid are placed, the portal and its obsidian are never touched, and the count reported is the
  // count read back from the world.
  async function shell (bot, job, api, body, budget) {
    if (!body.length) return { placed: 0, why: 'no portal block to wrap' }
    const bx = [Math.min(...body.map(p => p.x)), Math.max(...body.map(p => p.x))]
    const bz = [Math.min(...body.map(p => p.z)), Math.max(...body.map(p => p.z))]
    const y0 = Math.min(...body.map(p => p.y))
    const cx = Math.round((bx[0] + bx[1]) / 2); const cz = Math.round((bz[0] + bz[1]) / 2)
    const keep = new Set(); for (const p of body) { keep.add(p.x + ',' + p.y + ',' + p.z); for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) keep.add((p.x + d[0]) + ',' + (p.y + d[1]) + ',' + (p.z + d[2])) }
    // the door gap: the ring cell nearest to where we stand, 2 high — the way out for the next expedition
    const me = bot.entity.position
    const ring = []
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) if (Math.abs(x - cx) === 2 || Math.abs(z - cz) === 2) ring.push([x, z])
    const gap = ring.slice().sort((a, b) => Math.hypot(a[0] + 0.5 - me.x, a[1] + 0.5 - me.z) - Math.hypot(b[0] + 0.5 - me.x, b[1] + 0.5 - me.z))[0]
    const cells = []
    for (const [x, z] of ring) for (let y = y0; y <= y0 + 2; y++) { if (gap && x === gap[0] && z === gap[1] && y <= y0 + 1) continue; cells.push(new Vec3(x, y, z)) }
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) { cells.push(new Vec3(x, y0 + 3, z)); cells.push(new Vec3(x, y0 - 1, z)) } // roof + floor (only where there is a hole)
    let placed = 0; let lava = 0; const t0 = Date.now()
    for (const c of cells) {
      if (api.stop() || placed >= budget || Date.now() - t0 > 240000) break
      if (keep.has(c.x + ',' + c.y + ',' + c.z)) continue
      const b = bot.blockAt(c); if (!b) continue
      if (b.name === 'obsidian' || b.name === 'nether_portal') continue
      if (b.boundingBox === 'block') continue
      if (b.name === 'lava') lava++
      if (!A.count(bot, 'cobblestone')) break
      task(bot, 'portal: walling the far gate in (' + placed + ')')
      const r = await A.placeHard(bot, c, 'cobblestone', { stop: api.stop, noRest: true }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      const nb = bot.blockAt(c)
      if ((r && r.ok) || (nb && nb.boundingBox === 'block')) placed++
    }
    return { placed, lava, gap: gap ? [gap[0], y0, gap[1]] : null, box: [cx - 2, cz - 2, cx + 2, cz + 2], y: y0 }
  }

  // ---------------------------------------------------------------- the far side (also the entry point when a new slice starts over there)
  async function netherSide (bot, job, api, ctx2, st, P) {
    task(bot, 'portal: the Nether — waiting for the world')
    for (let w = 0; w < 80 && !bot.world.getColumnAt(bot.entity.position); w++) await sleep(500)
    await sleep(1500)
    const me = bot.entity.position.floored()
    let far = bot.findBlock({ matching: b => !!b && b.name === 'nether_portal', maxDistance: 32 })
    const body = far ? portalBody(bot, far.position, 10) : []
    if (!st.through) {
      st.through = Date.now()
      A.result(bot, { ev: 'portal_through', job: job.id, from: st.fromDim || 'overworld', to: dimOf(bot), pos: xyz(me), portal: far ? xyz(far.position) : null, cells: body.length })
      netherEdit({ portal: far ? xyz(far.position) : xyz(me), through: Date.now(), scoutRev: job.rev || 0, by: bot.username })
    }
    if (!far) {
      // no gate in sight = no way home on foot. Say it and stand still; the operator decides (a second gate, a rescue expedition).
      A.result(bot, { ev: 'nether_lost', job: job.id, pos: xyz(me), why: 'no nether_portal block within 32 of where I arrived' })
      A.askHelp(bot, 'nether_lost', 'I am in the Nether at ' + xyz(me).join(',') + ' and see no portal within 32 blocks')
      return 'in the Nether at ' + xyz(me).join(',') + ' with no portal in sight'
    }
    // LOOK: what a player checks in the first three seconds
    if (!st.looked) {
      st.looked = true
      const lavaIds = [bot.registry.blocksByName.lava && bot.registry.blocksByName.lava.id].filter(q => q != null)
      const lava = lavaIds.length ? bot.findBlocks({ matching: lavaIds, maxDistance: 16, count: 200, point: far.position }).length : 0
      const mobs = A.hostiles(bot, 16).map(e => e.name)
      let drop = 0; { const p0 = far.position; for (let y = p0.y - 1; y >= p0.y - 24; y--) { const b = bot.blockAt(new Vec3(p0.x, y, p0.z)); if (!b) { drop = -1; break } if (b.boundingBox === 'block') break; drop++ } }
      st.unsafe = lava > 0 || mobs.length > 0 || drop > 2 || drop < 0
      A.result(bot, { ev: 'nether_look', job: job.id, at: xyz(far.position), lava, mobs: mobs.slice(0, 8), drop, hp: bot.health, unsafe: st.unsafe })
    }
    // SHELL: only when it is needed, only with what we carried in
    if (st.unsafe && !st.shelled && A.count(bot, 'cobblestone') >= 16) {
      st.shelled = true
      const r = await shell(bot, job, api, body, Math.min(A.count(bot, 'cobblestone'), 160))
      A.result(bot, Object.assign({ ev: 'nether_shell', job: job.id }, r))
      if (r.placed) netherEdit({ hub: [r.box[0] + 2, r.y, r.box[1] + 2], shell: r.box, shellY: r.y })
    }
    // HOME. Never stay: keep_inventory is OFF and a slice is 15 min.
    if (api.stop()) return 'in the Nether at ' + xyz(me).join(',') + ' (slice over, going home next slice)'
    task(bot, 'portal: walking home')
    const back = portalBody(bot, far.position, 10).map(p => [p.x, p.y, p.z])
    const to = await stepThrough(bot, api, back.length ? back : [xyz(far.position)], Math.min(P.crossS || 90, 120), 'standing in the far gate')
    if (to && !/nether/.test(to)) {
      A.result(bot, { ev: 'portal_back', job: job.id, to, pos: xyz(bot.entity.position), ms: Date.now() - (st.through || Date.now()) })
      netherEdit({ back: Date.now() })
      st.phase = 'done'; st.deathsAtGo = null
      return 'portal_back: ' + to
    }
    return 'still in the Nether at ' + xyz(bot.entity.position) .join(',') + ' (' + (api.stop() ? 'slice over' : 'the gate did not take me') + ')'
  }

  // ================================================================ the job
  async function portal (bot, job, api, ctx2) {
    const P = job.params || {}
    if (!Array.isArray(P.origin) || P.origin.length !== 3 || !P.origin.every(Number.isFinite)) return muster(bot, job, api, ctx2, 'portal: params.origin [x,y,z] is missing (it is the origin of the nether_portal BUILD job)')
    let G; try { G = geomOf(P) } catch (e) { return muster(bot, job, api, ctx2, 'portal: blueprint error ' + String(e && e.message).slice(0, 80)) }
    const key = job.id + ':' + (job.rev || 0)
    const st = bot.__armyPortal = (bot.__armyPortal && bot.__armyPortal.key === key) ? bot.__armyPortal : { key, phase: 'gate' }

    // A BOT THAT DIED ON THE TRIP DOES NOT GO AGAIN (30 min): one bad gate must never burn a bot in a loop. Deaths are counted
    // from the moment the expedition started, so a creeper at base on another job never blocks the gate.
    if (st.deathsAtGo != null && (bot.__armyDeaths || 0) > st.deathsAtGo) {
      A.result(bot, { ev: 'portal_scout_died', job: job.id, deaths: (bot.__armyDeaths || 0) - st.deathsAtGo, at: st.through ? 'the_nether' : 'the gate' })
      st.deathsAtGo = null; st.phase = 'gate'; st.through = 0; st.looked = false; st.shelled = false
      A.decline(bot, job, 30 * 60000, 'died on the nether trip')
      return muster(bot, job, api, ctx2, 'portal: I died on the trip — this job is declined for 30 min')
    }
    // already over there (a new slice, or the dispatcher handed the job back): only nether work happens in the nether
    if (isNether(bot)) return await netherSide(bot, job, api, ctx2, st, P)

    // ---- 1. the FRAME is the build job's, never this one's
    const gate = v(G.floor[0])
    if (A.dist2(bot, gate.x, gate.z) > 24 && !await A.travel(bot, { x: gate.x, y: gate.y + 1, z: gate.z }, { range: 3, ms: 300000, stop: api.stop })) return 'portal: cannot reach the gate at ' + G.floor[0].join(',')
    await sleep(500)
    const gaps = frameGaps(bot, G)
    if (gaps.length) {
      A.result(bot, { ev: 'portal_frame_incomplete', job: job.id, missing: gaps.length, at: gaps.slice(0, 4).map(f => f.at.join(',')), build: P.buildJob || null })
      if (P.buildJob) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === P.buildJob); if (j && j.status !== 'active') { j.status = 'active'; j.note = 'auto-reactivated: the portal job found ' + gaps.length + ' frame cells missing' } })
      A.decline(bot, job, 6 * 60000, 'the frame is ' + gaps.length + ' cells short')
      return muster(bot, job, api, ctx2, 'portal: ' + gaps.length + ' frame cells are missing — that is ' + (P.buildJob || 'the build job') + "'s work")
    }

    // ---- 2. LIGHT it (nothing to do when it already burns)
    let lit = litCells(bot, G.inner).length
    if (lit < G.inner.length) {
      if (!A.count(bot, 'flint_and_steel')) {
        task(bot, 'portal: fetching flint and steel')
        if (!await A.obtain(bot, 'flint_and_steel', 1, { stop: api.stop })) {
          if (A.count(bot, 'flint') || await knapGravel(bot, api)) await A.obtain(bot, 'flint_and_steel', 1, { stop: api.stop })
        }
      }
      if (!A.count(bot, 'flint_and_steel')) { A.decline(bot, job, 10 * 60000, 'no flint_and_steel'); return muster(bot, job, api, ctx2, 'portal: no flint_and_steel and none craftable (needs 1 iron_ingot + 1 flint; flint drops from gravel)') }
      const r = await strike(bot, job, api, G)
      lit = litCells(bot, G.inner).length
      if (lit < G.inner.length) {
        st.fails = (st.fails || 0) + 1
        A.result(bot, { ev: 'portal_light_failed', job: job.id, at: G.floor[0], cells: lit + '/' + G.inner.length, why: String(r).slice(0, 140), tries: st.fails })
        if (st.fails >= 3) { A.askHelp(bot, 'portal_light_failed', 'the gate at ' + G.floor[0].join(',') + ' will not light: ' + String(r).slice(0, 120)); A.decline(bot, job, 15 * 60000, 'the gate will not light') }
        return 'portal: not lit — ' + String(r).slice(0, 120)
      }
      st.fails = 0
      A.result(bot, { ev: 'portal_lit', job: job.id, at: G.floor[0], cells: lit, axis: G.axis })
      netherEdit({ gate: G.floor[0], axis: G.axis, lit: Date.now(), by: bot.username })
    } else if (!netherOf().lit) netherEdit({ gate: G.floor[0], axis: G.axis, lit: Date.now(), by: bot.username })

    // ---- 3. GO (one pinned scout, once per rev)
    const N = netherOf()
    const wanted = P.go === true && (N.scoutRev !== (job.rev || 0) || !N.back)
    if (!wanted) {
      // the gate stands and burns and nobody has to watch it: free the bot (a job that holds a bot for nothing is a planning failure)
      if ((job.names || []).length <= 1 && !P.standing) A.boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j && (j.rev || 0) === (job.rev || 0) && j.status === 'active') { j.status = 'paused'; j.note = 'auto-paused: the gate is lit' + (P.go === true ? ' and the round trip is done (bump rev to send another expedition)' : '') } })
      return muster(bot, job, api, ctx2, 'portal: the gate stands and burns (' + lit + '/' + G.inner.length + ' cells)')
    }
    if ((job.names || []).length !== 1) {
      if (!st.saidScout) { st.saidScout = true; A.result(bot, { ev: 'portal_scout_missing', job: job.id, why: 'params.go needs exactly ONE pinned bot: set job.names:["<bot>"] (a squad would queue in the frame and the dispatcher could pull a bot while it is in the Nether)' }) }
      return 'portal: lit; the crossing waits for job.names with exactly one bot'
    }

    // KIT: bank first (keep_inventory is OFF), then 128 cobblestone + torches + food + the best sword we may take
    if (!st.kitted) {
      task(bot, 'portal: kitting up for the crossing')
      await A.kitUp(bot, { risk: true, force: true, why: job.id, stop: api.stop }).catch(e_ => swallow('jobs_nether:kitUp', e_))
      const want = { cobblestone: Math.max(32, P.cobble || 128), torch: 32 }
      for (const [item, n] of Object.entries(want)) if (A.count(bot, item) < n) await A.obtain(bot, item, n, { stop: api.stop }).catch(e_ => swallow('jobs_nether:obtain', e_))
      if (!bot.registry.foodsByName || !bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) await A.obtain(bot, 'bread', 16, { stop: api.stop }).catch(e_ => swallow('jobs_nether:food', e_))
      await A.equipBest(bot, 'sword').catch(e_ => swallow('jobs_nether:sword', e_))
      const short = []
      if (A.count(bot, 'cobblestone') < 32) short.push('cobblestone ' + A.count(bot, 'cobblestone') + '/32')
      if (!A.bestOf(bot, 'sword')) short.push('no sword')
      if (!bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) short.push('no food')
      if (short.length) { A.decline(bot, job, 10 * 60000, 'kit short: ' + short.join(', ')); return muster(bot, job, api, ctx2, 'portal: not going through under-equipped (' + short.join(', ') + ')') }
      st.kitted = true
    }
    if (api.stop()) return 'portal: kitted, crossing next slice'

    // CROSS
    st.fromDim = dimOf(bot); st.deathsAtGo = bot.__armyDeaths || 0; st.through = 0; st.looked = false; st.shelled = false
    const to = await stepThrough(bot, api, G.inner.filter(q => q[1] === P.origin[1] + 1), P.crossS || 90, 'standing in the gate')
    if (!to) {
      st.deathsAtGo = null
      A.result(bot, { ev: 'portal_light_failed', job: job.id, at: G.floor[0], cells: litCells(bot, G.inner).length + '/' + G.inner.length, why: 'stood in the gate for ' + (P.crossS || 90) + ' s and stayed in ' + dimOf(bot) })
      return 'portal: stood in the gate, no dimension change (still ' + dimOf(bot) + ')'
    }
    return await netherSide(bot, job, api, ctx2, st, P)
  }

  return { types: { portal }, verbs: {} }
}
module.exports.TYPES = ['portal']
module.exports.VERBS = []
