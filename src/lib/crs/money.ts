/** All money in this system is integer cents. Never floats. */

/**
 * Split `totalCents` across `weights` so the parts sum exactly to the total.
 *
 * Uses the largest-remainder method: floor every share, then hand the leftover
 * pennies to the shares with the biggest fractional parts. Proportional
 * rounding done naively loses or invents cents, which is how allocation
 * disputes start. Ties break toward the earlier index for determinism.
 */
export function allocateCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);

  // No weight anywhere: split as evenly as possible.
  if (sum <= 0) {
    const base = Math.floor(totalCents / weights.length);
    const out = weights.map(() => base);
    let leftover = totalCents - base * weights.length;
    for (let i = 0; leftover > 0; i = (i + 1) % weights.length, leftover--) {
      out[i] += 1;
    }
    return out;
  }

  const exact = weights.map((w) => (totalCents * w) / sum);
  const floored = exact.map(Math.floor);
  let remainder = totalCents - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    floored[order[k].i] += 1;
  }
  return floored;
}

/** Basis points of an amount, rounded half-up. 250 bps = 2.50%. */
export function bps(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10_000);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Compact form for dashboard tiles: $1.2k, $14.9k, $1.4M. */
export function formatCentsShort(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
