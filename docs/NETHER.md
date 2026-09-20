# NETHER — P5. The crossing works; the gates are being PAIRED (overworld/8) so a return can never land anywhere else
Keep this under 90 lines. Machine truth: `bots/army/jobs.json → settings.nether`, `armyctl.js events 20 "portal|nether|pair"`.

## The two gates
| where | what |
|---|---|
| overworld (`settings.nether.gate`) | **-327,68,-518**, axis x, frame 10 obsidian + 4 stone corners, **LIT and it stays lit** (owner 15:2xZ: closing it between trips is what made the game generate spare gates). Zone `portal` x -331..-322 / z -522..-514, apron flat at y68, the bottom row flush so a bot walks straight in. Blueprint `bots/blueprints/nether_portal.js` (`geom()` is the ONE description); build job `base_portal` with **`params.pad:false`** (the generic pad rule would put `air` into the portal columns) |
| the_nether, today (`settings.nether.portal`) | **-44,98,-80** — where the game put it, 15 blocks off the exact partner. Three overlapping frames in -45..-36, y97..101, -80..-76 (28 obsidian, 6 lit cells). It sits in an 8-cell pocket on a shelf near the roof; the real floor of that column is **y23** |
| the_nether, the PLAN | **-41,98,-65** = floor(-327/8), floor(-518/8). `work:'pair'` walks there (bridging over the void at the arrival level), builds the 7x9 platform, the frame with an inner column exactly on the partner point, lights it, writes `settings.nether.paired` — then the old frames come down (`work:'degate'`) |

**Why the exact partner matters (Paper defaults, `server/config/paper-world-defaults.yml`):** `portal-search-radius 128` with vanilla scaling = **16 blocks on the Nether side**; a partner further away, or unlit, and the game **creates a new gate**. `portal-create-radius 16`: a second overworld gate must be ≥ 320 overworld blocks from this one. `piglins-guard-chests true` (never open a chest near piglins), `entity-activation-range.monsters 32` (walk INTO the range to barter), `nether-ceiling-void-damage-height disabled`, `per-player-mob-spawns true`.

## THE FIVE RULES OF A CROSSING (all measured 09-20 15:3x-16:0xZ, all in `jobs_nether.js`)
1. **An unreadable world is not an empty world.** 0.6 s after the gate spits a bot out `blockAt` still gives null, so "am I in a portal cell?" reads false, nobody walks out, and 15 s later the cooldown expires *under the bot's feet* and it is sent straight back (`offCellS 0.6, offCell:false` → a bot "working" the Nether plan on overworld ground at -317,69,-476). So: wait for the block under the feet to be READABLE, then get out and CHECK, up to four times, inside the cooldown.
2. **A portal cell is a teleporter and the pathfinder does not know it.** Priced at 400 it was still the cheapest way across a 9-cell pocket (16:04:15Z: home again 14 s after arriving). `nether_portal` now goes into `blocksToAvoid` for every walk of ours (`gateGuardOn/Off`), so the graph has no edge through a gate at all; the ONE deliberate entry lifts the guard and puts it back.
3. **Out is out, room is a luxury.** The only cells 2 clear of the far frame lie behind its west wall — a `min:2` round walks into obsidian for the whole cooldown while a cell one step east is free. `clearOfGate` takes the nearest cell out of the cells, by hand with control states (the pathfinder will not plan from inside a portal block), and `spreadOut` looks for room afterwards.
4. **Standing in a lit gate is how you cross** — 80 ticks / 4 s. Being unable to step 3 cells clear is not a reason to abandon a crossing (15:35:37Z `gate_stuck` + "stood in the gate for 30 s"). And when 12 s of standing change nothing it is a **cooldown**, which Minecraft RESETS on every tick the entity is still inside: get OUT for the full 15 s, then walk back in.
5. **The dimension field lags; the world does not.** `bot.game.dimension` still read `the_nether` a minute after a bot was back in the overworld (15:51:51Z `portal_through to:"overworld"`). `netherHere()` asks the ground instead — Nether biome, bedrock at y127, or a Nether block underfoot — and no far-side work starts without it.

