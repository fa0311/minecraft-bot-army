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

## STAGE 2 — board-ready (write these jobs when items 1-2 above are in)
**Carry list for every Nether job** (fire resistance does not exist before blaze powder, so it is armour and distance): iron or diamond helmet/chestplate/leggings/boots, **shield**, best sword, bow + 64 arrows, 16 cooked food, **128+ blocks of any stone**, 32 torches, a pickaxe, flint and steel. Bank everything else first — keep_inventory is OFF and a ghast's knock-back is what kills, not its damage.

1. **`nether_landing_2`** (type `portal`, `dim:"the_nether"`, 1 bot, `params {landing:true, origin/args as base_portal_go}`) — a second, cheap pass at the arrival: the 2 remaining floor holes at x -39..-35 / z -78..-74, y97, from the other side of the gate. Only if it still reads unsafe is a **relocation** right: a second overworld gate **128+ blocks away in x or z** (base-plan slot near x -200 or z -650) puts its Nether exit **16+ blocks off** the present one, on different ground. Do not break the far obsidian first — a broken gate re-links the overworld side somewhere unknown.
2. **`nether_road_<bearing>`** (type `build`, `dim:"the_nether"`, blueprint `road` on a Nether origin, 4-6 bots) — **movement stays read-only, so what is built is a reusable road, not a tunnel a bot dug for itself**: a 2-wide walled walkway 2 high, floor + both parapets at head height, torches every 8, running from the landing on one bearing. Every corridor the army will use twice gets one; `no_route` is reported, never dug around.
3. **`nether_fortress`** (type `scout`-like, in `jobs_nether.js`, `dim:"the_nether"`, 4 bots on +x/-x/+z/-z) — walk the finished road, then the frontier at portal level; `nether_bricks` within 64 is the signal, the hit is written to `settings.nether.fortress` and the road job is extended towards it. Never within 4 of an open ledge; a ghast in view = stone between us and it first.
4. **`nether_blaze`** (`dim:"the_nether"`, 4-6 bots, `produces:['blaze_rod']`, target ≥12) — a spawner is a 9x9x9 box: wall it down to a 1-wide slit from outside, fight from behind stone with the bow, bank every trip through the gate. Blaze rods → blaze powder → a brewing stand (3 stone + 1 blaze rod) and the eyes of ender of P6.
5. **`nether_wart`** — the fortress stairs; wart + a brewing stand + water bottles (glass = sand, smelted) is the first fire resistance the army will ever have. Gold armour makes piglins neutral and is cheaper: the mine already banks gold.
