# minecraft-bot-army

50 [mineflayer](https://github.com/PrismarineJS/mineflayer) bots live an ordinary **legit survival** life on a Paper server (no /give, no /tp,
no creative) while humans watch as spectators. Mid-term goal: the Ender Dragon; after that, plain survival progression.

* All bots run ONE program (`bots/skills/army_worker.js`) and take jobs from ONE board (`bots/army/jobs.json`, edited through
  `bots/army/armyctl.js`). A dispatcher staffs jobs by demand (stock targets), tenure and measured yield.
* Movement is read-only: bots never dig or place blocks to get somewhere. World-changing work is a job with a blueprint (`bots/blueprints/`).
* LLMs are used sparingly: event-driven operator / help desk / foreman daemons (`ops/`), a chat daemon that can only talk. Everything
  repetitive is a script. Outcome audits (`ops/base-audit.js`, `ops/skyshot.js`) compare the world with the plan.

Start with `CLAUDE.md` (the operating runbook), then `docs/DEV.md` (code map), `docs/GOALS.md` (roadmap, doctrine, log),
`docs/PLAN-world2.md` (design). Not in the repository: server jars, worlds, backups, secrets (`server/.rcon_pw`, `server/server.properties`,
`server/plugins/`), local config (`server/guests.json`) and old-world records (`attic/`).
