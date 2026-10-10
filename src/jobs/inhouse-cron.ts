import { createAdminClient } from "../config/supabase.js";
import { createLogger } from "../lib/logger.js";
import {
  getActiveSeasonId,
  drainMatchmaker,
  sweepExpiredReadyChecks,
  sweepStaleLobbies,
  sweepMvpTimeouts,
} from "./inhouse-engine.js";

// One Inhouse tick, run ENTIRELY in the worker against the shared DB (service
// role). No HTTP to the app: the app's user-auth middleware would redirect these
// machine calls to /login (307 → 405), and more importantly the logic has no
// business being reachable through the user-facing app. The app still fires the
// same engine on events (a tick on join, sweeps on reads); this is the heartbeat.
//
// Everything is gated on an ACTIVE SEASON so the worker is effectively OFF when no
// Inhouse is running: the season check is one light query, cached for a couple of
// minutes, so even the idle poll barely touches Supabase (sync-worker log lesson).

const log = createLogger("lor-inhouse");
const supabase = createAdminClient();

const SEASON_CHECK_TTL_MS = 120_000;
let seasonCache: { checkedAt: number; seasonId: string | null } | null = null;
let lastReported: boolean | null = null;

async function activeSeasonId(): Promise<string | null> {
  const now = Date.now();
  if (seasonCache && now - seasonCache.checkedAt < SEASON_CHECK_TTL_MS) return seasonCache.seasonId;

  const seasonId = await getActiveSeasonId(supabase); // fails closed (null) on error
  seasonCache = { checkedAt: now, seasonId };

  const active = seasonId !== null;
  if (lastReported !== active) {
    log.info(active ? "active season — driving crons" : "no active season — idle");
    lastReported = active;
  }
  return seasonId;
}

async function runSweep(label: string, fn: () => Promise<number>): Promise<number | "error"> {
  try {
    return await fn();
  } catch (err) {
    // One failing sweep must not abort the others or be swallowed (observability).
    log.error(`${label} sweep failed`, err instanceof Error ? err.message : err);
    return "error";
  }
}

export async function inhouseCronTick(): Promise<void> {
  const seasonId = await activeSeasonId();
  if (!seasonId) return; // OFF when no Inhouse season is running

  // Expiry BEFORE the matchmaker: a just-failed ready-check is voided and its
  // acceptors are back in the queue in time for this tick to re-form them.
  const voided = await runSweep("ready-check", () => sweepExpiredReadyChecks(supabase));
  const lobbiesVoided = await runSweep("lobby", () => sweepStaleLobbies(supabase));
  const mvpResolved = await runSweep("mvp", () => sweepMvpTimeouts(supabase));

  let formed: number | "error" = "error";
  try {
    formed = await drainMatchmaker(supabase, seasonId);
  } catch (err) {
    log.error("matchmaker failed", err instanceof Error ? err.message : err);
  }

  if ([voided, lobbiesVoided, mvpResolved, formed].some((n) => n !== 0 && n !== "error")) {
    log.info(`tick: formed=${formed} ready=${voided} lobby=${lobbiesVoided} mvp=${mvpResolved}`);
  }
}
