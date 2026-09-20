// mats.js — material families for blueprints (NOT a blueprint: lives in lib/ so `armyctl.js blueprints` does not list it).
// WOOD-AGNOSTIC RULE (world 1 hard-coded spruce: in any other biome every gate, floor and chest order would have starved). A blueprint
// never names a species: `wood('fence')` gives a cell {block, mats, wood} whose `mats` accept EVERY species; the `build` job takes what
// is carried, then what the depot has, then the species whose logs/planks are in stock (`wood` = the suffix it crafts for).
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped']
const LOG = w => w === 'bamboo' ? 'bamboo_block' : /^(crimson|warped)$/.test(w) ? w + '_stem' : w + '_log'
const woodName = (w, kind) => kind === 'log' ? LOG(w) : w + '_' + kind
// kind: 'planks' | 'log' | 'slab' | 'stairs' | 'fence' | 'fence_gate' | 'door' | 'trapdoor'
const wood = (kind, extra) => Object.assign({ block: woodName('oak', kind), mats: WOODS.map(w => woodName(w, kind)), wood: kind }, extra || {})
const STONE = ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'stone_bricks', 'blackstone']
const stone = extra => Object.assign({ block: 'cobblestone', mats: STONE }, extra || {})
// what a farmer can till / what counts as "the soil is there" (farmland = a working tile, never replaced)
const SOIL = ['dirt', 'grass_block', 'farmland', 'podzol', 'coarse_dirt', 'rooted_dirt', 'dirt_path', 'mycelium']
const soil = extra => Object.assign({ block: 'dirt', mats: SOIL }, extra || {})
const COLOURS = ['white', 'light_gray', 'gray', 'black', 'brown', 'red', 'orange', 'yellow', 'lime', 'green', 'cyan', 'light_blue', 'blue', 'purple', 'magenta', 'pink']
const bed = extra => Object.assign({ block: 'white_bed', mats: COLOURS.map(c => c + '_bed') }, extra || {}) // any colour: the wool the shears bring decides
// a material PARAM given by the operator ('stone' | 'planks' | 'log' | a real block name) -> cell fields
const mat = (name, dflt) => { const n = name || dflt; return n === 'stone' ? stone() : /^(planks|log|slab|stairs|fence|fence_gate)$/.test(n) ? wood(n) : { block: n } }
// normalise(cell): the LOADER's guarantee that no cell is bound to a species, whatever a blueprint default or an operator's args say.
// 'planks' | 'log' | 'fence' … (no species) and '<species>_planks' … both become {block, mats: every species, wood: kind}; 'bed' / '<colour>_bed' = any bed.
const KINDS = ['planks', 'log', 'stem', 'wood', 'slab', 'stairs', 'fence', 'fence_gate', 'door', 'trapdoor']
const SPECIES_RE = new RegExp('^(' + WOODS.join('|') + ')_(' + KINDS.join('|') + ')$'); const KIND_RE = new RegExp('^(' + KINDS.join('|') + ')$')
function normalise (c) {
  if (!c || c.mats || c.wood || typeof c.block !== 'string') return c
  if (c.block === 'bed' || /^[a-z_]+_bed$/.test(c.block)) return Object.assign({}, c, bed())
  const m = KIND_RE.test(c.block) ? [null, null, c.block] : SPECIES_RE.exec(c.block)
  if (!m || (m[2] === 'wood' && !m[1])) return c
  return Object.assign({}, c, wood(m[2] === 'stem' ? 'log' : m[2]))
}
module.exports = { normalise,  WOODS, STONE, SOIL, COLOURS, woodName, wood, stone, soil, bed, mat }
