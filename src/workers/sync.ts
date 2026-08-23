// PM2 app "lor-sync" — continuous match-sync loop.
import { env } from "../config/env.js";
import { runForever } from "../lib/loop.js";
import { syncTick } from "../jobs/sync-matches.js";

await runForever({
  name: "lor-sync",
  intervalMs: env.syncIntervalMs,
  task: syncTick,
});
