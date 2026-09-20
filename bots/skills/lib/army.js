// army.js — worker-side library of the ONE ARMY.
// Small, defensive, file-based. Everything shared between processes lives in bots/army/*.json (atomic tmp+rename).
// Add a primitive only after it worked in the lab or in a controlled production test (note the result in docs/GOALS.md Log).
const fs = require('fs')
const swallow = require('./swallow')
const path = require('path')
const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const U = require('./util')
const C = require('./craft')

const DIR = path.join(__dirname, '..', '..', 'army')
const F = {
  board: path.join(DIR, 'jobs.json'),
  chests: path.join(DIR, 'chests.json'),
  results: path.join(DIR, 'results.jsonl'),
  hb: n => path.join(DIR, 'hb', n + '.json'),
  assign: n => path.join(DIR, 'assign', n + '.json')
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ------------------------------------------------------------------ files
function readJSON (f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return dflt } }
function writeJSON (f, d) {
  const tmp = f + '.tmp' + process.pid + '_' + Math.floor(Math.random() * 1e6)
  try { fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, f); return true } catch (e_) { swallow('army:writeJSON ' + path.basename(f), e_); try { fs.unlinkSync(tmp) } catch (e2) { /* the tmp file was never created */ } return false }
}
function result (bot, rec) {
  try { fs.appendFileSync(F.results, JSON.stringify(Object.assign({ t: Date.now(), bot: bot.username }, rec)) + '\n') } catch (e_) { swallow('army:27', e_) }
  try { speak(bot, rec) } catch (e_) { swallow('army:28', e_) }
}

// ---- bots TALK about what they start and finish (owner's wish) — LLM-free: short Japanese lines from templates, picked per event.
// Spam guard across all 10 processes: one line per 3 s army-wide (bots/army/say.json), one line per bot per 45 s, settings.talk=false mutes.
const JOBNAME = [[/^g2_iron|mine/, '採掘'], [/fish/, '釣り'], [/berr/, 'ベリー摘み'], [/farm/, '畑仕事'], [/deck|yard/, '拠点の穴ふさぎ'], [/lumber/, '木こり'], [/scout/, '偵察'], [/sheep|hunt/, '羊さがし'], [/night_watch|guard/, '夜の見張り'],
  [/toolsmith|tools/, '道具づくり'], [/smelt/, '精錬'], [/haul/, '荷運び'], [/qm_|warehouse/, '倉庫係'], [/pw_light|torch/, '明かりの設置'], [/pw_fill|pits/, '穴埋め'], [/pw_rm|pillar/, '柱の片付け'], [/out_/, '前哨地づくり'], [/depot|workshop|chest/, '倉庫づくり'], [/wall/, '防壁づくり'], [/level|seichi|tidy/, '整地'], [/house|shelter|build/, '建築'], [/water/, '水くみ']]
