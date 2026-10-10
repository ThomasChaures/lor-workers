import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

// One Inhouse tick: fire the Next app's ready-check expiry, then the matchmaker.
// The logic lives in the app (single source of truth) — this worker just triggers
// it on a schedule, authenticated with the shared INHOUSE_CRON_SECRET.
//
// Expiry runs BEFORE the matchmaker so any ready-check that just failed is voided
// and its acceptors are back in the queue in time for this tick to re-form them.

const log = createLogger("lor-inhouse");

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
  await callCron("/api/cron/inhouse-ready-check-expiry");
  await callCron("/api/cron/inhouse-matchmaker");
}
