// PM2 app "lor-emails" — placeholder for email cron jobs.
import { runForever } from "../lib/loop.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("lor-emails");

await runForever({
  name: "lor-emails",
  intervalMs: 60_000,
  task: async () => {
    log.info("idle — no email jobs wired yet");
  },
});
