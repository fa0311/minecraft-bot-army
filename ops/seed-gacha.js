#!/usr/bin/env node
// ops/seed-gacha.js [n=6] — try n random seeds on a throw-away server (server-gacha/, ports 25599/25598) and score the land around each world
// spawn for a SANDBOX SURVIVAL game: temperate spawn, liquid water, a village, many climates within reach, snow far away. Uses only `locate`
// (biome source, no chunk generation) — this is world SELECTION, not play. Results: server-gacha/results.json (best first).
const { spawn } = require('child_process'); const fs = require('fs'); const net = require('net'); const path = require('path')
const G = '/root/workspace/server-gacha'; const N = +(process.argv[2] || 6)
const pw = fs.readFileSync('/root/workspace/server/.rcon_pw', 'utf8').trim()
const sleep = ms => new Promise(r => setTimeout(r, ms))
function rcon (cmd) {
  return new Promise((resolve) => {
    const s = net.connect(25598, '127.0.0.1'); let acc = Buffer.alloc(0); let authed = false; const t = setTimeout(() => { s.destroy(); resolve('') }, 60000)
    const pkt = (id, type, body) => { const b = Buffer.from(body, 'utf8'); const buf = Buffer.alloc(14 + b.length); buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12); return buf }
    s.on('connect', () => s.write(pkt(1, 3, pw)))
    s.on('data', d => { acc = Buffer.concat([acc, d]); while (acc.length >= 4 && acc.length >= acc.readInt32LE(0) + 4) { const len = acc.readInt32LE(0); const body = acc.slice(12, len + 2).toString('utf8'); acc = acc.slice(len + 4); if (!authed) { authed = true; s.write(pkt(2, 2, cmd)) } else { clearTimeout(t); s.end(); resolve(body) } } })
    s.on('error', () => { clearTimeout(t); resolve('') })
  })
}
const BIOMES = ['plains', 'forest', 'birch_forest', 'river', 'swamp', 'desert', 'savanna', 'jungle', 'dark_forest', 'meadow', 'cherry_grove', 'flower_forest', 'taiga', 'snowy_plains', 'snowy_taiga', 'ocean', 'warm_ocean', 'beach', 'badlands', 'mushroom_fields']
const STRUCTS = ['#minecraft:village', 'minecraft:ruined_portal', 'minecraft:mineshaft', 'minecraft:stronghold', 'minecraft:pillager_outpost', 'minecraft:ancient_city']
const dist = out => { const m = String(out).match(/\((\d+) blocks? away\)/); return m ? +m[1] : null }
async function tryOne (seed) {
  for (const d of ['world', 'world_nether', 'world_the_end', 'logs']) fs.rmSync(path.join(G, d), { recursive: true, force: true })
  let props = fs.readFileSync(path.join(G, 'server.properties'), 'utf8').replace(/^level-seed=.*$/m, 'level-seed=' + seed); fs.writeFileSync(path.join(G, 'server.properties'), props)
  const p = spawn('java', ['-Xms1G', '-Xmx3G', '-jar', 'paper.jar', '--nogui'], { cwd: G, stdio: ['pipe', 'pipe', 'pipe'] })
  let log = ''; p.stdout.on('data', d => { log += d })
  const t0 = Date.now(); while (!/Done \(/.test(log) && Date.now() - t0 < 240000) await sleep(1000)
  const r = { seed: String(seed), bootS: Math.round((Date.now() - t0) / 1000), biomes: {}, structs: {} }
  if (/Done \(/.test(log)) {
    let sx = 0; let sy = 64; let sz = 0
    await rcon('save-all flush'); await sleep(1500) // level.dat (with the spawn point) exists only after the first save
    try { const nbt = require('/root/workspace/bots/node_modules/prismarine-nbt'); const { parsed } = await nbt.parse(fs.readFileSync(path.join(G, 'world', 'level.dat'))); const d = nbt.simplify(parsed).Data; const sp = d.spawn ? d.spawn.pos : [d.SpawnX, d.SpawnY, d.SpawnZ]; r.spawn = sp; sx = sp[0]; sy = sp[1]; sz = sp[2] } catch (e) { r.spawnErr = String(e.message) }
    const at = 'execute in minecraft:overworld positioned ' + sx + ' ' + sy + ' ' + sz + ' run '
    for (const b of BIOMES) r.biomes[b] = dist(await rcon(at + 'locate biome minecraft:' + b))
    for (const st of STRUCTS) r.structs[st.replace(/^#?minecraft:/, '')] = dist(await rcon(at + 'locate structure ' + st))
  } else r.error = 'server did not start'
  try { p.stdin.write('stop\n') } catch {}
  const t1 = Date.now(); while (p.exitCode == null && Date.now() - t1 < 60000) await sleep(500); if (p.exitCode == null) p.kill('SIGKILL')
  const B = r.biomes; const near = (k, d) => B[k] != null && B[k] <= d
  let s = 0
  if (near('plains', 150) || near('forest', 150) || near('birch_forest', 150) || near('meadow', 150) || near('flower_forest', 150)) s += 30 // temperate at spawn
  if (near('river', 300)) s += 15
  if (r.structs.village != null && r.structs.village <= 700) s += 20
  for (const k of ['desert', 'savanna', 'jungle', 'swamp', 'dark_forest', 'cherry_grove', 'badlands', 'taiga', 'warm_ocean', 'mushroom_fields']) if (near(k, 1500)) s += 5 // climates within a long walk
  if (near('ocean', 150)) s -= 10 // spawn on the coast is fine, spawn IN the ocean is not
  for (const k of ['snowy_plains', 'snowy_taiga']) if (near(k, 400)) s -= 20 // the last world: frozen water, no animals, no sugar cane for 700 blocks
  if (r.structs.stronghold != null && r.structs.stronghold <= 2500) s += 5
  r.score = s
  return r
}
;(async () => {
  const out = []
  for (let i = 0; i < N; i++) { const seed = (BigInt(Math.floor(Math.random() * 2 ** 31)) * 4294967296n + BigInt(Math.floor(Math.random() * 2 ** 32))) - 9223372036854775808n / 2n; const r = await tryOne(seed); out.push(r); out.sort((a, b) => (b.score || -99) - (a.score || -99)); fs.writeFileSync(path.join(G, 'results.json'), JSON.stringify(out, null, 1)); console.log('seed', r.seed, 'score', r.score, 'spawn', JSON.stringify(r.spawn), 'village', r.structs.village, 'river', r.biomes.river, 'plains', r.biomes.plains, 'forest', r.biomes.forest, 'snowy', r.biomes.snowy_plains, r.biomes.snowy_taiga, 'desert', r.biomes.desert, 'jungle', r.biomes.jungle, 'savanna', r.biomes.savanna, 'boot', r.bootS + 's') }
})()
