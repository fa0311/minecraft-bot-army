#!/usr/bin/env node
// ops/helpdesk.js — the HELP DESK: answers bots' failure tickets with an LLM (owner: "when something fails, let an LLM answer — algorithms have limits").
//   bots/army/tickets/<bot>.<t>.json  (written by A.askHelp)  ->  bots/army/answers/<bot>.json  (run by the worker at its next slice)
// One short, fresh, tool-less LLM call per NEW failure signature (model: HELP_MODEL, default sonnet). The answer is cached in
// bots/army/remedies.json by signature and reused for every later ticket of the same kind — remedies that fail twice more than they work are
// dropped and asked again. action = steps (<= 8 verbs for this bot) | decline (give the job back) | escalate (one line into docs/BUGS.md).
// start: setsid nohup node ops/helpdesk.js >> ops/helpdesk.log 2>&1 &   (ops/up.sh does it)      stop: pkill -f ops/helpdesk.js
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process')
const A = '/root/workspace/bots/army'; const T = path.join(A, 'tickets'); const ANS = path.join(A, 'answers'); const RF = path.join(A, 'remedies.json')
const MODEL = process.env.HELP_MODEL || 'sonnet'
for (const d of [T, ANS]) fs.mkdirSync(d, { recursive: true })
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 1)); fs.renameSync(f + '.tmp', f) }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const VERBS = ['goto', 'bank', 'withdraw', 'stash', 'unstash', 'place', 'dig', 'collect', 'fell', 'craft', 'smelt', 'kill', 'pickup', 'shear', 'till', 'equip', 'eat', 'sleep', 'wait', 'fill', 'pour']
function ask (prompt) {
  return new Promise(resolve => {
    // owner 09-20: "ハングしたらsonnetに判断…sonnet5はそこそこコンテクストあるぞ" - the desk gets EYES: read-only armyctl (look/bot/ground/stock/recipe/howto; ARMY_READONLY=1
    // makes every board write refuse itself) and a few turns to look before it answers. Still one fresh session per NEW failure signature, answers cached and scored.
    const p = spawn('claude', ['-p', prompt, '--model', MODEL, '--max-turns', '8', '--allowedTools', 'Bash(node bots/army/armyctl.js:*)', 'Read', '--disallowedTools', 'Edit', 'Write', 'Agent', 'Task', 'WebFetch', 'WebSearch'], { cwd: '/root/workspace', env: Object.assign({}, process.env, { ARMY_READONLY: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; p.stdout.on('data', d => { out += d }); const k = setTimeout(() => p.kill(), 300000)
    p.on('close', () => { clearTimeout(k); resolve(out) })
  })
}
function promptFor (t) {
  const table = (rj(path.join(A, 'jobs.json'), {}).settings || {}).craftTable // the depot crafting table of THIS world (board setting), never a hard-coded spot
  return `You are the help desk of a Minecraft survival bot army (mineflayer). A bot's algorithm failed and asks what to do. Answer with ONE JSON object only, no prose.
Rules of this world: legit survival; movement never digs/places; never stand in sweet berry bushes; water only into closed holes; keep_inventory is OFF; depot (chests/barrels${Array.isArray(table) ? ', crafting table at ' + table.join(',') : ''}) is where items come from ("withdraw" knows the stock index).
Already automatic (do NOT escalate these, answer with steps or decline): a boxed-in or roofed-in bot escapes by itself (fills a 1x1 pit, pillars straight up with filler blocks, or cuts a staircase) and a truly hung bot is rescued by the operator; hungry bots eat at the depot canteen; full chests are expanded by the quartermaster. If the bot lacks filler blocks for the pillar escape and stands on dirt/stone, a useful answer is steps like dig{at: a block beside its feet} to collect filler, then wait.\nVerbs the bot can run (each step is {"do":verb,...}): goto{to:[x,y|null,z],range} withdraw{item,n} bank{keep:{}} place{block,at:[x,y,z]} dig{at:[x,y,z]} collect{block,n,radius} fell{radius,replant} craft{item,n} smelt{item,n} kill{kinds:[],n,radius} pickup{radius} till{at,seed} equip{item} eat sleep wait{s} fill{at} pour{at} shear{n}.
You have EYES - use them before you answer when the ticket alone does not settle it (at most 5 commands, all read-only, from /root/workspace): 'node bots/army/armyctl.js look <bot> 10' (terrain + exact coordinates), 'bot <bot>' (inventory, boxed-in check, last reports), 'ground <bot> x,z …', 'stock <regex>', 'recipe <item>', 'howto <thing>', 'events 15 <bot>'. Think like a competent player standing where the bot stands: what would you do with what it carries? Your LAST message must be the ONE JSON object and nothing else.
Answer schema: {"action":"steps","steps":[...<=8],"reusable":true|false,"note":"why, <=100 chars"}  or {"action":"decline","note":"..."} (give the job back, e.g. the target is pointless)  or {"action":"escalate","note":"what the CODE OWNER must fix, with coordinates"}.
Use only coordinates that appear in the ticket (pos, why, look.things) — the look map is an ASCII top view around the bot: '@' bot, '.' same level, digits higher, letters lower, '~' water, 'T' tree, 'C' chest; north is up, top_left = [x,z] of the first character. "reusable": true only if the same steps would fix ANY ticket with this signature (no ticket-specific coordinates).
TICKET: ${JSON.stringify(t)}`
}
function valid (a) {
  if (!a || !['steps', 'decline', 'escalate'].includes(a.action)) return false
  if (a.action === 'steps') return Array.isArray(a.steps) && a.steps.length > 0 && a.steps.length <= 8 && a.steps.every(s => s && VERBS.includes(s.do))
  return true
}
async function handle (file) {
  const t = rj(path.join(T, file), null); if (!t || t.done) return
  const R = rj(RF, {}); let a = null; let from = 'llm' // eslint-disable-line prefer-const
  const c = R[t.sig]
  if (c && c.answer && (c.bad || 0) <= (c.ok || 0) + 2) { a = c.answer; from = 'cache' } else {
    const out = await ask(promptFor(t)); const m = out.match(/\{[\s\S]*\}/)
    try { a = m ? JSON.parse(m[0]) : null } catch { a = null }
    if (!valid(a)) { log('INVALID answer for', t.id, String(out).slice(0, 160)); a = { action: 'decline', note: 'help desk could not produce a valid answer' } } else if (a.action === 'steps' && a.reusable) { R[t.sig] = { answer: a, ok: 0, bad: 0, t: Date.now(), example: t.why }; wj(RF, R) }
  }
  a.t = Date.now(); a.sig = t.sig
  const escF = path.join(A, 'helpdesk_escalated.json'); const esc = rj(escF, {})
  if (a.action === 'escalate' && Date.now() - (esc[t.kind] || 0) < 3600000) { a = { action: 'decline', note: 'already escalated this kind within the hour: ' + String(a.note || '').slice(0, 60) } } else if (a.action === 'escalate') { esc[t.kind] = Date.now(); wj(escF, esc) }
  if (a.action === 'escalate') fs.appendFileSync('/root/workspace/docs/BUGS.md', `- [ ] ${new Date().toISOString().slice(11, 16)}Z helpdesk (${t.bot}, ${t.kind}): ${String(a.note).slice(0, 300)} | ticket: ${t.why.slice(0, 160)} @${t.pos}\n`)
  wj(path.join(ANS, t.bot + '.json'), a)
  t.done = true; t.answer = a; t.from = from; wj(path.join(T, file), t)
  log(from.toUpperCase(), t.bot, t.kind, '->', a.action, a.action === 'steps' ? a.steps.map(s => s.do).join('>') : '', '|', String(a.note || '').slice(0, 100))
}
async function loop () {
  for (;;) {
    try {
      const files = fs.readdirSync(T).filter(f => f.endsWith('.json')).sort()
      for (const f of files) { const st = fs.statSync(path.join(T, f)); if (Date.now() - st.mtimeMs > 6 * 3600000) { fs.unlinkSync(path.join(T, f)); continue } await handle(f) }
    } catch (e) { log('loop error', e.message) }
    await new Promise(r => setTimeout(r, 4000))
  }
}
log('help desk up, model', MODEL); loop()
