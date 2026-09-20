#!/usr/bin/env node
// ops/skyshot.js <x> <z> [half=256] [out.png] — AERIAL PHOTO of the live world (owner 09-19: "それめっちゃいいじゃん、今後botへの指示に活かしてね").
// A camera account `SkyEye` logs in from localhost; the `modes` datapack makes every non-army player a spectator, this script moves it with
// rcon `tp` (a camera, never a worker: it cannot touch the world). Samples the top block of every STEP-th column in 256-block tiles and draws
// colours = block kind, brightness = height, white dots = bots, red cross = the centre. LOOK at this before choosing a base site, a build
// origin or a road — then give the bots their orders. Also used by ops/seed-look.js (throw-away server) through survey()/render().
const fs = require('fs'); const zlib = require('zlib'); const { execFileSync } = require('child_process')
const NM = '/root/workspace/bots/node_modules/'; const { Vec3 } = require(NM + 'vec3')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const COL = [[/water|kelp|seagrass/, [60, 110, 220]], [/ice/, [170, 210, 255]], [/lava/, [255, 100, 0]], [/snow/, [240, 245, 250]], [/grass_block|moss/, [110, 175, 75]], [/cherry_leaves/, [240, 160, 200]], [/jungle_leaves|bamboo|vine/, [20, 130, 30]], [/acacia_leaves/, [120, 140, 40]], [/birch_leaves/, [90, 150, 80]], [/spruce_leaves/, [35, 80, 55]], [/_leaves/, [45, 110, 45]],
  [/sand|terracotta/, [225, 210, 160]], [/dirt|podzol|coarse|mud|mycelium/, [135, 100, 65]], [/stone|andesite|diorite|granite|gravel|tuff|deepslate/, [150, 150, 150]], [/_log|_planks|_wood|hay|cobble|path/, [200, 120, 50]], [/flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily|peony|rose|lilac|petals/, [230, 120, 220]], [/grass|fern|bush/, [95, 160, 65]]]
