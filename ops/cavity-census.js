#!/usr/bin/env node
// ops/cavity-census.js [--box x1,z1,x2,z2] [--ymin 30] [--ytop N] [--cells 400] [--depth 8] [--tunnel 3] [--dig] [--quiet] — THE CAVITY CENSUS, full coverage, LLM-free, ~2 min.
// WHY (owner 09-20): "地下にbotが誤って掘った穴が多すぎます、敵mobが変な位置に湧く原因になります" and "地下から緊急脱出を試みる際に作った階段を埋めないのは何故か？".
// ops/base-audit.js looks from ABOVE: a sealed pocket under a finished pad and a 1x2 escape staircase are both invisible to it. A bot only sees its
// own loaded chunks, so the JOB's survey (`cavity` work:'survey') covers what one bot can see; this flies the spectator camera `SkyEye` over the base
// box on the same 128-block lattice ops/base-audit.js uses and reads EVERY column from y `ymin` to `ytop` — full coverage, no world edit at all.
// The classification, the file and the table are ONE implementation with the job: bots/skills/lib/jobs_cavity.js (`module.exports.census`).
// Output: bots/army/cavities.json (atomic), one `cavity_census` line in the army ledger, a table on stdout sorted by spawnable floor cells.
const fs = require('fs')
const W = '/root/workspace'; const NM = W + '/bots/node_modules/'
const SKY = require(W + '/ops/skyshot.js')
const A = require(W + '/bots/skills/lib/army.js')
const CAV = require(W + '/bots/skills/lib/jobs_cavity.js').census
const { execFileSync } = require('child_process')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const opt = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const has = k => process.argv.includes(k)

const box = opt('--box') ? opt('--box').split(',').map(Number) : CAV.baseBox(A)
const yMin = +(opt('--ymin') || 30)
const yTop = +(opt('--ytop') || CAV.baseY(A) + 52)
const maxCells = +(opt('--cells') || 400)
const maxDepth = +(opt('--depth') || 8)
const tunnelMax = +(opt('--tunnel') || 3) // how far a sideways tunnel may reach from a free column (jobs_cavity entryOf; the job's params.tunnelMax)
const dig = process.argv.includes('--dig') // the box IS an excavation of ours (a ravine the army is filling): no depth or size cap
if (box.length !== 4 || box.some(n => !Number.isFinite(n))) { console.log('usage: node ops/cavity-census.js [--box x1,z1,x2,z2] [--ymin 30] [--ytop 120] [--cells 400] [--depth 8] [--dig]'); process.exit(1) }

const release = SKY.lock('cavity-census')
if (!release) { console.log('another SkyEye session is flying (base-audit / skyshot) - try again in a minute'); process.exit(2) }
process.on('exit', release)

const mineflayer = require(NM + 'mineflayer')
const rcon = c => { try { execFileSync('node', [W + '/bots/rcon.js', c], { timeout: 15000 }) } catch (e) { console.log('rcon failed:', e.message) } }
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'SkyEye', version: process.env.MC_VERSION || '26.1', auth: 'offline', viewDistance: 'far' })
bot.once('kicked', r => { console.log('kicked', r); process.exit(1) })
bot.once('error', e => { console.log('error', e.message); process.exit(1) })
bot.once('spawn', async () => {
  const t0 = Date.now()
  try {
    await sleep(2500)
    if (bot.game.gameMode !== 'spectator') { console.log('SkyEye is not a spectator (datapack modes missing?) - refusing to fly'); bot.quit(); process.exit(1) }
    const mcData = require(NM + 'minecraft-data')(bot.version)
    const G = CAV.newGrid(box, yMin, yTop)
    const cd = CAV.coder(mcData)
    console.log('cavity census: x ' + G.box[0] + '..' + G.box[2] + ' / z ' + G.box[1] + '..' + G.box[3] + '  y ' + yMin + '..' + yTop + '  (' + (G.W * G.D) + ' columns x ' + G.H + ' cells)')
    const flown = await SKY.fly(bot, (a, b, c) => rcon('tp SkyEye ' + a + ' ' + b + ' ' + c), [G.box], async h => {
      if (!h.ok) return
      const n = CAV.readInto(G, h.cell, h.sid, cd)
      if (!has('--quiet')) console.log('  read ' + h.cell.join(',') + '  ' + n + ' columns   (' + Math.round(100 * G.cols / (G.W * G.D)) + ' % of the box)')
    }, { cell: 128, deadline: Date.now() + 600000, loadMs: 30000, settleMs: 400 })
    const bad = flown.hovers.filter(h => !h.ok)
    if (bad.length) console.log('  ' + bad.length + ' lattice cell(s) never loaded: ' + bad.slice(0, 4).map(h => h.cell.join(',') + ' ' + (h.why || '')).join(' | '))
    const PS = CAV.planSets(A, G.box, true)
    CAV.markPlan(G, PS)
    console.log('plan: ' + PS.planned.size + ' blueprint cells, ' + PS.mine.size + ' mine cells, ' + PS.blockedCols.size + ' columns where no shaft may be opened, ' + PS.scars.size + ' escape-scar cells from the ledger')
    const list = CAV.analyse(G, { maxCells, maxDepth, dig, tunnelMax, hardCap: dig ? 60000 : 20000, blockedCol: PS.blockedCol })
    const doc = CAV.writeCensus(A, G, list, 'SkyEye')
    console.log('')
    console.log(CAV.table(doc))
    console.log('')
    const worst = doc.list.filter(CAV.isTarget).slice(0, 5).map(e => ({ at: e.at, cells: e.cells, depth: e.depth }))
    const cells = doc.list.filter(CAV.isTarget).reduce((n, e) => n + e.cells, 0)
    fs.appendFileSync(A.F.results, JSON.stringify({ t: Date.now(), bot: 'SkyEye', ev: 'cavity_census', n: doc.targets, cells, spawnable: doc.spawnable, coverage: doc.coverage, counts: doc.counts, worst, ms: Date.now() - t0 }) + '\n')
    console.log('TARGETS ' + doc.targets + ' (' + doc.spawnable + ' dark spawnable floor cells, ' + cells + ' cells to fill)   ' + JSON.stringify(doc.counts))
    console.log('coverage ' + doc.coverage + ' % of the base box   ->  ' + CAV.CAV_F + '   (' + Math.round((Date.now() - t0) / 1000) + ' s)')
    console.log('fix them: one `cavity` job on the board (bots = min(targets, 12)); each bot claims one, events cavity_filled / cavity_failed')
  } catch (e) { console.log('failed:', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e) }
  bot.quit(); setTimeout(() => process.exit(0), 500)
})
