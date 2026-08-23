const REGION_ROUTING_URLS: Record<string, string> = {
  americas: "https://americas.api.riotgames.com",
  europe: "https://europe.api.riotgames.com",
  asia: "https://asia.api.riotgames.com",
  sea: "https://sea.api.riotgames.com",
};

const PLATFORM_URLS: Record<string, string> = {
  la2: "https://la2.api.riotgames.com",
  la1: "https://la1.api.riotgames.com",
  na1: "https://na1.api.riotgames.com",
  euw1: "https://euw1.api.riotgames.com",
  kr: "https://kr.api.riotgames.com",
  eun1: "https://eun1.api.riotgames.com",
  br1: "https://br1.api.riotgames.com",
  oc1: "https://oc1.api.riotgames.com",
  jp1: "https://jp1.api.riotgames.com",
  tr1: "https://tr1.api.riotgames.com",
  ru: "https://ru.api.riotgames.com",
};

export const QUEUE_IDS = {
  RANKED_SOLO_DUO: 420,
  RANKED_FLEX: 440,
} as const;

export function getRoutingBaseUrl(): string {
  const region = process.env.RIOT_REGION_ROUTING;
  if (!region || !REGION_ROUTING_URLS[region]) {
    throw new Error(
      `RIOT_REGION_ROUTING inválido o no definido: "${region}". Valores posibles: ${Object.keys(REGION_ROUTING_URLS).join(", ")}`
    );
  }
  return REGION_ROUTING_URLS[region];
}

export function getPlatformBaseUrl(): string {
  const platform = process.env.RIOT_PLATFORM;
  if (!platform || !PLATFORM_URLS[platform]) {
    throw new Error(
      `RIOT_PLATFORM inválido o no definido: "${platform}". Valores posibles: ${Object.keys(PLATFORM_URLS).join(", ")}`
    );
  }
  return PLATFORM_URLS[platform];
}

export function platformBaseUrl(platform: string): string {
  const url = PLATFORM_URLS[platform];
  if (!url) {
    throw new Error(`RIOT platform inválido: "${platform}". Valores posibles: ${Object.keys(PLATFORM_URLS).join(", ")}`);
  }
  return url;
}

// Data Dragon (static asset CDN). Bump this on each new patch — single source of truth.
export const DDRAGON_VERSION = "16.16.1";

const DDRAGON_CDN = `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img`;

// Match-v5 returns championName casings that don't match Data Dragon image
// filenames. The classic one is Fiddlesticks (API returns "FiddleSticks" with a
// capital S, but the asset is "Fiddlesticks.png"), which otherwise 404s.
const DDRAGON_CHAMPION_NAME_OVERRIDES: Record<string, string> = {
  FiddleSticks: "Fiddlesticks",
};

/** Champion square icon by champion name (e.g. "Ahri"). */
export function championIconUrl(name: string): string {
  const ddName = DDRAGON_CHAMPION_NAME_OVERRIDES[name] ?? name;
  return `${DDRAGON_CDN}/champion/${ddName}.png`;
}

/** Item icon by numeric item id. */
export function itemIconUrl(id: number | string): string {
  return `${DDRAGON_CDN}/item/${id}.png`;
}

/** Summoner profile icon by numeric profile icon id. */
export function profileIconUrl(id: number | string): string {
  return `${DDRAGON_CDN}/profileicon/${id}.png`;
}

export const TIER_VALUES: Record<string, number> = {
  IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200,
  PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400,
  MASTER: 2800, GRANDMASTER: 3200, CHALLENGER: 3600,
};

export const RANK_VALUES: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };
