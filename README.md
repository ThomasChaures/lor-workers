# LOR-U — Worker Host

Background worker host for **LeagueOfRankeds**. Runs on the VPS (always-on),
separate from the Next front (Vercel). It is **not** a microservice: it exposes
no HTTP API. Workers run in loops and communicate with the app **through the
shared Supabase database**.

## Workers

| PM2 app      | Entry                    | Job                                             |
| ------------ | ------------------------ | ----------------------------------------------- |
| `lor-sync`   | `src/workers/sync.ts`    | Continuous Riot match sync (no 300s ceiling).   |
| `lor-emails` | `src/workers/emails.ts`  | Email cron jobs (placeholder for now).          |

Add new workers as new files under `src/workers/` + a new entry in
`ecosystem.config.cjs`.

## Layout

```
src/
  config/   env.ts, supabase.ts   # validated env + service-role client
  lib/      logger.ts, loop.ts    # runForever spine, scoped logging
  jobs/     sync-matches.ts       # the actual tick logic
  workers/  sync.ts, emails.ts    # PM2 entrypoints, one process each
  engine/   (to be vendored)      # shared sync/riot/scoring — see below
```

## Local dev

```bash
npm install
cp .env.example .env   # fill in Supabase + Riot
npm run dev:sync       # runs the sync loop with hot reload
npm run typecheck
```

## Deploy (CI/CD)

Deploys are automated via GitHub Actions (`.github/workflows/deploy.yml`): every
push to `main` SSHes into the VPS, hard-resets to `origin/main`, regenerates
`.env` from GitHub Secrets, runs `npm ci` and `pm2 startOrReload`.

Required GitHub Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (SSH connection) +
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RIOT_API_KEY` (written to `.env` on
each deploy — single source of truth, never committed).

One-time VPS setup (git/node/pm2 installed, deploy key authorized on GitHub):

```bash
git clone git@github.com:<you>/lor-u.git ~/lor-u
# then push to main — the pipeline does .env + npm ci + pm2 start
pm2 startup     # run ONCE after the first deploy, so PM2 survives reboots
pm2 logs        # tail
```

## Sharing the engine (important)

This repo is **separate** from the Next app, but the sync worker must reuse the
**exact same** scoring/Riot/sync code. If the two copies drift, the leaderboard
and the worker will compute different points — silent, hard-to-debug data
corruption.

Shared code from the Next repo (`src/lib/sync`, `src/lib/riot`, `src/lib/scoring`,
`src/types`) lands in `src/engine/`. To keep it in sync **do NOT hand-copy** —
pick one mechanism:

- **git subtree** (recommended): pull the engine folders from the main repo into
  `src/engine/` on demand. One command, history preserved, no submodule friction.
- **git submodule**: point `src/engine/` at a shared repo/branch.
- **published package**: extract the engine to a private npm package both consume.

Until the engine is vendored, `src/jobs/sync-matches.ts` runs a wired stub that
only verifies the Supabase connection.

## Front ↔ worker contract

The manual "Sincronizar" button in the front writes `sync_state.sync_requested_at`.
The worker reads it each tick and honors on-demand requests; otherwise it syncs on
its own interval. No HTTP call ever crosses from Vercel to the VPS.
