# INDUSTRY — turning the depot's glut into what the army lacks (`bots/skills/lib/jobs_industry.js`, job type `trade`)
Owner 09-20: 「工業化しないのか？在庫の有効活用は？」then「交易の最適化とかも」. Iron was the bottleneck (105 armour pieces
missing) while 17 828 wheat, 10 328 wool, 2 995 cane, 1 876 coal rotted on the shelf. **A trader is worth about ten miners.**
**Every design here is REDSTONE-FREE** (Paper's redstone is not vanilla's): water, gravity, lava, hoppers only.

## What stands
| job (`work:`) | who | what it does |
|---|---|---|
| `survey` | 1 bot | patrols the village (Paper ticks a villager only within 32 of a player) and re-measures villagers / professions / beds / stations / golems into `settings.industry` every 2 min |
| `trade` | 2 bots | load glut → 624-block walk → sell to every buyer → buy what we lack → walk home → bank |
| `post` | on demand | crafts the workstations the village LACKS and places them on probed free grass (x -746..-738 / z 28..33) |
| `breed` | 1 bot | throws bread at the adults so pairs breed into the free beds |
| `librarian` | 1 bot | re-rolls OUR OWN lectern until the enchanted book is one we want, then buys it to lock it |
Village: x -766..-703 / z 10..57, ground y62-76, rally **-714,73,27**, 624 blocks SW. Zone row in docs/WORLD.md.
Verbs for any `steps` plan: `collect_farm {at}` (empty a farm chest and measure ingots/h) · `anvil {item, with, at}`.

## What this village pays (READ OUT OF THE LIVE TRADE WINDOWS, never a wiki)
farmers 20 wheat / 22 carrot / 15 beetroot / 6 pumpkin → 1 emerald · leatherworkers 6 leather / 26 flint → 1, sell leather armour ·
weaponsmith + toolsmith (OURS, see below) 15 coal → 1, sell iron axe at 2-3 emeralds, buy 4 iron_ingot → 1 (never sell them that).

## Stage 1a — MAKE THE BUYERS (`work:'post'`, done)
An unemployed villager claims the nearest unclaimed workstation, so a missing profession is a recipe away: `loom` (18 wool → 1 em),
`lectern` (24 paper), `grindstone` (weaponsmith), `smithing_table` (toolsmith, 2 iron), `blast_furnace` (armorer, 5 iron — buys
coal, SELLS IRON ARMOUR), `barrel`, `smoker`. 7 ingots spent against 620 missing. `stone`/`smooth_stone` are SMELTED, not crafted,
so the job runs two furnace passes first, and it banks its pockets before solving any recipe chain.
**PROVEN:** 15:48Z grindstone placed at -740,70,33 → 15:52Z `professions {…, weaponsmith:1}` → 15:53Z he sold us iron axes.
Later the smithing table made a toolsmith. Nothing that already stood in the village was dug, moved or replaced.

## Stage 1b — OPTIMISING THE TRIP (measured, one bot, same village)
| | before | after |
|---|---|---|
| emeralds earned per BOT-HOUR | 286 | **729** (`trade_done.emPerBotHour`, off the visit clock) |
| wheat sold in one visit | 120-192 | 377-480 |
| minutes per round trip | ~10.4 | 5.6-6.3 |
| wheat sold per visit / villagers served | 120-192 / 3 | **925 / 6** |
**A BOUGHT TOOL IS NOT IRON** (coordinator 09-20, and the earlier "222 iron-equivalent/h" here was wrong): smelting an iron tool
yields ONE nugget, so an axe is worth ingots only while the army is short of axes — and it held 38 for 50 bots. Buying is now
strictly `settings.targets` minus what stock.js counts, per KIND: `iron_axe 38/8` buys nothing, `iron_chestplate 19/30` buys
eleven. `trade_done.ironSaved` reports the ingots we did not have to forge, counted only for kinds we were short of. What the
army really lacks is ARMOUR (helmet 5, chestplate 8, leggings 7, boots 4 ingots), shields, buckets and an anvil (31).
**Emeralds are hoarded** for the two things only trade can give: the ARMORER's iron armour and the LIBRARIAN's books. Emerald
stock is the measure until those two villagers exist. The purse is 448 so one visit can buy an armorer's whole stock (x50: 105
pieces at 4-9 emeralds is ~700, which one bot now earns in about an hour). What changed:
- **Several passes** over the villagers until a pass trades nothing: one pass served 3 of 9 (they walk off, stand on a roof, sleep).
- **Cargo from measurement:** every visit records `settings.industry.absorb` = Σ(remaining uses × price) per item — wheat 624,
  flint 600, coal 480, carrot 336, leather 288, beetroot 240. The next load carries that much. A fresh measurement that does not
  mention an item means nobody there buys it, so wool and paper stop riding 1 250 blocks for nothing.
- **Buy by deficit** against `settings.targets`, not a fixed list. **Eat on the road:** legs capped at 5 min so the handler
  re-enters and eats (one trader arrived on hp 1 / food 0 with four loaves in her pocket), and a trip is kitted with 32 bread.
