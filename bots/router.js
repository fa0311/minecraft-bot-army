// Thin API router on :3000 -> fans requests out to manager shards on :3001.. and merges the JSON replies.
const http = require('http')
const SHARDS = +(process.env.SHARDS || Math.ceil(require('./roster.json').length / 3))
const ROSTER = (() => { try { return require('./roster.json') } catch { return [] } })()
const PER = +(process.env.PER_SHARD || 3)
const shardOf = (name) => { const i = ROSTER.indexOf(name); return i < 0 ? 0 : Math.floor(i / PER) % SHARDS }
function call (shard, method, path, body) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: 3001 + shard, method, path, headers: { 'content-type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => { d += c }); res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.end(body)
  })
}
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c
  const url = new URL(req.url, 'http://x')
  let json = {}; try { json = body ? JSON.parse(body) : {} } catch {}
  const all = [...Array(SHARDS).keys()]
  let out
  if (url.pathname === '/players') {
    for (const s of all) { out = await call(s, 'GET', req.url); if (out && out.length) break }
    out = (out || []).map(p => ({ ...p, isBot: ROSTER.includes(p.name) }))
  } else if (req.method === 'GET') {
    const sel = url.searchParams.get('bots')
    const targets = sel && sel !== 'all' ? [...new Set(sel.split(',').map(shardOf))] : all
    out = (await Promise.all(targets.map(s => call(s, 'GET', req.url)))).filter(Array.isArray).flat()
    if (url.pathname === '/events') out.sort((a, b) => a.id - b.id)
    if (url.pathname === '/status') out.sort((a, b) => a.name < b.name ? -1 : 1)
  } else {
    // group the selected bots per shard, forward, merge
    let groups
    const sel = json.bots
    if (url.pathname === '/spawn' || !sel || sel === 'all') groups = all.map(s => [s, json])
    else {
      const names = Array.isArray(sel) ? sel : String(sel).split(',')
      const m = new Map()
      for (const n of names) { const s = shardOf(n); if (!m.has(s)) m.set(s, []); m.get(s).push(n) }
      groups = [...m].map(([s, ns]) => [s, { ...json, bots: ns }])
    }
    const rs = (await Promise.all(groups.map(([s, j]) => call(s, 'POST', req.url, JSON.stringify(j))))).filter(Boolean)
    if (rs.every(Array.isArray)) out = rs.flat()
    else { out = {}; for (const r of rs) for (const [k, v] of Object.entries(r)) out[k] = Array.isArray(v) ? (out[k] || []).concat(v) : v }
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out))
}).listen(3000, '127.0.0.1', () => console.log('router on :3000 ->', SHARDS, 'shards'))