const colour = n => { for (const [re, c] of COL) if (re.test(n)) return c; return [90, 90, 90] }
function png (w, h, rgb) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0 }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// survey(bot, tp, cx, cz, half, step) -> {n, step, x0, z0, cols:[ [name,y] | null ], biomes:{name:count}, bots:[[x,z,name]]}
async function survey (bot, tp, cx, cz, half = 256, step = 4) {
  const mcData = require(NM + 'minecraft-data')(bot.version); bot.physicsEnabled = false
  const x0 = cx - half; const z0 = cz - half; const n = Math.floor(2 * half / step); const cols = new Array(n * n).fill(null); const biomes = {}; const bots = new Map()
  for (let tz = z0 + 128; tz < cz + half + 128; tz += 256) {
    for (let tx = x0 + 128; tx < cx + half + 128; tx += 256) {
      tp(tx, 180, tz); bot.entity.position.set(tx, 180, tz)
      const t = Date.now(); const loaded = () => [[-126, -126], [126, -126], [-126, 126], [126, 126], [0, 0]].every(([a, b]) => bot.world.getColumnAt(new Vec3(tx + a, 0, tz + b)))
      while (!loaded() && Date.now() - t < 45000) { await sleep(500); bot.entity.position.set(tx, 180, tz) }
      for (let x = tx - 128; x < tx + 128; x += step) {
        for (let z = tz - 128; z < tz + 128; z += step) {
          const gx = Math.floor((x - x0) / step); const gz = Math.floor((z - z0) / step); if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue
          let top = null
          for (let y = 220; y > 40; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') { top = b; break } }
          if (!top) continue
          cols[gz * n + gx] = [top.name, top.position.y]
          const bn = (top.biome && (top.biome.name || (mcData.biomes[top.biome.id] || {}).name)) || '?'; biomes[bn] = (biomes[bn] || 0) + 1
        }
      }
      for (const e of Object.values(bot.entities)) if (e && e.type === 'player' && e.username && e.username !== bot.username) bots.set(e.username, [Math.floor(e.position.x), Math.floor(e.position.z), e.username])
      console.log('tile', tx, tz, loaded() ? 'ok' : 'PARTIAL')
    }
  }
  return { n, step, x0, z0, cols, biomes, bots: [...bots.values()] }
}
function render (M, out, marks = [], S = 2) { // marks: [[x,z,[r,g,b]]] crosses
  const { n, step, x0, z0, cols } = M; const W = n * S; const img = Buffer.alloc(W * W * 3); const ys = cols.filter(Boolean).map(c => c[1]); const lo = Math.min(...ys); const hi = Math.max(...ys)
  cols.forEach((c, i) => { const gx = i % n; const gz = Math.floor(i / n); const base = c ? colour(c[0]) : [0, 0, 0]; const k = c ? 0.6 + 0.4 * ((c[1] - lo) / Math.max(1, hi - lo)) : 1; for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) { const o = ((gz * S + b) * W + gx * S + a) * 3; img[o] = base[0] * k; img[o + 1] = base[1] * k; img[o + 2] = base[2] * k } })
  const dot = (X, Z, c) => { if (X >= 0 && Z >= 0 && X < W && Z < W) { const o = (Z * W + X) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2] } }
  const P = (x, z) => [Math.floor((x - x0) / step) * S, Math.floor((z - z0) / step) * S]
  for (let g = Math.ceil(x0 / 128) * 128; g < x0 + n * step; g += 128) { const [X] = P(g, z0); for (let Z = 0; Z < W; Z += 4) dot(X, Z, [0, 0, 0]) } // dotted grid every 128 blocks
  for (let g = Math.ceil(z0 / 128) * 128; g < z0 + n * step; g += 128) { const [, Z] = P(x0, g); for (let X = 0; X < W; X += 4) dot(X, Z, [0, 0, 0]) }
  for (const [x, z, c] of marks) { const [X, Z] = P(x, z); for (let a = -4; a <= 4; a++) { dot(X + a, Z, c); dot(X, Z + a, c) } }
  for (const [x, z] of M.bots || []) { const [X, Z] = P(x, z); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) dot(X + a, Z + b, [255, 255, 255]) }
  fs.writeFileSync(out, png(W, W, img))
  const tot = Object.values(M.biomes).reduce((a, b) => a + b, 0)
  return 'heights ' + lo + '..' + hi + '  biomes: ' + Object.entries(M.biomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + Math.round(100 * v / tot) + '%').join(', ')
}
// flatSites(M, size): slide a size x size window (stride 32) and rank BUILDABLE land: low relief (p90-p10 of ground heights), little water
// INSIDE, few trees to clear, but water within reach (any water column within 48 of the window). One line per window, best first.
function flatSites (M, size = 128, top = 8) {
  const { n, step, x0, z0, cols } = M; const w = Math.floor(size / step); const st = Math.floor(32 / step); const out = []
  const isWater = c => c && /water|kelp|seagrass|ice/.test(c[0]); const isTree = c => c && /_leaves|_log|bamboo|vine/.test(c[0])
  for (let gz = 0; gz + w <= n; gz += st) {
    for (let gx = 0; gx + w <= n; gx += st) {
      const ys = []; let water = 0; let tree = 0; let tot = 0; const kinds = {}
      for (let b = 0; b < w; b++) for (let a = 0; a < w; a++) { const c = cols[(gz + b) * n + gx + a]; if (!c) continue; tot++; if (isWater(c)) water++; else if (isTree(c)) tree++; else { ys.push(c[1]); kinds[c[0]] = (kinds[c[0]] || 0) + 1 } }
      if (tot < w * w * 0.9 || ys.length < tot * 0.4) continue
      ys.sort((p, q) => p - q); const relief = ys[Math.floor(ys.length * 0.9)] - ys[Math.floor(ys.length * 0.1)]; const level = ys[Math.floor(ys.length / 2)]
      // HOLES: p90-p10 throws a ravine away as an outlier (world 2, 09-19: "relief 4" site had a 70x12 ravine down to y41 through its centre,
      // bots fell in on the first night). Count land columns > 4 below the level, and report the deepest one.
      const holes = ys.filter(y => y < level - 4).length; const deep = ys[0]
      let near = false; const m = Math.floor(48 / step)
      for (let b = -m; b < w + m && !near; b += 2) for (let a = -m; a < w + m; a += 2) { const X = gx + a; const Z = gz + b; if (X >= 0 && Z >= 0 && X < n && Z < n && isWater(cols[Z * n + X])) { near = true; break } }
      const snow = (kinds.snow || 0) + (kinds.snow_block || 0)
      const score = 100 - relief * 6 - (water / tot) * 120 - (tree / tot) * 40 + (near ? 15 : -20) - (snow / tot) * 100 - (level > 90 ? 20 : 0) - holes * 4
      out.push({ x: x0 + gx * step + size / 2, z: z0 + gz * step + size / 2, level, relief, water: Math.round(100 * water / tot), trees: Math.round(100 * tree / tot), near, holes, deep, score: Math.round(score) })
    }
  }
  out.sort((a, b) => b.score - a.score); const pick = []
  for (const o of out) { if (pick.some(q => Math.abs(q.x - o.x) < size && Math.abs(q.z - o.z) < size)) continue; pick.push(o); if (pick.length >= top) break }
  return pick
}
// ---- STEP-1 EYES for ops/base-audit.js: fly(bot, tp, regions, onHover, opt) hovers over a 128-block lattice (cell centres, y 180) that covers `regions`
// ([x1,z1,x2,z2] boxes), waits until every chunk of the cell is loaded, snapshots the ENTITIES the server tracks there (animals are tracked 96 blocks
// horizontally: every point of a 128-cell is <= 91 from its centre, so nothing is missed) and hands onHover a READER of the loaded chunk data:
// { cell:[x1,z1,x2,z2], sid(x,y,z) -> block state id | null (not loaded), name(x,y,z), block(stateId) -> minecraft-data block }.
// Raw chunk reads (no Block objects): ~1 s per 16k columns x 60 y. Entities come back as Map id -> {name,type,username,x,y,z}. Never touches the world.
async function fly (bot, tp, regions, onHover, opt = {}) {
  const mcData = require(NM + 'minecraft-data')(bot.version); bot.physicsEnabled = false; const C = opt.cell || 128; const deadline = opt.deadline || Date.now() + 80000
  const cells = new Map(); for (const r of regions) for (let cx = Math.floor(r[0] / C); cx <= Math.floor(r[2] / C); cx++) for (let cz = Math.floor(r[1] / C); cz <= Math.floor(r[3] / C); cz++) cells.set(cx + ',' + cz, [cx, cz])
  const order = [...cells.values()].sort((a, b) => a[1] - b[1] || (a[1] % 2 ? b[0] - a[0] : a[0] - b[0])) // boustrophedon: neighbours share loaded chunks
  const ents = new Map(); const hovers = []; let col = null; let ck = null
  const sid = (x, y, z) => { const k = (x >> 4) + ',' + (z >> 4); if (k !== ck) { ck = k; col = bot.world.getColumn(x >> 4, z >> 4) } if (!col) return null; try { return col.getBlockStateId({ x: x & 15, y, z: z & 15 }) } catch { return null } }
  const block = id => mcData.blocksByStateId[id]; const name = (x, y, z) => { const id = sid(x, y, z); return id == null ? null : (block(id) || { name: 'air' }).name }
  for (const [cx, cz] of order) {
    if (Date.now() > deadline) { hovers.push({ cell: [cx * C, cz * C], ok: false, why: 'time budget' }); continue }
    const x1 = cx * C; const z1 = cz * C; const hx = x1 + C / 2; const hz = z1 + C / 2; tp(hx, 180, hz); bot.entity.position.set(hx, 180, hz); ck = null
    const loaded = () => { for (let x = x1; x < x1 + C; x += 16) for (let z = z1; z < z1 + C; z += 16) if (!bot.world.getColumn(x >> 4, z >> 4)) return false; return true }
    const t = Date.now(); while (!loaded() && Date.now() - t < (opt.loadMs || 20000)) { await sleep(250); bot.entity.position.set(hx, 180, hz) }
    await sleep(opt.settleMs || 1200); ck = null // entity spawn packets trail the chunks
    for (const e of Object.values(bot.entities)) if (e && e !== bot.entity && e.position && (e.type === 'player' || !opt.kinds || opt.kinds.test(e.name || ''))) ents.set(e.id, { name: e.name, type: e.type, username: e.username, x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) })
    const ok = loaded(); hovers.push({ cell: [x1, z1], ok, ms: Date.now() - t })
    try { await onHover({ cell: [x1, z1, x1 + C - 1, z1 + C - 1], sid, name, block, ok }) } catch (e) { hovers.push({ cell: [x1, z1], ok: false, why: 'onHover: ' + e.message }) }
  }
  return { ents, hovers }
}
// ONE SkyEye at a time (a second login would kick the first camera mid-flight): lock() -> release function, or null when another live session holds it
const LOCK = '/tmp/skyeye.lock'
function lock (who) {
  try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); let alive = true; try { process.kill(l.pid, 0) } catch { alive = false } if (alive && Date.now() - l.t < 300000 && l.pid !== process.pid) return null } catch {}
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, who, t: Date.now() })); return () => { try { if (JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK) } catch {} }
}
module.exports = { survey, render, flatSites, fly, lock, png, colour }
if (require.main === module) {
  const [x, z, half = 256, out = '/tmp/skyshot.png'] = process.argv.slice(2)
  if (x == null || z == null) { console.log('usage: node ops/skyshot.js <x> <z> [half=256] [out.png]   (dotted grid = 128 blocks; north is up; white = bots)'); process.exit(1) }
  const release = lock('skyshot'); if (!release) { console.log('another SkyEye session is flying (' + LOCK + ') - try again in a minute'); process.exit(1) } process.on('exit', release)
  const mineflayer = require(NM + 'mineflayer'); const rcon = c => { try { execFileSync('node', ['/root/workspace/bots/rcon.js', c], { timeout: 15000 }) } catch (e) { console.log('rcon failed:', e.message) } }
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'SkyEye', version: process.env.MC_VERSION || '26.1', auth: 'offline', viewDistance: 'far' })
  bot.once('kicked', r => { console.log('kicked', r); process.exit(1) }); bot.once('error', e => { console.log('error', e.message); process.exit(1) })
  bot.once('spawn', async () => {
    try {
      await sleep(2500); if (bot.game.gameMode !== 'spectator') { console.log('SkyEye is not a spectator (datapack modes missing?) - refusing to fly'); bot.quit(); process.exit(1) }
      const M = await survey(bot, (a, b, c) => rcon('tp SkyEye ' + a + ' ' + b + ' ' + c), +x, +z, +half)
      console.log(render(M, out, [[+x, +z, [255, 0, 0]]])); console.log('bots in view:', M.bots.map(b => b[2] + '@' + b[0] + ',' + b[1]).join(' ') || '-'); for (const o of flatSites(M, 128)) console.log('flat 128x128 centre', (o.x + ',' + o.z).padEnd(11), 'level y' + o.level, 'relief', o.relief, 'water', o.water + '%', 'trees', o.trees + '%', 'holes', o.holes + (o.holes ? ' (down to y' + o.deep + ')' : ''), o.near ? 'water<=48' : 'NO water near', 'score', o.score)
      fs.writeFileSync(out.replace(/\.png$/, '') + '.json', JSON.stringify(M)); console.log('png', out, ' 1 px =', M.step / 2, 'blocks; x', M.x0, '..', M.x0 + M.n * M.step, ' z', M.z0, '..', M.z0 + M.n * M.step)
    } catch (e) { console.log('failed:', e.message) }
    bot.quit(); setTimeout(() => process.exit(0), 500)
  })
}
