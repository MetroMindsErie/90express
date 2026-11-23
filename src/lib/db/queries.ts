/**
 * Data access for the app.
 *
 * Reads return plain rows. Anything economic — pooled pricing, freight
 * allocation, settlement — is computed by the engine in src/lib/crs from
 * those rows rather than stored and trusted, so a catalog or ladder change
 * is reflected immediately and every number on screen is reproducible.
 */
import { redirect } from "next/navigation";

import { getActingBusinessId, requireUser } from "@/lib/auth/session";

import { planLoad, type Carrier } from "@/lib/crs/freight";
import {
  buildPoolLines,
  summarizePool,
  type Commitment,
  type PoolLine,
  type Product,
} from "@/lib/crs/pricing";
import {
  screenParticipants,
  settleCycle,
  type CycleSettlement,
  type FeeModel,
  type ParticipantScreen,
} from "@/lib/crs/settlement";
import { quotedSoloFreight } from "@/lib/integrations/sync";
import { sql } from "./client";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type ZoneRow = {
  id: string;
  code: string;
  name: string;
  corridor: string;
  center_lat: number;
  center_lng: number;
  radius_miles: number;
  delivery_dow: number;
  active: boolean;
  member_count: number;
};

export type BusinessRow = {
  id: string;
  zone_id: string;
  zone_name: string;
  zone_code: string;
  legal_name: string;
  dba: string | null;
  segment: string;
  contact_name: string;
  contact_email: string;
  city: string;
  state: string;
  street: string;
  postal_code: string;
  lat: number;
  lng: number;
  dock_type: "dock" | "liftgate" | "ground";
  membership_tier: "starter" | "standard" | "premium";
  status: string;
};

export type CycleRow = {
  id: string;
  name: string;
  status:
    | "open"
    | "locked"
    | "negotiated"
    | "confirmed"
    | "shipped"
    | "delivered"
    | "failed";
  zone_id: string;
  zone_name: string;
  supplier_id: string;
  supplier_name: string;
  supplier_lat: number;
  supplier_lng: number;
  supplier_terms: string;
  supplier_lead_days: number;
  opens_at: Date;
  closes_at: Date;
  delivery_date: Date;
  min_order_cents: number;
  procurement_fee_bps: number;
  freight_coord_fee_cents: number;
  fee_model: "spend_bps" | "savings_share";
  savings_share_bps: number;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** Hydrate products with their volume ladders into engine-ready shape. */
export async function loadProducts(supplierId?: string): Promise<Map<string, Product>> {
  const rows = await sql<
    Array<{
      id: string;
      sku: string;
      name: string;
      category: string;
      pack_description: string;
      cases_per_pallet: number;
      case_weight_lb: number;
      list_price_cents: number;
      tiers: Array<{ min_cases: number; unit_price_cents: number }> | null;
    }>
  >`
    select p.id, p.sku, p.name, p.category, p.pack_description,
           p.cases_per_pallet, p.case_weight_lb::float8 as case_weight_lb,
           p.list_price_cents,
           coalesce(
             (select json_agg(json_build_object('min_cases', t.min_cases, 'unit_price_cents', t.unit_price_cents)
                              order by t.min_cases)
              from price_tiers t where t.product_id = p.id),
             '[]'::json
           ) as tiers
    from products p
    where p.active
      ${supplierId ? sql`and p.supplier_id = ${supplierId}` : sql``}
    order by p.category, p.name
  `;

  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        sku: r.sku,
        name: r.name,
        category: r.category,
        packDescription: r.pack_description,
        casesPerPallet: r.cases_per_pallet,
        caseWeightLb: Number(r.case_weight_lb),
        listPriceCents: r.list_price_cents,
        tiers: (r.tiers ?? []).map((t) => ({
          minCases: t.min_cases,
          unitPriceCents: t.unit_price_cents,
        })),
      } satisfies Product,
    ]),
  );
}

export async function getSupplierCatalog() {
  return sql<
    Array<{
      supplier_id: string;
      supplier_name: string;
      origin_city: string;
      origin_state: string;
      origin_lat: number;
      origin_lng: number;
      terms: string;
      lead_time_days: number;
      min_order_cents: number;
      invoices_members_separately: boolean;
      product_count: number;
    }>
  >`
    select s.id as supplier_id, s.name as supplier_name, s.origin_city, s.origin_state,
           s.origin_lat::float8 as origin_lat, s.origin_lng::float8 as origin_lng,
           s.terms, s.lead_time_days, s.min_order_cents, s.invoices_members_separately,
           (select count(*)::int from products p where p.supplier_id = s.id and p.active) as product_count
    from suppliers s
    where s.active
    order by s.name
  `;
}

