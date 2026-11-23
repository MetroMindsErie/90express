import Link from "next/link";

import { estimateSoloFreightCents, LTL_BENCHMARK, planLoad } from "@/lib/crs/freight";
import { formatCents } from "@/lib/crs/money";
import { type Product } from "@/lib/crs/pricing";
import { compareFeeModels } from "@/lib/crs/settlement";
import {
  analyzeCycle,
  getCycles,
  getMembershipPlans,
  getNetworkStats,
  getSettlements,
} from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  EstimateNote,
  Money,
  PageHead,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";

import { requireOperator } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * How many stops a load needs before consolidation beats separate LTL.
 *
 * A carrier charges a truckload minimum whether it runs 25 miles or 150. On a
 * corridor this short, every member's own LTL shipment also prices at its
 * carrier's minimum charge. So the comparison is one truckload minimum against
 * N small-shipment minimums, and the only variable that moves it is N.
 *
 * Built from the same engine the app settles with, so the threshold is real.
 */
function stopCountSensitivity(palletsEach: number) {
  const carrier = {
    id: "bench",
    name: "Benchmark carrier",
    equipment: "dry_van",
    capacityPallets: 26,
    maxWeightLb: 45_000,
    linehaulRateCents: 289,
    minChargeCents: 45_000,
    stopChargeCents: 7_500,
    liftgateFeeCents: 4_500,
  };

  // A synthetic product whose pack-out yields exactly palletsEach per member.
  const unit: Product = {
    id: "bench",
    sku: "BENCH",
    name: "Benchmark case",
    category: "benchmark",
    packDescription: "benchmark",
    casesPerPallet: 40,
    caseWeightLb: 30,
    listPriceCents: 3000,
    tiers: [],
  };
  const casesEach = palletsEach * unit.casesPerPallet;

  // A Charlotte origin with members spread up the corridor, as the pilot is.
  const origin = { lat: 35.205, lng: -80.88 };

  return [2, 3, 4, 5, 6, 8, 10].map((members) => {
    const stops = Array.from({ length: members }, (_, i) => ({
      businessId: `m${i}`,
      point: { lat: 35.3 + i * 0.07, lng: -80.85 },
      dockType: "liftgate" as const,
      items: [{ product: unit, cases: casesEach }],
    }));

    const load = planLoad(origin, carrier, stops);
    const pooled = load.totalFreightCents;
    const solo = stops.reduce(
      (a, s) =>
        a +
        estimateSoloFreightCents({
          origin,
          destination: s.point,
          pallets: palletsEach,
          needsLiftgate: true,
        }),
      0,
    );
    return {
      members,
      miles: load.routeMiles,
      pooled,
      solo,
      delta: solo - pooled,
      perMember: Math.round((solo - pooled) / members),
    };
  });
}

