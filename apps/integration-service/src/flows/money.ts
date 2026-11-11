/** Rounds to cents, so 0.1 + 0.2 compares equal to 0.3. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
