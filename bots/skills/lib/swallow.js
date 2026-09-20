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
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, process.pid + '.json'), JSON.stringify(counts)) } catch {}
}, 10000)
if (t.unref) t.unref()
module.exports = swallow
