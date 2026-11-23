import Link from "next/link";

import { daysToDepletion } from "@/lib/crs/agent";
import { formatCents } from "@/lib/crs/money";
import {
  getCurrentBusiness,
  getCycles,
  getInventory,
  getProposals,
  getSettlements,
  getShipments,
} from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  EstimateNote,
  fmtDate,
  LinkButton,
  Money,
  PageHead,
  relDays,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
  titleCase,
} from "@/components/ui";

export default async function DashboardPage() {
  const business = await getCurrentBusiness();
  const [cycles, inventory, proposals, settlements, shipments] = await Promise.all([
    getCycles(),
    getInventory(business.id),
    getProposals(business.id),
    getSettlements(business.id),
    getShipments(business.id),
  ]);

  const zoneCycles = cycles.filter(
    (c) => c.zone_id === business.zone_id && ["open", "negotiated"].includes(c.status),
  );
  const pending = proposals.filter((p) => p.status === "pending");
  const lifetimeSavings = settlements.reduce((a, s) => a + s.net_savings_cents, 0);
  const lifetimeSpend = settlements.reduce((a, s) => a + s.goods_cents, 0);
  const inbound = shipments.filter((s) => s.status !== "delivered");

  // Items that will run out before the next zone delivery lands.
  const nextDelivery = zoneCycles[0]?.delivery_date;
  const horizonDays = nextDelivery
    ? Math.max(
        0,
        (new Date(nextDelivery).getTime() - Date.now()) / 86_400_000,
      )
    : 7;

  const atRisk = inventory
    .map((i) => ({
      item: i,
      days: daysToDepletion({
        productId: i.product_id,
        onHandCases: Number(i.on_hand_cases),
        avgWeeklyCases: Number(i.avg_weekly_cases),
        parCases: Number(i.par_cases),
        safetyDays: i.safety_days,
      }),
    }))
    .filter((x) => Number.isFinite(x.days) && x.days <= horizonDays + 7)
    .slice(0, 6);

  return (
    <>
      <PageHead
        eyebrow={`${business.zone_name} · I-77`}
        title={business.dba ?? business.legal_name}
        sub={
          <>
            {titleCase(business.segment)} in {business.city}, {business.state} ·{" "}
            <Badge tone="route">{business.membership_tier}</Badge> membership ·{" "}
            {titleCase(business.dock_type)} receiving
          </>
        }
        right={<LinkButton href="/pools" tone="signal">Browse open pools</LinkButton>}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Net savings to date"
          value={formatCents(lifetimeSavings)}
          tone={lifetimeSavings >= 0 ? "guide" : "alert"}
          sub={
            settlements.length > 0
              ? `Across ${settlements.length} settled cycle${settlements.length === 1 ? "" : "s"} on ${formatCents(lifetimeSpend)} of goods`
              : "No settled cycles yet"
          }
        />
        <Stat
          label="Open pools in your zone"
          value={zoneCycles.length}
          sub={
            zoneCycles[0]
              ? `Next closes ${relDays(zoneCycles[0].closes_at)}`
              : "Nothing open right now"
          }
        />
        <Stat
          label="Awaiting your approval"
          value={pending.length}
          tone={pending.length > 0 ? "signal" : "neutral"}
          sub={
            pending.length > 0
              ? `${formatCents(pending.reduce((a, p) => a + p.est_total_cents, 0))} proposed by your agent`
              : "Agent has nothing waiting"
          }
        />
        <Stat
          label="Inbound deliveries"
          value={inbound.length}
          tone={inbound.length > 0 ? "route" : "neutral"}
          sub={
            inbound[0]
              ? `${inbound[0].zone_name} load arrives ${relDays(inbound[0].delivery_date)}`
              : "Nothing on the road"
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHead
              title="Collective purchasing open to you"
              sub="Pools running in your zone. Committing adds your volume to the zone's negotiating position."
              right={<LinkButton href="/pools">All pools</LinkButton>}
            />
            {zoneCycles.length === 0 ? (
              <Empty>No pool is open in {business.zone_name} right now.</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Cycle</Th>
                    <Th>Supplier</Th>
                    <Th>Window</Th>
                    <Th>Delivers</Th>
                    <Th right>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {zoneCycles.map((c) => (
                    <tr key={c.id} className="hover:bg-ink-850">
                      <Td>
                        <Link
                          href={`/pools/${c.id}`}
                          className="font-medium text-hi hover:text-signal"
                        >
                          {c.name}
                        </Link>
                      </Td>
                      <Td className="text-mid">{c.supplier_name}</Td>
                      <Td className="text-mid">
                        {c.status === "open"
                          ? `Closes ${relDays(c.closes_at)}`
                          : `Closed ${relDays(c.closes_at)}`}
                      </Td>
                      <Td className="num text-mid">{fmtDate(c.delivery_date)}</Td>
                      <Td right>
                        <StatusBadge status={c.status} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHead
              title="Running low before the next delivery"
              sub={
                nextDelivery
                  ? `Measured against the ${fmtDate(nextDelivery)} load and each item's own safety buffer.`
                  : "Measured against a one-week horizon."
              }
              right={<LinkButton href="/inventory">Inventory</LinkButton>}
            />
            {atRisk.length === 0 ? (
              <Empty>Nothing crosses its reorder point in this window.</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th right>On hand</Th>
                    <Th right>Weekly use</Th>
                    <Th right>Days left</Th>
                    <Th right>Par</Th>
                  </tr>
                </thead>
                <tbody>
                  {atRisk.map(({ item, days }) => {
                    const critical = days <= horizonDays;
                    return (
                      <tr key={item.id} className="hover:bg-ink-850">
                        <Td>
                          <span className="font-medium text-hi">{item.product_name}</span>
                          <span className="ml-2 text-xs text-low">{item.product_sku}</span>
                        </Td>
                        <Td right className="num text-mid">{item.on_hand_cases}</Td>
                        <Td right className="num text-mid">{item.avg_weekly_cases}</Td>
                        <Td right>
                          <span className={`num font-semibold ${critical ? "text-alert" : "text-signal"}`}>
                            {days.toFixed(1)}
                          </span>
                        </Td>
                        <Td right className="num text-low">{item.par_cases}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHead
              title="Agent inbox"
              sub="Proposals your procurement agent could not approve on its own."
              right={<LinkButton href="/agent">Agent</LinkButton>}
            />
            {pending.length === 0 ? (
              <Empty>Nothing waiting on you.</Empty>
            ) : (
              <ul className="divide-y divide-ink-800">
                {pending.slice(0, 4).map((p) => (
                  <li key={p.id} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-medium text-hi">
                        {p.cases} × {p.product_name}
                      </p>
                      <span className="num text-sm text-signal">
                        {formatCents(p.est_total_cents)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-mid">
                      {p.days_to_depletion.toFixed(1)} days of cover left · {p.cycle_name}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHead
              title="Settled cycles"
              sub="What each delivered pool actually cost you against buying it alone."
            />
            {settlements.length === 0 ? (
              <Empty>No settled cycles yet.</Empty>
            ) : (
              <ul className="divide-y divide-ink-800">
                {settlements.slice(0, 5).map((s) => (
                  <li key={s.id} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <Link
                        href={`/pools/${s.cycle_id}`}
                        className="truncate text-sm font-medium text-hi hover:text-signal"
                      >
                        {s.cycle_name}
                      </Link>
                      <Money cents={s.net_savings_cents} signed />
                    </div>
                    <p className="mt-1 text-xs text-mid">
                      {fmtDate(s.delivery_date)} · {formatCents(s.goods_cents)} goods ·{" "}
                      {s.fee_model === "savings_share"
                        ? "savings-share fee"
                        : "spend-based fee"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <div className="px-4 pb-4">
              <EstimateNote>
                Savings compare each order against a benchmark LTL rate for the
                same goods shipped to you alone. Benchmarks, not rated quotes.
              </EstimateNote>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
