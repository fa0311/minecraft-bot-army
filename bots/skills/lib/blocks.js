// blocks.js — THE shared block-work library (place / dig / pillar / bridge / farm / torch / tree).
// Owner: BLOCK-WORK ENGINEER (teams/inbox_blockwork.md). DIRECTIVE "REVIEW GATE": no own place/dig primitives.
//
// Design rules (each one is there because the old helpers measurably violated it — see docs/DEV.md "Block work"):
//   * act like a player: only click a face you can SEE, within 4.5 blocks of the eye, looking at it;
//     sneak when the clicked block is interactable (chest/table/furnace...), stand still + on the ground to dig
//     (airborne digging is 5x slower), right tool in hand or refuse (a stick on stone = 7.5 s and no drop).
//   * every result is SERVER-CONFIRMED (blockUpdate for places, dig ack + re-check for digs) and every
//     failure returns { ok:false, reason } — never throws except on cancel (err.cancelled === true).
//   * every await has a timeout; every loop polls bot.state.cancel.
//   * per-position FILE locks (bots/.blocklocks) so bots in different manager processes never fight over a block.
//   * scaffolding is written to a per-bot ledger file BEFORE it is placed, and removed by removeScaffold() /
//     withScaffold() even after a crash or a cancel.
//   * the pathfinder never edits terrain for us on the surface (lib/terrain_guard.js); safeMovements() presets.
//
// API (all async unless noted):
//   placeBlock(bot, pos, itemName, opts)  -> { ok, reason?, already?, ms, tries }
//   digBlock(bot, pos, opts)              -> { ok, reason?, ms, tool, expectedMs }
//   buildCells(bot, cells, opts)          -> { placed, already, failed:[{pos,reason}], ms }   cells=[{pos,name}]
//   clearAndFill(bot, box, fillName|null, opts)
//   pillarUp(bot, n, opts) / pillarDown(bot, n, opts) / removeScaffold(bot) / withScaffold(bot, fn)
//   bridge(bot, dir, len, itemName, opts)
//   tillAndPlant(bot, pos, seedName, opts) / placeTorch(bot, pos, opts)
//   harvestTree(bot, logPos, opts)        -> { ok, logs, left, replanted }
//   collectDrops(bot, center, opts)
//   safeMovements(bot, mode)              mode = 'surface' | 'zone' | 'wild' | 'underground'
//   stats(bot)                            sync: counters for benchmarks
const fs = require('fs')
const swallow = require('./swallow')
const blind = swallow.blind // loud swallow: "I was about to place/dig/step/judge a cell done while blind" -> `blind_action` event, once per signature per 5 min
const path = require('path')
const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')

const BOTS_DIR = path.join(__dirname, '..', '..')
const LOCK_DIR = path.join(BOTS_DIR, '.blocklocks')
const SCAF_DIR = path.join(BOTS_DIR, '.scaffold')
const REACH = 4.5
const EYE = 1.62

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
class Cancelled extends Error { constructor (m = 'cancelled') { super(m); this.cancelled = true } }
function ck (bot) {
  if (!bot || !bot.entity) throw new Cancelled('no entity')
  if (bot.state && bot.state.cancel) throw new Cancelled()
}
function withTimeout (p, ms, label = 'op') {
  let t
  return Promise.race([
    Promise.resolve(p).then(v => { clearTimeout(t); return v }, e => { clearTimeout(t); throw e }),
    new Promise((resolve, reject) => { t = setTimeout(() => reject(new Error('timeout:' + label)), ms) })
  ])
}
const V = (p) => (p instanceof Vec3 ? p : new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
const key = (p) => p.x + ',' + p.y + ',' + p.z

// ---------------------------------------------------------------- stats
function S (bot) {
  if (!bot.__blk) bot.__blk = { place: { calls: 0, ok: 0, already: 0, packets: 0, rejected: 0, fail: {} }, dig: { calls: 0, ok: 0, rejected: 0, fail: {}, ms: 0, expMs: 0 }, moves: 0, moveMs: 0 }
  return bot.__blk
}
function stats (bot) { return JSON.parse(JSON.stringify(S(bot))) }
function resetStats (bot) { delete bot.__blk; return S(bot) }
function failP (bot, reason, t0, extra) { const s = S(bot).place; s.fail[reason] = (s.fail[reason] || 0) + 1; return Object.assign({ ok: false, reason, ms: Date.now() - t0 }, extra) }
function failD (bot, reason, t0, extra) { const s = S(bot).dig; s.fail[reason] = (s.fail[reason] || 0) + 1; return Object.assign({ ok: false, reason, ms: Date.now() - t0 }, extra) }

// ---------------------------------------------------------------- block classes
const INTERACTABLE = /^(chest|trapped_chest|ender_chest|barrel|furnace|blast_furnace|smoker|crafting_table|anvil|chipped_anvil|damaged_anvil|brewing_stand|enchanting_table|beacon|hopper|dispenser|dropper|lever|repeater|comparator|note_block|jukebox|loom|smithing_table|stonecutter|grindstone|cartography_table|lectern|bell|daylight_detector|respawn_anchor|composter|cauldron|crafter|.*_bed|.*_door|.*_trapdoor|.*_fence_gate|.*_button|.*_shulker_box|shulker_box|.*_sign|.*_hanging_sign|cake|flower_pot|potted_.*|campfire|soul_campfire|decorated_pot|chiseled_bookshelf|dragon_egg)$/
const PROTECTED = /^(chest|trapped_chest|ender_chest|barrel|furnace|blast_furnace|smoker|crafting_table|anvil|chipped_anvil|damaged_anvil|brewing_stand|enchanting_table|bookshelf|beacon|lodestone|hopper|dispenser|dropper|observer|note_block|jukebox|cauldron|composter|loom|smithing_table|stonecutter|grindstone|cartography_table|fletching_table|lectern|bell|conduit|respawn_anchor|spawner|end_portal_frame|end_portal|nether_portal|lantern|soul_lantern|campfire|soul_campfire|farmland|.*_bed|.*_door|.*_sign|.*_hanging_sign|.*_banner|.*shulker_box|.*_fence|.*_fence_gate|.*_wall|glass|.*_glass|.*_glass_pane|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|ladder|rail|powered_rail|.*_carpet|.*_wool)$/
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding)$/
const FILLER = ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff']
const HAZARD_STAND = /^(magma_block|cactus|campfire|soul_campfire|fire|soul_fire|sweet_berry_bush|wither_rose|powder_snow|lava|pointed_dripstone)$/
const SOIL = /^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt|mycelium|moss_block|mud|muddy_mangrove_roots|farmland)$/
const TILLABLE = /^(dirt|grass_block|dirt_path)$/
const LIQ = /^(water|lava|bubble_column)$/

// ---------------------------------------------------------------- UNKNOWN IS AN ANSWER (owner 09-21, two lava deaths in the Nether)
// `bot.blockAt()` returns NULL for a cell whose chunk is not loaded. The old code read that null as "air": a cell that is not there
// was taken for an empty cell, so a job placed floor at the rim of a cavern it could not see and the bot walked over the edge
// (46 iron + 7 diamonds in six minutes). A cell we cannot see is not empty — it is UNSEEN.
//   THE RULE: an unknown cell is never passable, never done, never safe, never a valid place or dig target.
// readAt(bot, pos) -> { known, block, name, pos } is the one reader; the predicates below take a block, a null, or a read, so a
// caller can adopt them one line at a time. `blind(bot, where, why)` (lib/swallow.js) is how a blind cell gets SEEN by us.
function readAt (bot, pos) {
  const p = V(pos && pos.position ? pos.position : pos)
  let b = null
  try { b = bot.blockAt(p) } catch (e_) { swallow('blocks:readAt', e_); b = null }
  return b ? { known: true, block: b, name: b.name, pos: p } : { known: false, block: null, name: null, pos: p }
}
// a read, a block or a null -> the block or null
function blockOf (x) { return (x && typeof x.known === 'boolean') ? x.block : (x || null) }
function isUnknown (x) { return !blockOf(x) }
function isAir (x) { const b = blockOf(x); return !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') } // UNKNOWN IS NOT AIR
function isLiquid (x) { const b = blockOf(x); return !!b && LIQ.test(b.name) }
// can a new block be put here without breaking anything first?  unknown -> NO
function isReplaceable (x) {
  const b = blockOf(x)
  if (!b) return false
  if (isAir(b) || isLiquid(b)) return true
  if (b.boundingBox !== 'empty') return false
  return /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|seagrass|tall_seagrass|vine|glow_lichen|fire|soul_fire|light|structure_void|crimson_roots|warped_roots|nether_sprouts|hanging_roots)$/.test(b.name)
}
function isSolidRef (x) { const b = blockOf(x); return !!b && !isAir(b) && !isLiquid(b) && b.boundingBox === 'block' }
const isSolid = isSolidRef
// SNOW LAYERS are walkable ground cover, not walls: minecraft-data gives 'snow' a block bounding box, so in a snowy biome (world 1) NO cell next to
// a tree counted as standable and every trunk was "unreachable" in 8 ms (09-19). Thin snow (<= 3 layers) is passable, like a player sees it.
function thinSnow (b) { if (!b || b.name !== 'snow') return false; try { const l = b.getProperties().layers; return l == null || +l <= 3 } catch (e) { return true } } // no `layers` property = one layer
// UNKNOWN IS NEVER PASSABLE (see readAt above): a cell whose chunk is not loaded may be rock, a cavern or lava.
function isPassable (x) { const b = blockOf(x); return !b ? false : ((b.boundingBox === 'empty' || thinSnow(b)) && !isLiquid(b) && !HAZARD_STAND.test(b.name)) }

