// Bot army manager: hosts many mineflayer bots in one process and exposes a localhost HTTP API to probe them.
// It gives NO orders and takes none from the game: chat is only logged (CLAUDE.md rule 7), players are never looked for, followed or fought
// (humans are spectators), and every fight reflex lives in skills/lib/army.js (startGuard). Work comes from assignments.json -> army_worker.
const http = require('http')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const pvp = require('mineflayer-pvp').plugin
const toolPlugin = require('mineflayer-tool').plugin
const { Vec3 } = require('vec3')
const path = require('path')
const swallow = require('./skills/lib/swallow')

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = +(process.env.MC_PORT || 25565)
// protocol the bots SPEAK (the server may be newer: ViaBackwards translates). ops scripts set MC_VERSION; nothing else in this file knows a version.
const VERSION = process.env.MC_VERSION || '26.1'
const SHARDS = +(process.env.SHARDS || 1)
const SHARD = +(process.env.SHARD || 0)
const API_PORT = +(process.env.API_PORT || 3001 + SHARD)
const ROSTER = (() => { try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'roster.json'), 'utf8')) } catch (e) { console.log(JSON.stringify({ type: 'roster_unreadable', error: String(e.message).slice(0, 200) })); return [] } })()
// bots are sharded over several manager processes (one Node core each): Claude_01-05 -> shard 0, 06-10 -> shard 1, ...
const PER = +(process.env.PER_SHARD || 3)
const shardOf = (name) => { const i = ROSTER.indexOf(name); return i < 0 ? 0 : Math.floor(i / PER) % SHARDS }

const bots = new Map() // name -> bot
const events = [] // ring buffer of {id, t, bot, type, ...}
let evSeq = 0
function logEvent (e) {
  e.id = Date.now() * 100 + (evSeq = (evSeq + 1) % 100)
  e.t = new Date().toISOString()
  events.push(e)
  if (events.length > 2000) events.shift()
  console.log(JSON.stringify(e))
}

function isBotName (n) { return bots.has(n) || ROSTER.includes(n) }

// ---- movement hardening ---------------------------------------------------
// See bots/patches/README.md and the "Movement" section of docs/DEV.md.
// The real fixes live in the two node_modules patches; this is defence in depth
// so a bot can never be kicked for a bad packet and can always free itself
// WITHOUT dropping its connection.
const MOVE_PACKETS = new Set(['position', 'look', 'position_look', 'flying'])

function hardenMovement (bot) {
  // 1) never let a non-finite value reach the wire: Paper kicks with
  //    "Invalid move player packet received" on the very first one.
  const rawWrite = bot._client.write.bind(bot._client)
  bot._client.write = (pktName, params) => {
    if (MOVE_PACKETS.has(pktName) && params) {
      for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) {
        const v = params[k]
        if (typeof v === 'number' && !Number.isFinite(v)) {
          logEvent({ bot: bot.username, type: 'bad_move_packet', pkt: pktName, field: k, value: String(v) })
          return // drop it
        }
      }
    }
    return rawWrite(pktName, params)
  }
  // 2) count server position corrections (rubber-banding)
  bot.__corr = []
  bot._client.on('position', () => {
    const now = Date.now()
    bot.__corr.push(now)
    if (bot.__corr.length > 64) bot.__corr.shift()
  })
  bot.on('nonFiniteRotation', (r) => logEvent({ bot: bot.username, type: 'non_finite_rotation', ...r }))
  // 3) recovery helpers available to every skill, even ones that only get `bot`.
  //    USE THESE INSTEAD OF bot.quit() — a reconnect respawns the bot on the very
  //    same spot and loses ~10s plus the whole skill state.
  bot.unwedge = (why) => unwedge(bot, why || 'skill')
  bot.swimToShore = (ms) => swimToShore(bot, ms)
  bot.correctionRate = (ms) => corrRate(bot, ms)
  bot.headUnderWater = () => headUnderWater(bot)
}

// Every Movements a skill installs gets the safety floor. Skills are free to tune
// everything else; they cannot re-enable "drop into deep water from any height".
function hookSetMovements (bot) {
  const orig = bot.pathfinder.setMovements.bind(bot.pathfinder)
  bot.pathfinder.setMovements = (mv) => { bot.mv = applyMovementSafety(mv); return orig(mv) }
}

