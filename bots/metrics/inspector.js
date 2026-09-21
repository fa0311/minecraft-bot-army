#!/usr/bin/env node
/* LLM-free observability daemon for the bot army.  OUTPUT-first KPIs (docs/GOALS.md rev3).
 * Samples GET /status + /events every ~30 s, keeps a compact time series in
 * bots/metrics/samples-YYYYMMDD.jsonl, and refreshes REPORT.md + metrics/latest.json every minute.
 *
 * The central measurement is BANKING: when a bot's inventory shrinks while it stands within ~6
 * blocks of a registered chest, those items were deposited -> that is real output. Everything
 * else (distance, task labels) is motion, and is reported only as a cost per banked item.
 * Read-only: the only POST is a read-only eval probe for the in-water flag.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const WS = '/root/workspace'
const BOTS = path.join(WS, 'bots')
const MET = path.join(BOTS, 'metrics')
const API = { host: '127.0.0.1', port: 3000 }
const TICK = 30000
const KEEP = 34

fs.mkdirSync(MET, { recursive: true })

// ---------- helpers ----------
const now = () => Date.now()
function req (method, p, body, ms = 20000) {
  return new Promise(resolve => {
    const r = http.request({ ...API, method, path: p, headers: { 'content-type': 'application/json' } }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(null) } })
    })
    r.on('error', () => resolve(null))
    r.setTimeout(ms, () => { try { r.destroy() } catch {} resolve(null) })
    r.end(body ? JSON.stringify(body) : undefined)
  })
}
function readJSON (f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return dflt } }
function writeAtomic (f, s) { const t = f + '.tmp' + process.pid; fs.writeFileSync(t, s); fs.renameSync(t, f) }
function hash (s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h }
const fix = (n, d = 1) => +(+n || 0).toFixed(d)
const pad = (s, n) => String(s).length >= n ? String(s).slice(0, n) : String(s) + ' '.repeat(n - String(s).length)
const lpad = (s, n) => String(s).length >= n ? String(s).slice(0, n) : ' '.repeat(n - String(s).length) + String(s)
function log (m) { try { fs.appendFileSync(path.join(MET, 'inspector.log'), new Date().toISOString() + ' ' + m + '\n') } catch {} }

// ---------- config ----------
// ONE ARMY: there are no teams any more — rows are grouped by the JOB each bot currently holds on the army board
// (worker heartbeats, bots/army/hb/<bot>.json). Function/field names keep saying "team" so the report code stays unchanged.
function teams () {
  const of = {}
  const dir = path.join(BOTS, 'army', 'hb')
  let files = []
  try { files = fs.readdirSync(dir) } catch {}
  for (const f of files) {
    const h = readJSON(path.join(dir, f), null)
    if (h && h.bot) of[h.bot] = (Date.now() - (h.t || 0) < 180000 && h.job) ? h.job : 'offline'
  }
  const list = [...new Set(Object.values(of))].sort()
  return { list, of, def: Object.fromEntries(list.map(j => [j, { bots: Object.keys(of).filter(b => of[b] === j) }])) }
}
// every registered container in the world, tagged by role. The ARMY registry (jobs.json settings.chests: depot chests + warehouse
// barrels, categories food/tools/ores/build/salvage) is the truth and goes first; the pre-army files only add what it does not know.
// (Until 09-19 base.json went first and tagged everything 'base' unless x === -42, so the depot FOOD chest never counted as food.)
function armySettings () { return (readJSON(path.join(BOTS, 'army', 'jobs.json'), {}).settings) || {} }
function chestSites () {
  const out = []
  const seen = new Set()
  const add = (x, y, z, kind) => { const k = x + ',' + y + ',' + z; if (seen.has(k)) return; seen.add(k); out.push({ x, y, z, kind }) }
  for (const [cat, list] of Object.entries(armySettings().chests || {})) for (const c of (list || [])) add(c[0], c[1], c[2], cat === 'food' ? 'food' : (cat === 'build' ? 'build' : 'base'))
  const b = readJSON(path.join(BOTS, 'base.json'), {})
  for (const c of (b.chests || [])) add(c.x, c.y, c.z, 'base')
  return out
}

// ---------- state ----------
const STATE_F = path.join(MET, 'state.json')
let S = readJSON(STATE_F, null) || {}
S.lastEventId = S.lastEventId || 0
S.bots = S.bots || {}
S.startedAt = S.startedAt || now()
S.buildSeen = S.buildSeen || {}
delete S.bankLog                // retired: deposits come from the army ledger now (LEDGER below)
S.placeLog = S.placeLog || []  // [t, bot, team, item, n]
S.visitLog = S.visitLog || []  // [t, bot, banked01]
S.minY = S.minY || {}
const hist = []

function bs (n) {
  if (!S.bots[n]) S.bots[n] = { invHash: 0, invChangedAt: now(), deaths: [], kicks: [], spawns: [], taskChanges: [], lastTask: '', water: 0, waterSince: 0, deathSpots: [] }
  return S.bots[n]
}
function prune (arr, ms) { const c = now() - ms; while (arr.length && arr[0] < c) arr.shift(); return arr }
function pruneRows (arr, ms) { const c = now() - ms; let i = 0; while (i < arr.length && arr[i][0] < c) i++; return arr.slice(i) }

const EDIBLE = /^(bread|cooked_\w+|golden_apple|golden_carrot|apple|sweet_berries|carrot|potato|baked_potato|melon_slice|dried_kelp|rabbit_stew|mushroom_stew|beetroot_soup|cookie|beetroot|glow_berries|pumpkin_pie)$/
const RAW_FOOD = /^(cod|salmon|beef|porkchop|chicken|mutton|rabbit)$/ // ingredients: become edible in a furnace

// ---------- the army's own ledger (bots/army/results.jsonl) ----------
// Bots REPORT what they deposit (`banked {items}`), bake (`cooked {raw:'wheat->bread', n}`) and draw to eat (`canteen {item, n}`).
// That is the ground truth for food; the 30 s inventory diff below cannot see a quartermaster who withdraws wheat, bakes and banks
// the bread between two samples (09-19: report said 27 edible/2 h while 387 bread were baked and 290 berries banked).
function armyEvents (minutes) {
  const f = path.join(BOTS, 'army', 'results.jsonl')
  const cut = now() - minutes * 60000
  let fd
  try { fd = fs.openSync(f, 'r') } catch { return [] }
  try {
    const size = fs.fstatSync(fd).size
    let len = Math.min(size, 1 << 20)
    for (;;) {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      const lines = buf.toString('utf8').split('\n')
      if (len < size) lines.shift() // partial first line
      const rows = []
      let first = null
      for (const l of lines) {
        if (!l) continue
        let e; try { e = JSON.parse(l) } catch { continue }
        if (!e || typeof e.t !== 'number') continue
        if (first == null) first = e.t
        if (e.t >= cut) rows.push(e)
      }
      if (len >= size || (first != null && first < cut) || len >= (32 << 20)) return rows
      len = Math.min(size, len * 2)
    }
  } catch (e) { log('armyEvents: ' + e.message); return [] } finally { try { fs.closeSync(fd) } catch {} }
}
// Bot deaths of the last hour. COUNT = the bots' own `death` reports; CAUSE = server/console.log with colour codes and the team prefix
// stripped (since the `army` team got its coloured "[BOT] " prefix on 09-19 ~09:45 a death line no longer starts with the bot's name, so
// every parser anchored on the name counted 0 deaths while bots kept dying).
function deathLedger (ev) {
  const cut = now() - 3600000
  const D = { n1h: 0, byCause: {}, byJob: {}, logSeen: 0 }
  for (const e of ev) if (e.ev === 'death' && e.t >= cut) { D.n1h++; const j = e.job || '-'; D.byJob[j] = (D.byJob[j] || 0) + 1 }
  try {
    const roster = new Set(armySettings().roster || [])
    const f = path.join(WS, 'server', 'console.log')
    const fd = fs.openSync(f, 'r')
    try {
      const size = fs.fstatSync(fd).size; const len = Math.min(size, 768 * 1024)
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len)
      for (const raw of buf.toString('latin1').split('\n')) {
        const m = /^\[(\d\d):(\d\d):(\d\d) INFO\]: (\w+) (.*)$/.exec(raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/INFO\]: \[[^\]]{1,24}\] /, 'INFO]: '))
        if (!m || !roster.has(m[4])) continue
        const rest = m[5].replace(/ using .*/, '').trim()
        let cause = null
        if (/^was killed$/.test(rest)) cause = 'rescue kill'
        else if (/^suffocated|^was squished/.test(rest)) cause = 'suffocated'
        else if (/^(fell|hit the ground|was doomed to fall|experienced kinetic)/.test(rest)) cause = 'fall'
        else if (/^drowned/.test(rest)) cause = 'drowned'
        else if (/^starved/.test(rest)) cause = 'starved'
        else if (/lava|burned|flames|fire/.test(rest)) cause = 'fire/lava'
        else if (/^froze/.test(rest)) cause = 'froze'
        else { const by = /^(?:was|got) .* by (.+)$/.exec(rest); if (by) cause = by[1].trim() }
        if (!cause) continue
        const t = new Date(); t.setUTCHours(+m[1], +m[2], +m[3], 0); if (+t > now() + 60000) t.setTime(+t - 86400000) // log stamps = server clock (UTC here)
        if (+t < cut) continue
        D.logSeen++; D.byCause[cause] = (D.byCause[cause] || 0) + 1
      }
    } finally { fs.closeSync(fd) }
  } catch (e) { log('deathLedger: ' + e.message) }
  D.n1h = Math.max(D.n1h, D.logSeen)
  return D
}
function chestIndex () { return readJSON(path.join(BOTS, 'army', 'chests.json'), {}) }
function stockIn (idx, re) {
  const items = {}; let total = 0
  for (const v of Object.values(idx)) for (const [k, n] of Object.entries((v && v.items) || {})) if (re.test(k)) { items[k] = (items[k] || 0) + n; total += n }
  return { items, total }
}
// NEW edible food per window. Bread (and anything else with `cooked` events) counts where it is MADE — bread banked by other jobs is a
// returned ration, not production. Other edibles count when banked, minus what the same bot drew from the canteen before (returns).
function foodLedger (ev) {
  const t30 = now() - 1800000; const t60 = now() - 3600000
  const L = { made30: {}, made2h: {}, made30n: 0, made2hn: 0, drawn30: 0, drawn2h: 0, wheat1h: 0, raw1h: 0, breadIn30: 0 }
  const made = (t, item, n) => { if (!(n > 0)) return; L.made2h[item] = (L.made2h[item] || 0) + n; L.made2hn += n; if (t >= t30) { L.made30[item] = (L.made30[item] || 0) + n; L.made30n += n } }
  const cookedItem = e => String(e.raw || '').includes('->') ? String(e.raw).split('->')[1] : 'cooked_' + e.raw
  const viaCooked = new Set(['bread'])
  for (const e of ev) if (e.ev === 'cooked' && e.n > 0) viaCooked.add(cookedItem(e))
  const credit = {}
  for (const e of ev) {
    if (e.ev === 'cooked') made(e.t, cookedItem(e), +e.n || 0)
    else if (e.ev === 'canteen') {
      const n = +e.n || 0
      L.drawn2h += n; if (e.t >= t30) L.drawn30 += n
      const c = credit[e.bot] = credit[e.bot] || {}; c[e.item] = (c[e.item] || 0) + n
    } else if (e.ev === 'banked') {
      for (const [item, n0] of Object.entries(e.items || {})) {
        if (e.t >= t60 && e.job !== 'qm_scan') { if (item === 'wheat') L.wheat1h += n0; else if (RAW_FOOD.test(item)) L.raw1h += n0 }
        const c = credit[e.bot] || {}
        // bread that ANY job put into the chests in 30 min (net of what the bot drew before): not production (hauls move it twice), but proof that baking
        // is alive - the WHEAT NOT BAKED headline fired for hours while the bake_bread plan banked 2500 loaves/h, because only qm_scan reports `cooked` (09-20)
        if (item === 'bread' && e.t >= t30) L.breadIn30 += Math.max(0, n0 - (c[item] || 0))
        if (!EDIBLE.test(item) || viaCooked.has(item)) continue
        const back = Math.min(c[item] || 0, n0)
        if (back) c[item] -= back
        made(e.t, item, n0 - back)
      }
    }
  }
  return L
}

