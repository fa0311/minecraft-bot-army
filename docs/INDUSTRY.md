# INDUSTRY — turning the depot's glut into what the army lacks (front: village outpost, `bots/skills/lib/jobs_industry.js`)
Owner 09-20: 「工業化しないのか？ / 在庫の有効活用はしないのか？」. Iron is the bottleneck (620 ingots of armour missing, depot
iron ~20) while 17 828 wheat, 10 328 wool, 2 995 sugar cane, 1 876 coal and 188 leather rot on the shelf. Trading converts the
one into the other with no mining at all. **Every design on this page is REDSTONE-FREE** (owner: Paper's redstone is not
vanilla's — no clocks, observers, piston timing or zero-tick anywhere here; water, gravity, lava and hoppers only).

## What stands (09-20)
| thing | where | state |
|---|---|---|
| plains village | x -766..-703 / z 10..57, ground y62-76, rally **-714,73,27** (624 blocks SW of base) | 9 villagers, 10 beds, 2 composters + 1 blast furnace, 1 iron golem at -760,63,29 (`armyctl.js events 20 village_seen`) |
| `village_survey` | job type `trade`, `work:'survey'` | ONE bot patrols the village and re-measures villagers / professions / beds / workstations / golems every 2 min; writes `settings.industry` |
| `village_trade` | job type `trade`, 2 traders | load glut at the depot → 624-block walk → sell to every villager → buy iron gear → walk home → bank |
| `village_post` | job type `trade`, `work:'post'` | crafts the workstations the village LACKS and places them on probed free grass at x -746..-738 / z 28..33 |

## What this village really pays (READ FROM THE TRADE WINDOWS, not from a wiki)
- **farmers** (2): 20 wheat / 22 carrot / 15 beetroot / 6 pumpkin → 1 emerald; sell pumpkin pie.
- **leatherworkers** (4): 6 leather / 26 flint → 1 emerald; sell leather_helmet 5, leather_leggings 3, leather_chestplate 7 emeralds.
- **nobody** buys wool, paper, coal or string, and **nobody sells iron**. That is the whole problem, and it is a recipe away (below).
- Measured trades: Tamaki 320 wheat → **16 emeralds**; second trip 320 wheat + 96 leather over 2 villagers → **51 emeralds**;
  Yotsuba 320 wheat → **16 emeralds**. ~83 emeralds in three round trips, 0 deaths, 0 `no_route` on the whole 624-block route.
- **THE LOOP IS CLOSED (15:53Z):** with the new weaponsmith on the board, Yotsuba sold 375 wheat + 12 leather over 4 villagers for
  36 emeralds and **bought 6 iron axes** — 18 ingots of iron gear paid for with wheat, in one trip, by two bots. That is the whole
  answer to 「在庫の有効活用はしないのか？」: the depot's glut is iron, at 20 wheat per emerald.

## Stage 1a — MAKE THE BUYERS (`work:'post'`, running)
An unemployed villager claims the nearest unclaimed workstation it can reach, so the professions we need are craftable:
`loom` (shepherd: 18 wool → 1 em) · `lectern` (librarian: 24 paper) · `grindstone` (weaponsmith: 15 coal, sells iron sword/axe) ·
`smithing_table` (toolsmith, 2 iron: sells iron tools) · **`blast_furnace` (armorer, 5 iron: buys 15 coal AND SELLS IRON ARMOUR
for 4-9 emeralds a piece)** · `barrel` (fisherman) · `smoker` (butcher). Total iron spent: **7 ingots, reserved from the depot** —
against 105 armour pieces (620 ingots) that the armorer can then sell us for emeralds we make out of wheat and wool.
Nothing that already stands in the village is dug, moved or replaced; the stations go on columns probed with `armyctl.js ground`.
`stone` and `smooth_stone` are SMELTED, not crafted, so the job runs two furnace passes before the recipe solver.
**PROVEN ON THE FIELD 09-20 15:48Z:** Tamaki placed a `grindstone` at -740,70,33; four minutes later `village_seen` read
`professions {farmer:2, leatherworker:4, weaponsmith:1}` — a villager had taken the job. The village now buys our coal. The other
six stations follow on the next pass (the first pass crafted only the grindstone: a bot carrying 800 wheat from an interrupted
trade load made every withdrawal in the recipe chain fail with "inventory full", so `work:'post'` now banks its pockets first).

## Stage 1b — THE IRON GOLEM FARM: designed, sited nowhere yet, **0 ingots/hour measured** — and why
- **A bot must never kill a golem.** A *player* kill costs village reputation (major_negative gossip) and raises every price at the
  outpost we just built. Any farm here has to kill passively: water push → lava blade → hopper → chest. That also keeps it redstone-free.
- **A platform over the existing village does not work.** A villager spawns a golem at a random valid spot within ±8 x/z and ±6 y of
  itself; `iron-golems-can-spawn-in-air: false` only forbids air, so the village's own streets stay valid and most golems land out of
  reach. Only a pod whose surroundings are non-spawnable collects them.
- **Chosen design (smallest I can defend):** a levelled pad ≥40 blocks from the village carrying a 3-cell pod — 3 beds, 3 workstations,
  one villager per cell, walls of any stone — with the golem spawning floor as the only solid ground in the ±8 box (everything around
  it water or open air), water streams pushing golems into a 1-block hole, a lava blade above a hopper into a chest.
- **Paper settings it leans on** (all left at their defaults): `spigot.yml entity-activation-range.villagers: 32` +
  `tick-inactive-villagers: true` → **a villager only runs its brain near a player, so the standing surveyor/traders ARE the farm's
  clock**; `iron-golems-can-spawn-in-air: false` → a SOLID spawn floor, never a water sheet; `hopper cooldown-when-full: true`,
  `hopper-transfer 8 / hopper-check 1` → one hopper is enough for a few golems an hour; `max-entity-collisions: 8` → no cramming
  design; `zombie-aggressive-towards-villager: true` would make the scare variant work but needs a captive zombie — more moving parts.
- **Material bill:** 2 hoppers = **10 iron** (reserve them), 1 chest, 1 lava bucket, 1 water bucket, 3 beds (wool is glut), 3 cheap
  workstations, ~200 blocks of stone. Everything but the iron and the lava is already on the shelf.
- **The one experiment that decides it, NOT YET RUN:** build the pod's 3 beds + 3 workstations on a pad 40 blocks from the village and
  watch whether unemployed villagers claim them and sleep there (`village_survey` already reports professions and bed counts every
  2 min). If they do not migrate, the farm needs villager transport (boat) — a separate piece of work, not a patch on this one.
- Until that is built the honest number is **0 ingots/hour**. Trading is what pays today.

## Next industries, ranked by what they unblock
1. **The post's buyers** (running): unlocks 10 328 wool + 2 995 cane + 1 876 coal ≈ 900 emeralds, and the armorer who sells iron armour.
2. **An outpost chest + local wheat field at the village**: a round trip is ~25 min today and 22 of them are walking. A site chest
   (`stash`/`unstash`) plus a `haul` job turns three legs into one.
3. **Villager breeder + trading hall AT THE BASE** (beds + food, 0 iron): kills the 624-block walk for good, and is where a
   librarian's mending book comes from. Needs 2 villagers brought home — the same transport problem as the golem pod, solved once.
4. **The iron golem farm** above, after the pod experiment.
5. **Mob grinder** (XP, bones, gunpowder) and an **auto-smelter** — both want hoppers, so both queue behind the iron they save.
6. gold → piglin bartering belongs to the Nether engineer (docs/NETHER.md), not here.

## Rules for this front
Never hit a villager, never break a block the village already owns, never trade with mobs within 12 blocks (the combat module owns
mobs), never sell below the depot reserve in `SELL`, and **never trust `bot.inventory` while a trade window is open** — count on the
window (`inWin`), which is what cost the first trade its report on 09-20.