- **Prices:** `trade_price` reports every demand-driven rise it measures; the per-trade uses cap plus the multi-pass loop spread
  sales over villagers by themselves. Curing zombie villagers for discounts is NOT attempted: it needs a captive zombie, a
  splash weakness potion (blaze powder → brewing) and a golden apple (8 gold) per villager — say so, do not improvise it.
- **Levelling the smiths is the buy side's ceiling.** Coal (15 → 1 em) is what pushes a weaponsmith/toolsmith/armorer to
  journeyman (iron tools) and master (enchanted diamond gear), so coal rides along even though wheat pays better per slot.

## Stage 1c — MORE VILLAGERS, and the librarian (the way around our XP wall)
After the seven stations: `farmer 2, leatherworker 4, toolsmith 1, weaponsmith 1, unknown 1`. Nine villagers, ONE unemployed —
**the village is short of PEOPLE, not workstations.** `work:'breed'` throws bread at every adult (3 loaves make one willing) and
they breed into the free beds (12 beds, 9 villagers; wheat is our largest glut). Verified 16:47Z `breed_fed {villagers:8}` ×3.
`work:'librarian'` is the player's re-roll: while a librarian has NEVER traded, breaking and re-placing his lectern re-rolls his
whole offer set, so read the book, re-roll until it is Fortune / Mending / Unbreaking / Efficiency, then BUY it — one trade locks
it for ever. No bot reaches level 30 (deaths wipe XP), so a bought book + the `anvil` verb (a few levels) is the only road to
Fortune III. An anvil is 31 iron and pays back at ×2.2 raw iron.
**NOT YET FIELD-PROVEN:** the re-roll and the `anvil` verb are written, load-checked and on the board, but no librarian exists yet
(waiting on the first baby) and no anvil stands (31 iron). Neither has run once — do not trust them until they have.

## Stage 1d — THE IRON GOLEM FARM: designed, sited nowhere, **0 ingots/hour**, and why
A bot must never *kill* a golem: a player kill costs village reputation and raises every price at the outpost. A platform over the
existing village does not collect either — a golem spawns at a random valid spot within ±8 x/z of a villager and
`iron-golems-can-spawn-in-air: false` only forbids air, so the streets stay valid. The smallest defensible design is a pad ≥40
blocks out with a 3-cell pod (3 beds, 3 stations, one villager each), the spawn floor the only solid ground in the ±8 box, water
pushing golems into a lava blade over a hopper. **Paper settings it leans on** (all at their defaults): `entity-activation-range.
villagers: 32` + `tick-inactive-villagers: true` → the standing traders ARE the farm's clock; `iron-golems-can-spawn-in-air:
false` → a SOLID spawn floor; `hopper cooldown-when-full: true` → one hopper is enough; `max-entity-collisions: 8` → no cramming.
Bill: 10 iron of hoppers, 1 chest, lava + water bucket, 3 beds, ~200 stone. **The experiment that decides it has not been run:**
do villagers claim beds/stations on a pad 40 blocks out? Until then, trading is what pays.

## Next, ranked by what it unblocks
1. Babies → a shepherd (10 464 wool ≈ 580 em), a librarian (books), an armorer (IRON ARMOUR). Everything else waits on population.
2. Level the smiths with coal → journeyman iron tools, master enchanted diamond gear.
3. **Site chest at the village: DONE** (`village_trade.params.siteChest`, chest at -744,70,31 + a second at -744,70,30). It is a
   work-site chest through `A.stash`/`A.unstash`, so it never enters the depot's chest index and no bank/withdraw walks to it: a
   trip tops up from it on arrival and leaves whatever did not sell there instead of carrying it 1 250 blocks. **The road line
   (measured, the corridor the traders actually walk, not a drawn line):** -371,-490 → -415,-421 → -439,-378 → -484,-318 →
   -514,-242 → -573,-180 → -596,-139 → -636,-85 → -675,-27 → -714,27. 624 blocks, 0 `no_route` in ~20 trips; look at it from
   above before anyone paves it.
4. **Villager breeder + trading hall at the base — BRIEF, not built.** 16x16 pad inside the wall, 8 beds, one station per
   profession; all glut except 7 iron. The unsolved part is TRANSPORT of 2 villagers over 624 blocks: `bot.mount()` and
   `bot.moveVehicle()` do exist in mineflayer 4.39 (`lib/plugins/entities.js`) but nothing here has driven a boat, a villager must
   be shoved in by collision, and boats crawl on land; a minecart line is ~390 rails = 146 iron; a waterway is a mega-build.
   **Recommendation: build neither yet** — breeding works AT the village, so make the village the hall. Test boats in the lab first.
5. The iron golem farm (above), after the pod experiment. 6. Mob grinder + auto-smelter (both want hoppers = iron).
7. gold → piglin bartering is the Nether engineer's (docs/NETHER.md).

## Rules for this front
Never hit a villager or a golem, never break a block the village built (only our own lectern, and it goes straight back), never
trade with mobs within 12 blocks, never sell below the `SELL` reserve or sell iron to a smith, and **never trust `bot.inventory`
while a trade window is open** — count on the window (`inWin`), which is what cost the first trade its report.