// ---------- sampling ----------
async function sample (probeWater) {
  const t0 = now()
  const st = await req('GET', '/status', null, 28000)
  S.apiMs = now() - t0
  if (!Array.isArray(st)) { S.apiFails = (S.apiFails || 0) + 1; log('status unavailable (' + S.apiMs + 'ms)'); return null }
  S.apiFails = 0
  const ev = await req('GET', '/events?since=' + S.lastEventId, null, 25000)
  const T = teams()
  const snap = { t: now(), b: {} }
  const diedNow = new Set()
  if (Array.isArray(ev)) {
    for (const e of ev) {
      if (e.id > S.lastEventId) S.lastEventId = e.id
      const r = e.bot ? bs(e.bot) : null
      if (!r) continue
      const et = Date.parse(e.t) || snap.t
      if (e.type === 'death') {
        r.deaths.push(et); diedNow.add(e.bot)
        const last = hist.length ? hist[hist.length - 1].b[e.bot] : null
        if (last && last.online) r.deathSpots.push([Math.round(last.x), Math.round(last.y), Math.round(last.z), et])
        if (r.deathSpots.length > 12) r.deathSpots.splice(0, r.deathSpots.length - 12)
      } else if (e.type === 'kicked') { r.kicks.push(et); diedNow.add(e.bot) } else if (e.type === 'end' && !/socketClosed/.test(String(e.reason || ''))) r.kicks.push(et)
      else if (e.type === 'spawn') { r.spawns.push(et); diedNow.add(e.bot) }
    }
  }
  for (const n of Object.keys(S.bots)) { const r = S.bots[n]; prune(r.deaths, 3600000); prune(r.kicks, 3600000); prune(r.spawns, 3600000) }

  const sites = chestSites()
  const prev = hist.length ? hist[hist.length - 1] : null
  for (const b of st) {
    const n = b.name
    const r = bs(n)
    if (!b.online) { snap.b[n] = { online: false }; continue }
    const inv = b.inv || {}
    const ih = hash(Object.entries(inv).sort().map(([k, v]) => k + v).join(','))
    const invN = Object.values(inv).reduce((a, c) => a + c, 0)
    if (ih !== r.invHash) { r.invHash = ih; r.invChangedAt = snap.t }
    const task = String(b.task || 'idle')
    if (task !== r.lastTask) { r.lastTask = task; r.taskChanges.push(snap.t) }
    prune(r.taskChanges, 900000)
    const pos = { x: fix(b.pos.x), y: fix(b.pos.y), z: fix(b.pos.z) }
    if (!(n in S.minY) || pos.y < S.minY[n]) S.minY[n] = pos.y
    snap.b[n] = { online: true, ...pos, hp: fix(b.hp, 0), food: b.food, task, invH: ih, invN, inv, dim: b.dim }

    // --- BANKING / PLACEMENT detection ---
    const p = prev && prev.b[n]
    if (p && p.online && !diedNow.has(n)) {
      const moved = Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z)
      if (moved < 25) { // no respawn / teleport between the two samples
        let site = null; let best = 7
        for (const c of sites) { const d = Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z); if (d < best) { best = d; site = c } }
        const team = T.of[n] || '-'
        let bankedAny = 0
        for (const [item, was] of Object.entries(p.inv || {})) {
          const lost = was - (inv[item] || 0)
          if (lost <= 0) continue
          if (site) bankedAny += lost; else if (/^(torch|campfire|crafting_table|furnace|chest|lantern|fence|oak_fence|spruce_fence)$/.test(item)) {
            S.placeLog.push([snap.t, n, team, item, lost])
          }
        }
        if (site) S.visitLog.push([snap.t, n, bankedAny > 0 ? 1 : 0])
      }
    }
  }
  S.placeLog = pruneRows(S.placeLog, 7200000)
  S.visitLog = pruneRows(S.visitLog, 3600000)

  if (probeWater) {
    const w = await req('POST', '/cmd', { bots: 'all', action: 'eval', wait: true, args: { code: 'return (bot.entity && (bot.entity.isInWater || bot.entity.isInLava)) ? 1 : 0', timeout: 4000 } }, 15000)
    if (Array.isArray(w)) {
      for (const r0 of w) {
        if (!r0 || !r0.bot) continue
        const r = bs(r0.bot)
        if (r0.ok && r0.result === 1) { if (!r.water) r.waterSince = snap.t; r.water = 1 } else { r.water = 0; r.waterSince = 0 }
      }
    }
  }

  hist.push(snap)
  while (hist.length > KEEP) hist.shift()
  const line = { t: snap.t, b: {} }
  for (const [n, v] of Object.entries(snap.b)) line.b[n] = v.online ? [v.x, v.y, v.z, v.hp, v.food, v.task, v.invN, v.invH] : 0
  const f = path.join(MET, 'samples-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl')
  try { fs.appendFileSync(f, JSON.stringify(line) + '\n') } catch (e) { log('append: ' + e.message) }
  return snap
}

