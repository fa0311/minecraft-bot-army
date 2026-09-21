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
**Two independent pearl sources, one blaze source.** Pearls: `work:'enderhunt'` (this file) AND piglin bartering
(`jobs_nether.js`, ~1 pearl per 15.5 gold; the army holds 861 gold). Blaze rods have NO second source — a Nether fortress is the
only one, so **the fortress is the single point of failure of the whole deadline** and belongs to the Nether engineer.
Budget: 12 frames minus ~1.2 pre-filled + 20 % throw breakage + spares = **16 eyes = 16 pearls + 8 blaze rods**.

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