function jobName (id) { for (const [re, n] of JOBNAME) if (re.test(String(id))) return n; return '作業（' + String(id) + '）' }
const pick = a => a[Math.floor(Math.random() * a.length)]
function lineFor (bot, r) {
  let t = lineText(bot, r)
  if (!t) return null
  // the owner reads this as a human: short lines, no bracketed details (coordinates are in the hover text of the name)
  t = t.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/[-\d]+,[-\d]+(,[-\d]+)?/g, '').replace(/\s+/g, ' ').replace(/[：:、\s]+$/, '').trim()
  if (t.length > 40) t = t.slice(0, 40) + '…'
  const tag = /hedge_damaged|structure_damaged|crops_vanished|flood|legacy_remove_failed|legacy_open_failed|bank_unreachable|place_failed|build_blocked|chest_missing|stranded|hung|plan_failed|death|no_route|chest_full|sleep_failed|bed_missing|scout_lost|error|travel_fail|declined|plan_idle/.test(r.ev) ? '[警告] ' : /pockets|tidy_pass|smelted|legacy_drained|legacy_chest_removed|build_pass|build_done|irrigated|kitted|chest_added|chest_rebuilt|creeper|plan_done|deck_done|depot_ready|light_done|slept|banked|hauled|cooked|torch|farm_pass|deck_pass|fish_session|guard_pass|scout_trip/.test(r.ev) ? '[成果] ' : '[情報] '
  return tag + t
}
function lineText (bot, r) {
  const j = jobName(r.job)
  switch (r.ev) {
    case 'death': return 'やられました…（' + j + '中、' + (r.pos || []).join(',') + '）'
    case 'declined': return j + 'は今できません：' + String(r.why || '').replace(/^[a-z_ ]+: /, '').slice(0, 50)
    case 'travel_fail': return '目的地に着けません（' + (r.to || []).filter(v => v != null).join(',') + '、残り' + r.d + 'm）'
    case 'plan_idle': return j + '：やることがなくなりました（材料切れ？）'
    case 'step': return r.ok ? null : j + 'の手順' + r.i + '（' + r.do + '）失敗：' + String(r.why).slice(0, 50)
    case 'irrigated': return '畑に水を引きました ' + (r.at || []).join(',') + '（残り' + r.left + 'か所）'
    case 'pockets': return r.n >= 16 ? 'ポケットの中身を倉庫に片付けました' : null
    case 'crown_felled': return '宙に浮いた木を片付けました'
    case 'tidy_pass': return (r.pillars + r.holes + r.floats) > 0 ? '整地：柱' + r.pillars + '本・穴' + r.holes + 'か所・浮きブロック' + r.floats + '個を片付けました' : null
    case 'build_pass': return r.done >= 8 ? '建築（' + r.blueprint + '）：' + r.done + 'ブロック進みました、残り' + r.left : null
    case 'build_done': return '建築が完成しました！（' + r.blueprint + '）'
    case 'place_failed': return 'ブロックを置けませんでした（' + r.item + ' @' + (r.at || []).join(',') + '）：' + r.why + '／試したこと：' + (r.tried || []).join('→')
    case 'build_blocked': return '建築が止まっています：' + r.why
    case 'berry_trip': return 'ベリーを' + r.picked + '個つんできました（納品' + r.banked + '）'
    case 'hedge_demolished': return 'ベリー畑を解体中：' + r.removed + '個撤去、残り' + r.left
    case 'berries_roofed': return 'ベリーの茂みに屋根を' + r.n + '個かけました（中に入れなくなります）'
    case 'berries_moved': return '通路にあった茂みを' + r.n + '株どかしました'
    case 'berries_planted': return 'ベリーの苗を' + r.n + '株うえました'
    case 'string_night': return '今夜は寝ずにクモ狩りです（糸を' + r.need + '本集めます）'
    case 'help_asked': return '困りました、相談します'
    case 'help_done': return r.ok ? '助言どおりにやって解決しました' : '助言を試しましたがダメでした'
    case 'kitted': return '装備を受け取りました：' + (r.items || []).join(', ')
    case 'torch': return '松明を置きました ' + (r.at || []).join(',') + '（' + r.n + '本目）'
    case 'light_done': return '照明の設置、完了しました！'
    case 'rescue_kill': return 'ハングしていたので神の手でリスポーンします'
    case 'error': return 'プログラムエラー：' + String(r.err).slice(0, 60)
    case 'stashed': return '現場チェストに入れました'
    case 'in_bed': return 'おやすみなさい…（朝まで飛ばします）'
    case 'slept': return r.own ? null : 'おはようございます！朝です' // own:true = a bot's own rest in its dorm bed (every bot sleeps, 09-20): 16 good-mornings a night are chat spam
    case 'job_start': if (r.job === 'muster') return Math.random() < 0.3 ? pick(['いったん集合します', '手が空きました、待機します', '戻りました〜']) : null
      return pick([j + '、はじめます！', j + 'に行ってきます', 'これから' + j + 'です', j + '、まかせて'])
    case 'plan_done': return pick([j + '、終わりました！', j + '完了です', 'できました（' + j + '）'])
    case 'plan_failed': return pick([j + 'でつまずきました…（' + String(r.do) + '）', 'うーん、' + j + 'がうまくいきません'])
    case 'banked': { const e = Object.entries(r.items || {}).sort((a, b) => b[1] - a[1])[0]; return e && e[1] >= 8 ? pick(['納品しました：' + e[0] + ' ×' + e[1], e[0] + 'を' + e[1] + '個、倉庫に入れました']) : null }
    case 'fish_session': return r.st && r.st.catches >= 4 ? pick(['魚が' + r.st.catches + '匹つれました', 'いい釣果です（' + r.st.catches + '匹）']) : null
    case 'farm_pass': return r.st && (r.st.planted + r.st.harvested) > 0 ? '畑：植え付け' + r.st.planted + '、収穫' + r.st.harvested : null
    case 'deck_pass': return r.placed >= 8 ? '穴ふさぎ、' + r.placed + 'ブロック敷きました（残り' + r.left + '）' : null
    case 'deck_done': return '拠点の穴、ふさぎ終わりました！'
    case 'scout_depart': return pick(['偵察に出ます（方位' + r.bearing + '°）', 'ちょっと遠くを見てきます'])
    case 'scout_trip': return r.best ? '偵察から戻りました。いちばん良さそうな土地は ' + r.best.pos.join(',') + '（' + r.best.biome + '）' : '偵察から戻りました'
    case 'scout_lost': return '偵察中にやられました…あの方角は危険です'
    case 'guard_pass': return r.kills >= 2 ? '見張り中：' + r.kills + '体たおしました' + (r.string ? '、糸' + r.string + '本' : '') : null
    case 'cooked': return r.n > 0 ? r.n + '個、焼けました' : null
    case 'canteen': return Math.random() < 0.3 ? pick(['いただきます', 'ごはん休憩です']) : null
    case 'pit_filled': return '落ちた穴、埋めて出ました'
    case 'dug_out': case 'pillared_out': return '閉じ込められてたけど脱出しました'
    case 'hung': return '作業が進みません…いったん別の仕事に回ります（' + jobName(r.job) + '）'
    case 'stranded': return '動けません…助けてください（' + (r.at || []).join(',') + '）'
    case 'no_route': return '道がなくて進めません（行き先 ' + (r.to || []).filter(v => v != null).join(',') + '）'
    case 'recalled': return '坑道から上がってきました'
    case 'hauled': return '荷物を運んできました（' + (r.banked || 0) + '個）'
    case 'depot_ready': return '倉庫ができました！'
    case 'chest_missing': return 'チェストが無くなっています！（' + (r.at || []).join(',') + '）爆破されたかも'
    case 'furnaces': return r.took > 0 ? 'かまどから' + r.took + '個回収しました' : null
    case 'smelted': return r.n > 0 ? r.item + 'を' + r.n + '個、精錬しました' : null
    case 'legacy_drained': return '旧拠点のチェストから' + r.items + '個、運び出しました'
    case 'hedge_damaged': return 'ベリー垣根の茂みが' + (r.was - r.now) + '株、消えています！'
    case 'structure_damaged': return '建物が壊されています：' + r.job + ' ' + r.missing + 'マス、修理します'
    case 'crops_vanished': return '畑の作物が消えていました、' + r.replanted + 'マス植え直し'
    case 'flood': return '畑が水浸しです！ 流水' + r.flowing + 'マス'
    case 'stray_chests_found': return '登録されていないチェストを' + r.n + '個見つけました、回収します'
    case 'legacy_open_failed': return '旧拠点のチェストが開きません！'
    case 'lid_unblocked': return 'チェストの上の邪魔なブロックをどかしました'
    case 'legacy_chest_removed': return '旧拠点のチェストを1つ片付けました（残り' + r.left + '）'
    case 'chest_added': return '倉庫を増設しました（' + r.cat + '：' + (r.at || []).join(',') + '）'
    case 'chest_rebuilt': return 'チェストを建て直しました（' + (r.at || []).join(',') + '）'
    case 'creeper': return 'クリーパーを' + (r.killed ? '倒しました' : '拠点から引き離しています') + '！'
    case 'bank_unreachable': return ({ food: '食料', tools: '道具', ores: '鉱石', build: '建材', salvage: '素材' }[r.cat] || r.cat) + 'の倉庫に届きません！'
    case 'chest_full': return ({ food: '食料', tools: '道具', ores: '鉱石', build: '建材', salvage: '素材' }[r.cat] || r.cat) + 'のチェストがいっぱいです！'
    default: return null
  }
}
// humans are spectators without op: the modes datapack maps `/trigger goto set <n>` to "tp to bot n" for spectators
let _roster = null
function botNumber (name) {
  try { if (!_roster) _roster = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assignments.json'), 'utf8'))) } catch (e) { _roster = [] }
  return _roster.indexOf(name) + 1
}
function isBotName (n) { return botNumber(n) > 0 }

function speak (bot, rec) {
  if (!bot || !bot.chat || !bot.entity || settings().talk === false) return
  const line = lineFor(bot, rec)
  if (!line) return
  const now = Date.now()
  const urgent = /hedge_damaged|structure_damaged|flood|bank_unreachable|chest_missing|creeper|stranded|hung|plan_failed|death|no_route|chest_full|sleep_failed|bed_missing|scout_lost|error/.test(rec.ev)
  if (now - (bot.__armySaidT || 0) < (urgent ? 1500 : 6000)) return // per bot (the server kicks a player that chats much faster than 1/s)
  const f = path.join(DIR, 'say.json'); const sj = readJSON(f, {}) || {}; const last = sj.t || 0
  if (now - last < (urgent ? 150 : 700)) return // army-wide: the chat is the owner's live INFO log — loud is fine, a flood is not
  if (rec.ev === 'chest_full') { if (now - (sj.fullT || 0) < 60000) return; sj.fullT = now }
  writeJSON(f, Object.assign(sj, { t: now, bot: bot.username })); bot.__armySaidT = now
  // colour by severity (owner's idea): player chat cannot carry colours, so the line is shown with the server's `tellraw` (display only —
  // nothing in the world changes). Falls back to plain chat if rcon is not reachable.
  const sev = line.startsWith('[警告]') ? (/(stranded|death|error|hung)/.test(rec.ev) ? 'red' : 'gold') : line.startsWith('[成果]') ? 'green' : 'gray'
  // the name is clickable: a spectator who clicks it is taken to that bot (`/trigger goto`, no op needed; 1.21.5+ snake_case events)
  const p0 = bot.entity.position
  const msg = JSON.stringify([{ text: '<' + bot.username + '> ', color: 'white', click_event: { action: 'run_command', command: '/trigger goto set ' + botNumber(bot.username) }, hover_event: { action: 'show_text', value: 'クリックで ' + bot.username + ' へ（スペクテイター中のみ・op不要） ' + Math.round(p0.x) + ',' + Math.round(p0.y) + ',' + Math.round(p0.z) } }, { text: line.slice(0, 110), color: sev }])
  try {
    require('child_process').execFile('node', [path.join(DIR, '..', 'rcon.js'), 'tellraw @a ' + msg], { timeout: 5000 }, (err) => { if (err) { try { bot.chat(line.slice(0, 100)) } catch (e_) { swallow('army:118', e_) } } })
  } catch { try { bot.chat(line.slice(0, 100)) } catch (e_) { swallow('army:119', e_) } }
}
let _settings = { t: 0, v: null }
function settings () {
  if (Date.now() - _settings.t > 5000) { _settings = { t: Date.now(), v: (readJSON(F.board, {}) || {}).settings || {} } }
  return _settings.v || {}
}

// DECLINE: a job that cannot use this bot right now ("waiting for dawn", "trip done", "no hoe", "hurt", "plan finished") must hand the
// bot back instead of parking it at muster. The handler's muster(why) calls decline(); the dispatcher then skips that job for this
// bot until `until` (or until the job's rev changes) and gives it the next job it is eligible for.
function decline (bot, job, ms, why) {
  // a MAP of declined jobs per bot (one entry was not enough: a bot bounced between two day-jobs it could not do, each decline erasing the other)
  try {
    fs.mkdirSync(path.join(DIR, 'decline'), { recursive: true })
    const f = path.join(DIR, 'decline', bot.username + '.json'); const now = Date.now()
    let d = readJSON(f, {}) || {}; if (d.job) d = {} // old single-entry format
    for (const k of Object.keys(d)) if (!(d[k].until > now)) delete d[k]
    d[job.id] = { rev: job.rev || 0, until: now + ms, why: String(why || '').slice(0, 80) }
    writeJSON(f, d)
  } catch (e_) { swallow('army:139', e_) }
}

// locked read-modify-write of the job board (same mkdir lock as armyctl.js, so workers and operators never clobber each other)
function boardEdit (fn) {
  const lock = F.board + '.lock'; const t0 = Date.now()
  for (;;) { try { fs.mkdirSync(lock); break } catch { if (Date.now() - t0 > 4000) { try { fs.rmdirSync(lock) } catch {} } else { const e = Date.now() + 60; while (Date.now() < e) {} } } }
  try { const b = readJSON(F.board, null); if (!b) return false; fn(b); const tmp = F.board + '.tmp_w' + process.pid; fs.writeFileSync(tmp, JSON.stringify(b, null, 1)); fs.renameSync(tmp, F.board); return true } catch (e_) { swallow('army:boardEdit', e_); return false } finally { try { fs.rmdirSync(lock) } catch {} }
}

// ------------------------------------------------------------------ inventory
function inv (bot) { const m = {}; for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count; return m }
function count (bot, name) { return inv(bot)[name] || 0 }
const FILLERS = ['cobblestone', 'dirt', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite'] // what a bot may pillar/support with
const TIER = C.TIER_RANK // ONE tier table (craft.js): wooden/golden < stone < copper < iron < diamond < netherite
function bestOf (bot, kind) {
  let best = null; let r = 0
  for (const i of bot.inventory.items()) {
    const m = /^(\w+)_(pickaxe|axe|sword|shovel|hoe)$/.exec(i.name)
    if (m && m[2] === kind && (TIER[m[1]] || 0) > r) { r = TIER[m[1]]; best = i }
  }
  return best
}
async function equipBest (bot, kind) {
  const it = bestOf(bot, kind)
  if (!it) return false
  if (bot.heldItem && bot.heldItem.name === it.name) return true
  try { await U.withTimeout(bot.equip(it, 'hand'), 5000, 'equip'); return true } catch { return false }
}

// ------------------------------------------------------------------ heartbeat / assignment
// ---- sensors for the COMMONS ledger (terrain_debt.jsonl). Installed from heartbeat() so they hot-load without a manager restart.
// Explosions (creepers) near a place bots use leave craters that cost every later trip -> record them so a public-works job fills them.
const _seenBoom = new Set()
const _angryEnder = {} // entity id -> until (ms): endermen the server reported angry next to a hurt bot
// ---- GAZE GUARD (09-19: endermen = #1 killer by day, 6-8 deaths per 2 h, yet no code ever aims at one). Cause: the pathfinder walks with
// `bot.look(yaw, 0)` = eyes level, and vanilla calls it a STARE when the view vector points at the enderman's eyes (feet + 2.55) within
// dot > 1 - 0.025/distance for 5 ticks. On level ground that is true for every enderman 19-64 blocks straight ahead (or nearer, if it stands
// lower): bots provoked them just by walking towards them. Fix = what a player does: never rest the crosshair on the head. Every look of this
// bot (pathfinder, lookAt, dig, place) passes through safePitch(): if the view would fall within twice the vanilla cone of a CALM enderman's
// eyes, the pitch is lowered below the cone (same yaw). An enderman that is already fighting us (_angryEnder) is exempt. Cheap: the enderman
// list is cached for 400 ms; with none in sight it is one comparison per look.
function calmEnders (bot) {
  const c = bot.__armyEnders; const now = Date.now()
  if (c && now - c.t < 400) return c.list
  const list = []; const me = bot.entity.position
  for (const id in bot.entities) { const e = bot.entities[id]; if (e && e.name === 'enderman' && e.position && !(_angryEnder[e.id] > now) && e.position.distanceTo(me) < 66) list.push(e) }
  bot.__armyEnders = { t: now, list }
  return list
}
function safePitch (bot, yaw, pitch) {
  const list = calmEnders(bot); if (!list.length || !bot.entity) return pitch
  const p0 = bot.entity.position; const ey = p0.y + (bot.entity.eyeHeight || 1.62)
  for (let pass = 0; pass < 2; pass++) {
    for (const e of list) {
      const dx = e.position.x - p0.x; const dy = e.position.y + 2.55 - ey; const dz = e.position.z - p0.z
      const d = Math.hypot(dx, dy, dz); if (!(d > 0.3)) continue
      const cp = Math.cos(pitch); const dot = (-Math.sin(yaw) * cp * dx + Math.sin(pitch) * dy - Math.cos(yaw) * cp * dz) / d
      const lim = Math.max(0.5, 1 - 0.1 / d) // vanilla 0.025/d: four times (1 - cos) = twice the angle
      if (dot <= lim) continue
      pitch = Math.max(-1.45, Math.min(pitch, Math.atan2(dy, Math.hypot(dx, dz)) - Math.acos(lim) * 1.15))
    }
  }
  return pitch
}
function gazeGuard (bot) {
  if (!bot.__armyLook0) bot.__armyLook0 = bot.look
  const look0 = bot.__armyLook0
  bot.look = (yaw, pitch, force) => {
    let p = pitch
    try { p = safePitch(bot, yaw, pitch); if (p !== pitch) gazeNote(bot) } catch (e_) { swallow('army:gaze', e_) }
    return look0(yaw, p, force)
  }
}
function gazeNote (bot) { // one report per bot per 10 min: how often the guard had to lower the eyes (verification + REPORT)
  const g = bot.__armyGaze = bot.__armyGaze || { n: 0, t: Date.now() }
  g.n++
  if (Date.now() - g.t > 600000) { result(bot, { ev: 'gaze_averted', n: g.n, min: 10 }); g.n = 0; g.t = Date.now() }
}
// ---- ENDERMAN SHELTER (reflex): a bot that an enderman is hitting while no team-mate is within 8 blocks does what a player does - it steps under
// a 2-high ceiling (an enderman is 2.9 tall: it cannot follow) or, second choice, into 1-deep still water (water hurts endermen, they teleport
// away) if such a spot is within 6 blocks. Read-only movement (strict pathfinder, no block edits). Nothing suitable -> it keeps fighting (the
// melee reflex hits an angry enderman anyway). travel() pauses while bot.__armyShelterT is in the future, so the job does not drag the bot out.
function shelterSpot (bot) {
  const me = bot.entity.position.floored()
  const B = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solid = b => !!b && b.boundingBox === 'block'
  const open = b => !!b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava' && b.name !== 'sweet_berry_bush' && b.name !== 'fire'
  const tall = (x, y, z) => solid(B(x, y, z)) || solid(B(x, y + 1, z)) || solid(B(x, y + 2, z)) // an enderman cannot stand in this column
  let roof = null; let water = null
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const x = me.x + dx; const y = me.y + dy; const z = me.z + dz; const d = Math.hypot(dx, dy, dz)
        if (d > 6.5 || !solid(B(x, y - 1, z))) continue
        const feet = B(x, y, z)
        if (open(feet) && open(B(x, y + 1, z)) && solid(B(x, y + 2, z))) {
          let cover = 0
          for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) if ((ax || az) && tall(x + ax, y, z + az)) cover++
          const score = cover * 2 - d
          if (cover >= 5 && (!roof || score > roof.score)) roof = { kind: 'roof', x, y, z, score, cover }
        } else if (feet && feet.name === 'water' && (feet.metadata === 0) && open(B(x, y + 1, z)) && (!water || d < water.d)) water = { kind: 'water', x, y, z, d }
      }
    }
  }
  return roof || water
}
const sheltering = bot => (bot.__armyShelterT || 0) > Date.now()
async function shelter (bot) {
  if (bot.__armyShelterBusy || Date.now() - (bot.__armyShelterLast || 0) < 30000 || !bot.entity || bot.health <= 0) return
  const me = bot.entity.position
  const head = bot.blockAt(me.floored().offset(0, 2, 0)); if (head && head.boundingBox === 'block') return // already under a 2-high ceiling (tunnel, mine)
  for (const id in bot.entities) { const e = bot.entities[id]; if (e && e !== bot.entity && e.type === 'player' && e.username && isBotName(e.username) && e.position && e.position.distanceTo(me) <= 8) return } // not alone: 3-4 swords beat 40 hp
  bot.__armyShelterBusy = true; bot.__armyShelterLast = Date.now()
  try {
    const s = shelterSpot(bot)
    if (!s) { result(bot, { ev: 'ender_shelter', ok: false, why: 'no roof/water within 6', hp: Math.round(bot.health) }); return }
    bot.__armyShelterT = Date.now() + 25000
    try { bot.pathfinder.setGoal(null) } catch (e_) { swallow('army:shelterGoal', e_) }
    await sleep(200) // the job's own pathTo settles (its finally clears the goal), travel() then waits at its gate; the installed (read-only) movements stay
    const r = await U.pathTo(bot, s.kind === 'roof' ? new goals.GoalBlock(s.x, s.y, s.z) : new goals.GoalNear(s.x, s.y, s.z, 1), 7000).catch(() => 'fail')
    if (s.kind === 'water' && bot.entity.position.distanceTo(new Vec3(s.x + 0.5, s.y, s.z + 0.5)) < 2.5) {
      try { await bot.lookAt(new Vec3(s.x + 0.5, s.y + 0.5, s.z + 0.5), true) } catch (e_) { swallow('army:shelterLook', e_) }
      bot.setControlState('forward', true); await sleep(700); bot.clearControlStates()
    }
    const at = bot.entity.position.floored(); const hp0 = Math.round(bot.health)
    // stay while the enderman keeps coming (last hit < 8 s ago), at most until the 25 s are over
    while (Date.now() < bot.__armyShelterT && Date.now() - (bot.__armyEnderHitT || 0) < 8000 && bot.health > 0 && !U.cancelled(bot)) await sleep(400)
    result(bot, { ev: 'ender_shelter', ok: r === 'ok', kind: s.kind, at: [at.x, at.y, at.z], cover: s.cover, hp: hp0, hpAfter: Math.round(bot.health) })
  } catch (e_) { swallow('army:shelter', e_) } finally { bot.__armyShelterT = 0; bot.__armyShelterBusy = false }
}
// An enderman is ANGRY only when the server says so: entity metadata `creepy` (it screams at a target) or `stared_at`. The indices come from the
// registry of the bot's version (17/18 in 1.21.11 and 26.1), never from a constant. Metadata the server has not sent = the default = CALM
// (world 1 read "unknown" as angry: every enderman that stood near a zombie fight was attacked, and that started the fights it meant to avoid).
function enderAngry (bot, m) {
  const keys = ((bot.registry.entitiesByName.enderman || {}).metadataKeys) || []; const md = m.metadata || []
  const a = keys.indexOf('creepy'); const b = keys.indexOf('stared_at')
  return (a >= 0 && md[a] === true) || (b >= 0 && md[b] === true)
}
const LOADED_AT = Date.now()
function sensors (bot) {
  if ((bot.__armySensorsT || 0) >= LOADED_AT) return // listeners always belong to the NEWEST loaded copy of this lib (the worker reloads it when a lib file changed)
  bot.__armySensorsT = LOADED_AT
  for (const [em, ev, fn] of (bot.__armySensorFns || [])) { try { em.removeListener(ev, fn) } catch (e_) { swallow('army:sensOff', e_) } }
  bot.__armySensorFns = []
  const on = (em, ev, fn) => { em.on(ev, fn); bot.__armySensorFns.push([em, ev, fn]) }
  try { gazeGuard(bot) } catch (e_) { swallow('army:gazeGuard', e_) }
  // a bot standing still keeps its last view direction: an enderman that wanders INTO it is stared at just the same -> re-check every 2nd tick
  try { let tk = 0; on(bot, 'physicsTick', () => { try { if ((++tk & 1) || !bot.entity) return; const e = bot.entity; if (safePitch(bot, e.yaw, e.pitch) !== e.pitch) bot.look(e.yaw, e.pitch, true) } catch (e_) { swallow('army:gazeTick', e_) } }) } catch (e_) { swallow('army:gazeTickOn', e_) }
  try {
    on(bot, 'entityHurt', e => {
      try {
        if (!e || e.type !== 'player' || !e.username || !isBotName(e.username) || e.position.distanceTo(bot.entity.position) > 10) return // me or a team-mate beside me
        // the attacker is an enderman only if one that the SERVER reports angry stands within 4 blocks of the hurt bot; a calm one beside a zombie
        // fight is left alone (never looked at, never hit)
        let ender = false
        for (const id in bot.entities) { const m = bot.entities[id]; if (!m || m.name !== 'enderman' || !m.position || m.position.distanceTo(e.position) >= 4 || !enderAngry(bot, m)) continue; _angryEnder[m.id] = Date.now() + 45000; ender = true }
        if (ender && e.username === bot.username) { bot.__armyEnderHitT = Date.now(); shelter(bot).catch(e_ => swallow('army:shelterRun', e_)) }
      } catch (e_) { swallow('army:hurt', e_) }
    })
  } catch (e_) { swallow('army:hurtSensor', e_) }
  try {
    on(bot._client, 'explosion', (pk) => {
      try {
        const c = pk.center || pk
        if (!c || !isFinite(c.x)) return
        const at = [Math.round(c.x), Math.round(c.y), Math.round(c.z)]
        const key = at.map(v => Math.round(v / 4)).join(',')
        if (_seenBoom.has(key)) return // the other bots of this shard heard the same bang
        _seenBoom.add(key); if (_seenBoom.size > 200) _seenBoom.clear()
        const m0 = settings().muster; const places = [Array.isArray(m0) ? { x: m0[0], z: m0[2] } : m0].concat(Object.values(settings().chests || {}).map(l => l[0] && { x: l[0][0], z: l[0][2] })).filter(Boolean)
        if (!places.some(q => Math.hypot(q.x - at[0], q.z - at[2]) < 96)) return // wilderness heals itself in nobody's way
        debt(bot, { kind: 'crater', at, note: 'explosion near base - fill to ground level' })
      } catch (e_) { swallow('army:boom', e_) }
    })
  } catch (e_) { swallow('army:boomSensor', e_) }
}
// ---- KIT UP — the ONE gear function (world 1 handed out iron at bank() only, by item name). kitUp(bot, opts):
//   1. WEAR the best of what is carried: per armour slot the highest C.ARMOR_RANK, a shield into the off-hand (also the 15 s heartbeat reflex: wear()).
//   2. FETCH from the depot (chest index; containers within opts.maxDist, default 96) what would be an UPGRADE: per slot the best armour piece in
//      stock, a better sword (an axe only when there is no sword anywhere), a shield. One piece per kind, at most once per 5 min (opts.force).
//   FAIR SHARE (30 bots, one depot): a bot on a job with combat/mining risk (opts.risk) may take while stock lasts; everybody else only when the
//   stock of that item also covers every OTHER live bot that lacks one as good (fresh heartbeats) — so a farmer at the bank never takes the
//   chestplate a miner needs, and once there is enough for all, all get it. Worse pieces left in the pockets are banked by bank() for the next bot.
// Called by bank(), by the worker after a respawn and before a risk job (riskJob). Reports `kitted` with what it really took.
const ARMOR_SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const armorOf = name => { const m = /^(\w+)_(helmet|chestplate|leggings|boots)$/.exec(name); return m && C.ARMOR_RANK[m[1]] ? { rank: C.ARMOR_RANK[m[1]], piece: m[2] } : null }
const weaponOf = name => { const m = /^(\w+)_(sword|axe)$/.exec(name); return m && TIER[m[1]] ? { rank: TIER[m[1]], kind: m[2] } : null }
function wornRank (bot, piece) { const cur = bot.inventory.slots[bot.getEquipmentDestSlot(ARMOR_SLOT[piece])]; const a = cur && armorOf(cur.name); return a ? a.rank : 0 }
function offHand (bot) { return bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')] || null }
async function wear (bot) {
  if (bot.__armyWearing || bot.currentWindow || bot.__armyEating) return
  bot.__armyWearing = true
  try {
    for (const it of bot.inventory.items().slice().sort((a, b) => ((armorOf(b.name) || {}).rank || 0) - ((armorOf(a.name) || {}).rank || 0))) {
      const a = armorOf(it.name)
      if (a) { if (a.rank > wornRank(bot, a.piece)) await U.withTimeout(bot.equip(it, ARMOR_SLOT[a.piece]), 4000, 'armor').catch(e_ => swallow('army:wearArmor', e_)) } else if (it.name === 'shield' && !offHand(bot)) await U.withTimeout(bot.equip(it, 'off-hand'), 4000, 'shield').catch(e_ => swallow('army:wearShield', e_))
    }
  } catch (e_) { swallow('army:wear', e_) } finally { bot.__armyWearing = false }
}
// everything the bot has on it: pockets + worn armour + off-hand, summed (THE heartbeat `inv`: bots/army/stock.js and the dispatcher read it)
function carried (bot) { const m = inv(bot); for (const i of [5, 6, 7, 8, 45].map(q => bot.inventory.slots[q])) if (i) m[i.name] = (m[i.name] || 0) + i.count; return m }
const worn = bot => [5, 6, 7, 8, 45].map(q => bot.inventory.slots[q]).filter(Boolean).map(i => i.name)
function liveBots (maxAge = 600000) { // fresh heartbeats of the whole army (file-based: the other 27 bots live in other processes)
  const out = []; let files = []
  try { files = fs.readdirSync(path.join(DIR, 'hb')) } catch (e_) { if (e_.code !== 'ENOENT') swallow('army:hbDir', e_) }
  for (const f of files) { const h = f.endsWith('.json') && readJSON(path.join(DIR, 'hb', f), null); if (h && Date.now() - (h.t || 0) < maxAge) out.push(h) }
  return out
}
// jobs that meet mobs or rock: their bots kit up first and have first call on scarce gear. A job may also say `risk:true|false` itself.
const RISK_TYPES = /^(guard|hunt|ores|scout|delegate|haul|sleeper)$/
function riskJob (job, phase) { return !!job && (job.risk != null ? !!job.risk : (RISK_TYPES.test(job.type) || phase === 'night' || !!(job.params && job.params.needsNight))) }
// pure decision (offline-testable): mine/stock = {item:count}, others = [{item:count}] of the other live bots -> item names to take, one per kind
function kitPlan (mine, stock, others, risk) {
  const bestHeld = (m, of, key, val) => Object.keys(m).reduce((r, n) => { const q = of(n); return q && q[key] === val && m[n] > 0 ? Math.max(r, q.rank) : r }, 0)
  const pickFor = (of, key, val) => { // the best stocked UPGRADE of one kind that the fair-share rule lets this bot take
    const cur = bestHeld(mine, of, key, val)
    const cands = Object.keys(stock).filter(n => stock[n] > 0 && of(n) && of(n)[key] === val && of(n).rank > cur).sort((a, b) => of(b).rank - of(a).rank)
    return cands.find(n => risk || stock[n] > others.filter(m => bestHeld(m, of, key, val) < of(n).rank).length) || null
  }
  const wants = ['chestplate', 'leggings', 'helmet', 'boots'].map(p => pickFor(armorOf, 'piece', p))
  const swordAnywhere = bestHeld(mine, weaponOf, 'kind', 'sword') > 0 || Object.keys(stock).some(n => stock[n] > 0 && (weaponOf(n) || {}).kind === 'sword')
  wants.push(pickFor(weaponOf, 'kind', 'sword') || (swordAnywhere ? null : pickFor(weaponOf, 'kind', 'axe')))
  if (!mine.shield && stock.shield > 0 && (risk || stock.shield > others.filter(m => !m.shield).length)) wants.push('shield')
  return wants.filter(Boolean)
}
async function kitUp (bot, opts = {}) {
  if (bot.__armyKitBusy || !bot.entity) return []
  bot.__armyKitBusy = true; const took = []
  try {
    await wear(bot)
    if (opts.fetch === false || Date.now() - (bot.__armyKitT || 0) < (opts.force ? 0 : 300000)) return took
    bot.__armyKitT = Date.now()
    const wants = kitPlan(carried(bot), stockMap(), liveBots().filter(h => h.bot !== bot.username).map(h => h.inv || {}), !!opts.risk)
    for (const n of wants) {
      if (U.cancelled(bot) || (opts.stop && opts.stop())) break
      if (await withdraw(bot, n, 1, { stop: opts.stop, maxDist: opts.maxDist == null ? 96 : opts.maxDist }) > 0) took.push(n)
    }
    if (took.length) { await wear(bot); result(bot, { ev: 'kitted', items: took, risk: !!opts.risk, why: opts.why || null }) }
  } catch (e_) { swallow('army:kitUp', e_) } finally { bot.__armyKitBusy = false }
  return took
}
// HANG WATCHDOG (owner: "bots standing around the base"): a bot on a working job that has not moved 1.5 blocks for 3 minutes, while its
// task is not one that legitimately stands still, is HUNG. It says so (event `hung` -> operators' digest + chat), hands the job back
// (decline 5 min) and interrupts its handler so the dispatcher can give it something else. LLM-free, runs from heartbeat().
const STILL_OK = /sleep|fish|farm:waiting|plan idle|muster|guard|scan|cook|craft|smelt|step \d+\/\d+ (craft|smelt|wait|withdraw|bank)|canteen|iron:(branch|mine|vein|dig|stairs|craft|base)/
function watchdog (bot, extra) {
  const p = bot.entity.position; const w = bot.__armyWd = bot.__armyWd || { pos: p.clone(), t: Date.now() }
  if (p.distanceTo(w.pos) > 1.5) { w.pos = p.clone(); w.t = Date.now(); return }
  // WORKING ON THE SPOT IS NOT HANGING (09-20 06:57Z: four infill builders with a shovel/dirt in hand were declared hung while they filled and cut the
  // columns around their feet): a bot whose pockets change (blocks placed, dug, picked up, crafted) is doing something - only a bot that neither
  // moves NOR changes its inventory for 3 minutes is hung.
  try { let sig = 0; for (const i of bot.inventory.items()) sig += i.count * (i.type + 1); if (sig !== w.sig) { w.sig = sig; w.t = Date.now(); return } } catch (e_) { swallow('army:wdSig', e_) }
  const job = (extra && extra.job) || bot.__armyJob; const task = String(bot.state && bot.state.task || '')
  // an EXCUSED bot restarts its still-timer (09-20: a bot that had stood excused for 3 min - muster, baking, waiting at a furnace - was reported `hung`
  // the second its task text changed, although it had not been expected to move: 5 healthy miners at the muster woke the top model twice)
  if (!job || job === 'muster' || STILL_OK.test(task)) { w.t = Date.now(); return }
  if (Date.now() - w.t < 180000) return
  w.t = Date.now()
  askHelp(bot, 'hung', 'no movement for 3 min on job ' + job + ', task "' + task.slice(0, 60) + '"')
  result(bot, { ev: 'hung', job, task: task.slice(0, 60), at: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], area: walkableArea(bot, 80) })
  decline(bot, { id: job, rev: (assignment(bot).job || {}).rev || 0 }, 300000, 'hung: ' + task.slice(0, 40))
  try { if (bot.__core) bot.__core.alerts.push({ kind: 'hung', by: 'watchdog', t: Date.now(), prio: 1 }) } catch (e_) { swallow('army:220', e_) } // makes api.stop() true: the handler yields
}
// every bot is a scout for LIVESTOCK: mineflayer only knows entities the server streams to it (~48-64 blocks around the bot), so nobody can
// "search" for sheep — we remember sightings instead. >=2 animals of a kind, no record within 48 blocks in the last 30 min -> one line in
// bots/army/animals.jsonl (armyctl.js animals). Hunt/shear jobs take their `site` from there.
const HERD = ['sheep', 'cow', 'pig', 'chicken', 'rabbit', 'horse', 'mooshroom', 'goat']
const _herdSeen = []
function spotAnimals (bot) {
  if (Date.now() - (bot.__armySpotT || 0) < 30000) return
  bot.__armySpotT = Date.now()
  const c = {}; const at = {}
  for (const e of Object.values(bot.entities)) if (e && e.position && HERD.includes(e.name)) { c[e.name] = (c[e.name] || 0) + 1; at[e.name] = e.position }
  for (const [k, n] of Object.entries(c)) {
    if (n < 2) continue
    const p = at[k].floored()
    if (_herdSeen.some(q => q.k === k && Date.now() - q.t < 1800000 && Math.hypot(q.x - p.x, q.z - p.z) < 48)) continue
    _herdSeen.push({ k, x: p.x, z: p.z, t: Date.now() }); if (_herdSeen.length > 100) _herdSeen.shift()
    try { fs.appendFileSync(path.join(DIR, 'animals.jsonl'), JSON.stringify({ t: Date.now(), bot: bot.username, kind: k, n, at: [p.x, p.y, p.z] }) + '\n') } catch (e_) { swallow('army:237', e_) }
  }
}
function heartbeat (bot, extra) {
  if (!bot.entity) return
  sensors(bot)
  // the melee reflex is an interval started once by the worker: re-arm it with THIS (newer) copy of the lib, or hot fixes to hostiles()/the
  // reflex never reach a running bot
  if (bot.__armyGuard && (bot.__armyGuardT || 0) < LOADED_AT) { bot.__armyGuardT = LOADED_AT; startGuard(bot) }
  mealReflex(bot)
  try { spotAnimals(bot) } catch (e_) { swallow('army:243', e_) }
  wear(bot).catch(e_ => swallow('army:wearTick', e_))
  try { watchdog(bot, extra) } catch (e_) { swallow('army:245', e_) }
  const p = bot.entity.position
  bot.__armyLastInv = carried(bot) // the death report gets this snapshot (the inventory is already empty when 'death' fires)
  // `inv` = EVERYTHING on the bot as {item:count} (pockets + worn armour + off-hand) — bots/army/stock.js and the dispatcher read it; `worn` = what of it is equipped
  writeJSON(F.hb(bot.username), Object.assign({
    bot: bot.username, t: Date.now(), pos: [Math.round(p.x), Math.round(p.y), Math.round(p.z)],
    hp: Math.round(bot.health || 0), food: bot.food, inv: carried(bot), worn: worn(bot), task: bot.state && bot.state.task,
    deaths: bot.__armyDeaths || 0, dim: bot.game && bot.game.dimension
  }, extra || {}))
}
function assignment (bot) {
  const a = readJSON(F.assign(bot.username), null)
  if (!a || !a.job || Date.now() - (a.t || 0) > 180000) return { job: { id: 'muster', type: 'muster' }, phase: a ? a.phase : 'day', stale: true }
  return a
}

