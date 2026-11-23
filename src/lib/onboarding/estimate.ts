/**
 * What a prospective member would actually have saved.
 *
 * Run through the same engine that settles live cycles, against the zone's
 * real committed volume — not a brochure percentage. The applicant sees the
 * number before they join, and it is snapshotted onto the application so the
 * figure we showed them still exists when they ask about it later.
 *
 * It is built to be able to say "joining will not save you much", because the
 * two findings in docs/MODEL.md both describe members for whom that is true:
 * an operator already large enough to clear its own volume break, and a zone
 * with too few stops for consolidated freight to beat LTL. Telling someone
 * that up front costs one signup; discovering it from their own invoices in
 * month three costs the member.
 */
import {
  estimateSoloFreightCents,
  planLoad,
  type Carrier,
  type StopInput,
} from "@/lib/crs/freight";
import type { Point } from "@/lib/crs/geo";
import { bps } from "@/lib/crs/money";
import {
  palletsFor,
  unitPriceFor,
  type Product,
} from "@/lib/crs/pricing";
import type { FeeModel } from "@/lib/crs/settlement";

export type EstimateLine = {
  productId: string;
  sku: string;
  name: string;
  casesPerCycle: number;
  soloUnitCents: number;
  pooledUnitCents: number;
  soloGoodsCents: number;
  pooledGoodsCents: number;
  savingsCents: number;
  /** Zone volume on this product before the applicant is added. */
  zoneCasesBefore: number;
};

export type EstimateCaveat = {
  kind: "goods_flat" | "thin_zone" | "freight_loss" | "benchmark" | "no_history";
  message: string;
};

export type SavingsEstimate = {
  cyclesPerMonth: number;
  lines: EstimateLine[];

  goodsSoloCents: number;
  goodsPooledCents: number;
  goodsSavingsCents: number;

  freightSoloCents: number;
  freightPooledCents: number;
  freightSavingsCents: number;

  feesCents: number;
  /** Per cycle, after fees. Negative means joining would cost them. */
  netPerCycleCents: number;
  netPerMonthCents: number;

  palletsPerCycle: number;
  stopsOnLoad: number;
  /** True when every figure here still rests on the LTL benchmark. */
  isBenchmarked: boolean;
  caveats: EstimateCaveat[];
};

export type EstimateInput = {
  /** Where the applicant receives, and how. */
  destination: Point;
  dockType: "dock" | "liftgate" | "ground";
  /** Cases per cycle the applicant expects to buy, by product id. */
  demand: Map<string, number>;
  products: Map<string, Product>;
  /** Cases already committed by the zone on each product, per cycle. */
  zoneDemand: Map<string, number>;
  /** The zone's existing stops on a representative load. */
  existingStops: StopInput[];
  supplierOrigin: Point;
  carrier: Carrier;
  fees: FeeModel;
  cyclesPerMonth: number;
  /** Rated solo freight for this applicant, where a carrier has quoted it. */
  quotedSoloFreightCents?: number;
};

/**
 * Combine per-supplier estimates into the one number an applicant cares about.
 *
 * A member buys from several suppliers and is a stop on several loads. Each
 * supplier's cycle has to be priced on its own — its own ladder, its own
 * truck, its own stops — and then summed. Estimating against a single
 * supplier silently drops whatever the applicant buys from the others.
 */
export function mergeEstimates(parts: SavingsEstimate[]): SavingsEstimate | null {
  const usable = parts.filter((p) => p.lines.length > 0);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  const sum = (pick: (e: SavingsEstimate) => number) =>
    usable.reduce((a, e) => a + pick(e), 0);

  // Deduplicate caveats by kind; the same warning from three suppliers is
  // still one thing the applicant needs to know.
  const caveats = new Map<EstimateCaveat["kind"], EstimateCaveat>();
  for (const part of usable) {
    for (const c of part.caveats) if (!caveats.has(c.kind)) caveats.set(c.kind, c);
  }

  const netPerCycleCents =
    sum((e) => e.goodsSavingsCents) +
    sum((e) => e.freightSavingsCents) -
    sum((e) => e.feesCents);

  return {
    cyclesPerMonth: usable[0].cyclesPerMonth,
    lines: usable.flatMap((e) => e.lines).sort((a, b) => b.savingsCents - a.savingsCents),
    goodsSoloCents: sum((e) => e.goodsSoloCents),
    goodsPooledCents: sum((e) => e.goodsPooledCents),
    goodsSavingsCents: sum((e) => e.goodsSavingsCents),
    freightSoloCents: sum((e) => e.freightSoloCents),
    freightPooledCents: sum((e) => e.freightPooledCents),
    freightSavingsCents: sum((e) => e.freightSavingsCents),
    feesCents: sum((e) => e.feesCents),
    netPerCycleCents,
    netPerMonthCents: Math.round(netPerCycleCents * usable[0].cyclesPerMonth),
    palletsPerCycle: sum((e) => e.palletsPerCycle),
    // The thinnest load is the one that decides whether the warning applies.
    stopsOnLoad: Math.min(...usable.map((e) => e.stopsOnLoad)),
    isBenchmarked: usable.some((e) => e.isBenchmarked),
    caveats: [...caveats.values()],
  };
}

