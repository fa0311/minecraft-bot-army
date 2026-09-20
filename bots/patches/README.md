# node_modules patches (movement / physics)

Re-apply after every `npm install`: `sh /root/workspace/bots/patches/apply.sh`
Pristine copies of the patched files live in `patches/orig/` (used to regenerate the diffs).

---

## 01 — prismarine-physics: server-exact player half width  ← **the "bots stand still" bug**

**Symptom.** A bot walks into a wall / a shore block / any block face and freezes there
forever. Velocity reads exactly `(0,0,0)`, `onGround` is stuck `false`, the bot never falls
and never moves again. Team skills then declare it "stuck in water" and force a reconnect;
it respawns on the same spot and freezes again. Travel that does not end in a freeze is
still very slow, because `onGround === false` makes prismarine-physics use *airborne*
acceleration (0.02) instead of ground acceleration.

**Root cause.** The server builds the player AABB from a **float** width (`0.6f`), i.e.
half width `Math.fround(0.3) === 0.30000001192092896`. prismarine-physics used the
**double** `0.3`, which is *smaller*. So whenever the client clipped the player flush
against a block face, the server's AABB stuck `1.19e-8` **inside** that block,
`ServerGamePacketListenerImpl.isPlayerCollidingWithAnythingNew()` fired, and the server
**silently** (no log line!) teleported the player back to `lastGood{X,Y,Z}` with zero
delta movement. mineflayer's clientbound-`position` handler then zeroes the velocity and
sets `onGround = false`, so gravity never accumulates — and the pathfinder, seeing
"airborne", keeps `forward`+`jump` pressed and drives straight back into the face.
Result: a self-sustaining rubber-band loop at 20 Hz, forever.

**Measured proof** (probe bot, block at x ∈ [-23,-22], bot approaching from −x):

| client `pos.x`                         | server `maxX = x + fround(0.3)` | server reaction |
|----------------------------------------|----------------------------------|-----------------|
| `-23.3` (what `0.3` half width yields)  | `-22.99999998807907` → inside    | **teleport back** |
| `-23.30000001192093` (`fround(0.3)`)    | `-23` exactly → not inside       | accepted |
| `-23.3000001` (with margin)             | `-23.0000001`                    | accepted |

Also: `bot.physicsEnabled = false` → 0 teleports in 3 s; physics on → 39 teleports in 2 s
(the corrections are a *reaction* to our packets, not a server-side pin).
And `37 + Math.fround(0.3) === 37.30000001192093` — exactly the z the jammed lake bots showed.

**Fix.** `playerHalfWidth: 0.3` → `Math.fround(0.3) + 1e-7`. The `1e-7` is a safety margin
against floating-point drift in the clipping arithmetic; it widens the player by 2.2e-7
blocks, which changes nothing about which gaps the bot fits through.

## 02 — mineflayer: NaN/Infinity rotation guard

**Symptom.** `<Bot> lost connection: Invalid move player packet received` in `server/console.log`,
over and over, always the same handful of bots.

**Root cause.** Paper disconnects a client the moment one move packet contains a non-finite
value (`ServerGamePacketListenerImpl.containsInvalidValues`, which checks `Float.isFinite`
on yaw/pitch). Upstream mineflayer guards `x/y/z` on `position` / `position_look`, but
**not** yaw/pitch, and the `look` packet is unguarded entirely. Verified: the protodef
serializer happily writes `0x7fc00000` for a NaN `f32`. One NaN reaching `bot.entity.yaw`
(e.g. `bot.lookAt()` on a point with a NaN component, or `Math.atan2` of a NaN delta)
poisons `bot.entity.yaw` **and** `lastSentYaw` permanently, so the bot is kicked on
every reconnect.

**Fix.** Guard all three senders (`sendPacketPosition`, `sendPacketLook`,
`sendPacketPositionAndLook`), reject non-finite arguments in `bot.look()`, and *self-heal*
`bot.entity.yaw/pitch` + `lastSentYaw/Pitch` back to finite values instead of staying
broken. Emits `bot.emit('nonFiniteRotation', {yaw, pitch})` so it can be observed.

## 03 — prismarine-physics: vanilla collision tolerance (`AABB.computeOffset*`)  ← **the residual rubber-band**

**Symptom.** After 01, most bots moved fine, but a few still froze against a wall with
`correctionsPerSec ≈ 20`, `onGround false`, `velocity (0,0,0)` — the same loop as 01, in places
where 01's margin should have covered it (247 `unwedge` events in ~20 min, mostly builders).

**Root cause.** A bot resting flush against a face sits at `pos.x = blockMinX - halfWidth`.
Recomputing its AABB gives `maxX = pos.x + halfWidth`, and in doubles that is **not** exactly
`blockMinX` — it overshoots by one ULP (measured: `7.1e-15` at x ≈ -64). `computeOffsetX` only
clamps when `other.maxX <= this.minX`, so a 7e-15 overlap counts as "already inside", the clamp
is **skipped entirely**, and the client walks a full movement step (~0.0255 blocks) into the
block. The server rejects that and teleports back — the 20 Hz loop again.
Vanilla does not have this problem because `Shapes.collide` / `VoxelShape.collideX` use a
**1.0E-7 tolerance**: a face up to 1e-7 behind the player's max still clamps (to a slightly
negative offset, i.e. it pushes back out).

**Fix.** Add the same `COLLIDE_EPS = 1e-7` tolerance to `computeOffsetX/Y/Z`. Verified:

| situation | before | after |
|---|---|---|
| 7.1e-15 overlap, requested `dx = +0.0255` | `+0.0255` (walks in) | `-7.1e-15` (blocked) |
| approach from 0.5 away, `dx = +0.2` | `0.2` | `0.2` |
| moving away, `dx = -0.2` | `-0.2` | `-0.2` |
| genuinely 0.1 inside a block, `dx = +0.2` | `0.2` | `0.2` (can still escape) |

01 and 03 are both needed: 01 keeps the *resting* position outside the server's float AABB,
03 stops the client stepping through a face it is already touching.


---

## Not a cause (measured, do not "fix" again)

- **Event-loop starvation / sharding.** Mean loop lag 0–8 ms, max 25 ms across all 10 shards
  while 28 bots ran their roles. `tickTimeout = 12` and 3 bots/shard are fine.
- **Water physics / bubble columns / `waterlogged` / 1.21 movement-efficiency attributes.**
  prismarine-physics' water code is correct. The bots "stuck in water" were wedged against
  the *shore block*, which is bug 01.
- **Missing `teleport_confirm` / the 1.21.2+ `hasHorizontalCollision` flag bit.** Both are
  sent correctly; `undefined` serialises to `0`, which is what a still-standing client sends.
