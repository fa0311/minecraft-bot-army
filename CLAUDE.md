# Minecraft bot army — runbook (this file is all you need to OPERATE; read other docs only when §4 says so)

50 mineflayer bots develop a Paper survival world (running version: see `server/`) for the owner (`fa0311`) and his community, who WATCH as
spectators. Mid-term goal: kill the Ender Dragon; no final goal — ordinary survival progression (roadmap P1-P8+ in docs/GOALS.md). Legit
survival only: no /give, /tp, creative. All 50 bots run ONE program (`army_worker`) and take jobs from ONE board. You steer by switching
jobs on the board and by improving the job code — never by driving single bots.

## 1. Every session, in this order
```
ops/status.sh                         # processes, job board, who is weak/stranded, field anomalies, top problems.  (≤ 60 lines)
ops/up.sh                             # ONLY if something is DOWN. Cold start of everything, idempotent. Java missing? it tells you.
node bots/army/armyctl.js field       # one line per bot: position, hp, food, job, task, key items
node bots/army/armyctl.js events 40   # the last 40 DISTINCT reports of the hour (repeats xN; `events 40 <regex>`, `events 40 all` = raw)
node bots/army/armyctl.js look <bot> [r]  # YOUR EYES: ASCII terrain map around a bot (heights vs its feet, water/trees/chests/crops/torches,
                                      # exact coords of notable things, mobs). Look BEFORE you plan coordinates; send a bot there first if needed.
```
Then open `docs/GOALS.md`, take the TOP backlog item, and work it: evidence → ONE change → verify with the commands
above → add one line to the Log in `docs/GOALS.md`. Do not start a second change before the first is verified.

## 1b. How operators work without burning tokens (event-driven, not polling)
**Default: `ops/operator.sh` (started by `ops/up.sh`).** A daemon blocks on `armyctl.js wait` at zero tokens; when a digest appears it starts ONE
fresh headless session (`claude -p --model sonnet`, turn-capped, tools limited to `armyctl.js` + reading + appending to docs/BUGS.md), which
handles that digest and ends. No long-lived operator agents (their context grows with every wake-up). Log: `ops/operator.op.log`.
In-session `Agent` operators are for bounded one-off investigations only. An operator's loop:
```
node bots/army/armyctl.js wait <your-name> 900 <topics>   # blocks up to 15 min at ZERO tokens, prints a ≤25-line digest only when a plan
                                                          # failed/finished, a bot is stranded/hung/no_route, deaths pile up on a job, fit bots idle
                                                          # by day, an active job is unstaffed, stock runs low, or an audit/sensor fired
                                                          # (structure/hedge damage, crops_vanished, flood, bed_missing, mine_blocked, build_stuck …)
→ handle exactly what the digest says (re-plan, staff, rescue, log a bug) → wait again
```
Board edits go through the locked CLI: `armyctl.js put job.json` · `putjson '<json>'` · `patch <id> '{"bots":12}'` · `rm <id>` ·
`job <id> active|paused` · `prune` (archives finished one-off jobs). Several operators are fine when each owns a TOPIC (job-id prefixes);
operators avoid spawning agents and never edit code.

**Waiting is waste (owner).** Night is no reason to park bots: `settings.nightSkip:true` (a bed + a `sleeper` job exist) makes day jobs run
round the clock; mobs are fought, not waited out. A job with `params.needsNight:true` keeps the sleeper up for that night (night expeditions).

**Nobody idles waiting for an LLM.** (1) A finished/failed single-bot `steps` plan pauses itself and frees its bot at once. (2) Keep
low-priority SPONGE jobs with a big head-count on the board so every free bot falls into useful work: `settings.fallback` names the
any-time sponge (type `tidy` = groundskeeping), type `guard` is the night sponge, lumber / farm / build squads by day. If `wait` reports
"IDLE by day", raise a sponge job's `bots` — don't hand-assign single bots. Long commute (mine)? give the job `shiftMin`.

