export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface LeagueEntry {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

export interface MatchParticipant {
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
  timeCcingOthers: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
}

export interface MatchInfo {
  matchId: string;
  gameCreation: number;
  gameDuration: number;
  gameEndTimestamp: number;
  queueId: number;
  participants: MatchParticipant[];
}

export interface RiotApiErrorPayload {
  status: {
    message: string;
    status_code: number;
  };
}

export interface ClashTournamentSchedule {
  id: number;
  registrationTime: number;
  startTime: number;
  cancelled: boolean;
}

export interface ClashTournament {
  id: number;
  themeId: number;
  nameKey: string;
  nameKeySecondary: string;
  schedule: ClashTournamentSchedule[];
}

export interface MatchEvent {
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
}

export interface TimelineParticipant {
  participantId: number;
  puuid: string;
}

export interface MatchTimeline {
  matchId: string;
  participants: TimelineParticipant[];
  events: MatchEvent[]; // flattened from all frames
}