// ---------------------------------------------------------------- file locks (cross-process)
let lockDirOk = false
function lockFile (p) { return path.join(LOCK_DIR, p.x + '_' + p.y + '_' + p.z) }
function acquire (bot, p, ttl = 15000) {
  if (!lockDirOk) { try { fs.mkdirSync(LOCK_DIR, { recursive: true }) } catch (e_) { /* another shard created it a moment ago; if it is really unwritable the openSync below fails open, by design (see `fs trouble must never stop work`) */ } lockDirOk = true }
  const f = lockFile(p)
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(f, 'wx')
      fs.writeSync(fd, bot.username + ' ' + (Date.now() + ttl))
      fs.closeSync(fd)
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') return true // fs trouble must never stop work
      try {
        const [who, exp] = fs.readFileSync(f, 'utf8').split(' ')
        if (who === bot.username) { fs.writeFileSync(f, bot.username + ' ' + (Date.now() + ttl)); return true }
        if (+exp > Date.now()) return false
        fs.unlinkSync(f) // stale -> steal
      } catch { /* vanished meanwhile -> retry */ }
    }
  }
  return false
}
function release (bot, p) {
  const f = lockFile(p)
  try { if (fs.readFileSync(f, 'utf8').split(' ')[0] === bot.username) fs.unlinkSync(f) } catch (e_) { /* the lock expired and another bot stole it: it is no longer ours to release */ }
}

// ---------------------------------------------------------------- geometry: what can the bot see / reach?
function eyeAt (feetPos) { return feetPos.offset(0, EYE, 0) }
function eyeOf (bot) { return eyeAt(bot.entity.position) }

const FACES = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]
const FACE_PTS = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]]
function facePoint (blockPos, face, u, v) {
  // u,v in 0..1 across the face
  if (face.y !== 0) return new Vec3(blockPos.x + u, blockPos.y + (face.y > 0 ? 1 : 0), blockPos.z + v)
  if (face.x !== 0) return new Vec3(blockPos.x + (face.x > 0 ? 1 : 0), blockPos.y + v, blockPos.z + u)
  return new Vec3(blockPos.x + u, blockPos.y + v, blockPos.z + (face.z > 0 ? 1 : 0))
}
// A point on `face` of the block at blockPos that an eye at `eye` can see and reach — or null.
function visiblePoint (bot, eye, blockPos, face, opts = {}) {
  const reach = opts.reach || REACH
  const c = facePoint(blockPos, face, 0.5, 0.5)
  // the face must be turned towards the eye
  if ((eye.x - c.x) * face.x + (eye.y - c.y) * face.y + (eye.z - c.z) * face.z < 0.02) return null
  if (eye.distanceTo(c) > reach + 0.75) return null
  const pts = opts.half && face.y === 0
    ? (opts.half === 'top' ? [[0.5, 0.75], [0.25, 0.8], [0.75, 0.8]] : [[0.5, 0.25], [0.25, 0.2], [0.75, 0.2]])
    : FACE_PTS
  for (const [u, v] of pts) {
    const pt = facePoint(blockPos, face, u, v)
    const d = eye.distanceTo(pt)
    if (d > reach) continue
    const dir = pt.minus(eye).normalize()
    let hit = null
    try { hit = bot.world.raycast(eye, dir, d + 0.35) } catch { hit = null }
    if (!hit) { if (opts.shapeless) return pt; continue }
    if (hit.position.x === blockPos.x && hit.position.y === blockPos.y && hit.position.z === blockPos.z) return pt
    if (opts.shapeless && hit.intersect && eye.distanceTo(hit.intersect) >= d - 0.05) return pt
    if (opts.blockers) opts.blockers.push(hit)
  }
  return null
}
// any visible face of a block (for digging). Returns {face, point} or null
function visibleFaceOf (bot, eye, block, opts = {}) {
  const shapeless = !block.shapes || block.shapes.length === 0
  if (shapeless) { // grass, crops, torches...: aim at the cell centre, nothing may be in front of it
    const c = block.position.offset(0.5, 0.4, 0.5)
    const d = eye.distanceTo(c)
    if (d > (opts.reach || REACH)) return null
    let hit = null
    try { hit = bot.world.raycast(eye, c.minus(eye).normalize(), d) } catch (e_) { swallow('blocks:159', e_) }
    if (!hit || (hit.intersect && eye.distanceTo(hit.intersect) >= d - 0.3) || hit.position.equals(block.position)) return { face: FACES[0], point: c }
    if (opts.blockers) opts.blockers.push(hit)
    return null
  }
  for (const face of FACES) {
    const pt = visiblePoint(bot, eye, block.position, face, opts)
    if (pt) return { face, point: pt }
  }
  return null
}

function standable (bot, cell) {
  const below = bot.blockAt(cell.offset(0, -1, 0))
  if (!below || below.boundingBox !== 'block' || HAZARD_STAND.test(below.name) || isLiquid(below)) return false
  return isPassable(bot.blockAt(cell)) && isPassable(bot.blockAt(cell.offset(0, 1, 0)))
}
// would a player standing in the middle of `cell` overlap the block cell `p`?
function bodyHits (cell, p) { return cell.x === p.x && cell.z === p.z && (cell.y === p.y || cell.y + 1 === p.y) }
function botOverlaps (bot, p) {
  const e = bot.entity.position
  return e.x + 0.3 > p.x && e.x - 0.3 < p.x + 1 && e.z + 0.3 > p.z && e.z - 0.3 < p.z + 1 && e.y + 1.8 > p.y && e.y < p.y + 1
}

// Cells to stand in (nearest to the bot first) from which test(eye) is truthy.
function findStands (bot, target, test, opts = {}) {
  const r = opts.radius || 4
  const me = bot.entity.position
  const cands = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -4; dy <= 3; dy++) {
        const cell = new Vec3(target.x + dx, target.y + dy, target.z + dz)
        if (opts.solidTarget && bodyHits(cell, target)) continue
        const c = cell.offset(0.5, 0, 0.5)
        if (eyeAt(c).distanceTo(target.offset(0.5, 0.5, 0.5)) > REACH + 1) continue
        cands.push({ cell, d: c.distanceTo(me) + Math.abs(cell.y - me.y) * 0.75 })
      }
    }
  }
  cands.sort((a, b) => a.d - b.d)
  // THE STAND IS CHOSEN FOR WHAT CAN BE SEEN AND WALKED TO, NOT FOR BEING NEAR (foreman 09-20 07:20Z, probes of Yuzu/Yotsuba: the 3 nearest stands were all tree crowns -
  // `noPath` x3 in < 1 s was reported as `no_los`, 280 per builder-hour; and a face seen from the CENTRE of a rim cell is often hidden from where the bot stops in it):
  //   * a stand ON LEAVES costs +8 (a crown is rarely walkable), opts.rank(cell) adds the caller's own preference (placing: the rim above a hole before the hole)
  //   * opts.lean: when the centre eye sees nothing, the eye 0.35 towards the target (the rim's edge - the floor of a 2-deep pit shows only from there) is tested too;
  //     the cell then carries `.lean = [dx, dz]` and the caller walks to that point of the cell (centreOn), sneaking, before it aims again.
  if (opts.rank || opts.leaves !== false) { for (const c of cands) { const u = bot.blockAt(c.cell.offset(0, -1, 0)); c.d += (u && /_leaves$/.test(u.name) ? 8 : 0) + (opts.rank ? opts.rank(c.cell) || 0 : 0) } cands.sort((a, b) => a.d - b.d) }
  const out = []
  for (const c of cands) {
    if (opts.avoid && opts.avoid(c.cell)) continue
    if (!standable(bot, c.cell)) continue
    let ok = test(eyeAt(c.cell.offset(0.5, 0, 0.5)))
    if (!ok && opts.lean) {
      const sx = Math.sign(target.x - c.cell.x); const sz = Math.sign(target.z - c.cell.z)
      for (const [ox, oz] of [[sx, sz], [sx, 0], [0, sz]]) { if ((!ox && !oz) || ok) continue; if (test(eyeAt(c.cell.offset(0.5 + ox * 0.35, 0, 0.5 + oz * 0.35)))) { ok = true; c.cell.lean = [ox * 0.35, oz * 0.35] } }
    }
    if (!ok) continue
    out.push(c.cell)
    if (out.length >= (opts.max || 3)) break
  }
  return out
}

