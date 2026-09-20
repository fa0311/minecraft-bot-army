#!/usr/bin/env node
// ops/base-audit.js [--png out.png] [--px 3] [--box x1,z1,x2,z2] [--dry] [--all] | --idle [--min 60] — THE BASE AUDIT: the PLAN against the WORLD, LLM-free, ~60 s, every ~30 min.
// WHY (owner 09-20): cane that does not grow, 76 sheep outside the pen, junk blocks by the depot, a bumpy base, furnaces that are air, a dorm without
// its east wall - he saw them, no report did. Everything we "knew" was what bots REPORT about their own actions; nobody measured OUTCOMES.
// This script does: the spectator camera `SkyEye` (ops/skyshot.js fly(): rcon tp, never touches the world) reads the loaded chunk data at STEP 1 and
// compares it with the plan on the board (settings.base/keepOut/furniture, every build job's blueprint cells - board + bots/army/jobs-archive.jsonl -,
// herd pens, farm boxes) plus the inspector's per-minute bot positions (bots/metrics/samples-*.jsonl):
//   audit_rough     columns of the levelled base (pads, roads, footprints, the tidy yard) whose ground is not the base level -> clusters, NEW craters
//   audit_stray     solid placed-kind blocks above the level that are in no blueprint cell and are no registered furniture (pens / depot / hall first)
//   audit_floating  leaf/log clusters with no rooted trunk, or hanging over a finished pad / road / field (outside keep-outs and tree-farm zones) -> tidy work units
//   audit_pen       heads inside each pen vs the same kind outside within 96 blocks, open gates, climbable blocks inside
//   audit_growth    per farm/cane/lumber job: share of the last hour a bot stood within 128 blocks (crops only grow in ticked chunks), ripe share, grew?
//   audit_furniture registered furnaces/chests/beds/crafting table that are not standing
//   audit_field     per field_block: holes / raised / untilled / junk columns
//   audit_structure per build job (whatever its status): blueprint cells that are missing or wrong - walls under a roof included (chunk data, not a photo)
//   audit_idle      bot-hours each job HELD vs the output it produced (table OUTPUT below): share of bot time that produced nothing, worst jobs
// OUT: bots/army/base_audit.json (latest + prev), events {bot:'audit', ev:'audit_*', alert, fresh, text} in results.jsonl (alerts only + one audit_done),
// a PNG (RED bumps, BLUE holes, MAGENTA stray, YELLOW missing cells, ORANGE animals outside, white inside) and the same lines on stdout.
// Readers: REPORT.md "BASE AUDIT" (inspector, which also starts this script when the result is > 30 min old), ops/foreman.sh (prompt + picture),
// ops/escalate.sh (fresh alerts), `armyctl.js events 20 audit`.
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process')
const W = '/root/workspace'; const A = W + '/bots/army'; const NM = W + '/bots/node_modules/'; const SKY = require(W + '/ops/skyshot.js')
const STATE = A + '/base_audit.json'; const RESULTS = A + '/results.jsonl'; const T0 = Date.now()
const argv = process.argv.slice(2); const opt = n => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1] }; const DRY = argv.includes('--dry')
const OUT = opt('--png') || '/tmp/base-audit.png'; const PX = +(opt('--px') || 3); const MARGIN = 48
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const inBox = (b, x, z) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]
const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
const grow = (r, n) => [r[0] - n, r[1] - n, r[2] + n, r[3] + n]
const distBox = (b, x, z) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3]))
const TERRAIN = /^(level|clear_area|fill_void|quarry)$/; const OPEN_PIT = /^(mine_head|stairwell|quarry)$/
const GROUNDISH = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|farmland|dirt_path|stone|andesite|diorite|granite|gravel|sand|red_sand|sandstone|clay|mud|deepslate|tuff|calcite|snow_block|moss_block|.*_ore)$/
const TREE = /_log$|_wood$|_leaves$|^bamboo|^vine$|mushroom_block|mushroom_stem/
// WEEDS (owner 09-20: "花の除去が出来てない" - the base lies in a flower forest; `level` clears its own cells ONCE, nothing looked at what stands on the ground afterwards):
// small plants on the base's ground that nobody planted. Crops, saplings, cane and torches are not in here; fields and pens are left out below.
const WEED = /^(short_grass|tall_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|wildflowers|pink_petals|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|.*_tulip|sweet_berry_bush|cactus_flower|short_dry_grass|tall_dry_grass)$/
const FURN = /_bed$|^(chest|trapped_chest|barrel|furnace|smoker|blast_furnace|crafting_table|enchanting_table|bookshelf|anvil|campfire|lantern)$/
const CROPS = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 }; const HERD = /^(sheep|cow|pig|chicken|mooshroom|goat|horse|donkey|llama|rabbit)$/
const SOILS = /^(dirt|grass_block|farmland|podzol|dirt_path|coarse_dirt|rooted_dirt|mycelium)$/; const STORE = /^(chest|trapped_chest|barrel)$/
const same = (want, have, c) => want === have || (c && Array.isArray(c.mats) && c.mats.includes(have)) || (STORE.test(want) && STORE.test(have)) || (SOILS.test(want) && SOILS.test(have))

