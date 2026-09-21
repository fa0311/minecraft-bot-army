# END — pearls, eyes, the stronghold, the dragon (P6/P7)
Owner's deadline (09-21): **the Ender Dragon dies today.** Code: `bots/skills/lib/jobs_end.js` (job type `end`, switched by
`params.work`). Board state: `bots/army/jobs.json → settings.end`. Nothing here uses `/give`, `/tp`, creative or `/locate`.
Read `docs/PLAYBOOK.md` lines "Stronghold" / "Dragon" / "Pearls" for the raw Minecraft numbers; this page is the ORDER OF WORK.

## The chain, and where it can stall
```
ender pearls ─┐
              ├─> eye_of_ender ──> throw & triangulate ──> stronghold ──> 12 frames ──> END PORTAL ──> dragon
blaze rods ───┘   (1 pearl + 1 powder;   (2 bearings)      (staircase)    (12 eyes)                   (crystals first)
                   1 rod = 2 powder)
```
**Three possible pearl sources, ONE blaze source.** Pearls: `work:'enderhunt'` (this file) · piglin bartering
(`jobs_nether.js`, ~1 pearl per 15.5 gold; the army holds 861 gold = ~55 pearls, by far the best rate) · an **Expert cleric**
at the plains village sells pearls for 5 emeralds (PLAYBOOK "Village value"; the army holds 29 emeralds and `village_trade` is
running — `jobs_industry.js`, not this file). Blaze rods have NO second source — a Nether fortress is the only one, so
**the fortress is the single point of failure of the whole deadline** and belongs to the Nether engineer.
Budget: 12 frames minus ~1.2 pre-filled + 20 % throw breakage + spares = **16 eyes = 16 pearls + 8 blaze rods**.

### Measured 09-21 06:19-06:51Z (first live rounds of `end_hunt_1`) — **0.0 pearls per bot-hour over ~2.3 bot-hours**
The job runs clean: 10 hunters on the ground, hp 19-20, **0 deaths, 0 errors**, spread across the shelf, all reporting. What it has
not yet done is kill one. Three causes, in the order they were found and fixed:
1. **The ground was unreachable.** The first post (-350,-335, south of the base) is cut off by the ravine keep-out and the gully:
   7 of 10 hunters reported `no route to the hunting ground` (06:48Z). The post is now the **dark grass shelf WEST of the wall,
   `-432,63,-466`, radius 45, ground y62-63, 69 blocks from muster** — flat grass, read-only walkable, and the commute costs one
   minute of a ten-minute night instead of five. `no_route` went to 0.
2. **Every fight aborted in 250 ms.** `it teleported out of reach` x30: the abort was a flat 28 blocks measured before the bot had
   taken a step, while endermen were opening at 28-45. The gate is now "clearly farther than where it started" (`d0 + 16`, never
   under 36) **and only after 4 s of closing**.
3. **One target, in a loop.** Kanade's slice closed `seen:121 fought:121 killed:0` in 3 minutes — the same enderman 42 blocks off,
   re-opened every 250 ms. A target that beats a hunter twice is now dropped for a minute (`bot.__endGaveUp`) and a failed fight
   costs 1.5 s of quiet. (Both fixes went live through `armyctl.js patch end_hunt_1 '{"rev":N}'`: a hot lib edit only reaches a bot
   at its NEXT slice, and a slice runs up to 15 minutes — bump the rev when a fix must be in the field now.)
Encounter rate, measured by probe: **2-3 endermen loaded per hunter at night** on that shelf, typically 28-45 blocks off, plus
9-11 phantoms and ~20 zombies (a real night, so the spawns are real). Endermen are ~2.4 % of overworld monster spawns, so this is
what the surface gives. **Expect low single-digit pearls per night from 10 bots — a backup, not the plan.**

