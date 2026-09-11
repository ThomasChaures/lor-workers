import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number, min = 0): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n); // floor guards against a fat-fingered 0 / negative
}

// Validated once at boot. If a required var is missing the worker fails fast
// (and PM2 shows it) instead of running blind against a half-configured env.
//
// The engine reads RIOT_REGION_ROUTING and RIOT_PLATFORM directly via process.env
// (in riot/constants.ts). We validate them here too so a bad config fails at boot
// with a clear message, not mid-sync. RIOT_REGION_ROUTING drives match fetching
// (matches are region-routed: "americas" for LATAM); RIOT_PLATFORM is only a
// fallback since sync passes each player's own platform.
export const env = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  riotApiKey: required("RIOT_API_KEY"),
  riotRegionRouting: required("RIOT_REGION_ROUTING"),
  // Fallback only — the sync path always passes each player's own platform, so a
  // missing RIOT_PLATFORM must not crash boot. BR=br1, LAN=la1, LAS=la2.
  riotPlatform: optional("RIOT_PLATFORM", "la2"),
  syncIntervalMs: optionalInt("SYNC_INTERVAL_MS", 60_000, 30_000),
  syncStaleMs: optionalInt("SYNC_STALE_MS", 360_000, 60_000),
  // Live-status worker (lor-live). Twitch creds are OPTIONAL here so the sync
  // worker still boots without them; the lor-live entrypoint fails fast if they
  // are missing. Kick needs no credentials (unofficial endpoint).
  liveIntervalMs: optionalInt("LIVE_INTERVAL_MS", 60_000, 30_000),
  twitchClientId: optional("TWITCH_CLIENT_ID", ""),
  twitchClientSecret: optional("TWITCH_CLIENT_SECRET", ""),
};