// ---------- derived ----------
const STEP_CAP = 60
function pathDist (name, minutes) {
  const cut = now() - minutes * 60000
  let d = 0; let prev = null
  for (const s of hist) {
    if (s.t < cut) { prev = s.b[name] && s.b[name].online ? s.b[name] : null; continue }
    const c = s.b[name]
    if (c && c.online && prev) { const dd = Math.hypot(c.x - prev.x, c.y - prev.y, c.z - prev.z); if (dd <= STEP_CAP) d += dd }
    prev = c && c.online ? c : null
  }
  return fix(d)
}
const IDLE_TASKS = /^(idle|)$|wait|:idle|standby|hello/i

// deposits = the bots' own `banked` reports (rows [t, bot, job, item, n], rebuilt from the ledger on every derive). The old source — a 30 s
// inventory diff near a chest, attributed to the job held at sample time — showed mega_farm 103 items/30 min while it banked 5736.
let LEDGER = []
function ledgerRows (ev, T) {
  const rows = []
  for (const e of ev) if (e.ev === 'banked') for (const [item, n] of Object.entries(e.items || {})) rows.push([e.t, e.bot, e.job || T.of[e.bot] || '-', item, +n || 0])
  return rows
}
const BULK = /^(cobblestone|cobbled_deepslate|dirt|granite|diorite|andesite|tuff|gravel|deepslate|stone|netherrack|calcite)$/
function banked (minutes, filter) {
  const cut = now() - minutes * 60000
  const items = {}
  let total = 0
  for (const [t, bot, team, item, n] of LEDGER) {
    if (t < cut) continue
    if (filter && !filter({ bot, team, item })) continue
    items[item] = (items[item] || 0) + n
    total += n
  }
  return { items, total }
}
function placed (minutes, item) {
  const cut = now() - minutes * 60000
  let n = 0
  for (const r of S.placeLog) if (r[0] >= cut && (!item || r[3] === item)) n += r[4]
  return n
}

function classify (n, cur, bankedBot) {
  const r = bs(n)
  if (!cur || !cur.online) return { cls: 'OFFLINE' }
  const d1 = pathDist(n, 1.2); const d5 = pathDist(n, 5); const d15 = pathDist(n, 15)
  const invAge = (now() - r.invChangedAt) / 60000
  const kicks15 = r.kicks.filter(t => t > now() - 900000).length
  const churn5 = r.taskChanges.filter(t => t > now() - 300000).length
  const water = r.water && (now() - r.waterSince) > 45000
  const warm = hist.length >= 6 && (now() - hist[0].t) > 170000
  let cls
  if (kicks15 >= 4 || churn5 >= 14) cls = 'FLAPPING'
  else if (!warm) cls = invAge < 5 ? 'WORKING' : (IDLE_TASKS.test(cur.task) ? 'IDLE' : 'TRAVELLING')
  else if (water && d5 < 4) cls = 'STUCK'
  else if (d5 < 3 && invAge > 5 && !IDLE_TASKS.test(cur.task)) cls = 'STUCK'
  else if (IDLE_TASKS.test(cur.task) && d5 < 8) cls = 'IDLE'
  else if (bankedBot > 0) cls = 'PRODUCING'
  else if (invAge < 5) cls = 'WORKING'
  else if (d1 > 4) cls = 'TRAVELLING'
  else if (d5 < 3) cls = 'STUCK'
  else cls = 'IDLE'
  return { cls, d1, d5, d15, invAge: fix(invAge), kicks15, churn5, water: !!water, deaths15: r.deaths.filter(t => t > now() - 900000).length }
}

function buildProgress () {
  const out = []
  const q = readJSON(path.join(BOTS, 'build_queue.json'), { jobs: [] })
  const q2 = readJSON(path.join(BOTS, 'team_build_b_queue.json'), { jobs: [] })
  const dir = path.join(BOTS, 'build_state')
  for (const j of [...(q.jobs || []), ...(q2.jobs || [])]) {
    const st = readJSON(path.join(dir, j.id + '.json'), null)
    let cells = 0; let done = 0; let claimed = 0; let blocks = 0; let blocksDone = 0; let fails = 0
    const cl = st && st.cells ? (Array.isArray(st.cells) ? st.cells : Object.values(st.cells)) : []
    for (const c of cl) {
      if (!c || typeof c !== 'object') continue
      cells++; const n = +c.n || 1; blocks += n
      const status = c.s || c.status
      if (status === 'done') { done++; blocksDone += n }
      if (c.by || c.claimedBy) claimed++
      if (+c.fails > 0) fails++
    }
    const pct = blocks ? Math.round(100 * blocksDone / blocks) : 0
    const prev = S.buildSeen[j.id]
    if (!prev || prev.done !== blocksDone) S.buildSeen[j.id] = { done: blocksDone, t: now() }
    out.push({ id: j.id, bp: j.blueprint, status: j.status, cells, done, claimed, blocks, blocksDone, fails, pct, stallMin: Math.round((now() - S.buildSeen[j.id].t) / 60000) })
  }
  return out
}

function gateBoards (invAll, ev) {
  const held = (re) => Object.entries(invAll).filter(([k]) => (re instanceof RegExp ? re.test(k) : k === re)).reduce((a, [, v]) => a + v, 0)
  const b60 = banked(60)
  const led = foodLedger(ev || [])
  const idx = chestIndex()
  const stock = stockIn(idx, EDIBLE)
  const base = readJSON(path.join(BOTS, 'base.json'), {})
  const T = teams()
  const depths = Object.entries(S.minY).filter(([n]) => T.of[n] === 'mining').map(([, y]) => y)
  const g1 = {
    string: { held: held('string'), banked1h: b60.items.string || 0 },
    seeds: { held: held(/^(wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds)$/), banked1h: b60.items.wheat_seeds || 0, stock: stockIn(idx, /_seeds$/).total }, // banked1h is churn (farmers re-deposit what they drew) — the report shows stock instead
    bones: { held: held(/^(bone|bone_meal)$/), banked1h: (b60.items.bone || 0) + (b60.items.bone_meal || 0) },
    rods: { held: held('fishing_rod'), banked1h: b60.items.fishing_rod || 0 },
    wool: { held: held(/wool$/) },
    beds: { held: held(/_bed$/), placed: (((readJSON(path.join(BOTS, 'army', 'jobs.json'), {}).settings) || {}).respawnBeds || []).length || (base.beds || []).length || ((readJSON(path.join(BOTS, 'army', 'jobs.json'), {}).jobs) || []).filter(j => j.type === 'sleeper' && j.params && j.params.bed).length }, // the army's bed lives on the board (sleeper job), not in the old base registry
    // field names kept for bots/metrics/watch.sh; the VALUES now come from the army ledger (foodLedger), not from the inventory diff
    edibleBanked30: led.made30n,
    edibleBanked2h: led.made2hn,
    made30: led.made30, breadIn30: led.breadIn30,
    made2h: led.made2h,
    edibleHeld: held(EDIBLE),
    edibleStock: stock.total, // in indexed containers (bots/army/chests.json) = what `armyctl.js stock` shows as depot
    stockItems: stock.items,
    inflowPerMin: fix(led.made30n / 30, 2),
    inflow2h: fix(led.made2hn / 120, 2),
    drawn30: led.drawn30,
    drawn2h: led.drawn2h,
    wheatStock: stockIn(idx, /^wheat$/).total,
    wheatHeld: held('wheat'),
    wheatBanked1h: led.wheat1h,
    rawStock: stockIn(idx, RAW_FOOD).total,
    rawBanked1h: led.raw1h,
    containers: Object.keys(idx).length,
    torchesPlaced1h: placed(60, 'torch'),
    campfires1h: placed(60, 'campfire'),
    hungry: 0
  }
  const g2 = {
    raw_iron: held('raw_iron'),
    ingots: held('iron_ingot'),
    ingotsBanked1h: b60.items.iron_ingot || 0,
    rawBanked1h: b60.items.raw_iron || 0,
    coal: held('coal'),
    shafts: depths.length ? Math.min(...depths) : null,
    deepestAny: Object.values(S.minY).length ? Math.min(...Object.values(S.minY)) : null,
    shields: held('shield'),
    ironTools: held(/^iron_(pickaxe|sword|axe|shovel)$/),
    ironArmour: held(/^iron_(helmet|chestplate|leggings|boots)$/),
    buckets: held('bucket')
  }
  return { g1, g2 }
}

