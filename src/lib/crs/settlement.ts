/**
 * Settlement — the per-member bill for a CRS cycle.
 *
 * Three parties get paid and the money never pools at 90 Express:
 *   goods            -> the supplier, invoiced to the member directly
 *   freight          -> the contracted carrier
 *   fees             -> 90 Express (the only line that is revenue here)
 *
 * The counterfactual columns answer the only question a member actually asks:
 * was I better off in the pool than buying this myself? When the answer is no,
 * these functions say so rather than hiding it.
 */
import { estimateSoloFreightCents, type LoadPlan } from "./freight";
import type { Point } from "./geo";
import { bps } from "./money";
import { palletsFor, type PoolLine, type Product } from "./pricing";

/**
 * How 90 Express charges for coordination.
 *
 * `spend_bps` — a percentage of the goods subtotal plus a flat fee per stop.
 * Conventional, and the obvious first instinct. It has a structural flaw worth
 * stating plainly: the fee scales with how much a member spends while the
 * benefit scales with how far pooling moves them up the volume ladder. The
 * largest member in a zone is usually already at its own volume break, so it
 * gains least and pays most. In a voluntary network that member leaves, and it
 * is the member whose volume made the pool work.
 *
 * `savings_share` — a share of the savings actually delivered, measured
 * against the member's own counterfactual, and capped so a member can never
 * pay more in fees than the pool saved them. Nothing saved, nothing charged
 * beyond membership. It is the honest version of the same business and it
 * survives the conversation with the biggest buyer in the zone.
 */
export type FeeModel =
  | {
      kind: "spend_bps";
      /** Basis points of the goods subtotal. 250 = 2.50%. */
      procurementFeeBps: number;
      /** Flat charge per delivering stop. */
      freightCoordFeeCents: number;
    }
  | {
      kind: "savings_share";
      /** Basis points of gross savings. 2000 = 20%. */
      shareBps: number;
    };

export type SettlementLine = {
  product: Product;
  cases: number;
  soloUnitCents: number;
  poolUnitCents: number;
  soloGoodsCents: number;
  poolGoodsCents: number;
  savingsCents: number;
};

export type BusinessSettlement = {
  businessId: string;
  lines: SettlementLine[];
  pallets: number;

  goodsCents: number;
  freightCents: number;
  procurementFeeCents: number;
  freightCoordFeeCents: number;
  savingsShareFeeCents: number;
  /** What the member pays in total across supplier, carrier and 90 Express. */
  totalDueCents: number;

  soloGoodsCents: number;
  soloFreightCents: number;
  /**
   * Where the solo freight figure came from. A rated carrier quote turns the
   * member's savings number from an estimate into one that can be shown
   * without a disclaimer; `benchmark` means LTL_BENCHMARK was used.
   */
  soloFreightSource: "quoted" | "benchmark";
  soloTotalCents: number;

  goodsSavingsCents: number;
  freightSavingsCents: number;
  /** Savings before 90 Express takes anything. */
  grossSavingsCents: number;
  feesCents: number;
  /** Savings after 90 Express fees. Negative means the pool cost them money. */
  netSavingsCents: number;
  savingsRate: number;
};

export type CycleSettlement = {
  businesses: BusinessSettlement[];
  feeModel: FeeModel["kind"];
  goodsCents: number;
  freightCents: number;
  feeRevenueCents: number;
  grossSavingsCents: number;
  netSavingsCents: number;
  /** Members for whom the pool was a net loss after fees. */
  negativeCount: number;
  /** How many members' counterfactuals came from a rated quote. */
  quotedCount: number;
};

export type SettlementInput = {
  lines: PoolLine[];
  load: LoadPlan;
  supplierOrigin: Point;
  businesses: Array<{
    id: string;
    point: Point;
    dockType: "dock" | "liftgate" | "ground";
  }>;
  fees: FeeModel;
  /**
   * Rated carrier quotes for each member's order shipped alone, by business
   * id. Where a quote exists it replaces the LTL benchmark in that member's
   * counterfactual. Members without one keep the benchmark and stay labelled
   * as estimated.
   */
  quotedSoloFreight?: Map<string, number>;
};

