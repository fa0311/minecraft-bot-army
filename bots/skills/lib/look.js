// look.js — the operators' EYES. Turns what a bot has loaded around it into a compact ASCII map an LLM can read.
//   look(bot, r=16, mode='auto') -> { pos, biome, mode, rows:[...], legend, things:[...], entities:[...] }
// surface mode: one char per column = top solid block relative to the bot's FEET level (what you would see from above)
// cave mode   : one char per column = nearest standable floor within ±6 of the bot's feet (where could I walk down here?)
// North (-z) is up, east (+x) is right. Synchronous, ~50 ms for r=16. Read-only.
const { Vec3 } = require('vec3')
const LEGEND = "@ bot  . same level  1-9 higher by n  a-i lower by n (i = 9+ = pit/cliff)  ~ water  = ice  L lava  T tree  C chest  F furnace  # crafting table  w crop  f farmland  i torch  B bed  ^ bot-made cobble/planks  X no floor (cave mode: wall/void)  ? not loaded"
function sym (name) {
  if (name === 'water' || name === 'bubble_column') return '~'
  if (/^(ice|packed_ice|blue_ice|frosted_ice)$/.test(name)) return '='
  if (name === 'lava') return 'L'
  if (/_log$|_leaves$/.test(name)) return 'T'
  if (/chest$|^barrel$/.test(name)) return 'C'
  if (/furnace$|^smoker$/.test(name)) return 'F'
  if (name === 'crafting_table') return '#'
  if (/^(wheat|carrots|potatoes|beetroots)$/.test(name)) return 'w'
  if (name === 'farmland') return 'f'
  if (/torch$/.test(name)) return 'i'
  if (/_bed$/.test(name)) return 'B'
  return null
}
function rel (d) { return d === 0 ? '.' : d > 0 ? String(Math.min(9, d)) : 'abcdefghi'[Math.min(9, -d) - 1] }
function look (bot, r = 16, mode = 'auto') {
  r = Math.max(4, Math.min(32, r | 0))
  const me = bot.entity.position.floored()
  const feet = me.y
  const solid = b => b && b.boundingBox === 'block'
  let roofed = false
  for (let dy = 2; dy <= 30; dy++) { const b = bot.blockAt(me.offset(0, dy, 0)); if (solid(b) && !/leaves/.test(b.name)) { roofed = true; break } }
  if (mode === 'auto') mode = roofed ? 'cave' : 'surface'
  const rows = []; const things = {}
  const note = (k, x, y, z) => { (things[k] = things[k] || []).length < 6 && things[k].push([x, y, z]) }
  for (let z = me.z - r; z <= me.z + r; z++) {
    let row = ''
    for (let x = me.x - r; x <= me.x + r; x++) {
      if (x === me.x && z === me.z) { row += '@'; continue }
      let ch = '?'
      if (mode === 'surface') {
        for (let y = Math.min(feet + 24, 319); y >= feet - 24; y--) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (!b) break
          if (b.name === 'air' || b.name === 'cave_air' || b.name === 'snow' || /grass$|fern$|^dead_bush$|flower|^poppy$|^dandelion$/.test(b.name)) continue
          const s = sym(b.name)
          if (s) { ch = s; if ('CF#BL~'.includes(s) || s === 'w') note({ C: 'chest', F: 'furnace', '#': 'crafting_table', B: 'bed', L: 'lava', '~': 'water', w: 'crop' }[s], x, y, z); break }
          if (!solid(b)) continue
          ch = /^(cobblestone|.*_planks|cobblestone_wall|.*_slab|.*_stairs)$/.test(b.name) ? (y + 1 === feet ? '^' : rel(y + 1 - feet)) : rel(y + 1 - feet)
          break
        }
      } else {
        ch = 'X'
        for (const dy of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) {
          const p = new Vec3(x, feet + dy, z)
          const below = bot.blockAt(p.offset(0, -1, 0)); const a = bot.blockAt(p); const h = bot.blockAt(p.offset(0, 1, 0))
          if (!below || !a || !h) { ch = '?'; break }
          if ((a.name === 'water' || a.name === 'lava')) { ch = sym(a.name); break }
          if (solid(below) && !solid(a) && !solid(h)) { const s = sym(a.name) || sym(below.name); ch = s || rel(dy); break }
        }
      }
      row += ch
    }
    rows.push(row)
  }
  const entities = {}
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || e.position.distanceTo(bot.entity.position) > r * 1.5) continue
    if (e.type === 'player') { entities.players = (entities.players || 0) + 1; continue }
    const k = e.name || e.type
    if (k === 'item' || k === 'experience_orb') { entities.dropped_items = (entities.dropped_items || 0) + 1; continue }
    const p = e.position.floored(); (entities[k] = entities[k] || []).length < 4 && entities[k].push([p.x, p.y, p.z])
  }
  const g = bot.blockAt(me.offset(0, -1, 0)); const bi = g && g.biome && bot.registry.biomes[g.biome.id]
  return { pos: [me.x, me.y, me.z], biome: bi ? bi.name : null, standing_on: g && g.name, mode, radius: r, top_left: [me.x - r, me.z - r], rows, legend: LEGEND, things, entities }
}
module.exports = { look, LEGEND }