// ---------------------------------------------------------------- movement helpers
async function settle (bot, ms = 1200) {
  try { if (bot.pathfinder && bot.pathfinder.isMoving()) bot.pathfinder.setGoal(null) } catch (e_) { swallow('blocks:213', e_) }
  for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) { try { if (bot.getControlState(c)) bot.setControlState(c, false) } catch (e_) { swallow('blocks:214', e_) } }
  const end = Date.now() + ms
  while (!bot.entity.onGround && Date.now() < end) { ck(bot); await sleep(50) }
  return bot.entity.onGround
}
// ARRIVED = in the stand's column with the feet within 1/16 BELOW its y: a stand on FARMLAND (15/16 tall; soul sand, dirt path alike) has the feet at y-0.0625, and
// GoalBlock (floored feet) never ends there. MEASURED 09-21 18:4xZ: every cap over a field water cell failed `put:unreachable` for 3 h (base_field_2/4 paused) -
// all its stands are farmland; Honoka stood IN the stand at 68.94, the stuck timer fired and moveTo said "not reached".
function arrivedAt (bot, cell) { const p = bot.entity.position; return Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && p.y >= cell.y - 0.07 && p.y < cell.y + 0.5 }
// goto THAT WAITS FOR THE REAL OUTCOME. pathfinder's own goto resolves on ANY path_update whose path is empty - also the PARTIAL result of the first 12 ms planning
// tick (our movements expand ~3-6 nodes/ms, so a stand behind a field edge often has an empty best-so-far): "I have not planned yet" came back as "arrived".
// Here: resolved only by goal_reached; rejected by a final noPath/timeout, a goal change, a stop, or `ms`. A partial update just lets the pathfinder go on.
function gotoStrict (bot, goal, ms) {
  return new Promise((resolve, reject) => {
    let t = null
    const done = (err) => { clearTimeout(t); bot.removeListener('goal_reached', onOk); bot.removeListener('path_update', onUpd); bot.removeListener('goal_updated', onChg); bot.removeListener('path_stop', onStop); if (err) reject(err); else resolve() }
    const onOk = () => done(); const onStop = () => done(new Error('path stopped'))
    const onUpd = (r) => { if (r && (r.status === 'noPath' || r.status === 'timeout')) done(new Error(r.status)) }
    const onChg = (g) => { if (g !== goal) done(new Error('goal changed')) }
    bot.on('goal_reached', onOk); bot.on('path_update', onUpd); bot.on('path_stop', onStop)
    t = setTimeout(() => done(new Error('timeout:moveTo')), ms)
    try { bot.pathfinder.setGoal(goal) } catch (e) { done(e); return }
    bot.on('goal_updated', onChg) // after our own setGoal: its goal_updated is ours
  })
}
async function moveTo (bot, cell, ms = 12000) {
  ck(bot)
  const st = S(bot); st.moves++
  const t0 = Date.now()
  let last = bot.entity.position.clone(); let lastT = Date.now(); let stuck = false
  const timer = setInterval(() => {
    try {
      if (!bot.entity) return
      if (bot.state && bot.state.cancel) { bot.pathfinder.setGoal(null); return }
      if (arrivedAt(bot, cell) && bot.entity.onGround) { bot.pathfinder.setGoal(null); return }
      const p = bot.entity.position
      if (p.distanceTo(last) > 0.4) { last = p.clone(); lastT = Date.now(); return }
      if (Date.now() - lastT > 4000 && !bot.targetDigBlock) { stuck = true; bot.pathfinder.setGoal(null) }
    } catch (e_) { swallow('blocks:231', e_) }
  }, 500)
  // A STAND ON FARMLAND (the cap over a field's water cell has ONLY farmland stands): `farmland` is in blocksToAvoid (safeMovements: no route across a field)
  // and a body on farmland has its feet IN that cell, so the pathfinder never entered the plot - 3 h of `put:unreachable` on base_field_2/4 (09-21 18:5xZ,
  // Erika: 6 stands, 0 reached, 311 ms). For this one short walk to that one stand the veto is lifted (walking does not trample; the fieldCost weight stays).
  const mv = bot.pathfinder.movements; const fl = bot.registry.blocksByName.farmland; const below = bot.blockAt(cell.offset(0, -1, 0)); const inCell = bot.blockAt(cell)
  const lift = !!(mv && fl && mv.blocksToAvoid && mv.blocksToAvoid.has(fl.id) && ((below && below.type === fl.id) || (inCell && inCell.type === fl.id)))
  if (lift) mv.blocksToAvoid.delete(fl.id)
  try {
    await gotoStrict(bot, new goals.GoalBlock(cell.x, cell.y, cell.z), ms)
    // pathfinder's goto RESOLVES when the planner returns an EMPTY path (lib/goto.js checks `path.length === 0` before `noPath`): "no path at all" came back as
    // success - MEASURED 09-21 19:2xZ, Mashiro in base_field_4: 3 stands "reached" in 37-68 ms from 22 blocks away, then `no_los` on all 17 caps. Arrival is checked.
    return arrivedAt(bot, cell) || bot.entity.position.distanceTo(cell.offset(0.5, 0, 0.5)) < 0.9
  } catch (e) {
    bot.__moveErr = String(e && e.message).slice(0, 60) // why: probe-readable
    try { bot.pathfinder.setGoal(null) } catch (e_) { swallow('blocks:237', e_) }
    ck(bot)
    return arrivedAt(bot, cell) || (bot.entity.position.distanceTo(cell.offset(0.5, 0, 0.5)) < 0.9 && !stuck)
  } finally { clearInterval(timer); st.moveMs += Date.now() - t0; if (lift) mv.blocksToAvoid.add(fl.id) }
}

