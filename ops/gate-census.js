#!/usr/bin/env node
// ops/gate-census.js [--dim=the_nether] [x z] [r=96] — WHAT PORTAL FRAMES REALLY STAND (owner 09-21: 「ネザー側、壊れたポータルが3つもあるの把握してる？」 —
// the board's `settings.nether.gates` was written by a bot hours earlier and knew of ONE frame per dimension). LLM-free: the spectator camera
// `SkyEye` is tped into the dimension (rcon `execute in`), reads every obsidian / nether_portal block within r, clusters them into frames and
// prints one line per frame: obsidian, lit portal cells, box, and whether it is WHOLE (>= 10 obsidian + 6 cells), DEAD (no cells) or BROKEN.
// The result is written back to `settings.nether.gates` through the board's own lock, so operators and jobs see the truth.
const fs = require('fs'); const { execFileSync } = require('child_process')
const NM = '/root/workspace/bots/node_modules/'
const mineflayer = require(NM + 'mineflayer'); const { Vec3 } = require(NM + 'vec3')
const { lock } = require('./skyshot.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rcon = c => { try { execFileSync('node', ['/root/workspace/bots/rcon.js', c], { timeout: 15000 }) } catch (e) { console.log('rcon failed:', e.message) } }

const argv = process.argv.slice(2).filter(a => !/^--/.test(a))
const DIM = (process.argv.find(a => /^--dim=/.test(a)) || '').split('=')[1] || 'the_nether'
const [X, Z, R = 96] = argv
if (X == null || Z == null) { console.log('usage: node ops/gate-census.js <x> <z> [r=96] [--dim=the_nether|overworld]'); process.exit(1) }

function clusters (blocks, world) { // ONE FRAME = obsidian/portal cells that TOUCH each other (6-neighbour flood fill). A 6-block box merged
  // three frames into one 47-obsidian blob and hid exactly what the owner saw (09-21: three broken portals on the Nether side).
  const key = p => p.x + ',' + p.y + ',' + p.z
  const set = new Map(); for (const p of blocks) { const b = world(p); if (b) set.set(key(p), { p, b }) }
  const seen = new Set(); const out = []
  for (const [k, v] of set) {
    if (seen.has(k)) continue
    const stack = [v]; seen.add(k); const c = { min: v.p.clone(), max: v.p.clone(), obsidian: 0, cells: 0 }
    while (stack.length) {
      const cur = stack.pop()
      if (cur.b.name === 'nether_portal') c.cells++; else c.obsidian++
      c.min = new Vec3(Math.min(c.min.x, cur.p.x), Math.min(c.min.y, cur.p.y), Math.min(c.min.z, cur.p.z))
      c.max = new Vec3(Math.max(c.max.x, cur.p.x), Math.max(c.max.y, cur.p.y), Math.max(c.max.z, cur.p.z))
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nk = (cur.p.x + d[0]) + ',' + (cur.p.y + d[1]) + ',' + (cur.p.z + d[2])
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(set.get(nk)) }
      }
    }
    out.push(c)
  }
  return out.sort((a, b) => (b.obsidian + b.cells) - (a.obsidian + a.cells))
}

;(async () => {
  const release = lock('gate-census'); if (!release) { console.log('another SkyEye session is flying - try again in a minute'); process.exit(1) }
  process.on('exit', release)
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'SkyEye', version: process.env.MC_VERSION || '26.1', auth: 'offline', viewDistance: 'far' })
  bot.once('kicked', r => { console.log('kicked', r); process.exit(1) }); bot.once('error', e => { console.log('error', e.message); process.exit(1) })
  bot.once('spawn', async () => {
    try {
      await sleep(2500)
      const where = /overworld/.test(DIM) ? 'tp SkyEye ' : 'execute in minecraft:' + DIM + ' run tp SkyEye '
      rcon(where + X + ' 100 ' + Z); await sleep(3500); bot.entity.position.set(+X, 100, +Z); await sleep(3500)
      const found = bot.findBlocks({ matching: b => b && /^(obsidian|nether_portal)$/.test(b.name), maxDistance: +R, count: 600 })
      const cs = clusters(found, p => bot.blockAt(p))
      console.log(DIM, 'around', X + ',' + Z, 'r' + R + ':', cs.length, 'frame(s),', found.length, 'blocks')
      const rows = cs.map(c => {
        const state = c.cells >= 6 && c.obsidian >= 10 ? 'WHOLE (lit)' : c.cells > 0 ? 'BROKEN (lit but frame ' + c.obsidian + '/10)' : c.obsidian >= 10 ? 'DARK (frame stands, no fire)' : 'DEAD (' + c.obsidian + ' obsidian, no cells)'
        console.log('  ', state.padEnd(30), 'obsidian', String(c.obsidian).padStart(3), 'cells', String(c.cells).padStart(2), ' box', [c.min.x, c.min.y, c.min.z].join(',') + ' .. ' + [c.max.x, c.max.y, c.max.z].join(','))
        return { dim: DIM, at: [c.min.x, c.min.y, c.min.z], box: [[c.min.x, c.min.y, c.min.z], [c.max.x, c.max.y, c.max.z]], frame: c.obsidian, lit: c.cells > 0, cells: c.cells, state: state.split(' ')[0] }
      })
      const B = '/root/workspace/bots/army/jobs.json'; const board = JSON.parse(fs.readFileSync(B, 'utf8'))
      board.settings.nether = board.settings.nether || {}
      const keep = (board.settings.nether.gates || []).filter(g => g.dim !== DIM)
      board.settings.nether.gates = keep.concat(rows); board.settings.nether.gatesAt = Date.now()
      fs.writeFileSync(B + '.tmp', JSON.stringify(board, null, 1)); fs.renameSync(B + '.tmp', B)
      console.log('written to settings.nether.gates (' + rows.length + ' in ' + DIM + ', ' + keep.length + ' kept elsewhere)')
    } catch (e) { console.log('failed:', e.message) }
    bot.quit(); setTimeout(() => process.exit(0), 500)
  })
})()
