// core/index.js — THE CONTRACT between army_worker (Chief) and the BASICS modules (docs/GOALS.md A/B/C/D).
// Owner: Chief of Operations. Engineers deliver core/<module>.js; this file loads them, calls their hooks, and
// isolates their failures. A module runs in production only when it is listed in
// bots/army/jobs.json -> settings.core.enabled (enable a module only after its lab test passed).
//
// A module exports any subset of (all optional, all must tolerate being hot-reloaded at any time):
//   name        : 'survival'
//   install(bot, core)                 once per worker start. Idempotent. Keep state on bot.__core_<name>.
//   uninstall(bot, core)               clear your timers/listeners.
//   onTick(bot, core)                  1 Hz, SYNCHRONOUS and cheap (< 2 ms, no findBlocks > 16, no pathfinding).
//                                      Reflexes that need no legs (hit what is in reach, raise shield, eat) may be started
//                                      async here, but ONLY inside core.withHands(bot, fn) so eat/attack/equip never fight.
//                                      Anything that needs to WALK: core.raise(bot, {kind:'retreat', by:name, prio:0..100, data}).
//   handle(bot, alert, core)  async    the worker calls this for YOUR raised alert after the running job slice has yielded
//                                      (the job handler stops within ~1 s of a raise). You own the pathfinder until you return.
//                                      Bounded: you get alert.ms (default 60 s) and must poll core.cancelled(bot).
//   preJob(bot, job, core)    async -> {ok:true} | {ok:false, reason, retryMs}   kit up / eat / bank junk. Bounded 120 s.
//                                      job = {id,type,site,params,kit?}  (job.kit = {tools:[..],food:8,torches:16,blocks:32,weapon:true})
//   postJob(bot, job, result, core) async   pick up drops, bank output. Bounded 120 s.
//   onDeath(bot, info, core)  async    after respawn. info = {pos:[x,y,z], dim, t, inv:{name:count}, job, task}. Bounded 5 min.
//
// Services for modules (use them, do not copy them):
//   core.A            skills/lib/army.js: travel(), bank(), withdraw(), openChest(), index(), stockOf(), result(), readJSON/writeJSON,
//                     strictMovements(), hostiles(), kill(), pickup(), inv(), count(), bestOf(), equipBest(), settings()
//   core.raise(bot, alert) / core.pending(bot) / core.withHands(bot, fn) / core.cancelled(bot)
//   core.clock(bot) -> {time, phase:'day'|'night'}   (from the dispatcher; no rcon from modules)
//   core.log(bot, ev, data)  -> bots/army/results.jsonl
// Rules: never call bot.pathfinder/goto from install/onTick; never write bot.entity.position; never set bot.state.cancel;
//        every await has a timeout; shared state only in bots/army/*.json via core.A.writeJSON (atomic).
const fs = require('fs')
const path = require('path')

const ORDER = ['survival', 'combat', 'hazards', 'inventory', 'kit', 'death', 'blocks', 'crafting']
const _cache = {}
function fresh (f) { // reload a module only when its file changed
  const mt = fs.statSync(f).mtimeMs
  if (_cache[f] && _cache[f].mt === mt) return _cache[f].m
  delete require.cache[f]
  const m = require(f)
  _cache[f] = { mt, m }
  return m
}
function A () { return require('../lib/army') }
function withTimeout (p, ms, tag) {
  let t
  return Promise.race([Promise.resolve(p), new Promise((resolve, reject) => { t = setTimeout(() => reject(new Error('timeout ' + tag)), ms) })]).finally(() => clearTimeout(t))
}

function enabledNames () { const c = (A().settings().core) || {}; return Array.isArray(c.enabled) ? c.enabled : [] }
function load (bot) {
  const st = bot.__core = bot.__core || { alerts: [], bad: {}, hands: false, mods: {} }
  const mods = []
  for (const n of ORDER) {
    if (!enabledNames().includes(n)) continue
    if (st.bad[n] && Date.now() < st.bad[n]) continue
    const f = path.join(__dirname, n + '.js')
    if (!fs.existsSync(f)) continue
    try { const m = fresh(f); m.name = m.name || n; mods.push(m) } catch (e) { fail(bot, n, 'load', e) }
  }
  return mods
}
function fail (bot, n, hook, e) {
  const st = bot.__core
  st.bad[n] = Date.now() + 5 * 60000 // module is benched for 5 min on this bot
  try { A().result(bot, { ev: 'core_error', mod: n, hook, err: String(e && e.stack || e).slice(0, 300) }) } catch {}
}

