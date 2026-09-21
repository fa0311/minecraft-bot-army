# ROADS — the trunk network (owner 09-21「幹線道路という仕組みを強化し…何度も通るであろう道は先に整備し…skyeyeでの緻密な設計が必要」)

A road is the only world edit that pays for itself a thousand times: the village trade route is **624 blocks each way and 5 of
every 6 trip-minutes are walking** (docs/INDUSTRY.md), the mine commute is minutes per shift, the `no_route` storms of 09-19/20
came from terrain nobody prepared (366 in 30 min from ONE 3-deep pit), and two bots died walking the open Nether. So the routes
that will be walked many times are built BEFORE they are needed, from the camera, once, for all 50 bots.

Code: `bots/skills/lib/jobs_road.js` (job type `road`) · design tool: `ops/road-plan.js` · network on the board:
`settings.roads[] = {id, job, from, to, dim, width, cells, built:"n/m", checked}` (geometry stays in the job's `params.segments`).

## 1. The standard
| | trunk | spur |
|---|---|---|
| paving width | **5** (3 lanes + 2 shoulders) | **3** |
| surface | **cobblestone** | cobblestone |
| torches | every 8, both shoulders (the `road` blueprint) | every 8 |
| shoulder terrace | 2 cells | 1 cell |
| rail | fence/wall wherever the drop beside the paving is **>= 3** | same |
| height | **ONE height per segment, no step over 1 block** | may cut/fill (see §4) |

* **Why cobblestone** — the owner's material rule (docs/WORLD.md: "paths = cobblestone, never cobbled_deepslate/stone"); the depot
  holds thousands and the mine banks more every shift; it reads grey against grass **and** against netherrack, so one material
  serves every dimension; and the base lattice is already cobble, so a junction never changes material. `cobbled_deepslate` and
  the rest of the stone family stay what they are — the hidden sub-base, through the cell's `mats`.
* **Never a trench** (foreman 09-20): the shoulders are TERRACED — `s` cells out the ground may stand at most `s` above the road —
  so a bot can leave the road anywhere and enter it anywhere.
* **Rails are measured, not drawn.** A blueprint has no world access, so the builder looks: how far down is the first solid block
  one step outside the paving? `>= 3` → a fence post. Every rail that ends up standing is written to `segment.rails` on the
  board, so the audit can tell a stolen rail from a rail that was never needed.
* **Over a gap**: `lib/moves.js bridgeTo` (pathfinder scaffolding inside a corridor + sneak every tick), **spans of at most 6
  cells**, and each span is widened to full width and railed **from the safe spine before the next span** — a rail over the void
  has nothing to be placed against once the crew has walked past (docs/NETHER.md, paid for with one death).
* **In the Nether**: the rail is a 2-high **wall** (a ghast fires straight through a kerb) and the deck is **roofed** at +4
  wherever the sky over it is open for 5+ cells — that is exactly where a ghast has line of sight.
* **Finished** means: a bot walks it end to end with `canDig:false` and no `no_route`, measured with a real trip.

## 2. The network
| road | from → to | dim | width | state |
|---|---|---|---|---|
| `road_mine` | muster -367,-488 → mine head -330,-500 | overworld | 5 | 3 segments, 50 cells, y68 flat (0 cut / 0 fill) |
| `road_gate` | mine-head junction -330,-500 → Nether gate apron -327,-514 | overworld | 3 (spur) | plan it when the gate apron is final |
| `road_village` | muster -367,-488 → plains village -714,27 | overworld | 5 | the 624-block trade route, the biggest measured waste |
| Nether lane | gate partner → fortress | the_nether | 5 | the Nether engineer owns the lane; `road-plan.js --dim the_nether` designs it |

Junctions snap to the base lattice (docs/WORLD.md: `base_road_*`, 3 wide, y68, x -339/-374/-304/-284, z -491/-526/-456/-403).

## 3. How to plan a new road
```
node ops/road-plan.js <fromX,fromZ> <toX,toZ> [--id name] [--width 5] [--dim the_nether] [--half 64] [--px 3] [--spur] [--put]
```
1. The spectator camera `SkyEye` reads the **real ground height of every column** of the corridor at step 1 (cached in `/tmp`, delete to re-fly).
2. The no-go mask = every `settings.keepOut` box +3 and every non-terrain blueprint of ours +1, **grown by half the road's width + 1**
   — a road is a band, not a line (the first design put the 5-wide south shoulder inside the `ravine_s` keep-out).
3. A* over that grid, 4-connected (so every run is axis-aligned), cost `1 + earth(|Δground|) + water + turn`:
   `earth` 0/1.2/5/12/30+ for 0/1/2/3/>3 blocks — the route buys a 12-block detour rather than a 3-block cut, which is what a
   player does; water = 10; a turn = 8, so segments come out long and straight.
4. The deck profile is the mean of the two 1-Lipschitz envelopes of a median-filtered ground line, then clamped: **|Δy| ≤ 1 everywhere**.
5. Runs of equal direction + equal height + equal kind become **segments**; a deck 2+ over the ground or over water becomes a **bridge** segment.
6. It prints an ASCII profile (one column per 8 blocks), writes a PNG, and writes the job to `/tmp/<id>.json`. **READ the picture
   before `--put`.** Nothing reaches the board without it.

## 4. The spur — reaching the network is construction, not travel
Owner 09-21:「幹線道路以外から幹線道路への行き方は穴を掘ったり、ブロックを置いたりしても良いのでは？」 Yes. CLAUDE.md rule 4 (travel is
read-only) stands for *travel*; a **road spur** is a NAMED technique, like `moves.bridgeTo`:
* at most ~32 blocks, from a work site to the nearest trunk road — anything longer is a road, so plan it as one;
* planned by `road-plan.js --spur`, registered in `settings.roads`, repairable and audited like every other segment;
* it may cut a step, fill a dip or lay a ramp (`maxStep 12` in the router instead of 6, shoulder 1, width 3);
* while a builder works one it holds `terrain_guard.allowTerrainEdit(bot, 'road spur <id> seg<i> …', 13 min)` — **with a reason
  and a time box**, revoked in `finally`; nowhere else in `jobs_road.js`;
* it is **never** a private shortcut a bot digs on its own initiative.

## 5. The cost model — why a bot prefers the road
Owner 09-21:「空が見えているか、ディメンションがどこか、によって重み付けする必要はありそう」. `jobs_road.roadCost(bot, mv)` pushes one
`Movements.exclusionAreasStep` function (a **weight**, not a veto: `exclusionStep` sums numbers into the move cost). With no road
built it is a no-op.

| where the step lands | per body cell | per block walked | the measurement behind it |
|---|---|---|---|
| on a road cell | 0 | 0 | paved, flat, lit, 3 lanes, no jump |
| off-road, overworld, open sky | 0.3 | **0.6** | a bot on real stair TREADS walks 3.9 steps/s, on broken ground 2.5 (docs/DEV.md §7) → 3.9/2.5 = 1.56, so an off-road block is worth ~1.6 road blocks: a detour of up to ~60 % onto pavement is a win |
| off-road, underground / roofed | 1.25 | **2.5** | underground movement is GRAPH-ONLY doctrine (docs/DEV.md §7); off the graph is where the `no_route` storms, the falls and the long rescues happen |
| off-road, the Nether | 2.0 | **4.0** | two bots died walking the open Nether 09-20; one death cost 26 iron + 9 diamond (docs/NETHER.md) and nothing of ours fetches a kit back from another dimension |

`getMoveForward` prices two body cells (feet + head), hence the two columns. The mode is read **once per trip**
(`terrain_guard.modeOf` + dimension), never per A* node. The road map is `settings.roads` → the built segments of each road job,
cached 60 s per process.

**The hook** (`bots/skills/lib/army.js strictMovements`, one line before `bot.pathfinder.setMovements(mv)`):
```js
try { require('./jobs_road').roadCost(bot, mv) } catch (e_) { swallow('army:roadCost', e_) }
```

## 6. Keeping them true
A road is a structure that happens to be 600 blocks long. Every slice the holder reads its nearest segment back out of the world
(`segState`: the `road` blueprint's own cells for a paved run, the deck line for a bridge, plus the recorded rails) and judges only
what it can actually see (`seen >= 80 %`). 3 % of the segment wrong → `road_damaged {id, at, cells}`, the segment is marked
unbuilt on the board and the job — which pauses itself when everything is built — is the repair, exactly like a `build` job.
Never add a second job for a damaged road.

Events: `road_seg_start` · `road_seg_built` · `road_rails` · `road_roof` · `road_span` / `road_span_failed` · `road_done` ·
`road_damaged` · `road_blocked` (no fence, no stone). Claims are per segment (`asset_audit.json`, 15 min), so any number of bots
may join one road; a bot that finds every open segment claimed declines for 2 min and falls into the sponge.
