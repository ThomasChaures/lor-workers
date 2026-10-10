// VENDORED from MiLeague app: src/lib/inhouse/constants.ts — DO NOT EDIT HERE.
// Engine-relevant subset (dropped the Spanish UI labels + inhouseDayStartISO the
// worker doesn't need). Keep the kept values in sync with the app. Vendored so the
// Inhouse cron runs the matchmaker/sweeps directly against the shared DB, with no
// HTTP hop to the app (same pattern as the sync engine).

export const INHOUSE_DIVISIONS = ["low", "mid", "high"] as const;
export type InhouseDivision = (typeof INHOUSE_DIVISIONS)[number];

// Actual lanes a player is assigned to in a match.
export const INHOUSE_ROLES = ["top", "jungle", "mid", "adc", "support"] as const;
export type InhouseRole = (typeof INHOUSE_ROLES)[number];

// Role preferences a player can pick in the queue — lanes plus "fill".
export const INHOUSE_ROLE_PREFERENCES = [...INHOUSE_ROLES, "fill"] as const;
export type InhouseRolePreference = (typeof INHOUSE_ROLE_PREFERENCES)[number];

export const INHOUSE_SIDES = ["blue", "red"] as const;
export type InhouseSide = (typeof INHOUSE_SIDES)[number];

export const INHOUSE_ASSIGNED_BY = ["primary", "secondary", "fill"] as const;
export type InhouseAssignedBy = (typeof INHOUSE_ASSIGNED_BY)[number];

export const INHOUSE_MATCH_STATUSES = [
  "ready_check",
  "lobby",
  "in_game",
  "reporting",
  "disputed",
  "finished",
  "voided",
] as const;
export type InhouseMatchStatus = (typeof INHOUSE_MATCH_STATUSES)[number];

export const INHOUSE_SEASON_STATUSES = ["active", "frozen", "closed"] as const;
export type InhouseSeasonStatus = (typeof INHOUSE_SEASON_STATUSES)[number];

// A player in any of these is "in a match" — can't re-queue, and the Jugar poll
// treats this as "match found". Defined once so the join guard and the
// active-match signal can never drift apart. 'finished'/'voided' are terminal.
export const INHOUSE_NON_TERMINAL_STATUSES = [
  "ready_check",
  "lobby",
  "in_game",
  "reporting",
  "disputed",
] as const;

export const INHOUSE_LEDGER_REASONS = [
  "win",
  "loss",
  "mvp",
  "dodge",
  "afk",
  "false_report",
  "correction",
] as const;
export type InhouseLedgerReason = (typeof INHOUSE_LEDGER_REASONS)[number];

// ---- Scoring / ranking rules (spec) ----

/** Everyone starts each season at this many points; points = this + SUM(ledger.delta). */
export const INHOUSE_STARTING_POINTS = 1000;
/** Minimum games to appear in the ranking table. */
export const INHOUSE_MIN_GAMES_RANKING = 5;
/** Minimum games to be eligible for the monthly prize. */
export const INHOUSE_MIN_GAMES_PRIZE = 20;
/** Scoreable matches per day, to curb farming. */
export const INHOUSE_DAILY_SCOREABLE_CAP = 15;

/** Seconds a formed match waits in ready-check before a failed check voids it (dodge). */
export const INHOUSE_READY_CHECK_TIMEOUT_SECONDS = 90;
/** Seconds after a match finishes before the MVP vote is resolved with whatever votes exist. */
export const INHOUSE_MVP_VOTE_TIMEOUT_SECONDS = 120;
/** Seconds a match may sit in 'lobby' (host hasn't started) before it's auto-voided. */
export const INHOUSE_LOBBY_TIMEOUT_SECONDS = 1200; // 20 min
