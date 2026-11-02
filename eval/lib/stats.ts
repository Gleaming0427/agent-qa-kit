// Statistics for small evaluation samples. Each function is pure and unit-tested.

/** Binomial coefficient C(n, k), exact for the small n of an evaluation campaign. */
export function binom(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) result = (result * (n - i + 1)) / i;
  return Math.round(result);
}

export interface Proportion { successes: number; n: number; rate: number | null; low: number | null; high: number | null }

/**
 * Wilson score interval (95% by default). Unlike the normal approximation, it stays
 * inside [0, 1] and keeps a sensible width when n is small or the rate is 0 or 1.
 */
export function wilson(successes: number, n: number, z = 1.959963984540054): Proportion {
  if (n <= 0) return { successes, n, rate: null, low: null, high: null };
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { successes, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** pass@k: probability that at least one of k trials, drawn from n with c successes, succeeds. */
export function passAtK(n: number, c: number, k: number): number | null {
  if (k > n || n <= 0) return null;
  return 1 - binom(n - c, k) / binom(n, k);
}

/** pass^k (tau-bench): probability that all k trials, drawn from n with c successes, succeed. */
export function passHatK(n: number, c: number, k: number): number | null {
  if (k > n || n <= 0) return null;
  return binom(c, k) / binom(n, k);
}

/**
 * Standard error of a mean when observations are grouped in clusters (the trials of one
 * ticket are correlated): sqrt(sum over clusters of (sum of residuals)^2) / N.
 */
export function clusteredStandardError(values: { cluster: string; value: number }[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((sum, v) => sum + v.value, 0) / n;
  const residuals = new Map<string, number>();
  for (const v of values) residuals.set(v.cluster, (residuals.get(v.cluster) ?? 0) + (v.value - mean));
  if (residuals.size < 2) return null;
  const sumSquares = [...residuals.values()].reduce((sum, r) => sum + r * r, 0);
  return Math.sqrt(sumSquares) / n;
}

/** Percentile with linear interpolation between closest ranks (p in [0, 100]). */
export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}
