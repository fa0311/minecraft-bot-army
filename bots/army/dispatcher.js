#!/usr/bin/env node
// dispatcher.js — LLM-free dispatcher of the ONE ARMY. Pure file I/O + one read-only rcon query (world time).
//   reads : army/jobs.json (the job board, edited by the operator), army/hb/<bot>.json (worker heartbeats),
//           army/results.jsonl (worker reports)
//   writes: army/assign/<bot>.json (one job per bot), army/status.json, army/BOARD.md (human-readable), dispatcher.log;
//           jobs.json ONLY to activate the successor of a finished job (`after` chains, locked like the CLI) + one `job_activated` line in results.jsonl
// Rules: jobs by priority; sticky assignment; squads (job.bots = head-count, job.names = pinned bots);
//        at most settings.maxFronts work fronts (distinct job.front names) staffed at once; everyone else musters.
//        LABOUR BY DEMAND: a job with `produces:[item|group…]` gets minBots..maxBots by the worst stock deficit against settings.targets
//        (stock = stock.js: chests + carried) — see DEMAND below. Their minBots FLOOR is reserved before anybody else is staffed; above the
//        floor they compete by priority like every job, so put producers ABOVE build/sponge jobs: those get what is left.
// Dry run (no world, writes NOTHING): node dispatcher.js --dry <board.json> [fieldDir | +minutes]…   one tick per fieldDir (a dir with chests.json +
//        hb/*.json; none = the real field, heartbeat age ignored); `+N` moves the dispatcher's clock N minutes on (hysteresis, shift ends).
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const Stock = require('./stock.js')

const DIR = __dirname
const DRY = process.argv.indexOf('--dry') > 1 ? process.argv.slice(process.argv.indexOf('--dry') + 1) : null
let FIELD = DIR // where chests.json, hb/ and decline/ live (a dry run points it at a fake field)
let SKEW = 0 // dry run only: `+N` minutes
const NOW = () => Date.now() + SKEW
const P = {
  board: DRY ? path.resolve(DRY[0] || 'jobs.json') : path.join(DIR, 'jobs.json'), hb: path.join(DIR, 'hb'), assign: path.join(DIR, 'assign'),
  results: path.join(DIR, 'results.jsonl'), status: path.join(DIR, 'status.json'), md: path.join(DIR, 'BOARD.md')
}
if (!DRY) for (const d of [P.hb, P.assign]) fs.mkdirSync(d, { recursive: true })
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function readJSON (f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return dflt } }
function writeJSON (f, d, pretty) {
  const tmp = f + '.tmp' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(d, null, pretty ? 1 : 0)); fs.renameSync(tmp, f)
}

// ---- world time (read-only rcon, every 20 s, interpolated in between)
let clock = { time: 6000, at: Date.now(), ok: false } // at:0 made now() a RANDOM time of day until the first rcon answer: one tick of night jobs after every restart
function pollTime () {
  // 26.x renamed the query: `time query day` -> "Timeline minecraft:day is at N tick(s)"; up to 1.21 it was `time query daytime` -> "The time is N".
  // World 2, 09-19: the old form answered with a parse error, the clock free-ran from 6000 and the board showed NIGHT at noon (night guard by day).
  execFile('node', [path.join(DIR, '..', 'rcon.js'), 'time query day', 'time query daytime'], { timeout: 8000 }, (err, out) => {
    const m = /minecraft:day is at (\d+)/.exec(String(out || '')) || /The time is (\d+)/.exec(String(out || ''))
    if (m) clock = { time: +m[1] % 24000, at: Date.now(), ok: true }
  })
}
function now () { return (clock.time + Math.round((Date.now() - clock.at) / 50)) % 24000 }
function phaseOf (t, s) {
  const dusk = (s && s.dusk) || 12000; const dawn = (s && s.dawn) || 23300
  return (t >= dusk && t < dawn) ? 'night' : 'day'
}

// ---- results tail (deaths + banked output per job)
let resPos = 0
const events = [] // {t, bot, ev, job, items}
const doneEv = {} // job id -> {t, standing}: the last build_done / light_done report (AFTER chains)
// YIELD THROTTLE (owner 09-20: "仕事してないのってなんで気がつけないの？" - the audit measured 50 % of bot time without output, and nothing ACTED on it):
// a squad job that holds bots and reports no OUTPUT for them is cut by itself. Output = an event that changed the world or the stock. Every 5 min, per
// job with >= 3 bots (not named, not a shift job like the mine whose output only arrives with a haul, priority < 96): outputs of the last 15 min per
// bot held < 0.34 -> head-count cap = ceil(current / 2) (min 1) for 10 min; outputs back -> the cap doubles again until it is gone. LLM-free.
const outAt = {} // job id -> [t] of output events
const yieldCap = {} // job id -> {cap, until}
const workLeft = {} // job id -> {left, t}: open cells of the last build_pass (the only honest "how much work is left" the dispatcher can see)
const isOutput = r => (r.ev === 'banked' && r.items && Object.keys(r.items).some(k => !/^(dirt|cobblestone|cobbled_deepslate|torch|bread|stick|wheat_seeds)$/.test(k))) || (r.ev === 'build_pass' && r.done > 0) || (r.ev === 'tidy_fix' && r.n > 0) ||
  (r.ev === 'farm_pass' && r.st && (r.st.harvested > 0 || r.st.planted > 0)) || (r.ev === 'cane_pass' && (r.cut > 0 || r.planted > 0)) || (r.ev === 'guard_pass' && r.kills > 0) || (r.ev === 'trip' && r.kills > 0) ||
  /^(herded|bred|pen_harvest|crafted_to_target|forged|furnaces|torch|water_cell|lumber_pass|fish_session|tree_cleared|stair_repaired|obsidian_cast|step)$/.test(r.ev) && !(r.ev === 'herded' && !(r.n > 0)) && !(r.ev === 'step' && r.ok === false) && !(r.ev === 'lumber_pass' && !(r.felled > 0 || r.planted > 0))
let yieldT = 0
function yieldPass (jobs, staffedNow) {
  if (Date.now() - yieldT < 300000) return; yieldT = Date.now()
  const cut = Date.now() - 900000
  for (const id of Object.keys(outAt)) { outAt[id] = outAt[id].filter(t => t >= cut); if (!outAt[id].length) delete outAt[id] }
  for (const job of jobs) {
    const held = (staffedNow[job.id] || []).length; const y = yieldCap[job.id]
    if (job.names || job.shiftMin || (job.priority || 0) >= 96 || job.type === 'sleeper') { delete yieldCap[job.id]; continue }
    const per = (outAt[job.id] || []).length / Math.max(1, held)
    if (held >= 3 && per < 0.34) { const cap = Math.max(1, Math.ceil(held / 2)); yieldCap[job.id] = { cap, until: Date.now() + 600000 }; log('YIELD', job.id, 'held', held, 'outputs/15min', (outAt[job.id] || []).length, '-> cap', cap) } else if (y && per >= 1) { const cap = y.cap * 2; if (cap >= (job.bots || job.maxBots || 99)) delete yieldCap[job.id]; else yieldCap[job.id] = { cap, until: Date.now() + 600000 } }
    if (y && y.until < Date.now() && !(held >= 3 && per < 0.34)) delete yieldCap[job.id]
  }
}
function tailResults () {
  try {
    if (DRY) { P.results = path.join(FIELD, 'results.jsonl'); resPos = 0 } // a fake field may carry its own results.jsonl; never the real one
    const st = fs.statSync(P.results)
    if (st.size < resPos) resPos = 0
    if (st.size === resPos) return
    const fd = fs.openSync(P.results, 'r')
    const buf = Buffer.alloc(st.size - resPos)
    fs.readSync(fd, buf, 0, buf.length, resPos); fs.closeSync(fd)
    resPos = st.size
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line); if (r.job && r.t && isOutput(r)) (outAt[r.job] = outAt[r.job] || []).push(r.t)
        if (r.ev === 'build_pass' && r.job && typeof r.left === 'number') workLeft[r.job] = { left: r.left, t: r.t || Date.now() } // how many cells are still open = how many hands the job can really use (OVERFLOW)
        if (r.ev === 'death' || r.ev === 'banked' || r.ev === 'trip') events.push(r); else if ((r.ev === 'build_done' || r.ev === 'light_done') && r.job) doneEv[r.job] = { t: r.t, standing: !!r.standing } } catch {}
    }
    const cut = Date.now() - 6 * 3600000
    while (events.length && events[0].t < cut) events.shift()
  } catch {}
}