function derive () {
  const T = teams()
  const cur = hist.length ? hist[hist.length - 1] : { t: now(), b: {} }
  const ev = armyEvents(120)
  LEDGER = ledgerRows(ev, T)
  const per30 = {}
  for (const [t, bot, , , n] of LEDGER) if (t > now() - 1800000) per30[bot] = (per30[bot] || 0) + n
  const perBot = {}
  const invAll = {}
  for (const [n, v] of Object.entries(cur.b)) {
    const c = classify(n, v, per30[n] || 0)
    perBot[n] = { team: T.of[n] || '-', task: v.online ? v.task : 'offline', hp: v.hp, food: v.food, ...c, banked30: per30[n] || 0,
      pos: v.online ? [v.x, v.y, v.z] : null, minY: S.minY[n], deathSpots: bs(n).deathSpots.slice(-3) }
    if (v.online) for (const [k, q] of Object.entries(v.inv || {})) invAll[k] = (invAll[k] || 0) + q
  }
  const perTeam = {}
  for (const tname of T.list) {
    const names = T.def[tname].bots || []
    const cnt = { PRODUCING: 0, WORKING: 0, TRAVELLING: 0, STUCK: 0, IDLE: 0, FLAPPING: 0, OFFLINE: 0 }
    let walked15 = 0; let deaths30 = 0; let hungry = 0; let inWater = 0; let minFood = 20
    for (const n of names) {
      const p = perBot[n]
      if (!p) { cnt.OFFLINE++; continue }
      cnt[p.cls] = (cnt[p.cls] || 0) + 1
      walked15 += p.d15 || 0
      deaths30 += bs(n).deaths.filter(t => t > now() - 1800000).length
      if (p.water) inWater++
      if (p.food != null && p.food <= 6) hungry++
      if (p.food != null && p.food < minFood) minFood = p.food
    }
    const b30 = banked(30, x => x.team === tname)
    const b20 = banked(20, x => x.team === tname)
    const online = names.length - cnt.OFFLINE
    const botHours = Math.max(0.25, (online || names.length) * 0.5)
    const visits = S.visitLog.filter(r => r[0] > now() - 900000 && T.of[r[1]] === tname)
    perTeam[tname] = {
      bots: names.length, online, ...cnt,
      banked30: b30.total, banked20: b20.total,
      perBotHour: fix(b30.total / botHours, 1),
      walked15: Math.round(walked15),
      mPerItem: b30.total ? Math.round(walked15 * 2 / b30.total) : null,
      deaths30, hungry, minFood, inWater,
      chestVisits15: visits.length, emptyVisits: visits.filter(r => !r[2]).length,
      top: Object.entries(b30.items).sort((a, b) => (BULK.test(a[0]) - BULK.test(b[0])) || (b[1] - a[1])).slice(0, 3) // what the job is FOR first, bulk stone/dirt last
    }
  }
  const boards = gateBoards(invAll, ev)
  boards.g1.hungry = Object.values(perBot).filter(p => p.food != null && p.food <= 6 && p.cls !== 'OFFLINE').length
  const build = buildProgress()
  const compliance = auditCompliance(perBot, perTeam, build, boards)
  const problems = findProblems(perBot, perTeam, build, boards, compliance)
  const deaths = deathLedger(ev)
  if (deaths.n1h >= 20) problems.unshift({ sev: 4, tag: 'deaths', text: `${deaths.n1h} bot deaths in 1 h (${Object.entries(deaths.byCause).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + ' ' + v).join(', ')}) — keep_inventory OFF: every death also destroys the carried output` })
  let anomalies = []
  try { anomalies = fieldAnomalies(perBot, boards, ev) } catch (e) { log('anomalies: ' + (e.stack || e)) }
  let armyBuilds = []
  try { armyBuilds = armyBuildProgress(ev) } catch (e) { log('armyBuilds: ' + (e.stack || e)) }
  return { t: new Date().toISOString(), uptimeMin: Math.round((now() - S.startedAt) / 60000), perBot, perTeam, build,
    boards, compliance, invAll, banked30: banked(30), banked60: banked(60), problems, anomalies, armyBuilds, deaths,
    apiMs: S.apiMs, shardsDown: S.shardsDownList || [] }
}

// ---------- docs/GOALS.md compliance ----------
function auditCompliance (perBot, perTeam, build, boards) {
  return {} // retired with the team leaders (flat org): the job board IS the directive now
  const out = {} // eslint-disable-line no-unreachable
  const tasksOf = (team) => Object.entries(perBot).filter(([, p]) => p.team === team).map(([, p]) => p.task).join(' ')
  const MEGA = /castle|tenshu|torii|shrine|sakura|great_tower|pyramid|dome/i
  const FOODINFRA = /dock|farm|fish|campfire|smoker|till|pond|food|crop/i
  const active = build.filter(b => b.status === 'running').map(b => b.id)
  const mega = active.filter(id => MEGA.test(id))
  out.build_a = { ok: mega.length === 0 && (active.some(id => FOODINFRA.test(id)) || FOODINFRA.test(tasksOf('build_a'))),
    note: mega.length ? 'mega build running during Gate 1: ' + mega.join(',') : 'no food-infra job/task (active: ' + (active.join(',') || 'none') + ')' }
  out.build_b = { ok: boards.g1.torchesPlaced1h > 0 || boards.g1.campfires1h > 0, note: `torches placed 1h=${boards.g1.torchesPlaced1h}, campfires=${boards.g1.campfires1h}` }
  out.food = { ok: boards.g1.edibleBanked30 > 0 || boards.g1.rods.held >= 2, note: `rods ${boards.g1.rods.held}/5, edible banked 30m ${boards.g1.edibleBanked30}, inflow ${boards.g1.inflowPerMin}/min` }
  out.base = { ok: !(boards.g1.wool.held >= 3 || boards.g1.string.held >= 12) || (boards.g1.beds.held + boards.g1.beds.placed) > 0,
    note: `wool ${boards.g1.wool.held}, string ${boards.g1.string.held}, beds ${boards.g1.beds.held + boards.g1.beds.placed}` }
  out.mining = { ok: (boards.g2.raw_iron + boards.g2.ingots + boards.g2.rawBanked1h) > 0 || (boards.g2.shafts != null && boards.g2.shafts <= 30),
    note: `deepest mining y=${boards.g2.shafts}, iron ${boards.g2.raw_iron}raw/${boards.g2.ingots}ingot, banked 1h ${boards.g2.rawBanked1h}raw` }
  out.build_c = { ok: !!(perTeam.build_c && perTeam.build_c.banked30 > 0), note: `banked 30m = ${perTeam.build_c ? perTeam.build_c.banked30 : '?'}` }
  return out
}

