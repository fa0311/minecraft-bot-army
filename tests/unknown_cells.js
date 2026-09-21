'use strict'
// tests/unknown_cells.js — THE TEST THAT WOULD HAVE CAUGHT THE TWO LAVA DEATHS (owner 09-21).
// Run:  ARMY_TEST=1 node tests/unknown_cells.js
// No server, no mineflayer, no network: a fake bot over a fake world in which one region reads NULL, because that is
// what `bot.blockAt()` answers for an UNLOADED chunk. The bug class this pins down: null was read as "air", so a cell
// the bot could not see counted as empty / passable / already done, and a job decked the rim of a cavern and walked off it.
//
// The contract, asserted below:
//   1 the predicates REFUSE an unknown cell: never air, never passable, never solid, never replaceable, never standable.
//   2 nothing reports DONE for an unknown cell: digBlock says `unloaded`, never `{ok:true, already:true}`;
//     clearAndFill lists it as failed instead of skipping it like air.
//   3 a dig whose NEIGHBOUR is unknown is refused (`blind_neighbour`) — that neighbour may be the lava.
//   4 every one of those refusals raises a `blind_action` event, so `armyctl.js events 20 blind_action` sees it.
// ARMY_TEST=1 keeps swallow.blind() out of the live ledger (bots/army/results.jsonl); the bot's own event hook still fires.

process.env.ARMY_TEST = '1'
const { Vec3 } = require('../bots/node_modules/vec3')
const BL = require('../bots/skills/lib/blocks.js')
const U = require('../bots/skills/lib/util.js')

let fails = 0; let checks = 0
function ok (cond, what) { checks++; if (cond) return; fails++; console.log('  FAIL  ' + what) }
function eq (got, want, what) { ok(got === want, what + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')') }

// ---------------------------------------------------------------- the fake world
// Everything with z >= 1 is an UNLOADED chunk: blockAt returns null there, exactly like mineflayer.
const LOADED = (p) => p.z < 1
const TYPES = { air: 0, stone: 1, water: 2, lava: 3, grass_block: 4 }
function mk (name, p) {
  const empty = name === 'air' || name === 'water' || name === 'lava'
  return {
    name,
    position: p.clone ? p.clone() : new Vec3(p.x, p.y, p.z),
    type: TYPES[name],
    boundingBox: empty ? 'empty' : 'block',
    shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]],
    diggable: !empty,
    hardness: 1.5,
    harvestTools: null,
    digTime: () => 300,
    getProperties: () => ({})
  }
}
// ground at y <= 63 is stone, above is air — except the column at x=6 which is a cavern rim (air all the way down)
function nameAt (p) {
  if (p.x === 6) return 'air'
  return p.y <= 63 ? 'stone' : 'air'
}

const events = []
const bot = {
  username: 'TestBot',
  state: { job: 'unknown_cells_test', task: 'test' },
  entity: { position: new Vec3(0.5, 64, 0.5), effects: {}, onGround: true },
  inventory: { items: () => [], emptySlotCount: () => 36 },
  entities: {},
  heldItem: null,
  registry: { blocksByName: {}, itemsByName: {}, blocksArray: [] },
  world: { raycast: () => null },
  pathfinder: { isMoving: () => false, setGoal () {}, movements: null },
  digTime: () => 300,
  canDigBlock: () => true,
  blockAt (p) { return LOADED(p) ? mk(nameAt(p), p) : null },
  __logEvent (e) { events.push(e) }
}
const at = (x, y, z) => new Vec3(x, y, z)
const blinds = () => events.filter(e => e.type === 'blind_action')

// ---------------------------------------------------------------- 1. the predicates refuse an unknown cell
console.log('1. predicates')
const known = BL.readAt(bot, at(0, 64, 0))
const unknown = BL.readAt(bot, at(0, 64, 5))
eq(known.known, true, 'readAt on a loaded cell is known')
eq(known.name, 'air', 'readAt reports the block name')
eq(unknown.known, false, 'readAt on an unloaded cell is NOT known')
eq(unknown.block, null, 'an unknown read carries no block')
eq(BL.isUnknown(unknown), true, 'isUnknown(read of an unloaded cell)')
eq(BL.isUnknown(null), true, 'isUnknown(null) — a raw null read is unknown too')
eq(BL.isUnknown(known), false, 'isUnknown(read of a loaded cell)')