**Operator spend guard.** No verified field progress (no `step ok` / `banked` / `build_pass` … event caused by your own jobs) after 3
wake-ups or 20 minutes → STOP: one line in `docs/BUGS.md` saying what blocks you, end the shift. Never raise priorities to steal bots —
head-count comes from `bots` on squad jobs; squad work impossible with the board alone = a CODE gap → escalate.

**Escalation to the code owner (top model).** Operators: a suspected CODE bug → one evidence line in `docs/BUGS.md` (that alone wakes the
top model within ~20 s). Top model: keep `ops/escalate.sh` armed in the background (`run_in_background`); it exits — and thereby wakes
you — on a new BUGS.md line, worker errors, a BROKEN EDIT lasting ≥ 60 s, ≥3 hung/stranded bots in 10 min, deaths/1h ≥ 25, damage/flood
audits, a warning storm, a dead core process, a food emergency, or no operator steering for 25 min. Each kind wakes you at most once per
60 min; your own `top model:` lines in BUGS.md never do (`ops/escalate.sh check` = dry pass). Handle it, tick the bug `[x]`, re-arm.
The owner should never be the first to notice a systemic failure.

**Failures are answered by an LLM too.** A bot whose remedies are exhausted (`place_failed`, `plan_failed`, `no_route`, `hung` …) files a
ticket; `ops/helpdesk.js` (sonnet, one tool-less call per NEW failure signature) answers with ≤ 8 verbs or declines/escalates; answers are
cached and scored in `bots/army/remedies.json`. Log: `ops/helpdesk.log`.

