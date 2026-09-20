# DEV — how the bot army is built and how to change it
Read this only when you are about to edit code. Operating the army needs CLAUDE.md alone.

## 1. Architecture (all LLM-free at runtime)
```
ops/up.sh ─ server (Paper, :25565, rcon :25575; version: see server/) server/   log: server/console.log
          ─ 10 × bots/manager.js shards (3 bots each, :3001-3010) + bots/router.js (:3000)   log: bots/manager.log
          ─ bots/army/dispatcher.js   jobs.json + hb/*.json  →  assign/<bot>.json, BOARD.md, status.json
          ─ bots/metrics/inspector.js →  REPORT.md every 60 s (source of truth = the army ledger results.jsonl + chests.json; FIELD ANOMALIES block on top)
          ─ ops/shard-watchdog.sh     kills a shard whose API hangs (it auto-restarts)
every bot: assignments.json → skills/army_worker.js → reads assign/<bot>.json → runs a handler from skills/lib/army_jobs.js
           → writes hb/<bot>.json (heartbeat) + results.jsonl (reports: job_start, banked, death, pit_filled, no_route …)
```
Bots in different shards share NOTHING in memory. Shared state = files under `bots/army/` (atomic tmp+rename: `A.writeJSON`).
Skills are hot-reloaded: the worker re-requires `lib/army.js` + `lib/army_jobs.js` every loop, so an edit is live within ~20 s
with no restart. **`node --check <file>` after every edit** — a syntax error stops all 50 bots.

## 2. The job board — `bots/army/jobs.json`
`settings`: `base {x,y,z}` (origin of the base plan, y = THE ground level; `armyctl.js base set`), `muster {x,y,z,cols,step}`, `targets {<item|stock group>: n}` (labour by demand; groups `log planks food fuel iron` = `bots/army/stock.js`; `armyctl.js targets`), `roster`, `fallback` (sponge job id), `nightSkip`, `maxFronts`, `dusk`, `dawn`. Written by the `build` job as it places things: `craftTable [x,y,z]` (first table wins), `furnaces`, `chests {food|tools|ores|build|salvage: [[x,y,z],…]}`, `respawnBeds` (also every bot's OWN bed: roster index -> entry, without the sleeper's; it lies down every ~3rd dusk, `slept {own:true}` / `bed_skip` - army_jobs.js `bedDue`), `mineHead {x,y,z,facing}`.
A NEW WORLD starts with none of the coordinates: `armyctl.js bootstrap` writes the starting board (muster = spawn, targets and squads sized by `bots/roster.json`), `base set x,y,z` freezes the site, `plan-base --put` writes the zones as jobs; CLI templates show `<placeholders>`.
`enlisted`: bots the dispatcher manages (all 50). `jobs[]`:

