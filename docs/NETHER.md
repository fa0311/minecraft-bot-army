# NETHER — P5. Stage 1 is CLOSED (gate lit, round trip verified); stage 2 is written below as board-ready jobs
Keep this under 80 lines. Machine truth: `bots/army/jobs.json → settings.nether`, `armyctl.js events 20 "portal|nether"`.

## The gate (overworld)
| what | where / who |
|---|---|
| zone | `portal`, x -331..-322 / z -522..-514, y68 (docs/WORLD.md) — flat plains 18 blocks N of the mine head, off every pad, road, field and keep-out |
| frame | -328..-325, y68..72, z -518 (4x5, axis x): 10 obsidian, 4 stone corners; the bottom row lies FLUSH in the apron, so a bot walks straight in |
| blueprint | `bots/blueprints/nether_portal.js` — plinth, paved apron, 3 clear cells front and back, torches, **stepped stone shoulders** (a block goes against the TOP FACE of the one below it and that face is only visible from eye height above it, so an isolated 1-wide post can never be topped out from the apron: the shoulders are the stair the builder climbs). `geom()` is the ONE description of the working parts, read by the build job and the `portal` job alike |
| build job | `base_portal` (type `build`, **`params.pad:false`**) — not optional: the generic PAD RULE puts `air` cells into the portal columns and would break the lit portal every round. The 6 inner cells carry no blueprint cell at all for the same reason |
| light + cross | `base_portal_go` (type `portal`) · way home: `nether_return` (type `portal`, `dim:"the_nether"`, `settings.nether.returnJob`) |
| far side | **the_nether -37..-38, 98..100, -76** (`settings.nether.portal`), landing box x -39..-35 / z -78..-74 at y98 |

## Job type `portal` (`bots/skills/lib/jobs_nether.js`) — what it does, what it VERIFIES
`params {origin, args:{axis}, buildJob, go, landing, return, cobble, crossS, maxDeaths}`; `job.names` = exactly ONE bot when `go:true`.
1. **frame** — reads all 14 frame cells back. A gap → `portal_frame_incomplete`, the frame's own build job is re-activated (that is the repair), decline 6 min. It never builds the frame itself.
2. **light** — `A.obtain('flint_and_steel')` (iron_ingot + flint; no flint anywhere → `knapGravel`, 10 % a block). Clears the 6 inner cells, strikes the TOP FACE of a bottom obsidian from each stand. Success = **six `nether_portal` blocks read back** → `portal_lit`.
3. **go** — banks, kits up, `cobble` blocks of **any stone sort** + torches + food + best sword; refuses to cross under-equipped. Steps OUT of a gate before stepping in (Minecraft RESETS the portal cooldown every tick an entity is still inside — standing still never fires) → `portal_through`.
4. **arrival — NOBODY WALKS.** `sealNear` closes every lava/fire face within arm's reach and floors the bot's own cell; then `nether_look`; then `landing`: a 5x5 floor, walls 2 high, a 1x2 door gap, torches — all at arm's length with `place:{noMove:true}`, what is out of reach is COUNTED, never chased. The verdict is READ BACK: `safe` = every floor cell solid **and** no lava/fire within 5 of any landing cell. One attempt; `nether_unsafe` if it still reads lethal.
5. **home** — `comeHome`: the gate in view, else ONE bounded walk to `settings.nether.portal`; step out, step in, verify the overworld → `portal_back`. Shared by the crossing job and the return job.
6. **return job** (`return:true`, `dim:"the_nether"`) — `comeHome` and nothing else; in the overworld it declines 45 min and frees its bot at once.
7. **death rule** — a scout that dies after the expedition started declines 30 min and the count goes ON THE BOARD (`settings.nether.deaths`). At `maxDeaths` the crossing job **pauses itself** (`portal_unsafe`): no next scout until an operator makes the arrival safe and clears the count.

