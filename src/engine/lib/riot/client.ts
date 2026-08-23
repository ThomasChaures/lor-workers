import { getRoutingBaseUrl, getPlatformBaseUrl, platformBaseUrl } from "./constants";
import { waitForRateLimit } from "./rate-limiter";
import type {
  RiotAccount,
  LeagueEntry,
  MatchInfo,
  MatchParticipant,
  MatchEvent,
  MatchTimeline,
  RiotApiErrorPayload,
} from "@/types/riot";

export class RiotApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public endpoint: string
  ) {
    super(message);
    this.name = "RiotApiError";
  }
}

async function riotFetch<T>(url: string): Promise<T> {
  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RIOT_API_KEY no está definida. Conseguí una en https://developer.riotgames.com"
    );
  }

  const doFetch = async () => {
    await waitForRateLimit();
    return fetch(url, {
      headers: { "X-Riot-Token": apiKey },
    });
  };

  let response = await doFetch();

  // Retry once on rate limit
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "1", 10);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    response = await doFetch();
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as RiotApiErrorPayload;
      if (payload.status?.message) {
        message = payload.status.message;
      }
    } catch {
      // Response body wasn't JSON, keep default message
    }
    throw new RiotApiError(response.status, message, url);
  }

  return response.json() as Promise<T>;
}

export async function getAccountByRiotId(
  gameName: string,
  tagLine: string
): Promise<RiotAccount> {
  const base = getRoutingBaseUrl();
  const encodedName = encodeURIComponent(gameName);
  const encodedTag = encodeURIComponent(tagLine);
  return riotFetch<RiotAccount>(
    `${base}/riot/account/v1/accounts/by-riot-id/${encodedName}/${encodedTag}`
  );
}

export async function getRankedEntriesByPuuid(
  puuid: string,
  platform?: string
): Promise<LeagueEntry[]> {
  const base = platform ? platformBaseUrl(platform) : getPlatformBaseUrl();
  return riotFetch<LeagueEntry[]>(
    `${base}/lol/league/v4/entries/by-puuid/${puuid}`
  );
}

export async function getSummonerByPuuid(
  puuid: string,
  platform?: string
): Promise<{ profileIconId: number; summonerLevel: number }> {
  const base = platform ? platformBaseUrl(platform) : getPlatformBaseUrl();
  return riotFetch<{ profileIconId: number; summonerLevel: number }>(
    `${base}/lol/summoner/v4/summoners/by-puuid/${puuid}`
  );
}

interface MatchIdsOptions {
  count?: number;
  queue?: number;
  startTime?: number;
  endTime?: number;
}

export async function getMatchIdsByPuuid(
  puuid: string,
  options?: MatchIdsOptions
): Promise<string[]> {
  const base = getRoutingBaseUrl();
  const params = new URLSearchParams();

  if (options?.count) params.set("count", String(options.count));
  if (options?.queue) params.set("queue", String(options.queue));
  if (options?.startTime) params.set("startTime", String(options.startTime));
  if (options?.endTime) params.set("endTime", String(options.endTime));

  const qs = params.toString();
  return riotFetch<string[]>(
    `${base}/lol/match/v5/matches/by-puuid/${puuid}/ids${qs ? `?${qs}` : ""}`
  );
}

// Raw Riot match response types (only what we need to map)
interface RiotMatchParticipantRaw {
  puuid: string;
  teamId: number;
  championName: string;
  championId: number;
  teamPosition: string;
  win: boolean;
  gameEndedInEarlySurrender: boolean;
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
  timeCCingOthers: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
}

interface RiotMatchInfoRaw {
  gameCreation: number;
  gameDuration: number;
  gameEndTimestamp: number;
  queueId: number;
  participants: RiotMatchParticipantRaw[];
}

interface RiotMatchResponseRaw {
  metadata: { matchId: string };
  info: RiotMatchInfoRaw;
}