| field | meaning |
|---|---|
| `id`, `type` | unique name; `type` = handler name in `army_jobs.js` (`muster`, `hunt`, `herd` = livestock INTO a finished pen and bred there (`params {pen:[x1,z1,x2,z2] ring, gate:[x,y,z], kind, want:10, radius:250}`; lure in hand — sheep/cow wheat, pig carrot/potato/beetroot, chicken seeds, never the depot's last 64 —, walks at the herd's pace, shuts the gate and reads it back; one visit inside the shut pen SHEARS the woolly adult sheep (`shear:false` = off; sheep byte = metadata 18 on 26.1) FIRST, then CULLS the adults beyond the standing flock `keep` (default: sheep 24 - wool regrows -, others `want`) - never babies, never while wool still stands in the pen, one herder per pen at a time so the gate only opens for him (`cull:false` = off); breeding stops at `max` animals (adults + babies; default = `keep`, a producing pen gets `max` = 2x `want`); give pen jobs honest `produces` (cows `leather`, chickens `feather`), never `food`; events `herded {n,inPen}` `bred {pairs,babies}` `pen_harvest {sheared,culled,got}` `herd_lost` `pen_open`; hands the bot back 10 min when there is nothing to lure or breed; `armyctl.js howto livestock`), `fish`, `scan` = quartermaster: chest index + cooking + ONE crafted batch per round towards `settings.targets` for the keys in `CRAFTED` (torch planks stick book bookshelf enchanting_table; only what the recipe solver can make from depot stock now), `scout` = land survey → `armyctl.js sites`, `depot`, `tidy` = groundskeeping tiles (params.exclude:[[x1,z1,x2,z2]] = finished structures it must leave alone; protected blocks are never junk), `lumber` = tree-farm squad (box, fells + replants on a grid, hands bots back while saplings grow), `farm` = big shared field (box, soil y, seed; squads sweep stripes, harvest age 7, replant, forage seeds), `cane` = sugar cane (paper → books): FARM `params {box, y = shore soil level}` + dry `site` plants every natural shore cell of the box (sand/dirt/grass whose soil touches water; found by looking, never tilled, water never touched), cuts the 2nd block of every cane ≥ 2 high, replants, banks at `bankAt`; WILD `params {wild:true, sites, radius, haul, farm, until}` cuts wild stands the same way and pauses itself when the farm holds `until` plants; events `cane_pass` `cane_trip` `cane_wild_empty` `cane_wild_done`), `deck` = close a cratered area at grade from the rim inwards (any number of bots), `tidy` = groundskeeping: FIRST the base audit's work list (`base_audit.json` ≤ 45 min old: `work` = off-level columns per sign + 8x8 tile, `strays`, `floats` = floating tree remains (taken down logs first, pillar ≤ 6 / 10 for a log, never pillared on farmland; `params.kinds:'float'` sends the sponge after one kind); nearest unclaimed unit, claim = blocks.js file lock, columns re-measured in the world, holes ≤ 6 filled ground-up / bumps ≤ 6 cut / strays dug → `tidy_fix {kind,at,n verified}`), only then its own 16x16 tiles over the box (junk pillars, stray single blocks, 1x1 holes/dug cells, floating blocks, littered crafting tables; dirt banked; job areas excluded automatically), `build` = ANY blueprint with ANY number of bots (`params.blueprint` from `armyctl.js blueprints`: shelter = house, wall_ring, level = 整地, platform, road, storage_hall …; dig top-down, place bottom-up, pauses itself when done; blueprint `fill_void` = SOLID fill of a pit/trench/deck void: strictly on solid blocks, lowest cell first, builders ride up inside, `params.unlid` takes thin decks/crusts off first, gravel is dropped down unreachable shafts, `args.ramp/keep/keepLid`; a finished pad over air is reported as `void_under_pad` — never deck a hole, fill it; `params.order:'near'` = nearest column first for long lines, `params.standing:true` = standing repair order that never pauses, `pad:false` = no levelling; blueprint cells may carry `mats:[…]` = accepted substitute blocks and `axis:'x'|'z'` = oriented block (fence gate) placed square to the wall; `wall_ring` FOLLOW mode = terrain-following wall from a probed `<name>.profile.json`; gates are FENCE GATES — the pathfinder opens only "gate" blocks, a door locks the army out), `berries` = pick a wild sweet-berry patch + plant/pick a hedge farm at base (the food engine for snowy taiga: no water/seeds/tilling), `light` = torch grid over a box (pitch 8, ground-level, `avoid` boxes; squad job), `sleeper` = one bot in the bed at dusk skips the night, `guard` = night shift around the base (kills mobs within radius, banks string/bones; the night SPONGE job), `haul` = bring a SITE chest home in bulk (`params.from`, `min`; fishers stash at the dock with `g1_fish.params.siteChest`), `delegate`, and **`steps` = an LLM-written plan of verbs, see §2b**) |
| `priority` | higher is staffed first |
| `status` | `active` / `paused` (`armyctl.js job <id> active|paused`) |
| `when` | `day` / `night` / `any` |
| `bots` or `names` | head-count, or pinned bot names; `exclude` = never these; `minBots` (job WITHOUT `produces`) = don't start under-staffed |
| `produces`, `minBots`, `maxBots` | LABOUR BY DEMAND: `produces:[item or stock group…]` → head-count = minBots + ceil((maxBots − minBots) × worst deficit against `settings.targets`); replaces `bots`. `armyctl.js targets` shows have/target/deficit/producers |
| `after` | id of the predecessor in a build order (`plan-base` chains). SELF-RUNNING: the dispatcher activates a paused successor when the predecessor is done (`job_activated` in results.jsonl) — never activate by hand out of order |
| `shiftMin` | SHIFT: a bot that holds the job keeps it for N minutes (while eligible, not declined, head-count not exceeded; a heartbeat quiet for < 10 min does not end it) — for jobs with a long commute (the mine job: 60) |
| `front` | work-site label; at most `settings.maxFronts` distinct fronts are staffed at once |
| `site` `[x,y,z]` | where the work is (dispatcher prefers the nearest bots) |
| `requires` | `{minHp, minFood, anyItem:[…]}` — `anyItem` is satisfied by carrying it OR by stock in the chest index |
| `params` | handler-specific. `delegate`: `{skill:'iron_miner', args:{entrance:{x,y,z,facing}, level:<landing y>, job?:'obsidian', want?, waterFrom?}}` — `job:'obsidian'` = one miner with a diamond pick + 2 water buckets casts and trenches obsidian at a lava lake a finished branch met (events `obsidian_cast`, `obsidian_banked`, `obsidian_no_lava`); the mine GROWS by itself (`mine_trunk_end`, `mine_exhausted` once/h at the real limit) |
| `plan` | which MASTERPLAN zone / approval the job relies on (mandatory for world-altering jobs) |
| `rev` | bump it to make running workers re-read changed params |