const core = {
  get A () { return A() },
  cancelled: bot => !bot || !bot.entity || !!(bot.state && bot.state.cancel),
  log: (bot, ev, data) => A().result(bot, Object.assign({ ev }, data || {})),
  clock: bot => { const a = A().assignment(bot); const time = a.time == null ? 6000 : (a.time + Math.round((Date.now() - (a.t || Date.now())) / 50)) % 24000; return { time, phase: a.phase || 'day' } },
  raise (bot, alert) {
    const st = bot.__core; if (!st || !alert || !alert.kind) return
    if (st.alerts.some(a => a.kind === alert.kind && a.by === alert.by)) return
    st.alerts.push(Object.assign({ t: Date.now(), prio: 50, ms: 60000 }, alert))
  },
  pending: bot => !!(bot.__core && bot.__core.alerts.length),
  async withHands (bot, fn) {
    const st = bot.__core; if (!st || st.hands) return false
    st.hands = true
    try { await withTimeout(fn(), 8000, 'hands'); return true } catch { return false } finally { st.hands = false }
  }
}

async function install (bot) {
  uninstall(bot)
  const st = bot.__core = bot.__core || { alerts: [], bad: {}, hands: false, mods: {} }
  st.alerts = []; st.hands = false
  for (const m of load(bot)) { if (m.install) { try { await withTimeout(m.install(bot, core), 10000, 'install') } catch (e) { fail(bot, m.name, 'install', e) } } }
  st.timer = setInterval(() => {
    if (!bot.entity || bot.health <= 0) return
    for (const m of load(bot)) { if (m.onTick) { try { m.onTick(bot, core) } catch (e) { fail(bot, m.name, 'onTick', e) } } }
  }, 1000)
  if (st.timer.unref) st.timer.unref()
}
function uninstall (bot) {
  const st = bot.__core
  if (!st) return
  if (st.timer) { clearInterval(st.timer); st.timer = null }
  for (const m of load(bot)) { if (m.uninstall) { try { m.uninstall(bot, core) } catch {} } }
}
// worker calls this between job slices: highest prio alert first, each handled by the module that raised it
async function runAlerts (bot) {
  const st = bot.__core; if (!st) return 0
  let n = 0
  while (st.alerts.length && !core.cancelled(bot) && n < 5) {
    st.alerts.sort((a, b) => b.prio - a.prio)
    const alert = st.alerts.shift()
    if (Date.now() - alert.t > 30000) continue // stale
    const m = load(bot).find(x => x.name === alert.by)
    if (!m || !m.handle) continue
    n++
    if (bot.state) bot.state.task = 'core:' + alert.by + ':' + alert.kind
    try { await withTimeout(m.handle(bot, alert, core), (alert.ms || 60000) + 2000, 'handle') } catch (e) { fail(bot, m.name, 'handle', e) }
    try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch {}
  }
  return n
}
async function preJob (bot, job) {
  for (const m of load(bot)) {
    if (!m.preJob) continue
    try { const r = await withTimeout(m.preJob(bot, job, core), 125000, 'preJob'); if (r && r.ok === false) return Object.assign({ by: m.name }, r) } catch (e) { fail(bot, m.name, 'preJob', e) }
  }
  return { ok: true }
}
async function postJob (bot, job, result) {
  for (const m of load(bot)) { if (m.postJob) { try { await withTimeout(m.postJob(bot, job, result, core), 125000, 'postJob') } catch (e) { fail(bot, m.name, 'postJob', e) } } }
}
async function onDeath (bot, info) {
  for (const m of load(bot)) { if (m.onDeath) { try { await withTimeout(m.onDeath(bot, info, core), 305000, 'onDeath') } catch (e) { fail(bot, m.name, 'onDeath', e) } } }
}

module.exports = Object.assign(core, { install, uninstall, runAlerts, preJob, postJob, onDeath, ORDER, enabledNames })