## MEASURED 2026-09-20
| when | what |
|---|---|
| 11:48Z | `base_portal` **build_done** — 14/14 frame cells verified, 4 torches, apron flat at y68 |
| 11:50Z | **`portal_lit`** — 6/6 inner cells read back as `nether_portal` on the first strike |
| 11:56 / 12:02 / 12:05 / 12:29 / 12:30Z | **`portal_through`** x5. ViaBackwards (bots 26.1 / Paper 26.2) takes the dimension change cleanly — no kick, no stuck loading, chunks in ~2 s |
| 11:59 / 12:02Z | two scouts died ("tried to swim in lava", "fell from a high place") — **both in a step that MOVED the builder**. Landing and seal are travel-free since; the decline rule fired both times, no loop |
| **12:29:54 / 12:30:51Z** | **`portal_back` VERIFIED twice** (Kanade, 0 deaths): the_nether -38,98,-76 → overworld **-326,69,-518**. `base_portal_go` then auto-paused itself. **STAGE 1 CLOSED** |
| 12:29:39 / 12:30:18Z | `nether_landing`: `floor 0, walls 0, torches 3-4, outOfReach 1, holes 2, hotNear 0, safe:false`. The arrival is **better than feared** — no lava or fire within 5 of the landing, drop 0, the ground was already solid but for **2 floor holes, one of them out of arm's reach** (`place_failed unreachable -35,97,-74`). Nothing was walked to; the scout came home and said so |
| 12:30:15Z | a stale-cache loop: `A.settings()` caches 5 s, so the `back` a bot had just written was not there on its next slice and the gate sent it round again. Fixed — `netherOf()` reads the board, and `st.phase` is the belt to that brace |
| 12:30:23Z | `off_world {what:"dig_out_roof", dim:"the_nether"}` + `stranded` at area 120: the **escape doctrine ran in the Nether** and cut a staircase into the bedrock roof. `skyAbove()` can never be true under that roof, so a bot there is always "roofed in" — army.js item (e) below |

## OPEN — requests to other file owners
| # | file | request |
|---|---|---|
| 1 | `dispatcher.js` | **Eligibility by `dim`** (in hand). A job is overworld unless it carries the top-level field `dim`. A bot whose `hb.dim` differs is eligible ONLY for matching jobs, never idle, never squadded, never given the fallback sponge; with no such job it gets `settings.nether.returnJob`. |
| 2 | `lib/army.js` | (a) `dimOf(bot)`; (b) `travel({dim})` refuses `wrong_dim` without pathing; (c) KEEP-OUT rule + homeward bias overworld-only; (d) `bank`/`withdraw`/`chestsOf`/`scanChests` refuse off-overworld; (e) **`skyAbove`/`digOut`/`stepDown` must not run off the overworld** — under the Nether's bedrock roof every bot reads "roofed in" and cuts a staircase (measured 12:30:23Z); (f) `ours()`/`ourBlock()` key cells by `x,y,z` alone, so an overworld cell matches a Nether position. *(`portal` in `STILL_OK`: done.)* |
| 3 | `lib/army_jobs.js` | **Done 12:2xZ (by me, in the three places I was given):** `overworld(bot)` helper; `muster` stands still off-overworld instead of walking to the muster slot; `withHandover` skips bedtime, canteen, pocket-banking, handover-banking, the respawn-bed click and `upTheStairs` off-overworld. Proven live: Kanade banked **nothing** between 12:30:15 and 12:30:51 in the Nether and banked 208 cobblestone at 12:30:58, seven seconds after coming home. |

## GATE CENSUS BY CAMERA, 15:4xZ (perception, not gameplay: `SkyEye` tped with rcon into both dimensions, `findBlocks`)
`settings.nether.gates`, written by the census:
| dim | at | frame | lit |
|---|---|---|---|
| overworld | **-328,70,-518** | 10 | **yes** — and it is the ONLY gate in the overworld. The spare at -284,84,-607 is gone (job `nether_gate_spare_n607` finished it); there is **no gate at all** near -130,-240 or -203,-338 |
| the_nether | **-36..-45, 100, -76..-80** | 28 + 19 + 9 obsidian in three overlapping clusters, at least one lit (6 cells at -43/-44,100,-80) | yes |