// Drowning guard — runs for EVERY bot regardless of what its team skill is doing.
// keep_inventory is off, so a drowned bot loses everything it carried.
function startSwimGuard (bot) {
  let submerged = 0 // ticks of 250ms with the head under water
  bot.__swimTimer = setInterval(() => {
    const e = bot.entity
    if (!e || bot.__drownBusy || bot.__unwedgeBusy) return
    if (!headUnderWater(bot)) {
      if (bot.__forcedJump) { bot.__forcedJump = false; try { bot.setControlState('jump', false) } catch (e) { swallow('manager:swimJumpOff', e) } }
      submerged = 0
      return
    }
    submerged++
    // 1) always float: holding jump under water is "swim up" and is never harmful
    if (!bot.__forcedJump) { bot.__forcedJump = true; try { bot.setControlState('jump', true) } catch (e) { swallow('manager:swimJumpOn', e) } }
    // 2) still under after ~4 s -> the current plan is drowning us. Abandon it and surface.
    const lowAir = typeof bot.oxygenLevel === 'number' && bot.oxygenLevel > 0 && bot.oxygenLevel < 8
    if (submerged >= 16 || lowAir) {
      submerged = 0
      bot.__drownBusy = true
      logEvent({ bot: bot.username, type: 'drown_rescue', pos: fmtPos(e.position), oxygen: bot.oxygenLevel })
      swimToShore(bot, 30000).catch(e => swallow('manager:drownRescue', e)).finally(() => { bot.__drownBusy = false })
    }
  }, 250)
  if (bot.__swimTimer.unref) bot.__swimTimer.unref()
}

function corrRate (bot, ms = 2000) { const t = Date.now() - ms; return bot.__corr ? bot.__corr.filter(x => x > t).length : 0 }

// Is the bot's HEAD in water? (bot.entity.isInWater only looks at the feet, so a
// bot can be "in water" and breathing, or fully submerged and drowning.)
function headUnderWater (bot) {
  const e = bot.entity
  if (!e) return false
  const b = bot.blockAt(e.position.offset(0, 1.6, 0))
  return !!(b && (b.name === 'water' || b.name === 'bubble_column' || b.isWaterlogged))
}

// Safety floor applied to EVERY Movements any skill installs (see the setMovements
// hook in hardenMovement). keep_inventory is OFF, so drowning and fall damage cost
// the bot its whole inventory.
function applyMovementSafety (mv) {
  if (!mv) return mv
  if (!(mv.liquidCost >= 30)) mv.liquidCost = 30 // never plan a swim when land will do
  mv.infiniteLiquidDropdownDistance = false // do NOT plan "jump off the cliff into the pond"
  if (!(mv.maxDropDown <= 4)) mv.maxDropDown = 4 // 4 blocks = at most 1 fall damage
  return mv
}

// Nearest block a bot can stand on (solid, not ice/liquid, 2 air above).
function shoreNear (bot, maxR = 32) {
  const me = bot.entity.position.floored()
  for (let r = 1; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (let dy = -2; dy <= 4; dy++) {
          const p = me.offset(dx, dy, dz)
          const b = bot.blockAt(p)
          if (!b || b.boundingBox !== 'block') continue
          if (b.name === 'ice' || b.name === 'packed_ice' || b.name === 'blue_ice') continue
          const a1 = bot.blockAt(p.offset(0, 1, 0)); const a2 = bot.blockAt(p.offset(0, 2, 0))
          if (a1 && a1.boundingBox === 'empty' && a1.name !== 'water' && a2 && a2.boundingBox === 'empty') return p
        }
      }
    }
  }
  return null
}