export async function getProductsBySupplier(supplierId: string) {
  return sql<
    Array<{
      id: string;
      sku: string;
      name: string;
      category: string;
      pack_description: string;
      cases_per_pallet: number;
      case_weight_lb: number;
      list_price_cents: number;
      temp_class: string;
      tiers: Array<{ min_cases: number; unit_price_cents: number }>;
    }>
  >`
    select p.id, p.sku, p.name, p.category, p.pack_description, p.cases_per_pallet,
           p.case_weight_lb::float8 as case_weight_lb, p.list_price_cents, p.temp_class,
           coalesce(
             (select json_agg(json_build_object('min_cases', t.min_cases, 'unit_price_cents', t.unit_price_cents)
                              order by t.min_cases)
              from price_tiers t where t.product_id = p.id),
             '[]'::json
           ) as tiers
    from products p
    where p.supplier_id = ${supplierId} and p.active
    order by p.category, p.name
  `;
}

// ---------------------------------------------------------------------------
// Zones, businesses, carriers
// ---------------------------------------------------------------------------

export async function getZones() {
  return sql<ZoneRow[]>`
    select z.id, z.code, z.name, z.corridor, z.center_lat::float8 as center_lat,
           z.center_lng::float8 as center_lng, z.radius_miles, z.delivery_dow, z.active,
           (select count(*)::int from businesses b where b.zone_id = z.id) as member_count
    from zones z
    order by z.center_lat desc
  `;
}

export async function getBusinesses() {
  return sql<BusinessRow[]>`
    select b.id, b.zone_id, z.name as zone_name, z.code as zone_code, b.legal_name, b.dba,
           b.segment, b.contact_name, b.contact_email, b.city, b.state, b.street, b.postal_code,
           b.lat::float8 as lat, b.lng::float8 as lng, b.dock_type, b.membership_tier, b.status
    from businesses b
    join zones z on z.id = b.zone_id
    order by z.center_lat desc, b.dba
  `;
}

export async function getBusiness(id: string): Promise<BusinessRow | null> {
  const [row] = await sql<BusinessRow[]>`
    select b.id, b.zone_id, z.name as zone_name, z.code as zone_code, b.legal_name, b.dba,
           b.segment, b.contact_name, b.contact_email, b.city, b.state, b.street, b.postal_code,
           b.lat::float8 as lat, b.lng::float8 as lng, b.dock_type, b.membership_tier, b.status
    from businesses b
    join zones z on z.id = b.zone_id
    where b.id = ${id}
  `;
  return row ?? null;
}

/**
 * The member whose view the app is showing.
 *
 * Stands in for authentication. A real deployment puts a session here; the
 * rest of the app only ever asks "which business am I acting for".
 */
/**
 * The member whose console this request is rendering.
 *
 * A member gets their own business and nothing else. An operator gets the one
 * they selected for support; with no selection they get the longest-standing
 * member so the page has something to show, and the header says plainly that
 * they are an operator viewing someone else's console.
 *
 * Redirects to sign-in when there is no session, so every page that calls it
 * is authenticated by construction.
 */
export async function getCurrentBusiness(): Promise<BusinessRow> {
  const user = await requireUser();

  if (user.role === "member") {
    if (!user.businessId) redirect("/signin");
    const own = await getBusiness(user.businessId);
    if (!own) redirect("/signin");
    return own;
  }

  const selected = await getActingBusinessId(user);
  if (selected) {
    const found = await getBusiness(selected);
    if (found) return found;
  }

  const [fallback] = await sql<BusinessRow[]>`
    select b.id, b.zone_id, z.name as zone_name, z.code as zone_code, b.legal_name, b.dba,
           b.segment, b.contact_name, b.contact_email, b.city, b.state, b.street, b.postal_code,
           b.lat::float8 as lat, b.lng::float8 as lng, b.dock_type, b.membership_tier, b.status
    from businesses b
    join zones z on z.id = b.zone_id
    order by b.joined_at
    limit 1
  `;
  return fallback;
}

export async function getCarriers() {
  return sql<
    Array<{
      id: string;
      name: string;
      mc_number: string | null;
      equipment: string;
      capacity_pallets: number;
      max_weight_lb: number;
      linehaul_rate_cents: number;
      min_charge_cents: number;
      stop_charge_cents: number;
      liftgate_fee_cents: number;
    }>
  >`select * from carriers where active order by name`;
}

