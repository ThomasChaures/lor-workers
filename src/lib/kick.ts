// Kick live-status via the UNOFFICIAL endpoint (kick.com/api/v2/channels/{slug}).
// Kick has no batch API and sits behind Cloudflare, which often blocks
// datacenter IPs. The caller must be able to tell "confirmed offline" apart from
// "could not check" — clearing a live badge on a failed check would make it
// flicker every time Cloudflare blocks a request. So we return a tri-state and
// only a real 200 response yields 'live' | 'offline'; anything else is 'error'
// and the caller leaves that row untouched. See docs/live-status.md (MiLeague).

export type KickStatus = "live" | "offline" | "error";

const KICK_TIMEOUT_MS = 8_000;
const CONCURRENCY = 5; // gentle on the endpoint; caps how slow a tick can get
// Wall-clock budget for the WHOLE Kick phase. Without it, N slugs under a full
// Cloudflare block cost ceil(N/CONCURRENCY) * KICK_TIMEOUT_MS — which can stretch
// a tick past the front's 4-min staleness window and starve the loop's recovery
// gap. When the budget elapses, remaining slugs are simply left unchecked
// (absent from the map = "unknown", never cleared), so it degrades safely.
const KICK_PHASE_BUDGET_MS = 45_000;

async function checkKick(slug: string): Promise<KickStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KICK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: {
        // A realistic browser UA reduces (does not eliminate) Cloudflare blocks.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return "error"; // blocked / rate-limited / down — NOT offline
    const json = (await res.json()) as { livestream?: unknown };
    return json.livestream != null ? "live" : "offline"; // null when offline
  } catch {
    return "error"; // unreachable / timeout / bad JSON → unknown, not offline
  } finally {
    clearTimeout(timer);
  }
}

// Checks many Kick channels with a small concurrency cap and returns a map of
// slug → status. Slugs that errored are simply ABSENT from the map, so the
// caller can distinguish "confirmed offline" from "unknown". Per-channel
// isolation: one failure never rejects the batch.
export async function getLiveKickStatus(slugs: string[]): Promise<Map<string, KickStatus>> {
  const unique = [...new Set(slugs.map((s) => s.toLowerCase()).filter(Boolean))];
  const out = new Map<string, KickStatus>();
  const deadline = Date.now() + KICK_PHASE_BUDGET_MS;
  let cursor = 0;

  async function worker(): Promise<void> {
    // `cursor++` is safe as the sole synchronous read-increment here: JS is
    // single-threaded and there is NO `await` between reading and incrementing,
    // so two lanes can never grab the same index. Keep it that way — inserting
    // an `await` before `cursor++` would let lanes double-check the same slug.
    while (cursor < unique.length) {
      if (Date.now() > deadline) return; // phase budget spent — leave the rest unknown
      const slug = unique[cursor++];
      const status = await checkKick(slug);
      if (status !== "error") out.set(slug, status); // absent = unknown this tick
    }
  }

  const lanes = Math.min(CONCURRENCY, unique.length);
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return out;
}
