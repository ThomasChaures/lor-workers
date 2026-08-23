// ============================================================
// Database types — mirrors the SQL schema
// ============================================================

export type ProfileRole = "super_admin" | "liguer" | "member";

export interface Profile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  role: ProfileRole;
  riot_puuid: string | null;
  riot_game_name: string | null;
  riot_tag_line: string | null;
  riot_platform: string;
  riot_region_routing: string;
  riot_tier: string | null;
  riot_rank: string | null;
  riot_league_points: number | null;
  riot_last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Scoring Config
// ============================================================

export type ScoringOperator = "gte" | "lte" | "eq" | "gt" | "lt";

export type ScoringStat =
  | "kda_ratio"
  | "kills"
  | "deaths"
  | "assists"
  | "cs_per_min"
  | "vision_score"
  | "damage_per_min"
  | "gold_per_min"
  | "double_kills"
  | "triple_kills"
  | "quadra_kills"
  | "penta_kills"
  | "turret_kills"
  | "first_blood"
  | "objective_damage_per_min"
  | "damage_mitigated_per_min"
  | "wards_placed"
  | "wards_killed"
  | "cc_time"
  | "kill_participation"
  | "dragon_kills"
  | "baron_kills"
  | "herald_kills";

export type TeamPosition = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";

export interface ScoringRule {
  stat: ScoringStat;
  op: ScoringOperator;
  value: number;
  points: number;
  excludePositions?: TeamPosition[];
}

export interface StreakBonus {
  streak: number; // consecutive wins needed
  points: number; // bonus per match while on this streak
}

export interface ScoringConfig {
  base_win: number;
  base_loss: number;
  rules: ScoringRule[];
  streak_bonuses?: StreakBonus[];
}

// ============================================================
// League
// ============================================================

export interface League {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  invite_code: string;
  is_active: boolean;
  starts_at: string;
  ends_at: string;
  scoring_config: ScoringConfig;
  created_at: string;
  updated_at: string;
}

export type LeagueMemberRole = "owner" | "member";

export interface LeagueMember {
  id: string;
  league_id: string;
  profile_id: string;
  role: LeagueMemberRole;
  joined_at: string;
}

// ============================================================
// Matches
// ============================================================

export interface Match {
  id: string;
  riot_match_id: string;
  queue_id: number;
  game_duration: number;
  game_end_at: string;
  created_at: string;
}

export interface MatchParticipant {
  id: string;
  match_id: string;
  profile_id: string;
  champion_name: string;
  champion_id: number;
  team_position: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  total_damage_dealt_to_champions: number;
  gold_earned: number;
  vision_score: number;
  total_minions_killed: number;
  neutral_minions_killed: number;
  created_at: string;
}

// ============================================================
// League Points
// ============================================================

export interface PointBreakdown {
  base: number;
  [rule: string]: number;
}

export interface LeagueMatchPoints {
  id: string;
  league_id: string;
  match_participant_id: string;
  profile_id: string;
  points: number;
  breakdown: PointBreakdown;
  created_at: string;
}