export default async function EconomicsPage() {
  await requireOperator();
  const [stats, settlements, cycles, plans] = await Promise.all([
    getNetworkStats(),
    getSettlements(),
    getCycles(),
    getMembershipPlans(),
  ]);

  // Compare fee models on every cycle that has a load built.
  const analyses = (
    await Promise.all(cycles.map((c) => analyzeCycle(c.id)))
  ).filter((a): a is NonNullable<typeof a> => a !== null && a.load !== null);

  const comparisons = analyses.map((a) => {
    const cmp = compareFeeModels(
      {
        lines: a.lines,
        load: a.load!,
        supplierOrigin: { lat: a.cycle.supplier_lat, lng: a.cycle.supplier_lng },
        businesses: [...new Set(a.commitments.map((c) => c.business_id))].map((bid) => {
          const row = a.commitments.find((c) => c.business_id === bid)!;
          return {
            id: bid,
            point: { lat: row.business_lat, lng: row.business_lng },
            dockType: row.business_dock,
          };
        }),
      },
      {
        kind: "spend_bps",
        procurementFeeBps: a.cycle.procurement_fee_bps,
        freightCoordFeeCents: a.cycle.freight_coord_fee_cents,
      },
      { kind: "savings_share", shareBps: a.cycle.savings_share_bps },
    );
    return { analysis: a, cmp };
  });

  const totalGross = comparisons.reduce(
    (acc, c) => acc + c.cmp.savingsShare.grossSavingsCents,
    0,
  );
  const spendRevenue = comparisons.reduce(
    (acc, c) => acc + c.cmp.spendBased.feeRevenueCents,
    0,
  );
  const shareRevenue = comparisons.reduce(
    (acc, c) => acc + c.cmp.savingsShare.feeRevenueCents,
    0,
  );
  const spendLosers = comparisons.reduce(
    (acc, c) => acc + c.cmp.spendBased.negativeCount,
    0,
  );
  const shareLosers = comparisons.reduce(
    (acc, c) => acc + c.cmp.savingsShare.negativeCount,
    0,
  );

  const sensitivity = stopCountSensitivity(3);
  const breakeven = sensitivity.find((r) => r.delta > 0);

  // How the live loads actually divided: who ended up paying more than their
  // own LTL, before the cap rule, and what the pool gained in aggregate.
  const freightPositions = analyses.flatMap((a) =>
    a.load!.stops.map((s) => ({
      cycle: a.cycle.name,
      name: a.businessNames.get(s.businessId) ?? s.businessId,
      allocated: s.freightCents,
      benchmark: s.ltlBenchmarkCents,
      capped: s.cappedAtBenchmark,
      gain: s.ltlBenchmarkCents - s.freightCents,
    })),
  );
  const aggregateFreightGain = freightPositions.reduce((a, p) => a + p.gain, 0);
  const cappedCount = freightPositions.filter((p) => p.capped).length;
  const overpayers = freightPositions.filter((p) => p.gain < 0).length;

  const annualisedMrr = stats.mrr_cents * 12;

  return (
    <>
      <PageHead
        eyebrow="Operator view"
        title="Unit economics"
        sub="What the network actually produces, and the two structural facts that decide whether it holds together. Every figure here is computed by the same engine that settles live cycles."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Value created for members"
          value={formatCents(totalGross)}
          tone="guide"
          sub="Gross savings across all costed cycles, before 90 Express fees"
        />
        <Stat
          label="Fee revenue — savings share"
          value={formatCents(shareRevenue)}
          sub={`${totalGross > 0 ? ((shareRevenue / totalGross) * 100).toFixed(0) : 0}% of the value created`}
        />
        <Stat
          label="Fee revenue — spend based"
          value={formatCents(spendRevenue)}
          tone={spendRevenue > totalGross ? "alert" : "signal"}
          sub={`${totalGross > 0 ? ((spendRevenue / totalGross) * 100).toFixed(0) : 0}% of the value created`}
        />
        <Stat
          label="Membership ARR"
          value={formatCents(annualisedMrr)}
          sub={`${stats.members} members · recurring, independent of cycle volume`}
        />
      </div>

      <Card className="mt-6 border-signal/40">
        <CardHead
          title="Finding 1 — a percentage-of-spend fee bills the most to the member who gains the least"
          sub="The fee scales with spend. The benefit scales with how far pooling moves a member up the volume ladder. Those are not the same thing."
        />
        <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-mid">
          <p>
            The largest buyer in a zone usually already clears the supplier&apos;s
            volume break on its own volume, so pooling moves its unit price very
            little. It is also the member paying the biggest percentage fee, and
            the member whose volume is what pulls everyone else past the break.
            Under a spend-based schedule it is the first to work out that it is
            subsidising the zone, and the first to leave.
          </p>
          <p>
            Across the costed cycles here, a 2.5%-of-spend schedule would bill{" "}
            <span className="num font-semibold text-signal">
              {formatCents(spendRevenue)}
            </span>{" "}
            against{" "}
            <span className="num font-semibold text-guide">
              {formatCents(totalGross)}
            </span>{" "}
            of value created, leaving{" "}
            <span className="num font-semibold text-alert">{spendLosers}</span>{" "}
            member-cycles worse off than buying alone. A 20% share of verified
            savings bills{" "}
            <span className="num font-semibold text-hi">{formatCents(shareRevenue)}</span>{" "}
            and leaves{" "}
            <span className="num font-semibold text-hi">{shareLosers}</span> worse
            off from fees — it cannot charge more than it saved.
          </p>
        </div>

        <Table>
          <thead>
            <tr>
              <Th>Cycle</Th>
              <Th right>Value created</Th>
              <Th right>Fee @2.5% spend</Th>
              <Th right>Fee @20% savings</Th>
              <Th right>Members hurt</Th>
              <Th right>Capture rate</Th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map(({ analysis, cmp }) => {
              const gross = cmp.savingsShare.grossSavingsCents;
              const capture = gross > 0 ? cmp.spendBased.feeRevenueCents / gross : 0;
              return (
                <tr key={analysis.cycle.id} className="hover:bg-ink-850">
                  <Td>
                    <Link
                      href={`/pools/${analysis.cycle.id}`}
                      className="font-medium text-hi hover:text-signal"
                    >
                      {analysis.cycle.name}
                    </Link>
                    <p className="text-xs text-low">
                      {analysis.cycle.zone_name} · live model:{" "}
                      {analysis.cycle.fee_model.replace(/_/g, " ")}
                    </p>
                  </Td>
                  <Td right>
                    <Money cents={gross} signed />
                  </Td>
                  <Td right className="num text-signal">
                    {formatCents(cmp.spendBased.feeRevenueCents)}
                  </Td>
                  <Td right className="num text-guide">
                    {formatCents(cmp.savingsShare.feeRevenueCents)}
                  </Td>
                  <Td right>
                    <span className="num text-alert">{cmp.spendBased.negativeCount}</span>
                    <span className="text-low"> → </span>
                    <span className="num text-guide">{cmp.savingsShare.negativeCount}</span>
                  </Td>
                  <Td right>
                    <span
                      className={`num font-semibold ${capture > 1 ? "text-alert" : capture > 0.5 ? "text-signal" : "text-mid"}`}
                    >
                      {(capture * 100).toFixed(0)}%
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <div className="px-4 pb-4">
          <EstimateNote>
            Capture rate is the spend-based fee as a share of the value the pool
            created. Above 100% means 90 Express would bill more than the pool
            saved. &ldquo;Members hurt&rdquo; counts member-cycles with a negative net
            position under each schedule.
          </EstimateNote>
        </div>
      </Card>

      <Card className="mt-6 border-route/40">
        <CardHead
          title="Finding 2 — a zone needs a minimum number of stops before the truck is worth tendering"
          sub="On a corridor this short, both sides of the comparison sit at a carrier minimum. The only variable that moves it is how many members share the truck."
        />
        <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-mid">
          <p>
            A carrier charges a truckload minimum whether it runs 25 miles or
            150. Over a corridor this short, each member&apos;s own LTL shipment
            also prices at <em>its</em> carrier&apos;s minimum charge. So the
            real comparison is one truckload minimum plus stop charges against N
            small-shipment minimums — and distance barely enters into it.
          </p>
          <p>
            {breakeven ? (
              <>
                On the benchmark below, consolidation starts beating separate LTL
                at{" "}
                <span className="num font-semibold text-hi">
                  {breakeven.members} stops
                </span>{" "}
                on the load, and the gain widens with every stop after that. A
                zone with fewer live members than that should still pool its{" "}
                <em>purchasing</em> — the volume break is untouched by this — but
                it should let members take their own delivery until the zone fills
                out.
              </>
            ) : (
              <>
                On the benchmark below, consolidation never beats separate LTL at
                any stop count tested, which would mean the freight leg is not
                where this model earns.
              </>
            )}
          </p>
          <p>
            Across the live loads, consolidation is worth{" "}
            <span className="num font-semibold text-guide">
              {formatCents(aggregateFreightGain)}
            </span>{" "}
            in aggregate. But the aggregate hides the distribution: under plain
            pallet-share allocation{" "}
            <span className="num font-semibold text-alert">{overpayers}</span>{" "}
            member-stops would pay more inside the pool than shipping alone —
            typically the member with the biggest pallet share and a loading
            dock, which is usually the zone&apos;s anchor volume.
          </p>
          <p className="text-hi">
            The platform now allocates with{" "}
            <span className="num">ltl_capped</span>: no member is billed above its
            own LTL benchmark, and the excess is redistributed across members
            still below theirs.{" "}
            <span className="num font-semibold">{cappedCount}</span> stop
            {cappedCount === 1 ? " is" : "s are"} currently held at that cap. When
            the caps together cannot cover the truck, the load is reported as not
            worth tendering rather than quietly billed out.
          </p>
        </div>

        <Table>
          <thead>
            <tr>
              <Th right>Stops on load</Th>
              <Th right>Route miles</Th>
              <Th right>Consolidated</Th>
              <Th right>Separate LTL</Th>
              <Th right>Difference</Th>
              <Th right>Per member</Th>
              <Th>Verdict</Th>
            </tr>
          </thead>
          <tbody>
            {sensitivity.map((r) => (
              <tr key={r.members} className="hover:bg-ink-850">
                <Td right className="num font-semibold text-hi">{r.members}</Td>
                <Td right className="num text-low">{r.miles}</Td>
                <Td right className="num text-mid">{formatCents(r.pooled)}</Td>
                <Td right className="num text-mid">{formatCents(r.solo)}</Td>
                <Td right>
                  <Money cents={r.delta} signed />
                </Td>
                <Td right>
                  <Money cents={r.perMember} signed />
                </Td>
                <Td>
                  {r.delta > 0 ? (
                    <Badge tone="guide">consolidation wins</Badge>
                  ) : (
                    <Badge tone="alert">LTL wins</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="px-4 pb-4">
          <EstimateNote>
            Three pallets per member, liftgate delivery, Charlotte origin up the
            corridor, against the benchmark LTL rate (
            {formatCents(LTL_BENCHMARK.minChargeCents)} minimum,{" "}
            {LTL_BENCHMARK.centsPerPalletMile}¢ per pallet-mile) and a{" "}
            {formatCents(289)}/mile truckload with a {formatCents(45_000)} minimum
            plus {formatCents(7_500)} per stop. Both sides are planning benchmarks.
            Re-run against rated quotes from the carriers you actually contract
            with before relying on the threshold.
          </EstimateNote>
        </div>
      </Card>

      <Card className="mt-6">
        <CardHead
          title="Freight position by member"
          sub="Each member's allocated share against what its own LTL shipment would have cost. This is the table that decides whether the anchor member stays."
        />
        <Table>
          <thead>
            <tr>
              <Th>Member</Th>
              <Th>Cycle</Th>
              <Th right>Allocated</Th>
              <Th right>Own LTL (est.)</Th>
              <Th right>Position</Th>
              <Th>Rule applied</Th>
            </tr>
          </thead>
          <tbody>
            {freightPositions
              .sort((a, b) => a.gain - b.gain)
              .map((p, i) => (
                <tr key={`${p.cycle}-${p.name}-${i}`} className="hover:bg-ink-850">
                  <Td className="font-medium text-hi">{p.name}</Td>
                  <Td className="text-xs text-mid">{p.cycle}</Td>
                  <Td right className="num text-mid">{formatCents(p.allocated)}</Td>
                  <Td right className="num text-low">{formatCents(p.benchmark)}</Td>
                  <Td right>
                    <Money cents={p.gain} signed />
                  </Td>
                  <Td>
                    {p.capped ? (
                      <Badge tone="signal">held at own LTL cost</Badge>
                    ) : (
                      <Badge tone="neutral">pallet share</Badge>
                    )}
                  </Td>
                </tr>
              ))}
          </tbody>
        </Table>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHead
            title="Revenue mix"
            sub="Membership is the stable line. Coordination fees scale with cycles run."
          />
          <Table>
            <thead>
              <tr>
                <Th>Source</Th>
                <Th right>Current</Th>
                <Th>Behaviour</Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td className="font-medium text-hi">Membership</Td>
                <Td right className="num text-hi">
                  {formatCents(stats.mrr_cents)}/mo
                </Td>
                <Td className="text-xs text-mid">
                  Recurring. Paid whether or not a member buys this cycle.
                </Td>
              </tr>
              <tr>
                <Td className="font-medium text-hi">Coordination fees</Td>
                <Td right className="num text-hi">
                  {formatCents(stats.fee_revenue_cents)}
                </Td>
                <Td className="text-xs text-mid">
                  Settled to date. Under savings-share this is capped by the value
                  delivered, so it cannot outrun member benefit.
                </Td>
              </tr>
              {plans.map((p) => (
                <tr key={p.tier}>
                  <Td className="pl-6 text-xs capitalize text-mid">
                    {p.tier} × {p.member_count}
                  </Td>
                  <Td right className="num text-xs text-mid">
                    {formatCents(p.monthly_cents * p.member_count)}/mo
                  </Td>
                  <Td className="text-xs text-low">{p.description}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHead
            title="Settled cycles"
            sub="Actuals, by fee model, as recorded at settlement."
          />
          {settlements.length === 0 ? (
            <Empty>Nothing settled yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th>Cycle</Th>
                  <Th right>Goods</Th>
                  <Th right>Fee</Th>
                  <Th right>Net to member</Th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((s) => (
                  <tr key={s.id} className="hover:bg-ink-850">
                    <Td className="text-hi">{s.business_name}</Td>
                    <Td>
                      <p className="truncate text-xs text-mid">{s.cycle_name}</p>
                      <Badge
                        tone={s.fee_model === "savings_share" ? "guide" : "signal"}
                      >
                        {s.fee_model.replace(/_/g, " ")}
                      </Badge>
                    </Td>
                    <Td right className="num text-mid">{formatCents(s.goods_cents)}</Td>
                    <Td right className="num text-mid">
                      {formatCents(
                        s.procurement_fee_cents +
                          s.freight_coord_fee_cents +
                          s.savings_share_fee_cents,
                      )}
                    </Td>
                    <Td right>
                      <Money cents={s.net_savings_cents} signed />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