### Earlier measurements 09-21 06:2x-06:4xZ
- The squad reaches the ground, spreads into patches and patrols: 8 bots × 5-7 min slices, positions -340..-387 / -294..-382.
- **0 endermen in fight range on the surface, day or night.** A live probe of a hunter at 06:41Z (`POST :3000/cmd` eval) found
  two endermen loaded and BOTH underground (-375,**-43**,-380 and -339,**52**,-438 — the ravine) while the bot stood at y69. The
  night surface is a poor enderman ground; the dark under the base is full of them. The job now counts and reports what it can
  see but will not fight (`ender_far {outOfReach, lowestDy}`) instead of calling the ground empty.
- **Two of the three test nights were skipped** — see docs/BUGS.md 09-21 06:2xZ (~55 s and ~3 min out of ~9.6 min). The THIRD
  ran its full length (06:47:08-06:57:20Z, t 12069 -> 23300, nobody lay down), so `needsNight` does keep a night when no bot's
  6-hourly bed turn falls at that dusk — the skip is intermittent, not constant. **And a full night with 10 hunters still gave 0
  kills**, so the low rate is the ground truth, not an artefact of short nights. Bartering stays the pearl plan of record.

## 1. PEARLS — `work:'enderhunt'` (job `end_hunt_1`)
Night hunt in the open, 120 blocks S of the base wall on dark grass at `-350,65,-335` (grass y65, outside the base torch grid;
W and NW of the base is a y92-101 stone hill, S-SE is swamp/water — neither is hunting ground).
- `params.needsNight:true` is **mandatory**: `settings.nightSkip` is on and the sleeper snaps the night away in ~20 s otherwise.
  The flag only keeps the SLEEPER up; the dispatcher's own `NIGHT_SKIP` stays true, so every `when:"day"` job keeps working. A
  real night costs the army nothing but mobs at the base, which `guard_bed` and the combat reflex already handle.
- The job must sit at **priority ≥ 96**: under 96 the dispatcher's `holdFast`/`drainable` guards refuse to take bots off producing
  squads, and the job stands staffed `-` with no log line at all (measured 09-21 06:16Z).
- Squad geometry: the ground is cut into `ceil(bots/2)` patches and hunters are seated by roster index, so they work **in pairs**
  (PLAYBOOK: 40 hp, 7 damage a hit — one bot trades badly, two end it in under three seconds).
- The fight (what a good player does, `howto ender_pearl`): never in water, never in the rain (an enderman teleports out of every
  fight in the rain and the pearl is lost); fight under a 2-high ceiling where one is in reach — an enderman is 2.9 tall and
  cannot follow; break off at `minHp`. A bot with NO armour (see `bare` below) only engages from hp ≥ 18 and breaks at 12.
