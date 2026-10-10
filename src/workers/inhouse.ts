// PM2 app "lor-inhouse" — drives the Inhouse matchmaker + ready-check expiry by
// POSTing the Next app's cron endpoints on an interval. The app holds the logic;
// this is just the heartbeat so matches form (as tolerance grows for waiting
// players) and failed ready-checks get voided even when nobody is interacting.
import { env } from "../config/env.js";
import { runForever } from "../lib/loop.js";
import { inhouseCronTick } from "../jobs/inhouse-cron.js";

// Fail fast (this worker only) if the app URL / secret aren't configured — the
// other workers don't need them, so they stay optional in the shared env.
if (!env.appBaseUrl || !env.inhouseCronSecret) {
  throw new Error("lor-inhouse requires APP_BASE_URL and INHOUSE_CRON_SECRET");
}

await runForever({
  name: "lor-inhouse",
  intervalMs: env.inhouseIntervalMs,
  task: inhouseCronTick,
});
