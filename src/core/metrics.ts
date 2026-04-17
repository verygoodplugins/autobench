export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function summaryStats(values: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
} {
  const n = values.length;
  if (n === 0) return { n: 0, p50: NaN, p95: NaN, p99: NaN, mean: NaN };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    mean,
  };
}

const normalize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

export function wer(reference: string, hypothesis: string): number {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  const R = ref.length;
  const H = hyp.length;
  if (R === 0) return H === 0 ? 0 : 1;

  const dp: number[][] = Array.from({ length: R + 1 }, () =>
    new Array<number>(H + 1).fill(0)
  );
  for (let i = 0; i <= R; i++) dp[i]![0] = i;
  for (let j = 0; j <= H; j++) dp[0]![j] = j;

  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[R]![H]! / R;
}

export function rtf(processingMs: number, audioSeconds: number): number {
  if (audioSeconds <= 0) return NaN;
  return processingMs / 1000 / audioSeconds;
}

export class Stopwatch {
  private marks = new Map<string, number>();

  mark(label: string): number {
    const now = performance.now();
    this.marks.set(label, now);
    return now;
  }

  since(label: string): number {
    const start = this.marks.get(label);
    if (start === undefined) throw new Error(`No mark named "${label}"`);
    return performance.now() - start;
  }

  between(from: string, to: string): number {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    if (a === undefined || b === undefined) {
      throw new Error(`Missing mark: ${from}=${a}, ${to}=${b}`);
    }
    return b - a;
  }
}
