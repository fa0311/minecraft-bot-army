# World 2 — what we build differently (top model, 2026-09-19)

World 1 taught us Minecraft the hard way. World 2 (new seed, Paper 26.2, humans = spectators) starts from these algorithms, not from patches.
Status: DESIGN. Each block names its owner file(s) and its exit check. Nothing here is LLM work at run time.

## 0. Ground rules that stay
Read-only movement · one implementation of everything · level first, one site = one height · never trust an event without looking at the
world · audits of what we built · code only by Fable, atomic saves · x50 scale · no standby.

## 1. SITE before anything (world 1: base in snowy taiga, 42 blocks from spawn, frozen water, no animals)
`scout` long-range (budgetMin) in 8 bearings FIRST; `armyctl.js sites` scores: not snowy/frozen, liquid water, flat 64x64, trees within 100,
animals, sugar cane, distance to a village as a bonus. The base origin is CHOSEN from that list, then frozen into `settings.base = {x,y,z}`.
Exit: a site with score ≥ threshold, written to docs/WORLD.md.

## 2. The base is a PLAN, not a growth (world 1: depot, warehouse, farm, hedge grew where a bot happened to stand)
`armyctl.js plan-base` lays zones on a grid relative to `settings.base` (all on ONE level y, pads levelled by the build job first):
core 32x32 (craft table, furnace bank x16, depot = warehouse rows by category), dorm (beds for all as wool arrives), field blocks 27x27
(nine 9x9 plots, each with its water cell BUILT by the blueprint: hole at field level, water, cap), tree farm 48x48 on a 3-grid, animal
pens, mine head with a walled stairwell, roads 3 wide between zones, torch grid pitch 8 over everything, perimeter wall last.
Every zone = one `build` job from a blueprint → audited for ever by `auditStructures`. Exit: plan printed, jobs validated by `put`.

## 3. Labour by DEMAND, not by fixed priorities (world 1: 9 farmers with 500 bread in stock, 0 coal, 2 iron)
`settings.targets` = stock targets per item (bread 256, logs 256, cobblestone 1024, coal 128, iron_ingot 128, torch 128 …). Each producing
job declares `produces:[…]`. The dispatcher scales a job's head-count between `minBots` and `maxBots` with the worst deficit of what it
produces (stock from chests.json + carried); build jobs get what is left, capped by their own `bots`. Shifts and named plans stay.
Exit: with bread over target the farm drops to minBots by itself; with coal 0 the ore/mine squads grow.

## 4. Farming (world 1: five patch layers on irrigation, a flood, tables in water holes)
Water cells are PART OF THE FIELD BLUEPRINT and are made once by the build job (dig cell at field level → solid floor/sides → pour →
cap). Farmers only till, plant, harvest, replant and clear junk; they never touch water. Flood sensor and `farm_degrading` stay.

## 5. Mining (world 1: 140-step commute to y-54 as a sponge job, no iron level, dark trunk)
One squad per LEVEL with `shiftMin`: iron/coal level (y 16 band) first, diamond level (y -54) when iron tools exist. Stairwell is a
blueprint (walled, lit, 2 wide); trunk 2 wide and lit by the miners; junk stone dropped underground; hauls by value. `mine level` moves
up and down. Surface: `ores` squad takes exposed veins.

## 6. Logistics and crafting
Containers by category, nearest with room first, registered by the build job. Crafting only at `settings.craftTable` (first table wins).
Recipes are WOOD-AGNOSTIC (any planks/logs of the biome — world 1 hard-coded spruce). Metal is forged into tools/armour as it arrives.
Charcoal from logs whenever fuel < target. A bed per bot as wool arrives; one sleeper skips the night.

## 7. Perception
`census` (unknown containers, exposed ores), `mapshot`, REPORT FIELD ANOMALIES, planted-vs-standing audits, `errors` live-only,
escalation once per kind per hour. The foreman looks at maps every 25 min.

## 8. Bootstrap order (no LLM): survey → choose base → craft table + first tools (wood-agnostic) → food (hunt/forage, then field block 1) →
core pad + depot rows → tree farm → stairwell + iron level → torch grid → dorm/beds → field blocks 2..n, pens → wall → diamond level.

## 9. CONTRACT between the files (every engineer reads this; names are fixed so parallel work fits together)
- Board `settings`: `base:{x,y,z}` (origin + THE level of the base; unset until a site is chosen) · `muster:[x,y,z]` · `craftTable:[x,y,z]` ·
  `respawnBeds:[[x,y,z]…]` · `mineHead:{x,y,z,facing}` · `chests:{cat:[[x,y,z]…]}` · `targets:{<item|group>:n}` · `nightSkip`.
  A missing setting is never guessed from old coordinates: `setting(bot,key)` → event `setting_missing` once, job idles into the fallback.
- Stock groups (ONE definition: `bots/army/stock.js`, exports `groups`, `stock()` → `{name:n}` from chests.json + carried items in hb/, and
  `have(key)`): `log` (any `*_log`/`*_stem`), `planks`, `food` (bread-equivalents: hunger points / 5), `fuel` (coal+charcoal), else the item name.
- Job fields for labour by demand: `produces:[<item|group>…]`, `minBots`, `maxBots`. Jobs without `produces` keep `bots`. Dispatcher:
  deficit(job) = max over produces of clamp(1 - have/target, 0, 1); head-count = minBots + ceil((maxBots - minBots) * deficit).
- `scout.jsonl` sample (one JSON line): `pos,biome,ground,relief,flat` (share of 17x17 columns within ±1 of the feet) `,water,ice,tree,cane,crops,
  village,animals,temp` (`cold|temperate|warm|dry`) `,score`. `armyctl.js sites` ranks BASE sites from these; `armyctl.js base set x,y,z` freezes one.
- Blueprint cell kinds the `build` job understands: block names, `air` (dig), `water` (dig cell → make floor/sides solid → pour → verify
  source), furniture (`chest`, `furnace`, `crafting_table`, `*_bed`, `torch`). Containers/furnaces/beds/tables a build places are REGISTERED
  in `settings` by the build job itself. Farmers never pour or plug water.
- Mine: `delegate` job, `params.args = {entrance:{x,y,z,facing}, level:<y>}`; the miner digs and OWNS its stairwell (2 wide, walled, lit every
  6, steps only — no drops), audits it on every commute (`stair_broken` → repairs before anything else), and moves underground ONLY along
  branch → trunk → hub → stairs. A miner given a surface job first walks up the stairs (`upTheStairs`), never pathfinds through rock.
- Wood: no recipe, job or template names a wood species; `craft.js plankNameFor`/any-log matching decides from what is in stock.
- Every world-changing routine VERIFIES the world after acting and reports the verified result, never the intention.
