import { createLogger } from "../lib/logger.js";
import { createAdminClient } from "../config/supabase.js";
import { getLiveTwitchLogins } from "../lib/twitch.js";
import { getLiveKickStatus } from "../lib/kick.js";

const log = createLogger("poll-live");

type Row = {
  id: string;
  twitch_username: string | null;
  kick_username: string | null;
  live_platform: string | null;
};

// One live-status tick. Loads every profile that linked a channel, asks Twitch
// (batched) and Kick (1x1) who is live, and writes ONLY the delta vs the state
// already in the DB. The front never calls these APIs — it just reads
// live_platform / live_checked_at. Design lives in docs/live-status.md (MiLeague).
//
// Failure semantics (critical): a FAILED check is not an offline signal. We
// clear a live badge only on a TRUSTWORTHY not-live answer from the same
// platform the row was recorded live on. On any error we leave the row untouched
// and let the front's 4-minute staleness guard age it out if the outage lasts —
// otherwise a single Cloudflare block would flicker the badge off and on.
export async function pollLiveTick(): Promise<void> {
  const admin = createAdminClient();

  // Paginate — PostgREST silently caps a SELECT at 1000 rows, so a plain query
  // would stop polling everyone past the 1000th linked user with no error. (This
  // repo has been bitten by that cap twice; see the MiLeague leaderboard fixes.)
  const PAGE = 1000;
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("profiles")
      .select("id, twitch_username, kick_username, live_platform")
      .or("twitch_username.not.is.null,kick_username.not.is.null")
      .range(from, from + PAGE - 1);
    if (error) {
      log.error("failed to load linked profiles", error.message);
      return;
    }
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (rows.length === 0) {
    log.info("no linked profiles");
    return;
  }

  const twitchLogins = rows.map((r) => r.twitch_username).filter((v): v is string => !!v);
  const kickSlugs = rows.map((r) => r.kick_username).filter((v): v is string => !!v);

  // Query each platform in isolation. `twitchOk`/`kickStatus` capture whether we
  // can TRUST an offline determination this tick: if the Twitch batch threw we
  // trust nothing from Twitch; Kick reports per-channel, so a slug missing from
  // the map is "unknown", not "offline".
  let twitchOk = true;
  let twitchLive = new Set<string>();
  if (twitchLogins.length) {
    try {
      twitchLive = await getLiveTwitchLogins(twitchLogins);
    } catch (e) {
      twitchOk = false;
      log.error("twitch poll failed — leaving twitch rows untouched", e instanceof Error ? e.message : e);
    }
  }
  const kickStatus = kickSlugs.length
    ? await getLiveKickStatus(kickSlugs).catch((e) => {
        log.error("kick poll failed", e instanceof Error ? e.message : e);
        return new Map<string, "live" | "offline">();
      })
    : new Map<string, "live" | "offline">();

  // Twitch wins when live on both — the UI shows a single "LIVE" badge, so the
  // stored platform is bookkeeping only.
  const twitchIds: string[] = [];
  const kickIds: string[] = [];
  const offlineIds: string[] = [];
  for (const r of rows) {
    const tName = r.twitch_username?.toLowerCase();
    const kName = r.kick_username?.toLowerCase();

    if (tName && twitchLive.has(tName)) {
      twitchIds.push(r.id);
      continue;
    }
    if (kName && kickStatus.get(kName) === "live") {
      kickIds.push(r.id);
      continue;
    }

    // Not observed live this tick. Only clear an already-live row when we have a
    // trustworthy not-live answer from the platform it was recorded live on.
    if (r.live_platform === null) continue; // already offline — nothing to do
    const confirmedOffline =
      (r.live_platform === "twitch" && twitchOk) ||
      (r.live_platform === "kick" && kName != null && kickStatus.get(kName) === "offline");
    if (confirmedOffline) offlineIds.push(r.id);
    // else: check failed for that platform → leave as-is; staleness ages it out.
  }

  const nowIso = new Date().toISOString();

  // Live rows: refresh platform + checked_at EVERY tick so the front's staleness
  // guard (4 min) stays green while they stream. Offline-stable rows are left
  // untouched — a null live_platform reads as "not live" regardless of the stamp,
  // so only the ones we confirmed ended their stream get cleared.
  const writes: PromiseLike<{ error: { message: string } | null }>[] = [];
  if (twitchIds.length)
    writes.push(admin.from("profiles").update({ live_platform: "twitch", live_checked_at: nowIso }).in("id", twitchIds));
  if (kickIds.length)
    writes.push(admin.from("profiles").update({ live_platform: "kick", live_checked_at: nowIso }).in("id", kickIds));
  if (offlineIds.length)
    writes.push(admin.from("profiles").update({ live_platform: null, live_checked_at: null }).in("id", offlineIds));

  const results = await Promise.all(writes);
  for (const res of results) {
    if (res.error) log.error("write failed", res.error.message);
  }

  const kickErrors = new Set(kickSlugs.map((s) => s.toLowerCase())).size - kickStatus.size;
  log.info(
    `live: ${twitchIds.length} twitch, ${kickIds.length} kick; ` +
      `${offlineIds.length} went offline (of ${rows.length} linked)` +
      (twitchOk ? "" : "; twitch check FAILED") +
      (kickErrors > 0 ? `; ${kickErrors} kick unchecked` : "")
  );
}
