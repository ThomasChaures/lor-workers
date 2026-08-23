import { SupabaseClient } from "@supabase/supabase-js";
import {
  getMatchIdsByPuuid,
  getMatchById,
  getMatchTimeline,
  getRankedEntriesByPuuid,
  getSummonerByPuuid,
} from "@/lib/riot/client";
import { QUEUE_IDS, profileIconUrl } from "@/lib/riot/constants";
import { calculatePoints } from "@/lib/scoring/engine";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ScoringConfig } from "@/types/database";

export interface ObjectiveStats {
  dragonKills: number;
  baronKills: number;
  heraldKills: number;
}

interface MatchEvent {
  type: string;
  monsterType?: string;
  teamId?: number;
}

function extractObjectiveStats(events: MatchEvent[] | null, playerTeamId: number): ObjectiveStats {
  const stats: ObjectiveStats = { dragonKills: 0, baronKills: 0, heraldKills: 0 };
  if (!events) return stats;

  for (const e of events) {
    if (e.type !== "ELITE_MONSTER_KILL" || e.teamId !== playerTeamId) continue;
    switch (e.monsterType) {
      case "DRAGON": stats.dragonKills++; break;
      case "BARON_NASHOR": stats.baronKills++; break;
      case "RIFTHERALD": stats.heraldKills++; break;
    }
  }
  return stats;
}

export interface SyncProgress {
  membersProcessed: number;
  membersTotal: number;
  matchesFetched: number;
  matchesSkipped: number;
  matchesOutOfRange: number;
  pointsCalculated: number;
  errors: string[];
}

interface LeagueInfo {
  leagueId: string;
  type: string; // soloq | duoq | team
  teamId: string | null; // for team leagues
  duoPartnerPuuid: string | null; // for duoq leagues
  scoringConfig: ScoringConfig;
  startsAt: string; // ISO — only matches AFTER this count
  endsAt: string;   // ISO — only matches BEFORE this count
  joinedAt: string; // ISO — only matches AFTER the member joined
}

function getQueueForLeagueType(type: string): number {
  return type === "team" ? QUEUE_IDS.RANKED_FLEX : QUEUE_IDS.RANKED_SOLO_DUO;
}

// How far back to fetch matches for players NOT in any active league. Bounds the
// first-time Riot pull for a leagueless player so we don't drag their whole
// history. Players in a league use their earliest league start instead.
const TRACK_LOOKBACK_DAYS = 14;

// Per-player cooldown: a player synced within this window is skipped this pass,
// so the worker never re-hits Riot for the same player too often — it spreads
// load across the whole tracked-player set. Read from env (engine convention),
// default 3 min. `riot_last_synced_at` is stamped at the end of each player's sync.
const PLAYER_SYNC_COOLDOWN_MS = Number(process.env.PLAYER_SYNC_COOLDOWN_MS) || 3 * 60 * 1000;

interface PlayerToTrack {
  profileId: string;
  riotPuuid: string;
  riotGameName: string;
  riotPlatform: string;
  leagues: LeagueInfo[]; // may be empty — leagueless players are still tracked
  earliestLeagueStart: number; // epoch seconds — for Riot API startTime
}

