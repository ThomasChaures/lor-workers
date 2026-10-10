// PM2 app "lor-inhouse" — drives the Inhouse matchmaker + ready-check/lobby/MVP
// expiry directly against the shared DB (service role), on an interval. The app
// fires the same engine on events; this is the heartbeat so matches form (as
// tolerance grows for waiting players) and abandoned matches get voided even when
// nobody is interacting. Needs only the shared Supabase service-role env.
import { env } from "../config/env.js";
import { runForever } from "../lib/loop.js";
import { inhouseCronTick } from "../jobs/inhouse-cron.js";

await runForever({
  name: "lor-inhouse",
  intervalMs: env.inhouseIntervalMs,
  task: inhouseCronTick,
});