**What that proves:** the bots that reported `portal_through to:"overworld"` at -134,-242 and -203,-338 **never transferred** — no
gate exists there. `bot.game.dimension` is briefly falsy while a respawn packet is processed, `dimOf` returned `'unknown'`, and
`'unknown' !== 'overworld'` read as "we moved". Fixed: `dimChanged()` counts only a **known** dimension that differs, so a
half-read packet can never again be taken for a crossing (that is what produced `pair_probe groundY:86` — a Nether column measured
on overworld ground — and the whole "revolving door" story).

**Still to do, in order:** (1) nothing to sweep in the overworld; (2) one bot through the home gate with the fix in, `clearOfGate`
off the arrival cell inside the 4 s cooldown; (3) read-only walk to the partner point **-41,-65** (`work:'pair'` is written: probe,
platform 7x9 first, frame with an inner column exactly on -41,-65, light, then three verified round trips); (4) only then take the
stray Nether frames at -36..-45,100,-76..-80 down, one obsidian first, and bank it (25 in the depot already).

## THIS IS PAPER, NOT VANILLA (owner 15:1xZ; `server/config/paper-world-defaults.yml` + `server/spigot.yml`, all at defaults, untouched)
| setting | value | what it means for us |
|---|---|---|
| `portal-search-radius` / `portal-search-vanilla-dimension-scaling` | 128 / true | the search on the **Nether** side is 128/8 = **16 blocks**. A partner gate further than that from the computed spot, or unlit, and the game **creates a new one** — that is exactly how the spare gate at -284,84,-607 appeared while we were closing ours between trips. |
| `portal-create-radius` | 16 | the second overworld gate must be **>= 320 overworld blocks** from -327,-518 (= 40 Nether blocks, well past 16+create margin) or the two will share one far side. |
| `piglins-guard-chests` | true | opening or breaking a chest near piglins angers **every** piglin in sight — and the hub's chest is at `settings.nether.hub.chest`. `work:'barter'` refuses to trade within 24 of it; loot is banked at home. |
| `entity-activation-range.monsters` | 32 | a piglin further than 32 from a bot barely ticks and will never finish examining the gold: the barter squad walks **into** the range instead of waiting outside it. |
| `nether-ceiling-void-damage-height` | disabled | the bedrock roof is not lethal here — worth knowing, since our gate sits at y98 under it. |
| `per-player-mob-spawns` / `mob-spawn-range` | true / 8 | spawning follows the squad, so a lit, roofed hub and a lit stair really do stop it. |

**THE HOME GATE NOW STAYS LIT** (owner: "ゲートを空けたり閉めたりしてるから沢山ゲート生成されてるやん"). `closeGate` is opt-in
(`params.closeGate:true`) and `nether_gate_out` is off the board; the piglin trickle is the lesser evil at MSPT 33-45. A bot in the
Nether will not step into the far gate while `settings.nether.lit` is false — it waits and asks for a relight (`home_gate_out`)
rather than make the game generate another gate.

## THE WAY DOWN — `nether_stair` (RUNNING, the top model's call 13:5xZ)
Blueprint `nether_stair.js`: a 2-wide, 3-high, roofed, lit corridor from the hub's z- doorway at the_nether **-37,98,-81** down to
**y33**, 66 steps / 1330 cells. One blueprint serves both cases — the build routine **digs** the `air` cells where there is
netherrack and **places** the `stone` ones where there is void, so a half-rock, half-void slope needs no decision. Nobody walks a
ledge and no ghast sees in. Progress is `settings.nether.stair`; when `left` and `unloaded` both reach 0 it writes `floorHub`.
* **first passes: 490 of 1330 cells done, 43.7 and 20.7 blocks/bot-min, 0 deaths.**

## HOW A BOT WALKS IN THE NETHER (the fix for six identical deaths)
Six bots "tried to swim in lava" between 13:36 and 13:37Z — one cause, not bad luck. Lava is in `blocksToAvoid`, so the pathfinder
never routes INTO it; it routes ALONGSIDE it, cuts diagonal corners over it and drops 3-4 onto a ledge beside it. Every Nether walk
now goes through `nTravel`, which installs on that bot's movements:
* an `exclusionAreasStep` pricing at **100** any cell with lava or fire **within 2 horizontally, 3 below or 2 above** (from a lava
  set refreshed per trip, so flow that arrived after planning is seen next hop);
