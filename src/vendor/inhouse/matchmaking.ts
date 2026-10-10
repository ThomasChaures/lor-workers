// VENDORED from MiLeague app: src/lib/inhouse/engine/matchmaking.ts — DO NOT EDIT HERE.
// Resync = copy the app file over this one, re-pointing the two imports below to
// the local vendored files (./constants.js, ./mmr.js).
//
// Inhouse — matchmaking balance (pure). Two concerns:
//   1. assignRoles: place 10 queued players into 2-per-lane, preferring primary →
//      secondary → fill (autofill), by the order they're given (caller sorts by
//      wait time so the longest-waiting get priority).
//   2. balanceCost / bestSplit: with roles fixed, pick the blue/red split with the
//      lowest cost. 2^5 = 32 splits (16 distinct); the balancer tries them all.
//
//   cost = |avgMMR_blue − avgMMR_red|
//        + 0.5 · Σ_lane |MMR_blue,lane − MMR_red,lane| · w      (w = 0.1)
//        + 30 · n_secondary + 60 · n_fill
//
// The per-lane term keeps individual lanes close even when the averages match;
// the last two terms penalize pulling players off their primary role.

import { INHOUSE_ROLES, type InhouseRole, type InhouseRolePreference, type InhouseAssignedBy, type InhouseSide } from "./constants.js";
import { teamWinProbability } from "./mmr.js";

export type Lane = InhouseRole;
export const LANES: readonly Lane[] = INHOUSE_ROLES;

const DEFAULT_LANE_WEIGHT = 0.1;
const SECONDARY_PENALTY = 30;
const FILL_PENALTY = 60;

export interface QueuePlayer {
  id: string;
  mmr: number;
  primary: InhouseRolePreference; // a lane or "fill"
  secondary: InhouseRolePreference | null;
}

export interface AssignedPlayer {
  id: string;
  mmr: number;
  lane: Lane;
  assignedBy: InhouseAssignedBy; // primary | secondary | fill
}

/**
 * Assign exactly 10 players to 2-per-lane. Greedy by input order: primary picks
 * first, then secondary, then anyone left is autofilled into an open lane.
 * Returns null if the count isn't 10 (coverage is otherwise guaranteed by fill).
 */
export function assignRoles(players: QueuePlayer[]): AssignedPlayer[] | null {
  if (players.length !== 10) return null;

  const slots = new Map<Lane, AssignedPlayer[]>(LANES.map((l) => [l, []]));
  const placed = new Set<string>();

  const place = (p: QueuePlayer, lane: Lane, assignedBy: InhouseAssignedBy) => {
    slots.get(lane)!.push({ id: p.id, mmr: p.mmr, lane, assignedBy });
    placed.add(p.id);
  };
  const isLane = (r: InhouseRolePreference | null): r is Lane => r !== null && r !== "fill";
  const open = (lane: Lane) => slots.get(lane)!.length < 2;

  // Pass 1: primary role.
  for (const p of players) {
    if (!placed.has(p.id) && isLane(p.primary) && open(p.primary)) place(p, p.primary, "primary");
  }
  // Pass 2: secondary role.
  for (const p of players) {
    if (!placed.has(p.id) && isLane(p.secondary) && open(p.secondary)) place(p, p.secondary, "secondary");
  }
  // Pass 3: autofill whoever's left into any open lane.
  for (const p of players) {
    if (placed.has(p.id)) continue;
    const lane = LANES.find(open);
    if (!lane) return null;
    place(p, lane, "fill");
  }

  if (!LANES.every((l) => slots.get(l)!.length === 2)) return null;
  return LANES.flatMap((l) => slots.get(l)!);
}

const mean = (team: AssignedPlayer[]) => team.reduce((s, p) => s + p.mmr, 0) / team.length;

/**
 * Balance cost of a blue/red split. Lower is more even. Blue and red each hold
 * one player per lane.
 */
export function balanceCost(blue: AssignedPlayer[], red: AssignedPlayer[], w = DEFAULT_LANE_WEIGHT): number {
  const avgGap = Math.abs(mean(blue) - mean(red));

  let laneGap = 0;
  for (const lane of LANES) {
    const b = blue.find((p) => p.lane === lane);
    const r = red.find((p) => p.lane === lane);
    if (b && r) laneGap += Math.abs(b.mmr - r.mmr);
  }

  const all = [...blue, ...red];
  const nSecondary = all.filter((p) => p.assignedBy === "secondary").length;
  const nFill = all.filter((p) => p.assignedBy === "fill").length;

  return avgGap + 0.5 * laneGap * w + SECONDARY_PENALTY * nSecondary + FILL_PENALTY * nFill;
}