// Group every ACTIVE, started, non-duel league membership by profile, so we know
// which players get scored and with what config. Leagueless players simply won't
// appear here — they're still tracked (below), just not scored.
async function getActiveLeaguesByProfile(
  supabase: SupabaseClient
): Promise<Map<string, LeagueInfo[]>> {
  const byProfile = new Map<string, LeagueInfo[]>();

  const { data: members, error } = await supabase
    .from("league_members")
    .select(`
      profile_id,
      league_id,
      team_id,
      partner_id,
      joined_at,
      leagues:league_id(id, type, scoring_config, is_active, starts_at, ends_at, is_duel),
      partner:partner_id(profile_id, profiles:profile_id(riot_puuid))
    `)
    .order("profile_id");

  if (error || !members) {
    console.error("Error fetching league memberships:", error);
    return byProfile;
  }

  const now = Date.now();
  for (const m of members) {
    const league = m.leagues as unknown as {
      id: string;
      type: string;
      scoring_config: ScoringConfig;
      is_active: boolean;
      starts_at: string;
      ends_at: string;
      is_duel: boolean;
    };

    // Skip leagues that haven't started yet — their matches would be out of
    // range and score nothing. We intentionally do NOT filter on ends_at: ended
    // leagues are already excluded by is_active=false (deactivated at the start
    // of the sync). A null starts_at means no lower bound (dateless leagues
    // aren't excluded). Duels (is_duel) are a removed feature — never sync them.
    const startMs = league?.starts_at ? new Date(league.starts_at).getTime() : Number.NEGATIVE_INFINITY;
    const started = startMs <= now;
    if (!league?.is_active || !started || league?.is_duel) continue;

    // Resolve duo partner puuid if duoq league
    const partnerData = (m as unknown as { partner: { profiles: { riot_puuid: string } } | null }).partner;
    const duoPartnerPuuid = partnerData?.profiles?.riot_puuid ?? null;

    const leagueInfo: LeagueInfo = {
      leagueId: league.id,
      type: league.type,
      teamId: (m as unknown as { team_id: string | null }).team_id,
      duoPartnerPuuid,
      scoringConfig: league.scoring_config,
      startsAt: league.starts_at,
      endsAt: league.ends_at,
      joinedAt: (m as unknown as { joined_at: string }).joined_at,
    };

    const arr = byProfile.get(m.profile_id);
    if (arr) arr.push(leagueInfo);
    else byProfile.set(m.profile_id, [leagueInfo]);
  }

  return byProfile;
}

// Every player with a linked Riot account is tracked — league or not. This is the
// worker model: keep ALL players' match history fresh; scoring only happens for
// those in an active league.
async function getPlayersToTrack(supabase: SupabaseClient): Promise<PlayerToTrack[]> {
  // Per-player cooldown: only players never synced (null) or last synced before
  // the cutoff are due this pass. This is what paces the worker per-player.
  const cooldownCutoff = new Date(Date.now() - PLAYER_SYNC_COOLDOWN_MS).toISOString();
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, riot_puuid, riot_game_name, riot_platform")
    .not("riot_puuid", "is", null)
    .or(`riot_last_synced_at.is.null,riot_last_synced_at.lt.${cooldownCutoff}`);

  if (error || !profiles) {
    console.error("Error fetching profiles to track:", error);
    return [];
  }

  const leaguesByProfile = await getActiveLeaguesByProfile(supabase);

  const nowSec = Math.floor(Date.now() / 1000);
  const lookbackStart = nowSec - TRACK_LOOKBACK_DAYS * 24 * 60 * 60;

  const players: PlayerToTrack[] = [];
  for (const p of profiles) {
    const profile = p as unknown as {
      id: string;
      riot_puuid: string | null;
      riot_game_name: string | null;
      riot_platform: string | null;
    };
    if (!profile.riot_puuid) continue;

    const leagues = leaguesByProfile.get(profile.id) ?? [];
    const earliestLeagueStart = leagues.length > 0
      ? Math.min(...leagues.map((l) => Math.floor(new Date(l.startsAt).getTime() / 1000)))
      : lookbackStart;

    players.push({
      profileId: profile.id,
      riotPuuid: profile.riot_puuid,
      riotGameName: profile.riot_game_name ?? "Unknown",
      riotPlatform: profile.riot_platform ?? "la2",
      leagues,
      earliestLeagueStart,
    });
  }

  return players;
}

