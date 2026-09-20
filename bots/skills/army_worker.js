// army_worker.js — THE role skill of every bot in the ONE ARMY.
//   loop: heartbeat -> read assignment (bots/army/assign/<bot>.json, written by the LLM-free dispatcher)
//         -> eat -> run the job handler (skills/lib/army_jobs.js) until the job changes -> report.
// No improvisation: unknown job / missing precondition / dead dispatcher => muster point at base.
// Stop it with POST /cmd {action:"stop"} (sets bot.state.cancel) or by launching another role skill.
const path = require('path')
const fs = require('fs')

// HOT RELOAD of everything under skills/lib: one mtime scan per loop (~20 stat calls). A changed file drops the WHOLE lib cache — modules hold
// references to each other, so reloading one alone leaves its dependents on the old copy (world 1: only army.js + army_jobs.js were re-required,
// EVERY loop; a fix in util.js / craft.js / feed.js never reached a running bot, and army.js lost its module state each job slice). Unchanged
// files = the same module objects: enderman grudges, sensor listeners and caches survive until the next edit.
// SAFETY NET: a broken edit must never stop the army. If the new code does not load, the LAST GOOD modules are put back and keep running;
// `error: BROKEN EDIT …` is reported once a minute while it lasts (ops/escalate.sh wakes the code owner on it) and every new save is tried again.
const LIBDIR = path.join(__dirname, 'lib') + path.sep
const ARMY_F = path.join(LIBDIR, 'army.js')
let good = null // { A, J, FEED } — shared by the bots of this process
let sig = null // the mtimes `good` (or the broken edit) was loaded from
let brokenT = 0
function libSig () {
  let out = ''
  try { for (const f of fs.readdirSync(LIBDIR).sort()) if (f.endsWith('.js')) out += f + ':' + fs.statSync(LIBDIR + f).mtimeMs + ';' } catch (e) { return sig } // a file vanished between readdir and stat (an editor's atomic save): next loop
  return out
}
function libs () {
  const now = libSig(); const cur = require.cache[ARMY_F]
  if (good && now === sig && ((cur && cur.exports === good.A) || brokenT)) { if (brokenT && Date.now() - brokenT > 60000) sayBroken(null); return good }
  const old = {}
  // the cache was already renewed by another copy of this worker (manager.runSkill purges skills/ on every skill start): just join it
  if (now !== sig || !cur) for (const k of Object.keys(require.cache)) if (k.startsWith(LIBDIR)) { old[k] = require.cache[k]; delete require.cache[k] }
  try {
    good = { A: require('./lib/army'), J: require('./lib/army_jobs'), FEED: require('./lib/feed') }
    brokenT = 0
  } catch (e) {
    if (!good) throw e
    for (const k of Object.keys(require.cache)) if (k.startsWith(LIBDIR)) delete require.cache[k]
    Object.assign(require.cache, old)
    sayBroken(e)
  }
  sig = now
  return good
}
function sayBroken (e) {
  if (e) sayBroken.err = String(e.message).split('\n')[0].slice(0, 120)
  brokenT = Date.now()
  try { fs.appendFileSync(path.join(__dirname, '..', 'army', 'results.jsonl'), JSON.stringify({ t: Date.now(), bot: '-', ev: 'error', err: 'BROKEN EDIT, running last good skills/lib: ' + sayBroken.err }) + '\n') } catch (e_) { console.error('army_worker: cannot report BROKEN EDIT', e_ && e_.message) }
}
function fresh (rel) { // core/index.js lives outside lib/: reloaded when the manager purged it; keeps the last good copy on a broken edit
  const f = require.resolve(rel)
  const old = require.cache[f]
  delete require.cache[f]
  try { return require(f) } catch (e) {
    if (!old) throw e
    require.cache[f] = old
    sayBroken(e)
    return old.exports
  }
}