// Swim/walk out of water using controls only. NEVER write bot.entity.position.
async function swimToShore (bot, ms = 25000) {
  if (!bot.entity || !bot.entity.isInWater) return true
  const end = Date.now() + ms
  const shore = shoreNear(bot, 32)
  try { bot.pathfinder.setGoal(null) } catch (e) { swallow('manager:swimGoal', e) } // whatever plan put us here is drowning us
  bot.clearControlStates()
  while (Date.now() < end && bot.entity && bot.entity.isInWater && !bot.state.cancel) {
    const p = bot.entity.position
    const t = shore || p.offset(Math.cos(Date.now() / 900) * 8, 0, Math.sin(Date.now() / 900) * 8)
    // level pitch: looking down kills swim motion; jump = swim up / climb out
    await bot.look(Math.atan2(-(t.x + 0.5 - p.x), -(t.z + 0.5 - p.z)), 0, true).catch(e => swallow('manager:swimLook', e))
    bot.setControlState('jump', true) // always float first
    // don't push sideways while fully submerged with no idea where the surface is:
    // surfacing is what stops the drowning, the swim to shore can follow.
    bot.setControlState('forward', !headUnderWater(bot) || !!shore)
    await sleep(500)
  }
  bot.clearControlStates()
  if (shore && bot.entity && !bot.entity.isInWater) {
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(shore.x, shore.y + 1, shore.z, 1)), 15000) } catch (e) { swallow('manager:shoreWalk', e) }
  }
  return !!(bot.entity && !bot.entity.isInWater)
}

// Free a bot pinned by the server position-correction loop (see patches/README.md).
// Cheap and non-destructive: stop pressing into the wall, let gravity settle, step back.
async function unwedge (bot, why = 'wedged') {
  if (bot.__unwedgeBusy) return false
  bot.__unwedgeBusy = true
  try {
    logEvent({ bot: bot.username, type: 'unwedge', why, corr: corrRate(bot), pos: fmtPos(bot.entity && bot.entity.position) })
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    await sleep(700) // corrections stop as soon as we stop pushing; gravity resumes
    if (bot.entity && bot.entity.isInWater) { await swimToShore(bot, 20000); return true }
    bot.setControlState('back', true); await sleep(450); bot.setControlState('back', false)
    await sleep(200)
    bot.setControlState('jump', true); bot.setControlState('forward', true)
    await sleep(350)
    bot.clearControlStates()
    return true
  } catch (e) { swallow('manager:unwedge', e); return false } finally { bot.__unwedgeBusy = false }
}

// Per-bot watchdog. Deliberately strict: with the physics patch in place this
// should essentially never fire, so if it does it is a real wedge.
function startMovementWatchdog (bot) {
  let mark = null
  bot.__mvTimer = setInterval(() => {
    const e = bot.entity
    if (!e || bot.__unwedgeBusy || bot.state.cancel) return
    const now = Date.now()
    if (!mark || e.position.distanceTo(mark.pos) > 0.6) { mark = { pos: e.position.clone(), t: now }; return }
    const stillFor = now - mark.t
    const rate = corrRate(bot, 2000)
    const busy = bot.pathfinder.goal || e.isInWater
    if (!busy) return
    if (now - (bot.__lastUnwedge || 0) < 20000) return
    // rubber-band loop: server is correcting us >=15x/2s while we go nowhere
    // or: stuck in water for >25s without moving
    if ((rate >= 15 && stillFor > 3000) || (e.isInWater && stillFor > 25000)) {
      bot.__lastUnwedge = now
      mark = { pos: e.position.clone(), t: now }
      unwedge(bot, rate >= 15 ? 'rubber-band' : 'stuck-in-water')
    }
  }, 1000)
  if (bot.__mvTimer.unref) bot.__mvTimer.unref()
}