// ------------------------------------------------------------------ movement (read-only: no digging, no towers, no parkour; sprint while the larder is full)
// THE TWO TRAVEL RULES AND THEIR NUMBERS (the only place they are defined; travel() applies them):
//   SURFACE RULE    a trip that starts AND ends on the surface may not step below the surface floor = SEA_LEVEL - SURFACE_DEPTH (63 - 5 = y 58 in
//                   every overworld, whatever the base's height): the pathfinder then cannot route through caves or along a lake/river bottom
//                   (world 1: 10 of 16 deaths happened there while the job was on the surface). A bot that is already below the floor, a target
//                   below it, `opts.anyDepth`, or another dimension -> no floor (miners, cave escapes, nether).
//   REVERSIBLE RULE on a surface trip a step DOWN is at most 1 block, so every route walked out can be walked home (world 1: bots dropped 2-3
//                   blocks into shore pockets and were rescue-killed). Only the relaxed retry of a trip TOWARDS the muster point may drop 3.
//   maxDropDown     mineflayer-pathfinder counts to the FLOOR block of the landing (getLandingBlock: node.y - floor.y <= maxDropDown), so a real
//                   drop of n needs n + 1: DROP.surface 2 = one block, DROP.normal 3 = two, DROP.homeward 4 = three (1 made stairs one-way: measured).
const SEA_LEVEL = 63
const SURFACE_DEPTH = 5
const DROP = { surface: 2, normal: 3, homeward: 4 }
function surfaceFloor (bot) { return !bot.game || /overworld/.test(String(bot.game.dimension)) ? SEA_LEVEL - SURFACE_DEPTH : null }
function musterPos () { const m = settings().muster; return !m ? null : Array.isArray(m) ? { x: m[0], y: m[1], z: m[2] } : m } // CONTRACT form [x,y,z]; the old {x,y,z,cols} still reads
let _larder = { t: 0, ok: true }
function larderFull () { if (Date.now() - _larder.t > 120000) { _larder.t = Date.now(); try { _larder.ok = require('../../army/stock.js').have('food') >= 256 } catch (e_) { _larder.ok = true } } return _larder.ok } // stock.js reads 50 heartbeat files: once per 2 min, not per trip
function strictMovements (bot) {
  const mv = new Movements(bot)
  // RUN (owner 09-20: "効率を上げるための作業は惜しみなくやるべき … 走る"): sprinting was banned in world 1 to save food (1 hunger point per ~40 m);
  // world 2 holds 9000+ food for 50 bots - legs are the bottleneck now (base ↔ mine ↔ fields: minutes per trip). Off again only below the larder floor.
  mv.allowSprinting = larderFull()
  mv.canDig = false
  mv.allow1by1towers = false
  mv.allowParkour = false
  mv.scafoldingBlocks = []
  mv.maxDropDown = DROP.normal
  mv.canOpenDoors = true
  mv.dontCreateFlow = true
  // WATER IS A ROAD, not a wall (world 2, 09-19: with `water` in blocksToAvoid 20 bots stood on the bank of the first river, `no_route`;
  // world 1 never noticed because its water was ice). A good player swims a river and walks round a lake: water costs more than land.
  mv.liquidCost = 6
  const reg = bot.registry
  for (const n of ['lava', 'sweet_berry_bush', 'powder_snow', 'magma_block', 'cactus', 'campfire', 'fire', 'farmland']) {
    const b = reg.blocksByName[n]; if (b) mv.blocksToAvoid.add(b.id)
  }
  // AN OPEN GATE IS A HOLE IN THE WALL, NOT A WALL (world 2, 09-19 22:2xZ: six dorm builders stood inside their own dorm for 20 min, `no_route` and
  // `bank_unreachable` x33/min - both end gates stood OPEN). The pathfinder knows how to open a CLOSED gate (it has a collision shape), but an open
  // one has boundingBox 'block' with NO shapes: neither "safe" nor "openable work" -> impassable. Probe on Yui: partial -> success with this rule.
  const gb = mv.getBlock.bind(mv)
  mv.getBlock = (pos, dx, dy, dz) => { const b = gb(pos, dx, dy, dz); if (b && b.openable && b.shapes && b.shapes.length === 0) { b.safe = true; b.physical = false } return b }
  try { require('./terrain_guard').install(bot) } catch (e_) { swallow('army:tgInstall', e_) } // idempotent; a new guard VERSION reaches running bots here (the manager installs it only at spawn)
  bot.pathfinder.setMovements(mv)
  bot.mv = mv
  return mv
}
// last resort for a bot sealed in a pit: may dig (never towers). Used for ONE hop, then strict again.
function escapeMovements (bot) {
  const mv = strictMovements(bot)
  mv.canDig = true
  mv.digCost = 12
  for (const n of U.PROTECT_SET) { const b = bot.registry.blocksByName[n]; if (b) mv.blocksCantBreak.add(b.id) }
  bot.pathfinder.setMovements(mv)
  return mv
}
function dist2 (bot, x, z) { const p = bot.entity.position; return Math.hypot(p.x - x, p.z - z) }

