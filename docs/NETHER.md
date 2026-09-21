# NETHER — P5/P6. The crossing works. The front is EYES OF ENDER: blaze powder (fortress) + ender pearls (piglin bartering)
Keep this under 95 lines. Machine truth: `bots/army/jobs.json → settings.nether`, `armyctl.js events 20 "portal|nether|barter"`.
Held 09-21 06:00Z: **0 blaze rods, 0 ender pearls** after 24 h. Everything else for the dragon is ready (60 beds, 535 arrows, 34 bows, 376 diamonds).

## The two gates and the two targets
| where | what |
|---|---|
| overworld (`settings.nether.gate`) | **-327,68,-518**, axis x, 10 obsidian + 4 stone corners, **LIT and it stays lit** (closing it between trips is what made the game generate spare gates). Zone `portal` x -331..-322 / z -522..-514, 16x15 apron at y68, blueprint `bots/blueprints/nether_portal.js`, build job `base_portal` (`params.pad:false`) |
| the_nether (`settings.nether.portal`) | **-47,98,-77** — where the game put it. Arrival shelf: ONE connected ground of 383 standable cells, x -56..-30 / z -96..-72, y95-103, warped forest + our cobbled deepslate, void beneath it down to the lava sea at y31 |
| **fortress** (rcon `locate`, 09-21 06:0xZ) | **-784, ~, -592** — 899 blocks from the gate. Blaze rods live there and nowhere else |
| **bastion remnant** (same locate) | **-320, ~, -352** — 387 blocks. Piglins by the dozen, but also piglin brutes (which ARE in `util.js HOSTILE`, so our reflex fights them) and chests that anger every piglin when opened. Not the first stop |

**Paper, not vanilla** (`server/config/paper-world-defaults.yml`): `portal-search-radius 128` = **16 blocks on the Nether side**, `portal-create-radius 16`, `piglins-guard-chests true` (a container of ours OPENED or BROKEN angers every piglin within 16 — we never open one over there), `entity-activation-range.monsters 32` (a piglin further off barely ticks: stand among them), `per-player-mob-spawns true`.

## THE FIVE RULES OF A CROSSING (measured 09-20, all in `jobs_nether.js`)
1. **An unreadable world is not an empty world.** 0.6 s after the gate spits a bot out `blockAt` still gives null: wait for the block under the feet to be READABLE, then get out and CHECK, up to four times, inside the cooldown.
2. **A portal cell is a teleporter and the pathfinder does not know it.** `nether_portal` is in `blocksToAvoid` for every walk of ours (`gateGuardOn/Off`); the ONE deliberate entry lifts the guard and puts it back.
3. **Out is out, room is a luxury.** `clearOfGate` takes the nearest free cell by hand with control states (the pathfinder will not plan from inside a portal block); `spreadOut` looks for room afterwards.
4. **Standing in a lit gate is how you cross** — 80 ticks / 4 s. 12 s of nothing = a cooldown, which Minecraft resets on every tick the entity is still inside: get OUT for 15 s, then walk back in.
5. **The dimension field lags; the world does not.** `netherHere()` asks the ground (Nether biome, bedrock at y127, Nether block underfoot); no far-side work starts without it.