async function loadCarrier(id: string): Promise<Carrier | null> {
  const [c] = await sql<
    Array<{
      id: string;
      name: string;
      equipment: string;
      capacity_pallets: number;
      max_weight_lb: number;
      linehaul_rate_cents: number;
      min_charge_cents: number;
      stop_charge_cents: number;
      liftgate_fee_cents: number;
    }>
  >`select id, name, equipment, capacity_pallets, max_weight_lb, linehaul_rate_cents,
           min_charge_cents, stop_charge_cents, liftgate_fee_cents
    from carriers where id = ${id}`;
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    equipment: c.equipment,
    capacityPallets: c.capacity_pallets,
    maxWeightLb: c.max_weight_lb,
    linehaulRateCents: c.linehaul_rate_cents,
    minChargeCents: c.min_charge_cents,
    stopChargeCents: c.stop_charge_cents,
    liftgateFeeCents: c.liftgate_fee_cents,
  };
}

/** The carrier whose rates to use for a projection when none is assigned yet. */
async function defaultCarrier(): Promise<Carrier | null> {
  const [row] = await sql<Array<{ id: string }>>`
    select id from carriers where active order by linehaul_rate_cents limit 1
  `;
  return row ? loadCarrier(row.id) : null;
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

const cycleSelect = sql`
  select pc.id, pc.name, pc.status, pc.zone_id, z.name as zone_name,
         pc.supplier_id, s.name as supplier_name,
         s.origin_lat::float8 as supplier_lat, s.origin_lng::float8 as supplier_lng,
         s.terms as supplier_terms, s.lead_time_days as supplier_lead_days,
         pc.opens_at, pc.closes_at, pc.delivery_date, pc.min_order_cents,
         pc.procurement_fee_bps, pc.freight_coord_fee_cents, pc.fee_model,
         pc.savings_share_bps, pc.notes
  from pool_cycles pc
  join zones z on z.id = pc.zone_id
  join suppliers s on s.id = pc.supplier_id
`;

export async function getCycles(): Promise<CycleRow[]> {
  return sql<CycleRow[]>`${cycleSelect} order by
    case pc.status when 'open' then 0 when 'negotiated' then 1 when 'locked' then 2
                   when 'confirmed' then 3 when 'shipped' then 4 else 5 end,
    pc.closes_at`;
}

export async function getCycle(id: string): Promise<CycleRow | null> {
  const [row] = await sql<CycleRow[]>`${cycleSelect} where pc.id = ${id}`;
  return row ?? null;
}

export type CommitmentRow = {
  id: string;
  cycle_id: string;
  business_id: string;
  business_name: string;
  business_city: string;
  business_dock: "dock" | "liftgate" | "ground";
  business_lat: number;
  business_lng: number;
  product_id: string;
  product_name: string;
  product_sku: string;
  cases: number;
  status: string;
  source: string;
  approved_at: Date | null;
};

export async function getCycleCommitments(cycleId: string) {
  return sql<CommitmentRow[]>`
    select c.id, c.cycle_id, c.business_id, coalesce(b.dba, b.legal_name) as business_name,
           b.city as business_city, b.dock_type as business_dock,
           b.lat::float8 as business_lat, b.lng::float8 as business_lng,
           c.product_id, p.name as product_name, p.sku as product_sku,
           c.cases, c.status, c.source, c.approved_at
    from commitments c
    join businesses b on b.id = c.business_id
    join products p on p.id = c.product_id
    where c.cycle_id = ${cycleId} and c.status <> 'cancelled'
    order by b.dba, p.name
  `;
}

async function getNegotiated(cycleId: string): Promise<Map<string, number>> {
  const rows = await sql<Array<{ product_id: string; granted_price_cents: number }>>`
    select product_id, granted_price_cents from negotiated_prices where cycle_id = ${cycleId}
  `;
  return new Map(rows.map((r) => [r.product_id, r.granted_price_cents]));
}

export function feeModelFor(cycle: CycleRow): FeeModel {
  return cycle.fee_model === "spend_bps"
    ? {
        kind: "spend_bps",
        procurementFeeBps: cycle.procurement_fee_bps,
        freightCoordFeeCents: cycle.freight_coord_fee_cents,
      }
    : { kind: "savings_share", shareBps: cycle.savings_share_bps };
}

export type CycleAnalysis = {
  cycle: CycleRow;
  commitments: CommitmentRow[];
  lines: PoolLine[];
  summary: ReturnType<typeof summarizePool>;
  /** Null when the cycle has no commitments yet, so no load can be built. */
  load: ReturnType<typeof planLoad> | null;
  settlement: CycleSettlement | null;
  screens: ParticipantScreen[];
  businessNames: Map<string, string>;
  negotiated: Map<string, number>;
};

/**
 * Everything the app needs to show a cycle, computed from current rows.
 *
 * For an open cycle this is a projection at today's committed volume. Once
 * prices are negotiated the granted prices override the ladder, and the same
 * code path produces the figures that get settled.
 */
export async function analyzeCycle(cycleId: string): Promise<CycleAnalysis | null> {
  const cycle = await getCycle(cycleId);
  if (!cycle) return null;

  const [commitments, products, negotiated] = await Promise.all([
    getCycleCommitments(cycleId),
    loadProducts(cycle.supplier_id),
    getNegotiated(cycleId),
  ]);

  const engineCommitments: Commitment[] = commitments.map((c) => ({
    businessId: c.business_id,
    productId: c.product_id,
    cases: c.cases,
  }));

  const lines = buildPoolLines([...products.values()], engineCommitments, negotiated);
  const summary = summarizePool(lines, {
    minOrderCents: cycle.min_order_cents,
    procurementFeeBps: cycle.procurement_fee_bps,
  });

  const businessNames = new Map(
    commitments.map((c) => [c.business_id, c.business_name]),
  );

  // Build the load against the assigned carrier, or the cheapest active one
  // as a projection while the cycle is still open.
  const [assigned] = await sql<Array<{ carrier_id: string | null }>>`
    select carrier_id from shipments where cycle_id = ${cycleId}
  `;
  const carrier = assigned?.carrier_id
    ? await loadCarrier(assigned.carrier_id)
    : await defaultCarrier();

  const origin = { lat: cycle.supplier_lat, lng: cycle.supplier_lng };
  const participants = [...new Set(commitments.map((c) => c.business_id))];

  let load: ReturnType<typeof planLoad> | null = null;
  let settlement: CycleSettlement | null = null;
  let screens: ParticipantScreen[] = [];

  if (carrier && participants.length > 0) {
    load = planLoad(
      origin,
      carrier,
      // Platform default: never bill a member more than its own LTL would
      // have cost. See applyLtlCaps for why pallet share alone is not enough.
      participants.map((bid) => {
        const rows = commitments.filter((c) => c.business_id === bid);
        return {
          businessId: bid,
          point: { lat: rows[0].business_lat, lng: rows[0].business_lng },
          dockType: rows[0].business_dock,
          items: rows.map((r) => ({
            product: products.get(r.product_id)!,
            cases: r.cases,
          })),
        };
      }),
      "ltl_capped",
    );

    // Where a carrier has rated a member's order shipped alone, that quote
    // replaces the LTL benchmark in their counterfactual.
    const quotedSolo = await quotedSoloFreight(cycleId);

    settlement = settleCycle({
      lines,
      load,
      supplierOrigin: origin,
      quotedSoloFreight: quotedSolo,
      businesses: participants.map((bid) => {
        const row = commitments.find((c) => c.business_id === bid)!;
        return {
          id: bid,
          point: { lat: row.business_lat, lng: row.business_lng },
          dockType: row.business_dock,
        };
      }),
      fees: feeModelFor(cycle),
    });
    screens = screenParticipants(settlement);
  }

  return {
    cycle,
    commitments,
    lines,
    summary,
    load,
    settlement,
    screens,
    businessNames,
    negotiated,
  };
}

// ---------------------------------------------------------------------------
// Freight
// ---------------------------------------------------------------------------

export async function getShipments(businessId?: string) {
  return sql<
    Array<{
      id: string;
      cycle_id: string;
      cycle_name: string;
      zone_name: string;
      supplier_name: string;
      carrier_name: string | null;
      status: string;
      pickup_date: Date;
      delivery_date: Date;
      total_pallets: number;
      total_weight_lb: number;
      route_miles: number;
      linehaul_cents: number;
      accessorial_cents: number;
      allocation_method: string;
      stop_count: number;
    }>
  >`
    select sh.id, sh.cycle_id, pc.name as cycle_name, z.name as zone_name,
           s.name as supplier_name, ca.name as carrier_name, sh.status, sh.pickup_date,
           pc.delivery_date, sh.total_pallets, sh.total_weight_lb::float8 as total_weight_lb,
           sh.route_miles, sh.linehaul_cents, sh.accessorial_cents, sh.allocation_method,
           (select count(*)::int from shipment_stops ss where ss.shipment_id = sh.id) as stop_count
    from shipments sh
    join pool_cycles pc on pc.id = sh.cycle_id
    join zones z on z.id = pc.zone_id
    join suppliers s on s.id = pc.supplier_id
    left join carriers ca on ca.id = sh.carrier_id
    ${businessId
      ? sql`where exists (select 1 from shipment_stops ss
                          where ss.shipment_id = sh.id and ss.business_id = ${businessId})`
      : sql``}
    order by pc.delivery_date desc
  `;
}

export async function getShipmentStops(shipmentId: string) {
  return sql<
    Array<{
      id: string;
      business_id: string;
      business_name: string;
      city: string;
      sequence: number;
      pallets: number;
      weight_lb: number;
      miles_from_prev: number;
      eta: Date | null;
      status: string;
      delivered_at: Date | null;
      freight_cents: number;
      pod_signed_by: string | null;
    }>
  >`
    select ss.id, ss.business_id, coalesce(b.dba, b.legal_name) as business_name, b.city,
           ss.sequence, ss.pallets, ss.weight_lb::float8 as weight_lb, ss.miles_from_prev,
           ss.eta, ss.status, ss.delivered_at, ss.freight_cents, ss.pod_signed_by
    from shipment_stops ss
    join businesses b on b.id = ss.business_id
    where ss.shipment_id = ${shipmentId}
    order by ss.sequence
  `;
}

export async function getTrackingEvents(shipmentId: string) {
  return sql<
    Array<{ id: string; code: string; message: string; occurred_at: Date }>
  >`
    select id, code, message, occurred_at from tracking_events
    where shipment_id = ${shipmentId}
    order by occurred_at desc, id
  `;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type InventoryRow = {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  category: string;
  pack_description: string;
  supplier_name: string;
  on_hand_cases: number;
  avg_weekly_cases: number;
  par_cases: number;
  safety_days: number;
  list_price_cents: number;
  counted_at: Date;
};

export async function getInventory(businessId: string) {
  return sql<InventoryRow[]>`
    select i.id, i.product_id, p.name as product_name, p.sku as product_sku, p.category,
           p.pack_description, s.name as supplier_name,
           i.on_hand_cases::float8 as on_hand_cases,
           i.avg_weekly_cases::float8 as avg_weekly_cases,
           i.par_cases::float8 as par_cases,
           i.safety_days, p.list_price_cents, i.counted_at
    from inventory_items i
    join products p on p.id = i.product_id
    join suppliers s on s.id = p.supplier_id
    where i.business_id = ${businessId}
    order by (case when i.avg_weekly_cases > 0
                   then i.on_hand_cases / (i.avg_weekly_cases / 7.0)
                   else 99999 end)
  `;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export type AgentPolicyRow = {
  id: string;
  business_id: string;
  enabled: boolean;
  cycle_budget_cents: number;
  auto_approve_under_cents: number;
  allowed_categories: string[];
  updated_at: Date;
};

export async function getAgentPolicy(businessId: string): Promise<AgentPolicyRow | null> {
  const [row] = await sql<AgentPolicyRow[]>`
    select * from agent_policies where business_id = ${businessId}
  `;
  return row ?? null;
}

export async function getProposals(businessId: string) {
  return sql<
    Array<{
      id: string;
      run_id: string;
      cycle_id: string;
      cycle_name: string;
      cycle_status: string;
      product_id: string;
      product_name: string;
      product_sku: string;
      cases: number;
      est_unit_cents: number;
      est_total_cents: number;
      days_to_depletion: number;
      reason: string;
      status: string;
      decided_at: Date | null;
      decided_by: string | null;
      created_at: Date;
    }>
  >`
    select ap.id, ap.run_id, ap.cycle_id, pc.name as cycle_name, pc.status as cycle_status,
           ap.product_id, p.name as product_name, p.sku as product_sku, ap.cases,
           ap.est_unit_cents, ap.est_total_cents, ap.days_to_depletion::float8 as days_to_depletion,
           ap.reason, ap.status, ap.decided_at, ap.decided_by, ap.created_at
    from agent_proposals ap
    join products p on p.id = ap.product_id
    join pool_cycles pc on pc.id = ap.cycle_id
    where ap.business_id = ${businessId}
    order by case ap.status when 'pending' then 0 else 1 end, ap.created_at desc
  `;
}

export async function getAgentRuns(businessId: string) {
  return sql<
    Array<{
      id: string;
      cycle_id: string | null;
      cycle_name: string | null;
      status: string;
      trigger: string;
      started_at: Date;
      finished_at: Date | null;
      proposal_count: number;
    }>
  >`
    select ar.id, ar.cycle_id, pc.name as cycle_name, ar.status, ar.trigger,
           ar.started_at, ar.finished_at,
           (select count(*)::int from agent_proposals ap where ap.run_id = ar.id) as proposal_count
    from agent_runs ar
    left join pool_cycles pc on pc.id = ar.cycle_id
    where ar.business_id = ${businessId}
    order by ar.started_at desc
    limit 10
  `;
}

export async function getAgentSteps(runId: string) {
  return sql<Array<{ sequence: number; label: string; detail: string }>>`
    select sequence, label, detail from agent_steps where run_id = ${runId} order by sequence
  `;
}

// ---------------------------------------------------------------------------
// Settlements and savings
// ---------------------------------------------------------------------------

export async function getSettlements(businessId?: string) {
  return sql<
    Array<{
      id: string;
      cycle_id: string;
      cycle_name: string;
      business_id: string;
      business_name: string;
      zone_name: string;
      delivery_date: Date;
      fee_model: string;
      goods_cents: number;
      freight_cents: number;
      procurement_fee_cents: number;
      freight_coord_fee_cents: number;
      savings_share_fee_cents: number;
      solo_goods_cents: number;
      solo_freight_cents: number;
      gross_savings_cents: number;
      net_savings_cents: number;
      issued_at: Date;
    }>
  >`
    select st.id, st.cycle_id, pc.name as cycle_name, st.business_id,
           coalesce(b.dba, b.legal_name) as business_name, z.name as zone_name,
           pc.delivery_date, st.fee_model, st.goods_cents, st.freight_cents,
           st.procurement_fee_cents, st.freight_coord_fee_cents, st.savings_share_fee_cents,
           st.solo_goods_cents, st.solo_freight_cents, st.gross_savings_cents,
           st.net_savings_cents, st.issued_at
    from settlements st
    join pool_cycles pc on pc.id = st.cycle_id
    join zones z on z.id = pc.zone_id
    join businesses b on b.id = st.business_id
    ${businessId ? sql`where st.business_id = ${businessId}` : sql``}
    order by pc.delivery_date desc
  `;
}

export async function getNetworkStats() {
  const [row] = await sql<
    Array<{
      members: number;
      active_zones: number;
      suppliers: number;
      carriers: number;
      skus: number;
      open_cycles: number;
      goods_settled_cents: number;
      member_savings_cents: number;
      fee_revenue_cents: number;
      mrr_cents: number;
      agents_enabled: number;
    }>
  >`
    select
      (select count(*)::int from businesses where status = 'active') as members,
      (select count(*)::int from zones where active) as active_zones,
      (select count(*)::int from suppliers where active) as suppliers,
      (select count(*)::int from carriers where active) as carriers,
      (select count(*)::int from products where active) as skus,
      (select count(*)::int from pool_cycles where status = 'open') as open_cycles,
      (select coalesce(sum(goods_cents), 0)::int from settlements) as goods_settled_cents,
      (select coalesce(sum(net_savings_cents), 0)::int from settlements) as member_savings_cents,
      (select coalesce(sum(procurement_fee_cents + freight_coord_fee_cents + savings_share_fee_cents), 0)::int
         from settlements) as fee_revenue_cents,
      (select coalesce(sum(mp.monthly_cents), 0)::int
         from businesses b join membership_plans mp on mp.tier = b.membership_tier
         where b.status = 'active') as mrr_cents,
      (select count(*)::int from agent_policies where enabled) as agents_enabled
  `;
  return row;
}

export async function getMembershipPlans() {
  return sql<
    Array<{
      tier: string;
      monthly_cents: number;
      agent_addon_cents: number;
      description: string;
      member_count: number;
    }>
  >`
    select mp.tier, mp.monthly_cents, mp.agent_addon_cents, mp.description,
           (select count(*)::int from businesses b where b.membership_tier = mp.tier) as member_count
    from membership_plans mp
    order by mp.monthly_cents
  `;
}