// SQUARE ON THE STAND: the pathfinder's GoalBlock is met anywhere inside the cell; what findStands promised was seen from its centre (or its `.lean` point). Sneaking, so the
// last step never goes over a rim. A short, exact walk inside ONE standable cell - not travel.
async function centreOn (bot, cell, ms = 1300) {
  const lean = cell.lean || [0, 0]; const tx = cell.x + 0.5 + lean[0]; const tz = cell.z + 0.5 + lean[1]; const end = Date.now() + ms; let on = false
  try {
    while (Date.now() < end) {
      ck(bot)
      const q = bot.entity.position; const dx = tx - q.x; const dz = tz - q.z
      if (Math.hypot(dx, dz) < 0.1 || Math.hypot(dx, dz) > 1.6 || Math.abs(q.y - cell.y) > 0.6) break
      try { await bot.look(Math.atan2(-dx, -dz), 0, true) } catch (e_) { swallow('blocks:centreLook', e_) }
      if (!on) { bot.setControlState('sneak', true); on = true }
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { try { bot.setControlState('forward', false); if (on) bot.setControlState('sneak', false) } catch (e_) { swallow('blocks:centreOff', e_) } }
  await settle(bot, 500)
}
// walk to the stands one after the other until the bot really SEES what it came for: -> {a, reached}. A stand without a path costs nothing (moveTo fails at once);
// at most 3 stands are walked to, 30 s in all.
async function standAndAim (bot, stands, aimNow, moveMs) {
  let reached = 0; const end = Date.now() + 30000
  const log = bot.__standLog = [] // why: probe-readable record of the last stand walk (09-21 no_los investigation)
  for (const cell of stands) {
    if (reached >= 3 || Date.now() > end) break
    const t1 = Date.now(); const ok = await moveTo(bot, cell, moveMs || 12000); const e = bot.entity.position; log.push([cell.x, cell.y, cell.z, ok, Date.now() - t1, +e.x.toFixed(2), +e.y.toFixed(3), +e.z.toFixed(2), ok ? null : bot.__moveErr]); bot.__moveErr = null
    if (!ok) continue
    reached++
    await settle(bot, 600)
    let a = aimNow()
    if (!a) { await centreOn(bot, cell); a = aimNow() }
    if (a) return { a, reached }
  }
  return { a: null, reached }
}

function invCount (bot, name) { let n = 0; for (const i of bot.inventory.items()) if (i.name === name) n += i.count; return n }
function fillerItem (bot, prefer) {
  const list = prefer ? [prefer, ...FILLER] : FILLER
  return list.find(n => invCount(bot, n) > 0) || null
}
async function equipName (bot, name) {
  if (bot.heldItem && bot.heldItem.name === name) return true
  const it = bot.inventory.items().find(i => i.name === name)
  if (!it) return false
  try { await withTimeout(bot.equip(it, 'hand'), 4000, 'equip'); return !!(bot.heldItem && bot.heldItem.name === name) } catch { return false }
}

// wait for a server block update at p that satisfies pred(newBlock). Resolves newBlock|null(timeout)
function waitBlock (bot, p, pred, ms) {
  return new Promise(resolve => {
    const ev = `blockUpdate:(${p.x}, ${p.y}, ${p.z})`
    let t = null
    const on = (oldB, newB) => { if (!newB || pred(newB, oldB)) { clearTimeout(t); bot.removeListener(ev, on); resolve(newB || null) } }
    t = setTimeout(() => { bot.removeListener(ev, on); resolve(null) }, ms)
    bot.on(ev, on)
  })
}

// ---------------------------------------------------------------- WHAT WE BUILT IS NOT TERRAIN (registry: lib/army.js ours())
// owner 09-20: sheep left pen 1 over step blocks an escape routine had left on the pen floor; the dorm walls had holes dug by the same routine. Two rules live HERE
// because every job's edits pass through here: (1) nothing but a torch/fence/gate is ever PLACED inside a pen's ring at or above the fence level (reason 'pen');
// (2) nobody DIGS a block that stands where a blueprint of ours put it (reason 'ours') - except the job that owns the cell (`opts.own: <job id>`) or an operator's
// explicit order (`opts.own: true`: steps verb dig with force). army.js is required lazily (it requires this file lazily too).
function reg () { try { return require('./army') } catch (e_) { swallow('blocks:reg', e_); return null } }
function penAt (p) { const A = reg(); try { return A && A.penAt ? A.penAt(p.x, p.y, p.z) : null } catch (e_) { swallow('blocks:penAt', e_); return null } }
function oursAt (p, name) { const A = reg(); try { return A && A.ourBlock ? A.ourBlock(p, name) : null } catch (e_) { swallow('blocks:oursAt', e_); return null } }

// ---------------------------------------------------------------- PLACE
// opts: faces:[Vec3] restrict/ordered reference faces (vector from the reference block TO pos)
//       half:'top'|'bottom' (slabs/stairs), expect: RegExp|string for the resulting block name,
//       replace:true (dig a non-replaceable block first), retries (2), noMove, lock:false, scaffold:true (ledger)
async function placeBlock (bot, pos, itemName, opts = {}) {
  const t0 = Date.now()
  const st = S(bot).place; st.calls++
  ck(bot)
  const p = V(pos)
  let cur = bot.blockAt(p)
  if (!cur) { blind(bot, 'blocks:placeBlock', 'target cell not loaded, refusing to place into a cell we cannot see'); return failP(bot, 'unloaded', t0) }
  const want = opts.expect ? (opts.expect instanceof RegExp ? opts.expect : new RegExp('^' + opts.expect + '$')) : null
  const isWanted = (b) => !!b && (want ? want.test(b.name) : b.name === itemName)
  if (isWanted(cur)) { st.already++; return { ok: true, already: true, ms: 0, tries: 0 } }
  if (!/torch$|_fence$|_fence_gate$/.test(itemName) && opts.own !== true && penAt(p)) return failP(bot, 'pen', t0)
  if (invCount(bot, itemName) === 0) return failP(bot, 'noitem', t0)
  if (!isReplaceable(cur)) {
    if (!opts.replace) return failP(bot, 'occupied', t0, { block: cur.name })
    const d = await digBlock(bot, p, { collect: opts.collect !== false, lock: opts.lock })
    if (!d.ok) return failP(bot, 'occupied:' + d.reason, t0, { block: cur.name })
    cur = bot.blockAt(p)
  }
  if (opts.lock !== false && !acquire(bot, p)) return failP(bot, 'locked', t0)
  let sneaking = false
  try {
    // reference faces: neighbour n = p - f, clicked face of n = f
    const faceList = opts.faces || FACES
    const refs = []
    for (const f of faceList) {
      const n = bot.blockAt(p.minus(f))
      if (!n || isAir(n) || isLiquid(n) || isReplaceable(n)) continue
      if (n.boundingBox !== 'block' && !(n.shapes && n.shapes.length)) continue
      refs.push({ block: n, face: f, inter: INTERACTABLE.test(n.name) })
    }
    if (!refs.length) return failP(bot, 'noref', t0)
    refs.sort((a, b) => (a.inter - b.inter)) // prefer plain blocks over chests & co (stable sort keeps face order)
    const aim = (eye) => { for (const r of refs) { const pt = visiblePoint(bot, eye, r.block.position, r.face, { half: opts.half }); if (pt) return { r, pt } } return null }

    const tries = (opts.retries == null ? 2 : opts.retries) + 1
    let lastReason = 'unreachable'
    for (let attempt = 1; attempt <= tries; attempt++) {
      ck(bot)
      // 1. be somewhere sensible: not inside the target, a reference face in view
      let a = botOverlaps(bot, p) ? null : aim(eyeOf(bot))
      if (!a) {
        if (opts.noMove) return failP(bot, 'unreachable', t0)
        // PLACING DOWNWARDS FROM THE RIM comes first (a stand at or above the cell), standing IN the hole under the cell last; the stand is walked to only when a
        // reference face is visible from it, and the bot squares itself on it before it aims (standAndAim). No stand could be walked to = `unreachable` (said once,
        // no retry); stood there and still saw nothing = `no_los`.
        const stands = findStands(bot, p, (eye) => !!aim(eye), { solidTarget: true, avoid: opts.avoidStand, max: 6, lean: true, rank: c => (c.y < p.y ? 2 : 0) + (opts.triedStands && opts.triedStands.has(c.x + ',' + c.y + ',' + c.z) ? 20 : 0) })
        if (!stands.length) return failP(bot, 'unreachable', t0)
        const sa = await standAndAim(bot, stands, () => (botOverlaps(bot, p) ? null : aim(eyeOf(bot))), opts.moveMs)
        if (opts.triedStands) for (const c of stands.slice(0, 3)) opts.triedStands.add(c.x + ',' + c.y + ',' + c.z)
        a = sa.a
        if (!a) { if (!sa.reached) return failP(bot, 'unreachable', t0, { stands: stands.length }); lastReason = 'no_los'; const e = bot.entity.position; bot.__lastNoLos = { t: Date.now(), p: [p.x, p.y, p.z], item: itemName, stands: stands.map(c => [c.x, c.y, c.z, c.lean || null]), at: [+e.x.toFixed(2), +e.y.toFixed(3), +e.z.toFixed(2)], reached: sa.reached, refs: refs.map(r => r.block.name + '@' + r.block.position + ' f' + r.face) }; continue } // why: the last no_los, readable by a probe
      }
      // 2. nobody standing in the target cell?
      const blocker = Object.values(bot.entities).find(e => e !== bot.entity && e.position && (e.type === 'player' || e.type === 'mob' || e.type === 'animal' || e.type === 'hostile' || e.type === 'water_creature' || e.type === 'ambient') &&
        e.position.x + 0.3 > p.x && e.position.x - 0.3 < p.x + 1 && e.position.z + 0.3 > p.z && e.position.z - 0.3 < p.z + 1 && e.position.y + (e.height || 1.8) > p.y && e.position.y < p.y + 1)
      if (blocker) { lastReason = 'entity'; await sleep(700); continue }
      // 3. item in hand, sneak if the clicked block would open a GUI
      if (!await equipName(bot, itemName)) return failP(bot, invCount(bot, itemName) ? 'equip' : 'noitem', t0)
      if (a.r.inter && !sneaking) { bot.setControlState('sneak', true); sneaking = true; await sleep(150) }
      // 4. look at the exact point, click, wait for the SERVER to tell us the block changed
      try { await withTimeout(bot.lookAt(a.pt, true), 1500, 'look') } catch { lastReason = 'look'; continue }
      const before = bot.blockAt(p)
      const beforeType = before ? before.type : 0
      const conf = waitBlock(bot, p, (nb) => nb.type !== beforeType && !isReplaceable(nb), opts.confirmMs || 1500)
      st.packets++
      if (opts.scaffold) ledgerAdd(bot, p, itemName)
      try {
        await withTimeout(bot._genericPlace(a.r.block, a.r.face, { forceLook: 'ignore', swingArm: 'right', delta: a.pt.minus(a.r.block.position) }), 1500, 'place')
      } catch (e) { lastReason = 'send'; continue }
      const nb = await conf
      if (nb && (want ? want.test(nb.name) : true)) { st.ok++; return { ok: true, ms: Date.now() - t0, tries: attempt, block: nb.name } }
      const now = bot.blockAt(p)
      if (now && !isReplaceable(now) && (want ? want.test(now.name) : true)) { st.ok++; return { ok: true, ms: Date.now() - t0, tries: attempt, block: now.name } }
      st.rejected++
      lastReason = 'rejected'
      if (opts.scaffold) ledgerDrop(bot, p)
      await sleep(120)
    }
    return failP(bot, lastReason, t0, { tries })
  } finally {
    if (sneaking) { try { bot.setControlState('sneak', false) } catch (e_) { swallow('blocks:347', e_) } }
    if (opts.lock !== false) release(bot, p)
  }
}

// ---------------------------------------------------------------- DIG
function bestTool (bot, block) {
  const inWater = (() => { try { const b = bot.blockAt(eyeOf(bot)); return !!b && b.name === 'water' } catch { return false } })()
  const effects = bot.entity.effects || {}
  const timeWith = (it) => { try { return block.digTime(it ? it.type : null, false, inWater, false, it ? (it.enchants || []) : [], effects) } catch { return Infinity } }
  const canHarvestWith = (it) => !block.harvestTools || !!(it && block.harvestTools[it.type])
  let best = { item: null, ms: timeWith(null), harvest: canHarvestWith(null) }
  for (const it of bot.inventory.items()) {
    const h = canHarvestWith(it)
    const ms = timeWith(it)
    if ((h && !best.harvest) || (h === best.harvest && ms < best.ms - 1)) best = { item: it, ms, harvest: h }
  }
  // same speed as the bare hand -> do not wear a tool out on it
  if (best.item && best.harvest === canHarvestWith(null) && Math.abs(best.ms - timeWith(null)) < 1) best.item = null
  return best
}
function toolKindFor (block) {
  const m = block.material || ''
  if (/pickaxe/.test(m)) return 'pickaxe'
  if (/shovel/.test(m)) return 'shovel'
  if (/axe/.test(m)) return 'axe'
  if (/hoe/.test(m)) return 'hoe'
  return null
}

// opts: requireHarvest (true) | force (dig even if nothing drops) | craftTool | allowUnderFeet | allowProtected |
//       plug (true: plug adjacent liquids first) | collect (true) | clearFalling (true) | clearThrough: RegExp of
//       blocks that may be dug out of the line of sight (e.g. /_leaves$/) | noMove | lock:false
async function digBlock (bot, pos, opts = {}) {
  const t0 = Date.now()
  const st = S(bot).dig; st.calls++
  ck(bot)
  const p = V(pos.position || pos)
  let block = bot.blockAt(p)
  if (!block) { blind(bot, 'blocks:digBlock', 'target cell not loaded: it is NOT empty and NOT dug'); return failD(bot, 'unloaded', t0) }
  if (isAir(block)) return { ok: true, already: true, ms: 0 }
  if (isLiquid(block)) return failD(bot, 'liquid', t0)
  if (!block.diggable || block.hardness == null || block.hardness < 0) return failD(bot, 'unbreakable', t0)
  if (!opts.allowProtected && PROTECTED.test(block.name)) return failD(bot, 'protected', t0, { block: block.name })
  if (opts.own !== true) { const oc = oursAt(p, block.name); if (oc && oc.job !== opts.own) return failD(bot, 'ours', t0, { block: block.name, job: oc.job }) }
  const feet = bot.entity.position.floored()
  if (!opts.allowUnderFeet && p.x === feet.x && p.z === feet.z && p.y === feet.y - 1) return failD(bot, 'under_feet', t0)
  if (opts.lock !== false && !acquire(bot, p, 30000)) return failD(bot, 'locked', t0)
  try {
    // --- tool
    let tool = bestTool(bot, block)
    if (!tool.harvest && opts.requireHarvest !== false && !opts.force) {
      let crafted = false
      if (opts.craftTool) {
        const kind = toolKindFor(block)
        if (kind) {
          try {
            const CR = require('./craft')
            crafted = await withTimeout(CR.ensureTool(bot, kind, 'stone'), 40000, 'craftTool').catch(() => false) ||
              await withTimeout(CR.ensureTool(bot, kind, 'wooden'), 40000, 'craftTool').catch(() => false)
          } catch (e_) { swallow('blocks:406', e_) }
          tool = bestTool(bot, block)
        }
      }
      if (!tool.harvest) return failD(bot, 'notool', t0, { block: block.name, need: toolKindFor(block), crafted })
    }
    // --- liquids next to the block: plug them first (lava: or refuse)
    if (opts.plug !== false) {
      for (const f of FACES) {
        if (f.y < 0 && !opts.allowUnderFeet) continue
        // A NEIGHBOUR WE CANNOT SEE IS NOT "NO LAVA" (owner 09-21): `!n || !isLiquid(n) -> continue` read an unloaded neighbour as
        // dry rock and opened the cell into whatever was behind it. Unknown neighbour -> refuse the dig and say so out loud.
        const nr = readAt(bot, p.plus(f))
        if (!nr.known) { blind(bot, 'blocks:digBlock/plug', 'neighbour cell not loaded, cannot tell lava from rock'); return failD(bot, 'blind_neighbour', t0, { at: [p.x + f.x, p.y + f.y, p.z + f.z] }) }
        const n = nr.block
        if (!isLiquid(n)) continue
        const filler = fillerItem(bot)
        let plugged = false
        if (filler) plugged = (await placeBlock(bot, p.plus(f), filler, { retries: 1, lock: false, expect: /./ })).ok
        if (!plugged && n.name === 'lava') return failD(bot, 'lava', t0)
        if (!plugged && opts.strictWater) return failD(bot, 'water', t0)
      }
    }
    // --- position: see a face, within reach
    for (let attempt = 1; attempt <= 3; attempt++) {
      ck(bot)
      block = bot.blockAt(p)
      // NOT LOADED IS NOT DONE: this used to return ok:true (`already`) for a cell the bot could not see — the caller then ticked it off its list.
      if (!block) { blind(bot, 'blocks:digBlock/reread', 'target cell not loaded, refusing to call it dug'); return failD(bot, 'unloaded', t0) }
      if (isAir(block)) return { ok: true, already: true, ms: Date.now() - t0 }
      const blockers = []
      let a = visibleFaceOf(bot, eyeOf(bot), block, { blockers })
      if (!a && opts.clearThrough && blockers.length) {
        const b = blockers.find(h => opts.clearThrough.test(h.name) && eyeOf(bot).distanceTo(h.position.offset(0.5, 0.5, 0.5)) <= REACH)
        if (b && (opts._depth || 0) < 6) {
          const r = await digBlock(bot, b.position, Object.assign({}, opts, { collect: false, _depth: (opts._depth || 0) + 1, requireHarvest: false, plug: false }))
          if (r.ok) { attempt--; continue }
        }
      }
      if (!a) {
        if (opts.noMove) return failD(bot, 'unreachable', t0)
        const blk = block
        const stands = findStands(bot, p, (eye) => !!visibleFaceOf(bot, eye, blk), { max: 6, lean: true, avoid: (c) => (c.x === p.x && c.z === p.z && c.y === p.y + 1) || (opts.avoidStand && opts.avoidStand(c)) })
        if (!stands.length) return failD(bot, 'unreachable', t0)
        const sa = await standAndAim(bot, stands, () => { const nb = bot.blockAt(p); if (!nb) return null; return isAir(nb) ? { gone: true } : visibleFaceOf(bot, eyeOf(bot), nb) }, opts.moveMs)
        block = bot.blockAt(p)
        if (!block) { blind(bot, 'blocks:digBlock/afterMove', 'target cell not loaded after walking to it'); return failD(bot, 'unloaded', t0) }
        if (isAir(block)) return { ok: true, already: true, ms: Date.now() - t0 }
        a = sa.a && !sa.a.gone ? sa.a : null
        if (!a) { if (!sa.reached) return failD(bot, 'unreachable', t0, { stands: stands.length }); continue } // no stand could be walked to: not a line-of-sight problem (see findStands)
      }
      // never pull the floor from under ourselves by accident after moving
      const f2 = bot.entity.position.floored()
      if (!opts.allowUnderFeet && p.x === f2.x && p.z === f2.z && p.y === f2.y - 1) return failD(bot, 'under_feet', t0)
      // --- stand still on the ground (airborne digging is 5x slower), tool in hand, look, dig
      await settle(bot, 1200)
      tool = bestTool(bot, block)
      if (tool.item) { if (!(bot.heldItem && bot.heldItem.type === tool.item.type)) { try { await withTimeout(bot.equip(tool.item, 'hand'), 4000, 'equip') } catch { return failD(bot, 'equip', t0) } } } else if (bot.heldItem && bot.heldItem.maxDurability) {
        // bare-hand job but a tool is in hand: swap to any non-tool so we do not burn durability
        const junk = bot.inventory.items().find(i => !i.maxDurability)
        if (junk) { try { await withTimeout(bot.equip(junk, 'hand'), 4000, 'equip') } catch (e_) { swallow('blocks:460', e_) } }
      }
      try { await withTimeout(bot.lookAt(a.point, true), 1500, 'look') } catch { continue }
      const expMs = bot.digTime(block)
      if (!isFinite(expMs)) return failD(bot, 'unbreakable', t0)
      const above = bot.blockAt(p.offset(0, 1, 0))
      const ack = new Promise(resolve => { const h = () => { clearTimeout(t); resolve(true) }; const t = setTimeout(() => { bot._client.removeListener('acknowledge_player_digging', h); resolve(false) }, expMs + 2500); bot._client.once('acknowledge_player_digging', h) })
      const d0 = Date.now()
      try {
        await withTimeout(bot.dig(block, 'ignore'), expMs * 1.5 + 3000, 'dig')
      } catch (e) {
        try { bot.stopDigging() } catch (e_) { swallow('blocks:471', e_) }
        ck(bot)
        if (attempt === 3) return failD(bot, /timeout/.test(e.message) ? 'timeout' : 'aborted', t0)
        continue
      }
      // server confirmation: the finish ack arrives after any "put it back" block update
      await Promise.race([ack, sleep(400)])
      await sleep(60)
      const after = bot.blockAt(p)
      // the dig is SERVER-CONFIRMED by re-reading the cell; an unreadable cell confirms nothing, so it is not a success either
      if (!after) { blind(bot, 'blocks:digBlock/confirm', 'cell unreadable right after the dig, cannot confirm it is gone'); return failD(bot, 'unloaded', t0) }
      if (!isAir(after) && !isLiquid(after) && after.type === block.type && !GRAVITY.test(after.name)) {
        st.rejected++
        if (attempt === 3) return failD(bot, 'rejected', t0)
        await sleep(150)
        continue
      }
      st.ok++; st.ms += Date.now() - d0; st.expMs += expMs
      // --- gravel / sand column coming down: keep digging this cell until it stays clear
      if (opts.clearFalling !== false && above && GRAVITY.test(above.name)) {
        for (let i = 0; i < 16; i++) {
          ck(bot)
          await sleep(450)
          const nb = bot.blockAt(p)
          if (!nb || !GRAVITY.test(nb.name)) { const up = bot.blockAt(p.offset(0, 1, 0)); if (!up || !GRAVITY.test(up.name)) break; continue }
          try { await withTimeout(bot.dig(nb, true), bot.digTime(nb) * 1.5 + 3000, 'dig') } catch { try { bot.stopDigging() } catch (e_) { swallow('blocks:494', e_) } break }
        }
      }
      if (opts.collect !== false) await collectDrops(bot, p, { ms: opts.collectMs || 2500, radius: 2.5 })
      return { ok: true, ms: Date.now() - t0, tool: tool.item ? tool.item.name : 'hand', expectedMs: expMs, block: block.name }
    }
    return failD(bot, 'no_los', t0)
  } finally { if (opts.lock !== false) release(bot, p) }
}

// Pick up item entities lying around `center`. Walks (never digs/places) to each; bounded in time.
async function collectDrops (bot, center, opts = {}) {
  const c = center.position || center
  const radius = opts.radius || 4
  const end = Date.now() + (opts.ms || 3000)
  let got = 0; let first = true
  while (Date.now() < end) {
    ck(bot)
    if (bot.inventory.emptySlotCount() === 0) break
    const me = bot.entity.position
    const items = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(c.offset ? c.offset(0.5, 0.5, 0.5) : c) <= radius + 1 && Math.abs(e.position.y - me.y) < 5 && !(bot.__blkSkip && bot.__blkSkip.has(e.id)))
    if (!items.length) { if (first) { first = false; await sleep(250); continue } break }
    first = false
    items.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    const it = items[0]
    if (it.position.distanceTo(me) < 1.2) { await sleep(200); if (!bot.entities[it.id]) got++; continue } // pickup delay
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.7)), Math.min(4000, Math.max(500, end - Date.now())), 'collect')
    } catch {
      try { bot.pathfinder.setGoal(null) } catch (e_) { swallow('blocks:523', e_) }
      ck(bot)
      if (!bot.__blkSkip) bot.__blkSkip = new Set()
      bot.__blkSkip.add(it.id); if (bot.__blkSkip.size > 200) bot.__blkSkip.clear() // unreachable drop: one try only
    }
    await sleep(120)
    if (!bot.entities[it.id]) got++
  }
  return got
}

