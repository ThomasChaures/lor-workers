// PM2 app "lor-live" — polls Twitch/Kick and writes live status to profiles.
import { env } from "../config/env.js";
import { runForever } from "../lib/loop.js";
import { pollLiveTick } from "../jobs/poll-live.js";

// Fail fast (this worker only) if Twitch isn't configured — Kick alone would
// silently cover just half the feature. The sync/email workers don't need these,
// so they stay optional in the shared env and are enforced right here.
if (!env.twitchClientId || !env.twitchClientSecret) {
  throw new Error("lor-live requires TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET");
}

await runForever({
  name: "lor-live",
  intervalMs: env.liveIntervalMs,
  task: pollLiveTick,
});
