import type { SupabaseClient } from "@supabase/supabase-js";
import { formMatch, type QueueCandidate } from "../vendor/inhouse/matchmaking.js";
import { resolveMvp } from "../vendor/inhouse/mvp.js";
import {
  INHOUSE_READY_CHECK_TIMEOUT_SECONDS,
  INHOUSE_MVP_VOTE_TIMEOUT_SECONDS,
  INHOUSE_LOBBY_TIMEOUT_SECONDS,
  type InhouseRolePreference,
} from "../vendor/inhouse/constants.js";

// Inhouse cron engine, run IN the worker against the shared DB (service role).
// Ported from the app's src/lib/inhouse/{matchmaker,match}.ts: the app still runs
// these on events (a tick on join, sweeps opportunistically on reads); the worker
// is the periodic heartbeat so matches form as tolerance rises for waiting players
// and abandoned matches get voided when nobody is interacting. The DECISIONS stay
// pure (formMatch, resolveMvp — vendored); the money mutations are the same
// advisory-locked, idempotent RPCs. No HTTP hop to the app.

// ── Active season ────────────────────────────────────────────────────────────

/** Id of the single active season, or null. Fails CLOSED (null) on a query error. */
export async function getActiveSeasonId(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin
    .from("inhouse_season")
    .select("id")
    .eq("status", "active")
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.id as string;
}

// ── Matchmaker ─────────────────────────────────────────────────────────────

type QueueEntryRow = {
  player_id: string;
  primary_role: string;
  secondary_role: string | null;
  joined_at: string;
};

/**
 * Attempt to form one match from the current 'mid' queue. Returns the new match
 * id if one formed, or null (too few queued, still above tolerance, missing
 * ratings, or a lost commit race). Never throws on the normal no-op paths.
 */
export async function runMatchmakerTick(admin: SupabaseClient, seasonId: string): Promise<string | null> {
  const { data: entries } = await admin
    .from("inhouse_queue_entry")
    .select("player_id, primary_role, secondary_role, joined_at")
    .eq("division", "mid")
    .order("joined_at", { ascending: true });

  const rows = (entries ?? []) as QueueEntryRow[];
  if (rows.length < 10) return null;

  // Hidden MMR for the queued players (seeded at join; service-role read).
  const ids = rows.map((r) => r.player_id);
  const { data: ratings } = await admin.from("inhouse_player_rating").select("player_id, mmr").in("player_id", ids);
  const mmrOf = new Map((ratings ?? []).map((r) => [r.player_id as string, r.mmr as number]));

  const now = Date.now();
  const candidates: QueueCandidate[] = rows
    .filter((r) => mmrOf.has(r.player_id)) // no rating → can't balance; skip until seeded
    .map((r) => ({
      playerId: r.player_id,
      mmr: mmrOf.get(r.player_id)!,
      primary: r.primary_role as InhouseRolePreference,
      secondary: (r.secondary_role as InhouseRolePreference | null) ?? null,
      waitSeconds: Math.max(0, Math.floor((now - new Date(r.joined_at).getTime()) / 1000)),
    }));

  const formed = formMatch(candidates);
  if (!formed) return null;

  const { data: matchId, error } = await admin.rpc("inhouse_commit_match", {
    p_season: seasonId,
    p_division: "mid",
    p_win_probability: formed.winProbability,
    p_balance_cost: formed.balanceCost,
    p_players: formed.players.map((p) => ({
      player_id: p.playerId,
      side: p.side,
      role: p.role,
      assigned_by: p.assignedBy,
      is_captain: p.isCaptain,
    })),
  });

  if (error) {
    console.error("[inhouse matchmaker] commit failed", error);
    return null;
  }
  return (matchId as string | null) ?? null;
}

const MAX_FORMATIONS_PER_RUN = 10; // drain backlog without unbounded looping

/** Form as many matches as the queue allows this tick (bounded). Returns the count. */
export async function drainMatchmaker(admin: SupabaseClient, seasonId: string): Promise<number> {
  let formed = 0;
  for (let i = 0; i < MAX_FORMATIONS_PER_RUN; i++) {
    const matchId = await runMatchmakerTick(admin, seasonId);
    if (!matchId) break;
    formed += 1;
  }
  return formed;
}

// ── Sweeps ───────────────────────────────────────────────────────────────────

/** Void every stale ready-check (failed check → dodge + re-queue). Returns how many voided. */
export async function sweepExpiredReadyChecks(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - INHOUSE_READY_CHECK_TIMEOUT_SECONDS * 1000).toISOString();
  const { data } = await admin
    .from("inhouse_match")
    .select("id")
    .eq("status", "ready_check")
    .lt("created_at", cutoff);

  let voided = 0;
  for (const m of (data ?? []) as { id: string }[]) {
    const { data: res } = await admin.rpc("inhouse_expire_ready_check", {
      p_match_id: m.id,
      p_timeout_seconds: INHOUSE_READY_CHECK_TIMEOUT_SECONDS,
    });
    if (res === "expired") voided += 1;
  }
  return voided;
}

/** Void every stale lobby (host never started). Returns how many voided. */
export async function sweepStaleLobbies(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - INHOUSE_LOBBY_TIMEOUT_SECONDS * 1000).toISOString();
  const { data } = await admin.from("inhouse_match").select("id").eq("status", "lobby").lt("created_at", cutoff);
  let voided = 0;
  for (const m of (data ?? []) as { id: string }[]) {
    const { data: res } = await admin.rpc("inhouse_expire_stale_lobby", {
      p_match_id: m.id,
      p_timeout_seconds: INHOUSE_LOBBY_TIMEOUT_SECONDS,
    });
    if (res === "expired") voided += 1;
  }
  return voided;
}

/** Resolve a finished match's MVP from whatever votes exist (winner → award; none → just close). */
async function resolveMvpTimeout(admin: SupabaseClient, matchId: string): Promise<void> {
  const { data: votes } = await admin.from("inhouse_mvp_vote").select("voted_player_id").eq("match_id", matchId);
  const winner = resolveMvp((votes ?? []).map((v) => ({ votedPlayerId: v.voted_player_id as string })));
  if (winner) await admin.rpc("inhouse_award_mvp", { p_match_id: matchId, p_player: winner });
  // ALWAYS close the voting window — the award RPC returns early WITHOUT stamping
  // mvp_resolved_at when the MVP was already awarded (a pre-timeout vote, or a
  // pre-5.2 award). Without this the sweep re-processes the match every tick.
  await admin.from("inhouse_match").update({ mvp_resolved_at: new Date().toISOString() }).eq("id", matchId).is("mvp_resolved_at", null);
}

/** Resolve every finished match past its MVP voting window. Returns how many closed. */
export async function sweepMvpTimeouts(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - INHOUSE_MVP_VOTE_TIMEOUT_SECONDS * 1000).toISOString();
  const { data } = await admin
    .from("inhouse_match")
    .select("id")
    .eq("status", "finished")
    .is("mvp_resolved_at", null)
    .lt("ended_at", cutoff);

  const rows = (data ?? []) as { id: string }[];
  for (const m of rows) await resolveMvpTimeout(admin, m.id);
  return rows.length;
}
