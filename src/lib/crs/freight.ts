/**
 * Freight consolidation and cost allocation.
 *
 * 90 Express does not own trucks. It builds one consolidated load from a
 * zone's pooled order, tenders it to a contracted carrier, and divides the
 * carrier's charge across the members on the load. The division has to be
 * explainable line by line or members will not accept it.
 *
 * Allocation method `pallet_share_plus_stop`:
 *   - Linehaul is divided by each member's share of pallet positions. Pallets,
 *     not dollars: trailer space is the scarce resource being shared, and
 *     dollar-share would make a member buying expensive goods subsidise one
 *     buying cheap bulk.
 *   - Stop charges are split evenly across every stop on the load. Each stop
 *     imposes the same marginal burden on the driver's day.
 *   - Liftgate fees are charged only to the members who need a liftgate.
 */
import { planRoute, roadMiles, type Point } from "./geo";
import { allocateCents } from "./money";
import { palletsFor, weightFor, type Product } from "./pricing";

export type Carrier = {
  id: string;
  name: string;
  equipment: string;
  capacityPallets: number;
  maxWeightLb: number;
  /** Truckload linehaul rate, cents per route mile. */
  linehaulRateCents: number;
  minChargeCents: number;
  /** Charged per stop on the load. */
  stopChargeCents: number;
  liftgateFeeCents: number;
};

export type StopInput = {
  businessId: string;
  point: Point;
  dockType: "dock" | "liftgate" | "ground";
  items: Array<{ product: Product; cases: number }>;
};

export type AllocationMethod = "pallet_share_plus_stop" | "ltl_capped";

export type AllocatedStop = {
  businessId: string;
  sequence: number;
  pallets: number;
  weightLb: number;
  milesFromPrev: number;
  needsLiftgate: boolean;
  linehaulShareCents: number;
  stopShareCents: number;
  liftgateCents: number;
  /** What this member owes the carrier for this load. */
  freightCents: number;
  /** What this member's own LTL shipment would have cost. */
  ltlBenchmarkCents: number;
  /** True when `ltl_capped` held this member down to its own LTL cost. */
  cappedAtBenchmark: boolean;
};

export type LoadPlan = {
  carrier: Carrier;
  routeMiles: number;
  totalPallets: number;
  totalWeightLb: number;
  linehaulCents: number;
  accessorialCents: number;
  totalFreightCents: number;
  allocationMethod: AllocationMethod;
  stops: AllocatedStop[];
  /** Capacity problems that must be resolved before tendering. */
  warnings: string[];
};

/**
 * Build and cost a consolidated load.
 *
 * `origin` is the supplier's shipping point. Route miles cover origin through
 * the final stop; the carrier's deadhead home is priced into its rate, not
 * billed to members.
 */
export function planLoad(
  origin: Point,
  carrier: Carrier,
  stops: StopInput[],
  allocation: AllocationMethod = "pallet_share_plus_stop",
): LoadPlan {
  const route = planRoute(
    origin,
    stops.map((s) => ({ item: s, point: s.point })),
  );

  const ordered = route.ordered.map((o, index) => {
    const stop = o.item;
    return {
      stop,
      sequence: index + 1,
      milesFromPrev: o.milesFromPrev,
      pallets: palletsFor(stop.items),
      weightLb: weightFor(stop.items),
      needsLiftgate: stop.dockType !== "dock",
    };
  });

  const routeMiles = Math.round(route.totalMiles);
  const totalPallets = ordered.reduce((a, s) => a + s.pallets, 0);
  const totalWeightLb = ordered.reduce((a, s) => a + s.weightLb, 0);

  const linehaulCents = Math.max(
    carrier.minChargeCents,
    carrier.linehaulRateCents * routeMiles,
  );

  const stopChargesTotal = carrier.stopChargeCents * ordered.length;
  const liftgateTotal = ordered.filter((s) => s.needsLiftgate).length * carrier.liftgateFeeCents;
  const accessorialCents = stopChargesTotal + liftgateTotal;

  // Linehaul by pallet share, pennies reconciled so shares sum to the charge.
  const linehaulShares = allocateCents(
    linehaulCents,
    ordered.map((s) => s.pallets),
  );
  // Stop charges split evenly across stops.
  const stopShares = allocateCents(
    stopChargesTotal,
    ordered.map(() => 1),
  );

  const benchmarks = ordered.map((s) =>
    estimateSoloFreightCents({
      origin,
      destination: s.stop.point,
      pallets: s.pallets,
      needsLiftgate: s.needsLiftgate,
    }),
  );

  const allocated: AllocatedStop[] = ordered.map((s, i) => {
    const liftgateCents = s.needsLiftgate ? carrier.liftgateFeeCents : 0;
    return {
      businessId: s.stop.businessId,
      sequence: s.sequence,
      pallets: s.pallets,
      weightLb: Math.round(s.weightLb * 100) / 100,
      milesFromPrev: s.milesFromPrev,
      needsLiftgate: s.needsLiftgate,
      linehaulShareCents: linehaulShares[i],
      stopShareCents: stopShares[i],
      liftgateCents,
      freightCents: linehaulShares[i] + stopShares[i] + liftgateCents,
      ltlBenchmarkCents: benchmarks[i],
      cappedAtBenchmark: false,
    };
  });

  const warnings: string[] = [];

  if (allocation === "ltl_capped") {
    const capped = applyLtlCaps(
      allocated.map((a) => a.freightCents),
      benchmarks,
      ordered.map((s) => s.pallets),
      linehaulCents + accessorialCents,
    );
    if (capped.feasible) {
      capped.shares.forEach((cents, i) => {
        // Keep the components proportional to the new total so the stop's
        // breakdown still adds up on screen.
        const before = allocated[i].freightCents;
        allocated[i].freightCents = cents;
        allocated[i].cappedAtBenchmark = capped.capped[i];
        if (before > 0) {
          const scale = cents / before;
          allocated[i].linehaulShareCents = Math.round(
            allocated[i].linehaulShareCents * scale,
          );
          allocated[i].stopShareCents = Math.round(allocated[i].stopShareCents * scale);
          allocated[i].liftgateCents = Math.max(
            0,
            cents - allocated[i].linehaulShareCents - allocated[i].stopShareCents,
          );
        }
      });
    } else {
      warnings.push(
        "No split of this load leaves every member at or under its own LTL cost: the truck costs more than the members' separate shipments would. Do not tender it as one load.",
      );
    }
  }
  if (totalPallets > carrier.capacityPallets) {
    warnings.push(
      `Load is ${totalPallets} pallets against ${carrier.capacityPallets} on ${carrier.name}. Split the load or tender a second truck.`,
    );
  }
  if (totalWeightLb > carrier.maxWeightLb) {
    warnings.push(
      `Load weighs ${Math.round(totalWeightLb).toLocaleString()} lb against a ${carrier.maxWeightLb.toLocaleString()} lb limit.`,
    );
  }

  return {
    carrier,
    routeMiles,
    totalPallets,
    totalWeightLb: Math.round(totalWeightLb * 100) / 100,
    linehaulCents,
    accessorialCents,
    totalFreightCents: linehaulCents + accessorialCents,
    allocationMethod: allocation,
    stops: allocated,
    warnings,
  };
}

