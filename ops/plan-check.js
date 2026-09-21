#!/usr/bin/env node
// ops/plan-check.js — READ-ONLY report of the compiled base plan (bots/army/plan.js). It changes NOTHING: no board write, no
// world edit, no daemon. Run it before touching a build job, and after every `plan-base`, `put`, `patch` or road design.
//
// WHY (owner 09-21 「lockみたいな仕組みがないの？目標のブロックが決まってないわけ？差分管理というか」): two jobs with DIFFERENT targets for
// one cell dug and placed the same block for 20 hours (`build_runaway`). A lock cannot decide which target is right; a compiler
// can. This prints what the compiler decided, so a human sees the resolution BEFORE 50 bots act on it.
//
//   node ops/plan-check.js                      overlaps, plan errors, jobs with nothing left, per-zone totals
//   node ops/plan-check.js --all                every overlap (finished and chained pairs too), not just the live war
//   node ops/plan-check.js --job <id>           everything about one job: what it owns, what it lost, to whom
//   node ops/plan-check.js --at x,y,z           who owns this cell and what is supposed to stand in it
//   node ops/plan-check.js --diff [--box x1,z1,x2,z2]   fly the SkyEye camera and print the WORLD-vs-PLAN diff per zone (~60 s)
//   node ops/plan-check.js --json               the same as one JSON object
// Flags: --no-archive (board only) · --box x1,z1,x2,z2 (limit the compile) · --top <n>
const path = require('path'); const W = path.join(__dirname, '..')
const PLAN = require(path.join(W, 'bots/army/plan.js'))
const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const opt = n => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1] }
const nums = s => s ? s.split(',').map(Number) : null
const TOP = +(opt('--top') || 24)
const pad = (s, n) => String(s).padEnd(n)
const rpad = (s, n) => String(s).padStart(n)