// ---- WHAT WE BUILT IS NOT TERRAIN (owner 09-20 05:00Z: 76 sheep outside pen 1, holes in the dorm walls, stray blocks beside the depot, bumpy fields - ONE cause:
// the escape edits treated our own buildings as a cave. Evidence: Koharu `dug_out from [-333,-15,-563] to [-388,69,-540]` 03:42:10Z = she DIED at 03:41:08Z in the
// mine, the running digOut/stairUp survived the death, woke up under the dorm roof (`!skyAbove` = "roofed in"), cut through the wall, climbed the pen fence on its own
// step blocks (cobbled_deepslate on the fence post -376,70,-532) and left 11 step blocks on the pen floor; the flock count fell 24 -> 7 from 03:42Z on, sheep hop out
// over a block beside the fence. Iroha 04:15Z `dug_out ... to [-358,69,-538]` = the same inside the dorm.)
// ONE registry of every cell a blueprint of ours makes solid (build jobs on the board + bots/army/jobs-archive.jsonl; terrain jobs level/fill_void/clear_area/quarry
// are not structures) + the pen boxes of the herd jobs. Rules that read it: escape edits (digOut/stairUp/pillar) never dig or place in it, blocks.js refuses
// a block inside a pen, tidy removes what stands in a built zone and belongs to no blueprint, the structure audit counts furniture.
function blueprintCellsOf (q, fresh) {
  const f = path.join(DIR, '..', 'blueprints', String(q.blueprint).replace(/[^a-z0-9_]/gi, '') + '.js'); const mf = path.join(DIR, '..', 'blueprints', 'lib', 'mats.js')
  if (fresh) { delete require.cache[require.resolve(f)]; delete require.cache[require.resolve(mf)] }
  return require(f)({ x: q.origin[0], y: q.origin[1], z: q.origin[2] }, q.args || {}).map(require(mf).normalise)
}
const TERRAIN_BP = /^(level|fill_void|clear_area|quarry)$/
function buildJobs () { // every build job we know: the archive first, the board wins
  const m = new Map()
  try { for (const l of fs.readFileSync(path.join(DIR, 'jobs-archive.jsonl'), 'utf8').split('\n')) { if (!l) continue; try { const j = JSON.parse(l); if (j && j.type === 'build' && j.params && j.params.blueprint && Array.isArray(j.params.origin)) m.set(j.id, j) } catch (e_) { swallow('army:buildJobsLine', e_) } } } catch (e_) { swallow('army:buildJobsArchive', e_) }
  for (const j of (readJSON(F.board, {}) || {}).jobs || []) if (j.type === 'build' && j.params && j.params.blueprint && Array.isArray(j.params.origin)) m.set(j.id, j)
  return [...m.values()]
}
let _ours = { t: 0, cells: new Map(), boxes: [], pens: [], pads: [] }
function ours () {
  if (Date.now() - _ours.t < 300000) return _ours
  const cells = new Map(); const boxes = []; const pens = []; const pads = []
  for (const j of buildJobs()) {
    if (j.params.blueprint === 'level' && /build complete|auto-reactivated|auto-restored|cells nobody could do/.test(String(j.note || ''))) { const a = j.params.args || {}; /* a pad that was FINISHED once: an infill tile still in work is natural ground, its own job cuts it */ const w = a.w || 15; const d = a.d || w; const o = j.params.origin; pads.push({ job: j.id, x1: o[0] - Math.floor(w / 2), z1: o[2] - Math.floor(d / 2), x2: o[0] + Math.floor(w / 2), z2: o[2] + Math.floor(d / 2), y: o[1] }) }
    if (TERRAIN_BP.test(String(j.params.blueprint))) continue
    try {
      let x1 = Infinity; let z1 = Infinity; let x2 = -Infinity; let z2 = -Infinity; let y1 = Infinity; let y2 = -Infinity
      for (const c of blueprintCellsOf(j.params)) {
        if (c.block === 'air' || c.fillOnly || c.solid) continue
        cells.set(c.x + ',' + c.y + ',' + c.z, { job: j.id, block: c.block, mats: c.mats || null })
        if (c.x < x1) x1 = c.x; if (c.x > x2) x2 = c.x; if (c.z < z1) z1 = c.z; if (c.z > z2) z2 = c.z; if (c.y < y1) y1 = c.y; if (c.y > y2) y2 = c.y
      }
      if (x1 !== Infinity) boxes.push({ job: j.id, blueprint: j.params.blueprint, x1, z1, x2, z2, y1, y2 })
    } catch (e_) { swallow('army:oursCells', e_) }
  }
  for (const j of (readJSON(F.board, {}) || {}).jobs || []) { const p = j.params || {}; if (j.type === 'herd' && Array.isArray(p.pen) && p.pen.length === 4 && Array.isArray(p.gate)) pens.push({ job: j.id, x1: Math.min(p.pen[0], p.pen[2]), z1: Math.min(p.pen[1], p.pen[3]), x2: Math.max(p.pen[0], p.pen[2]), z2: Math.max(p.pen[1], p.pen[3]), y: p.gate[1] }) }
  _ours = { t: Date.now(), cells, boxes, pens, pads }
  return _ours
}
// a column of a BUILT ZONE: inside a level pad of ours or inside the footprint (+1) of a structure -> its ground level (pad y / structure base), else null
function zoneAt (x, z) { const o = ours(); for (const p of o.pads) if (x >= p.x1 && x <= p.x2 && z >= p.z1 && z <= p.z2) return p.y; for (const b of o.boxes) { const m = /^road/.test(b.blueprint) ? 0 : 1; if (x >= b.x1 - m && x <= b.x2 + m && z >= b.z1 - m && z <= b.z2 + m) return /^(road|road_path|field_block|tree_farm|core)$/.test(b.blueprint) ? b.y1 : b.y1 - 1 } return null }
// the block standing at pos IS what a blueprint of ours put there (name or an accepted substitute)
function ourBlock (pos, name) { const c = ours().cells.get(Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z)); return c && (c.block === name || (c.mats && c.mats.includes(name))) ? c : null }
// strictly INSIDE a pen's fence ring, from the floor's top (the fence level) up: nothing is ever placed or left there
function penAt (x, y, z) { for (const p of ours().pens) if (x > p.x1 && x < p.x2 && z > p.z1 && z < p.z2 && y >= p.y && y <= p.y + 4) return p; return null }
// the bot stands inside something we built: in a pen, or the first solid block over its head is a cell of ours (dorm roof, hall) - never a cave
function insideOurs (bot) {
  const p = bot.entity.position.floored()
  const pen = penAt(p.x, p.y, p.z); if (pen) return pen.job
  for (let dy = 2; dy <= 12; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (!b) return null; if (b.boundingBox === 'block' && !/leaves/.test(b.name)) { const c = ourBlock(b.position, b.name); return c ? c.job : null } }
  return null
}
// roofed in (old tunnels/pits)? walking can never help: dig a 1x2 STAIRCASE up (stairUp), log the hole for cleanup
function skyAbove (bot) {
  const p = bot.entity.position.floored()
  for (let dy = 2; dy <= 40; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (!b) return true
    if (b.boundingBox === 'block' && !/leaves|snow/.test(b.name)) return false
  }
  return true
}
// ---- ESCAPE DOCTRINE (owner: "each bot optimises its own way and the next bot pays for it")
// Travel never edits the world: strictMovements + the terrain guard make the pathfinder read-only (measured: 0 pathfinder edits).
// A bot that still cannot move may make exactly ONE kind of edit, and it must leave the place BETTER for the next bot:
//   1. 1x1 shaft under open sky (the plateau is full of old pathfinder pits): pillar up inside it with dirt/cobble it carries
//      = the pit gets FILLED and stops trapping bots.                                                        -> ev 'pit_filled'
//   2. roofed in (cave/tunnel) or no filler: one 1x2 staircase up (bot.dig, not the pathfinder).             -> ev 'dug_out'
// Every edit is appended to bots/army/terrain_debt.jsonl so a repair job can tidy it; nothing is dug "to save a detour".
function debt (bot, rec) {
  try { fs.appendFileSync(path.join(DIR, 'terrain_debt.jsonl'), JSON.stringify(Object.assign({ t: Date.now(), bot: bot.username }, rec)) + '\n') } catch (e_) { swallow('army:309', e_) }
}
function inShaft (bot) {
  const p = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const b = bot.blockAt(p.offset(dx, 0, dz))
    if (!b || b.boundingBox !== 'block') return false
  }
  return true
}
// how many cells can the bot WALK to from here (step up 1, drop <= 3)? < 60 = boxed in (pit, pillar top, dug-out hollow; open ground hits the limit of 120).
// Only a boxed-in bot may use the escape edits; "no path to the target" on open ground is a routing problem, not a licence to dig.
function walkableArea (bot, limit = 120, maxDrop = 3) {
  const wet = b => b && b.name === 'water' // a swimming bot is not boxed in: water cells count as ground AND as room (else a bot in a river "has area 1" and digs out)
  const pass = b => b && (b.boundingBox === 'empty' || /fence_gate$/.test(b.name)) && b.name !== 'lava' // a closed fence gate is a door (canOpenDoors), not a wall: 15:37Z Nanami dug out of the closed respawn room
  const solid = b => b && b.boundingBox === 'block' && !/fence_gate$/.test(b.name)
  const stand = p => (solid(bot.blockAt(p.offset(0, -1, 0))) || wet(bot.blockAt(p.offset(0, -1, 0))) || wet(bot.blockAt(p))) && pass(bot.blockAt(p)) && pass(bot.blockAt(p.offset(0, 1, 0)))
  const start = bot.entity.position.floored()
  const seen = new Set([start.x + ',' + start.y + ',' + start.z])
  const q = [start]
  while (q.length && seen.size < limit) {
    const c = q.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [1, 0, -1, -2, -3]) {
        if (-dy > maxDrop) break
        if (dy === 1 && !pass(bot.blockAt(c.offset(0, 2, 0)))) continue
        const n = c.offset(dx, dy, dz)
        if (dy < 0 && !pass(bot.blockAt(c.offset(dx, 1, dz)))) break
        if (!stand(n)) continue
        const k = n.x + ',' + n.y + ',' + n.z
        if (!seen.has(k)) { seen.add(k); q.push(n) }
        break
      }
    }
  }
  return seen.size
}
async function fillShaft (bot) {
  const BL = require('./blocks')
  const from = bot.entity.position.floored()
  let risen = 0
  for (let i = 0; i < 12 && inShaft(bot) && !U.cancelled(bot); i++) {
    const r = await U.withTimeout(BL.pillarUp(bot, 1, {}), 8000, 'pillarUp').catch(() => 0)
    if (!r) break
    risen += r
  }
  if (risen) {
    // these blocks are terrain now, not scaffolding: take them out of the scaffold ledger so nobody "cleans them up"
    try { const f = path.join(__dirname, '..', '..', '.scaffold', bot.username + '.json'); const l = (readJSON(f, []) || []).filter(e => !(e.x === from.x && e.z === from.z)); writeJSON(f, l) } catch (e_) { swallow('army:355', e_) }
    result(bot, { ev: 'pit_filled', at: [from.x, from.y, from.z], blocks: risen, out: !inShaft(bot) })
  }
  return !inShaft(bot)
}
// PERCHED (helpdesk 09-19 14:20Z: a bot 4 above the ground with no way down): a bot on top of a free-standing 1-wide COLUMN (a pillar left by an
// escape or a scaffold; nothing solid beside the two blocks under it) whose reversible surroundings (step up 1 / down 1) are < 150 cells comes
// down the way a player does - it digs the column away under its feet (blocks.pillarDown: never a jump, and the junk pillar is gone for the
// next bot). On a WIDER structure (wall top, roof) nothing is dug: event `marooned` (where, island size) for the operator/helpdesk.
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
function onColumn (bot) {
  const f = bot.entity.position.floored(); const u = bot.blockAt(f.offset(0, -1, 0))
  if (!u || u.boundingBox !== 'block' || U.protectedBlock(u) || ourBlock(u.position, u.name)) return false // a post, a wall top, a cap of OURS is not a junk pillar
  for (const dy of [-1, -2]) for (const [dx, dz] of N4) { const b = bot.blockAt(f.offset(dx, dy, dz)); if (!b || b.boundingBox === 'block') return false }
  return true
}
async function stepDown (bot) {
  const BL = require('./blocks'); const from = bot.entity.position.floored(); let down = 0
  for (let i = 0; i < 12 && onColumn(bot) && !U.cancelled(bot); i++) { const r = await U.withTimeout(BL.pillarDown(bot, 1, { any: true }), 25000, 'pillarDown').catch(e_ => { swallow('army:stepDown', e_); return 0 }); if (!r) break; down += r }
  if (down) { result(bot, { ev: 'stepped_down', from: [from.x, from.y, from.z], blocks: down, area: walkableArea(bot, 150, 1) }); debt(bot, { kind: 'pillar_removed', at: [from.x, from.y - 1, from.z], blocks: down }) }
  return down
}
// Dig a 1x2 staircase upward through solid ground: the only thing that reliably gets a bot out of a roofed cave — no scaffolding needed (it steps
// onto the rock it tunnels through), works bare-handed (slowly), and leaves a permanent exit for the next bot. Lava anywhere near a block to break
// is a veto; water only when it IS the block or sits right on top of it (it would pour into the staircase) — stricter vetoed every direction.
const STEP_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]
function digHazard (bot, q) {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) { const b = bot.blockAt(q.offset(dx, dy, dz)); if (b && b.name === 'lava') return 'lava' }
  for (const p of [q, q.offset(0, 1, 0)]) { const b = bot.blockAt(p); if (b && (b.name === 'water' || b.name === 'lava')) return 'liquid' }
  return null
}
async function stairUp (bot, targetY, ms = 300000, done = null) {
  const end = Date.now() + ms
  let di = bot.__stairDir == null ? 0 : bot.__stairDir
  let fails = 0
  // THE STAIRCASE DIES WITH THE BOT (09-20: a staircase begun at y-15 in the mine went on under the DORM ROOF after the respawn - see ours()): a death, a respawn or
  // any jump of the position ends it; blocks of our own blueprints are never dug, no step is ever placed inside a pen; placed steps are remembered for digOut's cleanup
  const life = bot.__armyDeaths || 0; let lastP = bot.entity.position.clone()
  // OUT IS OUT (09-20: 26 single dirt-now-grass blocks at y69 east of the depot rows = the steps of bots that climbed out of the cave under road 1: the target was
  // "start + 4", so a bot 2 deep went on building steps in the open air of the pad - Hotaru `dug_out from [-345,66,-494] to [-347,70,-505]`): done() ends the climb.
  while (bot.entity.position.y < targetY && Date.now() < end && fails < 30 && !(done && done())) {
    U.ck(bot)
    if ((bot.__armyDeaths || 0) !== life || bot.__armyDied || bot.health <= 0 || bot.entity.position.distanceTo(lastP) > 6) { bot.clearControlStates(); return false }
    lastP = bot.entity.position.clone()
    if (bot.entity.isInWater) { if (bot.swimToShore) await bot.swimToShore(25000).catch(e_ => swallow('army:stairSwim', e_)); fails++; continue }
    const feet = bot.entity.position.floored()
    const [dx, dz] = STEP_DIRS[di % STEP_DIRS.length]
    const step = feet.offset(dx, 0, dz) // the block we will stand ON
    const p1 = step.offset(0, 1, 0); const p2 = step.offset(0, 2, 0) // feet + head space after the climb
    const sb0 = bot.blockAt(step)
    if ((sb0 && (sb0.name === 'water' || sb0.name === 'lava')) || digHazard(bot, p1) || digHazard(bot, p2)) { di++; fails++; continue }
    let ok = true
    for (const q of [feet.offset(0, 2, 0), p2, p1]) { // our own head room first, so we can jump
      U.ck(bot)
      const b = bot.blockAt(q)
      if (!b || b.boundingBox === 'empty') continue
      if (U.protectedBlock(b) || ourBlock(q, b.name) || b.name === 'bedrock' || !await U.digBlock(bot, b, 35000, true)) { ok = false; break }
      await sleep(120)
    }
    if (!ok) { di++; fails++; await sleep(400); continue }
    const sb = bot.blockAt(step)
    if (!sb || sb.boundingBox !== 'block') {
      const fill = penAt(step.x, step.y, step.z) ? null : FILLERS.concat(['gravel', 'netherrack']).find(n => count(bot, n))
      if (fill) { await U.safe(bot, () => U.placeBlockAt(bot, fill, step), 'stairFloor'); const sb1 = bot.blockAt(step); if (sb1 && sb1.name === fill) (bot.__stairPlaced = bot.__stairPlaced || []).push({ x: step.x, y: step.y, z: step.z, name: fill }) }
      const sb2 = bot.blockAt(step)
      if (!sb2 || sb2.boundingBox !== 'block') { di++; fails++; continue }
    }
    const before = bot.entity.position.y
    await bot.lookAt(new Vec3(step.x + 0.5, feet.y + 1.2, step.z + 0.5), true).catch(e_ => swallow('army:stairLook', e_))
    bot.setControlState('forward', true); bot.setControlState('jump', true)
    await sleep(500)
    bot.setControlState('jump', false)
    await sleep(500)
    bot.clearControlStates()
    await U.pickupNear(bot, 400, 3)
    if (bot.entity.position.y > before + 0.4) fails = 0; else { fails++; if (fails % 2 === 0) di++ }
  }
  bot.__stairDir = di % STEP_DIRS.length
  bot.clearControlStates()
  return bot.entity.position.y >= targetY - 1
}
// the level a bot can WALK at beside its column: the highest standable top (solid, two free cells over it) among the four neighbours, feet y. null = none in sight
function levelAround (bot) {
  const p = bot.entity.position.floored(); let best = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let y = p.y + 8; y >= p.y - 4; y--) {
    const b = bot.blockAt(new Vec3(p.x + dx, y, p.z + dz)); if (!b) break
    if (b.boundingBox !== 'block') continue
    const a1 = bot.blockAt(new Vec3(p.x + dx, y + 1, p.z + dz)); const a2 = bot.blockAt(new Vec3(p.x + dx, y + 2, p.z + dz))
    if (a1 && a2 && a1.boundingBox !== 'block' && a2.boundingBox !== 'block') { if (best == null || y + 1 > best) best = y + 1 }
    break
  }
  return best
}
// A PILLAR NEVER STANDS ABOVE THE GROUND (foreman 09-20 06:25Z: 9 placed blocks above y68 in no blueprint, 6 of them cobbled_deepslate on finished pads - the pit
// escape pillared on while "walkable area < 60" stayed true on a fenced pad, up to 8 blocks into the air, and left it). Once out, the bot takes its own blocks
// (the scaffold ledger proves they are its own) down again until it stands level with the ground beside it: what is left FILLS the hole, flush.
async function trimPillar (bot) {
  try {
    const lvl = levelAround(bot); const y = Math.floor(bot.entity.position.y + 0.01)
    if (lvl == null || y <= lvl) return 0
    const n = await U.withTimeout(require('./blocks').pillarDown(bot, y - lvl), 30000, 'trimPillar').catch(e_ => { swallow('army:trimPillar', e_); return 0 })
    if (n) result(bot, { ev: 'pillar_trimmed', at: [Math.floor(bot.entity.position.x), lvl, Math.floor(bot.entity.position.z)], blocks: n })
    return n
  } catch (e_) { swallow('army:trimPillar2', e_); return 0 }
}
// A PIT OR POCKET INSIDE OUR OWN ZONE (06:35Z: Yui at -378,66,-511 and Tsumugi at -340,66,-496 stood 30+ min in 3-cell pockets two blocks under the PAVING of a field
// path / road 1, `no_route` x120, `shut_in` - the ours() rule forbids every escape edit there, and rightly so for a dorm or a pen). Such a hole is the DEFECT: it is
// reported (`pit`) for the pad audit, and the bot leaves like a player would - straight up through its own column on its own filler, which stays as the hole's fill,
// flush with the zone's ground. Roofed by plain ground/paving of ours (at most 2 blocks, nothing standing on it): that lid is opened from below and the last pillar
// block closes it again with the lid's own material. Never farmland, furniture, fences, walls; never a room (walkable area >= 12: the gate is the way out).
const LID_RE = /^(cobblestone|mossy_cobblestone|stone|cobbled_deepslate|deepslate|andesite|diorite|granite|tuff|dirt|coarse_dirt|grass_block|stone_bricks|[a-z_]+_planks)$/
async function pitExit (bot, own) {
  if (walkableArea(bot) >= 12 || Date.now() - (bot.__armyPitT || 0) < 300000) return false
  const from = bot.entity.position.floored(); const gy = zoneAt(from.x, from.z)
  if (gy == null || penAt(from.x, from.y, from.z)) return false
  const depth = gy + 1 - from.y; if (depth < 1 || depth > 6) return false
  bot.__armyPitT = Date.now() - 180000 // one try per 2 min
  const lids = []
  for (let y = from.y + 2; y <= gy + 2; y++) { const b = bot.blockAt(new Vec3(from.x, y, from.z)); if (!b) return false; if (b.boundingBox === 'block') { if (y > gy || !LID_RE.test(b.name) || lids.length >= 2) return false; lids.push(b) } else if (y > gy && !/^(air|cave_air)$/.test(b.name)) return false } // something stands on the lid (crop, torch, rail): not ours to open
  result(bot, { ev: 'pit', at: [from.x, from.y, from.z], depth, roofed: lids.length > 0, inside: own, note: 'a hole in a finished zone: the pad/infill audit owes this column a fill' })
  debt(bot, { kind: 'pit', at: [from.x, from.y, from.z], depth, inside: own })
  if (FILLERS.reduce((n, f) => n + count(bot, f), 0) < depth) return false
  const BL = require('./blocks'); let lidItem = null
  for (const b of lids) { const r = await BL.digBlock(bot, b.position, { requireHarvest: false, collect: true, plug: false, own: true /* the ONE sanctioned opening of a cell of ours: a plain lid, closed again with its own material two seconds later */ }).catch(e_ => { swallow('army:pitLid', e_); return { ok: false, reason: String(e_ && e_.message) } }); if (!r.ok) { result(bot, { ev: 'pit_left', from: [from.x, from.y, from.z], blocks: 0, out: false, why: 'lid: ' + r.reason }); return false } lidItem = b.name === 'grass_block' ? 'dirt' : /^(stone|deepslate)$/.test(b.name) ? (b.name === 'stone' ? 'cobblestone' : 'cobbled_deepslate') : b.name }
  let up = 0
  // SQUARE IN THE COLUMN FIRST (06:50Z Yui: lid open, pillarUp 0 - she stood 0.25 off the centre, her head met the paving of the NEXT column at the top of every jump)
  const centre = async () => { const end = Date.now() + 1500; while (Date.now() < end) { const q = bot.entity.position; const dx = from.x + 0.5 - q.x; const dz = from.z + 0.5 - q.z; if (Math.hypot(dx, dz) < 0.12) break; try { await bot.look(Math.atan2(-dx, -dz), 0, true) } catch (e_) { swallow('army:pitCentre', e_) } bot.setControlState('forward', true); await sleep(50); bot.setControlState('forward', false); await sleep(50) } bot.clearControlStates() }
  for (let i = 0; i < depth && !U.cancelled(bot); i++) { const last = i === depth - 1; await centre(); const r = await U.withTimeout(BL.pillarUp(bot, 1, last && lidItem && count(bot, lidItem) > 0 ? { item: lidItem } : {}), 8000, 'pitPillar').catch(() => 0); if (!r) break; up += r }
  await trimPillar(bot)
  try { writeJSON(path.join(__dirname, '..', '..', '.scaffold', bot.username + '.json'), []) } catch (e_) { swallow('army:pitLedger', e_) } // the column is the hole's fill now, nobody's scaffold
  const out = walkableArea(bot) >= 12
  result(bot, { ev: 'pit_left', from: [from.x, from.y, from.z], blocks: up, out })
  return out
}
async function digOut (bot, pit) {
  const from = bot.entity.position.floored()
  // SHUT IN A BUILDING OF OURS IS NOT BOXED IN (dorm, hall, pen): the way out is the gate, which the pathfinder opens. No edit, one report per 10 min.
  const own = insideOurs(bot); const zy = zoneAt(from.x, from.z)
  if ((own || (zy != null && from.y <= zy - 1)) && await pitExit(bot, own || 'zone')) { strictMovements(bot); return }
  if (own) { if (Date.now() - (bot.__armyShutInT || 0) > 600000) { bot.__armyShutInT = Date.now(); result(bot, { ev: 'shut_in', at: [from.x, from.y, from.z], inside: own, area: walkableArea(bot) }) } strictMovements(bot); return }
  const life = bot.__armyDeaths || 0; const gone = () => (bot.__armyDeaths || 0) !== life || !!bot.__armyDied || !bot.entity || bot.health <= 0
  bot.__stairPlaced = []
  if (pit && inShaft(bot) && await fillShaft(bot)) { strictMovements(bot); return }
  // open-sky pit wider than 1x1, blocks in the pocket: pillar up until the bot can walk again (max 8). Logged as debt (a pillar in a pit).
  if (pit) {
    const BL = require('./blocks'); let up = 0
    for (let i = 0; i < 8 && walkableArea(bot) < 60 && !U.cancelled(bot) && !gone(); i++) { const lvl = levelAround(bot); if (lvl != null && bot.entity.position.y >= lvl) break; /* level with the ground beside us: higher helps nobody */ const r = await U.withTimeout(BL.pillarUp(bot, 1, {}), 8000, 'pillarUp').catch(() => 0); if (!r) break; up += r }
    if (up) await trimPillar(bot)
    // ...and FLUSH: "can walk again" is true one block under the rim, which left a 1-deep dip in the pad (06:50Z Yui: column top y67 under a path at y68)
    if (up && !U.cancelled(bot) && !gone()) { const lvl = levelAround(bot); if (lvl != null && Math.floor(bot.entity.position.y + 0.01) === lvl - 1) up += await U.withTimeout(BL.pillarUp(bot, 1, {}), 8000, 'pillarFlush').catch(() => 0) }
    if (up) { const to = bot.entity.position.floored(); result(bot, { ev: 'pillared_out', from: [from.x, from.y, from.z], blocks: up, free: walkableArea(bot) >= 60 }); debt(bot, { kind: 'pillar', at: [from.x, from.y, from.z], blocks: up }); if (walkableArea(bot) >= 60) { strictMovements(bot); return } void to }
  }
  // ROOFED IN (cave, tunnel) with filler blocks in the pockets: the classic player escape — dig the two blocks overhead, jump, place under the
  // feet, repeat until the sky is open. The shaft is filled by the pillar itself, so nothing is left open behind (hand-dug stone: ~15 s per level).
  if (!pit && !skyAbove(bot)) {
    const BL = require('./blocks'); let up = 0
    const fillers = () => FILLERS.reduce((n, f) => n + count(bot, f), 0)
    const falling = () => { const p0 = bot.entity.position.floored(); for (let dy = 2; dy <= 4; dy++) { const b = bot.blockAt(p0.offset(0, dy, 0)); if (b && /^(gravel|sand|red_sand|.*concrete_powder|water|lava)$/.test(b.name)) return b.name } return null }
    // guards (4 bots suffocated on 09-19): never dig up into gravel/sand/liquid, at most 14 levels per attempt, then the staircase takes over
    for (let i = 0; i < 14 && !skyAbove(bot) && fillers() > 0 && !falling() && !U.cancelled(bot) && !gone(); i++) { const r = await U.withTimeout(BL.pillarUp(bot, 1, {}), 45000, 'nerdPole').catch(e_ => { swallow('army:nerdPole', e_); return 0 }); if (!r) break; up += r }
    if (up && skyAbove(bot)) await trimPillar(bot) // before the ledger is cleared: pillarDown only takes blocks the ledger calls ours
    if (up) { const to0 = bot.entity.position.floored(); result(bot, { ev: 'pillared_out', from: [from.x, from.y, from.z], blocks: up, free: skyAbove(bot) }); try { const f = path.join(__dirname, '..', '..', '.scaffold', bot.username + '.json'); writeJSON(f, []) } catch (e_) { swallow('army:nerdLedger', e_) } if (skyAbove(bot)) { strictMovements(bot); void to0; return } }
  }
  try {
    // stairUp checks its deadline only BETWEEN steps and one hand-dug step can take 3 x 35 s: an outer timeout 5 s after the inner one fired ~100x
    // (errors `army:373 timeout:stairUp`) and left stairUp digging on as a zombie while travel() walked the same bot. Slack = one full step.
    if (pit && !gone()) await U.withTimeout(stairUp(bot, from.y + 4, 90000, () => skyAbove(bot) && walkableArea(bot) >= 60), 90000 + 115000, 'stairUp')
    for (let i = 0; i < 12 && !skyAbove(bot) && !U.cancelled(bot) && !gone() && !insideOurs(bot); i++) await U.withTimeout(stairUp(bot, Math.floor(bot.entity.position.y) + 3, 60000, () => skyAbove(bot) && walkableArea(bot) >= 60), 60000 + 115000, 'stairUp')
  } catch (e_) { swallow('army:373', e_) }
  if (gone()) { result(bot, { ev: 'escape_aborted', from: [from.x, from.y, from.z], why: 'the bot died during the escape' }); bot.__stairPlaced = []; strictMovements(bot); return }
  const to = bot.entity.position.floored()
  // STEPS LEFT IN THE OPEN ARE LITTER (rule: what a routine places as a help it takes away again): a placed step at or above the level the bot walked out on
  // is dug and collected; steps below it are fill in the hole and stay.
  try {
    const BL = require('./blocks')
    for (const q of (bot.__stairPlaced || []).filter(q => q.y >= to.y).sort((a, b) => b.y - a.y)) { if (U.cancelled(bot) || gone()) break; const b = bot.blockAt(new Vec3(q.x, q.y, q.z)); if (b && b.name === q.name && !(q.x === to.x && q.z === to.z && q.y === to.y - 1)) await BL.digBlock(bot, new Vec3(q.x, q.y, q.z), { collect: true, requireHarvest: false, plug: false }).catch(e_ => swallow('army:stairLitter', e_)) }
  } catch (e_) { swallow('army:stairCleanup', e_) }
  bot.__stairPlaced = []
  if (to.distanceTo(from) >= 1) {
    result(bot, { ev: 'dug_out', pit: !!pit, from: [from.x, from.y, from.z], to: [to.x, to.y, to.z], sky: skyAbove(bot) })
    debt(bot, { kind: 'staircase', from: [from.x, from.y, from.z], to: [to.x, to.y, to.z] })
  } else if (Date.now() - (bot.__armyStrandedT || 0) > 10 * 60000) { // operator: `armyctl.js rescue <bot>`
    bot.__armyStrandedT = Date.now()
    result(bot, { ev: 'stranded', at: [from.x, from.y, from.z], area: walkableArea(bot) })
  }
  strictMovements(bot)
}

