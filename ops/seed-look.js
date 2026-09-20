#!/usr/bin/env node
// ops/seed-look.js <seed> [out.png] — LOOK at a seed before choosing it (world 1 was chosen blind: snow for 700 blocks).
// Boots the throw-away server in server-gacha (ports 25599/25598, cheats are fine THERE), one spectator bot hops over a 3x3 grid around the
// world spawn and samples the top block of every 4th column -> a ~770x770-block PNG (1 px = 4 blocks... drawn 2x) + a biome tally on stdout.
const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path')
const G = '/root/workspace/server-gacha'; const NM = '/root/workspace/bots/node_modules/'
const mineflayer = require(NM + 'mineflayer'); const nbt = require(NM + 'prismarine-nbt')
const [seed, out = '/root/workspace/server-gacha/look.png'] = process.argv.slice(2)
if (!seed) { console.log('usage: seed-look.js <seed> [out.png]'); process.exit(1) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
let P = null; const rcon = cmd => { try { P.stdin.write(cmd + '\n') } catch {} } // console commands through the server's stdin: no output needed
const { survey, render } = require('./skyshot.js')
;(async () => {
  for (const d of ['world', 'world_nether', 'world_the_end', 'logs']) fs.rmSync(path.join(G, d), { recursive: true, force: true })
  fs.writeFileSync(path.join(G, 'server.properties'), fs.readFileSync(path.join(G, 'server.properties'), 'utf8').replace(/^level-seed=.*$/m, 'level-seed=' + seed).replace(/^view-distance=.*$/m, 'view-distance=12'))
  fs.mkdirSync(path.join(G, 'plugins'), { recursive: true }); for (const j of ['ViaVersion.jar', 'ViaBackwards.jar']) fs.copyFileSync(path.join(G, 'plugins.off', j), path.join(G, 'plugins', j))
  const p = P = spawn('java', ['-Xms1G', '-Xmx4G', '-jar', 'paper.jar', '--nogui'], { cwd: G, stdio: ['pipe', 'pipe', 'pipe'] }); let log = ''; p.stdout.on('data', d => { log += d })
  const stop = async () => { try { p.stdin.write('stop\n') } catch {} const t = Date.now(); while (p.exitCode == null && Date.now() - t < 60000) await sleep(500); if (p.exitCode == null) p.kill('SIGKILL'); for (const j of ['ViaVersion.jar', 'ViaBackwards.jar']) fs.rmSync(path.join(G, 'plugins', j), { force: true }) }
  const t0 = Date.now(); while (!/Done \(/.test(log) && Date.now() - t0 < 240000) await sleep(1000)
  if (!/Done \(/.test(log)) { console.log('server did not start'); await stop(); process.exit(1) }
  rcon('save-all flush'); await sleep(1500)
  const d = nbt.simplify((await nbt.parse(fs.readFileSync(path.join(G, 'world', 'level.dat')))).parsed).Data; const sp = d.spawn ? d.spawn.pos : [d.SpawnX, d.SpawnY, d.SpawnZ]
  console.log('seed', seed, 'spawn', JSON.stringify(sp))
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25599, username: 'Looker', version: '26.1', auth: 'offline', viewDistance: 'far' })
  await new Promise((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject); bot.once('kicked', r => reject(new Error('kicked ' + r))); setTimeout(() => reject(new Error('join timeout')), 60000) })
  rcon('gamemode spectator Looker'); await sleep(1000)
  const M = await survey(bot, (x, y, z) => rcon('tp Looker ' + x + ' ' + y + ' ' + z), sp[0], sp[2], 384)
  console.log(render(M, out, [[sp[0], sp[2], [255, 0, 0]]])); console.log('png', out, '(red cross = world spawn, north is up, 1 px = 2 blocks, dotted grid = 128 blocks)')
  bot.quit(); await sleep(500); await stop(); process.exit(0)
})().catch(async e => { console.log('failed:', e.message); try { P.stdin.write('stop\n'); await sleep(15000); P.kill('SIGKILL') } catch {} process.exit(1) })
