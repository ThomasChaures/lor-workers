import { createLogger } from "./logger.js";

export interface LoopOptions {
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
}

// The spine of every worker: run `task` forever, sleeping `intervalMs` between
// runs (measured from the start of each tick, so a slow tick doesn't stack).
// A thrown task is logged and the loop keeps going — the process must never die
// on a transient Riot/Supabase error. SIGINT/SIGTERM stop the loop; if a signal
// lands mid-sleep the sleep is woken immediately (see `wake`), so a PM2 reload
// never has to wait out the full interval before the worker exits.
export async function runForever({ name, intervalMs, task }: LoopOptions): Promise<void> {
  const log = createLogger(name);
  let stopping = false;
  let wake: (() => void) | null = null; // resolves the current sleep early

  const stop = (signal: string) => {
    log.info(`received ${signal} — stopping`);
    stopping = true;
    wake?.(); // break out of the sleep NOW instead of waiting it out
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // Interruptible sleep: resolves after `ms`, or immediately if `wake()` fires
  // (on SIGINT/SIGTERM). Without this, a signal arriving mid-sleep would wait
  // out the full interval — then run one more whole tick — before stopping.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  log.info(`loop started (interval ${intervalMs}ms)`);
  for (;;) {
    const startedAt = Date.now();
    try {
      await task();
    } catch (err) {
      log.error("tick failed", err instanceof Error ? (err.stack ?? err.message) : err);
    }
    if (stopping) break;

    await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
    if (stopping) break;
  }

  log.info("stopped cleanly");
}
