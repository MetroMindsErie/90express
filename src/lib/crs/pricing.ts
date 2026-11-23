/**
 * Collective purchasing engine.
 *
 * The one economic claim 90 Express makes is this: a member's own volume lands
 * low on a supplier's volume-break ladder, and the zone's combined volume lands
 * higher. Everything here exists to compute that difference honestly, including
 * the cases where there is no difference.
 *
 * 90 Express does not take title to goods. These functions price a collective
 * order that the supplier fulfils and invoices to each member individually.
 */
import { bps } from "./money";

export type PriceTier = {
  minCases: number;
  unitPriceCents: number;
};

export type Product = {
  id: string;
  sku: string;
  name: string;
  category: string;
  packDescription: string;
  casesPerPallet: number;
  caseWeightLb: number;
  /** Published single-buyer price, used when no tier is reached. */
  listPriceCents: number;
  tiers: PriceTier[];
};

export type Commitment = {
  businessId: string;
  productId: string;
  cases: number;
};

/** The tier that applies at a given quantity, or null if none is reached. */
export function tierFor(tiers: PriceTier[], cases: number): PriceTier | null {
  let best: PriceTier | null = null;
  for (const t of tiers) {
    if (cases >= t.minCases && (best === null || t.minCases > best.minCases)) {
      best = t;
    }
  }
  return best;
}

/** Unit price a buyer gets at `cases`, falling back to list price. */
export function unitPriceFor(product: Product, cases: number): number {
  return tierFor(product.tiers, cases)?.unitPriceCents ?? product.listPriceCents;
}

/** The next unreached tier and what it would take to unlock it. */
export function nextTierFor(
  product: Product,
  cases: number,
): { tier: PriceTier; casesNeeded: number; unitSavingsCents: number } | null {
  const current = unitPriceFor(product, cases);
  const upcoming = product.tiers
    .filter((t) => t.minCases > cases && t.unitPriceCents < current)
    .sort((a, b) => a.minCases - b.minCases)[0];
  if (!upcoming) return null;
  return {
    tier: upcoming,
    casesNeeded: upcoming.minCases - cases,
    unitSavingsCents: current - upcoming.unitPriceCents,
  };
}

export type ParticipantShare = {
  businessId: string;
  cases: number;
  /** Price this business would reach buying alone. */
  soloUnitCents: number;
  /** Price the pool reaches. */
  poolUnitCents: number;
  soloGoodsCents: number;
  poolGoodsCents: number;
  goodsSavingsCents: number;
};

export type PoolLine = {
  product: Product;
  totalCases: number;
  participantCount: number;
  listPriceCents: number;
  /** Tier price the pooled quantity reaches. */
  poolUnitCents: number;
  /**
   * Price actually granted by the supplier for this cycle, once negotiated.
   * Until then this equals poolUnitCents — the ladder is a projection, not a quote.
   */
  grantedUnitCents: number | null;
  effectiveUnitCents: number;
  goodsCents: number;
  /** Sum over members of (their solo price - pool price) x their cases. */
  goodsSavingsCents: number;
  nextTier: ReturnType<typeof nextTierFor>;
  shares: ParticipantShare[];
};

/**
 * Aggregate commitments into priced pool lines.
 *
 * `granted` carries supplier-confirmed prices for cycles that have been
 * negotiated. A granted price overrides the ladder in both directions: the
 * supplier may beat the ladder or miss it, and members are owed the truth.
 */
export function buildPoolLines(
  products: Product[],
  commitments: Commitment[],
  granted: Map<string, number> = new Map(),
): PoolLine[] {
  const byProduct = new Map<string, Commitment[]>();
  for (const c of commitments) {
    const list = byProduct.get(c.productId);
    if (list) list.push(c);
    else byProduct.set(c.productId, [c]);
  }

  const lines: PoolLine[] = [];
  for (const product of products) {
    const lineCommitments = byProduct.get(product.id);
    if (!lineCommitments || lineCommitments.length === 0) continue;

    // One business may hold only one line per product per cycle, but sum
    // defensively so a double row can never silently halve the pool.
    const perBusiness = new Map<string, number>();
    for (const c of lineCommitments) {
      perBusiness.set(c.businessId, (perBusiness.get(c.businessId) ?? 0) + c.cases);
    }

    const totalCases = [...perBusiness.values()].reduce((a, b) => a + b, 0);
    const poolUnitCents = unitPriceFor(product, totalCases);
    const grantedUnitCents = granted.get(product.id) ?? null;
    const effectiveUnitCents = grantedUnitCents ?? poolUnitCents;

    const shares: ParticipantShare[] = [...perBusiness.entries()].map(
      ([businessId, cases]) => {
        const soloUnitCents = unitPriceFor(product, cases);
        const soloGoodsCents = soloUnitCents * cases;
        const poolGoodsCents = effectiveUnitCents * cases;
        return {
          businessId,
          cases,
          soloUnitCents,
          poolUnitCents: effectiveUnitCents,
          soloGoodsCents,
          poolGoodsCents,
          goodsSavingsCents: soloGoodsCents - poolGoodsCents,
        };
      },
    );

    lines.push({
      product,
      totalCases,
      participantCount: perBusiness.size,
      listPriceCents: product.listPriceCents,
      poolUnitCents,
      grantedUnitCents,
      effectiveUnitCents,
      goodsCents: effectiveUnitCents * totalCases,
      goodsSavingsCents: shares.reduce((a, s) => a + s.goodsSavingsCents, 0),
      nextTier: nextTierFor(product, totalCases),
      shares,
    });
  }

  return lines.sort((a, b) => b.goodsCents - a.goodsCents);
}

export type PoolSummary = {
  lines: PoolLine[];
  goodsCents: number;
  goodsSavingsCents: number;
  totalCases: number;
  participantCount: number;
  /** Supplier's floor for releasing a collective order. */
  minOrderCents: number;
  meetsMinimum: boolean;
  /** Goods value still needed to clear the minimum. Zero once cleared. */
  shortfallCents: number;
  /** Projected procurement fee at the current goods value. */
  procurementFeeCents: number;
};

export function summarizePool(
  lines: PoolLine[],
  opts: { minOrderCents: number; procurementFeeBps: number },
): PoolSummary {
  const goodsCents = lines.reduce((a, l) => a + l.goodsCents, 0);
  const participants = new Set<string>();
  for (const l of lines) for (const s of l.shares) participants.add(s.businessId);

  return {
    lines,
    goodsCents,
    goodsSavingsCents: lines.reduce((a, l) => a + l.goodsSavingsCents, 0),
    totalCases: lines.reduce((a, l) => a + l.totalCases, 0),
    participantCount: participants.size,
    minOrderCents: opts.minOrderCents,
    meetsMinimum: goodsCents >= opts.minOrderCents,
    shortfallCents: Math.max(0, opts.minOrderCents - goodsCents),
    procurementFeeCents: bps(goodsCents, opts.procurementFeeBps),
  };
}

/** Pallet positions a set of cases occupies, by product pack-out. */
export function palletsFor(
  items: Array<{ product: Pick<Product, "casesPerPallet">; cases: number }>,
): number {
  const fractional = items.reduce(
    (a, i) => a + i.cases / i.product.casesPerPallet,
    0,
  );
  if (fractional <= 0) return 0;
  // A partial pallet still occupies a position on the trailer.
  return Math.max(1, Math.ceil(fractional));
}

export function weightFor(
  items: Array<{ product: Pick<Product, "caseWeightLb">; cases: number }>,
): number {
  return items.reduce((a, i) => a + i.cases * i.product.caseWeightLb, 0);
}
