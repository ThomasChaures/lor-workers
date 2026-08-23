import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Validated once at boot. If a required var is missing the worker fails fast
// (and PM2 shows it) instead of running blind against a half-configured env.
export const env = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  riotApiKey: required("RIOT_API_KEY"),
  syncIntervalMs: optionalInt("SYNC_INTERVAL_MS", 120_000),
  syncStaleMs: optionalInt("SYNC_STALE_MS", 360_000),
};