export function settleCycle(input: SettlementInput): CycleSettlement {
  const freightByBusiness = new Map(
    input.load.stops.map((s) => [s.businessId, s]),
  );
  const businessById = new Map(input.businesses.map((b) => [b.id, b]));

  // Pivot pool lines into per-member line items.
  const perBusiness = new Map<string, SettlementLine[]>();
  for (const line of input.lines) {
    for (const share of line.shares) {
      const entry: SettlementLine = {
        product: line.product,
        cases: share.cases,
        soloUnitCents: share.soloUnitCents,
        poolUnitCents: share.poolUnitCents,
        soloGoodsCents: share.soloGoodsCents,
        poolGoodsCents: share.poolGoodsCents,
        savingsCents: share.goodsSavingsCents,
      };
      const list = perBusiness.get(share.businessId);
      if (list) list.push(entry);
      else perBusiness.set(share.businessId, [entry]);
    }
  }

  const settlements: BusinessSettlement[] = [];

  for (const [businessId, lines] of perBusiness) {
    const business = businessById.get(businessId);
    const stop = freightByBusiness.get(businessId);

    const goodsCents = lines.reduce((a, l) => a + l.poolGoodsCents, 0);
    const soloGoodsCents = lines.reduce((a, l) => a + l.soloGoodsCents, 0);
    const freightCents = stop?.freightCents ?? 0;
    const pallets =
      stop?.pallets ??
      palletsFor(lines.map((l) => ({ product: l.product, cases: l.cases })));

    const quoted = input.quotedSoloFreight?.get(businessId);
    const soloFreightSource: "quoted" | "benchmark" =
      quoted !== undefined ? "quoted" : "benchmark";
    const soloFreightCents =
      quoted !== undefined
        ? quoted
        : business
          ? estimateSoloFreightCents({
              origin: input.supplierOrigin,
              destination: business.point,
              pallets,
              needsLiftgate: business.dockType !== "dock",
            })
          : 0;

    const soloTotalCents = soloGoodsCents + soloFreightCents;
    // What the pool delivered before 90 Express takes anything.
    const grossSavingsCents = soloTotalCents - (goodsCents + freightCents);

    let procurementFeeCents = 0;
    let freightCoordFeeCents = 0;
    let savingsShareFeeCents = 0;

    if (input.fees.kind === "spend_bps") {
      procurementFeeCents = bps(goodsCents, input.fees.procurementFeeBps);
      freightCoordFeeCents = input.fees.freightCoordFeeCents;
    } else {
      // Share of savings only, and never more than was saved. A member who
      // gained nothing owes nothing on this cycle.
      savingsShareFeeCents = Math.min(
        Math.max(0, bps(grossSavingsCents, input.fees.shareBps)),
        Math.max(0, grossSavingsCents),
      );
    }

    const feesCents = procurementFeeCents + freightCoordFeeCents + savingsShareFeeCents;
    const totalDueCents = goodsCents + freightCents + feesCents;
    const netSavingsCents = soloTotalCents - totalDueCents;

    settlements.push({
      businessId,
      lines: lines.sort((a, b) => b.poolGoodsCents - a.poolGoodsCents),
      pallets,
      goodsCents,
      freightCents,
      procurementFeeCents,
      freightCoordFeeCents,
      savingsShareFeeCents,
      totalDueCents,
      soloGoodsCents,
      soloFreightCents,
      soloFreightSource,
      soloTotalCents,
      goodsSavingsCents: soloGoodsCents - goodsCents,
      freightSavingsCents: soloFreightCents - freightCents,
      grossSavingsCents,
      feesCents,
      netSavingsCents,
      savingsRate: soloTotalCents > 0 ? netSavingsCents / soloTotalCents : 0,
    });
  }

  settlements.sort((a, b) => b.netSavingsCents - a.netSavingsCents);

  return {
    businesses: settlements,
    feeModel: input.fees.kind,
    goodsCents: settlements.reduce((a, s) => a + s.goodsCents, 0),
    freightCents: settlements.reduce((a, s) => a + s.freightCents, 0),
    feeRevenueCents: settlements.reduce((a, s) => a + s.feesCents, 0),
    grossSavingsCents: settlements.reduce((a, s) => a + s.grossSavingsCents, 0),
    netSavingsCents: settlements.reduce((a, s) => a + s.netSavingsCents, 0),
    negativeCount: settlements.filter((s) => s.netSavingsCents < 0).length,
    quotedCount: settlements.filter((s) => s.soloFreightSource === "quoted").length,
  };
}

export type ParticipantScreen = {
  businessId: string;
  ok: boolean;
  grossSavingsCents: number;
  netSavingsCents: number;
  /** Which leg is responsible when a member comes out behind. */
  cause: "none" | "goods" | "freight" | "fees";
  finding: string;
  remedy: string;
};