// ---------------------------------------------------------------- scaffold ledger
function ledgerFile (bot) { return path.join(SCAF_DIR, bot.username + '.json') }
function ledgerRead (bot) { try { return JSON.parse(fs.readFileSync(ledgerFile(bot), 'utf8')) } catch { return [] } }
function ledgerWrite (bot, list) {
  try { fs.mkdirSync(SCAF_DIR, { recursive: true }); const f = ledgerFile(bot); fs.writeFileSync(f + '.tmp', JSON.stringify(list)); fs.renameSync(f + '.tmp', f) } catch (e_) { swallow('blocks:538', e_) }
}
function ledgerAdd (bot, p, name) { const l = ledgerRead(bot); if (!l.some(e => e.x === p.x && e.y === p.y && e.z === p.z)) { l.push({ x: p.x, y: p.y, z: p.z, name, t: Date.now() }); ledgerWrite(bot, l) } }
function ledgerDrop (bot, p) { const l = ledgerRead(bot); const n = l.filter(e => !(e.x === p.x && e.y === p.y && e.z === p.z)); if (n.length !== l.length) ledgerWrite(bot, n) }
function scaffoldLeft (bot) { return ledgerRead(bot) }

// Jump-place under the feet, n times. Every block goes into the ledger first. Returns blocks risen.
async function pillarUp (bot, n, opts = {}) {
  let risen = 0
  for (let i = 0; i < n; i++) {
    ck(bot)
    const item = fillerItem(bot, opts.item)
    if (!item) break
    await settle(bot, 1500)
    const feet = bot.entity.position.floored()
    if (penAt(feet)) break // never a pillar inside a pen (animals climb it and hop the fence)
    const head2 = readAt(bot, feet.offset(0, 2, 0))
    if (!head2.known) { blind(bot, 'blocks:pillarUp', 'the cell over the head is not loaded, refusing to jump-place into it'); break }
    if (!isPassable(head2)) { // ceiling: a player digs it first
      const r = await digBlock(bot, feet.offset(0, 2, 0), { collect: false, requireHarvest: false })
      if (!r.ok) break
    }
    const ref = bot.blockAt(feet.offset(0, -1, 0))
    if (!isSolidRef(ref)) break
    if (!await equipName(bot, item)) break
    if (!acquire(bot, feet)) break
    try {
      // centre on the block so the jump comes straight down on the new one
      try { await withTimeout(bot.look(bot.entity.yaw, -Math.PI / 2, true), 1000, 'look') } catch (e_) { swallow('blocks:564', e_) }
      const ledger = opts.ledger !== false // ledger:false = the block IS the work (a hole filled from inside, bottom-up), nobody's scaffold
      if (ledger) ledgerAdd(bot, feet, item)
      const conf = waitBlock(bot, feet, (nb) => !isReplaceable(nb), 1500)
      bot.setControlState('jump', true)
      const tEnd = Date.now() + 900
      let sent = false
      while (Date.now() < tEnd) {
        if (bot.entity.position.y >= feet.y + 1.02) {
          S(bot).place.calls++; S(bot).place.packets++
          try { await bot._genericPlace(ref, new Vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right', delta: new Vec3(0.5, 1, 0.5) }) } catch (e_) { swallow('blocks:573', e_) }
          sent = true
          break
        }
        await sleep(15)
      }
      bot.setControlState('jump', false)
      const nb = sent ? await conf : null
      if (nb) { S(bot).place.ok++; risen++ } else { if (sent) S(bot).place.rejected++; ledgerDrop(bot, feet); const now = bot.blockAt(feet); if (now && !isReplaceable(now)) { if (ledger) ledgerAdd(bot, feet, item); risen++ } else if (++i >= n + 2) break; else { n++; } }
      await settle(bot, 1200)
    } finally { bot.setControlState('jump', false); release(bot, feet) }
  }
  return risen
}

// Dig down through OUR OWN pillar (ledger blocks only, unless opts.any). Returns blocks descended.
async function pillarDown (bot, n = 64, opts = {}) {
  let down = 0
  for (let i = 0; i < n; i++) {
    ck(bot)
    await settle(bot, 1500)
    const under = bot.entity.position.floored().offset(0, -1, 0)
    const mine = ledgerRead(bot).some(e => e.x === under.x && e.y === under.y && e.z === under.z)
    if (!mine && !opts.any) break
    const b = bot.blockAt(under)
    if (!b || isAir(b)) { ledgerDrop(bot, under); await sleep(150); continue }
    const r = await digBlock(bot, under, { allowUnderFeet: true, collect: false, requireHarvest: false, noMove: true, plug: false })
    if (!r.ok) break
    ledgerDrop(bot, under)
    down++
    await settle(bot, 1500)
  }
  await collectDrops(bot, bot.entity.position.floored(), { ms: 1200, radius: 2 })
  return down
}

// Remove every scaffold block this bot ever registered (top-down). Returns {removed, left}
async function removeScaffold (bot, opts = {}) {
  let removed = 0
  const deadline = Date.now() + (opts.ms || 120000)
  for (let pass = 0; pass < 3; pass++) {
    const list = ledgerRead(bot).sort((a, b) => b.y - a.y)
    if (!list.length) break
    for (const e of list) {
      if (Date.now() > deadline) break
      try { ck(bot) } catch (err) { if (!opts.evenIfCancelled) throw err }
      const p = new Vec3(e.x, e.y, e.z)
      const b = bot.blockAt(p)
      if (!b) continue
      if (isAir(b) || b.name !== e.name) { ledgerDrop(bot, p); continue }
      const feet = bot.entity.position.floored()
      if (feet.x === p.x && feet.z === p.z && feet.y === p.y + 1) { removed += await pillarDown(bot, 64); continue }
      const r = await digBlock(bot, p, { requireHarvest: false, collect: true, plug: false })
      if (r.ok) { removed++; ledgerDrop(bot, p) }
    }
  }
  return { removed, left: ledgerRead(bot).length }
}
async function withScaffold (bot, fn) {
  try { return await fn() } finally {
    const was = bot.state && bot.state.cancel
    try { if (was) bot.state.cancel = false; await removeScaffold(bot, { ms: 60000 }) } catch (e_) { swallow('blocks:634', e_) } finally { if (was) bot.state.cancel = true }
  }
}

// ---------------------------------------------------------------- BRIDGE (sneak to the edge, click the side of the block we stand on)
// dir: {x,z} unit step. Bridges at floor level (feet.y-1) for `len` cells. Returns cells advanced.
async function bridge (bot, dir, len, itemName, opts = {}) {
  const d = new Vec3(Math.sign(dir.x || 0), 0, Math.sign(dir.z || 0))
  if ((d.x !== 0) === (d.z !== 0)) throw new Error('bridge: dir must be axis-aligned')
  let adv = 0
  await settle(bot, 1200)
  const yaw = Math.atan2(-d.x, -d.z)
  try {
    for (let i = 0; i < len; i++) {
      ck(bot)
      const feet = bot.entity.position.floored()
      const next = feet.plus(d)
      const floor = next.offset(0, -1, 0)
      if (!isPassable(bot.blockAt(next)) || !isPassable(bot.blockAt(next.offset(0, 1, 0)))) break // wall ahead (or unknown: never walked into)
      // THE RIM CASE (owner 09-21): an unreadable floor cell was read as "no floor", so the bot placed a deck over a cavern it could not
      // see and then stepped onto it. A bridge stops at the edge of what it can see.
      const fr = readAt(bot, floor)
      if (!fr.known) { blind(bot, 'blocks:bridge', 'the floor cell ahead is not loaded, refusing to deck over it'); break }
      const fb = fr.block
      if (!isSolidRef(fb)) {
        const item = itemName && invCount(bot, itemName) ? itemName : fillerItem(bot)
        if (!item) break
        const ref = bot.blockAt(feet.offset(0, -1, 0))
        if (!isSolidRef(ref)) break
        if (!await equipName(bot, item)) break
        bot.setControlState('sneak', true)
        await sleep(120)
        // creep to the edge until the eye is past the face plane (sneaking cannot fall off)
        try { await withTimeout(bot.look(yaw, 0, true), 1000, 'look') } catch (e_) { swallow('blocks:663', e_) }
        const past = () => { const e = bot.entity.position; return d.x !== 0 ? (e.x - (ref.position.x + (d.x > 0 ? 1 : 0))) * d.x : (e.z - (ref.position.z + (d.z > 0 ? 1 : 0))) * d.z }
        bot.setControlState('forward', true)
        const tEnd = Date.now() + 2500
        while (past() < 0.2 && Date.now() < tEnd) { ck(bot); await sleep(25) }
        bot.setControlState('forward', false)
        await sleep(80)
        let ok = false
        for (let k = 0; k < 3 && !ok; k++) {
          const pt = visiblePoint(bot, eyeOf(bot).offset(0, -0.3, 0), ref.position, d) || visiblePoint(bot, eyeOf(bot), ref.position, d)
          if (!pt) { bot.setControlState('forward', true); await sleep(120); bot.setControlState('forward', false); continue }
          try { await withTimeout(bot.lookAt(pt, true), 1200, 'look') } catch { continue }
          const conf = waitBlock(bot, floor, (nb) => !isReplaceable(nb), 1500)
          S(bot).place.calls++; S(bot).place.packets++
          if (opts.scaffold) ledgerAdd(bot, floor, item)
          try { await bot._genericPlace(ref, d, { forceLook: 'ignore', swingArm: 'right', delta: pt.minus(ref.position) }) } catch (e_) { swallow('blocks:678', e_) }
          ok = !!(await conf)
          if (ok) S(bot).place.ok++; else { S(bot).place.rejected++; if (opts.scaffold) ledgerDrop(bot, floor) }
        }
        if (!ok) break
      }
      // step onto the new block (still sneaking if we placed it)
      try { await withTimeout(bot.look(yaw, 0, true), 1000, 'look') } catch (e_) { swallow('blocks:685', e_) }
      bot.setControlState('forward', true)
      const tEnd2 = Date.now() + 3000
      const tgt = next.offset(0.5, 0, 0.5)
      while (Date.now() < tEnd2) { ck(bot); const e = bot.entity.position; if (Math.hypot(e.x - tgt.x, e.z - tgt.z) < 0.25) break; await sleep(25) }
      bot.setControlState('forward', false)
      if (!bot.entity.position.floored().equals(next)) break
      adv++
    }
  } finally { try { bot.setControlState('forward', false); bot.setControlState('sneak', false) } catch (e_) { swallow('blocks:694', e_) } }
  return adv
}

// ---------------------------------------------------------------- FARM
// unknown cells simply do not count as water: the bot then reports `no_water` and plants nothing — the safe side of the rule.
function hydrated (bot, p) {
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 0; dy <= 1; dy++) {
    const b = bot.blockAt(p.offset(dx, dy, dz)); if (b && (b.name === 'water' || b.isWaterlogged)) return true
  }
  return false
}
// pos = the soil block. Tills (if needed) and plants seedName (optional). Refuses dry land unless opts.allowDry.
async function tillAndPlant (bot, pos, seedName, opts = {}) {
  const t0 = Date.now()
  ck(bot)
  const p = V(pos)
  let soil = bot.blockAt(p)
  if (!soil) return { ok: false, reason: 'unloaded' }
  if (!opts.allowDry && !hydrated(bot, p)) return { ok: false, reason: 'no_water' }
  const up = p.offset(0, 1, 0)
  const top = bot.blockAt(up)
  if (!top) return { ok: false, reason: 'unloaded' } // the cell we would plant into is unreadable: nothing is planted and nothing is "already planted"
  const cropName = { wheat_seeds: 'wheat', beetroot_seeds: 'beetroots', carrot: 'carrots', potato: 'potatoes', melon_seeds: 'melon_stem', pumpkin_seeds: 'pumpkin_stem', torchflower_seeds: 'torchflower_crop', pitcher_pod: 'pitcher_crop' }[seedName]
  if (top && cropName && top.name === cropName) return { ok: true, already: true, ms: 0 }
  if (top && !isAir(top)) {
    if (top.boundingBox !== 'empty' || isLiquid(top)) return { ok: false, reason: 'obstructed', block: top.name }
    const r = await digBlock(bot, up, { collect: true, requireHarvest: false, plug: false })
    if (!r.ok) return { ok: false, reason: 'clear:' + r.reason }
  }
  soil = bot.blockAt(p)
  if (!soil) return { ok: false, reason: 'unloaded' } // (it also used to throw here: `soil.name` on a null read)
  if (soil.name !== 'farmland') {
    if (!TILLABLE.test(soil.name)) return { ok: false, reason: 'not_tillable', block: soil.name }
    const hoe = bot.inventory.items().find(i => /_hoe$/.test(i.name))
    if (!hoe) return { ok: false, reason: 'nohoe' }
    if (!acquire(bot, p)) return { ok: false, reason: 'locked' }
    try {
      let done = false
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        ck(bot)
        const face = new Vec3(0, 1, 0)
        let pt = botOverlaps(bot, up) && false ? null : visiblePoint(bot, eyeOf(bot), p, face)
        if (!pt) {
          const stands = findStands(bot, p, (eye) => !!visiblePoint(bot, eye, p, face), { avoid: opts.avoidStand })
          if (!stands.length) return { ok: false, reason: 'unreachable' }
          for (const c of stands) if (await moveTo(bot, c)) break
          await settle(bot, 600)
          pt = visiblePoint(bot, eyeOf(bot), p, face)
          if (!pt) continue
        }
        if (!await equipName(bot, hoe.name)) return { ok: false, reason: 'equip' }
        try { await withTimeout(bot.lookAt(pt, true), 1500, 'look') } catch { continue }
        const conf = waitBlock(bot, p, (nb) => nb.name === 'farmland', 1500)
        try { await withTimeout(bot._genericPlace(bot.blockAt(p), face, { forceLook: 'ignore', swingArm: 'right', delta: pt.minus(p) }), 1500, 'till') } catch (e_) { swallow('blocks:745', e_) }
        done = !!(await conf) || (bot.blockAt(p) || {}).name === 'farmland'
      }
      if (!done) return { ok: false, reason: 'till_rejected' }
    } finally { release(bot, p) }
  }
  if (!seedName) return { ok: true, ms: Date.now() - t0, tilled: true }
  const r = await placeBlock(bot, up, seedName, { faces: [new Vec3(0, 1, 0)], expect: cropName ? new RegExp('^' + cropName + '$') : /./, avoidStand: opts.avoidStand })
  return r.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, reason: 'plant:' + r.reason }
}

