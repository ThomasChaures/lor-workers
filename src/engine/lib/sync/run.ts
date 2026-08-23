import { SupabaseClient } from "@supabase/supabase-js";
import { syncMatches, type SyncProgress } from "./service";
import { SYNC_COOLDOWN_MS, SYNC_COOLDOWN_SECONDS, SYNC_STALE_MS } from "./constants";

// Atomically claim the global sync slot. This is the lock that keeps cron and
// manual syncs (and two concurrent clicks) from running syncMatches at once.
// A claim is rejected if a run is still IN FLIGHT (last_sync_at > last_completed_at
// and not yet stale) — gating on the real running state, not just the cooldown,
// so a run that outlives the 5-min cooldown can't be double-started. It's also
// rejected while the cooldown hasn't elapsed. `force` (super_admin) bypasses both.
export async function claimSyncSlot(
  admin: SupabaseClient,
  opts: { force?: boolean } = {}
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  if (opts.force) {
    await admin.from("sync_state").update({ last_sync_at: nowIso }).eq("id", "global");
    return { ok: true };
  }

  const { data: st } = await admin
    .from("sync_state")
    .select("last_sync_at, last_completed_at")
    .eq("id", "global")
    .single();

  // last_sync_at is NOT NULL DEFAULT epoch 0, so lastIso is always present.
  const lastIso = st?.last_sync_at ?? new Date(0).toISOString();
  const last = new Date(lastIso).getTime();
  const done = st?.last_completed_at ? new Date(st.last_completed_at).getTime() : 0;

  const running = last > 0 && last > done && now - last < SYNC_STALE_MS;
  const cooldownLeft = SYNC_COOLDOWN_MS - (now - last);
  if (running || cooldownLeft > 0) {
    const runLeft = running ? SYNC_STALE_MS - (now - last) : 0;
    return { ok: false, retryAfter: Math.max(1, Math.ceil(Math.max(cooldownLeft, runLeft) / 1000)) };
  }

  // Optimistic CAS: only win if nobody advanced last_sync_at between our read
  // and this write. The loser (concurrent claimant) backs off a full cooldown.
  const { data: won } = await admin
    .from("sync_state")
    .update({ last_sync_at: nowIso })
    .eq("id", "global")
    .eq("last_sync_at", lastIso)
    .select("id");

  if (won && won.length > 0) return { ok: true };
  return { ok: false, retryAfter: SYNC_COOLDOWN_SECONDS };
}

// Run the sync and ALWAYS stamp completion — even on failure — so the state
// never reads as permanently "running". Returns the progress (or null on throw)
// for callers that await it (cron); background callers can ignore the result.
export async function runSyncAndStamp(admin: SupabaseClient): Promise<SyncProgress | null> {
  try {
    return await syncMatches(admin);
  } catch (err) {
    console.error("[sync] Sync run failed:", err);
    return null;
  } finally {
    await admin
      .from("sync_state")
      .update({ last_completed_at: new Date().toISOString() })
      .eq("id", "global");
  }
}
