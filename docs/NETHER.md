# NETHER — P5 stage 1: the gate, and what stage 2 needs
Keep this under 60 lines. Machine truth: `bots/army/jobs.json → settings.nether`, `armyctl.js events 20 "portal|nether"`.

## The gate (overworld)
| what | where / who |
|---|---|
| zone | `portal`, x -330..-323 / z -522..-514, y68 (docs/WORLD.md) — flat plains 18 blocks N of the mine head, off every pad, road, field and keep-out |
| frame | -328..-325, y68..72, z -518 (4x5, axis x): 10 obsidian, the 4 corners any stone; the bottom row lies FLUSH in the apron so a bot walks straight in |
| blueprint | `bots/blueprints/nether_portal.js` — plinth (grade + 1 below), paved 8x9 apron, 3 clear cells in front and behind, 4 torches. `geom()` is the ONE description of the working parts (inner cells, the obsidian to strike, the stands) and both the build job and the `portal` job read it |
| build job | `base_portal` (type `build`, `params.pad:false`). **`pad:false` is not optional**: the generic PAD RULE puts `air` cells into the portal columns, and the build job would then break the lit portal on every round. The 6 inner cells carry NO blueprint cell at all for the same reason |
| light + cross | job `base_portal_go` (type `portal`, `bots/skills/lib/jobs_nether.js`) |

## Job type `portal` — what it does and what it VERIFIES
`params {origin, args:{axis}, buildJob, go, cobble:128, crossS:90}`; `job.names` = exactly ONE bot when `go:true`.
1. **frame** — reads all 14 frame cells back from the world. A gap → `portal_frame_incomplete` + the frame's own build job is re-activated (that is the repair) + the job declines itself for 6 min. It never builds the frame itself.
2. **light** — `A.obtain('flint_and_steel')` (iron_ingot + flint; no flint anywhere → `knapGravel` breaks natural gravel, 10 % a block, `flint_knapped`). Clears the 6 inner cells, then strikes the TOP FACE of a bottom obsidian from each of the 4 stands, both bottom cells. Success = **six `nether_portal` blocks read back** → `portal_lit`; else `portal_light_failed` with the count and the reason, a helpdesk ticket after 3 tries, decline 15 min.
3. **go** (`go:true`, one pinned bot) — banks, kits up (`A.kitUp` risk), 128 cobblestone + 32 torches + food + the best sword; refuses to cross under-equipped. Stands in the gate (goal dropped, re-centred every second) until `bot.game.dimension` changes → `portal_through {from,to,pos,portal,cells}`. On the far side: waits for chunks, finds the portal body, `nether_look {lava,mobs,drop,unsafe}`; if unsafe a 5x5x3 cobblestone shell with a 1x2 door gap goes up around it (`nether_shell {placed,lava,gap,box}`, placed = read back). Then back through → `portal_back`. The gate stands lit and the job pauses itself; bump `rev` to send the next expedition.
4. **death rule** — a bot that dies after the expedition started declines the job for 30 min (`portal_scout_died`). One bad gate can never burn a bot in a loop.

Board: `settings.nether = {gate:[x,y,z], axis, lit, portal:[x,y,z] NETHER coords, hub:[x,y,z], shell, through, back, scoutRev}`.

## OPEN — what stage 2 (fortress, blaze rods, brewing) needs, and from whom
**Nothing in the code base except `jobs_nether.js` knows that a second dimension exists.** A bot in the Nether that the dispatcher
hands an ordinary job will walk towards overworld coordinates in the Nether. Until the four items below are done, the crossing is
safe ONLY with `job.names` pinned to one bot at a high priority — that is why the `portal` job refuses to cross otherwise.

| # | file (owner) | request |
|---|---|---|
| 1 | `bots/army/dispatcher.js` | **Eligibility by dimension.** `hb.dim` is already in every heartbeat. A bot whose `dim` is not `overworld` is eligible ONLY for jobs with `params.dim` equal to that dimension (and for the `portal` job that owns it); it is never counted as idle, never pulled into a squad. Without this a returning expedition gets a farm job 60 blocks under the lava sea. |
| 2 | `bots/skills/lib/army.js` | **`travel` must know where it is.** (a) export `dimOf(bot)` (= `bot.game.dimension` without the `minecraft:` prefix); (b) `travel(bot, target, {dim})` refuses with `wrong_dim` (no path attempt, one report) when `dimOf(bot) !== dim`, and `A.travel` defaults `dim` to the job's dimension; (c) the KEEP-OUT rule and `musterPos()`-driven `homeward` bias are OVERWORLD-ONLY — today a Nether column inside an overworld keep-out box gets cost 100 for no reason; (d) `bank`/`withdraw`/`chestsOf`/`scanChests` return early with `wrong_dim` off the overworld (the depot index is overworld coordinates); (e) `ours()`/`ourBlock()` key cells by `x,y,z` only, so an overworld structure's cell can match a Nether position — key them with the dimension or gate them on overworld. |
| 3 | `bots/skills/lib/army_jobs.js` | `muster`, `withHandover` (bank-on-handover, respawn-bed click, `upTheStairs`) and `underground()` all assume the overworld: skip them when `dimOf(bot) !== 'overworld'`. |
| 4 | `bots/army/armyctl.js` · `ops/*` | `field` / `status.sh` print the dimension when it is not overworld; `look`/`mapshot` already work off a bot's own chunks and need nothing. |

Then stage 2 can be an ordinary squad job (`fortress` in `jobs_nether.js`, same file, same pattern):
- **find the fortress** — from the hub, walk the Nether on a bearing at portal level, `nether_bricks` within 64 is the signal; the roof of the Nether and the lava sea are the hazards, so the route is a 2-wide cobble catwalk built once (doctrine Q2) and reported as a zone.
- **blaze rods (≥12)** — a blaze spawner is a 9x9x9 box: wall it to a 1-wide slit, fight from behind cobble with a bow, bank every trip. Needs `produces:['blaze_rod']` so head-count follows `settings.targets`.
- **fire resistance** — nether wart from the fortress stairs + a brewing stand (3 cobblestone + 1 blaze rod) + water bottles (glass = sand, smelted). Gold armour makes piglins neutral and is cheaper than potions: the mine already banks gold.
- **safety** — ghasts kill by knock-back into lava: never walk within 4 of an open ledge, always carry 128 cobble, and bank before every crossing (keep_inventory is OFF).