// Torch on the floor at pos (preferred) or on a wall next to pos. Never on a ceiling.
async function placeTorch (bot, pos, opts = {}) {
  const item = opts.item || 'torch'
  const faces = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  const p = V(pos)
  const usable = faces.filter(f => { const n = bot.blockAt(p.minus(f)); return isSolidRef(n) && !(n.shapes && n.shapes.length !== 1) && !/farmland|_leaves$|ice$|glass/.test(n.name) })
  if (!usable.length) return { ok: false, reason: 'noref' }
  return placeBlock(bot, p, item, Object.assign({ faces: usable, expect: /torch$/ }, opts))
}

// ---------------------------------------------------------------- BUILD / CLEAR
// Places many cells efficiently: bottom-up, nearest-first inside a layer, defers cells that have nothing to
// stand against yet, never walks into the wall it is building. cells = [{pos:{x,y,z}, name}]
async function buildCells (bot, cells, opts = {}) {
  const t0 = Date.now()
  const todo = cells.map(c => ({ pos: V(c.pos), name: c.name, opts: c.opts }))
  const planned = new Set(todo.map(c => key(c.pos)))
  const res = { placed: 0, already: 0, failed: [], ms: 0 }
  const avoidStand = (cell) => planned.has(key(cell)) || planned.has(key(cell.offset(0, 1, 0))) // do not stand where a block is still to come
  let progress = true
  while (todo.length && progress) {
    progress = false
    const ys = [...new Set(todo.map(c => c.pos.y))].sort((a, b) => a - b)
    for (const y of ys) {
      let layer = todo.filter(c => c.pos.y === y)
      while (layer.length) {
        ck(bot)
        const me = bot.entity.position
        let bi = 0; let bd = Infinity
        for (let i = 0; i < layer.length; i++) { const d = layer[i].pos.distanceTo(me); if (d < bd) { bd = d; bi = i } }
        const c = layer.splice(bi, 1)[0]
        const r = await placeBlock(bot, c.pos, c.name, Object.assign({ avoidStand, replace: opts.replace }, opts.place, c.opts))
        if (r.ok) {
          todo.splice(todo.indexOf(c), 1); planned.delete(key(c.pos)); progress = true
          if (r.already) res.already++; else res.placed++
          if (opts.onPlace) opts.onPlace(c, r)
        } else {
          c.reason = r.reason
          if (r.reason === 'noitem') { res.failed = todo.map(t => ({ pos: t.pos, reason: t.reason || 'noitem' })); res.ms = Date.now() - t0; return res }
        }
      }
    }
  }
  res.failed = todo.map(t => ({ pos: t.pos, reason: t.reason }))
  res.ms = Date.now() - t0
  return res
}

