export function resolveSeedPoolIndex(
  preferredOrdinal: unknown,
  cursor: unknown,
  candidateCount: number,
): number {
  if (!Number.isFinite(candidateCount) || candidateCount <= 0) return 0;
  const requested = Number(preferredOrdinal);
  if (Number.isFinite(requested) && requested >= 0) return Math.floor(requested) % candidateCount;
  const fallback = Number(cursor);
  return Number.isFinite(fallback) && fallback >= 0 ? Math.floor(fallback) % candidateCount : 0;
}