export async function syncMatches(supabase: SupabaseClient): Promise<SyncProgress> {
  const progress: SyncProgress = {
    membersProcessed: 0,
    membersTotal: 0,
    matchesFetched: 0,
    matchesSkipped: 0,
    matchesOutOfRange: 0,
    pointsCalculated: 0,
    errors: [],
  };

  // Deactivate leagues whose end date has passed, before syncing. Nothing else
  // flips is_active, so this is what makes ended leagues show as finished.
  // Duels are a removed feature — leave their rows untouched (they're excluded
  // from the sync entirely and hidden from every list).
  try {
    const nowIso = new Date().toISOString();
    const { data: ended, error: endedError } = await createAdminClient()
      .from("leagues")
      .update({ is_active: false })
      .eq("is_active", true)
      .eq("is_duel", false)
      .lt("ends_at", nowIso)
      .select("id");
    if (endedError) {
      console.error("[sync] Error deactivating ended leagues:", endedError);
    } else if (ended && ended.length > 0) {
      console.log(`[sync] Deactivated ${ended.length} ended league(s)`);
    }
  } catch (err) {
    console.error("[sync] Error deactivating ended leagues:", err);
  }

  const members = await getPlayersToTrack(supabase);
  progress.membersTotal = members.length;

  if (members.length === 0) return progress;

  console.log(`[sync] Starting sync for ${members.length} players`);

  for (const member of members) {
    try {
      console.log(`[sync] Processing ${member.riotGameName} (${member.riotPuuid.slice(0, 8)}...)`);

      // 1. Fetch ranked match IDs from the earliest league start (per needed queue).
      // Leagueless players still get tracked — default to ranked solo/duo so their
      // profile match history stays fresh even with no league driving the queue.
      const neededQueues = member.leagues.length > 0
        ? [...new Set(member.leagues.map(l => getQueueForLeagueType(l.type)))]
        : [QUEUE_IDS.RANKED_SOLO_DUO];
      const matchIdArrays = await Promise.all(
        neededQueues.map(queue =>
          getMatchIdsByPuuid(member.riotPuuid, {
            count: 100,
            queue,
            startTime: member.earliestLeagueStart,
          })
        )
      );
      const matchIds = [...new Set(matchIdArrays.flat())];

      // 2. Filter out matches this player is already done with — either they have
      // a participant record, OR the match was already evaluated and flagged
      // is_skipped (remake / early surrender). Skipped matches never store a
      // participation, so without the is_skipped check they'd be re-fetched from
      // Riot every run and burn rate-limit budget forever.
      const { data: existingMatches } = await supabase
        .from("matches")
        .select("id, riot_match_id, is_skipped")
        .in("riot_match_id", matchIds);

      const matchDbMap = new Map<string, { id: string; isSkipped: boolean }>();
      for (const m of existingMatches ?? []) {
        matchDbMap.set(m.riot_match_id, { id: m.id, isSkipped: !!m.is_skipped });
      }

      // Of the matches in the DB, which does this player already have participation for?
      const existingDbIds = [...matchDbMap.values()].map((v) => v.id);
      const { data: existingParticipations } = existingDbIds.length > 0
        ? await supabase
            .from("match_participants")
            .select("match_id")
            .eq("profile_id", member.profileId)
            .in("match_id", existingDbIds)
        : { data: [] as { match_id: string }[] };

      const participatedDbIds = new Set(
        (existingParticipations ?? []).map((p) => p.match_id)
      );

      // Done with a match if the player already has participation OR it's flagged
      // skipped. Everything else (not in DB, or in DB without participation) is new.
      const alreadyProcessedRiotIds = new Set<string>();
      for (const [riotId, meta] of matchDbMap) {
        if (participatedDbIds.has(meta.id) || meta.isSkipped) {
          alreadyProcessedRiotIds.add(riotId);
        }
      }

      const newMatchIds = matchIds.filter((id) => !alreadyProcessedRiotIds.has(id));
      progress.matchesSkipped += alreadyProcessedRiotIds.size;

      // 3. Fetch and store each new match
      for (const matchId of newMatchIds) {
        try {
          const matchData = await getMatchById(matchId);
          const matchEndAt = new Date(matchData.gameEndTimestamp);

          // Skip remakes (games under 5 minutes) AND early surrenders by AFK.
          // Riot mitigates LP loss on early surrenders, so the league must not
          // penalize them either — skip the whole match for everyone. Persist a
          // flagged row so the dedup above recognises it next run instead of
          // re-fetching it from Riot forever (a remake/surrender is skipped for
          // every player, so this global flag is correct).
          const isEarlySurrender = matchData.participants.some(
            (p) => p.gameEndedInEarlySurrender
          );
          if (matchData.gameDuration < 300 || isEarlySurrender) {
            await supabase.from("matches").upsert(
              {
                riot_match_id: matchData.matchId,
                queue_id: matchData.queueId,
                game_duration: matchData.gameDuration,
                game_end_at: matchEndAt.toISOString(),
                is_skipped: true,
              },
              { onConflict: "riot_match_id" }
            );
            progress.matchesSkipped++;
            continue;
          }

          const participant = matchData.participants.find(
            (p) => p.puuid === member.riotPuuid
          );
          if (!participant) continue;

          // Insert match
          const { data: matchRow } = await supabase
            .from("matches")
            .upsert(
              {
                riot_match_id: matchData.matchId,
                queue_id: matchData.queueId,
                game_duration: matchData.gameDuration,
                game_end_at: matchEndAt.toISOString(),
              },
              { onConflict: "riot_match_id" }
            )
            .select("id, match_events")
            .single();

          if (!matchRow) continue;

          // Fetch and store timeline events if not already present
          let matchEvents: MatchEvent[] | null = matchRow.match_events as MatchEvent[] | null;
          if (!matchEvents) {
            try {
              const timeline = await getMatchTimeline(matchId);
              matchEvents = timeline.events as MatchEvent[];
              await supabase
                .from("matches")
                .update({ match_events: timeline.events })
                .eq("id", matchRow.id);
            } catch (err) {
              // Timeline fetch is non-critical — log and continue
              console.error(`[sync] Timeline fetch failed for ${matchId}:`, err instanceof Error ? err.message : err);
            }
          }

          // Insert participant stats
          const { data: participantRow } = await supabase
            .from("match_participants")
            .upsert(
              {
                match_id: matchRow.id,
                profile_id: member.profileId,
                champion_name: participant.championName,
                champion_id: participant.championId,
                team_position: participant.teamPosition,
                win: participant.win,
                kills: participant.kills,
                deaths: participant.deaths,
                assists: participant.assists,
                total_damage_dealt_to_champions: participant.totalDamageDealtToChampions,
                gold_earned: participant.goldEarned,
                vision_score: participant.visionScore,
                total_minions_killed: participant.totalMinionsKilled,
                neutral_minions_killed: participant.neutralMinionsKilled,
                double_kills: participant.doubleKills,
                triple_kills: participant.tripleKills,
                quadra_kills: participant.quadraKills,
                penta_kills: participant.pentaKills,
                turret_kills: participant.turretKills,
                first_blood_kill: participant.firstBloodKill,
                damage_dealt_to_objectives: participant.damageDealtToObjectives,
                damage_self_mitigated: participant.damageSelfMitigated,
                wards_placed: participant.wardsPlaced,
                wards_killed: participant.wardsKilled,
                time_ccing_others: participant.timeCcingOthers,
                item_0: participant.item0,
                item_1: participant.item1,
                item_2: participant.item2,
                item_3: participant.item3,
                item_4: participant.item4,
                item_5: participant.item5,
                item_6: participant.item6,
                riot_team_id: participant.teamId,
              },
              { onConflict: "match_id,profile_id" }
            )
            .select("id")
            .single();

          if (!participantRow) continue;
          progress.matchesFetched++;

          // 4. Calculate points ONLY for leagues where the match is in range AND queue matches
          for (const league of member.leagues) {
            // Skip if queue doesn't match league type
            if (matchData.queueId !== getQueueForLeagueType(league.type)) continue;

            // Team validation: for team leagues, check 5 members (any role) on same side
            if (league.type === "team" && league.teamId) {
              const { data: teamMembers } = await supabase
                .from("team_members")
                .select("profiles:profile_id(riot_puuid)")
                .eq("team_id", league.teamId);

              const memberPuuids = new Set(
                (teamMembers ?? []).map((t) => (t.profiles as unknown as { riot_puuid: string })?.riot_puuid).filter(Boolean)
              );

              const playerRiotTeamId = participant.teamId;
              const teammatesOnSameSide = matchData.participants.filter(
                (p) => p.teamId === playerRiotTeamId && memberPuuids.has(p.puuid)
              );

              if (teammatesOnSameSide.length < 5) continue; // Not 5 team members on same side
            }

            // Duo validation: for duoq leagues, check partner is in the same match
            if (league.type === "duoq") {
              if (!league.duoPartnerPuuid) continue; // unpaired, skip
              const partnerInMatch = matchData.participants.some(
                (p) => p.puuid === league.duoPartnerPuuid
              );
              if (!partnerInMatch) continue; // partner not in this match
            }

            const leagueStart = new Date(league.startsAt);
            const memberJoined = new Date(league.joinedAt);
            const effectiveStart = leagueStart > memberJoined ? leagueStart : memberJoined;
            const leagueEnd = new Date(league.endsAt);

            if (matchEndAt < effectiveStart || matchEndAt > leagueEnd) {
              progress.matchesOutOfRange++;
              continue;
            }

            const teamTotalKills = matchData.participants
              .filter((p) => p.teamId === participant.teamId)
              .reduce((sum, p) => sum + p.kills, 0);

            const objectives = extractObjectiveStats(matchEvents, participant.teamId);

            const result = calculatePoints(league.scoringConfig, {
              win: participant.win,
              kills: participant.kills,
              deaths: participant.deaths,
              assists: participant.assists,
              totalDamageDealtToChampions: participant.totalDamageDealtToChampions,
              goldEarned: participant.goldEarned,
              visionScore: participant.visionScore,
              totalMinionsKilled: participant.totalMinionsKilled,
              neutralMinionsKilled: participant.neutralMinionsKilled,
              doubleKills: participant.doubleKills,
              tripleKills: participant.tripleKills,
              quadraKills: participant.quadraKills,
              pentaKills: participant.pentaKills,
              turretKills: participant.turretKills,
              firstBloodKill: participant.firstBloodKill,
              damageDealtToObjectives: participant.damageDealtToObjectives,
              damageSelfMitigated: participant.damageSelfMitigated,
              wardsPlaced: participant.wardsPlaced,
              wardsKilled: participant.wardsKilled,
              timeCcingOthers: participant.timeCcingOthers,
              gameDurationSeconds: matchData.gameDuration,
              teamPosition: participant.teamPosition,
              teamTotalKills,
              dragonKills: objectives.dragonKills,
              baronKills: objectives.baronKills,
              heraldKills: objectives.heraldKills,
            });

            await supabase
              .from("league_match_points")
              .upsert(
                {
                  league_id: league.leagueId,
                  match_participant_id: participantRow.id,
                  profile_id: member.profileId,
                  points: result.points,
                  breakdown: result.breakdown,
                },
                { onConflict: "league_id,match_participant_id" }
              );

            progress.pointsCalculated++;
          }
        } catch (err) {
          const msg = `Error fetching match ${matchId}: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[sync] ${msg}`);
          progress.errors.push(msg);
        }
      }

      // 5. Recalculate streaks per league (needs all matches in order)
      if (newMatchIds.length > 0) {
        for (const league of member.leagues) {
          if (!league.scoringConfig.streak_bonuses?.length) continue;

          try {
            // Get all match participants for this player in this league, ordered chronologically
            const { data: allPoints } = await supabase
              .from("league_match_points")
              .select("id, match_participant_id, points, breakdown, match_participants:match_participant_id(win, match_id, matches:match_id(game_end_at))")
              .eq("league_id", league.leagueId)
              .eq("profile_id", member.profileId);

            if (!allPoints || allPoints.length === 0) continue;

            // Sort by game end time
            const sorted = allPoints
              .map((p) => {
                const mp = p.match_participants as unknown as { win: boolean; matches: { game_end_at: string } };
                return { ...p, win: mp.win, gameEndAt: mp.matches.game_end_at };
              })
              .sort((a, b) => (new Date(a.gameEndAt).getTime() || 0) - (new Date(b.gameEndAt).getTime() || 0));

            // Calculate streaks and update points
            let consecutiveWins = 0;
            for (const entry of sorted) {
              if (entry.win) {
                consecutiveWins++;
              } else {
                consecutiveWins = 0;
              }

              const breakdown = (entry.breakdown ?? {}) as Record<string, number>;
              // Remove old streak entries
              for (const key of Object.keys(breakdown)) {
                if (key.startsWith("racha_")) delete breakdown[key];
              }

              // Add new streak bonus if applicable
              if (entry.win && consecutiveWins >= 2) {
                const bonuses = [...league.scoringConfig.streak_bonuses].sort((a, b) => b.streak - a.streak);
                for (const b of bonuses) {
                  if (consecutiveWins >= b.streak) {
                    breakdown[`racha_${consecutiveWins}`] = b.points;
                    break;
                  }
                }
              }

              const newPoints = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
              const roundedPoints = Math.round(newPoints * 100) / 100;

              if (roundedPoints !== Number(entry.points)) {
                await supabase
                  .from("league_match_points")
                  .update({ points: roundedPoints, breakdown })
                  .eq("id", entry.id);
              }
            }
          } catch (err) {
            console.error(`[sync] Error calculating streaks for ${member.riotGameName}:`, err);
          }
        }
      }

      // 6. Update rank info + profile icon
      try {
        const [ranked, summoner] = await Promise.all([
          getRankedEntriesByPuuid(member.riotPuuid, member.riotPlatform),
          getSummonerByPuuid(member.riotPuuid, member.riotPlatform),
        ]);
        const soloQ = ranked.find((e) => e.queueType === "RANKED_SOLO_5x5");
        const profileUpdate: Record<string, unknown> = {
          riot_last_synced_at: new Date().toISOString(),
        };
        if (soloQ) {
          profileUpdate.riot_tier = soloQ.tier;
          profileUpdate.riot_rank = soloQ.rank;
          profileUpdate.riot_league_points = soloQ.leaguePoints;
        }
        if (summoner?.profileIconId != null) {
          profileUpdate.avatar_url = profileIconUrl(summoner.profileIconId);
        }
        await supabase
          .from("profiles")
          .update(profileUpdate)
          .eq("id", member.profileId);
      } catch (err) {
        console.error(`[sync] Error updating rank for ${member.riotGameName}:`, err);
      }

      progress.membersProcessed++;
      console.log(`[sync] Done with ${member.riotGameName}: ${newMatchIds.length} new matches`);
    } catch (err) {
      const msg = `Error syncing ${member.riotGameName}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[sync] ${msg}`);
      progress.errors.push(msg);
      progress.membersProcessed++;
    }
  }

  // Check grace deadlines — disqualify teams past deadline
  try {
    const { data: expiredGrace } = await supabase
      .from("league_teams")
      .select("id, team_id, league_id, teams:team_id(name, members:team_members(profile_id))")
      .eq("status", "grace")
      .lt("grace_deadline", new Date().toISOString());

    for (const lt of expiredGrace ?? []) {
      // Atomic claim: only the run that actually flips grace -> disqualified
      // sends the notifications. A concurrent run (or a re-run) matches 0 rows
      // here and skips, so team_disqualified notifications can't be duplicated.
      const { data: claimed } = await supabase
        .from("league_teams")
        .update({ status: "disqualified" })
        .eq("id", lt.id)
        .eq("status", "grace")
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      const team = lt.teams as unknown as { name: string; members: { profile_id: string }[] };
      for (const m of team?.members ?? []) {
        await supabase.from("notifications").insert({
          profile_id: m.profile_id,
          type: "team_disqualified",
          payload: { teamName: team.name, leagueId: lt.league_id },
        });
      }
      console.log(`[sync] Team ${team?.name} disqualified from league ${lt.league_id}`);
    }
  } catch (err) {
    console.error("[sync] Error checking grace deadlines:", err);
  }

  console.log(`[sync] Complete. ${progress.matchesFetched} new, ${progress.matchesOutOfRange} out of range, ${progress.pointsCalculated} points.`);
  return progress;
}
