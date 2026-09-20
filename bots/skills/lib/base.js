// base.js — COMPATIBILITY SHIM, no state and no logic of its own. World 1 kept furnaces/chests/beds in bots/base.json; that file is gone:
// furnaces live in the board (`settings.furnaces:[[x,y,z]…]`, docs/PLAN-world2.md §9) and the furnace primitives in lib/army.js
// (A.furnaces / A.registerFurnaces / A.openAt / A.smelt / A.pickFuel). This file only keeps the old call sites of army_jobs.js and
// iron_miner.js working until they call army.js directly — then DELETE it. Do not add anything here.
const A = require('./army')

function read () { return { base: A.settings().base || null, chests: [], beds: [], furnaces: A.furnaces().map(p => ({ x: p.x, y: p.y, z: p.z })) } }
// update(fn): fn may only ADD furnaces to d.furnaces (the one thing callers ever did); they are registered in settings.furnaces
async function update (fn) { const d = read(); const r = await fn(d); A.registerFurnaces(d.furnaces || []); return r }

module.exports = { read, update, furnaceList: A.furnaces, openAt: A.openAt, closeWin: A.closeWin, smelt: A.smelt, pickFuel: A.pickFuel }
