import Link from "next/link";

import { formatCents } from "@/lib/crs/money";
import {
  getCurrentBusiness,
  getShipments,
  getShipmentStops,
  getTrackingEvents,
} from "@/lib/db/queries";
import {
  Card,
  CardHead,
  Empty,
  EstimateNote,
  fmtDate,
  fmtDateTime,
  PageHead,
  relDays,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function FreightPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  const business = await getCurrentBusiness();
  const mineOnly = scope !== "network";

  const shipments = await getShipments(mineOnly ? business.id : undefined);
  const detail = await Promise.all(
    shipments.map(async (s) => ({
      shipment: s,
      stops: await getShipmentStops(s.id),
      events: await getTrackingEvents(s.id),
    })),
  );

  const inTransit = shipments.filter((s) =>
    ["in_transit", "tendered", "accepted"].includes(s.status),
  );
  const totalFreight = shipments.reduce(
    (a, s) => a + s.linehaul_cents + s.accessorial_cents,
    0,
  );
  const totalPallets = shipments.reduce((a, s) => a + s.total_pallets, 0);

  return (
    <>
      <PageHead
        eyebrow="Freight management"
        title="Consolidated loads"
        sub="One pooled order becomes one truck with several drops. 90 Express tenders the load to a contracted carrier and divides the charge across the members on it; it owns no equipment."
        right={
          <div className="flex gap-1 rounded border border-ink-600 p-0.5">
            <Link
              href="/freight"
              className={`rounded px-2.5 py-1 text-xs font-semibold ${mineOnly ? "bg-ink-800 text-hi" : "text-mid hover:text-hi"}`}
            >
              Mine
            </Link>
            <Link
              href="/freight?scope=network"
              className={`rounded px-2.5 py-1 text-xs font-semibold ${!mineOnly ? "bg-ink-800 text-hi" : "text-mid hover:text-hi"}`}
            >
              Network
            </Link>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Loads" value={shipments.length} sub={mineOnly ? "Carrying your goods" : "Across the corridor"} />
        <Stat
          label="On the road"
          value={inTransit.length}
          tone={inTransit.length > 0 ? "route" : "neutral"}
          sub={inTransit[0] ? `Arrives ${relDays(inTransit[0].delivery_date)}` : "Nothing moving"}
        />
        <Stat label="Pallets moved" value={totalPallets} />
        <Stat
          label="Carrier charges"
          value={formatCents(totalFreight)}
          sub="Billed by carriers, allocated to members"
        />
      </div>

      {detail.length === 0 ? (
        <Card className="mt-6">
          <Empty>No loads yet.</Empty>
        </Card>
      ) : (
        <div className="mt-6 space-y-6">
          {detail.map(({ shipment, stops, events }) => (
            <Card key={shipment.id}>
              <CardHead
                title={
                  <Link href={`/pools/${shipment.cycle_id}`} className="hover:text-signal">
                    {shipment.cycle_name}
                  </Link>
                }
                sub={
                  <>
                    {shipment.supplier_name} → {shipment.zone_name} ·{" "}
                    {shipment.carrier_name ?? "Unassigned carrier"} ·{" "}
                    {shipment.route_miles} mi · {shipment.total_pallets} pallets ·{" "}
                    {Math.round(shipment.total_weight_lb).toLocaleString()} lb · picked up{" "}
                    {fmtDate(shipment.pickup_date)}
                  </>
                }
                right={<StatusBadge status={shipment.status} />}
              />

              <div className="grid lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <Table>
                    <thead>
                      <tr>
                        <Th>#</Th>
                        <Th>Stop</Th>
                        <Th right>Pallets</Th>
                        <Th right>Leg</Th>
                        <Th>ETA</Th>
                        <Th right>Freight</Th>
                        <Th right>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {stops.map((s) => (
                        <tr
                          key={s.id}
                          className={
                            s.business_id === business.id ? "bg-ink-850" : "hover:bg-ink-850"
                          }
                        >
                          <Td className="num text-low">{s.sequence}</Td>
                          <Td>
                            <p className="font-medium text-hi">{s.business_name}</p>
                            <p className="text-xs text-low">{s.city}</p>
                          </Td>
                          <Td right className="num text-mid">{s.pallets}</Td>
                          <Td right className="num text-mid">{s.miles_from_prev} mi</Td>
                          <Td className="text-xs text-mid">
                            {s.delivered_at
                              ? `Delivered ${fmtDateTime(s.delivered_at)}`
                              : s.eta
                                ? fmtDateTime(s.eta)
                                : "—"}
                            {s.pod_signed_by ? (
                              <span className="block text-low">
                                Signed: {s.pod_signed_by}
                              </span>
                            ) : null}
                          </Td>
                          <Td right className="num text-hi">
                            {formatCents(s.freight_cents)}
                          </Td>
                          <Td right>
                            <StatusBadge status={s.status} />
                          </Td>
                        </tr>
                      ))}
                      <tr className="bg-ink-850">
                        <Td colSpan={5} className="eyebrow">
                          Linehaul {formatCents(shipment.linehaul_cents)} + accessorials{" "}
                          {formatCents(shipment.accessorial_cents)}
                        </Td>
                        <Td right className="num font-semibold text-hi">
                          {formatCents(shipment.linehaul_cents + shipment.accessorial_cents)}
                        </Td>
                        <Td />
                      </tr>
                    </tbody>
                  </Table>
                  <div className="px-4 pb-4">
                    <EstimateNote>
                      Allocation method{" "}
                      <span className="text-mid">
                        {shipment.allocation_method.replace(/_/g, " ")}
                      </span>
                      : linehaul by pallet share, stop charges split evenly,
                      liftgate fees only where the stop needs one.
                    </EstimateNote>
                  </div>
                </div>

                <div className="border-t border-ink-700 lg:border-l lg:border-t-0">
                  <p className="eyebrow px-4 pt-3">Tracking</p>
                  {events.length === 0 ? (
                    <Empty>No events.</Empty>
                  ) : (
                    <ol className="space-y-0 px-4 py-3">
                      {events.map((e, i) => (
                        <li key={e.id} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <span
                              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${i === 0 ? "bg-signal" : "bg-ink-500"}`}
                            />
                            {i < events.length - 1 ? (
                              <span className="w-px flex-1 bg-ink-700" />
                            ) : null}
                          </div>
                          <div className="pb-3">
                            <p className="text-xs font-medium text-hi">{e.message}</p>
                            <p className="text-[11px] text-low">
                              {fmtDateTime(e.occurred_at)}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