module.exports = async (bot, args = {}, ctx) => {
  const gen = Date.now() + Math.random()
  bot.__armyGen = gen
  let { A } = libs()
  // a reconnect creates a NEW bot object; the loop on the old object must die with its connection (it kept heart-beating a frozen position)
  let ended = false
  bot.once('end', () => { ended = true })
  const stale = () => ended || bot.__armyGen !== gen
  const cancelled = () => !!(bot.state && bot.state.cancel) && !bot.__armyPreempt

  if (!bot.__armyDeathHook) {
    bot.__armyDeathHook = true
    bot.__armyDeaths = 0
    bot.on('death', () => {
      bot.__armyDeaths++
      bot.__armyDied = Date.now()
      try {
        const p = bot.entity && bot.entity.position
        bot.__armyDeathInfo = { pos: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null, dim: bot.game && bot.game.dimension, t: Date.now(), inv: bot.__armyLastInv || {}, job: bot.__armyJob || null, task: bot.state && bot.state.task }
        libs().A.result(bot, { ev: 'death', job: bot.__armyJob || null, pos: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null, task: bot.state && bot.state.task })
      } catch (e_) { console.error('army_worker: death report failed', e_ && e_.message) }
    })
  }
  A.strictMovements(bot)
  A.startGuard(bot)
  bot.state.skillEats = true // manager's auto-eat stands down (see manager.js housekeeping)
  let CORE = fresh('./core/index')
  try { await CORE.install(bot) } catch (e_) { A.result(bot, { ev: 'core_error', hook: 'install', err: String(e_ && e_.message).slice(0, 200) }) }
  let preJobT = 0
  let kitT = 0
  let loops = 0
  let lastJob = null
  try {
    while (!stale() && !cancelled()) {
      loops++
      try {
        const L = libs(); A = L.A
        const J = L.J; const FEED = L.FEED
        if (!bot.entity || bot.health <= 0) { await A.sleep(2000); continue }
        if (require.cache[require.resolve('./core/index')] == null) { CORE = fresh('./core/index'); try { await CORE.install(bot) } catch (e_) { A.result(bot, { ev: 'core_error', hook: 'install', err: String(e_ && e_.message).slice(0, 200) }) } }
        if (bot.__armyDied) {
          await A.sleep(3000); bot.__armyDied = 0; A.strictMovements(bot)
          if (bot.__armyDeathInfo) { const info = bot.__armyDeathInfo; bot.__armyDeathInfo = null; await CORE.onDeath(bot, info) }
          kitT = 0; await A.kitUp(bot, { force: true, why: 'respawn', stop: () => stale() || cancelled() }) // naked at the respawn point, the depot is near: dress before anything else
        }
        await CORE.runAlerts(bot)
        const a = A.assignment(bot)
        const job = a.job
        bot.__armyJob = job.id
        A.heartbeat(bot, { job: job.id, gen })
        if (job.id !== lastJob) { A.result(bot, { ev: 'job_start', job: job.id, from: lastJob }); lastJob = job.id }
        // eat what we carry (food engineer's PLAYBOOK eat rule); never walk anywhere for food here
        bot.__armyEating = true
        try { await FEED.eat(bot, {}) } catch (e_) { A.result(bot, { ev: 'error', job: job.id, err: 'eat: ' + String(e_ && e_.message).slice(0, 120) }) } finally { bot.__armyEating = false }
        const t0 = Date.now()
        let lastCheck = 0
        let changed = false
        let hbT = Date.now()
        const api = {
          stop: () => {
            if (stale() || cancelled() || bot.__armyDied || CORE.pending(bot) || Date.now() - t0 > 15 * 60000) return true
            if (Date.now() - hbT > 15000) { hbT = Date.now(); A.heartbeat(bot, { job: job.id, gen }) }
            if (Date.now() - lastCheck > 4000) {
              lastCheck = Date.now()
              const b = A.assignment(bot)
              api._a = b
              if (b.job.id !== job.id || (b.job.rev || 0) !== (job.rev || 0)) changed = true
            }
            return changed
          },
          _a: a,
          phase: () => (api._a && api._a.phase) || 'day',
          time: () => { const b = api._a || a; return b.time == null ? 6000 : (b.time + Math.round((Date.now() - (b.t || Date.now())) / 50)) % 24000 }
        }
        const handler = J[job.type] || J.muster
        // KIT UP before a job with combat/mining risk (A.riskJob): on every job change and then every 10 min; risk bots have first call on scarce gear
        if (A.riskJob(job, api.phase()) && (job.id !== bot.__armyKitJob || Date.now() - kitT > 10 * 60000)) { bot.__armyKitJob = job.id; kitT = Date.now(); await A.kitUp(bot, { risk: true, force: true, why: job.id, stop: api.stop }) }
        if (job.id !== bot.__armyPreJobId || Date.now() - preJobT > 10 * 60000) {
          const pj = await CORE.preJob(bot, job)
          if (pj.ok === false) { A.result(bot, { ev: 'prejob_fail', job: job.id, by: pj.by, reason: pj.reason }); await J.muster(bot, job, api, ctx, 'prejob: ' + pj.reason); continue }
          bot.__armyPreJobId = job.id; preJobT = Date.now()
        }
        const r = await handler(bot, job, api, ctx)
        if (changed) await CORE.postJob(bot, job, r)
        if (r && r !== 'muster') A.result(bot, { ev: 'job_slice', job: job.id, r: String(r).slice(0, 160), ms: Date.now() - t0 })
        await A.sleep(500)
      } catch (e) {
        if (stale() || cancelled()) break
        try { A.result(bot, { ev: 'error', job: bot.__armyJob, err: String(e && e.stack || e).slice(0, 300) }) } catch (e_) { console.error('army_worker: cannot report', e_ && e_.message) }
        try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { /* the connection is gone: nothing to stop */ }
        await A.sleep(5000)
      }
    }
  } finally {
    if (bot.__armyGen === gen) { bot.state.skillEats = false; try { CORE.uninstall(bot) } catch (e_) { console.error('army_worker: core uninstall', e_ && e_.message) } A.stopGuard(bot); try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (e_) { /* the connection is gone: nothing to stop */ } }
  }
  return 'army_worker exited after ' + loops + ' loops'
}
