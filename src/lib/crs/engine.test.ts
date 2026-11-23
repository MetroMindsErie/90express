import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planReplenishment, daysToDepletion } from "./agent";
import {
  applyLtlCaps,
  estimateSoloFreightCents,
  planLoad,
  type Carrier,
} from "./freight";
import { haversineMiles, planRoute } from "./geo";
import { allocateCents, bps } from "./money";
import {
  buildPoolLines,
  nextTierFor,
  palletsFor,
  summarizePool,
  tierFor,
  unitPriceFor,
  type Product,
} from "./pricing";
import {
  compareFeeModels,
  screenParticipants,
  settleCycle,
  type FeeModel,
} from "./settlement";

const SPEND_FEES: FeeModel = {
  kind: "spend_bps",
  procurementFeeBps: 250,
  freightCoordFeeCents: 2500,
};
const SAVINGS_FEES: FeeModel = { kind: "savings_share", shareBps: 2000 };

// --- fixtures ---------------------------------------------------------------

const oil: Product = {
  id: "oil",
  sku: "OIL-35",
  name: "Fryer Oil, 35 lb",
  category: "oils_fats",
  packDescription: "1/35 lb",
  casesPerPallet: 48,
  caseWeightLb: 36,
  listPriceCents: 3000,
  tiers: [
    { minCases: 50, unitPriceCents: 2850 },
    { minCases: 250, unitPriceCents: 2600 },
    { minCases: 1000, unitPriceCents: 2400 },
  ],
};

const cups: Product = {
  id: "cups",
  sku: "CUP-16",
  name: "16 oz Cups",
  category: "disposables",
  packDescription: "20/50 ct",
  casesPerPallet: 36,
  caseWeightLb: 22,
  listPriceCents: 5400,
  tiers: [
    { minCases: 40, unitPriceCents: 5100 },
    { minCases: 200, unitPriceCents: 4750 },
  ],
};

const carrier: Carrier = {
  id: "c1",
  name: "Test Carrier",
  equipment: "dry_van",
  capacityPallets: 26,
  maxWeightLb: 45000,
  linehaulRateCents: 285,
  minChargeCents: 45000,
  stopChargeCents: 7500,
  liftgateFeeCents: 4500,
};

// Charlotte-ish supplier origin, members up I-77.
const CHARLOTTE = { lat: 35.2271, lng: -80.8431 };
const HUNTERSVILLE = { lat: 35.4107, lng: -80.8428 };
const MOORESVILLE = { lat: 35.5849, lng: -80.8101 };
const STATESVILLE = { lat: 35.7826, lng: -80.8873 };

// --- money ------------------------------------------------------------------

