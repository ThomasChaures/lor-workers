import { createLogger } from "../lib/logger.js";
import { createAdminClient } from "../config/supabase.js";
import { claimSyncSlot, runSyncAndStamp } from "@/lib/sync/run";

const log = createLogger("sync-matches");

// One sync tick — the real engine now. `claimSyncSlot` is the shared lock/cooldown
// (sync_state row id='global'): it rejects if a run is still in flight or the
// cooldown hasn't elapsed, so overlapping ticks (or a pass that outlives the loop
// interval) can't double-run. `runSyncAndStamp` runs syncMatches and ALWAYS stamps
// completion, even on failure, so the state never sticks as "running".
export async function syncTick(): Promise<void> {
  const admin = createAdminClient();

  const claim = await claimSyncSlot(admin);
  if (!claim.ok) {
    log.info(`skipped — slot busy or cooling down (retry in ${claim.retryAfter}s)`);
    return;
  }

  log.info("sync starting");
  const progress = await runSyncAndStamp(admin);
  if (!progress) {
    log.warn("sync run failed — see engine logs above");
    return;
  }

  log.info(
    `sync done: ${progress.membersProcessed}/${progress.membersTotal} players, ` +
      `${progress.matchesFetched} new matches, ${progress.pointsCalculated} points, ` +
      `${progress.matchesOutOfRange} out of range, ${progress.errors.length} errors`
  );
}