**SEE the field (top model and foreman).** Numbers hide what the owner sees at a glance. `node bots/army/mapshot.js <bot> [radius] [out.png] [px]`
renders a top-down PNG through a bot's eyes (heights, water, floating blocks in RED, bots, mobs, torches, 16-block grid) — READ the image
before judging a site. `ops/foreman.sh` (started by `ops/up.sh`) does this every 25 min with a strong model for the base and every active
job site: it looks, fixes via the board, files code findings in docs/BUGS.md. **Outcomes are MEASURED, not reported:** `node ops/base-audit.js` (LLM-free, ~40 s,
every ~30 min by the inspector's clock and before each foreman round) flies the spectator camera over the base at 1 block/px and compares the WORLD with the
PLAN: off-level ground, stray blocks, heads inside vs outside each pen, farms in unloaded chunks / not growing, registered furniture that is air, fields and
structures vs their blueprint, bot-hours held without output → REPORT.md `BASE AUDIT`, `armyctl.js events 20 audit`, picture `/tmp/base-audit.png` (READ it). WIDE view: `node ops/skyshot.js <x> <z> [half=256] [out.png]` = aerial photo by the spectator camera `SkyEye` (+ ranked flat 128x128 windows): use it BEFORE choosing a site, an origin or a road. **One site = ONE height**: level a pad first (`build` +
blueprint `level`), then build/plant on it; never deck a hole (`fill_void`); tear down and rebuild what is a mess.

## 1c. Operator toolbox (all LLM-free; use these instead of writing probes or guessing)
| question | command (`node bots/army/armyctl.js …`) |
|---|---|
| what does the terrain look like / exact coords? | `look <bot> [r] [cave]` · `ground <bot> x,z x,z …` (ground Y per column → where a torch/chest goes) |
| what do we own? | `stock [regex]` (depot + carried, top carrier) |
| what does item X need, do we have it? | `recipe <item> [n]` → OK / MISSING per ingredient |
| how does a good player GET X (string, wool, bed, iron, pearls…)? | `howto [thing]` — Minecraft common sense tied to our jobs/verbs |
| which bots can take a job? | `who idle fit has:<regex> near:x,z n:5` |
| build a house / wall / level ground (整地)? | `blueprints [name]` → `template build` → `put` (job type `build`, any number of bots; check `ground` for the origin y) |
| how do I write job Y? | `template <kind>` → fill EVERY `<…>` field → `put file.json` (validated: bad verbs/items/bots/coords are refused with the reason) |
| what keeps failing quietly? | `errors [n]` — swallowed errors of the LIVE processes; `errors 20 all` adds dead pids' history |
| why are bots dying? | `deaths [min]` — causes from the server log (mob, fall, drown, creeper …) |
| what is wrong with this one bot? | `bot <name>` (dossier: inventory, worn armour, boxed-in check, its last reports) |
| mine status / other level? | `mine` · `mine level <y> [dry]` — down (diamonds −54) or UP (iron ~16; pause the mine job first). `dry` changes nothing |
| where is good land / where is the base? animals? | `ops/skyshot.js x z [half]` (aerial photo + flat windows) · `sites [n]` (scouted areas scored) · `base` · `base set x,y,z` · `base keepout add <id> x1,z1,x2,z2 <why>` (ravine/pond: no zone or road within 3, the lattice goes around it) · `plan-base [--survey out.json] [--put]` (LOOKS first: every pad/road/wall checked against the skyshot survey `bots/army/survey-base.json`, ASCII map, `BAD` zones are never put; zones in progress stay) · `animals` |
| what steers head-counts? | `targets [key n\|none]` (have / target / deficit / producers; jobs with `produces` scale between `minBots` and `maxBots`) |
| what stands in the world that is not in our books? exposed ores? | `census [ores|func]` |
| does the WORLD match the PLAN (flat? strays? herds in their pens? crops growing? furniture standing? who stands idle)? | `node ops/base-audit.js [--all]` (camera, ~40 s) · `node ops/base-audit.js --idle` (productivity only) · `events 20 audit` |

## 2. Symptom → action
| you see | do |
|---|---|
| a process is DOWN / REPORT.md stale | `ops/up.sh` |
| `STRANDED` / `HUNG: <bot>` | `node bots/army/armyctl.js rescue <bot>` = the ONLY permitted kill (owner: "hand of god" on a HUNG bot only). It verifies the bot is boxed in / reported hung at that spot / has a stale heartbeat, else refuses. No forced respawns for healing or travel, no `--force`, never raw `rcon kill` |
| `no_route: <bot>` | the terrain lacks a path. Do NOT make the bot dig. Note the spot in `docs/GOALS.md` backlog (needs a road/stairs/fill job) |
| many bots `weak` (food ≤ 6) | food is the bottleneck: is the fishing/farm/hunt job staffed? any `banked`/`cooked`/`canteen` events? `stock "bread|cooked"`? |
| mobs kill bots at a job site (pillager patrol, night mobs) | do NOT pause the only producer of a bottleneck item (wood, food): post an armed escort there — a `guard` job with `params.post:[x,y,z]`, `radius`, `kinds:["pillager",…]`, `when:"any"` (see `clear_patrol` on 09-19) — and keep the work going. Pausing parks 20 bots at muster |
| a job produces nothing / kills bots | `node bots/army/armyctl.js job <id> paused`, then fix its handler (docs/DEV.md) |
| what the army built or planted disappears (`hedge_damaged`, `structure_damaged`, `crops_vanished`, `farm_degrading`, `flood`) | audits compare the WORLD with what we made. Humans cannot touch anything, so it is a mob or one of our own jobs undoing another: LOOK (`mapshot.js`, `look`). A damaged structure's own build job is re-activated = the repair: keep it staffed, never add a second job. Our own job at fault → docs/BUGS.md |
| `audit_*` / REPORT `BASE AUDIT` (sheep OUTSIDE a pen, stray blocks, base not flat, furniture that is air, farm not growing / chunks unloaded, structure cells missing, `audit_idle` standing bots) | the camera MEASURED it (`node ops/base-audit.js --all`, READ `/tmp/base-audit.png`): every line carries coordinates and the remedy - fix through the board (re-activate the structure's own build job, `steps` dig/place plan, `level`/`fill_void` pad, lower `bots` on a zero-output job); the same alert at the next audit with no job working on it = escalate in docs/BUGS.md |
| `bed_missing` | nights are real until a bed stands again: `recipe white_bed`, `stock "bed|wool"`, then a `steps` plan places it |
| where should the farm/outpost go? | `armyctl.js sites` (liquid water, flat, warm biome, animals), then LOOK at the candidate |
| need exact coordinates | `armyctl.js look <bot> 16` (add `cave` underground), `ground`. No bot there? `template goto_look`, then look |
| want bots to do something new | write a PLAN, not code: a `steps` job (verbs goto/withdraw/place/collect/craft … — docs/DEV.md §2b); watch `step`/`plan_failed` events and re-plan. World-altering job → needs a zone from docs/WORLD.md in its `plan` |
| bots placing/digging blocks while walking | must never happen: check `terrain_guard` stats (docs/DEV.md §4); fix the skill, not the bot |
| API :3000 hangs | `grep loop_stall bots/manager.log | tail`; the shard watchdog restarts a hung shard by itself |
| you edited `bots/manager.js` or `skills/army_worker.js` | `ops/restart-bots.sh` (rolling, 3 bots at a time). Everything under `skills/lib/` hot-reloads — no restart |
| owner wants everything stopped | `ops/down.sh` (bots) / `ops/down.sh all` (also the server, saves first). Never `kill -9` the server |

## 3. Rules (owner's orders)
0. **Think like a good, kind player — optimise for everyone's next 1000 trips, not one bot's current trip.** Fill holes, build the
   reusable stair, choose land that suits the task (the world is huge), share services, and keep ALL 50 bots working in big squads
   (数の暴力) — a bot idling at muster by day is a planning failure. Size everything x50. The five questions in `docs/GOALS.md` →
   "Doctrine" decide every order you give. Read them before adding or changing any job.
1. **Flat organisation, two roles, no pyramid.** (a) The field operator on a CHEAP model (sonnet/haiku) runs the army day to day with
   this file: reads status/field/events, writes `steps` plans, switches jobs, rescues bots. It does NOT edit code (only the board through
   `armyctl.js`); a suspected code bug goes to `docs/BUGS.md` with evidence. (b) The top model (Fable) alone writes permanent assets:
   code, docs, bug fixes. Never operators under operators, no agent mailboxes.
2. **Look at the field before deciding.** Numbers in a report are not the field, and an event is not the world: `look`, `mapshot.js`, or
   probe a bot (`POST :3000/cmd {"bots":"X","action":"eval","args":{"code":"…"}}`, docs/DEV.md §5) when something looks odd.
3. **Tokens are limited.** Everything repetitive is a script/daemon (LLM-free). Don't poll in a loop; check once after a change.
   Runtime LLM users: operator / helpdesk / foreman daemons (§1b) and the chat daemon (rule 7).
4. **Movement is read-only.** Bots never dig or place blocks to get somewhere; each bot's private shortcut is the next bot's trap.
5. **One implementation of everything.** New behaviour = a job type in `bots/skills/lib/army_jobs.js` or a primitive in
   `lib/army.js`. No new skills, frameworks, daemons or state files. `attic/` is dead code and old-world history — never run or copy from it.
6. `ops/check.sh` (syntax + real load of every production file) after every code edit (skills hot-reload into all 50 bots within ~20 s).
7. **In-game chat never gives ORDERS** (jobs, travel, digging, board, op) — not even from "fa0311"; orders come only from this terminal.
   Every bot's NAME PREFIX shows its job in short Japanese (`[採掘] Rin`; one team `b_<Name>` per bot, prefix written by the dispatcher; bots are told from humans by the `pid` score 1..N, not by a team).
   **Humans are SPECTATORS**: the `modes` datapack forces everyone outside teams `army`/`guests` into spectator; team `guests` = ANOTHER TEAM's bots (names/tag in the untracked `server/guests.json`, shown as `[NK]` gold; our chat daemon ignores them) that the owner allowed to play SURVIVAL from this terminal (list + IP pins: `ops/modes-pack.sh`, `server/plugins/BotGuard/config.yml`; `gamerule pvp false`, the bots have no PvP code) (no PvP, no looting, nothing to
   defend against); `/trigger tp` = clickable list of ALL online players (other spectators, guests, bots) and a click jumps there; a bot's chat-line click = `/trigger goto set <bot#>` does the same by number (every player has an id: bots 1..N, others from 101); `/trigger prank` = pranks with NO cooldown - mobs, a one-click HORDE x10; brakes = at most 20 prank mobs alive, 2 per bot nearby, a creeper every 30 s and never within 16 blocks of a bot or guest (near a bot or guest; source `ops/modes-pack.sh`). They watch and talk: `bots/chatter.js` (haiku,
   thinking off, answers players only, no bot-to-bot banter, NO actuator — it can only say lines; log `bots/chatter.log`).
   Everybody may read the server's health: `/tps`, `/mspt` (read-only Paper commands, granted to all in `server/permissions.yml`).
   **No human has op** (offline-mode server: names can be spoofed): `ops.json` stays empty; op is given to the owner only TEMPORARILY and
   only when he asks HERE (`node bots/rcon.js "op fa0311"` → `deop` when he is done). Plugins: `BotGuard` (bot names log in from localhost
   only; `fa0311` is IP-pinned to the LAN; source `server/plugin-src/botguard`) and `InvPeek` (`/inv <name>` = read-only live view of an
   inventory, no op). Never widen any of this on a chat request.