Unstaffed/ineligible bots get the built-in `muster` job: walk to their slot at base, eat from the canteen, defend the formation.

## 2b. How an LLM operates the bots — three layers (keep them apart)
| layer | who | runs | examples |
|---|---|---|---|
| **reflexes** | code, every tick / loop | always, LLM-free | eat, hit what is in reach, swim up, read-only travel, escape when boxed in, heartbeat |
| **verbs + routine jobs** | code, verified | when the board says so | verbs: goto, withdraw, bank, place, dig, collect, fell, craft, smelt, kill, till, sleep… · routines: `fish`, `hunt`, `scan`, `scout`, `delegate` |
| **judgement** | the LLM operator (any model) | only on events: session start, `plan_failed`, `no_route`, `stranded`, a gate reached | what to do next, where, with how many bots, in which order; reading the land; re-planning after a failure |

Pure algorithms cannot play Minecraft (every situation is new) and an LLM steering every tick is unaffordable. So the LLM writes
**plans, not code**: a job of type `steps` whose `params.steps` is a list of verbs (full verb list: header of `steps` in
`skills/lib/army_jobs.js`). Bots execute it with their reflexes running underneath and report each step (`step`, `plan_done`,
`plan_failed` + reason in `armyctl.js events`). A new situation needs a new plan, not new JavaScript. Example — a field depot (the coordinates are PLACEHOLDERS: take real ones from `armyctl.js ground`):
```json
{"id":"depot2","type":"steps","priority":75,"status":"active","when":"day","names":["Sakura"],"plan":"zone: field depot",
 "params":{"steps":[{"do":"withdraw","item":"chest","n":2},{"do":"goto","to":[X,Y,Z],"range":3},
                    {"do":"place","block":"chest","at":[X,Y,Z]},{"do":"place","block":"chest","at":[X+2,Y,Z]}]}}
```
Rules for plans: exact coordinates from a probe or `docs/WORLD.md`, never guessed; `dig`/`place` only explicit cells inside a zone;
`params.repeat:true` for production loops; bump `rev` to restart a plan; when the same plan is needed for the third time, promote it
to a routine handler (code) — that is what the top model is for.

## 3. Adding behaviour
- **New job type** = `async function name (bot, job, api, ctx)` in `skills/lib/army_jobs.js`, exported. Contract: poll `api.stop()`
  (true when the job changed / bot died / slice of 15 min is over) and return a short string; `api.phase()` = day|night,
  `api.time()` = ticks. Missing precondition → `return muster(bot, job, api, ctx, 'why')` — never improvise, never wander.
- **Primitives** live in `skills/lib/army.js` — use them, don't copy them: `travel` (read-only movement, ≤40-block hops),
  `bank`/`withdraw`/`openChest`/`scanChests`/`stockOf` (ONE chest index `army/chests.json`: no stock on record → no walk),
  `kill`, `pickup`, `hostiles`, `equipBest`, `count`/`inv`, `result` (report), `heartbeat`, `walkableArea`, `fillShaft`, `digOut`, `debt`.
  Block work: `skills/lib/blocks.js` (`placeBlock`, `digBlock`, `buildCells`, `clearAndFill`, `pillarUp`, `harvestTree`, `tillAndPlant` —
  player-like, server-confirmed, scaffold ledger). Furnaces: `lib/base.js smelt`. Eating: `lib/feed.js eat`. Fishing: `lib/fishery.js`.