/**
 * Lowest-cost blue/red split of 10 role-assigned players (2 per lane). Tries all
 * 32 side combinations and keeps the cheapest.
 */
export function bestSplit(
  assigned: AssignedPlayer[],
  w = DEFAULT_LANE_WEIGHT,
): { blue: AssignedPlayer[]; red: AssignedPlayer[]; cost: number } {
  const byLane = LANES.map((l) => assigned.filter((p) => p.lane === l));

  let best: { blue: AssignedPlayer[]; red: AssignedPlayer[]; cost: number } | null = null;
  for (let mask = 0; mask < 1 << LANES.length; mask++) {
    const blue: AssignedPlayer[] = [];
    const red: AssignedPlayer[] = [];
    for (let i = 0; i < LANES.length; i++) {
      const [p0, p1] = byLane[i];
      if ((mask >> i) & 1) {
        blue.push(p1);
        red.push(p0);
      } else {
        blue.push(p0);
        red.push(p1);
      }
    }
    const cost = balanceCost(blue, red, w);
    if (!best || cost < best.cost) best = { blue, red, cost };
  }
  return best!;
}

const BASE_TOLERANCE = 50;
const TOLERANCE_STEP = 25;
const TOLERANCE_INTERVAL_SECONDS = 120;

/**
 * Max acceptable balance cost given how long the front of the queue has waited.
 * Starts at 50 and grows 25 every 2 minutes (spec), so a match forms sooner the
 * longer people have been waiting.
 */
export function tolerance(waitSeconds: number): number {
  return BASE_TOLERANCE + TOLERANCE_STEP * Math.floor(Math.max(0, waitSeconds) / TOLERANCE_INTERVAL_SECONDS);
}

// --- formMatch: the whole formation decision, pure -------------------------

export interface QueueCandidate {
  playerId: string;
  mmr: number;
  primary: InhouseRolePreference;
  secondary: InhouseRolePreference | null;
  waitSeconds: number;
}

export interface FormedPlayer {
  playerId: string;
  side: InhouseSide; // blue | red
  role: Lane;
  assignedBy: InhouseAssignedBy;
  isCaptain: boolean;
  mmrBefore: number;
}

export interface FormedMatch {
  players: FormedPlayer[];
  /** Blue-side win probability at formation (red = 1 − this). */
  winProbability: number;
  balanceCost: number;
}

/**
 * Decide whether a match can form from the current queue. Takes the 10
 * longest-waiting candidates (FIFO), assigns roles, finds the cheapest split,
 * and forms only if the split's cost is within the wait-scaled tolerance of the
 * longest-waiting player. Returns null when it can't (too few, or still above
 * tolerance — they keep waiting and tolerance rises). Pure: no DB, no clock.
 */
export function formMatch(candidates: QueueCandidate[]): FormedMatch | null {
  if (candidates.length < 10) return null;

  // Longest wait first; the front of the queue gates tolerance.
  const ten = [...candidates].sort((a, b) => b.waitSeconds - a.waitSeconds).slice(0, 10);
  const maxWait = ten[0].waitSeconds;

  const assigned = assignRoles(
    ten.map((c) => ({ id: c.playerId, mmr: c.mmr, primary: c.primary, secondary: c.secondary })),
  );
  if (!assigned) return null;

  const { blue, red, cost } = bestSplit(assigned);
  if (cost > tolerance(maxWait)) return null;

  const build = (team: AssignedPlayer[], side: InhouseSide): FormedPlayer[] => {
    // Deterministic captain: highest MMR, ties broken by lowest id.
    const captainId = [...team].sort((a, b) => b.mmr - a.mmr || (a.id < b.id ? -1 : 1))[0].id;
    return team.map((p) => ({
      playerId: p.id,
      side,
      role: p.lane,
      assignedBy: p.assignedBy,
      isCaptain: p.id === captainId,
      mmrBefore: p.mmr,
    }));
  };

  return {
    players: [...build(blue, "blue"), ...build(red, "red")],
    winProbability: teamWinProbability(mean(blue), mean(red)),
    balanceCost: cost,
  };
}