// box = {x1,y1,z1,x2,y2,z2}. Digs everything that is not `fillName` (top-down), then fills (bottom-up) if fillName.
async function clearAndFill (bot, box, fillName, opts = {}) {
  const x1 = Math.min(box.x1, box.x2); const x2 = Math.max(box.x1, box.x2)
  const y1 = Math.min(box.y1, box.y2); const y2 = Math.max(box.y1, box.y2)
  const z1 = Math.min(box.z1, box.z2); const z2 = Math.max(box.z1, box.z2)
  const res = { dug: 0, placed: 0, failed: [] }
  for (let y = y2; y >= y1; y--) {
    const layer = []
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) layer.push(new Vec3(x, y, z))
    while (layer.length) {
      ck(bot)
      const me = bot.entity.position
      layer.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
      const p = layer.shift()
      const b = bot.blockAt(p)
      // an unloaded cell used to be skipped exactly like an air cell — silently, so the box came back "cleared". It is reported instead.
      if (!b) { blind(bot, 'blocks:clearAndFill', 'cell not loaded, it is NOT cleared'); res.failed.push({ pos: p, reason: 'dig:unloaded' }); continue }
      if (isAir(b) || isLiquid(b) || (fillName && b.name === fillName)) continue
      const r = await digBlock(bot, p, Object.assign({ requireHarvest: false }, opts.dig))
      if (r.ok) res.dug++; else res.failed.push({ pos: p, reason: 'dig:' + r.reason })
    }
  }
  if (fillName) {
    const cells = []
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) cells.push({ pos: new Vec3(x, y, z), name: fillName })
    const r = await buildCells(bot, cells, opts)
    res.placed = r.placed; res.failed.push(...r.failed)
  }
  return res
}