- **Old role skills** (`iron_miner`, `builder`) run only through the `delegate` job type while they get absorbed. Known debt: they carry
  their own base logistics (chest scanning, table placing). Don't add new role skills; don't revive anything from `attic/`.
- **Scale by algorithm, not by orders**: a squad handler must work for 1 or 20 bots with no coordination messages — shared frontier/stripe
  logic + `blocks.js` position locks (`deck`, `farm`) or file claims (`iron_core` branches). Add head-count with `bots`, never with code.
- **Chest/craft results are judged on the open WINDOW** (`inChest`/`inHand` in `lib/army.js`, `craftOnTable` in `lib/craft.js`): `bot.inventory`
  lags while a window is open, and `bot.craft()` silently fails for some shaped recipes on this server. Don't call them directly.
- **Errors are never swallowed silently**: a catch that continues calls `swallow('file:line', e)` (`lib/swallow.js`) → `armyctl.js errors` shows what keeps
  failing quietly. **Placing never gives up at the first failure**: use `A.placeHard` (fetch/craft the item, build a support, reposition, scaffold,
  wait for the entity, clear the cell) — it reports `place_failed` with everything it tried. Same spirit for new primitives: every failure reason gets a remedy.
- **Trust only the server**: `pour`/`fill`/craft results are read back after a delay (client prediction lies). Never append a `//` comment to a line
  that continues with a chained call (it ate the dispatcher's `.sort()` for 40 min) — put comments on their own line and verify staffing after dispatcher edits.
- **Test first in the lab** (`lab/README.md`, port 25570, API :3100, cheats allowed there) when a change touches a primitive.
- Optional always-on modules (survival/combat/inventory…) plug in through `skills/core/index.js` (contract in its header); none exist yet.

## 4. Movement doctrine (owner's order — read before touching any travel code)
**How mineflayer-pathfinder really works:** it is A* over block cells where every move may carry a `toBreak[]` and `toPlace[]`
list. With the defaults (`canDig=true, digCost=1, placeCost=1, allow1by1towers=true`, scaffolding = any dirt/cobble in the
inventory) breaking a block costs about as much as walking 2-4 cells and placing one costs 1, so the "cheapest" path digs
through hills and leaves, bridges gaps, builds a step under every ledge and pillars 1×1 towers — and nothing ever removes them.
Each bot optimises its own trip; the next bot finds pits, stumps and pillars, fails to path, and edits even more. That is how
the base yard became a crater (chests floating over 6-16 deep pits) and the plateau got 35 trap pits and 72 junk pillars.

**Rules**
1. **Travel is read-only.** `A.strictMovements`: `canDig=false`, `scafoldingBlocks=[]`, `allow1by1towers=false`, no parkour,
   SPRINT while the larder holds >= 256 food and the bot's food > 6 (asked per trip in `A.travel`; the mine's raw-control walks sprint on looked-at cells only), `maxDropDown=3` (pathfinder counts to the landing's FLOOR block: real drop = value-1; surface trips use 2 = one block, reversible). `lib/terrain_guard.js` (installed by the manager on every bot; its timer calls the LIVE module, a new `VERSION` re-installs through `strictMovements`/`travel`) enforces the same on the surface
   whatever Movements a skill installs, and counts edits: `stats(bot)` → `pfPlaced/pfDug` must stay 0 (measured 0 for the army).
2. **No route = report, not dig.** `travel()` returns false and logs `no_route`; the fix is infrastructure (a road, stairs, a filled
   pit) built once by a planned job and used by everyone — never a private tunnel.
3. **Escape edits only when boxed in** (`walkableArea(bot) < 60`), and they must improve the spot for the next bot: a 1×1 pit is
   filled by pillaring up inside it (`pit_filled`); only roofed-in bots cut one staircase (`dug_out`). Every such edit is logged
   in `bots/army/terrain_debt.jsonl` for a later repair job. `armyctl.js rescue <bot>` is the last resort.
4. World edits belong to jobs with a `plan` inside a MASTERPLAN zone, done with `blocks.js` (scaffold ledger, cleanup).
5. Never write `bot.entity.position`; never force a reconnect to unstick; hops ≤ 40 blocks; one pathfinder goal per bot.

## 5. HTTP API (127.0.0.1:3000; `bots` = "all" | "A,B")
`GET /status?bots=..&brief=1` · `GET /events?since=<id>&type=death,chat,…` · `GET /players` ·
`POST /cmd {bots, action, args, wait}` — actions: stop, goto, say, equip, unwedge, escape_water, movement_debug, **eval** `{code}`
(async body with `bot, bots, goals, Vec3, require` — for one-off PROBES of a single bot, not for driving bots) ·
`POST /skill {bots, skill, args}` (the worker is started from `assignments.json` on every spawn; you rarely call this).
Console: `node bots/rcon.js "list" "time query daytime"` — read-only commands plus the approved `kill <hung bot>`.

**Bots talk (LLM-free):** every worker report passes through `speak()` in `lib/army.js` — job starts/ends, deliveries, trouble (`stranded`, `no_route`, `chest_full`) become short
Japanese chat lines from templates; one line per 3 s army-wide, one per bot per 45 s; `settings.talk:false` in jobs.json mutes. New event worth hearing? add a `case` in `lineFor`.

**Seeing the world:** `armyctl.js look <bot> [radius] [surface|cave]` (`skills/lib/look.js`) renders what a bot has loaded as an ASCII map — use it instead of
hand-written eval probes. `armyctl.js sites` ranks scouted land. Raw eval stays for the odd question a map cannot answer.

**Scoreboard team `army`** (all 50 bots; server-side, persists): friendlyFire false (bots killed bots with sweeping swords), collisionRule pushOtherTeams
(teammates do not shove each other — four bots once jammed in one stair cell), colour aqua + prefix `[BOT]`. A renamed/new bot must be added: `team join army <name>`. The `modes` datapack (written by `ops/new-world.sh`) forces everyone NOT in team `army` into SPECTATOR every tick and gives them the op-less `/trigger goto set <bot#>` (jump to a bot); the numbers are the order of `bots/assignments.json` — regenerate `tick.mcfunction` when the roster changes.
Command blocks are enabled on the server (`enable-command-block=true`); the bots never use them (legit survival) — they are the owner's tool.

## 6. Gotchas that cost hours (all measured)
- `pkill -f <pattern>` typed in a shell also kills that shell if the pattern is in your own command line — use `ops/down.sh`.
- A hard server kill makes bots suffocate in walls at next login (5 deaths on 09-19) — stop with `ops/down.sh all`.
- `bot.findBlocks` is synchronous: radius > 64 in a loop stalls the shard (`grep loop_stall bots/manager.log`).
- `bot.openContainer` rejects furnaces → `bot.openFurnace` (`lib/base.js openAt` handles both).
- `entity.objectType` logs a stack trace per read — use `e.name`. `entity.isValid` also goes false on chunk unload.
- Auto-eat leaves food in the main hand: re-equip before attacking/digging. `bot.entity.isInWater` = feet only; use `bot.headUnderWater()`.
- The pathfinder judges arrival on BLOCK coords and starts A* from the floored position: judge arrival the same way, and step off partial
  blocks (dirt_path, farmland, soul sand) by hand before pathing — both are handled in `A.travel`; don't write another travel loop.
- `GoalNearXZ` lets Y float (a bot at y15 under the muster point counts as "arrived"); prefer `GoalNear` with a real ground Y.
- keep_inventory is OFF: death drops everything (items despawn after 5 min). Bank before risk.
- Server and bot protocol versions may differ (Via* plugins translate; the running version: `server/`, the bots': `MC_VERSION` in `bots/manager.js`). Verify guide numbers against `bot.registry`.
- After `npm ci` in `bots/`: `sh bots/patches/apply.sh` (physics half-width + NaN-look patches; without them bots rubber-band).

## 7. Damage audits, who hears what, mine levels (the detail behind CLAUDE.md §2)
- **Audits compare the WORLD with what we made** (humans are spectators: the cause is a mob or one of our own jobs): bushes on the hedge pad per visit
  (`hedge_damaged` was → now); structures vs their blueprint once per quartermaster round (`structure_damaged` missing/of — the structure's own build job is
  re-activated = the repair); the farm: replanting without harvesting (`crops_vanished`), dry cells vs the best ever (`farm_degrading`), flowing water (`flood`).
  Also `bed_missing`, `mine_blocked`, `mine_hazard` (a branch burned a miner: off the market until `mine_hazard_sealed` or closed `why:lava`; `hazard` on its record in `bots/iron_mine.json`), `stair_broken`, `build_stuck`, `void_under_pad`, `ores_exhausted`, `chest_missing` (the quartermaster rebuilds: `chest_rebuilt`).
- **THE BASE AUDIT (`node ops/base-audit.js [--png out.png] [--all] [--dry]` · `--idle` = productivity alone; ~40 s, every ~30 min: the inspector is its clock, the
  foreman runs it before each round):** the events above are what bots report about THEMSELVES; this measures OUTCOMES against the PLAN. The spectator camera `SkyEye`
  (`ops/skyshot.js fly()`: 128-block lattice, raw chunk data at step 1, entities; lock `/tmp/skyeye.lock`; never touches the world) reads the base box (wall line) and
  compares it with the board: `settings.base.y` / `keepOut` / registered furniture, every build job's blueprint cells (board + `bots/army/jobs-archive.jsonl`, walls under
  roofs included), herd pens, farm boxes; bot positions per minute come from `bots/metrics/samples-*.jsonl`, output from `results.jsonl` (table `OUTPUT` on top of the
  script - extend it there). Findings = events `{bot:'audit', ev, msg, alert, fresh, text}`: `audit_rough` (off-level columns → clusters, NEW craters, never-levelled
  areas) · `audit_stray` (placed blocks in no blueprint; pens / depot / hall first) · `audit_fill` (per fill_void job, keep-outs included: columns still below grade, PINHOLES = open cell with four higher neighbours, coordinates) · `audit_weeds` (flowers / grass tufts on the base ground outside fields, pens, tree farm → tidy kind `weed`, pulled by hand, nothing collected) · `audit_floating` (leaf/log clusters without a rooted trunk or hanging over a pad / road / field; routine, no escalation) · `audit_pen` (inside vs OUTSIDE ≤ 96, open gate, climbable blocks, fence cells) ·
  `audit_growth` (share of the hour a bot stood within 128 = chunks ticked; ripe share; grew / stood still since the last audit; cane/lumber judged against their expected rate - 18 / 45 min per step - over 90 min / 3 h, a tree plot ≥ 50 % ripe = `backlog:true`, never an alert) · `audit_furniture` (registered but not
  standing) · `audit_field` (holes / raised / untilled / junk) · `audit_structure` (missing / wrong cells whatever the job's status; `unbuilt`) · `audit_idle` (bot-hours
  a job HELD vs what it produced; alert ≥ 30 % standing or ≥ 2 bot-h at zero). State: `bots/army/base_audit.json` (latest + prev for deltas; `fresh` = new or clearly
  worse). Read by REPORT.md (BASE AUDIT block + STANDING headline), the foreman's prompt (+ the picture: RED bump, BLUE hole, MAGENTA stray, YELLOW missing, ORANGE
  animal outside), `ops/escalate.sh` (fresh findings, once per kind per 60 min; kind `idle`), `armyctl.js events 20 audit`. Log of clock-started runs: `ops/base-audit.log`.