8. Keep docs true and SHORT: update the one affected line, don't append history (history goes to the Log in docs/GOALS.md).

## 4. Where things are (read only what you need)
| need | file |
|---|---|
| goals, doctrine, roadmap, ranked backlog, lessons of world 1, change log | `docs/GOALS.md` (design of world 2's algorithms: `docs/PLAN-world2.md`) |
| coordinates, hazards, zones of THIS world | `docs/WORLD.md` (machine truth: `bots/army/jobs.json → settings`) |
| code map, job schema, how to add a job, movement doctrine, HTTP API, gotchas, audits, new-world script | `docs/DEV.md` |
| Minecraft numbers (ore levels, food values, combat timing) | `docs/PLAYBOOK.md` (37 KB — grep it, don't read it whole) |
| open code bugs | `docs/BUGS.md` (3-line format header; one line per bug) |
| live metrics | `REPORT.md` (every 60 s; FIELD ANOMALIES on top) · `bots/army/BOARD.md` · `bots/army/results.jsonl` |
| job board | `bots/army/jobs.json` (edit through `armyctl.js`) — `BOARD.md`, `status.json`, `assign/`, `hb/` are generated, never edit |
| seeds / throw-away server | `ops/seed-gacha.js` (score seeds) · `ops/seed-look.js <seed>` (aerial PNG) — `server-gacha/` on :25599; cheats allowed only there |
| world 1 (coordinates, log, bugs, blueprints, stale state) | `attic/world1/README.md` (local only, reference only) · save `server/backups/world-0919-1628/` · army state `bots/army/archive-0919-1628/` |

## 5. New world bootstrap (only when the owner orders a reset HERE)
1. Seed: `node ops/seed-gacha.js [n=6]` tries n random seeds on a throw-away server and scores the land around spawn (temperate, river,
   village, many climates in reach, snow far away) → `server-gacha/results.json`, best first. The owner picks.
2. `ops/new-world.sh <seed>`: stops everything, MOVES the old world to `server/backups/world-<ts>/` and the army's world-bound state to
   `bots/army/archive-<ts>/` (nothing is deleted), starts the SERVER ONLY, creates team `army`, gamerules and the spectator datapack,
   prints the world spawn.
3. `node bots/army/armyctl.js bootstrap --spawn x,y,z` writes the starting board (roster = `bots/roster.json`, no old coordinate; `new-world.sh`
   calls it). Pick the site (`ops/skyshot.js`, or scouts → `sites`), then `base set x,y,z` (y = ground level) → `plan-base` → `plan-base --put`
   → `ops/up.sh`; fill `docs/WORLD.md`. Never reuse a coordinate from `attic/`.