async function main () {
  const t0 = Date.now()
  const plan = PLAN.compile({ archive: !flag('--no-archive'), box: nums(opt('--box')) })
  const ms = Date.now() - t0
  const out = { t: Date.now(), ms, cells: plan.cellCount, chunks: plan.chunkCount, palette: plan.pal.length, sources: plan.sources.length, box: plan.box }

  if (opt('--at')) {
    const [x, y, z] = nums(opt('--at'))
    const t = plan.at(x, y, z)
    console.log('cell ' + x + ',' + y + ',' + z + (plan.inKeepOut(x, z) ? '  [keep-out ' + plan.inKeepOut(x, z) + ']' : ''))
    console.log(t ? '  target ' + t.block + '  layer ' + t.layer + '  owner ' + t.owner + ' (' + t.src + ', ' + t.kind + ')  accepts ' + (t.layer === 'body' ? 'ANY stone sort (buried)' : [t.block].concat(t.mats || []).slice(0, 8).join('/')) : '  NO TARGET — this cell is not in any plan (natural ground: nothing may dig or place here)')
    const col = plan.ownerAt(x, z); if (col) console.log('  column surface: ' + col.block + ' owned by ' + col.owner)
    return
  }

  // ---------------------------------------------------------------- sources
  const byKind = {}
  for (const s of plan.sources) { const k = s.kind + (s.live ? '' : ' (done)'); byKind[k] = (byKind[k] || 0) + 1 }
  console.log('PLAN  ' + plan.cellCount.toLocaleString() + ' target cells · ' + plan.chunkCount + ' chunks · palette ' + plan.pal.length + ' · ' + plan.sources.length + ' sources ' + JSON.stringify(byKind) + ' · compiled in ' + ms + ' ms')
  console.log('      box x ' + plan.box[0] + '..' + plan.box[2] + ' / z ' + plan.box[1] + '..' + plan.box[3] + ' · precedence structure > road > pad > fill > deco(cap) · keep-outs ' + plan.keepOut.map(k => k.id).join(', '))

  if (opt('--job')) {
    const id = opt('--job'); const ss = plan.sources.filter(s => s.owner === id)
    if (!ss.length) return console.log('no such build/road job on the board or in the archive: ' + id)
    const n = ss.reduce((a, s) => a + s.n, 0); const lf = ss.reduce((a, s) => a + s.stats.cells, 0); const rw = ss.reduce((a, s) => a + s.stats.rewrote, 0)
    console.log('\n' + id + '  ' + ss[0].kind + '  ' + ss[0].status + '  blueprint ' + ss[0].blueprint + '  zone ' + ss[0].zone)
    console.log('  cells ' + n + ' planned -> ' + lf + ' OWNED (' + (n - lf) + ' lost to a higher-precedence plan)' + (rw ? '; ' + rw + ' surface cells rewritten to the ground material by the material rule' : ''))
    console.log('  layers: surface ' + ss.reduce((a, s) => a + s.stats.surface, 0) + ' · body ' + ss.reduce((a, s) => a + s.stats.body, 0) + ' · structure ' + ss.reduce((a, s) => a + s.stats.structure, 0) + ' · air ' + ss.reduce((a, s) => a + s.stats.air, 0))
    for (const o of plan.overlaps.filter(o => o.loser === id || o.winner === id)) console.log('  ' + (o.loser === id ? 'LOSES ' + rpad(o.cells, 6) + ' cells to ' + o.winner : 'takes ' + rpad(o.cells, 6) + ' cells from ' + o.loser) + '  (' + o.kinds + (o.chain ? ', chained' : '') + (o.disagree ? ', ' + o.disagree + ' DISAGREE' : '') + ')')
    return
  }

  // ---------------------------------------------------------------- overlaps
  const all = flag('--all')
  const war = plan.overlaps.filter(o => all || (o.live && !o.chain))
  console.log('\nOVERLAPS — ' + plan.overlaps.length + ' pairs of jobs claim the same cells; ' + plan.overlaps.filter(o => o.live && !o.chain && o.disagree).length + ' are LIVE, unchained and DISAGREE about the block (= a dig/place war). Resolution is applied at plan time:')
  console.log('   ' + pad('loser', 34) + pad('winner', 26) + rpad('cells', 7) + rpad('cols', 6) + rpad('war', 6) + '  class            at')
  for (const o of war.slice(0, TOP)) {
    console.log('   ' + pad(o.loser + (o.lostAll ? ' *' : ''), 34) + pad(o.winner, 26) + rpad(o.cells, 7) + rpad(o.columns, 6) + rpad(o.disagree || '-', 6) + '  ' + pad(o.kinds + (o.chain ? ' ch' : '') + (o.live ? '' : ' done'), 17) + o.at.join(','))
  }
  if (war.length > TOP) console.log('   … ' + (war.length - TOP) + ' more (--top ' + war.length + (all ? '' : ' | --all') + ')')
  console.log('   war = cells where the two want DIFFERENT blocks (each would undo the other); * = the loser keeps nothing at all')
  console.log('   ch = a pad and the thing built on it (chained by `after` / `<zone>_pad`): overlap by design, not a conflict')
  for (const o of war.slice(0, 6)) console.log('   -> ' + o.resolution)

  // ---------------------------------------------------------------- plan errors
  console.log('\nPLAN ERRORS — precedence cannot reconcile these; a human must decide (' + plan.errors.length + '):')
  if (!plan.errors.length) console.log('   none')
  for (const e of plan.errors) console.log('   [' + e.kind + '] ' + e.why + (e.at ? '   look: ' + e.at.join(',') : ''))

  console.log('\nJOBS WITH NOTHING LEFT (' + plan.subsumed.length + ') — every cell of theirs belongs to a higher-precedence plan:')
  if (!plan.subsumed.length) console.log('   none')
  for (const s of plan.subsumed) console.log('   ' + pad(s.id, 34) + pad(s.kind + ' ' + s.status, 16) + rpad(s.had, 6) + ' -> ' + rpad(s.left, 5) + '  ' + s.verdict.toUpperCase() + '  (owned by ' + s.by.join(', ') + ')')

  // ---------------------------------------------------------------- the material rule
  const rw = plan.sources.filter(s => s.stats.rewrote).sort((a, b) => b.stats.rewrote - a.stats.rewrote)
  const rwN = rw.reduce((a, s) => a + s.stats.rewrote, 0)
  console.log('\nTHE MATERIAL RULE (owner 09-21) — the visible top of a terrain job now carries the GROUND material in the map, so no')
  console.log('second job has to lay a skin over it: ' + rwN.toLocaleString() + ' surface cells rewritten to ' + PLAN.SURFACE_BLOCK + ' across ' + rw.length + ' jobs' + (rw.length ? ' (' + rw.slice(0, 5).map(s => s.owner + ' ' + s.stats.rewrote).join(', ') + ')' : ''))
  const caps = plan.sources.filter(s => s.kind === 'deco' && s.live)
  console.log('   cap_* jobs still on the board: ' + (caps.length ? caps.map(s => s.owner).join(', ') : 'none') + ' — they are what the rule retires')

  // ---------------------------------------------------------------- per-zone totals
  const zones = new Map()
  for (const s of plan.sources) { const z = zones.get(s.zone) || { cells: 0, surface: 0, body: 0, structure: 0, air: 0, jobs: new Set() }; z.cells += s.stats.cells; z.surface += s.stats.surface; z.body += s.stats.body; z.structure += s.stats.structure; z.air += s.stats.air; z.jobs.add(s.owner); zones.set(s.zone, z) }
  console.log('\nTARGET CELLS PER ZONE (what the plan says should stand there):')
  console.log('   ' + pad('zone', 22) + rpad('jobs', 5) + rpad('cells', 9) + rpad('surface', 9) + rpad('body', 9) + rpad('structure', 10) + rpad('air', 8))
  for (const [k, z] of [...zones].sort((a, b) => b[1].cells - a[1].cells).slice(0, 14)) console.log('   ' + pad(k, 22) + rpad(z.jobs.size, 5) + rpad(z.cells, 9) + rpad(z.surface, 9) + rpad(z.body, 9) + rpad(z.structure, 10) + rpad(z.air, 8))

  // ---------------------------------------------------------------- the diff (optional: it needs the world)
  if (flag('--diff')) {
    const d = await worldDiff(plan, nums(opt('--box')) || plan.box)
    if (d) {
      out.diff = d
      console.log('\nWORLD vs PLAN (SkyEye camera, ' + d.ms + ' ms) — this is what a build job should work from:')
      console.log('   ' + pad('zone', 22) + rpad('missing', 9) + rpad('wrong', 8) + rpad('extra', 8) + rpad('ok', 9) + rpad('unseen', 8))
      for (const [k, c] of Object.entries(d.byZone).sort((a, b) => (b[1].missing + b[1].wrong + b[1].extra) - (a[1].missing + a[1].wrong + a[1].extra)).slice(0, 14)) console.log('   ' + pad(k, 22) + rpad(c.missing, 9) + rpad(c.wrong, 8) + rpad(c.extra, 8) + rpad(c.ok, 9) + rpad(c.unknown, 8))
      console.log('   TOTAL' + rpad(d.counts.missing, 26) + rpad(d.counts.wrong, 8) + rpad(d.counts.extra, 8) + rpad(d.counts.ok, 9) + rpad(d.counts.unknown, 8))
      for (const k of ['missing', 'wrong', 'extra']) {
        const ex = d.cells.filter(c => c.how === k).slice(0, 4)
        if (ex.length) console.log('   ' + pad(k, 9) + ex.map(c => c.x + ',' + c.y + ',' + c.z + ' want ' + c.want + '/' + c.layer + ' have ' + c.have + ' (' + c.owner + ')').join(' · '))
      }
      console.log('   missing = target solid, world air · wrong = target material, world has something else it does not accept · extra = target air, world solid')
      console.log('   (a BODY cell accepts any stone sort, so it is never "wrong": nobody will ever see it — that alone is thousands of digs not done)')
    }
  } else {
    console.log('\n(no world read: `node ops/plan-check.js --diff` flies the SkyEye camera and prints missing/wrong/extra per zone, ~60 s)')
  }

  if (flag('--json')) { out.overlaps = plan.overlaps; out.errors = plan.errors; out.subsumed = plan.subsumed; console.log('\n' + JSON.stringify(out)) }
}

