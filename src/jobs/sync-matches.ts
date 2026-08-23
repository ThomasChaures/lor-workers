import { createLogger } from "../lib/logger.js";
import { createAdminClient } from "../config/supabase.js";

const log = createLogger("sync-matches");

// One sync tick. Right now this is a WIRED STUB: it proves the loop, PM2 and the
// Supabase connection work end-to-end before we bring the engine over.
//
// TODO(engine): the real work lives in the Next repo under src/lib/sync
// (service.ts, run.ts, constants.ts), src/lib/riot/*, src/lib/scoring/* and
// src/types/*. Once that code is vendored into this repo (see README → "Sharing
// the engine"), replace the body below with:
//   const claim = await claimSyncSlot(admin);
//   if (claim.ok) await runSyncAndStamp(admin);
export async function syncTick(): Promise<void> {
  const admin = createAdminClient();

  const { data: state, error } = await admin
    .from("sync_state")
    .select("last_sync_at, last_completed_at, sync_requested_at")
    .eq("id", "global")
    .single();

  if (error) {
    log.warn("could not read sync_state — is the migration applied?", error.message);
    return;
  }

  log.info("tick ok — sync_state reachable", state);
}