// a worker may DECLINE a job it cannot do right now (army/decline/<bot>.json) — skip that job for it until the note expires or the job's rev changes
// ONE READ PER BOT PER TICK (09-20: the pool filter called declined() for 24 jobs x 50 bots x 3 passes = ~3600 file reads every 5 s; the
// decline map is also the evidence for the REST rule below, so the tick reads it once and both use the same snapshot).
let declCache = {}
function declMap (name) {
  if (name in declCache) return declCache[name]
  let d = readJSON(path.join(FIELD, 'decline', name + '.json'), null)
  if (d && d.job) d = { [d.job]: d } // old single-entry format
  return (declCache[name] = d || {})
}
function declined (job, name) {
  const e = declMap(name)[job.id]
  return !!(e && e.until > Date.now() && (e.rev || 0) === (job.rev || 0))
}
// CHURN (owner 09-20 "全体的にタスクの効率が悪すぎる"; measured 1203 ASSIGN/h = 24 per bot per hour, a job change every 2.5 min, each one a walk +
// a handover bank + an interrupted slice; `base-audit --idle` 56 % of bot time without output, 12.8 of 52.1 bot-h at muster). The dispatcher now
// MEASURES its own churn: assignsPerHour + the top flows go into status.json (REPORT.md / ops/status.sh) and one CHURN line per 10 min into the log.
const assigns = [] // {t, from, to} of the last hour
let churnLog = 0
function churnStat () {
  const t0 = Date.now()
  while (assigns.length && assigns[0].t < t0 - 3600000) assigns.shift()
  const flow = {}
  for (const a of assigns) { const k = a.from + ' -> ' + a.to; flow[k] = (flow[k] || 0) + 1 }
  return {
    assignsPerHour: assigns.length, assigns10min: assigns.filter(a => a.t > t0 - 600000).length,
    churnFlows: Object.entries(flow).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => k + ' x' + n)
  }
}
function eligible (job, hb, phase, sticky) {
  if (job.restUntil && job.restUntil > Date.now()) return false // the JOB rests (its handler found nothing to do for anybody: herd with no animal in reach / breeding cooldown) - nobody is sent until then // sticky = the bot already holds this job: HYSTERESIS on hp/food so a bot at the threshold does not flap between two jobs every 5 s (Mio, 09-19)
  if (job.when && job.when !== 'any' && job.when !== phase && !(job.when === 'day' && NIGHT_SKIP)) return false // nightSkip: day jobs run around the clock
  const r = job.requires || {}
  if (r.minHp && hb.hp < r.minHp - (sticky ? 5 : 0)) return false
  if (r.minFood && hb.food < r.minFood - (sticky ? 4 : 0)) return false
  if (r.anyItem && !carries(r, hb) && stockOf(r.anyItem) <= 0) return false
  return true
}
// requires.anyItem: a bot that CARRIES the item is always eligible; others only while the chest index (chests.json, kept by the
// workers) shows stock they can draw — so a rod lying in the TOOLS chest gets a fisher instead of waiting for a miracle.
function carries (r, hb) { return !r.anyItem || r.anyItem.some(n => (hb.inv || {})[n] > 0) }
const stockOpts = () => DRY ? { dir: FIELD, maxAgeMs: Infinity } : undefined
function stockOf (names) { const c = Stock.detail(stockOpts()).chest; return names.reduce((n, k) => n + (c[k] || 0), 0) } // CHESTS only: what a bot can draw (another bot's pocket is not a depot)
function dist (hb, site) { if (!site || !hb.pos) return 0; const s = Array.isArray(site) ? site : [site.x, site.y, site.z]; return Math.hypot(hb.pos[0] - s[0], hb.pos[2] - s[2]) }

let NIGHT_SKIP = false
let WANT_STRING = false
let last = {} // bot -> job id
let lastWrite = {} // bot -> ms
const over = {} // bot -> job id it OVERFLOWED into (see OVERFLOW below): a standing assignment, not a per-tick lottery
const declSeen = {} // "job|bot|until" -> ms we first saw that decline note (a note is unique per bot+job+expiry) = the REST rule's 10-min window
const restedAt = {} // job id -> {t, why, ms} of the last rest the dispatcher ordered (the same reason again doubles the rest)
const frontCut = {} // job id -> ms: last time we said out loud that maxFronts left this job unstaffed
const since = {} // bot -> ms when it got its current job (shifts). Survives a dispatcher restart through assign/<bot>.json
if (!DRY) for (const f of fs.readdirSync(P.assign)) { const a = f.endsWith('.json') && readJSON(path.join(P.assign, f), null); if (a && a.bot && a.job && a.job.id && Date.now() - a.t < 120000) { last[a.bot] = a.job.id; since[a.bot] = a.since || a.t } }

