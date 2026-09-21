# Blueprints

Each file exports `module.exports = (origin, params) => [{x, y, z, block}, ...]`

* `origin` = `{x, y, z}` integers. By convention `y` is the **base layer** (first
  layer that gets built) and `x/z` is the **centre** of the footprint unless the
  blueprint says otherwise.
* `block` is a real Minecraft block name (`cobblestone`, `furnace`, ...) or one of the kinds the `build` job understands:
  `'air'` = make sure this is empty (dig) · `'water'` = a WATER CELL (floor + 4 sides solid -> dig -> pour ONE bucket -> verify a source ->
  never touched again; claimed on the board; farmers never pour) · furniture (`chest`/`barrel` + `cat` [+ `half` 0|1 of a double chest],
  `furnace`, `crafting_table`, `*_bed` + `facing`, `torch`) - furniture that stands is REGISTERED in `settings` by the build job.
* WOOD-AGNOSTIC: never name a species. Use `require('./lib/mats')` (`wood('planks'|'log'|'fence'|'fence_gate'|…)`, `stone()`, `soil()`, `bed()`,
  `mat(param, default)`) or the generic block names `'planks'`, `'log'`, `'fence'`, `'fence_gate'`, `'bed'`: the loader (`normalise`) gives every such
  cell `mats` = all species, and the build job takes what is carried / in stock / craftable from the wood we own.
* Coordinates are absolute. Duplicates are fine (last one wins).
* Keep generators pure & fast — they are re-run by every bot and cached per job.
* Optional cell fields read by the `build` job: `fillOnly` (place only where the world has a hole), `mats:[…]` (accepted substitute blocks),
  `axis:'x'|'z'` (oriented block such as a fence gate: the direction the WALL runs; the builder stands square to it), `facing:'north'|…` (a bed:
  the head lands one cell further that way - keep it free), `needs:'water'|'below'` (wait until the cell below is a water source / solid: a cap
  over a water cell, a torch on its block), `solid` (fill_void rules), `soil:true` (a farmland tile of `field_block`).
  `pool:true` on a `water` cell (blueprint `well`): a source of the same pool counts as a closed side, it is poured with allowFlow, and a cell with two
  pool sources beside it is just opened (it fills itself) - two diagonal pours make a 2x2 infinite pool.
* BASE-PLAN blueprints (`armyctl.js plan-base`): `field_block`, `core`, `depot_rows`, `dorm`, `tree_farm`, `pen`, `mine_head`, `road`. Their header
  says `origin = NW corner` or `origin = centre` (plan-base reads that), they take `{w, d}` = their slot and never build outside it, and they
  export `.meta(args)` = `{origin, w, d}`. PAD RULE: the build job levels footprint + 1 first, except for the blueprints in its NO_PAD list. Outside the blueprint's own columns the pad never cuts below the origin y (a basement is no ground level). A `fillOnly` ground cell with `unlid:true` (road sub-base) makes the build job take a shallow deck off, fill the column, and put the block back.
* Cell flags since 09-20: `natural:true` on an `air` cell = only natural ground is cut, never another job's column or a block something stands on (`road` shoulders: s cells out the bank may stand s above the paving, `shoulder=4`); chest + `facing` + `half` = a pair that must MERGE (`depot_rows`: every chest faces its aisle; the build job places, verifies and re-makes them).
* Retired with world 1 (attic/world1/blueprints/): `warehouse` + `storage_hall` (-> `depot_rows`), `lake_farm` (-> `field_block`), `shelter` (-> `dorm`).
* `*.profile.json` = probed ground heights `{"x,z": y}` for terrain-following blueprints (`wall_ring` FOLLOW mode); probe BEFORE building.
