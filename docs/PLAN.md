# PLAN — ONE target block per cell (the compiler, the precedence, the diff, the leases)

Owner, 09-21: 「土被せと道路が干渉してる / どうしてそういう事が起こるわけ？ lockみたいな仕組みがないの？目標のブロックが決まってないわけ？差分管理というか /
管理アルゴリズムが現実的に無理な方法で行っているのでは？」 — he named the architectural flaw. **Locks answer "who may swing now"; they cannot
answer "what is supposed to stand here".** Two jobs each held an authoritative, contradictory answer for the same cell, so whoever ran last
won, for ever (`build_runaway` every few hours for 20 hours; `cap_ravine_nm` x `fill_ravine_m` = 1196 cells, cap lays dirt, fill lays cobble).

The fix is a **compiler, not a guard**: `bots/army/plan.js` expands every source of intent ONCE, decides every contested cell ONCE, at plan
time, and hands out `target(x,y,z) -> {block, owner, layer, kind, mats}`. Report: `node ops/plan-check.js` (read-only).

## 1. The model
| term | meaning |
|---|---|
| **source** | one thing that says what should stand somewhere: a `build` job (blueprint + origin + args), one SEGMENT of a `road` job, and the same from `bots/army/jobs-archive.jsonl` (a finished hall is still the target for its cells). |
| **kind** | the source's precedence class: `structure` · `road` · `pad` (`level`) · `fill` (`fill_void`/`clear_area`/`quarry`) · `deco` (`level cap:true`). |
| **layer** | the CELL's material rule: `structure` (a face or furniture) · `surface` (the visible top of a column) · `body` (buried) · `none` (must be air). |
| **owner** | the job id that owns the cell after resolution. `plan.owns(jobId,x,z)` is O(1). |

**Storage** — sparse, chunked, memoised on the board's mtime: a palette of distinct descriptors (460 for the whole base) plus, per 16x16
chunk, a `Map(int -> int)` with **one int→int entry per cell** (key `((y+128)<<8)|(lx<<4)|lz`). The current board = 377 k cells in 200
chunks, ~2.2 s to compile, ~60 MB. A query or a diff walks only the chunks of its box; nothing stores a per-cell object.

## 2. Precedence — the order of resolution (stated once, applied at plan time)
```
structure (60) > road (50) > pad/level (40) > terrain fill (30) > decoration/cap (10)
   same rank ->  a LIVE job beats a FINISHED one (terrain only: the board is the present tense, the archive only remembers)
              ->  higher board `priority`  ->  the SMALLER footprint (the more specific plan)  ->  the id (deterministic)
```
The winner's block **is** the target; the loser's cells are rewritten away — a pad simply ends where the road begins, a cap that has nothing
left is struck off the board. Both never survive. Structures keep the priority tie-break even against finished work, because a building
inside a building is a mistake, not a remediation: that pair is raised as a `buried` **plan error**.

**Plan errors** (precedence cannot reconcile them; a human decides): `grade_conflict` (two terrain jobs want the ground of one column at
different y — "one site = ONE height"), `same_rank` (same class, ≥8 cells where they want different blocks), `keepout` (a structure or road
planned inside a `settings.keepOut` box), `buried`. A pad and the thing built on it (`<zone>_pad` → `<zone>`, or an `after` chain) overlap by
design and are never errors.

## 3. The owner's material rule (09-21) lives in the map, not in the jobs
> the cell a player will SEE carries its exact material; everything buried accepts ANY stone sort.