## HOW A BOT WALKS OVER THERE — THE EDGE DOCTRINE, AND IT BELONGS TO EVERY NETHER JOB
Every Nether walk goes through **`nTravel`**, and every `work:` mode uses it (`explore`/fortress, `pair`, `barter`, `openDoors`, `safeStep`):
* `exclusionAreasStep` prices at 100 any cell with lava or fire within 2 horizontally / 3 below / 2 above; `maxDropDown 1`; no parkour, no 1x1 towers, no digging; `allowSprinting` pinned false with a property.
* **Never a goal in a cell with no floor within 3 or one touching lava** (`nether_refused`); within 4.5 of an edge it is one hand-driven `sneakStep`, never a pathfinder route that can cut a corner over air.
* **EVERY Nether walk sneaks for its whole length, and the hold is a COUNT nothing may clear.** Two measurements, one day apart, say the same thing. (1) Sneak used to be decided ONCE from the two ends of a walk, so a hop that set off from the middle of a wide shelf and met a 1-wide arch nine blocks later walked it upright — the ground that killed Aoi, Fuuka and Koharu at -54..-55,28,-80 in two minutes on 09-20 17:17Z. (2) Asking again on a 400 ms beat is still not enough (**Erika, 09-21 05:46:19Z, "tried to swim in lava" at -51,27,-75, 31 iron + 5 diamond, four blocks into the barter lane**): a bot covers ~1.7 blocks between two samples, so "no edge within 2 of where I am now" can read false and be a fall by the next sample — and worse, `buildCells` holds sneak for a whole build while every `safeStep` inside it went through `nTravel`, which **released sneak in its own `finally`**, switching the build's protection off over and over. So: `sneakHold(bot, on)` is a counter; the build takes one, every walk inside it takes its own, and sneak only comes off when the last holder lets go. `sneakStep` and the walk watch **re-assert** it every tick, because `clearControlStates()` drops it silently. It costs about a third of the walking speed on ground that is one long rim. (Sneak proven live: Rena at -328,16,-389, 6-block drop one cell west, 3 s of forward into it → moved 0.06 blocks, `dropped 0.00`, hp 20.)
* Bridging is `moves.bridgeTo` (pathfinder scaffolding + sneak): spans ≤ 6 cells, then that span is widened and railed before the next. Only from a safe stand (`walkableArea >= 8`, no lava within 2).
* **Going DOWN is gravel, not digging** (owner 09-21 「砂や砂利を使うことでネザーでも安全に下に降りることが出来る」): water cannot be placed over there, so a level change drops GRAVEL or SAND into the column from the rim until the stack reaches the feet, then walks down it. `getGrav` / `A.gravityDrop` in `army_jobs.js` — **not yet wired into this file**, see requests below.

## WHY BARTERING NEVER TRADED, AND WHERE IT TRADES NOW (camera, 09-21 05:xxZ)
`nether_barter` crossed and came home **36 times and traded nothing**: the old code tested the bot's CURRENT position against the hub chest, and the arrival cells are 10 blocks from it. Two facts behind it, both measured by flying `SkyEye` under the bedrock roof (`ops/skyshot.js --dim=the_nether --fly=104`, plus per-column solid/air reads):
* **No mob ever spawns within 24 blocks of a player**, and no cell of the 383-cell arrival shelf is further than 24 from a squad standing on it. So no piglin can ever appear there however long we wait — and the census found none: **0 of the 6** in the region.
* All **6 piglins and 17 of the 69 zombified piglins** stand on ONE other ground: **291 standable cells, x -69..-52 / z -83..-47, y100-116**, netherrack, with natural rock at **y113** three cells over its y109/110 plateau — a roof no ghast shoots through. It is big enough that a piglin spawning 24+ blocks away can walk to a squad on it.
**A STAIRCASE IS CHEAPER THAN A ROAD, AND THE LANE WAS NEVER NEEDED (top model 09-21 07:2xZ — this replaces the lane).** The lane
was the cheapest walkable line **at the arrival level** (26+ placed blocks west along z-75, a span at y96 over the void at x-57, then the
natural ramp to y110) and it killed three bots at -51..-55,98,-75 because that line crosses a **900-cell cavern** and every pass built
blind over it. Asked as a *different question* at step 1 with the same camera — "where is the nearest cell we can STAND on within 8 of an
adult piglin, counting only blocks we must PLACE?" — the answer is not a road: from the shelf's SW corner **-55,101,-83** a **7-cell
staircase of SIX placed blocks** (`-55,101,-82 · -55,102,-81 · -55,103,-80 · -55,104,-79 · -56,105,-79 · -57,106,-79`) stands **6.4 blocks
from the piglin at -57,110,-74**. Nothing is bridged, every step is +1, and **a step up onto a block placed at your own foot level is the one
construction move that cannot drop you** — you stand on the reference block while you place it. 6 blocks against 213, no void over a lava sea.
So `work:'barter'` carries `stairSearch` + `stairTo`. **`stairSearch`** is a corridor-bounded best-first search over cells THIS bot can read,
cost = blocks that must be placed, key = (cost, then distance to the goal) so the answer is still the cheapest stair but is found walking
towards the target; unguided Dijkstra is hopeless here because walking is free and every cost level is a shell through open cavern.
**`stairTo`** hands the cell list to **`buildCells`** (`seq` = leg index, so it lays them bottom-up) and then walks what stands.
Four physics facts it cost a shift to learn, all now asserted in the search or the step:
1. **A block needs a face to be placed against.** A floor one up and one across is DIAGONAL to the floor you stand on, so an ascent over
   pure air is impossible without pillaring - which the doctrine forbids. The search only climbs where rock is already beside the step
   (`hasSolidFace`); a FLAT placement always has your own floor as its reference, so a level causeway is always plannable.
