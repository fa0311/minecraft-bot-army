// swallow.js — NO MORE SILENT catch {} (owner, 09-19: "you are paying for all the errors you swallowed").
// Every catch that deliberately continues calls swallow('file:line', e): the error is COUNTED per (where, message) and flushed to
// bots/army/swallowed/<pid>.json every 10 s. `node bots/army/armyctl.js errors` merges the shards and shows what keeps failing, so a
// primitive that "works" only because its failures are invisible gets noticed. Cancellations are not errors and are ignored.
const fs = require('fs'); const path = require('path')
const DIR = path.join(__dirname, '..', '..', 'army', 'swallowed')
const counts = {}; let dirty = false
function swallow (where, e) {
  if (!e || e.cancelled) return
  const msg = String((e && e.message) || e).replace(/-?\d+(\.\d+)?/g, 'N').slice(0, 100)
  const k = where + ' | ' + msg
  const c = counts[k] = counts[k] || { n: 0, first: Date.now() }
  c.n++; c.last = Date.now(); dirty = true
}
const t = setInterval(() => {
  if (!dirty) return; dirty = false
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, process.pid + '.json'), JSON.stringify(counts)) } catch (e) { /* the shard dir is unwritable; the counters stay in memory and `errors` simply does not see this pid */ }
}, 10000)
if (t.unref) t.unref()

// ---- SEVERITY (owner 09-21, two lava deaths in the Nether: "ゴミみたいなエラーハンドリングしてるからだろ") --------------------------
// swallow() is right for NOISE. It is wrong when the swallowed error — or a block read that came back null because the chunk is not
// loaded — means the bot is about to PLACE, DIG, STEP or judge a cell DONE while BLIND. Those sites call swallow.blind(bot, where,
// why, e): still counted like any other swallowed error, and in addition reported ONCE per signature per 5 min as a real
// `blind_action` event in the army ledger (`armyctl.js events 20 blind_action`, the `wait` digest, ops/escalate.sh) and in the
// manager log. No new state file, no daemon — it writes the ledger army.js already writes.
const RESULTS = path.join(__dirname, '..', '..', 'army', 'results.jsonl')
const LOUD_MS = 5 * 60 * 1000
const loud = {}
function blind (bot, where, why, e) {
  swallow(where, e || { message: 'blind: ' + why })
  const sig = where + ' | ' + String(why || '').replace(/-?\d+(\.\d+)?/g, 'N').slice(0, 80)
  const now = Date.now()
  const s = loud[sig] || (loud[sig] = { n: 0, at: 0 })
  s.n++
  if (now - s.at < LOUD_MS) return false
  const reps = s.n; s.at = now; s.n = 0
  let at = null
  try { const p = bot.entity.position; at = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] } catch (e_) { at = null }
  const st = (bot && bot.state) || {}
  const rec = { t: now, bot: (bot && bot.username) || null, ev: 'blind_action', where, why: String(why || '').slice(0, 140), at, job: st.job || null, task: st.task || null, x: reps }
  // ARMY_TEST=1 (tests/unknown_cells.js) keeps a fake bot's events out of the live ledger; the bot's own hook still fires.
  if (!process.env.ARMY_TEST) { try { fs.appendFileSync(RESULTS, JSON.stringify(rec) + '\n') } catch (e_) { swallow('swallow:blindLedger', e_) } }
  try { if (bot && typeof bot.__logEvent === 'function') bot.__logEvent({ bot: rec.bot, type: 'blind_action', where, why: rec.why, at, x: reps }) } catch (e_) { swallow('swallow:blindLog', e_) }
  return true
}

module.exports = swallow
module.exports.blind = blind