// ---- AFTER: build orders run by themselves. `plan-base` writes chains of PAUSED jobs with `after:"<predecessor id>"`; the moment the predecessor is
// FINISHED the successor(s) go active here — nobody waits for an LLM to read "BUILD DONE x -> next: job y active" (that line in `armyctl.js wait`
// uses the same evidence). Finished = the job paused ITSELF as complete (board note `auto-paused: build complete…` / `grid complete`, written by the
// build/light handler after it VERIFIED the world), or a standing repair order reported `build_done standing`, or it was pruned after a *_done report.
// A successor is activated ONCE: only while it is paused WITHOUT a note; the activation writes a note, so a job an operator pauses later stays paused.
// The board write is the CLI's/workers' locked read-modify-write (mkdir jobs.json.lock, tmp + rename) — but never blocking: lock busy = next tick.
function boardEdit (fn) {
  const lock = P.board + '.lock'
  try { fs.mkdirSync(lock) } catch (e) { try { if (Date.now() - fs.statSync(lock).mtimeMs > 8000) fs.rmdirSync(lock) } catch {} return false } // a lock older than 8 s is a dead editor's (same rule as armyctl)
  try { const b = readJSON(P.board, null); if (!b) return false; fn(b); writeJSON(P.board, b, true); return true } catch (e) { log('board edit failed', e && e.message); return false } finally { try { fs.rmdirSync(lock) } catch {} }
}
function finished (b, id) {
  const p = (b.jobs || []).find(j => j.id === id); const ev = doneEv[id]
  if (!p) return ev ? 'pruned after its done report' : null
  if (p.status !== 'active' && /^auto-paused: (build|grid) complete/.test(p.note || '')) return p.note
  // A HANDFUL OF LEFTOVER CELLS IS NOT A REASON TO STOP THE BASE (world 2, 09-19 22:5xZ: 27 healthy bots idle, `tidy` declines x54/10 min, while roads 7-12,
  // pens 3-4 and fields 6-7 stood paused behind predecessors that ended as "auto-paused: 1 cells nobody could do" - or that only wait for torches/a bucket):
  // <= 10 undoable cells, or a job that only waits for MATERIAL (`needs:` note - but never for WATER: a farm behind a dry field is `farm_degrading`, op 23:00Z), lets the successor start. The leftovers stay in the note for the foreman.
  const m = /^auto-paused: (\d+) cells nobody could do/.exec(p.note || ''); if (p.status !== 'active' && m && +m[1] <= 10) return p.note
  if (/^needs: /.test(p.note || '') && !/water/.test(p.note)) return 'predecessor only waits for material (' + String(p.note).slice(0, 60) + ')'
  if (p.status === 'active' && p.params && p.params.standing && ev && ev.standing) return 'standing repair order reported complete'
  return null
}
const successors = b => (b.jobs || []).filter(j => j.after && j.status === 'paused' && !j.note).map(j => ({ j, why: finished(b, j.after) })).filter(x => x.why)
function afterPass (board) {
  tailResults()
  const act = x => { x.j.status = 'active'; x.j.rev = (x.j.rev || 0) + 1; x.j.note = 'auto-activated: `after` ' + x.j.after + ' finished (' + String(x.why).slice(0, 60) + ')' }
  const todo = successors(board); if (!todo.length) return []
  if (DRY) { todo.forEach(act); return todo.map(x => x.j.id + ' (after ' + x.j.after + ': ' + x.why + ')') }
  let done = []
  if (!boardEdit(b => { done = successors(b); done.forEach(act) })) return [] // re-judged on the board read UNDER the lock; busy -> next tick
  for (const x of done) { log('AFTER', x.j.after, 'finished ->', x.j.id, 'active'); try { fs.appendFileSync(P.results, JSON.stringify({ t: Date.now(), bot: 'dispatcher', ev: 'job_activated', job: x.j.id, after: x.j.after, why: x.why }) + '\n') } catch (e) { log('results append failed', e && e.message) } }
  todo.filter(x => done.some(y => y.j.id === x.j.id)).forEach(act) // this tick staffs it already
  return done.map(x => x.j.id)
}

// ---- DEMAND: labour follows the stock deficit, not fixed head-counts (world 1: 9 farmers kept farming on 500 bread while coal was 0 and iron 2).
// A job with `produces:[item|group…]` (groups: stock.js) wants  minBots + ceil((maxBots - minBots) * deficit)  bots,
//   deficit = max over produces of clamp(1 - have/target, 0, 1), target = settings.targets[key], have = chests + carried.
//   No target for a produced key: nobody said how much is enough -> deficit 1 while we own NONE of it, else 0.5 (half a squad), and BOARD.md says
//   "no target" so the operator sets one. target 0 = "we want none": deficit 0. Defaults: minBots 0, maxBots = bots.
// Jobs without `produces`, and jobs that pin `names`, keep their head-count exactly as before. For a producer `minBots` is the demand FLOOR, not
//   the old "don't start under-staffed" gate: two hungry survivors must be allowed to farm although the farm asks for four.
// The FLOOR IS RESERVED before the priority loop (dry run 09-19: forage_spawn 1-2 got 0 bots under a row of higher build jobs until its priority
//   was raised — "never raise priorities to steal bots"): producers in priority order each take minBots FIT bots (hp >= 10, food >= 7, the job's
//   own `requires`). Above the floor a producer competes by priority like everybody, so the sleeper/guards above it are never starved by demand.
// HYSTERESIS (world 1: bots thrown between jobs every minute; mine stays of 70 s against a 140-step commute): (1) after a change the head-count
//   of a job stands for settings.demandHoldMin (3) minutes; (2) it SHRINKS only when the deficit is clearly (BAND) under the step, so stock
//   wobbling around a step (a bot eats a bread, banks a bread) does not toss one bot to and fro; (3) a bot inside its `shiftMin` shift is never
//   sent away by a shrinking demand — the squad shrinks at shift ends (see SHIFTS: cap = maxBots). A board edit (rev/min/max/produces/target)
//   applies at once. The memory survives a restart through status.json (`demand`) — no state file of its own.
const BAND = 0.05
const demand = DRY ? {} : (readJSON(P.status, {}).demand || {}) // job id -> {want, raw, deficit, of, have, target, min, max, at, sig, held}
const produces = job => Array.isArray(job.produces) && job.produces.length && !(job.names && job.names.length)
const steps = (min, max, d) => min + Math.ceil((max - min) * d - 1e-9)
function demandOf (job, S, st) {
  const max = Math.max(0, job.maxBots != null ? job.maxBots : job.bots != null ? job.bots : (job.minBots || 1))
  const min = Math.min(max, Math.max(0, job.minBots || 0))
  const T = S.targets || {}
  let w = null
  for (const key of job.produces) {
    const have = Stock.count(key, st); const target = typeof T[key] === 'number' ? T[key] : null
    const d = target == null ? (have > 0 ? 0.5 : 1) : target <= 0 ? 0 : Math.min(1, Math.max(0, 1 - have / target))
    if (!w || d > w.deficit) w = { deficit: Math.round(d * 100) / 100, of: key, have, target }
  }
  // NO TARGET IS NOT A REASON FOR HALF A SQUAD (docs/REVIEW-early-assumptions.md row 8, measured 09-20: cane_farm held 2 bots for hours on 3020
  // idle cane because "no target" meant deficit 0.5). We own some of it and nobody said how much is enough -> its FLOOR, or one bot, and BOARD.md
  // keeps saying "no target" until the operator sets one. Owning NONE of it still pulls a full squad (deficit 1).
  const raw = w.target == null && w.have > 0 ? Math.max(min, Math.min(1, min + 1)) : steps(min, max, w.deficit)
  const sig = [min, max, job.rev || 0, job.produces.map(k => k + ':' + T[k]).join(',')].join('|')
  const prev = demand[job.id]; const hold = (S.demandHoldMin != null ? S.demandHoldMin : 3) * 60000
  let want = raw; let held = null
  if (prev && prev.sig === sig && prev.want !== raw) {
    if (NOW() - prev.at < hold) { want = prev.want; held = Math.ceil((hold - (NOW() - prev.at)) / 1000) + ' s' } else if (raw < prev.want && steps(min, max, Math.min(1, w.deficit + BAND)) >= prev.want) { want = prev.want; held = 'band' }
  }
  return (demand[job.id] = Object.assign(w, { want, raw, min, max, sig, held, at: prev && prev.sig === sig && prev.want === want ? prev.at : NOW() }))
}
const wantText = d => 'want ' + d.want + ' of ' + d.min + '-' + d.max + ' (deficit ' + d.deficit.toFixed(2) + ' of ' + d.of + ' ' + d.have + '/' + (d.target == null ? 'no target' : d.target) + (d.held ? '; raw ' + d.raw + ' held ' + d.held : '') + ')'