* `maxDropDown = 1`, no parkour, no 1x1 towers, no digging, and **`allowSprinting` pinned to false with a property** because
  `A.travel` re-asserts it from the larder on every trip. `netherWalkOff` takes it all back off when the bot is home.
* bridging only from a **safe stand** (`walkableArea >= 8` and no lava within 2) — never off the edge of a 1-wide ledge.
**Result: 0 deaths on the far side since it went in.**

## THE FAR GATE IS ON A LEDGE — that is the whole blocker (measured 13:4xZ)
Probe from Juri at the_nether -43,98,-80: **42 of 81 sampled columns within 12 blocks of the gate have no floor within 4 below.**
The gate generated on a narrow shelf near the Nether roof; the main floor is ~65 blocks down (soul sand at y33, ancient debris at
y102-107 above). Everything that looked like a code problem this hour was this:
* `routed:false` on every bearing, `walked 5-19` — the read-only pathfinder is right, there is nowhere to walk.
* 10 deaths in 45 min, and every fall death is at **y24-38** — bots that did get out fell off the shelf.
* The hub made it worse before it made it better: a 9x9 walled room with one door was a cage (`stranded {dim:"the_nether"}` x6 at
  -34..-35,98,-74..-79). Now cut open: **four plain 2-wide x 2-high doorways, no gate, a stone landing and a torch outside each**
  (`nether_door {doors:4, opened:13, landed:4}`), and scouts do step out — to the edge of the shelf, and no further.

**THE DECISION THIS NEEDS (not more scouting):** either
1. **a stair down** — a `work:'stair'` job from the hub's z- doorway to the Nether floor, built once with carried stone, walled and
   lit: a reusable road (doctrine Q2), ~65 blocks of descent, the honest cost of a gate that landed badly; or
2. **relocate** — a second overworld gate 128+ blocks away in x or z (its Nether exit lands 16+ blocks off, on different ground).
   Cheaper to try first, and the present gate stays as a fallback. **Do not break the far obsidian**: a broken gate re-links the
   overworld side somewhere unknown.
My recommendation is **2 first, 1 if the new exit is no better** — one build job either way, and the fortress hunt is unblocked the
moment a scout can walk.

## THE GATE IS OUT BETWEEN TRIPS (owner 13:0xZ, low TPS)
A lit portal spawns zombified piglins **in the overworld**, outside the mob cap, and the bots rightly never attack a neutral mob —
74 of them stood round the base. So the gate burns only while a trip is out. `closeGate` takes ONE frame obsidian out with a
diamond pickaxe (the whole surface goes out at once), reads the six inner cells back as **air**, and puts the obsidian straight
back, so the next trip only has to strike it. Water does not put a portal out and nothing can be placed inside a portal block;
this is the only move that can be proved from the world. `settings.nether.lit` is the truth, never an intention.
* automatic: the bot that comes home **last** does it — while any heartbeat still reads `dim: the_nether` the gate stays lit, because it is somebody's way back (`anyoneOverThere`). `params.closeGate:false` keeps a gate burning on purpose.
* by hand: job `nether_gate_out` (`params.close:true`), paused on the board, re-activate to put it out at any time.
* **verified 13:12:25Z:** `portal_out {was:6, cells:0, frameBack:true, gaps:0}`; probe: all six inner cells `air`, 14/14 frame cells right, 1 piglin left within view of the gate.
* **`settings.restartPending`:** while it is true no bot crosses (decline 5 min) — the code owner sets it right before a server restart and clears it after.

## STAGE 2 — what is BUILT, what is measured, what is next
All four works are one job type (`portal`, `params.work`), one round trip per slice, and nobody is ever left on the far side:
cross → seal → landing → work for `params.minutes` → **home**. The dispatcher exempts type `portal` from its `dim` filter, so a
squad is safe on a `work` job; an exploratory crossing (`go` without `work`) still needs exactly one pinned bot.

