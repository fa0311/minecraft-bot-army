# WORLD — places, hazards, zones of the CURRENT world (overworld, coords x,y,z)
Machine truth first: muster / chests / craft table = `bots/army/jobs.json → settings`; furnaces = `bots/base.json`; mine = `bots/iron_mine.json`;
scouted land = `armyctl.js sites`; herds = `armyctl.js animals`. This page holds only what a human decided. Keep it under 60 lines.
Fill it in AFTER looking (`ops/skyshot.js x z [half]` = aerial photo + flat-land ranking, `armyctl.js look`, `ground`, `mapshot.js`) — never from memory, never from world 1 (`attic/world1/WORLD.md` is history).

## Key places
| place | coords | notes |
|---|---|---|
| seed / server version | `-1930374656508956714` / Paper 26.2 (bots speak 26.1 through ViaBackwards) | world 2, started 2026-09-19; chosen from 16 scored seeds + an aerial look (`ops/seed-look.js`) |
| world spawn | `0,70,0` (flower forest, wooded, hilly) | bots respawn here until they sleep in a bed → beds at the base are an EARLY job (550 blocks to walk otherwise) |
| base site | `-320,68,-448` (128x128 window: relief 4 — the window score missed a RAVINE, see Hazards; water inside 0 %, trees 4 %) | open PLAINS picked from the air (`ops/skyshot.js 0 0 512`, photo `server-gacha/site-A.png`): lake NW (~-500..-400, -690..-610), river S/SW (z -380..-300), forest N of z -600 and E of x -150, cherry grove 172 away at -416,-320 (on a hill, y 116+), plains village 624 away at -720,32 |
| muster point | `settings.muster` | jobless bots stand here |
| depot (chests, craft table) | `settings.chests`, `settings.craftTable` | one row per category on a LEVELLED pad |
| furnaces | `bots/base.json` | registered by the `build` job that placed them |
| mine head | `<x,y,z>` | ONE shared staircase; state is machine-written |
| water for buckets | `<x,y,z>` | an infinite 2x2 pool at the farm; never fetch from far away |

## Biome facts that drive the economy
- Within 512 of spawn (aerial tally): flower forest 24 %, plains 20 %, forest 15 %, ocean 10 %, swamp 10 %, river 7 %, jungle 4 %, savanna 4 %, cherry 2 %. No snow for ~1300 blocks.
- Ocean bay + beach sand S of spawn (z 50..500); jungle/bamboo E (x 350+, z -300..0). Verify animals and sugar cane on foot (`scout`).

## Hazards
- **Ravine (x -334..-289 / z -486..-408, down to y41) + the two day-one quarry pits in its corners: BEING FILLED SOLID** (owner 09-20 "渓谷は埋めないのか？"; jobs `fill_ravine_s/m/n`, strictly bottom-up with surplus stone). It is NOT a quarry any more - do not pause the fill for "bots inside the keep-out"; the keep-out goes when the fill is complete.
- RAVINE through the base site: x -330..-293 / z -482..-412, 10-15 wide, NNE-SSW, down to y41 (bots fell in on night 1; a narrow crack runs on N to about -308,-520). It is keep-out `ravine` = x -334..-289 / z -486..-408 (`armyctl.js base`): the base plan goes around it; future quarry (exposed ores). NOT fenced yet — no blueprint fits (`pen` lids its whole footprint, a rectangle ring at +2 cuts field 1).
- Bots report new hazards to `bots/army/terrain_debt.jsonl`; a `no_route` spot that needs a road/stair goes to the GOALS backlog.

## Zones — build ONLY inside the zone for that purpose; everything else stays natural. One zone = ONE height: `level` it first.
| zone | footprint x / z, y | purpose / job |
|---|---|---|
| base plan (machine truth: `armyctl.js plan-base` prints the map + every origin) | wall line x -408..-230 / z -559..-369, y68; plaza -339,-491 (NW corner of the ravine keep-out) | lattice of 32x32 slots around keep-out `ravine`, re-planned 09-19 from the survey `bots/army/survey-base.json` |
| core (hall + depot) | x -372..-341 / z -524..-493 | `base_core_pad` → `base_hall` → `base_depot` (moved off the ravine 09-19) |
| yard = muster · field 1 | x -369..-341 / z -489..-477 · x -360..-332 / z -446..-418 (dug before the re-plan: it stays, 3 columns inside the keep-out box, survey ok) | `base_yard_pad` · `base_field_1` → `farm_1` |
| cane block | x -282..-262 / z -489..-469 (E of road 9, 85 blocks from muster: crops grow only in ticked chunks) | `base_cane_pad` → `base_cane` (blueprint `cane_block`) → `cane_farm`; `cane_lake` transplants the old lake-shore stand (x -500..-420 / z -445..-375) |
| dump (`settings.dump`) | stand -333,69,-480 (NW rim of the ravine keep-out, spread along z), aim -329,64,-480 | the ONE junk disposal (`A.dumpJunk`): nothing is ever dropped inside the base. THE craft table = the hall's, -345,69,-523 (`settings.craftTable`) |
| infill | everything else inside the wall line except keep-out +3 | `base_infill_*` level tiles (plan-base), ONE level y68 |
| tree farm · mine head | x -282..-235 / z -454..-407 (E of the ravine) · x -337..-323 / z -507..-493, stairs descend NORTH (away from the ravine) | `base_tree` → `lumber_base` · `base_mine` → `mine_iron` |
| portal (Nether gate) | x -331..-322 / z -522..-514, y68 (frame at -328..-325,68..72,-518) | `base_portal` (blueprint `nether_portal`, `pad:false`) → job type `portal` lights it and crosses; probed flat grass y68 09-20, 18 N of the mine head, clear of every zone/road/keep-out. Far side: `settings.nether` (docs/NETHER.md) |
| WEST TERRACE | x -492..-476 / z -502..-458, cut to y73 | dirt + stone source, job `west_terrace_cut`: a grass hill 80 blocks W of the wall (tops y76-86) becomes a flat terrace - never a pit. Between it and the wall the land lies 5-6 below the base level (a gully at x -460..-452): future fill, not a building site yet |

Size every zone x50 (docs/GOALS.md scale rule): storage for ~200 containers, fields of 1000+ cells, a furnace bank, beds for 50, pens, lumber grid.
Style: straight axis-aligned edges, one or two materials, no dirt in anything permanent, no floating blocks, no holes, scaffolds removed,
fence + FENCE GATE (never a door) around farms/pens, tables/furnaces/chests are furniture — not litter. Roads and the torch grid are zones too.
