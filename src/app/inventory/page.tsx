import { daysToDepletion } from "@/lib/crs/agent";
import { formatCents } from "@/lib/crs/money";
import { getCurrentBusiness, getCycles, getInventory } from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  fmtDate,
  Meter,
  PageHead,
  Stat,
  Table,
  Td,
  Th,
  titleCase,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const business = await getCurrentBusiness();
  const [inventory, cycles] = await Promise.all([
    getInventory(business.id),
    getCycles(),
  ]);

  const nextCycle = cycles.find(
    (c) => c.zone_id === business.zone_id && c.status === "open",
  );
  const horizonDays = nextCycle
    ? Math.max(0, (new Date(nextCycle.delivery_date).getTime() - Date.now()) / 86_400_000)
    : 7;

  const rows = inventory.map((i) => {
    const days = daysToDepletion({
      productId: i.product_id,
      onHandCases: Number(i.on_hand_cases),
      avgWeeklyCases: Number(i.avg_weekly_cases),
      parCases: Number(i.par_cases),
      safetyDays: i.safety_days,
    });
    const dailyUse = Number(i.avg_weekly_cases) / 7;
    const projectedAtDelivery = Math.max(
      0,
      Number(i.on_hand_cases) - dailyUse * horizonDays,
    );
    const gap = Math.max(0, Math.ceil(Number(i.par_cases) - projectedAtDelivery));
    const needsOrder = days <= horizonDays + i.safety_days && gap > 0;
    return { item: i, days, projectedAtDelivery, gap, needsOrder };
  });

  const due = rows.filter((r) => r.needsOrder);
  const dueValue = due.reduce((a, r) => a + r.gap * r.item.list_price_cents, 0);

  return (
    <>
      <PageHead
        eyebrow={business.dba ?? business.legal_name}
        title="Inventory"
        sub={
          nextCycle
            ? `Positions measured against the ${fmtDate(nextCycle.delivery_date)} delivery from ${nextCycle.supplier_name}. "Due" means stock runs below par before that load arrives, allowing for each item's safety buffer.`
            : "No open cycle in your zone, so positions are measured against a one-week horizon."
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Tracked items" value={inventory.length} />
        <Stat
          label="Due this cycle"
          value={due.length}
          tone={due.length > 0 ? "signal" : "guide"}
          sub={
            nextCycle
              ? `Before the ${fmtDate(nextCycle.delivery_date)} load`
              : "Within a week"
          }
        />
        <Stat
          label="Replenishment value"
          value={formatCents(dueValue)}
          sub="At list price, before any pool discount"
        />
        <Stat
          label="Shortest cover"
          value={
            rows.length > 0 && Number.isFinite(rows[0].days)
              ? `${rows[0].days.toFixed(1)}d`
              : "—"
          }
          tone={rows[0] && rows[0].days <= horizonDays ? "alert" : "neutral"}
          sub={rows[0]?.item.product_name}
        />
      </div>

      <Card className="mt-6">
        <CardHead
          title="Positions"
          sub="Sorted by days of cover. Weekly use is observed consumption; in production it comes from POS or usage history rather than a manual count."
        />
        {rows.length === 0 ? (
          <Empty>No inventory tracked for this member yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>Supplier</Th>
                <Th right>On hand</Th>
                <Th right>Weekly</Th>
                <Th right>Days left</Th>
                <Th>Cover to delivery</Th>
                <Th right>Par</Th>
                <Th right>Suggested</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, days, gap, needsOrder }) => {
                const critical = days <= horizonDays;
                return (
                  <tr key={item.id} className="hover:bg-ink-850">
                    <Td>
                      <p className="font-medium text-hi">{item.product_name}</p>
                      <p className="text-xs text-low">
                        {item.product_sku} · {titleCase(item.category)}
                      </p>
                    </Td>
                    <Td className="text-xs text-mid">{item.supplier_name}</Td>
                    <Td right className="num text-hi">{item.on_hand_cases}</Td>
                    <Td right className="num text-mid">{item.avg_weekly_cases}</Td>
                    <Td right>
                      <span
                        className={`num font-semibold ${
                          critical ? "text-alert" : needsOrder ? "text-signal" : "text-guide"
                        }`}
                      >
                        {Number.isFinite(days) ? days.toFixed(1) : "—"}
                      </span>
                    </Td>
                    <Td className="w-32">
                      <Meter
                        value={Math.min(days, horizonDays + item.safety_days)}
                        target={horizonDays + item.safety_days}
                        tone={critical ? "signal" : "guide"}
                      />
                    </Td>
                    <Td right className="num text-low">{item.par_cases}</Td>
                    <Td right>
                      {needsOrder ? (
                        <span className="num font-semibold text-signal">{gap}</span>
                      ) : (
                        <span className="text-low">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <div className="flex flex-wrap gap-4 border-t border-ink-700 px-4 py-3 text-xs text-low">
          <span>
            <Badge tone="alert">critical</Badge> runs out before the load arrives
          </span>
          <span>
            <Badge tone="signal">due</Badge> runs below par within its safety buffer
          </span>
          <span>
            <Badge tone="guide">covered</Badge> holds past the next delivery
          </span>
        </div>
      </Card>
    </>
  );
}