function tick () {
  const board = readJSON(P.board, null)
  if (!board) { log('jobs.json unreadable - keeping assignments'); return }
  declCache = {} // one decline read per bot per tick
  const S = board.settings || {}
  const activated = afterPass(board)
  // string nights are real nights — but ONLY when the army can actually fight one: >= 6 armoured bots with hp >= 10 online. Otherwise sleep
  // (09-19: a string night with 27 hurt bots = nobody fought, nobody slept, everybody stood at muster).
  NIGHT_SKIP = !!S.nightSkip
  WANT_STRING = (S.minString || 0) > 0 && stockOf(['string']) < S.minString
  const t = now()
  const phase = phaseOf(t, S)
  const enlisted = board.enlisted || []
  const hbs = {}
  const quiet = {} // heartbeat 2-10 min old: a shift holder on a long walk (140 stair steps, a bank run) is not "gone" - see SHIFTS
  for (const n of enlisted) { const h = readJSON(path.join(FIELD, 'hb', n + '.json'), null); if (h && (DRY || Date.now() - h.t < 120000)) hbs[n] = h; else if (h && Date.now() - h.t < 600000) quiet[n] = h }
  if (DRY) for (const n of enlisted) if (hbs[n] && hbs[n].job && !(n in last)) { last[n] = hbs[n].job; since[n] = NOW() } // a dry run starts from the jobs the heartbeats name (sticky, shifts)
  const fit = Object.values(hbs).filter(h => h.hp >= 10 && (h.inv || {}).iron_chestplate > 0).length
  const realNight = !NIGHT_SKIP || (WANT_STRING && fit >= 6)
  if (NIGHT_SKIP && realNight) NIGHT_SKIP = false
  if (!DRY) try { const nf = path.join(DIR, 'night.json'); const cur = readJSON(nf, {}); if (cur.real !== realNight || cur.fit !== fit) writeJSON(nf, { real: realNight, fit, wantString: WANT_STRING, t: Date.now() }) } catch {}
  // the fallback sponge can never be paused into idleness
  const jobs = (board.jobs || []).filter(j => j.status === 'active' || j.id === S.fallback).sort((a, b) => (b.priority || 0) - (a.priority || 0))
  const st = Stock.stock(stockOpts())
  const D = {} // this tick's DEMAND per producing job
  for (const job of jobs) if (produces(job)) D[job.id] = demandOf(job, S, st)
  for (const id of Object.keys(demand)) if (!D[id]) delete demand[id]
  const free = new Set(Object.keys(hbs))
  const out = {}
  const fronts = new Set()
  // WORK FRONTS SCALE WITH THE ARMY (docs/REVIEW-early-assumptions.md row 11): the default 3 (board 10) dates from a 3-site world; with 50 bots and
  // 87 jobs an 11th front simply got 0 bots and nobody was told. One front per 4 bots, never under 10, and the cut is logged (once per job per 10 min).
  const maxFronts = Math.max(S.maxFronts || 3, 10, Math.ceil(Object.keys(hbs).length / 4))
  const staffed = {}
  // SHIFTS: a job with `shiftMin: N` keeps the bot that holds it for at least N minutes (a miner's commute down 140 steps is longer than the
  // minute-long stints the priority loop used to hand out) - as long as the job is active, the bot is still eligible, has not declined and the
  // head-count is not exceeded. After N minutes the bot is ordinary (sticky) pool again.
  for (const n of enlisted) {
    const job = jobs.find(j => j.id === last[n])
    if (!job || !job.shiftMin || job.status !== 'active' || NOW() - (since[n] || 0) > job.shiftMin * 60000) continue
    if (!hbs[n] && !quiet[n]) continue
    if ((job.names && !job.names.includes(n)) || (job.exclude && job.exclude.includes(n)) || (hbs[n] && !eligible(job, hbs[n], phase, true)) || declined(job, n)) continue
    const have = staffed[job.id] || (staffed[job.id] = [])
    // DEMAND: cap = maxBots, a shrinking demand waits for the shift's end — EXCEPT at deficit 0 (owner 09-20: herders and farmers sat out a 20-min
    // shift on a full pen / a full larder). Nothing is missing, so the shift ends now and the extra bots are released at this tick.
    if (have.length >= (job.names ? job.names.length : D[job.id] ? (D[job.id].deficit <= 0 ? D[job.id].want : D[job.id].max) : (job.bots || 1))) { if (!have.length) delete staffed[job.id]; continue }
    have.push(n); out[n] = job; free.delete(n)
    if (job.front) fronts.add(job.front)
  }
  // NAMED PLANS CLAIM THEIR BOT (operator 09-19: torch_factory names:[Hina] prio 89 stayed unstaffed for an hour because Hina was one of three
  // interchangeable depot_guards at prio 92). A job that names its bots wants exactly those bots; a squad job can take anybody else. So named
  // jobs are served before the priority loop - unless the bot is on a shift (above), not eligible, or has declined the plan.
  // ...and a bot that is IN THE MIDDLE of a small `steps` plan keeps it until the plan ends (09-19: the crafter of diamond_picks was taken for
  // night_sleeper because it stood nearest to the bed; the torch plan lost its bot 3x in 40 s mid-smelt). Plans end by themselves (pause/decline).
  for (const n of [...free]) {
    const job = jobs.find(j => j.id === last[n])
    if (!job || job.type !== 'steps' || job.status !== 'active' || (job.names ? job.names.length : (job.bots || 1)) > 2 || !hbs[n]) continue
    if ((job.names && !job.names.includes(n)) || !eligible(job, hbs[n], phase, true) || declined(job, n)) continue
    const have = staffed[job.id] || (staffed[job.id] = [])
    if (have.length >= (job.names ? job.names.length : (job.bots || 1))) continue
    have.push(n); out[n] = job; free.delete(n)
  }
  for (const job of jobs) {
    if (!job.names || !job.names.length || job.status !== 'active') continue
    for (const n of job.names) {
      if (!free.has(n) || !hbs[n] || (job.exclude && job.exclude.includes(n)) || !eligible(job, hbs[n], phase, last[n] === job.id) || declined(job, n)) continue
      const have = staffed[job.id] || (staffed[job.id] = [])
      have.push(n); out[n] = job; free.delete(n)
    }
    if (staffed[job.id] && !staffed[job.id].length) delete staffed[job.id]
  }
  // TENURE (09-20 measurement: 982 job_start in 60 min = every bot switched job every 3 minutes; handover banking + walking + kitting ate 13-21 % of all
  // bot time; one bot was re-assigned 12x in 5 min, miners were recalled 2 min after a 2-min commute): every tick all bots were "free" and a higher-
  // priority vacancy simply took the NEAREST one - usually a bot busy on another job. Now a bot that has held a still-active job for less than
  // `settings.tenureMin` (10) minutes is not taken by another job in the first pass (its own job re-claims it, sticky); urgent jobs (priority >= 96)
  // ignore tenure; a second pass hands out whoever is left over - bots their own job no longer wants are free at once, so nobody idles for tenure.
  const TENURE = (S.tenureMin == null ? 10 : S.tenureMin) * 60000
  const activeIds = new Set(jobs.filter(j => j.status === 'active').map(j => j.id))
  // A BOT THAT WAITS IS NOT BUSY (owner 09-20): tenure protects productive work, never a farmer standing in a grown-out field or a herder whose pen
  // has nothing to breed - the heartbeat's own task text says so, and such a bot is free game for any job at any time.
  const IDLE_TASK = /waiting for growth|nobody ready to breed|no open work|nothing open|handed back|declined|muster/i
  const busy = n => !IDLE_TASK.test(String((hbs[n] || {}).task || ''))
  const young = (n, job) => !!last[n] && last[n] !== job.id && last[n] !== S.fallback && activeIds.has(last[n]) && NOW() - (since[n] || 0) < TENURE && busy(n)
  let tenurePass = true
  // A JOB THAT TURNS BOTS AWAY IS FULL (09-20 07:35Z: the tenure rule changed nothing - 846 switches/h - because the churn is DECLINE-driven: `base_field_1
  // "the rest waits for a water cell in work"` declined by 37 bots x63 in a few minutes, herd_cows/herd_chickens "nobody ready to breed" x8 each, finished
  // infill tiles "build: complete": every decline only excluded THAT bot, so the dispatcher fed the job the next one, and the next…). While >= 3 bots hold
  // an unexpired decline note for a job (same rev), the job gets no NEW bots - only those who already work it stay.
  const declineCount = {}
  const declWhy = {} // job id -> normalised reason -> Set of bots that declined it for that reason within the last 10 min
  const tNow = Date.now()
  for (const n of enlisted) {
    for (const [id, e] of Object.entries(declMap(n))) {
      const j = jobs.find(q => q.id === id)
      if (!j || !e || !(e.until > tNow) || (e.rev || 0) !== (j.rev || 0)) continue
      declineCount[id] = (declineCount[id] || 0) + 1
      const key = id + '|' + n + '|' + e.until
      if (!declSeen[key]) declSeen[key] = tNow
      if (tNow - declSeen[key] > 600000) continue
      const why = String(e.why || '').replace(/\d+/g, '#').slice(0, 40) // "sheep 67/60 … nobody ready to breed" and "sheep 60/60 …" are ONE reason
      const w = declWhy[id] = declWhy[id] || {}
      ;(w[why] = w[why] || new Set()).add(n)
    }
  }
  for (const k of Object.keys(declSeen)) if (tNow - declSeen[k] > 1800000) delete declSeen[k]
  const saturated = job => (declineCount[job.id] || 0) >= 3
  const headOf = j => j.names ? j.names.length : D[j.id] ? D[j.id].want : (j.bots == null ? 1 : j.bots)
  const crew = {} // active job id -> the ONLINE bots that held it when this tick started (who a job may be drained of, and who still works it)
  for (const n of Object.keys(hbs)) if (last[n] && activeIds.has(last[n])) (crew[last[n]] = crew[last[n]] || []).push(n)
  // A JOB THAT NOBODY CAN DO RESTS - it is not refilled with the next bot (09-20: `base_field_1 "build: the rest waits for a water cell in work"`
  // was declined 23x, herd_sheep "nobody ready to breed" 14x, tidy_spawn "nothing open" 17x: every decline only excluded THAT bot, the dispatcher fed
  // the job the next one, and the muster<->fallback ping-pong alone made 285+284 of 1210 moves an hour). >= 3 bots decline with the SAME reason inside
  // 10 min AND the job showed no OUTPUT in those 5 min -> the JOB rests 10 min (the `restUntil` mechanism the herd/cane handlers already use).
  // Urgent jobs (>= 96) and producing jobs are never rested, so this can never eject somebody who IS producing.
  for (const job of jobs) {
    if ((job.priority || 0) >= 96 || job.status !== 'active') continue
    if ((job.restUntil || 0) > tNow) continue
    const w = declWhy[job.id]; if (!w) continue
    const worst = Object.entries(w).sort((a, b) => b[1].size - a[1].size)[0]
    if (!worst || worst[1].size < 3) continue
    // …but never rest a job that is actually PRODUCING (resting ejects its holders too). Measured output, not "somebody has not declined yet":
    // a job refilled every minute always has one fresh bot without a note, which kept base_portal/base_dorm_pad cycling bots all morning.
    if ((outAt[job.id] || []).some(x => x >= tNow - 300000)) continue
    // BACKOFF: a fixed 10-min rest turned the sponge into a metronome (11:37-11:47: `muster -> tidy_spawn x17` the moment the rest ran out,
    // although the audit work list it waits for is only rebuilt every ~30 min). Each rest for the SAME reason doubles, capped at an hour.
    const r = restedAt[job.id]; const same = r && r.why === worst[0] && tNow - r.t < r.ms + 900000
    const ms = Math.min(1800000, same ? r.ms * 2 : 600000)
    restedAt[job.id] = { t: tNow, why: worst[0], ms }; job.restUntil = tNow + ms
    log('REST', job.id, worst[1].size + ' bots declined "' + worst[0] + '" in 10 min -> rests ' + Math.round(ms / 60000) + ' min')
    if (!DRY) boardEdit(b => { const j = (b.jobs || []).find(q => q.id === job.id); if (j) j.restUntil = Date.now() + ms })
  }
  // TENURE THAT HOLDS (09-20: the soft tenure above changed nothing - the SECOND pass ignored it altogether, and `last[n] !== S.fallback` made every
  // bot sitting in the sponge free game, which is how tidy_spawn <-> muster became the top two flows). A bot younger than tenureMin in a job that
  // SHOWED OUTPUT in the last 15 min (same bookkeeping as the yield throttle) is taken by NO job under priority 96, in either pass. Exceptions that
  // must stay: urgent jobs (>= 96) and the producers' reserved minBots FLOOR - a starving army may always re-man its food/iron floor.
  const producing = id => { const a = outAt[id]; return !!(a && a.length && a[a.length - 1] >= tNow - 900000) }
  const holdFast = (n, job) => (job.priority || 0) < 96 && !!last[n] && last[n] !== job.id && last[n] !== S.fallback && activeIds.has(last[n]) && NOW() - (since[n] || 0) < TENURE && producing(last[n]) && busy(n)
  // …and a squad is never drained below HALF its head-count by a job under 96: small jobs of priority 84-98 used to pull the 16-bot ravine squads
  // apart within 2-5 min (fill_ravine_n: 62 in / 63 out an hour, held 0-1 bots of 16).
  const drained = {}
  const drainable = (n, job) => {
    const src = last[n]
    if (!src || src === job.id || src === 'muster' || src === S.fallback || !activeIds.has(src) || (job.priority || 0) >= 96) return true
    const s = jobs.find(j => j.id === src); if (!s) return true
    return (crew[src] || []).length - (drained[src] || 0) > Math.floor(headOf(s) / 2)
  }
  // staff(job, head, floor): bring the job up to `head` bots from the free pool — the ONE way squads are filled (floor pass + priority loop)
  const staff = (job, head, floor) => {
    const front = job.front || null
    if (front && !fronts.has(front) && fronts.size >= maxFronts) { if (Date.now() - (frontCut[job.id] || 0) > 600000) { frontCut[job.id] = Date.now(); log('FRONT CUT', job.id, 'front', front, 'gets 0 bots:', fronts.size, 'of', maxFronts, 'fronts are staffed (' + [...fronts].join(',') + ') - raise settings.maxFronts or pause a front') } return }
    if (head <= 0) return
    const yc = yieldCap[job.id]; if (yc && yc.until > Date.now()) head = Math.min(head, yc.cap) // YIELD THROTTLE: a squad without output is cut by itself
    const want = head - (staffed[job.id] || []).length
    if (want <= 0) return
    const pool = [...free].filter(n => !(saturated(job) && last[n] !== job.id) && !(tenurePass && (job.priority || 0) < 96 && young(n, job)) && !(!floor && holdFast(n, job)) && drainable(n, job) && (!job.names || job.names.includes(n)) && (!job.exclude || !job.exclude.includes(n)) && eligible(job, hbs[n], phase, last[n] === job.id) && !declined(job, n) && (!floor || ((hbs[n].hp == null || hbs[n].hp >= 10) && (hbs[n].food == null || hbs[n].food >= 7))))
    // WHERE A JOB TAKES ITS BOTS FROM (09-20): sticky first, then the bots nobody is using - muster, the fallback sponge, an overflow hold - and only
    // then somebody else's squad: the LOWEST priority one holding the MOST bots. Within each source the bot NEAREST to the site (heartbeat pos).
    const R = job.requires || {}
    const srcOf = n => jobs.find(j => j.id === last[n])
    const rank = n => { const s = last[n]; if (s === job.id) return 0; if (!s || s === 'muster' || !activeIds.has(s)) return 1; if (s === S.fallback) return 2; if (over[n] === s) return 3; return 4 }
    pool.sort((a, b) => (carries(R, hbs[b]) - carries(R, hbs[a])) || (rank(a) - rank(b)) ||
      (rank(a) === 4 ? (((srcOf(a) || {}).priority || 0) - ((srcOf(b) || {}).priority || 0)) || ((crew[last[b]] || []).length - (crew[last[a]] || []).length) : 0) ||
      (dist(hbs[a], job.site) - dist(hbs[b], job.site)))
    const carriers = pool.filter(n => carries(R, hbs[n])).length
    const take = pool.slice(0, R.anyItem ? Math.min(want, carriers + stockOf(R.anyItem)) : want)
    if (process.env.DISPATCH_DEBUG && job.id === process.env.DISPATCH_DEBUG) log('DEBUG', job.id, floor ? 'FLOOR' : '', 'free', free.size, 'pool', pool.length, 'want', want, 'take', take.length, 'phase', phase, 'front', front, 'fronts', [...fronts].join(','))
    if (job.minBots && !D[job.id] && take.length + (staffed[job.id] || []).length < job.minBots) return // producers: minBots is the demand floor, not a start gate (see DEMAND)
    for (const n of take) { out[n] = job; free.delete(n); const src = last[n]; if (src && src !== job.id && src !== S.fallback && activeIds.has(src)) drained[src] = (drained[src] || 0) + 1 }
    if (take.length) { staffed[job.id] = (staffed[job.id] || []).concat(take); if (front) fronts.add(front) }
  }
  for (const job of jobs) if (D[job.id] && D[job.id].min > 0) staff(job, Math.min(D[job.id].min, D[job.id].want), true) // FLOORS first (see DEMAND)
  for (const job of jobs) staff(job, job.names ? job.names.length : D[job.id] ? D[job.id].want : (job.bots == null ? 1 : job.bots), false)
  tenurePass = false // second pass: the leftovers (bots no job re-claimed) fill whatever is still short, tenure or not
  for (const job of jobs) staff(job, job.names ? job.names.length : D[job.id] ? D[job.id].want : (job.bots == null ? 1 : job.bots), false)
  try { yieldPass(jobs, staffed) } catch (e) { log('yieldPass error', e && e.message) }
  const muster = { id: 'muster', type: 'muster' }
  // OVERFLOW instead of ping-pong (09-20: muster -> tidy_spawn 285x and tidy_spawn -> muster 284x an hour - the fallback has no open work most of
  // the time, declines, the bot musters, the 10-min decline expires and it is sent straight back; meanwhile fill_ravine_n wanted 16 and held 0-1).
  // A bot nobody wants joins a REAL squad: an active squad job (a handler that scales by algorithm, head-count >= 3, no `names`, not resting, not
  // saturated by declines, the bot fits its `requires`) with the most work left relative to its head-count - the dispatcher cannot count blueprint
  // cells, so "work left" = it produced something in the last 15 min AND it is short of its head-count - and among those the NEAREST to the bot.
  // The overflow goes BEYOND the job's head-count on purpose (数の暴力) and it STANDS: `over[n]` is re-claimed every tick until the job ends,
  // rests, pauses or declines the bot, so an overflow bot is as stable as a staffed one (tenure/holdFast protect it from jobs under 96).
  // ONLY WORK THAT CAN USE MORE HANDS (owner 09-20 on the field: "畑でサボってるやつ居る" - 9 bots stood on farm jobs, 5 of them "farm: waiting for
  // growth", while food was 9590 against a target of 448: a field does not grow faster with more farmers, and a pen does not breed faster). Overflow
  // goes ONLY into terrain/squad work that scales with head-count, NEVER into farm/cane/herd/hunt/guard/scan/fish, NEVER into a `produces` job whose
  // deficit is 0, and only while the job has cells left for the extra hand: 20 open cells (`build_pass.left`) per bot already on it.
  const SQUAD = /^(build|deck|lumber|light|tidy|ores)$/
  const roomFor = job => {
    const held = Math.max(1, (staffed[job.id] || []).length); const head = Math.max(1, headOf(job)); const w = workLeft[job.id]; const y = yieldCap[job.id]
    if (y && y.until > Date.now() && held >= y.cap) return false // a squad the YIELD THROTTLE cut is the last place for another bot
    // the gate is measured against the job's HEAD-COUNT, not against the bots already on it: a per-bot threshold moves every time somebody joins,
    // which left 16 bots standing at muster in the dry run while a ravine with 150 open cells was called "full". How many bots the site can really
    // employ is then MEASURED by the yield throttle above (output per bot), not guessed here.
    if (w && Date.now() - w.t < 600000) return w.left > 20 * head
    return producing(job.id) && held < 2 * head // handlers that report no cell count (lumber, light, tidy): never more than double
  }
  // CAPACITY GATES ONLY BAR NEWCOMERS, never the bots already inside (12:00: saturation and the yield cap were tested against the standing holders
  // too, so the moment 3 of 25 bots held a decline note the whole overflow squad was evicted to muster and walked back next tick - 50 tidy -> muster
  // and 25 fill_ravine_s <-> muster in 10 min). Same rule the priority loop has always used for sticky bots.
  const overFit = (job, n) => !!job && job.status === 'active' && SQUAD.test(job.type) && !(job.names && job.names.length) && !((job.restUntil || 0) > Date.now()) &&
    !(saturated(job) && last[n] !== job.id) && ((job.bots || 0) >= 3 || (job.maxBots || 0) >= 3) && headOf(job) > 0 && !(D[job.id] && D[job.id].deficit <= 0) &&
    !(job.front && !fronts.has(job.front) && fronts.size >= maxFronts) && !(job.exclude && job.exclude.includes(n)) && eligible(job, hbs[n], phase, last[n] === job.id) && !declined(job, n)
  // roomFor gates only a NEW overflow, never a standing one: it counts the bots placed THIS tick, so testing it again next tick made
  // fill_ravine_s and fill_ravine_m swap bots 11x in 10 min (11:47). A hold ends when the job ends, rests, saturates or declines the bot.
  const pickOverflow = n => {
    const c = jobs.filter(j => overFit(j, n) && roomFor(j)).map(j => { const head = Math.max(1, headOf(j)); return { j, t: producing(j.id) ? 1 : 0, s: (head - (staffed[j.id] || []).length) / head, d: dist(hbs[n], j.site) } })
    c.sort((a, b) => (b.t - a.t) || (Math.round(b.s * 4) - Math.round(a.s * 4)) || (a.d - b.d))
    return c.length ? c[0].j : null
  }
  const join = (n, job) => { out[n] = job; (staffed[job.id] = staffed[job.id] || []).push(n); if (job.front) fronts.add(job.front) }
  // STANDBY IS FORBIDDEN (owner 09-19): a bot no job wants goes to settings.fallback (a sponge job that always has work), whatever its hp/kit —
  // unless it declined that too a moment ago, or the fallback itself rests (REST rule above), or it already holds an overflow squad.
  // THE SPONGE IS NOT A WAYPOINT (09-20 measurement after the first cut: churn fell 1203 -> ~850/h only, and the top flows were
  // `tidy_spawn -> fill_ravine_s x13` against `fill_ravine_m -> tidy_spawn x10` per 10 min: a bot handed back by a finished build tile walked to
  // the sponge at base and was recruited into a real squad on the NEXT tick = two walks and two handovers for one move). So a bot nobody wants
  // is offered the OVERFLOW squad first and the sponge only when no squad has cells for it - the sponge still gets its own head-count from the
  // priority loop above, and it stays the last stop before muster, because standby is forbidden (owner 09-19).
  const fb = S.fallback && (board.jobs || []).find(j => j.id === S.fallback)
  for (const n of enlisted) {
    // ...but never a DYING bot (foreman 09-19: hp1/food0 bots were sent down the 140-step shaft while 179 bread sat in the depot): under
    // hp 10 / food 7 (or under the fallback's own `requires`) the bot musters on the surface, where the canteen reflex feeds and heals it.
    const h = hbs[n]; const rq = (fb && fb.requires) || {}
    const fitWork = !!h && (h.hp == null || h.hp >= 10) && (h.food == null || h.food >= 7)
    const fitFb = !!h && (h.hp == null || h.hp >= Math.max(10, rq.minHp || 0)) && (h.food == null || h.food >= Math.max(7, rq.minFood || 0))
    if (!out[n] && fitWork) {
      const hold = over[n] === last[n] ? jobs.find(j => j.id === over[n]) : null
      const j = hold && overFit(hold, n) ? hold : pickOverflow(n)
      if (j) { over[n] = j.id; join(n, j) } else if (fb && fitFb && !((fb.restUntil || 0) > Date.now()) && !declined(fb, n)) { out[n] = fb; (staffed[fb.id] = staffed[fb.id] || []).push(n) }
    }
    const job = out[n] || muster
    if (over[n] && over[n] !== job.id) delete over[n]
    const changed = last[n] !== job.id
    if (changed || Date.now() - (lastWrite[n] || 0) > 15000) {
      if (changed) since[n] = NOW()
      if (!DRY) writeJSON(path.join(P.assign, n + '.json'), { bot: n, t: Date.now(), since: since[n] || 0, time: t, phase, job: { id: job.id, type: job.type, site: job.site, params: job.params, rev: job.rev || 0, plan: job.plan, names: job.names } })
      lastWrite[n] = Date.now()
      if (changed && hbs[n] && !DRY) { log('ASSIGN', n, (last[n] || '-') + ' -> ' + job.id); assigns.push({ t: Date.now(), from: last[n] || '-', to: job.id }) }
      last[n] = job.id
    }
  }
  return { board, S, t, phase, hbs, staffed, enlisted, D, st, activated }
}