function mapParticipant(raw: RiotMatchParticipantRaw): MatchParticipant {
  return {
    puuid: raw.puuid,
    teamId: raw.teamId,
    championName: raw.championName,
    championId: raw.championId,
    teamPosition: raw.teamPosition,
    win: raw.win,
    gameEndedInEarlySurrender: raw.gameEndedInEarlySurrender ?? false,
    kills: raw.kills,
    deaths: raw.deaths,
    assists: raw.assists,
    totalDamageDealtToChampions: raw.totalDamageDealtToChampions,
    goldEarned: raw.goldEarned,
    visionScore: raw.visionScore,
    totalMinionsKilled: raw.totalMinionsKilled,
    neutralMinionsKilled: raw.neutralMinionsKilled,
    doubleKills: raw.doubleKills ?? 0,
    tripleKills: raw.tripleKills ?? 0,
    quadraKills: raw.quadraKills ?? 0,
    pentaKills: raw.pentaKills ?? 0,
    turretKills: raw.turretKills ?? 0,
    firstBloodKill: raw.firstBloodKill ?? false,
    damageDealtToObjectives: raw.damageDealtToObjectives ?? 0,
    damageSelfMitigated: raw.damageSelfMitigated ?? 0,
    wardsPlaced: raw.wardsPlaced ?? 0,
    wardsKilled: raw.wardsKilled ?? 0,
    timeCcingOthers: raw.timeCCingOthers ?? 0,
    item0: raw.item0 ?? 0,
    item1: raw.item1 ?? 0,
    item2: raw.item2 ?? 0,
    item3: raw.item3 ?? 0,
    item4: raw.item4 ?? 0,
    item5: raw.item5 ?? 0,
    item6: raw.item6 ?? 0,
  };
}

export async function getMatchById(matchId: string): Promise<MatchInfo> {
  const base = getRoutingBaseUrl();
  const raw = await riotFetch<RiotMatchResponseRaw>(
    `${base}/lol/match/v5/matches/${matchId}`
  );

  return {
    matchId: raw.metadata.matchId,
    gameCreation: raw.info.gameCreation,
    gameDuration: raw.info.gameDuration,
    gameEndTimestamp: raw.info.gameEndTimestamp,
    queueId: raw.info.queueId,
    participants: raw.info.participants.map(mapParticipant),
  };
}

// Raw Riot timeline response types (only what we extract)
interface RiotTimelineEventRaw {
  type: string;
  timestamp: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  position?: { x: number; y: number };
  monsterType?: string;
  monsterSubType?: string;
  buildingType?: string;
  towerType?: string;
  laneType?: string;
  teamId?: number;
  killerTeamId?: number;
}

interface RiotTimelineFrameRaw {
  timestamp: number;
  events: RiotTimelineEventRaw[];
}

interface RiotTimelineParticipantRaw {
  participantId: number;
  puuid: string;
}

interface RiotTimelineInfoRaw {
  frameInterval: number;
  frames: RiotTimelineFrameRaw[];
  participants: RiotTimelineParticipantRaw[];
}

interface RiotTimelineResponseRaw {
  metadata: { matchId: string };
  info: RiotTimelineInfoRaw;
}

const RELEVANT_EVENT_TYPES = new Set([
  "ELITE_MONSTER_KILL",
  "BUILDING_KILL",
  "CHAMPION_KILL",
]);

export async function getMatchTimeline(matchId: string): Promise<MatchTimeline> {
  const base = getRoutingBaseUrl();
  const raw = await riotFetch<RiotTimelineResponseRaw>(
    `${base}/lol/match/v5/matches/${matchId}/timeline`
  );

  // Flatten all events from all frames
  const events: MatchEvent[] = [];
  for (const frame of raw.info.frames) {
    for (const event of frame.events) {
      if (RELEVANT_EVENT_TYPES.has(event.type)) {
        events.push({
          type: event.type,
          timestamp: event.timestamp,
          killerId: event.killerId,
          victimId: event.victimId,
          assistingParticipantIds: event.assistingParticipantIds,
          position: event.position,
          monsterType: event.monsterType,
          monsterSubType: event.monsterSubType,
          buildingType: event.buildingType,
          towerType: event.towerType,
          laneType: event.laneType,
          teamId: event.killerTeamId ?? event.teamId,
        });
      }
    }
  }

  return {
    matchId: raw.metadata.matchId,
    participants: raw.info.participants.map((p) => ({
      participantId: p.participantId,
      puuid: p.puuid,
    })),
    events,
  };
}