// ---------------------------------------------------------------- TREE
// Fells the WHOLE tree containing logPos (top logs included: no floating crowns), removes its own scaffold,
// picks up the drops and replants a sapling on the stump soil.
// A TRUNK is any species' log or a nether stem — never `mushroom_stem`, `pumpkin_stem`, `melon_stem`, `big_dripleaf_stem` (they end in _stem too).
function isTrunk (name) { return /^(?!stripped_)\w+_log$|^(crimson|warped)_stem$/.test(name) }
function saplingOf (bot, trunk) { const sp = trunk.replace(/_(log|stem)$/, ''); return [sp + '_sapling', sp + '_propagule', sp + '_fungus'].find(n => bot.registry.itemsByName[n]) || (sp + '_sapling') }
async function harvestTree (bot, logPos, opts = {}) {
  ck(bot)
  const start = bot.blockAt(V(logPos))
  if (!start || !isTrunk(start.name)) return { ok: false, reason: 'not_a_log', logs: 0 }
  const kind = start.name
  const seen = new Map(); const q = [start.position]
  seen.set(key(start.position), start.position)
  while (q.length && seen.size < (opts.maxLogs || 96)) {
    const c = q.shift()
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue
      const n = c.offset(dx, dy, dz)
      if (seen.has(key(n)) || Math.abs(n.x - start.position.x) > 5 || Math.abs(n.z - start.position.z) > 5) continue
      const b = bot.blockAt(n)
      if (b && b.name === kind) { seen.set(key(n), n); q.push(n) }
    }
  }
  let logs = [...seen.values()]
  const minY = Math.min(...logs.map(l => l.y))
  const stumps = logs.filter(l => l.y === minY && SOIL.test((bot.blockAt(l.offset(0, -1, 0)) || {}).name || ''))
  const total = logs.length
  let felled = 0
  const deadline = Date.now() + (opts.ms || 180000)
  const res = await withScaffold(bot, async () => {
    let climbs = 0
    while (logs.length && Date.now() < deadline) {
      ck(bot)
      logs = logs.filter(l => { const b = bot.blockAt(l); return b && b.name === kind })
      if (!logs.length) break
      const me = bot.entity.position
      // lowest first; among equals the nearest
      logs.sort((a, b) => (a.y - b.y) || (a.distanceTo(me) - b.distanceTo(me)))
      let done = false; let lastReason = null
      for (const l of logs.slice(0, 6)) {
        const r = await digBlock(bot, l, { clearThrough: /_leaves$|^vine$|^snow$/, requireHarvest: false, collect: false, moveMs: 8000 })
        if (r.ok) { felled++; done = true; break }
        lastReason = r.reason
      }
      if (done) continue
      // out of reach from the ground: climb the trunk column like a player (pillar up inside it)
      if (climbs++ > 24) break
      const low = logs[0]
      const col = new Vec3(low.x, 0, low.z)
      const feet = bot.entity.position.floored()
      if (feet.x !== col.x || feet.z !== col.z) {
        // stand where the trunk was (its lowest free cell)
        let y = low.y - 1
        while (y > minY - 1 && isPassable(bot.blockAt(new Vec3(col.x, y - 1, col.z)))) y--
        const cell = new Vec3(col.x, y, col.z)
        if (!standable(bot, cell) || !await moveTo(bot, cell, 10000)) { return { stuck: lastReason || 'unreachable' } }
      }
      if (await pillarUp(bot, 1, { item: opts.scaffoldItem }) < 1) return { stuck: 'no_scaffold' }
    }
    return {}
  })
  logs = logs.filter(l => { const b = bot.blockAt(l); return b && b.name === kind })
  // FINISH THE TREE (owner 09-20: "floating tree remains, mostly over the fields"): opts.crown(pos) -> true = this leaf may not be left hanging (it is over a pad, a field, a
  // road of ours). Leaves with no log within 4 decay by themselves in a minute and are left to; the ones a neighbouring trunk or a log stump keeps alive are taken by hand
  // (max 48, 60 s, from the ground / the stump: no scaffold for leaves). Over natural ground outside our zones nothing is touched.
  let crown = 0
  if (opts.crown && !logs.length) {
    try {
      const c0 = start.position; const maxY = Math.max(...[...seen.values()].map(l => l.y)) + 4; const lv = []; const lg = []
      for (let x = c0.x - 10; x <= c0.x + 10; x++) for (let z = c0.z - 10; z <= c0.z + 10; z++) for (let y = minY; y <= maxY; y++) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) continue; if (/_leaves$/.test(b.name)) { if (Math.abs(x - c0.x) <= 6 && Math.abs(z - c0.z) <= 6) lv.push(b.position) } else if (/_log$|_wood$/.test(b.name)) lg.push(b.position) }
      const keep = lv.filter(p => opts.crown(p) && lg.some(l => Math.max(Math.abs(l.x - p.x), Math.abs(l.y - p.y), Math.abs(l.z - p.z)) <= 4)).sort((a, b) => b.y - a.y)
      const end = Date.now() + 60000
      for (const p of keep.slice(0, 48)) { if (Date.now() > end) break; ck(bot); const r = await digBlock(bot, p, { requireHarvest: false, collect: false, moveMs: 6000, plug: false }); if (r.ok) crown++ }
    } catch (e) { if (e instanceof Cancelled) throw e; swallow('blocks:crown', e) }
  }
  // drops + sapling
  if (stumps.length) await collectDrops(bot, stumps[0], { ms: opts.collectMs || 6000, radius: 5 })
  let replanted = 0
  if (opts.replant !== false) {
    const sap = saplingOf(bot, kind) // any species: oak_sapling … mangrove_propagule, crimson_fungus; none known -> invCount is 0 and nothing is planted
    for (const s of stumps) {
      if (invCount(bot, sap) === 0) break
      const b = bot.blockAt(s)
      if (b && !isReplaceable(b)) continue
      const r = await placeBlock(bot, s, sap, { faces: [new Vec3(0, 1, 0)], expect: new RegExp('^' + sap + '$') })
      if (r.ok) replanted++
    }
  }
  return { ok: logs.length === 0, logs: felled, total, left: logs.length, replanted, crown, scaffoldLeft: scaffoldLeft(bot).length, reason: res && res.stuck }
}

// ---------------------------------------------------------------- MOVEMENT PRESETS
// The terrain guard already forbids pathfinder edits on the surface; these presets make the intent explicit and
// add protection lists. mode: 'surface'|'zone' (no edits at all), 'wild' (same, parkour ok), 'underground' (limited).
function safeMovements (bot, mode = 'surface') {
  const mv = new Movements(bot)
  const reg = bot.registry
  mv.allowSprinting = false
  mv.canOpenDoors = true
  mv.dontCreateFlow = true
  mv.dontMineUnderFallingBlock = true
  mv.infiniteLiquidDropdownDistance = false
  mv.liquidCost = 40
  mv.maxDropDown = 3
  mv.allowParkour = mode === 'wild'
  mv.allow1by1towers = false
  if (mode === 'underground') {
    mv.canDig = true; mv.digCost = 6; mv.placeCost = 4
    mv.scafoldingBlocks = FILLER.map(n => reg.itemsByName[n] && reg.itemsByName[n].id).filter(x => x != null)
  } else {
    mv.canDig = false; mv.digCost = 1000; mv.placeCost = 1000
    mv.scafoldingBlocks = []
  }
  for (const b of reg.blocksArray) if (PROTECTED.test(b.name)) mv.blocksCantBreak.add(b.id)
  for (const n of ['sweet_berry_bush', 'powder_snow', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'fire', 'wither_rose', 'farmland']) { const b = reg.blocksByName[n]; if (b) mv.blocksToAvoid.add(b.id) }
  try { require('./terrain_guard').install(bot) } catch (e_) { swallow('blocks:932', e_) }
  bot.pathfinder.setMovements(mv)
  return mv
}

module.exports = {
  placeBlock, digBlock, buildCells, clearAndFill, pillarUp, pillarDown, removeScaffold, withScaffold, scaffoldLeft,
  bridge, tillAndPlant, placeTorch, harvestTree, isTrunk, saplingOf, collectDrops, safeMovements, stats, resetStats,
  bestTool, visiblePoint, visibleFaceOf, findStands, standable, centreOn, acquire, release, isReplaceable, isAir, isLiquid, hydrated,
  readAt, blockOf, isUnknown, isSolid, isPassable, blind,
  INTERACTABLE, PROTECTED, GRAVITY, FILLER, REACH, Cancelled
}