* `layer:'structure'` / `'surface'` → exact block, plus the substitutes the blueprint itself named (wood species, bed colours, soil family).
* `layer:'body'` → any stone sort (`BODY_OK`). A buried cell is therefore **never** "wrong material", so it is never worth a dig.
* A terrain job's **top** cell is `surface`: if the blueprint named its own top (a road's cobblestone, `fill_void params.top`, a `level cap`)
  it keeps it; otherwise the compiler rewrites bare filler to the ground material `dirt` (3 590 cells on today's board).
  **That retires the whole `cap_*` class** — the fill's own grade cell already is the dirt a cap used to lay, so there is nothing to cap.
  The MIGRATION the owner asked about (「現状は土被せがないとマイグレーションされないからね」) is not lost: old bare-stone ground now appears as
  `wrong` diff cells **owned by the fill itself**, so the same crew swaps them on its own column instead of a second job racing it.

## 4. The diff IS the work list — for building, for repairing, and for the camera audit
Owner 09-21: 「全てを目標ブロックに記録することでアルゴリズムのミスで壊れた部分もすぐに修復できるのではないか？」 Once every cell's intended block is on
record, damage needs no special bookkeeping. A dig/place loop, a fill that ate a road, a creeper, a lava flow all surface as the same three
classes, and the crew that built the place repairs it:
```js
plan.diff(world, box) -> { counts, byOwner, byZone, cells:[{x,y,z,want,have,how,owner,layer}] }
   how = 'missing' (target solid, world air) | 'wrong' (material the target does not accept) | 'extra' (target air, world solid) | 'ok' | 'unknown'
```
`world(x,y,z) -> name|null` fits both a bot (`plan.botWorld(bot)`) and the SkyEye camera (`ops/skyshot.js fly()` → `R.name`). `null` =
chunk not loaded → `unknown`, never `missing`. An `air` target is **not** a licence to clear: torches, cane, crops and furniture in a
headroom cell count as `ok` (measured: 804 false "extra" cane cells before this rule). A finished excavation's air cells are dropped — a
closed quarry is not a standing order to keep digging.

**Never retry for ever:** `plan.persistent(prevDiff, curDiff)` returns the cells reported wrong in BOTH passes — a crew has already failed
there. Those are escalated (one line in `docs/BUGS.md`), not handed out again.

## 5. Cell leases — the lock the owner asked for, for SURVIVAL not for work
Owner 09-21: 「ブロック単位のロックを行うことで帰り道を他のbotが塞ぐことが防げるのではないか？」 Kokoro was buried under 19 blocks this morning because a
mate's fill closed the column she stood in. A lease says "for the next minutes this cell is mine — not to build, but to stay alive".
```js
plan.lock(cells, bot, ms)        -> {ok, got, refused}   // ≤64 cells, ≤10 min, only cells IN the map or ≤6 blocks from the holder
plan.lockStanding(bot, {up:3, down:1, shaft:[…]})        // own column + the way out, in one call
plan.release(cells, bot) · plan.releaseAll(bot) · plan.lockedBy(x,y,z)
```
**One implementation:** a lease is written into the SAME per-cell lock file `blocks.js` already checks before every place and dig
(`bots/.blocklocks/<x>_<y>_<z>`, content `who <expiryMs>`). No new state file, no new directory, and no patch to `blocks.js` — every
`placeBlock`/`digBlock` in the army already refuses a cell another bot holds. Leases expire by themselves; a dead bot's clear.

## 6. API
```js
const PLAN = require('<workspace>/bots/army/plan.js')
const plan = PLAN.compile({ archive:true, box, dim:'overworld', fresh:false })   // memoised on the board's mtime
plan.at(x,y,z)        -> {block, mats, owner, src, kind, layer, natural, fillOnly} | null   // null = natural ground: NOTHING may dig or place
plan.owns(jobId,x,z)  -> bool        plan.ownerAt(x,z) -> the column's surface target
plan.cells(box)       -> generator of {x,y,z,t}          plan.inKeepOut(x,z) -> keep-out id | null
plan.diff / plan.lock / plan.lockStanding / plan.release / plan.releaseAll / plan.lockedBy / plan.persistent
plan.overlaps · plan.errors · plan.subsumed · plan.sources                        // what ops/plan-check.js prints
```

## 7. What this does NOT solve (honest list)
* **A job that edits the world without a plan.** Escape digs (`digOut`, `pillarUp`), `steps` plans, the mine's own graph and spurs are
  outside the map. `plan.at()` returns `null` there, which is the honest answer — not a permission.
* **Mobs, lava, gravity, growth.** They are damage, and the diff will SHOW them; the map does not prevent them.
* **The world below and beyond.** Only the base box and the roads are compiled; the Nether, the mine and open country have no targets yet
  (the same compiler takes them when their jobs carry blueprints).
* **Bad plans.** The compiler makes interference impossible; it cannot tell you that a zone is in the wrong place. `grade_conflict` and
  `keepout` are the only judgements it makes, and both need a human.
* **Ordering.** It says WHAT, never WHEN: the `after` chains and head-counts still belong to the board.

## 8. Migration (not done today — the library ships first)
1. `node ops/plan-check.js` after every board change; fix the plan errors it lists before staffing the jobs.
2. Take the subsumed `cap_*` jobs off the board (`armyctl.js rm`): the material rule already does their work.
3. Patch `build` to take its cells from `plan.diff` instead of its own box (patch list in the hand-over); `ops/base-audit.js` measures
   `audit_structure`/`audit_surface`/`audit_fill` against the same diff. Both read the SAME map, so an audit can no longer disagree with a
   builder.
4. Running jobs need no migration: the compiler is read-only and changes nothing until a handler calls it.