// travel to target {x,y,z} (y may be null). Hops <= 40 blocks (pathfinder is capped at 12 ms/tick).
// opts: range, ms, stop() -> true aborts, via: [[x,y,z],...] waypoints walked first
async function travel (bot, target, opts = {}) {
  const range = opts.range == null ? 2 : opts.range
  const end = Date.now() + (opts.ms || 240000)
  const stop = () => U.cancelled(bot) || (opts.stop && opts.stop()) || Date.now() > end
  for (const w of (opts.via || [])) {
    if (stop()) return false
    if (dist2(bot, w[0], w[2]) < 12) continue
    await travel(bot, { x: w[0], y: w[1], z: w[2] }, { range: 5, ms: Math.max(10000, end - Date.now()), stop: opts.stop })
  }
  let fails = 0
  let dug = false
  let relaxed = false
  let best = Infinity
  const dbg = { n: 0, ok: 0, last: null }
  // SURFACE + REVERSIBLE RULE: defined once above strictMovements()
  const floorY = surfaceFloor(bot)
  const surfaceTrip = floorY != null && bot.entity.position.y >= floorY && (target.y == null || target.y >= floorY) && !opts.anyDepth
  const floorRule = b => (b && b.position && b.position.y < floorY ? 100 : 0)
  // KEEP-OUT RULE (world 2, 09-19: every trip east of the base ended on the ravine floor at -305,53,-458 with `no_route`; a hunter fell to her
  // death): inside a `settings.keepOut` box nobody steps BELOW the base level - the rim and pads stay walkable, the hole does not exist for
  // the pathfinder. Not for a bot that is already down there (it must walk out) nor for a job whose target lies in the hole (ores, quarry).
  const KO = (settings().keepOut || []).map(k => k && k.box).filter(b => Array.isArray(b) && b.length === 4).map(b => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])])
  const koY = ((settings().base || {}).y || SEA_LEVEL + 5) - 3
  const inKO = (x, y, z) => y < koY && KO.some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3])
  const keepRule = b => (b && b.position && inKO(b.position.x, b.position.y, b.position.z) ? 100 : 0)
  const keepOn = KO.length > 0 && !inKO(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z) && !(target.y != null && inKO(target.x, target.y, target.z)) && !opts.anyDepth
  // OUT OF THE HOLE FIRST: a bot that is down in a keep-out (fell, was knocked in, worked the quarry) and wants to go elsewhere walks to the
  // hole's known EXIT before anything else (`settings.keepOut[].exit:[x,y,z]`, e.g. the ravine's natural ramp at its north end) - hopping
  // 38 blocks towards a target behind a 25-block cliff never finds it (09-19 22:21Z: six bots at -313,53,-427, `no_route` x12 a minute).
  if (!opts._viaExit && inKO(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z) && !(target.y != null && inKO(target.x, target.y, target.z))) {
    const me = bot.entity.position; const k = (settings().keepOut || []).find(q => q && Array.isArray(q.exit) && Array.isArray(q.box) && me.x >= Math.min(q.box[0], q.box[2]) && me.x <= Math.max(q.box[0], q.box[2]) && me.z >= Math.min(q.box[1], q.box[3]) && me.z <= Math.max(q.box[1], q.box[3]))
    if (k) await travel(bot, new Vec3(k.exit[0], k.exit[1], k.exit[2]), Object.assign({}, opts, { range: 3, ms: Math.min(opts.ms || 120000, 120000), quiet: true, _viaExit: true, anyDepth: true }))
  }
  const mv0 = bot.pathfinder.movements
  // RUN: the Movements object lives for hours (strictMovements runs at worker start / after a death) - the larder is asked per TRIP, and a new terrain-guard
  // version is installed here (measured 09-20 06:20Z: 50/50 bots allowSprinting=false, the guard's old timer kept switching it off)
  try { require('./terrain_guard').install(bot); if (mv0) mv0.allowSprinting = larderFull() && bot.food > 6 } catch (e_) { swallow('army:travelSprint', e_) }
  if (surfaceTrip && mv0 && !mv0.exclusionAreasStep.includes(floorRule)) mv0.exclusionAreasStep.push(floorRule)
  if (keepOn && mv0) mv0.exclusionAreasStep.push(keepRule)
  const ms0 = musterPos()
  const homeward = !!ms0 && Math.hypot(target.x - ms0.x, target.z - ms0.z) + 8 < Math.hypot(bot.entity.position.x - ms0.x, bot.entity.position.z - ms0.z)
  if (surfaceTrip && mv0) { mv0.maxDropDown = DROP.surface; mv0.infiniteLiquidDropdownDistance = false }
  const dropRule = () => { try { const m = bot.pathfinder.movements; if (m) { m.exclusionAreasStep = m.exclusionAreasStep.filter(f => f !== floorRule && f !== keepRule); m.maxDropDown = DROP.normal } } catch (e_) { swallow('army:dropRule', e_) } }
  // boxed in right now and the target is elsewhere: don't burn the whole time budget on path attempts that cannot succeed — escape first
  if (!opts.quiet && dist2(bot, target.x, target.z) > 6 && Date.now() - (bot.__armyEscT || 0) > 120000) {
    const rev = walkableArea(bot, 150, 1) // what the bot can walk AND walk back from
    if (rev < 150 && onColumn(bot)) { bot.__armyEscT = Date.now(); await stepDown(bot) } else if (rev < 150 && walkableArea(bot) < 60) { bot.__armyEscT = Date.now(); dug = true; await digOut(bot, skyAbove(bot)) } else if (rev < 150 && surfaceTrip && skyAbove(bot) && Date.now() - (bot.__armyMaroonT || 0) > 600000) {
      bot.__armyMaroonT = Date.now(); const p1 = bot.entity.position.floored(); const u1 = bot.blockAt(p1.offset(0, -1, 0))
      result(bot, { ev: 'marooned', at: [p1.x, p1.y, p1.z], on: u1 && u1.name, island: rev, area: walkableArea(bot) })
    }
  }
  while (!stop()) {
    while (sheltering(bot) && !stop()) await sleep(300) // the enderman-shelter reflex owns the legs for a few seconds
    dbg.n++
    const p = bot.entity.position
    const d = dist2(bot, target.x, target.z)
    const dy = target.y == null ? 0 : Math.abs(p.y - target.y)
    // arrival is judged on BLOCK coordinates, exactly like the pathfinder's GoalNear*: judging on the exact position made a bot 2.55
    // blocks away wait forever next to a goal the pathfinder already called reached
    const db = Math.hypot(Math.floor(p.x) - Math.floor(target.x), Math.floor(p.z) - Math.floor(target.z))
    if ((d <= range + 0.5 || db <= range) && dy <= Math.max(2, range)) { dropRule(); if (relaxed) strictMovements(bot); return true }
    let goal
    if (d > 44) {
      const t = 38 / d
      goal = new goals.GoalNearXZ(Math.round(p.x + (target.x - p.x) * t), Math.round(p.z + (target.z - p.z) * t), 4)
    } else goal = target.y == null ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range)
    const r = await U.pathTo(bot, goal, Math.min(45000, Math.max(5000, end - Date.now()))).catch(() => 'fail')
    dbg.last = r
    if (sheltering(bot)) continue // interrupted by the shelter reflex: not a failed attempt
    if (r === 'ok') {
      // 'ok' without getting closer = the pathfinder thinks it arrived and we do not (or a zero-length path): count it, never spin on it
      const dOk = dist2(bot, target.x, target.z)
      if (dOk <= best - 1) { dbg.ok = 0; fails = 0; best = dOk; await sleep(50); continue }
      dbg.ok++ // no progress: fall through and count it as a failed attempt (partial/empty path)
    }
    // progress = getting CLOSER to the target, not just moving: a bot pacing around inside a dug-out hollow moves plenty and arrives never
    const d2 = dist2(bot, target.x, target.z)
    if (d2 > best - 3) {
      fails++
      // standing on a partial block (dirt_path, farmland, soul sand: y = n.9) puts the A* start node INSIDE a block -> instant noPath.
      // No edit needed: step off it towards the target by hand.
      if (bot.entity.position.y % 1 > 0.4 || bot.entity.position.y % 1 < -0.4) {
        try { await bot.lookAt(new Vec3(target.x + 0.5, bot.entity.position.y + 1.6, target.z + 0.5), true) } catch (e_) { swallow('army:432', e_) }
        bot.setControlState('forward', true); bot.setControlState('jump', true); await sleep(700); bot.clearControlStates(); await sleep(300)
      }
      if (fails === 1 || fails === 3) { try { if (bot.unwedge) await U.withTimeout(bot.unwedge(), 8000, 'unwedge') } catch (e_) { swallow('army:435', e_) } }
      // boxed in -> escape. Roofed in (a cave under the base, however large) with no way up after 3 tries -> one staircase to the
      // surface: it is logged as terrain debt and serves every later bot that falls into the same cave.
      if (!dug && ((fails >= 2 && walkableArea(bot) < 60) || (fails >= 3 && !skyAbove(bot)))) { dug = true; await digOut(bot, skyAbove(bot)); continue }
      // hard-avoided blocks (berry bushes we planted ourselves!) can wall a bot in: the only exit of Yui's hollow was a bush (09-19).
      // Second failure -> ONE attempt with farmland/campfire walkable. NOT berry bushes: 3 more bots were poked to death in the base hedge.
      if (fails === 2 && !relaxed && !opts.noRelax) { relaxed = true; const mv = strictMovements(bot); for (const n of ['farmland', 'campfire']) { const b = bot.registry.blocksByName[n]; if (b) mv.blocksToAvoid.delete(b.id) } if (surfaceTrip) { mv.exclusionAreasStep.push(floorRule); mv.maxDropDown = homeward ? DROP.homeward : DROP.surface; mv.infiniteLiquidDropdownDistance = false } if (keepOn) mv.exclusionAreasStep.push(keepRule); bot.pathfinder.setMovements(mv); continue }
      if (fails === 4 && !opts.quiet) askHelp(bot, 'no_route', 'cannot path to ' + [Math.round(target.x), target.y == null ? '?' : Math.round(target.y), Math.round(target.z)].join(',') + ' (walkable area ' + walkableArea(bot) + ')')
      if (fails === 4 && !opts.quiet) result(bot, { ev: 'no_route', from: [Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)], to: [Math.round(target.x), target.y == null ? null : Math.round(target.y), Math.round(target.z)], area: walkableArea(bot), island: walkableArea(bot, 150, 1) })
      if (fails >= 5) return false
      await sleep(800)
    } else { best = d2; fails = Math.max(0, fails - 1) }
  }
  dropRule()
  if (relaxed) strictMovements(bot)
  if (dbg.n > 1 && !opts.quiet) result(bot, { ev: 'travel_fail', why: 'timeout/stop', to: [target.x, target.y, target.z], tries: dbg.n, fails, last: dbg.last, d: Math.round(dist2(bot, target.x, target.z)) })
  return false
}

// ------------------------------------------------------------------ chests (ONE index: nobody circles chests looking for things)
const CATS = ['food', 'tools', 'ores', 'build', 'salvage']
const _fullT = {}
function categoryOf (bot, name) {
  if (bot.registry.foodsByName[name] || /^(wheat|wheat_seeds|bone_meal|egg|sugar|pumpkin|melon|.*_seeds|cake)$/.test(name)) return 'food'
  if (/_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(name) || /^(shield|bow|arrow|torch|bucket|water_bucket|lava_bucket|fishing_rod|shears|flint_and_steel|crafting_table|furnace|chest|.*_bed|campfire|ladder)$/.test(name)) return 'tools'
  if (/^(raw_|coal$|charcoal$|diamond$|emerald$|lapis|redstone$|flint$|.*_ingot$|.*_nugget$|.*_ore$|obsidian$|clay_ball$|amethyst)/.test(name)) return 'ores'
  if (/^(string|bone|.*_wool|feather|leather|gunpowder|spider_eye|rotten_flesh|ender_pearl|slime_ball|ink_sac|rabbit_hide|rabbit_foot|blaze_rod|stick|sugar_cane|paper|book|bookshelf|phantom_membrane|ender_eye|nether_wart|blaze_powder)$/.test(name)) return 'salvage' // craft materials of the enchanting/nether chain live with the mob loot, not in the stone-filled build chests (09-20)
  return 'build'
}
function chestsOf (cat) { return ((settings().chests || {})[cat] || []).map(c => new Vec3(c[0], c[1], c[2])) }
function index () { return readJSON(F.chests, {}) }
function record (bot, pos, win) {
  const items = {}
  let used = 0
  for (const i of win.containerItems()) { items[i.name] = (items[i.name] || 0) + i.count; used++ }
  const d = index()
  let size = 27; try { size = win.inventoryStart || 27 } catch (e_) { swallow('army:record', e_) }
  d[pos.x + ',' + pos.y + ',' + pos.z] = { items, used, size, t: Date.now(), by: bot.username }
  writeJSON(F.chests, d)
  return items
}
// TO A CONTAINER = TO A FREE CELL BESIDE IT (foreman 09-20 05:40Z: `travel_fail x25/30 min to [-359,69,-500]` and the other east-end chests of the double-chest rows,
// 21 bots: the travel target was the CHEST CELL itself with range 2 - a goal the pathfinder also meets ON TOP of the row or in the aisle behind it, and one that can
// never be "arrived at" when the near cells are taken). The walk goes to a standable cell of the aisle within reach of the container (<= 3.5 from its centre: floor
// solid and no container, feet + head free), nearest to the bot first, up to 3 candidates; only when the container's chunk is not loaded yet, or no such cell
// exists, the old "somewhere within 2" walk is used.
function standsBeside (bot, pos) {
  const out = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, -1, 1]) {
    if (!dx && !dz) continue
    const c = pos.offset(dx, dy, dz); if (c.offset(0.5, 1.6, 0.5).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 3.5) continue
    const f = bot.blockAt(c.offset(0, -1, 0)); const a = bot.blockAt(c); const h = bot.blockAt(c.offset(0, 1, 0)); if (!f || !a || !h) continue
    if (f.boundingBox !== 'block' || U.protectedBlock(f) || /fence|_wall$/.test(f.name)) continue
    if (a.boundingBox !== 'empty' || h.boundingBox !== 'empty' || /water|lava/.test(a.name)) continue
    out.push(c)
  }
  const me = bot.entity.position
  return out.sort((p, q) => (p.distanceTo(me) + 2 * Math.abs(p.y - pos.y)) - (q.distanceTo(me) + 2 * Math.abs(q.y - pos.y)))
}
async function walkTo (bot, pos, opts = {}) { // -> true when the bot stands within reach of the container at pos
  const near = () => bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 3.6
  if (near()) return true
  if (!bot.blockAt(pos) && !await travel(bot, pos, { range: 8, ms: opts.ms || 90000, stop: opts.stop })) return false // not in view yet: get close first
  for (const c of standsBeside(bot, pos).slice(0, 3)) { if (opts.stop && opts.stop()) return false; if (await travel(bot, c, { range: 0, ms: Math.min(opts.ms || 90000, 45000), stop: opts.stop, quiet: true }) || near()) return true }
  return near() || !!(await travel(bot, pos, { range: 2, ms: opts.ms || 90000, stop: opts.stop })) || near()
}
async function openChest (bot, pos, opts = {}) {
  if (!await walkTo(bot, pos, opts)) return null
  const b = bot.blockAt(pos)
  if (b && !/^(chest|trapped_chest|barrel)$/.test(b.name)) { // a REGISTERED chest is gone (creeper!): forget its stock, tell everybody, the quartermaster rebuilds it
    const key = pos.x + ',' + pos.y + ',' + pos.z
    const registered = CATS.some(c => chestsOf(c).some(q => q.equals(pos)))
    const d = index(); if (d[key]) { delete d[key]; writeJSON(F.chests, d) }
    if (registered && bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 6) missingChest(bot, pos, key, b.name)
    return null
  }
  if (!b) return null
  // a CHEST under a full solid block cannot open (09-19: cobblestone on two old-base chests; the quartermaster "drained 0 items" for an hour).
  // Nobody wants a lid blocker: remove it (never another container, slab, stair, glass, leaves, torch ... - those do not block a lid).
  if (/chest$/.test(b.name)) {
    const top = bot.blockAt(pos.offset(0, 1, 0))
    if (top && top.boundingBox === 'block' && !top.transparent && !/chest|barrel|slab|stairs|glass|leaves|shulker|farmland|path/.test(top.name) && !U.protectedBlock(top)) {
      const r = await require('./blocks.js').digBlock(bot, top.position, { collect: true, requireHarvest: false }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      result(bot, { ev: 'lid_unblocked', at: [pos.x, pos.y + 1, pos.z], block: top.name, ok: !!(r && r.ok) })
    }
  }
  try {
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch (e_) { swallow('army:488', e_) } await sleep(200) }
    return await U.withTimeout(bot.openContainer(b), 8000, 'openChest')
  } catch (e) { swallow('army:openChest', e); return null }
}
// A REGISTERED container that is gone (creeper; measured with 14+ lost barrels: `chest_missing` x454 in 30 min - every bot of every shard
// re-reported every container every 5 min, and bank() kept walking to them). Army-wide ledger bots/army/chest_missing.json: ONE report per
// container per 10 min; after 3 independent sightings of "no container there" (another bot, or the same bot >= 3 min later) the container is
// taken off settings.chests (never the last one of a category), so bank()/scan stop visiting it. The warehouse build job re-registers what it re-places.
function missingChest (bot, pos, key, found) {
  const f = path.join(DIR, 'chest_missing.json'); const now = Date.now()
  const d = readJSON(f, {}) || {}
  for (const k of Object.keys(d)) if (now - (d[k].t || 0) > 3600000) delete d[k]
  const e = d[key] = d[key] || { n: 0, said: 0, t: 0, by: null }
  if (e.by !== bot.username || now - e.t >= 180000) { e.n++; e.by = bot.username; e.t = now }
  const say = now - (e.said || 0) > 600000; if (say) e.said = now
  let dropped = null
  if (e.n >= 3) {
    boardEdit(b => { const ch = (b.settings && b.settings.chests) || {}; for (const c of Object.keys(ch)) { const i = (ch[c] || []).findIndex(q => q[0] === pos.x && q[1] === pos.y && q[2] === pos.z); if (i >= 0 && ch[c].length > 1) { ch[c].splice(i, 1); dropped = c } } })
    if (dropped) { delete d[key]; _settings.t = 0 }
  }
  writeJSON(f, d)
  if (dropped) result(bot, { ev: 'chest_dropped', at: [pos.x, pos.y, pos.z], cat: dropped, found, sightings: e.n })
  else if (say) result(bot, { ev: 'chest_missing', at: [pos.x, pos.y, pos.z], found, sightings: e.n })
}
function closeWin (w) { try { w && w.close() } catch (e_) { swallow('army:492', e_) } }
// While a container window is open, judge results on the WINDOW (its container part / its inventory part), never on bot.inventory:
// bot.inventory lags behind until the window closes, which made every successful deposit look like "chest full" and every
// successful withdraw look like "got nothing" (one item per chest visit, 0 'banked' reports, the old "chest circling").
function inChest (w, name) { let n = 0; for (const i of w.containerItems()) if (i.name === name) n += i.count; return n }
function inHand (w, name) { let n = 0; for (const i of w.items()) if (i.name === name) n += i.count; return n }

