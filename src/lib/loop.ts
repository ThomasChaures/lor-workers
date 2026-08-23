import { createLogger } from "./logger.js";

export interface LoopOptions {
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The spine of every worker: run `task` forever, sleeping `intervalMs` between
// runs (measured from the start of each tick, so a slow tick doesn't stack).
// A thrown task is logged and the loop keeps going — the process must never die
// on a transient Riot/Supabase error. SIGINT/SIGTERM stop cleanly after the
// current tick, so PM2 reloads don't cut a sync mid-flight.
export async function runForever({ name, intervalMs, task }: LoopOptions): Promise<void> {
  const log = createLogger(name);
  let stopping = false;

  const stop = (signal: string) => {
    log.info(`received ${signal} — stopping after current tick`);
    stopping = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  log.info(`loop started (interval ${intervalMs}ms)`);
  for (;;) {
    const startedAt = Date.now();
    try {
      await task();
    } catch (err) {
      log.error("tick failed", err instanceof Error ? (err.stack ?? err.message) : err);
    }
    if (stopping) {
      log.info("stopped cleanly");
      return;
    }
    await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
  }
}