## Job type `portal` (`bots/skills/lib/jobs_nether.js`) — one job type, `params.work` picks the work
`params {origin, args:{axis}, buildJob, go, landing, work, at/from/bearing/length, minutes, cobble, crossS, maxDeaths, obsidian}`
* **frame** — reads all 14 cells back; a gap re-activates the frame's own build job (that IS the repair) and declines 6 min. It never builds the frame itself.
* **light** — `A.obtain('flint_and_steel')` (or `knapGravel`, 10 % a gravel block), clears the 6 inner cells, strikes the TOP FACE of a bottom obsidian; success = **six `nether_portal` blocks read back**.
* **go** — banks, kits up (stone of any sort, torches, food, sword, shield; `work:'pair'` also takes 14 obsidian + flint and steel + a diamond pickaxe) and refuses to cross under-equipped.
* **arrival** — rules 1-3 above, then `sealNear` (lava faces in arm's reach), `nether_look`, optional `landing`. Nothing is placed, dug or measured from a portal cell.
* **work** — `pair` (build the exact partner) · `stair` (blueprint `nether_stair`, the way down to the floor) · `hub` · `road` · `scout` · `fortress` · `barter` · `degate` (take a stray frame down on the far side, bank the obsidian at home). One round trip per slice; the trip always ends at the gate.
* **home** — `comeHome`: the gate in view, else ONE bounded walk to `settings.nether.portal`, step out, step in, verify → `portal_back`. Also the whole of the return job (`return:true`, `dim:"the_nether"`, id in `settings.nether.returnJob`).
* **death rule** — a rolling window: `maxDeaths` deaths in 30 min and the job pauses itself. A bot that died declines 3 min.
* EVENTS: `portal_frame_incomplete · portal_lit · portal_through {offCellS, offCell, hp} · gate_stuck · nether_sealed · nether_look · nether_landing · pair_probe · pair_bridge · pair_built · pair_unreachable · nether_pass · portal_back · portal_bounced · gate_removed · nether_lost · portal_scout_died`.

## THE FAR SIDE, MEASURED BY CAMERA (`SkyEye`, perception only: rcon `tp` + `findBlocks`, /tmp/gates.js + /tmp/nmap2.js this shift)
* **Census 15:4x / 16:0xZ:** overworld = exactly ONE gate (ours, lit). No gate anywhere near -130,-240 or -203,-338 — the bots that "arrived" there never transferred (rule 5).
* **Cell census 16:2xZ (`/tmp/cells.js`, every block read back):** the far side's 28 obsidian are **two** frames, not three —
  **LIVE:** -45..-42 / y97..101 / **z-80**, 14 obsidian holding the six `nether_portal` cells (-44/-43, y98-100) = our way home.
  **DEAD:** -39..-36 / y97..101 / **z-76**, 14 obsidian, **0 portal cells** — the "unnecessary gate" the owner sees. `nether_dead_frames` (`work:'degate'`) takes those 14 home; they are more than the 10 the partner frame needs. `degate` now reads the live portal cells back first and never digs an obsidian that touches one, so the way home cannot be broken; the live frame goes only after the new pair has its three verified round trips.
* **The shelf:** at the arrival level y98 the rock runs from z -88 to about z -72 (x -50..-33) and everything north of it, including the partner column -41,-65, is **void** — the floor of that column is y23. So the partner gate is built **at the arrival level** on a platform, reached by a causeway: 3 walkable cells wide, a rail on each rim, 3 high, cut through the rock where there is rock and laid over the void where there is none (`causewayCells`).
* Lava within 16 of the arrival: 3 cells. Drop under the frame: 0.

## HOW A BOT WALKS OVER THERE (the fix for six identical deaths, 13:3xZ)
Every Nether walk goes through `nTravel`: an `exclusionAreasStep` pricing at 100 any cell with lava or fire within 2 horizontally / 3 below / 2 above (lava set refreshed per trip), `maxDropDown 1`, no parkour, no 1x1 towers, no digging, `allowSprinting` pinned false with a property (`A.travel` re-asserts it every trip). `netherWalkOff` takes it all back off at home. Bridging only from a safe stand (`walkableArea >= 8`, no lava within 2). **0 deaths from the terrain since.**

## WHAT KILLS OUR SCOUTS TODAY IS NOT THE NETHER — IT IS `rescue`
Both scouts of the 15:4x-16:0x shift were killed by an operator's `rescue` within three minutes of arriving (Ichika 15:51:49, Hazuki 16:04:15, both "was killed" at the_nether -44,98,-79; two full kits and 14 obsidian lost). The arrival pocket is 8 cells wide, so `walkableArea` reads boxed-in, army.js files `stranded {dim:"the_nether"}` — its only possible move off the overworld — and the digest tells an operator to rescue, which is a kill. Until `armyctl rescue` refuses off-overworld bots (docs/BUGS.md 16:0xZ), a portal trip holds that generic alarm down for its own length: a `portal` job reports for itself and always ends at the gate.

## STAGE 2, what stands (all read back from the world)
| step | job | result |
|---|---|---|
| landing | `nether_landing_2` (paused) | `safe:true` 12:49Z, box x -39..-35 / z -78..-74 y97-99, 0 holes, 0 lava within 5 |
| hub | `nether_hub` (paused) | 413/413 cells, 9x9x5 walled + roofed + lit room round the old gate, chest -37,98,-79 and table -37,98,-73 STAND (`settings.nether.hub`), four 2x2 doorways cut open (a walled hub was a cage: 6x `stranded`) |
| way down | `nether_stair` (paused, 490 of 1330 cells) | corridor from the hub's z- door down to y33; **re-site it on the new platform** once `pair` is done, then `settings.nether.floorHub` |
| road / scout / fortress / barter | paused | the road wants a dog-leg at every door (a mob walked in and killed a bot at the gate); `barter` and `fortress` stay paused until `floorHub` exists — there are no piglins and no fortress on the shelf |

## PROVEN LIVE 09-20 16:0x-16:1xZ (one pinned scout, `nether_pair`, job OWNER-LOCKED while it runs)
```
16:04:01 Hazuki portal_through {from:"overworld", to:"the_nether", pos:[-44,98,-79], cells:6, offCellS:0.7, offCell:true, hp:20}
16:11:14 Aoi    portal_through {to:"the_nether", pos:[-43,98,-79], offCellS:0.3, offCell:true, hp:20}   (16:13:07 again, 0.4 s)
16:08:23 / 16:12:01 / 16:13:48 Aoi portal_back {to:"overworld", pos:[-326/-327,69,-518], from:[-43/-44,98..99,-80]}
16:11:45 Aoi    pair_bridge {from:[-43,98,-79], to:[-41,98,-65], len:16, placed:13, dug:6, steps:6, left:54, of:212}
```
**Three round trips, every return on the home gate itself (±1), 0 deaths from the world, and a camera census after them still
reads ONE gate in each dimension** (the second overworld cluster at -284..-279, y30-31, -604..-601 is 13 obsidian with **0 portal
cells** — a natural lava/water pocket in a cave, not a gate).

## SIZED FOR FIFTY (owner 16:3xZ 「50人でマインクラフトをやっていることを忘れているのでは？ネザーゲート周りが狭すぎる」, CLAUDE.md rule 0)
| where | was | is |
|---|---|---|
| home apron (blueprint `nether_portal`, job `base_portal`, `args {clear:6, margin:6}`) | 10x9 cobble, no road | **16x15** at y68 with the frame in the middle, 6 clear cells at each face, 5 of headroom, stepped shoulders, 4 torches — 264 stone; plus `nether_gate_road`, a 3-wide paved link from -334,68,-518 to the lattice at -338,68,-518 (probe: grass y68 the whole way, lattice cobble y68) |
| far platform (`work:'pair'`) | 7x9 | **15x15** with the gate in the middle, 3 high clear, a **solid rail on the whole outer rim** (a ghast's fireball knocks bots off, it does not kill them), 7 clear cells at each face |
| causeway (`causewayCells`) | 3 wide + rails | **5 walkable** (two lanes each way + a spare), floor 7 wide, rail on both rims |
| `spreadOut` / `landing` | ring 2-4 cells, 7x9 | the whole platform: ring 3-7 by roster index, landing box 15x15, nothing within 3 of a portal face |

**Throughput of ONE frame, from today's measurements** (single-bot, a 20-bot crossing has not been run): a bot is transferred after the vanilla 80 ticks (4 s) and is **off the arrival cells in 0.3-0.7 s** (`offCellS`, five crossings) — so a cell is free again ~4.5 s after it is entered, and a frame has **6 cells working in parallel**: ~6 bots per 4.5 s, i.e. a 20-bot shift change ≈ 18 s through one frame. **No second frame is needed**; what was actually queueing was the 8-cell arrival pocket, which the 15x15 platform removes. Re-measure with a real squad once the platform stands.

## NEXT, in order
1. `nether_pair` (1 pinned scout, **OWNER-LOCKED** while it runs): finish the causeway — anchored at the gate and written to `settings.nether.pairRoad`, so every trip continues the same road; 17 legs, floor 5 wide (the middle 3 walkable, the outer 2 carry the rail — a rail over the void has nothing to be placed against otherwise), and `buildCells` now walks to the head of the road it has already laid instead of looking for a stand in the void it is about to bridge. Then the 7x9 platform → frame on -41,-65 → light → `paired`.
2. Then `portal_through` must land within 2 of the NEW gate (the return side is already proven), with a camera census after each trip.
3. `work:'degate'` on the three old frames at -45..-36,97..101,-80..-76: one obsidian first (the surface goes out at once), then the rest, banked at home.
4. Re-site `nether_stair` from the new platform, squad of 3, death brake on. `fortress` and `barter` follow `floorHub`.
5. Open requests to other owners: dispatcher eligibility by `dim`; army.js `travel({dim})`, keep-out/homeward bias overworld-only, `bank`/`chestsOf` off-overworld, `ours()` keyed by dimension; armyctl `rescue` off-overworld (docs/BUGS.md).