// ---------- PRODUCTIVITY: what counts as OUTPUT (extend HERE). ev -> units of output attributable to r.job; a job_slice (bot, job, ms) with no output
// event of the same bot + job inside it is STANDING time (a guard without an enemy, a farmer waiting for growth, a lamplighter in a lit base) ----------
const sum = o => Object.values(o || {}).reduce((a, b) => a + (+b || 0), 0)
const OUTPUT = {
  banked: r => sum(r.items), build_pass: r => r.done, build_done: () => 1, chest_placed: () => 1, water_cell: () => 1, torch: () => 1,
  crafted_to_target: r => r.made, forged: r => sum(r.made), furnaces: r => (r.took || 0) + (r.loaded || 0), cooked: r => r.n || 1,
  farm_pass: r => ((r.st || {}).harvested || 0) + ((r.st || {}).planted || 0), cane_pass: r => (r.cut || 0) + (r.planted || 0), lumber_pass: r => (r.felled || 0) + (r.planted || 0),
  herded: r => r.n, bred: r => r.babies || r.pairs, pen_harvest: r => (r.sheared || 0) + (r.culled || 0), trip: r => (r.kills || 0) + (r.haul || 0) + (r.banked || 0),
  tidy_pass: r => (r.pillars || 0) + (r.holes || 0) + (r.floats || 0) - (r.failed || 0), guard_pass: r => r.kills, creeper: r => r.killed ? 1 : 0,
  stair_repaired: r => r.fixed, step: r => r.ok && !/^(goto|wait|say|equip|eat|sleep)$/.test(r.do) ? 1 : 0, scout_trip: () => 1, sampled: () => 1,
  job_slice: r => { const m = /"rawDelivered":(\d+)/.exec(r.r || ''); return m ? +m[1] : 0 } // a mine shift reports its haul in its own slice
}
function productivity (min = 60) {
  const cut = Date.now() - min * 60000; const st = fs.statSync(RESULTS); const from = Math.max(0, st.size - 24e6); const fd = fs.openSync(RESULTS, 'r'); const buf = Buffer.alloc(st.size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd)
  const out = {}; const slices = []; const J = {}; const job = id => (J[id] = J[id] || { job: id, ms: 0, idleMs: 0, output: 0, declines: 0, why: {}, kinds: {} })
  for (const l of buf.toString().split('\n')) {
    if (l.length < 20) continue; let r; try { r = JSON.parse(l) } catch { continue } if (!(r.t >= cut) || !r.job || r.bot === 'audit') continue
    if (r.ev === 'declined') { job(r.job).declines++; continue }
    const f = OUTPUT[r.ev]; const u = f ? +f(r) || 0 : 0
    if (u > 0) { (out[r.bot + '|' + r.job] = out[r.bot + '|' + r.job] || []).push(r.t); const j = job(r.job); j.output += u; j.kinds[r.ev] = (j.kinds[r.ev] || 0) + u }
    if (r.ev === 'job_slice' && r.ms > 0) slices.push(r)
  }
  for (const r of slices) { const j = job(r.job); const ms = Math.min(r.ms, r.t - cut); j.ms += ms; if (!(out[r.bot + '|' + r.job] || []).some(t => t >= r.t - r.ms - 2000 && t <= r.t + 2000)) { j.idleMs += ms; const w = String(r.r).replace(/[{\d].*$/, '').trim().slice(0, 40) || '-'; j.why[w] = (j.why[w] || 0) + ms } }
  // time at MUSTER is in no slice: the inspector's per-minute samples know it (task "army:muster…", the quartermaster's desk excluded)
  let musterMin = 0; let botMin = 0
  try { const f = W + '/bots/metrics/samples-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl'; const s2 = fs.statSync(f); const fr = Math.max(0, s2.size - (min + 5) * 60000); const fd2 = fs.openSync(f, 'r'); const b2 = Buffer.alloc(s2.size - fr); fs.readSync(fd2, b2, 0, b2.length, fr); fs.closeSync(fd2)
    for (const l of b2.toString().split('\n')) { if (l[0] !== '{') continue; try { const r = JSON.parse(l); if (r.t < cut) continue; for (const v of Object.values(r.b || {})) if (v) { botMin++; if (/^army:muster(?! \(quartermaster)/.test(String(v[5]))) musterMin++ } } catch {} } } catch {}
  const H = ms => +(ms / 3600000).toFixed(1); const rows = Object.values(J).filter(j => j.ms > 0); const tot = rows.reduce((n, j) => n + j.ms, 0) + musterMin * 60000; const idle = rows.reduce((n, j) => n + j.idleMs, 0) + musterMin * 60000
  const worst = rows.sort((a, b) => b.idleMs - a.idleMs).slice(0, 8).map(j => ({ job: j.job, botHours: H(j.ms), idleHours: H(j.idleMs), output: Math.round(j.output), declines: j.declines, why: (Object.entries(j.why).sort((a, b) => b[1] - a[1])[0] || ['-'])[0], of: Object.entries(j.kinds).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => k + ' ' + Math.round(n)).join(', ') }))
  const zero = worst.filter(w => w.botHours >= 2 && (w.output === 0 || w.idleHours >= w.botHours * 0.8)); const share = tot ? +(idle / tot).toFixed(2) : null
  return { ev: 'audit_idle', key: '', alert: share != null && (share >= 0.3 || zero.length > 0) && tot > 5 * 3600000, standingShare: share, botHours: H(tot), idleHours: H(idle), musterHours: +(musterMin / 60).toFixed(1), zeroJobs: zero.map(w => w.job), worst,
    text: 'PRODUCTIVITY last ' + min + ' min: ' + Math.round((share || 0) * 100) + ' % of bot time produced NOTHING (' + H(idle) + ' of ' + H(tot) + ' bot-h; at muster ' + (musterMin / 60).toFixed(1) + '): ' + worst.slice(0, 6).map(w => w.job + ' ' + w.idleHours + '/' + w.botHours + ' bot-h idle' + (w.output ? ' (out ' + w.output + ': ' + w.of + ')' : ' (ZERO output, "' + w.why + '")') + (w.declines ? ' declined x' + w.declines : '')).join(' · ') +
      ' -> a job that holds bots without output is a planning failure: lower its `bots`, give it `when`/`restUntil`, or pause it so the bots fall into a sponge that HAS work (build pads, lumber, mine); a handler that stands by design (guard patrol, farmers waiting for growth) = one line in docs/BUGS.md' }
}

// ---------- the PLAN ----------
function loadPlan () {
  const board = rj(A + '/jobs.json', {}); const S = board.settings || {}; if (!S.base) throw new Error('no settings.base on the board - nothing to audit against')
  const level = S.base.y; const jobs = new Map()
  try { for (const l of fs.readFileSync(W + '/bots/army/jobs-archive.jsonl', 'utf8').split('\n')) { if (!l) continue; try { const j = JSON.parse(l); jobs.set(j.id, Object.assign(j, { status: 'archived' })) } catch {} } } catch {}
  for (const j of board.jobs || []) jobs.set(j.id, j)
  let box = opt('--box') ? opt('--box').split(',').map(Number) : null
  if (!box) try { const m = /wall line x (-?\d+)\.\.(-?\d+) \/ z (-?\d+)\.\.(-?\d+)/.exec(execFileSync('node', [A + '/armyctl.js', 'plan-base'], { timeout: 20000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); if (m) box = [+m[1], +m[3], +m[2], +m[4]] } catch {}
  const tidy = [...jobs.values()].filter(j => j.type === 'tidy' && j.status === 'active' && j.params && Array.isArray(j.params.box))
  if (!box) box = tidy.length ? tidy[0].params.box.slice() : [S.base.x - 128, S.base.z - 128, S.base.x + 128, S.base.z + 128]
  const bd = W + '/bots/blueprints/'; const norm = require(bd + 'lib/mats.js').normalise; const builds = []; const near = grow(box, 64)
  for (const j of jobs.values()) {
    const P = j.params || {}; if (j.type !== 'build' || !P.blueprint || !Array.isArray(P.origin)) continue
    try {
      const f = bd + String(P.blueprint).replace(/[^a-z0-9_]/gi, '') + '.js'; const cells = require(f)({ x: P.origin[0], y: P.origin[1], z: P.origin[2] }, P.args || {}).map(norm); if (!cells.length) continue
      const bb = [1e9, 1e9, -1e9, -1e9]; for (const c of cells) { if (c.x < bb[0]) bb[0] = c.x; if (c.x > bb[2]) bb[2] = c.x; if (c.z < bb[1]) bb[1] = c.z; if (c.z > bb[3]) bb[3] = c.z }
      if (!overlap(bb, near)) continue // another world's archive, an outpost
      builds.push({ id: j.id, status: j.status, blueprint: P.blueprint, bbox: bb, cells, terrain: TERRAIN.test(P.blueprint) })
    } catch (e) { console.log('plan: ' + j.id + ' ' + P.blueprint + ': ' + e.message) }
  }
  // a cell a LATER terrain job cleared or a moved job re-planned is judged by the newest word only for structures: terrain blueprints never enter `planned`
  const planned = new Map() // 'x,y,z' -> cell (non-air) of any structure, 'steps' place cells included
  for (const b of builds) if (!b.terrain) for (const c of b.cells) if (c.block !== 'air') planned.set(c.x + ',' + c.y + ',' + c.z, c)
  for (const j of jobs.values()) if (j.type === 'steps') for (const s of (j.params || {}).steps || []) if (s.do === 'place') for (const c of [].concat(s.at ? [s.at] : [], s.cells || [])) if (Array.isArray(c) && c.length === 3) planned.set(c.join(','), { block: s.block })
  const furniture = []; const F = (list, kind, re) => { for (const p of list || []) if (Array.isArray(p) && p.length === 3) furniture.push({ at: p, kind, re }) }
  F(S.furnaces, 'furnace', /furnace|smoker/); for (const [cat, l] of Object.entries(S.chests || {})) F(l, 'chest:' + cat, STORE); F(S.respawnBeds, 'bed', /_bed$/); F(S.craftTable ? [S.craftTable] : [], 'crafting_table', /^crafting_table$/)
  const furnAt = new Set(); for (const f of furniture) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) furnAt.add((f.at[0] + dx) + ',' + f.at[1] + ',' + (f.at[2] + dz)) // a bed's head, a double chest's half
  const pens = []
  for (const j of jobs.values()) if (j.type === 'herd' && j.params && Array.isArray(j.params.pen)) pens.push({ id: j.id, box: j.params.pen, kind: j.params.kind || null, status: j.status, want: j.params.want })
  for (const b of builds) if (b.blueprint === 'pen') { const p = pens.find(q => overlap(q.box, b.bbox)); if (p) p.build = b.id; else pens.push({ id: b.id, box: b.bbox, kind: null, status: b.status, build: b.id }) }
  const farms = []
  for (const j of board.jobs || []) { const P = j.params || {}; if (j.status !== 'active' || !Array.isArray(P.box) || !/^(farm|cane|lumber)$/.test(j.type) || P.wild) continue; farms.push({ id: j.id, type: j.type, box: P.box, y: Number.isFinite(P.y) ? P.y : null }) }
  const zones = [] // named places for the "where" of a finding, most specific first
  for (const p of pens) zones.push({ name: 'pen ' + p.id, box: p.box })
  for (const b of builds) if (/^(depot_rows|core)$/.test(b.blueprint)) zones.push({ name: (b.blueprint === 'core' ? 'hall' : 'depot') + ' (<=8)', box: grow(b.bbox, 8) })
  for (const b of builds) if (!b.terrain && !/^road/.test(b.blueprint)) zones.push({ name: b.id.replace(/^base_/, ''), box: b.bbox })
  for (const b of builds) if (/^road/.test(b.blueprint)) zones.push({ name: b.id.replace(/^base_/, ''), box: b.bbox })
  for (const b of builds) if (b.blueprint === 'level') zones.push({ name: b.id.replace(/^base_/, '') + (b.status === 'archived' ? '' : ' [job ' + b.status + ']'), box: b.bbox })
  return { S, level, box, builds, planned, furniture, furnAt, pens, farms, zones, tidy: tidy.map(j => ({ box: j.params.box, exclude: j.params.exclude || [] })), keepOut: (S.keepOut || []).map(k => ({ id: k.id, box: grow(k.box, 3) })) }
}
const whereOf = (P, x, z) => { const q = P.zones.find(o => inBox(o.box, x, z)); return q ? q.name : 'yard' }

// ---------- loaded chunks: share of the last `min` minutes with >= 1 bot within 128 blocks (horizontal) of a point ----------
function loadedShare (farms, min = 60) {
  const rows = []; const cut = Date.now() - min * 60000
  for (const d of [new Date(Date.now() - 86400000), new Date()]) {
    const f = W + '/bots/metrics/samples-' + d.toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl'; let st; try { st = fs.statSync(f) } catch { continue }
    const from = Math.max(0, st.size - (min + 5) * 60000); const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(st.size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd)
    for (const l of buf.toString().split('\n')) { if (l.length < 20 || l[0] !== '{') continue; try { const r = JSON.parse(l); if (r.t >= cut) rows.push(r) } catch {} }
  }
  const out = {}
  for (const f of farms) {
    const cx = (f.box[0] + f.box[2]) / 2; const cz = (f.box[1] + f.box[3]) / 2; const pts = [[cx, cz], [f.box[0], f.box[1]], [f.box[2], f.box[1]], [f.box[0], f.box[3]], [f.box[2], f.box[3]]]; const hit = pts.map(() => 0)
    for (const r of rows) { const bs = Object.values(r.b || {}).filter(Boolean); pts.forEach((p, i) => { if (bs.some(v => Math.hypot(v[0] - p[0], v[2] - p[1]) <= 128)) hit[i]++ }) }
    out[f.id] = rows.length >= 10 ? { share: +(hit[0] / rows.length).toFixed(2), worst: +(Math.min(...hit) / rows.length).toFixed(2), samples: rows.length } : { share: null, worst: null, samples: rows.length } // centre, and the worst corner of the box
  }
  return out
}

// ---------- tiny PNG painter ----------
const FONT = { 0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111', '-': '000000111000000' }
function painter (w, h) {
  const img = Buffer.alloc(w * h * 3); const px = (x, y, c) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 3; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2] }
  const rect = (x, y, a, b, c) => { for (let j = 0; j < b; j++) for (let i = 0; i < a; i++) px(x + i, y + j, c) }
  const frame = (x, y, a, b, c) => { for (let i = 0; i < a; i++) { px(x + i, y, c); px(x + i, y + b - 1, c) } for (let j = 0; j < b; j++) { px(x, y + j, c); px(x + a - 1, y + j, c) } }
  const text = (x, y, s, c) => { for (const ch of String(s)) { const g = FONT[ch]; if (g) for (let k = 0; k < 15; k++) if (g[k] === '1') px(x + k % 3, y + Math.floor(k / 3), c); x += 4 } }
  return { img, px, rect, frame, text, w, h }
}

async function main () {
  if (argv.includes('--idle')) { const f = productivity(+(opt('--min') || 60)); console.log((f.alert ? '! ' : '  ok  ') + f.text); return } // the productivity block alone: no camera, nothing written
  const P = loadPlan(); const { level, box } = P; const pic = grow(box, MARGIN); const bw = box[2] - box[0] + 1; const bdp = box[3] - box[1] + 1; const pw = pic[2] - pic[0] + 1; const ph = pic[3] - pic[1] + 1
  const release = SKY.lock('base-audit'); if (!release) { console.log('another SkyEye session is flying - the audit is skipped'); process.exit(2) }
  process.on('exit', release)
  const rcon = c => { try { return execFileSync('node', [W + '/bots/rcon.js', c], { timeout: 15000, encoding: 'utf8' }) } catch (e) { return 'rcon failed: ' + e.message } }
  if (/\bSkyEye\b/.test(rcon('list'))) { console.log('SkyEye is already online (somebody else flies the camera) - the audit is skipped'); process.exit(2) }
  // per-column books of the base box
  const dy = new Int8Array(bw * bdp); const cls = new Uint8Array(bw * bdp) // cls: 0 wild · 1 pad/footprint · 2 structure column / pit / keep-out (not judged) · 3 tidy yard; +16 = seen
  const topY = new Int16Array(pw * ph).fill(-999); const topN = new Uint16Array(pw * ph); const names = ['?']; const nameIx = new Map(); const ix = n => { let i = nameIx.get(n); if (i == null) { i = names.length; names.push(n); nameIx.set(n, i) } return i }
  const wdN = new Uint8Array(bw * bdp); const gY = new Int16Array(bw * bdp).fill(-999) // solid top of EVERY column of the box, keep-outs included (fill audit below)
  const lvlN = new Uint16Array(bw * bdp); const upN = new Uint16Array(bw * bdp) // block at the level / one above it (field audit)
  const trN = new Uint8Array(bw * bdp); const trLo = new Int16Array(bw * bdp); const trHi = new Int16Array(bw * bdp); const trRoot = new Uint8Array(bw * bdp) // tree blocks above the level per column: count, lowest, highest, rooted trunk
  // a `level` pad CLAIMS its columns as flat only once it is done (archived by `prune`, or a build_done on record): a pad that is still planned or being cut is
  // land nobody levelled yet, not a defect (09-20: five new infill pads turned 483 rough columns into 10794)
  const doneJobs = new Set(); try { const st = fs.statSync(RESULTS); const from = Math.max(0, st.size - 24e6); const fd = fs.openSync(RESULTS, 'r'); const buf = Buffer.alloc(st.size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd); for (const l of buf.toString().split('\n')) if (l.includes('"build_done"')) { try { doneJobs.add(JSON.parse(l).job) } catch {} } } catch {}
  for (const b of P.builds) b.pending = b.blueprint === 'level' && b.status !== 'archived' && !doneJobs.has(b.id)
  const planTop = new Map(); for (const b of P.builds) for (const c of b.cells) { if (c.block === 'air' || /torch/.test(c.block) || b.pending) continue; const k = c.x + ',' + c.z; if (b.terrain && b.blueprint !== 'level') continue; if (!planTop.has(k) || planTop.get(k) < c.y) planTop.set(k, c.y) }
  for (let z = box[1]; z <= box[3]; z++) {
    for (let x = box[0]; x <= box[2]; x++) {
      const i = (z - box[1]) * bw + x - box[0]; const pt = planTop.get(x + ',' + z)
      if (P.keepOut.some(k => inBox(k.box, x, z))) cls[i] = 2
      else if (pt != null) cls[i] = pt > level ? 2 : 1
      else if (P.tidy.some(t => inBox(t.box, x, z) && !t.exclude.some(e => inBox(e, x, z)))) cls[i] = 3
    }
  }
  const pit = new Uint8Array(bw * bdp) // stairwells / quarries: their spoil and steps are theirs up to one above the level
  for (const b of P.builds) if (OPEN_PIT.test(b.blueprint)) for (let z = b.bbox[1]; z <= b.bbox[3]; z++) for (let x = b.bbox[0]; x <= b.bbox[2]; x++) if (inBox(box, x, z)) { cls[(z - box[1]) * bw + x - box[0]] = 2; pit[(z - box[1]) * bw + x - box[0]] = 1 }
  let surfaceStat = null; const weeds = []; const stray = []; const structs = new Map(P.builds.filter(b => !b.terrain).map(b => [b.id, { job: b.id, status: b.status, blueprint: b.blueprint, of: 0, seen: 0, missing: 0, wrong: 0, examples: [], marks: [] }]))
  const furnMissing = []; let furnSeen = 0; const crops = {}; for (const f of P.farms) crops[f.id] = { w: f.box[2] - f.box[0] + 1, map: new Array((f.box[2] - f.box[0] + 1) * (f.box[3] - f.box[1] + 1)).fill('?') }
  const gates = []; let Block = null
  const regions = [pic].concat(P.farms.map(f => f.box), P.pens.map(p => grow(p.box, 96)))

  const onHover = R => {
    const [cx1, cz1, cx2, cz2] = R.cell; const air = id => { const b = R.block(id); return !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' }
    // 1. the picture (top block) and, inside the base box, the SURFACE + STRAY scan
    for (let z = Math.max(cz1, pic[1]); z <= Math.min(cz2, pic[3]); z++) {
      for (let x = Math.max(cx1, pic[0]); x <= Math.min(cx2, pic[2]); x++) {
        if (R.sid(x, level, z) == null) continue
        const pi = (z - pic[1]) * pw + x - pic[0]; const inside = inBox(box, x, z); const bi = inside ? (z - box[1]) * bw + x - box[0] : -1
        let bump = null; let top = null; const judged = inside && cls[bi] !== 2
        for (let y = level + 45; y > level; y--) {
          const id = R.sid(x, y, z); if (id == null || air(id)) continue; const b = R.block(id); if (top == null) { top = y; topY[pi] = y; topN[pi] = ix(b.name) }
          if (!inside) break
          if (/_log$|_wood$|_leaves$/.test(b.name)) { if (trN[bi] < 255) trN[bi]++; if (!trHi[bi]) trHi[bi] = y; trLo[bi] = y }
          if (WEED.test(b.name) && judged) { const w0 = weeds[weeds.length - 1]; if (w0 && w0[0] === x && w0[2] === z) { w0[1] = y } else weeds.push([x, y, z, b.name]) } // the LOWEST cell of a plant (a lilac is 2 high: its foot takes both)
          if (TREE.test(b.name) || b.boundingBox !== 'block') continue
          const key = x + ',' + y + ',' + z; if (P.planned.has(key) || (FURN.test(b.name) && P.furnAt.has(key))) continue
          if (GROUNDISH.test(b.name)) { if (judged && bump == null) bump = y } else if (!pit[bi] || y > level + 1) stray.push([x, y, z, b.name])
        }
        let g = null; let wet = false
        for (let y = level; y >= level - 16; y--) { const id = R.sid(x, y, z); if (id == null || air(id)) continue; const b = R.block(id); if (top == null) { top = y; topY[pi] = y; topN[pi] = ix(b.name) } if (!inside) break; if (b.name === 'water') { wet = true; continue } if (WEED.test(b.name) && judged && !(weeds.length && weeds[weeds.length - 1][0] === x && weeds[weeds.length - 1][2] === z)) weeds.push([x, y, z, b.name]); if (TREE.test(b.name) || b.boundingBox !== 'block') continue; g = y; break }
        if (!inside) continue
        gY[bi] = (wet && (P.planned.get(x + ',' + level + ',' + z) || {}).block === 'water') ? level : bump != null ? bump : (g == null ? -999 : g); // a field's own water cell is not a hole if (gY[bi] !== -999 && WEED.test(R.name(x, gY[bi] + 1, z) || '')) wdN[bi] = 1
        cls[bi] |= 16; lvlN[bi] = ix(R.name(x, level, z) || '?'); upN[bi] = ix(R.name(x, level + 1, z) || '?')
        if (trN[bi]) { const gt = bump != null ? bump : g; trRoot[bi] = gt != null && /_log$|_wood$/.test(R.name(x, gt + 1, z) || '') ? 1 : 0 } // a trunk standing on the ground of this column
        if (judged) { const planWater = (P.planned.get(x + ',' + level + ',' + z) || {}).block === 'water'; dy[bi] = bump != null ? Math.min(100, bump - level) : planWater ? 0 : g == null ? -17 : g - level; if (wet && !planWater && dy[bi] === 0) dy[bi] = -1 }
      }
    }
    // 2. STRUCTURES: every blueprint cell of every build job in this cell of the lattice, walls under roofs included
    for (const b of P.builds) {
      if (b.terrain || !overlap(b.bbox, R.cell)) continue; const st = structs.get(b.id)
      for (const c of b.cells) {
        if (c.block === 'air' || c.fillOnly || /torch/.test(c.block) || !inBox(R.cell, c.x, c.z)) continue; st.of++
        const id = R.sid(c.x, c.y, c.z); if (id == null) continue; st.seen++; const hb = R.block(id) || { name: 'air' }; const have = hb.name
        if (/fence_gate$/.test(have) && b.blueprint === 'pen') { try { Block = Block || require(NM + 'prismarine-block')(bot.registry); if (Block.fromStateId(id, 0).getProperties().open) gates.push([c.x, c.y, c.z]) } catch {} }
        if (c.block === 'water' ? (have === 'water' && id === hb.minStateId) : same(c.block, have, c)) continue
        const gone = hb.boundingBox !== 'block' && have !== 'water'; if (gone) st.missing++; else st.wrong++
        if (st.examples.length < 5) st.examples.push(c.block + '@' + c.x + ',' + c.y + ',' + c.z + '=' + have); st.marks.push([c.x, c.z])
      }
    }
    // 3. FURNITURE the board counts on
    for (const f of P.furniture) { if (!inBox(R.cell, f.at[0], f.at[2])) continue; const n = R.name(f.at[0], f.at[1], f.at[2]); if (n == null) continue; furnSeen++; if (!f.re.test(n)) furnMissing.push({ kind: f.kind, at: f.at, have: n }) }
    // 4. CROPS of every active farm-like job: one char per column ('.' nothing · f bare farmland · 0-7 crop age · 1-9 cane height · s sapling · T tree)
    for (const f of P.farms) {
      if (!overlap(f.box, R.cell)) continue; const C = crops[f.id]; const yHi = (f.y != null ? f.y : level) + (f.type === 'lumber' ? 40 : 8); const yLo = (f.y != null ? f.y : level) - (f.type === 'lumber' ? 12 : 3)
      for (let z = Math.max(cz1, f.box[1]); z <= Math.min(cz2, f.box[3]); z++) {
        for (let x = Math.max(cx1, f.box[0]); x <= Math.min(cx2, f.box[2]); x++) {
          let ch = '.'; let cane = 0
          for (let y = yHi; y >= yLo; y--) {
            const id = R.sid(x, y, z); if (id == null) { ch = '?'; break } if (air(id)) continue; const b = R.block(id)
            if (b.name === 'sugar_cane') { cane++; continue } if (cane) break
            if (CROPS[b.name] != null) { ch = String(Math.round((id - b.minStateId) * 7 / CROPS[b.name])); break }
            if (b.name === 'farmland') { ch = 'f'; break } if (/_sapling$/.test(b.name)) { ch = 's'; break } if (/_log$/.test(b.name)) { ch = 'T'; break }
            if (f.type !== 'lumber' && b.boundingBox === 'block') break
            if (f.type === 'lumber' && b.boundingBox === 'block' && !TREE.test(b.name)) break
          }
          C.map[(z - f.box[1]) * C.w + x - f.box[0]] = cane ? String(Math.min(9, cane)) : ch
        }
      }
    }
  }

  const mineflayer = require(NM + 'mineflayer'); let bot
  const flown = await new Promise((resolve, reject) => {
    bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'SkyEye', version: process.env.MC_VERSION || '26.1', auth: 'offline', viewDistance: 'far' })
    bot.once('kicked', r => reject(new Error('kicked: ' + JSON.stringify(r).slice(0, 120)))); bot.once('error', e => reject(e)); const noSpawn = setTimeout(() => reject(new Error('no spawn in 30 s')), 30000)
    bot.once('spawn', async () => {
      clearTimeout(noSpawn)
      try {
        await sleep(2500); if (bot.game.gameMode !== 'spectator') throw new Error('SkyEye is not a spectator (datapack modes missing?) - refusing to fly')
        resolve(await SKY.fly(bot, (a, b, c) => rcon('tp SkyEye ' + a + ' ' + b + ' ' + c), regions, onHover, { kinds: HERD, deadline: T0 + 80000 }))
      } catch (e) { reject(e) }
    })
  }).finally(() => { try { bot.quit() } catch {} })
  const prevState = rj(STATE, null); const prev = prevState && prevState.t ? prevState : null; const findings = []; const say = f => findings.push(f)
  const prevAlert = new Map(((prev && prev.findings) || []).filter(f => f.alert).map(f => [f.ev + '|' + (f.key || ''), f]))

  // ---------- a. SURFACE ----------
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]; const mark = new Uint8Array(bw * bdp); const clusters = []; const count = { pad: 0, yard: 0, wild: 0, padSeen: 0, yardSeen: 0, wildSeen: 0, unseen: 0 }
  for (let i = 0; i < bw * bdp; i++) { const c = cls[i] & 15; if (!(cls[i] & 16)) { count.unseen++; continue } if (c === 2) continue; const k = c === 1 ? 'pad' : c === 3 ? 'yard' : 'wild'; count[k + 'Seen']++; if (dy[i]) count[k]++ }
  for (let i = 0; i < bw * bdp; i++) {
    if (mark[i] || !dy[i] || !(cls[i] & 16) || !((cls[i] & 15) === 1 || (cls[i] & 15) === 3)) continue
    const sign = dy[i] > 0 ? 1 : -1; const q = [i]; mark[i] = 1; let n = 0; let sx = 0; let sz = 0; let ext = 0; let onPad = 0; const members = []
    while (q.length) { const j = q.pop(); members.push(j); const x = j % bw; const z = (j - x) / bw; n++; sx += x; sz += z; if ((cls[j] & 15) === 1) onPad++; if (Math.abs(dy[j]) > Math.abs(ext)) ext = dy[j]; for (const [a, b] of N8) { const X = x + a; const Z = z + b; if (X < 0 || Z < 0 || X >= bw || Z >= bdp) continue; const k = Z * bw + X; if (mark[k] || !dy[k] || (dy[k] > 0 ? 1 : -1) !== sign || !(cls[k] & 16) || !((cls[k] & 15) === 1 || (cls[k] & 15) === 3)) continue; mark[k] = 1; q.push(k) } }
    clusters.push([box[0] + Math.round(sx / n), box[1] + Math.round(sz / n), n, ext, onPad, members])
  }
  // a DEFECT (crater, pillar, staircase, half-filled moat: <= 60 columns, or anything on a pad/road/footprint) is the sponge's and the builders' debt;
  // a big off-level area of the yard is LAND NOBODY LEVELLED YET (a hill, a pond inside the wall line) = a planning matter: it wants a `level` pad job
  const terrain = clusters.filter(c => c[2] > 60 && c[4] < c[2] * 0.5).sort((a, b) => b[2] - a[2]); const defects = clusters.filter(c => !terrain.includes(c)).sort((a, b) => b[2] * Math.abs(b[3]) - a[2] * Math.abs(a[3]))
  // THE SPONGE'S WORK LIST (foreman 09-20 07:20Z: 34 of 50 bots declined `tidy: every tile was tidied in the last 30 min` in the minute this audit measured 470 columns off
  // the level - the one measurement we trust and the one job that should act on it never talked). Every judged off-level column, grouped by sign and 8x8 tile:
  // {x,z centre, s: -1 hole / +1 bump, n, dy extreme, pad: columns on finished pads, area: 1 = part of a never-levelled area (lowest priority), cols:[[x,z,dy]]}.
  // job type `tidy` (army_jobs.js) takes the nearest unit nobody holds (blocks.js file lock), re-measures every column in the WORLD and reports `tidy_fix`.
  const work = []; { const wm = new Map(); for (const c of clusters) { const area = terrain.includes(c) ? 1 : 0; for (const j of c[5]) { const x = box[0] + j % bw; const z = box[1] + (j - j % bw) / bw; const k = (dy[j] > 0 ? 1 : -1) + ':' + (x >> 3) + ':' + (z >> 3); let u = wm.get(k); if (!u) { u = { x: 0, z: 0, s: dy[j] > 0 ? 1 : -1, n: 0, dy: 0, pad: 0, area, cols: [] }; wm.set(k, u); work.push(u) } u.cols.push([x, z, dy[j]]); u.n++; u.x += x; u.z += z; if ((cls[j] & 15) === 1) { u.pad++; u.area = 0 } if (!area) u.area = 0; if (Math.abs(dy[j]) > Math.abs(u.dy)) u.dy = dy[j] } } for (const u of work) { u.x = Math.round(u.x / u.n); u.z = Math.round(u.z / u.n) } }
  const pc = (prev && prev.clustersAll) || null; const fresh = pc ? defects.filter(c => !pc.some(p => Math.abs(p[0] - c[0]) <= 3 && Math.abs(p[1] - c[1]) <= 3 && (p[3] > 0) === (c[3] > 0))) : []
  const onPads = clusters.reduce((n, c) => n + c[4], 0); const rough = defects.reduce((n, c) => n + c[2], 0) + terrain.reduce((n, c) => n + c[4], 0); const wildCols = terrain.reduce((n, c) => n + c[2] - c[4], 0); const holes = defects.filter(c => c[3] < 0); const bumps = defects.filter(c => c[3] > 0); const cl = c => c[0] + ',' + c[1] + ' ' + (c[3] > 0 ? '+' : '') + c[3] + ' x' + c[2] + ' (' + whereOf(P, c[0], c[1]) + ')' // a pad column inside a hill's cluster is still a pad defect
  say({ ev: 'audit_rough', key: '', alert: rough >= 40 || fresh.filter(c => c[2] >= 3).length > 0, columns: rough, onPads, of: count.padSeen + count.yardSeen, holes: holes.length, bumps: bumps.length, was: prev && prev.rough ? prev.rough.columns : null, newClusters: fresh.slice(0, 6).map(c => ({ x: c[0], z: c[1], n: c[2], dy: c[3] })), clusters: defects.slice(0, 12).map(c => ({ x: c[0], z: c[1], n: c[2], dy: c[3], where: whereOf(P, c[0], c[1]) })), unlevelled: { columns: wildCols, areas: terrain.slice(0, 6).map(c => ({ x: c[0], z: c[1], n: c[2], dy: c[3] })) },
    text: 'BASE NOT FLAT (one site = ONE height, y' + level + '): ' + rough + ' columns in ' + holes.length + ' hole + ' + bumps.length + ' bump clusters are off the level (' + onPads + ' of them ON finished pads/roads/footprints' + (prev && prev.rough ? '; ' + prev.rough.columns + ' at the last audit' : '') + '); worst: ' + defects.slice(0, 6).map(cl).join(' · ') + (fresh.length ? ' | NEW since the last audit: ' + fresh.slice(0, 4).map(cl).join(' · ') : '') +
      ' -> the tidy sponge fills/cuts these (is it staffed, does it decline?); a crater that returns = find who digs (`look`); a big one = `template build` blueprint level / fill_void' + (wildCols ? ' | NEVER LEVELLED inside the yard: ' + wildCols + ' columns in ' + terrain.length + ' areas (' + terrain.slice(0, 4).map(cl).join(' · ') + ') -> a `level` pad job per area before anything is built there' : '') })

  // ---------- a2. WEEDS: flowers / grass on the base's ground (above the level; fields, pens and the tree farm keep theirs) ----------
  { const skip = (x, z) => P.farms.some(f => inBox(f.box, x, z)) || P.pens.some(q => inBox(q.box, x, z)) || /^(field|farm|pen|tree|cane)/.test(String(whereOf(P, x, z)))
    for (let i = weeds.length - 1; i >= 0; i--) if (skip(weeds[i][0], weeds[i][2])) weeds.splice(i, 1)
    const wk = {}; const wz = {}; for (const w of weeds) { wk[w[3]] = (wk[w[3]] || 0) + 1; const z0 = whereOf(P, w[0], w[2]); wz[z0] = (wz[z0] || 0) + 1 }
    say({ ev: 'audit_weeds', key: '', alert: false, n: weeds.length, was: prev && prev.weedN != null ? prev.weedN : null, kinds: Object.fromEntries(Object.entries(wk).sort((a, b) => b[1] - a[1]).slice(0, 6)), where: Object.fromEntries(Object.entries(wz).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      text: 'WEEDS: ' + weeds.length + ' flowers / grass tufts stand on the base ground' + (prev && prev.weedN != null ? ' (' + prev.weedN + ' at the last audit)' : '') + ': ' + Object.entries(wz).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => k + ' ' + n).join(', ') + ' -> the tidy sponge pulls them (kind `weed`); a number that does not fall = tidy is unstaffed or declines' }) }

  // ---------- a2b. SURFACE MATERIAL (owner 09-20: "適当にブロック使うから見栄えが悪い - 土を置くべきなところに石を置いたり、丸石を置くべきところに深層岩を置いてる"): what a spectator
  // SEES is the top block. (1) WRONG: a planned cell at the level whose block is a substitute of the blueprint's block (cobbled_deepslate in a cobblestone path - `mats`
  // substitution is for the hidden body of a wall or fill, never for a visible face); (2) RUBBLE: unplanned ground inside the base whose top is bare stone-family
  // filler (a filled ravine or a cut hill left as a grey slab) where grass/dirt belongs. Counted per zone with examples; tidy/cap jobs fix them. ----------
  { const STONE = /^(cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|gravel|mossy_cobblestone)$/; const wrong = []; const rub = {}; let rubN = 0; const wz = {}
    for (let z = box[1]; z <= box[3]; z++) for (let x = box[0]; x <= box[2]; x++) { const i = (z - box[1]) * bw + x - box[0]; if (!(cls[i] & 16) || gY[i] !== level) continue; const n = names[lvlN[i]]; if (!n || n === '?') continue
      const pc = P.planned.get(x + ',' + level + ',' + z)
      if (pc && pc.block && pc.block !== 'air' && pc.block !== 'water') { if (n !== pc.block && STONE.test(n) && STONE.test(pc.block)) { wrong.push([x, level, z, pc.block, n]); const w = whereOf(P, x, z); wz[w] = (wz[w] || 0) + 1 } continue }
      if (STONE.test(n)) { rubN++; const w = whereOf(P, x, z); rub[w] = (rub[w] || 0) + 1 } }
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => k + ' ' + n).join(', ')
    say({ ev: 'audit_surface', key: '', alert: false, wrong: wrong.length, rubble: rubN, was: prev && prev.surface ? prev.surface : null, wrongWhere: wz, rubbleWhere: rub, examples: wrong.slice(0, 8).map(q => q.slice(0, 3).join(',') + ' ' + q[3] + '<-' + q[4]),
      text: 'SURFACE MATERIAL: ' + wrong.length + ' visible planned cells hold a SUBSTITUTE block (' + top(wz) + '; e.g. ' + wrong.slice(0, 4).map(q => q.slice(0, 3).join(',') + ' wants ' + q[3] + ' has ' + q[4]).join(' | ') + ') · ' + rubN + ' ground columns are bare stone filler where grass/dirt belongs (' + top(rub) + ')' + (prev && prev.surface ? ' · last audit: ' + prev.surface.wrong + ' / ' + prev.surface.rubble : '') + ' -> visible faces take the blueprint block ONLY; fills and cuts end with a dirt cap' })
    surfaceStat = { wrong: wrong.length, rubble: rubN } }

  // ---------- a3. FILLS (owner 09-20: "花のある位置にブロックが置けず、穴が空いている ... 何故これらの問題に気が付けない？" - the ravine is a KEEP-OUT, and keep-outs were never judged:
  // the one place where 30 bots worked for hours was the one place this audit did not look at). Per fill_void job: columns still open below grade and PINHOLES = an open
  // column whose four neighbours all stand higher (a cell nobody could place: a flower, a lock, a bot stood there) - each with coordinates, plants flagged. ----------
  for (const b of P.builds.filter(q => q.blueprint === 'fill_void' && q.bbox)) {
    const bb = b.bbox; let open = 0; let deepest = 0; const pin = []
    for (let z = Math.max(bb[1], box[1]); z <= Math.min(bb[3], box[3]); z++) for (let x = Math.max(bb[0], box[0]); x <= Math.min(bb[2], box[2]); x++) {
      const i = (z - box[1]) * bw + x - box[0]; const g = gY[i]; if (g === -999 || g >= level) continue
      open++; deepest = Math.max(deepest, level - g)
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => { const X = x + dx; const Z = z + dz; return inBox(box, X, Z) ? gY[(Z - box[1]) * bw + X - box[0]] : level })
      if (nb.every(h => h !== -999 && h > g)) pin.push([x, g + 1, z, Math.min(...nb) - g, wdN[i]])
    }
    if (!open && b.status !== 'active') continue
    say({ ev: 'audit_fill', key: b.id, alert: pin.length >= 5 && b.status !== 'active', job: b.id, status: b.status, open, deepest, pinholes: pin.length, plants: pin.filter(q => q[4]).length, cells: pin.slice(0, 12).map(q => q.slice(0, 3).join(',')),
      text: 'FILL ' + b.id + ' (job ' + b.status + '): ' + open + ' columns still below grade y' + level + ' (deepest ' + deepest + '), ' + pin.length + ' PINHOLES (open cell, all four neighbours higher' + (pin.some(q => q[4]) ? '; ' + pin.filter(q => q[4]).length + ' hold a flower/grass' : '') + '): ' + pin.slice(0, 8).map(q => q.slice(0, 3).join(',') + (q[4] ? ' plant' : '')).join(' | ') + ' -> the fill job closes them (pull the plant, place the block); pinholes with the job paused/archived = a `steps` plan or re-activate the job' })
  }

  // ---------- b. STRAY BLOCKS ----------
  const kinds = {}; const byZone = {}; for (const s of stray) { kinds[s[3]] = (kinds[s[3]] || 0) + 1; const w = whereOf(P, s[0], s[2]); (byZone[w] = byZone[w] || []).push(s) }
  const hot = Object.entries(byZone).sort((a, b) => (/^(pen|depot|hall)/.test(b[0]) ? 1000 : 0) + b[1].length - (/^(pen|depot|hall)/.test(a[0]) ? 1000 : 0) - a[1].length)
  const hotN = hot.filter(([w]) => /^(pen|depot|hall)/.test(w)).reduce((n, [, l]) => n + l.length, 0)
  say({ ev: 'audit_stray', key: '', alert: hotN >= 1 || stray.length >= 12, n: stray.length, hot: hotN, was: prev && prev.strayN != null ? prev.strayN : null, blocks: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 8)), where: hot.slice(0, 8).map(([w, l]) => ({ zone: w, n: l.length, at: l.slice(0, 4).map(s => s[0] + ',' + s[1] + ',' + s[2] + ' ' + s[3]) })),
    text: 'STRAY BLOCKS: ' + stray.length + ' placed blocks above y' + level + ' that belong to no blueprint (' + Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => k + ' ' + n).join(', ') + '), ' + hotN + ' of them in pens / by the depot / hall: ' + hot.slice(0, 4).map(([w, l]) => w + ' x' + l.length + ' [' + l.slice(0, 3).map(s => s[0] + ',' + s[1] + ',' + s[2] + ' ' + s[3]).join(' | ') + ']').join(' · ') + ' -> somebody pillars/bridges or dumps blocks (movement is read-only!): remove them with a `steps` dig plan or the tidy sponge, and find the job that places them (docs/BUGS.md)' })

  // ---------- c. LIVESTOCK ----------
  const animals = [...flown.ents.values()].filter(e => e.type !== 'player' && HERD.test(e.name || '')); const inAnyPen = e => P.pens.some(p => e.x > p.box[0] && e.x < p.box[2] && e.z > p.box[1] && e.z < p.box[3])
  let culled = {}; try { const st = fs.statSync(RESULTS); const from = Math.max(0, st.size - 6e6); const fd = fs.openSync(RESULTS, 'r'); const buf = Buffer.alloc(st.size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd); for (const l of buf.toString().split('\n')) { if (!l.includes('"pen_harvest"')) continue; try { const r = JSON.parse(l); if (prev && r.t > prev.t && r.culled) culled[r.job] = (culled[r.job] || 0) + r.culled } catch {} } } catch {}
  const pensOut = {}
  for (const p of P.pens) {
    const mineKind = e => !p.kind || e.name === p.kind; const inside = animals.filter(e => mineKind(e) && e.x > p.box[0] && e.x < p.box[2] && e.z > p.box[1] && e.z < p.box[3]).length
    const others = animals.filter(e => !mineKind(e) && e.x > p.box[0] && e.x < p.box[2] && e.z > p.box[1] && e.z < p.box[3]).length
    const out = p.kind ? animals.filter(e => e.name === p.kind && !inAnyPen(e) && distBox(p.box, e.x, e.z) <= 96) : []; const far = out.reduce((m, e) => Math.max(m, Math.round(distBox(p.box, e.x, e.z))), 0)
    const climb = stray.filter(s => inBox(p.box, s[0], s[2])); let raised = 0; for (let z = p.box[1] + 1; z < p.box[3]; z++) for (let x = p.box[0] + 1; x < p.box[2]; x++) if (inBox(box, x, z) && dy[(z - box[1]) * bw + x - box[0]] > 0) raised++
    const gate = gates.filter(g => inBox(p.box, g[0], g[2])); const st = p.build && structs.get(p.build); const was = prev && prev.pens && prev.pens[p.id] ? prev.pens[p.id].inside : null
    const dropped = was != null && was >= 4 && inside < was * 0.7 && (was - inside) > (culled[p.id] || 0); pensOut[p.id] = { inside, outside: out.length }
    if (p.status !== 'active' && !inside && !out.length) continue
    const alert = (out.length >= 4 && out.length > inside / 2) || dropped || gate.length > 0 || (climb.length + raised > 0 && inside + out.length > 0) || !!(st && st.missing)
    say({ ev: 'audit_pen', key: p.id, job: p.id, pen: p.id, kind: p.kind, alert, inside, outside: out.length, farthest: far, was, culled: culled[p.id] || 0, others, gateOpen: gate.length, climbable: climb.length, raised, fenceMissing: st ? st.missing : null,
      text: 'PEN ' + p.id + ' (' + (p.kind || 'any') + ', x ' + p.box[0] + '..' + p.box[2] + ' / z ' + p.box[1] + '..' + p.box[3] + '): ' + inside + ' inside, ' + out.length + ' OUTSIDE within 96 blocks (farthest ' + far + ')' + (was != null ? ', inside at the last audit ' + was + (culled[p.id] ? ' (culled ' + culled[p.id] + ')' : '') : '') + (dropped ? ' = THE HERD IS LEAKING' : '') +
        ' | causes seen: ' + ([climb.length ? climb.length + ' climbable stray blocks inside (' + climb.slice(0, 3).map(s => s[0] + ',' + s[1] + ',' + s[2] + ' ' + s[3]).join(' | ') + ')' : '', raised ? raised + ' raised ground columns inside (animals step up and over the fence)' : '', gate.length ? 'GATE OPEN at ' + gate.map(g => g.join(',')).join(' ') : '', st && st.missing ? st.missing + ' fence cells missing (' + st.examples.slice(0, 2).join(', ') + ')' : ''].filter(Boolean).join('; ') || 'none from above - watch the gate while a herder passes') +
        ' -> flatten the pen floor, remove the blocks, re-activate the pen build for the fence; the herd job brings the animals back' })
  }

  // ---------- c2. FLOATING TREE REMAINS (owner 09-20: "floating trees got better, but bits remain over the fields") ----------
  // `level` clears 4 cells of headroom, lumber takes the trunk: what hangs above (a log stump keeps its leaf clump alive for ever) stays in the air, shades the wheat and looks
  // like nobody cares. Per column of the base box (outside keep-outs and the tree-farm / lumber zones): leaf/log blocks above the level; columns are flooded into clusters;
  // a cluster WITHOUT a rooted trunk is floating as a whole, of a rooted tree only the columns that hang over a finished pad / road / field footprint count.
  // -> `floats` in base_audit.json = work units of job type `tidy` (kind float: taken down top-down, short scaffold, never in the tree farm). Routine kind: no escalation.
  const floats = []
  { const treeZone = P.farms.filter(f => f.type === 'lumber').map(f => grow(f.box, 2)).concat(P.builds.filter(b => b.blueprint === 'tree_farm').map(b => grow(b.bbox, 2)))
    const okCol = i => { if (!trN[i] || !(cls[i] & 16)) return false; const x = box[0] + i % bw; const z = box[1] + (i - i % bw) / bw; return !P.keepOut.some(k => inBox(k.box, x, z)) && !treeZone.some(q => inBox(q, x, z)) }
    const seenT = new Uint8Array(bw * bdp)
    for (let i = 0; i < bw * bdp; i++) {
      if (seenT[i] || !okCol(i)) continue
      const q = [i]; seenT[i] = 1; const mem = []; let rooted = false
      while (q.length) { const j = q.pop(); mem.push(j); if (trRoot[j]) rooted = true; const x = j % bw; const z = (j - x) / bw; for (const [a, b] of N8) { const X = x + a; const Z = z + b; if (X < 0 || Z < 0 || X >= bw || Z >= bdp) continue; const k = Z * bw + X; if (seenT[k] || !okCol(k)) continue; seenT[k] = 1; q.push(k) } }
      const bad = rooted ? mem.filter(j => (cls[j] & 15) === 1) : mem; if (!bad.length) continue
      let sx = 0; let sz = 0; let lo = 999; let hi = -999; let n = 0; const cols = []
      for (const j of bad) { const x = box[0] + j % bw; const z = box[1] + (j - j % bw) / bw; sx += x; sz += z; lo = Math.min(lo, trLo[j]); hi = Math.max(hi, trHi[j]); n += trN[j]; if (cols.length < 120) cols.push([x, z, trLo[j], trHi[j]]) }
      const cx = Math.round(sx / bad.length); const cz = Math.round(sz / bad.length)
      floats.push({ x: cx, z: cz, y: lo, top: hi, n, columns: bad.length, rooted, zone: whereOf(P, cx, cz), cols })
    }
    floats.sort((a, b) => b.n - a.n)
    const nBlocks = floats.reduce((m, c) => m + c.n, 0); const was = prev && prev.floatN != null ? prev.floatN : null
    say({ ev: 'audit_floating', key: '', alert: floats.length > 0, n: nBlocks, clustersN: floats.length, was, clusters: floats.slice(0, 12).map(c => ({ x: c.x, z: c.z, y: c.y, n: c.n, zone: c.zone, rooted: c.rooted })),
      text: 'FLOATING TREE REMAINS: ' + nBlocks + ' leaf/log blocks in ' + floats.length + ' clusters hang in the air or over finished pads / roads / fields inside the base' + (was != null ? ' (' + was + ' clusters at the last audit)' : '') + ': ' + floats.slice(0, 8).map(c => c.x + ',' + c.z + ' y' + c.y + '-' + c.top + ' x' + c.n + (c.rooted ? ' overhang' : '') + ' (' + c.zone + ')').join(' · ') + ' -> work units of the tidy sponge (kind float); a cluster that returns = a level / lumber job leaves crowns behind (docs/BUGS.md)' }) }

  // ---------- d. GROWTH + LOADED CHUNKS ----------
  const loaded = loadedShare(P.farms); const growthState = {}
  for (const f of P.farms) {
    const map = crops[f.id].map.join(''); const pg = prev && prev.growth && prev.growth[f.id]; const max = f.type === 'cane' ? 3 : 7; let planted = 0; let ripe = 0; let bare = 0; let unseen = 0; let hsum = 0
    for (const ch of map) { if (ch === '?') unseen++; else if (ch === 'f') bare++; else if (ch === 's') planted++; else if (ch === 'T') { planted++; ripe++ } else if (ch >= '0' && ch <= '9') { planted++; hsum += +ch; if (+ch >= (f.type === 'cane' ? 2 : max)) ripe++ } }
    let grew = null; let stay = null; let cut = null; let dtMin = null
    if (pg && pg.map && pg.map.length === map.length) { grew = 0; stay = 0; cut = 0; dtMin = Math.round((T0 - pg.t) / 60000); for (let i = 0; i < map.length; i++) { const a = pg.map[i]; const b = map[i]; if (a === '?' || b === '?' || a === '.' || a === 'f') continue; const va = a === 's' ? 0 : a === 'T' ? 9 : +a; const vb = b === 's' ? 0 : b === 'T' ? 9 : (b === '.' || b === 'f') ? -1 : +b; if (vb > va) grew++; else if (vb < va) cut++; else if (va < max && a !== 'T') stay++ } }
    const L = loaded[f.id] || {}; const grewShare = grew != null && grew + stay > 0 ? +(grew / (grew + stay)).toFixed(2) : null
    // SLOW GROWERS ARE JUDGED AGAINST THEIR OWN CLOCK (foreman 09-20 07:20Z: "wood_spawn ... ripe 80 %, 3 grew / 45 stood still = PLANTED BUT NO GROWTH for 60 min" - a sapling
    // takes 20-60+ min and 80 % of the plot were grown trees waiting for 2 lumberjacks): expected share of the unripe plants that grows in dt = (1 - e^(-dt/tau)) x the
    // share of the time the chunks were loaded; tau = 18 min per cane block, 45 min per sapling. A sample counts as stalled below a quarter of that; a tree farm must
    // stall for 3 h, cane 90 min (wheat as before: < 10 % in >= 20 min, 55 min). A lumber plot with ripe share >= 50 % NEVER alerts: that is a HARVEST BACKLOG (`backlog:true`).
    const tau = f.type === 'cane' ? 18 : f.type === 'lumber' ? 45 : null; const expShare = tau && dtMin != null ? +((1 - Math.exp(-dtMin / tau)) * (L.share != null ? L.share : 1)).toFixed(2) : null
    const slowSample = grewShare != null && (tau ? grewShare < 0.25 * expShare && (grew + stay) * expShare >= 4 : grewShare < 0.1)
    let stallSince = null; if (grewShare != null && dtMin >= 20 && grew + stay >= 20 && slowSample) stallSince = pg.stallSince || pg.t
    else if (grewShare != null && dtMin < 20) stallSince = pg.stallSince || null
    const backlog = f.type === 'lumber' && planted > 0 && ripe / planted >= 0.5
    const stalled = !backlog && stallSince && T0 - stallSince >= (f.type === 'lumber' ? 180 : f.type === 'cane' ? 90 : 55) * 60000; const unloaded = L.share != null && (L.share < 0.5 || L.worst < 0.25); const cx = Math.round((f.box[0] + f.box[2]) / 2); const cz = Math.round((f.box[1] + f.box[3]) / 2)
    growthState[f.id] = { t: T0, map, stallSince }
    const distBase = Math.round(Math.hypot(cx - (P.S.muster || P.S.base).x, cz - (P.S.muster || P.S.base).z))
    say({ ev: 'audit_growth', key: f.id, job: f.id, type: f.type, alert: !!(unloaded || stalled) && planted > 0 && !backlog, backlog, expShare, loadedShare: L.share, loadedWorstCorner: L.worst, samples: L.samples, planted, bare, ripeShare: planted ? +(ripe / planted).toFixed(2) : null, mean: planted ? +(hsum / planted).toFixed(1) : null, grew, stay, cut, grewShare, dtMin, distBase, unseen,
      text: 'GROWTH ' + f.id + ' (' + f.type + ', centre ' + cx + ',' + cz + ', ' + distBase + ' blocks from muster): chunks LOADED ' + (L.share == null ? 'n/a' : Math.round(L.share * 100) + ' %' + (L.worst < L.share ? ' (worst corner ' + Math.round(L.worst * 100) + ' %)' : '')) + ' of the last hour (a bot within 128), ' + planted + ' plants' + (f.type !== 'lumber' ? ', ' + bare + ' bare farmland' : '') + ', ripe ' + (planted ? Math.round(100 * ripe / planted) : 0) + ' %' + (grew != null ? ', in ' + dtMin + ' min: ' + grew + ' grew / ' + stay + ' stood still / ' + cut + ' cut' : ', first sample') +
        (expShare != null && grew != null ? ' (expected to grow in that time: ~' + Math.round(expShare * 100) + ' % of the unripe)' : '') + (backlog ? ' = backlog: ' + ripe + ' grown trees stand waiting for the lumberjacks (HARVEST backlog, not a growth problem; raise the lumber job\'s bots when logs are wanted)' : '') +
        (unloaded && !backlog ? ' = CROPS DO NOT GROW IN UNLOADED CHUNKS: move the farm into the base (where bots always are) or keep a squad there round the clock' : '') + (stalled ? ' = PLANTED BUT NO GROWTH for ' + Math.round((T0 - stallSince) / 60000) + ' min (light? water? chunks?)' : '') })
  }

  // ---------- e. FURNITURE ----------
  const fk = {}; for (const m of furnMissing) fk[m.kind.split(':')[0]] = (fk[m.kind.split(':')[0]] || 0) + 1
  say({ ev: 'audit_furniture', key: '', alert: furnMissing.length > 0, registered: P.furniture.length, seen: furnSeen, missing: furnMissing.slice(0, 20).map(m => m.kind + '@' + m.at.join(',') + '=' + m.have), n: furnMissing.length,
    text: 'FURNITURE REGISTERED BUT NOT STANDING: ' + furnMissing.length + ' of ' + P.furniture.length + ' (' + Object.entries(fk).map(([k, n]) => k + ' ' + n).join(', ') + '): ' + furnMissing.slice(0, 8).map(m => m.kind + ' ' + m.at.join(',') + ' is ' + m.have).join(' | ') + ' -> the books count furniture that is air: re-place it (`steps` place, or re-activate the build job that owns it) or drop the entry from settings' })

  // ---------- f. FIELDS ----------
  for (const b of P.builds) {
    if (b.blueprint !== 'field_block') continue; const r = { holes: 0, raised: 0, untilled: 0, junk: 0, soil: 0, planted: 0, ex: [] }
    const junkAt = new Set(stray.filter(s => inBox(b.bbox, s[0], s[2])).map(s => s[0] + ',' + s[2])); r.junk = junkAt.size
    for (const c of b.cells) {
      if (!c.soil || !inBox(box, c.x, c.z)) continue; const i = (c.z - box[1]) * bw + c.x - box[0]; if (!(cls[i] & 16)) continue; r.soil++
      const at = names[lvlN[i]]; const up = names[upN[i]]; const note = k => { r[k]++; if (r.ex.length < 4) r.ex.push(k + ' ' + c.x + ',' + c.z) }
      if (dy[i] > 0 || (up !== 'air' && GROUNDISH.test(up))) note('raised'); else if (at === 'farmland') { if (CROPS[up] != null) r.planted++ } else if (SOILS.test(at)) note('untilled'); else if (at === 'air' || at === 'water' || dy[i] < 0) note('holes'); else note('untilled')
    }
    if (!r.soil) continue; const bad = r.holes + r.raised + r.untilled + r.junk
    say({ ev: 'audit_field', key: b.id, job: b.id, status: b.status, alert: b.status !== 'active' && (r.holes + r.raised + r.junk >= 3 || bad >= r.soil * 0.05), holes: r.holes, raised: r.raised, untilled: r.untilled, junk: r.junk, soil: r.soil, planted: r.planted, examples: r.ex,
      text: 'FIELD ' + b.id + ' (x ' + b.bbox[0] + '..' + b.bbox[2] + ' / z ' + b.bbox[1] + '..' + b.bbox[3] + '): of ' + r.soil + ' soil tiles ' + r.holes + ' holes, ' + r.raised + ' raised, ' + r.untilled + ' not tilled (dirt/grass), ' + r.junk + ' with junk on top; ' + r.planted + ' planted (' + r.ex.join(' | ') + ') -> a field is ONE flat sheet of farmland: re-activate its build job (= the repair), the farm job tills and plants the rest' })
  }

  // ---------- g. STRUCTURES ----------
  for (const st of structs.values()) {
    if (!st.of || st.seen < st.of * 0.8) continue; const bad = st.missing + st.wrong; if (!bad) continue
    const unbuilt = bad >= st.seen * 0.9; const idle = st.status !== 'active'
    say({ ev: 'audit_structure', key: st.job, job: st.job, status: st.status, blueprint: st.blueprint, alert: idle && bad >= 3 && !unbuilt, unbuilt, missing: st.missing, wrong: st.wrong, of: st.of, examples: st.examples,
      text: 'STRUCTURE ' + st.job + ' (' + st.blueprint + ', job ' + st.status + '): ' + (unbuilt ? 'NOT BUILT (' + bad + ' of ' + st.of + ' cells) - planned, and nobody is building it' : st.missing + ' cells MISSING + ' + st.wrong + ' wrong of ' + st.of + ' (' + st.examples.slice(0, 3).join(', ') + ')') + ' -> ' + (st.status === 'active' ? 'still being built' : 'plan and world differ while no job works on it (a hole in a wall/fence lets mobs in and animals out): `armyctl.js job ' + st.job + ' active` (archived? `putjson` it back from attic/jobs-archive.jsonl) = the repair, never a second job; the world is right and the blueprint changed? then say so in docs/BUGS.md') })
  }

  // ---------- h. PRODUCTIVITY ----------
  try { say(productivity(60)) } catch (e) { console.log('productivity: ' + e.message) }

  // fresh = an alert that was not one at the last audit, or that got clearly worse
  const size = f => f.ev === 'audit_rough' ? f.columns : f.ev === 'audit_floating' ? f.clustersN : f.ev === 'audit_stray' ? f.n : f.ev === 'audit_pen' ? f.outside : f.ev === 'audit_furniture' ? f.n : f.ev === 'audit_field' ? f.holes + f.raised + f.junk + f.untilled : f.ev === 'audit_structure' ? f.missing + f.wrong : f.ev === 'audit_idle' ? Math.round(f.standingShare * 100) : 0
  for (const f of findings) { const p = prevAlert.get(f.ev + '|' + (f.key || '')); f.fresh = !!f.alert && (!p || size(f) > size(p) * 1.25 + 2) }

  // ---------- the PICTURE ----------
  const LM = 26; const TM = 8; const G = painter(pw * PX + LM, ph * PX + TM); const X = x => LM + (x - pic[0]) * PX; const Z = z => TM + (z - pic[1]) * PX
  for (let z = pic[1]; z <= pic[3]; z++) {
    for (let x = pic[0]; x <= pic[2]; x++) {
      const pi = (z - pic[1]) * pw + x - pic[0]; if (topY[pi] === -999) continue; const n = names[topN[pi]]; let c = SKY.colour(n); const inside = inBox(box, x, z); const bi = inside ? (z - box[1]) * bw + x - box[0] : -1
      const k = Math.max(0.45, Math.min(1, 0.75 + (topY[pi] - level) * 0.04)); c = c.map(v => Math.round(v * k)); if (!inside || (cls[bi] & 15) === 0) c = c.map(v => Math.round(v * 0.6))
      if (/farmland/.test(n)) c = [96, 66, 40]; if (CROPS[n] != null) c = [190, 170, 60]; if (/torch/.test(n)) c = c.map(v => Math.round(v * 0.9))
      if (inside && (cls[bi] & 15) !== 2 && (cls[bi] & 15) !== 0 && dy[bi]) c = dy[bi] > 0 ? [255, Math.max(0, 110 - 50 * dy[bi]), Math.max(0, 90 - 45 * dy[bi])] : [Math.max(0, 70 + 25 * dy[bi]), Math.max(0, 120 + 30 * dy[bi]), 255]
      G.rect(X(x), Z(z), PX, PX, c)
    }
  }
  for (const k of P.keepOut) for (let z = k.box[1]; z <= k.box[3]; z++) for (let x = k.box[0]; x <= k.box[2]; x++) if ((x + z) % 4 === 0) G.px(X(x), Z(z), [0, 0, 0])
  for (let x = Math.ceil(pic[0] / 16) * 16; x <= pic[2]; x += 16) { for (let y = TM; y < G.h; y += (x % 64 ? 4 : 2)) G.px(X(x), y, [255, 255, 255]); if (x % 32 === 0) G.text(X(x) + 2, 1, x, [255, 255, 0]) }
  for (let z = Math.ceil(pic[1] / 16) * 16; z <= pic[3]; z += 16) { for (let x = LM; x < G.w; x += (z % 64 ? 4 : 2)) G.px(x, Z(z), [255, 255, 255]); if (z % 32 === 0) G.text(1, Z(z) + 2, z, [255, 255, 0]) }
  G.frame(X(box[0]) - 1, Z(box[1]) - 1, bw * PX + 2, bdp * PX + 2, [255, 255, 0])
  for (const p of P.pens) G.frame(X(p.box[0]) - 1, Z(p.box[1]) - 1, (p.box[2] - p.box[0] + 1) * PX + 2, (p.box[3] - p.box[1] + 1) * PX + 2, [255, 255, 255])
  for (const f of P.farms) G.frame(X(f.box[0]) - 1, Z(f.box[1]) - 1, (f.box[2] - f.box[0] + 1) * PX + 2, (f.box[3] - f.box[1] + 1) * PX + 2, [120, 255, 120])
  for (const st of structs.values()) if (st.status !== 'active') for (const [x, z] of st.marks) { G.rect(X(x) - 1, Z(z) - 1, PX + 2, PX + 2, [0, 0, 0]); G.rect(X(x), Z(z), PX, PX, [255, 235, 0]) }
  for (const m of furnMissing) { G.rect(X(m.at[0]) - 1, Z(m.at[2]) - 1, PX + 2, PX + 2, [0, 0, 0]); G.rect(X(m.at[0]), Z(m.at[2]), PX, PX, [255, 235, 0]) }
  for (const s of stray) { G.rect(X(s[0]) - 1, Z(s[2]) - 1, PX + 2, PX + 2, [0, 0, 0]); G.rect(X(s[0]), Z(s[2]), PX, PX, [255, 0, 255]) }
  for (const e of flown.ents.values()) { const c = e.type === 'player' ? [0, 255, 255] : inAnyPen(e) ? [255, 255, 255] : [255, 140, 0]; if (e.type === 'player' && e.y < level - 8) continue; G.rect(X(e.x) - 1, Z(e.z) - 1, PX + 2, PX + 2, [0, 0, 0]); G.rect(X(e.x), Z(e.z), PX, PX, c) }
  fs.writeFileSync(OUT, SKY.png(G.w, G.h, G.img))
  const legend = OUT + ' (' + G.w + 'x' + G.h + ' px, ' + PX + ' px = 1 block, north up, x ' + pic[0] + '..' + pic[2] + ' / z ' + pic[1] + '..' + pic[3] + ', yellow numbers = coordinates every 32, dotted grid every 16): yellow frame = the wall line; bright = levelled/claimed ground, dim = wild; RED = ground ABOVE the base level y' + level + ' (darker = higher), BLUE = hole/water below it, MAGENTA = stray placed block, YELLOW = blueprint cell / registered furniture that is missing, white frame = pen, green frame = farm box, WHITE dot = animal inside a pen, ORANGE dot = animal outside, CYAN = bot, hatched = keep-out'

  // ---------- out ----------
  const alerts = findings.filter(f => f.alert); const took = Math.round((Date.now() - T0) / 1000); const partial = flown.hovers.filter(h => !h.ok).length
  const state = { t: T0, took, level, box, png: OUT, legend, hovers: flown.hovers.length, partial, unseen: count.unseen, findings, rough: { columns: rough, onPads, unlevelled: wildCols }, clustersAll: defects.slice(0, 400).map(c => c.slice(0, 4)), work, surface: surfaceStat, weeds: weeds.slice(0, 6000).map(w => w.slice(0, 3)), weedN: weeds.length, floats, floatN: floats.length, strays: stray.slice(0, 400), strayN: stray.length, pens: pensOut, growth: growthState,
    prev: prev ? { t: prev.t, rough: prev.rough, strayN: prev.strayN, floatN: prev.floatN, pens: prev.pens, findings: (prev.findings || []).map(f => ({ ev: f.ev, key: f.key, alert: f.alert, text: f.text })) } : null }
  if (!DRY) {
    const tmp = STATE + '.tmp' + process.pid; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE)
    const lines = alerts.map(f => { const { key, ev, job, alert, fresh, text, ...rest } = f; return JSON.stringify(Object.assign({ t: Date.now(), bot: 'audit', ev }, job ? { job } : {}, { fresh, msg: text.split(' -> ')[0].slice(0, 150) }, rest, { alert, text })) }) // msg first: `armyctl.js events` prints the first 160 chars
    lines.push(JSON.stringify({ t: Date.now(), bot: 'audit', ev: 'audit_done', alerts: alerts.length, fresh: alerts.filter(f => f.fresh).length, s: took, partial, png: OUT }))
    fs.appendFileSync(RESULTS, lines.join('\n') + '\n')
  }
  console.log('BASE AUDIT ' + new Date(T0).toISOString().slice(0, 16) + 'Z: ' + alerts.length + ' alert(s) (' + alerts.filter(f => f.fresh).length + ' new), ' + flown.hovers.length + ' hovers' + (partial ? ' (' + partial + ' PARTIAL)' : '') + ', ' + count.unseen + ' columns unseen, ' + animals.length + ' animals, ' + took + ' s' + (DRY ? ' [dry: nothing written]' : ''))
  for (const f of findings) if (f.alert || argv.includes('--all')) console.log((f.alert ? (f.fresh ? '! NEW ' : '! ') : '  ok  ') + f.text)
  const quiet = findings.filter(f => !f.alert); if (quiet.length && !argv.includes('--all')) console.log('ok (' + quiet.length + ', --all shows them): ' + quiet.map(f => f.ev.replace('audit_', '') + (f.key ? ' ' + f.key : '')).join(' · '))
  console.log('PICTURE ' + legend)
}
main().then(() => setTimeout(() => process.exit(0), 300)).catch(e => { console.log('base-audit failed: ' + (e.stack || e.message || e)); setTimeout(() => process.exit(1), 300) })