// the WORLD for the diff: the spectator camera (ops/skyshot.js fly) at step 1, exactly as ops/base-audit.js reads it. Read-only.
async function worldDiff (plan, box) {
  const SKY = require(path.join(W, 'ops/skyshot.js')); const NM = path.join(W, 'bots/node_modules') + '/'
  const { execFileSync } = require('child_process')
  const rcon = c => { try { return execFileSync('node', [path.join(W, 'bots/rcon.js'), c], { encoding: 'utf8', timeout: 15000 }) } catch (e) { return '' } }
  const release = SKY.lock('plan-check'); if (!release) { console.log('\nWORLD vs PLAN: another SkyEye session holds the camera (/tmp/skyeye.lock) — try again in a minute'); return null }
  const t0 = Date.now(); const mineflayer = require(NM + 'mineflayer'); let bot
  const store = new Map()   // 'x,y,z' -> name, filled per camera hover for the cells of that tile only
  try {
    await new Promise((resolve, reject) => {
      bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'SkyEye', version: process.env.MC_VERSION || '26.1', auth: 'offline', viewDistance: 'far' })
      bot.once('kicked', r => reject(new Error('kicked: ' + JSON.stringify(r).slice(0, 120)))); bot.once('error', reject)
      const noSpawn = setTimeout(() => reject(new Error('no spawn in 30 s')), 30000)
      bot.once('spawn', async () => {
        clearTimeout(noSpawn)
        try {
          await new Promise(r => setTimeout(r, 2500))
          if (bot.game.gameMode !== 'spectator') throw new Error('SkyEye is not a spectator (datapack modes missing?) — refusing to fly')
          await SKY.fly(bot, (a, b, c) => rcon('tp SkyEye ' + a + ' ' + b + ' ' + c), [box], R => {
            for (const c of plan.cells([R.cell[0], R.cell[1], R.cell[2], R.cell[3]])) { const n = R.name(c.x, c.y, c.z); if (n != null) store.set(c.x + ',' + c.y + ',' + c.z, n) }
          }, { deadline: t0 + 150000 })
          resolve()
        } catch (e) { reject(e) }
      })
    })
  } catch (e) { console.log('\nWORLD vs PLAN: the camera could not fly (' + e.message + ') — is the server up? `ops/status.sh`'); return null } finally { try { bot.quit() } catch (e_) {} release() }
  const d = plan.diff((x, y, z) => { const v = store.get(x + ',' + y + ',' + z); return v === undefined ? null : v }, box, { max: 60000 })
  d.ms = Date.now() - t0
  return d
}

main().catch(e => { console.error('plan-check: ' + e.stack); process.exit(1) })
