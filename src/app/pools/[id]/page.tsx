import { notFound } from "next/navigation";

import { commitCases } from "@/app/actions";
import { formatCents } from "@/lib/crs/money";
import { LTL_BENCHMARK } from "@/lib/crs/freight";
import {
  analyzeCycle,
  getCurrentBusiness,
  getProductsBySupplier,
} from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  EstimateNote,
  fmtDate,
  fmtDateTime,
  Meter,
  Money,
  PageHead,
  relDays,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function PoolDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [analysis, business] = await Promise.all([
    analyzeCycle(id),
    getCurrentBusiness(),
  ]);
  if (!analysis) notFound();

  const { cycle, commitments, lines, summary, load, settlement, screens } = analysis;
  const catalog = await getProductsBySupplier(cycle.supplier_id);

  const myLines = new Map(
    commitments.filter((c) => c.business_id === business.id).map((c) => [c.product_id, c.cases]),
  );
  const myResult = settlement?.businesses.find((b) => b.businessId === business.id);
  const flagged = screens.filter((s) => !s.ok);
  // A member can only join its own zone's cycle: every member on a cycle
  // becomes a stop on that cycle's truck.
  const inZone = business.zone_id === cycle.zone_id;
  const isOpen = cycle.status === "open" && inZone;

  return (
    <>
      <PageHead
        eyebrow={`${cycle.zone_name} · ${cycle.supplier_name}`}
        title={cycle.name}
        sub={
          <>
            {isOpen
              ? `Open until ${fmtDateTime(cycle.closes_at)} (${relDays(cycle.closes_at)})`
              : `Window closed ${fmtDate(cycle.closes_at)}`}{" "}
            · delivers {fmtDate(cycle.delivery_date)} · supplier terms{" "}
            {cycle.supplier_terms}, {cycle.supplier_lead_days}-day lead
            {cycle.notes ? ` · ${cycle.notes}` : ""}
          </>
        }
        right={<StatusBadge status={cycle.status} />}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Pooled volume"
          value={`${summary.totalCases} cs`}
          sub={`${summary.participantCount} members across ${lines.length} SKUs`}
        />
        <Stat
          label="Collective order value"
          value={formatCents(summary.goodsCents)}
          sub={
            summary.meetsMinimum
              ? `Clears the ${formatCents(summary.minOrderCents)} supplier minimum`
              : `${formatCents(summary.shortfallCents)} short of the minimum`
          }
          tone={summary.meetsMinimum ? "guide" : "signal"}
        />
        <Stat
          label="Price advantage on goods"
          value={formatCents(summary.goodsSavingsCents)}
          tone={summary.goodsSavingsCents > 0 ? "guide" : "neutral"}
          sub="Pooled tier price against what each member reaches on its own volume"
        />
        <Stat
          label="Your position"
          value={myResult ? formatCents(myResult.netSavingsCents) : "—"}
          tone={
            myResult ? (myResult.netSavingsCents >= 0 ? "guide" : "alert") : "neutral"
          }
          sub={
            myResult
              ? `After freight and fees, against buying alone`
              : "You have no line in this cycle"
          }
        />
      </div>

      {!summary.meetsMinimum && isOpen ? (
        <Card className="mt-6 border-signal/40">
          <div className="px-4 py-3">
            <p className="text-sm font-semibold text-signal">
              This pool cannot be placed yet
            </p>
            <p className="mt-1 text-sm text-mid">
              {cycle.supplier_name} releases a negotiated collective order at{" "}
              {formatCents(summary.minOrderCents)}. The zone has committed{" "}
              {formatCents(summary.goodsCents)} — another{" "}
              <span className="num font-semibold text-hi">
                {formatCents(summary.shortfallCents)}
              </span>{" "}
              is needed before {fmtDate(cycle.closes_at)}, or the cycle fails and
              every commitment is released.
            </p>
            <div className="mt-3">
              <Meter value={summary.goodsCents} target={summary.minOrderCents} />
            </div>
          </div>
        </Card>
      ) : null}

      {flagged.length > 0 ? (
        <Card className="mt-6 border-alert/40">
          <CardHead
            title={`${flagged.length} member${flagged.length === 1 ? " is" : "s are"} worse off in this pool`}
            sub="Run before tendering. A member who loses money in the pool works it out from their own invoices eventually."
          />
          <ul className="divide-y divide-ink-800">
            {flagged.map((s) => (
              <li key={s.businessId} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-hi">
                    {analysis.businessNames.get(s.businessId) ?? s.businessId}
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge tone="alert">{s.cause}</Badge>
                    <Money cents={s.netSavingsCents} signed className="text-sm" />
                  </div>
                </div>
                <p className="mt-1 text-sm text-mid">{s.finding}</p>
                <p className="mt-1 text-sm text-signal">{s.remedy}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Card>
            <CardHead
              title="Demand board"
              sub={
                cycle.status === "open"
                  ? "Live aggregate demand. The pooled quantity sets the tier, so one member's cases lower everyone's price."
                  : "Aggregate demand as of window close, with the price the supplier actually granted."
              }
            />
            {lines.length === 0 ? (
              <Empty>No commitments yet. Be the first line on this cycle.</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th right>Pooled</Th>
                    <Th right>List</Th>
                    <Th right>Pool price</Th>
                    <Th right>Saved</Th>
                    <Th>Next break</Th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.product.id} className="hover:bg-ink-850">
                      <Td>
                        <p className="font-medium text-hi">{line.product.name}</p>
                        <p className="text-xs text-low">
                          {line.product.sku} · {line.product.packDescription} ·{" "}
                          {line.participantCount} member
                          {line.participantCount === 1 ? "" : "s"}
                        </p>
                      </Td>
                      <Td right className="num text-hi">{line.totalCases}</Td>
                      <Td right className="num text-low line-through">
                        {formatCents(line.listPriceCents)}
                      </Td>
                      <Td right>
                        <span className="num font-semibold text-hi">
                          {formatCents(line.effectiveUnitCents)}
                        </span>
                        {line.grantedUnitCents !== null &&
                        line.grantedUnitCents !== line.poolUnitCents ? (
                          <p className="text-[11px] text-guide">
                            negotiated under the {formatCents(line.poolUnitCents)} ladder
                          </p>
                        ) : null}
                      </Td>
                      <Td right>
                        <Money cents={line.goodsSavingsCents} signed />
                      </Td>
                      <Td>
                        {line.nextTier ? (
                          <span className="text-xs text-signal">
                            {line.nextTier.casesNeeded} more cases →{" "}
                            {formatCents(line.nextTier.tier.unitPriceCents)}
                            <span className="text-low">
                              {" "}
                              (saves {formatCents(line.nextTier.unitSavingsCents)}/case)
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-low">Top of ladder</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {load ? (
            <Card className="mt-6">
              <CardHead
                title="Consolidated load"
                sub={`${load.carrier.name} · ${load.routeMiles} route miles from ${cycle.supplier_name} · ${load.totalPallets} pallets · ${Math.round(load.totalWeightLb).toLocaleString()} lb`}
                right={
                  <span className="eyebrow">
                    {load.allocationMethod.replace(/_/g, " ")}
                  </span>
                }
              />
              {load.warnings.length > 0 ? (
                <div className="border-b border-ink-700 bg-alert-dim/40 px-4 py-2">
                  {load.warnings.map((w) => (
                    <p key={w} className="text-xs text-alert">
                      {w}
                    </p>
                  ))}
                </div>
              ) : null}
              <Table>
                <thead>
                  <tr>
                    <Th>Stop</Th>
                    <Th>Member</Th>
                    <Th right>Pallets</Th>
                    <Th right>Leg mi</Th>
                    <Th right>Linehaul</Th>
                    <Th right>Stop + gate</Th>
                    <Th right>Freight due</Th>
                  </tr>
                </thead>
                <tbody>
                  {load.stops.map((s) => (
                    <tr
                      key={s.businessId}
                      className={
                        s.businessId === business.id ? "bg-ink-850" : "hover:bg-ink-850"
                      }
                    >
                      <Td className="num text-low">{s.sequence}</Td>
                      <Td className="text-hi">
                        {analysis.businessNames.get(s.businessId)}
                        {s.needsLiftgate ? (
                          <span className="ml-2 text-xs text-low">liftgate</span>
                        ) : null}
                      </Td>
                      <Td right className="num text-mid">{s.pallets}</Td>
                      <Td right className="num text-mid">{s.milesFromPrev}</Td>
                      <Td right className="num text-mid">
                        {formatCents(s.linehaulShareCents)}
                      </Td>
                      <Td right className="num text-mid">
                        {formatCents(s.stopShareCents + s.liftgateCents)}
                      </Td>
                      <Td right className="num font-semibold text-hi">
                        {formatCents(s.freightCents)}
                      </Td>
                    </tr>
                  ))}
                  <tr className="bg-ink-850">
                    <Td colSpan={4} className="eyebrow">
                      Carrier charge
                    </Td>
                    <Td right className="num text-mid">
                      {formatCents(load.linehaulCents)}
                    </Td>
                    <Td right className="num text-mid">
                      {formatCents(load.accessorialCents)}
                    </Td>
                    <Td right className="num font-semibold text-hi">
                      {formatCents(load.totalFreightCents)}
                    </Td>
                  </tr>
                </tbody>
              </Table>
              <div className="px-4 pb-4">
                <EstimateNote>
                  Linehaul is divided by each member&apos;s share of pallet
                  positions; stop charges split evenly; liftgate fees fall only
                  on stops that need one.
                  {load.allocationMethod === "ltl_capped" ? (
                    <>
                      {" "}
                      No member is billed above what its own LTL shipment would
                      cost — {load.stops.filter((s) => s.cappedAtBenchmark).length}{" "}
                      stop
                      {load.stops.filter((s) => s.cappedAtBenchmark).length === 1
                        ? " is"
                        : "s are"}{" "}
                      held at that cap, and the excess is spread across members
                      still below theirs.
                    </>
                  ) : null}{" "}
                  Route miles are straight-line distance with a 1.15 circuity
                  factor, not a routed distance.
                </EstimateNote>
              </div>
            </Card>
          ) : null}

          {settlement ? (
            <Card className="mt-6">
              <CardHead
                title={cycle.status === "delivered" ? "Settlement" : "Settlement preview"}
                sub={
                  cycle.fee_model === "savings_share"
                    ? `90 Express takes ${(cycle.savings_share_bps / 100).toFixed(1)}% of verified savings, capped so fees can never exceed what the pool saved.`
                    : `90 Express charges ${(cycle.procurement_fee_bps / 100).toFixed(2)}% of goods plus ${formatCents(cycle.freight_coord_fee_cents)} per stop.`
                }
                right={
                  <Badge tone={cycle.fee_model === "savings_share" ? "guide" : "signal"}>
                    {cycle.fee_model.replace(/_/g, " ")}
                  </Badge>
                }
              />
              <Table>
                <thead>
                  <tr>
                    <Th>Member</Th>
                    <Th right>Goods</Th>
                    <Th right>Freight</Th>
                    <Th right>90X fee</Th>
                    <Th right>Total due</Th>
                    <Th right>Alone</Th>
                    <Th right>Net</Th>
                  </tr>
                </thead>
                <tbody>
                  {settlement.businesses.map((b) => (
                    <tr
                      key={b.businessId}
                      className={
                        b.businessId === business.id ? "bg-ink-850" : "hover:bg-ink-850"
                      }
                    >
                      <Td className="text-hi">
                        {analysis.businessNames.get(b.businessId)}
                      </Td>
                      <Td right className="num text-mid">{formatCents(b.goodsCents)}</Td>
                      <Td right className="num text-mid">{formatCents(b.freightCents)}</Td>
                      <Td right className="num text-mid">{formatCents(b.feesCents)}</Td>
                      <Td right className="num font-semibold text-hi">
                        {formatCents(b.totalDueCents)}
                      </Td>
                      <Td right className="num text-low">{formatCents(b.soloTotalCents)}</Td>
                      <Td right>
                        <Money cents={b.netSavingsCents} signed className="font-semibold" />
                      </Td>
                    </tr>
                  ))}
                  <tr className="bg-ink-850">
                    <Td className="eyebrow">Cycle</Td>
                    <Td right className="num text-mid">{formatCents(settlement.goodsCents)}</Td>
                    <Td right className="num text-mid">{formatCents(settlement.freightCents)}</Td>
                    <Td right className="num text-signal">
                      {formatCents(settlement.feeRevenueCents)}
                    </Td>
                    <Td right />
                    <Td right />
                    <Td right>
                      <Money
                        cents={settlement.netSavingsCents}
                        signed
                        className="font-semibold"
                      />
                    </Td>
                  </tr>
                </tbody>
              </Table>
              <div className="px-4 pb-4">
                {settlement.quotedCount === settlement.businesses.length ? (
                  <p className="mt-3 flex gap-2 border-l-2 border-guide pl-3 text-xs leading-relaxed text-mid">
                    <span className="font-semibold text-guide">Quoted</span>
                    <span>
                      &ldquo;Alone&rdquo; prices the same cases at the volume break
                      that member reaches on its own, plus a rated carrier quote
                      for shipping that order alone from {cycle.supplier_name}.
                      These are quoted figures, not benchmarks.
                    </span>
                  </p>
                ) : (
                  <EstimateNote>
                    &ldquo;Alone&rdquo; prices the same cases at the volume break
                    that member reaches on its own, plus the cost of shipping that
                    order alone from {cycle.supplier_name}.{" "}
                    {settlement.quotedCount > 0
                      ? `${settlement.quotedCount} of ${settlement.businesses.length} members have a rated carrier quote; the rest use a benchmark (${formatCents(LTL_BENCHMARK.minChargeCents)} minimum charge, ${LTL_BENCHMARK.centsPerPalletMile}¢ per pallet-mile).`
                      : `No carrier has rated these shipments yet, so a benchmark is used (${formatCents(LTL_BENCHMARK.minChargeCents)} minimum charge, ${LTL_BENCHMARK.centsPerPalletMile}¢ per pallet-mile).`}{" "}
                    Rate the cycle from the Integrations console to replace the
                    benchmark with quoted figures.
                  </EstimateNote>
                )}
              </div>
            </Card>
          ) : null}
        </div>

        <div>
          <Card>
            <CardHead
              title="Your line"
              sub={
                !inZone
                  ? `${business.dba ?? business.legal_name} is in ${business.zone_name}. This cycle delivers to ${cycle.zone_name}, and every member on a cycle becomes a stop on its truck — so joining is limited to members of that zone.`
                  : isOpen
                    ? "Set your cases per SKU. Changes are live until the window closes."
                    : "This window is closed. Demand is frozen at what the supplier quoted."
              }
            />
            <div className="divide-y divide-ink-800">
              {catalog.map((p) => {
                const current = myLines.get(p.id) ?? 0;
                const poolLine = lines.find((l) => l.product.id === p.id);
                return (
                  <div key={p.id} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-hi">{p.name}</p>
                      <span className="num text-xs text-mid">
                        {formatCents(poolLine?.effectiveUnitCents ?? p.list_price_cents)}
                        <span className="text-low">/cs</span>
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-low">
                      {p.pack_description} · {p.cases_per_pallet}/pallet
                      {poolLine ? ` · pool at ${poolLine.totalCases} cs` : ""}
                    </p>
                    {isOpen ? (
                      <form action={commitCases} className="mt-2 flex items-center gap-2">
                        <input type="hidden" name="cycleId" value={cycle.id} />
                        <input type="hidden" name="businessId" value={business.id} />
                        <input type="hidden" name="productId" value={p.id} />
                        <label htmlFor={`cases-${p.id}`} className="sr-only">
                          Cases of {p.name}
                        </label>
                        <input
                          id={`cases-${p.id}`}
                          name="cases"
                          type="number"
                          min={0}
                          max={100000}
                          defaultValue={current}
                          className="num w-20 rounded border border-ink-600 bg-ink-850 px-2 py-1 text-sm text-hi"
                        />
                        <button
                          type="submit"
                          className="rounded border border-ink-600 px-2.5 py-1 text-xs font-semibold text-hi transition-colors hover:border-signal hover:text-signal"
                        >
                          {current > 0 ? "Update" : "Commit"}
                        </button>
                        {current > 0 ? (
                          <span className="text-xs text-guide">in pool</span>
                        ) : null}
                      </form>
                    ) : (
                      <p className="mt-1 num text-xs text-mid">
                        {current > 0 ? `${current} cases committed` : "—"}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {myResult ? (
            <Card className="mt-6">
              <CardHead title="Your settlement detail" />
              <Table>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th right>Cs</Th>
                    <Th right>Alone</Th>
                    <Th right>Pool</Th>
                  </tr>
                </thead>
                <tbody>
                  {myResult.lines.map((l) => (
                    <tr key={l.product.id}>
                      <Td className="text-hi">{l.product.name}</Td>
                      <Td right className="num text-mid">{l.cases}</Td>
                      <Td right className="num text-low">
                        {formatCents(l.soloUnitCents)}
                      </Td>
                      <Td right className="num text-hi">
                        {formatCents(l.poolUnitCents)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <dl className="space-y-1.5 px-4 py-3 text-sm">
                <Row label="Goods to supplier" cents={myResult.goodsCents} />
                <Row label="Freight to carrier" cents={myResult.freightCents} />
                <Row label="90 Express fee" cents={myResult.feesCents} />
                <div className="my-2 border-t border-ink-700" />
                <Row label="Total due" cents={myResult.totalDueCents} strong />
                <Row
                  label={
                    myResult.soloFreightSource === "quoted"
                      ? "Buying alone (quoted)"
                      : "Buying alone (est.)"
                  }
                  cents={myResult.soloTotalCents}
                  muted
                />
                <div className="flex items-baseline justify-between pt-1">
                  <dt className="text-sm font-semibold text-hi">Your net</dt>
                  <dd>
                    <Money
                      cents={myResult.netSavingsCents}
                      signed
                      className="text-base font-semibold"
                    />
                  </dd>
                </div>
              </dl>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  cents,
  strong,
  muted,
}: {
  label: string;
  cents: number;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={muted ? "text-low" : "text-mid"}>{label}</dt>
      <dd
        className={`num ${strong ? "font-semibold text-hi" : muted ? "text-low" : "text-mid"}`}
      >
        {formatCents(cents)}
      </dd>
    </div>
  );
}
