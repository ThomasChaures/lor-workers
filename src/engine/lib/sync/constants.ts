// Worker override: the VPS worker paces itself PER-PLAYER (PLAYER_SYNC_COOLDOWN_MS
// in service.ts), so the global cooldown only needs to be short enough not to block
// back-to-back passes. The running-lock in claimSyncSlot still prevents overlap
// (incl. against the front's cron). The front keeps its own 5-min copy for the
// sync button. NOTE: sync/ is worker-owned after the getPlayersToTrack adaptation —
// do NOT re-vendor it from the front (only riot/, scoring/, types/ are re-vendorable).
export const SYNC_COOLDOWN_MS = 30 * 1000; // 30 seconds
export const SYNC_COOLDOWN_SECONDS = Math.ceil(SYNC_COOLDOWN_MS / 1000);

// A run is considered "running" only if it started within this window. Past it
// we assume the background run died (serverless kill / timeout past the 300s
// maxDuration) without stamping completion — so the UI self-heals instead of
// being stuck on "Sincronizando..." forever.
export const SYNC_STALE_MS = 6 * 60 * 1000; // 6 minutes (> maxDuration 300s)