// ---------- problems ----------
function findProblems (perBot, perTeam, build, boards, compliance) {
  const P = []
  const add = (sev, tag, text, team) => P.push({ sev, tag, text, team })
  for (const [t, v] of Object.entries(perTeam)) {
    if (t === 'muster' || t === 'offline' || t === 'qm_scan') continue // standing by / base services: no output expected
    if (v.banked20 === 0 && v.walked15 > 150) add(5, 'noout', `${t}: ZERO OUTPUT for 20 min while walking ${v.walked15} m/15min with ${v.online} bots — motion, not production`, t)
    else if (v.banked30 === 0) add(4, 'noout', `${t}: nothing banked in 30 min (${v.online} bots online, ${v.walked15} m/15min)`, t)
  }
  for (const [t, v] of Object.entries(perTeam)) {
    if (v.emptyVisits >= 4 && v.banked30 === 0) add(4, 'circling', `${t}: ${v.emptyVisits} chest visits in 15 min, nothing deposited — chest-circling`, t)
  }
  const byBot = {}
  for (const r of S.visitLog) { if (r[0] < now() - 900000) continue; byBot[r[1]] = byBot[r[1]] || [0, 0]; byBot[r[1]][0]++; if (r[2]) byBot[r[1]][1]++ }
  const standby = n => perBot[n] && (perBot[n].team === 'muster' || perBot[n].team === 'qm_scan') // the muster grid is next to the depot chests: standing there is not circling
  const circlers = Object.entries(byBot).filter(([n, v]) => v[0] >= 5 && v[1] === 0 && !standby(n)).map(([n, v]) => `${n}(${v[0]}x)`)
  if (circlers.length) add(3, 'circling', `chest-circling bots (15 min, 0 deposits): ${circlers.slice(0, 6).join(' ')}`)
  const g1 = boards.g1
  if (g1.edibleStock < 64 || Math.max(g1.inflowPerMin, g1.inflow2h) < 1 || (g1.beds.held + g1.beds.placed) < 1) add(4, 'gate1', `GATE 1 open: edible in stock ${g1.edibleStock}/64, new food ${g1.inflowPerMin}/min (30 m) ${g1.inflow2h}/min (2 h) (need 1.0), beds ${g1.beds.held + g1.beds.placed}/1`, 'food')
  if (boards.g1.hungry >= 4) add(4, 'hunger', `${boards.g1.hungry} bots at food<=6 — no sprint, no regen, and keep_inventory is OFF so each death destroys their carry`, 'food')
  if (boards.g1.string.held < 4 && boards.g1.rods.held < 5) add(3, 'gate1', `string ${boards.g1.string.held}, rods ${boards.g1.rods.held}/5 — fishing engine cannot start (2 string/rod, 12 string/bed)`, 'base')
  // deaths: see deathLedger() in derive()
  const wet = Object.entries(perBot).filter(([, p]) => p.water)
  if (wet.length) add(4, 'water', `${wet.length} bot(s) pinned in water: ` + wet.slice(0, 6).map(([n, p]) => `${n}(${p.team})@${(p.pos || []).join(',')}`).join(' '))
  const byTeamStuck = {}
  for (const [n, p] of Object.entries(perBot)) if (p.cls === 'STUCK' && p.team !== 'muster' && p.team !== 'offline') (byTeamStuck[p.team] = byTeamStuck[p.team] || []).push(`${n}@${(p.pos || []).join(',')} ${p.d5}m/5min`)
  for (const [t, l] of Object.entries(byTeamStuck)) add(l.length >= 2 ? 3 : 2, 'stuck', `${t}: ${l.length} stuck — ${l.slice(0, 3).join(' | ')}`, t)
  const flap = Object.entries(perBot).filter(([, p]) => p.cls === 'FLAPPING')
  if (flap.length >= 2) add(3, 'flapping', `${flap.length} bots kick/reconnect flapping: ` + flap.slice(0, 5).map(([n, p]) => `${n}(${p.kicks15}k)`).join(' '))
  for (const [t, c] of Object.entries(compliance)) if (!c.ok) add(3, 'directive', `${t} off-directive: ${c.note}`, t)
  const spots = []
  for (const [n, p] of Object.entries(perBot)) for (const d of (p.deathSpots || [])) if (d[3] > now() - 1800000) spots.push({ n, x: d[0], y: d[1], z: d[2] })
  const clusters = []
  for (const s of spots) {
    const c = clusters.find(c => Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z) < 12)
    if (c) { c.n++; c.who.add(s.n) } else clusters.push({ x: s.x, y: s.y, z: s.z, n: 1, who: new Set([s.n]) })
  }
  for (const c of clusters.filter(c => c.n >= 3).sort((a, b) => b.n - a.n).slice(0, 2)) add(3, 'hotspot', `death hotspot (${c.x},${c.y},${c.z}): ${c.n} deaths/30min — ${[...c.who].slice(0, 6).join(',')}`)
  if (S.apiMs > 8000) add(3, 'api', `API slow: GET /status ${Math.round(S.apiMs / 1000)}s — shard event loops blocked, bot physics starved`)
  if (S.shardsDown) add(4, 'shards', `${S.shardsDown}/10 manager shards not answering (${(S.shardsDownList || []).join(',')})`)
  return P.sort((a, b) => b.sev - a.sev)
}

