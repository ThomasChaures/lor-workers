// Global cooldown between manual syncs. Shared by the API route (enforcement)
// and the sync button (countdown display) so they never drift.
export const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const SYNC_COOLDOWN_SECONDS = Math.ceil(SYNC_COOLDOWN_MS / 1000);

// A run is considered "running" only if it started within this window. Past it
// we assume the background run died (serverless kill / timeout past the 300s
// maxDuration) without stamping completion — so the UI self-heals instead of
// being stuck on "Sincronizando..." forever.
export const SYNC_STALE_MS = 6 * 60 * 1000; // 6 minutes (> maxDuration 300s)
