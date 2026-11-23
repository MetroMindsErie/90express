/**
 * Data access for onboarding.
 *
 * The estimate is computed here from live rows — the zone's actual committed
 * volume and its actual last load — rather than from stored marketing figures.
 */
import type { StopInput } from "@/lib/crs/freight";
import type { Carrier } from "@/lib/crs/freight";
import { sql } from "@/lib/db/client";
import { loadProducts } from "@/lib/db/queries";
import {
  estimateSavings,
  mergeEstimates,
  type SavingsEstimate,
} from "./estimate";
import type { ZoneCandidate } from "./corridor";

export async function getZoneCandidates(): Promise<ZoneCandidate[]> {
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      center_lat: number;
      center_lng: number;
      radius_miles: number;
      active: boolean;
    }>
  >`
    select id, name, center_lat::float8 as center_lat, center_lng::float8 as center_lng,
           radius_miles, active
    from zones order by center_lat desc
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    centerLat: r.center_lat,
    centerLng: r.center_lng,
    radiusMiles: r.radius_miles,
    active: r.active,
  }));
}

/** Products an applicant can declare, grouped for the form. */
export async function getSelectableProducts() {
  return sql<
    Array<{
      id: string;
      sku: string;
      name: string;
      category: string;
      pack_description: string;
      supplier_name: string;
      list_price_cents: number;
    }>
  >`
    select p.id, p.sku, p.name, p.category, p.pack_description,
           s.name as supplier_name, p.list_price_cents
    from products p
    join suppliers s on s.id = p.supplier_id
    where p.active
    order by s.name, p.category, p.name
  `;
}

/**
 * The most recent costed cycle in a zone, used as the comparison basis.
 *
 * An estimate against a real cycle is worth something; an estimate against an
 * imagined one is not. When a zone has no history the estimate says so.
 */
/**
 * The most recent costed cycle for each supplier the zone trades with.
 *
 * One per supplier, not one overall: a member buys across suppliers and is a
 * stop on each of their loads. Estimating against only the latest cycle
 * silently drops everything the applicant buys from anyone else.
 */
async function representativeCycles(zoneId: string) {
  return sql<
    Array<{
      id: string;
      supplier_id: string;
      supplier_lat: number;
      supplier_lng: number;
      fee_model: "spend_bps" | "savings_share";
      procurement_fee_bps: number;
      freight_coord_fee_cents: number;
      savings_share_bps: number;
    }>
  >`
    select distinct on (pc.supplier_id)
           pc.id, pc.supplier_id,
           s.origin_lat::float8 as supplier_lat, s.origin_lng::float8 as supplier_lng,
           pc.fee_model, pc.procurement_fee_bps, pc.freight_coord_fee_cents,
           pc.savings_share_bps
    from pool_cycles pc
    join suppliers s on s.id = pc.supplier_id
    where pc.zone_id = ${zoneId}
      and exists (select 1 from commitments c where c.cycle_id = pc.id)
    order by pc.supplier_id, pc.closes_at desc
  `;
}

async function defaultCarrier(): Promise<Carrier | null> {
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
  >`
    select id, name, equipment, capacity_pallets, max_weight_lb, linehaul_rate_cents,
           min_charge_cents, stop_charge_cents, liftgate_fee_cents
    from carriers where active order by linehaul_rate_cents limit 1
  `;
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

export type EstimateRequest = {
  zoneId: string;
  destination: { lat: number; lng: number };
  dockType: "dock" | "liftgate" | "ground";
  /** Cases per month the applicant expects, by product id. */
  monthlyDemand: Map<string, number>;
};

/**
 * Estimate what an applicant would save in the zone they matched.
 *
 * Returns null when the zone has no supplier history to compare against,
 * which the caller surfaces rather than papering over.
 */
export async function buildEstimate(
  req: EstimateRequest,
): Promise<SavingsEstimate | null> {
  const cycles = await representativeCycles(req.zoneId);
  const carrier = await defaultCarrier();
  if (!carrier) return null;

  // Pools in these zones run roughly fortnightly.
  const cyclesPerMonth = 2;

  if (cycles.length === 0) return null;

  const parts: SavingsEstimate[] = [];

  // One estimate per supplier the zone trades with, then merged: the
  // applicant is a stop on each of those loads, not just the latest one.
  for (const cycle of cycles) {
    const part = await estimateAgainstCycle(req, cycle, carrier, cyclesPerMonth);
    if (part) parts.push(part);
  }

  return mergeEstimates(parts);
}

async function estimateAgainstCycle(
  req: EstimateRequest,
  cycle: Awaited<ReturnType<typeof representativeCycles>>[number],
  carrier: Carrier,
  cyclesPerMonth: number,
): Promise<SavingsEstimate | null> {
  const products = await loadProducts(cycle.supplier_id);

  // Only what this supplier carries can be pooled on their cycle.
  const demand = new Map<string, number>();
  for (const [productId, monthly] of req.monthlyDemand) {
    if (!products.has(productId)) continue;
    const perCycle = Math.max(1, Math.round(monthly / cyclesPerMonth));
    demand.set(productId, perCycle);
  }
  if (demand.size === 0) return null;

  const zoneDemand = new Map<string, number>();
  const existingStops: StopInput[] = [];

  {
    const commitments = await sql<
      Array<{
        business_id: string;
        product_id: string;
        cases: number;
        lat: number;
        lng: number;
        dock_type: "dock" | "liftgate" | "ground";
      }>
    >`
      select c.business_id, c.product_id, c.cases,
             b.lat::float8 as lat, b.lng::float8 as lng, b.dock_type
      from commitments c
      join businesses b on b.id = c.business_id
      where c.cycle_id = ${cycle.id} and c.status <> 'cancelled'
    `;

    for (const row of commitments) {
      zoneDemand.set(row.product_id, (zoneDemand.get(row.product_id) ?? 0) + row.cases);
    }

    type CommitmentRow = (typeof commitments)[number];
    const byBusiness = new Map<string, CommitmentRow[]>();
    for (const row of commitments) {
      const list = byBusiness.get(row.business_id);
      if (list) list.push(row);
      else byBusiness.set(row.business_id, [row]);
    }
    for (const [businessId, rows] of byBusiness) {
      existingStops.push({
        businessId,
        point: { lat: rows[0].lat, lng: rows[0].lng },
        dockType: rows[0].dock_type,
        items: rows
          .filter((r) => products.has(r.product_id))
          .map((r) => ({ product: products.get(r.product_id)!, cases: r.cases })),
      });
    }
  }

  return estimateSavings({
    destination: req.destination,
    dockType: req.dockType,
    demand,
    products,
    zoneDemand,
    existingStops: existingStops.filter((s) => s.items.length > 0),
    supplierOrigin: { lat: cycle.supplier_lat, lng: cycle.supplier_lng },
    carrier,
    fees:
      cycle.fee_model === "spend_bps"
        ? {
            kind: "spend_bps",
            procurementFeeBps: cycle.procurement_fee_bps,
            freightCoordFeeCents: cycle.freight_coord_fee_cents,
          }
        : { kind: "savings_share", shareBps: cycle.savings_share_bps },
    cyclesPerMonth,
  });
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export type ApplicationRow = {
  id: string;
  legal_name: string;
  dba: string | null;
  segment: string;
  contact_name: string;
  contact_email: string;
  phone: string | null;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  lat: number | null;
  lng: number | null;
  zone_id: string | null;
  zone_name: string | null;
  nearest_zone_id: string | null;
  nearest_zone_name: string | null;
  distance_miles: number | null;
  dock_type: "dock" | "liftgate" | "ground";
  requested_tier: "starter" | "standard" | "premium";
  status: string;
  estimate: SavingsEstimate | null;
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  decline_reason: string | null;
  business_id: string | null;
  created_at: Date;
  product_count: number;
};

const applicationSelect = sql`
  select a.id, a.legal_name, a.dba, a.segment, a.contact_name, a.contact_email,
         a.phone, a.street, a.city, a.state, a.postal_code,
         a.lat::float8 as lat, a.lng::float8 as lng,
         a.zone_id, z.name as zone_name,
         a.nearest_zone_id, nz.name as nearest_zone_name,
         a.distance_miles::float8 as distance_miles,
         a.dock_type, a.requested_tier, a.status, a.estimate, a.notes,
         a.reviewed_by, a.reviewed_at, a.decline_reason, a.business_id, a.created_at,
         (select count(*)::int from application_products ap
           where ap.application_id = a.id) as product_count
  from member_applications a
  left join zones z on z.id = a.zone_id
  left join zones nz on nz.id = a.nearest_zone_id