| step | job | result (MEASURED, read back from the world) |
|---|---|---|
| 1 landing | `nether_landing_2` (paused, done) | **`safe:true`** at 12:49:43Z. Box x -39..-35 / z -78..-74, y97-99: 0 open holes, 0 lava or fire within 5, 4 torches, `coveredVoids 2`. 4 trips, 0 deaths, ~4 s away per trip |
| 2 hub | `nether_hub` (paused, built) | **`left:0` of 413 cells**, `placed 22, dug 11`, **76.6 blocks/bot-min**, 26 s away. 9x9x5 walled + roofed + lit room (7x7 floor = 8 bots) around the gate; **chest `-37,98,-79` and crafting table `-37,98,-73` STAND** (`chestStands`/`tableStands` read back) and are registered under `settings.nether.hub` ONLY. **1 death** (Kanade, "fell from a high place") — cause found and fixed, see below |
| 3 road | `nether_road_xp` (PAUSED) | bearing x+, 64 blocks from the hub door `-32,98,-76` to `31,98,-76`, 768 cells. First squad pass: 0 blocks, **1 death** (Erika, "was killed" — a mob, inside the gate room). Two flaws found and fixed; not re-run |
| 4 scout | not yet run | `work:'scout'` walks the finished road inside its own box, looks 96 blocks and writes `settings.nether.sightings`. **No fortress sighted yet** — the road it is meant to walk does not exist |

**Three bugs this stage paid for, all fixed:**
1. **`A.placeHard` walks.** Its remedy loop (`noref` → build a support column, `unreachable` → reposition, high cell → pillar + scaffold) sits OUTSIDE the `place:{noMove:true}` it forwards to blocks.js. Kanade died at 12:55:43Z with `steps:0` — she never took a step of ours. The Nether now uses `placeStill` = `blocks.placeBlock(..., {noMove:true})` and nothing else.
2. **The landing step clobbered the hub.** It wrote `settings.nether.hub = [x,y,z]` over the hub's whole record, and the road squad arrived to "hub.outside is not set". The landing writes `landing*` keys only.
3. **An unloaded cell read as a finished cell.** `bot.blockAt` gives null outside loaded chunks and null read as "already right", so the first road squad came home with `left:0` on a road it had not laid one block of. Passes now report `done / left / unloaded / of`.

**Open on the road:** a bot standing in the gate room was killed by a mob. The hub has ONE door gap and no gate; before the road is re-run the hub wants a **fence gate or a 2-block dog-leg at its door**, and the road squad wants the same at every 16 blocks. That is the next change in `nether_hub.js`, not a reason to send another squad first.

## BOARD-READY — the blaze job, for the moment a fortress is sighted
Not yet on the board: `settings.nether.sightings` is empty, because step 4 needs step 3. When a scout reports `nether_sighting kind:'fortress'`, put this and tell the code owner — blaze rods are the owner's next milestone.
```json
{"id":"nether_blaze","type":"portal","priority":93,"front":"base","status":"active","when":"day","bots":4,"shiftMin":20,
 "site":[-326,69,-518],"produces":["blaze_rod"],"minBots":2,"maxBots":6,
 "plan":"zone portal: blaze rods (>=12) from the fortress spawner at <x,y,z from settings.nether.sightings>. Wall the 9x9x9 spawner box down to a 1-wide slit from OUTSIDE, fight from behind stone with the bow, bank every trip through the gate.",
 "params":{"blueprint":"nether_portal","origin":[-326,68,-518],"args":{"axis":"x"},"buildJob":"base_portal",
           "go":true,"landing":true,"work":"blaze","at":"<spawner x,y,z>","minutes":6,"cobble":256,"crossS":45,"maxDeaths":2}}
```
`work:'blaze'` is the one handler still to write in `jobs_nether.js` (same pattern as `hub`: a blueprint `nether_slit` of the wall cells, `buildCells`, then a bow loop from the slit). **Carry list for every Nether job** — fire resistance does not exist before blaze powder, so it is armour and distance: iron/diamond helmet, chestplate, leggings, boots, **shield**, best sword, bow + 64 arrows, 16 cooked food, **128+ blocks of any stone**, 32 torches, a pickaxe. Bank everything else first: keep_inventory is OFF and a ghast kills by knock-back, not by damage.

Then: blaze rods → blaze powder → a brewing stand (3 stone + 1 blaze rod) + nether wart from the fortress stairs = the army's first fire resistance, and the eyes of ender of P6. Gold armour makes piglins neutral and is cheaper: the mine already banks gold.