eq(BL.isAir(unknown), false, 'UNKNOWN IS NOT AIR  <- this single coercion caused the two lava deaths')
eq(BL.isAir(null), false, 'isAir(null) is false')
eq(BL.isAir(known), true, 'a loaded air cell still is air')
eq(BL.isPassable(unknown), false, 'UNKNOWN IS NEVER PASSABLE')
eq(BL.isPassable(null), false, 'isPassable(null) is false')
eq(BL.isPassable(known), true, 'a loaded air cell is passable')
eq(BL.isSolid(unknown), false, 'UNKNOWN IS NEVER SOLID (nothing is placed against it)')
eq(BL.isSolid(BL.readAt(bot, at(0, 63, 0))), true, 'loaded stone is solid')
eq(BL.isReplaceable(unknown), false, 'UNKNOWN IS NEVER A VALID PLACE TARGET')
eq(BL.isReplaceable(null), false, 'isReplaceable(null) is false')
eq(BL.isReplaceable(known), true, 'a loaded air cell may be placed into')
eq(BL.isLiquid(unknown), false, 'an unknown cell is not claimed to be liquid either')

// standing: floor known + solid, but the head cell unloaded -> never standable
eq(BL.standable(bot, at(0, 64, 0)), true, 'a loaded cell over stone is standable')
eq(BL.standable(bot, at(0, 64, 5)), false, 'UNKNOWN IS NEVER STANDABLE')
eq(U.isUnknownAt(bot, at(0, 64, 5)), true, 'util.isUnknownAt sees the unloaded cell')
eq(U.isAirish(bot, at(0, 64, 5)), false, 'util.isAirish refuses an unloaded cell')
eq(U.isSolid(bot, at(0, 64, 5)), false, 'util.isSolid refuses an unloaded cell')

// ---------------------------------------------------------------- 2+3. nothing is reported DONE, and a blind dig is refused
;(async () => {
  console.log('2. digBlock never calls an unknown cell done')
  const d1 = await BL.digBlock(bot, at(0, 63, 5), { lock: false, own: true, requireHarvest: false })
  eq(d1.ok, false, 'digging an UNLOADED cell fails')
  eq(d1.reason, 'unloaded', 'and the reason is `unloaded`, not `already`')
  ok(!d1.already, 'an unloaded cell is never reported as `already` (= done)')

  console.log('3. a dig with an unknown NEIGHBOUR is refused (the lava it cannot see)')
  // target (3,63,0) is loaded stone; its +z neighbour (3,63,1) is in the unloaded region
  const d2 = await BL.digBlock(bot, at(3, 63, 0), { lock: false, own: true, requireHarvest: false })
  eq(d2.ok, false, 'the dig is refused')
  eq(d2.reason, 'blind_neighbour', 'reason `blind_neighbour`: we cannot tell lava from rock behind that face')

  console.log('4. clearAndFill lists unknown cells instead of silently skipping them')
  // one loaded air cell (skipped, correctly) and two unloaded ones (must be reported)
  const res = await BL.clearAndFill(bot, { x1: 0, y1: 70, z1: 0, x2: 0, y2: 70, z2: 2 }, null, { dig: { lock: false, own: true } })
  eq(res.dug, 0, 'nothing was dug')
  eq(res.failed.length, 2, 'both unloaded cells come back as FAILED, not as cleared')
  ok(res.failed.every(f => f.reason === 'dig:unloaded'), 'each carries reason dig:unloaded')

  console.log('5. every blind refusal raised a blind_action event')
  const b = blinds()
  ok(b.length >= 3, 'at least one blind_action per distinct signature (got ' + b.length + ': ' + [...new Set(b.map(e => e.where))].join(', ') + ')')
  ok(b.some(e => e.where === 'blocks:digBlock/plug'), 'the unknown neighbour was reported')
  ok(b.some(e => e.where === 'blocks:clearAndFill'), 'the unknown clear cell was reported')
  ok(b.every(e => e.bot === 'TestBot' && e.why), 'every event names the bot and says why')
  // throttle: the same signature does not fire again inside 5 min
  const before = blinds().length
  await BL.digBlock(bot, at(3, 63, 0), { lock: false, own: true, requireHarvest: false })
  eq(blinds().length, before, 'the same signature stays quiet for 5 min (no event storm)')

  console.log(fails ? '\nunknown_cells: ' + fails + ' FAILED of ' + checks : '\nunknown_cells: all ' + checks + ' checks pass')
  process.exit(fails ? 1 : 0)
})().catch(e => { console.log('unknown_cells: THREW ' + (e && e.stack || e)); process.exit(1) })
