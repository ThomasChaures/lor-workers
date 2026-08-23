import type { ScoringConfig, ScoringRule, TeamPosition } from "@/types/database";

export interface ParticipantStats {
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalDamageDealtToChampions: number;
  goldEarned: number;
  visionScore: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  doubleKills: number;
  tripleKills: number;
  quadraKills: number;
  pentaKills: number;
  turretKills: number;
  firstBloodKill: boolean;
  damageDealtToObjectives: number;
  damageSelfMitigated: number;
  wardsPlaced: number;
  wardsKilled: number;
  timeCcingOthers: number;
  gameDurationSeconds: number;
  teamPosition: TeamPosition | string;
  teamTotalKills: number;
  // Objective participation (from timeline events)
  dragonKills: number;
  baronKills: number;
  heraldKills: number;
}

interface ScoringResult {
  points: number;
  breakdown: Record<string, number>;
}

function computeStat(stat: ScoringRule["stat"], s: ParticipantStats): number {
  const durationMin = Math.max(s.gameDurationSeconds / 60, 1);

  switch (stat) {
    case "kda_ratio":
      return (s.kills + s.assists) / Math.max(s.deaths, 1);
    case "kills":
      return s.kills;
    case "deaths":
      return s.deaths;
    case "assists":
      return s.assists;
    case "cs_per_min":
      return (s.totalMinionsKilled + s.neutralMinionsKilled) / durationMin;
    case "vision_score":
      return s.visionScore;
    case "damage_per_min":
      return s.totalDamageDealtToChampions / durationMin;
    case "gold_per_min":
      return s.goldEarned / durationMin;
    case "double_kills":
      return s.doubleKills;
    case "triple_kills":
      return s.tripleKills;
    case "quadra_kills":
      return s.quadraKills;
    case "penta_kills":
      return s.pentaKills;
    case "turret_kills":
      return s.turretKills;
    case "first_blood":
      return s.firstBloodKill ? 1 : 0;
    case "objective_damage_per_min":
      return s.damageDealtToObjectives / durationMin;
    case "damage_mitigated_per_min":
      return s.damageSelfMitigated / durationMin;
    case "wards_placed":
      return s.wardsPlaced;
    case "wards_killed":
      return s.wardsKilled;
    case "cc_time":
      return s.timeCcingOthers;
    case "kill_participation":
      return s.teamTotalKills > 0 ? ((s.kills + s.assists) / s.teamTotalKills) * 100 : 0;
    case "dragon_kills":
      return s.dragonKills;
    case "baron_kills":
      return s.baronKills;
    case "herald_kills":
      return s.heraldKills;
    default:
      return 0;
  }
}

const BOOLEAN_STATS = new Set(["first_blood"]);

function evaluateCondition(op: ScoringRule["op"], actual: number, target: number): boolean {
  switch (op) {
    case "gte": return actual >= target;
    case "gt":  return actual > target;
    case "lte": return actual <= target;
    case "lt":  return actual < target;
    case "eq":  return actual === target;
    default:    return false;
  }
}

// Get streak bonus for a given consecutive win count
function getStreakBonus(config: ScoringConfig, consecutiveWins: number): number {
  const bonuses = config.streak_bonuses;
  if (!bonuses || bonuses.length === 0 || consecutiveWins < 2) return 0;

  // Sort descending by streak threshold
  const sorted = [...bonuses].sort((a, b) => b.streak - a.streak);
  for (const b of sorted) {
    if (consecutiveWins >= b.streak) return b.points;
  }
  return 0;
}

export function calculatePoints(config: ScoringConfig, stats: ParticipantStats, consecutiveWins?: number): ScoringResult {
  const breakdown: Record<string, number> = {};

  const base = stats.win ? config.base_win : config.base_loss;
  breakdown["base"] = base;

  // Per stat: only the highest matching rule applies (no stacking)
  const bestPerStat = new Map<string, { points: number; label: string }>();

  for (const rule of config.rules) {
    if (rule.excludePositions && rule.excludePositions.length > 0) {
      if (rule.excludePositions.includes(stats.teamPosition as TeamPosition)) continue;
    }

    // Boolean stats: check directly, ignore op/value
    if (BOOLEAN_STATS.has(rule.stat)) {
      const val = computeStat(rule.stat, stats);
      if (val !== 1) continue;
    } else {
      const actual = computeStat(rule.stat, stats);
      if (!evaluateCondition(rule.op, actual, rule.value)) continue;
    }

    const statKey = rule.stat;
    const existing = bestPerStat.get(statKey);
    if (!existing || Math.abs(rule.points) > Math.abs(existing.points)) {
      bestPerStat.set(statKey, {
        points: rule.points,
        label: `${rule.stat}_${rule.op}_${rule.value}`,
      });
    }
  }

  for (const { points, label } of bestPerStat.values()) {
    breakdown[label] = points;
  }

  // Streak bonus
  if (stats.win && consecutiveWins !== undefined && consecutiveWins >= 2) {
    const streakBonus = getStreakBonus(config, consecutiveWins);
    if (streakBonus > 0) {
      breakdown[`racha_${consecutiveWins}`] = streakBonus;
    }
  }

  const points = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

  return {
    points: Math.round(points * 100) / 100,
    breakdown,
  };
}
