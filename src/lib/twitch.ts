import { env } from "../config/env.js";

// Twitch Helix client for live-status polling. Uses an app access token
// (client-credentials OAuth) cached in-process — the token lasts ~60 days, so
// we never mint one per tick. The /streams endpoint returns ONLY live channels
// and accepts up to 100 logins per request, so N linked users cost ceil(N/100)
// requests per tick. See docs/live-status.md in the MiLeague repo.

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const STREAMS_URL = "https://api.twitch.tv/helix/streams";
const BATCH = 100;
const TOKEN_SKEW_MS = 60_000; // refresh a minute early to avoid edge expiry

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAppToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedToken && now < cachedToken.expiresAt - TOKEN_SKEW_MS) {
    return cachedToken.value;
  }
  // Credentials go in the POST body, NOT the query string — a query string is
  // recorded verbatim by proxy/access logs, leaking the secret in cleartext.
  const params = new URLSearchParams({
    client_id: env.twitchClientId,
    client_secret: env.twitchClientSecret,
    grant_type: "client_credentials",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    // Do NOT include the response body — a token error body can echo submitted
    // credentials, which would then land in the PM2 logs. Status is enough.
    throw new Error(`token request failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return json.access_token;
}

// Returns the set of logins (lowercased) that are currently live. On a 401 the
// app token is refreshed once and the batch retried — covers a revoked/expired
// token without a per-tick token round-trip.
export async function getLiveTwitchLogins(logins: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  const unique = [...new Set(logins.map((l) => l.toLowerCase()).filter(Boolean))];

  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const params = new URLSearchParams();
    // first=100 (max) is REQUIRED: /streams defaults to first=20, so without it
    // a batch with >20 live channels would return only 20 + a cursor and the
    // rest would look offline. A full 100-login batch fits in one page at 100.
    params.set("first", String(BATCH));
    for (const login of chunk) params.append("user_login", login);
    const url = `${STREAMS_URL}?${params.toString()}`;

    const headers = (token: string) => ({
      "Client-Id": env.twitchClientId,
      Authorization: `Bearer ${token}`,
    });

    let res = await fetch(url, { headers: headers(await getAppToken()) });
    if (res.status === 401) {
      res = await fetch(url, { headers: headers(await getAppToken(true)) });
    }
    if (!res.ok) {
      // Status only — the error body may echo the bearer token / request detail.
      throw new Error(`/streams failed: ${res.status}`);
    }
    const json = (await res.json()) as { data: { user_login: string; type: string }[] };
    for (const s of json.data) {
      if (s.type === "live") live.add(s.user_login.toLowerCase());
    }
  }
  return live;
}