function spawnBot (name) {
  if (bots.has(name)) return bots.get(name)
  // bots ask for a SHORT view (8 chunks = 128 blocks: enough for every job) so that the server's larger view-distance (16, for the human spectators)
  // costs chunk sending and node memory only for humans (09-20: 62 players online, MSPT 41 of 50 ms)
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, version: VERSION, auth: 'offline', viewDistance: +(process.env.BOT_VIEW || 8) })
  bot.state = { task: 'idle', reconnect: true }
  bots.set(name, bot)
  hardenMovement(bot)
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)
  bot.loadPlugin(pvp)
  bot.loadPlugin(toolPlugin)

  bot.once('spawn', () => {
    const mv = new Movements(bot)
    mv.allowSprinting = true
    mv.canOpenDoors = true
    // Sane travel defaults (skills that need something else build their own Movements):
    mv.digCost = 8 // stay on the surface; tunnelling is an order of magnitude slower
    mv.placeCost = 2
    mv.dontCreateFlow = true
    applyMovementSafety(mv) // liquidCost / no dropping into deep water / drop height
    hookSetMovements(bot) // …and enforce the same floor on whatever a skill installs later
    // TERRAIN GUARD (block-work engineer, commander order 19:10): on the surface the pathfinder may neither place
    // scaffolding nor dig, whatever Movements a skill installs. Policy + opt-out: skills/lib/terrain_guard.js.
    try { bot.__logEvent = logEvent; require('./skills/lib/terrain_guard.js').install(bot) } catch (e) { logEvent({ bot: name, type: 'terrain_guard', ev: 'install_failed', error: String(e && e.message).slice(0, 200) }) }
    bot.pathfinder.setMovements(mv)
    // pathfinder computes synchronously inside the physics tick; cap it so N bots per process never starve the 50ms tick
    bot.pathfinder.tickTimeout = 12
    bot.pathfinder.thinkTimeout = 8000
    bot.mv = mv
    startMovementWatchdog(bot)
    startSwimGuard(bot)
    logEvent({ bot: name, type: 'spawn', pos: fmtPos(bot.entity.position) })
    setTimeout(() => autoAssign(bot), 3000)
  })

  // Chat is LOGGED, never obeyed (rule 7: orders come from the terminal only; names can be spoofed on an offline-mode server).
  // The "leader" bot (first spawned of shard 0) relays it so events aren't duplicated N times.
  bot.on('chat', (username, message) => {
    if (isBotName(username)) return
    if (SHARD === 0 && firstAliveBot() === bot) logEvent({ bot: name, type: 'chat', from: username, message })
  })
  bot.on('death', () => logEvent({ bot: name, type: 'death' }))
  bot.on('kicked', (reason) => logEvent({ bot: name, type: 'kicked', reason: JSON.stringify(reason).slice(0, 300) }))
  bot.on('error', (err) => logEvent({ bot: name, type: 'error', error: String(err).slice(0, 300) }))
  bot.on('end', (reason) => {
    if (bot.__mvTimer) { clearInterval(bot.__mvTimer); bot.__mvTimer = null }
    if (bot.__swimTimer) { clearInterval(bot.__swimTimer); bot.__swimTimer = null }
    logEvent({ bot: name, type: 'end', reason })
    const again = bot.state.reconnect
    bots.delete(name)
    if (again) setTimeout(() => spawnBot(name), 5000 + Math.random() * 5000)
  })

  // Housekeeping: eat when hungry — only for a bot WITHOUT a role skill (army_worker eats by the PLAYBOOK rule and fights with army.js startGuard).
  let busyEating = false
  bot.on('physicsTick', () => {
    if (!bot.entity || bot.time.age % 20 !== 0) return
    // a role skill that manages the hands itself (army_worker: eats between job slices) sets bot.state.skillEats — two eaters
    // fight over the main hand: the rod/tool gets unequipped mid-use and consume() is interrupted, so neither works.
    if (bot.food < 15 && !busyEating && !bot.state.skillEats) {
      const food = bot.inventory.items().find(i => bot.registry.foodsByName[i.name] && i.name !== 'rotten_flesh' && i.name !== 'spider_eye')
      if (food) {
        busyEating = true
        bot.equip(food, 'hand').then(() => bot.consume()).catch(e => swallow('manager:autoEat', e)).finally(() => { busyEating = false })
      }
    }
  })
  return bot
}

function firstAliveBot () { for (const b of bots.values()) if (b.entity) return b; return null }
function fmtPos (p) { return p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null }

