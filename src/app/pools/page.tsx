import Link from "next/link";

import { formatCents } from "@/lib/crs/money";
import { analyzeCycle, getCurrentBusiness, getCycles } from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  fmtDate,
  Meter,
  Money,
  PageHead,
  relDays,
  StatusBadge,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function PoolsPage() {
  const business = await getCurrentBusiness();
  const cycles = await getCycles();
  const analyses = await Promise.all(cycles.map((c) => analyzeCycle(c.id)));

  const live = analyses.filter(
    (a): a is NonNullable<typeof a> =>
      a !== null && ["open", "locked", "negotiated"].includes(a.cycle.status),
  );
  const settled = analyses.filter(
    (a): a is NonNullable<typeof a> =>
      a !== null && ["confirmed", "shipped", "delivered", "failed"].includes(a.cycle.status),
  );

  return (
    <>
      <PageHead
        eyebrow="CRS Exchange"
        title="Collective purchasing"
        sub="Each cycle pools one zone's demand into a single negotiated order with one supplier, delivered on one consolidated load. Members keep title to their own goods and pay the supplier directly."
      />

      <section className="space-y-4">
        <h2 className="eyebrow">Live cycles</h2>
        {live.length === 0 ? (
          <Card>
            <Empty>No cycles are open.</Empty>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {live.map((a) => (
              <CycleCard key={a.cycle.id} analysis={a} businessId={business.id} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10 space-y-4">
        <h2 className="eyebrow">Confirmed and settled</h2>
        {settled.length === 0 ? (
          <Card>
            <Empty>Nothing settled yet.</Empty>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {settled.map((a) => (
              <CycleCard key={a.cycle.id} analysis={a} businessId={business.id} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function CycleCard({
  analysis,
  businessId,
}: {
  analysis: NonNullable<Awaited<ReturnType<typeof analyzeCycle>>>;
  businessId: string;
}) {
  const { cycle, summary, settlement, screens } = analysis;
  const mine = analysis.commitments.filter((c) => c.business_id === businessId);
  const myCases = mine.reduce((a, c) => a + c.cases, 0);
  const myResult = settlement?.businesses.find((b) => b.businessId === businessId);
  const flagged = screens.filter((s) => !s.ok);

  return (
    <Card className="transition-colors hover:border-ink-600">
      <CardHead
        title={
          <Link href={`/pools/${cycle.id}`} className="hover:text-signal">
            {cycle.name}
          </Link>
        }
        sub={
          <>
            {cycle.zone_name} · {cycle.supplier_name} ·{" "}
            {cycle.status === "open"
              ? `closes ${relDays(cycle.closes_at)}`
              : `delivers ${fmtDate(cycle.delivery_date)}`}
          </>
        }
        right={<StatusBadge status={cycle.status} />}
      />

      <div className="grid grid-cols-3 gap-px border-b border-ink-700 bg-ink-700">
        <Figure label="Pooled volume" value={`${summary.totalCases} cs`} />
        <Figure label="Order value" value={formatCents(summary.goodsCents)} />
        <Figure label="Members in" value={String(summary.participantCount)} />
      </div>

      <div className="space-y-3 px-4 py-3">
        {cycle.status === "open" ? (
          summary.meetsMinimum ? (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-xs">
                <span className="text-guide">
                  Supplier minimum cleared
                </span>
                <span className="num text-mid">
                  {formatCents(summary.goodsCents)} / {formatCents(summary.minOrderCents)}
                </span>
              </div>
              <Meter value={summary.goodsCents} target={summary.minOrderCents} tone="guide" />
            </div>
          ) : (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-xs">
                <span className="text-signal">
                  {formatCents(summary.shortfallCents)} short of the supplier minimum
                </span>
                <span className="num text-mid">
                  {formatCents(summary.goodsCents)} / {formatCents(summary.minOrderCents)}
                </span>
              </div>
              <Meter value={summary.goodsCents} target={summary.minOrderCents} />
            </div>
          )
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {myCases > 0 ? (
            <span className="text-mid">
              Your line:{" "}
              <span className="num font-semibold text-hi">{myCases} cases</span>
              {myResult ? (
                <>
                  {" "}
                  · your position <Money cents={myResult.netSavingsCents} signed />
                </>
              ) : null}
            </span>
          ) : (
            <span className="text-low">You have nothing in this cycle.</span>
          )}

          {summary.goodsSavingsCents > 0 ? (
            <span className="text-mid">
              Pool price advantage{" "}
              <Money cents={summary.goodsSavingsCents} className="font-semibold text-guide" />
            </span>
          ) : null}

          {flagged.length > 0 ? (
            <Badge tone="alert">
              {flagged.length} member{flagged.length === 1 ? "" : "s"} worse off
            </Badge>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-900 px-4 py-2.5">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1 text-sm font-semibold text-hi">{value}</p>
    </div>
  );
}