// ---------- field anomalies (contradictions between numbers that each look fine alone; read by cheap operator models) ----------
const WARN_EV = /fail|unreach|missing|_full|blocked|error|no_route|hung|stranded|stuck/
const PASS_OUT = ['done', 'felled', 'planted', 'harvested', 'placed', 'pillars', 'holes', 'floats']
function fieldAnomalies (perBot, boards, ev) {
  const A = []
  const g1 = boards.g1
  const board = readJSON(path.join(BOTS, 'army', 'jobs.json'), {})
  const jobs = board.jobs || []
  const activeJob = id => jobs.some(j => j.id === id && j.status === 'active')
  // 1. food in stock but bots starve
  const starving = Object.entries(perBot).filter(([, p]) => p.cls !== 'OFFLINE' && p.food != null && p.food <= 6)
  if (starving.length && g1.edibleStock >= 32) A.push(`FOOD IN STOCK BUT BOTS STARVE: ${g1.edibleStock} edible in chests, yet ${starving.length} bot(s) at food<=6: ${starving.slice(0, 5).map(([n, p]) => `${n}(${p.food},${p.team})`).join(' ')}`)
  // 2. motion without output: the last 10 passes of an active job all produced 0
  const passes = {}
  for (const e of ev) {
    if (!/_pass$/.test(e.ev || '') || e.ev === 'guard_pass' || !e.job || e.t < now() - 3600000) continue
    if (e.ev === 'tidy_pass' && !e.found) continue // a clean tile is not a failure
    const src = { ...(e.st || {}), ...e }
    const out = PASS_OUT.reduce((a, k) => a + (+src[k] || 0), 0);
    (passes[e.job] = passes[e.job] || []).push([out, e.bot])
  }
  for (const [job, l] of Object.entries(passes)) {
    const last = l.slice(-10)
    if (last.length >= 10 && last.every(r => r[0] === 0) && activeJob(job)) A.push(`MOTION WITHOUT OUTPUT: ${job} — last 10 passes all 0 (${[...new Set(last.map(r => r[1]))].slice(0, 4).join(',')}); pause it or fix what blocks it`)
  }
  // 3. warning storms: the same warning >= 20x in 30 min
  const warn = {}
  for (const e of ev) {
    if (e.t < now() - 1800000 || !WARN_EV.test(e.ev || '')) continue
    const k = e.ev + (e.job ? ' ' + e.job : (e.cat ? ' ' + e.cat : ''))
    const w = warn[k] = warn[k] || { n: 0, bots: new Set(), where: {} }
    w.n++; w.bots.add(e.bot)
    const at = e.at || e.to || e.pos || e.from
    const tag = [e.why || e.err || '', Array.isArray(at) ? '@' + at.map(v => v == null ? '?' : v).join(',') : ''].filter(Boolean).join(' ')
    if (tag) w.where[tag] = (w.where[tag] || 0) + 1
  }
  for (const [k, w] of Object.entries(warn).filter(([, w]) => w.n >= 20).sort((a, b) => b[1].n - a[1].n).slice(0, 3)) {
    const top = Object.entries(w.where).sort((a, b) => b[1] - a[1])[0]
    A.push(`WARNING STORM: ${k} x${w.n}/30min (${w.bots.size} bots)${top ? ', most: ' + top[0] + ' x' + top[1] : ''} — nobody is resolving it`)
  }
  // 4. legacy chests still registered
  const legacy = Object.values(armySettings().legacyChests || {}).reduce((a, l) => a + ((l && l.length) || 0), 0)
  if (legacy) A.push(`LEGACY CHESTS: ${legacy} old chest(s) still registered (settings.legacyChests) — quartermaster has not drained them`)
  // 5. build jobs that paused themselves as stuck
  const stuck = jobs.filter(j => j.type === 'build' && j.status === 'paused' && /cells nobody could do/.test(j.note || ''))
  if (stuck.length) A.push(`BUILD STUCK: ${stuck.map(j => j.id).slice(0, 5).join(', ')} auto-paused (build_stuck) — ${String(stuck[0].note).slice(0, 90)}`)
  // 6. wheat piles up but nobody bakes
  if (g1.wheatStock >= 192 && !(g1.made30.bread > 0) && !(g1.breadIn30 > 0) && !((g1.stockItems || {}).bread >= 512)) A.push(`WHEAT NOT BAKED: ${g1.wheatStock} wheat in chests, 0 bread baked or banked by any job in 30 min — is a baker staffed (qm_scan, or a steps plan that crafts bread)?`)
  // 7. containers the index does not know (deposits there are invisible to stock/recipe/canteen)
  const idx = chestIndex()
  const reg = Object.values(armySettings().chests || {}).reduce((a, l) => a.concat(l || []), [])
  const unindexed = reg.filter(c => !idx[c[0] + ',' + c[1] + ',' + c[2]]).length
  if (reg.length && unindexed / reg.length > 0.25) A.push(`INDEX GAP: ${unindexed}/${reg.length} registered containers never scanned into chests.json`)
  // 8. AUDIT OF WHAT WE MADE (owner 09-19: ~100 planted berry bushes were pulled out by players and no number showed it): the bots' own audit
  // events per 30 min with who/where, and planted vs standing for the berry hedge. At most 3 lines, put FIRST.
  let audit = []
  try { audit = auditLines(ev) } catch (e) { log('audit: ' + (e.stack || e)) }
  return audit.concat(A.slice(0, 9)).slice(0, 12).map(l => l.slice(0, 230))
}
// bushes planted since the last hedge demolition (whole ledger, re-scanned at most every 10 min: results.jsonl is a few MB)
let _planted = { t: 0, n: 0, since: 0 }
function berriesPlanted () {
  if (now() - _planted.t < 600000) return _planted
  let n = 0; let since = 0
  try {
    for (const l of fs.readFileSync(path.join(BOTS, 'army', 'results.jsonl'), 'utf8').split('\n')) {
      if (l.indexOf('berries_planted') < 0 && l.indexOf('hedge_demolished') < 0) continue
      let e; try { e = JSON.parse(l) } catch { continue }
      if (e.ev === 'hedge_demolished' && e.removed > 0) { n = 0; since = e.t } else if (e.ev === 'berries_planted') { n += (+e.n || 0); if (!since) since = e.t }
    }
  } catch (e) { log('berriesPlanted: ' + e.message) }
  _planted = { t: now(), n, since }
  return _planted
}
function auditLines (ev) {
  const out = []
  const cut = now() - 1800000
  const at = e => Array.isArray(e.at) ? '@' + e.at.join(',') : ''
  const recent = ev.filter(e => e.t >= cut)
  // damage to things we built / planted
  const dmg = []
  const hd = recent.filter(e => e.ev === 'hedge_damaged')
  if (hd.length) dmg.push(`hedge_damaged x${hd.length} (-${hd.reduce((a, e) => a + Math.max(0, (+e.was || 0) - (+e.now || 0)), 0)} bushes, ${hd[hd.length - 1].job || '?'})`)
  const sd = recent.filter(e => e.ev === 'structure_damaged')
  if (sd.length) { const by = {}; for (const e of sd) by[e.job || '?'] = Math.max(by[e.job || '?'] || 0, +e.missing || 0); dmg.push(`structure_damaged x${sd.length} (${Object.entries(by).slice(0, 3).map(([j, m]) => j + ' ' + m + ' cells').join(', ')})`) }
  const cv = recent.filter(e => e.ev === 'crops_vanished')
  if (cv.length) dmg.push(`crops_vanished x${cv.length} (${cv.reduce((a, e) => a + (+e.replanted || 0), 0)} replanted, ${cv[cv.length - 1].job || '?'} ${at(cv[cv.length - 1])})`)
  if (dmg.length) out.push('ASSETS DAMAGED /30min: ' + dmg.join(' · ') + ' — mobs or one of our own jobs undo what we made: LOOK at the place (mapshot), the structure\'s own build job is the repair')
  // planted vs standing (asset_audit.json is written by the berry job on every visit of the pad)
  const au = readJSON(path.join(BOTS, 'army', 'asset_audit.json'), {}) || {}
  const pl = berriesPlanted()
  const st = Object.entries(au).find(([k, v]) => /berr/.test(k) && v && typeof v.n === 'number')
  if (pl.n || st) {
    const standing = st ? st[1].n : null
    const gone = standing != null ? pl.n - standing : null
    out.push(`BERRY HEDGE planted vs standing: planted ${pl.n}${pl.since ? ' since ' + new Date(pl.since).toISOString().slice(11, 16) + 'Z' : ''}, standing ${standing != null ? standing + ' (counted ' + Math.round((now() - st[1].t) / 60000) + ' min ago)' : 'never counted'}${gone != null && gone >= 10 ? ' -> ' + gone + ' MISSING (' + Math.round(gone * 100 / Math.max(1, pl.n)) + '%)' : ''}`)
  }
  return out.slice(0, 3)
}
// the army's `build` jobs (the pre-army build_queue.json is dead: its 'STALL 900m' lines described jobs nobody runs any more)
function armyBuildProgress (ev) {
  const jobs = (readJSON(path.join(BOTS, 'army', 'jobs.json'), {}).jobs || []).filter(j => j.type === 'build' && j.status === 'active')
  return jobs.map(j => {
    const l = ev.filter(e => e.ev === 'build_pass' && e.job === j.id)
    const last = l[l.length - 1]
    return { id: j.id, left: last ? last.left : null, done30: l.filter(e => e.t > now() - 1800000).reduce((a, e) => a + (+e.done || 0), 0), lastMin: last ? Math.round((now() - last.t) / 60000) : null }
  })
}

// ---------- report ----------
// ---------- GEMBA (ops/gemba.js): the CLASS-AGNOSTIC look - who stands still, which job crawls against one player by hand, who produced nothing in 10 min.
// The audits know failure CLASSES; this one needs no theory of the cause (owner 09-20: "その解決方法だとその2件しか気が付けないのでは？"). No new daemon:
// the inspector is its clock (one 60 s watch every 10 min, async - the 60 s report loop must never wait for it). Its "!" lines LEAD the REPORT.
let GEMBA = null; let gembaAt = 0; let gembaBusy = false
function gembaTick () {
  if (gembaBusy || now() - gembaAt < 600000) return
  gembaBusy = true; gembaAt = now()
  try {
    const g = require(path.join(WS, 'ops', 'gemba.js'))
    g.watch(60).then(r => { GEMBA = r; gembaBusy = false }, e => { gembaBusy = false; log('gemba: ' + ((e && e.message) || e)) })
  } catch (e) { gembaBusy = false; log('gemba: ' + e.message) }
}
function gembaBlock (L) {
  let rep = GEMBA && GEMBA.report; let t = GEMBA && GEMBA.t
  if (!rep) { const R = readJSON(path.join(MET, 'gemba.json'), null); if (R && R.report) { rep = R.report; t = R.t } } // just restarted: the last watch on disk
  const bangs = (rep || []).filter(l => l.startsWith('!')).length
  L.push('## GEMBA (go and look — ops/gemba.js watches the field for 60 s every 10 min: who STANDS, which job CRAWLS against one player by hand, who produced NOTHING) — ' +
    (rep ? bangs + ' line(s) to answer, ' + Math.round((now() - t) / 60000) + ' min old' : 'no watch yet: node ops/gemba.js 60'))
  for (const l of (rep || []).slice(1)) L.push(l)
  L.push('')
}