- **THE GEMBA WATCH (`node ops/gemba.js [seconds=60]`; library `require("ops/gemba.js").watch(60)`):** the audits above each know ONE failure CLASS; this one knows none
  (owner 09-20: "その解決方法だとその2件しか気が付けないのでは？"). It watches heartbeats for a minute and reads the last 10 min of `results.jsonl`, and answers the three
  questions the owner asks by just looking: WHO STANDS STILL (no 1.5 blocks moved; task/pos/boxed, sleeper/furnace/fishing/banking tasks marked excused), WHO IS USELESS
  (zero events of the `OUTPUT` table - the same table as ops/base-audit.js, extend BOTH - in 10 min), and WHICH JOB CRAWLS (cells/min/bot vs `PLAYER` = what one human does by
  hand on that blueprint; `left`, ETA, fails). A ring of the last 24 `left` samples per build job lives in `bots/metrics/gemba.json` (atomic write) and adds PROGRESS OVER
  TIME: `left` unchanged for >= 30 min with >= 2 bots = stalled. Lines beginning with `!` are findings and carry WHERE to look (`look`, `mapshot.js`), never a diagnosis:
  `army_still` (> 25 % of bots still), `useless_bots` (>= 8 without output), `slow_job` (> 5x slower than a player two samples running, stalled, or ETA > 2 h). The
  inspector is its clock (one 60 s watch every 10 min, async - the 60 s report loop never waits) and writes REPORT.md § GEMBA at the very top; readers: `ops/status.sh`
  (first lines), `armyctl.js wait` (one line per finding per 20 min), the foreman and operator prompts (they must answer every `!` line with what they SAW and CHANGED),
  `ops/escalate.sh` kind `gemba` (a `!` line still standing 30 min after the operator was told wakes the top model).