/**
 * Check every member's position before a cycle is confirmed.
 *
 * Run this between negotiation and tender. A member who is worse off in the
 * pool than buying alone will work that out from their own invoices eventually,
 * and finding out after the truck has run is how a network loses the member
 * whose volume it depends on.
 *
 * Two distinct failure modes, with different fixes:
 *
 *   freight — the member's share of a consolidated truckload exceeds what its
 *     own LTL would cost. Common for the largest member on a short corridor:
 *     pallet share puts most of the linehaul on it, while its own small LTL
 *     shipment would price at the carrier's minimum charge anyway. Fix by
 *     letting that member take the pooled goods price and arrange its own
 *     freight, or by adding stops so the linehaul spreads further.
 *
 *   goods — pooling moved the member's unit price not at all, because its own
 *     volume already clears the same break. Fix by pooling it with a larger
 *     zone, or accept that this member joins for the delivery and the
 *     automation rather than the price.
 */
export function screenParticipants(settlement: CycleSettlement): ParticipantScreen[] {
  return settlement.businesses.map((b) => {
    const freightLoss = b.freightSavingsCents < 0;
    const goodsFlat = b.goodsSavingsCents <= 0;

    if (b.netSavingsCents >= 0) {
      return {
        businessId: b.businessId,
        ok: true,
        grossSavingsCents: b.grossSavingsCents,
        netSavingsCents: b.netSavingsCents,
        cause: "none" as const,
        finding: "Better off in the pool on both goods and delivered cost.",
        remedy: "",
      };
    }

    // Fees turned a real gain into a loss: that is a pricing-policy failure.
    if (b.grossSavingsCents > 0) {
      return {
        businessId: b.businessId,
        ok: false,
        grossSavingsCents: b.grossSavingsCents,
        netSavingsCents: b.netSavingsCents,
        cause: "fees" as const,
        finding: `Pool saved ${fmt(b.grossSavingsCents)} but fees took ${fmt(b.feesCents)}.`,
        remedy:
          "Switch this zone to the savings-share fee model, which cannot charge more than it saves.",
      };
    }

    if (freightLoss && !goodsFlat) {
      return {
        businessId: b.businessId,
        ok: false,
        grossSavingsCents: b.grossSavingsCents,
        netSavingsCents: b.netSavingsCents,
        cause: "freight" as const,
        finding: `Goods saved ${fmt(b.goodsSavingsCents)}, but the allocated freight share costs ${fmt(-b.freightSavingsCents)} more than this member's own LTL benchmark.`,
        remedy:
          "Offer pooled goods pricing with member-arranged freight, or add stops to spread the linehaul further.",
      };
    }

    if (freightLoss) {
      return {
        businessId: b.businessId,
        ok: false,
        grossSavingsCents: b.grossSavingsCents,
        netSavingsCents: b.netSavingsCents,
        cause: "freight" as const,
        finding: `Neither the volume break nor the consolidated freight beats what this member can do alone (freight is ${fmt(-b.freightSavingsCents)} worse).`,
        remedy:
          "Leave this member off the load, or pool it into a larger zone before tendering.",
      };
    }

    return {
      businessId: b.businessId,
      ok: false,
      grossSavingsCents: b.grossSavingsCents,
      netSavingsCents: b.netSavingsCents,
      cause: "goods" as const,
      finding:
        "This member's own volume already clears the same price break, so pooling moved its unit cost nothing.",
      remedy:
        "Pool into a larger zone to reach the next break, or sell this member on delivery and automation rather than price.",
    };
  });
}

function fmt(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * Run the same cycle under both fee models.
 *
 * This exists because the choice is not cosmetic: it decides whether the
 * largest member in a zone stays. Use it before quoting a fee schedule.
 */
export function compareFeeModels(
  input: Omit<SettlementInput, "fees">,
  spend: Extract<FeeModel, { kind: "spend_bps" }>,
  savings: Extract<FeeModel, { kind: "savings_share" }>,
): {
  spendBased: CycleSettlement;
  savingsShare: CycleSettlement;
  /** Members left worse off by the spend-based fee but whole under savings-share. */
  rescued: string[];
  revenueDeltaCents: number;
} {
  const spendBased = settleCycle({ ...input, fees: spend });
  const savingsShare = settleCycle({ ...input, fees: savings });

  const savingsById = new Map(savingsShare.businesses.map((b) => [b.businessId, b]));
  const rescued = spendBased.businesses
    .filter(
      (b) =>
        b.netSavingsCents < 0 &&
        (savingsById.get(b.businessId)?.netSavingsCents ?? 0) >= 0,
    )
    .map((b) => b.businessId);

  return {
    spendBased,
    savingsShare,
    rescued,
    revenueDeltaCents: savingsShare.feeRevenueCents - spendBased.feeRevenueCents,
  };
}
