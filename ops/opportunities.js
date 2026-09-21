#!/usr/bin/env node
// ops/opportunities.js [regex] — WHAT THIS VERSION LETS US MAKE THAT WE ARE NOT MAKING (owner 09-21: 「wiki全部読んだらw」, after copper armour sat
// unnoticed while 4 707 raw copper slept in the depot and the army fought over 9 iron). LLM-free: it reads the SERVER'S OWN registry through a live
// bot (every item, every recipe of the running version - no wiki, no memory, no guesswork), joins it with the depot + carried stock and the board's
// targets, and prints what we could craft RIGHT NOW, what one smelt away, and which useful families we hold ZERO of.
const fs = require('fs'); const http = require('http')
const WS = '/root/workspace'
const post = (p, body) => new Promise((resolve, reject) => { const d = JSON.stringify(body); const q = http.request({ host: '127.0.0.1', port: 3000, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, r => { let s = ''; r.on('data', c => { s += c }); r.on('end', () => resolve(s)) }); q.on('error', reject); q.write(d); q.end() })

const CODE = `
const R = bot.registry
const out = { items: Object.keys(R.itemsByName || {}), recipes: {} }
for (const name of out.items) {
  const it = R.itemsByName[name]; const rs = (R.recipes || {})[it.id]; if (!rs || !rs.length) continue
  const r = rs[0]; const need = {}
  const add = id => { if (id == null || id < 0) return; const n = (R.items[id] || {}).name; if (n) need[n] = (need[n] || 0) + 1 }
  if (r.inShape) for (const row of r.inShape) for (const c of row) add(c && c.id != null ? c.id : c)
  else if (r.ingredients) for (const c of r.ingredients) add(c && c.id != null ? c.id : c)
  out.recipes[name] = { need, count: (r.result && r.result.count) || 1 }
}
return JSON.stringify(out)
`

// what is worth noticing: gear, the dragon chain, logistics, farms - not every block variant
const USEFUL = /^(copper|iron|diamond|netherite|golden|chainmail)_(helmet|chestplate|leggings|boots|sword|pickaxe|axe|shovel|hoe)$|^(shield|bucket|shears|flint_and_steel|anvil|cauldron|brewing_stand|blaze_powder|eye_of_ender|ender_chest|hopper|minecart|rail|powered_rail|activator_rail|detector_rail|lead|name_tag|saddle|crossbow|bow|arrow|spectral_arrow|tipped_arrow|enchanting_table|bookshelf|lectern|loom|smithing_table|blast_furnace|smoker|grindstone|stonecutter|composter|beacon|conduit|respawn_anchor|lodestone|target|bell|campfire|lantern|soul_lantern|chain|scaffolding|water_bucket|glass|glass_bottle|potion|boat|.*_boat|.*_bed|.*_banner|copper_golem_statue|copper_chest|copper_torch|copper_lantern|copper_bars|copper_door)$/

;(async () => {
  const bots = JSON.parse(await post('/bots', {}).catch(() => '[]') || '[]')
  const who = Array.isArray(bots) && bots.length ? (bots[0].name || bots[0].username || bots[0]) : 'all'
  const res = JSON.parse(await post('/cmd', { bots: who, action: 'eval', args: { code: CODE, timeout: 20000 } }) || '[]')[0]
  if (!res || !res.ok) { console.log('probe failed:', res && res.error); process.exit(1) }
  const R = JSON.parse(res.result)

  // stock: depot index + what the bots carry
  const stock = {}
  try { const ix = JSON.parse(fs.readFileSync(WS + '/bots/army/chests.json', 'utf8')); const idx = ix.chests || ix
    for (const k in idx) for (const n in (idx[k].items || {})) stock[n] = (stock[n] || 0) + idx[k].items[n] } catch {}
  try { for (const f of fs.readdirSync(WS + '/bots/army/hb')) { const h = JSON.parse(fs.readFileSync(WS + '/bots/army/hb/' + f, 'utf8')); for (const n in (h.inv || {})) stock[n] = (stock[n] || 0) + h.inv[n] } } catch {}
  const targets = (() => { try { return (JSON.parse(fs.readFileSync(WS + '/bots/army/jobs.json', 'utf8')).settings || {}).targets || {} } catch { return {} } })()

  const filter = process.argv[2] ? new RegExp(process.argv[2]) : null
  const have = n => stock[n] || 0
  const rows = []
  for (const name of Object.keys(R.recipes)) {
    if (filter ? !filter.test(name) : !USEFUL.test(name)) continue
    const { need } = R.recipes[name]
    let can = Infinity; const miss = []
    for (const n in need) { const k = Math.floor(have(n) / need[n]); if (k < can) can = k; if (have(n) < need[n]) miss.push(n + ' ' + have(n) + '/' + need[n]) }
    if (can === Infinity) can = 0
    rows.push({ name, held: have(name), can, miss, target: targets[name] || 0, need })
  }
  const pad = (s, n) => String(s).padEnd(n)
  console.log('WHAT WE COULD MAKE AND ARE NOT MAKING (registry of the running server, ' + Object.keys(R.items || {}).length + ' items; stock = depot + carried)')
  console.log(pad('item', 24) + pad('held', 6) + pad('target', 7) + pad('craftable now', 14) + 'missing')
  for (const r of rows.filter(r => r.can > 0 && r.held < Math.max(1, r.target)).sort((a, b) => b.can - a.can).slice(0, 25)) console.log('  ' + pad(r.name, 24) + pad(r.held, 6) + pad(r.target || '-', 7) + pad(r.can, 14) + Object.entries(r.need).map(([k, v]) => k + 'x' + v).join(' '))
  console.log('\nHELD ZERO AND BLOCKED (what stands between us and it):')
  for (const r of rows.filter(r => r.held === 0 && r.can === 0).sort((a, b) => a.miss.length - b.miss.length).slice(0, 20)) console.log('  ' + pad(r.name, 24) + 'missing ' + r.miss.join(', '))
  process.exit(0)
})().catch(e => { console.log('failed:', e.message); process.exit(1) })