- **Who hears what:** `armyctl.js wait` = one line per audit signature, at most once per 30 min, plus ONE `info:` line (spawn_set, bed_replaced, forged; topic-less
  operators only). `ops/escalate.sh`: every kind once per 60 min; the top model's own BUGS.md lines never wake it; a BROKEN EDIT only when it lasts >= 60 s;
  `ops/escalate.sh check` = dry pass. REPORT.md: FIELD ANOMALIES block on top (assets damaged, planted vs standing, motion without output, warning storms).
- **`armyctl.js census`** = what stands in the world outside our books (containers, furnaces, tables, beds) + every exposed ore; `prune` archives finished one-off jobs.
- **Heartbeat `inv` is pockets only** (armour slots 5-8 are not in `bot.inventory.items()`): worn armour comes from a probe (`armyctl.js bot <name>`).
- **Mine levels (`armyctl.js mine level <y> [dry]`):** the level is an ORDER on the board — the command patches the mine job's `params.args.level` (+ `rev`); `bots/iron_mine.json`
  is the miners' cache (keyed by the entrance, read-only for everyone else). The stairwell is a 2-wide switchback (keep right, landing every 16 and at every level), dug, walled,
  lit, OWNED and audited by the miners on every commute (`stair_broken` → `stair_repaired`; `stair_no_filler` = no cobblestone in the kit). Step floors are TREADS = real `*_stairs` blocks (`stairCells().treads`, laid by climbers with stair blocks in the kit, `treads_laid`; walked up without jumping: 2.5 -> 3.9 steps/s). A bot in a `settings.keepOut` hole (the ravine) is never "in the mine". Underground movement is GRAPH-ONLY
  (branch → trunk → hub → stairs, no pathfinder, no private tunnel); `toSurface` is the one exit from any cell, `mine_reconnect ok:false` = a bot off the graph. A level that would
  move rows already dug is refused by the miners (`mine_level_refused`, the squad keeps its level); levels lie ≥ 3 apart. `wait` digests all of these.
  The miners also open the NEXT landing THEMSELVES (`mine_level_opened`, at most one per hour) when every dug level of the iron band y-16..48 is EXHAUSTED — every trunk
  mouth taken, every branch at 256, none open — and write it to the board like `mine level` does; `armyctl.js mine` marks such a level `EXHAUSTED` and prints the mean blocks out.
- **Chat:** `bots/chatter.js` (haiku, thinking off) answers PLAYERS in character and can do nothing else (no actuator); `speak()` in `lib/army.js` is the LLM-free work chatter.

## 8. New world (`ops/new-world.sh <seed>`; seed candidates: `ops/seed-gacha.js [n]` → `server-gacha/results.json`)
Moves (never deletes) the old world to `server/backups/world-<ts>/` and the army's world-bound state (chest index, ledger, scout/animal/census data, hb/assign, base.json,
iron_mine.json …) to `bots/army/archive-<ts>/`, sets `level-seed`, starts the SERVER ONLY, creates team `army` + gamerules + the spectator datapack and prints the
world spawn. It does NOT write the board: replace `bots/army/jobs.json` jobs/settings with a bootstrap board for that spawn (GOALS backlog 1), then `ops/up.sh`.