// ---------- BASE AUDIT (ops/base-audit.js): the PLAN against the WORLD seen by the spectator camera - outcomes nobody reports about himself (owner 09-20:
// sheep outside the pen, junk blocks, a bumpy base, furnaces that are air, cane that does not grow, bots that stand). The inspector is its CLOCK (no new
// daemon): a result older than 30 min -> start the script detached (its own lock keeps a second camera out; one try per 10 min), and its alerts lead the REPORT.
let auditTry = 0
function baseAudit () {
  const A = readJSON(path.join(BOTS, 'army', 'base_audit.json'), null); const age = A && A.t ? Math.round((now() - A.t) / 60000) : null
  if ((age == null || age >= 30) && now() - auditTry > 600000 && readJSON(path.join(BOTS, 'army', 'jobs.json'), {}).settings && armySettings().base) {
    auditTry = now()
    try { const out = fs.openSync(path.join(WS, 'ops', 'base-audit.log'), 'a'); const c = require('child_process').spawn('node', [path.join(WS, 'ops', 'base-audit.js')], { detached: true, stdio: ['ignore', out, out] }); c.unref(); fs.closeSync(out); log('base-audit started (last result ' + (age == null ? 'none' : age + ' min old') + ')') } catch (e) { log('base-audit spawn: ' + e.message) }
  }
  return { A, age }
}
function renderReport (d) {
  const L = []
  const g1 = d.boards.g1; const g2 = d.boards.g2
  // furnaces live in the board settings since world 2 (`settings.furnaces:[[x,y,z]…]`, registered by the build job); bots/base.json is retired.
  // (foreman 09-19 23:45Z read "0 furnaces" here while 20 stood in the hall and concluded the registry was blind.)
  const base = readJSON(path.join(BOTS, 'base.json'), {}); try { const S = readJSON(path.join(BOTS, 'army', 'jobs.json'), {}).settings || {}; if (Array.isArray(S.furnaces) && S.furnaces.length) base.furnaces = S.furnaces.map(f => ({ x: f[0], y: f[1], z: f[2] })) } catch {}
  const tot = Object.keys(d.perBot).length
  const online = Object.values(d.perBot).filter(p => p.cls !== 'OFFLINE').length
  const walked15 = Object.values(d.perTeam).reduce((a, v) => a + v.walked15, 0)
  const b30 = d.banked30.total
  const dc = d.deaths ? d.deaths.byCause : null
  const deaths1h = d.deaths ? d.deaths.n1h : null
  L.push(`# BOT ARMY REPORT — ${d.t.replace('T', ' ').slice(0, 19)}Z  (inspector up ${d.uptimeMin}m)`)
  L.push(`HEADLINE (OUTPUT): ${b30} items banked/30min = ${fix(b30 / Math.max(0.5, online * 0.5), 1)} per bot-hour | food: ${g1.edibleStock} edible in stock, +${g1.edibleBanked30} new/30min (${g1.inflowPerMin}/min, need 1.0) | iron ${g2.raw_iron}raw+${g2.ingots}ingot`)
  L.push(`  cost: ${Math.round(walked15)} m walked/15min = ${b30 ? Math.round(walked15 * 2 / b30) + ' m per banked item' : 'NOTHING BANKED'} | deaths/h ${deaths1h != null ? deaths1h : 'n/a'} | ${g1.hungry} bots food<=6 | ${online}/${tot} online`)
  const reg = armySettings().chests || {}
  L.push(`  storage: ${Object.values(reg).reduce((a, l) => a + l.length, 0)} containers registered (${Object.entries(reg).map(([k, l]) => k + ' ' + l.length).join(', ')}), ${g1.containers} indexed | ${(base.furnaces || []).length} furnaces, ${g1.beds.placed} beds${(() => { try { const f = (readJSON(path.join(BOTS, 'army', 'base_audit.json'), {}).findings || []).find(q => q.ev === 'audit_furniture'); return f && f.n ? ' (REGISTERED - the camera saw ' + f.n + ' of all registered furniture NOT standing, see BASE AUDIT)' : '' } catch { return '' } })()} | API ${fix((d.apiMs || 0) / 1000, 1)}s${d.shardsDown.length ? ' | SHARDS DOWN ' + d.shardsDown.join(',') : ''}`)
  L.push('')
  try { gembaBlock(L) } catch (e) { log('gembaBlock: ' + (e.stack || e)) }
  try {
    const { A, age } = baseAudit(); const al = A ? (A.findings || []).filter(f => f.alert) : []; const idle = A && (A.findings || []).find(f => f.ev === 'audit_idle')
    if (idle && idle.standingShare != null) L.splice(3, 0, `  STANDING: ${Math.round(idle.standingShare * 100)} % of bot time produced nothing in the last hour (${idle.idleHours} of ${idle.botHours} bot-h; worst: ${(idle.worst || []).slice(0, 3).map(w => w.job + ' ' + w.idleHours + ' bot-h').join(', ')})${idle.alert ? '  <-- ABOVE 30 %: see BASE AUDIT' : ''}`)
    L.push(`## BASE AUDIT (plan vs WORLD through the spectator camera, every ~30 min: ops/base-audit.js) — ${A ? al.length + ' alert(s), ' + age + ' min old' + (age > 50 ? '  STALE: run `node ops/base-audit.js`, read ops/base-audit.log' : '') + ', picture ' + A.png + ' (RED bump, BLUE hole, MAGENTA stray, YELLOW missing, ORANGE animal outside)' : 'NO RESULT YET: node ops/base-audit.js'}`)
    const rank = { audit_pen: 0, audit_furniture: 1, audit_stray: 2, audit_growth: 3, audit_idle: 4, audit_rough: 5, audit_field: 6, audit_structure: 7 }
    for (const f of al.sort((a, b) => (rank[a.ev] ?? 9) - (rank[b.ev] ?? 9)).slice(0, 12)) L.push('- ' + (f.fresh ? 'NEW ' : '') + String(f.text).split(' -> ')[0].slice(0, 420))
    if (al.length > 12) L.push(`  (+${al.length - 12} more: node bots/army/armyctl.js events 30 audit)`)
    if (A && !al.length) L.push('  (plan and world agree)')
    L.push('')
  } catch (e) { log('baseAudit: ' + (e.stack || e)) }
  L.push('## FIELD ANOMALIES (numbers that contradict each other — act on these first)')
  if (!(d.anomalies || []).length) L.push('  (none)')
  for (const a of (d.anomalies || [])) L.push('- ' + a)
  L.push('')
  const top3 = o => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => k + ' ' + n).join(', ') || '-'
  const g1ok = g1.edibleStock >= 64 && Math.max(g1.inflowPerMin, g1.inflow2h) >= 1 && g1.hungry === 0 && (g1.beds.held + g1.beds.placed) >= 1
  L.push(`## GATE 1 food+bed  [need 64 edible IN STOCK, new food >=1/min, 0 hungry, 1 bed+sleeper]  ${g1ok ? 'MET' : 'OPEN'}`)
  L.push(`  edible in stock ${g1.edibleStock}/64 (${top3(g1.stockItems)}) + carried ${g1.edibleHeld} · ingredients: wheat ${g1.wheatStock}+${g1.wheatHeld} carried (=${Math.floor((g1.wheatStock + g1.wheatHeld) / 3)} bread), raw fish/meat ${g1.rawStock}`)
  L.push(`  NEW food 2h ${g1.edibleBanked2h} (${top3(g1.made2h)}) · 30m ${g1.edibleBanked30} = ${g1.inflowPerMin}/min (2h avg ${g1.inflow2h}/min) · eaten from canteen 2h ${g1.drawn2h} · wheat harvested +${g1.wheatBanked1h}/h`)
  L.push(`  string ${g1.string.held}(+${g1.string.banked1h}/h) seeds ${g1.seeds.held} carried + ${g1.seeds.stock} in stock bones ${g1.bones.held} rods ${g1.rods.held}/5 wool ${g1.wool.held} beds ${g1.beds.held + g1.beds.placed}`)
  L.push(`  torches placed/h ${g1.torchesPlaced1h} · campfires/h ${g1.campfires1h} · hungry bots ${g1.hungry}`)
  L.push('## GATE 2 iron  [need 120 ingots]')
  L.push(`  raw ${g2.raw_iron}(+${g2.rawBanked1h}/h) ingots ${g2.ingots}(+${g2.ingotsBanked1h}/h) coal ${g2.coal} · deepest mining y=${g2.shafts != null ? g2.shafts : '?'} (any bot ${g2.deepestAny != null ? g2.deepestAny : '?'})`)
  L.push(`  shields ${g2.shields} iron tools ${g2.ironTools} iron armour ${g2.ironArmour} buckets ${g2.buckets}`)
  L.push('')
  L.push('## Jobs (bots grouped by the army job they hold now; output first)')
  L.push('job            on  bank30 /bot-h  m/item  walk15  visits(dry) dead30 hungry  top banked')
  for (const [t, v] of Object.entries(d.perTeam)) {
    L.push(`${pad(t, 15)}${lpad(v.online + '/' + v.bots, 4)}${lpad(v.banked30, 7)}${lpad(v.perBotHour, 7)}${lpad(v.mPerItem == null ? 'inf' : v.mPerItem, 8)}${lpad(v.walked15 + 'm', 8)}${lpad(v.chestVisits15 + '(' + v.emptyVisits + ')', 12)}${lpad(v.deaths30, 7)}${lpad(v.hungry, 7)}  ${v.top.map(([k, n]) => k + ' ' + n).join(', ').slice(0, 28)}`)
  }
  if ((d.armyBuilds || []).length) L.push('## Builds (army `build` jobs) ' + d.armyBuilds.map(b => `${b.id}: ${b.left == null ? 'no pass in 2h' : b.left + ' cells left, +' + b.done30 + '/30min' + (b.lastMin > 10 ? ', last pass ' + b.lastMin + 'm ago' : '')}`).join(' · ').slice(0, 220))
  if (dc) L.push(`## Deaths last 1h: ${deaths1h} — by cause: ` + (Object.entries(dc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '-').slice(0, 120) + ' | by job: ' + (Object.entries(d.deaths.byJob).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '-').slice(0, 90))
  L.push('')
  L.push('## Top problems')
  const top = d.problems.slice(0, 5)
  if (!top.length) L.push('  (none detected)')
  top.forEach((p, i) => L.push(`${i + 1}. [${p.tag}] ${p.text}`.slice(0, 200)))
  L.push('')
  L.push('## Bots needing attention')
  const badb = Object.entries(d.perBot).filter(([, p]) => ['STUCK', 'FLAPPING', 'OFFLINE'].includes(p.cls) || (p.food != null && p.food <= 4) || (p.hp != null && p.hp <= 5)).slice(0, 6)
  if (!badb.length) L.push('  (none)')
  for (const [n, p] of badb) L.push(`  ${pad(n, 9)}${pad(p.team, 9)}${pad(p.cls, 11)}hp${lpad(p.hp, 3)} food${lpad(p.food, 3)} bank30 ${lpad(p.banked30, 3)}  ${p.water ? 'WATER ' : ''}${String(p.task).slice(0, 22)}`)
  L.push('')
  L.push('(food = army ledger results.jsonl [cooked/banked/canteen] + chest index chests.json; "bank30" = the bots own banked reports; visits(dry) = 30 s inventory diff near a registered container; inspector.js ~60s)')
  return L.slice(0, 82).join('\n') + '\n' // GEMBA + BASE AUDIT lead the report; the tail (per-job table, bots needing attention) must still fit
}

