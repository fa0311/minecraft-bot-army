# NETHER — P5 stage 1: the gate, the way home, and what stage 2 needs
Keep this under 70 lines. Machine truth: `bots/army/jobs.json → settings.nether`, `armyctl.js events 20 "portal|nether"`.

## The gate (overworld)
| what | where / who |
|---|---|
| zone | `portal`, x -331..-322 / z -522..-514, y68 (docs/WORLD.md) — flat plains 18 blocks N of the mine head, off every pad, road, field and keep-out |
| frame | -328..-325, y68..72, z -518 (4x5, axis x): 10 obsidian, the 4 corners any stone; the bottom row lies FLUSH in the apron so a bot walks straight in |
| blueprint | `bots/blueprints/nether_portal.js` — plinth, paved apron, 3 clear cells front and back, 4 torches, **stepped stone shoulders** (a block is placed against the TOP FACE of the block below it and that face is only visible from eye height above it, so an isolated 1-wide post can never be topped out from the apron: the shoulders are the stair the builder climbs). `geom()` is the ONE description of the working parts, read by the build job and the `portal` job alike |
| build job | `base_portal` (type `build`, **`params.pad:false`**). Not optional: the generic PAD RULE puts `air` cells into the portal columns and the build job would break the lit portal every round. The 6 inner cells carry no blueprint cell at all for the same reason |
| light + cross | `base_portal_go` (type `portal`) · way home: `nether_return` (type `portal`, `dim:"the_nether"`, `settings.nether.returnJob`) |

## Job type `portal` — what it does and what it VERIFIES (`bots/skills/lib/jobs_nether.js`)
`params {origin, args:{axis}, buildJob, go, shell, return, cobble, crossS, maxDeaths}`; `job.names` = exactly ONE bot when `go:true`.
1. **frame** — reads all 14 frame cells back. A gap → `portal_frame_incomplete`, the frame's own build job is re-activated (that is the repair), decline 6 min. It never builds the frame itself.
2. **light** — `A.obtain('flint_and_steel')` (iron_ingot + flint; no flint anywhere → `knapGravel`, 10 % a block, `flint_knapped`). Clears the 6 inner cells, strikes the TOP FACE of a bottom obsidian from each stand. Success = **six `nether_portal` blocks read back** → `portal_lit`; else `portal_light_failed` + count + reason, ticket after 3 tries, decline 15 min.
3. **go** (`go:true`, one pinned bot) — banks, kits up, `cobble` blocks of **any stone sort** + torches + food + the best sword; refuses to cross under-equipped. Steps OUT of a gate before stepping in (Minecraft RESETS the portal cooldown every tick an entity is still inside — standing still never fires). → `portal_through {from,to,pos,portal,cells}`.
4. **arrival** — **nobody walks.** `sealNear` closes every lava/fire face within arm's reach and puts a floor under the bot's feet (`nether_sealed {blocks}`), then `nether_look {lava,mobs,drop,unsafe}`, then (unless `shell:false`) a 5x5x3 stone shell with a 1x2 door gap, **still without walking** (`nether_shell {placed,lava,outOfReach,gap,box}`). Whatever is out of reach is left for an expedition that knows the terrain.
5. **home** — `comeHome`: the gate in view, else ONE bounded walk to `settings.nether.portal`, step out, step in, verify the overworld → `portal_back`. `nether_lost` when there is no gate and no route.
6. **return job** (`return:true`, `dim:"the_nether"`) — `comeHome` and nothing else; in the overworld it declines and frees its bot at once. This is what the dispatcher hands a bot that is in the Nether with no job there.
7. **death rule** — a scout that dies after the expedition started declines the job 30 min (`portal_scout_died`) and the count goes ON THE BOARD. At `maxDeaths` (2) the crossing job **pauses itself** (`portal_unsafe`): no third scout until an operator makes the arrival safe and clears `settings.nether.deaths`.