// ONE DISPOSAL FOR THE ARMY (owner 09-20: junk dropped at the depot is picked up by the next bot - pickup is automatic within a block - whose pockets fill, who cannot
// bank, who tosses again: THE "full-pocket bots circle the depot" loop, `junk_tossed` 48993 stone in 10 min). Junk is never dropped inside the base: it is carried
// to settings.dump = {at:[x,y,z] a standable rim cell of the ravine keep-out, aim:[x,y,z] a point down in the hole} and thrown in, where nobody walks; it despawns
// there. No dump on the board / not reachable / interrupted = the bot KEEPS the junk and says so once per 10 min (`dump_unreached`). Small amounts ride along:
// the walk is made for >= 96 items or when <= 6 slots are free (opts.force: always). -> number of items thrown
async function dumpJunk (bot, items, opts = {}) {
  const names = Object.keys(items || {}).filter(n => items[n] > 0 && bot.registry.itemsByName[n] && count(bot, n) > 0); if (!names.length) return 0
  const total = names.reduce((n, k) => n + Math.min(items[k], count(bot, k)), 0)
  if (!opts.force && total < 96 && U.freeSlots(bot) > 6) return 0
  const D = settings().dump; const say = why => { if (Date.now() - (bot.__armyDumpSaidT || 0) > 600000) { bot.__armyDumpSaidT = Date.now(); result(bot, { ev: 'dump_unreached', why, carried: total }) } }
  if (!D || !Array.isArray(D.at) || !Array.isArray(D.aim)) { say('no settings.dump {at, aim} on the board'); return 0 }
  // the rim is a LINE, not a cell (05:48Z: five bots arrived together, one reported `cannot reach`): settings.dump.spread = [dx,dz] steps along the rim (default: along z),
  // every bot starts at its own offset (roster index) and takes the first of 4 rim cells it can stand on; the aim moves along with it
  const sp = Array.isArray(D.spread) ? D.spread : [0, 1]; const idx = Math.max(0, (settings().roster || []).indexOf(bot.username)); let at = null; let off = 0
  for (let k = 0; k < 4 && !at && !(opts.stop && opts.stop()); k++) {
    const o = [0, -1, 1, -2][(k + idx) % 4]; const c = new Vec3(D.at[0] + sp[0] * o, D.at[1], D.at[2] + sp[1] * o)
    const f = bot.blockAt(c.offset(0, -1, 0)); if (f && f.boundingBox !== 'block') continue // not a rim cell (the chunk may also be unloaded: then try it)
    if (bot.entity.position.distanceTo(c.offset(0.5, 0, 0.5)) <= 1.2 || await travel(bot, c, { range: 0, ms: 120000, stop: opts.stop, quiet: true })) { at = c; off = o }
  }
  if (!at) { if (!(opts.stop && opts.stop())) say('cannot reach the dump at ' + D.at.join(',')); return 0 }
  let n = 0
  try {
    await bot.lookAt(new Vec3(D.aim[0] + sp[0] * off + 0.5, D.aim[1] + 0.5, D.aim[2] + sp[1] * off + 0.5), true); await sleep(250)
    for (const k of names) { const q = Math.min(items[k], count(bot, k)); if (q <= 0) continue; try { await U.withTimeout(bot.toss(bot.registry.itemsByName[k].id, null, q), 8000, 'dumpToss'); n += q; result(bot, { ev: 'junk_tossed', item: k, n: q, at: [at.x, at.y, at.z] }) } catch (e_) { swallow('army:dumpToss', e_) } await sleep(150) }
  } catch (e_) { swallow('army:dumpJunk', e_) }
  return n
}
// deposit everything except `keep` ({name:count}, plus best tool of each kind + 1 shield) into the category chests.
// returns {name:count} actually moved. Logs a 'banked' result.
async function bank (bot, keep = {}, opts = {}) {
  const plan = {}
  await wear(bot) // what is still in the pockets afterwards is spare: it goes to the depot for the next bot
  const bestNames = new Set(['pickaxe', 'axe', 'sword', 'shovel', 'hoe'].map(k => bestOf(bot, k)).filter(Boolean).map(i => i.name))
  const seenBest = new Set()
  for (const i of bot.inventory.items()) {
    let k = keep[i.name] || 0
    if (bestNames.has(i.name) && !seenBest.has(i.name)) { seenBest.add(i.name); k = Math.max(k, 1) }
    const ar = armorOf(i.name)
    if ((ar && ar.rank > wornRank(bot, ar.piece)) || (i.name === 'shield' && !offHand(bot))) k = Math.max(k, 1) // better than what is worn = wear() could not run yet: keep it
    plan[i.name] = (plan[i.name] == null ? -k : plan[i.name]) + i.count
  }
  const byCat = {}
  for (const [name, n] of Object.entries(plan)) if (n > 0) (byCat[categoryOf(bot, name)] = byCat[categoryOf(bot, name)] || {})[name] = n
  // SEED GLUT, checked BEFORE the chest visit (foreman 09-20 00:55Z: 7539 seeds in the depot = 3400 % of target, every farm pass banked 64 more and
  // other bots then threw them away by hand): over 512 in stock a farmer's surplus seeds never enter a chest - they are dropped at once (5 min despawn).
  const junk = {} // what the glut rules take out of the banking plan: never dropped here - dumpJunk carries it to settings.dump after the chest visits
  if (byCat.food && byCat.food.wheat_seeds > 0 && stockOf('wheat_seeds') >= 512) { junk.wheat_seeds = byCat.food.wheat_seeds; delete byCat.food.wheat_seeds; if (!Object.keys(byCat.food).length) delete byCat.food }
  // STONE GLUT, same rule as the seeds (op 09-20 01:30Z: build chests FULL of cobbled_deepslate - 22069 stone against a target of 1728 - so planks could not
  // be banked): once the stock holds 3x the target (min 4096) junk stone never enters a chest, it is dropped before the visit.
  if (byCat.build) {
    const tgt = (settings().targets || {}).cobblestone || 0; const stone = stockOf('cobblestone') + stockOf('cobbled_deepslate')
    if (stone >= Math.max(3 * tgt, 4096)) for (const name of Object.keys(byCat.build)) {
      if (!/^(cobblestone|cobbled_deepslate|granite|diorite|andesite|tuff|deepslate|stone)$/.test(name)) continue
      junk[name] = byCat.build[name]; delete byCat.build[name]
    }
    // DIRT/GRAVEL/SAND GLUT (foreman 09-20 03:00Z: full-pocket bots circle the depot, "[circling] 22 chest visits, nothing deposited", 5600 dirt carried
    // army-wide after the pads were levelled): over 1024 of it in stock, what a bot does not KEEP for its job is dropped, never queued at a full chest.
    if (byCat.build) for (const name of ['dirt', 'gravel', 'sand', 'coarse_dirt']) {
      if (!(byCat.build[name] > 0) || stockOf(name) < 1024) continue
      junk[name] = byCat.build[name]; delete byCat.build[name]
    }
    if (byCat.build && !Object.keys(byCat.build).length) delete byCat.build
  }
  const moved = {}
  const unreach = {}
  for (const cat of CATS) {
    const want = byCat[cat]
    if (!want) continue
    const idx0 = index()
    const knownFull = cp => { const e = idx0[cp.x + ',' + cp.y + ',' + cp.z]; return !!e && e.used >= (e.size || 27) && Date.now() - e.t < 900000 }
    // a big warehouse has dozens of containers per category: go straight to the first one not known to be full (nearest first among those)
    // order: containers KNOWN to have room (emptiest first) -> never opened -> known full. With 30-50 containers per category the six
    // opens of one bank visit must not be wasted on the old full depot chests at the head of the list (false CHEST FULL alarms, 09-19).
    const freeOf = cp => { const e = idx0[cp.x + ',' + cp.y + ',' + cp.z]; return e ? (e.size || 27) - e.used : null }
    const me0 = bot.entity.position
    const withRoom = chestsOf(cat).filter(cp => freeOf(cp) != null && freeOf(cp) > 2).sort((a, b) => a.distanceTo(me0) - b.distanceTo(me0)) // NEAREST container with room
    const unknown = chestsOf(cat).filter(cp => freeOf(cp) == null).sort((a, b) => a.distanceTo(me0) - b.distanceTo(me0))
    const order0 = withRoom.concat(unknown, chestsOf(cat).filter(cp => freeOf(cp) != null && freeOf(cp) <= 2)).filter(cp => !(opts.avoid && opts.avoid.includes(cp.x + ',' + cp.y + ',' + cp.z))) // avoid: the chest a builder is emptying to re-make it (09-20 depot repair)
    const nearO = order0.filter(cp => cp.distanceTo(me0) <= 64); const order = nearO.length ? nearO : order0 // never cross the map to bank while this place has containers of the category (camps)
    let opened = 0
    for (const cp of order) {
      if (!Object.keys(want).length || U.cancelled(bot) || (opts.stop && opts.stop()) || opened >= 8) break
      opened++
      const w = await openChest(bot, cp, opts)
      if (!w) { unreach[cat] = (unreach[cat] || 0) + 1; continue }
      try {
        for (const name of Object.keys(want)) {
          const item = bot.registry.itemsByName[name]
          const have = inHand(w, name)
          const n = Math.min(want[name], have)
          if (!item || n <= 0) { delete want[name]; continue }
          const was = inChest(w, name)
          try { await U.withTimeout(w.deposit(item.id, null, n), 8000, 'deposit') } catch (e_) { if (!/destination full/i.test(String(e_ && e_.message))) swallow('army:528', e_) } // 'destination full' = a PARTIAL deposit into a nearly full container: expected, the rest goes to the next one
          await sleep(150)
          const done = Math.max(inChest(w, name) - was, have - inHand(w, name), 0)
          if (done > 0) { moved[name] = (moved[name] || 0) + done; want[name] -= done }
          if (want[name] <= 0) delete want[name]; else break // chest full -> next chest of this category
        }
        record(bot, cp, w)
      } finally { closeWin(w); await sleep(150) }
    }
  }
  // worthless clutter never goes into a chest (TOOLS was 3x full of wooden tools and snowballs): a player throws it away
  for (const i of bot.inventory.items()) {
    if (!/^wooden_(sword|axe|pickaxe|shovel|hoe)$|^(snowball|pointed_dripstone|poisonous_potato|spider_eye)$/.test(i.name)) continue
    if (/^wooden_/.test(i.name) && !bot.inventory.items().some(j => new RegExp('^(stone|copper|iron|diamond|netherite)_' + i.name.split('_')[1] + '$').test(j.name)) && stockOf('stone_' + i.name.split('_')[1]) === 0) continue // it is all we have
    junk[i.name] = (junk[i.name] || 0) + i.count; for (const c of Object.values(byCat)) delete c[i.name]
  }
  // SEED GLUT (foreman 09-19: 1332 wheat_seeds in the depot + 4833 banked in an hour filled the FOOD containers): wheat gives more seeds than the
  // field can take. Once the stock holds 512, surplus seeds are thrown away like any junk (they despawn in 5 min) instead of being banked.
  if (byCat.food && byCat.food.wheat_seeds > 0 && stockOf('wheat_seeds') >= 512) { junk.wheat_seeds = (junk.wheat_seeds || 0) + byCat.food.wheat_seeds; delete byCat.food.wheat_seeds }
  // BUILD full of stone? a player throws surplus cobble away. Keep 64, toss the rest of the junk stone (despawns in 5 min) — a bot with a
  // full inventory of cobblestone can do nothing else, and 24k cobble are already banked.
  if (byCat.build) for (const name of Object.keys(byCat.build)) {
    if (!/^(cobblestone|cobbled_deepslate|granite|diorite|andesite|tuff|gravel|dirt|deepslate|stone|netherrack|calcite)$/.test(name)) continue
    const tgt = (settings().targets || {})[name]; if (tgt && stockOf(name) < tgt) continue // under its stock target it is CARGO, not junk (world 2, 09-19: cobblestone 1/1728 and the bank tossed everything over 64)
    const extra = count(bot, name) - 64
    if (extra > 0) { junk[name] = Math.max(junk[name] || 0, extra); delete byCat.build[name] }
  }
  if (Object.keys(junk).length && !(opts.stop && opts.stop())) await dumpJunk(bot, junk, { stop: opts.stop })
  // a category whose chests are all full used to swallow the rest silently — say so (the operator adds a chest: armyctl.js chest add)
  for (const cat of CATS) {
    const left = byCat[cat] && Object.keys(byCat[cat]).length
    if (!left || !chestsOf(cat).length || Date.now() - (_fullT[cat] || 0) < 600000) continue
    // an INTERRUPTED bank visit (job switch, cancel) leaves items in the pockets too - that is neither "full" nor "unreachable" (09-20 00:03Z:
    // bank_unreachable x93 by 38 bots, most with failedOpens 0 and 330 free slots: the dispatcher had re-assigned them mid-visit)
    if (U.cancelled(bot) || (opts.stop && opts.stop())) continue
    _fullT[cat] = Date.now()
    // say what REALLY happened: containers that could not be reached/opened are an ACCESS problem, not a capacity problem (09-19: 900+ free
    // slots while operators kept reporting "chest full")
    const idxN = index(); const free = chestsOf(cat).reduce((n, cp) => { const e = idxN[cp.x + ',' + cp.y + ',' + cp.z]; return n + (e ? Math.max(0, (e.size || 27) - e.used) : 27) }, 0)
    if (unreach[cat] || free > 30) result(bot, { ev: 'bank_unreachable', cat, failedOpens: unreach[cat] || 0, freeSlotsInCategory: free, from: [Math.round(bot.entity.position.x), Math.round(bot.entity.position.y), Math.round(bot.entity.position.z)] })
    else result(bot, { ev: 'chest_full', cat, left: Object.keys(byCat[cat]).slice(0, 6) })
  }
  if (Object.keys(moved).length) result(bot, { ev: 'banked', job: opts.job || null, items: moved })
  if (!opts.noKit) await kitUp(bot, { stop: opts.stop, risk: opts.risk, why: 'bank' }) // at the depot anyway: take what is an upgrade (fair share: see kitUp)
  return moved
}

