// VENDORED from MiLeague app: src/lib/inhouse/engine/mmr.ts — DO NOT EDIT HERE.
// Pure, no imports. Resync = copy the app file over this one verbatim. The worker
// only uses teamWinProbability (matchmaking balance); the rest is kept verbatim so
// a resync is a clean file copy.
//
// Inhouse — hidden MMR (money-critical, pure). Glicko-2 (Glickman) on the
// standard scale (centered 1500, scale factor 173.7178). The rating measures
// skill and is never shown; the ranking points live separately (see points.ts).
//
// A rating period is a single inhouse match: the player is updated against the
// games they played in it (the caller builds `games` — e.g. one entry per enemy,
// or one vs the enemy-team average). With no games, only RD grows (uncertainty
// from inactivity).

export interface Rating {
  rating: number;
  rd: number;
  vol: number;
}

/** An opponent faced in the rating period, with the player's result against them. */
export interface GameResult {
  rating: number;
  rd: number;
  /** 1 win, 0.5 draw, 0 loss. */
  score: number;
}

const SCALE = 173.7178;
const DEFAULT_RATING = 1500;
const CONVERGENCE = 0.000001;

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expected(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Updated rating after a rating period. Follows Glickman's Glicko-2 steps,
 * including the volatility root-find via the Illinois (regula falsi) algorithm.
 */
export function glicko2Update(player: Rating, games: GameResult[], tau = 0.5): Rating {
  const mu = (player.rating - DEFAULT_RATING) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;

  // No games played: rating and volatility hold; RD grows toward uncertainty.
  if (games.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: player.rating, rd: phiStar * SCALE, vol: sigma };
  }

  // Step 3 (variance v) and the Step 4 improvement sum Σ g(φ_j)(s_j − E).
  let vInv = 0;
  let deltaSum = 0;
  for (const game of games) {
    const muJ = (game.rating - DEFAULT_RATING) / SCALE;
    const phiJ = game.rd / SCALE;
    const gJ = g(phiJ);
    const eJ = expected(mu, muJ, phiJ);
    vInv += gJ * gJ * eJ * (1 - eJ);
    deltaSum += gJ * (game.score - eJ);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: new volatility σ' by solving f(x) = 0 (Illinois algorithm).
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const d2 = delta * delta;
    const pv = phi * phi + v + ex;
    return (ex * (d2 - phi * phi - v - ex)) / (2 * pv * pv) - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k += 1;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaPrime = Math.exp(A / 2);

  // Step 6-8: fold volatility into RD, then update RD and rating.
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return {
    rating: muPrime * SCALE + DEFAULT_RATING,
    rd: phiPrime * SCALE,
    vol: sigmaPrime,
  };
}

/**
 * Probability the player (by rating) beats an opponent of the given rating. With
 * the opponent's RD omitted it's the plain logistic; pass RD to widen the curve.
 */
export function expectedScore(rating: number, opponentRating: number, opponentRd = 0): number {
  const mu = (rating - DEFAULT_RATING) / SCALE;
  const muJ = (opponentRating - DEFAULT_RATING) / SCALE;
  const phiJ = opponentRd / SCALE;
  return expected(mu, muJ, phiJ);
}

/** Pre-game win probability of a team vs the enemy team, from average ratings. */
export function teamWinProbability(allyAvgRating: number, enemyAvgRating: number): number {
  return expectedScore(allyAvgRating, enemyAvgRating);
}

// ── Seeding + per-match update ───────────────────────────────────────────────

const TIER_ORDER = [
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
];
const DIV_ORDER: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };
// Compressed so a one-tier gap is ~0.60-0.65 win prob on the Glicko scale — NOT
// the spec's +100/division, which through the 173.7178 factor would read ~91%.
const SEED_STEP = 24; // rating points per division (~96 per tier)
const SEED_CENTER_ORDINAL = 15; // ladder midpoint maps to DEFAULT_RATING (1500)
const CALIBRATION_MULTIPLIER = 3; // first calibration games move 3× (spec)

/**
 * Initial MMR seeded from the associated account's soloq rank. Unranked (or an
 * unknown tier) seeds at the ladder center (1500). Monotonic in rank.
 */
export function seedMmrFromRank(tier: string | null, rank: string | null): number {
  if (!tier) return DEFAULT_RATING;
  const t = TIER_ORDER.indexOf(tier.toUpperCase());
  if (t < 0) return DEFAULT_RATING;
  // Iron..Diamond have 4 divisions; Master/GM/Challenger are single (ordinals 28-30).
  const ordinal = t <= 6 ? t * 4 + (DIV_ORDER[(rank ?? "IV").toUpperCase()] ?? 0) : 28 + (t - 7);
  return Math.round(DEFAULT_RATING + (ordinal - SEED_CENTER_ORDINAL) * SEED_STEP);
}

/**
 * MMR after one inhouse match: a single Glicko-2 game against the enemy team's
 * AVERAGE rating (not five games vs each enemy — that collapses RD far too fast).
 * During calibration the rating movement is tripled.
 */
export function updateMatchMmr(
  player: Rating,
  enemyAvgRating: number,
  enemyAvgRd: number,
  won: boolean,
  calibrating: boolean,
  tau = 0.5,
): Rating {
  const updated = glicko2Update(player, [{ rating: enemyAvgRating, rd: enemyAvgRd, score: won ? 1 : 0 }], tau);
  if (!calibrating) return updated;
  const delta = updated.rating - player.rating;
  return { ...updated, rating: player.rating + delta * CALIBRATION_MULTIPLIER };
}
