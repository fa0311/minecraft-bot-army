# REQUIREMENTS — what this system must be, and what it actually is (top model, 2026-09-21)

The owner asked for 要件整理 after a day in which he, not the system, found most of the faults. This file is the honest inventory: what the army
is FOR, what it must guarantee, where the current code breaks those guarantees, and the refactor backlog ranked by the damage each item did.
It is not a roadmap (that is `docs/GOALS.md`) and not a code map (`docs/DEV.md`). Keep it short; replace lines, do not append history.

## 1. What the army is for
Fifty bots play ONE legit survival game for the owner and his spectators. Mid-term goal: the Ender Dragon. No final goal: ordinary survival
progression afterwards. The owner steers with ideas; the top model decides and reports. Every bot-hour is the owner's money.

## 2. The guarantees (a failure of any of these is a bug, not a preference)
| # | Guarantee | Enforced by | Broken today? |
|---|---|---|---|
| G1 | A bot never changes the world to travel | capability switch (`terrain_guard`), not a cost | held |
| G2 | Every terrain edit is planned, named, logged, repairable | job + blueprint + `plan.js` target map | **broken**: escape digs, `steps`, mine graph and spurs have no plan entry |
| G3 | Two jobs never contradict each other on one cell | precedence at PLAN time (`plan.js`) | **broken until wired**: 556 overlaps, 24 live wars measured |
| G4 | Unknown is never success | `blocks.readAt`, `knownAt` | **mostly fixed today**: 8 patch sites outside the reliability engineer's files remain |
| G5 | A bot that can act is never idle by day | dispatcher + sponge jobs | **broken**: 76 % of bot-time produced nothing in the worst hour |
| G6 | Nothing the army owns is lost silently | `offload`, `recover`, death pricing | partly: 1 519 iron-eq, 580 diamonds lost to 115 deaths; ~27 % recovered |
| G7 | What we believe about the world expires | camera audits every 30 min | **fixed today** for gates and surfaces; stock/pens/roads still trust stale state |
| G8 | An experiment costs nothing to lose | `params.bare` | fixed today (and it must keep `params.cargo`) |
| G9 | Everything repetitive is LLM-free | scripts + daemons | held |
| G10 | The owner never finds a systemic failure first | audits + escalation | **broken repeatedly today** — the reason this file exists |

## 3. Where the model is wrong (the architectural debt, in order of damage)
1. **Job state is a boolean.** `active|paused` hides done / blocked-on-material / failed / retired / draft. A retired job leaves no trace, so
   when I retired the herds the sheep died out unnoticed; a blocked job looks like a broken one. → states + a reason field on every pause.
2. **Intent lives in job boxes, not in the world.** Each job computes its own truth from its own box, so two jobs disagree per cell and the
   last writer wins for ever (the 20-hour dig/place war). `bots/army/plan.js` now compiles ONE target per cell with precedence and cell leases;
   nothing is wired to it yet. → wire `build`, `cavity`, the audit and `armyctl put` to the map (patch list in `docs/PLAN.md`).
3. **Perception is per-feature.** The camera audit judged only planned pads (91 columns) while discarding unclaimed ground (2 432); the gate
   census was written once by a bot and never re-measured; the Nether had no eyes at all until today. → one diff (`plan.diff`) for build,
   repair and audit; every belief carries an expiry.
4. **Kit/banking decides what a trip can do, invisibly.** Bare/bank stripped the gold to trade, the stone to bridge and the diamonds to keep,
   and the failures surfaced as unrelated errors ("no sword", "No path to the goal!"). → `params.cargo` (done) + a kit contract per job type.
5. **Silent failure by default.** 561 `swallow()`, 123 empty `catch {}` (lint added, backlog unfixed), and defaults that read as success.
   → `swallow.blind` on any path that then places, digs, steps or judges; the lint gate goes strict once the backlog is cleared.
6. **Head-count is a number, not a plan.** Jobs are staffed by `bots` and a demand scaler that several fronts fight over; the mine sat at 0 of
   20 for three hours because a food gate rested the whole job. → readiness per bot, never per job; one scaler; a job that cannot be staffed says why.

## 4. Refactor backlog (do in this order, each with a measured before/after)
1. Job states + reason (`done|blocked|failed|retired|draft`), with the audit proposing revival when demand returns.
2. Wire `plan.js` into `build` (ownership, done-test, runaway) and into `base-audit` (one diff). Remove `ownedCols` and the `cap_*` class.
3. Kit contract: `params.cargo` + per-type kit list; `bank(…, {strip})` is the only tier-down path.
4. Finish G4: the 8 blind-read patch sites; then make the empty-catch lint fail the build.
5. Idle: one scaler, readiness per bot, a sponge that is always absorbable; gemba's `USELESS` count is the metric.
6. Roads as the default movement substrate (cost model is live, network is 1 of 3 built).

## 5. What today proved works and must not regress
Measured techniques: water-bucket landing (3/3, 0 hp), sprint-jump travel (OFF since 09-21 08:1xZ by the owner, `settings.dash`), `bridgeTo` (pathfinder scaffolding + sneak),
pillar escape (no scars), void sizing before any decision about a hole, the exposed-block rule (surface right 92.1 % → 95.1 %), cave-aware
mining (0 → 511 raw iron/hour), the camera in both dimensions, death pricing, and the bare-handed rule for experiments.