export function estimateSavings(input: EstimateInput): SavingsEstimate {
  const caveats: EstimateCaveat[] = [];
  const lines: EstimateLine[] = [];

  for (const [productId, cases] of input.demand) {
    const product = input.products.get(productId);
    if (!product || cases <= 0) continue;

    const zoneCasesBefore = input.zoneDemand.get(productId) ?? 0;
    // What they reach alone, against what the zone reaches with them in it.
    const soloUnitCents = unitPriceFor(product, cases);
    const pooledUnitCents = unitPriceFor(product, zoneCasesBefore + cases);

    lines.push({
      productId,
      sku: product.sku,
      name: product.name,
      casesPerCycle: cases,
      soloUnitCents,
      pooledUnitCents,
      soloGoodsCents: soloUnitCents * cases,
      pooledGoodsCents: pooledUnitCents * cases,
      savingsCents: (soloUnitCents - pooledUnitCents) * cases,
      zoneCasesBefore,
    });
  }

  lines.sort((a, b) => b.savingsCents - a.savingsCents);

  const goodsSoloCents = lines.reduce((a, l) => a + l.soloGoodsCents, 0);
  const goodsPooledCents = lines.reduce((a, l) => a + l.pooledGoodsCents, 0);
  const goodsSavingsCents = goodsSoloCents - goodsPooledCents;

  // --- freight ---
  const applicantItems = lines
    .map((l) => ({ product: input.products.get(l.productId)!, cases: l.casesPerCycle }))
    .filter((i) => i.product);

  const palletsPerCycle = palletsFor(applicantItems);

  const applicantStop: StopInput = {
    businessId: "__applicant__",
    point: input.destination,
    dockType: input.dockType,
    items: applicantItems,
  };

  // Price the load with and without them, and charge them the difference in
  // the only way that is fair to the members already on it: run the real
  // allocator over the combined load.
  const withApplicant = planLoad(
    input.supplierOrigin,
    input.carrier,
    [...input.existingStops, applicantStop],
    "ltl_capped",
  );
  const applicantAllocated =
    withApplicant.stops.find((s) => s.businessId === "__applicant__")?.freightCents ?? 0;

  const freightSoloCents =
    input.quotedSoloFreightCents ??
    estimateSoloFreightCents({
      origin: input.supplierOrigin,
      destination: input.destination,
      pallets: palletsPerCycle,
      needsLiftgate: input.dockType !== "dock",
    });

  const freightSavingsCents = freightSoloCents - applicantAllocated;

  // --- fees ---
  const grossSavings = goodsSavingsCents + freightSavingsCents;
  let feesCents = 0;
  if (input.fees.kind === "spend_bps") {
    feesCents =
      bps(goodsPooledCents, input.fees.procurementFeeBps) +
      input.fees.freightCoordFeeCents;
  } else {
    feesCents = Math.min(
      Math.max(0, bps(grossSavings, input.fees.shareBps)),
      Math.max(0, grossSavings),
    );
  }

  const netPerCycleCents = grossSavings - feesCents;

  // --- caveats: the part that keeps this honest ---
  const stopsOnLoad = withApplicant.stops.length;

  if (input.existingStops.length === 0) {
    caveats.push({
      kind: "no_history",
      message:
        "This zone has no pooled volume yet, so the figures above compare you against yourself. Treat them as a ceiling, not a forecast.",
    });
  }

  if (stopsOnLoad < 3) {
    caveats.push({
      kind: "thin_zone",
      message: `A consolidated truck only beats separate LTL from about three stops. This load would have ${stopsOnLoad}. Until the zone fills out, the purchasing side is worth more to you than the delivery side.`,
    });
  }

  if (goodsSavingsCents <= 0 && lines.length > 0) {
    caveats.push({
      kind: "goods_flat",
      message:
        "Your own volume already reaches the same price breaks the pool reaches, so pooling does not move your unit cost. You would be joining for the consolidated delivery and the automation, not the price.",
    });
  }

  if (freightSavingsCents < 0) {
    caveats.push({
      kind: "freight_loss",
      message:
        "Your share of a consolidated load would cost more than shipping your own order, because of your pallet volume and your dock. We cap members at their own LTL cost, so you would not actually be billed above it — but the delivery side saves you nothing here.",
    });
  }

  const isBenchmarked = input.quotedSoloFreightCents === undefined;
  if (isBenchmarked) {
    caveats.push({
      kind: "benchmark",
      message:
        "Freight comparisons use a benchmark LTL rate, not a quote for your address. We rate a real carrier before your first cycle settles, and the figure can move.",
    });
  }

  return {
    cyclesPerMonth: input.cyclesPerMonth,
    lines,
    goodsSoloCents,
    goodsPooledCents,
    goodsSavingsCents,
    freightSoloCents,
    freightPooledCents: applicantAllocated,
    freightSavingsCents,
    feesCents,
    netPerCycleCents,
    netPerMonthCents: Math.round(netPerCycleCents * input.cyclesPerMonth),
    palletsPerCycle,
    stopsOnLoad,
    isBenchmarked,
    caveats,
  };
}