const stockLine = ctx => 'stock vs targets: ' + (Object.entries(ctx.S.targets || {}).map(([k, n]) => k + ' ' + Stock.count(k, ctx.st) + '/' + n).join(' · ') || 'settings.targets is empty - producers run on "no target" guesses')
function report (ctx) {
  if (!ctx) return
  tailResults()
  const H = Date.now() - 3600000
  const deaths1h = events.filter(e => e.ev === 'death' && e.t > H)
  const byJob = {}
  for (const e of events) {
    if (e.ev !== 'banked') continue
    const j = byJob[e.job || '?'] = byJob[e.job || '?'] || { total: {}, h1: {} }
    for (const [k, n] of Object.entries(e.items || {})) { j.total[k] = (j.total[k] || 0) + n; if (e.t > H) j.h1[k] = (j.h1[k] || 0) + n }
  }
  const status = {
    t: new Date().toISOString(), time: ctx.t, phase: ctx.phase, clockOk: clock.ok, enlisted: ctx.enlisted.length, online: Object.keys(ctx.hbs).length,
    deaths1h: deaths1h.length, deathsByJob: deaths1h.reduce((m, e) => { m[e.job || '?'] = (m[e.job || '?'] || 0) + 1; return m }, {}),
    staffed: ctx.staffed, output: byJob,
    targets: Object.fromEntries(Object.entries(ctx.S.targets || {}).map(([k, n]) => [k, { have: Stock.count(k, ctx.st), target: n }])), demand // WHY each producer has its head-count (and the hysteresis memory, read back at start)
  }
  const ch = churnStat() // CHURN: one number that shows whether the army works or walks (see above)
  Object.assign(status, ch)
  if (Date.now() - churnLog > 600000) { churnLog = Date.now(); log('CHURN', ch.assignsPerHour + '/h ' + ch.assigns10min + '/10min |', ch.churnFlows.join(' · ') || 'no moves') }
  writeJSON(P.status, status, true)
  const lines = ['# ARMY BOARD  ' + status.t + '  time ' + ctx.t + ' (' + ctx.phase + ')  enlisted ' + status.enlisted + ' online ' + status.online + '  deaths/1h ' + status.deaths1h + '  assigns/h ' + ch.assignsPerHour, '']
  lines.push(stockLine(ctx), '')
  lines.push('| pri | job | type | front | status | plan | staffed | banked 1h |', '|---|---|---|---|---|---|---|---|')
  for (const j of (ctx.board.jobs || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
    const o = byJob[j.id] ? Object.entries(byJob[j.id].h1).map(([k, n]) => k + ':' + n).join(' ') : ''
    // DEMAND is shown INSIDE the staffed cell (ops/status.sh cuts this table by column position): "3 want 7 of 2-9 (deficit 0.62 of coal 49/128): A B C"
    const who = (ctx.staffed[j.id] || []).join(' '); const d = ctx.D[j.id]
    lines.push('| ' + [j.priority || 0, j.id, j.type, j.front || '-', j.status + (j.after && j.status === 'paused' && !j.note ? ' (after ' + j.after + ')' : ''), j.plan || '-', d ? (ctx.staffed[j.id] || []).length + ' ' + wantText(d) + (who ? ': ' + who : '') : who || '-', o || '-'].join(' | ') + ' |')
  }
  lines.push('', '| bot | job | hp | food | pos | task | age s |', '|---|---|---|---|---|---|---|')
  for (const n of ctx.enlisted) {
    const h = ctx.hbs[n]
    lines.push(h ? '| ' + [n, last[n], h.hp, h.food, (h.pos || []).join(','), h.task, Math.round((Date.now() - h.t) / 1000)].join(' | ') + ' |' : '| ' + n + ' | ' + (last[n] || '-') + ' | OFFLINE/no heartbeat |||||')
  }
  fs.writeFileSync(P.md + '.tmp', lines.join('\n') + '\n'); fs.renameSync(P.md + '.tmp', P.md)
}

// DRY RUN: the same tick() against a board file and fake fields; prints who would work where and WHY. Writes nothing, asks no server (time = noon).
function dry () {
  const args = DRY.slice(1).length ? DRY.slice(1) : [DIR]; let k = 0
  for (const a of args) {
    if (/^\+\d+$/.test(a)) { SKEW += +a * 60000; continue }
    FIELD = path.resolve(a)
    const ctx = tick(); if (!ctx) { console.log('cannot read board ' + P.board); process.exitCode = 1; return }
    console.log('--- dry tick ' + (++k) + ': field ' + FIELD + '  clock +' + SKEW / 60000 + ' min  ' + ctx.phase + '  online ' + Object.keys(ctx.hbs).length + '/' + ctx.enlisted.length)
    console.log(stockLine(ctx))
    if (ctx.activated.length) console.log('AFTER: would activate ' + ctx.activated.join(' · '))
    for (const j of (ctx.board.jobs || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
      const who = ctx.staffed[j.id] || []; if (j.status !== 'active' && !who.length) continue
      const d = ctx.D[j.id]
      console.log(String(j.priority || 0).padStart(4) + ' ' + String(j.id).padEnd(16) + String(j.type).padEnd(9) + String(who.length).padStart(3) + '  ' + (d ? wantText(d) : j.names ? 'names ' + j.names.length : 'bots ' + (j.bots == null ? 1 : j.bots)) + (j.shiftMin ? '  shift ' + j.shiftMin + ' min' : '') + '\n' + ' '.repeat(34) + (who.join(' ') || '-'))
    }
    const idle = ctx.enlisted.filter(n => last[n] === 'muster'); console.log('     muster          ' + String(idle.length).padStart(12) + '  ' + idle.join(' '))
  }
}
// JOB LABELS in the bots' NAME PREFIX (owner 09-20; a label floating at the shoulder was hard to read): every bot has its own team b_<Name>, made by
// ops/modes-pack.sh; the dispatcher - who knows every bot's job from the heartbeats - writes the team prefix "[採掘] " through rcon:
// only labels that CHANGED (every 10 s), plus a full refresh every 2 min so a label left behind by a death or relog is re-mounted.
const labelSent = {}; let labelFull = 0
// short JAPANESE names (owner: "日本語の短い呼び名にして"): by job id first, then by job type
const JOB_JA = [[/^mine_obsidian/, '黒曜石'], [/^mine_/, '採掘'], [/^fill_ravine/, '渓谷埋め'], [/^fill_|_void/, '穴埋め'], [/^base_infill|_pad$/, '整地'], [/^base_road/, '道路'], [/^base_cane|^cane/, 'サトウキビ'], [/^base_field/, '畑づくり'], [/^base_dorm/, '寮づくり'], [/^base_/, '建築'],
  [/^herd_sheep/, '羊の世話'], [/^herd_cows/, '牛の世話'], [/^herd_chickens/, '鶏の世話'], [/^herd_pigs/, '豚の世話'], [/^hunt/, '狩り'], [/^quartermaster/, '補給係'], [/^sleeper/, '就寝係'], [/^guard/, '警備'], [/^tidy/, '片付け'], [/^farm/, '畑'], [/^fish/, '釣り'],
  [/^wood|^lumber/, '伐採'], [/^scout/, '偵察'], [/^toolsmith|^craft_|^smelt/, '工作'], [/^bake/, 'パン焼き'], [/^enchant/, 'エンチャント'], [/^muster$/, '待機']]
const TYPE_JA = { build: '建築', farm: '畑', cane: 'サトウキビ', herd: '牧畜', hunt: '狩り', guard: '警備', scan: '補給係', tidy: '片付け', lumber: '伐採', fish: '釣り', scout: '偵察', steps: '作業', delegate: '採掘', sleeper: '就寝係', ores: '鉱石拾い', light: '照明', haul: '運搬' }
const TASK_JA = [[/muster|handed back|declined/, '待機'], [/bank|stash/, '預け入れ'], [/withdraw|getting|fetch/, '取り出し'], [/travel|goto|walking|to-face|to-entrance|trunk/, '移動'], [/craft|forg/, 'クラフト'], [/furnace|smelt|cook/, 'かまど'], [/sleep|bed/, '睡眠'], [/eat|canteen/, '食事'], [/shear/, '毛刈り'], [/cull|kill|hunt:work|guard: /, '戦闘'], [/breed|lur|herd/, '誘導'], [/stairs|surface/, '階段'], [/branch|vein|mine|dig/, '掘削'], [/water/, '水入れ'], [/fell|lumber/, '伐採'], [/plant|till|farm|harvest/, '農作業'], [/waiting/, '成長待ち']]
function labelPass () {
  try {
    const full = Date.now() - labelFull > 120000; if (full) labelFull = Date.now()
    const board = readJSON(P.board, {}) || {}; const typeOf = {}; for (const j of board.jobs || []) typeOf[j.id] = j.type
    const cmds = []
    for (const f of fs.readdirSync(path.join(FIELD, 'hb'))) {
      const h = readJSON(path.join(FIELD, 'hb', f), null); if (!h || !h.bot || Date.now() - (h.t || 0) > 90000) continue
      const job = String(h.job || 'muster'); const ja = (JOB_JA.find(([re]) => re.test(job)) || [])[1] || TYPE_JA[typeOf[job]] || job.slice(0, 12)
      const task = String(h.task || ''); const tj = (TASK_JA.find(([re]) => re.test(task)) || [])[1]
      const label = ja // the NAME PREFIX must stay short (it widens every chat line and the tab list): the job only; the task stays in `armyctl.js field`
      if (!full && labelSent[h.bot] === label) continue
      labelSent[h.bot] = label
      cmds.push('team modify b_' + h.bot.replace(/[^A-Za-z0-9_]/g, '') + ' prefix {"text":"[' + label + '] ","color":"aqua"}')
    }
    for (let i = 0; i < cmds.length; i += 25) execFile('node', [path.join(DIR, '..', 'rcon.js'), ...cmds.slice(i, i + 25)], { timeout: 15000 }, () => {})
  } catch (e) { log('labelPass error', e && e.message) }
}
if (DRY) dry()
else {
  log('dispatcher up, pid', process.pid)
  pollTime()
  setInterval(pollTime, 20000)
  setInterval(labelPass, 10000)
  let n = 0
  setInterval(() => {
    try { const ctx = tick(); if (n++ % 4 === 0) report(ctx) } catch (e) { log('tick error', e && e.stack || e) }
  }, 5000)
}