describe("allocateCents", () => {
  it("sums exactly to the total despite rounding", () => {
    const parts = allocateCents(10_000, [1, 1, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 10_000);
    assert.deepEqual(parts, [3334, 3333, 3333]);
  });

  it("allocates proportionally to weights", () => {
    const parts = allocateCents(100_000, [6, 3, 1]);
    assert.deepEqual(parts, [60_000, 30_000, 10_000]);
  });

  it("never loses a penny on awkward splits", () => {
    for (const total of [1, 7, 99, 100_001, 987_654]) {
      for (const weights of [[1, 2], [5, 5, 5], [7, 11, 13, 17], [1, 0, 0]]) {
        const parts = allocateCents(total, weights);
        assert.equal(
          parts.reduce((a, b) => a + b, 0),
          total,
          `total ${total} weights ${weights}`,
        );
        assert.ok(parts.every((p) => p >= 0));
      }
    }
  });

  it("splits evenly when all weights are zero", () => {
    const parts = allocateCents(1000, [0, 0, 0]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
  });

  it("handles an empty set", () => {
    assert.deepEqual(allocateCents(500, []), []);
  });
});

describe("bps", () => {
  it("computes basis points", () => {
    assert.equal(bps(100_000, 250), 2500);
    assert.equal(bps(9600_00, 250), 24_000);
  });
});

// --- pricing ----------------------------------------------------------------

describe("tier resolution", () => {
  it("returns null below the first break", () => {
    assert.equal(tierFor(oil.tiers, 10), null);
    assert.equal(unitPriceFor(oil, 10), 3000);
  });

  it("picks the highest tier reached", () => {
    assert.equal(unitPriceFor(oil, 50), 2850);
    assert.equal(unitPriceFor(oil, 249), 2850);
    assert.equal(unitPriceFor(oil, 250), 2600);
    assert.equal(unitPriceFor(oil, 5000), 2400);
  });

  it("reports what the next break costs to unlock", () => {
    const next = nextTierFor(oil, 240);
    assert.ok(next);
    assert.equal(next.casesNeeded, 10);
    assert.equal(next.tier.unitPriceCents, 2600);
    assert.equal(next.unitSavingsCents, 250);
  });

  it("reports no next tier at the top of the ladder", () => {
    assert.equal(nextTierFor(oil, 1200), null);
  });
});

describe("buildPoolLines", () => {
  // The scenario from the business model: 4 restaurants, 100 cases each.
  const commitments = [
    { businessId: "a", productId: "oil", cases: 100 },
    { businessId: "b", productId: "oil", cases: 100 },
    { businessId: "c", productId: "oil", cases: 100 },
    { businessId: "d", productId: "oil", cases: 100 },
  ];

  it("prices the pool at the aggregate tier, not the individual tier", () => {
    const [line] = buildPoolLines([oil], commitments);
    assert.equal(line.totalCases, 400);
    assert.equal(line.participantCount, 4);
    // Alone each reaches the 50-case tier at $28.50; pooled they reach $26.00.
    assert.equal(line.poolUnitCents, 2600);
    assert.equal(line.shares[0].soloUnitCents, 2850);
    assert.equal(line.goodsCents, 400 * 2600);
    // 250 cents saved per case, 400 cases.
    assert.equal(line.goodsSavingsCents, 400 * 250);
  });

  it("surfaces the gap to the next break", () => {
    const [line] = buildPoolLines([oil], commitments);
    assert.ok(line.nextTier);
    assert.equal(line.nextTier.casesNeeded, 600);
  });

  it("lets a negotiated price override the ladder in either direction", () => {
    const better = buildPoolLines([oil], commitments, new Map([["oil", 2500]]))[0];
    assert.equal(better.effectiveUnitCents, 2500);
    assert.equal(better.goodsSavingsCents, 400 * 350);

    // Supplier missed the ladder: members are shown the real, worse number.
    const worse = buildPoolLines([oil], commitments, new Map([["oil", 2900]]))[0];
    assert.equal(worse.effectiveUnitCents, 2900);
    assert.equal(worse.goodsSavingsCents, -(400 * 50));
  });

  it("reports zero savings when pooling unlocks nothing", () => {
    // Two members, 25 cases each: 50 pooled hits the same tier one of them
    // could reach alone only at 50. Individually at 25 they pay list.
    const [line] = buildPoolLines([oil], [
      { businessId: "a", productId: "oil", cases: 25 },
      { businessId: "b", productId: "oil", cases: 25 },
    ]);
    assert.equal(line.poolUnitCents, 2850);
    assert.equal(line.shares[0].soloUnitCents, 3000);
    assert.equal(line.goodsSavingsCents, 50 * 150);
  });

  it("ignores products with no commitments", () => {
    const lines = buildPoolLines([oil, cups], commitments);
    assert.equal(lines.length, 1);
  });

  it("sums duplicate rows for the same business and product", () => {
    const [line] = buildPoolLines([oil], [
      { businessId: "a", productId: "oil", cases: 60 },
      { businessId: "a", productId: "oil", cases: 40 },
    ]);
    assert.equal(line.participantCount, 1);
    assert.equal(line.totalCases, 100);
  });
});

describe("summarizePool", () => {
  it("flags a pool short of the supplier minimum", () => {
    const lines = buildPoolLines([oil], [
      { businessId: "a", productId: "oil", cases: 60 },
    ]);
    const s = summarizePool(lines, { minOrderCents: 500_000, procurementFeeBps: 250 });
    assert.equal(s.meetsMinimum, false);
    assert.equal(s.shortfallCents, 500_000 - 60 * 2850);
  });

  it("clears the minimum once demand builds", () => {
    const lines = buildPoolLines([oil], [
      { businessId: "a", productId: "oil", cases: 400 },
    ]);
    const s = summarizePool(lines, { minOrderCents: 500_000, procurementFeeBps: 250 });
    assert.equal(s.meetsMinimum, true);
    assert.equal(s.shortfallCents, 0);
    assert.equal(s.procurementFeeCents, bps(400 * 2600, 250));
  });
});

describe("palletsFor", () => {
  it("rounds a partial pallet up to a position", () => {
    assert.equal(palletsFor([{ product: oil, cases: 1 }]), 1);
    assert.equal(palletsFor([{ product: oil, cases: 48 }]), 1);
    assert.equal(palletsFor([{ product: oil, cases: 49 }]), 2);
  });

  it("consolidates across products before rounding", () => {
    // 24/48 + 18/36 = 1.0 pallet exactly, not 2.
    assert.equal(
      palletsFor([
        { product: oil, cases: 24 },
        { product: cups, cases: 18 },
      ]),
      1,
    );
  });

  it("is zero for nothing", () => {
    assert.equal(palletsFor([]), 0);
  });
});

// --- geo --------------------------------------------------------------------

describe("geo", () => {
  it("measures a known corridor distance", () => {
    // Charlotte to Statesville is roughly 40 miles as the crow flies.
    const miles = haversineMiles(CHARLOTTE, STATESVILLE);
    assert.ok(miles > 35 && miles < 45, `got ${miles}`);
  });

  it("sequences stops nearest-first up the corridor", () => {
    const route = planRoute(CHARLOTTE, [
      { item: "statesville", point: STATESVILLE },
      { item: "mooresville", point: MOORESVILLE },
      { item: "huntersville", point: HUNTERSVILLE },
    ]);
    assert.deepEqual(
      route.ordered.map((o) => o.item),
      ["huntersville", "mooresville", "statesville"],
    );
    assert.ok(route.totalMiles > 40 && route.totalMiles < 60, `got ${route.totalMiles}`);
  });
});

// --- freight ----------------------------------------------------------------

describe("planLoad", () => {
  const stops = [
    {
      businessId: "statesville",
      point: STATESVILLE,
      dockType: "liftgate" as const,
      items: [{ product: oil, cases: 100 }],
    },
    {
      businessId: "mooresville",
      point: MOORESVILLE,
      dockType: "dock" as const,
      items: [{ product: oil, cases: 100 }],
    },
    {
      businessId: "huntersville",
      point: HUNTERSVILLE,
      dockType: "liftgate" as const,
      items: [{ product: oil, cases: 200 }],
    },
  ];

  it("allocates every cent of the carrier charge", () => {
    const load = planLoad(CHARLOTTE, carrier, stops);
    const allocated = load.stops.reduce((a, s) => a + s.freightCents, 0);
    assert.equal(allocated, load.totalFreightCents);
  });

  it("charges linehaul by pallet share", () => {
    const load = planLoad(CHARLOTTE, carrier, stops);
    const hv = load.stops.find((s) => s.businessId === "huntersville")!;
    const ms = load.stops.find((s) => s.businessId === "mooresville")!;
    // 200 cases = 5 pallets vs 100 cases = 3 pallets (48/pallet, rounded up).
    assert.equal(hv.pallets, 5);
    assert.equal(ms.pallets, 3);
    assert.ok(hv.linehaulShareCents > ms.linehaulShareCents);
  });

  it("splits stop charges evenly and liftgate fees only where needed", () => {
    const load = planLoad(CHARLOTTE, carrier, stops);
    const shares = load.stops.map((s) => s.stopShareCents);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
    assert.equal(load.stops.find((s) => s.businessId === "mooresville")!.liftgateCents, 0);
    assert.equal(load.stops.find((s) => s.businessId === "statesville")!.liftgateCents, 4500);
  });

  it("applies the carrier minimum charge on short routes", () => {
    const load = planLoad(CHARLOTTE, carrier, [stops[2]]);
    // ~21 road miles x $2.85 is well under the $450 minimum.
    assert.equal(load.linehaulCents, carrier.minChargeCents);
  });

  it("warns when the load exceeds trailer capacity", () => {
    const load = planLoad(CHARLOTTE, carrier, [
      { ...stops[0], items: [{ product: oil, cases: 2000 }] },
    ]);
    assert.ok(load.warnings.some((w) => w.includes("pallets")));
  });

  it("sequences stops and reports route miles", () => {
    const load = planLoad(CHARLOTTE, carrier, stops);
    assert.deepEqual(
      load.stops.map((s) => s.businessId),
      ["huntersville", "mooresville", "statesville"],
    );
    assert.equal(load.stops.map((s) => s.sequence).join(","), "1,2,3");
    assert.ok(load.routeMiles > 0);
  });
});

describe("ltl_capped allocation", () => {
  // The shape that breaks pallet-share: one big member with a dock (cheap
  // LTL, large pallet share) pooled with small liftgate members. Four stops,
  // because three cannot cover a truckload minimum on this corridor at all —
  // see "refuses to pretend" below.
  const stops = [
    {
      businessId: "anchor",
      point: MOORESVILLE,
      dockType: "dock" as const,
      items: [{ product: oil, cases: 300 }],
    },
    {
      businessId: "small1",
      point: STATESVILLE,
      dockType: "liftgate" as const,
      items: [{ product: oil, cases: 20 }],
    },
    {
      businessId: "small2",
      point: HUNTERSVILLE,
      dockType: "liftgate" as const,
      items: [{ product: oil, cases: 24 }],
    },
    {
      businessId: "small3",
      point: { lat: 35.4868, lng: -80.8601 },
      dockType: "liftgate" as const,
      items: [{ product: oil, cases: 18 }],
    },
  ];

  it("reproduces the problem under plain pallet share", () => {
    const load = planLoad(CHARLOTTE, carrier, stops);
    const anchor = load.stops.find((s) => s.businessId === "anchor")!;
    assert.ok(
      anchor.freightCents > anchor.ltlBenchmarkCents,
      "the anchor member should be overpaying under pallet share",
    );
  });

  it("holds every member at or under its own LTL cost", () => {
    const load = planLoad(CHARLOTTE, carrier, stops, "ltl_capped");
    for (const s of load.stops) {
      assert.ok(
        s.freightCents <= s.ltlBenchmarkCents,
        `${s.businessId} pays ${s.freightCents} against a ${s.ltlBenchmarkCents} benchmark`,
      );
    }
  });

  it("still collects exactly the carrier's charge", () => {
    const load = planLoad(CHARLOTTE, carrier, stops, "ltl_capped");
    assert.equal(
      load.stops.reduce((a, s) => a + s.freightCents, 0),
      load.totalFreightCents,
    );
  });

  it("marks which members were held at their cap", () => {
    const load = planLoad(CHARLOTTE, carrier, stops, "ltl_capped");
    const anchor = load.stops.find((s) => s.businessId === "anchor")!;
    assert.equal(anchor.cappedAtBenchmark, true);
    assert.equal(anchor.freightCents, anchor.ltlBenchmarkCents);
  });

  it("keeps each stop's components adding up to its total", () => {
    const load = planLoad(CHARLOTTE, carrier, stops, "ltl_capped");
    for (const s of load.stops) {
      assert.equal(
        s.linehaulShareCents + s.stopShareCents + s.liftgateCents,
        s.freightCents,
      );
    }
  });

  it("refuses to pretend when the truck costs more than separate shipments", () => {
    // Three members, one pallet each, all with docks: LTL minimums are low and
    // the truckload minimum is high, so no split can keep everyone whole.
    const cheapLtl = [1, 2, 3].map((n) => ({
      businessId: `m${n}`,
      point: n === 1 ? MOORESVILLE : n === 2 ? HUNTERSVILLE : STATESVILLE,
      dockType: "dock" as const,
      items: [{ product: oil, cases: 10 }],
    }));
    const load = planLoad(CHARLOTTE, carrier, cheapLtl, "ltl_capped");
    const capTotal = load.stops.reduce((a, s) => a + s.ltlBenchmarkCents, 0);
    assert.ok(capTotal < load.totalFreightCents);
    assert.ok(
      load.warnings.some((w) => w.includes("Do not tender")),
      "an infeasible load must say so",
    );
    // It must not silently under-collect from the carrier.
    assert.equal(
      load.stops.reduce((a, s) => a + s.freightCents, 0),
      load.totalFreightCents,
    );
  });

  it("leaves a load alone when pallet share already keeps everyone whole", () => {
    const balanced = [
      { businessId: "a", point: MOORESVILLE, dockType: "liftgate" as const, items: [{ product: oil, cases: 100 }] },
      { businessId: "b", point: STATESVILLE, dockType: "liftgate" as const, items: [{ product: oil, cases: 100 }] },
      { businessId: "c", point: HUNTERSVILLE, dockType: "liftgate" as const, items: [{ product: oil, cases: 100 }] },
    ];
    const plain = planLoad(CHARLOTTE, carrier, balanced);
    const capped = planLoad(CHARLOTTE, carrier, balanced, "ltl_capped");
    if (plain.stops.every((s) => s.freightCents <= s.ltlBenchmarkCents)) {
      assert.deepEqual(
        capped.stops.map((s) => s.freightCents),
        plain.stops.map((s) => s.freightCents),
      );
    }
  });
});

describe("applyLtlCaps", () => {
  it("conserves the total exactly", () => {
    const base = [50_000, 20_000, 30_000];
    const caps = [30_000, 40_000, 45_000];
    const out = applyLtlCaps(base, caps, [6, 2, 3], 100_000);
    assert.equal(out.feasible, true);
    assert.equal(out.shares.reduce((a, b) => a + b, 0), 100_000);
  });

  it("reports infeasible rather than under-collecting", () => {
    const out = applyLtlCaps([50_000, 50_000], [10_000, 10_000], [1, 1], 100_000);
    assert.equal(out.feasible, false);
    assert.equal(out.shares.reduce((a, b) => a + b, 0), 100_000);
  });

  it("handles an empty load", () => {
    const out = applyLtlCaps([], [], [], 0);
    assert.deepEqual(out.shares, []);
    assert.equal(out.feasible, true);
  });
});

describe("estimateSoloFreightCents", () => {
  it("floors at the LTL minimum charge for a short single-pallet run", () => {
    const cents = estimateSoloFreightCents({
      origin: CHARLOTTE,
      destination: HUNTERSVILLE,
      pallets: 1,
      needsLiftgate: false,
    });
    assert.equal(cents, 18_500);
  });

  it("scales with pallets and distance, and adds liftgate", () => {
    const small = estimateSoloFreightCents({
      origin: CHARLOTTE,
      destination: STATESVILLE,
      pallets: 2,
      needsLiftgate: false,
    });
    const big = estimateSoloFreightCents({
      origin: CHARLOTTE,
      destination: STATESVILLE,
      pallets: 20,
      needsLiftgate: true,
    });
    assert.ok(big > small);
    assert.ok(big > 18_500 + 9_500);
  });
});

// --- settlement -------------------------------------------------------------

describe("settleCycle", () => {
  const businesses = [
    { id: "statesville", point: STATESVILLE, dockType: "liftgate" as const },
    { id: "mooresville", point: MOORESVILLE, dockType: "dock" as const },
    { id: "huntersville", point: HUNTERSVILLE, dockType: "liftgate" as const },
  ];
  const commitments = [
    { businessId: "statesville", productId: "oil", cases: 100 },
    { businessId: "mooresville", productId: "oil", cases: 100 },
    { businessId: "huntersville", productId: "oil", cases: 200 },
  ];
  const lines = buildPoolLines([oil], commitments);
  const load = planLoad(
    CHARLOTTE,
    carrier,
    businesses.map((b) => ({
      businessId: b.id,
      point: b.point,
      dockType: b.dockType,
      items: [
        {
          product: oil,
          cases: commitments.find((c) => c.businessId === b.id)!.cases,
        },
      ],
    })),
  );

  const settlement = settleCycle({
    lines,
    load,
    supplierOrigin: CHARLOTTE,
    businesses,
    fees: SPEND_FEES,
  });

  it("bills every participant once", () => {
    assert.equal(settlement.businesses.length, 3);
    const ids = settlement.businesses.map((b) => b.businessId).sort();
    assert.deepEqual(ids, ["huntersville", "mooresville", "statesville"]);
  });

  it("charges goods at the pooled price", () => {
    const ms = settlement.businesses.find((b) => b.businessId === "mooresville")!;
    assert.equal(ms.goodsCents, 100 * 2600);
    assert.equal(ms.soloGoodsCents, 100 * 2850);
    assert.equal(ms.goodsSavingsCents, 100 * 250);
  });

  it("totals goods + freight + fees as the amount due", () => {
    for (const b of settlement.businesses) {
      assert.equal(
        b.totalDueCents,
        b.goodsCents + b.freightCents + b.procurementFeeCents + b.freightCoordFeeCents,
      );
    }
  });

  it("takes fee revenue only, never the goods or freight", () => {
    const expectedFees = settlement.businesses.reduce(
      (a, b) => a + bps(b.goodsCents, 250) + 2500,
      0,
    );
    assert.equal(settlement.feeRevenueCents, expectedFees);
    assert.ok(settlement.feeRevenueCents < settlement.goodsCents);
  });

  it("reconciles allocated freight against the carrier charge", () => {
    assert.equal(settlement.freightCents, load.totalFreightCents);
  });

  it("computes net savings after fees", () => {
    for (const b of settlement.businesses) {
      assert.equal(
        b.netSavingsCents,
        b.soloTotalCents - b.totalDueCents,
      );
    }
    assert.ok(settlement.netSavingsCents > 0);
    assert.equal(settlement.negativeCount, 0);
  });

  it("reports a net loss honestly when fees outrun the savings", () => {
    // A pool that unlocks nothing, with a punitive fee, must show negative.
    const flat = buildPoolLines([oil], [
      { businessId: "mooresville", productId: "oil", cases: 100 },
    ]);
    const soloLoad = planLoad(CHARLOTTE, carrier, [
      {
        businessId: "mooresville",
        point: MOORESVILLE,
        dockType: "dock" as const,
        items: [{ product: oil, cases: 100 }],
      },
    ]);
    const bad = settleCycle({
      lines: flat,
      load: soloLoad,
      supplierOrigin: CHARLOTTE,
      businesses: [businesses[1]],
      fees: SPEND_FEES,
    });
    assert.equal(bad.businesses.length, 1);
    assert.ok(bad.businesses[0].netSavingsCents < 0);
    assert.equal(bad.negativeCount, 1);
  });
});

// --- fee models -------------------------------------------------------------
//
// The scenario that forced a second fee model into the design: a zone with one
// large member who already clears its own volume breaks alone, pooled with
// small members who do not.

describe("fee models", () => {
  const big = { id: "big", point: MOORESVILLE, dockType: "dock" as const };
  const small = { id: "small", point: STATESVILLE, dockType: "liftgate" as const };
  const businesses = [big, small];

  // 300 cases alone already reaches the 250-case break, so pooling with a
  // 20-case member moves the big buyer's price not at all.
  const commitments = [
    { businessId: "big", productId: "oil", cases: 300 },
    { businessId: "small", productId: "oil", cases: 20 },
  ];
  const lines = buildPoolLines([oil], commitments);
  const load = planLoad(
    CHARLOTTE,
    carrier,
    businesses.map((b) => ({
      businessId: b.id,
      point: b.point,
      dockType: b.dockType,
      items: [
        { product: oil, cases: commitments.find((c) => c.businessId === b.id)!.cases },
      ],
    })),
  );
  const base = { lines, load, supplierOrigin: CHARLOTTE, businesses };

  it("confirms the pool does nothing for the member who is already at scale", () => {
    const line = lines[0];
    const bigShare = line.shares.find((s) => s.businessId === "big")!;
    const smallShare = line.shares.find((s) => s.businessId === "small")!;
    assert.equal(bigShare.goodsSavingsCents, 0);
    assert.ok(smallShare.goodsSavingsCents > 0);
  });

  it("spend-based fees leave that member worse off for joining", () => {
    const s = settleCycle({ ...base, fees: SPEND_FEES });
    const bigResult = s.businesses.find((b) => b.businessId === "big")!;
    assert.ok(
      bigResult.netSavingsCents < 0,
      `expected a loss, got ${bigResult.netSavingsCents}`,
    );
  });

  it("savings-share fees can never exceed what the pool saved", () => {
    const s = settleCycle({ ...base, fees: SAVINGS_FEES });
    for (const b of s.businesses) {
      assert.ok(b.feesCents <= Math.max(0, b.grossSavingsCents));
      // The invariant the fee model can actually guarantee: 90 Express never
      // turns a gain into a loss, and never adds to a loss it did not cause.
      if (b.grossSavingsCents >= 0) {
        assert.ok(
          b.netSavingsCents >= 0,
          `${b.businessId} had a gain and must keep some of it, got ${b.netSavingsCents}`,
        );
      } else {
        assert.equal(b.netSavingsCents, b.grossSavingsCents);
      }
    }
  });

  it("does not pretend fees can fix a bad freight position", () => {
    // "big" is behind because its pallet share of the truckload costs more
    // than its own LTL would. No fee schedule repairs that.
    const s = settleCycle({ ...base, fees: SAVINGS_FEES });
    const bigResult = s.businesses.find((b) => b.businessId === "big")!;
    assert.equal(bigResult.feesCents, 0);
    assert.ok(bigResult.freightSavingsCents < 0);
    assert.ok(bigResult.netSavingsCents < 0);
  });

  it("charges nothing on a cycle that saved nothing", () => {
    const flat = buildPoolLines([oil], [{ businessId: "big", productId: "oil", cases: 300 }]);
    const soloLoad = planLoad(CHARLOTTE, carrier, [
      { businessId: "big", point: MOORESVILLE, dockType: "dock" as const, items: [{ product: oil, cases: 300 }] },
    ]);
    const s = settleCycle({
      lines: flat,
      load: soloLoad,
      supplierOrigin: CHARLOTTE,
      businesses: [big],
      fees: SAVINGS_FEES,
    });
    const only = s.businesses[0];
    assert.ok(only.grossSavingsCents <= 0);
    assert.equal(only.feesCents, 0);
  });

  it("takes exactly the agreed share when savings are real", () => {
    const s = settleCycle({ ...base, fees: { kind: "savings_share", shareBps: 2000 } });
    const smallResult = s.businesses.find((b) => b.businessId === "small")!;
    assert.ok(smallResult.grossSavingsCents > 0);
    assert.equal(
      smallResult.savingsShareFeeCents,
      Math.round(smallResult.grossSavingsCents * 0.2),
    );
    // 80% of the benefit stays with the member.
    assert.equal(
      smallResult.netSavingsCents,
      smallResult.grossSavingsCents - smallResult.savingsShareFeeCents,
    );
  });

  it("compareFeeModels quantifies the trade between the two schedules", () => {
    const cmp = compareFeeModels(base, SPEND_FEES as never, SAVINGS_FEES as never);
    // The honest model bills less here. That is the trade being made.
    assert.ok(cmp.revenueDeltaCents < 0);
    assert.ok(cmp.savingsShare.feeRevenueCents < cmp.spendBased.feeRevenueCents);
    // Every member is at least as well off under savings-share.
    const spendById = new Map(cmp.spendBased.businesses.map((b) => [b.businessId, b]));
    for (const b of cmp.savingsShare.businesses) {
      assert.ok(b.netSavingsCents >= spendById.get(b.businessId)!.netSavingsCents);
    }
  });
});

describe("screenParticipants", () => {
  const big = { id: "big", point: MOORESVILLE, dockType: "dock" as const };
  const small = { id: "small", point: STATESVILLE, dockType: "liftgate" as const };
  const commitments = [
    { businessId: "big", productId: "oil", cases: 300 },
    { businessId: "small", productId: "oil", cases: 20 },
  ];
  const lines = buildPoolLines([oil], commitments);
  const load = planLoad(CHARLOTTE, carrier, [
    { businessId: "big", point: MOORESVILLE, dockType: "dock" as const, items: [{ product: oil, cases: 300 }] },
    { businessId: "small", point: STATESVILLE, dockType: "liftgate" as const, items: [{ product: oil, cases: 20 }] },
  ]);
  const base = { lines, load, supplierOrigin: CHARLOTTE, businesses: [big, small] };

  it("passes members who are genuinely better off", () => {
    const screens = screenParticipants(settleCycle({ ...base, fees: SAVINGS_FEES }));
    const smallScreen = screens.find((s) => s.businessId === "small")!;
    assert.equal(smallScreen.ok, true);
    assert.equal(smallScreen.cause, "none");
  });

  it("blames fees when fees are what turned a gain into a loss", () => {
    // A long-haul lane, which is where consolidation genuinely pays: four
    // members 300-odd miles from the supplier, each already at the top of the
    // cups ladder so pooling moves their unit price nothing. The whole gain is
    // freight, and a 2.5%-of-spend fee is larger than that gain.
    const ATLANTA = { lat: 33.749, lng: -84.388 };
    const members = [
      { id: "m1", point: MOORESVILLE, dockType: "liftgate" as const },
      { id: "m2", point: STATESVILLE, dockType: "liftgate" as const },
      { id: "m3", point: HUNTERSVILLE, dockType: "liftgate" as const },
      { id: "m4", point: CHARLOTTE, dockType: "liftgate" as const },
    ];
    const longHaulCommitments = members.map((m) => ({
      businessId: m.id,
      productId: "cups",
      cases: 220,
    }));
    const longLines = buildPoolLines([cups], longHaulCommitments);
    // Confirm the premise: no volume break is unlocked by pooling here.
    assert.equal(longLines[0].goodsSavingsCents, 0);

    const longLoad = planLoad(
      ATLANTA,
      carrier,
      members.map((m) => ({
        businessId: m.id,
        point: m.point,
        dockType: m.dockType,
        items: [{ product: cups, cases: 220 }],
      })),
    );
    const settled = settleCycle({
      lines: longLines,
      load: longLoad,
      supplierOrigin: ATLANTA,
      businesses: members,
      fees: SPEND_FEES,
    });

    const screens = screenParticipants(settled);
    const feeCaused = screens.filter((s) => s.cause === "fees");
    assert.ok(feeCaused.length > 0, "expected at least one fee-caused finding");
    for (const s of feeCaused) {
      assert.equal(s.ok, false);
      assert.ok(s.grossSavingsCents > 0, "the pool did deliver a gain");
      assert.ok(s.netSavingsCents < 0, "fees took more than the gain");
      assert.ok(s.remedy.includes("savings-share"));
    }

    // Under savings-share the same members keep a share of the same gain.
    const fixed = screenParticipants(
      settleCycle({
        lines: longLines,
        load: longLoad,
        supplierOrigin: ATLANTA,
        businesses: members,
        fees: SAVINGS_FEES,
      }),
    );
    for (const s of feeCaused) {
      const after = fixed.find((f) => f.businessId === s.businessId)!;
      assert.equal(after.ok, true);
      assert.ok(after.netSavingsCents > 0);
    }
  });

  it("blames freight when the allocated share beats the member's own LTL", () => {
    const screens = screenParticipants(settleCycle({ ...base, fees: SAVINGS_FEES }));
    const bigScreen = screens.find((s) => s.businessId === "big")!;
    assert.equal(bigScreen.ok, false);
    assert.equal(bigScreen.cause, "freight");
    assert.ok(bigScreen.remedy.length > 0);
  });

  it("gives every flagged member an actionable remedy", () => {
    for (const fees of [SPEND_FEES, SAVINGS_FEES]) {
      for (const s of screenParticipants(settleCycle({ ...base, fees }))) {
        if (!s.ok) {
          assert.ok(s.finding.length > 0, "finding must be stated");
          assert.ok(s.remedy.length > 0, "remedy must be stated");
        }
      }
    }
  });
});

// --- agent ------------------------------------------------------------------

describe("replenishment agent", () => {
  const now = new Date("2026-03-02T12:00:00Z");
  const deliveryDate = new Date("2026-03-09T12:00:00Z"); // 7 days out
  const products = new Map([
    ["oil", oil],
    ["cups", cups],
  ]);

  const basePolicy = {
    enabled: true,
    cycleBudgetCents: 500_000,
    autoApproveUnderCents: 100_000,
    allowedCategories: ["oils_fats", "disposables"],
  };

  const ctx = (over: Partial<Parameters<typeof planReplenishment>[0]> = {}) =>
    planReplenishment({
      businessName: "Test Kitchen",
      deliveryDate,
      now,
      policy: basePolicy,
      inventory: [],
      products,
      zoneDemand: new Map(),
      existingCommitments: new Map(),
      ...over,
    });

  it("computes days of cover from observed usage", () => {
    assert.equal(
      daysToDepletion({ productId: "oil", onHandCases: 10, avgWeeklyCases: 7, parCases: 20, safetyDays: 5 }),
      10,
    );
  });

  it("never reorders an item with no recorded usage", () => {
    const plan = ctx({
      inventory: [
        { productId: "oil", onHandCases: 0, avgWeeklyCases: 0, parCases: 20, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals.length, 0);
  });

  it("does nothing when automation is off", () => {
    const plan = ctx({
      policy: { ...basePolicy, enabled: false },
      inventory: [
        { productId: "oil", onHandCases: 1, avgWeeklyCases: 20, parCases: 40, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals.length, 0);
    assert.ok(plan.steps.some((s) => s.label.includes("automation off")));
  });

  it("leaves well-stocked items alone", () => {
    const plan = ctx({
      inventory: [
        // 60 cases at 7/week is 60 days of cover; delivery is 7 days out.
        { productId: "oil", onHandCases: 60, avgWeeklyCases: 7, parCases: 40, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals.length, 0);
    assert.equal(plan.skipped.length, 1);
  });

  it("orders up to par based on stock projected at delivery", () => {
    const plan = ctx({
      inventory: [
        // 14/week = 2/day. 10 on hand runs out in 5 days, before the 7-day
        // delivery. Projected at delivery: 0. Par 40 -> order 40.
        { productId: "oil", onHandCases: 10, avgWeeklyCases: 14, parCases: 40, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals.length, 1);
    assert.equal(plan.proposals[0].cases, 40);
  });

  it("nets out cases already committed this cycle", () => {
    const plan = ctx({
      inventory: [
        { productId: "oil", onHandCases: 10, avgWeeklyCases: 14, parCases: 40, safetyDays: 5 },
      ],
      existingCommitments: new Map([["oil", 40]]),
    });
    assert.equal(plan.proposals.length, 0);
  });

  it("prices the proposal at pooled zone demand, not its own volume", () => {
    const plan = ctx({
      inventory: [
        { productId: "oil", onHandCases: 2, avgWeeklyCases: 14, parCases: 40, safetyDays: 5 },
      ],
      // Zone already has 300 cases committed; 40 more lands past the 250 break.
      zoneDemand: new Map([["oil", 300]]),
    });
    assert.equal(plan.proposals[0].estUnitCents, 2600);
    assert.ok(plan.proposals[0].reason.includes("Pooled zone demand"));
  });

  it("respects the category mandate", () => {
    const plan = ctx({
      policy: { ...basePolicy, allowedCategories: ["disposables"] },
      inventory: [
        { productId: "oil", onHandCases: 1, avgWeeklyCases: 14, parCases: 40, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals.length, 0);
    assert.ok(plan.skipped[0].reason.includes("mandate"));
  });

  it("holds a proposal that would breach the cycle budget", () => {
    const plan = ctx({
      policy: { ...basePolicy, cycleBudgetCents: 50_000 },
      inventory: [
        { productId: "oil", onHandCases: 1, avgWeeklyCases: 14, parCases: 100, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals.length, 0);
    assert.ok(plan.skipped[0].reason.includes("cycle budget"));
    assert.ok(plan.steps.some((s) => s.label.startsWith("Hold")));
  });

  it("auto-approves under the limit and escalates above it", () => {
    const plan = ctx({
      policy: { ...basePolicy, autoApproveUnderCents: 50_000 },
      inventory: [
        // ~$57 of cups: under the limit.
        { productId: "cups", onHandCases: 0, avgWeeklyCases: 7, parCases: 1, safetyDays: 5 },
        // ~$1,140 of oil: over the limit.
        { productId: "oil", onHandCases: 0, avgWeeklyCases: 14, parCases: 40, safetyDays: 5 },
      ],
    });
    const cupsProposal = plan.proposals.find((p) => p.productId === "cups")!;
    const oilProposal = plan.proposals.find((p) => p.productId === "oil")!;
    assert.equal(cupsProposal.autoApprove, true);
    assert.equal(oilProposal.autoApprove, false);
  });

  it("buys the most urgent item first when the budget binds", () => {
    const plan = ctx({
      policy: { ...basePolicy, cycleBudgetCents: 120_000 },
      inventory: [
        // 1 day of cover - most urgent.
        { productId: "cups", onHandCases: 1, avgWeeklyCases: 7, parCases: 20, safetyDays: 5 },
        // 2 days of cover.
        { productId: "oil", onHandCases: 4, avgWeeklyCases: 14, parCases: 100, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals[0].productId, "cups");
  });

  it("emits a numbered, gap-free reasoning trace", () => {
    const plan = ctx({
      inventory: [
        { productId: "oil", onHandCases: 2, avgWeeklyCases: 14, parCases: 40, safetyDays: 5 },
      ],
    });
    assert.ok(plan.steps.length >= 3);
    plan.steps.forEach((s, i) => {
      assert.equal(s.sequence, i + 1);
      assert.ok(s.label.length > 0);
      assert.ok(s.detail.length > 0);
    });
  });

  it("skips products the cycle's supplier does not carry", () => {
    const plan = ctx({
      inventory: [
        { productId: "napkins", onHandCases: 0, avgWeeklyCases: 10, parCases: 20, safetyDays: 5 },
      ],
    });
    assert.equal(plan.proposals.length, 0);
    assert.ok(plan.skipped[0].reason.includes("catalog"));
  });
});