2. **A crouched body cannot climb.** Sneak holds you at the lip of your own block, which is what keeps you alive - and what makes a
   1-block rise fail. `climbStep` = one hand-driven cell with a PULSED jump (a held jump bunny-hops a bot off the far side), crouch
   dropped for that one hop ONLY when there is no drop within 1 of either cell. `safeStep` now routes every rise through it.
3. **A crouched body cannot step DOWN either**, so the search plans dy 0/+1 only. We are climbing to a plateau; a dip is crossed flat.
4. **Where a bot WAITS is a design decision.** Erika, Chika, Honoka and Chino all died at -51..-55,26..28,-75 - the lip of the cavern -
   and Chino while literally `waiting for a piglin`. Sneak stops a body that walks off a rim; it does nothing for one that is SHOVED, and
   a zombified piglin wandering past is a shove. The bot now returns to its wide arrival anchor to wait.
The goal is FROZEN per trip and is the same for every bot (`settings.nether.barterSpot.stand`): piglins wander, so re-reading "the nearest
adult" before each attempt started a new stair every time - 5 attempts, 4 blocks, nothing finished. One goal means the cells one bot places
read back as free ground to the next one's search, so the stair GROWS across trips. Reports `nether_stair` + `nether_barter`.
The old lane (`work:'barterspot'`, `nether_barter_road`, pad -65,110,-72, 652 cells / 213 to place) is **paused and off the critical path** —
it is a road we may still want for a 50-bot squad, but it is not what buys the eyes.
`work:'barter'` (`nether_barter`) wears a gold piece, drops ONE ingot at a time at an ADULT piglin within 8, picks up at radius 7 (sneak held - the stair top is a rim), and reports **`nether_barter {offered, pearls, per64, pigsSeen, loot}`** — pearls per 64 gold is the number this front is judged by. Book rate: ~1 pearl / 15.5 ingots, so 16 pearls ≈ 250 gold; the depot holds 861. It never attacks: `util.js HOSTILE` has neither `piglin` nor `zombified_piglin`, so the melee reflex leaves the 17 zombified piglins on that ground alone.

