#!/usr/bin/env node
// mapshot.js — render a top-down PNG through a bot's eyes:  node bots/army/mapshot.js <bot> [radius=48] [out.png] [scale=6]
// colours = block kind, brightness = height, RED outline = floating block (2+ air under the top block), white dots = bots, magenta = mobs,
// yellow = torches, grid line every 16 blocks with coordinates on the edge. Pure JS PNG (no native deps).
const http = require('http'); const zlib = require('zlib'); const fs = require('fs')
const [bot, R = 48, out = '/tmp/mapshot.png', S = 6] = process.argv.slice(2)
const post = (p, body) => new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: 3000, path: p, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 60000 }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)) }); q.on('error', reject); q.end(JSON.stringify(body)) })
const COL = [[/water/, [60, 110, 220]], [/^(ice|packed_ice|blue_ice)$/, [170, 210, 255]], [/lava/, [255, 100, 0]], [/snow/, [240, 245, 250]], [/grass_block|moss/, [95, 160, 70]], [/short_grass|fern|tall_grass|flower|bush$/, [80, 145, 60]],
  [/sweet_berry/, [170, 40, 90]], [/_leaves/, [40, 100, 45]], [/_log|_wood/, [110, 80, 45]], [/farmland/, [120, 85, 50]], [/wheat|carrots|potatoes|beetroots/, [215, 190, 70]], [/dirt|podzol|coarse/, [135, 100, 65]],
  [/cobblestone|stone_brick/, [125, 125, 125]], [/^(stone|andesite|diorite|granite|deepslate|tuff|gravel|cobbled_deepslate|calcite|smooth_stone|.*_bricks|polished_.*)$/, [150, 150, 150]], [/_planks|_slab|_stairs|barrel|chest|crafting_table|_fence/, [190, 150, 90]], [/furnace|smoker/, [80, 80, 80]],
  [/torch|lantern|campfire/, [255, 230, 60]], [/_bed$/, [200, 40, 40]], [/sand/, [225, 215, 165]], [/_ore$/, [90, 200, 200]]]
const colour = n => { for (const [re, c] of COL) if (re.test(n)) return c; return [105, 95, 85] } // unknown block: dull brown-grey, NOT the mobs' magenta (09-20: a deepslate-paved road looked like a swarm)
function png (w, h, rgb) { // minimal PNG encoder (8-bit RGB)
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0 }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}
(async () => {
  const code = 'const f="/root/workspace/bots/skills/lib/mapshot.js";delete require.cache[f];return require(f).columns(bot,' + (+R) + ')'
  const res = JSON.parse(await post('/cmd', { bots: [bot], action: 'eval', args: { code, timeout: 50000 } }))[0]
  if (!res || !res.ok) { console.log('mapshot failed:', res && res.error); process.exit(1) }
  const M = res.result; const n = 2 * M.r + 1; const s = +S; const W = n * s; const img = Buffer.alloc(W * W * 3)
  const px = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= W) return; const i = (y * W + x) * 3; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2] }
  const ys = M.cols.filter(Boolean).map(c => c[1]); const lo = Math.min(...ys); const hi = Math.max(...ys)
  M.cols.forEach((c, i) => {
    const gx = i % n; const gz = Math.floor(i / n); const base = c ? colour(c[0]) : [0, 0, 0]
    const k = c ? 0.55 + 0.45 * ((c[1] - lo) / Math.max(1, hi - lo)) : 1
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) { const edge = c && c[2] && (dx === 0 || dy === 0 || dx === s - 1 || dy === s - 1); px(gx * s + dx, gz * s + dy, edge ? [255, 0, 0] : base.map(v => Math.round(v * k))) }
    // height step to the east/south neighbour >= 2 -> dark line (cliffs, pits, pillars show up as boxes)
    const e = M.cols[i + 1]; const so = M.cols[i + n]
    if (c && e && gx < n - 1 && Math.abs(e[1] - c[1]) >= 2) for (let dy = 0; dy < s; dy++) px(gx * s + s - 1, gz * s + dy, [20, 20, 20])
    if (c && so && Math.abs(so[1] - c[1]) >= 2) for (let dx = 0; dx < s; dx++) px(gx * s + dx, gz * s + s - 1, [20, 20, 20])
  })
  for (let g = 0; g < n; g++) { const wx = M.cx - M.r + g; const wz = M.cz - M.r + g; if (wx % 16 === 0) for (let y = 0; y < W; y += 2) px(g * s, y, [255, 255, 255]); if (wz % 16 === 0) for (let x = 0; x < W; x += 2) px(x, g * s, [255, 255, 255]) }
  for (const [name, ex, ez] of M.ents) { const gx = (ex - (M.cx - M.r)) * s; const gz = (ez - (M.cz - M.r)) * s; const c = name.startsWith('P:') ? [255, 255, 255] : /item|orb|arrow/.test(name) ? null : [255, 0, 255]; if (c) for (let dy = -1; dy <= s; dy++) for (let dx = -1; dx <= s; dx++) px(gx + dx, gz + dy, (dx === -1 || dy === -1 || dx === s || dy === s) ? [0, 0, 0] : c) }
  fs.writeFileSync(out, png(W, W, img))
  const grid = []; for (let g = 0; g < n; g++) { const wx = M.cx - M.r + g; if (wx % 16 === 0) grid.push('x=' + wx + '@px' + g * s) }
  console.log(out + '  ' + W + 'x' + W + 'px, ' + s + ' px/block, centre ' + M.cx + ',' + M.cy + ',' + M.cz + ', x ' + (M.cx - M.r) + '..' + (M.cx + M.r) + ' left→right, z ' + (M.cz - M.r) + '..' + (M.cz + M.r) + ' top→bottom, heights y ' + lo + '..' + hi + ' (brighter = higher)')
  console.log('white dashed lines every 16 blocks: ' + grid.join(' ') + ' (same spacing for z). RED box = floating block, dark lines = height steps >= 2, white squares = bots, magenta = mobs, yellow = torches, purple = berry bushes, tan = wood/barrels/chests')
})()