`;

export async function getApplications(): Promise<ApplicationRow[]> {
  return sql<ApplicationRow[]>`
    ${applicationSelect}
    order by case a.status
               when 'submitted' then 0 when 'reviewing' then 1
               when 'waitlisted' then 2 else 3 end,
             a.created_at desc
  `;
}

export async function getApplication(id: string): Promise<ApplicationRow | null> {
  const [row] = await sql<ApplicationRow[]>`${applicationSelect} where a.id = ${id}`;
  return row ?? null;
}

export async function getApplicationByTokenHash(
  tokenHash: string,
): Promise<ApplicationRow | null> {
  const [row] = await sql<ApplicationRow[]>`
    ${applicationSelect} where a.status_token_hash = ${tokenHash}
  `;
  return row ?? null;
}

export async function getApplicationProducts(applicationId: string) {
  return sql<
    Array<{
      product_id: string;
      sku: string;
      name: string;
      pack_description: string;
      monthly_cases: number;
      supplier_name: string;
    }>
  >`
    select ap.product_id, p.sku, p.name, p.pack_description,
           ap.monthly_cases::float8 as monthly_cases, s.name as supplier_name
    from application_products ap
    join products p on p.id = ap.product_id
    join suppliers s on s.id = p.supplier_id
    where ap.application_id = ${applicationId}
    order by p.name
  `;
}

export async function getOnboardingStats() {
  const [row] = await sql<
    Array<{
      submitted: number;
      waitlisted: number;
      approved_30d: number;
      declined_30d: number;
      pipeline_monthly_cents: number;
    }>
  >`
    select
      (select count(*)::int from member_applications
        where status in ('submitted','reviewing')) as submitted,
      (select count(*)::int from member_applications where status = 'waitlisted') as waitlisted,
      (select count(*)::int from member_applications
        where status = 'approved' and reviewed_at > now() - interval '30 days') as approved_30d,
      (select count(*)::int from member_applications
        where status = 'declined' and reviewed_at > now() - interval '30 days') as declined_30d,
      (select coalesce(sum((a.estimate->>'netPerMonthCents')::int), 0)::int
         from member_applications a
        where a.status in ('submitted','reviewing')
          and a.estimate is not null) as pipeline_monthly_cents
  `;
  return row;
}

/** Waitlist density per zone: the signal for where the next zone opens. */
export async function getWaitlistByZone() {
  return sql<
    Array<{
      zone_id: string;
      zone_name: string;
      active: boolean;
      waiting: number;
      cities: string;
    }>
  >`
    select z.id as zone_id, z.name as zone_name, z.active,
           count(a.id)::int as waiting,
           string_agg(distinct a.city, ', ' order by a.city) as cities
    from member_applications a
    join zones z on z.id = a.nearest_zone_id
    where a.status = 'waitlisted'
    group by z.id, z.name, z.active
    order by waiting desc
  `;
}

export async function getCurrentTerms() {
  const [row] = await sql<
    Array<{
      id: string;
      version: string;
      effective_from: Date;
      summary: string;
      body: Array<{ heading: string; text: string }>;
    }>
  >`
    select id, version, effective_from, summary, body
    from terms_versions
    order by effective_from desc, created_at desc
    limit 1
  `;
  return row ?? null;
}

export async function getTermsAcceptance(businessId: string) {
  const [row] = await sql<
    Array<{
      version: string;
      accepted_by_name: string;
      accepted_at: Date;
    }>
  >`
    select tv.version, ta.accepted_by_name, ta.accepted_at
    from terms_acceptances ta
    join terms_versions tv on tv.id = ta.terms_version_id
    where ta.business_id = ${businessId}
    order by ta.accepted_at desc
    limit 1
  `;
  return row ?? null;
}
