# FILL — solid filling as a planner (`bots/skills/lib/fill_plan.js`), tested without a server

## The algorithm, in eight lines
1. The box is cut into **lanes** of 3x3 columns. A lane is the unit of WORK and of OWNERSHIP; two claimed lanes never share an edge, so two builders can never target the same or a face-adjacent cell. No locks, no head-count, no supervisor: `openTiles` → `claim` → `next` → `release` (the owner's 気づいたbotがやる).
2. Per lane, strictly bottom-up: layer `L` = the lowest open cell **with a solid block under it**. The layer is closed before `L` rises ⇒ a pinhole cannot be left behind, and no block is ever placed over air.
3. **Water level (per column):** a cell may be filled only if it ends at most 1 above each of its four neighbouring columns. The filled surface is always a 1-step staircase — walkable in every direction, no well, no wall a builder cannot step over. The fill therefore spreads like water, deepest basin first.
4. The builder stands ON the finished layer and places the cells around itself (reach 4.5). It closes the cell under its own feet last by **riding up** onto it — that is also the escape when a mate's floor closes in.
5. Nobody is walled in: never at/above a mate's feet+1 in the 8 neighbouring columns, never into a mate's body, never where a mate's walkable area would drop under 4 (a flood capped at 4, so it costs nothing).
6. **Entry** (§Ways in) is pluggable; **exit is never needed**, because the floor rises under the builder. Within a layer, cells are taken **farthest from the entry first** = reverse-BFS from the way in, which is exactly the order that keeps the way in connected to the open work until the last layer.
7. Cells nobody can stand beside are classified ONCE: a **1x1 well** (found up front) is filled by dropping a gravity block down it from any height — which also breaks the flower at the bottom; a cell **under a roof** is not work at all and is reported as `roofed` (take the lid off first — the live blueprint's `unlid` — then the same planner fills it with no special case); anything else is written off only with evidence (a builder stood within 8 blocks of it, eight times over a minute) and takes the open cells above it with it (`abandoned` → `void_under_pad`). Lava is never sealed over: it is quenched first, and no builder ever stands touching it.
8. Crew size **emerges**: `capacity = ceil(open cells / K)`, `K = 8`. Surplus builders get `leave` and are spent elsewhere; nobody is assigned, nobody is released.

**Invariants** (the simulator checks them every tick): no builder entombed (walkable area ≥ 4, for more than 20 s); no block with air beneath it (only `stair`/`ladder` entries hang, by design); no cell dug after the fill placed it; two builders never touch the same or a face-adjacent cell in one tick; it TERMINATES with every reachable cell at grade; the crew ends on top.
**Proof sketch of "every unfilled cell stays reachable, every builder keeps a route out":** by rule 3 the top surface is 1-Lipschitz over the 4-neighbour graph, so any two surface cells are connected by steps of ≤1 (walkable both ways); by rule 2 a builder always stands on that surface; by rule 6 the entry is the last thing filled in its own column and the work retreats away from it. Cells that break the premise — under a roof, inside a 1x1 well, beside lava — are exactly the three classes rule 7 removes from the work set before anybody walks anywhere.
**Complexity:** `workMap` is O(cells) once (sky flood + roof scan + well scan). `firstOpen` is memoised and monotone, so a lane's state is O(9) per tick; `plan` is O(crew x (lane + a capped flood)); the only BFS over the box (≤4000 nodes) runs when a builder has nothing in reach and needs to walk. No allocation per cell, no board I/O, no `blockAt` storm.

## Ways in (`opts.entry`, default `auto`) — measured on the live trench, 12 builders
| way in | first bot down | total | hp lost | deaths | verdict |
|---|---|---|---|---|---|
| `drop` step off the rim, take the fall | 36 s | **10.9 min** | 193 | 0 | default while `fall-3 ≤ hp-6` |
| `water` pour a column down the wall, swim down and up | 36 s | 14.6 min | 0 | 0 | default when a drop would hurt |
| `ladder` rungs down a wall face | 36 s | 16.7 min | 0 | 0 | fills, but the run gets cut as the floor rises (open bug); live bots also misread a ladder column as wall |
| `stair` treads built inside the pit | — | — | — | — | **not working** (the builder cannot reach the next tread from the last one) |
| `dig_stair` 2-high staircase cut through the wall outside the box | — | — | — | — | **not working**, same cause. The owner's favourite and the right long-term default: walkable both ways, never buried, serves refill trips |
`walk` (nothing to build) is chosen whenever the floor is within 3 of the rim or the terrain slopes in. A planned fall is refused if it would leave under `keepHp` (6) or the landing is not solid, clear and lava-free.

## Running the tests
`node tests/fill_sim.js` (no server, ~2 min) — a voxel world, builders with pockets, hit points and a busy clock, place 4/s, walk 4 b/s, restock = distance/4 + 10 s, gravity for blocks and for bodies. `node tests/fill_sim.js b e` runs single scenarios, `--trace` / `--tail` print actions, `--dump` prints the lane table at a stall. Scenario (h) is a measurement, not a gate.

## Calling it from the live `build` handler (~40 lines, second step, not done here)
```js
const FP = require('./fill_plan.js')
const world = { get: (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) return 'unknown'
    return b.boundingBox === 'block' ? 'solid' : /^(lava)$/.test(b.name) ? 'lava' : /^water$/.test(b.name) ? 'water'
      : WEED_RE.test(b.name) ? 'plant' : b.name === 'ladder' ? 'ladder' : 'air' },
  sky: (x, z) => bot.world.getColumnAt ? … : grade + 1 }
const crew = mates()                       // heartbeats/entities -> [{id, pos, carrying:A.inv(bot), hp}]
const { actions, claims } = FP.plan(world, box, grade, [me], { map: st.map, claims: boardClaims(), now: Date.now(), others: crew })
switch (a.type) {                          // ONE action per pass, then report and loop
  case 'place':   await BL.placeBlock(bot, v(a.cell), a.item, { retries: 1 }); break
  case 'dig':     await BL.digBlock(bot, v(a.cell), { collect: true, plug: false, own: job.id }); break
  case 'move': case 'descend': await A.travel(bot, a.target, { range: 0, stop: api.stop }); break
  case 'ride_up': await BL.pillarUp(bot, 1, {}); break
  case 'restock': await A.withdraw(bot, a.item, a.n, { stop: api.stop }); break
  case 'leave':   return muster(bot, job, api, ctx, a.why)
}
```
`claims` live on the board under the job (`j.fill = {tileId: {bot, t}}`, the same locked `A.boardEdit` the water book uses); `map` is cached per process on `bot.__armyBuild`.
**What it replaces in `army_jobs.js` `build()`** (by their comment headlines): *SOLID FILL cells / skyOpen* · *NOBODY IS BURIED ALIVE* · *NOBODY RAISES A WALL BESIDE A BOT* · *LAVA* · *WHERE A GOOD PLAYER PUTS THE NEXT BLOCK IN A PIT* (the tier list) · *A FLOWER IN THE CELL…* · *A GROUND COLUMN NO RIM SHOWS / gravityDrop* · *FILL builders work INSIDE the void* (`climbOut`, `rideUp`) · *A TAIL DOES NOT HOLD A SQUAD* · *PINHOLES* · *NOTHING A FILL PLACED STAYS ABOVE GRADE* (`fill_flush` becomes unnecessary: the planner never places above grade). Roughly 50 special cases for ~330 lines of planner.
**Migration:** `fill_void` only, behind `params.planner:true`, on ONE job first (`fill_ravine_s`); compare `build_pass done/left` and `ops/gemba.js` cells/min/bot against the old handler on the neighbouring box; keep the old path untouched until two jobs have finished clean.

## The same work map for everything else a bot notices (architecture proposal)
A lane is *a small piece of work with a precondition, a material and an owner*. Nothing in `openTiles/claim/next/release` is about filling: replace "open cell below grade" with any predicate a bot or an audit can evaluate — a hole in a road, a stray block, a flower on a pad, an unlit 8x8 tile, a road cell holding the wrong material, a chest that is air — and the same three calls give: what is open near me, mine for 60 s, what do I do next. The board then keeps only what needs a PLAN (what to build where, expeditions, mine levels, targets), and everything that is merely *noticed* — by `ops/base-audit.js`, by `ops/gemba.js`, or by a bot's own eyes on its way past — becomes a tile in a work map any passing bot can take. That removes the layer that cost us today: head-counts, tails holding 25 bots, 1200 reassignments an hour, and bots walking 150 blocks to a job while work lay at their feet.
