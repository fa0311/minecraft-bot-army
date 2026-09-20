# bots/skills — what is production, what is not
| file | status |
|---|---|
| `army_worker.js` | **PRODUCTION** — the one role skill of all 50 bots (started from `bots/assignments.json`) |
| `lib/army.js`, `lib/army_jobs.js` | **PRODUCTION** — primitives (travel, chests, kitUp, obtain, furnaces/smelt, escapes) + job handlers |
| `lib/census.js`, `lib/look.js`, `lib/mapshot.js` | perception behind `armyctl.js census/look` and `mapshot.js` |
| `lib/craft.js` (wood-agnostic recipe chooser + table hands), `lib/feed.js` (eat), `lib/fishery.js`, `lib/blocks.js`, `lib/util.js`, `lib/terrain_guard.js`, `lib/swallow.js` | libraries the above import. The worker reloads ALL of `lib/` when any file in it changes |
| `lib/base.js`, `lib/roles.js` | SHIMS for old call sites (army_jobs/iron_miner -> `A.smelt`/`A.openAt`/`A.furnaces`; iron_miner bootstrap -> `chopWood`): delete once those call army.js/blocks.js |
| `core/index.js` | plug-in contract for always-on modules (none written yet) |
| `iron_miner.js` + `lib/iron_core.js` | DELEGATE — runs only via job type `delegate` (the mine levels, obsidian); to be absorbed into a native handler |
Rules: no new top-level skills. New behaviour = handler in `lib/army_jobs.js`. Retired world-1 records are in `attic/world1/` (reference only, nothing there runs).