## Job type `portal` — one type, `params.work` picks the work
`params {origin, args:{axis}, buildJob, go, landing, work, at/from/route/bearing/length/width/pad, minutes, cobble, crossS, maxDeaths, obsidian, ingots, roam, stairs, maxPlace, cargo}`
* **frame** (reads 14 cells back, re-activates the frame's build job) · **light** (`strike`, success = six `nether_portal` blocks read back) · **go** (banks, kits, refuses under-equipped) · **arrival** (rules 1-3, `sealNear`, `nether_look`, optional `landing`) · **home** (`comeHome`; the whole of `nether_return`).
* **work**: `pair` · `stair` (RETIRED, owner: bridge/gravel, do not dig) · `hub` · `road` · `scout` · `fortress` · **`barterspot`** · **`barter`** · `degate`. One round trip per slice; the trip always ends at the gate.
* **death rule**: `maxDeaths` deaths in 30 min and the job pauses itself. A bot that died declines 3 min.
* EVENTS: `portal_lit · portal_through · gate_stuck · nether_sealed · nether_look · nether_landing · nether_refused · pair_built · nether_pass · portal_back · gate_removed · nether_scout · nether_sighting · **nether_barter** · **barter_chest_near**`.
* **A `portal` job needs `priority` (not `prio`) or the dispatcher never staffs it** — 09-21 05:4xZ cost 15 min to that.
* **The gate is a queue.** 4+ bots on one portal job jam each other at the frame (`portal_light_failed {sharingCell:1, why:"stood in the gate for 30 s and stayed in overworld"}`, `cannot reach the gate`). 2-3 bots per portal job, `crossS:60`. Six cells at ~4.5 s each should carry 6 bots per 4.5 s — the measured throughput does not, and that is the next code gap for x50.

## What stands / what is paused
| job | state |
|---|---|
| `nether_barter_road` (work `barterspot`) | **PAUSED 09-21 07:2xZ, THREE deaths on one design** (Erika 05:46, Chika 05:52, Honoka 07:10, all at -51..-55,28,-75 in the lava sea under the same cavern). Off the critical path: the stair replaced it |
| `nether_barter` (work `barter`) | **ACTIVE, 2 bots, the whole front.** Off-road: nearest adult piglin -> `stairTo` -> trade -> wait. `maxPlace:24`, `stairs:4`, `minutes:12`, `cobble:96`, `maxDeaths:2` |
| `nether_fortress` (6 bots) | paused. Re-activate only after the lane proves the continuous-sneak doctrine with 0 deaths; `explore` already hops 16 blocks through `nTravel` and bridges with `bridgeAhead` |
| `nether_pair`, `nether_dead_frames` | PAUSED 09-21 05:4xZ (top model): `pair` declined 10x for `obsidian 6/10 (depot: 0)` and `dead_frames` 4x for `no sword` — neither could run, and both were queueing for the gate the barter lane needs. Gate pairing is off the critical path (40+ crossings work) |
| `nether_hub` (paused) | 413/413 cells, chest -37,98,-79 and table -37,98,-73 stand. **The chest is the one container that constrains bartering**; if a spot inside 32 of it is ever wanted, take the chest home first |
| `nether_landing_*`, `nether_road_xp`, `nether_stair`, `nether_gate_*` | paused, superseded or finished |

## THE THREE RULES THE TWO DEATHS BOUGHT (09-21 06:1xZ — read these before touching any Nether job)
1. **A chunk that reads null is UNKNOWN, and unknown is never work, floor or safe.** Asserted in one place (`knownAt` = `bot.world.getColumnAt` **and** `blockAt`, the loaded-check of `ops/skyshot.js survey()`; `knownRing` = that cell's floor, body space and neighbours) and inherited by every routine: `loadedAt`, `cellOK` (an unreadable cell is no longer counted as **done**), `safeStep`, `sneakStep` and `nTravel` all refuse it. `buildCells` waits until **60 %** of its cells are readable, up to 60 s, and reports `nether_unloaded {cells, of, waitedS}` when they never arrive.
2. **Minimal kit through the gate** (owner 「もったいな」: 115 deaths = 1519 iron-equivalents + 580 diamonds; the two on the lane = 46 iron + 7 diamonds in six minutes). `swapDown` fetches the iron tier FIRST, then wears it and deposits the diamond tier by hand into a tools chest — `A.bank` force-keeps the best tool of each class and better armour, and `A.stash` skips tools by name, so neither can bank a tier *down* (request upstream: `bank(bot, keep, {maxTier})`). `pair` and `degate` keep a diamond pickaxe; obsidian comes out for nothing else. Every crossing now reports `portal_kit {worth:{iron,diamond}, worthBefore, swapped, stillRich}`. Target ~15 iron, 0 diamonds.
3. **A span over the void is a library call.** `spanAhead` finds the head of the road we already have, measures the gap with **`voidSize`** (`jobs_cavity.js`, the terrain engineer's ONE implementation, required lazily) and refuses to bridge a `cavern` or anything that `touchesLava` (`nether_gap`), then lays **one span of ≤ 6 with `moves.bridgeTo`** (`nether_span`) — the method that has never lost a bot here. `buildCells` widens and rails that span from the spine before the next is opened. Note: `bridgeTo` drops sneak in its own `finally`; it is put straight back on.

## THE LAVA SEA UNDER -51..-55,~,-75 HAS KILLED FIVE (09-21 05:46 / 05:52 / 07:10 / 07:23 / 07:28Z)
Erika, Chika, Honoka, Chino and one `nether_return` bot all ended at y26-30 under the SAME rim: the lip of the 900-cell cavern the old lane
crossed. Causes, all now fixed: `cellOK()` counted an unreadable cell as **done** while `noFloor`/`edgeNear` read it as a drop, so a bot
placed blocks it could not read back (`unloaded: 1053 of 1053` 30 s after arrival) - rule 1 above; a pathfinder GOAL on the far plateau,
which `nTravel` accepts (rock under the piglin, no lava, chunks loaded) and then routes at the void between the two grounds; and standing
still at the rim, where a passing zombified piglin is a shove and sneak protects nothing. **No Nether job may give the pathfinder a goal its
own search has not reached over readable blocks.**

## NEXT, in order
0. **Re-lay the void span with `bridgeTo`, then re-run the lane.** Everything else on this list is downstream of it.
1. **Finish the lane and pad → first measured pearls** (`nether_barter` back to active, 6-8 bots). Target 16+ pearls = 12 eyes with spares.
2. **The Nether front door.** The owner (09-21): 「ネザー側のポータル周りが本当にあれすぎ」. The arrival shelf must be made as good as the overworld apron — ONE height on solid rock, 15x15, every cell supported (the camera draws floating cells RED), kerb on the boundary, torches on a pitch of 8, nothing within 3 of a portal face, the half-built pair frame at -41,102,-75 (8 obsidian) and the dead frame's 5 leftovers recovered. `node ops/skyshot.js -50 -70 64 /tmp/n.png --dim=the_nether --fly=104` and `node bots/army/mapshot.js <bot> 40` both work under the roof now — read one before and after every pass.
3. **The fortress road** to -784,-592: the same lane standard (one height, 3-5 wide, walled/roofed where a ghast can see it, lit, kerbs over drops), level changes by gravel drop, not by digging. Tell the road engineer this line so both dimensions get one trunk-road design.
4. **Ghasts.** Two bots were fireballed overnight. A shield is in the kit but is never RAISED (`bot.activateItem(true)`), so it blocks nothing. Either raise it when a ghast is within 48 in the open, or roof the lane. Measure which.

## OPEN REQUESTS to other owners (one implementation of everything)
* **terrain engineer**: the connected-air measurement the owner asked for (`{cells, box, h, openToSky, touchesLava}`, capped flood fill) — `jobs_nether.js` wants it in `bridgeAhead` (a fixed 4-cell span is a guess) and in pad/lane siting instead of counting `overVoid` after the fact. This shift's lane was sited by exactly that measurement done OFFLINE with the camera; the runtime needs the same function, not a second one.
* **`lib/moves.js` owner**: `gravelDown` (the owner's gravity-block descent) as a shared primitive — `getGrav`/`A.gravityDrop` live in `army_jobs.js` and this file must not copy them.
* **army.js / armyctl owner**: `rescue` must refuse off-overworld bots (two scouts were killed by operator rescues on 09-20); dispatcher eligibility by `dim`; `bank`/`chestsOf`/`ours()` keyed by dimension.
