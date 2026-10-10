import { env } from "../config/env.js";
import { createAdminClient } from "../config/supabase.js";
import { createLogger } from "../lib/logger.js";

// One Inhouse tick: fire the Next app's ready-check expiry, then the matchmaker.
// The logic lives in the app (single source of truth) — this worker just triggers
// it on a schedule, authenticated with the shared INHOUSE_CRON_SECRET.
//
// Everything is gated on an ACTIVE SEASON so the worker is effectively OFF when
// no Inhouse is running: no app calls, no app-side queries, no logs. The season
// check itself is one light query, cached for a couple of minutes, so even the
// idle poll barely touches Supabase (lesson from the sync-worker log overage).

const log = createLogger("lor-inhouse");
const supabase = createAdminClient();

const SEASON_CHECK_TTL_MS = 120_000;
let seasonCache: { checkedAt: number; active: boolean } | null = null;
let lastReported: boolean | null = null;

async function hasActiveSeason(): Promise<boolean> {
  const now = Date.now();
  if (seasonCache && now - seasonCache.checkedAt < SEASON_CHECK_TTL_MS) return seasonCache.active;

  const { data, error } = await supabase.from("inhouse_season").select("id").eq("status", "active").limit(1);
  // Fail CLOSED on a query error — a blip must not spin the app or log.
  const active = !error && (data?.length ?? 0) > 0;
  seasonCache = { checkedAt: now, active };

  if (lastReported !== active) {
    log.info(active ? "active season — driving crons" : "no active season — idle");
    lastReported = active;
  }
  return active;
}

async function callCron(path: string): Promise<void> {
  try {
    const res = await fetch(`${env.appBaseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.inhouseCronSecret}` },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      log.error(`${path} → HTTP ${res.status}`, JSON.stringify(body));
      return;
    }
    log.info(`${path} → ${JSON.stringify(body)}`);
  } catch (err) {
    // Never throw: a network blip must not kill the loop or skip the next call.
    log.error(`${path} failed`, err instanceof Error ? err.message : err);
  }
}

export async function inhouseCronTick(): Promise<void> {
  if (!(await hasActiveSeason())) return; // OFF when no Inhouse season is running

  // Expiry BEFORE the matchmaker: a just-failed ready-check is voided and its
  // acceptors are back in the queue in time for this tick to re-form them.
  await callCron("/api/cron/inhouse-ready-check-expiry");
  await callCron("/api/cron/inhouse-matchmaker");
}