## MEASURED 2026-09-20
| when | what |
|---|---|
| 11:48Z | `base_portal` **build_done** — 14/14 frame cells verified (10 obsidian + 4 stone corners), 4 torches, apron flat at y68 |
| 11:50Z | **`portal_lit`** — 6/6 inner cells read back as `nether_portal` on the first strike; `settings.nether.gate = [-327,68,-518]` |
| 11:56 / 12:02 / 12:05Z | **`portal_through`** x3 (Chino, Hotaru, Koharu): -327,68,-518 → **the_nether -38,98,-76**. ViaBackwards (bots 26.1 / Paper 26.2) takes the dimension change cleanly — no kick, no stuck loading, chunks in ~2 s |
| 11:56 / 12:05Z | `nether_look`: lava within 16, 0 mobs. The far gate generated **on a ledge near the Nether roof (y98-100) over open lava** |
| 11:59 / 12:02Z | **two scouts died** ("tried to swim in lava", "fell from a high place") — both in a step that MOVED the builder. The decline rule fired both times, no loop. Shell + seal are travel-free since; `settings.nether.deaths = 2` now **stops any third crossing** |
| 12:05-12:12Z | **`portal_back` still NOT verified.** Koharu stood in the far gate and stayed (cooldown reset — fixed); while she stood, the hung watchdog declined her job and the dispatcher gave her `tidy`, which dug her to y123 under the Nether roof with OVERWORLD coordinates. `armyctl.js rescue` brought her home |
| 12:19Z | `nether_return` on the board and registered; its overworld no-op path verified live (4 bots took it, declined at once, went back to work). **0 of 50 heartbeats are off overworld** |

## OPEN — what the return trip and stage 2 need, and from whom
| # | file (owner) | request |
|---|---|---|
| 1 | `bots/army/dispatcher.js` | **Eligibility by dimension** (in hand). A job is overworld unless it carries the top-level field `dim`. A bot whose `hb.dim` is not overworld is eligible ONLY for jobs with the matching `dim`, is never counted as idle, never pulled into a squad, never given the fallback sponge; with no such job it gets `settings.nether.returnJob`. MEASURED: without it a scout in the Nether was handed `tidy` and dug herself in under the roof at y123. |
| 2 | `bots/skills/lib/army.js` | (a) export `dimOf(bot)`; (b) `travel(bot, target, {dim})` refuses with `wrong_dim` — no path attempt — when the bot is not in that dimension; (c) the KEEP-OUT rule and the `musterPos()` homeward bias are OVERWORLD-ONLY (a Nether column inside an overworld keep-out box is costed 100 for nothing); (d) `bank`/`withdraw`/`chestsOf`/`scanChests` return `wrong_dim` off the overworld — the depot index is overworld coordinates; (e) `ours()`/`ourBlock()` key cells by `x,y,z` alone, so an overworld structure's cell matches a Nether position: key them with the dimension. **Done 12:1xZ: `portal` is in the hung watchdog's `STILL_OK` (a bot standing in a gate is not hung).** |
| 3 | `bots/skills/lib/army_jobs.js` | `muster`, `withHandover` (bank-on-handover, respawn-bed click, `upTheStairs`) and `underground()` all assume the overworld: skip them when the bot is not there. |
| 4 | `bots/army/armyctl.js` · `ops/*` | `field` / `status.sh` print the dimension when it is not overworld. |

Then stage 2 is an ordinary squad job (`fortress` in `jobs_nether.js`, same file, same pattern):
- **a safe arrival first.** This gate opens over lava at y98. The next trip's only job is to stand still, seal, and floor a 5x5 landing; only then does anyone walk. If the arrival stays lethal, break the far gate's obsidian and re-light a gate at a chosen spot (the overworld gate then re-links to it).
- **find the fortress** — from the hub, a bearing at portal level; `nether_bricks` within 64 is the signal. The route is a 2-wide stone catwalk built once (doctrine Q2) and reported as a zone — never a private tunnel.
- **blaze rods (≥12)** — a spawner is a 9x9x9 box: wall it to a slit, fight from behind stone with a bow, bank every trip. `produces:['blaze_rod']` so head-count follows `settings.targets`.
- **fire resistance** — nether wart + a brewing stand (3 stone + 1 blaze rod) + water bottles. Gold armour makes piglins neutral and is cheaper than potions; the mine already banks gold.
- **safety** — ghasts kill by knock-back into lava: never walk within 4 of an open ledge, always carry 128 stone, bank before every crossing (keep_inventory is OFF).