// ---- actions -------------------------------------------------------------
const actions = {
  async stop (bot) {
    bot.state.task = 'idle'; bot.state.cancel = true
    bot.pathfinder.setGoal(null); bot.pvp.stop()
    try { bot.collectBlock.cancelTask() } catch (e) { swallow('manager:stopCollect', e) }
    bot.clearControlStates()
    return 'stopped'
  },
  async goto (bot, { x, y, z, range = 1 }) {
    bot.state.task = `goto ${x} ${y} ${z}`
    const goal = (y === undefined || y === null) ? new goals.GoalNearXZ(x, z, range) : new goals.GoalNear(x, y, z, range)
    await bot.pathfinder.goto(goal)
    bot.state.task = 'idle'
    return 'arrived'
  },
  async say (bot, { message }) { bot.chat(String(message).slice(0, 250)); return 'ok' },
  async equip (bot, { item, destination = 'hand' }) {
    const it = bot.inventory.items().find(i => i.name === item)
    if (!it) throw new Error(`no ${item}`)
    await bot.equip(it, destination); return 'equipped'
  },
  // Movement recovery. Prefer these over dropping the connection.
  async escape_water (bot, { timeout = 25000 } = {}) { return (await swimToShore(bot, timeout)) ? 'out of water' : 'still in water' },
  async unwedge (bot) { await unwedge(bot, 'manual'); return 'unwedged' },
  async movement_debug (bot) {
    return {
      pos: fmtPos(bot.entity && bot.entity.position),
      onGround: bot.entity && bot.entity.onGround,
      inWater: bot.entity && bot.entity.isInWater,
      vel: bot.entity && bot.entity.velocity,
      correctionsPerSec: +(corrRate(bot, 2000) / 2).toFixed(1), // >5 means the bot is wedged
      halfWidth: bot.physics && bot.physics.playerHalfWidth, // must be 0.30000011192092896 (patched)
      goal: !!bot.pathfinder.goal,
      controls: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].filter(c => bot.getControlState(c))
    }
  },
  // Escape hatch for the LLM operators: run arbitrary async JS against a bot.
  async eval (bot, { code, timeout = 60000 }) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const fn = new AsyncFunction('bot', 'bots', 'goals', 'Vec3', 'actions', 'sleep', 'require', code)
    const res = await Promise.race([
      fn(bot, bots, goals, Vec3, actions, sleep, require),
      sleep(timeout).then(() => { throw new Error('eval timeout') })
    ])
    return res === undefined ? null : res
  }
}
// ctx is handed to skills. Skills must poll bot.state.cancel in loops and bail out when true.
const ctx = {
  bots,
  goals,
  Vec3,
  actions,
  logEvent,
  Movements,
  withTimeout,
  // movement recovery — use these INSTEAD of bot.quit()/forced reconnects
  swimToShore,
  unwedge,
  shoreNear,
  corrRate,
  get sleep () { return sleep }
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function botStatus (bot) {
  if (!bot.entity) return { name: bot.username, online: false }
  return {
    name: bot.username,
    online: true,
    pos: fmtPos(bot.entity.position),
    dim: bot.game?.dimension,
    hp: bot.health,
    food: bot.food,
    task: bot.state.task,
    held: bot.heldItem?.name || null,
    inv: Object.fromEntries(Object.entries(bot.inventory.items().reduce((m, i) => { m[i.name] = (m[i.name] || 0) + i.count; return m }, {})))
  }
}

function selectBots (sel) {
  if (!sel || sel === 'all') return [...bots.values()]
  const names = Array.isArray(sel) ? sel : String(sel).split(',')
  return names.map(n => bots.get(n)).filter(Boolean)
}

function runSkill (b, skill, args) {
  const dir = path.join(__dirname, 'skills')
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k]
  b.state.task = `skill:${skill}`
  b.state.cancel = false
  return Promise.resolve().then(() => require(path.join(dir, skill + '.js'))(b, args, ctx)).then(r => ({ bot: b.username, ok: true, result: r === undefined ? null : r }))
    .catch(e => ({ bot: b.username, ok: false, error: String(e.stack || e).slice(0, 500) }))
    .then(r => { if (b.state.task === `skill:${skill}`) b.state.task = 'idle'; logEvent({ bot: r.bot, type: 'skill_done', skill, ok: r.ok, result: r.ok ? r.result : r.error }); return r })
}
// assignments.json: {"Claude_01": {"skill": "name", "args": {...}}} -> (re)started automatically whenever that bot spawns.
function autoAssign (b) {
  try {
    const a = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'assignments.json'), 'utf8'))[b.username]
    if (a && a.skill) runSkill(b, a.skill, a.args || {})
  } catch (e) { logEvent({ bot: b.username, type: 'assign_failed', error: String(e.message).slice(0, 200) }) } // an unreadable assignments.json = a bot that never starts working
}

