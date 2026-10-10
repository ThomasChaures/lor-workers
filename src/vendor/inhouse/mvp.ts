// VENDORED from MiLeague app: src/lib/inhouse/engine/mvp.ts — DO NOT EDIT HERE.
// Pure, no imports. Resync = copy the app file over this one verbatim.
//
// Inhouse — MVP vote resolution (pure). Tolerates partial/zero votes so the same
// function serves both the all-voted trigger and the Fase 5 timeout. The awarded
// +3 lands via the inhouse_award_mvp RPC; this only decides WHO.

/**
 * The most-voted player. Ties break by lowest player id (deterministic). Returns
 * null when there are no votes — the caller then awards nothing.
 */
export function resolveMvp(votes: { votedPlayerId: string }[]): string | null {
  if (votes.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.votedPlayerId, (counts.get(v.votedPlayerId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}
