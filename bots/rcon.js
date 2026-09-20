#!/usr/bin/env node
// Minimal RCON client: node rcon.js "say hi" "list"
const net = require('net')
const fs = require('fs')
const path = require('path')
const pw = fs.readFileSync(path.join(__dirname, '../server/.rcon_pw'), 'utf8').trim()
const cmds = process.argv.slice(2)

function packet (id, type, body) {
  const b = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + b.length)
  buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8)
  b.copy(buf, 12)
  return buf
}
const sock = net.connect(25575, '127.0.0.1')
let acc = Buffer.alloc(0); let i = -1
sock.on('connect', () => sock.write(packet(1, 3, pw)))
sock.on('data', d => {
  acc = Buffer.concat([acc, d])
  while (acc.length >= 4 && acc.length >= acc.readInt32LE(0) + 4) {
    const len = acc.readInt32LE(0)
    const id = acc.readInt32LE(4)
    const body = acc.slice(12, len + 2).toString('utf8')
    acc = acc.slice(len + 4)
    if (id === -1) { console.error('auth failed'); process.exit(1) }
    if (i >= 0 && body) console.log(body.replace(/§./g, ''))
    i++
    if (i >= cmds.length) return sock.end()
    sock.write(packet(10 + i, 2, cmds[i]))
  }
})
sock.on('error', e => { console.error(String(e)); process.exit(1) })