// ---- HTTP API ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let body = ''
  for await (const c of req) body += c
  let json = {}
  try { json = body ? JSON.parse(body) : {} } catch { return send(res, 400, { error: 'bad json' }) }
  try {
    if (url.pathname === '/status') {
      const sel = url.searchParams.get('bots')
      const brief = url.searchParams.get('brief')
      let out = selectBots(sel).map(botStatus)
      if (brief) out = out.map(({ inv, ...r }) => r)
      return send(res, 200, out)
    }
    if (url.pathname === '/events') {
      const since = +(url.searchParams.get('since') || 0)
      const type = url.searchParams.get('type')
      return send(res, 200, events.filter(e => e.id > since && (!type || type.split(',').includes(e.type))))
    }
    if (url.pathname === '/players') {
      const b = firstAliveBot()
      if (!b) return send(res, 200, [])
      return send(res, 200, Object.values(b.players).map(p => ({ name: p.username, isBot: isBotName(p.username), pos: fmtPos(p.entity?.position), ping: p.ping })))
    }
    if (url.pathname === '/spawn') {
      const names = json.names || Array.from({ length: json.count || 1 }, (_, i) => `${json.prefix || 'Bot'}_${String(i + 1 + (json.offset || 0)).padStart(2, '0')}`)
      names.filter(n => shardOf(n) === SHARD).forEach((n, i) => setTimeout(() => spawnBot(n), i * (json.interval || 700)))
      return send(res, 200, { spawning: names })
    }
    if (url.pathname === '/despawn') {
      const list = selectBots(json.bots)
      list.forEach(b => { b.state.reconnect = false; b.quit() })
      return send(res, 200, { quit: list.map(b => b.username) })
    }
    if (url.pathname === '/cmd') {
      // {bots, action, args, wait}  wait=false -> fire and forget
      const list = selectBots(json.bots)
      const act = actions[json.action]
      if (!act) return send(res, 400, { error: 'unknown action', actions: Object.keys(actions) })
      const run = (b) => act(b, json.args || {}).then(r => ({ bot: b.username, ok: true, result: r }))
        .catch(e => ({ bot: b.username, ok: false, error: String(e.message || e).slice(0, 300) }))
      if (json.wait === false) {
        list.forEach(b => run(b).then(r => { if (!r.ok) logEvent({ bot: r.bot, type: 'cmd_error', cmd: json.action, error: r.error }) }))
        return send(res, 200, { started: list.map(b => b.username) })
      }
      return send(res, 200, await Promise.all(list.map(run)))
    }
    if (url.pathname === '/skill') {
      // {bots, skill, args, wait} -> runs skills/<skill>.js (hot reloaded): module.exports = async (bot, args, ctx) => result
      const list = selectBots(json.bots)
      const run = (b) => runSkill(b, json.skill, json.args || {})
      if (json.wait) return send(res, 200, await Promise.all(list.map(run)))
      list.forEach(run)
      return send(res, 200, { started: list.map(b => b.username) })
    }
    send(res, 404, { error: 'not found', endpoints: ['/status', '/events', '/players', '/spawn', '/despawn', '/cmd', '/skill'] })
  } catch (e) { send(res, 500, { error: String(e.stack || e) }) }
})
function send (res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
server.listen(API_PORT, '127.0.0.1', () => {
  console.log(`bot manager shard ${SHARD}/${SHARDS} API on 127.0.0.1:${API_PORT}`)
  try {
    const roster = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'roster.json'), 'utf8'))
    roster.filter(n => shardOf(n) === SHARD).forEach((n, i) => setTimeout(() => spawnBot(n), i * 700))
  } catch (e) { logEvent({ type: 'roster_unreadable', error: String(e.message).slice(0, 200) }) }
})

// Event-loop stall detector. The API "hangs for >10s" when one shard's loop is
// blocked by synchronous work in a skill (giant findBlocks, long sync loops, a
// single huge A*). Logs WHICH bots/tasks were running at the time so the stall
// can be pinned on a team's skill. Cheap: one 200ms timer per process.
let __loopMark = Date.now()
const __loopTimer = setInterval(() => {
  const now = Date.now()
  const lag = now - __loopMark - 200
  __loopMark = now
  if (lag > 700) {
    logEvent({ type: 'loop_stall', ms: lag, shard: SHARD, tasks: Object.fromEntries([...bots.values()].map(b => [b.username, b.state.task])) })
  }
}, 200)
if (__loopTimer.unref) __loopTimer.unref()

process.on('uncaughtException', e => logEvent({ type: 'uncaught', error: String(e.stack || e).slice(0, 500) }))
process.on('unhandledRejection', e => logEvent({ type: 'unhandled', error: String(e && (e.stack || e)).slice(0, 500) }))
function withTimeout (p, ms) { return Promise.race([p, sleep(ms).then(() => { throw new Error('timeout') })]) }