// ---- placeHard: PLACE A BLOCK AND DON'T GIVE UP EASILY (owner: "do you just give up when a block cannot be placed?").
// blocks.placeBlock reports WHY it failed; every reason has a remedy a player would use:
//   noitem      -> fetch it from the depot (chest index); craftable basics (planks<-logs, sticks, torches, chest) are crafted
//   noref       -> nothing to build against: build the support first — a filler column from the first solid block below (max 6), else sideways
//   unreachable / no_los -> walk to the other sides of the target and try from there; still not? pillar up 1-2 on a scaffold (removed after)
//   entity      -> somebody stands in the cell: wait for them (5 x 2 s)
//   occupied    -> the wrong block is there: dig it, then place
//   rejected / locked / look / send -> short wait, retry
// Returns blocks.js result + {remedies:[…]}. Only after the remedies are exhausted does it fail — with the full story in `reason`.
// obtain(bot, name, n): have n of `name` (a concrete item or a craft.js GENERIC: planks, bed, boat, fence_gate …) in the pockets — depot first,
// else CRAFT it. What to craft from is decided by craft.js `solve` over pockets + depot index (any wood, any tool stone, coal or charcoal; the
// chain goes as deep as needed: bamboo -> block -> planks -> slab -> barrel). Only what the plan consumes is fetched. true = at least one in hand.
// ONE CRAFTING TABLE for everybody (`settings.craftTable`), never a new table where you stand (world 1's census: 62 littered tables, 7 of them
// INSIDE the farm's water holes). Bootstrap of a new world: no table registered yet -> the one placed here becomes settings.craftTable (first wins).
async function craftSpot (bot, opts = {}) {
  const tId = bot.registry.blocksByName.crafting_table.id
  const dt = settings().craftTable
  if (dt) {
    if (!bot.findBlock({ matching: tId, maxDistance: 10 })) await travel(bot, new Vec3(dt[0], dt[1], dt[2]), { range: 3, ms: 240000, stop: opts.stop })
    if (bot.findBlock({ matching: tId, maxDistance: 10 })) return C.table(bot)
    // "GONE" IS A FACT ABOUT THE WORLD, NOT ABOUT MY TRIP (09-20 04:00Z + 05:39Z: `craft_table_set [-307,57,-436] "the registered table was gone"` - a bot whose walk
    // to the table was interrupted looked around WHERE IT STOOD, found a lost table on the floor of the RAVINE and registered it for the whole army: every craft
    // then failed `crafted 0/1` / `ingredients did not arrive` at a place nobody may walk to). Only a bot that stands within 6 blocks of the registered cell and sees
    // no table there may say so; and a table below the base level or inside a keep-out is never adopted.
    { const at = new Vec3(dt[0], dt[1], dt[2]); const b0 = bot.blockAt(at); if (bot.entity.position.distanceTo(at) > 6 || !b0 || b0.name === 'crafting_table') return null }
    // THE REGISTERED TABLE IS GONE (dug up by groundskeepers until 09-20 02:03Z, a creeper, a rebuild): do not fail every craft of the army for it -
    // any table within 48 blocks (the hall has one) becomes the registered one; with none in sight, fall through and place a new one here at the muster.
    const KOB = (settings().keepOut || []).map(k => k && k.box).filter(q => Array.isArray(q) && q.length === 4); const by = (settings().base || {}).y
    const other = bot.findBlock({ matching: tId, maxDistance: 48, useExtraInfo: b => !(by != null && b.position.y < by - 2) && !KOB.some(q => b.position.x >= Math.min(q[0], q[2]) && b.position.x <= Math.max(q[0], q[2]) && b.position.z >= Math.min(q[1], q[3]) && b.position.z <= Math.max(q[1], q[3])) })
    if (other) { boardEdit(b => { b.settings = b.settings || {}; b.settings.craftTable = [other.position.x, other.position.y, other.position.z] }); _settings.t = 0; result(bot, { ev: 'craft_table_set', at: [other.position.x, other.position.y, other.position.z], why: 'the registered table was gone' }); await travel(bot, other.position, { range: 3, ms: 120000, stop: opts.stop }); return C.table(bot) }
    boardEdit(b => { if (b.settings) delete b.settings.craftTable }); _settings.t = 0
  }
  // THE first table becomes settings.craftTable for ever: it belongs at the muster yard of the base, not where a lumberjack happens to stand
  // (world 2, 09-19: first tries were in a forest 250 blocks out and IN the river - freeSpotNear finds no spot in water).
  const m = musterPos()
  if (m && !bot.findBlock({ matching: tId, maxDistance: 12 }) && Math.hypot(bot.entity.position.x - m.x, bot.entity.position.z - m.z) > 12) await travel(bot, new Vec3(m.x, m.y, m.z), { range: 4, ms: 300000, stop: opts.stop })
  const tbl = await C.table(bot)
  if (tbl) {
    const q = tbl.position; let won = false
    boardEdit(b => { b.settings = b.settings || {}; if (!b.settings.craftTable) { b.settings.craftTable = [q.x, q.y, q.z]; won = true } }); _settings.t = 0
    if (won) { bot.__placedTable = null; result(bot, { ev: 'craft_table_set', at: [q.x, q.y, q.z] }) } // registered = permanent: no releaseTable picks it up again
  }
  return tbl
}
async function obtain (bot, name, n, opts = {}) {
  const reg = bot.registry
  const both = () => { const m = stockMap(); for (const [k, v] of Object.entries(inv(bot))) m[k] = (m[k] || 0) + v; return m }
  const item = C.resolve(reg, name, both())
  if (!reg.itemsByName[item]) return false
  if (count(bot, item) >= n) return true
  await withdraw(bot, item, Math.max(n, /torch|planks|cobblestone|dirt/.test(item) ? 32 : n) - count(bot, item), opts)
  if (count(bot, item) >= n) return true
  const fail = why => { result(bot, { ev: 'obtain_failed', item, n, why: String(why).slice(0, 120) }); return count(bot, item) > 0 }
  const all = both(); const plan = C.solve(reg, item, n, all)
  if (!plan.ok) return C.plans(reg, item).length ? fail('missing ' + JSON.stringify(plan.missing)) : count(bot, item) > 0 // not craftable (cobblestone, dirt): the depot was the only source
  for (const [k, had] of Object.entries(all)) { // fetch exactly what the chain consumes and the pockets lack
    const short = had - (plan.left[k] || 0) - count(bot, k)
    if (short > 0 && !U.cancelled(bot) && !(opts.stop && opts.stop())) await withdraw(bot, k, short, opts)
  }
  let mine = C.solve(reg, item, n, inv(bot)) // re-plan on what really arrived: the pockets are the truth
  // THE NEXT-BEST CHAIN BEFORE THE FAILURE (foreman 09-20 05:40Z: `obtain_failed stick ... ingredients did not arrive: {"#planks":4}` from 5 miners, then iron_pickaxe,
  // with 2677 LOGS in the depot: the plan was solved on a stock map that still showed ~170 planks, the builders had drained them, the withdraw came back short and
  // the re-plan on the pockets gave up). ONE retry: what came back short counts as NOT IN THE DEPOT (pockets only), the chain is solved again on the current stock
  // (logs -> planks -> sticks), its ingredients are fetched, the pockets decide. Then the honest failure.
  if (!mine.ok && !U.cancelled(bot) && !(opts.stop && opts.stop())) {
    const short = Object.keys(mine.missing || {}); const pockets = inv(bot); const all2 = both()
    const isShort = k => short.some(m => m === k || (m[0] === '#' && (m === '#planks' ? /_planks$/.test(k) : /^#logs?$/.test(m) ? /_(log|stem)$/.test(k) : (k === m.slice(1) || k.endsWith('_' + m.slice(1))))))
    for (const k of Object.keys(all2)) if (isShort(k)) all2[k] = pockets[k] || 0
    const plan2 = C.solve(reg, item, n, all2)
    if (plan2.ok) {
      for (const [k, had] of Object.entries(all2)) { const need = had - (plan2.left[k] || 0) - count(bot, k); if (need > 0 && !U.cancelled(bot) && !(opts.stop && opts.stop())) await withdraw(bot, k, need, opts) }
      mine = C.solve(reg, item, n, inv(bot))
      result(bot, { ev: 'obtain_retry', item, n, short, ok: !!mine.ok })
    }
  }
  if (!mine.ok) return fail('ingredients did not arrive: ' + JSON.stringify(mine.missing))
  try {
    const dt = settings().craftTable
    const tbl = await craftSpot(bot, opts)
    if (!tbl) return fail(dt ? 'no crafting table within reach of settings.craftTable ' + dt.join(',') : 'no settings.craftTable and no table could be placed here')
    for (const st of mine.steps) { if (U.cancelled(bot) || (opts.stop && opts.stop())) break; if (!await C.craft(bot, st.item, st.runs, tbl)) break }
    if (!dt && bot.__placedTable) await C.releaseTable(bot) // another bot's table was registered first: take mine back
  } catch (e_) { swallow('army:obtain', e_) }
  await sleep(400)
  return count(bot, item) >= n || fail('crafted ' + count(bot, item) + '/' + n)
}
// FILL A CELL FROM INSIDE IT: stand in the cell (solid floor, air for body, head and the jump), jump, place the block under the feet, ride up with it. For a FILL this is what a
// player does in a shaft whose floor no rim shows; the block is the work (ledger:false), never scaffold. Only plain full blocks, never inside a pen. -> true when the block stands.
const INSIDE_FILL_RE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|gravel|sand|red_sand|netherrack|[a-z_]+_planks|stone_bricks)$/
async function fillInside (bot, p, item, opts = {}) {
  const BL = require('./blocks')
  try {
    const head = bot.blockAt(p.offset(0, 2, 0))
    if (!INSIDE_FILL_RE.test(item) || !count(bot, item) || !BL.standable(bot, p) || !head || head.boundingBox === 'block' || penAt(p.x, p.y, p.z)) return false
    const at = () => { const q = bot.entity.position.floored(); return q.x === p.x && q.z === p.z && q.y === p.y }
    if (!at() && !await travel(bot, { x: p.x, y: p.y, z: p.z }, { range: 0, ms: 15000, stop: opts.stop, quiet: true })) return false
    if (!at()) return false
    await BL.centreOn(bot, p)
    const up = await U.withTimeout(BL.pillarUp(bot, 1, { item, ledger: false }), 8000, 'fillInside').catch(e_ => { swallow('army:fillInside', e_); return 0 })
    const nb = bot.blockAt(p)
    return !!(up && nb && nb.boundingBox === 'block')
  } catch (e_) { swallow('army:fillInside2', e_); return false }
}
// A GRAVITY BLOCK DOWN THE SHAFT: the floor cell p of a narrow hole deeper than the arm is long (probe 09-20 07:40Z: slots 1x2, 4-7 deep at -322,-508 / -316,-503 - no rim
// shows the floor, the drop is more than the pathfinder walks) is filled by placing gravel/sand against a SIDE wall of the same column higher up, from the rim, never from
// inside the column; it falls onto the floor. Only what the bot carries. topY = the highest cell of the column that may be used. -> the item name, or null.
const GRAVITY_FILL = ['gravel', 'sand', 'red_sand']
async function gravityDrop (bot, p, topY) {
  const BL = require('./blocks'); const solid = b => !!b && b.boundingBox === 'block'; const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  try {
    const g = GRAVITY_FILL.find(n => count(bot, n)); if (!g || solid(at(p.x, p.y, p.z)) || !solid(at(p.x, p.y - 1, p.z))) return null
    let topAir = p.y; while (topAir < topY && !solid(at(p.x, topAir + 1, p.z)) && !/^(water|lava)$/.test((at(p.x, topAir + 1, p.z) || {}).name)) topAir++
    const fy = Math.floor(bot.entity.position.y); const ys = []; for (let y = topAir; y > p.y; y--) ys.push(y)
    ys.sort((a, b) => Math.abs(a - fy) - Math.abs(b - fy))
    for (const y of ys.slice(0, 4)) {
      const rr = await BL.placeBlock(bot, new Vec3(p.x, y, p.z), g, { retries: 0, moveMs: 8000, faces: [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)], avoidStand: q => q.x === p.x && q.z === p.z }).catch(e => ({ ok: false, reason: String(e && e.message) }))
      if (!rr.ok) continue
      await sleep(400 + 150 * (y - p.y)) // it falls
      return solid(at(p.x, p.y, p.z)) ? g : null
    }
  } catch (e_) { swallow('army:gravityDrop', e_) }
  return null
}
async function placeHard (bot, pos, item, opts = {}) {
  const BL = require('./blocks'); const p = pos.clone ? pos.clone() : new Vec3(pos.x, pos.y, pos.z)
  const remedies = []; let r = null; const home = bot.entity.position.clone(); const sideSupports = []; let geo = 0; const triedStands = new Set()
  for (let round = 0; round < 7 && !U.cancelled(bot) && !(opts.stop && opts.stop()); round++) {
    r = await BL.placeBlock(bot, p, item, Object.assign({ retries: 1, triedStands }, opts.place || {})).catch(e => ({ ok: false, reason: e && e.cancelled ? 'cancelled' : String(e && e.message) }))
    if (r.ok || r.reason === 'cancelled') break
    const why = String(r.reason || '')
    if (why === 'noitem') { remedies.push('fetch ' + item); const back = bot.entity.position.clone(); if (!await obtain(bot, item, opts.want || 1, opts)) { r.reason = 'noitem: none of ' + item + ' carried, in the depot index, or craftable'; break } await travel(bot, back, { range: 3, ms: 90000, stop: opts.stop, quiet: true }); continue }
    if (why === 'noref') {
      remedies.push('support')
      let base = null; for (let d = 1; d <= 6; d++) { const b = bot.blockAt(p.offset(0, -d, 0)); if (b && b.boundingBox === 'block') { base = d; break } }
      const fill = FILLERS.find(f => count(bot, f) > (f === item ? 1 : 0)) || (await obtain(bot, 'cobblestone', 8, opts) ? 'cobblestone' : null)
      if (!fill) { r.reason = 'noref and no filler block to build a support'; break }
      if (base) { let ok = true; for (let d = base - 1; d >= 1 && ok; d--) { const q = await BL.placeBlock(bot, p.offset(0, -d, 0), fill, { retries: 1 }).catch(() => ({ ok: false })); ok = q.ok; if (ok && opts.scaffoldSupport) debt(bot, { kind: 'support', at: [p.x, p.y - d, p.z] }) } if (ok) continue }
      let side = false; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = bot.blockAt(p.offset(dx, -1, dz)); if (n && n.boundingBox === 'block') { const q = await BL.placeBlock(bot, p.offset(dx, 0, dz), fill, { retries: 1 }).catch(() => ({ ok: false })); if (q.ok) { side = true; sideSupports.push({ at: p.offset(dx, 0, dz), name: fill }); break } } }
      if (side) continue
      r.reason = 'noref: no solid block within 6 below or beside ' + [p.x, p.y, p.z]; break
    }
    if (why === 'unreachable' || why === 'no_los') {
      // A GEOMETRY PROBLEM IS SOLVED BY MOVING, NOT BY A TICKET (foreman 09-20 07:20Z: `place_failed no_los` x136/30 min, one builder x24 on ONE cell, six blind
      // `reposition` walks each). placeBlock now walks only to stands FROM which a reference face is seen (rim first, squared on the stand) and never twice to the same
      // ones (`triedStands`). What it cannot do from outside is a column that must be filled FROM INSIDE: the cell can be stood in (solid floor, 3 cells of air) ->
      // step in, jump, place under the feet (blocks.pillarUp, ledger:false = the block is the work, no scaffold) and ride up with the fill. A player fills a shaft
      // exactly so; it is filling, not travel. Deeper than the pathfinder drops: a carried gravity block goes down the shaft (gravityDrop). Both only for FILL work
      // (opts.fill; opts.fillTop = the column's top cell). Two geometry rounds at most, then the caller takes another cell.
      geo++
      if (opts.fill && !opts.noInside && await fillInside(bot, p, item, opts)) { remedies.push('inside'); const nb = bot.blockAt(p); r = { ok: true, inside: true, block: nb && nb.name, remedies }; break }
      if (opts.fill && opts.fillTop != null && opts.fillTop > p.y) { const g = await gravityDrop(bot, p, opts.fillTop); if (g) { remedies.push('gravity'); r = { ok: true, dropped: g, block: g, remedies }; break } }
      const high = p.y - bot.entity.position.y > 2.5 // a wall top / roof cell: the third round may pillar up on a scaffold (removed after)
      if (geo >= (high ? 3 : 2)) break
      remedies.push('reposition')
      const spots = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]].map(([dx, dz]) => p.offset(dx, 0, dz)).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      let moved = false; for (const s2 of spots.slice(round % 2, (round % 2) + 3)) { if (await travel(bot, { x: s2.x, y: null, z: s2.z }, { range: 1, ms: 15000, stop: opts.stop, quiet: true })) { moved = true; break } }
      if (high && geo >= 2 && p.y - bot.entity.position.y > 2.5) { remedies.push('scaffold'); await BL.pillarUp(bot, Math.min(3, Math.ceil(p.y - bot.entity.position.y - 2)), {}).catch(() => 0); r = await BL.placeBlock(bot, p, item, { retries: 1 }).catch(() => ({ ok: false, reason: 'unreachable' })); await BL.removeScaffold(bot).catch(e_ => swallow('army:609', e_)); if (r.ok) break }
      continue
    }
    if (why === 'entity') { remedies.push('wait for entity'); await sleep(2000); continue }
    // a TORCH in the way is furniture we put there ourselves (the pitch-8 light grid ran before the pads: op 09-19 22:42Z, base_pen_2_pad, 25 builders,
    // `occupied by torch and cannot dig it (protected)` x250): take it, place the block - the build job/light grid puts a torch back on top.
    if (why.startsWith('occupied')) { remedies.push('clear'); const occ = bot.blockAt(p); const d = await BL.digBlock(bot, p, { collect: true, requireHarvest: false, allowProtected: !!(occ && /torch$/.test(occ.name)) }).catch(() => ({ ok: false })); if (!d.ok) { r.reason = 'occupied by ' + (r.block || '?') + ' and cannot dig it (' + d.reason + ')'; break } continue }
    // LOCKED = another bot is working this very cell right now: that is CONTENTION, not a failure (op 09-19 22:32Z: 12 builders hammered one dirt
    // cell, `place_failed locked` x11-49 each, every one a help-desk ticket). No retry, no remedy, no ticket - the caller moves to another cell.
    if (why === 'locked') { remedies.length = 0; break }
    remedies.push('retry:' + why); await sleep(600)
  }
  // A SIDE SUPPORT IS A HELP, NOT A BUILDING (09-20: `debt kind:'support'` was written and nobody ever came): once the block it carried stands (a full block holds
  // itself) or the place failed for good, the routine that placed it takes it away again; only a torch-like item that may HANG on it keeps it (logged as debt).
  for (const q of sideSupports) {
    const hangs = r && r.ok && /torch|button|lever|_sign$|ladder|banner/.test(item)
    if (hangs) { debt(bot, { kind: 'support', at: [q.at.x, q.at.y, q.at.z], note: 'side support kept: ' + item + ' may hang on it' }); continue }
    const b = bot.blockAt(q.at); if (b && b.name === q.name && !ourBlock(q.at, b.name)) await BL.digBlock(bot, q.at, { collect: true, requireHarvest: false, plug: false }).catch(e_ => swallow('army:supportCleanup', e_))
  }
  if (r) r.remedies = remedies
  // no_los / unreachable = geometry, like `locked` = contention: NO help-desk ticket (an LLM cannot see the faces either), and the event is said once per bot + cell in 10 min
  const geoFail = !!r && !r.ok && /^(no_los|unreachable)$|\((no_los|unreachable)\)$/.test(String(r.reason)) // also `occupied by X and cannot dig it (unreachable)`
  if (r && !r.ok && remedies.length && r.reason !== 'cancelled' && !geoFail) askHelp(bot, 'place_failed', item + ' at ' + [p.x, p.y, p.z].join(',') + ': ' + r.reason, { tried: remedies.slice(0, 6) })
  if (r && !r.ok && remedies.length) { const said = bot.__armyPlaceSaid = bot.__armyPlaceSaid || {}; const k = p.x + ',' + p.y + ',' + p.z; const now = Date.now(); for (const q of Object.keys(said)) if (now - said[q] > 600000) delete said[q]; if (!geoFail || !said[k]) { said[k] = now; result(bot, { ev: 'place_failed', at: [p.x, p.y, p.z], item, why: String(r.reason).slice(0, 90), tried: remedies.slice(0, 6) }) } }
  void home
  return r || { ok: false, reason: 'cancelled' }
}

// ---- HELP DESK: when the algorithms are out of ideas, ask an LLM (owner, 09-19: "algorithms have limits — let an LLM answer failures").
// A bot files a TICKET (what failed, what was tried, what it carries, an ASCII look around it). ops/helpdesk.js answers with a short plan of
// verbs for THIS bot (or skip / decline / escalate); the worker runs the answer at its next slice start. Same failure signature = the cached
// remedy is reused without a new LLM call, so the army LEARNS. Limits: 1 open ticket per bot, 1 per bot per 10 min, 24 per hour army-wide.
function askHelp (bot, kind, why, extra = {}) {
  try {
    const dir = path.join(DIR, 'tickets'); fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    if (now - (bot.__armyHelpT || 0) < 600000) return false
    const recent = fs.readdirSync(dir).filter(f => now - fs.statSync(path.join(dir, f)).mtimeMs < 3600000)
    if (recent.length >= 24 || recent.some(f => f.startsWith(bot.username + '.'))) return false
    bot.__armyHelpT = now
    let lookRows = null; try { const L = require('./look').look(bot, 7); lookRows = { mode: L.mode, top_left: L.top_left, rows: L.rows, things: L.things, entities: L.entities } } catch (e_) { swallow('army:askHelpLook', e_) }
    const p = bot.entity.position.floored()
    const t = { id: bot.username + '.' + now, t: now, bot: bot.username, job: bot.__armyJob, kind, why: String(why).slice(0, 200), sig: kind + '|' + String(why).replace(/-?\d+/g, 'N').slice(0, 80), pos: [p.x, p.y, p.z], hp: Math.round(bot.health), food: bot.food, inv: inv(bot), extra, look: lookRows }
    writeJSON(path.join(dir, t.id + '.json'), t)
    result(bot, { ev: 'help_asked', kind, why: t.why.slice(0, 80) })
    return true
  } catch (e_) { swallow('army:askHelp', e_); return false }
}
function helpAnswer (bot) { // -> answer object or null (consumed)
  const f = path.join(DIR, 'answers', bot.username + '.json'); const a = readJSON(f, null)
  if (!a) return null
  try { fs.unlinkSync(f) } catch (e_) { swallow('army:helpAnswer', e_) }
  return Date.now() - (a.t || 0) < 900000 ? a : null
}