/**
 * Hold every member at or under its own LTL cost, and spread the excess.
 *
 * Pallet-share allocation is fair in the sense that trailer space is what is
 * being shared, but it has a failure mode the network cannot survive: the
 * member with the most pallets and the easiest dock can end up paying more
 * inside the pool than it would shipping alone. That member is usually the
 * zone's anchor volume, and it leaves.
 *
 * This caps each member at its own benchmark and redistributes the excess
 * across the members still below theirs, by pallet share, repeating until it
 * settles. The total still equals the carrier's charge exactly — the pool
 * never under-collects.
 *
 * If the caps together cannot cover the truck, there is no fair split, and
 * saying so is the useful answer: the load should not run as one tender.
 */
export function applyLtlCaps(
  baseShares: number[],
  benchmarks: number[],
  pallets: number[],
  totalCents: number,
): { shares: number[]; capped: boolean[]; feasible: boolean } {
  const n = baseShares.length;
  const capped = new Array<boolean>(n).fill(false);

  if (n === 0) return { shares: [], capped, feasible: true };

  const capTotal = benchmarks.reduce((a, b) => a + b, 0);
  if (capTotal < totalCents) {
    return { shares: baseShares, capped, feasible: false };
  }

  const shares = [...baseShares];

  // At most n passes: each pass caps at least one more member, or stops.
  for (let pass = 0; pass < n; pass++) {
    const over = shares
      .map((c, i) => ({ i, excess: c - benchmarks[i] }))
      .filter((x) => !capped[x.i] && x.excess > 0);
    if (over.length === 0) break;

    let excessPool = 0;
    for (const o of over) {
      excessPool += o.excess;
      shares[o.i] = benchmarks[o.i];
      capped[o.i] = true;
    }

    const free = shares.map((_, i) => i).filter((i) => !capped[i]);
    if (free.length === 0) {
      // Everyone is at their cap; hand the remainder back by pallet share.
      const give = allocateCents(excessPool, pallets);
      give.forEach((c, i) => {
        shares[i] += c;
      });
      break;
    }

    const add = allocateCents(
      excessPool,
      free.map((i) => pallets[i]),
    );
    free.forEach((i, k) => {
      shares[i] += add[k];
    });
  }

  // Reconcile any rounding drift against the carrier charge.
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum !== totalCents) {
    const drift = totalCents - sum;
    const target = shares.findIndex((_, i) => !capped[i]);
    shares[target >= 0 ? target : 0] += drift;
  }

  return { shares, capped, feasible: true };
}

/**
 * Benchmark LTL rates used for the "what this would have cost you alone"
 * counterfactual.
 *
 * These are planning figures, not quotes. Every savings number derived from
 * them is labelled an estimate in the UI. Replace with real rated quotes from
 * a carrier API before putting a savings figure in a contract or a pitch deck.
 */
export const LTL_BENCHMARK = {
  minChargeCents: 18_500,
  /** Cents per pallet per mile for small LTL shipments. */
  centsPerPalletMile: 22,
  liftgateFeeCents: 9_500,
  residentialOrGroundFeeCents: 0,
} as const;

/**
 * Estimated cost for one member to ship its own order direct from the supplier.
 * This is the freight leg of the savings comparison.
 */
export function estimateSoloFreightCents(args: {
  origin: Point;
  destination: Point;
  pallets: number;
  needsLiftgate: boolean;
}): number {
  const miles = Math.round(roadMiles(args.origin, args.destination));
  const variable = LTL_BENCHMARK.centsPerPalletMile * args.pallets * miles;
  const linehaul = Math.max(LTL_BENCHMARK.minChargeCents, variable);
  const liftgate = args.needsLiftgate ? LTL_BENCHMARK.liftgateFeeCents : 0;
  return linehaul + liftgate;
}