// ---------- loop ----------
async function probeShards () {
  const down = []
  const nShards = Math.ceil(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'roster.json'), 'utf8')).length / 3) // shard count follows the roster (50 bots = 17)
  await Promise.all([...Array(nShards).keys()].map(i => new Promise(resolve => {
    let fired = false
    const fin = (bad) => { if (fired) return; fired = true; if (bad) down.push(3001 + i); resolve() }
    const r = http.request({ host: '127.0.0.1', port: 3001 + i, method: 'GET', path: '/status?brief=1' }, res => { res.resume(); res.on('end', () => fin(false)) })
    r.on('error', () => fin(true))
    r.setTimeout(9000, () => { try { r.destroy() } catch {} fin(true) })
    r.end()
  })))
  S.shardsDown = down.length
  S.shardsDownList = [...new Set(down)].sort()
}

// OFF-SITE COPY, PROACTIVELY (owner 09-20: "github への push は積極的に行うべき"): every 30 min, when every production file loads (`ops/check.sh`), `ops/git.sh publish`
// commits what changed and pushes it (the wrapper refuses staged tokens / passwords / addresses; the token comes from this process's environment). No new daemon:
// one child process from this loop, never awaited, one at a time.
let _pubT = Date.now() - 20 * 60000; let _pubBusy = false
// EVERY BELIEF ABOUT THE WORLD EXPIRES (owner 09-21: 「ネザー側、壊れたポータルが3つもあるの把握してる？」 - the board said ONE frame per dimension and was
// hours old; the camera found a whole one, a dark one and two wrecks). The gate census re-measures BOTH dimensions every 30 min, writes
// `settings.nether.gates`, and raises `audit_gates` when the invariant breaks: exactly ONE lit frame per dimension, each frame 10 obsidian, no wrecks.
let _gateT = 0; let _gateBusy = false
function gateTick () {
  if (_gateBusy || Date.now() - _gateT < 30 * 60000) return
  const B = readJSON(path.join(WS, 'bots', 'army', 'jobs.json'), null); const S = (B && B.settings) || {}
  const g = S.nether && S.nether.gate; if (!g) return // no gate in this world yet
  _gateT = Date.now(); _gateBusy = true
  const { execFile } = require('child_process')
  const nx = Math.floor(g[0] / 8); const nz = Math.floor(g[2] / 8)
  const run = (args, next) => execFile('node', [path.join(WS, 'ops', 'gate-census.js')].concat(args), { timeout: 240000 }, (e, out) => { log('gates: ' + String(out || (e && e.message)).split('\n').filter(Boolean).slice(0, 5).join(' | ')); next && next() })
  run([String(nx), String(nz), '96', '--dim=the_nether'], () => run([String(g[0]), String(g[2]), '160', '--dim=overworld'], () => {
    _gateBusy = false
    const b2 = readJSON(path.join(WS, 'bots', 'army', 'jobs.json'), null); const rows = ((b2 && b2.settings && b2.settings.nether) || {}).gates || []
    const bad = []
    for (const d of ['overworld', 'the_nether']) {
      const mine = rows.filter(r => r.dim === d); const lit = mine.filter(r => r.lit)
      if (lit.length !== 1) bad.push(d + ': ' + lit.length + ' LIT frames (want exactly 1)')
      for (const r of mine) { if (!r.lit) bad.push(d + ': a ' + r.state + ' frame stands at ' + r.at.join(',') + ' (' + r.frame + ' obsidian) - take it down and bank the obsidian'); else if (r.frame > 14) bad.push(d + ': the lit frame at ' + r.at.join(',') + ' carries ' + r.frame + ' obsidian (a gate is 10) - leftovers of an older frame') }
    }
    if (bad.length) { try { fs.appendFileSync(path.join(BOTS, 'army', 'results.jsonl'), JSON.stringify({ t: Date.now(), bot: 'audit', ev: 'audit_gates', bad, gates: rows.map(r => r.dim + ' ' + r.state + ' ' + r.at.join(',')) }) + '\n') } catch (e) { log('gates: ' + e.message) } log('gates: AUDIT ' + bad.join(' ; ')) }
  }))
}
function publishTick () {
  if (_pubBusy || Date.now() - _pubT < 30 * 60000 || !process.env.GITHUB_TOKEN) return
  _pubT = Date.now(); _pubBusy = true
  const { execFile } = require('child_process')
  execFile('/bin/bash', ['-c', 'cd ' + WS + ' && ops/check.sh >/dev/null 2>&1 && ops/git.sh publish "auto: $(date -u +%F\\ %H:%MZ)" 2>&1 | tail -2'], { timeout: 180000 }, (err, out) => { _pubBusy = false; log('publish: ' + (err ? 'FAILED ' + String(err.message).slice(0, 120) : 'ok') + ' ' + String(out || '').replace(/ghp_[A-Za-z0-9]+/g, '***').trim().slice(0, 200)) })
}

let tick = 0
async function loop () {
  try {
    publishTick()
    gateTick() // both dimensions' portal frames re-measured every 30 min (fire and forget)
    gembaTick() // fire-and-forget: a 60 s field watch every 10 min, never awaited
    await probeShards()
    const snap = await sample(tick % 2 === 0)
    tick++
    if (snap && tick % 2 === 0) {
      const d = derive()
      writeAtomic(path.join(MET, 'latest.json'), JSON.stringify(d))
      writeAtomic(path.join(WS, 'REPORT.md'), renderReport(d))
      writeAtomic(STATE_F, JSON.stringify(S))
    }
  } catch (e) { log('loop error: ' + (e.stack || e)) }
}
log('inspector started pid ' + process.pid)
loop()
setInterval(loop, TICK)