- **The gaze guard is lifted for exactly one target.** `army.js safePitch` makes it impossible for any bot to rest its crosshair
  on a CALM enderman's eyes — that is what stops 50 bots provoking them all day, and it is right everywhere except here. The
  hunter re-stamps `bot.__armyEnders` (army.js's own 400 ms calm-list cache) with a FUTURE timestamp and its target removed, so it
  can aim at its one enderman and still avert its eyes from every other one in the field. Restored in `finally`.
  `army.js kill()` also refuses to start a fight with an enderman, so the hunt drives `bot.pvp` itself (`fightEnder`).
- Measurement: every slice reports `ender_hunt {seen, fought, killed, broke, pearls, min, perBotH}` — **pearls per bot-hour is the
  number this job is judged on**. `ender_dry` means no enderman ever came into view: the ground is too bright, too small, or the
  night was skipped.

## 2. EYES — `work:'eyes'` (job `end_eyes`)
One bot at the hall table; crafts every `eye_of_ender` the depot allows (`A.obtain` solves rod → powder → eye) and banks it.
Pauses itself at `params.target` (16). With an ingredient missing it reports `eyes_blocked` naming exactly what, and rests the
JOB (`restUntil`, 8 min) rather than declining bot after bot — the first live round churned 3 bots in 15 s before that was added.
**Known wart (patch for the army.js owner):** `categoryOf` lists `ender_eye`, not the real item name `eye_of_ender`, so eyes bank
into the BUILD chests among the stone. Harmless (the chest index is category-blind for `withdraw`/`stockOf`), but wrong.

## 3. THE STRONGHOLD — `work:'stronghold'`
The thrown eye is the only legitimate compass. Ring 1 lies 1280-2816 blocks from (0,0) and the base is 548 from it, so the
stronghold is **700-2300 blocks out** — this is an expedition, not an errand.
1. **Bearing.** Hold an eye, `bot.activateItem()`, then read the THROWN ENTITY's displacement over ~20 ticks — never the bot's
   yaw. Recorded on the board as `settings.end.throws[]` (6 h memory, last 12).
2. **Base line.** With no crossing yet the bot walks `leg` (320) blocks ACROSS the bearing (perpendicular, sign by roster seat so
   the squad splits both ways) and throws again.
3. **Fix.** `t = ((x2−x1)·dz2 − (z2−z1)·dx2) / (dx1·dz2 − dz1·dx2)`, stronghold ≈ P1 + t·d1. Bearings within ~7° of each other
   are refused as noise (`|den| < 0.12`). Written to `settings.end.fix`; event `sh_fix`.
4. **Approach** in `hop` (120) legs, read-only. Within `near` (90) one confirming throw: an eye that **dips** (`dy < 0`) says the
   stronghold is under our feet.
5. **Down.** `sniffStronghold` looks 40 blocks for stone bricks / iron bars / a portal frame first. Only then the staircase:
   1 forward and 1 down per step, body AND head cell opened, **the six neighbours of every cell read before the pick touches it**
   (lava behind a wall is what kills a digger), a torch every 5 steps, and the way back up is the stair itself. Never straight
   down under the feet. The job carries a `plan` because the descent IS the work here (movement doctrine rule 4).
6. A camera confirmation of what the eyes found is allowed once the bots are close (`ops/skyshot.js` pattern) — that is
   perception, not gameplay. `/locate` is not.

### 3b. THE WAY DOWN — `work:'way'` (job `end_way`) — the stronghold is under a river
Camera read 09-21 15:4xZ (SkyEye, `findBlocks` from 96,30,1514): the confirm eye dipped in a river 23 deep (bed y39). **Portal room:
x93..109 z1511..1521, floor y-43 (stand on y-42), 12 `end_portal_frame` at y-40 — 102,*,1515..1517 · 103..105,*,1514 · 103..105,*,1518 ·
106,*,1515..1517; portal 3x3 = 103..105 x 1515..1517 over a lava pool at y-42; 1 frame pre-filled (102,-40,1517); silverfish spawner
100,-40,1516 on the dais stair.** Stronghold extent x41..113 z1456..1583 y-49..3. On the board: `settings.end.room` (+ `stand`
108,-42,1515 — never the centre: it is the portal over the lava) via `end_way.params.room`.
The way: a covered, lit, 2-wide **switchback** from DRY land on the north bank — door **116,96,1494** (walk in from 115,96,1494),
flights of 12 along x (z1494/95 east, z1497/98 west, shared wall z1496), landings of 5, down to y-42, then a level tunnel S along
x120/121 to z1515 and W through the room's east wall at 109,-42,1514..1515 (223 walk cells, 3631 blueprint cells). Every cell was
read from a camera volume dump before it went on the board: no water/lava within 2, no stronghold brick until the room wall, 1 gravel,
1 cave cell (scratch tools: `vol.js` dump, `sw.js` legs + checker, `search.js`). It is cut by the Nether's route cutter —
`jobs_nether.js` exports `route.{work,walk,plan}` (one implementation; in the overworld it also plugs WATER behind a cell), head in
`settings.end.way`. When the head reaches the end the next slice is the proof walk door -> room -> door (`end_way_walked`), then the
job pauses itself. `portal` and `dragon` walk this way in and out (`viaWay`/`wayHome`) — the stronghold is ~2 000 blocks from the base.
**Cut and proven 09-21 16:5xZ** (Hazuki, Kotori, Aoi; ~65 min of which most was the 2 000-block commute; 0 deaths): Aoi walked
door -> room in 97 s and back in 113 s and read all 12 frames from the room (1 holds an eye) -> **11 eyes still needed**. Lessons: a stone
pickaxe lasts 131 blocks, so the kit is `params.picks` 8 (the first two bots ran out at seq 117 and 168 and walked home); two bots on
the route deadlock at the landings (the route cutter's "mate in the cell ahead" wait has no cap -> `hung` -> released) — ONE bot cuts;
a bare job never takes a bot that is already far from the depot with diamonds (it is released, `end_way` "carrying valuables").

## 4. THE PORTAL — `work:'portal'`
Walk the room, `noteFrames` writes every `end_portal_frame` to `settings.end.room`, then for each frame whose `eye` property
reads false: eye in hand, `activateBlock`, **read the property back**. ~10 % of frames generate pre-filled. When the 12 are full
the portal lights itself; the job verifies by finding a real `end_portal` block, writes `settings.end.lit` and pauses itself.
Before going in: a bed and a chest with spare kits in the portal room (keep_inventory is OFF, and a bot that dies in the End
respawns at its overworld bed — the portal room is the re-kit point).

## 5. THE DRAGON — `work:'dragon'` — THE ONLY JOB THAT IS NEVER `bare`
Dragon 200 hp, no scaling with player count. 6-10 bots in their best gear: diamond armour, sword/axe, bow + ≥ 64 arrows,
64 blocks, water bucket, food, beds. **Order, and it is not negotiable:**
1. **Through.** Stand in the `end_portal` cell until the dimension changes (`end_arrived`). Arrival is the obsidian platform at
   (100,49,0) and it may hang over the void — bridge west towards (0,·,0) before anything else.
2. **EVERY CRYSTAL FIRST.** 10 crystals on pillars at y 76…103 on a ~43-block circle heal the dragon 1 hp / 0.5 s within 32
   blocks, and the perch chance is `1/(3 + crystals alive)` — with crystals up the fight cannot end. Any projectile pops one;
   the squad shoots them from the ground (`shoot`: charge ~1.15 s, aim `+0.6 + 0.035·distance` for arrow drop, verify the entity
   is gone). Blast power 6: **never stand adjacent to one.** The y79 and y82 pillars are **caged in iron bars** — a climber
   pillars up BESIDE (never under) the cage, breaks one bar and shoots from 5+ blocks. Those report `crystal_caged`.
3. **The head, on the perch.** Arrows bounce off a perched dragon and non-head hits do ¼ damage, so the melee pairs wait at the
   fountain and swing at the head while it is down (`d.position.y < 72` within 20 blocks). It takes off again after ~50 damage
   per perch, so expect ~4 perches. Swing no faster than one per 650 ms (sword cooldown 12.5 ticks, mob hit-immunity 10 ticks).
4. **Beds are the fast weapon but the expensive one** (the army holds 66). A bed placed and struck while the dragon perches does
   ~half its health, but the blast is power 5 and the bot must be behind an obsidian/end-stone block. `params.beds` carries them;
   the melee phase above is the SAFE default and is what runs unless an operator asks for the bomb.
5. Standing rules for everyone in the End: never in the dragon's breath (3 hp/s, 6 hp/s in the fireball cloud — armour and
   shields do not help), never fight near the edge, and **never look at an enderman** — the gaze guard is on for every bot except
   a hunter with a chosen target, and in the End that guard is the difference between a fight and a rout.

## Live check-list for an operator
```
node bots/army/armyctl.js stock "ender_pearl|blaze_rod|blaze_powder|eye_of_ender"   # the whole critical path in one line
node bots/army/armyctl.js events 30 "ender_|eyes_|sh_|crystal|dragon_"              # what the squads actually did
node bots/army/armyctl.js job end_hunt_1 active     # the hunt is `when:"any"` while it is being proven; `night` once it is
```
`params.bare:true` marks every job here that has not yet carried a crew with 0 deaths (owner 09-21 — an experiment goes out
without valuables). It is removed by hand, job by job, as each design proves itself. The dragon squad never carries it.
