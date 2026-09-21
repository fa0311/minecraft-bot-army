#!/usr/bin/env node
// ops/lint-catch.js — AN EMPTY `catch {}` IS A LIE (owner 09-21: 「これ当たり前じゃないのか？」 - yes, and removing 20 by hand is not a fix; a gate is).
// It fails `ops/check.sh` when a production file swallows an error with NOTHING: no swallow(), no report, no comment saying why silence is right.
// Allowed: `catch {}` with a `// why:` comment on the same or previous line, or a body that swallows/reports/returns a value the caller checks.
const fs = require('fs'); const path = require('path')
const WS = '/root/workspace'
const DIRS = ['bots/skills', 'bots/army', 'ops', 'bots']
const SKIP = /node_modules|\/attic\/|\.min\.js$/
const files = []
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (SKIP.test(p)) continue; if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p) } }
for (const d of DIRS) { const p = path.join(WS, d); try { if (fs.statSync(p).isDirectory()) walk(p) } catch {} } // why: a missing optional directory is not a lint failure
const RE = /(^|[^/*\w])catch\s*(\([^)]*\))?\s*\{\s*\}/g // not inside a comment: the word `catch {}` appears in several headers explaining the rule
let bad = 0
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8'); const lines = src.split('\n')
  let m
  while ((m = RE.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    const here = lines[line - 1] || ''; const prev = lines[line - 2] || ''
    const before = here.slice(0, Math.max(0, here.indexOf('catch')))
    if (/\/\/|\*/.test(before)) continue // the match sits inside a comment
    if (/why:|\/\/ *(ignore|best effort|optional)/i.test(here) || /why:/.test(prev)) continue
    console.log('EMPTY CATCH  ' + path.relative(WS, f) + ':' + line + '  ' + here.trim().slice(0, 100))
    bad++
  }
}
if (bad) { console.log('\n' + bad + ' empty catch block(s): give each one a `// why: …` on the same line, a swallow() with a signature, or a real handler.') ; process.exit(1) }
console.log('lint: no empty catch blocks in ' + files.length + ' production files')