// ---- SITE CHESTS ("work where you stand"): a chest AT a work site that is NOT part of the base index. Workers stash output there
// and go straight back to work; a hauler brings it home in bulk when the counter in bots/army/sites.json says it is worth the walk.
const SITES_F = path.join(DIR, 'sites.json')
function siteKey (pos) { return pos.x + ',' + pos.y + ',' + pos.z }
function siteInfo (pos) { return (readJSON(SITES_F, {}) || {})[siteKey(pos)] || { n: 0, t: 0 } }
function siteSet (pos, n) { const d = readJSON(SITES_F, {}) || {}; d[siteKey(pos)] = { n: Math.max(0, n), t: Date.now() }; writeJSON(SITES_F, d) }
// put everything except `keep` {name:n} into the chest at pos. returns {name:count} moved (judged on the window).
async function stash (bot, pos, keep = {}, opts = {}) {
  const w = await openChest(bot, pos, opts)
  if (!w) return null
  const moved = {}
  try {
    const names = [...new Set(w.items().map(i => i.name))]
    for (const name of names) {
      const n = inHand(w, name) - (keep[name] || 0)
      const item = bot.registry.itemsByName[name]
      if (!item || n <= 0 || /_(pickaxe|axe|sword|shovel|hoe)$|^(shield|fishing_rod|torch|bucket|water_bucket)$/.test(name)) continue
      const was = inChest(w, name)
      try { await U.withTimeout(w.deposit(item.id, null, n), 8000, 'stash') } catch (e_) { swallow('army:640', e_) }
      await sleep(150)
      const done = Math.max(0, inChest(w, name) - was)
      if (done) moved[name] = done; else break // full
    }
    siteSet(pos, w.containerItems().reduce((a, i) => a + i.count, 0))
  } finally { closeWin(w); await sleep(150) }
  return moved
}
// take everything out of the chest at pos (as far as the inventory allows). returns {name:count}.
async function unstash (bot, pos, opts = {}) {
  const w = await openChest(bot, pos, opts)
  if (!w) return null
  const got = {}
  try {
    for (const it of w.containerItems().slice()) {
      if (w.firstEmptySlotRange(w.inventoryStart, w.inventoryEnd) == null) break
      const was = inChest(w, it.name)
      try { await U.withTimeout(w.withdraw(it.type, null, it.count), 8000, 'unstash') } catch (e_) { swallow('army:658', e_) }
      await sleep(120)
      const done = Math.max(0, was - inChest(w, it.name))
      if (done) got[it.name] = (got[it.name] || 0) + done
    }
    siteSet(pos, w.containerItems().reduce((a, i) => a + i.count, 0))
  } finally { closeWin(w); await sleep(150) }
  return got
}

// withdraw up to n of `name` using the index (goes straight to a chest known to hold it). returns amount taken.
async function withdraw (bot, name, n, opts = {}) {
  const item = bot.registry.itemsByName[name]
  if (!item) return 0
  const d = index()
  const cands = Object.entries(d).filter(([, v]) => v.items && v.items[name] > 0 && Date.now() - v.t < 30 * 60000)
    .sort((a, b) => b[1].items[name] - a[1].items[name])
    .map(([k]) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z) })
  // NEAR FIRST (camps 150-400 blocks out are in the same index): containers within 64 blocks (fullest first); only when none of them holds the
  // item, the others - nearest first
  const me0 = bot.entity.position; const nearC = cands.filter(cp => cp.distanceTo(me0) <= 64)
  const pickC = (nearC.length ? nearC : cands.slice().sort((a, b) => a.distanceTo(me0) - b.distanceTo(me0))).filter(cp => opts.maxDist == null || cp.distanceTo(me0) <= opts.maxDist)
  let got = 0
  for (const cp of pickC.slice(0, 6)) {
    if (got >= n) break
    const w = await openChest(bot, cp, opts)
    if (!w) continue
    try {
      const avail = inChest(w, name)
      if (avail > 0) {
        try { await U.withTimeout(w.withdraw(item.id, null, Math.min(avail, n - got)), 8000, 'withdraw') } catch (e_) { swallow('army:683', e_) }
        await sleep(150)
        got += Math.max(0, avail - inChest(w, name))
      }
      record(bot, cp, w)
    } finally { closeWin(w); await sleep(150) }
  }
  return got
}
// scan every registered chest once (quartermaster job) so the index is complete
async function scanChests (bot, opts = {}) {
  let n = 0
  for (const cat of CATS) {
    for (const cp of chestsOf(cat)) {
      if (U.cancelled(bot) || (opts.stop && opts.stop())) return n
      const e0 = index()[cp.x + ',' + cp.y + ',' + cp.z]
      if (cp.distanceTo(bot.entity.position) > 64) continue // another camp's containers: its own bots keep them fresh by using them
      if (e0 && Date.now() - e0.t < 600000) continue // fresh enough (everybody who opens a container updates the index)
      const w = await openChest(bot, cp, opts)
      if (!w) continue
      try { record(bot, cp, w); n++ } finally { closeWin(w); await sleep(150) }
    }
  }
  return n
}
function stockOf (name) { let n = 0; for (const v of Object.values(index())) n += (v.items && v.items[name]) || 0; return n }
function stockMap () { const m = {}; for (const v of Object.values(index())) for (const [k, n] of Object.entries(v.items || {})) m[k] = (m[k] || 0) + n; return m } // the depot as {item:count} (index only: nobody walks)

// ------------------------------------------------------------------ furnaces (`settings.furnaces:[[x,y,z]…]`, registered by whoever PLACES one: the build job)
function furnaces () { return (settings().furnaces || []).map(c => new Vec3(c[0], c[1], c[2])) }
function registerFurnaces (list) { // [[x,y,z]|{x,y,z}…] -> how many were new
  let added = 0
  boardEdit(b => { b.settings = b.settings || {}; const f = b.settings.furnaces = b.settings.furnaces || []; for (const c of list) { const q = Array.isArray(c) ? c : [c.x, c.y, c.z]; if (!f.some(o => o[0] === q[0] && o[1] === q[1] && o[2] === q[2])) { f.push(q); added++ } } })
  _settings.t = 0
  return added
}
// walk to a block and open it: furnaces need openFurnace (bot.openContainer REJECTS them: "containerToOpen is neither a block nor an entity")
async function openAt (bot, pos, names, ms = 12000, opts = {}) {
  if (!await walkTo(bot, pos, { stop: opts.stop })) return null
  const b = bot.blockAt(pos)
  if (!b || !names.includes(b.name)) return null
  try {
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch (e_) { swallow('army:openAtClose', e_) } await sleep(200) }
    return await U.withTimeout(/^(furnace|blast_furnace|smoker)$/.test(b.name) ? bot.openFurnace(b) : bot.openContainer(b), ms, 'openAt')
  } catch (e) { swallow('army:openAt', e); return null }
}
// fuel from the pockets for `items` smelts: coal/charcoal 8 each, coal block 80, ANY planks or log 1.5, sticks 0.5 (last resort: better than banking raw food)
function pickFuel (bot, items) {
  const per = n => /^(coal|charcoal)$/.test(n) ? 8 : n === 'coal_block' ? 80 : (U.PLANK_RE.test(n) || U.LOG_RE.test(n)) ? 1.5 : n === 'stick' ? 0.5 : 0
  const best = bot.inventory.items().filter(i => per(i.name) > 0 && (i.name !== 'stick' || i.count >= 2)).sort((a, b) => per(b.name) - per(a.name) || b.count - a.count)[0]
  return best ? { name: best.name, count: Math.min(count(bot, best.name), Math.max(1, Math.ceil(items / per(best.name)))), per: per(best.name) } : null
}
// Smelt `n` of inputName (carried) in a registered furnace (or the one at furnacePos). Returns the number of items the bot really took out.
async function smelt (bot, inputName, n, furnacePos) {
  const input = bot.registry.itemsByName[inputName]
  if (!input) return 0
  n = Math.min(n, count(bot, inputName), 32)
  if (n <= 0) return 0
  // a FREE furnace, nearest first (world 1: the nearest one was busy cooking for the quartermaster -> putInput failed -> "smelted nothing" ->
  // no charcoal, no torches). Busy everywhere: wait for one, up to 2 min.
  const list = (furnacePos ? [furnacePos] : furnaces()).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  if (!list.length) return 0
  let w = null; const until = Date.now() + 120000
  while (!w && Date.now() < until && !U.cancelled(bot)) {
    for (const fp of list) {
      const c = await openAt(bot, fp, ['furnace', 'blast_furnace', 'smoker'])
      if (!c) continue
      const inp = c.inputItem()
      if (!inp || inp.name === inputName) { w = c; break }
      closeWin(c); await sleep(200)
    }
    if (!w) await sleep(10000)
  }
  if (!w) return 0
  let produced = 0
  const take = async tag => { const out = w.outputItem(); if (!out) return 0; const k = out.count; await U.withTimeout(w.takeOutput(), 6000, tag).catch(e_ => swallow('army:' + tag, e_)); return w.outputItem() ? 0 : k }
  try {
    await take('smeltTake0') // somebody's finished batch: taken along and banked, not counted as ours
    const fuel = pickFuel(bot, n)
    if (!fuel) return 0
    await U.withTimeout(w.putFuel(bot.registry.itemsByName[fuel.name].id, null, fuel.count), 8000, 'putFuel').catch(e_ => swallow('army:putFuel', e_))
    await U.withTimeout(w.putInput(input.id, null, n), 8000, 'putInput').catch(e_ => swallow('army:putInput', e_))
    const deadline = Date.now() + n * 11000 + 25000
    while (Date.now() < deadline && !U.cancelled(bot)) {
      await sleep(2500)
      const out = w.outputItem()
      if (out && (out.count >= 16 || !w.inputItem())) produced += await take('smeltTake')
      if (!w.inputItem()) break
      if (!w.fuelItem()) { const f2 = pickFuel(bot, w.inputItem().count); if (!f2) break; await U.withTimeout(w.putFuel(bot.registry.itemsByName[f2.name].id, null, f2.count), 8000, 'refuel').catch(e_ => swallow('army:refuel', e_)) }
    }
    produced += await take('smeltTakeEnd')
    if (w.inputItem()) await U.withTimeout(w.takeInput(), 6000, 'takeInput').catch(e_ => swallow('army:takeInput', e_))
  } finally { closeWin(w); await sleep(200) }
  return produced
}

// ------------------------------------------------------------------ self-defence (no chasing: hit what is in reach)
const HOSTILE = U.HOSTILE // ONE list (util.js), checked against the registry of the bots' version
// ENDERMEN (world 1: 8 deaths in 90 min, the #1 killer by day): never a target by themselves (hitting or staring starts the fight). Only one that the
// SERVER reports angry (enderAngry) within 4 blocks of a bot that just got hurt is everybody's target for 45 s - 3-4 swords beat 40 hp.
function hostiles (bot, r) {
  const me = bot.entity.position
  const out = []
  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (!e || !e.position || e === bot.entity) continue
    if (e.name === 'enderman' ? !(_angryEnder[e.id] > Date.now()) : !HOSTILE.has(e.name)) continue // mobs only: players are never targets
    const d = e.position.distanceTo(me)
    if (Math.abs(e.position.y - me.y) > 6) continue // a mob in the cave 19 blocks under the warehouse is not a target (foreman 09-19: a guard burned a night on travel_fail x7)
    if (d <= r) out.push({ e, d })
  }
  return out.sort((a, b) => a.d - b.d)
}
// CLOSE THE GATE BEHIND YOU (mobs walk through an open gate): the pathfinder opens fence gates and never closes them. The reflex remembers the gate cell the
// bot stands in; once the bot is 1.3-4.2 blocks past it (within 8 s), the gate is still open and no other player stands in or at it, it is clicked shut.
function gateCloser (bot) {
  const p = bot.entity.position; const here = bot.blockAt(p.floored())
  if (here && /fence_gate$/.test(here.name)) { bot.__armyGate = { pos: here.position.clone(), t: Date.now() }; return }
  const g = bot.__armyGate; if (!g || bot.__armyGateBusy || bot.currentWindow) return
  const cx = g.pos.x + 0.5; const cz = g.pos.z + 0.5; const d = Math.hypot(p.x - cx, p.z - cz)
  if (Date.now() - g.t > 8000 || d > 4.2) { bot.__armyGate = null; return }
  if (d < 1.3) return
  const b = bot.blockAt(g.pos); let open = false
  try { open = !!b && /fence_gate$/.test(b.name) && String(b.getProperties().open) === 'true' } catch (e_) { swallow('army:gateProps', e_) }
  if (!open) { bot.__armyGate = null; return }
  for (const id in bot.entities) { const e = bot.entities[id]; if (e && e !== bot.entity && e.type === 'player' && e.position && Math.hypot(e.position.x - cx, e.position.z - cz) < 1.6 && Math.abs(e.position.y - g.pos.y) < 2) return } // somebody is in / at the gate: look again next tick
  bot.__armyGateBusy = true; bot.__armyGate = null
  U.withTimeout(bot.activateBlock(b), 2500, 'gateClose').then(() => {
    const st = bot.__armyGateStat = bot.__armyGateStat || { n: 0, t: 0 }; st.n++
    if (Date.now() - st.t > 300000) { st.t = Date.now(); result(bot, { ev: 'gate_closed', at: [g.pos.x, g.pos.y, g.pos.z], n: st.n }) }
  }).catch(e_ => swallow('army:gateClose', e_)).finally(() => { bot.__armyGateBusy = false })
}
// THE MEAL REFLEX (main 09-20 08:5xZ: 7 of 50 bots at food <= 10 WITH bread in the pocket, a miner at food 6 carrying 21 - the worker eats only BETWEEN slices, and a
// 15-min mine / build slice is long enough to starve; a bot below 18 never regenerates, below 7 it cannot sprint). Every 4 s: hungry (<= 12, or hurt and <= 17), food
// carried, hands free (not digging, no chest open, nobody else eating) -> feed.js eat rule, then the tool that was in the hand goes back. Re-armed by every hot reload.
function mealReflex (bot) {
  if (bot.__armyMealT === LOADED_AT) return
  bot.__armyMealT = LOADED_AT; if (bot.__armyMeal) clearInterval(bot.__armyMeal)
  const timer = bot.__armyMeal = setInterval(() => {
    try {
      if (!bot.entity || bot.health <= 0 || bot.__armyEating || bot.food == null) return
      if (!(bot.food <= 12 || (bot.health < 20 && bot.food <= 17)) || bot.targetDigBlock || bot.currentWindow) return
      const FEED = require('./feed')
      if (!FEED.edibleCount(bot)) { // STARVING WITH EMPTY POCKETS inside a long slice (09-20 09:1xZ: 10 bots at food 0-10, 2993 bread in the depot - the canteen runs at slice START only):
        // end the slice through the core's alert queue (an alert nobody handles is dropped); the next slice starts with the canteen walk. Once per 3 min, only while the depot has food.
        if (bot.food <= 6 && bot.__core && Array.isArray(bot.__core.alerts) && Date.now() - (bot.__armyMealAlertT || 0) > 180000 && Object.entries(stockMap()).some(([k, v]) => v > 0 && /^(bread|cooked_|baked_potato)/.test(k))) { bot.__armyMealAlertT = Date.now(); bot.__core.alerts.push({ t: Date.now(), prio: 50, ms: 1000, kind: 'hungry', by: 'mealReflex' }) }
        return
      }
      bot.__armyEating = true; const held = bot.heldItem
      FEED.eat(bot, {}).then(async n => { if (n && held && !bot.targetDigBlock && !bot.currentWindow) { const it = bot.inventory.items().find(i => i.type === held.type); if (it) await bot.equip(it, 'hand') } })
        .catch(e_ => swallow('army:mealReflex', e_)).finally(() => { bot.__armyEating = false })
    } catch (e_) { swallow('army:mealTick', e_) }
  }, 4000)
  bot.once('end', () => clearInterval(timer))
}
function startGuard (bot) {
  stopGuard(bot)
  let busy = false
  let lastHit = 0
  bot.__armyGuard = setInterval(() => {
    try {
      if (!bot.entity || bot.health <= 0) return
      try { gateCloser(bot) } catch (e_) { swallow('army:gateCloser', e_) }
      if (busy) return
      const h = hostiles(bot, 3.4)[0]
      if (!h || Date.now() - lastHit < 620) return
      busy = true
      Promise.resolve().then(async () => {
        const sw = bestOf(bot, 'sword') || bestOf(bot, 'axe')
        if (sw && !(bot.heldItem && bot.heldItem.name === sw.name) && !bot.__armyEating) { try { await U.withTimeout(bot.equip(sw, 'hand'), 2000, 'eq') } catch (e_) { swallow('army:733', e_) } }
        const p = h.e.position.offset(0, (h.e.height || 1.6) * 0.6, 0)
        if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) { try { await bot.lookAt(p, true) } catch (e_) { swallow('army:735', e_) } }
        try { bot.attack(h.e) } catch (e_) { swallow('army:736', e_) }
        lastHit = Date.now()
      }).catch(e_ => swallow('army:738', e_)).finally(() => { busy = false })
    } catch (e_) { swallow('army:739', e_) }
  }, 250)
  if (bot.__armyGuard.unref) bot.__armyGuard.unref()
}
function stopGuard (bot) { if (bot.__armyGuard) { clearInterval(bot.__armyGuard); bot.__armyGuard = null } }

// kill one entity (prey or mob) with the pvp plugin, bounded. true = it died / vanished.
async function kill (bot, ent, ms = 25000, stop) {
  if (!ent || !ent.isValid) return false
  if (ent.name === 'enderman' && !(_angryEnder[ent.id] > Date.now())) return false // never START a fight with an enderman (40 hp, 7 dmg, teleports)
  const id = ent.id
  await equipBest(bot, 'sword') || await equipBest(bot, 'axe')
  try { if (bot.pathfinder.movements) bot.pvp.movements = bot.pathfinder.movements } catch (e_) { swallow('army:pvpMv', e_) } // the plugin's default Movements may dig and scaffold: fights stay read-only too
  try { bot.pvp.attack(ent) } catch { return false }
  const end = Date.now() + ms
  try {
    while (Date.now() < end && !U.cancelled(bot) && !(stop && stop())) {
      await sleep(300)
      const cur = bot.entities[id]
      if (!cur || !cur.isValid) return true
      if (cur.position.distanceTo(bot.entity.position) > 30) return false
      if (bot.health <= 6) return false
    }
    return false
  } finally { try { bot.pvp.stop() } catch (e_) { swallow('army:761', e_) } try { bot.pathfinder.setGoal(null) } catch (e_) { swallow('army:761', e_) } }
}
// walk over dropped items within r (uses the pathfinder with whatever movements are installed)
async function pickup (bot, r = 6, ms = 6000) { try { await U.pickupNear(bot, ms, r) } catch (e_) { swallow('army:764', e_) } }

module.exports = {
  DIR, F, sleep, readJSON, writeJSON, boardEdit, decline, result, settings, inv, count, bestOf, equipBest, heartbeat, assignment,
  strictMovements, larderFull, escapeMovements, skyAbove, digOut, fillShaft, inShaft, walkableArea, debt, travel, dist2, categoryOf, chestsOf, index, record, openChest, closeWin, bank, withdraw,
  scanChests, stockOf, stockMap, dumpJunk, askHelp, helpAnswer, placeHard, fillInside, gravityDrop, obtain, craftSpot, stash, unstash, siteInfo, siteSet, hostiles, startGuard, stopGuard, kill, pickup, HOSTILE, CATS,
  kitUp, kitPlan, wear, riskJob, carried, liveBots, musterPos, surfaceFloor, SEA_LEVEL, DROP, stairUp, furnaces, registerFurnaces, openAt, pickFuel, smelt, blueprintCellsOf, buildJobs, ours, ourBlock, penAt, insideOurs, zoneAt, TERRAIN_BP
}
