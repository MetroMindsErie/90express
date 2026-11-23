import { CorridorMap } from "@/components/corridor-map";
import { formatCents } from "@/lib/crs/money";
import {
  getBusinesses,
  getCarriers,
  getCurrentBusiness,
  getMembershipPlans,
  getNetworkStats,
  getSupplierCatalog,
  getZones,
} from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  dow,
  PageHead,
  Stat,
  Table,
  Td,
  Th,
  titleCase,
} from "@/components/ui";

import { requireOperator } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function NetworkPage() {
  await requireOperator();
  const [zones, businesses, suppliers, carriers, stats, plans, current] =
    await Promise.all([
      getZones(),
      getBusinesses(),
      getSupplierCatalog(),
      getCarriers(),
      getNetworkStats(),
      getMembershipPlans(),
      getCurrentBusiness(),
    ]);

  const supplierMarks = suppliers.map((s) => ({
    id: s.supplier_id,
    name: s.supplier_name,
    lat: s.origin_lat,
    lng: s.origin_lng,
  }));

  return (
    <>
      <PageHead
        eyebrow="I-77 corridor"
        title="Network"
        sub="Zones are the unit of the business. A zone is a set of members close enough that one truck can serve them in a morning, and large enough that their combined demand clears a supplier's volume break."
      />

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Members" value={stats.members} />
        <Stat label="Active zones" value={stats.active_zones} />
        <Stat label="Suppliers" value={stats.suppliers} />
        <Stat label="Carriers" value={stats.carriers} />
        <Stat label="SKUs" value={stats.skus} />
        <Stat
          label="Membership MRR"
          value={formatCents(stats.mrr_cents)}
          tone="guide"
          sub="Recurring, before coordination fees"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHead
            title="ZoneMap"
            sub="Service radii along the corridor. Your zone is highlighted."
          />
          <div className="p-3">
            <CorridorMap
              highlightZoneId={current.zone_id}
              zones={zones.map((z) => ({
                id: z.id,
                name: z.name,
                lat: z.center_lat,
                lng: z.center_lng,
                radiusMiles: z.radius_miles,
                active: z.active,
                memberCount: z.member_count,
              }))}
              members={businesses.map((b) => ({
                id: b.id,
                name: b.dba ?? b.legal_name,
                lat: b.lat,
                lng: b.lng,
                zoneId: b.zone_id,
              }))}
              suppliers={supplierMarks}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-ink-700 px-4 py-3 text-[11px] text-low">
            <span>● member</span>
            <span className="text-signal">● zone centre</span>
            <span className="text-guide">◆ supplier origin</span>
            <span>dashed radius = planned zone</span>
          </div>
        </Card>

        <div className="space-y-6 lg:col-span-3">
          <Card>
            <CardHead title="Zones" sub="Standing delivery day sets the cycle rhythm for every pool in the zone." />
            <Table>
              <thead>
                <tr>
                  <Th>Zone</Th>
                  <Th>Code</Th>
                  <Th right>Radius</Th>
                  <Th>Delivery day</Th>
                  <Th right>Members</Th>
                  <Th right>Status</Th>
                </tr>
              </thead>
              <tbody>
                {zones.map((z) => (
                  <tr
                    key={z.id}
                    className={z.id === current.zone_id ? "bg-ink-850" : "hover:bg-ink-850"}
                  >
                    <Td className="font-medium text-hi">{z.name}</Td>
                    <Td className="num text-xs text-low">{z.code}</Td>
                    <Td right className="num text-mid">{z.radius_miles} mi</Td>
                    <Td className="text-mid">{dow(z.delivery_dow)}</Td>
                    <Td right className="num text-hi">{z.member_count}</Td>
                    <Td right>
                      {z.active ? (
                        <Badge tone="guide">active</Badge>
                      ) : (
                        <Badge>planned</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHead title="Members" />
            <Table>
              <thead>
                <tr>
                  <Th>Business</Th>
                  <Th>Segment</Th>
                  <Th>Zone</Th>
                  <Th>City</Th>
                  <Th>Receiving</Th>
                  <Th right>Plan</Th>
                </tr>
              </thead>
              <tbody>
                {businesses.map((b) => (
                  <tr
                    key={b.id}
                    className={b.id === current.id ? "bg-ink-850" : "hover:bg-ink-850"}
                  >
                    <Td className="font-medium text-hi">{b.dba ?? b.legal_name}</Td>
                    <Td className="text-xs text-mid">{titleCase(b.segment)}</Td>
                    <Td className="text-xs text-mid">{b.zone_name}</Td>
                    <Td className="text-xs text-mid">{b.city}</Td>
                    <Td className="text-xs text-mid">{titleCase(b.dock_type)}</Td>
                    <Td right>
                      <Badge tone={b.membership_tier === "premium" ? "signal" : "neutral"}>
                        {b.membership_tier}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHead
            title="Contracted carriers"
            sub="90 Express owns no equipment. Loads are tendered to these carriers at the rates shown."
          />
          <Table>
            <thead>
              <tr>
                <Th>Carrier</Th>
                <Th>Equipment</Th>
                <Th right>Capacity</Th>
                <Th right>Per mile</Th>
                <Th right>Minimum</Th>
                <Th right>Per stop</Th>
              </tr>
            </thead>
            <tbody>
              {carriers.map((c) => (
                <tr key={c.id} className="hover:bg-ink-850">
                  <Td>
                    <p className="font-medium text-hi">{c.name}</p>
                    <p className="num text-xs text-low">{c.mc_number}</p>
                  </Td>
                  <Td className="text-xs text-mid">{titleCase(c.equipment)}</Td>
                  <Td right className="num text-mid">{c.capacity_pallets} plt</Td>
                  <Td right className="num text-mid">
                    {formatCents(c.linehaul_rate_cents)}
                  </Td>
                  <Td right className="num text-mid">
                    {formatCents(c.min_charge_cents)}
                  </Td>
                  <Td right className="num text-mid">
                    {formatCents(c.stop_charge_cents)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHead
            title="Membership"
            sub="Recurring revenue, separate from per-cycle coordination fees."
          />
          <Table>
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th right>Monthly</Th>
                <Th right>Agent add-on</Th>
                <Th right>Members</Th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.tier} className="hover:bg-ink-850">
                  <Td>
                    <p className="font-medium capitalize text-hi">{p.tier}</p>
                    <p className="text-xs leading-snug text-low">{p.description}</p>
                  </Td>
                  <Td right className="num text-hi">{formatCents(p.monthly_cents)}</Td>
                  <Td right className="num text-mid">
                    {p.agent_addon_cents > 0 ? formatCents(p.agent_addon_cents) : "included"}
                  </Td>
                  <Td right className="num text-mid">{p.member_count}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
